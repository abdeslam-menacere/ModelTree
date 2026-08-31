import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rule `/providers/[slug]` has to keep: it may state a served-release count
 * only through the scoped label its view builder produces, never by reaching for
 * the raw number and wording the sentence itself.
 *
 * abdeslam-menacere/ModelTree#578 is what happens when the template words it.
 * `servedReleaseCount` is creator-scoped -- how many of *this* creator's releases
 * the platform is recorded as serving -- and the page rendered it as a bare
 * "N releases served", whose plain reading is the platform's total. The two
 * readings only visibly disagree at zero, so `/providers/amazon/` listed Amazon
 * SageMaker JumpStart under a heading about where models are reached and then
 * said "0 releases served". The number was right; the sentence was wrong.
 *
 * This is a source-level invariant rather than a rendering assertion, and the
 * reason is a measured one. Reaching the real emitted HTML means `astro build`,
 * which the two files in `tests/build/` already do twice under a cross-process
 * lock. Vitest runs one fork per test file, so a third build file does not merely
 * add its own build time: it holds a third fork alive, spin-blocked in
 * `acquireLock`, while the other two builds run. Measured on Windows, adding one
 * took `npm run validate` from 144s green to 228s and 236s, with four workers
 * failing to start at all on the second run. `exclusive-build.ts` exists because
 * this suite is already at the edge of that limit locally, and a test that makes
 * `npm run validate` unreliable for the next contributor costs more than the
 * coverage it adds.
 *
 * What is checked here is stronger than grepping for a phrase: the template must
 * not reference the unscoped number at all. There is then no way for it to
 * render a count except through the label, so no future refactor can quietly
 * reintroduce a sentence the label does not vouch for. The label's own wording --
 * singular, plural and zero -- is pinned against a controlled fixture in
 * `src/lib/provider-profile.test.ts`.
 */

const pageSource = readFileSync(
  fileURLToPath(new URL('../../src/pages/providers/[slug].astro', import.meta.url)),
  'utf8',
);

describe('the provider page renders served-release counts only through the scoped label', () => {
  it('reads the source it is asserting about', () => {
    // Positive control. A path typo would make every assertion below vacuous by
    // reading an empty string, and `not.toContain` passes happily on one.
    expect(pageSource).toContain('profile.servingPlatforms.map');
    expect(pageSource.length).toBeGreaterThan(1000);
  });

  it('renders the scoped label the builder produced', () => {
    expect(pageSource).toContain('view.servedReleaseLabel');
  });

  it('never reaches for the unscoped number, so it cannot word the count itself', () => {
    // The whole defect in one line: with no access to the raw count, the
    // template has nothing to build a bare "N releases served" out of.
    expect(pageSource).not.toContain('servedReleaseCount');
  });

  it('carries none of the unscoped phrasings the page used to render', () => {
    for (const phrasing of ['releases served', 'release served']) {
      expect(pageSource, phrasing).not.toContain(phrasing);
    }
  });

  it('keeps the operator statement as its own separate string', () => {
    // Operator-of and server-of are two relationships and stay two sentences.
    // Collapsing them is what made the zero case read as a contradiction.
    expect(pageSource).toContain('view.relationshipLabel');
  });

  it('would notice the defect it is guarding against', () => {
    // Differential control, run against the page as it was before the fix. If
    // these assertions passed on the old template too, they would be asserting
    // nothing about the new one.
    const beforeTheFix = [
      '<p class="relation-refs">',
      '  {view.servedReleaseCount === 1',
      "    ? '1 release served'",
      '    : `${view.servedReleaseCount} releases served`}',
      '</p>',
    ].join('\n');

    expect(beforeTheFix).toContain('servedReleaseCount');
    expect(beforeTheFix).toContain('releases served');
    expect(beforeTheFix).not.toContain('view.servedReleaseLabel');
  });
});
