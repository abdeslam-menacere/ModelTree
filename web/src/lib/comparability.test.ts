import { describe, expect, it } from 'vitest';
import { rawDataset } from '../data/raw';
import { validateDataset } from '../data/validate';
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Publisher,
  SourceReference,
} from '../data/schema';
import {
  COMPARABILITY_DIMENSIONS,
  defaultComparabilityPolicy,
  type ComparabilityPolicy,
} from './comparability-policy';
import {
  assessComparability,
  buildComparabilityGroups,
  buildComparabilityTable,
  buildComparison,
  buildGroupTable,
  comparabilityGroupKey,
  comparabilityRange,
  evaluateDimension,
  evaluationWindow,
  normalizeWithinGroup,
  UNDISCLOSED_LABEL,
  type ComparabilityFindingCode,
  type ComparabilityVerdict,
} from './comparability';

// --- fixtures ---------------------------------------------------------------
//
// Three acceptance criteria of issue #22 cannot be exercised by this
// repository's data at all: no benchmark result records a harness, a reasoning
// mode, or tool use; every benchmark is higher-is-better; and every result is
// official. Testing only over the real corpus would leave those guards
// unexecuted behind a green suite, so they are driven from fixtures here and
// the real corpus is exercised separately further down.

const benchmarks: BenchmarkDefinition[] = [
  {
    id: 'fixture-bench',
    slug: 'fixture-bench',
    name: 'Fixture Benchmark',
    domain: 'general-reasoning',
    owner: 'Fixture Owner',
    metric: 'Accuracy',
    metricUnit: 'percent',
    direction: 'higher-is-better',
    sourceIds: ['fixture-source'],
    verifiedAt: '2026-01-15',
  },
  {
    id: 'other-bench',
    slug: 'other-bench',
    name: 'Other Benchmark',
    domain: 'coding',
    owner: 'Fixture Owner',
    metric: 'pass@1',
    metricUnit: 'percent',
    direction: 'higher-is-better',
    sourceIds: ['fixture-source'],
    verifiedAt: '2026-01-15',
  },
  {
    id: 'fixture-latency',
    slug: 'fixture-latency',
    name: 'Fixture Latency',
    domain: 'operational',
    owner: 'Fixture Owner',
    metric: 'Time to first token',
    metricUnit: 'seconds',
    direction: 'lower-is-better',
    sourceIds: ['fixture-source'],
    verifiedAt: '2026-01-15',
  },
];

const publishers: Publisher[] = [{ id: 'fixture-publisher', name: 'Fixture Publisher' }];

const sources: SourceReference[] = [
  {
    id: 'fixture-source',
    url: 'https://example.com/fixture',
    title: 'Fixture evaluation report',
    type: 'official-announcement',
    publisherId: 'fixture-publisher',
    lastCheckedDate: '2026-01-15',
  },
];

/** Everything the policy checks is disclosed, so this pair is exactly comparable. */
const disclosedA: BenchmarkResult = {
  id: 'fixture-a',
  benchmarkId: 'fixture-bench',
  benchmarkVersion: '0-shot',
  releaseId: 'fixture-release-a',
  variantNote: 'Instruction-tuned',
  score: 70,
  unit: 'percent',
  evaluationDate: '2026-01',
  reasoningMode: 'standard',
  toolsEnabled: false,
  harness: 'lm-eval-harness 0.4.3',
  resultType: 'official',
  caveats: 'Fixture record.',
  sourceIds: ['fixture-source'],
  verifiedAt: '2026-01-15',
};

const disclosedB: BenchmarkResult = {
  ...disclosedA,
  id: 'fixture-b',
  releaseId: 'fixture-release-b',
  score: 82,
};

/** The shape every result in this repository actually has: setup undisclosed. */
const silentA: BenchmarkResult = {
  id: 'silent-a',
  benchmarkId: 'fixture-bench',
  benchmarkVersion: '0-shot',
  releaseId: 'fixture-release-a',
  variantNote: 'Instruction-tuned',
  score: 70,
  unit: 'percent',
  evaluationDate: '2026-01',
  resultType: 'official',
  sourceIds: ['fixture-source'],
  verifiedAt: '2026-01-15',
};

