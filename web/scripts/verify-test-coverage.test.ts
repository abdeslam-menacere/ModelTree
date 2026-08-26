import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compareCoverage,
  emptyReportedFiles,
  executionCountsByFile,
  executionTotals,
  EXECUTED_STATUSES,
  formatCoverageSummary,
  formatFailureReport,
  formatUnexercisedNote,
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

// Issue #337: the axis the cases above do not cover, and a live instance of
// why a neighbouring negative test is no evidence that they do (issue #312).
// Every case above varies *which* files are in the two sets; this one varies
// whether either set holds anything at all. Emptiness is the single state a set
// difference cannot see, because the difference of two empty sets is empty and
// reads exactly like agreement -- so the guard passed a run in which the whole
// suite had vanished, and passed it more readily the more total the loss was.
//
// The sibling cases, named so the next reader cannot mistake one of them for
// this one:
//   - 'fails loudly, naming the file, when a discovered file produced no
//     result' (#218) -- SOME discovered file is absent from the report. Always
//     caught, and re-asserted here as the control, because the defect was
//     precisely that one file gone was refused while every file gone was not.
//   - 'fails when the report shows results for a file that was not discovered'
//     -- a reported file nothing discovered. Non-empty `expected`.
//   - 'fails the comparison by name when a reported file ran zero tests'
//     (#245) -- a file is reported but holds no results. Non-empty `expected`.
//   - 'reports a quarantined file on the result and still calls the run ok'
//     (#270) -- a reported file executed nothing, and is deliberately NOT a
//     failure. Re-probed below, because an emptiness guard is likelier to
//     swallow that case than any other: discovering nothing and running
//     nothing are different states, and only the first is a defect.
// None of them can reach `expected: []`, so none of them covers this axis.
describe('a run that discovered no test files at all', () => {
  const greenReport = { success: true, numFailedTests: 0, numFailedTestSuites: 0 };

  // The discriminator. Against the pre-#337 script every assertion here dies:
  // ok was true and problems was empty, so a run whose entire suite had
  // disappeared exited 0.
  it('refuses, rather than passing vacuously, when the discovered set is empty', () => {
    const result = compareCoverage({
      expected: [],
      reported: [],
      empty: [],
      unexecuted: [],
      report: greenReport,
    });

    expect(result.ok).toBe(false);
    // Caught by the emptiness check and by nothing else: there is no missing
    // file, no unexpected file and no empty file for another branch to name.
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.empty).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });

  // Held to #307's standard: the message may state what was observed -- that
  // discovery returned nothing -- and must not settle on a cause this input
  // cannot establish. It lists the candidates as indistinguishable, which is
  // the honest form, so what is pinned here is that the hedge survives.
  it('names discovery coming back empty without asserting why it did', () => {
    const problems = compareCoverage({
      expected: [],
      reported: [],
      report: greenReport,
    }).problems.join('\n');

    expect(problems).toContain('Zero test files were discovered');
    expect(problems).toContain('does not establish why');
  });

  // Emptiness is a property of the discovered set specifically. The two
  // problems stay distinct rather than one absorbing the other.
  it('refuses on both counts when nothing was discovered but the report holds a file', () => {
    const result = compareCoverage({
      expected: [],
      reported: ['src/ghost.test.ts'],
      report: greenReport,
    });

    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual(['src/ghost.test.ts']);
    expect(result.problems).toHaveLength(2);
  });

  // No over-firing, 1 of 3: the control from the issue. The sibling that was
  // already refused must still be refused, and for its own reason -- if the new
  // problem also fired here it would mean the guard had stopped being about
  // emptiness.
  it('still refuses a single dropped file, by name and not as an emptiness problem', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/dropped.test.ts'],
      reported: ['src/a.test.ts'],
      report: greenReport,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['src/dropped.test.ts']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems.join('\n')).not.toContain('Zero test files were discovered');
  });

  // No over-firing, 2 of 3: the smallest healthy run that exists. One file is
  // not "nearly empty" -- the guard is on zero, never on few.
  it('passes a healthy run that discovered exactly one file', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts'],
      reported: ['src/a.test.ts'],
      report: greenReport,
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  // No over-firing, 3 of 3: #270's state, probed deliberately. Nothing here
  // executed either, which is what makes it the case most at risk of being
  // caught by a guard aimed at emptiness -- but a file WAS discovered, and that
  // is the whole difference. The recorded decision is report-not-refuse, and
  // this change must leave it exactly where it was.
  it('leaves a quarantined run alone: nothing executed, but something was discovered', () => {
    const result = compareCoverage({
      expected: ['src/quarantined.test.ts'],
      reported: ['src/quarantined.test.ts'],
      unexecuted: ['src/quarantined.test.ts'],
      report: greenReport,
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.unexecuted).toEqual(['src/quarantined.test.ts']);
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
  // cannot hide behind the others. Issue #307 adds jest's `disabled` to the
  // list: it is the third status its criterion 2 names, and like `pending` it is
  // neither skipped nor todo.
  it.each([
    ['it.skip', 'skipped'],
    ['it.todo', 'todo'],
    ["jest's pending", 'pending'],
    ["jest's disabled", 'disabled'],
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

  // Issue #307, criterion 3. The allow-list is the safe half of finding 2 and
  // must survive the wording fix, so it is pinned as a set rather than only
  // sampled through statuses. Widening it -- to make the old "skipped or todo"
  // sentence true, say -- would count an unrecognised status as exercised, which
  // is the exact failure mode (overstating what ran) this whole guard exists to
  // close. The wording was changed instead; this set must not be.
  it('recognises exactly passed and failed as executed, and nothing else', () => {
    expect([...EXECUTED_STATUSES].sort()).toEqual(['failed', 'passed']);
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
      reportedFileCount: 19,
      totals: { total: 400, executed: 400, notExecuted: 0 },
      unexecuted: [],
    });

    expect(summary).toBe(
      'test-coverage check: all 19 discovered test file(s) reported results and all executed ' +
        'at least one test (400 reported test(s): 400 executed, 0 not executed).',
    );
  });

  // The tally names the test that was applied, not a cause. `EXECUTED_STATUSES`
  // is an allow-list, so the not-executed bucket also holds `pending`,
  // `disabled`, and any status a future vitest adds -- none of which is skipped
  // or todo (issue #307, finding 2).
  it('states how many tests did not execute rather than folding them into the total', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      reportedFileCount: 19,
      totals: { total: 400, executed: 396, notExecuted: 4 },
      unexecuted: ['src/quarantined.test.ts'],
    });

    expect(summary).toContain('400 reported test(s): 396 executed, 4 not executed');
    expect(summary).not.toContain('skipped/todo');
  });

  // The defect in one assertion: the old line said "all reported results" and
  // stopped, which reads as a claim the files were exercised. It must not read
  // that way when one of them was not.
  it('never claims every file was exercised when one executed nothing', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      reportedFileCount: 19,
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
      reportedFileCount: 19,
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
      reportedFileCount: 19,
      totals: { total: 400, executed: 396, notExecuted: 4 },
      unexecuted: ['src/quarantined.test.ts'],
    });

    expect(summary).toContain('Reported, not refused');
    expect(summary).toContain('scripts/verify-test-coverage.mjs');
  });

  // The review gate's blocking finding on 67072a1, pinned. The summary hard-coded
  // "all reported results" in both of its branches, so it was true only because
  // of where it was called from -- and `main` had begun printing it on the
  // failure path too. A run with a dropped file therefore announced that every
  // discovered file had reported results, two lines under the verifier saying it
  // had not. The coverage clause is now derived from the reported count, so it
  // cannot overstate regardless of the call site.
  it('never claims every file reported when the reported count is short', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 20,
      reportedFileCount: 19,
      totals: { total: 400, executed: 396, notExecuted: 4 },
      unexecuted: ['src/quarantined.test.ts'],
    });

    expect(summary).not.toContain('all 20');
    expect(summary).not.toContain('all reported results');
    expect(summary).toContain('19 of 20 discovered test file(s) reported results');
  });

  it('derives the same short claim even with nothing quarantined', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 20,
      reportedFileCount: 19,
      totals: { total: 400, executed: 400, notExecuted: 0 },
      unexecuted: [],
    });

    expect(summary).not.toContain('all 20');
    expect(summary).toContain('19 of 20 discovered test file(s) reported results');
  });

  // Issue #307, finding 3 / criterion 4, and it is demonstrated by calling the
  // function directly on purpose. `main` never produces this input, because it
  // refuses before printing when `empty` is non-empty -- so the healthy claim
  // was true only because of where it was called from, which is the defect class
  // this file's own docstring warns about one level up.
  it('never claims execution when the tally in the same sentence says nothing ran', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 2,
      reportedFileCount: 2,
      totals: { total: 0, executed: 0, notExecuted: 0 },
      unexecuted: [],
    });

    expect(summary).not.toContain('all executed at least one test');
    expect(summary).toContain('no reported test executed');
    expect(summary).toContain('0 reported test(s): 0 executed, 0 not executed');
  });

  // The other half of the same fix: the guard belongs in the function, so the
  // set of present-but-empty files is taken as an argument rather than assumed
  // away because some caller happens to filter it.
  it('accounts for files that reported no results at all, instead of ignoring them', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 2,
      reportedFileCount: 2,
      totals: { total: 0, executed: 0, notExecuted: 0 },
      empty: ['src/killed.test.ts'],
      unexecuted: [],
    });

    expect(summary).not.toContain('all executed at least one test');
    expect(summary).toContain('1 of them reported no test results at all');
  });

  it('names both shortfalls when a run has an empty file and a quarantined one', () => {
    const summary = formatCoverageSummary({
      expectedFileCount: 3,
      reportedFileCount: 3,
      totals: { total: 3, executed: 2, notExecuted: 1 },
      empty: ['src/killed.test.ts'],
      unexecuted: ['src/quarantined.test.ts'],
    });

    expect(summary).not.toContain('all executed at least one test');
    expect(summary).toContain('1 of them executed no tests');
    expect(summary).toContain('1 of them reported no test results at all');
    expect(summary).toContain('src/quarantined.test.ts');
  });

  // Issue #307, criterion 2, driven through the real helpers rather than with a
  // hand-written `unexecuted` list, so what is checked is the sentence the
  // pipeline actually prints for a status the allow-list does not recognise.
  it.each(['pending', 'disabled', 'quarantined'])(
    'never calls a %s result skipped or todo, because the allow-list cannot know',
    (status) => {
      const report = {
        testResults: [
          {
            name: '/repo/web/src/only.test.ts',
            assertionResults: [{ status }, { status }],
          },
        ],
      };
      const unexecuted = unexecutedReportedFiles(report, '/repo/web') as string[];

      const summary = formatCoverageSummary({
        expectedFileCount: 1,
        reportedFileCount: 1,
        totals: executionTotals(report, '/repo/web'),
        empty: emptyReportedFiles(report, '/repo/web') as string[],
        unexecuted,
      });

      expect(unexecuted).toEqual(['src/only.test.ts']);
      expect(summary).toContain('src/only.test.ts');
      expect(summary).toContain('2 reported test(s): 0 executed, 2 not executed');
      // The whole of finding 2 in two assertions: the file is still named, and
      // the output does not attribute a cause the code never established.
      expect(summary).not.toContain('skipped');
      expect(summary).not.toContain('todo');
    },
  );
});

