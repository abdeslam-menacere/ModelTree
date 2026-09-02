import { describe, expect, it, vi } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import type { Dataset } from '../data/schema';
import { validateDataset } from '../data/validate';
import { buildUpdateIndex, type UpdateIndex } from './updates';
import {
  buildUpdateFeed,
  renderUpdatesChangelog,
  UPDATE_FEED_VERSION,
} from './updates-feed';

const UPDATES_URL = '/updates/';

const index = buildUpdateIndex(seedDataset, '/');
const feed = buildUpdateFeed(index, { updatesUrl: UPDATES_URL });
const changelog = renderUpdatesChangelog({ feed, records: index.records });

/** An index holding no events at all, for the honest-empty-state assertions. */
function emptyIndex(): UpdateIndex {
  const empty: Dataset = validateDataset({
    sources: [{
      id: 'src-a',
      url: 'https://example.com/a',
      title: 'Source A',
      type: 'official-announcement',
      publisherId: 'pub',
      lastCheckedDate: '2026-08-28',
    }],
    publishers: [{ id: 'pub', name: 'Example Publisher' }],
    organizations: [{
      id: 'org',
      slug: 'org',
      name: 'Org',
      shortName: 'Org',
      type: 'company',
      website: 'https://example.com/',
      releasePage: 'https://example.com/news',
      description: 'Fixture creator.',
      sourceIds: ['src-a'],
      verifiedAt: '2026-08-28',
    }],
    families: [{
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
    }],
    releases: [{
      id: 'rel-a',
      slug: 'rel-a',
      canonicalName: 'rel-a',
      displayName: 'REL-A',
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
    }],
    releaseEvents: [],
  });

  return buildUpdateIndex(empty, '/');
}

