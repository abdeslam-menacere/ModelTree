"""A source provider that fetches real web pages.

This is the one provider in the package that reaches the network. It implements
the *existing* async ``SourceProvider`` protocol (`providers/base.py`) — the same
`discover`/`fetch` shape the fixture provider satisfies — so the workflow is
unchanged: it still charges a page per fetch, still retries only typed
`ProviderError`s marked retryable, and still records every failure. Nothing here
writes ModelTree data; a fetch produces a `FetchedPage` and nothing else.

What it guarantees for a live page:

* **The hash is of the exact bytes served.** `FetchedPage.content_hash` digests
  the raw response body, not the decoded or tag-stripped text handed to the
  extractor, so a second fetch of unchanged content reproduces it (and any change
  to the served bytes changes it). `retrieved_at` is the real wall-clock instant
  the bytes arrived.
* **Honest citizenship.** It obeys `robots.txt`, identifies itself in a truthful
  `User-Agent`, and rate-limits per host. HTTPS-only, no credentials in URLs, no
  private or loopback hosts, no bare IPs — the same objective checks the
  `url-safety` gate applies, enforced here *before* the request because the gate
  runs after the fetch. Redirects are followed deliberately, one hop at a time,
  and every hop is re-validated so a redirect cannot smuggle a fetch to a
  private host.
* **Failures are typed.** Every failure is a `ProviderError`. Transient ones
  (connection errors, timeouts, HTTP 429/5xx, an unverifiable `robots.txt`) are
  ``retryable=True`` and spend the retry budget; deterministic ones (unsafe URL,
  disallowed by robots, wrong content type, oversized body, a 4xx) are
  ``retryable=False``. There is no new silent failure mode and no bare ``except``.

Network I/O is synchronous (`urllib`), so it runs in a worker thread via
`asyncio.to_thread`; the provider methods are genuinely ``async`` as the protocol
requires, never a synchronous ``def`` handing back an un-awaited coroutine.
"""

from __future__ import annotations

import asyncio
import http.client
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
from typing import Awaitable, Callable, Mapping, Sequence
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from ..contracts import (
    CreatorRequest,
    FetchedPage,
    SourceCandidate,
    SourceKind,
    content_hash_bytes,
)
from ..gates import url_safety_issues
from .base import ProviderError

__all__ = ["NetworkSourceProvider", "HttpResponse"]

PROVIDER_NAME = "network:sources"

# Truthful client identification: who is fetching, why, and where to complain.
DEFAULT_USER_AGENT = (
    "ModelTree-updater/0.1 "
    "(+https://github.com/abdeslam-menacere/ModelTree; proposal-only source fetcher)"
)

# Content types we can turn into readable text. Anything else (a PDF, an image, a
# binary download) is refused deliberately rather than hashed as opaque bytes.
DEFAULT_CONTENT_TYPES: frozenset[str] = frozenset(
    {"text/html", "application/xhtml+xml", "text/plain"}
)

_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})


@dataclass(frozen=True)
class HttpResponse:
    """One HTTP response, redirects *not* followed.

    ``url`` is the URL that produced this response. A 3xx is returned as data (with
    its ``Location``) rather than transparently followed, so the provider can
    re-validate every redirect hop for safety and robots policy itself.
    """

    url: str
    status: int
    headers: Mapping[str, str]
    body: bytes

    def header(self, name: str, default: str = "") -> str:
        lowered = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lowered:
                return value
        return default


# A callable that performs one request without following redirects. Injectable so
# the whole provider is exercisable offline with no sockets.
Opener = Callable[..., HttpResponse]

# Sentinel: a host whose robots.txt imposes no restriction (absent or 4xx).
_ALLOW_ALL = "allow-all"


def _default_opener(
    url: str, *, headers: Mapping[str, str], timeout: float, max_bytes: int
) -> HttpResponse:
    """Real HTTP via ``urllib``, reading at most ``max_bytes`` + 1 bytes.

    Redirects are not followed (the no-redirect opener returns the 3xx). HTTP
    error statuses are returned as data too, so the caller — not ``urllib`` —
    decides what a 404 or a 503 means.
    """
    request = urllib_request.Request(url, method="GET", headers=dict(headers))
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=timeout) as response:
            body = response.read(max_bytes + 1)
            return HttpResponse(
                url=response.geturl(),
                status=int(getattr(response, "status", 200) or 200),
                headers=dict(response.headers.items()),
                body=body,
            )
    except urllib_error.HTTPError as http_error:
        body = http_error.read(max_bytes + 1) if hasattr(http_error, "read") else b""
        headers = dict(http_error.headers.items()) if http_error.headers else {}
        return HttpResponse(
            url=http_error.geturl() or url,
            status=int(http_error.code),
            headers=headers,
            body=body,
        )


