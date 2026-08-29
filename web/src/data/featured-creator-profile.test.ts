import { describe, expect, it } from 'vitest';
import { rawDataset } from './raw';
import {
  repoRoot,
  reviewedCreatorIds,
} from '../../../.github/skills/modeltree-gates/scripts/gate-evidence.mjs';

/**
 * Invariant (#534): every creator the homepage leads with has a reviewed updater
 * profile in `tools/updater/profiles`. A featured creator without one is featured
 * while being the creator the refresh is *least* equipped to keep current, since it
 * falls back to `generic/long-tail.json` with no curated origins of its own — a
 * quality risk that surfaces as silence (stale facts on the most prominent surface)
 * rather than as a failure. Nothing else in the repository asserts this.
 *
 * Three properties give this test its value, and each maps to a way #534 warned it
 * could be built wrong:
 *
 *   - Subset, never equality. `featured == profiled` is *false today* and is meant
 *     to be: #494 reduced the homepage lead to five creators by editorial choice
 *     while leaving `alibaba-cloud` and `amazon` profiled. Those two are the current,
 *     legitimate counterexamples — a creator can be worth keeping current without
 *     leading the homepage — so only `featured ⊆ profiled` is asserted, in one
 *     direction. The converse is deliberately *not* asserted.
 *
 *   - Two independent sources, not one. The featured set is derived from the web
 *     dataset (`releases[].featured`); the profiled set is read off disk from
 *     `tools/updater/profiles`, a source the site never reads. Deriving both the
 *     same way would be the `dataset == dataset` tautology (#516) that cannot fail.
 *
 *   - No count, no fixed array, no ordering. #533 and #20 add creators and the
 *     featured set is an editorial choice that may change again, so the durable form
 *     is a set relation, not `5`, `7`, or a pinned list.
 *
 * `featured` is release-derived, not a creator-level flag: zero organizations carry
 * a `featured` key, so an implementation that read `organization.featured` would get
 * `undefined` for all of them, compute an empty featured set, and pass vacuously
 * forever (#516). The non-empty guard below exists to make that failure loud.
 *
 * The reviewed-profile set is read with `gate-evidence.mjs`'s `reviewedCreatorIds`,
 * the same reader that derives which review threshold applies under ADR 0002 / #59.
 * Reusing it rather than re-walking the directory here means its refusals — a padded
 * `creator.id`, a duplicate id, a case-only filename collision, an empty set — guard
 * this test too, and the reviewed set cannot drift between the two readers. It keys
 * on the declared `creator.id`, which is exactly the `creator.id`-vs-filename
 * discriminator #534 requires: the origin catalogues (`origins/*.json`, four of them
 * named after real creators) and the generic long-tail profile live in subdirectories
 * and carry no `creator.id`, so they are never counted as reviewed profiles.
 *
 * This invariant is web-side only. `tools/updater`'s Python gates (`gates.py`) have
 * no notion of `featured` at all — it is a web editorial flag the updater never sees
 * — so this duplicates no rule there. The only logic shared with `tools/updater` is
 * the reviewed-set reader, whose Python counterpart is `ProfileLibrary` in
 * `profiles.py`; the JS `reviewedCreatorIds` mirrors it deliberately, and is reused
 * here rather than recopied.
 */
describe('featured ⊆ reviewed updater profiles', () => {
  const featured = new Set(
    rawDataset.releases.filter((release) => release.featured === true).map((r) => r.organizationId),
  );
  const profiled = reviewedCreatorIds(repoRoot());

  it('derives a non-empty featured set from release flags, not an organization field', () => {
    // Vacuity guard. `featured` lives on releases; no organization carries the key.
    // Were the featured set empty, every subset assertion below would hold vacuously.
    expect(
      featured.size,
      'no featured creators derived — `featured` is a release flag (releases[].featured), '
        + 'not an organization field; reading it off organizations would make this test vacuous',
    ).toBeGreaterThan(0);
    expect([...featured].every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('reads a non-empty reviewed-profile set that excludes a fabricated creator', () => {
    // Differential control that cannot coincide with the answer: a made-up id must be
    // absent, so a reader that returned every string (or a dead one) is caught here
    // rather than silently endorsing the subset relation below.
    expect(profiled.size, 'the reviewed-profile set on disk is empty').toBeGreaterThan(0);
    expect(profiled.has('zzzz-not-a-creator')).toBe(false);
  });

  it('names any featured creator that has no reviewed updater profile', () => {
    const missing = [...featured].filter((creatorId) => !profiled.has(creatorId)).sort();

    // Subset only. `alibaba-cloud` and `amazon` are profiled but not featured (#494);
    // that is legitimate and is why the converse is not asserted. The failure names
    // the offending creator(s) rather than only reporting that a relation was violated.
    expect(
      missing,
      `featured creator(s) with no reviewed profile in tools/updater/profiles: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
