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
// this wrapper could.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
      child.on('close', (code) => settle({ code, stdout, stderr }));
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

  it('names the invocation that does scope a run', () => {
    const refusal = formatPositionalRefusal([SWALLOWED_PATH]);

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
});
