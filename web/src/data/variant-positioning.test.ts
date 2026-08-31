import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { variantPositioning, variantPositioningByFamilyId } from './variant-positioning';
import {
  POSITIONING_CLAIM_PATTERNS,
  findPositioningClaim,
  findPositioningWordingProblem,
  validateVariantPositioning,
} from './variant-positioning-schema';

/**
 * The committed positioning document, and the rules issue #38 asks it to keep.
 *
 * Two kinds of assertion, deliberately different. Some read the committed data
 * and assert a property today's records hold. Others feed a broken record to
 * `validateVariantPositioning` and assert it is refused — those are about the
 * contract, and they are what stops a future record from breaking a rule that
 * the first kind would only notice once someone had already written it down.
 */

/** A minimal valid record, so each rejection test below breaks exactly one rule. */
function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'positioning-sample-family',
    familyId: 'sample-family',
    note: 'What the names in this sample family settle, and what they leave open to the reader.',
    variants: [validEntry()],
    verifiedAt: '2026-08-30',
    ...overrides,
  };
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    variant: 'Sample',
    official: {
      effectiveAsOf: '2026-08-30',
      sources: [{
        url: 'https://example.com/docs',
        title: 'Sample docs',
        publisher: 'Example',
        type: 'official-docs',
        quote: 'Built for sample workloads',
        lastCheckedDate: '2026-08-30',
      }],
    },
    editorial: {
      summary: 'The creator describes this name by the kind of work it is meant for, and not by a level.',
      verifiedAt: '2026-08-30',
    },
    ...overrides,
  };
}

