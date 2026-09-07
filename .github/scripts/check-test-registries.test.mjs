// # The registry model of `check-test-registries.mjs`, pinned
//
// The guard's own self-check drives `analyse` and `registrationsIn` with literal
// data, which pins the comparison and the extractor but never constructs a
// *repository*. The directory walk, the three registry paths, the two vacuity
// refusals and the exit codes all ship unpinned unless something exercises them
// end to end.
//
// ## How the guard is exercised
//
// It takes no arguments -- "so the job cannot be pointed at an emptier tree" --
// derives `REPO_ROOT` from its own file URL, and exports nothing. So it is
// neither importable nor aimable. Each case therefore copies the committed
// script into a temporary repository root, which is what makes `REPO_ROOT`
// resolve to that root, writes a fixture corpus of registries and test files,
// and runs the copy in a child process. The shipped bytes are executed. Same
// arrangement, and same reason, as `check-shell-invocations.test.mjs`.
//
// ## Every case carries an arm required to differ
//
// A pin written as an assertion that cannot fail is no pin. Two kinds of arm are
// used, and they answer different questions:
//
//   - a **corpus** arm changes the fixture -- a registration removed, a path
//     pointed at nothing -- and asks whether the guard's verdict follows the
//     input. This is the direction the issue asks to be demonstrated.
//   - a **mutation** arm changes the guard's own source, with `substitution`
//     asserting the target appears exactly once, and asks whether the case's
//     assertion is load-bearing. A case whose expectation survives its detector
//     being deleted was testing nothing.
//
// Both directions appear. A suite whose every arm expects a finding cannot tell
// a working guard from one that flags everything, so the clean arms are as
// load-bearing as the failing ones.
//
// ## The per-registry removal the real repository cannot demonstrate
//
// The guard reads coverage as a **union**: a file is covered when at least one
// registry names it. On trunk every test file is named by two registries, so
// removing one registration correctly leaves the file covered and the guard
// correctly passes. That is the designed behaviour and not a gap, but it means
// the real repository cannot demonstrate "remove the registration and it fails"
// for a single registry.
//
// The corpora below therefore include files named by exactly one registry, where
// removing that one registration is the removal of the last one and the guard
// does fail. Both readings are pinned: `single registry` for the per-registry
// direction, `union` for the two-registry direction.
//
// ## A clean arm must prove it read something
//
// The guard exits 2 when the listing is empty or a registry yields nothing, so
// exit 0 alone cannot separate *read and clean* from *nothing was read* (ADR
// 0018). Every clean expectation therefore reads the file count out of the
// passing banner rather than trusting the exit code, and the vacuity cases pin
// the exit-2 path itself so that the distinction is established here and not
// assumed.
//
// Run: node --test .github/scripts/check-test-registries.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./check-test-registries.mjs", import.meta.url));
const GUARD_SOURCE = readFileSync(GUARD, "utf8");

const SKILLS_CI = ".github/workflows/skills-ci.yml";
const LINK_HEALTH = ".github/workflows/source-link-health.yml";
const PREFLIGHT = ".github/scripts/ci-preflight.mjs";

const T1 = ".github/scripts/one.test.mjs";
const T2 = ".github/scripts/source-link-health/two.test.mjs";
const T3 = ".github/skills/somewhere/tests/three.test.mjs";

const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// --- the three registry syntaxes actually in use, as builders -----------------
//
// Each ends with a line that must terminate the argument region, because a
// builder whose region ran to the end of the file would pass whatever the
// termination rule did.

/** `skills-ci.yml`: one `run:` line per path. */
const yamlOneLine = (paths) =>
  `${paths.map((path) => `        run: node --test ${path}`).join("\n      - name: Next\n")}\n      - name: Done\n`;

/** `source-link-health.yml`: one `run:` line carrying several paths. */
const yamlManyPaths = (paths) => `        run: node --test ${paths.join(" ")}\n      - name: Done\n`;

/** `ci-preflight.mjs`: a single-line `args` array per path. */
const jsInline = (paths) =>
  `${paths.map((path) => `        args: ['--test', '${path}'],`).join("\n      },\n      {\n")}\n      },\n`;

