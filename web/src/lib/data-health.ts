/**
 * The data-health model behind the staleness report (issue #28).
 *
 * This is pure over an injected reference date, so the same dataset classifies
 * identically in a unit test and in a scheduled run — the writing shell lives in
 * `scripts/data-health.mjs`, never here.
 *
 * It reports **distinct, named states**, never a composite score or a ranking
 * (both standing prohibitions in this repository):
 *
 *   - `healthy`     — verified within its category threshold; not conflicted.
 *   - `stale`       — verified longer ago than its category threshold. Reported,
 *                     and by design **never a CI failure** — ordinary age is a
 *                     fact, not a broken build.
 *   - `conflicted`  — party to a recorded, unresolved conflict. Kept side by
 *                     side; nothing here picks a winner.
 *
 * "Unverified" in the issue's acceptance criteria is the dataset's honest blank —
 * an aspect a record could carry but no source has been recorded for yet. That is
 * a *coverage* property, not a per-record verdict, and it is reported as
 * `coverageGaps` (the "missing optional coverage" section) rather than folded
 * into the state above. A first-party fact with no independent echo is not a
 * defect here, so it is not what "unverified" means.
 */

import {
  FRESHNESS_POLICY_VERSION,
  FRESHNESS_THRESHOLD_DAYS,
  type FreshnessCategory,
  type RecordKind,
  categoryOf,
  thresholdDaysFor,
} from '../data/freshness-policy';
import type { Dataset, SourceReference } from '../data/schema';
import { daysSince } from './usage-evidence';

export type RecordState = 'healthy' | 'stale' | 'conflicted';

/** One dated record, before it is classified. */
interface DatableRecord {
  kind: RecordKind;
  id: string;
  /** The day this record was last verified (`lastCheckedDate` for sources). */
  verifiedAt: string;
  /** True when the record is, or belongs to, a featured release. */
  featured: boolean;
  /** Ids this record is recorded as conflicting with, if any. */
  conflictsWith: string[];
}

export interface RecordHealth {
  kind: RecordKind;
  id: string;
  verifiedAt: string;
  category: FreshnessCategory;
  thresholdDays: number;
  ageDays: number;
  state: RecordState;
  featured: boolean;
  conflictsWith: string[];
}

export interface ConflictFinding {
  kind: RecordKind;
  id: string;
  /** The counterpart ids this record is recorded as conflicting with. */
  conflictsWith: string[];
  featured: boolean;
}

/** A featured/long-tail release and the optional coverage it is missing. */
export interface CoverageGap {
  releaseId: string;
  featured: boolean;
  missing: string[];
}

export interface SourceTypeCount {
  type: SourceReference['type'];
  count: number;
}

export interface DataHealthSummary {
  total: number;
  healthy: number;
  stale: number;
  conflicted: number;
  staleFeatured: number;
  staleLongTail: number;
  coverageGapReleases: number;
}

export interface DataHealthReport {
  policyVersion: string;
  referenceDate: string;
  thresholds: Record<FreshnessCategory, number>;
  summary: DataHealthSummary;
  /** Stale releases (and records tied to them) that are featured. Prioritised. */
  staleFeatured: RecordHealth[];
  /** Stale records that are not featured. The long tail. */
  staleLongTail: RecordHealth[];
  conflicts: ConflictFinding[];
  coverageGaps: CoverageGap[];
  sourceTypeMix: SourceTypeCount[];
  /** Every dated record with its verdict, for the machine-readable artifact. */
  records: RecordHealth[];
}

export interface IntegrityViolation {
  kind: RecordKind;
  id: string;
  verifiedAt: string;
  message: string;
}

/** Which optional coverage each release is checked for. Order is display order. */
const COVERAGE_ASPECTS = ['deployment', 'pricing', 'benchmark-result', 'usage-evidence'] as const;

/**
 * The set of release ids that are featured, plus the families and organizations
 * those releases belong to. Anything tied to a featured release is prioritised in
 * the report, so a stale price on a featured model is not buried in the long tail.
 */
function featuredScope(dataset: Dataset) {
  const releaseIds = new Set<string>();
  const familyIds = new Set<string>();
  const organizationIds = new Set<string>();
  for (const release of dataset.releases) {
    if (!release.featured) continue;
    releaseIds.add(release.id);
    familyIds.add(release.familyId);
    organizationIds.add(release.organizationId);
  }
  return { releaseIds, familyIds, organizationIds };
}

/**
 * Every dated record in the dataset, tagged with its kind, its featured status,
 * and any recorded conflict. Sources are dated by `lastCheckedDate`; a publisher
 * contributes a record only when it carries a `control` block with its own date.
 */
