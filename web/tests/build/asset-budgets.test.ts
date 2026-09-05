import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { buildSiteExclusively } from './exclusive-build';
import {
  analyzeRoute,
  globalTotals,
  groupRoutes,
} from '../../scripts/asset-budget.mjs';
import {
  NEAR_MISS_FRACTION,
  driftFailureMessage,
  driftOf,
  formatAllowanceReport,
} from '../../scripts/asset-drift.mjs';
import { probeTreeProvenance } from '../../scripts/tree-provenance.mjs';

// Issue #33: enforce deterministic asset budgets on the real production build.
//
// This is the merge-blocking half of the issue. It runs inside `npm run test`,
// so it is carried by the required `web-ci` check with no workflow change -- the
// same route `tests/build/base-path.test.ts` takes. It gates on RAW bytes read
// off disk, never on any tool's console output: a colouriser can rewrite a
// human-readable summary between environments (green locally, red on CI), but a
// file's byte length is the same number everywhere. gzip/brotli are reported by
// `npm run assets:report`; only raw is gated, so there is no compressor-version
// variance to make this flake.
//
// Lab metrics (LCP/INP/CLS) are deliberately NOT here. They vary with CPU
// contention and would manufacture a flaky required check; they are measured and
// recorded in docs/product/PERFORMANCE-BUDGETS.md instead.
//
// DEVIATION (recorded, not silent): the plan approval asked for a workflow-step
// check over the deploy artifact rather than a third build. This test instead
// runs inside `npm run test`, so it spawns one production build of its own. That
// was chosen deliberately and the tradeoff is real: a workflow step speaks only
// at CI, whereas a vitest test fails inside `npm run validate`, so a dock catches
// a budget breach locally, before CI. Given a night dominated by defects that
// were structurally invisible to local runs, moving enforcement earlier is worth
// the price -- which is one extra full `astro build` inside `npm run test`. The
// measured wall-clock cost of that build is recorded in PERFORMANCE-BUDGETS.md.
//
// BUILD CONCURRENCY (adopted #34's shared lock): two `astro build` processes
// running concurrently crash libuv on Windows
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), and vitest runs
// test files in parallel workers. This file and base-path.test.ts each spawn a
// build at module load, so the two together would race -- Windows-only, so
// invisible on the Linux CI runner and only biting a local `npm run validate`.
// The build below therefore goes through `buildSiteExclusively`
// (web/tests/build/exclusive-build.ts, from #34): the single shared cross-process
// mkdir lock. A second independent lock here would be worse than none -- each is
// correct alone, yet the two would not exclude each other -- so this file uses
// that one helper and passes its own pinned environment through it.
//
// This file measures byte SIZE at the deploy's base path (pinned below). Base
// path CORRECTNESS -- that every root-relative link is actually prefixed -- is
// `tests/build/base-path.test.ts`'s job, not this file's.

// The reconciliation failure message, shared by the build-driven report arm and
// the committed reconciliation test so both diagnose an offending key the same
// way. Names the exact declared/covered keys and, for each side, why it is wrong.
function driftReconciliationMessage(
  declared: string[],
  covered: string[],
  uncovered: string[],
  orphaned: string[],
): string {
  return (
    `asset-budgets.json declares recorded figure key(s) [${declared.join(', ')}] and the drift ` +
    `guard covers key(s) [${covered.join(', ')}]. ` +
    (uncovered.length
      ? `Declared but unguarded: [${uncovered.join(', ')}] -- a recorded figure that no ` +
        'subject measures is a figure free to rot unnoticed. This includes the ' +
        '`passport.measuredWorstJsRaw` exact-zero tripwire (deleting it would otherwise pass ' +
        'silently) and a `routeGroups.<id>.measuredWorstJsRaw` on a group that has no `jsMaxRaw` ' +
        'ceiling, so no subject measures it (#882). Add the missing ceiling/subject rather than ' +
        'leaving the figure unguarded. '
      : '') +
    (orphaned.length
      ? `Guarded but not declared: [${orphaned.join(', ')}] -- a subject key that no field in ` +
        'asset-budgets.json declares, so a figure was renamed or removed. Fix the `key` on the ' +
        'matching subject, or restore the field to the file. '
      : '')
  );
}

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../asset-budgets.json', import.meta.url)), 'utf8'),
);

// --- Drift-coverage reconciliation, as pure functions (#847, extended #882) ---
//
// The reconciliation compares the SET of recorded-figure keys asset-budgets.json
// declares against the SET of keys the drift subjects cover. #847 established the
// set (not count) comparison; #882 makes the routeGroups JS figure group-scoped
// so a collapsed array index can no longer hide an unguarded group. These live
// at module scope, and take their inputs as arguments, so the committed test
// below can drive them over an in-memory mutated budgets clone WITHOUT a full
// production build -- pinning the reconciliation itself, which #847 only proved
// by hand in a gate transcript (#882, finding 2).

