/**
 * Fixture records for the Model Passport's populated branches.
 *
 * Why these exist at all: `raw.ts` composes no pricing, deployment, serving
 * platform, or release-event JSON, so those four entity types are empty in the
 * shipped dataset and the only branch the real data can exercise is the absent
 * one. A pricing table tested only against real data renders nothing and every
 * assertion still passes — the section would ship having never once been seen
 * to work. These records are what the populated branches are proven against.
 *
 * Why they live here and not in `src/data/`: every fact in that directory
 * carries a primary source and a verification date, and these carry neither.
 * They describe organizations and models that do not exist, they are reachable
 * only from test files, and `passport.test.ts` asserts that no shipping module
 * imports this one. Nothing here reaches a built page.
 *
 * The four scenarios the issue asks to be covered:
 *
 * - `COMPLETE_RELEASE_ID` — every optional field populated, all four
 *   relationship kinds including one dangling id, two deployments, a price,
 *   and a change history.
 * - `SPARSE_RELEASE_ID` — the schema's bare minimum: no licence, no
 *   deployment, no price, no event, no relationship, no context window, no API
 *   identifier, and a release date its source stated only to the month.
 * - `PROPRIETARY_RELEASE_ID` — hosted-only, with a superseded price and a
 *   current one, and no licence record.
 * - `OPEN_WEIGHT_RELEASE_ID` — downloadable weights under a licence the OSI has
 *   not approved. The case where calling the model "open source" would be
 *   wrong, which is why the schema splits those two booleans.
 */
import type {
  Deployment,
  ModelFamily,
  ModelRelease,
  Organization,
  PricingRecord,
  Publisher,
  ReleaseEvent,
  ServingPlatform,
  SourceReference,
} from '../data/schema';
import type { PassportDataset } from './passport';

/** The build date every fixture-driven expectation is computed against. */
export const FIXTURE_TODAY = '2026-08-27';

export const COMPLETE_RELEASE_ID = 'complete-release';
export const SPARSE_RELEASE_ID = 'sparse-release';
export const PROPRIETARY_RELEASE_ID = 'proprietary-release';
export const OPEN_WEIGHT_RELEASE_ID = 'open-weight-release';

/** Named by `complete-release` but deliberately absent, to exercise dangling ids. */
export const DANGLING_RELATION_ID = 'never-reviewed-release';

const organizations: Organization[] = [
  {
    id: 'example-lab',
    slug: 'example-lab',
    name: 'Example Lab',
    shortName: 'Example',
    type: 'research-lab',
    website: 'https://lab.example.com',
    releasePage: 'https://lab.example.com/releases',
    description: 'A fictional model creator used only by tests.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'example-cloud',
    slug: 'example-cloud',
    name: 'Example Cloud',
    shortName: 'ExCloud',
    type: 'company',
    website: 'https://cloud.example.com',
    releasePage: 'https://cloud.example.com/releases',
    description: 'A fictional platform operator used only by tests.',
    sourceIds: ['cloud-pricing'],
    verifiedAt: '2026-08-01',
  },
];

const publishers: Publisher[] = [
  { id: 'lab-voice', name: 'Example Lab', organizationId: 'example-lab' },
  { id: 'cloud-voice', name: 'Example Cloud', organizationId: 'example-cloud' },
];

const sources: SourceReference[] = [
  {
    id: 'lab-docs',
    url: 'https://lab.example.com/docs',
    title: 'Example Lab documentation',
    type: 'official-docs',
    publisherId: 'lab-voice',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'lab-announcement',
    url: 'https://lab.example.com/blog/complete',
    title: 'Introducing Complete Model',
    type: 'official-announcement',
    publisherId: 'lab-voice',
    publishedDate: '2026-02-10',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'cloud-pricing',
    url: 'https://cloud.example.com/pricing',
    title: 'Example Cloud pricing',
    type: 'official-docs',
    publisherId: 'cloud-voice',
    lastCheckedDate: '2026-08-20',
  },
  {
    id: 'cloud-regions',
    url: 'https://cloud.example.com/regions',
    title: 'Example Cloud regional availability',
    type: 'official-docs',
    publisherId: 'cloud-voice',
    lastCheckedDate: '2026-08-20',
  },
];

const families: ModelFamily[] = [
  {
    id: 'complete-family',
    slug: 'complete-family',
    organizationId: 'example-lab',
    name: 'Complete Family',
    description: 'A fictional family used only by tests.',
    categories: ['language-reasoning'],
    firstReleaseDate: '2025-01-15',
    status: 'current',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'sparse-family',
    slug: 'sparse-family',
    organizationId: 'example-lab',
    name: 'Sparse Family',
    description: 'A fictional family whose records are deliberately minimal.',
    categories: ['coding'],
    firstReleaseDate: '2026-03-01',
    status: 'preview',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-01',
  },
];

