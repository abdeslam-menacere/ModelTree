/**
 * The benchmark evidence explorer's build-time view model (issue #23).
 *
 * `/benchmarks` answers one question a reader arrives with from a "See evidence"
 * link: for the models I selected, what was actually measured, under which
 * conditions, and can any of these numbers honestly be read against each other?
 *
 * Three rules shape everything below.
 *
 * 1. **This layer never compares raw result rows itself.** Every comparability
 *    judgement is delegated to `comparability.ts` (issue #22): results are
 *    filtered to the selected releases and handed to {@link buildComparabilityGroups},
 *    and this module only arranges the groups it gets back. The issue names this
 *    as a hard non-goal — "never compare raw result rows ad hoc in a component" —
 *    and honouring it is why no score is read, ranked, or thresholded here.
 *
 * 2. **Absence is stated, never smoothed.** A selected model with no benchmark
 *    result, a selection whose models share no benchmark, and a selection filtered
 *    down to nothing are three different outcomes, each with its own explanation
 *    and its own valid next actions. None of them is a blank screen.
 *
 * 3. **No composite score, no overall winner.** Groups are ordered by domain and
 *    benchmark name, never by score; ordering inside a group stays inside
 *    `comparability.ts`, whose own contract is that it never ranks across groups.
 *
 * The URL contract is shared, not reinvented. The `models` parameter is the same
 * one the lineage drawer's evidence actions already write, imported from
 * {@link EVIDENCE_MODELS_PARAMETER} rather than retyped; the documented ceiling on
 * selected models is derived from `compare-route.ts` rather than a fresh literal.
 * `domain` and `benchmark` are the two optional filters `compare-route.ts` already
 * reserves for this route, and this module is where they gain meaning.
 */
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ModelFamily,
  ModelRelease,
  Organization,
  Publisher,
  SourceReference,
} from '../data/schema';
import {
  buildComparabilityGroups,
  buildGroupTable,
  UNDISCLOSED_LABEL,
  type ComparabilityGroup,
  type ComparabilityRange,
  type ComparabilityTable,
  type ComparabilityVerdict,
  type EvaluationWindow,
} from './comparability';
import { EVIDENCE_MODELS_PARAMETER } from './evidence-actions';
import { MAX_COMPARISON_MODELS, MIN_COMPARISON_MODELS, compareUrl } from './compare-route';

// The parameter name and the ceiling are consumed, not redefined: importing them
// is what keeps a URL the drawer writes readable by the route that resolves it.
export { EVIDENCE_MODELS_PARAMETER } from './evidence-actions';

/**
 * The two optional filters that ride alongside `models` on this route.
 * `compare-route.ts` documents that it preserves but gives no meaning to a
 * `domain` and a `benchmark`; this route is where they mean something.
 */
export const EVIDENCE_DOMAIN_PARAMETER = 'domain';
export const EVIDENCE_BENCHMARK_PARAMETER = 'benchmark';

/**
 * The documented maximum number of models a share URL may select, answering the
 * issue's open question directly. It is the comparison ceiling rather than a new
 * number, because a reader moves between `/benchmarks` and `/compare` carrying
 * the same `models` list and a limit that changed under them would silently drop
 * models on the way.
 */
export const MAX_SELECTED_MODELS = MAX_COMPARISON_MODELS;

/** The point at which a selection can yield a cross-model comparison at all. */
export const MIN_COMPARABLE_MODELS = MIN_COMPARISON_MODELS;

export type BenchmarkDomain = BenchmarkDefinition['domain'];

/** Reader-facing labels for the eight capability domains the schema allows. */
export const DOMAIN_LABELS: Record<BenchmarkDomain, string> = {
  'general-reasoning': 'General reasoning',
  mathematics: 'Mathematics',
  coding: 'Coding',
  'tool-use-agents': 'Tool use & agents',
  multimodal: 'Multimodal',
  'long-context': 'Long context',
  'human-preference': 'Human preference',
  operational: 'Operational',
};

