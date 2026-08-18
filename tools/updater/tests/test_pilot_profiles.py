"""The four pilot creators run offline through the recorded review path.

Each pilot fixture is a synthetic, offline exercise (RFC 2606 reserved hosts, invented
model names — the real seeds live in profiles/<id>.json). A run of each must produce
claim candidates, send exactly one newly discovered source through the recorded 2-of-3
approval path, and leave at least one unknown/conflict explicit as needs-human-review.
The pilot creator ids line up with the version-controlled profiles.
"""

from __future__ import annotations

import asyncio

from modeltree_updater.contracts import ClaimDecision
from modeltree_updater.profiles import load_profile_library
from modeltree_updater.review import MAJORITY
from modeltree_updater.runner import run_creator

PILOT_CREATORS = ("openai", "anthropic", "google-deepmind", "meta")


def _run(creator_id, library, settings):
    return asyncio.run(run_creator(library.creators[creator_id], settings, run_id="run-" + creator_id))


def test_every_pilot_creator_has_a_matching_profile(library) -> None:
    profiles = load_profile_library()
    for creator_id in PILOT_CREATORS:
        assert creator_id in library.creators, f"missing pilot fixture for {creator_id}"
        assert creator_id in profiles.creator_ids, f"missing profile for {creator_id}"


def test_each_pilot_run_produces_claim_candidates(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        assert proposal.claims, f"{creator_id} produced no claim candidates"


def test_each_pilot_sends_one_discovery_through_the_recorded_review_path(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        discovered = [a for a in proposal.source_approvals if a.newly_discovered]
        assert len(discovered) == 1, f"{creator_id} should have exactly one discovery"
        approval = discovered[0]
        # It went through the 2-of-3 panel and a majority approved it — recorded, not
        # asserted: three lens verdicts and a majority of accepts.
        assert approval.approved is True
        assert len(approval.verdicts) == 3
        assert approval.accept_votes >= MAJORITY


def test_each_pilot_leaves_an_unknown_or_conflict_explicit(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        unresolved = [
            adjudication
            for adjudication in proposal.adjudications
            if adjudication.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
        ]
        assert unresolved, f"{creator_id} smoothed over its unknown/conflict"


def test_a_configured_source_needs_no_discovery_vote(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        configured = [a for a in proposal.source_approvals if not a.newly_discovered]
        assert configured, f"{creator_id} has no configured source"
        assert all(approval.approved for approval in configured)
