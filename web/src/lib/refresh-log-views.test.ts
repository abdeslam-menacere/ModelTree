import { describe, expect, it } from 'vitest';
import { refreshLog } from '../data/refresh-log';
import type { RefreshLog, RefreshRun } from '../data/refresh-log-schema';
import {
  ALL_RUNS,
  buildView,
  filterRuns,
  filterSegments,
  matchesFilter,
  pageCount,
  refreshFilterOptions,
  refreshViews,
  runYear,
  sameFilter,
  viewHref,
  viewSegments,
} from './refresh-log-views';

function run(id: string, ranOn: string, outcome: RefreshRun['outcome'] = 'no-change'): RefreshRun {
  return {
    id,
    title: `Data refresh ${ranOn}`,
    ranOn,
    outcome,
    summary: 'Summary.',
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
    recordedAt: ranOn,
  } as RefreshRun;
}

const LOG: RefreshLog = [
  run('2025-12-01-aaaaaa', '2025-12-01', 'stopped'),
  run('2026-01-05-bbbbbb', '2026-01-05'),
  run('2026-02-09-cccccc', '2026-02-09', 'published'),
  run('2026-03-14-dddddd', '2026-03-14', 'published'),
] as RefreshLog;

describe('runYear', () => {
  it('reads the year off the date the run actually ran', () => {
    expect(runYear(run('x', '2026-01-05'))).toBe('2026');
  });
});

describe('matchesFilter', () => {
  const published = run('x', '2026-01-05', 'published');

  it('lets everything through the all filter', () => {
    expect(matchesFilter(published, ALL_RUNS)).toBe(true);
  });

  it('matches on year and on outcome', () => {
    expect(matchesFilter(published, { kind: 'year', value: '2026' })).toBe(true);
    expect(matchesFilter(published, { kind: 'year', value: '2025' })).toBe(false);
    expect(matchesFilter(published, { kind: 'outcome', value: 'published' })).toBe(true);
    expect(matchesFilter(published, { kind: 'outcome', value: 'stopped' })).toBe(false);
  });
});

describe('sameFilter', () => {
  it('does not confuse a year with an outcome that shares no value', () => {
    expect(sameFilter({ kind: 'year', value: '2026' }, { kind: 'outcome', value: 'published' }))
      .toBe(false);
  });

  it('compares values within a kind', () => {
    expect(sameFilter({ kind: 'year', value: '2026' }, { kind: 'year', value: '2026' })).toBe(true);
    expect(sameFilter({ kind: 'year', value: '2026' }, { kind: 'year', value: '2025' })).toBe(false);
    expect(sameFilter(ALL_RUNS, ALL_RUNS)).toBe(true);
    expect(sameFilter(ALL_RUNS, { kind: 'year', value: '2026' })).toBe(false);
  });
});

describe('refreshFilterOptions', () => {
  it('offers all runs, then years newest first, then the outcomes present', () => {
    expect(refreshFilterOptions(LOG).map(({ label, count }) => [label, count])).toEqual([
      ['All runs', 4],
      ['2026', 3],
      ['2025', 1],
      ['Published', 2],
      ['Ran, changed nothing', 1],
      ['Stopped, published nothing', 1],
    ]);
  });

  it('never offers a filter that would come back empty', () => {
    const labels = refreshFilterOptions(LOG).map(({ label }) => label);
    expect(labels).not.toContain('Published, then reverted');
  });

  it('keeps the all-runs entry even for an empty log, so the page still exists', () => {
    expect(refreshFilterOptions([] as unknown as RefreshLog))
      .toEqual([{ filter: ALL_RUNS, label: 'All runs', count: 0 }]);
  });
});

describe('filterRuns', () => {
  it('returns the filtered runs newest first', () => {
    expect(filterRuns(LOG, { kind: 'year', value: '2026' }).map(({ ranOn }) => ranOn))
      .toEqual(['2026-03-14', '2026-02-09', '2026-01-05']);
  });
});

