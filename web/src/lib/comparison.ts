/**
 * The two-to-four-model comparison's build-time view model (issue #24).
 *
 * A comparison table is the most persuasive layout this site has: putting two
 * numbers in one row asserts that they answer the same question. Most of this
 * module exists to stop that assertion being made where the records do not
 * support it.
 *
 * Three things shape every decision below.
 *
 * 1. **The shipped dataset is sparse, and sparse is the main path, not an edge
 *    case.** Measured at merge-base `fc418bb6` over `web/src/data`: 49 releases,
 *    of which 44 state a context window, 26 a maximum output, 16 a licence, and
 *    15 a parameter count; `derivedFromIds` is non-empty on 0 of 49. `raw.ts`
 *    composes no pricing, deployment, or serving-platform JSON at all, so those
 *    three entity types reach a page only through Zod `.default([])`. Benchmark
 *    results exist but cover 2 of 49 releases. So for almost every pair a reader
 *    can pick, most of this table is absence — and rendering absence as a blank
 *    cell would read as a rendering fault rather than as a fact about coverage.
 *
 * 2. **Absence has kinds, and collapsing them is the failure this issue names.**
 *    {@link ValueState} splits it four ways and each kind is decided by a rule a
 *    test can check, never by a judgement call. The states are defined on the
 *    page itself in {@link VALUE_STATE_DEFINITIONS} rather than only here,
 *    because a distinction a reader cannot see is a distinction the page does
 *    not actually make.
 *
 * 3. **No overall winner, ever.** Columns are ordered by the reader's own
 *    selection, never by any score — that is structural, not a convention: this
 *    module never sorts models, so there is no code path that could emit a
 *    leaderboard. Benchmark ordering stays inside `comparability.ts`, whose own
 *    contract is that it never ranks across groups. Takeaways are gated on
 *    {@link ComparisonRow.fullyStated}, so a rule cannot fire off an attribute
 *    any selected model leaves unstated.
 *
 * Nothing here invents a value. Where a field is unstated it stays unstated,
 * and a similarly named release is never read to fill it.
 */
import type {
  BenchmarkResult,
  Dataset,
  Deployment,
  ModelRelease,
  PricingRecord,
  SourceReference,
} from '../data/schema';
import {
  UNDISCLOSED_LABEL,
  buildComparison,
  evaluationWindow,
  type ComparabilityVerdict,
  type EvaluationWindow,
} from './comparability';
import {
  defaultComparabilityPolicy,
  resolveEvaluationSpreadMonths,
} from './comparability-policy';
import { modelRoute } from './catalog';
import { accessLabel, categoryLabel, formatDate, formatNumber, statusLabel } from './format';
import {
  deliveryModeLabel,
  formatDateWithPrecision,
  formatEffectiveRange,
  formatRate,
  platformTypeLabel,
  pricingUnitLabel,
} from './passport';

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * One query parameter holding an ordered, comma-separated slug list.
 *
 * Repeated `?model=a&model=b` parameters were the alternative and are rejected
 * for a specific reason: `URLSearchParams` preserves their order but a reader
 * editing the address bar cannot see the ordering rule, and every consumer that
 * re-serialises has to remember to emit them in the same sequence. A single
 * ordered list makes selection order visible in the URL, which is what
 * "selection order and copied URL restore deterministically" has to mean.
 */
export const COMPARE_QUERY_PARAMETER = 'models';

export const MIN_COMPARISON_MODELS = 2;
export const MAX_COMPARISON_MODELS = 4;

export type SelectionRejectionCode = 'unknown-model' | 'duplicate-model' | 'over-capacity';

/**
 * A slug the page was asked to compare and did not.
 *
 * Every rejection names the slug it is about. That is an accessibility
 * requirement rather than a nicety: the message is announced from a live region
 * with no surrounding visual context, so "one model was rejected" tells a screen
 * reader user nothing they can act on.
 */
export interface SelectionRejection {
  code: SelectionRejectionCode;
  slug: string;
  message: string;
}

export interface ComparisonSelection {
  /** Accepted slugs, in the order the URL gave them. */
  slugs: string[];
  rejections: SelectionRejection[];
  /** True once at least {@link MIN_COMPARISON_MODELS} models are selected. */
  isComparable: boolean;
  /** How many more models are needed before a comparison can be drawn. */
  shortfall: number;
  isFull: boolean;
}

function selectionOf(slugs: string[], rejections: SelectionRejection[]): ComparisonSelection {
  return {
    slugs,
    rejections,
    isComparable: slugs.length >= MIN_COMPARISON_MODELS,
    shortfall: Math.max(0, MIN_COMPARISON_MODELS - slugs.length),
    isFull: slugs.length >= MAX_COMPARISON_MODELS,
  };
}

/**
 * Resolve a raw slug list against the releases that actually exist.
 *
 * The order of the three checks is load-bearing. An unknown slug is reported as
 * unknown even when it is also repeated, because "no such model" is the problem
 * the reader can act on; and the capacity check runs last so a list of five
 * slugs where two are typos still compares the three real ones rather than
 * spending capacity on entries that were never going to render.
 */
export function resolveComparisonSelection(
  requested: readonly string[],
  knownSlugs: readonly string[],
): ComparisonSelection {
  const known = new Set(knownSlugs);
  const accepted: string[] = [];
  const rejections: SelectionRejection[] = [];

  for (const raw of requested) {
    const slug = raw.trim();
    if (slug === '') continue;

    if (!known.has(slug)) {
      rejections.push({
        code: 'unknown-model',
        slug,
        message: `“${slug}” is not a model release in ModelTree, so it was left out of the comparison.`,
      });
      continue;
    }

    if (accepted.includes(slug)) {
      rejections.push({
        code: 'duplicate-model',
        slug,
        message: `“${slug}” was listed more than once. A model is compared against itself in no useful way, so the repeat was dropped.`,
      });
      continue;
    }

    if (accepted.length >= MAX_COMPARISON_MODELS) {
      rejections.push({
        code: 'over-capacity',
        slug,
        message: `“${slug}” was left out because a comparison holds at most ${MAX_COMPARISON_MODELS} models. Remove one to add it.`,
      });
      continue;
    }

    accepted.push(slug);
  }

  return selectionOf(accepted, rejections);
}

