import { describe, expect, it } from 'vitest';
import type { BenchmarkResult } from '../data/schema';
import {
  blockingDimensions,
  COMPARABILITY_DIMENSIONS,
  COMPARABILITY_POLICY_VERSION,
  defaultComparabilityPolicy,
  normalizeDisclosedValue,
  resolveEvaluationSpreadMonths,
} from './comparability-policy';

const baseResult: BenchmarkResult = {
  id: 'policy-fixture',
  benchmarkId: 'fixture-bench',
  benchmarkVersion: '0-shot',
  releaseId: 'fixture-release',
  score: 50,
  unit: 'percent',
  evaluationDate: '2026-01',
  resultType: 'official',
  sourceIds: ['fixture-source'],
  verifiedAt: '2026-01-15',
};

function dimension(id: string) {
  const found = COMPARABILITY_DIMENSIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no dimension ${id}`);
  return found;
}

describe('comparability policy shape', () => {
  it('carries a version that the default policy publishes', () => {
    expect(defaultComparabilityPolicy.version).toBe(COMPARABILITY_POLICY_VERSION);
    expect(COMPARABILITY_POLICY_VERSION.length).toBeGreaterThan(0);
  });

  it('declares each dimension once and gives every one a reader rationale', () => {
    const ids = COMPARABILITY_DIMENSIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of COMPARABILITY_DIMENSIONS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.rationale.length).toBeGreaterThan(0);
    }
  });

  it('names an owner and a rationale for every benchmark-specific exception', () => {
    const overrides = Object.entries(defaultComparabilityPolicy.benchmarkOverrides);
    // Issue #22 records unmaintainable, unowned exceptions as a risk. An
    // override with no owner is exactly that risk realised.
    for (const [benchmarkId, override] of overrides) {
      expect(override.owner.length, `${benchmarkId} owner`).toBeGreaterThan(0);
      expect(override.rationale.length, `${benchmarkId} rationale`).toBeGreaterThan(0);
    }
  });
});

describe('reading disclosed values', () => {
  // The reason this is its own test: a truthiness read would fold `false` into
  // `undefined`, turning a disclosed "tools were off" into silence. A tools-off
  // run would then be compared against a tools-on run under a warning instead
  // of being refused.
  it('treats tools disabled as a disclosure, not as silence', () => {
    const toolsDimension = dimension('tools-enabled');

    expect(toolsDimension.read({ ...baseResult, toolsEnabled: false })).toBe('tools disabled');
    expect(toolsDimension.read({ ...baseResult, toolsEnabled: true })).toBe('tools enabled');
    expect(toolsDimension.read(baseResult)).toBeUndefined();
  });

  it('returns undefined for every optional setup field the record omits', () => {
    expect(dimension('harness').read(baseResult)).toBeUndefined();
    expect(dimension('reasoning-mode').read(baseResult)).toBeUndefined();
    expect(dimension('variant-note').read(baseResult)).toBeUndefined();

    // Positive control: the same readers do return a value when one is present,
    // so an undefined above means "absent", not "the reader is broken".
    const disclosed = {
      ...baseResult,
      harness: 'lm-eval-harness',
      reasoningMode: 'standard',
      variantNote: 'Instruction-tuned',
    };
    expect(dimension('harness').read(disclosed)).toBe('lm-eval-harness');
    expect(dimension('reasoning-mode').read(disclosed)).toBe('standard');
    expect(dimension('variant-note').read(disclosed)).toBe('Instruction-tuned');
  });

  it('always resolves the identity dimensions the schema requires', () => {
    expect(dimension('benchmark').read(baseResult)).toBe('fixture-bench');
    expect(dimension('benchmark-version').read(baseResult)).toBe('0-shot');
    expect(dimension('unit').read(baseResult)).toBe('percent');
    expect(dimension('result-type').read(baseResult)).toBe('official');
  });
});

describe('severity assignment', () => {
  it('blocks on a disclosed setup difference and on asymmetric disclosure', () => {
    for (const id of ['variant-note', 'harness', 'reasoning-mode', 'tools-enabled']) {
      expect(dimension(id).onDifference, id).toBe('blocking');
      expect(dimension(id).onPartialDisclosure, id).toBe('blocking');
      expect(dimension(id).onUndisclosed, id).toBe('warning');
    }
  });

  it('only warns on mixed provenance, so official and independent stay comparable', () => {
    expect(dimension('result-type').onDifference).toBe('warning');
  });

  it('keeps warning-only dimensions out of the grouping key', () => {
    const blocking = blockingDimensions(defaultComparabilityPolicy).map((entry) => entry.id);

    expect(blocking).not.toContain('result-type');
    expect(blocking).toEqual([
      'benchmark',
      'benchmark-version',
      'unit',
      'variant-note',
      'harness',
      'reasoning-mode',
      'tools-enabled',
    ]);
  });
});

describe('evaluation spread policy', () => {
  it('falls back to the default window for a benchmark with no exception', () => {
    expect(resolveEvaluationSpreadMonths(defaultComparabilityPolicy, 'mmlu-pro')).toBe(
      defaultComparabilityPolicy.defaultEvaluationSpreadMonths,
    );
  });

  it('applies the tighter window a moving-target benchmark declares', () => {
    const override = resolveEvaluationSpreadMonths(defaultComparabilityPolicy, 'livecodebench');

    expect(override).toBe(3);
    expect(override).toBeLessThan(defaultComparabilityPolicy.defaultEvaluationSpreadMonths);
  });
});

describe('value normalisation', () => {
  it('ignores case and whitespace so formatting alone cannot split a group', () => {
    expect(normalizeDisclosedValue('  LM-Eval   Harness ')).toBe('lm-eval harness');
    expect(normalizeDisclosedValue('lm-eval harness')).toBe('lm-eval harness');
  });

  it('still separates values that genuinely differ', () => {
    expect(normalizeDisclosedValue('helm')).not.toBe(normalizeDisclosedValue('lm-eval-harness'));
  });
});