/** `ci-preflight.mjs`: a multi-line `args` array carrying several paths. */
const jsMultiLine = (paths) =>
  `        args: [\n          '--test',\n${paths.map((path) => `          '${path}',`).join("\n")}\n        ],\n      },\n`;

/**
 * Run the guard -- committed, or with one substitution applied -- over a fixture
 * corpus.
 *
 * `registries` maps each of the guard's three registry paths to its text; every
 * one must be present, because the guard exits 2 on a registry it cannot read.
 * `testFiles` are created as real files so the directory walk has something to
 * find.
 */
function guardRun({ registries, testFiles }, mutation = null) {
  const root = mkdtempSync(join(tmpdir(), "check-test-registries-"));
  roots.push(root);

  const write = (relative, text) => {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, "utf8");
  };

  const script = join(root, ".github", "scripts", "check-test-registries.mjs");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, mutation === null ? GUARD_SOURCE : mutation(GUARD_SOURCE), "utf8");

  for (const [path, text] of Object.entries(registries)) write(path, text);
  for (const path of testFiles) write(path, "// a fixture test file\n");

  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.error, undefined, `the guard could not be started: ${run.error?.message}`);

  const output = `${run.stdout}${run.stderr}`;
  const passing = /OK -- all (\d+) /.exec(output);

  return {
    status: run.status,
    output,
    // `    <path>` under the [orphan] heading. Stale lines carry spaces, and
    // coverage lines are indented 2 or 6, so neither can match here.
    orphans: [...output.matchAll(/^ {4}(\S+)$/gm)].map((match) => match[1]),
    // `    <registry> names <path>`
    stale: [...output.matchAll(/^ {4}(\S+) names (\S+)$/gm)].map((match) => ({
      registry: match[1],
      path: match[2],
    })),
    counted: passing === null ? null : Number(passing[1]),
  };
}

/**
 * One stated edit to the guard's source, refused unless it really applies.
 *
 * The target has to occur exactly once: zero means the guard was reworded and
 * this control has stopped controlling anything, and more than one means the
 * mutation is not the one described.
 */
