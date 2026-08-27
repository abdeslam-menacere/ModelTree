#!/usr/bin/env node
//
// Refuses a hand-written count of tests in the skill documentation under
// `.github/skills/`.
//
// ## Why the number is refused rather than reconciled
//
// The gate self-test count used to be asserted in prose, by hand, in two
// documents, and nothing compared either statement to the suite (#276). It
// drifted exactly as you would expect: #240 corrected it from 93 to 94, which
// was true at the instant #240 landed and false two merges later, once #185 and
// #237 added their own tests and the real total became 103.
//
// A check that compared the stated number against the observed one would not
// have caught that. The count's correctness is a property of the **merge
// result**, not of any one branch: two branches can each add a test, each state
// the total their own merge-base implies, and both go green -- and their merge
// is wrong, with no pull request left to notice. Worse, it would force every
// branch that adds a gate test to edit the same two prose lines, manufacturing a
// textual conflict between concurrent branches where none exists today.
//
// "These documents state no test count" is the invariant that behaves. It is
// preserved under merge, so it cannot drift; it never needs editing when the
// suite grows, so it never conflicts; and the true number stays one command
// away, printed by the suite itself, in both documents.
//
// ## Fail-closed
//
// A check that silently matches nothing is worse than no check, because it
// manufactures confidence. This one refuses to report success unless it proved,
// on this run, that its detector still fires: it runs the detector over known
// bad and known good samples before it reads any file, and it treats an empty
// scan as an error rather than a pass.
//
// ## The scan root, and why widening it is a decision rather than a tidy-up
//
// The root below is `.github/skills/` and nothing else. That bound is load
// bearing, because there is one file it can never be widened to include:
//
//   A substring scanner cannot be pointed at the prose that documents it,
//   because accurate documentation of a forbidden pattern necessarily contains
//   the forbidden pattern.
//
// So long as `.github/workflows/README.md` documents this check by quoting the
// shapes it refuses -- which is what that file is for -- a scan reaching it
// would refuse the description of itself.
// That is a constraint on this whole family of checks rather than a fault in
// this one: the ADR 0005 overclaim scan in
// `.github/skills/modeltree-gates/scripts/gates.test.mjs` is held to
// `gate-evidence.mjs` alone for the identical reason, and now says so in the
// same words. Two scanners, one rule, previously written down at neither.
//
// #316 weighed widening the root and decided against it, on measurement rather
// than taste. Those measurements were taken at `743a2054`, and they are
// recorded here as the evidence that settled the question -- never as claims
// about what that README holds now. This check does not read it, which is the
// whole decision, so nothing here could keep such a claim true and no run of
// this check could catch it going stale.
//
// Pointed at that file, this check separated two kinds of line:
//
// - The `skills-ci.yml` row: the prose describing these very rules, and so a
//   permanent false positive by the constraint above. No edit retires it,
//   because the row is doing its job.
// - A sentence stating a suite total: a real defect, of exactly the kind this
//   check refuses, and the one live argument for widening the root.
//
// #316 deliberately did not correct the second. It lay in a file this check
// does not scan and several branches contend for, correcting it was not needed
// to settle the scope question, and #316's acceptance criteria said as much
// outright. It is written down here as a known gap rather than quietly closed,
// and it belongs to a change of its own. A gap on the record is worth more
// than a gap tidied away, because the record is what the next person reads.
//
// What the permanent false positive would cost is what settled the choice:
//
// - An exemption marker is line granular, and the row it would have to cover
//   measured over a thousand characters -- of exactly the prose most likely to
//   acquire a real count later. Exempting it would open the hole at the precise
//   spot the widening was for.
// - Exempting backticked spans instead does not reach it. Of the two
//   illustrations on that row that fired, one was written in backticks and one
//   in quotation marks, so the row stayed red and the exemption bought nothing.
// - Rewriting the row to describe the rules without instancing them was the
//   third option weighed. It trades a description a reader can check against
//   this file for prose they cannot.
//
// Widening is permitted. Widening by accident is what this note exists to stop:
// a change that moves the root has to answer the three points above first, and
// has to re-measure rather than trust the observations recorded here.
//
// ## What is promised, in the words it should be checked against
//
// No markdown **under `.github/skills/`** states a test count in any form the
// patterns below recognise. That is the whole guarantee, and the path is part
// of it. It is deliberately not the broader claim a reader may assume -- that
// the repository's documentation states no count -- because
// `.github/workflows/README.md`, `docs/` and every other tree sit outside the
// scan by the decision above.
//
// Node built-ins only -- `skills-ci` installs nothing.
//
// Usage (no arguments, so the job cannot be pointed at an emptier tree):
//
//     node .github/scripts/check-skill-doc-test-counts.mjs
//
// Exit codes: 0 clean, 1 a count was found, 2 the checker itself is unsound.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Moving this is the decision argued in the header (#316), never a tidy-up: the
// file that documents this check quotes what it forbids, so it cannot be read
// by it.
const SKILLS_DIR = join(REPO_ROOT, ".github", "skills");

