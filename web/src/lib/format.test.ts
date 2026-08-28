import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { formatDate, formatReleaseDate } from './format';

describe('release dates are rendered no more precisely than they are recorded', () => {
  const releaseDate = '2024-03-07';

  it('renders a day only when the source supports a day', () => {
    expect(formatReleaseDate(releaseDate, 'day')).toBe('Mar 7, 2024');
    expect(formatReleaseDate(releaseDate, 'month')).toBe('Mar 2024');
    expect(formatReleaseDate(releaseDate, 'year')).toBe('2024');
  });

  it('never leaks the placeholder day of a coarser record', () => {
    for (const precision of ['year', 'month'] as const) {
      expect(formatReleaseDate('2024-01-01', precision)).not.toMatch(/\b1\b/);
    }
  });

  it('agrees with the unqualified formatter at day precision', () => {
    for (const release of dataset.releases) {
      if (release.datePrecision === 'day') {
        expect(formatReleaseDate(release.releaseDate, 'day')).toBe(formatDate(release.releaseDate));
      }
    }
  });
});
