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

const LABELED_HEADROOM =
  /[+](\d+\.?\d*)%\s+headroom\s*\(of\s+(ceiling|measured)\)/g;

// Tolerance: figures are rounded to 1 decimal in prose, so 0.15 pts covers rounding.
const TOLERANCE = 0.15;

/**
 * Validates the last labeled headroom figure in `reason` against the route's
 * numeric fields. Returns `{ ok: true }` when the figure matches its claimed
 * denominator within TOLERANCE, or `{ ok: false, diagnostic }` when it does not.
 * Returns `null` when the reason contains no labeled headroom figure.
 */
function validateLastHeadroom(
  reason: string,
  ceiling: number,
  measured: number,
): { ok: true } | { ok: false; diagnostic: string } | null {
  const matches = [...reason.matchAll(LABELED_HEADROOM)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const figure = parseFloat(last[1]);
  const denom = last[2]; // 'ceiling' or 'measured'

  const spare = ceiling - measured;
  const ofCeiling = (spare / ceiling) * 100;
  const ofMeasured = (spare / measured) * 100;
  const expected = denom === 'ceiling' ? ofCeiling : ofMeasured;

  const gap = Math.abs(figure - expected);
  if (gap < TOLERANCE) return { ok: true };
  return {
    ok: false,
    diagnostic:
      `figure +${figure}% (of ${denom}) does not match: ` +
      `expected ${expected.toFixed(2)}% (of ${denom}), gap ${gap.toFixed(3)}`,
  };
}

describe('the last headroom figure per route matches its claimed denominator (#1023)', () => {
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
  ].filter((r) => r.reason && validateLastHeadroom(r.reason, r.ceiling, r.measured) !== null);

  it('finds routes with labeled headroom to check', () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  it.each(routes.map((r) => [r.id, r] as const))(
    'last headroom figure is accurate for its claimed denominator: %s',
    (_id, route) => {
      const result = validateLastHeadroom(route.reason, route.ceiling, route.measured);
      expect(result).not.toBeNull();
      expect(result!.ok, result!.ok ? '' : (result as { diagnostic: string }).diagnostic).toBe(
        true,
      );
    },
  );

  // --- Mutation proof: contrasted fixture through the shared validation path ---
  //
  // Self-contained fixture with ceiling=1000, measured=800, spare=200.
  // spare/ceiling = 20.0%, spare/measured = 25.0% — gap 5.0 pts, well above
  // TOLERANCE. Neither ratio depends on live data.

  it('ACCEPTS correctly labeled (of ceiling) through the validation path', () => {
    const reason = 'Ceiling unchanged. +20.0% headroom (of ceiling).';
    const result = validateLastHeadroom(reason, 1000, 800);
    expect(result).toEqual({ ok: true });
  });

  it('ACCEPTS correctly labeled (of measured) through the validation path', () => {
    const reason = 'Ceiling unchanged. +25.0% headroom (of measured).';
    const result = validateLastHeadroom(reason, 1000, 800);
    expect(result).toEqual({ ok: true });
  });

  it('REJECTS a figure labeled (of ceiling) but computed as spare/measured', () => {
    // 25.0 is spare/measured; labeling it (of ceiling) is wrong — spare/ceiling is 20.0.
    const reason = 'Ceiling unchanged. +25.0% headroom (of ceiling).';
    const result = validateLastHeadroom(reason, 1000, 800);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect((result as { diagnostic: string }).diagnostic).toContain('does not match');
  });

  it('REJECTS a figure labeled (of measured) but computed as spare/ceiling', () => {
    // 20.0 is spare/ceiling; labeling it (of measured) is wrong — spare/measured is 25.0.
    const reason = 'Ceiling unchanged. +20.0% headroom (of measured).';
    const result = validateLastHeadroom(reason, 1000, 800);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect((result as { diagnostic: string }).diagnostic).toContain('does not match');
  });
});
