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


def test_prose_dates_are_rejected_rather_than_parsed() -> None:
    """A source writing "March 2026" states a month; `2026-03` records it.

    Prose is refused because parsing it means guessing which words are a date.
    Contrast `test_sourced_partial_dates_are_accepted` below: the *precision* a
    source gave is recordable, but only written in the dataset's own notation.
    """
    result = validate_claim(
        _claim(field_path="releaseDate", value="March 2026"), checked_at="2026-01-01"
    )

    assert result.status is ValidationStatus.INVALID
    assert any(
        "must be a YYYY, YYYY-MM or YYYY-MM-DD date" in issue for issue in result.issues
    )


def test_sourced_partial_dates_are_accepted() -> None:
    """The rule this issue exists to change, on both fields that carry a stated date."""
    for field_path, entity_kind in (
        ("releaseDate", EntityKind.RELEASE),
        ("firstReleaseDate", EntityKind.FAMILY),
    ):
        for value in ("2026", "2026-03", "2026-03-14"):
            result = validate_claim(
                _claim(entity_kind=entity_kind, field_path=field_path, value=value),
                checked_at="2026-01-01",
            )

            assert result.status is ValidationStatus.VALID, (field_path, value, result.issues)


def test_a_partial_date_naming_days_that_do_not_exist_is_refused() -> None:
    """Widening precision must not widen what counts as a real date."""
    for value in ("2026-13", "2026-00", "2026-02-30"):
        result = validate_claim(
            _claim(field_path="releaseDate", value=value), checked_at="2026-01-01"
        )

        assert result.status is ValidationStatus.INVALID, (value, result.issues)


def test_date_precision_is_proposable_and_checked_against_its_vocabulary() -> None:
    """Without this, a partial date could be proposed with no way to state its precision."""
    for entity_kind in (EntityKind.RELEASE, EntityKind.FAMILY):
        good = validate_claim(
            _claim(entity_kind=entity_kind, field_path="datePrecision", value="month"),
            checked_at="2026-01-01",
        )
        bad = validate_claim(
            _claim(entity_kind=entity_kind, field_path="datePrecision", value="decade"),
            checked_at="2026-01-01",
        )

        assert good.status is ValidationStatus.VALID, (entity_kind, good.issues)
        assert bad.status is ValidationStatus.INVALID, entity_kind


def test_dates_we_observe_ourselves_stay_exact() -> None:
    """Only dates a *source* stated were widened. `verifiedAt` is ours: we know the day."""
    for entity_kind in (EntityKind.RELEASE, EntityKind.FAMILY, EntityKind.ORGANIZATION):
        result = validate_claim(
            _claim(entity_kind=entity_kind, field_path="verifiedAt", value="2026-02"),
            checked_at="2026-01-01",
        )

        assert result.status is ValidationStatus.INVALID, entity_kind
        assert any("must be a YYYY-MM-DD date" in issue for issue in result.issues)


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
