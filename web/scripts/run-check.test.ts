// Pins the other half of issue #601: `npm run validate -- <path>`.
//
// `validate` is `npm run test && npm run check`, and npm appends forwarded
// arguments to the end of the whole script string, so the path reaches
// `astro check` rather than the tests. Observed on astro 7.2.0,
// `astro check src/lib/format.ts` checks all 188 files and exits 0 without
// mentioning the path -- the same silent, reassuring failure the test half of
// this issue is about, at the command a contributor is told to trust.
//
// So `check` refuses a positional argument, and the refusal is what these cases
// pin. The scope of the refusal is narrow on purpose: options still reach astro,
// because a flag it does not know is a flag it will reject and word better than
// this wrapper could. An option's *value* is not a positional either --
// `--root .` is two tokens and only the first is a flag -- so the cases below
// pin both directions: the value is passed through, and a path that merely
// follows a valueless flag is still refused.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { stripAnsi } from './ansi.mjs';
import { localBin } from './local-bin.mjs';
import { formatPositionalRefusal, planCheck } from './run-check.mjs';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('./run-check.mjs', import.meta.url));

const scripts = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** A real source file, so the refusal cannot be read as "no such path". */
const SWALLOWED_PATH = 'src/lib/format.ts';

/**
 * The parent environment minus vitest's own variables.
 *
 * A spawned astro that sees `VITEST` in its environment behaves as if it were
 * running under the test runner, which is not what these cases are about.
 */
function childEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
  );
}

/**
 * Run `node <entry> <args>` to completion and return what it said, with escape
 * sequences removed.
 *
 * astro colours its output too (`\u001B[1mResult (194 files): \u001B[22m`), and
 * a runner colours where a coding agent's shell does not -- see `ansi.mjs`. The
 * `not.toContain` assertions below are the reason this matters most: a phrase
 * broken up by escape codes would make them pass for the wrong reason, which is
 * a false green rather than a red.
 */
async function collect(entry: string, args: string[]) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (settle, fail) => {
      const child = spawn(process.execPath, [entry, ...args], { cwd: webRoot, env: childEnv() });
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
      child.on('close', (code) =>
        settle({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) }),
      );
    },
  );
}

/** Spawn the wrapper and capture what it said. */
async function runScript(args: string[]) {
  return await collect(scriptPath, args);
}

describe('the npm script this file is about', () => {
  it('routes `npm run check` through the wrapper rather than straight to astro', () => {
    expect(scripts.check).toBe('node scripts/run-check.mjs');
  });
});

