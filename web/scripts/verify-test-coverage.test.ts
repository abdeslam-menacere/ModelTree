import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareCoverage,
  emptyReportedFiles,
  executionCountsByFile,
  executionTotals,
  formatCoverageSummary,
  normaliseFile,
  reportedFilesFrom,
  testCountsByFile,
  unexecutedReportedFiles,
} from './verify-test-coverage.mjs';

// A minimal, healthy report: two files, both reporting results, all green.
function healthyReport() {
  return {
    numTotalTests: 5,
    numPassedTests: 5,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    success: true,
    testResults: [
      { name: '/repo/web/src/a.test.ts', status: 'passed' },
      { name: '/repo/web/src/b.test.ts', status: 'passed' },
    ],
  };
}

describe('normaliseFile', () => {
  // Build the absolute paths with the platform's own resolver so the case
  // asserts the property -- repo-relative, forward-slashed, lower-cased -- on
  // whatever platform CI runs. The earlier version hard-coded a Windows drive
  // path (`C:\repo\web`); on Linux that string is not absolute, so path.relative
  // walked up out of the root and produced `../c:/repo/web/...`. Deriving the
  // inputs from resolve()/join() means the base is always truly absolute and the
  // separators are always the platform's own, which is exactly what the
  // production code sees from the real filesystem.
  it('makes a path repo-relative, forward-slashed, and lower-cased', () => {
    const root = resolve('repo', 'web');
    const file = join(root, 'src', 'A.test.ts');

    const normalised = normaliseFile(file, root);

    expect(normalised).toBe('src/a.test.ts');
    // On Windows join() produced backslashes; the output must never carry one,
    // or a report path and a glob path would fail to match.
    expect(normalised).not.toContain('\\');
  });

  it('collapses a deeper native path to a lower-cased forward-slashed key', () => {
    const root = resolve('repo', 'web');
    const file = join(root, 'components', 'Deep', 'Nested.test.tsx');

    expect(normaliseFile(file, root)).toBe('components/deep/nested.test.tsx');
  });

  // POSIX-style absolute inputs are exercised directly, so the intended output
  // shape is pinned literally and not only via the platform-built paths above.
  // This is safe on both platforms: path.resolve treats a leading-slash path as
  // absolute on Linux and as rooted on the current drive on Windows, and both
  // the base and the file get the same treatment, so the relative result is the
  // same string either way.
  it('normalises a POSIX-style absolute path the same way', () => {
    expect(normaliseFile('/repo/web/src/a.test.ts', '/repo/web')).toBe('src/a.test.ts');
  });
});

describe('reportedFilesFrom', () => {
  it('extracts the normalised file set the report holds results for', () => {
    expect(reportedFilesFrom(healthyReport(), '/repo/web')).toEqual([
      'src/a.test.ts',
      'src/b.test.ts',
    ]);
  });

  it('tolerates a report with no testResults array', () => {
    expect(reportedFilesFrom({}, '/repo/web')).toEqual([]);
  });
});

describe('compareCoverage', () => {
  it('passes when every discovered file reported results and the run was green', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/b.test.ts'],
      reported: ['src/a.test.ts', 'src/b.test.ts'],
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 0 },
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  // This is the exact issue #218 shape: vitest discovered a file it never ran,
  // so the file is absent from the report while the report still looks green.
  it('fails loudly, naming the file, when a discovered file produced no result', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/dropped.test.ts'],
      reported: ['src/a.test.ts'],
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['src/dropped.test.ts']);
    expect(result.problems.join('\n')).toContain('src/dropped.test.ts');
  });

  it('fails when the report shows results for a file that was not discovered', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts'],
      reported: ['src/a.test.ts', 'src/ghost.test.ts'],
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual(['src/ghost.test.ts']);
  });

  it('fails when the report itself does not record success', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      report: { success: false, numFailedTests: 0, numFailedTestSuites: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('success: true');
  });

  it('fails when the report records failed tests, even with the full file set', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      report: { success: true, numFailedTests: 2, numFailedTestSuites: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('2 failed test(s)');
  });

  it('fails when the report records a failed test suite', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 1 },
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('1 failed test suite(s)');
  });
});

