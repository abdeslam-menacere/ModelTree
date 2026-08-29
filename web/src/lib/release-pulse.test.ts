import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import type { Dataset } from '../data/schema';
import { validateDataset } from '../data/validate';
import {
  buildCoverageStats,
  buildReleasePulse,
  latestChangeLabel,
  PULSE_MAX_ITEMS,
  PULSE_WINDOW_MONTHS,
  pulseWindowStart,
} from './release-pulse';
import { latestDay } from '../data/partial-date';

// ---------------------------------------------------------------------------
// Fixtures. Everything is built through `validateDataset`, so a test can never
// assert against a shape the schema would reject, and a schema change that
// invalidates these records fails here rather than passing quietly.
// ---------------------------------------------------------------------------

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
    sourceIds: ['src-official'],
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
    sourceIds: ['src-official'],
    verifiedAt: '2026-08-28',
    ...extra,
  };
}

function makeDataset(overrides: Record<string, unknown> = {}): Dataset {
  return validateDataset({
    sources: [
      {
        id: 'src-repo',
        url: 'https://example.com/repo',
        title: 'Repository listing',
        type: 'repository',
        publisherId: 'pub',
        lastCheckedDate: '2026-08-28',
      },
      {
        id: 'src-official',
        url: 'https://example.com/announcement',
        title: 'Official announcement',
        type: 'official-announcement',
        publisherId: 'pub',
        lastCheckedDate: '2026-08-28',
      },
    ],
    publishers: [{ id: 'pub', name: 'Example' }],
    organizations: [
      {
        id: 'org',
        slug: 'org',
        name: 'Org',
        shortName: 'Org',
        type: 'company',
        website: 'https://example.com/',
        releasePage: 'https://example.com/news',
        description: 'Fixture creator.',
        sourceIds: ['src-official'],
        verifiedAt: '2026-08-28',
      },
    ],
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
        sourceIds: ['src-official'],
        verifiedAt: '2026-08-28',
      },
    ],
    releases: [release('rel-a')],
    releaseEvents: [],
    ...overrides,
  });
}

const BASE = '/';

describe('coverage statistics', () => {
  it('derives counts from the dataset rather than pinning literals', () => {
    const stats = buildCoverageStats(seedDataset);

    // Guard the derivation: an assertion of equality to `.length` would pass
    // vacuously if the seed silently resolved to empty. It never should.
    expect(seedDataset.organizations.length).toBeGreaterThan(0);
    expect(seedDataset.releaseEvents.length).toBeGreaterThan(0);

    expect(stats.creators).toBe(seedDataset.organizations.length);
    expect(stats.families).toBe(seedDataset.families.length);
    expect(stats.releases).toBe(seedDataset.releases.length);
    expect(stats.sources).toBe(seedDataset.sources.length);
    expect(stats.events).toBe(seedDataset.releaseEvents.length);
  });

  it('counts only organizations that publish, not every organization', () => {
    // The heart of #515. `buildCoverageStats` counted `organizations.length`,
    // but a "creator" is an organization that has published -- serving
    // platforms, hosting providers and consortia are separate entities the
    // model keeps distinct. The live dataset has zero non-creator
    // organizations, so an assertion against the seed alone is vacuous: it
    // passes under both the correct and the broken derivation. This test
    // constructs the population the live data cannot supply.
    //
    // `nonCreator` is a fully-valid organization with no family and no release.
    // It is built through `makeDataset`/`validateDataset`, so a schema change
    // that outlawed this shape would fail here rather than pass quietly.
    const nonCreator = {
      id: 'org-platform',
      slug: 'org-platform',
      name: 'Serving Platform Co',
      shortName: 'Platform',
      type: 'company' as const,
      website: 'https://example.com/platform',
      releasePage: 'https://example.com/platform/news',
      description: 'A hosting-only organization that publishes no models.',
      sourceIds: ['src-official'],
      verifiedAt: '2026-08-28',
    };
    const withNonCreator = makeDataset({
      organizations: [
        {
          id: 'org',
          slug: 'org',
          name: 'Org',
          shortName: 'Org',
          type: 'company',
          website: 'https://example.com/',
          releasePage: 'https://example.com/news',
          description: 'Fixture creator.',
          sourceIds: ['src-official'],
          verifiedAt: '2026-08-28',
        },
        nonCreator,
      ],
    });

    // Vacuity guard: the fixture actually contains a non-creator organization,
    // one recorded but named by no release. Without this the assertion below
    // could pass because the two populations happen to coincide -- the exact
    // way the live dataset makes this test worthless.
    const publisherIds = new Set(withNonCreator.releases.map((r) => r.organizationId));
    const nonCreators = withNonCreator.organizations.filter((o) => !publisherIds.has(o.id));
    expect(nonCreators.map((o) => o.id)).toContain('org-platform');
    expect(withNonCreator.organizations.length).toBeGreaterThan(nonCreators.length);

    // The count is the creator population, strictly fewer than every
    // organization. Under the broken `organizations.length` derivation the
    // first assertion reads 2 and fails; that is what the mutation proof shows.
    const creatorCount = withNonCreator.organizations.length - nonCreators.length;
    expect(buildCoverageStats(withNonCreator).creators).toBe(creatorCount);
    expect(buildCoverageStats(withNonCreator).creators).toBeLessThan(
      withNonCreator.organizations.length,
    );

    // No-redden control: adding a non-creator organization does not change the
    // creator count relative to the base fixture, which has the same single
    // publisher. A test that reddened on any dataset edit could not tell this
    // apart from the assertion above.
    expect(buildCoverageStats(withNonCreator).creators).toBe(
      buildCoverageStats(makeDataset()).creators,
    );
  });


  it('moves each count with the records actually present', () => {
    const base = makeDataset();
    const grown = makeDataset({
      releases: [release('rel-a'), release('rel-b')],
    });

    expect(buildCoverageStats(grown).releases).toBe(buildCoverageStats(base).releases + 1);
  });

  it('reports the latest verification day across releases and recorded changes', () => {
    const stats = buildCoverageStats(
      makeDataset({
        releases: [release('rel-a', { verifiedAt: '2026-03-01' })],
        releaseEvents: [event('ev-late', '2026-02-01', 'day', { verifiedAt: '2026-07-15' })],
      }),
    );

    // The event was re-checked after the release, so it, not the release, sets
    // the latest verification day.
    expect(stats.latestVerifiedAt).toBe('2026-07-15');
  });

  it('has no latest verification day only when the dataset would be empty', () => {
    // A dataset always carries at least one release, so the null branch is
    // reachable only over an empty record set. Proven directly rather than
    // asserted vacuously against data that can never produce it.
    expect(buildCoverageStats({ ...makeDataset(), releases: [], releaseEvents: [] }).latestVerifiedAt)
      .toBeNull();
  });
});

