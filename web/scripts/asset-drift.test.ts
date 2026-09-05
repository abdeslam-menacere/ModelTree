import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CEILING_NEAR_MISS_FRACTION,
  NEAR_MISS_FRACTION,
  classifyDrift,
  classifyHeadroom,
  describeProvenance,
  driftFailureMessage,
  driftOf,
  formatAllowanceReport,
  formatConsumed,
  formatHeadroomReport,
  headroomOf,
} from './asset-drift.mjs';
import { PUBLISHED_REF, probeTreeProvenance } from './tree-provenance.mjs';

// abdeslam-menacere/ModelTree#832 -- the fast half of the guard.
//
// -- What this file can and cannot prove --
//
// The defect is a divergence between two trees: a local build measures the
// branch alone, and `web-ci.yml` checks out with no `ref:` override, so a
// `pull_request` run builds `refs/pull/N/merge`. Reproducing that end to end
// would mean two full `astro build`s of two different trees -- which is what
// `asset-budgets.test.ts` costs once, at ~55-75s, and it is why the reading
// added for #832 is a report rather than a second build.
//
// So this file does NOT prove that CI and a local run disagree. That is an
// established fact of the incident, measured in the issue and recorded in
// asset-budgets.json's drift-note, and it is a property of git and
// actions/checkout rather than of anything here.
//
// What it does prove is everything between that fact and a reader seeing it:
//
//   1. The consumption arithmetic is the SAME arithmetic the assertion binds
//      on, so the report cannot describe a different allowance from the one
//      that fails the build.
//   2. The measured incident is distinguishable. PR #830's branch-only `/tree`
//      figure and its merged figure are both fed in; the first passes and is
//      flagged NEAR MISS, the second is OVER. Under the old pass/fail assertion
//      the first was indistinguishable from a healthy 2%.
//   3. The merge mechanism reaches the reader in all three provenance states,
//      and `undetermined` never reads as "level with trunk".
//   4. The provenance probe can actually see a branch that trunk has moved past
//      -- proven against real git in throwaway repositories, because a probe
//      that reports "level" unconditionally would produce exactly the false
//      reassurance this issue is about.
//
// The numbers in (2) are the issue's own measurements, not invented fixtures.

const TREE_RECORDED = 532_352;
const TREE_BRANCH_ONLY = 542_692;
const TREE_MERGED = 544_346;
const COMPARE_RECORDED = 749_971;
const COMPARE_BRANCH_ONLY = 763_642;
const MAX_FRACTION = 0.02;

const repos: string[] = [];

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway repository with a `main`, a published remote-tracking ref, and a
 * branch that left trunk `trunkCommits` commits ago. Nothing here touches the
 * real repository.
 */
function throwawayRepo(trunkCommits: number, branchCommits: number) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-provenance-'));
  repos.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const commit = (n: string) => {
    writeFileSync(join(dir, 'f.txt'), n);
    git('add', 'f.txt');
    git('commit', '-m', n);
  };

  git('init', '--initial-branch=main');
  commit('base');
  git('checkout', '-b', 'dock');
  for (let i = 0; i < branchCommits; i += 1) commit(`branch-${i}`);
  git('checkout', 'main');
  for (let i = 0; i < trunkCommits; i += 1) commit(`trunk-${i}`);

  // The probe anchors on the remote-tracking ref, never on a local `main`,
  // because a local branch is one this working copy can move. There is no
  // remote here, so the ref is written directly -- which is precisely what a
  // fetch would leave behind.
  git('update-ref', PUBLISHED_REF, git('rev-parse', 'main').trim());
  git('checkout', 'dock');
  return dir;
}

