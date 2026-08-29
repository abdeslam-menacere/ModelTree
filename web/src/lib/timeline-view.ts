import type { FacetValue } from './catalog';
import type {
  TimelineEntry,
  TimelineFacets,
  TimelineOrder,
  TimelineScale,
  TimelineStop,
} from './timeline';
import {
  groupTimelineEntries,
  timelineDateCeiling,
  timelineEntryYear,
  TIMELINE_ORDERS,
  TIMELINE_SCALES,
} from './timeline';

export type TimelineFilterKey = 'creators' | 'categories' | 'accessTypes';

/**
 * One selectable filter dimension, declared once so parsing, serializing, and
 * filtering can never drift apart.
 *
 * The three params are the catalog's own (`creator`, `category`, `access`), so a
 * creator selected here means the same thing in a catalog URL. Nothing in the
 * catalog reads this list; it is reuse of the names, not of the behaviour.
 */
export interface TimelineFilterDimension {
  key: TimelineFilterKey;
  param: string;
  facet: keyof TimelineFacets;
  label: string;
  values: (entry: TimelineEntry) => string[];
}

export const TIMELINE_FILTER_DIMENSIONS: readonly TimelineFilterDimension[] = [
  {
    key: 'creators',
    param: 'creator',
    facet: 'creators',
    label: 'Creator',
    values: (entry) => [entry.creatorSlug],
  },
  {
    key: 'categories',
    param: 'category',
    facet: 'categories',
    label: 'Category',
    values: (entry) => entry.categories,
  },
  {
    key: 'accessTypes',
    param: 'access',
    facet: 'accessTypes',
    label: 'Access',
    values: (entry) => [entry.accessType],
  },
];

export const SCALE_PARAM = 'scale';
export const RANGE_PARAM = 'range';
export const ORDER_PARAM = 'order';

export const ALL_TIME = 'all';
export const DEFAULT_SCALE: TimelineScale = 'year';
export const DEFAULT_ORDER: TimelineOrder = 'newest';

export type TimelineFilters = Record<TimelineFilterKey, string[]>;

export interface TimelineViewState {
  filters: TimelineFilters;
  scale: TimelineScale;
  range: string;
  order: TimelineOrder;
}

export type TimelineRangeKind = 'all' | 'relative' | 'year';

export interface TimelineRangeOption {
  value: string;
  label: string;
  kind: TimelineRangeKind;
  /** Set for a relative preset; the window it opens, counted back from today. */
  months?: number;
  /** Set for a calendar-year preset. */
  year?: string;
}

/** The relative windows, declared apart from the data-derived year presets. */
const RELATIVE_RANGES: readonly TimelineRangeOption[] = [
  { value: '12m', label: 'Last 12 months', kind: 'relative', months: 12 },
  { value: '24m', label: 'Last 24 months', kind: 'relative', months: 24 },
];

/**
 * The range presets a view offers: all time, the relative windows, then one per
 * year the data actually contains. Deriving the year presets from the entries
 * means a year that leaves the dataset cannot be selected.
 */
export function timelineRangeOptions(years: readonly string[]): TimelineRangeOption[] {
  return [
    { value: ALL_TIME, label: 'All time', kind: 'all' },
    ...RELATIVE_RANGES,
    ...years.map((year) => ({ value: year, label: year, kind: 'year' as const, year })),
  ];
}

function emptyFilters(): TimelineFilters {
  return { creators: [], categories: [], accessTypes: [] };
}

export function defaultTimelineState(): TimelineViewState {
  return {
    filters: emptyFilters(),
    scale: DEFAULT_SCALE,
    range: ALL_TIME,
    order: DEFAULT_ORDER,
  };
}

/** Valid values per dimension, taken from the facets so an unknown value drops. */
function facetValueSet(facets: TimelineFacets, facet: keyof TimelineFacets): Set<string> {
  return new Set(facets[facet].map((value: FacetValue) => value.value));
}

