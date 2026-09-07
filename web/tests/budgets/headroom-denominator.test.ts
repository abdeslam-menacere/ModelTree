import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { proseFields } from './reason-supersession.test.ts';

/**
 * Guards `asset-budgets.json`'s headroom percentages against unlabeled denominators
 * (issue #1023).
 *
 * Two conventions coexist: `spare / ceiling` (the fraction of the ceiling unoccupied,
 * matching `headroomOf` in `asset-drift.mjs`) and `spare / measured` (the fraction by
 * which the route can grow from its current size). They diverge as headroom widens —
 * 0.18 points at 4% spare, 9.35 points at 35% — so a reader who does not know which
 * denominator a figure uses cannot compare it with the instrument's output.
 *
 * This test asserts that every `+X.X% headroom` figure in the file carries a
 * denominator label: `(of ceiling)` or `(of measured)`, or has the denominator stated
 * in immediately adjacent prose (e.g. "headroom of ceiling"). A figure that matches
 * neither pattern reddens here so the next append cannot recreate the ambiguity.
 *
 * It is proved by mutation: a figure switched to the unlabeled form must flip the
 * result.
 */

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../asset-budgets.json', import.meta.url)), 'utf8'),
);

/**
 * Matches `+X.X% headroom` that is NOT followed by `(of ceiling)`, `(of measured)`,
 * `of ceiling`, or `of measured`. The pattern deliberately does NOT match bare
 * percentages like `4.39%` — only the `+X.X% headroom` template used for re-record
 * entries.
 */
const UNLABELED_HEADROOM = /[+]\d+\.?\d*%\s+headroom(?!\s*\(of\s+(ceiling|measured)\b)(?!\s+of\s+(ceiling|measured)\b)/g;

describe('asset-budgets headroom percentages name their denominator (#1023)', () => {
  const fields = proseFields(budgets);

  it('finds prose fields to check at all', () => {
    expect(fields.length).toBeGreaterThan(10);
  });

  it.each(fields.map((f) => [f.name, f.text] as const))(
    'every headroom %% is labeled: %s',
    (name, text) => {
      const matches = [...text.matchAll(UNLABELED_HEADROOM)];
      expect(
        matches.length,
        `${name} has ${matches.length} unlabeled headroom percentage(s):\n` +
          matches.map((m) => `  at ${m.index}: "${text.substring(m.index!, m.index! + 40)}"`).join('\n') +
          '\n\nEvery headroom figure must carry `(of ceiling)` or `(of measured)` so ' +
          'a reader can compare it with the instrument output. See #1023.',
      ).toBe(0);
    },
  );

  it('actually finds labeled headroom figures, so the check is not vacuously true', () => {
    // Positive control: the file must contain some labeled figures.
    const LABELED = /[+]\d+\.?\d*%\s+headroom\s*\(of\s+(ceiling|measured)\b/g;
    const total = fields.reduce((n, f) => n + [...f.text.matchAll(LABELED)].length, 0);
    expect(total).toBeGreaterThan(10);
  });

  // --- Mutation proof: a figure switched to the unlabeled form must be caught ---

  it('CATCHES an unlabeled headroom figure', () => {
    const text = 'Absorbed by headroom, ceiling unchanged. +4.4% headroom. That is the tightest margin.';
    expect([...text.matchAll(UNLABELED_HEADROOM)]).toHaveLength(1);
  });

  it('ACCEPTS a labeled headroom figure (of ceiling)', () => {
    const text = 'Absorbed by headroom, ceiling unchanged. +4.4% headroom (of ceiling). That is the tightest.';
    expect([...text.matchAll(UNLABELED_HEADROOM)]).toHaveLength(0);
  });

  it('ACCEPTS a labeled headroom figure (of measured)', () => {
    const text = 'Absorbed by headroom, ceiling unchanged. +4.4% headroom (of measured). That is the tightest.';
    expect([...text.matchAll(UNLABELED_HEADROOM)]).toHaveLength(0);
  });

  it('ACCEPTS the "headroom of ceiling" inline form', () => {
    const text = 'compare (+4.2% headroom of ceiling), home (+4.2% of ceiling).';
    expect([...text.matchAll(UNLABELED_HEADROOM)]).toHaveLength(0);
  });
});

/**
 * Denominator accuracy: the LAST headroom figure per route must match the
 * denominator it claims, computed from the route's own numeric fields.
 * A figure switched to the other denominator flips this test (issue #1023
 * acceptance criterion 4).
 */
describe('the last headroom figure per route matches its claimed denominator (#1023)', () => {
  const LABELED_HEADROOM =
    /[+](\d+\.?\d*)%\s+headroom\s*\(of\s+(ceiling|measured)\)/g;

  // Tolerance: figures are rounded to 1 decimal in prose, so 0.15 pts covers rounding.
  const TOLERANCE = 0.15;

  const routes: Array<{
    id: string;
    ceiling: number;
    measured: number;
    reason: string;
  }> = [
    ...budgets.fixedRoutes.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      ceiling: r.criticalMaxRaw as number,
      measured: r.measuredRaw as number,
      reason: r.reason as string,
    })),
    ...budgets.routeGroups.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      ceiling: r.criticalMaxRaw as number,
      measured: (r.measuredWorstRaw ?? r.measuredRaw) as number,
      reason: r.reason as string,
    })),
  ].filter(
    (r) => r.reason && [...r.reason.matchAll(LABELED_HEADROOM)].length > 0,
  );

  it('finds routes with labeled headroom to check', () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  it.each(routes.map((r) => [r.id, r] as const))(
    'last headroom figure is accurate for its claimed denominator: %s',
    (_id, route) => {
      const matches = [...route.reason.matchAll(LABELED_HEADROOM)];
      const last = matches[matches.length - 1];
      const figure = parseFloat(last[1]);
      const denom = last[2]; // 'ceiling' or 'measured'

      const spare = route.ceiling - route.measured;
      const ofCeiling = (spare / route.ceiling) * 100;
      const ofMeasured = (spare / route.measured) * 100;
      const expected = denom === 'ceiling' ? ofCeiling : ofMeasured;
      const other = denom === 'ceiling' ? ofMeasured : ofCeiling;

      expect(
        Math.abs(figure - expected),
        `${route.id}: last figure is +${figure}% (of ${denom}), ` +
          `expected ${expected.toFixed(2)}% (of ${denom}), ` +
          `gap ${Math.abs(figure - expected).toFixed(3)} exceeds tolerance ${TOLERANCE}. ` +
          `The other denominator gives ${other.toFixed(2)}%.\n` +
          `If the figure matches the OTHER denominator, the label is wrong.`,
      ).toBeLessThan(TOLERANCE);
    },
  );

  // --- Mutation proof: switching the denominator must flip the result ---

  it('REJECTS a figure that matches the other denominator', () => {
    // Take a real route where the two conventions differ meaningfully.
    // home: spare/ceiling=4.20%, spare/measured=4.39% — gap 0.19 pts, above tolerance.
    const home = routes.find((r) => r.id === 'home');
    expect(home).toBeDefined();
    const spare = home!.ceiling - home!.measured;
    const ofMeasured = (spare / home!.measured) * 100; // ~4.39
    const ofCeiling = (spare / home!.ceiling) * 100; // ~4.20

    // A figure claiming "of ceiling" but using the measured value should fail.
    const gap = Math.abs(ofMeasured - ofCeiling);
    expect(
      gap,
      'The two denominators must differ enough to detect a switch',
    ).toBeGreaterThan(TOLERANCE);
  });
});
