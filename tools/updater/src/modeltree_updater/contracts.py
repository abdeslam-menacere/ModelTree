"""Typed contracts for the proposal-only ModelTree updater.

Every contract is immutable and serialises to plain JSON so that a proposal can be
read, diffed, and audited by a human without running the tool. Nothing in this
module writes ModelTree data; a proposal is a *suggestion* carrying its evidence.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import Any, Mapping, Sequence

__all__ = [
    "BudgetUsage",
    "ClaimAdjudication",
    "ClaimCandidate",
    "ClaimDecision",
    "Conflict",
    "ConflictKind",
    "CreatorProposal",
    "CreatorRequest",
    "Evidence",
    "EntityKind",
    "FailureKind",
    "FetchedPage",
    "GateResult",
    "GateStatus",
    "ProposalStatus",
    "REVIEW_LENSES",
    "ReviewLens",
    "ReviewVerdict",
    "RunFailure",
    "RunReport",
    "SourceApproval",
    "SourceCandidate",
    "SourceVerdict",
    "ValidationResult",
    "ValidationStatus",
    "WorkflowStage",
    "content_hash",
    "content_hash_bytes",
]


def content_hash_bytes(raw: bytes) -> str:
    """Stable digest of the *exact* bytes retrieved from a source.

    Hashing the raw response body — not a decoded, normalised, or re-serialised
    rendering of it — is what makes the digest a reproducible proof: a second
    fetch of an unchanged page yields byte-identical content and therefore the
    same hash, while any change to the served bytes changes it.
    """
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def content_hash(text: str) -> str:
    """Stable digest used to prove which bytes a claim was extracted from."""
    return content_hash_bytes(text.encode("utf-8"))


def _encode(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode(item) for item in value]
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return value


@dataclass(frozen=True)
class _Serialisable:
    def to_dict(self) -> dict[str, Any]:
        return {
            name: _encode(getattr(self, name))
            for name in self.__dataclass_fields__  # type: ignore[attr-defined]
        }

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False) + "\n"


class EntityKind(str, Enum):
    """ModelTree entity a claim is about. Creators, models, products, and serving
    platforms stay separate; a claim never spans two of them."""

    ORGANIZATION = "organization"
    FAMILY = "family"
    RELEASE = "release"
    PRODUCT = "product"
    SERVING_PLATFORM = "serving-platform"
    DEPLOYMENT = "deployment"


class SourceKind(str, Enum):
    OFFICIAL_ANNOUNCEMENT = "official-announcement"
    OFFICIAL_DOCS = "official-docs"
    MODEL_CARD = "model-card"
    REPOSITORY = "repository"
    BENCHMARK_OWNER = "benchmark-owner"
    INDEPENDENT_EVALUATION = "independent-evaluation"


class ClaimDecision(str, Enum):
    ACCEPT = "accept"
    REJECT = "reject"
    NEEDS_HUMAN_REVIEW = "needs-human-review"
    # A reviewer that could not judge — no opinion, and never counted as consent.
    ABSTAIN = "abstain"


class ReviewLens(str, Enum):
    """The three semantic review jobs.

    They are deliberately *different jobs*, not three copies of one reviewer: each
    lens is given a different view of the run (see `review.py`) and answers a
    different question, so agreement between two of them means something.
    """

    PROVENANCE = "provenance"
    CONSISTENCY = "consistency"
    EDITORIAL = "editorial"


REVIEW_LENSES: tuple[ReviewLens, ...] = (
    ReviewLens.PROVENANCE,
    ReviewLens.CONSISTENCY,
    ReviewLens.EDITORIAL,
)


class GateStatus(str, Enum):
    """Outcome of one deterministic gate. `FAILED` is a veto, never a vote."""

    PASSED = "passed"
    FAILED = "failed"
    NOT_APPLICABLE = "not-applicable"


class ValidationStatus(str, Enum):
    VALID = "valid"
    INVALID = "invalid"
    NOT_CHECKED = "not-checked"


class ConflictKind(str, Enum):
    CONTRADICTORY_VALUES = "contradictory-values"
    CONTRADICTORY_SOURCES = "contradictory-sources"
    # The reviewers themselves disagreed. Recorded rather than resolved: a 2-of-3
    # majority is a decision, not a consensus, and the dissent stays visible.
    REVIEWER_DISAGREEMENT = "reviewer-disagreement"


class ProposalStatus(str, Enum):
    """A proposal is never silently partial: incomplete and failed are recorded."""

    COMPLETE = "complete"
    INCOMPLETE = "incomplete"
    FAILED = "failed"


class WorkflowStage(str, Enum):
    DISCOVER = "discover-sources"
    EXTRACT = "extract-claims"
    REVIEW = "review-claims"
    VALIDATE = "validate-and-bundle"


class FailureKind(str, Enum):
    BUDGET_EXHAUSTED = "budget-exhausted"
    PROVIDER_FAILURE = "provider-failure"
    INTERNAL_ERROR = "internal-error"


@dataclass(frozen=True)
class CreatorRequest(_Serialisable):
    """One creator selected for a run."""

    creator_id: str
    creator_name: str
    entry_urls: tuple[str, ...] = ()
    notes: str | None = None


@dataclass(frozen=True)
class SourceCandidate(_Serialisable):
    id: str
    creator_id: str
    url: str
    title: str
    publisher: str
    kind: SourceKind
    discovered_at: str
    published_date: str | None = None


@dataclass(frozen=True)
class FetchedPage(_Serialisable):
    source: SourceCandidate
    text: str
    retrieved_at: str
    content_hash: str


@dataclass(frozen=True)
class Evidence(_Serialisable):
    """Why a claim is believed. A claim without evidence cannot be accepted."""

    source_id: str
    url: str
    quote: str
    content_hash: str
    verified_at: str


@dataclass(frozen=True)
class ClaimCandidate(_Serialisable):
    """One atomic assertion about one field of one entity."""

    id: str
    creator_id: str
    entity_kind: EntityKind
    entity_id: str
    field_path: str
    value: Any
    evidence: tuple[Evidence, ...]
    confidence: float
    extracted_at: str
    extractor: str


@dataclass(frozen=True)
class ReviewVerdict(_Serialisable):
    """One reviewer's judgment of one claim. Never rewritten after the fact.

    `lens` records *which job* produced it, so the three identities survive into
    the bundle. `evidence_refs` names the evidence the reviewer actually cited.
    """

    claim_id: str
    decision: ClaimDecision
    rationale: str
    reviewer: str
    reviewed_at: str
    lens: ReviewLens | None = None
    evidence_refs: tuple[str, ...] = ()


@dataclass(frozen=True)
class SourceVerdict(_Serialisable):
    """One reviewer's judgment of a newly discovered source."""

    source_id: str
    decision: ClaimDecision
    rationale: str
    reviewer: str
    reviewed_at: str
    lens: ReviewLens | None = None


