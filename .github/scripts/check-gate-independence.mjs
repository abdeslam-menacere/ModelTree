#!/usr/bin/env node
//
// Refuses a gate agent definition that instructs a gate to read an input its
// verdict must not have been exposed to, and refuses the two shipped gate
// definitions and `.github/copilot-instructions.md` drifting into disagreement
// about what those inputs are (#863).
//
// ## The defect
//
// `.github/copilot-instructions.md` states that a gate verdict "is only worth
// something if the reviewer and QA agents never saw the developer's summary or
// session -- issue text and `git diff` only", and states the property behind it:
// a gate reads the issue as filed, not the conversation that followed it.
//
// The two documents that *are* those gates said the opposite. Before this check
// landed, `.github/agents/drydock-reviewer.md` told the reviewer to audit the
// developer's own recorded assumptions, and `.github/agents/drydock-qa.md` told
// QA to take the acceptance criteria themselves from the developer's worktree
// file -- a file the party under review writes and can edit. Three lines across
// two files, contradicting the property in a third, with nothing anywhere
// noticing.
//
// That failure is silent and self-confirming. A contaminated reviewer that
// agrees with the developer produces something that reads exactly like
// independent corroboration, which is the strongest signal this system emits.
// Contamination does not merely escape detection; it manufactures the
// appearance of the property it destroys.
//
// ## What this check measures, in its own terms before the terms anyone wanted
//
// It reads **repository content**: the text of the two gate definitions and the
// instructions file. It answers exactly one question -- *do the shipped
// documents instruct a gate to read a forbidden input, and do they still agree
// with each other?*
//
// It does **not** observe what any gate agent actually read at run time, and it
// cannot. `.github/copilot-instructions.md` argues that case directly and this
// check does not contradict it: a gate agent can run any command, there is no
// sandbox here to take a flag away from, and a checker sweeping for one
// spelling would report green while another route returned the same bytes. No
// gate transcript is repository content either -- the live dock state is
// gitignored, and the one tracked manifest under `.drydock/docks/` is a fossil
// -- so there is nothing recording what a gate read for any checker to audit
// (abdeslam-menacere/ModelTree#863, second comment).
//
// Those are two different quantities and conflating them is the failure this
// check is most likely to be misread as committing. Runtime behaviour stays a
// property an agent applies. What was *also* unenforced, and is enforceable
// because it is versioned text, is whether the documents an agent reads first
// tell it to do the forbidden thing. That is what regressed here, that is what
// this reads, and the pass line says so in those words.
//
// ## Decision 1 -- a byte-pinned contract, not a sweep for known-bad strings
//
// A sweep alone cannot carry this. The one occurrence of the comments flag on
// trunk is the sentence forbidding it, so a naive scan fails the document that
// complies -- the constraint `check-skill-doc-test-counts.mjs` records in its
// own header, that a substring scanner cannot be pointed at the prose which
// documents it. The usual escape is an exemption marker, and an exemption is a
// hole the size of the thing being checked: any instruction could sit inside
// one.
//
// So the primary assertion is positive rather than negative. Each gate
// definition must carry the contract below **verbatim**, between the
// `gate-inputs` markers, byte for byte against `CANONICAL_BLOCK` here. The
// region between those markers is the only region excluded from the forbidden
// scan, and it is excluded safely precisely because its content is pinned:
// nothing arbitrary can hide in a carve-out whose every byte is asserted. An
// author who wants to change what a gate may read has to change this file too,
// which is a diff a reviewer reads as "the gate input contract changed" rather
// than as a wording tweak in one agent file. That is the whole of the "cannot
// silently regress" property. It cannot stop a deliberate, visible edit, and it
// is not trying to: no check can, and one claiming otherwise would be the
// dressed-up prose this repository refuses.
//
// The canonical text lives here, in the checker, rather than in a data file
// both agents point at. With the text held elsewhere the invariant degrades to
// "the copies agree", which three coordinated edits satisfy while saying
// nothing about content. Held here it is an assertion about what the rule *is*.
//
// ## Decision 2 -- the forbidden scan finds instances, and says so
//
// Outside the pinned block the scan is an enumeration of known routes, and an
// enumeration is structurally incapable of the class: a rule keyed on the
// comments flag reports green while the equivalent REST path returns the
// identical material. The enumeration is kept because the regression that
// actually happened here was one of these spellings written in plain prose, and
// catching the instance is worth something. The class is carried by the pinned
// block, which states the property -- recognise a route by what it returns
// rather than by what it is called -- so an agent can apply it to a route
// nobody has enumerated. Both halves are reported separately on every run so a
// reader cannot mistake the second for the first.
//
// ## Decision 3 -- fail-closed, with controls that land on the failing path
//
// A check that can only ever report "nothing wrong" is the exact defect #863 is
// about, so this one proves its detectors fire before it reads any file:
//
//   - every forbidden rule is run over a sample it must flag and a control it
//     must not, and both arms must come back differing;
//   - the block exclusion is run over a synthetic document carrying a forbidden
//     token inside the pinned block and another outside it, and must report
//     exactly the outside one -- an exclusion that swallowed everything would
//     report zero, which is what a silently-blind carve-out looks like;
//   - the byte pin is run over a mutated block, which it must reject, and an
//     intact one, which it must accept;
//   - the phrase normaliser is run over samples that a naive `includes` is
//     asserted to *miss*, so the control exercises the blindness rather than
//     being trivially matchable, plus a nonce generated at run time.
//
// An empty scan is an error rather than a pass, and a missing covered file is
// an error rather than an absence.
//
// Node built-ins only -- `skills-ci` installs nothing.
//
// Usage (no arguments, so the job cannot be pointed at an emptier tree):
//
//     node .github/scripts/check-gate-independence.mjs
//
// Exit codes: 0 clean, 1 a violation, 2 the checker itself could not answer.
// Exit 2 is never a pass.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// The gate definitions. These are the documents dispatched *as* the gates, so
// what they instruct is what a gate is told to read. `drydock-dev.md` is
// deliberately absent: the developer is the party being judged and is required
// to read everything, so nothing about its inputs is a defect.
const COVERED = [".github/agents/drydock-reviewer.md", ".github/agents/drydock-qa.md"];

