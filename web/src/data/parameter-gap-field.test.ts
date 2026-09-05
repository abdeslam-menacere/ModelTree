import { describe, expect, it } from 'vitest';

import { dataset } from './dataset';

const { releases } = dataset;

/**
 * Fifteen releases record no `parameters` block and explain in prose why,
 * because no primary source states a total that could be cited. This test pins
 * that the explanation lives in one field for all of them, so the sixteenth
 * contributor does not have to guess which.
 *
 * The field is `summary`, and the reason is measurable rather than aesthetic.
 * `buildComparisonPayload` ships an explicit allow-list that includes
 * `intendedUse` and excludes `summary`, so a note in `intendedUse` is delivered
 * in the `/compare` payload on every render while the same note in `summary`
 * costs zero shipped bytes (see `web/README.md` "Data notes" and
 * `comparison.test.ts` "keeps the shipped payload within its budget"). An
 * explanation of an *absent* field is editorial context, so it belongs in the
 * editorial field; `intendedUse` is reserved for what the model is for.
 *
 * Until #943 the set was gated solely on the identifier stating a count (a
 * `34B`, `7B`, `2B` and so on), and a record whose count appeared only as
 * approximate prose on its card was treated as a different category. That gate
 * describes how such a record gets *noticed*; it never described where the note
 * belongs, and the dataset had already outgrown it. Four records whose
 * identifier states no count — both Grok releases, `deepseek-v3-2` and
 * `kyutai-moshiko-pytorch-bf16` — documented the same absence in `summary`
 * anyway, which left `tencent-hunyuan-video-t2v` as the only record in the
 * catalogue explaining a missing count in the shipped field. #943 decided the
 * convention follows the absence rather than the name, moved that record's
 * sentence into `summary` unchanged, and widened the filter below to match.
 *
 * Both disjuncts earn their place, and neither is redundant. The identifier arm
 * is the tripwire: a new name-only release added with no `parameters` block and
 * no explanation at all still reddens the count assertion below rather than
 * slipping in silently, which the prose arm alone would not catch. The prose arm
 * is the convention: any record that explains an absent count is held to the
 * field whatever its name says.
 *
 * The set is computed from the data, never hard-coded. Widening a predicate can
 * quietly turn a guard into a tautology, so the two assertions after the field
 * one pin what this filter still refuses — each against a live, non-empty class
 * taken from the dataset rather than from this file's own expectations.
 */
const NAME_STATES_COUNT = /\b\d+(?:\.\d+)?\s*[bB]\b/;
const PARAMETER_GAP = /parameter count/i;

const nameStatesCount = (release: (typeof releases)[number]) =>
  NAME_STATES_COUNT.test(release.id) ||
  NAME_STATES_COUNT.test(release.canonicalName) ||
  NAME_STATES_COUNT.test(release.displayName ?? '');

const documentsGap = (release: (typeof releases)[number]) =>
  PARAMETER_GAP.test(release.summary) || PARAMETER_GAP.test(release.intendedUse);

const gapRecords = releases.filter(
  (release) => !release.parameters && (nameStatesCount(release) || documentsGap(release)),
);

/** Discusses a parameter count *and records one*, so the gap convention is none of its business. */
const recordsTheCount = releases.filter(
  (release) => release.parameters && documentsGap(release),
);

/** No `parameters` block, and raises no count in either its name or its prose. */
const raisesNoCount = releases.filter(
  (release) => !release.parameters && !nameStatesCount(release) && !documentsGap(release),
);

const EXPECTED_GAP_IDS = [
  '01-ai-yi-1-5-34b-chat',
  '01-ai-yi-34b-chat',
  'ai2-molmo-7b-d',
  'apple-fastvlm-7b',
  'deepseek-v3-2',
  'kyutai-moshiko-pytorch-bf16',
  'lg-ai-research-exaone-4-0-32b',
  'maritaca-ai-sabia-7b',
  'moonshot-ai-kimi-audio-7b-instruct',
  'nvidia-cosmos-1-0-diffusion-7b-text2world',
  'nvidia-nemotron-nano-9b-v2',
  'tencent-hunyuan-video-t2v',
  'xai-grok-4-5',
  'xai-grok-4-6',
  'zhipu-ai-cogvideox-2b',
].sort();

describe('parameter-count gaps', () => {
  it('are exactly the fifteen records that record no count and explain why', () => {
    expect(gapRecords.map((release) => release.id).sort()).toEqual(EXPECTED_GAP_IDS);
  });

  it('document the missing count in summary, never in intendedUse', () => {
    for (const release of gapRecords) {
      expect(
        PARAMETER_GAP.test(release.summary),
        `${release.id}: the parameter-count explanation must be in summary`,
      ).toBe(true);
      expect(
        PARAMETER_GAP.test(release.intendedUse),
        `${release.id}: intendedUse ships in the /compare payload, so the gap note must not be there`,
      ).toBe(false);
    }
  });

  // The two exclusions below are what stop the widened filter from being a
  // tautology. Each asserts its class is non-empty first: a class that had
  // emptied would make the exclusion pass by having nothing to exclude, which
  // is the failure this pair exists to catch rather than the pass it looks like.
  it('still excludes records that discuss a parameter count and record one', () => {
    expect(
      recordsTheCount.length,
      'no release both records a parameters block and discusses the count, so this exclusion proves nothing',
    ).toBeGreaterThan(0);

    const gapIds = new Set(gapRecords.map((release) => release.id));
    for (const release of recordsTheCount) {
      expect(
        gapIds.has(release.id),
        `${release.id}: records a parameter count, so it is not a gap and must stay out of the set`,
      ).toBe(false);
    }
  });

  it('still excludes records with no parameters block that raise no count at all', () => {
    expect(
      raisesNoCount.length,
      'every release without a parameters block raises a count somewhere, so this exclusion proves nothing',
    ).toBeGreaterThan(0);

    const gapIds = new Set(gapRecords.map((release) => release.id));
    for (const release of raisesNoCount) {
      expect(
        gapIds.has(release.id),
        `${release.id}: neither its name nor its prose raises a count, so it is not a documented gap`,
      ).toBe(false);
    }

    // The filter admits a strict subset of the records that lack a block, not
    // all of them. Stated as a count so the margin is visible when it narrows.
    const withoutBlock = releases.filter((release) => !release.parameters);
    expect(gapRecords.length).toBeLessThan(withoutBlock.length);
  });
});
