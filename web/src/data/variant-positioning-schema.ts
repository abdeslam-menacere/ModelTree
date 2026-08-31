import { z } from 'zod';
import { isoDate } from './schema';
import { findUniversalClaim } from './model-fit-rubric';

/**
 * The contract for **variant positioning** — what a creator says one branch of
 * its own naming ("Opus", "Flash-Lite", "Nano") is for, and what ModelTree makes
 * of that claim.
 *
 * ## Why this document exists
 *
 * A family's variant names are the part of a model's identity a reader is most
 * likely to guess at. The guess that this file exists to make unnecessary is the
 * one that reads a ladder into the names — that the smaller-sounding one is the
 * worse one — and the guess it refuses to replace it with is a ladder of
 * ModelTree's own. What is recorded is what the creator said, quoted, and what
 * ModelTree read into it, labelled. Neither is an ordering.
 *
 * ## Deliberately not part of `raw.ts`
 *
 * `gate-scope.mjs` bounds an auto-merging refresh to exactly the documents
 * `raw.ts` composes, and `gates.test.mjs` asserts that correspondence, so adding
 * this file to `raw.ts` would widen the ADR 0003 qualifying class — an ADR-level
 * decision rather than a data change. It should also stay out on the merits:
 * `editorial.summary` is ModelTree's own voice, and prose written in this
 * repository's name is exactly the kind of change a human should have to accept.
 * `glossary-schema.ts` and `refresh-log-schema.ts` are kept out for the same
 * reason and are the precedent this file follows.
 *
 * ## Why nothing here is called a tier
 *
 * Rendered prose says "tier", because that is the word a reader arrives with.
 * The *fields* say "variant", which is this dataset's own word for the same
 * thing (`releaseSchema.variant` already holds `"Opus"`, `"Flash"`, `"Nano"`).
 * The split is not squeamishness: `RANKING_WORDS` in
 * `.github/skills/modeltree-gates/scripts/gate-dataset.mjs` classes `tier` as
 * ranking vocabulary and refuses it as a key name across the documents it walks.
 * This document is not one of them, so the gate would not read it — which is
 * precisely why the convention is written down here instead of enforced there.
 *
 * ## What the shape makes unsayable
 *
 * Four constraints from issue #38 are discharged by the shape rather than by
 * review attention, because a rule a schema cannot express is a rule that
 * survives exactly as long as everyone remembers it.
 *
 * **No cross-creator analogy.** A record names one `familyId` and, inside it,
 * variant names drawn from that family's own releases. There is no field for a
 * second family, a second creator, or a release outside the family — so
 * "Sonnet sits roughly where Flash sits" has nowhere to be written. The
 * remaining route in is prose, and `lib/variant-positioning.ts` closes it by
 * refusing, at build time, a `summary` or `note` that names another
 * organization or another family.
 *
 * **Nothing is derived from price, and nothing is ranked.** There is no price
 * field and no reference to a pricing record — unlike `model-fit`, which may
 * cite one. `editorial.summary` and `note` additionally run through
 * `findUniversalClaim` and through {@link POSITIONING_CLAIM_PATTERNS} below,
 * which reject the ways a price argument or a recommendation gets written down.
 *
 * **The creator's claim and ModelTree's reading are different fields.**
 * `official` holds *only* verbatim quotes and their source metadata: there is no
 * ModelTree-authored string inside it, so the two voices cannot be blurred by an
 * author who is in a hurry. Where this repository speaks is named by
 * `MODELTREE_PROSE_PATHS` — today `editorial.summary` and the record-level
 * `note` — and a test holds that list to the committed document. The wording
 * filters run over those and never over a `quote`, for the reason
 * `UNIVERSAL_CLAIM_PATTERNS` already gives: a creator's superlative is reported
 * as the creator's claim, not asserted as ModelTree's,
 * and silently editing it would make `official` no longer verbatim.
 *
 * **Absence is not a value here.** There is no "unknown" variant entry and no
 * coverage flag, because a record that could *declare* itself complete could
 * declare it wrongly. Coverage is derived in `lib/variant-positioning.ts` by
 * comparing recorded variants against the family's actual releases, so the
 * complete / partial / absent reading is a measurement rather than a claim.
 *
 * ## Sources are inline, and that has a cost
 *
 * As in the glossary, sources are recorded inline with a verbatim `quote` rather
 * than as ids into `sources.json`. A URL proves a page exists; the quote is what
 * shows the page says what the record says it says, and it is the entire content
 * of `official`. The cost is the same one the glossary records:
 * `.github/workflows/source-link-health.yml` only re-checks `sources.json`, so
 * these URLs get no automated link-health pass, and `lastCheckedDate` is what a
 * reader has instead.
 */

const nonEmpty = z.string().min(1);