describe('release pulse window bound', () => {
  it('counts the window back from the build day in whole months', () => {
    expect(pulseWindowStart('2026-06-15', 3)).toBe('2026-03-15');
    expect(pulseWindowStart('2026-08-28', PULSE_WINDOW_MONTHS)).toBe('2025-02-28');
  });

  it('includes an event dated exactly on the cutoff and excludes the day before', () => {
    const data = makeDataset({
      releaseEvents: [
        event('on-cutoff', '2026-03-15', 'day'),
        event('day-before', '2026-03-14', 'day'),
      ],
    });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-06-15', windowMonths: 3 });
    const ids = pulse.items.map((item) => item.id);

    expect(ids).toContain('on-cutoff');
    expect(ids).not.toContain('day-before');
    expect(pulse.items).toHaveLength(1);
  });

  it('keeps a partial date whose interval reaches into the window', () => {
    const data = makeDataset({
      releaseEvents: [event('year-2025', '2025', 'year')],
    });

    // The window opens mid-2025; a year-precision 2025 event could mean any day
    // that year, including days after the cutoff, so it is kept by its ceiling.
    const pulse = buildReleasePulse(data, { base: BASE, now: '2025-12-01', windowMonths: 6 });

    expect(pulse.items.map((item) => item.id)).toEqual(['year-2025']);
  });
});

describe('release pulse recency by dated event, not verification', () => {
  it('excludes an old release that was merely re-verified today', () => {
    const data = makeDataset({
      releaseEvents: [
        // A change that actually happened inside the window.
        event('fresh', '2026-05-01', 'day', { verifiedAt: '2026-05-02' }),
        // A five-year-old change re-checked this morning. Recent verification,
        // ancient event. It must not surface as recent.
        event('old-recheck', '2021-01-04', 'day', { verifiedAt: '2026-08-28' }),
      ],
    });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-08-28', windowMonths: 18 });
    const ids = pulse.items.map((item) => item.id);

    expect(ids).toContain('fresh');
    expect(ids).not.toContain('old-recheck');
    expect(pulse.items).toHaveLength(1);
    expect(pulse.items[0].id).toBe('fresh');
  });

  it('orders by the source-dated event, so a fresh verification cannot jump an old change ahead', () => {
    const data = makeDataset({
      releaseEvents: [
        event('older-newly-verified', '2026-02-01', 'day', { verifiedAt: '2026-08-28' }),
        event('newer-long-verified', '2026-07-01', 'day', { verifiedAt: '2026-07-02' }),
      ],
    });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-08-28', windowMonths: 18 });

    // Newest event first. If ordering read verifiedAt, the February change would
    // lead because it was verified more recently.
    expect(pulse.items.map((item) => item.id)).toEqual([
      'newer-long-verified',
      'older-newly-verified',
    ]);
  });
});

