import { describe, expect, it } from 'vitest';

import { dataset } from '../data/dataset';
import {
  COMPARE_QUERY_PARAMETER,
  COMPARISON_GROUP_ORDER,
  MAX_COMPARISON_MODELS,
  MIN_COMPARISON_MODELS,
  NO_RANKING_NOTE,
  VALUE_STATE_DEFINITIONS,
  addToComparison,
  buildComparisonCandidates,
  buildComparisonPayload,
  buildComparisonPickerIndex,
  buildModelComparison,
  compareRoute,
  compareUrl,
  measureComparisonPayload,
  parseComparisonSelection,
  removeFromComparison,
  resolveComparisonSelection,
  serializeComparisonSelection,
  type ComparisonCell,
  type ComparisonDataset,
  type ComparisonView,
} from './comparison';
import {
  defaultComparabilityPolicy,
  resolveEvaluationSpreadMonths,
} from './comparability-policy';
import {
  ATLAS_EXTRA,
  ATLAS_MINI,
  ATLAS_OPEN,
  ATLAS_PRO,
  BLOCKED_BENCHMARK,
  BOREALIS_AIR,
  COMPARABLE_BENCHMARK,
  COMPARISON_BASE,
  COMPARISON_TODAY,
  comparisonFixtures,
  comparisonFixturesWithoutOperations,
} from '../../tests/fixtures/comparison-dataset';

const knownSlugs = comparisonFixtures.releases.map((release) => release.slug);

function build(slugs: string[], data = comparisonFixtures) {
  return buildModelComparison(data, slugs, COMPARISON_BASE, COMPARISON_TODAY);
}

function allCells(view: ComparisonView): ComparisonCell[] {
  return view.groups.flatMap((group) => group.rows.flatMap((row) => row.cells));
}

function rowOf(view: ComparisonView, id: string) {
  const row = view.groups.flatMap((group) => group.rows).find((entry) => entry.id === id);
  if (!row) throw new Error(`no row "${id}" in this comparison`);
  return row;
}

function groupOf(view: ComparisonView, id: string) {
  const group = view.groups.find((entry) => entry.id === id);
  if (!group) throw new Error(`no group "${id}" in this comparison`);
  return group;
}

// ---------------------------------------------------------------------------
// Selection: "selection order and copied URL restore deterministically" and
// "duplicate, unknown, and over-capacity selections are rejected with a reason".
// ---------------------------------------------------------------------------

describe('comparison selection', () => {
  it('round-trips a selection through the URL in the order it was made', () => {
    const chosen = [BOREALIS_AIR, ATLAS_PRO, ATLAS_OPEN];
    const restored = parseComparisonSelection(
      serializeComparisonSelection(chosen),
      knownSlugs,
    );

    expect(restored.slugs).toEqual(chosen);
  });

  it('treats a different selection order as a different URL and a different result', () => {
    const forward = [ATLAS_PRO, BOREALIS_AIR];
    const reverse = [BOREALIS_AIR, ATLAS_PRO];

    expect(serializeComparisonSelection(forward)).not.toBe(serializeComparisonSelection(reverse));
    expect(parseComparisonSelection(serializeComparisonSelection(reverse), knownSlugs).slugs)
      .toEqual(reverse);
  });

  it('serialises an empty selection to no query string at all', () => {
    expect(serializeComparisonSelection([])).toBe('');
    expect(compareUrl(COMPARISON_BASE, [])).toBe(`${COMPARISON_BASE}compare/`);
  });

  it('carries the selection in one ordered parameter', () => {
    const url = compareUrl(COMPARISON_BASE, [ATLAS_PRO, BOREALIS_AIR]);
    const params = new URLSearchParams(url.slice(url.indexOf('?')));

    expect(params.getAll(COMPARE_QUERY_PARAMETER)).toHaveLength(1);
    expect(params.get(COMPARE_QUERY_PARAMETER)).toBe(`${ATLAS_PRO},${BOREALIS_AIR}`);
  });

  it('rejects an unknown slug and names it in the reason', () => {
    const selection = resolveComparisonSelection([ATLAS_PRO, 'no-such-model'], knownSlugs);

    expect(selection.slugs).toEqual([ATLAS_PRO]);
    expect(selection.rejections).toHaveLength(1);
    expect(selection.rejections[0]!.code).toBe('unknown-model');
    expect(selection.rejections[0]!.slug).toBe('no-such-model');
    expect(selection.rejections[0]!.message).toContain('no-such-model');
  });

  it('rejects a repeated slug and names it in the reason', () => {
    const selection = resolveComparisonSelection([ATLAS_PRO, BOREALIS_AIR, ATLAS_PRO], knownSlugs);

    expect(selection.slugs).toEqual([ATLAS_PRO, BOREALIS_AIR]);
    expect(selection.rejections.map((entry) => entry.code)).toEqual(['duplicate-model']);
    expect(selection.rejections[0]!.message).toContain(ATLAS_PRO);
  });

  it('rejects the fifth model and names the ceiling in the reason', () => {
    const selection = resolveComparisonSelection(
      [ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN, ATLAS_EXTRA],
      knownSlugs,
    );

    expect(selection.slugs).toHaveLength(MAX_COMPARISON_MODELS);
    expect(selection.slugs).not.toContain(ATLAS_EXTRA);
    expect(selection.rejections.map((entry) => entry.code)).toEqual(['over-capacity']);
    expect(selection.rejections[0]!.message).toContain(String(MAX_COMPARISON_MODELS));
    expect(selection.isFull).toBe(true);
  });

  it('reports an unknown slug as unknown even when it is also repeated', () => {
    const selection = resolveComparisonSelection(
      [ATLAS_PRO, 'ghost-model', 'ghost-model'],
      knownSlugs,
    );

    expect(selection.rejections.map((entry) => entry.code)).toEqual([
      'unknown-model',
      'unknown-model',
    ]);
  });

  it('spends capacity only on slugs that would otherwise render', () => {
    // Two typos ahead of three real models: capacity must not be consumed by
    // entries that were never going to produce a column.
    const selection = resolveComparisonSelection(
      ['typo-one', 'typo-two', ATLAS_PRO, BOREALIS_AIR, ATLAS_OPEN],
      knownSlugs,
    );

    expect(selection.slugs).toEqual([ATLAS_PRO, BOREALIS_AIR, ATLAS_OPEN]);
  });

  it('reports how many more models a comparison still needs', () => {
    expect(resolveComparisonSelection([ATLAS_PRO], knownSlugs).isComparable).toBe(false);
    expect(resolveComparisonSelection([ATLAS_PRO], knownSlugs).shortfall)
      .toBe(MIN_COMPARISON_MODELS - 1);
    expect(resolveComparisonSelection([ATLAS_PRO, ATLAS_OPEN], knownSlugs).isComparable).toBe(true);
  });

  it('adds to the end of the selection and refuses a fifth with a reason', () => {
    const added = addToComparison([ATLAS_PRO], BOREALIS_AIR);
    expect(added.slugs).toEqual([ATLAS_PRO, BOREALIS_AIR]);
    expect(added.rejection).toBeNull();

    const full = [ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN];
    const refused = addToComparison(full, ATLAS_EXTRA);
    expect(refused.slugs).toEqual(full);
    expect(refused.rejection?.code).toBe('over-capacity');
    expect(refused.rejection?.slug).toBe(ATLAS_EXTRA);
  });

  it('removes a model without disturbing the order of the rest', () => {
    expect(removeFromComparison([ATLAS_PRO, BOREALIS_AIR, ATLAS_OPEN], BOREALIS_AIR))
      .toEqual([ATLAS_PRO, ATLAS_OPEN]);
  });

  it('builds every URL from the configured base path', () => {
    const candidates = buildComparisonCandidates(comparisonFixtures, [ATLAS_PRO], COMPARISON_BASE);
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const urls = [
      compareRoute(COMPARISON_BASE),
      ...candidates.map((candidate) => candidate.toggleUrl),
      ...view.models.flatMap((model) => [model.route, model.removeUrl]),
    ];

    expect(urls).not.toHaveLength(0);
    for (const url of urls) expect(url.startsWith(COMPARISON_BASE)).toBe(true);
  });

  it('offers a removal link for a selected model and an addition link for the rest', () => {
    const candidates = buildComparisonCandidates(comparisonFixtures, [ATLAS_PRO], COMPARISON_BASE);
    const selected = candidates.find((candidate) => candidate.slug === ATLAS_PRO)!;
    const other = candidates.find((candidate) => candidate.slug === BOREALIS_AIR)!;

    expect(selected.selected).toBe(true);
    expect(selected.toggleLabel).toContain('Remove');
    expect(selected.toggleUrl).toBe(`${COMPARISON_BASE}compare/`);
    expect(other.toggleLabel).toContain('Add');
    expect(parseComparisonSelection(other.toggleUrl.slice(other.toggleUrl.indexOf('?')), knownSlugs).slugs)
      .toEqual([ATLAS_PRO, BOREALIS_AIR]);
  });
});

