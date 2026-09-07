// Drift-allowance accounting for the recorded asset-budget measurements, and
// the provenance of the tree they were measured on -- abdeslam-menacere/ModelTree#832.
//
// -- The defect this exists for --
//
// `asset-budgets.test.ts` compares each `measured*` figure in
// asset-budgets.json against a locally built page weight and fails when they
// differ by more than `measuredDrift.maxFraction`. That guard is right and
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
//
// -- TWO WALLS, TWO THRESHOLDS: read the axis before reading the number --
//
// abdeslam-menacere/ModelTree#939. Everything above measures ONE axis, and it is
// not the axis that gates dataset growth. This module now carries both, and they
// are unrelated quantities that are easy to read as each other:
//
//   DRIFT AXIS    |recorded - measured| against floor(recorded * maxFraction).
//                 Flagged at `NEAR_MISS_FRACTION` = 0.75 of the ALLOWANCE.
//                 "How stale is the recorded figure?" A red here is
//                 SELF-CLEARING: re-record with `npm run assets:report`, which
//                 ADR 0015 lets an unattended refresh do for itself.
//
//   CEILING AXIS  measured against `criticalMaxRaw` / `jsMaxRaw` /
//                 `globals.*MaxRaw`. Flagged at `CEILING_NEAR_MISS_FRACTION`
//                 = 0.925 of the CEILING. "How much room is left before the
//                 build reddens?" A red here is NOT self-clearing: it needs a
//                 trim, or a human decision to raise a ceiling that ADR 0015
//                 deliberately keeps OUT of the auto-merging class.
//
// `driftOf` mentions no ceiling anywhere, so `consumed` cannot say anything
// about ceiling headroom by construction -- which is why a route could sit at
// 95% of its enforced ceiling and trip nothing at all. Measured at trunk
// b44c63d6: four of the thirteen checked figures were above 94% of their
// ceiling and silent, while the drift report printed beside them read every one
// of those figures at 0.0% of its allowance, because #987 had just re-recorded
// them. A re-record resets the first axis completely and moves the second not
// one byte. That is the whole reason the second instrument has to exist
// separately rather than being read off the first.
//
// #874 conflated the two, asserting a "75% on 11 of 13" reading as though some
// implemented flag governed it. No flag did. The coincidence is real and worth
// naming so it is not mistaken for a flag again: at trunk b44c63d6 a 0.75 line
// on the CEILING axis would indeed fire on 11 of 13 figures -- which is exactly
// why 0.75 is the wrong number there, and why the threshold below is derived
// rather than borrowed.

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
 *
 * AXIS. This is 75% of the DRIFT ALLOWANCE -- `measuredDrift.maxFraction`, a
 * fraction of a recorded figure -- and it is NOT a statement about ceiling
 * headroom. The ceiling axis has its own threshold,
 * `CEILING_NEAR_MISS_FRACTION` below, at a deliberately different number so the
 * two cannot be confused by sight. Do not read this 0.75 as "75% of the way to
 * the budget"; see the two-walls note in this file's header for why they
 * measure different things and why a re-record moves this one to zero while
 * leaving the other exactly where it was.
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

