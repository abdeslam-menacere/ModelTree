"""The generic long-tail profile: unanimity, explicit unknowns, and a promotion flag.

These tests are about *one* thing — that covering creators nobody has reviewed is
strictly harder than covering the pilot creators, not a lighter path bolted onto the
side. So the interesting assertions are the negative ones: a 2-of-3 vote that carries
a pilot creator's claim must *fail* here, and each of those has a control proving the
same fixture votes really would have passed under the majority policy. A test that
only checked acceptance would pass against code that ignored the threshold entirely.
"""

from __future__ import annotations

import asyncio
import inspect
import io
import json

import pytest

from modeltree_updater.budgets import CreatorBudget
from modeltree_updater.checkpoints import create_checkpoint_storage, recorded_profile_id
from modeltree_updater.cli import EXIT_USAGE, build_parser, main
from modeltree_updater.contracts import (
    ClaimDecision,
    ConflictKind,
    CreatorRequest,
    FailureKind,
    ProposalStatus,
    REVIEW_LENSES,
)
from modeltree_updater.gates import GATE_SOURCE_APPROVAL
from modeltree_updater.longtail import (
    DEFAULT_LONG_TAIL_PROFILE,
    DEFAULT_LONG_TAIL_PROFILE_ID,
    KNOWN_PROMOTION_CRITERIA,
    load_long_tail_library,
    load_long_tail_profile,
    reviewed_long_tail_profile,
)
from modeltree_updater.messages import ReviewedClaims
from modeltree_updater.profiles import ProfileError
from modeltree_updater.providers.fixtures import build_fixture_bundle
from modeltree_updater.publisher import render_body
from modeltree_updater.review import MAJORITY_POLICY, UNANIMOUS_POLICY
from modeltree_updater.runner import resume_creator_run, run_creator
from modeltree_updater.scout import ScoutFinding, SourceScout
from modeltree_updater.workflow import (
    WORKFLOW_NAME,
    ProfileMismatch,
    RunSettings,
    bundle_proposal,
)

# Mirrors `conftest.TIMESTAMP`: later than every fixture's `verified_at`, so the
# date gate does not refuse evidence for being checked after the run that read it.
TIMESTAMP = "2026-06-01T00:00:00+00:00"

RICH = "proseware-ai"
THIN = "litware-ai"

# The claim two lenses accepted and the third could not judge. Under the pilot
# creators' policy this is an accept; under the long-tail policy it must not be.
TWO_OF_THREE_CLAIM = "proseware-ai-scribe-2-summary"
# The claim two lenses accepted and one rejected outright.
ONE_REJECT_CLAIM = "proseware-ai-scribe-2-intended-use"
# The family label every lens abstained on: a naming mapping nobody could settle.
UNSETTLED_NAMING_CLAIM = "proseware-ai-scribe-family-name"
APPROVED_DISCOVERY = "proseware-ai-partner-docs"
REFUSED_DISCOVERY = "proseware-ai-rumour"
REFUSED_DISCOVERY_CLAIM = "proseware-ai-scribe-3-context-window"


def _settings(library, *, long_tail, budget=None) -> RunSettings:
    return RunSettings(
        build_fixture_bundle(library, timestamp=TIMESTAMP),
        budget=budget or CreatorBudget(),
        timestamp=TIMESTAMP,
        long_tail=load_long_tail_profile() if long_tail else None,
    )


def _run(creator_id, library, *, long_tail=True, budget=None, storage=None):
    return asyncio.run(
        run_creator(
            library.creators[creator_id],
            _settings(library, long_tail=long_tail, budget=budget),
            run_id="run-" + creator_id,
            checkpoint_storage=storage,
        )
    )


def _decision(proposal, claim_id):
    for adjudication in proposal.adjudications:
        if adjudication.claim_id == claim_id:
            return adjudication
    raise AssertionError(f"no adjudication for {claim_id}")


def _approval(proposal, source_id):
    for approval in proposal.source_approvals:
        if approval.source_id == source_id:
            return approval
    raise AssertionError(f"no approval for {source_id}")


# --------------------------------------------------------------------------
# The threshold
# --------------------------------------------------------------------------


