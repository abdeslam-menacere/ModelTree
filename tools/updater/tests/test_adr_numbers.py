"""The guard on ADR numbering, and the near miss that made it necessary.

`test_the_committed_adrs_are_unique` runs the checker against the real
`docs/adr/`, so a pull request that lands a second ADR 0003 turns this red as
well as the dedicated workflow.

The rest pin the behaviour that makes that first test worth anything. A check
that cannot fail against the defect it names is worthless -- this repository has
already shipped one of those -- so `test_the_145_and_146_collision_fails`
reconstructs the two real filenames from that near miss and asserts the checker
rejects the pair, and its neighbours pin the three classification decisions:
companions are ignored, non-Markdown is ignored, and a Markdown file whose name
carries no readable number is refused rather than quietly skipped.

`test_an_empty_directory_is_a_failure` is the anti-vacuity pin. A duplicate check
that finds nothing to compare would otherwise report success, which is the exact
defect class the issue warns about.

Two of those classification decisions turned out to have a gap each, both found
by running the shipped checker (#220), and the tests for them are written to be
evidence rather than decoration. `\\d{4}` in a `str` pattern is the whole Unicode
`Nd` category, so a `0003` in Arabic-Indic, Devanagari or fullwidth digits was
admitted as an ADR under a number string no ASCII `0003` could be bucketed
against, and the run ended `OK: 2 ADRs, every number claimed by exactly one
file`. Separately, a case-sensitive `\\.md$` in the name pattern contradicted the
case-*insensitive* `path.suffix.lower()` above it, so `0007-title.MD` was
Markdown to one line and unnumbered to the next. Each of those tests asserts the
refusal or the acceptance -- never that the ASCII, lowercase path still works,
which passes against the defect as readily as against the fix.

`numbers_reported` exists for the third gap in that issue: assertions on
`report.duplicates` are assertions on a property recomputed from `report.adrs`,
not on the problems list the script prints and exits on, and truncating the
problems loop used to leave this whole file green.

Every assertion about a diagnosis is made against a `Problem` record rather than
against rendered text, and the `duplicate_message` / `paths_named` pair that used
to cut a paragraph out of `render()` before asserting is gone with the last call
site. Slicing was the right repair when the problems list held preformatted
lines -- `render()` concatenates an inventory of every examined ADR with those
lines, so `"<filename>" in report.render()` is answered by the inventory whatever
the diagnosis says, and twice in this file an assertion whose whole stated
purpose was to pin the diagnosis was in fact passing off the inventory. It was a
repair that had to be remembered, though, and the two tests that needed it were
found by reading rather than by going red. `problem.paths` needs remembering by
nobody: the inventory is not reachable from it.
`test_the_duplicate_record_holds_the_diagnosis_and_not_the_inventory` is the pin
on that, and it is deliberately built so that the rendered report and the record
disagree -- an uncontested ADR that `render()` names and the diagnosis does not.
The two `render()` pins that remain,
`test_a_duplicate_record_renders_the_block_the_workflow_prints` and
`test_a_single_file_refusal_renders_as_one_line`, spell the output in full,
because the text is what the workflow shows a reader and restructuring how a
problem is *held* must not move it.

`the record's own number` is #286, and it is where this file stops being about
filenames alone. An ADR's number lives in the filename *and* in the
`# ADR NNNN:` heading, with nothing keeping the two in step -- a hand-maintained
mirror whose realistic trigger is the advice this very checker gives, to
renumber one of a colliding pair. Every test in that section asserts a refusal
or names the one file diagnosed; none asserts that a correct record still
passes, because that is satisfied by a checker which reads no heading at all.
Where one has to show something is *not* diagnosed -- a `# ADR 0003:` quoted
inside a code fence, a byte-order mark in front of the `#` -- a genuinely
mismatched record sits beside it as the control, so the test cannot go green by
the heading check having quietly stopped running. `adr_dir` derives each
fixture's heading from its own filename for the same reason: a fixture built to
exercise the duplicate rule then stays silent about headings by construction,
and a test that wants the two to disagree writes that file itself.

The last two sections are #303, and both are about output that misstates what
happened rather than about the duplicate rule. A filename holding a newline used
to claim a line of the report and put a forged `OK:` above the genuine `FAIL:`;
a filename holding a character the console's codepage cannot represent used to
kill the run inside `cp1252.py`, over an ADR set in which every number was
unique. The pairs matter more than the individual assertions in both: an
ordinary name has to come back untouched or the fix is a rewrite of the report,
and a name cp1252 *can* carry has to keep printing or the encoding test is
pinning "non-ASCII" -- which is not the trigger and never was. `run_cli` exists
because `capsys` carries any `str` and so cannot see the defect at all.

The checker lives outside the updater package because it is not an updater
concern, and is loaded by path for the same reason -- the arrangement
`test_instruction_references.py` already uses. Its tests live here because this is
where the repository's stdlib-Python invariants are asserted, and running them in
this suite needs no second pytest project.
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CHECKER_PATH = REPO_ROOT / "tools" / "adr_numbers" / "check_adr_numbers.py"
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "adr-numbers.yml"

# The two filenames from the near miss in #145 and #146. Same number, different
# title, no path collision -- which is why git had nothing to say about them.
MERGED_0003 = "0003-an-agent-gated-data-refresh-may-auto-merge.md"
COMPETING_0003 = "0003-unattended-data-refresh-may-auto-merge.md"

# `0003` written in digit scripts other than ASCII. Every one of these matches
# `\d{4}` in a `str` pattern, because `\d` there is the whole Unicode `Nd`
# category, and every one reads as ADR 3 under `int()` -- while comparing equal
# to no ASCII "0003" and so landing in a duplicate bucket of its own. Spelled by
# codepoint rather than pasted, because the fullwidth form is indistinguishable
# from ASCII in most editors, which is the whole reason it is dangerous.
NON_ASCII_0003 = {
    "arabic-indic": "\u0660\u0660\u0660\u0663",
    "devanagari": "\u0966\u0966\u0966\u0969",
    "fullwidth": "\uff10\uff10\uff10\uff13",
}


def _load_checker():
    spec = importlib.util.spec_from_file_location("check_adr_numbers", CHECKER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


checker = _load_checker()


@pytest.fixture()
def adr_dir(tmp_path):
    """Build a directory of ADR files, each opening with the heading its own
    name implies.

    The checker reads the first heading of every decision record since #286, so
    a file whose name says ADR 0001 has to say `# ADR 0001:` inside or every
    test in this file would trip the heading refusal instead of the behaviour it
    means to pin. The heading is *derived from the name* rather than passed in,
    so a fixture built to exercise the duplicate rule stays silent about
    headings by construction and cannot drift out of agreement with itself. A
    test that wants the two to disagree writes that file itself, which is what
    the heading section below does.
    """

    def build(*names: str) -> Path:
        directory = tmp_path / "adr"
        directory.mkdir(exist_ok=True)
        for name in names:
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(adr_body(name), encoding="utf-8")
        return directory

    return build


def adr_body(name: str) -> str:
    """The contents a file called `name` needs in order to be a sound ADR.

    A well-formed heading when the name carries an ASCII ADR number, and a plain
    one otherwise -- `README.md`, `0001-diagram.png` and a name whose digits are
    fullwidth are all deliberately not decision records, and giving them an
    `# ADR NNNN:` heading would state a claim the test is asserting they do not
    make. The number is taken from the checker's own `ADR_NAME_RE`, so the
    fixture admits exactly the files the checker admits.
    """
    stem = Path(name).stem
    match = checker.ADR_NAME_RE.match(stem)
    if Path(name).suffix.lower() == ".md" and match is not None:
        return f"# ADR {match.group(1)}: {stem}\n"
    return f"# {name}\n"


def numbers(report) -> set[str]:
    return set(report.duplicates)


def numbers_reported(report) -> set[str]:
    """The contested numbers read back out of `report.problems`.

    `numbers()` above reads `report.duplicates`, a property recomputed from
    `report.adrs` -- so it answers "which numbers *are* contested", which is not
    the same question as "which contested numbers does the script tell anyone
    about". `report.problems` is the list `render()` prints and `ok` is derived
    from, so it is the one a reader and CI actually see. Truncating the
    problems loop to `list(report.duplicates.items())[:1]` leaves every
    `numbers()` assertion green and turns the assertions using this red.
    """
    return {
        problem.number
        for problem in report.problems
        if problem.kind == checker.DUPLICATE
    }


# The advice sentence a DUPLICATE record carries as its message.
DUPLICATE_ADVICE = "An ADR number must identify exactly one decision record."


def problems_of(report, kind: str) -> list:
    """Every problem of one kind, in the order the checker recorded them."""
    return [problem for problem in report.problems if problem.kind == kind]


def duplicate(report, number: str):
    """The one DUPLICATE record for `number`.

    This replaces the `duplicate_message` / `paths_named` pair this file used to
    carry. Those existed because `render()` concatenates an inventory of every
    examined ADR with the problems block into one string, so
    `"<filename>" in report.render()` is satisfied by the inventory whatever the
    diagnosis says -- and the paragraph had to be cut out of the rendered text
    before a filename could be asserted against it meaningfully. Twice in this
    file that slicing was missing and the assertion passed off the inventory.

    `report.problems` holds records now, so there is no inventory to slice away:
    `problem.paths` *is* the set of files the diagnosis names, and the examined
    list is not reachable from it. Asserting exactly one record per number is
    kept from the old helper -- two DUPLICATE paragraphs for one number would
    otherwise let a test pick whichever one agreed with it.
    """
    found = [
        problem
        for problem in report.problems
        if problem.kind == checker.DUPLICATE and problem.number == number
    ]
    assert len(found) == 1, (
        f"expected exactly one DUPLICATE record for ADR {number}, "
        f"found {len(found)}:\n{report.render()}"
    )
    return found[0]


# --- the guard itself -------------------------------------------------------


def test_the_committed_adrs_are_unique():
    """Every ADR on this branch claims a number no other ADR claims."""
    report = checker.check(REPO_ROOT / checker.DEFAULT_DIRECTORY, REPO_ROOT)

    assert report.ok, report.render()


def test_the_committed_directory_is_actually_being_examined():
    """The counterweight to the test above: passing on zero files is not a pass.

    Counted a second way, by a plain glob rather than by the checker's own
    walk, so "it found what is there" is asserted rather than assumed. Not
    pinned to a literal 3, because adding an ADR is correct work and a guard
    that fails on correct work gets worked around.
    """
    directory = REPO_ROOT / checker.DEFAULT_DIRECTORY
    on_disk = sorted(path.name for path in directory.glob("[0-9][0-9][0-9][0-9]-*.md"))
    report = checker.check(directory, REPO_ROOT)

    assert on_disk, "docs/adr holds no decision records at all"
    assert [Path(adr.path).name for adr in report.adrs] == on_disk


def test_the_default_target_is_the_adr_directory():
    """CI passes no argument, so the default is the whole of what it checks."""
    assert checker.DEFAULT_DIRECTORY == Path("docs") / "adr"
    assert (REPO_ROOT / checker.DEFAULT_DIRECTORY).is_dir()


# --- the regression pin -----------------------------------------------------


def test_the_145_and_146_collision_fails(adr_dir):
    """The near miss, reconstructed. If this passes, the guard is worthless."""
    report = checker.check(adr_dir(MERGED_0003, COMPETING_0003), REPO_ROOT)

    assert not report.ok
    assert numbers(report) == {"0003"}


def test_the_failure_names_both_paths_and_the_number(adr_dir):
    """Naming one path, or saying only "duplicate found", leaves the reader to
    go and find the other file. Both names and the number, on the record.

    The distinction is the entire value of this test. `render()` lists every
    examined ADR by path above the problems block, so an assertion over the
    rendered text finds both filenames whatever the DUPLICATE line says. That
    is not a hazard this test has to steer around any more: `problem.paths` is
    the diagnosis and holds nothing else, so there is no inventory in reach to
    be satisfied by. Pinned by mutation: `paths[:1]` on the record built in
    check_adr_numbers.py turns this red.

    The expected paths are literals rather than anything derived from the
    checker, so a mutation cannot move both sides of the comparison at once.
    """
    report = checker.check(adr_dir(MERGED_0003, COMPETING_0003), REPO_ROOT)
    problem = duplicate(report, "0003")

    assert problem.paths == (MERGED_0003, COMPETING_0003)
    assert problem.number == "0003"
    assert problem.message == (
        f"{DUPLICATE_ADVICE} Renumber all but one of these to the next unused "
        "number."
    )


def test_the_duplicate_record_holds_the_diagnosis_and_not_the_inventory(adr_dir):
    """The property this issue exists for, asserted rather than assumed.

    An uncontested ADR is in `report.adrs` and in the rendered inventory, so
    `"0009-uncontested.md" in report.render()` is true -- while the diagnosis
    says nothing about it. The record has to disagree with the rendered text
    here, because that gap is precisely what an assertion aimed at the
    diagnosis used to be unable to see.
    """
    report = checker.check(
        adr_dir(MERGED_0003, COMPETING_0003, "0009-uncontested.md"), REPO_ROOT
    )
    problem = duplicate(report, "0003")

    assert "0009-uncontested.md" in report.render()
    assert "0009-uncontested.md" not in problem.paths
    assert "0009-uncontested.md" not in problem.message
    assert set(problem.paths) == {MERGED_0003, COMPETING_0003}
    assert {adr.path for adr in report.adrs} > set(problem.paths)


def test_every_file_on_a_contested_number_is_named(adr_dir):
    """Three claimants report three paths on the record, not the first two."""
    report = checker.check(
        adr_dir("0007-one.md", "0007-two.md", "0007-three.md"), REPO_ROOT
    )
    problem = duplicate(report, "0007")

    assert report.duplicates["0007"] == [
        "0007-one.md",
        "0007-three.md",
        "0007-two.md",
    ]
    assert problem.paths == (
        "0007-one.md",
        "0007-three.md",
        "0007-two.md",
    )


def test_the_stated_count_matches_the_paths_the_message_lists(adr_dir):
    """"claimed by N files" followed by fewer than N paths is a lie the reader
    cannot detect without opening the directory.

    The count is now derived from `problem.paths` when the message is rendered,
    so the two cannot disagree by construction. That makes the interesting
    assertion the other one: that `problem.paths` is what is actually on disk.
    Both sides are pinned against the fixture -- the count against the literal
    the fixture was built from, never against `len(problem.paths)`, which would
    make this test agree with itself whatever the checker found.
    """
    for count in (2, 3, 4):
        names = [f"0007-{index}.md" for index in range(count)]
        report = checker.check(adr_dir(*names), REPO_ROOT)
        problem = duplicate(report, "0007")

        assert sorted(problem.paths) == sorted(names)
        assert len(problem.paths) == count
        assert f"claimed by {count} files" in problem.render()


def test_a_duplicate_record_renders_the_block_the_workflow_prints(adr_dir):
    """The record is what a test asserts against; this is the pin that its
    *text* has not moved.

    `render()` is what `.github/workflows/adr-numbers.yml` puts in front of
    whoever opens the failed job, so restructuring how a problem is held must
    not move a byte of it. Written out in full rather than matched by pattern,
    because a pattern is exactly what a formatting change slips through.
    """
    report = checker.check(adr_dir(MERGED_0003, COMPETING_0003), REPO_ROOT)

    assert duplicate(report, "0003").render() == (
        "  DUPLICATE: ADR 0003 is claimed by 2 files:\n"
        f"      {MERGED_0003}\n"
        f"      {COMPETING_0003}\n"
        "      An ADR number must identify exactly one decision record. "
        "Renumber all but one of these to the next unused number."
    )


def test_two_separate_collisions_are_both_reported(adr_dir):
    """Reporting only the first would hide the second behind a fix for the
    first, so the same pull request would fail twice for different reasons.

    Asserted against `report.problems` as well as `report.duplicates`. The
    latter is recomputed from `report.adrs`, so on its own it says the checker
    *found* both collisions and says nothing about whether it *reports* both --
    `list(report.duplicates.items())[:1]` in the problems loop ships a script
    that prints one collision of two and left this test green.
    """
    report = checker.check(
        adr_dir("0004-a.md", "0004-b.md", "0009-c.md", "0009-d.md"), REPO_ROOT
    )

    assert numbers(report) == {"0004", "0009"}
    assert numbers_reported(report) == {"0004", "0009"}


def test_a_number_claimed_in_a_subdirectory_still_collides(adr_dir):
    """Nesting does not open a second numbering namespace."""
    report = checker.check(
        adr_dir("0003-first.md", "superseded/0003-second.md"), REPO_ROOT
    )

    assert not report.ok
    assert numbers(report) == {"0003"}


# --- what is deliberately allowed -------------------------------------------


def test_distinct_numbers_pass(adr_dir):
    report = checker.check(adr_dir("0001-a.md", "0002-b.md", "0003-c.md"), REPO_ROOT)

    assert report.ok, report.render()


def test_a_gap_is_not_a_failure(adr_dir):
    """Ordering and contiguity are out of scope: two pull requests each adding
    the next ADR would collide by construction under a contiguity rule."""
    report = checker.check(adr_dir("0001-a.md", "0005-b.md", "0009-c.md"), REPO_ROOT)

    assert report.ok, report.render()


def test_prose_below_the_heading_is_still_not_read(adr_dir):
    """The boundary of #286. One heading is read; the rest of the record is not.

    This replaces `test_the_number_inside_the_document_is_never_read`, which
    asserted that a file named `0002-b.md` saying `# ADR 0001:` was fine. That
    was the behaviour #286 removed, so the test had to go with it -- but the
    limit it was guarding still exists one level in, and something has to hold
    it. A decision record may say anything it likes below its title, including
    citing other ADRs by number, and none of it is the checker's business.
    """
    directory = adr_dir("0001-a.md")
    (directory / "0002-b.md").write_text(
        "# ADR 0002: correct heading\n\nThis record supersedes ADR 0001 and\n"
        "## ADR 0009: is not one\n",
        encoding="utf-8",
    )

    report = checker.check(directory, REPO_ROOT)

    assert report.ok, report.render()


# --- classification: ignored, and visibly so --------------------------------


@pytest.mark.parametrize("companion", ["README.md", "readme.md", "TEMPLATE.md"])
def test_a_companion_file_is_ignored(adr_dir, companion):
    report = checker.check(adr_dir("0001-a.md", companion), REPO_ROOT)

    assert report.ok, report.render()
    assert any(path == companion for path, _ in report.ignored)


def test_a_non_markdown_file_is_ignored(adr_dir):
    """A diagram beside a decision record is not a decision record."""
    report = checker.check(adr_dir("0001-a.md", "0001-diagram.png"), REPO_ROOT)

    assert report.ok, report.render()
    assert any(path == "0001-diagram.png" for path, _ in report.ignored)


def test_what_was_skipped_is_named_in_the_report(adr_dir):
    """An exemption nobody can see is indistinguishable from a bypass.

    Sliced to the ignored line, so the reason is asserted to travel with the
    name rather than merely to exist somewhere in the report. Unlike the
    DUPLICATE assertions, this one was never satisfiable by the ADR inventory
    above it -- an inventory line is "NNNN  path", so only the ignored list can
    emit an "ignored: " prefix -- but a name without its reason is still half
    the point.
    """
    report = checker.check(adr_dir("0001-a.md", "README.md"), REPO_ROOT)
    rendered = report.render()
    ignored_lines = [
        line.strip()
        for line in rendered.splitlines()
        if line.strip().startswith("ignored: ")
    ]

    assert ignored_lines == [
        "ignored: README.md -- a companion file, not a decision record"
    ]
    assert "1 ADR files examined, 1 files ignored" in rendered


# --- classification: a directory that looks like an ADR ---------------------


def _ignored_lines(rendered: str) -> list[str]:
    """The ignored list, sliced out of a rendered report.

    Asserting a reason against the whole of `render()` proves almost nothing:
    `render()` prints an inventory of every examined ADR above the problems
    block, and #161's review failed on exactly that whole-output substring
    check. Only the ignored list emits an "ignored: " prefix, so slicing to it
    ties the reason to the entry rather than to the report at large.
    """
    return [
        line.strip()
        for line in rendered.splitlines()
        if line.strip().startswith("ignored: ")
    ]


def test_a_directory_named_like_an_adr_is_reported_as_ignored(adr_dir):
    """The defect: a directory named `0003-something.md/` is skipped by the walk
    and appears nowhere -- not examined, not ignored, not counted -- so a report
    over a tree that holds one is silently wrong in both numbers.

    An exemption nobody can see is indistinguishable from a bypass. The reason
    has to say "directory" so a reader can tell it from a file carrying an
    unparseable number, and it is asserted against the specific ignored line,
    not the whole rendered report. Built from `tmp_path` with `pathlib` because
    a directory whose name ends in `.md` behaves differently across filesystems
    and a hard-coded absolute path would not survive the move to CI.
    """
    directory = adr_dir("0001-a.md")
    (directory / "0003-something.md").mkdir()

    report = checker.check(directory, REPO_ROOT)

    assert _ignored_lines(report.render()) == [
        "ignored: 0003-something.md -- a directory named like an ADR, "
        "not a decision record"
    ]


def test_the_ignored_count_includes_an_adr_named_directory(adr_dir):
    """The tally has to reconcile: examined + ignored accounts for the directory
    instead of hiding it. On the unfixed checker this line reads "0 files
    ignored" over a directory that is plainly there."""
    directory = adr_dir("0001-a.md")
    (directory / "0003-something.md").mkdir()

    report = checker.check(directory, REPO_ROOT)

    assert len(report.ignored) == 1
    assert "1 ADR files examined, 1 files ignored" in report.render()


