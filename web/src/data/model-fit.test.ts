import { describe, expect, it } from 'vitest';
import { rawDataset } from './raw';
import { findUniversalClaim } from './model-fit-rubric';
import { validateDataset } from './validate';
import type { ModelFitEvidenceGap, ModelFitStatement } from './schema';

const RELEASE_ID = 'meta-llama-4-scout';
const FAMILY_ID = 'meta-llama-4';
const OTHER_RELEASE_ID = 'openai-gpt-4-1-2025-04-14';
const SEED_SOURCE_ID = 'meta-llama-4-scout-model-card';

/** A statement over facts the seed already records, so only the rule under test varies. */
function statement(overrides: Partial<ModelFitStatement> = {}): ModelFitStatement {
  return {
    id: 'test-fit-statement',
    releaseId: RELEASE_ID,
    classification: 'good-fit-when',
    condition: 'you have to run the model on hardware you operate',
    statement: 'The weights are published for download under a stated licence.',
    rubricDimensions: ['access-and-licensing'],
    facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' }],
    sourceIds: ['meta-llama-4-scout-model-card'],
    scope: 'Covers availability only.',
    caveats: ['Availability is not a statement about behaviour.'],
    conflictsWithIds: [],
    verifiedAt: '2026-08-15',
    ...overrides,
  };
}

function gap(overrides: Partial<ModelFitEvidenceGap> = {}): ModelFitEvidenceGap {
  return {
    id: 'test-fit-gap',
    releaseId: RELEASE_ID,
    dimension: 'cost-structure',
    reason: 'no-qualifying-source',
    note: 'No pricing record is held for this release, so no cost guidance is derived.',
    verifiedAt: '2026-08-15',
    ...overrides,
  };
}

/** The seed dataset with the guidance records under test swapped in. */
function datasetWith(
  modelFitStatements: ModelFitStatement[],
  modelFitEvidenceGaps: ModelFitEvidenceGap[] = [],
): Record<string, unknown> {
  const input = structuredClone(rawDataset) as Record<string, any>;
  input.modelFitStatements = modelFitStatements;
  input.modelFitEvidenceGaps = modelFitEvidenceGaps;
  return input;
}

/**
 * The seed carries no lifecycle event, benchmark, or pricing record, so the
 * rubric's mapping for those fact kinds would otherwise go untested in the
 * accept direction. These are synthetic records attached to a real release and
 * citing a source it already cites; they exist only to exercise the support
 * table and are not seeded into the repository.
 */
function datasetWithSupportingRecords(
  modelFitStatements: ModelFitStatement[],
): Record<string, unknown> {
  const input = datasetWith(modelFitStatements) as Record<string, any>;

  input.releaseEvents = [{
    id: 'test-release-event',
    releaseId: RELEASE_ID,
    type: 'generally-available',
    date: '2025-04-05',
    datePrecision: 'day',
    note: 'Published for download on the day of the announcement.',
    sourceIds: [SEED_SOURCE_ID],
    verifiedAt: '2026-08-15',
  }];

  input.benchmarks = [{
    id: 'test-benchmark',
    slug: 'test-benchmark',
    name: 'Test Benchmark',
    domain: 'general-reasoning',
    owner: 'Test Benchmark Owner',
    metric: 'accuracy',
    metricUnit: '%',
    direction: 'higher-is-better',
    sourceIds: [SEED_SOURCE_ID],
    verifiedAt: '2026-08-15',
  }];

  input.benchmarkResults = [{
    id: 'test-benchmark-result',
    benchmarkId: 'test-benchmark',
    benchmarkVersion: '2026-01',
    releaseId: RELEASE_ID,
    score: 70,
    unit: '%',
    evaluationDate: '2026-06',
    resultType: 'official',
    sourceIds: [SEED_SOURCE_ID],
    verifiedAt: '2026-08-15',
  }];

  input.servingPlatforms = [{
    id: 'test-platform',
    slug: 'test-platform',
    name: 'Test Platform',
    organizationId: 'meta',
    type: 'model-hub',
    website: 'https://platform.test/',
    sourceIds: [SEED_SOURCE_ID],
    verifiedAt: '2026-08-15',
  }];

  input.deployments = [{
    id: 'test-deployment',
    releaseId: RELEASE_ID,
    platformId: 'test-platform',
    deliveryMode: 'hosted-api',
    regions: [],
    effectiveFrom: '2025-04-05',
    sourceIds: [SEED_SOURCE_ID],
    verifiedAt: '2026-08-15',
  }];

  input.pricing = [{
    id: 'test-pricing',
    deploymentId: 'test-deployment',
    currency: 'USD',
    unit: 'per-1m-tokens',
    rates: { input: 0.5, output: 2 },
    effectiveFrom: '2025-04-05',
    sourceIds: [SEED_SOURCE_ID],
    verifiedAt: '2026-08-15',
  }];

  return input;
}