// Issue #245: a file can be *present* in the report yet hold zero test results.
// That hides exactly as much as an absent file -- nothing ran -- but the
// set-membership check is blind to it, because the file does have a name and so
// is counted as "reported", never "missing". The decision recorded in the
// script is that this is an error with no exemption: the report cannot tell a
// killed/dropped worker apart from a file that genuinely had no it()/test(),
// both surface identically, and exempting the latter would reopen the hole.
describe('present-but-empty test files', () => {
  // One healthy file with three tests and one file that ran nothing: present in
  // testResults, but with an empty assertionResults array.
  function reportWithAnEmptyFile() {
    return {
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      success: true,
      testResults: [
        {
          name: '/repo/web/src/a.test.ts',
          status: 'passed',
          assertionResults: [
            { title: 'one', status: 'passed' },
            { title: 'two', status: 'passed' },
            { title: 'three', status: 'passed' },
          ],
        },
        { name: '/repo/web/src/empty.test.ts', status: 'passed', assertionResults: [] },
      ],
    };
  }

  it('lists the empty file among reported files, so membership alone cannot catch it', () => {
    // This is the crux: the empty file IS reported, so `missing` will be empty
    // and the pre-#245 check has nothing to complain about.
    expect(reportedFilesFrom(reportWithAnEmptyFile(), '/repo/web')).toEqual([
      'src/a.test.ts',
      'src/empty.test.ts',
    ]);
  });

  it('counts each file its true number of tests, zero for the empty one', () => {
    const counts = testCountsByFile(reportWithAnEmptyFile(), '/repo/web');

    expect(counts.get('src/a.test.ts')).toBe(3);
    expect(counts.get('src/empty.test.ts')).toBe(0);
  });

  it('sums assertion counts when a file appears more than once', () => {
    const report = {
      testResults: [
        { name: '/repo/web/src/a.test.ts', assertionResults: [{ status: 'passed' }] },
        { name: '/repo/web/src/a.test.ts', assertionResults: [{ status: 'passed' }] },
      ],
    };

    expect(testCountsByFile(report, '/repo/web').get('src/a.test.ts')).toBe(2);
  });

  it('flags only the empty file, by its normalised name', () => {
    expect(emptyReportedFiles(reportWithAnEmptyFile(), '/repo/web')).toEqual([
      'src/empty.test.ts',
    ]);
  });

  it('flags no files when every reported file holds at least one test', () => {
    const report = {
      testResults: [
        { name: '/repo/web/src/a.test.ts', assertionResults: [{ status: 'passed' }] },
        { name: '/repo/web/src/b.test.ts', assertionResults: [{ status: 'passed' }] },
      ],
    };

    expect(emptyReportedFiles(report, '/repo/web')).toEqual([]);
  });

  // The behavioural discriminator. Driving compareCoverage exactly as main()
  // does for a report holding a present-but-empty file: `missing` and
  // `unexpected` are both empty and the run is green, so main's compareCoverage
  // -- which has no `empty` parameter -- returns ok: true. Every assertion below
  // dies against that version, and does so by name.
  it('fails the comparison by name when a reported file ran zero tests', () => {
    const report = reportWithAnEmptyFile();
    const reported = [...new Set(reportedFilesFrom(report, '/repo/web'))] as string[];
    const empty = emptyReportedFiles(report, '/repo/web') as string[];

    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/empty.test.ts'],
      reported,
      empty,
      report,
    });

    expect(result.ok).toBe(false);
    // Caught by the new check, not the old one: nothing is missing or unexpected.
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.empty).toEqual(['src/empty.test.ts']);
    expect(result.problems.join('\n')).toContain('src/empty.test.ts');
    expect(result.problems.join('\n')).toContain('zero test results');
  });

  // The guard must not become a false-positive machine, nor be quietly weakened:
  // a full, green report with every file populated must still pass.
  it('still passes when no file is empty and the run is green', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/b.test.ts'],
      reported: ['src/a.test.ts', 'src/b.test.ts'],
      empty: [],
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 0 },
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });
});