export function enumerateRecords(dataset: Dataset): DatableRecord[] {
  const featured = featuredScope(dataset);
  const deploymentReleaseById = new Map(
    dataset.deployments.map((deployment) => [deployment.id, deployment.releaseId]),
  );
  const records: DatableRecord[] = [];

  for (const organization of dataset.organizations) {
    records.push({
      kind: 'organization',
      id: organization.id,
      verifiedAt: organization.verifiedAt,
      featured: featured.organizationIds.has(organization.id),
      conflictsWith: [],
    });
  }
  for (const family of dataset.families) {
    records.push({
      kind: 'family',
      id: family.id,
      verifiedAt: family.verifiedAt,
      featured: featured.familyIds.has(family.id),
      conflictsWith: [],
    });
  }
  for (const release of dataset.releases) {
    records.push({
      kind: 'release',
      id: release.id,
      verifiedAt: release.verifiedAt,
      featured: release.featured,
      conflictsWith: [],
    });
  }
  for (const product of dataset.products) {
    records.push({
      kind: 'product',
      id: product.id,
      verifiedAt: product.verifiedAt,
      featured: false,
      conflictsWith: [],
    });
  }
  for (const platform of dataset.servingPlatforms) {
    records.push({
      kind: 'serving-platform',
      id: platform.id,
      verifiedAt: platform.verifiedAt,
      featured: false,
      conflictsWith: [],
    });
  }
  for (const deployment of dataset.deployments) {
    records.push({
      kind: 'deployment',
      id: deployment.id,
      verifiedAt: deployment.verifiedAt,
      featured: featured.releaseIds.has(deployment.releaseId),
      conflictsWith: [],
    });
  }
  for (const price of dataset.pricing) {
    const releaseId = deploymentReleaseById.get(price.deploymentId);
    records.push({
      kind: 'pricing',
      id: price.id,
      verifiedAt: price.verifiedAt,
      featured: releaseId ? featured.releaseIds.has(releaseId) : false,
      conflictsWith: [],
    });
  }
  for (const benchmark of dataset.benchmarks) {
    records.push({
      kind: 'benchmark',
      id: benchmark.id,
      verifiedAt: benchmark.verifiedAt,
      featured: false,
      conflictsWith: [],
    });
  }
  for (const result of dataset.benchmarkResults) {
    records.push({
      kind: 'benchmark-result',
      id: result.id,
      verifiedAt: result.verifiedAt,
      featured: featured.releaseIds.has(result.releaseId),
      conflictsWith: [],
    });
  }
  for (const event of dataset.releaseEvents) {
    records.push({
      kind: 'release-event',
      id: event.id,
      verifiedAt: event.verifiedAt,
      featured: featured.releaseIds.has(event.releaseId),
      conflictsWith: [],
    });
  }
  for (const observation of dataset.usageObservations) {
    records.push({
      kind: 'usage-observation',
      id: observation.id,
      verifiedAt: observation.verifiedAt,
      featured: featured.releaseIds.has(observation.releaseId),
      conflictsWith: [...observation.conflictsWithIds],
    });
  }
  for (const synthesis of dataset.usageSyntheses) {
    records.push({
      kind: 'usage-synthesis',
      id: synthesis.id,
      verifiedAt: synthesis.verifiedAt,
      featured: featured.releaseIds.has(synthesis.releaseId),
      // A synthesis that reports disagreement IS the recorded conflict; the
      // observations it points at are the parties.
      conflictsWith: synthesis.agreement === 'conflicting' ? [...synthesis.observationIds] : [],
    });
  }
  for (const statement of dataset.modelFitStatements) {
    records.push({
      kind: 'model-fit-statement',
      id: statement.id,
      verifiedAt: statement.verifiedAt,
      featured: featured.releaseIds.has(statement.releaseId),
      conflictsWith: [...statement.conflictsWithIds],
    });
  }
  for (const gap of dataset.modelFitEvidenceGaps) {
    records.push({
      kind: 'model-fit-evidence-gap',
      id: gap.id,
      verifiedAt: gap.verifiedAt,
      featured: featured.releaseIds.has(gap.releaseId),
      conflictsWith: [],
    });
  }
  for (const source of dataset.sources) {
    records.push({
      kind: 'source',
      id: source.id,
      verifiedAt: source.lastCheckedDate,
      featured: false,
      conflictsWith: [],
    });
  }
  for (const publisher of dataset.publishers) {
    if (!publisher.control) continue;
    records.push({
      kind: 'publisher-control',
      id: publisher.id,
      verifiedAt: publisher.control.verifiedAt,
      featured: false,
      conflictsWith: [],
    });
  }

  return records;
}

