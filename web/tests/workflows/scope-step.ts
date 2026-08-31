/**
 * Runs a workflow's changed-file scope step through a real `bash`, so a test can
 * judge what the shell actually does with `grep`'s exit status rather than what
 * the script's text looks like it should do.
 *
 * This is the harness #609 introduced inline in `web-ci.test.ts`, lifted into a
 * module because #691 needs the same execution against four more scope steps
 * across three workflows. Copying it four times would reproduce, in the tests,
 * precisely the failure the issue is about: one shape duplicated across
 * siblings, fixed in one copy, left standing in the others. The semantics are
 * unchanged from #609 -- the same stubs, the same environment, the same relative
 * `GITHUB_OUTPUT`, the same refusal to skip when `bash` is missing.
 * `web-ci.test.ts` keeps its own copy: rewriting another issue's tests is not
 * this change's business.
 *
 * Kept out of a `.test.ts` file for the reason `eol-policy.ts` is, one directory
 * over: a harness that has only ever been pointed at a healthy input has not
 * been shown to fail. Each test file still extracts its own step with its own
 * YAML helpers, exactly as the four sibling files already do, so a step renamed
 * out from under a test throws there and reddens the file rather than leaving it
 * to collect nothing and report green.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ScopeOutcome {
  /** The step's own exit status. Anything but 0 is a step that failed the job. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** The contents of `$GITHUB_OUTPUT`, or null when the step wrote nothing. */
  githubOutput: string | null;
}

export interface ScopeRunner {
  /**
   * Run the committed step for a pull request whose changed-file list is
   * `changed`. `grepExit` replaces `grep` with a stub returning that status;
   * left undefined, the real `grep` runs against the real committed pattern.
   */
  run(changed: string, grepExit?: number): ScopeOutcome;
  /** Remove every temporary directory this runner created. */
  cleanup(): void;
}

/**
 * A runner for one committed scope script.
 *
 * `env` carries whatever event data that particular workflow reads. The
 * changed-file list arrives through `CHANGED_FILES` so that no path or filename
 * is ever interpolated into the script under test.
 */
export function scopeStepRunner(script: string, env: Record<string, string>): ScopeRunner {
  const directories: string[] = [];

  return {
    run(changed: string, grepExit?: number): ScopeOutcome {
      const directory = mkdtempSync(join(tmpdir(), 'scope-step-'));
      directories.push(directory);

      // `git` is stubbed rather than run: what is under test is what the step
      // decides from a changed-file list, not how it obtains one.
      const gitStub = `
git() {
  printf '%s' "$CHANGED_FILES"
}
`;

      // Real grep writes a diagnostic and exits non-zero when it cannot run, so
      // the stub reproduces both channels and the script is judged on the same
      // evidence the runner would give it.
      const grepStub =
        grepExit === undefined
          ? ''
          : `
grep() {
  printf 'grep: stubbed failure\\n' >&2
  return ${grepExit}
}
`;

      // `.gitattributes` pins the working tree to LF, but blobs stored with CRLF
      // exist in this repository and a checkout elsewhere could carry one. A
      // stray CR makes bash fail on `$'\r': command not found`, which reads as
      // an unrelated defect. Same normalisation, and same reason, as the check
      // step harness in `source-link-health.test.ts`.
      const normalised = script.replace(/\r\n/g, '\n');

      writeFileSync(join(directory, 'step.sh'), `${gitStub}${grepStub}\n${normalised}\n`, 'utf8');

      const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', 'step.sh'], {
        // `cwd` here and the relative `GITHUB_OUTPUT` below are load-bearing on
        // Windows: an absolute path such as `C:\Users\...` inside a bash
        // double-quoted string has its backslashes eaten as escapes.
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_OUTPUT: './github-output',
          // A relative RUNNER_TEMP for the same reason, for the steps that
          // write a baseline file beside their output.
          RUNNER_TEMP: '.',
          ...env,
          CHANGED_FILES: changed,
        },
        encoding: 'utf8',
      });

      if (run.error !== undefined) {
        // Never a skip. A test that did not run is not a test that passed, and
        // the shell semantics this exists to pin are exactly what CI would stop
        // checking. `bash` is present on `ubuntu-latest`, where these run in CI,
        // and ships with Git for Windows.
        throw new Error(`could not run bash, which these tests require: ${run.error.message}`);
      }

      return {
        status: run.status,
        stdout: run.stdout ?? '',
        stderr: run.stderr ?? '',
        githubOutput: existsSync(join(directory, 'github-output'))
          ? readFileSync(join(directory, 'github-output'), 'utf8')
          : null,
      };
    },

    cleanup(): void {
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
      directories.length = 0;
    },
  };
}
