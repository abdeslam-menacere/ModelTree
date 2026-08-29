import type {
  HomeReleaseRow,
  HomeSearchFacets,
  HomeSuggestion,
  HomepageSearchIndex,
} from './homepage-search';
import { normalizeText, releaseMatchesQuery } from './homepage-search';

/**
 * The shareable state of the homepage search: the query text, the active filters
 * across four dimensions, and an optionally selected release. It round-trips
 * through query parameters so a reload, a browser back/forward, and a copied
 * link all restore the same view. Nothing here mutates the index or the dataset;
 * every derivation returns a fresh value.
 */

export type HomeFilterKey = 'categories' | 'access' | 'statuses' | 'periods';

export interface HomeFilterDimension {
  key: HomeFilterKey;
  /** The query-string key this dimension round-trips through. */
  param: string;
  /** The facet list its valid values and labels come from. */
  facet: keyof HomeSearchFacets;
  label: string;
  /** The value(s) a release row contributes to this dimension. */
  values: (row: HomeReleaseRow) => string[];
}

/** Declared once so parsing, serializing, and filtering can never drift apart. */
export const HOME_FILTER_DIMENSIONS: readonly HomeFilterDimension[] = [
  {
    key: 'categories',
    param: 'category',
    facet: 'categories',
    label: 'Category',
    values: (row) => row.categories,
  },
  {
    key: 'access',
    param: 'access',
    facet: 'access',
    label: 'Access',
    values: (row) => [row.accessType],
  },
  {
    key: 'statuses',
    param: 'status',
    facet: 'statuses',
    label: 'Status',
    values: (row) => [row.status],
  },
  {
    key: 'periods',
    param: 'period',
    facet: 'periods',
    label: 'Release period',
    values: (row) => [row.releaseYear],
  },
];

export const HOME_SEARCH_PARAM = 'q';
export const HOME_SELECTED_PARAM = 'sel';

export type HomeFilters = Record<HomeFilterKey, string[]>;

export interface HomeSearchState {
  query: string;
  filters: HomeFilters;
  /** The selected release slug, or null when nothing is pinned. */
  selected: string | null;
}

function emptyFilters(): HomeFilters {
  return { categories: [], access: [], statuses: [], periods: [] };
}

export function defaultHomeSearchState(): HomeSearchState {
  return { query: '', filters: emptyFilters(), selected: null };
}

function facetValueSet(facets: HomeSearchFacets, facet: keyof HomeSearchFacets): Set<string> {
  return new Set(facets[facet].map((value) => value.value));
}

/**
 * Reads state from a query string, keeping only values the current index knows.
 * An unknown filter value or a selection slug that is no longer a homepage
 * release is dropped rather than trusted, so a copied URL that predates a data
 * change degrades to a valid view instead of a broken one.
 */
export function parseHomeSearchState(
  search: string,
  index: HomepageSearchIndex,
): HomeSearchState {
  const params = new URLSearchParams(search);
  const state = defaultHomeSearchState();

  state.query = (params.get(HOME_SEARCH_PARAM) ?? '').trim();

  for (const dimension of HOME_FILTER_DIMENSIONS) {
    const valid = facetValueSet(index.facets, dimension.facet);
    state.filters[dimension.key] = params
      .getAll(dimension.param)
      .filter((value, position, all) => valid.has(value) && all.indexOf(value) === position);
  }

  const selected = params.get(HOME_SELECTED_PARAM);
  const validSlugs = new Set(index.releases.map((row) => row.slug));
  state.selected = selected && validSlugs.has(selected) ? selected : null;

  return state;
}

/**
 * Serializes state to a query string, emitting only what departs from the
 * default so a pristine view has a clean URL. Filter values are written in facet
 * order rather than click order, so two routes to the same selection copy to the
 * same link. A selection is emitted only when it is still a homepage release.
 */
export function serializeHomeSearchState(
  state: HomeSearchState,
  index: HomepageSearchIndex,
): string {
  const params = new URLSearchParams();

  if (state.query) params.set(HOME_SEARCH_PARAM, state.query);

  for (const dimension of HOME_FILTER_DIMENSIONS) {
    const selected = new Set(state.filters[dimension.key]);
    if (!selected.size) continue;
    for (const facetValue of index.facets[dimension.facet]) {
      if (selected.has(facetValue.value)) params.append(dimension.param, facetValue.value);
    }
  }

  if (state.selected && index.releases.some((row) => row.slug === state.selected)) {
    params.set(HOME_SELECTED_PARAM, state.selected);
  }

  const query = params.toString();
  return query ? `?${query}` : '';
}

