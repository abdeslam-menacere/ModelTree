import type { BenchmarkResult } from '../data/schema';

/**
 * The versioned comparability policy.
 *
 * Issue #22 requires that comparability rules live "with benchmark definitions
 * or a versioned policy, not hardcoded per UI chart". This module is that
 * policy: a data structure describing which disclosed dimensions decide whether
 * two benchmark results may sit beside each other, and what a difference or a
 * silence in each one costs. The engine in `comparability.ts` reads this table
 * and owns no benchmark knowledge of its own, so a rule change is an edit here
 * rather than a change to a chart.
 *
 * Bump `COMPARABILITY_POLICY_VERSION` whenever a dimension, a severity, or an
 * override changes. Consumers carry the version alongside every verdict so a
 * rendered comparison can be traced back to the rules that produced it.
 */
export const COMPARABILITY_POLICY_VERSION = '2026-08-benchmark-comparability-1';

export type ComparabilityDimensionId =
  | 'benchmark'
  | 'benchmark-version'
  | 'unit'
  | 'variant-note'
  | 'harness'
  | 'reasoning-mode'
  | 'tools-enabled'
  | 'result-type';

/**
 * `blocking` refuses the comparison outright; `warning` lets it stand but
 * forces an explicit caveat that a consumer cannot render without.
 */
export type FindingSeverity = 'blocking' | 'warning';

export interface ComparabilityDimension {
  id: ComparabilityDimensionId;
  label: string;
  /**
   * The disclosed value, or `undefined` when no source ever stated it.
   *
   * `undefined` means "nobody wrote this down", never "these agree". The engine
   * depends on that distinction, so a reader must not collapse the two.
   */
  read: (result: BenchmarkResult) => string | undefined;
  /** Cost when two results disclose genuinely different values. */
  onDifference: FindingSeverity;
  /** Cost when some results disclose the value and others do not. */
  onPartialDisclosure: FindingSeverity;
  /** Cost when no result in the set discloses the value at all. */
  onUndisclosed: FindingSeverity;
  /** Why this dimension can change what a number means. Shown to readers. */
  rationale: string;
}

/**
 * Reading `toolsEnabled` needs an explicit `undefined` test rather than a
 * truthiness test: `false` is a disclosure ("tools were off") and must stay
 * distinguishable from silence, or a tools-off run would read as undisclosed
 * and be compared against a tools-on run under a mere warning.
 */
function readToolsEnabled(result: BenchmarkResult) {
  if (result.toolsEnabled === undefined) return undefined;
  return result.toolsEnabled ? 'tools enabled' : 'tools disabled';
}

/**
 * Setup dimensions share one severity profile, and the reasoning is the same in
 * every case. A disclosed difference is a known incompatibility, so it blocks.
 * Asymmetric disclosure -- one side names a harness, the other is silent --
 * also blocks, because nothing in the record establishes that the silent run
 * used the same one; treating it as a match would be an inference, which the
 * issue's non-goals rule out. Total silence only warns, because refusing every
 * comparison in a corpus where nobody discloses harnesses would leave no
 * evidence at all; the caveat carries the uncertainty instead.
 */
const SETUP_SEVERITY = {
  onDifference: 'blocking',
  onPartialDisclosure: 'blocking',
  onUndisclosed: 'warning',
} as const satisfies Pick<
  ComparabilityDimension,
  'onDifference' | 'onPartialDisclosure' | 'onUndisclosed'
>;

/** Dimensions the schema always populates, so silence is unreachable for them. */
const ALWAYS_DISCLOSED = {
  onDifference: 'blocking',
  onPartialDisclosure: 'blocking',
  onUndisclosed: 'blocking',
} as const satisfies Pick<
  ComparabilityDimension,
  'onDifference' | 'onPartialDisclosure' | 'onUndisclosed'
>;