/**
 * When a figure is reported as NEAR CEILING: it is under its enforced ceiling,
 * so it passes, and it has little enough room left that the ordinary growth of
 * this repository is about to take the rest.
 *
 * -- Derived, not picked --
 *
 * Measured from the history of `web/asset-budgets.json` itself, with a
 * key-level JSON parse of every revision (never a line regex -- field names
 * appear inside `reason` prose, so a regex hit is not a field change). For each
 * pair of successive revisions, each entry's change in recorded measurement is
 * expressed as a fraction of THAT ENTRY'S OWN CEILING, which is the quantity
 * this threshold has to survive. Five spans moved a recorded figure; 36
 * positive per-entry deltas in total.
 *
 * One of those five is not an ordinary span and is excluded on the file's own
 * evidence: 441b33f4..2c951daa is the #813/#818 RE-BASELINE, which absorbed 23
 * commits of accumulated staleness in one write (`drift-note` records exactly
 * that). It is a correction of a long-rotted record rather than one tranche of
 * growth, and including it inflates the estimate -- it supplies the four
 * largest deltas in the set, up to 4.32%.
 *
 * The four ordinary spans (n = 26 positive deltas) measured:
 *
 *     median  1.09%   p90  2.10%   max  3.74%   of ceiling
 *
 * and the worst single entry in each of those four spans was 1.98%, 3.74%,
 * 2.11% and 1.81%. So the most any one entry has lost to one ordinary landed
 * span is 3.74% of its ceiling -- `benchmarks`, +19,462 bytes of a 520,000
 * ceiling, at #872.
 *
 * The threshold leaves room for TWO such spans:
 *
 *     1 - (2 x 0.0374) = 0.9252, rounded DOWN to 0.925
 *
 * Rounded down and never up: down warns marginally earlier, which is the
 * recoverable direction. Two rather than one because of the asymmetry in the
 * header note -- a drift red clears itself by re-recording, so one span of
 * notice is enough there, whereas a ceiling red clears only by trimming or by a
 * human raising a ceiling ADR 0015 puts out of the auto-merging class. The
 * warning therefore has to arrive with room to ACT, not merely room to notice:
 * one span for the tranche already in flight, and one more for a trim to be
 * scheduled and landed before the ceiling actually reddens.
 *
 * -- What a crossing is meant to prompt --
 *
 * Trim the route, on ADR 0010's stopping rule: trim first, raise only when
 * trimming cannot close the gap. Failing that, accept explicitly that the next
 * ordinary data tranche reddens this entry and that clearing it is a human
 * decision, not something an unattended refresh can do for itself. It is NOT a
 * prompt to raise the ceiling, and nothing here can raise one.
 *
 * -- That it discriminates, measured --
 *
 * A naive 0.75 borrowed from the drift axis fires on 11 of the 13 checked
 * figures at trunk b44c63d6, and so carries no information -- which is the
 * finding #939 was filed on. At that same trunk: 0.85 also fires on 11, 0.90 on
 * 6, and 0.925 on 4 -- `compare` 95.83%, `home` 95.80%, `catalog` 95.37% and
 * `benchmarks` 94.57%. The next figure below is `providers` at 90.41%, so 92.5%
 * sits in the middle of a 4.16-point gap and is robust to small movement in
 * either direction. Those four are exactly the entries with under two ordinary
 * spans of room left.
 *
 * -- It permits nothing --
 *
 * Identical discipline to `NEAR_MISS_FRACTION`. This threshold cannot make a
 * failing check pass, cannot raise or soften a ceiling, cannot widen
 * `measuredDrift.maxFraction`, and crossing it changes no exit code and fails
 * no test. `classifyHeadroom` decides `over` from the ceiling comparison alone,
 * so this number cannot disagree with the assertion that binds. It only decides
 * whether a passing row prints with a warning beside it.
 */
export const CEILING_NEAR_MISS_FRACTION = 0.925;

/**
 * Ceiling-headroom accounting for one measured figure -- the second wall.
 *
 * `used` is `measured / ceiling`, so `1 - used` is `spare / ceiling` -- the
 * fraction of the ceiling that is unoccupied. This is distinct from
 * `spare / measured` (the fraction by which the route can grow from its current
 * size), which is the other convention used in asset-budgets.json prose. The
 * two diverge as headroom widens; see #1023 for the measured gap per route.
 *
 * `measured` is the figure the BUILD produced, not the one recorded in
 * asset-budgets.json, because the built figure is what the ceiling assertion
 * compares. Reporting headroom against the recorded value instead would
 * describe a guard that is not the one running -- the same trap `driftOf`
 * avoids by reproducing the test's own tolerance arithmetic.
 *
 * A ceiling of 0 has no fraction to be a fraction of: `used` is 0 for a
 * measured 0 and Infinity otherwise, which sorts a tripped tripwire to the top
 * of the report where it belongs.
 */
export function headroomOf(label, measured, ceiling) {
  const used = ceiling === 0 ? (measured === 0 ? 0 : Infinity) : measured / ceiling;
  return {
    label,
    measured,
    ceiling,
    headroom: ceiling - measured,
    used,
    within: measured <= ceiling,
  };
}

/**
 * `over` (above the ceiling -- the budget assertion fails on this row),
 * `near-ceiling` (under it, but at or above `nearMiss` of it) or `ok`.
 *
 * `over` is decided by `within` and never by the used fraction, so this
 * classification can never disagree with the assertion that actually binds --
 * and no value of `nearMiss`, including 1 or 0, can turn an over-ceiling row
 * into a passing one. That is what "permits nothing" means mechanically.
 */
