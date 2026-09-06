import { describe, expect, it } from 'vitest';

import {
  DATA_FILES,
  DEFAULT_DONOR_PERCENTILE,
  buildTranche,
  creatorFootprint,
  rankCreators,
  selectDonors,
} from './dataset-tranche.mjs';

/**
 * A fixture rather than the real dataset: these tests are about the cloning
 * rules, and pinning them to live data would make them fail whenever a creator
 * is added -- a test that reports the dataset changing is not a test of this
 * module. That the rules hold against the REAL dataset is established the only
 * way it can be, by arm B building at all: `validateDataset` runs at import
 * during every build, so a clone that broke a uniqueness or referential
 * constraint would fail the build rather than pass quietly.
 */
function fixture(): Record<string, any[]> {
  const empty = Object.fromEntries(Object.keys(DATA_FILES).map((key) => [key, []]));
  return {
    ...empty,
    organizations: [
      { id: 'small', slug: 'small', name: 'Small' },
      { id: 'mid', slug: 'mid', name: 'Mid' },
      { id: 'big', slug: 'big', name: 'Big' },
    ],
    publishers: [{ id: 'pub-shared', organizationId: 'other', name: 'Shared publisher' }],
    families: [
      { id: 'small-f1', organizationId: 'small', slug: 'small-f1', sourceIds: ['s1'] },
      { id: 'mid-f1', organizationId: 'mid', slug: 'mid-f1', sourceIds: ['s1', 's2'] },
      { id: 'big-f1', organizationId: 'big', slug: 'big-f1', sourceIds: ['s1', 's2', 's3'] },
      { id: 'big-f2', organizationId: 'big', slug: 'big-f2', sourceIds: ['s3'] },
    ],
    releases: [
      {
        id: 'small-r1',
        organizationId: 'small',
        familyId: 'small-f1',
        slug: 'small-r1',
        apiAliases: ['small/one'],
        sourceIds: ['s1'],
        note: 'mentions small-f1 inside prose',
      },
      { id: 'mid-r1', organizationId: 'mid', familyId: 'mid-f1', slug: 'mid-r1', sourceIds: ['s2'] },
      { id: 'mid-r2', organizationId: 'mid', familyId: 'mid-f1', slug: 'mid-r2', sourceIds: ['s2'] },
      { id: 'big-r1', organizationId: 'big', familyId: 'big-f1', slug: 'big-r1', sourceIds: ['s3'] },
      { id: 'big-r2', organizationId: 'big', familyId: 'big-f2', slug: 'big-r2', sourceIds: ['s3'] },
      { id: 'big-r3', organizationId: 'big', familyId: 'big-f2', slug: 'big-r3', sourceIds: ['s3'] },
    ],
    sources: [
      { id: 's1', url: 'https://example.com/a', publisherId: 'pub-shared' },
      { id: 's2', url: 'https://example.com/b', publisherId: 'pub-shared' },
      { id: 's3', url: 'https://example.com/c', publisherId: 'pub-shared' },
    ],
    benchmarkResults: [
      { id: 'br1', releaseId: 'big-r1', benchmarkId: 'mmlu', sourceIds: ['s3'] },
    ],
    benchmarks: [{ id: 'mmlu', name: 'MMLU' }],
    variantPositioning: [{ id: 'vp1', familyId: 'big-f1', note: 'x' }],
  };
}

describe('creatorFootprint', () => {
  it('counts sources by reachability, not by a named top-level field', () => {
    // Sources are where a creator's rendered bytes mostly live, and `sourceIds`
    // is nested in some records. A footprint that missed them would rank a
    // prose-heavy creator alongside a bare one.
    expect(creatorFootprint(fixture(), 'big')).toMatchObject({
      families: 2,
      releases: 3,
      sources: 3,
    });
  });

  it('control: a smaller creator measures smaller through the same function', () => {
    const data = fixture();
    expect(creatorFootprint(data, 'small').records).toBeLessThan(
      creatorFootprint(data, 'big').records,
    );
  });
});

describe('selectDonors', () => {
  it('is deterministic, so a reported rate can be re-derived by a later reader', () => {
    const data = fixture();
    expect(selectDonors(data, 2)).toEqual(selectDonors(data, 2));
  });

  it('draws from above the median by default, the conservative direction', () => {
    // Under-stating growth over-states runway, which is what tells a dock it can
    // afford research it cannot land. So the default must not be the smallest.
    const data = fixture();
    const ranked = rankCreators(data).map((entry) => entry.organizationId);
    expect(ranked[0]).toBe('small');
    expect(selectDonors(data, 1)).not.toEqual(['small']);
    expect(selectDonors(data, 1, { percentile: 100 })).toEqual(['big']);
  });

  it('control: the percentile actually moves the selection', () => {
    const data = fixture();
    expect(selectDonors(data, 1, { percentile: 0 })).toEqual(['small']);
    expect(selectDonors(data, 1, { percentile: 0 })).not.toEqual(
      selectDonors(data, 1, { percentile: 100 }),
    );
  });

  it('picks distinct donors so a window of three is not one creator measured thrice', () => {
    const donors = selectDonors(fixture(), 3);
    expect(new Set(donors).size).toBe(3);
  });

  it('returns nothing for a zero-creator tranche', () => {
    expect(selectDonors(fixture(), 0)).toEqual([]);
    expect(DEFAULT_DONOR_PERCENTILE).toBe(75);
  });
});

