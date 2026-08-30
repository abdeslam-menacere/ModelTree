import { describe, expect, it } from 'vitest';
import { withEmptyFamily } from '../../tests/fixtures/empty-family';
import { dataset as seedDataset } from '../data/dataset';
import { validateDataset } from '../data/validate';
import { buildCreatorEcosystems, buildLineageEcosystems } from './lineage-view';
import { organizationFullNameIfDistinct } from './organization-name';
import {
  assertRoutesResolve,
  buildCatalogIndex,
  CatalogIndexError,
  measureIndexSize,
  planPagination,
  providerRoute,
  sortModels,
} from './catalog';

function makeRelease(
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

const ALPHA_ONE_FAMILY = {
  id: 'alpha-one',
  slug: 'alpha-one',
  organizationId: 'alpha',
  name: 'Alpha One',
  description: 'Fixture family.',
  categories: ['language-reasoning'],
  firstReleaseDate: '2025-01-01',
  datePrecision: 'day',
  status: 'current',
  sourceIds: ['src-a'],
  verifiedAt: '2026-01-01',
};

const BETA_ONE_FAMILY = {
  id: 'beta-one',
  slug: 'beta-one',
  organizationId: 'beta',
  name: 'Beta One',
  description: 'Fixture family.',
  categories: ['coding'],
  firstReleaseDate: '2025-01-01',
  datePrecision: 'day',
  status: 'current',
  sourceIds: ['src-a'],
  verifiedAt: '2026-01-01',
};

function makeDataset(overrides: Record<string, unknown> = {}) {
  return validateDataset({
    sources: [{
      id: 'src-a',
      url: 'https://example.com/a',
      title: 'Announcement',
      type: 'official-announcement',
      publisherId: 'example',
      lastCheckedDate: '2026-01-01',
    }],
    publishers: [{ id: 'example', name: 'Example' }],
    organizations: [
      {
        id: 'alpha',
        slug: 'alpha',
        name: 'Alpha Labs',
        // Deliberately distinct from `name`: this is the creator label, and the
        // alias-collision test below depends on it normalizing to "alpha".
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
      ALPHA_ONE_FAMILY,
      BETA_ONE_FAMILY,
    ],
    releases: [
      makeRelease('alpha-new', 'alpha', 'alpha-one', '2025-06-01', { apiAliases: ['alpha'] }),
      makeRelease('alpha-old', 'alpha', 'alpha-one', '2025-02-01'),
      makeRelease('beta-same', 'beta', 'beta-one', '2025-06-01', {
        categories: ['coding'],
        contextWindow: 200_000,
      }),
    ],
    ...overrides,
  });
}

describe('catalog index generation', () => {
  it('produces identical output for identical data', () => {
    const first = buildCatalogIndex(makeDataset());
    const second = buildCatalogIndex(makeDataset());

    expect(second).toEqual(first);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it('does not depend on the order records appear in the source files', () => {
    const ordered = makeDataset();
    const reversed = makeDataset({
      releases: [
        makeRelease('beta-same', 'beta', 'beta-one', '2025-06-01', {
          categories: ['coding'],
          contextWindow: 200_000,
        }),
        makeRelease('alpha-old', 'alpha', 'alpha-one', '2025-02-01'),
        makeRelease('alpha-new', 'alpha', 'alpha-one', '2025-06-01', { apiAliases: ['alpha'] }),
      ],
    });

    expect(buildCatalogIndex(reversed)).toEqual(buildCatalogIndex(ordered));
  });

  it('breaks release-date ties on slug rather than input order', () => {
    const index = buildCatalogIndex(makeDataset());

    expect(index.models.map((model) => model.slug)).toEqual([
      'alpha-new',
      'beta-same',
      'alpha-old',
    ]);
  });

  it('sorts by name and by verification without disturbing the tie-break', () => {
    const { models } = buildCatalogIndex(makeDataset());

    expect(sortModels(models, 'name').map((model) => model.slug))
      .toEqual(['alpha-new', 'alpha-old', 'beta-same']);
    expect(sortModels(models, 'recently-verified').map((model) => model.slug))
      .toEqual(['alpha-new', 'alpha-old', 'beta-same']);
  });

  it('keeps detail payloads out of listing rows', () => {
    const [row] = buildCatalogIndex(makeDataset()).models;

    for (const field of ['summary', 'intendedUse', 'sourceIds', 'apiAliases', 'license']) {
      expect(row).not.toHaveProperty(field);
    }
  });

  it('keeps entity roles on aliases that collide', () => {
    const { aliases } = buildCatalogIndex(makeDataset());
    const collisions = aliases.filter((alias) => alias.normalized === 'alpha');

    expect(collisions.map((alias) => alias.entity)).toEqual(['model', 'organization']);
    expect(collisions.map((alias) => alias.targetSlug)).toEqual(['alpha-new', 'alpha']);
  });

  it('counts facets per model rather than per record it was derived from', () => {
    const { facets } = buildCatalogIndex(makeDataset());
    const counts = Object.fromEntries(facets.creators.map((facet) => [facet.value, facet.count]));

    expect(counts).toEqual({ alpha: 2, beta: 1 });
    expect(facets.categories.map((facet) => [facet.value, facet.count]))
      .toEqual([['coding', 1], ['language-reasoning', 2]]);
    expect(facets.contextTiers.map((facet) => [facet.value, facet.count]))
      .toEqual([['128k-to-1m', 1], ['unknown', 2]]);
    expect(facets.priceAvailability.map((facet) => [facet.value, facet.count]))
      .toEqual([['not-published', 3]]);
  });

  it('labels facets with the same wording the interface uses', () => {
    const { facets } = buildCatalogIndex(makeDataset());

    expect(facets.statuses[0].label).toBe('Available');
    expect(facets.accessTypes[0].label).toBe('Hosted API');
    expect(facets.categories.map((facet) => facet.label))
      .toEqual(['Coding', 'Language and reasoning']);
  });

  it('records a published price only when a deployment is actually priced', () => {
    const priced = makeDataset({
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
        id: 'alpha-new-on-alpha-api',
        releaseId: 'alpha-new',
        platformId: 'alpha-api',
        deliveryMode: 'hosted-api',
        regions: [],
        effectiveFrom: '2025-06-01',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      }],
      pricing: [{
        id: 'alpha-new-price',
        deploymentId: 'alpha-new-on-alpha-api',
        currency: 'USD',
        unit: 'per-1m-tokens',
        rates: { input: 1 },
        effectiveFrom: '2025-06-01',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      }],
    });

    const bySlug = Object.fromEntries(
      buildCatalogIndex(priced).models.map((model) => [model.slug, model.hasPublishedPrice]),
    );

    expect(bySlug).toEqual({ 'alpha-new': true, 'alpha-old': false, 'beta-same': false });
  });

  it('marks an organization that also operates a platform', () => {
    const withPlatform = makeDataset({
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
    });

    const roles = Object.fromEntries(
      buildCatalogIndex(withPlatform).providers.map((provider) => [provider.slug, provider.role]),
    );

    expect(roles).toEqual({ alpha: 'creator-and-platform', beta: 'creator' });
  });
});

describe('pagination planning', () => {
  const slugs = ['a', 'b', 'c', 'd', 'e'];

  it('splits into deterministic page boundaries', () => {
    const plan = planPagination(slugs, 2);

    expect(plan.pageCount).toBe(3);
    expect(plan.pages.map((page) => [page.number, page.start, page.end]))
      .toEqual([[1, 0, 1], [2, 2, 3], [3, 4, 4]]);
  });

  it('leaves earlier pages untouched when a record sorts onto the end', () => {
    const before = planPagination(slugs, 2);
    const after = planPagination([...slugs, 'f'], 2);

    expect(after.pages.slice(0, 2)).toEqual(before.pages.slice(0, 2));
    expect(after.pages[2].slugs).toEqual(['e', 'f']);
  });

  it('refuses a page size that cannot produce pages', () => {
    expect(() => planPagination(slugs, 0)).toThrow(CatalogIndexError);
  });
});

describe('route resolution and payload budget', () => {
  it('publishes a provider route for an organization with releases and none for one without', () => {
    // beta keeps its family but holds no release, so it is the organization no
    // provider page is generated for. Both branches of the route decision are
    // exercised here; the previous assertion could only ever see the null one,
    // because no fixture organization was featured.
    //
    // The empty family is added after validation (#554): the validator refuses
    // that shape, and this test is about what the catalog does if one reaches it
    // anyway.
    const index = buildCatalogIndex(withEmptyFamily(makeDataset({
      families: [ALPHA_ONE_FAMILY],
      releases: [
        makeRelease('alpha-new', 'alpha', 'alpha-one', '2025-06-01', { apiAliases: ['alpha'] }),
      ],
    }), BETA_ONE_FAMILY));

    expect(index.providers).not.toHaveLength(0);
    expect(Object.fromEntries(index.providers.map((provider) => [provider.slug, provider.route])))
      .toEqual({ alpha: '/providers/alpha/', beta: null });

    const organizationAliases = index.aliases.filter((alias) => alias.entity === 'organization');
    expect(organizationAliases).not.toHaveLength(0);
    for (const alias of organizationAliases) {
      expect(alias.route, alias.targetSlug)
        .toBe(alias.targetSlug === 'alpha' ? '/providers/alpha/' : null);
    }
  });

  it('fails when a model index row has no detail route to land on', () => {
    const index = buildCatalogIndex(makeDataset());

    expect(() => assertRoutesResolve(index, { models: ['alpha-new'] }))
      .toThrow(/model index row "alpha-old" has no generated detail route/);
  });

  it('fails when a provider row republishes a route the build does not generate', () => {
    const index = buildCatalogIndex(makeDataset());
    index.providers[0].route = providerRoute('/', index.providers[0].slug);

    // No providers key: the caller states it generates no provider page, so the
    // guard must still refuse the row rather than skip the whole check.
    expect(() => assertRoutesResolve(index, { models: index.models.map((model) => model.slug) }))
      .toThrow(/provider index row "alpha" has no generated detail route/);
  });

  it('fails when a published provider route falls outside the generated slugs', () => {
    const index = buildCatalogIndex(makeDataset());
    for (const provider of index.providers) {
      provider.route = providerRoute('/', provider.slug);
    }

    expect(() => assertRoutesResolve(index, {
      models: index.models.map((model) => model.slug),
      providers: ['alpha'],
    })).toThrow(/provider index row "beta" has no generated detail route/);
  });

  it('fails when an alias republishes a route to a page nobody builds', () => {
    const index = buildCatalogIndex(makeDataset());
    const [alias] = index.aliases.filter((row) => row.entity === 'organization');
    alias.route = providerRoute('/', alias.targetSlug);

    expect(() => assertRoutesResolve(index, { models: index.models.map((model) => model.slug) }))
      .toThrow(/alias row ".+" routes to organization "\w+", which has no generated detail route/);
  });

  it('passes when every published route has a generated page', () => {
    const index = buildCatalogIndex(makeDataset());

    expect(assertRoutesResolve(index, {
      models: index.models.map((model) => model.slug),
      // Both fixture organizations hold releases, so both now get a page and the
      // caller must declare them.
      providers: index.providers.map((provider) => provider.slug),
    })).toBe(index);
  });

  it('holds the real dataset index to the routes the build generates', () => {
    const index = buildCatalogIndex(seedDataset, '/ModelTree');
    const providerSlugs = buildCreatorEcosystems(seedDataset)
      .map((ecosystem) => ecosystem.organization.slug);

    // Positive control: the real dataset must record a release for at least one
    // organization, or the routed-provider assertions below would pass on an
    // empty set. The stronger control is differential -- the routed set must be
    // larger than the featured one, or this test would still pass against the
    // old featured-only derivation it exists to rule out.
    expect(providerSlugs.length).toBeGreaterThan(0);
    expect(providerSlugs.length).toBeGreaterThan(buildLineageEcosystems(seedDataset).length);

    expect(assertRoutesResolve(index, {
      models: seedDataset.releases.map((release) => release.slug),
      providers: providerSlugs,
    })).toBe(index);

    // An organization with releases now carries its generated provider route;
    // any organization without them keeps a null route, because no page lands it.
    const routed = new Set(providerSlugs);
    for (const provider of index.providers) {
      if (routed.has(provider.slug)) {
        expect(provider.route).toBe(`/ModelTree/providers/${provider.slug}/`);
      } else {
        expect(provider.route).toBeNull();
      }
    }

    // Organization aliases route the same way, from the same helper, so a search
    // hit on any creator with releases opens its page and an organization with
    // no page does not advertise a route that would 404.
    const organizationAliases = index.aliases.filter((alias) => alias.entity === 'organization');
    expect(organizationAliases).not.toHaveLength(0);
    for (const alias of organizationAliases) {
      if (routed.has(alias.targetSlug)) {
        expect(alias.route).toBe(`/ModelTree/providers/${alias.targetSlug}/`);
      } else {
        expect(alias.route).toBeNull();
      }
    }
  });

  it('refuses the real dataset index when its provider routes are not declared', () => {
    const index = buildCatalogIndex(seedDataset, '/ModelTree');

    // The index now publishes a real provider route for every organization with
    // releases; omitting the providers key states no provider page is
    // built, so the fail-closed guard must reject rather than wave them through.
    expect(buildCreatorEcosystems(seedDataset).length).toBeGreaterThan(0);
    expect(() => assertRoutesResolve(index, {
      models: seedDataset.releases.map((release) => release.slug),
    })).toThrow(/provider index row ".+" has no generated detail route/);
  });

  it('keeps the real dataset index within its payload budget', () => {
    const index = buildCatalogIndex(seedDataset, '/');
    const size = measureIndexSize(index);

    // Budgeted per row and per shipped page, because the index itself grows
    // with the catalog while a catalog page only ever ships one page slice.
    expect(size.bytesPerModelRow).toBeLessThanOrEqual(600);
    expect(size.bytesPerModelRow * 24).toBeLessThanOrEqual(20_480);
  });

  it('carries the creator\'s fuller recorded form only where it differs from the label', () => {
    // This is what keeps the row inside the budget above. Search must match
    // either recorded form (#479), but carrying both on every row breached that
    // budget, while carrying the fuller form only where the record actually
    // distinguishes the two stays inside it. The measured figures are not
    // restated here: the assertion above is what holds them, and it fails
    // loudly when the dataset moves them, which a comment cannot do.
    // A present value also states that the record makes a distinction, so
    // repeating the label here would assert one it does not make.
    const index = buildCatalogIndex(seedDataset, '/');
    const organizationBySlug = new Map(seedDataset.organizations.map((item) => [item.slug, item]));
    expect(index.models.length).toBeGreaterThan(0);

    let carried = 0;
    for (const row of index.models) {
      const organization = organizationBySlug.get(row.organizationSlug)!;
      const distinct = organizationFullNameIfDistinct(organization);
      expect(row.organizationFullName).toBe(distinct ?? undefined);
      if (row.organizationFullName) carried += 1;
    }

    // Controls: the sweep is neither vacuous nor universal. Some rows carry it
    // and some do not, so `toBe` above discriminates in both directions.
    expect(carried).toBeGreaterThan(0);
    expect(carried).toBeLessThan(index.models.length);
  });

  it('routes every real model row at its generated detail page', () => {
    const index = buildCatalogIndex(seedDataset, '/');
    const slugs = new Set(seedDataset.releases.map((release) => release.slug));

    expect(index.models).not.toHaveLength(0);
    for (const model of index.models) {
      expect(slugs.has(model.slug)).toBe(true);
      expect(model.route).toBe(`/models/${model.slug}/`);
    }
  });

  it('lists every release regardless of whether it is featured', () => {
    // `buildCatalogIndex` never reads `featured` (catalog.ts:193-222), and
    // nothing downstream of it may start to. Moving a creator between the Model
    // Tree's Featured and Others branches changes which releases carry the flag;
    // the catalog at /models must be untouched by that, because a reader would
    // experience a missing release as the site being wrong rather than as an
    // editorial choice.
    const index = buildCatalogIndex(seedDataset, '/');
    const notFeatured = seedDataset.releases.filter((release) => !release.featured);
    const featured = seedDataset.releases.filter((release) => release.featured);
    const indexedSlugs = new Set(index.models.map((model) => model.slug));

    // Positive controls: with either group empty this proves nothing at all.
    expect(notFeatured.length).toBeGreaterThan(0);
    expect(featured.length).toBeGreaterThan(0);

    expect(index.models).toHaveLength(seedDataset.releases.length);
    for (const release of seedDataset.releases) expect(indexedSlugs.has(release.slug)).toBe(true);
    expect(index.coverage.releases).toBe(seedDataset.releases.length);
    // The creator facet counts unfiltered releases too, so a creator on the
    // Others branch still appears in the catalog's own filters.
    const facetTotal = index.facets.creators.reduce((sum, entry) => sum + entry.count, 0);
    expect(facetTotal).toBe(seedDataset.releases.length);
  });

  it('indexes a dataset in which no release is featured at all', () => {
    // The catalog does not depend on a featured release existing, so the flag
    // cannot become a filter by accident. The Model Tree page keeps its own
    // separate guard for that (tree.astro:21); this one must not.
    const index = buildCatalogIndex(makeDataset());

    expect(makeDataset().releases.every((release) => !release.featured)).toBe(true);
    expect(index.models).toHaveLength(3);
    expect(index.models.map((model) => model.slug).sort())
      .toEqual(['alpha-new', 'alpha-old', 'beta-same']);
  });

  it('honours a project base path', () => {
    const index = buildCatalogIndex(seedDataset, '/ModelTree');

    expect(index.models[0].route.startsWith('/ModelTree/models/')).toBe(true);
    expect(providerRoute('/ModelTree', 'openai')).toBe('/ModelTree/providers/openai/');
  });
});
