"""Creator profiles load through one shared path, with real https source seeds.

These tests hold down the "one shared implementation, four profiles" rule: the four
creators differ only in version-controlled data, the loader has no per-creator branch,
and every trusted source seed is a secure, real-looking origin with verification
metadata. They never reach the network — a profile only *describes* a source.
"""

from __future__ import annotations

import ast
import tokenize
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from modeltree_updater.contracts import CreatorRequest, SourceKind
from modeltree_updater.profiles import (
    DEFAULT_PROFILES_DIR,
    ProfileError,
    load_profile,
    load_profile_library,
)

EXPECTED_CREATORS = {"openai", "anthropic", "google-deepmind", "meta"}
# The four creators are data, never a code path. No module in the package may steer on
# a specific creator id; the differences live in profiles/<id>.json.
SHARED_MODULES = ("profiles.py", "scout.py")


@pytest.fixture()
def library():
    return load_profile_library()


def test_the_four_creator_profiles_load_through_one_shared_path(library) -> None:
    assert set(library.creator_ids) == EXPECTED_CREATORS
    assert len(library) == 4


def test_every_trusted_source_seed_is_a_real_https_origin(library) -> None:
    for profile in library:
        assert profile.catalog, f"{profile.creator_id} has an empty source catalog"
        for source in profile.catalog:
            parts = urlsplit(source.url)
            assert parts.scheme == "https", f"{source.id} is not https: {source.url}"
            # A real public origin: a dotted host, no credentials, no bare localhost.
            assert parts.hostname and "." in parts.hostname
            assert "@" not in source.url
            assert isinstance(source.kind, SourceKind)


def test_every_seed_carries_owner_and_verification_metadata(library) -> None:
    for profile in library:
        for source in profile.catalog:
            assert source.owner, f"{source.id} has no owner"
            assert source.verified_at, f"{source.id} has no verification date"
            # Verification date is a real YYYY-MM-DD day.
            year, month, day = source.verified_at.split("-")
            assert len(year) == 4 and len(month) == 2 and len(day) == 2


def test_profiles_record_terminology_naming_and_ambiguities(library) -> None:
    for profile in library:
        assert profile.terminology, f"{profile.creator_id} records no terminology"
        assert profile.naming_rules, f"{profile.creator_id} records no naming rules"
        # Ambiguities are recorded, not smoothed over: unknown/conflicting stay explicit.
        assert profile.ambiguities, f"{profile.creator_id} records no ambiguities"
        for ambiguity in profile.ambiguities:
            assert ambiguity.guidance


def test_creator_request_entry_urls_are_the_catalog_origins(library) -> None:
    for profile in library:
        request = profile.to_creator_request()
        assert isinstance(request, CreatorRequest)
        for url in request.entry_urls:
            assert profile.is_configured_origin(url)
        # Every configured origin is reachable from the request's entry urls.
        request_origins = {
            f"{urlsplit(u).scheme}://{urlsplit(u).hostname}" for u in request.entry_urls
        }
        assert profile.configured_origins <= request_origins


def test_trusted_source_lookup_respects_allowed_paths(library) -> None:
    openai = library["openai"]
    news = openai.trusted_source_for("https://openai.com/news/some-post")
    assert news is not None and news.id == "openai-news"
    # An origin OpenAI trusts, but a path its catalog does not admit, is not configured.
    assert openai.trusted_source_for("https://openai.com/careers") is None
    # An unrelated origin is not trusted at all.
    assert openai.trusted_source_for("https://example.com/openai") is None


def test_no_module_branches_on_a_specific_creator_id() -> None:
    # A per-creator branch needs the creator id as a *standalone* string literal
    # (e.g. ``creator == "openai"``). We flag a STRING token only when its evaluated
    # value equals a creator id exactly, so a docstring that merely mentions the
    # forbidden pattern as a counter-example is not a false positive.
    src = Path(__file__).resolve().parent.parent / "src" / "modeltree_updater"
    for name in SHARED_MODULES:
        path = src / name
        with tokenize.open(path) as handle:
            for token in tokenize.generate_tokens(handle.readline):
                if token.type != tokenize.STRING:
                    continue
                try:
                    value = ast.literal_eval(token.string)
                except (ValueError, SyntaxError):
                    continue
                assert value not in EXPECTED_CREATORS, (
                    f"{name} uses creator id {value!r} as a string literal; "
                    "profiles must stay data, not a code branch"
                )


def test_a_malformed_profile_fails_loudly(tmp_path) -> None:
    bad = tmp_path / "broken.json"
    bad.write_text('{"creator": {"id": "x", "name": "X"}}', encoding="utf-8")
    with pytest.raises(ProfileError):
        load_profile(bad)


def test_default_profiles_directory_is_the_versioned_one() -> None:
    assert DEFAULT_PROFILES_DIR.name == "profiles"
    assert DEFAULT_PROFILES_DIR.is_dir()
