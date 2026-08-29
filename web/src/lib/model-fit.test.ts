import { describe, expect, it } from 'vitest';
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  Deployment,
  ModelFamily,
  ModelFitEvidenceGap,
  ModelFitStatement,
  ModelRelease,
  Organization,
  PricingRecord,
  Publisher,
  ReleaseEvent,
  SourceReference,
  UsageObservation,
} from '../data/schema';
import { buildModelFitGuidance, fitClassificationLabel, fitDimensionLabel, fitRubric } from './model-fit';
import { FIT_RUBRIC_DIMENSIONS } from '../data/model-fit-rubric';

const TODAY = '2026-08-18';
const RELEASE_ID = 'release-a';

const organizations: Organization[] = [
  {
    id: 'example-org',
    slug: 'example-org',
    name: 'Example Org',
    shortName: 'Example',
    type: 'company',
    website: 'https://example.com',
    releasePage: 'https://example.com/releases',
    description: 'A creator organization.',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

// `creator-arm` is an arm of `creator-voice`, so a source it publishes must still
// resolve to the creator rather than being read as an outside voice.
const publishers: Publisher[] = [
  { id: 'creator-voice', name: 'Example Org', organizationId: 'example-org' },
  {
    id: 'creator-arm',
    name: 'Example Org Research',
    control: { parentId: 'creator-voice', sourceIds: ['creator-docs'], verifiedAt: '2026-08-01' },
  },
  { id: 'analyst-house', name: 'Analyst House' },
];

const sources: SourceReference[] = [
  {
    id: 'creator-docs',
    url: 'https://example.com/docs',
    title: 'Creator documentation',
    type: 'official-docs',
    publisherId: 'creator-voice',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'creator-arm-note',
    url: 'https://example.com/research',
    title: 'Creator research note',
    type: 'official-announcement',
    publisherId: 'creator-arm',
    lastCheckedDate: '2026-08-01',
  },
  {
    id: 'analyst-report',
    url: 'https://example.org/report',
    title: 'Analyst report',
    type: 'independent-evaluation',
    publisherId: 'analyst-house',
    lastCheckedDate: '2026-08-01',
  },
];

const families: ModelFamily[] = [
  {
    id: 'family-a',
    slug: 'family-a',
    organizationId: 'example-org',
    name: 'Family A',
    description: 'A model family.',
    categories: ['language-reasoning'],
    firstReleaseDate: '2026-01-01',
    datePrecision: 'day',
    status: 'legacy',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

const releases: ModelRelease[] = [
  {
    id: RELEASE_ID,
    slug: 'release-a',
    canonicalName: 'Release A',
    displayName: 'Release A',
    organizationId: 'example-org',
    familyId: 'family-a',
    version: '1',
    variant: 'Base',
    releaseDate: '2026-01-01',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'open-weight',
    license: { name: 'Example Community Licence', weightsDownloadable: true, osiApproved: false },
    contextWindow: 200000,
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    derivedFromIds: [],
    summary: 'A model.',
    intendedUse: 'Assistant-style chat.',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

// Documentation recorded by somebody who is neither the creator nor a measurer.
const releaseEvents: ReleaseEvent[] = [
  {
    id: 'event-a',
    releaseId: RELEASE_ID,
    type: 'generally-available',
    date: '2026-01-01',
    datePrecision: 'day',
    note: 'Listed as generally available in an outside registry.',
    sourceIds: ['analyst-report'],
    verifiedAt: '2026-08-01',
  },
];

const benchmarks: BenchmarkDefinition[] = [  {
    id: 'bench-a',
    slug: 'bench-a',
    name: 'Bench A',
    domain: 'general-reasoning',
    owner: 'Bench Owner',
    metric: 'accuracy',
    metricUnit: '%',
    direction: 'higher-is-better',
    sourceIds: ['analyst-report'],
    verifiedAt: '2026-08-01',
  },
];

const benchmarkResults: BenchmarkResult[] = [
  {
    id: 'result-independent',
    benchmarkId: 'bench-a',
    benchmarkVersion: '2026-01',
    releaseId: RELEASE_ID,
    score: 71.5,
    unit: '%',
    evaluationDate: '2026-06',
    resultType: 'independent',
    sourceIds: ['analyst-report'],
    verifiedAt: '2026-08-01',
  },
  {
    id: 'result-official',
    benchmarkId: 'bench-a',
    benchmarkVersion: '2026-01',
    releaseId: RELEASE_ID,
    score: 78,
    unit: '%',
    evaluationDate: '2026-06',
    resultType: 'official',
    sourceIds: ['creator-arm-note'],
    verifiedAt: '2026-08-01',
  },
];

const usageObservations: UsageObservation[] = [
  {
    id: 'observation-a',
    releaseId: RELEASE_ID,
    metric: 'downloads',
    metricLabel: 'Model hub downloads',
    unit: 'downloads',
    population: 'downloads from one model hub',
    valueAsStated: '120,000 downloads',
    windowStart: '2026-05',
    windowEnd: '2026-06',
    methodology: 'Hub-reported totals',
    sourceCategory: 'independent-measurement',
    sourceIds: ['analyst-report'],
    scope: 'One hub only',
    caveats: ['One hub only'],
    conflictsWithIds: [],
    verifiedAt: '2026-08-01',
  },
];

const deployments: Deployment[] = [
  {
    id: 'deployment-a',
    releaseId: RELEASE_ID,
    platformId: 'platform-a',
    deliveryMode: 'hosted-api',
    regions: [],
    effectiveFrom: '2026-01-01',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

const pricing: PricingRecord[] = [
  {
    id: 'pricing-a',
    deploymentId: 'deployment-a',
    currency: 'USD',
    unit: 'per-1m-tokens',
    rates: { input: 0.5, output: 2 },
    effectiveFrom: '2026-01-01',
    sourceIds: ['creator-docs'],
    verifiedAt: '2026-08-01',
  },
];

function statement(overrides: Partial<ModelFitStatement> = {}): ModelFitStatement {
  return {
    id: 'fit-a',
    releaseId: RELEASE_ID,
    classification: 'good-fit-when',
    condition: 'you must run the model on hardware you operate',
    statement: 'The weights are published for download under a stated licence.',
    rubricDimensions: ['access-and-licensing'],
    facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' }],
    sourceIds: ['creator-docs'],
    scope: 'Availability only.',
    caveats: ['Availability says nothing about behaviour.'],
    conflictsWithIds: [],
    verifiedAt: '2026-08-01',
    ...overrides,
  };
}

function build(
  modelFitStatements: ModelFitStatement[],
  modelFitEvidenceGaps: ModelFitEvidenceGap[] = [],
  releaseId = RELEASE_ID,
) {
  return buildModelFitGuidance(
    {
      sources,
      publishers,
      organizations,
      families,
      releases,
      releaseEvents,
      benchmarks,
      benchmarkResults,
      usageObservations,
      pricing,
      deployments,
      modelFitStatements,
      modelFitEvidenceGaps,
    },
    releaseId,
    TODAY,
  );
}

describe('the disclosed rubric', () => {
  it('exposes every dimension with the question it asks', () => {
    const rubric = fitRubric();

    expect(rubric.map(({ dimension }) => dimension)).toEqual([...FIT_RUBRIC_DIMENSIONS]);
    for (const entry of rubric) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.question).toMatch(/\?$/);
    }
  });

  it('carries no weight, score, or ordering with a dimension', () => {
    for (const entry of fitRubric()) {
      expect(entry).toEqual({
        dimension: entry.dimension,
        label: entry.label,
        question: entry.question,
      });
    }
  });

  it('labels classifications and dimensions in reader-facing words', () => {
    expect(fitClassificationLabel('good-fit-when')).toBe('Good fit when');
    expect(fitClassificationLabel('trade-off')).toBe('Trade-off');
    expect(fitClassificationLabel('avoid-when')).toBe('Avoid when');
    expect(fitDimensionLabel('access-and-licensing')).toBe('Access and licensing');
  });

  it('reports the dimensions behind each statement, and only those', () => {
    const view = build([statement({
      rubricDimensions: ['access-and-licensing', 'context-window'],
      facts: [
        { kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' },
        { kind: 'release-field', releaseId: RELEASE_ID, field: 'contextWindow' },
      ],
    })]);

    expect(view.groups[0].statements[0].rubric.map(({ dimension }) => dimension))
      .toEqual(['access-and-licensing', 'context-window']);
  });
});

describe('facts a statement rests on', () => {
  it('resolves a release field to its recorded value', () => {
    const view = build([statement({
      rubricDimensions: ['context-window'],
      facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'contextWindow' }],
    })]);
    const [fact] = view.groups[0].statements[0].facts;

    expect(fact.label).toBe('Context window');
    expect(fact.detail).toContain('200,000 tokens');
    expect(fact.sources.map(({ source }) => source.id)).toEqual(['creator-docs']);
  });

  it('resolves a family field and names the family it describes', () => {
    const view = build([statement({
      rubricDimensions: ['lifecycle-stability'],
      facts: [{ kind: 'family-field', familyId: 'family-a', field: 'status' }],
    })]);
    const [fact] = view.groups[0].statements[0].facts;

    expect(fact.label).toBe('Family lifecycle status');
    expect(fact.detail).toBe('Family A: Legacy');
  });

  it('resolves a pricing record with its unit and currency intact', () => {
    const view = build([statement({
      rubricDimensions: ['cost-structure'],
      facts: [{ kind: 'pricing-record', pricingRecordId: 'pricing-a' }],
    })]);
    const [fact] = view.groups[0].statements[0].facts;

    expect(fact.detail).toContain('input 0.5 USD');
    expect(fact.detail).toContain('per 1m tokens');
  });

  it('drops a fact whose record has gone rather than inventing one', () => {
    const view = build([statement({
      facts: [
        { kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' },
        { kind: 'benchmark-result', benchmarkResultId: 'missing-result' },
      ],
    })]);

    expect(view.groups[0].statements[0].facts).toHaveLength(1);
  });
});

describe('evidence classes', () => {
  it('treats an independent evaluation as measured evidence', () => {
    const view = build([statement({
      rubricDimensions: ['measured-benchmark-evidence'],
      facts: [{ kind: 'benchmark-result', benchmarkResultId: 'result-independent' }],
      sourceIds: ['analyst-report'],
    })]);

    expect(view.groups[0].statements[0].facts[0].evidenceClass).toBe('measured-evidence');
    expect(view.evidenceClassesUsed).toEqual(['measured-evidence']);
  });

  it('treats a creator-run evaluation as a creator claim, not a measurement', () => {
    const view = build([statement({
      rubricDimensions: ['measured-benchmark-evidence'],
      facts: [{ kind: 'benchmark-result', benchmarkResultId: 'result-official' }],
      sourceIds: ['creator-arm-note'],
    })]);

    expect(view.groups[0].statements[0].facts[0].evidenceClass).toBe('creator-claim');
  });

  it('resolves a corporate arm of the creator to the creator, not a third party', () => {
    const view = build([statement({
      facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' }],
    })]);

    // The release cites creator-docs, published by the creator's own voice.
    expect(view.groups[0].statements[0].facts[0].evidenceClass).toBe('creator-claim');
  });

  it('treats an independently measured usage figure as measured evidence', () => {
    const view = build([statement({
      rubricDimensions: ['usage-evidence'],
      facts: [{ kind: 'usage-observation', usageObservationId: 'observation-a' }],
      sourceIds: ['analyst-report'],
    })]);

    expect(view.groups[0].statements[0].facts[0].evidenceClass).toBe('measured-evidence');
  });

  it('treats documentation from a non-creator publisher as a third-party record', () => {
    const view = build([statement({
      rubricDimensions: ['lifecycle-stability'],
      facts: [{ kind: 'release-event', eventId: 'event-a' }],
      sourceIds: ['analyst-report'],
    })]);

    expect(view.groups[0].statements[0].facts[0].evidenceClass).toBe('third-party-record');
  });

  it('groups evidence by class with measurement first and creator claims last', () => {
    const view = build([statement({
      rubricDimensions: ['access-and-licensing', 'lifecycle-stability', 'measured-benchmark-evidence'],
      facts: [
        { kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' },
        { kind: 'release-event', eventId: 'event-a' },
        { kind: 'benchmark-result', benchmarkResultId: 'result-independent' },
      ],
      sourceIds: ['creator-docs', 'analyst-report'],
    })]);

    expect(view.groups[0].statements[0].evidenceByClass.map(({ evidenceClass }) => evidenceClass))
      .toEqual(['measured-evidence', 'third-party-record', 'creator-claim']);
    expect(view.evidenceClassesUsed)
      .toEqual(['measured-evidence', 'third-party-record', 'creator-claim']);
  });

  it('omits an evidence class with nothing in it', () => {
    const view = build([statement()]);

    expect(view.groups[0].statements[0].evidenceByClass).toHaveLength(1);
  });
});

describe('grouping and states', () => {
  it('reports the no-guidance state without inventing an empty group', () => {
    const view = build([]);

    expect(view.state).toBe('no-guidance');
    expect(view.groups).toEqual([]);
    expect(view.statementCount).toBe(0);
  });

  it('ignores guidance recorded against another release', () => {
    const view = build([statement({ releaseId: 'release-b' })]);

    expect(view.state).toBe('no-guidance');
  });

  it('orders groups fit, trade-off, avoid regardless of record order', () => {
    const view = build([
      statement({ id: 'fit-avoid', classification: 'avoid-when' }),
      statement({ id: 'fit-trade', classification: 'trade-off' }),
      statement({ id: 'fit-good', classification: 'good-fit-when' }),
    ]);

    expect(view.groups.map(({ classification }) => classification))
      .toEqual(['good-fit-when', 'trade-off', 'avoid-when']);
    expect(view.statementCount).toBe(3);
  });

  it('describes each group as conditional rather than as a verdict', () => {
    const view = build([statement()]);

    expect(view.groups[0].description).toContain('Not a statement that it is preferable to any other model');
  });

  it('marks guidance stale once it passes the shared verification window', () => {
    const fresh = build([statement()]);
    const stale = build([statement({ verifiedAt: '2025-06-01' })]);

    expect(fresh.hasStale).toBe(false);
    expect(fresh.groups[0].statements[0].daysSinceVerified).toBe(17);
    expect(stale.hasStale).toBe(true);
    expect(stale.groups[0].statements[0].isStale).toBe(true);
  });
});

describe('conflicting guidance', () => {
  const pair = [
    statement({ id: 'fit-current', conflictsWithIds: ['fit-legacy'] }),
    statement({
      id: 'fit-legacy',
      classification: 'avoid-when',
      condition: 'you need a family the vendor still lists as current',
      conflictsWithIds: ['fit-current'],
    }),
  ];

  it('links both readings and resolves neither', () => {
    const view = build(pair);

    expect(view.hasConflict).toBe(true);
    expect(view.statementCount).toBe(2);
    expect(view.groups.map(({ classification }) => classification))
      .toEqual(['good-fit-when', 'avoid-when']);
  });

  it('describes the counterpart by classification and condition', () => {
    const view = build(pair);
    const [conflict] = view.groups[0].statements[0].conflictsWith;

    expect(conflict).toEqual({
      id: 'fit-legacy',
      classificationLabel: 'Avoid when',
      condition: 'you need a family the vendor still lists as current',
    });
  });

  it('reports no conflict when nothing contradicts', () => {
    expect(build([statement()]).hasConflict).toBe(false);
  });
});

describe('recorded evidence gaps', () => {
  const gap: ModelFitEvidenceGap = {
    id: 'gap-a',
    releaseId: RELEASE_ID,
    dimension: 'cost-structure',
    reason: 'no-qualifying-source',
    note: 'No pricing is recorded for this release.',
    verifiedAt: '2026-08-01',
  };

  it('reports a gap with its dimension, question, and reason in words', () => {
    const view = build([statement()], [gap]);

    expect(view.gaps).toHaveLength(1);
    expect(view.gaps[0].dimensionLabel).toBe('Cost structure');
    expect(view.gaps[0].reasonLabel).toBe('No qualifying source');
    expect(view.gaps[0].question).toContain('rates');
  });

  it('reports gaps even when a release has no guidance at all', () => {
    const view = build([], [gap]);

    expect(view.state).toBe('no-guidance');
    expect(view.gaps).toHaveLength(1);
  });

  it('ignores gaps recorded against another release', () => {
    const view = build([statement()], [{ ...gap, releaseId: 'release-b' }]);

    expect(view.gaps).toEqual([]);
  });
});
