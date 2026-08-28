import { describe, expect, it } from 'vitest';

import { dataset } from '../data/dataset';
import type { DatePrecision } from '../data/schema';
import { formatDateWithPrecision } from './format';

/**
 * Consolidation proof for the duplicated precision-rendering rule.
 *
 * Until this change the repository held two independent implementations of
 * "render a date no more precisely than its source stated it": `formatReleaseDate`
 * in `format.ts`, and `formatDateWithPrecision` in `passport.ts`, which arrived
 * whole in a later change carrying its own copy. Neither referenced the other.
 * Collapsing them to one is only safe if they agreed, so this file settles that
 * by measurement rather than by reading them side by side.
 *
 * The two functions below are frozen verbatim copies of those implementations as
 * they stood before the consolidation. They are deliberately *not* imported from
 * anywhere: their whole purpose is to be a fixed historical record to compare
 * against, so they must not track later edits. Nothing outside this file may use
 * them, and they are not a second live implementation of anything.
 */

/** `web/src/lib/format.ts:3` before the consolidation. */
function historicalFormatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

/** `web/src/lib/format.ts:20` before the consolidation. */
function historicalFormatReleaseDate(value: string, precision: DatePrecision) {
  const date = new Date(`${value}T00:00:00Z`);
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC', year: 'numeric' };

  if (precision === 'month' || precision === 'day') options.month = 'short';
  if (precision === 'day') options.day = 'numeric';

  return new Intl.DateTimeFormat('en', options).format(date);
}

/** `web/src/lib/passport.ts:192` before the consolidation. */
function historicalFormatDateWithPrecision(value: string, precision: DatePrecision) {
  const [year, month, day] = value.split('-');

  if (precision === 'year') return year;
  if (precision === 'month') {
    return new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${year}-${month}-01T00:00:00Z`));
  }

  return historicalFormatDate(`${year}-${month}-${day}`);
}

type Outcome = { ok: true; value: string } | { ok: false };

function attempt(render: () => string): Outcome {
  try {
    const value = render();
    // `Intl` yields the literal string "Invalid Date" rather than throwing in
    // some engines, so an unusable render is normalised to the same failure
    // outcome as a thrown one. Otherwise a disagreement could hide as a match
    // between two different flavours of broken.
    return value.includes('Invalid Date') ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  }
}

const committedPairs = dataset.releases.map((release) => ({
  id: release.id,
  value: release.releaseDate,
  precision: release.datePrecision,
}));

describe('precision-rendering consolidation', () => {
  it('compares against a non-empty set of committed release dates', () => {
    // This repository has drawn wrong conclusions from empty loops before, so
    // the loops below are only evidence once this holds. It is a lower bound
    // rather than a pin: the dataset grows, and a test that had to be edited on
    // every data refresh would be edited without being read.
    expect(committedPairs.length).toBeGreaterThanOrEqual(40);
  });

  it('finds the two historical implementations agreed on every committed release date', () => {
    const disagreements = committedPairs.filter(({ value, precision }) => {
      const viaFormat = attempt(() => historicalFormatReleaseDate(value, precision));
      const viaPassport = attempt(() => historicalFormatDateWithPrecision(value, precision));

      if (!viaFormat.ok || !viaPassport.ok) return true;
      return viaFormat.value !== viaPassport.value;
    });

    expect(disagreements).toEqual([]);
  });

  it('reproduces that agreed output exactly, for every committed release date', () => {
    for (const { id, value, precision } of committedPairs) {
      const agreed = historicalFormatReleaseDate(value, precision);

      expect(`${id}: ${formatDateWithPrecision(value, precision)}`).toBe(`${id}: ${agreed}`);
    }
  });
});

describe('precision-rendering consolidation, beyond the committed data', () => {
  const shapes = ['2026', '2026-03', '2026-03-14'];
  const precisions: DatePrecision[] = ['year', 'month', 'day'];

  const grid = shapes.flatMap((value) => precisions.map((precision) => ({ value, precision })));

  it('finds the older implementation invented a day where the newer one refused', () => {
    const disagreed: string[] = [];

    for (const { value, precision } of grid) {
      const viaFormat = attempt(() => historicalFormatReleaseDate(value, precision));
      const viaPassport = attempt(() => historicalFormatDateWithPrecision(value, precision));

      const same = viaFormat.ok && viaPassport.ok && viaFormat.value === viaPassport.value;
      if (!same) disagreed.push(`${value} @ ${precision}: format=${viaFormat.ok ? viaFormat.value : 'unrenderable'} passport=${viaPassport.ok ? viaPassport.value : 'unrenderable'}`);
    }

    // The finding this file exists to record, and it is not the one expected
    // before running it. `formatReleaseDate` fed its value to `new Date()`, and
    // `new Date('2026T00:00:00Z')` is not an error — it is 1 January 2026. So on
    // a partial value that implementation did not fail; it silently supplied the
    // missing components and printed a day no source ever stated, in a format
    // indistinguishable from a sourced one. That is precisely the failure this
    // issue exists to prevent, latent in the renderer rather than the schema,
    // and it would have gone live the moment a partial value reached it.
    //
    // `formatDateWithPrecision` split the string instead, so a missing component
    // stayed missing and the render broke visibly rather than lying quietly.
    // That is why the consolidation keeps the splitting implementation. The two
    // agree on every full `YYYY-MM-DD` value, which is every record committed
    // today, so nothing rendered changes.
    expect(disagreed).toEqual([
      '2026 @ month: format=Jan 2026 passport=unrenderable',
      '2026 @ day: format=Jan 1, 2026 passport=unrenderable',
      '2026-03 @ day: format=Mar 1, 2026 passport=unrenderable',
    ]);
  });

  it('never reproduces the invented day, on any input that produced one', () => {
    // The three cases above, stated as the property rather than as a transcript,
    // so this keeps holding if the grid grows.
    const invented: Array<[string, DatePrecision]> = [
      ['2026', 'month'],
      ['2026', 'day'],
      ['2026-03', 'day'],
    ];

    for (const [value, precision] of invented) {
      expect(historicalFormatReleaseDate(value, precision)).toMatch(/Jan|Mar/);
      expect(formatDateWithPrecision(value, precision)).toBe(
        value === '2026' ? '2026' : 'Mar 2026',
      );
    }
  });

  it('renders every shape at no finer precision than the value itself carries', () => {
    for (const { value, precision } of grid) {
      const rendered = formatDateWithPrecision(value, precision);

      expect(rendered).not.toContain('Invalid');
      expect(rendered).not.toContain('undefined');

      // The consolidated function renders at the coarser of the two, so it is
      // total across the grid where both historical versions were partial.
      if (value === '2026') expect(rendered).toBe('2026');
      if (value === '2026-03' && precision !== 'year') expect(rendered).toBe('Mar 2026');
    }
  });
});