def test_a_bare_adr_named_directory_still_exits_zero(adr_dir):
    """Behaviour is unchanged: a directory is not a decision record and not a
    collision, so a tree whose only oddity is one exits clean. This pins the
    visibility fix against becoming a policy change -- the directory is named,
    not refused. It fails on the unfixed checker only because the directory goes
    unreported, never because the exit code moved."""
    directory = adr_dir("0001-a.md")
    (directory / "0003-something.md").mkdir()

    report = checker.check(directory, REPO_ROOT)

    assert report.ok, report.render()
    assert any(
        "a directory named like an ADR" in reason for _, reason in report.ignored
    )


def test_an_adr_named_directory_containing_a_collision_still_fails(adr_dir):
    """The half the gate confirmed by execution: a directory named like an ADR
    that *contains* a colliding file still produces DUPLICATE and exit 1,
    because the walk descends into it and examines the file. The fix adds the
    directory to the ignored list without touching that -- reported *and*
    collided, not one instead of the other."""
    directory = adr_dir("0003-real-decision.md")
    decoy = directory / "0003-decoy.md"
    decoy.mkdir()
    (decoy / "0003-inside.md").write_text(
        adr_body("0003-inside.md"), encoding="utf-8"
    )

    report = checker.check(directory, REPO_ROOT)

    assert not report.ok
    assert numbers(report) == {"0003"}
    assert any(
        "a directory named like an ADR" in reason for _, reason in report.ignored
    )


