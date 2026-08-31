import type { DatePrecision, ModelRelease } from '../data/schema';
import { precisionOf, PRECISION_SEGMENTS } from '../data/partial-date';

/**
 * A date *we* recorded — `verifiedAt`, `lastCheckedDate`, `publishedDate`,
 * licence windows. The day is always known for these, because we were the ones
 * observing it, so they are `isoDate` and always render in full.
 *
 * Do not call this on a date a *source* stated. Those are `partialDate` fields
 * and go through `formatDateWithPrecision` below, which is the only function
 * allowed to decide how much of such a date to show.
 */
export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

/**
 * Renders a date only as precisely as the source stated it.
 *
 * Two things carry that precision and they are required to agree: the value's
 * own shape (`2026-03` states a month and nothing finer) and the `datePrecision`
 * recorded beside it. `validateDataset` rejects any record where they disagree,
 * so in committed data they always do.
 *
 * This function nonetheless renders at the **coarser** of the two rather than
 * trusting either alone. That makes "never print a day the source did not give"
 * a property of the formatter itself rather than a consequence of validation
 * having run first — the failure it guards against is one where a day appears
 * in published output *looking* sourced, which is worse than showing less.
 * There is no corresponding harm in showing too little, so the asymmetry
 * decides the direction.
 */
export function formatDateWithPrecision(value: string, precision: DatePrecision) {
  const [year, month, day] = value.split('-');
  const effective = PRECISION_SEGMENTS[precisionOf(value)] < PRECISION_SEGMENTS[precision]
    ? precisionOf(value)
    : precision;

  if (effective === 'year') return year;
  if (effective === 'month') {
    // Day 1 is a formatting placeholder only; nothing below the month is shown.
    return new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${year}-${month}-01T00:00:00Z`));
  }

  return formatDate(`${year}-${month}-${day}`);
}

/** A `partialDate` rendered at the precision its own value states. */
export function formatPartialDate(value: string) {
  return formatDateWithPrecision(value, precisionOf(value));
}

export { precisionOf as precisionOfPartialDate } from '../data/partial-date';

/** A release date rendered no more precisely than its source stated it. */
export function formatReleaseDate(value: string, precision: DatePrecision) {
  return formatDateWithPrecision(value, precision);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('en').format(value);
}

export function statusLabel(status: ModelRelease['status']) {
  return {
    preview: 'Preview',
    current: 'Available',
    legacy: 'Legacy',
    deprecated: 'Deprecated',
    research: 'Research',
    unknown: 'Unknown',
  }[status];
}

export function accessLabel(accessType: ModelRelease['accessType']) {
  return {
    'proprietary-hosted': 'Hosted API',
    'open-weight': 'Open-weight',
    'source-available': 'Source-available',
    both: 'Hosted and open-weight',
  }[accessType];
}

export function categoryLabel(category: ModelRelease['categories'][number]) {
  return {
    'language-reasoning': 'Language and reasoning',
    'multimodal-generalist': 'Multimodal generalist',
    coding: 'Coding',
    image: 'Image',
    video: 'Video',
    'audio-speech': 'Audio and speech',
    'embedding-reranking': 'Embedding and reranking',
    scientific: 'Scientific',
    'robotics-world': 'Robotics and world',
  }[category];
}