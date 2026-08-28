import { RUBRIC_DIMENSION_SUPPORT } from '../data/model-fit-rubric';
import type {
  Dataset,
  FitClassification,
  FitFactRef,
  FitRubricDimension,
  ModelFitEvidenceGap,
  ModelFitStatement,
  Publisher,
  SourceReference,
} from '../data/schema';
// Guidance ages the same way a usage figure does, so it reuses one staleness
// rule rather than introducing a second number that could drift from it. What
// ages is the evidence: a statement's date is the verification date of the
// newest fact beneath it, not a record of editorial review.
import { STALE_AFTER_DAYS, daysSince } from './usage-evidence';
import { accessLabel, categoryLabel, formatDate, formatNumber, statusLabel } from './format';

export { STALE_AFTER_DAYS, daysSince };

/**
 * Where a cited fact comes from. The guidance statement itself is always
 * ModelTree's editorial synthesis; this describes only the evidence beneath it,
 * so a reader can see what the creator asserted, what somebody else recorded,
 * and what was actually measured.
 */
export type FitEvidenceClass = 'creator-claim' | 'third-party-record' | 'measured-evidence';

export interface FitSourceView {
  source: SourceReference;
  publisherName: string;
}

export interface FitFactView {
  key: string;
  /** What the fact is, in reader-facing words. */
  label: string;
  /** The recorded value, so guidance can be checked against the record. */
  detail: string;
  evidenceClass: FitEvidenceClass;
  sources: FitSourceView[];
  verifiedAt: string;
}

export interface FitRubricView {
  dimension: FitRubricDimension;
  label: string;
  question: string;
}

export interface FitConflictView {
  id: string;
  classificationLabel: string;
  condition: string;
}

export interface FitStatementView {
  statement: ModelFitStatement;
  classificationLabel: string;
  rubric: FitRubricView[];
  facts: FitFactView[];
  /** The same facts split by where they come from, for the rendered separation. */
  evidenceByClass: { evidenceClass: FitEvidenceClass; label: string; note: string; facts: FitFactView[] }[];
  sources: FitSourceView[];
  conflictsWith: FitConflictView[];
  isStale: boolean;
  daysSinceVerified: number;
}

export interface FitGroupView {
  classification: FitClassification;
  label: string;
  description: string;
  statements: FitStatementView[];
}

export interface FitGapView {
  gap: ModelFitEvidenceGap;
  dimensionLabel: string;
  question: string;
  reasonLabel: string;
}

export interface ModelFitView {
  state: 'no-guidance' | 'guidance';
  groups: FitGroupView[];
  statementCount: number;
  gaps: FitGapView[];
  hasConflict: boolean;
  hasStale: boolean;
  evidenceClassesUsed: FitEvidenceClass[];
}

type FitDataset = Pick<
  Dataset,
  | 'sources'
  | 'publishers'
  | 'organizations'
  | 'families'
  | 'releases'
  | 'releaseEvents'
  | 'benchmarks'
  | 'benchmarkResults'
  | 'usageObservations'
  | 'pricing'
  | 'deployments'
  | 'modelFitStatements'
  | 'modelFitEvidenceGaps'
>;

const CLASSIFICATION_LABELS: Record<FitClassification, string> = {
  'good-fit-when': 'Good fit when',
  'trade-off': 'Trade-off',
  'avoid-when': 'Avoid when',
};

const CLASSIFICATION_DESCRIPTIONS: Record<FitClassification, string> = {
  'good-fit-when': 'Conditions under which the recorded facts support choosing this model. Not a statement that it is preferable to any other model.',
  'trade-off': 'Conditions where the recorded facts cut both ways, so the decision depends on what the reader is willing to accept.',
  'avoid-when': 'Conditions under which the recorded facts count against this model. Not a statement that the model is deficient.',
};

const DIMENSION_LABELS: Record<FitRubricDimension, string> = {
  'context-window': 'Context window',
  'documented-limits': 'Documented limits',
  'modality-coverage': 'Modality coverage',
  'access-and-licensing': 'Access and licensing',
  'lifecycle-stability': 'Lifecycle stability',
  'cost-structure': 'Cost structure',
  'measured-benchmark-evidence': 'Measured benchmark evidence',
  'usage-evidence': 'Usage evidence',
};

