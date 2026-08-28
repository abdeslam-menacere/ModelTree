import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ModelRelease,
  Publisher,
  SourceReference,
} from '../data/schema';
import {
  blockingDimensions,
  defaultComparabilityPolicy,
  normalizeDisclosedValue,
  resolveEvaluationSpreadMonths,
  type ComparabilityDimension,
  type ComparabilityDimensionId,
  type ComparabilityPolicy,
  type FindingSeverity,
} from './comparability-policy';

/**
 * Benchmark comparability and evidence transformations (issue #22).
 *
 * Two numbers printed side by side imply they were measured the same way. This
 * module decides when that implication is earned, and when it is not it says so
 * in words a table can carry.
 *
 * The load-bearing rule, and the one worth stating before any code: a field
 * nobody filled in can never satisfy a sameness check. Equality would make
 * `undefined === undefined` true and return the *strongest* verdict exactly
 * where the evidence is *weakest*. So every dimension resolves to one of three
 * states -- `same`, `different`, `unknown` -- and `same` is reachable only when
 * every result in the set actually disclosed the value. `unknown` flows into an
 * explicit warning or a refusal, never into `comparable`.
 *
 * This is not hypothetical for this repository. No benchmark result currently
 * records a harness, a reasoning mode, or tool use, so `unknown` is the only
 * state real data can honestly produce for those three dimensions.
 */

export type DimensionState = 'same' | 'different' | 'unknown';

/** How much of the set actually stated a value for a dimension. */
export type Disclosure = 'full' | 'partial' | 'none';

export type ComparabilityVerdict = 'comparable' | 'partially-comparable' | 'not-comparable';

export type ComparabilityFindingCode =
  | `${ComparabilityDimensionId}-mismatch`
  | `${ComparabilityDimensionId}-partially-disclosed`
  | `${ComparabilityDimensionId}-undisclosed`
  | 'evaluation-window-spread';

export const UNDISCLOSED_LABEL = 'Not disclosed';

export interface DimensionOutcome {
  dimension: ComparabilityDimensionId;
  label: string;
  state: DimensionState;
  disclosure: Disclosure;
  /** Distinct disclosed values, as written by their sources, sorted. */
  values: string[];
  disclosedCount: number;
  undisclosedCount: number;
}

export interface ComparabilityFinding {
  code: ComparabilityFindingCode;
  dimension: ComparabilityDimensionId | 'evaluation-window';
  severity: FindingSeverity;
  state: DimensionState;
  /** One sentence a consumer can print beside the comparison. */
  detail: string;
}

export interface ComparabilityAssessment {
  verdict: ComparabilityVerdict;
  policyVersion: string;
  dimensions: DimensionOutcome[];
  findings: ComparabilityFinding[];
  blockingFindings: ComparabilityFinding[];
  warningFindings: ComparabilityFinding[];
  summary: string;
}

export interface ComparabilityRange {
  min: number;
  max: number;
  span: number;
  /** The best and worst score under the benchmark's own metric direction. */
  best: number;
  worst: number;
  direction: BenchmarkDefinition['direction'];
  /**
   * `explicit` when every checked dimension was disclosed and identical;
   * `provisional` when the group only clears the blocking rules and still
   * carries warnings. A provisional range must never be rendered without the
   * findings that qualify it.
   */
  confidence: 'explicit' | 'provisional';
}

export interface EvaluationWindow {
  earliest: string;
  latest: string;
  spreadMonths: number;
  allowedSpreadMonths: number;
  isVolatile: boolean;
}

export interface ComparabilitySourceView {
  source: SourceReference;
  publisherName: string;
}

export interface DisclosedSetupEntry {
  dimension: ComparabilityDimensionId;
  label: string;
  /** The disclosed value, or `UNDISCLOSED_LABEL` when the source is silent. */
  value: string;
  isDisclosed: boolean;
}

export interface ComparabilityResultView {
  result: BenchmarkResult;
  releaseId: string;
  releaseName: string;
  benchmarkId: string;
  benchmarkName: string;
  score: number;
  unit: string;
  evaluationDate: string;
  caveats: string | null;
  verifiedAt: string;
  sources: ComparabilitySourceView[];
  setup: DisclosedSetupEntry[];
}

export interface ComparabilityGroup {
  key: string;
  benchmarkId: string;
  benchmarkName: string;
  benchmarkVersion: string;
  metric: string;
  unit: string;
  direction: BenchmarkDefinition['direction'];
  assessment: ComparabilityAssessment;
  /** Ordered best to worst under this group's own direction, never across groups. */
  results: ComparabilityResultView[];
  displayRange: ComparabilityRange | null;
  evaluationWindow: EvaluationWindow | null;
}

