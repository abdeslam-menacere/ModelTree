"""The scout triages leads for review and never launders a snippet into evidence.

Two properties matter here. A lead from a trusted, in-catalogue origin is a configured
source usable without a discovery vote; a lead from anywhere else is newly discovered
and must go through the recorded 2-of-3 review path. And a search snippet is only ever
a review aid: it travels as ``search_snippet`` and there is no path that turns it into
a claim's :class:`Evidence`.
"""

from __future__ import annotations

from dataclasses import fields

import pytest

from modeltree_updater.contracts import Evidence, SourceCandidate, SourceKind
from modeltree_updater.profiles import load_profile_library
from modeltree_updater.scout import (
    ScoutFinding,
    SourceProposal,
    SourceScout,
    snippet_is_never_evidence,
)

DISCOVERED_AT = "2026-08-18"


@pytest.fixture()
def scout():
    return SourceScout(load_profile_library()["openai"])


def test_a_lead_on_a_configured_origin_is_not_newly_discovered(scout) -> None:
    finding = ScoutFinding(
        url="https://openai.com/news/nimbus",
        title="A post",
        publisher="OpenAI",
        snippet="some surrounding text from a search result",
    )
    proposal = scout.propose(finding, discovered_at=DISCOVERED_AT)
    assert proposal.newly_discovered is False
    assert proposal.trusted_source_id == "openai-news"
    assert isinstance(proposal.candidate, SourceCandidate)
    # The catalogue decides the kind for a configured source.
    assert proposal.candidate.kind is SourceKind.OFFICIAL_ANNOUNCEMENT


def test_a_lead_from_an_unknown_origin_is_routed_through_review(scout) -> None:
    finding = ScoutFinding(
        url="https://blog.example.com/openai-rumours",
        title="What we hear",
        publisher="Someone",
        snippet="a snippet that is only a reason to go and read the page",
        proposed_kind=SourceKind.INDEPENDENT_EVALUATION,
    )
    proposal = scout.propose(finding, discovered_at=DISCOVERED_AT)
    assert proposal.newly_discovered is True
    assert proposal.trusted_source_id is None
    # The finder's guessed kind is carried forward for the reviewers to judge.
    assert proposal.candidate.kind is SourceKind.INDEPENDENT_EVALUATION


def test_a_trusted_origin_reached_by_a_disallowed_path_is_still_a_discovery(scout) -> None:
    finding = ScoutFinding(
        url="https://openai.com/careers/eng",
        title="Careers",
        publisher="OpenAI",
    )
    proposal = scout.propose(finding, discovered_at=DISCOVERED_AT)
    assert proposal.newly_discovered is True
    assert proposal.trusted_source_id is None


def test_the_snippet_travels_only_as_a_review_aid(scout) -> None:
    finding = ScoutFinding(
        url="https://blog.example.com/openai",
        title="Post",
        publisher="Someone",
        snippet="THE SNIPPET",
    )
    proposal = scout.propose(finding, discovered_at=DISCOVERED_AT)
    assert proposal.search_snippet == "THE SNIPPET"


def test_a_scout_finding_and_proposal_can_hold_no_evidence() -> None:
    # Structural guarantee: neither type has a field that could carry an Evidence
    # record, so a snippet cannot be stored as a claim's evidence by construction.
    for record in (ScoutFinding, SourceProposal):
        annotations = {field.type for field in fields(record)}
        assert not any("Evidence" in str(annotation) for annotation in annotations)


def test_there_is_no_conversion_from_a_lead_to_evidence() -> None:
    finding = ScoutFinding(url="https://example.com/x", title="t", publisher="p", snippet="s")
    with pytest.raises(TypeError):
        snippet_is_never_evidence(finding)


def test_scouting_a_batch_preserves_order_and_produces_no_claims(scout) -> None:
    findings = [
        ScoutFinding(url="https://openai.com/news/a", title="a", publisher="OpenAI"),
        ScoutFinding(url="https://blog.example.com/b", title="b", publisher="Someone"),
    ]
    proposals = scout.scout(findings, discovered_at=DISCOVERED_AT)
    assert [p.candidate.url for p in proposals] == [f.url for f in findings]
    # A scout yields source proposals, never claims or evidence.
    assert all(isinstance(p.candidate, SourceCandidate) for p in proposals)
    assert all(not isinstance(p, Evidence) for p in proposals)

    discovered = scout.newly_discovered(findings, discovered_at=DISCOVERED_AT)
    assert [p.candidate.url for p in discovered] == ["https://blog.example.com/b"]