def test_a_plain_container_subdirectory_is_not_named(adr_dir):
    """The boundary of the decision. A namespace directory like `superseded/` is
    walked and its contents examined, so nothing under it was passed over and
    naming it would be noise rather than visibility. Only a directory that
    *looks like an ADR file* is reported -- asserted alongside a real one so the
    test still fails on the unfixed checker."""
    directory = adr_dir("0001-a.md", "superseded/0002-b.md")
    (directory / "0003-collision.md").mkdir()

    report = checker.check(directory, REPO_ROOT)
    ignored_paths = [path for path, _ in report.ignored]

    assert "0003-collision.md" in ignored_paths
    assert not any(Path(path).name == "superseded" for path in ignored_paths)


def test_the_cli_exits_zero_on_a_bare_adr_named_directory(adr_dir, capsys):
    """The degenerate table from #161's review, re-run: a bare directory named
    like an ADR exits 0. The rendered output now names the directory, but the
    exit code is what it always was."""
    directory = adr_dir("0001-a.md")
    (directory / "0003-something.md").mkdir()

    assert checker.main([str(directory)]) == 0
    assert "a directory named like an ADR" in capsys.readouterr().out


def test_the_cli_exits_one_on_a_collision_inside_an_adr_named_directory(
    adr_dir, capsys
):
    """The other row: a directory named like an ADR that holds a colliding file
    exits 1 with DUPLICATE, unchanged. Visibility was added, policy was not."""
    directory = adr_dir("0003-real-decision.md")
    decoy = directory / "0003-decoy.md"
    decoy.mkdir()
    (decoy / "0003-inside.md").write_text(
        adr_body("0003-inside.md"), encoding="utf-8"
    )

    assert checker.main([str(directory)]) == 1
    out = capsys.readouterr().out
    assert "DUPLICATE" in out
    assert "a directory named like an ADR" in out


