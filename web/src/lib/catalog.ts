import type { Dataset } from '../data/schema';
import { accessLabel, categoryLabel, statusLabel } from './format';
import { buildLineageEcosystems } from './lineage-view';

export const CATALOG_INDEX_VERSION = 1;

export class CatalogIndexError extends Error {
  constructor(issues: string[]) {
    super(`Catalog index generation failed:\n- ${issues.join('\n- ')}`);
    this.name = 'CatalogIndexError';
  }
}

export type ContextTier = 'unknown' | 'up-to-128k' | '128k-to-1m' | '1m-and-above';
export type ModelSort = 'release-date' | 'name' | 'recently-verified';
export type ProviderRole = 'creator' | 'serving-platform' | 'creator-and-platform';
export type AliasEntity = 'model' | 'family' | 'organization' | 'product' | 'serving-platform';

export interface ModelIndexRow {
  slug: string;
  name: string;
  variant: string;
  organizationSlug: string;
  organizationName: string;
  familySlug: string;
  familyName: string;
  releaseDate: string;
  status: string;
  accessType: string;
  categories: string[];
  inputModalities: string[];
  outputModalities: string[];
  contextWindow: number | null;
  contextTier: ContextTier;
  weightsDownloadable: boolean;
  hasPublishedPrice: boolean;
  verifiedAt: string;
  route: string;
}

export interface ProviderIndexRow {
  slug: string;
  name: string;
  shortName: string;
  role: ProviderRole;
  type: string;
  initial: string;
  familyCount: number;
  releaseCount: number;
  categories: string[];
  verifiedAt: string;
  /** Null while no provider detail page is generated, so no row advertises a 404. */
  route: string | null;
}