describe('the plan an argv produces', () => {
  it('runs plain `astro check` when given nothing, which is what CI runs', () => {
    const plan = planCheck([]);

    expect(plan.refuse).toBe(false);
    expect(plan.astroArgs).toEqual(['check']);
  });

  it('refuses a positional path, the argument astro check silently ignores', () => {
    const plan = planCheck([SWALLOWED_PATH]);

    expect(plan.refuse).toBe(true);
    expect(plan.positional).toEqual([SWALLOWED_PATH]);
  });

  it('passes an option through, so astro keeps owning its own flags', () => {
    const plan = planCheck(['--watch']);

    expect(plan.refuse).toBe(false);
    expect(plan.astroArgs).toEqual(['check', '--watch']);
  });

  // The regression this block exists for: `--root .` is an option and its value,
  // and reading the value as a stray path narrowed a command that worked.
  it.each([
    ['--root', '.'],
    ['--tsconfig', 'tsconfig.json'],
    ['--minimumSeverity', 'warning'],
    // yargs-parser folds this spelling onto the same option, so this must too.
    ['--minimum-severity', 'warning'],
  ])('takes the token after %s as its value, not as a path', (option, value) => {
    const plan = planCheck([option, value]);

    expect(plan.refuse).toBe(false);
    expect(plan.astroArgs).toEqual(['check', option, value]);
  });

  it('still refuses a path that follows a boolean flag, which astro would swallow', () => {
    // astro declares almost nothing boolean to yargs-parser, so it binds this
    // path to `--verbose` and checks everything -- #601 exactly.
    const plan = planCheck(['--verbose', SWALLOWED_PATH]);

    expect(plan.refuse).toBe(true);
    expect(plan.positional).toEqual([SWALLOWED_PATH]);
  });

  it('refuses rather than trusts an option it does not know takes a value', () => {
    const plan = planCheck(['--qa-invented-option', SWALLOWED_PATH]);

    expect(plan.refuse).toBe(true);
    expect(formatPositionalRefusal(plan.strays)).toContain('--option=value');
  });

  it('refuses a path hidden behind a bare `--`, which yargs also treats as positional', () => {
    const plan = planCheck(['--', SWALLOWED_PATH]);

    expect(plan.refuse).toBe(true);
    expect(plan.positional).toEqual([SWALLOWED_PATH]);
  });

  it('lets `--option=value` carry its own value without consuming the next token', () => {
    const plan = planCheck(['--root=.']);

    expect(plan.refuse).toBe(false);
    expect(plan.astroArgs).toEqual(['check', '--root=.']);
  });

  it('names the invocation that does scope a run', () => {
    const refusal = formatPositionalRefusal([{ token: SWALLOWED_PATH, after: null }]);

    expect(refusal).toContain(SWALLOWED_PATH);
    expect(refusal).toContain('npm run test -- <path>');
    expect(refusal).toContain('npm run validate -- <path>');
    expect(refusal).toContain('not a pass');
  });
});