// A digit that counts tests, in either order: the number before the noun
// ("103 tests", "**103** self-tests") or the noun before the number, which is
// how a label states it ("tests: 103", "self-tests -- 103").
//
// Markdown emphasis is tolerated around the numeral, because prose that quotes
// a count usually emphasises it -- #276's own issue body writes `**95**` and
// `**100**`. A pattern anchored on `\d+\s+tests` cannot see any of those, so the
// most likely way an author restates the count would be the one way the guard
// missed. `*`, `_` and backticks are therefore allowed to wrap the number and to
// sit between it and the noun.
//
// ## Two rules that keep it off honest prose
//
// - **The noun-first form needs a real separator.** "tests" is also a verb, and
//   allowing bare whitespace after it flagged ordinary sentences: "gate-dataset
//   tests 4 kinds of emptiness", "This gate tests 2 independent properties",
//   "Run the tests 3 times if the network is flaky". None states a count, and
//   the remediation this check prints would be nonsense advice for them. A label
//   or a table cell always puts something non-space between the noun and the
//   number -- a colon, a pipe, or a dash -- so requiring at least one of those
//   deletes the whole verb class. Measured against every form this check claims
//   to catch, it costs nothing.
// - **A year is not a quantity.** "In 2024 tests were added for the loader"
//   reads as number-first, but the numeral is the object of a time preposition,
//   not a count of anything. A numeral directly after `in`, `since`, `by`,
//   `during`, `before`, `after`, `from` or `until` is therefore not a count.
//
// ## What is deliberately not matched, so the promise stays honest
//
// - **Written-out numbers.** SKILL.md says "One test is a deliberate exception"
//   about a single characterisation test. That is a statement about that test,
//   not a claim about the size of the suite.
// - **The singular "N test".** It would flag "2 test files", which claims
//   nothing about the suite.
// - **"N checks".** In this repository "check" overwhelmingly means a CI status
//   check -- `.github/workflows/README.md` is largely about which ones are safe
//   to require -- so "3 checks" is far more likely to be a true statement about
//   CI than a test count. It is excluded on purpose and pinned as a
//   must-not-flag sample below: an honest narrow promise beats an ambitious
//   false one.
// - **A count split across two lines of prose.** This scans line by line, so a
//   noun ending one line and a numeral starting the next is not seen. The one
//   split form that is worth the cost of state is the markdown table, handled
//   separately below.
//
// Where it errs, it errs toward over-matching in one known way: a numeral
// directly before a count noun reads as a count even when the sentence is about
// a change rather than the suite, so "adds 3 tests" is flagged. That is the
// safer error. A false positive is a red check with a message telling the author
// exactly what to do, while a false negative is the silent drift this whole
// check exists to end.
const COUNT_NOUN = String.raw`(?:self-)?(?:tests|test\s+cases?|assertions)`;
// Emphasis and code marks. `#` is excluded from what may precede a numeral so an
// issue reference like "tests #103" is not read as a count.
const WRAP = String.raw`[\s*_\`]*`;
// At least one non-space separator, which is what a label or a table cell always
// supplies and what a verb never does. Emphasis may sit on either side of it.
const LABEL_SEP = String.raw`[\s*_\`]*[:|\u2014\u2013-]+[\s*_\`]*`;
// Not `\b`: `_` is a word character, so `\b\d` never fires inside `_103_`. This
// spells out what may sit immediately before the numeral instead -- anything
// except a letter, another digit, or the `#` of an issue reference. That also
// stops "H100 tests" being read as a count of 100.
const NUMBER_START = String.raw`(?<![#0-9A-Za-z])`;
// A numeral governed by a time preposition is a date, not a quantity.
const NOT_A_YEAR = String.raw`(?<!\b(?:in|on|since|by|during|before|after|from|until)\s)`;
const NUMBER_FIRST = new RegExp(
  String.raw`${NOT_A_YEAR}${NUMBER_START}\d+${WRAP}${COUNT_NOUN}\b`,
  "i",
);
const NOUN_FIRST = new RegExp(String.raw`\b${COUNT_NOUN}\b${LABEL_SEP}${NUMBER_START}\d+`, "i");

