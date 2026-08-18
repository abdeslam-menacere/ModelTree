"""The three-lens panel: different jobs, 2-of-3 majority, and no vote over a gate.

The two properties these hold down are the ones the program specification cares
about. First, the three reviewers are genuinely different jobs — each is handed a
different view of the run, so agreement between two of them is corroboration
rather than an echo. Second, the majority is advisory about *semantic judgment
only*: a failed deterministic gate rejects the candidate however the panel voted,
and there is no configuration that changes that.
"""

from __future__ import annotations

import asyncio

from modeltree_updater.contracts import (
    ClaimCandidate,
    ClaimDecision,
    ConflictKind,
    CreatorRequest,
    EntityKind,
    Evidence,
    GateResult,
    GateStatus,
    ProposalStatus,
    ReviewLens,
    ReviewVerdict,
    SourceCandidate,
    SourceKind,
    SourceVerdict,
)
from modeltree_updater.review import (
    MAJORITY,
    PANEL_SIZE,
    adjudicate_claim,
    approve_source,
    build_claim_request,
    build_source_request,
    disagreement_conflicts,
    is_newly_discovered,
)
from modeltree_updater.runner import run_creator

DECIDED_AT = "2026-06-01"
CREATOR = CreatorRequest(
    creator_id="contoso-ai",
    creator_name="Contoso AI",
    entry_urls=("https://www.example.com/contoso-ai/releases",),
)


def _run(creator_id, library, settings):
    return asyncio.run(run_creator(library.creators[creator_id], settings, run_id="run-test"))


def _source(source_id="contoso-ai-notes", url="https://www.example.com/contoso-ai/releases"):
    return SourceCandidate(
        id=source_id,
        creator_id="contoso-ai",
        url=url,
        title="Release notes",
        publisher="Contoso AI",
        kind=SourceKind.OFFICIAL_DOCS,
        discovered_at=DECIDED_AT,
    )


def _claim(claim_id="contoso-ai-atlas-3-context-window", **overrides):
    values = {
        "creator_id": "contoso-ai",
        "entity_kind": EntityKind.RELEASE,
        "entity_id": "contoso-atlas-3",
        "field_path": "contextWindow",
        "value": 200000,
        "confidence": 0.9,
        "extracted_at": DECIDED_AT,
        "extractor": "tests",
    }
    values.update(overrides)
    return ClaimCandidate(
        id=claim_id,
        evidence=(
            Evidence(
                source_id="contoso-ai-notes",
                url="https://www.example.com/contoso-ai/releases",
                quote="Atlas 3 supports a 200,000 token context window",
                content_hash="sha256:abc",
                verified_at="2026-05-01",
            ),
        ),
        **values,
    )


def _verdict(lens, decision, claim_id="contoso-ai-atlas-3-context-window"):
    return ReviewVerdict(
        claim_id=claim_id,
        decision=decision,
        rationale=f"{lens.value} says {decision.value}",
        reviewer=f"tests:{lens.value}",
        reviewed_at=DECIDED_AT,
        lens=lens,
    )


def _panel(*decisions, claim_id="contoso-ai-atlas-3-context-window"):
    return [
        _verdict(lens, decision, claim_id)
        for lens, decision in zip(ReviewLens, decisions)
    ]


def _passed(gate="schema-validation", subject="contoso-ai-atlas-3-context-window"):
    return GateResult(
        gate=gate,
        subject_kind="claim",
        subject_id=subject,
        status=GateStatus.PASSED,
        issues=(),
        checked_at=DECIDED_AT,
    )


def _failed(gate="schema-validation", subject="contoso-ai-atlas-3-context-window"):
    return GateResult(
        gate=gate,
        subject_kind="claim",
        subject_id=subject,
        status=GateStatus.FAILED,
        issues=("value is not storable",),
        checked_at=DECIDED_AT,
    )


# ------------------------------------------------------------------ distinct jobs