describe('drift allowance accounting (#832)', () => {
  // The report's allowance must be the assertion's allowance. If these two ever
  // diverge the report becomes a confident description of a guard that is not
  // the one running, which is worse than printing nothing.
  it('computes the allowance exactly as the assertion does: floor(recorded * maxFraction)', () => {
    const row = driftOf('tree', TREE_RECORDED, TREE_BRANCH_ONLY, MAX_FRACTION);
    expect(row.tolerance).toBe(Math.floor(TREE_RECORDED * MAX_FRACTION));
    expect(row.tolerance).toBe(10_647);
    expect(row.drift).toBe(10_340);
    expect(row.drift).toBe(Math.abs(TREE_BRANCH_ONLY - TREE_RECORDED));
  });

  it('reproduces the measured #830 near miss that the old pass/fail reading hid', () => {
    const branchOnly = driftOf('tree', TREE_RECORDED, TREE_BRANCH_ONLY, MAX_FRACTION);
    const merged = driftOf('tree', TREE_RECORDED, TREE_MERGED, MAX_FRACTION);

    // The incident in two lines: the branch passed the guard and the merge CI
    // actually built did not, on the same commit and the same recorded figure.
    expect(branchOnly.within, 'the branch alone passed the guard, and did so correctly').toBe(true);
    expect(merged.within, 'the merge CI built did not pass it').toBe(false);

    // And this is what was invisible: the passing figure had spent 97.1% of its
    // allowance. Under a pass/fail assertion that reads identically to 2%.
    expect(formatConsumed(branchOnly.consumed)).toBe('97.1%');
    expect(classifyDrift(branchOnly)).toBe('near-miss');
    expect(classifyDrift(merged)).toBe('over');

    const compare = driftOf('compare', COMPARE_RECORDED, COMPARE_BRANCH_ONLY, MAX_FRACTION);
    expect(compare.within).toBe(true);
    expect(formatConsumed(compare.consumed)).toBe('91.1%');
    expect(classifyDrift(compare)).toBe('near-miss');
  });

  // Control on the classification: it must be capable of returning `ok`, or
  // "near-miss" above proves only that it says the same thing to everything.
  it('does not call every passing figure a near miss', () => {
    const healthy = driftOf('updates', 443_966, 443_966 + 500, MAX_FRACTION);
    expect(healthy.within).toBe(true);
    expect(classifyDrift(healthy)).toBe('ok');
    expect(healthy.consumed).toBeLessThan(NEAR_MISS_FRACTION);
  });

  // `over` is decided by `within` and never by the consumption fraction, so the
  // report can never contradict the assertion that actually binds.
  it('classifies `over` from the binding comparison, not from the percentage', () => {
    const justInside = driftOf('x', 100_000, 100_000 + 2_000, MAX_FRACTION);
    const justOutside = driftOf('x', 100_000, 100_000 + 2_001, MAX_FRACTION);
    expect(justInside.tolerance).toBe(2_000);
    expect(classifyDrift(justInside)).toBe('near-miss');
    expect(classifyDrift(justOutside)).toBe('over');
  });

  it('treats a recorded 0 as exactly 0 (the passport static-hydration tripwire)', () => {
    const clean = driftOf('passport measuredWorstJsRaw', 0, 0, MAX_FRACTION);
    expect(clean.tolerance).toBe(0);
    expect(clean.within).toBe(true);
    expect(clean.consumed).toBe(0);
    expect(classifyDrift(clean)).toBe('ok');

    // One byte of island JS on a static page trips it. There is no fraction of
    // a zero allowance, so it reports OVER rather than a percentage.
    const tripped = driftOf('passport measuredWorstJsRaw', 0, 1, MAX_FRACTION);
    expect(tripped.within).toBe(false);
    expect(formatConsumed(tripped.consumed)).toBe('OVER');
    expect(classifyDrift(tripped)).toBe('over');
  });

  it('reports drift in both directions (a figure that shrank is stale too)', () => {
    const shrunk = driftOf('tree', TREE_RECORDED, TREE_RECORDED - 20_000, MAX_FRACTION);
    expect(shrunk.direction).toBe('shrunk');
    expect(shrunk.within).toBe(false);
    expect(driftOf('tree', TREE_RECORDED, TREE_MERGED, MAX_FRACTION).direction).toBe('grown');
  });
});