// Walk asset-budgets.json and return every numeric field whose name records a
// measurement, as a dotted path. Arrays contribute no index, so sibling entries
// collapse onto one path -- correct for `fixedRoutes.measuredRaw` and
// `routeGroups.measuredWorstRaw`, where every entry carries the figure and a
// per-index key would be noise.
function recordedFigureKeys(node: unknown, trail: string[] = []): string[] {
  if (Array.isArray(node)) return node.flatMap((item) => recordedFigureKeys(item, trail));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    typeof value === 'number' && /measured/i.test(key)
      ? [[...trail, key].join('.')]
      : recordedFigureKeys(value, [...trail, key]),
  );
}

// The declared key set. It is the generic scan, EXCEPT the collapsed
// `routeGroups.measuredWorstJsRaw` is expanded into one key per group that
// declares `measuredWorstJsRaw` -- `routeGroups.<id>.measuredWorstJsRaw`. Only
// the JS figure is expanded: unlike `measuredWorstRaw`, which every group
// carries, `measuredWorstJsRaw` is a per-group JS tripwire that a group is free
// NOT to have, so collapsing it hides a group that declares the figure without
// the `jsMaxRaw` ceiling that would make it measured (#882, finding 1).
function declaredDriftKeys(b: any): string[] {
  const generic = recordedFigureKeys(b).filter((k) => k !== 'routeGroups.measuredWorstJsRaw');
  const perGroupJs = (b.routeGroups ?? [])
    .filter((group: any) => typeof group.measuredWorstJsRaw === 'number')
    .map((group: any) => `routeGroups.${group.id}.measuredWorstJsRaw`);
  return [...new Set([...generic, ...perGroupJs])].sort();
}

// The covered key set: the distinct `key` of every drift subject.
function coveredDriftKeys(subjects: { key: string }[]): string[] {
  return [...new Set(subjects.map((subject) => subject.key))].sort();
}

// The covered key set derived straight from a budgets object -- the same keys the
// `driftSubjects` list produces, but as pure data with no `measure` thunks, so a
// committed test can reconcile a mutated budgets clone without a build. This MUST
// mirror the subject construction in the describe block below; the build-driven
// arm reconciles the real subjects, so a drift between the two is caught there.
function subjectKeysFor(b: any): string[] {
  const keys: string[] = [];
  (b.fixedRoutes ?? []).forEach(() => keys.push('fixedRoutes.measuredRaw'));
  (b.routeGroups ?? []).forEach(() => keys.push('routeGroups.measuredWorstRaw'));
  (b.routeGroups ?? [])
    .filter((group: any) => typeof group.jsMaxRaw === 'number')
    .forEach((group: any) => keys.push(`routeGroups.${group.id}.measuredWorstJsRaw`));
  (['jsTotalMeasuredRaw', 'cssTotalMeasuredRaw', 'fontTotalMeasuredRaw', 'astroDirMeasuredRaw']).forEach(
    (key) => keys.push(`globals.${key}`),
  );
  return [...new Set(keys)].sort();
}

// Reconcile the two sets. `uncovered` is a declared figure no subject measures
// (a figure free to rot, a deleted tripwire, or -- the #882 case -- a group's JS
// figure with no `jsMaxRaw`, so no subject is built for it). `orphaned` is a
// subject key no field declares (a renamed or removed field). Both name the
// offending key, so the message points at the exact group/field.
function reconcileDriftKeys(declared: string[], covered: string[]) {
  const declaredSet = new Set(declared);
  const coveredSet = new Set(covered);
  return {
    uncovered: declared.filter((key) => !coveredSet.has(key)),
    orphaned: covered.filter((key) => !declaredSet.has(key)),
  };
}


const outDir = mkdtempSync(join(tmpdir(), 'modeltree-asset-budgets-'));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

