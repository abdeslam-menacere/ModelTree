import { describe, expect, it } from 'vitest';
import { refreshLog } from './refresh-log';
import { refreshRunSchema } from './refresh-log-schema';
import {
  coverageSummary,
  degradedChannels,
  unchangedCreators,
  unsweptCreators,
} from '../lib/refresh-log';

/**
 * The #903 regression: a creator that was not scouted ("unswept") must never be
 * reported as a creator that was scouted and found unchanged. The two are the
 * same shape of "no change came from here" and were, before this, the same
 * observation — which let a narrowed run report `no-change` about creators it
 * never looked at. These tests pin that the two states are separately
 * representable and are never collapsed, at the schema and at the reading layer.
 */

/** A minimal valid run; each test perturbs exactly one thing. */
function validRun(overrides: Record<string, unknown> = {}) {
  return {
    id: '2026-01-02-abc123',
    title: 'Data refresh 2026-01-02',
    ranOn: '2026-01-02',
    outcome: 'no-change',
    summary: 'Ran every stage and found nothing to change.',
    scope: 'A narrowed pass',
    stages: [{ stage: 'preflight', status: 'ran', note: 'Clean tree.' }],
    found: { scouts: 1, pagesFetched: 3, claimsProposed: 0 },
    evaluated: {
      reviewers: 0,
      verdictsCast: 0,
      acceptedByPanel: 0,
      rejectedByPanel: 0,
      gates: [{
        gate: 'gate-dataset',
        scope: 'working tree',
        exitCode: 0,
        outcome: 'pass',
        required: true,
        detail: 'The dataset is coherent.',
      }],
    },
    posted: { editsApplied: 0 },
    caveats: ['A gate pass is not a claim that the source still says what it said.'],
    references: [{
      kind: 'issue',
      label: 'Issue #903',
      url: 'https://github.com/abdeslam-menacere/ModelTree/issues/903',
    }],
    recordedAt: '2026-01-02',
    ...overrides,
  };
}

/** A no-change run that swept two creators and both were unchanged. */
const sweptFoundNothing = refreshRunSchema.parse(validRun({
  found: {
    scouts: 2,
    pagesFetched: 6,
    claimsProposed: 0,
    bundles: [
      { creator: 'openai', policy: 'pilot', threshold: '2-of-3', claimsFound: 0 },
      { creator: 'meta', policy: 'pilot', threshold: '2-of-3', claimsFound: 0 },
    ],
  },
}));

/** A no-change run that scouted meta and did *not* look at openai at all. */
const narrowedSkippedOpenai = refreshRunSchema.parse(validRun({
  found: {
    scouts: 1,
    pagesFetched: 3,
    claimsProposed: 0,
    bundles: [
      { creator: 'meta', policy: 'pilot', threshold: '2-of-3', claimsFound: 0 },
    ],
    unswept: [
      { creator: 'openai', lastScouted: '2026-09-01', reason: 'Narrowed to meta on gap signal; openai ships no open weights to rank into it.' },
    ],
  },
}));

describe('the #903 unswept vs unchanged distinction', () => {
  it('accepts a run that both scouts-unchanged and leaves a creator unswept', () => {
    expect(refreshRunSchema.safeParse(narrowedSkippedOpenai).success).toBe(true);
  });

  it('refuses to encode a creator as both scouted and unswept', () => {
    const result = refreshRunSchema.safeParse(validRun({
      found: {
        scouts: 1,
        pagesFetched: 3,
        claimsProposed: 0,
        bundles: [{ creator: 'openai', policy: 'pilot', threshold: '2-of-3', claimsFound: 0 }],
        unswept: [{ creator: 'openai', reason: 'Also claimed as not looked at.' }],
      },
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues))
      .toMatch(/reports openai as both scouted and unswept/);
  });

  it('refuses the same creator listed unswept twice', () => {
    const result = refreshRunSchema.safeParse(validRun({
      found: {
        scouts: 0,
        pagesFetched: 0,
        claimsProposed: 0,
        unswept: [
          { creator: 'openai', reason: 'Skipped.' },
          { creator: 'openai', reason: 'Skipped again.' },
        ],
      },
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/lists openai as unswept twice/);
  });

  it('reads "did not look" and "looked and found nothing" from different fields', () => {
    const swept = sweptFoundNothing;
    const narrowed = narrowedSkippedOpenai;

    // openai is unchanged (scouted, zero claims) in one run and unswept in the other.
    expect(unchangedCreators(swept).map((b) => b.creator)).toContain('openai');
    expect(unsweptCreators(swept)).toEqual([]);

    expect(unsweptCreators(narrowed).map((u) => u.creator)).toContain('openai');
    expect(unchangedCreators(narrowed).map((b) => b.creator)).not.toContain('openai');
  });

  it('gives the two no-change runs distinguishable coverage summaries', () => {
    const swept = coverageSummary(sweptFoundNothing);
    const narrowed = coverageSummary(narrowedSkippedOpenai);

    // Both report no change; only one admits it did not look at everyone.
    expect(swept.reportsUnswept).toBe(false);
    expect(swept.unswept).toBe(0);

    expect(narrowed.reportsUnswept).toBe(true);
    expect(narrowed.unswept).toBe(1);

    // The two runs both close no-change, yet their coverage is not the same
    // observation: one looked at everyone, the other admits it skipped a creator.
    expect(swept.reportsUnswept).not.toBe(narrowed.reportsUnswept);
    expect(narrowed.scouted).toBeLessThan(swept.scouted);
  });

  it('reports a degraded discovery channel per creator, not as a bare failure line', () => {
    const run = validRun({
      found: {
        scouts: 1,
        pagesFetched: 3,
        claimsProposed: 0,
        bundles: [{ creator: 'openai', policy: 'pilot', threshold: '2-of-3', claimsFound: 0 }],
        degradedChannels: [
          { creator: 'openai', source: 'official-announcement', detail: 'openai.com/news/ returned 403.' },
        ],
      },
    });

    const parsed = refreshRunSchema.safeParse(run);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const channels = degradedChannels(parsed.data);
      expect(channels).toHaveLength(1);
      expect(channels[0].creator).toBe('openai');
      expect(channels[0].source).toBe('official-announcement');
    }
  });

  it('leaves every committed run with unswept and unchanged as separate, disjoint sets', () => {
    for (const run of refreshLog) {
      const unsweptNames = new Set(unsweptCreators(run).map((u) => u.creator));
      const scoutedNames = new Set(run.found.bundles.map((b) => b.creator));
      for (const name of unsweptNames) {
        expect(scoutedNames.has(name), `${run.id} lists ${name} as both scouted and unswept`).toBe(false);
      }
    }
  });
});