describe('release pulse ordering of partial and tied dates', () => {
  it('sorts newest first and never ranks a coarse date above a precise later one', () => {
    const data = makeDataset({
      releaseEvents: [
        event('year', '2026', 'year'),
        event('month', '2026-08', 'month'),
        event('day', '2026-08-14', 'day'),
      ],
    });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-08-28', windowMonths: 24 });

    expect(pulse.items.map((item) => item.id)).toEqual(['day', 'month', 'year']);
  });

  it('breaks equal dates by event id, independent of source order', () => {
    const forward = makeDataset({
      releaseEvents: [
        event('zzz', '2026-05-05', 'day'),
        event('aaa', '2026-05-05', 'day'),
      ],
    });
    const reversed = makeDataset({
      releaseEvents: [
        event('aaa', '2026-05-05', 'day'),
        event('zzz', '2026-05-05', 'day'),
      ],
    });

    const order = (data: Dataset) =>
      buildReleasePulse(data, { base: BASE, now: '2026-08-28', windowMonths: 24 })
        .items.map((item) => item.id);

    expect(order(forward)).toEqual(['aaa', 'zzz']);
    expect(order(reversed)).toEqual(['aaa', 'zzz']);
  });
});

describe('release pulse item cap', () => {
  it('keeps the newest items up to the cap and reports how many matched', () => {
    const data = makeDataset({
      releaseEvents: [
        event('a', '2026-01-01', 'day'),
        event('b', '2026-02-01', 'day'),
        event('c', '2026-03-01', 'day'),
      ],
    });

    const pulse = buildReleasePulse(data, {
      base: BASE,
      now: '2026-08-28',
      windowMonths: 24,
      maxItems: 2,
    });

    expect(pulse.items.map((item) => item.id)).toEqual(['c', 'b']);
    expect(pulse.items).toHaveLength(2);
    expect(pulse.totalInWindow).toBe(3);
  });

  it('defaults the cap and window to the documented constants', () => {
    const events = Array.from({ length: PULSE_MAX_ITEMS + 2 }, (_unused, index) =>
      event(`ev-${String(index).padStart(2, '0')}`, `2026-0${(index % 8) + 1}-01`, 'day'),
    );
    const data = makeDataset({ releaseEvents: events });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-08-28' });

    expect(pulse.items).toHaveLength(PULSE_MAX_ITEMS);
    expect(pulse.windowMonths).toBe(PULSE_WINDOW_MONTHS);
    expect(pulse.maxItems).toBe(PULSE_MAX_ITEMS);
  });
});

describe('release pulse item content and links', () => {
  it('links each item to its release passport and a primary source, and states the change', () => {
    const data = makeDataset({
      releaseEvents: [
        event('ga', '2026-06-01', 'day', {
          type: 'generally-available',
          note: 'REL-A reached general availability.',
          // Prefers the official announcement over the repository mirror.
          sourceIds: ['src-repo', 'src-official'],
        }),
      ],
    });

    const [item] = buildReleasePulse(data, {
      base: '/app/',
      now: '2026-08-28',
      windowMonths: 18,
    }).items;

    expect(item).toEqual({
      id: 'ga',
      releaseId: 'rel-a',
      releaseName: 'REL-A',
      releaseRoute: '/app/models/rel-a/',
      type: 'generally-available',
      typeLabel: 'Generally available',
      date: '2026-06-01',
      datePrecision: 'day',
      dateLabel: 'Jun 1, 2026',
      note: 'REL-A reached general availability.',
      verifiedAt: '2026-08-28',
      source: { title: 'Official announcement', url: 'https://example.com/announcement' },
    });
  });
});

