import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dataset, sourceById } from '../data/dataset';
import type { SourceReference } from '../data/schema';
import {
  RELEASE_SOURCE_TYPE_PRIORITY,
  buildReleaseSourceIndex,
  countReleaseCitations,
  selectReleaseSource,
} from './release-source';

/**
 * Guards that which source a release cites is decided by something declared,
 * never by where an id happens to sit in `releases.json`.
 *
 * `sourceIds` order is undeclared: `schema.ts` carries 13
 * `sourceIds: z.array(entityId).min(1)` declarations, none with a `.max()` and
 * none with an ordering comment, and nothing sorts the array between the JSON
 * and the page. Permuting it is therefore a semantically null edit, so the
 * cited source must not move when it happens.
 *
 * That is one of two holes and it is the lower one. Permutation-invariance
 * holds under *any* total order, so it is invariant to the policy that decides
 * which source wins -- which left `RELEASE_SOURCE_TYPE_PRIORITY` itself
 * unasserted. Measured on this dataset by mutating the shipped exported array
 * in place: adopting the `release-pulse.ts` order moves the cited source on 56
 * of 120 releases, promoting `model-card` above `official-docs` moves 75, and
 * reversing the array moves 99 -- the whole population of releases citing more
 * than one source type -- with the suite green throughout. The block below
 * closes that (#936). Both guards are needed; neither can see the other's hole.
 */

const permutations = (ids: readonly string[]): readonly string[][] => [
  [...ids].reverse(),
  [...ids].sort(),
  [...ids].sort().reverse(),
];

/** The pre-fix expression, kept as the control that the dataset still exercises
 * the defect. If this stops finding order dependence, the guard below has gone
 * vacuous and must fail loudly rather than pass for free. */
const legacySelect = (ids: readonly string[]) =>
  ids
    .map((sourceId) => sourceById.get(sourceId))
    .find((candidate) => candidate?.type === 'official-docs')
    ?? sourceById.get(ids[0]);

const source = (id: string, type: SourceReference['type']): SourceReference => ({
  id,
  url: `https://example.invalid/${id}`,
  title: `Title for ${id}`,
  type,
  publisherId: 'example-publisher',
  lastCheckedDate: '2026-01-01',
});

const mapOf = (...entries: SourceReference[]) =>
  new Map(entries.map((entry) => [entry.id, entry]));

describe('release source selection is permutation-invariant', () => {
  it('cites the same source for every release when sourceIds are reordered', () => {
    const committed = buildReleaseSourceIndex(dataset.releases, sourceById);

    for (const permute of [0, 1, 2]) {
      const reordered = buildReleaseSourceIndex(
        dataset.releases.map((release) => ({
          ...release,
          sourceIds: permutations(release.sourceIds)[permute],
        })),
        sourceById,
      );
      expect(reordered).toEqual(committed);
    }
  });

  it('CONTROL: the committed dataset still contains order-dependent releases', () => {
    // A positive control for the negative claim above. Were this zero, the
    // guard would be asserting invariance over a population that cannot vary,
    // and its green would mean nothing.
    //
    // Exact, not `> 0`. A floor reddens only on an empty population and passes
    // for any non-zero one, so an instrument that has gone half-blind reads as
    // confirmation: a simulated 16 of the true 33 passes `> 0` and fails
    // `toBe(33)`. If this number moves, the population changed -- re-read it
    // and write the new figure down here. That is the signal this assertion
    // exists to give; it is not a nuisance to silence by loosening the bound
    // back to a floor, which would be `> 0` with extra steps.
    const orderDependent = dataset.releases.filter(
      (release) => legacySelect(release.sourceIds)?.id
        !== legacySelect([...release.sourceIds].reverse())?.id,
    );
    expect(orderDependent.length).toBe(33);
  });

  it('CONTROL: reordering actually changes the input array for some release', () => {
    // Exact for the same reason as above: a floor cannot tell a shrinking
    // population from a healthy one. A change here means releases gained or
    // lost sources, so re-read the population and update the figure rather
    // than relaxing the assertion.
    const reordered = dataset.releases.filter(
      (release) => release.sourceIds.join() !== [...release.sourceIds].reverse().join(),
    );
    expect(reordered.length).toBe(110);
  });
});

