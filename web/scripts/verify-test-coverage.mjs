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
 * vitest. Given the set of files vitest intended to run (`expected`) and the set
 * it actually reported results for (`reported`), plus the report's own totals,
 * decide whether the run is trustworthy.
 *
 * @param {{ expected: string[], reported: string[], report: object }} input
 * @returns {{ ok: boolean, problems: string[], missing: string[], unexpected: string[] }}
 */
export function compareCoverage({ expected, reported, report }) {
  const expectedSet = new Set(expected);
  const reportedSet = new Set(reported);

  const missing = [...expectedSet].filter((file) => !reportedSet.has(file)).sort();
  const unexpected = [...reportedSet].filter((file) => !expectedSet.has(file)).sort();

  const problems = [];

  if (missing.length > 0) {
    problems.push(
      `${missing.length} discovered test file(s) produced no result and were silently omitted ` +
        `from the reported count (a dropped file / fork-worker failure): ${missing.join(', ')}`,
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

  return { ok: problems.length === 0, problems, missing, unexpected };
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
  const { ok, problems } = compareCoverage({ expected, reported, report });

  if (ok) {
    console.log(
      `test-coverage check: ${expected.length} discovered test file(s) all reported results ` +
        `(${report.numPassedTests}/${report.numTotalTests} tests passed).`,
    );
    return;
  }

  console.error('test-coverage check FAILED -- the run cannot be trusted:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    `\nDiscovered ${expected.length} test file(s); the report holds results for ${reported.length}.`,
  );
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`test-coverage check errored: ${error.message}`);
    process.exitCode = 1;
  });
}
