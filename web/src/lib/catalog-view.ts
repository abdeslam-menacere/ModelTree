import type {
  CatalogFacets,
  FacetValue,
  ModelIndexRow,
  ModelSort,
} from './catalog';
import { planPagination, sortModels } from './catalog';

export type CatalogView = 'table' | 'list';

/**
 * One selectable filter dimension. The key names the field on the state object;
 * the param names the query-string key it round-trips through; the facet names
 * the {@link CatalogFacets} list its valid values and labels come from; and
 * `values` reads the value(s) a model row contributes to that dimension.
 */
export interface FilterDimension {
  key: FilterKey;
  param: string;
  facet: keyof CatalogFacets;
  label: string;
  values: (row: ModelIndexRow) => string[];
}

export type FilterKey =
  | 'creators'
  | 'families'
  | 'categories'
  | 'modalities'
  | 'accessTypes'
  | 'statuses'
  | 'releaseYears'
  | 'contextTiers'
  | 'priceAvailability';

/** Declared once so parsing, serializing, and filtering can never drift apart. */
export const FILTER_DIMENSIONS: readonly FilterDimension[] = [
  {
    key: 'creators',
    param: 'creator',
    facet: 'creators',
    label: 'Creator',
    values: (row) => [row.organizationSlug],
  },
  {
    key: 'families',
    param: 'family',
    facet: 'families',
    label: 'Family',
    values: (row) => [row.familySlug],
  },
  {
    key: 'categories',
    param: 'category',
    facet: 'categories',
    label: 'Category',
    values: (row) => row.categories,
  },
  {
    key: 'modalities',
    param: 'modality',
    facet: 'modalities',
    label: 'Modality',
    values: (row) => [...new Set([...row.inputModalities, ...row.outputModalities])],
  },
  {
    key: 'accessTypes',
    param: 'access',
    facet: 'accessTypes',
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
    key: 'releaseYears',
    param: 'year',
    facet: 'releaseYears',
    label: 'Year',
    values: (row) => [row.releaseDate.slice(0, 4)],
  },
  {
    key: 'contextTiers',
    param: 'tier',
    facet: 'contextTiers',
    label: 'Context tier',
    values: (row) => [row.contextTier],
  },
  {
    key: 'priceAvailability',
    param: 'price',
    facet: 'priceAvailability',
    label: 'Price availability',
    values: (row) => [row.hasPublishedPrice ? 'published' : 'not-published'],
  },
];

export const MODEL_SORTS: readonly ModelSort[] = ['release-date', 'name', 'recently-verified'];
export const CATALOG_VIEWS: readonly CatalogView[] = ['table', 'list'];

export const SORT_LABELS: Record<ModelSort, string> = {
  'release-date': 'Newest first',
  name: 'Name (A–Z)',
  'recently-verified': 'Recently verified',
};

/** One page slice at a time keeps a shipped page bounded regardless of catalog size. */
export const CATALOG_PAGE_SIZE = 24;

export const SEARCH_PARAM = 'q';
export const SORT_PARAM = 'sort';
export const VIEW_PARAM = 'view';
export const PAGE_PARAM = 'page';

export type CatalogFilters = Record<FilterKey, string[]>;

export interface CatalogViewState {
  search: string;
  filters: CatalogFilters;
  sort: ModelSort;
  view: CatalogView;
  page: number;
}

function emptyFilters(): CatalogFilters {
  return {
    creators: [],
    families: [],
    categories: [],
    modalities: [],
    accessTypes: [],
    statuses: [],
    releaseYears: [],
    contextTiers: [],
    priceAvailability: [],
  };
}

export function defaultCatalogState(): CatalogViewState {
  return {
    search: '',
    filters: emptyFilters(),
    sort: 'release-date',
    view: 'table',
    page: 1,
  };
}

/** Valid values per dimension, taken from the facets so an unknown value drops. */
function facetValueSet(facets: CatalogFacets, facet: keyof CatalogFacets): Set<string> {
  return new Set(facets[facet].map((value: FacetValue) => value.value));
}

/**
 * Reads state from a query string, keeping only values the current facets know.
 * An unknown filter value, sort, or view is dropped rather than trusted, so a
 * copied URL that predates a data change degrades to a valid view instead of an
 * empty or broken one. Page is clamped to a positive integer; it is bounded
 * against the result count by {@link deriveCatalogResults}, which alone knows it.
 */
export function parseCatalogState(
  search: string,
  facets: CatalogFacets,
): CatalogViewState {
  const params = new URLSearchParams(search);
  const state = defaultCatalogState();

  state.search = (params.get(SEARCH_PARAM) ?? '').trim();

  for (const dimension of FILTER_DIMENSIONS) {
    const valid = facetValueSet(facets, dimension.facet);
    const selected = params
      .getAll(dimension.param)
      .filter((value, index, all) => valid.has(value) && all.indexOf(value) === index);
    state.filters[dimension.key] = selected;
  }

  const sort = params.get(SORT_PARAM);
  if (sort && (MODEL_SORTS as readonly string[]).includes(sort)) {
    state.sort = sort as ModelSort;
  }

  const view = params.get(VIEW_PARAM);
  if (view && (CATALOG_VIEWS as readonly string[]).includes(view)) {
    state.view = view as CatalogView;
  }

  const page = Number(params.get(PAGE_PARAM));
  if (Number.isInteger(page) && page >= 1) state.page = page;

  return state;
}