describe('selectReleaseSource', () => {
  it('is invariant when a release cites several official-docs sources', () => {
    const sources = mapOf(
      source('zeta-docs', 'official-docs'),
      source('alpha-docs', 'official-docs'),
    );
    const forward = selectReleaseSource(['zeta-docs', 'alpha-docs'], sources, 'r');
    const backward = selectReleaseSource(['alpha-docs', 'zeta-docs'], sources, 'r');
    expect(forward.id).toBe(backward.id);
  });

  it('is invariant when a release cites no official-docs source at all', () => {
    // The shape that makes the `?? sourceById.get(sourceIds[0])` arm observable:
    // two or more sources, none of them official-docs. That arm indexes the RAW
    // id array, so sorting only the mapped candidates leaves this red.
    const sources = mapOf(
      source('zeta-announcement', 'official-announcement'),
      source('alpha-announcement', 'official-announcement'),
    );
    const forward = selectReleaseSource(['zeta-announcement', 'alpha-announcement'], sources, 'r');
    const backward = selectReleaseSource(['alpha-announcement', 'zeta-announcement'], sources, 'r');
    expect(forward.id).toBe(backward.id);
  });

  it('is invariant across source types when none is official-docs', () => {
    const sources = mapOf(
      source('a-repo', 'repository'),
      source('b-card', 'model-card'),
      source('c-announcement', 'official-announcement'),
    );
    const ids = ['a-repo', 'b-card', 'c-announcement'];
    const picks = new Set(
      [ids, [...ids].reverse(), [ids[1], ids[0], ids[2]]].map(
        (order) => selectReleaseSource(order, sources, 'r').id,
      ),
    );
    expect([...picks]).toHaveLength(1);
  });

  it('throws when a release resolves to no source at all', () => {
    expect(() => selectReleaseSource(['missing'], mapOf(), 'lonely-release')).toThrow(
      'No source found for lonely-release',
    );
  });
});

describe('the declared type priority', () => {
  /**
   * The intended order, written out as a literal here on purpose.
   *
   * Deriving these expectations from `RELEASE_SOURCE_TYPE_PRIORITY` would make
   * every assertion below re-derive itself from whatever the array happens to
   * say, so a reorder would still be green and this block would be theatre.
   * The duplication is the guard: changing the policy has to cost an edit to a
   * test that names the new behaviour.
   */
  const INTENDED: readonly SourceReference['type'][] = [
    'official-docs',
    'official-announcement',
    'model-card',
    'repository',
    'benchmark-owner',
    'independent-evaluation',
  ];

  const adjacentPairs = INTENDED.slice(0, -1).map(
    (higher, index) => [higher, INTENDED[index + 1]] as const,
  );

  it('ships exactly the intended order, membership and all', () => {
    // Catches what the behavioural pairs below cannot: a type added, removed,
    // or renamed. An unlisted type ranks last by `rank()`'s -1 branch, which
    // is a silent policy change rather than a type error.
    expect(RELEASE_SOURCE_TYPE_PRIORITY).toEqual(INTENDED);
  });

  // Every adjacent pair, not just the first entry. Pinning only "docs beats
  // announcement" leaves the other four positions free to move. Adjacent pairs
  // are sufficient as well as necessary: a permutation that inverts no
  // adjacent pair preserves the whole order by transitivity, so it is the
  // identity.
  for (const [higher, lower] of adjacentPairs) {
    const winner = `z-${higher}`;
    const loser = `a-${lower}`;

    it(`cites ${higher} in preference to ${lower}`, () => {
      // The ids run the other way deliberately. `a-` sorts before `z-` and
      // neither source is cited by any release, so both tiebreaks below the
      // type rank -- breadth, then id -- favour the LOWER-priority candidate.
      // A pick of the higher type can therefore only have come from the type
      // priority, which is the thing under test.
      const sources = mapOf(source(winner, higher), source(loser, lower));
      for (const order of [[winner, loser], [loser, winner]]) {
        expect(selectReleaseSource(order, sources, 'r').id).toBe(winner);
      }
    });

    it(`CONTROL: with one type the id picks ${lower}'s slot over ${higher}'s`, () => {
      // The other side of that instrument: same ids, same orders, one type, so
      // the rank term cannot separate them. Were this also the `z-` id, the
      // test above would be passing for a reason unrelated to the priority.
      const sources = mapOf(source(winner, lower), source(loser, lower));
      for (const order of [[winner, loser], [loser, winner]]) {
        expect(selectReleaseSource(order, sources, 'r').id).toBe(loser);
      }
    });
  }

  it('cites the documentation on a set mixing docs with every other type', () => {
    // Documentation-first stated once over the whole mix rather than pairwise,
    // with the id tiebreak stacked against docs again: `zzz-docs` sorts last.
    const docs = source('zzz-docs', 'official-docs');
    const others = INTENDED.slice(1).map((type, index) => source(`a${index}-${type}`, type));
    const sources = mapOf(docs, ...others);
    const ids = [docs.id, ...others.map((other) => other.id)];

    for (const order of [ids, [...ids].reverse(), [...ids].sort()]) {
      expect(selectReleaseSource(order, sources, 'r').id).toBe('zzz-docs');
    }
  });

  it('CONTROL: retyping that same source drops it, so its id is not what won', () => {
    // Non-vacuity for the test above. Same ids, same set, one field changed:
    // if `zzz-docs` had won on something other than its type -- a quirk of the
    // ids, or of `mapOf` -- it would still win here. It must not, and what
    // takes its place is the next type down rather than the next id.
    const notDocs = source('zzz-docs', 'independent-evaluation');
    const others = INTENDED.slice(1).map((type, index) => source(`a${index}-${type}`, type));
    const sources = mapOf(notDocs, ...others);
    const ids = [notDocs.id, ...others.map((other) => other.id)];

    expect(selectReleaseSource(ids, sources, 'r').id).toBe('a0-official-announcement');
  });
});

