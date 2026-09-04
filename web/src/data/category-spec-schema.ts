import { z } from 'zod';
import { isoDate, modelCategory } from './schema';

/**
 * The contract for **category-specific model facts** — the facts that mean
 * something for one kind of model and nothing at all for another (issue #43).
 *
 * ## Why this document exists
 *
 * `releaseSchema` holds what every model has regardless of what it produces:
 * identity, dates and their precision, lifecycle status, categories,
 * modalities, access type, sources, and a `verifiedAt`. Those are the **shared**
 * concepts, and they are shared because a source states them whenever it
 * publishes a model at all.
 *
 * They are not the whole of what a source says. An image model's own
 * documentation states the size of the pictures it makes, whether it edits an
 * existing image or only generates a new one, and how many reference images it
 * accepts. None of those has a home on `releaseSchema`, and none of them should:
 * a `maximumOutput` counted in tokens is not the same fact as an output
 * resolution counted in pixels, and recording the second in the first would be
 * the "reuse language-model fields with misleading labels" that #43 lists as a
 * non-goal.
 *
 * ADR 0007 admitted image and video releases under the shared schema and named
 * this gap as the thing it was deliberately leaving open:
 *
 * > Resolution, duration, frame rate, and aspect-ratio support have nowhere to
 * > go [...] This is accepted deliberately, and it is the gap #43 closes.
 *
 * This document is that gap's floor, for one category.
 * `docs/adr/0016-category-specific-facts-are-a-discriminated-extension.md`
 * records the split and the reasoning behind every constraint below.
 *
 * ## One category is piloted, and the union is what makes that safe
 *
 * {@link categorySpecSchema} is a discriminated union on `category` carrying
 * exactly one member today. That is the pilot #43's own Scope asks for — "pilot
 * one category with a small source-backed dataset before scaling" — and the
 * union is what keeps it from being a special case: a second category arrives as
 * a second member with its own fields, not as an optional field bolted onto the
 * first. {@link CATEGORY_SPEC_COVERAGE} then forces every `modelCategory` member
 * to say which of those two states it is in, so a tenth category cannot ship
 * silently unhandled.
 *
 * ## Deliberately not part of `raw.ts`
 *
 * `gate-scope.mjs` bounds an auto-merging refresh to the documents `raw.ts`
 * composes plus `refresh-runs.json`, and `gates.test.mjs` asserts that
 * correspondence, so adding
 * this file to `raw.ts` would widen ADR 0003's qualifying class — an ADR-level
 * decision rather than a data change, and not one #43 asked for.
 * `variant-positioning-schema.ts`, `glossary-schema.ts` and
 * `refresh-log-schema.ts` are kept out for the same reason and are the precedent
 * this file follows.
 *
 * ## What the shape makes unsayable
 *
 * **No score, no ranking, no cross-category comparison.** There is no numeric
 * field anywhere below, no ordering key, and no field that can name a second
 * release, a second category, or a benchmark. "Better at images than GPT-Image-2"
 * has nowhere to be written, and neither has "8.1 out of 10". A record describes
 * one release against its own sources and stops.
 *
 * **No fact without the words that back it.** Every entry carries both a
 * `quote`, verbatim from one cited source, and a `statement`, which is
 * ModelTree's own recording of it — the same two-part shape
 * `variant-positioning.json` already uses for what a creator says a variant is
 * for. A dimension nobody documented has no entry, and the absence is rendered
 * as "no cited source states this" rather than being filled with a plausible
 * value. That is the repository's inclusion rule applied one level down: leave a
 * field unset when no cited source states it.
 */

const nonEmpty = z.string().min(1);

/**
 * Ids are matched here rather than imported because `schema.ts` keeps its
 * `entityId` module-local. `variant-positioning-schema.ts` restates the same
 * pattern for the same reason, and is the precedent.
 */
const recordId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * The image dimensions this pilot can record.
 *
 * Every member earned its place by being stated outright by at least one
 * primary source already registered in `sources.json` — this vocabulary was
 * read off the sources, not designed in advance and then hunted for. None of
 * them is expressible on `releaseSchema` today, which is the test for belonging
 * here at all.
 *
 * Members are listed as bare literals with nothing between the brackets. That
 * is the convention `accessType` in `schema.ts` documents: `enumMembers` in
 * `.github/skills/modeltree-gates/scripts/gate-dataset.mjs` derives vocabularies
 * by reading declarations as text and executes no TypeScript, so a comment
 * inside the list is a member it cannot read. This enum is not one the gate
 * currently walks, and it is written to the rule anyway so that it stays
 * readable if it ever becomes one.
 */
