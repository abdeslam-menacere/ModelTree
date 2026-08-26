"""Creator profiles load through one shared path, with real https source seeds.

These tests hold down the "one shared implementation, four profiles" rule: the four
creators differ only in version-controlled data, the loader has no per-creator branch,
and every trusted source seed is a secure, real-looking origin with verification
metadata. They never reach the network — a profile only *describes* a source.
"""

from __future__ import annotations

import ast
import json
import tokenize
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from modeltree_updater import longtail
from modeltree_updater.contracts import CreatorRequest, SourceKind
from modeltree_updater.profiles import (
    DEFAULT_PROFILES_DIR,
    ProfileError,
    _duplicate_key,
    _reviewed_profile_paths,
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
    """Which directory a *checkout* defaults to — when there is a checkout (#212).

    `DEFAULT_PROFILES_DIR` has been `Path | None` since #147 and is `None` in an
    installed distribution, which carries no reviewed profiles on purpose. The
    contract chosen here is to skip rather than to assert the `None` case: this
    test is about which directory a checkout picks, and an installed copy has no
    answer to that question rather than a wrong one. The installed case is
    already pinned on its own terms, against the layout check itself, in
    `test_installed_layout.py`. Before the guard this raised
    `AttributeError: 'NoneType' object has no attribute 'name'`, which named
    neither the constant nor the reason.
    """
    if DEFAULT_PROFILES_DIR is None:
        pytest.skip(
            "DEFAULT_PROFILES_DIR is None: running from an installed "
            "distribution, which ships no reviewed profiles (#147), so there is "
            "no versioned profiles directory for this test to check"
        )
    assert DEFAULT_PROFILES_DIR.name == "profiles"
    assert DEFAULT_PROFILES_DIR.is_dir()


# --------------------------------------------------------------------------
# Which files are the reviewed set, decided the same way on every platform
# --------------------------------------------------------------------------
# `glob("*.json")` is case-insensitive on Windows and case-sensitive on Linux, so
# `anthropic.JSON` was a reviewed creator profile on a developer machine and did not
# exist in CI. These are the *dedicated* profiles, so a file that is present locally
# and absent in CI silently downgrades a reviewed creator to generic handling. #108
# settled the rule for the long-tail set; this half of it is the same rule, applied by
# the same function, so the two sets cannot drift apart again. The duplicate check
# folds case with it; the *lookup* deliberately does not.


def _profile_document(creator_id: Any = "acme-labs") -> dict:
    """The smallest document `load_profile` accepts, with a caller-chosen id."""
    return {
        "creator": {"id": creator_id, "name": "Acme Labs"},
        "source_catalog": [
            {
                "id": "acme-blog",
                "owner": "Acme Labs",
                "url": "https://acme.example/blog/",
                "kind": "official-announcement",
            }
        ],
    }


def _profile_file(path: Path, creator_id: Any = "acme-labs") -> Path:
    path.write_text(json.dumps(_profile_document(creator_id)), encoding="utf-8")
    return path


def test_an_uppercase_json_extension_is_refused_rather_than_silently_skipped(
    tmp_path,
) -> None:
    """The local-versus-CI divergence, turned into a sentence that names the file.

    Matching lowercase alone would make the platforms agree, but agree on *silence*:
    the contributor still has a file that is not a profile and still no reason why.
    A name differing from `.json` only in case is a file someone plainly meant as a
    profile, so it is refused out loud, at load, before anything is fetched.
    """
    _profile_file(tmp_path / "profile.json")
    _profile_file(tmp_path / "extra.JSON", creator_id="acme-labs-research")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "extra.JSON" in message
    assert "'.json' exactly" in message
    assert "rename the file" in message


def test_a_file_that_is_not_json_at_all_is_still_ignored(tmp_path) -> None:
    """The accept side, and the proof that the refusal above stays narrow.

    A neighbour that is not JSON at all is ignored exactly as before. Only a file
    whose extension *is* `.json` under case folding, without being `.json`, trips it.
    """
    _profile_file(tmp_path / "profile.json")
    (tmp_path / "notes.txt").write_text("not a profile", encoding="utf-8")
    (tmp_path / "README.md").write_text("# not a profile", encoding="utf-8")
    (tmp_path / "LICENSE").write_text("not a profile", encoding="utf-8")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_a_dotfile_is_not_a_reviewed_creator_profile(tmp_path) -> None:
    """A name beginning with a dot says "not part of the working set"; that is honoured."""
    _profile_file(tmp_path / "profile.json")
    _profile_file(tmp_path / ".hidden.json", creator_id="acme-labs-hidden")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_the_same_document_without_the_leading_dot_is_a_reviewed_profile(
    tmp_path,
) -> None:
    """The accept side: the dot is the whole reason, not the contents."""
    _profile_file(tmp_path / "profile.json")
    _profile_file(tmp_path / "hidden.json", creator_id="acme-labs-hidden")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("acme-labs", "acme-labs-hidden")


def test_a_directory_named_like_a_profile_is_not_read_as_one(tmp_path) -> None:
    """A directory was never a document, so it is neither parsed nor refused.

    It matters here and not only in the abstract: the shipped profiles directory has
    a `generic/` subdirectory in it, so "everything in this directory" has to mean
    files. Handing a directory to the parser produced an unreadable-file error that
    said nothing about the real problem.
    """
    _profile_file(tmp_path / "profile.json")
    (tmp_path / "archive.json").mkdir()

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_two_creator_ids_differing_only_in_case_are_one_id(tmp_path) -> None:
    """The duplicate check exists so nobody reasons about which document won.

    Two ids a reader would call the same name defeat that intent, so they collide
    here. The refusal names both files and both declared strings, because "duplicate"
    is otherwise baffling in front of two names that do not look alike.
    """
    _profile_file(tmp_path / "acme.json", creator_id="acme-labs")
    _profile_file(tmp_path / "other.json", creator_id="Acme-Labs")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "duplicate" in message
    assert "case" in message
    assert "acme.json" in message and "other.json" in message
    assert "'acme-labs'" in message and "'Acme-Labs'" in message


def test_two_creator_ids_differing_by_more_than_case_are_two_profiles(tmp_path) -> None:
    """Folding case refuses more; it must not refuse ids that are genuinely distinct."""
    _profile_file(tmp_path / "acme.json", creator_id="acme-labs")
    _profile_file(tmp_path / "other.json", creator_id="acme-labs-research")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("acme-labs", "acme-labs-research")


def test_two_documents_whose_ids_are_one_dict_key_are_refused(tmp_path) -> None:
    """Folding does not replace comparing the declared ids, so both are guarded.

    `True` and `1` fold to different strings while being the same dict key. Guarding
    on the folded key alone would miss the collision and then let the second document
    overwrite the first, leaving one entry in the library for two documents on disk
    with nothing said. The merge-base refused this pair through plain dict equality;
    this is the guard that keeps it refused. What such an id *should* be rejected for
    is a separate question, and not this change's.
    """
    _profile_file(tmp_path / "acme.json", creator_id=True)
    _profile_file(tmp_path / "other.json", creator_id=1)

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    assert "duplicate" in str(error.value)


def test_both_reviewed_sets_are_discovered_by_the_same_function() -> None:
    """The sharing is the fix, so it is pinned rather than left to convention.

    Two copies of this rule are what let the sets disagree about what a profile file
    is in the first place: #108 corrected one copy and the other kept the defect for
    as long as it took to notice. Re-copying it would restore exactly that.
    """
    assert longtail._reviewed_profile_paths is _reviewed_profile_paths
    assert longtail._duplicate_key is _duplicate_key
