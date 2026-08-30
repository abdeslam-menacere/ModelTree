import type { Dataset, DatePrecision, ReleaseEvent, SourceReference } from '../data/schema';
import { comparePartialDatesDescending, latestDay } from '../data/partial-date';
import { formatDateWithPrecision } from './format';
import { releaseEventTypeLabel } from './provider-profile';

/**
 * Release Pulse: a compact, honest strip of recent, source-dated lifecycle
 * changes, derived at build time from versioned records.
 *
 * The one rule this module exists to enforce, and the reason the issue exists:
 * recency is read from the source-dated event (`event.date`), never from
 * `verifiedAt`. `verifiedAt` records when *we* last re-checked a fact and moves
 * every time we do; a five-year-old model re-verified this morning must not
 * surface as a recent release. So both the window filter and the ordering below
 * read `event.date`, and the pulse is drawn from `releaseEvents` — the only
 * records that carry a source-dated lifecycle date and its precision — rather
 * than from a release's own verification stamp.
 *
 * Dates here are partial: a `2026` event states some day in 2026 and nothing
 * finer. Ordering therefore goes through `comparePartialDates`, which treats a
 * partial date as the interval of days it could mean and never invents a day to
 * make a comparison work. Equal dates are broken by event id so a build is
 * deterministic and two events dated the same day never reorder between builds.
 */

/**
 * How far back a build looks for recent events, in whole months counted from the
 * build date. Documented here as the single source of truth and exercised at the
 * boundary by the tests. An event whose interval of possible days reaches no
 * later than this cutoff is treated as history, not pulse.
 */
export const PULSE_WINDOW_MONTHS = 18;

/**
 * The most items the strip ever shows. The strip is deliberately secondary to
 * the explorer, so a burst of changes is capped rather than allowed to grow the
 * homepage. Newest events win the cap.
 */
export const PULSE_MAX_ITEMS = 6;

/**
 * Which source to link when an event cites several. Earlier is preferred, so an
 * official announcement is chosen over a repository mirror when both are
 * present. This picks *which* primary source to surface; it never invents one.
 */
const SOURCE_TYPE_PRIORITY: readonly SourceReference['type'][] = [
  'official-announcement',
  'official-docs',
  'model-card',
  'repository',
  'benchmark-owner',
  'independent-evaluation',
];

/** Codepoint order, so output does not vary with the host's locale. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

function modelRoute(base: string, slug: string): string {
  return `${normalizeBase(base)}models/${slug}/`;
}

/** A single recorded change, resolved to everything the strip renders. */
export interface ReleasePulseItem {
  /** The release event's own id. Stable across builds. */
  id: string;
  releaseId: string;
  /** The release's display name, or the raw id if the release is missing. */
  releaseName: string;
  /** The release's generated Model Passport route. */
  releaseRoute: string;
  type: ReleaseEvent['type'];
  /** Plain-words label for the event type, e.g. "Generally available". */
  typeLabel: string;
  /** The raw source-dated date. Partial, so never rendered directly. */
  date: string;
  datePrecision: DatePrecision;
  /** The date rendered no more precisely than its source stated it. */
  dateLabel: string;
  /** What changed, in the source's own terms. */
  note: string;
  /** When we last re-checked this record. Not a release date. */
  verifiedAt: string;
  /** The one primary source this item links to. */
  source: { title: string; url: string };
}

export interface ReleasePulseOptions {
  /** Site base path, for building Model Passport routes. */
  base: string;
  /** The build's reference day as `YYYY-MM-DD`. The window is counted back from it. */
  now: string;
  /** Override the default window. Whole months. */
  windowMonths?: number;
  /** Override the default item cap. */
  maxItems?: number;
}

