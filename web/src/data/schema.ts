import { z } from 'zod';

const entityId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const slug = entityId;

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, 'must be a real calendar date in YYYY-MM-DD format');

/** A date a source states only to the year or month. Precision is never guessed. */
export const partialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  if (month !== undefined && (month < 1 || month > 12)) return false;
  if (day === undefined) return true;

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, 'must be a real date written as YYYY, YYYY-MM, or YYYY-MM-DD');

export const datePrecision = z.enum(['year', 'month', 'day']);
export const lifecycleStatus = z.enum(['preview', 'current', 'legacy', 'deprecated', 'research']);
export const modality = z.enum(['text', 'image', 'audio', 'video']);

export const modelCategory = z.enum([
  'language-reasoning',
  'multimodal-generalist',
  'coding',
  'image',
  'video',
  'audio-speech',
  'embedding-reranking',
  'scientific',
  'robotics-world',
]);

export const accessType = z.enum([
  'proprietary-hosted',
  'open-weight',
  'source-available',
  'both',
]);

// Downloadable weights and OSI-approved licensing are separate claims. A model
// may permit the first while failing the second, so neither implies the other.
export const licenseSchema = z.object({
  name: z.string().min(1),
  spdxId: z.string().min(1).optional(),
  url: z.url().optional(),
  weightsDownloadable: z.boolean(),
  osiApproved: z.boolean(),
});

export const parameterCountSchema = z.object({
  totalBillions: z.number().positive().optional(),
  activeBillions: z.number().positive().optional(),
});

export const sourceSchema = z.object({
  id: entityId,
  url: z.url(),
  title: z.string().min(1),
  type: z.enum([
    'official-announcement',
    'official-docs',
    'model-card',
    'repository',
    'benchmark-owner',
    'independent-evaluation',
  ]),
  publisher: z.string().min(1),
  publishedDate: isoDate.optional(),
  lastCheckedDate: isoDate,
  notes: z.string().min(1).optional(),
});