/** Split the query parameter's ordered list, tolerating stray whitespace. */
export function readComparisonSlugs(search: string): string[] {
  const raw = new URLSearchParams(search).get(COMPARE_QUERY_PARAMETER);
  if (raw === null) return [];
  return raw.split(',');
}

export function parseComparisonSelection(search: string, knownSlugs: readonly string[]) {
  return resolveComparisonSelection(readComparisonSlugs(search), knownSlugs);
}

/**
 * The query string for a selection. Empty for an empty selection, so a cleared
 * comparison yields a bare `/compare/` rather than a trailing `?models=`.
 */
export function serializeComparisonSelection(slugs: readonly string[]) {
  if (slugs.length === 0) return '';
  const params = new URLSearchParams();
  params.set(COMPARE_QUERY_PARAMETER, slugs.join(','));
  return `?${params.toString()}`;
}

function normalizeBase(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

export function compareRoute(base: string) {
  return `${normalizeBase(base)}compare/`;
}

export function compareUrl(base: string, slugs: readonly string[]) {
  return `${compareRoute(base)}${serializeComparisonSelection(slugs)}`;
}

/**
 * Add one model to the end of a selection, so the column order a reader builds
 * up is the order they chose. Returns the rejection instead of the slug when
 * the addition cannot stand, rather than silently doing nothing.
 */
export function addToComparison(
  current: readonly string[],
  slug: string,
): { slugs: string[]; rejection: SelectionRejection | null } {
  if (current.includes(slug)) {
    return {
      slugs: [...current],
      rejection: {
        code: 'duplicate-model',
        slug,
        message: `“${slug}” is already in the comparison.`,
      },
    };
  }

  if (current.length >= MAX_COMPARISON_MODELS) {
    return {
      slugs: [...current],
      rejection: {
        code: 'over-capacity',
        slug,
        message: `“${slug}” was not added because a comparison holds at most ${MAX_COMPARISON_MODELS} models. Remove one to add it.`,
      },
    };
  }

  return { slugs: [...current, slug], rejection: null };
}

export function removeFromComparison(current: readonly string[], slug: string) {
  return current.filter((candidate) => candidate !== slug);
}

// ---------------------------------------------------------------------------
// Value states
// ---------------------------------------------------------------------------

/**
 * The four ways a cell can fail to state a value, plus the one where it does.
 *
 * Each maps to one of the four the issue names, and each is decided by a rule
 * rather than by judgement:
 *
 * - `unrecorded` (**unknown**) — the release record exists and does not state
 *   this field. ModelTree cannot tell "the creator never published it" from
 *   "nobody has reviewed it yet", and the definition below says so rather than
 *   implying the stronger of the two.
 * - `not-collected` (**missing**) — the whole entity type that would carry this
 *   fact holds no records at all. That is a fact about ModelTree's coverage, not
 *   about any model in the comparison, and it is the state real data reaches for
 *   pricing and availability.
 * - `not-applicable` (**unavailable**) — the attribute cannot apply to this
 *   release, so there is nothing to record. Licence terms for a release holding
 *   no licence record are the case that occurs.
 * - `not-comparable` (**non-comparable**) — a value exists for every model and
 *   they still cannot share a row, because the records disagree on something
 *   that changes what the number means. Decided by `comparability.ts` for
 *   benchmarks and by currency for prices; never asserted here by hand.
 */
export type ValueState =
  | 'stated'
  | 'unrecorded'
  | 'not-collected'
  | 'not-applicable'
  | 'not-comparable';

export const VALUE_STATE_ORDER: readonly ValueState[] = [
  'stated',
  'unrecorded',
  'not-collected',
  'not-applicable',
  'not-comparable',
];

export const VALUE_STATE_LABELS: Record<ValueState, string> = {
  stated: 'Recorded',
  unrecorded: 'Not recorded',
  'not-collected': 'Not collected',
  'not-applicable': 'Not applicable',
  'not-comparable': 'Not comparable',
};

/**
 * Rendered as a legend on the page. A reader who cannot tell "we have not looked"
 * from "the creator has not said" is reading the same table as one who can, and
 * the difference between the two is the whole point of this issue.
 */
export const VALUE_STATE_DEFINITIONS: Record<ValueState, string> = {
  stated: 'A reviewed primary source states this value. The date it was last checked and the source it came from are shown with it.',
  unrecorded: 'The release record holds no value for this field. ModelTree does not distinguish a creator that never published it from a fact nobody has reviewed yet, so this is not a claim that the value does not exist.',
  'not-collected': 'ModelTree holds no records of this kind for any model yet, so there is nothing to compare. This describes ModelTree\u2019s coverage, not the models.',
  'not-applicable': 'The attribute cannot apply to this release, so no record is expected. This is not a gap.',
  'not-comparable': 'Every model states a value and they still cannot be read against each other, because the records disagree on something that changes what the value means. The reason is given with the row.',
};

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

export interface ComparisonSourceView {
  id: string;
  title: string;
  url: string;
  publisherName: string;
  lastCheckedDate: string;
}

export interface ComparisonCell {
  slug: string;
  state: ValueState;
  /** Always printable. Never an empty string, so a cell cannot read as a gap. */
  value: string;
  /** Why this cell is not `stated`. Null only when it is. */
  reason: string | null;
  /**
   * When the underlying record was last checked, and the range it applies to.
   * Both are non-null for every `stated` cell — that invariant is what the
   * issue's "every volatile value exposes effective or verification date and
   * source" requirement reduces to, and it is asserted over all rows at once.
   */
  verifiedAt: string | null;
  effectiveRange: string | null;
  sources: ComparisonSourceView[];
  /**
   * The evaluation setup a benchmark cell was produced under, including the
   * dimensions its source left undisclosed. Null on every non-benchmark cell.
   * Carried on the cell rather than the row because two results in one row can
   * disclose different amounts, and that difference is the reason a row may not
   * be comparable.
   */
  setup: string | null;
}

export interface ComparisonEvidence {
  benchmarkId: string;
  benchmarkName: string;
  verdict: ComparabilityVerdict;
  policyVersion: string;
  summary: string;
  /** Each finding's own sentence, blocking first, exactly as the policy wrote it. */
  notes: string[];
  /** The benchmark's own declared direction, never ModelTree's opinion. */
  directionNote: string;
  evaluationWindow: EvaluationWindow | null;
}

export interface ComparisonRow {
  id: string;
  label: string;
  /** What the row asserts, stated once instead of repeated in every cell. */
  note: string | null;
  /** True where the fact can change without the model changing. */
  volatile: boolean;
  cells: ComparisonCell[];
  hasStatedValue: boolean;
  /** Every cell states a value. The precondition every takeaway rule is gated on. */
  fullyStated: boolean;
  /** The stated cells do not all agree. A difference, never a ranking. */
  differs: boolean;
  evidence: ComparisonEvidence | null;
}

export type ComparisonGroupId =
  | 'identity'
  | 'lifecycle'
  | 'positioning'
  | 'modalities'
  | 'limits'
  | 'access'
  | 'availability'
  | 'pricing'
  | 'evidence';

export const COMPARISON_GROUP_ORDER: readonly ComparisonGroupId[] = [
  'identity',
  'lifecycle',
  'positioning',
  'modalities',
  'limits',
  'access',
  'availability',
  'pricing',
  'evidence',
];

export interface ComparisonGroup {
  id: ComparisonGroupId;
  title: string;
  headingId: string;
  description: string;
  rows: ComparisonRow[];
  /**
   * Set when the group holds no rows at all. A group with an absence renders as
   * a named, explained gap rather than as an empty table, for the same reason
   * the Model Passport lists what it does not record: a silently dropped section
   * and a section nothing is known about look identical otherwise.
   */
  absence: { state: ValueState; reason: string } | null;
}

export interface ComparisonModelColumn {
  slug: string;
  displayName: string;
  canonicalName: string;
  organizationName: string;
  familyName: string;
  route: string;
  /** The release record's own verification date, stamped above its column. */
  verifiedAt: string;
  sources: ComparisonSourceView[];
  /** The comparison with this model taken out, so removal is a plain link. */
  removeUrl: string;
  removeLabel: string;
}

export interface ComparisonCandidate {
  slug: string;
  displayName: string;
  organizationName: string;
  familyName: string;
  selected: boolean;
  /** The comparison with this model added or removed, whichever applies. */
  toggleUrl: string;
  toggleLabel: string;
}

export type TakeawayRuleId =
  | 'self-hosting'
  | 'input-modalities'
  | 'context-window'
  | 'lifecycle-status'
  | 'benchmark-not-comparable';

export interface ComparisonTakeaway {
  rule: TakeawayRuleId;
  headline: string;
  detail: string;
  /** The row the rule read, so a reader can check the claim against the table. */
  basisRowId: string;
  sources: ComparisonSourceView[];
}

export interface ComparisonView {
  selection: ComparisonSelection;
  models: ComparisonModelColumn[];
  groups: ComparisonGroup[];
  /** Only the groups holding at least one row. */
  presentGroups: ComparisonGroup[];
  /** Only the groups holding none, each with its reason. */
  absentGroups: ComparisonGroup[];
  takeaways: ComparisonTakeaway[];
  noRankingNote: string;
  valueStateLegend: Array<{ state: ValueState; label: string; definition: string }>;
  /** Every state actually used by a cell in this comparison. */
  usedStates: ValueState[];
}

export class ComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComparisonError';
  }
}

