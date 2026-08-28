import { describe, expect, it } from 'vitest';
import { glossary, glossaryEntryById } from './glossary';
import {
  normalizeGlossaryTerm,
  validateGlossary,
  type GlossaryEntry,
} from './glossary-schema';
import { buildGlossaryIndex, RESERVED_GLOSSARY_ANCHORS } from '../lib/glossary';

/**
 * The committed glossary, and the rules issue #44 asks it to keep.
 *
 * Two kinds of assertion live here and they are deliberately different. The
 * first reads the committed document and asserts a property every entry must
 * hold — those are about the data. The second feeds a deliberately broken
 * document to `validateGlossary` and asserts it is refused — those are about the
 * contract, and they are what stops a future entry from quietly breaking a rule
 * the first kind only checks for today's entries.
 */

/** A minimal valid entry, so each rejection test below breaks exactly one rule. */
function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sample-term',
    term: 'Sample term',
    category: 'parameters',
    aliases: ['sample'],
    short: 'A short explanation.',
    definition: 'A longer definition of the sample term.',
    sources: [{
      url: 'https://example.com/docs',
      title: 'Sample docs',
      publisher: 'Example',
      type: 'official-docs',
      quote: 'A sample term is a sample term.',
      lastCheckedDate: '2026-08-28',
    }],
    verifiedAt: '2026-08-28',
    ...overrides,
  };
}

describe('the committed naming glossary', () => {
  it('validates against the contract', () => {
    expect(() => validateGlossary(glossary)).not.toThrow();
    expect(glossary.length).toBeGreaterThan(0);
  });

  it('indexes every entry by its id', () => {
    expect(glossaryEntryById.size).toBe(glossary.length);
    for (const entry of glossary) expect(glossaryEntryById.get(entry.id)).toBe(entry);
  });
});

