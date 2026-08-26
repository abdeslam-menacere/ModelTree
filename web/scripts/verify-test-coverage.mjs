// Guards `npm run test` against the failure recorded in issue #218: a vitest
// fork-worker startup timeout can drop an entire discovered test file while the
// run still reports a plausible, green-looking pass count. The pass count is
// computed only over the files vitest managed to run, so a file it never started
// contributes nothing -- not a pass, not a fail, not even to the total -- and the
// omission is invisible to a reader counting passes.
//
// This repository's whole release process is predict-then-verify: a merge is
// refused unless the observed test count matches a prediction. That is only sound
// if the reporter cannot silently run fewer files than it discovered. So the
// defect being closed is "the count can be wrong and still look right", not the
// timeout itself.
//
// The denominator is not a hard-coded number. It is asked of vitest directly,
// with `globTestSpecifications()` -- the exact discovery the run itself uses to
// decide which files to schedule. The numerator is the set of files the JSON
// report shows results for. Because both sides derive from the same source (the
// files on disk matching vitest's own include globs), adding or removing a test
// file moves them together; the only way they can diverge is the bug -- a
// discovered file that produced no result. That is why the derivation cannot
// drift into the sixteen-times "documentation asserts a value the code owns"
// defect class: no value is asserted here at all.
//
// Issue #245 closes the residue #218 left: set membership alone is blind to a
// file that is *present in the report but holds zero test results*. That state
// hides exactly as much as an absent file -- the tests did not run either way --
// yet it slips past the missing/unexpected check because the file does have a
// name in `testResults`. #218 only caught it incidentally, because the crash
// that produced it also made vitest exit non-zero; the verifier on its own said
// nothing. So a reported file whose per-file test count is zero is now a named
// failure, with the same message quality as the missing-file branch.
//
// The decision on a *legitimately* empty test file (one matching the glob but
// containing no it()/test()) is deliberate and strict: it is an error, not an
// exemption. The report cannot tell a dropped/killed worker apart from a file
// that simply had no tests -- both surface as "present, zero results" -- so
// exempting the latter would reopen the exact hole this guard exists to close,
// and would make the guard more permissive than #218's. Every discovered file
// today carries tests, so there is nothing to exempt; an empty test file is
// treated as the accident it almost always is and must be deleted or filled.
//
// -- Issue #270: skipped-only files, and why they are reported and not refused --
//
// #245 closed "present, zero results". It does not touch the neighbouring state:
// a file whose every test is `it.skip`, `describe.skip`, or `it.todo`. Those
// still emit one entry each in `assertionResults` (observed, vitest 4.1.10:
// `it.skip` -> status `skipped`, `it.todo` -> status `todo`, and `describe.skip`
// emits each child individually with status `skipped`), so the length is >= 1,
// the #245 count check is satisfied, and the file reads as covered. Worse, the
// report's own `numTotalTests` counts skipped and todo tests, so the headline
// figure this repo's predict-then-verify process compares against a prediction
// does not move when a suite is skipped either. Nothing downstream said the file
// stopped being exercised.
//
// Four behaviours were on the table (issue #270): (1) fail when every result in
// a file is skipped/todo; (2) report such a file distinctly -- covered, but zero
// *executed* tests -- without failing; (3) fail unless the file carries a
// checked-in quarantine marker; (4) accept it and only document the limit.
//
// The decision is (2), and the reasoning is that the defect here is a *claim*
// defect, not a missing refusal. What was wrong was the output: "all reported
// results" was true but read as "all exercised", and a reader forms the belief
// "these 19 files are covered" at exactly that line. So the line now separates
// executed from merely discovered-and-reported, and names every file that
// executed nothing.
//
// (1) was rejected because it has a cost the repository would actually pay: a
// deliberately quarantined suite is a legitimate state, and turning it into a
// hard CI failure removes the quarantine mechanism with no escape short of
// deleting the file -- which loses the tests entirely, the worse outcome. That
// is a strictly larger blast radius than the problem being fixed, and unlike the
// #218/#245 branches it would refuse a run that is *not* untrustworthy: every
// test that ran, ran, and the report says so accurately. (3) was rejected
// because it invents a marker convention for a state no file in this repository
// is currently in, and the marker then becomes its own thing to keep honest. (4)
// was rejected because it leaves the overstated wording in place, which is the
// one outcome the issue rules out.
//
// `it.skip`, `describe.skip`, and `it.todo` are handled identically and
// deliberately: all three mean "this test did not run", which is the only
// property this check is about. Whether the author intends to come back is not
// something the JSON report records and not something this guard should guess.
//
// Known limits, stated rather than papered over:
//   - This does not stop a skip from reaching main. It makes the skip loud at
//     the point the coverage claim is made; it does not refuse the run. A skip
//     landing silently is prevented only to the extent that someone reads CI
//     output, and that is the deliberate trade for keeping quarantine usable.
//   - "Executed" is an allow-list -- status `passed` or `failed` -- rather than
//     a deny-list of skip-ish statuses. Any status this file does not recognise
//     (jest's `pending`/`disabled`, or anything a future vitest adds) therefore
//     counts as *not* executed. That is the deliberate direction to be wrong in:
//     the failure mode being closed is overstating what ran, so an unknown
//     status must never be silently counted as exercised.
//   - It is per-file, not per-test. A file with 40 tests where 39 are skipped
//     still executed one, so it is not named on the not-exercised line. The
//     run-wide skipped/todo tally on the summary line is what surfaces that
//     case; there is no per-file threshold, because any threshold would be a
//     number this code asserts rather than derives.

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Normalise an absolute path to a lower-cased, forward-slash path relative to
 * `root`, so a path from vitest's glob and a path from the JSON report compare
 * equal regardless of separator or drive-letter casing on Windows.
 */