// What `main` prints underneath a refusal. This is the wording the review gate
// found overstating on 67072a1, and the absence of a test at exactly this level
// is why it got through: every case above asserted the *summary*, which on a
// failing run is not what should be printed at all.
describe('the failure-path note', () => {
  it('is empty when nothing was quarantined, so a clean refusal stays clean', () => {
    expect(formatUnexercisedNote({ unexecuted: [] })).toBe('');
    expect(formatUnexercisedNote({})).toBe('');
  });

  it('names the quarantined files and says why they were not refused', () => {
    const note = formatUnexercisedNote({ unexecuted: ['src/one.test.ts', 'src/two.test.ts'] });

    expect(note).toContain('NOT exercised');
    expect(note).toContain('src/one.test.ts, src/two.test.ts');
    expect(note).toContain('Reported, not refused');
  });

  // Issue #307, finding 2. The note used to read "every test in them is skipped
  // or todo", which the allow-list at `EXECUTED_STATUSES` cannot establish -- a
  // `pending`, a `disabled`, or a status a future vitest invents lands in this
  // set too. The sentence now states the test that was applied.
  it('states the test that was applied, not a cause the allow-list cannot support', () => {
    const note = formatUnexercisedNote({ unexecuted: ['src/quarantined.test.ts'] });

    expect(note).toContain("no result in them had status 'passed' or 'failed'");
    expect(note).not.toContain('skipped or todo');
    expect(note).not.toContain('every test in them');
  });

  // The blocking finding, stated as a property: the note goes out under a
  // refusal, so it must carry no run-level claim of its own. Anything asserting
  // how many files reported, or wearing the `test-coverage check:` prefix that
  // reads like the success line, is the defect returning.
  it('makes no run-level coverage claim and does not mimic the success line', () => {
    const note = formatUnexercisedNote({ unexecuted: ['src/quarantined.test.ts'] });

    expect(note).not.toContain('all reported results');
    expect(note).not.toContain('discovered test file(s)');
    expect(note).not.toContain('test-coverage check:');
  });

  // The note is a strict substring of the summary, so the two cannot drift into
  // describing the same finding differently depending on which path printed it.
  it('is the same text the summary embeds, so the two paths cannot disagree', () => {
    const unexecuted = ['src/quarantined.test.ts'];
    const summary = formatCoverageSummary({
      expectedFileCount: 19,
      reportedFileCount: 19,
      totals: { total: 400, executed: 396, notExecuted: 4 },
      unexecuted,
    });

    expect(summary).toContain(formatUnexercisedNote({ unexecuted }));
  });
});