def test_a_two_of_three_accept_does_not_carry_a_long_tail_claim(library) -> None:
    """The headline rule, stated as a refusal.

    The control below runs the *same fixture votes* under the majority policy and
    gets an accept, so this cannot pass against an implementation that ignores the
    threshold: the only difference between the two runs is which policy was applied.
    """
    long_tail = _decision(_run(RICH, library), TWO_OF_THREE_CLAIM)

    assert long_tail.accept_votes == 2
    assert long_tail.reject_votes == 0
    assert long_tail.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    assert long_tail.decision is not ClaimDecision.ACCEPT
    assert "unanimous 3-of-3" in long_tail.rationale


def test_the_same_two_of_three_vote_is_accepted_under_the_majority_policy(library) -> None:
    """Control for the test above."""
    majority = _decision(_run(RICH, library, long_tail=False), TWO_OF_THREE_CLAIM)

    assert majority.accept_votes == 2
    assert majority.decision is ClaimDecision.ACCEPT


def test_one_reviewer_rejecting_is_enough_to_stop_a_long_tail_claim(library) -> None:
    proposal = _run(RICH, library)
    adjudication = _decision(proposal, ONE_REJECT_CLAIM)

    assert adjudication.accept_votes == 2
    assert adjudication.reject_votes == 1
    assert adjudication.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    assert ONE_REJECT_CLAIM not in proposal.accepted_claim_ids

    # Every verdict survives, dissent included, with the lens that cast it.
    lenses = {verdict.lens for verdict in adjudication.verdicts}
    assert lenses == set(REVIEW_LENSES)
    rejections = [
        verdict for verdict in adjudication.verdicts
        if verdict.decision is ClaimDecision.REJECT
    ]
    assert len(rejections) == 1
    assert rejections[0].rationale


def test_the_same_single_rejection_is_outvoted_under_the_majority_policy(library) -> None:
    """Control: two accepts and one reject is an accept for a pilot creator."""
    majority = _decision(_run(RICH, library, long_tail=False), ONE_REJECT_CLAIM)

    assert majority.reject_votes == 1
    assert majority.decision is ClaimDecision.ACCEPT


def test_a_unanimous_claim_is_accepted(library) -> None:
    proposal = _run(RICH, library)

    assert "proseware-ai-scribe-2-context-window" in proposal.accepted_claim_ids
    adjudication = _decision(proposal, "proseware-ai-scribe-2-context-window")
    assert adjudication.accept_votes == 3
    assert adjudication.decision is ClaimDecision.ACCEPT
    assert adjudication.vetoed_by == ()


def test_the_run_records_the_threshold_it_applied(library) -> None:
    long_tail = _run(RICH, library)
    majority = _run(RICH, library, long_tail=False)

    assert long_tail.review_policy == UNANIMOUS_POLICY
    assert long_tail.review_policy.required_accepts == 3
    assert majority.review_policy == MAJORITY_POLICY
    # Refusing never got harder; only accepting did.
    assert UNANIMOUS_POLICY.required_rejects == MAJORITY_POLICY.required_rejects


# --------------------------------------------------------------------------
# Newly discovered sources
# --------------------------------------------------------------------------


def test_a_newly_discovered_source_needs_all_three_reviewers(library) -> None:
    proposal = _run(RICH, library)

    approved = _approval(proposal, APPROVED_DISCOVERY)
    assert approved.newly_discovered is True
    assert approved.accept_votes == 3
    assert approved.approved is True

    refused = _approval(proposal, REFUSED_DISCOVERY)
    assert refused.newly_discovered is True
    assert refused.accept_votes == 2
    assert refused.approved is False


def test_the_same_discovery_is_approved_under_the_majority_policy(library) -> None:
    """Control: 2-of-3 is enough for a pilot creator's discovery, and not here."""
    majority = _approval(_run(RICH, library, long_tail=False), REFUSED_DISCOVERY)

    assert majority.accept_votes == 2
    assert majority.approved is True


