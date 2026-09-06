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
 * Regenerating either list is a deliberate act, not routine maintenance. What
 * forces a regeneration differs between them, and the two are not symmetric --
 * do not read a red on one the way you would read a red on the other.
 *
 * `ORDER_DEPENDENT_AT_PIN` is read as a subset: the assertion names only the
 * pinned ids that STOPPED being order-dependent, so a release added after the
 * pin cannot move it. A red there really does mean an existing release's
 * sourcing changed. Measured: a new order-dependent release takes the derived
 * count 33 -> 34 and leaves this file green.
 *
 * `CITING_ONE_SOURCE_AT_PIN` is read as an exact equality, so it reddens on a
 * NEW release citing one source as well. Measured: adding one reddens the
 * CONTROL block below with zero existing records modified. Both causes are
 * worth a human reading, which is why it costs an edit to a file a refresh
 * cannot reach -- but they call for different fixes, set out at that block.
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
 * added. Measured: adding one takes the corpus 120 -> 121 and the multi-source
 * set 110 -> 111, with this list unmoved at 10.
 *
 * What pinning it anchors is that ten-member exception set, exactly. It does
 * NOT anchor the size of the multi-source population, which it cannot see.
 * The inference that it does is tempting and false: the identity
 * `multi-source = corpus - exceptions` has two unknowns, and pinning the
 * exceptions fixes only one of them. Nothing here fixes the other -- no
 * assertion in this file reads `dataset.releases.length`, or the corpus size
 * in any other form. So the same ten-id list is consistent with a corpus of
 * 120 and with a corpus of 121, which is exactly what the measurement above
 * shows. Shrinkage of the multi-source population is caught in
 * `web/src/data/validate.test.ts`, not here; the CONTROL block below says why
 * that cross-file dependency must survive.
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
    // gone half-blind reads as confirmation. Against the `toBe(33)` it
    // replaces it is stronger in one direction and deliberately weaker in the
    // other, rather than strictly stronger. A count cannot see a swap, so five
    // of these going quiet while five other releases turned order-dependent
    // holds that count at 33 and is red here -- measured, not asserted. A
    // count does see an addition, and this does not, which is the whole fix
    // (#992): adding a release moves the count and must not move this.
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
    // release does not move it. What it anchors exactly is that ten-member
    // exception set -- not the population size, which it cannot see. Measured:
    // a half-load that keeps every pinned id and drops the other 77 of 120
    // releases leaves this assertion green, because it drops only multi-source
    // records and all ten of these cite one. A red here has two causes, not
    // one, and they need opposite responses. Either an existing release gained
    // or lost sources -- read the population and fix the sourcing, or move the
    // id in or out with a note -- or a NEW release citing exactly one source
    // was added, which reddens this equality with no existing record touched
    // at all. Measured: adding one such release reddens the assertion below
    // with zero existing records modified. In that second case nothing
    // existing is broken and there is nothing to restore; source the new
    // release properly, with two or more, which is the shape the guard is
    // asking for.
    //
    // The equality is again the half the pin cannot state. It is **not**
    // strictly stronger than the `toBe(110)` it replaces, and the two do not
    // order: each catches what the other misses. It is stronger against a
    // filter that swaps members while holding the count, which a count cannot
    // see by construction. It is weaker against shrinkage of the multi-source
    // population, because both sides of an equality shrink together. Measured:
    // a half-load keeping every pinned id and dropping the other 77 of 120
    // releases (64%) leaves this file green, where `toBe(110)` reddens with
    // `expected 33 to be 110`.
    //
    // That shrinkage is still caught, and it is caught **in another file**.
    // `RECORDS_AT_DAY_WHEN_PINNED` in `web/src/data/validate.test.ts` pins 117
    // releases by id, and 76 of the 77 that half-load drops are among them, so
    // it reddens naming each one. The dependency is real, and being cross-file
    // it is the fragile kind: do not delete or loosen that pin on the grounds
    // that this file already covers population shrinkage. It does not.
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
    // Near-tautological given the no-repeat precondition asserted above: an
    // array of two or more distinct ids always differs from its reverse, so
    // this cannot fail unless that precondition fails first. What it
    // establishes is narrow -- that the join-comparison `reordered` uses still
    // agrees with a plain arity test, so it has not stopped discriminating --
    // and it is not a check on the population.
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