export interface ReleasePulse {
  /** The events inside the window, newest first, capped at `maxItems`. */
  items: ReleasePulseItem[];
  windowMonths: number;
  maxItems: number;
  /** The inclusive lower bound of the window as `YYYY-MM-DD`. */
  windowStart: string;
  /** The reference day the window was counted back from. */
  now: string;
  /** The newest recorded change date in the whole dataset, or null if none. */
  latestEventDate: string | null;
  /** How many events fell in the window before the cap was applied. */
  totalInWindow: number;
  /** True when the dataset carries no release events at all. */
  isEmpty: boolean;
  /** True when events exist but none fall in the window. An honest stale state. */
  isStale: boolean;
}

/**
 * The inclusive lower bound of the window, counted back from the build date.
 *
 * Month arithmetic is done in UTC so a build's timezone cannot shift the cutoff
 * by a day. A month subtraction that lands on a shorter month rolls forward the
 * way `Date.UTC` normalises it; the result is only ever compared against event
 * dates, never rendered, so the exact overflow day carries no meaning.
 */
export function pulseWindowStart(now: string, windowMonths: number): string {
  const [year, month, day] = now.split('-').map(Number);
  const anchor = new Date(Date.UTC(year, month - 1 - windowMonths, day));
  return anchor.toISOString().slice(0, 10);
}

/**
 * Whether an event's source-dated interval reaches into the window. Measured by
 * `latestDay`, so a `2025` event whose interval ends 2025-12-31 still answers a
 * window that opens inside 2025 rather than being dropped for lacking a day. The
 * window has no upper bound: an event a source dated slightly ahead of the build
 * clock stays visible rather than being silently hidden.
 */
function eventInWindow(event: ReleaseEvent, windowStart: string): boolean {
  return latestDay(event.date) >= windowStart;
}

function resolvePrimarySource(
  event: ReleaseEvent,
  sourceById: ReadonlyMap<string, SourceReference>,
): { title: string; url: string } {
  const resolved = event.sourceIds
    .map((id) => sourceById.get(id))
    .filter((source): source is SourceReference => Boolean(source));

  if (resolved.length === 0) {
    // Every event validates with at least one resolvable source, so reaching
    // here means the dataset is internally inconsistent. Fail the build loudly
    // rather than render a change with no way to check it.
    throw new Error(`Release event ${event.id} has no resolvable source`);
  }

  const rank = (source: SourceReference) => {
    const index = SOURCE_TYPE_PRIORITY.indexOf(source.type);
    return index === -1 ? SOURCE_TYPE_PRIORITY.length : index;
  };

  return resolved
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((source) => ({ title: source.title, url: source.url }))[0];
}

/**
 * Derives the Release Pulse from validated data.
 *
 * Pure and deterministic given `now`: the same dataset and reference day always
 * produce the same strip, which is what lets the boundary and ordering be tested
 * without a clock. The Astro page supplies the build date as `now`.
 */
export function buildReleasePulse(dataset: Dataset, options: ReleasePulseOptions): ReleasePulse {
  const {
    base,
    now,
    windowMonths = PULSE_WINDOW_MONTHS,
    maxItems = PULSE_MAX_ITEMS,
  } = options;

  const windowStart = pulseWindowStart(now, windowMonths);
  const releaseById = new Map(dataset.releases.map((release) => [release.id, release]));
  const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));

  // Newest first by the *source-dated* date, with an id tiebreak so equal dates
  // never reorder between builds. Read `event.date`, never `event.verifiedAt`.
  const ordered = [...dataset.releaseEvents].sort(
    (a, b) => comparePartialDatesDescending(a.date, b.date) || compare(a.id, b.id),
  );

  const inWindow = ordered.filter((event) => eventInWindow(event, windowStart));

  const items: ReleasePulseItem[] = inWindow.slice(0, maxItems).map((event) => {
    const release = releaseById.get(event.releaseId);
    return {
      id: event.id,
      releaseId: event.releaseId,
      releaseName: release?.displayName ?? event.releaseId,
      releaseRoute: modelRoute(base, release?.slug ?? event.releaseId),
      type: event.type,
      typeLabel: releaseEventTypeLabel(event.type),
      date: event.date,
      datePrecision: event.datePrecision,
      dateLabel: formatDateWithPrecision(event.date, event.datePrecision),
      note: event.note,
      verifiedAt: event.verifiedAt,
      source: resolvePrimarySource(event, sourceById),
    };
  });

  return {
    items,
    windowMonths,
    maxItems,
    windowStart,
    now,
    latestEventDate: ordered[0]?.date ?? null,
    totalInWindow: inWindow.length,
    isEmpty: dataset.releaseEvents.length === 0,
    isStale: dataset.releaseEvents.length > 0 && inWindow.length === 0,
  };
}