# --- classification: refused, not silently skipped --------------------------


@pytest.mark.parametrize(
    "name",
    [
        "003-three-digits.md",
        "00003-five-digits.md",
        "0003_underscore.md",
        "adr-0003-prefixed.md",
        "notes.md",
    ],
)
def test_a_markdown_file_with_no_readable_number_is_refused(adr_dir, name):
    """Each of these reads as ADR 3 to a human and as nothing to a matcher.

    Skipping them silently is how a collision walks past a collision check.
    """
    report = checker.check(adr_dir("0001-a.md", name), REPO_ROOT)
    refusals = problems_of(report, checker.UNNUMBERED)

    assert not report.ok
    assert [problem.paths for problem in refusals] == [(name,)]


def test_the_refusal_says_how_to_resolve_it(adr_dir):
    report = checker.check(adr_dir("0001-a.md", "notes.md"), REPO_ROOT)
    refusals = problems_of(report, checker.UNNUMBERED)

    assert len(refusals) == 1
    assert "COMPANION_NAMES" in refusals[0].message


def test_a_single_file_refusal_renders_as_one_line(adr_dir):
    """The counterpart to the DUPLICATE block pin. Every kind but DUPLICATE
    concerns one file and states itself in a sentence, so its rendered form is
    the kind, a colon and the message -- on one line, because a second line
    here would put an unaccounted-for entry into a report whose tally two lines
    above says nothing about it."""
    report = checker.check(adr_dir("0001-a.md", "notes.md"), REPO_ROOT)
    rendered = problems_of(report, checker.UNNUMBERED)[0].render()

    assert len(rendered.splitlines()) == 1
    assert rendered.startswith("  UNNUMBERED: notes.md is a Markdown file under ")
    assert rendered.endswith("Rename it, or add its name to COMPANION_NAMES.")


# --- classification: four digits means four ASCII digits ---------------------


@pytest.mark.parametrize("script", sorted(NON_ASCII_0003))
def test_a_non_ascii_0003_is_not_admitted_beside_an_ascii_0003(adr_dir, script):
    """The defect this section exists for, and the assertion has to be that the
    impostor is *refused*.

    An assertion that the ASCII path still works passes against the unfixed
    checker as readily as against the fixed one, so it is not evidence of
    anything. Under `\\d{4}` both files below were admitted, bucketed under two
    different number strings, and the run ended `OK: 2 ADRs, every number
    claimed by exactly one file` at exit 0 -- a success line that is false as
    printed, since both files claim ADR 3.
    """
    impostor = f"{NON_ASCII_0003[script]}-impostor.md"
    report = checker.check(adr_dir("0003-real-decision.md", impostor), REPO_ROOT)

    assert not report.ok, report.render()
    assert [adr.path for adr in report.adrs] == ["0003-real-decision.md"]


@pytest.mark.parametrize("script", sorted(NON_ASCII_0003))
def test_no_two_admitted_adrs_read_as_the_same_number(adr_dir, script):
    """The acceptance criterion stated directly: the OK line cannot be printed
    while two files claim one number under `int()`.

    Comparing the admitted numbers as integers rather than as strings is the
    point -- string comparison is exactly what the defect defeated, so a test
    that compares them the same way the checker did could not see it.
    """
    impostor = f"{NON_ASCII_0003[script]}-impostor.md"
    report = checker.check(adr_dir("0003-real-decision.md", impostor), REPO_ROOT)
    rendered = report.render()
    claimed = [int(adr.number) for adr in report.adrs]

    assert len(claimed) == len(set(claimed)), rendered
    assert "every number claimed by exactly one file" not in rendered


@pytest.mark.parametrize("script", sorted(NON_ASCII_0003))
def test_the_non_ascii_refusal_names_the_digits_rather_than_the_filename(
    adr_dir, script
):
    """A refusal a reader cannot act on sends them somewhere else.

    The glyphs are the entire problem and, fullwidth especially, are not
    distinguishable on sight from `0003`, so the message gives codepoints and
    the number the name reads as. It must also *not* offer COMPANION_NAMES:
    that allowlist is for READMEs and templates, and following the suggestion
    for a file named like a decision record would exempt a real ADR from
    collision checking permanently -- converting a naming slip into the exact
    failure this module exists to prevent.
    """
    digits = NON_ASCII_0003[script]
    report = checker.check(
        adr_dir("0003-real-decision.md", f"{digits}-impostor.md"), REPO_ROOT
    )
    refusals = problems_of(report, checker.NON_ASCII_NUMBER)

    assert len(refusals) == 1, report.render()
    refusal = refusals[0]
    message = refusal.message
    assert refusal.paths == (f"{digits}-impostor.md",)
    assert refusal.number == "0003"
    assert all(f"U+{ord(char):04X}" in message for char in digits)
    assert "ADR 0003" in message
    assert "COMPANION_NAMES" not in message


def test_an_ascii_near_miss_still_gets_the_unnumbered_refusal(adr_dir):
    """The counterweight: the new branch must not swallow the old one.

    `003-x.md` carries no four-digit number in any script, so the advice that
    fits it -- rename, or allowlist it as a companion -- is still the advice it
    gets.
    """
    report = checker.check(adr_dir("0001-a.md", "003-three-digits.md"), REPO_ROOT)

    assert not report.ok
    assert problems_of(report, checker.UNNUMBERED)
    assert not problems_of(report, checker.NON_ASCII_NUMBER)


# --- classification: the Markdown suffix is read case-insensitively ----------


@pytest.mark.parametrize("suffix", [".MD", ".Md", ".mD"])
def test_an_uppercase_markdown_suffix_is_accepted(adr_dir, suffix):
    """One question, one answer.

    `path.suffix.lower() != ".md"` had already decided that Markdown-ness does
    not depend on case; the name pattern then re-decided it case-sensitively
    and disagreed. `0007-uppercase-ext.MD` was refused as a Markdown file that
    is "neither named NNNN-title.md nor a known companion" -- which it plainly
    is -- and the casing, the one thing that actually disqualified it, went
    unmentioned.
    """
    report = checker.check(
        adr_dir("0001-a.md", f"0007-uppercase-ext{suffix}"), REPO_ROOT
    )

    assert report.ok, report.render()
    assert [adr.number for adr in report.adrs] == ["0001", "0007"]


def test_a_collision_is_seen_across_suffix_casing(adr_dir):
    """Accepting the file is only worth something if it is then checked.

    Refusing it left the collision unreported: the reader was told to rename or
    allowlist one file and never told that another already claims ADR 7.
    """
    report = checker.check(adr_dir("0007-lower.md", "0007-UPPER.MD"), REPO_ROOT)

    assert not report.ok
    assert numbers_reported(report) == {"0007"}


def test_no_numbered_decision_record_is_sent_to_companion_names(adr_dir):
    """COMPANION_NAMES is for READMEs and templates. Suggesting it for a file
    named `NNNN-title` invites the reader to file a decision record as a
    non-ADR and exempt its number from checking for good."""
    report = checker.check(adr_dir("0001-a.md", "0007-uppercase-ext.MD"), REPO_ROOT)

    assert not any(
        "COMPANION_NAMES" in problem.message for problem in report.problems
    )


def test_a_non_markdown_suffix_is_still_not_an_adr(adr_dir):
    """Case-insensitive is not extension-insensitive: `.MD` is Markdown, `.TXT`
    is not, and neither is `.markdown`."""
    report = checker.check(
        adr_dir("0001-a.md", "0002-notes.TXT", "0003-notes.markdown"), REPO_ROOT
    )

    assert report.ok, report.render()
    assert sorted(path for path, _ in report.ignored) == [
        "0002-notes.TXT",
        "0003-notes.markdown",
    ]