def test_a_claim_resting_on_a_refused_discovery_is_vetoed(library) -> None:
    proposal = _run(RICH, library)
    adjudication = _decision(proposal, REFUSED_DISCOVERY_CLAIM)

    assert GATE_SOURCE_APPROVAL in adjudication.vetoed_by
    assert adjudication.decision is ClaimDecision.REJECT
    # The reviewers liked the claim. The gate refused it anyway.
    assert adjudication.semantic_decision is ClaimDecision.ACCEPT


# --------------------------------------------------------------------------
# Seeds: lower trust, not lighter scrutiny
# --------------------------------------------------------------------------


def test_a_seed_source_is_built_from_the_run_s_own_entry_urls(library) -> None:
    """Seeds come from the request, and are never dressed up as verified."""
    creator = library.creators[RICH]
    catalog = load_long_tail_profile().for_creator(creator).catalog

    assert [source.url for source in catalog] == list(creator.entry_urls)
    for source in catalog:
        assert source.trust == "unverified-seed"
        assert source.verified_at is None
        assert source.verification is None
        assert source.trust_notes


def test_an_unsafe_seed_url_is_refused_rather_than_catalogued() -> None:
    profile = load_long_tail_profile()

    with pytest.raises(ProfileError) as error:
        profile.for_creator(
            CreatorRequest(
                creator_id="insecure-ai",
                creator_name="Insecure AI",
                entry_urls=("http://www.example.com/insecure-ai/news",),
            )
        )

    assert "https" in str(error.value)


def test_a_run_with_an_unsafe_seed_stops_before_a_page_is_read(library) -> None:
    """The seed check happens up front, not after the evidence is already in hand."""
    with pytest.raises(ProfileError):
        asyncio.run(
            run_creator(
                CreatorRequest(
                    creator_id="insecure-ai",
                    creator_name="Insecure AI",
                    entry_urls=("https://192.0.2.10/insecure-ai/news",),
                ),
                _settings(library, long_tail=True),
                run_id="run-insecure",
            )
        )


def test_a_seed_only_covers_its_own_origin(library) -> None:
    """Everything off the seed origin is a discovery and must be voted on."""
    scout = SourceScout(load_long_tail_profile().for_creator(library.creators[RICH]))

    def finding(url: str) -> ScoutFinding:
        return ScoutFinding(url=url, title="lead", publisher="Proseware AI")

    assert scout.classify(finding("https://www.example.com/proseware-ai/blog/x"))[0] is False
    assert scout.classify(finding("https://docs.example.org/proseware-ai/x"))[0] is True


def test_an_unverified_seed_faces_exactly_the_same_gates_as_a_catalogued_source(
    library,
) -> None:
    """Lower trust buys a seed nothing: the gate set is identical, not reduced."""
    long_tail = _run(RICH, library)
    pilot = _run("openai", library, long_tail=False)

    def gates(proposal, subject_kind):
        return {
            result.gate
            for result in proposal.gates
            if result.subject_kind == subject_kind
        }

    assert gates(long_tail, "source") == gates(pilot, "source")
    assert gates(long_tail, "claim") == gates(pilot, "claim")
    assert gates(long_tail, "source")
    # Every source read in the long-tail run was gated, seeds included.
    gated = {result.subject_id for result in long_tail.gates if result.subject_kind == "source"}
    assert gated == {source.id for source in long_tail.sources}


# --------------------------------------------------------------------------
# Unknown mappings stay unknown
# --------------------------------------------------------------------------


def test_an_unsettled_naming_mapping_becomes_an_explicit_conflict(library) -> None:
    """The abstained mapping would otherwise vanish into 'not accepted'.

    All three lenses abstained, so the adjudication is *unanimous* and the reviewer
    disagreement detector — correctly — says nothing about it. Without the long-tail
    conflict there would be no record at all that a question was left open.
    """
    proposal = _run(RICH, library)
    adjudication = _decision(proposal, UNSETTLED_NAMING_CLAIM)

    assert adjudication.abstain_votes == 3
    assert adjudication.unanimous is True
    assert adjudication.decision is ClaimDecision.NEEDS_HUMAN_REVIEW

    unresolved = [
        conflict
        for conflict in proposal.conflicts
        if conflict.kind is ConflictKind.UNRESOLVED_MAPPING
    ]
    assert [conflict.claim_ids for conflict in unresolved] == [(UNSETTLED_NAMING_CLAIM,)]
    assert "naming" in unresolved[0].values[0]
    assert not any(
        conflict.kind is ConflictKind.REVIEWER_DISAGREEMENT
        and UNSETTLED_NAMING_CLAIM in conflict.claim_ids
        for conflict in proposal.conflicts
    )
    # Nothing was adopted, and the proposal says so rather than looking finished.
    assert UNSETTLED_NAMING_CLAIM not in proposal.accepted_claim_ids
    assert proposal.status is ProposalStatus.INCOMPLETE