export const VERDICT_LABELS: Record<ComparabilityVerdict, string> = {
  comparable: 'Comparable',
  'partially-comparable': 'Partially comparable',
  'not-comparable': 'Not comparable',
};

// ---------------------------------------------------------------------------
// Dataset payload
// ---------------------------------------------------------------------------

export type EvidenceRelease = Pick<
  ModelRelease,
  'id' | 'slug' | 'canonicalName' | 'displayName' | 'organizationId' | 'familyId' | 'verifiedAt'
>;

export type EvidenceSourceRecord = Pick<
  SourceReference,
  'id' | 'url' | 'title' | 'publisherId' | 'publishedDate' | 'lastCheckedDate'
>;

export type BenchmarkExplorerDataset = {
  releases: EvidenceRelease[];
  organizations: Array<Pick<Organization, 'id' | 'name'>>;
  families: Array<Pick<ModelFamily, 'id' | 'name'>>;
  publishers: Array<Pick<Publisher, 'id' | 'name'>>;
  sources: EvidenceSourceRecord[];
  benchmarks: BenchmarkDefinition[];
  benchmarkResults: BenchmarkResult[];
};

/**
 * Trim the full dataset to exactly the fields the evidence page reads, so the
 * records that travel to the browser stay small. The page is built ahead of
 * time and the selection is not known here, so — as on `/compare` — the data
 * ships with the page rather than being fetched, and its weight is kept visible
 * by {@link measureBenchmarkExplorerPayload}.
 */
export function buildBenchmarkExplorerPayload(
  dataset: BenchmarkExplorerDataset,
): BenchmarkExplorerDataset {
  return {
    releases: dataset.releases.map((release) => ({
      id: release.id,
      slug: release.slug,
      canonicalName: release.canonicalName,
      displayName: release.displayName,
      organizationId: release.organizationId,
      familyId: release.familyId,
      verifiedAt: release.verifiedAt,
    })),
    organizations: dataset.organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
    })),
    families: dataset.families.map((family) => ({ id: family.id, name: family.name })),
    publishers: dataset.publishers.map((publisher) => ({
      id: publisher.id,
      name: publisher.name,
    })),
    // Only sources a benchmark or a result actually cites can be reached, so the
    // rest never need to travel.
    sources: (() => {
      const cited = new Set<string>();
      for (const benchmark of dataset.benchmarks) for (const id of benchmark.sourceIds) cited.add(id);
      for (const result of dataset.benchmarkResults) for (const id of result.sourceIds) cited.add(id);
      return dataset.sources
        .filter((source) => cited.has(source.id))
        .map((source) => ({
          id: source.id,
          url: source.url,
          title: source.title,
          publisherId: source.publisherId,
          publishedDate: source.publishedDate,
          lastCheckedDate: source.lastCheckedDate,
        }));
    })(),
    benchmarks: dataset.benchmarks,
    benchmarkResults: dataset.benchmarkResults,
  };
}