// The deploy's environment, reproduced explicitly so the measured bytes are the
// bytes that ship -- wherever this test runs. A raw-byte budget whose value
// depends on the ambient shell is not a budget. `web-ci.yml` sets BASE_PATH and
// SITE_URL at job level, so under CI the child build inherits them, while on a
// contributor's machine they are unset: the same green-local/red-CI split this
// whole approach exists to defeat, arriving through the environment rather than
// through a colouriser. So every deploy-shaping variable is pinned here, never
// inherited:
//   * BASE_PATH=/ModelTree/ -- astro.config resolves `base: env.BASE_PATH ?? '/'`,
//     and base prefixes every root-relative href and asset URL. Unpinned, a local
//     build measures `base=/` while CI enforces against `base=/ModelTree/`, so
//     every internal URL is 10 bytes shorter in the calibrated numbers than in
//     the build they gate. The budgets below are measured at /ModelTree/.
//   * SITE_URL -- length-neutral here (astro.config's fallback already equals the
//     deploy value), pinned anyway so the measured value means "what ships" by
//     construction, not by a coincidence between two defaults that a later config
//     change could break silently.
//   * NODE_ENV=production -- `astro build` in CI runs with NODE_ENV unset, so Vite
//     sets it to production and React minifies to its shipping bundle. Inheriting
//     vitest's NODE_ENV=test keeps React's dev build (~250kB of extra unminified
//     JS that never ships), measuring a bundle no visitor downloads. Pinned by the
//     assertion below, not just this comment.
//   * BASE_URL is dropped rather than left unset: vitest puts BASE_URL=/ into
//     process.env, Astro copies it onto import.meta.env where it wins over the
//     value derived from `base`, so an inherited BASE_URL un-prefixes every link.
//
// `buildSiteExclusively` passes this env through verbatim, so the pins above are
// exactly what the child build sees.
const BASE_PATH = '/ModelTree/';
const SITE_URL = 'https://abdeslam-menacere.github.io';
const { BASE_URL: _inheritedFromVitest, ...inheritedEnv } = process.env;

buildSiteExclusively(outDir, { ...inheritedEnv, NODE_ENV: 'production', BASE_PATH, SITE_URL });

// One cache set shared across every analysis in this file: `_astro` names are
// content-hashed, so each chunk is read and compressed once.
const caches = { importCache: new Map(), fontCache: new Map(), sizeCache: new Map() };

// Memoised by directory: a group scan re-reads every page's HTML, and the drift
// reporting below asks for the same two groups several more times than the
// original assertions did. The `caches` above already spare the shared `_astro`
// chunks; this spares the per-page HTML too, so the reporting added for #832
// costs no extra scans.
const groupAnalyses = new Map<string, ReturnType<typeof analyzeGroupUncached>>();

function analyzeGroupUncached(dir: string) {
  const analyses = groupRoutes(outDir, dir).map((route) => analyzeRoute(outDir, route, caches));
  const worstBy = (pick: (a: (typeof analyses)[number]) => number) =>
    analyses.reduce((worst, a) => (pick(a) > pick(worst) ? a : worst));
  return {
    count: analyses.length,
    worstCritical: worstBy((a) => a.totals.critical.raw),
    worstJs: worstBy((a) => a.totals.js.raw),
  };
}

function analyzeGroup(dir: string) {
  let analysis = groupAnalyses.get(dir);
  if (!analysis) {
    analysis = analyzeGroupUncached(dir);
    groupAnalyses.set(dir, analysis);
  }
  return analysis;
}

// Which tree these bytes describe. Measured once, at module load, and never
// asserted on: it is the provenance line attached to every drift reading below.
// A local build measures the branch alone; `web-ci.yml` checks out with no
// `ref:` override, so a `pull_request` run builds `refs/pull/N/merge`, the
// branch merged with trunk. The probe never throws and an unanswerable probe
// reports `undetermined` rather than "level" -- see scripts/tree-provenance.mjs.
const provenance = probeTreeProvenance(fileURLToPath(new URL('../..', import.meta.url)));

