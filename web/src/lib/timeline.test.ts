import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import { precisionOf } from '../data/partial-date';
import type { Dataset } from '../data/schema';
import { validateDataset } from '../data/validate';
import {
  buildTimelineIndex,
  groupTimelineEntries,
  timelineDateCeiling,
  TimelineIndexError,
  type TimelineEntry,
  type TimelineScale,
} from './timeline';
import { entryInRange } from './timeline-view';

function release(
  id: string,
  organizationId: string,
  familyId: string,
  releaseDate: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    slug: id,
    canonicalName: id,
    displayName: id,
    organizationId,
    familyId,
    version: '1',
    variant: 'Standard',
    releaseDate,
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    summary: 'A fixture release.',
    intendedUse: 'Fixture use.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
    ...extra,
  };
}

function event(
  id: string,
  releaseId: string,
  date: string,
  datePrecision: 'year' | 'month' | 'day',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    releaseId,
    type: 'api-available',
    date,
    datePrecision,
    note: 'A fixture event.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
    ...extra,
  };
}

function organization(id: string, name: string): Record<string, unknown> {
  return {
    id,
    slug: id,
    name,
    shortName: name.split(' ')[0],
    type: 'company',
    website: `https://${id}.example/`,
    releasePage: `https://${id}.example/news`,
    description: 'Fixture creator.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
  };
}

function family(id: string, organizationId: string, categories: string[]): Record<string, unknown> {
  const firstReleaseDate = '2023-01-01';
  return {
    id,
    slug: id,
    organizationId,
    name: id,
    description: 'Fixture family.',
    categories,
    firstReleaseDate,
    // Derived rather than stated: these families exist to carry releases, and no
    // assertion here turns on their precision.
    datePrecision: precisionOf(firstReleaseDate),
    status: 'current',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
  };
}

function fixture(overrides: Record<string, unknown> = {}): Dataset {
  return validateDataset({
    sources: [{
      id: 'src-a',
      url: 'https://example.com/a',
      title: 'Announcement',
      type: 'official-announcement',
      publisherId: 'example',
      lastCheckedDate: '2026-01-01',
    }, {
      // A release recording `license.osiApproved` has to cite OSI at either
      // value, so the two licence-bearing fixtures below carry this.
      id: 'osi-list',
      url: 'https://opensource.org/licenses',
      title: 'OSI Approved Licenses',
      type: 'official-docs',
      publisherId: 'open-source-initiative',
      lastCheckedDate: '2026-01-01',
    }],
    publishers: [
      { id: 'example', name: 'Example' },
      { id: 'open-source-initiative', name: 'Open Source Initiative' },
    ],
    organizations: [organization('alpha', 'Alpha Labs'), organization('beta', 'Beta Corp')],
    families: [
      family('alpha-one', 'alpha', ['language-reasoning']),
      family('beta-one', 'beta', ['image']),
    ],
    releases: [
      release('alpha-spring', 'alpha', 'alpha-one', '2024-03-14'),
      release('alpha-summer', 'alpha', 'alpha-one', '2024-07-23', {
        accessType: 'open-weight',
        license: { name: 'Apache-2.0', weightsDownloadable: true, osiApproved: false },
        sourceIds: ['src-a', 'osi-list'],
      }),
      release('beta-winter', 'beta', 'beta-one', '2025-11-05', {
        categories: ['image'],
        outputModalities: ['image'],
        accessType: 'both',
        license: { name: 'Llama-3', weightsDownloadable: true, osiApproved: false },
        sourceIds: ['src-a', 'osi-list'],
      }),
    ],
    releaseEvents: [
      event('alpha-spring-ga', 'alpha-spring', '2024-05-02', 'day', {
        type: 'generally-available',
      }),
      event('alpha-summer-month', 'alpha-summer', '2024-09', 'month'),
      event('beta-winter-year', 'beta-winter', '2025', 'year', { type: 'deprecated' }),
    ],
    ...overrides,
  });
}

const index = buildTimelineIndex(fixture(), '/');
const entryById = new Map(index.entries.map((entry) => [entry.id, entry]));

/**
 * A release a source dated only to the year.
 *
 * This fixture used to prove the opposite point: it paired `datePrecision:
 * 'year'` with a full `2024-03-15`, because `releaseDate` was an `isoDate` and
 * `validateDataset` checked date-against-precision for release events only, so
 * the incoherent pair validated and the timeline had to narrow it itself.
 * abdeslam-menacere/ModelTree#468 closed that: `releaseDate` is now a
 * `partialDate` and the pairing is enforced for releases too, so a year-precision
 * release says `2024` and nothing else can be stored. The assertions below are
 * unchanged — a coarse release must still keep its ceiling, its label and its
 * stop — but they now run against the honest shape rather than the padded one.
 */
