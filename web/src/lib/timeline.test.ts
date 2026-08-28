import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
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
  return {
    id,
    slug: id,
    organizationId,
    name: id,
    description: 'Fixture family.',
    categories,
    firstReleaseDate: '2023-01-01',
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
    }],
    publishers: [{ id: 'example', name: 'Example' }],
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
      }),
      release('beta-winter', 'beta', 'beta-one', '2025-11-05', {
        categories: ['image'],
        outputModalities: ['image'],
        accessType: 'both',
        license: { name: 'Llama-3', weightsDownloadable: true, osiApproved: false },
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
    expect(eventEntry.creatorName).toBe('Beta Corp');
    expect(eventEntry.modelName).toBe('beta-winter');
    expect(eventEntry.route).toBe('/models/beta-winter/');
    expect(eventEntry.categories).toEqual(['image']);
    expect(eventEntry.accessType).toBe('both');
    expect(eventEntry.accessTypeLabel).toBe('Hosted and open-weight');
  });

  it('counts facets over every entry, releases and events alike', () => {
    expect(index.facets.creators).toEqual([
      { value: 'alpha', label: 'Alpha Labs', count: 4 },
      { value: 'beta', label: 'Beta Corp', count: 2 },
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

describe('timelineDateCeiling', () => {
  it('measures a partial date by the latest instant it could still mean', () => {
    expect(timelineDateCeiling({ date: '2024-07-23', datePrecision: 'day' })).toBe('2024-07-23');
    expect(timelineDateCeiling({ date: '2024-07', datePrecision: 'month' })).toBe('2024-07-31');
    expect(timelineDateCeiling({ date: '2024', datePrecision: 'year' })).toBe('2024-12-31');
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