// ---------------------------------------------------------------------------
// Column order. Structural proof that the table cannot become a leaderboard.
// ---------------------------------------------------------------------------

describe('comparison ordering', () => {
  it('orders columns by the reader\u2019s selection, never by any value', () => {
    // Atlas Pro outscores Borealis Air on the comparable benchmark, so a table
    // that ranked would put it first either way.
    const forward = build([ATLAS_PRO, BOREALIS_AIR]);
    const reverse = build([BOREALIS_AIR, ATLAS_PRO]);

    expect(forward.models.map((model) => model.slug)).toEqual([ATLAS_PRO, BOREALIS_AIR]);
    expect(reverse.models.map((model) => model.slug)).toEqual([BOREALIS_AIR, ATLAS_PRO]);
  });

  it('keeps every row\u2019s cells in the same order as the columns', () => {
    const view = build([BOREALIS_AIR, ATLAS_OPEN, ATLAS_PRO]);
    const columns = view.models.map((model) => model.slug);

    for (const group of view.groups) {
      for (const row of group.rows) {
        expect(row.cells.map((cell) => cell.slug)).toEqual(columns);
      }
    }
  });

  it('keeps benchmark cells in selection order even though the source orders by score', () => {
    const reverse = build([BOREALIS_AIR, ATLAS_PRO]);
    const row = rowOf(reverse, `benchmark-${COMPARABLE_BENCHMARK}`);

    expect(row.cells.map((cell) => cell.slug)).toEqual([BOREALIS_AIR, ATLAS_PRO]);
    expect(row.cells[0]!.value).toContain('81.5');
  });

  it('presents groups in the documented order', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    expect(view.groups.map((group) => group.id)).toEqual([...COMPARISON_GROUP_ORDER]);
  });
});

// ---------------------------------------------------------------------------
// AC: "every volatile value exposes effective or verification date and source".
// Asserted over every cell at once rather than row by row, so a row added later
// is covered without anyone remembering to extend this test.
// ---------------------------------------------------------------------------

