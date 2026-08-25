"""The creator workflow, built from Microsoft Agent Framework executors.

Four executors run in a chain: discover sources, extract claims, review claims,
bundle a proposal. Each one charges the creator's budget, records typed failures
instead of swallowing them, and persists its stage state so the run can be
checkpointed and resumed.

The review stage runs three independent semantic lenses concurrently and records
their votes. It does not decide anything: the bundling stage runs the deterministic
hard gates and adjudicates, so an objective failure always beats a majority.

Nothing in this module writes ModelTree data. The only output is a
:class:`~modeltree_updater.contracts.CreatorProposal`.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import replace
from typing import Any, Awaitable, Callable, Mapping, Sequence, TypeVar

from agent_framework import Executor, Workflow, WorkflowBuilder, WorkflowContext, handler

from .budgets import BudgetExhausted, BudgetLedger, CreatorBudget
from .conflicts import detect_conflicts
from .contracts import (
    REVIEW_LENSES,
    ClaimAdjudication,
    ClaimCandidate,
    ClaimDecision,
    Conflict,
    ConflictKind,
    CreatorProposal,
    FailureKind,
    GateResult,
    ProposalStatus,
    ReviewLens,
    ReviewPolicy,
    ReviewVerdict,
    RunFailure,
    SourceApproval,
    SourceCandidate,
    SourceVerdict,
    WorkflowStage,
)
from .gates import run_claim_gates, run_source_gates
from .longtail import LongTailProfile, assess_promotion, unresolved_mapping_conflicts
from .messages import CreatorTask, DiscoveredSources, ExtractedClaims, ReviewedClaims
from .providers.base import ProviderBundle, ProviderError
from .review import (
    MAJORITY_POLICY,
    adjudicate_claim,
    approve_source,
    build_claim_request,
    build_source_request,
    disagreement_conflicts,
    is_newly_discovered,
)
from .validation import validate_claims

__all__ = [
    "WORKFLOW_NAME",
    "ProfileMismatch",
    "RunSettings",
    "build_creator_workflow",
    "bundle_proposal",
]

WORKFLOW_NAME = "modeltree-creator-proposal"

T = TypeVar("T")


class ProfileMismatch(ProviderError):
    """A resume could not honour the profile the checkpointed run used.

    The review policy lives in the checkpoint, so it is restored rather than
    re-decided. The profile behind it carries the promotion criteria and the
    unresolved-mapping topics, which cannot be reconstructed from the policy alone —
    so if the resuming command supplies a different one, or none, the run stops.
    Adjudicating a long-tail creator on the pilot creators' bar because a flag was
    forgotten is exactly the silent change this refuses to make.

    ``reason`` states a refusal the recorded-versus-requested pair does not describe
    on its own: a checkpoint naming a profile id that the reviewed set no longer
    contains cannot be rebuilt at all, and guessing the nearest one would be the
    substitution this refuses.
    """

    def __init__(
        self, recorded: str | None, requested: str | None, *, reason: str | None = None
    ) -> None:
        detail = reason or (
            f"this checkpoint was produced under profile {recorded!r} but the "
            f"requested profile is {requested!r}"
        )
        super().__init__(
            f"refusing to resume: {detail}. The review policy a proposal was decided "
            "under must be the one it states.",
            provider="modeltree-updater",
            retryable=False,
        )
        self.recorded = recorded
        self.requested = requested


class RunSettings:
    """Everything the executors share for one run: providers, budget, and clocks."""

    def __init__(
        self,
        providers: ProviderBundle,
        *,
        budget: CreatorBudget,
        timestamp: str,
        clock: Callable[[], float] | None = None,
        long_tail: LongTailProfile | None = None,
    ) -> None:
        self.providers = providers
        self.budget = budget
        self.timestamp = timestamp
        self.clock = clock
        # The generic long-tail profile, when this run was asked for one. `None` means
        # the creators being processed have reviewed dedicated profiles and the agreed
        # majority policy applies — which is what every landed run does.
        self.long_tail = long_tail

    @property
    def review_policy(self) -> ReviewPolicy:
        """The threshold a *new* run starts under. A resumed run uses its own."""
        return self.long_tail.review_policy if self.long_tail else MAJORITY_POLICY

    @property
    def profile_id(self) -> str | None:
        return self.long_tail.id if self.long_tail else None

    def adopt_long_tail(self, profile: LongTailProfile) -> None:
        """Attach the profile a checkpoint says the run was started under.

        Used by the resume path so the recorded profile, not the resuming command,
        decides how the rest of the run is judged.
        """
        self.long_tail = profile

    def ledger(self, state: Any) -> BudgetLedger:
        if self.clock is None:
            return BudgetLedger.from_state(self.budget, {})
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


async def _provider_call(method: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Call an async provider method, refusing a synchronous one loudly.

    A provider defined with `def` returns its result — or, if it wraps an async
    client, an un-awaited coroutine that looks like an empty answer. Neither may
    reach the workflow silently, so the mistake becomes a typed, non-retryable
    provider failure naming the method.
    """
    result = method(*args, **kwargs)
    if not inspect.isawaitable(result):
        provider = getattr(getattr(method, "__self__", None), "name", "provider")
        name = getattr(method, "__qualname__", getattr(method, "__name__", "call"))
        raise ProviderError(
            f"{name} returned {type(result).__name__}, not an awaitable; provider "
            "methods must be declared with `async def`",
            provider=str(provider),
            retryable=False,
        )
    return await result