// The third document in the disagreement. It is read for the property sentence
// only and is never scanned for forbidden routes: it is the file that documents
// the prohibition, so a scan reaching it would refuse the description of itself.
const PROPERTY_SOURCE = ".github/copilot-instructions.md";

// Article-free and lower case, so it survives a sentence that opens with it and
// one that does not. Normalised on both sides before comparison.
const PROPERTY = "gate reads the issue as filed, not the conversation that followed it";

const BEGIN = "<!-- gate-inputs:begin -->";
const END = "<!-- gate-inputs:end -->";

// The contract, byte for byte. Every line between and including the markers.
// Changing anything here is a change to what a gate may read; see decision 1.
const CANONICAL_LINES = [
  BEGIN,
  "## Permitted inputs",
  "",
  "Your verdict is worth nothing if it was reached having seen the developer's own",
  "account of its own work. You have two inputs and no others.",
  "",
  "1. **The issue as filed** — its body and title, and not its comments:",
  "   `gh issue view <issue> --repo <owner>/<repo> --json body,title`.",
  "2. **The branch diff**, against a merge-base you compute rather than one you are",
  "   handed: `git merge-base HEAD refs/remotes/origin/main`, then",
  "   `git diff --stat <merge-base>...HEAD`. The repository tree at the commit you",
  "   are judging is yours to read.",
  "",
  "**A gate reads the issue as filed, not the conversation that followed it.** The",
  "flag is a route and not the violation. The comments REST endpoint reached with",
  "`gh api`, a GraphQL timeline query, a `--json comments` projection, the issue's",
  "page in a browser, and the review thread on a linked pull request all return the",
  "same material under other names, and each is the same violation. Recognise a",
  "route by what it returns rather than by what it is called: if it can hand you",
  "something written after the issue was filed, it is outside your input, whether",
  "or not anybody has enumerated it.",
  "",
  "The developer's `DOCK.md` is outside it for the same reason rather than a",
  "different one — it is written, and editable, by the party you are judging, so",
  "policy or acceptance criteria taken from it are supplied by the subject of your",
  "review. Untracked is not unreadable: you run in the worktree that holds it, so",
  "this is a rule you keep and not a wall that keeps it for you. Take the operating",
  "policy from `drydock config show` instead.",
  "",
  "An input you could not read is not an input you read and found empty. Say which",
  "one refused, and fail rather than passing over a gap.",
  END,
];

