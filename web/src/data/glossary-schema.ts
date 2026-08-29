import { z } from 'zod';
import { isoDate } from './schema';

/**
 * The contract for the naming glossary — the terms that make a model *name*
 * hard to decode: aliases, API ids, suffixes, parameter notation, mixture-of-
 * experts active parameters, quantization tags, and context units.
 *
 * Deliberately **not** part of `raw.ts`. These are facts about terminology, not
 * facts about models, and `gate-scope.mjs` bounds an auto-merging refresh to
 * exactly the documents `raw.ts` composes. Adding this file there would widen
 * the ADR 0003 qualifying class, which is an ADR-level decision rather than a
 * data change. `refresh-log-schema.ts` is kept out for the same reason and is
 * the precedent this file follows.
 *
 * Two things about the shape are worth stating plainly, because they are the
 * acceptance criteria of issue #44 expressed as a schema rather than as prose.
 *
 * **Every entry carries evidence.** `sources` is `min(1)` and `verifiedAt` is
 * required, so there is no way to publish a definition this repository cannot
 * point at. Each source also carries a `quote`: the words the publisher actually
 * used, so a reader can see the distance between the source and the editorial
 * gloss instead of taking the gloss on trust. The issue's own non-goal — "define
 * terms without evidence" — is therefore unreachable rather than discouraged.
 *
 * **An alias resolves to exactly one canonical entry.** That is enforced across
 * the whole document in `glossarySchema` below, not per entry, because the
 * failure it prevents is a collision *between* entries. Alias comparison runs on
 * `normalizeGlossaryTerm`, so `MoE`, `moe` and `M.o.E.` are one term and cannot
 * be split across two records by punctuation alone.
 *
 * Sources are recorded inline here rather than as ids into `sources.json`. The
 * two registries answer different questions — `sources.json` is the evidence
 * behind model facts, and its publisher identity feeds the independence bar for
 * synthesis — and a glossary that cited into it would tie terminology edits to a
 * document an auto-merging refresh may rewrite. The cost is real and recorded:
 * `.github/workflows/source-link-health.yml` only re-checks `sources.json`, so
 * the URLs below get no automated link-health pass. `lastCheckedDate` is what a
 * reader has instead, and it is per source rather than per entry.
 */

const nonEmpty = z.string().min(1);

/** Anchors are the shareable part of the glossary, so an id is a URL fragment. */
const entryId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * Which part of a name the term decodes. A category is a filing aid for readers
 * scanning a long page; it is never a ranking, and nothing is scored.
 */
export const glossaryCategory = z.enum([
  'parameters',
  'architecture',
  'openness',
  'context',
  'precision',
  'identifiers',
  'versioning',
  'tuning',
]);

/**
 * A primary source for one entry, with the publisher's own words.
 *
 * `quote` is required and verbatim. A URL alone proves a page exists; the quote
 * is what shows the page says the thing the entry claims it says.
 */
export const glossarySourceSchema = z.object({
  url: z.url().refine((value) => value.startsWith('https://'), 'must be https'),
  title: nonEmpty,
  /** The voice behind the page, as a display name. See the note above on why this is not a `publisherId`. */
  publisher: nonEmpty,
  type: z.enum(['official-docs', 'model-card', 'official-announcement', 'standards-body']),
  /** Verbatim from the page. Never paraphrased, and never reworded to fit the entry. */
  quote: nonEmpty,
  publishedDate: isoDate.optional(),
  lastCheckedDate: isoDate,
});

/**
 * A term this one is routinely confused with, and why they are not the same.
 *
 * `from` is free text on purpose: the most useful contrasts point *outside* the
 * glossary ("open source", "a word"), and forcing every contrast to be an entry
 * would either drop the contrast or invent an entry to hold it.
 */
export const glossaryDistinctionSchema = z.object({
  from: nonEmpty,
  note: nonEmpty,
});

/** A real notation and how to read it. `notation` is copied from a source, not invented. */
export const glossaryExampleSchema = z.object({
  notation: nonEmpty,
  reading: nonEmpty,
});

/**
 * Where sources disagree, or where usage is not settled. Recorded rather than
 * resolved: an entry that smoothed a live disagreement into one clean sentence
 * would be stating something no source states.
 */
export const glossaryConflictSchema = z.object({
  note: nonEmpty,
  urls: z.array(z.url()).min(1),
});