/**
 * Reads state from a query string, keeping only values the current facets and
 * range presets know. An unknown filter value, scale, range, or order is dropped
 * rather than trusted, so a copied URL that predates a data change degrades to a
 * valid view instead of an empty or broken one.
 */
export function parseTimelineState(
  search: string,
  facets: TimelineFacets,
  ranges: readonly TimelineRangeOption[],
): TimelineViewState {
  const params = new URLSearchParams(search);
  const state = defaultTimelineState();

  for (const dimension of TIMELINE_FILTER_DIMENSIONS) {
    const valid = facetValueSet(facets, dimension.facet);
    state.filters[dimension.key] = params
      .getAll(dimension.param)
      .filter((value, index, all) => valid.has(value) && all.indexOf(value) === index);
  }

  const scale = params.get(SCALE_PARAM);
  if (scale && (TIMELINE_SCALES as readonly string[]).includes(scale)) {
    state.scale = scale as TimelineScale;
  }

  const range = params.get(RANGE_PARAM);
  if (range && ranges.some((option) => option.value === range)) state.range = range;

  const order = params.get(ORDER_PARAM);
  if (order && (TIMELINE_ORDERS as readonly string[]).includes(order)) {
    state.order = order as TimelineOrder;
  }

  return state;
}

/**
 * Serializes state to a query string, emitting only what differs from the
 * default so a pristine view has a clean URL. Filter values are written in facet
 * order rather than click order, so two routes to the same selection copy to the
 * same link.
 */
export function serializeTimelineState(
  state: TimelineViewState,
  facets: TimelineFacets,
): string {
  const params = new URLSearchParams();

  for (const dimension of TIMELINE_FILTER_DIMENSIONS) {
    const selected = new Set(state.filters[dimension.key]);
    if (!selected.size) continue;
    for (const facetValue of facets[dimension.facet]) {
      if (selected.has(facetValue.value)) params.append(dimension.param, facetValue.value);
    }
  }

  if (state.scale !== DEFAULT_SCALE) params.set(SCALE_PARAM, state.scale);
  if (state.range !== ALL_TIME) params.set(RANGE_PARAM, state.range);
  if (state.order !== DEFAULT_ORDER) params.set(ORDER_PARAM, state.order);

  const query = params.toString();
  return query ? `?${query}` : '';
}

export interface TimelineRangeBound {
  /** Inclusive lower bound as `YYYY-MM-DD`, or null for no lower bound. */
  from: string | null;
  /** A single calendar year the entries must fall in, or null. */
  year: string | null;
  label: string;
}

/**
 * The window a preset opens, counted back from `now`.
 *
 * A relative preset is anchored to the reader's clock, which a static build
 * cannot know, so `now` is supplied by the caller and is null until the island
 * hydrates. A relative preset with no anchor resolves to no bound rather than to
 * a guessed one, which is also why the server only ever renders the default.
 *
 * The window has no upper bound: an entry dated after the reader's clock stays
 * visible instead of being silently hidden by a preset that reads as "recent".
 */
export function resolveTimelineRange(
  range: string,
  ranges: readonly TimelineRangeOption[],
  now: string | null,
): TimelineRangeBound {
  const option = ranges.find((entry) => entry.value === range)
    ?? ranges.find((entry) => entry.value === ALL_TIME)!;

  if (option.kind === 'year' && option.year) {
    return { from: null, year: option.year, label: option.label };
  }

  if (option.kind === 'relative' && option.months && now) {
    const [year, month, day] = now.split('-').map(Number);
    const anchor = new Date(Date.UTC(year, month - 1 - option.months, day));
    return { from: anchor.toISOString().slice(0, 10), year: null, label: option.label };
  }

  return { from: null, year: null, label: option.label };
}

/**
 * Whether one entry falls in the window. A partial date is measured by the
 * latest instant it could mean, so a `2024` entry still answers a window that
 * opens inside 2024 rather than being dropped for lacking a day.
 */
