import { describe, expect, it } from 'vitest';
import { normalizeGlossaryTerm, type GlossaryEntry } from '../data/glossary-schema';
import {
  buildGlossaryIndex,
  createGlossarySearchUrl,
  glossaryCountText,
  glossaryEntryHref,
  GLOSSARY_SEARCH_PARAM,
  parseGlossaryAnchor,
  parseGlossaryQuery,
  resolveGlossaryTerm,
  searchGlossary,
} from './glossary';

/**
 * The glossary's search, alias resolution, and anchor handling, exercised
 * against a fixture rather than the committed dataset. A data refresh must not
 * be able to redden this file, and an assertion on real entries would do exactly
 * that the first time a term is reworded.
 */

function entry(overrides: Partial<GlossaryEntry> & Pick<GlossaryEntry, 'id' | 'term'>): GlossaryEntry {
  return {
    category: 'parameters',
    aliases: [],
    short: 'A short explanation.',
    definition: 'A longer definition.',
    distinctions: [],
    examples: [],
    related: [],
    conflicts: [],
    sources: [{
      url: 'https://example.com/docs',
      title: 'Docs',
      publisher: 'Example',
      type: 'official-docs',
      quote: 'Quoted verbatim.',
      lastCheckedDate: '2026-08-28',
    }],
    verifiedAt: '2026-08-28',
    ...overrides,
  };
}

const fixture: GlossaryEntry[] = [
  entry({
    id: 'active-params',
    term: 'Active parameters',
    aliases: ['activated parameters', 'active params'],
    short: 'The weights used per token.',
    definition: 'Only some experts run on any one token.',
    examples: [{ notation: '17B (Activated)', reading: 'Seventeen billion per token.' }],
  }),
  entry({
    id: 'moe',
    term: 'Mixture of experts',
    aliases: ['MoE', 'sparse mixture of experts'],
    short: 'Routes each token to a few experts.',
    definition: 'A router selects experts per token.',
    distinctions: [{ from: 'Dense models', note: 'A dense model runs every weight.' }],
  }),
  entry({
    id: 'quant-tag',
    term: 'Quantization tag',
    aliases: ['Q4_K_M'],
    short: 'Names the numeric precision of stored weights.',
    definition: 'Applied after training by whoever converted the file.',
  }),
];

describe('normalizing a term', () => {
  it('collapses case and punctuation so one term stays one term', () => {
    expect(normalizeGlossaryTerm('MoE')).toBe('moe');
    expect(normalizeGlossaryTerm('M.o.E.')).toBe('moe');
    expect(normalizeGlossaryTerm('-Instruct')).toBe('instruct');
    expect(normalizeGlossaryTerm('Q4_K_M')).toBe('q4 k m');
    expect(normalizeGlossaryTerm('  Active   Parameters  ')).toBe('active parameters');
  });
});

describe('resolving an alias to its canonical entry', () => {
  const index = buildGlossaryIndex(fixture);

  it('resolves the canonical term', () => {
    expect(resolveGlossaryTerm(index, 'Mixture of experts')?.id).toBe('moe');
  });

  it('resolves every alias to the same single entry, however it is written', () => {
    for (const written of ['MoE', 'moe', 'M.O.E.', 'sparse mixture of experts']) {
      expect(resolveGlossaryTerm(index, written)?.id, written).toBe('moe');
    }
  });

  it('resolves a punctuated alias such as a quantization tag', () => {
    expect(resolveGlossaryTerm(index, 'q4-k-m')?.id).toBe('quant-tag');
  });

  it('returns nothing for a term the glossary does not record', () => {
    expect(resolveGlossaryTerm(index, 'flux capacitor')).toBeUndefined();
  });

  it('refuses to build an index in which one alias would own two entries', () => {
    expect(() => buildGlossaryIndex([
      entry({ id: 'first', term: 'First', aliases: ['shared'] }),
      entry({ id: 'second', term: 'Second', aliases: ['SHARED'] }),
    ])).toThrow(/exactly one canonical entry/);
  });
});