const GAP_REASON_LABELS: Record<ModelFitEvidenceGap['reason'], string> = {
  'no-qualifying-source': 'No qualifying source',
  'evidence-below-threshold': 'Evidence below the threshold',
  'sources-conflict': 'Sources conflict',
};

const EVIDENCE_CLASS_LABELS: Record<FitEvidenceClass, { label: string; note: string }> = {
  'creator-claim': {
    label: 'Creator claims',
    note: 'Recorded from pages published by the model\u2019s creator. Documentation, not measurement.',
  },
  'third-party-record': {
    label: 'Third-party records',
    note: 'Recorded from a publisher other than the creator. Documentation, not measurement.',
  },
  'measured-evidence': {
    label: 'Measured evidence',
    note: 'Produced by a recorded measurement rather than stated in documentation.',
  },
};

const EVIDENCE_CLASS_ORDER: FitEvidenceClass[] = [
  'measured-evidence',
  'third-party-record',
  'creator-claim',
];

export function fitClassificationLabel(classification: FitClassification) {
  return CLASSIFICATION_LABELS[classification];
}

export function fitDimensionLabel(dimension: FitRubricDimension) {
  return DIMENSION_LABELS[dimension];
}

export function fitGapReasonLabel(reason: ModelFitEvidenceGap['reason']) {
  return GAP_REASON_LABELS[reason];
}

/** The full disclosed rubric, for the methodology block. */
export function fitRubric(): FitRubricView[] {
  return (Object.keys(RUBRIC_DIMENSION_SUPPORT) as FitRubricDimension[]).map((dimension) => ({
    dimension,
    label: DIMENSION_LABELS[dimension],
    question: RUBRIC_DIMENSION_SUPPORT[dimension].question,
  }));
}

/** The controlling company behind a publisher, so corporate arms count as one voice. */
function publisherRoot(publisherId: string, publisherById: Map<string, Publisher>) {
  const seen = new Set<string>();
  let current = publisherId;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = publisherById.get(current)?.control?.parentId;
    if (!parent || !publisherById.has(parent)) break;
    current = parent;
  }
  return current;
}

function factKey(ref: FitFactRef) {
  switch (ref.kind) {
    case 'release-field':
      return `${ref.kind}:${ref.releaseId}:${ref.field}`;
    case 'family-field':
      return `${ref.kind}:${ref.familyId}:${ref.field}`;
    case 'release-event':
      return `${ref.kind}:${ref.eventId}`;
    case 'benchmark-result':
      return `${ref.kind}:${ref.benchmarkResultId}`;
    case 'usage-observation':
      return `${ref.kind}:${ref.usageObservationId}`;
    case 'pricing-record':
      return `${ref.kind}:${ref.pricingRecordId}`;
  }
}

const RELEASE_FIELD_LABELS: Record<string, string> = {
  accessType: 'Access',
  license: 'Licence',
  contextWindow: 'Context window',
  maximumOutput: 'Maximum output',
  inputModalities: 'Input',
  outputModalities: 'Output',
  categories: 'Categories',
  parameters: 'Parameters',
  status: 'Lifecycle status',
  releaseDate: 'Released',
  intendedUse: 'Documented intended use',
};

const FAMILY_FIELD_LABELS: Record<string, string> = {
  status: 'Family lifecycle status',
  firstReleaseDate: 'First family release',
  categories: 'Family categories',
};

function describeReleaseField(release: Dataset['releases'][number], field: string) {
  switch (field) {
    case 'accessType':
      return accessLabel(release.accessType);
    case 'license':
      return release.license
        ? `${release.license.name}${release.license.osiApproved ? '' : ' (not OSI-approved)'}`
        : 'Unknown';
    case 'contextWindow':
      return release.contextWindow ? `${formatNumber(release.contextWindow)} tokens` : 'Unknown';
    case 'maximumOutput':
      return release.maximumOutput ? `${formatNumber(release.maximumOutput)} tokens` : 'Unknown';
    case 'inputModalities':
      return release.inputModalities.join(', ');
    case 'outputModalities':
      return release.outputModalities.join(', ');
    case 'categories':
      return release.categories.map(categoryLabel).join(', ');
    case 'parameters':
      return [
        release.parameters?.totalBillions ? `${release.parameters.totalBillions}B total` : undefined,
        release.parameters?.activeBillions ? `${release.parameters.activeBillions}B active` : undefined,
      ].filter(Boolean).join(', ') || 'Unknown';
    case 'status':
      return statusLabel(release.status);
    case 'releaseDate':
      return formatDate(release.releaseDate);
    default:
      return release.intendedUse;
  }
}

