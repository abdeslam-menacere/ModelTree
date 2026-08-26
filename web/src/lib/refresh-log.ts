import type {
  ClaimKind,
  GateOutcome,
  RefreshLog,
  RefreshRun,
  ReviewRubric,
  RunOutcome,
  RunStage,
  StageStatus,
  WithheldCategory,
  WithheldItem,
} from '../data/refresh-log-schema';

/**
 * Reading helpers for the data refresh log.
 *
 * Everything here is derived from the committed log document. Nothing counts a
 * run as having done more than it recorded: where the log is silent the answer
 * is zero or an empty group, never an inferred one.
 */

/** Newest first, with the run id breaking a tie so two runs on one day stay ordered. */
export function runsNewestFirst(log: RefreshLog): RefreshRun[] {
  return [...log].sort((a, b) => {
    if (a.ranOn !== b.ranOn) return a.ranOn < b.ranOn ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

export function outcomeLabel(outcome: RunOutcome) {
  return {
    published: 'Published',
    stopped: 'Stopped, published nothing',
    'no-change': 'Ran, changed nothing',
    reverted: 'Published, then reverted',
  }[outcome];
}

export function stageLabel(stage: RunStage) {
  return {
    preflight: 'Preflight',
    scout: 'Scout',
    review: 'Review',
    gates: 'Gates',
    publish: 'Publish',
    deploy: 'Deploy',
  }[stage];
}

/** "Not run" and "not applicable" are distinct findings and are never merged. */
export function stageStatusLabel(status: StageStatus) {
  return {
    ran: 'Ran',
    'not-run': 'Not run',
    'not-applicable': 'Not applicable',
    failed: 'Failed',
  }[status];
}

export function claimKindLabel(kind: ClaimKind) {
  return {
    add: 'Add',
    change: 'Change',
    remove: 'Remove',
    unchanged: 'Unchanged',
    conflict: 'Conflict',
  }[kind];
}

export function rubricLabel(rubric: ReviewRubric) {
  return {
    provenance: 'Provenance',
    consistency: 'Cross-source consistency',
    editorial: 'Editorial and entity boundaries',
  }[rubric];
}

export function gateOutcomeLabel(outcome: GateOutcome) {
  return { pass: 'Pass', fail: 'Fail', 'not-run': 'Could not run' }[outcome];
}

/** "1 edit", not "1 edits". The count is always shown, including zero. */
export function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${new Intl.NumberFormat('en').format(value)} ${value === 1 ? singular : plural}`;
}

export function withheldCategoryLabel(category: WithheldCategory) {
  return {
    'rejected-by-panel': 'Rejected by the review panel',
    'dropped-after-acceptance': 'Accepted by the panel, then dropped',
    'verification-held': 'Verification date deliberately held back',
    'conflict-recorded': 'Sources conflict, so no value changed',
    'source-refused': 'Source refused by the approval gate',
    'blocked-by-policy': 'Blocked by policy before it could run',
    'not-covered': 'Out of the run’s reach',
  }[category];
}

/**
 * The display order for withheld groups: panel decisions first, then decisions
 * taken after acceptance, then things nobody decided at all.
 */
const WITHHELD_ORDER: WithheldCategory[] = [
  'rejected-by-panel',
  'dropped-after-acceptance',
  'verification-held',
  'conflict-recorded',
  'source-refused',
  'blocked-by-policy',
  'not-covered',
];

export interface WithheldGroup {
  category: WithheldCategory;
  label: string;
  items: WithheldItem[];
}

/** Only categories the run actually used appear, so no group is an empty promise. */
export function withheldGroups(run: RefreshRun): WithheldGroup[] {
  return WITHHELD_ORDER
    .map((category) => ({
      category,
      label: withheldCategoryLabel(category),
      items: run.withheld.filter((item) => item.category === category),
    }))
    .filter(({ items }) => items.length > 0);
}

export interface GateTally {
  total: number;
  passed: number;
  failed: number;
  notRun: number;
  /** Required gates that did not pass. A published run can never have one. */
  blocking: number;
}

export function gateTally(run: RefreshRun): GateTally {
  const gates = run.evaluated.gates;
  return {
    total: gates.length,
    passed: gates.filter(({ outcome }) => outcome === 'pass').length,
    failed: gates.filter(({ outcome }) => outcome === 'fail').length,
    notRun: gates.filter(({ outcome }) => outcome === 'not-run').length,
    blocking: gates.filter((gate) => gate.required && gate.outcome !== 'pass').length,
  };
}

export interface PostedTally {
  edits: number;
  documentsTouched: number;
  /** The net record movement the log itself states, not a guess from the edit count. */
  netRecordChange: number;
  recordsNamed: number;
}

export function postedTally(run: RefreshRun): PostedTally {
  return {
    edits: run.posted.editsApplied,
    documentsTouched: run.posted.documents.length,
    netRecordChange: run.posted.documents.reduce(
      (total, document) => total + (document.recordsAfter - document.recordsBefore),
      0,
    ),
    recordsNamed: run.posted.records.length,
  };
}

export interface RunLedger {
  posted: number;
  withheld: number;
  /** True when a run reports at least one thing it did not post. */
  reportsWithheld: boolean;
}
/** The headline the log page exists to show: what landed against what did not. */
export function runLedger(run: RefreshRun): RunLedger {
  return {
    posted: run.posted.editsApplied,
    withheld: run.withheld.length,
    reportsWithheld: run.withheld.length > 0,
  };
}

export interface LogTotals {
  runs: number;
  published: number;
  pagesFetched: number;
  claimsProposed: number;
  editsApplied: number;
  withheld: number;
  latestRun: string;
}

export function logTotals(log: RefreshLog): LogTotals {
  const ordered = runsNewestFirst(log);
  const latest = ordered[0];
  if (!latest) throw new Error('The data refresh log needs at least one run');

  return {
    runs: log.length,
    published: log.filter(({ outcome }) => outcome === 'published').length,
    pagesFetched: log.reduce((total, run) => total + run.found.pagesFetched, 0),
    claimsProposed: log.reduce((total, run) => total + run.found.claimsProposed, 0),
    editsApplied: log.reduce((total, run) => total + run.posted.editsApplied, 0),
    withheld: log.reduce((total, run) => total + run.withheld.length, 0),
    latestRun: latest.ranOn,
  };
}
