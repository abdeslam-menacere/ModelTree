import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { lineageFixtureDataset } from '../../tests/fixtures/lineage-dataset';
import { buildHomepageSearchIndex } from './homepage-search';
import {
  clearAllHomeFilters,
  clearHomeFilterValue,
  defaultHomeSearchState,
  deriveHomeSearchResults,
  hasActiveFilters,
  hasActiveQueryOrFilters,
  homeActiveFilters,
  homeSuggestionsFor,
  parseHomeSearchState,
  serializeHomeSearchState,
  toggleHomeFilterValue,
  type HomeSearchState,
} from './homepage-search-view';

const index = buildHomepageSearchIndex(dataset, '/');

describe('parse/serialize round trip', () => {
  it('round-trips query, filters, and selection through the query string', () => {
    const category = index.facets.categories[0].value;
    const access = index.facets.access[0].value;
    const selected = index.releases[0].slug;
    const state: HomeSearchState = {
      query: 'gpt',
      filters: { categories: [category], access: [access], statuses: [], periods: [] },
      selected,
    };

    const serialized = serializeHomeSearchState(state, index);
    expect(serialized).toContain('q=gpt');
    expect(serialized).toContain(`category=${category}`);
    expect(serialized).toContain(`access=${access}`);
    expect(serialized).toContain(`sel=${selected}`);

    const parsed = parseHomeSearchState(serialized, index);
    expect(parsed).toEqual(state);
  });

  it('serializes a default state to an empty query string', () => {
    expect(serializeHomeSearchState(defaultHomeSearchState(), index)).toBe('');
  });

  it('emits filter values in facet order, so click order does not change the link', () => {
    const values = index.facets.categories.map((facet) => facet.value);
    // Only meaningful when the fixture has at least two categories to reorder.
    expect(values.length).toBeGreaterThanOrEqual(2);
    const [first, second] = values;

    const clicked: HomeSearchState = {
      ...defaultHomeSearchState(),
      filters: { categories: [second, first], access: [], statuses: [], periods: [] },
    };
    const serialized = serializeHomeSearchState(clicked, index);
    expect(serialized.indexOf(`category=${first}`)).toBeLessThan(serialized.indexOf(`category=${second}`));
  });

  it('drops filter values and selections the index no longer knows', () => {
    const parsed = parseHomeSearchState('?category=not-a-real-category&sel=not-a-real-release', index);
    expect(parsed.filters.categories).toEqual([]);
    expect(parsed.selected).toBeNull();
  });
});

describe('combined filters', () => {
  it('narrows results with an AND across dimensions and never mutates the input state', () => {
    const status = index.facets.statuses[0].value;
    const base: HomeSearchState = {
      ...defaultHomeSearchState(),
      filters: { categories: [], access: [], statuses: [status], periods: [] },
    };
    const withStatus = deriveHomeSearchResults(index, base);
    expect(withStatus.total).toBeGreaterThan(0);
    expect(withStatus.total).toBeLessThanOrEqual(index.releases.length);
    expect(withStatus.matches.every((row) => row.status === status)).toBe(true);

    // A second dimension can only keep or shrink the set.
    const period = withStatus.matches[0].releaseYear;
    const both: HomeSearchState = {
      ...base,
      filters: { ...base.filters, periods: [period] },
    };
    const withBoth = deriveHomeSearchResults(index, both);
    expect(withBoth.total).toBeLessThanOrEqual(withStatus.total);
    expect(withBoth.matches.every((row) => row.status === status && row.releaseYear === period)).toBe(true);

    // Immutability: toggling returns a new state and leaves the original alone.
    const frozen = JSON.stringify(base);
    toggleHomeFilterValue(base, 'periods', period);
    expect(JSON.stringify(base)).toBe(frozen);
  });

  it('reports active filters and clears them individually and all at once', () => {
    const category = index.facets.categories[0].value;
    const state: HomeSearchState = {
      ...defaultHomeSearchState(),
      query: 'gpt',
      filters: { categories: [category], access: [], statuses: [], periods: [] },
    };
    expect(hasActiveFilters(state)).toBe(true);
    expect(hasActiveQueryOrFilters(state)).toBe(true);
    expect(homeActiveFilters(state, index.facets)).toHaveLength(1);

    const cleared = clearHomeFilterValue(state, 'categories', category);
    expect(cleared.filters.categories).toEqual([]);
    expect(hasActiveFilters(cleared)).toBe(false);

    const wiped = clearAllHomeFilters(state);
    expect(wiped.query).toBe('');
    expect(wiped.selected).toBeNull();
    expect(hasActiveQueryOrFilters(wiped)).toBe(false);
  });
});

