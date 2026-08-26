import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareCoverage,
  emptyReportedFiles,
  normaliseFile,
  reportedFilesFrom,
  testCountsByFile,
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
