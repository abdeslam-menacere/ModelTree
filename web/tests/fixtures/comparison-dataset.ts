/**
 * Fixture records for the comparison's populated branches (issue #24).
 *
 * Why a second fixture dataset rather than reusing `passport-dataset.ts`: that
 * one is shaped around one release at a time, and the states this issue has to
 * distinguish only appear when several releases are read side by side. Two
 * specifically cannot be reached from it at all — it holds no benchmark results,
 * so no evidence row can be built from it, and its two priced deployments differ
 * in unit as well as currency, so they land in separate rows and never meet in
 * the one place a currency clash could be detected. Extending it in place would
 * also mean editing a fixture three suites already pin, which is a change to
 * issue #19's tests rather than to this issue's.
 *
 * The states below cannot be reached from `src/data` either, and the reason is
 * measured rather than assumed. At merge-base `fc418bb6`, `raw.ts` composes no
 * pricing, deployment, or serving-platform JSON at all, and of 49 releases only
 * 2 carry any benchmark result. So against real data the pricing and
 * availability groups are always absent and no `not-comparable` row can occur —
 * every assertion about them would pass over a table that had never once
 * rendered. The real dataset still gets its own tests, because sparse output is
 * this feature's main path; these records are what the populated half is proven
 * against.
 *
 * Why they live here and not under `web/src/`: every fact under `src/data/`
 * carries a primary source and a verification date, and these carry neither.
 * Keeping them outside the site source tree is what stops a fictional price
 * reaching a built page.
 *
 * What each release is for:
 *
 * - `ATLAS_PRO` — every optional field populated, an OSI-approved licence,
 *   downloadable weights, two input modalities, prices on one platform, and
 *   results on both benchmarks.
 * - `BOREALIS_AIR` — hosted-only and `legacy`, so it has no licence record at
 *   all (the `not-applicable` case), a narrower context window, one input
 *   modality, and prices published in a different currency from `ATLAS_PRO` on
 *   the same platform and unit (the `not-comparable` case).
 * - `ATLAS_MINI` — the schema's bare minimum: no context window, no maximum
 *   output, no parameters, no licence, no API identifier, no deployment, no
 *   price, no benchmark result (the `unrecorded` case, across every group).
 * - `ATLAS_OPEN` — downloadable weights under a licence the OSI has not
 *   approved, so "downloadable" and "open source" can be seen to disagree.
 * - `ATLAS_EXTRA` — a fifth release, existing only so a five-slug selection can
 *   overflow the four-model ceiling against real records.
 */
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Deployment,
  ModelFamily,
  ModelRelease,
  Organization,
  PricingRecord,
  Publisher,
  ServingPlatform,
  SourceReference,
} from '../../src/data/schema';
import type { ComparisonDataset } from '../../src/lib/comparison';
import { precisionOf } from '../../src/data/partial-date';

/** The build date every fixture-driven expectation is computed against. */
export const COMPARISON_TODAY = '2026-08-27';

/** The base path expectations are built against, matching `astro.config.mjs`. */
export const COMPARISON_BASE = '/ModelTree/';

export const ATLAS_PRO = 'atlas-pro';
export const BOREALIS_AIR = 'borealis-air';
export const ATLAS_MINI = 'atlas-mini';
export const ATLAS_OPEN = 'atlas-open';
export const ATLAS_EXTRA = 'atlas-extra';

/** The benchmark whose results clear the comparability policy. */
export const COMPARABLE_BENCHMARK = 'atlas-bench';
/** The benchmark whose results disagree on a blocking dimension. */
export const BLOCKED_BENCHMARK = 'strict-bench';

const organizations: Organization[] = [
  {
    id: 'northwind-labs',
    slug: 'northwind-labs',
    name: 'Northwind Labs',
    shortName: 'Northwind',
    type: 'research-lab',
    website: 'https://northwind.example.com',
    releasePage: 'https://northwind.example.com/releases',
    description: 'A fictional model creator used only by tests.',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'eastwind-cloud',
    slug: 'eastwind-cloud',
    name: 'Eastwind Cloud',
    shortName: 'Eastwind',
    type: 'company',
    website: 'https://eastwind.example.com',
    releasePage: 'https://eastwind.example.com/releases',
    description: 'A fictional platform operator used only by tests.',
    sourceIds: ['eastwind-pricing'],
    verifiedAt: '2026-08-01',
  },
];

