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

function addEffectiveRangeIssues(
  issues: string[],
  owner: string,
  record: { effectiveFrom: string; effectiveTo?: string; verifiedAt: string },
) {
  if (record.effectiveTo && record.effectiveTo < record.effectiveFrom) {
    issues.push(`${owner} ends before it takes effect`);
  }
  if (record.effectiveFrom > record.verifiedAt) {
    issues.push(`${owner} was verified before it takes effect`);
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

    // Derivation may cross families and organizations, so it is checked apart
    // from the within-family relationship fields.
    for (const derivedFrom of release.derivedFromIds) {
      if (!releaseById.has(derivedFrom)) {
        issues.push(`release ${release.id}.derivedFromIds references missing id "${derivedFrom}"`);
      }
      if (derivedFrom === release.id) {
        issues.push(`release ${release.id}.derivedFromIds cannot reference itself`);
      }
    }
  }

  addDuplicateIssues(issues, 'product', 'id', data.products.map(({ id }) => id));
  addDuplicateIssues(issues, 'product', 'slug', data.products.map(({ slug }) => slug));
  addDuplicateIssues(issues, 'serving platform', 'id', data.servingPlatforms.map(({ id }) => id));
  addDuplicateIssues(issues, 'serving platform', 'slug', data.servingPlatforms.map(({ slug }) => slug));
  addDuplicateIssues(issues, 'deployment', 'id', data.deployments.map(({ id }) => id));
  addDuplicateIssues(issues, 'pricing record', 'id', data.pricing.map(({ id }) => id));
  addDuplicateIssues(issues, 'benchmark', 'id', data.benchmarks.map(({ id }) => id));
  addDuplicateIssues(issues, 'benchmark', 'slug', data.benchmarks.map(({ slug }) => slug));
  addDuplicateIssues(issues, 'benchmark result', 'id', data.benchmarkResults.map(({ id }) => id));
  addDuplicateIssues(issues, 'release event', 'id', data.releaseEvents.map(({ id }) => id));

  const releaseIds = new Set(releaseById.keys());
  const organizationIds = new Set(organizationById.keys());
  const platformById = new Map(data.servingPlatforms.map((platform) => [platform.id, platform]));
  const deploymentById = new Map(data.deployments.map((deployment) => [deployment.id, deployment]));
  const benchmarkById = new Map(data.benchmarks.map((benchmark) => [benchmark.id, benchmark]));

  for (const product of data.products) {
    if (!organizationIds.has(product.organizationId)) {
      issues.push(`product ${product.id}.organizationId references missing id "${product.organizationId}"`);
    }
    addMissingReferences(issues, `product ${product.id}`, 'releaseIds', product.releaseIds, releaseIds);
    addMissingReferences(issues, `product ${product.id}`, 'sourceIds', product.sourceIds, sourceIds);
    addEffectiveRangeIssues(issues, `product ${product.id}`, product);
    if (product.modelSelection === 'fixed' && product.releaseIds.length === 0) {
      issues.push(`product ${product.id} claims a fixed model but names no release`);
    }
  }

  for (const platform of data.servingPlatforms) {
    if (!organizationIds.has(platform.organizationId)) {
      issues.push(`serving platform ${platform.id}.organizationId references missing id "${platform.organizationId}"`);
    }
    addMissingReferences(issues, `serving platform ${platform.id}`, 'sourceIds', platform.sourceIds, sourceIds);
  }

  for (const deployment of data.deployments) {
    if (!releaseIds.has(deployment.releaseId)) {
      issues.push(`deployment ${deployment.id}.releaseId references missing id "${deployment.releaseId}"`);
    }
    if (!platformById.has(deployment.platformId)) {
      issues.push(`deployment ${deployment.id}.platformId references missing id "${deployment.platformId}"`);
    }
    addMissingReferences(issues, `deployment ${deployment.id}`, 'sourceIds', deployment.sourceIds, sourceIds);
    addEffectiveRangeIssues(issues, `deployment ${deployment.id}`, deployment);
  }

  for (const price of data.pricing) {
    const deployment = deploymentById.get(price.deploymentId);
    if (!deployment) {
      issues.push(`pricing record ${price.id}.deploymentId references missing id "${price.deploymentId}"`);
    } else if (deployment.deliveryMode === 'downloadable-weights') {
      issues.push(`pricing record ${price.id} prices downloadable weights, which have no per-unit rate`);
    }
    if (Object.values(price.rates).every((rate) => rate === undefined)) {
      issues.push(`pricing record ${price.id} states no rate`);
    }
    addMissingReferences(issues, `pricing record ${price.id}`, 'sourceIds', price.sourceIds, sourceIds);
    addEffectiveRangeIssues(issues, `pricing record ${price.id}`, price);
  }

  for (const benchmark of data.benchmarks) {
    addMissingReferences(issues, `benchmark ${benchmark.id}`, 'sourceIds', benchmark.sourceIds, sourceIds);
  }

  const resultSetups = new Set<string>();
  for (const result of data.benchmarkResults) {
    const benchmark = benchmarkById.get(result.benchmarkId);
    if (!benchmark) {
      issues.push(`benchmark result ${result.id}.benchmarkId references missing id "${result.benchmarkId}"`);
    } else if (benchmark.metricUnit !== result.unit) {
      issues.push(`benchmark result ${result.id} unit "${result.unit}" does not match benchmark ${benchmark.id} unit "${benchmark.metricUnit}"`);
    }
    if (!releaseIds.has(result.releaseId)) {
      issues.push(`benchmark result ${result.id}.releaseId references missing id "${result.releaseId}"`);
    }
    addMissingReferences(issues, `benchmark result ${result.id}`, 'sourceIds', result.sourceIds, sourceIds);

    // Two results for the same model under the same disclosed setup cannot both
    // be true, and silently keeping either would fabricate comparability.
    const setup = [
      result.benchmarkId,
      result.benchmarkVersion,
      result.releaseId,
      result.variantNote ?? '',
      result.reasoningMode ?? '',
      String(result.toolsEnabled ?? ''),
      result.harness ?? '',
    ].join('|');
    if (resultSetups.has(setup)) {
      issues.push(`benchmark result ${result.id} duplicates an existing result for the same model and setup`);
    }
    resultSetups.add(setup);
  }

  for (const event of data.releaseEvents) {
    if (!releaseIds.has(event.releaseId)) {
      issues.push(`release event ${event.id}.releaseId references missing id "${event.releaseId}"`);
    }
    addMissingReferences(issues, `release event ${event.id}`, 'sourceIds', event.sourceIds, sourceIds);

    const segments = event.date.split('-').length;
    const expected = { year: 1, month: 2, day: 3 }[event.datePrecision];
    if (segments !== expected) {
      issues.push(`release event ${event.id} date "${event.date}" does not match precision "${event.datePrecision}"`);
    }
    if (event.date > event.verifiedAt) {
      issues.push(`release event ${event.id} was verified before it happened`);
    }
  }

  if (issues.length) throw new DataValidationError(issues);
  return data;
}