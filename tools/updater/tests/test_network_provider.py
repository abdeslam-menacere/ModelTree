"""The network source provider fetches real pages honestly — proven offline.

No test here opens a socket or consults DNS. Most run with an injected opener;
the resolved-address tests run the *real* transport with the resolver and the
connector injected, so the code that resolves, validates and pins an address is
itself under test rather than stubbed past. The single live test is marked
``network`` and is excluded from the default run by ``addopts`` in
``pyproject.toml``.
"""

from __future__ import annotations

import asyncio
import inspect
import io
import ipaddress
import socket
import ssl
from datetime import datetime, timezone
from typing import Sequence
from urllib import error as urllib_error

import pytest

from modeltree_updater.contracts import (
    CreatorRequest,
    SourceCandidate,
    SourceKind,
    content_hash_bytes,
)
from modeltree_updater.providers.base import ProviderError, SourceProvider
from modeltree_updater.providers.network import (
    DEFAULT_USER_AGENT,
    HttpResponse,
    NetworkSourceProvider,
    UnsafeAddressError,
    _default_ssl_context,
    _pinned_endpoints,
    address_safety_issue,
    build_default_opener,
)

FIXED_NOW = datetime(2026, 6, 1, 12, 30, 0, tzinfo=timezone.utc)


class FakeHttp:
    """Programmable, no-redirect opener. Records the URLs it was asked to fetch."""

    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    def __call__(self, url, *, headers, timeout, max_bytes):  # noqa: ANN001
        self.calls.append(url)
        self.last_headers = headers
        if url.endswith("/robots.txt") and url not in self.responses:
            # Absent robots.txt: 404 means no restrictions.
            return HttpResponse(url=url, status=404, headers={}, body=b"")
        item = self.responses[url]
        if isinstance(item, list):
            item = item.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _ok(url: str, body: bytes, content_type: str = "text/html; charset=utf-8") -> HttpResponse:
    return HttpResponse(url=url, status=200, headers={"Content-Type": content_type}, body=body)


def _provider(responses: dict[str, object], **kwargs) -> tuple[NetworkSourceProvider, FakeHttp]:
    http = FakeHttp(responses)
    provider = NetworkSourceProvider(
        opener=http,
        now=lambda: FIXED_NOW,
        min_host_interval=0.0,
        **kwargs,
    )
    return provider, http


def _candidate(url: str) -> SourceCandidate:
    return SourceCandidate(
        id="net-test",
        creator_id="creator",
        url=url,
        title=url,
        publisher="example.com",
        kind=SourceKind.OFFICIAL_DOCS,
        discovered_at=FIXED_NOW.isoformat(),
    )


def _run(coro):
    return asyncio.run(coro)


# -- protocol conformance -------------------------------------------------------


def test_it_satisfies_the_source_provider_protocol() -> None:
    provider, _ = _provider({})
    assert isinstance(provider, SourceProvider)
    assert provider.name == "network:sources"


def test_provider_methods_return_awaitables() -> None:
    provider, _ = _provider({})
    creator = CreatorRequest(creator_id="c", creator_name="C", entry_urls=())
    discover = provider.discover(creator, limit=1)
    assert inspect.isawaitable(discover)
    _run(discover)


# -- discovery ------------------------------------------------------------------


def test_discover_turns_seed_urls_into_candidates_without_network() -> None:
    provider, http = _provider({})
    creator = CreatorRequest(
        creator_id="acme",
        creator_name="Acme",
        entry_urls=("https://acme.example/a", "https://acme.example/b"),
    )
    candidates = _run(provider.discover(creator, limit=5))

    assert http.calls == []  # discovery touches nothing
    assert [c.url for c in candidates] == ["https://acme.example/a", "https://acme.example/b"]
    assert all(c.creator_id == "acme" for c in candidates)
    assert candidates[0].publisher == "acme.example"
    assert candidates[0].discovered_at == FIXED_NOW.isoformat()


