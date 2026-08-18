"""Deterministic hard gates.

These checks are **objective** and **binding**. Semantic review is advisory about
meaning; a gate is about whether the candidate is admissible at all. A failed gate
rejects the candidate outright, and no reviewer majority — unanimous or otherwise —
can overturn it. There is deliberately no override flag, no `--force`, and no
severity dial: a gate either passed or it did not.

The gates are:

``url-safety``
    Evidence and source URLs must be plain, fetchable, credential-free HTTPS.
``typed-contract``
    The candidate must actually be the typed contract it claims to be.
``schema-validation``
    The value must survive the dataset's shape rules (mirrored from the Zod schema).
``date-sanity``
    Dates must be real calendar dates at day precision, and evidence cannot have
    been verified in the future.
``reference-integrity``
    Every cited source must exist in this run and match the URL it was read from.
``lineage-invariants``
    Claims stay inside their creator, and one entity id never spans two entity kinds.
``source-approval``
    A claim may not rest on a source this run did not approve.
"""

from __future__ import annotations

import ipaddress
import json
import re
from datetime import date
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

from .contracts import (
    ClaimCandidate,
    CreatorRequest,
    EntityKind,
    Evidence,
    GateResult,
    GateStatus,
    SourceCandidate,
)
from .validation import FIELD_REGISTRY, validate_claim

__all__ = [
    "CLAIM_GATES",
    "GATE_DATES",
    "GATE_LINEAGE",
    "GATE_REFERENCES",
    "GATE_SCHEMA",
    "GATE_SOURCE_APPROVAL",
    "GATE_TYPED_CONTRACT",
    "GATE_URL_SAFETY",
    "SOURCE_GATES",
    "failed_gates",
    "run_claim_gates",
    "run_source_gates",
    "url_safety_issues",
]

GATE_URL_SAFETY = "url-safety"
GATE_TYPED_CONTRACT = "typed-contract"
GATE_SCHEMA = "schema-validation"
GATE_DATES = "date-sanity"
GATE_REFERENCES = "reference-integrity"
GATE_LINEAGE = "lineage-invariants"
GATE_SOURCE_APPROVAL = "source-approval"

SOURCE_GATES: tuple[str, ...] = (GATE_URL_SAFETY, GATE_TYPED_CONTRACT)
CLAIM_GATES: tuple[str, ...] = (
    GATE_URL_SAFETY,
    GATE_TYPED_CONTRACT,
    GATE_SCHEMA,
    GATE_DATES,
    GATE_REFERENCES,
    GATE_LINEAGE,
    GATE_SOURCE_APPROVAL,
)

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x20\x7f]")

# ModelTree records nothing from before modern computing, and a date decades out is
# a parsing accident rather than a roadmap.
EARLIEST_YEAR = 1950
MAX_YEARS_AHEAD = 5

PRIVATE_HOST_SUFFIXES = (".local", ".internal", ".localhost", ".test", ".invalid")
PRIVATE_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"})


def _result(
    gate: str,
    *,
    subject_kind: str,
    subject_id: str,
    issues: Sequence[str],
    checked_at: str,
) -> GateResult:
    return GateResult(
        gate=gate,
        subject_kind=subject_kind,
        subject_id=subject_id,
        status=GateStatus.FAILED if issues else GateStatus.PASSED,
        issues=tuple(issues),
        checked_at=checked_at,
    )


def url_safety_issues(label: str, url: Any) -> list[str]:
    """Objective URL safety. No heuristics, no reputation, no allow-list of brands.

    HTTPS is required: evidence read over plain HTTP cannot be shown to be the
    bytes the publisher served, which makes its content hash worthless.
    """
    issues: list[str] = []
    if not isinstance(url, str) or not url.strip():
        return [f"{label} must be a non-empty URL string"]
    if CONTROL_CHARACTERS.search(url):
        return [f"{label} contains whitespace or control characters"]

    try:
        parts = urlsplit(url)
    except ValueError as error:
        return [f"{label} could not be parsed: {error}"]

    if parts.scheme != "https":
        issues.append(f"{label} must use https, got {parts.scheme or 'no'} scheme")
    if parts.username or parts.password:
        issues.append(f"{label} must not embed credentials")

    host = (parts.hostname or "").lower()
    if not host:
        issues.append(f"{label} has no host")
    else:
        if host in PRIVATE_HOSTS or host.endswith(PRIVATE_HOST_SUFFIXES):
            issues.append(f"{label} points at a non-public host {host!r}")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if "." not in host:
                issues.append(f"{label} host {host!r} is not a public domain name")
        else:
            issues.append(
                f"{label} uses the bare IP address {address}; a source needs a "
                "resolvable publisher domain"
            )
    return issues