describe('deterministic asset budgets on the production build', () => {
  it('builds and emits a hashed asset directory', () => {
    expect(readdirSync(join(outDir, '_astro')).length).toBeGreaterThan(0);
  });

  // Pins the NODE_ENV=production correction above with an assertion, not just a
  // comment -- a correction that lives only in a comment is one refactor from
  // gone. If the child build inherits vitest's NODE_ENV=test, Vite resolves
  // React's DEVELOPMENT build (~250kB of extra unminified JS that never ships)
  // and the budgets would silently measure a bundle no visitor downloads. React
  // dev-only internals never appear in the production build; their presence in
  // any shipped chunk means the measured build was the dev build. Markers were
  // verified against a NODE_ENV=test build on 2026-08-30: `disabledLog` and
  // `captureOwnerStack` each appear in the dev client chunk and in zero
  // production chunks. The whole-build `jsTotalMaxRaw` budget is the
  // marker-independent size backstop -- the dev build measured 670,510 raw JS
  // bytes against a 520,000 ceiling -- so a React rename that defeated these
  // strings would still redden the global JS budget below.
  it('measures the production React build, not the dev build (NODE_ENV pin)', () => {
    const devOnlyMarkers = ['disabledLog', 'captureOwnerStack'];
    const jsFiles = readdirSync(join(outDir, '_astro')).filter((n) => n.endsWith('.js'));
    const offenders = jsFiles.filter((n) => {
      const src = readFileSync(join(outDir, '_astro', n), 'utf8');
      return devOnlyMarkers.some((marker) => src.includes(marker));
    });
    expect(
      offenders,
      `React dev-only internals (${devOnlyMarkers.join(', ')}) found in ${offenders.join(', ')}: ` +
        'the child build measured React in development mode. The NODE_ENV=production ' +
        'correction on the spawned build was lost -- the budgets are measuring a bundle that never ships.',
    ).toEqual([]);
  });

  describe('fixed representative routes', () => {
    it.each(budgets.fixedRoutes.map((r: any) => [r.id, r]) as [string, any][])(
      '%s stays within its critical-path budget',
      (_id: string, route: any) => {
        const { totals } = analyzeRoute(outDir, route.path, caches);
        expect(
          totals.critical.raw,
          `${route.id} (${route.path}) critical raw ${totals.critical.raw} > budget ${route.criticalMaxRaw}`,
        ).toBeLessThanOrEqual(route.criticalMaxRaw);
      },
    );

    // Non-vacuous: the JS accounting must actually be finding hydrated islands,
    // otherwise every route would pass a JS-inclusive budget trivially.
    it('measures non-zero island JS on at least one route', () => {
      const anyJs = budgets.fixedRoutes.some(
        (r: any) => analyzeRoute(outDir, r.path, caches).totals.js.raw > 0,
      );
      expect(anyJs).toBe(true);
    });
  });

  describe('route groups (worst-case page)', () => {
    it.each(budgets.routeGroups.map((g: any) => [g.id, g]) as [string, any][])(
      '%s worst-case page stays within its critical-path budget',
      (_id: string, group: any) => {
        const { count, worstCritical } = analyzeGroup(group.dir);
        expect(count, `no pages found under ${group.dir}/`).toBeGreaterThan(0);
        expect(
          worstCritical.totals.critical.raw,
          `${group.id} worst page ${worstCritical.route} critical raw ${worstCritical.totals.critical.raw} > budget ${group.criticalMaxRaw}`,
        ).toBeLessThanOrEqual(group.criticalMaxRaw);
      },
    );

    it.each(
      budgets.routeGroups
        .filter((g: any) => typeof g.jsMaxRaw === 'number')
        .map((g: any) => [g.id, g]) as [string, any][],
    )('%s pages stay under the static-hydration JS tripwire', (_id: string, group: any) => {
      const { worstJs } = analyzeGroup(group.dir);
      expect(
        worstJs.totals.js.raw,
        `${group.id} page ${worstJs.route} ships ${worstJs.totals.js.raw} bytes of JS > tripwire ${group.jsMaxRaw}; a client:* island was likely added to a static page`,
      ).toBeLessThanOrEqual(group.jsMaxRaw);
    });
  });

  describe('whole-build global budgets', () => {
    const g = budgets.globals;
    it.each([
      ['js', 'jsTotalMaxRaw'],
      ['css', 'cssTotalMaxRaw'],
      ['font', 'fontTotalMaxRaw'],
      ['astroDir', 'astroDirMaxRaw'],
    ] as const)('%s total stays within budget', (kind, key) => {
      const measured = globalTotals(outDir)[kind];
      expect(measured, `_astro ${kind} total ${measured} > budget ${g[key]}`).toBeLessThanOrEqual(
        g[key],
      );
    });

    // Non-vacuous, per kind. globalTotals classifies _astro files by filename
    // suffix (.js / .css / .woff2), and the ceilings above are one-sided: a
    // classifier drift that matched nothing -- a suffix typo, a bundler that
    // emitted .mjs, a font format change -- would zero that kind and pass the
    // ceiling trivially, so a real budget would stop measuring anything while
    // still reporting green. A production build always ships JS (React islands),
    // CSS and fonts, so each per-kind total must be non-zero. astroDir needs no
    // floor here: it sums every file regardless of suffix and is separately
    // asserted non-empty above, so it is the classifier-independent backstop.
    it.each([['js'], ['css'], ['font']] as const)(
      '%s total is non-empty (the per-kind classifier actually matched files)',
      (kind) => {
        const measured = globalTotals(outDir)[kind];
        expect(
          measured,
          `_astro ${kind} total measured 0: the suffix classifier in globalTotals matched no ` +
            `files, so this budget would pass its ceiling trivially. A suffix/format drift ` +
            `(e.g. .js -> .mjs, .woff2 -> a new font format) is the likely cause.`,
        ).toBeGreaterThan(0);
      },
    );
  });

  // The recorded-measurement drift guard -- abdeslam-menacere/ModelTree#813.
  //
  // Every `measured*` field in asset-budgets.json is documentation: the test
  // above gates on `criticalMaxRaw`, so a stale measurement never reddens a
  // build. That is exactly why it decayed. On 2026-09-02 every route's recorded
  // figure was stale, tree by 75,378 bytes, and the file was advertising 82,997
  // bytes of headroom on a route that had 7,619 -- which is how a fully
  // researched data tranche came to look unaffordable when it was not (#811).
  // Nothing failed, because nothing was checking.
  //
  // So the recorded numbers are now checked against the build that produced
  // them. This is a tightening and never a bypass: it permits no extra byte, it
  // cannot raise or soften a ceiling, and a route over its ceiling still fails
  // on the ceiling. A failure here means the recorded number is wrong -- re-run
  // `npm run assets:report` and write the new figures into asset-budgets.json.
  //
  // Raw bytes are deterministic for a given source tree (see the $schema-note),
  // so this cannot flake between machines the way a compressed or parsed figure
  // could.
  //
  // -- What #832 added, and what it deliberately did not --
  //
  // "For a given source tree" is the load-bearing clause, and there are two
  // source trees. A local run builds the branch alone; `web-ci.yml` checks out
  // with no `ref:` override, so a `pull_request` run builds `refs/pull/N/merge`,
  // the branch merged with trunk. The allowance below therefore absorbs two
  // unrelated quantities: accumulated staleness, which #813 sized it for, and
  // the branch-vs-trunk build delta, which nothing sized it for. Their sum
  // reddened PR #830 on a commit whose local run was green, with `/tree` at
  // 97.1% of its allowance locally and no way for the dock to see it, because a
  // pass/fail assertion cannot tell 97.1% from 2%.
  //
  // The fix is a reading, not a looser number. `maxFraction` is UNCHANGED at 2%
  // and every assertion below binds exactly where it did. What is new is that
  // each figure now reports how much of its allowance it has spent, on success
  // as well as on failure, and every reading carries the provenance of the tree
  // it was taken on. Widening the tolerance would have made the symptom vanish
  // and the guard meaningless; see scripts/asset-drift.mjs for why the two jobs
  // are reported apart rather than budgeted apart.
  describe('recorded measurements track the real build (measuredDrift)', () => {
    const { maxFraction } = budgets.measuredDrift;

    // The tolerance is the guard's own budget, so it gets the same treatment
    // the byte ceilings get: it is not for the party it constrains to widen
    // quietly. Every figure quoted here and in the failure message below is a
    // restatement of `measuredDrift.reason` in asset-budgets.json, which is the
    // authoritative record of the 2026-09-02 re-baseline and lists all eight
    // staleness figures (11.17, 4.92, 4.83, 4.66, 4.04, 3.13, 2.89, 0.93) --
    // re-derive the counts from there rather than trusting this restatement.
    // Drift that day ran 0.93%-11.17%, and four of the eight recorded figures
    // were stale by 4.0%-4.9%, so a tolerance above 5% would have called that
    // day's rot compliant.
    it('keeps a tolerance tight enough to have caught the drift it exists for', () => {
      expect(typeof maxFraction, 'measuredDrift.maxFraction must be a number').toBe('number');
      expect(maxFraction).toBeGreaterThan(0);
      expect(
        maxFraction,
        'a tolerance above 5% would have passed seven of the eight figures that ' +
          'were stale on 2026-09-02, and six of those seven are figures the 2% in ' +
          'force catches; widening it that far defeats the guard. The eight ' +
          'figures are recorded in `measuredDrift.reason` in asset-budgets.json',
      ).toBeLessThanOrEqual(0.05);
    });

    function expectWithinTolerance(label: string, recorded: number, measured: number) {
      // A recorded value that is not a number means the field this subject reads
      // was renamed or removed in asset-budgets.json (a `globals.*` subject reads
      // a hardcoded key, so a rename leaves `recorded` undefined). Fail on that
      // with the reconciliation message rather than letting `driftOf` carry the
      // undefined into `toLocaleString` and throw a `TypeError` -- issue #847,
      // finding 4a. The report test below names the exact key mismatch; this
      // keeps the per-figure arm from crashing before it gets there.
      expect(
        typeof recorded,
        `${label}: asset-budgets.json has no numeric recorded figure for this subject, so the ` +
          'field was renamed or removed. Reconcile the subject `key` with the file (see the drift ' +
          'allowance reconciliation below) rather than leaving a subject reading a missing field.',
      ).toBe('number');
      // A fraction of the recorded value, with no absolute floor: a recorded 0
      // (the passport static-hydration tripwire) therefore means exactly 0. The
      // arithmetic lives in scripts/asset-drift.mjs so the report below computes
      // the allowance the same way the assertion does -- a report describing a
      // different allowance from the one that binds would be worse than none.
      const row = driftOf(label, recorded, measured, maxFraction);
      expect(row.drift, driftFailureMessage(row, maxFraction, provenance)).toBeLessThanOrEqual(
        row.tolerance,
      );
    }

    // ONE enumeration of every recorded figure. The per-figure assertions and
    // the allowance report both read this list, so the report's denominator is
    // the assertion set by construction rather than by two lists happening to
    // agree. `measure` is a thunk: nothing is measured until the row is needed,
    // and every measurement goes through the caches above.
    // `key` is the dotted path of the JSON field this subject reconciles to,
    // written to match `recordedFigureKeys` below exactly (arrays contribute no
    // index, so every fixedRoutes entry shares `fixedRoutes.measuredRaw`). It is
    // what makes the reconciliation a set comparison on KEYS rather than a count:
    // deleting or renaming a recorded field changes the declared key set and no
    // longer merely its size, so a removal is caught the same way an addition is.
    type DriftSubject = { key: string; label: string; recorded: number; measure: () => number };

    const driftSubjects: DriftSubject[] = [
      ...budgets.fixedRoutes.map((route: any) => ({
        key: 'fixedRoutes.measuredRaw',
        label: `${route.id} (${route.path}) measuredRaw`,
        recorded: route.measuredRaw,
        measure: () => analyzeRoute(outDir, route.path, caches).totals.critical.raw,
      })),
      ...budgets.routeGroups.map((group: any) => ({
        key: 'routeGroups.measuredWorstRaw',
        label: `${group.id} measuredWorstRaw`,
        recorded: group.measuredWorstRaw,
        measure: () => analyzeGroup(group.dir).worstCritical.totals.critical.raw,
      })),
      ...budgets.routeGroups
        // Keyed on `jsMaxRaw`, not on `measuredWorstJsRaw`: a group with a JS
        // tripwire MUST carry its recorded drift companion, so this subject is
        // built whenever the tripwire exists. Deleting `measuredWorstJsRaw` then
        // leaves a subject whose `recorded` is undefined -- caught by the
        // per-figure guard's numeric check and by the key reconciliation below --
        // rather than silently dropping both the subject and the declared key and
        // staying green (#847, finding 1). Filtering on `measuredWorstJsRaw`
        // itself is what made a removal invisible.
        .filter((group: any) => typeof group.jsMaxRaw === 'number')
        .map((group: any) => ({
          // Keyed PER GROUP ID, not by the collapsed path `routeGroups.
          // measuredWorstJsRaw`. `routeGroups` is an array, so the generic key
          // scan drops the index and collapses every group's JS figure onto one
          // path -- which meant a `measuredWorstJsRaw` added to a group with no
          // `jsMaxRaw` (e.g. `providers`) was never a distinct declared key and
          // reconciled green against the figure `passport` supplies (#882,
          // finding 1). `declaredDriftKeys` below expands the same collapse on
          // the declared side, so a group carrying the JS figure without the
          // ceiling that builds this subject surfaces as an uncovered
          // `routeGroups.<id>.measuredWorstJsRaw` naming that group.
          key: `routeGroups.${group.id}.measuredWorstJsRaw`,
          label: `${group.id} measuredWorstJsRaw`,
          recorded: group.measuredWorstJsRaw,
          measure: () => analyzeGroup(group.dir).worstJs.totals.js.raw,
        })),
      ...(
        [
          ['js', 'jsTotalMeasuredRaw'],
          ['css', 'cssTotalMeasuredRaw'],
          ['font', 'fontTotalMeasuredRaw'],
          ['astroDir', 'astroDirMeasuredRaw'],
        ] as const
      ).map(([kind, key]) => ({
        key: `globals.${key}`,
        label: `globals.${key}`,
        recorded: budgets.globals[key],
        measure: () => globalTotals(outDir)[kind],
      })),
    ];

    it.each(driftSubjects.map((subject) => [subject.label, subject] as [string, DriftSubject]))(
      '%s matches the build',
      (_label: string, subject: DriftSubject) => {
        expectWithinTolerance(subject.label, subject.recorded, subject.measure());
      },
    );

    // The reporting half of #832, and the reason this issue is not "raise the
    // tolerance". The assertions above are pass/fail, so a figure that has spent
    // 97.1% of its allowance reads exactly like one that has spent 2% -- which
    // is what let PR #830 hand off green on a branch that was one trunk commit
    // from red. This prints consumed-vs-available for every recorded figure, on
    // success as well as on failure, and states which tree produced the numbers.
    //
    // It asserts rather than merely printing, because a report is only worth
    // reading if its denominator reconciles. `recordedFigureKeys` walks
    // asset-budgets.json itself and finds every numeric field whose name says it
    // records a measurement; the guard must cover exactly that SET of keys.
    //
    // The reconciliation is on the key SET, not on the count -- issue #847. A
    // count comparison (`driftSubjects.length === declared.length`) catches an
    // ADDED figure but not a REMOVED one: deleting `passport.measuredWorstJsRaw`
    // drops both sides to the same smaller number and stays green, silently
    // disarming the exact-zero static-hydration tripwire that recorded figure
    // is. Comparing the sets catches both directions and names the offending
    // key: a declared key with no subject (a figure free to rot, or a tripwire
    // deleted) and a subject key with no declaration (a stale subject) each fail
    // with the missing key in the message.
    it('reports how much of the drift allowance each recorded figure has consumed', () => {
      const declared = declaredDriftKeys(budgets);
      const covered = coveredDriftKeys(driftSubjects);

      expect(
        declared.length,
        'asset-budgets.json declares no recorded measurement at all, so this report and the ' +
          'assertions above are both measuring nothing. The key scan is the broken part, not the file.',
      ).toBeGreaterThan(0);

      const { uncovered, orphaned } = reconcileDriftKeys(declared, covered);
      expect(
        { uncovered, orphaned },
        driftReconciliationMessage(declared, covered, uncovered, orphaned),
      ).toEqual({ uncovered: [], orphaned: [] });

      const rows = driftSubjects.map((subject) =>
        driftOf(subject.label, subject.recorded, subject.measure(), maxFraction),
      );

      // eslint-disable-next-line no-console -- the report IS the deliverable here.
      console.log(
        formatAllowanceReport(rows, provenance, maxFraction, NEAR_MISS_FRACTION).join('\n'),
      );

      // Non-vacuous: a report built from thunks that all returned 0 would print
      // a clean table and mean nothing. Every route ships a non-trivial number
      // of bytes, so at least one measurement must be substantial.
      expect(
        rows.filter((row) => row.measured > 100_000).length,
        'no recorded figure measured over 100,000 bytes, so the report is not reading a real build',
      ).toBeGreaterThan(0);
    });

    // Non-vacuous: every assertion above is an equality-ish check, and a
    // comparison that is fed the same number on both sides passes while
    // measuring nothing. This proves the guard can see a difference at all.
    it('fails a recorded figure that is genuinely wrong', () => {
      const route = budgets.fixedRoutes.find((r: any) => r.id === 'tree');
      const measured = analyzeRoute(outDir, route.path, caches).totals.critical.raw;
      expect(measured, 'tree must measure a non-trivial number of bytes').toBeGreaterThan(100_000);
      expect(() =>
        expectWithinTolerance('control', Math.round(measured * 0.5), measured),
      ).toThrow();
    });
  });


  // The #34 accounting distinction, locked in. A route's transfer sums only its
  // render/hydration resources; an `og:image` <meta> asset (the single static OG
  // card #34 will add) is not one of those and must not be charged to any route.
  // Proven against the real build by pointing an og:image meta at the largest
  // real JS chunk and confirming the analyser counts zero JS for it.
  describe('the OG card accounting exclusion for #34', () => {
    const astroDir = join(outDir, '_astro');
    const names = readdirSync(astroDir);
    const css = names.find((n) => n.endsWith('.css'))!;
    const biggestJs = names
      .filter((n) => n.endsWith('.js'))
      .map((n) => ({ n, size: readFileSync(join(astroDir, n)).length }))
      .sort((a, b) => b.size - a.size)[0];

    const probe = 'og-exclusion-probe.html';
    writeFileSync(
      join(outDir, probe),
      `<!doctype html><html><head>` +
        `<link rel="stylesheet" href="/_astro/${css}">` +
        `<meta property="og:image" content="/_astro/${biggestJs.n}">` +
        `</head><body></body></html>`,
    );

    it('counts the stylesheet but never the og:image asset', () => {
      const { totals } = analyzeRoute(outDir, probe, caches);
      expect(totals.css.raw, 'stylesheet should be counted').toBeGreaterThan(0);
      expect(
        totals.js.raw,
        'an og:image <meta> asset must not be charged to a route',
      ).toBe(0);
      expect(biggestJs.size, 'probe must reference a non-trivial JS asset').toBeGreaterThan(0);
    });
  });
}, 300_000);