interface ResolvedFact {
  label: string;
  detail: string;
  sourceIds: string[];
  verifiedAt: string;
  /** Set when the record is itself a measurement rather than documentation. */
  measured?: boolean;
}

function resolveFact(ref: FitFactRef, data: FitDataset): ResolvedFact | undefined {
  switch (ref.kind) {
    case 'release-field': {
      const release = data.releases.find(({ id }) => id === ref.releaseId);
      if (!release) return undefined;
      return {
        label: RELEASE_FIELD_LABELS[ref.field] ?? ref.field,
        detail: describeReleaseField(release, ref.field),
        sourceIds: release.sourceIds,
        verifiedAt: release.verifiedAt,
      };
    }
    case 'family-field': {
      const family = data.families.find(({ id }) => id === ref.familyId);
      if (!family) return undefined;
      const detail = ref.field === 'status'
        ? statusLabel(family.status)
        : ref.field === 'firstReleaseDate'
          ? formatDate(family.firstReleaseDate)
          : family.categories.map(categoryLabel).join(', ');
      return {
        label: FAMILY_FIELD_LABELS[ref.field] ?? ref.field,
        detail: `${family.name}: ${detail}`,
        sourceIds: family.sourceIds,
        verifiedAt: family.verifiedAt,
      };
    }
    case 'release-event': {
      const event = data.releaseEvents.find(({ id }) => id === ref.eventId);
      if (!event) return undefined;
      return {
        label: 'Lifecycle event',
        detail: `${event.type.replaceAll('-', ' ')} on ${event.date}: ${event.note}`,
        sourceIds: event.sourceIds,
        verifiedAt: event.verifiedAt,
      };
    }
    case 'benchmark-result': {
      const result = data.benchmarkResults.find(({ id }) => id === ref.benchmarkResultId);
      if (!result) return undefined;
      const benchmark = data.benchmarks.find(({ id }) => id === result.benchmarkId);
      return {
        label: 'Benchmark result',
        detail: `${benchmark?.name ?? result.benchmarkId}: ${result.score} ${result.unit}`,
        sourceIds: result.sourceIds,
        verifiedAt: result.verifiedAt,
        // An official score is the creator reporting on itself; only an
        // independent run counts as measured evidence here.
        measured: result.resultType === 'independent',
      };
    }
    case 'usage-observation': {
      const observation = data.usageObservations.find(({ id }) => id === ref.usageObservationId);
      if (!observation) return undefined;
      return {
        label: 'Usage observation',
        detail: `${observation.metricLabel}: ${observation.valueAsStated}`,
        sourceIds: observation.sourceIds,
        verifiedAt: observation.verifiedAt,
        measured: observation.sourceCategory !== 'creator-self-report',
      };
    }
    case 'pricing-record': {
      const pricing = data.pricing.find(({ id }) => id === ref.pricingRecordId);
      if (!pricing) return undefined;
      const rates = Object.entries(pricing.rates)
        .filter(([, rate]) => rate !== undefined)
        .map(([name, rate]) => `${name} ${rate} ${pricing.currency}`)
        .join(', ');
      return {
        label: 'Pricing record',
        detail: `${rates} ${pricing.unit.replaceAll('-', ' ')}`,
        sourceIds: pricing.sourceIds,
        verifiedAt: pricing.verifiedAt,
      };
    }
  }
}

/**
 * Builds the conditional-fit view for one release.
 *
 * Nothing here ranks, scores, or compares models. Statements are grouped by the
 * classification their author recorded, contradictions are surfaced rather than
 * resolved, and dimensions with no supporting evidence are reported as gaps.
 */
