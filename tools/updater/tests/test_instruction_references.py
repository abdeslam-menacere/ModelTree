"""The guard on the covered documents, and the two false positives.

This suite is the guard itself: `test_every_covered_document_resolves` runs the
checker over every document CI checks -- `.github/copilot-instructions.md` and
the skill documents -- so a pull request that adds a broken pointer to any of
them turns this red.

The rest pin the behaviour that makes that first test worth anything. A check
that cannot fail against the defect it names is worthless -- this repository has
already shipped one of those -- so `test_reintroducing_spec_md_fails` restores
the #103 defect and asserts the checker rejects it, and its neighbours assert
the two settled non-issues, `DOCK.md` and `.docks/`, stay green.

The "which documents are covered" section pins the scope decision itself, in
both directions: that a skill added later is covered without editing a list, and
that the narrowed rule set applied to skill documents still catches the citation
defect it was widened for. The narrowing is a stated decision recorded in the
checker's module docstring, not an exemption, and a test asserts it stays
visible in the report rather than implied by silence.

Globbing that set rather than listing it adds an axis none of those reach: the
glob can match nothing, and an empty set has no document that could fail, so the
widened half of the check passed most readily when it had lost the most. The
"discovering nothing" section pins that refusal, along with the controls that
keep it from swallowing a small healthy run. The section after it pins what the
report claims to have measured, because a count printed as zero where nothing was
counted is what let a run over 81 backticked spans and a run over nothing print
the same line.

The "wraps across a line break" section pins a fail-open of a different shape. A
backticked reference the file wrapped did not merely go unchecked: the stray
backtick it left behind was read as an *opening* one, which put the pairing out
of phase and swallowed the next real reference on the line the wrap's tail landed
on. Those tests bracket the fix from both sides, because an over-broad one moves
that swallowing onto the line below an unpaired backtick rather than removing it.

The "fenced code blocks" section pins a decision rather than a defect. A
`#`-prefixed token inside a fence is sample content -- `#123456` is a colour --
and the citation rule now says so. Those tests come in pairs on purpose: an
implementation that stops refusing real citations is worse than the false
positive it removes, so every "this is exempt" is matched by the same token one
line outside the block still being refused. The two deliberate non-changes,
indented blocks and inline code spans, are asserted there too, so the decision
recorded in the checker's docstring cannot outrun the code.

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


def exemptions(report) -> set[str]:
    return {finding.reference for finding in report.exempt}


# --- the guard itself -------------------------------------------------------


def test_the_governing_file_resolves():
    """Every reference in the committed instructions file points at something."""
    report = checker.check(REPO_ROOT / checker.DEFAULT_DOCUMENT, REPO_ROOT)

    assert report.ok, report.render()


def test_the_default_target_is_the_governing_file():
    """The governing file leads the covered set, and CI passes no argument."""
    assert checker.DEFAULT_DOCUMENT == Path(".github") / "copilot-instructions.md"
    assert (REPO_ROOT / checker.DEFAULT_DOCUMENT).is_file()
    assert checker.covered_documents(REPO_ROOT)[0] == (
        REPO_ROOT / checker.DEFAULT_DOCUMENT,
        checker.FULL,
    )


def test_the_reviewer_skill_scope_citation_resolves():
    """The gate-scope.mjs pointer added to the reviewer skill cannot rot silently.

    `test_the_governing_file_resolves` guards copilot-instructions.md. The
    reviewer skill is now covered too, but only for issue citations -- its paths
    are document-relative, so the checker does not resolve them (see the scope
    section of the checker's module docstring). This asserts that one citation
    under the full rule set anyway, so a moved or renamed gate turns it red
    rather than waiting for a scope decision the checker has deliberately
    deferred.
    """
    skill = REPO_ROOT / ".github" / "skills" / "modeltree-review" / "SKILL.md"
    cited = ".github/skills/modeltree-gates/scripts/gate-scope.mjs"
    report = checker.check(skill, REPO_ROOT, checker.FULL)

    assert cited in report.candidates
    assert any(
        finding.reference == cited for finding in report.resolved
    ), report.render()


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


# --- a code span the file wraps across a line break --------------------------
#
# The defect these pin is not that a wrapped reference went unchecked. It is
# that the stray backtick left over from the failed match was read as an
# *opening* one, which put the pairing out of phase and silently swallowed the
# next real reference on the line the wrap's tail landed on. A wrap cost two
# references, and the second of them was a reference the author wrote in the
# ordinary way and the checker had in hand.
#
# Bracketed from both sides on purpose. Under-matching swallows the next
# reference; over-matching glues an unpaired backtick to the line below it and
# swallows a reference the old scan resynchronised onto, or reports a wrapped
# span that is not a broken path at all. A fix that trades one of those for the
# other has moved the fail-open rather than closed it.


def test_a_wrapped_span_does_not_swallow_the_next_reference(document):
    """The fail-open, exactly as measured on the reporting issue.

    `web/src/data/` and `schema.ts` are one reference the document wrapped. The
    reference after it is broken and has nothing to do with the wrap, and it is
    the one that used to disappear: the wrapped span's closing backtick was
    consumed as an opener, so the checker never saw the span that followed.
    """
    path = document(
        "See `web/src/data/\nschema.ts` and `truly/missing.md` here.\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert not report.ok, report.render()
    assert "truly/missing.md" in references(report)
    reported = next(f for f in report.problems if f.reference == "truly/missing.md")
    # Reported where a reader will look for it, not at the line the wrap opened.
    assert reported.line == 2


def test_wrapping_a_span_does_not_change_what_follows_it(document):
    """The control that proves the test above discriminates.

    Byte-identical but for the newline. Before the fix these two inputs
    disagreed -- the unwrapped one failed, the wrapped one passed -- which is
    the whole defect stated as a difference. They must now agree.
    """
    wrapped = checker.check(
        document("See `web/src/data/\nschema.ts` and `truly/missing.md` here.\n"),
        REPO_ROOT,
    )
    unwrapped = checker.check(
        document("See `web/src/data/schema.ts` and `truly/missing.md` here.\n"),
        REPO_ROOT,
    )

    assert references(unwrapped) == {"truly/missing.md"}
    assert references(wrapped) == references(unwrapped)


def test_a_wrapped_reference_is_declined_rather_than_flagged(document):
    """The recorded decision: seen enough to stay in phase, not resolved.

    What the document renders is the two fragments joined by a *space*, so the
    token it presents carries whitespace and is not a path. Joining them
    without the space would be a guess at what the author meant, and a guess is
    the failure this checker exists to prevent -- so a wrapped reference is
    neither resolved nor reported, exactly as `check_section_markers` already
    declines it. The name here does not exist, so an over-broad fix that
    resolved the join would turn this red.
    """
    path = document("See `truly/\nmissing.md` for the rest.\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert "truly/missing.md" not in report.candidates


def test_an_unpaired_backtick_still_resynchronises_at_the_line_end(document):
    """The other side of the bracket, and the one an over-broad fix breaks.

    A backtick with no partner is not a wrap. Letting it pair with the first
    backtick on the line below moves the swallowing rather than removing it:
    the reference on that next line is the one that would vanish, which is the
    same fail-open at a new address.
    """
    path = document(
        "See `an unpaired backtick\nand then `truly/missing.md` here.\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert not report.ok, report.render()
    assert "truly/missing.md" in references(report)


@pytest.mark.parametrize(
    "second_line",
    ["`truly/missing.md` here.", "   `truly/missing.md` here."],
    ids=["flush", "indented"],
)
def test_a_wrap_does_not_close_on_the_next_lines_opening_backtick(
    document, second_line
):
    """The empty tail, which is the other way a wrap can swallow a reference.

    Requiring the fragment after the break to be non-empty is not tidiness. Let
    a wrap close on nothing and it closes instead on the backtick that was
    *opening* the next reference, consuming it whole -- and that reference is
    one the un-widened scan reported, so admitting it would be a regression
    against the merge base rather than a residual carried forward.

    The indented case is here because indentation is skipped before the tail is
    read, so "empty" and "whitespace then a backtick" are the same hazard
    reached by two routes, and a rule that closes only the first leaves the
    fail-open reachable.
    """
    path = document(f"See `docs/adr\n{second_line}\n")
    report = checker.check(path, REPO_ROOT)

    assert not report.ok, report.render()
    assert "truly/missing.md" in references(report)


def test_a_wrapped_span_carrying_whitespace_is_a_disclosed_residual(document):
    """Pins the limit, so the documentation cannot outrun the code.

    Only a wrap whose fragments are both whitespace-free is admitted, and a
    wrapped command line is not that. Such a wrap still goes out of phase and
    still swallows the reference after it -- the very fail-open this rule
    narrows -- because that text is indistinguishable from a stray unpaired
    backtick followed by prose, and admitting it was measured to lose a broken
    path the narrower rule catches.

    Asserted rather than described so the claim in `.github/workflows/README.md`
    stays checkable: if a later change closes this, the test goes red and says
    so, and the row it contradicts gets rewritten instead of quietly becoming
    false. The control is the same reference unwrapped, which must be reported,
    so the test cannot pass merely because the name resolved.
    """
    swallowed = document(
        "Run `git merge-base\nHEAD refs/heads/main` and `truly/missing.md` here.\n"
    )
    report = checker.check(swallowed, REPO_ROOT)

    assert report.ok, report.render()
    assert "truly/missing.md" not in references(report)

    control = document("Run `git merge-base` and `truly/missing.md` here.\n")
    control_report = checker.check(control, REPO_ROOT)

    assert "truly/missing.md" in references(control_report)


def test_a_fenced_block_does_not_pair_across_its_own_lines(document):
    """A fence is three backticks and a newline, and it stays inert.

    The checker does not model fenced blocks -- a separate, deliberately
    separate defect -- and widening the span scan must not change that by
    accident. If a fence delimiter started pairing with the line under it, the
    references inside the block would shift phase and the ones after it with
    them.
    """
    path = document(
        "Example:\n\n```\nSee `truly/missing.md` in here.\n```\n\n"
        "And `also/missing.md` after it.\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"truly/missing.md", "also/missing.md"}


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


# --- fenced code blocks -------------------------------------------------------
#
# A `#`-prefixed token inside a fence is sample content: a colour, a comment, a
# command line. The citation rule used to read every one of them as a citation,
# which was harmless only because nothing in the covered set had yet written one
# -- and the covered set had just grown to eight example-heavy skill documents
# carrying 36 fence markers between them.
#
# These bracket the change from both sides on purpose. An implementation that
# stops refusing real citations is a worse defect than the one being fixed, so
# for every test that asserts something is now exempt there is one asserting
# that the same token, one line outside the block, is still refused.


def test_a_css_colour_in_a_fenced_block_is_not_a_citation(document):
    """`#123456` is a colour. It has never pointed at an issue anywhere."""
    path = document("Palette:\n\n```css\n.a { color: #123456; }\n```\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert "#123456" not in references(report)


def test_a_quoted_shell_argument_in_a_fenced_block_is_not_a_citation(document):
    """The second shape the issue names: a `#` that is an argument, not a link."""
    path = document("Search:\n\n```bash\ngrep '#42' notes.txt\n```\n")
    report = checker.check(path, REPO_ROOT)

    assert report.ok, report.render()
    assert "#42" not in references(report)


def test_a_bare_citation_outside_a_fence_is_still_refused(document):
    """The other side of the bracket, in a document that also has a fence.

    The exemption is the block, not the document. If the presence of a fence
    anywhere relaxed the rule for everything, the check would go quiet on
    exactly the documents it was widened to cover.
    """
    path = document(
        "The rationale is in #3.\n\n```css\n.a { color: #123456; }\n```\n\n"
        "The schema work is in #4.\n"
    )
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#3", "#4"}


def test_a_citation_beside_a_fenced_block_is_still_refused(document):
    """Adjacency does not exempt: the delimiter lines are the boundary.

    Written with no blank line either side, so the citations are as close to the
    block as Markdown allows without being in it. An off-by-one in the range
    ends -- taking the opening line's newline, or stopping one line late --
    shows up here and nowhere else.
    """
    path = document("Before #11\n```\n#123456\n```\nAfter #12\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#11", "#12"}
    assert exemptions(report) == {"#123456"}


def test_a_citation_in_the_info_string_is_still_refused(document):
    """The opening delimiter is a line of the document, not of the block."""
    path = document("```text #13\n#123456\n```\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#13"}


def test_the_fenced_exemption_is_reported_rather_than_silent(document):
    """Every other exemption here prints its evidence, and so does this one.

    A skip nobody can see in the CI log is the fail-open this checker exists to
    avoid: it would leave a reader unable to tell a document with nothing to
    report from a rule that quietly stopped looking. The message names the
    delimiter line rather than the citation's own line, because the fence is the
    fact being asserted about.
    """
    path = document("A\nB\n```\n#123456\n```\n")
    report = checker.check(path, REPO_ROOT)

    exemption = next(
        (f for f in report.exempt if f.reference == "#123456"), None
    )

    assert exemption is not None, report.render()
    assert exemption.line == 4
    assert "line 3" in exemption.message


def test_the_exemption_holds_under_the_narrowed_coverage(document):
    """Skill documents are checked for citations only, and they hold the fences.

    The narrowed coverage is the whole reason this matters: every document that
    carries a fenced block in this repository is checked under it.
    """
    path = document("```css\n.a { color: #123456; }\n```\n\nAnd #4 after it.\n")
    report = checker.check(path, REPO_ROOT, checker.CITATIONS_ONLY)

    assert references(report) == {"#4"}
    assert exemptions(report) == {"#123456"}


def test_a_tilde_fence_is_a_fence(document):
    """CommonMark's other delimiter, modelled even though nothing writes it yet.

    A fence model that handles the syntax in use today and not the rest leaves
    whoever first writes `~~~` with the exact surprise this removes, and the
    repository does already use four-backtick fences elsewhere, so the wider
    syntax is not hypothetical.
    """
    path = document("~~~css\n.a { color: #123456; }\n~~~\n\nAnd #7 after.\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#7"}
    assert exemptions(report) == {"#123456"}


def test_a_tilde_line_does_not_close_a_backtick_fence(document):
    """A closing delimiter is the same character as the one that opened."""
    path = document("```\n#111\n~~~\n#222\n```\n\nAnd #7 after.\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#7"}
    assert exemptions(report) == {"#111", "#222"}


def test_a_longer_fence_is_not_closed_by_a_shorter_one(document):
    """A four-backtick fence is how a document shows a three-backtick one.

    If the shorter inner delimiter closed the block, the second half of the
    example would fall outside it and every token in it would be read as prose
    -- and the block after that would be inside out.
    """
    path = document("````markdown\n```\n#123456\n```\n````\n\nAnd #7 after.\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#7"}
    assert exemptions(report) == {"#123456"}


def test_an_unclosed_fence_runs_to_the_end_of_the_document(document):
    """What CommonMark says, and therefore what a reader sees rendered.

    Ruling the other way -- an unpaired delimiter is inert -- was considered and
    rejected: it would make this checker disagree with every renderer about
    where the code is, which trades one surprise for a subtler one. The control
    is the citation *before* the fence, which must still be refused, so the test
    cannot pass by exempting the whole document.
    """
    path = document("Intro #1 here.\n\n```\n#123456\nand #99 too\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#1"}
    assert exemptions(report) == {"#123456", "#99"}


def test_a_span_that_merely_looks_like_a_fence_is_not_one(document):
    """A backtick fence's info string may not itself contain a backtick.

    ``` `x` ``` on a line of its own is how CommonMark writes a code span that
    contains backticks. Read as an opening delimiter it would never close, and
    would exempt every line beneath it -- so the guard declining it is the
    difference between exempting one block and exempting the rest of the
    document. The second line is the easier half of the same question: a
    delimiter has to begin its line to be one at all.
    """
    path = document("``` `x` ```\n\nProse ``` `y` ``` and then #8.\n\nAlso #9.\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#8", "#9"}


def test_a_fence_indented_four_spaces_is_not_recognised(document):
    """A stated residual, pinned so the documentation cannot outrun the code.

    Three spaces is the whole of the indentation the model allows, so a fence
    nested deeper -- inside a list item, say -- is not seen as one. It fails
    closed: the citation stays refused rather than being exempted by a block the
    checker cannot make out, which is what makes this a residual and not a
    defect. The control is the same block unindented, which must be exempt, so
    the test cannot pass merely because nothing was exempted anywhere.
    """
    indented = document("Example:\n\n    ```\n    #42\n    ```\n")
    control = document("Example:\n\n```\n#42\n```\n")

    assert references(checker.check(indented, REPO_ROOT)) == {"#42"}
    assert references(checker.check(control, REPO_ROOT)) == set()


def test_an_indented_code_block_is_still_scanned(document):
    """Deliberate, and the opposite of what the fence decision does.

    Four-space indentation cannot be told from a list continuation or from
    indented prose without the block-structure parser this file does not have,
    and these documents indent prose far more often than code. Exempting it
    would relax the rule over most of a document to catch a case that has not
    arisen -- widening the fail-open rather than closing it. Recorded as a
    decision in the checker's docstring, and asserted here so the documentation
    cannot outrun the code.
    """
    path = document("Example:\n\n    See #42 for the rationale.\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#42"}


def test_a_backticked_citation_is_still_refused(document):
    """The other half of the same deliberate answer.

    A code span is inline content inside a paragraph: "see `#42`" is prose, and
    backticks change the typeface rather than the meaning, so it misdirects a
    reader exactly as the unbackticked form does. Exempting it would also hand
    every author a one-character way to silence the rule -- while the rule's own
    remedy says to write owner/repo#N *unbackticked*.
    """
    path = document("See `#42` for the rationale.\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"#42"}


def test_the_fence_model_did_not_reach_the_path_rule(document):
    """Only the citation rule consults it, and the two now answer differently.

    A broken path inside a fenced example is still a path a reader may copy, so
    it is still reported. That divergence is the decision, not an unfinished
    half of one, and asserting both answers off the same document is what stops
    a later change quietly extending the exemption to paths.
    """
    path = document("```\nSee `truly/missing.md`, tracked in #42.\n```\n")
    report = checker.check(path, REPO_ROOT)

    assert references(report) == {"truly/missing.md"}
    assert exemptions(report) == {"#42"}


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


def test_the_cli_exits_zero_over_the_whole_covered_set(capsys):
    """No argument checks every covered document, which is what CI runs."""
    assert checker.main([]) == 0
    out = capsys.readouterr().out

    assert out.rstrip().splitlines()[-1].startswith("OK: ")
    assert "covered documents checked, every reference resolves." in out
    for document, _ in checker.covered_documents(REPO_ROOT):
        assert document.name in out


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


# --- which documents are covered --------------------------------------------
#
# The checker used to read one document, so a rule it enforced and a violation
# of that rule could both exist and never meet: the reviewer skill carried a
# bare `#59` that the checker rejected on sight when pointed at it, and nothing
# ever pointed it there. These pin the scope that closed that, and -- just as
# importantly -- pin the edge of it, so the narrowing stays a stated decision
# rather than drifting into a blind spot nobody can see.


def test_every_covered_document_resolves():
    """The widened guard itself: every document CI checks is green."""
    failed = [
        report
        for report in (
            checker.check(document, REPO_ROOT, coverage)
            for document, coverage in checker.covered_documents(REPO_ROOT)
        )
        if not report.ok
    ]

    assert not failed, "\n\n".join(report.render() for report in failed)


def test_every_tracked_skill_document_is_covered():
    """Asked of git, not of the glob the checker uses.

    Comparing the covered set against the checker's own glob would only prove
    the glob equals itself. `git ls-files` is the independent answer to "what
    skill documents does this repository have", so a glob that stops matching
    -- a renamed directory, a nested layout, a stray typo -- turns this red.
    """
    tracked = subprocess.run(
        ["git", "ls-files", "--", ".github/skills/**/*.md", ".github/skills/*.md"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    expected = {Path(name).as_posix() for name in tracked}
    covered = {
        document.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
        for document, _ in checker.covered_documents(REPO_ROOT)
    }

    assert expected, "no tracked skill documents: the query itself is wrong"
    assert expected <= covered, sorted(expected - covered)


def test_a_new_skill_document_is_covered_without_touching_a_list(tmp_path):
    """The whole point of globbing the set rather than listing it.

    A document added later must be covered the day it lands. If this needed an
    edit to a roster somewhere, the next skill would be silently unchecked --
    which is the defect, restored.
    """
    added = tmp_path / ".github" / "skills" / "modeltree-newcomer" / "SKILL.md"
    added.parent.mkdir(parents=True)
    added.write_text("# Newcomer\n\nBody.\n", encoding="utf-8")

    covered = dict(checker.covered_documents(tmp_path))

    assert added in covered
    assert covered[added] == checker.CITATIONS_ONLY


def test_the_governing_file_is_checked_under_the_full_rule_set():
    governing = REPO_ROOT / checker.DEFAULT_DOCUMENT

    assert checker.coverage_for(governing, REPO_ROOT) == checker.FULL
    assert checker.coverage_for(governing, REPO_ROOT).resolves_paths


def test_a_skill_document_is_checked_for_citations_only():
    """The stated narrowing: skill paths are document-relative, so unresolved."""
    skill = REPO_ROOT / ".github" / "skills" / "modeltree-review" / "SKILL.md"

    assert checker.coverage_for(skill, REPO_ROOT) == checker.CITATIONS_ONLY
    assert not checker.coverage_for(skill, REPO_ROOT).resolves_paths


def test_an_uncovered_document_gets_the_full_rule_set(document):
    """An unrecognised name must not be a way to shed rules.

    Defaulting an unknown document to the narrower coverage would turn "not in
    the covered set" into a bypass. It defaults to the stricter one instead.
    """
    path = document("Body.\n")

    assert checker.coverage_for(path, REPO_ROOT) == checker.FULL


def test_a_bare_citation_in_a_skill_document_still_fails(document):
    """The rule that was never pointed at the skills, now pointed at them."""
    path = document("Acceptance is unanimous for a long-tail creator (#59).\n")
    report = checker.check(path, REPO_ROOT, checker.CITATIONS_ONLY)

    assert not report.ok
    assert "#59" in references(report)


def test_citations_only_coverage_does_not_resolve_paths(document):
    """Pins the exact edge of the narrowing, in both directions at once.

    A dangling path is not reported under this coverage -- that is the stated
    decision -- while a bare citation in the very same document still is. A
    test that only asserted the second half would pass just as well if the
    narrowing had quietly swallowed the citation rule too.
    """
    path = document(
        "See `nowhere-at-all/guide.md`, and the rationale in #59.\n"
    )
    report = checker.check(path, REPO_ROOT, checker.CITATIONS_ONLY)

    assert references(report) == {"#59"}
    assert report.candidates == []


def test_the_reviewer_skill_no_longer_carries_a_bare_citation():
    """The named instance from the issue, fixed rather than exempted.

    The citation is still made -- it is a real and relevant pointer -- but it
    now says which repository it means, which is all the rule ever asked.
    """
    skill = REPO_ROOT / ".github" / "skills" / "modeltree-review" / "SKILL.md"
    body = skill.read_text(encoding="utf-8")
    report = checker.check(skill, REPO_ROOT, checker.CITATIONS_ONLY)

    assert report.ok, report.render()
    assert "abdeslam-menacere/ModelTree#59" in body


def test_the_verdict_names_the_document_it_checked(document):
    """It used to claim every failure was in "the file every agent reads first".

    That was true only while the checker could never be pointed anywhere else.
    Widening the scope made it wrong for most of what it now reads, so the
    message names the document instead of asserting which one it must be.
    """
    path = document("The rationale is in #3.\n")
    report = checker.check(path, REPO_ROOT, checker.CITATIONS_ONLY)
    rendered = report.render()

    assert f"FAIL: a reference in {report.display} points at nothing." in rendered
    assert "the file every agent reads first" not in rendered


def test_the_report_states_which_rules_it_applied(document):
    """An exemption nobody can see is indistinguishable from a bypass.

    The narrowed coverage is a deliberate decision, so every report says which
    rules produced its verdict rather than leaving a reader of the CI log to
    infer it from what is missing.
    """
    path = document("Body.\n")

    full = checker.check(path, REPO_ROOT, checker.FULL).render()
    narrow = checker.check(path, REPO_ROOT, checker.CITATIONS_ONLY).render()

    assert "rules applied: paths, issue citations and section markers" in full
    assert "rules applied: issue citations only" in narrow


def test_the_run_verdict_reports_a_failure_anywhere_in_the_set(
    tmp_path, monkeypatch, capsys
):
    """A green document must not be able to carry a red one over the line.

    Each document prints its own verdict, so a log read from the bottom could
    otherwise end on an `OK:` while an earlier document had failed. The run
    prints its own verdict last.
    """
    governing = tmp_path / checker.DEFAULT_DOCUMENT
    governing.parent.mkdir(parents=True)
    governing.write_text("# Instructions\n\nNothing to resolve.\n", encoding="utf-8")
    skill = tmp_path / ".github" / "skills" / "modeltree-newcomer" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("# Newcomer\n\nPer #59.\n", encoding="utf-8")
    monkeypatch.setattr(checker, "REPO_ROOT", tmp_path)

    assert checker.main([]) == 1
    out = capsys.readouterr().out

    assert out.rstrip().splitlines()[-1] == (
        "FAIL: 1 of 2 covered documents make a reference that points at nothing."
    )


def test_the_workflow_runs_on_every_covered_document():
    """A covered document CI never triggers on is not actually covered.

    The checker's scope and the workflow's path filter are two halves of one
    decision: widening the first without the second would leave a skill change
    unchecked on every pull request that touched only skills.
    """
    yaml = pytest.importorskip("yaml", reason="PyYAML is part of the dev extra")
    workflow = yaml.safe_load(
        (
            REPO_ROOT / ".github" / "workflows" / "instruction-references.yml"
        ).read_text(encoding="utf-8")
    )
    # YAML 1.1 reads a bare `on` key as the boolean True.
    triggers = workflow.get("on", workflow.get(True))

    for event in ("pull_request", "push"):
        paths = triggers[event]["paths"]
        assert ".github/copilot-instructions.md" in paths
        assert ".github/skills/**" in paths
        assert "tools/instruction_refs/**" in paths


# --- discovering nothing is itself the failure -------------------------------
#
# The covered set is globbed rather than listed, which is what makes a new skill
# covered the day it lands. It also buys a failure mode a list does not have: the
# glob can match nothing, and an empty set holds no document that could fail. The
# widened half of the check therefore passed most readily when it had lost the
# most -- one skill carrying a bare citation was caught, every skill gone was not.
#
# These are the emptiness axis, and none of the tests above reaches it. The
# section above varies *which* documents are in the covered set and what they
# contain; every one of them runs against a set with something in it. An adjacent
# negative test has more than once made a hole in this repository look covered, so
# this says outright that those cases cannot cover this one.
#
# Three of the eight below are controls on innocent input rather than probes of
# the defect: the smallest healthy run must still pass, a missing governing file
# must still be reported as itself, and a named-document run must not start
# printing a run verdict. A guard on emptiness is likeliest to go wrong by
# swallowing exactly those.


def fake_repo(root: Path, skills: dict[str, str]) -> Path:
    """A minimal repository: the governing file, plus the named skill documents.

    Built on disk rather than mocked because discovery is a glob against a real
    tree, and the state under test -- that glob matching nothing -- is only
    honestly reproduced by there being nothing for it to match.
    """
    governing = root / checker.DEFAULT_DOCUMENT
    governing.parent.mkdir(parents=True, exist_ok=True)
    governing.write_text("# Instructions\n\nNothing to resolve.\n", encoding="utf-8")
    for relative, body in skills.items():
        target = root / ".github" / "skills" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
    return root


def test_a_run_that_discovers_no_skill_documents_is_refused(
    tmp_path, monkeypatch, capsys
):
    """A scan of nothing is not a pass.

    With the skills gone the run checked one document, skipped the run-level
    verdict because only one report existed, and exited 0 -- so the state in
    which this check had stopped checking was the state it reported success in.
    """
    monkeypatch.setattr(checker, "REPO_ROOT", fake_repo(tmp_path, {}))

    assert checker.main([]) == 2
    captured = capsys.readouterr()

    assert checker.SKILL_DOCUMENTS_GLOB in captured.err
    assert "A scan of nothing is not a pass." in captured.err


def test_the_refusal_leaves_nothing_that_reads_as_a_pass(
    tmp_path, monkeypatch, capsys
):
    """The exit code is not the only thing a reader goes on.

    The defect was that a zero-discovery run was *indistinguishable* from a
    healthy one, and it looked healthy because the last line it printed was an
    `OK:`. So the refusal must not leave one behind on stdout.
    """
    monkeypatch.setattr(checker, "REPO_ROOT", fake_repo(tmp_path, {}))

    assert checker.main([]) == 2
    captured = capsys.readouterr()

    assert "OK:" not in captured.out
    assert "Checking " not in captured.out


def test_the_refusal_does_not_claim_a_cause(tmp_path, monkeypatch, capsys):
    """It says discovery returned nothing, not why.

    A renamed directory, a changed layout, a broken glob and the wrong working
    directory all produce this identical input, so naming one of them would be a
    guess printed as a diagnosis. The message disclaims that explicitly.
    """
    monkeypatch.setattr(checker, "REPO_ROOT", fake_repo(tmp_path, {}))
    checker.main([])

    assert "does not establish why" in capsys.readouterr().err


def test_the_smallest_healthy_run_is_not_swallowed_by_the_guard(
    tmp_path, monkeypatch, capsys
):
    """Control. One clean skill document is a pass, not an emptiness.

    The case an emptiness guard is likeliest to break: a set small enough to
    look empty to a sloppy check.
    """
    root = fake_repo(tmp_path, {"newcomer/SKILL.md": "# N\n\nSee owner/repo#1.\n"})
    monkeypatch.setattr(checker, "REPO_ROOT", root)

    assert checker.main([]) == 0
    out = capsys.readouterr().out

    assert out.rstrip().splitlines()[-1] == (
        "OK: 2 covered documents checked, every reference resolves."
    )


def test_a_missing_governing_file_is_still_reported_as_itself(
    tmp_path, monkeypatch, capsys
):
    """Control. The emptiness guard must not absorb the neighbouring refusal.

    An empty tree is missing the governing file *and* every skill. Both are
    exit 2, so the guard could quietly take over the message without changing
    any exit code, and the more specific diagnosis would be lost.
    """
    monkeypatch.setattr(checker, "REPO_ROOT", tmp_path)

    assert checker.main([]) == 2

    assert "no such document" in capsys.readouterr().err


def test_discovery_finds_the_skill_documents_this_repository_has():
    """The guard is only worth something if it is off in the healthy case.

    Asserted against the real tree, so a glob that stops matching here turns
    this red rather than turning the whole check into a silent pass.
    """
    assert checker.discovery_problem(REPO_ROOT) is None
    assert checker.skill_documents(REPO_ROOT)


def test_a_discovery_run_states_its_count_even_for_a_single_document(
    tmp_path, monkeypatch, capsys
):
    """The run verdict is conditioned on the mode, not on the count.

    It used to be printed only when more than one report existed, which meant
    the single run that most needed to state its count -- the one that had
    discovered nothing -- was the one run that stated none. The guard above now
    refuses that run before it gets here, so this stubs the guard out to assert
    the second half independently: even if emptiness were ever allowed through,
    the log would say how many documents it read rather than ending on one
    document's OK.
    """
    monkeypatch.setattr(checker, "REPO_ROOT", fake_repo(tmp_path, {}))
    monkeypatch.setattr(checker, "discovery_problem", lambda *_, **__: None)

    assert checker.main([]) == 0
    out = capsys.readouterr().out

    assert out.rstrip().splitlines()[-1] == (
        "OK: 1 covered document checked, every reference resolves."
    )


def test_a_named_document_run_prints_no_run_verdict(document, capsys):
    """Control. Naming a document is not a discovery run.

    A run over exactly the document asked for cannot be wrong about which
    documents it read, so it has no count to reconcile. Printing a run verdict
    there would be noise, and would make the verdict stop meaning "this is what
    the covered set did".
    """
    path = document("Body with no references.\n")

    assert checker.main([str(path)]) == 0

    assert "covered document" not in capsys.readouterr().out


# --- what the report says it measured ----------------------------------------


def test_backticked_spans_are_counted_under_the_narrowed_rules(document):
    """The counter is a fact about the document, not a by-product of a rule.

    It used to be incremented inside `check_paths`, so a document checked for
    citations only reported zero spans -- not "not measured", a plain zero,
    which reads as a measurement. Every skill document in this repository
    reported `0 backticked spans, 0 path-like references` while one of them had
    81, and that erased the single signal that would have shown a run over
    nothing at a glance.
    """
    path = document("Run `npm run validate` from `web/`, per `tools/x.py`.\n")

    narrow = checker.check(path, REPO_ROOT, checker.CITATIONS_ONLY)
    full = checker.check(path, REPO_ROOT, checker.FULL)

    assert narrow.spans == 3
    assert narrow.spans == full.spans


def test_an_unmeasured_path_count_is_not_printed_as_zero(document):
    """Say it was not measured. Do not print a zero that reads as a finding."""
    path = document("Run `npm run validate` from `web/`.\n")

    rendered = checker.check(path, REPO_ROOT, checker.CITATIONS_ONLY).render()

    assert "path-like references not measured" in rendered
    assert "0 path-like references" not in rendered


def test_the_live_skill_documents_report_the_spans_they_have():
    """Against the real tree, because that is where the false zero was printed.

    Reads the count off the document itself rather than restating a number here:
    a hand-written total is correct only against one commit, and the point is
    that the report agrees with the file, not that it agrees with this test.
    """
    for skill in checker.skill_documents(REPO_ROOT):
        text = skill.read_text(encoding="utf-8")
        expected = len(checker.CODE_SPAN_RE.findall(text))
        report = checker.check(skill, REPO_ROOT, checker.CITATIONS_ONLY)

        assert report.spans == expected, skill


def test_the_suite_reruns_when_what_it_asserts_changes():
    """A guard that cannot run is not a guard.

    The covered set is derived from `.github/skills/**`, and the assertions that
    the set is complete and that a zero-discovery run is refused both live in
    this suite -- which runs under `updater-tests.yml`. While that workflow's
    filter omitted the skills directory, a pull request that renamed or emptied
    it was the one pull request that would never run the tests written to catch
    exactly that. The same argument covers the instruction-reference workflow,
    whose own path filter this suite asserts.
    """
    yaml = pytest.importorskip("yaml", reason="PyYAML is part of the dev extra")
    workflow = yaml.safe_load(
        (
            REPO_ROOT / ".github" / "workflows" / "updater-tests.yml"
        ).read_text(encoding="utf-8")
    )
    # YAML 1.1 reads a bare `on` key as the boolean True.
    triggers = workflow.get("on", workflow.get(True))

    for event in ("pull_request", "push"):
        paths = triggers[event]["paths"]
        assert "tools/instruction_refs/**" in paths
        assert ".github/skills/**" in paths
        assert ".github/workflows/instruction-references.yml" in paths

