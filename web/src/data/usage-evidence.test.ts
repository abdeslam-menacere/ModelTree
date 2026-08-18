import { describe, expect, it } from 'vitest';
import { rawDataset } from './raw';
import { comparabilityKey, validateDataset } from './validate';
import type { UsageObservation, UsageSynthesis } from './schema';

const RELEASE_ID = 'openai-gpt-4-1-2025-04-14';

const EXTRA_SOURCES = [
  {
    id: 'test-creator-usage-post',
    url: 'https://example.com/creator-usage',
    title: 'Creator usage update',
    type: 'official-announcement',
    publisher: 'OpenAI',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'test-router-usage-report',
    url: 'https://example.com/router-usage',
    title: 'Aggregator routing report',
    type: 'independent-evaluation',
    publisher: 'Router Platform',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'test-analyst-usage-report',
    url: 'https://example.com/analyst-usage',
    title: 'Analyst measurement',
    type: 'independent-evaluation',
    publisher: 'Analyst House',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'test-analyst-second-usage-report',
    url: 'https://example.com/analyst-usage-2',
    title: 'Analyst measurement, second window',
    type: 'independent-evaluation',
    publisher: 'Analyst House',
    lastCheckedDate: '2026-08-01',
  },
];

function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    id: 'test-observation-router',
    releaseId: RELEASE_ID,
    metric: 'tokens',
    metricLabel: 'Routed tokens',
    unit: 'share of routed tokens',
    population: 'requests routed by one aggregator',
    valueAsStated: 'about 4% of routed tokens',
    windowStart: '2026-05',
    windowEnd: '2026-06',
    methodology: 'Aggregator-reported routing totals',
    sourceCategory: 'independent-measurement',
    sourceIds: ['test-router-usage-report'],
    scope: 'One aggregator only',
    caveats: ['Covers one aggregator, not the whole market'],
    conflictsWithIds: [],
    verifiedAt: '2026-08-01',
    ...overrides,
  };
}

function synthesis(overrides: Partial<UsageSynthesis> = {}): UsageSynthesis {
  return {
    id: 'test-synthesis-router',
    releaseId: RELEASE_ID,
    statement: 'Two independent reporters observed the model among routed traffic in mid-2026.',
    observationIds: ['test-observation-router', 'test-observation-analyst'],
    agreement: 'agreeing',
    comparabilityNote: 'Both readings cover the same metric, unit, and routed-request population.',
    caveats: ['Neither reading describes usage outside routed aggregator traffic'],
    verifiedAt: '2026-08-02',
    ...overrides,
  };
}

/** The seed dataset plus the injected usage records under test. */
function datasetWith(
  usageObservations: UsageObservation[],
  usageSyntheses: UsageSynthesis[] = [],
): Record<string, unknown> {
  const input = structuredClone(rawDataset) as Record<string, any>;
  input.sources = [...input.sources, ...structuredClone(EXTRA_SOURCES)];
  input.usageObservations = usageObservations;
  input.usageSyntheses = usageSyntheses;
  return input;
}

const independentPair = [
  observation(),
  observation({
    id: 'test-observation-analyst',
    sourceIds: ['test-analyst-usage-report'],
    valueAsStated: 'about 5% of routed tokens',
  }),
];

describe('usage observation schema and provenance', () => {
  it('defaults to no usage evidence when the dataset omits it', () => {
    const parsed = validateDataset(structuredClone(rawDataset));

    expect(parsed.usageObservations).toEqual([]);
    expect(parsed.usageSyntheses).toEqual([]);
  });

  it('accepts a fully provenanced observation', () => {
    const parsed = validateDataset(datasetWith([observation()]));

    expect(parsed.usageObservations).toHaveLength(1);
    expect(parsed.usageObservations[0].sourceIds).toEqual(['test-router-usage-report']);
  });

  it('rejects an observation with no source', () => {
    expect(() => validateDataset(datasetWith([observation({ sourceIds: [] })])))
      .toThrow(/sourceIds/);
  });

  it('rejects an observation with no stated caveat', () => {
    expect(() => validateDataset(datasetWith([observation({ caveats: [] })])))
      .toThrow(/caveats/);
  });

  it('rejects an observation citing a missing source', () => {
    expect(() => validateDataset(datasetWith([observation({ sourceIds: ['no-such-source'] })])))
      .toThrow(/references missing id "no-such-source"/);
  });

  it('rejects an observation about a missing release', () => {
    expect(() => validateDataset(datasetWith([observation({ releaseId: 'no-such-release' })])))
      .toThrow(/releaseId references missing id "no-such-release"/);
  });

  it('rejects a window that closes after the verification date', () => {
    expect(() => validateDataset(datasetWith([observation({ windowEnd: '2026-09' })])))
      .toThrow(/verified before its measurement window ended/);
  });

  it('rejects a window that predates the release', () => {
    expect(() => validateDataset(datasetWith([observation({ windowStart: '2024-01', windowEnd: '2024-02' })])))
      .toThrow(/precedes release/);
  });

  it('rejects independent evidence published by the model creator', () => {
    expect(() => validateDataset(datasetWith([observation({ sourceIds: ['test-creator-usage-post'] })])))
      .toThrow(/claims independent evidence but cites a source published by OpenAI/);
  });

  it('rejects a creator self-report that cites nothing from the creator', () => {
    const selfReport = observation({ sourceCategory: 'creator-self-report' });

    expect(() => validateDataset(datasetWith([selfReport])))
      .toThrow(/labelled a creator self-report but cites no source published by OpenAI/);
  });

  it('accepts a creator self-report backed by a creator primary source', () => {
    const parsed = validateDataset(datasetWith([
      observation({ sourceCategory: 'creator-self-report', sourceIds: ['test-creator-usage-post'] }),
    ]));

    expect(parsed.usageObservations[0].sourceCategory).toBe('creator-self-report');
  });
});