const silentB: BenchmarkResult = { ...silentA, id: 'silent-b', releaseId: 'fixture-release-b', score: 82 };

const context = { benchmarks, publishers, sources };

function codesOf(results: BenchmarkResult[], policy?: ComparabilityPolicy) {
  return assessComparability(results, { ...context, policy }).findings.map((finding) => finding.code);
}

function dimension(id: string) {
  const found = COMPARABILITY_DIMENSIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no dimension ${id}`);
  return found;
}

// --- the guard this module exists for ---------------------------------------

describe('undisclosed setup never reads as matching setup', () => {
  // Written as equality, `a.harness === b.harness` is `undefined === undefined`
  // for every pair in this repository, so every comparison would come back
  // `comparable` -- the strongest verdict returned exactly where the evidence
  // is weakest. Each assertion below is paired with a positive control so that
  // a state of `unknown` means the data is silent, not that the probe is dead.
  for (const id of ['harness', 'reasoning-mode', 'tools-enabled'] as const) {
    it(`resolves ${id} to unknown, not same, when nobody recorded it`, () => {
      const outcome = evaluateDimension([silentA, silentB], dimension(id));

      expect(outcome.state).toBe('unknown');
      expect(outcome.state).not.toBe('same');
      expect(outcome.disclosure).toBe('none');
      expect(outcome.disclosedCount).toBe(0);
      expect(outcome.undisclosedCount).toBe(2);
    });
  }

  it('positive control: the same readers do return same when the value is recorded', () => {
    for (const id of ['harness', 'reasoning-mode', 'tools-enabled'] as const) {
      const outcome = evaluateDimension([disclosedA, disclosedB], dimension(id));

      expect(outcome.state, id).toBe('same');
      expect(outcome.disclosure, id).toBe('full');
      expect(outcome.undisclosedCount, id).toBe(0);
    }
  });

  it('refuses to call a wholly undisclosed pair comparable', () => {
    const assessment = assessComparability([silentA, silentB], context);

    expect(assessment.verdict).toBe('partially-comparable');
    expect(assessment.verdict).not.toBe('comparable');
    expect(assessment.findings.map((finding) => finding.code)).toEqual([
      'harness-undisclosed',
      'reasoning-mode-undisclosed',
      'tools-enabled-undisclosed',
    ]);
    for (const finding of assessment.findings) expect(finding.severity).toBe('warning');
  });

  it('positive control: the identical pair with setup recorded is comparable', () => {
    const assessment = assessComparability([disclosedA, disclosedB], context);

    expect(assessment.verdict).toBe('comparable');
    expect(assessment.findings).toEqual([]);
  });
});

// --- mutation-style guards --------------------------------------------------

interface Mutation {
  name: string;
  mutate: (result: BenchmarkResult) => BenchmarkResult;
  code: ComparabilityFindingCode;
  severity: 'blocking' | 'warning';
  verdict: ComparabilityVerdict;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'an unrelated benchmark',
    mutate: (result) => ({ ...result, benchmarkId: 'other-bench' }),
    code: 'benchmark-mismatch',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'a different benchmark version',
    mutate: (result) => ({ ...result, benchmarkVersion: '5-shot' }),
    code: 'benchmark-version-mismatch',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'a different unit',
    mutate: (result) => ({ ...result, unit: 'points' }),
    code: 'unit-mismatch',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'a different model variant',
    mutate: (result) => ({ ...result, variantNote: 'Base checkpoint' }),
    code: 'variant-note-mismatch',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'a different harness',
    mutate: (result) => ({ ...result, harness: 'helm 1.0' }),
    code: 'harness-mismatch',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'a different reasoning mode',
    mutate: (result) => ({ ...result, reasoningMode: 'extended thinking' }),
    code: 'reasoning-mode-mismatch',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'tools switched on',
    mutate: (result) => ({ ...result, toolsEnabled: true }),
    code: 'tools-enabled-mismatch',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'a harness dropped from one side only',
    mutate: (result) => ({ ...result, harness: undefined }),
    code: 'harness-partially-disclosed',
    severity: 'blocking',
    verdict: 'not-comparable',
  },
  {
    name: 'an independent rather than official result',
    mutate: (result) => ({ ...result, resultType: 'independent' }),
    code: 'result-type-mismatch',
    severity: 'warning',
    verdict: 'partially-comparable',
  },
  {
    name: 'an evaluation date well outside the allowed window',
    mutate: (result) => ({ ...result, evaluationDate: '2027-06' }),
    code: 'evaluation-window-spread',
    severity: 'warning',
    verdict: 'partially-comparable',
  },
];

describe('every guard changes an assertion on its own', () => {
  it('starts from a baseline that no guard objects to', () => {
    // Without this, a mutation test proves nothing: a pair that was already
    // failing would go on failing whatever the mutation did.
    expect(codesOf([disclosedA, disclosedB])).toEqual([]);
    expect(assessComparability([disclosedA, disclosedB], context).verdict).toBe('comparable');
  });

  for (const mutation of MUTATIONS) {
    it(`reports ${mutation.code} for ${mutation.name}`, () => {
      const mutated = mutation.mutate(disclosedB);
      const assessment = assessComparability([disclosedA, mutated], context);

      // Exact equality, not `toContain`: it proves this mutation fired this one
      // guard and no other, so the test can tell the guards apart. A
      // `toContain` here would pass even if every guard fired at once.
      expect(assessment.findings.map((finding) => finding.code)).toEqual([mutation.code]);
      expect(assessment.findings[0]?.severity).toBe(mutation.severity);
      expect(assessment.verdict).toBe(mutation.verdict);
      expect(assessment.summary).toContain(assessment.findings[0]?.detail ?? '');
    });
  }

  it('names every distinct guard, so no two mutations share a reason', () => {
    const codes = MUTATIONS.map((mutation) => mutation.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// --- the four cases the issue names -----------------------------------------

describe('exact, partial, missing-context, and unrelated cases', () => {
  it('calls a fully disclosed identical setup comparable', () => {
    const assessment = assessComparability([disclosedA, disclosedB], context);

    expect(assessment.verdict).toBe('comparable');
    expect(assessment.summary).toContain('Comparable');
    expect(assessment.blockingFindings).toEqual([]);
    expect(assessment.warningFindings).toEqual([]);
  });

  it('calls a mixed-provenance but otherwise identical setup partially comparable', () => {
    const assessment = assessComparability(
      [disclosedA, { ...disclosedB, resultType: 'independent' }],
      context,
    );

    expect(assessment.verdict).toBe('partially-comparable');
    expect(assessment.warningFindings.map((finding) => finding.code)).toEqual([
      'result-type-mismatch',
    ]);
    expect(assessment.summary).toContain('Partially comparable');
  });

  it('turns missing context into an explicit warning rather than silence', () => {
    const assessment = assessComparability([silentA, silentB], context);

    expect(assessment.verdict).toBe('partially-comparable');
    for (const finding of assessment.findings) {
      expect(finding.state).toBe('unknown');
      expect(finding.detail).toContain('not disclosed');
      // The reason has to explain why the dimension matters, or a reader is
      // told only that something is missing and not why they should care.
      expect(finding.detail.length).toBeGreaterThan(40);
    }
  });

  it('refuses an unrelated benchmark outright and offers no shared scale', () => {
    const other: BenchmarkResult = { ...disclosedB, benchmarkId: 'other-bench' };
    const comparison = buildComparison([disclosedA, other], context);

    expect(comparison.assessment.verdict).toBe('not-comparable');
    expect(comparison.assessment.blockingFindings.map((finding) => finding.code)).toEqual([
      'benchmark-mismatch',
    ]);
    expect(comparison.displayRange).toBeNull();
    expect(comparison.direction).toBeNull();
    expect(comparison.results.map((view) => view.result.id)).toEqual(['fixture-a', 'fixture-b']);
  });

  it('gives a comparable set a range and refuses one to a blocked set', () => {
    expect(comparabilityRange([disclosedA, disclosedB], 'higher-is-better', 'comparable'))
      .toMatchObject({ min: 70, max: 82, confidence: 'explicit' });
    expect(comparabilityRange([disclosedA, disclosedB], 'higher-is-better', 'partially-comparable'))
      .toMatchObject({ confidence: 'provisional' });
    expect(comparabilityRange([disclosedA, disclosedB], 'higher-is-better', 'not-comparable'))
      .toBeNull();
    expect(comparabilityRange([], 'higher-is-better', 'comparable')).toBeNull();
  });
});

// --- metric direction -------------------------------------------------------

describe('metric direction', () => {
  const higher = [disclosedA, disclosedB];
  const lower: BenchmarkResult[] = [
    { ...disclosedA, id: 'latency-a', benchmarkId: 'fixture-latency', unit: 'seconds', score: 0.4 },
    { ...disclosedB, id: 'latency-b', benchmarkId: 'fixture-latency', unit: 'seconds', score: 1.1 },
  ];

  it('treats the largest score as best when higher is better', () => {
    const [group] = buildComparabilityGroups({ benchmarks, benchmarkResults: higher });

    expect(group?.direction).toBe('higher-is-better');
    expect(group?.results.map((view) => view.result.id)).toEqual(['fixture-b', 'fixture-a']);
    expect(group?.displayRange?.best).toBe(82);
    expect(group?.displayRange?.worst).toBe(70);
  });

  it('treats the smallest score as best when lower is better', () => {
    const [group] = buildComparabilityGroups({ benchmarks, benchmarkResults: lower });

    expect(group?.direction).toBe('lower-is-better');
    expect(group?.results.map((view) => view.result.id)).toEqual(['latency-a', 'latency-b']);
    expect(group?.displayRange?.best).toBe(0.4);
    expect(group?.displayRange?.worst).toBe(1.1);
  });

  it('normalises so that 1 is the best result under either direction', () => {
    const up = comparabilityRange(higher, 'higher-is-better', 'comparable')!;
    const down = comparabilityRange(lower, 'lower-is-better', 'comparable')!;

    expect(normalizeWithinGroup(up, 82)).toBe(1);
    expect(normalizeWithinGroup(up, 70)).toBe(0);
    expect(normalizeWithinGroup(down, 0.4)).toBe(1);
    expect(normalizeWithinGroup(down, 1.1)).toBe(0);
  });

  it('mutation: flipping only the direction reverses order and normalisation', () => {
    const asHigher = comparabilityRange(lower, 'higher-is-better', 'comparable')!;
    const asLower = comparabilityRange(lower, 'lower-is-better', 'comparable')!;

    expect(asHigher.best).toBe(1.1);
    expect(asLower.best).toBe(0.4);
    expect(normalizeWithinGroup(asHigher, 0.4)).toBe(0);
    expect(normalizeWithinGroup(asLower, 0.4)).toBe(1);
  });

  it('gives every member of a flat group the best position rather than dividing by zero', () => {
    const flat = [disclosedA, { ...disclosedB, score: 70 }];
    const range = comparabilityRange(flat, 'higher-is-better', 'comparable')!;

    expect(range.span).toBe(0);
    expect(normalizeWithinGroup(range, 70)).toBe(1);
  });

  it('never ranks across groups: groups come back keyed, not scored', () => {
    const mixed = [...higher, ...lower];
    const groups = buildComparabilityGroups({ benchmarks, benchmarkResults: mixed });
    const keys = groups.map((group) => group.key);

    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    // Each group scales against its own scores only; the 0.4-second result is
    // not placed below the 70-percent one by any output of this layer.
    for (const group of groups) {
      const scores = group.results.map((view) => view.score);
      expect(group.displayRange?.min).toBe(Math.min(...scores));
      expect(group.displayRange?.max).toBe(Math.max(...scores));
    }
  });
});

// --- date volatility --------------------------------------------------------

describe('evaluation date volatility', () => {
  it('stays quiet while dates sit inside the benchmark window', () => {
    expect(codesOf([disclosedA, { ...disclosedB, evaluationDate: '2026-09' }])).toEqual([]);
  });

  it('is benchmark-aware: the same spread trips a moving-target benchmark only', () => {
    const spreadMonths = 6;
    const stable = [
      { ...disclosedA, evaluationDate: '2026-01' },
      { ...disclosedB, evaluationDate: '2026-07' },
    ];
    const moving = stable.map((result) => ({
      ...result,
      benchmarkId: 'livecodebench',
    }));

    expect(evaluationWindow(stable, 12)?.spreadMonths).toBe(spreadMonths);
    expect(codesOf(stable)).toEqual([]);
    expect(codesOf(moving)).toEqual(['evaluation-window-spread']);
  });

  it('reads a year-only date as the whole year rather than as January', () => {
    const yearOnly = [
      { ...disclosedA, evaluationDate: '2026' },
      { ...disclosedB, evaluationDate: '2026' },
    ];

    // Both dates are "2026", yet the pair could be eleven months apart. The
    // window reports that honestly instead of collapsing to a zero spread.
    expect(evaluationWindow(yearOnly, 12)?.spreadMonths).toBe(11);
    expect(evaluationWindow(yearOnly, 12)?.isVolatile).toBe(false);
    expect(evaluationWindow(yearOnly, 3)?.isVolatile).toBe(true);
  });

  it('reports the window it measured alongside the tolerance it applied', () => {
    const window = evaluationWindow([disclosedA, { ...disclosedB, evaluationDate: '2027-06' }], 12)!;

    expect(window).toMatchObject({
      earliest: '2026-01',
      latest: '2027-06',
      spreadMonths: 17,
      allowedSpreadMonths: 12,
      isVolatile: true,
    });
  });

  it('skips the date rule entirely when the set does not agree on a benchmark', () => {
    const crossBenchmark = [
      disclosedA,
      { ...disclosedB, benchmarkId: 'other-bench', evaluationDate: '2029-01' },
    ];

    // A single benchmark's tolerance means nothing across two benchmarks, so
    // the only reason returned is the one that actually blocks.
    expect(codesOf(crossBenchmark)).toEqual(['benchmark-mismatch']);
  });

  it('returns no window for an empty set', () => {
    expect(evaluationWindow([], 12)).toBeNull();
  });
});

// --- grouping ---------------------------------------------------------------

describe('grouping keys', () => {
  it('keeps an undisclosed harness out of a disclosed harness group', () => {
    const withHarness = comparabilityGroupKey(disclosedA);
    const withoutHarness = comparabilityGroupKey({ ...disclosedA, harness: undefined });

    expect(withHarness).not.toBe(withoutHarness);
  });

  it('groups two equally silent results as candidates without calling them comparable', () => {
    const groups = buildComparabilityGroups({ benchmarks, benchmarkResults: [silentA, silentB] });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.results.map((view) => view.result.id)).toEqual(['silent-b', 'silent-a']);
    expect(groups[0]?.assessment.verdict).toBe('partially-comparable');
    expect(groups[0]?.displayRange?.confidence).toBe('provisional');
  });

  it('splits a blocking difference into separate groups', () => {
    const groups = buildComparabilityGroups({
      benchmarks,
      benchmarkResults: [disclosedA, { ...disclosedB, harness: 'helm 1.0' }],
    });

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.assessment.blockingFindings).toEqual([]);
      expect(group.results).toHaveLength(1);
    }
  });

  // Two different benchmarks can share a version string: in this repository
  // MMLU-Pro and MMMU are both recorded as "0-shot", in the same unit. They are
  // kept apart today only because their variant notes happen to differ, which
  // makes the benchmark component of the key look redundant against real data
  // while it is in fact the only thing that must hold. This fixture removes
  // that luck -- the two results differ in nothing but the benchmark -- so the
  // guard is proved rather than merely unexercised.
  it('keeps two benchmarks apart even when every other keyed field matches', () => {
    const twin: BenchmarkResult = { ...disclosedA, id: 'twin', benchmarkId: 'other-bench' };
    const groups = buildComparabilityGroups({
      benchmarks,
      benchmarkResults: [disclosedA, twin],
    });

    expect(comparabilityGroupKey(disclosedA)).not.toBe(comparabilityGroupKey(twin));
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.results.map((view) => view.result.id)).flat().sort())
      .toEqual(['fixture-a', 'twin']);
    // The pair must also be refused outright if a consumer compares them directly.
    expect(assessComparability([disclosedA, twin], context).verdict).toBe('not-comparable');
  });

  it('cannot be forged by a value that contains the key separator', () => {
    const left = comparabilityGroupKey({ ...disclosedA, benchmarkVersion: 'a', unit: 'b c' });
    const right = comparabilityGroupKey({ ...disclosedA, benchmarkVersion: 'a b', unit: 'c' });

    expect(left).not.toBe(right);
  });

  it('is deterministic under repetition and input order', () => {
    const results = [disclosedA, disclosedB, silentA, silentB];
    const first = buildComparabilityGroups({ benchmarks, benchmarkResults: results });
    const second = buildComparabilityGroups({ benchmarks, benchmarkResults: results });
    const reversed = buildComparabilityGroups({
      benchmarks,
      benchmarkResults: [...results].reverse(),
    });

    expect(second).toEqual(first);
    expect(reversed.map((group) => group.key)).toEqual(first.map((group) => group.key));
    expect(reversed.map((group) => group.assessment.verdict))
      .toEqual(first.map((group) => group.assessment.verdict));
  });

  it('publishes the policy version that produced each verdict', () => {
    const [group] = buildComparabilityGroups({ benchmarks, benchmarkResults: [disclosedA] });

    expect(group?.assessment.policyVersion).toBe(defaultComparabilityPolicy.version);
  });

  it('treats a lone fully disclosed result as comparable to anything matching it', () => {
    const [group] = buildComparabilityGroups({ benchmarks, benchmarkResults: [disclosedA] });

    expect(group?.assessment.verdict).toBe('comparable');
    expect(group?.displayRange).toMatchObject({ min: 70, max: 70, span: 0 });
  });
});

// --- accessible output ------------------------------------------------------

describe('accessible table output', () => {
  it('carries every result, spells out silence, and states the reasons', () => {
    const [group] = buildComparabilityGroups({
      benchmarks,
      benchmarkResults: [silentA, silentB],
      publishers,
      sources,
    });
    const table = buildGroupTable(group!);

    expect(table.rows.map((row) => row.resultId)).toEqual(['silent-b', 'silent-a']);
    expect(table.caption).toContain('Fixture Benchmark');
    expect(table.caption).toContain('Partially comparable');
    expect(table.notes).toEqual(group!.assessment.findings.map((finding) => finding.detail));
    expect(table.notes.length).toBeGreaterThan(0);

    for (const row of table.rows) {
      for (const column of table.columns) {
        expect(typeof row.cells[column.key], `${row.resultId}.${column.key}`).toBe('string');
        expect(row.cells[column.key]!.length).toBeGreaterThan(0);
      }
      expect(row.cells.harness).toBe(UNDISCLOSED_LABEL);
      expect(row.cells['reasoning-mode']).toBe(UNDISCLOSED_LABEL);
      expect(row.cells['tools-enabled']).toBe(UNDISCLOSED_LABEL);
      expect(row.cells.sources).toContain('Fixture Publisher');
    }
  });

  it('prints a disclosed setup verbatim rather than as a placeholder', () => {
    const [group] = buildComparabilityGroups({
      benchmarks,
      benchmarkResults: [disclosedA, disclosedB],
      publishers,
      sources,
    });
    const table = buildGroupTable(group!);

    for (const row of table.rows) {
      expect(row.cells.harness).toBe('lm-eval-harness 0.4.3');
      expect(row.cells['tools-enabled']).toBe('tools disabled');
      expect(row.cells['reasoning-mode']).toBe('standard');
    }
  });

  it('leads with the blocking reason when a comparison is refused', () => {
    const comparison = buildComparison(
      [disclosedA, { ...disclosedB, benchmarkId: 'other-bench' }],
      context,
    );
    const table = buildComparabilityTable({
      assessment: comparison.assessment,
      results: comparison.results,
    });

    expect(table.notes[0]).toContain('Benchmark differs');
    expect(table.caption).toContain('Not comparable');
  });

  it('exposes source, date, and caveat metadata for every result', () => {
    const [group] = buildComparabilityGroups({
      benchmarks,
      benchmarkResults: [disclosedA],
      publishers,
      sources,
    });
    const [view] = group!.results;

    expect(view?.sources[0]?.publisherName).toBe('Fixture Publisher');
    expect(view?.sources[0]?.source.url).toBe('https://example.com/fixture');
    expect(view?.evaluationDate).toBe('2026-01');
    expect(view?.caveats).toBe('Fixture record.');
    expect(view?.verifiedAt).toBe('2026-01-15');
  });

  it('reports no caveat as a stated absence rather than an empty cell', () => {
    const [group] = buildComparabilityGroups({
      benchmarks,
      benchmarkResults: [{ ...disclosedA, caveats: undefined }],
      publishers,
      sources,
    });

    expect(group?.results[0]?.caveats).toBeNull();
    expect(buildGroupTable(group!).rows[0]?.cells.caveats).toBe('None recorded');
  });
});

// --- the real corpus --------------------------------------------------------
//
// Fixtures prove the guards fire. These prove the layer survives contact with
// the data actually in the repository. Nothing here asserts a dataset size:
// another dock is adding benchmark data concurrently, so every expectation is
// either derived or anchored to a named record.

describe('the repository dataset', () => {
  const dataset = validateDataset(rawDataset);
  const groups = buildComparabilityGroups(dataset);
  const groupOf = (resultId: string) =>
    groups.find((group) => group.results.some((view) => view.result.id === resultId));

  it('puts one benchmark, one version, and one unit in each group', () => {
    for (const group of groups) {
      const ids = new Set(group.results.map((view) => view.result.benchmarkId));
      const versions = new Set(group.results.map((view) => view.result.benchmarkVersion));
      const units = new Set(group.results.map((view) => view.result.unit));

      expect(ids.size, group.key).toBe(1);
      expect(versions.size, group.key).toBe(1);
      expect(units.size, group.key).toBe(1);
    }
  });

  it('never leaves a blocking difference inside a group', () => {
    for (const group of groups) {
      expect(group.assessment.blockingFindings, group.key).toEqual([]);
      expect(group.assessment.verdict, group.key).not.toBe('not-comparable');
    }
  });

  // Derived rather than hardcoded, so incoming data cannot make it stale. At the
  // time of writing MMLU-Pro and MMMU both record "0-shot" in percent, which is
  // exactly the collision a version-keyed grouping would merge. If a later data
  // change removes every such pair this check becomes trivially true, which is
  // safe: the fixture test above holds the guarantee unconditionally.
  it('never merges two benchmarks that share a version and unit', () => {
    const byVersionAndUnit = new Map<string, Set<string>>();
    for (const result of dataset.benchmarkResults) {
      const axis = `${result.benchmarkVersion}\u0000${result.unit}`;
      const bucket = byVersionAndUnit.get(axis) ?? new Set<string>();
      bucket.add(result.benchmarkId);
      byVersionAndUnit.set(axis, bucket);
    }

    const collidingAxes = [...byVersionAndUnit.entries()].filter(([, ids]) => ids.size > 1);

    for (const [axis, ids] of collidingAxes) {
      const affected = dataset.benchmarkResults.filter(
        (result) => `${result.benchmarkVersion}\u0000${result.unit}` === axis,
      );
      for (const result of affected) {
        const group = groups.find((entry) =>
          entry.results.some((view) => view.result.id === result.id));
        const benchmarksInGroup = new Set(
          group?.results.map((view) => view.result.benchmarkId) ?? [],
        );
        expect(benchmarksInGroup.size, `${result.id} shares ${axis} with ${[...ids].join(', ')}`)
          .toBe(1);
      }
    }
  });

  it('accounts for every benchmark result exactly once', () => {
    const grouped = groups.flatMap((group) => group.results.map((view) => view.result.id)).sort();
    const expected = dataset.benchmarkResults.map((result) => result.id).sort();

    expect(grouped).toEqual(expected);
  });

  it('withholds the comparable verdict from the Llama 4 MMLU-Pro pair', () => {
    const group = groupOf('llama-4-scout-mmlu-pro');

    // Both results come from one model card under one version, and it would be
    // easy to read them as measured identically. Nothing in the record says so.
    expect(group?.results.map((view) => view.result.id)).toContain('llama-4-maverick-mmlu-pro');
    expect(group?.assessment.verdict).toBe('partially-comparable');
    expect(group?.assessment.findings.map((finding) => finding.code)).toEqual([
      'harness-undisclosed',
      'reasoning-mode-undisclosed',
      'tools-enabled-undisclosed',
    ]);
    expect(group?.displayRange?.confidence).toBe('provisional');
  });

  it('refuses a comparison drawn across two real benchmarks', () => {
    const scoutMmlu = dataset.benchmarkResults.find((r) => r.id === 'llama-4-scout-mmlu-pro')!;
    const scoutGpqa = dataset.benchmarkResults.find((r) => r.id === 'llama-4-scout-gpqa-diamond')!;
    const comparison = buildComparison([scoutMmlu, scoutGpqa], dataset);

    expect(comparison.assessment.verdict).toBe('not-comparable');
    expect(comparison.assessment.blockingFindings.map((f) => f.code)).toContain(
      'benchmark-mismatch',
    );
    expect(comparison.displayRange).toBeNull();
  });

  it('resolves each result to its release, benchmark, and cited sources', () => {
    const group = groupOf('llama-4-scout-mmlu-pro');
    const view = group?.results.find((entry) => entry.result.id === 'llama-4-scout-mmlu-pro');
    const release = dataset.releases.find((entry) => entry.id === 'meta-llama-4-scout');
    const benchmark = dataset.benchmarks.find((entry) => entry.id === 'mmlu-pro');

    expect(view?.releaseName).toBe(release?.displayName ?? release?.canonicalName);
    expect(view?.benchmarkName).toBe(benchmark?.name);
    expect(view?.sources.map((entry) => entry.source.id)).toContain(
      'meta-llama-4-model-card-github',
    );
    for (const entry of view?.sources ?? []) {
      expect(entry.publisherName.length).toBeGreaterThan(0);
    }
  });

  it('renders an accessible table for every group it produces', () => {
    for (const group of groups) {
      const table = buildGroupTable(group);

      expect(table.rows.map((row) => row.resultId))
        .toEqual(group.results.map((view) => view.result.id));
      expect(table.caption).toContain(group.benchmarkName);
      expect(table.notes).toEqual([
        ...group.assessment.blockingFindings.map((finding) => finding.detail),
        ...group.assessment.warningFindings.map((finding) => finding.detail),
      ]);
      for (const row of table.rows) {
        for (const column of table.columns) {
          expect(typeof row.cells[column.key], `${row.resultId}.${column.key}`).toBe('string');
        }
      }
    }
  });

  it('is deterministic over the real corpus', () => {
    expect(buildComparabilityGroups(dataset)).toEqual(groups);
    expect(
      buildComparabilityGroups({
        ...dataset,
        benchmarkResults: [...dataset.benchmarkResults].reverse(),
      }).map((group) => group.key),
    ).toEqual(groups.map((group) => group.key));
  });
});