describe('the script run as a process', () => {
  // Issue #679: `npm run validate` was red on the first run after a fresh
  // `npm ci` and green on a warm re-run of the same tree, failing on the
  // `Result (` assertion below with a received value that began
  // `17:52:23 [vite] [optimizer] bundling dependencies...`.
  //
  // -- What that line is --
  //
  // vite's dependency optimizer, from `packages/vite/src/node/optimizer/index.ts`:
  //
  //   const bundleTimer = setTimeout(() => {
  //     environment.logger.info('[optimizer] bundling dependencies...', { timestamp: true })
  //   }, 1000)
  //
  // It is on a one-second delay, so it is printed only when pre-bundling has
  // not finished within a second -- which needs both a cold
  // `node_modules/.vite/deps` and enough load to make the bundling slow. Both
  // hold in a fresh dock worktree, which has just run `npm ci` and is sharing a
  // machine with sibling agents.
  //
  // -- What it is not --
  //
  // It is not the banner *displacing* `Result (`. That was the reported
  // mechanism and it does not survive measurement: across 34 real cold-cache
  // checks here (idle, 4-hog and 10-hog load, and up to six concurrent), the
  // banner was purely additive -- 1810 stdout bytes where a run without it had
  // 1738, the extra 72 being the line itself -- and `Result (` followed it every
  // single time. `toContain` would pass with the banner merely in front of what
  // it looks for, so a received value that truly lacks `Result (` is a run that
  // never printed it at all.
  //
  // @astrojs/check prints that line unconditionally, from `console.info`
  // immediately after `checker.lint()` resolves, with no branch that skips it
  // outside watch mode. So stdout ending at the optimizer banner is a check that
  // died *during* pre-bundling -- before even `[types] Generated`, which is
  // otherwise stdout's first line. The banner is the timestamp on the wreck, not
  // the cause of it.
  //
  // -- Why this block was where it happened --
  //
  // The case below runs two full `astro check` processes at once against one
  // project root, so on a cold cache both drive vite's optimizer into the same
  // `node_modules/.vite/deps`, doing the same pre-bundle twice, while the other
  // ~100 files of this suite occupy the rest of the machine. Measured cost of
  // that cold window, wall clock per check: 20.7 s idle, 57-138 s under four
  // spinning hogs, and 321 s under ten -- against this block's own 180 s budget,
  // which a cold loaded run therefore also blows outright (observed: this file
  // red at 182136 ms with `Test timed out in 180000ms`).
  //
  // So the fix is to stop the assertions depending on optimizer state at all.
  // `astro sync` performs exactly the pre-bundle that emits the banner -- it was
  // observed printing that same line itself under load -- and none of the
  // 251-file diagnostics pass, costing 3.92 s from cold here. Running it once,
  // serially, before anything asserts leaves the real checks below a populated
  // cache to read and no optimizer pass of their own.
  //
  // This is not retry or flake tolerance, and the difference is not a matter of
  // framing: nothing that fails is ever re-run, no assertion is repeated, and a
  // genuinely broken wrapper still fails on the first attempt. A precondition is
  // established once rather than raced for by two processes that both assumed
  // someone else had established it. If `astro sync` itself cannot run, that is
  // thrown below rather than swallowed, because a warm-up that fails quietly
  // would put back the silence this whole file exists to remove.
  //
  // Filtering the banner out of the captured stdout was the other candidate and
  // is deliberately not done: it would be a no-op against a received value that
  // has no `Result (` in it either way, and it would delete the one piece of
  // evidence that says a cold optimizer pass was in flight when the check died.
  beforeAll(async () => {
    const { code, stdout, stderr } = await collect(localBin('astro'), ['sync']);

    if (code !== 0) {
      throw new Error(
        `astro sync exited ${code}, so vite's dependency cache was not populated and ` +
          'the checks below would each pre-bundle it themselves -- the cold-cache ' +
          `condition of issue #679.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    // Cold and idle this is ~4 s; cold under four spinning hogs it measured
    // 35.8 s. The explicit budget is therefore load-bearing rather than
    // decorative: the 30 s `hookTimeout` in `vitest.config.ts` was sized for
    // jsdom renders and that 35.8 s run would have blown it. 180 s matches the
    // block this hook protects.
  }, 180_000);

  it(
    'exits 1 without checking anything when handed a path',
    async () => {
      const { code, stdout, stderr } = await runScript([SWALLOWED_PATH]);

      expect(stderr).toContain('refusing to run');
      expect(stderr).toContain(SWALLOWED_PATH);
      // astro check prints this on any run it starts and a file count when it
      // finishes, so their absence is the evidence that nothing was checked --
      // as opposed to a whole-project check reported as if it were scoped.
      expect(stdout).not.toContain('Getting diagnostics');
      expect(stdout).not.toContain('Result (');
      expect(code).toBe(1);
    },
    60_000,
  );

  // Both halves of the control together, because either alone proves less: a
  // wrapper that accepted everything would pass the first two and fail the
  // third, and one that refused everything would pass the third and fail the
  // first two. The two real checks are awaited concurrently -- one full check is
  // ~30s and the pair costs about the same wall clock as one.
  it(
    'runs `--root .` and `--root=.` for real and still refuses a real stray path',
    async () => {
      const [spaced, equals, stray] = await Promise.all([
        runScript(['--root', '.']),
        runScript(['--root=.']),
        runScript([SWALLOWED_PATH]),
      ]);

      for (const [form, result] of [
        ['--root .', spaced],
        ['--root=.', equals],
      ] as const) {
        expect(`${form}: ${result.stderr}`).not.toContain('refusing to run');
        // Exit code before output, so a check that *died* says so instead of
        // reporting as a check that ran and printed the wrong thing. Under the
        // other order, the #679 failures read as "stdout lacked `Result (`",
        // and three separate docks and the issue itself concluded from that
        // wording that the optimizer banner had displaced the line -- a
        // mechanism that measurement does not support (see the note above).
        // Same assertions, same subjects; only the one that names the cause now
        // fires first.
        expect({ form, code: result.code }).toEqual({ form, code: 0 });
        expect(`${form}: ${result.stdout}`).toContain('Result (');
      }

      expect(stray.stderr).toContain('refusing to run');
      expect(stray.code).not.toBe(0);
    },
    180_000,
  );
});
