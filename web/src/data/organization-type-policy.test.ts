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
      cohere: 'company',
      ai2: 'research-lab',
      tii: 'research-lab',
      nvidia: 'company',
      'ai21-labs': 'company',
      'zhipu-ai': 'company',
      'moonshot-ai': 'company',
      eleutherai: 'research-lab',
      'lg-ai-research': 'research-lab',
      snowflake: 'company',
      upstage: 'company',
      ibm: 'company',
      baidu: 'company',
      tencent: 'company',
      'bytedance-seed': 'company',
      'stability-ai': 'company',
      databricks: 'company',
      minimax: 'company',
      apple: 'company',
      'hugging-face': 'company',
      '01-ai': 'company',
      'sakana-ai': 'company',
      'sarvam-ai': 'company',
      naver: 'company',
      'aleph-alpha': 'company',
      'reka-ai': 'company',
      'nous-research': 'company',
      'liquid-ai': 'company',
      xiaomi: 'company',
      'ai-singapore': 'research-lab',
      kyutai: 'research-lab',
      'lelapa-ai': 'company',
      'maritaca-ai': 'company',
      openbmb: 'company',
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
      cohere: {
        facts: {
          offersPaidModelProductsOrAccess: true,
          institutionControlsReleases: true,
          primarilyResearch: false,
        },
        type: 'company',
        clause: 'paid-company',
      },
      ai2: {
        facts: { institutionControlsReleases: true, primarilyResearch: true },
        type: 'research-lab',
        clause: 'research-lab',
      },
      tii: {
        facts: { institutionControlsReleases: true, primarilyResearch: true },
        type: 'research-lab',
        clause: 'research-lab',
      },
      nvidia: {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      'ai21-labs': {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      'zhipu-ai': {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      'moonshot-ai': {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      eleutherai: {
        facts: { institutionControlsReleases: true, primarilyResearch: true },
        type: 'research-lab',
        clause: 'research-lab',
      },
      'lg-ai-research': {
        facts: { institutionControlsReleases: true, primarilyResearch: true },
        type: 'research-lab',
        clause: 'research-lab',
      },
      snowflake: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      upstage: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // IBM's own Granite page establishes indemnification for "IBM-developed
      // models" and contrasts IBM with "other providers of large language
      // models", but no IBM-published page read for this record states that IBM
      // sells model products or access. Indemnification is not a paid offering
      // and the contrast is not a claim, so no fact is asserted here rather than
      // inferring one from the surrounding commercial language.
      ibm: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // No Baidu-published page read for this record states that Baidu sells
      // model products or access under its own name, so no fact is asserted and
      // the fallback clause types it rather than a reverse-engineered one.
      baidu: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Same position as Baidu: the Hunyuan card and licence establish who
      // publishes the weights, and neither establishes a paid offering.
      tencent: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Seed is ByteDance's named research unit and publishes its own models,
      // but nothing read here establishes that it "exists primarily for
      // research" as the research-lab clause requires, so it is not claimed.
      'bytedance-seed': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Stability's own model card puts commercial use above $1M in annual
      // revenue behind an Enterprise License obtained from Stability AI.
      'stability-ai': {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      // Databricks' own announcement states "DBRX is available for Databricks
      // customers to use via APIs", which is access under its own name.
      databricks: {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      // MiniMax's own launch announcement prices the API it sells under its own
      // name -- "providing APIs on our official website at the industry's
      // lowest prices", at "$0.4/million tokens for input" -- so the paid
      // clause is stated rather than inferred, unlike Baidu and Tencent above.
      minimax: {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      // Apple's OpenELM licence establishes that Apple developed and released
      // the weights for scientific research. No Apple page read for this record
      // states that Apple sells model products or access, so no fact is
      // asserted and the fallback clause types it.
      apple: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Hugging Face is recorded as a creator for SmolLM3 only. Its blog and
      // model card establish that it made the model; neither states a paid
      // model offering, and the Hub it operates is a hosting platform rather
      // than a model product of its own, so no fact is asserted here.
      'hugging-face': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // 01.AI's README states the Yi series is trained from scratch by 01.AI
      // and distributed under Apache 2.0. Nothing read for this record states a
      // paid offering.
      '01-ai': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Sakana AI's post states its "core research focus", which is not the
      // same claim as existing primarily for research, and no page read
      // establishes that an institution controls its releases. Both halves of
      // the research-lab clause are therefore unmet and neither is invented.
      'sakana-ai': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Sarvam AI publishes API documentation, but no page read for this record
      // states that access is paid, so the paid-company clause is not claimed
      // from the existence of an API alone.
      'sarvam-ai': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // NAVER's announcement states the opposite of a paid offering for these
      // weights -- the SEED models "can now be used for commercial purposes free
      // of charge" -- and no NAVER page read for this record states that NAVER
      // sells model products or access under its own name, so no fact is
      // asserted and the fallback clause types it. NAVER Cloud's separate
      // commercial offerings are not NAVER's sales for this purpose, and no
      // source read here states the relation between the two anyway.
      naver: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Aleph Alpha's own Pharia blog announces the weight-available model family
      // but states no paid model product or access under its own name on any page
      // read for this record, so the fallback clause types it rather than an
      // inferred sale.
      'aleph-alpha': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Reka's own news post open-sources Reka Flash 3.1; while it mentions an API,
      // no page read for this record states that access is paid, so the paid clause
      // is not claimed from the existence of an API alone and the fallback types it.
      'reka-ai': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Nous Research's own site metadata and footer both call it "The AI
      // accelerator company". Nothing read here states that contributors outside
      // its own appointment chain decide its releases, so the community clause is
      // not met, and no paid offering is stated, so the fallback clause types it.
      'nous-research': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Liquid AI's own blog releases the LFM2 weights; no page read for this
      // record states a paid model product or access under its own name, so the
      // fallback clause types it.
      'liquid-ai': {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // Xiaomi's MiMo repository publishes the weights under MIT; no page read for
      // this record states that Xiaomi sells model products or access under its own
      // name, so no fact is asserted and the fallback clause types it.
      xiaomi: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
      },
      // AI Singapore's SEA-LION v3 card records "Funded by: National Research
      // Foundation, Singapore": a national research-funded programme whose
      // institution controls its releases and which exists primarily for research,
      // matching the research-lab clause as TII and AI2 do.
      'ai-singapore': {
        facts: { institutionControlsReleases: true, primarilyResearch: true },
        type: 'research-lab',
        clause: 'research-lab',
      },
      // Kyutai's own site titles it "kyutai: open-science AI lab", calls itself
      // an "AI RESEARCH LAB BASED IN PARIS", and states a mission to "build and
      // democratize artificial general intelligence through open science". One
      // standalone institution controls its releases and exists primarily for
      // research. No page read states that it sells model access under its own
      // name, so the paid clause is not reached and research-lab is the first
      // match.
      kyutai: {
        facts: { institutionControlsReleases: true, primarilyResearch: true },
        type: 'research-lab',
        clause: 'research-lab',
      },
      // Lelapa AI's own pricing page offers "Speech-to-text with codeswitching
      // support for multilingual contact centres" under "Simple, transparent
      // pricing", so it offers model access for payment under its own name and
      // the paid clause matches before any later one is reached.
      'lelapa-ai': {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      // Maritaca AI's own plans page prices its API "por 1 milhão de tokens",
      // so it offers model access for payment under its own name. Its About
      // page separately calls it "uma empresa brasileira", but the clause rests
      // on the priced access rather than on the self-description.
      'maritaca-ai': {
        facts: { offersPaidModelProductsOrAccess: true },
        type: 'company',
        clause: 'paid-company',
      },
      // No page read states OpenBMB's governance, its legal form, or whether it
      // sells access under its own name, so every earlier clause goes unmatched
      // and the record falls to the fallback. That is an absence of evidence
      // recorded as such, not a finding that OpenBMB is none of those things.
      openbmb: {
        facts: {},
        type: 'company',
        clause: 'company-fallback',
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
