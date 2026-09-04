// Drift-allowance accounting for the recorded asset-budget measurements, and
// the provenance of the tree they were measured on -- abdeslam-menacere/ModelTree#832.
//
// -- The defect this exists for --
//
// `asset-budgets.test.ts` compares each `measured*` figure in
// asset-budgets.json against a locally built page weight and fails when they
// differ by more than `measuredDrift.maxFraction` (2%). That guard is right and
// nothing here weakens it. What was missing is that the guard is pass/fail, and
// its two inputs are measured on trees that are not the same tree:
//
//   * LOCALLY, "the build" is the branch alone.
//   * In CI it is the branch MERGED WITH TRUNK. `.github/workflows/web-ci.yml`
//     checks out with no `ref:` override, so a `pull_request` run builds
//     `refs/pull/N/merge`.
//
// Those trees differ whenever trunk has moved since the branch left it. So the
// 2% allowance silently absorbs two unrelated things: accumulated staleness in
// the recorded figure, which is what #813 sized it for, and the branch-vs-trunk
// build delta, which nothing sized it for. When the two together exceed 2%, a
// dock that verified honestly and saw green hands off work that CI turns red.
//
// Measured instance (PR #830, issue #822), branch-only against recorded:
// `/tree` drift 10,340 of an allowance of 10,647 -- 97.1% consumed -- and
// `/compare` 13,671 of 14,999 -- 91.1%. Both PASS. Trunk's #826 then added
// 1,654 and 2,529 bytes to those routes through a shared island and stylesheet,
// and the merge CI built measured 11,994 and 16,200: red, on a commit whose
// local run was green. A pass/fail assertion cannot distinguish 97.1% from 2%,
// so there was no local signal that the branch was one trunk commit from red.
//
// -- What this module does about it --
//
// It reports. Every function here is pure accounting and formatting over
// numbers the caller has already measured; nothing in this file reads a budget,
// raises a ceiling, widens a tolerance or decides a verdict. The assertions in
// `asset-budgets.test.ts` are unchanged and still bind at exactly
// `measuredDrift.maxFraction`.
//
// Two readings are produced:
//
//   1. **Consumption.** How much of each figure's allowance the drift has
//      already spent, on success as well as on failure, so a near miss is
//      visible before handoff rather than after CI.
//   2. **Provenance.** Whether the tree just measured is the tree CI measures,
//      stated from a measurement of how far HEAD sits behind trunk rather than
//      left for the reader to reconstruct.

/**
 * When a drift is reported as a NEAR MISS: it is inside the allowance, so it
 * passes, and it is close enough to the edge that one ordinary trunk commit
 * could carry it over.
 *
 * Derived from the incident above rather than picked round, and derived from
 * the part of it that is trunk's rather than the branch's, because that is the
 * quantity a branch cannot see. Trunk's #826 cost `/tree` 1,654 bytes of a
 * 10,647 allowance (15.5%) and `/compare` 2,529 of 14,999 (16.9%) -- so a
 * figure above ~83% consumption was already within one trunk commit of red.
 * 75% takes that boundary and leaves margin for a trunk commit larger than
 * #826, which was itself a single feature touching one island and one
 * stylesheet.
 *
 * It permits nothing. This threshold cannot make a failing check pass, cannot
 * raise a ceiling and cannot widen `measuredDrift.maxFraction`; crossing it
 * changes no exit code and fails no test. It only decides whether a passing row
 * is printed with a warning next to it. A near miss is not a defect -- it is a
 * fact about how much room is left, which is exactly what this issue found
 * nobody could see.
 */
export const NEAR_MISS_FRACTION = 0.75;

/**
 * Drift accounting for one recorded figure.
 *
 * `tolerance` reproduces the test's own arithmetic exactly -- a floored
 * fraction of the RECORDED value, with no absolute floor -- because a report
 * that computed the allowance differently from the assertion would be
 * describing a different guard. A recorded 0 (the passport static-hydration
 * tripwire) therefore has an allowance of 0 and means exactly 0.
 *
 * `consumed` is the fraction of that allowance spent. Where the allowance is 0
 * it is 0 for an exact match and Infinity for anything else: there is no
 * fraction of nothing, and Infinity sorts to the top of the report, which is
 * where a tripwire that has tripped belongs.
 */