function classify(record: DatableRecord, referenceDate: string): RecordHealth {
  const category = categoryOf(record.kind);
  const thresholdDays = thresholdDaysFor(record.kind);
  const ageDays = daysSince(record.verifiedAt, referenceDate);
  const state: RecordState = record.conflictsWith.length > 0
    ? 'conflicted'
    : ageDays > thresholdDays
      ? 'stale'
      : 'healthy';
  return {
    kind: record.kind,
    id: record.id,
    verifiedAt: record.verifiedAt,
    category,
    thresholdDays,
    ageDays,
    state,
    featured: record.featured,
    conflictsWith: record.conflictsWith,
  };
}

/** Releases missing optional coverage — the "unverified/unknown" aspects. */
export function collectCoverageGaps(dataset: Dataset): CoverageGap[] {
  const featured = featuredScope(dataset);
  const deploymentReleaseIds = new Set(dataset.deployments.map((d) => d.releaseId));
  const deploymentIdToReleaseId = new Map(dataset.deployments.map((d) => [d.id, d.releaseId]));
  const pricedReleaseIds = new Set<string>();
  for (const price of dataset.pricing) {
    const releaseId = deploymentIdToReleaseId.get(price.deploymentId);
    if (releaseId) pricedReleaseIds.add(releaseId);
  }
  const benchmarkedReleaseIds = new Set(dataset.benchmarkResults.map((r) => r.releaseId));
  const usageReleaseIds = new Set(dataset.usageObservations.map((o) => o.releaseId));

  const has: Record<(typeof COVERAGE_ASPECTS)[number], (releaseId: string) => boolean> = {
    deployment: (id) => deploymentReleaseIds.has(id),
    pricing: (id) => pricedReleaseIds.has(id),
    'benchmark-result': (id) => benchmarkedReleaseIds.has(id),
    'usage-evidence': (id) => usageReleaseIds.has(id),
  };

  const gaps: CoverageGap[] = [];
  for (const release of dataset.releases) {
    const missing = COVERAGE_ASPECTS.filter((aspect) => !has[aspect](release.id));
    if (missing.length === 0) continue;
    gaps.push({ releaseId: release.id, featured: featured.releaseIds.has(release.id), missing });
  }
  return gaps;
}