// A second import from the same module, deliberately kept apart from the import
// block at the top of the file so this block can be appended without touching it
// (that block is concurrently held by another branch, #992).
import { LICENCE_EVIDENCE_PUBLISHER_ID, releaseSourceOrder } from './release-source';

/**
 * The releases whose headline the licence-evidence exclusion moved when this
 * was pinned: 63 of 123. Read as a **subset**, exactly as
 * `ORDER_DEPENDENT_AT_PIN` above is read -- the assertion names only the pinned
 * ids that STOPPED being moved, so a release added after the pin cannot move
 * it. A red here means a named release's headline stopped being rescued from
 * licence evidence: find which, and either restore its sourcing or move the id
 * out with a note saying why.
 *
 * It replaces `expect(moved.length).toBe(63)`, and for the reason #992 gives at
 * the two lists at the top of this file (#1006). A count over a derived
 * population moves whenever the corpus grows, and this file sits outside the
 * class `gate-scope.mjs` admits, so an agent-gated refresh that reddens it
 * cannot carry out the instruction the old comment gave -- "re-measure and
 * update the figure" is an edit to a file the refresh may not touch. Measured:
 * appending one open-weight release citing its own documentation alongside the
 * existing `osi-license-index` -- the ordinary shape of 63 of the 123 records
 * here -- takes the derived count 63 -> 64 and leaves this list green.
 *
 * Regenerating it is a deliberate act, not routine maintenance.
 */
