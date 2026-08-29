import { describe, expect, it } from 'vitest';
import type { BenchmarkDefinition, BenchmarkResult } from '../data/schema';
import {
  buildBenchmarkExplorerPayload,
  buildBenchmarkExplorerView,
  EVIDENCE_MODELS_PARAMETER,
  evidenceHref,
  MAX_SELECTED_MODELS,
  measureBenchmarkExplorerPayload,
  NO_FILTERS,
  parseEvidenceSelection,
  readEvidenceFilters,
  readEvidenceModels,
  resolveEvidenceSelection,
  serializeEvidenceState,
  toggleModel,
  type BenchmarkExplorerDataset,
  type EvidenceFilters,
} from './benchmark-explorer';

const BASE = '/ModelTree/';

// A focused, source-free fixture. The states this view distinguishes only appear
// with several releases read together, and the real dataset covers a single
// creator's results, so the fixture is what the branching logic is proven
// against. It is deliberately not pinned to `src/data` counts.
function makeDataset(overrides: Partial<BenchmarkResult>[] = []): BenchmarkExplorerDataset {
  const benchmarks: BenchmarkDefinition[] = [
    {
      id: 'bench-gr',
      slug: 'gr-bench',
      name: 'Reasoning Bench',
      domain: 'general-reasoning',
      owner: 'Bench Org',
      metric: 'Accuracy',
      metricUnit: 'percent',
      direction: 'higher-is-better',
      sourceIds: ['src-bench'],
      verifiedAt: '2026-08-01',
    },
    {
      id: 'bench-code',
      slug: 'code-bench',
      name: 'Code Bench',
      domain: 'coding',
      owner: 'Bench Org',
      metric: 'pass@1',
      metricUnit: 'percent',
      direction: 'higher-is-better',
      sourceIds: ['src-bench'],
      verifiedAt: '2026-08-01',
    },
    {
      id: 'bench-math',
      slug: 'math-bench',
      name: 'Math Bench',
      domain: 'mathematics',
      owner: 'Bench Org',
      metric: 'Accuracy',
      metricUnit: 'percent',
      direction: 'higher-is-better',
      sourceIds: ['src-bench'],
      verifiedAt: '2026-08-01',
    },
  ];

  const base: BenchmarkResult[] = [
    result('alpha-gr', 'bench-gr', 'alpha-r', 90, 'h1'),
    result('beta-gr', 'bench-gr', 'beta-r', 85, 'h1'),
    result('delta-gr', 'bench-gr', 'delta-r', 80, 'h1'),
    result('alpha-code', 'bench-code', 'alpha-r', 70, 'hA'),
    result('beta-code', 'bench-code', 'beta-r', 72, 'hB'),
    result('gamma-math', 'bench-math', 'gamma-r', 60, 'h1'),
    result('pico-code', 'bench-code', 'pico-r', 50, 'hX'),
    result('nano-code', 'bench-code', 'nano-r', 55, 'hY'),
  ];

  const byId = new Map(base.map((entry) => [entry.id, entry]));
  for (const override of overrides) {
    const existing = byId.get(override.id ?? '');
    if (existing) byId.set(existing.id, { ...existing, ...override });
  }

  return {
    releases: [
      release('alpha', 'alpha-r', 'Alpha One'),
      release('beta', 'beta-r', 'Beta Two'),
      release('gamma', 'gamma-r', 'Gamma Three'),
      release('delta', 'delta-r', 'Delta Four'),
      release('epsilon', 'epsilon-r', 'Epsilon Five'),
      release('pico', 'pico-r', 'Pico Six'),
      release('nano', 'nano-r', 'Nano Seven'),
    ],
    organizations: [{ id: 'org-a', name: 'Org A' }],
    families: [{ id: 'fam-a', name: 'Family A' }],
    publishers: [{ id: 'pub-a', name: 'Publisher A' }],
    sources: [
      { id: 'src-bench', url: 'https://example.com/bench', title: 'Benchmark spec', publisherId: 'pub-a', lastCheckedDate: '2026-08-01' },
      { id: 'src-a', url: 'https://example.com/a', title: 'Alpha card', publisherId: 'pub-a', publishedDate: '2026-01-01', lastCheckedDate: '2026-08-02' },
      { id: 'src-unused', url: 'https://example.com/unused', title: 'Unused source', publisherId: 'pub-a', lastCheckedDate: '2026-08-02' },
    ],
    benchmarks,
    benchmarkResults: [...byId.values()],
  };
}