describe('the allowance report (#832)', () => {
  const rows = [
    driftOf('tree (tree/index.html) measuredRaw', TREE_RECORDED, TREE_BRANCH_ONLY, MAX_FRACTION),
    driftOf('compare (compare/index.html) measuredRaw', COMPARE_RECORDED, COMPARE_BRANCH_ONLY, MAX_FRACTION),
    driftOf('updates (updates/index.html) measuredRaw', 443_966, 443_966 + 100, MAX_FRACTION),
  ];
  const behind = { status: 'behind' as const, ref: PUBLISHED_REF, head: 'aaaaaaaaaa', trunk: 'bbbbbbbbbb', behind: 3 };
  const report = formatAllowanceReport(rows, behind, MAX_FRACTION).join('\n');

  it('states consumption for every figure, on a run where nothing failed', () => {
    expect(rows.every((row) => row.within), 'this fixture must be an all-green run').toBe(true);
    expect(report).toContain('97.1%');
    expect(report).toContain('91.1%');
    expect(report).toContain('NEAR MISS');
    expect(report).toContain('3 recorded figure(s) checked: 0 over allowance, 2 near miss, 1 clear');
  });

  // The denominator, printed. "0 over" is worthless unless the total is visible
  // and reconciles with it, which is the same discipline the test file's
  // key-scan assertion applies to asset-budgets.json.
  it('reconciles its own counts against the number of rows', () => {
    const counts = [...report.matchAll(/(\d+) over allowance, (\d+) near miss, (\d+) clear/g)];
    expect(counts).toHaveLength(1);
    const [, over, near, clear] = counts[0].map(Number);
    expect(over + near + clear).toBe(rows.length);
  });

  it('names the row closest to the edge rather than leaving it to be found', () => {
    expect(report).toContain('Closest to the edge: tree (tree/index.html) measuredRaw at 97.1%');
  });

  it('sorts worst-first so the row that matters is the first one read', () => {
    const treeAt = report.indexOf('tree (tree/index.html)');
    const compareAt = report.indexOf('compare (compare/index.html)');
    const updatesAt = report.indexOf('updates (updates/index.html)');
    expect(treeAt).toBeGreaterThan(-1);
    expect(treeAt).toBeLessThan(compareAt);
    expect(compareAt).toBeLessThan(updatesAt);
  });

  // Control on the flagging: a report that printed the warning unconditionally
  // would pass every assertion above while telling a reader nothing.
  it('omits the near-miss advice when no figure is near its allowance', () => {
    const calm = formatAllowanceReport(
      [driftOf('updates', 443_966, 443_966 + 100, MAX_FRACTION)],
      behind,
      MAX_FRACTION,
    ).join('\n');
    expect(calm).toContain('0 over allowance, 0 near miss, 1 clear');
    expect(calm).not.toContain('NEAR MISS');
    expect(calm).not.toContain('one trunk commit from red');
  });
});