export function entryInRange(entry: TimelineEntry, bound: TimelineRangeBound): boolean {
  if (bound.year) return timelineEntryYear(entry) === bound.year;
  if (bound.from) return timelineDateCeiling(entry) >= bound.from;
  return true;
}

function matchesFilters(entry: TimelineEntry, filters: TimelineFilters): boolean {
  for (const dimension of TIMELINE_FILTER_DIMENSIONS) {
    const selected = filters[dimension.key];
    if (!selected.length) continue;
    const entryValues = dimension.values(entry);
    if (!selected.some((value) => entryValues.includes(value))) return false;
  }
  return true;
}

export function filterTimelineEntries(
  entries: readonly TimelineEntry[],
  state: TimelineViewState,
  ranges: readonly TimelineRangeOption[],
  now: string | null,
): TimelineEntry[] {
  const bound = resolveTimelineRange(state.range, ranges, now);
  return entries.filter(
    (entry) => matchesFilters(entry, state.filters) && entryInRange(entry, bound),
  );
}

export interface ActiveTimelineFilter {
  key: TimelineFilterKey;
  param: string;
  dimensionLabel: string;
  value: string;
  label: string;
}

/** The active selections, labelled with facet wording, for a filter summary. */
export function activeTimelineFilters(
  state: TimelineViewState,
  facets: TimelineFacets,
): ActiveTimelineFilter[] {
  const active: ActiveTimelineFilter[] = [];
  for (const dimension of TIMELINE_FILTER_DIMENSIONS) {
    const selected = new Set(state.filters[dimension.key]);
    if (!selected.size) continue;
    for (const facetValue of facets[dimension.facet]) {
      if (!selected.has(facetValue.value)) continue;
      active.push({
        key: dimension.key,
        param: dimension.param,
        dimensionLabel: dimension.label,
        value: facetValue.value,
        label: facetValue.label,
      });
    }
  }
  return active;
}

export function hasActiveTimelineFilters(state: TimelineViewState): boolean {
  if (state.range !== ALL_TIME) return true;
  return TIMELINE_FILTER_DIMENSIONS.some((dimension) => state.filters[dimension.key].length > 0);
}

export interface TimelineResults {
  entries: TimelineEntry[];
  stops: TimelineStop[];
  total: number;
  active: ActiveTimelineFilter[];
  range: TimelineRangeBound;
}

/** Filters, then groups into the period stops one state asks for. */
export function deriveTimelineResults(
  entries: readonly TimelineEntry[],
  state: TimelineViewState,
  facets: TimelineFacets,
  ranges: readonly TimelineRangeOption[],
  now: string | null = null,
): TimelineResults {
  const matches = filterTimelineEntries(entries, state, ranges, now);

  return {
    entries: matches,
    stops: groupTimelineEntries(matches, state.scale, state.order),
    total: matches.length,
    active: activeTimelineFilters(state, facets),
    range: resolveTimelineRange(state.range, ranges, now),
  };
}

/** State with one value toggled in a dimension. */
export function toggleTimelineFilter(
  state: TimelineViewState,
  key: TimelineFilterKey,
  value: string,
): TimelineViewState {
  const current = state.filters[key];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return { ...state, filters: { ...state.filters, [key]: next } };
}

/** State with one active filter removed, for the per-filter clear control. */
export function clearTimelineFilter(
  state: TimelineViewState,
  key: TimelineFilterKey,
  value: string,
): TimelineViewState {
  return {
    ...state,
    filters: {
      ...state.filters,
      [key]: state.filters[key].filter((entry) => entry !== value),
    },
  };
}

/** State with every filter and the range cleared, keeping scale and order. */
export function clearAllTimelineFilters(state: TimelineViewState): TimelineViewState {
  return { ...state, filters: emptyFilters(), range: ALL_TIME };
}
