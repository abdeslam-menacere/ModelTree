import { z } from 'zod';
import { isoDate } from './schema';

/**
 * The contract for the data refresh log.
 *
 * A refresh run's working state lives under `.modeltree-refresh/runs/`, which is
 * git-ignored and deleted with the machine that produced it. The durable record
 * is the pull request body and the summary issue. This document is the reviewed,
 * versioned transcription of that record so the site can show it, and it is
 * deliberately **not** part of `raw.ts`: it holds facts about runs, not facts
 * about models, and `gate-scope.mjs` bounds an auto-merging refresh to the nine
 * documents `raw.ts` composes. Adding this file there would widen the ADR 0003
 * qualifying class, which is an ADR-level decision rather than a data change.
 *
 * The shape enforces the reason the page exists: a run may not report what it
 * posted without also reporting what it did not. `withheld` carries the second
 * half, and the refinements below refuse the combinations that would let a run
 * overstate itself.
 */

const runId = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/, 'must be a run id in YYYY-MM-DD-<6 hex> form');

const nonEmpty = z.string().min(1);
const count = z.number().int().nonnegative();

/** What the run did to the published dataset, decided by outcome and never inferred from counts. */
export const runOutcome = z.enum(['published', 'stopped', 'no-change', 'reverted']);

export const runStage = z.enum(['preflight', 'scout', 'review', 'gates', 'publish', 'deploy']);

/** `not-run` and `not-applicable` are different findings and are never collapsed. */
export const stageStatus = z.enum(['ran', 'not-run', 'not-applicable', 'failed']);

export const reviewPolicy = z.enum(['pilot', 'long-tail']);

export const reviewRubric = z.enum(['provenance', 'consistency', 'editorial']);

export const claimKind = z.enum(['add', 'change', 'remove', 'unchanged', 'conflict']);

/** Exit 2 is "the gate could not run". It is a failure and never a pass. */
export const gateOutcome = z.enum(['pass', 'fail', 'not-run']);

/**
 * Why something a run looked at did not reach the dataset. Each value is a
 * distinct finding rather than a severity, so nothing is smoothed into a single
 * "skipped" bucket.
 */
export const withheldCategory = z.enum([
  'rejected-by-panel',
  'dropped-after-acceptance',
  'verification-held',
  'conflict-recorded',
  'source-refused',
  'blocked-by-policy',
  'not-covered',
]);

export const stageRecordSchema = z.object({
  stage: runStage,
  status: stageStatus,
  note: nonEmpty,
});

export const scoutBundleSchema = z.object({
  creator: nonEmpty,
  policy: reviewPolicy,
  /** The threshold as the run applied it, e.g. `2-of-3`. Recorded, never derived here. */
  threshold: nonEmpty,
  claimsFound: count,
});

export const claimTallySchema = z.object({
  kind: claimKind,
  count,
  effect: nonEmpty,
});

export const dissentSchema = z.object({
  claimId: nonEmpty,
  rubric: reviewRubric,
  objection: nonEmpty,
});

export const gateRunSchema = z.object({
  gate: nonEmpty,
  scope: nonEmpty,
  /** Absent for a check that reports no exit code of its own, such as a CI job. */
  exitCode: z.number().int().min(0).max(2).optional(),
  outcome: gateOutcome,
  /** Whether a failure here is allowed to stop a merge. */
  required: z.boolean(),
  detail: nonEmpty,
}).superRefine((gate, context) => {
  if (gate.outcome === 'pass' && gate.exitCode !== undefined && gate.exitCode !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['outcome'],
      message: `reports a pass on exit ${gate.exitCode}; only exit 0 is a pass, and exit 2 means the gate could not run`,
    });
  }
  if (gate.outcome !== 'pass' && gate.exitCode === 0) {
    context.addIssue({
      code: 'custom',
      path: ['outcome'],
      message: 'reports a non-pass on exit 0, which contradicts the exit code',
    });
  }
});

export const postedDocumentSchema = z.object({
  document: nonEmpty,
  recordsBefore: count,
  recordsAfter: count,
  note: nonEmpty,
});