/**
 * Printed under the takeaways, and the reason it is a constant rather than
 * prose in a component: the non-goal it states is a repository policy, so it
 * must be assertable by a test rather than editable in markup.
 */
export const NO_RANKING_NOTE =
  'ModelTree publishes no overall winner, no composite score, and no ranking across attributes. '
  + 'Every observation below is scoped to one attribute, names the records it was read from, and is '
  + 'withheld unless every model in this comparison states that attribute.';

export type ComparisonDataset = Pick<
  Dataset,
  | 'sources'
  | 'publishers'
  | 'organizations'
  | 'families'
  | 'releases'
  | 'servingPlatforms'
  | 'deployments'
  | 'pricing'
  | 'benchmarks'
  | 'benchmarkResults'
>;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const GROUP_DEFINITIONS: Record<ComparisonGroupId, { title: string; description: string }> = {
  identity: {
    title: 'Identity and position',
    description: 'Which creator and family each release belongs to, and the exact record being compared. Creator, family, product, and serving platform are separate entities here, so a release is never described by the product it happens to power.',
  },
  lifecycle: {
    title: 'Dates and status',
    description: 'When each release was published, how far its source dated it, and where it sits in its own lifecycle.',
  },
  positioning: {
    title: 'Intended use',
    description: 'What each creator says the release is for. This is the creator\u2019s own positioning, quoted from its record, not ModelTree\u2019s assessment of fit.',
  },
  modalities: {
    title: 'Modalities',
    description: 'What each release documents itself as accepting and producing. A difference here usually means the two are not alternatives for the same job.',
  },
  limits: {
    title: 'Documented limits',
    description: 'Figures the creator published. An unrecorded limit is not a small one.',
  },
  access: {
    title: 'Access and licensing',
    description: 'How each release can be obtained, and on what terms. Downloadable weights and OSI-approved licensing are separate claims and neither implies the other.',
  },
  availability: {
    title: 'Availability',
    description: 'Which platforms are recorded as serving each release, with the date each record takes effect.',
  },
  pricing: {
    title: 'Pricing',
    description: 'Published prices, held against one platform in the currency and unit the vendor published. Prices are never converted between currencies or normalised between units, because a converted price is a figure no source states.',
  },
  evidence: {
    title: 'Comparable evidence',
    description: 'Benchmark results, passed through the comparability transformation before they are placed in one row. A row that cannot clear it is marked rather than dropped.',
  },
};

