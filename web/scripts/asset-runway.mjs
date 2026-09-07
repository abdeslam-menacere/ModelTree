/**
 * Route runway: spare bytes divided by a MEASURED growth rate (#1018).
 *
 * A THIRD READING, NOT A THIRD WALL
 *
 * `asset-drift.mjs` documents two walls -- drift of a recorded figure from the
 * built one, and headroom of a built figure under its ceiling. Both answer
 * "where am I now". Neither answers the question a data dock has to ask BEFORE
 * it spends a day on primary-source research: "how much can I add before this
 * reddens?" That question needs a rate, and a rate needs two points.
 *
 * The drift guard cannot supply one. It measures STALENESS of a record and
 * resets to ~0% every time somebody re-records, so it reads green all the way to
 * the wall. The headroom report supplies spare bytes but no rate, so it can say
 * `home` is closest to its ceiling and still not say how many creators that is.
 *
 * WHY THE RATE IS BUILT AND NOT MINED
 *
 * `measuredRaw` in `asset-budgets.json` is a record of a past measurement, not a
 * measurement of the current tree, so its history across commits is a sawtooth
 * of re-record events rather than a growth curve. Mining it yields whoever's
 * re-record size and cadence and never a rate. Worse, in that file "did not
 * grow" and "was not measured" are byte-identical, so an un-re-recorded route
 * reads exactly like a stable one -- which is how `catalog` came to sit second
 * closest to its ceiling with nobody having measured its growth at all.
 *
 * So `asset-runway-report.mjs` builds BOTH ARMS in the run that reports, and
 * this module does the accounting over the two results. Every figure gets a rate
 * from the same run, so the "flat means unmeasured" ambiguity cannot recur here:
 * a flat figure in this report was measured twice and did not move.
 *
 * FOUR STATUSES, BECAUSE THREE OF THEM ARE NOT "OK"
 *
 * A figure whose two arms agree is REPORTED AS FLAT, and flat is not the same
 * claim as unmeasured -- `docs/adr/0018-...` is the decision that these two must
 * stay separately representable, and the whole point of building both arms is
 * that this report can tell them apart. A figure that SHRANK between arms is an
 * instrument fault, not a windfall, and is undetermined. And if EVERY figure is
 * flat the overlay did not take at all, which is instrument failure rather than
 * a green result -- that is the arms-must-disagree control, and it is the reason
 * this module refuses to report a pass it cannot distinguish from a no-op.
 *
 * WHAT THIS PERMITS: nothing. It raises no ceiling, widens no allowance, and is
 * not wired into `npm run validate` or `npm run build`. It is a reading taken at
 * the one moment acting on it is still cheap -- before the records are written.
 */

import { CEILING_NEAR_MISS_FRACTION, classifyHeadroom, formatConsumed, headroomOf } from './asset-drift.mjs';
import { DEFAULT_DONOR_PERCENTILE } from './dataset-tranche.mjs';

/** Creators in the tranche a dock is asking about, when it does not say. */
export const DEFAULT_TRANCHE_CREATORS = 3;

/**
 * A command line that does not mean what it says is refused, not guessed at.
 *
 * Every failure below exits 2, the code this probe documents as "could not
 * answer", and never 1. Exit 1 is a FINDING -- a figure refusing the tranche --
 * and a crash or a typo wearing that code would be read as a measurement that
 * was taken. `Number.parseInt` is what makes that easy to get wrong: it accepts
 * `2.5` and `3abc` and returns an integer, so an `Number.isInteger` guard
 * downstream passes a value the user never typed. The whole-string test below
 * rejects them instead of silently truncating.
 */
export class UsageError extends Error {}

/**
 * Parse the probe's argv. Pure, and exported so the refusals above are testable:
 * a behavioural rule with no test is a rule that stops holding quietly.
 *
 * @param {string[]} argv
 * @returns {{ creators: number, percentile: number, donors: string[] | null, keep: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const args = {
    creators: DEFAULT_TRANCHE_CREATORS,
    percentile: DEFAULT_DONOR_PERCENTILE,
    donors: /** @type {string[] | null} */ (null),
    keep: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    const value = (name) => {
      const raw = inline ?? argv[i + 1];
      if (inline === undefined) i += 1;
      if (raw === undefined || raw === '' || raw.startsWith('--')) {
        throw new UsageError(`${name} needs a value`);
      }
      return raw;
    };
    const integer = (name) => {
      const raw = value(name);
      // Whole string, so `2.5` and `3abc` are refused rather than truncated.
      if (!/^\d+$/.test(raw)) throw new UsageError(`${name} needs a whole number, got "${raw}"`);
      return Number(raw);
    };

    if (flag === '--creators') args.creators = integer('--creators');
    else if (flag === '--percentile') args.percentile = integer('--percentile');
    else if (flag === '--donors') {
      const list = value('--donors')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) throw new UsageError('--donors needs at least one creator id');
      args.donors = list;
    } else if (flag === '--keep') args.keep = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new UsageError(`unknown flag ${flag}`);
  }

  if (args.percentile > 100) {
    throw new UsageError(`--percentile must be between 0 and 100, got ${args.percentile}`);
  }
  return args;
}