export interface AliasIndexRow {
  alias: string;
  normalized: string;
  entity: AliasEntity;
  targetSlug: string;
  label: string;
  route: string | null;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export interface CatalogFacets {
  creators: FacetValue[];
  families: FacetValue[];
  categories: FacetValue[];
  modalities: FacetValue[];
  accessTypes: FacetValue[];
  statuses: FacetValue[];
  releaseYears: FacetValue[];
  contextTiers: FacetValue[];
  priceAvailability: FacetValue[];
}

export interface ReleaseDateRow {
  slug: string;
  releaseDate: string;
  year: number;
  route: string;
}

export interface CatalogIndex {
  version: number;
  latestVerifiedAt: string;
  contentHash: string;
  coverage: Record<string, number>;
  models: ModelIndexRow[];
  providers: ProviderIndexRow[];
  aliases: AliasIndexRow[];
  facets: CatalogFacets;
  releaseDates: ReleaseDateRow[];
}

/** Codepoint order, so index output does not vary with the host's locale. */
function compare(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function normalizeBase(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

export function modelRoute(base: string, slug: string) {
  return `${normalizeBase(base)}models/${slug}/`;
}

/**
 * The shape a provider detail route takes. Nothing publishes it yet: the build
 * generates no provider pages, so provider rows carry a null route until it does.
 */
export function providerRoute(base: string, slug: string) {
  return `${normalizeBase(base)}providers/${slug}/`;
}

export function contextTierOf(contextWindow?: number): ContextTier {
  if (contextWindow === undefined) return 'unknown';
  if (contextWindow <= 128_000) return 'up-to-128k';
  if (contextWindow < 1_000_000) return '128k-to-1m';
  return '1m-and-above';
}

export function contextTierLabel(tier: ContextTier) {
  return {
    unknown: 'Context window unknown',
    'up-to-128k': 'Up to 128K tokens',
    '128k-to-1m': '128K to 1M tokens',
    '1m-and-above': '1M tokens and above',
  }[tier];
}

/** FNV-1a over the serialized index, so identical data yields an identical hash. */
function contentHashOf(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

function countFacet(
  entries: Array<{ value: string; label: string }>,
  order: 'value' | 'value-desc' = 'value',
): FacetValue[] {
  const counts = new Map<string, FacetValue>();

  for (const entry of entries) {
    const existing = counts.get(entry.value);
    if (existing) existing.count += 1;
    else counts.set(entry.value, { value: entry.value, label: entry.label, count: 1 });
  }

  return [...counts.values()].sort((a, b) => (
    order === 'value-desc' ? compare(b.value, a.value) : compare(a.value, b.value)
  ));
}

const MODEL_COMPARATORS: Record<ModelSort, (a: ModelIndexRow, b: ModelIndexRow) => number> = {
  'release-date': (a, b) => compare(b.releaseDate, a.releaseDate) || compare(a.slug, b.slug),
  name: (a, b) => compare(a.name, b.name) || compare(a.slug, b.slug),
  'recently-verified': (a, b) => compare(b.verifiedAt, a.verifiedAt) || compare(a.slug, b.slug),
};

export function sortModels(rows: readonly ModelIndexRow[], sort: ModelSort = 'release-date') {
  return [...rows].sort(MODEL_COMPARATORS[sort]);
}

export function buildCatalogIndex(dataset: Dataset, base = '/'): CatalogIndex {
  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));
  const familyById = new Map(dataset.families.map((item) => [item.id, item]));

  // The organizations `/providers/[slug]` actually generates a page for, read
  // from the same derivation the route itself uses (see routes.ts). A provider
  // row or an organization alias publishes a canonical route only when a page
  // stands behind it; every other organization keeps a null route so no row ever
  // advertises a 404. `assertRoutesResolve` holds this to the generated slugs.
  const routedProviderSlugs = new Set(
    buildLineageEcosystems(dataset).map((ecosystem) => ecosystem.organization.slug),
  );
  const providerRouteFor = (slug: string) => (
    routedProviderSlugs.has(slug) ? providerRoute(base, slug) : null
  );

  const pricedDeploymentIds = new Set(dataset.pricing.map((price) => price.deploymentId));
  const pricedReleaseIds = new Set(
    dataset.deployments
      .filter((deployment) => pricedDeploymentIds.has(deployment.id))
      .map((deployment) => deployment.releaseId),
  );

  const issues: string[] = [];
  const models: ModelIndexRow[] = [];

  for (const release of dataset.releases) {
    const organization = organizationById.get(release.organizationId);
    const family = familyById.get(release.familyId);
    if (!organization || !family) {
      issues.push(`release ${release.id} has no resolvable organization or family`);
      continue;
    }

    models.push({
      slug: release.slug,
      name: release.displayName,
      variant: release.variant,
      organizationSlug: organization.slug,
      organizationName: organization.name,
      familySlug: family.slug,
      familyName: family.name,
      releaseDate: release.releaseDate,
      status: release.status,
      accessType: release.accessType,
      categories: [...release.categories].sort(compare),
      inputModalities: [...release.inputModalities].sort(compare),
      outputModalities: [...release.outputModalities].sort(compare),
      contextWindow: release.contextWindow ?? null,
      contextTier: contextTierOf(release.contextWindow),
      weightsDownloadable: release.license?.weightsDownloadable ?? false,
      hasPublishedPrice: pricedReleaseIds.has(release.id),
      verifiedAt: release.verifiedAt,
      route: modelRoute(base, release.slug),
    });
  }

  const platformOperatorIds = new Set(dataset.servingPlatforms.map((item) => item.organizationId));
  const creatorIds = new Set(dataset.families.map((item) => item.organizationId));

  const providers: ProviderIndexRow[] = dataset.organizations
    .map((organization) => {
      const families = dataset.families.filter((item) => item.organizationId === organization.id);
      const releases = dataset.releases.filter((item) => item.organizationId === organization.id);
      const isCreator = creatorIds.has(organization.id);
      const isPlatform = platformOperatorIds.has(organization.id);
      const initial = organization.name.slice(0, 1).toUpperCase();

      return {
        slug: organization.slug,
        name: organization.name,
        shortName: organization.shortName,
        role: (isCreator && isPlatform
          ? 'creator-and-platform'
          : isPlatform ? 'serving-platform' : 'creator') as ProviderRole,
        type: organization.type,
        initial: /^[A-Z]$/.test(initial) ? initial : '#',
        familyCount: families.length,
        releaseCount: releases.length,
        categories: [...new Set(families.flatMap((item) => item.categories))].sort(compare),
        verifiedAt: organization.verifiedAt,
        // A canonical route only where a provider page is generated for this
        // organization; null otherwise, so no row advertises a 404.
        route: providerRouteFor(organization.slug),
      };
    })
    .sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug));

