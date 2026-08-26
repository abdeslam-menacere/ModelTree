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


def test_a_non_string_creator_id_is_refused_at_parse_time(tmp_path) -> None:
    """A reviewed document declaring a non-string id refuses cleanly, not with a crash.

    An id that is not a string keys a profile under a value no string lookup can reach,
    and the id set is sorted to build both `creator_ids` and unrelated refusal messages —
    so a second such document of a different type would crash `sorted` while formatting
    someone else's error. `True` and `1` fold to different strings while being one dict
    key, which is why the merge-base met them at the duplicate guard; this reviewed set
    now refuses either one earlier, at parse, for the more basic reason that a non-string
    id is unreachable. The refusal names the file, the field, and the type found.

    What such an id should be for the *fixtures* set is a separate question and not this
    change's (#204). This is the reviewed-profile half of #136.
    """
    _profile_file(tmp_path / "acme.json", creator_id=True)

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "acme.json" in message
    assert "creator id must be a string" in message
    assert "bool" in message
    assert "TypeError" not in message


@pytest.mark.parametrize(
    "creator_id, type_name",
    [(["a"], "list"), ({}, "dict"), (0.0, "float"), (1, "int"), (None, "NoneType")],
)
def test_every_non_string_creator_id_shape_is_refused_by_the_real_loader(
    tmp_path, creator_id, type_name
) -> None:
    """Each unhashable and mixed-type shape #136 names, driven through the real loader.

    A `list`/`dict` id crashed at the duplicate guard's membership test; a `float`
    beside a `str` crashed `sorted(creator_ids)`. Refusing at parse means neither can
    form. Driving `load_profile_library`, not `_refuse_padded_id` in isolation, is what
    proves no operator-reachable path reaches the `TypeError`.
    """
    _profile_file(tmp_path / "acme.json", creator_id=creator_id)

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "creator id must be a string" in message
    assert type_name in message


def test_a_well_formed_string_creator_id_still_loads(tmp_path) -> None:
    """The accept side: the type gate refuses non-strings and nothing else."""
    _profile_file(tmp_path / "acme.json", creator_id="acme-labs")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_refuse_padded_id_requires_a_string_by_default(tmp_path) -> None:
    """The shared guard's default is the safe mode, so a caller opts *out*, not in (#204).

    This pins the decision directly at the helper rather than only through a loader. The
    fixtures loader shared this helper while leaving `require_string` at its previous
    default of `False`, and nothing flagged the omission — a safety helper whose default
    is the unsafe mode puts the burden on every caller to remember to opt in, and one
    did not, which is how that loader kept the `TypeError` #136 closed for the other two.
    Defaulting to `True` makes the omission safe: a non-string id passed with no
    `require_string` argument at all is now refused.
    """
    path = tmp_path / "acme.json"

    with pytest.raises(ProfileError) as error:
        _refuse_padded_id(True, path=path, subject="creator id")

    message = str(error.value)
    assert "creator id must be a string" in message
    assert "bool" in message


def test_refuse_padded_id_accepts_non_strings_only_on_explicit_opt_out(tmp_path) -> None:
    """`require_string=False` is the visible, deliberate opt-out that stays available.

    Flipping the default did not remove the ability to accept a non-string id; it made
    accepting one a choice a caller must state at its call site, where a reviewer can see
    it, rather than one inherited from a permissive default. No loader opts out, but the
    lever remains and returns the value unchanged when pulled.
    """
    path = tmp_path / "acme.json"

    assert _refuse_padded_id(True, path=path, subject="creator id", require_string=False) is True


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


