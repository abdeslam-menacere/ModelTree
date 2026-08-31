"""Structural validation of claim candidates.

This mirrors the shape rules the Astro dataset enforces with Zod (`web/src/data/schema.ts`)
so a proposal cannot suggest a field that does not exist or a value the dataset would
reject. It deliberately does **not** decide whether a claim is *true* — fact-checking
policy is out of scope for this issue.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Mapping, Sequence

from .contracts import (
    ClaimCandidate,
    EntityKind,
    ValidationResult,
    ValidationStatus,
)

__all__ = [
    "DATE_PRECISIONS",
    "FIELD_REGISTRY",
    "FieldSpec",
    "PARTIAL_DATE",
    "PRECISION_SEGMENTS",
    "partial_date_is_real",
    "validate_claim",
    "validate_claims",
]

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# A date a source stated only to the year or month. The dataset stores these for
# `firstReleaseDate` and `releaseDate` because a source that announced "March 2026"
# gave no day, and inventing one to satisfy an exact-date rule records a fact nobody
# published. `ISO_DATE` above stays the rule for every date *we* observe —
# `verifiedAt`, `lastCheckedDate`, licence windows — where the day is always known.
PARTIAL_DATE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")

# How much of a date a source actually gave, and how many `-`-separated segments a
# value carries at each precision.
DATE_PRECISIONS = ("year", "month", "day")
PRECISION_SEGMENTS = {"year": 1, "month": 2, "day": 3}

LIFECYCLE_STATUS = (
    "preview",
    "current",
    "legacy",
    "deprecated",
    "research",
    # Mirrors `lifecycleStatus` in `web/src/data/schema.ts`, which is the source
    # of truth for the dataset. `unknown` is the faithful value for a source that
    # states no lifecycle term at all (a bare model card); it is a deliberate
    # vocabulary member, not a nullable escape hatch, exactly like `unknown` in
    # the `modelSelection` enum. Kept in lockstep so a record the web schema
    # accepts is never rejected here in the permissive direction. See
    # docs/adr/0007-lifecycle-status-carries-an-explicit-unknown-member.md.
    "unknown",
)
MODEL_CATEGORY = (
    "language-reasoning",
    "multimodal-generalist",
    "coding",
    "image",
    "video",
    "audio-speech",
    "embedding-reranking",
    "scientific",
    "robotics-world",
)
ACCESS_TYPE = ("proprietary-hosted", "open-weight", "source-available", "both")
ORGANIZATION_TYPE = ("company", "research-lab", "nonprofit", "community")


@dataclass(frozen=True)
class FieldSpec:
    """What the dataset will accept for one proposable field."""

    # text | url | date | partial-date | integer | number | boolean | enum | enum-list | text-list
    kind: str
    allowed: tuple[str, ...] = ()


FIELD_REGISTRY: Mapping[EntityKind, Mapping[str, FieldSpec]] = {
    EntityKind.ORGANIZATION: {
        "name": FieldSpec("text"),
        "shortName": FieldSpec("text"),
        "type": FieldSpec("enum", ORGANIZATION_TYPE),
        "website": FieldSpec("url"),
        "releasePage": FieldSpec("url"),
        "description": FieldSpec("text"),
        "verifiedAt": FieldSpec("date"),
    },
    EntityKind.FAMILY: {
        "name": FieldSpec("text"),
        "description": FieldSpec("text"),
        "categories": FieldSpec("enum-list", MODEL_CATEGORY),
        "firstReleaseDate": FieldSpec("partial-date"),
        "datePrecision": FieldSpec("enum", DATE_PRECISIONS),
        "status": FieldSpec("enum", LIFECYCLE_STATUS),
        "verifiedAt": FieldSpec("date"),
    },
    EntityKind.RELEASE: {
        "displayName": FieldSpec("text"),
        "canonicalName": FieldSpec("text"),
        "version": FieldSpec("text"),
        "releaseDate": FieldSpec("partial-date"),
        "datePrecision": FieldSpec("enum", DATE_PRECISIONS),
        "status": FieldSpec("enum", LIFECYCLE_STATUS),
        "categories": FieldSpec("enum-list", MODEL_CATEGORY),
        "accessType": FieldSpec("enum", ACCESS_TYPE),
        "contextWindow": FieldSpec("integer"),
        "maximumOutput": FieldSpec("integer"),
        "apiAliases": FieldSpec("text-list"),
        "summary": FieldSpec("text"),
        "intendedUse": FieldSpec("text"),
        "license.name": FieldSpec("text"),
        "license.spdxId": FieldSpec("text"),
        "license.weightsDownloadable": FieldSpec("boolean"),
        "license.osiApproved": FieldSpec("boolean"),
        "parameters.totalBillions": FieldSpec("number"),
        "parameters.activeBillions": FieldSpec("number"),
        "verifiedAt": FieldSpec("date"),
    },
    EntityKind.PRODUCT: {
        "name": FieldSpec("text"),
        "description": FieldSpec("text"),
        "modelSelection": FieldSpec("enum", ("fixed", "routed", "unknown")),
        "effectiveFrom": FieldSpec("date"),
        "verifiedAt": FieldSpec("date"),
    },
    EntityKind.SERVING_PLATFORM: {
        "name": FieldSpec("text"),
        "website": FieldSpec("url"),
        "type": FieldSpec(
            "enum",
            ("first-party-api", "cloud-platform", "aggregator", "model-hub", "local-runtime"),
        ),
        "verifiedAt": FieldSpec("date"),
    },
    EntityKind.DEPLOYMENT: {
        "apiIdentifier": FieldSpec("text"),
        "deliveryMode": FieldSpec(
            "enum",
            ("hosted-api", "managed-endpoint", "downloadable-weights", "local-runtime"),
        ),
        "effectiveFrom": FieldSpec("date"),
        "verifiedAt": FieldSpec("date"),
    },
}


def partial_date_is_real(value: str) -> bool:
    """Whether a `YYYY`, `YYYY-MM` or `YYYY-MM-DD` value names days that exist.

    Only the segments a source actually gave are checked. `2026-02` is real because
    February 2026 exists; asking whether its *day* is real would mean picking one.
    """
    segments = value.split("-")
    if len(segments) >= 2 and not 1 <= int(segments[1]) <= 12:
        return False
    if len(segments) < 3:
        return True
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _value_issues(spec: FieldSpec, field_path: str, value: Any) -> list[str]:
    issues: list[str] = []
    if spec.kind == "text":
        if not isinstance(value, str) or not value.strip():
            issues.append(f"{field_path} must be a non-empty string")
    elif spec.kind == "url":
        if not isinstance(value, str) or not value.startswith(("http://", "https://")):
            issues.append(f"{field_path} must be an absolute http(s) URL")
    elif spec.kind == "date":
        if not isinstance(value, str) or not ISO_DATE.match(value):
            issues.append(f"{field_path} must be a YYYY-MM-DD date")
    elif spec.kind == "partial-date":
        if not isinstance(value, str) or not PARTIAL_DATE.match(value):
            issues.append(f"{field_path} must be a YYYY, YYYY-MM or YYYY-MM-DD date")
        elif not partial_date_is_real(value):
            issues.append(f"{field_path} is not a real date: {value!r}")
    elif spec.kind == "integer":
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            issues.append(f"{field_path} must be a positive integer")
    elif spec.kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
            issues.append(f"{field_path} must be a positive number")
    elif spec.kind == "boolean":
        if not isinstance(value, bool):
            issues.append(f"{field_path} must be a boolean")
    elif spec.kind == "enum":
        if value not in spec.allowed:
            issues.append(f"{field_path} must be one of {', '.join(spec.allowed)}")
    elif spec.kind in {"enum-list", "text-list"}:
        if not isinstance(value, (list, tuple)) or not value:
            issues.append(f"{field_path} must be a non-empty list")
        else:
            for item in value:
                if spec.kind == "enum-list" and item not in spec.allowed:
                    issues.append(f"{field_path} contains unsupported value {item!r}")
                if spec.kind == "text-list" and (not isinstance(item, str) or not item.strip()):
                    issues.append(f"{field_path} contains a non-string entry")
    return issues


def validate_claim(claim: ClaimCandidate, *, checked_at: str) -> ValidationResult:
    """Check one claim's shape and provenance. Never mutates the claim."""
    issues: list[str] = []

    fields = FIELD_REGISTRY.get(claim.entity_kind)
    if fields is None:
        issues.append(f"unsupported entity kind {claim.entity_kind.value}")
    else:
        spec = fields.get(claim.field_path)
        if spec is None:
            issues.append(
                f"unknown field path {claim.field_path!r} for {claim.entity_kind.value}"
            )
        else:
            issues.extend(_value_issues(spec, claim.field_path, claim.value))

    if not claim.entity_id.strip():
        issues.append("entity id is required")

    if not claim.evidence:
        issues.append("claim has no evidence; every fact needs a primary source")
    for index, evidence in enumerate(claim.evidence):
        label = f"evidence[{index}]"
        if not evidence.url.startswith(("http://", "https://")):
            issues.append(f"{label}.url must be an absolute http(s) URL")
        if not evidence.quote.strip():
            issues.append(f"{label}.quote must not be empty")
        if not ISO_DATE.match(evidence.verified_at):
            issues.append(f"{label}.verified_at must be a YYYY-MM-DD date")
        if not evidence.content_hash:
            issues.append(f"{label}.content_hash must record the bytes that were read")

    if not 0.0 <= claim.confidence <= 1.0:
        issues.append("confidence must be between 0 and 1")

    status = ValidationStatus.INVALID if issues else ValidationStatus.VALID
    return ValidationResult(
        claim_id=claim.id,
        status=status,
        issues=tuple(issues),
        checked_at=checked_at,
    )


def validate_claims(
    claims: Sequence[ClaimCandidate], *, checked_at: str
) -> tuple[ValidationResult, ...]:
    return tuple(validate_claim(claim, checked_at=checked_at) for claim in claims)
