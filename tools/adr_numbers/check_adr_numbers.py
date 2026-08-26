"""Refuse two ADRs that claim the same number.

Nothing in git notices this. #145 added
`docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md`; #146's branch
independently added `docs/adr/0003-unattended-data-refresh-may-auto-merge.md`.
Same number, different filename, contradictory content -- one declared it amended
ADR 0001, the other declared that guardrail untouched. Git compares *paths*, so
the two files do not touch and both would have merged clean, leaving the
repository with two ADR 0003s and no signal. It was caught by a human reading
both branches, which is not a control that scales.

The cost is not cosmetic. ADRs are how this repository records decisions that are
otherwise unwritable, and a duplicate number means "ADR 0003" stops being a
unique reference: an agent told to follow ADR 0003 finds two contradictory
documents and no way to tell which governs. The existing `instruction-references`
check does not cover this -- it asserts that a citation *resolves*, and both of
those files exist, so both resolve fine.

This checks one property and no more: **no two ADR files share a leading
four-digit number.** Gaps and ordering are deliberately out of scope. Contiguity
would have caught the same defect, but two open pull requests each adding the
next ADR collide by construction under it, and a check that fires on correct work
gets worked around rather than fixed. Whether ADR numbers must also be
next-unused is a separate decision for a separate change.

Three classification decisions, made against what `docs/adr/` actually contains
(three files, all of the form NNNN-title.md, no README and no template):

1. **An ADR is a Markdown file whose name begins with exactly four digits and a
   hyphen** -- the `NNNN-kebab-case-title.md` convention the instructions state.
   The scan is recursive, because a number claimed inside a subdirectory is still
   a claim on "ADR NNNN": nesting does not open a second numbering namespace.

2. **A file that is not Markdown is not an ADR.** A diagram or other asset may
   legitimately sit beside a decision record, and refusing one would make the
   rule trip over correct work. Every such file is still *named* in the output,
   so the skip is visible rather than silent.

3. **A Markdown file that is neither an ADR nor an allowlisted companion is a
   failure, not a skip.** This is the one place this checker is deliberately
   stricter than "ignore what does not match", and the reason is the failure mode
   it exists to remove: `003-title.md`, `0003_title.md` and `00003-title.md` all
   *look* numbered, and under a silent-skip rule each one would slip past the
   duplicate check while a reader would still call it ADR 3. A check that quietly
   declines to examine the file it was pointed at is worse than no check, and
   this repository has already shipped one of those. `README.md` and a template
   are the companions a decision-record directory actually grows, so they are
   allowlisted by name; adding another is a one-line reviewable diff, which is
   the point -- the exception is recorded rather than assumed.

Finding **no ADRs at all** is likewise a failure. A duplicate check that passes
because it never located the directory's contents is the vacuous-pass defect in
its purest form, so an empty result is reported as one.

Validating ADR *content* is out of scope: this reads filenames only and never
opens a decision record, so it cannot object to what one says. In particular it
does not compare the number in the filename with the number in the `# ADR NNNN:`
heading inside it.

Standard library only, and no network: `pip install` fails on the development
machine.

Usage:

    python tools/adr_numbers/check_adr_numbers.py

An optional positional argument points the checker at a different directory,
which is how its own tests -- and a demonstration that it can fail -- run it
against a fixture. CI passes no argument, so the job cannot be aimed at an
emptier directory than the real one.

Exit codes match `tools/instruction_refs/check_instruction_references.py`:
0 clean, 1 the check failed, 2 the invocation was wrong. There is no --skip and
no --force. A genuine exception belongs in branch protection, where it is
auditable.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIRECTORY = Path("docs") / "adr"

# Exactly four digits, then a hyphen, then a title. Anchored at both ends so
# `003-x.md`, `00003-x.md` and `0003_x.md` do not match -- they are near misses
# that a reader would still call ADR 3, and they are refused below rather than
# skipped.
ADR_NAME_RE = re.compile(r"^(\d{4})-.+\.md$")

# Markdown files a decision-record directory legitimately carries that are not
# decision records. Compared case-insensitively; every match is named in the
# output, so an exemption is never invisible.
COMPANION_NAMES = frozenset({"readme.md", "template.md", "adr-template.md"})


@dataclass(frozen=True)
class Adr:
    number: str
    path: str


@dataclass
class Report:
    directory: Path
    base: Path
    adrs: list[Adr] = field(default_factory=list)
    ignored: list[tuple[str, str]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    @property
    def duplicates(self) -> dict[str, list[str]]:
        by_number: dict[str, list[str]] = {}
        for adr in self.adrs:
            by_number.setdefault(adr.number, []).append(adr.path)
        return {
            number: paths
            for number, paths in sorted(by_number.items())
            if len(paths) > 1
        }

    def render(self) -> str:
        lines = [
            f"Checking {self.directory}",
            f"  {len(self.adrs)} ADR files examined, "
            f"{len(self.ignored)} files ignored",
        ]
        lines.extend(f"    {adr.number}  {adr.path}" for adr in self.adrs)
        lines.extend(
            f"    ignored: {path} -- {reason}" for path, reason in self.ignored
        )
        if self.problems:
            lines.append("")
            lines.extend(self.problems)
            lines.append("")
            lines.append(
                "FAIL: an ADR number does not identify exactly one decision "
                "record."
            )
        else:
            lines.append("")
            lines.append(
                f"OK: {len(self.adrs)} ADRs, every number claimed by exactly "
                "one file."
            )
        return "\n".join(lines)


def display(path: Path, *bases: Path) -> str:
    """Slash-separated and as short as it can be, so a failure message reads the
    same from a Windows checkout as from the CI runner.

    Relative to the repository when the file is inside it, which is the real
    case; relative to the scanned directory otherwise, which is what a fixture
    outside the checkout gets. An absolute path is the last resort rather than
    the ordinary output.
    """
    resolved = path.resolve()
    for base in bases:
        try:
            return resolved.relative_to(base).as_posix()
        except ValueError:
            continue
    return resolved.as_posix()


def check(directory: Path, base: Path = REPO_ROOT) -> Report:
    report = Report(directory=directory, base=base.resolve())
    bases = (report.base, directory.resolve())
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        shown = display(path, *bases)
        name = path.name
        if name.lower() in COMPANION_NAMES:
            report.ignored.append(
                (shown, "a companion file, not a decision record")
            )
            continue
        if path.suffix.lower() != ".md":
            report.ignored.append((shown, "not a Markdown document"))
            continue
        match = ADR_NAME_RE.match(name)
        if match is None:
            report.problems.append(
                f"  UNNUMBERED: {shown} is a Markdown file under "
                f"{directory.as_posix()} that is neither named NNNN-title.md "
                "nor a known companion, so no number can be read from it and it "
                "cannot be checked for a collision. Rename it, or add its name "
                "to COMPANION_NAMES."
            )
            continue
        report.adrs.append(Adr(number=match.group(1), path=shown))

    report.adrs.sort(key=lambda adr: (adr.number, adr.path))

    # Both paths and the number, so the fix is obvious without opening either
    # file -- the whole point is that the two documents do not otherwise touch.
    for number, paths in report.duplicates.items():
        listed = "\n".join(f"      {path}" for path in paths)
        report.problems.append(
            f"  DUPLICATE: ADR {number} is claimed by {len(paths)} files:\n"
            f"{listed}\n"
            "      An ADR number must identify exactly one decision record. "
            "Renumber all but one of these to the next unused number."
        )

    if not report.adrs and not report.problems:
        report.problems.append(
            f"  EMPTY: no ADR files were found under {directory.as_posix()}. A "
            "duplicate check that examines nothing passes for the wrong reason, "
            "so this is reported as a failure rather than a clean run."
        )

    return report


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) > 1:
        print("usage: check_adr_numbers.py [directory]", file=sys.stderr)
        return 2
    directory = Path(args[0]) if args else REPO_ROOT / DEFAULT_DIRECTORY
    if not directory.is_dir():
        print(f"no such directory: {directory}", file=sys.stderr)
        return 2
    report = check(directory, REPO_ROOT)
    print(report.render())
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
