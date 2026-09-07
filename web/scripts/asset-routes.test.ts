import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BudgetRouteError,
  assertFiguresCover,
  expectedFigureLabels,
  fixedRoutesOf,
} from './asset-routes.mjs';

/**
 * #1030: the route id -> path mapping is stated once, in `asset-budgets.json`,
 * and the reports read it from there. This file is the assertion that the two
 * cannot drift -- specifically that a SEVENTH `fixedRoutes` entry is covered,
 * which is the case no test could reach while the mapping lived as a literal
 * array inside two entry-point scripts that build the site at import.
 *
 * Every negative arm below is paired with a positive one from the same function
 * in the same run. A refusal that fires on everything passes a one-sided test
 * and reports nothing, and "the seventh route is covered" is worth exactly
 * nothing unless the same call can be shown to leave it out when it is absent.
 */

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const realBudgets = JSON.parse(readFileSync(join(webRoot, 'asset-budgets.json'), 'utf8'));

type RouteFixture = { id?: string; path?: string; criticalMaxRaw?: number };
type GroupFixture = { id?: string; dir?: string; criticalMaxRaw?: number; jsMaxRaw?: number };
type BudgetsFixture = { fixedRoutes: RouteFixture[]; routeGroups: GroupFixture[] };

/** Six routes and two groups, shaped like the real file and independent of it. */
const sixRoutes = (): BudgetsFixture => ({
  fixedRoutes: [
    { id: 'home', path: 'index.html', criticalMaxRaw: 1_105_000 },
    { id: 'catalog', path: 'models/index.html', criticalMaxRaw: 660_000 },
    { id: 'benchmarks', path: 'benchmarks/index.html', criticalMaxRaw: 520_000 },
    { id: 'tree', path: 'tree/index.html', criticalMaxRaw: 760_000 },
    { id: 'compare', path: 'compare/index.html', criticalMaxRaw: 820_000 },
    { id: 'updates', path: 'updates/index.html', criticalMaxRaw: 495_000 },
  ],
  routeGroups: [
    { id: 'passport', dir: 'models', criticalMaxRaw: 700_000, jsMaxRaw: 20_000 },
    { id: 'providers', dir: 'providers', criticalMaxRaw: 600_000 },
  ],
});

/** The same fixture with the seventh route this issue exists to make safe. */
const sevenRoutes = (): BudgetsFixture => {
  const budgets = sixRoutes();
  budgets.fixedRoutes.push({
    id: 'methodology',
    path: 'methodology/index.html',
    criticalMaxRaw: 400_000,
  });
  return budgets;
};

describe('fixedRoutesOf reads the mapping from asset-budgets.json', () => {
  it('derives every route the real budget file states, and nothing else', () => {
    const derived = fixedRoutesOf(realBudgets);
    expect(derived.map((r) => r.id)).toEqual(realBudgets.fixedRoutes.map((r: any) => r.id));
    expect(derived.map((r) => r.path)).toEqual(realBudgets.fixedRoutes.map((r: any) => r.path));
    // Non-vacuous: a file with no routes would satisfy the two equalities above
    // by matching emptiness on both sides.
    expect(derived.length).toBeGreaterThan(0);
  });

  it('carries each route ceiling through, so no caller has to look it up again', () => {
    const derived = fixedRoutesOf(realBudgets);
    for (const route of derived) {
      const source = realBudgets.fixedRoutes.find((r: any) => r.id === route.id);
      expect(route.criticalMaxRaw).toBe(source.criticalMaxRaw);
    }
  });

  it('preserves budget-file order, because the reports print in it', () => {
    // PERFORMANCE-BUDGETS.md quotes figures read off that output; sorting here
    // would reorder a published table for no reason.
    expect(fixedRoutesOf(sixRoutes()).map((r) => r.id)).toEqual([
      'home',
      'catalog',
      'benchmarks',
      'tree',
      'compare',
      'updates',
    ]);
  });
});

