import { describe, expect, it } from 'vitest';
import type { TimelineEntry, TimelineFacets } from './timeline';
import {
  activeTimelineFilters,
  ALL_TIME,
  clearAllTimelineFilters,
  clearTimelineFilter,
  defaultTimelineState,
  deriveTimelineResults,
  entryInRange,
  filterTimelineEntries,
  hasActiveTimelineFilters,
  parseTimelineState,
  resolveTimelineRange,
  serializeTimelineState,
  timelineRangeOptions,
  toggleTimelineFilter,
  TIMELINE_FILTER_DIMENSIONS,
  type TimelineViewState,
} from './timeline-view';

function entry(
  id: string,
  date: string,
  datePrecision: TimelineEntry['datePrecision'],
  extra: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    id,
    kind: 'release',
    date,
    datePrecision,
    dateLabel: date,
    kindLabel: 'Released',
    modelName: id,
    modelSlug: id,
    route: `/models/${id}/`,
    creatorSlug: 'alpha',
    creatorName: 'Alpha Labs',
    categories: ['language-reasoning'],
    accessType: 'proprietary-hosted',
    accessTypeLabel: 'Hosted API',
    ...extra,
  };
}

const entries: TimelineEntry[] = [
  entry('old-alpha', '2023-05-01', 'day'),
  entry('mid-beta', '2025-06-15', 'day', {
    creatorSlug: 'beta',
    creatorName: 'Beta Corp',
    categories: ['image'],
    accessType: 'open-weight',
    accessTypeLabel: 'Open-weight',
  }),
  entry('mid-alpha-coding', '2025-09-30', 'day', {
    categories: ['coding', 'language-reasoning'],
  }),
  entry('year-only', '2025', 'year', { kind: 'event', kindLabel: 'Deprecated' }),
  entry('future-alpha', '2027-01-20', 'day'),
];

const facets: TimelineFacets = {
  creators: [
    { value: 'alpha', label: 'Alpha Labs', count: 4 },
    { value: 'beta', label: 'Beta Corp', count: 1 },
  ],
  categories: [
    { value: 'coding', label: 'Coding', count: 1 },
    { value: 'image', label: 'Image', count: 1 },
    { value: 'language-reasoning', label: 'Language and reasoning', count: 4 },
  ],
  accessTypes: [
    { value: 'open-weight', label: 'Open-weight', count: 1 },
    { value: 'proprietary-hosted', label: 'Hosted API', count: 4 },
  ],
};

const years = ['2027', '2025', '2023'];
const ranges = timelineRangeOptions(years);
const NOW = '2026-03-10';

function stateWith(overrides: Partial<TimelineViewState> = {}): TimelineViewState {
  return { ...defaultTimelineState(), ...overrides };
}

function idsFor(state: TimelineViewState, now: string | null = NOW) {
  return filterTimelineEntries(entries, state, ranges, now).map((item) => item.id);
}

describe('timelineRangeOptions', () => {
  it('offers all time, the relative windows, then one preset per year in the data', () => {
    expect(ranges.map((option) => option.value)).toEqual([
      'all', '12m', '24m', '2027', '2025', '2023',
    ]);
    expect(ranges.map((option) => option.label)).toEqual([
      'All time', 'Last 12 months', 'Last 24 months', '2027', '2025', '2023',
    ]);
  });

  it('offers no year preset when the data has no years', () => {
    expect(timelineRangeOptions([]).map((option) => option.value)).toEqual(['all', '12m', '24m']);
  });
});

describe('defaultTimelineState', () => {
  it('starts at year scale, all time, newest first, with nothing filtered', () => {
    expect(defaultTimelineState()).toEqual({
      filters: { creators: [], categories: [], accessTypes: [] },
      scale: 'year',
      range: 'all',
      order: 'newest',
    });
    expect(hasActiveTimelineFilters(defaultTimelineState())).toBe(false);
  });
});

describe('parseTimelineState', () => {
  it('reads the catalog’s own param names for the shared filter dimensions', () => {
    expect(TIMELINE_FILTER_DIMENSIONS.map((dimension) => dimension.param))
      .toEqual(['creator', 'category', 'access']);

    const state = parseTimelineState(
      '?creator=beta&category=image&access=open-weight&scale=month&range=2025&order=oldest',
      facets,
      ranges,
    );
    expect(state).toEqual({
      filters: { creators: ['beta'], categories: ['image'], accessTypes: ['open-weight'] },
      scale: 'month',
      range: '2025',
      order: 'oldest',
    });
  });

  it('drops a filter value the facets no longer know rather than trusting it', () => {
    const state = parseTimelineState('?creator=gone&creator=beta&category=nope', facets, ranges);
    expect(state.filters.creators).toEqual(['beta']);
    expect(state.filters.categories).toEqual([]);
  });

  it('drops a repeated value so one selection cannot be counted twice', () => {
    expect(parseTimelineState('?creator=beta&creator=beta', facets, ranges).filters.creators)
      .toEqual(['beta']);
  });

  it('falls back to the default for an unknown scale, range, or order', () => {
    const state = parseTimelineState('?scale=decade&range=2019&order=sideways', facets, ranges);
    expect(state.scale).toBe('year');
    expect(state.range).toBe(ALL_TIME);
    expect(state.order).toBe('newest');
  });

  it('reads an empty query as the default view', () => {
    expect(parseTimelineState('', facets, ranges)).toEqual(defaultTimelineState());
  });
});

