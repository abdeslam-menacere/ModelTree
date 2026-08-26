"""The guard on `.github/copilot-instructions.md` and the two false positives.

This suite is the guard itself: `test_the_governing_file_resolves` runs the
checker against the real committed file, so a pull request that adds a broken
pointer to it turns this red.

The rest pin the behaviour that makes that first test worth anything. A check
that cannot fail against the defect it names is worthless -- this repository has
already shipped one of those -- so `test_reintroducing_spec_md_fails` restores
the #103 defect and asserts the checker rejects it, and its neighbours assert
the two settled non-issues, `DOCK.md` and `.docks/`, stay green.

The checker lives outside the updater package because it is not an updater
concern, and is loaded by path for the same reason. Its tests live here because
this is already where the repository's stdlib-Python invariants are asserted --
`test_publication_workflow.py` reaches into `.github/` the same way -- and
running them in this suite needs no second pytest project.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CHECKER_PATH = (
    REPO_ROOT / "tools" / "instruction_refs" / "check_instruction_references.py"
)


def _load_checker():
    spec = importlib.util.spec_from_file_location(
        "check_instruction_references", CHECKER_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


checker = _load_checker()


@pytest.fixture()
def document(tmp_path):
    """Write a document to check. Body only -- callers supply the whole text."""

    def write(body: str) -> Path:
        path = tmp_path / "instructions.md"
        path.write_text(body, encoding="utf-8")
        return path

    return write


def references(report) -> set[str]:
    return {finding.reference for finding in report.problems}


# --- the guard itself -------------------------------------------------------


def test_the_governing_file_resolves():
    """Every reference in the committed instructions file points at something."""
    report = checker.check(REPO_ROOT / checker.DEFAULT_DOCUMENT, REPO_ROOT)

    assert report.ok, report.render()


def test_the_default_target_is_the_governing_file():
    """CI passes no argument, so the default is the whole of what it checks."""
    assert checker.DEFAULT_DOCUMENT == Path(".github") / "copilot-instructions.md"
    assert (REPO_ROOT / checker.DEFAULT_DOCUMENT).is_file()


# --- the regression pin -----------------------------------------------------


def test_reintroducing_spec_md_fails(document):
    """The #103 defect, restored. If this passes, the guard is worthless."""
    path = document(
        "# Copilot instructions\n\n"
        "See `SPEC.md` for the autonomy decision.\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "SPEC.md" in references(report)


def test_reintroducing_the_dangling_section_marker_fails(document):
    path = document("See `SPEC.md` \u00a710 for the autonomy decision.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "SPEC.md" in references(report)
    assert "\u00a710 in `SPEC.md`" in references(report)


def test_a_missing_path_fails_even_when_only_mentioned_in_passing(document):
    """Absence has to be *stated*. Merely being conditional is not enough."""
    path = document("If your dock has one, read `BRIEF.md` before starting.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "BRIEF.md" in references(report)


# --- false positive one: a name the document says is absent -----------------


def test_a_name_the_document_states_is_absent_is_not_flagged(document):
    """`DOCK.md`, in the file's own words. The opposite of the SPEC.md defect."""
    path = document(
        "If the CLI generated a `DOCK.md`, read it first.\n"
        "If there is no `DOCK.md`, read the next paragraph.\n"
        "Follow-ups go under `## Follow-ups` in `DOCK.md` if this worktree has "
        "one.\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert any(finding.reference == "DOCK.md" for finding in report.exempt)


def test_the_absence_statement_is_quoted_in_the_report(document):
    """An exemption nobody can see is indistinguishable from a bypass."""
    path = document("There is no `DOCK.md` here.\n")
    report = checker.check(path, REPO_ROOT)

    exemption = next(f for f in report.exempt if f.reference == "DOCK.md")
    assert "no `DOCK.md`" in exemption.message


def test_the_absence_statement_may_wrap_across_a_line(document):
    """The real file wraps "then no\\n`DOCK.md` was generated"."""
    path = document("If the CLI is absent then no\n`DOCK.md` was generated.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()


def test_a_negation_that_is_not_adjacent_does_not_exempt(document):
    """"not documented in `SPEC.md`" does not say SPEC.md is absent."""
    path = document("That decision is not documented in `SPEC.md`.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "SPEC.md" in references(report)


# --- false positive two: the gitignored worktree directory ------------------


def test_the_gitignored_docks_directory_is_not_flagged(document):
    """`.docks/` is where dock worktrees go. A clean checkout has none."""
    path = document("Dock worktrees are created under `.docks/`.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert ".docks/" not in references(report)


def test_git_is_never_asked_about_a_trailing_slash():
    """A blank line in `.gitignore` is reported as matching any path ending "/".

    Passing the reference through as written would therefore mark every missing
    directory as an ignored artefact, which is a silent pass -- the failure mode
    the whole check exists to remove. Asking about a child instead is precise.
    """
    assert checker.is_git_ignored(REPO_ROOT, ".docks/")
    assert checker.is_git_ignored(REPO_ROOT, ".docks")
    assert not checker.is_git_ignored(REPO_ROOT, "docs/nonexistent/")
    assert not checker.is_git_ignored(REPO_ROOT, "drydock.config.json")


def _repo_with_gitignore(root: Path, gitignore_bytes: bytes) -> Path:
    """A throwaway git work tree whose `.gitignore` is written verbatim.

    Bytes, not text, so a caller can plant a lone `\\r` or trailing space that a
    text write on Windows would rewrite. The trailing-slash discipline in
    `is_git_ignored` has to hold whatever the ignore file contains, so the test
    controls the ignore file exactly rather than borrowing the repository's.
    """
    subprocess.run(
        ["git", "init", "--quiet", str(root)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    (root / ".gitignore").write_bytes(gitignore_bytes)
    return root


# The neighbours of a truly-blank line, and whether `git check-ignore` reports a
# bare directory-shaped path as ignored when that line is the whole ignore file
# body around a real pattern. The ones marked True are live traps: on git 2.53 a
# whitespace-only line or a lone carriage return matches every path ending "/".
# `is_git_ignored` must answer "not ignored" for a nonexistent directory through
# all of them, because it never asks about a trailing-slash path.
GITIGNORE_NEIGHBOURS = [
    ("truly_empty_line", b"*.log\n\n.docks/\n"),
    ("space_only_line", b"*.log\n \n.docks/\n"),
    ("tab_only_line", b"*.log\n\t\n.docks/\n"),
    ("comment_line", b"*.log\n# a comment\n.docks/\n"),
    ("trailing_whitespace", b"*.log  \n.docks/\n"),
    ("negation_pattern", b"*.log\n!keep.log\n.docks/\n"),
    ("cr_left_by_crlf", b"*.log\r\n\r\n.docks/\r\n"),
    ("lone_cr_blank_line", b"*.log\n\r\n.docks/\n"),
    ("completely_empty_file", b""),
]


@pytest.mark.parametrize(
    "label, body", GITIGNORE_NEIGHBOURS, ids=[n for n, _ in GITIGNORE_NEIGHBOURS]
)
def test_a_nonexistent_directory_is_never_ignored(tmp_path, label, body):
    """Whatever blank-ish line the ignore file carries, a missing dir is reported.

    This is the guarantee the trailing-slash probe exists to give. Several of
    these bodies -- the whitespace-only line, the lone carriage return -- make
    `git check-ignore` say "ignored" for any path ending "/", so passing the
    reference through as written (`docs/nowhere/`) would exempt it. The two-probe
    design asks about a child that does not end "/", so the answer stays "no".
    """
    repo = _repo_with_gitignore(tmp_path, body)

    assert not checker.is_git_ignored(repo, "docs/nonexistent/")
    assert not checker.is_git_ignored(repo, "docs/nonexistent")


def test_the_whitespace_trap_would_fire_without_the_probe(tmp_path):
    """Pins that the trap is real, so the test above is not vacuous.

    A whitespace-only line makes git report a bare trailing-slash path as
    ignored. If this ever stops being true the guard test above proves nothing,
    and this failing is the signal to revisit it.
    """
    repo = _repo_with_gitignore(tmp_path, b"*.log\n \n.docks/\n")

    naive = subprocess.run(
        ["git", "check-ignore", "--quiet", "--", "docs/nonexistent/"],
        cwd=repo,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

    assert naive.returncode == 0  # git: "ignored" -- the trap
    assert not checker.is_git_ignored(repo, "docs/nonexistent/")  # checker: "no"


def test_a_missing_directory_is_still_reported(document):
    """The end-to-end form of the case above."""
    path = document("Product context lives in `docs/nonexistent/`.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "docs/nonexistent/" in references(report)


def test_the_committed_dock_manifests_are_a_different_thing(document):
    """`.drydock/docks/` is tracked -- the audit trail -- and must resolve."""
    path = document("Do not edit `.drydock/docks/*.json` by hand.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert ".drydock/docks/*.json" in report.candidates


def test_config_values_are_never_extracted(document):
    """Where the naive checker goes wrong: `.docks` is a value inside that JSON.

    This checker reads one document and resolves what that document quotes. It
    never parses `drydock.config.json`, so "docksDir": ".docks" is not a
    reference and cannot be reported as a broken one.
    """
    path = document("Do not use `drydock.config.json` as the test.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.candidates == ["drydock.config.json"]
    assert report.ok, report.render()


# --- what counts as a path --------------------------------------------------


def test_a_naming_template_is_not_a_path(document):
    path = document("ADRs are named `NNNN-kebab-case-title.md`.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert any(
        finding.reference == "NNNN-kebab-case-title.md" for finding in report.exempt
    )


def test_config_keys_are_not_paths(document):
    """`.level` and `.enabled` are not file extensions."""
    path = document("It sets `autonomy.level` to `full`, with `merge.enabled` "
                    "true and `retriesOnGateFail` 2.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.candidates == []
    assert report.ok, report.render()


def test_commands_and_flags_are_not_paths(document):
    path = document(
        "Check with `drydock --version`, run `npm run build`, and never add "
        "`--skip-gates` or `--force`.\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert report.candidates == []
    assert report.ok, report.render()


def test_a_directory_reference_must_be_a_directory(document):
    path = document("Product context lives in `drydock.config.json/`.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "drydock.config.json/" in references(report)


def test_a_glob_that_matches_nothing_fails(document):
    path = document("Manifests live in `.drydock/docks/*.yaml`.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert ".drydock/docks/*.yaml" in references(report)


def test_a_bracketed_route_filename_resolves(document, tmp_path):
    """`[slug].astro` is a real filename here, not a character class.

    Resolution tries the literal name before treating the token as a pattern,
    because glob would read those brackets as "one of s, l, u, g" and miss the
    exact file the reference names.
    """
    routes = tmp_path / "pages"
    routes.mkdir()
    (routes / "[slug].astro").write_text("---\n---\n", encoding="utf-8")
    path = document("Model pages are `pages/[slug].astro`.\n")

    report = checker.check(path, tmp_path)

    assert report.ok, report.render()


# --- slash-bearing tokens that are not paths --------------------------------
#
# A slash alone used to be enough to make a token a path candidate, which meant
# every one of these was reported as a dangling path. A guard that misfires on
# plausible prose gets worked around rather than fixed.


@pytest.mark.parametrize(
    "token",
    [
        "abdeslam-menacere/ModelTree",
        "github/docs",
        "@astrojs/react",
        "@types/node",
        "actions/checkout@v4",
        "https://github.com/abdeslam-menacere/ModelTree/issues/80",
        "http://example.com/a/b",
        "and/or",
        "3.11/3.13",
    ],
)
def test_a_slash_does_not_make_a_token_a_path(document, token):
    path = document(f"Prose mentioning `{token}` in passing.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert token not in report.candidates


def test_narrowing_did_not_stop_it_catching_a_real_broken_path(document):
    """The counterweight: under a directory that exists, a bad path still fails.

    Without this the narrowing could be over-broad and nothing would say so.
    """
    path = document("The rules are in `docs/nonexistent/guide.md`.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "docs/nonexistent/guide.md" in references(report)


def test_a_broken_path_under_an_unknown_directory_still_fails(document):
    """Caught through the extension, not the first segment."""
    path = document("See `nowhere-at-all/guide.md` for it.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert "nowhere-at-all/guide.md" in references(report)


# --- issue citations --------------------------------------------------------


def test_a_bare_issue_citation_is_rejected(document):
    """#3 and #4 here are closed and unrelated: plausible, and wrong."""
    path = document("The rationale is in #3 and the schema work in #4.\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#3", "#4"}


def test_a_qualified_issue_citation_is_accepted(document):
    path = document("See abdeslam-menacere/ModelTree#110 for the guard.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()


def test_the_prescribed_remedy_is_accepted_when_backticked(document):
    """The guard must not punish compliance with its own instruction.

    Rule 2 rejects a bare #N and says to write owner/repo#N. This file backticks
    such things by house style -- `agent:<role>`, `DRYDOCK_ACTOR`, `feat:` -- so
    if the path rule read that as a dangling path, following the remedy would
    trade one failure for another, and the message would not even hint that the
    backticks were the problem.
    """
    path = document("See `abdeslam-menacere/ModelTree#131` for the rationale.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()


def test_an_issue_url_link_is_not_a_bare_citation(document):
    """A full URL says which repository it means more completely than #N does."""
    path = document(
        "Branch protection is "
        "[#80](https://github.com/abdeslam-menacere/ModelTree/issues/80).\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()


def test_a_pull_request_url_link_is_not_a_bare_citation(document):
    path = document("Landed in [#12](https://github.com/o/r/pull/12).\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()


def test_markdown_headings_are_not_issue_citations(document):
    path = document("# Title\n\n## 2. Second\n\nBody.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()


# --- section markers --------------------------------------------------------


def test_a_section_marker_resolving_to_a_real_heading_is_accepted(
    document, tmp_path
):
    target = tmp_path / "guide.md"
    target.write_text("# Guide\n\n## 2. Gates\n\nBody.\n", encoding="utf-8")
    path = document(f"See `{target.name}` \u00a72 for the gate contract.\n")

    report = checker.check(path, tmp_path)

    assert report.ok, report.render()


def test_a_section_marker_with_no_such_heading_is_rejected(document, tmp_path):
    target = tmp_path / "guide.md"
    target.write_text("# Guide\n\n## Gates\n\nBody.\n", encoding="utf-8")
    path = document(f"See `{target.name}` \u00a710 for the gate contract.\n")

    report = checker.check(path, tmp_path)

    assert not report.ok
    assert any("\u00a710" in reference for reference in references(report))


def test_a_section_marker_with_no_document_is_rejected(document):
    path = document("The autonomy decision is at \u00a710.\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok
    assert any("\u00a710" in reference for reference in references(report))


def test_a_section_marker_finds_its_document_past_a_long_code_span(
    document, tmp_path
):
    """Located over the whole text, not over a sliced lookbehind window.

    Slicing can cut a code span in half, which puts the backtick pairing out of
    phase for everything after it and silently loses the document the marker
    points into -- turning a real "that heading does not exist" into a vague
    "no document to resolve against", or vice versa.
    """
    target = tmp_path / "guide.md"
    target.write_text("# Guide\n\n## 2. Gates\n", encoding="utf-8")
    padding = "`" + "x" * 200 + "`"
    path = document(f"{padding}. See `guide.md` \u00a72 for the rest.\n")

    report = checker.check(path, tmp_path)

    assert report.ok, report.render()


# --- the command line -------------------------------------------------------


def test_the_cli_exits_zero_on_the_governing_file(capsys):
    assert checker.main([]) == 0
    assert "OK: every reference resolves." in capsys.readouterr().out


def test_the_cli_exits_one_when_a_reference_is_broken(document, capsys):
    path = document("See `SPEC.md` for the autonomy decision.\n")

    assert checker.main([str(path)]) == 1
    assert "SPEC.md" in capsys.readouterr().out


def test_the_cli_takes_no_flags_that_could_skip_the_check(capsys):
    """A bypass belongs in branch protection, where it is auditable.

    There is no argument parser, so a flag is read as a document path and the
    run ends in a usage error rather than a silent pass.
    """
    assert checker.main(["--skip-gates"]) == 2
    assert checker.main(["--force"]) == 2
    assert checker.main([str(CHECKER_PATH), "extra"]) == 2
    assert "OK" not in capsys.readouterr().out
