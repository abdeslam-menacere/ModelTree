import { describe, expect, it } from 'vitest';
import { dataset, sourceById } from './dataset';

// abdeslam-menacere/ModelTree#481. `validateDataset` already refuses a licence
// claim that cites no OSI-published source, so the first assertion here is a
// second reading of the same rule. It earns its place by covering what the
// validator cannot: that the OSI sources resolve to OSI's own host, and that a
// `false` record rests on the *exhaustive index* rather than on some other
// licence's page — a per-licence page can say a licence was approved, but only
// the complete list can support the claim that one was not.
//
// Every group is guarded for non-vacuity. A rule quantified over an empty set is
// satisfied by definition, so an empty group would let this file report success
// while checking nothing.

const OSI_PUBLISHER_ID = 'open-source-initiative';
const OSI_ORIGIN = 'https://opensource.org';
/** OSI's complete published list of approved licences. */
const OSI_INDEX_URL = 'https://opensource.org/licenses';

const licensed = dataset.releases.filter((release) => release.license !== undefined);
const recordedTrue = licensed.filter((release) => release.license?.osiApproved === true);
const recordedFalse = licensed.filter((release) => release.license?.osiApproved === false);

function osiSourcesOf(release: (typeof dataset.releases)[number]) {
  return release.sourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source) => source?.publisherId === OSI_PUBLISHER_ID);
}

describe('osiApproved citations in the committed dataset', () => {
  it('records the field at both values, so the rules below quantify over something', () => {
    expect(recordedTrue.length).toBeGreaterThan(0);
    expect(recordedFalse.length).toBeGreaterThan(0);
    expect(recordedTrue.length + recordedFalse.length).toBe(licensed.length);
  });

  it('cites a source published by the OSI for every recorded value', () => {
    const uncited = licensed.filter((release) => osiSourcesOf(release).length === 0);
    expect(uncited.map((release) => release.id)).toEqual([]);
  });

  it('keeps every OSI-published source on OSI’s own origin', () => {
    const osiSources = dataset.sources.filter((source) => source.publisherId === OSI_PUBLISHER_ID);
    expect(osiSources.length).toBeGreaterThan(0);
    const offOrigin = osiSources.filter((source) => !source.url.startsWith(`${OSI_ORIGIN}/`));
    expect(offOrigin.map((source) => source.id)).toEqual([]);
  });

  it('rests every osiApproved: false on the exhaustive approved-licence index', () => {
    const indexSource = dataset.sources.find((source) => source.url === OSI_INDEX_URL);
    // Named rather than assumed: without the index in the dataset the check
    // below would hold trivially for every record.
    expect(indexSource).toBeDefined();

    const missingIndex = recordedFalse.filter(
      (release) => !release.sourceIds.includes(indexSource!.id),
    );
    expect(missingIndex.map((release) => release.id)).toEqual([]);
  });

  it('never rests an osiApproved: true on the index alone standing in for a licence page', () => {
    // A `true` record may cite the index, but it must also identify the licence
    // it is claiming approval for — the structural floor `releaseSchema`
    // enforces. Read here over the real data so the two cannot drift apart.
    const unpinned = recordedTrue.filter(
      (release) => !release.license?.spdxId && !release.license?.url,
    );
    expect(unpinned.map((release) => release.id)).toEqual([]);
  });
});