def test_each_lens_is_given_a_different_view_of_the_run() -> None:
    claim = _claim()
    sibling = _claim("contoso-ai-atlas-3-release-date", field_path="releaseDate", value="2026-02-10")
    sources = [_source()]

    provenance = build_claim_request(
        ReviewLens.PROVENANCE, creator=CREATOR, claim=claim, claims=[claim, sibling], sources=sources
    )
    consistency = build_claim_request(
        ReviewLens.CONSISTENCY, creator=CREATOR, claim=claim, claims=[claim, sibling], sources=sources
    )
    editorial = build_claim_request(
        ReviewLens.EDITORIAL, creator=CREATOR, claim=claim, claims=[claim, sibling], sources=sources
    )

    # Provenance reads the evidence and the source it came from, and nothing else.
    assert provenance.evidence and provenance.cited_sources
    assert provenance.sibling_claims == ()
    assert provenance.expectation is None

    # Consistency compares against siblings, without the quotes to be persuaded by.
    assert [item.id for item in consistency.sibling_claims] == [sibling.id]
    assert consistency.evidence == ()

    # Editorial sees only what the dataset expects for the field.
    assert editorial.expectation is not None
    assert editorial.expectation.field_path == "contextWindow"
    assert editorial.expectation.kind == "integer"
    assert editorial.evidence == () and editorial.sibling_claims == ()


def test_the_three_briefs_are_three_different_jobs() -> None:
    claim = _claim()
    briefs = {
        build_claim_request(
            lens, creator=CREATOR, claim=claim, claims=[claim], sources=[_source()]
        ).brief
        for lens in ReviewLens
    }

    assert len(briefs) == PANEL_SIZE


# ----------------------------------------------------------------- majority rules


def test_a_unanimous_panel_accepts() -> None:
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window",
        _panel(ClaimDecision.ACCEPT, ClaimDecision.ACCEPT, ClaimDecision.ACCEPT),
        [_passed()],
        decided_at=DECIDED_AT,
    )

    assert result.decision is ClaimDecision.ACCEPT
    assert result.unanimous is True
    assert result.accept_votes == 3


def test_a_two_of_three_majority_accepts_and_keeps_the_dissent() -> None:
    verdicts = _panel(ClaimDecision.ACCEPT, ClaimDecision.ACCEPT, ClaimDecision.REJECT)
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window", verdicts, [_passed()], decided_at=DECIDED_AT
    )

    assert result.decision is ClaimDecision.ACCEPT
    assert result.accept_votes == MAJORITY
    assert result.unanimous is False
    # The dissenting reviewer's identity, lens, and rationale all survive.
    assert [verdict.lens for verdict in result.verdicts] == list(ReviewLens)
    assert result.verdicts[2].decision is ClaimDecision.REJECT
    assert result.verdicts[2].rationale


def test_a_three_way_split_escalates_rather_than_guessing() -> None:
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window",
        _panel(
            ClaimDecision.ACCEPT, ClaimDecision.REJECT, ClaimDecision.NEEDS_HUMAN_REVIEW
        ),
        [_passed()],
        decided_at=DECIDED_AT,
    )

    assert result.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    assert (result.accept_votes, result.reject_votes, result.abstain_votes) == (1, 1, 1)


def test_abstentions_never_count_as_consent() -> None:
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window",
        _panel(ClaimDecision.ACCEPT, ClaimDecision.ABSTAIN, ClaimDecision.ABSTAIN),
        [_passed()],
        decided_at=DECIDED_AT,
    )

    assert result.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    assert result.accept_votes == 1


def test_two_real_votes_still_carry_when_the_third_lens_abstained() -> None:
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window",
        _panel(ClaimDecision.ABSTAIN, ClaimDecision.ACCEPT, ClaimDecision.ACCEPT),
        [_passed()],
        decided_at=DECIDED_AT,
    )

    assert result.decision is ClaimDecision.ACCEPT


def test_a_majority_to_reject_rejects() -> None:
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window",
        _panel(ClaimDecision.REJECT, ClaimDecision.REJECT, ClaimDecision.ACCEPT),
        [_passed()],
        decided_at=DECIDED_AT,
    )

    assert result.decision is ClaimDecision.REJECT


# --------------------------------------------------------------------- hard veto


def test_a_unanimous_accept_loses_to_a_single_failed_gate() -> None:
    """The property the whole design rests on: a vote cannot outrank a fact."""
    verdicts = _panel(ClaimDecision.ACCEPT, ClaimDecision.ACCEPT, ClaimDecision.ACCEPT)
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window",
        verdicts,
        [_passed("url-safety"), _failed("schema-validation")],
        decided_at=DECIDED_AT,
    )

    assert result.decision is ClaimDecision.REJECT
    assert result.vetoed_by == ("schema-validation",)
    # The panel's opinion is not erased; it is recorded next to the veto.
    assert result.semantic_decision is ClaimDecision.ACCEPT
    assert result.accept_votes == PANEL_SIZE
    assert result.verdicts == tuple(verdicts)
    assert "cannot override" in result.rationale