describe('seeded conditional-fit guidance', () => {
  const parsed = validateDataset(structuredClone(rawDataset));

  it('validates every statement shipped in the seed', () => {
    expect(parsed.modelFitStatements.length).toBeGreaterThan(0);
    expect(parsed.modelFitEvidenceGaps.length).toBeGreaterThan(0);
  });

  it('files every seeded statement under exactly one classification', () => {
    for (const record of parsed.modelFitStatements) {
      expect(['good-fit-when', 'trade-off', 'avoid-when']).toContain(record.classification);
    }
  });

  it('gives every seeded statement a condition, facts, sources, and caveats', () => {
    for (const record of parsed.modelFitStatements) {
      expect(record.condition.length).toBeGreaterThan(0);
      expect(record.facts.length).toBeGreaterThan(0);
      expect(record.sourceIds.length).toBeGreaterThan(0);
      expect(record.caveats.length).toBeGreaterThan(0);
      expect(record.rubricDimensions.length).toBeGreaterThan(0);
    }
  });

  it('records the seeded lifecycle disagreement as a reciprocal conflict', () => {
    const pair = parsed.modelFitStatements.filter(
      (record) => record.releaseId === 'anthropic-claude-haiku-4-5',
    );

    expect(pair).toHaveLength(2);
    for (const record of pair) {
      const counterpart = pair.find((other) => other.id !== record.id);
      expect(record.conflictsWithIds).toEqual([counterpart?.id]);
    }
  });
});

describe('claim-level provenance', () => {
  it('accepts a statement traced to a recorded fact', () => {
    const parsed = validateDataset(datasetWith([statement()]));

    expect(parsed.modelFitStatements).toHaveLength(1);
  });

  it('rejects a statement with no fact behind it', () => {
    expect(() => validateDataset(datasetWith([statement({ facts: [] })])))
      .toThrow(/facts/);
  });

  it('rejects a statement with no source', () => {
    expect(() => validateDataset(datasetWith([statement({ sourceIds: [] })])))
      .toThrow(/sourceIds/);
  });

  it('rejects a statement with no caveat', () => {
    expect(() => validateDataset(datasetWith([statement({ caveats: [] })])))
      .toThrow(/caveats/);
  });

  it('rejects a statement about a missing release', () => {
    expect(() => validateDataset(datasetWith([statement({ releaseId: 'no-such-release' })])))
      .toThrow(/releaseId references missing id "no-such-release"/);
  });

  it('rejects a fact the release does not record', () => {
    expect(() => validateDataset(datasetWith([statement({
      rubricDimensions: ['documented-limits'],
      facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'maximumOutput' }],
    })]))).toThrow(/which the release does not record/);
  });

  it('rejects a fact that describes a different release', () => {
    expect(() => validateDataset(datasetWith([statement({
      facts: [{ kind: 'release-field', releaseId: OTHER_RELEASE_ID, field: 'accessType' }],
    })]))).toThrow(/describes release openai-gpt-4-1-2025-04-14, not meta-llama-4-scout/);
  });

  it('rejects a family fact from another family', () => {
    expect(() => validateDataset(datasetWith([statement({
      rubricDimensions: ['lifecycle-stability'],
      facts: [{ kind: 'family-field', familyId: 'openai-gpt-5', field: 'status' }],
      sourceIds: ['openai-gpt-5-docs'],
    })]))).toThrow(/which is not the family of meta-llama-4-scout/);
  });

  it('rejects a source that none of the cited facts carries', () => {
    expect(() => validateDataset(datasetWith([statement({
      sourceIds: ['openai-gpt-4-1-announcement'],
    })]))).toThrow(/cites source "openai-gpt-4-1-announcement", which none of the facts it rests on cites/);
  });

  it('rejects a source that does not exist', () => {
    expect(() => validateDataset(datasetWith([statement({ sourceIds: ['no-such-source'] })])))
      .toThrow(/references missing id "no-such-source"/);
  });

  it('rejects guidance dated before the evidence beneath it', () => {
    expect(() => validateDataset(datasetWith([statement({ verifiedAt: '2025-01-01' })])))
      .toThrow(/was verified before release field accessType/);
  });
});

