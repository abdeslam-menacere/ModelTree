import { describe, expect, it } from 'vitest';

import { dataset } from './dataset';

const { releases } = dataset;

/**
 * Ten releases assert a parameter count in their identifier (a `34B`, `7B`,
 * `2B` and so on) but record no `parameters` block, because no primary source
 * states a total that could be cited. As of #850 every one of them documents
 * *why* the block is absent — but before #875 they did it in two different
 * fields: five in `summary`, four in `intendedUse`. This test pins that the
 * explanation now lives in one field for all ten, so the eleventh contributor
 * does not have to guess which.
 *
 * `moonshot-ai-kimi-audio-7b-instruct` is the tenth, added by #820. It is
 * exactly the case the note below anticipated: its card states `7B` only inside
 * the model name, and this list reddening is what put the record in front of a
 * contributor rather than letting it land against the wrong field.
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
 * The set is computed from the data, not hard-coded, so an eleventh name-only
 * release added without a `parameters` block reddens the count assertion below
 * rather than slipping in against the wrong field silently. Records whose count
 * appears only in prose on a source (e.g. a card that says "over 13 billion
 * parameters" without an exact figure) are a different category and are not
 * enumerated here, because their identifier states no count.
 */
const NAME_STATES_COUNT = /\b\d+(?:\.\d+)?\s*[bB]\b/;
const PARAMETER_GAP = /parameter count/i;

const gapRecords = releases.filter(
  (release) =>
    !release.parameters &&
    (NAME_STATES_COUNT.test(release.id) ||
      NAME_STATES_COUNT.test(release.canonicalName) ||
      NAME_STATES_COUNT.test(release.displayName ?? '')),
);

const EXPECTED_GAP_IDS = [
  '01-ai-yi-1-5-34b-chat',
  '01-ai-yi-34b-chat',
  'ai2-molmo-7b-d',
  'apple-fastvlm-7b',
  'lg-ai-research-exaone-4-0-32b',
  'maritaca-ai-sabia-7b',
  'moonshot-ai-kimi-audio-7b-instruct',
  'nvidia-cosmos-1-0-diffusion-7b-text2world',
  'nvidia-nemotron-nano-9b-v2',
  'zhipu-ai-cogvideox-2b',
].sort();

describe('name-only parameter-count gaps', () => {
  it('are exactly the ten records that state a count in the name but record none', () => {
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
});
