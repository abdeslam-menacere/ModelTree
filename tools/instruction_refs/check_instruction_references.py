"""Resolve every reference `.github/copilot-instructions.md` makes.

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

Standard library only, and no network: `pip install` fails on the development
machine, and external URL liveness is deliberately not checked.

Usage:

    python tools/instruction_refs/check_instruction_references.py

An optional positional argument points the checker at a different document,
which is how its own tests -- and a demonstration that it can fail -- run it
against a fixture. Paths still resolve against the repository root, and CI
passes no argument.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DOCUMENT = Path(".github") / "copilot-instructions.md"

# A backticked span is a path candidate when it contains "/" or ends in one of
# these. The allowlist is what keeps `autonomy.level` and `merge.enabled` -- the
# config keys quoted in the autonomy paragraph -- out of the candidate set while
# keeping `drydock.config.json` in it. It can miss an exotic extension, which is
# a silent pass; it will not invent a path, which would be a false positive.
# That bias is deliberate: a checker that fires on prose gets turned off.
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

CODE_SPAN_RE = re.compile(r"`([^`\n]+)`")
TEMPLATE_RE = re.compile(r"[<>{}]|([A-Z])\1{2,}")
# Not preceded by a word character, so `owner/repo#3` -- which does say which
# repository it means -- is left alone; and not by "/" or "#", so a URL fragment
# and a Markdown heading are not read as citations.
BARE_ISSUE_RE = re.compile(r"(?<![\w/#])#(\d+)")
SECTION_RE = re.compile(r"\u00a7\s*([0-9]+(?:\.[0-9]+)*)?")
HEADING_RE = re.compile(r"^#{1,6}\s+(.*?)\s*$", re.MULTILINE)
GLOB_CHARS = "*?"

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
    spans: int = 0
    candidates: list[str] = field(default_factory=list)
    resolved: list[Finding] = field(default_factory=list)
    exempt: list[Finding] = field(default_factory=list)
    problems: list[Finding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    def render(self) -> str:
        lines = [
            f"Checking {self.document}",
            f"  repository root: {self.repo_root}",
            f"  {self.spans} backticked spans, "
            f"{len(self.candidates)} path-like references",
            f"  resolved ({len(self.resolved)}):",
        ]
        lines.extend(str(finding) for finding in self.resolved)
        lines.append(f"  exempt ({len(self.exempt)}):")
        lines.extend(str(finding) for finding in self.exempt)
        if self.problems:
            lines.append(f"  UNRESOLVED ({len(self.problems)}):")
            lines.extend(str(finding) for finding in self.problems)
            lines.append("")
            lines.append(
                "FAIL: a reference in the file every agent reads first points "
                "at nothing."
            )
        else:
            lines.append("")
            lines.append("OK: every reference resolves.")
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


def is_path_candidate(token: str) -> bool:
    if not token or any(char.isspace() for char in token):
        return False
    if token.startswith("-"):
        return False
    if "/" in token:
        return True
    return PurePosixPath(token).suffix.lower() in PATH_EXTENSIONS


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
    if any(char in relative for char in GLOB_CHARS):
        return any(repo_root.glob(relative))
    target = repo_root / relative
    return target.is_dir() if wants_directory else target.exists()


def numbered_heading(document: Path, number: str) -> bool:
    try:
        body = document.read_text(encoding="utf-8")
    except OSError:
        return False
    wanted = re.compile(r"^(?:section\s+)?" + re.escape(number) + r"(?![0-9])")
    return any(
        wanted.match(heading.strip().lower()) for heading in HEADING_RE.findall(body)
    )


def check_paths(text: str, repo_root: Path, report: Report) -> None:
    for match in CODE_SPAN_RE.finditer(text):
        token = match.group(1)
        report.spans += 1
        if not is_path_candidate(token) or token in report.candidates:
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
    for match in BARE_ISSUE_RE.finditer(text):
        report.problems.append(
            Finding(
                line_of(text, match.start()),
                match.group(0),
                "bare issue citation. #3 and #4 in this repository resolve to "
                "closed, unrelated issues, so a bare number sends a reader "
                "somewhere plausible and wrong. Write owner/repo#N.",
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
            and is_path_candidate(token)
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


def check(document: Path, repo_root: Path = REPO_ROOT) -> Report:
    text = document.read_text(encoding="utf-8")
    report = Report(document=document, repo_root=repo_root)
    check_paths(text, repo_root, report)
    check_issue_citations(text, report)
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
    document = Path(args[0]) if args else REPO_ROOT / DEFAULT_DOCUMENT
    if not document.is_file():
        print(f"no such document: {document}", file=sys.stderr)
        return 2
    report = check(document, REPO_ROOT)
    print(report.render())
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
