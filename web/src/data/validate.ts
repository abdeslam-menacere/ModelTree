import {
  datasetSchema,
  type Dataset,
  type FitFactRef,
  type ModelFamily,
  type ModelRelease,
  type Publisher,
  type SourceReference,
  type UsageObservation,
} from './schema';
import { RUBRIC_DIMENSION_SUPPORT } from './model-fit-rubric';
import {
  earliestDay,
  isDefinitelyAfter,
  isDefinitelyBefore,
  latestDay,
  precisionMatchesValue,
  type DatePrecision,
} from './partial-date';

export const PRIMARY_SOURCE_TYPES = new Set<SourceReference['type']>([
  'official-announcement',
  'official-docs',
  'model-card',
  'repository',
]);

/**
 * Two observations may only be discussed together when they counted the same
 * thing, in the same unit, over the same population. Nothing is converted.
 */
export function comparabilityKey(observation: UsageObservation) {
  return [
    observation.metric,
    observation.unit.trim().toLowerCase(),
    observation.population.trim().toLowerCase(),
  ].join('|');
}

/**
 * A record that declares one precision and carries another states a date no
 * source gave. Families, releases and release events all pair a `partialDate`
 * with a `datePrecision`, and all three are held to this one rule rather than
 * to three copies of it. This is what closes the invented-day path: a `month`
 * record cannot smuggle a day in and then label it as though it had not.
 */
function addPrecisionIssue(
  issues: string[],
  owner: string,
  field: string,
  value: string,
  precision: DatePrecision,
) {
  if (!precisionMatchesValue(value, precision)) {
    issues.push(`${owner} ${field} "${value}" does not match precision "${precision}"`);
  }
}

/**
 * Publisher identity, resolved through the ownership graph. `groupRoot` walks the
 * `control.parentId` chain to the controlling company so that corporate siblings
 * (an arm and its parent, or two arms of one parent) resolve to a single voice.
 * Two publishers that merely share a display name have distinct ids and distinct
 * roots, so they stay two voices.
 */
function buildPublisherIndex(publishers: Publisher[]) {
  const byId = new Map(publishers.map((publisher) => [publisher.id, publisher]));
  const rootCache = new Map<string, string>();

  function groupRoot(publisherId: string): string {
    const cached = rootCache.get(publisherId);
    if (cached) return cached;

    const seen = new Set<string>();
    let current = publisherId;
    while (true) {
      if (seen.has(current)) break; // A cycle is reported separately.
      seen.add(current);
      const parent = byId.get(current)?.control?.parentId;
      if (!parent || !byId.has(parent)) break;
      current = parent;
    }

    rootCache.set(publisherId, current);
    return current;
  }

  return { byId, groupRoot };
}

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

/**
 * One structured fact a guidance statement rests on, resolved to the record it
 * points at. `subject` records what the fact describes, so a statement can be
 * held to facts about its own model.
 */
interface ResolvedFitFact {
  label: string;
  releaseId?: string;
  familyId?: string;
  sourceIds: string[];
  verifiedAt: string;
}

function describeFitFact(ref: FitFactRef) {
  switch (ref.kind) {
    case 'release-field':
      return `release field ${ref.field} on ${ref.releaseId}`;
    case 'family-field':
      return `family field ${ref.field} on ${ref.familyId}`;
    case 'release-event':
      return `release event ${ref.eventId}`;
    case 'benchmark-result':
      return `benchmark result ${ref.benchmarkResultId}`;
    case 'usage-observation':
      return `usage observation ${ref.usageObservationId}`;
    case 'pricing-record':
      return `pricing record ${ref.pricingRecordId}`;
  }
}

/**
 * Resolves a fact reference against the dataset, or explains why it does not
 * resolve. A field reference must also name a field the record actually holds:
 * guidance about a context window cannot be derived from a release that
 * documents none.
 */