describe('deriveHomeSearchResults states', () => {
  it('reports the empty state for a query no release matches', () => {
    const state = { ...defaultHomeSearchState(), query: 'zzqqxxnomatch' };
    const results = deriveHomeSearchResults(index, state);
    expect(results.total).toBe(0);
    expect(results.matches).toHaveLength(0);
    expect(results.selected).toBeNull();
  });

  it('includes the queried release among results when a query names one (real data)', () => {
    const target = index.releases[0];
    const results = deriveHomeSearchResults(index, {
      ...defaultHomeSearchState(),
      query: target.canonicalName,
    });
    expect(results.total).toBeGreaterThan(0);
    expect(results.matches.map((row) => row.slug)).toContain(target.slug);
  });

  it('reports exactly one result for a query only one release matches (self-contained fixture)', () => {
    // A frozen fixture, so "exactly one" is fixed by construction and cannot
    // drift with the growing seed catalog. The lineage fixture features several
    // releases; only the shallow family's release carries the token "solo".
    const fixtureIndex = buildHomepageSearchIndex(lineageFixtureDataset, '/');
    // Positive control: the index holds more than one release, so a single match
    // is a genuine narrowing rather than the whole (possibly empty) set.
    expect(fixtureIndex.releases.length).toBeGreaterThan(1);

    const results = deriveHomeSearchResults(fixtureIndex, {
      ...defaultHomeSearchState(),
      query: 'solo',
    });
    expect(results.total).toBe(1);
    expect(results.matches).toHaveLength(1);
    expect(results.matches[0].slug).toBe('fixture-alpha-solo-one');
  });

  it('reports the broad state (all releases) for an empty query and no filters', () => {
    const results = deriveHomeSearchResults(index, defaultHomeSearchState());
    expect(results.total).toBe(index.releases.length);
    expect(results.total).toBeGreaterThan(0);
  });

  it('resolves a selection only when it survives the active query and filters', () => {
    const target = index.releases[0];
    const shown = deriveHomeSearchResults(index, {
      ...defaultHomeSearchState(),
      selected: target.slug,
    });
    expect(shown.selected?.slug).toBe(target.slug);

    // A query that excludes the selected release must not report it as shown.
    const hidden = deriveHomeSearchResults(index, {
      ...defaultHomeSearchState(),
      query: 'zzqqxxnomatch',
      selected: target.slug,
    });
    expect(hidden.selected).toBeNull();
  });
});

describe('homeSuggestionsFor', () => {
  it('returns none for an empty query, keeping the default view uncluttered', () => {
    expect(homeSuggestionsFor(index, '', 8)).toHaveLength(0);
    expect(homeSuggestionsFor(index, '   ', 8)).toHaveLength(0);
  });

  it('returns none for a punctuation-only query rather than matching everything', () => {
    // Positive control: a real query against the same index does return matches,
    // so an empty result below is the normalized-needle guard firing, not an
    // empty index passing vacuously.
    expect(homeSuggestionsFor(index, index.releases[0].name, 8).length).toBeGreaterThan(0);
    for (const punctuation of ['-', '!!!', '***', '. , ;']) {
      expect(homeSuggestionsFor(index, punctuation, 8)).toHaveLength(0);
    }
  });

  it('returns entity-typed suggestions matching the query, capped at the limit', () => {
    const sample = index.releases[0];
    const suggestions = homeSuggestionsFor(index, sample.name, 8);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(8);
    expect(suggestions.some((suggestion) => suggestion.entity === 'model')).toBe(true);
  });
});
