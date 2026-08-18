"""Deterministic gates are objective, and they are the ones that bind.

These tests pin the gate behaviour directly, without a workflow run. The point of
the gates is that they do not depend on judgment at all, so they are testable as
pure functions — which is exactly why a vote is not allowed to overrule them.
"""

from __future__ import annotations

import pytest

from modeltree_updater.contracts import (
    ClaimCandidate,
    CreatorRequest,
    EntityKind,
    Evidence,
    GateStatus,
    SourceCandidate,
    SourceKind,
)
from modeltree_updater.gates import (
    CLAIM_GATES,
    GATE_DATES,
    GATE_LINEAGE,
    GATE_REFERENCES,
    GATE_SCHEMA,
    GATE_SOURCE_APPROVAL,
    GATE_URL_SAFETY,
    failed_gates,
    run_claim_gates,
    run_source_gates,
    url_safety_issues,
)

CHECKED_AT = "2026-06-01"
CREATOR = CreatorRequest(
    creator_id="contoso-ai",
    creator_name="Contoso AI",
    entry_urls=("https://www.example.com/contoso-ai/releases",),
)


def _source(**overrides) -> SourceCandidate:
    values = {
        "id": "contoso-ai-notes",
        "creator_id": "contoso-ai",
        "url": "https://www.example.com/contoso-ai/releases",
        "title": "Release notes",
        "publisher": "Contoso AI",
        "kind": SourceKind.OFFICIAL_DOCS,
        "discovered_at": CHECKED_AT,
    }
    values.update(overrides)
    return SourceCandidate(**values)


def _claim(**overrides) -> ClaimCandidate:
    evidence = overrides.pop(
        "evidence",
        (
            Evidence(
                source_id="contoso-ai-notes",
                url="https://www.example.com/contoso-ai/releases",
                quote="Atlas 3 supports a 200,000 token context window",
                content_hash="sha256:abc",
                verified_at="2026-05-01",
            ),
        ),
    )
    values = {
        "id": "contoso-ai-atlas-3-context-window",
        "creator_id": "contoso-ai",
        "entity_kind": EntityKind.RELEASE,
        "entity_id": "contoso-atlas-3",
        "field_path": "contextWindow",
        "value": 200000,
        "confidence": 0.9,
        "extracted_at": CHECKED_AT,
        "extractor": "tests",
    }
    values.update(overrides)
    return ClaimCandidate(evidence=evidence, **values)


def _run(claim: ClaimCandidate, *, approved=frozenset({"contoso-ai-notes"}), sources=None):
    return run_claim_gates(
        claim,
        creator=CREATOR,
        sources=sources if sources is not None else [_source()],
        claims=[claim],
        approved_source_ids=approved,
        checked_at=CHECKED_AT,
    )


def _gate(results, name):
    return next(result for result in results if result.gate == name)


def test_a_clean_claim_passes_every_gate() -> None:
    results = _run(_claim())

    assert [result.gate for result in results] == list(CLAIM_GATES)
    assert all(result.status is GateStatus.PASSED for result in results)
    assert failed_gates(results) == ()


@pytest.mark.parametrize(
    "url",
    [
        "http://www.example.com/notes",
        "https://user:secret@www.example.com/notes",
        "https://localhost/notes",
        "https://192.0.2.10/notes",
        "https://internal.local/notes",
        "ftp://www.example.com/notes",
        "",
    ],
)
def test_unsafe_urls_are_refused(url) -> None:
    assert url_safety_issues("url", url)


def test_a_safe_url_has_no_issues() -> None:
    assert url_safety_issues("url", "https://www.example.com/a/b?c=d#e") == []


def test_an_unsafe_evidence_url_fails_the_url_gate() -> None:
    evidence = Evidence(
        source_id="contoso-ai-notes",
        url="http://www.example.com/contoso-ai/releases",
        quote="q",
        content_hash="sha256:abc",
        verified_at="2026-05-01",
    )
    results = _run(_claim(evidence=(evidence,)))

    assert _gate(results, GATE_URL_SAFETY).status is GateStatus.FAILED


def test_an_imprecise_date_fails_both_schema_and_date_gates() -> None:
    results = _run(_claim(field_path="releaseDate", value="March 2026"))

    assert _gate(results, GATE_SCHEMA).status is GateStatus.FAILED
    assert _gate(results, GATE_DATES).status is GateStatus.FAILED


