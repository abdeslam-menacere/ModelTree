import { datasetSchema, type Dataset, type ModelRelease, type SourceReference } from './schema';

const PRIMARY_SOURCE_TYPES = new Set<SourceReference['type']>([
  'official-announcement',
  'official-docs',
  'model-card',
  'repository',
]);

export class DataValidationError extends Error {
  constructor(issues: string[]) {
    super(`ModelTree data validation failed:\n- ${issues.join('\n- ')}`);
    this.name = 'DataValidationError';
  }
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return [...duplicates];
}

function addDuplicateIssues(
  issues: string[],
  entity: string,
  field: string,
  values: string[],
) {
  for (const duplicate of duplicateValues(values)) {
    issues.push(`duplicate ${entity} ${field} "${duplicate}"`);
  }
}

function addMissingReferences(
  issues: string[],
  owner: string,
  field: string,
  ids: string[],
  validIds: Set<string>,
) {
  for (const id of ids) {
    if (!validIds.has(id)) issues.push(`${owner}.${field} references missing id "${id}"`);
  }
}

function validateReleaseRelationships(
  release: ModelRelease,
  releaseById: Map<string, ModelRelease>,
  issues: string[],
) {
  const relationshipFields = ['predecessorIds', 'successorIds', 'siblingIds'] as const;

  for (const field of relationshipFields) {
    for (const relatedId of release[field]) {
      const related = releaseById.get(relatedId);
      if (!related) {
        issues.push(`release ${release.id}.${field} references missing id "${relatedId}"`);
        continue;
      }
      if (relatedId === release.id) {
        issues.push(`release ${release.id}.${field} cannot reference itself`);
      }
      if (related.familyId !== release.familyId) {
        issues.push(`release ${release.id}.${field} must stay within family ${release.familyId}`);
      }
      if (field === 'siblingIds' && !related.siblingIds.includes(release.id)) {
        issues.push(`release ${release.id} sibling relationship with ${relatedId} is not reciprocal`);
      }
    }
  }
}

export function validateDataset(input: unknown): Dataset {
  const parsed = datasetSchema.safeParse(input);
  if (!parsed.success) {
    throw new DataValidationError(parsed.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'dataset';
      return `${path}: ${issue.message}`;
    }));
  }

  const data = parsed.data;
  const issues: string[] = [];

  addDuplicateIssues(issues, 'source', 'id', data.sources.map(({ id }) => id));
  addDuplicateIssues(issues, 'source', 'url', data.sources.map(({ url }) => url));
  addDuplicateIssues(issues, 'organization', 'id', data.organizations.map(({ id }) => id));
  addDuplicateIssues(issues, 'organization', 'slug', data.organizations.map(({ slug }) => slug));
  addDuplicateIssues(issues, 'family', 'id', data.families.map(({ id }) => id));
  addDuplicateIssues(issues, 'family', 'slug', data.families.map(({ slug }) => slug));
  addDuplicateIssues(issues, 'release', 'id', data.releases.map(({ id }) => id));
  addDuplicateIssues(issues, 'release', 'slug', data.releases.map(({ slug }) => slug));
  addDuplicateIssues(issues, 'API alias', 'value', data.releases.flatMap(({ apiAliases }) => apiAliases));

  const sourceById = new Map(data.sources.map((source) => [source.id, source]));
  const sourceIds = new Set(sourceById.keys());
  const organizationById = new Map(data.organizations.map((organization) => [organization.id, organization]));
  const familyById = new Map(data.families.map((family) => [family.id, family]));
  const releaseById = new Map(data.releases.map((release) => [release.id, release]));

  for (const source of data.sources) {
    if (source.publishedDate && source.publishedDate > source.lastCheckedDate) {
      issues.push(`source ${source.id} was checked before its published date`);
    }
  }

  for (const organization of data.organizations) {
    addMissingReferences(issues, `organization ${organization.id}`, 'sourceIds', organization.sourceIds, sourceIds);
  }

  for (const family of data.families) {
    if (!organizationById.has(family.organizationId)) {
      issues.push(`family ${family.id}.organizationId references missing id "${family.organizationId}"`);
    }
    addMissingReferences(issues, `family ${family.id}`, 'sourceIds', family.sourceIds, sourceIds);
  }

  for (const release of data.releases) {
    const family = familyById.get(release.familyId);
    if (!organizationById.has(release.organizationId)) {
      issues.push(`release ${release.id}.organizationId references missing id "${release.organizationId}"`);
    }
    if (!family) {
      issues.push(`release ${release.id}.familyId references missing id "${release.familyId}"`);
    } else {
      if (family.organizationId !== release.organizationId) {
        issues.push(`release ${release.id} organization does not match family ${family.id}`);
      }
      if (release.releaseDate < family.firstReleaseDate) {
        issues.push(`release ${release.id} predates family ${family.id}`);
      }
    }
    if (release.releaseDate > release.verifiedAt) {
      issues.push(`release ${release.id} was verified before its release date`);
    }
    addMissingReferences(issues, `release ${release.id}`, 'sourceIds', release.sourceIds, sourceIds);
    validateReleaseRelationships(release, releaseById, issues);

    if (release.featured) {
      const hasPrimarySource = release.sourceIds.some((sourceId) => {
        const source = sourceById.get(sourceId);
        return source ? PRIMARY_SOURCE_TYPES.has(source.type) : false;
      });
      if (!hasPrimarySource) issues.push(`featured release ${release.id} requires a primary source`);
    }
  }

  if (issues.length) throw new DataValidationError(issues);
  return data;
}