function collectSourceTypeMix(dataset: Dataset): SourceTypeCount[] {
  const counts = new Map<SourceReference['type'], number>();
  for (const source of dataset.sources) {
    counts.set(source.type, (counts.get(source.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/**
 * A **hard integrity** violation is a self-contradiction in the record, never
 * ordinary age. The only rule here — a `verifiedAt` after the reference date —
 * asserts a record was verified in a future that has not happened. Real data only
 * ages further into the past, so this can newly-pass over time and never
 * newly-fail, the same time model the model passport already uses.
 *
 * The relational coherence rules (dangling/self/non-reciprocal conflict ids,
 * `effectiveFrom > verifiedAt`, dates after verification, source
 * `publishedDate > lastCheckedDate`) are already enforced in `validate.ts` and
 * are deliberately not duplicated here.
 */
export function collectIntegrityViolations(
  dataset: Dataset,
  referenceDate: string,
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const record of enumerateRecords(dataset)) {
    if (record.verifiedAt > referenceDate) {
      violations.push({
        kind: record.kind,
        id: record.id,
        verifiedAt: record.verifiedAt,
        message:
          `verified ${record.verifiedAt}, which is after the reference date ${referenceDate}: `
          + 'a record cannot be verified in the future',
      });
    }
  }
  return violations;
}

function bySalience(a: RecordHealth, b: RecordHealth) {
  return b.ageDays - a.ageDays || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}

export function buildDataHealthReport(dataset: Dataset, referenceDate: string): DataHealthReport {
  const records = enumerateRecords(dataset)
    .map((record) => classify(record, referenceDate))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  const stale = records.filter((record) => record.state === 'stale');
  const staleFeatured = stale.filter((record) => record.featured).sort(bySalience);
  const staleLongTail = stale.filter((record) => !record.featured).sort(bySalience);

  const conflicts: ConflictFinding[] = records
    .filter((record) => record.state === 'conflicted')
    .map((record) => ({
      kind: record.kind,
      id: record.id,
      conflictsWith: record.conflictsWith,
      featured: record.featured,
    }));

  const coverageGaps = collectCoverageGaps(dataset).sort(
    (a, b) => Number(b.featured) - Number(a.featured) || a.releaseId.localeCompare(b.releaseId),
  );

  const summary: DataHealthSummary = {
    total: records.length,
    healthy: records.filter((record) => record.state === 'healthy').length,
    stale: stale.length,
    conflicted: conflicts.length,
    staleFeatured: staleFeatured.length,
    staleLongTail: staleLongTail.length,
    coverageGapReleases: coverageGaps.length,
  };

  return {
    policyVersion: FRESHNESS_POLICY_VERSION,
    referenceDate,
    thresholds: { ...FRESHNESS_THRESHOLD_DAYS },
    summary,
    staleFeatured,
    staleLongTail,
    conflicts,
    coverageGaps,
    sourceTypeMix: collectSourceTypeMix(dataset),
    records,
  };
}

function renderRecordRow(record: RecordHealth): string {
  return `| \`${record.id}\` | ${record.kind} | ${record.category} | ${record.verifiedAt} | ${record.ageDays} | ${record.thresholdDays} |`;
}

/**
 * The human-readable artifact. Calm and factual: every stale line carries the
 * date and the threshold that produced the verdict, so a maintainer reads *why*
 * rather than a bare number. No score, no ranking, no alarm.
 */
export function renderDataHealthMarkdown(report: DataHealthReport): string {
  const lines: string[] = [];
  lines.push('# ModelTree data-health report');
  lines.push('');
  lines.push(`- Policy version: \`${report.policyVersion}\``);
  lines.push(`- Reference date: ${report.referenceDate}`);
  lines.push(
    `- Thresholds (days): volatile ${report.thresholds.volatile}, `
    + `evidence ${report.thresholds.evidence}, `
    + `release-metadata ${report.thresholds['release-metadata']}, `
    + `structural ${report.thresholds.structural}`,
  );
  lines.push('');
  lines.push(
    `Ordinary age is reported here, never failed. ${report.summary.total} dated records: `
    + `${report.summary.healthy} healthy, ${report.summary.stale} stale, `
    + `${report.summary.conflicted} conflicted.`,
  );
  lines.push('');

  lines.push('## Stale featured records');
  lines.push('');
  if (report.staleFeatured.length === 0) {
    lines.push('None. No featured record is past its freshness threshold.');
  } else {
    lines.push('| id | kind | category | verified | age (days) | threshold |');
    lines.push('| --- | --- | --- | --- | ---: | ---: |');
    for (const record of report.staleFeatured) lines.push(renderRecordRow(record));
  }
  lines.push('');

  lines.push('## Stale long-tail records');
  lines.push('');
  if (report.staleLongTail.length === 0) {
    lines.push('None. No long-tail record is past its freshness threshold.');
  } else {
    lines.push('| id | kind | category | verified | age (days) | threshold |');
    lines.push('| --- | --- | --- | --- | ---: | ---: |');
    for (const record of report.staleLongTail) lines.push(renderRecordRow(record));
  }
  lines.push('');

  lines.push('## Missing optional coverage');
  lines.push('');
  lines.push('Aspects a release could carry but no source has been recorded for yet.');
  lines.push('');
  if (report.coverageGaps.length === 0) {
    lines.push('None. Every release carries deployment, pricing, benchmark, and usage coverage.');
  } else {
    lines.push('| release | featured | missing |');
    lines.push('| --- | --- | --- |');
    for (const gap of report.coverageGaps) {
      lines.push(`| \`${gap.releaseId}\` | ${gap.featured ? 'yes' : 'no'} | ${gap.missing.join(', ')} |`);
    }
  }
  lines.push('');

  lines.push('## Source-type mix');
  lines.push('');
  lines.push('A coverage indicator, not a score. Counts of primary sources by type.');
  lines.push('');
  lines.push('| type | count |');
  lines.push('| --- | ---: |');
  for (const entry of report.sourceTypeMix) lines.push(`| ${entry.type} | ${entry.count} |`);
  lines.push('');

  lines.push('## Unresolved conflicts');
  lines.push('');
  lines.push('Recorded disagreements kept side by side. Nothing here picks a winner.');
  lines.push('');
  if (report.conflicts.length === 0) {
    lines.push('None recorded.');
  } else {
    lines.push('| id | kind | conflicts with |');
    lines.push('| --- | --- | --- |');
    for (const conflict of report.conflicts) {
      lines.push(`| \`${conflict.id}\` | ${conflict.kind} | ${conflict.conflictsWith.map((id) => `\`${id}\``).join(', ')} |`);
    }
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}