export function driftOf(label, recorded, measured, maxFraction) {
  const tolerance = Math.floor(recorded * maxFraction);
  const drift = Math.abs(measured - recorded);
  const consumed = tolerance === 0 ? (drift === 0 ? 0 : Infinity) : drift / tolerance;
  return {
    label,
    recorded,
    measured,
    drift,
    tolerance,
    consumed,
    within: drift <= tolerance,
    direction: measured === recorded ? 'exact' : measured > recorded ? 'grown' : 'shrunk',
  };
}

/**
 * `over` (outside the allowance -- the assertion fails on this row),
 * `near-miss` (inside it, but at or above `nearMiss` of it) or `ok`.
 *
 * `over` is decided by `within` and never by the consumption fraction, so this
 * classification can never disagree with the assertion that actually binds.
 */
export function classifyDrift(row, nearMiss = NEAR_MISS_FRACTION) {
  if (!row.within) return 'over';
  return row.consumed >= nearMiss ? 'near-miss' : 'ok';
}

const group = (value) => value.toLocaleString('en-US');

/** `97.1%`, or `n/a` where the allowance is 0 and there is nothing to be a fraction of. */
export function formatConsumed(consumed) {
  if (!Number.isFinite(consumed)) return 'OVER';
  return `${(consumed * 100).toFixed(1)}%`;
}

/**
 * The one-line reason a reader needs when a drift assertion fails, including
 * the part today's message does not say: which tree was measured.
 *
 * The existing message correctly says the recorded figure is stale and to
 * re-run `assets:report`. Followed literally on a branch that trunk has moved
 * past, that records a figure describing a tree that never reaches `main` --
 * which is how the mechanism stayed invisible. So the provenance goes in the
 * failure itself.
 */
export function driftFailureMessage(row, maxFraction, provenance) {
  return (
    `${row.label}: asset-budgets.json records ${group(row.recorded)}, the build measures ` +
    `${group(row.measured)} (drift ${group(row.drift)} > allowance ${group(row.tolerance)} at ` +
    `${maxFraction * 100}%). The recorded figure is stale, not the ceiling. Re-run ` +
    '`npm run assets:report` and update the measured value; do NOT change any *MaxRaw ceiling, ' +
    'and do NOT widen measuredDrift.maxFraction, to accommodate this.\n' +
    describeProvenance(provenance).join('\n')
  );
}

/**
 * Read a tree-provenance probe into prose, in every one of its three states.
 *
 * `undetermined` is never rounded to `level`. A probe that could not answer has
 * not established that the branch is level with trunk, and reading it as though
 * it had is what would restore the false green this whole module exists to
 * remove.
 */
export function describeProvenance(provenance) {
  const ciMechanism =
    'CI does not build this tree: `.github/workflows/web-ci.yml` checks out with no `ref:` ' +
    'override, so a `pull_request` run builds `refs/pull/N/merge` -- this branch MERGED with ' +
    'trunk.';

  if (!provenance || provenance.status === 'undetermined') {
    const why = provenance?.reason ? ` (${provenance.reason})` : '';
    return [
      `TREE PROVENANCE: UNDETERMINED${why}.`,
      `  ${ciMechanism}`,
      '  This is NOT read as "level with trunk". If trunk has moved, whatever those commits add',
      '  to a shared component, stylesheet or island is in the tree CI builds and is not in the',
      '  figures above, so merged drift is USUALLY at least the local drift here -- the exception',
      '  is a route trunk has SHRUNK (as #813 cut /tree by 220,029 bytes), where CI measures less.',
    ];
  }

  if (provenance.status === 'behind') {
    return [
      `TREE PROVENANCE: this build measured HEAD ALONE, which is NOT the tree CI measures.`,
      `  HEAD         ${provenance.head}`,
      `  ${provenance.ref}  ${provenance.trunk}`,
      `  behind       ${provenance.behind} commit(s) -- trunk has moved since this branch left it`,
      `  ${ciMechanism}`,
      '  Whatever those commits add to a shared component, stylesheet or island is in CI\'s tree',
      '  and is not in the figures above, so merged drift is USUALLY at least the local drift here.',
      '  The exception is a route trunk has SHRUNK (as #813 cut /tree by 220,029 bytes), where CI',
      '  measures less than this. Re-running `npm run assets:report` on this tree records a figure',
      '  describing a tree that never reaches `main`. See docs/product/PERFORMANCE-BUDGETS.md,',
      '  "Recording a measured figure when trunk has moved".',
    ];
  }

  return [
    `TREE PROVENANCE: HEAD is level with ${provenance.ref} (${provenance.trunk}), so the tree`,
    '  measured here is the tree CI builds and these drift figures are CI\'s figures.',
    '  That ref is a local cache and only moves when something fetches: `git fetch origin main`',
    '  refreshes it, and until it does, "level" means level with the last trunk this checkout saw.',
  ];
}