def test_discover_respects_the_limit_and_yields_stable_ids() -> None:
    provider, _ = _provider({})
    creator = CreatorRequest(
        creator_id="acme",
        creator_name="Acme",
        entry_urls=("https://acme.example/a", "https://acme.example/b", "https://acme.example/c"),
    )
    first = _run(provider.discover(creator, limit=2))
    again = _run(provider.discover(creator, limit=2))

    assert len(first) == 2
    assert [c.id for c in first] == [c.id for c in again]  # deterministic


# -- fetch and hashing ----------------------------------------------------------


def test_fetch_hashes_the_exact_bytes_and_extracts_text() -> None:
    url = "https://example.com/page"
    body = b"<html><body><h1>Title</h1><script>ignore()</script><p>Body</p></body></html>"
    provider, http = _provider({url: _ok(url, body)})

    page = _run(provider.fetch(_candidate(url)))

    assert page.content_hash == content_hash_bytes(body)
    assert page.retrieved_at == FIXED_NOW.isoformat()
    assert "Title" in page.text and "Body" in page.text
    assert "ignore" not in page.text  # script contents dropped
    assert "https://example.com/robots.txt" in http.calls


def test_a_second_fetch_of_unchanged_bytes_reproduces_the_hash() -> None:
    url = "https://example.com/page"
    body = b"<html><body>same bytes</body></html>"
    provider, _ = _provider({url: [_ok(url, body), _ok(url, body)]})

    first = _run(provider.fetch(_candidate(url)))
    second = _run(provider.fetch(_candidate(url)))

    assert first.content_hash == second.content_hash


def test_changed_bytes_change_the_hash() -> None:
    url = "https://example.com/page"
    provider, _ = _provider(
        {url: [_ok(url, b"<html>one</html>"), _ok(url, b"<html>two</html>")]}
    )

    first = _run(provider.fetch(_candidate(url)))
    second = _run(provider.fetch(_candidate(url)))

    assert first.content_hash != second.content_hash


def test_plain_text_is_kept_verbatim() -> None:
    url = "https://example.com/robots-like"
    body = b"line one\nline two"
    provider, _ = _provider({url: _ok(url, body, content_type="text/plain")})

    page = _run(provider.fetch(_candidate(url)))

    assert "line one" in page.text and "line two" in page.text
    assert page.content_hash == content_hash_bytes(body)


# -- content-type and size handling --------------------------------------------


def test_unsupported_content_type_is_a_non_retryable_failure() -> None:
    url = "https://example.com/report.pdf"
    provider, _ = _provider({url: _ok(url, b"%PDF-1.7", content_type="application/pdf")})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False
    assert excinfo.value.provider == "network:sources"


def test_an_oversized_body_is_refused() -> None:
    url = "https://example.com/big"
    provider, _ = _provider({url: _ok(url, b"x" * 50)}, max_bytes=10)

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False


# -- URL safety (SSRF) enforced before any request -----------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/",  # not https
        "https://localhost/",  # loopback
        "https://127.0.0.1/",  # bare IP
        "https://user:pw@example.com/",  # embedded credentials
    ],
)
def test_unsafe_urls_are_refused_without_a_request(url: str) -> None:
    provider, http = _provider({})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False
    assert http.calls == []  # nothing was fetched


# -- resolved-address safety (DNS rebinding) ------------------------------------
#
# A URL is only a name, so the tests above prove nothing about where a *public*
# hostname actually points. These exercise the real transport — the one built by
# `build_default_opener` and used in production — with DNS and the socket
# injected, so the resolve/validate/pin path itself is under test with no network.


class FakeResolver:
    """A ``socket.getaddrinfo`` stand-in: the records DNS would hand back."""

    def __init__(self, records: dict[str, list[str]]) -> None:
        self.records = records
        self.calls: list[tuple[str, int]] = []

    def __call__(self, host, port, *args, **kwargs):  # noqa: ANN001, ANN204
        self.calls.append((host, port))
        addresses = self.records.get(host)
        if addresses is None:
            raise socket.gaierror(f"no records for {host}")
        infos = []
        for text in addresses:
            parsed = ipaddress.ip_address(text)
            if parsed.version == 6:
                infos.append((socket.AF_INET6, socket.SOCK_STREAM, 6, "", (text, port, 0, 0)))
            else:
                infos.append((socket.AF_INET, socket.SOCK_STREAM, 6, "", (text, port)))
        return infos


