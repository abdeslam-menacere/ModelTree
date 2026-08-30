// Pins the fix for issue #601: `npm run test -- <path>` must scope the run to
// `<path>`, or refuse -- never silently run all 88 files and report green.
//
// The defect was invisible to every existing test because nothing in the suite
// read `package.json`'s `test` script, and nothing compared "how many files did
// I ask for" against "how many files ran". Those two numbers are the whole
// subject of this file. A run that ignores its filter and a run that honours it
// are indistinguishable by exit code, by colour, and by the word "passed"; they
// differ only in a count, so a count is what has to be asserted.
//
// Convention note (CONTRIBUTING.md, rule 4): the process cases below are built
// so that the old behaviour would fail them. Under the `&&` chain this replaces,
// the scoped case would report `Test Files 88 passed (88)` and the no-match case
// would report a green full suite instead of exit 1. Neither can pass by
// accident on a run that quietly widened.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COVERAGE_VERIFIER,
  FULL_RUN_ARGS,
  REPORT_PATH,
  formatFileList,
  formatNoMatchRefusal,
  formatScopeNotice,
  planRun,
} from './run-tests.mjs';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('./run-tests.mjs', import.meta.url));

const scripts = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * A real, small test file used as the scoped target. Named rather than
 * generated: a fixture test file placed under `web/` would itself become an
 * 89th discovered file, and the count is the measurement here.
 */
const SCOPED_TARGET = 'src/lib/format.test.ts';

/** A path shaped like a test file that no file on disk matches. */
const UNMATCHABLE_TARGET = 'src/lib/there-is-no-such-file.test.ts';

async function runScript(args: string[]) {
  // The parent is itself a vitest worker, and its VITEST_* variables describe
  // that run. Handing them to a child that starts its own Vitest would let the
  // harness leak into what is under test.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
  );

  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (settle, fail) => {
      const child = spawn(process.execPath, [scriptPath, ...args], { cwd: webRoot, env });
      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', fail);
      child.on('close', (code) => settle({ code, stdout, stderr }));
    },
  );
}

describe('the npm scripts this file is about', () => {
  // The regression guard for the defect itself. Restoring the `&&` chain --
  // the shape that made npm append the filter past vitest and onto the
  // coverage verifier -- fails here by name.
  it('routes `npm run test` through the wrapper rather than a && chain', () => {
    expect(scripts.test).toBe('node scripts/run-tests.mjs');
    expect(scripts.test).not.toContain('&&');
  });

  it('leaves `npm run validate` composed of the two scripts CI runs separately', () => {
    expect(scripts.validate).toBe('npm run test && npm run check');
  });
});

