import { describe, expect, it } from 'vitest';
import { dataset as sourceDataset } from '../data/dataset';
import type { BenchmarkDefinition, BenchmarkResult, ModelRelease } from '../data/schema';
import {
  buildBenchmarkExplorerView,
  NO_FILTERS,
  type BenchmarkExplorerDataset,
} from './benchmark-explorer';

const BASE = '/ModelTree/';

type ModelCategory = ModelRelease['categories'][number];

// The refusal only appears when releases of different kinds are read together,
// and the shipped dataset records benchmark results for one creator's language
// models alone. So the branching is proven against a fixture, and the shipped
// data is asserted separately below for the properties it can actually answer.
function release(slug: string, id: string, displayName: string, categories: ModelCategory[]) {
  return {
    id,
    slug,
    canonicalName: `${displayName} (canonical)`,
    displayName,
    organizationId: 'org-a',
    familyId: 'fam-a',
    verifiedAt: '2026-08-10',
    categories,
  };
}

function benchmark(
  id: string,
  slug: string,
  name: string,
  appliesToCategories: ModelCategory[],
): BenchmarkDefinition {
  return {
    id,
    slug,
    name,
    domain: 'general-reasoning',
    owner: 'Bench Org',
    appliesToCategories,
    metric: 'Accuracy',
    metricUnit: 'percent',
    direction: 'higher-is-better',
    sourceIds: ['src-bench'],
    verifiedAt: '2026-08-01',
  };
}

function result(id: string, benchmarkId: string, releaseId: string, score: number): BenchmarkResult {
  return {
    id,
    benchmarkId,
    benchmarkVersion: '1.0',
    releaseId,
    variantNote: 'instruction-tuned',
    score,
    unit: 'percent',
    evaluationDate: '2026-02',
    reasoningMode: 'standard',
    toolsEnabled: false,
    harness: 'h1',
    resultType: 'official',
    sourceIds: ['src-a'],
    verifiedAt: '2026-08-05',
  };
}

function makeDataset(): BenchmarkExplorerDataset {
  return {
    releases: [
      release('alpha', 'alpha-r', 'Alpha One', ['language-reasoning', 'coding']),
      release('beta', 'beta-r', 'Beta Two', ['language-reasoning', 'coding']),
      release('pixel', 'pixel-r', 'Pixel One', ['image']),
      release('canvas', 'canvas-r', 'Canvas Two', ['image']),
    ],
    organizations: [{ id: 'org-a', name: 'Org A Laboratories', shortName: 'Org A' }],
    families: [{ id: 'fam-a', name: 'Family A' }],
    publishers: [{ id: 'pub-a', name: 'Publisher A' }],
    sources: [
      { id: 'src-bench', url: 'https://example.com/bench', title: 'Benchmark spec', publisherId: 'pub-a', lastCheckedDate: '2026-08-01' },
      { id: 'src-a', url: 'https://example.com/a', title: 'Alpha card', publisherId: 'pub-a', lastCheckedDate: '2026-08-02' },
    ],
    benchmarks: [
      benchmark('bench-gr', 'gr-bench', 'Reasoning Bench', ['language-reasoning', 'coding']),
    ],
    benchmarkResults: [
      result('alpha-gr', 'bench-gr', 'alpha-r', 90),
      result('beta-gr', 'bench-gr', 'beta-r', 85),
    ],
  };
}

const dataset = makeDataset();

function viewFor(slugs: string[]) {
  return buildBenchmarkExplorerView(dataset, slugs, NO_FILTERS, BASE);
}