describe('serializeTimelineState', () => {
  it('emits nothing for a pristine view', () => {
    expect(serializeTimelineState(defaultTimelineState(), facets)).toBe('');
  });

  it('emits only what differs from the default', () => {
    expect(serializeTimelineState(stateWith({ scale: 'quarter' }), facets)).toBe('?scale=quarter');
    expect(serializeTimelineState(stateWith({ range: '12m' }), facets)).toBe('?range=12m');
    expect(serializeTimelineState(stateWith({ order: 'oldest' }), facets)).toBe('?order=oldest');
  });

  it('writes filter values in facet order, so two routes to one selection copy alike', () => {
    const clickedInReverse = stateWith({
      filters: { creators: ['beta', 'alpha'], categories: [], accessTypes: [] },
    });
    expect(serializeTimelineState(clickedInReverse, facets)).toBe('?creator=alpha&creator=beta');
  });

  it('round-trips a full view through the query string', () => {
    const state = stateWith({
      filters: { creators: ['beta'], categories: ['image'], accessTypes: ['open-weight'] },
      scale: 'month',
      range: '2025',
      order: 'oldest',
    });
    const query = serializeTimelineState(state, facets);
    expect(parseTimelineState(query, facets, ranges)).toEqual(state);
  });
});

describe('resolveTimelineRange', () => {
  it('opens no window for all time', () => {
    expect(resolveTimelineRange(ALL_TIME, ranges, NOW))
      .toEqual({ from: null, year: null, label: 'All time' });
  });

  it('counts a relative window back from the reader’s clock', () => {
    expect(resolveTimelineRange('12m', ranges, NOW).from).toBe('2025-03-10');
    expect(resolveTimelineRange('24m', ranges, NOW).from).toBe('2024-03-10');
  });

  it('leaves a relative window unresolved with no clock, so the server renders all time', () => {
    expect(resolveTimelineRange('12m', ranges, null))
      .toEqual({ from: null, year: null, label: 'Last 12 months' });
  });

  it('resolves a year preset to that calendar year', () => {
    expect(resolveTimelineRange('2025', ranges, NOW))
      .toEqual({ from: null, year: '2025', label: '2025' });
  });

  it('falls back to all time for a range nobody offers', () => {
    expect(resolveTimelineRange('1999', ranges, NOW).label).toBe('All time');
  });
});

describe('entryInRange', () => {
  it('keeps a year-only entry that could still fall inside the window', () => {
    const bound = resolveTimelineRange('12m', ranges, NOW);
    expect(entryInRange(entry('year-only', '2025', 'year'), bound)).toBe(true);
    expect(entryInRange(entry('older', '2024', 'year'), bound)).toBe(false);
  });

  it('measures a month-precision entry by the end of its month', () => {
    const bound = { from: '2025-03-20', year: null, label: 'window' };
    expect(entryInRange(entry('march', '2025-03', 'month'), bound)).toBe(true);
  });
});