const AVAILABILITY_NOT_COLLECTED =
  'ModelTree holds no deployment records for any release yet, so there is nothing to compare. '
  + 'A deployment ties a release to a named serving platform with its own source and effective date, '
  + 'and none has been reviewed. Absence is not a claim that these models are unavailable.';

const PRICING_NOT_COLLECTED =
  'ModelTree holds no pricing records for any release yet, so there is nothing to compare. '
  + 'A price is held only against a reviewed deployment on a named platform, with its currency, unit, '
  + 'and effective date. Absence is not a claim that these models are free or unpriced.';

const EVIDENCE_NONE =
  'No reviewed benchmark result covers any of these releases, so no evidence row can be drawn. '
  + 'ModelTree records a benchmark result only with the setup its source disclosed, and none has been '
  + 'reviewed for these models.';

function stated(
  slug: string,
  value: string,
  verifiedAt: string,
  sources: ComparisonSourceView[],
  effectiveRange: string | null = null,
): ComparisonCell {
  return { slug, state: 'stated', value, reason: null, verifiedAt, effectiveRange, sources, setup: null };
}

function absent(
  slug: string,
  state: Exclude<ValueState, 'stated'>,
  reason: string,
): ComparisonCell {
  return {
    slug,
    state,
    value: VALUE_STATE_LABELS[state],
    reason,
    verifiedAt: null,
    effectiveRange: null,
    sources: [],
    setup: null,
  };
}

function rowOf(
  id: string,
  label: string,
  cells: ComparisonCell[],
  options: { note?: string; volatile?: boolean; evidence?: ComparisonEvidence } = {},
): ComparisonRow {
  const statedCells = cells.filter((cell) => cell.state === 'stated');
  const distinct = new Set(statedCells.map((cell) => cell.value));

  return {
    id,
    label,
    note: options.note ?? null,
    volatile: options.volatile ?? false,
    cells,
    hasStatedValue: statedCells.length > 0,
    fullyStated: statedCells.length === cells.length && cells.length > 0,
    differs: distinct.size > 1,
    evidence: options.evidence ?? null,
  };
}