const group = (value) => value.toLocaleString('en-US');

/**
 * Runway accounting for one figure, from two arms of one run.
 *
 * `baseline` is the figure the unmodified dataset built and `tranche` the figure
 * the same tree built with `creators` synthetic creators added. Both come from
 * `asset-budget.mjs`, the same measurement code the budget test uses, so this
 * row cannot disagree with the assertion that binds about where the figure is
 * today -- only about how fast it is moving, which nothing else measures.
 *
 * `spare` is measured against the CEILING and against the arm-A build, never
 * against the value recorded in `asset-budgets.json`: the recorded value is a
 * record and may be months stale, and a runway computed from it would be a
 * runway from a tree nobody is standing in.
 */
export function rateOf(label, ceiling, baseline, tranche, creators) {
  const delta = tranche - baseline;
  const spare = ceiling - baseline;
  const perCreator = creators > 0 ? delta / creators : 0;

  let status;
  if (baseline > ceiling) status = 'over';
  else if (creators <= 0) status = 'undetermined';
  else if (delta < 0) status = 'shrunk';
  else if (delta === 0) status = 'flat';
  else status = 'rated';

  return {
    label,
    ceiling,
    baseline,
    tranche,
    delta,
    creators,
    perCreator,
    spare,
    // Whole creators only: two thirds of a creator is not a creator you can
    // write, and rounding up here would report affordable research that is not.
    affordable: status === 'rated' ? Math.floor(spare / perCreator) : null,
    status,
    headroom: classifyHeadroom(headroomOf(label, baseline, ceiling)),
  };
}

/**
 * How a row reads against the tranche actually being asked about.
 *
 * `refused` is the finding this instrument exists to produce, and it is produced
 * BEFORE the research rather than after `npm run validate`. `tight` affords the
 * request and not the one after it, which is worth saying separately: a dock
 * that lands a tranche into a `tight` figure has left the next dock with none.
 */
export function classifyRunway(row, requested = DEFAULT_TRANCHE_CREATORS) {
  if (row.status === 'over') return 'over';
  if (row.status === 'shrunk' || row.status === 'undetermined') return 'undetermined';
  if (row.status === 'flat') return 'flat';
  if (row.affordable < requested) return 'refused';
  if (row.affordable < requested * 2) return 'tight';
  return 'clear';
}

/**
 * The verdict and its exit code.
 *
 * Instrument faults are checked FIRST and win, because a refusal counted by a
 * broken instrument is not a refusal. Every-figure-flat is the specific fault
 * this probe is most likely to suffer: the data overlay silently failing to
 * apply produces two identical builds, which without this check reports as
 * "nothing grew" -- a green wall of zeroes indistinguishable from a real result.
 *
 *   0  every figure rated or flat, and every rated figure affords the request
 *   1  at least one figure is over its ceiling or cannot afford the request
 *   2  the probe could not answer: no figures, an arms-agree instrument failure,
 *      or a figure that shrank between arms
 *
 * Exit 2 is never a pass, which is the convention the gate scripts under
 * `.github/skills/modeltree-gates/` already hold to.
 *
 * The arms-agree fault is EVERY-FIGURE-FLAT, and not merely "no figure was
 * rated". The two are not the same set, because an over-ceiling row is read from
 * arm A alone -- `baseline > ceiling`, decided before any delta is looked at --
 * so it is never rated and a failed overlay can neither produce it nor hide it.
 * Testing `rated === 0` therefore filed the worst true finding this probe can
 * return, every route past its budget, as a broken harness: one exit code and
 * one verbatim reason string covering both "the overlay silently failed" and
 * "every route is over its ceiling", which route a reader to opposite places
 * (#1038). Instrument faults still win where they are faults; this narrows what
 * counts as one, and softens nothing about what a 2 means.
 */