const CANONICAL_BLOCK = CANONICAL_LINES.join("\n");

// Known routes, enumerated. Decision 2 states what this can and cannot carry.
// Each rule ships the two arms its own soundness is established from.
const FORBIDDEN = [
  {
    rule: "developer-worktree-file",
    pattern: /DOCK\.md/,
    remedy:
      "A gate may not take policy or acceptance criteria from the developer's worktree file: "
      + "the party under review writes it and can edit it. Operating policy comes from "
      + "`drydock config show`; acceptance criteria come from the issue as filed.",
    sample: "1. Re-read the original issue in `DOCK.md`. Extract every acceptance criterion.",
    control: "1. Re-read the original issue as filed. Extract every acceptance criterion.",
  },
  {
    rule: "issue-comments-flag",
    pattern: /--comments\b/,
    remedy:
      "`gh issue view <n> --comments` returns the body plus every comment on it, and the "
      + "developer's summary is put there on purpose. Read the body alone: "
      + "`gh issue view <n> --json body,title`.",
    sample: "Read the issue with `gh issue view <issue> --comments` before starting.",
    control: "Read the issue with `gh issue view <issue> --json body,title` before starting.",
  },
  {
    rule: "issue-comments-projection",
    pattern: /--json\s+[A-Za-z,]*comments\b/,
    remedy:
      "A `--json` projection naming comments returns the same material the flag does. "
      + "Project `body,title` and nothing else.",
    sample: "Fetch it with `gh issue view <issue> --json body,comments`.",
    control: "Fetch it with `gh issue view <issue> --json body,title`.",
  },
  {
    rule: "issue-comments-endpoint",
    pattern: /issues\/[^\s/`)]+\/comments/,
    remedy:
      "The comments REST endpoint delivers the conversation under another name. It is the "
      + "same violation as the flag.",
    sample: "Page it with `gh api repos/<owner>/<repo>/issues/<issue>/comments --paginate`.",
    control: "Page it with `gh api repos/<owner>/<repo>/issues/<issue>`.",
  },
  {
    rule: "issue-timeline-query",
    pattern: /timelineItems/,
    remedy:
      "A GraphQL timeline query returns comments among its nodes, so it is the same "
      + "violation reached by a third name.",
    sample: "Query `timelineItems(first: 100)` for the full history.",
    control: "Query `title` and `body` for the issue as filed.",
  },
];

/**
 * The phrase normaliser `.github/copilot-instructions.md` prescribes for a probe
 * over its own prose, reproduced here rather than paraphrased. Emphasis markers
 * are stripped outside inline code spans and preserved inside them, an em- or
 * en-dash becomes a space so no two tokens fuse, and runs of whitespace collapse
 * so a phrase the document wraps across a line break still matches. `\s+`
 * matches `\r`, so CRLF needs nothing added.
 */
function norm(text) {
  return text
    .split("\u0060")
    .map((token, index) => (index % 2 ? token : token.replace(/\*/g, "")))
    .join("")
    .replace(/[\u2014\u2013]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Locates the pinned block. Returns the marker line indices, or a reason it
 * could not be located. Duplicated or crossed markers are refused rather than
 * resolved to a best guess: two blocks means two contracts.
 */
function locateBlock(lines) {
  const begins = [];
  const ends = [];

  lines.forEach((line, index) => {
    if (line.trim() === BEGIN) begins.push(index);
    if (line.trim() === END) ends.push(index);
  });

  if (begins.length === 0 && ends.length === 0) {
    return { ok: false, reason: `neither ${BEGIN} nor ${END} is present` };
  }
  if (begins.length !== 1 || ends.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one ${BEGIN} and one ${END}, found ${begins.length} and ${ends.length}`,
    };
  }
  if (ends[0] < begins[0]) {
    return { ok: false, reason: `${END} appears before ${BEGIN}` };
  }

  return { ok: true, start: begins[0], end: ends[0] };
}

