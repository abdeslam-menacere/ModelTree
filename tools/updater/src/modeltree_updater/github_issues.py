"""The one place this tool talks to GitHub, and it can only talk about issues.

The updater proposes; a human disposes. Publication is therefore deliberately
narrow: this module can create an issue, edit an issue, comment on an issue, and
list open issues. Every request is built under ``/repos/{owner}/{repo}/issues``,
so there is no code path here that could reach a branch, a commit, a file, a
merge, or a pull request, whatever a caller asked for.
`tests/test_proposal_only.py` enforces that this is the only module in the
package allowed to name the GitHub API at all, and reads the URL fragments it can
build straight out of the syntax tree.

Everything above this boundary depends on the :class:`IssuesClient` protocol, so
the whole publication decision — materiality, identity, deduplication — is
exercised offline with a fake client and no network and no token.

Transport is stdlib ``urllib``, matching `providers/network.py`; publication adds
no dependency. The token is read from the environment by the caller, never
logged, and never written into a proposal.
"""

from __future__ import annotations

import http.client
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol, Sequence
from urllib import error as urllib_error
from urllib import request as urllib_request

__all__ = [
    "DEFAULT_API_URL",
    "GitHubError",
    "Issue",
    "IssuesClient",
    "RestIssuesClient",
    "split_repository",
]

DEFAULT_API_URL = "https://api.github.com"

USER_AGENT = (
    "ModelTree-updater/0.1 "
    "(+https://github.com/abdeslam-menacere/ModelTree; proposal-only issue publisher)"
)

API_VERSION = "2022-11-28"

# GitHub's own limit for an issue body. Rendering respects it rather than letting
# a large proposal fail the request with a 422.
MAX_BODY_CHARS = 65_536

_OWNER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
# A name that is nothing but dots -- ``.``, ``..``, ``...`` -- passes the
# character class above but is not a repository GitHub will name; ``.`` and
# ``..`` in particular are path segments, and ``..`` reaches the wire literally
# because the client does not normalise the path. Refusing every all-dots name
# closes that without touching legitimate single-dot names like ``my.repo``.
_ALL_DOTS = re.compile(r"^\.+$")

# A listing that needs more pages than this is not a repository this tool should
# be guessing about: failing loudly beats missing the issue it must update and
# opening a duplicate instead.
MAX_LIST_PAGES = 20
PER_PAGE = 100


