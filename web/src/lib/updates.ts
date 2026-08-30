import { comparePartialDatesDescending } from '../data/partial-date';
import type {
  Dataset,
  DatePrecision,
  ModelRelease,
  Publisher,
  ReleaseEvent,
  SourceReference,
} from '../data/schema';
import type { FacetValue } from './catalog';
import { modelRoute } from './catalog';
import { categoryLabel, formatDate, formatDateWithPrecision } from './format';
import { organizationLabel } from './organization-name';
import { releaseEventTypeLabel } from './provider-profile';

/**
 * The verified update ledger: every recorded release event, resolved to
 * everything a reader needs to check it, and grouped into the month and year
 * rails `/updates` renders.
 *
 * This is deliberately *not* `timeline.ts`. That module answers "when did models
 * appear", and to do it merges releases and events into one-line entries that
 * carry a date, a name and a kind. This one answers "what changed, and how would
 * I know", so every record carries the source's own note, the sources it rests
 * on, and the day we last re-checked it. The two surfaces stay separate because
 * a release has no what-changed note and inventing one would be exactly the
 * marketing summary the issue rules out.
 *
 * Three rules hold this module honest, and each is tested rather than trusted:
 *
 * - **Recency is the source's date, never ours.** Ordering and grouping read
 *   `event.date`. `verifiedAt` records when *we* last looked and moves every
 *   time we do, so a five-year-old correction re-checked this morning must not
 *   surface as this morning's news. Both dates are shown, labelled as what they
 *   are, and never substituted for one another.
 * - **An event is emitted once.** Records are keyed by event id and built by a
 *   single pass over `dataset.releaseEvents`. Nothing walks models and then
 *   their events, which is the only shape in which one event could reach the
 *   page twice, and a repeated id is a build failure rather than a duplicate.
 * - **Dates stay as partial as their source left them.** A `2026` event states
 *   some day in 2026 and no month, so it is never assigned one; it lands in an
 *   explicit undated bucket inside its year that says so.
 */

export class UpdatesIndexError extends Error {
  constructor(issues: string[]) {
    super(`Update index generation failed:\n- ${issues.join('\n- ')}`);
    this.name = 'UpdatesIndexError';
  }
}

/** One primary source an update rests on, resolved for linking. */
export interface UpdateSourceLink {
  id: string;
  title: string;
  url: string;
  type: SourceReference['type'];
  /** The organisation that published the source, or null when unresolvable. */
  publisherName: string | null;
  /** The day the source itself was published, when it states one. */
  publishedDate: string | null;
  /** The day we last fetched the source. Ours, not the publisher's. */
  lastCheckedDate: string;
}

/**
 * Another model covered by the same announcement.
 *
 * The issue names the hazard directly: one announcement can cover several
 * releases and produce events that *look* duplicated. They are not duplicates —
 * "Qwen3.8-27B became available" and "Qwen3.8-2.4T-A95B became available" are
 * two facts about two models — so they are never merged into one record. They
 * are cross-referenced instead, which tells a reader why the two entries rhyme
 * without either of them losing its own model, note, or source.
 */
export interface UpdateCompanion {
  eventId: string;
  anchorId: string;
  modelName: string;
  modelRoute: string;
}

/** One recorded release event, resolved to everything `/updates` renders. */
export interface UpdateRecord {
  /** The release event's own id. Stable across builds and across data refreshes. */
  id: string;
  /** The element id this record renders under, so a link to it survives a reload. */
  anchorId: string;
  type: ReleaseEvent['type'];
  /** Plain-words event type, e.g. "Generally available". Never colour alone. */
  typeLabel: string;
  /**
   * The source-stated date, narrowed to what {@link datePrecision} claims. Kept
   * partial, so nothing downstream can print a day nobody stated.
   */
  date: string;
  datePrecision: DatePrecision;
  /** The date rendered no more precisely than its source stated it. */
  dateLabel: string;
  /** What changed, in the source's own terms. */
  note: string;
  /** The day we last re-checked this record. Never a release date. */
  verifiedAt: string;
  verifiedAtLabel: string;
  releaseId: string;
  modelName: string;
  modelSlug: string;
  modelRoute: string;
  creatorSlug: string;
  creatorName: string;
  categories: ModelRelease['categories'];
  categoryLabels: string[];
  sources: UpdateSourceLink[];
  /**
   * Identifies the announcement this event was read from: its source-stated date
   * and the set of sources it cites. Two events sharing a key were read from the
   * same publication on the same date. It is a grouping aid, never an identity —
   * records are keyed by {@link id} alone.
   */
  announcementKey: string;
  /** Other models the same announcement covered. Empty for most records. */
  companions: UpdateCompanion[];
}