@dataclass(frozen=True)
class GateResult(_Serialisable):
    """One deterministic check against one subject.

    A failed gate is a veto: no reviewer majority can overturn it. That asymmetry
    is the point — semantic judgment is advisory, objective validation is binding.
    """

    gate: str
    subject_kind: str  # "claim" | "source"
    subject_id: str
    status: GateStatus
    issues: tuple[str, ...]
    checked_at: str

    @property
    def failed(self) -> bool:
        return self.status is GateStatus.FAILED


@dataclass(frozen=True)
class ClaimAdjudication(_Serialisable):
    """How one claim was decided, showing the votes *and* the gates separately.

    `semantic_decision` is what the reviewers alone concluded; `decision` is what
    actually binds. When they differ, a deterministic gate vetoed the majority and
    `vetoed_by` names it.
    """

    claim_id: str
    decision: ClaimDecision
    semantic_decision: ClaimDecision
    accept_votes: int
    reject_votes: int
    abstain_votes: int
    vetoed_by: tuple[str, ...]
    unanimous: bool
    rationale: str
    verdicts: tuple[ReviewVerdict, ...]
    decided_at: str


@dataclass(frozen=True)
class SourceApproval(_Serialisable):
    """Whether a source may back claims in this run's proposal.

    Sources the creator profile already configured are trusted without a vote. A
    newly discovered source needs a 2-of-3 semantic majority — and still cannot be
    used if a deterministic gate (URL safety, contract shape) failed.
    """

    source_id: str
    newly_discovered: bool
    approved: bool
    accept_votes: int
    reject_votes: int
    abstain_votes: int
    vetoed_by: tuple[str, ...]
    rationale: str
    verdicts: tuple[SourceVerdict, ...]
    decided_at: str


