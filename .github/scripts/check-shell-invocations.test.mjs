// # The fence model of `check-shell-invocations.mjs`, pinned
//
// The guard's own `MUST_FLAG` / `MUST_NOT_FLAG` self-test feeds command strings
// straight into the parser. It never constructs a *document*, so every behaviour
// of `fencedBlocks` shipped unpinned: tilde support, cross-marker closure,
// run-length closure, indentation, and the exemption-marker lookback on the
// preceding line. All of it is correct today, and nothing stopped a later edit
// narrowing the regex to `` `{3,} `` with every check still green (#1040).
//
// ## How the guard is exercised
//
// It takes no arguments, deliberately -- "so the job cannot be pointed at an
// emptier tree" -- and derives `REPO_ROOT` from its own file URL. It exports
// nothing. So it is neither importable nor aimable, and the issue's rule 7 is
// that this change makes no production edit to it.
//
// Each case therefore copies the committed script into a temporary repository
// root, which is what makes `REPO_ROOT` resolve to that root, writes a fixture
// document at one of the three covered paths, and runs the copy in a child
// process. The shipped bytes are executed: `fencedBlocks`, the
// `COVERED_LANGUAGES` routing, the exemption lookback, and the
// `block.fenceLine + finding.line` arithmetic. Same arrangement, and same
// reason, as the scratch-repository cases in `ci-preflight.test.ts`.
//
// ## Every case carries a mutation arm
//
// A pin written as an assertion that cannot fail is #401 again. So each case
// runs two arms: the committed script, and a copy with one stated textual
// substitution applied. `substitution` asserts the target appears **exactly
// once** before replacing it, so a mutation that silently fails to apply is a
// loud error rather than a control that looks like it passed (#857 -- a
// mutation named by cardinality is not a control). The arms are then required
// to come back *differing*, which is what a one-sided arm cannot establish.
//
// Two of the mutations flip the other way -- the committed script is clean and
// the mutant flags -- because a suite whose every arm expects a finding cannot
// tell a working guard from one that flags everything.
//
// ## A clean arm must prove it read something
//
// The guard exits 2 when `scannedBlocks === 0`, so exit 0 alone cannot separate
// *read and clean* from *nothing was read* -- ADR 0018's property, and the exact
// way this suite could go quietly inert. Every fixture whose expected result is
// clean therefore carries a sentinel block, and `assertClean` reads the scanned
// count out of the passing banner rather than trusting the exit code. The last
// case pins the exit-2 path itself, so that discipline is established here and
// not assumed.
//
// ## What this method cannot see, stated rather than left to be inferred
//
// Indentation *stripping* is not observable from outside the process. The
// scanner is indentation-insensitive by construction -- a here-string
// terminator is matched on `line.trim()`, `<` is judged on
// `line.slice(0, i).trim()`, and a finding's evidence is `lines[i].trim()` --
// so a body line reaches every published surface with its leading whitespace
// already gone, stripped or not. The indented case below therefore pins that an
// indented fence is *recognised* and its body judged at the right line, and
// claims nothing about the `Math.min` arithmetic. Pinning that needs an export,
// which rule 7 puts outside this change.
//
// Run: node --test .github/scripts/check-shell-invocations.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./check-shell-invocations.mjs", import.meta.url));
const GUARD_SOURCE = readFileSync(GUARD, "utf8");

const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Run the guard -- committed, or with one substitution applied -- over a fixture
 * corpus of exactly one document.
 *
 * `.github/agents` and `.github/skills` are created empty because they are two
 * of the three entries in the guard's covered set, and `markdownUnder` exits 2
 * on a path it cannot stat. An empty directory contributes no markdown, so the
 * fixture stays the only document read.
 */