def _iso_date_issues(label: str, value: Any) -> tuple[list[str], date | None]:
    if not isinstance(value, str) or not ISO_DATE.match(value):
        return ([f"{label} must be an exact YYYY-MM-DD date, got {value!r}"], None)
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return ([f"{label} is not a real calendar date: {value!r}"], None)
    if parsed.year < EARLIEST_YEAR:
        return ([f"{label} predates {EARLIEST_YEAR}: {value!r}"], parsed)
    return ([], parsed)


def _checked_date(checked_at: str) -> date | None:
    try:
        return date.fromisoformat(checked_at[:10])
    except ValueError:  # pragma: no cover - the runner always passes an ISO date
        return None


# --------------------------------------------------------------------------- sources


def run_source_gates(source: SourceCandidate, *, checked_at: str) -> tuple[GateResult, ...]:
    """Objective checks a source must pass before its votes matter at all."""
    return (
        _result(
            GATE_URL_SAFETY,
            subject_kind="source",
            subject_id=source.id,
            issues=url_safety_issues("source.url", source.url),
            checked_at=checked_at,
        ),
        _result(
            GATE_TYPED_CONTRACT,
            subject_kind="source",
            subject_id=source.id,
            issues=_source_contract_issues(source),
            checked_at=checked_at,
        ),
    )


def _source_contract_issues(source: SourceCandidate) -> list[str]:
    issues: list[str] = []
    if not isinstance(source, SourceCandidate):  # pragma: no cover - typed by construction
        return [f"expected a SourceCandidate, got {type(source).__name__}"]
    for name in ("id", "creator_id", "title", "publisher"):
        value = getattr(source, name)
        if not isinstance(value, str) or not value.strip():
            issues.append(f"source.{name} must be a non-empty string")
    if source.published_date is not None:
        issues.extend(_iso_date_issues("source.published_date", source.published_date)[0])
    return issues


# ---------------------------------------------------------------------------- claims


def run_claim_gates(
    claim: ClaimCandidate,
    *,
    creator: CreatorRequest,
    sources: Sequence[SourceCandidate],
    claims: Sequence[ClaimCandidate],
    approved_source_ids: frozenset[str] | set[str],
    checked_at: str,
) -> tuple[GateResult, ...]:
    """Run every claim gate. Order is fixed so the bundle is byte-stable."""
    by_id = {source.id: source for source in sources}
    return (
        _result(
            GATE_URL_SAFETY,
            subject_kind="claim",
            subject_id=claim.id,
            issues=_claim_url_issues(claim),
            checked_at=checked_at,
        ),
        _result(
            GATE_TYPED_CONTRACT,
            subject_kind="claim",
            subject_id=claim.id,
            issues=_claim_contract_issues(claim),
            checked_at=checked_at,
        ),
        _result(
            GATE_SCHEMA,
            subject_kind="claim",
            subject_id=claim.id,
            issues=validate_claim(claim, checked_at=checked_at).issues,
            checked_at=checked_at,
        ),
        _result(
            GATE_DATES,
            subject_kind="claim",
            subject_id=claim.id,
            issues=_claim_date_issues(claim, checked_at=checked_at),
            checked_at=checked_at,
        ),
        _result(
            GATE_REFERENCES,
            subject_kind="claim",
            subject_id=claim.id,
            issues=_claim_reference_issues(claim, by_id),
            checked_at=checked_at,
        ),
        _result(
            GATE_LINEAGE,
            subject_kind="claim",
            subject_id=claim.id,
            issues=_claim_lineage_issues(claim, creator=creator, claims=claims),
            checked_at=checked_at,
        ),
        _result(
            GATE_SOURCE_APPROVAL,
            subject_kind="claim",
            subject_id=claim.id,
            issues=_claim_source_approval_issues(claim, approved_source_ids),
            checked_at=checked_at,
        ),
    )


def _claim_url_issues(claim: ClaimCandidate) -> list[str]:
    issues: list[str] = []
    for index, evidence in enumerate(claim.evidence):
        if not isinstance(evidence, Evidence):  # pragma: no cover - typed by construction
            issues.append(f"evidence[{index}] is not an Evidence record")
            continue
        issues.extend(url_safety_issues(f"evidence[{index}].url", evidence.url))
    return issues


