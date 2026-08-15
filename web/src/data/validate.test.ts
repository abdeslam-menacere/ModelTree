import { describe, expect, it } from 'vitest';
import { rawDataset } from './raw';
import { validateDataset } from './validate';

function copyDataset() {
  return structuredClone(rawDataset);
}

describe('validateDataset', () => {
  it('accepts the source-backed seed dataset', () => {
    expect(validateDataset(copyDataset()).releases).toHaveLength(3);
  });

  it('rejects a duplicate release id', () => {
    const input = copyDataset();
    input.releases[1].id = input.releases[0].id;

    expect(() => validateDataset(input)).toThrow(/duplicate release id/);
  });

  it('rejects an impossible release date', () => {
    const input = copyDataset();
    input.releases[0].releaseDate = '2025-02-30';

    expect(() => validateDataset(input)).toThrow(/real calendar date/);
  });

  it('rejects a broken family reference', () => {
    const input = copyDataset();
    input.releases[0].familyId = 'missing-family';

    expect(() => validateDataset(input)).toThrow(/familyId references missing id/);
  });

  it('rejects a broken source reference', () => {
    const input = copyDataset();
    input.releases[0].sourceIds = ['missing-source'];

    expect(() => validateDataset(input)).toThrow(/sourceIds references missing id/);
  });

  it('requires a primary source for featured records', () => {
    const input = copyDataset();
    input.sources[0].type = 'independent-evaluation';
    input.sources[1].type = 'independent-evaluation';

    expect(() => validateDataset(input)).toThrow(/featured release .* requires a primary source/);
  });
});