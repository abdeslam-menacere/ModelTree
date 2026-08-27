#!/usr/bin/env node
// Self-tests for the deterministic gates. Run with:
//   node --test .github/skills/modeltree-gates/scripts/
//
// The point of these is narrow and specific: a gate that has only ever been
// seen to pass is indistinguishable from a gate that cannot fail. Every rule
// below is proved to fire by breaking the data in exactly the way it exists to
// catch, and the live repository dataset is asserted to pass, so the suite
// fails both when a gate goes blind and when a gate goes paranoid.
//
// No dependencies. Node's built-in runner only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DATA = join(REPO, 'web', 'src', 'data');
const GATE_DATASET = join(HERE, 'gate-dataset.mjs');
const GATE_EVIDENCE = join(HERE, 'gate-evidence.mjs');
const GATE_SCOPE = join(HERE, 'gate-scope.mjs');
const GATE_SOURCE_APPROVAL = join(HERE, 'gate-source-approval.mjs');

// ---------------------------------------------------------------------------
// Two clocks, and which tests may use which (#318)
//
// A gate that reads dates has to be told what "today" is, and the honest answer
// differs between a fixture and the live dataset. Both kinds live in this file,
// so the rule is written here rather than left to be inferred per test.
//
// PINNED (`TODAY`) -- every fixture test, meaning everything from the
// `gate-evidence` block down. A fixture's dates are literals written next to the
// assertion, so anchoring them to a fixed day is what makes a suite that passes
// today still pass in a year. Real "today" is never used there: those tests
// would then drift.
//
// REAL (no `--today` at all) -- the `gate-dataset` block, which gates the *live*
// repository dataset, directly or through a mutated copy. Its dates are claims
// about the real world, and "no record is dated after today" is a claim only the
// real clock can settle. Omitting the flag lets `gate-dataset.mjs` use its own
// clock, which is also the code path `node gate-dataset.mjs` takes in CI, so
// there is no second clock here that could disagree with the gate's.
//
// Pinning a day for the live data is exactly what turned main red in #318: the
// 2026-08-26 refresh landed, a frozen 2026-08-25 read it as the future, and
// every data refresh thereafter would have needed a correlated edit to this
// file. Do not re-merge the two clocks.
//
// Rejected alternative: derive the live clock from the data, e.g. the maximum
// `verifiedAt` present. It cannot drift, which is the appeal, but it is
// self-fulfilling -- the maximum date present is by construction never after
// itself, so the future-date rule could no longer fail on the live data at all.
// That rule catches a real thing (a refresh writing tomorrow's date, a machine
// with a skewed clock), so deriving the clock would have bought a green suite by
// giving up a live check.
//
// The cost accepted instead is that the live-dataset tests' verdict depends on
// the wall clock. That is the correct dependency rather than drift: drift is
// when an assertion's *meaning* changes as the clock moves, and here the meaning
// is fixed while only its referent moves -- which is the rule itself.
//
// A test that simulates some *other* day passes it explicitly via
// `gateDatasetAt`, so a supplied clock in this file always means "a day being
// simulated on purpose", never "today".
// ---------------------------------------------------------------------------

/** The pinned clock. Fixtures only -- never aim this at the live dataset. */
const TODAY = '2026-08-25';

/** The real clock, in the same UTC form `gate-dataset.mjs` computes for itself. */
function realToday() {
  return new Date().toISOString().slice(0, 10);
}