describe('rubric application', () => {
  it('accepts a dimension answered by an allowed fact kind', () => {
    const parsed = validateDataset(datasetWith([statement({
      rubricDimensions: ['context-window'],
      facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'contextWindow' }],
    })]));

    expect(parsed.modelFitStatements[0].rubricDimensions).toEqual(['context-window']);
  });

  it('rejects a dimension no cited fact can answer', () => {
    expect(() => validateDataset(datasetWith([statement({
      rubricDimensions: ['access-and-licensing', 'cost-structure'],
    })]))).toThrow(/discloses rubric dimension "cost-structure" without citing a fact that answers it/);
  });

  it('rejects a fact of the wrong field for the dimension', () => {
    expect(() => validateDataset(datasetWith([statement({
      rubricDimensions: ['context-window'],
      facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' }],
    })]))).toThrow(/discloses rubric dimension "context-window" without citing a fact that answers it/);
  });

  it('accepts a family lifecycle fact for the lifecycle dimension', () => {
    const parsed = validateDataset(datasetWith([statement({
      rubricDimensions: ['lifecycle-stability'],
      facts: [{ kind: 'family-field', familyId: FAMILY_ID, field: 'status' }],
      sourceIds: ['meta-llama-4-announcement'],
    })]));

    expect(parsed.modelFitStatements[0].facts[0].kind).toBe('family-field');
  });

  it('rejects a measured-evidence dimension with no measurement behind it', () => {
    expect(() => validateDataset(datasetWith([statement({
      rubricDimensions: ['measured-benchmark-evidence'],
    })]))).toThrow(/discloses rubric dimension "measured-benchmark-evidence" without citing a fact that answers it/);
  });

  it('rejects a benchmark fact that does not exist', () => {
    expect(() => validateDataset(datasetWith([statement({
      rubricDimensions: ['measured-benchmark-evidence'],
      facts: [{ kind: 'benchmark-result', benchmarkResultId: 'no-such-result' }],
    })]))).toThrow(/cites benchmark result no-such-result, which does not exist/);
  });

  // The seed uses only release and family fields, so these three mappings are
  // exercised against synthetic records to keep the support table itself honest.
  it('accepts a benchmark result for the measured-evidence dimension', () => {
    const parsed = validateDataset(datasetWithSupportingRecords([statement({
      rubricDimensions: ['measured-benchmark-evidence'],
      facts: [{ kind: 'benchmark-result', benchmarkResultId: 'test-benchmark-result' }],
    })]));

    expect(parsed.modelFitStatements[0].facts[0].kind).toBe('benchmark-result');
  });

  it('accepts a pricing record for the cost-structure dimension', () => {
    const parsed = validateDataset(datasetWithSupportingRecords([statement({
      rubricDimensions: ['cost-structure'],
      facts: [{ kind: 'pricing-record', pricingRecordId: 'test-pricing' }],
    })]));

    expect(parsed.modelFitStatements[0].facts[0].kind).toBe('pricing-record');
  });

  it('accepts a lifecycle event for the lifecycle-stability dimension', () => {
    const parsed = validateDataset(datasetWithSupportingRecords([statement({
      rubricDimensions: ['lifecycle-stability'],
      facts: [{ kind: 'release-event', eventId: 'test-release-event' }],
    })]));

    expect(parsed.modelFitStatements[0].facts[0].kind).toBe('release-event');
  });

  it('refuses a pricing record as an answer to a dimension it cannot answer', () => {
    expect(() => validateDataset(datasetWithSupportingRecords([statement({
      rubricDimensions: ['context-window'],
      facts: [{ kind: 'pricing-record', pricingRecordId: 'test-pricing' }],
    })]))).toThrow(/discloses rubric dimension "context-window" without citing a fact that answers it/);
  });

  it('refuses a release field as an answer to the cost-structure dimension', () => {
    expect(() => validateDataset(datasetWithSupportingRecords([statement({
      rubricDimensions: ['cost-structure'],
      facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'accessType' }],
    })]))).toThrow(/discloses rubric dimension "cost-structure" without citing a fact that answers it/);
  });

  it('refuses a benchmark result as an answer to the usage-evidence dimension', () => {
    expect(() => validateDataset(datasetWithSupportingRecords([statement({
      rubricDimensions: ['usage-evidence'],
      facts: [{ kind: 'benchmark-result', benchmarkResultId: 'test-benchmark-result' }],
    })]))).toThrow(/discloses rubric dimension "usage-evidence" without citing a fact that answers it/);
  });

  it('still holds a synthetic fact to the release it describes', () => {
    const input = datasetWithSupportingRecords([statement({
      rubricDimensions: ['cost-structure'],
      facts: [{ kind: 'pricing-record', pricingRecordId: 'test-pricing' }],
    })]) as Record<string, any>;
    input.deployments[0].releaseId = OTHER_RELEASE_ID;

    expect(() => validateDataset(input))
      .toThrow(/describes release openai-gpt-4-1-2025-04-14, not meta-llama-4-scout/);
  });
});