export const organizationSchema = z.object({
  id: entityId,
  slug,
  name: z.string().min(1),
  shortName: z.string().min(1),
  type: z.enum(['company', 'research-lab', 'nonprofit', 'community']),
  website: z.url(),
  releasePage: z.url(),
  description: z.string().min(1),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const familySchema = z.object({
  id: entityId,
  slug,
  organizationId: entityId,
  name: z.string().min(1),
  description: z.string().min(1),
  categories: z.array(modelCategory).min(1),
  firstReleaseDate: isoDate,
  status: lifecycleStatus,
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const releaseSchema = z.object({
  id: entityId,
  slug,
  canonicalName: z.string().min(1),
  displayName: z.string().min(1),
  organizationId: entityId,
  familyId: entityId,
  version: z.string().min(1),
  variant: z.string().min(1),
  releaseDate: isoDate,
  datePrecision,
  status: lifecycleStatus,
  featured: z.boolean(),
  featuredRationale: z.string().min(1).optional(),
  categories: z.array(modelCategory).min(1),
  inputModalities: z.array(modality).min(1),
  outputModalities: z.array(modality).min(1),
  accessType,
  license: licenseSchema.optional(),
  parameters: parameterCountSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  maximumOutput: z.number().int().positive().optional(),
  apiAliases: z.array(z.string().min(1)),
  predecessorIds: z.array(entityId),
  successorIds: z.array(entityId),
  siblingIds: z.array(entityId),
  derivedFromIds: z.array(entityId).default([]),
  summary: z.string().min(1),
  intendedUse: z.string().min(1),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
}).superRefine((release, context) => {
  if (release.featured && !release.featuredRationale) {
    context.addIssue({
      code: 'custom',
      path: ['featuredRationale'],
      message: 'is required for a featured release',
    });
  }

  const claimsWeights = release.accessType === 'open-weight' || release.accessType === 'both';
  if (claimsWeights && !release.license) {
    context.addIssue({
      code: 'custom',
      path: ['license'],
      message: 'is required when a release claims downloadable weights',
    });
  }
  if (claimsWeights && release.license && !release.license.weightsDownloadable) {
    context.addIssue({
      code: 'custom',
      path: ['license', 'weightsDownloadable'],
      message: 'contradicts an open-weight access type',
    });
  }
  if (release.license?.osiApproved && !release.license.spdxId && !release.license.url) {
    context.addIssue({
      code: 'custom',
      path: ['license'],
      message: 'an OSI-approved claim needs an spdxId or a licence URL as evidence',
    });
  }
});

export const productSchema = z.object({
  id: entityId,
  slug,
  name: z.string().min(1),
  organizationId: entityId,
  description: z.string().min(1),
  // A product may route between models; that is not the same as naming one.
  modelSelection: z.enum(['fixed', 'routed', 'unknown']),
  releaseIds: z.array(entityId).default([]),
  availabilityNotes: z.string().min(1).optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const servingPlatformSchema = z.object({
  id: entityId,
  slug,
  name: z.string().min(1),
  // The organization operating the platform, which is rarely the model creator.
  organizationId: entityId,
  type: z.enum([
    'first-party-api',
    'cloud-platform',
    'aggregator',
    'model-hub',
    'local-runtime',
  ]),
  website: z.url(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const deploymentSchema = z.object({
  id: entityId,
  releaseId: entityId,
  platformId: entityId,
  deliveryMode: z.enum([
    'hosted-api',
    'managed-endpoint',
    'downloadable-weights',
    'local-runtime',
  ]),
  apiIdentifier: z.string().min(1).optional(),
  regions: z.array(z.string().min(1)).default([]),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const pricingRecordSchema = z.object({
  id: entityId,
  deploymentId: entityId,
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter ISO 4217 code'),
  unit: z.enum([
    'per-1m-tokens',
    'per-1k-tokens',
    'per-image',
    'per-minute',
    'per-request',
  ]),
  rates: z.object({
    input: z.number().nonnegative().optional(),
    cachedInput: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    batchInput: z.number().nonnegative().optional(),
    batchOutput: z.number().nonnegative().optional(),
  }),
  region: z.string().min(1).optional(),
  processingTier: z.string().min(1).optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const benchmarkDefinitionSchema = z.object({
  id: entityId,
  slug,
  name: z.string().min(1),
  domain: z.enum([
    'general-reasoning',
    'mathematics',
    'coding',
    'tool-use-agents',
    'multimodal',
    'long-context',
    'human-preference',
    'operational',
  ]),
  owner: z.string().min(1),
  metric: z.string().min(1),
  metricUnit: z.string().min(1),
  direction: z.enum(['higher-is-better', 'lower-is-better']),
  datasetVersion: z.string().min(1).optional(),
  methodologyNotes: z.string().min(1).optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const benchmarkResultSchema = z.object({
  id: entityId,
  benchmarkId: entityId,
  benchmarkVersion: z.string().min(1),
  releaseId: entityId,
  variantNote: z.string().min(1).optional(),
  score: z.number().finite(),
  unit: z.string().min(1),
  evaluationDate: partialDate,
  // Configuration that decides whether two results may be compared at all.
  reasoningMode: z.string().min(1).optional(),
  toolsEnabled: z.boolean().optional(),
  harness: z.string().min(1).optional(),
  resultType: z.enum(['official', 'independent']),
  caveats: z.string().min(1).optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const releaseEventSchema = z.object({
  id: entityId,
  releaseId: entityId,
  type: z.enum([
    'announced',
    'preview',
    'api-available',
    'generally-available',
    'deprecated',
    'retired',
    'corrected',
  ]),
  date: partialDate,
  datePrecision,
  note: z.string().min(1),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

/**
 * How a usage figure was produced. The category decides how the observation is
 * labelled and whether it may support a cross-source synthesis; it is never a
 * quality ranking of the source.
 */
export const usageSourceCategory = z.enum([
  'creator-self-report',
  'platform-operator-report',
  'independent-measurement',
  'developer-survey',
  'community-signal',
]);

/** The coarse shape of what was counted. Never converted between kinds. */
export const usageMetricKind = z.enum([
  'active-users',
  'developer-accounts',
  'requests',
  'tokens',
  'downloads',
  'deployments',
  'repository-signal',
  'survey-share',
]);

export const usageObservationSchema = z.object({
  id: entityId,
  releaseId: entityId,
  metric: usageMetricKind,
  // The metric as the source itself names it, so two figures are never merged
  // because a coarse kind happens to match.
  metricLabel: z.string().min(1),
  unit: z.string().min(1),
  // Exactly who or what was counted. Two observations of the same metric over
  // different populations are separate facts, not two readings of one fact.
  population: z.string().min(1),
  value: z.number().optional(),
  // Always required: the claim as stated, so a missing numeric value still
  // renders something a reader can check against the source.
  valueAsStated: z.string().min(1),
  windowStart: partialDate,
  windowEnd: partialDate,
  methodology: z.string().min(1),
  sourceCategory: usageSourceCategory,
  sourceIds: z.array(entityId).min(1),
  scope: z.string().min(1),
  caveats: z.array(z.string().min(1)).min(1),
  // Conflicting readings stay side by side; nothing picks a winner.
  conflictsWithIds: z.array(entityId).default([]),
  verifiedAt: isoDate,
});

export const usageSynthesisSchema = z.object({
  id: entityId,
  releaseId: entityId,
  statement: z.string().min(1),
  observationIds: z.array(entityId).min(2),
  // A synthesis may report agreement or disagreement; it may not resolve it.
  agreement: z.enum(['agreeing', 'conflicting']),
  comparabilityNote: z.string().min(1),
  caveats: z.array(z.string().min(1)).min(1),
  verifiedAt: isoDate,
});

export const datasetSchema = z.object({
  sources: z.array(sourceSchema).min(1),
  organizations: z.array(organizationSchema).min(1),
  families: z.array(familySchema).min(1),
  releases: z.array(releaseSchema).min(1),
  products: z.array(productSchema).default([]),
  servingPlatforms: z.array(servingPlatformSchema).default([]),
  deployments: z.array(deploymentSchema).default([]),
  pricing: z.array(pricingRecordSchema).default([]),
  benchmarks: z.array(benchmarkDefinitionSchema).default([]),
  benchmarkResults: z.array(benchmarkResultSchema).default([]),
  releaseEvents: z.array(releaseEventSchema).default([]),
  usageObservations: z.array(usageObservationSchema).default([]),
  usageSyntheses: z.array(usageSynthesisSchema).default([]),
});

export type SourceReference = z.infer<typeof sourceSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type ModelFamily = z.infer<typeof familySchema>;
export type ModelRelease = z.infer<typeof releaseSchema>;
export type Product = z.infer<typeof productSchema>;
export type ServingPlatform = z.infer<typeof servingPlatformSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type PricingRecord = z.infer<typeof pricingRecordSchema>;
export type BenchmarkDefinition = z.infer<typeof benchmarkDefinitionSchema>;
export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;
export type ReleaseEvent = z.infer<typeof releaseEventSchema>;
export type UsageSourceCategory = z.infer<typeof usageSourceCategory>;
export type UsageMetricKind = z.infer<typeof usageMetricKind>;
export type UsageObservation = z.infer<typeof usageObservationSchema>;
export type UsageSynthesis = z.infer<typeof usageSynthesisSchema>;
export type Dataset = z.infer<typeof datasetSchema>;