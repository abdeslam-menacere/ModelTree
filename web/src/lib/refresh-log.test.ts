import { describe, expect, it } from 'vitest';
import { refreshLog } from '../data/refresh-log';
import type { RefreshRun, WithheldItem } from '../data/refresh-log-schema';
import {
  claimKindLabel,
  countLabel,
  gateOutcomeLabel,
  gateTally,
  logTotals,
  outcomeLabel,
  postedTally,
  rubricLabel,
  runLedger,
  runsNewestFirst,
  stageLabel,
  stageStatusLabel,
  coverageGapTally,
  knownCoverageGaps,
  withheldCategoryLabel,
  withheldGroups,
} from './refresh-log';

function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
  return {
    id: '2026-01-02-aaaaaa',
    title: 'Data refresh 2026-01-02',
    ranOn: '2026-01-02',
    outcome: 'no-change',
    summary: 'Nothing to change.',
    scope: 'Every creator',
    stages: [{ stage: 'preflight', status: 'ran', note: 'Clean tree.' }],
    found: { scouts: 1, pagesFetched: 4, claimsProposed: 0, bundles: [], claimsByKind: [], notCovered: [] },
    evaluated: {
      reviewers: 0,
      verdictsCast: 0,
      acceptedByPanel: 0,
      rejectedByPanel: 0,
      dissents: [],
      gates: [{
        gate: 'gate-dataset',
        scope: 'working tree',
        exitCode: 0,
        outcome: 'pass',
        required: true,
        detail: 'Coherent.',
      }],
    },
    posted: { editsApplied: 0, documents: [], records: [] },
    withheld: [],
    caveats: ['Form, not remote content.'],
    followUps: [],
    references: [{ kind: 'issue', label: 'Issue #1', url: 'https://example.com/1' }],
    recordedAt: '2026-01-02',
    ...overrides,
  } as RefreshRun;
}

