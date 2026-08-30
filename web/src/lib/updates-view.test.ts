import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import { buildUpdateIndex, type UpdateRecord } from './updates';
import {
  activeUpdateFilters,
  anchorTargetId,
  clearAllUpdateFilters,
  clearUpdateFilter,
  defaultUpdateState,
  deriveUpdateResults,
  filterUpdateRecords,
  hasActiveUpdateFilters,
  hiddenAnchorRecord,
  parseUpdateState,
  serializeUpdateState,
  toggleUpdateFilter,
  UPDATE_FILTER_DIMENSIONS,
  type UpdateViewState,
} from './updates-view';

const index = buildUpdateIndex(seedDataset, '/');
const { records, facets } = index;

function stateWith(filters: Partial<UpdateViewState['filters']>): UpdateViewState {
  return { filters: { ...defaultUpdateState().filters, ...filters } };
}

function ids(list: readonly UpdateRecord[]): string[] {
  return list.map((record) => record.id);
}

describe('the ledger this suite reads is the real one', () => {
  it('has enough shape to make filtering observable', () => {
    // Guards every assertion below: on a dataset with one creator, a filter test
    // would pass whether or not filtering worked at all.
    expect(records.length).toBeGreaterThan(1);
    expect(facets.creators.length).toBeGreaterThan(1);
    expect(facets.categories.length).toBeGreaterThan(1);
  });
});

describe('a view has a URL, and the URL is the view', () => {
  it('reads nothing from an empty query string', () => {
    const state = parseUpdateState('', facets);

    expect(state).toEqual(defaultUpdateState());
    expect(hasActiveUpdateFilters(state)).toBe(false);
  });

  it('leaves the URL clean when nothing is selected', () => {
    expect(serializeUpdateState(defaultUpdateState(), facets)).toBe('');
  });

  it('round-trips every selection it accepts', () => {
    const creator = facets.creators[0].value;
    const category = facets.categories[0].value;
    const original = stateWith({ creators: [creator], categories: [category] });

    const query = serializeUpdateState(original, facets);

    expect(parseUpdateState(query, facets)).toEqual(original);
  });

  it('round-trips a multi-value selection', () => {
    const creators = facets.creators.slice(0, 2).map((facet) => facet.value);
    const original = stateWith({ creators });

    expect(parseUpdateState(serializeUpdateState(original, facets), facets)).toEqual(original);
  });

  it('spells its parameters the way the rest of the site spells them', () => {
    // A reader who has learned `?creator=` on /models has learned it here.
    expect(UPDATE_FILTER_DIMENSIONS.map((dimension) => dimension.param))
      .toEqual(['creator', 'category']);
  });

  it('does not filter by event type', () => {
    // Deliberate: a type filter could hide a deprecation from a reader who did
    // not think to ask for one. Types are shown as words on every record instead.
    expect(UPDATE_FILTER_DIMENSIONS.some((dimension) => dimension.param === 'type')).toBe(false);
  });

  it('writes the same URL however the reader arrived at the selection', () => {
    const [first, second] = facets.creators.slice(0, 2).map((facet) => facet.value);

    const forwards = serializeUpdateState(stateWith({ creators: [first, second] }), facets);
    const backwards = serializeUpdateState(stateWith({ creators: [second, first] }), facets);

    expect(backwards).toBe(forwards);
  });

  it('orders values by the facet, not by the click', () => {
    const values = facets.creators.slice(0, 2).map((facet) => facet.value);
    const query = serializeUpdateState(stateWith({ creators: [...values].reverse() }), facets);

    expect([...new URLSearchParams(query).getAll('creator')]).toEqual(values);
  });
});