class FakeSocket:
    """Replays one canned HTTP response and records what was written to it."""

    def __init__(self, response: bytes) -> None:
        self.response = response
        self.sent = b""

    def setsockopt(self, *args: object) -> None:
        return None

    def sendall(self, data: object) -> None:
        self.sent += bytes(data)  # type: ignore[arg-type]

    def makefile(self, mode: str = "rb", *args: object, **kwargs: object) -> io.BytesIO:
        return io.BytesIO(self.response)

    def close(self) -> None:
        return None


class RecordingConnector:
    """A ``socket.create_connection`` stand-in that records every dial attempt.

    Recording the *address* is what makes "refused before any connection" an
    assertion about behaviour rather than about the error message: an empty
    ``calls`` list means no socket was ever opened.
    """

    def __init__(self, responses: Sequence[bytes] = ()) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, int]] = []
        self.sockets: list[FakeSocket] = []

    def __call__(self, address, timeout=None, source_address=None):  # noqa: ANN001, ANN204
        self.calls.append(address)
        if not self.responses:
            raise OSError(f"no scripted response for {address}")
        sock = FakeSocket(self.responses.pop(0))
        self.sockets.append(sock)
        return sock


class RecordingTLS:
    """Stands in for an ``ssl.SSLContext``, recording the SNI name it was given.

    It verifies nothing — it cannot, against a fake socket — but it records the
    ``server_hostname`` so the tests can prove the *name* is still what TLS is
    asked to authenticate, even though the *address* is pinned.
    """

    check_hostname = True
    verify_mode = ssl.CERT_REQUIRED

    def __init__(self) -> None:
        self.server_hostnames: list[str | None] = []

    def wrap_socket(self, sock: FakeSocket, *, server_hostname: str | None = None) -> FakeSocket:
        self.server_hostnames.append(server_hostname)
        return sock


def _raw(status: str, headers: dict[str, str] | None = None, body: bytes = b"") -> bytes:
    head = f"HTTP/1.1 {status}\r\n"
    head += "".join(f"{key}: {value}\r\n" for key, value in (headers or {}).items())
    head += f"Content-Length: {len(body)}\r\n\r\n"
    return head.encode("ascii") + body


def _pinned_provider(
    records: dict[str, list[str]], responses: Sequence[bytes] = (), **kwargs: object
) -> tuple[NetworkSourceProvider, FakeResolver, RecordingConnector, RecordingTLS]:
    resolver = FakeResolver(records)
    connector = RecordingConnector(responses)
    tls = RecordingTLS()
    provider = NetworkSourceProvider(
        opener=build_default_opener(resolver=resolver, connector=connector, ssl_context=tls),
        now=lambda: FIXED_NOW,
        min_host_interval=0.0,
        respect_robots=bool(kwargs.pop("respect_robots", False)),
        **kwargs,  # type: ignore[arg-type]
    )
    return provider, resolver, connector, tls


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",  # loopback
        "169.254.169.254",  # link-local: the cloud metadata endpoint
        "10.0.0.5",  # RFC1918
        "172.16.0.1",  # RFC1918
        "192.168.1.1",  # RFC1918
        "100.64.0.1",  # CGNAT
        "0.0.0.0",  # unspecified
        "224.0.0.1",  # multicast
        "255.255.255.255",  # broadcast/reserved
        "::1",  # IPv6 loopback
        "::",  # IPv6 unspecified
        "fe80::1",  # IPv6 link-local
        "fc00::1",  # IPv6 unique-local
        "ff02::1",  # IPv6 multicast
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
        "2002:7f00:1::1",  # 6to4-encoded loopback
        "64:ff9b::a00:1",  # NAT64-encoded RFC1918
    ],
)
def test_addresses_off_the_public_internet_are_refused(address: str) -> None:
    assert address_safety_issue(address) is not None