class _NoRedirect(urllib_request.HTTPRedirectHandler):
    """Return the 3xx instead of following it, so hops can be re-validated."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_NO_REDIRECT_OPENER = urllib_request.build_opener(_NoRedirect)


class _TextExtractor(HTMLParser):
    """Minimal, dependency-free HTML-to-text: drop markup, keep readable words."""

    _SKIP = frozenset({"script", "style", "noscript", "template"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: object) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0 and data.strip():
            self._chunks.append(data.strip())

    def text(self) -> str:
        return "\n".join(self._chunks)


def _html_to_text(markup: str) -> str:
    parser = _TextExtractor()
    parser.feed(markup)
    parser.close()
    return parser.text()


def _decode(body: bytes, content_type: str) -> str:
    """Decode using the header charset when given, else UTF-8, never crashing.

    The decoded text is only what the extractor reads; the integrity guarantee
    rests on the hash of ``body``, so a lenient decode here changes nothing about
    what was proven to have been served.
    """
    charset = ""
    for part in content_type.split(";")[1:]:
        key, _, value = part.strip().partition("=")
        if key.strip().lower() == "charset":
            charset = value.strip().strip('"').strip("'")
            break
    try:
        return body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def _main_content_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


class NetworkSourceProvider:
    """Fetches real pages for one creator, implementing ``SourceProvider``.

    ``discover`` turns the creator's configured seed URLs (`entry_urls`) into
    candidate sources; it does not search or crawl. ``fetch`` retrieves one, with
    the safety, robots, rate-limit, redirect, and content-type handling above.
    """

    name = PROVIDER_NAME

    def __init__(
        self,
        *,
        user_agent: str = DEFAULT_USER_AGENT,
        timeout: float = 15.0,
        min_host_interval: float = 1.0,
        max_bytes: int = 5_000_000,
        max_redirects: int = 5,
        allowed_content_types: frozenset[str] = DEFAULT_CONTENT_TYPES,
        respect_robots: bool = True,
        opener: Opener | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if max_redirects < 0:
            raise ValueError("max_redirects must be non-negative")
        self._user_agent = user_agent
        self._timeout = timeout
        self._min_host_interval = max(0.0, min_host_interval)
        self._max_bytes = max_bytes
        self._max_redirects = max_redirects
        self._allowed_content_types = allowed_content_types
        self._respect_robots = respect_robots
        self._opener = opener or _default_opener
        self._clock = clock
        self._sleep = sleep
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._robots: dict[str, object] = {}
        self._robots_lock = asyncio.Lock()
        self._last_fetch: dict[str, float] = {}
        self._rate_lock = asyncio.Lock()

    # -- protocol ---------------------------------------------------------------

    async def discover(
        self, creator: CreatorRequest, *, limit: int
    ) -> Sequence[SourceCandidate]:
        """Seed URLs become candidates; the network is not touched until ``fetch``.

        Unsafe or malformed seeds are *kept* as candidates rather than silently
        dropped: ``fetch`` will refuse them with a typed failure the proposal
        records, which is the honest outcome — a missing source must never look
        like "there was nothing to read".
        """
        discovered_at = self._now().isoformat()
        candidates: list[SourceCandidate] = []
        for url in creator.entry_urls[: max(0, limit)]:
            parts = urlsplit(url)
            candidates.append(
                SourceCandidate(
                    id=f"net-{sha256(url.encode('utf-8')).hexdigest()[:12]}",
                    creator_id=creator.creator_id,
                    url=url,
                    title=url,
                    publisher=(parts.hostname or "").lower(),
                    kind=SourceKind.OFFICIAL_DOCS,
                    discovered_at=discovered_at,
                )
            )
        return tuple(candidates)

    async def fetch(self, candidate: SourceCandidate) -> FetchedPage:
        response = await self._fetch_following_redirects(candidate.url)
        content_type = response.header("content-type")
        main_type = _main_content_type(content_type)
        if main_type and main_type not in self._allowed_content_types:
            raise ProviderError(
                f"unsupported content type {main_type!r} for {response.url}; "
                f"expected one of {sorted(self._allowed_content_types)}",
                provider=self.name,
                retryable=False,
            )

        # Hash the exact bytes served, then decode a separate view for extraction.
        digest = content_hash_bytes(response.body)
        text = _decode(response.body, content_type)
        if main_type != "text/plain":
            text = _html_to_text(text)

        return FetchedPage(
            source=candidate,
            text=text,
            retrieved_at=self._now().isoformat(),
            content_hash=digest,
        )

    # -- fetching ---------------------------------------------------------------

    async def _fetch_following_redirects(self, url: str) -> HttpResponse:
        current = url
        for _ in range(self._max_redirects + 1):
            self._require_safe_url(current)
            await self._require_robots_allow(current)
            response = await self._get(current)

            if response.status in _REDIRECT_CODES:
                location = response.header("location")
                if not location:
                    raise ProviderError(
                        f"{current} returned {response.status} without a Location header",
                        provider=self.name,
                        retryable=False,
                    )
                current = urljoin(current, location)
                continue

            return self._checked(response)

        raise ProviderError(
            f"too many redirects (> {self._max_redirects}) starting at {url}",
            provider=self.name,
            retryable=False,
        )

    def _checked(self, response: HttpResponse) -> HttpResponse:
        status = response.status
        if status == 200:
            if len(response.body) > self._max_bytes:
                raise ProviderError(
                    f"{response.url} body exceeds the {self._max_bytes}-byte limit",
                    provider=self.name,
                    retryable=False,
                )
            return response
        if status == 429 or 500 <= status < 600:
            raise ProviderError(
                f"{response.url} returned a transient HTTP {status}",
                provider=self.name,
                retryable=True,
            )
        raise ProviderError(
            f"{response.url} returned HTTP {status}",
            provider=self.name,
            retryable=False,
        )

    async def _get(self, url: str) -> HttpResponse:
        """Rate-limited page request. Network failures become retryable errors."""
        await self._rate_limit(_host_key(url))
        return await self._request(url)

    async def _request(self, url: str) -> HttpResponse:
        headers = {"User-Agent": self._user_agent, "Accept": "text/html, text/plain, */*"}
        try:
            return await asyncio.to_thread(
                self._opener,
                url,
                headers=headers,
                timeout=self._timeout,
                max_bytes=self._max_bytes,
            )
        except (
            urllib_error.URLError,
            http.client.HTTPException,
            TimeoutError,
            OSError,
            ValueError,
        ) as error:
            # Every transport-level failure — DNS, connection, timeout, a truncated
            # read, a malformed status line or port — becomes one typed, retryable
            # outcome. None may escape as an untyped exception the workflow can't
            # account for.
            raise ProviderError(
                f"could not reach {url}: {error}",
                provider=self.name,
                retryable=True,
            ) from error

    # -- politeness -------------------------------------------------------------

    def _require_safe_url(self, url: str) -> None:
        issues = url_safety_issues("source.url", url)
        if issues:
            raise ProviderError(
                f"refusing to fetch {url}: {'; '.join(issues)}",
                provider=self.name,
                retryable=False,
            )
        # NOTE: these are the same lexical checks the `url-safety` gate applies. A
        # host that *resolves* to a private or loopback address (DNS rebinding) is
        # not caught here — see the network provider follow-up in the issue.

    async def _rate_limit(self, host: str) -> None:
        if self._min_host_interval <= 0:
            return
        async with self._rate_lock:
            now = self._clock()
            reserved = self._last_fetch.get(host)
            start_at = now if reserved is None else max(now, reserved)
            wait = start_at - now
            # Reserve this host's slot so concurrent fetches queue behind it.
            self._last_fetch[host] = start_at + self._min_host_interval
        if wait > 0:
            await self._sleep(wait)

    async def _require_robots_allow(self, url: str) -> None:
        if not self._respect_robots:
            return
        key = _origin(url)
        rules = self._robots.get(key)
        if rules is None:
            # Serialise loads so concurrent fetches to one host don't each stampede
            # its robots.txt; re-check the cache once the lock is held.
            async with self._robots_lock:
                rules = self._robots.get(key)
                if rules is None:
                    rules = await self._load_robots(key)
                    self._robots[key] = rules
        if rules is _ALLOW_ALL:
            return
        assert isinstance(rules, RobotFileParser)
        if not rules.can_fetch(self._user_agent, url):
            raise ProviderError(
                f"robots.txt at {key} disallows fetching {url}",
                provider=self.name,
                retryable=False,
            )

    async def _load_robots(self, origin: str) -> object:
        """Fetch and parse ``origin/robots.txt``, following redirects deliberately.

        Robots requests go through the same per-host rate limiter and safety checks
        as page requests. Per RFC 9309: a 2xx is parsed; a 4xx (including an absent
        404) means no restrictions; a 429/5xx is transient and refused as retryable
        rather than guessed. A robots redirect is followed, not read as allow-all.
        """
        current = origin + "/robots.txt"
        for _ in range(self._max_redirects + 1):
            self._require_safe_url(current)
            response = await self._get(current)
            if response.status in _REDIRECT_CODES:
                location = response.header("location")
                if not location:
                    return _ALLOW_ALL
                current = urljoin(current, location)
                continue
            if response.status == 200:
                parser = RobotFileParser()
                parser.parse(
                    response.body.decode("utf-8", errors="replace").splitlines()
                )
                return parser
            if response.status == 429 or 500 <= response.status < 600:
                # Can't confirm the page is allowed; treat as transient, don't guess.
                raise ProviderError(
                    f"robots.txt at {origin} is unavailable (HTTP {response.status})",
                    provider=self.name,
                    retryable=True,
                )
            # Absent or otherwise 4xx robots.txt means no restrictions (RFC 9309).
            return _ALLOW_ALL
        # A robots.txt that only ever redirects: fetch nothing, impose nothing.
        return _ALLOW_ALL


def _host_key(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"