const recordId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * Language that turns positioning into a purchase recommendation or a price
 * argument.
 *
 * A vocabulary filter, like `UNIVERSAL_CLAIM_PATTERNS`, and with the same
 * limits: it catches the usual phrasings and cannot catch a recommendation
 * worded around them. It errs toward rejection, because a false positive costs
 * an author a rewording and a false negative ships.
 *
 * Two categories, and it is worth being explicit about why each is here.
 *
 * *Recommendation* language is rejected because "which should I use" is not a
 * question this feature answers — the issue's own non-goal. Positioning explains
 * what a name means; choosing is the reader's, informed by conditional guidance
 * in `model-fit-statements.json`, which carries the rubric and the caveats that
 * a one-line summary cannot.
 *
 * *Price* language is rejected because a cheaper variant is not a worse model,
 * and a summary that reaches for price to explain a name has stopped explaining
 * the name. Prices are recorded in this dataset, with their own sources and
 * their own dates, and they move; a positioning summary that leaned on one would
 * go stale silently. Note that this filter never runs over a `quote` — creators
 * do talk about price, and when they do, that is reported in their voice.
 */
export const POSITIONING_CLAIM_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'direct recommendation', pattern: /\b(?:we\s+)?recommend(?:s|ed|ation|ations)?\b/i },
  { name: 'prescriptive advice', pattern: /\byou\s+(?:should|ought\s+to|must|want\s+to)\b/i },
  { name: 'reach-for framing', pattern: /\b(?:reach\s+for|opt\s+for|pick|choose)\s+(?:this|it|that|the)\b/i },
  { name: 'use-instead framing', pattern: /\buse\s+(?:this|it|that)\s+instead\s+of\b|\binstead\s+of\s+(?:the\s+)?(?:other|larger|smaller)\b/i },
  { name: 'default-choice framing', pattern: /\b(?:default|obvious|safe|sensible)\s+(?:choice|pick|option|bet)\b/i },
  { name: 'downgrade framing', pattern: /\b(?:downgrade|upgrade)\s+to\b|\bstep\s+(?:up|down)\s+to\b/i },
  { name: 'price vocabulary', pattern: /\b(?:price|prices|priced|pricing|cost|costs|costlier|cheap|cheaper|cheapest|expensive|affordable|budget)\b/i },
  { name: 'currency amount', pattern: /(?:[$£€]\s?\d|\bper\s+(?:million\s+)?tokens?\b|\bmtok\b|\bper\s+1m\b)/i },
  { name: 'value-for-money framing', pattern: /\b(?:value\s+for\s+money|bang\s+for|cost[-\s]effective|cost[-\s]efficien\w*|economical)\b/i },
  { name: 'letter grade', pattern: /\bgrade\s+[a-f]\b|\b[a-f][+-]?\s+grade\b/i },
  { name: 'ordered-ladder framing', pattern: /\b(?:top|middle|bottom|entry)[-\s](?:tier|rung|level)\b|\b(?:higher|lower)\s+tier\b/i },
];

/**
 * The first recommendation-or-price phrase in a piece of ModelTree editorial
 * text, or `undefined` when the text stays descriptive.
 */
export function findPositioningClaim(text: string) {
  for (const { name, pattern } of POSITIONING_CLAIM_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { name, phrase: match[0] };
  }

  return undefined;
}

/** Runs both vocabulary filters over one piece of ModelTree-authored prose. */
export function findPositioningWordingProblem(text: string) {
  return findUniversalClaim(text) ?? findPositioningClaim(text);
}

/**
 * A primary source for one variant's official positioning, carrying the words
 * the creator actually used.
 *
 * `quote` is verbatim and required. It may be a contiguous fragment of a longer
 * sentence — a page rarely states positioning in exactly the span that is useful
 * beside a node — but it is never reworded, never joined across an ellipsis, and
 * never trimmed in a way that changes what the sentence does.
 */
export const variantPositioningSourceSchema = z.object({
  url: z.url().refine((value) => value.startsWith('https://'), 'must be https'),
  title: nonEmpty,
  /** The voice behind the page, as a display name. See the note above on why this is not a `publisherId`. */
  publisher: nonEmpty,
  type: z.enum(['official-docs', 'model-card', 'official-announcement']),
  /**
   * Verbatim from the page.
   *
   * Bounded at both ends on purpose. The floor rejects a fragment too short to
   * mean anything on its own ("Fast"), which would put the burden of the claim
   * back on ModelTree's framing of it. The ceiling is the design note "one
   * concise line near sibling nodes" made enforceable: this string is rendered
   * beside a node in the lineage explorer, at 320px, and a quote that needed
   * three lines there would be a paragraph pretending to be a label.
   */
  quote: nonEmpty.min(12).max(200),
  publishedDate: isoDate.optional(),
  lastCheckedDate: isoDate,
});

/**
 * What the creator says this variant is for — and nothing else.
 *
 * Every string in here came off the cited page. That is the whole point of the
 * split: a reader can tell the creator's claim from ModelTree's reading without
 * being asked to trust a colour, a font, or an author's discipline about where
 * the quotation marks go.
 */
export const variantOfficialPositioningSchema = z.object({
  /**
   * The date this wording was observed on the cited page as the creator's
   * current positioning.
   *
   * Not the date the creator adopted it. Docs pages almost never state that, and
   * a positioning ladder can be rewritten without any page saying so, so an
   * adoption date here would be an invention. What this date supports is the
   * only honest reading available: *as of this day, this is what they said*.
   */
  effectiveAsOf: isoDate,
  sources: z.array(variantPositioningSourceSchema).min(1),
});

