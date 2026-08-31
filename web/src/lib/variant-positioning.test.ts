import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { variantPositioning } from '../data/variant-positioning';
import type { VariantPositioning } from '../data/variant-positioning-schema';
import {
  buildFamilyVariantPositioning,
  buildVariantPositioningIndex,
  variantPositioningCoverageLine,
} from './variant-positioning';
import {
  ABSENT_FAMILY_ID,
  COMPLETE_FAMILY_ID,
  PARTIAL_FAMILY_ID,
  REPEATED_NAME_FAMILY_ID,
  RIVAL_FAMILY_NAME,
  RIVAL_ORGANIZATION_NAME,
  SECOND_FIXTURE_SOURCE,
  SHORTENED_ORGANIZATION_ALIAS,
  SHORTENED_ORGANIZATION_NAME,
  TWO_SOURCE_VARIANT,
  positioningFixtureDataset,
  positioningFixtureRecords,
  positioningFixtureRecordsWithTwoSources,
} from '../../tests/fixtures/variant-positioning-dataset';

/**
 * Reading positioning records against a catalog.
 *
 * The fixture assertions pin the three coverage states, because the real catalog
 * holds whichever of them the sources support today. The real-data assertions
 * then sweep the committed document, so a record that points at a family or a
 * variant the catalog does not have fails here rather than at build time on a
 * page nobody opened.
 */

function fixtureFamily(id: string) {
  const family = positioningFixtureDataset.families.find((candidate) => candidate.id === id);
  if (!family) throw new Error(`fixture family ${id} is missing`);
  return family;
}

function fixtureReleases(familyId: string) {
  return positioningFixtureDataset.releases.filter((release) => release.familyId === familyId);
}

function buildFixture(familyId: string, records: VariantPositioning = positioningFixtureRecords) {
  const index = buildVariantPositioningIndex(positioningFixtureDataset, records);
  return buildFamilyVariantPositioning(fixtureFamily(familyId), fixtureReleases(familyId), index);
}

describe('a family whose variants are all positioned', () => {
  it('reads as complete', () => {
    const view = buildFixture(COMPLETE_FAMILY_ID);

    expect(view.coverage).toBe('complete');
    expect(view.unpositioned).toEqual([]);
    expect(view.positionedVariantCount).toBe(2);
    expect(view.variantCount).toBe(2);
  });

  it('orders variants by first release rather than by the order they were written down', () => {
    const view = buildFixture(COMPLETE_FAMILY_ID);

    // The record lists Quick first; Wide shipped first.
    expect(view.positioned.map(({ variant }) => variant)).toEqual(['Wide', 'Quick']);
  });

  it('gives every release a line carrying the creator, the quote and the variant name', () => {
    const view = buildFixture(COMPLETE_FAMILY_ID);
    const line = view.lineByReleaseId.get('fixture-tiers-one-wide');

    expect(line).toEqual({
      recorded: true,
      variant: 'Wide',
      sources: [{ publisher: 'Tier Foundry', quote: 'Built for broad context work' }],
    });
  });

  it('says so in words', () => {
    expect(variantPositioningCoverageLine(buildFixture(COMPLETE_FAMILY_ID)))
      .toBe('Creator positioning is recorded for all 2 variant names in Tier One.');
  });
});

/**
 * A variant cited to more than one page.
 *
 * `sources` is `min(1)` and unbounded, so this has always been a legal record;
 * the line built for it used to carry the first source and drop the rest, which
 * meant a page could be cited, pass every gate, and never reach a reader. The
 * failure was silent in the one place this repository can least afford silence,
 * because the evidence trail went shorter than the evidence.
 */
describe('a variant whose positioning rests on several pages', () => {
  const view = buildFixture(COMPLETE_FAMILY_ID, positioningFixtureRecordsWithTwoSources);

  it('carries every cited page on the line, not just the first', () => {
    const line = view.lineByReleaseId.get('fixture-tiers-one-wide');

    expect(line).toEqual({
      recorded: true,
      variant: TWO_SOURCE_VARIANT,
      sources: [
        { publisher: 'Tier Foundry', quote: 'Built for broad context work' },
        { publisher: SECOND_FIXTURE_SOURCE.publisher, quote: SECOND_FIXTURE_SOURCE.quote },
      ],
    });
  });

  it('keeps the full record reachable, so nothing rests on the line alone', () => {
    const wide = view.positioned.find(({ variant }) => variant === TWO_SOURCE_VARIANT);

    expect(wide?.official.sources.map(({ url }) => url)).toEqual([
      'https://fixture.invalid/positioning/docs',
      SECOND_FIXTURE_SOURCE.url,
    ]);
  });

  it('leaves a single-source variant in the same family carrying exactly one', () => {
    // The count is read from the record rather than assumed, so a renderer
    // cannot start showing a second page where the data has only one.
    expect(view.lineByReleaseId.get('fixture-tiers-one-quick'))
      .toMatchObject({ recorded: true, sources: [{ quote: 'Built for short turnarounds' }] });
  });
});