def test_a_zero_width_space_is_left_alone_by_the_fold_but_refused_by_the_guard(
    tmp_path,
) -> None:
    """The #199 fold pin, updated for the #260 refusal that now precedes it.

    #199 pinned that `_duplicate_key` does not normalise a zero-width space -- it treats
    U+200B as a real difference rather than guessing at invisible characters. That is
    still true of the fold in isolation, and is asserted directly here. What changed is
    that #260 refuses a format-character id at the guard, before the fold is ever
    consulted, so a loader no longer loads two such ids as distinct: it refuses the one
    that carries the character, naming the codepoint. Both facts are pinned -- the fold's
    unchanged conservatism, and that a format-character id never reaches it through a
    loader.
    """
    assert _duplicate_key("acme\u200blabs") != _duplicate_key("acmelabs")

    _profile_file(tmp_path / "acme.json", creator_id="acme\u200blabs")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    assert "U+200B" in str(error.value)


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

    These are the string pairs that still reach the guard in this reviewed set. #136
    refuses a non-string reviewed id at parse, before the guard, so the pairs that used
    to fold apart while being one dict key — `(True, 1)` and the `1`/`True`/`None`
    collisions — are now met earlier; the guard's ordering-independence over *those*
    stays exercised by the fixtures set, which still admits non-string ids pending #204.
    """
    pairs = (
        ("acme-labs", "Acme-Labs"),
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


# --------------------------------------------------------------------------
# Empty, zero-width and bidi-override ids (#260)
# --------------------------------------------------------------------------
# `str.strip()` refuses only leading/trailing Python whitespace, which is narrower than
# the exact-id contract this guard enforces. Three further content defects are refused,
# each as its own named refusal because each is a different wrong:
#   * `""` -- an id that names nothing (strips to itself, so padding never saw it).
#   * any Unicode format character (category `Cf`) -- U+200B, U+200E/F, U+202A-U+202E,
#     U+2066-U+2069, U+FEFF -- which render invisibly or reorder the line.
# The check is category-based (`unicodedata.category(ch) == "Cf"`), not an explicit list,
# so a future format character joins without a code change. Ids are *not* NFC-normalised:
# this guard refuses an ambiguous id, it never rewrites one.
#
# Every test here drives a real loader and expects a refusal. On `main` these inputs load
# silently, so each `pytest.raises(ProfileError)` fails behaviourally (DID NOT RAISE), not
# at collection time -- the failure this issue requires on `main` is a missing refusal.

# The format characters #260 names, each by codepoint, written as escapes so this test
# for invisible characters contains no invisible characters.
FORMAT_CHARACTERS = (
    "\u200b",  # ZERO WIDTH SPACE
    "\u200e",  # LEFT-TO-RIGHT MARK
    "\u200f",  # RIGHT-TO-LEFT MARK
    "\u202a",  # LEFT-TO-RIGHT EMBEDDING
    "\u202d",  # LEFT-TO-RIGHT OVERRIDE
    "\u202e",  # RIGHT-TO-LEFT OVERRIDE
    "\u2066",  # LEFT-TO-RIGHT ISOLATE
    "\u2069",  # POP DIRECTIONAL ISOLATE
    "\ufeff",  # ZERO WIDTH NO-BREAK SPACE / BOM
)


def test_an_empty_creator_id_is_refused(tmp_path) -> None:
    """`""` passes the padding check by stripping to itself, and names nothing.

    An id names exactly one record, so an empty id makes every downstream lookup, sort
    and join run on a key that cannot tell one record from another. The refusal names
    the file and says the id is empty, at parse, as an exit-2 usage error not a
    traceback. On `main` this directory loads a one-entry library keyed on `""`.
    """
    _profile_file(tmp_path / "acme.json", creator_id="")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "empty" in message
    assert "acme.json" in message


@pytest.mark.parametrize("character", FORMAT_CHARACTERS)
def test_a_format_character_in_a_creator_id_is_refused(tmp_path, character) -> None:
    """Every category-`Cf` character the issue names, refused and named by codepoint.

    These are not whitespace to `str.strip()`, so the padding check never saw them, yet
    each renders invisibly (U+200B, U+FEFF) or reorders the line (U+202E) -- so an id
    carrying one is a distinct dict key that looks identical to one without it, and its
    rendered form disagrees with its bytes. The refusal prints the id via `repr`, which
    escapes the character to `\\uXXXX`, and names the offending codepoint.
    """
    _profile_file(tmp_path / "acme.json", creator_id=f"contoso-ai{character}")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    message = str(error.value)
    assert "format character" in message
    assert f"U+{ord(character):04X}" in message
    assert "acme.json" in message


def test_a_format_character_id_is_refused_rather_than_stripped(tmp_path) -> None:
    """Refused, not silently cleaned: the same file loads once the character is gone.

    Stripping the format character would register the document under a string the JSON
    does not contain -- the trap that makes padding a refusal rather than a trim -- so
    the id `"contoso-ai\\u200b"` is refused outright, and the plain `"contoso-ai"` loads.
    """
    padded = _profile_file(tmp_path / "acme.json", creator_id="contoso-ai\u200b")

    with pytest.raises(ProfileError):
        load_profile(padded)

    _profile_file(padded, creator_id="contoso-ai")
    assert load_profile(padded).creator_id == "contoso-ai"


def test_a_bom_prefixed_id_that_str_strip_leaves_alone_is_refused(tmp_path) -> None:
    """U+FEFF is category `Cf`, not `Zs`, so `str.strip()` does not remove it.

    This is the exact accident of `str.strip()` the issue calls out: NBSP is refused
    because Python happens to call it whitespace, while a BOM/ZWNBSP is not. The
    category check closes that gap without touching the alphabet.
    """
    assert "\ufeff".strip() == "\ufeff"
    _profile_file(tmp_path / "acme.json", creator_id="\ufeffcontoso-ai")

    with pytest.raises(ProfileError) as error:
        load_profile_library(tmp_path)

    assert "U+FEFF" in str(error.value)


def test_the_guard_narrows_nothing_that_already_loaded(tmp_path) -> None:
    """Strictly more refusals, never fewer: a legitimate id still loads unchanged.

    The rule refuses empty, padded and format-character ids and nothing else -- it does
    not narrow the alphabet, so a non-Latin id (were one declared) would still load. The
    shipped ids are plain kebab-case ASCII; this pins that the hardening leaves them be.
    """
    _profile_file(tmp_path / "acme.json", creator_id="google-deepmind")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("google-deepmind",)


def test_a_non_ascii_but_visible_id_is_not_refused_by_the_format_check(tmp_path) -> None:
    """The alphabet is untouched: only empty, padded and `Cf` ids are refused.

    `strasse` written with a sharp-s is a letter (category `Ll`), not a format
    character, so it is not caught. This pins that the fix refuses the invisible and
    reordering class, not everything outside ASCII.
    """
    _profile_file(tmp_path / "acme.json", creator_id="stra\u00dfe")

    library = load_profile_library(tmp_path)

    assert library.creator_ids == ("stra\u00dfe",)


def test_the_twelve_shipped_fixture_ids_all_survive_the_hardened_guard() -> None:
    """The real corpus, run through the guard by name, refuses none of its ids.

    Every shipped creator id is plain kebab-case ASCII, so none is empty, padded or
    carries a format character. Passing each real id back through the shared guard is the
    execution-level proof that the hardening catches no legitimate existing id (#260 AC7).
    """
    shipped = (
        "anthropic",
        "contoso-ai",
        "fabrikam-ai",
        "google-deepmind",
        "litware-ai",
        "meta",
        "northwind-ai",
        "openai",
        "proseware-ai",
        "quiet-ai",
        "tailspin-ai",
        "wingtip-ai",
    )
    path = Path("fixtures") / "creators" / "unused.json"
    for creator_id in shipped:
        assert (
            _refuse_padded_id(creator_id, path=path, subject="creator id") == creator_id
        )
