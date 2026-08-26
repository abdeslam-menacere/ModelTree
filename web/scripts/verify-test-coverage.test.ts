import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareCoverage,
  normaliseFile,
  reportedFilesFrom,
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