describe('release pulse honest empty and stale states', () => {
  it('is empty, not stale, when the dataset records no changes', () => {
    const pulse = buildReleasePulse(makeDataset({ releaseEvents: [] }), {
      base: BASE,
      now: '2026-08-28',
    });

    expect(pulse.items).toEqual([]);
    expect(pulse.isEmpty).toBe(true);
    expect(pulse.isStale).toBe(false);
    expect(pulse.latestEventDate).toBeNull();
  });

  it('is stale, not empty, when every recorded change predates the window', () => {
    const data = makeDataset({
      releaseEvents: [
        event('old-1', '2021-01-04', 'day', { verifiedAt: '2026-08-28' }),
        event('old-2', '2020-06-01', 'day', { verifiedAt: '2026-08-28' }),
      ],
    });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-08-28', windowMonths: 18 });

    expect(pulse.items).toEqual([]);
    expect(pulse.isEmpty).toBe(false);
    expect(pulse.isStale).toBe(true);
    // The strip can honestly say how old the newest recorded change is.
    expect(pulse.latestEventDate).toBe('2021-01-04');
    expect(latestChangeLabel(pulse, data)).toBe('Jan 4, 2021');
  });

  it('reports neither empty nor stale once a change falls in the window', () => {
    // The mirror of the two states above: the flags are not constants.
    const data = makeDataset({ releaseEvents: [event('fresh', '2026-05-01', 'day')] });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-08-28', windowMonths: 18 });

    expect(pulse.items).toHaveLength(1);
    expect(pulse.isEmpty).toBe(false);
    expect(pulse.isStale).toBe(false);
  });
});

describe('release pulse snapshots', () => {
  it('snapshots the empty state', () => {
    const pulse = buildReleasePulse(makeDataset({ releaseEvents: [] }), {
      base: BASE,
      now: '2026-08-28',
      windowMonths: 18,
    });

    expect(pulse).toMatchInlineSnapshot(`
      {
        "isEmpty": true,
        "isStale": false,
        "items": [],
        "latestEventDate": null,
        "maxItems": 6,
        "now": "2026-08-28",
        "totalInWindow": 0,
        "windowMonths": 18,
        "windowStart": "2025-02-28",
      }
    `);
  });

  it('snapshots a populated state', () => {
    const data = makeDataset({
      releaseEvents: [
        event('preview', '2026-04-10', 'day', { type: 'preview', note: 'Preview opened.' }),
        event('ga', '2026-06-01', 'day', { type: 'generally-available', note: 'Reached GA.' }),
      ],
    });

    const pulse = buildReleasePulse(data, { base: BASE, now: '2026-08-28', windowMonths: 18 });

    expect(pulse).toMatchInlineSnapshot(`
      {
        "isEmpty": false,
        "isStale": false,
        "items": [
          {
            "date": "2026-06-01",
            "dateLabel": "Jun 1, 2026",
            "datePrecision": "day",
            "id": "ga",
            "note": "Reached GA.",
            "releaseId": "rel-a",
            "releaseName": "REL-A",
            "releaseRoute": "/models/rel-a/",
            "source": {
              "title": "Official announcement",
              "url": "https://example.com/announcement",
            },
            "type": "generally-available",
            "typeLabel": "Generally available",
            "verifiedAt": "2026-08-28",
          },
          {
            "date": "2026-04-10",
            "dateLabel": "Apr 10, 2026",
            "datePrecision": "day",
            "id": "preview",
            "note": "Preview opened.",
            "releaseId": "rel-a",
            "releaseName": "REL-A",
            "releaseRoute": "/models/rel-a/",
            "source": {
              "title": "Official announcement",
              "url": "https://example.com/announcement",
            },
            "type": "preview",
            "typeLabel": "Preview",
            "verifiedAt": "2026-08-28",
          },
        ],
        "latestEventDate": "2026-06-01",
        "maxItems": 6,
        "now": "2026-08-28",
        "totalInWindow": 2,
        "windowMonths": 18,
        "windowStart": "2025-02-28",
      }
    `);
  });
});

describe('release pulse against the real dataset', () => {
  it('never surfaces an event whose interval predates the window', () => {
    // A fixed reference day keeps the test deterministic regardless of when it
    // runs; it is not a dataset count and does not move as trunk grows.
    const now = '2026-08-28';
    const windowMonths = PULSE_WINDOW_MONTHS;
    const start = pulseWindowStart(now, windowMonths);
    const pulse = buildReleasePulse(seedDataset, { base: BASE, now, windowMonths });

    // Independently derived from the seed, so the counts move with the data
    // rather than being pinned. Guarded so the per-item check below is not run
    // over an empty subject unnoticed.
    const inWindowCount = seedDataset.releaseEvents.filter(
      (event) => latestDay(event.date) >= start,
    ).length;

    expect(seedDataset.releaseEvents.length).toBeGreaterThan(0);
    expect(pulse.totalInWindow).toBe(inWindowCount);
    expect(pulse.items).toHaveLength(Math.min(inWindowCount, PULSE_MAX_ITEMS));

    // The trap restated over real data: every shown item's own event date must
    // reach the window. A derivation that read verifiedAt would admit an old
    // record re-checked recently and fail here.
    for (const item of pulse.items) {
      expect(seedDataset.releaseEvents.some((event) => event.id === item.id)).toBe(true);
      expect(latestDay(item.date) >= start).toBe(true);
    }
  });
});
