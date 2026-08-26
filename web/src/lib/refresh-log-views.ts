import type { RefreshLog, RefreshRun, RunOutcome } from '../data/refresh-log-schema';
import { outcomeLabel, runsNewestFirst } from './refresh-log';

/**
 * The list view over the refresh log: which filters exist, which runs each one
 * holds, and how those are split into pages.
 *
 * Every filter offered here is derived from the log itself, so the page can never
 * present a filter that would come back empty, and pagination is computed from the
 * filtered set rather than from the whole log.
 */

export const RUNS_PER_PAGE = 10;

/** Outcomes in a fixed order, so the filter bar does not reshuffle as data lands. */
const OUTCOME_ORDER: RunOutcome[] = ['published', 'no-change', 'stopped', 'reverted'];

export type RefreshFilter =
  | { kind: 'all' }
  | { kind: 'year'; value: string }
  | { kind: 'outcome'; value: RunOutcome };

export const ALL_RUNS: RefreshFilter = { kind: 'all' };

export interface RefreshFilterOption {
  filter: RefreshFilter;
  label: string;
  /** How many runs the filter holds. Never zero — an empty filter is not offered. */
  count: number;
}

export interface RefreshView {
  filter: RefreshFilter;
  /** 1-based. */
  page: number;
  totalPages: number;
  /** Runs the filter holds, across every page. */
  totalRuns: number;
  runs: RefreshRun[];
  /** 1-based index of the first run shown, or 0 when the page is empty. */
  firstShown: number;
  lastShown: number;
}

export function runYear(run: RefreshRun) {
  return run.ranOn.slice(0, 4);
}

export function sameFilter(a: RefreshFilter, b: RefreshFilter) {
  if (a.kind !== b.kind) return false;
  return a.kind === 'all' || b.kind === 'all' || a.value === b.value;
}

export function matchesFilter(run: RefreshRun, filter: RefreshFilter) {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'year') return runYear(run) === filter.value;
  return run.outcome === filter.value;
}

export function filterLabel(filter: RefreshFilter) {
  if (filter.kind === 'all') return 'All runs';
  if (filter.kind === 'year') return filter.value;
  return outcomeLabel(filter.value);
}

/** The url segments under /refresh/ that address a filter. Empty for every run. */
export function filterSegments(filter: RefreshFilter) {
  return filter.kind === 'all' ? [] : [filter.kind, filter.value];
}

export function viewSegments(filter: RefreshFilter, page: number) {
  return page > 1 ? [...filterSegments(filter), 'page', String(page)] : filterSegments(filter);
}

export function viewHref(base: string, filter: RefreshFilter, page: number) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const segments = viewSegments(filter, page);
  return segments.length === 0 ? `${root}refresh/` : `${root}refresh/${segments.join('/')}/`;
}

export function filterRuns(log: RefreshLog, filter: RefreshFilter) {
  return runsNewestFirst(log).filter((run) => matchesFilter(run, filter));
}

/**
 * Filters the log actually supports, newest year first and outcomes in their fixed
 * order. "All runs" always leads, and is kept even when the log is empty so the
 * list page always exists.
 */
export function refreshFilterOptions(log: RefreshLog): RefreshFilterOption[] {
  const years = [...new Set(log.map(runYear))].sort().reverse();
  const present = new Set(log.map(({ outcome }) => outcome));

  const candidates: RefreshFilter[] = [
    ALL_RUNS,
    ...years.map((value): RefreshFilter => ({ kind: 'year', value })),
    ...OUTCOME_ORDER.filter((outcome) => present.has(outcome))
      .map((value): RefreshFilter => ({ kind: 'outcome', value })),
  ];

  return candidates
    .map((filter) => ({
      filter,
      label: filterLabel(filter),
      count: log.filter((run) => matchesFilter(run, filter)).length,
    }))
    .filter(({ filter, count }) => filter.kind === 'all' || count > 0);
}

export function pageCount(total: number, pageSize = RUNS_PER_PAGE) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function buildView(
  log: RefreshLog,
  filter: RefreshFilter,
  page: number,
  pageSize = RUNS_PER_PAGE,
): RefreshView {
  const matching = filterRuns(log, filter);
  const start = (page - 1) * pageSize;
  const runs = matching.slice(start, start + pageSize);

  return {
    filter,
    page,
    totalPages: pageCount(matching.length, pageSize),
    totalRuns: matching.length,
    runs,
    firstShown: runs.length === 0 ? 0 : start + 1,
    lastShown: start + runs.length,
  };
}

/** Every page of every filter, which is exactly the set of routes to build. */
export function refreshViews(log: RefreshLog, pageSize = RUNS_PER_PAGE): RefreshView[] {
  return refreshFilterOptions(log).flatMap(({ filter, count }) =>
    Array.from({ length: pageCount(count, pageSize) }, (_, index) =>
      buildView(log, filter, index + 1, pageSize)));
}