def _claim_contract_issues(claim: ClaimCandidate) -> list[str]:
    issues: list[str] = []
    if not isinstance(claim.entity_kind, EntityKind):  # pragma: no cover - typed
        return [f"claim.entity_kind is {type(claim.entity_kind).__name__}, not EntityKind"]
    for name in ("id", "creator_id", "entity_id", "field_path", "extracted_at", "extractor"):
        value = getattr(claim, name)
        if not isinstance(value, str) or not value.strip():
            issues.append(f"claim.{name} must be a non-empty string")
    if not isinstance(claim.confidence, (int, float)) or isinstance(claim.confidence, bool):
        issues.append("claim.confidence must be a number")
    elif not 0.0 <= float(claim.confidence) <= 1.0:
        issues.append("claim.confidence must be between 0 and 1")
    if not isinstance(claim.evidence, tuple):
        issues.append("claim.evidence must be a tuple of Evidence records")
    else:
        for index, evidence in enumerate(claim.evidence):
            if not isinstance(evidence, Evidence):
                issues.append(f"claim.evidence[{index}] is not an Evidence record")
    if claim.value is None:
        issues.append("claim.value must not be null")
    else:
        try:
            json.dumps(claim.value)
        except (TypeError, ValueError):
            issues.append(
                f"claim.value of type {type(claim.value).__name__} is not JSON-serialisable"
            )
    return issues


def _claim_date_issues(claim: ClaimCandidate, *, checked_at: str) -> list[str]:
    issues: list[str] = []
    today = _checked_date(checked_at)

    spec = FIELD_REGISTRY.get(claim.entity_kind, {}).get(claim.field_path)
    if spec is not None and spec.kind == "date":
        problems, parsed = _iso_date_issues(f"claim.value ({claim.field_path})", claim.value)
        issues.extend(problems)
        # A future *release* date can be legitimate — a preview announced ahead of
        # time — so only an implausibly distant one is refused.
        if parsed and today and parsed.year > today.year + MAX_YEARS_AHEAD:
            issues.append(
                f"claim.value ({claim.field_path}) is more than {MAX_YEARS_AHEAD} "
                f"years beyond the run date: {claim.value!r}"
            )

    for index, evidence in enumerate(claim.evidence):
        if not isinstance(evidence, Evidence):  # pragma: no cover - typed by construction
            continue
        label = f"evidence[{index}].verified_at"
        problems, parsed = _iso_date_issues(label, evidence.verified_at)
        issues.extend(problems)
        # Nothing can have been verified after the run that is recording it.
        if parsed and today and parsed > today:
            issues.append(f"{label} is in the future relative to the run date {today.isoformat()}")
    return issues


def _claim_reference_issues(
    claim: ClaimCandidate, sources: Mapping[str, SourceCandidate]
) -> list[str]:
    issues: list[str] = []
    if not claim.evidence:
        issues.append("claim cites no source; every fact needs a primary source")
    for index, evidence in enumerate(claim.evidence):
        if not isinstance(evidence, Evidence):  # pragma: no cover - typed by construction
            continue
        label = f"evidence[{index}]"
        source = sources.get(evidence.source_id)
        if source is None:
            issues.append(
                f"{label}.source_id {evidence.source_id!r} was not read in this run"
            )
            continue
        if evidence.url != source.url:
            issues.append(
                f"{label}.url {evidence.url!r} does not match source {source.id!r} "
                f"({source.url!r})"
            )
        if not evidence.content_hash.startswith("sha256:"):
            issues.append(f"{label}.content_hash must name the bytes that were read")
    return issues


def _claim_lineage_issues(
    claim: ClaimCandidate,
    *,
    creator: CreatorRequest,
    claims: Sequence[ClaimCandidate],
) -> list[str]:
    """Entity-boundary invariants that hold regardless of what a page says."""
    issues: list[str] = []
    if claim.creator_id != creator.creator_id:
        issues.append(
            f"claim belongs to creator {claim.creator_id!r} but this run is for "
            f"{creator.creator_id!r}"
        )
    if claim.entity_id and not SLUG.match(claim.entity_id):
        issues.append(
            f"entity id {claim.entity_id!r} is not a dataset slug "
            "(lowercase letters, digits, and hyphens)"
        )
    # Creators, families, releases, products, and serving platforms are separate
    # entities. One id standing for two of them collapses that boundary.
    other_kinds = sorted(
        {
            other.entity_kind.value
            for other in claims
            if other.entity_id == claim.entity_id and other.entity_kind is not claim.entity_kind
        }
    )
    if other_kinds:
        issues.append(
            f"entity id {claim.entity_id!r} is also claimed as "
            f"{', '.join(other_kinds)}; entity kinds must stay separate"
        )
    return issues


def _claim_source_approval_issues(
    claim: ClaimCandidate, approved_source_ids: frozenset[str] | set[str]
) -> list[str]:
    return [
        f"evidence[{index}] rests on source {evidence.source_id!r}, which this run "
        "did not approve"
        for index, evidence in enumerate(claim.evidence)
        if evidence.source_id not in approved_source_ids
    ]


def failed_gates(results: Sequence[GateResult]) -> tuple[str, ...]:
    """The names of the gates that vetoed, in the order they were run."""
    return tuple(result.gate for result in results if result.failed)