export function classifyHeadroom(row, nearMiss = CEILING_NEAR_MISS_FRACTION) {
  if (!row.within) return 'over';
  return row.used >= nearMiss ? 'near-ceiling' : 'ok';
}

/**
 * The headroom report: every measured figure against the ceiling that binds it,
 * and how much room is left. Printed next to the drift allowance report so both
 * walls are visible in one place, because the whole defect was that a reader
 * looking at one of them had no way to see the other.
 *
 * Like the allowance report it prints on success as well as failure, states its
 * own denominator, and names the row closest to the edge.
 */
export function formatHeadroomReport(rows, ceilingNearMiss = CEILING_NEAR_MISS_FRACTION) {
  const classified = rows.map((row) => ({ row, verdict: classifyHeadroom(row, ceilingNearMiss) }));
  const count = (verdict) => classified.filter((entry) => entry.verdict === verdict).length;

  const labelWidth = Math.max(6, ...rows.map((row) => row.label.length));
  const col = (value, width) => String(value).padStart(width);

  const flagPercent = formatConsumed(ceilingNearMiss);

  const lines = [
    '',
    'CEILING HEADROOM -- a DIFFERENT axis from the drift allowance above.',
    '  Measured against its CEILING, not recorded against measured. A re-record moves the',
    `  numbers above to zero and these not one byte. Near-ceiling flag at ${flagPercent} of the`,
    '  CEILING; it fails nothing, permits nothing and changes no exit code.',
    `  ${'figure'.padEnd(labelWidth)}  ${col('measured', 11)}  ${col('ceiling', 11)}  ` +
      `${col('headroom', 10)}  ${col('used', 8)}`,
  ];

  // Worst first, same as the allowance report: the only row a reader has to
  // read on a long report is the one closest to the edge.
  for (const { row, verdict } of [...classified].sort((a, b) => b.row.used - a.row.used)) {
    const flag = verdict === 'over' ? '  OVER CEILING' : verdict === 'near-ceiling' ? '  NEAR CEILING' : '';
    lines.push(
      `  ${row.label.padEnd(labelWidth)}  ${col(group(row.measured), 11)}  ` +
        `${col(group(row.ceiling), 11)}  ${col(group(row.headroom), 10)}  ` +
        `${col(formatConsumed(row.used), 8)}${flag}`,
    );
  }

  lines.push(
    '',
    `  ${rows.length} measured figure(s) checked against a ceiling: ${count('over')} over ceiling, ` +
      `${count('near-ceiling')} near ceiling, ${count('ok')} clear.`,
  );

  const worst = classified.reduce((a, b) => (b.row.used > a.row.used ? b : a), classified[0]);
  if (worst) {
    lines.push(
      `  Closest to its ceiling: ${worst.row.label} at ${formatConsumed(worst.row.used)} ` +
        `of ${group(worst.row.ceiling)} (${group(worst.row.headroom)} bytes left).`,
    );
  }

  if (count('near-ceiling') > 0 || count('over') > 0) {
    lines.push('', `  NEAR CEILING is set at ${flagPercent} of the ceiling.`);
    if (ceilingNearMiss === CEILING_NEAR_MISS_FRACTION) {
      lines.push(
        '  That is 1 - 2x the 3.74% of its own ceiling that one ordinary landed span has cost a',
        '  single entry at its worst (benchmarks at #872) -- so a flagged figure has under two',
        '  such spans of ordinary growth left before it reddens.',
      );
    }
    lines.push(
      '  It is NOT the drift near-miss above and is not cleared the same way: re-recording a',
      '  measured figure resets the drift allowance to zero and moves this number not one byte.',
      '  Clearing it means TRIMMING the route -- ADR 0010 says trim first, raise only when',
      '  trimming cannot close the gap -- and raising a ceiling is a human decision ADR 0015 keeps',
      '  out of the auto-merging class. Nothing here permits a byte, fails a test or changes an',
      '  exit code; it is a reading, and acting on it is optional until the ceiling itself',
      '  reddens, at which point it is not.',
    );
  }

  lines.push('');
  return lines;
}
