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

/**
 * ADR 0012. A rationale earns its place by saying something that a rationale
 * for a different release of the same creator could not say. Three kinds of
 * reference qualify, and transplanting the sentence onto another release
 * falsifies each: it names another release, which that release's own rationale
 * could not do without pointing at itself; it states this release's lifecycle
 * standing, which a release still current does not share; or it states a
 * uniqueness claim, which by construction holds of one release in a line.
 *
 * This is a documented list of reference kinds, not a decision procedure for
 * English, and it fails safe -- a rationale containing "only" incidentally
 * passes. What stops the list from being decorative is the negative control
 * beside every use of it: the sentence #788 was filed about must still be
 * refused, or a pass here would prove only that the check cannot come back
 * false.
 */
const DISCRIMINATING_REFERENCES = [
  // Lifecycle standing, which a release's successor does not share.
  'legacy', 'retirement', 'shutdown', 'replacement', 'superseded',
  'migrat', 'preceded', 'successor',
  // Uniqueness, which by construction holds of one release in a line.
  'only', 'first', 'introduced', 'largest', 'newest', 'latest', 'seed',
  'historically important',
];

/** The sentence this issue was filed about: true verbatim of Claude Fable 5.1. */
const SUPERSEDED_FABLE_5_RATIONALE =
  'A widely released Claude model with a dated general-availability statement in the official model documentation.';

function discriminates(rationale: string): boolean {
  const text = rationale.toLowerCase();
  return DISCRIMINATING_REFERENCES.some((reference) => text.includes(reference));
}

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
    // The five steps, in the order a reader applies them.
    expect(schemaPolicyClauses()).toHaveLength(5);
    expect(schemaPolicyClauses()[0]).toContain('one of the five');
    expect(schemaPolicyClauses()[1]).toContain('at least one release for each of those five');
    expect(schemaPolicyClauses()[2]).toContain('flag no release of any other creator');
    expect(schemaPolicyClauses()[3]).toContain('on exactly the releases flagged');
    expect(schemaPolicyClauses()[4]).toContain('no lifecycle status decide the flag');
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

  it('lets no lifecycle status decide the flag, in either direction', () => {
    // ADR 0012. `status` is a sourced measurement, so deriving the list from it
    // would make membership a function of recency -- an order, computed from
    // data, in a list that states it has none. The rule is pinned in the
    // procedure so a later refresh reads it rather than re-deciding it, and the
    // equality test below carries it to both published surfaces.
    const statement = schemaPolicyStatement();

    expect(statement).toContain('let no lifecycle status decide the flag in either direction');
    expect(statement).toContain('a `legacy` release may stay flagged');
    expect(statement).toContain('a `current` one is not owed the flag');

    // It must not have been written as an ordering on the way in.
    expect(statement).not.toMatch(/\branked\b/i);
    expect(statement).not.toMatch(/\bscore of\b/i);
  });

  it('makes a flagged release that has been superseded say why it keeps its placement', () => {
    // Instrument controls, both directions, before any record is read: a check
    // that cannot come back false would pass the whole catalog vacuously, and a
    // check that cannot come back true would fail it for no reason.
    expect(discriminates('Historically important: the largest Llama 3.1 size.')).toBe(true);
    expect(discriminates(SUPERSEDED_FABLE_5_RATIONALE)).toBe(false);

    // The class may legitimately empty as releases retire, which is why the
    // controls above rather than the class size are what prove this is live.
    for (const release of rawDataset.releases) {
      if (!release.featured || release.status !== 'legacy') continue;

      expect(release.featuredRationale, release.id).toBeDefined();
      expect(discriminates(release.featuredRationale!), release.id).toBe(true);
    }
  });

  it('keeps a rationale that could not be written of the release succeeding it', () => {
    const fable5 = rawDataset.releases.find(({ id }) => id === 'anthropic-claude-fable-5');
    const fable51 = rawDataset.releases.find(({ id }) => id === 'anthropic-claude-fable-5-1');

    // Positive control: reading `undefined` would satisfy every assertion below
    // without proving anything about either record.
    expect(fable5, 'anthropic-claude-fable-5').toBeDefined();
    expect(fable51, 'anthropic-claude-fable-5-1').toBeDefined();
    expect(fable5!.status).toBe('legacy');
    expect(fable51!.status).toBe('current');
    expect(fable5!.featuredRationale, 'anthropic-claude-fable-5').toBeDefined();

    // "Not interchangeable" is decidable in this form where "is this sentence
    // true of that release?" is not: the rationale names its successor, so
    // transplanting it onto that successor makes the successor point at itself.
    expect(fable5!.featuredRationale).toContain(fable51!.displayName);
    expect(discriminates(fable5!.featuredRationale!)).toBe(true);

    // Negative control: the sentence this issue was filed about, which is true
    // verbatim of Claude Fable 5.1 and must fail both readings.
    expect(SUPERSEDED_FABLE_5_RATIONALE).not.toContain(fable51!.displayName);
    expect(discriminates(SUPERSEDED_FABLE_5_RATIONALE)).toBe(false);
  });

  it('gives no two featured releases of one creator the same rationale, unless they launched together', () => {
    const flagged = rawDataset.releases.filter(({ featured }) => featured);
    const byCreator = new Map<string, typeof flagged>();
    for (const release of flagged) {
      byCreator.set(release.organizationId, [
        ...(byCreator.get(release.organizationId) ?? []),
        release,
      ]);
    }

    let compared = 0;
    for (const [creatorId, releases] of byCreator) {
      for (const a of releases) {
        for (const b of releases) {
          if (a.id >= b.id) continue;
          compared += 1;

          // Releases announced on one date may share one launch rationale: the
          // three GPT-4.1 seeds are a single announcement, not three decisions.
          if (a.releaseDate === b.releaseDate) continue;

          expect(a.featuredRationale, `${creatorId}: ${a.id} vs ${b.id}`)
            .not.toBe(b.featuredRationale);
        }
      }
    }

    // Differential control: a rule over pairs asserts nothing if no pair formed.
    expect(compared).toBeGreaterThan(0);
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