// The refusal block as a whole. The review gate's finding was not a bad string;
// every string involved was individually correct. It was the failure path
// *choosing* to print the run summary, whose coverage clause describes a healthy
// run. That choice is only assertable if the block is composed by a pure
// function, which is why `formatFailureReport` exists.
describe('the failure report block', () => {
  const droppedFile =
    '1 discovered test file(s) produced no result and were silently omitted from the ' +
    'reported count (a dropped file / fork-worker failure): src/lib/homepage.test.ts';

  it('leads with the refusal and lists every problem it was given', () => {
    const report = formatFailureReport({
      problems: [droppedFile, 'The vitest JSON report does not record success: true.'],
      expectedFileCount: 19,
      reportedFileCount: 18,
      unexecuted: [],
    });

    expect(report).toContain('test-coverage check FAILED -- the run cannot be trusted:');
    expect(report).toContain(`  - ${droppedFile}`);
    expect(report).toContain('  - The vitest JSON report does not record success: true.');
    expect(report).toContain('Discovered 19 test file(s); the report holds results for 18.');
  });

  // The blocking finding on 67072a1, reproduced as a unit case. A dropped file
  // alongside a quarantined one printed "19 ... all reported results" two lines
  // under the verifier saying eighteen had. No coverage claim of any shape
  // belongs in a block explaining why the run cannot be trusted.
  it('never restates the run summary or its coverage claim under a refusal', () => {
    const report = formatFailureReport({
      problems: [droppedFile],
      expectedFileCount: 19,
      reportedFileCount: 18,
      unexecuted: ['src/lib/selection.test.ts'],
    });

    expect(report).not.toContain('all reported results');
    expect(report).not.toContain('discovered test file(s) reported results');
    expect(report).not.toContain('all executed at least one test');
    // The success line's prefix must not appear either: it reads as a verdict,
    // and the verdict here is the FAILED line at the top.
    expect(report).not.toContain('test-coverage check: ');
  });

  it('still surfaces the quarantined file, visibly subordinated to the refusal', () => {
    const report = formatFailureReport({
      problems: [droppedFile],
      expectedFileCount: 19,
      reportedFileCount: 18,
      unexecuted: ['src/lib/selection.test.ts'],
    });

    expect(report).toContain('Also, though it is not why this failed:');
    expect(report).toContain('NOT exercised');
    expect(report).toContain('src/lib/selection.test.ts');
    // Subordination is positional, not just a phrase: the refusal has to come
    // first or the note reads as the headline.
    expect(report.indexOf('FAILED')).toBeLessThan(report.indexOf('NOT exercised'));
  });

  // A refusal with nothing quarantined must be exactly what it was before this
  // issue: #245's message and nothing appended.
  it('adds nothing at all when no file was quarantined', () => {
    const report = formatFailureReport({
      problems: [droppedFile],
      expectedFileCount: 19,
      reportedFileCount: 18,
      unexecuted: [],
    });

    expect(report).not.toContain('Also, though it is not why this failed');
    expect(report).not.toContain('NOT exercised');
    expect(report).toBe(
      'test-coverage check FAILED -- the run cannot be trusted:\n' +
        `  - ${droppedFile}\n` +
        '\n' +
        'Discovered 19 test file(s); the report holds results for 18.',
    );
  });
});