# --- the record's own number -------------------------------------------------
#
# #286. An ADR's number lives in two places -- the filename and the
# `# ADR NNNN:` heading -- and nothing kept them in sync. That is a
# hand-maintained mirror whose realistic trigger is this checker's own advice to
# renumber a colliding file: the remedy for one ambiguity introduces another.
#
# Every test below asserts a *refusal* or names the one file diagnosed. None of
# them asserts that a correct record still passes, because that is satisfied by
# a checker which reads no heading at all -- the state these tests exist to
# leave behind. Where a test has to show something is *not* diagnosed, a
# genuinely broken file sits beside it as the control, so the test cannot go
# green by the heading check having quietly stopped running.


# A filename and a heading that disagree, left as a half-finished renumber
# leaves them: the file was renamed 0003 -> 0007 and the heading was not.
RENUMBERED = "0007-renamed-but-not-inside.md"
STALE_HEADING = "# ADR 0003: Left behind by a renumber\n"


def write(directory: Path, name: str, body: str) -> Path:
    """One decision record with a body the `adr_dir` fixture would not produce.

    The fixture derives every heading from the filename, which is what keeps the
    rest of this file silent about headings. A test in this section is about the
    two disagreeing, so it has to write the body itself.
    """
    target = directory / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")
    return target


def mismatch(report):
    """The one HEADING MISMATCH record on `report`.

    Asserting there is exactly one is kept from `duplicate()` above and for the
    same reason: two records for one file would let a test pick whichever
    happened to agree with it.
    """
    found = problems_of(report, checker.HEADING_MISMATCH)
    assert len(found) == 1, (
        f"expected exactly one HEADING MISMATCH record, found {len(found)}:\n"
        f"{report.render()}"
    )
    return found[0]


def test_a_heading_that_disagrees_with_the_filename_fails(adr_dir):
    """The defect stated directly. If this passes, #286 is not closed."""
    directory = adr_dir("0001-a.md")
    write(directory, RENUMBERED, STALE_HEADING)

    report = checker.check(directory, REPO_ROOT)

    assert not report.ok, report.render()
    assert mismatch(report).paths == (RENUMBERED,)


def test_the_mismatch_record_carries_both_numbers_and_the_path(adr_dir):
    """Criterion 1: both values and the path, asserted on the record.

    Structurally rather than through the rendered text, for the reason the
    DUPLICATE assertions are: `render()` lists every examined ADR above the
    problems block, so `"0007" in report.render()` is answered by the inventory
    whatever the diagnosis says. `number` and `heading_number` *are* the
    diagnosis and the inventory is not reachable from them.

    Both expected values are literals, so a mutation cannot move both sides of
    a comparison at once.
    """
    directory = adr_dir("0001-a.md")
    write(directory, RENUMBERED, STALE_HEADING)

    problem = mismatch(checker.check(directory, REPO_ROOT))

    assert problem.number == "0007"
    assert problem.heading_number == "0003"
    assert problem.paths == (RENUMBERED,)


def test_the_mismatch_renders_the_line_the_workflow_prints(adr_dir):
    """The text pin, spelled in full for the reason the DUPLICATE one is:
    `render()` is what `.github/workflows/adr-numbers.yml` puts in front of
    whoever opens the failed job, and both numbers have to survive into it.

    They are interpolated from the record's own fields rather than from a
    sentence composed at the call site, so a line stating one pair of numbers
    over a record holding another is unrepresentable rather than merely
    untested -- the property `Problem.render()` already gives "claimed by N
    files".
    """
    directory = adr_dir("0001-a.md")
    write(directory, RENUMBERED, STALE_HEADING)

    rendered = mismatch(checker.check(directory, REPO_ROOT)).render()

    assert rendered == (
        f"  HEADING MISMATCH: {RENUMBERED} is filed as ADR 0007 and its "
        "heading says ADR 0003. An ADR is cited as a bare `ADR NNNN`, "
        "resolved by looking for the record that says it is that number, so "
        "the filename and the heading have to agree. Edit whichever of the "
        "two is wrong."
    )
    assert len(rendered.splitlines()) == 1


def test_a_mismatch_does_not_hide_a_collision(adr_dir):
    """A record that misstates its own number is still a claim on the number in
    its name.

    Withholding it from the duplicate bucket would be this module's own silent
    skip wearing a new hat: the file drops out of the collision check and the
    duplicate it was contesting gets reported as unique. Both diagnoses, not one
    instead of the other -- so the DUPLICATE has to name *both* files.
    """
    directory = adr_dir("0003-real-decision.md")
    write(directory, "0003-also-real.md", "# ADR 0004: wrong about itself\n")

    report = checker.check(directory, REPO_ROOT)

    assert duplicate(report, "0003").paths == (
        "0003-also-real.md",
        "0003-real-decision.md",
    )
    assert numbers_reported(report) == {"0003"}
    assert mismatch(report).paths == ("0003-also-real.md",)


@pytest.mark.parametrize(
    "body",
    [
        "",
        "no heading at all, just prose\n",
        "## ADR 0008: an H2 is not the title\n",
        "# Static-First Architecture\n",
        "# ADR 8: too few digits\n",
        "# ADR 00008: too many digits\n",
        "# ADR0008: no space after ADR\n",
        "#ADR 0008: no space after the hash\n",
        "#\n",
    ],
)
def test_a_record_whose_heading_states_no_number_is_refused(adr_dir, body):
    """Criterion 2, and the rule the filename branch already follows.

    A check that quietly declines to examine the file it was pointed at is
    worse than no check. Every body here leaves the number resting on the
    filename alone, which is the single point of failure #286 is about, and
    several of them -- `# ADR 8:` especially -- read as a number to a person
    while matching nothing. Refusing a second spelling of the number is
    deliberate: admitting one is how a mirror starts drifting.
    """
    directory = adr_dir("0001-a.md")
    write(directory, "0008-x.md", body)

    report = checker.check(directory, REPO_ROOT)
    refusals = problems_of(report, checker.UNREADABLE_HEADING)

    assert not report.ok, report.render()
    assert [problem.paths for problem in refusals] == [("0008-x.md",)]


def test_the_unreadable_heading_refusal_names_the_number_to_write(adr_dir):
    """A refusal a reader cannot act on sends them somewhere else. The number
    is already known -- it is in the filename -- so the message spells the
    heading that would fix it rather than describing the shape in the abstract.
    """
    directory = adr_dir("0001-a.md")
    write(directory, "0008-x.md", "# Not a numbered title\n")

    refusals = problems_of(
        checker.check(directory, REPO_ROOT), checker.UNREADABLE_HEADING
    )

    assert "# ADR 0008: Title" in refusals[0].message


@pytest.mark.parametrize("script", sorted(NON_ASCII_0003))
def test_a_heading_number_in_another_script_is_spelled_by_codepoint(
    adr_dir, script
):
    """The filename trap in its second location, and why the quote is spelled.

    A fullwidth `0003` is not distinguishable from ASCII `0003` in most
    editors, so a refusal quoting the heading as itself reads as "0003 is not
    0003" and sends the reader looking for a checker bug. Asserted on the
    codepoints *and* on the glyphs being gone, which is the only form that can
    tell the two apart -- an assertion that the message merely mentions the file
    passes whether the quote was spelled or not.
    """
    digits = NON_ASCII_0003[script]
    directory = adr_dir("0001-a.md")
    write(directory, "0003-x.md", f"# ADR {digits}: impostor\n")

    refusals = problems_of(
        checker.check(directory, REPO_ROOT), checker.UNREADABLE_HEADING
    )

    assert [problem.paths for problem in refusals] == [("0003-x.md",)]
    assert all(f"U+{ord(char):04X}" in refusals[0].message for char in digits)
    assert digits not in refusals[0].message


def test_an_example_heading_in_a_code_fence_is_not_the_records_own_claim(
    adr_dir,
):
    """A `# ADR 0003:` shown inside a fence is an example, not a claim.

    Reported as a disagreement it would be a refusal that misstates what the
    file says, which is the failure this module keeps finding elsewhere. The
    genuinely mismatched file beside it is the control: without it this test
    goes green against a checker that reads no headings at all.
    """
    directory = adr_dir("0001-a.md")
    write(
        directory,
        "0002-quotes-an-example.md",
        "```md\n# ADR 0003: an example\n```\n\n# ADR 0002: the real heading\n",
    )
    write(directory, RENUMBERED, STALE_HEADING)

    report = checker.check(directory, REPO_ROOT)

    assert mismatch(report).paths == (RENUMBERED,)
    assert [problem.paths for problem in report.problems] == [(RENUMBERED,)]


