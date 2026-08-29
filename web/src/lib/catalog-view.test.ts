import { describe, expect, it } from 'vitest';
import { validateDataset } from '../data/validate';
import { buildCatalogIndex } from './catalog';
import type { CatalogFacets, CatalogIndex, ModelIndexRow } from './catalog';
import {
  activeFilters,
  CATALOG_PAGE_SIZE,
  clearAllFilters,
  clearFilterValue,
  defaultCatalogState,
  deriveCatalogResults,
  FILTER_DIMENSIONS,
  filterAndSortModels,
  hasActiveFilters,
  MODEL_SORTS,
  parseCatalogState,
  serializeCatalogState,
  toggleFilterValue,
  type CatalogViewState,
  type FilterKey,
} from './catalog-view';

function release(
  id: string,
  organizationId: string,
  familyId: string,
  releaseDate: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    slug: id,
    canonicalName: id,
    displayName: id,
    organizationId,
    familyId,
    version: '1',
    variant: 'Standard',
    releaseDate,
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    summary: 'A fixture release.',
    intendedUse: 'Fixture use.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
    ...extra,
  };
}

function makeIndex(overrides: Record<string, unknown> = {}): CatalogIndex {
  const dataset = validateDataset({
    sources: [{
      id: 'src-a',
      url: 'https://example.com/a',
      title: 'Announcement',
      type: 'official-announcement',
      publisherId: 'example',
      lastCheckedDate: '2026-01-01',
    }, {
      // A release recording `license.osiApproved` has to cite OSI at either
      // value, so the two licence-bearing fixtures below carry this.
      id: 'osi-list',
      url: 'https://opensource.org/licenses',
      title: 'OSI Approved Licenses',
      type: 'official-docs',
      publisherId: 'open-source-initiative',
      lastCheckedDate: '2026-01-01',
    }],
    publishers: [
      { id: 'example', name: 'Example' },
      { id: 'open-source-initiative', name: 'Open Source Initiative' },
    ],
    organizations: [
      {
        id: 'alpha',
        slug: 'alpha',
        name: 'Alpha Labs',
        shortName: 'Alpha',
        type: 'company',
        website: 'https://alpha.example/',
        releasePage: 'https://alpha.example/news',
        description: 'Fixture creator.',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
      {
        id: 'beta',
        slug: 'beta',
        name: 'Beta Corp',
        shortName: 'Beta',
        type: 'company',
        website: 'https://beta.example/',
        releasePage: 'https://beta.example/news',
        description: 'Fixture creator.',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
    ],
    families: [
      {
        id: 'alpha-one',
        slug: 'alpha-one',
        organizationId: 'alpha',
        name: 'Alpha One',
        description: 'Fixture family.',
        categories: ['language-reasoning'],
        firstReleaseDate: '2023-01-01',
        datePrecision: 'day',
        status: 'current',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
      {
        id: 'alpha-two',
        slug: 'alpha-two',
        organizationId: 'alpha',
        name: 'Alpha Two',
        description: 'Fixture family.',
        categories: ['coding'],
        firstReleaseDate: '2023-01-01',
        datePrecision: 'day',
        status: 'current',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
      {
        id: 'beta-one',
        slug: 'beta-one',
        organizationId: 'beta',
        name: 'Beta One',
        description: 'Fixture family.',
        categories: ['image'],
        firstReleaseDate: '2023-01-01',
        datePrecision: 'day',
        status: 'current',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
    ],
    releases: [
      release('alpha-lang', 'alpha', 'alpha-one', '2025-06-01', {
        categories: ['language-reasoning'],
        contextWindow: 64_000,
        verifiedAt: '2026-02-01',
      }),
      release('alpha-code', 'alpha', 'alpha-two', '2024-03-01', {
        categories: ['coding'],
        status: 'preview',
        accessType: 'open-weight',
        inputModalities: ['text', 'video'],
        contextWindow: 500_000,
        license: { name: 'Apache-2.0', weightsDownloadable: true, osiApproved: false },
        sourceIds: ['src-a', 'osi-list'],
        verifiedAt: '2026-01-15',
      }),
      release('beta-image', 'beta', 'beta-one', '2025-01-01', {
        categories: ['image'],
        accessType: 'both',
        inputModalities: ['text', 'image'],
        outputModalities: ['image', 'audio'],
        contextWindow: 2_000_000,
        license: { name: 'Llama-3', weightsDownloadable: true, osiApproved: false },
        sourceIds: ['src-a', 'osi-list'],
        verifiedAt: '2026-01-10',
      }),
      release('beta-legacy', 'beta', 'beta-one', '2023-11-01', {
        categories: ['image', 'multimodal-generalist'],
        status: 'legacy',
        accessType: 'source-available',
        verifiedAt: '2026-01-05',
      }),
    ],
    servingPlatforms: [{
      id: 'alpha-api',
      slug: 'alpha-api',
      name: 'Alpha API',
      organizationId: 'alpha',
      type: 'first-party-api',
      website: 'https://alpha.example/api',
      sourceIds: ['src-a'],
      verifiedAt: '2026-01-01',
    }],
    deployments: [{
      id: 'alpha-lang-on-alpha-api',
      releaseId: 'alpha-lang',
      platformId: 'alpha-api',
      deliveryMode: 'hosted-api',
      regions: [],
      effectiveFrom: '2025-06-01',
      sourceIds: ['src-a'],
      verifiedAt: '2026-01-01',
    }],
    pricing: [{
      id: 'alpha-lang-price',
      deploymentId: 'alpha-lang-on-alpha-api',
      currency: 'USD',
      unit: 'per-1m-tokens',
      rates: { input: 1 },
      effectiveFrom: '2025-06-01',
      sourceIds: ['src-a'],
      verifiedAt: '2026-01-01',
    }],
    ...overrides,
  });

  return buildCatalogIndex(dataset);
}

const index = makeIndex();
const facets: CatalogFacets = index.facets;
const rows = index.models;

function stateWith(partial: Partial<CatalogViewState>): CatalogViewState {
  const base = defaultCatalogState();
  return {
    ...base,
    ...partial,
    filters: { ...base.filters, ...(partial.filters ?? {}) },
  };
}

describe('parseCatalogState', () => {
  it('reads search, sort, view, and page from the query', () => {
    const state = parseCatalogState('?q=alpha&sort=name&view=list&page=2', facets);

    expect(state.search).toBe('alpha');
    expect(state.sort).toBe('name');
    expect(state.view).toBe('list');
    expect(state.page).toBe(2);
  });

  it('keeps only facet values it recognises, and de-duplicates them', () => {
    const state = parseCatalogState(
      '?creator=alpha&creator=alpha&creator=ghost&category=coding',
      facets,
    );

    expect(state.filters.creators).toEqual(['alpha']);
    expect(state.filters.categories).toEqual(['coding']);
  });

  it('falls back to defaults for an unknown sort, view, or non-positive page', () => {
    const state = parseCatalogState('?sort=popularity&view=grid&page=0', facets);

    expect(state.sort).toBe('release-date');
    expect(state.view).toBe('table');
    expect(state.page).toBe(1);
  });
});

describe('serializeCatalogState', () => {
  it('emits nothing for a pristine default state', () => {
    expect(serializeCatalogState(defaultCatalogState(), facets)).toBe('');
  });

  it('omits defaults but keeps every non-default choice', () => {
    const query = serializeCatalogState(
      stateWith({ search: 'gpt', sort: 'name', view: 'list', page: 3 }),
      facets,
    );

    expect(query).toBe('?q=gpt&sort=name&view=list&page=3');
  });

  it('writes filter values in facet order regardless of selection order', () => {
    const facetOrder = facets.categories.map((facet) => facet.value);
    const clicked = [...facetOrder].reverse();
    const query = serializeCatalogState(
      stateWith({ filters: { categories: clicked } as never }),
      facets,
    );

    const emitted = new URLSearchParams(query).getAll('category');
    expect(emitted).toEqual(facetOrder);
  });

  it('round-trips a non-trivial state through parse', () => {
    const original = stateWith({
      search: 'alpha',
      sort: 'recently-verified',
      view: 'list',
      page: 2,
      filters: { creators: ['alpha'], categories: ['coding'] } as never,
    });

    const restored = parseCatalogState(serializeCatalogState(original, facets), facets);
    expect(restored).toEqual(original);
  });
});

describe('filterAndSortModels', () => {
  it('returns every row when no filter or search is set', () => {
    expect(filterAndSortModels(rows, defaultCatalogState())).toHaveLength(rows.length);
  });

  // The generic loop below can only prove the filter is wired into the pipeline
  // (a row that carries the value survives) — it CANNOT prove the value accessor
  // is right, because it computes its own expectation from `dimension.values`,
  // the very function under test. Exact-set correctness is pinned separately in
  // PINNED_FILTER_CASES against hand-written literals.
  for (const dimension of FILTER_DIMENSIONS) {
    it(`wires the "${dimension.key}" filter into the pipeline`, () => {
      const value = index.facets[dimension.facet][0].value;
      const state = stateWith({ filters: { [dimension.key]: [value] } as never });
      const result = filterAndSortModels(rows, state);

      const expected = rows.filter((row) => dimension.values(row).includes(value));
      expect(result.map((row) => row.slug).sort()).toEqual(
        expected.map((row) => row.slug).sort(),
      );
      expect(result.length).toBeGreaterThan(0);
    });
  }

  // Hand-pinned expectations: the expected slug set for each dimension is a
  // literal, NOT computed from `dimension.values` (the accessor under test).
  // The loop above can only falsify the filter plumbing; a wrong `values`
  // accessor — e.g. `modalities` reading input but not output modalities —
  // stays green there because both sides use the same wrong function. These
  // literals catch that class of fault, and each guards a specific direction:
  // `categories=multimodal-generalist` is carried by a NON-first category value
  // (rows sort categories), so it fails if only the first is read;
  // `modalities=audio` is an output-only value and `modalities=video` an
  // input-only value, so dropping either side of the modality union reddens one.
  const PINNED_FILTER_CASES: ReadonlyArray<{ key: FilterKey; value: string; expected: string[] }> = [
    { key: 'creators', value: 'alpha', expected: ['alpha-code', 'alpha-lang'] },
    { key: 'families', value: 'beta-one', expected: ['beta-image', 'beta-legacy'] },
    { key: 'categories', value: 'image', expected: ['beta-image', 'beta-legacy'] },
    { key: 'categories', value: 'multimodal-generalist', expected: ['beta-legacy'] },
    { key: 'modalities', value: 'audio', expected: ['beta-image'] },
    { key: 'modalities', value: 'video', expected: ['alpha-code'] },
    { key: 'accessTypes', value: 'open-weight', expected: ['alpha-code'] },
    { key: 'statuses', value: 'current', expected: ['alpha-lang', 'beta-image'] },
    { key: 'releaseYears', value: '2025', expected: ['alpha-lang', 'beta-image'] },
    { key: 'contextTiers', value: '1m-and-above', expected: ['beta-image'] },
    { key: 'priceAvailability', value: 'published', expected: ['alpha-lang'] },
  ];

  for (const testCase of PINNED_FILTER_CASES) {
    it(`selects the literal rows for "${testCase.key}=${testCase.value}"`, () => {
      const state = stateWith({ filters: { [testCase.key]: [testCase.value] } as never });
      const result = filterAndSortModels(rows, state);
      expect(result.map((row) => row.slug).sort()).toEqual(testCase.expected);
    });
  }

  it('treats multiple values in one dimension as OR', () => {
    const state = stateWith({ filters: { accessTypes: ['open-weight', 'both'] } as never });
    const result = filterAndSortModels(rows, state);

    expect(result.map((row) => row.slug).sort()).toEqual(['alpha-code', 'beta-image']);
  });

  it('treats values across dimensions as AND', () => {
    const both = stateWith({
      filters: { creators: ['beta'], categories: ['image'] } as never,
    });
    expect(filterAndSortModels(rows, both).map((row) => row.slug).sort())
      .toEqual(['beta-image', 'beta-legacy']);

    const contradiction = stateWith({
      filters: { creators: ['alpha'], categories: ['image'] } as never,
    });
    expect(filterAndSortModels(rows, contradiction)).toHaveLength(0);
  });

  it('matches search against model, family, and creator names case-insensitively', () => {
    expect(filterAndSortModels(rows, stateWith({ search: 'BETA' })).map((row) => row.slug).sort())
      .toEqual(['beta-image', 'beta-legacy']);
    expect(filterAndSortModels(rows, stateWith({ search: 'two alpha' }))).toHaveLength(0);
    expect(filterAndSortModels(rows, stateWith({ search: 'Alpha Two' })).map((row) => row.slug))
      .toEqual(['alpha-code']);
  });

  it('matches search on the creator name alone, case-insensitively', () => {
    // "Labs" appears only in the organization name "Alpha Labs" — not in any
    // model name ("alpha-lang"/"alpha-code") or family name ("Alpha One"/"Two").
    // So this isolates the creator-name clause of the search predicate.
    expect(filterAndSortModels(rows, stateWith({ search: 'LABS' })).map((row) => row.slug).sort())
      .toEqual(['alpha-code', 'alpha-lang']);
  });

  it('matches search on the model name alone, case-insensitively', () => {
    // "lang" appears only in the model name "alpha-lang" — not in its family
    // ("Alpha One") or creator ("Alpha Labs"), and in no other row. So this
    // isolates the model-name clause; deleting it would make this return [].
    expect(filterAndSortModels(rows, stateWith({ search: 'LANG' })).map((row) => row.slug))
      .toEqual(['alpha-lang']);
  });

  it('orders results by each supported sort', () => {
    expect(filterAndSortModels(rows, stateWith({ sort: 'release-date' })).map((row) => row.slug))
      .toEqual(['alpha-lang', 'beta-image', 'alpha-code', 'beta-legacy']);
    expect(filterAndSortModels(rows, stateWith({ sort: 'name' })).map((row) => row.slug))
      .toEqual(['alpha-code', 'alpha-lang', 'beta-image', 'beta-legacy']);
    expect(filterAndSortModels(rows, stateWith({ sort: 'recently-verified' })).map((row) => row.slug))
      .toEqual(['alpha-lang', 'alpha-code', 'beta-image', 'beta-legacy']);
  });

  it('exposes exactly the three supported sorts and no ranking sort', () => {
    expect([...MODEL_SORTS]).toEqual(['release-date', 'name', 'recently-verified']);
  });
});

describe('deriveCatalogResults', () => {
  it('reports totals and the active-filter summary for the full set', () => {
    const result = deriveCatalogResults(rows, defaultCatalogState(), facets);

    expect(result.total).toBe(rows.length);
    expect(result.pageCount).toBe(1);
    expect(result.active).toEqual([]);
  });

  it('slices to the requested page and bounds the page number', () => {
    const paged = deriveCatalogResults(rows, stateWith({ page: 2 }), facets, 2);

    expect(paged.pageCount).toBe(2);
    expect(paged.page).toBe(2);
    expect(paged.pageRows.map((row) => row.slug)).toEqual(['alpha-code', 'beta-legacy']);
    expect(paged.pageStart).toBe(3);
    expect(paged.pageEnd).toBe(4);

    const overshoot = deriveCatalogResults(rows, stateWith({ page: 9 }), facets, 2);
    expect(overshoot.page).toBe(2);
    expect(overshoot.pageRows.map((row) => row.slug)).toEqual(['alpha-code', 'beta-legacy']);
  });

  it('returns an empty page and a zero count for a no-result state', () => {
    const empty = deriveCatalogResults(rows, stateWith({ search: 'nothing-matches' }), facets);

    expect(empty.total).toBe(0);
    expect(empty.pageCount).toBe(0);
    expect(empty.page).toBe(1);
    expect(empty.pageRows).toEqual([]);
    expect(empty.pageStart).toBe(0);
    expect(empty.pageEnd).toBe(0);
  });

  it('defaults to a bounded shipped page size', () => {
    expect(CATALOG_PAGE_SIZE).toBeGreaterThan(0);
    const result = deriveCatalogResults(rows, defaultCatalogState(), facets);
    expect(result.pageRows.length).toBeLessThanOrEqual(CATALOG_PAGE_SIZE);
  });

  it('stays bounded and responsive on a fixture far larger than any page', () => {
    const many: ModelIndexRow[] = Array.from({ length: 5_000 }, (_, i) => ({
      ...rows[i % rows.length],
      id: `bulk-${i}`,
      slug: `bulk-${i}`,
    }));

    const started = performance.now();
    const result = deriveCatalogResults(many, stateWith({ page: 3 }), facets, CATALOG_PAGE_SIZE);
    const elapsedMs = performance.now() - started;

    expect(result.total).toBe(5_000);
    expect(result.pageCount).toBe(Math.ceil(5_000 / CATALOG_PAGE_SIZE));
    expect(result.pageRows.length).toBe(CATALOG_PAGE_SIZE);
    expect(result.page).toBe(3);
    // Generous guard against an accidental super-linear regression, not a benchmark.
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe('active filters and clearing', () => {
  it('labels active filters with facet wording', () => {
    const state = stateWith({ filters: { accessTypes: ['open-weight'] } as never });
    const [entry] = activeFilters(state, facets);

    expect(entry.dimensionLabel).toBe('Access');
    expect(entry.label).toBe('Open-weight');
    expect(entry.value).toBe('open-weight');
  });

  it('reports whether any filter or search is active', () => {
    expect(hasActiveFilters(defaultCatalogState())).toBe(false);
    expect(hasActiveFilters(stateWith({ search: 'x' }))).toBe(true);
    expect(hasActiveFilters(stateWith({ filters: { creators: ['alpha'] } as never }))).toBe(true);
  });

  it('toggles a filter value on and off and resets the page', () => {
    const on = toggleFilterValue(stateWith({ page: 4 }), 'creators', 'alpha');
    expect(on.filters.creators).toEqual(['alpha']);
    expect(on.page).toBe(1);

    const off = toggleFilterValue(on, 'creators', 'alpha');
    expect(off.filters.creators).toEqual([]);
  });

  it('clears an individual value while leaving siblings in place', () => {
    const state = stateWith({
      filters: { creators: ['alpha', 'beta'] } as never,
      page: 3,
    });
    const cleared = clearFilterValue(state, 'creators', 'alpha');

    expect(cleared.filters.creators).toEqual(['beta']);
    expect(cleared.page).toBe(1);
  });

  it('clears search and every filter but keeps sort and view', () => {
    const state = stateWith({
      search: 'alpha',
      sort: 'name',
      view: 'list',
      filters: { creators: ['alpha'], categories: ['coding'] } as never,
    });
    const cleared = clearAllFilters(state);

    expect(cleared.search).toBe('');
    expect(hasActiveFilters(cleared)).toBe(false);
    expect(cleared.sort).toBe('name');
    expect(cleared.view).toBe('list');
  });
});
