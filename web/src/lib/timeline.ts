import type { Dataset, ModelRelease } from '../data/schema';
import type { FacetValue } from './catalog';
import { modelRoute } from './catalog';
import { accessLabel, categoryLabel, formatReleaseDate } from './format';
import { releaseEventTypeLabel } from './provider-profile';

export class TimelineIndexError extends Error {
  constructor(issues: string[]) {
    super(`Timeline index generation failed:\n- ${issues.join('\n- ')}`);
    this.name = 'TimelineIndexError';
  }
}

export type TimelineScale = 'year' | 'quarter' | 'month';
export type TimelineOrder = 'newest' | 'oldest';

/**
 * Which record produced the entry. A release is the model appearing; an event is
 * something that later happened to it. They stay distinguishable because a
 * deprecation is not a release, and a reader must be able to tell them apart.
 */
export type TimelineEntryKind = 'release' | 'event';

export interface TimelineEntry {
  id: string;
  kind: TimelineEntryKind;
  /**
   * The date narrowed to what {@link datePrecision} claims: `2024-07-23`,
   * `2024-07`, or `2024`. Kept partial so nothing downstream can print a day
   * nobody claimed. Codepoint order over these strings is already chronological,
   * and a coarser date sorts before the finer dates inside it, so no padded day
   * is invented to make entries comparable.
   */
  date: string;
  datePrecision: ModelRelease['datePrecision'];
  /** The date rendered no more precisely than {@link datePrecision} allows. */
  dateLabel: string;
  kindLabel: string;
  modelName: string;
  modelSlug: string;
  route: string;
  creatorSlug: string;
  creatorName: string;
  categories: string[];
  accessType: string;
  accessTypeLabel: string;
}

export interface TimelineFacets {
  creators: FacetValue[];
  categories: FacetValue[];
  accessTypes: FacetValue[];
}

export interface TimelineIndex {
  entries: TimelineEntry[];
  facets: TimelineFacets;
  /** Every year the entries touch, newest first, for the range presets. */
  years: string[];
}

/** Codepoint order, so index output does not vary with the host's locale. */
function compare(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function countFacet(
  entries: Array<{ value: string; label: string }>,
  order: 'value' | 'value-desc' = 'value',
): FacetValue[] {
  const counts = new Map<string, FacetValue>();

  for (const entry of entries) {
    const existing = counts.get(entry.value);
    if (existing) existing.count += 1;
    else counts.set(entry.value, { value: entry.value, label: entry.label, count: 1 });
  }

  return [...counts.values()].sort((a, b) => (
    order === 'value-desc' ? compare(b.value, a.value) : compare(a.value, b.value)
  ));
}

/** Ascending: earliest first, with a coarser date ahead of the dates inside it. */
function byDateAscending(a: TimelineEntry, b: TimelineEntry) {
  return compare(a.date, b.date) || compare(a.id, b.id);
}

export function timelineEntryYear(entry: Pick<TimelineEntry, 'date'>) {
  return entry.date.slice(0, 4);
}

/**
 * The latest instant the entry's date could still refer to, as a comparable
 * string. A `2024` entry could be as late as the end of 2024, so a range bound
 * that used the stored `2024` alone would hide it from every window opening
 * inside that year. The `-31` is a comparison ceiling, never a rendered date and
 * never stored, so no day is claimed for a month-precision record.
 */
export function timelineDateCeiling(entry: Pick<TimelineEntry, 'date' | 'datePrecision'>) {
  if (entry.datePrecision === 'day') return entry.date;
  return entry.datePrecision === 'month' ? `${entry.date}-31` : `${entry.date}-12-31`;
}

/** How many characters of an ISO date each precision actually claims. */
const PRECISION_WIDTH: Record<ModelRelease['datePrecision'], number> = {
  year: 4,
  month: 7,
  day: 10,
};

/**
 * Trims a date to what its precision claims.
 *
 * This existed because `releaseSchema.releaseDate` was a full ISO date whatever
 * the precision beside it said, so a year-precision release arrived carrying a
 * day no source stated. abdeslam-menacere/ModelTree#468 made `releaseDate` a
 * `partialDate` and made validation enforce the pairing, so validated data no
 * longer reaches here needing the trim. It is kept as a cheap total function
 * over the type rather than a load-bearing correction: `buildTimelineIndex` is
 * exported and accepts any `Dataset`, so this keeps {@link TimelineEntry.date}
 * true to its precision without depending on where the value came from.
 */
function toStatedPrecision(date: string, precision: ModelRelease['datePrecision']) {
  return date.slice(0, PRECISION_WIDTH[precision]);
}

export function buildTimelineIndex(dataset: Dataset, base = '/'): TimelineIndex {
  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));
  const releaseById = new Map(dataset.releases.map((item) => [item.id, item]));

  const issues: string[] = [];
  const entries: TimelineEntry[] = [];

  const push = (
    id: string,
    kind: TimelineEntryKind,
    sourceDate: string,
    datePrecision: ModelRelease['datePrecision'],
    kindLabel: string,
    release: ModelRelease,
  ) => {
    const organization = organizationById.get(release.organizationId);
    if (!organization) {
      issues.push(`timeline entry ${id} has no resolvable creator`);
      return;
    }

    const date = toStatedPrecision(sourceDate, datePrecision);

    entries.push({
      id,
      kind,
      date,
      datePrecision,
      dateLabel: formatReleaseDate(date, datePrecision),
      kindLabel,
      modelName: release.displayName,
      modelSlug: release.slug,
      route: modelRoute(base, release.slug),
      // The creator of the model, never the party that published the event. A
      // platform announcing availability changes where a model runs, not who
      // built it, so the badge keeps naming the creator.
      creatorSlug: organization.slug,
      creatorName: organization.name,
      categories: [...release.categories].sort(compare),
      accessType: release.accessType,
      accessTypeLabel: accessLabel(release.accessType),
    });
  };

  for (const release of dataset.releases) {
    push(
      `release:${release.id}`,
      'release',
      release.releaseDate,
      release.datePrecision,
      'Released',
      release,
    );
  }

  for (const event of dataset.releaseEvents) {
    const release = releaseById.get(event.releaseId);
    if (!release) {
      issues.push(`release event ${event.id} references missing release "${event.releaseId}"`);
      continue;
    }
    push(
      `event:${event.id}`,
      'event',
      event.date,
      event.datePrecision,
      releaseEventTypeLabel(event.type),
      release,
    );
  }

  if (issues.length) throw new TimelineIndexError(issues);

  entries.sort(byDateAscending);

  const facets: TimelineFacets = {
    creators: countFacet(entries.map((entry) => ({
      value: entry.creatorSlug,
      label: entry.creatorName,
    }))),
    categories: countFacet(entries.flatMap((entry) => entry.categories.map((category) => ({
      value: category,
      label: categoryLabel(category as never),
    })))),
    accessTypes: countFacet(entries.map((entry) => ({
      value: entry.accessType,
      label: entry.accessTypeLabel,
    }))),
  };

  const years = [...new Set(entries.map(timelineEntryYear))].sort((a, b) => compare(b, a));

  return { entries, facets, years };
}