describe('searching the glossary', () => {
  it('returns every entry for an empty query', () => {
    expect(searchGlossary(fixture, '').map(({ entry: found }) => found.id))
      .toEqual(['active-params', 'moe', 'quant-tag']);
  });

  it('finds an entry by an alias and reports which alias matched', () => {
    const [match, ...rest] = searchGlossary(fixture, 'MoE');

    expect(rest).toEqual([]);
    expect(match.entry.id).toBe('moe');
    expect(match.matchedAlias).toBe('MoE');
  });

  it('finds an entry by words in its definition, not only by its term', () => {
    expect(searchGlossary(fixture, 'router').map(({ entry: found }) => found.id)).toEqual(['moe']);
  });

  it('finds an entry by an example notation a reader can see on the page', () => {
    expect(searchGlossary(fixture, '17B').map(({ entry: found }) => found.id))
      .toEqual(['active-params']);
  });

  it('finds an entry by a recorded distinction', () => {
    expect(searchGlossary(fixture, 'dense').map(({ entry: found }) => found.id)).toEqual(['moe']);
  });

  it('ignores punctuation and case in the query', () => {
    expect(searchGlossary(fixture, 'q4-k-m').map(({ entry: found }) => found.id))
      .toEqual(['quant-tag']);
  });

  it('returns nothing when nothing matches', () => {
    expect(searchGlossary(fixture, 'flux capacitor')).toEqual([]);
  });

  it('does not match across the boundary between two separate fields', () => {
    // "token experts" spans the end of one field and the start of another. A
    // naive join on a space would match it and claim a phrase no page contains.
    expect(searchGlossary(fixture, 'per token routes')).toEqual([]);
  });
});

describe('an anchored entry is never filtered away', () => {
  it('keeps the pinned entry even when the query excludes it, and marks it', () => {
    const matches = searchGlossary(fixture, 'router', 'quant-tag');

    expect(matches.map(({ entry: found }) => found.id)).toEqual(['moe', 'quant-tag']);
    expect(matches.find(({ entry: found }) => found.id === 'quant-tag')?.pinned).toBe(true);
    expect(matches.find(({ entry: found }) => found.id === 'moe')?.pinned).toBe(false);
  });

  it('marks the pinned entry when it also matches the query', () => {
    const matches = searchGlossary(fixture, 'router', 'moe');

    expect(matches.map(({ entry: found }) => found.id)).toEqual(['moe']);
    expect(matches[0].pinned).toBe(true);
  });
});

describe('reading and writing the shareable search URL', () => {
  it('reads the query out of a URL, trimming it', () => {
    expect(parseGlossaryQuery(`?${GLOSSARY_SEARCH_PARAM}=%20MoE%20`)).toBe('MoE');
  });

  it('reads no query at all from a clean URL', () => {
    expect(parseGlossaryQuery('')).toBe('');
    expect(parseGlossaryQuery('?other=1')).toBe('');
  });

  it('writes the query without disturbing another parameter or the fragment', () => {
    const written = createGlossarySearchUrl('/ModelTree/glossary/?theme=dark#moe', 'MoE');
    const url = new URL(written, 'https://modeltree.local');

    expect(url.pathname).toBe('/ModelTree/glossary/');
    expect(url.searchParams.get('theme')).toBe('dark');
    expect(url.searchParams.get(GLOSSARY_SEARCH_PARAM)).toBe('MoE');
    expect(url.hash).toBe('#moe');
  });

  it('clears the parameter for an empty query rather than leaving a trailing q=', () => {
    const written = createGlossarySearchUrl(
      `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=MoE`,
      '   ',
    );

    expect(written).toBe('/ModelTree/glossary/');
  });

  it('round-trips a query through the URL', () => {
    const written = createGlossarySearchUrl('/ModelTree/glossary/', 'open weight');

    expect(parseGlossaryQuery(new URL(written, 'https://modeltree.local').search))
      .toBe('open weight');
  });
});

describe('reading an entry anchor', () => {
  it('resolves a fragment that names a recorded entry', () => {
    expect(parseGlossaryAnchor('#moe', fixture)).toBe('moe');
    expect(parseGlossaryAnchor('moe', fixture)).toBe('moe');
  });

  it('resolves nothing for an empty or unknown fragment', () => {
    expect(parseGlossaryAnchor('', fixture)).toBeNull();
    expect(parseGlossaryAnchor('#', fixture)).toBeNull();
    expect(parseGlossaryAnchor('#no-such-entry', fixture)).toBeNull();
  });
});

describe('building an entry address', () => {
  it('prefixes the base path so a shared link survives a project-page deploy', () => {
    expect(glossaryEntryHref('/ModelTree/', 'moe')).toBe('/ModelTree/glossary/#moe');
    expect(glossaryEntryHref('/', 'moe')).toBe('/glossary/#moe');
  });
});

describe('stating the count in words', () => {
  it('states the whole set when nothing is searched', () => {
    expect(glossaryCountText(3, 3, '')).toBe('Showing all 3 recorded terms.');
  });

  it('states the matched fraction when something is', () => {
    expect(glossaryCountText(1, 3, 'MoE')).toBe('Showing 1 of 3 terms matching \u201cMoE\u201d.');
  });

  it('says plainly when a query matched nothing, naming the query', () => {
    expect(glossaryCountText(0, 3, 'flux')).toBe('No recorded term matches \u201cflux\u201d.');
  });
});