export const imageSpecDimension = z.enum([
  'output-sizing',
  'aspect-ratio-control',
  'image-editing',
  'multi-image-input',
]);

/**
 * How each dimension is titled on a page.
 *
 * Held beside the vocabulary rather than in `format.ts` so that adding a member
 * to {@link imageSpecDimension} without titling it is a type error. The same
 * total-map discipline as {@link CATEGORY_SPEC_COVERAGE}, one level down.
 */
export const IMAGE_SPEC_DIMENSION_LABELS: Record<z.infer<typeof imageSpecDimension>, string> = {
  'output-sizing': 'Output sizing',
  'aspect-ratio-control': 'Aspect ratio control',
  'image-editing': 'Image editing',
  'multi-image-input': 'Multiple input images',
};

/**
 * The order these dimensions appear in, fixed so two releases are read down the
 * same column. `model-dna.ts` fixes its order for the same reason: a list that
 * reorders itself per record invites a reader to compare rows that are not
 * aligned.
 */
export const IMAGE_SPEC_DIMENSION_ORDER = imageSpecDimension.options;

/** What each dimension is, in ModelTree's words. Never a value's meaning. */
export const IMAGE_SPEC_DIMENSION_DEFINITIONS: Record<
  z.infer<typeof imageSpecDimension>,
  string
> = {
  'output-sizing':
    'What the documentation says about the size of the images this release produces. '
    + 'Recorded as the source frames it, which is sometimes a resolution and sometimes a '
    + 'statement that the size is caller-chosen.',
  'aspect-ratio-control':
    'Whether the documentation says the caller can ask for a particular shape of image, '
    + 'as distinct from a particular number of pixels.',
  'image-editing':
    'Whether the documentation says this release changes an image it is given, rather than '
    + 'only generating a new one from a prompt.',
  'multi-image-input':
    'Whether the documentation says this release accepts more than one input image at once, '
    + 'for example as references to compose from.',
};

/**
 * One documented fact about one dimension.
 *
 * `quote` and `statement` are both required and are deliberately different
 * things. The quote is the source's own words and is what a reader checks;
 * the statement is ModelTree's recording of what those words say about this
 * dimension, and is what the page renders as prose. Requiring both is what
 * stops a recording from quietly outrunning its evidence — the failure the
 * `provenance` rubric in `.github/skills/modeltree-review/SKILL.md` exists to
 * catch.
 *
 * `sourceId` names one source rather than a list, because a quote comes from
 * exactly one document. The record's own `sourceIds` is the superset, and
 * `validateCategorySpecs` refuses a `sourceId` that is not in it.
 */
export const imageSpecFactSchema = z.object({
  dimension: imageSpecDimension,
  statement: nonEmpty,
  quote: nonEmpty,
  sourceId: recordId,
});

export const imageCategorySpecSchema = z.object({
  category: z.literal('image'),
  releaseId: recordId,
  /**
   * At least one, because a record with no facts states nothing and the honest
   * way to say "no source documents any of this" is to hold no record at all.
   * A dimension absent from this list is rendered as undocumented, so absence
   * here is a published fact rather than a hole.
   */
  facts: z.array(imageSpecFactSchema).min(1),
  sourceIds: z.array(recordId).min(1),
  verifiedAt: isoDate,
});

/**
 * The discriminated union #43 asks for, with one member while the pilot runs.
 *
 * Zod's `discriminatedUnion` requires a literal discriminant on every member, so
 * the `category` literal is load-bearing rather than decorative: a second
 * member cannot be added without declaring which category it speaks for, and no
 * member can speak for two.
 */
export const categorySpecSchema = z.discriminatedUnion('category', [imageCategorySpecSchema]);

export type ImageSpecDimension = z.infer<typeof imageSpecDimension>;
export type ImageSpecFact = z.infer<typeof imageSpecFactSchema>;
export type ImageCategorySpec = z.infer<typeof imageCategorySpecSchema>;
export type CategorySpec = z.infer<typeof categorySpecSchema>;

/**
 * Whether a category carries specific facts of its own yet, stated for every
 * member of `modelCategory`.
 *
 * This is the discriminator test #43's testing requirements ask for, held as a
 * total map rather than as a list of the interesting cases. Adding a tenth
 * member to `modelCategory` makes this object fail to typecheck until somebody
 * says which state it is in, so "we forgot about scientific models" is a build
 * error rather than a silently missing section.
 *
 * `shared-schema-only` is a real and honest state, not a to-do: it says the
 * shared fields are all this repository currently records for that category,
 * which is exactly what ADR 0007 permitted for image and video before this
 * document existed. It asserts nothing about whether such models have
 * category-specific facts in the world.
 */
