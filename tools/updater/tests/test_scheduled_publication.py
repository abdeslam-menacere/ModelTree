"""Deduplication across a *sequence* of scheduled runs.

#66 built this publisher for manual dispatch and #30 puts it on a weekly
schedule, so #30's acceptance criteria require that duplicate observations still
update one open issue when the run was scheduled rather than dispatched. That is
a property of a series of runs, not of any one of them, so it is asserted over a
series.

Why the series is worth testing separately from `test_publisher.py`'s single-run
cases: the workflow derives its run id from `github.run_id`, which differs on
every run. Each scheduled run therefore reaches the publisher looking like a new
run standing over an issue written by an older one -- and it does so
indefinitely, unattended, which is the input a manual re-run almost never
produces.

The four cases #30 asks for are named here as the publisher actually expresses
them, because there is no fingerprint layer in this repository to express them
any other way -- that is #85, and it is deliberately not built here:

  new        a creator with something material and no open proposal
  changed    the same creator, later, with a different observation
  unchanged  the same creator, later, with the same observation
  removed    a source that is gone, which reaches the publisher either as a run
             with nothing material left to say or as a run carrying the failure
             to reach it. Both are covered; they behave differently and both
             behaviours matter.

Everything runs offline against committed fixtures and an in-memory client.
"""

from __future__ import annotations

import pytest

from modeltree_updater.budgets import CreatorBudget
from modeltree_updater.github_issues import Issue
from modeltree_updater.publisher import (
    PublicationAction,
    identity_marker,
    issue_title,
    publish_proposal,
    read_state,
)

# The fixture creators, by the role each plays. Same names `test_publisher.py`
# uses, for the same reasons.
MATERIAL = "contoso-ai"
UNREACHABLE = "fabrikam-ai"
QUIET = "quiet-ai"


def _weekly_run_id(week: int) -> str:
    """What the workflow passes as `--run-id`, one Monday at a time.

    `run-<github.run_id>-<github.run_attempt>`. The run id is what makes each
    scheduled run distinguishable from the last, so the tests below vary it and
    nothing else unless they say so.
    """
    return f"run-{1000 + week}-1"


def _open_proposals(client) -> list[Issue]:
    return [
        issue
        for issue in client.issues
        if issue.state == "open" and issue.body.startswith("<!-- modeltree-proposal:")
    ]


# ---------------------------------------------------------------------------
# the four cases, in the order a schedule meets them
# ---------------------------------------------------------------------------


def test_new_the_first_sweep_opens_one_issue(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id=_weekly_run_id(1)), client)

    assert outcome.action is PublicationAction.CREATED
    assert len(_open_proposals(client)) == 1
    assert client.issues[0].title == issue_title(MATERIAL)


def test_changed_a_later_sweep_updates_that_issue_rather_than_opening_another(
    proposal_factory, fake_issues_client
) -> None:
    """A different observation for a creator that already has an open proposal.

    The budget is what makes week two's observation genuinely different rather
    than merely later, and the assertion that the two differ is made explicitly:
    a test that meant to exercise "changed" and silently exercised "unchanged"
    would still pass every assertion below it.
    """
    client = fake_issues_client()
    week_one = proposal_factory(MATERIAL, run_id=_weekly_run_id(1))
    week_two = proposal_factory(
        MATERIAL, run_id=_weekly_run_id(2), budget=CreatorBudget(max_pages=1)
    )
    assert (len(week_two.claims), week_two.status) != (
        len(week_one.claims),
        week_one.status,
    ), "the second observation has to actually differ for this to test anything"

    first = publish_proposal(week_one, client)
    second = publish_proposal(week_two, client)

    assert second.action is PublicationAction.UPDATED
    assert second.issue_number == first.issue_number
    assert len(_open_proposals(client)) == 1
    assert second.superseded_run == _weekly_run_id(1)
    assert client.comments, "the run it replaced is recorded before the overwrite"


def test_unchanged_a_repeat_observation_still_updates_the_one_issue(
    proposal_factory, fake_issues_client
) -> None:
    """The same observation a week later opens nothing new.

    It does rewrite the body and file a supersession comment, because the run id
    moved and the publisher compares run ids rather than observations. That is a
    known cost of scheduling, recorded in `tools/updater/README.md` under false
    positives: suppressing it means comparing this observation with the last
    reviewed state, which is #85's clause and is not built here. The assertion
    is written to say what is guaranteed -- one issue, never a second -- rather
    than to freeze the churn as though it were desired.
    """
    client = fake_issues_client()

    publish_proposal(proposal_factory(MATERIAL, run_id=_weekly_run_id(1)), client)
    second = publish_proposal(proposal_factory(MATERIAL, run_id=_weekly_run_id(2)), client)

    assert second.action is PublicationAction.UPDATED
    assert len(_open_proposals(client)) == 1
    assert client.actions.count("create") == 1