export interface UpdateFacets {
  creators: FacetValue[];
  categories: FacetValue[];
  /**
   * Counts per event type. Not a filter dimension — the issue scopes filtering to
   * creator and category — but rendered as a legend, because "announcement,
   * preview, availability, GA, deprecation and correction stay distinguishable"
   * is only observable if a reader can see which kinds are present at all.
   */
  types: FacetValue[];
}

export interface UpdateIndex {
  records: UpdateRecord[];
  facets: UpdateFacets;
  /** True when the dataset records no release events at all. */
  isEmpty: boolean;
  /**
   * The latest day any record in this index was re-checked, or null when empty.
   * A verification stamp for the ledger as a whole; never a release date.
   */
  latestVerifiedAt: string | null;
}

/** Codepoint order, so output never varies with the host's locale. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** How many characters of an ISO date each precision actually claims. */
const PRECISION_WIDTH: Record<DatePrecision, number> = {
  year: 4,
  month: 7,
  day: 10,
};

/**
 * Trims a date to what its precision claims.
 *
 * `validateDataset` already requires the two to agree, so committed data never
 * needs this. It is kept because {@link buildUpdateIndex} is exported and takes
 * any `Dataset`, which makes "a record's date never outruns its precision" a
 * property of this module rather than a consequence of validation having run
 * somewhere upstream.
 */
function toStatedPrecision(date: string, precision: DatePrecision): string {
  return date.slice(0, PRECISION_WIDTH[precision]);
}

function countFacet(entries: Array<{ value: string; label: string }>): FacetValue[] {
  const counts = new Map<string, FacetValue>();

  for (const entry of entries) {
    const existing = counts.get(entry.value);
    if (existing) existing.count += 1;
    else counts.set(entry.value, { value: entry.value, label: entry.label, count: 1 });
  }

  return [...counts.values()].sort((a, b) => compare(a.value, b.value));
}

/**
 * Newest first by the date the *source* stated, with an event-id tiebreak.
 *
 * `comparePartialDates` treats a partial date as the interval of days it could
 * mean, so a `2026` event never outranks a dated 2026 event it might not
 * actually beat. The id tiebreak is what makes two events on the same day order
 * identically in every build, which is what the changelog's determinism rests
 * on.
 */
function byRecency(a: Pick<UpdateRecord, 'date' | 'id'>, b: Pick<UpdateRecord, 'date' | 'id'>) {
  return comparePartialDatesDescending(a.date, b.date) || compare(a.id, b.id);
}

export function updateAnchorId(eventId: string): string {
  return `event-${eventId}`;
}

function announcementKeyOf(event: ReleaseEvent): string {
  return `${event.date}|${[...event.sourceIds].sort(compare).join(',')}`;
}

function resolveSources(
  event: ReleaseEvent,
  sourceById: ReadonlyMap<string, SourceReference>,
  publisherById: ReadonlyMap<string, Publisher>,
  issues: string[],
): UpdateSourceLink[] {
  const links: UpdateSourceLink[] = [];

  for (const id of event.sourceIds) {
    const source = sourceById.get(id);
    if (!source) {
      issues.push(`release event ${event.id} cites missing source "${id}"`);
      continue;
    }
    links.push({
      id: source.id,
      title: source.title,
      url: source.url,
      type: source.type,
      publisherName: publisherById.get(source.publisherId)?.name ?? null,
      publishedDate: source.publishedDate ?? null,
      lastCheckedDate: source.lastCheckedDate,
    });
  }

  // Every event validates with at least one resolvable source. Reaching zero
  // means the dataset is internally inconsistent, and publishing a change with
  // no way to check it is the one outcome this page exists to prevent.
  if (event.sourceIds.length > 0 && links.length === 0) {
    issues.push(`release event ${event.id} has no resolvable source`);
  }

  return links;
}