export interface ComparabilityTableColumn {
  key: string;
  label: string;
}

export interface ComparabilityTableRow {
  resultId: string;
  cells: Record<string, string>;
}

export interface ComparabilityTable {
  caption: string;
  columns: ComparabilityTableColumn[];
  rows: ComparabilityTableRow[];
  /** The textual comparability reasons, one per finding, in severity order. */
  notes: string[];
}

export interface ComparabilityContext {
  benchmarks?: BenchmarkDefinition[];
  releases?: ModelRelease[];
  sources?: SourceReference[];
  publishers?: Publisher[];
  policy?: ComparabilityPolicy;
}

interface ResolvedContext {
  policy: ComparabilityPolicy;
  benchmarkById: Map<string, BenchmarkDefinition>;
  releaseById: Map<string, ModelRelease>;
  sourceById: Map<string, SourceReference>;
  publisherById: Map<string, Publisher>;
}

function resolveContext(context: ComparabilityContext = {}): ResolvedContext {
  return {
    policy: context.policy ?? defaultComparabilityPolicy,
    benchmarkById: new Map((context.benchmarks ?? []).map((entry) => [entry.id, entry])),
    releaseById: new Map((context.releases ?? []).map((entry) => [entry.id, entry])),
    sourceById: new Map((context.sources ?? []).map((entry) => [entry.id, entry])),
    publisherById: new Map((context.publishers ?? []).map((entry) => [entry.id, entry])),
  };
}

// --- dimensions -------------------------------------------------------------

/**
 * Resolve one dimension across a set of results.
 *
 * The order of the branches is the whole guard. `different` is decided first,
 * because two distinct disclosed values are a known incompatibility whatever
 * else is missing. `same` is decided last and only after every result has been
 * confirmed to disclose the value, which is what stops silence from passing as
 * agreement.
 */
export function evaluateDimension(
  results: BenchmarkResult[],
  dimension: ComparabilityDimension,
): DimensionOutcome {
  const disclosed: string[] = [];
  let undisclosedCount = 0;

  for (const result of results) {
    const value = dimension.read(result);
    if (value === undefined) {
      undisclosedCount += 1;
    } else {
      disclosed.push(value);
    }
  }

  const distinctNormalized = new Set(disclosed.map(normalizeDisclosedValue));
  const values = [...new Set(disclosed)].sort();

  const disclosure: Disclosure = disclosed.length === 0
    ? 'none'
    : undisclosedCount === 0
      ? 'full'
      : 'partial';

  const state: DimensionState = distinctNormalized.size > 1
    ? 'different'
    : disclosure === 'full'
      ? 'same'
      : 'unknown';

  return {
    dimension: dimension.id,
    label: dimension.label,
    state,
    disclosure,
    values,
    disclosedCount: disclosed.length,
    undisclosedCount,
  };
}

function findingFor(
  dimension: ComparabilityDimension,
  outcome: DimensionOutcome,
): ComparabilityFinding | null {
  if (outcome.state === 'same') return null;

  if (outcome.state === 'different') {
    return {
      code: `${dimension.id}-mismatch`,
      dimension: dimension.id,
      state: 'different',
      severity: dimension.onDifference,
      detail: `${dimension.label} differs across these results (${outcome.values.join(' vs ')}). ${dimension.rationale}`,
    };
  }

  if (outcome.disclosure === 'partial') {
    return {
      code: `${dimension.id}-partially-disclosed`,
      dimension: dimension.id,
      state: 'unknown',
      severity: dimension.onPartialDisclosure,
      detail: `${dimension.label} is recorded for ${outcome.disclosedCount} of these results (${outcome.values.join(', ')}) and left unstated for ${outcome.undisclosedCount}, so nothing establishes that they match. ${dimension.rationale}`,
    };
  }

  return {
    code: `${dimension.id}-undisclosed`,
    dimension: dimension.id,
    state: 'unknown',
    severity: dimension.onUndisclosed,
    detail: `${dimension.label} is not disclosed for any of these results, so it is unknown whether they match. ${dimension.rationale}`,
  };
}

// --- evaluation dates -------------------------------------------------------

/**
 * The first and last month a partial date could mean, so `2025` is read as the
 * whole of 2025 rather than as 1 January. Widening a year-only date widens the
 * measured spread, which errs toward warning -- the safe direction here.
 */