/**
 * ModelTree's reading of the official positioning, per variant.
 *
 * This is one of the fields carrying ModelTree's own voice in this document;
 * `MODELTREE_PROSE_PATHS` below names them all, and is the list to read rather
 * than a count restated here that a later field would quietly falsify.
 *
 * Kept to a couple of sentences, because a reading longer than the claim it
 * reads has become an argument. The filters below are what stop that argument
 * from becoming a recommendation.
 */
export const variantEditorialPositioningSchema = z.object({
  summary: nonEmpty.min(40).max(400),
  verifiedAt: isoDate,
});

export const variantPositioningEntrySchema = z.object({
  /**
   * The variant name, which must match a `release.variant` in this family
   * exactly. Members are resolved from that match rather than listed here, so a
   * record cannot drift out of step with the releases it describes and cannot
   * name a release in another family — it never names a release at all.
   */
  variant: nonEmpty,
  official: variantOfficialPositioningSchema,
  editorial: variantEditorialPositioningSchema,
}).superRefine((entry, context) => {
  const found = findPositioningWordingProblem(entry.editorial.summary);
  if (!found) return;

  context.addIssue({
    code: 'custom',
    path: ['editorial', 'summary'],
    message:
      `uses unsupported language ("${found.phrase}", ${found.name}); a positioning summary `
      + 'describes what a name means within its family and never ranks, recommends, or reasons from price',
  });
});

export const variantPositioningRecordSchema = z.object({
  id: recordId,
  familyId: recordId,
  /**
   * What this family's naming does and does not settle, in ModelTree's voice.
   *
   * Per family rather than per variant because the useful caveats are about the
   * ladder as a whole: that it is scoped to this generation, that the order
   * below is chronological, that a name means nothing outside these releases.
   */
  note: nonEmpty.min(40).max(400),
  variants: z.array(variantPositioningEntrySchema).min(1),
  verifiedAt: isoDate,
}).superRefine((record, context) => {
  const found = findPositioningWordingProblem(record.note);
  if (found) {
    context.addIssue({
      code: 'custom',
      path: ['note'],
      message:
        `uses unsupported language ("${found.phrase}", ${found.name}); a positioning note `
        + 'describes what a name means within its family and never ranks, recommends, or reasons from price',
    });
  }

  const seen = new Set<string>();
  for (const [index, entry] of record.variants.entries()) {
    const key = entry.variant.toLowerCase();
    if (seen.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['variants', index, 'variant'],
        message: `variant "${entry.variant}" is positioned twice in ${record.id}`,
      });
    }
    seen.add(key);
  }
});

/**
 * Every field in this document that carries ModelTree's own words, as a path
 * from one record.
 *
 * This list exists so that no comment, and no sentence of documentation, has to
 * state a count. A definite enumeration over a set the author has not closed
 * goes false the moment the set grows, and the growth is exactly the moment
 * nobody rereads the prose. So the surrounding comments point here instead of
 * counting, and `variant-positioning.test.ts` holds this list to the committed
 * document and to the filters that enforce it.
 *
 * The limit, stated rather than glossed: the test derives prose paths from the
 * committed records, so it sees a new authored field once a record uses one. An
 * optional field added to the schema and left unused by every record would not
 * redden it.
 *
 * `official` is deliberately absent, and the absence is the point: nothing
 * inside it is ModelTree's to write.
 */
export const MODELTREE_PROSE_PATHS = ['note', 'variants[].editorial.summary'] as const;

export const variantPositioningSchema = z
  .array(variantPositioningRecordSchema)
  .superRefine((records, context) => {
    const ids = new Set<string>();
    const families = new Set<string>();

    for (const record of records) {
      if (ids.has(record.id)) {
        context.addIssue({ code: 'custom', message: `record ${record.id} is recorded twice` });
      }
      ids.add(record.id);

      // One record per family, so that "what does Pro mean here" has exactly one
      // answer. A second record for the same family would not be extra detail;
      // it would be an unresolved disagreement rendered as two lines.
      if (families.has(record.familyId)) {
        context.addIssue({
          code: 'custom',
          message:
            `family ${record.familyId} carries more than one positioning record; `
            + 'a family has one naming scheme and one record describing it',
        });
      }
      families.add(record.familyId);
    }
  });

export type VariantPositioningSource = z.infer<typeof variantPositioningSourceSchema>;
export type VariantOfficialPositioning = z.infer<typeof variantOfficialPositioningSchema>;
export type VariantEditorialPositioning = z.infer<typeof variantEditorialPositioningSchema>;
export type VariantPositioningEntry = z.infer<typeof variantPositioningEntrySchema>;
export type VariantPositioningRecord = z.infer<typeof variantPositioningRecordSchema>;
export type VariantPositioning = z.infer<typeof variantPositioningSchema>;

export function validateVariantPositioning(input: unknown): VariantPositioning {
  const result = variantPositioningSchema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Variant positioning failed validation:\n${issues}`);
}