describe('the data and the reports cannot drift (#1030)', () => {
  it('covers a SEVENTH fixedRoutes entry with no code change', () => {
    const derived = fixedRoutesOf(sevenRoutes());

    expect(derived).toHaveLength(7);
    expect(derived.map((r) => r.id)).toContain('methodology');
    expect(derived.find((r) => r.id === 'methodology')?.path).toBe('methodology/index.html');
  });

  it('control: the same call leaves that route out when the data does not carry it', () => {
    // Without this arm the assertion above could be satisfied by a function that
    // returns 'methodology' unconditionally, and the two arms coming back
    // DIFFERING is the whole of the discrimination.
    const derived = fixedRoutesOf(sixRoutes());

    expect(derived).toHaveLength(6);
    expect(derived.map((r) => r.id)).not.toContain('methodology');
  });

  it('a route the data states can never be silently skipped', () => {
    // The pre-#1030 shape was a literal list plus `if (!budget) continue;`, so a
    // route the budget file knew about and the literal did not was dropped
    // without a word. There is no list to fall out of step with any more: every
    // entry maps to exactly one derived route.
    const budgets = sevenRoutes();
    const derived = fixedRoutesOf(budgets);

    expect(derived).toHaveLength(budgets.fixedRoutes.length);
    for (const entry of budgets.fixedRoutes) {
      expect(derived.map((r) => r.id)).toContain(entry.id);
    }
  });
});

describe('a route that cannot be measured is a failure, not a continue', () => {
  it('refuses an entry whose path is missing, naming the entry', () => {
    const budgets = sixRoutes();
    delete budgets.fixedRoutes[3].path;

    expect(() => fixedRoutesOf(budgets)).toThrow(BudgetRouteError);
    expect(() => fixedRoutesOf(budgets)).toThrow(/tree/);
  });

  it('refuses an entry whose path is the empty string', () => {
    // Distinct from missing: an empty string is a present-but-useless value, and
    // `readFileSync(join(dist, ''))` reads a directory rather than a route.
    const budgets = sixRoutes();
    budgets.fixedRoutes[0].path = '';

    expect(() => fixedRoutesOf(budgets)).toThrow(BudgetRouteError);
  });

  it('refuses an entry with no usable id', () => {
    const budgets = sixRoutes();
    delete budgets.fixedRoutes[2].id;

    expect(() => fixedRoutesOf(budgets)).toThrow(BudgetRouteError);
  });

  it('refuses an entry with no ceiling to measure against', () => {
    const budgets = sixRoutes();
    delete budgets.fixedRoutes[5].criticalMaxRaw;

    expect(() => fixedRoutesOf(budgets)).toThrow(/criticalMaxRaw/);
  });

  it('control: the same call accepts the well-formed fixture it was given', () => {
    // Without this arm every expectation above is satisfied by a function that
    // throws on all input.
    expect(() => fixedRoutesOf(sixRoutes())).not.toThrow();
    expect(() => fixedRoutesOf(sevenRoutes())).not.toThrow();
    expect(() => fixedRoutesOf(realBudgets)).not.toThrow();
  });
});

describe('a degenerate budget file must not read as a covered one', () => {
  it('refuses an empty fixedRoutes array rather than reporting zero routes', () => {
    // Zero routes measured and zero routes asked for produce the same green
    // report, which is the state a denominator cannot distinguish on its own.
    expect(() => fixedRoutesOf({ fixedRoutes: [] })).toThrow(BudgetRouteError);
  });

  it('refuses a budgets object with no fixedRoutes key at all', () => {
    expect(() => fixedRoutesOf({})).toThrow(BudgetRouteError);
    expect(() => fixedRoutesOf(undefined as any)).toThrow(BudgetRouteError);
  });

  it('control: a single well-formed route is accepted, so the refusal is about emptiness', () => {
    const one = fixedRoutesOf({
      fixedRoutes: [{ id: 'home', path: 'index.html', criticalMaxRaw: 1 }],
    });
    expect(one).toHaveLength(1);
  });
});