def test_every_failed_gate_is_named_in_the_veto() -> None:
    result = adjudicate_claim(
        "contoso-ai-atlas-3-context-window",
        _panel(ClaimDecision.ACCEPT, ClaimDecision.ACCEPT, ClaimDecision.ACCEPT),
        [_failed("date-sanity"), _failed("lineage-invariants")],
        decided_at=DECIDED_AT,
    )

    assert result.vetoed_by == ("date-sanity", "lineage-invariants")


# --------------------------------------------------------------- source approval


def test_a_source_on_a_configured_origin_is_not_newly_discovered() -> None:
    assert is_newly_discovered(_source(), CREATOR) is False
    assert (
        is_newly_discovered(
            _source("elsewhere", "https://blog.example.org/contoso-ai"), CREATOR
        )
        is True
    )


def _source_verdict(lens, decision, source_id="elsewhere"):
    return SourceVerdict(
        source_id=source_id,
        decision=decision,
        rationale=f"{lens.value} says {decision.value}",
        reviewer=f"tests:{lens.value}",
        reviewed_at=DECIDED_AT,
        lens=lens,
    )


def test_a_majority_may_approve_a_newly_discovered_source() -> None:
    """Deliberately permissive, and recorded as such: this is the agreed policy."""
    source = _source("elsewhere", "https://blog.example.org/contoso-ai")
    approval = approve_source(
        source,
        [
            _source_verdict(ReviewLens.PROVENANCE, ClaimDecision.ACCEPT),
            _source_verdict(ReviewLens.CONSISTENCY, ClaimDecision.ACCEPT),
            _source_verdict(ReviewLens.EDITORIAL, ClaimDecision.REJECT),
        ],
        [_passed("url-safety", "elsewhere")],
        newly_discovered=True,
        decided_at=DECIDED_AT,
    )

    assert approval.approved is True
    assert approval.accept_votes == MAJORITY
    assert len(approval.verdicts) == PANEL_SIZE


def test_a_newly_discovered_source_without_a_majority_is_not_approved() -> None:
    source = _source("elsewhere", "https://blog.example.org/contoso-ai")
    approval = approve_source(
        source,
        [
            _source_verdict(ReviewLens.PROVENANCE, ClaimDecision.ACCEPT),
            _source_verdict(ReviewLens.CONSISTENCY, ClaimDecision.ABSTAIN),
            _source_verdict(ReviewLens.EDITORIAL, ClaimDecision.ABSTAIN),
        ],
        [_passed("url-safety", "elsewhere")],
        newly_discovered=True,
        decided_at=DECIDED_AT,
    )

    assert approval.approved is False


def test_no_majority_can_approve_a_source_that_failed_a_gate() -> None:
    source = _source("elsewhere", "http://blog.example.org/contoso-ai")
    approval = approve_source(
        source,
        [
            _source_verdict(ReviewLens.PROVENANCE, ClaimDecision.ACCEPT),
            _source_verdict(ReviewLens.CONSISTENCY, ClaimDecision.ACCEPT),
            _source_verdict(ReviewLens.EDITORIAL, ClaimDecision.ACCEPT),
        ],
        [_failed("url-safety", "elsewhere")],
        newly_discovered=True,
        decided_at=DECIDED_AT,
    )

    assert approval.approved is False
    assert approval.vetoed_by == ("url-safety",)
    assert approval.accept_votes == PANEL_SIZE


def test_a_configured_source_needs_no_discovery_vote() -> None:
    approval = approve_source(
        _source(),
        [],
        [_passed("url-safety", "contoso-ai-notes")],
        newly_discovered=False,
        decided_at=DECIDED_AT,
    )

    assert approval.approved is True


# ------------------------------------------------------------------ disagreement


def test_reviewer_disagreement_becomes_a_visible_conflict() -> None:
    claim = _claim()
    adjudication = adjudicate_claim(
        claim.id,
        _panel(ClaimDecision.ACCEPT, ClaimDecision.ACCEPT, ClaimDecision.REJECT),
        [_passed()],
        decided_at=DECIDED_AT,
    )

    conflicts = disagreement_conflicts([claim], [adjudication], detected_at=DECIDED_AT)

    assert len(conflicts) == 1
    assert conflicts[0].kind is ConflictKind.REVIEWER_DISAGREEMENT
    assert conflicts[0].claim_ids == (claim.id,)
    assert set(conflicts[0].values) == {
        "provenance: accept",
        "consistency: accept",
        "editorial: reject",
    }