/**
 * The allowance report: every recorded figure, what it has spent, and what is
 * left. Printed on success as well as failure -- a report that appears only
 * when the guard is already red would tell a dock nothing it did not know.
 *
 * `total` is stated next to the counts on purpose. "0 over" proves nothing
 * unless the denominator is visible and reconciles, and the caller builds this
 * list from the same enumeration the assertions run over.
 */
export function formatAllowanceReport(rows, provenance, maxFraction, nearMiss = NEAR_MISS_FRACTION) {
  const classified = rows.map((row) => ({ row, verdict: classifyDrift(row, nearMiss) }));
  const count = (verdict) => classified.filter((entry) => entry.verdict === verdict).length;

  const labelWidth = Math.max(6, ...rows.map((row) => row.label.length));
  const col = (value, width) => String(value).padStart(width);

  const lines = [
    '',
    `DRIFT ALLOWANCE against measuredDrift.maxFraction = ${maxFraction * 100}%  ` +
      `(near-miss flag at ${nearMiss * 100}% of allowance; it fails nothing)`,
    `  ${'figure'.padEnd(labelWidth)}  ${col('recorded', 11)}  ${col('measured', 11)}  ` +
      `${col('drift', 9)}  ${col('allowance', 9)}  ${col('consumed', 8)}`,
  ];

  // Worst first: the row a reader needs is the one closest to the edge, and on
  // a long report that row is the only one that has to be read.
  for (const { row, verdict } of [...classified].sort((a, b) => b.row.consumed - a.row.consumed)) {
    const flag = verdict === 'over' ? '  OVER ALLOWANCE' : verdict === 'near-miss' ? '  NEAR MISS' : '';
    lines.push(
      `  ${row.label.padEnd(labelWidth)}  ${col(group(row.recorded), 11)}  ` +
        `${col(group(row.measured), 11)}  ${col(group(row.drift), 9)}  ` +
        `${col(group(row.tolerance), 9)}  ${col(formatConsumed(row.consumed), 8)}${flag}`,
    );
  }

  lines.push(
    '',
    `  ${rows.length} recorded figure(s) checked: ${count('over')} over allowance, ` +
      `${count('near-miss')} near miss, ${count('ok')} clear.`,
  );

  const worst = classified.reduce(
    (a, b) => (b.row.consumed > a.row.consumed ? b : a),
    classified[0],
  );
  if (worst) {
    lines.push(
      `  Closest to the edge: ${worst.row.label} at ${formatConsumed(worst.row.consumed)} ` +
        `of its allowance (${group(worst.row.drift)} of ${group(worst.row.tolerance)}).`,
    );
  }

  if (count('near-miss') > 0 || count('over') > 0) {
    lines.push(
      '',
      '  A figure this close to its allowance may be within one trunk commit of red -- the flag is',
      '  set at 75% of allowance, below the ~83% at which the incident that calibrated it (#826) was',
      '  actually one commit from the edge, so it warns early. The commit that carries a near miss',
      '  over need not be yours: the guard is spent by accumulated staleness from every change since',
      '  the figure was recorded. Re-record before handing off -- against the tree CI builds, which',
      '  is not this one unless the provenance below says it is.',
    );
  }

  lines.push('', ...describeProvenance(provenance), '');
  return lines;
}