/** Sentence-case list, so a two-item and a four-item row read the same way. */
function listOf(names: readonly string[]) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function buildModelComparison(
  dataset: ComparisonDataset,
  slugs: readonly string[],
  base: string,
  today: string,
): ComparisonView {
  const selection = resolveComparisonSelection(
    slugs,
    dataset.releases.map((release) => release.slug),
  );

  const releaseBySlug = new Map(dataset.releases.map((release) => [release.slug, release]));
  const releases = selection.slugs.map((slug) => {
    const release = releaseBySlug.get(slug);
    // Unreachable through `resolveComparisonSelection`, which only accepts slugs
    // it found in this same list. Thrown rather than filtered so a future caller
    // that bypasses the resolver fails loudly instead of comparing four models
    // and rendering three.
    if (!release) throw new ComparisonError(`selection accepted unknown release slug "${slug}"`);
    return release;
  });

  const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));
  const publisherById = new Map(dataset.publishers.map((item) => [item.id, item]));
  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));
  const familyById = new Map(dataset.families.map((item) => [item.id, item]));
  const platformById = new Map(dataset.servingPlatforms.map((item) => [item.id, item]));

  const toSourceView = (source: SourceReference): ComparisonSourceView => ({
    id: source.id,
    title: source.title,
    url: source.url,
    publisherName: publisherById.get(source.publisherId)?.name ?? source.publisherId,
    lastCheckedDate: source.lastCheckedDate,
  });

  const resolveSources = (sourceIds: readonly string[]) => sourceIds
    .map((id) => sourceById.get(id))
    .filter((source): source is SourceReference => Boolean(source))
    .map(toSourceView);

  const sourcesOf = new Map(
    releases.map((release) => [release.slug, resolveSources(release.sourceIds)]),
  );
  const releaseSources = (release: ModelRelease) => sourcesOf.get(release.slug) ?? [];

  const models: ComparisonModelColumn[] = releases.map((release) => {
    const organization = organizationById.get(release.organizationId);
    const family = familyById.get(release.familyId);
    if (!organization) {
      throw new ComparisonError(`release "${release.id}" names missing organization "${release.organizationId}"`);
    }
    if (!family) {
      throw new ComparisonError(`release "${release.id}" names missing family "${release.familyId}"`);
    }

    return {
      slug: release.slug,
      displayName: release.displayName,
      canonicalName: release.canonicalName,
      organizationName: organization.name,
      familyName: family.name,
      route: modelRoute(base, release.slug),
      verifiedAt: formatDate(release.verifiedAt),
      sources: releaseSources(release),
      removeUrl: compareUrl(base, removeFromComparison(selection.slugs, release.slug)),
      removeLabel: `Remove ${release.displayName} from the comparison`,
    };
  });

  // -------------------------------------------------------------------------
  // Release-derived rows. `read` returns the printable value or null; null is
  // always `unrecorded`, because the release record exists and simply does not
  // state it. A field whose absence means something else does not go through
  // this helper.
  // -------------------------------------------------------------------------

  const releaseRow = (
    id: string,
    label: string,
    read: (release: ModelRelease) => string | null,
    options: { note?: string; volatile?: boolean; unrecordedReason?: string } = {},
  ) => rowOf(
    id,
    label,
    releases.map((release) => {
      const value = read(release);
      return value === null || value === ''
        ? absent(
          release.slug,
          'unrecorded',
          options.unrecordedReason
            ?? `The ${release.displayName} record states no ${label.toLowerCase()}.`,
        )
        : stated(release.slug, value, formatDate(release.verifiedAt), releaseSources(release));
    }),
    { note: options.note, volatile: options.volatile },
  );

  const identityRows: ComparisonRow[] = [
    releaseRow('creator', 'Creator', (release) => organizationById.get(release.organizationId)?.name ?? null),
    releaseRow('family', 'Family', (release) => familyById.get(release.familyId)?.name ?? null),
    releaseRow('canonical-name', 'Canonical name', (release) => release.canonicalName),
    releaseRow('version', 'Version', (release) => release.version),
    releaseRow('variant', 'Variant', (release) => release.variant),
    releaseRow(
      'api-aliases',
      'API identifiers',
      (release) => (release.apiAliases.length ? release.apiAliases.join(', ') : null),
      {
        note: 'The strings each API accepts for this exact release. Two releases sharing an identifier would be one record, not two.',
        unrecordedReason: 'No API identifier is recorded for this release.',
      },
    ),
  ];

  const lifecycleRows: ComparisonRow[] = [
    releaseRow(
      'released',
      'Released',
      (release) => formatDateWithPrecision(release.releaseDate, release.datePrecision),
      { note: 'Shown only as precisely as the source stated it. A year-precision record is not a January release.' },
    ),
    releaseRow('status', 'Lifecycle status', (release) => statusLabel(release.status)),
    releaseRow(
      'verified',
      'Record last checked',
      (release) => formatDate(release.verifiedAt),
      {
        volatile: true,
        note: 'When ModelTree last re-read the primary sources for this release.',
      },
    ),
  ];

  const positioningRows: ComparisonRow[] = [
    releaseRow('intended-use', 'Intended use', (release) => release.intendedUse, {
      note: 'The creator\u2019s own statement of what the release is for, not an assessment of how well it does it.',
    }),
    releaseRow(
      'categories',
      'Categories',
      (release) => release.categories.map((category) => categoryLabel(category)).join(', '),
    ),
    releaseRow(
      'featured-rationale',
      'Why ModelTree features it',
      (release) => release.featuredRationale ?? null,
      {
        unrecordedReason: 'This release is not featured, so no rationale is recorded. That is not a judgement about the model.',
      },
    ),
  ];

  const modalityRows: ComparisonRow[] = [
    releaseRow('input-modalities', 'Input modalities', (release) => release.inputModalities.join(', ')),
    releaseRow('output-modalities', 'Output modalities', (release) => release.outputModalities.join(', ')),
  ];

  const limitRows: ComparisonRow[] = [
    releaseRow(
      'context-window',
      'Context window',
      (release) => (release.contextWindow ? `${formatNumber(release.contextWindow)} tokens` : null),
      { unrecordedReason: 'No context window is recorded for this release.' },
    ),
    releaseRow(
      'maximum-output',
      'Maximum output',
      (release) => (release.maximumOutput ? `${formatNumber(release.maximumOutput)} tokens` : null),
      { unrecordedReason: 'No maximum output is recorded for this release.' },
    ),
    releaseRow(
      'parameters',
      'Parameters',
      (release) => {
        const total = release.parameters?.totalBillions;
        const active = release.parameters?.activeBillions;
        if (total === undefined && active === undefined) return null;
        if (total !== undefined && active !== undefined) {
          return `${formatNumber(total)}B total, ${formatNumber(active)}B active`;
        }
        return total !== undefined ? `${formatNumber(total)}B total` : `${formatNumber(active!)}B active`;
      },
      {
        note: 'Total and active parameter counts are different quantities and are never mixed into one figure.',
        unrecordedReason: 'No parameter count is recorded for this release. Most creators of hosted models publish none.',
      },
    ),
  ];

  // Licence rows are the one place `not-applicable` is reachable: the schema
  // requires a licence record only where a release claims downloadable weights,
  // so its absence on a hosted-only release is not a gap in the record.
  const licenceRow = (
    id: string,
    label: string,
    read: (license: NonNullable<ModelRelease['license']>) => string | null,
    unrecordedReason: string,
  ) => rowOf(
    id,
    label,
    releases.map((release) => {
      const license = release.license;
      if (!license) {
        return absent(
          release.slug,
          'not-applicable',
          `${release.displayName} holds no licence record. The schema requires one only where a release claims downloadable weights, so its absence is not a claim that the model is unlicensed.`,
        );
      }
      const value = read(license);
      return value === null
        ? absent(release.slug, 'unrecorded', unrecordedReason)
        : stated(release.slug, value, formatDate(release.verifiedAt), releaseSources(release));
    }),
  );

  const accessRows: ComparisonRow[] = [
    releaseRow('access-type', 'Access', (release) => accessLabel(release.accessType)),
    licenceRow('licence', 'Licence', (license) => license.name, 'No licence name is recorded.'),
    licenceRow('licence-spdx', 'SPDX identifier', (license) => license.spdxId ?? null, 'No SPDX identifier is recorded for this licence.'),
    licenceRow(
      'weights-downloadable',
      'Downloadable weights',
      (license) => (license.weightsDownloadable ? 'Documented as downloadable' : 'Not documented as downloadable'),
      'No weight availability is recorded.',
    ),
    licenceRow(
      'osi-approved',
      'OSI-approved licence',
      (license) => (license.osiApproved ? 'Recorded as OSI-approved' : 'Not recorded as OSI-approved'),
      'No OSI status is recorded.',
    ),
  ];

  // -------------------------------------------------------------------------
  // Availability. One row per platform any selected release is served on, so a
  // platform serving only one of them shows the others as unrecorded rather
  // than vanishing — which platform is missing is itself the comparison.
  // -------------------------------------------------------------------------

  const deploymentsBySlug = new Map<string, Deployment[]>(
    releases.map((release) => [
      release.slug,
      dataset.deployments.filter((deployment) => deployment.releaseId === release.id),
    ]),
  );

  const platformIds = [...new Set(
    releases.flatMap((release) => (deploymentsBySlug.get(release.slug) ?? [])
      .map((deployment) => deployment.platformId)),
  )].sort();

  const availabilityRows: ComparisonRow[] = platformIds.map((platformId) => {
    const platform = platformById.get(platformId);
    const platformName = platform?.name ?? platformId;
    const operator = platform ? organizationById.get(platform.organizationId)?.name : undefined;

    return rowOf(
      `availability-${platformId}`,
      platformName,
      releases.map((release) => {
        const deployment = (deploymentsBySlug.get(release.slug) ?? [])
          .filter((candidate) => candidate.platformId === platformId)
          .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];

        if (!deployment) {
          return absent(
            release.slug,
            'unrecorded',
            `No reviewed deployment records ${release.displayName} on ${platformName}. Absence is not a claim that it is unavailable there.`,
          );
        }

        const current = deployment.effectiveTo === undefined || deployment.effectiveTo >= today;
        const regions = deployment.regions.length ? deployment.regions.join(', ') : 'no regions recorded';

        return stated(
          release.slug,
          `${deliveryModeLabel(deployment.deliveryMode)}${current ? '' : ' (superseded)'} \u00b7 ${regions}`,
          formatDate(deployment.verifiedAt),
          resolveSources(deployment.sourceIds),
          formatEffectiveRange(deployment.effectiveFrom, deployment.effectiveTo),
        );
      }),
      {
        volatile: true,
        note: platform
          ? `${platformTypeLabel(platform.type)}${operator ? `, operated by ${operator}` : ''}.`
          : undefined,
      },
    );
  });

  // -------------------------------------------------------------------------
  // Pricing. Rows are keyed by platform, unit, and rate, because those three
  // decide whether two amounts answer the same question. Currency is checked
  // across the row afterwards: two prices in different currencies are the
  // `not-comparable` case, and converting them would publish a figure no source
  // states.
  // -------------------------------------------------------------------------

  const pricingFor = (release: ModelRelease): PricingRecord[] => {
    const deploymentIds = new Set((deploymentsBySlug.get(release.slug) ?? []).map(({ id }) => id));
    return dataset.pricing.filter((price) => deploymentIds.has(price.deploymentId));
  };

  const pricingBySlug = new Map(releases.map((release) => [release.slug, pricingFor(release)]));
  const deploymentById = new Map(dataset.deployments.map((deployment) => [deployment.id, deployment]));

  const priceKeys = [...new Set(
    releases.flatMap((release) => (pricingBySlug.get(release.slug) ?? []).flatMap((price) => {
      const deployment = deploymentById.get(price.deploymentId);
      const platformId = deployment?.platformId ?? 'unknown-platform';
      return (Object.keys(price.rates) as Array<keyof PricingRecord['rates']>)
        .filter((rate) => price.rates[rate] !== undefined)
        .map((rate) => `${platformId}|${price.unit}|${rate}`);
    })),
  )].sort();

  const RATE_LABELS: Record<keyof PricingRecord['rates'], string> = {
    input: 'Input',
    cachedInput: 'Cached input',
    output: 'Output',
    batchInput: 'Batch input',
    batchOutput: 'Batch output',
  };

  const pricingRows: ComparisonRow[] = priceKeys.map((key) => {
    const [platformId, unit, rateKey] = key.split('|') as [string, PricingRecord['unit'], keyof PricingRecord['rates']];
    const platformName = platformById.get(platformId)?.name ?? platformId;
    const label = `${platformName} \u00b7 ${RATE_LABELS[rateKey]} ${pricingUnitLabel(unit)}`;

    const cells = releases.map((release) => {
      const price = (pricingBySlug.get(release.slug) ?? [])
        .filter((candidate) => deploymentById.get(candidate.deploymentId)?.platformId === platformId)
        .filter((candidate) => candidate.unit === unit && candidate.rates[rateKey] !== undefined)
        .filter((candidate) => candidate.effectiveTo === undefined || candidate.effectiveTo >= today)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];

      if (!price) {
        return absent(
          release.slug,
          'unrecorded',
          `No current ${RATE_LABELS[rateKey].toLowerCase()} price on ${platformName} is recorded for ${release.displayName}.`,
        );
      }

      return stated(
        release.slug,
        formatRate(price.rates[rateKey] as number, price.currency),
        formatDate(price.verifiedAt),
        resolveSources(price.sourceIds),
        formatEffectiveRange(price.effectiveFrom, price.effectiveTo),
      );
    });

    const currencies = new Set(
      releases
        .map((release, index) => ({ release, cell: cells[index]! }))
        .filter(({ cell }) => cell.state === 'stated')
        .map(({ release }) => (pricingBySlug.get(release.slug) ?? [])
          .find((candidate) => deploymentById.get(candidate.deploymentId)?.platformId === platformId
            && candidate.unit === unit
            && candidate.rates[rateKey] !== undefined)?.currency)
        .filter((currency): currency is string => Boolean(currency)),
    );

    // A row whose stated amounts are in different currencies keeps its numbers
    // and loses its comparability, rather than being converted or dropped.
    const mixedCurrency = currencies.size > 1;
    const finalCells = mixedCurrency
      ? cells.map((cell) => (cell.state === 'stated'
        ? {
          ...cell,
          state: 'not-comparable' as const,
          reason: `These amounts are published in different currencies (${[...currencies].sort().join(', ')}). ModelTree does not convert between currencies, because a converted price is a figure no source states.`,
        }
        : cell))
      : cells;

    return rowOf(`pricing-${key.replace(/\|/g, '-')}`, label, finalCells, {
      volatile: true,
      note: mixedCurrency
        ? 'Published in more than one currency, so these amounts do not share a scale.'
        : undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Comparable evidence. Results are grouped by benchmark and handed to
  // `buildComparison`, which is the entry point in `comparability.ts` that can
  // return `not-comparable`. Nothing here decides comparability itself: a
  // second implementation of that rule would be free to disagree with the
  // policy the site documents.
  // -------------------------------------------------------------------------

  const releaseIdBySlug = new Map(releases.map((release) => [release.slug, release.id]));
  const selectedReleaseIds = new Set(releases.map((release) => release.id));
  const relevantResults = dataset.benchmarkResults.filter(
    (result) => selectedReleaseIds.has(result.releaseId),
  );

  const resultsByBenchmark = new Map<string, BenchmarkResult[]>();
  for (const result of relevantResults) {
    const bucket = resultsByBenchmark.get(result.benchmarkId);
    if (bucket) bucket.push(result);
    else resultsByBenchmark.set(result.benchmarkId, [result]);
  }

  const comparabilityContext = {
    benchmarks: dataset.benchmarks,
    releases: dataset.releases,
    sources: dataset.sources,
    publishers: dataset.publishers,
  };

  const evidenceRows: ComparisonRow[] = [...resultsByBenchmark.keys()]
    .sort()
    .map((benchmarkId) => {
      const results = resultsByBenchmark.get(benchmarkId)!;
      const comparison = buildComparison(results, comparabilityContext);
      const definition = dataset.benchmarks.find((entry) => entry.id === benchmarkId);
      const benchmarkName = definition?.name ?? benchmarkId;
      const viewByReleaseId = new Map(comparison.results.map((view) => [view.releaseId, view]));
      const blocked = comparison.assessment.verdict === 'not-comparable';

      const cells = releases.map((release) => {
        const view = viewByReleaseId.get(releaseIdBySlug.get(release.slug)!);
        if (!view) {
          return absent(
            release.slug,
            'unrecorded',
            `No reviewed benchmark result records ${release.displayName} on ${benchmarkName}.`,
          );
        }

        const setup = view.setup
          .map((entry) => `${entry.label}: ${entry.value}`)
          .join('; ') || null;
        const value = `${view.score} ${view.unit}`;

        if (blocked) {
          return {
            slug: release.slug,
            state: 'not-comparable' as const,
            // The number is kept rather than hidden. A reader who can see both
            // figures and the reason they do not share a scale is better served
            // than one shown a blank where a published result exists.
            value,
            reason: comparison.assessment.blockingFindings
              .map((finding) => finding.detail)
              .join(' '),
            verifiedAt: formatDate(view.verifiedAt),
            effectiveRange: `Evaluated ${view.evaluationDate}`,
            sources: view.sources.map((entry) => toSourceView(entry.source)),
            setup,
          };
        }

        return {
          ...stated(
            release.slug,
            value,
            formatDate(view.verifiedAt),
            view.sources.map((entry) => toSourceView(entry.source)),
            `Evaluated ${view.evaluationDate}`,
          ),
          setup,
        };
      });

      const window = evaluationWindow(
        results,
        resolveEvaluationSpreadMonths(defaultComparabilityPolicy, benchmarkId),
      );

      return rowOf(`benchmark-${benchmarkId}`, `${benchmarkName} (${results[0]!.benchmarkVersion})`, cells, {
        volatile: true,
        note: definition
          ? `${definition.metric}, measured in ${definition.metricUnit}. Its own definition states ${definition.direction.replace(/-/g, ' ')}.`
          : undefined,
        evidence: {
          benchmarkId,
          benchmarkName,
          verdict: comparison.assessment.verdict,
          policyVersion: comparison.assessment.policyVersion,
          summary: comparison.assessment.summary,
          notes: [
            ...comparison.assessment.blockingFindings.map((finding) => finding.detail),
            ...comparison.assessment.warningFindings.map((finding) => finding.detail),
          ],
          directionNote: definition
            ? `On ${benchmarkName}, ${definition.direction.replace(/-/g, ' ')} according to the benchmark\u2019s own definition. ModelTree adds no ranking of its own.`
            : `${benchmarkName} declares no direction in ModelTree, so no reading of these scores as better or worse is published.`,
          evaluationWindow: window,
        },
      });
    });

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  const rowsByGroup: Record<ComparisonGroupId, ComparisonRow[]> = {
    identity: identityRows,
    lifecycle: lifecycleRows,
    positioning: positioningRows,
    modalities: modalityRows,
    limits: limitRows,
    access: accessRows,
    availability: availabilityRows,
    pricing: pricingRows,
    evidence: evidenceRows,
  };

  const absenceReason = (id: ComparisonGroupId): { state: ValueState; reason: string } | null => {
    if (id === 'availability') {
      return dataset.deployments.length === 0
        ? { state: 'not-collected', reason: AVAILABILITY_NOT_COLLECTED }
        : {
          state: 'unrecorded',
          reason: `ModelTree holds deployment records, but none covers ${listOf(models.map((model) => model.displayName))}. Absence is not a claim that these models are unavailable.`,
        };
    }
    if (id === 'pricing') {
      return dataset.pricing.length === 0
        ? { state: 'not-collected', reason: PRICING_NOT_COLLECTED }
        : {
          state: 'unrecorded',
          reason: `ModelTree holds pricing records, but none covers ${listOf(models.map((model) => model.displayName))}. Absence is not a claim that these models are free or unpriced.`,
        };
    }
    if (id === 'evidence') {
      return { state: 'unrecorded', reason: EVIDENCE_NONE };
    }
    // Every other group is guaranteed non-empty by the release schema, so an
    // absence here would be a bug rather than a coverage gap.
    return null;
  };

  const groups: ComparisonGroup[] = COMPARISON_GROUP_ORDER.map((id) => {
    const rows = rowsByGroup[id];
    return {
      id,
      title: GROUP_DEFINITIONS[id].title,
      headingId: `comparison-${id}-title`,
      description: GROUP_DEFINITIONS[id].description,
      rows,
      absence: rows.length === 0 ? absenceReason(id) : null,
    };
  });

  // -------------------------------------------------------------------------
  // Takeaways. Every rule is gated on `fullyStated`, so silence in any column
  // withholds the observation rather than weakening it. That gate is what
  // "source-backed use-case takeaways only when rule-based evidence supports
  // them" reduces to, and it is the only thing standing between an attribute
  // difference and an editorial ranking.
  // -------------------------------------------------------------------------

  const allRows = groups.flatMap((group) => group.rows);
  const rowById = new Map(allRows.map((row) => [row.id, row]));
  const takeaways: ComparisonTakeaway[] = [];

  const nameFor = (slug: string) => models.find((model) => model.slug === slug)?.displayName ?? slug;
  const sourcesForRow = (row: ComparisonRow) => row.cells.flatMap((cell) => cell.sources);

  // Read from `access-type` rather than from the licence rows, and the reason is
  // a coverage fact rather than a preference: `accessType` is required by the
  // schema, so it is stated for all 49 releases, while a licence record exists
  // for 16 and every one of those 16 records downloadable weights. A rule keyed
  // on the licence rows would therefore be unreachable on real data — it would
  // pass its tests against fixtures and never once fire on the site.
  const access = rowById.get('access-type');
  if (access && access.fullyStated && access.differs) {
    const openWeight = releases.filter(
      (release) => release.accessType === 'open-weight' || release.accessType === 'both',
    );
    const hostedOnly = releases.filter((release) => release.accessType === 'proprietary-hosted');
    if (openWeight.length > 0 && hostedOnly.length > 0) {
      takeaways.push({
        rule: 'self-hosting',
        headline: 'Only some of these can be run on your own hardware.',
        detail: `${listOf(openWeight.map((release) => release.displayName))} ${openWeight.length === 1 ? 'documents' : 'document'} open weights; `
          + `${listOf(hostedOnly.map((release) => release.displayName))} ${hostedOnly.length === 1 ? 'is' : 'are'} recorded as available only through a hosted API. `
          + 'If self-hosting, air-gapped deployment, or offline use is a requirement, that difference decides it before any other row does. '
          + 'Open weights and OSI-approved licensing are separate claims and neither implies the other; both are compared on their own rows.',
        basisRowId: access.id,
        sources: sourcesForRow(access),
      });
    }
  }

  const inputs = rowById.get('input-modalities');
  if (inputs && inputs.fullyStated && inputs.differs) {
    takeaways.push({
      rule: 'input-modalities',
      headline: 'These do not accept the same kinds of input.',
      detail: `${inputs.cells.map((cell) => `${nameFor(cell.slug)} accepts ${cell.value}`).join('; ')}. `
        + 'A comparison between releases with different documented input modalities is not a like-for-like choice: '
        + 'for work that needs an input one of them does not document, the others are not substitutes.',
      basisRowId: inputs.id,
      sources: sourcesForRow(inputs),
    });
  }

  const context = rowById.get('context-window');
  if (context && context.fullyStated && context.differs) {
    const windows = releases.map((release) => ({
      name: release.displayName,
      tokens: release.contextWindow ?? 0,
    })).filter((entry) => entry.tokens > 0);
    const smallest = Math.min(...windows.map((entry) => entry.tokens));
    const largest = Math.max(...windows.map((entry) => entry.tokens));
    const above = windows.filter((entry) => entry.tokens > smallest);

    // A stated multiple, not a verdict: the rule reports which records document
    // accepting a prompt the smallest one does not, which is a fact each record
    // states about itself.
    takeaways.push({
      rule: 'context-window',
      headline: 'A long input rules some of these out before quality does.',
      detail: `Documented context windows run from ${formatNumber(smallest)} to ${formatNumber(largest)} tokens. `
        + `A request above ${formatNumber(smallest)} tokens is documented to fit only in ${listOf(above.map((entry) => entry.name))}. `
        + 'A context window is a documented limit, not a measure of how well the release uses it.',
      basisRowId: context.id,
      sources: sourcesForRow(context),
    });
  }

  const status = rowById.get('status');
  if (status && status.fullyStated && status.differs) {
    const superseded = releases.filter(
      (release) => release.status === 'legacy' || release.status === 'deprecated',
    );
    if (superseded.length > 0) {
      takeaways.push({
        rule: 'lifecycle-status',
        headline: 'These are not at the same point in their lifecycles.',
        detail: `${listOf(superseded.map((release) => `${release.displayName} is recorded as ${statusLabel(release.status)}`))}. `
          + 'Starting new work on a release its creator has moved past is a different commitment from starting on a current one, '
          + 'whatever the rest of this table says.',
        basisRowId: status.id,
        sources: sourcesForRow(status),
      });
    }
  }

  for (const row of evidenceRows) {
    if (row.evidence?.verdict === 'not-comparable') {
      takeaways.push({
        rule: 'benchmark-not-comparable',
        headline: `Published ${row.evidence.benchmarkName} scores here cannot be read against each other.`,
        detail: `${row.evidence.summary} Both figures are shown because both are published, `
          + 'but the difference between them is not evidence about the models.',
        basisRowId: row.id,
        sources: sourcesForRow(row),
      });
    }
  }

  const usedStates = VALUE_STATE_ORDER.filter(
    (state) => allRows.some((row) => row.cells.some((cell) => cell.state === state)),
  );

  return {
    selection,
    models,
    groups,
    presentGroups: groups.filter((group) => group.rows.length > 0),
    absentGroups: groups.filter((group) => group.rows.length === 0),
    takeaways,
    noRankingNote: NO_RANKING_NOTE,
    valueStateLegend: usedStates.map((state) => ({
      state,
      label: VALUE_STATE_LABELS[state],
      definition: VALUE_STATE_DEFINITIONS[state],
    })),
    usedStates,
  };
}

/**
 * The picker's rows: every release, with the link that adds or removes it.
 *
 * Built here rather than in the component so the "already selected", "would
 * exceed four" and "would be the removal link" cases are decided in one place a
 * test can reach, and so the picker works with JavaScript disabled — each entry
 * is a real URL.
 */
export function buildComparisonCandidates(
  dataset: Pick<ComparisonDataset, 'releases' | 'organizations' | 'families'>,
  selected: readonly string[],
  base: string,
): ComparisonCandidate[] {
  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));
  const familyById = new Map(dataset.families.map((item) => [item.id, item]));

  return dataset.releases.map((release) => {
    const isSelected = selected.includes(release.slug);
    const next = isSelected
      ? removeFromComparison(selected, release.slug)
      : addToComparison(selected, release.slug).slugs;

    return {
      slug: release.slug,
      displayName: release.displayName,
      organizationName: organizationById.get(release.organizationId)?.name ?? release.organizationId,
      familyName: familyById.get(release.familyId)?.name ?? release.familyId,
      selected: isSelected,
      toggleUrl: compareUrl(base, next),
      toggleLabel: isSelected
        ? `Remove ${release.displayName} from the comparison`
        : `Add ${release.displayName} to the comparison`,
    };
  });
}

/** Re-exported so a consumer marking an undisclosed benchmark cell uses one spelling. */
export { UNDISCLOSED_LABEL };
