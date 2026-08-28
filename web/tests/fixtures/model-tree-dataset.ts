import { dataset } from '../../src/data/dataset';
import { precisionOf } from '../../src/data/partial-date';
import type { Dataset, ModelFamily, ModelRelease, Organization } from '../../src/data/schema';
import { validateDataset } from '../../src/data/validate';

/**
 * Test-only scaffolding, deliberately outside `src/` so no page or component can
 * reach it and no fabricated provenance sits in the site source graph. These
 * records are synthetic: they exist to prove the derivation, never to assert a
 * fact about a real creator.
 *
 * The real catalog populates `Others` on its own, so this fixture is no longer
 * what keeps that branch from being empty. What it still supplies is the
 * ordering pathology the catalog does not happen to contain, and cannot be made
 * to contain without inventing creators: two creators sharing a name so the id
 * tiebreak is observable, a creator whose name sorts last while its id sorts
 * first, two families tied on their newest release date, two releases tied on
 * release date, and a family with no releases that must be dropped.
 */

const SYNTHETIC_SOURCE_ID = 'synthetic-other-branch-note';
const VERIFIED_AT = '2026-08-01';

const publisher = {
  id: 'synthetic-other-branch-publisher',
  name: 'Synthetic Fixture Publisher',
};

const source = {
  id: SYNTHETIC_SOURCE_ID,
  url: 'https://fixture.invalid/model-tree/other-branch',
  title: 'Synthetic fixture record for the Others branch',
  type: 'official-announcement' as const,
  publisherId: publisher.id,
  publishedDate: '2025-01-01',
  lastCheckedDate: VERIFIED_AT,
};

function organization(id: string, name: string): Organization {
  return {
    id,
    slug: id,
    name,
    shortName: name,
    type: 'research-lab',
    website: `https://fixture.invalid/${id}/`,
    releasePage: `https://fixture.invalid/${id}/releases/`,
    description: `Synthetic creator ${id} used only to exercise the Others branch.`,
    sourceIds: [SYNTHETIC_SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

function family(
  id: string,
  organizationId: string,
  name: string,
  firstReleaseDate: string,
): ModelFamily {
  return {
    id,
    slug: id,
    organizationId,
    name,
    description: `Synthetic family ${id} used only to exercise the Others branch.`,
    categories: ['language-reasoning'],
    firstReleaseDate,
    datePrecision: precisionOf(firstReleaseDate),
    status: 'current',
    sourceIds: [SYNTHETIC_SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

function release(
  id: string,
  organizationId: string,
  familyId: string,
  displayName: string,
  releaseDate: string,
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
    summary: `Synthetic release ${id} used only to exercise the Others branch.`,
    intendedUse: 'Fixture data. Not a claim about any real model.',
    sourceIds: [SYNTHETIC_SOURCE_ID],
    verifiedAt: VERIFIED_AT,
  };
}

const organizations: Organization[] = [
  // Name sorts last, id sorts first: proves creators order by name, not id.
  organization('other-alpha', 'Zenith Labs'),
  // Shares a name with other-zulu, so the id tiebreak decides the pair.
  organization('other-bravo', 'Aurora Research'),
  organization('other-zulu', 'Aurora Research'),
];

const families: ModelFamily[] = [
  family('other-alpha-core', 'other-alpha', 'Zenith Core', '2025-03-01'),
  family('other-bravo-core', 'other-bravo', 'Bravo Core', '2025-02-01'),
  family('other-zulu-nova', 'other-zulu', 'Zulu Nova', '2025-01-01'),
  family('other-zulu-atlas', 'other-zulu', 'Zulu Atlas', '2025-06-01'),
  family('other-zulu-orion', 'other-zulu', 'Zulu Orion', '2025-06-01'),
  // No releases: must be dropped rather than rendered as an empty branch.
  family('other-zulu-void', 'other-zulu', 'Zulu Void', '2025-01-01'),
];

const releases: ModelRelease[] = [
  release('other-alpha-core-one', 'other-alpha', 'other-alpha-core', 'Zenith Flagship', '2025-03-01'),
  release('other-bravo-core-one', 'other-bravo', 'other-bravo-core', 'Bravo Flagship', '2025-02-01'),
  release('other-zulu-nova-two', 'other-zulu', 'other-zulu-nova', 'Nova Beta', '2026-03-01'),
  release('other-zulu-nova-one', 'other-zulu', 'other-zulu-nova', 'Nova Alpha', '2026-03-01'),
  release('other-zulu-nova-old', 'other-zulu', 'other-zulu-nova', 'Nova Legacy', '2025-01-01'),
  release('other-zulu-atlas-one', 'other-zulu', 'other-zulu-atlas', 'Atlas Prime', '2025-06-01'),
  release('other-zulu-orion-one', 'other-zulu', 'other-zulu-orion', 'Orion Prime', '2025-06-01'),
];

/**
 * The reviewed catalog plus three synthetic creators that hold releases but no
 * featured release. Run through the real validator so the fixture cannot drift
 * into a shape the production dataset could never take.
 */
export const datasetWithOtherCreators: Dataset = validateDataset({
  ...dataset,
  publishers: [...dataset.publishers, publisher],
  sources: [...dataset.sources, source],
  organizations: [...dataset.organizations, ...organizations],
  families: [...dataset.families, ...families],
  releases: [...dataset.releases, ...releases],
});

/** Creator ids the fixture expects under `others`, in exact render order. */
export const expectedOtherCreatorIds = ['other-bravo', 'other-zulu', 'other-alpha'];
