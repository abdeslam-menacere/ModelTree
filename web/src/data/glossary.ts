import glossaryEntries from './glossary.json';
import { validateGlossary } from './glossary-schema';

/**
 * The naming glossary, validated at build time like every other document here.
 *
 * Kept out of `raw.ts` on purpose: these are facts about terminology, not about
 * models, and `gate-scope.mjs` bounds an auto-merging refresh to exactly the
 * documents `raw.ts` composes. `refresh-log.ts` is kept out for the same reason.
 */
export const glossary = validateGlossary(glossaryEntries);

export const glossaryEntryById = new Map(glossary.map((entry) => [entry.id, entry]));
