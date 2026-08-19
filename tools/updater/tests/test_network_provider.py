"""The network source provider fetches real pages honestly — proven offline.

Every test here runs with an injected opener and no sockets, so the default suite
stays genuinely offline. The single live test is marked ``network`` and is
excluded from the default run by ``addopts`` in ``pyproject.toml``.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
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
    assert hasattr(discover, "__await__")
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