function substitution(from, to) {
  return (source) => {
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
}

/** A clean verdict, read off the banner rather than off the exit code alone. */
function assertClean(result, expectedFiles, why) {
  assert.equal(result.status, 0, `${why}\n${result.output}`);
  assert.equal(
    result.counted,
    expectedFiles,
    `${why} -- exit 0 must be a verdict about ${expectedFiles} file(s), not a scan of nothing\n${result.output}`,
  );
}

/**
 * The corpus every case starts from: three registries, three test files, all
 * covered. `T1` is named twice on purpose, so the union direction has something
 * to remove; `T2` and `T3` are named once, so the per-registry direction does.
 */
const clean = () => ({
  registries: {
    [SKILLS_CI]: yamlOneLine([T1]),
    [LINK_HEALTH]: yamlManyPaths([T2]),
    [PREFLIGHT]: jsInline([T1, T3]),
  },
  testFiles: [T1, T2, T3],
});

describe("check-test-registries", () => {
  it("passes a corpus in which every test file is named, and says how many it read", () => {
    const result = guardRun(clean());
    assertClean(result, 3, "a fully covered corpus must pass");
    assert.match(result.output, /named by at least one of 3 registries/);

    // The arm that makes the pass a measurement: break the extractor and the
    // same corpus stops passing. Without this, exit 0 could mean the guard read
    // nothing and compared nothing.
    const blinded = guardRun(
      clean(),
      substitution('const FLAG = "--test";', 'const FLAG = "--no-such-flag";'),
    );
    assert.notEqual(
      blinded.status,
      0,
      `a guard that cannot read a registration must not report the corpus clean\n${blinded.output}`,
    );
  });

  it("fails when a test file on disk is named by no registry", () => {
    const corpus = clean();
    corpus.testFiles.push(".github/skills/somewhere/tests/orphan.test.mjs");

    const result = guardRun(corpus);
    assert.equal(result.status, 1, `an unregistered test file must fail\n${result.output}`);
    assert.deepEqual(result.orphans, [".github/skills/somewhere/tests/orphan.test.mjs"]);
    assert.match(result.output, /\[orphan\]/);

    // Load-bearing check: delete the orphan rule and this case must stop failing.
    const neutered = guardRun(
      corpus,
      substitution(
        "const orphans = onDisk.filter((path) => !covered.has(path));",
        "const orphans = [];",
      ),
    );
    assert.notEqual(
      neutered.status,
      1,
      `the orphan verdict did not come from the orphan rule\n${neutered.output}`,
    );
  });

  it("fails when a registry names a file that does not exist", () => {
    const corpus = clean();
    corpus.registries[SKILLS_CI] = yamlOneLine([T1, ".github/scripts/deleted.test.mjs"]);

    const result = guardRun(corpus);
    assert.equal(result.status, 1, `a registration pointing at nothing must fail\n${result.output}`);
    assert.deepEqual(result.stale, [
      { registry: SKILLS_CI, path: ".github/scripts/deleted.test.mjs" },
    ]);
    assert.match(result.output, /\[stale\]/);

    // Load-bearing check: delete the stale rule and this case must stop failing.
    const neutered = guardRun(
      corpus,
      substitution(
        "      if (!onDisk.includes(path)) stale.push({ registry, path });",
        "      void registry; void path;",
      ),
    );
    assert.notEqual(
      neutered.status,
      1,
      `the stale verdict did not come from the stale rule\n${neutered.output}`,
    );
  });

  describe("removing a registration", () => {
    it("fails when the file was named by a single registry", () => {
      // T3 is named only by the preflight. Removing it there is the removal of
      // the last registration, so the guard must fail. This is the literal
      // per-registry reading of the issue's third criterion, which the real
      // repository cannot exhibit because every file there is named twice.
      const before = guardRun(clean());
      assertClean(before, 3, "the corpus must be clean before the registration is removed");

      const corpus = clean();
      corpus.registries[PREFLIGHT] = jsInline([T1]);
      const after = guardRun(corpus);

      assert.equal(after.status, 1, `removing the only registration must fail\n${after.output}`);
      assert.deepEqual(after.orphans, [T3]);
      assert.notEqual(before.status, after.status, "the two arms must differ, or neither is evidence");
    });

    it("passes when another registry still names the file, and fails once both drop it", () => {
      // T1 is named by skills-ci and by the preflight. Coverage is a union, so
      // one removal is not a defect and must not be reported as one.
      const oneLeft = clean();
      oneLeft.registries[SKILLS_CI] = yamlOneLine([".github/scripts/source-link-health/two.test.mjs"]);
      const stillCovered = guardRun(oneLeft);
      assertClean(stillCovered, 3, "a file named by a second registry is still covered");

      const noneLeft = clean();
      noneLeft.registries[SKILLS_CI] = yamlOneLine([".github/scripts/source-link-health/two.test.mjs"]);
      noneLeft.registries[PREFLIGHT] = jsInline([T3]);
      const dropped = guardRun(noneLeft);

      assert.equal(dropped.status, 1, `dropping the last registration must fail\n${dropped.output}`);
      assert.deepEqual(dropped.orphans, [T1]);
      assert.notEqual(
        stillCovered.status,
        dropped.status,
        "the union arm and the no-coverage arm must differ",
      );
    });
  });

  describe("the registry syntaxes actually in use", () => {
    // Each case makes one syntax the *only* thing naming a file. If the
    // extractor could not read that form the file would read as an orphan, so a
    // clean verdict is evidence the form was parsed. The paired arm removes the
    // flag, which must turn the same corpus into an orphan report -- otherwise
    // the clean verdict came from somewhere other than the parse.
    const forms = [
      ["a yaml run line with one path", (paths) => yamlOneLine(paths)],
      ["a yaml run line with several paths", (paths) => yamlManyPaths(paths)],
      ["a single-line js args array", (paths) => jsInline(paths)],
      ["a multi-line js args array", (paths) => jsMultiLine(paths)],
    ];

    for (const [label, build] of forms) {
      it(`reads ${label}`, () => {
        const only = ".github/scripts/only-here.test.mjs";
        const corpus = {
          registries: {
            [SKILLS_CI]: yamlOneLine([T1]),
            [LINK_HEALTH]: yamlManyPaths([T2]),
            [PREFLIGHT]: `${jsInline([T3])}${build([only])}`,
          },
          testFiles: [T1, T2, T3, only],
        };

        assertClean(guardRun(corpus), 4, `${label} was not read as a registration`);

        const unflagged = {
          ...corpus,
          registries: {
            ...corpus.registries,
            [PREFLIGHT]: `${jsInline([T3])}${build([only]).replace("--test", "--other")}`,
          },
        };
        const control = guardRun(unflagged);
        assert.equal(
          control.status,
          1,
          `without the flag the same path must stop counting, or the clean arm proved nothing\n${control.output}`,
        );
        assert.deepEqual(control.orphans, [only]);
      });
    }
  });

  it("does not read a bare mention as a registration", () => {
    // The conservative direction: a path named without `--test` is not a path
    // that runs, and counting it would be a false pass.
    const mentioned = ".github/scripts/mentioned.test.mjs";
    const corpus = clean();
    corpus.registries[PREFLIGHT] = `${jsInline([T1, T3])}        // see ${mentioned} for the fixture\n        run: node ${mentioned}\n`;
    corpus.testFiles.push(mentioned);

    const result = guardRun(corpus);
    assert.equal(result.status, 1, `a mention is not a registration\n${result.output}`);
    assert.deepEqual(result.orphans, [mentioned]);
  });

  it("does not read a commented-out registration as a registration", () => {
    const commented = ".github/scripts/commented.test.mjs";
    const corpus = clean();
    corpus.registries[PREFLIGHT] = `${jsInline([T1, T3])}        // args: ['--test', '${commented}'],\n`;
    corpus.testFiles.push(commented);

    const result = guardRun(corpus);
    assert.equal(result.status, 1, `a commented registration must not count\n${result.output}`);
    assert.deepEqual(result.orphans, [commented]);
  });

  describe("an empty scan is refused rather than passed", () => {
    it("exits 2 when no test file is found at all", () => {
      const result = guardRun({ registries: clean().registries, testFiles: [] });
      assert.equal(result.status, 2, `a listing of nothing is not a pass\n${result.output}`);
      assert.match(result.output, /A scan of nothing is not a pass/);
      // It must not be silent about it: exit 2 and exit 0 have to be separable
      // by more than the number, because a caller may only read the text.
      assert.doesNotMatch(result.output, /OK --/);
    });

    it("exits 2 when a registry yields no registration", () => {
      const corpus = clean();
      corpus.registries[SKILLS_CI] = "      - name: A workflow that runs no test at all\n";
      // T1 is still named by the preflight, so this is not an orphan report:
      // the only thing wrong is that one registry went quiet.
      const result = guardRun(corpus);
      assert.equal(result.status, 2, `a registry that names nothing is not a pass\n${result.output}`);
      assert.match(result.output, /yielded no registration at all/);
      assert.match(result.output, /skills-ci\.yml/);
    });

    it("exits 2 when a registry is missing entirely", () => {
      const corpus = clean();
      delete corpus.registries[LINK_HEALTH];
      const result = guardRun(corpus);
      assert.equal(result.status, 2, `an unreadable registry is not a pass\n${result.output}`);
      assert.match(result.output, /cannot read the registry/);
    });
  });

  it("refuses arguments, so it cannot be pointed at an emptier tree", () => {
    const root = mkdtempSync(join(tmpdir(), "check-test-registries-args-"));
    roots.push(root);
    const script = join(root, ".github", "scripts", "check-test-registries.mjs");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, GUARD_SOURCE, "utf8");

    const run = spawnSync(process.execPath, [script, ".github/scripts"], { encoding: "utf8" });
    assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
    assert.match(`${run.stdout}${run.stderr}`, /takes no arguments/);
  });

  it("reports which registry covers which file, on passing runs too", () => {
    // ADR 0018: a reader cannot act on either finding without knowing where the
    // coverage came from, and a report printed only on failure leaves a passing
    // run indistinguishable from a run that looked at nothing.
    const result = guardRun(clean());
    assertClean(result, 3, "the corpus must pass for this to be about a passing run");
    assert.match(result.output, /Coverage as measured:/);
    for (const path of [T1, T2, T3]) {
      assert.ok(result.output.includes(path), `${path} is missing from the coverage report`);
    }
    assert.match(result.output, /Not checked by this program:/);
  });
});
