import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { dataset } from './dataset';
import { familySchema, releaseSchema } from './schema';

const { families, releases, sources } = dataset;

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const schemaSource = read('./schema.ts');
const readme = read('../../README.md');
const adr = read('../../../docs/adr/0009-a-platform-api-record-is-corroborating-metadata.md');

/**
 * `dateBasis` records that a committed date is a hosting platform's measurement
 * rather than a creator's statement (issue #682, ADR 0009). Two things make it
 * worth anything, and neither is enforced by the Zod schema:
 *
 *  1. the marker names the artefact it rests on, rather than asserting a mood --
 *     a record that says "platform-repository-created" while citing no platform
 *     record is unfalsifiable; and
 *  2. every surface that explains the field says plainly that its **absence
 *     asserts nothing**. A field silently meaning "verified" when missing would
 *     rebuild the exact defect #682 closes, one level up.
 *
 * These are the two the gates cannot check, so they are checked here.
 */
describe('dateBasis marks a platform-observed date', () => {
  const PLATFORM = 'platform-repository-created';

  // Pinned rather than derived. Deriving the expected set from the data would
  // make this test agree with whatever the data says, which is not a check.
  //
  // A pin has its own failure mode, and #682's QA found it: a set pinned to an
  // incomplete answer asserts the omission is correct, so the later fix has to
  // edit a test that claims it is already right. The pin is therefore paired
  // with `covers every record whose own sources say the date rests on the
  // platform` below, which derives the *candidate* set from committed prose and
  // fails when this list is short. Pin and derivation check each other.
  const EXPECTED_RELEASES = [
    'apple-openelm-3b-instruct',
    'baidu-ernie-4-5-300b-a47b',
    'deepseek-v3-2',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'moonshot-ai-kimi-k2-instruct',
    'sarvam-ai-sarvam-m-v1',
  ];
  const EXPECTED_FAMILIES = [
    'apple-openelm',
    'baidu-ernie-4-5',
    'deepseek-v3-2',
    'deepseek-v4',
    'moonshot-ai-kimi-k2',
    'sarvam-ai-sarvam-m',
  ];

  it('is carried by exactly the releases and families established to hold one', () => {
    expect(releases.filter((r) => r.dateBasis !== undefined).map((r) => r.id).sort())
      .toEqual(EXPECTED_RELEASES);
    expect(families.filter((f) => f.dateBasis !== undefined).map((f) => f.id).sort())
      .toEqual(EXPECTED_FAMILIES);
  });

  // The composed dataset is what the site renders, and an optional key that the
  // schema did not know about would be stripped there while surviving in the
  // JSON -- passing every gate and reaching no reader. Assert on the composed
  // value, not on the file.
  it('survives composition rather than being stripped as an unknown key', () => {
    for (const id of EXPECTED_RELEASES) {
      expect(`${id}: ${releases.find((r) => r.id === id)?.dateBasis}`).toBe(`${id}: ${PLATFORM}`);
    }
    for (const id of EXPECTED_FAMILIES) {
      expect(`${id}: ${families.find((f) => f.id === id)?.dateBasis}`).toBe(`${id}: ${PLATFORM}`);
    }
  });

  // A fabricated id, so a run that matched nothing is distinguishable from one
  // that genuinely passed. Without it, an empty `releases` would satisfy every
  // "every release ..." assertion below vacuously.
  it('finds no marker on a record that does not exist', () => {
    expect(releases.some((r) => r.id === 'fabricated-control-release')).toBe(false);
    expect(releases.length).toBeGreaterThan(80);
    expect(families.length).toBeGreaterThan(40);
  });

  it('cites a platform record wherever it claims a platform basis', () => {
    const repositoryIds = new Set(
      sources.filter((s) => s.type === 'repository').map((s) => s.id),
    );
    expect(repositoryIds.size).toBeGreaterThan(0);

    const uncited = releases
      .filter((r) => r.dateBasis === PLATFORM)
      .filter((r) => !r.sourceIds.some((id) => repositoryIds.has(id)))
      .map((r) => r.id);
    expect(uncited).toEqual([]);

    const uncitedFamilies = families
      .filter((f) => f.dateBasis === PLATFORM)
      .filter((f) => !f.sourceIds.some((id) => repositoryIds.has(id)))
      .map((f) => f.id);
    expect(uncitedFamilies).toEqual([]);
  });

  // A family's `firstReleaseDate` is copied from one of its releases. If that
  // release's date is platform-observed then the family's is the same fact, and
  // marking one while leaving the other bare would publish the same timestamp
  // twice with two different provenances.
  it('agrees between a family and the release supplying its first date', () => {
    const disagreements: string[] = [];
    for (const family of families) {
      const supplying = releases.filter(
        (r) => r.familyId === family.id
          && r.releaseDate === family.firstReleaseDate
          && r.datePrecision === family.datePrecision,
      );
      if (supplying.length === 0) continue;
      const allMarked = supplying.every((r) => r.dateBasis === PLATFORM);
      const noneMarked = supplying.every((r) => r.dateBasis === undefined);
      if (allMarked && family.dateBasis !== PLATFORM) {
        disagreements.push(`${family.id}: releases are ${PLATFORM}, family records ${family.dateBasis}`);
      }
      if (noneMarked && family.dateBasis !== undefined) {
        disagreements.push(`${family.id}: no release is marked, family records ${family.dateBasis}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('accepts the one value and refuses any other, on both schemas', () => {
    const release = releases.find((r) => r.id === 'moonshot-ai-kimi-k2-instruct');
    const family = families.find((f) => f.id === 'moonshot-ai-kimi-k2');
    expect(releaseSchema.safeParse({ ...release, dateBasis: PLATFORM }).success).toBe(true);
    expect(familySchema.safeParse({ ...family, dateBasis: PLATFORM }).success).toBe(true);

    // Optional means optional: removing it must still parse, or the 90 records
    // that assert nothing could not exist.
    const { dateBasis: _dropped, ...bare } = release ?? {};
    expect(releaseSchema.safeParse(bare).success).toBe(true);

    // `creator-stated` is the value this schema deliberately does not have.
    for (const bad of ['creator-stated', 'platform-repository-created ', 'unknown', '']) {
      expect(`${JSON.stringify(bad)}: ${releaseSchema.safeParse({ ...release, dateBasis: bad }).success}`)
        .toBe(`${JSON.stringify(bad)}: false`);
    }
  });

  // ADR 0009's guardrail, as a check rather than a hope. Each surface that
  // explains the field must carry the disclaimer; a rewrite that drops it fails
  // here rather than shipping a field whose silence reads as verification.
  it('states on every surface that absence asserts nothing', () => {
    const surfaces = [
      ['schema', schemaSource],
      ['README', readme],
      ['ADR 0009', adr],
    ] as const;
    for (const [name, text] of surfaces) {
      expect(`${name}: ${/absence[^.]{0,60}asserts nothing|absence[^.]{0,60}not an assertion/i.test(text)}`)
        .toBe(`${name}: true`);
      expect(`${name}: ${text.includes('dateBasis')}`).toBe(`${name}: true`);
    }
  });

  // The enum has one member on purpose. A second member added without revisiting
  // the reasoning above should stop here and read it.
  it('offers no value that would let a bare record read as verified', () => {
    expect(schemaSource).toContain("z.enum(['platform-repository-created'])");
    expect(schemaSource).not.toContain("'creator-stated'");
  });

  // The member is named for what the Hub field records -- repository creation --
  // and not for publication. `createdAt` matches the repository's own oldest
  // commit and a repository can be created private, so it attests no visibility
  // event. Naming it `platform-first-published` would assert one, which is the
  // overstatement this whole field exists to prevent, one step smaller.
  //
  // The rejected spelling is named in prose on every surface, deliberately, so
  // this asserts on the value in use rather than on the word appearing: a test
  // banning the string would forbid the explanation of why it was rejected.
  it('names the member for repository creation rather than publication', () => {
    expect(schemaSource).not.toContain("z.enum(['platform-first-published'])");
    expect(readme).not.toContain('"value":"platform-first-published"');
    for (const record of [...releases, ...families]) {
      expect(`${record.id}: ${record.dateBasis ?? PLATFORM}`).toBe(`${record.id}: ${PLATFORM}`);
    }
  });

  /**
   * The failure this test exists for is the one QA found on the first attempt at
   * #682: two releases whose committed source notes already concluded the date
   * rests on the Hub, left unmarked, with the pinned set above quietly asserting
   * that was correct.
   *
   * So derive the candidates from the prose instead of from memory. Any release
   * one of whose own cited sources says its date rests on the platform record is
   * a record whose basis someone has already established in writing, and item 3
   * of ADR 0009 says the data must then say so too.
   *
   * This is deliberately a floor and not a ceiling: it finds records whose prose
   * states the conclusion, and cannot find one whose basis is real but was never
   * written down. It rules out the regression, not the whole class.
   *
   * Two derivations, because the first attempt only read source notes and the
   * three DeepSeek releases had stated their basis in their own `summary`
   * instead -- a second hiding place, found only by re-reading. A record states
   * this conclusion wherever its author happened to be writing at the time, so
   * both places are read.
   */
  it('covers every record whose own sources say the date rests on the platform', () => {
    const ESTABLISHING = [
      "rests on the Hub's measurement",
      'rests on the Hub record',
      'release date comes from the Hub',
      "date rests on the Hub's",
    ];
    const establishing = new Set(
      sources
        .filter((s) => ESTABLISHING.some((phrase) => (s.notes ?? '').includes(phrase)))
        .map((s) => s.id),
    );
    // Control: the phrases must actually match something, or every assertion
    // below passes by finding nothing.
    expect(establishing.size).toBeGreaterThan(0);

    const unmarked = releases
      .filter((r) => r.sourceIds.some((id) => establishing.has(id)))
      .filter((r) => r.dateBasis === undefined)
      .map((r) => r.id);
    expect(unmarked).toEqual([]);

    // Second derivation: the record's own summary. Matched without the
    // apostrophe, which is typographic in the committed text and would make the
    // phrase brittle for a reason that has nothing to do with the claim.
    const SELF_DECLARING = [
      'the day the repository was published',
      'the day the repository was created',
    ];
    const selfDeclaring = releases.filter((r) =>
      SELF_DECLARING.some((phrase) => (r.summary ?? '').includes(phrase)),
    );
    expect(selfDeclaring.length).toBeGreaterThan(0);
    expect(selfDeclaring.filter((r) => r.dateBasis === undefined).map((r) => r.id)).toEqual([]);
  });

  /**
   * ADR 0009's guardrail forbids text stating that a *missing* `dateBasis` means
   * a date is creator-stated. The disclaimer check above catches that text being
   * deleted; it does not catch it being contradicted, and QA demonstrated the
   * gap by adding "the other releases carry no dateBasis, which is how you can
   * tell their dates are creator-stated" and watching every test still pass.
   *
   * These patterns are a bounded set of the inversion, not a general
   * contradiction detector -- prose can always say it another way. The guardrail
   * stays broader than its enforcement, and this narrows the gap rather than
   * closing it.
   */
  it('carries no text reading a missing marker as verification', () => {
    const INVERSIONS = [
      /(?:carry|carries|have|has|with|lack|lacks|lacking) no [`']?dateBasis[`']?[^.]{0,140}?(?:creator[- ]stated|creator's statement|creator stated|verified)/i,
      /(?:absence|missing|unmarked|bare|without)[^.]{0,140}?(?:means|implies|indicates|shows|tells you|how you can tell)[^.]{0,140}?(?:creator[- ]stated|creator's statement|verified)/i,
      /no [`']?dateBasis[`']?[^.]{0,140}?(?:therefore|so)[^.]{0,140}?creator/i,
    ];

    // A document that forbids an assertion has to quote it, and a document that
    // states this field's limitation has to name the reading it rules out. Both
    // look exactly like the violation to a regex. So test per sentence, and skip
    // sentences that are denying or prohibiting rather than asserting -- that is
    // what every legitimate occurrence in these three files is doing.
    const EXEMPT = [
      'may state or imply',
      'must not',
      'may never',
      'forbid',
      'cannot',
      'does not mean',
      'is not thereby',
      'asserts nothing',
      'not an assertion',
      'would assert',
      'deliberately does not',
      'is a regression',
    ];
    const offending = (text: string): string[] =>
      text
        .split(/(?<=[.:])\s+/)
        .filter((sentence) => !EXEMPT.some((marker) => sentence.toLowerCase().includes(marker)))
        .filter((sentence) => INVERSIONS.some((pattern) => pattern.test(sentence)));

    for (const [name, text] of [
      ['schema', schemaSource],
      ['README', readme],
      ['ADR 0009', adr],
    ] as const) {
      expect(`${name}: ${JSON.stringify(offending(text))}`).toBe(`${name}: []`);
    }

    // Controls. The first two are the inversion in the two shapes it actually
    // takes; without them "[]" above would be satisfied by patterns that match
    // nothing. The third is the sentence the exemption exists for, and asserting
    // it stays clean is what stops the exemption being widened into a hole.
    for (const planted of [
      'The other 88 releases carry no dateBasis, which is how you can tell their dates are creator-stated.',
      'The absence of the marker means the date is creator-stated.',
    ]) {
      expect(`${planted.slice(0, 30)}: ${offending(planted).length}`)
        .toBe(`${planted.slice(0, 30)}: 1`);
    }
    expect(
      offending('No gate message may state or imply that a missing dateBasis means a date is creator-stated.'),
    ).toEqual([]);
  });
});