@pytest.mark.parametrize(
    "address",
    ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"],
)
def test_genuinely_public_addresses_are_allowed(address: str) -> None:
    assert address_safety_issue(address) is None


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "169.254.169.254", "10.0.0.5"],
)
def test_a_name_resolving_off_the_public_internet_is_refused_before_connecting(
    address: str,
) -> None:
    provider, resolver, connector, _ = _pinned_provider({"rebind.example": [address]})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate("https://rebind.example/page")))

    assert excinfo.value.retryable is False  # deterministic, not worth a retry
    assert excinfo.value.provider == "network:sources"
    assert address in str(excinfo.value)
    assert resolver.calls == [("rebind.example", 443)]  # the name was looked up
    assert connector.calls == []  # and no socket was ever opened


def test_every_resolved_record_is_validated_not_only_the_first() -> None:
    """A name answering with one public and one private record is refused whole."""
    provider, _, connector, _ = _pinned_provider(
        {"mixed.example": ["93.184.216.34", "10.0.0.7"]},
        [_raw("200 OK", {"Content-Type": "text/html"}, b"<p>reachable</p>")],
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate("https://mixed.example/page")))

    assert excinfo.value.retryable is False
    assert "10.0.0.7" in str(excinfo.value)
    assert connector.calls == []  # not even the public record was dialled


def test_a_public_host_still_fetches_over_the_pinned_transport() -> None:
    body = b"<html><body><h1>Title</h1><p>Body</p></body></html>"
    provider, _, _, _ = _pinned_provider(
        {"example.com": ["93.184.216.34"]},
        [_raw("200 OK", {"Content-Type": "text/html; charset=utf-8"}, body)],
    )

    page = _run(provider.fetch(_candidate("https://example.com/page")))

    assert page.content_hash == content_hash_bytes(body)
    assert "Title" in page.text and "Body" in page.text


def test_the_connection_dials_the_validated_address_not_the_name() -> None:
    """The TOCTOU close: one lookup, and the socket goes to what was checked.

    If the hostname were handed to the socket layer it would be resolved a second
    time, and a low-TTL record could answer differently at connect than it did at
    check. The connector therefore sees an address, never a name.
    """
    body = b"<html>ok</html>"
    provider, resolver, connector, tls = _pinned_provider(
        {"example.com": ["93.184.216.34"]},
        [_raw("200 OK", {"Content-Type": "text/html"}, body)],
    )

    _run(provider.fetch(_candidate("https://example.com/page")))

    assert connector.calls == [("93.184.216.34", 443)]
    assert resolver.calls == [("example.com", 443)]  # resolved exactly once
    # Pinning the address costs nothing in authentication: TLS is still asked to
    # verify the certificate against the hostname, and the server still sees it.
    assert tls.server_hostnames == ["example.com"]
    assert b"Host: example.com\r\n" in connector.sockets[0].sent


def test_a_redirect_to_a_privately_resolving_host_is_refused() -> None:
    provider, _, connector, _ = _pinned_provider(
        {"example.com": ["93.184.216.34"], "internal.example": ["192.168.0.10"]},
        [_raw("302 Found", {"Location": "https://internal.example/admin"})],
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate("https://example.com/old")))

    assert excinfo.value.retryable is False
    assert "192.168.0.10" in str(excinfo.value)
    # The public first hop happened; the private second hop never opened a socket.
    assert connector.calls == [("93.184.216.34", 443)]


def test_the_robots_fetch_is_address_checked_too() -> None:
    provider, _, connector, _ = _pinned_provider(
        {"rebind.example": ["169.254.169.254"]}, respect_robots=True
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate("https://rebind.example/page")))

    assert excinfo.value.retryable is False
    assert "robots.txt" in str(excinfo.value)  # refused on the very first request
    assert connector.calls == []


def test_the_lexical_checks_still_run_and_precede_any_resolution() -> None:
    """The address check is added to the lexical checks, not swapped in for them."""
    provider, resolver, connector, _ = _pinned_provider({"example.com": ["93.184.216.34"]})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate("http://example.com/page")))  # not https

    assert excinfo.value.retryable is False
    assert "https" in str(excinfo.value)
    assert resolver.calls == []  # refused on the URL alone
    assert connector.calls == []