describe('buildTranche', () => {
  it('adds nothing at all for zero creators, so the control arm is a true control', () => {
    const data = fixture();
    const { dataset, manifest } = buildTranche(data, { creators: 0 });
    expect(manifest.addedRecords).toBe(0);
    for (const key of Object.keys(DATA_FILES)) {
      expect(dataset[key]).toEqual(data[key]);
    }
  });

  it('leaves the input dataset untouched', () => {
    const data = fixture();
    const before = JSON.stringify(data);
    buildTranche(data, { creators: 2 });
    expect(JSON.stringify(data)).toBe(before);
  });

  it('keeps every id unique, which validateDataset would otherwise reject', () => {
    const { dataset } = buildTranche(fixture(), { creators: 2, donors: ['big'] });
    for (const key of Object.keys(DATA_FILES)) {
      const ids = dataset[key].map((record: any) => record.id);
      expect(new Set(ids).size, `${key} has duplicate ids`).toBe(ids.length);
    }
  });

  it('breaks every uniqueness-constrained text field, not only the ids', () => {
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    const unique = (list: unknown[]) => new Set(list).size === list.length;
    expect(unique(dataset.families.map((f: { slug: string }) => f.slug))).toBe(true);
    expect(unique(dataset.releases.map((r: { slug: string }) => r.slug))).toBe(true);
    expect(unique(dataset.organizations.map((o: { slug: string }) => o.slug))).toBe(true);
    expect(unique(dataset.sources.map((s: { url: string }) => s.url))).toBe(true);
  });

  it('keeps a cloned source url parseable, since the schema parses it as a url', () => {
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    for (const source of dataset.sources) {
      expect(() => new URL(source.url)).not.toThrow();
    }
  });

  it('repoints a clone at its own records, not at the donor originals', () => {
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    const clonedReleases = dataset.releases.filter((r: { id: string }) => r.id.endsWith('-rw0'));
    expect(clonedReleases.length).toBe(3);
    for (const release of clonedReleases) {
      expect(release.familyId).toMatch(/-rw0$/);
      expect(release.organizationId).toBe('big-rw0');
      for (const id of release.sourceIds) expect(id).toMatch(/-rw0$/);
    }
  });

  it('leaves references to uncloned entities pointing at the originals', () => {
    // A real new creator cites the same shared publisher; rewriting that would
    // invent an entity the dataset does not have.
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    const cloned = dataset.sources.filter((s: { id: string }) => s.id.endsWith('-rw0'));
    expect(cloned.length).toBeGreaterThan(0);
    for (const source of cloned) expect(source.publisherId).toBe('pub-shared');
  });

  it('rewrites whole-value ids only, so prose mentioning a slug is untouched', () => {
    // A substring rewrite would change rendered bytes for a reason unrelated to
    // the tranche, which is a rate measuring the cloner instead of the data.
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['small'] });
    const clone = dataset.releases.find((r: { id: string }) => r.id === 'small-r1-rw0');
    expect(clone.note).toBe('mentions small-f1 inside prose');
  });

  it('clones records owned through a release, not only the release', () => {
    // Cloning less under-counts growth, which over-states runway -- the
    // direction that loses a dock its research.
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    const cloned = dataset.benchmarkResults.filter((b: { id: string }) => b.id.endsWith('-rw0'));
    expect(cloned.length).toBe(1);
    expect(cloned[0].releaseId).toBe('big-r1-rw0');
  });

  it('clones a family-owned record that lives outside raw.ts', () => {
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    const cloned = dataset.variantPositioning.filter((v: { id: string }) => v.id.endsWith('-rw0'));
    expect(cloned.length).toBe(1);
    expect(cloned[0].familyId).toBe('big-f1-rw0');
  });

  it('carries shared reference entities through unchanged', () => {
    // A new creator brings results against MMLU, not a second MMLU.
    const data = fixture();
    const { dataset } = buildTranche(data, { creators: 2, donors: ['big'] });
    expect(dataset.benchmarks).toEqual(data.benchmarks);
  });

  it('tags each clone distinctly so two clones of one donor coexist', () => {
    const { dataset, manifest } = buildTranche(fixture(), { creators: 2, donors: ['big'] });
    expect(manifest.clones.map((c: { tag: string }) => c.tag)).toEqual(['rw0', 'rw1']);
    const orgIds = dataset.organizations.map((o: { id: string }) => o.id);
    expect(orgIds).toContain('big-rw0');
    expect(orgIds).toContain('big-rw1');
    expect(new Set(orgIds).size).toBe(orgIds.length);
  });

  it('reports what it added, because a rate whose unit is unstated is not checkable', () => {
    const { manifest } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    expect(manifest.added.families).toBe(2);
    expect(manifest.added.releases).toBe(3);
    expect(manifest.added.sources).toBe(3);
    expect(manifest.addedRecords).toBe(manifest.clones[0].records);
  });
});