describe('tree provenance reaches the reader (#832)', () => {
  const mechanism = 'refs/pull/N/merge';

  it('names the merge ref when the branch is behind trunk', () => {
    const text = describeProvenance({
      status: 'behind',
      ref: PUBLISHED_REF,
      head: 'aaaaaaaaaa',
      trunk: 'bbbbbbbbbb',
      behind: 3,
    }).join('\n');
    expect(text).toContain('NOT the tree CI measures');
    expect(text).toContain(mechanism);
    expect(text).toContain('3 commit(s)');
    // #847 finding 2: merged drift is USUALLY at least local drift, not an
    // unconditional LOWER BOUND -- a route trunk has shrunk is the exception.
    expect(text).toContain('USUALLY at least');
    expect(text).toContain('SHRUNK');
    expect(text).not.toContain('LOWER BOUND');
    // The specific trap the issue names: following "re-run assets:report"
    // literally on this tree records a figure describing a tree that never
    // reaches main. The reader must be told that here, where they are about to.
    expect(text).toContain('never reaches `main`');
    expect(text).toContain('docs/product/PERFORMANCE-BUDGETS.md');
  });

  it('says so plainly when the tree measured IS the tree CI builds', () => {
    const text = describeProvenance({
      status: 'level',
      ref: PUBLISHED_REF,
      head: 'aaaaaaaaaa',
      trunk: 'bbbbbbbbbb',
      behind: 0,
    }).join('\n');
    expect(text).toContain('level with');
    expect(text).toContain("these drift figures are CI's figures");
    // And still says the anchor is a cache, because "level" only ever means
    // level with the last trunk this checkout fetched.
    expect(text).toContain('git fetch origin main');
  });

  it('never rounds an unanswerable probe to "level with trunk"', () => {
    const text = describeProvenance({ status: 'undetermined', ref: PUBLISHED_REF, reason: 'no such ref' }).join('\n');
    expect(text).toContain('UNDETERMINED');
    expect(text).toContain('no such ref');
    expect(text).toContain('NOT read as "level with trunk"');
    expect(text).toContain(mechanism);
    // #847 finding 2: reworded away from "LOWER BOUND" here too.
    expect(text).toContain('USUALLY at least');
    expect(text).toContain('SHRUNK');
    expect(text).not.toContain('LOWER BOUND');
  });

  it('degrades to UNDETERMINED rather than throwing when handed nothing', () => {
    expect(describeProvenance(undefined).join('\n')).toContain('UNDETERMINED');
  });

  it('carries the provenance into the failure message itself', () => {
    const row = driftOf('tree measuredRaw', TREE_RECORDED, TREE_MERGED, MAX_FRACTION);
    const message = driftFailureMessage(row, MAX_FRACTION, {
      status: 'behind',
      ref: PUBLISHED_REF,
      head: 'aaaaaaaaaa',
      trunk: 'bbbbbbbbbb',
      behind: 3,
    });
    expect(message).toContain('11,994');
    expect(message).toContain('10,647');
    expect(message).toContain('do NOT widen measuredDrift.maxFraction');
    expect(message).toContain(mechanism);
  });
});

describe('reworded strings that claimed a bound the code cannot establish (#847)', () => {
  const behind = {
    status: 'behind' as const,
    ref: PUBLISHED_REF,
    head: 'aaaaaaaaaa',
    trunk: 'bbbbbbbbbb',
    behind: 3,
  };

  // Finding 2: "every drift here is a LOWER BOUND on what CI will measure" is
  // false when trunk SHRINKS a route (recorded R, branch B, merged M: |B-R| is
  // not bounded above by |M-R|). #813 removed 220,029 bytes from /tree, so the
  // repository's own history is the counter-example. Present in both the
  // `behind` and `undetermined` provenance branches.
  it('does not claim merged drift is an unconditional lower bound (behind branch)', () => {
    const text = describeProvenance(behind).join('\n');
    expect(text).not.toContain('LOWER BOUND');
    expect(text).toContain('USUALLY at least');
    expect(text).toContain('SHRUNK');
    expect(text).toContain('220,029');
  });

  it('does not claim merged drift is an unconditional lower bound (undetermined branch)', () => {
    const text = describeProvenance({
      status: 'undetermined',
      ref: PUBLISHED_REF,
      reason: 'no such ref',
    }).join('\n');
    expect(text).not.toContain('LOWER BOUND');
    expect(text).toContain('USUALLY at least');
    expect(text).toContain('SHRUNK');
  });

  // Finding 3: the near-miss banner said a near miss "is one trunk commit from
  // red" at the 75% flag point, while its own derivation puts that nearer ~83%.
  // Reworded to a possibility ("may be within one trunk commit"), and to state
  // the flag sits below the calibrating incident's ~83%.
  it('does not assert a near miss IS one commit from red at the 75% flag', () => {
    const rows = [
      driftOf('tree measuredRaw', TREE_RECORDED, TREE_BRANCH_ONLY, MAX_FRACTION),
      driftOf('updates measuredRaw', 443_966, 443_966 + 100, MAX_FRACTION),
    ];
    const report = formatAllowanceReport(rows, behind, MAX_FRACTION).join('\n');
    expect(report).toContain('NEAR MISS');
    expect(report).not.toContain('is one trunk commit from red');
    expect(report).toContain('may be within one trunk commit of red');
    expect(report).toContain('~83%');
  });
});

