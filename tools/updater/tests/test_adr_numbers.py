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

The checker lives outside the updater package because it is not an updater
concern, and is loaded by path for the same reason -- the arrangement
`test_instruction_references.py` already uses. Its tests live here because this is
where the repository's stdlib-Python invariants are asserted, and running them in
this suite needs no second pytest project.
"""

from __future__ import annotations

import importlib.util
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
    go and find the other file. Both names and the number, in the message."""
    report = checker.check(adr_dir(MERGED_0003, COMPETING_0003), REPO_ROOT)
    rendered = report.render()

    assert "ADR 0003" in rendered
    assert MERGED_0003 in rendered
    assert COMPETING_0003 in rendered


def test_every_file_on_a_contested_number_is_named(adr_dir):
    """Three claimants report three paths, not the first two."""
    report = checker.check(
        adr_dir("0007-one.md", "0007-two.md", "0007-three.md"), REPO_ROOT
    )

    assert report.duplicates["0007"] == [
        "0007-one.md",
        "0007-three.md",
        "0007-two.md",
    ]


def test_two_separate_collisions_are_both_reported(adr_dir):
    """Reporting only the first would hide the second behind a fix for the
    first, so the same pull request would fail twice for different reasons."""
    report = checker.check(
        adr_dir("0004-a.md", "0004-b.md", "0009-c.md", "0009-d.md"), REPO_ROOT
    )

    assert numbers(report) == {"0004", "0009"}


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
    """An exemption nobody can see is indistinguishable from a bypass."""
    report = checker.check(adr_dir("0001-a.md", "README.md"), REPO_ROOT)
    rendered = report.render()

    assert "ignored: README.md" in rendered
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
    directory = adr_dir(MERGED_0003, COMPETING_0003)

    assert checker.main([str(directory)]) == 1
    output = capsys.readouterr().out
    assert MERGED_0003 in output
    assert COMPETING_0003 in output


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
