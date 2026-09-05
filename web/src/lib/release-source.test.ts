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

/**
 * The releases that were order-dependent when this was pinned, and the ones
 * that cited exactly one source. Both lists are read by the CONTROL blocks
 * below; both are exact; neither is a population count.
 *
 * That distinction is the whole of #992. The quantity these replace --
 * "how many releases are there of shape X" -- moves whenever a release is
 * added, and this file sits outside the class `gate-scope.mjs` admits, so an
 * agent-gated refresh cannot edit it. Pinning a growing quantity in an
 * unreachable file meant no normally-sourced release could be published at
 * all: two runs researched one, passed every data gate, and stopped here
 * (#935, #986). What is pinned instead is the side that does not grow.
 *
 * Regenerating either list is a deliberate act, not routine maintenance. Both
 * describe releases that already exist, so a change to one means an existing
 * release's sourcing changed -- which is worth a human reading, and is exactly
 * why it costs an edit to a file a refresh cannot reach.
 */
const ORDER_DEPENDENT_AT_PIN: readonly string[] = [
  'openai-gpt-5-6-sol',
  'anthropic-claude-fable-5',
  'anthropic-claude-mythos-5',
  'google-gemini-3-1-pro-preview',
  'google-gemini-3-1-flash-lite',
  'google-gemini-3-5-flash-lite',
  'google-gemini-2-5-pro',
  'google-gemini-2-5-flash',
  'openai-gpt-5-6-cyber',
  'openai-gpt-image-2',
  'anthropic-claude-sonnet-5',
  'google-gemini-3-5-flash',
  'google-gemini-3-6-flash',
  'google-gemini-3-7-flash',
  'xai-grok-4-6',
  'xai-grok-4-5',
  'anthropic-claude-opus-4-8',
  'anthropic-claude-fable-5-1',
  'anthropic-claude-mythos-5-1',
  'alibaba-qwen3-8-flash-next',
  'cohere-command-a-plus-05-2026',
  'nvidia-nemotron-4-340b-base',
  'ai21-labs-jamba-v0-1',
  'zhipu-ai-glm-4-5-air',
  'tencent-hunyuan-video-t2v',
  'databricks-dbrx-instruct',
  'apple-openelm-3b-instruct',
  'minimax-text-01-456b',
  'sakana-ai-evollm-jp-v1-7b',
  'naver-hyperclova-x-seed-text-instruct-1-5b',
  'kyutai-moshiko-pytorch-bf16',
  'maritaca-ai-sabia-7b',
  'apple-fastvlm-7b',
];

/**
 * Releases citing exactly one source: the standing exception, and the
 * complement of the population the guard below is about.
 *
 * A release usually needs one source for its specifications and another for
 * its date, so citing one is the unusual shape -- 10 of 120 when pinned -- and
 * it is the quantity that does NOT move when a normally-sourced release is
 * added. Pinning it anchors the population size exactly, without pinning the
 * population.
 */
const CITING_ONE_SOURCE_AT_PIN: readonly string[] = [
  'openai-gpt-5',
  'openai-gpt-5-1',
  'openai-gpt-5-2',
  'meta-muse-spark',
  'meta-muse-spark-1-1',
  'meta-muse-image',
  'meta-muse-video',
  'microsoft-mai-thinking-1',
  'amazon-titan-text-express',
  'ai21-labs-jurassic-1-jumbo',
];

/**
 * A release repeating a source id, which no release does and none should.
 *
 * Both derivations below assume it: an array of two or more entries is a
 * palindrome only if it repeats one, so "the reversal differs" and "there are
 * two or more entries" name the same set only while this is empty. Asserted
 * rather than assumed, so that a repeat fails as itself instead of surfacing
 * as an unexplained disagreement between two set derivations.
 */