describe('a family whose variants are only partly positioned', () => {
  it('reads as partial rather than as complete or absent', () => {
    const view = buildFixture(PARTIAL_FAMILY_ID);

    expect(view.coverage).toBe('partial');
    expect(view.positioned.map(({ variant }) => variant)).toEqual(['Wide', 'Quiet']);
    expect(view.unpositioned.map(({ variant }) => variant)).toEqual(['Dark']);
  });

  it('marks the uncovered release as unrecorded and offers no substitute', () => {
    const view = buildFixture(PARTIAL_FAMILY_ID);

    expect(view.lineByReleaseId.get('fixture-tiers-two-dark')).toEqual({
      recorded: false,
      variant: 'Dark',
    });
  });

  it('reaches every release carrying a positioned variant name', () => {
    const view = buildFixture(PARTIAL_FAMILY_ID);
    const quiet = view.positioned.find(({ variant }) => variant === 'Quiet');

    expect(quiet?.releases.map(({ id }) => id))
      .toEqual(['fixture-tiers-two-quiet-one', 'fixture-tiers-two-quiet-two']);
    expect(view.lineByReleaseId.get('fixture-tiers-two-quiet-two')).toMatchObject({ recorded: true });
  });

  it('counts what is recorded out of what is in use', () => {
    expect(variantPositioningCoverageLine(buildFixture(PARTIAL_FAMILY_ID)))
      .toBe('Creator positioning is recorded for 2 of the 3 variant names in Tier Two; the rest are marked as not recorded.');
  });
});

describe('a family with no positioning record', () => {
  it('reads as absent, with the variant names still available', () => {
    const view = buildFixture(ABSENT_FAMILY_ID);

    expect(view.coverage).toBe('absent');
    expect(view.positioned).toEqual([]);
    expect(view.unpositioned.map(({ variant }) => variant)).toEqual(['Wide', 'Quick']);
    expect(view.note).toBeUndefined();
    expect(view.verifiedAt).toBeUndefined();
  });

  it('marks every release unrecorded', () => {
    const view = buildFixture(ABSENT_FAMILY_ID);

    for (const release of fixtureReleases(ABSENT_FAMILY_ID)) {
      expect(view.lineByReleaseId.get(release.id)).toEqual({ recorded: false, variant: release.variant });
    }
  });

  it('says nothing is recorded rather than falling silent', () => {
    expect(variantPositioningCoverageLine(buildFixture(ABSENT_FAMILY_ID)))
      .toBe('No creator statement of what these 2 variant names mean is recorded for Tier Three.');
  });
});

describe('the same variant name in two generations', () => {
  it('keeps the two readings apart', () => {
    const earlier = buildFixture(COMPLETE_FAMILY_ID).positioned.find(({ variant }) => variant === 'Wide');
    const later = buildFixture(REPEATED_NAME_FAMILY_ID).positioned.find(({ variant }) => variant === 'Wide');

    expect(earlier?.official.sources[0].quote).toBe('Built for broad context work');
    expect(later?.official.sources[0].quote).toBe('Built for multi-step agent runs');
    expect(earlier?.editorial.summary).not.toBe(later?.editorial.summary);
  });
});