describe('expectedFigureLabels keeps a printed denominator honest', () => {
  it('counts every figure the real budget file asks for, re-derived from the file', () => {
    // docs/product/PERFORMANCE-BUDGETS.md publishes "13 figures compared, 13
    // identical, 0 moved" from the runway probe's mechanism control run at
    // d5907b3bdc. That figure is bound to a named commit as history, so it stays
    // true OF THAT COMMIT and is not the count today: #1065 added a seventh
    // fixed route (`methodology`, the one route in the build linking a
    // page-specific stylesheet), which is precisely the move this module exists
    // to absorb. So the expectation is re-derived from the file rather than
    // bumped to the next constant -- a constant restated beside the data file
    // that holds the authority is the #1030 defect itself, and updating it to 14
    // would rebuild that defect one number later.
    //
    // The sum is written out here independently of `expectedFigureLabels`, not
    // read back from it, so a category silently vanishing from that function
    // still fails this arm rather than moving both sides together.
    const groups = realBudgets.routeGroups as { jsMaxRaw?: number }[];
    const expectedCount =
      realBudgets.fixedRoutes.length +
      groups.length +
      groups.filter((g) => typeof g.jsMaxRaw === 'number').length +
      4; // globals: js, css, font, _astro dir

    const labels = expectedFigureLabels(realBudgets);
    expect(labels).toHaveLength(expectedCount);
    // Non-vacuous: an emptiness matching an emptiness would satisfy the equality
    // above, and the four globals alone would satisfy any count that ignored the
    // file's routes.
    expect(expectedCount).toBeGreaterThan(4);
    expect(labels).toContain('route:updates');
    // #1065: the seventh route is in the denominator every report prints, which
    // is the whole of what putting it in `fixedRoutes` was for.
    expect(labels).toContain('route:methodology');
    expect(labels).toContain('group:passport js');
    expect(labels).toContain('global:_astro dir');
  });

  it('moves to fourteen on a seventh route, which is what a constant cannot do', () => {
    expect(expectedFigureLabels(sixRoutes())).toHaveLength(13);
    expect(expectedFigureLabels(sevenRoutes())).toHaveLength(14);
    expect(expectedFigureLabels(sevenRoutes())).toContain('route:methodology');
  });

  it('adds a group JS figure only where the budget file states a JS ceiling', () => {
    const budgets = sixRoutes();
    expect(expectedFigureLabels(budgets)).not.toContain('group:providers js');

    budgets.routeGroups[1].jsMaxRaw = 5_000;
    expect(expectedFigureLabels(budgets)).toContain('group:providers js');
  });
});

describe('assertFiguresCover refuses a report that dropped a figure', () => {
  const expected = expectedFigureLabels(sevenRoutes());

  it('names a figure the budget file asked for and the report did not measure', () => {
    const measured = expected.filter((label) => label !== 'route:methodology');

    expect(() => assertFiguresCover(measured, expected, 'arm A')).toThrow(BudgetRouteError);
    expect(() => assertFiguresCover(measured, expected, 'arm A')).toThrow(/route:methodology/);
    // The denominator, both sides of it, so a reader is not left to infer the
    // gap from a count they cannot see the other half of.
    expect(() => assertFiguresCover(measured, expected, 'arm A')).toThrow(/13 figure\(s\).*asks for 14/s);
  });

  it('names a figure the report measured that the budget file does not know about', () => {
    // The other direction is a different fault: the denominator over-counts, and
    // a reader sent looking for a dropped route loses the time.
    expect(() => assertFiguresCover([...expected, 'route:ghost'], expected, 'arm B')).toThrow(/route:ghost/);
  });

  it('control: a report that covers exactly the expected set is accepted', () => {
    // Without this arm every expectation above is satisfied by a checker that
    // refuses everything, which would fail the runway probe on every run.
    expect(() => assertFiguresCover(expected, expected, 'arm A')).not.toThrow();
    // Order is not part of the claim; membership is.
    expect(() => assertFiguresCover([...expected].reverse(), expected, 'arm A')).not.toThrow();
  });
});