def test_a_unanimous_panel_raises_no_conflict() -> None:
    claim = _claim()
    adjudication = adjudicate_claim(
        claim.id,
        _panel(ClaimDecision.ACCEPT, ClaimDecision.ACCEPT, ClaimDecision.ACCEPT),
        [_passed()],
        decided_at=DECIDED_AT,
    )

    assert disagreement_conflicts([claim], [adjudication], detected_at=DECIDED_AT) == ()


# ------------------------------------------------------------- end to end, offline


def test_the_panel_records_three_verdicts_per_claim(library, settings) -> None:
    proposal = _run("contoso-ai", library, settings)

    for claim in proposal.claims:
        verdicts = [item for item in proposal.verdicts if item.claim_id == claim.id]
        assert [verdict.lens for verdict in verdicts] == list(ReviewLens)
        assert len({verdict.reviewer for verdict in verdicts}) == PANEL_SIZE


def test_fixture_panel_outcomes_cover_every_path(library, settings) -> None:
    proposal = _run("tailspin-ai", library, settings)
    by_id = {item.claim_id: item for item in proposal.adjudications}

    unanimous = by_id["tailspin-ai-vector-2-context-window"]
    majority = by_id["tailspin-ai-vector-2-license"]
    split = by_id["tailspin-ai-vector-2-parameters"]
    with_failure = by_id["tailspin-ai-vector-2-release-date"]
    starved = by_id["tailspin-ai-vector-2-status"]

    assert unanimous.unanimous and unanimous.decision is ClaimDecision.ACCEPT
    assert majority.decision is ClaimDecision.ACCEPT and majority.accept_votes == MAJORITY
    assert split.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    # A lens that could not run abstains; the other two still carry a majority.
    assert with_failure.decision is ClaimDecision.ACCEPT
    assert with_failure.abstain_votes == 1
    # ...but one real vote plus two abstentions is not a majority.
    assert starved.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    assert starved.accept_votes == 1


def test_a_failed_lens_abstains_and_is_reported_not_hidden(library, settings) -> None:
    proposal = _run("tailspin-ai", library, settings)

    abstentions = [
        verdict
        for verdict in proposal.verdicts
        if verdict.decision is ClaimDecision.ABSTAIN
        and verdict.lens is ReviewLens.PROVENANCE
    ]

    assert abstentions
    assert all("did not complete" in verdict.rationale for verdict in abstentions)
    assert proposal.failures  # the provider failure is on the record
    assert proposal.status is ProposalStatus.INCOMPLETE


def test_panel_splits_are_surfaced_as_conflicts_and_noted(library, settings) -> None:
    proposal = _run("tailspin-ai", library, settings)

    splits = [
        conflict
        for conflict in proposal.conflicts
        if conflict.kind is ConflictKind.REVIEWER_DISAGREEMENT
    ]

    assert splits
    assert any("panel split" in note for note in proposal.notes)


def test_source_approval_decides_which_claims_may_stand(library, settings) -> None:
    proposal = _run("wingtip-ai", library, settings)
    approvals = {item.source_id: item for item in proposal.source_approvals}

    configured = approvals["wingtip-ai-official-notes"]
    approved = approvals["wingtip-ai-approved-discovery"]
    refused = approvals["wingtip-ai-unapproved-discovery"]
    insecure = approvals["wingtip-ai-insecure-mirror"]

    assert configured.newly_discovered is False and configured.approved is True
    assert approved.newly_discovered is True and approved.approved is True
    assert refused.approved is False
    # Unanimous approval, refused anyway: the URL gate is not a matter of opinion.
    assert insecure.accept_votes == PANEL_SIZE
    assert insecure.approved is False
    assert insecure.vetoed_by == ("url-safety",)

    accepted = set(proposal.accepted_claim_ids)
    assert "wingtip-ai-beacon-1-release-date" in accepted
    assert "wingtip-ai-beacon-1-context-window" in accepted
    assert "wingtip-ai-beacon-1-maximum-output" in proposal.vetoed_claim_ids
    assert "wingtip-ai-beacon-1-status" in proposal.vetoed_claim_ids