describe('a link that has aged', () => {
  it('drops a creator the dataset no longer knows', () => {
    const state = parseUpdateState('?creator=a-creator-that-left', facets);

    expect(state.filters.creators).toEqual([]);
  });

  it('keeps the values it still recognises alongside one it does not', () => {
    const creator = facets.creators[0].value;
    const state = parseUpdateState(`?creator=${creator}&creator=gone`, facets);

    expect(state.filters.creators).toEqual([creator]);
  });

  it('shows the whole ledger rather than insisting nothing matches', () => {
    // The point of dropping rather than trusting: a stale link degrades to a
    // useful page, not an empty one.
    const state = parseUpdateState('?creator=gone&category=gone', facets);

    expect(filterUpdateRecords(records, state)).toHaveLength(records.length);
  });

  it('ignores a repeated value rather than double-counting it', () => {
    const creator = facets.creators[0].value;
    const state = parseUpdateState(`?creator=${creator}&creator=${creator}`, facets);

    expect(state.filters.creators).toEqual([creator]);
  });

  it('ignores parameters it does not define', () => {
    const state = parseUpdateState('?sort=oldest&page=3&type=deprecated', facets);

    expect(state).toEqual(defaultUpdateState());
  });
});

describe('filtering narrows the ledger without changing what a record says', () => {
  it('keeps only the selected creator', () => {
    const creator = facets.creators[0];
    const matches = filterUpdateRecords(records, stateWith({ creators: [creator.value] }));

    expect(matches).toHaveLength(creator.count);
    expect(matches.every((record) => record.creatorSlug === creator.value)).toBe(true);
  });

  it('treats several values in one dimension as "any of"', () => {
    const [first, second] = facets.creators.slice(0, 2);
    const matches = filterUpdateRecords(
      records,
      stateWith({ creators: [first.value, second.value] }),
    );

    expect(matches).toHaveLength(first.count + second.count);
  });

  it('treats values across dimensions as "all of"', () => {
    const creator = facets.creators[0].value;
    const category = facets.categories[0].value;
    const matches = filterUpdateRecords(records, stateWith({
      creators: [creator],
      categories: [category],
    }));

    for (const record of matches) {
      expect(record.creatorSlug).toBe(creator);
      expect(record.categories).toContain(category);
    }
  });

  it('preserves the newest-first order of whatever survives', () => {
    const creator = facets.creators[0].value;
    const matches = filterUpdateRecords(records, stateWith({ creators: [creator] }));
    const expected = records.filter((record) => record.creatorSlug === creator);

    expect(ids(matches)).toEqual(ids(expected));
  });

  it('can return nothing without breaking', () => {
    const impossible = stateWith({
      creators: [facets.creators[0].value],
      categories: [],
    });
    const other = facets.creators.find((facet) => facet.value !== facets.creators[0].value);

    expect(other).toBeDefined();

    const matches = filterUpdateRecords(
      filterUpdateRecords(records, impossible),
      stateWith({ creators: [other!.value] }),
    );

    expect(matches).toEqual([]);
  });
});

describe('the reader can see, and undo, what they selected', () => {
  it('names every active selection in facet wording', () => {
    const creator = facets.creators[0];
    const active = activeUpdateFilters(stateWith({ creators: [creator.value] }), facets);

    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      key: 'creators',
      param: 'creator',
      dimensionLabel: 'Creator',
      value: creator.value,
      label: creator.label,
    });
  });

  it('reports nothing active on a pristine view', () => {
    expect(activeUpdateFilters(defaultUpdateState(), facets)).toEqual([]);
    expect(hasActiveUpdateFilters(defaultUpdateState())).toBe(false);
  });

  it('toggles a value on and back off', () => {
    const creator = facets.creators[0].value;
    const on = toggleUpdateFilter(defaultUpdateState(), 'creators', creator);
    const off = toggleUpdateFilter(on, 'creators', creator);

    expect(on.filters.creators).toEqual([creator]);
    expect(off.filters.creators).toEqual([]);
    expect(off).toEqual(defaultUpdateState());
  });

  it('does not mutate the state it was handed', () => {
    const original = defaultUpdateState();
    toggleUpdateFilter(original, 'creators', facets.creators[0].value);

    expect(original.filters.creators).toEqual([]);
  });

  it('clears one selection without disturbing the others', () => {
    const [first, second] = facets.creators.slice(0, 2).map((facet) => facet.value);
    const category = facets.categories[0].value;
    const state = stateWith({ creators: [first, second], categories: [category] });

    const cleared = clearUpdateFilter(state, 'creators', first);

    expect(cleared.filters.creators).toEqual([second]);
    expect(cleared.filters.categories).toEqual([category]);
  });

  it('clears everything back to the pristine view', () => {
    expect(clearAllUpdateFilters()).toEqual(defaultUpdateState());
    expect(serializeUpdateState(clearAllUpdateFilters(), facets)).toBe('');
  });
});