// Issue #270: the state next door to #245's. A file whose every test is
// `it.skip`, `describe.skip`, or `it.todo` DOES emit an assertionResults entry
// per test, so its length is >= 1 and #245's count check is satisfied. Nothing
// downstream said the file had stopped being exercised, and the summary line
// said "all reported results", which is true but reads as "all exercised".
//
// The decision recorded in the script is to report, not refuse: a quarantined
// suite is a legitimate state and failing on it would delete the quarantine
// mechanism. So what these cases pin is (a) that the two states are told apart
// at all, and (b) that telling them apart does not turn into a refusal.
//
// The status strings below are not invented. They were observed from vitest
// 4.1.10's own JSON reporter on a file containing one passing test, one
// `it.skip`, one `it.todo`, and a `describe.skip` wrapping one test:
//   passed -> 'passed', it.skip -> 'skipped', it.todo -> 'todo',
//   describe.skip -> one 'skipped' entry per child test.
describe('skipped-only test files', () => {
  // One healthy file, and one quarantined file whose four results cover all
  // three ways a test can fail to run.
  function reportWithAQuarantinedFile() {
    return {
      numTotalTests: 6,
      numPassedTests: 2,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      success: true,
      testResults: [
        {
          name: '/repo/web/src/a.test.ts',
          status: 'passed',
          assertionResults: [
            { title: 'one', status: 'passed' },
            { title: 'two', status: 'passed' },
          ],
        },
        {
          name: '/repo/web/src/quarantined.test.ts',
          status: 'passed',
          assertionResults: [
            { title: 'an it.skip', status: 'skipped' },
            { title: 'an it.todo', status: 'todo' },
            { title: 'a describe.skip child', status: 'skipped' },
            { title: 'another describe.skip child', status: 'skipped' },
          ],
        },
      ],
    };
  }

  // The crux, and why neither earlier branch can see this. The quarantined file
  // is present in the report, so `missing` cannot hold it; and it has four
  // results, so #245's zero-length check cannot hold it either.
  it('is invisible to both earlier branches: reported, and with a non-zero test count', () => {
    const report = reportWithAQuarantinedFile();

    expect(reportedFilesFrom(report, '/repo/web')).toEqual([
      'src/a.test.ts',
      'src/quarantined.test.ts',
    ]);
    expect(testCountsByFile(report, '/repo/web').get('src/quarantined.test.ts')).toBe(4);
    expect(emptyReportedFiles(report, '/repo/web')).toEqual([]);
  });

  it('splits each file into the tests that ran and the tests that only existed', () => {
    const counts = executionCountsByFile(reportWithAQuarantinedFile(), '/repo/web');

    expect(counts.get('src/a.test.ts')).toEqual({ total: 2, executed: 2, notExecuted: 0 });
    expect(counts.get('src/quarantined.test.ts')).toEqual({
      total: 4,
      executed: 0,
      notExecuted: 4,
    });
  });

  // Acceptance criterion: it.todo and describe.skip are handled the same way as
  // it.skip. Each is checked on its own so a regression naming only one of them
  // cannot hide behind the others.
  it.each([
    ['it.skip', 'skipped'],
    ['it.todo', 'todo'],
    ["jest's pending", 'pending'],
    ['a status no vitest version has emitted yet', 'not-a-real-status'],
  ])('treats %s as not executed', (_label, status) => {
    const report = {
      testResults: [{ name: '/repo/web/src/only.test.ts', assertionResults: [{ status }] }],
    };

    expect(executionCountsByFile(report, '/repo/web').get('src/only.test.ts')).toEqual({
      total: 1,
      executed: 0,
      notExecuted: 1,
    });
    expect(unexecutedReportedFiles(report, '/repo/web')).toEqual(['src/only.test.ts']);
  });

  it('counts a failed test as executed, because its body did run', () => {
    const report = {
      testResults: [
        { name: '/repo/web/src/only.test.ts', assertionResults: [{ status: 'failed' }] },
      ],
    };

    expect(executionCountsByFile(report, '/repo/web').get('src/only.test.ts')).toEqual({
      total: 1,
      executed: 1,
      notExecuted: 0,
    });
    expect(unexecutedReportedFiles(report, '/repo/web')).toEqual([]);
  });

  it('names only the file that executed nothing', () => {
    expect(unexecutedReportedFiles(reportWithAQuarantinedFile(), '/repo/web')).toEqual([
      'src/quarantined.test.ts',
    ]);
  });

  it('names no file when every file executed at least one test', () => {
    const report = {
      testResults: [
        {
          name: '/repo/web/src/mostly-skipped.test.ts',
          assertionResults: [{ status: 'skipped' }, { status: 'passed' }],
        },
      ],
    };

    expect(unexecutedReportedFiles(report, '/repo/web')).toEqual([]);
  });

  // The two sets must stay disjoint. A file with zero results is #245's failure
  // and must not be relabelled as a quarantine, which would soften a refusal
  // into a note -- the one regression this change must not cause.
  it('leaves a zero-result file to the empty branch rather than claiming it', () => {
    const report = {
      testResults: [
        { name: '/repo/web/src/killed.test.ts', assertionResults: [] },
        { name: '/repo/web/src/quarantined.test.ts', assertionResults: [{ status: 'skipped' }] },
      ],
    };

    expect(emptyReportedFiles(report, '/repo/web')).toEqual(['src/killed.test.ts']);
    expect(unexecutedReportedFiles(report, '/repo/web')).toEqual(['src/quarantined.test.ts']);
  });

  it('sums run-wide totals so the summary can say how much actually ran', () => {
    expect(executionTotals(reportWithAQuarantinedFile(), '/repo/web')).toEqual({
      total: 6,
      executed: 2,
      notExecuted: 4,
    });
  });

  // The behavioural discriminator for the decision itself. It touches only
  // `compareCoverage`, which existed before this change, so against the pre-#270
  // version it fails on an assertion -- `result.unexecuted` is `undefined` --
  // rather than on a missing symbol at import time.
  it('reports a quarantined file on the result and still calls the run ok', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/quarantined.test.ts'],
      reported: ['src/a.test.ts', 'src/quarantined.test.ts'],
      empty: [],
      unexecuted: ['src/quarantined.test.ts'],
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 0 },
    });

    expect(result.unexecuted).toEqual(['src/quarantined.test.ts']);
    // The recorded decision, in one assertion: reported, never refused.
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  // The same decision reached through main()'s exact pipeline, so the helpers
  // and the comparison are shown to agree end to end and not just in isolation.
  it('carries the quarantined file onto the result without failing the run', () => {
    const report = reportWithAQuarantinedFile();
    const reported = [...new Set(reportedFilesFrom(report, '/repo/web'))] as string[];
    const empty = emptyReportedFiles(report, '/repo/web') as string[];
    const unexecuted = unexecutedReportedFiles(report, '/repo/web') as string[];

    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/quarantined.test.ts'],
      reported,
      empty,
      unexecuted,
      report,
    });

    expect(result.unexecuted).toEqual(['src/quarantined.test.ts']);
    // The recorded decision: reported, never refused.
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    // And it got there without any earlier branch noticing.
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.empty).toEqual([]);
  });

  it('does not let a quarantined file mask a real refusal in the same run', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/dropped.test.ts', 'src/quarantined.test.ts'],
      reported: ['src/a.test.ts', 'src/quarantined.test.ts'],
      unexecuted: ['src/quarantined.test.ts'],
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['src/dropped.test.ts']);
    expect(result.unexecuted).toEqual(['src/quarantined.test.ts']);
  });
});