function release(slug: string, id: string, displayName: string) {
  return {
    id,
    slug,
    canonicalName: `${displayName} (canonical)`,
    displayName,
    organizationId: 'org-a',
    familyId: 'fam-a',
    verifiedAt: '2026-08-10',
  };
}

// Fully disclosed on every setup dimension, so a same-benchmark, same-harness
// pair clears the policy outright rather than only partially.
function result(
  id: string,
  benchmarkId: string,
  releaseId: string,
  score: number,
  harness: string,
): BenchmarkResult {
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
    harness,
    resultType: 'official',
    sourceIds: ['src-a'],
    verifiedAt: '2026-08-05',
  };
}

const dataset = makeDataset();

function viewFor(slugs: string[], filters: EvidenceFilters = NO_FILTERS) {
  return buildBenchmarkExplorerView(dataset, slugs, filters, BASE);
}

describe('URL state', () => {
  it('reads the shared models parameter', () => {
    expect(readEvidenceModels('?models=alpha,beta')).toEqual(['alpha', 'beta']);
    expect(readEvidenceModels('')).toEqual([]);
    // The parameter name is imported from the evidence actions, not retyped.
    expect(EVIDENCE_MODELS_PARAMETER).toBe('models');
  });

  it('drops an unknown domain but keeps a known one', () => {
    expect(readEvidenceFilters('?domain=coding').domain).toBe('coding');
    expect(readEvidenceFilters('?domain=not-a-domain').domain).toBeNull();
    expect(readEvidenceFilters('?benchmark=code-bench').benchmark).toBe('code-bench');
  });

  it('round-trips a state through serialize and read', () => {
    const filters: EvidenceFilters = { domain: 'coding', benchmark: 'code-bench' };
    const query = serializeEvidenceState(['alpha', 'beta'], filters);
    expect(query).toBe('?models=alpha,beta&domain=coding&benchmark=code-bench');
    expect(readEvidenceModels(query)).toEqual(['alpha', 'beta']);
    expect(readEvidenceFilters(query)).toEqual(filters);
  });

  it('serializes an empty state to a bare route and carries unrelated params', () => {
    expect(serializeEvidenceState([], NO_FILTERS)).toBe('');
    expect(serializeEvidenceState([], NO_FILTERS, '?ref=drawer')).toBe('?ref=drawer');
    expect(evidenceHref(BASE, [], NO_FILTERS)).toBe('/ModelTree/benchmarks/');
  });
});

