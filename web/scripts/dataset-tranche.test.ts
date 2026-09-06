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
    // `usage-syntheses.json` holds ZERO records today, which is the only reason
    // omitting it from the clone set is currently inert. A test that read the
    // real file would therefore pass whether or not syntheses are cloned, and
    // would prove nothing about either. The fixture is non-empty on purpose, and
    // the tests below assert its size before reading any result from it.
    usageObservations: [
      { id: 'uo1', releaseId: 'big-r1', metric: 'downloads', sourceIds: ['s3'] },
      { id: 'uo2', releaseId: 'big-r1', metric: 'downloads', sourceIds: ['s3'] },
    ],
    usageSyntheses: [
      {
        id: 'us1',
        releaseId: 'big-r1',
        statement: 'Two readings of big-r1 downloads agree.',
        // `usageSynthesisSchema` requires at least two, and they are entity ids
        // of records this same donor owns -- so a clone that did not remap them
        // would point at the donor's observations, not its own.
        observationIds: ['uo1', 'uo2'],
        agreement: 'agreeing',
      },
    ],
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

/**
 * A donor that clones nothing is the dangerous input, not an academic one.
 *
 * `buildTranche` loops `creators` times and takes `chosen[index % chosen.length]`,
 * so a donor id that matches no organization clones ZERO records while still
 * counting in the denominator that `rateOf` divides by. The measured rate is then
 * diluted in proportion, `affordable` is over-stated in proportion, and because
 * the surviving real donors still move the figures the run has `rated > 0` and
 * exits 0. That is the over-states-runway direction this module's header calls
 * the one that loses work: a dock told it can afford six creators when it can
 * afford three does three creators of research that cannot land.
 *
 * The realistic trigger needs no typo. `organizations.json` carries `mistral-ai`,
 * so `--donors mistral,cohere,ai2` -- the natural way to write that set, with two
 * real ids -- silently drops a third of the intended growth.
 */
