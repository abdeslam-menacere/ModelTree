import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import { validateDataset } from '../data/validate';
import {
  assertRoutesResolve,
  buildCatalogIndex,
  CatalogIndexError,
  measureIndexSize,
  planPagination,
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
        firstReleaseDate: '2025-01-01',
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
        categories: ['coding'],
        firstReleaseDate: '2025-01-01',
        status: 'current',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
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
  it('fails when an index row has no detail route to land on', () => {
    const index = buildCatalogIndex(makeDataset());
    const models = index.models.map((model) => model.slug);

    expect(() => assertRoutesResolve(index, { models, providers: ['alpha'] }))
      .toThrow(/provider index row "beta" has no generated detail route/);
  });

  it('passes when every row has a route', () => {
    const index = buildCatalogIndex(makeDataset());

    expect(assertRoutesResolve(index, {
      models: index.models.map((model) => model.slug),
      providers: index.providers.map((provider) => provider.slug),
    })).toBe(index);
  });

  it('keeps the real dataset index within its payload budget', () => {
    const index = buildCatalogIndex(seedDataset, '/');
    const size = measureIndexSize(index);

    // Budgeted per row and per shipped page, because the index itself grows
    // with the catalog while a catalog page only ever ships one page slice.
    expect(size.bytesPerModelRow).toBeLessThanOrEqual(600);
    expect(size.bytesPerModelRow * 24).toBeLessThanOrEqual(20_480);
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

  it('honours a project base path', () => {
    const index = buildCatalogIndex(seedDataset, '/ModelTree');

    expect(index.models[0].route.startsWith('/ModelTree/models/')).toBe(true);
    expect(index.providers[0].route.startsWith('/ModelTree/providers/')).toBe(true);
  });
});
