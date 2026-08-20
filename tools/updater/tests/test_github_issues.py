"""The one module allowed to name the GitHub API.

These tests pin what it can address. If a future change could reach a branch, a
commit, or a pull request, one of these fails.
"""

from __future__ import annotations

import json
import urllib.error
from urllib.parse import parse_qs, urlsplit

import pytest

from modeltree_updater.github_issues import (
    MAX_LIST_PAGES,
    PER_PAGE,
    GitHubError,
    HttpResponse,
    RestIssuesClient,
    split_repository,
)


class Recorder:
    """A fake transport. Records every request and replays queued responses."""

    def __init__(self, responses) -> None:
        self.responses = list(responses)
        self.requests: list[dict] = []

    def __call__(self, url, *, method, headers, payload, timeout):
        self.requests.append(
            {
                "url": url,
                "method": method,
                "headers": dict(headers),
                "payload": None if payload is None else json.loads(payload),
                "timeout": timeout,
            }
        )
        if not self.responses:
            raise AssertionError(f"unexpected request: {method} {url}")
        return self.responses.pop(0)

    @property
    def paths(self) -> list[str]:
        return [urlsplit(request["url"]).path for request in self.requests]


def _json(payload, status: int = 200) -> HttpResponse:
    return HttpResponse(
        status=status, headers={}, body=json.dumps(payload).encode("utf-8")
    )


def _client(recorder, repository: str = "octo/modeltree") -> RestIssuesClient:
    return RestIssuesClient(
        repository=repository, token="t0ken", opener=recorder, api_url="https://api.test"
    )


def _issue(number: int, **extra) -> dict:
    return {
        "number": number,
        "title": f"issue {number}",
        "body": "body",
        "state": "open",
        **extra,
    }


def test_listing_open_issues_reads_only_the_issues_endpoint() -> None:
    recorder = Recorder([_json([_issue(1)])])

    issues = _client(recorder).list_open_issues()

    assert [issue.number for issue in issues] == [1]
    assert recorder.paths == ["/repos/octo/modeltree/issues"]
    assert recorder.requests[0]["method"] == "GET"
    assert parse_qs(urlsplit(recorder.requests[0]["url"]).query)["state"] == ["open"]


def test_a_pull_request_served_by_the_issues_endpoint_is_dropped() -> None:
    """GitHub returns pull requests from /issues. This tool must never touch one."""
    recorder = Recorder(
        [_json([_issue(1), _issue(2, pull_request={"url": "https://api.test/pr/2"})])]
    )

    issues = _client(recorder).list_open_issues()

    assert [issue.number for issue in issues] == [1]


def test_listing_follows_pagination_until_a_short_page() -> None:
    recorder = Recorder(
        [
            _json([_issue(number) for number in range(1, PER_PAGE + 1)]),
            _json([_issue(999)]),
        ]
    )

    issues = _client(recorder).list_open_issues()

    assert len(issues) == PER_PAGE + 1
    pages = [
        parse_qs(urlsplit(request["url"]).query)["page"] for request in recorder.requests
    ]
    assert pages == [["1"], ["2"]]


def test_an_unbounded_issue_list_is_refused_rather_than_silently_truncated() -> None:
    full_page = _json([_issue(number) for number in range(1, PER_PAGE + 1)])
    recorder = Recorder([full_page] * (MAX_LIST_PAGES + 1))

    with pytest.raises(GitHubError) as error:
        _client(recorder).list_open_issues()

    assert "refusing to guess" in str(error.value)


def test_creating_an_issue_posts_title_and_body() -> None:
    recorder = Recorder([_json(_issue(7), status=201)])

    issue = _client(recorder).create_issue(title="t", body="b")

    assert issue.number == 7
    assert recorder.requests[0]["method"] == "POST"
    assert recorder.paths == ["/repos/octo/modeltree/issues"]
    assert recorder.requests[0]["payload"] == {"title": "t", "body": "b"}


