"""Publication: what counts as material, what identifies a proposal, what the
issue body has to say, and what must never happen.

Every test here runs offline against a fake issues client.
"""

from __future__ import annotations

import dataclasses

import pytest

from modeltree_updater.contracts import ProposalStatus
from modeltree_updater.github_issues import MAX_BODY_CHARS, Issue
from modeltree_updater.parsing import proposal_from_dict
from modeltree_updater.publisher import (
    PublicationAction,
    PublicationError,
    find_open_proposals,
    identity_marker,
    is_material,
    issue_title,
    matches_identity,
    publish_proposal,
    publish_report,
    render_body,
    render_issue,
)

MATERIAL = "contoso-ai"
INCOMPLETE = "fabrikam-ai"
QUIET = "quiet-ai"


def _issue(number: int, body: str, *, state: str = "open") -> Issue:
    return Issue(number=number, title="whatever", body=body, state=state)


# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------


def test_the_marker_is_the_first_line_of_the_body(proposal_factory) -> None:
    body = render_body(proposal_factory(MATERIAL))

    assert body.splitlines()[0] == identity_marker(MATERIAL)


def test_identity_is_anchored_to_the_first_line_only() -> None:
    """The regression this issue's first attempt shipped.

    Rendered bodies contain quotes from fetched pages, so marker-shaped text can
    appear anywhere in the content. Only line one is identity.
    """
    marker = identity_marker(MATERIAL)

    assert matches_identity(marker + "\n\nbody", MATERIAL)
    assert matches_identity(marker + "\r\nbody", MATERIAL)
    assert not matches_identity("Some preamble\n" + marker, MATERIAL)
    assert not matches_identity("> quoted: " + marker, MATERIAL)
    assert not matches_identity(marker, INCOMPLETE)
    assert not matches_identity(None, MATERIAL)
    assert not matches_identity("", MATERIAL)


def test_another_creators_open_proposal_is_never_matched() -> None:
    issues = [
        _issue(101, identity_marker(MATERIAL) + "\ncontoso body"),
        _issue(102, "chatter mentioning " + identity_marker(MATERIAL)),
        _issue(103, identity_marker(INCOMPLETE) + "\nfabrikam body", state="closed"),
    ]

    assert [issue.number for issue in find_open_proposals(issues, MATERIAL)] == [101]
    assert find_open_proposals(issues, INCOMPLETE) == ()


def test_duplicates_are_ordered_with_the_lowest_number_first() -> None:
    issues = [
        _issue(number, identity_marker(MATERIAL) + "\nx") for number in (204, 101, 190)
    ]

    assert [issue.number for issue in find_open_proposals(issues, MATERIAL)] == [
        101,
        190,
        204,
    ]


def test_a_creator_id_that_could_forge_an_identity_is_refused() -> None:
    for creator_id in ("contoso --><!-- modeltree-proposal: v1 creator=evil", "", "A/B"):
        with pytest.raises(PublicationError):
            identity_marker(creator_id)
        with pytest.raises(PublicationError):
            issue_title(creator_id)


def test_the_title_is_stable_and_names_the_creator() -> None:
    assert issue_title(MATERIAL) == "ModelTree proposal: contoso-ai"


# ---------------------------------------------------------------------------
# materiality
# ---------------------------------------------------------------------------


def test_a_run_with_candidates_is_material(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)

    assert proposal.claims
    assert is_material(proposal)


def test_a_complete_run_that_found_nothing_is_not_material(proposal_factory) -> None:
    proposal = proposal_factory(QUIET)

    assert proposal.status is ProposalStatus.COMPLETE
    assert (proposal.claims, proposal.conflicts, proposal.failures) == ((), (), ())
    assert not is_material(proposal)


def test_an_incomplete_run_is_material_even_with_nothing_to_propose(
    proposal_factory,
) -> None:
    proposal = dataclasses.replace(
        proposal_factory(QUIET), status=ProposalStatus.INCOMPLETE
    )

    assert is_material(proposal)


def test_a_claim_the_panel_refused_is_still_material(proposal_factory) -> None:
    """"We looked and rejected it" is a reviewable outcome, not silence."""
    quiet = proposal_factory(QUIET)
    with_refused_claim = dataclasses.replace(
        quiet, claims=proposal_factory(MATERIAL).claims[:1], adjudications=()
    )

    assert is_material(with_refused_claim)


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------


def test_the_body_carries_every_section_the_issue_requires(proposal_factory) -> None:
    body = render_body(proposal_factory(MATERIAL))

    for heading in (
        "## Candidate patch",
        "## Atomic evidence",
        "## Sources and source decisions",
        "## Reviewer verdicts",
        "## Deterministic validation",
        "## Conflicts",
        "## Budget usage",
        "## Completion status",
    ):
        assert heading in body, heading


