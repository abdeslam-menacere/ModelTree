import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildDataHealthReport, collectIntegrityViolations } from './data-health';

/**
 * The hard-integrity gate for issue #28, run against the REAL dataset so it rides
 * the required `web-ci` check on every pull request.
 *
 * The contract this test defends is the one the issue draws explicitly: *fail CI
 * only for hard integrity rules, not ordinary age*. So there are two assertions,
 * and they must not be collapsed:
 *
 *   1. The shipped dataset has zero hard-integrity violations. The only such rule
 *      is a `verifiedAt` in the future — a self-contradiction, not staleness.
 *   2. Ordinary age is NEVER a failure. Even a dataset built entirely of
 *      ancient-but-well-formed records reports staleness and yields zero
 *      integrity violations. This is what stops a scheduled build reddening for
 *      reasons no commit caused.
 *
 * The reference date is real `today`, matching the model-passport build-date
 * model: real data only ages further into the past, so this can newly-pass over
 * time and never newly-fail. Assertions read parsed values, never console text,
 * so they behave identically with or without a TTY (CI colourises; a spawned
 * child does not).
 */
describe('data-health hard integrity gate (real dataset)', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('the shipped dataset has no verifiedAt in the future', () => {
    const violations = collectIntegrityViolations(dataset, today);
    expect(violations).toEqual([]);
  });

  it('ordinary age never counts as an integrity violation', () => {
    // Move the reference date far into the future: every real record is now long
    // past its threshold. Staleness must be reported; integrity must stay clean.
    const farFuture = '2999-12-31';
    const report = buildDataHealthReport(dataset, farFuture);
    const violations = collectIntegrityViolations(dataset, farFuture);

    expect(report.summary.stale).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