const coarseIndex = (() => {
  const base = fixture();
  return buildTimelineIndex(validateDataset({
    ...base,
    releases: [
      ...base.releases,
      release('alpha-undated', 'alpha', 'alpha-one', '2024', { datePrecision: 'year' }),
    ],
  }), '/');
})();

const coarseEntry = (() => {
  const found = coarseIndex.entries.find((item) => item.id === 'release:alpha-undated');
  if (!found) throw new Error('fixture has no year-precision release entry');
  return found;
})();

function entry(id: string): TimelineEntry {
  const found = entryById.get(id);
  if (!found) throw new Error(`fixture has no timeline entry "${id}"`);
  return found;
}

function labelsAt(scale: TimelineScale) {
  return groupTimelineEntries(index.entries, scale, 'oldest').map((stop) => stop.label);
}

describe('buildTimelineIndex', () => {
  it('produces one entry per release and one per release event, with namespaced ids', () => {
    expect(index.entries).toHaveLength(6);
    expect(index.entries.map((item) => item.id)).toEqual([
      'release:alpha-spring',
      'event:alpha-spring-ga',
      'release:alpha-summer',
      'event:alpha-summer-month',
      'event:beta-winter-year',
      'release:beta-winter',
    ]);
    expect(new Set(index.entries.map((item) => item.id)).size).toBe(index.entries.length);
  });

  it('orders entries earliest first, with a coarser date ahead of the dates inside it', () => {
    expect(index.entries.map((item) => item.date)).toEqual([
      '2024-03-14',
      '2024-05-02',
      '2024-07-23',
      '2024-09',
      '2025',
      '2025-11-05',
    ]);
  });

  it('labels a release entry as released and an event entry by its own type', () => {
    expect(entry('release:alpha-spring').kindLabel).toBe('Released');
    expect(entry('release:alpha-spring').kind).toBe('release');
    expect(entry('event:alpha-spring-ga').kindLabel).toBe('Generally available');
    expect(entry('event:beta-winter-year').kindLabel).toBe('Deprecated');
    expect(entry('event:beta-winter-year').kind).toBe('event');
  });

  it('never prints a date more precisely than its source stated it', () => {
    // Rendered through the same precision-aware formatter the rest of the site
    // uses, so one date reads the same way on every page.
    expect(entry('release:alpha-summer').dateLabel).toBe('Jul 23, 2024');
    expect(entry('event:alpha-summer-month').dateLabel).toBe('Sep 2024');
    expect(entry('event:beta-winter-year').dateLabel).toBe('2025');
    expect(entry('event:beta-winter-year').date).toBe('2025');
  });

  it('credits an event to the creator of the model, carrying the release facets over', () => {
    const eventEntry = entry('event:beta-winter-year');
    expect(eventEntry.creatorSlug).toBe('beta');
    // The label, not the recorded name: this fixture records "Beta Corp" with a
    // short form of "Beta", and the timeline prints what every other surface
    // prints (abdeslam-menacere/ModelTree#479).
    expect(eventEntry.creatorName).toBe('Beta');
    expect(eventEntry.modelName).toBe('beta-winter');
    expect(eventEntry.route).toBe('/models/beta-winter/');
    expect(eventEntry.categories).toEqual(['image']);
    expect(eventEntry.accessType).toBe('both');
    expect(eventEntry.accessTypeLabel).toBe('Hosted and open-weight');
  });

  it('counts facets over every entry, releases and events alike', () => {
    expect(index.facets.creators).toEqual([
      // Labelled by the creator label, because the chip is counted off the
      // entries and a filter that reads differently from the rows it filters is
      // the defect in #479 wearing a different hat.
      { value: 'alpha', label: 'Alpha', count: 4 },
      { value: 'beta', label: 'Beta', count: 2 },
    ]);
    expect(index.facets.categories).toEqual([
      { value: 'image', label: 'Image', count: 2 },
      { value: 'language-reasoning', label: 'Language and reasoning', count: 4 },
    ]);
    expect(index.facets.accessTypes.map((facet) => facet.value))
      .toEqual(['both', 'open-weight', 'proprietary-hosted']);
  });

  it('lists every year the entries touch, newest first', () => {
    expect(index.years).toEqual(['2025', '2024']);
  });

  it('honours the base path when building passport routes', () => {
    const based = buildTimelineIndex(fixture(), '/ModelTree/');
    expect(based.entries[0].route).toBe('/ModelTree/models/alpha-spring/');
  });

  it('refuses an event that points at no release rather than dropping it silently', () => {
    const broken = {
      ...fixture(),
      releaseEvents: [{ ...event('orphan', 'nobody', '2025-01-01', 'day') }],
    } as unknown as Dataset;
    expect(() => buildTimelineIndex(broken)).toThrow(TimelineIndexError);
    expect(() => buildTimelineIndex(broken)).toThrow(/references missing release "nobody"/);
  });
});