describe('every factual entry carries evidence', () => {
  it('gives every entry at least one primary source and a verification date', () => {
    for (const entry of glossary) {
      expect(entry.sources.length, `${entry.id} has no source`).toBeGreaterThan(0);
      expect(entry.verifiedAt, `${entry.id} has no verification date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('quotes the publisher on every source, over https, with the day it was checked', () => {
    for (const entry of glossary) {
      for (const source of entry.sources) {
        expect(source.url, `${entry.id} cites a non-https source`).toMatch(/^https:\/\//);
        expect(source.quote.trim(), `${entry.id} cites ${source.url} with no quote`).not.toBe('');
        expect(source.publisher.trim(), `${entry.id} cites ${source.url} with no publisher`)
          .not.toBe('');
        expect(source.lastCheckedDate, `${entry.id} cites ${source.url} with no check date`)
          .toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('refuses an entry with no source at all', () => {
    expect(() => validateGlossary([validEntry({ sources: [] })])).toThrow(/Glossary failed/);
  });

  it('refuses an entry with no verification date', () => {
    const { verifiedAt: _dropped, ...withoutDate } = validEntry();
    expect(() => validateGlossary([withoutDate])).toThrow(/Glossary failed/);
  });

  it('refuses a source with no verbatim quote', () => {
    const entry = validEntry();
    entry.sources[0].quote = '';
    expect(() => validateGlossary([entry])).toThrow(/Glossary failed/);
  });

  it('refuses a source served over plain http', () => {
    const entry = validEntry();
    entry.sources[0].url = 'http://example.com/docs';
    expect(() => validateGlossary([entry])).toThrow(/Glossary failed/);
  });
});

describe('an alias resolves to exactly one canonical entry', () => {
  it('builds an index in which every alias and term has one owner', () => {
    const index = buildGlossaryIndex(glossary);

    for (const entry of glossary) {
      expect(index.get(normalizeGlossaryTerm(entry.term))).toBe(entry);
      for (const alias of entry.aliases) {
        expect(index.get(normalizeGlossaryTerm(alias)), `${alias} on ${entry.id}`).toBe(entry);
      }
    }
  });

  it('records no alias twice across the whole document, ignoring case and punctuation', () => {
    const seen = new Map<string, string>();

    for (const entry of glossary) {
      for (const raw of [entry.term, ...entry.aliases]) {
        const key = normalizeGlossaryTerm(raw);
        expect(seen.has(key), `"${raw}" is claimed by both ${seen.get(key)} and ${entry.id}`)
          .toBe(false);
        seen.set(key, entry.id);
      }
    }
  });

  it('refuses two entries that claim the same alias', () => {
    expect(() => validateGlossary([
      validEntry({ id: 'first-term', term: 'First term', aliases: ['shared'] }),
      validEntry({ id: 'second-term', term: 'Second term', aliases: ['Shared'] }),
    ])).toThrow(/exactly one canonical entry/);
  });

  it('refuses an alias that shadows another entry\u2019s canonical term', () => {
    expect(() => validateGlossary([
      validEntry({ id: 'first-term', term: 'Mixture of experts', aliases: [] }),
      validEntry({ id: 'second-term', term: 'Second term', aliases: ['mixture-of-experts'] }),
    ])).toThrow(/exactly one canonical entry/);
  });

  it('refuses an alias that is only punctuation, which could never be resolved', () => {
    expect(() => validateGlossary([validEntry({ aliases: ['---'] })]))
      .toThrow(/normalizes to nothing/);
  });
});

describe('cross-references resolve', () => {
  it('points every related link at an entry that exists', () => {
    const ids = new Set(glossary.map((entry) => entry.id));

    for (const entry of glossary) {
      for (const related of entry.related) {
        expect(ids.has(related), `${entry.id} points at unknown entry ${related}`).toBe(true);
        expect(related, `${entry.id} lists itself as related`).not.toBe(entry.id);
      }
    }
  });

  it('refuses a related link to an entry that does not exist', () => {
    expect(() => validateGlossary([validEntry({ related: ['no-such-entry'] })]))
      .toThrow(/unknown related entry/);
  });

  it('refuses an entry that lists itself as related', () => {
    expect(() => validateGlossary([validEntry({ related: ['sample-term'] })]))
      .toThrow(/lists itself as related/);
  });
});

describe('anchors are shareable', () => {
  it('gives every entry a fragment-safe id', () => {
    for (const entry of glossary) {
      expect(entry.id, `${entry.id} is not fragment-safe`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(encodeURIComponent(entry.id)).toBe(entry.id);
    }
  });

  it('never collides with an element id the glossary page uses for its own furniture', () => {
    for (const entry of glossary) {
      expect(RESERVED_GLOSSARY_ANCHORS, `${entry.id} shadows a page element`)
        .not.toContain(entry.id);
    }
  });
});

describe('the technical examples the issue names', () => {
  const entryFor = (id: string): GlossaryEntry => {
    const entry = glossaryEntryById.get(id);
    expect(entry, `expected a "${id}" entry`).toBeDefined();
    return entry!;
  };

  it('distinguishes total from active parameters, in both directions', () => {
    expect(entryFor('total-parameters').distinctions.map(({ from }) => from))
      .toContain('Active parameters');
    expect(entryFor('active-parameters').distinctions.map(({ from }) => from))
      .toContain('Total parameters');
  });

  it('shows a real notation in which the two parameter counts differ', () => {
    const notations = entryFor('total-parameters').examples.map(({ notation }) => notation);

    expect(notations.some((notation) => /activated/i.test(notation) && /total/i.test(notation)))
      .toBe(true);
  });

  it('distinguishes open weight from open source, in both directions', () => {
    expect(entryFor('open-weight').distinctions.map(({ from }) => from))
      .toContain('Open source AI');
    expect(entryFor('open-source-ai').distinctions.map(({ from }) => from))
      .toContain('Open weight');
  });

  it('backs the openness pair with the Open Source Initiative rather than a vendor alone', () => {
    const publishers = entryFor('open-source-ai').sources.map(({ publisher }) => publisher);

    expect(publishers).toContain('Open Source Initiative');
  });

  it('covers the naming features the issue lists, each as its own entry', () => {
    for (const id of [
      'model-alias',
      'model-api-id',
      'dated-snapshot',
      'expert-count-suffix',
      'mixture-of-experts',
      'quantization-tag',
      'context-window',
    ]) {
      expect(glossaryEntryById.has(id), `expected a "${id}" entry`).toBe(true);
    }
  });
});

describe('editorial discipline', () => {
  it('keeps every inline explanation short enough to sit beside a term', () => {
    for (const entry of glossary) {
      expect(entry.short.length, `${entry.id} has a ${entry.short.length}-character short form`)
        .toBeLessThanOrEqual(240);
    }
  });

  it('refuses an inline explanation that has grown into a paragraph', () => {
    expect(() => validateGlossary([validEntry({ short: 'x'.repeat(241) })]))
      .toThrow(/Glossary failed/);
  });

  it('records disagreement explicitly wherever it records it at all', () => {
    for (const entry of glossary) {
      for (const conflict of entry.conflicts) {
        expect(conflict.urls.length, `${entry.id} records a conflict with no source`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('states somewhere that usage is contested, rather than smoothing every term over', () => {
    expect(glossary.some((entry) => entry.conflicts.length > 0)).toBe(true);
  });
});