export const COMPARABILITY_DIMENSIONS: ComparabilityDimension[] = [
  {
    id: 'benchmark',
    label: 'Benchmark',
    read: (result) => result.benchmarkId,
    ...ALWAYS_DISCLOSED,
    rationale:
      'Two benchmarks measure different things, so their scores share no scale even when both are percentages.',
  },
  {
    id: 'benchmark-version',
    label: 'Benchmark version',
    read: (result) => result.benchmarkVersion,
    ...ALWAYS_DISCLOSED,
    rationale:
      'Shot count, subset, and problem-release window change the difficulty of the same named benchmark.',
  },
  {
    id: 'unit',
    label: 'Unit',
    read: (result) => result.unit,
    ...ALWAYS_DISCLOSED,
    rationale: 'A score cannot be placed on a scale it was not measured in.',
  },
  {
    id: 'variant-note',
    label: 'Model variant',
    read: (result) => result.variantNote,
    ...SETUP_SEVERITY,
    rationale:
      'A base checkpoint and an instruction-tuned checkpoint are different systems under one release name.',
  },
  {
    id: 'harness',
    label: 'Evaluation harness',
    read: (result) => result.harness,
    ...SETUP_SEVERITY,
    rationale:
      'Prompt templates, answer parsing, and scoring differ between harnesses, which moves the same model by points.',
  },
  {
    id: 'reasoning-mode',
    label: 'Reasoning mode',
    read: (result) => result.reasoningMode,
    ...SETUP_SEVERITY,
    rationale:
      'Extended reasoning changes the compute a model spends per question, so it is a different configuration of the same weights.',
  },
  {
    id: 'tools-enabled',
    label: 'Tool use',
    read: readToolsEnabled,
    ...SETUP_SEVERITY,
    rationale:
      'A run with search or code execution available is not measuring the model alone.',
  },
  {
    id: 'result-type',
    label: 'Result provenance',
    read: (result) => result.resultType,
    // Deliberately a warning rather than a block. An official figure set
    // against an independent reproduction is one of the most useful
    // comparisons this dataset can offer; it needs a caveat, not a refusal.
    onDifference: 'warning',
    onPartialDisclosure: 'warning',
    onUndisclosed: 'warning',
    rationale:
      'A creator-reported figure and an independent measurement carry different incentives and verification.',
  },
];

/**
 * A named exception to the default rules for one benchmark.
 *
 * `owner` and `rationale` are required because issue #22 records the risk that
 * "benchmark-specific exceptions can become unmaintainable without explicit
 * ownership". An override that cannot say who holds it and why does not compile.
 */
export interface BenchmarkPolicyOverride {
  evaluationSpreadMonths?: number;
  owner: string;
  rationale: string;
}

export interface ComparabilityPolicy {
  version: string;
  dimensions: ComparabilityDimension[];
  /**
   * How far apart two evaluation dates may sit before the comparison carries a
   * volatility note. Models and benchmark tooling both move; a year is the
   * point past which "measured at the same time" stops being a fair reading.
   */
  defaultEvaluationSpreadMonths: number;
  benchmarkOverrides: Record<string, BenchmarkPolicyOverride>;
}

export const defaultComparabilityPolicy: ComparabilityPolicy = {
  version: COMPARABILITY_POLICY_VERSION,
  dimensions: COMPARABILITY_DIMENSIONS,
  defaultEvaluationSpreadMonths: 12,
  benchmarkOverrides: {
    livecodebench: {
      evaluationSpreadMonths: 3,
      owner: 'ModelTree benchmark data maintainers',
      rationale:
        "LiveCodeBench collects new problems continuously, so its own methodology notes state a result is only comparable to others over the same problem-release window. Dates that drift more than a quarter apart are very likely different windows even when the recorded version string matches.",
    },
  },
};

export function resolveEvaluationSpreadMonths(
  policy: ComparabilityPolicy,
  benchmarkId: string,
) {
  return (
    policy.benchmarkOverrides[benchmarkId]?.evaluationSpreadMonths
    ?? policy.defaultEvaluationSpreadMonths
  );
}

/**
 * Dimensions whose disclosed differences refuse a comparison. These, and only
 * these, form the grouping key: results that differ on a warning-only
 * dimension still belong in one group, carrying the warning with them.
 */
export function blockingDimensions(policy: ComparabilityPolicy) {
  return policy.dimensions.filter((dimension) => dimension.onDifference === 'blocking');
}

/**
 * Free-text disclosures are compared case- and whitespace-insensitively, the
 * same normalisation `comparabilityKey` already applies to usage observations.
 * Only comparison uses the normalised form; readers are always shown the value
 * exactly as the source wrote it.
 */
export function normalizeDisclosedValue(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