describe('pageCount', () => {
  it('never reports fewer than one page, even with nothing to show', () => {
    expect(pageCount(0, 10)).toBe(1);
  });

  it('rounds a partial page up', () => {
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
    expect(pageCount(21, 10)).toBe(3);
  });
});

describe('buildView', () => {
  it('slices the filtered runs and reports the range being shown', () => {
    const view = buildView(LOG, ALL_RUNS, 2, 3);

    expect(view.runs.map(({ ranOn }) => ranOn)).toEqual(['2025-12-01']);
    expect(view).toMatchObject({ page: 2, totalPages: 2, totalRuns: 4, firstShown: 4, lastShown: 4 });
  });

  it('counts the whole filter, not just the page', () => {
    expect(buildView(LOG, ALL_RUNS, 1, 3)).toMatchObject({ totalRuns: 4, firstShown: 1, lastShown: 3 });
  });

  it('reports an empty range rather than a first item it does not have', () => {
    expect(buildView([] as unknown as RefreshLog, ALL_RUNS, 1, 3))
      .toMatchObject({ runs: [], totalRuns: 0, firstShown: 0, lastShown: 0, totalPages: 1 });
  });

  it('paginates within a filter, not across the whole log', () => {
    const view = buildView(LOG, { kind: 'outcome', value: 'published' }, 1, 3);
    expect(view.totalRuns).toBe(2);
    expect(view.totalPages).toBe(1);
  });
});

describe('viewSegments and viewHref', () => {
  it('addresses the unfiltered first page as the bare route', () => {
    expect(viewSegments(ALL_RUNS, 1)).toEqual([]);
    expect(viewHref('/', ALL_RUNS, 1)).toBe('/refresh/');
  });

  it('keeps the filter in the path when paging through it', () => {
    expect(viewSegments({ kind: 'year', value: '2026' }, 3)).toEqual(['year', '2026', 'page', '3']);
    expect(viewHref('/', { kind: 'year', value: '2026' }, 3)).toBe('/refresh/year/2026/page/3/');
  });

  it('does not put page 1 in the path', () => {
    expect(viewHref('/', { kind: 'outcome', value: 'published' }, 1))
      .toBe('/refresh/outcome/published/');
  });

  it('honours a base path, with or without its trailing slash', () => {
    expect(viewHref('/ModelTree/', ALL_RUNS, 2)).toBe('/ModelTree/refresh/page/2/');
    expect(viewHref('/ModelTree', ALL_RUNS, 2)).toBe('/ModelTree/refresh/page/2/');
  });

  it('segments an outcome filter under its own prefix', () => {
    expect(filterSegments({ kind: 'outcome', value: 'stopped' })).toEqual(['outcome', 'stopped']);
    expect(filterSegments(ALL_RUNS)).toEqual([]);
  });
});

describe('refreshViews', () => {
  it('builds one route per page of every filter, and no empty pages', () => {
    const views = refreshViews(LOG, 3);
    const routes = views.map((view) => viewSegments(view.filter, view.page).join('/'));

    expect(routes).toEqual([
      '',
      'page/2',
      'year/2026',
      'year/2025',
      'outcome/published',
      'outcome/no-change',
      'outcome/stopped',
    ]);
    for (const view of views) expect(view.runs.length).toBeGreaterThan(0);
  });

  it('addresses every route exactly once', () => {
    const routes = refreshViews(LOG, 1).map((view) => viewSegments(view.filter, view.page).join('/'));
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('covers every committed run at least once from the unfiltered pages', () => {
    const unfiltered = refreshViews(refreshLog)
      .filter(({ filter }) => sameFilter(filter, ALL_RUNS))
      .flatMap(({ runs }) => runs.map(({ id }) => id));

    expect(new Set(unfiltered)).toEqual(new Set(refreshLog.map(({ id }) => id)));
  });
});