/** `days` after `date` (negative for before), as YYYY-MM-DD. */
function shiftDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function run(script, args) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    return { code: error.status, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * A scratch copy of the real dataset, mutated by `edit`, then gated on the real
 * clock. The copy is still the live data, so its dates are still claims about
 * the real world; see the clock note above. Use `gateDatasetAt` when a test
 * means to simulate a particular day.
 */
function gateMutatedDataset(edit) {
  return gateDatasetCopy(edit, []);
}

/**
 * As `gateMutatedDataset`, but judged on a stated day. Only for tests that
 * simulate a specific date on purpose -- never as a stand-in for "today".
 */
function gateDatasetAt(today, edit) {
  return gateDatasetCopy(edit, ['--today', today]);
}

function gateDatasetCopy(edit, clockArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
  try {
    cpSync(DATA, dir, { recursive: true });
    const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const write = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
    edit({ read, write });
    return run(GATE_DATASET, ['--data', dir, ...clockArgs, '--json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every document `gate-dataset.mjs` loads, exactly as its own `DOCUMENTS` map
 * names them. This *is* a second hand-written copy of a list that file owns, and
 * saying so is the point: `gate-dataset.mjs:23` states its own coupling to
 * `web/src/data/raw.ts` rather than denying it, and this comment used to claim
 * the opposite about itself. What the constant buys is de-duplication between
 * the two tests below that need the whole set; that does not stop it being a
 * copy.
 *
 * The copy drifts in two directions and only one of them used to be audible. If
 * the gate gains a document this list does not name, `a wholesale-empty dataset
 * is refused` fails loudly -- it empties only the documents this list names, the
 * gate still finds records in the one it does not, and the expected `non-empty`
 * failure never arrives. But `a dataset refreshed on a later day still passes`
 * would re-verify only the documents it knows, leave the new one's dates in the
 * past where they are comfortably below the simulated day, and stay green while
 * covering less: the 400-day forward guard narrowing without a sound. `the
 * document list still matches the one gate-dataset.mjs owns` below is what makes
 * that half audible.
 */
const DATASET_DOCUMENTS = [
  'sources.json', 'publishers.json', 'organizations.json', 'families.json',
  'releases.json', 'usage-observations.json', 'usage-syntheses.json',
  'model-fit-statements.json', 'model-fit-evidence-gaps.json',
];

/**
 * `entry` as a refresh dated `day` would leave it: the fields a refresh rewrites
 * move to that day, and nothing else does. Three fields move, not two --
 * `verifiedAt` and `lastCheckedDate` at the top level, and the *nested*
 * `control.verifiedAt`. A second nested date-bearing structure would have to be
 * handled here too, or the dataset this returns would only look refreshed.
 * `releaseDate` and `publishedDate` are facts about the past, so moving them
 * would test a dataset no refresh produces.
 */
function reverified(entry, day) {
  const moved = { ...entry };
  for (const field of ['verifiedAt', 'lastCheckedDate']) {
    if (moved[field] !== undefined) moved[field] = day;
  }
  if (moved.control && moved.control.verifiedAt !== undefined) {
    moved.control = { ...moved.control, verifiedAt: day };
  }
  return moved;
}

/**
 * Asserts the gate failed, that it failed for the stated reason rather than any
 * reason, and -- the upper bound -- that no gate this test did not name failed
 * alongside it (#369).
 *
 * Without that upper bound every assertion here is existential: `report.failures`
 * is filtered down to `gate` and everything outside the filter is discarded
 * unexamined, so a report carrying the expected failure *plus* two unexpected
 * ones satisfies the helper exactly as well as a clean one. The test then proves
 * something weaker than its name advertises -- "this mutation causes at least
 * this failure, among an unknown number of others" rather than "this mutation
 * causes this failure".
 *
 * The harm is realised, not theoretical. During #318 the harness pinned a clock
 * the live dataset had moved past, so every test routing through
 * `gateMutatedDataset` gated genuinely-future-dated data and carried a spurious
 * `dates` failure beside the failure it was proving -- and stayed green. The
 * outage surfaced only through the tests that assert `code === 0`, which is why
 * it presented as a couple of failures rather than as the twenty-odd it was.
 *
 * A test that legitimately provokes more than one gate declares the others in
 * `alsoFails`, and a declaration is checked in **both** directions: an
 * undeclared gate that fires fails, and a declared gate that does *not* fire
 * fails too. That second half is what stops `alsoFails` decaying into the
 * wildcard this helper exists to remove -- a declaration whose cause has gone is
 * deleted rather than left standing as permanent permission to fail.
 */
function assertFailed(result, gate, fragment, { alsoFails = [] } = {}) {
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false);
  const matching = report.failures.filter((failure) => failure.gate === gate);
  assert.ok(
    matching.length > 0,
    `expected a "${gate}" failure, got: ${report.failures.map((f) => f.gate).join(', ') || '(none)'}`,
  );
  if (fragment) {
    assert.ok(
      matching.some((failure) => failure.message.includes(fragment)),
      `expected a "${gate}" failure mentioning "${fragment}", got:\n${matching.map((f) => f.message).join('\n')}`,
    );
  }

  const fired = new Set(report.failures.map((failure) => failure.gate));
  const stale = alsoFails.filter((extra) => !fired.has(extra));
  assert.deepEqual(
    stale,
    [],
    `alsoFails declares ${stale.join(', ')}, but nothing failed under that name. `
      + `Gates that did fail: ${[...fired].join(', ') || '(none)'}. `
      + 'A declaration whose cause has gone is deleted, not left standing.',
  );

  const declared = new Set([gate, ...alsoFails]);
  const undeclared = report.failures.filter((failure) => !declared.has(failure.gate));
  assert.deepEqual(
    undeclared.map((failure) => failure.gate),
    [],
    `the run also failed ${undeclared.length} gate failure(s) this test never declared, so its "${gate}" `
      + 'result is not attributable to its own mutation:\n'
      + undeclared.map((failure) => `  ${failure.gate}: ${failure.message}`).join('\n')
      + `\nDeclared: ${[...declared].join(', ')}. If these are genuinely expected, name them in alsoFails.`,
  );
}

/**
 * A throwaway repository holding a *copy of the gate itself*, so the gate can be
 * run the way the workflows run it: with no `--repo` at all.
 *
 * Both `gate-scope.mjs` and `gate-source-approval.mjs` choose their working
 * directory with
 *
 *     const cwd = args.repo ? resolve(args.repo) : repoRoot();
 *
 * and every other test in this file supplies `--repo`, which is right for
 * isolation but leaves the `repoRoot()` arm executed by nothing. Running the
 * ambient checkout instead is not an option: these two gates anchor on
 * `refs/remotes/origin/main`, and a CI clone has no such ref -- the same reason
 * the `gate-source-approval` block builds its own repository rather than gating
 * this one.
 *
 * The copy is planted at the path the original occupies **relative to this
 * repository's root**, derived rather than written out. That is what gives the
 * copy the same directory arithmetic to do as the original, so the test fails
 * both when the `..` count changes and when a gate is moved to a different depth
 * without its count being adjusted -- and it is a claim about location only, so
 * nothing here depends on the checkout's commit or on data that changes.
 *
 * `build` fills the tree and returns the argv to run the planted copy with.
 * `root` comes back resolved through `realpathSync`, because the platform temp
 * directory is a symlink on some systems and Node resolves a module's own path
 * before `import.meta.url` ever reaches `repoRoot()`.
 */
function fallbackRepo(script, build) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-fallback-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'gate@example.com');
    git('config', 'user.name', 'Gate Test');
    const planted = join(dir, relative(REPO, script));
    mkdirSync(dirname(planted), { recursive: true });
    cpSync(script, planted);
    mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'scratch\n');
    const commit = (message) => {
      git('add', '-A');
      git('commit', '-qm', message);
      return git('rev-parse', 'HEAD').trim();
    };
    const publish = () => git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
    const args = build({ dir, git, commit, publish });
    const root = realpathSync(dir);
    return { ...run(planted, args), root };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

/**
 * The helper the rest of this file leans on, exercised against synthetic reports
 * rather than by running a gate: what is under test is `assertFailed`'s own
 * arithmetic over `report.failures`, and spawning a real gate would make that
 * slower and less controllable without making it more true. An upper bound that
 * is never itself exercised is the same unproved claim this suite exists to
 * refuse -- a guard that has only ever been seen to pass is indistinguishable
 * from a guard that cannot fire (#369).
 */
describe('assertFailed', () => {
  const report = (...gates) => ({
    code: 1,
    stdout: JSON.stringify({
      passed: false,
      failures: gates.map((gate) => ({ gate, message: `${gate} went wrong` })),
    }),
  });

  test('a report carrying only the expected gate still passes, so the bound is not blanket', () => {
    assertFailed(report('dates'), 'dates');
    assertFailed(report('dates'), 'dates', 'went wrong');
  });

  test('an undeclared second gate is refused, and the refusal names it', () => {
    assert.throws(
      () => assertFailed(report('dates', 'references'), 'dates'),
      (error) => error.message.includes('references') && error.message.includes('never declared'),
      'an undeclared failure must be reported by name rather than filtered away unexamined',
    );
  });

  test('a second gate the test declares is accepted', () => {
    assertFailed(report('dates', 'references'), 'dates', undefined, { alsoFails: ['references'] });
  });

  test('a declaration that no longer fires is refused, so alsoFails cannot rot into a wildcard', () => {
    assert.throws(
      () => assertFailed(report('dates'), 'dates', undefined, { alsoFails: ['references'] }),
      /alsoFails declares references/,
    );
  });

  test('the expected gate still has to have failed at all', () => {
    assert.throws(() => assertFailed(report('references'), 'dates'), /expected a "dates" failure/);
  });
});

describe('gate-dataset', () => {
  test('the repository dataset passes as it stands', () => {
    // No `--today`: the live dataset is judged on the gate's own clock. The
    // sampled comparison below is the guard against this quietly being re-pinned
    // -- a frozen constant here passes only until the data moves past it, which
    // is #318. The UTC midnight race between this sample and the gate's own
    // `new Date()` runs one way only, so the tolerance is one-sided: `sampled` is
    // taken before the gate is spawned, and both clocks are UTC -- `realToday()`
    // here, `new Date().toISOString().slice(0, 10)` at `gate-dataset.mjs` -- so
    // the gate's day is never earlier than the sample. Only `sampled` and the day
    // after it are reachable. A third arm for the day *before* would cost the one
    // thing this assertion exists to do: a `--today` re-pinned to yesterday would
    // satisfy it, which is #318 arriving again through its own tripwire.
    const sampled = realToday();
    const result = run(GATE_DATASET, ['--data', DATA, '--json']);
    const report = JSON.parse(result.stdout);
    assert.ok(
      [sampled, shiftDays(sampled, 1)].includes(report.today),
      `the live dataset must be gated on the real clock, but ran at "${report.today}" against a real ${sampled}`,
    );
    assert.deepEqual(report.failures, [], 'the live dataset must pass its own gates');
    assert.equal(result.code, 0);
    assert.ok(report.counts.releases > 0, 'the fixture-free dataset should not be empty');
  });

  test('an unchanged copy of the dataset also passes, so the harness itself is honest', () => {
    const result = gateMutatedDataset(() => {});
    assert.equal(result.code, 0, result.stdout);
  });

  // #318 in one assertion: a record verified *today* is not the future. The
  // pinned clock failed exactly here the morning after a refresh landed, so this
  // is the regression guard rather than a restatement of the test above -- that
  // one passes whenever the data happens to be older than the pin, this one only
  // when the boundary itself is right.
  test('a record verified today is accepted rather than read as the future', () => {
    const today = realToday();
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = today;
      write('releases.json', releases);
    });
    assert.equal(result.code, 0, result.stdout);
  });

  // `DATASET_DOCUMENTS` is a copy of a list `gate-dataset.mjs` owns, and one
  // direction of that copy drifting is silent (see the note on the constant).
  // This is what makes it audible: the gate's `DOCUMENTS` map is scraped back
  // out of its own source and compared against the copy.
  //
  // Compared as a directional diff rather than in order, because both consumers
  // iterate with `for..of`, where order carries no meaning -- membership is the
  // whole coupling, so reordering the gate's map is not drift and must not fail
  // here. The message names which side each stray document sits on, since
  // "a document was added to the gate" and "a document was removed from this
  // file" need different fixes.
  //
  // The scrape refuses rather than returning an empty list, the same way
  // `allowedPathsFrom` does further down: two empty lists compare equal, so a
  // parser that silently matched nothing would leave this guard green while
  // checking nothing -- the exact failure mode the constant's comment used to
  // have. The synthetic sources at the end hold the parser to its claim and
  // prove both refusals fire, so this test cannot pass vacuously. It asserts on
  // the parsed list, never on an exit code: gates in this file exit 0 while
  // broken, and no gate is run here at all.
  test('the document list still matches the one gate-dataset.mjs owns', () => {
    const documentsFrom = (source) => {
      const decl = /const\s+DOCUMENTS\s*=\s*\{([\s\S]*?)\}\s*;/.exec(source);
      if (!decl) throw new Error('no DOCUMENTS = { ... } declaration found');
      const files = [...decl[1].matchAll(/['"]([^'"]+\.json)['"]/g)].map((m) => m[1]);
      if (files.length === 0) throw new Error('DOCUMENTS declaration names no documents');
      return files;
    };

    const owned = documentsFrom(readFileSync(GATE_DATASET, 'utf8'));
    const onlyInGate = owned.filter((file) => !DATASET_DOCUMENTS.includes(file)).sort();
    const onlyInTest = DATASET_DOCUMENTS.filter((file) => !owned.includes(file)).sort();
    assert.deepEqual(
      { onlyInGate, onlyInTest },
      { onlyInGate: [], onlyInTest: [] },
      'DATASET_DOCUMENTS has drifted from the DOCUMENTS map gate-dataset.mjs owns -- '
        + `loaded by the gate but not named here: ${onlyInGate.join(', ') || '(none)'}; `
        + `named here but not loaded by the gate: ${onlyInTest.join(', ') || '(none)'}`,
    );

    // The parser reads what it claims to, and fails closed when it does not.
    assert.deepEqual(
      documentsFrom("const DOCUMENTS = {\n  a: 'a.json',\n  b: \"b.json\",\n};\n"),
      ['a.json', 'b.json'],
    );
    assert.throws(() => documentsFrom('const OTHER = 1;'), /no DOCUMENTS/);
    assert.throws(() => documentsFrom('const DOCUMENTS = {};'), /names no documents/);
  });

  // The other half of #318: the suite has to survive the *next* refresh, not
  // just today's. A refresh dated later only exists on a later day, so this moves
  // the data and the clock together -- moving the data alone would be a genuinely
  // future-dated dataset, which must stay refused (proved below). Every date here
  // is computed from the real clock, so nothing in this test can expire.
  test('a dataset refreshed on a later day still passes, so no ceiling is pinned', () => {
    const laterDay = shiftDays(realToday(), 400);
    const result = gateDatasetAt(laterDay, ({ read, write }) => {
      for (const file of DATASET_DOCUMENTS) {
        write(file, read(file).map((entry) => reverified(entry, laterDay)));
      }
    });
    assert.equal(result.code, 0, result.stdout);
  });

  // A refresh that writes nine structurally valid but empty arrays wipes the
  // dataset while every coherence gate stays green -- an empty set has no
  // dangling references, no duplicate ids, nothing to fail. ADR 0003 lets an
  // agent-gated refresh auto-merge, so this all-empty case must be refused
  // outright with a named `non-empty` failure and exit 1 (#185). The literal
  // `[]` written to every document is the expectation, computed from nothing
  // the gate itself produces.
  test('a wholesale-empty dataset is refused rather than reported as coherent', () => {
    const result = gateMutatedDataset(({ write }) => {
      for (const file of DATASET_DOCUMENTS) {
        write(file, []);
      }
    });
    assertFailed(result, 'non-empty', 'found 0');
  });

  // The floor is the all-empty case only: a tree with a single record anywhere
  // is accepted, so this is a pure widening of refusal that leaves every
  // non-empty tree exactly as it was. `usage-syntheses.json` is legitimately
  // empty in the live data, which is why the rule cannot be "every document is
  // non-empty".
  //
  // The documents emptied here are derived from `DATASET_DOCUMENTS` rather than
  // hand-written, because a copy local to this test body is invisible to the
  // drift check above -- that check computes `onlyInGate` and `onlyInTest`
  // against the module-level constant only. A tenth document would therefore
  // reach both the gate and the constant while this body went on emptying nine
  // of ten, leaving the tenth populated and the tree trivially non-empty, and
  // this test would keep its name and its green tick while testing less than it
  // describes. It degrades quietly where `a wholesale-empty dataset is refused`
  // degrades loudly, because its assertion is that nothing fires, and nothing
  // firing is exactly what a narrowed test produces. Deriving closes the second
  // half of the coupling: the drift check makes gate -> constant audible, and
  // this makes constant -> test body automatic.
  test('a dataset emptied to a single record still passes, so the floor is not a per-document rule', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      const keptSource = sources[0];
      const emptied = DATASET_DOCUMENTS.filter((file) => file !== 'sources.json');
      for (const file of emptied) {
        write(file, []);
      }
      write('sources.json', [keptSource]);
    });
    const report = JSON.parse(result.stdout);
    const nonEmptyFailures = report.failures.filter((f) => f.gate === 'non-empty');
    assert.deepEqual(nonEmptyFailures, [], 'a single surviving record must not trip the non-empty floor');
  });

  test('a broken source reference is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].sourceIds = ['a-source-that-was-never-added'];
      write('releases.json', releases);
    });
    assertFailed(result, 'references', 'does not resolve to a source');
  });

  test('a verification date in the future is caught', () => {
    // Computed from the real clock, not written as a literal: under the live
    // clock a fixed date stops being "the future" the moment it arrives, so
    // `2027-01-01` would have quietly stopped testing anything in 2027. The
    // wide margin also clears the UTC midnight race with the gate's own clock.
    const future = shiftDays(realToday(), 366);
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = future;
      write('releases.json', releases);
    });
    assertFailed(result, 'dates', 'is in the future');
  });

  test('a date that never existed is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].releaseDate = '2026-02-30';
      write('releases.json', releases);
    });
    assertFailed(result, 'dates', 'is not a real YYYY-MM-DD date');
  });

  test('a release that predates the model it descends from is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      // Make the second release descend from the first, then date it earlier.
      releases[1].predecessorIds = [releases[0].id];
      releases[1].releaseDate = '2000-01-01';
      write('releases.json', releases);
    });
    assertFailed(result, 'dates', 'precedes predecessor', {
      // Declared rather than tolerated (#369). Backdating the second release is
      // not a single-gate mutation: it also makes that release a lineage
      // neighbour of a family sibling, which `lineage` refuses on its own terms.
      // Both failures are consequences of this one edit, so both are the test's
      // to state -- and the declaration is checked in both directions, so if the
      // lineage consequence ever stops arriving this line fails rather than
      // standing as permanent permission.
      alsoFails: ['lineage'],
    });
  });

  test('a release that is its own predecessor is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].predecessorIds = [releases[0].id];
      write('releases.json', releases);
    });
    assertFailed(result, 'lineage', 'contains the release itself');
  });

  test('a predecessor cycle between two releases is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].predecessorIds = [releases[1].id];
      releases[1].predecessorIds = [releases[0].id];
      write('releases.json', releases);
    });
    assertFailed(result, 'lineage');
  });

  test('a release attributed away from its family owner is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      const organizations = read('organizations.json');
      const other = organizations.find((organization) => organization.id !== releases[0].organizationId);
      releases[0].organizationId = other.id;
      write('releases.json', releases);
    });
    assertFailed(result, 'entity-boundary', 'belongs to');
  });

  test('a publisher squatting on a creator id without being its voice is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const publishers = read('publishers.json');
      const impostor = publishers.find((publisher) => publisher.organizationId);
      delete impostor.organizationId;
      write('publishers.json', publishers);
    });
    assertFailed(result, 'entity-boundary', 'without declaring organizationId');
  });

  test('an http source url is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      sources[0].url = 'http://openai.com/news/';
      write('sources.json', sources);
    });
    assertFailed(result, 'urls', 'is not https');
  });

  test('a source hosted on localhost is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      sources[0].url = 'https://localhost/news/';
      write('sources.json', sources);
    });
    assertFailed(result, 'urls', 'cannot stand behind a public fact');
  });

  test('a fact with no primary source is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      families[0].sourceIds = [];
      write('families.json', families);
    });
    assertFailed(result, 'evidence', 'no primary source');
  });

  test('a composite score field is caught wherever it is buried', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].parameters = { ...releases[0].parameters, overallScore: 91 };
      write('releases.json', releases);
    });
    assertFailed(result, 'no-composite-score', 'ranking or composite score');
  });

  test('a source checked before it was published is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      const dated = sources.find((source) => source.publishedDate);
      dated.lastCheckedDate = '2000-01-01';
      write('sources.json', sources);
    });
    assertFailed(result, 'dates', 'precedes publishedDate');
  });

  test('a malformed dataset document fails rather than being skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
    try {
      cpSync(DATA, dir, { recursive: true });
      writeFileSync(join(dir, 'releases.json'), '{not json');
      const result = run(GATE_DATASET, ['--data', dir, '--json']);
      assertFailed(result, 'well-formed', 'not valid JSON', {
        // Declared rather than tolerated (#369). An unparseable `releases.json`
        // loads as no releases at all, so every record in the other documents
        // that points at a release dangles and `references` fires a dozen times
        // over. That cascade is the direct consequence of this mutation, not
        // noise from somewhere else, so the test states it.
        alsoFails: ['references'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // The three states of one dataset document (#312). A document can be
  // **absent**, **unknown** (present but not what it claims to be), or
  // **present-but-stale**. They fail differently and none implies another, so
  // each is stated rather than inferred from its neighbour.
  //
  // The stale cell is deliberately empty and is not a gap: this gate applies no
  // freshness floor to a record, and nothing here caches a document between
  // runs, so a document has no stale state to test. Inventing one to fill the
  // row would be worse than saying so.
  //
  // The absent *directory* test below is a fourth thing again, and covers none
  // of these: it exits 2 before any document is looked for.
  // -------------------------------------------------------------------------

  // `usage-syntheses.json` is the document to delete, and the choice is the
  // whole test. Nothing references it, so the missing-document rule is the only
  // thing standing between a deleted document and exit 0 -- delete
  // `releases.json` instead and a wall of dangling-reference failures fires,
  // which would pass this assertion while proving nothing about the rule under
  // test. Removing the rule leaves the suite green and the gate publishing a
  // dataset with a document silently gone.
  test('a dataset document that is absent entirely is caught, not read as an empty collection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
    try {
      cpSync(DATA, dir, { recursive: true });
      rmSync(join(dir, 'usage-syntheses.json'));
      const result = run(GATE_DATASET, ['--data', dir, '--json']);
      assertFailed(result, 'well-formed', 'dataset document is missing');
      const report = JSON.parse(result.stdout);
      assert.ok(
        report.failures.some((failure) => failure.where === 'usage-syntheses.json'),
        `the refusal must name the document that vanished:\n${result.stdout}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The sibling of `a malformed dataset document fails rather than being
  // skipped` above, which reaches only the *unparseable* branch. A document that
  // parses cleanly but is an object, a string or a number takes a different
  // branch entirely, and without this rule would load as an empty collection --
  // which every other gate in this file accepts, because an empty collection has
  // no dangling references, no duplicate ids and no out-of-range dates.
  test('a dataset document that parses but is not an array is caught, not loaded as empty', () => {
    for (const body of ['{"usageSyntheses": []}', '"a string"', '42', 'null']) {
      const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
      try {
        cpSync(DATA, dir, { recursive: true });
        writeFileSync(join(dir, 'usage-syntheses.json'), body);
        const result = run(GATE_DATASET, ['--data', dir, '--json']);
        assertFailed(result, 'well-formed', 'must be a JSON array');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // `--today`'s three states, and this is the one that fails open. **Absent** is
  // the live path, asserted at the top of this block. **Present-but-stale** -- an
  // older day supplied on purpose -- is what `gateDatasetAt` exists for and what
  // the later-day test above exercises. **Unknown** is here.
  //
  // Why it is the dangerous one: every future-date rule in this gate is a `>`
  // comparison against `startOf(today)`, and `startOf("tomorrow")` is NaN. NaN
  // loses every comparison, so an unvalidated `--today` does not shift the clock
  // by a day, it deletes the entire future-date gate while still exiting 0.
  //
  // `''` used to sit in the list below and no longer does. It is not a day that
  // failed to parse -- it is the flag arriving with no value at all, which #372
  // moved earlier, to `parseArgs`, where it exits 2 naming the flag rather than
  // the date. The case is still asserted, in `--today with no value exits 2
  // rather than falling back to the wall clock`; it changed owner, not verdict.
  test('--today that is not a real date exits 2 rather than disabling every future-date rule', () => {
    for (const bad of ['not-a-date', 'tomorrow', '2026-13-01', '2026-02-30', '26-08-25']) {
      const result = run(GATE_DATASET, ['--data', DATA, '--today', bad, '--json']);
      assert.equal(result.code, 2, `--today ${JSON.stringify(bad)} must not be accepted:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes('is not a real date'),
        `the refusal must name the flag, not fail for some other reason:\n${result.stdout}`,
      );
    }

    // The consequence the guard exists to prevent, stated as a scenario so the
    // test above is anchored to something observable rather than to an exit
    // code: on a real clock a record dated far in the future is caught, so a
    // `--today` that waved it through would be this gate going blind.
    const future = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = '2099-01-01';
      write('releases.json', releases);
    });
    assertFailed(future, 'dates', 'is in the future');
  });

  // The mirror of gate-scope's `an unknown flag exits 2 rather than being
  // ignored`, and stated per gate rather than inferred across them: these four
  // scripts each hand-roll their own `parseArgs`, so a guarantee proved on one
  // is not a guarantee about another. #168 is open on exactly that drift.
  test('an unknown flag on the dataset gate exits 2 rather than being ignored', () => {
    for (const flag of ['--force', '--skip', '--skip-gates', '--yes']) {
      const result = run(GATE_DATASET, ['--data', DATA, flag, '--json']);
      assert.equal(result.code, 2, `${flag} must not be recognised, and must never be a pass:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes(`unknown flag ${flag}`),
        `the refusal must name the flag it did not recognise:\n${result.stdout}`,
      );
    }
  });

  // `--data` in its **absent** state. The test below is a different cell and
  // does not cover this one: it supplies `--data <a path that does not exist>`,
  // which is the *unknown* state. Absent means the flag is not passed at all,
  // and the two take different branches at `gate-dataset.mjs:549`:
  //
  //     const dataDir = args.data ? resolve(args.data) : join(repoRoot(), ...);
  //
  // Every other `run(GATE_DATASET, ...)` call site in this file passes `--data`,
  // so before this test the fallback arm was never executed once. A `repoRoot()`
  // with the wrong number of `..` segments -- the ordinary way that line breaks,
  // since it counts directories by hand -- was caught by nothing.
  //
  // Asserting the resolved directory, and not just the exit code, is the point.
  // A gate that fell back to the wrong place but happened to find some dataset
  // there would still exit 0, so the code alone cannot tell the two apart. The
  // counts assertion then proves it actually loaded what it named, rather than
  // reporting a path it never opened.
  //
  // No `--today`: this reads the live dataset, so it is bound by the two-clock
  // rule at the top of this file exactly as the first test in this block is.
  test('with no --data at all the gate falls back to this repository, not to nothing', () => {
    const result = run(GATE_DATASET, ['--json']);
    assert.equal(result.code, 0, `the live dataset must pass when found by fallback:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(
      resolve(report.dataDir),
      resolve(DATA),
      'the fallback must resolve to this repository\'s own web/src/data',
    );
    assert.ok(report.counts.sources > 0, `the fallback directory must be the one actually read:\n${result.stdout}`);
  });

  // The **unknown** state of the same input: supplied, but naming nothing.
  test('a missing data directory exits 2 rather than passing', () => {
    const result = run(GATE_DATASET, ['--data', join(tmpdir(), 'modeltree-does-not-exist'), '--json']);
    assert.equal(result.code, 2, 'a gate that cannot run must not report success');
  });

  // `--data` in a fourth state, and the only one of the four that failed open:
  // **supplied, but carrying nothing**. `argv[++i]` on a flag written last is
  // `undefined`, which is falsy, so the fallback arm two tests up ran and gated
  // this repository's own `web/src/data` -- a directory the caller never named
  // -- and exited 0. A green verdict about a different input is indistinguishable
  // from a green verdict, which is the failure this gate set exists to prevent
  // occurring in the gate set itself (#372).
  //
  // The exit code alone cannot state that, which is why the third assertion is
  // here rather than implied: the fallback dataset *passes*, so the defect's
  // signature is `code === 0` **plus a report about a directory nobody asked
  // for**, and a gate that refuses must produce no verdict at all. `"dataDir"`
  // is the key every `--json` report carries, so its absence is that claim.
  // Asserting the path itself instead would not survive JSON's backslash
  // escaping on Windows -- the substring would be absent either way, and the
  // assertion would pass while proving nothing.
  //
  // `''` is the same state reached without anyone typing a malformed command:
  // PowerShell strips embedded double quotes from native-command arguments, so
  // `--data ""` arrives here as an empty string.
  test('--data with no value exits 2 rather than falling back to this repository', () => {
    for (const argv of [['--json', '--data'], ['--data', '', '--json']]) {
      const result = run(GATE_DATASET, argv);
      assert.equal(result.code, 2, `${JSON.stringify(argv)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-dataset: --data needs a value/);
      assert.ok(
        !result.stdout.includes('"dataDir"'),
        `a refused invocation must report no verdict about any directory:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass: the guard must refuse a value-less
    // flag without making the flag unusable. No `--today` here, per the
    // two-clock rule at the top of this file.
    const control = run(GATE_DATASET, ['--data', DATA, '--json']);
    assert.equal(control.code, 0, `--data with a real value must still gate:\n${control.stdout}`);
    assert.equal(
      resolve(JSON.parse(control.stdout).dataDir),
      resolve(DATA),
      'and must gate the directory it was given',
    );
  });

  // The same defect on this gate's other value-taking flag, and a quieter one:
  // `--today` has no directory to name, so a value that went missing left
  // `undefined` for `args.today ?? new Date()...` to replace with the wall
  // clock. The gate then judged the dataset against a day the caller never
  // chose and exited 0 -- which, on a run pinning an older day on purpose, is
  // the future-date rule silently evaluated at the wrong instant (#372).
  //
  // `"today"` is the report key that carries the claim: a refused invocation
  // must not have reported a day at all. Note the second argv exits 2 either
  // way -- an empty string reached `isRealDate` before the fix -- so the code
  // assertion cannot separate them and the message is what does.
  test('--today with no value exits 2 rather than falling back to the wall clock', () => {
    for (const argv of [['--data', DATA, '--json', '--today'], ['--data', DATA, '--today', '', '--json']]) {
      const result = run(GATE_DATASET, argv);
      assert.equal(result.code, 2, `${JSON.stringify(argv)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-dataset: --today needs a value/);
      assert.ok(
        !result.stdout.includes('"today"'),
        `a refused invocation must report no verdict against any day:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass. Tomorrow is a day simulated on
    // purpose, which is what a supplied clock means in this file -- never
    // "today" -- and every live record is dated on or before today, so this
    // passes for as long as the first test in this block does. The reported day
    // is asserted because it is what separates "the value was carried through"
    // from "the wall clock was used and happened to agree".
    const simulated = shiftDays(realToday(), 1);
    const control = run(GATE_DATASET, ['--data', DATA, '--today', simulated, '--json']);
    assert.equal(control.code, 0, `--today with a real value must still gate:\n${control.stdout}`);
    assert.equal(JSON.parse(control.stdout).today, simulated, 'and must be judged on the day it was given');
  });
});

// ---------------------------------------------------------------------------

const HASH = `sha256:${'a'.repeat(64)}`;

function claim(overrides = {}) {
  return {
    id: 'openai-gpt-5-7-release-date',
    kind: 'change',
    collection: 'releases',
    targetId: 'openai-gpt-5-7',
    field: 'releaseDate',
    currentValue: '2026-08-01',
    proposedValue: '2026-08-20',
    statement: 'GPT-5.7 was released on 20 August 2026.',
    evidence: [{
      sourceId: 'openai-gpt-5-7-announcement',
      url: 'https://openai.com/index/gpt-5-7/',
      contentHash: HASH,
      fetchedAt: '2026-08-25',
      quote: 'Today we are releasing GPT-5.7 to all API customers.',
      retrieval: 'fetch',
    }],
    verdicts: [
      { reviewer: 'provenance', vote: 'accept', rationale: 'The announcement states the date directly.' },
      { reviewer: 'consistency', vote: 'accept', rationale: 'Consistent with the family timeline.' },
      { reviewer: 'editorial', vote: 'accept', rationale: 'Release, not product; boundary respected.' },
    ],
    ...overrides,
  };
}

// A bundle's policy is derived from its creator (#233), so every bundle now
// names one. Tests that are not about derivation take a reviewed (pilot) creator
// by default, so their declared `pilot` matches the policy derived from the
// reviewed-profile set; the derivation tests below set `creator` explicitly to
// exercise the long-tail and mismatch cases. A bundle carrying no `policy` is
// left untouched, so the absent-policy refusal still sees the bundle as written.
const DEFAULT_PILOT_CREATOR = 'openai';

function gateBundle(bundle, options = {}) {
  const withCreator = Object.hasOwn(bundle, 'creator') || !Object.hasOwn(bundle, 'policy')
    ? bundle
    : { ...bundle, creator: DEFAULT_PILOT_CREATOR };
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
  try {
    const path = join(dir, 'claims.json');
    writeFileSync(path, JSON.stringify(withCreator, null, 2));
    const extra = options.repo ? ['--repo', options.repo] : [];
    return run(GATE_EVIDENCE, ['--claims', path, '--today', TODAY, '--json', ...extra]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A scratch repository whose reviewed-profile set holds exactly `entries`, for
 * the loader's own rules (#251). A string value is written verbatim, an object
 * is written as JSON, and `null` makes a directory of that name -- which is how
 * the "a directory is never a candidate" case is stated.
 */
function repoWithProfiles(entries) {
  const repo = mkdtempSync(join(tmpdir(), 'modeltree-reviewed-set-'));
  const dir = join(repo, 'tools', 'updater', 'profiles');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(entries)) {
    if (body === null) mkdirSync(join(dir, name), { recursive: true });
    else writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return repo;
}

/**
 * As `gateBundle`, but the argument list is stated in full: no `--today` is
 * supplied unless `args` carries one.
 *
 * `gateBundle` always pins the clock, which is right for a fixture and wrong for
 * the tests that are *about* the clock flag -- an absent `--today` and an
 * unknown one are states of that input in their own right (#312), and neither is
 * reachable through a helper that always supplies a good value.
 */
function gateBundleWithArgs(bundle, args) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
  try {
    const path = join(dir, 'claims.json');
    writeFileSync(path, JSON.stringify(bundle, null, 2));
    return run(GATE_EVIDENCE, ['--claims', path, '--json', ...args]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gate-evidence', () => {
  test('a fully evidenced, unanimously accepted claim passes', () => {
    const result = gateBundle({ runId: 'r1', creator: 'openai', policy: 'pilot', claims: [claim()] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 1);
  });

  test('a search snippet is refused as evidence', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], retrieval: 'search-snippet' }] })],
    });
    assertFailed(result, 'evidence', 'a search snippet is never evidence');
  });

  test('evidence with no content hash is refused', () => {
    const evidence = { ...claim().evidence[0] };
    delete evidence.contentHash;
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [evidence] })] });
    assertFailed(result, 'evidence', 'is not shaped sha256:<64 hex>');
  });

  test('a hash that is not a sha256 digest is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], contentHash: 'sha256:short' }] })],
    });
    assertFailed(result, 'evidence', 'is not shaped sha256:<64 hex>');
  });

  test('a quote too short to show the source stating the claim is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], quote: 'yes' }] })],
    });
    assertFailed(result, 'evidence', 'shorter than');
  });

  // ADR 0005: the evidence gate verifies the FORM of contentHash and quote, never
  // that they correspond to the remote page. It fetches nothing, so a fabricated
  // digest and an invented quote pass provided both are well-formed. This test
  // pins that accepted limit as executable characterisation (#240 AC1). The digest
  // is a literal, deliberately not the fixture's default and not computed by any
  // hashing helper, so the test cannot silently become a tautology against a hash
  // function. It is capable of failing: were the gate to gain real content
  // verification, or were the shape/length checks tightened to reject these
  // well-formed values, this claim would stop passing.
  test('a fabricated content hash and an invented quote still pass, because the gate checks only form (ADR 0005)', () => {
    const fabricated = `sha256:${'0123456789abcdef'.repeat(4)}`;
    const fixtureHash = claim().evidence[0].contentHash;
    assert.notEqual(fabricated, fixtureHash, 'the fabricated hash must differ from the fixture default');
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        evidence: [{
          ...claim().evidence[0],
          contentHash: fabricated,
          quote: 'This sentence never appeared on the cited page and was invented wholesale.',
        }],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.applicable, 1);
    assert.equal(
      report.failures.filter((f) => f.gate === 'evidence').length,
      0,
      'the gate raises no evidence failure for a well-formed but fabricated citation',
    );
  });

  test('a claim with no evidence at all is refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [] })] });
    assertFailed(result, 'evidence', 'no evidence at all');
  });

  test('a 1-of-3 minority cannot apply a change', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'ok' },
          { reviewer: 'consistency', vote: 'reject', rationale: 'contradicts the family timeline' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'conflates product with release' },
        ],
      })],
    });
    assertFailed(result, 'review', 'only reached 1 of 2 required accepts');
  });

  test('a 2-of-3 majority is enough for a pilot creator', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
  });

  test('the same 2-of-3 majority is NOT enough for a long-tail creator', () => {
    const result = gateBundle({
      creator: 'some-long-tail-creator',
      policy: 'long-tail',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assertFailed(result, 'review', 'only reached 2 of 3 required accepts');
  });

  test('an incomplete panel is refused even when every reported vote accepts', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
        ],
      })],
    });
    assertFailed(result, 'review', 'never reported');
  });

  test('one reviewer voting twice cannot manufacture a majority', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly again' },
          { reviewer: 'editorial', vote: 'accept', rationale: 'fine' },
        ],
      })],
    });
    assertFailed(result, 'review', 'voted twice');
  });

  test('a verdict with no rationale is refused as unauditable', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: '' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'accept', rationale: 'fine' },
        ],
      })],
    });
    assertFailed(result, 'review', 'no rationale');
  });

  test('a change that changes nothing is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ currentValue: '2026-08-20', proposedValue: '2026-08-20' })],
    });
    assertFailed(result, 'shape', 'equals the current value');
  });

  test('a claim aimed at a file outside the dataset is refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim({ collection: 'schema' })] });
    assertFailed(result, 'shape', 'is not a dataset document');
  });

  test('two claims sharing an id are refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim(), claim()] });
    assertFailed(result, 'shape', 'appears more than once');
  });

  test('evidence fetched in the future is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], fetchedAt: '2027-01-01' }] })],
    });
    assertFailed(result, 'evidence', 'is in the future');
  });

  test('an unchanged finding needs evidence but not a majority', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        kind: 'unchanged',
        verdicts: [
          { reviewer: 'provenance', vote: 'reject', rationale: 'no change found' },
          { reviewer: 'consistency', vote: 'reject', rationale: 'no change found' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'no change found' },
        ],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 0, 'an unchanged finding applies nothing');
  });

  test('a missing bundle exits 2 rather than passing', () => {
    const result = run(GATE_EVIDENCE, ['--claims', join(tmpdir(), 'no-such-bundle.json'), '--json']);
    assert.equal(result.code, 2);
  });

  // -------------------------------------------------------------------------
  // `--today`, across its three states (#312). Every other test in this block
  // pins the clock through `gateBundle`, which covers the **present-but-stale**
  // cell -- a day supplied on purpose that is not the real one -- and leaves the
  // other two unexercised. Both are closed here, and they fail differently.
  // -------------------------------------------------------------------------

  // **Absent.** The default path, and the one every documented invocation of
  // this gate takes: `node gate-evidence.mjs --claims <path>` supplies no clock.
  // Until now no test in this file ran it, so the fallback could have been any
  // constant at all -- including one far enough forward to make the future-date
  // rule unreachable -- without the suite noticing.
  test('with no --today the gate falls back to the real clock, so a future fetchedAt is still caught', () => {
    const future = shiftDays(realToday(), 400);
    const result = gateBundleWithArgs({
      runId: 'r1',
      creator: DEFAULT_PILOT_CREATOR,
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], fetchedAt: future }] })],
    }, []);
    assertFailed(result, 'evidence', 'is in the future');
    assert.ok(
      result.stdout.includes(future),
      `the refusal must name the date it read as the future:\n${result.stdout}`,
    );
    // And the clock it compared against is the real one, not a constant that
    // happens to sit before the fixture. A frozen fallback would satisfy the
    // assertion above while being exactly the defect (#318 is the same shape).
    assert.ok(
      [shiftDays(realToday(), -1), realToday()].some((day) => result.stdout.includes(`today is ${day}`)),
      `the fallback clock must be the real one:\n${result.stdout}`,
    );
  });

  // **Unknown.** The dangerous half, for the same reason it is in `gate-dataset`:
  // the future-date rule is a `>` comparison against `startOf(today)`, and
  // `startOf("soon")` is NaN. NaN loses every comparison, so an unvalidated
  // `--today` would not shift the clock, it would delete the rule while still
  // reporting a pass.
  //
  // `''` left this list in #372 for the reason given on the `gate-dataset`
  // sibling above: an empty value is the flag carrying nothing, refused at
  // `parseArgs` and asserted by its own test below, not a date that failed to
  // parse.
  test('--today that is not a real date exits 2 rather than being carried into the comparison', () => {
    for (const bad of ['soon', 'not-a-date', '2026-13-01', '2026-02-30', '26-08-25']) {
      const result = gateBundleWithArgs(
        { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] },
        ['--today', bad],
      );
      assert.equal(result.code, 2, `--today ${JSON.stringify(bad)} must not be accepted:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes('is not a real date'),
        `the refusal must name the flag, not fail for some other reason:\n${result.stdout}`,
      );
    }
  });

  // The mirror of gate-scope's and gate-source-approval's unknown-flag tests.
  // Stated per gate rather than inferred across them: all four scripts hand-roll
  // their own `parseArgs`, and #168 is open on nothing detecting drift between
  // them. ADR 0003's "no escape hatch" guardrail is a claim about every gate.
  test('an unknown flag on the evidence gate exits 2 rather than being ignored', () => {
    for (const flag of ['--force', '--skip', '--skip-gates', '--yes']) {
      const result = gateBundleWithArgs(
        { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] },
        ['--today', TODAY, flag],
      );
      assert.equal(result.code, 2, `${flag} must not be recognised, and must never be a pass:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes(`unknown flag ${flag}`),
        `the refusal must name the flag it did not recognise:\n${result.stdout}`,
      );
    }
  });

  // The three flags this gate takes a value for, each refused when the value is
  // missing rather than replaced by a default (#372). Split one test per flag,
  // because the defaults differ and so does what each substitution costs.
  //
  // `--repo` is the expensive one: it selects the reviewed-profile set the
  // policy threshold is *derived* from, so a value that went missing had this
  // gate hold a bundle to a threshold computed from a tree the caller never
  // named, and report a pass. The report key `"passed"` is the claim that no
  // verdict was reached at all; asserting the root path instead would not
  // survive JSON's backslash escaping on Windows and would pass vacuously.
  test('--repo with no value exits 2 rather than falling back to the tree this script sits in', () => {
    const bundle = { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] };
    for (const args of [['--today', TODAY, '--repo'], ['--today', TODAY, '--repo', '']]) {
      const result = gateBundleWithArgs(bundle, args);
      assert.equal(result.code, 2, `${JSON.stringify(args)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-evidence: --repo needs a value/);
      assert.ok(
        !result.stdout.includes('"passed"'),
        `a refused invocation must reach no verdict about any tree:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass: the flag still selects a root when it
    // is given one, and the report still names it.
    const control = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', REPO]);
    assert.equal(control.code, 0, `--repo with a real value must still gate:\n${control.stdout}`);
    assert.equal(resolve(JSON.parse(control.stdout).repo), resolve(REPO), 'and must gate the tree it was given');
  });

  // `--today`'s missing value fell through to the wall clock, so a run pinning a
  // day on purpose would have had its date rules evaluated at some other
  // instant and still exited 0. The second argv exited 2 before the fix as well
  // -- an empty string reached `isRealDate` -- so the message is what separates
  // the two refusals, not the code.
  test('--today with no value exits 2 rather than falling back to the wall clock', () => {
    const bundle = { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] };
    for (const args of [['--today'], ['--today', '']]) {
      const result = gateBundleWithArgs(bundle, args);
      assert.equal(result.code, 2, `${JSON.stringify(args)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-evidence: --today needs a value/);
      assert.ok(
        !result.stdout.includes('"passed"'),
        `a refused invocation must reach no verdict at all:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass, on the pinned fixture clock.
    const control = gateBundleWithArgs(bundle, ['--today', TODAY]);
    assert.equal(control.code, 0, `--today with a real value must still gate:\n${control.stdout}`);
  });

  // `--claims` is the honest exception in this group, and the test says so
  // rather than borrowing credit from its siblings: this flag never had a
  // default to fall back to, so nothing here was failing open and the exit code
  // was 2 before the fix as well. What changed is that the refusal now names
  // what happened. "`--claims <path>` is required" is what a caller who omitted
  // the flag entirely is told, and reporting that to a caller who *did* pass it
  // -- whose value expanded to nothing under a shell that strips quotes -- sends
  // them looking for the wrong bug. The message assertion is therefore the whole
  // test; an exit-code-only assertion here could not fail and would be one more
  // check that cannot fail.
  test('--claims with no value is refused as a value-less flag, not as an absent one', () => {
    for (const argv of [['--json', '--claims'], ['--claims', '', '--json']]) {
      const result = run(GATE_EVIDENCE, argv);
      assert.equal(result.code, 2, `${JSON.stringify(argv)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-evidence: --claims needs a value/);
      assert.ok(
        !result.stdout.includes('is required'),
        `a flag that was passed must not be reported as one that was omitted:\n${result.stdout}`,
      );
    }

    // The refusal the message above must stay distinct from: the flag genuinely
    // absent. A control in the other direction, and the reason the assertion
    // above is worth making.
    const omitted = run(GATE_EVIDENCE, ['--json']);
    assert.equal(omitted.code, 2, `an absent --claims must still be refused:\n${omitted.stdout}`);
    assert.match(omitted.stdout, /gate-evidence: --claims <path> is required/);

    // Positive control, expected to pass: a real bundle path still gates.
    const control = gateBundle({ runId: 'r1', policy: 'pilot', claims: [claim()] });
    assert.equal(control.code, 0, `--claims with a real value must still gate:\n${control.stdout}`);
  });

  test('an unknown policy exits 2 rather than falling back to the loose one', () => {
    const result = gateBundle({ policy: 'whatever', claims: [claim()] });
    assert.equal(result.code, 2, result.stdout);
  });

  // The sibling of the test above, and the more dangerous half. An unknown
  // policy is a typo; a *missing* one is the field simply not being reported by
  // the agent whose work this gate exists to check. Defaulting it picks the
  // looser threshold from silence, so a long-tail claim that never reached
  // unanimity would publish under the pilot bar. `tools/updater` refuses the
  // same way -- naming a long-tail profile without choosing its threshold exits
  // 2 -- because the threshold a change was decided under must be a choice.
  test('a missing policy exits 2 rather than defaulting to the loose one', () => {
    const bundle = { runId: 'r1', creator: 'some-long-tail-creator', claims: [claim()] };
    assert.ok(!Object.hasOwn(bundle, 'policy'), 'the fixture must not carry a policy');
    const result = gateBundle(bundle);
    assert.equal(result.code, 2, result.stdout);
  });

  // The failure this protects against, stated as the scenario rather than as a
  // property: a long-tail creator, a 2-accept/1-reject panel, and no policy.
  // That is 2 of the 3 accepts unanimity requires, and it must not pass.
  test('a 2-of-3 panel with no policy cannot publish by defaulting to pilot', () => {
    const result = gateBundle({
      runId: 'r1',
      creator: 'some-long-tail-creator',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assert.notEqual(result.code, 0, `a claim that never chose a threshold must not pass: ${result.stdout}`);
  });

  // ---------------------------------------------------------------------------
  // Policy is derived from the reviewed-profile set, not believed from the
  // bundle (#233). The gate validated that `policy` was present and one of the
  // two known strings, but never that it was the *correct* threshold for the
  // creator -- so a long-tail creator could declare "pilot" and be held to a
  // 2-of-3 majority instead of the unanimity ADR 0002 requires.
  // ---------------------------------------------------------------------------

  // The defect, demonstrated. A creator with no reviewed profile is long-tail,
  // so it must clear a unanimous panel; declaring "pilot" must not lower that bar
  // to a majority. Against the pre-#233 gate this bundle passed with exit 0 --
  // which is exactly the hole this issue closes.
  test('a long-tail creator declaring "policy": "pilot" is refused, not held to the pilot bar', () => {
    const result = gateBundle({
      runId: 'r1',
      creator: 'some-long-tail-creator',
      policy: 'pilot',
      claims: [claim()],
    });
    assert.equal(result.code, 2, `a long-tail creator must not publish under the pilot bar: ${result.stdout}`);
    assert.match(result.stdout, /some-long-tail-creator/, 'the refusal must name the creator');
    assert.match(result.stdout, /pilot/, 'the refusal must name the declared policy');
    assert.match(result.stdout, /long-tail/, 'the refusal must name the derived policy');
  });

  // The mirror: a reviewed (pilot) creator declaring long-tail is also a
  // contradiction. The declared value is checked against ground truth in both
  // directions, and never silently overridden -- a run that believes it is
  // publishing under the wrong bar is itself a defect worth surfacing.
  test('a pilot creator declaring "policy": "long-tail" is refused as a contradiction', () => {
    const result = gateBundle({
      runId: 'r1',
      creator: 'openai',
      policy: 'long-tail',
      claims: [claim()],
    });
    assert.equal(result.code, 2, `a declared/derived policy mismatch must be refused: ${result.stdout}`);
    assert.match(result.stdout, /openai/, 'the refusal must name the creator');
  });

  // Derivation admits the honest bundle: a reviewed creator whose declared
  // policy matches the one derived from disk still passes and still applies.
  test('a reviewed creator whose declared policy matches the derived one still passes', () => {
    const result = gateBundle({ runId: 'r1', creator: 'anthropic', policy: 'pilot', claims: [claim()] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 1);
  });

  // Fails closed on an unclassifiable creator. A bundle naming no creator has
  // nothing to derive a policy from, so it exits 2 rather than falling through to
  // the declared (looser) value. Built inline rather than through `gateBundle`,
  // which would supply a default creator and hide the case under test.
  test('a bundle with no creator cannot be classified and exits 2', () => {
    const bundle = { runId: 'r1', policy: 'pilot', claims: [claim()] };
    assert.ok(!Object.hasOwn(bundle, 'creator'), 'the fixture must not carry a creator');
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
    try {
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      const result = run(GATE_EVIDENCE, ['--claims', path, '--today', TODAY, '--json']);
      assert.equal(result.code, 2, `an unclassifiable creator must exit 2: ${result.stdout}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Fails closed when the reviewed-profile set itself cannot be read. Pointed at
  // a repository with no profiles directory, the gate exits 2 rather than
  // classifying every creator against nothing.
  //
  // Exit 2 on its own does not establish that (#251). A gate that has never heard
  // of `--repo` rejects it as an unknown flag and exits 2 as well, so the bare
  // assertion this test used to make passed against a gate that did not handle
  // the case at all -- it read the right code off the wrong behaviour. The two
  // assertions below are what make it discriminate: the refusal must not be the
  // unknown-flag one, and it must name the set it could not read.
  test('an unreadable reviewed-profile set fails closed with exit 2, naming the set', () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), 'modeltree-no-profiles-'));
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'openai', policy: 'pilot', claims: [claim()] },
        { repo: emptyRepo },
      );
      assert.equal(result.code, 2, `an unreadable reviewed set must fail closed: ${result.stdout}`);
      assert.ok(
        !result.stdout.includes('unknown flag'),
        `--repo must be honoured, not rejected as unknown; exit 2 from that path proves nothing:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes('reviewed-profile set'),
        `the refusal must say what was unreadable:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes(resolve(emptyRepo, 'tools', 'updater', 'profiles')),
        `the refusal must name the directory it could not read:\n${result.stdout}`,
      );
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  // The other half of that tightening. Refusing to read a directory shows `--repo`
  // was not ignored; it does not show the flag *selects* the set the policy is
  // derived from. Pointed at a scratch repository whose reviewed set holds one
  // creator this repository has never heard of, the derivation has to follow that
  // set in both directions -- the invented creator is a pilot there, and `openai`,
  // a pilot here, is long-tail there.
  test('--repo selects the reviewed set the policy is derived from', () => {
    const repo = mkdtempSync(join(tmpdir(), 'modeltree-other-profiles-'));
    try {
      const dir = join(repo, 'tools', 'updater', 'profiles');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'acme.json'), JSON.stringify({ creator: { id: 'acme-labs' } }));

      const pilotThere = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(pilotThere.code, 0, `acme-labs has a reviewed profile in that repository: ${pilotThere.stdout}`);
      assert.equal(JSON.parse(pilotThere.stdout).threshold, 2, 'a pilot there is held to 2 of 3');

      const longTailHere = gateBundle(
        { runId: 'r1', creator: 'openai', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(longTailHere.code, 2, `openai has no reviewed profile there: ${longTailHere.stdout}`);
      assert.ok(
        longTailHere.stdout.includes('long-tail'),
        `the refusal must derive long-tail from the set --repo named:\n${longTailHere.stdout}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Which root the verdict was about (#381). `--repo` selects the tree this gate
  // reads its reviewed set from, and until now the report never said which tree
  // that was -- so a run pointed at the wrong one produced a report identical in
  // every field to a run pointed at the right one.
  //
  // Presence is not the claim; the value is. The two roots below hold *identical
  // contents* and differ only in path, so every other field of the two reports
  // is equal and the assertion can only be carried by `repo` itself. A field
  // hard-wired to any one value fails here rather than passing twice.
  test('the evidence report names the root the reviewed set was read from', () => {
    const bundle = { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] };
    const profiles = { 'acme.json': { creator: { id: 'acme-labs' } } };
    const first = repoWithProfiles(profiles);
    const second = repoWithProfiles(profiles);
    try {
      const a = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', first]);
      const b = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', second]);
      assert.equal(a.code, 0, `the first root must be gateable:\n${a.stdout}`);
      assert.equal(b.code, 0, `the second root must be gateable:\n${b.stdout}`);

      const reportA = JSON.parse(a.stdout);
      const reportB = JSON.parse(b.stdout);
      assert.equal(typeof reportA.repo, 'string', `the report must name a root:\n${a.stdout}`);
      assert.equal(typeof reportB.repo, 'string', `the report must name a root:\n${b.stdout}`);
      assert.equal(reportA.repo, resolve(first), 'the reported root must be the one --repo selected');
      assert.equal(reportB.repo, resolve(second), 'the reported root must be the one --repo selected');
      assert.notEqual(
        reportA.repo,
        reportB.repo,
        'two runs over two different roots must not report the same root',
      );

      // And it is the resolved path the gate used, not the argument it was
      // handed: spelled through a directory that does not exist and back out
      // again, so an echo of `args.repo` and the resolved root cannot be the
      // same string. `resolve` is lexical, so the missing segment is normalised
      // away before anything opens it.
      const detour = `${first}/nowhere/..`;
      const wobbly = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', detour]);
      assert.equal(wobbly.code, 0, `the same root spelled differently must still gate:\n${wobbly.stdout}`);
      const reportWobbly = JSON.parse(wobbly.stdout);
      assert.equal(reportWobbly.repo, resolve(first), 'the report must name the resolved root');
      assert.notEqual(reportWobbly.repo, detour, 'the report must not echo the argument as given');
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  // The sharper half of #381: the report must name the root the gate *used*, and
  // the one root a caller cannot read off their own command line is the fallback
  // one -- `repoRoot()`, four `..` segments counted by hand. It is also the way
  // `.github/workflows` and the skill documentation invoke this gate, and every
  // other `gate-evidence` test here supplies `--repo`, so without this test that
  // arm is executed by nothing.
  //
  // This test used to reach the fallback by writing `--repo` last and letting
  // #372's silent substitution carry it there, and its own note said to update
  // it to the new refusal rather than delete it when that defect was fixed.
  // Done: the argv below omits `--repo` altogether, which is the same branch at
  // `gate-evidence.mjs`'s `args.repo ? ... : repoRoot()` reached honestly, and
  // every claim the test made about the *report* is unchanged. The refusal it
  // used to depend on is asserted by `--repo with no value exits 2 rather than
  // falling back to the repository this script sits in` below.
  //
  // That the fallback root was genuinely read, and not merely named, is carried
  // by the policy: `acme-labs` has a reviewed profile only in the planted tree,
  // so any other root derives `long-tail`, contradicts the declared `pilot`, and
  // exits 2 with no report at all.
  test('with no --repo at all the evidence gate reports the fallback root it used', () => {
    const result = fallbackRepo(GATE_EVIDENCE, ({ dir }) => {
      mkdirSync(join(dir, 'tools', 'updater', 'profiles'), { recursive: true });
      writeFileSync(
        join(dir, 'tools', 'updater', 'profiles', 'acme.json'),
        JSON.stringify({ creator: { id: 'acme-labs' } }),
      );
      const bundle = join(dir, 'claims.json');
      writeFileSync(
        bundle,
        JSON.stringify({ runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] }, null, 2),
      );
      // No `--repo`, which is how the workflows and the skill docs call it.
      return ['--claims', bundle, '--today', TODAY, '--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.repo, 'string', `the report must name a root:\n${result.stdout}`);
    assert.equal(
      resolve(report.repo),
      result.root,
      `the report must name the fallback root the gate resolved for itself:\n${result.stdout}`,
    );
    assert.equal(report.policy, 'pilot', 'the fallback root must be the tree actually read');
    assert.equal(report.threshold, 2, 'and the threshold must follow from that tree');
  });

  // The reviewed-profile **directory**, in its three states (#312). **Absent** is
  // the test above, which cannot `readdirSync` it at all. **Present-but-stale**
  // is not a state it has: it is read once per run, straight from disk, and
  // nothing caches it -- the closest thing, a set that disagrees with this
  // checkout, is what `--repo` selects on purpose and is tested as such above.
  // **Unknown** is this test, and it is a genuinely different branch: the
  // directory reads fine and simply holds nothing that is a profile.
  //
  // The refusal must be the second one, not the first. A directory holding only
  // a README is readable, so the failure has to come from `holds no profiles`;
  // without that rule the gate loads an empty reviewed set and quietly
  // classifies every creator in the world as long-tail against nothing.
  // `long-tail` is declared here deliberately, so a pass could not be mistaken
  // for the declared/derived mismatch refusal firing instead.
  test('a reviewed-profile directory that exists but holds no profiles fails closed', () => {
    const sets = {
      'nothing at all': {},
      'a note nobody meant as a profile': { 'README.md': '# not a profile\n' },
      'only a dotfile': { '.hidden.json': { creator: { id: 'hidden-labs' } } },
      'only a directory': { generic: null },
    };
    for (const [description, entries] of Object.entries(sets)) {
      const repo = repoWithProfiles(entries);
      try {
        const result = gateBundle(
          { runId: 'r1', creator: 'acme-labs', policy: 'long-tail', claims: [claim()] },
          { repo },
        );
        assert.equal(result.code, 2, `${description}: an empty reviewed set must fail closed:\n${result.stdout}`);
        assert.ok(
          result.stdout.includes('holds no profiles'),
          `${description}: the refusal must be the empty-set one, not another:\n${result.stdout}`,
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  // A reviewed **profile** that is not valid JSON. Its siblings are all covered
  // below and none of them reaches this branch: a padded id, a duplicate id, a
  // `.JSON` case-variant and an invisible id all parse first. This one does not
  // parse at all, and the loader's stated contract -- "throws rather than
  // returning a partial set" -- is what makes it a refusal instead of a profile
  // that vanishes from the reviewed set with nobody told. A skipped profile is
  // the silent half: the creator it was written for becomes long-tail, and the
  // only symptom is a bundle refused for a policy mismatch it did not cause.
  test('a reviewed profile that is not valid JSON is refused, not skipped', () => {
    for (const [name, body] of Object.entries({
      truncated: '{"creator": {"id": "broken-labs"',
      'not json at all': 'creator: broken-labs\n',
      empty: '',
    })) {
      const repo = repoWithProfiles({
        'acme.json': { creator: { id: 'acme-labs' } },
        'broken.json': body,
      });
      try {
        const result = gateBundle(
          { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
          { repo },
        );
        assert.equal(result.code, 2, `${name}: an unparseable profile must be refused:\n${result.stdout}`);
        assert.ok(
          result.stdout.includes('broken.json'),
          `${name}: the refusal must name the document to fix:\n${result.stdout}`,
        );
        assert.ok(
          result.stdout.includes('not valid JSON'),
          `${name}: the refusal must say what is wrong with it:\n${result.stdout}`,
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  // -------------------------------------------------------------------------
  // The reviewed-set loader's own rules, brought level with the Python
  // ProfileLibrary that reads the same directory (#251, a named instance of the
  // drift #168 records). None of these lowers the bar for a genuinely long-tail
  // creator and none is reachable from a claim bundle -- each needs a malformed
  // profile committed to the repository. They are closed because two
  // implementations of one rule that disagree about what is valid will
  // eventually disagree about something that matters, and because a profile
  // skipped rather than refused makes a creator vanish from the reviewed set
  // without anyone being told.
  // -------------------------------------------------------------------------

  // A padded id is reachable by no lookup: the set is keyed by the exact declared
  // string, so a document declaring " acme-labs" answers only to " acme-labs" and
  // never to the id its author plainly meant. Admitting it loads a profile that
  // classifies nobody, and the creator it was written for is quietly long-tail.
  test('a reviewed profile whose creator.id is padded is refused, not admitted', () => {
    const repo = repoWithProfiles({ 'acme.json': { creator: { id: ' acme-labs ' } } });
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(result.code, 2, `a padded creator id must be refused: ${result.stdout}`);
      assert.ok(
        result.stdout.includes('whitespace'),
        `the refusal must name the padding, not something else:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes('acme.json'),
        `the refusal must name the document:\n${result.stdout}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Two documents answering to one id make the answer depend on which was read
  // last. The loader deduped them into a Set and said nothing, so whichever
  // profile lost was invisible. Ids differing only in case, or only in how they
  // space themselves, are one id to the reader this rule exists for.
  test('two reviewed profiles declaring one creator id are refused, not silently deduped', () => {
    const pairs = [
      ['acme-labs', 'acme-labs'],
      ['acme-labs', 'Acme-Labs'],
      ['acme labs', 'acme  labs'],
      ['acme labs', 'acme\u00a0labs'],
    ];
    for (const [left, right] of pairs) {
      for (const [first, second] of [[left, right], [right, left]]) {
        const repo = repoWithProfiles({
          'a.json': { creator: { id: first } },
          'b.json': { creator: { id: second } },
        });
        try {
          const result = gateBundle(
            { runId: 'r1', creator: first, policy: 'pilot', claims: [claim()] },
            { repo },
          );
          assert.equal(result.code, 2, `${first} / ${second}: a duplicate creator id must be refused: ${result.stdout}`);
          assert.ok(
            result.stdout.includes('duplicate'),
            `the refusal must say what is wrong:\n${result.stdout}`,
          );
          assert.ok(
            result.stdout.includes('a.json') && result.stdout.includes('b.json'),
            `the refusal must name both documents:\n${result.stdout}`,
          );
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      }
    }
  });

  // The platform-split case (#246). `.JSON` and `.json` are one file on Windows,
  // where every gate agent here runs, and two files on the Linux that CI runs.
  // Skipping the case-variant makes the two platforms disagree about what the
  // reviewed set contains; refusing makes them agree, loudly, on both. The
  // refusal is the rule `tools/updater` already applies to the same directory.
  test('a filename differing from .json only in case is refused, not silently skipped', () => {
    const repo = repoWithProfiles({
      'acme.json': { creator: { id: 'acme-labs' } },
      'other.JSON': { creator: { id: 'other-labs' } },
    });
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(result.code, 2, `a .JSON case-variant must be refused: ${result.stdout}`);
      assert.ok(
        result.stdout.includes('other.JSON'),
        `the refusal must name the file to rename:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes('case-sensitive'),
        `the refusal must say why the case matters:\n${result.stdout}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The refusal above has to stay narrow, or the suite only proves the gate went
  // paranoid. A neighbour nobody meant as a profile is ignored exactly as before:
  // a note, an extensionless file, a dotfile, and a directory -- including one
  // named as though it were a case-variant, because a directory was never a
  // document and refusing it would be the wrong answer to the wrong question.
  test('a neighbour that was never meant as a profile is still ignored', () => {
    const repo = repoWithProfiles({
      'acme.json': { creator: { id: 'acme-labs' } },
      'notes.md': '# not a profile\n',
      'README': 'not a profile either\n',
      '.hidden.json': { creator: { id: 'hidden-labs' } },
      'generic': null,
      'archive.JSON': null,
    });
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(result.code, 0, `only real profiles are candidates: ${result.stdout}`);
      assert.equal(JSON.parse(result.stdout).threshold, 2, 'acme-labs is the reviewed creator there');

      const hidden = gateBundle(
        { runId: 'r1', creator: 'hidden-labs', policy: 'long-tail', claims: [claim()] },
        { repo },
      );
      assert.equal(hidden.code, 0, `a dotfile is not part of the reviewed set: ${hidden.stdout}`);
      assert.equal(JSON.parse(hidden.stdout).threshold, 3, 'a dotfile profile classifies nobody as a pilot');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Fail-closed, stated as a property rather than as four anecdotes. These are
  // the four id values this repository has met that no reader can tell from
  // another: the empty string, and U+200B ZERO WIDTH SPACE, U+202E RIGHT-TO-LEFT
  // OVERRIDE and U+FEFF ZERO WIDTH NO-BREAK SPACE. Whether each is refused at
  // load or merely fails to classify differs -- JS `trim()` treats U+FEFF as
  // whitespace and Python's `strip()` does not, and neither treats the other two
  // as whitespace at all -- and the property deliberately does not care which.
  // What it pins is the one thing that must never happen: none of them may end
  // with the gate applying the looser pilot threshold to a creator the reviewed
  // set does not plainly name.
  test('an invisible or empty creator id never selects the pilot threshold', () => {
    const INVISIBLE = ['', '\u200b', '\u202e', '\ufeff'];
    const named = (id) => JSON.stringify(id);

    // The control, so a passing property is not just a harness that cannot pass.
    const clean = repoWithProfiles({ 'acme.json': { creator: { id: 'acme-labs' } } });
    try {
      const ok = gateBundle({ runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] }, { repo: clean });
      assert.equal(ok.code, 0, `the unmangled id is what a pilot looks like: ${ok.stdout}`);
      assert.equal(JSON.parse(ok.stdout).threshold, 2);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }

    const mangled = [];
    for (const ch of INVISIBLE) {
      mangled.push(ch, `${ch}acme-labs`, `acme-labs${ch}`);
    }
    for (const id of mangled) {
      if (id === 'acme-labs') continue;
      const repo = repoWithProfiles({ 'acme.json': { creator: { id } } });
      try {
        const result = gateBundle(
          { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
          { repo },
        );
        assert.notEqual(
          result.code,
          0,
          `a profile declaring ${named(id)} must not hand "acme-labs" the pilot bar: ${result.stdout}`,
        );
        if (result.code === 1) {
          assert.notEqual(
            JSON.parse(result.stdout).threshold,
            2,
            `a profile declaring ${named(id)} must not select the pilot threshold: ${result.stdout}`,
          );
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('gate-source-approval', () => {
  // The dataset the real repository stands behind, used as the anchor content.
  // The tests build their own git repository around it rather than gating this
  // checkout: the anchor is the merge base with `refs/remotes/origin/main`, and
  // a CI checkout has no such ref, so gating the ambient tree would make the
  // suite depend on how it was cloned. Seeding a scratch repository with the
  // real file keeps the anchor real and the test hermetic.
  const REAL_SOURCES = JSON.parse(readFileSync(join(DATA, 'sources.json'), 'utf8'));
  const REAL = REAL_SOURCES[0];
  const REAL_ORIGIN = new URL(REAL.url).origin;

  /** A source on a host nothing in the repository has ever stood behind. */
  const EVIL = {
    id: 'evil-source',
    url: 'https://contoso-model-notes.example/a',
    title: 'E',
    type: 'official-announcement',
    publisherId: 'p',
    lastCheckedDate: TODAY,
  };

  /**
   * A throwaway git repository, so the test never depends on this checkout.
   *
   * `publish` is the piece that matters: it points `refs/remotes/origin/main` at
   * the commit standing in for reviewed history. Everything committed after that
   * is history the run authored, and the gate must not treat it as trust.
   */
  function approvalRepo(build, bundle, extra = []) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-approval-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const publish = () => git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      const sources = join(dir, 'web', 'src', 'data', 'sources.json');
      const writeSources = (records) => writeFileSync(sources, JSON.stringify(records, null, 2));
      const commit = (message) => {
        git('add', '-A');
        git('commit', '-qm', message);
        return git('rev-parse', 'HEAD').trim();
      };
      build({ dir, git, sources, writeSources, commit, publish });
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      return run(GATE_SOURCE_APPROVAL, ['--claims', path, '--repo', dir, '--json', ...extra]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A bundle gated against the real dataset, committed and published. */
  function gateSources(bundle, extra = []) {
    return approvalRepo(
      ({ writeSources, commit, publish }) => {
        writeSources(REAL_SOURCES);
        commit('the reviewed dataset');
        publish();
      },
      bundle,
      extra,
    );
  }

  /** Evidence citing `sourceId`, read from `url`. */
  function evidence(sourceId, url) {
    return {
      sourceId,
      url,
      contentHash: HASH,
      fetchedAt: TODAY,
      quote: 'Today we are releasing this model to all API customers.',
      retrieval: 'fetch',
    };
  }

  /** A `sources` claim adding `id` at `url`, unanimously accepted by the panel. */
  function addSource(id, url) {
    return claim({
      id: `add-${id}`,
      kind: 'add',
      collection: 'sources',
      targetId: id,
      field: undefined,
      currentValue: null,
      proposedValue: {
        id,
        url,
        title: 'A source',
        type: 'official-announcement',
        publisherId: 'openai',
        lastCheckedDate: TODAY,
      },
      statement: `${url} is a primary source for this creator.`,
      evidence: [evidence(id, url)],
    });
  }

  test('a claim resting on a source already in the dataset passes', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(REAL.id, REAL.url)] })],
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.inheritedSources, [REAL.id]);
    assert.ok(report.anchors.approvedOrigins.length > 0, 'the gate must have a trust anchor');
  });

  // The probe that found this hole. Before this gate existed, exactly this
  // bundle produced `all gates passed over 105 records` and exit 0: a source
  // nobody approved, added and cited in the same run, satisfying referential
  // integrity the whole way. It is the load-bearing case in #167 and the reason
  // ADR 0003 holds this as a precondition rather than an accepted cost.
  test('a fabricated source on an unrelated domain, cited from a real release, is refused', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const result = gateSources({
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [
        addSource('contoso-model-notes', url),
        claim({ evidence: [evidence('contoso-model-notes', url)] }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.failures.some((failure) => failure.where === 'claim:openai-gpt-5-7-release-date#evidence[0]'),
      'the claim that cites the invented source must be named, not only the claim that adds it',
    );
  });

  // The gates run after review and cannot be outvoted (ADR 0003). A unanimous
  // panel is the strongest thing the run can produce, and it changes nothing.
  test('no panel majority can approve a source on an origin nobody stands behind', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const unanimous = [
      { reviewer: 'provenance', vote: 'accept', rationale: 'The page states it plainly.' },
      { reviewer: 'consistency', vote: 'accept', rationale: 'Agrees with the timeline.' },
      { reviewer: 'editorial', vote: 'accept', rationale: 'Entity boundary respected.' },
    ];
    const source = addSource('contoso-model-notes', url);
    const result = gateSources({
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [
        { ...source, verdicts: unanimous },
        claim({ evidence: [evidence('contoso-model-notes', url)], verdicts: unanimous }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
  });

  // The other direction, and the reason the rule is drawn at the origin rather
  // than at "no new source record". `sources.json` holds one entry per page, so
  // every new release announcement is a new source record. A rule that refused
  // those would refuse the refresh its entire purpose.
  test('a new page on an origin the dataset already stands behind is allowed', () => {
    const url = `${REAL_ORIGIN}/a-page-published-since-the-last-refresh`;
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [
        addSource('a-newly-announced-page', url),
        claim({ evidence: [evidence('a-newly-announced-page', url)] }),
      ],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).proposedSources, ['a-newly-announced-page']);
  });

  test('a claim citing a source that is neither in the dataset nor proposed is refused', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence('a-source-nobody-ever-added', REAL.url)] })],
    });
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // Without this, an approved id is just a label a run can staple onto any page
  // it likes, and the binding is decorative.
  test('evidence read from a different origin than the source it cites is refused', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(REAL.id, 'https://mirror-of-everything.example/page')] })],
    });
    assertFailed(result, 'source-approval', 'evidence must come from the source it cites');
  });

  test('repointing an approved source at a new origin is refused', () => {
    const url = 'https://contoso-model-notes.example/relocated';
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [
        claim({
          id: 'repoint-the-source',
          kind: 'change',
          collection: 'sources',
          targetId: REAL.id,
          field: 'url',
          currentValue: REAL.url,
          proposedValue: url,
          statement: 'The source moved.',
          evidence: [evidence(REAL.id, url)],
        }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
  });

  /** A throwaway git repository, so the test never depends on the real tree. */
  const scratchRepo = approvalRepo;

  // The whole gate turns on this. `sources.json` is a file the run is about to
  // write, so a gate that read it from disk could be satisfied by the run's own
  // uncommitted patch - which would not close the circle, only move it. The
  // anchor is the committed blob, and this proves it.
  test('a source written into the working tree does not approve itself', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('base');
        publish();
        // The run applies its own patch before the gate runs.
        writeSources([good, EVIL]);
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
    );
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // And the same attack one step further on, which is the one that matters most.
  // Patching the working tree was already refused; *committing* the source first
  // was not, back when the anchor defaulted to `HEAD` - the gate then read the
  // run's own commit and reported the fabricated source as inherited trust. The
  // anchor is the merge base with published history, so a commit on this branch
  // cannot move it, and no flag is needed to get this right.
  test('a source the run commits before gating is still not approved, with no --base given', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
        writeSources([good, EVIL]);
        commit('the run commits its own source, then calls the gate');
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
    );
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // `--base` exists to re-gate an older bundle, and may only ever narrow. A
  // required flag would not have been enough here: the agent under test supplies
  // it either way, so what is checked is the ref, not whether it was passed.
  test('--base cannot select a commit this branch authored', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
        writeSources([good, EVIL]);
        commit('the run commits its own source');
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
      // `HEAD` is the run's own commit, which is exactly the ref that must not
      // be selectable. It was the default until #167's review found it.
      ['--base', 'HEAD'],
    );
    assert.equal(result.code, 2, `a run-authored anchor must not be selectable:\n${result.stdout}`);
    assert.match(result.stdout, /may only narrow/);
  });

  test('--base may pin an older reviewed commit, and pins it for real', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const later = { id: 'later-source', url: 'https://later.example/a', title: 'L', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const build = ({ writeSources, commit, publish }) => {
      writeSources([good]);
      commit('the first reviewed commit');
      writeSources([good, later]);
      commit('a second reviewed commit');
      publish();
    };
    const cite = (id, url) => ({
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(id, url)] })],
    });

    const pinned = scratchRepo(build, cite(good.id, good.url), ['--base', 'HEAD~1']);
    assert.equal(pinned.code, 0, pinned.stdout);
    const report = JSON.parse(pinned.stdout);
    assert.equal(report.anchors.datasetSources, 1, 'the pinned anchor must be the older tree');
    assert.equal(report.anchor.requestedBase, 'HEAD~1');

    // Narrower means narrower: the source added in the *second* reviewed commit
    // is outside a pin at the first, so pinning cannot be turned into widening.
    const outside = scratchRepo(build, cite(later.id, later.url), ['--base', 'HEAD~1']);
    assertFailed(outside, 'source-approval', 'nothing approved it');
  });

  // The **unresolvable** state of `--base`, which is a different cell from the
  // two above: those supply a ref that resolves and is then judged against the
  // merge base, and this one supplies a ref that resolves to nothing at all. The
  // two are separated by distinct guards in `resolveAnchor`, and only the second
  // guard -- the ancestry one -- had a catcher here; a typo'd or stale ref went
  // straight past the first.
  //
  // The direction that matters is fail-open. `gate-scope.mjs` carries the same
  // function and states the hazard at its own copy of this test: "the dangerous
  // shape would be falling back to the computed anchor and passing". That is
  // precisely what an unguarded first branch does, and it is silent -- the run
  // reports `"passed": true` with `requestedBase: null`, so the operator who
  // typed the ref never learns it was ignored.
  //
  // The bundle is deliberately one that *would* pass at the computed anchor, so
  // a fallback would exit 0 rather than merely exiting differently. That is what
  // makes exit 2 here a claim about the guard and not about the bundle.
  test('--base naming a ref that does not exist exits 2 rather than falling back to the computed anchor', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(good.id, good.url)] })],
      },
      ['--base', 'no-such-ref'],
    );
    assert.equal(result.code, 2, `an unresolvable --base must not fall back:\n${result.stdout}`);
    assert.match(result.stdout, /--base no-such-ref is not a commit in this repository/);
  });

  // `--repo` in its **absent** state -- how `gate-source-approval.mjs` runs when
  // invoked without the flag, and the arm every test above skips, since they all
  // route through `approvalRepo` and always pass `--repo <scratch>`.
  //
  // The exit code alone cannot carry this claim, and neither can the dataset
  // anchor. A `repoRoot()` landing one directory short resolves to `.github`,
  // which exists and sits inside the same git repository -- and `datasetAnchor`
  // reads `git show <base>:web/src/data/sources.json`, whose path git resolves
  // from the top of the working tree no matter which subdirectory git was run
  // in. So a wrong-but-inside-the-repo root still finds the same sources.
  //
  // The profile catalogue is what separates them: `catalogAnchor` passes
  // `tools/updater/profiles` as a **pathspec**, which git resolves relative to
  // the directory it was run in. From the real root the catalogue is found; from
  // `.github` it matches nothing and is silently treated as absent, since an
  // absent catalogue is a tolerated state rather than an error. Asserting that
  // the catalogued origin was picked up therefore pins the resolved root itself.
  //
  // Neither origin appears in any real dataset, so this cannot pass by having
  // read some other repository either.
  test('with no --repo at all the approval gate falls back to the repository its own file sits in', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = fallbackRepo(GATE_SOURCE_APPROVAL, ({ dir, commit, publish }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'sources.json'), JSON.stringify([good], null, 2));
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the reviewed dataset and its catalogue');
      publish();
      const bundle = join(dir, 'claims.json');
      writeFileSync(bundle, JSON.stringify({
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(good.id, good.url)] })],
      }, null, 2));
      return ['--claims', bundle, '--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(
      report.anchors.profileCatalogues,
      1,
      `the fallback must resolve to the root the catalogue is read from, not to a directory inside it:\n${result.stdout}`,
    );
    // Sorted by the gate, so this is the whole set and not a subset.
    assert.deepEqual(
      report.anchors.approvedOrigins,
      [CATALOGUED, 'https://good.example'],
      'the fallback must anchor trust in the repository the script sits in, not in another tree',
    );
    assert.equal(report.anchors.datasetSources, 1, 'the fallback root must be the tree actually read');
  });

  // The identity field this block previously had to infer (#381). `--repo`
  // selects the root, and until now nothing in the report said which root that
  // was -- the test above pins it through `anchors.profileCatalogues`, a count,
  // precisely because there was no field naming the thing it cares about.
  //
  // The wrong root here is a real directory *inside the same git repository*,
  // which is the failure mode rather than an invented one. `datasetAnchor` reads
  // `git show <base>:web/src/data/sources.json`, a path git resolves from the
  // top of the working tree no matter which subdirectory it ran in, so the wrong
  // root finds the same dataset anchor. Both runs below exit 0 and both report
  // `passed: true`; measured on the same fixture, the reports differ in exactly
  // two fields, and one of them is an incidental count. Only `repo` answers
  // "which tree was this verdict about".
  test('the approval report names the root it resolved against, so a wrong root is visible in it', () => {
    const bundle = {
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(ANCHORED.id, ANCHORED.url)] })],
    };
    let root = null;
    let wrong = null;
    let wobbly = null;

    const right = approvalRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the reviewed dataset and its catalogue');
      publish();
      root = dir;

      const path = join(dir, 'inside.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      const at = (repo) => run(GATE_SOURCE_APPROVAL, ['--claims', path, '--repo', repo, '--json']);

      // A directory that exists and sits inside the same repository, which is
      // what a miscounted `repoRoot()` or a wrapper passing the wrong path lands
      // on. `.github` is exactly the directory one segment short resolves to.
      mkdirSync(join(dir, '.github'), { recursive: true });
      wrong = at(join(dir, '.github'));

      // The right root, spelled through a directory that does not exist and back
      // out again, so an echo of the argument and the resolved path cannot be
      // the same string. `resolve` is lexical, so nothing opens the gap.
      wobbly = at(`${dir}/nowhere/..`);
    }, bundle);

    assert.equal(right.code, 0, `the right root must be gateable:\n${right.stdout}`);
    assert.equal(wrong.code, 0, `the wrong root exits 0 too, which is the whole problem:\n${wrong.stdout}`);
    assert.equal(wobbly.code, 0, `the same root spelled differently must still gate:\n${wobbly.stdout}`);

    const rightReport = JSON.parse(right.stdout);
    const wrongReport = JSON.parse(wrong.stdout);
    assert.equal(typeof rightReport.repo, 'string', `the report must name a root:\n${right.stdout}`);
    assert.equal(typeof wrongReport.repo, 'string', `the report must name a root:\n${wrong.stdout}`);
    assert.equal(rightReport.repo, resolve(root), 'the reported root must be the one --repo selected');
    assert.equal(
      wrongReport.repo,
      resolve(join(root, '.github')),
      'a run over the wrong root must say so rather than reporting the tree it accidentally read from',
    );
    assert.notEqual(
      rightReport.repo,
      wrongReport.repo,
      'two runs over two different roots must not report the same root',
    );

    // The verdict cannot separate them, which is why the field is needed.
    assert.equal(rightReport.passed, true);
    assert.equal(wrongReport.passed, true);
    // And the two really did read different trees: only the right root's
    // catalogue pathspec matched.
    assert.equal(rightReport.anchors.profileCatalogues, 1, 'the right root reads its catalogue');
    assert.equal(wrongReport.anchors.profileCatalogues, 0, 'the wrong root silently reads none');

    const wobblyReport = JSON.parse(wobbly.stdout);
    assert.equal(wobblyReport.repo, resolve(root), 'the report must name the resolved root');
    assert.notEqual(wobblyReport.repo, `${root}/nowhere/..`, 'the report must not echo the argument as given');
  });

  // The fallback arm of the same field, and the one place the reported root
  // cannot be an echo of anything: with no `--repo` at all the gate resolves its
  // own location, and the report has to name the root it arrived at. Without
  // this, a `repo` field spelled `args.repo` rather than the resolved root would
  // report `null` here and every test above would still pass.
  //
  // The fixture is the one directly above this block, on purpose: that test
  // proves the fallback landed on the right root by way of the catalogue count,
  // and this one asserts the same fact directly, which is what #381 makes
  // possible. Both are kept -- the count is a separate claim, and #344 is open
  // on how it is computed.
  test('with no --repo at all the approval report names the fallback root it used', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = fallbackRepo(GATE_SOURCE_APPROVAL, ({ dir, commit, publish }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'sources.json'), JSON.stringify([good], null, 2));
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the reviewed dataset and its catalogue');
      publish();
      const bundle = join(dir, 'claims.json');
      writeFileSync(bundle, JSON.stringify({
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(good.id, good.url)] })],
      }, null, 2));
      return ['--claims', bundle, '--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.repo, 'string', `the report must name a root:\n${result.stdout}`);
    assert.equal(
      resolve(report.repo),
      result.root,
      `the report must name the fallback root the gate resolved for itself:\n${result.stdout}`,
    );
    assert.equal(report.anchors.profileCatalogues, 1, 'and that root must be the tree actually read');
  });

  test('a repository with no published main cannot be gated', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit }) => {
        writeSources([good]);
        commit('a base nobody published');
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim({ evidence: [evidence(good.id, good.url)] })] },
    );
    assert.equal(result.code, 2, `no published history means the gate cannot run:\n${result.stdout}`);
    assert.match(result.stdout, /cannot resolve refs\/remotes\/origin\/main/);
  });

  test('an anchor commit with no dataset file at all exits 2 rather than passing', () => {
    const result = scratchRepo(
      ({ commit, publish }) => {
        commit('no dataset here');
        publish();
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim()] },
    );
    assert.equal(result.code, 2, `a gate with no trust anchor must not report success:\n${result.stdout}`);
    assert.match(result.stdout, /cannot read web\/src\/data\/sources\.json/);
  });

  // Distinct from the above, and reached only when the file parses: a dataset
  // that is present but stands behind nothing leaves the gate with an empty
  // approved set, which would otherwise refuse every citation for a reason that
  // has nothing to do with the citation.
  test('an anchor that yields no approved origin exits 2 rather than refusing everything', () => {
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([]);
        commit('a dataset standing behind nothing');
        publish();
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })] },
    );
    assert.equal(result.code, 2, `an empty anchor is not a verdict:\n${result.stdout}`);
    assert.match(result.stdout, /no approved origin at/);
  });

  // -------------------------------------------------------------------------
  // The **second** trust anchor: `tools/updater/profiles/**` `source_catalog`.
  //
  // Until now no test in this block reached it. `approvalRepo` never creates
  // `tools/updater/profiles`, so `catalogAnchor` returned an empty set in every
  // case and the whole function could have been deleted outright without the
  // suite noticing -- which is precisely the "one covered case reads as a
  // covered axis" pattern #312 exists to stop, with the dataset anchor's own
  // absent/unknown/stale tests above standing in for it.
  //
  // What the two tests below cover, and what they do not. The happy path is
  // stated separately from the axis, because it is not one of the three states:
  //
  //   present -- at the anchor commit, the first test below. Not an axis cell;
  //              it is the control that proves the anchor is read at all, and
  //              without it the two cells beneath could both pass vacuously.
  //              Trust attaches to the origin, so a new page on a catalogued
  //              origin is admissible.
  //
  //   absent  -- every other test in this block, which is why the dataset anchor
  //              carries them alone; the gate reports `profileCatalogues: 0`.
  //   unknown -- **not covered, and not N/A.** A catalogue that is present at
  //              the anchor but unparseable is swallowed by the `catch { continue }`
  //              in `catalogAnchor` (`gate-source-approval.mjs:257`) and skipped
  //              with nobody told, so a typo silently narrows the trust boundary
  //              instead of refusing. It fails closed, which is why it is left
  //              open here rather than closed with the rest, but it is a real
  //              gap and is recorded as one on #312 -- not a state this input
  //              lacks. Do not read the two tests below as covering it.
  //   stale   -- present, but not at the anchor: only in the working tree, or
  //              committed by this branch after it left published history. The
  //              second test below. This is the cell that fails open.
  // -------------------------------------------------------------------------

  /** A source on an origin the dataset anchor stands behind, so it is not the one under test. */
  const ANCHORED = {
    id: 'anchored-source',
    url: 'https://good.example/a',
    title: 'G',
    type: 'official-announcement',
    publisherId: 'p',
    lastCheckedDate: TODAY,
  };

  /** An origin only a reviewed profile catalogue ever stands behind. */
  const CATALOGUED = 'https://catalogued.example';

  function writeCatalogue(dir, url) {
    mkdirSync(join(dir, 'tools', 'updater', 'profiles'), { recursive: true });
    writeFileSync(
      join(dir, 'tools', 'updater', 'profiles', 'acme.json'),
      JSON.stringify({ creator: { id: 'acme-labs' }, source_catalog: [{ url }] }, null, 2),
    );
  }

  test('a reviewed profile catalogue at the anchor is a trust anchor in its own right', () => {
    const result = scratchRepo(
      ({ dir, writeSources, commit, publish }) => {
        writeSources([ANCHORED]);
        writeCatalogue(dir, `${CATALOGUED}/newsroom`);
        commit('the reviewed dataset and its catalogue');
        publish();
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        // A *different page* on the catalogued origin. Trust attaches to the
        // origin, so a creator announcing on a new page of its own newsroom is
        // the ordinary case and the whole point of the refresh.
        claims: [addSource('acme-launch', `${CATALOGUED}/launch`)],
      },
    );
    assert.equal(result.code, 0, `a catalogued origin is inherited trust:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.anchors.profileCatalogues, 1, 'the catalogue must actually have been read');
    assert.ok(
      report.anchors.approvedOrigins.includes(CATALOGUED),
      `the catalogued origin must be approved:\n${result.stdout}`,
    );
    // And it came from the catalogue rather than from the dataset: the anchor
    // tree holds exactly one source, on a different origin. Without this the
    // test would pass on the dataset anchor alone.
    assert.equal(report.anchors.datasetSources, 1, 'the dataset anchor holds only the unrelated source');
    assert.equal(report.inheritedSources.length, 0, 'nothing here was inherited from sources.json');
  });

  // The mirror of `a source written into the working tree does not approve
  // itself`, for the other anchor -- and the fail-open half of this input. A run
  // that could write itself a catalogue would extend the trust boundary to any
  // host it liked, which is exactly what ADR 0003 keeps as a human act.
  //
  // `gate-scope.mjs` refuses any change touching `tools/updater/`, so in the
  // pipeline this is barred twice. That is not a reason to leave it untested: a
  // gate that is only closed because another one runs first is not closed, and
  // this file already states that rule for the claim-shape checks above.
  test('a profile catalogue this run wrote, rather than inherited, approves nothing', () => {
    const bundle = {
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [addSource('acme-launch', `${CATALOGUED}/launch`)],
    };

    // Written into the working tree, never committed.
    const onDisk = scratchRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      commit('the reviewed base');
      publish();
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
    }, bundle);
    assertFailed(onDisk, 'source-approval', 'a run cannot approve its own source');
    const onDiskReport = JSON.parse(onDisk.stdout);
    assert.equal(onDiskReport.anchors.profileCatalogues, 0, 'an uncommitted catalogue is not at the anchor');
    assert.ok(
      !onDiskReport.anchors.approvedOrigins.includes(CATALOGUED),
      `an uncommitted catalogue must not widen the trust boundary:\n${onDisk.stdout}`,
    );

    // And one step further on, which is the half that survived the equivalent
    // dataset-anchor bug: committed by this branch *after* it left published
    // history. Committing moves HEAD and never the merge base, so this buys the
    // run nothing either.
    const committed = scratchRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      commit('the reviewed base');
      publish();
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the run commits its own catalogue, then calls the gate');
    }, bundle);
    assertFailed(committed, 'source-approval', 'a run cannot approve its own source');
    assert.equal(
      JSON.parse(committed.stdout).anchors.profileCatalogues,
      0,
      'a catalogue committed on this branch is not at the merge base',
    );
  });

  // Malformed shapes are refused, not skipped. A missing `sourceId` already
  // refuses, so a missing `evidence` that silently passed would make absence the
  // most permissive input in a gate about what a run leaves out. `gate-evidence`
  // refuses these too, but relying on that would make this gate closed only
  // while the two are run in a particular order.
  test('a bundle that is not a claim bundle object cannot be gated', () => {
    for (const notABundle of ['a string', 42, null, ['an', 'array']]) {
      const result = gateSources(notABundle);
      assert.equal(result.code, 2, `${JSON.stringify(notABundle)} is not a bundle, and is not a pass`);
    }
  });

  test('a bundle with no claims array cannot be gated', () => {
    const result = gateSources({ runId: 'r1', creator: 'someone', policy: 'pilot' });
    assert.equal(result.code, 2, `a bundle with no claims is not a pass:\n${result.stdout}`);
  });

  test('a claim that is not an object is refused rather than skipped', () => {
    const result = gateSources({ runId: 'r1', creator: 'someone', policy: 'pilot', claims: ['not a claim'] });
    assertFailed(result, 'source-approval', 'is not a claim object');
  });

  test('a claim with no evidence array is refused rather than skipped', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: undefined })],
    });
    assertFailed(result, 'source-approval', 'has no evidence array');
  });

  test('evidence entries that are not objects are refused rather than skipped', () => {
    for (const notEvidence of ['https://openai.com/index/gpt-5-7/', null, 7, ['x']]) {
      const result = gateSources({
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [notEvidence] })],
      });
      assertFailed(result, 'source-approval', 'rather than an evidence object');
    }
  });

  // ADR 0003's "no escape hatch" guardrail, as a test rather than as a promise.
  test('there is no flag that lets a refused bundle through', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const bundle = {
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [addSource('contoso-model-notes', url), claim({ evidence: [evidence('contoso-model-notes', url)] })],
    };
    for (const flag of ['--force', '--skip', '--skip-gates', '--yes']) {
      const result = gateSources(bundle, [flag]);
      assert.equal(result.code, 2, `${flag} must not be recognised, and must never be a pass`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('gate-scope', () => {
  // The path #210 reproduced against: a reviewed updater profile. It is absent
  // from ALLOWED_PATHS, which is the only thing making the profiles unforgeable,
  // so it is the right file to prove the gate still refuses.
  const OUT_OF_CLASS = 'tools/updater/profiles/anthropic.json';

  function writeOutOfClass(dir, body = '{"id":"anthropic"}\n') {
    mkdirSync(join(dir, 'tools', 'updater', 'profiles'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'updater', 'profiles', 'anthropic.json'), body);
  }

  /**
   * A throwaway git repository, so the test never depends on the real tree's
   * state. `body` gets the directory, a `git`, and a `gate` that runs the gate
   * against it.
   *
   * `publish` writes `refs/remotes/origin/main`, which is where the gate computes
   * its anchor from. A real clone gets that ref from the remote; setting it here
   * explicitly is what lets a test say which commit counts as reviewed - and
   * omitting it is a degraded case in its own right, not an oversight.
   */
  function withScratchRepo(body, { publish = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-scope-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[]');
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      if (publish) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return body({
        dir,
        git,
        gate: (...args) => run(GATE_SCOPE, ['--repo', dir, ...args]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The common shape: build a state, then gate it as JSON. */
  function scratchRepo(build, extraArgs = []) {
    return withScratchRepo(({ dir, git, gate }) => {
      build({ dir, git });
      return gate('--json', ...extraArgs);
    });
  }

  test('a dataset-only change is in class', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.inClass, ['web/src/data/releases.json']);
  });

  test('a schema change alongside a dataset change disqualifies the whole thing', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      writeFileSync(join(dir, 'web', 'src', 'data', 'schema.ts'), 'export const x = 1;\n');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['web/src/data/schema.ts']);
  });

  test('an untracked new file cannot sneak past by never being added', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['sneaky.mjs']);
  });

  test('a same-named data file outside web/src/data does not qualify', () => {
    const result = scratchRepo(({ dir }) => {
      mkdirSync(join(dir, 'elsewhere'), { recursive: true });
      writeFileSync(join(dir, 'elsewhere', 'releases.json'), '[]');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['elsewhere/releases.json']);
  });

  // -------------------------------------------------------------------------
  // The three-state table from #210. One test per row. The same out-of-class
  // edit is gated uncommitted, committed, and committed with an explicit
  // `--base`; every row must refuse.
  //
  // Each row asserts the **message**, not just the exit code. The broken gate
  // got rows A and C right, so a suite that checked `code === 1` on those and
  // `code === 0` on B would have passed against it in full. Row B's bug is a
  // *wrong success*, and the only thing that distinguishes it from a real pass
  // is what the gate said it examined.
  // -------------------------------------------------------------------------

  test('State A - an uncommitted out-of-class change is refused', () => {
    const result = withScratchRepo(({ dir, gate }) => {
      writeOutOfClass(dir);
      return gate();
    });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
  });

  test('State B - the same change, committed, is refused with no flag passed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      // The precondition that used to blind the gate: nothing left on disk.
      assert.equal(git('status', '--porcelain').trim(), '', 'the working tree must be clean here');
      return gate();
    });
    assert.equal(result.code, 1, `a committed out-of-class change must be refused:\n${result.stdout}`);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
    // The exact wrong success this issue is about. Exit 1 alone would not catch a
    // regression that reported absence of work while examining nothing.
    assert.doesNotMatch(result.stdout, /nothing changed/);
    assert.doesNotMatch(result.stdout, /nothing to publish/);
  });

  test('State C - the same commit with --base origin/main is still refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'origin/main');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
  });

  test('a change split across a commit and the working tree is reported whole', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'half of it');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      return gate('--json');
    });
    assert.equal(result.code, 1, result.stdout);
    // Committed and uncommitted halves both present: neither mode replaced the
    // other, which is what keeps AC 4 and AC 7 from trading off.
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['sneaky.mjs', OUT_OF_CLASS]);
  });

  // The scenario named on the issue, in the fixture shape the sibling schema test
  // already established. `empty` is the assertion target rather than the exit code
  // because it is the observable signature of the blind state: on `main` this same
  // callback yields `empty: true`, and a naive fix could exit 1 for another reason
  // while still reporting the tree as empty.
  test('a committed schema change is not empty, which is what the blind state claimed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'schema.ts'), 'export const x = 1;\n');
      git('add', '-A');
      git('commit', '-qm', 'schema change, committed');
      assert.equal(git('status', '--porcelain').trim(), '', 'the working tree must be clean here');
      return gate('--json');
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.empty, false, 'a committed change must never be reported as an empty tree');
    assert.deepEqual(report.outOfClass, ['web/src/data/schema.ts']);
    assert.equal(result.code, 1, result.stdout);
  });

  // The pair below is the proof, and neither half carries it alone. This one
  // shows empty-means-empty; the `empty: false` assertion in the committed test
  // above shows committed-does-not-mean-empty. Restored verbatim from `main`
  // rather than rewritten: exit 0 on a genuinely empty tree is the correct
  // answer and a fix that broke this test would be the wrong fix.
  test('a clean tree reports nothing to publish rather than passing silently', () => {
    const result = scratchRepo(() => {});
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).empty, true);
  });

  test('nothing changed is a finding about the anchor, not a fallthrough', () => {
    const result = withScratchRepo(({ gate }) => ({ text: gate(), json: gate('--json') }));
    assert.equal(result.text.code, 0, result.text.stdout);
    // It has to say what it established, so a reader can tell this apart from the
    // gate having looked in the wrong place.
    assert.match(result.text.stdout, /nothing changed since [0-9a-f]{10} and the working tree is clean/);
    assert.equal(JSON.parse(result.json.stdout).empty, true);
  });

  test('the anchor is reported as a resolved commit, not as the flag that was passed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      return { report: JSON.parse(gate('--json').stdout), head: git('rev-parse', 'HEAD').trim() };
    });
    assert.match(result.report.base, /^[0-9a-f]{40}$/);
    assert.equal(result.report.base, result.head, 'the anchor is the merge base, here HEAD');
    assert.equal(result.report.anchor.publishedRef, 'refs/remotes/origin/main');
    assert.equal(result.report.anchor.requestedBase, null);
    // Byte-identical to gate-source-approval.mjs's, because #168 is open on the
    // absence of drift detection between the two and this is where drift starts.
    assert.equal(result.report.anchor.selectedBy, 'merge-base with refs/remotes/origin/main');
  });

  // The fourth half of the working-tree question, and the one #210's three-state
  // table did not reach (#312). `changedPaths` asks four things and unions the
  // answers: the committed diff, the unstaged diff, the **staged** diff, and
  // untracked files. Three have tests -- committed is State B above, unstaged is
  // the dataset-only and schema-change tests, untracked is the sneaky-file test.
  // Staged-but-not-committed had none, because every `git add` in this block is
  // followed immediately by a commit, which moves the change into the first
  // question and out of this one.
  //
  // It is invisible to all three siblings by construction, which is why none of
  // them covers it: `git add` puts the file in the index, so `ls-files --others`
  // stops listing it; the worktree then matches the index, so the unstaged diff
  // is empty; and nothing is committed, so `<anchor>...HEAD` is empty too. Only
  // `--cached` sees it. Dropping that one line makes the gate report
  // `empty: true` and exit 0 over an out-of-class change -- the same wrong
  // success as #210, on a different half of the same input, which is why `empty`
  // is asserted here rather than only the exit code.
  test('State D - a staged but uncommitted out-of-class change is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      // The preconditions that isolate this half. Without them the test could
      // pass on the strength of one of the three siblings instead.
      assert.equal(
        git('status', '--porcelain').trim(),
        `A  ${OUT_OF_CLASS}`,
        'the change must be staged, and only staged',
      );
      assert.equal(git('diff', '--name-only').trim(), '', 'nothing may be left unstaged');
      assert.equal(git('ls-files', '--others', '--exclude-standard').trim(), '', 'nothing may be left untracked');
      assert.equal(git('rev-list', '--count', 'refs/remotes/origin/main..HEAD').trim(), '0', 'nothing may be committed');
      return gate('--json');
    });
    assert.equal(result.code, 1, `a staged out-of-class change must be refused:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.empty, false, 'a staged change must never be reported as an empty tree');
    assert.deepEqual(report.outOfClass, [OUT_OF_CLASS]);
  });

  // -------------------------------------------------------------------------
  // `--base` may only narrow. The flag is supplied by the agent under test, so
  // it must never be able to select a commit this branch authored.
  // -------------------------------------------------------------------------

  test('--base HEAD cannot be used to hide what this branch committed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'HEAD');
    });
    assert.equal(result.code, 2, `widening --base must exit 2, not pass:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
    assert.match(result.stdout, /may only narrow/);
  });

  // The rest of the widening set #167's review proved out by execution on
  // `gate-source-approval.mjs`. Kept in step deliberately: #168 is open because
  // nothing detects drift between the two gates, and a rejection this gate
  // accepts while the other refuses is exactly that drift. Every one exits 2
  // with no fallback - never 0, and never a quiet reversion to the merge base.
  test('--base pointing at a post-merge-base commit that is not HEAD is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'first branch commit');
      const middle = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'second branch commit');
      return gate('--base', middle);
    });
    assert.equal(result.code, 2, `a mid-branch commit must not become the anchor:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base pointing at a tag on a branch commit is refused, not resolved past', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      // An annotated tag: `^{commit}` peels it, so the check runs on the commit
      // it names rather than being sidestepped by the object type.
      git('tag', '-a', 'v-branch', '-m', 'tag on a branch commit');
      return gate('--base', 'v-branch');
    });
    assert.equal(result.code, 2, `a tag naming a branch commit must not widen:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base pointing at a sibling branch tip is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      git('checkout', '-q', '-b', 'sibling');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'sibling work');
      const siblingTip = git('rev-parse', 'HEAD').trim();
      git('checkout', '-q', '-');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', siblingTip);
    });
    assert.equal(result.code, 2, `a sibling tip is not inherited trust:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base naming a ref that does not exist exits 2 rather than falling back', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'no-such-ref');
    });
    // The dangerous shape would be falling back to the computed anchor and
    // passing, or worse to the working tree. Neither: it refuses to run.
    assert.equal(result.code, 2, `an unresolvable --base must not fall back:\n${result.stdout}`);
    assert.match(result.stdout, /--base no-such-ref is not a commit in this repository/);
  });

  test('--base may pin an older reviewed commit, and still sees the later change', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      const first = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'README.md'), 'scratch, reviewed\n');
      git('add', '-A');
      git('commit', '-qm', 'second reviewed commit');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return { pinned: gate('--json', '--base', first), first };
    });
    assert.equal(result.pinned.code, 1, result.pinned.stdout);
    const report = JSON.parse(result.pinned.stdout);
    assert.equal(report.anchor.commit, result.first, 'the pinned ancestor is the anchor');
    // Narrowing widens the diff, so it can only ever add refusals.
    assert.deepEqual(report.outOfClass, ['README.md', OUT_OF_CLASS]);
  });

  test('--base with no value exits 2 rather than swallowing the next argument', () => {
    const result = withScratchRepo(({ gate }) => gate('--base'));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /--base needs a value/);
  });

  // `--repo` in its **absent** state, which is how `.github/workflows` and the
  // skill documentation invoke this gate, and the one input cell no test above
  // reaches: `withScratchRepo`'s `gate` always passes `--repo <scratch>`, so
  // `repoRoot()` -- four `..` segments counted by hand -- was executed by
  // nothing.
  //
  // Asserting the resolved root, and not just the exit code, is the point. The
  // ordinary way this line breaks is a miscounted segment, and one segment short
  // resolves to `.github`: a directory that exists, and one that git happily
  // answers from because it walks up to the enclosing repository. The gate would
  // then exit 0 having measured a tree nobody asked about. Only the reported
  // root separates that from the correct answer.
  //
  // Per the note on `fallbackRepo`, this is a claim about location alone -- no
  // commit and no dataset content is asserted -- so it cannot rot as the
  // repository changes.
  test('with no --repo at all the scope gate falls back to the repository its own file sits in', () => {
    const result = fallbackRepo(GATE_SCOPE, ({ dir, commit, publish }) => {
      commit('base');
      publish();
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      return ['--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(
      resolve(report.repo),
      result.root,
      'the fallback must resolve to the repository the script sits in, not to a neighbour of it',
    );
    assert.deepEqual(
      report.inClass,
      ['web/src/data/releases.json'],
      'the fallback root must be the tree actually measured, not just the one named',
    );
  });

  // -------------------------------------------------------------------------
  // Degraded anchors. A gate that cannot establish what changed exits 2; it
  // never exits 0. A missing ref that passed would be a worse bug than the one
  // this replaces.
  // -------------------------------------------------------------------------

  test('a repository with no refs/remotes/origin/main refuses rather than passing', () => {
    const result = withScratchRepo(({ dir, gate }) => {
      writeOutOfClass(dir);
      return gate();
    }, { publish: false });
    assert.equal(result.code, 2, `a missing published ref must not pass:\n${result.stdout}`);
    assert.match(result.stdout, /cannot resolve refs\/remotes\/origin\/main/);
  });

  test('a clean tree with no refs/remotes/origin/main still refuses, so absence never reads as a pass', () => {
    const result = withScratchRepo(({ gate }) => gate(), { publish: false });
    assert.equal(result.code, 2, `an unresolvable anchor must never exit 0:\n${result.stdout}`);
    assert.match(result.stdout, /fetch main before gating/);
  });

  test('a HEAD sharing no history with the published ref refuses', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      git('checkout', '-q', '--orphan', 'unrelated');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'unrelated root');
      return gate();
    });
    assert.equal(result.code, 2, `an unrelated history must not pass:\n${result.stdout}`);
    assert.match(result.stdout, /shares no history with refs\/remotes\/origin\/main/);
  });

  test('a stale published ref only moves the anchor backwards, which adds refusals', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      // origin/main stays at the first commit while the branch moves on twice.
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      git('add', '-A');
      git('commit', '-qm', 'dataset change, already on main upstream');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--json');
    });
    assert.equal(result.code, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    // Everything since the stale anchor, which is a superset of what a current
    // ref would have shown. Staleness costs precision, never safety.
    assert.deepEqual(report.outOfClass, [OUT_OF_CLASS]);
    assert.deepEqual(report.inClass, ['web/src/data/releases.json']);
  });

  test('an unknown flag exits 2 rather than being ignored', () => {
    const result = withScratchRepo(({ gate }) => gate('--force'));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /unknown flag --force/);
  });
});

// ---------------------------------------------------------------------------

// gate-scope's ALLOWED_PATHS and raw.ts's JSON imports are a hand-maintained
// mirror: the gate permits a refresh to touch exactly the documents raw.ts
// composes. Nothing enforced that they stay equal, and #237 records that the
// dangerous direction fails open - ALLOWED_PATHS keeping a path raw.ts no longer
// imports lets the gate wave through a write to a file that has left the reviewed
// dataset surface. This block derives both sides from their source files and
// asserts set equality, naming any path and the side it is missing from.
//
// Both sides are DERIVED, never restated: no filename or count from either file
// appears here as a literal. The comparison logic (`diffAllowedPaths`) is unit-
// tested below against synthetic sources that disagree in each direction, so it
// is proved able to fail without perturbing the committed files - which is also
// why deriving the real expectation is not a tautology: a wrong ALLOWED_PATHS
// value would change one derived set but not the other, and the diff would fire.
describe('gate-scope ALLOWED_PATHS mirrors raw.ts', () => {
  const RAW_TS = join(REPO, 'web', 'src', 'data', 'raw.ts');
  const DATA_PREFIX = 'web/src/data/';

  // Fails closed: a source that cannot be read or from which no set can be
  // extracted throws, and every caller turns that into a refusal rather than an
  // empty set that would spuriously compare equal to another empty set.
  function readOrRefuse(file) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message}`);
    }
    if (text.length === 0) throw new Error(`${file} is empty`);
    return text;
  }

  // The repo-relative paths named inside `const ALLOWED_PATHS = new Set([ ... ])`.
  // Extracts the array body by brackets, then every single- or double-quoted
  // string in it. Refuses if the declaration is absent or names nothing.
  function allowedPathsFrom(source) {
    const decl = /const\s+ALLOWED_PATHS\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/.exec(source);
    if (!decl) throw new Error('no ALLOWED_PATHS = new Set([...]) declaration found');
    const paths = [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (paths.length === 0) throw new Error('ALLOWED_PATHS declaration names no paths');
    return new Set(paths);
  }

  // The JSON documents raw.ts imports, resolved to their repo-relative paths.
  // Only `.json` imports count - raw.ts imports nothing else, and a non-JSON
  // import would not be a dataset document. Refuses if there are none.
  function rawImportsFrom(source) {
    const specs = [...source.matchAll(/import\s+[^;]*?\bfrom\s+['"](\.\/[^'"]+\.json)['"]/g)]
      .map((m) => m[1].replace(/^\.\//, DATA_PREFIX));
    if (specs.length === 0) throw new Error('raw.ts imports no .json documents');
    return new Set(specs);
  }

  // The directional diff #237 asks for: what only the gate allows, and what only
  // raw.ts composes. Returned as sorted arrays so a failure message is stable.
  function diffAllowedPaths(allowed, imported) {
    return {
      onlyInAllowed: [...allowed].filter((p) => !imported.has(p)).sort(),
      onlyInRaw: [...imported].filter((p) => !allowed.has(p)).sort(),
    };
  }

  function describeDrift({ onlyInAllowed, onlyInRaw }) {
    const parts = [];
    if (onlyInAllowed.length > 0) {
      parts.push(`allowed by gate-scope but not composed by raw.ts: ${onlyInAllowed.join(', ')}`);
    }
    if (onlyInRaw.length > 0) {
      parts.push(`composed by raw.ts but not allowed by gate-scope: ${onlyInRaw.join(', ')}`);
    }
    return parts.join('; ');
  }

  test('the live ALLOWED_PATHS and raw.ts imports are equal as sets', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    const imported = rawImportsFrom(readOrRefuse(RAW_TS));
    const drift = diffAllowedPaths(allowed, imported);
    assert.deepEqual(
      drift,
      { onlyInAllowed: [], onlyInRaw: [] },
      `gate-scope ALLOWED_PATHS and raw.ts imports have drifted - ${describeDrift(drift)}`,
    );
  });

  test('drift is detected and named when raw.ts drops a path the gate still allows', () => {
    const allowed = new Set(['web/src/data/a.json', 'web/src/data/b.json']);
    const imported = new Set(['web/src/data/a.json']);
    const drift = diffAllowedPaths(allowed, imported);
    assert.deepEqual(drift.onlyInAllowed, ['web/src/data/b.json']);
    assert.deepEqual(drift.onlyInRaw, []);
    assert.match(describeDrift(drift), /allowed by gate-scope but not composed by raw\.ts: web\/src\/data\/b\.json/);
  });

  test('drift is detected and named when raw.ts adds a path the gate does not allow', () => {
    const allowed = new Set(['web/src/data/a.json']);
    const imported = new Set(['web/src/data/a.json', 'web/src/data/c.json']);
    const drift = diffAllowedPaths(allowed, imported);
    assert.deepEqual(drift.onlyInRaw, ['web/src/data/c.json']);
    assert.deepEqual(drift.onlyInAllowed, []);
    assert.match(describeDrift(drift), /composed by raw\.ts but not allowed by gate-scope: web\/src\/data\/c\.json/);
  });

  test('the ALLOWED_PATHS derivation actually reads the gate source', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    // A lower bound stated as a literal count would restate the file; instead we
    // only assert non-empty, and prove the parser's shape against a synthetic
    // source below.
    assert.ok(allowed.size > 0);
    for (const p of allowed) assert.ok(p.startsWith(DATA_PREFIX), `unexpected allowed path ${p}`);
  });

  test('allowedPathsFrom extracts exactly the quoted paths in the Set literal', () => {
    const source = "const ALLOWED_PATHS = new Set([\n  'web/src/data/x.json',\n  \"web/src/data/y.json\",\n]);\n";
    assert.deepEqual([...allowedPathsFrom(source)].sort(), ['web/src/data/x.json', 'web/src/data/y.json']);
  });

  test('rawImportsFrom resolves ./ JSON specifiers and ignores non-JSON imports', () => {
    const source = "import a from './a.json';\nimport b from './b.json';\nimport { z } from './helper.ts';\n";
    assert.deepEqual([...rawImportsFrom(source)].sort(), ['web/src/data/a.json', 'web/src/data/b.json']);
  });

  test('both derivations fail closed rather than returning an empty set', () => {
    assert.throws(() => allowedPathsFrom('const OTHER = 1;'), /no ALLOWED_PATHS/);
    assert.throws(() => allowedPathsFrom('const ALLOWED_PATHS = new Set([]);'), /names no paths/);
    assert.throws(() => rawImportsFrom('export const x = 1;'), /imports no \.json/);
    assert.throws(() => readOrRefuse(join(REPO, 'no', 'such', 'file.xyz')), /cannot read/);
  });
});

