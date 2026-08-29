import { describe, expect, it } from 'vitest';

import {
  comparePartialDates,
  comparePartialDatesDescending,
  earliestDay,
  isDefinitelyAfter,
  isDefinitelyBefore,
  latestDay,
  precisionMatchesValue,
  precisionOf,
} from './partial-date';

describe('precisionOf', () => {
  it('reads the precision off the value rather than being told it', () => {
    expect(precisionOf('2026')).toBe('year');
    expect(precisionOf('2026-03')).toBe('month');
    expect(precisionOf('2026-03-14')).toBe('day');
  });
});

describe('the interval a partial date denotes', () => {
  it('opens on the first day the value could mean', () => {
    expect(earliestDay('2026')).toBe('2026-01-01');
    expect(earliestDay('2026-03')).toBe('2026-03-01');
    expect(earliestDay('2026-03-14')).toBe('2026-03-14');
  });

  it('closes on the last day the value could mean', () => {
    expect(latestDay('2026')).toBe('2026-12-31');
    expect(latestDay('2026-03')).toBe('2026-03-31');
    expect(latestDay('2026-03-14')).toBe('2026-03-14');
  });

  it('closes February on the day that month actually had', () => {
    // A hardcoded 28 or 30 would be a second invented date, so the bound is
    // computed. 2024 is a leap year and 2026 is not.
    expect(latestDay('2024-02')).toBe('2024-02-29');
    expect(latestDay('2026-02')).toBe('2026-02-28');
    expect(latestDay('2026-04')).toBe('2026-04-30');
  });

  it('collapses to a single day when the source gave one', () => {
    expect(earliestDay('2026-03-14')).toBe(latestDay('2026-03-14'));
  });
});

describe('ordering dates of mixed precision', () => {
  it('places a partial date at the earliest day it could mean', () => {
    const sorted = ['2026-03-14', '2026', '2025-12-31', '2026-03'].sort(comparePartialDates);

    expect(sorted).toEqual(['2025-12-31', '2026', '2026-03', '2026-03-14']);
  });

  it('reverses cleanly for the newest-first lists the site uses', () => {
    const sorted = ['2025-12-31', '2026', '2026-03'].sort(comparePartialDatesDescending);

    expect(sorted).toEqual(['2026-03', '2026', '2025-12-31']);
  });

  it('is total and stable where two intervals overlap', () => {
    // '2026-03' and '2026-03-14' overlap, so the sources do not settle the
    // order. The comparator still has to return something for lists to be
    // stable, and what it must not do is return 0 and leave the order to
    // whatever the sort happened to be given.
    expect(comparePartialDates('2026-03', '2026-03-14')).toBeLessThan(0);
    expect(comparePartialDates('2026-03-14', '2026-03')).toBeGreaterThan(0);
    expect(comparePartialDates('2026-03', '2026-03')).toBe(0);
  });

  it('does not read an overlap as a chronology claim', () => {
    // The pair above orders, but neither is *definitely* before the other, and
    // that is the predicate every correctness check in the repo uses.
    expect(isDefinitelyBefore('2026-03', '2026-03-14')).toBe(false);
    expect(isDefinitelyAfter('2026-03-14', '2026-03')).toBe(false);
  });

  it('still settles an order the sources do settle', () => {
    expect(isDefinitelyBefore('2025', '2026-03')).toBe(true);
    expect(isDefinitelyAfter('2026-04', '2026-03')).toBe(true);
    expect(isDefinitelyBefore('2026-03-31', '2026-04-01')).toBe(true);
  });

  it('never coerces a partial date to a day that could be rendered', () => {
    // The bounds are a sort key. Nothing here changes the value itself, which is
    // what any renderer receives.
    const values = ['2026', '2026-03', '2026-03-14'];
    const sorted = [...values].sort(comparePartialDates);

    expect(sorted).toEqual(values);
    expect(sorted.every((value, index) => value === values[index])).toBe(true);
  });
});

/**
 * The guard, and the proof that testing it is not vacuous.
 *
 * Each case is stated once, as a helper taking the implementation under test,
 * then run twice: against the real `precisionMatchesValue`, where it must pass,
 * and against a deliberately permissive stand-in, where it must fail. Without
 * the second run an assertion that never rejects anything would look identical
 * to one that works.
 */
type PrecisionGuard = (value: string, precision: 'year' | 'month' | 'day') => boolean;

function assertGuardRejectsInventedDays(guard: PrecisionGuard) {
  // A day behind a coarser claim: the invented-day path itself.
  expect(guard('2026-03-14', 'month')).toBe(false);
  expect(guard('2026-03-14', 'year')).toBe(false);
  expect(guard('2026-03', 'year')).toBe(false);
  // A claim finer than the value: a day asserted that is not even present.
  expect(guard('2026-03', 'day')).toBe(false);
  expect(guard('2026', 'day')).toBe(false);
  expect(guard('2026', 'month')).toBe(false);
}

function assertGuardAcceptsAgreement(guard: PrecisionGuard) {
  expect(guard('2026', 'year')).toBe(true);
  expect(guard('2026-03', 'month')).toBe(true);
  expect(guard('2026-03-14', 'day')).toBe(true);
}

describe('the invented-day guard', () => {
  it('rejects every disagreement between a value and its declared precision', () => {
    assertGuardRejectsInventedDays(precisionMatchesValue);
  });

  it('accepts a value that states exactly the precision recorded beside it', () => {
    assertGuardAcceptsAgreement(precisionMatchesValue);
  });

  it('fails when run against a guard that rejects nothing', () => {
    // The negative control. If this ever passes, the assertion above has stopped
    // measuring anything and the suite is green for the wrong reason.
    const permissive: PrecisionGuard = () => true;

    expect(() => assertGuardRejectsInventedDays(permissive)).toThrow();
    // ...and the control is specific rather than merely broken: the permissive
    // stand-in still satisfies the acceptance half, so what the first assertion
    // detects is the missing rejection and nothing else.
    expect(() => assertGuardAcceptsAgreement(permissive)).not.toThrow();
  });

  it('fails when run against a guard that only compares the first four characters', () => {
    // A second control, closer to a plausible wrong implementation than
    // `() => true` is: comparing years only would accept a month-precision claim
    // over a full day, which is exactly the case that matters.
    const yearOnly: PrecisionGuard = (value) => value.slice(0, 4).length === 4;

    expect(() => assertGuardRejectsInventedDays(yearOnly)).toThrow();
  });
});
