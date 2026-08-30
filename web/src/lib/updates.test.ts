import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import type { Dataset, ReleaseEvent } from '../data/schema';
import { validateDataset } from '../data/validate';
import { releaseEventTypeLabel } from './provider-profile';
import {
  buildUpdateIndex,
  groupUpdatesByPeriod,
  measureUpdatesPayload,
  updateAnchorId,
  UpdatesIndexError,
  type UpdateRecord,
} from './updates';

// ---------------------------------------------------------------------------
// Fixtures. Everything is built through `validateDataset`, so a test can never
// assert against a shape the schema would reject, and a schema change that
// invalidates these records fails here rather than passing quietly.
// ---------------------------------------------------------------------------

const BASE = '/';

function source(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Source ${id}`,
    type: 'official-announcement',
    publisherId: 'pub',
    lastCheckedDate: '2026-08-28',
    ...extra,
  };
}

function release(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    slug: id,
    canonicalName: id,
    displayName: id.toUpperCase(),
    organizationId: 'org',
    familyId: 'fam',
    version: '1',
    variant: 'Standard',
    releaseDate: '2026-01-01',
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
    verifiedAt: '2026-08-28',
    ...extra,
  };
}

function event(
  id: string,
  date: string,
  datePrecision: 'year' | 'month' | 'day',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    releaseId: 'rel-a',
    type: 'generally-available',
    date,
    datePrecision,
    note: `Change ${id}.`,
    sourceIds: ['src-a'],
    verifiedAt: '2026-08-28',
    ...extra,
  };
}

function organization(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    slug: id,
    name: `${id} Incorporated`,
    shortName: id.toUpperCase(),
    type: 'company',
    website: 'https://example.com/',
    releasePage: 'https://example.com/news',
    description: 'Fixture creator.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-08-28',
    ...extra,
  };
}

function makeDataset(overrides: Record<string, unknown> = {}): Dataset {
  return validateDataset({
    sources: [source('src-a'), source('src-b', { type: 'model-card' })],
    publishers: [{ id: 'pub', name: 'Example Publisher' }],
    organizations: [organization('org')],
    families: [
      {
        id: 'fam',
        slug: 'fam',
        organizationId: 'org',
        name: 'Fam',
        description: 'Fixture family.',
        categories: ['language-reasoning'],
        firstReleaseDate: '2026-01-01',
        datePrecision: 'day',
        status: 'current',
        sourceIds: ['src-a'],
        verifiedAt: '2026-08-28',
      },
    ],
    releases: [release('rel-a')],
    releaseEvents: [],
    ...overrides,
  });
}

/**
 * A dataset holding one event of every recorded type.
 *
 * This exists because the seed holds only three of the seven. An assertion over
 * the seed alone would pass today while saying nothing about `announced`,
 * `deprecated`, `retired` or `corrected`, and would keep passing on the day one
 * of them is added rendering identically to a GA event. The acceptance criterion
 * is about all six named kinds staying distinguishable, so the fixture supplies
 * the ones the data has not reached yet.
 */
const ALL_EVENT_TYPES: readonly ReleaseEvent['type'][] = [
  'announced',
  'preview',
  'api-available',
  'generally-available',
  'deprecated',
  'retired',
  'corrected',
];

function everyTypeDataset(): Dataset {
  return makeDataset({
    releaseEvents: ALL_EVENT_TYPES.map((type, index) => event(
      `evt-${type}`,
      `2026-0${index + 1}-05`,
      'day',
      { type },
    )),
  });
}

function ids(records: readonly UpdateRecord[]): string[] {
  return records.map((record) => record.id);
}

// ---------------------------------------------------------------------------

describe('an event is resolved to something a reader can check', () => {
  it('carries the note, the sources, the model, the creator and both dates', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [event('evt-a', '2026-08-12', 'day', { sourceIds: ['src-a', 'src-b'] })],
    }), BASE);

    const [record] = index.records;

    expect(record.note).toBe('Change evt-a.');
    expect(record.modelName).toBe('REL-A');
    expect(record.modelRoute).toBe('/models/rel-a/');
    expect(record.creatorName).toBe('ORG');
    expect(record.creatorSlug).toBe('org');
    expect(record.date).toBe('2026-08-12');
    expect(record.verifiedAt).toBe('2026-08-28');
    expect(record.sources.map((item) => item.title)).toEqual(['Source src-a', 'Source src-b']);
    expect(record.sources[0].publisherName).toBe('Example Publisher');
  });

  it('gives every record an anchor derived from its own event id', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [event('evt-a', '2026-08-12', 'day')],
    }), BASE);

    expect(index.records[0].anchorId).toBe(updateAnchorId('evt-a'));
    expect(index.records[0].anchorId).toBe('event-evt-a');
  });

  it('respects the deployed base path when routing to the affected model', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [event('evt-a', '2026-08-12', 'day')],
    }), '/probe/');

    expect(index.records[0].modelRoute).toBe('/probe/models/rel-a/');
  });

  it('shows the verification date as a separate fact from the event date', () => {
    // The issue's non-goal, made observable: the two dates are different values
    // on the record, differently labelled, and neither is derived from the other.
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [event('evt-a', '2025-01-02', 'day', { verifiedAt: '2026-08-28' })],
    }), BASE);

    const [record] = index.records;

    expect(record.date).toBe('2025-01-02');
    expect(record.verifiedAt).toBe('2026-08-28');
    expect(record.dateLabel).not.toBe(record.verifiedAtLabel);
  });
});

describe('the six named kinds of change stay distinguishable', () => {
  it('gives every recorded event type its own explicit label', () => {
    const index = buildUpdateIndex(everyTypeDataset(), BASE);
    const labels = index.records.map((record) => record.typeLabel);

    expect(index.records).toHaveLength(ALL_EVENT_TYPES.length);
    expect(new Set(labels).size).toBe(ALL_EVENT_TYPES.length);

    for (const label of labels) {
      expect(label.trim()).not.toBe('');
    }
  });

  it('covers the four types the seed dataset does not yet contain', () => {
    // Guard against this suite quietly narrowing to whatever the data holds.
    const seedTypes = new Set(seedDataset.releaseEvents.map((item) => item.type));
    const missingFromSeed = ALL_EVENT_TYPES.filter((type) => !seedTypes.has(type));

    expect(missingFromSeed.length).toBeGreaterThan(0);

    const fixtureTypes = new Set(buildUpdateIndex(everyTypeDataset(), BASE)
      .records.map((record) => record.type));

    for (const type of missingFromSeed) {
      expect(fixtureTypes.has(type), `fixture must exercise "${type}"`).toBe(true);
    }
  });

  it('labels each type the way the rest of the site labels it', () => {
    for (const record of buildUpdateIndex(everyTypeDataset(), BASE).records) {
      expect(record.typeLabel).toBe(releaseEventTypeLabel(record.type));
    }
  });

  it('keeps a deprecation from reading as an availability change', () => {
    const index = buildUpdateIndex(everyTypeDataset(), BASE);
    const byType = new Map(index.records.map((record) => [record.type, record]));

    expect(byType.get('deprecated')?.typeLabel).not.toBe(byType.get('generally-available')?.typeLabel);
    expect(byType.get('retired')?.typeLabel).not.toBe(byType.get('deprecated')?.typeLabel);
    expect(byType.get('corrected')?.typeLabel).not.toBe(byType.get('announced')?.typeLabel);
  });

  it('counts every present type in the legend facet', () => {
    const index = buildUpdateIndex(everyTypeDataset(), BASE);

    expect(index.facets.types.map((facet) => facet.value).sort())
      .toEqual([...ALL_EVENT_TYPES].sort());
    expect(index.facets.types.every((facet) => facet.count === 1)).toBe(true);
  });
});

describe('recency is the source\'s date, never ours', () => {
  it('orders newest first by the event date', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-old', '2024-03-01', 'day'),
        event('evt-new', '2026-08-12', 'day'),
        event('evt-mid', '2025-06-30', 'day'),
      ],
    }), BASE);

    expect(ids(index.records)).toEqual(['evt-new', 'evt-mid', 'evt-old']);
  });

  it('does not let a fresh re-check promote an old change', () => {
    // The heart of the non-goal. `validateDataset` requires `verifiedAt` to be
    // on or after the event, so the sharpest legal form of this is: the *older*
    // change is the one re-checked most recently.
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-old', '2024-03-01', 'day', { verifiedAt: '2026-08-28' }),
        event('evt-new', '2026-08-12', 'day', { verifiedAt: '2026-08-13' }),
      ],
    }), BASE);

    expect(ids(index.records)).toEqual(['evt-new', 'evt-old']);
  });

  it('places a partial date at the earliest day it could mean, never ahead of a dated one', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-year', '2026', 'year'),
        event('evt-day', '2026-08-12', 'day'),
      ],
    }), BASE);

    // `2026` could be any day in 2026, so it must not outrank a change the
    // sources actually dated to August.
    expect(ids(index.records)).toEqual(['evt-day', 'evt-year']);
  });

  it('breaks a tie on event id, so equal dates never reorder between builds', () => {
    const forwards = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-b', '2026-08-12', 'day'),
        event('evt-a', '2026-08-12', 'day'),
      ],
    }), BASE);
    const backwards = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day'),
        event('evt-b', '2026-08-12', 'day'),
      ],
    }), BASE);

    expect(ids(forwards.records)).toEqual(['evt-a', 'evt-b']);
    expect(ids(backwards.records)).toEqual(ids(forwards.records));
  });

  it('reports the latest verification stamp without treating it as a date of change', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-a', '2024-03-01', 'day', { verifiedAt: '2026-08-28' }),
        event('evt-b', '2026-08-12', 'day', { verifiedAt: '2026-08-13' }),
      ],
    }), BASE);

    // The ledger's newest verification belongs to its *oldest* change, and the
    // ordering is unmoved by that.
    expect(index.latestVerifiedAt).toBe('2026-08-28');
    expect(ids(index.records)[0]).toBe('evt-b');
  });
});

describe('no event is emitted twice', () => {
  it('emits exactly one record per event, whatever the models involved', () => {
    const index = buildUpdateIndex(makeDataset({
      releases: [release('rel-a'), release('rel-b')],
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day', { releaseId: 'rel-a' }),
        event('evt-b', '2026-08-12', 'day', { releaseId: 'rel-b' }),
      ],
    }), BASE);

    expect(ids(index.records)).toEqual(['evt-a', 'evt-b']);
    expect(new Set(ids(index.records)).size).toBe(index.records.length);
  });

  it('refuses a repeated event id rather than rendering it twice', () => {
    // `validateDataset` may not police this pairing, so the index does. A
    // duplicate id would render twice and appear twice in the changelog, and
    // nothing downstream could tell the two apart.
    const raw = makeDataset({
      releaseEvents: [event('evt-a', '2026-08-12', 'day')],
    });
    const duplicated: Dataset = {
      ...raw,
      releaseEvents: [...raw.releaseEvents, ...raw.releaseEvents],
    };

    expect(() => buildUpdateIndex(duplicated, BASE)).toThrow(UpdatesIndexError);
    expect(() => buildUpdateIndex(duplicated, BASE)).toThrow(/recorded more than once/);
  });

  it('emits every seed event exactly once', () => {
    const index = buildUpdateIndex(seedDataset, BASE);

    expect(seedDataset.releaseEvents.length).toBeGreaterThan(0);
    expect(index.records).toHaveLength(seedDataset.releaseEvents.length);
    expect(new Set(ids(index.records)).size).toBe(index.records.length);
  });
});

describe('one announcement covering several models', () => {
  it('keeps each model its own record and cross-references the others', () => {
    const index = buildUpdateIndex(makeDataset({
      releases: [release('rel-a'), release('rel-b')],
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day', { releaseId: 'rel-a' }),
        event('evt-b', '2026-08-12', 'day', { releaseId: 'rel-b' }),
      ],
    }), BASE);

    expect(index.records).toHaveLength(2);

    const [first, second] = index.records;

    expect(first.companions.map((companion) => companion.modelName)).toEqual([second.modelName]);
    expect(second.companions.map((companion) => companion.modelName)).toEqual([first.modelName]);
    expect(first.companions[0].anchorId).toBe(second.anchorId);
  });

  it('does not cross-reference a record to its own model', () => {
    // Two lifecycle steps for one model from one publication are not one
    // announcement seen twice, and pointing a reader back at the model they are
    // already reading about would say nothing.
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day', { type: 'preview' }),
        event('evt-b', '2026-08-12', 'day', { type: 'generally-available' }),
      ],
    }), BASE);

    for (const record of index.records) {
      expect(record.companions).toEqual([]);
    }
  });

  it('does not relate events that share a date but not a source', () => {
    const index = buildUpdateIndex(makeDataset({
      releases: [release('rel-a'), release('rel-b')],
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day', { releaseId: 'rel-a', sourceIds: ['src-a'] }),
        event('evt-b', '2026-08-12', 'day', { releaseId: 'rel-b', sourceIds: ['src-b'] }),
      ],
    }), BASE);

    for (const record of index.records) {
      expect(record.companions).toEqual([]);
    }
  });

  it('does not relate events that share a source but not a date', () => {
    const index = buildUpdateIndex(makeDataset({
      releases: [release('rel-a'), release('rel-b')],
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day', { releaseId: 'rel-a' }),
        event('evt-b', '2026-08-14', 'day', { releaseId: 'rel-b' }),
      ],
    }), BASE);

    for (const record of index.records) {
      expect(record.companions).toEqual([]);
    }
  });

  it('reads the source set in a stable order, however the record lists it', () => {
    const index = buildUpdateIndex(makeDataset({
      releases: [release('rel-a'), release('rel-b')],
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day', { releaseId: 'rel-a', sourceIds: ['src-a', 'src-b'] }),
        event('evt-b', '2026-08-12', 'day', { releaseId: 'rel-b', sourceIds: ['src-b', 'src-a'] }),
      ],
    }), BASE);

    expect(index.records[0].announcementKey).toBe(index.records[1].announcementKey);
    expect(index.records[0].companions).toHaveLength(1);
  });
});

describe('the creator of a model is not the operator of the platform', () => {
  it('attributes the record to the model\'s creator, whoever published the event', () => {
    // The shape is real: the seed records an Alibaba model being made available
    // on an Amazon-operated platform. The event's source is Amazon's; the model
    // is still Alibaba's, and the ledger must not collapse the two entities.
    const dataset = makeDataset({
      organizations: [organization('org'), organization('platform-operator')],
      sources: [
        source('src-a'),
        source('src-b'),
        source('src-platform', { title: 'Platform availability note' }),
      ],
      releaseEvents: [
        event('evt-a', '2026-08-27', 'day', {
          type: 'api-available',
          sourceIds: ['src-platform'],
        }),
      ],
    });

    const [record] = buildUpdateIndex(dataset, BASE).records;

    expect(record.creatorSlug).toBe('org');
    expect(record.creatorName).not.toContain('platform-operator');
    expect(record.sources[0].title).toBe('Platform availability note');
  });

  it('holds for the real cross-creator record in the seed dataset', () => {
    const index = buildUpdateIndex(seedDataset, BASE);
    const record = index.records.find((item) => item.id === 'qwen3-8-27b-on-sagemaker-jumpstart');

    expect(record, 'the seed still carries the cross-creator event').toBeDefined();
    // Alibaba built it; Amazon published the availability note.
    expect(record?.creatorSlug).toBe('alibaba-cloud');
    expect(record?.sources.some((source) => /amazon/i.test(source.url))).toBe(true);
  });
});

describe('grouping by month and year', () => {
  it('groups into years newest first, and months newest first inside them', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-a', '2025-01-05', 'day'),
        event('evt-b', '2026-08-12', 'day'),
        event('evt-c', '2026-02-03', 'day'),
      ],
    }), BASE);

    const years = groupUpdatesByPeriod(index.records);

    expect(years.map((year) => year.year)).toEqual(['2026', '2025']);
    expect(years[0].months.map((month) => month.key)).toEqual(['2026-08', '2026-02']);
    expect(years[0].months[0].label).toBe('August 2026');
    expect(years[1].months.map((month) => month.key)).toEqual(['2025-01']);
  });

  it('produces the same grouping whatever order the records arrive in', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-a', '2025-01-05', 'day'),
        event('evt-b', '2026-08-12', 'day'),
        event('evt-c', '2026-02-03', 'day'),
      ],
    }), BASE);

    const forwards = groupUpdatesByPeriod(index.records);
    const backwards = groupUpdatesByPeriod([...index.records].reverse());

    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });

  it('counts a year from the months beneath it', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day'),
        event('evt-b', '2026-08-14', 'day'),
        event('evt-c', '2026-02-03', 'day'),
      ],
    }), BASE);

    const [year] = groupUpdatesByPeriod(index.records);

    expect(year.count).toBe(3);
    expect(year.months.reduce((total, month) => total + month.count, 0)).toBe(3);
  });

  it('loses no record to grouping', () => {
    const index = buildUpdateIndex(seedDataset, BASE);
    const grouped = groupUpdatesByPeriod(index.records)
      .flatMap((year) => year.months)
      .flatMap((month) => month.records);

    expect(ids(grouped).sort()).toEqual(ids(index.records).sort());
  });
});

describe('a date with no month stated', () => {
  it('keeps a year-precision record inside its year and says the month is missing', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [event('evt-year', '2026', 'year')],
    }), BASE);

    const [year] = groupUpdatesByPeriod(index.records);
    const [month] = year.months;

    expect(year.year).toBe('2026');
    expect(month.imprecise).toBe(true);
    expect(month.key).toBe('2026-month-not-stated');
    expect(month.label).toBe('2026 · month not stated');
    expect(month.note).toMatch(/state 2026 only/);
  });

  it('does not rank an undated record among the months it cannot be placed in', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-year', '2026', 'year'),
        event('evt-aug', '2026-08-12', 'day'),
        event('evt-feb', '2026-02-03', 'day'),
      ],
    }), BASE);

    const [year] = groupUpdatesByPeriod(index.records);

    // Appended after the dated months rather than placed first, which in a
    // newest-first rail would read as "most recent" — the one claim the source
    // declined to make.
    expect(year.months.map((month) => month.key))
      .toEqual(['2026-08', '2026-02', '2026-month-not-stated']);
  });

  it('renders a month-precision record without inventing a day', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [event('evt-month', '2026-03', 'month')],
    }), BASE);

    const [record] = index.records;

    expect(record.date).toBe('2026-03');
    expect(record.dateLabel).not.toMatch(/\b\d{1,2}\b\s+Mar/);
    expect(record.dateLabel).toMatch(/2026/);

    const [year] = groupUpdatesByPeriod(index.records);

    expect(year.months[0].key).toBe('2026-03');
    expect(year.months[0].imprecise).toBe(false);
  });

  it('never carries a date more precise than the record claims', () => {
    const index = buildUpdateIndex(makeDataset({
      releaseEvents: [
        event('evt-year', '2026', 'year'),
        event('evt-month', '2025-03', 'month'),
        event('evt-day', '2024-03-14', 'day'),
      ],
    }), BASE);

    const widths = { year: 4, month: 7, day: 10 } as const;

    for (const record of index.records) {
      expect(record.date).toHaveLength(widths[record.datePrecision]);
    }
  });
});

describe('an empty ledger', () => {
  it('reports emptiness rather than throwing', () => {
    const index = buildUpdateIndex(makeDataset(), BASE);

    expect(index.isEmpty).toBe(true);
    expect(index.records).toEqual([]);
    expect(index.latestVerifiedAt).toBeNull();
  });

  it('produces empty facets and no period groups', () => {
    const index = buildUpdateIndex(makeDataset(), BASE);

    expect(index.facets.creators).toEqual([]);
    expect(index.facets.categories).toEqual([]);
    expect(index.facets.types).toEqual([]);
    expect(groupUpdatesByPeriod(index.records)).toEqual([]);
  });
});

describe('a populated ledger', () => {
  it('is not empty and carries the facets the filters need', () => {
    const index = buildUpdateIndex(seedDataset, BASE);

    expect(index.isEmpty).toBe(false);
    expect(index.facets.creators.length).toBeGreaterThan(0);
    expect(index.facets.categories.length).toBeGreaterThan(0);
    expect(index.latestVerifiedAt).not.toBeNull();
  });

  it('counts each creator facet from the records that carry it', () => {
    const index = buildUpdateIndex(seedDataset, BASE);

    for (const facet of index.facets.creators) {
      const matching = index.records.filter((record) => record.creatorSlug === facet.value);

      expect(matching.length, `creator "${facet.value}"`).toBe(facet.count);
    }
  });

  it('orders facet values deterministically rather than by encounter', () => {
    const index = buildUpdateIndex(seedDataset, BASE);
    const values = index.facets.creators.map((facet) => facet.value);

    expect([...values].sort()).toEqual(values);
  });
});

describe('an inconsistent dataset fails the build rather than publishing a gap', () => {
  it('refuses an event pointing at a release that is not there', () => {
    const raw = makeDataset({ releaseEvents: [event('evt-a', '2026-08-12', 'day')] });
    const orphaned: Dataset = {
      ...raw,
      releaseEvents: raw.releaseEvents.map((item) => ({ ...item, releaseId: 'rel-missing' })),
    };

    expect(() => buildUpdateIndex(orphaned, BASE)).toThrow(UpdatesIndexError);
    expect(() => buildUpdateIndex(orphaned, BASE)).toThrow(/missing release/);
  });

  it('refuses an event whose creator cannot be resolved', () => {
    const raw = makeDataset({ releaseEvents: [event('evt-a', '2026-08-12', 'day')] });
    const orphaned: Dataset = {
      ...raw,
      releases: raw.releases.map((item) => ({ ...item, organizationId: 'org-missing' })),
    };

    expect(() => buildUpdateIndex(orphaned, BASE)).toThrow(/no resolvable creator/);
  });

  it('refuses an event citing a source that is not there', () => {
    const raw = makeDataset({ releaseEvents: [event('evt-a', '2026-08-12', 'day')] });
    const orphaned: Dataset = {
      ...raw,
      releaseEvents: raw.releaseEvents.map((item) => ({ ...item, sourceIds: ['src-missing'] })),
    };

    expect(() => buildUpdateIndex(orphaned, BASE)).toThrow(/missing source/);
  });

  it('names every problem it found, not only the first', () => {
    const raw = makeDataset({
      releaseEvents: [
        event('evt-a', '2026-08-12', 'day'),
        event('evt-b', '2026-08-13', 'day'),
      ],
    });
    const orphaned: Dataset = {
      ...raw,
      releaseEvents: raw.releaseEvents.map((item) => ({ ...item, releaseId: 'rel-missing' })),
    };

    try {
      buildUpdateIndex(orphaned, BASE);
      expect.unreachable('expected the index to refuse this dataset');
    } catch (error) {
      expect((error as Error).message).toContain('evt-a');
      expect((error as Error).message).toContain('evt-b');
    }
  });
});

describe('the shipped payload stays within budget', () => {
  it('reports zero per record for an empty ledger rather than dividing by zero', () => {
    expect(measureUpdatesPayload([])).toEqual({ bytes: 2, records: 0, bytesPerRecord: 0 });
  });

  it('keeps the real ledger small enough to ship as island props', () => {
    const index = buildUpdateIndex(seedDataset, BASE);
    const size = measureUpdatesPayload(index.records);

    expect(size.records).toBeGreaterThan(0);

    // Budgeted per record as well as in total, so "the dataset grew" and "each
    // record got fatter" stay distinguishable — only the second is a
    // regression, and only the second should be fixed by trimming the record.
    expect(
      size.bytesPerRecord,
      `Each update record ships ${size.bytesPerRecord} bytes (budget 4,096). `
      + 'A rise here means the record itself grew, not that more events were recorded.',
    ).toBeLessThan(4_096);

    expect(
      size.bytes,
      `The ledger ships ${size.bytes} bytes over ${size.records} records (budget 262,144). `
      + 'If the per-record figure above is unchanged, this is the ledger simply growing.',
    ).toBeLessThan(262_144);
  });
});