describe('guards that fail the build', () => {
  function withFirstRecord(changes: Record<string, unknown>): VariantPositioning {
    const [first, ...rest] = positioningFixtureRecords;
    return [{ ...first, ...changes } as typeof first, ...rest];
  }

  it('refuses a record that positions a variant no release uses', () => {
    const records = withFirstRecord({
      variants: [{ ...positioningFixtureRecords[0].variants[0], variant: 'Nonexistent' }],
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records))
      .toThrow(/which no release of .* uses/);
  });

  it('refuses a record pointing at a family the catalog does not have', () => {
    const records = withFirstRecord({ familyId: 'fixture-not-a-family' });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records))
      .toThrow(/unknown family/);
  });

  /**
   * The non-goal of issue #38, enforced rather than reviewed for. The sentence
   * below is the natural one to write and the one that must never ship.
   */
  it('refuses an editorial summary that positions this creator against another', () => {
    const [entry] = positioningFixtureRecords[0].variants;
    const records = withFirstRecord({
      variants: [{
        ...entry,
        editorial: {
          ...entry.editorial,
          summary: `This name sits roughly where ${RIVAL_ORGANIZATION_NAME} places its own comparable name.`,
        },
      }],
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records))
      .toThrow(/names creator "Rival Laboratories"/);
  });

  it("refuses a family note that names another creator's family", () => {
    const records = withFirstRecord({
      note: `These names are read the same way the ${RIVAL_FAMILY_NAME} names are read.`,
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records))
      .toThrow(/names another creator's family/);
  });

  /**
   * The gap issue #648 was filed on. A creator's colloquial short form — "Google"
   * for "Google DeepMind" — is registered as neither `name` nor `shortName`, so a
   * guard matching only those two forms lets it through. The positive control
   * that predates the fix is the full registered name below: the guard caught
   * that all along. The two tests after it inject the short form alone, at both
   * prose sites the issue names — `editorial.summary` and a record-level `note` —
   * and pass only because the widened guard now reads the organization's
   * registered `aliases`. Weaken the guard by dropping the alias branch in
   * `assertStaysWithinCreator` and both go red while the control above stays
   * green, which is what distinguishes the fix from the pre-existing behaviour.
   */
  it('catches the full registered name of the shortened-form creator (control that predates the fix)', () => {
    const [entry] = positioningFixtureRecords[0].variants;
    const records = withFirstRecord({
      variants: [{
        ...entry,
        editorial: {
          ...entry.editorial,
          summary: `This name is framed the way ${SHORTENED_ORGANIZATION_NAME} frames its own comparable name.`,
        },
      }],
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records))
      .toThrow(new RegExp(`names creator "${SHORTENED_ORGANIZATION_NAME}"`));
  });

  it('refuses an editorial summary that names a creator by its shortened form alone', () => {
    const [entry] = positioningFixtureRecords[0].variants;
    const records = withFirstRecord({
      variants: [{
        ...entry,
        editorial: {
          ...entry.editorial,
          summary: `This name sits roughly where ${SHORTENED_ORGANIZATION_ALIAS} places its own comparable name.`,
        },
      }],
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records))
      .toThrow(new RegExp(`names creator "${SHORTENED_ORGANIZATION_ALIAS}"`));
  });

  it('refuses a record-level note that names a creator by its shortened form alone', () => {
    const records = withFirstRecord({
      note: `These names are read much as ${SHORTENED_ORGANIZATION_ALIAS} reads its own.`,
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records))
      .toThrow(new RegExp(`names creator "${SHORTENED_ORGANIZATION_ALIAS}"`));
  });

  it('allows a sibling generation from the same creator, which is the point of generation scoping', () => {
    const records = withFirstRecord({
      note: 'These names are scoped to this family; Tier Four reuses one of them for different work.',
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records)).not.toThrow();
  });

  it('does not mistake a creator name inside a longer word for a mention of that creator', () => {
    const records = withFirstRecord({
      note: 'These names describe the work each one is aimed at, with no rivalry implied by the ordering.',
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records)).not.toThrow();
  });

  it('does not mistake a registered short form buried in a longer word for a mention', () => {
    // The alias branch matches on word boundaries, like the name branch, so a
    // short form registered as "Vega" is a mention of that creator only as a
    // whole word — "Vegas" and "vegan" carry it as a fragment and must not trip.
    const records = withFirstRecord({
      note: `These names read the same in ${SHORTENED_ORGANIZATION_ALIAS}s and to a vegan audience alike.`,
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records)).not.toThrow();
  });

  it('leaves creator quotes out of the cross-creator check, because they are reported not asserted', () => {
    const [entry] = positioningFixtureRecords[0].variants;
    const records = withFirstRecord({
      variants: [{
        ...entry,
        official: {
          ...entry.official,
          sources: [{ ...entry.official.sources[0], quote: `Faster than ${RIVAL_ORGANIZATION_NAME} models` }],
        },
      }],
    });

    expect(() => buildVariantPositioningIndex(positioningFixtureDataset, records)).not.toThrow();
  });
});

describe('the committed records against the reviewed catalog', () => {
  const index = buildVariantPositioningIndex(dataset, variantPositioning);

  it('validates every committed record against the catalog it describes', () => {
    expect(index.size).toBe(variantPositioning.length);
  });

  it('records only variants the catalog actually uses', () => {
    for (const record of variantPositioning) {
      const inUse = new Set(
        dataset.releases.filter((release) => release.familyId === record.familyId).map(({ variant }) => variant),
      );
      for (const entry of record.variants) expect(inUse).toContain(entry.variant);
    }
  });

  /**
   * Absence is the commonest state in this catalog and the one the feature most
   * has to handle honestly, so its presence is asserted rather than assumed.
   */
  it('leaves families with sibling variants and no documented ladder explicitly absent', () => {
    const absent = dataset.families
      .map((family) => buildFamilyVariantPositioning(
        family,
        dataset.releases.filter((release) => release.familyId === family.id),
        index,
      ))
      .filter((view) => view.coverage === 'absent' && view.variantCount > 1);

    expect(absent.length).toBeGreaterThan(0);
  });

  it('produces at least one fully positioned family', () => {
    const complete = dataset.families
      .map((family) => buildFamilyVariantPositioning(
        family,
        dataset.releases.filter((release) => release.familyId === family.id),
        index,
      ))
      .filter((view) => view.coverage === 'complete');

    expect(complete.length).toBeGreaterThan(0);
  });

  it('never lets a family read as complete while a variant in it is unpositioned', () => {
    for (const family of dataset.families) {
      const view = buildFamilyVariantPositioning(
        family,
        dataset.releases.filter((release) => release.familyId === family.id),
        index,
      );
      if (view.coverage !== 'complete') continue;
      expect(view.unpositioned).toEqual([]);
      expect(view.positionedVariantCount).toBe(view.variantCount);
    }
  });

  it('gives every release of every family exactly one line', () => {
    for (const family of dataset.families) {
      const releases = dataset.releases.filter((release) => release.familyId === family.id);
      const view = buildFamilyVariantPositioning(family, releases, index);

      expect(view.lineByReleaseId.size).toBe(releases.length);
    }
  });
});