def test_an_unsettled_ownership_mapping_becomes_an_explicit_conflict(library) -> None:
    proposal = _run(THIN, library)

    unresolved = [
        conflict
        for conflict in proposal.conflicts
        if conflict.kind is ConflictKind.UNRESOLVED_MAPPING
    ]
    assert [conflict.claim_ids for conflict in unresolved] == [
        ("litware-ai-organization-type",)
    ]
    assert "ownership" in unresolved[0].values[0]


def test_a_dedicated_profile_run_records_no_unresolved_mapping(library) -> None:
    """The new conflict kind is scoped to the long-tail path and nothing else."""
    for creator_id in ("openai", "anthropic", "google-deepmind", "meta"):
        proposal = _run(creator_id, library, long_tail=False)
        assert proposal.promotion is None
        assert not any(
            conflict.kind is ConflictKind.UNRESOLVED_MAPPING
            for conflict in proposal.conflicts
        )


# --------------------------------------------------------------------------
# Promotion: a flag, never an action
# --------------------------------------------------------------------------


def test_promotion_is_recommended_when_every_criterion_is_met(library) -> None:
    promotion = _run(RICH, library).promotion

    assert promotion is not None
    assert promotion.creator_id == RICH
    assert promotion.profile_id == "long-tail-generic"
    assert promotion.recommended is True
    assert {criterion.id for criterion in promotion.criteria} == set(KNOWN_PROMOTION_CRITERIA)
    assert all(criterion.met for criterion in promotion.criteria)
    for criterion in promotion.criteria:
        assert criterion.observed >= criterion.threshold
        assert criterion.description
    assert "human" in promotion.next_step


def test_promotion_is_not_recommended_for_a_thin_creator(library) -> None:
    """A 'no' is a recorded measurement, not silence."""
    promotion = _run(THIN, library).promotion

    assert promotion is not None
    assert promotion.recommended is False
    unmet = [criterion for criterion in promotion.criteria if not criterion.met]
    assert unmet
    observed = {criterion.id: criterion.observed for criterion in promotion.criteria}
    assert observed["accepted-claims"] == 1
    assert observed["escalated-mappings"] == 1
    assert promotion.rationale


def test_nothing_creates_a_dedicated_profile(tmp_path, library) -> None:
    """Promotion recommends. Creating the profile stays a human act."""
    before = {path.name for path in DEFAULT_LONG_TAIL_PROFILE.parent.parent.glob("*.json")}

    proposal = _run(RICH, library)

    after = {path.name for path in DEFAULT_LONG_TAIL_PROFILE.parent.parent.glob("*.json")}
    assert proposal.promotion.recommended is True
    assert before == after
    assert not list(tmp_path.iterdir())


# --------------------------------------------------------------------------
# Budgets
# --------------------------------------------------------------------------


def test_budget_exhaustion_is_reported_and_the_promotion_signal_survives(library) -> None:
    proposal = _run(THIN, library, budget=CreatorBudget(max_pages=1))

    assert proposal.status is ProposalStatus.INCOMPLETE
    assert any(
        failure.kind is FailureKind.BUDGET_EXHAUSTED for failure in proposal.failures
    )
    assert proposal.budget.exhausted_by
    assert any("budget exhausted" in note for note in proposal.notes)
    # Partial coverage does not become a silently smaller creator: the assessment is
    # still made, and still says no.
    assert proposal.promotion is not None
    assert proposal.promotion.recommended is False
    assert proposal.review_policy == UNANIMOUS_POLICY


