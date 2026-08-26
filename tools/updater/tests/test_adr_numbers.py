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

The checker lives outside the updater package because it is not an updater
concern, and is loaded by path for the same reason -- the arrangement
`test_instruction_references.py` already uses. Its tests live here because this is
where the repository's stdlib-Python invariants are asserted, and running them in
this suite needs no second pytest project.
"""

from __future__ import annotations

import importlib.util
import re
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
    """Build a directory of ADR files. Names only -- the checker never reads
    a decision record's contents, so a one-line body is enough."""

    def build(*names: str) -> Path:
        directory = tmp_path / "adr"
        directory.mkdir(exist_ok=True)
        for name in names:
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"# {name}\n", encoding="utf-8")
        return directory

    return build


def numbers(report) -> set[str]:
    return set(report.duplicates)


DUPLICATE_HEADING_RE = re.compile(r"^\s*DUPLICATE: ADR (\S+) is claimed by")


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
        match.group(1)
        for problem in report.problems
        for line in problem.splitlines()
        if (match := DUPLICATE_HEADING_RE.match(line))
    }


# The advice line closing a DUPLICATE paragraph. Indented like the paths it
# follows, so `paths_named` has to exclude it explicitly rather than by shape.
DUPLICATE_ADVICE = "An ADR number must identify exactly one decision record."


def duplicate_message(text: str, number: str) -> str:
    """Cut the DUPLICATE paragraph for one number out of a rendered report.

    Asserting a filename against the *whole* of `render()` proves almost
    nothing, and this file used to do exactly that. `render()` prints an
    inventory of every examined ADR by path above the problems block, so both
    names are in the rendered text however few of them the DUPLICATE message
    itself lists -- the assertion passes on a checker that says "claimed by 2
    files" and then names one. Slicing to the paragraph first is what makes the
    assertion mean what its name says.
    """
    lines = text.splitlines()
    heading = f"  DUPLICATE: ADR {number} is claimed by"
    starts = [index for index, line in enumerate(lines) if line.startswith(heading)]
    assert len(starts) == 1, (
        f"expected exactly one DUPLICATE paragraph for ADR {number}, "
        f"found {len(starts)}:\n{text}"
    )
    start = starts[0]
    end = start + 1
    while end < len(lines) and lines[end].startswith("      "):
        end += 1
    return "\n".join(lines[start:end])


def paths_named(message: str) -> list[str]:
    """The paths a DUPLICATE paragraph actually names, advice line excluded."""
    return [
        line.strip()
        for line in message.splitlines()[1:]
        if not line.strip().startswith(DUPLICATE_ADVICE[:13])
    ]


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
    go and find the other file. Both names and the number, in the message --
    and asserted against the message, not against the whole rendered report.

    The distinction is the entire value of this test. `render()` lists every
    examined ADR by path above the problems block, so an assertion over the
    rendered text finds both filenames whatever the DUPLICATE line says. Pinned
    by mutation: `for path in paths[:1]` in check_adr_numbers.py produces a
    report claiming "2 files" and naming one, which the rendered-text form of
    this assertion passed and this form fails.

    The expected paths are literals rather than anything derived from the
    checker, so a mutation cannot move both sides of the comparison at once.
    """
    report = checker.check(adr_dir(MERGED_0003, COMPETING_0003), REPO_ROOT)
    message = duplicate_message(report.render(), "0003")

    assert paths_named(message) == [MERGED_0003, COMPETING_0003]
    assert "claimed by 2 files" in message
    assert DUPLICATE_ADVICE in message


def test_every_file_on_a_contested_number_is_named(adr_dir):
    """Three claimants report three paths in the message, not the first two."""
    report = checker.check(
        adr_dir("0007-one.md", "0007-two.md", "0007-three.md"), REPO_ROOT
    )
    message = duplicate_message(report.render(), "0007")

    assert report.duplicates["0007"] == [
        "0007-one.md",
        "0007-three.md",
        "0007-two.md",
    ]
    assert paths_named(message) == [
        "0007-one.md",
        "0007-three.md",
        "0007-two.md",
    ]


def test_the_stated_count_matches_the_paths_the_message_lists(adr_dir):
    """"claimed by N files" followed by fewer than N paths is a lie the reader
    cannot detect without opening the directory, and is precisely what the
    rendered-text assertion this test replaces could not see."""
    for count in (2, 3, 4):
        names = [f"0007-{index}.md" for index in range(count)]
        report = checker.check(adr_dir(*names), REPO_ROOT)
        message = duplicate_message(report.render(), "0007")

        assert f"claimed by {count} files" in message
        assert len(paths_named(message)) == count


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


def test_the_number_inside_the_document_is_never_read(adr_dir):
    """Filenames only. Content validation is a different check and a different
    decision, and this one must not start making claims about prose."""
    directory = adr_dir("0001-a.md")
    (directory / "0002-b.md").write_text("# ADR 0001: mislabelled\n", encoding="utf-8")

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

    assert not report.ok
    assert any("UNNUMBERED" in problem and name in problem for problem in report.problems)


def test_the_refusal_says_how_to_resolve_it(adr_dir):
    report = checker.check(adr_dir("0001-a.md", "notes.md"), REPO_ROOT)

    assert any("COMPANION_NAMES" in problem for problem in report.problems)


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
    refusals = [
        problem for problem in report.problems if "NON-ASCII NUMBER" in problem
    ]

    assert len(refusals) == 1, report.render()
    message = refusals[0]
    assert f"{digits}-impostor.md" in message
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
    assert any("UNNUMBERED" in problem for problem in report.problems)
    assert not any("NON-ASCII NUMBER" in problem for problem in report.problems)


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

    assert not any("COMPANION_NAMES" in problem for problem in report.problems)


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


# --- anti-vacuity -----------------------------------------------------------


def test_an_empty_directory_is_a_failure(tmp_path):
    """A check that examines nothing must not report success."""
    directory = tmp_path / "adr"
    directory.mkdir()

    report = checker.check(directory, REPO_ROOT)

    assert not report.ok
    assert any("EMPTY" in problem for problem in report.problems)


def test_a_directory_holding_only_companions_is_a_failure(adr_dir):
    """The same defect wearing a disguise: everything present, nothing checked."""
    report = checker.check(adr_dir("README.md"), REPO_ROOT)

    assert not report.ok
    assert any("EMPTY" in problem for problem in report.problems)


# --- the command line -------------------------------------------------------


def test_the_cli_exits_zero_on_the_committed_adrs(capsys):
    assert checker.main([]) == 0
    assert "every number claimed by exactly one file" in capsys.readouterr().out


def test_the_cli_exits_one_on_a_duplicate(adr_dir, capsys):
    """The message reaching stdout is sliced the same way as in the report test.

    The CLI prints `render()` verbatim, so asserting a filename against the
    whole of stdout carried the identical defect: the inventory above the
    problems block satisfied it regardless of what the DUPLICATE line named.
    """
    directory = adr_dir(MERGED_0003, COMPETING_0003)

    assert checker.main([str(directory)]) == 1
    message = duplicate_message(capsys.readouterr().out, "0003")
    assert paths_named(message) == [MERGED_0003, COMPETING_0003]


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
