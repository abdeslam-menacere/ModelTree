import { describe, expect, it } from 'vitest';
import { rawDataset } from '../data/raw';
import { validateDataset } from '../data/validate';
import type { Publisher, SourceReference, UsageObservation } from '../data/schema';
import {
  buildUsageEvidence,
  canSynthesize,
  daysSince,
  independentPublishers,
  STALE_AFTER_DAYS,
} from './usage-evidence';

const TODAY = '2026-08-18';

// Two publishers deliberately share the display name "Analyst House" but have
// distinct ids, so they must count as two independent voices.
const publishers: Publisher[] = [
  { id: 'example-creator', name: 'Example Creator' },
  { id: 'router-platform', name: 'Router Platform' },
  { id: 'analyst-house', name: 'Analyst House' },
  { id: 'analyst-house-a', name: 'Analyst House' },
  { id: 'analyst-house-b', name: 'Analyst House' },
];

const publisherById = new Map(publishers.map((publisher) => [publisher.id, publisher]));

const sources: SourceReference[] = [
  {
    id: 'creator-blog',
    url: 'https://example.com/creator',
    title: 'Creator usage update',
    type: 'official-announcement',
    publisherId: 'example-creator',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'platform-report',
    url: 'https://example.com/platform',
    title: 'Platform routing report',
    type: 'independent-evaluation',
    publisherId: 'router-platform',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'analyst-report',
    url: 'https://example.com/analyst',
    title: 'Analyst measurement',
    type: 'independent-evaluation',
    publisherId: 'analyst-house',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'analyst-second-report',
    url: 'https://example.com/analyst-2',
    title: 'Analyst measurement, second quarter',
    type: 'independent-evaluation',
    publisherId: 'analyst-house',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'analyst-a-report',
    url: 'https://example.com/analyst-a',
    title: 'First analyst house measurement',
    type: 'independent-evaluation',
    publisherId: 'analyst-house-a',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'analyst-b-report',
    url: 'https://example.com/analyst-b',
    title: 'Second analyst house measurement',
    type: 'independent-evaluation',
    publisherId: 'analyst-house-b',
    lastCheckedDate: '2026-08-01',
  },
];

const sourceById = new Map(sources.map((source) => [source.id, source]));

function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    id: 'observation-a',
    releaseId: 'release-a',
    metric: 'tokens',
    metricLabel: 'Routed tokens',
    unit: 'share of routed tokens',
    population: 'requests routed by one aggregator',
    valueAsStated: 'about 4% of routed tokens',
    windowStart: '2026-05',
    windowEnd: '2026-06',
    methodology: 'Platform-reported routing totals',
    sourceCategory: 'independent-measurement',
    sourceIds: ['platform-report'],
    scope: 'One aggregator only',
    caveats: ['Covers one aggregator, not the whole market'],
    conflictsWithIds: [],
    verifiedAt: '2026-08-01',
    ...overrides,
  };
}

describe('synthesis thresholds', () => {
  it('refuses a synthesis from a single non-creator observation', () => {
    expect(canSynthesize([observation()], sourceById, publisherById)).toBe(false);
  });

  it('refuses a synthesis when two observations share one publisher', () => {
    const observations = [
      observation({ id: 'observation-a', sourceIds: ['analyst-report'] }),
      observation({ id: 'observation-b', sourceIds: ['analyst-second-report'] }),
    ];

    expect(independentPublishers(observations, sourceById, publisherById)).toEqual(['Analyst House']);
    expect(canSynthesize(observations, sourceById, publisherById)).toBe(false);
  });

  it('counts two independent publishers that share a display name as two', () => {
    const observations = [
      observation({ id: 'observation-a', sourceIds: ['analyst-a-report'] }),
      observation({ id: 'observation-b', sourceIds: ['analyst-b-report'] }),
    ];

    expect(independentPublishers(observations, sourceById, publisherById)).toEqual([
      'Analyst House',
      'Analyst House',
    ]);
    expect(canSynthesize(observations, sourceById, publisherById)).toBe(true);
  });

  it('refuses a synthesis when creator self-reports make up the count', () => {
    const observations = [
      observation({ id: 'observation-a' }),
      observation({
        id: 'observation-b',
        sourceCategory: 'creator-self-report',
        sourceIds: ['creator-blog'],
      }),
    ];

    expect(canSynthesize(observations, sourceById, publisherById)).toBe(false);
  });

  it('allows a synthesis from two independent publishers', () => {
    const observations = [
      observation({ id: 'observation-a', sourceIds: ['platform-report'] }),
      observation({ id: 'observation-b', sourceIds: ['analyst-report'] }),
    ];

    expect(canSynthesize(observations, sourceById, publisherById)).toBe(true);
  });
});