describe('git absent from PATH gets its own remedy, not `git fetch` (#847 finding 4b)', () => {
  // With git unrunnable, `spawnSync` sets `error` and the probe must surface
  // that cause rather than advising `git fetch origin main`, which cannot fix a
  // missing git. Run the probe in a child node process with a PATH that cannot
  // resolve git, so `git` genuinely fails to launch.
  it('reports the unrunnable-git cause and never advises `git fetch`', () => {
    const probeUrl = new URL('./tree-provenance.mjs', import.meta.url).href;
    const script =
      `import { probeTreeProvenance } from ${JSON.stringify(probeUrl)};` +
      'const p = probeTreeProvenance(process.cwd());' +
      'process.stdout.write(JSON.stringify(p));';
    const emptyDir = mkdtempSync(join(tmpdir(), 'modeltree-nogit-'));
    repos.push(emptyDir);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: emptyDir,
      encoding: 'utf8',
      // A PATH with nothing on it: git cannot be found, so spawnSync sets
      // `error` (ENOENT) rather than a non-zero exit.
      env: { ...process.env, PATH: emptyDir, Path: emptyDir },
    });
    const provenance = JSON.parse(out);
    expect(provenance.status).toBe('undetermined');
    expect(provenance.reason).toContain('could not run git');
    expect(provenance.reason).not.toContain('git fetch origin main');
    expect(provenance.reason).not.toContain('does not resolve');
  });
});

describe('the provenance probe against real git (#832)', () => {
  // The control that matters. Every reading above is fed a hand-built
  // provenance object, so none of them establishes that the probe can produce
  // one. A probe that answered "level" to everything would satisfy all of them
  // and restore exactly the false reassurance this issue is about.
  it('detects a branch that trunk has moved past', () => {
    const provenance = probeTreeProvenance(throwawayRepo(2, 1));
    expect(provenance.status).toBe('behind');
    expect(provenance.behind).toBe(2);
  });

  it('reports level when trunk has not moved -- so it is not stuck on "behind"', () => {
    const provenance = probeTreeProvenance(throwawayRepo(0, 1));
    expect(provenance.status).toBe('level');
    expect(provenance.behind).toBe(0);
  });

  it('reports UNDETERMINED, not level, where the published ref does not resolve', () => {
    const bare = mkdtempSync(join(tmpdir(), 'modeltree-provenance-empty-'));
    repos.push(bare);
    const provenance = probeTreeProvenance(bare);
    expect(provenance.status).toBe('undetermined');
    expect(provenance.reason).toBeTruthy();
  });

  it('never throws, whatever it is pointed at', () => {
    expect(() => probeTreeProvenance(join(tmpdir(), 'modeltree-does-not-exist-zzz'))).not.toThrow();
    expect(probeTreeProvenance(join(tmpdir(), 'modeltree-does-not-exist-zzz')).status).toBe(
      'undetermined',
    );
  });
});