export interface TimelineStop {
  key: string;
  label: string;
  /**
   * True when the entries beneath state a year but not the month the selected
   * scale groups by. The stop stays inside its year and says so, rather than
   * guessing a month or dropping the entries from the view.
   */
  imprecise: boolean;
  note?: string;
  entries: TimelineEntry[];
  count: number;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const TIMELINE_SCALES: readonly TimelineScale[] = ['year', 'quarter', 'month'];
export const TIMELINE_ORDERS: readonly TimelineOrder[] = ['newest', 'oldest'];

export const SCALE_LABELS: Record<TimelineScale, string> = {
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
};

export const ORDER_LABELS: Record<TimelineOrder, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
};

/** Quarter and month stops both need the month; a year-only date supplies neither. */
function scaleNeedsMonth(scale: TimelineScale) {
  return scale !== 'year';
}

interface StopIdentity {
  key: string;
  sortKey: string;
  label: string;
  imprecise: boolean;
  note?: string;
}

function stopIdentityOf(entry: TimelineEntry, scale: TimelineScale): StopIdentity {
  const year = timelineEntryYear(entry);

  if (scaleNeedsMonth(scale) && entry.datePrecision === 'year') {
    const missing = scale === 'quarter' ? 'quarter' : 'month';
    return {
      key: `${year}:undated`,
      // `~` sorts after every digit and after `Q`, so an undated stop sits at the
      // end of its year ascending and at the start of it reversed, which keeps
      // the two orders exact mirrors of one another.
      sortKey: `${year}-~`,
      label: `${year} · ${missing} not given`,
      imprecise: true,
      note: `These sources state ${year} only, so the ${missing} is not given.`,
    };
  }

  if (scale === 'year') {
    return { key: year, sortKey: year, label: year, imprecise: false };
  }

  const month = Number(entry.date.slice(5, 7));

  if (scale === 'quarter') {
    const quarter = Math.floor((month - 1) / 3) + 1;
    return {
      key: `${year}-Q${quarter}`,
      sortKey: `${year}-Q${quarter}`,
      label: `Q${quarter} ${year}`,
      imprecise: false,
    };
  }

  return {
    key: entry.date.slice(0, 7),
    sortKey: entry.date.slice(0, 7),
    label: `${MONTH_LABELS[month - 1]} ${year}`,
    imprecise: false,
  };
}

/**
 * Groups entries into the period stops one scale asks for, in the chosen order.
 *
 * Scale and order are presentation only: every entry handed in comes out again,
 * so changing the scale can never make a record disappear from the page.
 */
export function groupTimelineEntries(
  entries: readonly TimelineEntry[],
  scale: TimelineScale,
  order: TimelineOrder,
): TimelineStop[] {
  const stops = new Map<string, TimelineStop & { sortKey: string }>();

  for (const entry of [...entries].sort(byDateAscending)) {
    const identity = stopIdentityOf(entry, scale);
    const existing = stops.get(identity.key);
    if (existing) {
      existing.entries.push(entry);
      existing.count += 1;
      continue;
    }
    stops.set(identity.key, {
      key: identity.key,
      sortKey: identity.sortKey,
      label: identity.label,
      imprecise: identity.imprecise,
      note: identity.note,
      entries: [entry],
      count: 1,
    });
  }

  const ascending = [...stops.values()].sort((a, b) => compare(a.sortKey, b.sortKey));
  const ordered = order === 'newest' ? ascending.reverse() : ascending;

  return ordered.map(({ sortKey: _sortKey, ...stop }) => ({
    ...stop,
    entries: order === 'newest' ? [...stop.entries].reverse() : stop.entries,
  }));
}
