import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { validateDataset } from '../data/validate';
import { lineageFixtureDataset } from '../../tests/fixtures/lineage-dataset';
import { buildLineageEcosystems } from './lineage-view';
import { homeSuggestionsFor } from './homepage-search-view';
import {
  organizationFullNameIfDistinct,
  organizationLabel,
} from './organization-name';
import {
  buildHomepageSearchIndex,
  measureHomepageSearchIndexSize,
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

describe('product suggestions', () => {
  // A self-contained fixture, so the fixed expectations below cannot drift with
  // the growing seed catalog. The lineage fixture has featured releases and no
  // products; we add exactly one product that routes to a single featured
  // release and prove the product code path lights up correctly.
  const routedProductDataset = validateDataset({
    ...lineageFixtureDataset,
    products: [{
      id: 'fixture-alpha-assistant',
      slug: 'fixture-alpha-assistant',
      name: 'Alpha Assistant',
      organizationId: 'fixture-alpha',
      description: 'Synthetic product that routes to one featured release, to exercise product suggestions.',
      modelSelection: 'routed',
      releaseIds: ['fixture-alpha-solo-one'],
      effectiveFrom: '2025-01-01',
      sourceIds: ['fixture-lineage-announcement'],
      verifiedAt: '2026-08-01',
    }],
  });

  it('emits a product suggestion routed to the single release it names, and injects its term', () => {
    // Non-vacuous control: the same fixture without the product yields none, so
    // the assertions below are driven by the product path, not by ambient data.
    const baseIndex = buildHomepageSearchIndex(lineageFixtureDataset, '/');
    expect(baseIndex.suggestions.some((suggestion) => suggestion.entity === 'product')).toBe(false);

    const productIndex = buildHomepageSearchIndex(routedProductDataset, '/');
    const productSuggestion = productIndex.suggestions.find((suggestion) => suggestion.entity === 'product');
    expect(productSuggestion, 'a product routing to a featured release must be searchable').toBeDefined();
    expect(productSuggestion!.term).toBe('Alpha Assistant');
    expect(productSuggestion!.targetSlug).toBe('fixture-alpha-solo-one');
    expect(productSuggestion!.route).toBe('/models/fixture-alpha-solo-one/');

    // The product name joins the routed release's searchable terms, so typing the
    // product reaches the release it powers.
    const routedRow = productIndex.releases.find((row) => row.slug === 'fixture-alpha-solo-one');
    expect(routedRow, 'the routed release is indexed').toBeDefined();
    expect(routedRow!.terms).toContain(normalizeText('Alpha Assistant'));
  });

  it('offers no product suggestion while no shipped product routes to a featured release', () => {
    // Documents the B1 decision: the product path is live (proven above) but the
    // seed catalog lights up none of it today, which is why the homepage copy
    // does not promise product lookup. When a shipped product first routes to a
    // featured release, this reddens and the copy should be restored.
    // Positive control so an empty suggestion set cannot pass this vacuously.
    expect(index.suggestions.length).toBeGreaterThan(0);
    expect(index.suggestions.filter((suggestion) => suggestion.entity === 'product')).toHaveLength(0);
  });
});

describe('creator suggestions', () => {
  it('gives a creator one row, displayed as the label and reachable by either recorded form', () => {
    // No two suggestions of one entity type read the same. Stated over every
    // entity rather than creators alone because it is not a creator rule: this
    // builder already skips a model alias that normalizes to the model's own
    // display name, for exactly this reason. An organization-only assertion
    // would pin something narrower than the index actually keeps.
    for (const entity of new Set(index.suggestions.map(({ entity: type }) => type))) {
      const terms = index.suggestions
        .filter((suggestion) => suggestion.entity === entity)
        .map(({ term }) => term);
      // Names the offending string on failure, which a size comparison would not.
      expect(terms.filter((term, at) => terms.indexOf(term) !== at)).toEqual([]);
    }

    // ...and the one row stays reachable from *both* forms. Without this, the
    // duplicate above is trivially satisfied by dropping the fuller form, which
    // would leave a reader who types the other one unable to find the creator --
    // a worse regression, and one no assertion above would notice.
    //
    // That needs a creator on the homepage whose two recorded forms differ, and
    // the featured set is an editorial choice that today contains none: #531
    // settled the last one by deciding `google-deepmind` displays as "Google
    // DeepMind", which made its two forms agree. Rather than let this go
    // vacuous, feature a release from a creator that still records two forms --
    // the sole input the derivation reads -- so the property keeps being
    // exercised without inventing an organization or editing the dataset.
    const differing = dataset.organizations
      .filter((organization) => organizationFullNameIfDistinct(organization) !== null)
      .map(({ id }) => id);
    expect(differing.length).toBeGreaterThan(0);

    const promoted = dataset.releases.find((release) => differing.includes(release.organizationId));
    expect(promoted, 'no release from a two-form creator available to feature').toBeDefined();

    const withTwoForms = {
      ...dataset,
      releases: dataset.releases.map((release) => (
        release.id === promoted!.id ? { ...release, featured: true } : release
      )),
    };
    const built = buildHomepageSearchIndex(withTwoForms, '/');
    const twoForms = buildLineageEcosystems(withTwoForms)
      .map(({ organization }) => organization)
      .filter((organization) => organizationFullNameIfDistinct(organization) !== null);

    // Vacuity guard for the loop below, now that the fixture rather than the
    // seed data is what puts such a creator on the page.
    expect(twoForms.length).toBeGreaterThan(0);

    // Read off the record's two fields rather than off `organizationSearchTerms`,
    // which is the function this loop exists to check: iterating its output
    // means dropping the fuller form shrinks the loop instead of failing it, so
    // the assertion would survive the exact regression it is here to catch.
    for (const organization of twoForms) {
      for (const recorded of [organization.name, organization.shortName]) {
        const matched = homeSuggestionsFor(built, recorded)
          .filter((suggestion) => suggestion.entity === 'organization')
          .map(({ term }) => term);
        expect(matched).toContain(organizationLabel(organization));
      }
    }
  });
});

describe('measureHomepageSearchIndexSize', () => {
  it('keeps the homepage index within a per-row payload budget', () => {
    // The index ships whole to the homepage as client:load props, so budget it
    // per row -- immune to dataset growth -- with positive controls so an empty
    // index fails loudly rather than passing vacuously.
    expect(index.releases.length).toBeGreaterThan(0);
    expect(index.suggestions.length).toBeGreaterThan(0);
    const size = measureHomepageSearchIndexSize(index);
    const bytesPerRelease = Math.round(size.releases / index.releases.length);
    const bytesPerSuggestion = Math.round(size.suggestions / index.suggestions.length);
    expect(bytesPerRelease).toBeLessThanOrEqual(900);
    expect(bytesPerSuggestion).toBeLessThanOrEqual(320);
    // Total is dominated by those two sections; keep it bounded by their budgets.
    expect(size.total).toBeLessThanOrEqual(
      bytesPerRelease * index.releases.length + bytesPerSuggestion * index.suggestions.length + 4_096,
    );
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