/**
 * Compares the located block against the canonical text and returns the first
 * disagreement, so a mismatch report names a line rather than dumping two
 * blocks and leaving the reader to diff them by eye.
 */
function pinDifference(lines, start, end) {
  const found = lines.slice(start, end + 1);

  if (found.length !== CANONICAL_LINES.length) {
    return `the block is ${found.length} line(s); the contract is ${CANONICAL_LINES.length}`;
  }

  for (let index = 0; index < CANONICAL_LINES.length; index += 1) {
    if (found[index] !== CANONICAL_LINES[index]) {
      return `line ${index + 1} of the block differs\n`
        + `      contract: ${JSON.stringify(CANONICAL_LINES[index])}\n`
        + `      document: ${JSON.stringify(found[index])}`;
    }
  }

  return null;
}

/**
 * Runs the forbidden enumeration over every line outside the pinned block. The
 * exclusion is what lets the contract quote what it forbids; the byte pin above
 * is what stops the exclusion being a hiding place.
 */
function scanOutsideBlock(lines, start, end) {
  const findings = [];
  let scanned = 0;

  lines.forEach((line, index) => {
    if (start !== null && index >= start && index <= end) return;
    scanned += 1;

    for (const { rule, pattern } of FORBIDDEN) {
      const match = line.match(pattern);
      if (match) findings.push({ line: index + 1, rule, evidence: line.trim() });
    }
  });

  return { findings, scanned };
}

const splitLines = (text) => text.replace(/\r\n/g, "\n").split("\n");

/**
 * Every detector is exercised, in both directions, before any repository file is
 * read. A detector that has only ever seen healthy input has not been shown to
 * fail at all, and this whole check exists because an unfireable check is worse
 * than none.
 */
