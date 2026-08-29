import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildLineageEcosystems } from './lineage-view';
import {
  buildHomepageSearchIndex,
  normalizeText,
  releaseMatchesQuery,
  tokenize,
  type HomeReleaseRow,
} from './homepage-search';

const index = buildHomepageSearchIndex(dataset, '/');

// The set the homepage actually renders; the search index must mirror it exactly
// rather than the long-tail catalog. Derived, never pinned to a count.
const ecosystems = buildLineageEcosystems(dataset);
const homepageReleases = ecosystems.flatMap((ecosystem) =>
  ecosystem.families.flatMap((family) => family.releases));

function rowFor(slug: string): HomeReleaseRow {
  const row = index.releases.find((entry) => entry.slug === slug);
  if (!row) throw new Error(`no homepage row for ${slug}`);
  return row;
}

describe('normalizeText', () => {
  it('folds case, punctuation, and diacritics to spaced alphanumeric tokens', () => {
    expect(normalizeText('GPT-4o')).toBe('gpt 4o');
    expect(normalizeText('DeepSeek-R1')).toBe('deepseek r1');
    expect(normalizeText('  Café  ')).toBe('cafe');
    expect(normalizeText('!!!')).toBe('');
  });
});

describe('tokenize', () => {
  it('splits on non-alphanumeric boundaries and de-duplicates in order', () => {
    expect(tokenize('GPT-4.1 mini')).toEqual(['gpt', '4', '1', 'mini']);
    expect(tokenize('gpt gpt GPT')).toEqual(['gpt']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('buildHomepageSearchIndex', () => {
  it('indexes exactly the releases the homepage renders (positive control: non-empty)', () => {
    expect(index.releases.length).toBeGreaterThan(0);
    const indexed = new Set(index.releases.map((row) => row.slug));
    const expected = new Set(homepageReleases.map((release) => release.slug));
    expect(indexed).toEqual(expected);
  });

  it('carries only approved display fields and never a score, rank, or popularity metric', () => {
    const serialized = JSON.stringify(index);
    expect(serialized).not.toMatch(/"(score|rank|ranking|popularity|rating)"/i);
    for (const row of index.releases) {
      expect(Object.keys(row).sort()).toEqual([
        'accessType', 'canonicalName', 'categories', 'datePrecision', 'familyName',
        'familySlug', 'name', 'organizationName', 'organizationSlug', 'releaseDate',
        'releaseYear', 'route', 'slug', 'status', 'terms', 'verifiedAt',
      ]);
    }
  });

  it('derives each release\'s terms from its canonical name, aliases, family, and creator', () => {
    // Positive control: the fixture must actually exercise every source of terms.
    expect(index.releases.length).toBeGreaterThan(0);
    for (const release of homepageReleases) {
      const row = rowFor(release.slug);
      const family = dataset.families.find((entry) => entry.id === release.familyId)!;
      const organization = dataset.organizations.find((entry) => entry.id === release.organizationId)!;
      for (const term of [release.canonicalName, release.displayName, family.name, organization.name]) {
        const normalized = normalizeText(term);
        const haystack = ` ${row.terms.join(' ')} `;
        for (const token of normalized.split(' ')) {
          expect(haystack).toContain(token);
        }
      }
    }
  });

  it('records every entity type on its suggestions and never collapses them', () => {
    const entities = new Set(index.suggestions.map((suggestion) => suggestion.entity));
    expect(entities.has('model')).toBe(true);
    expect(entities.has('family')).toBe(true);
    expect(entities.has('organization')).toBe(true);
    // A creator and its family may share a name, yet stay separate suggestions.
    for (const suggestion of index.suggestions) {
      expect(['model', 'family', 'organization', 'product']).toContain(suggestion.entity);
    }
  });

  it('offers each known API alias as a model suggestion that targets its release', () => {
    const withAlias = homepageReleases.filter((release) => release.apiAliases.length > 0);
    // Positive control: the dataset must actually contain aliases to test.
    expect(withAlias.length).toBeGreaterThan(0);

    for (const release of withAlias) {
      for (const alias of release.apiAliases) {
        if (normalizeText(alias) === normalizeText(release.displayName)) continue;
        const match = index.suggestions.find((suggestion) =>
          suggestion.entity === 'model'
          && suggestion.targetSlug === release.slug
          && normalizeText(suggestion.term) === normalizeText(alias));
        expect(match, `alias ${alias} of ${release.slug}`).toBeDefined();
      }
    }
  });

  it('builds category, access, status, and period facets with descending periods', () => {
    expect(index.facets.categories.length).toBeGreaterThan(0);
    expect(index.facets.access.length).toBeGreaterThan(0);
    expect(index.facets.statuses.length).toBeGreaterThan(0);
    expect(index.facets.periods.length).toBeGreaterThan(0);

    const periods = index.facets.periods.map((facet) => facet.value);
    expect([...periods].sort((a, b) => (a < b ? 1 : -1))).toEqual(periods);

    // Each facet count is the number of indexed releases carrying that value.
    for (const facet of index.facets.access) {
      const actual = index.releases.filter((row) => row.accessType === facet.value).length;
      expect(facet.count).toBe(actual);
    }
  });

  it('is stable: identical data yields an identical content hash', () => {
    const again = buildHomepageSearchIndex(dataset, '/');
    expect(again.contentHash).toBe(index.contentHash);
  });

  it('never mutates the source dataset', () => {
    const before = JSON.stringify(dataset);
    buildHomepageSearchIndex(dataset, '/');
    expect(JSON.stringify(dataset)).toBe(before);
  });
});

describe('releaseMatchesQuery', () => {
  it('matches every release on an empty query and none on an unrelated one', () => {
    expect(index.releases.length).toBeGreaterThan(0);
    expect(index.releases.every((row) => releaseMatchesQuery(row, ''))).toBe(true);
    // A token that is in no term drives the matched set to empty, not merely
    // perturbing a constant, so the assertion is not vacuous.
    expect(index.releases.filter((row) => releaseMatchesQuery(row, 'zzqqxxnomatch'))).toHaveLength(0);
  });

  it('matches a release by its canonical name, and requires every query token (AND)', () => {
    const sample = homepageReleases[0];
    const row = rowFor(sample.slug);
    expect(releaseMatchesQuery(row, sample.canonicalName)).toBe(true);
    // Appending a token no term contains must exclude the row.
    expect(releaseMatchesQuery(row, `${sample.canonicalName} zzqqxxnomatch`)).toBe(false);
  });

  it('matches a release by a known API alias', () => {
    const withAlias = homepageReleases.find((release) =>
      release.apiAliases.some((alias) => normalizeText(alias) !== normalizeText(release.displayName)));
    expect(withAlias, 'a featured release with a distinct alias').toBeDefined();
    const alias = withAlias!.apiAliases.find(
      (candidate) => normalizeText(candidate) !== normalizeText(withAlias!.displayName))!;
    expect(releaseMatchesQuery(rowFor(withAlias!.slug), alias)).toBe(true);
  });
});
