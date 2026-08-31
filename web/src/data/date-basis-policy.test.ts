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
 *     a record that says "platform-first-published" while citing no platform
 *     record is unfalsifiable; and
 *  2. every surface that explains the field says plainly that its **absence
 *     asserts nothing**. A field silently meaning "verified" when missing would
 *     rebuild the exact defect #682 closes, one level up.
 *
 * These are the two the gates cannot check, so they are checked here.
 */
describe('dateBasis marks a platform-observed date', () => {
  const PLATFORM = 'platform-first-published';

  // Pinned rather than derived. Deriving the expected set from the data would
  // make this test agree with whatever the data says, which is not a check.
  const EXPECTED_RELEASES = ['baidu-ernie-4-5-300b-a47b', 'moonshot-ai-kimi-k2-instruct'];
  const EXPECTED_FAMILIES = ['baidu-ernie-4-5', 'moonshot-ai-kimi-k2'];

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
    for (const bad of ['creator-stated', 'platform-first-published ', 'unknown', '']) {
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
    expect(schemaSource).toContain("z.enum(['platform-first-published'])");
    expect(schemaSource).not.toContain("'creator-stated'");
  });
});