/** Build-time coverage counts and the latest verification stamp across the dataset. */
export interface CoverageStats {
  creators: number;
  families: number;
  releases: number;
  sources: number;
  events: number;
  /**
   * The latest day any release or recorded change was re-verified, or null when
   * the dataset carries neither. This is a *verification* stamp — when we last
   * checked — and is deliberately distinct from a release date.
   */
  latestVerifiedAt: string | null;
  /**
   * The earliest day any release or recorded change was re-verified, over the
   * same population as `latestVerifiedAt`, or null when the dataset carries
   * neither.
   *
   * It is published beside the latest stamp because the latest one alone cannot
   * be read as a freshness claim about the dataset: a single record verified
   * today sets it, no matter how long every other record has gone unchecked. A
   * reader who sees only the newest date learns when *something* was checked,
   * and would reasonably infer something stronger. The pair states the span the
   * dataset was verified across, which is the honest form of the same fact and
   * the one that makes staleness visible rather than hiding it behind the most
   * recently touched record.
   */
  earliestVerifiedAt: string | null;
}

/**
 * Coverage statistics, computed from validated records at build time. Every
 * figure is a count of what the dataset actually holds; nothing here implies the
 * dataset is complete, and no figure is combined with another into a score or a
 * rank.
 */
export function buildCoverageStats(dataset: Dataset): CoverageStats {
  // `verifiedAt` is a full ISO day on every record, so a lexical max is the
  // chronological max. Drawn from both releases and recorded changes so the stat
  // reflects the most recent verification of either.
  const verifiedDates = [
    ...dataset.releases.map((release) => release.verifiedAt),
    ...dataset.releaseEvents.map((event) => event.verifiedAt),
  ].sort(compare);

  // A "creator" is an organization that has actually published — not every
  // organization the dataset records. Serving platforms, hosting providers and
  // consortia are separate entities the data model deliberately keeps distinct
  // (schema.ts), so counting all organizations would overstate creators the
  // instant one such non-creator entity is modelled. We derive the count from
  // releases, the same population the homepage search index is built from, so
  // the panel's "Creators N" claim stays true against what search can find
  // (see homepage-search.test.ts). Today this is identical to a family-derived
  // count — every organization publishes both — but they diverge silently once
  // a family with no releases is added (abdeslam-menacere/ModelTree#441), and a
  // release-derived count is the one that keeps search parity.
  const creatorIds = new Set(dataset.releases.map((release) => release.organizationId));

  return {
    creators: dataset.organizations.filter((organization) => creatorIds.has(organization.id))
      .length,
    families: dataset.families.length,
    releases: dataset.releases.length,
    sources: dataset.sources.length,
    events: dataset.releaseEvents.length,
    latestVerifiedAt: verifiedDates.at(-1) ?? null,
    earliestVerifiedAt: verifiedDates.at(0) ?? null,
  };
}

/** The newest recorded-change date, formatted at its own precision, or null. */
export function latestChangeLabel(pulse: ReleasePulse, dataset: Dataset): string | null {
  if (!pulse.latestEventDate) return null;
  const event = dataset.releaseEvents.find(({ date }) => date === pulse.latestEventDate);
  return event ? formatDateWithPrecision(event.date, event.datePrecision) : null;
}
