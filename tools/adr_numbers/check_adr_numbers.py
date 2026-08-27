"""Refuse two ADRs that claim the same number, or one that misstates its own.

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

The number appears **twice per decision record** -- once in the filename and
once in the `# ADR NNNN:` heading -- and until #286 nothing kept the two in
sync. That is a hand-maintained mirror, the defect class this repository has
been retiring, and its realistic trigger is the remedy this very checker
prescribes: told to "renumber all but one of these", someone renames the file
and does not touch the heading, so the fix for one ambiguity introduces another.
The consequence is a duplicate's consequence, because no citation of an ADR in
this repository resolves through a link. They are bare numbers, and a reader
resolves one by looking for the record that says it is that number -- so a
record that says the wrong number makes `ADR 0003` stop identifying one
document just as surely as a second ADR 0003 would.

So this checker now **opens each decision record and reads one line of it**.
That is a real change of character, and it was chosen over the alternative --
leave this tool filename-only and add a second one -- for this issue's own
argument turned on itself: a second tool needs its own copy of the walk, the
name pattern and above all `COMPANION_NAMES`, and two allowlists that have to
agree is another hand-maintained mirror. One tool, one allowlist, one place to
look. The cost is paid in this docstring, which no longer gets to claim the
"never opens a decision record" property it used to state here.

What is read is the **first ATX H1 in the document**, which must be
`# ADR NNNN:` carrying the same four ASCII digits the filename does. Precisely
that, and each qualification closes a silent skip:

- The *first* H1, not any matching line anywhere in the file. A record whose
  opening heading is wrong is not rescued by citing the right number further
  down, and a search-anywhere rule would let it be.
- Lines inside a fenced code block are not headings. An example `# ADR 0003:`
  quoted in a fence is not the document's own claim, and reporting it as one
  would be a refusal that misstates what the file says -- the failure this
  module keeps finding elsewhere.
- ASCII `[0-9]{4}`, for the reason `ADR_NAME_RE` spells it that way: `\\d` in a
  `str` pattern is the whole Unicode `Nd` category. `# ADR 3:` is therefore
  *unreadable* rather than a mismatch, because admitting a second spelling of
  the number is how a mirror starts drifting.
- A record with **no readable heading is refused, not skipped** -- the rule the
  filename branch already follows, for the reason given there: a check that
  quietly declines to examine what it was pointed at is worse than no check.
- A file whose bytes are not UTF-8, or that cannot be opened at all, is a
  reported problem rather than a traceback out of the codec. Same discipline as
  the unprintable-report refusal below: the operator is told the situation.

A record whose heading disagrees is **still admitted to the duplicate check**
under its filename's number. Withholding it would let a mismatch hide a
collision, which is the failure this file exists to prevent. A file can be wrong
about itself and contested by another file at the same time, and both are said.

Everything else a decision record contains stays out of scope. This reads one
heading, not the prose: the required sections, the metadata list and the status
are not checked, and an ADR may still say anything it likes below its title.

Two things about a *name* can stop the report being read as what it is, and both
are settled where a name becomes report text rather than where the report is
printed, because that is the one place every name passes through.

**A name cannot introduce a line.** `Adr.path` is a `str` and `render()` joins
with "\\n", so a filename holding a newline claims a line of its own:
`0002-x.md\\n\\nOK: 9 ADRs, ...` puts a forged `OK:` *above* the genuine `FAIL:`,
and anything grepping the output for `OK:` reads a run with a real duplicate as
clean. Windows cannot create such a file, which is why this went unnoticed; git
and every POSIX filesystem can. So every character that can end a line -- the C0
and C1 controls, DEL, U+2028 and U+2029 -- is spelled `<U+000A>` rather than
emitted, in `display()` where a filesystem path becomes text and again in
`render()` where text becomes lines. Both, because neither covers the other: a
refusal message interpolates a path from `display()` and never passes through
`render()`'s per-entry formatting, while an `Adr` built directly -- the field is
a `str`, which is what makes the forge reachable at all -- never passed through
`display()`. It is one function at both boundaries and it leaves no such
character behind, so applying it twice cannot produce a second answer.

**A name the output encoding cannot carry is refused, not crashed on.** Nothing
here configures an encoding, so `print(report.render())` on a console whose
codepage cannot represent a name died inside the codec: the operator was shown a
traceback naming this file and `cp1252.py`, never the actual situation -- that
this console cannot print that filename -- over an ADR set that was perfectly
fine. The trigger is the codepage, not non-ASCII-ness: a name carrying U+00E9
prints on a cp1252 stdout, because cp1252 has that character, and one carrying
U+65E5 does not. So the encoding is asked *before* printing, and a report it
cannot carry is withheld, with the offending name spelled by codepoint, at exit
2 -- no verdict was reached, which is what 2 already means here. Withheld rather
than printed through an `errors="replace"` stdout, because `0002-??.md` is not a
name on disk and this checker exists to name files precisely enough to act on.
`no such directory:` spells its name inline instead of withholding: that message
is already a refusal at exit 2, so there is no verdict to hold back and
withholding would leave the operator with nothing at all. Every refusal goes to
stderr through one function that spells for *stderr*, which need not share
stdout's encoding.

A problem is held as **what it is, not as the line it prints**. `render()`
concatenates an inventory of every examined ADR with the problems block into one
string, so `"<filename>" in report.render()` is satisfied by the inventory
whatever the diagnosis actually says: an assertion meant to prove that a
`DUPLICATE` message names both contested files passed against a checker that
said "claimed by 2 files" and then named one. That was found twice in this file,
both times by someone reading it rather than by a test going red, and both times
repaired by slicing the paragraph out of the rendered text before asserting.
Slicing works, and it is a habit -- the next person to write an assertion here
has to remember it, and two people already did not. So each problem is a frozen
`Problem` carrying its kind, the number it concerns, the paths it names and its
message, and formatting happens at the edge in `render()`. The report text is
unchanged; what changes is that `problem.paths` *is* the diagnosis, and the
inventory cannot be reached from it. The count in "claimed by N files" is
derived from those same paths as the message is built, so a report that states
one number and then lists a different one is no longer a thing this code can
express.

Standard library only, and no network: `pip install` fails on the development
machine.

Usage:

    python tools/adr_numbers/check_adr_numbers.py

An optional positional argument points the checker at a different directory,
which is how its own tests -- and a demonstration that it can fail -- run it
against a fixture. CI passes no argument, so the job cannot be aimed at an
emptier directory than the real one.

Exit codes match `tools/instruction_refs/check_instruction_references.py`:
0 clean, 1 the check failed, 2 no verdict was reached -- the invocation was
wrong, or the report could not be carried by this stdout. There is no --skip and
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

# The heading a decision record must open with. Four ASCII digits again, and
# `[0-9]` rather than `\d` for the reason spelled out above -- a fullwidth or
# Arabic-Indic `0003` in a heading reads as ADR 3 to a person and matches no
# filename's number, which is the same trap in a second place.
#
# Up to three leading spaces and at least one space or tab after the `#`,
# because that is what an ATX heading is; `#Heading` is not one.
ADR_HEADING_RE = re.compile(r"^ {0,3}#[ \t]+ADR[ \t]+([0-9]{4})[ \t]*:")

# Any ATX H1 -- the one line `ADR_HEADING_RE` is asked about. A bare `#` is an
# empty H1 and matches here, so a document opening with one is refused for
# stating no readable number rather than quietly passed over in favour of some
# later heading. `##` is an H2 and `#word` is not a heading at all; neither
# matches, so neither can stand in for the title line.
H1_RE = re.compile(r"^ {0,3}#(?:[ \t]|\Z)")

# A fenced code block delimiter, opening or closing. Lines inside a fence are
# not headings, so an example `# ADR 0003:` shown in one cannot be read as the
# document's own claim and reported as a disagreement with a number the file
# never asserted.
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")

# How much of an unreadable heading a refusal quotes back. A heading is one
# line and a Markdown file may be one very long line, so without a limit a
# single malformed document floods the report an operator has to read. Clipping
# is marked with a trailing "..." so a truncated quote cannot be mistaken for
# the whole of what the file says.
HEADING_QUOTE_LIMIT = 120

# Markdown files a decision-record directory legitimately carries that are not
# decision records. Compared case-insensitively; every match is named in the
# output, so an exemption is never invisible.
COMPANION_NAMES = frozenset({"readme.md", "template.md", "adr-template.md"})

# Characters that must never reach the report as themselves, because each one
# ends a line: the whole `str.splitlines()` set, which is the C0 controls, DEL
# and the C1 controls, U+2028 and U+2029. The remaining controls in those ranges
# are included rather than picked out one by one -- an escape sequence rewrites
# a reader's idea of the line as effectively as a newline does, and "no control
# character reaches the report" is a rule that can be checked by reading it.
#
# An explicit class rather than a shorthand, for the same reason `ADR_NAME_RE`
# spells `[0-9]`: a Unicode shorthand answers a wider question than the one
# being asked, and this file has already shipped that defect once.
UNRENDERABLE_RE = re.compile(r"[\x00-\x1F\x7F-\x9F\u2028\u2029]")


def _as_codepoints(text: str, offends) -> str:
    """`text` with every character `offends` rejects written as `<U+XXXX>`.

    The single place this notation is decided. `U+XXXX` because the NON-ASCII
    NUMBER refusal already spells an unseeable character that way: one notation,
    and the reader has to learn it once.
    """
    return "".join(
        f"<U+{ord(char):04X}>" if offends(char) else char for char in text
    )


def spelled(text: str) -> str:
    """`text` with every line-ending control written as `<U+XXXX>`.

    The name boundary. No value interpolated into the report can claim a line of
    its own, because the characters that would end one no longer survive to be
    printed.

    A no-op on every ordinary name -- `0001-a.md` and a name carrying U+00E9
    come back unchanged -- which is the property that keeps this from being a
    change to what the report says. Idempotent: the output holds no line-ending
    control, so a second pass finds nothing left to spell, and the two places
    that call it cannot disagree about a name they both handle.
    """
    return _as_codepoints(text, UNRENDERABLE_RE.match)


def quoted(text: str) -> str:
    """`text` as report-safe text: outside printable ASCII spelled, then clipped.

    A third boundary, and a different question from the two above. `spelled()`
    asks what a *name* may do to the report and `carried()` asks what a *stream*
    can take; this one asks how to quote a line **out of a document** back to
    the reader in a refusal about that line.

    Every character outside printable ASCII, not just the line enders, because
    the character that makes a heading unreadable is very often one that looks
    like an ordinary digit: a fullwidth or Arabic-Indic `0003` is
    indistinguishable from `0003` in most editors, so quoting it as itself would
    produce a refusal that says the number in the heading is not the number in
    the heading. Spelled, the reader sees the codepoints and the message
    explains itself.

    Strictly wider than `spelled()` -- every line ender is outside printable
    ASCII -- so a quoted heading cannot forge a report line either.
    """
    clipped = text[:HEADING_QUOTE_LIMIT]
    shown = _as_codepoints(clipped, lambda char: not (" " <= char <= "~"))
    return f"{shown}..." if len(text) > HEADING_QUOTE_LIMIT else shown


def carried(text: str, encoding: str | None) -> str:
    """`text` with every character `encoding` cannot carry written as `<U+XXXX>`.

    The stream boundary, and a different question from `spelled()`: that one
    asks what a *name* may do to the report, this one asks what a *stream* can
    take. Applied to authored refusal text, whose own newlines are structure
    rather than an interpolated name, so it must leave them alone -- spelling
    them would turn a refusal into one unreadable line.
    """
    offenders = unencodable(text, encoding)
    return _as_codepoints(text, offenders.__contains__) if offenders else text


def unencodable(text: str, encoding: str | None) -> str:
    """The characters in `text` that `encoding` cannot carry, first seen first.

    Asked per character rather than of the whole string, because the refusal has
    to name them and `UnicodeEncodeError` over a whole report names an offset
    into a string the reader never sees.

    A stream with no encoding -- a `StringIO`, which carries any `str` -- and an
    encoding name Python does not know both come back empty. Refusing to print
    because the codec could not be identified would fail on the codec's account
    rather than on the report's, which is the substitution this whole change
    exists to stop.
    """
    if encoding is None:
        return ""
    offenders = ""
    for char in dict.fromkeys(text):
        try:
            char.encode(encoding)
        except UnicodeEncodeError:
            offenders += char
        except LookupError:
            return ""
    return offenders


@dataclass(frozen=True)
class Adr:
    number: str
    path: str


# The seven diagnoses this checker can reach, named once. `Problem.kind` is the
# label the report prints and the label a test selects on, and spelling either
# of them by hand at a call site is how the two drift apart.
DUPLICATE = "DUPLICATE"
UNNUMBERED = "UNNUMBERED"
NON_ASCII_NUMBER = "NON-ASCII NUMBER"
EMPTY = "EMPTY"
# The three from #286, all about what a record says its own number is. Kept
# distinct rather than folded together because they take different repairs:
# edit one of the two numbers, add a heading, or fix the file itself.
HEADING_MISMATCH = "HEADING MISMATCH"
UNREADABLE_HEADING = "UNREADABLE HEADING"
UNREADABLE_FILE = "UNREADABLE FILE"


@dataclass(frozen=True)
class Problem:
    """One diagnosis, structured, with its text produced on demand.

    `kind` is which refusal this is, `number` the ADR number it concerns (the
    contested one for a `DUPLICATE`, the number a non-ASCII name *reads* as for
    a `NON-ASCII NUMBER`, the number the *filename* claims for the three
    heading diagnoses, and None where no number could be read at all),
    `heading_number` the number the document's own heading states -- set only
    for a `HEADING MISMATCH`, which is the one diagnosis about two numbers at
    once -- `paths` the files the diagnosis is about, and `message` the sentence
    that explains it. A test asserts against those fields; nothing in them is
    reachable from the inventory `Report.render()` prints above the problems
    block, which is the entire point of holding them this way.

    `DUPLICATE` is the one kind that lists its paths, because it is the one
    kind about a *set* of files -- every other diagnosis concerns one file and
    says so in a sentence. Its stated count is `len(self.paths)`, computed here
    rather than carried, so the count and the list are the same fact rendered
    twice and cannot disagree.

    `HEADING MISMATCH` gets its sentence built here for the same reason, from
    `number` and `heading_number` rather than from a string composed at the call
    site: a message that states one pair of numbers over a record holding
    another is then not a thing this code can express. `message` carries only
    the advice.

    Paths and the number are spelled on the way out for the reason `Adr.path`
    is: both are `str`, so a caller may put a line ender in one, and `render()`
    joins with "\\n". Production values arrive from `display()`, which has
    already spelled them, and `spelled()` is idempotent -- so this costs the
    real output nothing and closes the forge on a record built directly.
    """

    kind: str
    message: str
    number: str | None = None
    paths: tuple[str, ...] = ()
    heading_number: str | None = None

    def render(self) -> str:
        if self.kind == DUPLICATE:
            return "\n".join(
                [
                    f"  {self.kind}: ADR {spelled(self.number or '')} is "
                    f"claimed by {len(self.paths)} files:",
                    *(f"      {spelled(path)}" for path in self.paths),
                    f"      {self.message}",
                ]
            )
        if self.kind == HEADING_MISMATCH:
            return (
                f"  {self.kind}: "
                f"{spelled(self.paths[0] if self.paths else '')} is filed as "
                f"ADR {spelled(self.number or '')} and its heading says ADR "
                f"{spelled(self.heading_number or '')}. {self.message}"
            )
        return f"  {self.kind}: {self.message}"


@dataclass
class Report:
    directory: Path
    base: Path
    adrs: list[Adr] = field(default_factory=list)
    ignored: list[tuple[str, str]] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)

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
        # Every value interpolated below occupies exactly one line, so each is
        # spelled first. `Adr.path` is a `str` and this method joins with
        # "\n", so without it a name holding a newline forges a report line --
        # an `OK:` above the genuine `FAIL:`, in the case that prompted this.
        # `display()` spells the names it produces too; this is the same
        # function, applied where text becomes lines rather than where a path
        # becomes text, and it covers the entries a caller built directly.
        lines = [
            f"Checking {spelled(str(self.directory))}",
            f"  {len(self.adrs)} ADR files examined, "
            f"{len(self.ignored)} files ignored",
        ]
        lines.extend(
            f"    {spelled(adr.number)}  {spelled(adr.path)}"
            for adr in self.adrs
        )
        lines.extend(
            f"    ignored: {spelled(path)} -- {spelled(reason)}"
            for path, reason in self.ignored
        )
        if self.problems:
            lines.append("")
            lines.extend(problem.render() for problem in self.problems)
            lines.append("")
            lines.append(
                "FAIL: an ADR number does not identify exactly one decision "
                "record."
            )
        else:
            lines.append("")
            lines.append(
                f"OK: {len(self.adrs)} ADRs, every number claimed by exactly "
                "one file, every heading agreeing with its filename."
            )
        return "\n".join(lines)


def display(path: Path, *bases: Path) -> str:
    """Slash-separated and as short as it can be, so a failure message reads the
    same from a Windows checkout as from the CI runner.

    Relative to the repository when the file is inside it, which is the real
    case; relative to the scanned directory otherwise, which is what a fixture
    outside the checkout gets. An absolute path is the last resort rather than
    the ordinary output.

    Spelled on the way out, because this is where an untrusted filesystem name
    becomes report text: a refusal message interpolates what this returns and is
    never re-formatted by `render()`, so a name holding a newline would forge a
    line from inside a problem paragraph. Ordinary names come back untouched.
    """
    resolved = path.resolve()
    for base in bases:
        try:
            shown = resolved.relative_to(base).as_posix()
            break
        except ValueError:
            continue
    else:
        shown = resolved.as_posix()
    return spelled(shown)


HEADING_ADVICE = (
    "An ADR is cited as a bare `ADR NNNN`, resolved by looking for the record "
    "that says it is that number, so the filename and the heading have to "
    "agree. Edit whichever of the two is wrong."
)


def first_heading(text: str) -> str | None:
    """The document's first ATX H1, or None when it has none.

    Fenced code blocks are skipped: a fence opens on a run of at least three
    backticks or tildes and closes on a run of the same character at least as
    long, which is CommonMark's rule and enough to keep an example heading out
    of the answer. An unclosed fence swallows the rest of the file, exactly as
    a Markdown renderer would -- so a document that opens a fence and never
    shuts it has no readable heading, and is refused rather than credited with
    whatever line happens to follow.
    """
    fence = ""
    for line in text.splitlines():
        marker = FENCE_RE.match(line)
        delimiter = marker.group(1) if marker is not None else ""
        if fence:
            if (
                delimiter
                and delimiter[0] == fence[0]
                and len(delimiter) >= len(fence)
            ):
                fence = ""
            continue
        if delimiter:
            fence = delimiter
            continue
        if H1_RE.match(line):
            return line.rstrip()
    return None


def read_failure(error: Exception) -> str:
    """A short, printable reason a decision record could not be read.

    `UnicodeDecodeError` carries `reason` ("invalid start byte") and `OSError`
    carries `strerror` ("Permission denied"); both are worth having and neither
    is worth a traceback. Quoted, because `strerror` is text the operating
    system chose and may hold anything -- including a line ender, which would
    let the filesystem's error message forge a report line.
    """
    reason = getattr(error, "reason", None) or getattr(error, "strerror", None)
    name = type(error).__name__
    return quoted(f"{name}: {reason}" if reason else name)


def heading_problem(path: Path, shown: str, number: str) -> Problem | None:
    """What `path` gets wrong about its own number, or None when it agrees.

    `shown` is the already-displayed path, so the message names the file the
    way every other message in this report names one, and `number` is what the
    filename claims. Returning None is the whole of "this record is consistent";
    there is no separate success value to keep in step with it.
    """
    try:
        # utf-8-sig, not utf-8: a byte-order mark left by a Windows editor sits
        # in front of the `#` and would turn a perfectly correct record into an
        # unreadable one, which is a refusal about the checker rather than
        # about the file.
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as error:
        return Problem(
            kind=UNREADABLE_FILE,
            number=number,
            paths=(shown,),
            message=(
                f"{shown} is named as a decision record but could not be read "
                f"as UTF-8 text ({read_failure(error)}), so the number in its "
                f"heading cannot be compared with the ADR {number} its name "
                "claims. Reported rather than skipped: a file this check could "
                "not open is not a file this check has cleared."
            ),
        )
    heading = first_heading(text)
    if heading is None:
        return Problem(
            kind=UNREADABLE_HEADING,
            number=number,
            paths=(shown,),
            message=(
                f"{shown} contains no `# ` heading at all, so it states no "
                f"number of its own to check against the ADR {number} its "
                f"filename claims. Give it a `# ADR {number}: Title` heading. "
                "Refused rather than skipped, because a record that never says "
                "which decision it is leaves its number resting on the "
                "filename alone -- the single point of failure this check "
                "exists to remove."
            ),
        )
    found = ADR_HEADING_RE.match(heading)
    if found is None:
        return Problem(
            kind=UNREADABLE_HEADING,
            number=number,
            paths=(shown,),
            message=(
                f"{shown} opens with `{quoted(heading)}`, which carries no "
                f"`# ADR NNNN:` number, so nothing in it can be checked "
                f"against the ADR {number} its filename claims. The heading "
                f"has to read `# ADR {number}: Title`, with four ASCII digits "
                "0-9. Any character in the quoted heading outside printable "
                "ASCII is spelled by codepoint, because a digit from another "
                "script reads as an ASCII one and matches nothing."
            ),
        )
    if found.group(1) != number:
        return Problem(
            kind=HEADING_MISMATCH,
            number=number,
            heading_number=found.group(1),
            paths=(shown,),
            message=HEADING_ADVICE,
        )
    return None


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
                    Problem(
                        kind=NON_ASCII_NUMBER,
                        number=f"{int(digits):04d}",
                        paths=(shown,),
                        message=(
                            f"{shown} begins with four digits that "
                            f"are not ASCII 0-9 ({codepoints}), so it reads "
                            f"as ADR {int(digits):04d} to a human while "
                            "colliding with no other file's number here. "
                            "Renaming it with ASCII digits 0-9 is the only "
                            "fix: it is a decision record, so its number has "
                            "to be one this check can compare."
                        ),
                    )
                )
                continue
            report.problems.append(
                Problem(
                    kind=UNNUMBERED,
                    paths=(shown,),
                    message=(
                        f"{shown} is a Markdown file under "
                        f"{spelled(directory.as_posix())} that is neither "
                        "named NNNN-title.md nor a known companion, so no "
                        "number can be read from it and it cannot be checked "
                        "for a collision. Rename it, or add its name to "
                        "COMPANION_NAMES."
                    ),
                )
            )
            continue
        number = match.group(1)
        report.adrs.append(Adr(number=number, path=shown))
        # Recorded *as well as* admitting the file above, never instead of it.
        # A record that misstates its own number is still a claim on the number
        # in its filename, so withholding it here would let a mismatch hide a
        # collision -- one file quietly dropped out of the bucket its name puts
        # it in, and the duplicate it was contesting reported as unique.
        mismatch = heading_problem(path, shown, number)
        if mismatch is not None:
            report.problems.append(mismatch)

    report.adrs.sort(key=lambda adr: (adr.number, adr.path))

    # Both paths and the number, so the fix is obvious without opening either
    # file -- the whole point is that the two documents do not otherwise touch.
    # The paths go on the record rather than into a formatted block: the stated
    # count is derived from them in `Problem.render()`, so "claimed by N files"
    # over a shorter list is unrepresentable rather than merely untested.
    for number, paths in report.duplicates.items():
        report.problems.append(
            Problem(
                kind=DUPLICATE,
                number=number,
                paths=tuple(paths),
                message=(
                    "An ADR number must identify exactly one decision record. "
                    "Renumber all but one of these to the next unused number."
                ),
            )
        )

    if not report.adrs and not report.problems:
        report.problems.append(
            Problem(
                kind=EMPTY,
                message=(
                    f"no ADR files were found under "
                    f"{spelled(directory.as_posix())}. A duplicate check that "
                    "examines nothing passes for the wrong reason, so this is "
                    "reported as a failure rather than a clean run."
                ),
            )
        )

    return report


def encoding_refusal(rendered: str, encoding: str | None) -> str | None:
    """What to say instead of `rendered`, or None when it can simply be printed.

    The refusal is ASCII whatever the report held, because a refusal that dies
    in its own print is the defect it is here to remove. It names the encoding,
    the codepoints that encoding cannot carry, and the report lines they appear
    in with those characters spelled -- enough to identify the file and act on
    it -- and it states outright that no verdict is being given, so that a
    reader cannot take a refusal for a clean run.
    """
    offenders = unencodable(rendered, encoding)
    if not offenders:
        return None
    codepoints = ", ".join(f"U+{ord(char):04X}" for char in offenders)
    listed = "\n".join(
        f"      {carried(line, encoding)}"
        for line in rendered.splitlines()
        if any(char in line for char in offenders)
    )
    return (
        f"  UNPRINTABLE: stdout is encoded as {encoding}, which cannot carry "
        f"{codepoints}. The report lines holding them, with those characters "
        f"spelled by codepoint:\n"
        f"{listed}\n"
        "      The report itself is withheld rather than printed with a name "
        "it does not have. This says nothing about whether an ADR number is "
        "claimed twice -- the check ran and its result was not reported. "
        "Re-run with a UTF-8 stdout, PYTHONIOENCODING=utf-8 or `chcp 65001` on "
        "a Windows console, to read it."
    )


def refuse(message: str) -> None:
    """Put `message` on stderr, spelled so that it cannot itself fail to print.

    Every refusal in this file goes through here, including the one that exists
    because a report could not be printed: the stream carrying the reason is the
    one that must never be the thing that fails, and stderr's encoding is not
    guaranteed to be stdout's. Only the encoding question is asked here --
    `message` is authored text whose newlines are its structure, and every
    untrusted name reaching it has already passed `spelled()`.
    """
    encoding = getattr(sys.stderr, "encoding", None)
    print(carried(message, encoding), file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) > 1:
        refuse("usage: check_adr_numbers.py [directory]")
        return 2
    directory = Path(args[0]) if args else REPO_ROOT / DEFAULT_DIRECTORY
    if not directory.is_dir():
        refuse(f"no such directory: {spelled(str(directory))}")
        return 2
    report = check(directory, REPO_ROOT)
    rendered = report.render()
    # Asked before printing, not caught afterwards: `print` raising from inside
    # the codec leaves the operator a traceback about this file and cp1252.py
    # over an ADR set that may be perfectly fine.
    refusal = encoding_refusal(rendered, getattr(sys.stdout, "encoding", None))
    if refusal is not None:
        refuse(refusal)
        return 2
    print(rendered)
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
