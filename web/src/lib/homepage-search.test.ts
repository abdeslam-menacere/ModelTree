import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { validateDataset } from '../data/validate';
import { lineageFixtureDataset } from '../../tests/fixtures/lineage-dataset';
import { homeSuggestionsFor } from './homepage-search-view';
import { buildLineageEcosystems } from './lineage-view';
import { buildCoverageStats } from './release-pulse';
import {
  buildHomepageSearchIndex,
  measureHomepageSearchIndexSize,
  normalizeText,
  releaseMatchesQuery,
  tokenize,
  type HomeReleaseRow,
} from './homepage-search';

const index = buildHomepageSearchIndex(dataset, '/');

/**
 * The displayed side of abdeslam-menacere/ModelTree#525, read straight off the
 * versioned JSON on disk.
 *
 * Deliberately not derived from `buildCreatorEcosystems`, which is the seed
 * `buildHomepageSearchIndex` itself reads: an expectation computed from the
 * function under test moves with it, so it cannot fail when that function is
 * wrong. Routing through the file the dataset is composed from is what makes
 * the parity assertions below able to go red at all.
 */
const dataDir = new URL('../data/', import.meta.url);

function readCollection<T>(file: string): T[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL(file, dataDir), 'utf8'));
  // These documents are bare arrays. A member-access read of a bare array is
  // the instrument failure this guard exists to make impossible: it returns
  // something shaped plausibly enough to certify a dead probe.
  if (!Array.isArray(parsed)) throw new Error(`${file} is not the bare array this read assumes`);
  return parsed as T[];
}

const recordedReleases = readCollection<{ slug: string; organizationId: string }>('releases.json');
const recordedOrganizations = readCollection<{
  id: string;
  slug: string;
  name: string;
  shortName: string;
}>('organizations.json');

// Every release the homepage names. Its no-script index enumerates the whole
// catalog creator -> family -> release, and the search index now mirrors that;
// the parity assertions read the displayed side off disk rather than from here.
const homepageReleases = dataset.releases;

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
  // the growing seed catalog. The lineage fixture has releases and no products;
  // we add exactly one product that routes to a single indexed release and
  // prove the product code path lights up correctly.
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
    expect(productSuggestion, 'a product routing to an indexed release must be searchable').toBeDefined();
    expect(productSuggestion!.term).toBe('Alpha Assistant');
    expect(productSuggestion!.targetSlug).toBe('fixture-alpha-solo-one');
    expect(productSuggestion!.route).toBe('/models/fixture-alpha-solo-one/');

    // The product name joins the routed release's searchable terms, so typing the
    // product reaches the release it powers.
    const routedRow = productIndex.releases.find((row) => row.slug === 'fixture-alpha-solo-one');
    expect(routedRow, 'the routed release is indexed').toBeDefined();
    expect(routedRow!.terms).toContain(normalizeText('Alpha Assistant'));
  });

  it('offers no product suggestion while no recorded product routes to any release', () => {
    // Documents the B1 decision: the product path is live (proven above) but the
    // seed catalog lights up none of it today, which is why the homepage copy
    // does not promise product lookup. The reason changed with #525 and is worth
    // stating plainly: this used to hold because no product routed to a
    // *featured* release, and now holds because the one recorded product
    // discloses no routing at all -- `microsoft-copilot` carries an empty
    // `releaseIds`, since no consulted source documents which model answers a
    // given request. Widening the index cannot rescue a routing the sources
    // never stated. When a product first names a release, this reddens and the
    // copy should be restored.
    // Positive control so an empty suggestion set cannot pass this vacuously.
    expect(index.suggestions.length).toBeGreaterThan(0);
    expect(index.suggestions.filter((suggestion) => suggestion.entity === 'product')).toHaveLength(0);
  });
});

