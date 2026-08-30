// The entry point behind `npm run check`, and the second half of issue #601.
//
// `check` used to be `astro check`, which is a fine command with one property
// that matters here: **it silently ignores a positional path argument.**
// Observed on astro 7.2.0, `astro check src/lib/format.ts` prints
// `Result (188 files)` -- the whole project -- and exits 0, saying nothing about
// the path it was handed.
//
// That matters because `validate` is `npm run test && npm run check`, and npm
// appends forwarded arguments to the end of the whole script string. So
// `npm run validate -- <path>` expanded to:
//
//   npm run test && npm run check <path>
//
// The tests ran unfiltered, then `astro check` swallowed the path, and the
// developer who asked for a scoped validation got a green whole-project result
// that read as one. Fixing `npm run test -- <path>` alone would have left this
// half of the same defect in place, at the command most likely to be trusted.
//
// `validate` has to keep the shape `npm run test && npm run check`: web-ci.yml
// runs those two as separately-named steps and `web/tests/workflows/web-ci.test.ts`
// proves the CI steps expand to exactly the leaf commands the Pages deploy
// gates on. So the refusal belongs in `check`, which is the command the
// arguments actually reach.
//
// What is refused is narrow, and deliberately so: a *positional* argument, the
// shape astro ignores. Options are passed straight through, so
// `npm run check -- --watch` and anything else astro's CLI defines keeps
// working, and an option astro does not know is astro's to reject and to word.
//
// One limit, stated rather than left to be discovered: under
// `npm run validate -- <path>` the test stage runs first and in full, so this
// refusal arrives after a complete unfiltered suite. It makes the outcome red
// and names what happened; it cannot make the wasted run not happen, because
// the arguments never pass through the test stage at all. The message says so.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { localBin } from './local-bin.mjs';

/**
 * Decide what a given argv means. Pure, so only the spawn below needs a process.
 *
 * @param {string[]} forwarded arguments npm forwarded, `process.argv.slice(2)`
 */
export function planCheck(forwarded) {
  const positional = forwarded.filter((argument) => !argument.startsWith('-'));

  return {
    refuse: positional.length > 0,
    positional,
    astroArgs: ['check', ...forwarded],
  };
}

/** What a swallowed path prints, on the way to exit 1. */
export function formatPositionalRefusal(positional) {
  return [
    `npm run check: refusing to run -- ignored path argument(s): ${positional.join(' ')}`,
    '  `astro check` has no per-file mode. It checks the whole project and drops a',
    '  path argument without a word, so running it would have reported a',
    '  whole-project result that reads as scoped to what you named.',
    '  Nothing was checked, and this exit code is not a pass.',
    '  To scope a test run, use `npm run test -- <path>`. For the diagnostics, use',
    '  `npm run check` with no arguments.',
    '  If you got here from `npm run validate -- <path>`: that form cannot scope',
    '  anything, and the test stage above it has already run the FULL suite, not',
    '  the path you named. Use `npm run test -- <path>` to scope the tests.',
  ].join('\n');
}

/** Run a command to completion, inheriting the streams so output is unchanged. */
export function run(command, args) {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', fail);
    // A child killed by a signal has no exit code; 1 keeps that a failure.
    child.on('close', (code) => settle(code ?? 1));
  });
}

export async function main(forwarded) {
  const plan = planCheck(forwarded);

  if (plan.refuse) {
    console.error(formatPositionalRefusal(plan.positional));
    return 1;
  }

  return await run(process.execPath, [localBin('astro'), ...plan.astroArgs]);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`npm run check: could not start astro check: ${error.message}`);
      process.exitCode = 1;
    });
}