def test_a_fence_that_is_never_closed_leaves_no_heading(adr_dir):
    """An unclosed fence swallows the rest of the file, exactly as a Markdown
    renderer would. Giving up on the fence and taking the next `# ` line
    instead would credit the record with a heading its own renderer never
    shows."""
    directory = adr_dir("0001-a.md")
    write(directory, "0002-unclosed.md", "```\n# ADR 0002: inside a fence\n")

    report = checker.check(directory, REPO_ROOT)
    refusals = problems_of(report, checker.UNREADABLE_HEADING)

    assert [problem.paths for problem in refusals] == [("0002-unclosed.md",)]


def test_a_correct_heading_further_down_does_not_rescue_a_wrong_first_one(
    adr_dir,
):
    """The *first* H1, not any matching line in the file.

    A search-anywhere rule would let a record whose title states the wrong
    number pass on the strength of citing the right one in its prose -- and the
    title is what a reader sees.
    """
    directory = adr_dir("0001-a.md")
    write(
        directory,
        "0002-b.md",
        "# ADR 0009: the title\n\n# ADR 0002: mentioned lower down\n",
    )

    problem = mismatch(checker.check(directory, REPO_ROOT))

    assert problem.paths == ("0002-b.md",)
    assert problem.heading_number == "0009"


def test_a_numbered_heading_below_an_unnumbered_title_does_not_rescue_it(
    adr_dir,
):
    """The other half of "the *first* H1", and the half that actually
    distinguishes the rule from a search-anywhere one.

    Its sibling above pins a first heading carrying the *wrong* number -- which
    a rule scanning for any `# ADR NNNN:` line finds first too, so that test
    cannot tell the two rules apart and a mutation swapping them survives it.
    Here the title carries no number at all and the matching one sits below:
    under "first H1" the record is refused, under "any matching line" it passes
    clean. Only this shape separates them, and it is the realistic one -- a
    record retitled in prose while a stale `# ADR NNNN:` lingers further down.
    """
    directory = adr_dir("0001-a.md")
    write(
        directory,
        "0002-b.md",
        "# The Title Of This Decision\n\n# ADR 0002: only mentioned here\n",
    )

    report = checker.check(directory, REPO_ROOT)
    refusals = problems_of(report, checker.UNREADABLE_HEADING)

    assert not report.ok, report.render()
    assert [problem.paths for problem in refusals] == [("0002-b.md",)]


def test_a_byte_order_mark_does_not_make_a_correct_record_unreadable(adr_dir):
    """A Windows editor leaves a BOM in front of the `#`.

    Read as plain UTF-8 that codepoint sits where the heading marker should be
    and turns a perfectly correct decision record into a refusal -- a complaint
    about the checker in the costume of a complaint about the file. The
    mismatched record beside it is the control, so this cannot pass by the
    heading check having stopped working.
    """
    directory = adr_dir("0001-a.md")
    write(directory, "0002-bom.md", "\ufeff# ADR 0002: with a byte order mark\n")
    write(directory, RENUMBERED, STALE_HEADING)

    report = checker.check(directory, REPO_ROOT)

    assert [problem.paths for problem in report.problems] == [(RENUMBERED,)]


def test_a_record_that_is_not_utf8_is_reported_rather_than_crashing(adr_dir):
    """`read_text` raises `UnicodeDecodeError` on these bytes, and a traceback
    out of the codec tells the operator about this checker and `codecs.py`
    rather than about the decision record that could not be read.

    The same refuse-don't-crash discipline the unprintable-report path already
    follows, and reported rather than skipped for the same reason everything
    else here is: a file the check could not open is not a file it has cleared.
    """
    directory = adr_dir("0001-a.md")
    (directory / "0002-latin1.md").write_bytes(b"# ADR 0002: caf\xe9\n")

    report = checker.check(directory, REPO_ROOT)
    refusals = problems_of(report, checker.UNREADABLE_FILE)

    assert not report.ok, report.render()
    assert [problem.paths for problem in refusals] == [("0002-latin1.md",)]
    assert "UnicodeDecodeError" in refusals[0].message


def test_a_very_long_unreadable_heading_is_clipped(adr_dir):
    """A Markdown file may be one very long line, and a refusal quoting the
    whole of it floods the report an operator has to read. Clipped, and marked
    as clipped, so a truncated quote cannot be taken for the whole of what the
    file says."""
    directory = adr_dir("0001-a.md")
    write(directory, "0002-long.md", "# " + "x" * 500 + "\n")

    refusals = problems_of(
        checker.check(directory, REPO_ROOT), checker.UNREADABLE_HEADING
    )

    assert "x" * checker.HEADING_QUOTE_LIMIT not in refusals[0].message
    assert "..." in refusals[0].message


def test_the_cli_exits_one_on_a_heading_mismatch(adr_dir, capsys):
    """End to end: the exit code CI reads and the diagnosis a reader gets."""
    directory = adr_dir("0001-a.md")
    write(directory, RENUMBERED, STALE_HEADING)

    assert checker.main([str(directory)]) == 1
    out = capsys.readouterr().out
    assert "HEADING MISMATCH" in out
    assert "OK:" not in out


def test_the_committed_adrs_agree_with_their_own_headings():
    """The live guard, and the counterpart to
    `test_the_committed_adrs_are_unique`: a pull request that renumbers a
    decision record and leaves its heading behind turns this red.

    The heading is read back out of each file here rather than taken from the
    checker, so this and the checker are two independent readings of the same
    five documents. The list is asserted non-empty first, because a loop over
    nothing passes -- the anti-vacuity pin this file applies everywhere else.
    """
    directory = REPO_ROOT / checker.DEFAULT_DIRECTORY
    on_disk = sorted(directory.glob("[0-9][0-9][0-9][0-9]-*.md"))

    assert on_disk, "docs/adr holds no decision records at all"
    for path in on_disk:
        first = path.read_text(encoding="utf-8-sig").splitlines()[0]
        assert first.startswith(f"# ADR {path.name[:4]}:"), (
            f"{path.name} opens with {first!r}"
        )


# --- anti-vacuity -----------------------------------------------------------


def test_an_empty_directory_is_a_failure(tmp_path):
    """A check that examines nothing must not report success."""
    directory = tmp_path / "adr"
    directory.mkdir()

    report = checker.check(directory, REPO_ROOT)

    assert not report.ok
    assert [problem.kind for problem in report.problems] == [checker.EMPTY]


def test_a_directory_holding_only_companions_is_a_failure(adr_dir):
    """The same defect wearing a disguise: everything present, nothing checked."""
    report = checker.check(adr_dir("README.md"), REPO_ROOT)

    assert not report.ok
    assert [problem.kind for problem in report.problems] == [checker.EMPTY]


# --- the command line -------------------------------------------------------


def test_the_cli_exits_zero_on_the_committed_adrs(capsys):
    assert checker.main([]) == 0
    assert "every number claimed by exactly one file" in capsys.readouterr().out


def test_the_cli_exits_one_on_a_duplicate(adr_dir, capsys):
    """What the CLI owes the reader is that it prints the report and nothing
    else, so that is what is asserted -- as equality, not as a substring.

    This test used to slice the DUPLICATE paragraph out of stdout and assert
    the paths against it, because `render()` puts an inventory of every
    examined ADR above the problems block and a bare `MERGED_0003 in out`
    passed off that inventory whatever the diagnosis said. Splitting the claim
    in two removes the need to slice anything: *this* pins that stdout is the
    report verbatim, and what the report says about ADR 0003 is pinned on the
    record by `test_the_failure_names_both_paths_and_the_number`. Neither half
    can be satisfied by the other half's evidence.
    """
    directory = adr_dir(MERGED_0003, COMPETING_0003)
    expected = checker.check(directory, REPO_ROOT).render()

    assert checker.main([str(directory)]) == 1
    assert capsys.readouterr().out == f"{expected}\n"


def test_the_cli_rejects_a_directory_that_is_not_there(tmp_path, capsys):
    assert checker.main([str(tmp_path / "nowhere")]) == 2
    assert "OK" not in capsys.readouterr().out


def test_the_cli_takes_no_flags_that_could_skip_the_check(capsys):
    """A bypass belongs in branch protection, where it is auditable.

    There is no argument parser, so a flag is read as a directory path and the
    run ends in a usage error rather than a silent pass.
    """
    assert checker.main(["--skip-gates"]) == 2
    assert checker.main(["--force"]) == 2
    assert checker.main([str(REPO_ROOT), "extra"]) == 2
    assert "OK" not in capsys.readouterr().out