# --------------------------------------------------------------------------
# The policy survives a resume
# --------------------------------------------------------------------------


async def _first_checkpoint(storage):
    checkpoints = storage.list_checkpoints(workflow_name=WORKFLOW_NAME)
    if inspect.isawaitable(checkpoints):
        checkpoints = await checkpoints
    return sorted(checkpoints, key=lambda item: item.iteration_count)[0]


def test_a_resume_without_the_flag_still_applies_the_recorded_policy(
    tmp_path, library
) -> None:
    """The checkpoint decides the bar, so a forgotten flag cannot downgrade it."""
    storage = create_checkpoint_storage(tmp_path / "checkpoints")
    _run(RICH, library, storage=storage)

    async def scenario():
        checkpoint = await _first_checkpoint(storage)
        recorded = await recorded_profile_id(storage, checkpoint.checkpoint_id)
        # Deliberately no long-tail profile supplied: this is the operator who
        # forgot, and `resume` has no flag to remind them.
        resumed = await resume_creator_run(
            _settings(library, long_tail=False),
            checkpoint_id=checkpoint.checkpoint_id,
            checkpoint_storage=storage,
        )
        return recorded, resumed

    recorded, resumed = asyncio.run(scenario())

    assert recorded == "long-tail-generic"
    assert resumed.review_policy == UNANIMOUS_POLICY
    assert _decision(resumed, TWO_OF_THREE_CLAIM).decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    assert resumed.promotion is not None


def test_a_profile_that_does_not_match_the_checkpoint_stops_the_run(library) -> None:
    """Bundling refuses a message whose recorded profile it cannot honour."""
    message = ReviewedClaims(
        run_id="run-test",
        creator=library.creators[RICH],
        sources=(),
        claims=(),
        verdicts=(),
        failures=(),
        budget_state={},
        review_policy=UNANIMOUS_POLICY,
        profile_id="long-tail-generic",
    )

    with pytest.raises(ProfileMismatch):
        bundle_proposal(message, _settings(library, long_tail=False))


# --------------------------------------------------------------------------
# The profile is reviewable, not adjustable
# --------------------------------------------------------------------------


def _profile_document():
    return json.loads(DEFAULT_LONG_TAIL_PROFILE.read_text(encoding="utf-8"))


def test_the_shipped_profile_demands_unanimity() -> None:
    profile = load_long_tail_profile()

    assert profile.review_policy.required_accepts == 3
    assert profile.review_policy == UNANIMOUS_POLICY
    assert {topic.topic for topic in profile.unresolved_topics} == {
        "naming",
        "ownership",
        "lineage",
    }


def test_a_profile_cannot_be_edited_down_to_a_majority(tmp_path) -> None:
    document = _profile_document()
    document["review_policy"]["required_accepts"] = 2
    path = tmp_path / "weak.json"
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ProfileError) as error:
        load_long_tail_profile(path)

    assert "required_accepts" in str(error.value)


def test_a_profile_cannot_name_the_majority_policy_instead(tmp_path) -> None:
    """Swapping in the dedicated-profile policy wholesale is refused just the same."""
    document = _profile_document()
    document["review_policy"] = {
        "id": MAJORITY_POLICY.id,
        "required_accepts": MAJORITY_POLICY.required_accepts,
        "required_rejects": MAJORITY_POLICY.required_rejects,
        "decision_label": MAJORITY_POLICY.decision_label,
        "description": MAJORITY_POLICY.description,
    }
    path = tmp_path / "majority.json"
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ProfileError) as error:
        load_long_tail_profile(path)

    assert "unanimous" in str(error.value)


def test_a_profile_cannot_invent_a_policy_the_code_does_not_implement(tmp_path) -> None:
    """A recorded threshold nobody applies would be a fiction in the artefact."""
    document = _profile_document()
    document["review_policy"]["id"] = "unanimous-4-of-4"
    path = tmp_path / "invented.json"
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ProfileError) as error:
        load_long_tail_profile(path)

    assert "unknown review policy" in str(error.value)