const publishers: Publisher[] = [
  { id: 'northwind-voice', name: 'Northwind Labs', organizationId: 'northwind-labs' },
  { id: 'eastwind-voice', name: 'Eastwind Cloud', organizationId: 'eastwind-cloud' },
];

const sources: SourceReference[] = [
  {
    id: 'northwind-docs',
    url: 'https://northwind.example.com/docs',
    title: 'Northwind Labs documentation',
    type: 'official-docs',
    publisherId: 'northwind-voice',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'northwind-card',
    url: 'https://northwind.example.com/cards/atlas-pro',
    title: 'Atlas Pro model card',
    type: 'model-card',
    publisherId: 'northwind-voice',
    publishedDate: '2026-02-10',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'eastwind-pricing',
    url: 'https://eastwind.example.com/pricing',
    title: 'Eastwind Cloud pricing',
    type: 'official-docs',
    publisherId: 'eastwind-voice',
    lastCheckedDate: '2026-08-20',
  },
  {
    id: 'eastwind-regions',
    url: 'https://eastwind.example.com/regions',
    title: 'Eastwind Cloud regional availability',
    type: 'official-docs',
    publisherId: 'eastwind-voice',
    lastCheckedDate: '2026-08-20',
  },
];

const families: ModelFamily[] = [
  {
    id: 'atlas-family',
    slug: 'atlas-family',
    organizationId: 'northwind-labs',
    name: 'Atlas',
    description: 'A fictional family used only by tests.',
    categories: ['language-reasoning'],
    firstReleaseDate: '2025-06-01',
    datePrecision: precisionOf('2025-06-01'),
    status: 'current',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'borealis-family',
    slug: 'borealis-family',
    organizationId: 'northwind-labs',
    name: 'Borealis',
    description: 'A second fictional family, so a comparison can cross families.',
    categories: ['language-reasoning'],
    firstReleaseDate: '2025-02-01',
    datePrecision: precisionOf('2025-02-01'),
    status: 'legacy',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-01',
  },
];