describe('the committed positioning document', () => {
  it('records at least one family', () => {
    expect(variantPositioning.length).toBeGreaterThan(0);
  });

  it('indexes every record by its family', () => {
    expect(variantPositioningByFamilyId.size).toBe(variantPositioning.length);
    for (const record of variantPositioning) {
      expect(variantPositioningByFamilyId.get(record.familyId)).toBe(record);
    }
  });

  it('carries a primary source with a verbatim quote and a check date on every variant', () => {
    for (const record of variantPositioning) {
      for (const entry of record.variants) {
        expect(entry.official.sources.length).toBeGreaterThan(0);
        for (const source of entry.official.sources) {
          expect(source.quote.trim().length).toBeGreaterThan(0);
          expect(source.url.startsWith('https://')).toBe(true);
          expect(source.lastCheckedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        expect(entry.official.effectiveAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(entry.editorial.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('keeps every ModelTree-authored string clear of ranking, recommendation and price language', () => {
    for (const record of variantPositioning) {
      expect(findPositioningWordingProblem(record.note)).toBeUndefined();
      for (const entry of record.variants) {
        expect(findPositioningWordingProblem(entry.editorial.summary)).toBeUndefined();
      }
    }
  });

  /**
   * The complement of the test above, and the reason the split between
   * `official` and `editorial` is structural rather than stylistic: a creator's
   * own superlative survives intact, because it is reported as theirs.
   */
  it('leaves creator quotes unedited, including the superlatives ModelTree may not write', () => {
    const quotes = variantPositioning.flatMap((record) => (
      record.variants.flatMap((entry) => entry.official.sources.map((source) => source.quote))
    ));

    expect(quotes.some((quote) => findPositioningWordingProblem(quote) !== undefined)).toBe(true);
  });
});

/**
 * `gate-dataset.mjs` refuses ranking vocabulary as a *key name* across the
 * documents it walks. This document is not one of them, so the gate would not
 * read it — which is exactly why the convention is asserted here instead.
 *
 * The word list is parsed out of the gate rather than restated, so that adding a
 * word there cannot leave this test quietly checking an older rule.
 */
describe('field naming', () => {
  function rankingWords(): string[] {
    const gate = readFileSync(
      fileURLToPath(new URL('../../../.github/skills/modeltree-gates/scripts/gate-dataset.mjs', import.meta.url)),
      'utf8',
    );
    const block = /const RANKING_WORDS\s*=\s*(\[[\s\S]*?\]);/.exec(gate);
    if (!block) throw new Error('could not find RANKING_WORDS in gate-dataset.mjs');

    const words = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    if (words.length === 0) throw new Error('parsed RANKING_WORDS but found no words');
    return words;
  }

  function keyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
      for (const item of value) keyNames(item, into);
    } else if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        for (const segment of key.split(/(?=[A-Z])|[-_]/)) into.add(segment.toLowerCase());
        keyNames(nested, into);
      }
    }
    return into;
  }

  it('parses a non-trivial word list out of the gate, including "tier"', () => {
    expect(rankingWords()).toContain('tier');
  });

  it('uses no key name the dataset gate classes as ranking vocabulary', () => {
    const banned = new Set(rankingWords());
    const used = [...keyNames(variantPositioning)].filter((segment) => banned.has(segment));

    expect(used).toEqual([]);
  });
});

describe('the positioning contract', () => {
  it('accepts a well-formed record', () => {
    expect(() => validateVariantPositioning([validRecord()])).not.toThrow();
  });

  it('accepts an empty document, because absence everywhere is a valid state', () => {
    expect(validateVariantPositioning([])).toEqual([]);
  });

  it('refuses a variant with no source', () => {
    const entry = validEntry({ official: { effectiveAsOf: '2026-08-30', sources: [] } });
    expect(() => validateVariantPositioning([validRecord({ variants: [entry] })]))
      .toThrow(/sources/);
  });

  it('refuses a source with no quote', () => {
    const source = { ...validEntry().official.sources[0], quote: '' };
    const entry = validEntry({ official: { effectiveAsOf: '2026-08-30', sources: [source] } });
    expect(() => validateVariantPositioning([validRecord({ variants: [entry] })]))
      .toThrow(/quote/);
  });

  it('refuses a quote too long to sit on one line beside a node', () => {
    const source = { ...validEntry().official.sources[0], quote: 'x'.repeat(201) };
    const entry = validEntry({ official: { effectiveAsOf: '2026-08-30', sources: [source] } });
    expect(() => validateVariantPositioning([validRecord({ variants: [entry] })]))
      .toThrow(/quote/);
  });

  it('refuses a variant with no verification date on its editorial summary', () => {
    const entry = validEntry({ editorial: { summary: validEntry().editorial.summary } });
    expect(() => validateVariantPositioning([validRecord({ variants: [entry] })]))
      .toThrow(/verifiedAt/);
  });

  it('refuses the same variant positioned twice in one family', () => {
    const record = validRecord({ variants: [validEntry(), validEntry()] });
    expect(() => validateVariantPositioning([record])).toThrow(/positioned twice/);
  });

  it('refuses two records for the same family', () => {
    const records = [validRecord(), validRecord({ id: 'positioning-sample-family-again' })];
    expect(() => validateVariantPositioning(records)).toThrow(/more than one positioning record/);
  });

  it('refuses two records with the same id', () => {
    const records = [validRecord(), validRecord({ familyId: 'other-family' })];
    expect(() => validateVariantPositioning(records)).toThrow(/recorded twice/);
  });

  it('refuses a record with no variants at all, because absence is a missing record', () => {
    expect(() => validateVariantPositioning([validRecord({ variants: [] })])).toThrow();
  });
});

describe('the wording filters over ModelTree prose', () => {
  const rejected: [string, string][] = [
    ['a recommendation', 'The creator scopes this name to batch work, and we recommend it for that.'],
    ['prescriptive advice', 'The creator scopes this name to batch work, so you should use it there.'],
    ['a default-choice framing', 'The creator scopes this name to batch work; it is the safe choice.'],
    ['price vocabulary', 'The creator scopes this name to batch work at a lower price than its siblings.'],
    ['a currency amount', 'The creator scopes this name to batch work, at $1 per million tokens run.'],
    ['a value-for-money framing', 'The creator scopes this name to batch work, which is cost-effective at volume.'],
    ['a letter grade', 'The creator scopes this name to batch work, which we would call grade B overall.'],
    ['an ordered ladder', 'The creator scopes this name to batch work; it is the entry tier of the family.'],
  ];

  it.each(rejected)('rejects %s in an editorial summary', (_label, summary) => {
    const record = validRecord({ variants: [validEntry({ editorial: { summary, verifiedAt: '2026-08-30' } })] });
    expect(() => validateVariantPositioning([record])).toThrow(/unsupported language/);
  });

  it.each(rejected)('rejects %s in a family note', (_label, note) => {
    expect(() => validateVariantPositioning([validRecord({ note })])).toThrow(/unsupported language/);
  });

  /**
   * The filter inherited from `model-fit-rubric.ts` runs here too. Positioning
   * and conditional guidance are different features answering different
   * questions, and neither one gets to declare a winner.
   */
  it('rejects universal-winner language inherited from the model-fit filter', () => {
    const summary = 'The creator scopes this name to agentic work, and it is the best model available.';
    const record = validRecord({ variants: [validEntry({ editorial: { summary, verifiedAt: '2026-08-30' } })] });
    expect(() => validateVariantPositioning([record])).toThrow(/unsupported language/);
  });

  it('names the phrase and the category it failed on, so a rejection is actionable', () => {
    expect(findPositioningClaim('cheaper than the alternatives'))
      .toEqual({ name: 'price vocabulary', phrase: 'cheaper' });
  });

  it('leaves descriptive prose alone', () => {
    expect(findPositioningClaim('The creator describes this name by the kind of work it is meant for.'))
      .toBeUndefined();
  });

  it('states a category name for every pattern, so no rejection is anonymous', () => {
    for (const { name, pattern } of POSITIONING_CLAIM_PATTERNS) {
      expect(name.trim().length).toBeGreaterThan(0);
      expect(pattern.flags).toContain('i');
    }
  });
});
