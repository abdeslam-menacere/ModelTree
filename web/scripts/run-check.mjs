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
// Telling those apart takes more than "starts with a dash", because an option's
// value does not. `--root .` is two tokens and the second is not a path anyone
// wanted checked; refusing it, as an earlier version of this file did, narrows a
// command that worked. But the opposite reading is worse: astro parses its argv
// with yargs-parser and declares almost nothing boolean, so
// `astro check --verbose src/lib/format.ts` binds the path to `verbose` and
// checks all 193 files -- the path vanishing into a flag that never wanted one
// is exactly the silent whole-project-reported-as-scoped result this file
// exists to stop. So a bare token counts as a value only after an option
// *known* to take one, and every other bare token is refused. An option this
// list has not heard of is therefore refused rather than trusted, which can be
// a false alarm; it is a loud one, it names the way through (`--option=value`,
// which carries its own value and is passed straight on), and the alternative
// failure is the one #601 is about.
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
 * Options astro 7.2.0 takes a separate value for, so the bare token after one of
 * these is that value rather than a path. Read off `astro --help` (global
 * `--config <path>`, `--root <path>`, `--site <url>`, `--base <pathname>`) and
 * `astro check --help` (`--root`, `--tsconfig`, `--minimumFailingSeverity` and
 * `--minimumSeverity`, all typed `[string]`). Everything else those two list is
 * `[boolean]` and takes no value.
 *
 * Kept as normalised names so `--minimum-severity` reads the same as
 * `--minimumSeverity`; yargs-parser accepts both spellings, so this must too.
 */
export const VALUE_TAKING_OPTIONS = new Set([
  'base',
  'config',
  'minimumfailingseverity',
  'minimumseverity',
  'root',
  'site',
  'tsconfig',
]);

/** `--minimum-severity` and `--minimumSeverity` are one option to yargs-parser. */
function optionName(token) {
  return token.replace(/^-+/, '').replaceAll('-', '').toLowerCase();
}

/**
 * Decide what a given argv means. Pure, so only the spawn below needs a process.
 *
 * @param {string[]} forwarded arguments npm forwarded, `process.argv.slice(2)`
 */
export function planCheck(forwarded) {
  /** @type {{ token: string, after: string | null }[]} */
  const strays = [];
  let afterSeparator = false;

  for (let index = 0; index < forwarded.length; index += 1) {
    const token = forwarded[index];

    // A bare `--` ends option parsing for yargs-parser too: everything past it
    // lands in `_`, which is the pile astro drops.
    if (!afterSeparator && token === '--') {
      afterSeparator = true;
      continue;
    }

    if (!afterSeparator && token.startsWith('-') && token !== '-') {
      // `--root=.` carries its own value, so it consumes nothing after it.
      if (token.includes('=')) continue;

      const next = forwarded[index + 1];
      const takesValue =
        VALUE_TAKING_OPTIONS.has(optionName(token)) && next !== undefined && !next.startsWith('-');

      // Step over the value so it is never mistaken for a path.
      if (takesValue) index += 1;
      continue;
    }

    const previous = index > 0 ? forwarded[index - 1] : undefined;
    strays.push({
      token,
      after: previous !== undefined && previous.startsWith('-') ? previous : null,
    });
  }

  return {
    refuse: strays.length > 0,
    strays,
    positional: strays.map((stray) => stray.token),
    astroArgs: ['check', ...forwarded],
  };
}

/** What a swallowed path prints, on the way to exit 1. */
export function formatPositionalRefusal(strays) {
  const tokens = strays.map((stray) => stray.token);
  const afterOption = strays.filter((stray) => stray.after !== null && stray.after !== '--');

  const lines = [
    `npm run check: refusing to run -- ignored path argument(s): ${tokens.join(' ')}`,
    '  `astro check` has no per-file mode. It checks the whole project and drops a',
    '  path argument without a word, so running it would have reported a',
    '  whole-project result that reads as scoped to what you named.',
    '  Nothing was checked, and this exit code is not a pass.',
    '  To scope a test run, use `npm run test -- <path>`. For the diagnostics, use',
    '  `npm run check` with no arguments.',
    '  If you got here from `npm run validate -- <path>`: that form cannot scope',
    '  anything, and the test stage above it has already run the FULL suite, not',
    '  the path you named. Use `npm run test -- <path>` to scope the tests.',
  ];

  if (afterOption.length > 0) {
    const options = [...new Set(afterOption.map((stray) => stray.after))].join(' ');
    lines.push(
      `  Read as a path because \`${options}\` is not an option this wrapper knows to`,
      '  take a separate value, and astro would bind the token to the flag and check',
      '  everything anyway. If it really is that option\'s value, write it as',
      '  `--option=value`, which carries its own value and is passed straight through.',
    );
  }

  return lines.join('\n');
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
    console.error(formatPositionalRefusal(plan.strays));
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
