import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  NEAR_MISS_FRACTION,
  classifyDrift,
  describeProvenance,
  driftFailureMessage,
  driftOf,
  formatAllowanceReport,
  formatConsumed,
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
    expect(text).toContain('LOWER BOUND');
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
    expect(text).toContain('LOWER BOUND');
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
