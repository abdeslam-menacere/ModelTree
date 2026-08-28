import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rawDataset } from './raw';
import { organizationSchema } from './schema';

const schemaSource = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8');
const reviewSkill = readFileSync(
  new URL('../../../.github/skills/modeltree-review/SKILL.md', import.meta.url),
  'utf8',
);
const methodologyPage = readFileSync(
  new URL('../pages/methodology.astro', import.meta.url),
  'utf8',
);
const informationArchitecture = readFileSync(
  new URL('../../../docs/product/INFORMATION-ARCHITECTURE.md', import.meta.url),
  'utf8',
);

describe('organization type policy', () => {
  it('keeps the required four-member category and all committed assignments', () => {
    expect(organizationSchema.shape.type.options).toEqual([
      'company',
      'research-lab',
      'nonprofit',
      'community',
    ]);
    expect(organizationSchema.shape.type.safeParse(undefined).success).toBe(false);
    expect(Object.fromEntries(rawDataset.organizations.map(({ id, type }) => [id, type]))).toEqual({
      openai: 'company',
      anthropic: 'company',
      'google-deepmind': 'research-lab',
      meta: 'company',
      xai: 'company',
      'mistral-ai': 'company',
      deepseek: 'company',
    });
  });

  it('documents one ordered editorial decision procedure beside the field', () => {
    const policy = schemaSource.match(
      /\/\/ Editorial functional classification[\s\S]*?type: z\.enum/,
    )?.[0];

    expect(policy).toBeDefined();
    expect(policy).toContain('not a sourced claim');
    expect(policy).toContain('Choose the first');
    expect(policy).toContain("outside any one entity's");
    expect(policy).toContain('can initiate and decide its model releases');
    expect(policy).toContain('not merely submit work');
    expect(policy).toContain('one standalone institution or');
    expect(policy).toContain('named unit controls releases');
    expect(policy).toContain('exists primarily for research');
    expect(policy).toContain('does not');
    expect(policy).toContain('sell model products or access under its name');
    expect(policy).toContain("a parent's sales do not");
    const categoryOffsets = ['`community`', '`research-lab`', '`nonprofit`', '`company`'].map(
      (category) => policy!.indexOf(category),
    );
    expect(categoryOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(categoryOffsets).toEqual([...categoryOffsets].sort((a, b) => a - b));
  });

  it('exempts only organization type from quote-gated provenance', () => {
    expect(reviewSkill).toContain('Organization type is editorial, not quoted');
    expect(reviewSkill).toContain('For a claim whose field is `organizationSchema.type`');
    expect(reviewSkill).toContain('do not require or gate');
    expect(reviewSkill).toContain('abdeslam-menacere/ModelTree#469');
    expect(reviewSkill).toMatch(
      /keep\s+quote requirements unchanged for every sourced field in the same organization\s+record/,
    );
  });

  it('publishes the functional, non-ranked decision procedure on both policy surfaces', () => {
    for (const document of [methodologyPage, informationArchitecture]) {
      expect(document).toContain('editorial functional category');
      expect(document).toContain('not a ranking');
      expect(document).toContain('first matching category');
      expect(document).toContain('primary-source quote');
      for (const category of ['community', 'research-lab', 'nonprofit', 'company']) {
        expect(document).toContain(category);
      }
    }
  });
});