function monthBounds(value: string) {
  const [year, month] = value.split('-');
  const yearMonths = Number(year) * 12;
  if (month === undefined) return { earliest: yearMonths, latest: yearMonths + 11 };
  return { earliest: yearMonths + Number(month) - 1, latest: yearMonths + Number(month) - 1 };
}

export function evaluationWindow(
  results: BenchmarkResult[],
  allowedSpreadMonths: number,
): EvaluationWindow | null {
  if (results.length === 0) return null;

  const dates = results.map((result) => result.evaluationDate).sort();
  const earliest = dates[0]!;
  const latest = dates[dates.length - 1]!;
  const spreadMonths = Math.max(
    ...dates.map((date) => monthBounds(date).latest),
  ) - Math.min(...dates.map((date) => monthBounds(date).earliest));

  return {
    earliest,
    latest,
    spreadMonths,
    allowedSpreadMonths,
    isVolatile: spreadMonths > allowedSpreadMonths,
  };
}

// --- assessment -------------------------------------------------------------

function summarize(verdict: ComparabilityVerdict, findings: ComparabilityFinding[]) {
  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  if (verdict === 'not-comparable') {
    return `Not comparable: ${blocking.map((finding) => finding.detail).join(' ')}`;
  }
  if (verdict === 'partially-comparable') {
    return `Partially comparable: ${warnings.map((finding) => finding.detail).join(' ')}`;
  }
  return 'Comparable: every dimension this policy checks is disclosed and identical across these results.';
}

/**
 * Decide whether an arbitrary set of results may be compared.
 *
 * Deterministic by construction: it reads only the results and the policy, and
 * iterates the policy's dimensions in their declared order, so the same input
 * yields the same findings in the same order every time.
 */
export function assessComparability(
  results: BenchmarkResult[],
  context: ComparabilityContext = {},
): ComparabilityAssessment {
  const { policy, benchmarkById } = resolveContext(context);
  const dimensions: DimensionOutcome[] = [];
  const findings: ComparabilityFinding[] = [];

  for (const dimension of policy.dimensions) {
    const outcome = evaluateDimension(results, dimension);
    dimensions.push(outcome);
    const finding = findingFor(dimension, outcome);
    if (finding) findings.push(finding);
  }

  // The date rule is benchmark-scoped rather than result-scoped, so it only
  // applies once the set agrees on which benchmark it is measuring. Applying a
  // single benchmark's tolerance to a mixed set would be meaningless.
  const benchmarkOutcome = dimensions.find((entry) => entry.dimension === 'benchmark');
  if (benchmarkOutcome?.state === 'same' && results.length > 0) {
    const benchmarkId = results[0]!.benchmarkId;
    const allowed = resolveEvaluationSpreadMonths(policy, benchmarkId);
    const window = evaluationWindow(results, allowed);
    if (window?.isVolatile) {
      const benchmarkName = benchmarkById.get(benchmarkId)?.name ?? benchmarkId;
      findings.push({
        code: 'evaluation-window-spread',
        dimension: 'evaluation-window',
        state: 'different',
        severity: 'warning',
        detail: `These results were evaluated ${window.spreadMonths} months apart (${window.earliest} to ${window.latest}), beyond the ${allowed}-month window this policy allows for ${benchmarkName}. Benchmark contents and tooling move over time.`,
      });
    }
  }

  const blockingFindings = findings.filter((finding) => finding.severity === 'blocking');
  const warningFindings = findings.filter((finding) => finding.severity === 'warning');

  const verdict: ComparabilityVerdict = blockingFindings.length > 0
    ? 'not-comparable'
    : warningFindings.length > 0
      ? 'partially-comparable'
      : 'comparable';

  return {
    verdict,
    policyVersion: policy.version,
    dimensions,
    findings,
    blockingFindings,
    warningFindings,
    summary: summarize(verdict, findings),
  };
}

// --- direction and ranges ---------------------------------------------------

/**
 * Ranges and normalisation are computed strictly inside one already-compatible
 * set. Nothing here ever reaches across a group, and a set that is not
 * comparable at all gets no range -- there is no shared scale to place it on.
 */
export function comparabilityRange(
  results: BenchmarkResult[],
  direction: BenchmarkDefinition['direction'],
  verdict: ComparabilityVerdict,
): ComparabilityRange | null {
  if (verdict === 'not-comparable' || results.length === 0) return null;

  const scores = results.map((result) => result.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);

  return {
    min,
    max,
    span: max - min,
    best: direction === 'higher-is-better' ? max : min,
    worst: direction === 'higher-is-better' ? min : max,
    direction,
    confidence: verdict === 'comparable' ? 'explicit' : 'provisional',
  };
}