def test_a_profile_cannot_reword_the_policy_it_restates(tmp_path) -> None:
    """The file declares a policy; review.py defines it."""
    document = _profile_document()
    document["review_policy"]["decision_label"] = "any two will do"
    path = tmp_path / "reworded.json"
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ProfileError) as error:
        load_long_tail_profile(path)

    assert "decision_label" in str(error.value)


def test_a_promotion_criterion_nothing_measures_is_refused(tmp_path) -> None:
    """A criterion with no measurement behind it would silently never be met."""
    document = _profile_document()
    document["promotion_criteria"]["criteria"].append(
        {"id": "vibes", "threshold": 1, "description": "unmeasurable"}
    )
    path = tmp_path / "unmeasurable.json"
    path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(ProfileError) as error:
        load_long_tail_profile(path)

    assert "vibes" in str(error.value)


# --------------------------------------------------------------------------
# What a human actually reads
# --------------------------------------------------------------------------


def test_the_published_body_shows_the_policy_the_escalations_and_the_promotion(
    library,
) -> None:
    body = render_body(_run(RICH, library))

    assert "unanimous 3-of-3 accept" in body
    assert "## Profile and promotion" in body
    assert "long-tail-generic" in body
    assert "needs-human-review" in body
    assert "unresolved-mapping" in body
    assert "accepted-claims" in body
    for phrase in ("a human decides", "never creates a dedicated profile"):
        assert phrase in body


def test_a_dedicated_profile_body_has_no_promotion_section(library) -> None:
    body = render_body(_run("openai", library, long_tail=False))

    assert "## Profile and promotion" not in body
    assert "2-of-3 majority" in body


# --------------------------------------------------------------------------
# A profile id names exactly one reviewed document
# --------------------------------------------------------------------------
# A checkpoint records the profile *id*, and a resume rebuilds the profile from
# it. That is only sound if an id identifies a file, so the profiles a run can be
# started under are the reviewed set in `profiles/generic/`, and the set refuses
# two documents answering to one id. Before this, `--long-tail-profile` took any
# path and the resume loaded the default one back, so two files sharing an id
# meant a resumed run silently swapped one for the other.


def _custom_profile_file(path, *, profile_id=DEFAULT_LONG_TAIL_PROFILE_ID):
    """A loadable profile that differs from the reviewed one where it matters.

    The declared review policy is untouched — the loader refuses anything short of
    unanimity, and the policy survives a resume in the checkpointed messages anyway.
    What differs is exactly what the policy cannot rebuild: the promotion criteria
    and the mappings that stay explicit. This is the file whose contents must never
    be quietly stood in for, or quietly stand in for the reviewed one.
    """
    document = _profile_document()
    document["profile"]["id"] = profile_id
    document["promotion_criteria"]["criteria"] = [
        {
            "id": "accepted-claims",
            "threshold": 99,
            "description": "a bar nobody reviewed",
        }
    ]
    document["unresolved_topics"] = [
        {
            "topic": "naming",
            "note": "a note nobody reviewed",
            "guidance": "guidance nobody reviewed",
            "entity_kinds": ["family"],
            "field_paths": ["categories"],
        }
    ]
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def _cli(argv):
    stream = io.StringIO()
    return main(argv, env={}, stream=stream), stream.getvalue()


def test_the_reviewed_set_contains_the_shipped_profile() -> None:
    library = load_long_tail_library()

    assert DEFAULT_LONG_TAIL_PROFILE_ID in library.ids
    assert reviewed_long_tail_profile(DEFAULT_LONG_TAIL_PROFILE_ID) == (
        load_long_tail_profile(DEFAULT_LONG_TAIL_PROFILE)
    )


def test_two_reviewed_profiles_cannot_answer_to_one_id(tmp_path) -> None:
    """The uniqueness that makes rebuilding a profile from a recorded id honest."""
    document = _profile_document()
    (tmp_path / "long-tail.json").write_text(json.dumps(document), encoding="utf-8")
    _custom_profile_file(tmp_path / "twin.json")

    with pytest.raises(ProfileError) as error:
        load_long_tail_library(tmp_path)

    assert "duplicate" in str(error.value)
    assert DEFAULT_LONG_TAIL_PROFILE_ID in str(error.value)


