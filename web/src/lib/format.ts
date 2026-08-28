import type { ModelRelease } from '../data/schema';

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

/**
 * A release date rendered no more precisely than its source stated it.
 *
 * `releaseDate` is always stored as a full calendar date, but `datePrecision`
 * records how much of it the source actually supports. Formatting a
 * year-precision record as a day would publish a day nobody claimed, so the
 * precision decides the format rather than the stored string.
 */
export function formatReleaseDate(value: string, precision: ModelRelease['datePrecision']) {
  const date = new Date(`${value}T00:00:00Z`);
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC', year: 'numeric' };

  if (precision === 'month' || precision === 'day') options.month = 'short';
  if (precision === 'day') options.day = 'numeric';

  return new Intl.DateTimeFormat('en', options).format(date);
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