/** Referenced by `complete-release`'s relationships, so each kind resolves. */
const relatedReleases: ModelRelease[] = [
  {
    id: 'earlier-release',
    slug: 'earlier-model',
    canonicalName: 'Example Earlier Model',
    displayName: 'Earlier Model',
    organizationId: 'example-lab',
    familyId: 'complete-family',
    version: '1',
    variant: 'base',
    releaseDate: '2025-01-15',
    datePrecision: 'day',
    status: 'legacy',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [],
    successorIds: [COMPLETE_RELEASE_ID],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'The earlier release in this line.',
    intendedUse: 'Superseded; kept for lineage.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'later-release',
    slug: 'later-model',
    canonicalName: 'Example Later Model',
    displayName: 'Later Model',
    organizationId: 'example-lab',
    familyId: 'complete-family',
    version: '3',
    variant: 'base',
    releaseDate: '2026-07-01',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [COMPLETE_RELEASE_ID],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'The later release in this line.',
    intendedUse: 'The current version.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'variant-release',
    slug: 'variant-model',
    canonicalName: 'Example Complete Model Mini',
    displayName: 'Complete Model Mini',
    organizationId: 'example-lab',
    familyId: 'complete-family',
    version: '2',
    variant: 'mini',
    releaseDate: '2026-02-10',
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
    siblingIds: [COMPLETE_RELEASE_ID],
    derivedFromIds: [],
    summary: 'A smaller variant of the same family.',
    intendedUse: 'Cheaper and faster than its sibling.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-01',
  },
  {
    // A release whose source stated only the year, so the page must not print a
    // month or a day for it.
    id: 'foundation-release',
    slug: 'foundation-model',
    canonicalName: 'Example Foundation Model',
    displayName: 'Foundation Model',
    organizationId: 'example-lab',
    familyId: 'complete-family',
    version: '0',
    variant: 'base',
    releaseDate: '2024-01-01',
    datePrecision: 'year',
    status: 'research',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'open-weight',
    license: {
      name: 'Example Permissive Licence 1.0',
      spdxId: 'Apache-2.0',
      url: 'https://lab.example.com/licences/permissive',
      weightsDownloadable: true,
      osiApproved: true,
    },
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'The base model later releases were built from.',
    intendedUse: 'Research use.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-01',
  },
];

