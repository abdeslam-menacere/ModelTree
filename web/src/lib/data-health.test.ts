import { describe, expect, it } from 'vitest';
import type {
  Dataset,
  Deployment,
  ModelFamily,
  ModelRelease,
  Organization,
  PricingRecord,
  SourceReference,
  UsageObservation,
} from '../data/schema';
import {
  buildDataHealthReport,
  collectCoverageGaps,
  collectIntegrityViolations,
  enumerateRecords,
  renderDataHealthMarkdown,
} from '../lib/data-health';

const REFERENCE = '2026-08-30';

function emptyDataset(): Dataset {
  return {
    sources: [],
    publishers: [],
    organizations: [],
    families: [],
    releases: [],
    products: [],
    servingPlatforms: [],
    deployments: [],
    pricing: [],
    benchmarks: [],
    benchmarkResults: [],
    releaseEvents: [],
    usageObservations: [],
    usageSyntheses: [],
    modelFitStatements: [],
    modelFitEvidenceGaps: [],
  };
}

function org(id: string, verifiedAt: string): Organization {
  return {
    id,
    slug: id,
    name: id,
    shortName: id,
    type: 'company',
    website: 'https://example.com',
    releasePage: 'https://example.com/releases',
    description: 'test org',
    sourceIds: ['src'],
    verifiedAt,
  };
}

function family(id: string, verifiedAt: string): ModelFamily {
  return {
    id,
    slug: id,
    organizationId: 'org',
    name: id,
    description: 'test family',
    categories: ['language-reasoning'],
    firstReleaseDate: '2025-01-01',
    datePrecision: 'day',
    status: 'current',
    sourceIds: ['src'],
    verifiedAt,
  };
}

function release(
  id: string,
  verifiedAt: string,
  overrides: Partial<ModelRelease> = {},
): ModelRelease {
  return {
    id,
    slug: id,
    canonicalName: id,
    displayName: id,
    organizationId: 'org',
    familyId: 'fam',
    version: '1',
    variant: 'base',
    releaseDate: '2025-01-01',
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
    siblingIds: [],
    derivedFromIds: [],
    summary: 'test release',
    intendedUse: 'testing',
    sourceIds: ['src'],
    verifiedAt,
    ...overrides,
  };
}

function source(id: string, type: SourceReference['type'], lastCheckedDate: string): SourceReference {
  return { id, url: 'https://example.com', title: id, type, publisherId: 'pub', lastCheckedDate };
}

function deployment(id: string, releaseId: string, verifiedAt: string): Deployment {
  return {
    id,
    releaseId,
    platformId: 'plat',
    deliveryMode: 'hosted-api',
    regions: [],
    effectiveFrom: '2025-01-01',
    sourceIds: ['src'],
    verifiedAt,
  };
}

function pricing(id: string, deploymentId: string, verifiedAt: string): PricingRecord {
  return {
    id,
    deploymentId,
    currency: 'USD',
    unit: 'per-1m-tokens',
    rates: { input: 1 },
    effectiveFrom: '2025-01-01',
    sourceIds: ['src'],
    verifiedAt,
  };
}

function usageObservation(
  id: string,
  releaseId: string,
  verifiedAt: string,
  conflictsWithIds: string[] = [],
): UsageObservation {
  return {
    id,
    releaseId,
    metric: 'active-users',
    metricLabel: 'users',
    unit: 'people',
    population: 'all',
    valueAsStated: 'many',
    windowStart: '2025-01',
    windowEnd: '2025-02',
    methodology: 'stated',
    sourceCategory: 'creator-self-report',
    sourceIds: ['src'],
    scope: 'global',
    caveats: ['self-reported'],
    conflictsWithIds,
    verifiedAt,
  };
}

describe('record state classification', () => {
  it('is healthy at exactly the category threshold and stale one day past it', () => {
    // release is release-metadata -> 365 day threshold.
    const atThreshold = buildDataHealthReport(
      { ...emptyDataset(), releases: [release('r-edge', '2025-08-30')] },
      REFERENCE,
    );
    expect(atThreshold.records[0].ageDays).toBe(365);
    expect(atThreshold.records[0].state).toBe('healthy');

    const pastThreshold = buildDataHealthReport(
      { ...emptyDataset(), releases: [release('r-edge', '2025-08-29')] },
      REFERENCE,
    );
    expect(pastThreshold.records[0].ageDays).toBe(366);
    expect(pastThreshold.records[0].state).toBe('stale');
  });

  it('applies the volatile threshold to pricing, not the metadata one', () => {
    const data = {
      ...emptyDataset(),
      releases: [release('rel', '2026-08-20')],
      deployments: [deployment('dep', 'rel', '2026-08-20')],
      // 120 days old: fresh for a 365-day release, stale for a 90-day price.
      pricing: [pricing('price', 'dep', '2026-05-02')],
    };
    const report = buildDataHealthReport(data, REFERENCE);
    const price = report.records.find((r) => r.kind === 'pricing');
    expect(price?.category).toBe('volatile');
    expect(price?.thresholdDays).toBe(90);
    expect(price?.state).toBe('stale');
  });

  it('marks a record with recorded conflicts as conflicted regardless of age', () => {
    const data = {
      ...emptyDataset(),
      releases: [release('rel', '2026-08-20')],
      usageObservations: [
        usageObservation('obs-a', 'rel', '2026-08-20', ['obs-b']),
        usageObservation('obs-b', 'rel', '2026-08-20', ['obs-a']),
      ],
    };
    const report = buildDataHealthReport(data, REFERENCE);
    const obs = report.records.filter((r) => r.kind === 'usage-observation');
    expect(obs.every((r) => r.state === 'conflicted')).toBe(true);
    expect(report.conflicts.map((c) => c.id).sort()).toEqual(['obs-a', 'obs-b']);
  });
});