export const postedRecordSchema = z.object({
  id: nonEmpty,
  collection: nonEmpty,
  note: nonEmpty,
});

export const withheldItemSchema = z.object({
  id: nonEmpty,
  category: withheldCategory,
  detail: nonEmpty,
  /** The records, tests, or policies that held it back. Empty when nothing named one. */
  blockedBy: z.array(nonEmpty).default([]),
});

export const runReferenceSchema = z.object({
  kind: z.enum(['pull-request', 'issue', 'commit', 'deployment']),
  label: nonEmpty,
  url: z.url().refine((value) => value.startsWith('https://'), 'must be https'),
  state: nonEmpty.optional(),
});

export const foundSchema = z.object({
  scouts: count,
  pagesFetched: count,
  claimsProposed: count,
  bundles: z.array(scoutBundleSchema).default([]),
  claimsByKind: z.array(claimTallySchema).default([]),
  /** What the run did not reach. Published rather than hidden. */
  notCovered: z.array(nonEmpty).default([]),
});

export const evaluatedSchema = z.object({
  reviewers: count,
  verdictsCast: count,
  acceptedByPanel: count,
  rejectedByPanel: count,
  /** A claim that met its threshold over a recorded objection. Applied, not overruled. */
  dissents: z.array(dissentSchema).default([]),
  gates: z.array(gateRunSchema).min(1),
});

export const postedSchema = z.object({
  editsApplied: count,
  documents: z.array(postedDocumentSchema).default([]),
  records: z.array(postedRecordSchema).default([]),
});

export const refreshRunSchema = z.object({
  id: runId,
  title: nonEmpty,
  ranOn: isoDate,
  outcome: runOutcome,
  summary: nonEmpty,
  scope: nonEmpty,
  stages: z.array(stageRecordSchema).min(1),
  found: foundSchema,
  evaluated: evaluatedSchema,
  posted: postedSchema,
  withheld: z.array(withheldItemSchema).default([]),
  /** What a green run still does not prove. Never empty: there is always something. */
  caveats: z.array(nonEmpty).min(1),
  /**
   * A run's loose ends, written on the day and never revisited. An issue number
   * may appear in one only where it *identifies* something the run itself
   * produced or was blocked by, which is a fact the run fixes and time cannot
   * unfix. It may not stand as a claim about what another issue covers: that
   * asserts the contents of a document which keeps changing once the run is
   * over, nothing re-reads this file to notice when it stops being true, and
   * the entry is rendered to visitors either way. Decided on #342, where one
   * such citation had gone false. A pointer that needs to stay current belongs
   * in `references`, which carries a `state` a reader can check.
   */
  followUps: z.array(nonEmpty).default([]),
  /** Where a reader checks this entry against the record it transcribes. */
  references: z.array(runReferenceSchema).min(1),
  /** The day this entry was written into the repository. */
  recordedAt: isoDate,
}).superRefine((run, context) => {
  const stages = run.stages.map(({ stage }) => stage);
  const duplicateStage = stages.find((stage, index) => stages.indexOf(stage) !== index);
  if (duplicateStage) {
    context.addIssue({
      code: 'custom',
      path: ['stages'],
      message: `reports the ${duplicateStage} stage twice`,
    });
  }

  const bundled = run.found.bundles.reduce((total, bundle) => total + bundle.claimsFound, 0);
  if (bundled !== run.found.claimsProposed) {
    context.addIssue({
      code: 'custom',
      path: ['found', 'bundles'],
      message: `account for ${bundled} claims but the run proposed ${run.found.claimsProposed}`,
    });
  }

  const tallied = run.found.claimsByKind.reduce((total, tally) => total + tally.count, 0);
  if (tallied !== run.found.claimsProposed) {
    context.addIssue({
      code: 'custom',
      path: ['found', 'claimsByKind'],
      message: `account for ${tallied} claims but the run proposed ${run.found.claimsProposed}`,
    });
  }

  const judged = run.evaluated.acceptedByPanel + run.evaluated.rejectedByPanel;
  if (judged > run.found.claimsProposed) {
    context.addIssue({
      code: 'custom',
      path: ['evaluated'],
      message: `records ${judged} verdicts over ${run.found.claimsProposed} proposed claims`,
    });
  }

  // A dissent is a claim the panel carried over an objection, so it must be one
  // of the claims the panel accepted.
  if (run.evaluated.dissents.length > run.evaluated.acceptedByPanel) {
    context.addIssue({
      code: 'custom',
      path: ['evaluated', 'dissents'],
      message: 'record more dissenting claims than the panel accepted',
    });
  }

  const withheldIds = run.withheld.map(({ id }) => id);
  const duplicateWithheld = withheldIds.find((id, index) => withheldIds.indexOf(id) !== index);
  if (duplicateWithheld) {
    context.addIssue({
      code: 'custom',
      path: ['withheld'],
      message: `lists ${duplicateWithheld} twice`,
    });
  }

  const published = run.outcome === 'published';

  if (!published && run.posted.editsApplied > 0) {
    context.addIssue({
      code: 'custom',
      path: ['posted', 'editsApplied'],
      message: `claims ${run.posted.editsApplied} edits for a run whose outcome is "${run.outcome}"`,
    });
  }
  if (!published && run.posted.documents.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['posted', 'documents'],
      message: `names changed documents for a run whose outcome is "${run.outcome}"`,
    });
  }
  if (published && run.posted.editsApplied === 0) {
    context.addIssue({
      code: 'custom',
      path: ['posted', 'editsApplied'],
      message: 'is zero for a run recorded as published; a run that changed nothing is "no-change"',
    });
  }
  if (published && !run.references.some(({ kind }) => kind === 'pull-request')) {
    context.addIssue({
      code: 'custom',
      path: ['references'],
      message: 'must include the pull request a published run merged',
    });
  }

  // The one gate rule worth restating in the log: a required check that failed
  // or never ran cannot sit beside a published outcome.
  if (published) {
    const blocking = run.evaluated.gates.find(
      (gate) => gate.required && gate.outcome !== 'pass',
    );
    if (blocking) {
      context.addIssue({
        code: 'custom',
        path: ['evaluated', 'gates'],
        message: `record ${blocking.gate} as "${blocking.outcome}" while the run is published; a required gate that did not pass cannot ship`,
      });
    }
  }
});

