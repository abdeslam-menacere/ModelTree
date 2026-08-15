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
  categories: z.array(z.enum([
    'language-reasoning',
    'multimodal-generalist',
    'coding',
  ])).min(1),
  firstReleaseDate: isoDate,
  status: z.enum(['preview', 'current', 'legacy', 'deprecated', 'research']),
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
  datePrecision: z.literal('day'),
  status: z.enum(['preview', 'current', 'legacy', 'deprecated', 'research']),
  featured: z.boolean(),
  featuredRationale: z.string().min(1).optional(),
  categories: z.array(z.enum([
    'language-reasoning',
    'multimodal-generalist',
    'coding',
  ])).min(1),
  inputModalities: z.array(z.enum(['text', 'image', 'audio', 'video'])).min(1),
  outputModalities: z.array(z.enum(['text', 'image', 'audio', 'video'])).min(1),
  accessType: z.enum([
    'proprietary-hosted',
    'open-weight',
    'source-available',
    'both',
  ]),
  contextWindow: z.number().int().positive().optional(),
  maximumOutput: z.number().int().positive().optional(),
  apiAliases: z.array(z.string().min(1)),
  predecessorIds: z.array(entityId),
  successorIds: z.array(entityId),
  siblingIds: z.array(entityId),
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
});

export const datasetSchema = z.object({
  sources: z.array(sourceSchema).min(1),
  organizations: z.array(organizationSchema).min(1),
  families: z.array(familySchema).min(1),
  releases: z.array(releaseSchema).min(1),
});

export type SourceReference = z.infer<typeof sourceSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type ModelFamily = z.infer<typeof familySchema>;
export type ModelRelease = z.infer<typeof releaseSchema>;
export type Dataset = z.infer<typeof datasetSchema>;