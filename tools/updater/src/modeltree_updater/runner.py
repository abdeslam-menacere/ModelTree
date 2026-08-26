"""Run the creator workflow for one or many creators.

One creator failing never stops the others: each creator gets its own workflow
instance, and a crash is converted into an explicitly failed proposal rather than
an aborted run.
"""

from __future__ import annotations

import traceback
from typing import Any, Sequence

from .checkpoints import (
    CHECKPOINT_SCHEMA_VERSION,
    TOOL_VERSION,
    CheckpointVersion,
    current_version_marker,
    recorded_profile_id,
    recorded_providers,
    recorded_version_marker,
)
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
    "CheckpointVersionMismatch",
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


class CheckpointVersionMismatch(ProviderError):
    """A resume was asked to reinterpret state a different build wrote.

    The refusal, not a warning. A run's supersteps are adjudicated one at a time and
    the checkpoint is what carries the decision between them, so a build change
    across a resume means the earlier half of a proposal was decided by code the
    later half is not. Logging that and continuing produces exactly the artefact this
    tool exists not to produce: one proposal presented as a single judgement that was
    made under two sets of rules, with nothing on its face saying so. There is no
    partially-correct outcome to salvage, so there is nothing for a warning to be
    useful *for*.

    **An unmarked checkpoint is refused too, and that is the deliberate choice rather
    than the accident.** A checkpoint written before this marker existed says nothing
    about the build that wrote it, so it cannot be shown to match — and "cannot be
    shown to match" must not resolve to the permissive branch merely because the
    evidence is missing. #146 was failed at review for the mirror image of this
    (`bundle.policy ?? 'pilot'` read an absent field as licence to apply the weaker
    bar), and while an unmarked checkpoint is genuinely a different thing — state
    predating a feature, not a field a peer omitted — the *conclusion* is the same
    and for a stronger reason here. The unmarked checkpoints that exist are precisely
    the ones ADR 0002 names in its residual: written when `--long-tail-profile` still
    took a path, carrying an id from a document the reviewed set never saw. Accepting
    them as legacy would keep that hole open and leave the ADR unable to drop its
    qualification, which is the whole point of closing this. Issue #140 settles the
    cost directly — there is no checkpoint corpus to migrate, and refusing an old
    checkpoint is the correct conservative behaviour.

    ``retryable=False``: resuming again changes nothing. The message names the build
    that wrote the checkpoint, the build reading it, which of the two numbers differ,
    and the two things an operator can actually do.
    """

    def __init__(self, recorded: CheckpointVersion, reading: CheckpointVersion) -> None:
        if not recorded.is_marked:
            opening = "this checkpoint records no tool or checkpoint schema version"
            differs = (
                "It predates the version marker, so the build that wrote it cannot be "
                "identified at all"
            )
            remedy = (
                "Start this creator again from the beginning with the current build. "
                "An unmarked checkpoint cannot be shown to match, and a resume that "
                "cannot be shown to match is not one this tool will make."
            )
        else:
            opening = f"this checkpoint was written by {recorded.describe()}"
            names = []
            if recorded.tool_version != reading.tool_version:
                names.append(
                    f"the tool version differs ({recorded.tool_version!r} wrote it, "
                    f"{reading.tool_version!r} is reading it)"
                )
            if recorded.schema_version != reading.schema_version:
                names.append(
                    f"the checkpoint schema version differs ({recorded.schema_version!r} "
                    f"wrote it, {reading.schema_version!r} is reading it)"
                )
            joined = "; ".join(names)
            differs = joined[:1].upper() + joined[1:]
            remedy = (
                f"Resume with modeltree-updater {recorded.tool_version}, or start this "
                "creator again from the beginning with the current build. Do not "
                "resume it with this one."
            )
        super().__init__(
            f"refusing to resume: {opening}, but this is {reading.describe()}. "
            f"{differs}. A proposal must be decided under one set of rules from end "
            f"to end. {remedy}",
            provider="modeltree-updater",
            retryable=False,
        )
        self.recorded = recorded
        self.reading = reading


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
            # Stamped here for the same reason and at the same moment: this is the
            # build adjudicating the run, so it is the build every checkpoint the
            # run writes has to name.
            tool_version=TOOL_VERSION,
            checkpoint_schema_version=CHECKPOINT_SCHEMA_VERSION,
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

    It must not quietly change the *code* either. The checkpoint records the tool
    version and the checkpoint schema version of the build that wrote it, and a
    resume by any other build — or by any build at all, where the checkpoint predates
    the marker and names none — stops with ``CheckpointVersionMismatch`` before the
    providers or the profile are looked at. See that class for why refusing an
    unmarked checkpoint is the deliberate reading of absence rather than an oversight.

    It must not quietly change the *bar* either. The review policy travels in the
    checkpointed messages, so it is restored rather than re-decided — the resuming
    command's ``--long-tail`` flag is not consulted for it. The profile behind that
    policy carries the promotion criteria and the unresolved-mapping topics, which
    the policy alone cannot rebuild, so it is rebuilt from the recorded profile id
    by looking that id up in the **reviewed set** of generic profiles. Because that
    set refuses two documents answering to one id, the id identifies the file, so a
    run started through the CLI gets back the document it started under rather than
    whichever file happened to sit at the default path. An id the reviewed set does
    not contain, or a resume that asks for a different profile than the checkpoint
    records, stops the run.

    Two limits, so this does not read as more than it is. A profile built in-process
    from an arbitrary path — which no newly started CLI run can do, though the loader
    still allows it — may declare an id the reviewed set does contain, and that
    resume gets the reviewed document rather than the one the run started with. That
    resolves towards a reviewed document, which is safe for *provenance*; it is not
    necessarily the stricter document, and strictness is not ordered between the
    two — the substituted promotion criteria can be looser on one criterion and
    stricter on another than the ones the run started under. See ADR 0002. Only the
    *start* of such a run is confined to the Python API: no CLI invocation can name an
    unreviewed document, but the checkpoint that in-process run writes carries this
    build's version marker like any other, so a CLI ``resume`` of it satisfies the
    version check above and substitutes the document — executed rather than reasoned in
    #206. What that check refuses is the older route: a checkpoint written back when
    ``--long-tail-profile`` still took a path, which carries no marker at all. And a
    reviewed set that cannot be loaded at all, because the directory is missing or
    empty, surfaces as ``FileNotFoundError`` rather than ``ProfileMismatch``: that
    is a broken installation, not a disagreement about which profile applies. The
    CLI maps both to exit 2.
    """
    # First, and before any work. If this build cannot be shown to be the one that
    # wrote the state, nothing else read out of that state means what it appears to:
    # comparing providers or a profile id across a schema whose field meanings may
    # have moved would be reporting a comparison this code is not entitled to make.
    # A checkpoint that cannot be loaded at all is not a version disagreement, so it
    # is left to the framework to report as it does today.
    recorded_version = await recorded_version_marker(checkpoint_storage, checkpoint_id)
    reading_version = current_version_marker()
    if recorded_version is not None and recorded_version != reading_version:
        raise CheckpointVersionMismatch(recorded_version, reading_version)

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