  const aliases: AliasIndexRow[] = [];
  const addAlias = (
    alias: string,
    entity: AliasEntity,
    targetSlug: string,
    label: string,
    route: string | null,
  ) => {
    aliases.push({ alias, normalized: alias.toLowerCase(), entity, targetSlug, label, route });
  };

  for (const release of dataset.releases) {
    const route = modelRoute(base, release.slug);
    const names = new Set([release.canonicalName, release.displayName, ...release.apiAliases]);
    for (const alias of names) addAlias(alias, 'model', release.slug, release.displayName, route);
  }
  for (const family of dataset.families) {
    addAlias(family.name, 'family', family.slug, family.name, null);
  }
  for (const organization of dataset.organizations) {
    const route = providerRouteFor(organization.slug);
    const names = new Set([organization.name, organization.shortName]);
    for (const alias of names) {
      addAlias(alias, 'organization', organization.slug, organization.name, route);
    }
  }
  for (const product of dataset.products) {
    addAlias(product.name, 'product', product.slug, product.name, null);
  }
  for (const platform of dataset.servingPlatforms) {
    addAlias(platform.name, 'serving-platform', platform.slug, platform.name, null);
  }

  aliases.sort((a, b) => (
    compare(a.normalized, b.normalized)
    || compare(a.entity, b.entity)
    || compare(a.targetSlug, b.targetSlug)
  ));

  const sortedModels = sortModels(models);

  const facets: CatalogFacets = {
    creators: countFacet(sortedModels.map((model) => ({
      value: model.organizationSlug,
      label: model.organizationName,
    }))),
    families: countFacet(sortedModels.map((model) => ({
      value: model.familySlug,
      label: model.familyName,
    }))),
    categories: countFacet(sortedModels.flatMap((model) => model.categories.map((category) => ({
      value: category,
      label: categoryLabel(category as never),
    })))),
    modalities: countFacet(sortedModels.flatMap((model) => (
      [...new Set([...model.inputModalities, ...model.outputModalities])].map((value) => ({
        value,
        label: `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`,
      }))
    ))),
    accessTypes: countFacet(sortedModels.map((model) => ({
      value: model.accessType,
      label: accessLabel(model.accessType as never),
    }))),
    statuses: countFacet(sortedModels.map((model) => ({
      value: model.status,
      label: statusLabel(model.status as never),
    }))),
    releaseYears: countFacet(sortedModels.map((model) => ({
      value: model.releaseDate.slice(0, 4),
      label: model.releaseDate.slice(0, 4),
    })), 'value-desc'),
    contextTiers: countFacet(sortedModels.map((model) => ({
      value: model.contextTier,
      label: contextTierLabel(model.contextTier),
    }))),
    priceAvailability: countFacet(sortedModels.map((model) => ({
      value: model.hasPublishedPrice ? 'published' : 'not-published',
      label: model.hasPublishedPrice ? 'Published price' : 'No published price',
    }))),
  };

  const releaseDates: ReleaseDateRow[] = sortedModels.map((model) => ({
    slug: model.slug,
    releaseDate: model.releaseDate,
    year: Number(model.releaseDate.slice(0, 4)),
    route: model.route,
  }));