// #882: pin the drift-coverage RECONCILIATION itself, with no production build.
//
// #847 moved the guard from a count comparison to a key-SET comparison, and
// proved it worked by running mutations by hand in a gate transcript -- delete a
// key, rename a key, both go red. A transcript is not a regression test: nothing
// committed would notice if the reconciliation regressed to counting, or if the
// routeGroups JS figure went back to collapsing every group onto one path.
//
// These arms drive the pure reconciliation functions (`declaredDriftKeys`,
// `subjectKeysFor`, `reconcileDriftKeys`) directly over an in-memory clone of
// asset-budgets.json, so they need no build and run in milliseconds. They assert
// the reconciliation VERDICT (green/red) and, on the red arms, the offending key
// the message names -- which is what turns "the check refuses something" into
// "the check refuses the right something for the right reason".
//
// The suite deliberately carries a PASS-EXPECTED arm alongside the failing ones
// (#882, criterion 5): a suite where every arm expects refusal cannot tell a
// correct check from one that refuses everything.
describe('drift-coverage reconciliation (build-free, pins the key-set logic)', () => {
  const realBudgets = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../asset-budgets.json', import.meta.url)), 'utf8'),
  );
  const clone = () => JSON.parse(JSON.stringify(realBudgets));
  const reconcile = (b: any) =>
    reconcileDriftKeys(declaredDriftKeys(b), subjectKeysFor(b));

  // PASS-EXPECTED. The real, valid document reconciles clean. Without this arm a
  // reconciliation hardwired to `{ uncovered: ['x'], orphaned: [] }` would pass
  // every failing arm below and be worthless.
  it('accepts the real asset-budgets.json (nothing uncovered, nothing orphaned)', () => {
    expect(reconcile(realBudgets)).toEqual({ uncovered: [], orphaned: [] });
  });

  // PART 1. A routeGroup carrying `measuredWorstJsRaw` with no `jsMaxRaw` builds
  // no drift subject, so its figure is measured by nothing. Under the collapsed
  // key path this reconciled GREEN because `passport` supplied the shared path;
  // group-scoped keys surface it as uncovered and NAME the group.
  it('refuses a routeGroup JS figure that has no jsMaxRaw ceiling, naming the group', () => {
    const b = clone();
    const providers = b.routeGroups.find((g: any) => g.id === 'providers');
    expect(typeof providers.jsMaxRaw, 'fixture premise: providers has no jsMaxRaw').not.toBe(
      'number',
    );
    providers.measuredWorstJsRaw = 999999999;

    const { uncovered, orphaned } = reconcile(b);
    expect(uncovered).toContain('routeGroups.providers.measuredWorstJsRaw');
    expect(orphaned).toEqual([]);
    expect(
      driftReconciliationMessage(declaredDriftKeys(b), subjectKeysFor(b), uncovered, orphaned),
    ).toContain('providers');
  });

  // #847 finding preserved: deleting the passport exact-zero JS tripwire leaves a
  // subject (built from `jsMaxRaw`, which is still present) whose declared key is
  // gone -> orphaned, red. A count check would drop both sides equally and pass.
  it('refuses when the passport.measuredWorstJsRaw tripwire is deleted', () => {
    const b = clone();
    delete b.routeGroups.find((g: any) => g.id === 'passport').measuredWorstJsRaw;
    const { uncovered, orphaned } = reconcile(b);
    expect(orphaned).toContain('routeGroups.passport.measuredWorstJsRaw');
    expect(uncovered).toEqual([]);
  });

  // #847 finding preserved: a renamed field must produce the reconciliation
  // diagnosis (uncovered + orphaned), not a TypeError. This is ALSO the Part 2
  // proof -- a rename keeps the declared COUNT identical (one key removed, one
  // added) while changing the SET, so a count-equality reconciliation stays green
  // here. Reverting reconcileDriftKeys to a count check turns THIS arm red-less,
  // i.e. it fails to refuse, and the assertion below fails.
  it('refuses a renamed recorded key (and would pass a count check, pinning the set logic)', () => {
    const b = clone();
    b.globals.jsGrandTotalMeasuredRaw = b.globals.jsTotalMeasuredRaw;
    delete b.globals.jsTotalMeasuredRaw;

    const declared = declaredDriftKeys(b);
    const covered = subjectKeysFor(b);
    // The count is unchanged by a rename -- this is what a count check sees, and
    // why a count check would (wrongly) pass. Asserted so the pin is explicit.
    expect(declared.length, 'a rename must leave the declared count unchanged').toBe(
      declaredDriftKeys(realBudgets).length,
    );

    const { uncovered, orphaned } = reconcileDriftKeys(declared, covered);
    expect(uncovered).toContain('globals.jsGrandTotalMeasuredRaw');
    expect(orphaned).toContain('globals.jsTotalMeasuredRaw');
  });

  // The difference control for this build-free suite: the reconciler must be able
  // to return BOTH sides empty (proven by the pass arm) AND non-empty (proven by
  // the red arms). A reconciler that always returned `{uncovered:[],orphaned:[]}`
  // would pass the first arm and fail every red arm -- so the suite as a whole
  // cannot be satisfied by a check that refuses nothing OR one that refuses all.
  it('the reconciler distinguishes valid from invalid (not vacuous in either direction)', () => {
    const valid = reconcile(realBudgets);
    const invalid = (() => {
      const b = clone();
      b.routeGroups.find((g: any) => g.id === 'providers').measuredWorstJsRaw = 1;
      return reconcile(b);
    })();
    const isEmpty = (r: { uncovered: string[]; orphaned: string[] }) =>
      r.uncovered.length === 0 && r.orphaned.length === 0;
    expect(isEmpty(valid)).toBe(true);
    expect(isEmpty(invalid)).toBe(false);
  });
});
