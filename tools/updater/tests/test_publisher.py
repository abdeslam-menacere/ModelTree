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
    UNREADABLE_RUN,
    PublicationAction,
    PublicationError,
    find_open_proposals,
    identity_marker,
    is_material,
    issue_title,
    matches_identity,
    publish_proposal,
    publish_report,
    read_state,
    render_body,
    render_issue,
    state_marker,
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


# ---------------------------------------------------------------------------
# measured time never reaches the body
#
# Rendering the same *object* twice, above, cannot catch a wall-clock value: the
# measurement is frozen into the proposal before rendering starts. What has to be
# pinned is that two executions of one run, whose measured elapsed times differ,
# still produce the same bytes. These force that difference rather than racing
# for it.
# ---------------------------------------------------------------------------


# Windows' monotonic clock ticks at ~15.6 ms, so two executions of one run land
# on adjacent ticks. That is the granularity that surfaced this.
WINDOWS_TIMER_TICK = 0.015625

# Elapsed values chosen to fall in different buckets under every plausible way of
# printing measured time: raw, two decimal places, whole seconds, whole minutes.
ELAPSED_SPREAD = (0.0, WINDOWS_TIMER_TICK, 0.9, 1.0, 59.4, 119.999)


def _with_elapsed(proposal, seconds: float):
    """The same proposal with only its measured elapsed time changed."""
    return dataclasses.replace(
        proposal,
        budget=dataclasses.replace(proposal.budget, elapsed_seconds=seconds),
    )


def _stopped_clock(at: float = 1000.0):
    return lambda: at


def _ticking_clock(step: float = WINDOWS_TIMER_TICK, start: float = 1000.0):
    """A `time.monotonic` stand-in that advances one timer tick per read."""
    state = {"now": start}

    def clock() -> float:
        now = state["now"]
        state["now"] = now + step
        return now

    return clock


def test_the_budget_section_prints_the_time_limit_and_no_measured_time(
    proposal_factory,
) -> None:
    """Pinned as an exact row, so a timing value cannot be slipped back into it.

    The limit stays: a run stopped by it has to be readable against something.
    """
    proposal = proposal_factory(MATERIAL)
    body = render_body(_with_elapsed(proposal, 47.31597))

    assert f"| seconds | _not rendered_ | {proposal.budget.max_seconds:g} |" in body
    assert "47.31597" not in body
    assert "47.32" not in body
    assert "47.3" not in body


def test_the_body_is_identical_however_long_the_run_took(proposal_factory) -> None:
    """The property the existing no-churn test could only sample.

    Every value here would print differently under any scheme that renders or
    quantises measured time, so this fails if a timing-derived value is
    reintroduced in any form — including a bucketed one.
    """
    proposal = proposal_factory(MATERIAL)

    bodies = {render_body(_with_elapsed(proposal, s)) for s in ELAPSED_SPREAD}

    assert len(bodies) == 1


def test_two_renders_one_windows_timer_tick_apart_are_byte_identical(
    proposal_factory,
) -> None:
    """The reported case exactly: `0.00` against `0.02` at two decimal places.

    Linux's clock is fine-grained enough to hide this most of the time, which is
    why it is asserted here rather than left to be observed.
    """
    proposal = proposal_factory(MATERIAL)

    assert render_body(_with_elapsed(proposal, 0.0)) == render_body(
        _with_elapsed(proposal, WINDOWS_TIMER_TICK)
    )


def test_a_run_stopped_by_the_time_limit_still_says_so(proposal_factory) -> None:
    """Not printing the measurement must not hide the enforcement.

    The ledger keeps measuring elapsed time and keeps stopping a run that
    overruns; the body has to keep reporting that it did.
    """
    proposal = proposal_factory(MATERIAL)
    overrun = dataclasses.replace(
        proposal,
        budget=dataclasses.replace(
            proposal.budget, elapsed_seconds=120.5, exhausted_by=("seconds",)
        ),
    )

    body = render_body(overrun)

    assert "**Exhausted:** `seconds`" in body
    assert f"| seconds | _not rendered_ | {proposal.budget.max_seconds:g} |" in body
    assert "120.5" not in body


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
    # The seeded body carries no state marker, so replacing it is recorded first.
    assert client.actions == ["list", "comment", "update"]
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


# ---------------------------------------------------------------------------
# supersession continuity
#
# An update replaces a body wholesale, taking the previous run's evidence with
# it. "The previous run's evidence vanished with no trace" must not be reachable.
# ---------------------------------------------------------------------------


def test_the_state_marker_is_the_second_line_and_round_trips(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL, run_id="run-a")
    body = render_body(proposal, supersedes="run-older")

    state = read_state(body)

    assert body.split("\n")[1] == state_marker(proposal, "run-older")
    assert state is not None
    assert state.run_id == "run-a"
    assert state.supersedes == "run-older"
    assert state.claims == len(proposal.claims)
    assert state.accepted == len(proposal.accepted_claim_ids)
    assert state.conflicts == len(proposal.conflicts)
    assert state.failures == len(proposal.failures)


def test_state_is_anchored_to_the_second_line_only(proposal_factory) -> None:
    """Proposal content is fetched text. It must not be able to describe the issue."""
    proposal = proposal_factory(MATERIAL, run_id="run-a")
    forged = state_marker(proposal_factory(MATERIAL, run_id="run-forged"))
    body = render_body(proposal) + f"\nA quoted page said: {forged}\n"

    state = read_state(body)

    assert state is not None
    assert state.run_id == "run-a"


def test_a_body_without_a_state_marker_reads_as_unreadable() -> None:
    assert read_state(identity_marker(MATERIAL) + "\nhand written") is None
    assert read_state("") is None
    assert read_state(None) is None


