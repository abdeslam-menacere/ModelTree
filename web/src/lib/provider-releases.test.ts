import { describe, expect, it } from 'vitest';
import type { ProviderReleaseRow } from './provider-profile';
import {
  RELEASE_STATUS_PARAM,
  createReleaseFilterUrl,
  filterReleaseRows,
  parseReleaseStatusFilter,
} from './provider-releases';

function row(id: string, status: ProviderReleaseRow['release']['status']): ProviderReleaseRow {
  return {
    release: {
      id,
      slug: id,
      status,
      // Only the fields the filter reads are needed here; the rest are irrelevant
      // to selecting rows and are omitted deliberately.
    } as ProviderReleaseRow['release'],
    familyName: 'Family',
    route: `/models/${id}/`,
  };
}

const rows: ProviderReleaseRow[] = [
  row('r-current', 'current'),
  row('r-legacy', 'legacy'),
  row('r-current-2', 'current'),
];

describe('parseReleaseStatusFilter', () => {
  it('reads a status the creator offers', () => {
    expect(parseReleaseStatusFilter(`?${RELEASE_STATUS_PARAM}=legacy`, ['current', 'legacy']))
      .toBe('legacy');
  });

  it('falls back to all when the parameter is absent', () => {
    expect(parseReleaseStatusFilter('', ['current', 'legacy'])).toBe('all');
  });

  it('falls back to all for a status this creator has no release in', () => {
    // "deprecated" is a real schema status, but if it was never offered the
    // filter must not select an empty list for it.
    expect(parseReleaseStatusFilter(`?${RELEASE_STATUS_PARAM}=deprecated`, ['current', 'legacy']))
      .toBe('all');
  });

  it('falls back to all for a value that is not a status at all', () => {
    expect(parseReleaseStatusFilter(`?${RELEASE_STATUS_PARAM}=banana`, ['current', 'legacy']))
      .toBe('all');
  });
});

describe('createReleaseFilterUrl', () => {
  it('writes a selected status onto the query', () => {
    expect(createReleaseFilterUrl('/providers/prime/', 'legacy'))
      .toBe(`/providers/prime/?${RELEASE_STATUS_PARAM}=legacy`);
  });

  it('clears the parameter for the all view rather than writing status=all', () => {
    expect(createReleaseFilterUrl(`/providers/prime/?${RELEASE_STATUS_PARAM}=legacy`, 'all'))
      .toBe('/providers/prime/');
  });

  it('leaves every other parameter and the fragment untouched', () => {
    const out = createReleaseFilterUrl(
      `/providers/prime/?provider=prime&model=x&${RELEASE_STATUS_PARAM}=current#tree`,
      'legacy',
    );
    const url = new URL(out, 'https://modeltree.local');
    expect(url.searchParams.get('provider')).toBe('prime');
    expect(url.searchParams.get('model')).toBe('x');
    expect(url.searchParams.get(RELEASE_STATUS_PARAM)).toBe('legacy');
    expect(url.hash).toBe('#tree');
  });

  it('preserves the lineage parameters when clearing the status back to all', () => {
    const out = createReleaseFilterUrl(
      `/providers/prime/?provider=prime&model=x&${RELEASE_STATUS_PARAM}=current#tree`,
      'all',
    );
    expect(out).toBe('/providers/prime/?provider=prime&model=x#tree');
  });

  it('accepts a URL as well as a string', () => {
    const out = createReleaseFilterUrl(new URL('https://modeltree.local/providers/prime/'), 'current');
    expect(out).toBe(`/providers/prime/?${RELEASE_STATUS_PARAM}=current`);
  });
});

describe('filterReleaseRows', () => {
  it('returns every row for the all filter, in order', () => {
    expect(filterReleaseRows(rows, 'all').map((r) => r.release.id))
      .toEqual(['r-current', 'r-legacy', 'r-current-2']);
  });

  it('returns only the rows matching a selected status', () => {
    expect(filterReleaseRows(rows, 'current').map((r) => r.release.id))
      .toEqual(['r-current', 'r-current-2']);
    expect(filterReleaseRows(rows, 'legacy').map((r) => r.release.id))
      .toEqual(['r-legacy']);
  });

  it('returns a copy so the caller cannot mutate the source rows', () => {
    const out = filterReleaseRows(rows, 'all');
    expect(out).not.toBe(rows);
    out.pop();
    expect(rows).toHaveLength(3);
  });
});
