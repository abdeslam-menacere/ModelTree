// The route id -> output-path mapping, stated once (#1030).
//
// -- The defect this exists for --
//
// `asset-budgets.json` carries `path` on every `fixedRoutes` entry, and
// `tests/build/asset-budgets.test.ts` -- the gate that actually binds -- reads
// it from there. Two report scripts then restated the same six pairs as literal
// arrays: `asset-report.mjs` and `asset-runway-report.mjs`. The copies agreed
// with the data, which is why nothing had broken; the defect was LATENT and
// became live on a seventh route, which would have been gated by the test and
// silently absent from both reports.
//
// Worse than absent: `asset-runway-report.mjs` looked its own literal id up in
// the budget file and wrote `if (!budget) continue;`, so a route the data knew
// about and the literal did not was dropped without a word, and the report went
// on printing `N figure(s)` as though N were the whole set. That is the shape
// this repository has now hit four times -- #179, #276, #1029 and this one -- a
// value restated in prose or code while a data file holds the authority.
//
// So the rule is REFERENCE, NOT RESTATE, and it is enforced rather than asked
// for: there is no literal route list anywhere below, and a `fixedRoutes` entry
// this module cannot use is a named failure rather than a skipped row.
//
// -- Why a separate module --
//
// Both literals lived in entry-point scripts that build the site at import, so
// nothing could import them to check them and the duplication was structurally
// untestable. Everything here is pure: it takes a parsed budgets object and
// returns values. `scripts/asset-routes.test.ts` drives it with a fixture
// carrying a SEVENTH route, which is the case no test could reach before.
//
// It reads no file, measures nothing, gates nothing and permits nothing. No
// ceiling, no `measuredRaw` and no `measuredDrift` value is read or written
// here -- this module answers "which routes must a report cover", and the
// answer is "whatever the budget file says", which is the whole point.

/**
 * A budgets file this module cannot answer from.
 *
 * Its own class so a caller can tell a malformed budget file apart from a bug
 * in the caller: the two want different fixes, and a bare `Error` would collapse
 * them into one message.
 */
export class BudgetRouteError extends Error {}

/**
 * The fixed routes every report must cover, in the order `asset-budgets.json`
 * states them.
 *
 * Order is preserved rather than sorted, because the reports print in this
 * order and `docs/product/PERFORMANCE-BUDGETS.md` publishes figures read off
 * that output. Sorting here would reorder a published table for no reason.
 *
 * Every failure below is a THROW and never a skip. A route in the budget file
 * that a report cannot measure is exactly the state this issue exists to make
 * loud: skipping it leaves the report printing a denominator that counts the
 * rows it managed rather than the rows it was asked for, and those two numbers
 * differing is the only evidence that anything went wrong.
 *
 * @param {{ fixedRoutes?: unknown }} budgets  parsed `asset-budgets.json`
 * @returns {{ id: string, path: string, criticalMaxRaw: number }[]}
 */
export function fixedRoutesOf(budgets) {
  const routes = budgets?.fixedRoutes;

  if (!Array.isArray(routes)) {
    throw new BudgetRouteError(
      'asset-budgets.json has no `fixedRoutes` array, so there is no route list to report on. ' +
        'This is refused rather than treated as zero routes: a report over an empty set prints ' +
        '"0 figure(s)" and exits green, which is indistinguishable from a clean run and is the ' +
        'failure this check exists to prevent.',
    );
  }

  if (routes.length === 0) {
    throw new BudgetRouteError(
      '`fixedRoutes` in asset-budgets.json is empty, so every route-derived figure would be ' +
        'absent and every denominator would read zero. An empty budget file and a fully covered ' +
        'one must not produce the same green report.',
    );
  }

  return routes.map((route, index) => {
    const where = typeof route?.id === 'string' && route.id !== '' ? `id "${route.id}"` : `index ${index}`;

    if (typeof route?.id !== 'string' || route.id === '') {
      throw new BudgetRouteError(
        `fixedRoutes[${index}] has no usable \`id\`, so its figure could not be labelled in any ` +
          'report. Give the entry an id rather than letting the reports skip it.',
      );
    }

    if (typeof route.path !== 'string' || route.path === '') {
      throw new BudgetRouteError(
        `fixedRoutes entry ${where} has no usable \`path\`, so no report can measure it. ` +
          'Add the built HTML path (e.g. "updates/index.html") to asset-budgets.json. This is a ' +
          'failure and not a skip: a silently dropped route is a route whose ceiling is gated and ' +
          'whose size nothing reports.',
      );
    }

    if (typeof route.criticalMaxRaw !== 'number' || !Number.isFinite(route.criticalMaxRaw)) {
      throw new BudgetRouteError(
        `fixedRoutes entry ${where} has no usable \`criticalMaxRaw\` ceiling, so a runway or ` +
          'headroom reading for it would have no wall to measure against.',
      );
    }

    return { id: route.id, path: route.path, criticalMaxRaw: route.criticalMaxRaw };
  });
}