export function normaliseFile(absolutePath, root) {
  return relative(root, absolutePath).replaceAll('\\', '/').toLowerCase();
}

/**
 * The heart of the check, kept pure so it can be unit tested without starting
 * vitest. Given the set of files vitest intended to run (`expected`), the set it
 * actually reported results for (`reported`), and the subset of those that held
 * zero test results (`empty`), plus the report's own totals, decide whether the
 * run is trustworthy.
 *
 * `unexecuted` -- files that reported results but executed none of them -- is
 * carried through and returned, and deliberately never contributes a problem.
 * Issue #270 chose reporting over refusal there; the header explains why. It
 * lives on this result rather than being computed in `main` so that "this does
 * not fail the run" is an assertable property of the pure function, not a
 * property of a script nobody can call.
 *
 * @param {{ expected: string[], reported: string[], empty?: string[], unexecuted?: string[], report: object }} input
 * @returns {{ ok: boolean, problems: string[], missing: string[], unexpected: string[], empty: string[], unexecuted: string[] }}
 */
export function compareCoverage({ expected, reported, empty = [], unexecuted = [], report }) {
  const expectedSet = new Set(expected);
  const reportedSet = new Set(reported);

  const missing = [...expectedSet].filter((file) => !reportedSet.has(file)).sort();
  const unexpected = [...reportedSet].filter((file) => !expectedSet.has(file)).sort();
  const emptyReported = [...new Set(empty)].sort();
  const unexecutedReported = [...new Set(unexecuted)].sort();

  const problems = [];

  if (missing.length > 0) {
    problems.push(
      `${missing.length} discovered test file(s) produced no result and were silently omitted ` +
        `from the reported count (a dropped file / fork-worker failure): ${missing.join(', ')}`,
    );
  }

  if (emptyReported.length > 0) {
    problems.push(
      `${emptyReported.length} reported test file(s) held zero test results, so a discovered ` +
        `file ran nothing while the run still looked green (a killed/dropped worker, or a file ` +
        `with no it()/test()): ${emptyReported.join(', ')}`,
    );
  }

  if (unexpected.length > 0) {
    problems.push(
      `${unexpected.length} reported test file(s) were not in the discovered set, so the ` +
        `denominator and the run disagree: ${unexpected.join(', ')}`,
    );
  }

  if (report && report.success !== true) {
    problems.push('The vitest JSON report does not record success: true.');
  }

  if (report && typeof report.numFailedTests === 'number' && report.numFailedTests > 0) {
    problems.push(`The vitest JSON report records ${report.numFailedTests} failed test(s).`);
  }

  if (
    report &&
    typeof report.numFailedTestSuites === 'number' &&
    report.numFailedTestSuites > 0
  ) {
    problems.push(
      `The vitest JSON report records ${report.numFailedTestSuites} failed test suite(s).`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    missing,
    unexpected,
    empty: emptyReported,
    unexecuted: unexecutedReported,
  };
}

/**
 * Count, per discovered file, how many individual test results the report holds
 * for it. In vitest's JSON (jest-compatible) report each `testResults` entry is
 * one file and its `assertionResults` array is that file's tests, so the length
 * of that array is the per-file test count. Files are keyed by their normalised
 * name and duplicate entries for the same file are summed.
 *
 * @returns {Map<string, number>}
 */
export function testCountsByFile(report, root) {
  const results = Array.isArray(report && report.testResults) ? report.testResults : [];
  const counts = new Map();
  for (const result of results) {
    if (!result || typeof result.name !== 'string' || result.name.length === 0) {
      continue;
    }
    const key = normaliseFile(result.name, root);
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults.length : 0;
    counts.set(key, (counts.get(key) ?? 0) + assertions);
  }
  return counts;
}

/**
 * The normalised names of files the report lists but for which it holds zero
 * test results -- present-but-empty, the blind spot #245 closes.
 */
export function emptyReportedFiles(report, root) {
  return [...testCountsByFile(report, root).entries()]
    .filter(([, count]) => count === 0)
    .map(([file]) => file)
    .sort();
}

/**
 * The statuses that mean a test body actually ran. Deliberately an allow-list:
 * see the known-limits note in this file's header for why an unrecognised
 * status must fall on the "did not run" side rather than the other way round.
 */
export const EXECUTED_STATUSES = new Set(['passed', 'failed']);

/**
 * Split each reported file's results into the tests that ran and the tests that
 * were only discovered. A vitest `assertionResults` entry exists for a skipped
 * or todo test just as it does for one that ran, which is precisely why the
 * #245 length check cannot see the difference; the status field is where the
 * difference actually lives.
 *
 * @returns {Map<string, { total: number, executed: number, notExecuted: number }>}
 */
export function executionCountsByFile(report, root) {
  const results = Array.isArray(report && report.testResults) ? report.testResults : [];
  const counts = new Map();
  for (const result of results) {
    if (!result || typeof result.name !== 'string' || result.name.length === 0) {
      continue;
    }
    const key = normaliseFile(result.name, root);
    const bucket = counts.get(key) ?? { total: 0, executed: 0, notExecuted: 0 };
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    for (const assertion of assertions) {
      bucket.total += 1;
      if (assertion && EXECUTED_STATUSES.has(assertion.status)) {
        bucket.executed += 1;
      } else {
        bucket.notExecuted += 1;
      }
    }
    counts.set(key, bucket);
  }
  return counts;
}

/**
 * Sum the per-file execution buckets into run-wide totals, so the summary line
 * can state how much of the reported test count actually ran.
 *
 * @returns {{ total: number, executed: number, notExecuted: number }}
 */
export function executionTotals(report, root) {
  const totals = { total: 0, executed: 0, notExecuted: 0 };
  for (const bucket of executionCountsByFile(report, root).values()) {
    totals.total += bucket.total;
    totals.executed += bucket.executed;
    totals.notExecuted += bucket.notExecuted;
  }
  return totals;
}

/**
 * The normalised names of files that reported at least one result but executed
 * none of them -- every test skipped or todo. The `total > 0` guard is what
 * keeps this disjoint from #245's `empty` set: a file with no results at all is
 * that branch's failure and must not be double-reported here as a quarantine.
 */
export function unexecutedReportedFiles(report, root) {
  return [...executionCountsByFile(report, root).entries()]
    .filter(([, bucket]) => bucket.total > 0 && bucket.executed === 0)
    .map(([file]) => file)
    .sort();
}

/**
 * Build the success summary. Kept pure and exported so the exact wording is
 * under test: the acceptance criterion of issue #270 is about what this string
 * claims, so the string is the thing that has to be asserted on.
 *
 * @param {{ expectedFileCount: number, totals: { total: number, executed: number, notExecuted: number }, unexecuted?: string[] }} input
 * @returns {string}
 */
export function formatCoverageSummary({ expectedFileCount, totals, unexecuted = [] }) {
  const tally =
    `${totals.total} reported test(s): ${totals.executed} executed, ` +
    `${totals.notExecuted} skipped/todo`;

  if (unexecuted.length === 0) {
    return (
      `test-coverage check: ${expectedFileCount} discovered test file(s) all reported results ` +
      `and all executed at least one test (${tally}).`
    );
  }

  return (
    `test-coverage check: ${expectedFileCount} discovered test file(s) all reported results, ` +
    `but ${unexecuted.length} of them executed no tests (${tally}).\n` +
    `  Discovered and reported, but NOT exercised -- every test in them is skipped or todo: ` +
    `${unexecuted.join(', ')}\n` +
    `  Reported, not refused: a deliberately quarantined suite is a legitimate state. See the ` +
    `known-limits note in scripts/verify-test-coverage.mjs.`
  );
}

/**
 * Pull the set of files the report actually holds results for.
 */
export function reportedFilesFrom(report, root) {
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  return results
    .map((result) => result && result.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .map((name) => normaliseFile(name, root));
}

async function readReport(reportPath) {
  let raw;
  try {
    raw = await readFile(reportPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the vitest JSON report at ${reportPath}: ${error.message}. ` +
        'The test run must write it before this check runs.',
    );
  }

  if (raw.trim().length === 0) {
    throw new Error(`The vitest JSON report at ${reportPath} is empty.`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`The vitest JSON report at ${reportPath} is not valid JSON: ${error.message}`);
  }
}

async function main() {
  const root = process.cwd();
  const reportPath = process.argv[2] ?? '.vitest/report.json';

  const report = await readReport(reportPath);

  // Ask vitest itself which files it would run. This uses the same config the
  // run used (there is none, so vitest's defaults), and it globs on the main
  // thread without spawning the fork workers, so it cannot itself hit the
  // startup-timeout bug it is here to detect.
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false });
  let expected;
  try {
    const specifications = await vitest.globTestSpecifications();
    expected = [...new Set(specifications.map((spec) => normaliseFile(spec.moduleId, root)))];
  } finally {
    await vitest.close();
  }

  const reported = [...new Set(reportedFilesFrom(report, root))];
  const empty = emptyReportedFiles(report, root);
  const unexecuted = unexecutedReportedFiles(report, root);
  const totals = executionTotals(report, root);
  const { ok, problems } = compareCoverage({ expected, reported, empty, unexecuted, report });

  const summary = formatCoverageSummary({
    expectedFileCount: expected.length,
    totals,
    unexecuted,
  });

  if (ok) {
    console.log(summary);
    return;
  }

  console.error('test-coverage check FAILED -- the run cannot be trusted:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    `\nDiscovered ${expected.length} test file(s); the report holds results for ${reported.length}.`,
  );
  // The not-exercised report is informational, so it survives the failure path
  // too rather than being swallowed by an unrelated refusal.
  if (unexecuted.length > 0) {
    console.error(summary);
  }
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`test-coverage check errored: ${error.message}`);
    process.exitCode = 1;
  });
}
