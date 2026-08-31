import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs `astro build` under a cross-process lock, so no two builds ever overlap.
 *
 * Vitest runs test files in parallel workers, and every build-integration test
 * spawns a full `astro build` at module load. Two of those running at once crash
 * libuv on Windows -- `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * file src\win\async.c` -- which aborts the build with no test-level error and
 * reddens the suite intermittently. The crash is Windows-specific, so it is
 * invisible on the Linux CI runner and only bites a contributor running
 * `npm run validate` locally, which is exactly the failure mode that is hardest
 * to trust.
 *
 * The lock is an atomic `mkdir`: whichever worker creates the lock directory
 * first builds, and the others spin synchronously until it is released. A
 * synchronous spin is correct here -- each worker is dedicated to its one test
 * file, and blocking it during module init is what serialises the builds.
 */

const astroBin = fileURLToPath(new URL('../../node_modules/astro/bin/astro.mjs', import.meta.url));
const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const lockDir = join(tmpdir(), 'modeltree-astro-build.lock');

const ACQUIRE_TIMEOUT_MS = 300_000;
const STALE_LOCK_MS = 300_000;
const POLL_MS = 200;

/** Blocks the current worker thread for `ms` without an event loop turn. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(): void {
  const start = Date.now();

  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      // Reclaim a lock a crashed worker never released, so one aborted build
      // cannot wedge every later run.
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The holder released it between our mkdir and our stat; just retry.
      }

      if (Date.now() - start > ACQUIRE_TIMEOUT_MS) {
        throw new Error('timed out waiting for the astro build lock');
      }

      sleepSync(POLL_MS);
    }
  }
}

/**
 * Builds the site into `outDir` with the given environment, holding the shared
 * build lock for the duration. `env` is passed through verbatim, so each caller
 * keeps full control of `SITE_URL`, `BASE_PATH`, and which variables it drops.
 */
export function buildSiteExclusively(outDir: string, env: NodeJS.ProcessEnv): void {
  acquireLock();

  try {
    execFileSync(process.execPath, [astroBin, 'build', '--outDir', outDir], {
      cwd: webRoot,
      env,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
