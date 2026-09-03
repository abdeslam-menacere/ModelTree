import categorySpecRecords from './category-specs.json';
import {
  validateCategorySpecs,
  type CategorySpec,
  type ImageCategorySpec,
} from './category-spec-schema';

/**
 * Category-specific model facts, validated at build time like every other
 * document here (issue #43).
 *
 * Kept out of `raw.ts` on purpose, following `variant-positioning.ts`,
 * `glossary.ts` and `refresh-log.ts`. `gate-scope.mjs` bounds an auto-merging
 * refresh to the documents `raw.ts` composes plus `refresh-runs.json`, so adding
 * this one there
 * would widen ADR 0003's qualifying class — a decision that belongs to an ADR
 * rather than to a data change. It also carries ModelTree's own `statement`
 * prose beside each quote, which is the kind of writing a person should have to
 * accept. `docs/adr/0013-category-specific-facts-are-a-discriminated-extension.md`
 * records both reasons.
 *
 * This module deliberately imports nothing but its own document. The passport
 * reaches it, so anything imported here travels to the browser: an earlier
 * revision read `releases.json` and `sources.json` for cross-reference checks
 * and shipped a second, unshared copy of both, putting the `/compare` critical
 * payload 262 kB over budget. Those checks now live in
 * `assertCategorySpecsResolve`, which `category-specs.test.ts` runs against the
 * validated dataset — so they still fail `npm run validate`, and `npm run build`
 * runs that first.
 */
export const categorySpecs: CategorySpec[] = validateCategorySpecs(categorySpecRecords);

/**
 * Specs by release id.
 *
 * Keyed by release alone rather than by release and category because
 * `validateCategorySpecs` refuses a second spec for the same pair and no
 * release in the dataset carries two piloted categories. If a release ever
 * needs specs for two categories at once, this becomes a list and the callers
 * that render "the" spec have to say which one they mean — a change worth
 * being made to notice.
 */
export const categorySpecByReleaseId = new Map(
  categorySpecs.map((spec) => [spec.releaseId, spec]),
);

/** The image spec for a release, or `undefined` when no source documented one. */
export function imageSpecForRelease(releaseId: string): ImageCategorySpec | undefined {
  const spec = categorySpecByReleaseId.get(releaseId);

  return spec?.category === 'image' ? spec : undefined;
}