function resolveFitFact(
  ref: FitFactRef,
  data: Dataset,
  indexes: {
    releaseById: Map<string, ModelRelease>;
    familyById: Map<string, ModelFamily>;
  },
): ResolvedFitFact | string {
  const label = describeFitFact(ref);

  switch (ref.kind) {
    case 'release-field': {
      const release = indexes.releaseById.get(ref.releaseId);
      if (!release) return `cites ${label}, which references a missing release`;
      if (release[ref.field] === undefined) {
        return `cites ${label}, which the release does not record`;
      }
      return {
        label,
        releaseId: release.id,
        sourceIds: release.sourceIds,
        verifiedAt: release.verifiedAt,
      };
    }
    case 'family-field': {
      const family = indexes.familyById.get(ref.familyId);
      if (!family) return `cites ${label}, which references a missing family`;
      if (family[ref.field] === undefined) {
        return `cites ${label}, which the family does not record`;
      }
      return {
        label,
        familyId: family.id,
        sourceIds: family.sourceIds,
        verifiedAt: family.verifiedAt,
      };
    }
    case 'release-event': {
      const event = data.releaseEvents.find(({ id }) => id === ref.eventId);
      if (!event) return `cites ${label}, which does not exist`;
      return {
        label,
        releaseId: event.releaseId,
        sourceIds: event.sourceIds,
        verifiedAt: event.verifiedAt,
      };
    }
    case 'benchmark-result': {
      const result = data.benchmarkResults.find(({ id }) => id === ref.benchmarkResultId);
      if (!result) return `cites ${label}, which does not exist`;
      return {
        label,
        releaseId: result.releaseId,
        sourceIds: result.sourceIds,
        verifiedAt: result.verifiedAt,
      };
    }
    case 'usage-observation': {
      const observation = data.usageObservations.find(({ id }) => id === ref.usageObservationId);
      if (!observation) return `cites ${label}, which does not exist`;
      return {
        label,
        releaseId: observation.releaseId,
        sourceIds: observation.sourceIds,
        verifiedAt: observation.verifiedAt,
      };
    }
    case 'pricing-record': {
      const pricing = data.pricing.find(({ id }) => id === ref.pricingRecordId);
      if (!pricing) return `cites ${label}, which does not exist`;
      const deployment = data.deployments.find(({ id }) => id === pricing.deploymentId);
      if (!deployment) return `cites ${label}, whose deployment does not exist`;
      return {
        label,
        releaseId: deployment.releaseId,
        sourceIds: pricing.sourceIds,
        verifiedAt: pricing.verifiedAt,
      };
    }
  }
}

/** Whether a cited fact answers the question a rubric dimension asks. */
function factAnswersDimension(ref: FitFactRef, dimension: keyof typeof RUBRIC_DIMENSION_SUPPORT) {
  const support = RUBRIC_DIMENSION_SUPPORT[dimension];
  if (!support.factKinds.includes(ref.kind)) return false;
  if (ref.kind === 'release-field') {
    return support.releaseFields?.includes(ref.field) ?? false;
  }
  if (ref.kind === 'family-field') {
    return support.familyFields?.includes(ref.field) ?? false;
  }
  return true;
}

/**
 * Conditional model-fit guidance, held to the rules that keep it guidance rather
 * than a verdict: every statement traces to structured facts about its own
 * release, cites no source those facts do not already cite, discloses rubric
 * dimensions that its facts actually answer, keeps contradictions reciprocal and
 * unresolved, and never claims a dimension that is separately recorded as an
 * evidence gap. Winner language is refused by the schema itself.
 */
