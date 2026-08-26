import { describe, expect, it } from 'vitest';
import { refreshLog, runById } from './refresh-log';
import {
  gateRunSchema,
  refreshRunSchema,
  validateRefreshLog,
  type RefreshRun,
} from './refresh-log-schema';

const publishedRun = refreshLog.find((run) => run.outcome === 'published');
const stoppedRun = refreshLog.find((run) => run.outcome === 'stopped');

/** A minimal run that passes, so each test below breaks exactly one rule. */
function validRun(overrides: Record<string, unknown> = {}) {
  return {
    id: '2026-01-02-abc123',
    title: 'Data refresh 2026-01-02',
    ranOn: '2026-01-02',
    outcome: 'no-change',
    summary: 'Ran every stage and found nothing to change.',
    scope: 'Every creator',
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
      label: 'Issue #1',
      url: 'https://github.com/abdeslam-menacere/ModelTree/issues/1',
    }],
    recordedAt: '2026-01-02',
    ...overrides,
  };
}

describe('the committed data refresh log', () => {
  it('validates against the contract', () => {
    expect(() => validateRefreshLog(refreshLog)).not.toThrow();
    expect(refreshLog.length).toBeGreaterThan(0);
  });

  it('indexes every run by its id', () => {
    expect(runById.size).toBe(refreshLog.length);
    for (const run of refreshLog) expect(runById.get(run.id)).toBe(run);
  });

  it('records a run that published and a run that published nothing', () => {
    expect(publishedRun, 'a published run').toBeDefined();
    expect(stoppedRun, 'a run that published nothing').toBeDefined();
  });

  it('accounts for every claim it says it found', () => {
    for (const run of refreshLog) {
      const bundled = run.found.bundles.reduce((total, b) => total + b.claimsFound, 0);
      const tallied = run.found.claimsByKind.reduce((total, t) => total + t.count, 0);

      expect(bundled, `${run.id} bundles`).toBe(run.found.claimsProposed);
      expect(tallied, `${run.id} claim kinds`).toBe(run.found.claimsProposed);
    }
  });

  it('never shows a published run beside a required check that did not pass', () => {
    for (const run of refreshLog.filter(({ outcome }) => outcome === 'published')) {
      const blocking = run.evaluated.gates.filter((g) => g.required && g.outcome !== 'pass');
      expect(blocking, `${run.id} blocking gates`).toEqual([]);
    }
  });

  it('gives every run at least one caveat and one place to check it', () => {
    for (const run of refreshLog) {
      expect(run.caveats.length, `${run.id} caveats`).toBeGreaterThan(0);
      expect(run.references.length, `${run.id} references`).toBeGreaterThan(0);
    }
  });

  it('reports what the published run withheld as well as what it posted', () => {
    const run = publishedRun as RefreshRun;

    expect(run.posted.editsApplied).toBeGreaterThan(0);
    expect(run.withheld.length, 'a run that posted something must say what it did not')
      .toBeGreaterThan(0);
  });

  it('keeps the stopped run free of any claim to have changed data', () => {
    const run = stoppedRun as RefreshRun;

    expect(run.posted.editsApplied).toBe(0);
    expect(run.posted.documents).toEqual([]);
    expect(run.posted.records).toEqual([]);
    expect(run.stages.find(({ stage }) => stage === 'scout')?.status).toBe('not-run');
  });
});