// abdeslam-menacere/ModelTree#939 -- the SECOND wall.
//
// Everything above this line is the DRIFT axis: how stale a recorded figure is
// against a fresh build. These figures are the CEILING axis: how much room a
// measured figure has left before the budget assertion reddens. The two are
// unrelated, and #874 conflated them, which is why every assertion below names
// its axis.
//
// -- Why these numbers are pinned to a commit --
//
// Read from `web/asset-budgets.json` at trunk b44c63d6 with a KEY-LEVEL JSON
// parse (never a line regex: field names occur inside `reason` prose, so a
// regex hit is not a field change and a regex miss is not absence). Each pair
// is `measuredRaw`/`measuredWorst*`/`*MeasuredRaw` against the `criticalMaxRaw`
// /`jsMaxRaw`/`globals.*MaxRaw` the budget assertions in
// `tests/build/asset-budgets.test.ts` compare it to.
//
// They are pinned as a HISTORICAL snapshot at a named commit, which is a
// terminal fact and stays true, rather than re-read from the live file. Two
// reasons, and the second is the load-bearing one:
//
//   1. #987 re-recorded eleven of the thirteen the day this was written, so a
//      live read pins the fixture on a state still in motion.
//   2. An assertion on the LIVE file's classification counts would make this
//      instrument fail a build as entries approach their ceilings -- exactly
//      the "permits nothing, fails nothing" discipline it is required to keep.
//      The classifier is proven here on fixed inputs; nothing asserts anything
//      about today's file.
const LIVE_CEILING_FIGURES: ReadonlyArray<readonly [string, number, number]> = [
  ['compare', 785_784, 820_000],
  ['home', 1_058_558, 1_105_000],
  ['catalog', 629_471, 660_000],
  ['benchmarks', 491_766, 520_000],
  ['providers', 650_936, 720_000],
  ['updates', 447_249, 495_000],
  ['globals.fontTotalMeasuredRaw', 187_036, 210_000],
  ['globals.jsTotalMeasuredRaw', 452_844, 520_000],
  ['globals.astroDirMeasuredRaw', 747_420, 860_000],
  ['passport', 173_003, 200_000],
  ['globals.cssTotalMeasuredRaw', 107_540, 125_000],
  ['tree', 560_418, 760_000],
  ['passport measuredWorstJsRaw', 0, 20_000],
];

const liveRows = () => LIVE_CEILING_FIGURES.map(([label, m, c]) => headroomOf(label, m, c));