function selfCheck() {
  const fail = (why) => {
    console.error(`check-gate-independence: self-check failed -- ${why}`);
    console.error("The checker cannot be trusted to report on the real documents. Exit 2 is never a pass.");
    process.exit(2);
  };

  // --- the normaliser, on controls that land on the failing path ------------
  // Each sample must be one a naive substring match MISSES. A control the naive
  // matcher already passes proves nothing about a matcher blind on that path.
  const wrapDoc = "a claim needs a control that would have\ncome back positive";
  const wrapProbe = "would have come back positive";
  if (wrapDoc.includes(wrapProbe)) fail("the wrap sample does not exercise a wrap-blind matcher");
  if (!norm(wrapDoc).includes(norm(wrapProbe))) fail("the normaliser lost a phrase across a line break");

  const markupDoc = "the **issue** as filed";
  const markupProbe = "the issue as filed";
  if (markupDoc.includes(markupProbe)) fail("the markup sample does not exercise a markup-blind matcher");
  if (!norm(markupDoc).includes(norm(markupProbe))) fail("the normaliser lost a phrase across inline markup");

  const literalDoc = "match `refs/heads/*` exactly";
  if (!norm(literalDoc).includes(norm("`refs/heads/*`"))) {
    fail("the normaliser stripped a literal asterisk inside a code span");
  }

  // Invented at the moment of use, so it cannot be quoted into any document.
  const nonce = `zz-absent-${randomUUID()}`;
  if (norm(`${wrapDoc}${markupDoc}${literalDoc}`).includes(norm(nonce))) {
    fail("the normaliser matched a nonce that is not present");
  }

  // The property must be findable in the contract this checker ships. If it is
  // not, every document comparison below is against a phrase that is nowhere.
  if (!norm(CANONICAL_BLOCK).includes(norm(PROPERTY))) {
    fail("the canonical contract does not itself state the property being enforced");
  }

  // --- the forbidden enumeration, two-sided, rule by rule -------------------
  for (const { rule, pattern, sample, control } of FORBIDDEN) {
    if (!pattern.test(sample)) fail(`rule ${rule} did not flag its own known-bad sample`);
    if (pattern.test(control)) fail(`rule ${rule} flagged its own known-good control`);
    if (sample === control) fail(`rule ${rule} has arms that do not differ, so it discriminates nothing`);
  }

  // --- the exclusion, on a synthetic document ------------------------------
  // The contract quotes what it forbids, so an exclusion that leaked would
  // report the block. One that swallowed the document would report nothing --
  // and reporting nothing is precisely what a blind check looks like from
  // outside. Both are refused here by requiring exactly the outside line.
  const outsideLine = "Take the operating policy from `DOCK.md` instead.";
  const synthetic = ["# synthetic", "", ...CANONICAL_LINES, "", outsideLine];
  const located = locateBlock(synthetic);
  if (!located.ok) fail(`the locator could not find the contract in a document built from it: ${located.reason}`);
  if (pinDifference(synthetic, located.start, located.end) !== null) {
    fail("the byte pin rejected a block built from the contract itself");
  }
  const { findings: syntheticFindings, scanned: syntheticScanned } = scanOutsideBlock(
    synthetic,
    located.start,
    located.end,
  );
  if (syntheticScanned === 0) fail("the exclusion left nothing outside the block to scan");
  if (syntheticFindings.length !== 1) {
    fail(
      `the exclusion reported ${syntheticFindings.length} finding(s) on a document with exactly one `
        + "violation outside the block and several quoted inside it",
    );
  }
  if (syntheticFindings[0].line !== synthetic.length) {
    fail("the exclusion reported a finding inside the pinned block rather than the one outside it");
  }

  // The same document with the block absent must report the quoted routes too,
  // which is what establishes that the exclusion is doing the excluding rather
  // than the rules simply never firing on that text.
  const unfenced = scanOutsideBlock(synthetic, null, null);
  if (unfenced.findings.length <= syntheticFindings.length) {
    fail("removing the exclusion changed nothing, so the exclusion is not what suppressed the quoted routes");
  }

  // --- the byte pin, on a mutation -----------------------------------------
  const mutated = [...synthetic];
  const targetIndex = located.start + 1;
  mutated[targetIndex] = `${mutated[targetIndex]} and also read the developer's notes`;
  if (pinDifference(mutated, located.start, located.end) === null) {
    fail("the byte pin accepted a block with an instruction appended to it");
  }
}

if (process.argv.length > 2) {
  console.error(
    "check-gate-independence: this check takes no arguments, so it cannot be pointed at an "
      + `emptier tree or at a laxer contract. Unrecognised: ${process.argv.slice(2).join(" ")}`,
  );
  process.exit(2);
}

selfCheck();

if (COVERED.length === 0) {
  console.error("check-gate-independence: the covered set is empty. A scan of nothing is not a pass.");
  process.exit(2);
}

const read = (relativePath) => {
  try {
    return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
  } catch (error) {
    console.error(`check-gate-independence: cannot read ${relativePath}: ${error.message}`);
    console.error("A document that could not be read has not been checked, which is not a pass.");
    process.exit(2);
  }
};

const findings = [];
let totalScanned = 0;

