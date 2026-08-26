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

// A digit that counts tests. Written-out numbers are deliberately not matched:
// SKILL.md says "One test is a deliberate exception" about a single
// characterisation test, which is a statement about that test and not a claim
// about the size of the suite. The singular "N test" is left out for the same
// reason -- it would flag "2 test files", which claims nothing about the suite.
const TEST_COUNT = /\b\d+\s+(?:self-)?(?:tests|test\s+cases?)\b/i;

// Proof, re-run on every invocation, that the pattern above still does the job
// it is here to do. If a future edit breaks it, this fails loudly instead of
// passing every file forever.
const MUST_FLAG = [
  "The gates have 94 self-tests. Run them:",
  "94 tests. Every rule is proved to fire by breaking the data",
  "The suite has 103 test cases.",
  "there are 7 self-tests covering it",
];
const MUST_NOT_FLAG = [
  "One test is a deliberate exception: it characterises the accepted limit",
  "node --test .github/skills/modeltree-gates/scripts/gates.test.mjs",
  "Run the 2 test files in that directory",
  "ADR 0003 authorises the refresh",
  "Every rule is proved to fire by breaking real data in exactly the way",
];

function selfCheck() {
  const broken = [];
  for (const sample of MUST_FLAG) {
    if (!TEST_COUNT.test(sample)) {
      broken.push(`should have been flagged but was not: ${JSON.stringify(sample)}`);
    }
  }
  for (const sample of MUST_NOT_FLAG) {
    if (TEST_COUNT.test(sample)) {
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
    if (TEST_COUNT.test(text)) {
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
    `${posix(relative(REPO_ROOT, SKILLS_DIR))} state no hand-written test count.`,
);