describe('buildUsageEvidence', () => {
  it('reports the no-data state when nothing is recorded', () => {
    const view = buildUsageEvidence(
      { sources, publishers, usageObservations: [], usageSyntheses: [] },
      'release-a',
      TODAY,
    );

    expect(view.state).toBe('no-data');
    expect(view.groups).toEqual([]);
    expect(view.observationCount).toBe(0);
  });

  it('keeps incompatible metrics and populations in separate groups', () => {
    const view = buildUsageEvidence(
      {
        sources,
        publishers,
        usageObservations: [
          observation({ id: 'observation-a' }),
          observation({
            id: 'observation-b',
            metric: 'downloads',
            metricLabel: 'Model hub downloads',
            unit: 'downloads',
            population: 'downloads from one model hub',
            sourceIds: ['analyst-report'],
          }),
        ],
        usageSyntheses: [],
      },
      'release-a',
      TODAY,
    );

    expect(view.state).toBe('evidence');
    expect(view.groups).toHaveLength(2);
    for (const group of view.groups) {
      expect(group.observations).toHaveLength(1);
      expect(group.canSynthesize).toBe(false);
    }
  });

  it('labels creator self-reports and marks stale verification', () => {
    const staleDate = '2026-01-01';
    const view = buildUsageEvidence(
      {
        sources,
        publishers,
        usageObservations: [
          observation({
            id: 'observation-a',
            sourceCategory: 'creator-self-report',
            sourceIds: ['creator-blog'],
            verifiedAt: staleDate,
          }),
        ],
        usageSyntheses: [],
      },
      'release-a',
      TODAY,
    );

    const [entry] = view.groups[0].observations;
    expect(entry.isCreatorSelfReport).toBe(true);
    expect(entry.provenanceLabel).toBe('Creator self-report');
    expect(daysSince(staleDate, TODAY)).toBeGreaterThan(STALE_AFTER_DAYS);
    expect(entry.isStale).toBe(true);
    expect(view.hasStale).toBe(true);
    expect(view.hasCreatorSelfReport).toBe(true);
  });

  it('surfaces a conflict without choosing a reading', () => {
    const view = buildUsageEvidence(
      {
        sources,
        publishers,
        usageObservations: [
          observation({
            id: 'observation-a',
            sourceIds: ['platform-report'],
            conflictsWithIds: ['observation-b'],
          }),
          observation({
            id: 'observation-b',
            sourceIds: ['analyst-report'],
            valueAsStated: 'about 9% of routed tokens',
            conflictsWithIds: ['observation-a'],
          }),
        ],
        usageSyntheses: [],
      },
      'release-a',
      TODAY,
    );

    expect(view.groups).toHaveLength(1);
    expect(view.hasConflict).toBe(true);
    expect(view.groups[0].observations.map((entry) => entry.conflictsWith)).toEqual([
      ['Routed tokens'],
      ['Routed tokens'],
    ]);
    expect(view.groups[0].observations.map((entry) => entry.observation.valueAsStated)).toEqual([
      'about 4% of routed tokens',
      'about 9% of routed tokens',
    ]);
  });

  it('renders evidence only for the releases the seed actually observes', () => {
    const seed = validateDataset(structuredClone(rawDataset));
    const observed = new Set(seed.usageObservations.map((observation) => observation.releaseId));

    // The no-data state is a supported state, not a placeholder: every release
    // without a qualifying observation must still resolve to it.
    expect(observed.size).toBeGreaterThan(0);
    for (const release of seed.releases) {
      expect(buildUsageEvidence(seed, release.id, TODAY).state).toBe(
        observed.has(release.id) ? 'evidence' : 'no-data',
      );
    }
  });
});