describe('filterTimelineEntries', () => {
  it('returns everything for the default state', () => {
    expect(idsFor(defaultTimelineState())).toEqual(entries.map((item) => item.id));
  });

  it('never cuts off the top of a relative window, so a future entry stays visible', () => {
    expect(idsFor(stateWith({ range: '12m' })))
      .toEqual(['mid-beta', 'mid-alpha-coding', 'year-only', 'future-alpha']);
  });

  it('limits a year preset to that calendar year, partial dates included', () => {
    expect(idsFor(stateWith({ range: '2025' })))
      .toEqual(['mid-beta', 'mid-alpha-coding', 'year-only']);
  });

  it('ignores a relative preset until a clock is available', () => {
    expect(idsFor(stateWith({ range: '12m' }), null)).toEqual(entries.map((item) => item.id));
  });

  it('unions the values inside one dimension and intersects across dimensions', () => {
    expect(idsFor(stateWith({
      filters: { creators: ['alpha', 'beta'], categories: [], accessTypes: [] },
    }))).toEqual(entries.map((item) => item.id));

    expect(idsFor(stateWith({
      filters: { creators: ['alpha'], categories: ['coding'], accessTypes: [] },
    }))).toEqual(['mid-alpha-coding']);

    expect(idsFor(stateWith({
      filters: { creators: ['beta'], categories: ['coding'], accessTypes: [] },
    }))).toEqual([]);
  });

  it('matches an entry on any one of its categories', () => {
    expect(idsFor(stateWith({
      filters: { creators: [], categories: ['language-reasoning'], accessTypes: [] },
    }))).toEqual(['old-alpha', 'mid-alpha-coding', 'year-only', 'future-alpha']);
  });

  it('filters by access type', () => {
    expect(idsFor(stateWith({
      filters: { creators: [], categories: [], accessTypes: ['open-weight'] },
    }))).toEqual(['mid-beta']);
  });

  it('combines a filter with a range', () => {
    expect(idsFor(stateWith({
      filters: { creators: ['alpha'], categories: [], accessTypes: [] },
      range: '2025',
    }))).toEqual(['mid-alpha-coding', 'year-only']);
  });
});

describe('activeTimelineFilters', () => {
  it('labels each selection with its facet wording, in facet order', () => {
    const state = stateWith({
      filters: { creators: ['beta'], categories: [], accessTypes: ['open-weight'] },
    });
    expect(activeTimelineFilters(state, facets)).toEqual([
      { key: 'creators', param: 'creator', dimensionLabel: 'Creator', value: 'beta', label: 'Beta Corp' },
      { key: 'accessTypes', param: 'access', dimensionLabel: 'Access', value: 'open-weight', label: 'Open-weight' },
    ]);
  });

  it('counts a non-default range as an active narrowing', () => {
    expect(hasActiveTimelineFilters(stateWith({ range: '2025' }))).toBe(true);
    expect(hasActiveTimelineFilters(stateWith({ scale: 'month', order: 'oldest' }))).toBe(false);
  });
});

describe('state transitions', () => {
  it('toggles one value on and off again', () => {
    const on = toggleTimelineFilter(defaultTimelineState(), 'creators', 'beta');
    expect(on.filters.creators).toEqual(['beta']);
    expect(toggleTimelineFilter(on, 'creators', 'beta').filters.creators).toEqual([]);
  });

  it('clears one value while leaving the rest of the selection alone', () => {
    const state = stateWith({
      filters: { creators: ['alpha', 'beta'], categories: ['image'], accessTypes: [] },
    });
    const cleared = clearTimelineFilter(state, 'creators', 'alpha');
    expect(cleared.filters.creators).toEqual(['beta']);
    expect(cleared.filters.categories).toEqual(['image']);
  });

  it('clears every filter and the range, keeping scale and order', () => {
    const state = stateWith({
      filters: { creators: ['alpha'], categories: ['image'], accessTypes: ['open-weight'] },
      scale: 'month',
      range: '2025',
      order: 'oldest',
    });
    expect(clearAllTimelineFilters(state)).toEqual(stateWith({ scale: 'month', order: 'oldest' }));
  });
});

describe('deriveTimelineResults', () => {
  it('reports the matches, the stops they group into, and the active filters', () => {
    const state = stateWith({ scale: 'year', range: '2025', order: 'newest' });
    const results = deriveTimelineResults(entries, state, facets, ranges, NOW);

    expect(results.total).toBe(3);
    expect(results.entries.map((item) => item.id))
      .toEqual(['mid-beta', 'mid-alpha-coding', 'year-only']);
    expect(results.stops.map((stop) => ({ label: stop.label, count: stop.count })))
      .toEqual([{ label: '2025', count: 3 }]);
    expect(results.range.label).toBe('2025');
    expect(results.active).toEqual([]);
  });

  it('groups the same matches differently per scale without losing one', () => {
    for (const scale of ['year', 'quarter', 'month'] as const) {
      const results = deriveTimelineResults(entries, stateWith({ scale }), facets, ranges, NOW);
      expect(results.total).toBe(entries.length);
      expect(results.stops.reduce((sum, stop) => sum + stop.count, 0)).toBe(entries.length);
    }
  });

  it('reports no stops and a zero total when nothing matches', () => {
    const results = deriveTimelineResults(
      entries,
      stateWith({ filters: { creators: ['beta'], categories: ['coding'], accessTypes: [] } }),
      facets,
      ranges,
      NOW,
    );
    expect(results.total).toBe(0);
    expect(results.stops).toEqual([]);
    expect(results.active.map((filter) => filter.label)).toEqual(['Beta Corp', 'Coding']);
  });
});