describe('the feed shape a consumer would read', () => {
  it('declares its own version, so a shape change is detectable', () => {
    expect(feed.version).toBe(UPDATE_FEED_VERSION);
    expect(UPDATE_FEED_VERSION).toBeGreaterThan(0);
  });

  it('carries one item per rendered record, in the rendered order', () => {
    expect(feed.items.map((item) => item.id)).toEqual(index.records.map((record) => record.id));
  });

  it('gives every item a stable id that is the event\'s own', () => {
    const eventIds = new Set(seedDataset.releaseEvents.map((event) => event.id));

    for (const item of feed.items) {
      expect(eventIds.has(item.id), `feed item "${item.id}" is a real event id`).toBe(true);
    }

    expect(new Set(feed.items.map((item) => item.id)).size).toBe(feed.items.length);
  });

  it('links each item to the update on the site and to the affected model', () => {
    for (const item of feed.items) {
      expect(item.url).toBe(`${UPDATES_URL}#event-${item.id}`);
      expect(item.modelUrl).toMatch(/^\/models\/.+\/$/);
    }
  });

  it('names the creator as author, and the categories as tags', () => {
    for (const [position, item] of feed.items.entries()) {
      const record = index.records[position];

      expect(item.authors).toEqual([{ name: record.creatorName, id: record.creatorSlug }]);
      expect(item.tags).toEqual(record.categoryLabels);
    }
  });

  it('carries every source through with somewhere to click', () => {
    for (const item of feed.items) {
      expect(item.sources.length).toBeGreaterThan(0);
      for (const source of item.sources) {
        expect(source.url).toMatch(/^https?:\/\//);
        expect(source.title.trim()).not.toBe('');
      }
    }
  });

  it('keeps the source-stated date exactly as partial as the source left it', () => {
    const widths = { year: 4, month: 7, day: 10 } as const;

    for (const item of feed.items) {
      expect(item.datePublished).toHaveLength(widths[item.datePublishedPrecision]);
    }
  });

  it('keeps the verification date as a separate field from the publication date', () => {
    for (const item of feed.items) {
      expect(item.dateVerified).not.toBe(undefined);
      // Distinct fields, so no consumer can read one as the other by accident.
      expect(Object.keys(item)).toContain('datePublished');
      expect(Object.keys(item)).toContain('dateVerified');
    }
  });

  it('stamps the feed with the ledger\'s latest check, not with the build time', () => {
    expect(feed.latestVerifiedAt).toBe(index.latestVerifiedAt);
  });

  it('reports an empty feed as empty rather than as an error', () => {
    const empty = buildUpdateFeed(emptyIndex(), { updatesUrl: UPDATES_URL });

    expect(empty.items).toEqual([]);
    expect(empty.latestVerifiedAt).toBeNull();
    expect(empty.version).toBe(UPDATE_FEED_VERSION);
  });

  it('publishes no RSS or Atom document, deliberately', () => {
    // The issue defers publication: a subscribable feed is a promise about
    // update cadence this project does not yet make. The shape is ready; the
    // serializer is intentionally absent, and this records that as a decision
    // rather than an omission.
    expect(feed).not.toHaveProperty('rss');
    expect(feed).not.toHaveProperty('atom');
    expect(changelog).not.toMatch(/<rss|<feed\b/);
  });
});

describe('the changelog is generated, not written', () => {
  it('produces identical output for identical data', () => {
    const again = renderUpdatesChangelog({
      feed: buildUpdateFeed(buildUpdateIndex(seedDataset, '/'), { updatesUrl: UPDATES_URL }),
      records: buildUpdateIndex(seedDataset, '/').records,
    });

    expect(again).toBe(changelog);
  });

  it('does not vary with the order the events happen to be stored in', () => {
    const shuffled: Dataset = {
      ...seedDataset,
      releaseEvents: [...seedDataset.releaseEvents].reverse(),
    };
    const shuffledIndex = buildUpdateIndex(shuffled, '/');

    const output = renderUpdatesChangelog({
      feed: buildUpdateFeed(shuffledIndex, { updatesUrl: UPDATES_URL }),
      records: shuffledIndex.records,
    });

    expect(output).toBe(changelog);
  });

  it('reads no clock, so a rebuild of unchanged data changes nothing', () => {
    // A `Date.now()` in the render path would make every build differ from the
    // last and turn the determinism assertions above into tests of nothing.
    //
    // Moving the clock tests that directly. The cheaper proxy this replaced —
    // asserting today's date is absent from the text — was wrong in both
    // directions, because every full ISO date this document prints is some
    // record's `verifiedAt` rather than a stamp. It therefore failed on honest
    // data whenever a record was verified today, which is the ordinary state on
    // the day of a refresh and was true of the committed data on 2026-08-28,
    // and it passed a build stamp minted on any other day.
    vi.useFakeTimers();
    try {
      for (const day of ['2024-01-02T03:04:05Z', '2027-11-30T23:59:59Z']) {
        vi.setSystemTime(new Date(day));
        const rebuilt = buildUpdateIndex(seedDataset, '/');

        expect(renderUpdatesChangelog({
          feed: buildUpdateFeed(rebuilt, { updatesUrl: UPDATES_URL }),
          records: rebuilt.records,
        })).toBe(changelog);
      }
    } finally {
      vi.useRealTimers();
    }

    expect(changelog).not.toMatch(/generated (on|at) \d/i);
  });

  it('ends with exactly one trailing newline', () => {
    expect(changelog.endsWith('\n')).toBe(true);
    expect(changelog.endsWith('\n\n')).toBe(false);
  });
});

describe('the changelog matches the source the page renders', () => {
  it('describes every rendered record exactly once', () => {
    for (const record of index.records) {
      const occurrences = changelog.split(record.id).length - 1;

      expect(occurrences, `record "${record.id}" appears once in the changelog`).toBe(1);
    }
  });

  it('describes nothing the page does not render', () => {
    const recordIds = new Set(index.records.map((record) => record.id));
    const cited = [...changelog.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]);

    expect(cited.length).toBe(index.records.length);

    for (const id of cited) {
      expect(recordIds.has(id), `changelog cites only rendered records, saw "${id}"`).toBe(true);
    }
  });

  it('carries each record\'s note in the source\'s own words', () => {
    for (const record of index.records) {
      // Escaped for Markdown, so compare on the unescaped-safe portion.
      const plain = record.note.replace(/([\\`*_[\]|])/g, '\\$1');

      expect(changelog, `note for "${record.id}"`).toContain(plain);
    }
  });

  it('carries each record\'s type, model, creator and date as the page shows them', () => {
    for (const record of index.records) {
      expect(changelog).toContain(record.typeLabel);
      expect(changelog).toContain(record.modelName);
      expect(changelog).toContain(record.creatorName);
      expect(changelog).toContain(record.dateLabel);
    }
  });

  it('links each record to at least one primary source', () => {
    for (const record of index.records) {
      for (const source of record.sources) {
        expect(changelog, `source for "${record.id}"`).toContain(source.url);
      }
    }
  });

  it('states when each record was checked, distinctly from when it happened', () => {
    for (const record of index.records) {
      expect(changelog).toContain(`Checked ${record.verifiedAt}`);
    }
  });

  it('never prints a verification date where a change date belongs', () => {
    // The non-goal, checked on the rendered artifact rather than only on the
    // model behind it. Every bullet heading opens with the source-stated label.
    const headings = [...changelog.matchAll(/^- \*\*(.+?) — /gm)].map((match) => match[1]);
    const dateLabels = new Set(index.records.map((record) => record.dateLabel));

    expect(headings).toHaveLength(index.records.length);

    for (const heading of headings) {
      expect(dateLabels.has(heading), `"${heading}" is a source-stated date`).toBe(true);
    }
  });

  it('groups by the same years and months the page groups by', () => {
    const years = [...changelog.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    const expected = [...new Set(index.records.map((record) => record.date.slice(0, 4)))];

    expect(years).toEqual(expected);
  });

  it('cross-references the same announcements the page cross-references', () => {
    const withCompanions = index.records.filter((record) => record.companions.length > 0);
    const mentions = changelog.split('Same announcement also covered:').length - 1;

    expect(mentions).toBe(withCompanions.length);
  });
});

describe('an empty changelog', () => {
  const empty = emptyIndex();
  const emptyChangelog = renderUpdatesChangelog({
    feed: buildUpdateFeed(empty, { updatesUrl: UPDATES_URL }),
    records: empty.records,
  });

  it('says the dataset records nothing, rather than rendering a bare heading', () => {
    expect(emptyChangelog).toContain('No release events are recorded yet.');
  });

  it('distinguishes an empty dataset from a broken build', () => {
    expect(emptyChangelog).toMatch(/honest state of the dataset/);
  });

  it('invents no entries and no counts', () => {
    expect(emptyChangelog).not.toMatch(/^## /m);
    expect(emptyChangelog).not.toMatch(/^- /m);
  });

  it('is still a well-formed document', () => {
    expect(emptyChangelog.startsWith('# ModelTree release updates')).toBe(true);
    expect(emptyChangelog.endsWith('\n')).toBe(true);
  });
});

describe('the changelog is readable as Markdown', () => {
  it('opens with a single top-level heading', () => {
    const topLevel = [...changelog.matchAll(/^# .+$/gm)];

    expect(topLevel).toHaveLength(1);
    expect(changelog.startsWith('# ModelTree release updates')).toBe(true);
  });

  it('nests month headings under year headings', () => {
    const headings = [...changelog.matchAll(/^(#{2,3}) /gm)].map((match) => match[1]);

    expect(headings[0]).toBe('##');
    expect(headings).toContain('###');
  });

  it('says where it came from, so it is not mistaken for hand-written notes', () => {
    expect(changelog).toContain('/updates/');
    expect(changelog).toMatch(/Generated from the same records/);
  });

  it('explains which of its two dates is which', () => {
    expect(changelog).toMatch(/dated by the day its \*\*source\*\* stated/);
  });

  it('escapes note text that would otherwise be read as formatting', () => {
    const dataset: Dataset = {
      ...seedDataset,
      releaseEvents: [{
        ...seedDataset.releaseEvents[0],
        note: 'Renamed `foo` to *bar* | see [docs].',
      }],
    };
    const built = buildUpdateIndex(dataset, '/');
    const output = renderUpdatesChangelog({
      feed: buildUpdateFeed(built, { updatesUrl: UPDATES_URL }),
      records: built.records,
    });

    expect(output).toContain('Renamed \\`foo\\` to \\*bar\\* \\| see \\[docs\\].');
  });

  it('keeps every entry on its own line', () => {
    const dataset: Dataset = {
      ...seedDataset,
      releaseEvents: [{
        ...seedDataset.releaseEvents[0],
        note: 'First line.\nSecond line.',
      }],
    };
    const built = buildUpdateIndex(dataset, '/');
    const output = renderUpdatesChangelog({
      feed: buildUpdateFeed(built, { updatesUrl: UPDATES_URL }),
      records: built.records,
    });

    expect(output).toContain('First line. Second line.');
  });
});
