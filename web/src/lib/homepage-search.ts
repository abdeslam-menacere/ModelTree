import type { Dataset, DatePrecision } from '../data/schema';
import { accessLabel, categoryLabel, statusLabel } from './format';
import { buildLineageEcosystems } from './lineage-view';
import { organizationLabel, organizationSearchTerms } from './organization-name';

/**
 * The homepage search index: a compact, source-derived view that lets a visitor
 * find and narrow the **featured** releases already shown on the homepage — the
 * exact set `buildLineageEcosystems` renders, never the long-tail catalog. The
 * `/models` catalog owns whole-catalog search; searching it from the homepage is
 * an explicit non-goal, so this index deliberately scopes itself smaller.
 *
 * Every field here is derived from validated records and is an approved display
 * field (names, known aliases, family, creator, product, and the controlled
 * category/access/status/period vocabularies). Nothing is fetched at runtime,
 * nothing is written back into the dataset, and nothing here invents a score, an
 * overall rank, or a popularity ordering — those are non-goals of this feature.
 *
 * Each searchable entity records its {@link HomeEntityType}, because a creator, a
 * model family, a model, and a product are separate entities that may share a
 * name and must stay distinguishable in a suggestion list.
 */

export const HOMEPAGE_SEARCH_INDEX_VERSION = 1;

export type HomeEntityType = 'model' | 'family' | 'organization' | 'product';

/** Sort priority for suggestions, so a model beats a family beats a creator, etc. */
const ENTITY_ORDER: Record<HomeEntityType, number> = {
  model: 0,
  family: 1,
  organization: 2,
  product: 3,
};

export interface HomeReleaseRow {
  slug: string;
  name: string;
  canonicalName: string;
  familySlug: string;
  familyName: string;
  organizationSlug: string;
  organizationName: string;
  releaseDate: string;
  datePrecision: DatePrecision;
  /** The four-digit year, read identically from `2026`, `2026-03`, `2026-03-14`. */
  releaseYear: string;
  status: string;
  accessType: string;
  categories: string[];
  route: string;
  verifiedAt: string;
  /**
   * Normalized searchable terms for this release, each derived from an approved
   * display field: the canonical and display names, known API aliases, and the
   * names of the family, creator, and any product that routes to it. A query
   * matches when every one of its tokens is found among these terms.
   */
  terms: string[];
}