def test_a_run_cannot_be_started_from_an_unreviewed_profile_file(
    tmp_path, fixture_dir
) -> None:
    """The refusal that closes the swap, stated at the moment it becomes possible.

    The file here is the awkward one: it declares the same id as the reviewed
    profile, so an id comparison cannot tell them apart, but its promotion criteria
    and unresolved-mapping topics are different. There is no longer a run to
    checkpoint and resume, because the run is refused before anything is fetched.
    """
    custom = _custom_profile_file(tmp_path / "custom.json")
    output_dir = tmp_path / "proposals"

    code, output = _cli(
        [
            "run",
            "--creator",
            THIN,
            "--fixtures",
            str(fixture_dir),
            "--long-tail",
            "--long-tail-profile",
            str(custom),
            "--output",
            str(output_dir),
            "--run-id",
            "run-custom",
            "--timestamp",
            TIMESTAMP,
        ]
    )

    assert code == EXIT_USAGE
    assert "not a path" in output
    assert "profiles/generic" in output
    # Refused before the workflow ran: no proposal, and nothing to resume later.
    assert not output_dir.exists()


def test_an_unknown_profile_id_is_refused_and_the_reviewed_set_is_named(
    fixture_dir,
) -> None:
    code, output = _cli(
        [
            "run",
            "--creator",
            THIN,
            "--fixtures",
            str(fixture_dir),
            "--long-tail",
            "--long-tail-profile",
            "long-tail-experimental",
            "--timestamp",
            TIMESTAMP,
        ]
    )

    assert code == EXIT_USAGE
    assert "unknown long-tail profile" in output
    assert DEFAULT_LONG_TAIL_PROFILE_ID in output