/**
 * Every figure label a full report is expected to produce, derived from the
 * budget file and from nothing else.
 *
 * This is what makes a printed denominator checkable. `asset-runway-report.mjs`
 * prints `N figure(s)`; N is only worth reading if it is a count of what the
 * budget file asked for, and comparing the measured labels against this set is
 * how the report establishes that rather than asserting it. A seventh route
 * moves this from 13 to 14, so no constant can stand in for it.
 *
 * The three categories are the report's own, kept in one place so a category
 * silently disappearing from `figuresFor` is a mismatch here rather than a
 * quietly smaller denominator.
 *
 * @param {object} budgets  parsed `asset-budgets.json`
 * @returns {string[]}
 */
export function expectedFigureLabels(budgets) {
  const labels = fixedRoutesOf(budgets).map((route) => `route:${route.id}`);

  const groups = budgets?.routeGroups;
  if (!Array.isArray(groups)) {
    throw new BudgetRouteError(
      'asset-budgets.json has no `routeGroups` array, so the group figures every report prints ' +
        'would be absent from the expected set and a report missing them would still look complete.',
    );
  }

  for (const group of groups) {
    if (typeof group?.id !== 'string' || group.id === '') {
      throw new BudgetRouteError('a routeGroups entry has no usable `id`, so its figure could not be labelled.');
    }
    labels.push(`group:${group.id}`);
    // Only `passport` carries a JS ceiling today. Presence of the key is the
    // condition, so adding one to another group adds its figure here too.
    if (typeof group.jsMaxRaw === 'number') labels.push(`group:${group.id} js`);
  }

  labels.push('global:js', 'global:css', 'global:font', 'global:_astro dir');
  return labels;
}

/**
 * Refuse a measured figure set that does not cover what the budget file asked
 * for, naming both directions of the difference.
 *
 * Both directions, because they are different faults and a reader sent looking
 * for the wrong one loses the time. A MISSING label is a figure the budget file
 * demands and the report did not measure -- the #1030 defect itself. An
 * UNEXPECTED label is the report measuring something the budget file does not
 * know about, which means this module and the report have drifted apart and the
 * denominator is over-counting rather than under-counting.
 *
 * @param {Iterable<string>} measured  labels the report actually produced
 * @param {string[]} expected  labels from `expectedFigureLabels`
 * @param {string} context  which arm or run is being checked
 */
export function assertFiguresCover(measured, expected, context) {
  const got = new Set(measured);
  const missing = expected.filter((label) => !got.has(label));
  const unexpected = [...got].filter((label) => !expected.includes(label));

  if (missing.length === 0 && unexpected.length === 0) return;

  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.length}: ${missing.join(', ')}`);
  if (unexpected.length > 0) parts.push(`unexpected ${unexpected.length}: ${unexpected.join(', ')}`);

  throw new BudgetRouteError(
    `${context} measured ${got.size} figure(s) where asset-budgets.json asks for ${expected.length} ` +
      `-- ${parts.join('; ')}. The printed denominator would have been a count of what this run ` +
      'managed rather than of what was asked for, and those two numbers differing is the only ' +
      'signal that anything was dropped.',
  );
}