describe('universal-winner language', () => {
  const rejected = [
    'the best model for the job',
    'a state-of-the-art option',
    'the most capable model available',
    'it outperforms all other models',
    'the number one choice',
    'an industry-leading model',
    'suitable for all use cases',
    'always the right choice',
    'it tops the leaderboard',
    'its composite score leads the field',
    'the go-to model for teams',
    'universally applicable work',
  ];

  it.each(rejected)('refuses "%s" in a statement', (text) => {
    expect(() => validateDataset(datasetWith([statement({ statement: text })])))
      .toThrow(/unsupported universal-winner language/);
  });

  it('refuses winner language in the condition', () => {
    expect(() => validateDataset(datasetWith([statement({ condition: 'you want the best available model' })])))
      .toThrow(/unsupported universal-winner language/);
  });

  it('refuses winner language in the scope', () => {
    expect(() => validateDataset(datasetWith([statement({ scope: 'Covers why it beats every rival.' })])))
      .toThrow(/unsupported universal-winner language/);
  });

  it('refuses winner language in a caveat', () => {
    expect(() => validateDataset(datasetWith([statement({
      caveats: ['Still the smartest option on the market.'],
    })]))).toThrow(/unsupported universal-winner language/);
  });

  it('refuses winner language in an evidence gap note', () => {
    expect(() => validateDataset(datasetWith([], [gap({
      note: 'No pricing is recorded, though it is the cheapest option regardless.',
    })]))).toThrow(/unsupported universal-winner language/);
  });

  it('names the phrase that failed so an author can fix it', () => {
    expect(() => validateDataset(datasetWith([statement({ statement: 'A leaderboard favourite.' })])))
      .toThrow(/"leaderboard"/);
  });

  it('leaves conditional wording alone', () => {
    const parsed = validateDataset(datasetWith([statement({
      statement: 'Weights are downloadable, which suits deployments that cannot leave a private network.',
      condition: 'your data cannot leave infrastructure you control',
    })]));

    expect(parsed.modelFitStatements).toHaveLength(1);
  });

  // Wording that brushes a pattern without making a winner claim. These are the
  // cases a blunter filter would break, so they are pinned.
  const nearMisses = [
    'No benchmark score is recorded for this release.',
    'Most of the documented limits are stated in prose rather than in a table.',
    'The vendor is leading with a newer model on its own documentation pages.',
    'Suitable for any deployment that must stay inside a private network.',
    'The licence is always worth reading in full before adopting the model.',
    'This is not a top-of-the-range configuration of the family.',
    'The documentation is thinner here than for other releases in the family.',
  ];

  it.each(nearMisses)('allows the near-miss phrasing "%s"', (text) => {
    expect(findUniversalClaim(text)).toBeUndefined();
    expect(() => validateDataset(datasetWith([statement({ caveats: [text] })]))).not.toThrow();
  });

  // The two directions the filter gets wrong, asserted so the limitation lives
  // in the suite rather than only in the prose that describes it.
  it('does not catch a comparative claim worded around the pattern list', () => {
    const missed = 'No model handles long context better than this one.';

    expect(findUniversalClaim(missed)).toBeUndefined();
    // It passes provenance too, and that is the point: it cites the same source
    // the contextWindow fact carries, so the subset rule has nothing to object
    // to. No mechanical check here rejects this sentence. The subset rule
    // governs where a citation may come from, never whether the sentence
    // follows from it, so an author writing carelessly is caught by review and
    // by the facts rendered beside the statement — not by validation.
    expect(() => validateDataset(datasetWith([statement({ statement: missed })]))).not.toThrow();
  });

  it('rejects an honest caveat that happens to contain a listed word', () => {
    // A false positive: the caveat makes no winner claim, but "best" is on the
    // list. Accepted deliberately — an author can reword, whereas a false
    // negative ships. The rewritten form is in the near-miss list above.
    expect(() => validateDataset(datasetWith([statement({
      caveats: ['This is not the best-documented release in its family.'],
    })]))).toThrow(/unsupported universal-winner language/);
  });

  it('detects the phrase directly, without needing a whole dataset', () => {
    expect(findUniversalClaim('the best option')).toEqual({ name: 'superlative ranking', phrase: 'best' });
    expect(findUniversalClaim('a good fit for batch jobs')).toBeUndefined();
  });
});

