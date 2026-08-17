"""The creator workflow, built from Microsoft Agent Framework executors.

Four executors run in a chain: discover sources, extract claims, review claims,
bundle a proposal. Each one charges the creator's budget, records typed failures
instead of swallowing them, and persists its stage state so the run can be
checkpointed and resumed.

Nothing in this module writes ModelTree data. The only output is a
:class:`~modeltree_updater.contracts.CreatorProposal`.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Callable, Sequence, TypeVar

from agent_framework import Executor, Workflow, WorkflowBuilder, WorkflowContext, handler

from .budgets import BudgetExhausted, BudgetLedger, CreatorBudget
from .conflicts import detect_conflicts
from .contracts import (
    ClaimCandidate,
    ClaimDecision,
    CreatorProposal,
    FailureKind,
    ProposalStatus,
    ReviewVerdict,
    RunFailure,
    SourceCandidate,
    ValidationStatus,
    WorkflowStage,
)
from .messages import CreatorTask, DiscoveredSources, ExtractedClaims, ReviewedClaims
from .providers.base import ProviderBundle, ProviderError
from .validation import validate_claims

__all__ = [
    "WORKFLOW_NAME",
    "RunSettings",
    "build_creator_workflow",
    "bundle_proposal",
]

WORKFLOW_NAME = "modeltree-creator-proposal"

T = TypeVar("T")


class RunSettings:
    """Everything the executors share for one run: providers, budget, and clocks."""

    def __init__(
        self,
        providers: ProviderBundle,
        *,
        budget: CreatorBudget,
        timestamp: str,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.providers = providers
        self.budget = budget
        self.timestamp = timestamp
        self.clock = clock

    def ledger(self, state: Any) -> BudgetLedger:
        if self.clock is None:
            return BudgetLedger.from_state(self.budget, state or {})
        return BudgetLedger.from_state(self.budget, state or {}, clock=self.clock)


def _budget_failure(stage: WorkflowStage, error: BudgetExhausted, timestamp: str) -> RunFailure:
    return RunFailure(
        stage=stage,
        kind=FailureKind.BUDGET_EXHAUSTED,
        message=str(error),
        occurred_at=timestamp,
        retryable=False,
        detail={"resource": error.resource, "limit": error.limit, "used": error.used},
    )


def _provider_failure(stage: WorkflowStage, error: ProviderError, timestamp: str) -> RunFailure:
    return RunFailure(
        stage=stage,
        kind=FailureKind.PROVIDER_FAILURE,
        message=str(error),
        occurred_at=timestamp,
        retryable=error.retryable,
        detail={"provider": error.provider},
    )


def _call_with_retry(
    call: Callable[[], T],
    *,
    stage: WorkflowStage,
    ledger: BudgetLedger,
    timestamp: str,
    failures: list[RunFailure],
) -> T | None:
    """Run a provider call, spending the retry budget on retryable failures only.

    Returns ``None`` when the call could not be completed; the reason is always
    appended to ``failures`` so the proposal records why data is missing.
    """
    while True:
        try:
            return call()
        except BudgetExhausted as error:
            failures.append(_budget_failure(stage, error, timestamp))
            return None
        except ProviderError as error:
            failures.append(_provider_failure(stage, error, timestamp))
            if not error.retryable:
                return None
            try:
                ledger.record_retry()
            except BudgetExhausted as budget_error:
                failures.append(_budget_failure(stage, budget_error, timestamp))
                return None


class DiscoverSourcesExecutor(Executor):
    """Stage 1 — find candidate sources for the creator, within the page budget."""

    def __init__(self, settings: RunSettings, executor_id: str = "discover-sources") -> None:
        super().__init__(id=executor_id)
        self._settings = settings

    @handler
    async def run(
        self, message: CreatorTask, ctx: WorkflowContext[DiscoveredSources]
    ) -> None:
        settings = self._settings
        ledger = settings.ledger(message.budget_state)
        failures: list[RunFailure] = []

        discovered: Sequence[SourceCandidate] = ()
        result = _call_with_retry(
            # One more than the page budget, so a truncated discovery is detectable
            # rather than silently looking like "there was nothing else to read".
            lambda: settings.providers.sources.discover(
                message.creator, limit=settings.budget.max_pages + 1
            ),
            stage=WorkflowStage.DISCOVER,
            ledger=ledger,
            timestamp=settings.timestamp,
            failures=failures,
        )
        if result is not None:
            discovered = tuple(result)

        allowed = settings.budget.max_pages
        if len(discovered) > allowed:
            dropped = discovered[allowed:]
            failures.append(
                RunFailure(
                    stage=WorkflowStage.DISCOVER,
                    kind=FailureKind.BUDGET_EXHAUSTED,
                    message=(
                        f"page budget of {allowed} is smaller than the {len(discovered)} "
                        f"candidate source(s) found; {len(dropped)} were not examined"
                    ),
                    occurred_at=settings.timestamp,
                    retryable=False,
                    detail={
                        "resource": "pages",
                        "dropped_source_ids": [source.id for source in dropped],
                    },
                )
            )
            discovered = discovered[:allowed]

        ctx.set_state("stage", WorkflowStage.DISCOVER.value)
        ctx.set_state("sources_discovered", len(discovered))
        await ctx.send_message(
            DiscoveredSources(
                run_id=message.run_id,
                creator=message.creator,
                sources=tuple(discovered),
                failures=tuple(failures),
                budget_state=ledger.state(),
            )
        )


class ExtractClaimsExecutor(Executor):
    """Stage 2 — read each source and extract atomic claims with evidence."""

    def __init__(self, settings: RunSettings, executor_id: str = "extract-claims") -> None:
        super().__init__(id=executor_id)
        self._settings = settings

    @handler
    async def run(
        self, message: DiscoveredSources, ctx: WorkflowContext[ExtractedClaims]
    ) -> None:
        settings = self._settings
        ledger = settings.ledger(message.budget_state)
        failures = list(message.failures)
        claims: list[ClaimCandidate] = []
        read_sources: list[SourceCandidate] = []

        for source in message.sources:
            def read(source: SourceCandidate = source) -> Any:
                ledger.charge_pages(1)
                return settings.providers.sources.fetch(source)

            page = _call_with_retry(
                read,
                stage=WorkflowStage.EXTRACT,
                ledger=ledger,
                timestamp=settings.timestamp,
                failures=failures,
            )
            if page is None:
                continue

            def extract(page: Any = page) -> Any:
                extraction = settings.providers.extractor.extract(message.creator, page)
                ledger.charge_tokens(extraction.tokens_used)
                return extraction

            extraction = _call_with_retry(
                extract,
                stage=WorkflowStage.EXTRACT,
                ledger=ledger,
                timestamp=settings.timestamp,
                failures=failures,
            )
            if extraction is None:
                continue

            read_sources.append(source)
            claims.extend(extraction.claims)

        ctx.set_state("stage", WorkflowStage.EXTRACT.value)
        ctx.set_state("claims_extracted", len(claims))
        await ctx.send_message(
            ExtractedClaims(
                run_id=message.run_id,
                creator=message.creator,
                sources=tuple(read_sources),
                claims=tuple(claims),
                failures=tuple(failures),
                budget_state=ledger.state(),
            )
        )


class ReviewClaimsExecutor(Executor):
    """Stage 3 — judge each claim against its evidence, one claim at a time."""

    def __init__(self, settings: RunSettings, executor_id: str = "review-claims") -> None:
        super().__init__(id=executor_id)
        self._settings = settings

    @handler
    async def run(
        self, message: ExtractedClaims, ctx: WorkflowContext[ReviewedClaims]
    ) -> None:
        settings = self._settings
        ledger = settings.ledger(message.budget_state)
        failures = list(message.failures)
        verdicts: list[ReviewVerdict] = []

        for claim in message.claims:
            def review(claim: ClaimCandidate = claim) -> Any:
                result = settings.providers.reviewer.review(message.creator, claim)
                ledger.charge_tokens(result.tokens_used)
                return result

            result = _call_with_retry(
                review,
                stage=WorkflowStage.REVIEW,
                ledger=ledger,
                timestamp=settings.timestamp,
                failures=failures,
            )
            if result is None:
                # An unreviewed claim is never treated as accepted.
                verdicts.append(
                    ReviewVerdict(
                        claim_id=claim.id,
                        decision=ClaimDecision.NEEDS_HUMAN_REVIEW,
                        rationale="review did not complete; see proposal failures",
                        reviewer="modeltree-updater",
                        reviewed_at=settings.timestamp,
                    )
                )
                continue
            verdicts.append(result.verdict)

        ctx.set_state("stage", WorkflowStage.REVIEW.value)
        ctx.set_state("verdicts_recorded", len(verdicts))
        await ctx.send_message(
            ReviewedClaims(
                run_id=message.run_id,
                creator=message.creator,
                sources=message.sources,
                claims=message.claims,
                verdicts=tuple(verdicts),
                failures=tuple(failures),
                budget_state=ledger.state(),
            )
        )


class BundleProposalExecutor(Executor):
    """Stage 4 — validate, detect conflicts, and yield the audited proposal."""

    def __init__(self, settings: RunSettings, executor_id: str = "bundle-proposal") -> None:
        super().__init__(id=executor_id)
        self._settings = settings

    @handler
    async def run(
        self, message: ReviewedClaims, ctx: WorkflowContext[Any, CreatorProposal]
    ) -> None:
        proposal = bundle_proposal(message, self._settings)
        ctx.set_state("stage", WorkflowStage.VALIDATE.value)
        ctx.set_state("proposal_status", proposal.status.value)
        await ctx.yield_output(proposal)


def bundle_proposal(message: ReviewedClaims, settings: RunSettings) -> CreatorProposal:
    """Assemble the proposal. Pure enough to unit test without a workflow run."""
    timestamp = settings.timestamp
    checked_at = timestamp[:10]
    validations = validate_claims(message.claims, checked_at=checked_at)
    invalid_ids = {
        result.claim_id for result in validations if result.status is ValidationStatus.INVALID
    }

    verdicts: list[ReviewVerdict] = []
    for verdict in message.verdicts:
        if verdict.decision is ClaimDecision.ACCEPT and verdict.claim_id in invalid_ids:
            # A claim the dataset would reject cannot stand as accepted.
            verdicts.append(
                replace(
                    verdict,
                    decision=ClaimDecision.NEEDS_HUMAN_REVIEW,
                    rationale=(
                        f"{verdict.rationale} (downgraded: claim failed dataset validation)"
                    ),
                )
            )
        else:
            verdicts.append(verdict)

    accepted_ids = {
        verdict.claim_id for verdict in verdicts if verdict.decision is ClaimDecision.ACCEPT
    }
    conflicts = detect_conflicts(
        [claim for claim in message.claims if claim.id in accepted_ids],
        detected_at=checked_at,
    )

    ledger = settings.ledger(message.budget_state)
    usage = ledger.snapshot()
    exhausted = tuple(
        failure
        for failure in message.failures
        if failure.kind is FailureKind.BUDGET_EXHAUSTED
    )
    if exhausted and not usage.exhausted:
        usage = replace(
            usage,
            exhausted_by=tuple(
                sorted({str(failure.detail.get("resource", "unknown")) for failure in exhausted})
            ),
        )

    if message.failures and not message.sources and not message.claims:
        status = ProposalStatus.FAILED
    elif message.failures or conflicts:
        status = ProposalStatus.INCOMPLETE
    else:
        status = ProposalStatus.COMPLETE

    notes: list[str] = []
    if usage.exhausted:
        notes.append(
            "budget exhausted (" + ", ".join(usage.exhausted_by) + "); coverage is partial"
        )
    if conflicts:
        notes.append("sources disagree; conflicts are listed unresolved for a human decision")

    return CreatorProposal(
        run_id=message.run_id,
        creator_id=message.creator.creator_id,
        status=status,
        generated_at=timestamp,
        sources=message.sources,
        claims=message.claims,
        verdicts=tuple(verdicts),
        validations=validations,
        conflicts=conflicts,
        budget=usage,
        failures=message.failures,
        notes=tuple(notes),
    )


def build_creator_workflow(
    settings: RunSettings, *, checkpoint_storage: Any | None = None
) -> Workflow:
    """Wire the four executors into a checkpointable Agent Framework workflow."""
    discover = DiscoverSourcesExecutor(settings)
    extract = ExtractClaimsExecutor(settings)
    review = ReviewClaimsExecutor(settings)
    bundle = BundleProposalExecutor(settings)

    builder = WorkflowBuilder(
        name=WORKFLOW_NAME,
        description="Propose source-backed ModelTree updates for one creator",
        start_executor=discover,
        checkpoint_storage=checkpoint_storage,
    )
    builder.add_chain([discover, extract, review, bundle])
    return builder.build()