describe('cross-category refusal', () => {
  it('refuses a comparison between models of different kinds', () => {
    const view = viewFor(['alpha', 'pixel']);
    expect(view.categoryRefusal).not.toBeNull();
    expect(view.categoryRefusal!.code).toBe('cross-category');
    // Both kinds are named, so the reader is told what the mismatch is rather
    // than only that there is one.
    expect(view.categoryRefusal!.categoryLabels).toContain('Image');
    expect(view.categoryRefusal!.categoryLabels).toContain('Language and reasoning');
  });

  it('says more evidence would not help, because that is the honest reason', () => {
    const view = viewFor(['alpha', 'pixel']);
    // The distinction this whole state exists for: a refusal is not a coverage
    // gap, and must not read as one.
    expect(view.categoryRefusal!.reason).toContain('would not change it');
  });

  it('distinguishes an uncovered kind from an incomparable pair', () => {
    const view = viewFor(['pixel', 'canvas']);
    expect(view.categoryRefusal).not.toBeNull();
    // Same kind of model, nothing recorded to measure them on. That is this
    // repository's coverage gap and it is not refused on principle.
    expect(view.categoryRefusal!.code).toBe('no-applicable-benchmark');
    expect(view.categoryRefusal!.categoryLabels).toEqual(['Image']);
    expect(view.categoryRefusal!.reason).toContain('gap');
  });

  it('does not refuse models that share an applicable benchmark', () => {
    const view = viewFor(['alpha', 'beta']);
    expect(view.categoryRefusal).toBeNull();
    expect(view.comparableGroups.length).toBeGreaterThan(0);
  });

  it('never refuses a single model, which is not a comparison', () => {
    expect(viewFor(['pixel']).categoryRefusal).toBeNull();
    expect(viewFor(['alpha']).categoryRefusal).toBeNull();
    expect(viewFor([]).categoryRefusal).toBeNull();
  });

  it('offers each model passport instead of an empty chart', () => {
    const view = viewFor(['alpha', 'pixel']);
    const labels = view.categoryRefusal!.nextActions.map((action) => action.label);
    expect(labels).toContain("Open Alpha One's passport");
    expect(labels).toContain("Open Pixel One's passport");
  });

  it('carries its meaning in words, not in colour or an icon alone', () => {
    for (const slugs of [['alpha', 'pixel'], ['pixel', 'canvas']]) {
      const refusal = viewFor(slugs).categoryRefusal!;
      expect(refusal.heading.length).toBeGreaterThan(0);
      expect(refusal.reason.length).toBeGreaterThan(0);
    }
  });

  it('replaces the generic comparability notice rather than doubling it', () => {
    const view = viewFor(['alpha', 'pixel']);
    // Two notices explaining the same silence in different words is worse than
    // one explaining it precisely.
    expect(view.comparabilityNotice).toBeNull();
  });
});

describe('shipped benchmark policy', () => {
  const benchmarkById = new Map(sourceDataset.benchmarks.map((entry) => [entry.id, entry]));
  const releaseById = new Map(sourceDataset.releases.map((entry) => [entry.id, entry]));

  it('declares an applicable category for every recorded benchmark', () => {
    for (const definition of sourceDataset.benchmarks) {
      expect(definition.appliesToCategories.length).toBeGreaterThan(0);
    }
  });

  it('keeps every recorded result consistent with the policy', () => {
    // A release's categories say what a model is *for*, never what it may be
    // *measured on* -- so this asserts the policy is wide enough for the data
    // that already exists, and nothing stronger. Widening a benchmark's
    // declared categories is the documented fix if this ever trips.
    for (const entry of sourceDataset.benchmarkResults) {
      const definition = benchmarkById.get(entry.benchmarkId);
      const release = releaseById.get(entry.releaseId);
      expect(definition, `benchmark for ${entry.id}`).toBeDefined();
      expect(release, `release for ${entry.id}`).toBeDefined();
      const shared = definition!.appliesToCategories
        .filter((category) => release!.categories.includes(category));
      expect(shared.length, `${entry.id} has no shared category`).toBeGreaterThan(0);
    }
  });

  it('keeps a general model measured on a coding benchmark valid', () => {
    // The case that disproves the tempting stricter rule. Llama 4 Scout is not
    // recorded as a coding model, and its LiveCodeBench result is legitimate
    // and sourced. If this ever fails, the rule has been tightened wrongly.
    const entry = sourceDataset.benchmarkResults.find((row) => row.id === 'llama-4-scout-livecodebench');
    expect(entry).toBeDefined();
    const release = releaseById.get(entry!.releaseId)!;
    expect(release.categories).not.toContain('coding');
    expect(benchmarkById.get(entry!.benchmarkId)!.appliesToCategories).toContain('language-reasoning');
  });
});
