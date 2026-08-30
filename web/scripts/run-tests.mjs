// The entry point behind `npm run test`, and the fix for issue #601.
//
// -- What was wrong --
//
// `test` used to be a `&&` chain:
//
//   vitest run --reporter=default --reporter=json --outputFile=.vitest/report.json
//     && node scripts/verify-test-coverage.mjs .vitest/report.json
//
// npm appends the arguments of `npm run test -- <path>` to the end of the whole
// script string, not to the command a reader assumes owns them. So the filter
// landed on `verify-test-coverage.mjs` as `argv[3]`, which that script never
// reads, while `vitest run` -- sitting in the first clause -- never saw it at
// all. The whole suite ran, the filter was discarded without a word, and the
// exit code was 0.
//
// The direction of that failure is what made it worth a script rather than a
// note in the README: it failed toward reassurance. A full green suite and a
// targeted green suite look alike, so "I ran just this file and it passed" was
// being written on the strength of a run that was never scoped to the file
// named. This repository's premise is that a claim is worth what its evidence
// is worth, and that particular claim was worth nothing.
//
// -- What this does instead --
//
// A script rather than a chain, because the argument has to reach vitest and
// only a real argv can decide what to do with it. Two modes, and the mode is
// decided by whether anything was forwarded at all:
//
//   * No arguments -- the CI and deploy path -- runs exactly what the chain ran,
//     in the same order, and prints nothing of its own. `npm run test`,
//     `npm run validate` and `npm run build` are unchanged, deliberately: the
//     Pages deploy gates on them, and this fix is not allowed to move them.
//
//   * Any argument at all is a scoped run. The filters go to vitest, where they
//     belong, and the run is announced on stdout before it starts -- the filters,
//     how many of the discovered files they matched, and which. The coverage
//     verifier does not run for a scoped run (see below), and the announcement
//     says so rather than leaving its absence to be noticed.
//
// The announcement is the part that does the work. "Matched 1 of 88 discovered
// test file(s)" is a claim that a reader can compare against vitest's own
// "Test Files 1 passed (1)" two lines later, and against the 88 the unfiltered
// run reports. A scoped run and a full run stop being able to look alike, which
// is the defect, rather than merely being differently configured.
//
// -- Why the coverage verifier is skipped, and not merely broken, when scoped --
//
// `verify-test-coverage.mjs` asks vitest which files it would discover and
// refuses the run unless every one of them reported a result. That is precisely
// a full-suite guard: point it at a one-file run and it refuses, correctly, with
// 87 "discovered but produced no result" failures. So a scoped run cannot pass
// through it, and forcing it to would mean weakening it -- the one thing issue
// #601 rules out, since it exists to catch exactly the kind of quiet
// under-running this fix is about. It is skipped, loudly, and the scoped run
// says in its own output that it is not a substitute for `npm run test`.
// `.github/scripts/ci-preflight.mjs` reached the same conclusion independently
// and for the same reason; it calls vitest's entry point directly.
//
// A scoped run also does not write `.vitest/report.json`. A partial report left
// at the path the verifier defaults to is a trap of the same family as the one
// being closed here: the next reader of that file would be reading a one-file
// run as though it described the suite.
//
// -- Why zero matches is a refusal --
//
// A filter that matches nothing must not degrade into anything that runs. The
// pre-check uses vitest's own `globTestSpecifications`, the same discovery the
// run itself uses, so the count in the message cannot drift from the count that
// decides what runs. It applies when every forwarded argument is a path filter;
// once an option is present, this script does not guess which of the remaining
// arguments is an option's value and which is a path, and lets vitest -- which
// does know -- do the filtering. vitest exits non-zero on no matching files, so
// the guarantee holds either way; what is lost in that case is only the count in
// the message, not the refusal.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { localBin } from './local-bin.mjs';
// The same path shape the coverage verifier compares in, imported rather than
// rewritten so the two cannot describe the same file differently.
import { repoRelativeFile } from './verify-test-coverage.mjs';

/** Where the JSON report goes, and the argument `verify-test-coverage.mjs` reads. */
export const REPORT_PATH = '.vitest/report.json';

/** The coverage verifier, run only after an unfiltered suite. */
export const COVERAGE_VERIFIER = 'scripts/verify-test-coverage.mjs';

/**
 * The unfiltered run, byte for byte what the old `&&` chain passed to vitest.
 * CI, `npm run validate` and the Pages deploy all reach vitest through here.
 */
