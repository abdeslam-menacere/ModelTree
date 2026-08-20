"""Run the creator workflow for one or many creators.

One creator failing never stops the others: each creator gets its own workflow
instance, and a crash is converted into an explicitly failed proposal rather than
an aborted run.
"""

from __future__ import annotations

import traceback
from typing import Any, Sequence

from .checkpoints import recorded_profile_id, recorded_providers
from .contracts import (
    BudgetUsage,
    CreatorProposal,
    CreatorRequest,
    FailureKind,
    ProposalStatus,
    RunFailure,
    RunReport,
    WorkflowStage,
)
from .longtail import reviewed_long_tail_profile
from .messages import CreatorTask
from .profiles import ProfileError
from .providers.base import ProviderError
from .workflow import ProfileMismatch, RunSettings, build_creator_workflow

__all__ = [
    "ProfileMismatch",
    "ProviderMismatch",
    "run_creator",
    "run_creators",
    "resume_creator_run",
]


class ProviderMismatch(ProviderError):
    """A resume asked for different providers than the checkpointed run used."""

    def __init__(self, recorded: dict[str, str], requested: dict[str, str]) -> None:
        super().__init__(
            "refusing to resume: this checkpoint was produced by "
            f"{recorded} but the requested providers are {requested}. A proposal "
            "must state the providers that actually produced it.",
            provider="modeltree-updater",
            retryable=False,
        )
        self.recorded = recorded
        self.requested = requested


def _empty_budget(settings: RunSettings) -> BudgetUsage:
    return settings.ledger({}).snapshot()


def _failed_proposal(
    creator: CreatorRequest,
    settings: RunSettings,
    *,
    run_id: str,
    error: BaseException,
) -> CreatorProposal:
    failure = RunFailure(
        stage=WorkflowStage.DISCOVER,
        kind=FailureKind.INTERNAL_ERROR,
        message=f"{type(error).__name__}: {error}",
        occurred_at=settings.timestamp,
        retryable=False,
        detail={"traceback": "".join(traceback.format_exception_only(type(error), error)).strip()},
    )
    return CreatorProposal(
        run_id=run_id,
        creator_id=creator.creator_id,
        status=ProposalStatus.FAILED,
        generated_at=settings.timestamp,
        sources=(),
        claims=(),
        verdicts=(),
        validations=(),
        conflicts=(),
        budget=_empty_budget(settings),
        failures=(failure,),
        notes=("the workflow did not complete; nothing was proposed for this creator",),
        providers=dict(settings.providers.descriptor),
    )


def _single_proposal(outputs: Sequence[Any]) -> CreatorProposal:
    proposals = [output for output in outputs if isinstance(output, CreatorProposal)]
    if len(proposals) != 1:
        raise RuntimeError(
            f"expected exactly one proposal from the workflow, got {len(proposals)}"
        )
    return proposals[0]


async def run_creator(
    creator: CreatorRequest,
    settings: RunSettings,
    *,
    run_id: str,
    checkpoint_storage: Any | None = None,
) -> CreatorProposal:
    """Run the full workflow for one creator and return its proposal."""
    if settings.long_tail is not None:
        # Instantiate the generic profile for this creator *before* anything is
        # fetched. It produces the same `CreatorProfile` type the dedicated profiles
        # load to, and building it runs the URL safety check over the creator's seed
        # URLs — so an unsafe seed stops the run here rather than being read first
        # and refused afterwards. Being trusted less must never mean being checked
        # less.
        settings.long_tail.for_creator(creator)
    workflow = build_creator_workflow(settings, checkpoint_storage=checkpoint_storage)
    result = await workflow.run(
        CreatorTask(
            run_id=run_id,
            creator=creator,
            providers=settings.providers.descriptor,
            # Stamped once, at the start. Everything downstream forwards it, so the
            # bar this run is judged by is fixed here and recorded in every
            # checkpoint rather than re-decided later.
            review_policy=settings.review_policy,
            profile_id=settings.profile_id,
        )
    )
    return _single_proposal(result.get_outputs())


async def resume_creator_run(
    settings: RunSettings,
    *,
    checkpoint_id: str,
    checkpoint_storage: Any,
) -> CreatorProposal:
    """Resume a previously checkpointed creator run and finish it.

    A resume must not quietly change where the evidence came from, so the
    providers recorded in the checkpoint have to match the ones supplied here.

    It must not quietly change the *bar* either. The review policy travels in the
    checkpointed messages, so it is restored rather than re-decided — the resuming
    command's ``--long-tail`` flag is not consulted for it. The profile behind that
    policy carries the promotion criteria and the unresolved-mapping topics, which
    the policy alone cannot rebuild, so it is rebuilt from the recorded profile id
    by looking that id up in the **reviewed set** of generic profiles. Because that
    set refuses two documents answering to one id, the id identifies the file, and
    the resumed run gets back the document the run started under rather than
    whichever file happened to sit at the default path. An id the reviewed set does
    not contain, or a resume that asks for a different profile than the checkpoint
    records, stops the run.
    """
    recorded = await recorded_providers(checkpoint_storage, checkpoint_id)
    requested = dict(settings.providers.descriptor)
    if recorded is not None and recorded != requested:
        raise ProviderMismatch(recorded, requested)

    recorded_profile = await recorded_profile_id(checkpoint_storage, checkpoint_id)
    if recorded_profile is not None and settings.profile_id is None:
        try:
            profile = reviewed_long_tail_profile(recorded_profile)
        except ProfileError as error:
            raise ProfileMismatch(
                recorded_profile,
                None,
                reason=(
                    f"this checkpoint was produced under profile {recorded_profile!r}, "
                    f"which is not in the reviewed set ({error})"
                ),
            ) from error
        settings.adopt_long_tail(profile)
    if recorded_profile != settings.profile_id:
        raise ProfileMismatch(recorded_profile, settings.profile_id)

    workflow = build_creator_workflow(settings, checkpoint_storage=checkpoint_storage)
    result = await workflow.run(
        checkpoint_id=checkpoint_id, checkpoint_storage=checkpoint_storage
    )
    return _single_proposal(result.get_outputs())


async def run_creators(
    creators: Sequence[CreatorRequest],
    settings: RunSettings,
    *,
    run_id: str,
    checkpoint_storage: Any | None = None,
) -> RunReport:
    """Run every selected creator, continuing past individual failures."""
    proposals: list[CreatorProposal] = []
    for creator in creators:
        try:
            proposals.append(
                await run_creator(
                    creator,
                    settings,
                    run_id=run_id,
                    checkpoint_storage=checkpoint_storage,
                )
            )
        except Exception as error:  # noqa: BLE001 - one creator must not sink the run
            proposals.append(_failed_proposal(creator, settings, run_id=run_id, error=error))

    return RunReport(
        run_id=run_id,
        started_at=settings.timestamp,
        completed_at=settings.timestamp,
        proposals=tuple(proposals),
        settings={
            "providers": settings.providers.descriptor,
            "budget": {
                "max_pages": settings.budget.max_pages,
                "max_tokens": settings.budget.max_tokens,
                "max_seconds": settings.budget.max_seconds,
                "max_retries": settings.budget.max_retries,
            },
            "mode": "proposal-only",
        },
    )
