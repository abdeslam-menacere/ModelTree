import { comparabilityKey } from '../data/validate';
import type {
  Dataset,
  Publisher,
  SourceReference,
  UsageObservation,
  UsageSynthesis,
} from '../data/schema';

/**
 * How long a usage figure is presented without a staleness warning. Usage moves
 * faster than model metadata, so a figure that has not been re-checked within
 * half a year is shown as unverified rather than quietly presented as current.
 */
export const STALE_AFTER_DAYS = 180;

/** A cited source paired with the display name of the publisher behind it. */
export interface UsageSourceView {
  source: SourceReference;
  publisherName: string;
}

export interface UsageObservationView {
  observation: UsageObservation;
  sources: UsageSourceView[];
  isCreatorSelfReport: boolean;
  provenanceLabel: string;
  isStale: boolean;
  daysSinceVerified: number;
  conflictsWith: string[];
}

export interface UsageEvidenceGroup {
  key: string;
  metricLabel: string;
  unit: string;
  population: string;
  observations: UsageObservationView[];
  independentPublishers: string[];
  /** Whether this group clears the two-independent-source bar for a synthesis. */
  canSynthesize: boolean;
  hasConflict: boolean;
}

export interface UsageSynthesisView {
  synthesis: UsageSynthesis;
  observations: UsageObservation[];
  isStale: boolean;
}

export interface UsageEvidenceView {
  state: 'no-data' | 'evidence';
  groups: UsageEvidenceGroup[];
  syntheses: UsageSynthesisView[];
  observationCount: number;
  hasStale: boolean;
  hasConflict: boolean;
  hasCreatorSelfReport: boolean;
}

const PROVENANCE_LABELS: Record<UsageObservation['sourceCategory'], string> = {
  'creator-self-report': 'Creator self-report',
  'platform-operator-report': 'Platform operator report',
  'independent-measurement': 'Independent measurement',
  'developer-survey': 'Developer survey',
  'community-signal': 'Community signal',
};

export function usageProvenanceLabel(category: UsageObservation['sourceCategory']) {
  return PROVENANCE_LABELS[category];
}

function toUtcDay(value: string) {
  return Date.parse(`${value}T00:00:00Z`);
}

export function daysSince(verifiedAt: string, today: string) {
  return Math.floor((toUtcDay(today) - toUtcDay(verifiedAt)) / 86_400_000);
}

/**
 * The controlling company behind a publisher. Walks the ownership chain so an
 * arm and its parent resolve to one voice; a display-name collision does not,
 * because identity is the id, not the name.
 */
function publisherVoice(
  publisherId: string,
  publisherById: Map<string, Publisher>,
): { key: string; name: string } {
  const seen = new Set<string>();
  let current = publisherId;
  while (true) {
    if (seen.has(current)) break;
    seen.add(current);
    const parent = publisherById.get(current)?.control?.parentId;
    if (!parent || !publisherById.has(parent)) break;
    current = parent;
  }
  const name = publisherById.get(current)?.name
    ?? publisherById.get(publisherId)?.name
    ?? publisherId;
  return { key: current, name };
}

/**
 * Publishers behind non-creator observations, counted by controlling company.
 * Two restatements from the same publisher (or an arm and its parent) are one
 * voice; two independent publishers stay two even if their names collide.
 */
export function independentPublishers(
  observations: UsageObservation[],
  sourceById: Map<string, SourceReference>,
  publisherById: Map<string, Publisher>,
) {
  const voices = new Map<string, string>();

  for (const observation of observations) {
    if (observation.sourceCategory === 'creator-self-report') continue;
    for (const sourceId of observation.sourceIds) {
      const publisherId = sourceById.get(sourceId)?.publisherId;
      if (!publisherId) continue;
      const { key, name } = publisherVoice(publisherId, publisherById);
      voices.set(key, name);
    }
  }

  return [...voices.values()].sort();
}

/**
 * A cross-source statement needs at least two non-creator observations from at
 * least two distinct publishers. A single-source observation still renders; it
 * simply cannot become a synthesis.
 */
export function canSynthesize(
  observations: UsageObservation[],
  sourceById: Map<string, SourceReference>,
  publisherById: Map<string, Publisher>,
) {
  const nonCreator = observations.filter(
    (observation) => observation.sourceCategory !== 'creator-self-report',
  );

  return nonCreator.length >= 2
    && independentPublishers(nonCreator, sourceById, publisherById).length >= 2;
}

export function buildUsageEvidence(
  dataset: Pick<Dataset, 'sources' | 'publishers' | 'usageObservations' | 'usageSyntheses'>,
  releaseId: string,
  today: string,
): UsageEvidenceView {
  const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));
  const publisherById = new Map(dataset.publishers.map((publisher) => [publisher.id, publisher]));
  const observations = dataset.usageObservations.filter(
    (observation) => observation.releaseId === releaseId,
  );
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));

  const groups = new Map<string, UsageEvidenceGroup>();

  for (const observation of observations) {
    const key = comparabilityKey(observation);
    const daysSinceVerified = daysSince(observation.verifiedAt, today);
    const view: UsageObservationView = {
      observation,
      sources: observation.sourceIds
        .map((sourceId) => sourceById.get(sourceId))
        .filter((source): source is SourceReference => Boolean(source))
        .map((source) => ({
          source,
          publisherName: publisherById.get(source.publisherId)?.name ?? source.publisherId,
        })),
      isCreatorSelfReport: observation.sourceCategory === 'creator-self-report',
      provenanceLabel: usageProvenanceLabel(observation.sourceCategory),
      isStale: daysSinceVerified > STALE_AFTER_DAYS,
      daysSinceVerified,
      conflictsWith: observation.conflictsWithIds
        .map((conflictId) => observationById.get(conflictId)?.metricLabel)
        .filter((label): label is string => Boolean(label)),
    };

    const group = groups.get(key);
    if (group) {
      group.observations.push(view);
    } else {
      groups.set(key, {
        key,
        metricLabel: observation.metricLabel,
        unit: observation.unit,
        population: observation.population,
        observations: [view],
        independentPublishers: [],
        canSynthesize: false,
        hasConflict: false,
      });
    }
  }

  for (const group of groups.values()) {
    const groupObservations = group.observations.map(({ observation }) => observation);
    group.independentPublishers = independentPublishers(groupObservations, sourceById, publisherById);
    group.canSynthesize = canSynthesize(groupObservations, sourceById, publisherById);
    group.hasConflict = group.observations.some((view) => view.conflictsWith.length > 0);
  }

  const syntheses = dataset.usageSyntheses
    .filter((synthesis) => synthesis.releaseId === releaseId)
    .map((synthesis) => ({
      synthesis,
      observations: synthesis.observationIds
        .map((observationId) => observationById.get(observationId))
        .filter((observation): observation is UsageObservation => Boolean(observation)),
      isStale: daysSince(synthesis.verifiedAt, today) > STALE_AFTER_DAYS,
    }));

  const groupList = [...groups.values()];

  return {
    state: observations.length === 0 ? 'no-data' : 'evidence',
    groups: groupList,
    syntheses,
    observationCount: observations.length,
    hasStale: groupList.some((group) => group.observations.some((view) => view.isStale)),
    hasConflict: groupList.some((group) => group.hasConflict),
    hasCreatorSelfReport: groupList.some((group) => group.observations.some(
      (view) => view.isCreatorSelfReport,
    )),
  };
}