def _charge_failed_attempt(error: ProviderError, ledger: BudgetLedger) -> None:
    """A failed model call still cost tokens. Charge them; ignore exhaustion here.

    The caller is already recording the failure, and the next charge attempt will
    refuse the work, so an exhausted budget still surfaces as its own failure.
    """
    if error.tokens_used > 0:
        try:
            ledger.charge_tokens(error.tokens_used)
        except BudgetExhausted:
            pass


async def _call_with_retry(
    call: Callable[[], Awaitable[T]],
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
            return await call()
        except BudgetExhausted as error:
            failures.append(_budget_failure(stage, error, timestamp))
            return None
        except ProviderError as error:
            failures.append(_provider_failure(stage, error, timestamp))
            _charge_failed_attempt(error, ledger)
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

        async def discover() -> Any:
            # One more than the page budget, so a truncated discovery is detectable
            # rather than silently looking like "there was nothing else to read".
            return await _provider_call(
                settings.providers.sources.discover,
                message.creator,
                limit=settings.budget.max_pages + 1,
            )

        result = await _call_with_retry(
            discover,
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
                providers=message.providers,
                review_policy=message.review_policy,
                profile_id=message.profile_id,
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
            async def read(source: SourceCandidate = source) -> Any:
                ledger.charge_pages(1)
                return await _provider_call(settings.providers.sources.fetch, source)

            page = await _call_with_retry(
                read,
                stage=WorkflowStage.EXTRACT,
                ledger=ledger,
                timestamp=settings.timestamp,
                failures=failures,
            )
            if page is None:
                continue

            async def extract(page: Any = page) -> Any:
                extraction = await _provider_call(
                    settings.providers.extractor.extract, message.creator, page
                )
                ledger.charge_tokens(extraction.tokens_used)
                return extraction

            extraction = await _call_with_retry(
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
                providers=message.providers,
                review_policy=message.review_policy,
                profile_id=message.profile_id,
            )
        )


class ReviewClaimsExecutor(Executor):
    """Stage 3 — run the three semantic lenses concurrently over sources and claims.

    The lenses are independent jobs and never see each other's verdicts, so they are
    dispatched together with `asyncio.gather`. Only the *votes* are collected here;
    the decision is made in stage 4, where the deterministic gates can veto it.
    """

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

        newly_discovered = tuple(
            source.id
            for source in message.sources
            if is_newly_discovered(source, message.creator)
        )
        source_verdicts = await self._review_sources(
            message, ledger=ledger, failures=failures, newly_discovered=newly_discovered
        )
        verdicts = await self._review_claims(message, ledger=ledger, failures=failures)

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
                providers=message.providers,
                review_policy=message.review_policy,
                profile_id=message.profile_id,
                source_verdicts=tuple(source_verdicts),
                newly_discovered_source_ids=newly_discovered,
            )
        )

    async def _review_sources(
        self,
        message: ExtractedClaims,
        *,
        ledger: BudgetLedger,
        failures: list[RunFailure],
        newly_discovered: Sequence[str],
    ) -> list[SourceVerdict]:
        """Vote only on sources the creator profile did not already configure."""
        settings = self._settings
        verdicts: list[SourceVerdict] = []

        for source in message.sources:
            if source.id not in newly_discovered:
                continue
            requests = {
                lens: build_source_request(
                    lens,
                    creator=message.creator,
                    source=source,
                    sources=message.sources,
                )
                for lens in REVIEW_LENSES
            }
            results = await self._run_panel(
                "review_source",
                requests,
                ledger=ledger,
                failures=failures,
                timestamp=settings.timestamp,
            )
            for lens, result in zip(REVIEW_LENSES, results):
                if result is None:
                    verdicts.append(
                        SourceVerdict(
                            source_id=source.id,
                            decision=ClaimDecision.ABSTAIN,
                            rationale=(
                                f"the {lens.value} review did not complete; see proposal "
                                "failures. An absent reviewer never counts as consent."
                            ),
                            reviewer=_reviewer_name(settings, lens),
                            reviewed_at=settings.timestamp,
                            lens=lens,
                        )
                    )
                    continue
                verdicts.append(result.verdict)
        return verdicts

    async def _review_claims(
        self,
        message: ExtractedClaims,
        *,
        ledger: BudgetLedger,
        failures: list[RunFailure],
    ) -> list[ReviewVerdict]:
        settings = self._settings
        verdicts: list[ReviewVerdict] = []

        for claim in message.claims:
            requests = {
                lens: build_claim_request(
                    lens,
                    creator=message.creator,
                    claim=claim,
                    claims=message.claims,
                    sources=message.sources,
                )
                for lens in REVIEW_LENSES
            }
            results = await self._run_panel(
                "review_claim",
                requests,
                ledger=ledger,
                failures=failures,
                timestamp=settings.timestamp,
            )
            for lens, result in zip(REVIEW_LENSES, results):
                if result is None:
                    # A lens that could not run abstains. It is never silently
                    # treated as agreement, so a majority still needs two real votes.
                    verdicts.append(
                        ReviewVerdict(
                            claim_id=claim.id,
                            decision=ClaimDecision.ABSTAIN,
                            rationale=(
                                f"the {lens.value} review did not complete; see proposal "
                                "failures. An absent reviewer never counts as consent."
                            ),
                            reviewer=_reviewer_name(settings, lens),
                            reviewed_at=settings.timestamp,
                            lens=lens,
                        )
                    )
                    continue
                verdicts.append(result.verdict)
        return verdicts

    async def _run_panel(
        self,
        method_name: str,
        requests: Mapping[ReviewLens, Any],
        *,
        ledger: BudgetLedger,
        failures: list[RunFailure],
        timestamp: str,
    ) -> list[Any]:
        """Dispatch all three lenses at once, then settle the budget in lens order.

        Charging after the gather keeps the ledger deterministic: three concurrent
        calls would otherwise charge in whatever order they happened to finish. The
        cost of that choice is bounded and explicit — one panel can overrun the token
        budget by at most the two calls that were already in flight, and the overrun
        is charged, recorded, and stops the next panel.
        """
        panel = self._settings.providers.panel

        def dispatch(reviewer: Any, lens: ReviewLens) -> Callable[[], Awaitable[Any]]:
            async def call() -> Any:
                # The bound method is handed to the guard directly, so a provider
                # written with `def` is still refused as a typed failure naming it.
                return await _provider_call(getattr(reviewer, method_name), requests[lens])

            return call

        results = await asyncio.gather(
            *(
                _call_with_retry(
                    dispatch(reviewer, lens),
                    stage=WorkflowStage.REVIEW,
                    ledger=ledger,
                    timestamp=timestamp,
                    failures=failures,
                )
                for lens, reviewer in zip(REVIEW_LENSES, panel.reviewers)
            )
        )

        settled: list[Any] = []
        for result in results:
            if result is None:
                settled.append(None)
                continue
            try:
                ledger.charge_tokens(result.tokens_used)
            except BudgetExhausted as error:
                failures.append(_budget_failure(WorkflowStage.REVIEW, error, timestamp))
                settled.append(None)
                continue
            settled.append(result)
        return settled