const statesATestCount = (line) => NUMBER_FIRST.test(line) || NOUN_FIRST.test(line);

// ## The markdown table, which no single line of which states a count
//
// A real table splits the claim across rows: the count noun is a header cell and
// the number is a body cell under it.
//
//     | Suite | tests |
//     |---|---|
//     | gates | 103   |
//
// Scanned a line at a time nothing there is a count, so the construct walked
// straight through an earlier version of this check while the one-line form
// `| tests | 103 |` was flagged -- the pin fitted the regex rather than the way
// tables are written. This correlates the two instead, and stays narrow to keep
// the false-positive surface small: the header cell must be a count noun and
// nothing else, the body cell must be a numeral and nothing else, and only the
// plural nouns count, so a `| test case | 3 |` row identifying a case by number
// is not a size claim.
const CELL_NOUN = /^(?:self-)?(?:tests|test\s+cases|assertions)$/i;
const CELL_NUMBER = /^[*_`]*\d+[*_`]*$/;
const DELIMITER_ROW = /^\|[\s|:-]+\|?$/;

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  let body = trimmed.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

const stripMarks = (cell) => cell.replace(/[*_`]/g, "").trim();

// Zero-based indices of the body rows that put a numeral under a count-noun
// heading.
function tableCountRows(lines) {
  const flagged = new Set();
  let countColumns = null;
  for (let i = 0; i < lines.length; i += 1) {
    const cells = tableCells(lines[i]);
    if (cells === null) {
      countColumns = null;
      continue;
    }
    if (countColumns === null) {
      countColumns = new Set();
      cells.forEach((cell, column) => {
        if (CELL_NOUN.test(stripMarks(cell))) countColumns.add(column);
      });
      continue;
    }
    if (DELIMITER_ROW.test(lines[i].trim())) continue;
    for (const column of countColumns) {
      if (column < cells.length && CELL_NUMBER.test(cells[column])) {
        flagged.add(i);
        break;
      }
    }
  }
  return flagged;
}

// Proof, re-run on every invocation, that the patterns above still do the job
// they are here to do. If a future edit breaks one, this fails loudly instead of
// passing every file forever. Every form the guard claims to cover is pinned
// here, and so is every form it deliberately declines to cover.
const MUST_FLAG = [
  "The gates have 94 self-tests. Run them:",
  "94 tests. Every rule is proved to fire by breaking the data",
  "The suite has 103 test cases.",
  "there are 7 self-tests covering it",
  // Emphasis around the numeral -- the evasion this pattern was widened to close.
  "The gates have **103** self-tests.",
  "The suite has *103* tests.",
  "It runs _103_ tests.",
  "There are __103__ test cases.",
  "There are `103` tests.",
  "The gates have **110 self-tests** today.",
  // The noun-first forms a label or a one-line row produces. A real multi-line
  // table is a different construct and is proved separately, below.
  "| tests | 103 |",
  "tests: 103",
  "self-tests — 103",
  // A count restated as assertions rather than tests.
  "103 assertions cover the gates.",
];
const MUST_NOT_FLAG = [
  "One test is a deliberate exception: it characterises the accepted limit",
  "node --test .github/skills/modeltree-gates/scripts/gates.test.mjs",
  "Run the 2 test files in that directory",
  "ADR 0003 authorises the refresh",
  "Every rule is proved to fire by breaking real data in exactly the way",
  // "tests" as a verb. Ordinary sentences that happen to hold a count noun and a
  // digit, of the shape this repository's own gate documentation is written in.
  "gate-dataset tests 4 kinds of emptiness",
  "This gate tests 2 independent properties",
  "Run the tests 3 times if the network is flaky",
  "The gate tests 1 property per rule",
  "Each run tests 12 documents in web/src/data",
  "The suite tests 5 gates end to end",
  "This step tests 3 things at once",
  // A numeral governed by a time preposition is a date, not a quantity.
  "In 2024 tests were added for the loader",
  "In 2019 test cases were rewritten",
  // Deliberate exclusions, pinned so that narrowing the promise stays a decision
  // rather than an accident.
  "103 checks reported on the pull request",
  "the gate checks the form of a citation, not its remote content",
  "The `gate-source-approval` cases build a throwaway git repository",
  "see the tests #103 for the reasoning",
];

// The table construct, proved as blocks rather than lines because that is what
// it is. Each sample is a whole table; the flagged row is named so a narrowing
// edit cannot pass by flagging the wrong line.
const TABLE_MUST_FLAG = [
  { rows: ["| Suite | tests |", "|---|---|", "| gates | 103   |"], flags: [2] },
  { rows: ["| Gate | test cases |", "|---|---|", "| gate-scope | 12 |"], flags: [2] },
  { rows: ["| Suite | **tests** |", "|---|---|", "| gates | `103` |"], flags: [2] },
];
const TABLE_MUST_NOT_FLAG = [
  // A column of gate names and a column of numbers that count something else.
  ["| Gate | properties |", "|---|---|", "| gate-scope | 12 |"],
  // A count noun in a heading with no numeral beneath it.
  ["| Suite | tests |", "|---|---|", "| gates | all of them |"],
  // A singular heading identifying a case by number, not sizing a suite.
  ["| Gate | test case |", "|---|---|", "| gate-scope | 3 |"],
];

function selfCheck() {
  const broken = [];
  for (const sample of MUST_FLAG) {
    if (!statesATestCount(sample)) {
      broken.push(`should have been flagged but was not: ${JSON.stringify(sample)}`);
    }
  }
  for (const sample of MUST_NOT_FLAG) {
    if (statesATestCount(sample)) {
      broken.push(`should not have been flagged but was: ${JSON.stringify(sample)}`);
    }
  }
  for (const { rows, flags } of TABLE_MUST_FLAG) {
    const got = [...tableCountRows(rows)].sort((a, b) => a - b);
    if (got.join(",") !== flags.join(",")) {
      broken.push(
        `table should have flagged row(s) ${flags.join(",")} but flagged ${
          got.length === 0 ? "none" : got.join(",")
        }: ${JSON.stringify(rows)}`,
      );
    }
  }
  for (const rows of TABLE_MUST_NOT_FLAG) {
    const got = [...tableCountRows(rows)];
    if (got.length > 0) {
      broken.push(`table should not have been flagged but was: ${JSON.stringify(rows)}`);
    }
  }
  if (broken.length > 0) {
    console.error("check-skill-doc-test-counts: the detector is unsound, so this run proves nothing.");
    for (const line of broken) console.error(`  ${line}`);
    process.exit(2);
  }
}

function markdownFilesUnder(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`check-skill-doc-test-counts: cannot read ${dir}: ${err.message}`);
    process.exit(2);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownFilesUnder(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

function posix(path) {
  return path.split(sep).join("/");
}

selfCheck();

const files = markdownFilesUnder(SKILLS_DIR);

// An empty scan is not a pass. If the tree moved or the walk broke, this check
// stopped checking, and that must be as loud as a violation.
if (files.length === 0) {
  console.error(
    `check-skill-doc-test-counts: found no markdown under ${posix(relative(REPO_ROOT, SKILLS_DIR))}. ` +
      "A scan of nothing is not a pass.",
  );
  process.exit(2);
}

const findings = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const tableRows = tableCountRows(lines);
  lines.forEach((text, index) => {
    if (statesATestCount(text) || tableRows.has(index)) {
      findings.push({ path: posix(relative(REPO_ROOT, file)), line: index + 1, text: text.trim() });
    }
  });
}

if (findings.length > 0) {
  console.error(
    "check-skill-doc-test-counts: a hand-written test count is stated in the skill documentation " +
      `under ${posix(relative(REPO_ROOT, SKILLS_DIR))}.\n`,
  );
  for (const { path, line, text } of findings) {
    console.error(`  ${path}:${line}: ${text}`);
  }
  console.error(
    "\nThe size of a suite is not a fact this repository can keep true by hand. It is correct\n" +
      "only against one merge-base, so two branches that each add a test can both state a\n" +
      "correct total and still merge to a wrong one -- which is how the stated count sat at 94\n" +
      "while the suite had 103 (#276).\n\n" +
      "Say what the suite proves, not how many cases it takes, and leave the number to the\n" +
      "command: `node --test .github/skills/modeltree-gates/scripts/gates.test.mjs` reports its\n" +
      "own totals every time it runs.",
  );
  process.exit(1);
}

console.log(
  `check-skill-doc-test-counts: OK -- ${files.length} markdown file(s) under ` +
    `${posix(relative(REPO_ROOT, SKILLS_DIR))} state no test count in any form this check recognises.`,
);
