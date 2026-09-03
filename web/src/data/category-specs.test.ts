import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelCategory } from './schema';
import { rawDataset } from './raw';
import {
  CATEGORY_SPEC_COVERAGE,
  CategorySpecValidationError,
  IMAGE_SPEC_DIMENSION_DEFINITIONS,
  PILOTED_CATEGORIES,
  assertCategorySpecsResolve,
  categorySpecSchema,
  imageSpecDimension,
  validateCategorySpecs,
} from './category-spec-schema';
import { categorySpecByReleaseId, categorySpecs, imageSpecForRelease } from './category-specs';

const releaseById = new Map(rawDataset.releases.map((release) => [release.id, release]));
const sourceIds = new Set(rawDataset.sources.map((source) => source.id));

function context() {
  return {
    releaseCategories: new Map<string, readonly string[]>(
      rawDataset.releases.map((release) => [release.id, release.categories]),
    ),
    knownSourceIds: sourceIds,
  };
}

function imageSpec() {
  return {
    category: 'image' as const,
    releaseId: 'openai-gpt-image-2',
    verifiedAt: '2026-09-02',
    sourceIds: ['openai-gpt-image-2-docs'],
    facts: [
      {
        dimension: 'output-sizing' as const,
        statement: 'Sizes are flexible.',
        quote: 'It supports flexible image sizes and high-fidelity image inputs.',
        sourceId: 'openai-gpt-image-2-docs',
      },
    ],
  };
}

/**
 * The discriminator test issue #43 asks for.
 *
 * It is written against `modelCategory`'s own members rather than a list
 * repeated here, so it fails when a category is added and nobody says what
 * happens to it. That is the whole point: the risk this pilot introduces is not
 * that image is wrong, it is that a tenth category arrives and silently gets
 * nothing.
 */
describe('every model category is accounted for', () => {
  it('declares a coverage state for each member of the enum', () => {
    expect(Object.keys(CATEGORY_SPEC_COVERAGE).sort()).toEqual([...modelCategory.options].sort());
  });

  it('pilots exactly one category, as the issue scope requires', () => {
    expect(PILOTED_CATEGORIES).toEqual(['image']);
  });

  it('gives the union a member for every piloted category and no other', () => {
    const members = categorySpecSchema.options.map((option) => option.shape.category.value);

    expect([...members].sort()).toEqual([...PILOTED_CATEGORIES].sort());
  });

  it('holds no spec record for a category that is not piloted', () => {
    for (const spec of categorySpecs) {
      expect(CATEGORY_SPEC_COVERAGE[spec.category]).toBe('piloted');
    }
  });

  it('defines every image dimension it can record', () => {
    expect(Object.keys(IMAGE_SPEC_DIMENSION_DEFINITIONS).sort())
      .toEqual([...imageSpecDimension.options].sort());
  });
});

