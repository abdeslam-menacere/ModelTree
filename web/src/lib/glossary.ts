import { normalizeGlossaryTerm, type GlossaryEntry } from '../data/glossary-schema';

/**
 * Search, alias resolution, and anchor handling for the naming glossary.
 *
 * Three properties here are acceptance criteria of issue #44 rather than
 * conveniences, so each is a named function with a test rather than a few lines
 * inlined into the component.
 *
 * 1. **An alias resolves to exactly one canonical entry.** `buildGlossaryIndex`
 *    is the runtime half of the rule `glossarySchema` enforces on the document,
 *    and both call the same `normalizeGlossaryTerm`. It throws on a collision
 *    instead of picking a winner: a silent last-one-wins would make the site
 *    disagree with the validator about what a term means.
 * 2. **Search is shareable.** The query lives in a URL parameter, written
 *    without disturbing any other parameter or the fragment.
 * 3. **Anchors are shareable and never dead.** `pinnedEntryId` keeps the entry a
 *    fragment names visible even when the active search would filter it out, so
 *    a link carrying both a query and a fragment cannot land on nothing.
 */

export const GLOSSARY_SEARCH_PARAM = 'q';

const RESOLVE_BASE = 'https://modeltree.local';

/**
 * Element ids the glossary page uses for its own furniture. An entry id that
 * collided with one of these would make `#<id>` ambiguous in the document and
 * scroll a shared link to the wrong element, so `glossary.test.ts` asserts the
 * data never does. Entry anchors are the bare entry id — the shortest thing a
 * reader can share — which is what makes the check necessary.
 */
export const RESERVED_GLOSSARY_ANCHORS: readonly string[] = [
  'main-content',
  'glossary-search',
  'glossary-results',
  'glossary-title',
  'glossary-count',
];

export interface GlossaryMatch {
  entry: GlossaryEntry;
  /**
   * The alias the query matched, when it matched through one. The UI states it
   * so a reader who searched "MoE" can see why "Mixture of experts" answered.
   */
  matchedAlias?: string;
  /** True when this entry is present because the URL fragment names it, not because it matched. */
  pinned: boolean;
}

export type GlossaryIndex = ReadonlyMap<string, GlossaryEntry>;

/**
 * Every canonical term and alias, normalized, mapped to its one entry.
 *
 * Throws on a collision rather than resolving it. The document schema already
 * refuses to validate in that case, so reaching this throw means the two rules
 * have drifted apart, and failing loudly at build time is the point.
 */
export function buildGlossaryIndex(entries: readonly GlossaryEntry[]): GlossaryIndex {
  const index = new Map<string, GlossaryEntry>();

  const add = (raw: string, entry: GlossaryEntry) => {
    const key = normalizeGlossaryTerm(raw);
    const held = index.get(key);
    if (held && held.id !== entry.id) {
      throw new Error(
        `Glossary term "${raw}" resolves to both ${held.id} and ${entry.id}; `
        + 'an alias must resolve to exactly one canonical entry',
      );
    }
    index.set(key, entry);
  };

  for (const entry of entries) add(entry.term, entry);
  for (const entry of entries) {
    for (const alias of entry.aliases) add(alias, entry);
  }

  return index;
}

/** The canonical entry a term or alias names, or `undefined` when nothing does. */
export function resolveGlossaryTerm(
  index: GlossaryIndex,
  term: string,
): GlossaryEntry | undefined {
  return index.get(normalizeGlossaryTerm(term));
}

/**
 * Which alias of an entry a query matched, if any. Exact normalized match first,
 * then a prefix or containment match, so "moe" reports the `moe` alias rather
 * than the first alias that happens to contain the letters.
 */
function matchingAlias(entry: GlossaryEntry, needle: string): string | undefined {
  const exact = entry.aliases.find((alias) => normalizeGlossaryTerm(alias) === needle);
  if (exact) return exact;

  return entry.aliases.find((alias) => normalizeGlossaryTerm(alias).includes(needle));
}

/**
 * Entries matching a free-text query, in document order.
 *
 * Matching runs over the normalized canonical term, the aliases, the short
 * explanation, the definition, the recorded distinctions, and the example
 * notations — everything a reader can see on the page, so a query that matches
 * something visible never returns nothing.
 *
 * `pinnedId` is the entry a URL fragment names. It is always included and always
 * marked, even when it does not match, which is what keeps a shared link
 * carrying both `?q=` and `#anchor` from landing on an empty page.
 */
export function searchGlossary(
  entries: readonly GlossaryEntry[],
  query: string,
  pinnedId?: string | null,
): GlossaryMatch[] {
  const needle = normalizeGlossaryTerm(query);

  return entries.flatMap((entry) => {
    const pinned = pinnedId === entry.id;

    if (needle === '') return [{ entry, pinned }];

    const haystack = [
      entry.term,
      ...entry.aliases,
      entry.short,
      entry.definition,
      ...entry.distinctions.flatMap((distinction) => [distinction.from, distinction.note]),
      ...entry.examples.flatMap((example) => [example.notation, example.reading]),
    ]
      .map(normalizeGlossaryTerm)
      .join(' \u0000 ');

    if (!haystack.includes(needle)) {
      return pinned ? [{ entry, pinned }] : [];
    }

    return [{ entry, pinned, matchedAlias: matchingAlias(entry, needle) }];
  });
}

/** The search query a URL carries. An absent or blank parameter is no query at all. */
export function parseGlossaryQuery(search: string): string {
  return new URLSearchParams(search).get(GLOSSARY_SEARCH_PARAM)?.trim() ?? '';
}

/**
 * Writes a query back onto a URL, leaving every other parameter and the fragment
 * untouched. An empty query clears the parameter, so an unfiltered glossary has
 * a clean, shareable address rather than a trailing `?q=`.
 */
export function createGlossarySearchUrl(input: string | URL, query: string): string {
  const url = input instanceof URL ? new URL(input) : new URL(input, RESOLVE_BASE);
  const trimmed = query.trim();

  url.searchParams.delete(GLOSSARY_SEARCH_PARAM);
  if (trimmed !== '') url.searchParams.set(GLOSSARY_SEARCH_PARAM, trimmed);

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The entry id a URL fragment names, or `null` when it names nothing this
 * glossary holds. An unknown fragment is not an error: the page simply has
 * nothing to pin.
 */
export function parseGlossaryAnchor(hash: string, entries: readonly GlossaryEntry[]): string | null {
  const candidate = hash.replace(/^#/, '');
  if (candidate === '') return null;

  return entries.some((entry) => entry.id === candidate) ? candidate : null;
}

/** The shareable address of one entry, base-path aware so it survives a project-page deploy. */
export function glossaryEntryHref(basePath: string, id: string): string {
  return `${basePath}glossary/#${id}`;
}

/** How the count is stated in words, so nothing rests on emphasis or colour alone. */
export function glossaryCountText(shown: number, total: number, query: string): string {
  if (query.trim() === '') {
    return total === 1 ? 'Showing the 1 recorded term.' : `Showing all ${total} recorded terms.`;
  }
  if (shown === 0) return `No recorded term matches “${query.trim()}”.`;

  return shown === 1
    ? `Showing 1 of ${total} terms matching “${query.trim()}”.`
    : `Showing ${shown} of ${total} terms matching “${query.trim()}”.`;
}