function matchesFilters(row: HomeReleaseRow, filters: HomeFilters): boolean {
  for (const dimension of HOME_FILTER_DIMENSIONS) {
    const selected = filters[dimension.key];
    if (!selected.length) continue;
    const rowValues = dimension.values(row);
    if (!selected.some((value) => rowValues.includes(value))) return false;
  }
  return true;
}

/** Releases satisfying the query and every active filter, in index order. */
export function filterHomeReleases(
  index: HomepageSearchIndex,
  state: HomeSearchState,
): HomeReleaseRow[] {
  return index.releases.filter(
    (row) => releaseMatchesQuery(row, state.query) && matchesFilters(row, state.filters),
  );
}

export interface HomeActiveFilter {
  key: HomeFilterKey;
  param: string;
  dimensionLabel: string;
  value: string;
  label: string;
}

/** The active selections, labelled with facet wording, for a filter summary. */
export function homeActiveFilters(
  state: HomeSearchState,
  facets: HomeSearchFacets,
): HomeActiveFilter[] {
  const active: HomeActiveFilter[] = [];
  for (const dimension of HOME_FILTER_DIMENSIONS) {
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

export function hasActiveFilters(state: HomeSearchState): boolean {
  return HOME_FILTER_DIMENSIONS.some((dimension) => state.filters[dimension.key].length > 0);
}

export function hasActiveQueryOrFilters(state: HomeSearchState): boolean {
  return Boolean(state.query) || hasActiveFilters(state);
}

export interface HomeSearchResults {
  matches: HomeReleaseRow[];
  total: number;
  active: HomeActiveFilter[];
  /** The pinned release, only when it survives the current query and filters. */
  selected: HomeReleaseRow | null;
}

/**
 * Filters the index for one state and resolves the active selection against the
 * visible results, so a selection that a filter has excluded is not reported as
 * shown. Never mutates the index.
 */
export function deriveHomeSearchResults(
  index: HomepageSearchIndex,
  state: HomeSearchState,
): HomeSearchResults {
  const matches = filterHomeReleases(index, state);
  const selected = state.selected
    ? matches.find((row) => row.slug === state.selected) ?? null
    : null;
  return {
    matches,
    total: matches.length,
    active: homeActiveFilters(state, index.facets),
    selected,
  };
}

/**
 * Suggestions whose term contains the query, entity-typed for disambiguation and
 * capped so the listbox stays bounded. The query is normalized the same way the
 * suggestions are, so a query that reduces to nothing — empty, whitespace, or
 * punctuation-only such as `-` or `!!!` — yields no suggestions rather than
 * matching everything, keeping the default view uncluttered.
 */
export function homeSuggestionsFor(
  index: HomepageSearchIndex,
  query: string,
  limit = 8,
): HomeSuggestion[] {
  const normalizedNeedle = normalizeText(query);
  if (!normalizedNeedle) return [];
  return index.suggestions
    .filter((suggestion) => suggestion.normalized.includes(normalizedNeedle))
    .slice(0, limit);
}

/**
 * State with one value toggled in a dimension. The selection is preserved here;
 * whether it still shows under the new filters is reconciled by
 * {@link deriveHomeSearchResults}, not asserted at toggle time.
 */
export function toggleHomeFilterValue(
  state: HomeSearchState,
  key: HomeFilterKey,
  value: string,
): HomeSearchState {
  const current = state.filters[key];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return {
    ...state,
    filters: { ...state.filters, [key]: next },
  };
}

/** State with one active filter removed, for the per-filter clear control. */
export function clearHomeFilterValue(
  state: HomeSearchState,
  key: HomeFilterKey,
  value: string,
): HomeSearchState {
  return {
    ...state,
    filters: {
      ...state.filters,
      [key]: state.filters[key].filter((entry) => entry !== value),
    },
  };
}

/** State with the query, every filter, and the selection cleared. */
export function clearAllHomeFilters(state: HomeSearchState): HomeSearchState {
  return { ...state, query: '', filters: emptyFilters(), selected: null };
}