function validateModelFitGuidance(
  data: Dataset,
  context: {
    issues: string[];
    sourceIds: Set<string>;
    releaseById: Map<string, ModelRelease>;
    familyById: Map<string, ModelFamily>;
  },
) {
  const { issues, sourceIds, releaseById, familyById } = context;

  addDuplicateIssues(issues, 'model fit statement', 'id', data.modelFitStatements.map(({ id }) => id));
  addDuplicateIssues(issues, 'model fit evidence gap', 'id', data.modelFitEvidenceGaps.map(({ id }) => id));

  const statementById = new Map(data.modelFitStatements.map((statement) => [statement.id, statement]));
  const supportedDimensions = new Map<string, Set<string>>();

  for (const statement of data.modelFitStatements) {
    const owner = `model fit statement ${statement.id}`;
    const release = releaseById.get(statement.releaseId);
    if (!release) {
      issues.push(`${owner}.releaseId references missing id "${statement.releaseId}"`);
    }

    addMissingReferences(issues, owner, 'sourceIds', statement.sourceIds, sourceIds);
    addDuplicateIssues(issues, owner, 'sourceIds entry', statement.sourceIds);

    const resolved: { ref: FitFactRef; fact: ResolvedFitFact }[] = [];
    for (const ref of statement.facts) {
      const outcome = resolveFitFact(ref, data, { releaseById, familyById });
      if (typeof outcome === 'string') {
        issues.push(`${owner} ${outcome}`);
        continue;
      }
      resolved.push({ ref, fact: outcome });

      // Guidance stands on facts about the model it describes. A fact about
      // another release would make the statement comparative, which is ranking.
      if (outcome.releaseId && outcome.releaseId !== statement.releaseId) {
        issues.push(`${owner} ${outcome.label} describes release ${outcome.releaseId}, not ${statement.releaseId}`);
      }
      if (outcome.familyId && release && outcome.familyId !== release.familyId) {
        issues.push(`${owner} ${outcome.label} describes family ${outcome.familyId}, which is not the family of ${statement.releaseId}`);
      }
    }

    for (const dimension of statement.rubricDimensions) {
      if (!resolved.some(({ ref }) => factAnswersDimension(ref, dimension))) {
        issues.push(`${owner} discloses rubric dimension "${dimension}" without citing a fact that answers it`);
      }
    }

    // A statement may only cite sources its own facts already cite, so guidance
    // cannot pull in a source no recorded fact carries. This constrains sourcing,
    // not semantics: it does not check that the statement follows from the facts.
    const factSources = new Set(resolved.flatMap(({ fact }) => fact.sourceIds));
    for (const sourceId of statement.sourceIds) {
      if (sourceIds.has(sourceId) && !factSources.has(sourceId)) {
        issues.push(`${owner} cites source "${sourceId}", which none of the facts it rests on cites`);
      }
    }

    for (const { fact } of resolved) {
      if (statement.verifiedAt < fact.verifiedAt) {
        issues.push(`${owner} was verified before ${fact.label}`);
      }
    }

    if (resolved.length > 0) {
      const dimensions = supportedDimensions.get(statement.releaseId) ?? new Set<string>();
      for (const dimension of statement.rubricDimensions) dimensions.add(dimension);
      supportedDimensions.set(statement.releaseId, dimensions);
    }

    for (const conflictId of statement.conflictsWithIds) {
      if (conflictId === statement.id) {
        issues.push(`${owner}.conflictsWithIds cannot reference itself`);
        continue;
      }
      const counterpart = statementById.get(conflictId);
      if (!counterpart) {
        issues.push(`${owner}.conflictsWithIds references missing id "${conflictId}"`);
        continue;
      }
      if (counterpart.releaseId !== statement.releaseId) {
        issues.push(`${owner} conflicts with ${conflictId}, which describes another release`);
      }
      // Guidance derived from different dimensions is not contradictory; it is
      // simply about different things.
      const shared = statement.rubricDimensions.some(
        (dimension) => counterpart.rubricDimensions.includes(dimension),
      );
      if (!shared) {
        issues.push(`${owner} conflicts with ${conflictId}, which shares no rubric dimension with it`);
      }
      if (!counterpart.conflictsWithIds.includes(statement.id)) {
        issues.push(`${owner} conflict with ${conflictId} is not reciprocal`);
      }
    }
  }

  const gapKeys = data.modelFitEvidenceGaps.map((gap) => `${gap.releaseId}/${gap.dimension}`);
  addDuplicateIssues(issues, 'model fit evidence gap', 'release and dimension', gapKeys);

  for (const gap of data.modelFitEvidenceGaps) {
    const owner = `model fit evidence gap ${gap.id}`;
    if (!releaseById.has(gap.releaseId)) {
      issues.push(`${owner}.releaseId references missing id "${gap.releaseId}"`);
    }
    // A dimension cannot be both answered and unanswerable for one release.
    if (supportedDimensions.get(gap.releaseId)?.has(gap.dimension)) {
      issues.push(`${owner} records dimension "${gap.dimension}" as unsupported while a statement derives guidance from it`);
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
  const { byId: publisherById, groupRoot } = buildPublisherIndex(data.publishers);
  const publisherIds = new Set(publisherById.keys());
  const organizationById = new Map(data.organizations.map((organization) => [organization.id, organization]));
  const familyById = new Map(data.families.map((family) => [family.id, family]));
  const releaseById = new Map(data.releases.map((release) => [release.id, release]));

  for (const source of data.sources) {
    if (!publisherIds.has(source.publisherId)) {
      issues.push(`source ${source.id}.publisherId references missing id "${source.publisherId}"`);
    }
    if (source.publishedDate && source.publishedDate > source.lastCheckedDate) {
      issues.push(`source ${source.id} was checked before its published date`);
    }
  }

  addDuplicateIssues(issues, 'publisher', 'id', data.publishers.map(({ id }) => id));
  for (const publisher of data.publishers) {
    const owner = `publisher ${publisher.id}`;
    if (publisher.organizationId && !organizationById.has(publisher.organizationId)) {
      issues.push(`${owner}.organizationId references missing id "${publisher.organizationId}"`);
    }
    if (publisher.control) {
      const { parentId, sourceIds: controlSourceIds } = publisher.control;
      if (parentId === publisher.id) {
        issues.push(`${owner}.control.parentId cannot reference itself`);
      } else if (!publisherIds.has(parentId)) {
        issues.push(`${owner}.control.parentId references missing id "${parentId}"`);
      }
      // An ownership claim is a fact like any other: it must cite real sources.
      addMissingReferences(issues, owner, 'control.sourceIds', controlSourceIds, sourceIds);
      addDuplicateIssues(issues, owner, 'control.sourceIds entry', controlSourceIds);
    }
  }
  // A cycle in the ownership chain would make the controlling company undefined.
  for (const publisher of data.publishers) {
    const seen = new Set<string>();
    let current: string | undefined = publisher.id;
    while (current) {
      if (seen.has(current)) {
        if (current === publisher.id) {
          issues.push(`publisher ${publisher.id} is part of an ownership cycle`);
        }
        break;
      }
      seen.add(current);
      const parent: string | undefined = publisherById.get(current)?.control?.parentId;
      current = parent && publisherById.has(parent) ? parent : undefined;
    }
  }

  for (const organization of data.organizations) {
    addMissingReferences(issues, `organization ${organization.id}`, 'sourceIds', organization.sourceIds, sourceIds);
  }

  for (const family of data.families) {
    if (!organizationById.has(family.organizationId)) {
      issues.push(`family ${family.id}.organizationId references missing id "${family.organizationId}"`);
    }
    addPrecisionIssue(
      issues,
      `family ${family.id}`,
      'firstReleaseDate',
      family.firstReleaseDate,
      family.datePrecision,
    );
    if (isDefinitelyAfter(family.firstReleaseDate, family.verifiedAt)) {
      issues.push(`family ${family.id} was verified before its first release date`);
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
      // Only a *definite* contradiction is reported. Where the two intervals
      // overlap — a day-precision release inside its family's month-precision
      // first release — the sources leave the order open, and an open question
      // is not an error to raise.
      if (isDefinitelyBefore(release.releaseDate, family.firstReleaseDate)) {
        issues.push(`release ${release.id} predates family ${family.id}`);
      }
    }
    addPrecisionIssue(
      issues,
      `release ${release.id}`,
      'releaseDate',
      release.releaseDate,
      release.datePrecision,
    );
    if (isDefinitelyAfter(release.releaseDate, release.verifiedAt)) {
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

    addPrecisionIssue(issues, `release event ${event.id}`, 'date', event.date, event.datePrecision);
    if (isDefinitelyAfter(event.date, event.verifiedAt)) {
      issues.push(`release event ${event.id} was verified before it happened`);
    }
  }

  addDuplicateIssues(issues, 'usage observation', 'id', data.usageObservations.map(({ id }) => id));
  addDuplicateIssues(issues, 'usage synthesis', 'id', data.usageSyntheses.map(({ id }) => id));

  const observationById = new Map(data.usageObservations.map((observation) => [observation.id, observation]));

  for (const observation of data.usageObservations) {
    const owner = `usage observation ${observation.id}`;
    const release = releaseById.get(observation.releaseId);
    if (!release) {
      issues.push(`${owner}.releaseId references missing id "${observation.releaseId}"`);
    }
    addMissingReferences(issues, owner, 'sourceIds', observation.sourceIds, sourceIds);
    addDuplicateIssues(issues, owner, 'sourceIds entry', observation.sourceIds);

    if (earliestDay(observation.windowStart) > latestDay(observation.windowEnd)) {
      issues.push(`${owner} measurement window ends before it starts`);
    }
    if (earliestDay(observation.windowEnd) > observation.verifiedAt) {
      issues.push(`${owner} was verified before its measurement window ended`);
    }
    if (release && isDefinitelyBefore(observation.windowStart, release.releaseDate)) {
      issues.push(`${owner} measures a window that precedes release ${release.id}`);
    }

    // Independence is a property of who published the evidence. Publisher
    // identity is resolved through the ownership graph, so a corporate sibling
    // of the creator (an arm of the same parent company) is not independent,
    // and two unrelated publishers that share a display name are not merged.
    const creator = release ? organizationById.get(release.organizationId) : undefined;
    const creatorRoots = creator
      ? new Set(
          data.publishers
            .filter((publisher) => publisher.organizationId === creator.id)
            .map((publisher) => groupRoot(publisher.id)),
        )
      : new Set<string>();
    const creatorPublished = observation.sourceIds.some((sourceId) => {
      const publisherId = sourceById.get(sourceId)?.publisherId;
      if (!publisherId) return false;
      const publisher = publisherById.get(publisherId);
      if (creator && publisher?.organizationId === creator.id) return true;
      return creatorRoots.has(groupRoot(publisherId));
    });

    if (observation.sourceCategory === 'creator-self-report') {
      if (creator && !creatorPublished) {
        issues.push(`${owner} is labelled a creator self-report but cites no source published by ${creator.name}`);
      }
      const hasPrimarySource = observation.sourceIds.some((sourceId) => {
        const source = sourceById.get(sourceId);
        return source ? PRIMARY_SOURCE_TYPES.has(source.type) : false;
      });
      if (!hasPrimarySource) issues.push(`${owner} is a creator self-report without a primary source`);
    } else if (creator && creatorPublished) {
      issues.push(`${owner} claims independent evidence but cites a source published by ${creator.name}`);
    }

    for (const conflictId of observation.conflictsWithIds) {
      const counterpart = observationById.get(conflictId);
      if (!counterpart) {
        issues.push(`${owner}.conflictsWithIds references missing id "${conflictId}"`);
        continue;
      }
      if (conflictId === observation.id) {
        issues.push(`${owner}.conflictsWithIds cannot reference itself`);
        continue;
      }
      if (counterpart.releaseId !== observation.releaseId) {
        issues.push(`${owner} conflicts with ${conflictId}, which describes another release`);
      }
      // Different metrics, units, or populations are incomparable rather than
      // contradictory; recording them as a conflict would imply a shared scale.
      if (comparabilityKey(counterpart) !== comparabilityKey(observation)) {
        issues.push(`${owner} conflicts with ${conflictId}, which measures an incomparable metric or population`);
      }
      if (!counterpart.conflictsWithIds.includes(observation.id)) {
        issues.push(`${owner} conflict with ${conflictId} is not reciprocal`);
      }
    }
  }

  for (const synthesis of data.usageSyntheses) {
    const owner = `usage synthesis ${synthesis.id}`;
    if (!releaseIds.has(synthesis.releaseId)) {
      issues.push(`${owner}.releaseId references missing id "${synthesis.releaseId}"`);
    }
    addDuplicateIssues(issues, owner, 'observationIds entry', synthesis.observationIds);

    const cited = synthesis.observationIds
      .map((observationId) => {
        const observation = observationById.get(observationId);
        if (!observation) issues.push(`${owner}.observationIds references missing id "${observationId}"`);
        return observation;
      })
      .filter((observation): observation is UsageObservation => Boolean(observation));

    for (const observation of cited) {
      if (observation.releaseId !== synthesis.releaseId) {
        issues.push(`${owner} cites observation ${observation.id}, which describes another release`);
      }
      if (synthesis.verifiedAt < observation.verifiedAt) {
        issues.push(`${owner} was verified before observation ${observation.id}`);
      }
    }

    const keys = new Set(cited.map(comparabilityKey));
    if (keys.size > 1) {
      issues.push(`${owner} combines incomparable metrics or populations, which cannot be synthesized`);
    }

    // The bar for a cross-source statement: two non-creator observations from
    // two different publishers. Publishers are counted by their controlling
    // company, so an arm and its parent (or two arms of one parent) are one
    // voice, while two unrelated publishers sharing a name stay two.
    const independentPublishers = new Set(
      cited
        .filter((observation) => observation.sourceCategory !== 'creator-self-report')
        .flatMap((observation) =>
          observation.sourceIds
            .map((sourceId) => sourceById.get(sourceId)?.publisherId)
            .filter((publisherId): publisherId is string => Boolean(publisherId))
            .map((publisherId) => groupRoot(publisherId)),
        ),
    );
    const independentObservations = cited.filter(
      (observation) => observation.sourceCategory !== 'creator-self-report',
    );
    if (independentObservations.length < 2 || independentPublishers.size < 2) {
      issues.push(`${owner} requires at least two independent non-creator sources`);
    }

    const declaresConflict = cited.some((observation) => cited.some(
      (other) => other.id !== observation.id && observation.conflictsWithIds.includes(other.id),
    ));
    if (synthesis.agreement === 'agreeing' && declaresConflict) {
      issues.push(`${owner} reports agreement between observations that record a conflict`);
    }
    if (synthesis.agreement === 'conflicting' && !declaresConflict) {
      issues.push(`${owner} reports a conflict that none of its observations records`);
    }
  }

  validateModelFitGuidance(data, {
    issues,
    sourceIds,
    releaseById,
    familyById,
  });

  if (issues.length) throw new DataValidationError(issues);
  return data;
}