/**
 * Builds the update ledger from validated data.
 *
 * Pure and deterministic: the same dataset always produces the same records in
 * the same order, with no clock read anywhere. That is what lets the generated
 * changelog be compared byte for byte against a previous build.
 */
export function buildUpdateIndex(dataset: Dataset, base = '/'): UpdateIndex {
  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));
  const releaseById = new Map(dataset.releases.map((item) => [item.id, item]));
  const sourceById = new Map(dataset.sources.map((item) => [item.id, item]));
  const publisherById = new Map(dataset.publishers.map((item) => [item.id, item]));

  const issues: string[] = [];
  const seen = new Set<string>();
  const records: UpdateRecord[] = [];

  for (const event of dataset.releaseEvents) {
    if (seen.has(event.id)) {
      // The duplicate-suppression guarantee, enforced rather than assumed. Two
      // records under one id would render twice and appear twice in the
      // changelog, and no downstream check could tell them apart.
      issues.push(`release event id "${event.id}" is recorded more than once`);
      continue;
    }
    seen.add(event.id);

    const release = releaseById.get(event.releaseId);
    if (!release) {
      issues.push(`release event ${event.id} references missing release "${event.releaseId}"`);
      continue;
    }

    const organization = organizationById.get(release.organizationId);
    if (!organization) {
      issues.push(`release event ${event.id} has no resolvable creator`);
      continue;
    }

    const sources = resolveSources(event, sourceById, publisherById, issues);
    const date = toStatedPrecision(event.date, event.datePrecision);
    const categories = [...release.categories].sort(compare) as ModelRelease['categories'];

    records.push({
      id: event.id,
      anchorId: updateAnchorId(event.id),
      type: event.type,
      typeLabel: releaseEventTypeLabel(event.type),
      date,
      datePrecision: event.datePrecision,
      dateLabel: formatDateWithPrecision(date, event.datePrecision),
      note: event.note,
      verifiedAt: event.verifiedAt,
      verifiedAtLabel: formatDate(event.verifiedAt),
      releaseId: release.id,
      modelName: release.displayName,
      modelSlug: release.slug,
      modelRoute: modelRoute(base, release.slug),
      // The creator of the model, never the party that published the event. A
      // platform announcing availability changes where a model runs, not who
      // built it, so the attribution keeps naming the creator.
      creatorSlug: organization.slug,
      creatorName: organizationLabel(organization),
      categories,
      categoryLabels: categories.map((category) => categoryLabel(category)),
      sources,
      announcementKey: announcementKeyOf(event),
      companions: [],
    });
  }

  if (issues.length) throw new UpdatesIndexError(issues);

  records.sort(byRecency);
  attachCompanions(records);

  const facets: UpdateFacets = {
    creators: countFacet(records.map((record) => ({
      value: record.creatorSlug,
      label: record.creatorName,
    }))),
    categories: countFacet(records.flatMap((record) => record.categories.map((category) => ({
      value: category,
      label: categoryLabel(category),
    })))),
    types: countFacet(records.map((record) => ({
      value: record.type,
      label: record.typeLabel,
    }))),
  };

  // `verifiedAt` is a full ISO day on every record, so a lexical max is the
  // chronological max.
  const verifiedDates = records.map((record) => record.verifiedAt).sort(compare);

  return {
    records,
    facets,
    isEmpty: records.length === 0,
    latestVerifiedAt: verifiedDates.at(-1) ?? null,
  };
}

/**
 * Cross-references events read from the same announcement, in place.
 *
 * Only events about *different* models are linked: two events about one model
 * from one publication are two lifecycle steps, not one announcement seen twice,
 * and pointing a reader from a record back to its own model would say nothing.
 */
