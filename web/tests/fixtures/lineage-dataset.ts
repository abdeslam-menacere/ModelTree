import { precisionOf } from '../../src/data/partial-date';
import type { Dataset, ModelFamily, ModelRelease, Organization } from '../../src/data/schema';
import { validateDataset } from '../../src/data/validate';

/**
 * Test-only scaffolding, deliberately outside `src/` so no page or component can
 * reach it and no fabricated provenance sits in the site source graph. Every
 * record here is synthetic: it exists to pin a *shape* the lineage explorer must
 * handle, never to assert a fact about a real creator or model.
 *
 * The reviewed catalog cannot be the source of these shapes. It holds whichever
 * lineage the sources happen to support on a given day, so a smoke test that
 * reached for "the deep family" or "the family with no relationships" in real
 * data would be testing today's dataset rather than the transformation, and
 * would go quiet -- not red, quiet -- the moment a data refresh reshaped it.
 * These fixtures guarantee the shapes exist; the real-data assertions in
 * `lineage-view.test.ts` separately sweep whatever the catalog actually holds.
 *
 * Shapes pinned here:
 *
 * - shallow: one featured family holding a single release
 * - long tail: a family with no featured release, which must not be rendered
 * - deep: a four-generation predecessor chain, with two of its edges recorded
 *   from one side only, because `validate.ts` enforces reciprocity for siblings
 *   but not for predecessor/successor
 * - multi-root: two independent roots in one family, plus a reciprocal sibling pair
 * - multi-predecessor: a release two other releases both claim as a successor
 * - cycle: two releases that each record the other as a successor
 * - derivation: a `derivedFromIds` edge that crosses organizations, which
 *   `validate.ts` explicitly permits and which therefore must never nest
 * - cross-family succession: two families of one creator, each holding a single
 *   release, joined by `successorIds`. This is the shape ADR 0014 exists for --
 *   Anthropic models each point release as its own family, so Fable 5 -> 5.1 is
 *   a family boundary while Google's identical 3.1 -> 3.5 is not. The link is
 *   written on the *earlier* release only, so reading it from the later family
 *   proves the union-of-both-directions read survives the crossing. Before
 *   ADR 0014 this fixture could not be constructed at all: `validateDataset`
 *   threw on it, which is why the fixture is itself the validator's witness
 * - partial dates: releases a source dated only to the year or the month, stored
 *   at exactly that precision, so a renderer cannot invent a day the source
 *   never stated. Before abdeslam-menacere/ModelTree#468 these had to carry a
 *   fabricated `-01-01` day and rely on `datePrecision` to suppress it; they now
 *   say what the source said.
 */

const SOURCE_ID = 'fixture-lineage-announcement';
const VERIFIED_AT = '2026-08-01';

const publisher = {
  id: 'fixture-lineage-publisher',
  name: 'Synthetic Lineage Fixture Publisher',
};