def test_an_impossible_calendar_date_is_refused() -> None:
    results = _run(_claim(field_path="releaseDate", value="2026-02-30"))

    assert _gate(results, GATE_DATES).status is GateStatus.FAILED


def test_evidence_cannot_be_verified_after_the_run_that_read_it() -> None:
    evidence = Evidence(
        source_id="contoso-ai-notes",
        url="https://www.example.com/contoso-ai/releases",
        quote="q",
        content_hash="sha256:abc",
        verified_at="2027-01-01",
    )
    results = _run(_claim(evidence=(evidence,)))

    assert _gate(results, GATE_DATES).status is GateStatus.FAILED


def test_a_future_release_date_is_allowed_but_a_distant_one_is_not() -> None:
    near = _run(_claim(field_path="releaseDate", value="2027-01-01"))
    far = _run(_claim(field_path="releaseDate", value="2099-01-01"))

    assert _gate(near, GATE_DATES).status is GateStatus.PASSED
    assert _gate(far, GATE_DATES).status is GateStatus.FAILED


def test_evidence_pointing_at_a_source_this_run_never_read_is_refused() -> None:
    evidence = Evidence(
        source_id="somewhere-else",
        url="https://www.example.com/contoso-ai/releases",
        quote="q",
        content_hash="sha256:abc",
        verified_at="2026-05-01",
    )
    results = _run(_claim(evidence=(evidence,)), approved=frozenset({"somewhere-else"}))

    assert _gate(results, GATE_REFERENCES).status is GateStatus.FAILED


def test_evidence_whose_url_does_not_match_its_source_is_refused() -> None:
    evidence = Evidence(
        source_id="contoso-ai-notes",
        url="https://www.example.com/somewhere/else",
        quote="q",
        content_hash="sha256:abc",
        verified_at="2026-05-01",
    )
    results = _run(_claim(evidence=(evidence,)))

    assert _gate(results, GATE_REFERENCES).status is GateStatus.FAILED


def test_a_claim_with_no_evidence_is_refused() -> None:
    results = _run(_claim(evidence=()))

    assert _gate(results, GATE_REFERENCES).status is GateStatus.FAILED


def test_a_claim_about_another_creator_is_a_lineage_violation() -> None:
    results = _run(_claim(creator_id="fabrikam-ai"))

    assert _gate(results, GATE_LINEAGE).status is GateStatus.FAILED


def test_an_entity_id_that_is_not_a_slug_is_refused() -> None:
    results = _run(_claim(entity_id="Contoso Atlas 3"))

    assert _gate(results, GATE_LINEAGE).status is GateStatus.FAILED


def test_one_entity_id_may_not_stand_for_two_entity_kinds() -> None:
    release = _claim()
    product = _claim(
        id="contoso-ai-atlas-3-name",
        entity_kind=EntityKind.PRODUCT,
        field_path="name",
        value="Atlas 3",
    )
    results = run_claim_gates(
        release,
        creator=CREATOR,
        sources=[_source()],
        claims=[release, product],
        approved_source_ids=frozenset({"contoso-ai-notes"}),
        checked_at=CHECKED_AT,
    )

    assert _gate(results, GATE_LINEAGE).status is GateStatus.FAILED


def test_a_claim_resting_on_an_unapproved_source_is_refused() -> None:
    results = _run(_claim(), approved=frozenset())

    assert _gate(results, GATE_SOURCE_APPROVAL).status is GateStatus.FAILED


def test_source_gates_refuse_an_insecure_source_url() -> None:
    results = run_source_gates(
        _source(url="http://www.example.com/notes"), checked_at=CHECKED_AT
    )

    assert failed_gates(results) == (GATE_URL_SAFETY,)


def test_source_gates_refuse_an_imprecise_publication_date() -> None:
    results = run_source_gates(_source(published_date="May 2026"), checked_at=CHECKED_AT)

    assert "typed-contract" in failed_gates(results)


def test_gate_results_are_a_pass_or_a_fail_with_no_severity_dial() -> None:
    """There is no 'warning' status a caller could choose to ignore."""
    results = _run(_claim())

    assert {result.status for result in results} <= {
        GateStatus.PASSED,
        GateStatus.FAILED,
        GateStatus.NOT_APPLICABLE,
    }