@pytest.mark.parametrize(
    ("host", "refused"),
    [("127.0.0.1", True), ("93.184.216.34", False)],
)
def test_an_ip_literal_host_is_checked_without_being_resolved(host: str, refused: bool) -> None:
    """Tested directly: the lexical checks refuse bare-IP URLs before this runs."""
    resolver = FakeResolver({})  # any lookup at all raises

    if refused:
        with pytest.raises(UnsafeAddressError):
            _pinned_endpoints(host, 443, resolver=resolver)
    else:
        assert _pinned_endpoints(host, 443, resolver=resolver) == (
            (socket.AF_INET, host),
        )
    assert resolver.calls == []


def test_a_resolution_failure_stays_a_retryable_failure() -> None:
    """DNS falling over is transient; it must not be reported as an unsafe host."""
    provider, _, connector, _ = _pinned_provider({})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate("https://nowhere.example/page")))

    assert excinfo.value.retryable is True
    assert connector.calls == []


def test_the_default_transport_verifies_certificates_and_hostnames() -> None:
    """Guards the trade this fix must not make: SSRF closed, MITM opened."""
    context = _default_ssl_context()

    assert context.check_hostname is True
    assert context.verify_mode is ssl.CERT_REQUIRED


# -- redirects ------------------------------------------------------------------


def _redirect(url: str, location: str, status: int = 302) -> HttpResponse:
    return HttpResponse(url=url, status=status, headers={"Location": location}, body=b"")


def test_a_redirect_is_followed_and_the_final_page_is_hashed() -> None:
    start = "https://example.com/old"
    dest = "https://example.com/new"
    body = b"<html>moved</html>"
    provider, _ = _provider({start: _redirect(start, dest), dest: _ok(dest, body)})

    page = _run(provider.fetch(_candidate(start)))

    assert page.content_hash == content_hash_bytes(body)


def test_a_redirect_to_a_private_host_is_refused() -> None:
    start = "https://example.com/old"
    provider, _ = _provider({start: _redirect(start, "https://127.0.0.1/internal")})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(start)))
    assert excinfo.value.retryable is False


def test_too_many_redirects_is_refused() -> None:
    url = "https://example.com/loop"
    provider, _ = _provider({url: _redirect(url, url)}, max_redirects=2)

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False


def test_a_redirect_without_a_location_is_refused() -> None:
    url = "https://example.com/broken"
    provider, _ = _provider({url: HttpResponse(url=url, status=302, headers={}, body=b"")})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False


# -- HTTP status → typed retryability ------------------------------------------