const releasesRepeatingASourceId = () => dataset.releases.filter(
  (release) => new Set(release.sourceIds).size !== release.sourceIds.length,
);

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
    // Two assertions, because the two blindnesses they catch are independent
    // and neither sees the other's hole.
    //
    // **The pin.** Every release that was order-dependent when the list was
    // taken must still be. Exact, not `> 0`: a floor reddens only on an empty
    // population and passes for any non-zero one, so an instrument that has
    // gone half-blind reads as confirmation. It is also strictly stronger than
    // the `toBe(33)` it replaces, because a count cannot see a swap: five of
    // these going quiet while five other releases turned order-dependent held
    // that count at 33 and is red here. What it is not is a count of the
    // population, so adding a release never moves it; that is the fix (#992).
    // A red here means a named release changed how it cites sources: find
    // which, and either restore the sourcing or move the id out with a note
    // saying why. It is not a nuisance to silence by loosening the bound back
    // to a floor, which would be `> 0` with extra steps.
    //
    // **The invariant**, which the pin cannot state because it cannot name a
    // release that does not exist yet. `legacySelect` reads the first
    // `official-docs` source and otherwise falls back to the first id, so it
    // is order-dependent exactly when a release cites two or more sources and
    // the number of `official-docs` among them is not one. That equality is a
    // property of the selector rather than of the corpus, so it holds over
    // records added after the pin and catches a selector that has gone
    // half-blind on them.
    expect(releasesRepeatingASourceId().map(({ id }) => id)).toEqual([]);

    const orderDependent = dataset.releases.filter(
      (release) => legacySelect(release.sourceIds)?.id
        !== legacySelect([...release.sourceIds].reverse())?.id,
    );
    const stillOrderDependent = new Set(orderDependent.map(({ id }) => id));
    const wentQuiet = ORDER_DEPENDENT_AT_PIN.filter((id) => !stillOrderDependent.has(id));
    expect(wentQuiet).toEqual([]);

    const citingSeveralWithoutOneDoc = dataset.releases.filter((release) => {
      const officialDocs = release.sourceIds.filter(
        (sourceId) => sourceById.get(sourceId)?.type === 'official-docs',
      );
      return release.sourceIds.length >= 2 && officialDocs.length !== 1;
    });
    expect(orderDependent.map(({ id }) => id))
      .toEqual(citingSeveralWithoutOneDoc.map(({ id }) => id));
  });

  it('CONTROL: reordering actually changes the input array for some release', () => {
    // Exact for the same reason as above: a floor cannot tell a shrinking
    // population from a healthy one. What changed is which side is pinned.
    //
    // `reordered` is every release citing two or more sources, which was 110 of
    // 120 when this was written -- 91.7% of the corpus, and the normal shape of
    // a well-sourced record here rather than an edge case. Pinning it made
    // adding any normally-sourced release require an edit to this file, and
    // this file is outside the class `gate-scope.mjs` admits, so the only way
    // for a refresh to avoid the edit was to cite a single source and leave a
    // fact unsourced. The dodge is unavailable by design, which is what made
    // the deadlock total rather than occasional (#992).
    //
    // So the **complement** is pinned instead. The releases citing exactly one
    // source are the standing exception set, and adding a normally-sourced
    // release does not move it. It anchors the population size exactly: a
    // half-loaded dataset drops ids the pin names and reddens, which is the
    // shrinkage a floor could not see. A red here means a release gained or
    // lost sources -- read the population and fix the sourcing, or move the id
    // in or out with a note.
    //
    // The equality is again the half the pin cannot state, and it is strictly
    // stronger than `toBe(110)`: a count is blind to a filter that misses five
    // releases while over-reporting five others, and a named set is not.
    expect(releasesRepeatingASourceId().map(({ id }) => id)).toEqual([]);

    const reordered = dataset.releases.filter(
      (release) => release.sourceIds.join() !== [...release.sourceIds].reverse().join(),
    );
    const citingOneSource = dataset.releases.filter(
      (release) => release.sourceIds.length === 1,
    );
    expect(citingOneSource.map(({ id }) => id)).toEqual(CITING_ONE_SOURCE_AT_PIN);

    const citingSeveralSources = dataset.releases.filter(
      (release) => release.sourceIds.length >= 2,
    );
    expect(reordered.map(({ id }) => id)).toEqual(citingSeveralSources.map(({ id }) => id));
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
