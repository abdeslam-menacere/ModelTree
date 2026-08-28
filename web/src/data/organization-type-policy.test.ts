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
const POLICY_BLOCK_START = '<!-- organization-type-policy:start -->';
const POLICY_BLOCK_END = '<!-- organization-type-policy:end -->';

function normalizePolicyText(source: string): string {
  return source
    .replaceAll('<code>', '`')
    .replaceAll('</code>', '`')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('//', ' ')
    .replaceAll('’', "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function schemaPolicyClauses(): string[] {
  const normalized = schemaPolicyStatement();
  const start = normalized.indexOf('Choose the first match:');
  if (start < 0) throw new Error('organization type policy is not machine-readable');

  return normalized
    .slice(start + 'Choose the first match:'.length)
    .replace(/\.$/, '')
    .split(';')
    .map((clause) => clause.trim());
}

function schemaPolicyStatement(): string {
  const policy = schemaSource.match(
    /\/\/ Editorial functional classification[\s\S]*?type: z\.enum/,
  )?.[0];
  if (!policy) throw new Error('organization type policy is missing beside the schema field');

  const normalized = normalizePolicyText(policy);
  const end = normalized.indexOf(' type: z.enum');
  if (end < 0) throw new Error('organization type policy is not machine-readable');
  return normalized.slice(0, end);
}

function publishedPolicyBlock(source: string, name: string): string {
  const starts = source.split(POLICY_BLOCK_START).length - 1;
  const ends = source.split(POLICY_BLOCK_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`${name} must contain exactly one delimited organization type policy block`);
  }

  const start = source.indexOf(POLICY_BLOCK_START) + POLICY_BLOCK_START.length;
  const end = source.indexOf(POLICY_BLOCK_END, start);
  if (end < start) throw new Error(`${name} organization type policy delimiters are out of order`);

  return normalizePolicyText(source.slice(start, end));
}

type OrganizationType = (typeof organizationSchema.shape.type.options)[number];

interface OrganizationFacts {
  independentContributorReleaseAuthority?: boolean;
  offersPaidModelProductsOrAccess?: boolean;
  institutionControlsReleases?: boolean;
  primarilyResearch?: boolean;
  centrallyGovernedNonprofit?: boolean;
}

function applyOrganizationTypePolicy(facts: OrganizationFacts): {
  type: OrganizationType;
  clause: 'community' | 'paid-company' | 'research-lab' | 'nonprofit' | 'company-fallback';
} {
  if (facts.independentContributorReleaseAuthority) {
    return { type: 'community', clause: 'community' };
  }
  if (facts.offersPaidModelProductsOrAccess) {
    return { type: 'company', clause: 'paid-company' };
  }
  if (facts.institutionControlsReleases && facts.primarilyResearch) {
    return { type: 'research-lab', clause: 'research-lab' };
  }
  if (facts.centrallyGovernedNonprofit) {
    return { type: 'nonprofit', clause: 'nonprofit' };
  }
  return { type: 'company', clause: 'company-fallback' };
}

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
      'alibaba-cloud': 'company',
      microsoft: 'company',
      amazon: 'company',
    });
  });

  it('documents one ordered editorial decision procedure beside the field', () => {
    const policy = schemaSource.match(
      /\/\/ Editorial functional classification[\s\S]*?type: z\.enum/,
    )?.[0];

    expect(policy).toBeDefined();
    const normalizedPolicy = normalizePolicyText(policy!);
    expect(normalizedPolicy).toContain('not a sourced claim');
    expect(normalizedPolicy).toContain('Choose the first');
    expect(normalizedPolicy).toContain("outside any one entity's");
    expect(normalizedPolicy).toContain('can initiate and decide its model releases');
    expect(normalizedPolicy).toContain('not merely submit work');
    expect(normalizedPolicy).toContain('offers model products or');
    expect(normalizedPolicy).toContain('access for payment under its name');
    expect(normalizedPolicy).toContain("a parent's sales do not count");
    expect(normalizedPolicy).toContain('one standalone institution or');
    expect(normalizedPolicy).toContain('named unit controls releases');
    expect(normalizedPolicy).toContain('exists primarily for research');
    expect(normalizedPolicy).toContain('otherwise `company`');
    expect(normalizedPolicy).toContain('centrally operated creator that runs the model work');
    const categoryOffsets = ['`community`', '`company`', '`research-lab`', '`nonprofit`'].map(
      (category) => normalizedPolicy.indexOf(category),
    );
    expect(categoryOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(categoryOffsets).toEqual([...categoryOffsets].sort((a, b) => a - b));
    expect(normalizedPolicy.lastIndexOf('otherwise `company`')).toBeGreaterThan(
      normalizedPolicy.indexOf('`nonprofit`'),
    );
  });

  it('assigns every committed organization through a total generic procedure', () => {
    const cases: Record<string, {
      facts: OrganizationFacts;
      type: OrganizationType;
      clause: ReturnType<typeof applyOrganizationTypePolicy>['clause'];
    }> = {
      openai: {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      anthropic: {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      'google-deepmind': {
        facts: { institutionControlsReleases: true, primarilyResearch: true },
        type: 'research-lab',
        clause: 'research-lab',
      },
      meta: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      xai: {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      'mistral-ai': {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      deepseek: {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      'alibaba-cloud': {
        facts: {
          offersPaidModelProductsOrAccess: true,
          institutionControlsReleases: true,
          primarilyResearch: false,
        },
        type: 'company',
        clause: 'paid-company',
      },
      microsoft: {
        facts: {
          offersPaidModelProductsOrAccess: true,
          institutionControlsReleases: true,
          primarilyResearch: false,
        },
        type: 'company',
        clause: 'paid-company',
      },
      amazon: {
        facts: {
          offersPaidModelProductsOrAccess: true,
          institutionControlsReleases: true,
          primarilyResearch: false,
        },
        type: 'company',
        clause: 'paid-company',
      },
    };

    expect(Object.keys(cases).sort()).toEqual(rawDataset.organizations.map(({ id }) => id).sort());
    for (const organization of rawDataset.organizations) {
      const testCase = cases[organization.id];
      expect(applyOrganizationTypePolicy(testCase.facts)).toEqual({
        type: testCase.type,
        clause: testCase.clause,
      });
      expect(testCase.type).toBe(organization.type);
    }
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
    const clauses = schemaPolicyClauses();
    expect(clauses).toHaveLength(5);
    const expectedPolicy = schemaPolicyStatement();

    for (const [name, document] of [
      ['methodology', methodologyPage],
      ['information architecture', informationArchitecture],
    ] as const) {
      expect(document).toContain('classifies function');
      expect(document).toContain('legal form');
      expect(document).toContain('not a ranking');
      expect(document).toContain('primary-source quote');

      expect(publishedPolicyBlock(document, name)).toBe(expectedPolicy);
    }
  });
});