describe('the refresh run contract', () => {
  it('accepts a well-formed run', () => {
    expect(refreshRunSchema.safeParse(validRun()).success).toBe(true);
  });

  it('refuses a run id that is not YYYY-MM-DD-<6 hex>', () => {
    const result = refreshRunSchema.safeParse(validRun({ id: '2026-01-02' }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/6 hex/);
  });

  it('refuses edits claimed by a run that did not publish', () => {
    const result = refreshRunSchema.safeParse(validRun({ posted: { editsApplied: 4 } }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/claims 4 edits/);
  });

  it('refuses a published run that applied nothing', () => {
    const result = refreshRunSchema.safeParse(validRun({
      outcome: 'published',
      references: [{
        kind: 'pull-request',
        label: 'PR #1',
        url: 'https://github.com/abdeslam-menacere/ModelTree/pull/1',
      }],
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/a run that changed nothing is/);
  });

  it('refuses a published run with no pull request to check it against', () => {
    const result = refreshRunSchema.safeParse(validRun({
      outcome: 'published',
      posted: { editsApplied: 2, documents: [], records: [] },
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/must include the pull request/);
  });

  it('refuses a published run whose required gate did not pass', () => {
    const result = refreshRunSchema.safeParse(validRun({
      outcome: 'published',
      posted: { editsApplied: 2 },
      references: [{
        kind: 'pull-request',
        label: 'PR #1',
        url: 'https://github.com/abdeslam-menacere/ModelTree/pull/1',
      }],
      evaluated: {
        reviewers: 0,
        verdictsCast: 0,
        acceptedByPanel: 0,
        rejectedByPanel: 0,
        gates: [{
          gate: 'web-ci',
          scope: 'PR #1',
          outcome: 'fail',
          required: true,
          detail: 'Red.',
        }],
      },
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/required gate that did not pass cannot ship/);
  });

  it('refuses bundles that do not account for the claims proposed', () => {
    const result = refreshRunSchema.safeParse(validRun({
      found: {
        scouts: 1,
        pagesFetched: 3,
        claimsProposed: 5,
        bundles: [{ creator: 'openai', policy: 'pilot', threshold: '2-of-3', claimsFound: 2 }],
        claimsByKind: [{ kind: 'add', count: 5, effect: 'New records.' }],
      },
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/account for 2 claims but the run proposed 5/);
  });

  it('refuses more verdicts than there were claims to judge', () => {
    const result = refreshRunSchema.safeParse(validRun({
      evaluated: {
        reviewers: 3,
        verdictsCast: 9,
        acceptedByPanel: 3,
        rejectedByPanel: 0,
        gates: [{
          gate: 'gate-dataset',
          scope: 'working tree',
          exitCode: 0,
          outcome: 'pass',
          required: true,
          detail: 'Coherent.',
        }],
      },
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/records 3 verdicts over 0 proposed claims/);
  });

  it('refuses the same stage reported twice', () => {
    const result = refreshRunSchema.safeParse(validRun({
      stages: [
        { stage: 'scout', status: 'ran', note: 'Fetched.' },
        { stage: 'scout', status: 'not-run', note: 'Also did not fetch.' },
      ],
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/reports the scout stage twice/);
  });

  it('refuses the same withheld item listed twice', () => {
    const result = refreshRunSchema.safeParse(validRun({
      withheld: [
        { id: 'a-claim', category: 'not-covered', detail: 'Out of reach.' },
        { id: 'a-claim', category: 'source-refused', detail: 'Also refused.' },
      ],
    }));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/lists a-claim twice/);
  });

  it('refuses a non-https reference', () => {
    const result = refreshRunSchema.safeParse(validRun({
      references: [{ kind: 'issue', label: 'Issue', url: 'http://example.com/1' }],
    }));

    expect(result.success).toBe(false);
  });

  it('refuses a run with no caveat at all', () => {
    expect(refreshRunSchema.safeParse(validRun({ caveats: [] })).success).toBe(false);
  });
});

describe('a gate run', () => {
  const gate = {
    gate: 'gate-scope',
    scope: 'branch vs anchor',
    outcome: 'pass',
    required: true,
    detail: 'In class.',
  };

  it('accepts a pass on exit 0', () => {
    expect(gateRunSchema.safeParse({ ...gate, exitCode: 0 }).success).toBe(true);
  });

  it('accepts a check that reports no exit code of its own', () => {
    expect(gateRunSchema.safeParse(gate).success).toBe(true);
  });

  it('refuses a pass recorded on exit 2, which means the gate could not run', () => {
    const result = gateRunSchema.safeParse({ ...gate, exitCode: 2 });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/exit 2 means the gate could not run/);
  });

  it('refuses a failure recorded on exit 0', () => {
    const result = gateRunSchema.safeParse({ ...gate, outcome: 'fail', exitCode: 0 });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/contradicts the exit code/);
  });
});

describe('validateRefreshLog', () => {
  it('names the failing path in its message', () => {
    expect(() => validateRefreshLog([validRun({ id: 'nope' })]))
      .toThrow(/Refresh log failed validation:[\s\S]*0\.id/);
  });

  it('refuses an empty log rather than reading it as "no runs yet"', () => {
    expect(() => validateRefreshLog([])).toThrow(/Refresh log failed validation/);
  });

  it('refuses the same run recorded twice', () => {
    expect(() => validateRefreshLog([validRun(), validRun()]))
      .toThrow(/run 2026-01-02-abc123 is recorded twice/);
  });
});