// ---------------------------------------------------------------------------
// ADR 0005 Decision item 2: the gate makes no claim, "in code comments,
// messages, or documentation", that it verifies the hash is the hash of the
// cited page or that the quote appears there. Three of the four instances #278
// removed were code comments, so a test that inspected only refusal output
// would have missed them; the scan below is over the script's whole source.
//
// The decision forbids two claims, so the patterns cover two halves: the
// hash-and-retrieval half, which is where all four of #278's instances were,
// and the quote half. The quote half is the easier one to drift into, because
// no contentHash check sits beside it to make the limit obvious.
//
// The vocabulary is chosen to be *presupposing*: each pattern asserts that a
// retrieval happened, or asserts correspondence between a value the producer
// declared and a remote page, and none can appear in an honest disclaimer
// without rewording. That is a deliberate cost. A disclaimer in this file must
// say what the gate does not do without borrowing the phrasing that does the
// overclaiming -- writing "never that a page was retrieved" trips the same wire
// as claiming it, because a substring scan cannot read negation. It is also why
// the scan is scoped to gate-evidence.mjs alone: ADR 0005 and
// reference/claim-bundle.md state the same limit correctly and, in doing so,
// use the forbidden phrasings, so scanning them would red honest text.
//
// That last point is a rule rather than a local convenience, and it is the same
// rule the skill-doc count check states at its own scan root (#316):
//
//   A substring scanner cannot be pointed at the prose that documents it,
//   because accurate documentation of a forbidden pattern necessarily contains
//   the forbidden pattern.
//
// Both scans meet it, independently, and both answer it by staying narrow. So
// widening this one past gate-evidence.mjs is a decision to be argued, not
// housekeeping: ADR 0005 and reference/claim-bundle.md would go red on the day
// it happened, and they would be right and the scan would be wrong.
//
// What this scan is not: a fixed vocabulary cannot recognise every way of
// overclaiming, and phrasings outside it pass -- #278's QA demonstrated several.
// A clean run means no *known* phrasing is present in this one file, never that
// the file is free of overclaims. Item 2 is a standing obligation on all three
// channels, and this test discharges a part of it on one of them.
// ---------------------------------------------------------------------------
describe('gate-evidence claims no retrieval it cannot perform (ADR 0005)', () => {
  const OVERCLAIMS = [
    { label: 'names a page as fetched/retrieved/downloaded', re: /\b(fetched|retrieved|downloaded)\s+page\b/i },
    { label: 'claims something was actually fetched/read/retrieved', re: /\bactually\s+(fetched|read|retrieved|downloaded)\b/i },
    { label: 'claims a check proves a retrieval happened', re: /\bprove[sdn]?\b[^.\n]{0,60}\b(read|fetched|retrieved|downloaded)\b/i },
    { label: 'claims the hash corresponds to the page', re: /\b(hash|digest)\s+of\s+the\s+(\w+\s+){0,2}page\b/i },
    // The quote half of Decision item 2. gate-evidence.mjs does check that a
    // quote is present and long enough, so the drift this watches for is one
    // word wide: "present in the bundle" becoming "present in the source".
    {
      label: 'claims the quote was located in the cited source',
      re: /\bquot(?:e|es|ed|ation)\b[^.\n]{0,60}\b(appears?|occurs?|found|present)\b[^.\n]{0,30}\b(page|source|document|article|site|url|there)\b/i,
    },
  ];

  function matchOverclaims(text) {
    return OVERCLAIMS.filter(({ re }) => re.test(text)).map(({ label }) => label);
  }

  // One probe per pattern, each phrased so that pattern and no other matches it.
  // Deliberately a separate list rather than a field on each OVERCLAIMS entry: a
  // probe that lived on its own pattern would be deleted along with it, and the
  // coverage test below would stay green through exactly the deletion it exists
  // to catch. Kept apart, deleting a pattern orphans its probe and goes red.
  const PATTERN_PROBES = [
    ['names a page as fetched/retrieved/downloaded', 'no hash and no fetched page for this citation'],
    ['claims something was actually fetched/read/retrieved', 'the url was actually retrieved by the gate'],
    ['claims a check proves a retrieval happened', 'a well-formed hash proves the source was read'],
    ['claims the hash corresponds to the page', 'the digest of the page it names'],
    ['claims the quote was located in the cited source', 'the quote appears in the source document'],
  ];

  test('every pattern is the sole match for some probe, so none can be deleted unnoticed', () => {
    for (const [label, text] of PATTERN_PROBES) {
      assert.deepEqual(
        matchOverclaims(text),
        [label],
        `the probe for "${label}" is not matched by that pattern and only that pattern: ${text}`,
      );
    }
    assert.deepEqual(
      PATTERN_PROBES.map(([label]) => label).sort(),
      OVERCLAIMS.map(({ label }) => label).sort(),
      'every pattern needs a probe only it matches, and every probe needs a live pattern',
    );
  });

  // The strings #278 removed, kept as fixtures -- verbatim apart from leading
  // indentation and, on the last, the trailing comma that followed it in the
  // argument list. Each pins one historical regression against silent
  // reintroduction, and the test below shows the scan still fires on real
  // removed text rather than only on text written to be caught.
  //
  // What they do not show is that each pattern individually can fire: all four
  // are hash-and-retrieval-half text, so none reaches the quote pattern, and the
  // only one reaching the hash-corresponds-to-page pattern is matched by a
  // second pattern too. Per-pattern capability is PATTERN_PROBES' job.
  const REMOVED_BY_278 = [
    '// fetched page, no hash, or a review that never reached a majority. Search',
    '// Gate: the evidence behind a claim was actually retrieved.',
    '// field that must say `fetch` and a hash that proves something was read.',
    '`contentHash "${item.contentHash ?? \'missing\'}" is not a sha256:<64 hex> digest of the fetched page`',
  ];

  test('every removed overclaim is still detected, so the scan is not vacuous', () => {
    for (const fixture of REMOVED_BY_278) {
      assert.ok(
        matchOverclaims(fixture).length > 0,
        `no pattern detects the overclaim: ${fixture}`,
      );
    }
  });

  test('honest descriptions of the same checks are not flagged', () => {
    // Guards the patterns against being so broad that conforming text cannot be
    // written: these are the shapes the corrected file actually uses.
    const honest = [
      'a field that must say `fetch` and a hash that must be well-formed',
      'contentHash is not shaped sha256:<64 hex> - this gate checks that shape only',
      'it cannot judge whether a quote supports a claim, nor whether anyone ever visited the cited url',
      'fetchedAt "2026-01-01" is not a real YYYY-MM-DD date',
      'retrieval is "search-snippet", but only "fetch" is admissible',
      'the reviewed-profile set is read from disk, not taken from the bundle',
      // The quote half. These are the shapes an honest description of the quote
      // check takes, including the live refusal message with its template
      // resolved: the quote pattern must leave every one of them alone, or the
      // gate cannot describe what it does without tripping its own scanner.
      'quote is missing or shorter than 24 characters, so it cannot show the source stating this',
      'a quote short enough to be a coincidence is not corroboration',
      'the quote field is checked for length only, never against the cited url',
      'the quote and the url are both values the producer declared in the bundle',
      'a quote is copied from the source by the scout, and this gate never sees the source',
      'the quote is present and non-empty',
    ];
    for (const text of honest) {
      assert.deepEqual(matchOverclaims(text), [], `honest text was flagged: ${text}`);
    }
  });

  test('the gate-evidence source makes no remote-content claim', () => {
    const source = readFileSync(GATE_EVIDENCE, 'utf8');
    assert.ok(source.length > 0, 'gate-evidence.mjs is empty');
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1, labels: matchOverclaims(line) }))
      .filter((entry) => entry.labels.length > 0);
    assert.deepEqual(
      offenders.map((o) => `${o.number}: ${o.line.trim()} [${o.labels.join('; ')}]`),
      [],
      'gate-evidence.mjs claims a retrieval or correspondence it never establishes (ADR 0005)',
    );
  });

  // The #155/#261 pattern applied to this vocabulary: the refusal an operator
  // actually sees must not describe a fetch that never happened.
  test('the contentHash refusal describes only what was checked', () => {
    const evidence = { ...claim().evidence[0] };
    delete evidence.contentHash;
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [evidence] })] });
    assert.equal(result.code, 1, result.stdout);
    const messages = JSON.parse(result.stdout).failures
      .filter((failure) => failure.gate === 'evidence')
      .map((failure) => failure.message);
    assert.ok(messages.length > 0, 'expected an evidence failure');
    for (const message of messages) {
      assert.deepEqual(matchOverclaims(message), [], `refusal overclaims: ${message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// check-skill-doc-test-counts.mjs: SKILLS_DIR is the whole scope of that check
//
// `SKILLS_DIR` is a scan root, which is the same shape of constant as
// gate-scope's ALLOWED_PATHS above, and #237's asymmetry applies to it
// unchanged: the constant *is* the entire extent of what the check guarantees,
// so nothing about a green run distinguishes a correct root from a wrong one.
// Until #388 nothing in this repository named it, so no test could notice.
//
// ## Which direction fails open, and why that is the one this block exists for
//
// NARROWING. A root reaching fewer files produces a green run over less of the
// tree, and that is indistinguishable from a clean repository: the exit code is
// 0 either way, and the only trace is a file count inside a success message.
// Measured on this repository at cbef9e7, before this block existed -- pointing
// the root at `.github/skills/modeltree-gates` took the scan from eight markdown
// files to two while the checker still exited 0 and this suite still passed
// whole. Those numbers are evidence at that commit, never a live claim about
// what the tree holds now. The checker still exits 0 under that edit today; what
// changed is that this suite no longer does.
//
// Widening is loud today, but only by accident, and the difference matters.
// `.github/workflows/README.md` currently states counts, so a root reaching it
// exits 1. That is a fact about that file's present contents rather than a
// guarantee -- the checker's own header records that it does not read that file
// and so cannot keep any claim about it true. Correct those lines and widening
// goes quiet too. The pin below is therefore on the exact value in both
// directions, never a floor.
//
// ## What is pinned, and what is deliberately not
//
// Pinned: the declared value of `SKILLS_DIR`, derived from the checker's source
// rather than restated, and the scan root the checker *names to a reader*, taken
// from the live process rather than from its source. The messages are IN SCOPE
// (#388 AC 5). Every message that names the root renders it through
// `posix(relative(REPO_ROOT, SKILLS_DIR))`, so today they follow the constant
// for free; pinning them is what catches the single edit that would separate the
// two, which is a message rewritten to name a root it no longer computes. A
// reader told the scan covered `.github/skills` when it did not is the same
// fail-open failure one level up, in the only channel anyone actually reads.
//
// Not pinned: what the checker scans. #316 weighed widening this root and chose
// to keep it narrow; that decision stands and #388 does not disturb it. This
// block turns "widening is a deliberate act" from an aspiration into a
// mechanism, and moves nothing.
//
// The derivation reads one declaration and never the whole file, so an unrelated
// edit to the checker leaves it green -- an assertion that fired on every change
// to that file would be pinning the file, not the constant. That property is a
// test below rather than a claim here.
// ---------------------------------------------------------------------------
describe('check-skill-doc-test-counts SKILLS_DIR is pinned to .github/skills', () => {
  const SKILL_DOC_CHECK = join(REPO, '.github', 'scripts', 'check-skill-doc-test-counts.mjs');

  // The only literal expectation in this block. A change that moves the root has
  // to edit this line, which is the whole mechanism.
  const PINNED_SEGMENTS = ['.github', 'skills'];
  const PINNED_ROOT = PINNED_SEGMENTS.join('/');

  // Fails closed: a source that cannot be read, or that is empty, throws rather
  // than yielding text from which no declaration is found for the wrong reason.
  function sourceOf(file) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message}`);
    }
    if (text.length === 0) throw new Error(`${file} is empty`);
    return text;
  }

  // The path segments named in `const SKILLS_DIR = join(REPO_ROOT, ...)`,
  // derived from that declaration and nothing else. Every way of not finding an
  // answer throws: a missing declaration, a base that is not REPO_ROOT, and a
  // join naming no segments would each otherwise produce a value that could
  // compare equal to something by accident.
  function skillsDirSegmentsFrom(source) {
    const decl = /const\s+SKILLS_DIR\s*=\s*join\(([^)]*)\)/.exec(source);
    if (!decl) throw new Error('no const SKILLS_DIR = join(...) declaration found');
    const args = decl[1];
    const base = args.split(',')[0].trim();
    if (base !== 'REPO_ROOT') throw new Error(`SKILLS_DIR is not anchored at REPO_ROOT but at ${base}`);
    const segments = [...args.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
    if (segments.length === 0) throw new Error('SKILLS_DIR names no path segments below REPO_ROOT');
    return segments;
  }

  // One pattern per message the checker uses to name its scan root -- success,
  // refusal, and empty scan -- so this reads whichever the live tree produces
  // and is deliberately not coupled to the skill docs being clean today: a real
  // count landing in a skill doc must red that checker, not this block as well.
  // Naming no root at all throws rather than being read as agreement.
  const ROOT_NAMED = [
    /markdown file\(s\) under (.+?) state no test count/,
    /is stated in the skill documentation under (.+?)\.\n/,
    /found no markdown under (.+?)\. A scan of nothing/,
  ];

  function scanRootNamedByChecker() {
    const { code, stdout } = run(SKILL_DOC_CHECK, []);
    for (const pattern of ROOT_NAMED) {
      const match = pattern.exec(stdout);
      if (match) return match[1];
    }
    throw new Error(`the checker named no scan root (exit ${code}): ${stdout.trim().slice(0, 400)}`);
  }

  test('the declared SKILLS_DIR is exactly .github/skills', () => {
    assert.deepEqual(
      skillsDirSegmentsFrom(sourceOf(SKILL_DOC_CHECK)),
      PINNED_SEGMENTS,
      'check-skill-doc-test-counts.mjs SKILLS_DIR has moved. That constant is the entire scope of ' +
        'the check, and narrowing it yields a green run over fewer files that reads exactly like a ' +
        'clean repository. #316 weighed widening this root and chose to keep it narrow; read that ' +
        'decision in the checker header, and re-measure it, before editing this expectation.',
    );
  });

  test('the scan root the checker names to a reader is the one it is pinned to', () => {
    assert.equal(
      scanRootNamedByChecker(),
      PINNED_ROOT,
      'the checker reports a scan root other than the pinned one, so what it tells a reader and ' +
        'what it actually reads can no longer be read as the same claim',
    );
  });

  test('a moved root is detected rather than absorbed, in both directions', () => {
    // The fail-open direction first, since it is the one nothing else catches.
    const narrowed = 'const SKILLS_DIR = join(REPO_ROOT, ".github", "skills", "modeltree-gates");';
    assert.deepEqual(skillsDirSegmentsFrom(narrowed), ['.github', 'skills', 'modeltree-gates']);
    assert.notDeepEqual(skillsDirSegmentsFrom(narrowed), PINNED_SEGMENTS);
    const widened = 'const SKILLS_DIR = join(REPO_ROOT, ".github");';
    assert.deepEqual(skillsDirSegmentsFrom(widened), ['.github']);
    assert.notDeepEqual(skillsDirSegmentsFrom(widened), PINNED_SEGMENTS);
  });

  test('an unrelated edit to the checker leaves the derived value alone', () => {
    // The control #388 AC 3 asks for. An assertion that fired on every edit to
    // the checker would be pinning the file rather than the constant, and would
    // red on any honest change to it.
    //
    // Stated as a relationship between two derivations rather than against
    // PINNED_SEGMENTS, deliberately: compared to the pinned value it would also
    // red whenever the constant moved, which would make it a second copy of the
    // pin above instead of a control on it. It has to stay green under exactly
    // the mutation that reds the pin, and it does.
    const source = sourceOf(SKILL_DOC_CHECK);
    const lines = source.split('\n');
    const at = lines.findIndex((line) => line.includes('const SKILLS_DIR = join('));
    assert.notEqual(at, -1, 'the declaration this control edits around is not present');
    // Comments directly above and directly below the declaration and nothing
    // else: the most adversarial innocent edit available, because every line
    // around the constant moves while the constant itself does not.
    const innocent = [
      ...lines.slice(0, at),
      '// an unrelated comment directly above the declaration',
      lines[at],
      '// an unrelated comment directly below it',
      ...lines.slice(at + 1),
    ].join('\n');
    // The control on the control: an innocent edit that edited nothing would
    // prove nothing.
    assert.notEqual(innocent, source, 'the innocent edit changed nothing, so this control proves nothing');
    assert.deepEqual(
      skillsDirSegmentsFrom(innocent),
      skillsDirSegmentsFrom(source),
      'an edit that never touched the SKILLS_DIR declaration changed the value derived from it',
    );
  });

  test('the derivation reads the join arguments in order, in either quote style', () => {
    assert.deepEqual(skillsDirSegmentsFrom('const SKILLS_DIR = join(REPO_ROOT, ".a", \'b\', "c");'), ['.a', 'b', 'c']);
  });

  test('the derivation fails closed rather than returning a value that could compare equal', () => {
    assert.throws(
      () => skillsDirSegmentsFrom('const OTHER_DIR = join(REPO_ROOT, ".github", "skills");'),
      /no const SKILLS_DIR/,
    );
    assert.throws(
      () => skillsDirSegmentsFrom('const SKILLS_DIR = join(HERE, ".github", "skills");'),
      /not anchored at REPO_ROOT/,
    );
    assert.throws(() => skillsDirSegmentsFrom('const SKILLS_DIR = join(REPO_ROOT);'), /names no path segments/);
    assert.throws(() => sourceOf(join(REPO, 'no', 'such', 'file.mjs')), /cannot read/);
  });
});
