"""Validation mirrors the dataset's shape rules and its evidence requirement."""

from __future__ import annotations

from modeltree_updater.contracts import (
    ClaimCandidate,
    EntityKind,
    Evidence,
    ValidationStatus,
    content_hash,
)
from modeltree_updater.validation import validate_claim


def _claim(**overrides) -> ClaimCandidate:
    defaults = dict(
        id="claim-1",
        creator_id="contoso-ai",
        entity_kind=EntityKind.RELEASE,
        entity_id="contoso-atlas-3",
        field_path="contextWindow",
        value=200000,
        evidence=(
            Evidence(
                source_id="src-1",
                url="https://www.example.com/contoso-ai/blog/atlas-3",
                quote="a 200,000 token context window",
                content_hash=content_hash("a 200,000 token context window"),
                verified_at="2026-02-11",
            ),
        ),
        confidence=0.9,
        extracted_at="2026-01-01T00:00:00+00:00",
        extractor="fixtures:extractor",
    )
    defaults.update(overrides)
    return ClaimCandidate(**defaults)


def test_a_well_formed_claim_is_valid() -> None:
    result = validate_claim(_claim(), checked_at="2026-01-01")

    assert result.status is ValidationStatus.VALID
    assert result.issues == ()


def test_unknown_field_paths_are_rejected() -> None:
    result = validate_claim(_claim(field_path="vibes"), checked_at="2026-01-01")

    assert result.status is ValidationStatus.INVALID
    assert any("unknown field path" in issue for issue in result.issues)


def test_partial_dates_are_rejected_rather_than_guessed() -> None:
    result = validate_claim(
        _claim(field_path="releaseDate", value="March 2026"), checked_at="2026-01-01"
    )

    assert result.status is ValidationStatus.INVALID
    assert any("YYYY-MM-DD" in issue for issue in result.issues)


def test_a_claim_without_evidence_cannot_be_valid() -> None:
    result = validate_claim(_claim(evidence=()), checked_at="2026-01-01")

    assert result.status is ValidationStatus.INVALID
    assert any("no evidence" in issue for issue in result.issues)


def test_enum_and_list_fields_are_checked() -> None:
    bad_enum = validate_claim(
        _claim(field_path="status", value="brand-new"), checked_at="2026-01-01"
    )
    bad_list = validate_claim(
        _claim(field_path="categories", value=["telepathy"]), checked_at="2026-01-01"
    )

    assert bad_enum.status is ValidationStatus.INVALID
    assert bad_list.status is ValidationStatus.INVALID


def test_evidence_provenance_is_required() -> None:
    weak_evidence = Evidence(
        source_id="src-1",
        url="ftp://example.com/page",
        quote="   ",
        content_hash="",
        verified_at="2026",
    )
    result = validate_claim(_claim(evidence=(weak_evidence,)), checked_at="2026-01-01")

    assert result.status is ValidationStatus.INVALID
    assert len(result.issues) == 4