class GitHubError(RuntimeError):
    """A GitHub request failed, or answered something this tool cannot use."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Issue:
    """One issue as this tool needs to see it."""

    number: int
    title: str
    body: str
    state: str


class IssuesClient(Protocol):
    """The complete set of things publication is allowed to do to a repository."""

    def list_open_issues(self) -> Sequence[Issue]:
        """Every open issue in the repository, pull requests excluded."""

    def create_issue(self, *, title: str, body: str) -> Issue:
        """Open a new issue."""

    def update_issue(self, number: int, *, title: str, body: str) -> Issue:
        """Replace the title and body of an existing issue."""

    def create_comment(self, number: int, *, body: str) -> None:
        """Add a comment to an existing issue.

        Publication needs this to record what an update is about to overwrite: a
        body replaced wholesale takes the previous run's evidence with it, and a
        comment is the only append-only record this tool can leave.
        """


def split_repository(repository: str) -> tuple[str, str]:
    """Validate and split ``owner/name``.

    The two halves are interpolated into a URL, so they are checked against
    GitHub's own naming rules rather than trusted. There is exactly one
    separator, the owner cannot contain ``.`` or ``/`` at all, and a name that is
    nothing but dots -- ``.`` or ``..`` or any run of dots -- is refused, so no
    ``owner/..``-shaped value survives to be interpolated. A name that merely
    contains a dot, such as ``my.repo``, is still accepted. What is *not*
    promised here: a name carrying a dot in some other position is not otherwise
    constrained beyond the character class, and this function does not confirm
    that the repository exists.
    """
    owner, separator, name = repository.partition("/")
    if (
        not separator
        or not _OWNER.match(owner)
        or not _REPO.match(name)
        or _ALL_DOTS.match(name)
    ):
        raise GitHubError(
            f"{repository!r} is not a valid repository; expected owner/name"
        )
    return owner, name


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


Opener = Callable[..., HttpResponse]


def _default_opener(
    url: str, *, method: str, headers: Mapping[str, str], payload: bytes | None, timeout: float
) -> HttpResponse:
    request = urllib_request.Request(
        url, method=method, headers=dict(headers), data=payload
    )
    try:
        with urllib_request.urlopen(request, timeout=timeout) as response:
            return HttpResponse(
                status=int(getattr(response, "status", 200) or 200),
                headers=dict(response.headers.items()),
                body=response.read(),
            )
    except urllib_error.HTTPError as http_error:
        body = http_error.read() if hasattr(http_error, "read") else b""
        headers = dict(http_error.headers.items()) if http_error.headers else {}
        return HttpResponse(status=int(http_error.code), headers=headers, body=body)


class RestIssuesClient:
    """`IssuesClient` over the GitHub REST API.

    ``api_url`` exists for GitHub Enterprise and for tests; it is not a way to
    widen what this client can do, because every request is built from
    :meth:`_issues_url` and nothing else.
    """

    def __init__(
        self,
        *,
        repository: str,
        token: str,
        api_url: str = DEFAULT_API_URL,
        opener: Opener | None = None,
        timeout: float = 30.0,
    ) -> None:
        if not token:
            raise GitHubError("a GitHub token is required to publish a proposal issue")
        self._owner, self._repo = split_repository(repository)
        self._api_url = api_url.rstrip("/")
        self._token = token
        self._opener = opener or _default_opener
        self._timeout = timeout

    @property
    def repository(self) -> str:
        return f"{self._owner}/{self._repo}"

    # -- the only URLs this client can build -------------------------------------

    def _issues_url(self, *, number: int | None = None, query: str = "") -> str:
        suffix = "" if number is None else f"/{int(number)}"
        return f"{self._api_url}/repos/{self._owner}/{self._repo}/issues{suffix}{query}"

    def _comments_url(self, number: int) -> str:
        """The comment collection of one issue, and nothing else.

        Built from :meth:`_issues_url` so it inherits the same validated owner and
        repository, and cannot address anything outside `/issues`.
        """
        return f"{self._issues_url(number=number)}/comments"

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self._token}",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
        }

    def _send(self, url: str, *, method: str, payload: Mapping[str, Any] | None) -> Any:
        encoded = None if payload is None else json.dumps(payload).encode("utf-8")
        try:
            response = self._opener(
                url,
                method=method,
                headers=self._headers(),
                payload=encoded,
                timeout=self._timeout,
            )
        except (urllib_error.URLError, http.client.HTTPException, TimeoutError, OSError) as error:
            raise GitHubError(f"{method} {_safe(url)} failed: {error}") from error

        if not 200 <= response.status < 300:
            raise GitHubError(
                f"{method} {_safe(url)} returned HTTP {response.status}: "
                f"{_detail(response.body)}",
                status=response.status,
            )
        if not response.body:
            return None
        try:
            return json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GitHubError(f"{method} {_safe(url)} returned unreadable JSON: {error}") from error

    # -- protocol ---------------------------------------------------------------

    def list_open_issues(self) -> Sequence[Issue]:
        issues: list[Issue] = []
        for page in range(1, MAX_LIST_PAGES + 1):
            url = self._issues_url(
                query=f"?state=open&per_page={PER_PAGE}&page={page}&sort=created&direction=asc"
            )
            batch = self._send(url, method="GET", payload=None)
            if not isinstance(batch, list):
                raise GitHubError(f"expected a list of issues from {_safe(url)}")
            for item in batch:
                # A pull request is served by the issues endpoint too. This tool
                # neither opens nor edits one, so they are dropped here.
                if isinstance(item, Mapping) and "pull_request" not in item:
                    issues.append(_issue(item))
            if len(batch) < PER_PAGE:
                return tuple(issues)
        raise GitHubError(
            f"{self.repository} has more than {MAX_LIST_PAGES * PER_PAGE} open issues; "
            "refusing to guess which proposal issue to update"
        )

    def create_issue(self, *, title: str, body: str) -> Issue:
        return _issue(
            self._send(
                self._issues_url(), method="POST", payload={"title": title, "body": body}
            )
        )

    def update_issue(self, number: int, *, title: str, body: str) -> Issue:
        return _issue(
            self._send(
                self._issues_url(number=number),
                method="PATCH",
                payload={"title": title, "body": body},
            )
        )

    def create_comment(self, number: int, *, body: str) -> None:
        self._send(self._comments_url(number), method="POST", payload={"body": body})


def _issue(data: Any) -> Issue:
    if not isinstance(data, Mapping) or "number" not in data:
        raise GitHubError(f"expected an issue object, got {type(data).__name__}")
    return Issue(
        number=int(data["number"]),
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
        state=str(data.get("state") or "open"),
    )


def _safe(url: str) -> str:
    """URLs are built from validated parts and carry no credentials, but the
    query is dropped from error text anyway so nothing incidental is echoed."""
    return url.split("?", 1)[0]


def _detail(body: bytes) -> str:
    text = body.decode("utf-8", errors="replace").strip()
    return text[:400] if text else "(no response body)"
