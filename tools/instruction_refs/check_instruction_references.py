"""Resolve the references the governing file and the skill documents make.

The governing file is the one every agent is required to read first. A pointer in
it that resolves to nothing is not a cosmetic defect: an agent reads
"See `SPEC.md` for the autonomy decision", goes looking, finds nothing, and has
no signal about what to do next -- so it guesses. Silent guessing is the failure
this whole system exists to prevent. `SPEC.md` was cited twice, with a dangling
section marker, and survived because nothing checked. #103 fixed the instances;
this checks the class.

Three kinds of reference, extracted mechanically -- never from a hand-maintained
list, which can go stale exactly the way the prose did:

1. Paths. A backticked span with no whitespace that either contains "/" or ends
   in a known file extension. It must exist in the working tree.
2. Issue citations. A bare "#N" is rejected outright. In this repository #3 and
   #4 resolve to two closed, unrelated issues, so an agent following a bare
   number lands somewhere plausible and wrong -- worse than landing nowhere.
   Write "owner/repo#N", which says which repository it means.
3. Section markers (U+00A7 followed by a number). Each must attach to a path
   reference, and that document must carry a heading with that number.

Which documents are covered, and why not all of them
----------------------------------------------------

The governing file, plus every `.github/skills/**/*.md`. The set is globbed, not
listed, so a skill added tomorrow is covered the day it lands rather than the day
somebody remembers to extend a list.

Globbing buys that at the price of a failure mode a list does not have: the glob
can match nothing, and a set that is empty has no document that could fail. So a
discovery run that finds no skill documents is refused outright, with exit 2,
before anything is checked. Without that refusal the widened half of this check
passed most readily when it had lost the most -- one skill carrying a bare
citation was caught, every skill gone was not -- which is a fail-open in the very
guard that exists to notice that the skills stopped being read. The sibling
checker over the same directory settles this the same way and says so in the same
words: a scan of nothing is not a pass (see
`.github/scripts/check-skill-doc-test-counts.mjs`).

The refusal states only that discovery returned no files and deliberately does not
name a cause, because a renamed directory, a changed layout, a broken glob and the
wrong working directory all produce this identical input and none of them is
distinguishable in it. There is no --allow-empty: this repository always has skill
documents, so the flag would ship with no user, and it would be a switch that
restores exactly the fail-open being closed here. The run-level verdict is printed
on every discovery run for the same reason, whatever the count. It used to be
conditioned on there being more than one report, which meant the single run that
most needed to state its count -- the one that had discovered nothing -- was the
one run that printed none, leaving a run that examined nothing looking exactly
like a healthy one.

The skills earn coverage because of who reads them. They are the instructions
an agent follows *while acting as a gate* -- deciding whether work is fit to
merge. A misdirected pointer costs more there than in ordinary prose, because a
gate that mis-anchors emits a confident wrong verdict rather than visible
confusion. The reviewer skill carried a bare `#59` from the day it was written,
and the rule that forbids exactly that had never once been pointed at the file.

The two rule groups do not travel together, and this is the substance of the
decision rather than a detail of it:

**Issue citations are location-independent.** "#59" misdirects a reader the same
way in any file, because the ambiguity is about *which repository* the number
belongs to and nothing about the citing document changes that answer. So this
rule applies to every covered document.

**Path and section-marker resolution is anchored, and the anchor is a house
style rather than a fact.** Every path in the governing file is written relative
to the repository root, which is why resolving against the root is correct there.
The skills use document-relative links instead -- `scripts/gate-scope.mjs` and
`../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md` -- because
that is what renders as a working link on GitHub from where those files sit. So
path checking stays on the governing file, and covered skill documents are
checked for citations only. Each report prints which rules it applied, so the
narrowing is visible in the log rather than implied by silence.

Widening the path rule to the skills is a real piece of design, not an oversight
deferred out of laziness. It needs an answer to two questions this file does not
attempt: which anchor a given document's paths are written against, and what to
do about a bare filename used in prose as a *name* rather than a path (the skills
say "the `gate-scope.mjs` gate refuses" more often than they cite its path).
Rewriting those documents to repo-root paths would resolve them here at the cost
of breaking the relative links GitHub renders -- a worse document for a greener
checker. That trade is recorded rather than taken.

The rest of the repository is out of scope for the same reason, at a scale that
makes it obvious: at the time this was written, tracked Markdown outside the
covered set carried 236 bare citations, 184 of them in `docs/product/BACKLOG.md`
alone, where `#N` is the idiom of a repository-local tracking list. Bringing
those in is a separate decision about a separate class of document, and folding
it in here would have buried it.

Two exemptions, both mechanical, both reported with their evidence so the CI log
shows what was skipped and why. Neither is an override: there is no --skip and
no --force, because a bypass belongs in branch protection where it is auditable.

**Documented absence.** A missing path is exempt only when the document itself
states its absence -- the token appears immediately preceded by "no", "not",
"without" or "never". This is the whole `SPEC.md` / `DOCK.md` distinction:

    "If there is no `DOCK.md`, read the next paragraph."   -> exempt
    "See `SPEC.md` for the autonomy decision."             -> flagged

`DOCK.md` names something the file says outright is not generated here.
`SPEC.md` was a directive to a document that did not exist. The exemption is
name-level rather than occurrence-level on purpose: `DOCK.md` also appears in
directive-shaped sentences ("read it first"), so checking each occurrence
separately would flag the very case that must not be flagged.

**Naming templates.** A candidate containing <, >, { or } or a run of three or
more identical capitals is a pattern, not a path: `NNNN-kebab-case-title.md`
describes how ADRs are named. Three rather than two so a real name like
ALL_CAPS.md is still resolved.

**Ignored artefact paths.** A path git deliberately excludes is a runtime
directory, not repository content, so its absence from a clean checkout is
correct. `.docks/` is the live example: `drydock.config.json` sets
"docksDir" to it, and that is where dock *worktrees* are created -- gitignored --
while `.drydock/docks/` holds the committed dock *manifests* that are the audit
trail. Two similarly named things with different jobs, and a checker that flags
the first is wrong. Note that this checker reads one document and never parses
config *values*, so ".docks" is not extracted from `drydock.config.json` in the
first place; this rule is what keeps the answer correct if the instructions file
ever cites the directory directly.

**Not paths at all.** A URL, a scoped or versioned package name, and a
`owner/repo#131` citation all contain a slash without naming anything in this
repository, so none of them is treated as a path: they are neither resolved nor
reported. External URL liveness is out of scope and a URL is not fetched. The
last of those three matters most, because the issue-citation rule tells an
author to write owner/repo#N and this file backticks such things by house style
-- so without it the checker would flag its own prescribed remedy as a dangling
path, and punish compliance with its own instruction.

Standard library only, and no network: `pip install` fails on the development
machine.

Usage:

    python tools/instruction_refs/check_instruction_references.py

With no argument the whole covered set is checked, which is what CI runs. An
optional positional argument narrows the run to one document, which is how its
own tests -- and a demonstration that it can fail -- run it against a fixture.
A document that is in the covered set is checked under exactly the rules CI
would apply to it, so pointing the checker at a file by hand cannot report
something CI would not; a document outside the set gets the full rule set, which
is the stricter of the two and never the more permissive.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DOCUMENT = Path(".github") / "copilot-instructions.md"

# Globbed rather than listed, on the same principle as the reference extraction
# above: a hand-maintained roster of covered documents goes stale exactly the way
# the prose it guards does, and a skill added without touching the list would be
# silently unchecked -- which is the defect this scope widening exists to close.
SKILL_DOCUMENTS_GLOB = ".github/skills/**/*.md"

# A backticked span is a path candidate when it ends in one of these, or when it
# contains "/" and starts at something this repository actually has. The
# allowlist is what keeps `autonomy.level` and `merge.enabled` -- the config keys
# quoted in the autonomy paragraph -- out of the candidate set while keeping
# `drydock.config.json` in it. It can miss an exotic extension, which is a silent
# pass. That bias is deliberate, and it points this way on purpose: a checker
# that fires on prose gets turned off rather than fixed.
PATH_EXTENSIONS = frozenset(
    {
        ".astro",
        ".cfg",
        ".cjs",
        ".css",
        ".html",
        ".ini",
        ".js",
        ".json",
        ".jsx",
        ".lock",
        ".md",
        ".mjs",
        ".png",
        ".ps1",
        ".py",
        ".sh",
        ".svg",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".yaml",
        ".yml",
    }
)

# A code span, and the second alternative is the whole of the phase defence.
#
# A span cannot contain a newline, so a reference the file wraps across two
# lines never matched -- and the cost of that was not the wrapped reference. The
# scan resumed at the wrap's *closing* backtick and read it as an opening one,
# which put the pairing out of phase and silently swallowed the next real
# reference on the line the tail landed on. One wrap cost two references, and
# the second was one the author had written in the ordinary way.
#
# So a span may also close one line down. The wrap is admitted only when neither
# fragment carries whitespace, which is what keeps this from trading the miss for
# an over-match: an unpaired backtick followed by prose is not a wrap, and
# gluing it to the first backtick on the line below would swallow *that* line's
# reference -- the same fail-open at a new address. Ending the line at the
# backtick is likewise not a wrap, because the fragment after it would be empty
# of anything but whitespace. A fence delimiter is inert for that reason too:
# ``` is followed by a newline, so it cannot open a wrapped span, and the
# checker's blindness to fenced blocks is left exactly as it is rather than
# quietly changed here.
#
# The wrapped span is then seen but not resolved. What the document renders is
# the two fragments joined by a space, so the token it presents carries
# whitespace and `is_path_candidate` declines it -- the same answer
# `check_section_markers` has always given it through `normalise`. Joining the
# fragments without the space would be a guess at what the author meant, and a
# guess is the failure this file exists to prevent. Being in phase is what was
# missing; resolving the wrap is a separate decision, and this is it, recorded
# rather than taken.
CODE_SPAN_RE = re.compile(r"`([^`\n]+|[^`\s]+\n[ \t]*[^`\s]*)`")
TEMPLATE_RE = re.compile(r"[<>{}]|([A-Z])\1{2,}")
# Not preceded by a word character, so `owner/repo#3` -- which does say which
# repository it means -- is left alone; and not by "/" or "#", so a URL fragment
# and a Markdown heading are not read as citations.
BARE_ISSUE_RE = re.compile(r"(?<![\w/#])#(\d+)")
SECTION_RE = re.compile(r"\u00a7\s*([0-9]+(?:\.[0-9]+)*)?")
HEADING_RE = re.compile(r"^#{1,6}\s+(.*?)\s*$", re.MULTILINE)
# Brackets included so a real Astro route can be cited. Note that resolve_path
# tries the literal name first: glob reads "[slug]" as a character class, which
# would miss the very file `web/src/pages/models/[slug].astro` names.
GLOB_CHARS = "*?[]"

# Never a repository path, whatever else it looks like: a URL scheme, a scope or
# version suffix (`@astrojs/mdx`, `actions/checkout@v4`), and a trailing issue
# number (`owner/repo#131`). Checked before anything else so the intent is legible
# here rather than emerging as a side effect of the first-segment test below.
NON_PATH_RE = re.compile(r"://|@|#\d+$")

# `[#80](https://github.com/abdeslam-menacere/ModelTree/issues/80)` names the
# repository more completely than owner/repo#N does, so its label is not a bare
# citation. Without this the raw scan sees "[#80]" and reports the qualified form
# as the unqualified one.
ISSUE_LINK_RE = re.compile(
    r"\[#\d+\]\(\s*https?://[^)\s]*?/(?:issues|pull)/\d+[^)\s]*\)", re.IGNORECASE
)

# "no `DOCK.md`", "there is no `DOCK.md`", "without the `DOCK.md`". Adjacency is
# the point: "not documented in `SPEC.md`" puts a word between the cue and the
# name, so it does not read as a statement that SPEC.md is absent.
ABSENCE_CUE = r"(?:\bno|\bnot|\bwithout|\bnever)\s+(?:an?\s+|the\s+)?"

# How far back from a section marker to look for the document it points into.
SECTION_LOOKBEHIND = 120

# A name asked of `git check-ignore` to find out whether a directory-only
# pattern covers a directory that is not on disk to be recognised as one.
IGNORE_PROBE = ".gitignore-probe"


@dataclass(frozen=True)
class Coverage:
    """Which of the two rule groups apply to a document.

    Separated because they do not have the same reach. A bare issue citation
    misdirects identically wherever it is written, while path resolution depends
    on the anchor the document's own house style uses -- see the scope section
    of the module docstring. `resolves_paths` false is a narrower check, never a
    suppressed one: nothing is exempted, a rule group simply does not claim
    jurisdiction it cannot exercise correctly.
    """

    resolves_paths: bool

    @property
    def label(self) -> str:
        if self.resolves_paths:
            return "paths, issue citations and section markers"
        return "issue citations only (paths are document-relative here)"


FULL = Coverage(resolves_paths=True)
CITATIONS_ONLY = Coverage(resolves_paths=False)


def skill_documents(repo_root: Path = REPO_ROOT) -> list[Path]:
    """Every skill document on disk, in a stable sorted order.

    Discovery is a function of its own rather than an expression inside
    `covered_documents` so that "the glob matched nothing" is a state something
    can be asserted about. Folded into the covered set it was unobservable: that
    list always carries the governing file, so an empty discovery still returned
    a non-empty set and read as an ordinary small run.
    """
    return [
        document
        for document in sorted(repo_root.glob(SKILL_DOCUMENTS_GLOB))
        if document.is_file()
    ]


# Phrased to say only what the input supports. A renamed directory, a changed
# layout, a broken glob and the wrong working directory all produce an empty
# discovery and none of them is distinguishable in it, so naming any one of them
# would be a guess printed as a diagnosis.
ZERO_DISCOVERY_MESSAGE = (
    f"discovery matched no skill documents under {SKILL_DOCUMENTS_GLOB}, so the "
    "widened half of this check examined nothing. Every verdict this check "
    "prints is a statement about the documents it found, and an empty set holds "
    "no document that could carry a bad reference -- so the more completely the "
    "skills went missing, the more readily this run passed. A scan of nothing "
    "is not a pass. This states only that discovery returned no files; it does "
    "not establish why, because a renamed directory, a changed layout, a broken "
    "glob and the wrong working directory all produce this input and none of "
    "them is distinguishable in it."
)


def discovery_problem(repo_root: Path = REPO_ROOT) -> str | None:
    """Why a discovery run must not proceed, or None if it may.

    Checked ahead of the per-document work rather than alongside it, because
    this is the state that makes that work vacuous rather than one more way for
    it to fail. Kept a pure function of the root so the refusal is an assertable
    property rather than a branch reachable only by deleting a directory.
    """
    if skill_documents(repo_root):
        return None
    return ZERO_DISCOVERY_MESSAGE


def covered_documents(repo_root: Path = REPO_ROOT) -> list[tuple[Path, Coverage]]:
    """Every document CI checks, with the rules that apply to each.

    The governing file first because it is the one every agent reads first, then
    the skill documents in a stable sorted order so a CI log diffs cleanly.
    """
    covered: list[tuple[Path, Coverage]] = [(repo_root / DEFAULT_DOCUMENT, FULL)]
    covered.extend(
        (document, CITATIONS_ONLY) for document in skill_documents(repo_root)
    )
    return covered


def coverage_for(document: Path, repo_root: Path = REPO_ROOT) -> Coverage:
    """The rules for a named document: what CI would apply, else the full set.

    An uncovered document gets `FULL`, which is the stricter answer. Defaulting
    the other way would let a document escape path checking merely by not being
    listed, turning an unrecognised name into a bypass.
    """
    try:
        resolved = document.resolve()
    except OSError:
        return FULL
    for candidate, coverage in covered_documents(repo_root):
        try:
            if candidate.resolve() == resolved:
                return coverage
        except OSError:
            continue
    return FULL


@dataclass(frozen=True)
class Finding:
    line: int
    reference: str
    message: str

    def __str__(self) -> str:
        return f"    line {self.line}: {self.reference} -- {self.message}"


@dataclass
class Report:
    document: Path
    repo_root: Path
    coverage: Coverage = FULL
    spans: int = 0
    candidates: list[str] = field(default_factory=list)
    resolved: list[Finding] = field(default_factory=list)
    exempt: list[Finding] = field(default_factory=list)
    problems: list[Finding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    @property
    def display(self) -> str:
        """The document as a reader would cite it: relative to the root."""
        try:
            return self.document.resolve().relative_to(
                self.repo_root.resolve()
            ).as_posix()
        except (OSError, ValueError):
            return str(self.document)

    @property
    def measurements(self) -> str:
        """What was counted, saying plainly what was not counted at all.

        `spans` is measured for every document, so it is always a number. Path
        candidates are a product of the path rule, so where that rule did not
        run there is no measurement to report -- and printing `0 path-like
        references` there was worse than useless, because a zero reads as a
        finding. That is what let a run over a document with 81 backticked spans
        report the same counts as a run over nothing at all.
        """
        if self.coverage.resolves_paths:
            return (
                f"{self.spans} backticked spans, "
                f"{len(self.candidates)} path-like references"
            )
        return (
            f"{self.spans} backticked spans, path-like references not measured "
            "(the path rule did not run on this document)"
        )

    def render(self) -> str:
        lines = [
            f"Checking {self.display}",
            f"  repository root: {self.repo_root}",
            f"  rules applied: {self.coverage.label}",
            f"  {self.measurements}",
            f"  resolved ({len(self.resolved)}):",
        ]
        lines.extend(str(finding) for finding in self.resolved)
        lines.append(f"  exempt ({len(self.exempt)}):")
        lines.extend(str(finding) for finding in self.exempt)
        if self.problems:
            lines.append(f"  UNRESOLVED ({len(self.problems)}):")
            lines.extend(str(finding) for finding in self.problems)
            lines.append("")
            # Names the document it actually read. The message used to assert
            # this was "the file every agent reads first", which was true only
            # while the checker could never be pointed anywhere else.
            lines.append(
                f"FAIL: a reference in {self.display} points at nothing."
            )
        else:
            lines.append("")
            lines.append(f"OK: every checked reference in {self.display} resolves.")
        return "\n".join(lines)


def normalise(text: str) -> tuple[str, list[int]]:
    """Collapse whitespace, keeping a map back into the original text.

    The absence cue has to match across a line break -- the file wraps
    "then no\\n`DOCK.md` was generated" -- but a finding still has to be
    reported at the line a reader will look at.
    """
    out: list[str] = []
    offsets: list[int] = []
    in_space = False
    for index, char in enumerate(text):
        if char.isspace():
            if not in_space and out:
                out.append(" ")
                offsets.append(index)
            in_space = True
            continue
        in_space = False
        out.append(char)
        offsets.append(index)
    return "".join(out), offsets


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def names_a_top_level_entry(repo_root: Path, token: str) -> bool:
    """Whether a slash-bearing token starts at something this repository has.

    `abdeslam-menacere/ModelTree`, `github/docs`, `3.11/3.13` and `and/or` all
    contain a slash and none of them is a path. `web/src/data/` is. The
    difference that holds up mechanically is whether the first segment names a
    real top-level entry, and it costs one stat.
    """
    first = token.lstrip("/").split("/", 1)[0]
    if not first or first in {".", ".."}:
        return False
    try:
        return (repo_root / first).exists()
    except OSError:
        return False


def is_path_candidate(repo_root: Path, token: str) -> bool:
    if not token or any(char.isspace() for char in token):
        return False
    if token.startswith("-"):
        return False
    if NON_PATH_RE.search(token):
        return False
    known_extension = (
        PurePosixPath(token.rstrip("/")).suffix.lower() in PATH_EXTENSIONS
    )
    if "/" not in token:
        return known_extension
    # A slash alone is not enough. Requiring the extension, the trailing slash or
    # a real first segment keeps `nonexistent/guide.md` and `nonexistent/dir/`
    # catchable while leaving prose and repository slugs alone.
    return (
        known_extension
        or token.endswith("/")
        or names_a_top_level_entry(repo_root, token)
    )


def is_template(token: str) -> bool:
    return TEMPLATE_RE.search(token) is not None


def absence_statement(text: str, token: str) -> tuple[str, int] | None:
    """Where, if anywhere, the document says this name may not be there."""
    flat, offsets = normalise(text)
    pattern = re.compile(ABSENCE_CUE + "`" + re.escape(token) + "`", re.IGNORECASE)
    match = pattern.search(flat)
    if match is None:
        return None
    return match.group(0), line_of(text, offsets[match.start()])


def is_git_ignored(repo_root: Path, token: str) -> bool:
    """Ask git, the authority on what is repository content and what is not.

    Never ask about a path that ends in "/". A blank line in `.gitignore` is
    reported as a match for any such path, so `docs/nowhere/` would come back
    "ignored" and a genuinely broken directory reference would be exempted --
    the exact class of silent pass this checker exists to remove.

    A directory-only pattern like `.docks/` will not match the bare name either,
    because a directory that is not on disk cannot be recognised as one. So ask
    twice: about the name, and about a child of it.

    Failing to ask -- no git on PATH, not a work tree -- returns False, so the
    reference is reported rather than silently passed.
    """
    relative = token.strip("/")
    if not relative:
        return False
    for probe in (relative, f"{relative}/{IGNORE_PROBE}"):
        try:
            completed = subprocess.run(
                ["git", "check-ignore", "--quiet", "--", probe],
                cwd=repo_root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except (OSError, ValueError):
            return False
        if completed.returncode == 0:
            return True
    return False


def resolve_path(repo_root: Path, token: str) -> bool:
    relative = token.lstrip("/")
    wants_directory = relative.endswith("/")
    relative = relative.rstrip("/")
    if not relative:
        return False
    target = repo_root / relative
    try:
        if target.is_dir() if wants_directory else target.exists():
            return True
    except OSError:
        pass
    # Only then as a pattern. Literal first because `[slug].astro` is a real
    # filename here, and glob would read those brackets as a character class and
    # miss the exact file the reference names.
    if any(char in relative for char in GLOB_CHARS):
        try:
            matches = list(repo_root.glob(relative))
        except (OSError, ValueError):
            return False
        if wants_directory:
            return any(match.is_dir() for match in matches)
        return bool(matches)
    return False


def numbered_heading(document: Path, number: str) -> bool:
    try:
        body = document.read_text(encoding="utf-8")
    except OSError:
        return False
    wanted = re.compile(r"^(?:section\s+)?" + re.escape(number) + r"(?![0-9])")
    return any(
        wanted.match(heading.strip().lower()) for heading in HEADING_RE.findall(body)
    )


def count_spans(text: str, report: Report) -> None:
    """How much backticked markup the document carries.

    Measured for every document, whatever rules apply to it. This counter used
    to live inside `check_paths`, which made it a by-product of the path rule
    rather than a fact about the document: under the narrowed coverage the rule
    did not run, so the count stayed at its initial zero and was printed as
    though it had been taken.
    """
    report.spans = sum(1 for _ in CODE_SPAN_RE.finditer(text))


def check_paths(text: str, repo_root: Path, report: Report) -> None:
    for match in CODE_SPAN_RE.finditer(text):
        token = match.group(1)
        if not is_path_candidate(repo_root, token) or token in report.candidates:
            continue
        report.candidates.append(token)
        line = line_of(text, match.start())

        if is_template(token):
            report.exempt.append(Finding(line, token, "naming template, not a path"))
            continue
        if resolve_path(repo_root, token):
            report.resolved.append(Finding(line, token, "exists"))
            continue

        stated = absence_statement(text, token)
        if stated is not None:
            quote, where = stated
            report.exempt.append(
                Finding(
                    line,
                    token,
                    f'the document states its absence at line {where}: "{quote}"',
                )
            )
            continue
        if is_git_ignored(repo_root, token):
            report.exempt.append(
                Finding(
                    line,
                    token,
                    "gitignored: a runtime artefact, not repository content",
                )
            )
            continue

        report.problems.append(
            Finding(
                line,
                token,
                "no such path in the repository, and the document does not say "
                "it is absent. Fix the reference, or say plainly that it is not "
                "generated here.",
            )
        )


def check_issue_citations(text: str, report: Report) -> None:
    linked = [match.span() for match in ISSUE_LINK_RE.finditer(text)]
    for match in BARE_ISSUE_RE.finditer(text):
        if any(
            start <= match.start() and match.end() <= end for start, end in linked
        ):
            continue
        report.problems.append(
            Finding(
                line_of(text, match.start()),
                match.group(0),
                "bare issue citation. #3 and #4 in this repository resolve to "
                "closed, unrelated issues, so a bare number sends a reader "
                "somewhere plausible and wrong. Write owner/repo#N, unbackticked, "
                "or link it as [#N](https://github.com/owner/repo/issues/N).",
            )
        )


def check_section_markers(text: str, repo_root: Path, report: Report) -> None:
    flat, offsets = normalise(text)
    # Located over the whole document, not over a window. Slicing first can cut
    # a code span in half, which puts the backtick pairing out of phase and
    # silently loses the document a marker points into.
    spans = [
        (match.end(), match.group(1)) for match in CODE_SPAN_RE.finditer(flat)
    ]
    for match in SECTION_RE.finditer(flat):
        line = line_of(text, offsets[match.start()])
        marker = match.group(0).strip()
        number = match.group(1)
        if number is None:
            report.problems.append(
                Finding(line, marker, "section marker with no section number.")
            )
            continue

        documents = [
            token
            for end, token in spans
            if end <= match.start()
            and match.start() - end <= SECTION_LOOKBEHIND
            and is_path_candidate(repo_root, token)
            and not is_template(token)
        ]
        if not documents:
            report.problems.append(
                Finding(
                    line,
                    marker,
                    "section marker with no document to resolve it against. "
                    "Name the document it points into.",
                )
            )
            continue

        token = documents[-1]
        target = repo_root / token.lstrip("/")
        if not target.is_file():
            report.problems.append(
                Finding(
                    line,
                    f"{marker} in `{token}`",
                    "the document it points into does not exist, so the "
                    "section cannot resolve.",
                )
            )
            continue
        if not numbered_heading(target, number):
            report.problems.append(
                Finding(
                    line,
                    f"{marker} in `{token}`",
                    f"{token} has no heading numbered {number}. Cite a heading "
                    "that exists, or drop the marker.",
                )
            )


def check(
    document: Path,
    repo_root: Path = REPO_ROOT,
    coverage: Coverage = FULL,
) -> Report:
    text = document.read_text(encoding="utf-8")
    report = Report(document=document, repo_root=repo_root, coverage=coverage)
    count_spans(text, report)
    if coverage.resolves_paths:
        check_paths(text, repo_root, report)
    check_issue_citations(text, report)
    if coverage.resolves_paths:
        check_section_markers(text, repo_root, report)
    report.problems.sort(key=lambda finding: (finding.line, finding.reference))
    return report


def main(argv: list[str] | None = None) -> int:
    # A section marker is U+00A7, which a Windows console's default code page
    # cannot encode. Reporting a failure must not itself fail.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, OSError, ValueError):
        pass
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) > 1:
        print("usage: check_instruction_references.py [document]", file=sys.stderr)
        return 2

    # Two modes, and the distinction matters below: a discovery run is the one
    # CI makes, and it is the only one that can be wrong about *which* documents
    # it read. A named document is exactly the document the caller asked for.
    discovery_run = not args
    if args:
        document = Path(args[0])
        if not document.is_file():
            print(f"no such document: {document}", file=sys.stderr)
            return 2
        targets = [(document, coverage_for(document, REPO_ROOT))]
    else:
        targets = covered_documents(REPO_ROOT)
        missing = [document for document, _ in targets if not document.is_file()]
        if missing:
            for document in missing:
                print(f"no such document: {document}", file=sys.stderr)
            return 2
        problem = discovery_problem(REPO_ROOT)
        if problem is not None:
            print(f"check_instruction_references: {problem}", file=sys.stderr)
            return 2

    reports = [check(document, REPO_ROOT, coverage) for document, coverage in targets]
    print("\n\n".join(report.render() for report in reports))

    failed = [report for report in reports if not report.ok]
    if discovery_run:
        # Stated on every discovery run, whatever the count, and below the
        # per-document verdicts so a log read from the bottom cannot mistake the
        # last document's OK for the run's. This was once conditioned on there
        # being more than one report, which meant the run that most needed to
        # state its count -- the one that had discovered nothing -- printed none
        # and ended on a per-document OK, indistinguishable from a healthy run.
        print("")
        counted = f"{len(reports)} covered document" + (
            "" if len(reports) == 1 else "s"
        )
        if failed:
            print(
                f"FAIL: {len(failed)} of {counted} make a reference that points "
                "at nothing."
            )
        else:
            print(f"OK: {counted} checked, every reference resolves.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