describe('the pilot dataset', () => {
  it('records specs only for releases that declare the category', () => {
    for (const spec of categorySpecs) {
      const release = releaseById.get(spec.releaseId);

      expect(release, `${spec.releaseId} should exist`).toBeDefined();
      expect(release?.categories).toContain(spec.category);
    }
  });

  it('carries a primary source and a verification date on every record', () => {
    expect(categorySpecs.length).toBeGreaterThan(0);

    for (const spec of categorySpecs) {
      expect(spec.sourceIds.length).toBeGreaterThan(0);
      expect(spec.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      for (const id of spec.sourceIds) expect(sourceIds.has(id)).toBe(true);
    }
  });

  it('backs every recorded fact with a quote from a source the record lists', () => {
    for (const spec of categorySpecs) {
      for (const fact of spec.facts) {
        expect(fact.quote.trim().length).toBeGreaterThan(0);
        expect(fact.statement.trim().length).toBeGreaterThan(0);
        expect(spec.sourceIds).toContain(fact.sourceId);
      }
    }
  });

  it('leaves undocumented dimensions absent rather than guessing them', () => {
    // Meta's announcement states editing and multi-reference composition and says
    // nothing whatever about resolution. The gap is the point: ADR 0007 predicted
    // exactly this shortfall, and a value invented here would hide it.
    const muse = imageSpecForRelease('meta-muse-image');
    const dimensions = muse?.facts.map((fact) => fact.dimension) ?? [];

    expect(muse).toBeDefined();
    expect(dimensions).toContain('image-editing');
    expect(dimensions).not.toContain('output-sizing');
  });

  it('indexes each spec by its release', () => {
    for (const spec of categorySpecs) {
      expect(categorySpecByReleaseId.get(spec.releaseId)).toBe(spec);
    }
  });

  it('returns nothing for a release no source documented', () => {
    expect(imageSpecForRelease('meta-llama-4-scout')).toBeUndefined();
  });
});

describe('document validation', () => {
  it('accepts the pilot shape', () => {
    expect(validateCategorySpecs([imageSpec()])).toHaveLength(1);
  });

  it('refuses two specs for the same release and category', () => {
    expect(() => validateCategorySpecs([imageSpec(), imageSpec()]))
      .toThrow(/duplicates an existing spec/);
  });

  it('refuses a quote whose source the record does not list', () => {
    const base = imageSpec();
    const spec = {
      ...base,
      facts: [{ ...base.facts[0], sourceId: 'openai-models-catalog' }],
    };

    expect(() => validateCategorySpecs([spec]))
      .toThrow(/which the record does not list in sourceIds/);
  });

  it('refuses a record with no facts', () => {
    const spec = { ...imageSpec(), facts: [] };

    expect(() => validateCategorySpecs([spec])).toThrow(z.ZodError);
  });

  it('refuses a dimension outside the vocabulary', () => {
    const base = imageSpec();
    const spec = { ...base, facts: [{ ...base.facts[0], dimension: 'render-speed' }] };

    expect(() => validateCategorySpecs([spec])).toThrow(z.ZodError);
  });

  it('refuses a fact whose quote is empty', () => {
    const base = imageSpec();
    const spec = { ...base, facts: [{ ...base.facts[0], quote: '' }] };

    expect(() => validateCategorySpecs([spec])).toThrow(z.ZodError);
  });
});

describe('cross-reference validation', () => {
  // These run here rather than at module load so that `category-specs.ts` can
  // import its own document and nothing else. It is reachable from the passport,
  // and importing the raw documents there shipped a second copy of them to the
  // browser. `npm run build` runs `npm run validate` first, so a cross-reference
  // that breaks still cannot ship.
  it('accepts every shipped spec against the real dataset', () => {
    expect(() => assertCategorySpecsResolve(categorySpecs, context())).not.toThrow();
    expect(categorySpecs.length).toBeGreaterThan(0);
  });

  it('refuses a spec for a release that does not exist', () => {
    const spec = { ...imageSpec(), releaseId: 'not-a-real-release' };

    expect(() => assertCategorySpecsResolve(validateCategorySpecs([spec]), context()))
      .toThrow(CategorySpecValidationError);
  });

  it('refuses an image spec on a release that is not an image model', () => {
    // The check that keeps the discriminant honest.
    const spec = { ...imageSpec(), releaseId: 'meta-llama-4-scout' };

    expect(() => assertCategorySpecsResolve(validateCategorySpecs([spec]), context()))
      .toThrow(/is a "image" spec, but that release declares only/);
  });

  it('refuses a source id the dataset does not register', () => {
    const base = imageSpec();
    const spec = {
      ...base,
      sourceIds: ['no-such-source'],
      facts: [{ ...base.facts[0], sourceId: 'no-such-source' }],
    };

    expect(() => assertCategorySpecsResolve(validateCategorySpecs([spec]), context()))
      .toThrow(/references missing source/);
  });
});