describe('conflicting guidance', () => {
  const conflictPair = [
    statement({
      id: 'test-fit-a',
      rubricDimensions: ['lifecycle-stability'],
      facts: [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'status' }],
      conflictsWithIds: ['test-fit-b'],
    }),
    statement({
      id: 'test-fit-b',
      classification: 'trade-off',
      rubricDimensions: ['lifecycle-stability'],
      facts: [{ kind: 'family-field', familyId: FAMILY_ID, field: 'status' }],
      sourceIds: ['meta-llama-4-announcement'],
      conflictsWithIds: ['test-fit-a'],
    }),
  ];

  it('keeps a reciprocal conflict over a shared dimension', () => {
    const parsed = validateDataset(datasetWith(conflictPair));

    expect(parsed.modelFitStatements.map(({ id }) => id)).toEqual(['test-fit-a', 'test-fit-b']);
  });

  it('rejects a one-sided conflict', () => {
    const [first, second] = structuredClone(conflictPair);
    second.conflictsWithIds = [];

    expect(() => validateDataset(datasetWith([first, second])))
      .toThrow(/conflict with test-fit-b is not reciprocal/);
  });

  it('rejects a conflict between statements that share no dimension', () => {
    const [first, second] = structuredClone(conflictPair);
    second.rubricDimensions = ['access-and-licensing'];
    second.facts = [{ kind: 'release-field', releaseId: RELEASE_ID, field: 'license' }];
    second.sourceIds = ['meta-llama-4-license'];

    expect(() => validateDataset(datasetWith([first, second])))
      .toThrow(/shares no rubric dimension with it/);
  });

  it('rejects a conflict with a statement about another release', () => {
    const [first, second] = structuredClone(conflictPair);
    second.releaseId = OTHER_RELEASE_ID;
    second.facts = [{ kind: 'release-field', releaseId: OTHER_RELEASE_ID, field: 'status' }];
    second.sourceIds = ['openai-gpt-4-1-announcement'];

    expect(() => validateDataset(datasetWith([first, second])))
      .toThrow(/which describes another release/);
  });

  it('rejects a statement that conflicts with itself', () => {
    expect(() => validateDataset(datasetWith([statement({ conflictsWithIds: ['test-fit-statement'] })])))
      .toThrow(/cannot reference itself/);
  });
});

describe('recorded evidence gaps', () => {
  it('accepts a gap for a dimension no statement claims', () => {
    const parsed = validateDataset(datasetWith([statement()], [gap()]));

    expect(parsed.modelFitEvidenceGaps).toHaveLength(1);
  });

  it('rejects a gap that contradicts a published statement', () => {
    expect(() => validateDataset(datasetWith(
      [statement()],
      [gap({ dimension: 'access-and-licensing' })],
    ))).toThrow(/records dimension "access-and-licensing" as unsupported while a statement derives guidance from it/);
  });

  it('rejects a gap about a missing release', () => {
    expect(() => validateDataset(datasetWith([], [gap({ releaseId: 'no-such-release' })])))
      .toThrow(/releaseId references missing id "no-such-release"/);
  });

  it('rejects the same dimension recorded twice for one release', () => {
    expect(() => validateDataset(datasetWith([], [gap(), gap({ id: 'test-fit-gap-two' })])))
      .toThrow(/duplicate model fit evidence gap release and dimension/);
  });

  it('rejects a gap with no stated reason note', () => {
    expect(() => validateDataset(datasetWith([], [gap({ note: '' })])))
      .toThrow(/note/);
  });
});