export const refreshLogSchema = z.array(refreshRunSchema).min(1).superRefine((runs, context) => {
  const ids = runs.map(({ id }) => id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) {
    context.addIssue({ code: 'custom', message: `run ${duplicate} is recorded twice` });
  }
});

export type RunOutcome = z.infer<typeof runOutcome>;
export type RunStage = z.infer<typeof runStage>;
export type StageStatus = z.infer<typeof stageStatus>;
export type ReviewPolicy = z.infer<typeof reviewPolicy>;
export type ReviewRubric = z.infer<typeof reviewRubric>;
export type ClaimKind = z.infer<typeof claimKind>;
export type GateOutcome = z.infer<typeof gateOutcome>;
export type WithheldCategory = z.infer<typeof withheldCategory>;
export type StageRecord = z.infer<typeof stageRecordSchema>;
export type ScoutBundle = z.infer<typeof scoutBundleSchema>;
export type ClaimTally = z.infer<typeof claimTallySchema>;
export type Dissent = z.infer<typeof dissentSchema>;
export type GateRun = z.infer<typeof gateRunSchema>;
export type PostedDocument = z.infer<typeof postedDocumentSchema>;
export type PostedRecord = z.infer<typeof postedRecordSchema>;
export type WithheldItem = z.infer<typeof withheldItemSchema>;
export type RunReference = z.infer<typeof runReferenceSchema>;
export type RefreshRun = z.infer<typeof refreshRunSchema>;
export type RefreshLog = z.infer<typeof refreshLogSchema>;

export function validateRefreshLog(input: unknown): RefreshLog {
  const result = refreshLogSchema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Refresh log failed validation:\n${issues}`);
}
