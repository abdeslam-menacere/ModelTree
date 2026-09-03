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
 * ADR 0012 asks two things of a rationale, and #840 established by measurement
 * that one instrument cannot answer both:
 *
 *   "... in terms that stay true once the release is superseded [durability]
 *    and that could not be written of another release of the same creator
 *    [discrimination]."
 *
 * The list below is the *durability* proxy. Half of it is lifecycle vocabulary
 * -- `legacy`, `retirement`, `shutdown`, `superseded`, `preceded` -- which a
 * release that is still current cannot honestly use about itself, so the list
 * is scoped to flagged releases that have been superseded and stays there.
 *
 * Reading it as the discrimination instrument as well was tried and refused on
 * the measurement: applied to all 24 flagged records it fails 9 of them, six of
 * which #840 puts out of scope because they already discriminate in substance
 * (`meta-llama-4-maverick` names another release outright), and it *passes* the
 * three byte-identical GPT-4.1 rationales, because "Seed release with ..."
 * contains `seed`. A check that fails records that are fine and passes the
 * records the issue was filed about is measuring the wrong thing. Discrimination
 * is enforced instead by `isWrittenOf` below, over every flagged release.
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

/**
 * ADR 0012's discrimination clause, and the sentences #840 was filed about.
 * Both are kept verbatim so the widened check is pinned against the exact
 * defect rather than against whatever the dataset happens to hold today.
 */
const SHARED_GPT_5_6_RATIONALE =
  'Launched in the GPT-5.6 general-availability announcement with its own dated API model documentation.';
const SUBSUMED_GEMINI_3_6_RATIONALE =
  'A generally available Flash tier of the Gemini 3 generation, with a dated release and published token limits.';
const SUBSUMING_GEMINI_3_7_RATIONALE =
  'The newest generally available Flash tier of the Gemini 3 generation, with a dated release and published token limits.';

/**
 * A sentence that says everything `SHARED_GPT_5_6_RATIONALE` says and more, so
 * the containment control below compares two distinct strings. Kept beside the
 * sentences it is built from rather than inline, so that it is visibly a
 * fixture and cannot be mistaken for a rationale any record publishes.
 */
const GENERIC_RATIONALE_SUPERSET =
  'Launched in the dated GPT-5.6 general-availability announcement for developers, with its own API model documentation and published token limits.';

/**
 * The featured set, pinned as a roster of ids rather than as a count.
 *
 * #840's sixth criterion asks that the featured totals be asserted "with their
 * denominator". A count alone cannot carry that claim: `toBeGreaterThan(0)`
 * stays green when a release is flagged, unflagged, or moved between statuses,
 * and even an exact `toBe(24)` stays green when one record leaves the set and
 * another joins it in the same change. The membership question and the size
 * question are different questions, and only the first one is the invariant
 * #840 exists to protect. So the roster below is compared by *identity*, in
 * both directions, and the counts are derived from it rather than written
 * beside it where the two could disagree.
 *
 * Why this is a roster and not a computation: ADR 0012 holds that featuring is
 * an editorial choice and that no lifecycle status decides it. An editorial set
 * has no formula, so the honest machine-readable form of "this set did not
 * change" is the set, written down. That is the same bookkeeping the asset
 * budgets use for `measuredRaw` -- a measured figure is pinned, and a change to
 * it is a reviewable line in the same commit as the change that moved it.
 *
 * If a data change moves any of this, updating the roster is the correct
 * response and belongs in that same commit. One caveat is worth knowing before
 * you reach for it: `.github/skills/modeltree-gates/scripts/gate-scope.mjs`
 * limits an ADR 0003 auto-merging refresh to the dataset JSON documents, and
 * this file is not among them. A refresh that reds this test therefore cannot
 * repair it in-class, and that is the intended outcome rather than a snag --
 * such a refresh is by definition changing an editorial set from sourced data,
 * which is the exact move ADR 0012 forbids. It should stop, loudly, and be
 * looked at by someone.
 */
const FEATURED_ROSTER: Readonly<Record<string, readonly string[]>> = {
  current: [
    'anthropic-claude-haiku-4-5',
    'anthropic-claude-opus-5',
    'anthropic-claude-sonnet-5',
    'google-gemini-2-5-flash',
    'google-gemini-2-5-pro',
    'google-gemini-3-1-flash-lite',
    'google-gemini-3-5-flash-lite',
    'google-gemini-3-6-flash',
    'google-gemini-3-7-flash',
    'meta-llama-4-maverick',
    'meta-llama-4-scout',
    'meta-muse-spark-1-1',
    'openai-gpt-4-1-2025-04-14',
    'openai-gpt-4-1-mini-2025-04-14',
    'openai-gpt-4-1-nano-2025-04-14',
    'openai-gpt-5-6-luna',
    'openai-gpt-5-6-sol',
    'openai-gpt-5-6-terra',
  ],
  legacy: [
    'anthropic-claude-fable-5',
    'google-gemini-3-5-flash',
    'meta-llama-3-1-405b',
    'meta-llama-3-3-70b',
  ],
  preview: [
    'google-gemini-3-1-pro-preview',
    'microsoft-mai-thinking-1',
  ],
};