describe('comparison evidence', () => {
  const datasets = [
    ['populated fixtures', comparisonFixtures] as const,
    ['fixtures with no operational records', comparisonFixturesWithoutOperations] as const,
  ];

  for (const [name, data] of datasets) {
    it(`states a date and a source for every recorded value (${name})`, () => {
      const view = build([ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN], data);
      const statedCells = allCells(view).filter((cell) => cell.state === 'stated');

      expect(statedCells.length).toBeGreaterThan(0);
      for (const cell of statedCells) {
        expect(cell.verifiedAt, `${cell.slug} cell "${cell.value}"`).toBeTruthy();
        expect(cell.sources.length, `${cell.slug} cell "${cell.value}"`).toBeGreaterThan(0);
      }
    });

    it(`never renders an empty cell (${name})`, () => {
      const view = build([ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN], data);
      for (const cell of allCells(view)) expect(cell.value.trim()).not.toBe('');
    });

    it(`gives a reason for every value it does not state (${name})`, () => {
      const view = build([ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN], data);
      const absentCells = allCells(view).filter((cell) => cell.state !== 'stated');

      expect(absentCells.length).toBeGreaterThan(0);
      for (const cell of absentCells) {
        expect(cell.reason, `${cell.slug} ${cell.state}`).toBeTruthy();
      }
    });
  }

  it('stamps each column with the release record\u2019s own verification date', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    for (const model of view.models) {
      expect(model.verifiedAt).toBeTruthy();
      expect(model.sources.length).toBeGreaterThan(0);
    }
  });

  it('carries the effective range on a priced cell, not just a date', () => {
    const view = build([ATLAS_PRO, ATLAS_OPEN]);
    const row = rowOf(view, 'pricing-eastwind-api-per-1m-tokens-input');
    const priced = row.cells.find((cell) => cell.slug === ATLAS_PRO)!;

    expect(priced.state).toBe('stated');
    expect(priced.effectiveRange).toBeTruthy();
  });

  it('shows the current price rather than a superseded one', () => {
    const view = build([ATLAS_PRO, ATLAS_OPEN]);
    const row = rowOf(view, 'pricing-eastwind-api-per-1m-tokens-input');
    const priced = row.cells.find((cell) => cell.slug === ATLAS_PRO)!;

    expect(priced.value).toContain('0.35');
    expect(priced.value).not.toContain('0.5');
  });
});

// ---------------------------------------------------------------------------
// AC: "distinguish missing, unknown, unavailable, and non-comparable values".
// Each state is reached by a separate route and none stands in for another.
// ---------------------------------------------------------------------------

describe('comparison value states', () => {
  it('marks a field the record does not state as unrecorded, not as absent data', () => {
    const view = build([ATLAS_MINI, ATLAS_PRO]);
    const row = rowOf(view, 'context-window');
    const mini = row.cells.find((cell) => cell.slug === ATLAS_MINI)!;

    expect(mini.state).toBe('unrecorded');
    expect(row.cells.find((cell) => cell.slug === ATLAS_PRO)!.state).toBe('stated');
  });

  it('does not imply a creator withheld a value ModelTree merely has not reviewed', () => {
    // The wording is the whole point of the state, so it is asserted rather than
    // left to a reviewer to notice.
    expect(VALUE_STATE_DEFINITIONS.unrecorded).toContain('does not distinguish');
  });

  it('marks a licence row on a hosted-only release as not applicable', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const row = rowOf(view, 'licence');
    const hosted = row.cells.find((cell) => cell.slug === BOREALIS_AIR)!;

    expect(hosted.state).toBe('not-applicable');
    expect(hosted.reason).toContain('downloadable weights');
    expect(row.cells.find((cell) => cell.slug === ATLAS_PRO)!.state).toBe('stated');
  });

  it('marks a whole group as not collected when the dataset holds no such records', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR], comparisonFixturesWithoutOperations);
    const pricing = groupOf(view, 'pricing');
    const availability = groupOf(view, 'availability');

    expect(pricing.rows).toHaveLength(0);
    expect(pricing.absence?.state).toBe('not-collected');
    expect(pricing.absence?.reason).toContain('no pricing records for any release');
    expect(pricing.absence?.reason).toContain('not a claim');
    expect(availability.absence?.state).toBe('not-collected');
    expect(availability.absence?.reason).toContain('no deployment records for any release');
    expect(availability.absence?.reason).toContain('not a claim');
  });

  it('separates "we hold none of these records" from "none covers these models"', () => {
    const notCollected = build([ATLAS_PRO, BOREALIS_AIR], comparisonFixturesWithoutOperations);
    // Atlas Mini and Atlas Extra have no deployment, so pricing records exist in
    // the dataset but none reaches this pair.
    const unrecorded = build([ATLAS_MINI, ATLAS_EXTRA]);

    expect(groupOf(notCollected, 'pricing').absence?.state).toBe('not-collected');
    expect(groupOf(unrecorded, 'pricing').absence?.state).toBe('unrecorded');
    expect(groupOf(unrecorded, 'pricing').absence?.reason).toContain('Atlas Mini');
  });

  it('refuses to compare prices published in different currencies, and shows both', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const row = rowOf(view, 'pricing-eastwind-api-per-1m-tokens-input');

    expect(row.cells.map((cell) => cell.state)).toEqual(['not-comparable', 'not-comparable']);
    expect(row.cells[0]!.value).toContain('USD');
    expect(row.cells[1]!.value).toContain('EUR');
    for (const cell of row.cells) expect(cell.reason).toContain('does not convert');
  });

  it('still compares prices that share a currency', () => {
    const view = build([ATLAS_PRO, ATLAS_OPEN]);
    const row = rowOf(view, 'pricing-eastwind-api-per-1m-tokens-input');

    expect(row.cells.find((cell) => cell.slug === ATLAS_PRO)!.state).toBe('stated');
  });

  it('keeps a platform row that serves only one model, showing the gap', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const row = rowOf(view, 'availability-eastwind-hub');

    expect(row.cells.find((cell) => cell.slug === ATLAS_PRO)!.state).toBe('stated');
    const missing = row.cells.find((cell) => cell.slug === BOREALIS_AIR)!;
    expect(missing.state).toBe('unrecorded');
    expect(missing.reason).toContain('not a claim that it is unavailable');
  });

  it('defines on the page every state it actually uses', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN]);
    const used = new Set(allCells(view).map((cell) => cell.state));

    expect(view.valueStateLegend.map((entry) => entry.state).sort()).toEqual([...used].sort());
    for (const entry of view.valueStateLegend) expect(entry.definition.length).toBeGreaterThan(40);
  });

  it('reaches all five states in one comparison', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN]);
    expect(view.usedStates.sort()).toEqual(
      ['not-applicable', 'not-comparable', 'stated', 'unrecorded'].sort(),
    );

    // `not-collected` is a property of the dataset rather than of a cell, so it
    // is reached through a group absence instead.
    const empty = build([ATLAS_PRO, BOREALIS_AIR], comparisonFixturesWithoutOperations);
    expect(empty.absentGroups.map((group) => group.absence?.state)).toContain('not-collected');
  });
});

