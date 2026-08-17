"""Run the creator workflow for one or many creators.

One creator failing never stops the others: each creator gets its own workflow
instance, and a crash is converted into an explicitly failed proposal rather than
an aborted run.
"""

from __future__ import annotations

import traceback
from typing import Any, Sequence

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
from .messages import CreatorTask
from .workflow import RunSettings, build_creator_workflow

__all__ = ["run_creator", "run_creators", "resume_creator_run"]


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
    workflow = build_creator_workflow(settings, checkpoint_storage=checkpoint_storage)
    result = await workflow.run(CreatorTask(run_id=run_id, creator=creator))
    return _single_proposal(result.get_outputs())


async def resume_creator_run(
    settings: RunSettings,
    *,
    checkpoint_id: str,
    checkpoint_storage: Any,
) -> CreatorProposal:
    """Resume a previously checkpointed creator run and finish it."""
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
