import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const schemaSource = read('./schema.ts');
const methodologyPage = read('../pages/methodology.astro');
const reviewSkill = read('../../../.github/skills/modeltree-review/SKILL.md');

const POLICY_BLOCK_START = '<!-- osi-approved-evidence-policy:start -->';
const POLICY_BLOCK_END = '<!-- osi-approved-evidence-policy:end -->';

// An SPDX id read as evidence is the inference #461 exists to forbid, so the
// page must not carry any sentence of that shape, not merely avoid one wording.
const EVIDENCE_INVERSION = /(?:spdx|licence `?url`?|licence URL)[^.]{0,160}as evidence/i;

function normalizePolicyText(source: string): string {
  return source
    .replaceAll('<code>', '`')
    .replaceAll('</code>', '`')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('**', '')
    .replaceAll('//', ' ')
    .replaceAll('’', "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// The schema comment beside `licenseSchema` is the source of truth. Reading the
// canonical clauses out of it, rather than restating them here, is what makes
// this a guard: reword the schema and the slice changes, so every published
// surface must be brought along or go red.
function schemaEvidenceRule(): string {
  const rule = schemaSource.match(/\/\/ What evidences `osiApproved`[\s\S]*?\n\/\/\n/)?.[0];
  if (!rule) throw new Error('the osiApproved evidence rule is missing beside the schema field');
  return normalizePolicyText(rule);
}

function sliceBetween(source: string, open: string, close: string, label: string): string {
  const start = source.indexOf(open);
  if (start < 0) throw new Error(`the schema evidence rule no longer opens ${label} with "${open}"`);
  const end = source.indexOf(close, start + open.length);
  if (end < 0) throw new Error(`the schema evidence rule no longer closes ${label} with "${close}"`);
  return source.slice(start, end + close.length);
}

const CANONICAL_CLAUSES: ReadonlyArray<{ label: string; open: string; close: string }> = [
  {
    label: 'the evidence rule',
    open: '`osiApproved` must rest on a source',
    close: 'at opensource.org',
  },
  {
    label: 'the non-evidence rule',
    open: 'an `spdxId` or a licence `url` alone',
    close: 'not evidence of OSI status',
  },
  {
    label: 'the structural floor',
    open: 'is a structural floor',
    close: "which is the reviewer's to apply",
  },
];

function canonicalClauses(): string[] {
  const rule = schemaEvidenceRule();
  return CANONICAL_CLAUSES.map(({ label, open, close }) =>
    sliceBetween(rule, open, close, label),
  );
}

function publishedPolicyBlock(source: string, name: string): string {
  const starts = source.split(POLICY_BLOCK_START).length - 1;
  const ends = source.split(POLICY_BLOCK_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`${name} must contain exactly one delimited osiApproved evidence block`);
  }

  const start = source.indexOf(POLICY_BLOCK_START) + POLICY_BLOCK_START.length;
  const end = source.indexOf(POLICY_BLOCK_END, start);
  if (end < start) throw new Error(`${name} osiApproved evidence delimiters are out of order`);

  return normalizePolicyText(source.slice(start, end));
}

describe('osiApproved evidence policy', () => {
  it('states the evidence rule beside the schema field', () => {
    const rule = schemaEvidenceRule();
    expect(rule).toContain('must rest on a source that states OSI approval');
    expect(rule).toContain('alone is not evidence of OSI status');
    expect(rule).toContain('structural floor');
    expect(rule).toContain('it ensures a licence is identified');
    expect(rule).toContain('not the evidence rule for the field');
  });

  it('derives three usable clauses from the schema comment', () => {
    const clauses = canonicalClauses();
    expect(clauses).toHaveLength(3);
    for (const clause of clauses) {
      expect(clause.length).toBeGreaterThan(20);
      expect(schemaEvidenceRule()).toContain(clause);
    }
  });

  it('publishes the schema’s own clauses on every surface that states the rule', () => {
    const clauses = canonicalClauses().map((clause) => clause.toLowerCase());

    for (const [name, document] of [['methodology', methodologyPage]] as const) {
      const published = publishedPolicyBlock(document, name).toLowerCase();
      for (const clause of clauses) {
        expect(published).toContain(clause);
      }
    }
  });

  it('never presents an spdxId or a licence URL as evidence of OSI status', () => {
    for (const [name, document] of [['methodology', methodologyPage]] as const) {
      expect({ name, matches: EVIDENCE_INVERSION.test(normalizePolicyText(document)) }).toEqual({
        name,
        matches: false,
      });
    }
  });

  it('keeps the review rubric giving the same answer as the schema', () => {
    const rubric = normalizePolicyText(reviewSkill);
    expect(rubric).toContain('alone is not evidence of OSI status');
    expect(rubric).toContain('structural floor');
    expect(EVIDENCE_INVERSION.test(rubric)).toBe(false);
  });
});
