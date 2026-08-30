import type { DatePrecision } from '../data/schema';
import type { UpdateIndex, UpdateRecord } from './updates';
import { groupUpdatesByPeriod } from './updates';

/**
 * One feed-ready shape, and the one artifact generated from it today.
 *
 * The issue asks for two things that are usually built twice: a public changelog
 * generated from the dated events, and a feed-ready data shape whose RSS/Atom
 * publication is deferred. Building them twice is how they drift, and
 * "the generated changelog matches the rendered event source" then becomes a
 * promise nobody can check.
 *
 * So there is one intermediate representation. `buildUpdateFeed` normalises the
 * records `/updates` renders into feed items, and `renderUpdatesChangelog`
 * serialises those items to Markdown. The changelog cannot describe an event the
 * page does not show, or describe it differently, because it never sees the
 * dataset — only the records the page was built from.
 *
 * **What is deferred, and what is not.** The shape below is deliberately
 * feed-shaped: stable item ids, absolute-capable links, a published date, an
 * updated date, a plain-text body, authors and tags. It is modelled on JSON Feed
 * so that an RSS or Atom serializer is a pure function of it. No such serializer
 * is written, and no feed document is served, because the issue defers
 * publication — a feed people can subscribe to is a promise about update
 * cadence, and this project makes no such promise yet.
 *
 * **Determinism.** Nothing here reads a clock. The changelog's "as of" stamp is
 * the ledger's own latest verification date, which is a fact about the data
 * rather than about when the build ran, so two builds of one dataset produce
 * byte-identical output. A `Date.now()` anywhere in this file would silently
 * make every build differ from the last and turn the determinism test into a
 * test of nothing.
 */

/** The feed shape's own version, so a consumer can tell the shape changed. */
export const UPDATE_FEED_VERSION = 1;

export interface UpdateFeedAuthor {
  name: string;
  /** The creator's slug, so a consumer can rejoin this to the dataset. */
  id: string;
}

export interface UpdateFeedSource {
  title: string;
  url: string;
  publisherName: string | null;
}

export interface UpdateFeedItem {
  /** Globally stable item id. The event id, which never changes for an event. */
  id: string;
  /** Route to the update on this site, including its fragment. */
  url: string;
  /** Route to the affected model's Model Passport. */
  modelUrl: string;
  title: string;
  /**
   * The source's own what-changed note. Plain text, never HTML, and never a
   * rewritten or summarised form of the note the page shows.
   */
  contentText: string;
  /**
   * The date the *source* stated, exactly as partial as the source left it. It
   * is not an RFC 3339 instant and must not be coerced into one: a consumer that
   * needs an instant has to decide for itself what `2026` means, rather than
   * having this project decide silently on its behalf.
   */
  datePublished: string;
  datePublishedPrecision: DatePrecision;
  /** How the site renders {@link datePublished}. Never more precise than it. */
  datePublishedLabel: string;
  /**
   * The day we last re-checked the record. Present so a consumer can tell
   * freshness of *verification* from recency of *event*, and never a substitute
   * for {@link datePublished}.
   */
  dateVerified: string;
  eventType: UpdateRecord['type'];
  eventTypeLabel: string;
  authors: UpdateFeedAuthor[];
  tags: string[];
  sources: UpdateFeedSource[];
  /** Other models the same announcement covered, by model name. */
  alsoCovers: string[];
}

export interface UpdateFeed {
  version: number;
  title: string;
  description: string;
  /** The `/updates` route this feed mirrors. */
  homePageUrl: string;
  /**
   * The latest day any item was re-checked, or null when the feed is empty.
   * A verification stamp for the feed as a whole; never a publication date.
   */
  latestVerifiedAt: string | null;
  items: UpdateFeedItem[];
}

export interface UpdateFeedOptions {
  /** The site's `/updates` route, already carrying its base path. */
  updatesUrl: string;
}

const FEED_TITLE = 'ModelTree release updates';
const FEED_DESCRIPTION = 'Recorded, source-backed changes to reviewed AI model releases: '
  + 'announcements, previews, availability, deprecations, and corrections.';

/**
 * Normalises rendered records into feed items, preserving their order.
 *
 * The records arrive already ordered newest-first by the source-stated date,
 * which is the order the page shows and therefore the order the changelog must
 * use. Re-sorting here would be a second opinion about chronology and a second
 * place for it to be wrong.
 */
