import type { ModelRelease } from '../data/schema';
import type { ProviderReleaseRow } from './provider-profile';

/**
 * URL state for the current/legacy release filter on a provider page.
 *
 * The filter is one selected lifecycle status, or `all`. It lives in a query
 * parameter so a reload, a back or forward navigation, and a copied link all
 * restore the same view, and it is written without disturbing any other
 * parameter -- the lineage explorer on the same page owns `provider` and `model`
 * -- or the fragment, so the two pieces of URL state never clobber one another.
 */
export const RELEASE_STATUS_PARAM = 'status';

export type ReleaseStatusFilter = ModelRelease['status'] | 'all';

const RESOLVE_BASE = 'https://modeltree.local';

/**
 * Reads the filter out of a query string. An unknown value, or one for a status
 * this creator has no release in, falls back to `all` rather than showing an
 * empty list for a status that was never offered.
 */
export function parseReleaseStatusFilter(
  search: string,
  available: readonly ModelRelease['status'][],
): ReleaseStatusFilter {
  const candidate = new URLSearchParams(search).get(RELEASE_STATUS_PARAM);
  if (candidate && (available as readonly string[]).includes(candidate)) {
    return candidate as ModelRelease['status'];
  }
  return 'all';
}

/**
 * Writes the filter back onto a URL, leaving every other parameter and the
 * fragment untouched. `all` clears the parameter, so the unfiltered view has a
 * clean URL and never carries a redundant `status=all`.
 */
export function createReleaseFilterUrl(input: string | URL, filter: ReleaseStatusFilter): string {
  const url = input instanceof URL ? new URL(input) : new URL(input, RESOLVE_BASE);
  url.searchParams.delete(RELEASE_STATUS_PARAM);
  if (filter !== 'all') url.searchParams.set(RELEASE_STATUS_PARAM, filter);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The rows a filter selects. `all` returns every row, in the given order. */
export function filterReleaseRows(
  rows: readonly ProviderReleaseRow[],
  filter: ReleaseStatusFilter,
): ProviderReleaseRow[] {
  if (filter === 'all') return [...rows];
  return rows.filter((row) => row.release.status === filter);
}
