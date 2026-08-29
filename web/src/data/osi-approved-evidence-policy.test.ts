import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const schemaSource = read('./schema.ts');
const validateSource = read('./validate.ts');
const methodologyPage = read('../pages/methodology.astro');
const readme = read('../../README.md');
const reviewSkill = read('../../../.github/skills/modeltree-review/SKILL.md');

// Every surface that states the rule to a reader — the published methodology
// page and the contributor README — must state the schema's version of it.
const PUBLISHED_SURFACES = [
  ['methodology', methodologyPage],
  ['README', readme],
] as const;

// The rule is stated in code too, in a comment and in a refusal message. A
// refusal message is the channel where a false claim of verification is most
// likely to be believed, because it reaches an operator at the moment the check
// fires — the reasoning ADR 0005 records for `gate-evidence.mjs`, and the reason
// #481 rewrote the `superRefine` message that called the identifier "evidence".
// So these are held to the same negative check as the published prose.
const CODE_SURFACES = [
  ['schema', schemaSource],
  ['validate', validateSource],
] as const;

const POLICY_BLOCK_START = '<!-- osi-approved-evidence-policy:start -->';
const POLICY_BLOCK_END = '<!-- osi-approved-evidence-policy:end -->';

// Treating a licence identifier as sufficient grounds for OSI status is the
// inference #461 exists to forbid, and it has more phrasings than "as evidence"
// — abdeslam-menacere/ModelTree#486 states the same error as "finding an SPDX id
// is sufficient grounds to record `osiApproved: true`". So match the shape
// (a licence identifier, then a sufficiency claim) rather than one wording.
//
// THE LIMIT, stated plainly because it is easy to mistake this for a total
// check: a negative prose check is necessarily incomplete. No regex decides
// whether English asserts a semantic claim, and any list of verbs can be
// paraphrased around. This alternation covers the formulations this repository
// has actually produced or named and is deliberately bounded there; chasing
// exhaustiveness would make the check look complete while still not being, which
// is the very defect class #486 belongs to. The load-bearing mechanism is the
// positive assertion below — that every published surface contains the schema's
// own clauses — which fails on ANY rewording, including ones this regex misses.
// This check is a second line that catches known-bad shapes, not the first.
const LICENCE_IDENTIFIER = String.raw`spdx|licence \`?url\`?|licence URL|licence identifier`;
// \b matters on every verb: "approves" contains "proves".
const SUFFICIENCY_CLAIM = String.raw`as evidence|\bis evidence\b|\bare evidence\b|\bproves\b|\bproof\b|\bestablishes\b|\bdemonstrates\b|\bconfirms\b|\bsufficient\b|\benough\b`;
// The gap may not cross a sentence end, nor a negation: "an spdxId alone is not
// evidence of OSI status" is the correct wording and must never match.
const EVIDENCE_INVERSION = new RegExp(
  `(?:${LICENCE_IDENTIFIER})(?:(?!\\bnot\\b|\\bnever\\b)[^.]){0,160}(?:${SUFFICIENCY_CLAIM})`,
  'i',
);

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

    for (const [name, document] of PUBLISHED_SURFACES) {
      const published = publishedPolicyBlock(document, name).toLowerCase();
      for (const clause of clauses) {
        expect(published).toContain(clause);
      }
    }
  });

  it('never presents an spdxId or a licence URL as grounds for OSI status', () => {
    for (const [name, document] of PUBLISHED_SURFACES) {
      expect({ name, matches: EVIDENCE_INVERSION.test(normalizePolicyText(document)) }).toEqual({
        name,
        matches: false,
      });
    }
  });

  // Pins what the negative check does and does not cover, so its boundary is
  // readable here rather than inferred from a regex. The escaping fixtures are
  // recorded deliberately: they are the honest statement of the limit, and they
  // are caught by the positive clause-containment test above, not by this one.
  it('catches the sufficiency formulations this issue names, and admits it is not exhaustive', () => {
    const caught = [
      'an OSI-approved claim needs an spdxId or a licence url as evidence',
      // The formulation issue #486 uses in its own words, which QA reproduced.
      'finding an SPDX identifier is sufficient grounds to record osiApproved: true',
      'a licence url is evidence of OSI approval',
      'an spdxId proves OSI approval',
      'an SPDX identifier is enough to record osiApproved',
      'a licence url establishes OSI approval',
      'an spdxId demonstrates OSI status',
      'a licence url confirms OSI approval',
      'an spdxId is proof of OSI approval',
    ];
    for (const sentence of caught) {
      expect({ sentence, caught: EVIDENCE_INVERSION.test(sentence) }).toEqual({
        sentence,
        caught: true,
      });
    }

    const correctWordingMustNotTrip = [
      'an spdxId or a licence url alone is not evidence of OSI status',
      'an spdxId alone is never sufficient to record osiApproved',
      'that requirement is a structural floor - it ensures a licence is identified',
      'not the evidence rule for the field’s truth, which is the reviewer’s to apply',
      'osiApproved must rest on a source that states OSI approval',
      'whether OSI approved that licence is a separate fact that only OSI states',
      'a validator can check that a licence is identified',
    ];
    for (const sentence of correctWordingMustNotTrip) {
      expect({ sentence, caught: EVIDENCE_INVERSION.test(sentence) }).toEqual({
        sentence,
        caught: false,
      });
    }

    // Recorded, not asserted as caught: a negative prose check cannot be
    // complete, and pretending otherwise is the failure shape #486 is about.
    const knownToEscape = [
      'an spdxId settles the question of OSI approval',
      'if a model card names Apache-2.0, mark it OSI approved',
    ];
    for (const sentence of knownToEscape) {
      expect(EVIDENCE_INVERSION.test(sentence)).toBe(false);
    }
  });

  it('keeps the review rubric giving the same answer as the schema', () => {
    const rubric = normalizePolicyText(reviewSkill);
    expect(rubric).toContain('alone is not evidence of OSI status');
    expect(rubric).toContain('structural floor');
    expect(EVIDENCE_INVERSION.test(rubric)).toBe(false);
  });

  it('never presents an spdxId or a licence URL as grounds for OSI status in code', () => {
    for (const [name, document] of CODE_SURFACES) {
      expect({ name, matches: EVIDENCE_INVERSION.test(normalizePolicyText(document)) }).toEqual({
        name,
        matches: false,
      });
    }
  });

  // Acceptance criterion 3 of #481: the decision on `osiApproved: false` is
  // recorded beside the field, with its reasoning and its limit, rather than
  // living only in a pull request nobody reads again.
  it('records beside the field whether osiApproved: false needs a source', () => {
    const decision = schemaSource.match(
      /\/\/ Whether `osiApproved: false`[\s\S]*?\nexport const licenseSchema/,
    )?.[0];
    if (!decision) throw new Error('the osiApproved: false decision is missing beside the schema field');
    const text = normalizePolicyText(decision);

    // The decision itself.
    expect(text).toContain('must cite a source published by the Open Source Initiative');
    // Why absence from OSI's list is readable evidence and not an argument from silence.
    expect(text).toContain('exhaustive by construction');
    // Why the structural floor stays on `true` alone.
    expect(text).toContain('stays asymmetric, and that part is deliberate');
    // What the enforcement does not establish, stated where the rule is stated.
    expect(text).toContain('never reads that source');
  });
});