/**
 * Whether a `YYYY-MM-DD` string names a day the calendar has, checked by
 * round-tripping through `Date.UTC`: JavaScript normalises an overflowing day
 * into the following month, so a value that survives unchanged is real and
 * `2024-02-31` is not.
 */
function isRealCalendarDate(value: string): boolean {
  const parts = value.split('-');
  if (parts.length !== 3) return false;
  const [year, month, day] = parts.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

describe('timelineDateCeiling', () => {
  it('measures a partial date by the latest instant it could still mean', () => {
    expect(timelineDateCeiling({ date: '2024-07-23', datePrecision: 'day' })).toBe('2024-07-23');
    expect(timelineDateCeiling({ date: '2024-07', datePrecision: 'month' })).toBe('2024-07-31');
    expect(timelineDateCeiling({ date: '2024', datePrecision: 'year' })).toBe('2024-12-31');
  });

  it('measures a coarse release the same way, from the date the index actually stored', () => {
    // Reading the ceiling off an untrimmed `2024-03-15` would yield the
    // unordered "2024-03-15-12-31" and hide the entry from any window opening
    // later in its own year.
    expect(timelineDateCeiling(coarseEntry)).toBe('2024-12-31');
  });

  it('names a day the calendar actually has, for the months a hardcoded 31 got wrong', () => {
    // The ceiling used to be built as `${date}-31` for every month, so these
    // three returned 2024-04-31, 2024-02-31 and 2023-02-31 — strings that order
    // like dates but that no calendar accepts.
    expect(timelineDateCeiling({ date: '2024-04', datePrecision: 'month' })).toBe('2024-04-30');
    expect(timelineDateCeiling({ date: '2024-02', datePrecision: 'month' })).toBe('2024-02-29');
    expect(timelineDateCeiling({ date: '2023-02', datePrecision: 'month' })).toBe('2023-02-28');
  });

  it('applies the century rule to February rather than testing divisibility by four', () => {
    expect(timelineDateCeiling({ date: '2100-02', datePrecision: 'month' })).toBe('2100-02-28');
    expect(timelineDateCeiling({ date: '2000-02', datePrecision: 'month' })).toBe('2000-02-29');
  });

  it('rolls over the year at a month-precision December instead of overflowing it', () => {
    // Deriving the month end by stepping back from the first of the *next*
    // month is the natural fix and the natural place to get December wrong, so
    // the rollover is pinned separately from the short-month cases above.
    expect(timelineDateCeiling({ date: '2024-12', datePrecision: 'month' })).toBe('2024-12-31');
    expect(timelineDateCeiling({ date: '2023-12', datePrecision: 'month' })).toBe('2023-12-31');
  });

  it('returns a real calendar date for every month of a leap and a non-leap year', () => {
    // Expected lengths are written out rather than derived, so the assertion
    // cannot agree with the implementation by sharing its arithmetic.
    const lengths: Record<number, number[]> = {
      2023: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
      2024: [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    };

    // Control for the round-trip check itself: it has to be capable of both
    // answers, or "every ceiling is real" would be a claim it cannot refute.
    expect(isRealCalendarDate('2024-02-29')).toBe(true);
    expect(isRealCalendarDate('2024-02-31')).toBe(false);
    expect(isRealCalendarDate('2023-02-29')).toBe(false);

    for (const [year, monthLengths] of Object.entries(lengths)) {
      monthLengths.forEach((lastDay, index) => {
        const date = `${year}-${String(index + 1).padStart(2, '0')}`;
        const ceiling = timelineDateCeiling({ date, datePrecision: 'month' });
        expect(ceiling).toBe(`${date}-${String(lastDay).padStart(2, '0')}`);
        expect(isRealCalendarDate(ceiling)).toBe(true);
      });
    }
  });

  it('measures a date finer than its precision by what the precision claims', () => {
    // `buildTimelineIndex` trims before storing, but the function is exported
    // and takes any entry, so a mismatched pair must still yield an ordered
    // date rather than "2024-03-15-31".
    expect(timelineDateCeiling({ date: '2024-03-15', datePrecision: 'month' })).toBe('2024-03-31');
    expect(timelineDateCeiling({ date: '2024-03-15', datePrecision: 'year' })).toBe('2024-12-31');
  });
});

describe('a release whose precision claims less than its stored date', () => {
  it('stores only the segments the precision claims, so no consumer sees a day', () => {
    expect(coarseEntry.date).toBe('2024');
    expect(coarseEntry.datePrecision).toBe('year');
  });

  it('renders that date no more precisely than the precision allows', () => {
    expect(coarseEntry.dateLabel).toBe('2024');
  });

  it('survives a relative window that opens later in its own year', () => {
    // The end-to-end shape of the bug: an untrimmed date gives a ceiling that
    // sorts below any real bound, so the entry would vanish from a window it
    // could genuinely fall in.
    expect(entryInRange(coarseEntry, { from: '2024-06-01', year: null, label: 'window' }))
      .toBe(true);
    expect(entryInRange(coarseEntry, { from: '2025-01-01', year: null, label: 'window' }))
      .toBe(false);
  });

  it('still sorts and groups as a year-precision entry', () => {
    expect(coarseIndex.entries.map((item) => item.date)).toEqual([
      '2024',
      '2024-03-14',
      '2024-05-02',
      '2024-07-23',
      '2024-09',
      '2025',
      '2025-11-05',
    ]);
    const stops = groupTimelineEntries(coarseIndex.entries, 'month', 'oldest');
    const undated = stops.find((stop) => stop.key === '2024:undated');
    expect(undated?.imprecise).toBe(true);
    expect(undated?.entries.map((item) => item.id)).toContain('release:alpha-undated');
  });
});

describe('groupTimelineEntries', () => {
  it('groups into calendar years at year scale', () => {
    const stops = groupTimelineEntries(index.entries, 'year', 'oldest');
    expect(stops.map((stop) => stop.label)).toEqual(['2024', '2025']);
    expect(stops.map((stop) => stop.count)).toEqual([4, 2]);
    expect(stops.every((stop) => stop.imprecise === false)).toBe(true);
  });

  it('groups into quarters, reading the quarter from a month-precision date', () => {
    expect(labelsAt('quarter')).toEqual(['Q1 2024', 'Q2 2024', 'Q3 2024', 'Q4 2025', '2025 · quarter not given']);
  });

  it('groups into months', () => {
    expect(labelsAt('month')).toEqual(['Mar 2024', 'May 2024', 'Jul 2024', 'Sep 2024', 'Nov 2025', '2025 · month not given']);
  });

  it('keeps a year-only entry inside its year under a stop that says the month is missing', () => {
    const stops = groupTimelineEntries(index.entries, 'month', 'oldest');
    const imprecise = stops.find((stop) => stop.imprecise);
    expect(imprecise).toBeDefined();
    expect(imprecise!.key).toBe('2025:undated');
    expect(imprecise!.note).toBe('These sources state 2025 only, so the month is not given.');
    expect(imprecise!.entries.map((item) => item.id)).toEqual(['event:beta-winter-year']);
  });

  it('never drops an entry, whatever the scale', () => {
    for (const scale of ['year', 'quarter', 'month'] as TimelineScale[]) {
      const stops = groupTimelineEntries(index.entries, scale, 'newest');
      const grouped = stops.flatMap((stop) => stop.entries);
      expect(grouped).toHaveLength(index.entries.length);
      expect(new Set(grouped.map((item) => item.id))).toEqual(
        new Set(index.entries.map((item) => item.id)),
      );
      expect(stops.reduce((total, stop) => total + stop.count, 0)).toBe(index.entries.length);
    }
  });

  it('makes the two orders exact mirrors of one another', () => {
    for (const scale of ['year', 'quarter', 'month'] as TimelineScale[]) {
      const newest = groupTimelineEntries(index.entries, scale, 'newest')
        .flatMap((stop) => stop.entries.map((item) => item.id));
      const oldest = groupTimelineEntries(index.entries, scale, 'oldest')
        .flatMap((stop) => stop.entries.map((item) => item.id));
      expect(newest).toEqual([...oldest].reverse());
    }
  });

  it('returns no stops for no entries', () => {
    expect(groupTimelineEntries([], 'month', 'newest')).toEqual([]);
  });
});

describe('the reviewed dataset', () => {
  const seed = buildTimelineIndex(seedDataset, '/');

  it('places every release and every release event on the timeline', () => {
    expect(seed.entries).toHaveLength(
      seedDataset.releases.length + seedDataset.releaseEvents.length,
    );
    expect(seed.entries.filter((item) => item.kind === 'release')).toHaveLength(
      seedDataset.releases.length,
    );
    expect(seed.entries.filter((item) => item.kind === 'event')).toHaveLength(
      seedDataset.releaseEvents.length,
    );
  });

  it('routes every entry to a passport the build generates', () => {
    const slugs = new Set(seedDataset.releases.map((item) => item.slug));
    for (const item of seed.entries) {
      expect(slugs.has(item.modelSlug)).toBe(true);
      expect(item.route).toBe(`/models/${item.modelSlug}/`);
    }
  });

  it('offers a range preset for every year the data touches', () => {
    const years = new Set(seed.entries.map((item) => item.date.slice(0, 4)));
    expect(new Set(seed.years)).toEqual(years);
    expect(seed.years).toEqual([...seed.years].sort().reverse());
  });
});