export const CATEGORY_SPEC_COVERAGE: Record<
  z.infer<typeof modelCategory>,
  'piloted' | 'shared-schema-only'
> = {
  'language-reasoning': 'shared-schema-only',
  'multimodal-generalist': 'shared-schema-only',
  coding: 'shared-schema-only',
  image: 'piloted',
  video: 'shared-schema-only',
  'audio-speech': 'shared-schema-only',
  'embedding-reranking': 'shared-schema-only',
  scientific: 'shared-schema-only',
  'robotics-world': 'shared-schema-only',
};

/** The categories a {@link categorySpecSchema} member exists for. */
export const PILOTED_CATEGORIES = Object.freeze(
  (Object.keys(CATEGORY_SPEC_COVERAGE) as z.infer<typeof modelCategory>[]).filter(
    (category) => CATEGORY_SPEC_COVERAGE[category] === 'piloted',
  ),
);

export class CategorySpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategorySpecValidationError';
  }
}

export interface CategorySpecContext {
  /** Release id to the categories that release declares. */
  releaseCategories: ReadonlyMap<string, readonly string[]>;
  knownSourceIds: ReadonlySet<string>;
}

/**
 * Parses the document and enforces the two checks that need nothing but the
 * document itself:
 *
 * 1. **One spec per release per category.** Two records would both render, and
 *    a reader would have no way to tell which was current.
 * 2. **Every quote's source is one the record itself lists.** A `sourceId`
 *    outside `sourceIds` would put a fact's evidence outside the set the page
 *    cites underneath it.
 *
 * The checks that need the dataset live in {@link assertCategorySpecsResolve},
 * separately and deliberately. This function is reachable from the browser
 * bundle through the passport, so it must not import `releases.json` or
 * `sources.json`: doing so shipped a second, unshared copy of both and put the
 * `/compare` critical payload 262 kB over its budget. `variant-positioning`
 * splits along the same line for the same reason — its loader validates the
 * records, and `buildVariantPositioningIndex` does the cross-referencing where
 * the dataset is already in scope.
 */
export function validateCategorySpecs(input: unknown): CategorySpec[] {
  const parsed = z.array(categorySpecSchema).parse(input);
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const spec of parsed) {
    const label = `category spec ${spec.category}/${spec.releaseId}`;

    const key = `${spec.category}/${spec.releaseId}`;
    if (seen.has(key)) issues.push(`${label} duplicates an existing spec for the same release`);
    seen.add(key);

    const listed = new Set(spec.sourceIds);
    for (const item of spec.facts) {
      if (!listed.has(item.sourceId)) {
        issues.push(
          `${label} quotes source "${item.sourceId}" for "${item.dimension}", `
            + 'which the record does not list in sourceIds',
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new CategorySpecValidationError(
      `category spec validation failed:\n- ${issues.join('\n- ')}`,
    );
  }

  return parsed;
}

/**
 * Enforces the cross-references a schema cannot, against a dataset the caller
 * already holds.
 *
 * 1. **The release exists.** A spec naming a release that was renamed or
 *    withdrawn would otherwise sit in the file rendering nowhere, and nothing
 *    would say so.
 * 2. **The release actually carries the category.** This is the check that
 *    keeps the discriminant honest: an `image` spec on a language model would
 *    render image facts on a page that has no business showing them.
 *
 * Run from `category-specs.test.ts` against the shipped dataset, so a broken
 * cross-reference fails `npm run validate` — which `npm run build` runs first,
 * so it cannot ship. Enforcing it at module load instead would mean importing
 * the raw documents here, which is what this split exists to avoid.
 */
export function assertCategorySpecsResolve(
  specs: readonly CategorySpec[],
  context: CategorySpecContext,
): void {
  const issues: string[] = [];

  for (const spec of specs) {
    const label = `category spec ${spec.category}/${spec.releaseId}`;

    const categories = context.releaseCategories.get(spec.releaseId);
    if (!categories) {
      issues.push(`${label} references missing release "${spec.releaseId}"`);
    } else if (!categories.includes(spec.category)) {
      issues.push(
        `${label} is a "${spec.category}" spec, but that release declares only `
          + `${categories.map((category) => `"${category}"`).join(', ')}`,
      );
    }

    for (const sourceId of spec.sourceIds) {
      if (!context.knownSourceIds.has(sourceId)) {
        issues.push(`${label}.sourceIds references missing source "${sourceId}"`);
      }
    }
  }

  if (issues.length > 0) {
    throw new CategorySpecValidationError(
      `category spec validation failed:\n- ${issues.join('\n- ')}`,
    );
  }
}