export const FULL_RUN_ARGS = Object.freeze([
  'run',
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${REPORT_PATH}`,
]);

/**
 * A scoped run: the default reporter and nothing else, so no JSON report is
 * written from a run that describes only part of the suite.
 */
export const SCOPED_RUN_ARGS = Object.freeze(['run', '--reporter=default']);

/**
 * Decide what a given argv means. Pure, so the wiring below is the only part
 * that needs a process to test.
 *
 * @param {string[]} forwarded arguments npm forwarded, `process.argv.slice(2)`
 */
export function planRun(forwarded) {
  if (forwarded.length === 0) {
    return {
      scoped: false,
      forwarded: [],
      pathFilters: [],
      // Only an unfiltered run can satisfy a check that every discovered file
      // reported, so this is the only plan that runs it.
      verifyCoverage: true,
      vitestArgs: [...FULL_RUN_ARGS],
    };
  }

  const options = forwarded.filter((argument) => argument.startsWith('-'));

  return {
    scoped: true,
    forwarded: [...forwarded],
    // Claimed as path filters only when nothing in the list could be an
    // option's value. Naming a flag's value as an unmatched path would produce
    // a confident, wrong refusal, which is worse than no pre-check at all.
    pathFilters: options.length === 0 ? [...forwarded] : [],
    verifyCoverage: false,
    vitestArgs: [...SCOPED_RUN_ARGS, ...forwarded],
  };
}

/** At most `limit` paths, one per line, with the remainder counted rather than dropped. */
export function formatFileList(files, limit = 10) {
  const shown = files.slice(0, limit).map((file) => `    ${file}`);
  const hidden = files.length - shown.length;
  return hidden > 0 ? [...shown, `    ... and ${hidden} more`].join('\n') : shown.join('\n');
}

/**
 * What a scoped run prints before it starts. Both counts come from the same
 * discovery, so the line is a comparison a reader can make rather than a label.
 */
export function formatScopeNotice({ forwarded, matched, discoveredCount }) {
  const lines = [`npm run test: SCOPED run -- filters: ${forwarded.join(' ')}`];

  if (matched === null) {
    lines.push(
      '  An option was passed, so vitest applies the filtering and this notice does',
      '  not count the files first. vitest fails the run if nothing matches.',
    );
  } else {
    lines.push(`  Matched ${matched.length} of ${discoveredCount} discovered test file(s):`);
    lines.push(formatFileList(matched));
  }

  lines.push(
    `  This is NOT the full suite, and ${COVERAGE_VERIFIER} does not run for a`,
    '  scoped run -- it requires every discovered file to have reported. Run',
    '  `npm run test` with no arguments before claiming the suite passes.',
  );

  return lines.join('\n');
}

/** What a filter that matched nothing prints, on the way to exit 1. */
export function formatNoMatchRefusal({ forwarded, discoveredCount }) {
  return [
    `npm run test: refusing to run -- filters: ${forwarded.join(' ')}`,
    `  Matched 0 of ${discoveredCount} discovered test file(s), so nothing ran.`,
    '  The full suite did NOT run and this exit code is not a pass.',
    '  A filter is matched against the test file path relative to web/, as a',
    '  substring: `npm run test -- src/lib/format.test.ts` or',
    '  `npm run test -- src/lib`. For the whole suite, pass no arguments.',
  ].join('\n');
}

/**
 * Ask vitest which files it discovers, and which of them the filters keep.
 * Globbing runs on the main thread and starts no workers, so this costs a
 * second and cannot itself fail the way a real run can.
 */
export async function resolveFilters(pathFilters) {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false });
  try {
    const root = process.cwd();
    const relative = (specifications) => [
      ...new Set(specifications.map((specification) => repoRelativeFile(specification.moduleId, root))),
    ];
    return {
      discovered: relative(await vitest.globTestSpecifications()),
      matched: relative(await vitest.globTestSpecifications(pathFilters)),
    };
  } finally {
    await vitest.close();
  }
}

/** Run a command to completion, inheriting the streams so output is unchanged. */
export function run(command, args) {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', fail);
    // A child killed by a signal has no exit code; 1 keeps that a failure
    // rather than letting `null` read as success downstream.
    child.on('close', (code) => settle(code ?? 1));
  });
}

export async function main(forwarded) {
  const plan = planRun(forwarded);

  if (plan.scoped) {
    let matched = null;
    let discoveredCount = 0;

    if (plan.pathFilters.length > 0) {
      const resolved = await resolveFilters(plan.pathFilters);
      matched = resolved.matched;
      discoveredCount = resolved.discovered.length;

      if (matched.length === 0) {
        console.error(formatNoMatchRefusal({ forwarded: plan.forwarded, discoveredCount }));
        return 1;
      }
    }

    console.log(formatScopeNotice({ forwarded: plan.forwarded, matched, discoveredCount }));
  }

  const vitestExit = await run(process.execPath, [localBin('vitest'), ...plan.vitestArgs]);
  if (vitestExit !== 0 || !plan.verifyCoverage) {
    return vitestExit;
  }

  // The second half of the old `&&` chain, with the report path still passed
  // explicitly as `argv[2]` -- the argument that script reads.
  return await run(process.execPath, [COVERAGE_VERIFIER, REPORT_PATH]);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`npm run test: could not start the run: ${error.message}`);
      process.exitCode = 1;
    });
}