# --- output: a name cannot forge a line -------------------------------------


# The forged verdict from #303, reproduced by constructing the module's own
# `Report` and `Adr` and calling `render()`. No filesystem is involved because
# none is needed: `Adr.path` is a `str`, which is what makes this reachable, and
# Windows cannot create a file whose name holds a newline anyway.
FORGED_OK = (
    "OK: 9 ADRs, every number claimed by exactly one file, every heading "
    "agreeing with its filename."
)
GENUINE_FAIL = "FAIL: an ADR number does not identify exactly one decision record."

# Every character `str.splitlines()` treats as ending a line. A test that pinned
# only "\n" would pass against a fix that special-cased "\n", and "\r" alone
# splits a line just as effectively -- as do the separators nobody thinks of.
LINE_ENDERS = ["\n", "\r", "\r\n", "\v", "\f", "\x1c", "\x85", "\u2028", "\u2029"]


def verdict_lines(rendered: str) -> list[str]:
    """The lines that state an outcome. Exactly one of these is ever genuine."""
    return [
        line for line in rendered.splitlines() if line.startswith(("OK:", "FAIL:"))
    ]


@pytest.mark.parametrize("ender", LINE_ENDERS)
def test_a_line_ender_in_a_reported_path_cannot_forge_a_verdict(ender):
    """The defect: a filename claims a line of the report, and the line it
    claims says the run was clean.

    On the unfixed checker this renders a forged `OK:` *above* the genuine
    `FAIL:`, so anything grepping the output for `OK:` reads a run with a real
    duplicate as clean. Asserted as "the only verdict line is the genuine one"
    rather than as "the path is escaped", because the escaping is a means and
    this is the property that matters.
    """
    report = checker.Report(
        directory=Path("docs") / "adr",
        base=REPO_ROOT,
        adrs=[
            checker.Adr("0001", "0001-real.md"),
            checker.Adr("0002", f"0002-x.md{ender}{ender}{FORGED_OK}{ender}"),
        ],
        problems=[checker.Problem(kind=checker.EMPTY, message="stand-in")],
    )
    rendered = report.render()

    assert verdict_lines(rendered) == [GENUINE_FAIL], rendered


@pytest.mark.parametrize("ender", LINE_ENDERS)
def test_a_line_ender_in_a_diagnosed_path_cannot_forge_a_verdict(ender):
    """`Problem.paths` holds `str`, exactly as `Adr.path` does.

    Moving the contested paths onto a record put a second untrusted string
    field into the report, and `render()` still joins with "\\n". Production
    values reach it through `display()`, which has already spelled them and is
    idempotent, so spelling them again in `Problem.render()` costs the real
    output nothing -- and without it this refactor would have narrowed the
    invariant the inventory already holds to, by adding a field it does not
    cover.
    """
    report = checker.Report(
        directory=Path("docs") / "adr",
        base=REPO_ROOT,
        adrs=[checker.Adr("0003", "0003-real.md")],
        problems=[
            checker.Problem(
                kind=checker.DUPLICATE,
                number="0003",
                paths=(
                    "0003-real.md",
                    f"0003-x.md{ender}{ender}{FORGED_OK}{ender}",
                ),
                message="stand-in",
            )
        ],
    )

    assert verdict_lines(report.render()) == [GENUINE_FAIL], report.render()


@pytest.mark.parametrize("ender", LINE_ENDERS)
def test_the_report_has_exactly_the_lines_its_own_tally_implies(ender):
    """The same property counted rather than matched, because the pattern-based
    form of this test passed on the unfixed checker.

    Two ADRs and no problems is six lines: the heading, the tally, one line per
    ADR, a blank, and the verdict. A name that spans lines makes the report
    contradict the tally it printed two lines above -- "2 ADR files examined"
    over a four-line inventory -- and a reader has no way to tell which of the
    two is lying. Counting every line catches that; counting only the lines that
    still look like inventory entries does not, which is why it is done this
    way.
    """
    report = checker.Report(
        directory=Path("docs") / "adr",
        base=REPO_ROOT,
        adrs=[
            checker.Adr("0001", "0001-real.md"),
            checker.Adr("0002", f"0002-x.md{ender}{FORGED_OK}"),
        ],
    )
    rendered = report.render()

    assert "2 ADR files examined, 0 files ignored" in rendered
    assert len(rendered.splitlines()) == 6, rendered


def test_the_scanned_directory_cannot_forge_a_line():
    """The directory is a reported path too -- it is the first line of every
    report, and the UNNUMBERED and EMPTY refusals name it as well. It arrives
    from argv, so on any filesystem that permits the name it is as untrusted as
    the files under it."""
    report = checker.Report(
        directory=Path(f"docs/adr\n{FORGED_OK}"),
        base=REPO_ROOT,
        adrs=[checker.Adr("0001", "0001-real.md")],
        problems=[checker.Problem(kind=checker.EMPTY, message="stand-in")],
    )

    assert verdict_lines(report.render()) == [GENUINE_FAIL], report.render()


def test_a_real_path_holding_a_newline_is_shown_as_one_line():
    """The other route into the report, and the one Windows cannot demonstrate
    end to end.

    A refusal paragraph interpolates what `display()` returns and is never
    re-formatted by `render()`, so closing the hole in `render()` alone would
    leave `UNNUMBERED: <forged lines>` forging exactly the same way on Linux,
    where such a filename is legal and git carries it. `display()` only
    resolves the path, so this needs no file on disk -- which is what makes it
    runnable on the machine that cannot create one.
    """
    forging = Path(f"docs/adr/notes.md\n\n{FORGED_OK}")

    shown = checker.display(forging, REPO_ROOT)

    assert len(shown.splitlines()) == 1
    assert FORGED_OK not in shown.splitlines()


@pytest.mark.parametrize(
    "name",
    [
        "0001-a.md",
        "0002-caf\u00e9.md",
        "0003-\u65e5\u672c.md",
        "0004-a b.md",
        "0005-\U0001f600.md",
    ],
)
def test_an_ordinary_name_is_returned_unchanged(name):
    """The counterweight, and the reason this is a robustness fix rather than a
    change to what the report says.

    Nothing here holds a line ender, so nothing here is spelled -- including the
    non-ASCII names, which is the distinction the whole encoding half of #303
    turns on. A fix that escaped "anything unusual" would quietly rewrite every
    accented or emoji filename in the inventory, and this test is what stops it.
    """
    assert checker.spelled(name) == name


def test_a_spelled_character_names_its_codepoint():
    """`U+XXXX`, the notation the NON-ASCII NUMBER refusal already uses. A
    reader who has to identify an invisible character needs its number, and one
    notation for that is enough."""
    assert checker.spelled("a\nb") == "a<U+000A>b"
    assert checker.spelled("a\u2028b") == "a<U+2028>b"


def test_spelling_a_name_twice_changes_nothing_the_second_time():
    """`display()` spells, and `render()` spells what `display()` produced.

    That is deliberate -- neither boundary covers the other -- and it is only
    safe because the result holds nothing left to spell. If it were not
    idempotent the two boundaries would be two answers, which is the defect
    #220 removed from this file rather than reworded.
    """
    once = checker.spelled(f"0002-x.md\n\n{FORGED_OK}")

    assert checker.spelled(once) == once


# --- output: a report this stdout cannot carry -------------------------------


# A name cp1252 cannot carry, and a name it can. The pair is the entire point:
# `e` with an acute accent is non-ASCII too and prints on a cp1252 stdout
# perfectly well, so "non-ASCII crashes it" is not true and a test written to
# that framing passes for the wrong reason. It takes a codepoint the codepage
# does not have.
OUTSIDE_CP1252 = "0002-\u65e5\u672c.md"
INSIDE_CP1252 = "0002-caf\u00e9.md"


