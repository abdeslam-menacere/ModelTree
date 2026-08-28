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
  type ComparisonView,
} from './comparison';
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

    expect(window?.allowedSpreadMonths).toBe(12);
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

  it('names pricing and availability as not collected rather than leaving them blank', () => {
    // Measured at merge-base fc418bb6: `raw.ts` composes no pricing, deployment,
    // or serving-platform JSON, so these two groups are absent for every real
    // pair. If that ever changes this test should be the first thing to notice.
    expect(dataset.pricing).toHaveLength(0);
    expect(dataset.deployments).toHaveLength(0);

    const view = buildSeed([seedSlugs[0]!, seedSlugs[1]!]);
    for (const id of ['pricing', 'availability']) {
      const group = groupOf(view, id);
      expect(group.rows).toHaveLength(0);
      expect(group.absence?.state).toBe('not-collected');
      expect(group.absence?.reason.length).toBeGreaterThan(80);
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

  it('produces real benchmark rows for the one real pair that has results', () => {
    // Measured at merge-base fc418bb6: benchmark results cover exactly two
    // releases, so this is the only real selection that can produce an evidence
    // row at all.
    const covered = [...new Set(dataset.benchmarkResults.map((result) => result.releaseId))]
      .map((id) => dataset.releases.find((release) => release.id === id)!.slug);

    expect(covered).toHaveLength(2);

    const view = buildSeed(covered);
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
    const whole = JSON.stringify({
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
    }).length;

    expect(trimmed.totalBytes).toBeLessThan(whole);
    expect(payload.releases[0]).not.toHaveProperty('summary');
    expect(payload.releases[0]).not.toHaveProperty('predecessorIds');
  });

  it('keeps the shipped payload within its budget', () => {
    const size = measureComparisonPayload(payload);

    // Budgeted per release as well as in total, because the total moves whenever
    // a release is added while the per-release figure only moves when a record
    // gets fatter. Measured at merge-base fc418bb6: 68,731 bytes over 49
    // releases, 1,403 per release. The thresholds sit just above that, so the
    // next change to either is a decision somebody makes rather than a drift
    // nobody sees.
    expect(size.bytesPerRelease).toBeLessThanOrEqual(1_600);
    expect(size.totalBytes).toBeLessThanOrEqual(81_920);
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

    expect(index).toHaveLength(dataset.releases.length);
    expect(JSON.stringify(index).length).toBeLessThanOrEqual(8_192);
    for (const row of index) {
      expect(row.displayName).toBeTruthy();
      expect(row.organizationName).toBeTruthy();
      expect(row.familyName).toBeTruthy();
    }
  });
});