describe('what the homepage displays is what the homepage can search', () => {
  // abdeslam-menacere/ModelTree#525. The page displayed 21 creators, printed
  // "Creators 21" in its own coverage panel, and shipped a search that found 5
  // of them: a visitor could read `Allen Institute for AI -> OLMo 2 -> OLMo 2
  // 7B` on the page and get nothing for `OLMo` in the box directly above it.
  //
  // Every expectation here is read off the versioned JSON on disk, not derived
  // from `buildCreatorEcosystems` -- the seed the index itself is built from.
  // That is the whole point: an expectation taken from the function under test
  // moves with the defect and keeps passing while the page contradicts itself.

  it('indexes every release the page names, and nothing it does not', () => {
    // Vacuity guards on both sides: two empty sets are equal.
    expect(recordedReleases.length).toBeGreaterThan(0);
    expect(index.releases.length).toBeGreaterThan(0);

    const indexed = [...new Set(index.releases.map((row) => row.slug))].sort();
    const displayed = [...new Set(recordedReleases.map((release) => release.slug))].sort();
    expect(indexed).toEqual(displayed);
  });

  it('makes every creator the page names findable, in both directions', () => {
    const withRelease = new Set(recordedReleases.map((release) => release.organizationId));
    const displayed = recordedOrganizations
      .filter((organization) => withRelease.has(organization.id))
      .map((organization) => organization.slug)
      .sort();
    expect(displayed.length).toBeGreaterThan(0);

    const searchable = [...new Set(index.releases.map((row) => row.organizationSlug))].sort();
    // Equality, not containment, so this fails in both directions: a creator
    // dropped from the index reddens it, and so would an index row for a
    // creator the catalog records no release for.
    expect(searchable).toEqual(displayed);
  });

  it('keeps the coverage panel\'s creator count true against what search can find', () => {
    // `index.astro` prints the creator count as "Creators N" a few hundred
    // pixels above the search box, and `buildCoverageStats` repeats it under
    // Release Pulse. The relationship is pinned rather than the number, so the
    // catalog can grow without editing this file -- but a creator the page
    // counts and the box cannot find reddens it, which is #525 exactly.
    //
    // A "creator" is an organization that has published a release, not every
    // recorded organization: the model deliberately keeps serving platforms and
    // other non-creator entities distinct, and #515 is the count counting all
    // organizations instead. This measures the same population as the sibling
    // `withRelease` predicate twelve lines up rather than inventing a third
    // notion. Today every organization publishes, so this equals
    // `recordedOrganizations.length`; the fixture-driven test in release-pulse
    // is what proves the derivation without relying on that coincidence.
    const creatorOrganizations = recordedOrganizations.filter((organization) =>
      recordedReleases.some((release) => release.organizationId === organization.id),
    );
    expect(creatorOrganizations.length).toBeGreaterThan(0);
    expect(buildCoverageStats(dataset).creators).toBe(creatorOrganizations.length);

    const searchable = new Set(index.releases.map((row) => row.organizationSlug));
    expect(searchable.size).toBe(creatorOrganizations.length);
  });

  it('widens the index without reading the editorial featured flag', () => {
    // AC3: the fix must not be "mark more releases featured". Flipping every
    // release to not-featured must leave the index byte-identical, which it
    // cannot be if any part of this derivation still consults the flag.
    // The control is the same mutation observed through the lead view, which
    // *does* read it and collapses to nothing -- so the invariance above is
    // this index ignoring the flag, not the mutation failing to apply.
    const unfeatured = validateDataset({
      ...dataset,
      releases: dataset.releases.map((release) => ({ ...release, featured: false })),
    });
    expect(dataset.releases.some((release) => release.featured)).toBe(true);
    expect(unfeatured.releases.some((release) => release.featured)).toBe(false);

    expect(buildHomepageSearchIndex(unfeatured, '/').contentHash).toBe(index.contentHash);
    expect(buildLineageEcosystems(unfeatured)).toHaveLength(0);
    expect(buildLineageEcosystems(dataset).length).toBeGreaterThan(0);
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
    // abdeslam-menacere/ModelTree#531 had to *fabricate* this situation: it
    // promoted a two-form creator's release to `featured` on a local copy of the
    // dataset, because the index then covered only the featured lead set, and
    // `google-deepmind` -- the last two-form creator inside it -- had just had
    // its two recorded forms made to agree. Widening the index in #525 made
    // every recorded creator searchable, so the property is exercised by the
    // real dataset and that fixture is redundant.
    //
    // It is removed rather than left in place, and said so rather than dropped
    // quietly: a promotion that can no longer change the index under test is a
    // prop, not a control, and a test that keeps one reads as coverage while
    // having stopped being able to fail.
    //
    // The vacuity guard it protected is kept, because what it guards against is
    // unchanged -- a catalog in which no creator records two differing forms
    // would make the sweep below iterate nothing and pass. It is read off disk,
    // so it cannot be satisfied by the naming helpers this loop is checking.
    const twoForms = recordedOrganizations
      .filter((organization) => organization.name !== organization.shortName);
    expect(twoForms.length).toBeGreaterThan(0);

    for (const organization of twoForms) {
      for (const recorded of [organization.name, organization.shortName]) {
        const matched = homeSuggestionsFor(index, recorded)
          .filter((suggestion) => suggestion.entity === 'organization')
          .map(({ term }) => term);
        // Containment, not equality: `AI2` is a prefix of `AI21` and `Allen
        // Institute for AI` ends in `AI`, so either query legitimately surfaces
        // the other creator's row alongside the right one. What AC2 states is
        // that the creator you typed is among the results, and an exact-set
        // assertion would read as a defect for that pair and no other.
        expect(matched, `${organization.id} via "${recorded}"`)
          .toContain(organization.shortName);
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
    expect(withAlias, 'an indexed release with a distinct alias').toBeDefined();
    const alias = withAlias!.apiAliases.find(
      (candidate) => normalizeText(candidate) !== normalizeText(withAlias!.displayName))!;
    expect(releaseMatchesQuery(rowFor(withAlias!.slug), alias)).toBe(true);
  });
});