export function measureBenchmarkExplorerPayload(payload: BenchmarkExplorerDataset) {
  const totalBytes = JSON.stringify(payload).length;
  return {
    totalBytes,
    releaseCount: payload.releases.length,
    resultCount: payload.benchmarkResults.length,
  };
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

export interface EvidenceFilters {
  /** A capability-domain value, or `null` for every domain. */
  domain: BenchmarkDomain | null;
  /** A benchmark slug, or `null` for every benchmark. */
  benchmark: string | null;
}

export const NO_FILTERS: EvidenceFilters = { domain: null, benchmark: null };

function normalizeBase(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

export function benchmarksRoute(base: string) {
  return `${normalizeBase(base)}benchmarks/`;
}

const DOMAIN_VALUES = new Set<string>(Object.keys(DOMAIN_LABELS));

/** The raw `models` list, split but not yet resolved against real releases. */
export function readEvidenceModels(search: string): string[] {
  const raw = new URLSearchParams(search).get(EVIDENCE_MODELS_PARAMETER);
  return raw === null ? [] : raw.split(',');
}

/**
 * The two filters, read defensively: a `domain` that is not one of the schema's
 * values is dropped rather than trusted, so a hand-edited URL cannot push an
 * unknown domain into the view. The benchmark value is validated later against
 * the selection, since which benchmarks exist depends on the data.
 */
export function readEvidenceFilters(search: string): EvidenceFilters {
  const params = new URLSearchParams(search);
  const domain = params.get(EVIDENCE_DOMAIN_PARAMETER);
  const benchmark = params.get(EVIDENCE_BENCHMARK_PARAMETER);
  return {
    domain: domain !== null && DOMAIN_VALUES.has(domain) ? (domain as BenchmarkDomain) : null,
    benchmark: benchmark !== null && benchmark.trim() !== '' ? benchmark.trim() : null,
  };
}

export function readEvidenceState(search: string) {
  return { slugs: readEvidenceModels(search), filters: readEvidenceFilters(search) };
}

/**
 * The query string for a state. Empty for the empty state, so a bare
 * `/benchmarks/` is reachable, and any unrelated parameter already present is
 * carried through untouched. This is the whole of "shareable and restorable":
 * the same slugs and the same filters serialise to the same string every time.
 */
export function serializeEvidenceState(
  slugs: readonly string[],
  filters: EvidenceFilters,
  currentSearch = '',
) {
  const carried = new URLSearchParams(currentSearch);
  carried.delete(EVIDENCE_MODELS_PARAMETER);
  carried.delete(EVIDENCE_DOMAIN_PARAMETER);
  carried.delete(EVIDENCE_BENCHMARK_PARAMETER);

  // Built by hand rather than through `URLSearchParams.toString()` so the
  // comma-separated slug list stays literal — `URLSearchParams` would escape the
  // comma to `%2C`, and the copied URL would then differ from the one the
  // lineage drawer's evidence action wrote. Slugs and the domain enum match
  // `[a-z0-9-]+`, so nothing here needs escaping.
  const parts: string[] = [];
  if (slugs.length > 0) parts.push(`${EVIDENCE_MODELS_PARAMETER}=${slugs.join(',')}`);
  if (filters.domain) parts.push(`${EVIDENCE_DOMAIN_PARAMETER}=${filters.domain}`);
  if (filters.benchmark) parts.push(`${EVIDENCE_BENCHMARK_PARAMETER}=${filters.benchmark}`);

  const carriedQuery = carried.toString();
  if (carriedQuery !== '') parts.push(carriedQuery);

  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

export function evidenceHref(
  base: string,
  slugs: readonly string[],
  filters: EvidenceFilters = NO_FILTERS,
  currentSearch = '',
) {
  return `${benchmarksRoute(base)}${serializeEvidenceState(slugs, filters, currentSearch)}`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type EvidenceRejectionCode = 'unknown-model' | 'duplicate-model' | 'over-capacity';

export interface EvidenceRejection {
  code: EvidenceRejectionCode;
  slug: string;
  /** A sentence naming the slug, so a live-region announcement is actionable. */
  message: string;
}

export interface EvidenceSelection {
  slugs: string[];
  rejections: EvidenceRejection[];
  isFull: boolean;
}

/**
 * Resolve a raw slug list against the releases that exist.
 *
 * Unlike a comparison, one selected model is a complete request — a "See
 * evidence" link carries a single slug — so there is no minimum. Unknown is
 * reported before duplicate because "no such model" is the problem a reader can
 * act on, and the capacity check runs last so a list where two entries are typos
 * still keeps its real models rather than spending the ceiling on ghosts.
 */
export function resolveEvidenceSelection(
  requested: readonly string[],
  knownSlugs: readonly string[],
): EvidenceSelection {
  const known = new Set(knownSlugs);
  const accepted: string[] = [];
  const rejections: EvidenceRejection[] = [];

  for (const raw of requested) {
    const slug = raw.trim();
    if (slug === '') continue;

    if (!known.has(slug)) {
      rejections.push({
        code: 'unknown-model',
        slug,
        message: `“${slug}” is not a model release in ModelTree, so it was left out of the evidence view.`,
      });
      continue;
    }

    if (accepted.includes(slug)) {
      rejections.push({
        code: 'duplicate-model',
        slug,
        message: `“${slug}” was listed more than once; the repeat was dropped.`,
      });
      continue;
    }

    if (accepted.length >= MAX_SELECTED_MODELS) {
      rejections.push({
        code: 'over-capacity',
        slug,
        message: `“${slug}” was left out because this view holds at most ${MAX_SELECTED_MODELS} models. Remove one to add it.`,
      });
      continue;
    }

    accepted.push(slug);
  }

  return { slugs: accepted, rejections, isFull: accepted.length >= MAX_SELECTED_MODELS };
}

export function parseEvidenceSelection(search: string, knownSlugs: readonly string[]) {
  return resolveEvidenceSelection(readEvidenceModels(search), knownSlugs);
}

export function toggleModel(current: readonly string[], slug: string): string[] {
  if (current.includes(slug)) return current.filter((entry) => entry !== slug);
  if (current.length >= MAX_SELECTED_MODELS) return [...current];
  return [...current, slug];
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface EvidenceSourceLink {
  id: string;
  title: string;
  url: string;
  publisherName: string;
  lastCheckedDate: string;
  publishedDate: string | null;
}

export interface EvidenceSetupEntry {
  label: string;
  value: string;
  isDisclosed: boolean;
}

export interface EvidenceResultRow {
  resultId: string;
  releaseName: string;
  passportRoute: string;
  scoreLabel: string;
  benchmarkVersion: string;
  variantNote: string;
  evaluationDate: string;
  resultType: BenchmarkResult['resultType'];
  setup: EvidenceSetupEntry[];
  caveats: string;
  hasCaveats: boolean;
  verifiedAt: string;
  sources: EvidenceSourceLink[];
}

export interface EvidenceGroupView {
  key: string;
  benchmarkId: string;
  benchmarkSlug: string;
  benchmarkName: string;
  benchmarkVersion: string;
  domain: BenchmarkDomain;
  domainLabel: string;
  metric: string;
  unit: string;
  verdict: ComparabilityVerdict;
  verdictLabel: string;
  summary: string;
  releaseCount: number;
  /** True once the group holds results from two or more selected releases. */
  isCrossModel: boolean;
  range: ComparabilityRange | null;
  evaluationWindow: EvaluationWindow | null;
  notes: string[];
  policyVersion: string;
  table: ComparabilityTable;
  results: EvidenceResultRow[];
  benchmarkSources: EvidenceSourceLink[];
  /** The `?benchmark=` link that narrows the view to this benchmark. */
  filterHref: string;
}

export interface EvidenceFacet {
  value: string;
  label: string;
  count: number;
  active: boolean;
  href: string;
}

export interface EvidenceModelCard {
  slug: string;
  displayName: string;
  canonicalName: string;
  organizationName: string;
  familyName: string;
  route: string;
  verifiedAt: string;
  resultCount: number;
  removeHref: string;
  removeLabel: string;
}

export interface EvidenceCandidate {
  slug: string;
  displayName: string;
  organizationName: string;
  familyName: string;
  selected: boolean;
  hasEvidence: boolean;
  toggleHref: string;
  toggleLabel: string;
}

export interface EvidenceNextAction {
  label: string;
  href: string | null;
}

export type EvidenceEmptyStateCode =
  | 'no-selection'
  | 'no-evidence'
  | 'no-filter-match';

export interface EvidenceEmptyState {
  code: EvidenceEmptyStateCode;
  heading: string;
  reason: string;
  nextActions: EvidenceNextAction[];
}

export interface EvidenceComparabilityNotice {
  reason: string;
  nextActions: EvidenceNextAction[];
}

export interface BenchmarkExplorerView {
  selection: EvidenceSelection;
  filters: EvidenceFilters;
  models: EvidenceModelCard[];
  candidates: EvidenceCandidate[];
  domainFacets: EvidenceFacet[];
  benchmarkFacets: EvidenceFacet[];
  groups: EvidenceGroupView[];
  comparableGroups: EvidenceGroupView[];
  singleModelGroups: EvidenceGroupView[];
  hasComparableEvidence: boolean;
  totalResultCount: number;
  filteredResultCount: number;
  emptyState: EvidenceEmptyState | null;
  comparabilityNotice: EvidenceComparabilityNotice | null;
  maxSelectedModels: number;
  benchmarksRoute: string;
  clearFiltersHref: string;
  policyVersion: string | null;
}

function modelRoute(base: string, slug: string) {
  return `${normalizeBase(base)}models/${slug}/`;
}

function domainLabel(domain: BenchmarkDomain) {
  return DOMAIN_LABELS[domain] ?? domain;
}

/**
 * Build the whole view for a resolved selection and a pair of filters.
 *
 * The order is deliberate: results are filtered to the selected releases first,
 * comparability groups are computed over that set by the issue-#22 engine, and
 * only then are the domain and benchmark filters applied — so the facets always
 * describe what the selection actually holds, and a filter can narrow the view
 * but never invent a group the data does not support.
 */
export function buildBenchmarkExplorerView(
  dataset: BenchmarkExplorerDataset,
  requestedSlugs: readonly string[],
  filters: EvidenceFilters,
  base: string,
): BenchmarkExplorerView {
  const releaseBySlug = new Map(dataset.releases.map((release) => [release.slug, release]));
  const releaseById = new Map(dataset.releases.map((release) => [release.id, release]));
  const organizationById = new Map(dataset.organizations.map((entry) => [entry.id, entry]));
  const familyById = new Map(dataset.families.map((entry) => [entry.id, entry]));
  const publisherById = new Map(dataset.publishers.map((entry) => [entry.id, entry]));
  const sourceById = new Map(dataset.sources.map((entry) => [entry.id, entry]));
  const benchmarkById = new Map(dataset.benchmarks.map((entry) => [entry.id, entry]));
  const benchmarkBySlug = new Map(dataset.benchmarks.map((entry) => [entry.slug, entry]));

  const knownSlugs = dataset.releases.map((release) => release.slug);
  const selection = resolveEvidenceSelection(requestedSlugs, knownSlugs);

  // Only a benchmark that actually exists may filter; a stale `?benchmark=` slug
  // is treated as no benchmark filter rather than as an empty result set.
  const resolvedFilters: EvidenceFilters = {
    domain: filters.domain,
    benchmark:
      filters.benchmark !== null && benchmarkBySlug.has(filters.benchmark)
        ? filters.benchmark
        : null,
  };

  const linkSources = (ids: readonly string[]): EvidenceSourceLink[] =>
    ids
      .map((id) => sourceById.get(id))
      .filter((source): source is EvidenceSourceRecord => Boolean(source))
      .map((source) => ({
        id: source.id,
        title: source.title,
        url: source.url,
        publisherName: publisherById.get(source.publisherId)?.name ?? source.publisherId,
        lastCheckedDate: source.lastCheckedDate,
        publishedDate: source.publishedDate ?? null,
      }));

  const selectedReleaseIds = new Set<string>();
  for (const slug of selection.slugs) {
    const release = releaseBySlug.get(slug);
    if (release) selectedReleaseIds.add(release.id);
  }

  const selectedResults = dataset.benchmarkResults.filter((result) =>
    selectedReleaseIds.has(result.releaseId),
  );

  const groups: ComparabilityGroup[] = buildComparabilityGroups({
    benchmarks: dataset.benchmarks,
    benchmarkResults: selectedResults,
    releases: dataset.releases as ModelRelease[],
    sources: dataset.sources as SourceReference[],
    publishers: dataset.publishers as Publisher[],
  });

  const toGroupView = (group: ComparabilityGroup): EvidenceGroupView => {
    const benchmark = benchmarkById.get(group.benchmarkId);
    const domain = (benchmark?.domain ?? 'operational') as BenchmarkDomain;
    const distinctReleases = new Set(group.results.map((view) => view.releaseId));
    const slug = benchmark?.slug ?? group.benchmarkId;

    const results: EvidenceResultRow[] = group.results.map((view) => {
      const release = releaseById.get(view.releaseId);
      return {
        resultId: view.result.id,
        releaseName: view.releaseName,
        passportRoute: release ? modelRoute(base, release.slug) : modelRoute(base, view.releaseId),
        scoreLabel: `${view.score} ${view.unit}`,
        benchmarkVersion: view.result.benchmarkVersion,
        variantNote: view.result.variantNote ?? UNDISCLOSED_LABEL,
        evaluationDate: view.evaluationDate,
        resultType: view.result.resultType,
        setup: view.setup.map((entry) => ({
          label: entry.label,
          value: entry.value,
          isDisclosed: entry.isDisclosed,
        })),
        caveats: view.caveats ?? 'None recorded',
        hasCaveats: view.caveats !== null,
        verifiedAt: view.verifiedAt,
        sources: view.sources.map((entry) => ({
          id: entry.source.id,
          title: entry.source.title,
          url: entry.source.url,
          publisherName: entry.publisherName,
          lastCheckedDate: entry.source.lastCheckedDate,
          publishedDate: entry.source.publishedDate ?? null,
        })),
      };
    });

    return {
      key: group.key,
      benchmarkId: group.benchmarkId,
      benchmarkSlug: slug,
      benchmarkName: group.benchmarkName,
      benchmarkVersion: group.benchmarkVersion,
      domain,
      domainLabel: domainLabel(domain),
      metric: group.metric,
      unit: group.unit,
      verdict: group.assessment.verdict,
      verdictLabel: VERDICT_LABELS[group.assessment.verdict],
      summary: group.assessment.summary,
      releaseCount: distinctReleases.size,
      isCrossModel: distinctReleases.size >= MIN_COMPARABLE_MODELS,
      range: group.displayRange,
      evaluationWindow: group.evaluationWindow,
      notes: [
        ...group.assessment.blockingFindings.map((finding) => finding.detail),
        ...group.assessment.warningFindings.map((finding) => finding.detail),
      ],
      policyVersion: group.assessment.policyVersion,
      table: buildGroupTable(group),
      results,
      benchmarkSources: benchmark ? linkSources(benchmark.sourceIds) : [],
      filterHref: evidenceHref(base, selection.slugs, { domain: resolvedFilters.domain, benchmark: slug }),
    };
  };

  const allGroupViews = groups
    .map(toGroupView)
    .sort(
      (a, b) =>
        a.domainLabel.localeCompare(b.domainLabel) ||
        a.benchmarkName.localeCompare(b.benchmarkName) ||
        a.benchmarkVersion.localeCompare(b.benchmarkVersion),
    );

  // Facets describe the whole selection, before the filters narrow it, so a
  // reader can always see every domain and benchmark their models cover.
  const domainCounts = new Map<BenchmarkDomain, number>();
  const benchmarkCounts = new Map<string, { slug: string; name: string; domain: BenchmarkDomain; count: number }>();
  for (const group of allGroupViews) {
    domainCounts.set(group.domain, (domainCounts.get(group.domain) ?? 0) + group.results.length);
    const existing = benchmarkCounts.get(group.benchmarkId);
    if (existing) existing.count += group.results.length;
    else
      benchmarkCounts.set(group.benchmarkId, {
        slug: group.benchmarkSlug,
        name: group.benchmarkName,
        domain: group.domain,
        count: group.results.length,
      });
  }

  const domainFacets: EvidenceFacet[] = [...domainCounts.entries()]
    .map(([domain, count]) => {
      const active = resolvedFilters.domain === domain;
      return {
        value: domain,
        label: domainLabel(domain),
        count,
        active,
        // Toggling a domain clears any benchmark filter, since the chosen
        // benchmark may not belong to the new domain.
        href: evidenceHref(base, selection.slugs, {
          domain: active ? null : domain,
          benchmark: null,
        }),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const benchmarkFacets: EvidenceFacet[] = [...benchmarkCounts.values()]
    // When a domain is chosen, only its benchmarks are offered, so the two
    // filters cannot contradict each other.
    .filter((entry) => resolvedFilters.domain === null || entry.domain === resolvedFilters.domain)
    .map((entry) => {
      const active = resolvedFilters.benchmark === entry.slug;
      return {
        value: entry.slug,
        label: entry.name,
        count: entry.count,
        active,
        href: evidenceHref(base, selection.slugs, {
          domain: resolvedFilters.domain,
          benchmark: active ? null : entry.slug,
        }),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const filteredGroups = allGroupViews.filter((group) => {
    if (resolvedFilters.domain !== null && group.domain !== resolvedFilters.domain) return false;
    if (resolvedFilters.benchmark !== null && group.benchmarkSlug !== resolvedFilters.benchmark)
      return false;
    return true;
  });

  const comparableGroups = filteredGroups.filter((group) => group.isCrossModel);
  const singleModelGroups = filteredGroups.filter((group) => !group.isCrossModel);
  const filteredResultCount = filteredGroups.reduce((sum, group) => sum + group.results.length, 0);

  const models: EvidenceModelCard[] = selection.slugs.map((slug) => {
    const release = releaseBySlug.get(slug)!;
    const resultCount = selectedResults.filter((result) => result.releaseId === release.id).length;
    return {
      slug,
      displayName: release.displayName,
      canonicalName: release.canonicalName,
      organizationName: organizationById.get(release.organizationId)?.name ?? release.organizationId,
      familyName: familyById.get(release.familyId)?.name ?? release.familyId,
      route: modelRoute(base, slug),
      verifiedAt: release.verifiedAt,
      resultCount,
      removeHref: evidenceHref(base, toggleModel(selection.slugs, slug), resolvedFilters),
      removeLabel: `Remove ${release.displayName} from the evidence view`,
    };
  });

  const candidates: EvidenceCandidate[] = dataset.releases.map((release) => {
    const selected = selection.slugs.includes(release.slug);
    const hasEvidence = dataset.benchmarkResults.some((result) => result.releaseId === release.id);
    return {
      slug: release.slug,
      displayName: release.displayName,
      organizationName: organizationById.get(release.organizationId)?.name ?? release.organizationId,
      familyName: familyById.get(release.familyId)?.name ?? release.familyId,
      selected,
      hasEvidence,
      toggleHref: evidenceHref(base, toggleModel(selection.slugs, release.slug), resolvedFilters),
      toggleLabel: selected
        ? `Remove ${release.displayName} from the evidence view`
        : `Add ${release.displayName} to the evidence view`,
    };
  });

  const clearFiltersHref = evidenceHref(base, selection.slugs, NO_FILTERS);
  const route = benchmarksRoute(base);
  const catalogAction: EvidenceNextAction = { label: 'Browse the model catalogue', href: `${normalizeBase(base)}models/` };

  const emptyState = buildEmptyState({
    selection,
    totalResultCount: selectedResults.length,
    filteredResultCount,
    filteredGroupCount: filteredGroups.length,
    filtersActive: resolvedFilters.domain !== null || resolvedFilters.benchmark !== null,
    models,
    clearFiltersHref,
    catalogAction,
  });

  const comparabilityNotice = buildComparabilityNotice({
    selection,
    totalResultCount: selectedResults.length,
    comparableGroupCount: comparableGroups.length,
    filteredGroups,
    base,
    catalogAction,
  });

  return {
    selection,
    filters: resolvedFilters,
    models,
    candidates,
    domainFacets,
    benchmarkFacets,
    groups: filteredGroups,
    comparableGroups,
    singleModelGroups,
    hasComparableEvidence: comparableGroups.length > 0,
    totalResultCount: selectedResults.length,
    filteredResultCount,
    emptyState,
    comparabilityNotice,
    maxSelectedModels: MAX_SELECTED_MODELS,
    benchmarksRoute: route,
    clearFiltersHref,
    policyVersion: allGroupViews[0]?.policyVersion ?? null,
  };
}

function buildEmptyState(input: {
  selection: EvidenceSelection;
  totalResultCount: number;
  filteredResultCount: number;
  filteredGroupCount: number;
  filtersActive: boolean;
  models: EvidenceModelCard[];
  clearFiltersHref: string;
  catalogAction: EvidenceNextAction;
}): EvidenceEmptyState | null {
  if (input.filteredGroupCount > 0) return null;

  if (input.selection.slugs.length === 0) {
    return {
      code: 'no-selection',
      heading: 'Choose a model to see its evidence',
      reason:
        'This view reads the models to explain from the page address. Pick one or more releases and it will show what each was measured on, with every source and date.',
      nextActions: [input.catalogAction],
    };
  }

  if (input.totalResultCount === 0) {
    const names = input.models.map((model) => model.displayName).join(', ');
    return {
      code: 'no-evidence',
      heading: 'No benchmark evidence recorded yet',
      reason: `ModelTree holds no benchmark results for ${names}. That is a gap in coverage, not a score of zero — each model's own passport still records everything that is known about it.`,
      nextActions: [
        ...input.models.map((model) => ({ label: `Open ${model.displayName}'s passport`, href: model.route })),
        input.catalogAction,
      ],
    };
  }

  // Results exist for the selection, but the active filters match none of them.
  return {
    code: 'no-filter-match',
    heading: 'No evidence matches these filters',
    reason:
      'The selected models do carry benchmark evidence, but none of it falls under the domain or benchmark you filtered to.',
    nextActions: [{ label: 'Clear the filters', href: input.clearFiltersHref }],
  };
}

function buildComparabilityNotice(input: {
  selection: EvidenceSelection;
  totalResultCount: number;
  comparableGroupCount: number;
  filteredGroups: EvidenceGroupView[];
  base: string;
  catalogAction: EvidenceNextAction;
}): EvidenceComparabilityNotice | null {
  // The notice only makes sense once a reader has asked for a comparison — two
  // or more models — and there is evidence to show but none of it lines up.
  if (input.selection.slugs.length < MIN_COMPARABLE_MODELS) return null;
  if (input.totalResultCount === 0) return null;
  if (input.comparableGroupCount > 0) return null;
  if (input.filteredGroups.length === 0) return null;

  // Distinguish "no benchmark in common" from "same benchmark, incompatible
  // setup", reading only the groups actually shown. A benchmark whose shown
  // groups cover two or more of the selected models yet yields no cross-model
  // group has split on a blocking setup difference such as a different harness.
  const byBenchmark = new Map<string, { name: string; releases: Set<string>; anyCrossModel: boolean }>();
  for (const group of input.filteredGroups) {
    const entry = byBenchmark.get(group.benchmarkId) ?? {
      name: group.benchmarkName,
      releases: new Set<string>(),
      anyCrossModel: false,
    };
    for (const result of group.results) entry.releases.add(result.passportRoute);
    entry.anyCrossModel = entry.anyCrossModel || group.isCrossModel;
    byBenchmark.set(group.benchmarkId, entry);
  }

  const sharedButSplit = [...byBenchmark.values()].filter(
    (entry) => entry.releases.size >= MIN_COMPARABLE_MODELS && !entry.anyCrossModel,
  );

  const nextActions: EvidenceNextAction[] = [
    { label: 'Compare these models side by side', href: compareUrl(input.base, input.selection.slugs) },
    input.catalogAction,
  ];

  if (sharedButSplit.length > 0) {
    const names = sharedButSplit.map((entry) => entry.name).join(', ');
    return {
      reason: `These models were measured on ${names}, but under evaluation setups that cannot be read against each other — a different harness, variant, or configuration puts each result in its own group. Each model's direct evidence is shown below; the comparability notes on every table say exactly what differs.`,
      nextActions,
    };
  }

  return {
    reason:
      'The selected models share no benchmark, so there is nothing to place on a common scale. Each model\'s direct evidence is shown below. To draw a comparison, pick models that were measured on the same benchmark.',
    nextActions,
  };
}