const releases: ModelRelease[] = [
  {
    id: 'atlas-pro-release',
    slug: ATLAS_PRO,
    canonicalName: 'Northwind Atlas Pro 2',
    displayName: 'Atlas Pro',
    organizationId: 'northwind-labs',
    familyId: 'atlas-family',
    version: '2',
    variant: 'base',
    releaseDate: '2026-02-10',
    datePrecision: 'day',
    status: 'current',
    featured: true,
    featuredRationale: 'it exercises every populated branch of the comparison',
    categories: ['language-reasoning', 'coding'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    accessType: 'open-weight',
    license: {
      name: 'Northwind Permissive Licence 1.0',
      spdxId: 'Apache-2.0',
      url: 'https://northwind.example.com/licences/permissive',
      weightsDownloadable: true,
      osiApproved: true,
    },
    parameters: { totalBillions: 120, activeBillions: 12 },
    contextWindow: 200_000,
    maximumOutput: 32_000,
    apiAliases: ['atlas-pro-2', 'atlas-pro-2-2026-02-10'],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A fictional release with every optional field populated.',
    intendedUse: 'Long-context reasoning and code generation.',
    sourceIds: ['northwind-card', 'northwind-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: 'borealis-air-release',
    slug: BOREALIS_AIR,
    canonicalName: 'Northwind Borealis Air 1',
    displayName: 'Borealis Air',
    organizationId: 'northwind-labs',
    familyId: 'borealis-family',
    version: '1',
    variant: 'air',
    releaseDate: '2025-11-04',
    datePrecision: 'day',
    // Superseded by its own creator, which is what the lifecycle takeaway reads.
    status: 'legacy',
    featured: false,
    categories: ['language-reasoning'],
    // One input modality against Atlas Pro's two, so the modality rule fires.
    inputModalities: ['text'],
    outputModalities: ['text'],
    // Hosted-only, so it carries no licence record at all.
    accessType: 'proprietary-hosted',
    contextWindow: 64_000,
    maximumOutput: 8_000,
    apiAliases: ['borealis-air-1'],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A fictional hosted-only release priced in a second currency.',
    intendedUse: 'Low-latency chat.',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: 'atlas-mini-release',
    slug: ATLAS_MINI,
    canonicalName: 'Northwind Atlas Mini',
    displayName: 'Atlas Mini',
    organizationId: 'northwind-labs',
    familyId: 'atlas-family',
    version: '1',
    variant: 'mini',
    // The announcement gave a month, so `datePrecision` decides how it prints.
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
    intendedUse: 'Exercising the comparison when almost nothing is recorded.',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: 'atlas-open-release',
    slug: ATLAS_OPEN,
    canonicalName: 'Northwind Atlas Open',
    displayName: 'Atlas Open',
    organizationId: 'northwind-labs',
    familyId: 'atlas-family',
    version: '1',
    variant: 'open',
    releaseDate: '2026-04-05',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'open-weight',
    license: {
      name: 'Northwind Community Licence 2.0',
      // No SPDX id, and the OSI has not approved it. Downloadable weights under
      // terms that are not open source is the case the wording must get right.
      url: 'https://northwind.example.com/licences/community',
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
    intendedUse: 'Self-hosted assistants.',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: 'atlas-extra-release',
    slug: ATLAS_EXTRA,
    canonicalName: 'Northwind Atlas Extra',
    displayName: 'Atlas Extra',
    organizationId: 'northwind-labs',
    familyId: 'atlas-family',
    version: '1',
    variant: 'extra',
    releaseDate: '2026-05-05',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    contextWindow: 16_000,
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A fifth fictional release, so a selection can exceed the ceiling.',
    intendedUse: 'Exercising the four-model ceiling.',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
];

const servingPlatforms: ServingPlatform[] = [
  {
    id: 'eastwind-api',
    slug: 'eastwind-api',
    name: 'Eastwind API',
    organizationId: 'eastwind-cloud',
    type: 'cloud-platform',
    website: 'https://eastwind.example.com/api',
    sourceIds: ['eastwind-pricing'],
    verifiedAt: '2026-08-20',
  },
  {
    // Serves Atlas Pro only, so the other columns show an unrecorded cell rather
    // than the row disappearing. Which platform is missing is the comparison.
    id: 'eastwind-hub',
    slug: 'eastwind-hub',
    name: 'Eastwind Hub',
    organizationId: 'eastwind-cloud',
    type: 'model-hub',
    website: 'https://hub.eastwind.example.com',
    sourceIds: ['eastwind-regions'],
    verifiedAt: '2026-08-20',
  },
];

const deployments: Deployment[] = [
  {
    id: 'atlas-pro-hosted',
    releaseId: 'atlas-pro-release',
    platformId: 'eastwind-api',
    deliveryMode: 'hosted-api',
    apiIdentifier: 'atlas-pro-2',
    regions: ['us-east', 'eu-west'],
    effectiveFrom: '2026-02-10',
    sourceIds: ['eastwind-regions'],
    verifiedAt: '2026-08-20',
  },
  {
    id: 'atlas-pro-weights',
    releaseId: 'atlas-pro-release',
    platformId: 'eastwind-hub',
    deliveryMode: 'downloadable-weights',
    regions: [],
    effectiveFrom: '2026-02-10',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-20',
  },
  {
    id: 'borealis-air-hosted',
    releaseId: 'borealis-air-release',
    platformId: 'eastwind-api',
    deliveryMode: 'hosted-api',
    regions: ['eu-west'],
    effectiveFrom: '2025-11-04',
    sourceIds: ['eastwind-regions'],
    verifiedAt: '2026-08-20',
  },
  {
    id: 'atlas-open-hosted',
    releaseId: 'atlas-open-release',
    platformId: 'eastwind-hub',
    deliveryMode: 'downloadable-weights',
    regions: [],
    effectiveFrom: '2026-04-05',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-20',
  },
];

const pricing: PricingRecord[] = [
  {
    // Closed range, superseded by the record below. Present so "the current
    // price is the one shown" is a claim with something to be wrong about.
    id: 'atlas-pro-price-old',
    deploymentId: 'atlas-pro-hosted',
    currency: 'USD',
    unit: 'per-1m-tokens',
    rates: { input: 0.5, output: 2 },
    effectiveFrom: '2026-02-10',
    effectiveTo: '2026-05-31',
    sourceIds: ['eastwind-pricing'],
    verifiedAt: '2026-08-20',
  },
  {
    id: 'atlas-pro-price-current',
    deploymentId: 'atlas-pro-hosted',
    currency: 'USD',
    unit: 'per-1m-tokens',
    rates: { input: 0.35, cachedInput: 0.035, output: 1.4 },
    region: 'us-east',
    processingTier: 'Standard',
    effectiveFrom: '2026-06-01',
    sourceIds: ['eastwind-pricing'],
    verifiedAt: '2026-08-20',
  },
  {
    // Same platform, same unit, same rate keys as Atlas Pro, published in a
    // different currency. This is the only way a row reaches `not-comparable`
    // without a benchmark, and converting it would publish a figure no source
    // states.
    id: 'borealis-air-price',
    deploymentId: 'borealis-air-hosted',
    currency: 'EUR',
    unit: 'per-1m-tokens',
    rates: { input: 0.3, output: 1.2 },
    region: 'eu-west',
    effectiveFrom: '2025-11-04',
    sourceIds: ['eastwind-pricing'],
    verifiedAt: '2026-08-20',
  },
];

const benchmarks: BenchmarkDefinition[] = [
  {
    id: COMPARABLE_BENCHMARK,
    slug: COMPARABLE_BENCHMARK,
    name: 'Atlas Bench',
    domain: 'general-reasoning',
    owner: 'Northwind Labs',
    metric: 'Accuracy',
    metricUnit: '%',
    direction: 'higher-is-better',
    datasetVersion: '1.0',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
  {
    id: BLOCKED_BENCHMARK,
    slug: BLOCKED_BENCHMARK,
    name: 'Strict Bench',
    domain: 'coding',
    owner: 'Northwind Labs',
    metric: 'Pass@1',
    metricUnit: '%',
    direction: 'higher-is-better',
    datasetVersion: '2.0',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
];

const benchmarkResults: BenchmarkResult[] = [
  // Every blocking dimension agrees, so this pair clears the policy and shares
  // one row.
  {
    id: 'atlas-bench-atlas-pro',
    benchmarkId: COMPARABLE_BENCHMARK,
    benchmarkVersion: '1.0',
    releaseId: 'atlas-pro-release',
    score: 88.2,
    unit: '%',
    evaluationDate: '2026-02-15',
    variantNote: 'instruction-tuned',
    reasoningMode: 'standard',
    toolsEnabled: false,
    harness: 'northwind-eval 0.4',
    resultType: 'official',
    sourceIds: ['northwind-card'],
    verifiedAt: '2026-08-15',
  },
  {
    id: 'atlas-bench-borealis-air',
    benchmarkId: COMPARABLE_BENCHMARK,
    benchmarkVersion: '1.0',
    releaseId: 'borealis-air-release',
    score: 81.5,
    unit: '%',
    evaluationDate: '2026-03-01',
    variantNote: 'instruction-tuned',
    reasoningMode: 'standard',
    toolsEnabled: false,
    harness: 'northwind-eval 0.4',
    resultType: 'official',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
  // Both disclose a harness and the harnesses differ, which the policy treats as
  // blocking. Both scores are published, and neither may be read against the
  // other.
  {
    id: 'strict-bench-atlas-pro',
    benchmarkId: BLOCKED_BENCHMARK,
    benchmarkVersion: '2.0',
    releaseId: 'atlas-pro-release',
    score: 74.0,
    unit: '%',
    evaluationDate: '2026-02-20',
    variantNote: 'instruction-tuned',
    reasoningMode: 'standard',
    toolsEnabled: false,
    harness: 'northwind-eval 0.4',
    resultType: 'official',
    sourceIds: ['northwind-card'],
    verifiedAt: '2026-08-15',
  },
  {
    id: 'strict-bench-borealis-air',
    benchmarkId: BLOCKED_BENCHMARK,
    benchmarkVersion: '2.0',
    releaseId: 'borealis-air-release',
    score: 79.0,
    unit: '%',
    evaluationDate: '2026-02-22',
    variantNote: 'instruction-tuned',
    reasoningMode: 'standard',
    toolsEnabled: false,
    harness: 'eastwind-runner 2.1',
    resultType: 'official',
    sourceIds: ['northwind-docs'],
    verifiedAt: '2026-08-15',
  },
];

export const comparisonFixtures: ComparisonDataset = {
  sources,
  publishers,
  organizations,
  families,
  releases,
  servingPlatforms,
  deployments,
  pricing,
  benchmarks,
  benchmarkResults,
};

/**
 * The same records with every operational entity type emptied, which is the
 * shape `raw.ts` actually composes. Separating `not-collected` from `unrecorded`
 * needs both datasets: one where ModelTree holds no records of a kind at all,
 * and one where it holds some that miss these particular models.
 */
export const comparisonFixturesWithoutOperations: ComparisonDataset = {
  ...comparisonFixtures,
  servingPlatforms: [],
  deployments: [],
  pricing: [],
  benchmarks: [],
  benchmarkResults: [],
};