const MOVED_BY_EXCLUSION_AT_PIN: readonly string[] = [
  'meta-llama-4-scout',
  'meta-llama-4-maverick',
  'meta-llama-3-1-405b',
  'meta-llama-3-3-70b',
  'meta-llama-3-2-1b',
  'meta-llama-3-2-3b',
  'meta-llama-3-2-11b-vision',
  'meta-llama-3-2-90b-vision',
  'mistral-large-3-675b-instruct',
  'mistral-ministral-3-8b-instruct',
  'mistral-devstral-2-123b-instruct',
  'mistral-devstral-small-2-24b-instruct',
  'mistral-small-4-119b',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v3-2',
  'alibaba-qwen3-8-2-4t-a95b',
  'alibaba-qwen3-8-27b',
  'microsoft-fara-1-5-27b',
  'microsoft-fara-1-5-4b',
  'microsoft-fara-1-5-9b',
  'ai2-olmo-2-7b',
  'tii-falcon-h1-34b-instruct',
  'moonshot-ai-kimi-k2-instruct',
  'eleutherai-pythia-12b',
  'lg-ai-research-exaone-3-5-7-8b-instruct',
  'lg-ai-research-exaone-4-0-32b',
  'snowflake-arctic-instruct',
  'upstage-solar-pro-preview-instruct',
  'ibm-granite-4-2-30b',
  'baidu-ernie-4-5-300b-a47b',
  'bytedance-seed-oss-36b-instruct',
  'stability-ai-stable-diffusion-3-5-large',
  'minimax-m1-40k',
  'minimax-m1-80k',
  'hugging-face-smollm3-3b',
  '01-ai-yi-1-5-34b-chat',
  'sarvam-ai-sarvam-m-v1',
  'aleph-alpha-pharia-1-llm-7b-control',
  'reka-flash-3-1',
  'nous-hermes-4-14b',
  'liquid-lfm2-1-2b',
  'xiaomi-mimo-7b-rl-0530',
  'ai-singapore-llama-sea-lion-v3-8b',
  '01-ai-yi-34b-chat',
  'alibaba-qwen3-5-397b-a17b',
  'alibaba-qwen3-6-35b-a3b',
  'eleutherai-gpt-neo-2-7b',
  'ibm-granite-4-0-h-small',
  'ibm-granite-4-0-h-tiny',
  'lelapa-ai-inkubalm-0-4b',
  'openbmb-minicpm5-1b',
  'nvidia-nemotron-nano-9b-v2',
  'tencent-hunyuanimage-3-0-standard',
  'tii-falcon-180b',
  'ai2-molmo-7b-d',
  'stability-ai-svd-img2vid-xt',
  'nvidia-cosmos-1-0-diffusion-7b-text2world',
  'zhipu-ai-cogvideox-2b',
  'bytedance-seed-oss-36b-base',
  'openbmb-minicpm-v-4-5',
  'openbmb-minicpm-v-4-6',
  'moonshot-ai-kimi-audio-7b-instruct',
];

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

  it('CONTROL: the exclusion still moves the headline on every release it moved when pinned', () => {
    // Non-vacuity for the invariant above. Two assertions, because the two
    // blindnesses they catch are independent and neither sees the other's hole
    // -- the same division of labour the `orderDependent` CONTROL block above
    // uses, and deliberately the same idiom rather than a second one (#1006).
    //
    // **The pin.** Every release the exclusion moved when the list was taken
    // must still be moved. Read as a subset, not as a count: `toBe(63)` is a
    // census of a derived population, so it also reddens when a release is
    // ADDED, and the fix it then demands -- "re-measure and update the figure"
    // -- is an edit to this file, which `gate-scope.mjs` refuses to an
    // agent-gated refresh. Measured: appending one open-weight release citing
    // its own documentation alongside the existing `osi-license-index` takes
    // the derived count 63 -> 64 and leaves this assertion green. What is
    // deliberately given up is the other direction: a count sees an addition
    // and this does not. What is gained is that a release going quiet is named
    // rather than summed, which a count cannot see at all -- one release
    // dropping out while another starts being moved holds the count at 63.
    //
    // **The invariant**, which the pin cannot state because it cannot name a
    // release that does not exist yet. The exclusion moves a headline exactly
    // when the unfiltered pick is licence evidence AND the release carries some
    // other source: `selectReleaseSource` filters licence evidence out and
    // falls back to the unfiltered set when nothing survives, so a release
    // whose top pick is already documentary keeps it, and one with no
    // alternative at all keeps its licence evidence rather than stranding.
    // That equality is a property of the selector rather than of the corpus, so
    // it holds over records added after the pin. It is what reddens if the
    // exclusion regresses -- `moved` empties while the right-hand side does
    // not. It cannot on its own report that the population is non-empty, which
    // is the pin's job.
    //
    // Both sides are insensitive to the `breadth` term of the total order,
    // which is a GLOBAL citation count, so appending a release that cites an
    // EXISTING source perturbs it for every other release at once. Measured
    // over all 289 sources, a +1 on any single one moves the selected source on
    // 13 of the 123 releases and moves this set on none of them: 109 releases
    // have two or more candidates after the exclusion, 24 have two or more tied
    // at the best rank, and 13 of those flip on a single citation. The
    // exclusion is decided by rank on every release it moves, and the four
    // `open-source-initiative` sources sit at breadth 30, 11, 36 and 0, far
    // from any documentary tie -- so the knife-edge is real for the headline
    // and does not reach this membership.
    const citations = countReleaseCitations(dataset.releases);
    const order = releaseSourceOrder(citations);
    const resolvedSources = (ids: readonly string[]) =>
      ids
        .map((id) => sourceById.get(id))
        .filter((candidate): candidate is SourceReference => candidate !== undefined);
    // Computed against the same total order with no exclusion applied, which is
    // exactly the pre-change selection.
    const unfilteredPick = (ids: readonly string[]) => [...resolvedSources(ids)].sort(order)[0];
    const moved = dataset.releases.filter((release) => {
      const before = unfilteredPick(release.sourceIds);
      const after = selectReleaseSource(release.sourceIds, sourceById, release.id, citations);
      return before !== undefined && before.id !== after.id;
    });

    const stillMoved = new Set(moved.map(({ id }) => id));
    const wentQuiet = MOVED_BY_EXCLUSION_AT_PIN.filter((id) => !stillMoved.has(id));
    expect(wentQuiet).toEqual([]);

    const licenceLed = dataset.releases.filter((release) => {
      const resolved = resolvedSources(release.sourceIds);
      const before = unfilteredPick(release.sourceIds);
      return before !== undefined
        && before.publisherId === LICENCE_EVIDENCE_PUBLISHER_ID
        && resolved.some((candidate) => candidate.publisherId !== LICENCE_EVIDENCE_PUBLISHER_ID);
    });
    expect(moved.map(({ id }) => id)).toEqual(licenceLed.map(({ id }) => id));
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