function guardRun(document, mutation = null) {
  const root = mkdtempSync(join(tmpdir(), "check-shell-invocations-"));
  roots.push(root);

  mkdirSync(join(root, ".github", "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "agents"), { recursive: true });
  mkdirSync(join(root, ".github", "skills"), { recursive: true });

  const script = join(root, ".github", "scripts", "check-shell-invocations.mjs");
  writeFileSync(script, mutation === null ? GUARD_SOURCE : mutation(GUARD_SOURCE), "utf8");
  writeFileSync(join(root, ".github", "copilot-instructions.md"), document, "utf8");

  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.error, undefined, `the guard could not be started: ${run.error?.message}`);

  const output = `${run.stdout}${run.stderr}`;
  const scanned = /OK -- (\d+) fenced/.exec(output);

  return {
    status: run.status,
    output,
    // `  <path>:<line>: [<rule>] <evidence>`
    findings: [...output.matchAll(/^ {2}(\S+):(\d+): \[([a-z-]+)\] (.*)$/gm)].map((match) => ({
      path: match[1],
      line: Number(match[2]),
      rule: match[3],
      evidence: match[4].trimEnd(),
    })),
    // The same shape without a rule, which is how an exemption is reported.
    exemptions: [...output.matchAll(/^ {2}(\S+):(\d+): (?!\[)(.*)$/gm)].map((match) => ({
      path: match[1],
      line: Number(match[2]),
      reason: match[3].trimEnd(),
    })),
    scanned: scanned === null ? null : Number(scanned[1]),
  };
}

/**
 * One stated edit to the guard's source, refused unless it really applies.
 *
 * The target has to occur exactly once: zero means the guard was reworded and
 * this control has stopped controlling anything, and more than one means the
 * mutation is not the one described. Either way it throws here rather than
 * letting the case pass on an unmutated copy.
 */
function substitution(from, to) {
  const mutate = (source) => {
    const occurrences = source.split(from).length - 1;
    assert.equal(
      occurrences,
      1,
      `the mutation target must appear exactly once in the guard, found ${occurrences}: ${from}`,
    );

    const mutated = source.replace(from, to);
    assert.notEqual(mutated, source, `the mutation changed nothing: ${from} -> ${to}`);
    return mutated;
  };

  mutate.description = `${from}  ->  ${to}`;
  return mutate;
}

const MUTATION = {
  // Exactly the narrowing #1034's body wrongly claimed was already the case.
  tildesUnmodelled: substitution("(`{3,}|~{3,})", "(`{3,})"),
  anyMarkerCloses: substitution("fence[2][0] === open.char", "true"),
  threeMarkersClose: substitution("fence[2].length >= open.length", "fence[2].length >= 3"),
  onlyLongerCloses: substitution("fence[2].length >= open.length", "fence[2].length > open.length"),
  onlyEqualCloses: substitution("fence[2].length >= open.length", "fence[2].length === open.length"),
  everyBlockIsBash: substitution("language: fence[3].toLowerCase(),", 'language: "bash",'),
  exemptOnlyBackticks: substitution(
    'const marker = EXEMPTION.exec((lines[i - 1] ?? "").trim());',
    'const marker = fence[2][0] === "`" ? EXEMPTION.exec((lines[i - 1] ?? "").trim()) : null;',
  ),
  indentedFenceUnmodelled: substitution("/^(\\s*)(", "/^()("),
};

const TICK = "```";
const TILDE = "~~~";
const FIXTURE = ".github/copilot-instructions.md";

// A real Windows PowerShell 5.1 parse error, and the one the guard exists for.
const CHAIN = "cd web && npm run validate";

// A covered block that is read and found clean. Its job is to make "exit 0"
// mean *the corpus was scanned and nothing was found* rather than *the scan
// found nothing to read*, which the guard reports as exit 2.
const SENTINEL = [`${TICK}bash`, "Write-Output 'ok'", TICK];

const document = (...lines) => `${lines.flat().join("\n")}\n`;

function assertFlagged(result, expected, message) {
  assert.deepEqual(
    result.findings,
    [{ path: FIXTURE, line: expected.line, rule: expected.rule, evidence: expected.evidence }],
    `${message}\n${result.output}`,
  );
  assert.equal(result.status, 1, `${message}: the guard must exit 1 on a finding\n${result.output}`);
}

function assertClean(result, scanned, message) {
  assert.deepEqual(result.findings, [], `${message}: expected no finding\n${result.output}`);
  assert.equal(result.status, 0, `${message}: the guard must exit 0\n${result.output}`);
  // The load-bearing half. Without it this assertion also passes when the fence
  // model went blind and nothing was read at all.
  assert.equal(
    result.scanned,
    scanned,
    `${message}: the run must report reading ${scanned} covered block(s)\n${result.output}`,
  );
}

describe("both fence markers open a block", () => {
  //  1  # Fixture
  //  2
  //  3  ~~~bash
  //  4  cd web && npm run validate
  //  5  ~~~
  const tilde = document("# Fixture", "", `${TILDE}bash`, CHAIN, TILDE, "", SENTINEL);
  const backtick = document("# Fixture", "", `${TICK}bash`, CHAIN, TICK, "");

  it("extracts a tilde-opened block with its language and its body", () => {
    // A finding at all means `fence[3]` was read as `bash` and routed through
    // COVERED_LANGUAGES; the line means `fenceLine + finding.line` is right; the
    // evidence means the body survived extraction.
    assertFlagged(
      guardRun(tilde),
      { line: 4, rule: "chain-operator", evidence: CHAIN },
      "a ~~~bash block carrying a parse error must be flagged",
    );
  });

  it("extracts a backtick-opened block, which is the arm that must survive the mutation", () => {
    assertFlagged(
      guardRun(backtick),
      { line: 4, rule: "chain-operator", evidence: CHAIN },
      "a ```bash block carrying a parse error must be flagged",
    );
  });

  it(`goes red when tildes are not modelled: ${MUTATION.tildesUnmodelled.description}`, () => {
    // The tilde block becomes prose, so its parse error is never read -- and the
    // sentinel is, which is what makes this "the tilde block vanished" rather
    // than "the guard stopped reading anything".
    assertClean(
      guardRun(tilde, MUTATION.tildesUnmodelled),
      1,
      "with tildes unmodelled the ~~~bash block must go unread",
    );

    // The other half of the same run: the mutation must be specific. A change
    // that blinded the guard entirely would satisfy the assertion above.
    assertFlagged(
      guardRun(backtick, MUTATION.tildesUnmodelled),
      { line: 4, rule: "chain-operator", evidence: CHAIN },
      "the same mutation must leave backtick fences working",
    );
  });
});

describe("a fence is closed only by its own marker", () => {
  // The case with real consequences: read wrongly, a stray line merges two
  // blocks or swallows the rest of the file. The parse error sits *after* the
  // foreign fence line, so it falls outside the block if that line closed it.
  //
  //  3  ```bash          3  ~~~bash
  //  4  Write-Output 'a'  4  Write-Output 'a'
  //  5  ~~~               5  ```
  //  6  cd web && ...     6  cd web && ...
  //  7  ```               7  ~~~
  const tildeInsideBackticks = document(
    "# Fixture", "", `${TICK}bash`, "Write-Output 'a'", TILDE, CHAIN, TICK, "", SENTINEL,
  );
  const backticksInsideTilde = document(
    "# Fixture", "", `${TILDE}bash`, "Write-Output 'a'", TICK, CHAIN, TILDE, "", SENTINEL,
  );

  it("does not let a ~~~ line close a backtick fence", () => {
    assertFlagged(
      guardRun(tildeInsideBackticks),
      { line: 6, rule: "chain-operator", evidence: CHAIN },
      "a ~~~ line inside a ``` fence must not close it",
    );
  });

  it("does not let a ``` line close a tilde fence", () => {
    assertFlagged(
      guardRun(backticksInsideTilde),
      { line: 6, rule: "chain-operator", evidence: CHAIN },
      "a ``` line inside a ~~~ fence must not close it",
    );
  });

  it(`goes red when any marker closes: ${MUTATION.anyMarkerCloses.description}`, () => {
    // The foreign fence line now closes the block early, so the parse error
    // lands in prose and is never judged -- silently, at exit 0.
    assertClean(
      guardRun(tildeInsideBackticks, MUTATION.anyMarkerCloses),
      1,
      "a ~~~ line closing a ``` fence must lose the finding",
    );
    assertClean(
      guardRun(backticksInsideTilde, MUTATION.anyMarkerCloses),
      1,
      "a ``` line closing a ~~~ fence must lose the finding",
    );
  });
});

describe("a fence is closed only by a run at least as long as its own", () => {
  //  3  ~~~~bash          3  ~~~~bash           3  ~~~~bash
  //  4  Write-Output 'a'  4  Write-Output 'a'   4  Write-Output 'a'
  //  5  ~~~               5  ~~~~               5  ~~~~~
  //  6  cd web && ...     6                     6
  //  7  ~~~~              7  cd web && ...      7  cd web && ...
  const shortRunDoesNotClose = document(
    "# Fixture", "", "~~~~bash", "Write-Output 'a'", TILDE, CHAIN, "~~~~", "", SENTINEL,
  );
  const equalRunCloses = document(
    "# Fixture", "", "~~~~bash", "Write-Output 'a'", "~~~~", "", CHAIN, "", SENTINEL,
  );
  const longerRunCloses = document(
    "# Fixture", "", "~~~~bash", "Write-Output 'a'", "~~~~~", "", CHAIN, "", SENTINEL,
  );

  it("is not closed by a shorter run", () => {
    assertFlagged(
      guardRun(shortRunDoesNotClose),
      { line: 6, rule: "chain-operator", evidence: CHAIN },
      "~~~ must not close a ~~~~ fence",
    );
  });

  it("is closed by an equal run, so what follows is prose", () => {
    // Two blocks read: the four-tilde one and the sentinel. The parse error sits
    // between them, outside both.
    assertClean(guardRun(equalRunCloses), 2, "~~~~ must close a ~~~~ fence");
  });

  it("is closed by a longer run too", () => {
    assertClean(guardRun(longerRunCloses), 2, "~~~~~ must close a ~~~~ fence");
  });

  it(`goes red when three markers always close: ${MUTATION.threeMarkersClose.description}`, () => {
    assertClean(
      guardRun(shortRunDoesNotClose, MUTATION.threeMarkersClose),
      1,
      "a ~~~ closing a ~~~~ fence must lose the finding",
    );
  });

  it(`goes red when only a longer run closes: ${MUTATION.onlyLongerCloses.description}`, () => {
    // The fence never closes, so the prose after it is swallowed into the block
    // and judged as shell -- the opposite failure, and the reason both
    // directions of the comparison are pinned rather than only the strict one.
    assertFlagged(
      guardRun(equalRunCloses, MUTATION.onlyLongerCloses),
      { line: 7, rule: "chain-operator", evidence: CHAIN },
      "a ~~~~ fence that no longer closes on ~~~~ must swallow the prose after it",
    );
  });

  it(`goes red when only an equal run closes: ${MUTATION.onlyEqualCloses.description}`, () => {
    assertFlagged(
      guardRun(longerRunCloses, MUTATION.onlyEqualCloses),
      { line: 7, rule: "chain-operator", evidence: CHAIN },
      "a ~~~~ fence that no longer closes on ~~~~~ must swallow the prose after it",
    );
  });
});

describe("a tilde fence's language tag routes through the covered set", () => {
  //  3  ~~~text
  //  4  cd web && npm run validate
  //  5  ~~~
  const uncovered = document("# Fixture", "", `${TILDE}text`, CHAIN, TILDE, "", SENTINEL);

  it("reads an uncovered tilde language and skips the block", () => {
    // The paired negative. The positive -- ~~~bash producing a finding -- is the
    // first case in this file; together they establish that the tag is read
    // rather than that every tilde block is scanned or none is.
    assertClean(guardRun(uncovered), 1, "a ~~~text block must not be judged as shell");
  });

  it(`goes red when every block is treated as bash: ${MUTATION.everyBlockIsBash.description}`, () => {
    assertFlagged(
      guardRun(uncovered, MUTATION.everyBlockIsBash),
      { line: 4, rule: "chain-operator", evidence: CHAIN },
      "with the language tag discarded the ~~~text block must be judged",
    );
  });
});

describe("the exemption marker is read for a tilde fence too", () => {
  const REASON = "quoted from a transcript; not a prescription";

  //  3  <!-- shell-parse-exempt: ... -->
  //  4  ~~~bash
  //  5  cd web && npm run validate
  //  6  ~~~
  const marked = document(
    "# Fixture", "", `<!-- shell-parse-exempt: ${REASON} -->`, `${TILDE}bash`, CHAIN, TILDE, "", SENTINEL,
  );
  const unmarked = document("# Fixture", "", `${TILDE}bash`, CHAIN, TILDE, "");

  it("exempts a marked tilde block and names it on a passing run", () => {
    const result = guardRun(marked);

    assertClean(result, 1, "a marked ~~~bash block must not be judged");
    // ADR 0018 again, this time the guard's own: a block that was skipped is not
    // a block that was read and found clean, so it is named even when the run
    // passes.
    assert.deepEqual(
      result.exemptions,
      [{ path: FIXTURE, line: 4, reason: REASON }],
      `the exempted block must be named with its reason\n${result.output}`,
    );
  });

  it("flags the same body when the marker is absent", () => {
    // The control that makes the exemption a decision rather than a blind spot.
    assertFlagged(
      guardRun(unmarked),
      { line: 4, rule: "chain-operator", evidence: CHAIN },
      "the exempted body must fail when it is not exempted",
    );
  });

  it(`goes red when the lookback skips tildes: ${MUTATION.exemptOnlyBackticks.description}`, () => {
    assertFlagged(
      guardRun(marked, MUTATION.exemptOnlyBackticks),
      { line: 5, rule: "chain-operator", evidence: CHAIN },
      "with the lookback restricted to backticks the marked block must be judged",
    );
  });
});

describe("an indented fence is recognised", () => {
  // Named in #1040's account of the gap, and absent from its numbered criteria.
  // It pins recognition and the reported line, not the `Math.min` strip -- see
  // the header for why the strip is unobservable from outside the process.
  //
  //  5    ~~~bash
  //  6    cd web && npm run validate
  //  7    ~~~
  const indented = document(
    "# Fixture", "", "- A list item that carries a block:", "",
    `  ${TILDE}bash`, `  ${CHAIN}`, `  ${TILDE}`, "", SENTINEL,
  );

  it("judges the body of a tilde fence indented under a list item", () => {
    assertFlagged(
      guardRun(indented),
      { line: 6, rule: "chain-operator", evidence: CHAIN },
      "an indented ~~~bash block must be judged",
    );
  });

  it(`goes red when the fence must start at column 0: ${MUTATION.indentedFenceUnmodelled.description}`, () => {
    assertClean(
      guardRun(indented, MUTATION.indentedFenceUnmodelled),
      1,
      "with indentation unmodelled the indented block must go unread",
    );
  });
});

describe("a corpus the fence model reads nothing out of is not a pass", () => {
  it("exits 2 rather than 0 when no covered block was scanned", () => {
    // The assumption every `assertClean` above rests on, established rather than
    // inherited: without a sentinel those cases would pass on a guard whose
    // fence model had gone entirely blind.
    const result = guardRun(document("# Fixture", "", `${TICK}text`, CHAIN, TICK, ""));

    assert.equal(result.status, 2, `a scan of nothing must exit 2\n${result.output}`);
    assert.match(result.output, /A scan of nothing is not a pass/);
    assert.equal(result.scanned, null, "a refused run reports no scanned count");
  });
});