describe('deriving what the page renders', () => {
  it('groups the filtered records rather than all of them', () => {
    const creator = facets.creators[0];
    const results = deriveUpdateResults(records, stateWith({ creators: [creator.value] }), facets);
    const grouped = results.years.flatMap((year) => year.months).flatMap((month) => month.records);

    expect(results.total).toBe(creator.count);
    expect(ids(grouped).sort()).toEqual(ids(results.records).sort());
  });

  it('reports the total of what survived, not of the ledger', () => {
    const creator = facets.creators[0];
    const results = deriveUpdateResults(records, stateWith({ creators: [creator.value] }), facets);

    expect(results.total).toBe(creator.count);
    expect(results.total).toBeLessThan(records.length);
  });

  it('carries the active selections through for the summary', () => {
    const creator = facets.creators[0];
    const results = deriveUpdateResults(records, stateWith({ creators: [creator.value] }), facets);

    expect(results.active.map((filter) => filter.value)).toEqual([creator.value]);
  });

  it('produces empty rails, not a crash, when nothing matches', () => {
    const results = deriveUpdateResults([], defaultUpdateState(), facets);

    expect(results.records).toEqual([]);
    expect(results.years).toEqual([]);
    expect(results.total).toBe(0);
  });
});

describe('a link to one update', () => {
  it('reads an event fragment', () => {
    expect(anchorTargetId('#event-abc')).toBe('event-abc');
    expect(anchorTargetId('event-abc')).toBe('event-abc');
  });

  it('ignores a fragment that names something else', () => {
    expect(anchorTargetId('#filters')).toBeNull();
    expect(anchorTargetId('')).toBeNull();
    expect(anchorTargetId('#')).toBeNull();
  });

  it('says when the filters have hidden the record the link points at', () => {
    const target = records[0];
    const visible = records.filter((record) => record.id !== target.id);

    expect(hiddenAnchorRecord(`#${target.anchorId}`, records, visible)).toBe(target);
  });

  it('says nothing when the record is on screen already', () => {
    const target = records[0];

    expect(hiddenAnchorRecord(`#${target.anchorId}`, records, records)).toBeNull();
  });

  it('says nothing about a fragment this ledger does not know', () => {
    // A mistyped or stale link is not a filtered-out record, and reporting it as
    // one would offer the reader a control that could not help them.
    expect(hiddenAnchorRecord('#event-never-existed', records, [])).toBeNull();
  });

  it('recovers the hidden record by clearing the filters', () => {
    const target = records[0];
    const other = facets.creators.find((facet) => facet.value !== target.creatorSlug);

    expect(other, 'the seed has a second creator to filter down to').toBeDefined();

    const filtered = filterUpdateRecords(records, stateWith({ creators: [other!.value] }));

    expect(hiddenAnchorRecord(`#${target.anchorId}`, records, filtered)).toBe(target);

    const recovered = filterUpdateRecords(records, clearAllUpdateFilters());

    expect(hiddenAnchorRecord(`#${target.anchorId}`, records, recovered)).toBeNull();
  });
});