export function runwayVerdict(rows, requested = DEFAULT_TRANCHE_CREATORS) {
  const verdicts = rows.map((row) => classifyRunway(row, requested));
  const count = (name) => verdicts.filter((v) => v === name).length;

  const tally = {
    total: rows.length,
    rated: rows.filter((row) => row.status === 'rated').length,
    flat: count('flat'),
    over: count('over'),
    refused: count('refused'),
    tight: count('tight'),
    clear: count('clear'),
    undetermined: count('undetermined'),
  };

  // The binding figure: the rated figure that runs out first. Not the same
  // ranking as the headroom report's, which sorts by fraction of ceiling used --
  // a figure can be further from its ceiling and still run out sooner because it
  // grows faster. That reordering is the reading this report adds.
  const rated = rows.filter((row) => row.status === 'rated');
  const binding = rated.length > 0 ? rated.reduce((a, b) => (b.affordable < a.affordable ? b : a)) : null;

  let code;
  let reason;
  if (rows.length === 0) {
    code = 2;
    reason = 'no figures were measured';
  } else if (tally.undetermined > 0) {
    code = 2;
    reason = `${tally.undetermined} figure(s) shrank between arms, which added records cannot do`;
  } else if (tally.flat === tally.total) {
    // Every figure flat, which is the overlay failing to apply. Statuses are
    // disjoint and `undetermined` is already spent above, so what remains is
    // over + flat + rated: this predicate is exactly "nothing but flat", and it
    // cannot be reached by a run carrying an over-ceiling row.
    code = 2;
    reason = 'no figure moved between the two arms -- the tranche overlay did not take';
  } else if (tally.over > 0 || tally.refused > 0) {
    code = 1;
    // Named separately rather than summed, so the reason alone says which of the
    // two it is: over-ceiling is a figure already past its budget with no tranche
    // added, while refused is a measured rate that will not carry the request.
    reason = [
      tally.over > 0 ? `${tally.over} figure(s) are over ceiling before any tranche is added` : null,
      tally.refused > 0 ? `${tally.refused} figure(s) cannot take a ${requested}-creator tranche` : null,
    ]
      .filter(Boolean)
      .join('; ');
  } else {
    code = 0;
    reason = `every rated figure affords ${requested} creator(s)`;
  }

  return { code, reason, tally, binding, requested };
}

/**
 * The runway report.
 *
 * Printed in full on success as well as failure, with its own denominator, for
 * the reason the two reports beside it are: a reading that appears only when
 * something is wrong is one a reader learns to read the absence of, and the
 * absence of a reading is not a finding.
 */
