"""Opt-in publication against a real GitHub repository.

Excluded from the default run by the `live` marker: normal CI stays offline and
credential-free. Enable deliberately, against a scratch repository you own::

    MODELTREE_LIVE_PUBLISH_REPO=you/scratch GITHUB_TOKEN=... \
        pytest -m live tests/test_live_publication.py

The token needs issues:write on that repository and nothing else. These tests
create and update issues there; they never close one, and they never touch
repository content.
"""

from __future__ import annotations

import os

import pytest

from modeltree_updater.github_issues import RestIssuesClient
from modeltree_updater.publisher import (
    PublicationAction,
    find_open_proposals,
    identity_marker,
    issue_title,
    publish_proposal,
)

pytestmark = pytest.mark.live

REPO_VAR = "MODELTREE_LIVE_PUBLISH_REPO"
CREATOR = "contoso-ai"


@pytest.fixture()
def live_client() -> RestIssuesClient:
    repository = os.environ.get(REPO_VAR)
    token = os.environ.get("GITHUB_TOKEN")
    if not repository or not token:
        pytest.skip(f"set {REPO_VAR} and GITHUB_TOKEN to run live publication tests")
    return RestIssuesClient(
        repository=repository,
        token=token,
        api_url=os.environ.get("GITHUB_API_URL") or "https://api.github.com",
    )


def test_publishing_twice_leaves_exactly_one_open_proposal(
    live_client, proposal_factory
) -> None:
    proposal = proposal_factory(CREATOR)

    first = publish_proposal(proposal, live_client)
    second = publish_proposal(proposal, live_client)

    assert first.issue_number == second.issue_number
    assert second.action is PublicationAction.UPDATED

    open_proposals = find_open_proposals(live_client.list_open_issues(), CREATOR)
    assert [issue.number for issue in open_proposals] == [first.issue_number]
    assert open_proposals[0].title == issue_title(CREATOR)
    assert open_proposals[0].body.splitlines()[0] == identity_marker(CREATOR)


def test_a_no_change_run_publishes_nothing(live_client, proposal_factory) -> None:
    before = live_client.list_open_issues()

    outcome = publish_proposal(proposal_factory("quiet-ai"), live_client)

    assert outcome.action is PublicationAction.SKIPPED_NO_CHANGE
    assert [issue.number for issue in live_client.list_open_issues()] == [
        issue.number for issue in before
    ]