const scenarioReleases: ModelRelease[] = [
  {
    id: COMPLETE_RELEASE_ID,
    slug: 'complete-model',
    canonicalName: 'Example Complete Model 2',
    displayName: 'Complete Model',
    organizationId: 'example-lab',
    familyId: 'complete-family',
    version: '2',
    variant: 'base',
    releaseDate: '2026-02-10',
    datePrecision: 'day',
    status: 'current',
    featured: true,
    featuredRationale: 'it is the fixture that exercises every populated branch',
    categories: ['language-reasoning', 'coding'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    accessType: 'open-weight',
    license: {
      name: 'Example Permissive Licence 1.0',
      spdxId: 'Apache-2.0',
      url: 'https://lab.example.com/licences/permissive',
      weightsDownloadable: true,
      osiApproved: true,
    },
    parameters: { totalBillions: 120, activeBillions: 12 },
    contextWindow: 200_000,
    maximumOutput: 32_000,
    apiAliases: ['complete-model-2', 'complete-model-2-2026-02-10'],
    predecessorIds: ['earlier-release'],
    successorIds: ['later-release'],
    siblingIds: ['variant-release'],
    // One resolvable derivation and one id this dataset has never reviewed.
    derivedFromIds: ['foundation-release', DANGLING_RELATION_ID],
    summary: 'A fictional release with every optional field populated.',
    intendedUse: 'Exercising the passport when every record exists.',
    sourceIds: ['lab-announcement', 'lab-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: SPARSE_RELEASE_ID,
    slug: 'sparse-model',
    canonicalName: 'Sparse Model',
    displayName: 'Sparse Model',
    organizationId: 'example-lab',
    familyId: 'sparse-family',
    version: '1',
    variant: 'base',
    // The announcement gave a month, so the stored day is a placeholder and
    // `datePrecision` is what decides how it prints.
    releaseDate: '2026-03-01',
    datePrecision: 'month',
    status: 'preview',
    featured: false,
    categories: ['coding'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A fictional release recorded with the bare minimum the schema allows.',
    intendedUse: 'Exercising the passport when almost nothing is recorded.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: PROPRIETARY_RELEASE_ID,
    slug: 'proprietary-model',
    canonicalName: 'Example Proprietary Model',
    displayName: 'Proprietary Model',
    organizationId: 'example-lab',
    familyId: 'complete-family',
    version: '1',
    variant: 'base',
    releaseDate: '2026-01-20',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    contextWindow: 128_000,
    apiAliases: ['proprietary-model-1'],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A fictional hosted-only release with published prices.',
    intendedUse: 'Exercising pricing and availability without a licence record.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: OPEN_WEIGHT_RELEASE_ID,
    slug: 'open-weight-model',
    canonicalName: 'Example Open Weight Model',
    displayName: 'Open Weight Model',
    organizationId: 'example-lab',
    familyId: 'complete-family',
    version: '1',
    variant: 'base',
    releaseDate: '2026-04-05',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'open-weight',
    license: {
      name: 'Example Community Licence 2.0',
      // No SPDX id, and the OSI has not approved it. Downloadable weights under
      // terms that are not open source is the case the wording must get right.
      url: 'https://lab.example.com/licences/community',
      weightsDownloadable: true,
      osiApproved: false,
    },
    parameters: { totalBillions: 70 },
    contextWindow: 32_768,
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A fictional release whose weights download under a non-OSI licence.',
    intendedUse: 'Exercising openness wording where weights and licence disagree.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-15',
  },
];

const servingPlatforms: ServingPlatform[] = [
  {
    id: 'example-cloud-api',
    slug: 'example-cloud-api',
    name: 'Example Cloud API',
    organizationId: 'example-cloud',
    type: 'cloud-platform',
    website: 'https://cloud.example.com/api',
    sourceIds: ['cloud-pricing'],
    verifiedAt: '2026-08-20',
  },
  {
    id: 'example-hub',
    slug: 'example-hub',
    name: 'Example Hub',
    organizationId: 'example-cloud',
    type: 'model-hub',
    website: 'https://hub.example.com',
    sourceIds: ['cloud-regions'],
    verifiedAt: '2026-08-20',
  },
];

const deployments: Deployment[] = [
  {
    id: 'complete-hosted',
    releaseId: COMPLETE_RELEASE_ID,
    platformId: 'example-cloud-api',
    deliveryMode: 'hosted-api',
    apiIdentifier: 'complete-model-2',
    regions: ['us-east', 'eu-west'],
    effectiveFrom: '2026-02-10',
    sourceIds: ['cloud-regions'],
    verifiedAt: '2026-08-20',
  },
  {
    // Weights carry no per-unit rate, so this deployment holds no pricing record.
    id: 'complete-weights',
    releaseId: COMPLETE_RELEASE_ID,
    platformId: 'example-hub',
    deliveryMode: 'downloadable-weights',
    regions: [],
    effectiveFrom: '2026-02-10',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-20',
  },
  {
    id: 'proprietary-hosted',
    releaseId: PROPRIETARY_RELEASE_ID,
    platformId: 'example-cloud-api',
    deliveryMode: 'hosted-api',
    regions: ['us-east'],
    effectiveFrom: '2026-01-20',
    sourceIds: ['cloud-regions'],
    // Verified well over the volatile horizon before FIXTURE_TODAY.
    verifiedAt: '2026-01-20',
  },
];

const pricing: PricingRecord[] = [
  {
    id: 'complete-price',
    deploymentId: 'complete-hosted',
    currency: 'USD',
    unit: 'per-1m-tokens',
    rates: { input: 0.35, cachedInput: 0.035, output: 1.4 },
    region: 'us-east',
    processingTier: 'Standard',
    effectiveFrom: '2026-02-10',
    sourceIds: ['cloud-pricing'],
    verifiedAt: '2026-08-20',
  },
  {
    // Closed range: superseded by the record below.
    id: 'proprietary-price-old',
    deploymentId: 'proprietary-hosted',
    currency: 'EUR',
    unit: 'per-1k-tokens',
    rates: { input: 0.002, output: 0.006 },
    region: 'eu-west',
    processingTier: 'Batch',
    effectiveFrom: '2026-01-20',
    effectiveTo: '2026-05-31',
    sourceIds: ['cloud-pricing'],
    verifiedAt: '2026-08-20',
  },
  {
    // No region and no tier, so the page must mark both as not recorded rather
    // than leaving two empty cells.
    id: 'proprietary-price-current',
    deploymentId: 'proprietary-hosted',
    currency: 'EUR',
    unit: 'per-1k-tokens',
    rates: { input: 0.0018, output: 0.0054 },
    effectiveFrom: '2026-06-01',
    sourceIds: ['cloud-pricing'],
    verifiedAt: '2026-03-01',
  },
];

const releaseEvents: ReleaseEvent[] = [
  // Deliberately out of chronological order, so sorting is exercised.
  {
    id: 'complete-ga',
    releaseId: COMPLETE_RELEASE_ID,
    type: 'generally-available',
    date: '2026-03',
    datePrecision: 'month',
    note: 'Left preview and became generally available.',
    sourceIds: ['lab-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: 'complete-announced',
    releaseId: COMPLETE_RELEASE_ID,
    type: 'announced',
    date: '2026-02-10',
    datePrecision: 'day',
    note: 'Announced alongside the family refresh.',
    sourceIds: ['lab-announcement'],
    verifiedAt: '2026-08-15',
  },
];

export const passportFixtures: PassportDataset = {
  sources,
  publishers,
  organizations,
  families,
  releases: [...scenarioReleases, ...relatedReleases],
  servingPlatforms,
  deployments,
  pricing,
  releaseEvents,
  usageObservations: [],
  modelFitStatements: [],
};
