"""Contracts keep claim-level evidence and audit metadata through serialisation."""

from __future__ import annotations

import json

from modeltree_updater.contracts import (
    BudgetUsage,
    ClaimCandidate,
    ClaimDecision,
    CreatorProposal,
    EntityKind,
    Evidence,
    ProposalStatus,
    ReviewVerdict,
    content_hash,
)


def _claim(claim_id: str = "claim-1") -> ClaimCandidate:
    return ClaimCandidate(
        id=claim_id,
        creator_id="contoso-ai",
        entity_kind=EntityKind.RELEASE,
        entity_id="contoso-atlas-3",
        field_path="contextWindow",
        value=200000,
        evidence=(
            Evidence(
                source_id="contoso-ai-atlas-announcement",
                url="https://www.example.com/contoso-ai/blog/atlas-3",
                quote="Atlas 3 supports a 200,000 token context window",
                content_hash=content_hash("Atlas 3 supports a 200,000 token context window"),
                verified_at="2026-02-11",
            ),
        ),
        confidence=0.94,
        extracted_at="2026-01-01T00:00:00+00:00",
        extractor="fixtures:extractor",
    )


def test_claim_serialises_with_its_evidence() -> None:
    payload = json.loads(_claim().to_json())

    assert payload["entity_kind"] == "release"
    assert payload["evidence"][0]["quote"].startswith("Atlas 3 supports")
    assert payload["evidence"][0]["content_hash"].startswith("sha256:")
    assert payload["evidence"][0]["verified_at"] == "2026-02-11"
    assert payload["extractor"] == "fixtures:extractor"


def test_content_hash_is_stable_and_specific() -> None:
    assert content_hash("a") == content_hash("a")
    assert content_hash("a") != content_hash("b")


def test_proposal_reports_accepted_claims_only() -> None:
    accepted = _claim("claim-1")
    rejected = _claim("claim-2")
    proposal = CreatorProposal(
        run_id="run-1",
        creator_id="contoso-ai",
        status=ProposalStatus.COMPLETE,
        generated_at="2026-01-01T00:00:00+00:00",
        sources=(),
        claims=(accepted, rejected),
        verdicts=(
            ReviewVerdict(
                claim_id="claim-1",
                decision=ClaimDecision.ACCEPT,
                rationale="quoted",
                reviewer="fixtures:reviewer",
                reviewed_at="2026-01-01T00:00:00+00:00",
            ),
            ReviewVerdict(
                claim_id="claim-2",
                decision=ClaimDecision.NEEDS_HUMAN_REVIEW,
                rationale="ambiguous",
                reviewer="fixtures:reviewer",
                reviewed_at="2026-01-01T00:00:00+00:00",
            ),
        ),
        validations=(),
        conflicts=(),
        budget=BudgetUsage(0, 0, 0.0, 0, 8, 40000, 120.0, 2),
    )

    assert proposal.accepted_claim_ids == ("claim-1",)
    assert json.loads(proposal.to_json())["status"] == "complete"