// The acceptance criterion of #270 is about what the verifier's output *claims*,
// so the output string is the thing under test. `formatCoverageSummary` exists
// to make that assertable without spawning the script.
describe('the coverage summary wording', () => {
  it('claims execution, not just reporting, when every file ran something', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      totals: { total: 400, executed: 400, notExecuted: 0 },
      unexecuted: [],
    });

    expect(summary).toBe(
      'test-coverage check: 19 discovered test file(s) all reported results and all executed ' +
        'at least one test (400 reported test(s): 400 executed, 0 skipped/todo).',
    );
  });

  it('states how many tests were skipped rather than folding them into the total', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      totals: { total: 400, executed: 396, notExecuted: 4 },
      unexecuted: ['src/quarantined.test.ts'],
    });

    expect(summary).toContain('400 reported test(s): 396 executed, 4 skipped/todo');
  });

  // The defect in one assertion: the old line said "all reported results" and
  // stopped, which reads as a claim the files were exercised. It must not read
  // that way when one of them was not.
  it('never claims every file was exercised when one executed nothing', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      totals: { total: 400, executed: 396, notExecuted: 4 },
      unexecuted: ['src/quarantined.test.ts'],
    });

    expect(summary).not.toContain('all executed at least one test');
    expect(summary).toContain('1 of them executed no tests');
    expect(summary).toContain('NOT exercised');
    expect(summary).toContain('src/quarantined.test.ts');
  });

  it('names every unexercised file, not just a count of them', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      totals: { total: 400, executed: 390, notExecuted: 10 },
      unexecuted: ['src/one.test.ts', 'src/two.test.ts'],
    });

    expect(summary).toContain('2 of them executed no tests');
    expect(summary).toContain('src/one.test.ts, src/two.test.ts');
  });

  // Reporting rather than refusing is only defensible if the reader is told that
  // is what happened, so the reason is in the output and not only in the source.
  it('says the finding was reported rather than refused, and where the reasoning lives', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      totals: { total: 400, executed: 396, notExecuted: 4 },
      unexecuted: ['src/quarantined.test.ts'],
    });

    expect(summary).toContain('Reported, not refused');
    expect(summary).toContain('scripts/verify-test-coverage.mjs');
  });
});