def run_cli(monkeypatch, argv: list[str], encoding: str, err_encoding=None):
    """`main(argv)` against a stdout and stderr encoded as `encoding`.

    `capsys` cannot express this test. Its streams carry any `str`, so the
    defect -- a console whose codepage cannot represent a name in the report --
    is invisible through it, and every existing CLI test in this file passes on
    the unfixed checker for that reason. Real `TextIOWrapper`s over real buffers
    with `errors="strict"` reproduce the console exactly, which is why reverting
    the fix turns these red with the original `UnicodeEncodeError` rather than
    with an assertion.

    `err_encoding` gives stderr a narrower encoding than stdout, which is the
    one case where a refusal can still die in its own print.
    """
    err_encoding = err_encoding or encoding
    out = io.TextIOWrapper(io.BytesIO(), encoding=encoding, newline="\n")
    err = io.TextIOWrapper(io.BytesIO(), encoding=err_encoding, newline="\n")
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)
    code = checker.main(argv)
    out.flush()
    err.flush()
    return (
        code,
        out.buffer.getvalue().decode(encoding),
        err.buffer.getvalue().decode(err_encoding),
    )


def test_a_name_this_stdout_cannot_carry_is_refused_not_crashed(
    adr_dir, monkeypatch
):
    """#303 item 1. The checker died inside `cp1252.py` with a traceback that
    reads as a bug in itself, over an ADR set in which every number was unique.

    The refusal has to be the checker's own and has to be actionable: which
    encoding, which codepoints, and which name -- spelled, since by definition
    it cannot be shown as itself on this stream.
    """
    directory = adr_dir("0001-plain.md", OUTSIDE_CP1252)

    code, out, err = run_cli(monkeypatch, [str(directory)], "cp1252")

    assert code == 2
    assert out == ""
    assert "UNPRINTABLE" in err
    assert "cp1252" in err
    assert "U+65E5" in err and "U+672C" in err
    assert "0002-<U+65E5><U+672C>.md" in err


def test_the_refusal_cannot_be_mistaken_for_a_verdict(adr_dir, monkeypatch):
    """#303 item 1, the half that makes it worth doing. A refusal that reads
    like a clean run is the failure this repository keeps finding, so the
    refusal says outright that no result was reported and emits no OK line."""
    directory = adr_dir("0001-plain.md", OUTSIDE_CP1252)

    code, out, err = run_cli(monkeypatch, [str(directory)], "cp1252")

    assert code != 0
    assert "OK:" not in err and "OK:" not in out
    assert "every number claimed by exactly one file" not in err
    assert "the check ran and its result was not reported" in err


def test_a_duplicate_hidden_behind_an_unprintable_name_never_exits_zero(
    adr_dir, monkeypatch
):
    """The safe direction, pinned. A real collision that cannot be printed must
    not become a pass -- the exit code says "no verdict", never "clean"."""
    directory = adr_dir("0003-real.md", f"0003-{OUTSIDE_CP1252}")

    code, out, err = run_cli(monkeypatch, [str(directory)], "cp1252")

    assert code == 2
    assert out == ""
    assert "UNPRINTABLE" in err


def test_the_same_name_prints_as_itself_on_a_utf8_stdout(adr_dir, monkeypatch):
    """The refusal is keyed on what the stream can carry, not on the name.

    A counterweight rather than evidence: it passes on the unfixed checker too,
    which is exactly its job. Without it, a fix that simply refused every
    non-ASCII name would satisfy the test above while making the checker useless
    on the UTF-8 stdout CI actually runs, and nothing here would notice.
    """
    directory = adr_dir("0001-plain.md", OUTSIDE_CP1252)

    code, out, err = run_cli(monkeypatch, [str(directory)], "utf-8")

    assert code == 0
    assert OUTSIDE_CP1252 in out
    assert "UNPRINTABLE" not in err
    assert "every number claimed by exactly one file" in out


def test_a_name_cp1252_can_carry_still_prints_on_a_cp1252_stdout(
    adr_dir, monkeypatch
):
    """The control case #303 insists on, and the one that decides whether the
    encoding tests above test what they claim.

    `e` with an acute accent is non-ASCII and cp1252 has it, so this run printed
    fine and exited 0 before the fix and prints identically after it -- it
    passes both ways by design. A fix keyed on "non-ASCII" rather than on "this
    encoding" is what turns it red.
    """
    directory = adr_dir("0001-plain.md", INSIDE_CP1252)

    code, out, err = run_cli(monkeypatch, [str(directory)], "cp1252")

    assert code == 0
    assert err == ""
    assert INSIDE_CP1252 in out
    assert "U+00E9" not in out
    assert "every number claimed by exactly one file" in out


def test_a_missing_directory_named_outside_the_encoding_is_still_refused(
    tmp_path, monkeypatch
):
    """The other print in `main()`. It echoes an argument straight to stderr, so
    it carries the identical crash, and a usage refusal that dies inside the
    codec leaves the operator with nothing at all. Spelled inline rather than
    withheld: this message is already the refusal, so there is no verdict being
    held back."""
    missing = tmp_path / "\u65e5\u672c"

    code, out, err = run_cli(monkeypatch, [str(missing)], "cp1252")

    assert code == 2
    assert out == ""
    assert "no such directory:" in err
    assert "<U+65E5><U+672C>" in err


def test_a_refusal_survives_a_stderr_narrower_than_stdout(adr_dir, monkeypatch):
    """The refusal is checked against stdout and printed to stderr, and the two
    need not agree.

    A name holding both a character cp1252 carries and one it does not is
    spelled only for the second, so the refusal still contains `e` with an acute
    accent -- which an ASCII stderr cannot take. Routing every refusal through
    one function that spells for stderr is what closes it; checking stdout and
    printing to stderr unchecked reopens it.
    """
    directory = adr_dir("0001-plain.md", "0002-caf\u00e9\u65e5\u672c.md")

    code, out, err = run_cli(
        monkeypatch, [str(directory)], "cp1252", err_encoding="ascii"
    )

    assert code == 2
    assert out == ""
    assert "UNPRINTABLE" in err
    assert "0002-caf<U+00E9><U+65E5><U+672C>.md" in err


def test_an_unknown_encoding_does_not_become_a_refusal_of_its_own():
    """A codec Python cannot look up is not evidence about the report.

    Refusing on it would substitute one wrong answer for another -- the checker
    failing on the codec's account rather than on the ADRs' -- which is the
    exact substitution this change removes.
    """
    assert checker.unencodable("anything", "not-a-real-codec") == ""
    assert checker.unencodable("anything", None) == ""
    assert checker.encoding_refusal("report", "not-a-real-codec") is None


# --- the workflow that runs it ----------------------------------------------


@pytest.fixture(scope="module")
def workflow() -> dict:
    yaml = pytest.importorskip("yaml", reason="PyYAML is part of the dev extra")
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def triggers(workflow) -> dict:
    # YAML 1.1 reads a bare `on` key as the boolean True.
    return workflow.get("on", workflow.get(True))


def test_the_workflow_exists() -> None:
    assert WORKFLOW_PATH.is_file()


def test_the_workflow_runs_on_pull_requests_touching_the_adrs(triggers) -> None:
    assert "docs/adr/**" in triggers["pull_request"]["paths"]
    assert "tools/adr_numbers/**" in triggers["pull_request"]["paths"]


def test_the_workflow_pushes_only_from_main(triggers) -> None:
    """Verifying this workflow before it reaches `main` needs a branch added to
    this list for one commit, because `gh workflow run` 404s on a workflow the
    default branch has never seen. That is a legitimate technique and a
    catastrophic thing to leave behind: a stale branch entry here is a trigger
    nobody expects. Equality, not membership, so a leftover cannot hide.
    """
    assert triggers["push"]["branches"] == ["main"]


def test_the_workflow_holds_no_write_scope(workflow) -> None:
    assert workflow["permissions"] == {"contents": "read"}
    assert all("permissions" not in job for job in workflow["jobs"].values())


def test_the_job_name_is_the_one_the_workflow_readme_documents(workflow) -> None:
    """Branch protection matches the job *name*. Renaming it silently stops any
    rule that requires it from ever being satisfied."""
    assert list(workflow["jobs"]) == ["adr-numbers"]
    assert workflow["jobs"]["adr-numbers"]["name"] == "adr-numbers"


def test_the_job_invokes_the_checker_with_no_arguments(workflow) -> None:
    """No argument means the real directory. A job that could be pointed at a
    fixture is a job that can be made to pass."""
    commands = [
        step["run"].strip()
        for step in workflow["jobs"]["adr-numbers"]["steps"]
        if "run" in step
    ]

    assert commands == ["python tools/adr_numbers/check_adr_numbers.py"]