def test_updating_an_issue_patches_that_issue() -> None:
    recorder = Recorder([_json(_issue(7))])

    _client(recorder).update_issue(7, title="t", body="b")

    assert recorder.requests[0]["method"] == "PATCH"
    assert recorder.paths == ["/repos/octo/modeltree/issues/7"]
    assert recorder.requests[0]["payload"] == {"title": "t", "body": "b"}


def test_commenting_posts_to_that_issues_comments() -> None:
    recorder = Recorder([_json({"id": 1}, status=201)])

    _client(recorder).create_comment(7, body="recorded")

    assert recorder.requests[0]["method"] == "POST"
    assert recorder.paths == ["/repos/octo/modeltree/issues/7/comments"]
    assert recorder.requests[0]["payload"] == {"body": "recorded"}


def test_a_comment_cannot_be_addressed_outside_the_repository() -> None:
    """The comment URL is built from the same validated owner and repository."""
    recorder = Recorder([_json({"id": 1}, status=201)])

    _client(recorder, "octo/modeltree").create_comment(7, body="b")

    assert recorder.paths[0].startswith("/repos/octo/modeltree/issues/")


def test_every_url_this_client_can_build_ends_at_issues() -> None:
    """Every URL builder in the client; this asserts what they can reach."""
    recorder = Recorder(
        [_json([]), _json(_issue(7), status=201), _json(_issue(7)), _json({"id": 1}, status=201)]
    )
    client = _client(recorder)

    client.list_open_issues()
    client.create_issue(title="t", body="b")
    client.update_issue(7, title="t", body="b")
    client.create_comment(7, body="b")

    for path in recorder.paths:
        assert path in {
            "/repos/octo/modeltree/issues",
            "/repos/octo/modeltree/issues/7",
            "/repos/octo/modeltree/issues/7/comments",
        }, path


def test_requests_are_authenticated_and_version_pinned() -> None:
    recorder = Recorder([_json([])])

    _client(recorder).list_open_issues()
    headers = recorder.requests[0]["headers"]

    assert headers["Authorization"].startswith("Bearer ")
    assert headers["Accept"] == "application/vnd.github+json"
    assert headers["X-GitHub-Api-Version"]


def test_an_error_response_becomes_a_typed_error_carrying_the_status() -> None:
    recorder = Recorder(
        [HttpResponse(status=403, headers={}, body=b'{"message": "Resource not accessible"}')]
    )

    with pytest.raises(GitHubError) as error:
        _client(recorder).create_issue(title="t", body="b")

    assert error.value.status == 403
    assert "Resource not accessible" in str(error.value)


def test_a_transport_failure_becomes_a_typed_error() -> None:
    def explode(url, **kwargs):
        raise urllib.error.URLError("no route to host")

    with pytest.raises(GitHubError) as error:
        _client(explode).list_open_issues()

    assert "no route to host" in str(error.value)


def test_the_token_never_reaches_an_error_message() -> None:
    recorder = Recorder([HttpResponse(status=500, headers={}, body=b"boom")])

    with pytest.raises(GitHubError) as error:
        RestIssuesClient(
            repository="octo/modeltree",
            token="ghp-supersecret",
            opener=recorder,
            api_url="https://api.test",
        ).create_issue(title="t", body="b")

    assert "ghp-supersecret" not in str(error.value)


def test_unreadable_json_is_refused() -> None:
    recorder = Recorder([HttpResponse(status=200, headers={}, body=b"<html>")])

    with pytest.raises(GitHubError):
        _client(recorder).list_open_issues()


def test_a_repository_without_an_owner_is_refused() -> None:
    with pytest.raises(GitHubError):
        split_repository("modeltree")


def test_a_repository_that_could_escape_the_url_is_refused() -> None:
    for repository in ("octo/../../secrets", "octo/repo/extra", "../octo/repo"):
        with pytest.raises(GitHubError):
            RestIssuesClient(repository=repository, token="t", opener=Recorder([]))


def test_a_missing_token_is_refused_before_any_request() -> None:
    with pytest.raises(GitHubError):
        RestIssuesClient(repository="octo/modeltree", token="")
