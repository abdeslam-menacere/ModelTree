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

import { describe, expect, it } from 'vitest';

import { stripAnsi } from './ansi.mjs';
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
 * Spawn the wrapper and capture what it said, with escape sequences removed.
 *
 * astro colours its output too (`\u001B[1mResult (194 files): \u001B[22m`), and
 * a runner colours where a coding agent's shell does not -- see `ansi.mjs`. The
 * `not.toContain` assertions below are the reason this matters most: a phrase
 * broken up by escape codes would make them pass for the wrong reason, which is
 * a false green rather than a red.
 */
async function runScript(args: string[]) {
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
      child.on('close', (code) =>
        settle({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) }),
      );
    },
  );
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
        expect(`${form}: ${result.stdout}`).toContain('Result (');
        expect({ form, code: result.code }).toEqual({ form, code: 0 });
      }

      expect(stray.stderr).toContain('refusing to run');
      expect(stray.code).not.toBe(0);
    },
    180_000,
  );
});