describe('a donor that would clone nothing', () => {
  it('is refused, rather than diluting the rate it was supposed to contribute to', () => {
    expect(() =>
      buildTranche(fixture(), { creators: 3, donors: ['big', 'zz-not-a-creator', 'mid'] }),
    ).toThrow(/zz-not-a-creator/);
  });

  it('control: a donor set that is entirely real is not refused', () => {
    // Without this arm the check above passes just as well against a function
    // that throws at every donor set, which would refuse every real run.
    expect(() =>
      buildTranche(fixture(), { creators: 3, donors: ['big', 'mid', 'small'] }),
    ).not.toThrow();
  });

  it('names every unknown id, not only the first, so one run fixes the whole flag', () => {
    let message = '';
    try {
      buildTranche(fixture(), { creators: 2, donors: ['aa-nope', 'bb-nope'] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/aa-nope/);
    expect(message).toMatch(/bb-nope/);
  });

  it('suggests the near miss, because the realistic case is a real creator under another id', () => {
    // `mistral` -> `mistral-ai` in the real dataset; `big-ai` -> `big` here.
    expect(() => buildTranche(fixture(), { creators: 1, donors: ['big-ai'] })).toThrow(/big/);
  });

  it('refuses before building, so no caller can read a diluted manifest at all', () => {
    // The dilution is only observable in a manifest that was returned. Asserting
    // the throw is asserting that none is.
    let manifest: any = null;
    try {
      ({ manifest } = buildTranche(fixture(), { creators: 3, donors: ['big', 'zz-nope', 'mid'] }));
    } catch {
      /* expected */
    }
    expect(manifest).toBeNull();
  });

  it('every clone in a manifest it did return contributed records', () => {
    const { manifest } = buildTranche(fixture(), { creators: 4, donors: ['big', 'mid'] });
    expect(manifest.clones).toHaveLength(4);
    for (const clone of manifest.clones) expect(clone.records).toBeGreaterThan(0);
  });

  it('unknown and clones-nothing are the same set, which is why membership is the check', () => {
    // The property is "contributes no records". The implementation checks
    // membership. They coincide only because `collectOwned` always yields at
    // least the organization record itself, so this asserts that rather than
    // assuming it -- with the other arm alongside, or it would pass while every
    // footprint was zero.
    const data = fixture();
    for (const org of data.organizations) {
      expect(creatorFootprint(data, org.id).records).toBeGreaterThan(0);
    }
    expect(creatorFootprint(data, 'zz-not-a-creator').records).toBe(0);
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

/**
 * Usage syntheses are release-owned and were absent from the clone set (#1031).
 *
 * `usageSynthesisSchema` declares `releaseId: entityId`, so a synthesis traces
 * to a donor creator by exactly the route every other release-owned collection
 * does. Leaving it out clones less than the donor really consists of, which
 * under-counts growth, which over-states runway -- the direction this module's
 * header names as the one that loses work.
 *
 * WHY A FIXTURE AND NOT THE REAL FILE. `web/src/data/usage-syntheses.json` holds
 * 0 records at this writing, and that emptiness is the whole reason the omission
 * is inert rather than live. An empty subject yields the same reading as a
 * correct one, so a test pointed at the real file would pass against the broken
 * module and against the fixed one alike. Every test here therefore asserts the
 * fixture's SIZE before it reads anything out of a build.
 */
describe('release-owned usage syntheses', () => {
  it('the fixture is non-empty, or nothing below this line means anything', () => {
    // Stated as its own assertion rather than assumed by the others: if a later
    // edit empties this fixture, this fails loudly instead of leaving four
    // vacuous passes behind.
    const data = fixture();
    expect(data.usageSyntheses.length).toBe(1);
    expect(data.usageSyntheses[0].observationIds.length).toBeGreaterThanOrEqual(2);
    expect(data.usageObservations.length).toBe(2);
  });

  it('is cloned with the donor, like every other collection owned via releaseId', () => {
    const { dataset, manifest } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    const cloned = dataset.usageSyntheses.filter((s: { id: string }) => s.id.endsWith('-rw0'));
    expect(cloned.length).toBe(1);
    expect(manifest.added.usageSyntheses).toBe(1);
  });

  it('remaps releaseId AND observationIds, so the clone reads its own records', () => {
    // Two distinct reference shapes in one record: a scalar id and an array of
    // ids. A fix that remapped only the scalar would leave the clone quoting the
    // donor's observations while claiming to synthesise its own.
    const { dataset } = buildTranche(fixture(), { creators: 1, donors: ['big'] });
    const clone = dataset.usageSyntheses.find((s: { id: string }) => s.id === 'us1-rw0');
    expect(clone).toBeDefined();
    expect(clone.releaseId).toBe('big-r1-rw0');
    expect(clone.observationIds).toEqual(['uo1-rw0', 'uo2-rw0']);
  });

  it('leaves no cloned reference pointing at a record that was not cloned', () => {
    // The acceptance criterion stated as reachability rather than as string
    // shape: a suffix test would pass on `uo9-rw0` even if no such observation
    // existed. A reference into thin air is a broken tranche.
    const { dataset } = buildTranche(fixture(), { creators: 2, donors: ['big'] });
    const releaseIds = new Set(dataset.releases.map((r: { id: string }) => r.id));
    const observationIds = new Set(dataset.usageObservations.map((o: { id: string }) => o.id));
    const cloned = dataset.usageSyntheses.filter((s: { id: string }) => s.id !== 'us1');
    expect(cloned.length).toBe(2);
    for (const synthesis of cloned) {
      expect(releaseIds.has(synthesis.releaseId), `${synthesis.id} releaseId`).toBe(true);
      for (const id of synthesis.observationIds) {
        expect(observationIds.has(id), `${synthesis.id} observationIds`).toBe(true);
      }
    }
  });

  it('control: the donor original is untouched, so the clone is an addition', () => {
    // Without this arm the assertions above would pass just as well against a
    // module that rewrote the donor's own synthesis in place -- which would be a
    // corrupted dataset reported as growth.
    const data = fixture();
    const { dataset } = buildTranche(data, { creators: 1, donors: ['big'] });
    const original = dataset.usageSyntheses.find((s: { id: string }) => s.id === 'us1');
    expect(original).toEqual(data.usageSyntheses[0]);
    expect(original.observationIds).toEqual(['uo1', 'uo2']);
  });

  it('control: a donor owning no synthesis clones none, so the count tracks the donor', () => {
    // The other direction of the same instrument. If this returned 1 as well,
    // the assertions above would be reading something other than the donor's
    // records -- an instrument that answers the same thing to everything.
    const { dataset, manifest } = buildTranche(fixture(), { creators: 1, donors: ['small'] });
    expect(manifest.added.usageSyntheses).toBe(0);
    expect(dataset.usageSyntheses.filter((s: { id: string }) => s.id.endsWith('-rw0'))).toEqual([]);
  });
});
