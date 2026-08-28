import { precisionOf } from '../../src/data/partial-date';
import type {
  Dataset,
  Deployment,
  ModelFamily,
  ModelRelease,
  Organization,
  Product,
  ReleaseEvent,
  ServingPlatform,
} from '../../src/data/schema';
import { validateDataset } from '../../src/data/validate';

/**
 * Test-only scaffolding for the `/providers/[slug]` profile builder, deliberately
 * outside `src/` so no page or component can import it and no fabricated
 * provenance sits in the site source graph. Every record here is synthetic: it
 * exists to pin a *shape* `buildProviderProfile` must handle, never to assert a
 * fact about a real creator, product, or serving platform.
 *
 * The reviewed catalog cannot supply these shapes. The seed carries no products,
 * no serving platforms, no deployments and no release events at all right now, so
 * a builder test that reached into real data would assert nothing about the
 * sections that only appear once such records exist -- and would stay quiet, not
 * red, the day a data refresh adds them in a shape the builder never saw. This
 * fixture guarantees the shapes exist; `provider-profile.test.ts` also sweeps the
 * real dataset separately for the invariants that must hold whatever it contains.
 *
 * Shapes pinned here:
 *
 * - a dense creator (`prime-labs`) with two releases across two lifecycle states
 *   (current + legacy), three products (one of each `modelSelection`), release
 *   events, and a serving platform it operates itself
 * - a third-party operator (`open-hub`) whose platform carries deployments of the
 *   dense creator's releases, so the "served here, operated by someone else"
 *   relationship exists and stays labelled apart from the first-party one
 * - a sparse creator (`spare-labs`) with a single release and no products, no
 *   platform, no deployment and no event, so every optional section is exercised
 *   in its absent state
 */

const SOURCE_ID = 'fixture-provider-record';
const VERIFIED_AT = '2026-08-01';

const publisher = {
  id: 'fixture-provider-publisher',
  name: 'Synthetic Provider Fixture Publisher',
};

const source = {
  id: SOURCE_ID,
  url: 'https://fixture.invalid/provider/record',
  title: 'Synthetic fixture record for provider profile shapes',
  type: 'official-announcement' as const,
  publisherId: publisher.id,
  publishedDate: '2024-01-01',
  lastCheckedDate: VERIFIED_AT,
};

export const PRIME_ORG_ID = 'fixture-prime-labs';
export const SPARE_ORG_ID = 'fixture-spare-labs';
export const HUB_ORG_ID = 'fixture-open-hub';