describe('runsNewestFirst', () => {
  it('puts the most recent run first', () => {
    const ordered = runsNewestFirst([
      run({ id: '2026-01-01-aaaaaa', ranOn: '2026-01-01' }),
      run({ id: '2026-03-04-bbbbbb', ranOn: '2026-03-04' }),
      run({ id: '2026-02-02-cccccc', ranOn: '2026-02-02' }),
    ]);

    expect(ordered.map(({ ranOn }) => ranOn)).toEqual(['2026-03-04', '2026-02-02', '2026-01-01']);
  });

  it('orders two runs from the same day by run id, so neither floats', () => {
    const ordered = runsNewestFirst([
      run({ id: '2026-01-01-aaaaaa', ranOn: '2026-01-01' }),
      run({ id: '2026-01-01-ffffff', ranOn: '2026-01-01' }),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual(['2026-01-01-ffffff', '2026-01-01-aaaaaa']);
  });

  it('does not mutate the log it was given', () => {
    const log = [
      run({ id: '2026-01-01-aaaaaa', ranOn: '2026-01-01' }),
      run({ id: '2026-03-04-bbbbbb', ranOn: '2026-03-04' }),
    ];
    runsNewestFirst(log);

    expect(log.map(({ ranOn }) => ranOn)).toEqual(['2026-01-01', '2026-03-04']);
  });
});

describe('gateTally', () => {
  it('counts each outcome separately and never folds "could not run" into a pass', () => {
    const tally = gateTally(run({
      evaluated: {
        reviewers: 0,
        verdictsCast: 0,
        acceptedByPanel: 0,
        rejectedByPanel: 0,
        dissents: [],
        gates: [
          { gate: 'a', scope: 's', exitCode: 0, outcome: 'pass', required: true, detail: 'd' },
          { gate: 'b', scope: 's', exitCode: 1, outcome: 'fail', required: false, detail: 'd' },
          { gate: 'c', scope: 's', exitCode: 2, outcome: 'not-run', required: true, detail: 'd' },
        ],
      },
    }));

    expect(tally).toEqual({ total: 3, passed: 1, failed: 1, notRun: 1, blocking: 1 });
  });

  it('does not count a failed optional check as blocking', () => {
    const tally = gateTally(run({
      evaluated: {
        reviewers: 0,
        verdictsCast: 0,
        acceptedByPanel: 0,
        rejectedByPanel: 0,
        dissents: [],
        gates: [{ gate: 'skills-ci', scope: 'PR', outcome: 'fail', required: false, detail: 'Red.' }],
      },
    }));

    expect(tally.blocking).toBe(0);
    expect(tally.failed).toBe(1);
  });
});

describe('postedTally', () => {
  it('reports the net record movement the documents state', () => {
    const tally = postedTally(run({
      outcome: 'published',
      posted: {
        editsApplied: 12,
        documents: [
          { document: 'sources.json', recordsBefore: 47, recordsAfter: 61, note: 'Added.' },
          { document: 'organizations.json', recordsBefore: 4, recordsAfter: 4, note: 'Corrected.' },
        ],
        records: [{ id: 'a-release', collection: 'releases', note: 'New.' }],
      },
    }));

    expect(tally).toEqual({ edits: 12, documentsTouched: 2, netRecordChange: 14, recordsNamed: 1 });
  });

  it('reports zeroes for a run that posted nothing rather than guessing', () => {
    expect(postedTally(run())).toEqual({
      edits: 0,
      documentsTouched: 0,
      netRecordChange: 0,
      recordsNamed: 0,
    });
  });
});

describe('withheldGroups', () => {
  it('groups by category in a fixed display order and drops empty categories', () => {
    const groups = withheldGroups(run({
      withheld: [
        { id: 'x', category: 'source-refused', detail: 'Unapproved origin.', blockedBy: [] },
        { id: 'y', category: 'rejected-by-panel', detail: 'Voted down.', blockedBy: [] },
        { id: 'z', category: 'source-refused', detail: 'Also unapproved.', blockedBy: [] },
      ],
    }));

    expect(groups.map(({ category }) => category)).toEqual(['rejected-by-panel', 'source-refused']);
    expect(groups[1].items.map(({ id }) => id)).toEqual(['x', 'z']);
    expect(groups[1].label).toBe('Source refused by the approval gate');
  });

  it('returns nothing when a run withheld nothing', () => {
    expect(withheldGroups(run())).toEqual([]);
  });
});

describe('runLedger', () => {
  it('sets posted against withheld', () => {
    const ledger = runLedger(run({
      outcome: 'published',
      posted: { editsApplied: 63, documents: [], records: [] },
      withheld: [{ id: 'a', category: 'not-covered', detail: 'Out of reach.', blockedBy: [] }],
    }));

    expect(ledger).toEqual({ posted: 63, withheld: 1, reportsWithheld: true });
  });

  it('says so plainly when a run recorded nothing withheld', () => {
    expect(runLedger(run()).reportsWithheld).toBe(false);
  });
});

describe('logTotals', () => {
  it('adds up every run and names the most recent date', () => {
    const totals = logTotals([
      run({
        id: '2026-01-01-aaaaaa',
        ranOn: '2026-01-01',
        found: { scouts: 1, pagesFetched: 10, claimsProposed: 4, bundles: [], claimsByKind: [], notCovered: [] },
      }),
      run({
        id: '2026-05-05-bbbbbb',
        ranOn: '2026-05-05',
        outcome: 'published',
        found: { scouts: 2, pagesFetched: 20, claimsProposed: 6, bundles: [], claimsByKind: [], notCovered: [] },
        posted: { editsApplied: 30, documents: [], records: [] },
        withheld: [{ id: 'a', category: 'not-covered', detail: 'Out of reach.', blockedBy: [] }],
      }),
    ]);

    expect(totals).toEqual({
      runs: 2,
      published: 1,
      pagesFetched: 30,
      claimsProposed: 10,
      editsApplied: 30,
      withheld: 1,
      latestRun: '2026-05-05',
    });
  });

  it('refuses an empty log rather than reporting a date it does not have', () => {
    expect(() => logTotals([])).toThrow(/at least one run/);
  });

  it('summarises the committed log without throwing', () => {
    const totals = logTotals(refreshLog);

    expect(totals.runs).toBe(refreshLog.length);
    expect(totals.latestRun).toBe(runsNewestFirst(refreshLog)[0].ranOn);
  });
});

describe('labels', () => {
  it('keeps "stopped" readable as having published nothing', () => {
    expect(outcomeLabel('stopped')).toBe('Stopped, published nothing');
    expect(outcomeLabel('published')).toBe('Published');
  });

  it('keeps "not run" and "not applicable" distinct', () => {
    expect(stageStatusLabel('not-run')).toBe('Not run');
    expect(stageStatusLabel('not-applicable')).toBe('Not applicable');
  });

  it('never calls a gate that could not run a pass', () => {
    expect(gateOutcomeLabel('not-run')).toBe('Could not run');
    expect(gateOutcomeLabel('pass')).toBe('Pass');
  });

  it('labels the remaining vocabularies', () => {
    expect(stageLabel('deploy')).toBe('Deploy');
    expect(claimKindLabel('unchanged')).toBe('Unchanged');
    expect(rubricLabel('consistency')).toBe('Cross-source consistency');
    expect(withheldCategoryLabel('verification-held'))
      .toBe('Verification date deliberately held back');
  });
});

describe('countLabel', () => {
  it('does not write "1 items"', () => {
    expect(countLabel(1, 'item')).toBe('1 item');
    expect(countLabel(2, 'item')).toBe('2 items');
  });

  it('still names the unit when the count is zero', () => {
    expect(countLabel(0, 'edit')).toBe('0 edits');
  });

  it('groups thousands and honours an irregular plural', () => {
    expect(countLabel(1234, 'page')).toBe('1,234 pages');
    expect(countLabel(3, 'entry', 'entries')).toBe('3 entries');
    expect(countLabel(1, 'entry', 'entries')).toBe('1 entry');
  });
});

describe('known coverage gaps', () => {
  const gap = (id: string, category: WithheldItem['category']): WithheldItem => ({
    id,
    category,
    detail: `Withheld ${id}.`,
    blockedBy: [],
  });

  it('carries every withheld item forward with the run that withheld it', () => {
    const gaps = knownCoverageGaps([
      run({
        id: '2026-01-02-aaaaaa',
        ranOn: '2026-01-02',
        withheld: [gap('alpha', 'blocked-by-policy'), gap('beta', 'source-refused')],
      }),
    ]);

    // A gap is only useful with its provenance attached: which run declined it,
    // and when. Dropping either would leave an assertion nobody can re-check.
    expect(gaps.map(({ item }) => item.id)).toEqual(['alpha', 'beta']);
    expect(gaps.every(({ runId }) => runId === '2026-01-02-aaaaaa')).toBe(true);
    expect(gaps.every(({ ranOn }) => ranOn === '2026-01-02')).toBe(true);
  });

  it('orders gaps newest run first', () => {
    const gaps = knownCoverageGaps([
      run({ id: '2026-01-02-aaaaaa', ranOn: '2026-01-02', withheld: [gap('older', 'source-refused')] }),
      run({ id: '2026-05-09-bbbbbb', ranOn: '2026-05-09', withheld: [gap('newer', 'source-refused')] }),
    ]);

    // Fixture order is deliberately oldest-first, so a helper that merely
    // preserved input order would fail here rather than coincidentally pass.
    expect(gaps.map(({ item }) => item.id)).toEqual(['newer', 'older']);
  });

  it('tallies by category and omits categories nothing landed in', () => {
    const tally = coverageGapTally([
      run({
        id: '2026-01-02-aaaaaa',
        withheld: [
          gap('a', 'blocked-by-policy'),
          gap('b', 'blocked-by-policy'),
          gap('c', 'source-refused'),
        ],
      }),
    ]);

    const counts = Object.fromEntries(tally.map(({ category, count }) => [category, count]));
    expect(counts).toEqual({ 'blocked-by-policy': 2, 'source-refused': 1 });
    // A zero-count row would read as a gap category that exists and is empty,
    // which is a different and false claim from the category not arising.
    expect(tally.every(({ count }) => count > 0)).toBe(true);
  });

  it('labels every tallied category the same way the run pages do', () => {
    const tally = coverageGapTally(refreshLog);

    // Positive control: an empty tally would satisfy the label assertion
    // vacuously, and the committed log does record withheld items.
    expect(tally.length).toBeGreaterThan(0);
    for (const { category, label } of tally) {
      expect(label).toBe(withheldCategoryLabel(category));
    }
  });

  it('accounts for every withheld item in the committed log exactly once', () => {
    const gaps = knownCoverageGaps(refreshLog);
    const withheldInLog = refreshLog.flatMap((entry) => entry.withheld);

    // Bound to the log's own contents rather than to any fixed number, so
    // adding or closing a run cannot falsify it. The control keeps it honest
    // if the log ever carries no withheld items at all.
    expect(withheldInLog.length).toBeGreaterThan(0);
    expect(gaps.length).toBe(withheldInLog.length);
    expect(coverageGapTally(refreshLog).reduce((sum, { count }) => sum + count, 0))
      .toBe(withheldInLog.length);
  });
});