def test_removed_a_creator_with_nothing_left_to_say_makes_no_request(
    proposal_factory, fake_issues_client
) -> None:
    """One reading of "removed": there is no longer anything to report.

    The proposal is not material, so the sweep makes no GitHub request at all --
    not even a read -- and any open proposal is left exactly as it was. Deciding
    a stale proposal is a human's call; a weekly job closing issues on its own is
    precisely what this workflow must not become.
    """
    existing = Issue(
        number=101,
        title=issue_title(QUIET),
        body=identity_marker(QUIET) + "\nan earlier proposal a human is reading",
        state="open",
    )
    client = fake_issues_client([existing])

    outcome = publish_proposal(proposal_factory(QUIET, run_id=_weekly_run_id(9)), client)

    assert outcome.action is PublicationAction.SKIPPED_NO_CHANGE
    assert client.calls == []
    assert client.issues == [existing]


def test_removed_a_source_that_could_not_be_reached_reaches_the_issue(
    proposal_factory, fake_issues_client
) -> None:
    """The other reading: the source is gone and the run says so.

    A failure is material, so it is published rather than swallowed. This is the
    half the workflow's exit-3 handling exists to protect: the report carrying
    this failure is written before the CLI returns 3, and aborting the step on
    that code would have thrown it away before the publish step ever ran.
    """
    proposal = proposal_factory(UNREACHABLE, run_id=_weekly_run_id(1))
    assert proposal.failures, "this fixture is the one that fails"
    client = fake_issues_client()

    outcome = publish_proposal(proposal, client)

    assert outcome.action is PublicationAction.CREATED
    assert "Completion status" in client.issues[0].body


# ---------------------------------------------------------------------------
# the acceptance criterion itself
# ---------------------------------------------------------------------------


def test_a_run_of_sweeps_converges_on_exactly_one_issue(
    proposal_factory, fake_issues_client
) -> None:
    """"Duplicate observations update one open issue", over a year of Mondays.

    Five distinct run ids, one issue. The count is what #30 asks about; asserting
    it after a single re-run would be a weaker claim than the criterion makes.
    """
    client = fake_issues_client()

    for week in range(1, 6):
        publish_proposal(proposal_factory(MATERIAL, run_id=_weekly_run_id(week)), client)

    assert len(_open_proposals(client)) == 1
    assert client.actions.count("create") == 1
    assert client.actions.count("update") == 4
    assert read_state(client.issues[0].body).run_id == _weekly_run_id(5)


@pytest.mark.parametrize("week", [1, 7, 52])
def test_identity_does_not_depend_on_which_run_observed_it(
    proposal_factory, fake_issues_client, week
) -> None:
    """Why scheduling cannot break deduplication, stated as the reason.

    The marker the publisher matches on carries the creator id and nothing else
    -- no run id, no event name, no timestamp -- so a scheduled run and a
    dispatched one address the same issue by construction rather than by
    agreement. If this ever stops holding, every test above degrades into
    creating issues nobody asked for, so it is pinned on its own.
    """
    client = fake_issues_client()
    publish_proposal(proposal_factory(MATERIAL, run_id=_weekly_run_id(0)), client)

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id=_weekly_run_id(week)), client)

    assert outcome.action is PublicationAction.UPDATED
    assert client.issues[0].body.splitlines()[0] == identity_marker(MATERIAL)


def test_one_unreachable_creator_does_not_stop_the_sweep(
    proposal_factory, fake_issues_client
) -> None:
    """A weekly sweep covers several creators, and one bad week must not silence
    the rest. `publish_report` already isolates a publication failure; this is
    the same guarantee on the observation side, which is what an unreachable
    source produces."""
    client = fake_issues_client()
    run_id = _weekly_run_id(3)

    failed = publish_proposal(proposal_factory(UNREACHABLE, run_id=run_id), client)
    healthy = publish_proposal(proposal_factory(MATERIAL, run_id=run_id), client)

    assert failed.action is PublicationAction.CREATED
    assert healthy.action is PublicationAction.CREATED
    assert failed.issue_number != healthy.issue_number
    assert len(_open_proposals(client)) == 2