  const verificationDates = [
    ...dataset.organizations.map((item) => item.verifiedAt),
    ...dataset.families.map((item) => item.verifiedAt),
    ...dataset.releases.map((item) => item.verifiedAt),
  ].sort(compare);

  if (issues.length) throw new CatalogIndexError(issues);

  const body = {
    version: CATALOG_INDEX_VERSION,
    latestVerifiedAt: verificationDates.at(-1) ?? '',
    coverage: {
      organizations: dataset.organizations.length,
      families: dataset.families.length,
      releases: dataset.releases.length,
      products: dataset.products.length,
      servingPlatforms: dataset.servingPlatforms.length,
      sources: dataset.sources.length,
    },
    models: sortedModels,
    providers,
    aliases,
    facets,
    releaseDates,
  };

  return { ...body, contentHash: contentHashOf(body) };
}

export interface PaginationPage {
  number: number;
  start: number;
  end: number;
  slugs: string[];
}

export interface PaginationPlan {
  pageSize: number;
  pageCount: number;
  total: number;
  pages: PaginationPage[];
}

export function planPagination(slugs: readonly string[], pageSize: number): PaginationPlan {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new CatalogIndexError([`page size must be a positive integer, received ${pageSize}`]);
  }

  const pages: PaginationPage[] = [];
  for (let start = 0; start < slugs.length; start += pageSize) {
    pages.push({
      number: pages.length + 1,
      start,
      end: Math.min(start + pageSize, slugs.length) - 1,
      slugs: slugs.slice(start, start + pageSize),
    });
  }

  return { pageSize, pageCount: pages.length, total: slugs.length, pages };
}

/**
 * Index rows promise a detail page. Callers pass the slugs their routes actually
 * generate, so an index row for a page nobody builds fails the build instead.
 *
 * Every non-null route in the index is checked, including alias rows. A caller
 * that omits `providers` is not opting out of the provider check: it is stating
 * that no provider page is generated, so any provider route at all is a 404.
 */
export function assertRoutesResolve(
  index: CatalogIndex,
  available: { models: Iterable<string>; providers?: Iterable<string> },
) {
  const modelSlugs = new Set(available.models);
  const providerSlugs = new Set(available.providers ?? []);
  const issues: string[] = [];

  for (const model of index.models) {
    if (!modelSlugs.has(model.slug)) {
      issues.push(`model index row "${model.slug}" has no generated detail route`);
    }
  }

  for (const provider of index.providers) {
    if (provider.route !== null && !providerSlugs.has(provider.slug)) {
      issues.push(`provider index row "${provider.slug}" has no generated detail route`);
    }
  }

  // Entities absent from this map generate no pages at all, so any route they
  // publish is a 404 by definition.
  const aliasTargets: Partial<Record<AliasEntity, Set<string>>> = {
    model: modelSlugs,
    organization: providerSlugs,
  };

  for (const alias of index.aliases) {
    if (alias.route === null) continue;
    if (!aliasTargets[alias.entity]?.has(alias.targetSlug)) {
      issues.push(
        `alias row "${alias.alias}" routes to ${alias.entity} "${alias.targetSlug}", `
        + 'which has no generated detail route',
      );
    }
  }

  if (issues.length) throw new CatalogIndexError(issues);
  return index;
}

/** Bytes each section would add to a page payload, for budget checks. */
export function measureIndexSize(index: CatalogIndex) {
  const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  return {
    total: bytesOf(index),
    models: bytesOf(index.models),
    providers: bytesOf(index.providers),
    aliases: bytesOf(index.aliases),
    facets: bytesOf(index.facets),
    releaseDates: bytesOf(index.releaseDates),
    bytesPerModelRow: index.models.length
      ? Math.round(bytesOf(index.models) / index.models.length)
      : 0,
  };
}