@pytest.mark.parametrize("status", [500, 503, 429])
def test_transient_status_codes_are_retryable(status: int) -> None:
    url = "https://example.com/page"
    provider, _ = _provider(
        {url: HttpResponse(url=url, status=status, headers={}, body=b"")}
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is True


@pytest.mark.parametrize("status", [400, 403, 404, 410])
def test_client_error_status_codes_are_not_retryable(status: int) -> None:
    url = "https://example.com/page"
    provider, _ = _provider(
        {url: HttpResponse(url=url, status=status, headers={}, body=b"")}
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False


def test_a_network_error_becomes_a_retryable_failure() -> None:
    url = "https://example.com/page"
    provider, _ = _provider({url: urllib_error.URLError("connection refused")})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is True


# -- robots.txt -----------------------------------------------------------------


def test_robots_disallow_blocks_the_fetch() -> None:
    url = "https://example.com/secret"
    robots = "https://example.com/robots.txt"
    provider, http = _provider(
        {
            robots: HttpResponse(
                url=robots,
                status=200,
                headers={"Content-Type": "text/plain"},
                body=b"User-agent: *\nDisallow: /secret",
            ),
            url: _ok(url, b"<html>secret</html>"),
        }
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False
    assert url not in http.calls  # the page itself was never requested


def test_robots_allow_permits_the_fetch() -> None:
    url = "https://example.com/public"
    robots = "https://example.com/robots.txt"
    body = b"<html>public</html>"
    provider, _ = _provider(
        {
            robots: HttpResponse(
                url=robots,
                status=200,
                headers={"Content-Type": "text/plain"},
                body=b"User-agent: *\nDisallow: /private",
            ),
            url: _ok(url, body),
        }
    )

    page = _run(provider.fetch(_candidate(url)))
    assert page.content_hash == content_hash_bytes(body)


def test_absent_robots_allows_the_fetch() -> None:
    url = "https://example.com/page"
    body = b"<html>ok</html>"
    provider, _ = _provider({url: _ok(url, body)})  # robots.txt defaults to 404

    page = _run(provider.fetch(_candidate(url)))
    assert page.content_hash == content_hash_bytes(body)


def test_unavailable_robots_is_retryable() -> None:
    url = "https://example.com/page"
    robots = "https://example.com/robots.txt"
    provider, _ = _provider(
        {
            robots: HttpResponse(url=robots, status=503, headers={}, body=b""),
            url: _ok(url, b"<html>ok</html>"),
        }
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is True


def test_robots_can_be_disabled() -> None:
    url = "https://example.com/secret"
    robots = "https://example.com/robots.txt"
    body = b"<html>secret</html>"
    http = FakeHttp(
        {
            robots: HttpResponse(
                url=robots,
                status=200,
                headers={"Content-Type": "text/plain"},
                body=b"User-agent: *\nDisallow: /",
            ),
            url: _ok(url, body),
        }
    )
    provider = NetworkSourceProvider(
        opener=http, now=lambda: FIXED_NOW, min_host_interval=0.0, respect_robots=False
    )

    page = _run(provider.fetch(_candidate(url)))
    assert page.content_hash == content_hash_bytes(body)
    assert robots not in http.calls  # robots not even consulted


def test_a_redirecting_robots_is_followed_not_read_as_allow_all() -> None:
    url = "https://example.com/secret"
    robots = "https://example.com/robots.txt"
    moved = "https://example.com/robots-final.txt"
    provider, _ = _provider(
        {
            robots: _redirect(robots, moved),
            moved: HttpResponse(
                url=moved,
                status=200,
                headers={"Content-Type": "text/plain"},
                body=b"User-agent: *\nDisallow: /secret",
            ),
            url: _ok(url, b"<html>secret</html>"),
        }
    )

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is False  # the disallow rule was honoured


def test_a_transport_exception_becomes_a_retryable_failure() -> None:
    import http.client

    url = "https://example.com/page"
    provider, _ = _provider({url: http.client.IncompleteRead(b"partial")})

    with pytest.raises(ProviderError) as excinfo:
        _run(provider.fetch(_candidate(url)))
    assert excinfo.value.retryable is True


# -- rate limiting and honest identification ------------------------------------


def test_requests_to_one_host_are_rate_limited() -> None:
    url = "https://example.com/page"
    sleeps: list[float] = []

    async def record_sleep(duration: float) -> None:
        sleeps.append(duration)

    http = FakeHttp({url: [_ok(url, b"<html>a</html>"), _ok(url, b"<html>b</html>")]})
    provider = NetworkSourceProvider(
        opener=http,
        now=lambda: FIXED_NOW,
        respect_robots=False,
        min_host_interval=2.0,
        clock=lambda: 100.0,
        sleep=record_sleep,
    )

    _run(provider.fetch(_candidate(url)))
    _run(provider.fetch(_candidate(url)))

    assert sleeps == [2.0]  # the second fetch waited a full interval


def test_the_client_identifies_itself_honestly() -> None:
    url = "https://example.com/page"
    provider, http = _provider({url: _ok(url, b"<html>ok</html>")}, respect_robots=False)

    _run(provider.fetch(_candidate(url)))

    assert http.last_headers["User-Agent"] == DEFAULT_USER_AGENT
    assert "ModelTree" in DEFAULT_USER_AGENT


# -- live network (opt-in) ------------------------------------------------------


@pytest.mark.network
def test_live_fetch_reproduces_its_content_hash() -> None:
    """Opt-in: reaches the real network. Excluded from the default offline run."""
    provider = NetworkSourceProvider(min_host_interval=0.0)
    creator = CreatorRequest(
        creator_id="example",
        creator_name="Example",
        entry_urls=("https://example.com/",),
    )
    candidates = _run(provider.discover(creator, limit=1))
    first = _run(provider.fetch(candidates[0]))
    second = _run(provider.fetch(candidates[0]))

    assert first.content_hash.startswith("sha256:")
    assert first.content_hash == second.content_hash
    assert first.text