def test_a_run_id_that_could_forge_a_state_marker_is_refused(proposal_factory) -> None:
    proposal = dataclasses.replace(
        proposal_factory(MATERIAL), run_id="run --> <!-- modeltree-run: v1 run=evil"
    )

    with pytest.raises(PublicationError):
        render_body(proposal)


def test_an_update_from_a_different_run_records_the_one_it_replaces(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()
    first = proposal_factory(MATERIAL, run_id="run-a")
    second = proposal_factory(MATERIAL, run_id="run-b")

    publish_proposal(first, client)
    outcome = publish_proposal(second, client)

    assert outcome.superseded_run == "run-a"
    assert client.actions == ["list", "create", "list", "comment", "update"]
    assert len(client.comments) == 1
    number, comment = client.comments[0]
    assert number == outcome.issue_number
    assert "run-a" in comment
    assert "run-b" in comment


def test_the_supersession_comment_carries_the_replaced_runs_counts(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()
    first = proposal_factory(MATERIAL, run_id="run-a")

    publish_proposal(first, client)
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)
    _, comment = client.comments[0]

    assert f"| Candidate claims | {len(first.claims)} |" in comment
    assert f"| Accepted | {len(first.accepted_claim_ids)} |" in comment
    assert f"| Conflicts | {len(first.conflicts)} |" in comment
    assert f"| Failures | {len(first.failures)} |" in comment


def test_the_comment_is_filed_before_the_body_is_overwritten(
    proposal_factory, fake_issues_client
) -> None:
    """The record exists to survive the rewrite, so it cannot be written after it.

    If the update fails, the run that was about to be replaced is still on record
    and the failure is reported; the reverse order can lose it silently.
    """
    client = fake_issues_client()
    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)

    def refuse(number: int, *, title: str, body: str):
        raise RuntimeError("update refused")

    client.update_issue = refuse

    with pytest.raises(RuntimeError):
        publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert len(client.comments) == 1
    assert "run-a" in client.comments[0][1]


def test_the_new_body_names_the_run_it_superseded(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()

    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert "| Supersedes run | `run-a` |" in client.issues[0].body


def test_a_first_publication_supersedes_nothing(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)

    assert outcome.superseded_run is None
    assert client.comments == []
    assert "| Supersedes run | — |" in client.issues[0].body


def test_re_rendering_the_same_run_adds_no_comment_and_no_churn(
    proposal_factory, fake_issues_client
) -> None:
    """Byte-identical, and the earlier supersession is carried forward intact."""
    client = fake_issues_client()
    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)
    after_replacement = client.issues[0].body

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert outcome.superseded_run is None
    assert len(client.comments) == 1
    assert client.issues[0].body == after_replacement
    assert "| Supersedes run | `run-a` |" in client.issues[0].body


def test_re_publishing_a_run_that_took_longer_adds_no_comment_and_no_churn(
    proposal_factory, fake_issues_client
) -> None:
    """The test above, with the clock controlled instead of raced.

    Two executions of run `run-b`: one against a stopped clock, one against a
    clock that advances a Windows timer tick per read. Their measured elapsed
    times genuinely differ — asserted, not assumed — and the published issue must
    still be byte-identical with no second supersession comment. This is what the
    test above can only get by luck, and got wrong a few percent of the time.
    """
    client = fake_issues_client()
    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)

    instant = proposal_factory(MATERIAL, run_id="run-b", clock=_stopped_clock())
    publish_proposal(instant, client)
    after_replacement = client.issues[0].body

    slow = proposal_factory(MATERIAL, run_id="run-b", clock=_ticking_clock())
    outcome = publish_proposal(slow, client)

    assert instant.budget.elapsed_seconds != slow.budget.elapsed_seconds
    assert outcome.superseded_run is None
    assert len(client.comments) == 1
    assert client.issues[0].body == after_replacement
    assert "| Supersedes run | `run-a` |" in client.issues[0].body


def test_replacing_a_body_that_cannot_be_read_says_so_rather_than_guessing(
    proposal_factory, fake_issues_client
) -> None:
    hand_edited = _issue(101, identity_marker(MATERIAL) + "\nsomeone rewrote this")
    client = fake_issues_client([hand_edited])

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert outcome.superseded_run == UNREADABLE_RUN
    assert len(client.comments) == 1
    assert "could not be read" in client.comments[0][1]
    # No invented run id, and no invented counts.
    assert "Candidate claims |" not in client.comments[0][1]
    assert "could not be read" in client.issues[0].body


def test_an_unreadable_replacement_is_carried_forward_as_a_known_unknown(
    proposal_factory, fake_issues_client
) -> None:
    hand_edited = _issue(101, identity_marker(MATERIAL) + "\nsomeone rewrote this")
    client = fake_issues_client([hand_edited])
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert len(client.comments) == 1
    assert read_state(client.issues[0].body).supersedes == UNREADABLE_RUN


def test_a_dry_run_records_no_supersession(report_factory, fake_issues_client) -> None:
    client = fake_issues_client()
    publish_proposal(
        report_factory(MATERIAL, run_id="run-a").proposals[0], client
    )

    result = publish_report(report_factory(MATERIAL, run_id="run-b"), None, dry_run=True)

    assert client.comments == []
    assert result.outcomes[0].superseded_run is None
    assert client.actions == ["list", "create"]


def test_a_no_change_run_never_comments(proposal_factory, fake_issues_client) -> None:
    existing = _issue(101, identity_marker(QUIET) + "\nolder proposal")
    client = fake_issues_client([existing])

    publish_proposal(proposal_factory(QUIET), client)

    assert client.comments == []
    assert client.calls == []