describe('ceiling headroom accounting (#939)', () => {
  // The report's comparison must be the assertion's comparison. The budget
  // tests assert `measured <= criticalMaxRaw`; if `within` ever computed
  // something else, this report would be a confident description of a guard
  // that is not the one running.
  it('computes the same comparison the budget assertion binds on', () => {
    const row = headroomOf('compare', 785_784, 820_000);
    expect(row.within).toBe(785_784 <= 820_000);
    expect(row.headroom).toBe(34_216);
    expect(row.used).toBe(785_784 / 820_000);
    expect(formatConsumed(row.used)).toBe('95.8%');
  });

  // THE MUTATION TEST the issue asks for. An entry pushed above the threshold
  // must flip the classification; one below must not. Both arms run here, and
  // the two are asserted to DIFFER -- a classifier that answered the same thing
  // to everything would satisfy either arm alone.
  //
  // Note where the mutation happens: across the FLAG, never across the ceiling.
  // Both rows PASS. That is what makes this an instrument rather than a guard.
  it('flips an entry pushed above the threshold, and does not flip one below (mutation)', () => {
    const ceiling = 720_000;
    const atFlag = ceiling * CEILING_NEAR_MISS_FRACTION;
    expect(atFlag, 'fixture premise: the flag lands on a whole byte here').toBe(666_000);

    const below = headroomOf('providers', atFlag - 1, ceiling);
    const above = headroomOf('providers', atFlag, ceiling);

    expect(below.within, 'the mutation must stay under the ceiling on both arms').toBe(true);
    expect(above.within, 'the mutation must stay under the ceiling on both arms').toBe(true);

    expect(classifyHeadroom(below)).toBe('ok');
    expect(classifyHeadroom(above)).toBe('near-ceiling');
    expect(classifyHeadroom(below)).not.toBe(classifyHeadroom(above));
  });

  // The negative case, stated as the issue states it: a green suite that would
  // also be green with the check deleted proves nothing. So delete it -- a stub
  // classifier that always says `ok` -- and require the real one to disagree
  // with the stub on the real figures.
  it('disagrees with the check deleted: an always-ok classifier is not this one', () => {
    const rows = liveRows();
    const real = rows.map((row) => classifyHeadroom(row));
    const deleted = rows.map(() => 'ok');

    expect(real).not.toEqual(deleted);

    // ... and it is not the opposite stub either: it must fire on some rows and
    // stay silent on others, or it carries no information in the other
    // direction.
    const fired = real.filter((verdict) => verdict === 'near-ceiling');
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.length).toBeLessThan(rows.length);
  });

  // The discrimination criterion, measured. A 0.75 borrowed from the drift axis
  // fires on 11 of these 13 and so tells a reader nothing -- which is the whole
  // finding #939 was filed on, and the reason the threshold is derived rather
  // than copied across axes.
  it('discriminates where a borrowed 0.75 would not (trunk b44c63d6)', () => {
    const rows = liveRows();
    const firesAt = (t: number) =>
      rows.filter((row) => classifyHeadroom(row, t) === 'near-ceiling').map((row) => row.label);

    expect(firesAt(NEAR_MISS_FRACTION)).toHaveLength(11);
    expect(firesAt(0.85)).toHaveLength(11);
    expect(firesAt(0.9)).toHaveLength(6);
    expect(firesAt(CEILING_NEAR_MISS_FRACTION)).toEqual([
      'compare',
      'home',
      'catalog',
      'benchmarks',
    ]);

    // The threshold sits inside a real gap rather than mid-cluster: the lowest
    // flagged figure and the highest unflagged one are 4.16 points apart, so
    // small movement either way does not change the reading.
    const used = Object.fromEntries(rows.map((row) => [row.label, row.used]));
    expect(used.benchmarks - CEILING_NEAR_MISS_FRACTION).toBeGreaterThan(0);
    expect(CEILING_NEAR_MISS_FRACTION - used.providers).toBeGreaterThan(0.02);
  });

  // "It permits nothing", mechanically rather than as a claim in prose: `over`
  // is decided by `within` alone, so no value of the threshold -- including the
  // degenerate ones -- can turn a failing row into a passing one.
  it('permits nothing: no threshold turns an over-ceiling row into a passing one', () => {
    const over = headroomOf('compare', 820_001, 820_000);
    expect(over.within).toBe(false);
    expect(over.headroom).toBe(-1);
    for (const t of [0, 0.5, 0.925, 1, 2, Infinity]) {
      expect(classifyHeadroom(over, t), `threshold ${t} must not excuse an over-ceiling row`).toBe(
        'over',
      );
    }

    // And the converse: the binding comparison never depends on the threshold,
    // so tightening or loosening the flag cannot redden a passing row either.
    const passing = headroomOf('compare', 785_784, 820_000);
    for (const t of [0, 0.5, 0.925, 1]) {
      expect(classifyHeadroom(passing, t)).not.toBe('over');
    }
  });

  // The conflation #874 made, refuted in both directions with real figures.
  it('is a different axis from the drift near-miss, and the two do not track each other', () => {
    expect(CEILING_NEAR_MISS_FRACTION).not.toBe(NEAR_MISS_FRACTION);

    // Direction 1 -- PR #830's /tree: 97.1% of its DRIFT allowance, a near
    // miss, while sitting at 71% of its ceiling with 217,308 bytes to spare.
    const drifted = driftOf('tree', TREE_RECORDED, TREE_BRANCH_ONLY, MAX_FRACTION);
    expect(classifyDrift(drifted)).toBe('near-miss');
    expect(classifyHeadroom(headroomOf('tree', TREE_BRANCH_ONLY, 760_000))).toBe('ok');

    // Direction 2 -- the #939 case itself, and the sharper one. A figure
    // re-recorded to the byte has spent 0% of its drift allowance and reads
    // perfect on the only instrument that existed, while sitting at 95.8% of
    // the ceiling that actually gates growth. Re-recording resets the first
    // axis completely and moves the second not one byte.
    const freshlyRecorded = driftOf('compare', 785_784, 785_784, MAX_FRACTION);
    expect(classifyDrift(freshlyRecorded)).toBe('ok');
    expect(freshlyRecorded.consumed).toBe(0);
    expect(classifyHeadroom(headroomOf('compare', 785_784, 820_000))).toBe('near-ceiling');
  });

  it('treats a zero ceiling as admitting nothing', () => {
    const clean = headroomOf('passport measuredWorstJsRaw', 0, 0);
    expect(clean.within).toBe(true);
    expect(clean.used).toBe(0);
    expect(classifyHeadroom(clean)).toBe('ok');

    const tripped = headroomOf('passport measuredWorstJsRaw', 1, 0);
    expect(tripped.within).toBe(false);
    expect(formatConsumed(tripped.used)).toBe('OVER');
    expect(classifyHeadroom(tripped)).toBe('over');
  });
});