def test_a_resume_adopts_the_reviewed_document_for_the_recorded_id(
    tmp_path, library
) -> None:
    """The wiring: a resume rebuilds its profile from the reviewed set, not a flag.

    Weak on purpose, and worth naming as such rather than dressing up. With one
    document in the reviewed set this assertion holds identically against the code
    it replaced, which loaded the default path — there is nothing here to
    discriminate, so it cannot fail against the defect. It pins the shape and
    nothing more.

    The tests that can fail against the defect are
    `test_a_run_cannot_be_started_from_an_unreviewed_profile_file` and
    `test_a_checkpointed_profile_outside_the_reviewed_set_stops_the_resume`; the
    residual is pinned by
    `test_an_in_process_colliding_profile_resumes_under_the_reviewed_document`.
    Adding a second document to `profiles/generic/` to make this one discriminate
    would put an unreviewed artefact in the reviewed set, which is what ADR 0002
    exists to prevent.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")
    _run(RICH, library, storage=storage)
    settings = _settings(library, long_tail=False)

    async def scenario():
        checkpoint = await _first_checkpoint(storage)
        return await resume_creator_run(
            settings,
            checkpoint_id=checkpoint.checkpoint_id,
            checkpoint_storage=storage,
        )

    resumed = asyncio.run(scenario())
    reviewed = reviewed_long_tail_profile(DEFAULT_LONG_TAIL_PROFILE_ID)

    assert settings.long_tail == reviewed
    assert [criterion.id for criterion in resumed.promotion.criteria] == [
        threshold.id for threshold in reviewed.promotion.criteria
    ]
    assert [criterion.threshold for criterion in resumed.promotion.criteria] == [
        threshold.threshold for threshold in reviewed.promotion.criteria
    ]


def test_a_checkpointed_profile_outside_the_reviewed_set_stops_the_resume(
    tmp_path, library
) -> None:
    """No nearest match, and no falling back to whatever sits at the default path.

    Constructing a profile from an arbitrary file is still possible in-process — the
    loader takes a path so that malformed documents can be tested. Note the id here
    is deliberately *outside* the reviewed set, which is the case that stops: there
    is nothing to rebuild the profile from. An in-process profile whose id collides
    with a reviewed one behaves differently, and
    `test_an_in_process_colliding_profile_resumes_under_the_reviewed_document`
    covers that.
    """
    custom = _custom_profile_file(
        tmp_path / "experimental.json", profile_id="long-tail-experimental"
    )
    storage = create_checkpoint_storage(tmp_path / "checkpoints")
    settings = RunSettings(
        build_fixture_bundle(library, timestamp=TIMESTAMP),
        budget=CreatorBudget(),
        timestamp=TIMESTAMP,
        long_tail=load_long_tail_profile(custom),
    )
    asyncio.run(
        run_creator(
            library.creators[RICH],
            settings,
            run_id="run-experimental",
            checkpoint_storage=storage,
        )
    )

    async def scenario():
        checkpoint = await _first_checkpoint(storage)
        return await resume_creator_run(
            _settings(library, long_tail=False),
            checkpoint_id=checkpoint.checkpoint_id,
            checkpoint_storage=storage,
        )

    with pytest.raises(ProfileMismatch) as error:
        asyncio.run(scenario())

    assert "long-tail-experimental" in str(error.value)
    assert "not in the reviewed set" in str(error.value)
    assert DEFAULT_LONG_TAIL_PROFILE_ID in str(error.value)


def test_an_in_process_colliding_profile_resumes_under_the_reviewed_document(
    tmp_path, library
) -> None:
    """The residual ADR 0002 accepts, pinned so the prose cannot drift off it.

    The CLI cannot *start* this run — that is what the reviewed set is for — but the
    loader still takes a path, so in-process code can, and a checkpoint written by an
    older build that accepted paths records no schema or tool-version marker, so a
    resume can still reach this state through the CLI. When such a profile declares
    an id the reviewed set *does* contain, the resume rebuilds from that id and gets
    the reviewed document back: #94's substitution, surviving on the Python API.

    This is documented, not fixed. It resolves towards the reviewed document rather
    than away from it, which is the safe direction for *provenance* — though not
    necessarily the stricter one: the fixture here declares an ``accepted-claims``
    threshold of 99 against the reviewed profile's 3, so the substitution loosens the
    promotion bar. That stays bounded because promotion criteria drive a
    recommendation, while acceptance is pinned by the unanimous review policy this
    path never touches. Closing it would mean checkpointing a content hash — the
    option #94 weighed and this repository rejected. The assertion exists so that
    "cannot be resumed" cannot be written in the ADR again without a test going red.
    """
    custom = _custom_profile_file(tmp_path / "collides.json")
    unreviewed = load_long_tail_profile(custom)
    reviewed = reviewed_long_tail_profile(DEFAULT_LONG_TAIL_PROFILE_ID)

    assert unreviewed.id == reviewed.id, "the collision is the whole premise"
    assert unreviewed.promotion.criteria != reviewed.promotion.criteria

    storage = create_checkpoint_storage(tmp_path / "checkpoints")
    settings = RunSettings(
        build_fixture_bundle(library, timestamp=TIMESTAMP),
        budget=CreatorBudget(),
        timestamp=TIMESTAMP,
        long_tail=unreviewed,
    )
    asyncio.run(
        run_creator(
            library.creators[RICH],
            settings,
            run_id="run-collides",
            checkpoint_storage=storage,
        )
    )

    resuming = _settings(library, long_tail=False)

    async def scenario():
        checkpoint = await _first_checkpoint(storage)
        return await resume_creator_run(
            resuming,
            checkpoint_id=checkpoint.checkpoint_id,
            checkpoint_storage=storage,
        )

    asyncio.run(scenario())

    assert resuming.long_tail == reviewed
    assert resuming.long_tail != unreviewed


def test_resume_still_takes_no_profile_flag_of_any_kind() -> None:
    """Naming the profile by id must not become a way to name one on resume.

    The bar a resumed run is judged by comes out of its checkpoint. A flag that
    could restate it is a flag that could get it wrong.
    """
    parser = build_parser()
    base = ["resume", "--checkpoint-id", "c1", "--checkpoint-dir", "checkpoints"]

    for flag in (["--long-tail"], ["--long-tail-profile", DEFAULT_LONG_TAIL_PROFILE_ID]):
        with pytest.raises(SystemExit):
            parser.parse_args(base + flag)