/**
 * Serializes state to a query string, emitting only what differs from the
 * default so a pristine view has a clean URL. Filter values are written in
 * facet order rather than click order, so two routes to the same selection copy
 * to the same link.
 */
export function serializeCatalogState(
  state: CatalogViewState,
  facets: CatalogFacets,
): string {
  const params = new URLSearchParams();

  if (state.search) params.set(SEARCH_PARAM, state.search);

  for (const dimension of FILTER_DIMENSIONS) {
    const selected = new Set(state.filters[dimension.key]);
    if (!selected.size) continue;
    for (const facetValue of facets[dimension.facet]) {
      if (selected.has(facetValue.value)) params.append(dimension.param, facetValue.value);
    }
  }

  if (state.sort !== 'release-date') params.set(SORT_PARAM, state.sort);
  if (state.view !== 'table') params.set(VIEW_PARAM, state.view);
  if (state.page > 1) params.set(PAGE_PARAM, String(state.page));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * A row matches when the needle is in its name, its family, or *either* of its
 * creator's recorded name forms. Matching only the label would mean a reader
 * who knows the creator by the fuller recorded form finds nothing, which is the
 * regression this restores (abdeslam-menacere/ModelTree#479).
 */
function matchesSearch(row: ModelIndexRow, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return (
    row.name.toLowerCase().includes(needle)
    || row.familyName.toLowerCase().includes(needle)
    || row.organizationName.toLowerCase().includes(needle)
    || (row.organizationFullName?.toLowerCase().includes(needle) ?? false)
  );
}

function matchesFilters(row: ModelIndexRow, filters: CatalogFilters): boolean {
  for (const dimension of FILTER_DIMENSIONS) {
    const selected = filters[dimension.key];
    if (!selected.length) continue;
    const rowValues = dimension.values(row);
    if (!selected.some((value) => rowValues.includes(value))) return false;
  }
  return true;
}

/** Rows that satisfy the search and every active filter, in the chosen order. */
export function filterAndSortModels(
  rows: readonly ModelIndexRow[],
  state: CatalogViewState,
): ModelIndexRow[] {
  const matched = rows.filter(
    (row) => matchesSearch(row, state.search) && matchesFilters(row, state.filters),
  );
  return sortModels(matched, state.sort);
}

export interface ActiveFilter {
  key: FilterKey;
  param: string;
  dimensionLabel: string;
  value: string;
  label: string;
}

/** The active selections, labelled with facet wording, for a filter summary. */
export function activeFilters(
  state: CatalogViewState,
  facets: CatalogFacets,
): ActiveFilter[] {
  const active: ActiveFilter[] = [];
  for (const dimension of FILTER_DIMENSIONS) {
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

export function hasActiveFilters(state: CatalogViewState): boolean {
  if (state.search) return true;
  return FILTER_DIMENSIONS.some((dimension) => state.filters[dimension.key].length > 0);
}

export interface CatalogResults {
  /** Every row that passed the filters, sorted; the count summary reads this. */
  matches: ModelIndexRow[];
  /** Just the current page's rows, the only slice a page ships. */
  pageRows: ModelIndexRow[];
  total: number;
  page: number;
  pageCount: number;
  pageStart: number;
  pageEnd: number;
  active: ActiveFilter[];
}

/**
 * Filters, sorts, and pages the catalog for one state. Page is clamped into
 * `[1, pageCount]` here — the only place the post-filter page count is known —
 * so a deep link to page 9 of a two-page result lands on the last page rather
 * than an empty one, and never leaves a valid page unreachable.
 */
export function deriveCatalogResults(
  rows: readonly ModelIndexRow[],
  state: CatalogViewState,
  facets: CatalogFacets,
  pageSize: number = CATALOG_PAGE_SIZE,
): CatalogResults {
  const matches = filterAndSortModels(rows, state);
  const plan = planPagination(
    matches.map((row) => row.slug),
    pageSize,
  );
  const pageCount = plan.pageCount;
  const page = pageCount === 0 ? 1 : Math.min(Math.max(state.page, 1), pageCount);
  const current = plan.pages[page - 1];
  const pageRows = current ? matches.slice(current.start, current.end + 1) : [];

  return {
    matches,
    pageRows,
    total: matches.length,
    page,
    pageCount,
    pageStart: current ? current.start + 1 : 0,
    pageEnd: current ? current.end + 1 : 0,
    active: activeFilters(state, facets),
  };
}

/** State with one value toggled in a dimension, page reset so the result is visible. */
export function toggleFilterValue(
  state: CatalogViewState,
  key: FilterKey,
  value: string,
): CatalogViewState {
  const current = state.filters[key];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return {
    ...state,
    filters: { ...state.filters, [key]: next },
    page: 1,
  };
}

/** State with one active filter removed, for the per-filter clear control. */
export function clearFilterValue(
  state: CatalogViewState,
  key: FilterKey,
  value: string,
): CatalogViewState {
  return {
    ...state,
    filters: {
      ...state.filters,
      [key]: state.filters[key].filter((entry) => entry !== value),
    },
    page: 1,
  };
}

/** State with search and every filter cleared, keeping sort and view. */
export function clearAllFilters(state: CatalogViewState): CatalogViewState {
  return {
    ...state,
    search: '',
    filters: emptyFilters(),
    page: 1,
  };
}
