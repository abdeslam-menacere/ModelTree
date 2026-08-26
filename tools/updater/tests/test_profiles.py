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
from modeltree_updater.providers import fixtures
from modeltree_updater.profiles import (
    DEFAULT_PROFILES_DIR,
    ProfileError,
    _DuplicateIdGuard,
    _duplicate_key,
    _id_difference,
    _refuse_padded_id,
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

    Object identity, not resemblance. The duplicate check is pinned through the guard
    rather than through `_duplicate_key`, because the guard is now what owns the whole
    decision — the fold key, both key spaces, the twin lookup and the wording. Pinning
    the key function alone would let a caller share the key and still re-decide what to
    do with it, which is the shape of the divergence this is here to prevent (#199).
    """
    assert longtail._reviewed_profile_paths is _reviewed_profile_paths
    assert longtail._DuplicateIdGuard is _DuplicateIdGuard
    assert longtail._refuse_padded_id is _refuse_padded_id


def test_all_three_loaders_share_the_one_duplicate_id_rule() -> None:
    """The fixtures loader is the third caller, and the one #199 was filed about.

    #151 factored the rule out for two sets and #172 brought the third in. A fourth
    ruleset is what #172 explicitly forbids, so all three are checked together here
    rather than pairwise in two files that could each pass while disagreeing.
    """
    for module in (longtail, fixtures):
        assert module._DuplicateIdGuard is _DuplicateIdGuard, module.__name__
        assert module._refuse_padded_id is _refuse_padded_id, module.__name__
        assert module._reviewed_profile_paths is _reviewed_profile_paths, module.__name__


# --------------------------------------------------------------------------
# Whitespace, and telling the truth about how two colliding ids differ (#199)
# --------------------------------------------------------------------------
# Two defects in the shared helper, fixed in the shared helper. It folded case and
# normalised type but ignored whitespace, so `acme` and ` acme` loaded as two entries
# — the silent-drop class the check exists to refuse. And it explained every collision
# it caught as ids that "differ only in case", which is false for `1` against `"1"`.
#
# The decision on whitespace, stated once here and implemented once in
# `_refuse_padded_id`: an id **padded** with leading or trailing whitespace is refused
# outright rather than folded, because every set is read by exact lookup and a padded
# id answers to a string nobody would type — folding would catch it only when a twin
# happened to exist, leaving the lone typo loaded and unreachable. An id with
# **internal** whitespace is folded, not refused: internal spacing may be deliberate,
# so refusing it would refuse documents nothing has said are wrong, while two ids
# differing only in how they space themselves are still one id to a reader.


def test_a_creator_id_padded_with_whitespace_is_refused_on_its_own(tmp_path) -> None:
    """The lone typo, which folding alone would never have caught.

    This is the case that decides "refuse" over "fold". With one such file in the
    directory there is no twin to collide with, so a fold-only fix leaves it loaded
    under an id no caller will ever ask for. The refusal names the file and the string.
    """
    _profile_file(tmp_path / "acme.json", creator_id=" acme-labs")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "whitespace" in message
    assert "acme.json" in message
    assert "' acme-labs'" in message


def test_a_padded_creator_id_is_refused_rather_than_registered_stripped(
    tmp_path,
) -> None:
    """Stripping is the tempting fix and is worse than either alternative.

    It would register the document under a string the JSON does not contain, so a
    reader could no longer tell which id resolves. The refusal cannot change what any
    well-formed id resolves to, and the same file loads once the padding is removed.
    """
    padded = _profile_file(tmp_path / "acme.json", creator_id=" acme-labs ")

    with pytest.raises(ProfileError):
        load_profile(padded)

    _profile_file(padded, creator_id="acme-labs")
    assert load_profile(padded).creator_id == "acme-labs"


def test_two_ids_differing_only_in_padding_cannot_both_load(tmp_path) -> None:
    """The reported defect: `acme` and ` acme` folded apart and both loaded.

    At the merge base this directory produced a two-entry library, which is the silent
    drop the duplicate check exists to refuse — one of the two documents is keyed on a
    string that nothing downstream asks for. Refused now, in either file ordering.
    """
    _profile_file(tmp_path / "acme.json", creator_id="acme-labs")
    _profile_file(tmp_path / "other.json", creator_id=" acme-labs")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    assert "whitespace" in str(error.value)


def test_two_ids_differing_only_in_internal_spacing_are_one_id(tmp_path) -> None:
    """Internal whitespace is folded rather than refused, so this is a collision.

    `acme labs` and `acme  labs` are one id to a reader and two keys to a dict. The
    refusal says whitespace, not case, because case is not what is wrong here.
    """
    _profile_file(tmp_path / "acme.json", creator_id="acme labs")
    _profile_file(tmp_path / "other.json", creator_id="acme  labs")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "duplicate creator id" in message
    assert "whitespace" in message
    assert "case" not in message
    assert "acme.json" in message and "other.json" in message


def test_a_non_breaking_space_does_not_hide_a_duplicate_id(tmp_path) -> None:
    """The worst version of the defect: two ids that are identical to the eye.

    `acme\u00a0labs` and `acme labs` differ by one invisible byte, so no reviewer reading
    the diff can tell them apart. Both orderings are checked, because which document
    is seen first decides which one the guard has to reach back for.
    """
    for index, (first, second) in enumerate(
        (("acme labs", "acme\u00a0labs"), ("acme\u00a0labs", "acme labs"))
    ):
        directory = tmp_path / f"order-{index}"
        directory.mkdir()
        _profile_file(directory / "a.json", creator_id=first)
        _profile_file(directory / "b.json", creator_id=second)

        with pytest.raises(ProfileError) as error:
            load_profile_library(directory)

        message = str(error.value)
        assert "whitespace" in message
        assert "a.json" in message and "b.json" in message


def test_a_zero_width_space_is_left_alone_as_a_real_difference(tmp_path) -> None:
    """The stated limit of the fold, pinned so that widening it is a decision.

    A zero-width space is not whitespace to Python and is not normalised here. Folding
    may only ever grow what is refused, and guessing at invisible characters one at a
    time is how that would start shrinking instead — so these stay two ids until
    something says otherwise.
    """
    _profile_file(tmp_path / "acme.json", creator_id="acme\u200blabs")
    _profile_file(tmp_path / "other.json", creator_id="acmelabs")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("acmelabs", "acme\u200blabs")


def test_a_type_collision_is_not_reported_as_a_case_collision(tmp_path) -> None:
    """The message-only defect, and the reason it was worth fixing anyway.

    `1` and `"1"` differ in type, not case. Told they differ only in case, an operator
    goes looking for a capitalisation problem in a file whose actual problem is that
    JSON gave them a number — and the message is their entire diagnosis.
    """
    _profile_file(tmp_path / "acme.json", creator_id=1)
    _profile_file(tmp_path / "other.json", creator_id="1")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "differing only in type" in message
    assert "case" not in message


def test_an_id_differing_in_both_type_and_case_is_described_as_both(tmp_path) -> None:
    """`True` against `"true"` really does differ in both, so both are named.

    Each difference is judged on its own rather than one label being picked for the
    whole collision, which is what made the old wording false as soon as more than one
    kind of difference existed.
    """
    _profile_file(tmp_path / "acme.json", creator_id=True)
    _profile_file(tmp_path / "other.json", creator_id="true")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    assert "differing only in type and case" in str(error.value)


def test_two_documents_declaring_the_very_same_id_claim_no_difference(tmp_path) -> None:
    """Silence is the honest answer when there is nothing to say beyond "duplicate".

    The clause is added only when a difference can be named. Two files declaring
    `acme-labs` differ in nothing, so the refusal explains why one id may not name two
    documents and invents no distinction between them.
    """
    _profile_file(tmp_path / "acme.json", creator_id="acme-labs")
    _profile_file(tmp_path / "other.json", creator_id="acme-labs")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "duplicate creator id" in message
    assert "differing only in" not in message


def test_every_ordering_of_a_colliding_pair_names_both_documents(tmp_path) -> None:
    """The `KeyError` #108's remedy raised while reaching for the twin, pinned shut.

    A collision may be found through the folded key or through the declared id, and
    which one fires depends on the order the files are read in. The guard records
    every id under both key spaces and finds the twin with the same lookup that
    detected the collision, so no ordering can report a duplicate it cannot then name.
    """
    pairs = (
        ("acme-labs", "Acme-Labs"),
        (1, "1"),
        (True, "true"),
        (None, "none"),
        (True, 1),
        ("acme labs", "acme  labs"),
        ("acme-labs", "acme-labs"),
    )
    for index, (left, right) in enumerate(pairs):
        for order, (first, second) in enumerate(((left, right), (right, left))):
            directory = tmp_path / f"pair-{index}-{order}"
            directory.mkdir()
            _profile_file(directory / "a.json", creator_id=first)
            _profile_file(directory / "b.json", creator_id=second)

            with pytest.raises(ProfileError) as error:
                load_profile_library(directory)

            message = str(error.value)
            assert "duplicate creator id" in message, message
            assert "a.json" in message and "b.json" in message, message
            assert repr(first) in message and repr(second) in message, message


def test_the_fold_refuses_strictly_more_than_the_case_only_fold_it_replaced() -> None:
    """The property two prior fixes in this area each broke, pinned as a property.

    Both defects were fixed by *widening*, and widening is only safe if it is monotone.
    `_duplicate_key` is a composition of steps that each remove a distinction, so any
    two ids the merge base's `str(id).casefold()` brought together are still brought
    together — this walks the table rather than trusting the argument.
    """
    inputs = (
        "acme-labs",
        "Acme-Labs",
        "ACME-LABS",
        "acme labs",
        "acme  labs",
        "acme\u00a0labs",
        " acme-labs",
        "acme-labs ",
        "\tacme-labs",
        "acme\u200blabs",
        "stra\u00dfe",
        "STRASSE",
        "",
        "   ",
        1,
        "1",
        True,
        "true",
        "True",
        None,
        "none",
        1.0,
        0,
        False,
    )
    for left in inputs:
        for right in inputs:
            if str(left).casefold() == str(right).casefold():
                assert _duplicate_key(left) == _duplicate_key(right), (left, right)


def test_folding_whitespace_does_not_widen_what_an_id_matches(tmp_path) -> None:
    """The pin that matters most, restated for the whitespace fold.

    Widening what is *refused* is monotone and safe; widening what an id *matches* is
    not, and would resolve ids that should be unknown — a silent success in place of a
    loud refusal, which is this defect class pointed the other way (#94, ADR 0002).
    """
    _profile_file(tmp_path / "acme.json", creator_id="Acme-Labs")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("Acme-Labs",)
    for near_miss in ("acme-labs", " Acme-Labs", "Acme-Labs ", "Acme Labs"):
        assert near_miss not in library.profiles
        with pytest.raises(ProfileError):
            library[near_miss]
    assert library["Acme-Labs"].creator_id == "Acme-Labs"


def test_a_difference_is_named_only_when_there_is_one() -> None:
    """The classifier, exercised directly, because it is what the wording rests on."""
    assert _id_difference("acme", "acme") == ""
    assert _id_difference("acme", "ACME") == "case"
    assert _id_difference(1, "1") == "type"
    assert _id_difference(True, 1) == "type"
    assert _id_difference(None, "None") == "type"
    assert _id_difference(True, "true") == "type and case"
    assert _id_difference("acme labs", "acme  labs") == "whitespace"
    assert _id_difference("Acme Labs", "acme  labs") == "whitespace and case"
