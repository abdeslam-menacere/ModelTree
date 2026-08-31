import { precisionOf } from '../../src/data/partial-date';
import type { Dataset, ModelFamily, ModelRelease, Organization } from '../../src/data/schema';
import { validateDataset } from '../../src/data/validate';
import type { VariantPositioning } from '../../src/data/variant-positioning-schema';

/**
 * Test-only scaffolding for variant positioning, deliberately outside `src/` so
 * no page or component can reach it and no fabricated provenance sits in the site
 * source graph. Every record here is synthetic and asserts nothing about any real
 * creator or model.
 *
 * The reviewed catalog cannot be the source of these shapes. Which families have
 * documented variant positioning is whatever the sources happen to support on a
 * given day, so a test that reached for "the partial family" in real data would
 * be testing today's dataset rather than the transformation, and would go quiet —
 * not red, quiet — the first time a creator published a page that filled the gap.
 * These fixtures guarantee the shapes exist; `variant-positioning.test.ts`
 * separately sweeps whatever the catalog actually holds.
 *
 * Shapes pinned here:
 *
 * - complete: every variant the family's releases use is positioned
 * - partial: one variant in use is positioned by nothing
 * - absent: a family with sibling variants and no record at all
 * - repeated name: a later family of the same creator reusing a variant name from
 *   an earlier one, positioned differently, because tier semantics belong to a
 *   family and generation rather than to a name
 * - multi-release variant: one variant name carried by several releases
 * - rival creator: a second creator, so the cross-creator guard has something to
 *   catch
 */

const SOURCE_ID = 'fixture-positioning-announcement';
const VERIFIED_AT = '2026-08-01';

const publisher = {
  id: 'fixture-positioning-publisher',
  name: 'Synthetic Positioning Fixture Publisher',
};

const source = {
  id: SOURCE_ID,
  url: 'https://fixture.invalid/positioning/announcement',
  title: 'Synthetic fixture record for variant positioning shapes',
  type: 'official-announcement' as const,
  publisherId: publisher.id,
  publishedDate: '2025-01-01',
  lastCheckedDate: VERIFIED_AT,
};