export function buildUpdateFeed(index: UpdateIndex, options: UpdateFeedOptions): UpdateFeed {
  const items = index.records.map((record) => ({
    id: record.id,
    url: `${options.updatesUrl}#${record.anchorId}`,
    modelUrl: record.modelRoute,
    title: `${record.modelName} — ${record.typeLabel}`,
    contentText: record.note,
    datePublished: record.date,
    datePublishedPrecision: record.datePrecision,
    datePublishedLabel: record.dateLabel,
    dateVerified: record.verifiedAt,
    eventType: record.type,
    eventTypeLabel: record.typeLabel,
    authors: [{ name: record.creatorName, id: record.creatorSlug }],
    tags: [...record.categoryLabels],
    sources: record.sources.map((source) => ({
      title: source.title,
      url: source.url,
      publisherName: source.publisherName,
    })),
    alsoCovers: record.companions.map((companion) => companion.modelName),
  }));

  return {
    version: UPDATE_FEED_VERSION,
    title: FEED_TITLE,
    description: FEED_DESCRIPTION,
    homePageUrl: options.updatesUrl,
    latestVerifiedAt: index.latestVerifiedAt,
    items,
  };
}

/**
 * The changelog's grouping, derived from the same records the page groups.
 *
 * The feed is flat, so the year and month rails are recovered by re-grouping the
 * records rather than by carrying a second copy of the structure through the
 * feed. Passing the records alongside the feed keeps `renderUpdatesChangelog` a
 * pure function of what the page rendered.
 */
export interface ChangelogOptions {
  feed: UpdateFeed;
  records: readonly UpdateRecord[];
}

/** Markdown escaping for text that lands inside a table cell or a list item. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]|])/g, '\\$1').replace(/\r?\n/g, ' ');
}

/** Drops trailing blank lines, so the document ends with exactly one newline. */
function finish(lines: readonly string[]): string {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return `${trimmed.join('\n')}\n`;
}

/**
 * Renders the public changelog.
 *
 * Every line is derived from a feed item, and every feed item from a rendered
 * record, so a change that reaches this document has reached the page and vice
 * versa. Nothing is summarised: the note is the source's own wording, and the
 * two dates stay labelled as the different things they are.
 */
export function renderUpdatesChangelog({ feed, records }: ChangelogOptions): string {
  const itemById = new Map(feed.items.map((item) => [item.id, item]));
  const lines: string[] = [];

  lines.push('# ModelTree release updates');
  lines.push('');
  lines.push(feed.description);
  lines.push('');
  lines.push(
    'Generated from the same records the site renders at `/updates/`. '
    + 'Each entry is dated by the day its **source** stated, never by the day it was checked here; '
    + 'both dates are given so the two are never mistaken for one another.',
  );
  lines.push('');

  if (feed.items.length === 0) {
    lines.push('No release events are recorded yet.');
    lines.push('');
    lines.push(
      'This is the honest state of the dataset rather than a rendering failure: '
      + 'an undated or unsourced change is not published here.',
    );
    return finish(lines);
  }

  lines.push(
    `${feed.items.length} recorded ${feed.items.length === 1 ? 'change' : 'changes'}. `
    + `Every record here was last re-checked on or before ${feed.latestVerifiedAt}.`,
  );
  lines.push('');

  for (const year of groupUpdatesByPeriod(records)) {
    lines.push(`## ${year.year}`);
    lines.push('');

    for (const month of year.months) {
      lines.push(`### ${month.label}`);
      lines.push('');

      if (month.note) {
        lines.push(`_${month.note}_`);
        lines.push('');
      }

      for (const record of month.records) {
        const item = itemById.get(record.id);
        // Unreachable while the feed is built from these same records; a throw
        // rather than a skip, because a changelog quietly missing an entry the
        // page shows is the exact failure this module is arranged to prevent.
        if (!item) throw new Error(`Changelog record ${record.id} has no feed item`);

        lines.push(`- **${escapeMarkdown(item.datePublishedLabel)} — ${escapeMarkdown(item.eventTypeLabel)}: ${escapeMarkdown(record.modelName)}** (${escapeMarkdown(record.creatorName)})`);
        lines.push(`  - ${escapeMarkdown(item.contentText)}`);

        if (item.alsoCovers.length > 0) {
          lines.push(`  - Same announcement also covered: ${item.alsoCovers.map(escapeMarkdown).join(', ')}`);
        }

        const sources = item.sources
          .map((source) => {
            const publisher = source.publisherName ? ` (${escapeMarkdown(source.publisherName)})` : '';
            return `[${escapeMarkdown(source.title)}](${source.url})${publisher}`;
          })
          .join(', ');

        lines.push(`  - Source: ${sources}`);
        lines.push(`  - Checked ${item.dateVerified} · \`${item.id}\``);
      }

      lines.push('');
    }
  }

  return finish(lines);
}
