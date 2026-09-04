import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every URL a data document cites as a *source* must be registered in
 * `sources.json`, because `sources.json` is the sole subject of the
 * `Source link health` sweep. A source cited anywhere else is verified by no
 * automated run, which is the gap this guard exists to close.
 *
 * ## Why this walks the directory, not `raw.ts`
 *
 * `raw.ts` imports 15 of the 18 JSON documents. `glossary.json`,
 * `refresh-runs.json` and `variant-positioning.json` sit outside its module
 * graph deliberately, to keep the ADR-0003 auto-merge qualifying class narrow.
 * A guard that followed `raw.ts`'s imports would inherit that exclusion and be
 * blind to exactly the documents that motivate the guard — including
 * `variant-positioning.json`, whose citations happen to be covered only by
 * coincidence today. So the enumeration reads the *directory*, and asserts its
 * own reach (see `covers every JSON document…` and the empty-directory test)
 * so a walk that quietly matches nothing goes red rather than green.
 *
 * ## What counts as a "source citation"
 *
 * A `url` (or a member of a `urls` array) that appears inside a `sources`
 * array anywhere in a document. That is the inline-citation shape used by the
 * two documents that carry raw source URLs — `variant-positioning.json` and
 * `glossary.json`. Every other document cites by `sourceIds` referencing
 * `sources.json` by id, so they carry no inline citation URLs and are covered
 * by construction. `sources.json`'s own records hold their `url` at the top
 * level of each record — not inside a key named `sources` — so the registry is
 * never made a subject of itself, and prose URLs (in `quote`, `note`,
 * `references`, license fields, homepages) are not citations and are left out.
 */

const dataDir = fileURLToPath(new URL('.', import.meta.url));

/** The full data directory holds this many JSON documents; fewer means the walk went blind. */
const MIN_JSON_DOCUMENTS = 18;

/**
 * Source URLs cited in committed data that `sources.json` carries no record of.
 *
 * Empty, and that is the state to keep it in: every URL cited as a source in
 * this directory is registered. An entry here is a standing exception to the
 * rule that every important fact carries a primary source and a verification
 * date, so it must name a URL some document cites while `sources.json` holds no
 * record of it — and registering that URL there is what removes the entry
 * again. Sorted so the comparison below is order-independent.
 */
const KNOWN_UNREGISTERED_CITATIONS: string[] = [].sort();

/** Collect `url` / `urls[]` strings that live inside a `sources` array. */
function collectCitationUrls(node: unknown, insideSources: boolean, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCitationUrls(item, insideSources, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'sources' && Array.isArray(value)) {
        collectCitationUrls(value, true, out);
      } else if (insideSources && key === 'url' && typeof value === 'string') {
        out.add(value);
      } else if (insideSources && key === 'urls' && Array.isArray(value)) {
        for (const url of value) if (typeof url === 'string') out.add(url);
      } else {
        collectCitationUrls(value, insideSources, out);
      }
    }
  }
}

interface Enumeration {
  jsonFiles: string[];
  registeredUrls: Set<string>;
  citationsByFile: Map<string, Set<string>>;
  citationUrls: Set<string>;
}

/**
 * Read every JSON document in `dir`, the registered set from `sources.json`,
 * and every inline source-citation URL. Pure over the directory it is given, so
 * the empty-directory test can point it somewhere with nothing to find.
 */
function enumerate(dir: string): Enumeration {
  const jsonFiles = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  let registeredUrls = new Set<string>();
  const citationsByFile = new Map<string, Set<string>>();
  const citationUrls = new Set<string>();

  for (const file of jsonFiles) {
    const doc: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (file === 'sources.json') {
      registeredUrls = new Set(
        (doc as Array<{ url?: string }>).map((record) => record.url).filter((url): url is string => typeof url === 'string'),
      );
    }
    const urls = new Set<string>();
    collectCitationUrls(doc, false, urls);
    if (urls.size > 0) {
      citationsByFile.set(file, urls);
      for (const url of urls) citationUrls.add(url);
    }
  }

  return { jsonFiles, registeredUrls, citationsByFile, citationUrls };
}

/**
 * The anti-blindness guard, factored out so both the live run (which must pass)
 * and the empty-directory run (which must throw) exercise the same check.
 */
function assertSubjectNonEmpty(result: Enumeration): void {
  if (result.jsonFiles.length < MIN_JSON_DOCUMENTS) {
    throw new Error(
      `source-registration guard walked ${result.jsonFiles.length} JSON document(s); ` +
        `expected at least ${MIN_JSON_DOCUMENTS}. The walk found nothing to check.`,
    );
  }
  if (result.registeredUrls.size === 0) {
    throw new Error('source-registration guard read no registered URLs from sources.json.');
  }
  if (result.citationUrls.size === 0) {
    throw new Error('source-registration guard found no inline source citations to verify.');
  }
}

describe('every source a data document cites is registered in sources.json', () => {
  const result = enumerate(dataDir);

  it('covers every JSON document in the data directory, not just raw.ts imports', () => {
    // The subject is the directory. Assert it is non-empty and of the expected
    // size so a walk that matches nothing fails loudly rather than passing.
    expect(() => assertSubjectNonEmpty(result)).not.toThrow();
    expect(result.jsonFiles.length).toBeGreaterThanOrEqual(MIN_JSON_DOCUMENTS);
    expect(result.jsonFiles).toContain('sources.json');
    // The two documents that carry inline citations must be reached. If the
    // walk ever stops seeing them, the guard has gone blind to precisely the
    // documents that motivate it and would pass while checking nothing.
    expect(result.citationsByFile.has('variant-positioning.json')).toBe(true);
    expect(result.citationsByFile.has('glossary.json')).toBe(true);
    expect(result.registeredUrls.size).toBeGreaterThan(0);
    expect(result.citationUrls.size).toBeGreaterThan(0);
  });

  it('registers every cited source URL', () => {
    const unregistered = [...result.citationUrls]
      .filter((url) => !result.registeredUrls.has(url))
      .sort();

    // Equality, not subset: a newly unregistered citation reddens this, and an
    // exception that has since been registered forces the baseline to be shrunk
    // deliberately rather than left to drift.
    expect(
      unregistered,
      'a data document cites a source URL that sources.json does not register. ' +
        'Fix this where the citation is: add a record to web/src/data/sources.json ' +
        'for each URL listed below, carrying a primary-source classification and ' +
        'the date you read the page, or drop the citation from the document. ' +
        'Adding the URL to KNOWN_UNREGISTERED_CITATIONS is not the fix — that ' +
        'list is empty because every cited source is registered, and it exists ' +
        'to stop the set of exceptions growing quietly',
    ).toEqual(KNOWN_UNREGISTERED_CITATIONS);
  });
});

describe('the guard reddens when its subject is empty (mutation proof)', () => {
  it('throws when pointed at a directory with no documents', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'source-registration-empty-'));
    const result = enumerate(emptyDir);

    expect(result.jsonFiles).toEqual([]);
    expect(() => assertSubjectNonEmpty(result)).toThrow(/found nothing to check/);
  });
});
