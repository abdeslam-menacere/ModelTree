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

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../asset-budgets.json', import.meta.url)), 'utf8'),
);

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

function analyzeGroup(dir: string) {
  const analyses = groupRoutes(outDir, dir).map((route) => analyzeRoute(outDir, route, caches));
  const worstBy = (pick: (a: (typeof analyses)[number]) => number) =>
    analyses.reduce((worst, a) => (pick(a) > pick(worst) ? a : worst));
  return {
    count: analyses.length,
    worstCritical: worstBy((a) => a.totals.critical.raw),
    worstJs: worstBy((a) => a.totals.js.raw),
  };
}

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
  describe('recorded measurements track the real build (measuredDrift)', () => {
    const { maxFraction } = budgets.measuredDrift;

    // The tolerance is the guard's own budget, so it gets the same treatment
    // the byte ceilings get: it is not for the party it constrains to widen
    // quietly. Measured drift on the 2026-09-02 re-baseline ran 0.62%-11.1%,
    // and four of the eight recorded figures were stale by 4.0%-4.9%, so a
    // tolerance above 5% would have called that day's rot compliant.
    it('keeps a tolerance tight enough to have caught the drift it exists for', () => {
      expect(typeof maxFraction, 'measuredDrift.maxFraction must be a number').toBe('number');
      expect(maxFraction).toBeGreaterThan(0);
      expect(
        maxFraction,
        'a tolerance above 5% would have passed four of the eight figures that were ' +
          'stale on 2026-09-02; widening it that far defeats the guard',
      ).toBeLessThanOrEqual(0.05);
    });

    function expectWithinTolerance(label: string, recorded: number, measured: number) {
      // A fraction of the recorded value, with no absolute floor: a recorded 0
      // (the passport static-hydration tripwire) therefore means exactly 0.
      const tolerance = Math.floor(recorded * maxFraction);
      const drift = Math.abs(measured - recorded);
      expect(
        drift,
        `${label}: asset-budgets.json records ${recorded}, the build measures ${measured} ` +
          `(drift ${drift} > tolerance ${tolerance} at ${maxFraction * 100}%). The recorded ` +
          `figure is stale, not the ceiling. Re-run \`npm run assets:report\` and update the ` +
          `measured value; do NOT change any *MaxRaw ceiling to accommodate this.`,
      ).toBeLessThanOrEqual(tolerance);
    }

    it.each(budgets.fixedRoutes.map((r: any) => [r.id, r]) as [string, any][])(
      '%s measuredRaw matches the build',
      (_id: string, route: any) => {
        expectWithinTolerance(
          `${route.id} (${route.path}) measuredRaw`,
          route.measuredRaw,
          analyzeRoute(outDir, route.path, caches).totals.critical.raw,
        );
      },
    );

    it.each(budgets.routeGroups.map((g: any) => [g.id, g]) as [string, any][])(
      '%s measuredWorstRaw matches the build',
      (_id: string, group: any) => {
        const { worstCritical, worstJs } = analyzeGroup(group.dir);
        expectWithinTolerance(
          `${group.id} measuredWorstRaw`,
          group.measuredWorstRaw,
          worstCritical.totals.critical.raw,
        );
        if (typeof group.measuredWorstJsRaw === 'number') {
          expectWithinTolerance(
            `${group.id} measuredWorstJsRaw`,
            group.measuredWorstJsRaw,
            worstJs.totals.js.raw,
          );
        }
      },
    );

    it.each([
      ['js', 'jsTotalMeasuredRaw'],
      ['css', 'cssTotalMeasuredRaw'],
      ['font', 'fontTotalMeasuredRaw'],
      ['astroDir', 'astroDirMeasuredRaw'],
    ] as const)('globals %s measured total matches the build', (kind, key) => {
      expectWithinTolerance(`globals.${key}`, budgets.globals[key], globalTotals(outDir)[kind]);
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