// Issue #307, finding 4 / criterion 5. `JSON.parse` turns a file containing the
// four bytes `null` into `null`, so this is a real input, not a hypothetical.
// Every reader in the script guarded it except `reportedFilesFrom`, which meant
// one malformed-input path surfaced a raw TypeError while all its neighbours
// refused in the checker's own words. The run was refused either way -- the
// defect was the inconsistency, so what is pinned here is that they now agree.
describe('a report that is null rather than an object', () => {
  const readers = [
    ['reportedFilesFrom', () => reportedFilesFrom(null, '/repo/web')],
    ['testCountsByFile', () => testCountsByFile(null, '/repo/web')],
    ['emptyReportedFiles', () => emptyReportedFiles(null, '/repo/web')],
    ['executionCountsByFile', () => executionCountsByFile(null, '/repo/web')],
    ['executionTotals', () => executionTotals(null, '/repo/web')],
    ['unexecutedReportedFiles', () => unexecutedReportedFiles(null, '/repo/web')],
  ] as const;

  it.each(readers)('%s reads it without throwing a TypeError', (_name, read) => {
    expect(read).not.toThrow();
  });

  it('reads as a report holding nothing, exactly as its neighbours already did', () => {
    expect(reportedFilesFrom(null, '/repo/web')).toEqual([]);
    expect(emptyReportedFiles(null, '/repo/web')).toEqual([]);
    expect(unexecutedReportedFiles(null, '/repo/web')).toEqual([]);
    expect(testCountsByFile(null, '/repo/web').size).toBe(0);
    expect(executionTotals(null, '/repo/web')).toEqual({
      total: 0,
      executed: 0,
      notExecuted: 0,
    });
  });

  // Guarding it must not soften it. A report holding nothing still loses every
  // discovered file, so the run is refused -- through the checker's own message,
  // naming the files, which is the whole point of the alignment.
  it('is still fail-closed: the run refuses, and names what it lost', () => {
    const result = compareCoverage({
      expected: ['src/a.test.ts', 'src/b.test.ts'],
      reported: reportedFilesFrom(null, '/repo/web') as string[],
      empty: emptyReportedFiles(null, '/repo/web') as string[],
      unexecuted: unexecutedReportedFiles(null, '/repo/web') as string[],
      report: null as unknown as object,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(result.problems.join('\n')).toContain('produced no result');
  });
});

// Issue #307, finding 1 / criterion 1: the coverage gap that made every case
// above insufficient on its own. All of them call the exported pure functions,
// so nothing checked the code in `main` that wires them together -- the reads,
// the vitest discovery call, which value is passed to which formatter, what is
// printed, and on which stream. That wiring could be cut with the whole suite
// green: replacing the `unexecuted` computation in `main` with `[]` left every
// unit case passing while the real end-to-end output claimed a skipped-only
// file had been exercised, which is the precise claim #270 exists to prevent.
//
// So these cases spawn the script as a process against a throwaway fixture tree
// and assert on its real stdout, stderr, and exit code. The fixture lives
// outside the repository, in the OS temp directory, for a reason worth stating:
// a fixture test file placed anywhere under `web/` would be picked up by this
// project's own vitest glob and would itself become a discovered file.
describe('the script run as a process', () => {
  const scriptPath = fileURLToPath(new URL('./verify-test-coverage.mjs', import.meta.url));
  const createdDirectories: string[] = [];

  type FixtureFile = {
    name: string;
    source: string;
    // The statuses the report claims for this file, matching what vitest 4.1.10
    // emits for the source above. `null` means the report omits the file
    // entirely -- the dropped-worker shape from #218.
    statuses: string[] | null;
  };

  const passingSource = "import { it, expect } from 'vitest';\nit('runs', () => expect(1).toBe(1));\n";
  const skippedSource = "import { it } from 'vitest';\nit.skip('does not run', () => {});\n";

  async function buildFixture(
    files: FixtureFile[],
    reportPath: string,
    configSource?: string,
  ): Promise<string> {
    // realpath, because the temp directory can be reached by a symlink or a
    // short path, and the child's own `process.cwd()` reports the resolved form.
    // The report's absolute names have to normalise against that same root or
    // the comparison would fail for a reason the fixture never intended.
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'verify-test-coverage-')));
    createdDirectories.push(directory);

    const testResults = [];
    for (const file of files) {
      await writeFile(join(directory, file.name), file.source, 'utf8');
      if (file.statuses === null) {
        continue;
      }
      testResults.push({
        name: join(directory, file.name),
        status: 'passed',
        assertionResults: file.statuses.map((status, index) => ({
          title: `assertion ${index}`,
          status,
        })),
      });
    }

    // A vitest config, when the fixture needs discovery itself to be broken --
    // the #337 shape, where test files exist on disk but the include glob does
    // not reach them. `.mjs` so the config is loaded as ESM without vite
    // warning about ESM syntax in a file it treats as CommonJS.
    if (configSource !== undefined) {
      await writeFile(join(directory, 'vitest.config.mjs'), configSource, 'utf8');
    }

    const absoluteReportPath = join(directory, reportPath);
    await mkdir(dirname(absoluteReportPath), { recursive: true });
    await writeFile(
      absoluteReportPath,
      JSON.stringify({
        numTotalTests: testResults.reduce((sum, file) => sum + file.assertionResults.length, 0),
        numFailedTests: 0,
        numFailedTestSuites: 0,
        success: true,
        testResults,
      }),
      'utf8',
    );

    return directory;
  }

  async function runScriptIn(directory: string, args: string[] = []) {
    // The parent is itself a vitest worker, and its VITEST_* variables describe
    // that run. Handing them to a child that starts its own Vitest instance
    // would let the harness leak into what is under test.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );

    return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (settle, fail) => {
        const child = spawn(process.execPath, [scriptPath, ...args], { cwd: directory, env });
        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', fail);
        child.on('close', (code) => settle({ code, stdout, stderr }));
      },
    );
  }

  afterEach(async () => {
    await Promise.all(
      createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  // Also the only case that exercises the default report path, so the argument
  // fallback in `main` is not taken on trust either.
  it(
    'prints the healthy summary and exits 0, reading the default report path',
    async () => {
      const directory = await buildFixture(
        [
          { name: 'alpha.test.js', source: passingSource, statuses: ['passed'] },
          { name: 'beta.test.js', source: passingSource, statuses: ['passed'] },
        ],
        join('.vitest', 'report.json'),
      );

      const { code, stdout, stderr } = await runScriptIn(directory);

      expect(stderr).toBe('');
      expect(stdout.trim()).toBe(
        'test-coverage check: all 2 discovered test file(s) reported results and all executed ' +
          'at least one test (2 reported test(s): 2 executed, 0 not executed).',
      );
      expect(code).toBe(0);
    },
    60_000,
  );

  // The mutation-killer, and the reason this whole describe exists. Cutting the
  // `unexecuted` computation out of `main` leaves every other test in this file
  // green while this stdout silently becomes "all executed at least one test".
  it(
    'names a skipped-only file on real stdout, and still exits 0',
    async () => {
      const directory = await buildFixture(
        [
          { name: 'alpha.test.js', source: passingSource, statuses: ['passed'] },
          { name: 'quarantined.test.js', source: skippedSource, statuses: ['skipped'] },
        ],
        'report.json',
      );

      const { code, stdout, stderr } = await runScriptIn(directory, ['report.json']);

      expect(stdout).toContain('but 1 of them executed no tests');
      expect(stdout).toContain('2 reported test(s): 1 executed, 1 not executed');
      expect(stdout).toContain('NOT exercised');
      expect(stdout).toContain('quarantined.test.js');
      // The claim that must never appear for this tree, however green the run is.
      expect(stdout).not.toContain('all executed at least one test');
      expect(stderr).toBe('');
      // Reported, not refused: the recorded #270 decision, observed end to end.
      expect(code).toBe(0);
    },
    60_000,
  );

  // The #218 shape through the real wiring: a discovered file the report never
  // mentions. This is the half of `main` the healthy cases cannot reach --
  // the failure block, the stream it goes to, and the exit code.
  it(
    'refuses a dropped file on stderr with exit 1, printing no summary',
    async () => {
      const directory = await buildFixture(
        [
          { name: 'alpha.test.js', source: passingSource, statuses: ['passed'] },
          { name: 'dropped.test.js', source: passingSource, statuses: null },
        ],
        'report.json',
      );

      const { code, stdout, stderr } = await runScriptIn(directory, ['report.json']);

      expect(stderr).toContain('test-coverage check FAILED -- the run cannot be trusted:');
      expect(stderr).toContain('dropped.test.js');
      expect(stderr).toContain('Discovered 2 test file(s); the report holds results for 1.');
      // The refusal must not drag the summary's coverage claim along with it.
      expect(stderr).not.toContain('test-coverage check: ');
      expect(stdout).toBe('');
      expect(code).toBe(1);
    },
    60_000,
  );

  // Issue #337 through the real wiring, and the half of it no exported function
  // can reach: `expected` comes from vitest's own globTestSpecifications(), so
  // "discovery returned nothing" is only genuinely reproduced by pointing that
  // glob somewhere empty. Two real test files sit on disk in this fixture; the
  // config's include glob names a directory that does not exist, which is the
  // broken-glob / moved-directory shape the issue describes. The unit case
  // above hands `compareCoverage` an empty array and has to assume `main` can
  // produce one; this case makes `main` produce it.
  //
  // Against the pre-#337 script this exits 0 and prints the summary to stdout:
  // the fail-open observed end to end, not argued from the pure functions.
  it(
    'refuses a run in which discovery found nothing, instead of reporting success',
    async () => {
      const directory = await buildFixture(
        [
          { name: 'alpha.test.js', source: passingSource, statuses: null },
          { name: 'beta.test.js', source: passingSource, statuses: null },
        ],
        'report.json',
        "export default { test: { include: ['tests-moved-away/**/*.test.js'] } };\n",
      );

      const { code, stdout, stderr } = await runScriptIn(directory, ['report.json']);

      expect(stderr).toContain('test-coverage check FAILED -- the run cannot be trusted:');
      expect(stderr).toContain('Zero test files were discovered');
      expect(stderr).toContain('Discovered 0 test file(s); the report holds results for 0.');
      // The summary line, whose prose was already correct, must not be printed
      // under a refusal -- and above all must not be printed alone on stdout,
      // which is exactly what the fail-open did.
      expect(stdout).toBe('');
      expect(code).toBe(1);
    },
    60_000,
  );

  // The top-level catch, which is wiring too: an unreadable report must refuse
  // in the checker's own words rather than as an unhandled rejection.
  it(
    'refuses in its own words when the report file is not there at all',
    async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'verify-test-coverage-')));
      createdDirectories.push(directory);

      const { code, stdout, stderr } = await runScriptIn(directory, ['absent-report.json']);

      expect(stderr).toContain('test-coverage check errored:');
      expect(stderr).toContain('absent-report.json');
      expect(stderr).toContain('The test run must write it before this check runs.');
      expect(stdout).toBe('');
      expect(code).toBe(1);
    },
    60_000,
  );
});
