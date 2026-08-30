import type { FacetValue } from './catalog';
import type { UpdateFacets, UpdateRecord, UpdateYearGroup } from './updates';
import { groupUpdatesByPeriod } from './updates';

/**
 * The shareable view state of `/updates`, as query parameters.
 *
 * Query parameters rather than route segments, for two reasons that both come
 * from outside this module. `docs/product/INFORMATION-ARCHITECTURE.md` states
 * that every user selection defining a useful view uses stable query parameters,
 * and `/models`, `/compare`, `/benchmarks` and `/timeline` all already do. So a
 * creator selected here is spelled the way a creator is spelled everywhere else
 * on the site, and a reader who has learned one of these URLs has learned them
 * all.
 *
 * The parameter names are the catalog's own — `creator`, `category`. Nothing in
 * the catalog reads this module; it is reuse of the vocabulary, not of the
 * behaviour.
 *
 * Filtering is scoped to creator and category because that is what the issue
 * scopes it to. Event type is deliberately *not* a filter: it is rendered as
 * explicit words on every record and counted in a legend, so the kinds stay
 * distinguishable without a control that could hide a deprecation from someone
 * who did not think to ask for one.
 */

export type UpdateFilterKey = 'creators' | 'categories';

export interface UpdateFilterDimension {
  key: UpdateFilterKey;
  param: string;
  facet: keyof UpdateFacets;
  label: string;
  values: (record: UpdateRecord) => readonly string[];
}

/** Declared once, so parsing, serializing and filtering cannot drift apart. */
export const UPDATE_FILTER_DIMENSIONS: readonly UpdateFilterDimension[] = [
  {
    key: 'creators',
    param: 'creator',
    facet: 'creators',
    label: 'Creator',
    values: (record) => [record.creatorSlug],
  },
  {
    key: 'categories',
    param: 'category',
    facet: 'categories',
    label: 'Category',
    values: (record) => record.categories,
  },
];

export type UpdateFilters = Record<UpdateFilterKey, string[]>;

export interface UpdateViewState {
  filters: UpdateFilters;
}

function emptyFilters(): UpdateFilters {
  return { creators: [], categories: [] };
}

export function defaultUpdateState(): UpdateViewState {
  return { filters: emptyFilters() };
}

/** Valid values per dimension, taken from the facets so an unknown value drops. */
function facetValueSet(facets: UpdateFacets, facet: keyof UpdateFacets): Set<string> {
  return new Set(facets[facet].map((value: FacetValue) => value.value));
}

/**
 * Reads state from a query string, keeping only values the current facets know.
 *
 * An unknown value is dropped rather than trusted, so a link copied before a
 * data refresh degrades to a valid view instead of an empty or broken one. A
 * creator that leaves the dataset takes its filter with it, and the reader sees
 * the whole ledger rather than a page insisting nothing matches.
 */
export function parseUpdateState(search: string, facets: UpdateFacets): UpdateViewState {
  const params = new URLSearchParams(search);
  const state = defaultUpdateState();

  for (const dimension of UPDATE_FILTER_DIMENSIONS) {
    const valid = facetValueSet(facets, dimension.facet);
    state.filters[dimension.key] = params
      .getAll(dimension.param)
      .filter((value, index, all) => valid.has(value) && all.indexOf(value) === index);
  }

  return state;
}

/**
 * Serializes state to a query string, emitting only what differs from the
 * default so a pristine view has a clean URL.
 *
 * Values are written in facet order rather than in the order they were clicked,
 * so two readers who arrive at the same selection by different routes copy the
 * same link.
 */
export function serializeUpdateState(state: UpdateViewState, facets: UpdateFacets): string {
  const params = new URLSearchParams();

  for (const dimension of UPDATE_FILTER_DIMENSIONS) {
    const selected = new Set(state.filters[dimension.key]);
    if (!selected.size) continue;
    for (const facetValue of facets[dimension.facet]) {
      if (selected.has(facetValue.value)) params.append(dimension.param, facetValue.value);
    }
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

function matchesFilters(record: UpdateRecord, filters: UpdateFilters): boolean {
  for (const dimension of UPDATE_FILTER_DIMENSIONS) {
    const selected = filters[dimension.key];
    if (!selected.length) continue;
    const recordValues = dimension.values(record);
    if (!selected.some((value) => recordValues.includes(value))) return false;
  }
  return true;
}

export function filterUpdateRecords(
  records: readonly UpdateRecord[],
  state: UpdateViewState,
): UpdateRecord[] {
  return records.filter((record) => matchesFilters(record, state.filters));
}

export interface ActiveUpdateFilter {
  key: UpdateFilterKey;
  param: string;
  dimensionLabel: string;
  value: string;
  label: string;
}

/** The active selections, labelled with facet wording, for the filter summary. */
export function activeUpdateFilters(
  state: UpdateViewState,
  facets: UpdateFacets,
): ActiveUpdateFilter[] {
  const active: ActiveUpdateFilter[] = [];

  for (const dimension of UPDATE_FILTER_DIMENSIONS) {
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

export function hasActiveUpdateFilters(state: UpdateViewState): boolean {
  return UPDATE_FILTER_DIMENSIONS.some((dimension) => state.filters[dimension.key].length > 0);
}

export interface UpdateResults {
  records: UpdateRecord[];
  years: UpdateYearGroup[];
  total: number;
  active: ActiveUpdateFilter[];
}

/** Filters, then groups into the year and month rails the page renders. */
export function deriveUpdateResults(
  records: readonly UpdateRecord[],
  state: UpdateViewState,
  facets: UpdateFacets,
): UpdateResults {
  const matches = filterUpdateRecords(records, state);

  return {
    records: matches,
    years: groupUpdatesByPeriod(matches),
    total: matches.length,
    active: activeUpdateFilters(state, facets),
  };
}

/** State with one value toggled in a dimension. */
export function toggleUpdateFilter(
  state: UpdateViewState,
  key: UpdateFilterKey,
  value: string,
): UpdateViewState {
  const current = state.filters[key];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return { ...state, filters: { ...state.filters, [key]: next } };
}

/** State with one active filter removed, for the per-filter clear control. */
export function clearUpdateFilter(
  state: UpdateViewState,
  key: UpdateFilterKey,
  value: string,
): UpdateViewState {
  return {
    ...state,
    filters: {
      ...state.filters,
      [key]: state.filters[key].filter((entry) => entry !== value),
    },
  };
}

export function clearAllUpdateFilters(): UpdateViewState {
  return defaultUpdateState();
}

/**
 * The event id a URL fragment points at, or null.
 *
 * A link to one update is `#event-<id>`, which resolves in the static HTML
 * without any of this running. This exists for the case the fragment alone
 * cannot cover: a link that also carries filters excluding the very record it
 * points at. The page can then say so and offer to clear them, rather than
 * scrolling to nothing.
 */
export function anchorTargetId(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  return fragment.startsWith('event-') ? fragment : null;
}

/**
 * Whether a fragment names a record the current filters have hidden. Null when
 * the fragment names nothing in this ledger, which is not this page's problem to
 * report — an unknown id is a stale or mistyped link, not a filtered-out record.
 */
export function hiddenAnchorRecord(
  hash: string,
  allRecords: readonly UpdateRecord[],
  visibleRecords: readonly UpdateRecord[],
): UpdateRecord | null {
  const anchorId = anchorTargetId(hash);
  if (!anchorId) return null;

  const target = allRecords.find((record) => record.anchorId === anchorId);
  if (!target) return null;

  return visibleRecords.some((record) => record.id === target.id) ? null : target;
}