export function formatRunwayReport(rows, manifest, requested = DEFAULT_TRANCHE_CREATORS) {
  const verdict = runwayVerdict(rows, requested);
  const labelWidth = Math.max(6, ...rows.map((row) => row.label.length));
  const col = (value, width) => String(value).padStart(width);

  const lines = [
    '',
    'ROUTE RUNWAY -- spare bytes divided by a rate MEASURED in this run.',
    '  A THIRD reading, not a third wall. Drift measures staleness of a record and resets to',
    '  zero on every re-record; headroom measures distance to a ceiling but has no rate. This',
    '  measures how many creators fit in the distance, which is the question a data tranche',
    '  has to answer BEFORE the research, because records are the change and cannot be trimmed.',
    `  Both arms built here: arm A is the dataset as committed, arm B is the same tree plus`,
    `  ${manifest.creators} synthetic creator(s). No rate is mined from asset-budgets.json -- that file`,
    '  records re-record events, not growth, and cannot tell "did not grow" from "not measured".',
    '',
    `  ${'figure'.padEnd(labelWidth)}  ${col('arm A', 11)}  ${col('ceiling', 11)}  ${col('spare', 10)}  ` +
      `${col('B/creator', 10)}  ${col('creators', 9)}`,
  ];

  // Shortest runway first. A reader who reads one row should read the one that
  // runs out first, which is not necessarily the one closest to its ceiling.
  const order = { over: 0, refused: 1, tight: 2, clear: 3, flat: 4, undetermined: 5 };
  const decorated = rows.map((row) => ({ row, verdict: classifyRunway(row, requested) }));
  decorated.sort(
    (a, b) =>
      order[a.verdict] - order[b.verdict] ||
      (a.row.affordable ?? Infinity) - (b.row.affordable ?? Infinity) ||
      a.row.label.localeCompare(b.row.label),
  );

  for (const { row, verdict: rowVerdict } of decorated) {
    const rate = row.status === 'rated' ? group(Math.round(row.perCreator)) : '--';
    const creators = row.status === 'rated' ? group(row.affordable) : '--';
    const flag =
      rowVerdict === 'over'
        ? '  OVER CEILING'
        : rowVerdict === 'refused'
          ? `  REFUSED (< ${requested})`
          : rowVerdict === 'tight'
            ? '  TIGHT'
            : rowVerdict === 'flat'
              ? '  flat: measured twice, did not move'
              : rowVerdict === 'undetermined'
                ? '  UNDETERMINED'
                : '';
    const near = row.headroom === 'near-ceiling' && rowVerdict !== 'over' ? ' [near ceiling]' : '';
    lines.push(
      `  ${row.label.padEnd(labelWidth)}  ${col(group(row.baseline), 11)}  ${col(group(row.ceiling), 11)}  ` +
        `${col(group(row.spare), 10)}  ${col(rate, 10)}  ${col(creators, 9)}${flag}${near}`,
    );
  }

  const t = verdict.tally;
  lines.push(
    '',
    `  ${t.total} figure(s): ${t.rated} rated, ${t.flat} flat, ${t.undetermined} undetermined.`,
    `  Of the rated: ${t.clear} clear, ${t.tight} tight, ${t.refused} refused, ${t.over} over ceiling.`,
  );

  if (verdict.binding) {
    lines.push(
      `  Binds first: ${verdict.binding.label} at ${group(verdict.binding.affordable)} more creator(s) ` +
        `(${group(verdict.binding.spare)} spare / ${group(Math.round(verdict.binding.perCreator))} per creator).`,
    );
  }

  if (t.flat > 0) {
    lines.push(
      '',
      '  FLAT is a measurement, not a gap. Those figures were built twice and did not move, so a',
      '  data tranche does not bound them -- unlike asset-budgets.json, where an unmoved number',
      '  and an unmeasured one are byte-identical. It is not a claim about code changes, which',
      '  move hashed assets that a dataset never touches.',
    );
  }

  if (t.refused > 0 || t.over > 0) {
    lines.push(
      '',
      `  REFUSED means the research should not start. ADR 0010 says trim first and raise a ceiling`,
      '  only when trimming cannot close the gap -- and a data tranche CANNOT trim, because the',
      '  records are the change. So the trim has to come from elsewhere on the route, or the',
      '  tranche has to be smaller, and both of those are cheap to decide now and expensive to',
      '  discover after the sources have been read.',
    );
  }

  if (rows.some((row) => row.headroom === 'near-ceiling')) {
    lines.push(
      '',
      `  [near ceiling] is the ${formatConsumed(CEILING_NEAR_MISS_FRACTION)}-of-ceiling flag from the headroom report, carried`,
      '  here so it decides something rather than only printing: the creators column says how',
      '  many creators that flag is worth. A flagged figure with a long runway is a slow route',
      '  near its wall; an unflagged figure with a short runway is a fast route that will be',
      '  there shortly, and the headroom report alone ranks the second one as safe.',
    );
  }

  lines.push('', `  ${verdict.code === 0 ? 'PASS' : verdict.code === 1 ? 'REFUSED' : 'UNDETERMINED'}: ${verdict.reason}.`, '');
  return lines;
}

/**
 * What a synthetic creator consisted of, in the run that produced the rate.
 *
 * A rate whose unit is unstated is not checkable, and "creator" is not a fixed
 * quantity here -- the dataset's creators run from 6 records to 59. So the
 * report names the donors and their footprints rather than leaving a reader to
 * assume the rate came from a creator like the one they are about to add.
 */
export function formatTrancheManifest(manifest) {
  const lines = [
    '',
    `Synthetic tranche: ${manifest.creators} creator(s), ${manifest.addedRecords} record(s) added.`,
  ];
  if (manifest.percentile !== null && manifest.percentile !== undefined) {
    lines.push(
      `  Donors drawn from the p${manifest.percentile} footprint percentile -- deliberately above the median,`,
      '  because a rate from a below-typical creator over-states runway, and over-stated runway is',
      '  what loses a dock a day of research. Override with --donors or --percentile.',
    );
  } else {
    lines.push('  Donors named explicitly with --donors.');
  }
  for (const clone of manifest.clones) {
    const f = clone.footprint;
    lines.push(
      `  ${clone.tag}  <- ${clone.donorId.padEnd(22)} ${String(f.families).padStart(2)} famil(y/ies), ` +
        `${String(f.releases).padStart(2)} release(s), ${String(f.sources).padStart(2)} source(s), ` +
        `${String(clone.records).padStart(3)} record(s)`,
    );
  }
  lines.push('');
  return lines;
}
