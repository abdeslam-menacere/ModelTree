/**
 * A date a source stated is not a point in time. It is the interval of days its
 * wording leaves open: `2026` means some day in 2026, `2026-03` some day in
 * March. Every comparison and every rendering in this repository reads a
 * partial date that way, so that no code path has to pick a day the source
 * never gave.
 *
 * `isoDate` is the deliberate opposite and is not handled here. Those are dates
 * *we* record — `verifiedAt`, `lastCheckedDate`, licence windows — where the
 * day is always known because we were the ones observing it.
 *
 * This module has no imports on purpose: `schema.ts` builds its `datePrecision`
 * enum from the vocabulary below, so the edge runs one way and the two cannot
 * drift apart.
 */

/** How much of a date a source actually gave. */
export const DATE_PRECISIONS = ['year', 'month', 'day'] as const;

export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/** How many `-`-separated segments a value at each precision carries. */
export const PRECISION_SEGMENTS: Record<DatePrecision, number> = {
  year: 1,
  month: 2,
  day: 3,
};

const PRECISION_BY_SEGMENTS: Record<number, DatePrecision> = {
  1: 'year',
  2: 'month',
  3: 'day',
};

/** The precision a value's own shape carries, independent of what it declares. */
export function precisionOf(value: string): DatePrecision {
  return PRECISION_BY_SEGMENTS[value.split('-').length] ?? 'day';
}

/**
 * The guard that closes the invented-day path.
 *
 * A record declaring `month` while carrying `2026-03-14` states a day no source
 * supported, and labels it as though it did not. Storing the two separately is
 * only honest if they are required to agree, so disagreement is a rejection
 * rather than something a renderer is left to paper over.
 */
export function precisionMatchesValue(value: string, precision: DatePrecision): boolean {
  return value.split('-').length === PRECISION_SEGMENTS[precision];
}

/** The earliest day a partial date could mean, so `2026` is not read as 1 January. */
export function earliestDay(value: string): string {
  // Every absent segment defaults, and a present one is kept. Reading only
  // `[year, month]` here and always appending `-01` would discard the day of a
  // full date, quietly turning `2026-03-14` into `2026-03-01` — which is the
  // same class of silent coercion this module exists to remove.
  const [year, month = '01', day = '01'] = value.split('-');
  return `${year}-${month}-${day}`;
}

/** The latest day a partial date could mean. */
export function latestDay(value: string): string {
  const parts = value.split('-');
  if (parts.length === 3) return value;
  if (parts.length === 2) {
    const [year, month] = parts.map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${parts[0]}-${parts[1]}-${String(lastDay).padStart(2, '0')}`;
  }
  return `${parts[0]}-12-31`;
}

/**
 * Ordering over dates of mixed precision, ascending.
 *
 * A partial date denotes a closed interval of days, so ordering is by
 * `earliestDay` first and `latestDay` second. Two consequences are intended:
 *
 * - A less precise date never sorts as more recent than a precise date whose
 *   position it might not actually beat. `2026` is placed at the earliest day
 *   it could mean, so in a newest-first list it falls behind every dated 2026
 *   release rather than ahead of them.
 * - Where two intervals overlap — `2026-03` against `2026-03-14` — the sources
 *   do not settle which came first, and neither does this. The order it returns
 *   is presentational and total so that lists are stable; it is not a claim
 *   about chronology, and callers must not read one out of it.
 *
 * What it never does is coerce a partial date to a day to make a comparison
 * work. The interval bounds are a derived sort key and are never rendered.
 */
export function comparePartialDates(a: string, b: string): number {
  const startA = earliestDay(a);
  const startB = earliestDay(b);
  if (startA !== startB) return startA < startB ? -1 : 1;

  const endA = latestDay(a);
  const endB = latestDay(b);
  if (endA !== endB) return endA < endB ? -1 : 1;
  return 0;
}

/** `comparePartialDates` reversed, for the newest-first lists that dominate the site. */
export function comparePartialDatesDescending(a: string, b: string): number {
  return comparePartialDates(b, a);
}

/**
 * True only when `a` is *definitely* before `b` — the whole of `a`'s interval
 * falls before the whole of `b`'s. Overlap means the sources leave the order
 * open, and an open question is not a contradiction to report.
 */
export function isDefinitelyBefore(a: string, b: string): boolean {
  return latestDay(a) < earliestDay(b);
}

/** True only when `a` is definitely after `b`. The mirror of `isDefinitelyBefore`. */
export function isDefinitelyAfter(a: string, b: string): boolean {
  return earliestDay(a) > latestDay(b);
}
