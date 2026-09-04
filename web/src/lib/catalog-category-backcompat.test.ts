import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildCatalogIndex, modelRoute } from './catalog';
import {
  deriveCatalogResults,
  FILTER_DIMENSIONS,
  parseCatalogState,
  serializeCatalogState,
} from './catalog-view';
import { PILOTED_CATEGORIES } from '../data/category-spec-schema';
import { categorySpecByReleaseId } from '../data/category-specs';

// Piloting one category (abdeslam-menacere/ModelTree#43) must not move anything
// a reader already has bookmarked. These assertions are about the shipped
// dataset and the real index, because a fixture cannot answer whether the
// catalog still routes and filters the releases that actually exist.
const index = buildCatalogIndex(dataset, '/ModelTree/');
const facets = index.facets;

describe('catalog filters after the image pilot', () => {
  it('keeps every filter parameter name unchanged', () => {
    // The query parameters are the public surface of this page. Pinned by
    // literal, so renaming one cannot pass by being renamed in the test too.
    const params = FILTER_DIMENSIONS.map((dimension) => dimension.param);
    expect(params).toEqual([
      'creator',
      'family',
      'category',
      'modality',
      'access',
      'status',
      'year',
      'tier',
      'price',
    ]);
  });

  it('offers image as a category facet with a truthful count', () => {
    const facet = facets.categories.find((entry) => entry.value === 'image');
    expect(facet).toBeDefined();
    const expected = dataset.releases.filter((release) => release.categories.includes('image'));
    expect(facet!.count).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('selects exactly the image releases from ?category=image', () => {
    const state = parseCatalogState('?category=image', facets);
    expect(state.filters.categories).toEqual(['image']);

    const results = deriveCatalogResults(index.models, state, facets);
    const slugs = results.matches.map((row) => row.slug).sort();
    const expected = dataset.releases
      .filter((release) => release.categories.includes('image'))
      .map((release) => release.slug)
      .sort();
    expect(slugs).toEqual(expected);
  });

  it('round-trips the image filter state through the query string', () => {
    const state = parseCatalogState('?category=image&sort=name&view=list', facets);
    const query = serializeCatalogState(state, facets);
    expect(query).toContain('category=image');
    expect(parseCatalogState(query, facets)).toEqual(state);
  });

  it('combines the category filter with another dimension unchanged', () => {
    const state = parseCatalogState('?category=image&category=language-reasoning', facets);
    const results = deriveCatalogResults(index.models, state, facets);
    // Values within one dimension stay a union, which is the behaviour that
    // existed before the pilot and is what the active-filter chips describe.
    for (const row of results.matches) {
      expect(
        row.categories.includes('image') || row.categories.includes('language-reasoning'),
      ).toBe(true);
    }
    expect(results.matches.length).toBeGreaterThan(
      dataset.releases.filter((release) => release.categories.includes('image')).length,
    );
  });

  it('still routes every release, image or not', () => {
    for (const release of dataset.releases) {
      const row = index.models.find((entry) => entry.slug === release.slug);
      expect(row, `no index row for ${release.slug}`).toBeDefined();
      expect(modelRoute('/ModelTree/', release.slug)).toBe(`/ModelTree/models/${release.slug}/`);
    }
  });

  it('does not add or remove a single catalog row', () => {
    // The pilot records facts about existing releases. If this count moves, the
    // change stopped being a pilot and became a dataset expansion.
    expect(index.models.length).toBe(dataset.releases.length);
  });
});

describe('pilot scope stays where it was declared', () => {
  it('pilots exactly one category', () => {
    expect(PILOTED_CATEGORIES).toEqual(['image']);
  });

  it('records a spec only for releases in the piloted category', () => {
    const releaseById = new Map(dataset.releases.map((release) => [release.id, release]));
    for (const releaseId of categorySpecByReleaseId.keys()) {
      const release = releaseById.get(releaseId);
      expect(release, `spec for unknown release ${releaseId}`).toBeDefined();
      expect(release!.categories).toContain('image');
    }
  });

  it('leaves every other category with no spec records at all', () => {
    const specced = new Set(categorySpecByReleaseId.keys());
    const nonImage = dataset.releases.filter((release) => !release.categories.includes('image'));
    expect(nonImage.length).toBeGreaterThan(0);
    for (const release of nonImage) {
      expect(specced.has(release.id), `${release.slug} unexpectedly has a spec`).toBe(false);
    }
  });
});