describe('the headroom report (#939)', () => {
  const report = formatHeadroomReport(liveRows()).join('\n');

  // The report is printed directly beneath the drift allowance report, so the
  // one thing it must never do is read as more of the same table.
  it('names its axis so it cannot be read as the drift allowance', () => {
    expect(report).toContain('CEILING HEADROOM');
    expect(report).toContain('DIFFERENT axis');
    expect(report).toContain('Near-ceiling flag at 92.5%');
    expect(report).toContain('it fails nothing, permits nothing and changes no exit code');
  });

  // Control on that printed denominator: a hardcoded "92.5%" would satisfy the
  // assertion above while describing a threshold the report is not using. The
  // two arms must DIFFER, or the header is decoration rather than a reading.
  it('prints the threshold it actually used, not a hardcoded one', () => {
    const borrowed = formatHeadroomReport(liveRows(), NEAR_MISS_FRACTION).join('\n');
    expect(borrowed).toContain('Near-ceiling flag at 75.0%');
    expect(borrowed).not.toContain('Near-ceiling flag at 92.5%');
    expect(borrowed).not.toEqual(report);
  });

  it('flags the figures with under two ordinary spans of room, and only those', () => {
    expect(report).toContain('NEAR CEILING');
    expect(report).toContain(
      '13 measured figure(s) checked against a ceiling: 0 over ceiling, 4 near ceiling, 9 clear.',
    );
  });

  // The denominator, printed and reconciled -- "0 over" is worthless unless the
  // total is visible and adds up.
  it('reconciles its own counts against the number of rows', () => {
    const counts = [...report.matchAll(/(\d+) over ceiling, (\d+) near ceiling, (\d+) clear/g)];
    expect(counts).toHaveLength(1);
    const [, over, near, clear] = counts[0].map(Number);
    expect(over + near + clear).toBe(LIVE_CEILING_FIGURES.length);
  });

  it('names the row closest to its ceiling rather than leaving it to be found', () => {
    expect(report).toContain('Closest to its ceiling: compare at 95.8% of 820,000 (34,216 bytes left).');
  });

  it('sorts worst-first so the row that matters is the first one read', () => {
    const compareAt = report.indexOf('  compare ');
    const providersAt = report.indexOf('  providers ');
    const treeAt = report.indexOf('  tree ');
    expect(compareAt).toBeGreaterThan(-1);
    expect(compareAt).toBeLessThan(providersAt);
    expect(providersAt).toBeLessThan(treeAt);
  });

  // Control on the flagging: a report that printed the warning unconditionally
  // would satisfy every assertion above while telling a reader nothing.
  it('omits the trim advice when nothing is near a ceiling', () => {
    const calm = formatHeadroomReport([headroomOf('tree', 560_418, 760_000)]).join('\n');
    expect(calm).toContain('0 over ceiling, 0 near ceiling, 1 clear.');
    expect(calm).not.toContain('NEAR CEILING');
    expect(calm).not.toContain('TRIMMING');
  });
});