describe('the specificity tiebreak', () => {
  const sources = mapOf(
    source('a-overview', 'official-docs'),
    source('z-release-docs', 'official-docs'),
  );
  const ids = ['a-overview', 'z-release-docs'];

  it('prefers the document cited by fewer releases, in either order', () => {
    // `a-overview` wins on id alone, so this fails if the layer goes inert.
    const citations = new Map([['a-overview', 9], ['z-release-docs', 1]]);
    for (const order of [ids, [...ids].reverse()]) {
      expect(selectReleaseSource(order, sources, 'r', citations).id).toBe('z-release-docs');
    }
  });

  it('CONTROL: without the citation counts the id decides instead', () => {
    // The other side of the same instrument. Were this also `z-release-docs`,
    // the test above would be passing for a reason unrelated to specificity.
    for (const order of [ids, [...ids].reverse()]) {
      expect(selectReleaseSource(order, sources, 'r').id).toBe('a-overview');
    }
  });

  it('counts each release once and does not depend on sourceIds order', () => {
    const releases = [
      { sourceIds: ['shared', 'shared', 'narrow'] },
      { sourceIds: ['narrow-two', 'shared'] },
    ] as unknown as Parameters<typeof countReleaseCitations>[0];
    const counts = countReleaseCitations(releases);
    expect(counts.get('shared')).toBe(2);
    expect(counts.get('narrow')).toBe(1);
    expect(counts.get('narrow-two')).toBe(1);
  });
});

describe('every page reads the shared selector', () => {
  const pages = {
    index: new URL('../pages/index.astro', import.meta.url),
    tree: new URL('../pages/tree.astro', import.meta.url),
    provider: new URL('../pages/providers/[slug].astro', import.meta.url),
  } as const;

  for (const [name, url] of Object.entries(pages)) {
    it(`${name}.astro selects through release-source.ts`, () => {
      const text = readFileSync(url, 'utf8');
      expect(text).toContain('buildReleaseSourceIndex');
      expect(text).not.toContain('sourceIds[0]');
      expect(text).not.toContain("candidate?.type === 'official-docs'");
    });
  }
});

// A second import from the same module, deliberately kept apart from the import
// block at the top of the file so this block can be appended without touching it
// (that block is concurrently held by another branch, #992).
import { LICENCE_EVIDENCE_PUBLISHER_ID, releaseSourceOrder } from './release-source';