export interface HomeSuggestion {
  /** The term as displayed, e.g. a model name, an alias, a family or creator name. */
  term: string;
  normalized: string;
  entity: HomeEntityType;
  /** Provider/family (or role) context, so two same-named entities read apart. */
  context: string;
  /**
   * The release this suggestion selects when chosen, when it resolves to exactly
   * one homepage release; otherwise null, and choosing it narrows the query.
   */
  targetSlug: string | null;
  route: string | null;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export interface HomeSearchFacets {
  categories: FacetValue[];
  access: FacetValue[];
  statuses: FacetValue[];
  periods: FacetValue[];
}

export interface HomepageSearchIndex {
  version: number;
  releases: HomeReleaseRow[];
  suggestions: HomeSuggestion[];
  facets: HomeSearchFacets;
  contentHash: string;
}

/** Codepoint order, so index output does not vary with the host's locale. */
function compare(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function normalizeBase(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

function modelRoute(base: string, slug: string) {
  return `${normalizeBase(base)}models/${slug}/`;
}

/**
 * Lowercases and reduces a value to space-separated alphanumeric tokens.
 * Punctuation becomes a separator and is never removed, so `GPT-4o` and
 * `gpt 4o` both fold to `gpt 4o`, while `gpt4o` stays distinct as `gpt4o`.
 * Diacritics are folded, so `DeepSeek-R1` and a stray accented spelling meet.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The distinct normalized tokens in a value, in first-seen order. */
export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalized.split(' ')) {
    if (token && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Whether a release's terms satisfy a query. Every query token must be a
 * substring of the release's combined term text, so a multi-word query narrows
 * (AND) rather than widens, and a partial token like `gpt` still matches
 * `gpt-4o`. An empty query matches everything.
 */
export function releaseMatchesQuery(row: HomeReleaseRow, query: string): boolean {
  const tokens = tokenize(query);
  if (!tokens.length) return true;
  const haystack = ` ${row.terms.join(' ')} `;
  return tokens.every((token) => haystack.includes(token));
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

/** FNV-1a over the serialized body, so identical data yields an identical hash. */
function contentHashOf(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const ORGANIZATION_ROLE_LABEL = 'Creator';
const PRODUCT_ROLE_LABEL = 'Product';

/**
 * Builds the homepage search index from the featured ecosystems.
 *
 * The release set is exactly what the homepage lineage explorer shows, taken
 * from {@link buildLineageEcosystems}, so search and the visible tree can never
 * drift apart and neither reaches into the long-tail catalog. The dataset is
 * only read here — no record is mutated — so this is safe to call at build time
 * and the "filtering never mutates source data" criterion holds at the source.
 */
export function buildHomepageSearchIndex(dataset: Dataset, base = '/'): HomepageSearchIndex {
  const ecosystems = buildLineageEcosystems(dataset);

  const releases: HomeReleaseRow[] = [];
  const suggestions: HomeSuggestion[] = [];
  const seenSuggestion = new Set<string>();

  const addSuggestion = (suggestion: HomeSuggestion) => {
    const key = `${suggestion.entity}\u0000${suggestion.normalized}\u0000${suggestion.targetSlug ?? ''}`;
    if (seenSuggestion.has(key)) return;
    seenSuggestion.add(key);
    suggestions.push(suggestion);
  };

  // The homepage release ids, so a product's routing can be intersected with the
  // set that actually appears here rather than the whole dataset.
  const homepageReleaseIdBySlug = new Map<string, string>();
  const homepageReleaseSlugById = new Map<string, string>();

  for (const ecosystem of ecosystems) {
    const { organization } = ecosystem;

    // A creator is one entity, so it contributes one row. Both recorded forms
    // stay *matchable* — `normalized` is what the query is tested against, and
    // it carries every recorded form — while the row *displays* the label. So a
    // creator is neither shown under two different strings nor listed twice
    // under one.
    //
    // The second of those is why this emits a single suggestion. Emitting one
    // per recorded form was correct while `term` was the loop variable; once
    // `term` became the label it stopped varying, and a creator whose two forms
    // differ produced two rows that were identical to read *and* identical to
    // choose, since choosing sets the query to `term`.
    //
    // De-duplicated after normalizing, not before: two recorded forms differing
    // only by punctuation or case fold to the same tokens. The label's form
    // leads, so an alias only ever extends the string and never moves where
    // this row sorts. See `organization-name.ts`.
    addSuggestion({
      term: organizationLabel(organization),
      normalized: [...new Set(
        organizationSearchTerms(organization).map(normalizeText).filter(Boolean),
      )].join(' '),
      entity: 'organization',
      context: ORGANIZATION_ROLE_LABEL,
      targetSlug: null,
      route: null,
    });

    for (const familyView of ecosystem.families) {
      const { family } = familyView;

      addSuggestion({
        term: family.name,
        normalized: normalizeText(family.name),
        entity: 'family',
        context: `${organizationLabel(organization)} family`,
        targetSlug: null,
        route: null,
      });

      for (const release of familyView.releases) {
        const route = modelRoute(base, release.slug);
        homepageReleaseIdBySlug.set(release.slug, release.id);
        homepageReleaseSlugById.set(release.id, release.slug);

        const aliasTerms = new Set<string>([
          release.canonicalName,
          release.displayName,
          ...release.apiAliases,
        ]);

        const terms = new Set<string>();
        const addTerm = (value: string) => {
          const normalized = normalizeText(value);
          if (normalized) terms.add(normalized);
        };
        for (const alias of aliasTerms) addTerm(alias);
        addTerm(family.name);
        addTerm(organization.name);
        addTerm(organization.shortName);

        releases.push({
          slug: release.slug,
          name: release.displayName,
          canonicalName: release.canonicalName,
          familySlug: family.slug,
          familyName: family.name,
          organizationSlug: organization.slug,
          organizationName: organizationLabel(organization),
          releaseDate: release.releaseDate,
          datePrecision: release.datePrecision,
          releaseYear: release.releaseDate.slice(0, 4),
          status: release.status,
          accessType: release.accessType,
          categories: [...release.categories].sort(compare),
          route,
          verifiedAt: release.verifiedAt,
          terms: [...terms].sort(compare),
        });

        // The model itself, and each distinct alias, are model-typed suggestions
        // that select this one release.
        addSuggestion({
          term: release.displayName,
          normalized: normalizeText(release.displayName),
          entity: 'model',
          context: `${organizationLabel(organization)} · ${family.name}`,
          targetSlug: release.slug,
          route,
        });
        for (const alias of aliasTerms) {
          if (normalizeText(alias) === normalizeText(release.displayName)) continue;
          addSuggestion({
            term: alias,
            normalized: normalizeText(alias),
            entity: 'model',
            context: `Alias · ${release.displayName}`,
            targetSlug: release.slug,
            route,
          });
        }
      }
    }
  }

  // Products are separate entities that may route between models. A product is
  // searchable only where it routes to at least one homepage release; where it
  // routes to exactly one, choosing it selects that release, otherwise it
  // narrows the query. A product that routes nowhere on the homepage (routing
  // undisclosed or off the featured set) contributes nothing rather than a dead
  // suggestion — routing the sources do not state is never invented here.
  for (const product of dataset.products) {
    const routedSlugs = product.releaseIds
      .map((releaseId) => homepageReleaseSlugById.get(releaseId))
      .filter((slug): slug is string => slug !== undefined);
    if (!routedSlugs.length) continue;

    const uniqueSlugs = [...new Set(routedSlugs)].sort(compare);
    const targetSlug = uniqueSlugs.length === 1 ? uniqueSlugs[0] : null;
    addSuggestion({
      term: product.name,
      normalized: normalizeText(product.name),
      entity: 'product',
      context: PRODUCT_ROLE_LABEL,
      targetSlug,
      route: targetSlug ? modelRoute(base, targetSlug) : null,
    });

    // A product name is a legitimate way to reach the release(s) it routes to,
    // so it joins those releases' searchable terms too.
    for (const slug of uniqueSlugs) {
      const row = releases.find((candidate) => candidate.slug === slug);
      const normalized = normalizeText(product.name);
      if (row && normalized && !row.terms.includes(normalized)) {
        row.terms = [...row.terms, normalized].sort(compare);
      }
    }
  }

  releases.sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug));
  suggestions.sort((a, b) => (
    ENTITY_ORDER[a.entity] - ENTITY_ORDER[b.entity]
    || compare(a.normalized, b.normalized)
    || compare(a.targetSlug ?? '', b.targetSlug ?? '')
  ));

  const facets: HomeSearchFacets = {
    categories: countFacet(releases.flatMap((row) => row.categories.map((category) => ({
      value: category,
      label: categoryLabel(category as never),
    })))),
    access: countFacet(releases.map((row) => ({
      value: row.accessType,
      label: accessLabel(row.accessType as never),
    }))),
    statuses: countFacet(releases.map((row) => ({
      value: row.status,
      label: statusLabel(row.status as never),
    }))),
    periods: countFacet(releases.map((row) => ({
      value: row.releaseYear,
      label: row.releaseYear,
    })), 'value-desc'),
  };

  const body = {
    version: HOMEPAGE_SEARCH_INDEX_VERSION,
    releases,
    suggestions,
    facets,
  };

  return { ...body, contentHash: contentHashOf(body) };
}

/** Bytes the index would add to the homepage payload, for budget checks. */
export function measureHomepageSearchIndexSize(index: HomepageSearchIndex) {
  const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  return {
    total: bytesOf(index),
    releases: bytesOf(index.releases),
    suggestions: bytesOf(index.suggestions),
    facets: bytesOf(index.facets),
  };
}