describe('featured prioritisation', () => {
  it('separates stale featured records from the stale long tail', () => {
    const data = {
      ...emptyDataset(),
      families: [family('fam', '2024-01-01')],
      releases: [
        release('feat', '2024-01-01', { featured: true, featuredRationale: 'lead model' }),
        release('tail', '2024-01-01'),
      ],
    };
    const report = buildDataHealthReport(data, REFERENCE);
    expect(report.staleFeatured.map((r) => r.id)).toContain('feat');
    expect(report.staleFeatured.map((r) => r.id)).not.toContain('tail');
    expect(report.staleLongTail.map((r) => r.id)).toContain('tail');
    // The family of a featured release is stale and prioritised with it.
    expect(report.staleFeatured.map((r) => r.id)).toContain('fam');
  });

  it('prioritises a stale price on a featured release with the featured group', () => {
    const data = {
      ...emptyDataset(),
      releases: [release('feat', '2026-08-20', { featured: true, featuredRationale: 'lead' })],
      deployments: [deployment('dep', 'feat', '2026-08-20')],
      pricing: [pricing('price', 'dep', '2026-01-01')],
    };
    const report = buildDataHealthReport(data, REFERENCE);
    expect(report.staleFeatured.some((r) => r.id === 'price')).toBe(true);
  });
});

describe('coverage gaps (the unknown/unverified state)', () => {
  it('reports each optional aspect a release is missing', () => {
    const gaps = collectCoverageGaps({
      ...emptyDataset(),
      releases: [release('bare', '2026-08-20', { featured: true, featuredRationale: 'lead' })],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ releaseId: 'bare', featured: true });
    expect(gaps[0].missing).toEqual(['deployment', 'pricing', 'benchmark-result', 'usage-evidence']);
  });

  it('drops an aspect once a record supplies it', () => {
    const gaps = collectCoverageGaps({
      ...emptyDataset(),
      releases: [release('rel', '2026-08-20')],
      deployments: [deployment('dep', 'rel', '2026-08-20')],
      pricing: [pricing('price', 'dep', '2026-08-20')],
      usageObservations: [usageObservation('obs', 'rel', '2026-08-20')],
    });
    expect(gaps[0].missing).toEqual(['benchmark-result']);
  });
});

describe('source-type mix', () => {
  it('counts primary sources by type, most common first', () => {
    const report = buildDataHealthReport(
      {
        ...emptyDataset(),
        sources: [
          source('a', 'official-docs', '2026-08-20'),
          source('b', 'official-docs', '2026-08-20'),
          source('c', 'independent-evaluation', '2026-08-20'),
        ],
      },
      REFERENCE,
    );
    expect(report.sourceTypeMix).toEqual([
      { type: 'official-docs', count: 2 },
      { type: 'independent-evaluation', count: 1 },
    ]);
  });
});

describe('integrity violations vs ordinary age', () => {
  it('flags a verifiedAt in the future as a hard violation', () => {
    const violations = collectIntegrityViolations(
      { ...emptyDataset(), releases: [release('future', '2027-01-01')] },
      REFERENCE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'release', id: 'future' });
    expect(violations[0].message).toContain('future');
  });

  it('never treats ordinary age as an integrity violation', () => {
    // A dataset made entirely of ancient-but-well-formed records: many stale
    // findings, zero integrity violations. This is the guarantee that ordinary
    // age cannot fail CI.
    const data = {
      ...emptyDataset(),
      sources: [source('src', 'official-docs', '2015-01-01')],
      organizations: [org('org', '2015-01-01')],
      families: [family('fam', '2015-01-01')],
      releases: [release('rel', '2015-01-01')],
    };
    expect(collectIntegrityViolations(data, REFERENCE)).toHaveLength(0);
    const report = buildDataHealthReport(data, REFERENCE);
    expect(report.summary.stale).toBe(report.summary.total);
    expect(report.summary.stale).toBeGreaterThan(0);
  });

  it('dates a source by its lastCheckedDate and a publisher by its control block', () => {
    const records = enumerateRecords({
      ...emptyDataset(),
      sources: [source('src', 'official-docs', '2026-08-01')],
      publishers: [
        { id: 'pub', name: 'Pub', control: { parentId: 'parent', sourceIds: ['src'], verifiedAt: '2026-07-01' } },
      ],
    });
    expect(records.find((r) => r.kind === 'source')?.verifiedAt).toBe('2026-08-01');
    expect(records.find((r) => r.kind === 'publisher-control')?.verifiedAt).toBe('2026-07-01');
  });
});

describe('human-readable report', () => {
  it('renders the calm, factual sections with dates and thresholds', () => {
    const data = {
      ...emptyDataset(),
      sources: [source('src', 'official-docs', '2026-08-20')],
      families: [family('fam', '2026-08-20')],
      releases: [
        release('feat', '2024-01-01', { featured: true, featuredRationale: 'lead' }),
        release('fresh', '2026-08-20'),
      ],
      usageObservations: [
        usageObservation('obs-a', 'fresh', '2026-08-20', ['obs-b']),
        usageObservation('obs-b', 'fresh', '2026-08-20', ['obs-a']),
      ],
    };
    const markdown = renderDataHealthMarkdown(buildDataHealthReport(data, REFERENCE));
    expect(markdown).toMatchSnapshot();
  });
});
