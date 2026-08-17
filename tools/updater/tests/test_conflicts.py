"""Conflicts stay explicit; nothing picks a winner."""

from __future__ import annotations

from modeltree_updater.conflicts import detect_conflicts
from modeltree_updater.contracts import (
    ClaimCandidate,
    ConflictKind,
    EntityKind,
    Evidence,
    content_hash,
)


def _claim(claim_id: str, value: object, source_id: str = "src-1") -> ClaimCandidate:
    return ClaimCandidate(
        id=claim_id,
        creator_id="northwind-ai",
        entity_kind=EntityKind.RELEASE,
        entity_id="northwind-harbor-2",
        field_path="contextWindow",
        value=value,
        evidence=(
            Evidence(
                source_id=source_id,
                url="https://www.example.com/northwind-ai/docs/harbor-2",
                quote="context window",
                content_hash=content_hash(str(value)),
                verified_at="2026-03-06",
            ),
        ),
        confidence=0.8,
        extracted_at="2026-01-01T00:00:00+00:00",
        extractor="fixtures:extractor",
    )


def test_agreeing_claims_produce_no_conflict() -> None:
    claims = [_claim("a", 128000, "src-1"), _claim("b", 128000, "src-2")]

    assert detect_conflicts(claims, detected_at="2026-01-01") == ()


def test_disagreeing_claims_are_reported_unresolved() -> None:
    claims = [_claim("a", 128000, "src-1"), _claim("b", 256000, "src-2")]

    conflicts = detect_conflicts(claims, detected_at="2026-01-01")

    assert len(conflicts) == 1
    assert conflicts[0].kind is ConflictKind.CONTRADICTORY_VALUES
    assert conflicts[0].claim_ids == ("a", "b")
    assert set(conflicts[0].values) == {128000, 256000}


def test_a_source_contradicting_itself_is_called_out_separately() -> None:
    claims = [_claim("a", 128000, "src-1"), _claim("b", 256000, "src-1")]

    kinds = {conflict.kind for conflict in detect_conflicts(claims, detected_at="2026-01-01")}

    assert kinds == {ConflictKind.CONTRADICTORY_VALUES, ConflictKind.CONTRADICTORY_SOURCES}


def test_different_fields_do_not_collide() -> None:
    first = _claim("a", 128000)
    second = ClaimCandidate(**{**first.__dict__, "id": "b", "field_path": "maximumOutput"})

    assert detect_conflicts([first, second], detected_at="2026-01-01") == ()