function attachCompanions(records: UpdateRecord[]): void {
  const byAnnouncement = new Map<string, UpdateRecord[]>();

  for (const record of records) {
    const group = byAnnouncement.get(record.announcementKey);
    if (group) group.push(record);
    else byAnnouncement.set(record.announcementKey, [record]);
  }

  for (const group of byAnnouncement.values()) {
    if (group.length < 2) continue;
    for (const record of group) {
      record.companions = group
        .filter((other) => other.releaseId !== record.releaseId)
        .map((other) => ({
          eventId: other.id,
          anchorId: other.anchorId,
          modelName: other.modelName,
          modelRoute: other.modelRoute,
        }));
    }
  }
}

/** The month rail inside one year. */
export interface UpdateMonthGroup {
  /** `2026-08`, or `2026-month-not-stated` for the undated bucket. */
  key: string;
  label: string;
  /**
   * True for the bucket holding records whose sources state a year but no month.
   * They stay inside their year and say so, rather than being assigned a month
   * nobody claimed or dropped from the page.
   */
  imprecise: boolean;
  note?: string;
  records: UpdateRecord[];
  count: number;
}

export interface UpdateYearGroup {
  year: string;
  label: string;
  count: number;
  months: UpdateMonthGroup[];
}

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const MONTH_NOT_STATED_SUFFIX = 'month-not-stated';

export function updateRecordYear(record: Pick<UpdateRecord, 'date'>): string {
  return record.date.slice(0, 4);
}

/**
 * Groups records into year rails and, inside each, month rails. Newest first.
 *
 * Every record handed in comes out again: grouping is presentation, so no
 * arrangement of the page can make a recorded change disappear from it.
 *
 * A year-precision record cannot be ordered against the months of its year, so
 * it is not ranked among them. Its bucket is appended after the dated months and
 * carries a note saying why. Placing it first would read as "most recent", which
 * is precisely the claim its source declined to make.
 */
export function groupUpdatesByPeriod(records: readonly UpdateRecord[]): UpdateYearGroup[] {
  const ordered = [...records].sort(byRecency);
  const years = new Map<string, Map<string, UpdateMonthGroup>>();

  for (const record of ordered) {
    const year = updateRecordYear(record);
    const months = years.get(year) ?? new Map<string, UpdateMonthGroup>();
    years.set(year, months);

    const imprecise = record.datePrecision === 'year';
    const key = imprecise ? `${year}-${MONTH_NOT_STATED_SUFFIX}` : record.date.slice(0, 7);
    const existing = months.get(key);

    if (existing) {
      existing.records.push(record);
      existing.count += 1;
      continue;
    }

    const monthIndex = Number(record.date.slice(5, 7)) - 1;

    months.set(key, {
      key,
      label: imprecise ? `${year} · month not stated` : `${MONTH_LABELS[monthIndex]} ${year}`,
      imprecise,
      note: imprecise
        ? `These sources state ${year} only, so the month is not given and these changes are not ordered against the months above.`
        : undefined,
      records: [record],
      count: 1,
    });
  }

  return [...years.entries()]
    .sort(([a], [b]) => compare(b, a))
    .map(([year, months]) => {
      const dated = [...months.values()]
        .filter((month) => !month.imprecise)
        .sort((a, b) => compare(b.key, a.key));
      const undated = [...months.values()].filter((month) => month.imprecise);
      const ordered_ = [...dated, ...undated];

      return {
        year,
        label: year,
        count: ordered_.reduce((total, month) => total + month.count, 0),
        months: ordered_,
      };
    });
}

/**
 * Bytes the records would add to a page payload, for the budget check.
 *
 * `/updates` ships its records to a hydrating island as props, so the ledger's
 * size is paid by every reader of the page. Budgeted per record as well as in
 * total, so "the dataset grew" and "each record got fatter" stay distinguishable
 * — only the second is a regression.
 */
export function measureUpdatesPayload(records: readonly UpdateRecord[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(records)).length;

  return {
    bytes,
    records: records.length,
    bytesPerRecord: records.length === 0 ? 0 : Math.round(bytes / records.length),
  };
}