function organization(id: string, name: string, shortName: string): Organization {
  return {
    id,
    slug: id,
    name,
    shortName,
    type: 'research-lab',
    website: `https://fixture.invalid/${id}/`,
    releasePage: `https://fixture.invalid/${id}/releases/`,
    description: `Synthetic creator ${id} used only to exercise variant positioning.`,
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

function family(id: string, organizationId: string, name: string, firstReleaseDate: string): ModelFamily {
  return {
    id,
    slug: id,
    organizationId,
    name,
    description: `Synthetic family ${id} used only to exercise variant positioning.`,
    categories: ['language-reasoning'],
    firstReleaseDate,
    datePrecision: precisionOf(firstReleaseDate),
    status: 'current',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

function release(
  id: string,
  organizationId: string,
  familyId: string,
  displayName: string,
  releaseDate: string,
  variant: string,
): ModelRelease {
  return {
    id,
    slug: id,
    canonicalName: displayName,
    displayName,
    organizationId,
    familyId,
    version: '1',
    variant,
    releaseDate,
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: `Synthetic release ${id} used only to exercise variant positioning.`,
    intendedUse: 'Fixture data. Not a claim about any real model.',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

export const COMPLETE_FAMILY_ID = 'fixture-tiers-one';
export const PARTIAL_FAMILY_ID = 'fixture-tiers-two';
export const ABSENT_FAMILY_ID = 'fixture-tiers-three';
export const REPEATED_NAME_FAMILY_ID = 'fixture-tiers-four';
export const RIVAL_FAMILY_ID = 'fixture-rival-one';

export const RIVAL_ORGANIZATION_NAME = 'Rival Laboratories';
/**
 * Deliberately shares no word with its creator's name or short name, so that a
 * test asserting the family-name branch of the guard cannot pass by tripping the
 * creator-name branch instead.
 */
export const RIVAL_FAMILY_NAME = 'Ensemble Nine';

const organizations: Organization[] = [
  organization('fixture-tiers', 'Tier Foundry', 'Tier'),
  organization('fixture-rival', RIVAL_ORGANIZATION_NAME, 'Rival'),
];

const families: ModelFamily[] = [
  family(COMPLETE_FAMILY_ID, 'fixture-tiers', 'Tier One', '2025-01-01'),
  family(PARTIAL_FAMILY_ID, 'fixture-tiers', 'Tier Two', '2025-01-01'),
  family(ABSENT_FAMILY_ID, 'fixture-tiers', 'Tier Three', '2025-01-01'),
  family(REPEATED_NAME_FAMILY_ID, 'fixture-tiers', 'Tier Four', '2026-01-01'),
  family(RIVAL_FAMILY_ID, 'fixture-rival', RIVAL_FAMILY_NAME, '2025-01-01'),
];

const releases: ModelRelease[] = [
  // Complete: both variants in use are positioned. "Wide" is released first, so
  // it must order first regardless of how the record lists the variants.
  release('fixture-tiers-one-wide', 'fixture-tiers', COMPLETE_FAMILY_ID, 'Tier One Wide', '2025-01-01', 'Wide'),
  release('fixture-tiers-one-quick', 'fixture-tiers', COMPLETE_FAMILY_ID, 'Tier One Quick', '2025-02-01', 'Quick'),

  // Partial: three variants in use, one of them positioned by nothing. "Quiet"
  // also carries two releases, so a single record has to reach both of them.
  release('fixture-tiers-two-wide', 'fixture-tiers', PARTIAL_FAMILY_ID, 'Tier Two Wide', '2025-03-01', 'Wide'),
  release('fixture-tiers-two-quiet-one', 'fixture-tiers', PARTIAL_FAMILY_ID, 'Tier Two Quiet', '2025-04-01', 'Quiet'),
  release('fixture-tiers-two-quiet-two', 'fixture-tiers', PARTIAL_FAMILY_ID, 'Tier Two Quiet II', '2025-05-01', 'Quiet'),
  release('fixture-tiers-two-dark', 'fixture-tiers', PARTIAL_FAMILY_ID, 'Tier Two Dark', '2025-06-01', 'Dark'),

  // Absent: sibling variants with no record at all, which is the commonest state
  // in the real catalog and must render as an explicit absence.
  release('fixture-tiers-three-wide', 'fixture-tiers', ABSENT_FAMILY_ID, 'Tier Three Wide', '2025-07-01', 'Wide'),
  release('fixture-tiers-three-quick', 'fixture-tiers', ABSENT_FAMILY_ID, 'Tier Three Quick', '2025-08-01', 'Quick'),

  // Repeated name: the same creator reusing "Wide" a generation later.
  release('fixture-tiers-four-wide', 'fixture-tiers', REPEATED_NAME_FAMILY_ID, 'Tier Four Wide', '2026-01-01', 'Wide'),

  release('fixture-rival-one-wide', 'fixture-rival', RIVAL_FAMILY_ID, 'Ensemble Nine Wide', '2025-01-01', 'Wide'),
];

export const positioningFixtureDataset: Dataset = validateDataset({
  sources: [source],
  publishers: [publisher],
  organizations,
  families,
  releases,
});

function entry(variant: string, quote: string, summary: string) {
  return {
    variant,
    official: {
      effectiveAsOf: '2026-08-01',
      sources: [{
        url: 'https://fixture.invalid/positioning/docs',
        title: 'Synthetic positioning docs',
        publisher: 'Tier Foundry',
        type: 'official-docs' as const,
        quote,
        lastCheckedDate: '2026-08-01',
      }],
    },
    editorial: { summary, verifiedAt: '2026-08-01' },
  };
}

export const positioningFixtureRecords: VariantPositioning = [
  {
    id: 'positioning-fixture-tiers-one',
    familyId: COMPLETE_FAMILY_ID,
    note: 'What the two names in this synthetic family are said to be for, and what that leaves open.',
    // Listed newest-name first on purpose: ordering is derived from release
    // dates, so the rendered order must not follow this array.
    variants: [
      entry('Quick', 'Built for short turnarounds', 'The creator describes this name by how quickly it answers, and not by a level.'),
      entry('Wide', 'Built for broad context work', 'The creator describes this name by the breadth of context it handles, and not by a level.'),
    ],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'positioning-fixture-tiers-two',
    familyId: PARTIAL_FAMILY_ID,
    note: 'What two of the three names in this synthetic family are said to be for; the third is unrecorded.',
    variants: [
      entry('Wide', 'Built for broad context work', 'The creator describes this name by the breadth of context it handles, and not by a level.'),
      entry('Quiet', 'Built for background batches', 'The creator describes this name by the kind of work it runs, and not by a level.'),
    ],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'positioning-fixture-tiers-four',
    familyId: REPEATED_NAME_FAMILY_ID,
    note: 'What the reused name means a generation later, which is not what it meant before.',
    variants: [
      entry('Wide', 'Built for multi-step agent runs', 'The creator has moved this name onto agent work, so the earlier reading of it no longer applies.'),
    ],
    verifiedAt: '2026-08-01',
  },
];