describe('selection resolution', () => {
  const known = dataset.releases.map((entry) => entry.slug);

  it('accepts a single model — evidence has no minimum', () => {
    const selection = resolveEvidenceSelection(['alpha'], known);
    expect(selection.slugs).toEqual(['alpha']);
    expect(selection.rejections).toEqual([]);
  });

  it('reports unknown, duplicate, and over-capacity without crashing', () => {
    const requested = ['alpha', 'ghost', 'alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const selection = resolveEvidenceSelection(requested, known);
    expect(selection.slugs).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect(selection.slugs.length).toBe(MAX_SELECTED_MODELS);
    const codes = selection.rejections.map((rejection) => rejection.code);
    expect(codes).toContain('unknown-model');
    expect(codes).toContain('duplicate-model');
    expect(codes).toContain('over-capacity');
    // Every rejection names the slug it concerns, for a live-region announcement.
    for (const rejection of selection.rejections) {
      expect(rejection.message).toContain(rejection.slug);
    }
  });

  it('parses selection straight from a search string', () => {
    expect(parseEvidenceSelection('?models=alpha,ghost', known).slugs).toEqual(['alpha']);
  });

  it('toggles a model in and out and respects the ceiling', () => {
    expect(toggleModel(['alpha'], 'beta')).toEqual(['alpha', 'beta']);
    expect(toggleModel(['alpha', 'beta'], 'alpha')).toEqual(['beta']);
    const full = ['alpha', 'beta', 'gamma', 'delta'];
    expect(toggleModel(full, 'epsilon')).toEqual(full);
  });
});

describe('empty states', () => {
  it('prompts for a selection when none is given', () => {
    const view = viewFor([]);
    expect(view.emptyState?.code).toBe('no-selection');
    expect(view.groups).toHaveLength(0);
    expect(view.emptyState?.nextActions.length).toBeGreaterThan(0);
  });

  it('explains an absent record rather than showing a blank', () => {
    const view = viewFor(['epsilon']);
    expect(view.emptyState?.code).toBe('no-evidence');
    expect(view.emptyState?.reason).toContain('Epsilon Five');
    // A valid next action links to the model's own passport.
    const passport = view.emptyState?.nextActions.find((action) =>
      action.href === '/ModelTree/models/epsilon/',
    );
    expect(passport).toBeDefined();
  });

  it('offers a way back when filters match nothing', () => {
    const view = viewFor(['alpha'], { domain: 'mathematics', benchmark: null });
    expect(view.emptyState?.code).toBe('no-filter-match');
    expect(view.emptyState?.nextActions[0]?.href).toBe(view.clearFiltersHref);
  });
});

describe('direct evidence for one model', () => {
  const view = viewFor(['alpha']);

  it('shows every benchmark the model was measured on', () => {
    // Derived from the fixture, not pinned: alpha carries gr and code results.
    const benchmarkNames = view.groups.map((group) => group.benchmarkName).sort();
    expect(benchmarkNames).toEqual(['Code Bench', 'Reasoning Bench']);
    expect(view.groups.length).toBeGreaterThan(0);
    expect(view.hasComparableEvidence).toBe(false);
    expect(view.comparabilityNotice).toBeNull();
  });

  it('surfaces score, variant, date, sources and caveats on each result', () => {
    const gr = view.groups.find((group) => group.benchmarkSlug === 'gr-bench')!;
    const row = gr.results[0]!;
    expect(row.scoreLabel).toBe('90 percent');
    expect(row.variantNote).toBe('instruction-tuned');
    expect(row.evaluationDate).toBe('2026-02');
    expect(row.passportRoute).toBe('/ModelTree/models/alpha/');
    expect(row.sources.length).toBeGreaterThan(0);
    expect(row.verifiedAt).toBe('2026-08-05');
    // Every group carries an accessible table with a caption and scoped columns.
    expect(gr.table.caption.length).toBeGreaterThan(0);
    expect(gr.table.columns.map((column) => column.label)).toContain('Score');
  });
});

describe('comparable and incompatible fixtures', () => {
  it('groups two models on the same benchmark into one comparable group', () => {
    const view = viewFor(['alpha', 'beta']);
    const gr = view.comparableGroups.find((group) => group.benchmarkSlug === 'gr-bench');
    expect(gr).toBeDefined();
    expect(gr!.isCrossModel).toBe(true);
    expect(gr!.releaseCount).toBe(2);
    expect(gr!.verdict).toBe('comparable');
    expect(gr!.table.rows).toHaveLength(2);
    expect(view.hasComparableEvidence).toBe(true);
  });

  it('keeps a benchmark measured under different harnesses out of one group', () => {
    const view = viewFor(['alpha', 'beta']);
    const codeGroups = view.singleModelGroups.filter((group) => group.benchmarkSlug === 'code-bench');
    // Different harnesses split the two code results into two single-model groups.
    expect(codeGroups).toHaveLength(2);
    for (const group of codeGroups) {
      expect(group.isCrossModel).toBe(false);
      expect(group.releaseCount).toBe(1);
    }
  });

  it('is not a vacuous split — a matching harness makes the pair comparable', () => {
    // Mutate beta's code harness to match alpha's; the split must collapse.
    const matched = makeDataset([{ id: 'beta-code', harness: 'hA' }]);
    const view = buildBenchmarkExplorerView(matched, ['alpha', 'beta'], NO_FILTERS, BASE);
    const code = view.comparableGroups.find((group) => group.benchmarkSlug === 'code-bench');
    expect(code).toBeDefined();
    expect(code!.releaseCount).toBe(2);
  });
});

describe('no-comparable-evidence notice', () => {
  it('names an incompatible setup when the shared benchmark splits', () => {
    const view = viewFor(['pico', 'nano']);
    expect(view.hasComparableEvidence).toBe(false);
    expect(view.comparabilityNotice).not.toBeNull();
    expect(view.comparabilityNotice!.reason).toContain('Code Bench');
    // Direct evidence is still rendered, not hidden behind the notice.
    expect(view.groups.length).toBeGreaterThan(0);
    const compareAction = view.comparabilityNotice!.nextActions.find((action) =>
      action.href?.includes('/compare/'),
    );
    expect(compareAction).toBeDefined();
  });

  it('explains no benchmark in common when models never overlap', () => {
    const view = viewFor(['gamma', 'delta']);
    expect(view.hasComparableEvidence).toBe(false);
    expect(view.comparabilityNotice).not.toBeNull();
    expect(view.comparabilityNotice!.reason).toContain('share no benchmark');
  });

  it('stays silent once a comparable group exists', () => {
    const view = viewFor(['alpha', 'beta']);
    expect(view.hasComparableEvidence).toBe(true);
    expect(view.comparabilityNotice).toBeNull();
  });
});

describe('filters', () => {
  it('narrows groups to the chosen domain and offers only its benchmarks', () => {
    const view = viewFor(['alpha', 'beta'], { domain: 'coding', benchmark: null });
    expect(view.groups.every((group) => group.domain === 'coding')).toBe(true);
    expect(view.groups.length).toBeGreaterThan(0);
    // A domain filter leaves only benchmarks in that domain selectable.
    expect(view.benchmarkFacets.every((facet) => facet.value === 'code-bench')).toBe(true);
    expect(view.benchmarkFacets.length).toBeGreaterThan(0);
  });

  it('facets describe the whole selection, marking the active one', () => {
    const view = viewFor(['alpha', 'beta'], { domain: 'coding', benchmark: null });
    const domains = view.domainFacets.map((facet) => facet.value).sort();
    expect(domains).toEqual(['coding', 'general-reasoning']);
    const coding = view.domainFacets.find((facet) => facet.value === 'coding')!;
    expect(coding.active).toBe(true);
    // Toggling the active domain clears it, so its href carries no domain filter.
    expect(coding.href).not.toContain('domain=');
    // An inactive domain's href sets that filter.
    const reasoning = view.domainFacets.find((facet) => facet.value === 'general-reasoning')!;
    expect(reasoning.active).toBe(false);
    expect(reasoning.href).toContain('domain=general-reasoning');
  });

  it('drops a stale benchmark slug rather than emptying the view', () => {
    const view = viewFor(['alpha'], { domain: null, benchmark: 'ghost-bench' });
    expect(view.filters.benchmark).toBeNull();
    expect(view.groups.length).toBeGreaterThan(0);
  });
});

describe('payload', () => {
  it('keeps only cited sources and reports its weight', () => {
    const payload = buildBenchmarkExplorerPayload(dataset);
    const ids = payload.sources.map((source) => source.id);
    expect(ids).toContain('src-bench');
    expect(ids).toContain('src-a');
    expect(ids).not.toContain('src-unused');
    const measured = measureBenchmarkExplorerPayload(payload);
    expect(measured.resultCount).toBe(dataset.benchmarkResults.length);
    expect(measured.totalBytes).toBeGreaterThan(0);
  });
});
