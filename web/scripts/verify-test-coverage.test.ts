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
  it('makes paths relative, forward-slashed, and lower-cased so both sides compare equal', () => {
    expect(normaliseFile('C:\\repo\\web\\src\\A.test.ts', 'C:\\repo\\web')).toBe('src/a.test.ts');
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