/**
 * Position a score within its own group's range, where 1 is always the best
 * result under that group's direction. A group whose scores are all equal
 * normalises to 1 for every member rather than dividing by a zero span.
 */
export function normalizeWithinGroup(range: ComparabilityRange, score: number) {
  if (range.span === 0) return 1;
  return range.direction === 'higher-is-better'
    ? (score - range.min) / range.span
    : (range.max - score) / range.span;
}

/** Best first under the group's direction; ties broken by id so order is stable. */
function orderByDirection(
  results: BenchmarkResult[],
  direction: BenchmarkDefinition['direction'],
) {
  return [...results].sort((a, b) => {
    const delta = direction === 'higher-is-better' ? b.score - a.score : a.score - b.score;
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

// --- grouping ---------------------------------------------------------------

/**
 * The grouping key.
 *
 * It covers every dimension whose difference blocks a comparison, and it
 * encodes an undisclosed value as `null` -- a token no disclosed string can
 * produce. That is what keeps a result with no recorded harness out of the same
 * group as one that names a harness, while still letting two equally silent
 * results sit together as candidates. They group; they do not thereby become
 * comparable, because the verdict is computed separately and downgrades on the
 * same silence.
 */
export function comparabilityGroupKey(
  result: BenchmarkResult,
  policy: ComparabilityPolicy = defaultComparabilityPolicy,
) {
  return JSON.stringify(
    blockingDimensions(policy).map((dimension) => {
      const value = dimension.read(result);
      return value === undefined ? null : normalizeDisclosedValue(value);
    }),
  );
}

function releaseName(releaseId: string, releaseById: Map<string, ModelRelease>) {
  const release = releaseById.get(releaseId);
  return release?.displayName ?? release?.canonicalName ?? releaseId;
}

function buildResultView(
  result: BenchmarkResult,
  { policy, benchmarkById, releaseById, sourceById, publisherById }: ResolvedContext,
): ComparabilityResultView {
  return {
    result,
    releaseId: result.releaseId,
    releaseName: releaseName(result.releaseId, releaseById),
    benchmarkId: result.benchmarkId,
    benchmarkName: benchmarkById.get(result.benchmarkId)?.name ?? result.benchmarkId,
    score: result.score,
    unit: result.unit,
    evaluationDate: result.evaluationDate,
    caveats: result.caveats ?? null,
    verifiedAt: result.verifiedAt,
    sources: result.sourceIds
      .map((sourceId) => sourceById.get(sourceId))
      .filter((source): source is SourceReference => Boolean(source))
      .map((source) => ({
        source,
        publisherName: publisherById.get(source.publisherId)?.name ?? source.publisherId,
      })),
    setup: policy.dimensions
      // The always-present identity dimensions describe which comparison this
      // is, not how the run was configured, so they are not setup entries.
      .filter((dimension) => !['benchmark', 'benchmark-version', 'unit'].includes(dimension.id))
      .map((dimension) => {
        const value = dimension.read(result);
        return {
          dimension: dimension.id,
          label: dimension.label,
          value: value ?? UNDISCLOSED_LABEL,
          isDisclosed: value !== undefined,
        };
      }),
  };
}

/**
 * Group every result into candidate sets and assess each one.
 *
 * Groups come back ordered by key. That is deliberate: an ordering by score
 * would read as a ranking, and this layer never ranks across groups.
 */
export function buildComparabilityGroups(
  data: {
    benchmarks?: BenchmarkDefinition[];
    benchmarkResults: BenchmarkResult[];
    releases?: ModelRelease[];
    sources?: SourceReference[];
    publishers?: Publisher[];
  },
  context: Omit<ComparabilityContext, 'benchmarks' | 'releases' | 'sources' | 'publishers'> = {},
): ComparabilityGroup[] {
  const resolved = resolveContext({
    benchmarks: data.benchmarks,
    releases: data.releases,
    sources: data.sources,
    publishers: data.publishers,
    policy: context.policy,
  });

  const buckets = new Map<string, BenchmarkResult[]>();
  for (const result of data.benchmarkResults) {
    const key = comparabilityGroupKey(result, resolved.policy);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(result);
    else buckets.set(key, [result]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, results]) => {
      const first = results[0]!;
      const benchmark = resolved.benchmarkById.get(first.benchmarkId);
      const direction = benchmark?.direction ?? 'higher-is-better';
      const assessment = assessComparability(results, {
        benchmarks: data.benchmarks,
        policy: resolved.policy,
      });

      return {
        key,
        benchmarkId: first.benchmarkId,
        benchmarkName: benchmark?.name ?? first.benchmarkId,
        benchmarkVersion: first.benchmarkVersion,
        metric: benchmark?.metric ?? first.unit,
        unit: first.unit,
        direction,
        assessment,
        results: orderByDirection(results, direction)
          .map((result) => buildResultView(result, resolved)),
        displayRange: comparabilityRange(results, direction, assessment.verdict),
        evaluationWindow: evaluationWindow(
          results,
          resolveEvaluationSpreadMonths(resolved.policy, first.benchmarkId),
        ),
      };
    });
}

/**
 * Assess an arbitrary set a consumer picked itself -- two results a reader
 * asked to compare, which may well cross a group boundary. This is the entry
 * point that can return `not-comparable`, because `buildComparabilityGroups`
 * never puts a blocking difference inside one group.
 */
export function buildComparison(
  results: BenchmarkResult[],
  context: ComparabilityContext = {},
) {
  const resolved = resolveContext(context);
  const assessment = assessComparability(results, context);
  const benchmark = results.length > 0
    ? resolved.benchmarkById.get(results[0]!.benchmarkId)
    : undefined;
  const direction = benchmark?.direction ?? 'higher-is-better';

  // Direction only means something once the set agrees on one benchmark, so an
  // unrelated-benchmark set is ordered by id and gets no range.
  const isSingleBenchmark = assessment.dimensions
    .find((entry) => entry.dimension === 'benchmark')?.state === 'same';

  const ordered = isSingleBenchmark
    ? orderByDirection(results, direction)
    : [...results].sort((a, b) => a.id.localeCompare(b.id));

  return {
    assessment,
    direction: isSingleBenchmark ? direction : null,
    results: ordered.map((result) => buildResultView(result, resolved)),
    displayRange: isSingleBenchmark
      ? comparabilityRange(results, direction, assessment.verdict)
      : null,
  };
}

// --- accessible table -------------------------------------------------------

/**
 * The table model behind every visual comparison.
 *
 * Issue #22 requires a semantically equivalent table and a textual reason, so
 * the reasons travel in the same object as the rows. Every cell is a string and
 * silence is spelled out rather than left blank, because an empty cell reads as
 * a rendering gap rather than as missing evidence.
 */
export function buildComparabilityTable(input: {
  benchmarkName?: string;
  benchmarkVersion?: string;
  assessment: ComparabilityAssessment;
  results: ComparabilityResultView[];
}): ComparabilityTable {
  const setupColumns: ComparabilityTableColumn[] = (input.results[0]?.setup ?? []).map(
    (entry) => ({ key: entry.dimension, label: entry.label }),
  );

  const columns: ComparabilityTableColumn[] = [
    { key: 'release', label: 'Model release' },
    { key: 'benchmark', label: 'Benchmark' },
    { key: 'score', label: 'Score' },
    { key: 'evaluationDate', label: 'Evaluation date' },
    ...setupColumns,
    { key: 'sources', label: 'Sources' },
    { key: 'caveats', label: 'Caveats' },
    { key: 'verifiedAt', label: 'Verified' },
  ];

  const rows: ComparabilityTableRow[] = input.results.map((view) => {
    const cells: Record<string, string> = {
      release: view.releaseName,
      benchmark: `${view.benchmarkName} (${view.result.benchmarkVersion})`,
      score: `${view.score} ${view.unit}`,
      evaluationDate: view.evaluationDate,
      sources: view.sources.length > 0
        ? view.sources.map((entry) => `${entry.publisherName}: ${entry.source.title}`).join('; ')
        : UNDISCLOSED_LABEL,
      caveats: view.caveats ?? 'None recorded',
      verifiedAt: view.verifiedAt,
    };
    for (const entry of view.setup) cells[entry.dimension] = entry.value;
    return { resultId: view.result.id, cells };
  });

  const caption = input.benchmarkName
    ? `${input.benchmarkName}${input.benchmarkVersion ? ` (${input.benchmarkVersion})` : ''} — ${input.assessment.summary}`
    : input.assessment.summary;

  return {
    caption,
    columns,
    rows,
    notes: [
      ...input.assessment.blockingFindings.map((finding) => finding.detail),
      ...input.assessment.warningFindings.map((finding) => finding.detail),
    ],
  };
}

/** The table for a group, captioned with the benchmark it belongs to. */
export function buildGroupTable(group: ComparabilityGroup): ComparabilityTable {
  return buildComparabilityTable({
    benchmarkName: group.benchmarkName,
    benchmarkVersion: group.benchmarkVersion,
    assessment: group.assessment,
    results: group.results,
  });
}