describe('conflicting observations', () => {
  it('accepts a reciprocal conflict between comparable readings', () => {
    const parsed = validateDataset(datasetWith([
      observation({ conflictsWithIds: ['test-observation-analyst'] }),
      observation({
        id: 'test-observation-analyst',
        sourceIds: ['test-analyst-usage-report'],
        valueAsStated: 'about 9% of routed tokens',
        conflictsWithIds: ['test-observation-router'],
      }),
    ]));

    expect(parsed.usageObservations.map(({ id }) => id)).toEqual([
      'test-observation-router',
      'test-observation-analyst',
    ]);
  });

  it('rejects a one-sided conflict', () => {
    expect(() => validateDataset(datasetWith([
      observation({ conflictsWithIds: ['test-observation-analyst'] }),
      observation({ id: 'test-observation-analyst', sourceIds: ['test-analyst-usage-report'] }),
    ]))).toThrow(/conflict with test-observation-analyst is not reciprocal/);
  });

  it('rejects a conflict between incomparable populations', () => {
    expect(() => validateDataset(datasetWith([
      observation({ conflictsWithIds: ['test-observation-downloads'] }),
      observation({
        id: 'test-observation-downloads',
        metric: 'downloads',
        metricLabel: 'Model hub downloads',
        unit: 'downloads',
        population: 'downloads from one model hub',
        sourceIds: ['test-analyst-usage-report'],
        conflictsWithIds: ['test-observation-router'],
      }),
    ]))).toThrow(/measures an incomparable metric or population/);
  });
});

describe('cross-source synthesis rules', () => {
  it('accepts a synthesis backed by two independent publishers', () => {
    const parsed = validateDataset(datasetWith(independentPair, [synthesis()]));

    expect(parsed.usageSyntheses).toHaveLength(1);
  });

  it('rejects a synthesis built from a single observation', () => {
    expect(() => validateDataset(datasetWith(
      [observation()],
      [synthesis({ observationIds: ['test-observation-router'] })],
    ))).toThrow(/observationIds/);
  });

  it('rejects a synthesis whose sources share one publisher', () => {
    expect(() => validateDataset(datasetWith(
      [
        observation({ sourceIds: ['test-analyst-usage-report'] }),
        observation({
          id: 'test-observation-analyst',
          sourceIds: ['test-analyst-second-usage-report'],
        }),
      ],
      [synthesis()],
    ))).toThrow(/requires at least two independent non-creator sources/);
  });

  it('rejects a synthesis that leans on a creator self-report', () => {
    expect(() => validateDataset(datasetWith(
      [
        observation(),
        observation({
          id: 'test-observation-analyst',
          sourceCategory: 'creator-self-report',
          sourceIds: ['test-creator-usage-post'],
        }),
      ],
      [synthesis()],
    ))).toThrow(/requires at least two independent non-creator sources/);
  });

  it('rejects a synthesis that combines incomparable metrics', () => {
    expect(() => validateDataset(datasetWith(
      [
        observation(),
        observation({
          id: 'test-observation-analyst',
          metric: 'downloads',
          metricLabel: 'Model hub downloads',
          unit: 'downloads',
          population: 'downloads from one model hub',
          sourceIds: ['test-analyst-usage-report'],
        }),
      ],
      [synthesis()],
    ))).toThrow(/combines incomparable metrics or populations/);
  });

  it('rejects a synthesis that calls conflicting readings agreement', () => {
    expect(() => validateDataset(datasetWith(
      [
        observation({ conflictsWithIds: ['test-observation-analyst'] }),
        observation({
          id: 'test-observation-analyst',
          sourceIds: ['test-analyst-usage-report'],
          valueAsStated: 'about 9% of routed tokens',
          conflictsWithIds: ['test-observation-router'],
        }),
      ],
      [synthesis()],
    ))).toThrow(/reports agreement between observations that record a conflict/);
  });

  it('rejects a claimed conflict that no observation records', () => {
    expect(() => validateDataset(datasetWith(
      independentPair,
      [synthesis({ agreement: 'conflicting' })],
    ))).toThrow(/reports a conflict that none of its observations records/);
  });

  it('rejects a synthesis citing an observation about another release', () => {
    expect(() => validateDataset(datasetWith(
      [
        observation(),
        observation({
          id: 'test-observation-analyst',
          releaseId: 'openai-gpt-4-1-mini-2025-04-14',
          sourceIds: ['test-analyst-usage-report'],
        }),
      ],
      [synthesis()],
    ))).toThrow(/describes another release/);
  });
});

describe('comparabilityKey', () => {
  it('separates different metrics, units, and populations', () => {
    const base = observation();

    expect(comparabilityKey(base)).toBe(comparabilityKey(observation({ id: 'other' })));
    expect(comparabilityKey(base)).not.toBe(comparabilityKey(observation({ unit: 'requests' })));
    expect(comparabilityKey(base)).not.toBe(comparabilityKey(observation({ population: 'all traffic' })));
    expect(comparabilityKey(base)).not.toBe(comparabilityKey(observation({ metric: 'downloads' })));
  });
});