describe('the plan an argv produces', () => {
  it('runs the unfiltered suite and then the coverage verifier when given nothing', () => {
    const plan = planRun([]);

    expect(plan.scoped).toBe(false);
    expect(plan.verifyCoverage).toBe(true);
    // Criterion 3 of #601, restated as an assertion: CI and the Pages deploy
    // reach vitest through exactly the arguments the old chain used.
    expect(plan.vitestArgs).toEqual([
      'run',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${REPORT_PATH}`,
    ]);
    expect(FULL_RUN_ARGS).toContain(`--outputFile=${REPORT_PATH}`);
  });

  it('hands a forwarded path to vitest, where the old chain sent it to the verifier', () => {
    const plan = planRun([SCOPED_TARGET]);

    expect(plan.scoped).toBe(true);
    expect(plan.vitestArgs).toEqual(['run', '--reporter=default', SCOPED_TARGET]);
    expect(plan.pathFilters).toEqual([SCOPED_TARGET]);
    // A scoped run must not leave a partial report at the path the verifier
    // defaults to, and must not claim the coverage of a full suite.
    expect(plan.vitestArgs.join(' ')).not.toContain(REPORT_PATH);
    expect(plan.verifyCoverage).toBe(false);
  });

  it('leaves filtering to vitest once an option is present, rather than guessing', () => {
    const plan = planRun(['-t', 'formats']);

    expect(plan.scoped).toBe(true);
    // `formats` is a value of `-t`, not a path. Claiming it as one would
    // produce a confident, wrong "matched 0 files" refusal.
    expect(plan.pathFilters).toEqual([]);
    expect(plan.vitestArgs).toEqual(['run', '--reporter=default', '-t', 'formats']);
    expect(plan.verifyCoverage).toBe(false);
  });
});

describe('what a scoped run says about itself', () => {
  it('prints both counts, so a widened run cannot read like a scoped one', () => {
    const notice = formatScopeNotice({
      forwarded: [SCOPED_TARGET],
      matched: [SCOPED_TARGET],
      discoveredCount: 88,
    });

    expect(notice).toContain('SCOPED run');
    expect(notice).toContain('Matched 1 of 88 discovered test file(s)');
    expect(notice).toContain(SCOPED_TARGET);
    expect(notice).toContain(COVERAGE_VERIFIER);
    expect(notice).toContain('NOT the full suite');
  });

  it('says nothing ran, and does not call the exit code a pass, when nothing matched', () => {
    const refusal = formatNoMatchRefusal({ forwarded: [UNMATCHABLE_TARGET], discoveredCount: 88 });

    expect(refusal).toContain('refusing to run');
    expect(refusal).toContain(UNMATCHABLE_TARGET);
    expect(refusal).toContain('Matched 0 of 88');
    expect(refusal).toContain('The full suite did NOT run');
  });

  it('counts the files it does not print rather than dropping them', () => {
    const files = Array.from({ length: 12 }, (_, index) => `src/file-${index}.test.ts`);
    const listed = formatFileList(files, 10);

    expect(listed).toContain('src/file-0.test.ts');
    expect(listed).toContain('... and 2 more');
    expect(listed).not.toContain('src/file-11.test.ts');
  });
});

// The cases that would have caught #601, and the only ones that observe the
// real run rather than a plan. They spawn the wrapper as a process, so the
// numbers asserted are numbers vitest produced.
describe('the script run as a process', () => {
  it(
    'runs strictly fewer files than the suite discovers when scoped to one file',
    async () => {
      const { code, stdout } = await runScript([SCOPED_TARGET]);

      const counts = stdout.match(/Matched (\d+) of (\d+) discovered test file\(s\)/u);
      expect(counts, `no scope notice in:\n${stdout}`).not.toBeNull();

      const matched = Number(counts?.[1]);
      const discovered = Number(counts?.[2]);

      // The guard against a vacuous comparison: a discovery that collapsed to
      // one file would satisfy "fewer" trivially (CONTRIBUTING.md, rule 1).
      expect(discovered).toBeGreaterThan(1);
      expect(matched).toBe(1);
      expect(matched).toBeLessThan(discovered);

      // vitest's own count, independently of the notice above it. The two
      // agreeing is what makes the notice evidence rather than a label -- and
      // this is the line that read `Test Files 88 passed (88)` before the fix.
      expect(stdout).toContain('Test Files  1 passed (1)');
      // The coverage verifier is a full-suite guard and must not claim to have
      // vouched for a partial run.
      expect(stdout).not.toContain('test-coverage check:');
      expect(code).toBe(0);
    },
    120_000,
  );

  it(
    'refuses a path that matches nothing instead of falling back to the whole suite',
    async () => {
      const { code, stdout, stderr } = await runScript([UNMATCHABLE_TARGET]);

      expect(stderr).toContain('refusing to run');
      expect(stderr).toContain(UNMATCHABLE_TARGET);
      expect(stderr).toMatch(/Matched 0 of \d+ discovered test file\(s\)/u);
      // The measurement that separates "refused" from "ran everything and
      // passed": vitest prints this line on any run it starts, so its absence
      // is the evidence that no run started.
      expect(stdout).not.toContain('Test Files');
      expect(code).toBe(1);
    },
    120_000,
  );
});