@dataclass(frozen=True)
class ValidationResult(_Serialisable):
    claim_id: str
    status: ValidationStatus
    issues: tuple[str, ...]
    checked_at: str


@dataclass(frozen=True)
class Conflict(_Serialisable):
    id: str
    entity_kind: EntityKind
    entity_id: str
    field_path: str
    kind: ConflictKind
    claim_ids: tuple[str, ...]
    values: tuple[Any, ...]
    detected_at: str


@dataclass(frozen=True)
class BudgetUsage(_Serialisable):
    pages_fetched: int
    tokens_used: int
    elapsed_seconds: float
    retries_used: int
    max_pages: int
    max_tokens: int
    max_seconds: float
    max_retries: int
    exhausted_by: tuple[str, ...] = ()

    @property
    def exhausted(self) -> bool:
        return bool(self.exhausted_by)


@dataclass(frozen=True)
class RunFailure(_Serialisable):
    """An explicit, typed outcome. Failures are recorded, never swallowed."""

    stage: WorkflowStage
    kind: FailureKind
    message: str
    occurred_at: str
    retryable: bool = False
    detail: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CreatorProposal(_Serialisable):
    """The audited bundle produced for one creator. Read-only by construction."""

    run_id: str
    creator_id: str
    status: ProposalStatus
    generated_at: str
    sources: tuple[SourceCandidate, ...]
    claims: tuple[ClaimCandidate, ...]
    verdicts: tuple[ReviewVerdict, ...]
    validations: tuple[ValidationResult, ...]
    conflicts: tuple[Conflict, ...]
    budget: BudgetUsage
    failures: tuple[RunFailure, ...] = ()
    notes: tuple[str, ...] = ()
    # Which providers produced this proposal. Provenance is the artefact's point,
    # so it is recorded per creator and survives a resumed run.
    providers: Mapping[str, str] = field(default_factory=dict)
    # Every deterministic check that ran, passed or failed, and how each claim was
    # decided from the three lens verdicts plus those checks.
    gates: tuple[GateResult, ...] = ()
    adjudications: tuple[ClaimAdjudication, ...] = ()
    source_approvals: tuple[SourceApproval, ...] = ()

    @property
    def accepted_claim_ids(self) -> tuple[str, ...]:
        if self.adjudications:
            return tuple(
                adjudication.claim_id
                for adjudication in self.adjudications
                if adjudication.decision is ClaimDecision.ACCEPT
            )
        return tuple(
            verdict.claim_id
            for verdict in self.verdicts
            if verdict.decision is ClaimDecision.ACCEPT
        )

    @property
    def vetoed_claim_ids(self) -> tuple[str, ...]:
        """Claims a deterministic gate rejected, whatever the reviewers voted."""
        return tuple(
            adjudication.claim_id
            for adjudication in self.adjudications
            if adjudication.vetoed_by
        )


@dataclass(frozen=True)
class RunReport(_Serialisable):
    """Everything one CLI invocation produced, including the creators that failed."""

    run_id: str
    started_at: str
    completed_at: str
    proposals: tuple[CreatorProposal, ...]
    settings: Mapping[str, Any] = field(default_factory=dict)

    @property
    def failed_creator_ids(self) -> tuple[str, ...]:
        return tuple(
            proposal.creator_id
            for proposal in self.proposals
            if proposal.status is ProposalStatus.FAILED
        )

    @property
    def incomplete_creator_ids(self) -> tuple[str, ...]:
        return tuple(
            proposal.creator_id
            for proposal in self.proposals
            if proposal.status is ProposalStatus.INCOMPLETE
        )


def creator_requests_from_ids(
    creator_ids: Sequence[str],
    catalog: Mapping[str, CreatorRequest],
) -> tuple[CreatorRequest, ...]:
    """Resolve CLI creator ids against a catalog, failing loudly on unknown ids."""
    unknown = [creator_id for creator_id in creator_ids if creator_id not in catalog]
    if unknown:
        raise KeyError(f"unknown creator id(s): {', '.join(sorted(unknown))}")
    return tuple(catalog[creator_id] for creator_id in creator_ids)