export function buildModelFitGuidance(
  data: FitDataset,
  releaseId: string,
  today: string,
): ModelFitView {
  const sourceById = new Map(data.sources.map((source) => [source.id, source]));
  const publisherById = new Map(data.publishers.map((publisher) => [publisher.id, publisher]));
  const release = data.releases.find(({ id }) => id === releaseId);

  // Publisher voices that speak for this model's creator, resolved through the
  // ownership chain so a corporate arm is not mistaken for a third party.
  const creatorRoots = new Set(
    data.publishers
      .filter((publisher) => publisher.organizationId === release?.organizationId)
      .map((publisher) => publisherRoot(publisher.id, publisherById)),
  );

  const toSourceViews = (sourceIds: string[]) => sourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is SourceReference => Boolean(source))
    .map((source) => ({
      source,
      publisherName: publisherById.get(source.publisherId)?.name ?? source.publisherId,
    }));

  const classifyEvidence = (fact: ResolvedFact): FitEvidenceClass => {
    if (fact.measured) return 'measured-evidence';
    const fromCreator = fact.sourceIds.some((sourceId) => {
      const publisherId = sourceById.get(sourceId)?.publisherId;
      return publisherId ? creatorRoots.has(publisherRoot(publisherId, publisherById)) : false;
    });
    return fromCreator ? 'creator-claim' : 'third-party-record';
  };

  const statements = data.modelFitStatements.filter(
    (statement) => statement.releaseId === releaseId,
  );
  const statementById = new Map(statements.map((statement) => [statement.id, statement]));
  const evidenceClassesUsed = new Set<FitEvidenceClass>();

  const views: FitStatementView[] = statements.map((statement) => {
    const facts = statement.facts
      .map((ref) => {
        const resolved = resolveFact(ref, data);
        if (!resolved) return undefined;
        const evidenceClass = classifyEvidence(resolved);
        evidenceClassesUsed.add(evidenceClass);
        return {
          key: factKey(ref),
          label: resolved.label,
          detail: resolved.detail,
          evidenceClass,
          sources: toSourceViews(resolved.sourceIds),
          verifiedAt: resolved.verifiedAt,
        } satisfies FitFactView;
      })
      .filter((fact): fact is FitFactView => Boolean(fact));

    const daysSinceVerified = daysSince(statement.verifiedAt, today);

    return {
      statement,
      classificationLabel: CLASSIFICATION_LABELS[statement.classification],
      rubric: statement.rubricDimensions.map((dimension) => ({
        dimension,
        label: DIMENSION_LABELS[dimension],
        question: RUBRIC_DIMENSION_SUPPORT[dimension].question,
      })),
      facts,
      evidenceByClass: EVIDENCE_CLASS_ORDER
        .map((evidenceClass) => ({
          evidenceClass,
          ...EVIDENCE_CLASS_LABELS[evidenceClass],
          facts: facts.filter((fact) => fact.evidenceClass === evidenceClass),
        }))
        .filter((group) => group.facts.length > 0),
      sources: toSourceViews(statement.sourceIds),
      conflictsWith: statement.conflictsWithIds
        .map((conflictId) => statementById.get(conflictId))
        .filter((counterpart): counterpart is ModelFitStatement => Boolean(counterpart))
        .map((counterpart) => ({
          id: counterpart.id,
          classificationLabel: CLASSIFICATION_LABELS[counterpart.classification],
          condition: counterpart.condition,
        })),
      isStale: daysSinceVerified > STALE_AFTER_DAYS,
      daysSinceVerified,
    };
  });

  const groups: FitGroupView[] = (Object.keys(CLASSIFICATION_LABELS) as FitClassification[])
    .map((classification) => ({
      classification,
      label: CLASSIFICATION_LABELS[classification],
      description: CLASSIFICATION_DESCRIPTIONS[classification],
      statements: views.filter((view) => view.statement.classification === classification),
    }))
    .filter((group) => group.statements.length > 0);

  const gaps: FitGapView[] = data.modelFitEvidenceGaps
    .filter((gap) => gap.releaseId === releaseId)
    .map((gap) => ({
      gap,
      dimensionLabel: DIMENSION_LABELS[gap.dimension],
      question: RUBRIC_DIMENSION_SUPPORT[gap.dimension].question,
      reasonLabel: GAP_REASON_LABELS[gap.reason],
    }));

  return {
    state: views.length === 0 ? 'no-guidance' : 'guidance',
    groups,
    statementCount: views.length,
    gaps,
    hasConflict: views.some((view) => view.conflictsWith.length > 0),
    hasStale: views.some((view) => view.isStale),
    evidenceClassesUsed: EVIDENCE_CLASS_ORDER.filter(
      (evidenceClass) => evidenceClassesUsed.has(evidenceClass),
    ),
  };
}