export const glossaryEntrySchema = z.object({
  id: entryId,
  term: nonEmpty,
  category: glossaryCategory,
  /** Spellings, notations, and abbreviations that resolve to this entry. */
  aliases: z.array(nonEmpty).default([]),
  /**
   * The inline explanation, capped so it stays a sentence a reader can take in
   * beside the term. The cap is the design note "compact editorial definitions"
   * made enforceable; the long form lives in `definition`.
   */
  short: nonEmpty.max(240),
  definition: nonEmpty,
  distinctions: z.array(glossaryDistinctionSchema).default([]),
  examples: z.array(glossaryExampleSchema).default([]),
  related: z.array(entryId).default([]),
  conflicts: z.array(glossaryConflictSchema).default([]),
  sources: z.array(glossarySourceSchema).min(1),
  verifiedAt: isoDate,
});

/**
 * Lower-cases and folds punctuation so that one term written several ways is
 * still one term.
 *
 * Punctuation is not all alike here, so it is not all treated alike. Hyphens,
 * underscores, slashes and whitespace are *word separators* in this domain —
 * `Q4_K_M` is three parts, `open-weight` is two — so they fold to a space and
 * `open-weight` meets `open weight`. Everything else is dropped outright, which
 * is what makes `M.o.E.` meet `MoE`: an abbreviation's dots are not separating
 * words, and folding them to spaces would split one initialism into three.
 *
 * So: `-Instruct`, `Instruct` and `instruct` collapse together, as do `MoE` and
 * `M.o.E.`, and `Q4_K_M` and `q4 k m`. A consequence worth naming rather than
 * discovering: a decimal loses its point, so `2.5` normalizes to `25` and not to
 * `2 5`. No alias in this dataset is a bare version number, and matching a
 * version string is the search's job, not the alias index's.
 *
 * Exported from the schema module because the uniqueness rule below and the
 * runtime lookup in `lib/glossary.ts` must agree on what "the same term" means.
 * Two normalizers would let the data pass validation and still fail to resolve.
 */
export function normalizeGlossaryTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\-_/\\]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/ +/g, ' ')
    .trim();
}

export const glossarySchema = z
  .array(glossaryEntrySchema)
  .min(1)
  .superRefine((entries, context) => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) {
        context.addIssue({ code: 'custom', message: `entry ${entry.id} is recorded twice` });
      }
      ids.add(entry.id);
    }

    // One normalized term -> one entry, over canonical terms and aliases alike.
    // Aliases are checked in the same namespace as canonical terms because an
    // alias that shadows another entry's term is exactly the ambiguity the
    // acceptance criterion forbids.
    const owner = new Map<string, { id: string; label: string }>();
    const claim = (raw: string, id: string, label: string) => {
      const key = normalizeGlossaryTerm(raw);
      if (key === '') {
        context.addIssue({
          code: 'custom',
          message: `${label} "${raw}" on ${id} normalizes to nothing, so it can never be resolved`,
        });
        return;
      }

      const held = owner.get(key);
      if (held) {
        context.addIssue({
          code: 'custom',
          message:
            `"${raw}" (${label} on ${id}) already resolves to ${held.id} as its ${held.label}; `
            + 'an alias must resolve to exactly one canonical entry',
        });
        return;
      }
      owner.set(key, { id, label });
    };

    for (const entry of entries) claim(entry.term, entry.id, 'canonical term');
    for (const entry of entries) {
      for (const alias of entry.aliases) claim(alias, entry.id, 'alias');
    }

    for (const entry of entries) {
      for (const related of entry.related) {
        if (related === entry.id) {
          context.addIssue({ code: 'custom', message: `entry ${entry.id} lists itself as related` });
        } else if (!ids.has(related)) {
          context.addIssue({
            code: 'custom',
            message: `entry ${entry.id} points at unknown related entry ${related}`,
          });
        }
      }

      const seenRelated = new Set<string>();
      for (const related of entry.related) {
        if (seenRelated.has(related)) {
          context.addIssue({
            code: 'custom',
            message: `entry ${entry.id} lists ${related} as related twice`,
          });
        }
        seenRelated.add(related);
      }
    }
  });

export type GlossaryCategory = z.infer<typeof glossaryCategory>;
export type GlossarySource = z.infer<typeof glossarySourceSchema>;
export type GlossaryDistinction = z.infer<typeof glossaryDistinctionSchema>;
export type GlossaryExample = z.infer<typeof glossaryExampleSchema>;
export type GlossaryConflict = z.infer<typeof glossaryConflictSchema>;
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;
export type Glossary = z.infer<typeof glossarySchema>;

export function validateGlossary(input: unknown): Glossary {
  const result = glossarySchema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Glossary failed validation:\n${issues}`);
}