def test_the_body_shows_every_reviewer_verdict(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    assert proposal.verdicts
    for verdict in proposal.verdicts:
        assert verdict.reviewer in body
        assert verdict.lens.value in body
    for adjudication in proposal.adjudications:
        assert adjudication.claim_id in body


def test_the_body_shows_atomic_evidence_for_every_claim(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    for claim in proposal.claims:
        for evidence in claim.evidence:
            assert evidence.url in body
            assert evidence.content_hash in body
            assert evidence.verified_at in body
            assert evidence.quote.strip().splitlines()[0][:40] in body


def test_the_body_shows_every_deterministic_gate_including_failures(
    proposal_factory,
) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    assert proposal.gates
    for gate in proposal.gates:
        assert gate.gate in body
    if any(gate.failed for gate in proposal.gates):
        assert "**failed**" in body
    for validation in proposal.validations:
        assert validation.claim_id in body


def test_the_body_shows_source_decisions_with_their_vote_tally(
    proposal_factory,
) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    assert proposal.source_approvals
    for approval in proposal.source_approvals:
        assert approval.source_id in body


def test_the_body_shows_budget_usage(proposal_factory) -> None:
    body = render_body(proposal_factory(MATERIAL))

    assert "## Budget" in body
    assert "pages" in body and "tokens" in body


def test_an_incomplete_run_states_its_failures(proposal_factory) -> None:
    proposal = proposal_factory(INCOMPLETE)
    body = render_body(proposal)

    assert proposal.status is not ProposalStatus.COMPLETE
    assert proposal.status.value in body
    for failure in proposal.failures:
        assert failure.message[:40] in body
        assert failure.stage.value in body


def test_rendering_the_same_artefact_twice_is_byte_identical(
    proposal_factory,
) -> None:
    """No render-time clock, no dict ordering luck: reruns must not churn the issue."""
    proposal = proposal_factory(MATERIAL)

    assert render_body(proposal) == render_body(proposal)


def test_rendering_survives_a_json_round_trip_unchanged(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)
    restored = proposal_from_dict(proposal.to_dict())

    assert render_body(restored) == render_body(proposal)


def test_table_content_cannot_break_out_of_its_row(proposal_factory) -> None:
    """Claim values come from fetched pages. A pipe or newline must not forge a row."""
    quiet = proposal_factory(QUIET)
    claim = proposal_factory(MATERIAL).claims[0]
    hostile = dataclasses.replace(
        quiet,
        claims=(
            dataclasses.replace(
                claim, value="a | b\nsecond line", field_path="x | y"
            ),
        ),
    )

    body = render_body(hostile)
    rows = [line for line in body.splitlines() if line.startswith("|")]

    assert "x \\| y" in body
    assert "second line" in body
    assert all(row.endswith("|") for row in rows)
    assert not any(row.strip() == "| second line |" for row in rows)


def test_an_oversized_proposal_is_truncated_explicitly(proposal_factory) -> None:
    """Nothing is dropped silently: the body names what it had to leave out."""
    proposal = proposal_factory(MATERIAL)
    huge = dataclasses.replace(proposal, claims=proposal.claims * 4000)

    body = render_body(huge)

    assert len(body) <= MAX_BODY_CHARS
    assert body.splitlines()[0] == identity_marker(MATERIAL)
    assert "## Publication notes" in body
    assert "omitted to fit a GitHub issue body" in body
    assert "## Completion status" in body


# ---------------------------------------------------------------------------
# publication
# ---------------------------------------------------------------------------


def test_a_first_run_creates_one_issue(proposal_factory, fake_issues_client) -> None:
    client = fake_issues_client()

    outcome = publish_proposal(proposal_factory(MATERIAL), client)

    assert outcome.action is PublicationAction.CREATED
    assert client.actions == ["list", "create"]
    assert len(client.issues) == 1
    assert client.issues[0].title == issue_title(MATERIAL)


def test_a_rerun_updates_the_same_issue_instead_of_duplicating(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()
    proposal = proposal_factory(MATERIAL)

    first = publish_proposal(proposal, client)
    second = publish_proposal(proposal, client)

    assert first.action is PublicationAction.CREATED
    assert second.action is PublicationAction.UPDATED
    assert second.issue_number == first.issue_number
    assert len(client.issues) == 1
    assert client.actions == ["list", "create", "list", "update"]


def test_a_no_change_run_makes_no_github_request_at_all(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()

    outcome = publish_proposal(proposal_factory(QUIET), client)

    assert outcome.action is PublicationAction.SKIPPED_NO_CHANGE
    assert outcome.issue_number is None
    assert client.calls == []


def test_a_no_change_run_leaves_an_existing_proposal_untouched(
    proposal_factory, fake_issues_client
) -> None:
    """A stale open proposal is a human's call. Closing it would destroy review context."""
    existing = _issue(101, identity_marker(QUIET) + "\nolder proposal")
    client = fake_issues_client([existing])

    publish_proposal(proposal_factory(QUIET), client)

    assert client.issues == [existing]


def test_publishing_one_creator_never_touches_another_creators_issue(
    proposal_factory, fake_issues_client
) -> None:
    foreign = _issue(101, identity_marker(MATERIAL) + "\ncontoso proposal")
    client = fake_issues_client([foreign])

    outcome = publish_proposal(proposal_factory(INCOMPLETE), client)

    assert outcome.action is PublicationAction.CREATED
    assert outcome.issue_number != 101
    assert client.issues[0] == foreign


def test_duplicates_are_reported_and_never_closed(
    proposal_factory, fake_issues_client
) -> None:
    """No conditional write exists on this API, so this tool does not close issues.

    It updates the lowest-numbered proposal, says so, and leaves the rest for a human.
    """
    canonical = _issue(101, identity_marker(MATERIAL) + "\nfirst")
    duplicate = _issue(102, identity_marker(MATERIAL) + "\nsecond")
    client = fake_issues_client([canonical, duplicate])

    outcome = publish_proposal(proposal_factory(MATERIAL), client)

    assert outcome.action is PublicationAction.UPDATED
    assert outcome.issue_number == 101
    assert outcome.duplicates == (102,)
    assert client.actions == ["list", "update"]
    assert [issue.number for issue in client.issues] == [101, 102]
    assert client.issues[1] == duplicate
    assert "#102" in client.issues[0].body


def test_one_creator_failing_does_not_stop_the_others(
    report_factory, fake_issues_client
) -> None:
    report = report_factory(MATERIAL, INCOMPLETE)
    client = fake_issues_client()
    original_create = client.create_issue

    def create(*, title: str, body: str):
        if MATERIAL in title:
            raise RuntimeError("issue creation refused")
        return original_create(title=title, body=body)

    client.create_issue = create

    result = publish_report(report, client)

    assert [failure.creator_id for failure in result.failures] == [MATERIAL]
    assert "issue creation refused" in result.failures[0].message
    assert [outcome.creator_id for outcome in result.outcomes] == [INCOMPLETE]
    assert [issue.title for issue in client.issues] == [issue_title(INCOMPLETE)]


def test_an_incomplete_creator_updates_its_own_proposal_with_the_failure(
    report_factory, fake_issues_client
) -> None:
    report = report_factory(MATERIAL, INCOMPLETE)
    client = fake_issues_client()

    publish_report(report, client)
    reran = publish_report(report, client)

    bodies = {issue.title: issue.body for issue in client.issues}
    incomplete = report.proposals[1]

    assert len(client.issues) == 2
    assert all(
        outcome.action is PublicationAction.UPDATED for outcome in reran.outcomes
    )
    assert incomplete.status.value in bodies[issue_title(INCOMPLETE)]
    for failure in incomplete.failures:
        assert failure.message[:40] in bodies[issue_title(INCOMPLETE)]


def test_a_dry_run_renders_the_payload_and_sends_nothing(
    report_factory, fake_issues_client
) -> None:
    report = report_factory(MATERIAL, QUIET)
    client = fake_issues_client()

    rendered = publish_report(report, None, dry_run=True)
    published = publish_report(report, client)

    assert [outcome.action for outcome in rendered.outcomes] == [
        PublicationAction.RENDERED,
        PublicationAction.SKIPPED_NO_CHANGE,
    ]
    assert rendered.outcomes[0].payload == published.outcomes[0].payload
    assert rendered.outcomes[0].issue_number is None


def test_publishing_without_a_client_is_refused(report_factory) -> None:
    with pytest.raises(PublicationError):
        publish_report(report_factory(QUIET), None)


def test_the_rendered_payload_is_what_gets_sent(
    proposal_factory, fake_issues_client
) -> None:
    proposal = proposal_factory(MATERIAL)
    client = fake_issues_client()

    outcome = publish_proposal(proposal, client)

    assert outcome.payload == render_issue(proposal)
    assert client.issues[0].body == outcome.payload.body
    assert client.issues[0].title == outcome.payload.title