// ---------------------------------------------------------------------------
// AC: "benchmark rows use the comparability transformation".
// ---------------------------------------------------------------------------

describe('comparison benchmark rows', () => {
  it('passes results through the comparability policy and records its verdict', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const row = rowOf(view, `benchmark-${COMPARABLE_BENCHMARK}`);

    expect(row.evidence?.verdict).toBe('comparable');
    expect(row.evidence?.policyVersion).toBeTruthy();
    expect(row.cells.map((cell) => cell.state)).toEqual(['stated', 'stated']);
  });

  it('marks a row the policy blocks rather than dropping or silently showing it', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const row = rowOf(view, `benchmark-${BLOCKED_BENCHMARK}`);

    expect(row.evidence?.verdict).toBe('not-comparable');
    expect(row.cells.map((cell) => cell.state)).toEqual(['not-comparable', 'not-comparable']);
    // Both published figures are still shown; it is the reading across them that
    // is refused, not the record.
    expect(row.cells[0]!.value).toContain('74');
    expect(row.cells[1]!.value).toContain('79');
    for (const cell of row.cells) expect(cell.reason).toBeTruthy();
    expect(row.evidence?.notes.length).toBeGreaterThan(0);
  });

  it('attributes direction to the benchmark rather than to ModelTree', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const row = rowOf(view, `benchmark-${COMPARABLE_BENCHMARK}`);

    expect(row.evidence?.directionNote).toContain('own definition');
    expect(row.evidence?.directionNote).toContain('adds no ranking');
  });

  it('carries the disclosed setup on each benchmark cell', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const row = rowOf(view, `benchmark-${BLOCKED_BENCHMARK}`);

    expect(row.cells[0]!.setup).toContain('northwind-eval 0.4');
    expect(row.cells[1]!.setup).toContain('eastwind-runner 2.1');
  });

  it('reports the evaluation window the policy allows for the benchmark', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const window = rowOf(view, `benchmark-${COMPARABLE_BENCHMARK}`).evidence?.evaluationWindow;

    // Bound to the policy rather than reciting its number. The window is #22's
    // to set in `comparability-policy.ts`, so a literal here would turn a
    // legitimate policy change into a failure in this file; resolving it through
    // the policy's own helper also means a per-benchmark override is honoured.
    const allowed = resolveEvaluationSpreadMonths(defaultComparabilityPolicy, COMPARABLE_BENCHMARK);
    expect(allowed, 'the policy must resolve a real window for this to assert anything').toBeGreaterThan(0);

    expect(window?.allowedSpreadMonths).toBe(allowed);
    expect(window?.earliest).toBe('2026-02-15');
  });

  it('marks a model with no result on a benchmark as unrecorded, not as zero', () => {
    const view = build([ATLAS_PRO, ATLAS_MINI]);
    const row = rowOf(view, `benchmark-${COMPARABLE_BENCHMARK}`);
    const missing = row.cells.find((cell) => cell.slug === ATLAS_MINI)!;

    expect(missing.state).toBe('unrecorded');
    expect(missing.value).not.toContain('0');
  });

  it('names the absence when no result covers any selected model', () => {
    const view = build([ATLAS_MINI, ATLAS_OPEN]);
    const group = groupOf(view, 'evidence');

    expect(group.rows).toHaveLength(0);
    expect(group.absence?.reason).toContain('No reviewed benchmark result');
  });
});

// ---------------------------------------------------------------------------
// AC: "source-backed use-case takeaways, only when rule-based evidence supports
// them" plus the non-goals: no winner, no composite score, no ranking.
// ---------------------------------------------------------------------------

