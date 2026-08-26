"""Fixture discovery obeys the same rule as the two reviewed sets, and refuses.

`providers/fixtures.py` was the third loader to decide for itself which files in a
directory are documents, and the only one with no duplicate check at all: two fixture
files declaring one creator id left one entry in the library and said nothing. That it
loads *test doubles* is the argument for closing it, not against. `mode=fixtures` is the
mode the publisher workflow dispatches, so a dropped fixture creator does not turn a run
red — it produces a green run carrying fewer proposals than the author wrote.

These tests hold down that the rule is **shared** rather than restated (#108, #151), and
that widening what is refused never widens what an id matches.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from modeltree_updater.profiles import (
    ProfileError,
    _DuplicateIdGuard,
    _refuse_padded_id,
    _reviewed_profile_paths,
)
from modeltree_updater.providers import fixtures
from modeltree_updater.providers.base import ProviderError
from modeltree_updater.providers.fixtures import load_fixture_library


def _fixture_file(path: Path, *, creator_id: Any, creator_name: str = "Fixture Co") -> Path:
    """One minimal creator fixture: the smallest document this loader accepts."""
    document = {
        "creator": {
            "creator_id": creator_id,
            "creator_name": creator_name,
            "entry_urls": ["https://www.example.com/fixture/releases"],
        },
        "sources": [],
    }
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def _deep_hash(payload: Any) -> str:
    """A hash over everything a document carries, not just how much of it.

    A count agrees with itself while the contents change underneath, which is the
    failure mode a discovery change is most likely to produce.
    """
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def test_fixture_discovery_shares_one_implementation_with_the_reviewed_sets() -> None:
    """The sharing is the fix, so it is pinned rather than left to convention.

    Three copies of one rule is how the defect survived two fixes: #108 corrected
    `longtail.py`, #151 corrected `profiles.py` and made those two share an
    implementation, and this loader kept the original defect throughout because it held
    a copy nobody was looking at. A fourth copy would restore exactly that.
    """
    assert fixtures._reviewed_profile_paths is _reviewed_profile_paths
    assert fixtures._DuplicateIdGuard is _DuplicateIdGuard
    assert fixtures._refuse_padded_id is _refuse_padded_id


def test_a_fixture_id_padded_with_whitespace_is_refused(tmp_path) -> None:
    """The whitespace rule reaches this loader too, because it is the same rule.

    The long-tail set refused a padded id and the other two did not, which is the same
    "one rule, three copies" divergence that let the duplicate check itself rot in this
    file (#199). A fixture declaring `" acme-labs"` is refused here exactly as a
    reviewed profile declaring it is, and for the same reason: the library is read by
    exact lookup, so the document would answer to a string no run will ask for.
    """
    _fixture_file(tmp_path / "acme.json", creator_id=" acme-labs")

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "whitespace" in message
    assert "acme.json" in message


def test_two_fixture_ids_differing_only_in_whitespace_cannot_both_load(
    tmp_path,
) -> None:
    """The reported defect, in the loader it was reported against.

    At the merge base this directory produced a two-entry library and said nothing,
    which in `mode=fixtures` is a green run carrying a proposal for a creator whose
    twin was quietly dropped.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    _fixture_file(tmp_path / "other.json", creator_id="acme-labs ")

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    assert "whitespace" in str(error.value)


def test_a_non_string_fixture_id_is_refused_before_it_can_collide(
    tmp_path,
) -> None:
    """A non-string id is refused at parse, before the duplicate guard ever sees it.

    At the merge base this pair (`True` and `"true"`) loaded far enough for the folding
    guard to refuse it as a collision "differing only in type and case". The id decision
    #204 makes moves the refusal earlier: a fixture id must be a string, so `True` is
    refused the moment it is read, naming the file, the field and the type. The input is
    still refused — strictly no less than before — only sooner and for the more precise
    reason. The type collision the old message described is now unreachable through this
    loader, because two ids that both load are now always both strings.
    """
    _fixture_file(tmp_path / "acme.json", creator_id=True)
    _fixture_file(tmp_path / "other.json", creator_id="true")

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "creator id must be a string" in message
    assert "bool" in message


def test_two_non_string_fixture_ids_are_refused_at_parse(tmp_path) -> None:
    """`True` and `1` are two dict keys, and both are refused for not being strings.

    At the merge base this pair was refused by the duplicate guard, which watches both
    key spaces so a plain assignment could not silently drop one. With string ids
    required (#204) the first non-string id read is refused before the guard is reached,
    so the directory is still refused — the "strictly more refusals, never fewer"
    property holds — while the reachable-`TypeError` path the guard left open is closed.
    """
    _fixture_file(tmp_path / "acme.json", creator_id=True)
    _fixture_file(tmp_path / "other.json", creator_id=1)

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    assert "creator id must be a string" in str(error.value)


@pytest.mark.parametrize(
    "creator_id, type_name",
    [(["a"], "list"), ({}, "dict"), (0.0, "float"), (1, "int"), (None, "NoneType"), (True, "bool")],
)
def test_every_non_string_fixture_id_shape_is_refused_by_the_real_loader(
    tmp_path, creator_id, type_name
) -> None:
    """Every non-string id shape, refused at parse by the real fixtures loader (#204).

    This is the reviewed sets' rule (#136) reaching the third loader, driven through
    `load_fixture_library` rather than the helper in isolation: a `list`/`dict` id
    crashed the duplicate guard's membership test, and a `float`/`bool` id beside a
    string crashed `sorted(creator_ids)`. Requiring a string at parse means neither
    reachable `TypeError` can form. The refusal names the offending value's type.
    """
    _fixture_file(tmp_path / "acme.json", creator_id=creator_id)

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "creator id must be a string" in message
    assert type_name in message


def test_a_mixed_type_fixture_library_cannot_reach_creator_ids(tmp_path) -> None:
    """The reported defect: a str id and a bool id, distinct and both loadable, sorted.

    The two ids do not collide under folding — `"acme-labs"` and `True` fold to
    different keys — so at the merge base the library loaded, correctly and by design,
    and `FixtureLibrary.creator_ids` then raised `TypeError: '<' not supported between
    instances of 'bool' and 'str'` the moment it sorted them. Constructed through the
    real loader, not by hand-assembling the object, so it proves the sort was reachable.
    Requiring a string id refuses the bool at parse, so no library the loader accepts can
    hold a mixed-type id set and `creator_ids` can sort freely.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    _fixture_file(tmp_path / "other.json", creator_id=True)

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    assert "creator id must be a string" in str(error.value)


def test_creator_ids_is_orderable_for_every_library_the_loader_accepts(tmp_path) -> None:
    """The accept side of criterion 2: an accepted library sorts without raising.

    A well-formed set of string ids loads and `creator_ids` returns them sorted. The
    refusal above and this together are the two halves of "cannot raise TypeError for
    any library the loader accepts": mixed types never load, and what does load orders.
    """
    _fixture_file(tmp_path / "b.json", creator_id="beta")
    _fixture_file(tmp_path / "a.json", creator_id="alpha")

    library = load_fixture_library(tmp_path)

    assert library.creator_ids == ("alpha", "beta")


def test_a_fixture_document_missing_creator_is_refused_by_name(tmp_path) -> None:
    """A document with no `creator` key is refused naming the file, not a bare KeyError.

    Valid JSON, wrong shape: a plausible hand-edit, or a different kind of document
    entirely. At the merge base the loader indexed `document["creator"]` directly and
    raised `KeyError: 'creator'`, which names the key but not which of a dozen documents
    on disk carried it — the one thing the operator needs. Now it is the same exit-2
    usage error the missing-fixtures case uses, naming the file and the field (#204).
    """
    (tmp_path / "acme.json").write_text(
        json.dumps({"sources": []}), encoding="utf-8"
    )

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "acme.json" in message
    assert "creator" in message


@pytest.mark.parametrize("missing", ["creator_id", "creator_name"])
def test_a_fixture_creator_missing_a_required_field_is_refused_by_name(
    tmp_path, missing
) -> None:
    """A creator block missing a required field is refused by name, not by KeyError.

    Same standard as the missing top-level `creator`: `creator["creator_id"]` and
    `creator["creator_name"]` were direct index reads that raised a bare `KeyError`
    naming the field but not the file. `_require` names both, matching how the reviewed
    profile loader already reads its own required creator fields (#204).
    """
    creator = {"creator_id": "acme-labs", "creator_name": "Acme"}
    del creator[missing]
    (tmp_path / "acme.json").write_text(
        json.dumps({"creator": creator, "sources": []}), encoding="utf-8"
    )

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "acme.json" in message
    assert missing in message


def test_a_duplicate_creator_id_is_refused_and_names_both_files(tmp_path) -> None:
    """Two files, one id: refused by name, where before the second quietly won.

    The refusal names both files because "duplicate creator id" is useless to someone
    who then has to grep a directory to find out which two documents collided.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    _fixture_file(tmp_path / "acme-copy.json", creator_id="acme-labs")

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "duplicate creator id" in message
    assert "'acme-labs'" in message
    assert "acme.json" in message and "acme-copy.json" in message


def test_two_creator_ids_differing_only_in_case_are_one_id(tmp_path) -> None:
    """Two ids a reader would call the same name collide, and the refusal says so.

    The message has to name both declared strings and say "case", because "duplicate"
    is baffling in front of two ids that do not look alike.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    _fixture_file(tmp_path / "other.json", creator_id="Acme-Labs")

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "duplicate creator id" in message
    assert "case" in message
    assert "'acme-labs'" in message and "'Acme-Labs'" in message
    assert "acme.json" in message and "other.json" in message


def test_two_string_ids_differing_only_in_internal_spacing_are_one_id(tmp_path) -> None:
    """Folding still refuses a string collision through this loader after the id rule.

    `"acme labs"` and `"acme  labs"` (one internal space vs two) are two dict keys that
    fold to one, and the guard refuses them as one id. This replaces the merge base's
    `True`/`1` form of the pin: that pair exercised the guard's second key space (ids
    that are one dict key but fold apart), which only non-string ids can be — and those
    are now refused before the guard for not being strings (#204). Two ids that both
    reach the guard are now always strings, so the reachable collision to pin is a
    folding one, and it is still refused.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme labs")
    _fixture_file(tmp_path / "other.json", creator_id="acme  labs")

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "duplicate creator id" in message
    assert "whitespace" in message


def test_two_creator_ids_differing_by_more_than_case_are_two_fixtures(tmp_path) -> None:
    """Regression pin: passes before and after the fix, and is kept deliberately.

    Folding refuses strictly more than comparing exact strings does, so it needs a
    guard against refusing ids that are genuinely distinct. This asserts the widening
    stopped where it was meant to.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    _fixture_file(tmp_path / "other.json", creator_id="acme-labs-research")

    library = load_fixture_library(tmp_path)

    assert library.creator_ids == ("acme-labs", "acme-labs-research")


def test_the_lookup_stays_exact_although_the_collision_check_folds(tmp_path) -> None:
    """Regression pin: passes before and after, and is the pin that matters most.

    Widening what is *refused* is monotone and safe; widening what an id *matches* is
    not. Before this change there was no folding to leak, so the property held for
    free — the pin exists because folding was just introduced next to the lookup, and
    if it ever leaked in, a run would start resolving ids that should be unknown. That
    is a silent success in place of a loud refusal: the same defect class this change
    removes, pointed the other way.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="Acme-Labs")

    library = load_fixture_library(tmp_path)

    assert library.creator_ids == ("Acme-Labs",)
    assert "acme-labs" not in library.creators
    with pytest.raises(ProviderError):
        library.document("acme-labs")
    assert library.document("Acme-Labs")["creator"]["creator_id"] == "Acme-Labs"


def test_a_case_variant_extension_is_refused_rather_than_silently_ignored(tmp_path) -> None:
    """`acme.JSON` is a fixture on Windows and absent on Linux, so it is refused.

    Matching lowercase alone would make the platforms agree, but agree on silence: the
    author still has a file that is not a fixture and no reason why. The refusal names
    the file and the suffix it actually has.
    """
    _fixture_file(tmp_path / "keeper.json", creator_id="keeper")
    _fixture_file(tmp_path / "acme.JSON", creator_id="acme-labs")

    with pytest.raises(ProfileError) as error:
        load_fixture_library(tmp_path)

    message = str(error.value)
    assert "acme.JSON" in message
    assert "'.JSON'" in message


def test_a_neighbour_that_was_never_a_fixture_is_still_ignored(tmp_path) -> None:
    """The refusal is narrow: only a file plainly meant to be a fixture trips it.

    Regression pin — a `.txt` neighbour was ignored by the old `glob("*.json")` too.
    It is here because the case-variant refusal above is the kind of tightening that
    over-reaches, and a directory holding a README must keep loading.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    (tmp_path / "README.md").write_text("how these fixtures work", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("not a fixture", encoding="utf-8")

    library = load_fixture_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_a_dot_prefixed_fixture_is_not_part_of_the_working_set(tmp_path) -> None:
    """A leading dot is the author saying "not part of the working set", and is honoured.

    `glob("*.json")` matched dot-prefixed names on every platform, so a file an author
    had deliberately set aside was loaded anyway — and, being a fixture, was loaded into
    a run rather than into a review.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    _fixture_file(tmp_path / ".draft.json", creator_id="draft-labs")

    library = load_fixture_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_the_leading_dot_is_judged_before_the_extension(tmp_path) -> None:
    """`.draft.JSON` is skipped for its dot, not refused for its case.

    The two rules could disagree about one file, so the order is pinned rather than
    left to whichever branch happens to come first. Honouring a stated intent beats
    correcting an incidental one.

    Non-vacuity is platform-dependent here, and deliberately reported as such: on a
    case-insensitive filesystem the pre-fix loader loaded this file, so it fails
    before the change; on Linux the pre-fix `glob("*.json")` never matched it, so
    there it is a regression pin rather than new coverage.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    _fixture_file(tmp_path / ".draft.JSON", creator_id="draft-labs")

    library = load_fixture_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_a_directory_named_like_a_fixture_is_not_a_document(tmp_path) -> None:
    """`archive.json/` was globbed and handed to the parser, which is nobody's answer.

    Refusing it for its extension and reading it as a document are both wrong answers
    to something that was never a file.
    """
    _fixture_file(tmp_path / "acme.json", creator_id="acme-labs")
    (tmp_path / "archive.json").mkdir()

    library = load_fixture_library(tmp_path)

    assert library.creator_ids == ("acme-labs",)


def test_the_shipped_fixture_library_still_loads_every_document(fixture_dir) -> None:
    """Regression pin: the tightening must not drop or alter anything already on disk.

    Checked against the directory read independently of the loader, and by deep hash
    per document rather than by a count — a count agrees with itself while the contents
    change underneath. Written this way rather than as a pinned literal so that adding
    a fixture does not break it, while a fixture silently vanishing still does.
    """
    on_disk = {}
    for path in sorted(fixture_dir.iterdir()):
        if path.suffix != ".json" or not path.is_file():
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        on_disk[document["creator"]["creator_id"]] = _deep_hash(document)

    library = load_fixture_library(fixture_dir)

    assert set(library.creators) == set(on_disk), "a fixture on disk is not in the library"
    assert set(library.documents) == set(on_disk)
    assert {
        creator_id: _deep_hash(document)
        for creator_id, document in library.documents.items()
    } == on_disk
    for creator_id, request in library.creators.items():
        assert request.creator_id == creator_id