/**
 * The denominator. Pinned for the same reason as the roster: "24 flagged" is a
 * claim about the catalog only if the size of the catalog is fixed beside it.
 * Unlike the roster this figure is sourced rather than editorial, so a refresh
 * that adds a release is expected to move it and to say so in its own commit.
 */
const TOTAL_RELEASES = 117;

/**
 * The one creator holding a single flagged release, and therefore the one the
 * sibling rule below cannot say anything about: a release with no flagged
 * sibling forms no pair, so its rationale is unconstrained by that rule.
 *
 * Pinned rather than left implicit because an unstated hole in an enforcement
 * claim is the same defect #840 was filed about, one level up. Naming the
 * exemption makes it counted, reviewable, and load-bearing: if a second creator
 * ever drops to one flagged release, this goes red and someone decides whether
 * the claim or the data should move.
 */
const CREATORS_EXEMPT_FROM_THE_SIBLING_RULE = ['microsoft'];

function discriminates(rationale: string): boolean {
  const text = rationale.toLowerCase();
  return DISCRIMINATING_REFERENCES.some((reference) => text.includes(reference));
}

function rationaleWords(rationale: string): string[] {
  return rationale
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The transplant test the Fable 5 case already calls decidable, generalised so
 * it applies to every flagged release rather than to one pair by hand.
 *
 * A rationale is *written of* a sibling when every word it uses is a word that
 * sibling's rationale already uses. It then asserts nothing about its own
 * release that the sibling's sentence does not already assert, so transplanting
 * it changes nothing -- which is ADR 0012's "could not be written of another
 * release of the same creator", failing.
 *
 * Strictly stronger than the string equality it replaces, and directional,
 * which is what lets it name the record that must change: Gemini 3.6 Flash's
 * sentence is written of Gemini 3.7 Flash's, while 3.7's says "newest" and is
 * not written of 3.6's. Byte-identical rationales are the symmetric case and
 * fail in both directions.
 */
function isWrittenOf(rationale: string, sibling: string): boolean {
  const words = rationaleWords(rationale);
  // A rationale with no words at all would be vacuously "written of" everything.
  if (words.length === 0) return false;

  const siblingWords = new Set(rationaleWords(sibling));
  return words.every((word) => siblingWords.has(word));
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

  it('reconciles the featured set against its denominator, by identity and not by count', () => {
    // #840 criterion 6. Everything here is asserted as an exact figure or an
    // exact set: a lower bound cannot express "these totals did not change",
    // which is the claim ADR 0012's Costs section now makes in prose and which
    // nothing in this suite could previously check.
    const rosterByStatus = Object.entries(FEATURED_ROSTER);
    const rosterIds = rosterByStatus.flatMap(([, ids]) => ids).sort();

    // Fixture controls, before the dataset is read at all. The roster is
    // hand-maintained, so a duplicated id would inflate its own denominator and
    // a partition that did not sum would make every comparison below ambiguous.
    expect(new Set(rosterIds).size, 'roster holds a duplicate id').toBe(rosterIds.length);
    expect(rosterIds.length).toBe(24);
    expect(FEATURED_ROSTER.current).toHaveLength(18);
    expect(FEATURED_ROSTER.legacy).toHaveLength(4);
    expect(FEATURED_ROSTER.preview).toHaveLength(2);
    expect(
      FEATURED_ROSTER.current.length + FEATURED_ROSTER.legacy.length + FEATURED_ROSTER.preview.length,
    ).toBe(rosterIds.length);

    // The denominator. Asserted first so "24 flagged" below is a share of a
    // known catalog rather than a bare number, and so a release appearing or
    // disappearing is caught even when the featured set is untouched.
    expect(
      rawDataset.releases.length,
      'the release count moved; update TOTAL_RELEASES in the same commit as the data',
    ).toBe(TOTAL_RELEASES);
    // Liveness: a denominator equal to its numerator would make the share
    // meaningless, and would also be the shape a broken read produces.
    expect(TOTAL_RELEASES).toBeGreaterThan(rosterIds.length);

    const flagged = rawDataset.releases.filter(({ featured }) => featured);
    const flaggedIds = flagged.map(({ id }) => id).sort();

    // Identity, not count. This is what a count cannot do: removing one record
    // from the set and adding another leaves every total unchanged, so a
    // size-only check stays green through exactly the change that would break
    // the "no featured flag changes anywhere" invariant #840 turns on.
    expect(flaggedIds, 'the featured set changed membership').toEqual(rosterIds);
    expect(flagged.length).toBe(rosterIds.length);

    // Differential control: set comparison has to be able to come back false,
    // or the equality above proves only that the comparison is blind. A swap --
    // one out, one in -- is the specific mutation that keeps the count at 24.
    const swapped = [...rosterIds.slice(1), 'zzz-not-a-real-release'].sort();
    expect(swapped).toHaveLength(rosterIds.length);
    expect(swapped, 'set comparison cannot distinguish a swap').not.toEqual(rosterIds);

    // The partition covers the set with nothing left over, in both directions:
    // every flagged release lands in exactly one pinned bucket, and no bucket
    // claims a release the catalog does not flag with that status.
    for (const [status, ids] of rosterByStatus) {
      const actual = flagged.filter((r) => r.status === status).map(({ id }) => id).sort();
      expect(actual, `the ${status} share of the featured set changed`).toEqual([...ids].sort());
    }

    const classified = new Set(rosterByStatus.flatMap(([, ids]) => ids));
    const unclassified = flagged.filter(({ id }) => !classified.has(id));
    expect(unclassified.map(({ id }) => id), 'a flagged release holds a status the roster does not partition').toEqual([]);

    // The sibling rule below forms no pair for a creator holding one flagged
    // release, so its enforcement is not universal and the exemption is named
    // rather than left for a reader to discover. #840's own defect was an
    // enforcement claim wider than the enforcement.
    const flaggedPerCreator = new Map<string, number>();
    for (const release of flagged) {
      flaggedPerCreator.set(
        release.organizationId,
        (flaggedPerCreator.get(release.organizationId) ?? 0) + 1,
      );
    }
    const exempt = [...flaggedPerCreator.entries()]
      .filter(([, count]) => count === 1)
      .map(([creatorId]) => creatorId)
      .sort();
    expect(exempt, 'the set of creators the sibling rule cannot reach changed').toEqual(
      [...CREATORS_EXEMPT_FROM_THE_SIBLING_RULE].sort(),
    );
    // Control on that reading: the exemption is meaningful only while some
    // creator does form pairs. If every creator held one flagged release the
    // sibling rule would be universally vacuous and this test would say so.
    expect([...flaggedPerCreator.values()].some((count) => count > 1)).toBe(true);
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
    // ADR 0012's *durability* clause, and deliberately still scoped to `legacy`
    // after #840 widened the discrimination clause beside it. The reference list
    // this reads is half lifecycle vocabulary, which a release that is still
    // current cannot honestly use about itself, so widening this particular
    // check would demand edits to six records that already discriminate. The
    // status-independent rule is the sibling test below.
    //
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

  it('gives no flagged release a rationale that is written of a sibling, whatever its status', () => {
    // Instrument controls, both directions, before any record is read. #840
    // requires one that fires on a generic `current` rationale.
    //
    // Not `isWrittenOf(X, X)`: that holds of any non-empty string by the shape
    // of the predicate, so it restates the implementation instead of testing
    // it. The two cases below are the ones that carry information, and both are
    // drawn from the defect this issue was filed about. First, strict
    // containment between two *distinct* sentences -- the generic one the
    // GPT-5.6 pair shared, against a sentence that says everything it says and
    // more. Equality would call these different and let the pair stand.
    expect(SHARED_GPT_5_6_RATIONALE).not.toBe(GENERIC_RATIONALE_SUPERSET);
    expect(isWrittenOf(SHARED_GPT_5_6_RATIONALE, GENERIC_RATIONALE_SUPERSET)).toBe(true);
    // The case equality could not reach: not byte-identical, still written of it.
    expect(SUBSUMED_GEMINI_3_6_RATIONALE).not.toBe(SUBSUMING_GEMINI_3_7_RATIONALE);
    expect(isWrittenOf(SUBSUMED_GEMINI_3_6_RATIONALE, SUBSUMING_GEMINI_3_7_RATIONALE)).toBe(true);
    // Directional, so it names the one record that must change rather than both
    // halves of a pair. Without this the check would demand an edit to a
    // rationale that is doing its job.
    expect(isWrittenOf(SUBSUMING_GEMINI_3_7_RATIONALE, SUBSUMED_GEMINI_3_6_RATIONALE)).toBe(false);
    // And it must come back false on a sentence that genuinely says something
    // else, or every record below would pass for the wrong reason.
    expect(isWrittenOf(SUPERSEDED_FABLE_5_RATIONALE, SHARED_GPT_5_6_RATIONALE)).toBe(false);

    const flagged = rawDataset.releases.filter(({ featured }) => featured);
    const byCreator = new Map<string, typeof flagged>();
    for (const release of flagged) {
      byCreator.set(release.organizationId, [
        ...(byCreator.get(release.organizationId) ?? []),
        release,
      ]);
    }

    // Widening control: the rule is enforced regardless of `status`, so the
    // class it reaches must actually hold more than one status. If the catalog
    // ever flagged only `current` releases, "regardless of status" would be
    // true and vacuous, and this assertion is what would say so.
    expect(new Set(flagged.map(({ status }) => status)).size).toBeGreaterThan(1);

    let compared = 0;
    for (const [creatorId, releases] of byCreator) {
      for (const a of releases) {
        for (const b of releases) {
          if (a.id === b.id) continue;
          compared += 1;

          // No launch-date exemption. #840: a shared announcement date is a
          // fact about the launch, not a licence for one sentence to stand in
          // for three. The three GPT-4.1 seeds shared one rationale on exactly
          // that reasoning, and it identified none of them.
          expect(
            isWrittenOf(a.featuredRationale!, b.featuredRationale!),
            `${creatorId}: ${a.id}'s rationale is written of ${b.id}`,
          ).toBe(false);
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
