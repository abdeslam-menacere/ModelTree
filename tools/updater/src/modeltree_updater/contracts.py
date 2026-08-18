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
    "ProposalStatus",
    "ReviewVerdict",
    "RunFailure",
    "RunReport",
    "SourceCandidate",
    "ValidationResult",
    "ValidationStatus",
    "WorkflowStage",
    "content_hash",
]


def content_hash(text: str) -> str:
    """Stable digest used to prove which bytes a claim was extracted from."""
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


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


class ValidationStatus(str, Enum):
    VALID = "valid"
    INVALID = "invalid"
    NOT_CHECKED = "not-checked"


class ConflictKind(str, Enum):
    CONTRADICTORY_VALUES = "contradictory-values"
    CONTRADICTORY_SOURCES = "contradictory-sources"


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
    claim_id: str
    decision: ClaimDecision
    rationale: str
    reviewer: str
    reviewed_at: str


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

    @property
    def accepted_claim_ids(self) -> tuple[str, ...]:
        return tuple(
            verdict.claim_id
            for verdict in self.verdicts
            if verdict.decision is ClaimDecision.ACCEPT
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