const source = {
  id: SOURCE_ID,
  url: 'https://fixture.invalid/lineage/announcement',
  title: 'Synthetic fixture record for lineage explorer shapes',
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
    description: `Synthetic creator ${id} used only to exercise lineage rendering.`,
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
    description: `Synthetic family ${id} used only to exercise lineage rendering.`,
    categories: ['language-reasoning'],
    firstReleaseDate,
    datePrecision: precisionOf(firstReleaseDate),
    status: 'current',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

interface ReleaseOverrides {
  featured?: boolean;
  predecessorIds?: string[];
  successorIds?: string[];
  siblingIds?: string[];
  derivedFromIds?: string[];
  datePrecision?: ModelRelease['datePrecision'];
  status?: ModelRelease['status'];
  variant?: string;
}

function release(
  id: string,
  organizationId: string,
  familyId: string,
  displayName: string,
  releaseDate: string,
  overrides: ReleaseOverrides = {},
): ModelRelease {
  const featured = overrides.featured ?? true;

  return {
    id,
    slug: id,
    canonicalName: displayName,
    displayName,
    organizationId,
    familyId,
    version: '1',
    variant: overrides.variant ?? 'Standard',
    releaseDate,
    datePrecision: overrides.datePrecision ?? 'day',
    status: overrides.status ?? 'current',
    featured,
    // Required by the schema whenever `featured` is set, and true of the fixture
    // rather than of any model: it is here to exercise the featured derivation.
    featuredRationale: featured ? 'Synthetic fixture record, featured to exercise the derivation.' : undefined,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: overrides.predecessorIds ?? [],
    successorIds: overrides.successorIds ?? [],
    siblingIds: overrides.siblingIds ?? [],
    derivedFromIds: overrides.derivedFromIds ?? [],
    summary: `Synthetic release ${id} used only to exercise lineage rendering.`,
    intendedUse: 'Fixture data. Not a claim about any real model.',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

const organizations: Organization[] = [
  organization('fixture-alpha', 'Alpha Foundry', 'Alpha'),
  organization('fixture-beta', 'Beta Collective', 'Beta'),
  organization('fixture-gamma', 'Gamma Works', 'Gamma'),
];

export const SHALLOW_FAMILY_ID = 'fixture-alpha-solo';
export const LONG_TAIL_FAMILY_ID = 'fixture-alpha-longtail';
export const DEEP_FAMILY_ID = 'fixture-beta-chain';
export const MULTI_ROOT_FAMILY_ID = 'fixture-beta-roots';
export const FLAT_FAMILY_ID = 'fixture-gamma-flat';
export const MULTI_PREDECESSOR_FAMILY_ID = 'fixture-gamma-converge';
export const CYCLE_FAMILY_ID = 'fixture-gamma-cycle';
export const SUCCESSION_ORIGIN_FAMILY_ID = 'fixture-alpha-mark-one';
export const SUCCESSION_HEIR_FAMILY_ID = 'fixture-alpha-mark-two';

const families: ModelFamily[] = [
  family(SHALLOW_FAMILY_ID, 'fixture-alpha', 'Alpha Solo', '2025-01-01'),
  family(LONG_TAIL_FAMILY_ID, 'fixture-alpha', 'Alpha Long Tail', '2025-01-01'),
  family(SUCCESSION_ORIGIN_FAMILY_ID, 'fixture-alpha', 'Alpha Mark One', '2025-04-01'),
  family(SUCCESSION_HEIR_FAMILY_ID, 'fixture-alpha', 'Alpha Mark Two', '2025-05-01'),
  family(DEEP_FAMILY_ID, 'fixture-beta', 'Beta Chain', '2022-01-01'),
  family(MULTI_ROOT_FAMILY_ID, 'fixture-beta', 'Beta Roots', '2025-01-01'),
  family(FLAT_FAMILY_ID, 'fixture-gamma', 'Gamma Flat', '2025-01-01'),
  family(MULTI_PREDECESSOR_FAMILY_ID, 'fixture-gamma', 'Gamma Converge', '2025-01-01'),
  family(CYCLE_FAMILY_ID, 'fixture-gamma', 'Gamma Cycle', '2025-01-01'),
];

const releases: ModelRelease[] = [
  // Shallow: a featured family of exactly one release, and no lineage at all.
  release('fixture-alpha-solo-one', 'fixture-alpha', SHALLOW_FAMILY_ID, 'Alpha Solo One', '2025-01-01'),

  // Long tail: a family of the same creator with no featured release. Its
  // releases must not reach the homepage explorer at all.
  release('fixture-alpha-longtail-one', 'fixture-alpha', LONG_TAIL_FAMILY_ID, 'Alpha Long Tail One', '2025-01-01', {
    featured: false,
  }),

  // Cross-family succession: one creator, one release per family, joined across
  // the boundary. Recorded on the earlier release only, so the later family has
  // to find the edge by reading the other end -- the same union-of-directions
  // rule the within-family tree uses, applied where the two ends are drawn in
  // different panels and no connector between them is possible.
  release('fixture-alpha-mark-one-release', 'fixture-alpha', SUCCESSION_ORIGIN_FAMILY_ID, 'Alpha Mark One Release', '2025-04-01', {
    successorIds: ['fixture-alpha-mark-two-release'],
    status: 'legacy',
  }),
  release('fixture-alpha-mark-two-release', 'fixture-alpha', SUCCESSION_HEIR_FAMILY_ID, 'Alpha Mark Two Release', '2025-05-01'),

  // Deep: gen1 -> gen2 -> gen3 -> gen4.
  // gen1/gen2 is recorded only on the child's `predecessorIds`; gen3/gen4 only on
  // the parent's `successorIds`. Both must produce the same nesting, which is why
  // edges are read as the union of the two directions.
  release('fixture-beta-chain-gen1', 'fixture-beta', DEEP_FAMILY_ID, 'Beta Chain Gen 1', '2022', {
    datePrecision: 'year',
    status: 'legacy',
  }),
  release('fixture-beta-chain-gen2', 'fixture-beta', DEEP_FAMILY_ID, 'Beta Chain Gen 2', '2023-06', {
    predecessorIds: ['fixture-beta-chain-gen1'],
    datePrecision: 'month',
    status: 'legacy',
  }),
  release('fixture-beta-chain-gen3', 'fixture-beta', DEEP_FAMILY_ID, 'Beta Chain Gen 3', '2024-03-04', {
    predecessorIds: ['fixture-beta-chain-gen2'],
    successorIds: ['fixture-beta-chain-gen4'],
  }),
  release('fixture-beta-chain-gen4', 'fixture-beta', DEEP_FAMILY_ID, 'Beta Chain Gen 4', '2025-05-06', {
    variant: 'Compact',
  }),

  // Multi-root: two independent roots, one of which has a successor, plus a
  // reciprocal sibling pair across the two roots.
  release('fixture-beta-roots-first', 'fixture-beta', MULTI_ROOT_FAMILY_ID, 'Beta Roots First', '2025-01-01', {
    siblingIds: ['fixture-beta-roots-second'],
    successorIds: ['fixture-beta-roots-child'],
  }),
  release('fixture-beta-roots-second', 'fixture-beta', MULTI_ROOT_FAMILY_ID, 'Beta Roots Second', '2025-02-01', {
    siblingIds: ['fixture-beta-roots-first'],
  }),
  release('fixture-beta-roots-child', 'fixture-beta', MULTI_ROOT_FAMILY_ID, 'Beta Roots Child', '2025-03-01'),

  // Flat: three releases, no recorded relationship of any kind. Rendering a
  // connector between any two of these would be an invented claim, which is the
  // whole of the "unknown relationships" acceptance criterion.
  release('fixture-gamma-flat-one', 'fixture-gamma', FLAT_FAMILY_ID, 'Gamma Flat One', '2025-01-01'),
  release('fixture-gamma-flat-two', 'fixture-gamma', FLAT_FAMILY_ID, 'Gamma Flat Two', '2025-02-01', {
    featured: false,
    // Crosses organizations, which `validate.ts` permits for derivation alone.
    derivedFromIds: ['fixture-alpha-solo-one'],
  }),
  release('fixture-gamma-flat-three', 'fixture-gamma', FLAT_FAMILY_ID, 'Gamma Flat Three', '2025-03-01', {
    featured: false,
  }),

  // Multi-predecessor: two releases both record the same successor.
  release('fixture-gamma-converge-left', 'fixture-gamma', MULTI_PREDECESSOR_FAMILY_ID, 'Gamma Converge Left', '2025-01-01', {
    successorIds: ['fixture-gamma-converge-merged'],
  }),
  release('fixture-gamma-converge-right', 'fixture-gamma', MULTI_PREDECESSOR_FAMILY_ID, 'Gamma Converge Right', '2025-02-01', {
    successorIds: ['fixture-gamma-converge-merged'],
  }),
  release('fixture-gamma-converge-merged', 'fixture-gamma', MULTI_PREDECESSOR_FAMILY_ID, 'Gamma Converge Merged', '2025-03-01'),

  // Cycle: each records the other as its successor. Impossible as a fact and not
  // rejected by the validator, so the transformation has to terminate anyway.
  release('fixture-gamma-cycle-one', 'fixture-gamma', CYCLE_FAMILY_ID, 'Gamma Cycle One', '2025-01-01', {
    successorIds: ['fixture-gamma-cycle-two'],
  }),
  release('fixture-gamma-cycle-two', 'fixture-gamma', CYCLE_FAMILY_ID, 'Gamma Cycle Two', '2025-02-01', {
    successorIds: ['fixture-gamma-cycle-one'],
  }),
];

/**
 * A standalone synthetic catalog, run through the real validator so the fixture
 * cannot drift into a shape the production dataset could never take. It is
 * deliberately *not* merged with the reviewed catalog: these assertions are about
 * the transformation, and merging would make them move with the real data.
 */
export const lineageFixtureDataset: Dataset = validateDataset({
  sources: [source],
  publishers: [publisher],
  organizations,
  families,
  releases,
});