function organization(
  id: string,
  name: string,
  shortName: string,
  type: Organization['type'],
): Organization {
  return {
    id,
    slug: id,
    name,
    shortName,
    type,
    website: `https://fixture.invalid/${id}/`,
    releasePage: `https://fixture.invalid/${id}/releases/`,
    description: `Synthetic organization ${id} used only to exercise provider profiles.`,
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

const organizations: Organization[] = [
  organization('fixture-prime-labs', 'Prime Labs', 'Prime', 'research-lab'),
  organization('fixture-spare-labs', 'Spare Labs', 'Spare', 'research-lab'),
  organization('fixture-open-hub', 'Open Hub', 'Hub', 'company'),
];

function family(id: string, organizationId: string, name: string, firstReleaseDate: string): ModelFamily {
  return {
    id,
    slug: id,
    organizationId,
    name,
    description: `Synthetic family ${id} used only to exercise provider profiles.`,
    categories: ['language-reasoning'],
    firstReleaseDate,
    datePrecision: precisionOf(firstReleaseDate),
    status: 'current',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

export const PRIME_FAMILY_ID = 'fixture-prime-core';
export const SPARE_FAMILY_ID = 'fixture-spare-solo';

const families: ModelFamily[] = [
  family(PRIME_FAMILY_ID, PRIME_ORG_ID, 'Prime Core', '2024-01-01'),
  family(SPARE_FAMILY_ID, SPARE_ORG_ID, 'Spare Solo', '2025-03-01'),
];

function release(
  id: string,
  organizationId: string,
  familyId: string,
  displayName: string,
  releaseDate: string,
  status: ModelRelease['status'],
): ModelRelease {
  return {
    id,
    slug: id,
    canonicalName: displayName,
    displayName,
    organizationId,
    familyId,
    version: '1',
    variant: 'Standard',
    releaseDate,
    datePrecision: 'day',
    status,
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
    summary: `Synthetic release ${id} used only to exercise provider profiles.`,
    intendedUse: 'Fixture data. Not a claim about any real model.',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

export const PRIME_CURRENT_RELEASE_ID = 'fixture-prime-core-v2';
export const PRIME_LEGACY_RELEASE_ID = 'fixture-prime-core-v1';
export const SPARE_RELEASE_ID = 'fixture-spare-one';

const releases: ModelRelease[] = [
  release(PRIME_CURRENT_RELEASE_ID, PRIME_ORG_ID, PRIME_FAMILY_ID, 'Prime Core V2', '2025-06-01', 'current'),
  release(PRIME_LEGACY_RELEASE_ID, PRIME_ORG_ID, PRIME_FAMILY_ID, 'Prime Core V1', '2024-01-01', 'legacy'),
  release(SPARE_RELEASE_ID, SPARE_ORG_ID, SPARE_FAMILY_ID, 'Spare One', '2025-03-01', 'current'),
];

function product(
  id: string,
  name: string,
  modelSelection: Product['modelSelection'],
  releaseIds: string[],
): Product {
  return {
    id,
    slug: id,
    name,
    organizationId: PRIME_ORG_ID,
    description: `Synthetic product ${id} used only to exercise provider profiles.`,
    modelSelection,
    releaseIds,
    effectiveFrom: '2025-06-01',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

export const FIXED_PRODUCT_ID = 'fixture-prime-assistant';
export const ROUTED_PRODUCT_ID = 'fixture-prime-router';
export const UNKNOWN_PRODUCT_ID = 'fixture-prime-legacy-suite';

const products: Product[] = [
  product(FIXED_PRODUCT_ID, 'Prime Assistant', 'fixed', [PRIME_CURRENT_RELEASE_ID]),
  product(ROUTED_PRODUCT_ID, 'Prime Router', 'routed', [PRIME_CURRENT_RELEASE_ID, PRIME_LEGACY_RELEASE_ID]),
  product(UNKNOWN_PRODUCT_ID, 'Prime Legacy Suite', 'unknown', []),
];

function servingPlatform(
  id: string,
  name: string,
  organizationId: string,
  type: ServingPlatform['type'],
): ServingPlatform {
  return {
    id,
    slug: id,
    name,
    organizationId,
    type,
    website: `https://fixture.invalid/${id}/`,
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

export const FIRST_PARTY_PLATFORM_ID = 'fixture-prime-cloud';
export const THIRD_PARTY_PLATFORM_ID = 'fixture-open-hub-platform';

const servingPlatforms: ServingPlatform[] = [
  servingPlatform(FIRST_PARTY_PLATFORM_ID, 'Prime Cloud', PRIME_ORG_ID, 'first-party-api'),
  servingPlatform(THIRD_PARTY_PLATFORM_ID, 'Open Hub Platform', HUB_ORG_ID, 'aggregator'),
];

function deployment(id: string, releaseId: string, platformId: string): Deployment {
  return {
    id,
    releaseId,
    platformId,
    deliveryMode: 'hosted-api',
    regions: [],
    effectiveFrom: '2025-06-01',
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

const deployments: Deployment[] = [
  // First-party platform carries the current release only.
  deployment('fixture-deploy-prime-cloud-v2', PRIME_CURRENT_RELEASE_ID, FIRST_PARTY_PLATFORM_ID),
  // Third-party hub carries both of the dense creator's releases: two distinct
  // releases, so its served-release count must be 2 rather than the row count.
  deployment('fixture-deploy-hub-v2', PRIME_CURRENT_RELEASE_ID, THIRD_PARTY_PLATFORM_ID),
  deployment('fixture-deploy-hub-v1', PRIME_LEGACY_RELEASE_ID, THIRD_PARTY_PLATFORM_ID),
];

function releaseEvent(
  id: string,
  releaseId: string,
  type: ReleaseEvent['type'],
  date: string,
  note: string,
): ReleaseEvent {
  return {
    id,
    releaseId,
    type,
    date,
    datePrecision: 'day',
    note,
    sourceIds: [SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

const releaseEvents: ReleaseEvent[] = [
  releaseEvent('fixture-event-v2-announced', PRIME_CURRENT_RELEASE_ID, 'announced', '2025-06-01', 'Announced.'),
  releaseEvent('fixture-event-v2-ga', PRIME_CURRENT_RELEASE_ID, 'generally-available', '2025-06-15', 'Generally available.'),
  releaseEvent('fixture-event-v1-deprecated', PRIME_LEGACY_RELEASE_ID, 'deprecated', '2025-01-01', 'Deprecated.'),
];

/**
 * A standalone synthetic catalog, run through the real validator so the fixture
 * cannot drift into a shape the production dataset could never take. It is
 * deliberately *not* merged with the reviewed catalog.
 */
export const providerProfileFixtureDataset: Dataset = validateDataset({
  sources: [source],
  publishers: [publisher],
  organizations,
  families,
  releases,
  products,
  servingPlatforms,
  deployments,
  releaseEvents,
});