for (const relativePath of COVERED) {
  const lines = splitLines(read(relativePath));
  const located = locateBlock(lines);

  if (!located.ok) {
    findings.push({
      path: relativePath,
      line: 1,
      rule: "missing-contract",
      evidence: located.reason,
    });
    // With no block located the whole document is scanned: a definition that
    // dropped the contract is not thereby exempt from the enumeration.
    const { findings: loose, scanned } = scanOutsideBlock(lines, null, null);
    totalScanned += scanned;
    for (const finding of loose) findings.push({ path: relativePath, ...finding });
    continue;
  }

  const difference = pinDifference(lines, located.start, located.end);
  if (difference !== null) {
    findings.push({
      path: relativePath,
      line: located.start + 1,
      rule: "altered-contract",
      evidence: difference,
    });
  }

  const { findings: outside, scanned } = scanOutsideBlock(lines, located.start, located.end);
  totalScanned += scanned;
  for (const finding of outside) findings.push({ path: relativePath, ...finding });
}

if (totalScanned === 0) {
  console.error(
    "check-gate-independence: the covered documents held no line outside a pinned block. "
      + "A scan of nothing is not a pass.",
  );
  process.exit(2);
}

// The third document in the disagreement. Read for the property only.
const propertyText = read(PROPERTY_SOURCE);
const backticks = (propertyText.match(/\u0060/g) ?? []).length;
const propertyPresent = norm(propertyText).includes(norm(PROPERTY));

if (!propertyPresent) {
  findings.push({
    path: PROPERTY_SOURCE,
    line: 1,
    rule: "property-drift",
    evidence:
      `the property the gate contract is built on is not stated here: "${PROPERTY}"`
      + `\n      (${backticks} backticks in this document; the normaliser needs an even count)`,
  });
}

const REMEDY = Object.fromEntries(FORBIDDEN.map(({ rule, remedy }) => [rule, remedy]));
REMEDY["missing-contract"] =
  `Every gate definition carries the permitted-inputs contract verbatim between ${BEGIN} and `
  + `${END}. Copy it from CANONICAL_LINES in this checker.`;
REMEDY["altered-contract"] =
  "The contract is pinned byte for byte because it is the one region excluded from the scan "
  + "below. Change what a gate may read by editing CANONICAL_LINES in this checker and both "
  + "gate definitions together, so the change is a diff a reviewer reads as a change to the "
  + "contract.";
REMEDY["property-drift"] =
  "The gate definitions and the instructions file must state one property, not two. Either "
  + "restore the sentence in the instructions file or change PROPERTY and the contract here "
  + "in the same commit.";

// Printed on every run, passing runs included: what was not looked at is not
// what was looked at and found clean (ADR 0018).
const coverageNote = () =>
  [
    "",
    "Not covered by this check, and therefore not reported on:",
    "  - what any gate agent actually read at run time. No gate transcript is repository",
    "    content, so there is nothing to audit; runtime remains a property an agent applies.",
    "  - routes to the conversation that nobody has enumerated. The rules above find",
    `    instances; the class is carried by the contract's own property sentence.`,
    `  - ${PROPERTY_SOURCE}, which is read for the property sentence only and never scanned`,
    "    for forbidden routes, because it is the document that describes them.",
    "  - .github/agents/drydock-dev.md, which is the party under review rather than a gate.",
  ].join("\n");

if (findings.length > 0) {
  console.error(
    "check-gate-independence: a gate definition instructs a gate to read an input its verdict "
      + "must not have been exposed to, or the documents have drifted apart.\n",
  );
  for (const { path, line, rule, evidence } of findings) {
    console.error(`  ${path}:${line}: [${rule}] ${evidence}`);
  }
  for (const rule of [...new Set(findings.map((finding) => finding.rule))]) {
    console.error(`\n[${rule}] ${REMEDY[rule]}`);
  }
  console.error(coverageNote());
  process.exit(1);
}

console.log(
  `check-gate-independence: OK -- ${COVERED.length} gate definition(s) carry the `
    + `${CANONICAL_LINES.length}-line permitted-inputs contract verbatim, ${totalScanned} line(s) `
    + `outside those blocks name none of the ${FORBIDDEN.length} enumerated routes to the `
    + `developer's account, and ${PROPERTY_SOURCE} still states the property they rest on.`,
);
console.log(coverageNote());
