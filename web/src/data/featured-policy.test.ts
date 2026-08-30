import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rawDataset } from './raw';

/**
 * The featured flag's editorial criterion, held to the same standard ADR-era
 * issue #469 set for organization `type`: one ordered decision procedure, pinned
 * beside the field it governs, published verbatim wherever the site explains it,
 * and compared here so the three cannot drift.
 *
 * The procedure names five creators. That is deliberate and is the honest form
 * of this decision: an editorial choice about what the site leads with cannot be
 * derived from the data without inventing a measurement, and a measurement is
 * exactly the universal ranking this repository forbids. So the list is written
 * down as a list, and every assertion below is about *membership*, never about
 * order, size, or standing.
 */
const schemaSource = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8');
const methodologyPage = readFileSync(
  new URL('../pages/methodology.astro', import.meta.url),
  'utf8',
);
const informationArchitecture = readFileSync(
  new URL('../../../docs/product/INFORMATION-ARCHITECTURE.md', import.meta.url),
  'utf8',
);
const treePage = readFileSync(new URL('../pages/tree.astro', import.meta.url), 'utf8');

const POLICY_BLOCK_START = '<!-- featured-policy:start -->';
const POLICY_BLOCK_END = '<!-- featured-policy:end -->';

const CREATORS_THE_SITE_LEADS_WITH = [
  'anthropic',
  'google-deepmind',
  'meta',
  'microsoft',
  'openai',
];

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

function schemaPolicyStatement(): string {
  const policy = schemaSource.match(/\/\/ Editorial lead selection[\s\S]*?featured: z\.boolean/)?.[0];
  if (!policy) throw new Error('featured policy is missing beside the schema field');

  const normalized = normalizePolicyText(policy);
  const end = normalized.indexOf(' featured: z.boolean');
  if (end < 0) throw new Error('featured policy is not machine-readable');
  return normalized.slice(0, end);
}

function schemaPolicyClauses(): string[] {
  const normalized = schemaPolicyStatement();
  const start = normalized.indexOf('Apply in order:');
  if (start < 0) throw new Error('featured policy states no ordered procedure');

  return normalized
    .slice(start + 'Apply in order:'.length)
    .split(';')
    .map((clause) => clause.trim());
}

function publishedPolicyBlock(source: string, name: string): string {
  const starts = source.split(POLICY_BLOCK_START).length - 1;
  const ends = source.split(POLICY_BLOCK_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`${name} must contain exactly one delimited featured policy block`);
  }

  const start = source.indexOf(POLICY_BLOCK_START) + POLICY_BLOCK_START.length;
  const end = source.indexOf(POLICY_BLOCK_END, start);
  if (end < start) throw new Error(`${name} featured policy delimiters are out of order`);

  return normalizePolicyText(source.slice(start, end));
}

/** The creators the procedure names, read out of the pinned text itself. */
function creatorsNamedByPolicy(): string[] {
  const statement = schemaPolicyStatement();
  const start = statement.indexOf('this site leads with --');
  if (start < 0) throw new Error('featured policy does not name the creators it leads with');

  const clause = statement.slice(start, statement.indexOf(';', start));
  return [...clause.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]);
}

describe('featured policy', () => {
  it('documents one ordered editorial decision procedure beside the field', () => {
    const statement = schemaPolicyStatement();

    expect(statement).toContain('Editorial lead selection');
    expect(statement).toContain('not a ranking and not a sourced claim');
    expect(statement).toContain('Apply in order:');
    // The four steps, in the order a reader applies them.
    expect(schemaPolicyClauses()).toHaveLength(4);
    expect(schemaPolicyClauses()[0]).toContain('one of the five');
    expect(schemaPolicyClauses()[1]).toContain('at least one release for each of those five');
    expect(schemaPolicyClauses()[2]).toContain('flag no release of any other creator');
    expect(schemaPolicyClauses()[3]).toContain('on exactly the releases flagged');
  });

  it('states what the list is not, so featuring cannot read as a ranking', () => {
    const statement = schemaPolicyStatement();

    expect(statement).toContain('a choice about its own entry point');
    expect(statement).toContain('no order, no score');
    expect(statement).toContain('larger, better, or more important');
    // The three ways this repository would notice a ranking having crept in.
    expect(statement).not.toMatch(/\btop five\b/i);
    expect(statement).not.toMatch(/\branked\b/i);
    expect(statement).not.toMatch(/\bscore of\b/i);
  });

  it('names exactly five creators, and the same five the catalog flags', () => {
    // The list is read out of the pinned procedure, so the text is what decides
    // this rather than a constant repeated beside it.
    const named = creatorsNamedByPolicy();

    expect(named).toEqual(CREATORS_THE_SITE_LEADS_WITH);
    expect(new Set(named).size).toBe(5);
    expect([...new Set(
      rawDataset.releases.filter(({ featured }) => featured).map((r) => r.organizationId),
    )].sort()).toEqual([...named].sort());
  });

  it('flags at least one release for each named creator and none for any other', () => {
    const named = new Set(creatorsNamedByPolicy());

    for (const creatorId of named) {
      const owned = rawDataset.releases.filter((r) => r.organizationId === creatorId);
      // Positive control: a creator holding nothing would satisfy the
      // no-unflagged-release claim below without proving anything.
      expect(owned.length, creatorId).toBeGreaterThan(0);
      expect(owned.some(({ featured }) => featured), creatorId).toBe(true);
    }

    const omitted = [...new Set(rawDataset.releases.map((r) => r.organizationId))]
      .filter((id) => !named.has(id));

    // Differential control: the procedure only says something if some creator is
    // omitted. An empty Others branch would make every assertion below vacuous.
    expect(omitted.length).toBeGreaterThan(0);
    for (const creatorId of omitted) {
      const owned = rawDataset.releases.filter((r) => r.organizationId === creatorId);
      expect(owned.length, creatorId).toBeGreaterThan(0);
      expect(owned.filter(({ featured }) => featured), creatorId).toEqual([]);
    }
  });

  it('keeps a rationale on exactly the flagged releases, in both directions', () => {
    const flagged = rawDataset.releases.filter(({ featured }) => featured);
    const explained = rawDataset.releases.filter((r) => r.featuredRationale !== undefined);

    expect(flagged.length).toBeGreaterThan(0);
    expect(explained.map(({ id }) => id).sort()).toEqual(flagged.map(({ id }) => id).sort());
  });

  it('publishes the same procedure on both policy surfaces', () => {
    const expectedPolicy = schemaPolicyStatement();

    for (const [name, document] of [
      ['methodology', methodologyPage],
      ['information architecture', informationArchitecture],
    ] as const) {
      expect(publishedPolicyBlock(document, name)).toBe(expectedPolicy);
    }
  });

  it('no longer tells a reader that featuring follows a reviewed source profile', () => {
    // The defect class this issue exists to close: a page that keeps stating the
    // superseded criterion is wrong in a way no type or schema catches.
    for (const [name, document] of [
      ['methodology', methodologyPage],
      ['information architecture', informationArchitecture],
      ['tree page', treePage],
      ['schema', schemaSource],
    ] as const) {
      expect(document.toLowerCase(), name).not.toContain('reviewed source profile');
      expect(document.toLowerCase(), name).not.toContain('reviewed profile');
    }

    // Control: the same probe must find the phrase where it is genuinely
    // present, or a zero here would prove only that the probe is broken.
    expect('a creator has a reviewed source profile').toContain('reviewed source profile');
  });
});