describe('comparison takeaways', () => {
  it('withholds a takeaway when any selected model leaves the attribute unstated', () => {
    // Atlas Mini records no context window, so the rule that reads it cannot
    // fire, however large the difference between the models that do state one.
    const withMini = build([ATLAS_PRO, ATLAS_MINI]);
    const withoutMini = build([ATLAS_PRO, ATLAS_OPEN]);

    expect(rowOf(withMini, 'context-window').fullyStated).toBe(false);
    expect(withMini.takeaways.map((entry) => entry.rule)).not.toContain('context-window');
    expect(withoutMini.takeaways.map((entry) => entry.rule)).toContain('context-window');
  });

  it('never emits a takeaway whose basis row is not fully stated', () => {
    for (const slugs of [
      [ATLAS_PRO, BOREALIS_AIR],
      [ATLAS_PRO, ATLAS_MINI],
      [ATLAS_PRO, BOREALIS_AIR, ATLAS_MINI, ATLAS_OPEN],
      [ATLAS_MINI, ATLAS_EXTRA],
    ]) {
      const view = build(slugs);
      for (const takeaway of view.takeaways) {
        const row = rowOf(view, takeaway.basisRowId);
        // A benchmark row is the one exception: its rule fires *because* the row
        // is not comparable, which is itself an evidence-backed observation.
        if (takeaway.rule === 'benchmark-not-comparable') {
          expect(row.evidence?.verdict).toBe('not-comparable');
        } else {
          expect(row.fullyStated, `${takeaway.rule} on ${slugs.join('+')}`).toBe(true);
          expect(row.differs, `${takeaway.rule} on ${slugs.join('+')}`).toBe(true);
        }
      }
    }
  });

  it('points every takeaway at a row the reader can check and at its sources', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);

    expect(view.takeaways.length).toBeGreaterThan(0);
    for (const takeaway of view.takeaways) {
      expect(() => rowOf(view, takeaway.basisRowId)).not.toThrow();
      expect(takeaway.sources.length).toBeGreaterThan(0);
    }
  });

  it('emits no takeaway at all when nothing distinguishes the models', () => {
    const identical = build([ATLAS_MINI, ATLAS_EXTRA]);
    // Both are hosted-only text models with no benchmark result. Atlas Mini
    // records no context window, so even the limits rule has nothing to read.
    expect(identical.takeaways).toEqual([]);
  });

  it('reports a difference in access without recommending either side', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const takeaway = view.takeaways.find((entry) => entry.rule === 'self-hosting');

    expect(takeaway).toBeDefined();
    expect(takeaway!.detail).toContain('Atlas Pro');
    expect(takeaway!.detail).toContain('Borealis Air');
    expect(takeaway!.detail).toContain('neither implies the other');
  });

  it('reports a blocked benchmark as a takeaway about the evidence, not the models', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);
    const takeaway = view.takeaways.find((entry) => entry.rule === 'benchmark-not-comparable');

    expect(takeaway).toBeDefined();
    expect(takeaway!.detail).toContain('not evidence about the models');
  });

  it('publishes the no-ranking commitment with every comparison', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR]);

    expect(view.noRankingNote).toBe(NO_RANKING_NOTE);
    expect(view.noRankingNote).toContain('no overall winner');
    expect(view.noRankingNote).toContain('no composite score');
  });

  it('exposes no aggregate score anywhere in the view', () => {
    const view = build([ATLAS_PRO, BOREALIS_AIR, ATLAS_OPEN]);
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    walk(view);

    for (const banned of ['overallScore', 'compositeScore', 'rank', 'ranking', 'winner', 'total']) {
      expect(keys.has(banned), `view exposes "${banned}"`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC: "sparse comparisons remain readable and honest". Run against the shipped
// dataset, where absence is the main path rather than an edge case.
// ---------------------------------------------------------------------------

describe('comparison over the shipped dataset', () => {
  const seedSlugs = dataset.releases.map((release) => release.slug);
  const seedBase = '/ModelTree/';
  const today = '2026-08-27';

  const buildSeed = (slugs: string[]) => buildModelComparison(dataset, slugs, seedBase, today);

  it('compares every adjacent pair of real releases without throwing', () => {
    expect(seedSlugs.length).toBeGreaterThanOrEqual(2);
    for (let index = 0; index + 1 < seedSlugs.length; index += 1) {
      expect(() => buildSeed([seedSlugs[index]!, seedSlugs[index + 1]!])).not.toThrow();
    }
  });

  it('states a date and a source for every value it states, across every real pair', () => {
    let statedTotal = 0;
    for (let index = 0; index + 1 < seedSlugs.length; index += 1) {
      const view = buildSeed([seedSlugs[index]!, seedSlugs[index + 1]!]);
      for (const cell of allCells(view)) {
        if (cell.state !== 'stated') {
          expect(cell.reason, `${cell.slug} ${cell.state}`).toBeTruthy();
          continue;
        }
        statedTotal += 1;
        expect(cell.verifiedAt).toBeTruthy();
        expect(cell.sources.length).toBeGreaterThan(0);
      }
    }
    expect(statedTotal).toBeGreaterThan(0);
  });

  it('names pricing and availability rather than leaving them blank, at either data shape', () => {
    // Deliberately keyed on what the dataset holds rather than on a measured
    // snapshot. At merge-base fc418bb6 `raw.ts` composed neither pricing nor
    // deployment JSON and both groups read `not-collected`; the operational
    // files are exactly the kind of thing a refresh lands, and a test pinned to
    // the empty shape would fail on the data rather than on the behaviour. What
    // has to hold either way is that the group is never silently blank: it
    // shows rows, or it says why it cannot, and it distinguishes "nobody has
    // collected this" from "records exist but none cover these models".
    const view = buildSeed([seedSlugs[0]!, seedSlugs[1]!]);
    const backing = { pricing: dataset.pricing, availability: dataset.deployments } as const;

    for (const id of ['pricing', 'availability'] as const) {
      const group = groupOf(view, id);
      if (group.rows.length > 0) {
        expect(group.absence, `${id} shows rows, so it must claim no absence`).toBeNull();
        continue;
      }

      expect(group.absence, `${id} has no rows, so it must say why`).not.toBeNull();
      expect(group.absence!.state).toBe(backing[id].length === 0 ? 'not-collected' : 'unrecorded');
      expect(group.absence!.reason.length).toBeGreaterThan(80);
    }
  });

  it('still shows a substantial comparison when most groups are absent', () => {
    const view = buildSeed([seedSlugs[0]!, seedSlugs[1]!]);
    const stated = allCells(view).filter((cell) => cell.state === 'stated');

    // Readable means there is something to read: identity, lifecycle,
    // positioning, modalities and access are all schema-required.
    expect(view.presentGroups.map((group) => group.id)).toEqual(
      expect.arrayContaining(['identity', 'lifecycle', 'positioning', 'modalities', 'access']),
    );
    expect(stated.length).toBeGreaterThan(20);
  });

  it('gives a reason for every absent group', () => {
    const view = buildSeed([seedSlugs[0]!, seedSlugs[1]!]);
    expect(view.absentGroups.length).toBeGreaterThan(0);
    for (const group of view.absentGroups) {
      expect(group.absence, group.id).not.toBeNull();
      expect(group.absence!.reason, group.id).toBeTruthy();
    }
  });

  it('produces real benchmark rows for every real pair that has results', () => {
    // Coverage is read, not asserted at a measured count, for the same reason as
    // the group test above: benchmark results are refresh-managed data, and a
    // test pinned to "exactly two covered releases" would fail the day a
    // refresh lands a third. Two is the floor the comparison needs to render an
    // evidence row at all.
    const covered = [...new Set(dataset.benchmarkResults.map((result) => result.releaseId))]
      .map((id) => dataset.releases.find((release) => release.id === id)!.slug);

    expect(covered.length).toBeGreaterThanOrEqual(2);

    const view = buildSeed(covered.slice(0, MAX_COMPARISON_MODELS));
    const evidence = groupOf(view, 'evidence');

    expect(evidence.rows.length).toBeGreaterThan(0);
    for (const row of evidence.rows) {
      expect(row.evidence?.policyVersion).toBeTruthy();
      expect(row.cells.some((cell) => cell.state === 'stated' || cell.state === 'not-comparable'))
        .toBe(true);
    }
  });

  it('rejects a real over-capacity selection rather than truncating silently', () => {
    const selection = resolveComparisonSelection(seedSlugs.slice(0, 6), seedSlugs);

    expect(selection.slugs).toHaveLength(MAX_COMPARISON_MODELS);
    expect(selection.rejections).toHaveLength(2);
    for (const rejection of selection.rejections) {
      expect(rejection.code).toBe('over-capacity');
      expect(rejection.message).toContain(rejection.slug);
    }
  });
});

// ---------------------------------------------------------------------------
// Payload. `/compare` is the one page in this site that ships its records, so
// it is the one page whose weight can grow without anybody noticing.
// ---------------------------------------------------------------------------

describe('comparison payload', () => {
  const payload = buildComparisonPayload(dataset);
  const seedSlugs = dataset.releases.map((release) => release.slug);
  const seedBase = '/ModelTree/';
  const today = '2026-08-27';

  it('drops the fields the comparison never reads', () => {
    const trimmed = measureComparisonPayload(payload);
    // Same unit on both sides. `trimmed.totalBytes` is UTF-8 (#621), so
    // measuring the untrimmed baseline with `.length` would compare bytes
    // against UTF-16 code units — a mismatch the correction itself would
    // introduce, and one that flatters the trim by 604 bytes at present.
    const whole = new TextEncoder().encode(JSON.stringify({
      releases: dataset.releases,
      sources: dataset.sources,
      publishers: dataset.publishers,
      organizations: dataset.organizations,
      families: dataset.families,
      servingPlatforms: dataset.servingPlatforms,
      deployments: dataset.deployments,
      pricing: dataset.pricing,
      benchmarks: dataset.benchmarks,
      benchmarkResults: dataset.benchmarkResults,
    })).length;

    expect(trimmed.totalBytes).toBeLessThan(whole);
    expect(payload.releases[0]).not.toHaveProperty('summary');
    expect(payload.releases[0]).not.toHaveProperty('predecessorIds');
  });

  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    // Criterion 3 of #621. The guard is pinned against a fixture whose byte
    // length is hand-derivable, rather than against the live dataset, because
    // the live dataset is 99.97% ASCII: it agrees with the wrong measurement to
    // within 36 bytes and so cannot witness the defect at all. What each
    // character costs, and why the two counts diverge:
    //
    //   é       U+00E9   1 code unit    2 bytes   +1   (twice: name, shortName)
    //   한국어  U+D55C…  1 unit each    3 each    +2 each
    //   😀      U+1F600  2 (surrogate)  4         +2
    //
    // Hand-derived: 1 + 1 + (3 × 2) + 2 = 10 bytes more than code units.
    const fixture: ComparisonDataset = {
      sources: [],
      publishers: [],
      organizations: [{ id: 'org-cafe', name: 'Café Intelligence', shortName: 'Café' }],
      families: [{ id: 'fam-hangul', name: '한국어 😀' }],
      releases: [],
      servingPlatforms: [],
      deployments: [],
      pricing: [],
      benchmarks: [],
      benchmarkResults: [],
    };

    const codeUnits = JSON.stringify(fixture).length;
    const measured = measureComparisonPayload(fixture).totalBytes;

    expect(codeUnits).toBe(265);
    expect(measured).toBe(275);
    // Asserted as a difference as well as an absolute. The absolute pins the
    // exact byte length; the difference is the part a reader can re-derive from
    // the table above without running anything, and it is what a revert to
    // `JSON.stringify(...).length` drives to zero. Anyone "simplifying" this
    // measurement back fails here rather than quietly under-reporting.
    expect(measured - codeUnits).toBe(10);
    expect(measured).toBeGreaterThan(codeUnits);
  });

  it('keeps the shipped payload within its budget', () => {
    const size = measureComparisonPayload(payload);

    // Two guards, and only one of them is really a guard. Read this before you
    // change either number, because the honest answer to "what bounds page
    // weight" is not the same for the two.
    //
    // Both figures are UTF-8 bytes. Until #621 they were UTF-16 code units
    // reported under a byte name, which understates any non-ASCII character by
    // one to two bytes and so read progressively lower as the catalogue
    // internationalized. Correcting the unit moved the measured total up 36
    // bytes against an unchanged ceiling — 137,655 to 137,691 of 143,360 — and
    // left the per-release figure at 1,497 of 1,600. Neither threshold moved,
    // which was the condition for making the correction at all: it was free
    // while the catalogue was still 99.97% ASCII, and it stops being free.
    //
    // The per-release ceiling below (the `1_600` assertion) is the instrument.
    // It is scale-invariant: it does not move when the catalogue grows, only
    // when the average record gets fatter, which is the drift that actually
    // costs a reader. It does real work and it is the one to trust. Do not
    // weaken it to make any total look nicer — that trade was refused on
    // abdeslam-menacere/ModelTree#584 and stays refused.
    //
    // The absolute total below (the second assertion) is not scale-invariant.
    // It can only ever fail because the catalogue grew, which is the thing this
    // project exists to do, so raising it every time it binds measures nothing
    // but how recently someone last raised it. abdeslam-menacere/ModelTree#602
    // is the decision to stop treating that raise as routine. The total is kept
    // — 143,360 bytes shipped to /compare is a real cost on a slow connection,
    // and a page-weight ceiling is a real acceptance criterion here — but it is
    // now a ratchet with a stated stopping rule rather than a number that moves
    // on sight.
    //
    // The stopping rule. The total may be raised only when BOTH hold:
    //   1. the catalogue simply grew — more releases or more cited sources — and
    //   2. the per-release figure held under its own ceiling.
    // If the per-release figure moved too, the payload got fatter: trim it, do
    // not raise the total. And a raise is legitimate only when trimming has been
    // tried first and cannot close the gap without dropping a cited source or
    // reducing a record to a stub. It never is: provenance outranks page weight
    // in this repository (criterion 5 of the issue), so a cited source is never
    // dropped and a record is never trimmed to fit a byte target.
    //
    // What to count when you apply that rule: cited sources, not records and not
    // note prose. buildComparisonPayload ships exactly five identity fields per
    // cited source (id, url, title, publisherId, lastCheckedDate) and ships only
    // the ~168 of 202 sources that something in the payload cites; it drops
    // `notes`, `type` and `publishedDate` entirely. So the two axes pull apart:
    // a new cited source costs bytes, while longer, more verbatim note prose
    // costs nothing. Provenance breadth is what moves this total; provenance
    // quality is free. Trimming a note therefore buys no bytes and spends the
    // one audience notes have — the reviewer reading the versioned JSON — so do
    // not reach for it.
    //
    // Why there are no historical byte figures in this comment any more: they
    // were a measurement of a dataset that keeps changing, so every breadth
    // tranche left one of them stale and no test could see it go wrong. They
    // justified past raises; git history holds that. The only figures that
    // belong here are ones a reader can re-derive by running the test, which is
    // why the failure message below prints the measured value rather than
    // repeating it in prose.
    expect(
      size.bytesPerRelease,
      'a record got fatter — trim the payload rather than raising this',
    ).toBeLessThanOrEqual(1_600);
    expect(
      size.totalBytes,
      `/compare ships ${size.totalBytes} UTF-8 bytes for ${payload.releases.length} releases `
      + `(${size.bytesPerRelease}/release, budget 143,360). The #584-era anchors — 124,410 over 83 `
      + 'releases at 1,499 each, against 121,916 over 82 at its 7ca5802 merge-base — are UTF-16 '
      + 'code-unit counts taken before #621 corrected the unit, so they read low by about 0.03% and '
      + 'are not strictly comparable with the figure above. If the '
      + 'catalogue simply grew and the per-release figure held, raising this is a deliberate '
      + 'page-weight decision; if the per-release figure moved too, trim instead.',
    ).toBeLessThanOrEqual(143_360);
  });

  it('ships only the sources something in the payload cites', () => {
    const cited = new Set([
      ...payload.releases.flatMap((release) => release.sourceIds),
      ...payload.benchmarkResults.flatMap((result) => result.sourceIds),
      ...payload.deployments.flatMap((deployment) => deployment.sourceIds),
      ...payload.pricing.flatMap((price) => price.sourceIds),
    ]);

    expect(payload.sources.length).toBeLessThan(dataset.sources.length);
    expect(payload.sources.every((source) => cited.has(source.id))).toBe(true);
    for (const id of cited) {
      expect(payload.sources.some((source) => source.id === id), `source ${id}`).toBe(true);
    }
  });

  it('builds the same comparison from the payload as from the whole dataset', () => {
    // The trimming is only safe if nothing the table renders was trimmed away,
    // which is a claim about output rather than about which keys were copied.
    for (let index = 0; index + 1 < seedSlugs.length; index += 1) {
      const slugs = [seedSlugs[index]!, seedSlugs[index + 1]!];
      expect(JSON.stringify(buildModelComparison(payload, slugs, seedBase, today)))
        .toBe(JSON.stringify(buildModelComparison(dataset, slugs, seedBase, today)));
    }
  });

  it('needs only the picker index before a reader has chosen anything', () => {
    const index = buildComparisonPickerIndex(dataset);
    // UTF-8 bytes, matching the payload guard after #621. Measured at the time
    // of that correction the two counts were identical here — delta exactly 0 —
    // because every field a picker row carries is ASCII today. That is a
    // measurement of the current dataset and not a property of the row: a
    // creator whose `shortName` carries non-ASCII would separate them, which is
    // precisely why this counts bytes rather than assuming the two agree.
    const bytes = new TextEncoder().encode(JSON.stringify(index)).length;
    const bytesPerRelease = index.length === 0 ? 0 : Math.round(bytes / index.length);

    expect(index).toHaveLength(dataset.releases.length);
    // Two-part, matching the payload budget above: a scale-invariant guard that
    // moves only when a row gets fatter, and a total that necessarily grows with
    // the catalogue. Until abdeslam-menacere/ModelTree#545 this assertion was the
    // total alone, so nothing in the suite could tell "six more creators" from
    // "every picker row got fatter" — exactly the drift the sibling budget's
    // comment exists to prevent, and the reason a bare raise was refused.
    //
    // The `128` assertion below is the instrument, on the same terms as the
    // payload's `1_600`: scale-invariant, it moves only when a row gets fatter,
    // and it is never weakened to make a total look nicer. The rule below does
    // not touch it and no raise of the total may buy headroom from it.
    //
    // ---- The stopping rule for the total (abdeslam-menacere/ModelTree#659) ----
    //
    // A raise is legitimate only when all three hold:
    //   1. the catalogue simply grew — more releases — and
    //   2. the per-release figure held under its own 128-byte ceiling, and
    //   3. a trim has been tried and cannot close the gap without dropping a
    //      cited source or reducing a record to a stub.
    // If 2 fails, the rows got fatter rather than more numerous: trim, do not
    // raise. Conditions 1 and 2 are the payload's, unchanged. Condition 3 is the
    // payload's too — and the difference between the two rules is entirely that
    // the payload discharges 3 in advance and this guard cannot.
    //
    // Why it cannot, in terms of what a picker row carries. #622 discharges "try
    // trimming first" for the payload with "it never is", because the payload
    // spends its bytes on five identity fields per cited source: every trim of it
    // drops provenance, and provenance outranks page weight here. A picker row
    // carries `slug`, `displayName`, `organizationName`, `familyName`, and cites
    // nothing. Trimming it drops no provenance, stubs no record, and costs
    // nothing that #584's refusal or criterion 4 of #659 protects. The clause
    // that makes payload raises automatically legitimate is simply absent on this
    // side, so the burden stays live and has to be discharged by measurement,
    // per raise. That is why #602 could exempt these two guards as "well inside
    // their limits" without settling the question, and why the premise expired
    // rather than the rule transferring.
    //
    // Measured, condition 3 has never yet held here, which is what collapses the
    // three conditions into a flat instruction: do not raise this total, trim the
    // row. At merge-base 356989e9, 92 rows and 10,449 bytes — JSON key names are
    // 4,876 of them (46.7%): organizationName 1,748, displayName 1,288,
    // familyName 1,196, slug 644, against 5,020 bytes of values and 553
    // structural, the three summing to the total exactly. One-character keys buy
    // back 3,404, landing at 7,045 (77/row, 31% under even the pre-#651 10,240);
    // tuple rows buy back 4,876, landing at 5,573 (61/row). Both keep all four
    // values on every row. Interning the 40 distinct organization names and 64
    // family names buys only 379, because the repetition is in the keys and not
    // the values — recorded so the next reader does not spend the effort finding
    // that out again. The cheaper structural trim is therefore worth ~30 rows of
    // growth at 113.58 bytes/row, against the 815 bytes (~7 rows) of headroom
    // this total has left: the remedy outruns the problem by an order of
    // magnitude, and no plausible tranche escapes it.
    //
    // Which makes the rule non-blocking, and that is the point of stating it this
    // way. A guard that names its own remedy is not an obstacle to the change
    // that trips it, so performing the trim is in scope for whatever change trips
    // this. What is not in scope is altering what a row *carries*: dropping
    // organizationName/familyName and resolving them client-side from ids changes
    // the picker's contract with its consumer, and belongs to its own issue with
    // its own review — #659 puts that option on the record and explicitly
    // declines to be its remedy. Shortening keys or moving to tuple rows keeps
    // every value on every row and is mechanical.
    //
    // Worth weighing before spending effort on either side: nothing ships this
    // index. `buildComparisonPickerIndex` is imported only by this file and by
    // organization-name.test.ts — /compare ships buildComparisonPayload
    // (compare.astro), and no .astro, script or client bundle imports the picker.
    // So a raise costs zero delivered bytes and a trim saves zero; both move a
    // proxy for a page weight that is not yet real. The guard is still worth
    // keeping as a design constraint on what /compare would ship if the picker is
    // adopted — but what adoption would inherit is the row shape, not the
    // catalogue size, and the catalogue growing is the thing this project exists
    // to do. That is a second and independent reason the remedy here is the trim
    // and not the raise.
    //
    // #651 raised this from 10,240 to 11,264, correctly reading the protocol this
    // comment used to document; the protocol was what was wrong, not that dock.
    // The raise stands — #659 declines to revert raises already landed — and it
    // is verified rather than assumed: with the dataset at 10,449 bytes,
    // restoring 10_240 fails this assertion by 209 bytes, which was run before
    // this note was written. Earlier tranche-by-tranche figures have been dropped
    // from this comment for the reason the payload's comment gives for dropping
    // its own: they measure a dataset that keeps changing, so every tranche left
    // one of them stale and no test could see it go wrong. git history holds
    // them. The one measurement kept above is anchored to a merge-base a reader
    // can recompute, the rule leans on its ratio rather than its absolutes, and
    // the failure message below prints the live value rather than repeating it.
    expect(
      bytesPerRelease,
      'a picker row got fatter — trim the row rather than raising this',
    ).toBeLessThanOrEqual(128);
    expect(
      bytes,
      `the picker index ships ${bytes} bytes for ${index.length} releases `
      + `(${bytesPerRelease}/release, budget 11,264). Do not raise this number. `
      + 'A picker row cites no source, so trimming one drops no provenance and '
      + 'stubs no record, and the trim is measured to outrun the growth: key names '
      + 'are 47% of these bytes, and one-character keys buy back about 30 rows '
      + 'against the ~7 rows of headroom this budget had. Trimming the row shape is '
      + 'in scope for whatever change trips this guard; changing what a row carries '
      + 'is not. A raise needs a measurement showing a trim cannot close the gap — '
      + 'see the stopping rule above.',
    ).toBeLessThanOrEqual(11_264);
    for (const row of index) {
      expect(row.displayName).toBeTruthy();
      expect(row.organizationName).toBeTruthy();
      expect(row.familyName).toBeTruthy();
    }
  });
});
