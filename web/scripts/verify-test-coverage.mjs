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
// `describe.todo` is the exception to that equivalence, and it is forced by
// what vitest emits rather than chosen here: a file whose only suite is
// `describe.todo` produces no `assertionResults` entries at all (observed,
// vitest 4.1.10, alongside the statuses listed above), so it never reaches this
// branch. It lands in #245's present-but-empty set and is *refused*, where an
// `it.todo`-only file is merely named. That asymmetry is the safe direction --
// the stricter outcome for the case this file cannot tell apart from a dropped
// worker -- and it is written down here only so the next reader does not have
// to rediscover it by experiment (issue #307, finding 5).
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
//     status must never be silently counted as exercised. The output is held to
//     the same standard (issue #307, finding 2): it says a file executed no
//     tests and states the test that was applied, and it does not name skip or
//     todo as the cause, because an allow-list cannot establish one. A status
//     of `pending`, `disabled`, or anything a future vitest adds is neither
//     skipped nor todo, and describing it as either would be the printed claim
//     outrunning the code again. The fix for that wording is the wording; it is
//     never to widen this set so the old sentence becomes true.
//   - It is per-file, not per-test. A file with 40 tests where 39 are skipped
//     still executed one, so it is not named on the not-exercised line. The
//     run-wide executed/not-executed tally on the summary line is what surfaces
//     that case; there is no per-file threshold, because any threshold would be
//     a number this code asserts rather than derives.
//   - A test that runs but asserts nothing is not detected, and cannot be from
//     this input. A body that executes and reaches its end -- assertions behind
//     an `if (false)`, an `expect` never called, an async assertion never
//     awaited -- reports status `passed`, which is indistinguishable in the JSON
//     report from a test that asserted and passed. Closing that needs a coverage
//     provider, which issue #270 puts out of scope. So "executed" here means
//     "the body ran", never "the body checked something", and this guard is a
//     floor under the coverage claim rather than a proof of it.
//
// -- Issue #337: discovering nothing is itself the failure --
//
// Every check above is a comparison against the discovered set, and a set
// difference cannot see emptiness. With `expected` empty, `missing` is empty,
// `unexpected` is empty, `empty` is empty and the report still says success, so
// `compareCoverage` returned ok and the script exited 0. A run in which the
// entire suite vanished therefore passed the check that exists to catch exactly
// that disappearance -- and it passed more easily the more total the loss was:
// one dropped file was refused, all of them was not. That is a fail-open in a
// guard whose only value is that it refuses a run which looks green while the
// tests went missing.
//
// The prose was never the problem. `formatCoverageSummary` already printed
// "but no reported test executed" for this run, which is #307's fix working as
// intended. Only the exit code disagreed with it. So what is added below is a
// problem in `compareCoverage` and not a rewording anywhere: the conclusion the
// tool already printed now reaches the exit code.
//
// `expected` has exactly one source and no floor -- `globTestSpecifications()`
// in `main` -- so anything that makes vitest's own glob return nothing produces
// this state. The guard is placed on the discovered set being empty rather than
// on any cause of it, because the causes are not distinguishable from this
// input and the message must not claim otherwise (issue #307, finding 2).
//
// An `--allow-empty` opt-out was considered and deliberately not added. In
// order of weight: (1) this repository always has test files, so the flag would
// ship with no user and no run exercising its true branch -- configuration that
// does nothing and still has to be kept honest; (2) it is a switch that
// restores the precise fail-open being closed here, and once it exists the
// cheapest way past a red check is to pass it, which is how a guard that cannot
// be talked out of a refusal stops being one; (3) the asymmetry favours
// waiting, because adding the flag later for a project that genuinely has no
// tests costs one argument, while removing it after some CI file has started
// passing it costs a negotiation. Nobody is left stuck by the omission: the
// refusal says plainly that discovery returned nothing, and a project with no
// test files has no reason to run a test-coverage verifier over them.
//
// This is deliberately not the `unexecuted` case. A reported file that executed
// no tests -- a file of `.todo` tests, say -- is #270's decision, reported and
// never refused, and it is untouched here. The defect is discovering nothing,
// which is not the same thing as running nothing.
//
// -- Issue #340: the case fold merges two files into one --
//
// Every set in this file is keyed on `normaliseFile`, which lower-cases the
// whole repo-relative path. On a case-sensitive filesystem -- which is what CI
// runs on -- `src/Foo.test.ts` and `src/foo.test.ts` are two files, so the fold
// turns two discovered entries into one key and `new Set()` keeps one of them.
// If exactly one of the pair then reports results, `missing` comes back empty
// and the run passes: the dropped file is invisible to the comparison that
// exists to name it. That is the same failure class as #218 and #337 -- the
// guard reporting success because it could not see what it had lost.
//
// The docstring on `normaliseFile` used to justify the fold by drive-letter
// casing on Windows, and that reason does not survive measurement.
// `path.win32.relative` resolves a mixed-case drive letter *and* a mixed-case
// root segment on its own and leaves no colon in the result -- measured:
// `relative('c:\\repo\\web', 'C:\\repo\\web\\src\\Foo.test.ts')` is
// `src\\Foo.test.ts` -- so that case was already handled one call earlier and
// the fold was doing none of it. The docstring now states the reason that does
// survive.
//
// The fold is still not dead code, and deleting it would trade this fail-open
// for a fail-closed on the other platform. Where the filesystem is
// case-insensitive the two spellings are one file, so a path spelled one way by
// vitest's glob and the other way by the JSON report has to compare equal or a
// healthy run is refused over a file that never went missing. A single global
// choice is wrong on one platform either way, and that is the actual defect:
// fold, and a case-sensitive host cannot see a dropped file; do not fold, and a
// case-insensitive one invents a missing file that is sitting right there.
//
// So the fold stays and is made safe. `caseFoldCollisions` refuses when folding
// would merge two *distinct discovered* paths: discovery holds the real,
// unfolded paths, so the merge is detectable exactly where it would otherwise
// become silent, and a fail-open becomes a named refusal.
//
// Discovered-side only, and that asymmetry is chosen rather than overlooked.
// `expected` comes from a filesystem glob, so two entries differing by case
// alone are a fact about what discovery returned. Two *reported* entries
// differing by case are not the same fact: on a case-insensitive host they are
// one file addressed twice, and refusing there would manufacture precisely the
// false positive that keeping the fold exists to avoid. The check is placed
// where the input can support the conclusion drawn from it.
//
// It is raised before the missing/unexpected comparisons for #337's reason: it
// is the state that makes them unreliable rather than one more way for them to
// fail, and a reader who sees `missing` come back empty has to be told why that
// set could not be trusted.
//
// What this rests on, stated rather than implied. The case-insensitive half was
// verified only as far as the filesystem: both spellings were measured to reach
// one file on such a host, which is what makes a mismatched-spelling input a
// real one rather than an invented one. Whether vitest's discovery and its own
// JSON report ever *do* spell a single file differently was not reproduced --
// not here, and not in the issue. So the fold is kept as protection against a
// hazard that is real in the filesystem and unobserved in the reporter, and no
// stronger claim than that is made for it.
//
// On a case-insensitive filesystem the new refusal is unreachable by
// construction, because the glob cannot return two paths differing only in case
// when the filesystem cannot hold two such files. That is why the end-to-end
// case for this branch measures what the filesystem actually did instead of
// testing `process.platform`, and why a green run on a case-insensitive host is
// not evidence about a case-sensitive one.

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repo-relative, forward-slashed form of an absolute path, with its case
 * left exactly as the filesystem spelled it.
 *
 * This is the form discovery has to be inspected in before anything is folded
 * (issue #340): a fold cannot be checked for collisions after it has already
 * happened, because by then the two spellings are one string. `normaliseFile`
 * is defined in terms of this so the two cannot drift apart.
 */
export function repoRelativeFile(absolutePath, root) {
  return relative(root, absolutePath).replaceAll('\\', '/');
}

/**
 * Normalise an absolute path to a lower-cased, forward-slash path relative to
 * `root`, so a path from vitest's glob and a path from the JSON report compare
 * equal when the two spell the same file differently.
 *
 * The fold is about the spelling of one file and not about drive letters. This
 * docstring used to say the lower-casing made paths equal "regardless of
 * separator or drive-letter casing on Windows"; `path.win32.relative` does that
 * part by itself, for the drive letter and for a mixed-case root segment alike,
 * and leaves no colon in what it returns, so the fold was credited with work
 * that had already happened one call earlier (issue #340).
 *
 * What the fold actually does is let `src/Foo.test.ts` and `src/foo.test.ts`
 * compare equal. That is correct where the filesystem holds them as one file
 * and dangerous where it holds them as two, since it merges two discovered
 * entries into one key and hides a dropped file. `caseFoldCollisions` is what
 * makes keeping it safe; the header records the reasoning.
 */
export function normaliseFile(absolutePath, root) {
  return repoRelativeFile(absolutePath, root).toLowerCase();
}

/**
 * The groups of distinct discovered paths that the case fold would merge into a
 * single key -- the input on which every set comparison in this file stops
 * being able to tell two files apart (issue #340).
 *
 * Exact duplicates are not a collision. vitest can list one module more than
 * once, and the same path twice folds to the same key without anything having
 * been merged; only two *different* spellings mean information is about to be
 * lost. The set of spellings is what makes that distinction, so it is the set
 * and not the count of paths that decides.
 *
 * @param {string[]} paths - case-preserved relative paths, as `repoRelativeFile` returns them
 * @returns {{ key: string, paths: string[] }[]}
 */
export function caseFoldCollisions(paths) {
  const byKey = new Map();
  for (const path of paths) {
    const key = path.toLowerCase();
    const spellings = byKey.get(key) ?? new Set();
    spellings.add(path);
    byKey.set(key, spellings);
  }

  return [...byKey.entries()]
    .filter(([, spellings]) => spellings.size > 1)
    .map(([key, spellings]) => ({ key, paths: [...spellings].sort() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
 * An empty `expected` is a problem in its own right (issue #337) and not a
 * vacuous pass. Everything else here is a set difference, and a set difference
 * is blind to emptiness; the header records why that state is refused outright
 * rather than made opt-outable.
 *
 * `collisions` is the same shape of problem one level down (issue #340): the
 * comparisons below are keyed on a case fold, so two discovered paths differing
 * only in case arrive here already merged into one member of `expected`, and a
 * dropped one of the pair cannot be named. It is taken as an argument rather
 * than derived here because deriving it is impossible from this input -- by the
 * time a path reaches `expected` it has been folded, and the evidence is gone.
 *
 * @param {{ expected: string[], reported: string[], empty?: string[], unexecuted?: string[], collisions?: { key: string, paths: string[] }[], report: object }} input
 * @returns {{ ok: boolean, problems: string[], missing: string[], unexpected: string[], empty: string[], unexecuted: string[], collisions: { key: string, paths: string[] }[] }}
 */
export function compareCoverage({
  expected,
  reported,
  empty = [],
  unexecuted = [],
  collisions = [],
  report,
}) {
  const expectedSet = new Set(expected);
  const reportedSet = new Set(reported);

  const missing = [...expectedSet].filter((file) => !reportedSet.has(file)).sort();
  const unexpected = [...reportedSet].filter((file) => !expectedSet.has(file)).sort();
  const emptyReported = [...new Set(empty)].sort();
  const unexecutedReported = [...new Set(unexecuted)].sort();
  const foldCollisions = [...collisions];

  const problems = [];

  // Issue #337. Checked before the comparisons because it is the state that
  // makes them vacuous rather than one more way for them to fail: with nothing
  // discovered there is no file that could have gone missing, so the whole
  // suite disappearing looked exactly like the whole suite being covered.
  if (expectedSet.size === 0) {
    problems.push(
      'Zero test files were discovered, so the set this check measures the run against was ' +
        'empty: a missing-file comparison against an empty discovered set can never name a ' +
        'file, which is why a run whose entire suite vanished was indistinguishable, on that ' +
        'comparison, from a fully covered one. This states only that discovery returned no ' +
        'files; it does not establish why, because a broken include glob, a moved directory ' +
        'and the wrong working directory all produce this input and none of them is ' +
        'distinguishable in it.',
    );
  }

  // Issue #340, and before the comparisons for #337's reason: this is the state
  // that makes them unreliable, so a reader who sees `missing` come back empty
  // has to be told that the set it was computed from had two files merged into
  // one member.
  if (foldCollisions.length > 0) {
    const named = foldCollisions
      .map(({ key, paths }) => `${key} <- ${paths.join(' + ')}`)
      .join('; ');
    problems.push(
      `${foldCollisions.length} group(s) of discovered test files differ only in case, so the ` +
        `case fold these comparisons are keyed on merges each group into a single entry and ` +
        `cannot tell its members apart -- one of them going missing would not be named: ` +
        `${named}. This states only that discovery returned paths differing by case alone; ` +
        `whether they are separate files or one file spelled two ways is not established by ` +
        `this input, and the comparison is unreliable either way.`,
    );
  }

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
    collisions: foldCollisions,
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
 * none of them -- no result carried a status in `EXECUTED_STATUSES`. The set is
 * deliberately described by the test that produced it rather than by a cause:
 * an allow-list establishes "not recognised as executed", never "skipped or
 * todo", and a `pending` or `disabled` result lands here too. The `total > 0`
 * guard is what keeps this disjoint from #245's `empty` set: a file with no
 * results at all is that branch's failure and must not be double-reported here
 * as a quarantine.
 */
export function unexecutedReportedFiles(report, root) {
  return [...executionCountsByFile(report, root).entries()]
    .filter(([, bucket]) => bucket.total > 0 && bucket.executed === 0)
    .map(([file]) => file)
    .sort();
}

/**
 * The indented lines naming the files that were discovered and reported but
 * executed nothing, plus the one-line reason they are named and not refused.
 * Empty string when there are none.
 *
 * Split out from the summary so the failure path can print this finding without
 * dragging the summary's coverage claim along with it. That coupling is exactly
 * what produced the overstatement this function exists to prevent: the summary
 * was printed whole on a failing run, so a run with a dropped file still
 * announced that every discovered file had reported results.
 *
 * The sentence names the test that was applied, not a cause. It used to read
 * "every test in them is skipped or todo", which the mechanism above cannot
 * establish: `EXECUTED_STATUSES` is an allow-list, so `pending`, `disabled`, or
 * any status a future vitest adds also arrives here and is neither skipped nor
 * todo (issue #307, finding 2).
 *
 * @param {{ unexecuted?: string[] }} input
 * @returns {string}
 */
export function formatUnexercisedNote({ unexecuted = [] }) {
  if (unexecuted.length === 0) {
    return '';
  }

  return (
    `  Discovered and reported, but NOT exercised -- no result in them had status ` +
    `'passed' or 'failed': ${unexecuted.join(', ')}\n` +
    `  Reported, not refused: a deliberately quarantined suite is a legitimate state. See the ` +
    `known-limits note in scripts/verify-test-coverage.mjs.`
  );
}

/**
 * Build the run summary. Kept pure and exported so the exact wording is under
 * test: the acceptance criterion of issue #270 is about what this string
 * claims, so the string is the thing that has to be asserted on.
 *
 * Every claim here is derived from an argument, never hard-coded. The earlier
 * version wrote "all reported results" as a literal in both branches, which was
 * true only because of where it happened to be called from -- and stopped being
 * true the moment it was also called on the failure path. A claim that depends
 * on its call site is the same defect class #270 is about, one level up.
 *
 * The healthy branch used to be one instance of that trap left standing (issue
 * #307, finding 3). It gated "all executed at least one test" on
 * `unexecuted.length === 0` alone, which is only sufficient because `main` also
 * holds back the summary when `empty` is non-empty. Called with `unexecuted: []`
 * and zero totals it produced "all executed at least one test (0 reported
 * test(s): 0 executed" -- a sentence contradicting its own tally. So every
 * reason that claim can be false is now read off an argument: `empty` is taken
 * as a parameter rather than assumed absent, and `totals.executed` has to be
 * non-zero for the claim to be made at all. The guard is here, not at the call
 * site.
 *
 * @param {{ expectedFileCount: number, reportedFileCount: number, totals: { total: number, executed: number, notExecuted: number }, empty?: string[], unexecuted?: string[] }} input
 * @returns {string}
 */
export function formatCoverageSummary({
  expectedFileCount,
  reportedFileCount,
  totals,
  empty = [],
  unexecuted = [],
}) {
  const coverage =
    reportedFileCount === expectedFileCount
      ? `all ${expectedFileCount} discovered test file(s) reported results`
      : `${reportedFileCount} of ${expectedFileCount} discovered test file(s) reported results`;

  // "not executed" and not "skipped/todo": the split is made by an allow-list,
  // which cannot tell those two apart from a `pending` or an unknown status.
  const tally =
    `${totals.total} reported test(s): ${totals.executed} executed, ` +
    `${totals.notExecuted} not executed`;

  const shortfalls = [];
  if (unexecuted.length > 0) {
    shortfalls.push(`${unexecuted.length} of them executed no tests`);
  }
  if (empty.length > 0) {
    shortfalls.push(`${empty.length} of them reported no test results at all`);
  }
  // Nothing was named, yet nothing ran either -- an inconsistent or empty input
  // rather than a healthy run. Say so instead of claiming execution the tally
  // contradicts one clause later.
  if (shortfalls.length === 0 && totals.executed === 0) {
    shortfalls.push('no reported test executed');
  }

  if (shortfalls.length === 0) {
    return `test-coverage check: ${coverage} and all executed at least one test (${tally}).`;
  }

  const line = `test-coverage check: ${coverage}, but ${shortfalls.join(', and ')} (${tally}).`;
  const note = formatUnexercisedNote({ unexecuted });

  return note.length > 0 ? `${line}\n${note}` : line;
}

/**
 * Build the whole refusal block, so what a failing run prints is a pure value
 * and not a sequence of `console.error` calls only a subprocess could observe.
 *
 * This exists because of the review-gate finding on 67072a1: the defect was not
 * in any one string, it was in *which* string the failure path chose to print --
 * it reached for the run summary, whose coverage claim describes a healthy run.
 * A wording test on the individual pieces could not have caught that, because
 * every piece was individually fine. Composing here makes the choice itself
 * assertable.
 *
 * @param {{ problems: string[], expectedFileCount: number, reportedFileCount: number, unexecuted?: string[] }} input
 * @returns {string}
 */
export function formatFailureReport({
  problems,
  expectedFileCount,
  reportedFileCount,
  unexecuted = [],
}) {
  const lines = ['test-coverage check FAILED -- the run cannot be trusted:'];

  for (const problem of problems) {
    lines.push(`  - ${problem}`);
  }

  lines.push(
    '',
    `Discovered ${expectedFileCount} test file(s); the report holds results for ${reportedFileCount}.`,
  );

  // The not-exercised finding is informational, so it survives a refusal rather
  // than being swallowed by an unrelated one -- but only the finding itself, and
  // visibly subordinated. The run summary is deliberately not reprinted here.
  const note = formatUnexercisedNote({ unexecuted });
  if (note.length > 0) {
    lines.push('', 'Also, though it is not why this failed:', note);
  }

  return lines.join('\n');
}

/**
 * Pull the set of files the report actually holds results for.
 *
 * The `report &&` guard matches every other reader in this file (issue #307,
 * finding 4). Without it a report of literal `null` -- which `JSON.parse` will
 * happily produce from a well-formed file -- surfaced a raw TypeError instead
 * of the checker's own refusal. The run was refused either way; what was wrong
 * was that one malformed-input path refused differently from all the others.
 */
export function reportedFilesFrom(report, root) {
  const results = Array.isArray(report && report.testResults) ? report.testResults : [];
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
  let collisions;
  let discoveredFileCount;
  try {
    const specifications = await vitest.globTestSpecifications();
    // Case-preserved first, folded second. Issue #340: the collision has to be
    // read off the paths the filesystem actually gave, because folding is what
    // destroys the evidence of it.
    const discovered = specifications.map((spec) => repoRelativeFile(spec.moduleId, root));
    collisions = caseFoldCollisions(discovered);
    // Counted before the fold, because "Discovered N test file(s)" is a claim
    // about discovery and not about how many comparison keys survived it. The
    // two numbers differ only when a collision merged something, and printing
    // the folded one there would have the refusal understate the very loss it
    // is refusing over -- naming two paths on one line and calling them one
    // file on the next.
    discoveredFileCount = new Set(discovered).size;
    // `normaliseFile` and not `discovered.map(toLowerCase)`: the reported side
    // is keyed by `normaliseFile`, so writing the fold out a second time here
    // would let the two sides of the comparison drift apart under any change to
    // it -- the halves would still each be internally consistent, and the
    // comparison between them would quietly stop meaning anything.
    expected = [...new Set(specifications.map((spec) => normaliseFile(spec.moduleId, root)))];
  } finally {
    await vitest.close();
  }

  const reported = [...new Set(reportedFilesFrom(report, root))];
  const empty = emptyReportedFiles(report, root);
  const unexecuted = unexecutedReportedFiles(report, root);
  const totals = executionTotals(report, root);
  const { ok, problems } = compareCoverage({
    expected,
    reported,
    empty,
    unexecuted,
    collisions,
    report,
  });

  const summary = formatCoverageSummary({
    expectedFileCount: discoveredFileCount,
    reportedFileCount: reported.length,
    totals,
    empty,
    unexecuted,
  });

  if (ok) {
    console.log(summary);
    return;
  }

  console.error(
    formatFailureReport({
      problems,
      expectedFileCount: discoveredFileCount,
      reportedFileCount: reported.length,
      unexecuted,
    }),
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