def _reviewer_name(settings: RunSettings, lens: ReviewLens) -> str:
    return settings.providers.panel.reviewer_for(lens).name


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


def _profile_for(
    message: ReviewedClaims, settings: RunSettings
) -> LongTailProfile | None:
    """The long-tail profile this message was produced under, if any.

    The message is the authority: it was written when the run started and survives
    in the checkpoint. The settings only have to *supply* the same profile, because
    the promotion criteria and unresolved-mapping topics cannot be reconstructed
    from the recorded policy alone.
    """
    recorded = message.profile_id
    supplied = settings.profile_id
    if recorded != supplied:
        raise ProfileMismatch(recorded, supplied)
    return settings.long_tail if recorded is not None else None


def bundle_proposal(message: ReviewedClaims, settings: RunSettings) -> CreatorProposal:
    """Assemble the proposal. Pure enough to unit test without a workflow run.

    This is where semantic judgment meets objective validation. The gates run first
    and independently of the votes; the adjudication then combines them with the
    rule that a failed gate rejects the candidate no matter how the panel voted.

    The acceptance threshold comes from the *message*, not from the settings, so a
    resumed run is judged on the bar it started under. When the message names a
    profile, the settings must carry that same profile — it holds the promotion
    criteria and the unresolved-mapping topics — or the run stops rather than
    quietly finishing under a different one.
    """
    profile = _profile_for(message, settings)
    policy = message.review_policy or MAJORITY_POLICY
    timestamp = settings.timestamp
    checked_at = timestamp[:10]
    validations = validate_claims(message.claims, checked_at=checked_at)

    gates: list[GateResult] = []
    source_approvals: list[SourceApproval] = []
    verdicts_by_source: dict[str, list[SourceVerdict]] = {}
    for verdict in message.source_verdicts:
        verdicts_by_source.setdefault(verdict.source_id, []).append(verdict)

    for source in message.sources:
        source_gates = run_source_gates(source, checked_at=checked_at)
        gates.extend(source_gates)
        source_approvals.append(
            approve_source(
                source,
                verdicts_by_source.get(source.id, ()),
                source_gates,
                newly_discovered=source.id in message.newly_discovered_source_ids,
                decided_at=checked_at,
                policy=policy,
            )
        )

    approved_source_ids = frozenset(
        approval.source_id for approval in source_approvals if approval.approved
    )

    verdicts_by_claim: dict[str, list[ReviewVerdict]] = {}
    for verdict in message.verdicts:
        verdicts_by_claim.setdefault(verdict.claim_id, []).append(verdict)

    adjudications: list[ClaimAdjudication] = []
    for claim in message.claims:
        claim_gates = run_claim_gates(
            claim,
            creator=message.creator,
            sources=message.sources,
            claims=message.claims,
            approved_source_ids=approved_source_ids,
            checked_at=checked_at,
        )
        gates.extend(claim_gates)
        adjudications.append(
            adjudicate_claim(
                claim.id,
                verdicts_by_claim.get(claim.id, ()),
                claim_gates,
                decided_at=checked_at,
                policy=policy,
            )
        )

    accepted_ids = {
        adjudication.claim_id
        for adjudication in adjudications
        if adjudication.decision is ClaimDecision.ACCEPT
    }
    conflicts = detect_conflicts(
        [claim for claim in message.claims if claim.id in accepted_ids],
        detected_at=checked_at,
    ) + disagreement_conflicts(message.claims, adjudications, detected_at=checked_at)

    # Only the long-tail path records these. A creator with a reviewed dedicated
    # profile has reviewed terminology and naming rules, so its conflict output is
    # unchanged — byte for byte — by everything below.
    unresolved: tuple[Conflict, ...] = ()
    promotion = None
    if profile is not None:
        unresolved = unresolved_mapping_conflicts(
            profile, message.claims, adjudications, detected_at=checked_at
        )
        conflicts = conflicts + unresolved
        promotion = assess_promotion(
            profile,
            creator_id=message.creator.creator_id,
            claims=message.claims,
            adjudications=adjudications,
            source_approvals=source_approvals,
            unresolved=unresolved,
            assessed_at=checked_at,
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

    vetoed = [adjudication for adjudication in adjudications if adjudication.vetoed_by]
    unapproved = [
        approval for approval in source_approvals if not approval.approved
    ]

    if message.failures and not message.sources and not message.claims:
        status = ProposalStatus.FAILED
    elif message.failures or conflicts:
        status = ProposalStatus.INCOMPLETE
    else:
        status = ProposalStatus.COMPLETE

    notes: list[str] = []
    if profile is not None:
        notes.append(
            f"generic long-tail profile {profile.id!r}: this creator has no reviewed "
            f"dedicated profile, so claims and newly discovered sources needed "
            f"{policy.decision_label}"
        )
    if usage.exhausted:
        notes.append(
            "budget exhausted (" + ", ".join(usage.exhausted_by) + "); coverage is partial"
        )
    if any(
        conflict.kind
        not in (ConflictKind.REVIEWER_DISAGREEMENT, ConflictKind.UNRESOLVED_MAPPING)
        for conflict in conflicts
    ):
        notes.append("sources disagree; conflicts are listed unresolved for a human decision")
    if any(conflict.kind is ConflictKind.REVIEWER_DISAGREEMENT for conflict in conflicts):
        notes.append(
            "the review panel split on at least one claim; every lens verdict is recorded"
        )
    if unresolved:
        notes.append(
            f"{len(unresolved)} naming, ownership or lineage mapping(s) could not be "
            "settled; they are recorded as open conflicts rather than guessed"
        )
    if vetoed:
        notes.append(
            f"{len(vetoed)} claim(s) rejected by a deterministic gate; a reviewer "
            "majority cannot override one"
        )
    if unapproved:
        notes.append(
            f"{len(unapproved)} source(s) were not approved for use in this proposal"
        )
    if promotion is not None:
        notes.append(
            f"promotion signal: a dedicated profile is {'' if promotion.recommended else 'not '}"
            f"recommended for {promotion.creator_id}; creating one is a human decision"
        )

    return CreatorProposal(
        run_id=message.run_id,
        creator_id=message.creator.creator_id,
        status=status,
        generated_at=timestamp,
        sources=message.sources,
        claims=message.claims,
        verdicts=tuple(message.verdicts),
        validations=validations,
        conflicts=conflicts,
        budget=usage,
        failures=message.failures,
        notes=tuple(notes),
        providers=dict(message.providers or settings.providers.descriptor),
        gates=tuple(gates),
        adjudications=tuple(adjudications),
        source_approvals=tuple(source_approvals),
        review_policy=policy,
        promotion=promotion,
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
