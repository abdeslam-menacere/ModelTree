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

1. **An ADR is a Markdown file whose name begins with exactly four ASCII digits
   and a hyphen** -- the `NNNN-kebab-case-title.md` convention the instructions
   state. ASCII, explicitly: `\\d` in a `str` pattern is the whole Unicode `Nd`
   category, so an Arabic-Indic or fullwidth `0003` matched and was admitted as
   an ADR whose number no ASCII `0003` could ever be bucketed against. Those
   files are refused as near misses now, and told which digits offend.
   The scan is recursive, because a number claimed inside a subdirectory is still
   a claim on "ADR NNNN": nesting does not open a second numbering namespace.

2. **A file that is not Markdown is not an ADR.** A diagram or other asset may
   legitimately sit beside a decision record, and refusing one would make the
   rule trip over correct work. Every such file is still *named* in the output,
   so the skip is visible rather than silent. Markdown-ness is decided once, by
   lowercasing the suffix, so `0007-title.MD` is an ADR and is checked for a
   collision like any other. It had been accepted as Markdown by that test and
   then refused by a case-sensitive one in the name pattern -- two answers to
   one question, and the refusal named neither.

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

A **directory** whose name matches the ADR pattern -- `0003-something.md/` -- is
skipped like any other directory, because a directory is not a decision record
and carries no number claim, and refusing it would be changing what the check
*does* rather than what it says. But it is named in the ignored list with a
reason that says "directory", not skipped in silence, so the examined-and-ignored
tally accounts for it. An exemption nobody can see is indistinguishable from a
bypass, and a clean report over a tree that holds a `0003-decision.md/` where a
file was meant -- a botched `git mv`, a half-extracted archive -- is exactly
that: the directory looks accounted for while contributing nothing, and both
counts are silently wrong. Files *inside* such a directory are still walked, so
one holding a second ADR 0003 is still a `DUPLICATE` at exit 1; collision
detection is untouched. Plain container subdirectories stay unnamed, because
their contents are examined and nothing under them was passed over -- naming
them would be noise, not visibility.

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
# `003-x`, `00003-x` and `0003_x` do not match -- they are near misses that a
# reader would still call ADR 3, and they are refused below rather than skipped.
#
# Matched against the filename with its extension removed, because whether the
# file is Markdown at all is settled once, above, by `path.suffix.lower()`.
# Spelling `\.md$` here as well was a second, case-*sensitive* answer to a
# question already answered case-insensitively, and the two disagreed:
# `0007-uppercase-ext.MD` was accepted as Markdown on one line and then refused
# as unnumbered on the next, for a reason the message never named.
#
# `[0-9]` rather than `\d`: in a `str` pattern `\d` is the whole Unicode `Nd`
# category, so an Arabic-Indic, Devanagari or fullwidth `0003` matched and was
# admitted as an ADR carrying a number string no ASCII `0003` could ever
# collide with. The explicit class rather than `re.ASCII`, which would narrow
# `.+` too. `\Z` rather than `$`, which also matches before a trailing newline.
ADR_NAME_RE = re.compile(r"^([0-9]{4})-.+\Z")

# The same shape read through Unicode `\d`. Never used to admit a file -- only
# to tell the reader of a refusal *why*, because a `0003` written in U+0660..
# or U+FF10.. reads as ADR 3 to a human while matching nothing to the checker,
# and the advice for a genuinely unnumbered file is the wrong advice for this
# one: it is a decision record, and allowlisting it would exempt it for good.
NON_ASCII_NUMBER_RE = re.compile(r"^(\d{4})-.+\Z")

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
            # A directory whose name would make it an ADR file -- `.md` suffix,
            # four ASCII digits and a hyphen -- is skipped, because a directory
            # is not a decision record. Skipping it *silently* is the defect:
            # `0003-something.md/` looks accounted for to an operator scanning
            # the tree by eye while producing no ADR entry, so the
            # examined/ignored tally is wrong in both numbers with no signal.
            # It is named in the ignored list, with a reason that says
            # "directory" so a reader can tell it from a file carrying an
            # unparseable number -- the same visible-skip discipline the
            # companion and non-Markdown branches already follow. It is reported
            # as ignored rather than refused because a directory is not a number
            # claim and never collided; any file it *contains* is still walked
            # below, so a `0003-x.md/` holding a second ADR 0003 stays a
            # DUPLICATE at exit 1. Plain container directories are left unnamed:
            # their contents are examined, so nothing under them was passed over.
            if (
                path.is_dir()
                and path.suffix.lower() == ".md"
                and ADR_NAME_RE.match(path.stem) is not None
            ):
                report.ignored.append(
                    (
                        display(path, *bases),
                        "a directory named like an ADR, not a decision record",
                    )
                )
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
        match = ADR_NAME_RE.match(path.stem)
        if match is None:
            near_miss = NON_ASCII_NUMBER_RE.match(path.stem)
            if near_miss is not None:
                digits = near_miss.group(1)
                codepoints = " ".join(f"U+{ord(char):04X}" for char in digits)
                report.problems.append(
                    f"  NON-ASCII NUMBER: {shown} begins with four digits that "
                    f"are not ASCII 0-9 ({codepoints}), so it reads as ADR "
                    f"{int(digits):04d} to a human while colliding with no "
                    "other file's number here. Renaming it with ASCII digits "
                    "0-9 is the only fix: it is a decision record, so its "
                    "number has to be one this check can compare."
                )
                continue
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
