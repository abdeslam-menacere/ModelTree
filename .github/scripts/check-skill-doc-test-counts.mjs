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
const SKILLS_DIR = join(REPO_ROOT, ".github", "skills");

// A digit that counts tests, in either order: the number before the noun
// ("103 tests", "**103** self-tests") or the noun before the number, which is
// how a table row or a label states it ("| tests | 103 |", "tests: 103").
//
// Markdown emphasis is tolerated around the numeral, because prose that quotes
// a count usually emphasises it -- #276's own issue body writes `**95**` and
// `**100**`. A pattern anchored on `\d+\s+tests` cannot see any of those, so the
// most likely way an author restates the count would be the one way the guard
// missed. `*`, `_` and backticks are therefore allowed to wrap the number and to
// sit between it and the noun.
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
//   must-not-flag sample below. This is the one evasion left open, and it is
//   left open knowingly: an honest narrow promise beats an ambitious false one.
//
// Where it errs, it errs toward over-matching: "test cases 1 and 2" would be
// flagged. That is the safer error. A false positive is a red check with a
// message telling the author exactly what to do, while a false negative is the
// silent drift this whole check exists to end.
const COUNT_NOUN = String.raw`(?:self-)?(?:tests|test\s+cases?|assertions)`;
// Emphasis, code marks, and the separators a table or label puts between the
// two. `#` is excluded so an issue reference like "tests #103" is not a count.
const WRAP = String.raw`[\s*_\`]*`;
const LABEL_SEP = String.raw`[\s*_\`:|\u2014\u2013-]*`;
// Not `\b`: `_` is a word character, so `\b\d` never fires inside `_103_`. This
// spells out what may sit immediately before the numeral instead -- anything
// except a letter, another digit, or the `#` of an issue reference. That also
// stops "H100 tests" being read as a count of 100.
const NUMBER_START = String.raw`(?<![#0-9A-Za-z])`;
const NUMBER_FIRST = new RegExp(String.raw`${NUMBER_START}\d+${WRAP}${COUNT_NOUN}\b`, "i");
const NOUN_FIRST = new RegExp(String.raw`\b${COUNT_NOUN}\b${LABEL_SEP}${NUMBER_START}\d+`, "i");

const statesATestCount = (line) => NUMBER_FIRST.test(line) || NOUN_FIRST.test(line);

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
  // The noun-first forms a table or a label produces.
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
  // Deliberate exclusions, pinned so that narrowing the promise stays a decision
  // rather than an accident.
  "103 checks reported on the pull request",
  "the gate checks the form of a citation, not its remote content",
  "The `gate-source-approval` cases build a throwaway git repository",
  "see the tests #103 for the reasoning",
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
  lines.forEach((text, index) => {
    if (statesATestCount(text)) {
      findings.push({ path: posix(relative(REPO_ROOT, file)), line: index + 1, text: text.trim() });
    }
  });
}

if (findings.length > 0) {
  console.error("check-skill-doc-test-counts: a hand-written test count is stated in the skill documentation.\n");
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
