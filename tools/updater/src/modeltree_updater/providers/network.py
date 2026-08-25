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
* **The address is checked, not just the name.** A URL is only a name, so a
  public hostname whose A record points at loopback, a cloud metadata endpoint or
  the LAN would pass every lexical check. The transport resolves each host once,
  refuses the name unless *every* record it returns is on the public internet,
  and then connects to one of those validated addresses directly — so there is no
  window in which a second lookup could answer differently. TLS still verifies
  the certificate against the hostname, so pinning the address costs nothing in
  authentication.
* **Failures are typed.** Every failure is a `ProviderError`. Transient ones
  (connection errors, timeouts, HTTP 429/5xx, an unverifiable `robots.txt`) are
  ``retryable=True`` and spend the retry budget; deterministic ones (an unsafe URL
  or resolved address, disallowed by robots, wrong content type, oversized body, a
  4xx) are ``retryable=False``. There is no new silent failure mode and no bare
  ``except``.

Network I/O is synchronous (`urllib`), so it runs in a worker thread via
`asyncio.to_thread`; the provider methods are genuinely ``async`` as the protocol
requires, never a synchronous ``def`` handing back an un-awaited coroutine.
"""

from __future__ import annotations

import asyncio
import http.client
import ipaddress
import socket
import ssl
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

__all__ = [
    "NetworkSourceProvider",
    "HttpResponse",
    "UnsafeAddressError",
    "address_safety_issue",
    "build_default_opener",
]

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

# ``socket.getaddrinfo``-shaped name resolution, and ``socket.create_connection``-
# shaped dialling. Both are injectable so the pinned transport below can be
# proven offline without opening a socket or consulting real DNS.
Resolver = Callable[..., Sequence[tuple]]
Connector = Callable[..., socket.socket]

# Sentinel: a host whose robots.txt imposes no restriction (absent or 4xx).
_ALLOW_ALL = "allow-all"


# -- resolved-address safety ----------------------------------------------------


class UnsafeAddressError(Exception):
    """A host resolved to an address that must not be connected to.

    Deliberately *not* an ``OSError`` or ``ValueError``: a transport failure is
    transient and worth retrying, whereas an address off the public internet is a
    deterministic refusal. Keeping the types disjoint stops one being mistaken for
    the other when the provider turns it into a typed ``ProviderError``.
    """


# The ranges that are not the public internet. Spelled out rather than delegated
# to ``ipaddress``'s ``is_private``, whose membership has shifted between releases
# (3.11 does not count CGNAT as private), because what is refused here must not
# depend on the interpreter's patch level.
_IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
_IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

_BLOCKED_NETWORKS: tuple[tuple[_IPNetwork, str], ...] = tuple(
    (ipaddress.ip_network(cidr), label)
    for cidr, label in (
        ("0.0.0.0/8", "unspecified/this-network"),
        ("10.0.0.0/8", "RFC1918 private"),
        ("100.64.0.0/10", "CGNAT"),
        ("127.0.0.0/8", "loopback"),
        ("169.254.0.0/16", "link-local"),
        ("172.16.0.0/12", "RFC1918 private"),
        ("192.0.0.0/24", "IETF protocol assignment"),
        ("192.168.0.0/16", "RFC1918 private"),
        ("198.18.0.0/15", "benchmarking"),
        ("224.0.0.0/4", "multicast"),
        ("240.0.0.0/4", "reserved"),
        ("::/128", "unspecified"),
        ("::1/128", "loopback"),
        ("fc00::/7", "unique-local"),
        ("fe80::/10", "link-local"),
        ("fec0::/10", "site-local"),
        ("ff00::/8", "multicast"),
    )
)

# IPv6 forms that carry an IPv4 destination inside them.
_NAT64_PREFIX = ipaddress.ip_network("64:ff9b::/96")


def _embedded_addresses(address: _IPAddress) -> tuple[_IPAddress, ...]:
    """The address itself plus any IPv4 address encoded inside an IPv6 one.

    ``::ffff:127.0.0.1`` (IPv4-mapped), ``2002:7f00:1::`` (6to4) and
    ``64:ff9b::7f00:1`` (NAT64) all reach 127.0.0.1 while matching no IPv4 range
    textually, so the address they carry is judged as well as the outer form.
    """
    if not isinstance(address, ipaddress.IPv6Address):
        return (address,)
    embedded = address.ipv4_mapped or address.sixtofour
    if embedded is None and address in _NAT64_PREFIX:
        embedded = ipaddress.IPv4Address(int(address) & 0xFFFF_FFFF)
    return (address,) if embedded is None else (address, embedded)


def address_safety_issue(address: str) -> str | None:
    """Why this literal address must not be fetched from, or ``None`` if it may be.

    Objective and range-based: no reputation, no allow-list. It answers only
    "is this on the public internet", which is what separates a real publisher
    from the loopback interface, a cloud metadata endpoint, or the LAN.
    """
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return f"{address!r} is not a usable IP address"
    candidates = _embedded_addresses(parsed)
    for candidate in candidates:
        for network, label in _BLOCKED_NETWORKS:
            if candidate.version == network.version and candidate in network:
                return f"{parsed} is in the {label} range {network}"
    for candidate in candidates:
        if not candidate.is_global:
            # Whatever else this interpreter knows is not globally reachable.
            return f"{parsed} is not a globally routable address"
    return None


def _as_ip_literal(host: str) -> _IPAddress | None:
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


def _pinned_endpoints(host: str, port: int, *, resolver: Resolver) -> tuple[tuple[int, str], ...]:
    """Resolve ``host`` **once** and refuse it unless every record is public.

    The addresses returned are the addresses the connection then dials, so the
    name is never looked up a second time between the check and the connection —
    which is the whole point: a low-TTL record cannot answer with a public address
    to a check and a private one to the socket.

    Every record is validated, not just the one that gets dialled. A name that
    answers with a mix of public and private addresses is the signature of a
    rebinding attempt, so the name is refused outright rather than reduced to its
    "good" answers. A host that is already an IP literal is checked as-is and
    never resolved at all.
    """
    literal = _as_ip_literal(host)
    if literal is not None:
        family = socket.AF_INET6 if literal.version == 6 else socket.AF_INET
        endpoints: tuple[tuple[int, str], ...] = ((family, str(literal)),)
    else:
        seen: dict[tuple[int, str], None] = {}
        for info in resolver(host, port, 0, socket.SOCK_STREAM):
            seen.setdefault((info[0], info[4][0]), None)
        endpoints = tuple(seen)
    if not endpoints:
        raise OSError(f"{host} resolved to no addresses")
    for _family, address in endpoints:
        issue = address_safety_issue(address)
        if issue is not None:
            raise UnsafeAddressError(
                f"{host} resolves to an address that must not be reached: {issue}"
            )
    return endpoints


# -- the real transport ---------------------------------------------------------


def _default_ssl_context() -> ssl.SSLContext:
    """A fully verifying TLS context: certificate chain *and* hostname checked.

    Pinning the address must not be paid for in authentication. Nothing here
    relaxes verification, and the certificate is matched against the hostname
    from the URL rather than the address dialled — trading SSRF for a
    machine-in-the-middle would be no trade at all.
    """
    context = ssl.create_default_context()
    context.set_alpn_protocols(["http/1.1"])
    return context


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """An HTTPS connection that dials a pre-validated address, not a name.

    ``connect`` resolves nothing: it dials one of the addresses already checked by
    `_pinned_endpoints`, so the address that was verified is the address reached.
    TLS still verifies the *name* — SNI and the certificate check both use the
    hostname from the URL — and the ``Host`` header is the hostname too, so
    pinning is invisible to the server and to certificate validation.
    """

    def __init__(self, host: str, *, connector: Connector, **kwargs: object) -> None:
        super().__init__(host, **kwargs)  # type: ignore[arg-type]
        self._connector = connector
        self._endpoints: tuple[tuple[int, str], ...] = ()

    def pin_to(self, endpoints: tuple[tuple[int, str], ...]) -> None:
        self._endpoints = endpoints

    def connect(self) -> None:
        self.sock = self._dial()
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, True)
        if self._tunnel_host:
            self._tunnel()
            server_hostname = self._tunnel_host
        else:
            server_hostname = self.host
        self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname)

    def _dial(self) -> socket.socket:
        """Try each validated address in turn; never anything else."""
        failures: list[str] = []
        for _family, address in self._endpoints:
            try:
                # A numeric address is never a DNS lookup, so the pin holds.
                return self._connector((address, self.port), self.timeout, self.source_address)
            except OSError as error:
                failures.append(f"{address}: {error}")
        raise OSError(
            f"could not connect to any validated address for {self.host}: "
            f"{'; '.join(failures) or 'no validated address'}"
        )


class _PinnedHTTPSHandler(urllib_request.HTTPSHandler):
    """Makes ``urllib`` open every HTTPS connection through the pinned path."""

    def __init__(
        self, *, resolver: Resolver, connector: Connector, ssl_context: ssl.SSLContext
    ) -> None:
        super().__init__(context=ssl_context)
        self._resolver = resolver
        self._connector = connector

    def https_open(self, req):  # noqa: ANN001, D102
        return self.do_open(self._new_connection, req, context=self._context)

    def _new_connection(self, host: str, **kwargs: object) -> _PinnedHTTPSConnection:
        connection = _PinnedHTTPSConnection(host, connector=self._connector, **kwargs)
        # Resolve and validate here, before the connection is used: an unsafe
        # address raises without a socket ever being opened.
        connection.pin_to(
            _pinned_endpoints(connection.host, connection.port, resolver=self._resolver)
        )
        return connection


class _NoRedirect(urllib_request.HTTPRedirectHandler):
    """Return the 3xx instead of following it, so hops can be re-validated."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def build_default_opener(
    *,
    resolver: Resolver | None = None,
    connector: Connector | None = None,
    ssl_context: ssl.SSLContext | None = None,
) -> Opener:
    """Build the real transport: HTTPS to a resolved, validated, pinned address.

    Address safety is enforced *here*, at the connection, rather than in the
    provider: that is the only place the address checked can be guaranteed to be
    the address dialled. It therefore applies to every request the provider makes
    — each redirect hop and each robots.txt fetch is a separate open, so each one
    resolves and validates again.

    ``resolver`` and ``connector`` exist so this path is testable with no DNS and
    no socket; both default to the stdlib.
    """
    opener = urllib_request.build_opener(
        _NoRedirect,
        _PinnedHTTPSHandler(
            resolver=resolver or socket.getaddrinfo,
            connector=connector or socket.create_connection,
            ssl_context=ssl_context or _default_ssl_context(),
        ),
    )

    def open_url(
        url: str, *, headers: Mapping[str, str], timeout: float, max_bytes: int
    ) -> HttpResponse:
        """Real HTTP via ``urllib``, reading at most ``max_bytes`` + 1 bytes.

        Redirects are not followed (the no-redirect opener returns the 3xx). HTTP
        error statuses are returned as data too, so the caller — not ``urllib`` —
        decides what a 404 or a 503 means.
        """
        request = urllib_request.Request(url, method="GET", headers=dict(headers))
        try:
            with opener.open(request, timeout=timeout) as response:
                body = response.read(max_bytes + 1)
                return HttpResponse(
                    url=response.geturl(),
                    status=int(getattr(response, "status", 200) or 200),
                    headers=dict(response.headers.items()),
                    body=body,
                )
        except urllib_error.HTTPError as http_error:
            body = http_error.read(max_bytes + 1) if hasattr(http_error, "read") else b""
            error_headers = dict(http_error.headers.items()) if http_error.headers else {}
            return HttpResponse(
                url=http_error.geturl() or url,
                status=int(http_error.code),
                headers=error_headers,
                body=body,
            )

    return open_url


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
        self._opener = opener or build_default_opener()
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
        except UnsafeAddressError as error:
            # The name resolved off the public internet. Deterministic, not
            # transient: retrying would only repeat the same refusal.
            raise ProviderError(
                f"refusing to fetch {url}: {error}",
                provider=self.name,
                retryable=False,
            ) from error
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
        # These are the same lexical checks the `url-safety` gate applies, and they
        # are retained in full. What a URL *says* is only half of it, though: the
        # address a name resolves to is checked separately, at the connection, by
        # the transport `build_default_opener` builds.

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