describe('a release does not lead with licence evidence (#938)', () => {
  const asOsi = (base: SourceReference): SourceReference => ({
    ...base,
    publisherId: LICENCE_EVIDENCE_PUBLISHER_ID,
  });

  it('prefers a model-documenting source over an OSI licence source, in either order', () => {
    // The OSI source is official-docs and would win on type rank; the alternative
    // is a model-card, which ranks lower. Excluding licence evidence is the only
    // reason the model-card can win, so a model-card pick proves the exclusion
    // fired rather than the type priority. Both orders, so it is not positional.
    const licence = asOsi(source('z-osi-licence', 'official-docs'));
    const card = source('a-model-card', 'model-card');
    const sources = mapOf(licence, card);
    for (const order of [[licence.id, card.id], [card.id, licence.id]]) {
      expect(selectReleaseSource(order, sources, 'r').id).toBe('a-model-card');
    }
  });

  it('excludes by publisher identity, not by the word "licence" in a title', () => {
    // Structural, per the acceptance criterion. A non-OSI source whose title is a
    // licence name stays eligible and wins on type; an OSI source with a
    // documentation-style title is still excluded. Title text decides nothing.
    const nonOsiLicenceTitled: SourceReference = {
      ...source('a-mit-doc', 'official-docs'),
      title: 'The MIT License',
    };
    const card = source('z-model-card', 'model-card');
    const eligible = mapOf(nonOsiLicenceTitled, card);
    expect(selectReleaseSource([nonOsiLicenceTitled.id, card.id], eligible, 'r').id).toBe('a-mit-doc');

    const osiDocTitled: SourceReference = {
      ...asOsi(source('a-osi-docs', 'official-docs')),
      title: 'Developer documentation',
    };
    const excluded = mapOf(osiDocTitled, card);
    expect(selectReleaseSource([osiDocTitled.id, card.id], excluded, 'r').id).toBe('z-model-card');
  });

  it('GUARD: still cites the licence evidence when it is the only source, in either order', () => {
    // The population this protects is empty today -- no release cites only OSI
    // sources -- so without the guard a future single-source release would throw
    // silently. Two OSI sources, nothing else: the release must resolve to one of
    // them rather than strand, and deterministically. `a-osi` wins the total
    // order, so both input orders must return it.
    const first = asOsi(source('a-osi', 'official-docs'));
    const second = asOsi(source('z-osi', 'official-docs'));
    const sources = mapOf(first, second);
    for (const order of [[first.id, second.id], [second.id, first.id]]) {
      expect(selectReleaseSource(order, sources, 'lonely').id).toBe('a-osi');
    }
  });

  it('no committed release leads with licence evidence while it carries an alternative', () => {
    // The behavioural pin on real data: every release that has any non-OSI source
    // must cite a non-OSI headline. Fails on the pre-change selector, where 63 of
    // 120 headlines were OSI-published.
    const citations = countReleaseCitations(dataset.releases);
    for (const release of dataset.releases) {
      const resolved = release.sourceIds
        .map((id) => sourceById.get(id))
        .filter((candidate): candidate is SourceReference => candidate !== undefined);
      const hasAlternative = resolved.some(
        (candidate) => candidate.publisherId !== LICENCE_EVIDENCE_PUBLISHER_ID,
      );
      const chosen = selectReleaseSource(release.sourceIds, sourceById, release.id, citations);
      if (hasAlternative) {
        expect(chosen.publisherId).not.toBe(LICENCE_EVIDENCE_PUBLISHER_ID);
      }
    }
  });

  it('CONTROL: the exclusion moves the headline on exactly the measured population', () => {
    // Non-vacuity for the invariant above, and exact per this file's style: were
    // it a floor it would pass over a shrinking population. If it moves, the data
    // changed -- re-measure and update the figure rather than loosening it.
    // Computed against the same total order with no exclusion applied, which is
    // exactly the pre-change selection.
    const citations = countReleaseCitations(dataset.releases);
    const order = releaseSourceOrder(citations);
    const unfilteredPick = (ids: readonly string[]) =>
      [
        ...ids
          .map((id) => sourceById.get(id))
          .filter((candidate): candidate is SourceReference => candidate !== undefined),
      ].sort(order)[0];
    const moved = dataset.releases.filter((release) => {
      const before = unfilteredPick(release.sourceIds);
      const after = selectReleaseSource(release.sourceIds, sourceById, release.id, citations);
      return before !== undefined && before.id !== after.id;
    });
    expect(moved.length).toBe(63);
  });

  it('CONTROL: no committed release is stranded by the exclusion', () => {
    // The other half of acceptance: 0 releases resolve to nothing. Without the
    // guard, a release citing only licence evidence would throw; none exist today,
    // and the guard keeps the count at 0 either way.
    const citations = countReleaseCitations(dataset.releases);
    const stranded = dataset.releases.filter((release) => {
      try {
        selectReleaseSource(release.sourceIds, sourceById, release.id, citations);
        return false;
      } catch {
        return true;
      }
    });
    expect(stranded.length).toBe(0);
  });
});
