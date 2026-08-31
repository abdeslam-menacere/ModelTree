// Human-readable asset-budget report. Report-only: deliberately NOT wired into
// `npm run validate`, so `web/tests/workflows/web-ci.test.ts` (which pins the
// required check's step list to exactly `npm run build`) stays untouched. Run it
// by hand with `npm run assets:report` to see the table the budget test asserts
// against.
//
// It builds the site itself, with the SAME deploy environment the gate pins
// (asset-budgets.test.ts): NODE_ENV=production, BASE_PATH=/ModelTree/, SITE_URL,
// and BASE_URL dropped. Without this the numbers would silently disagree with the
// gate -- astro.config resolves `base: env.BASE_PATH ?? '/'`, so an ambient build
// renders every root-relative href 10 bytes shorter than the deploy CI enforces,
// the exact green-locally/red-on-CI split the raw-byte design exists to defeat.
// Keep these three values in sync with the gate and with .github/workflows/
// web-ci.yml. A manual report is not run concurrently with the vitest suite, so
// it does not need the suite's cross-process build lock.
//
// Usage:
//   node scripts/asset-report.mjs            build with the pinned deploy env, then report
//   node scripts/asset-report.mjs <distDir>  report an existing build as-is (no build)

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  analyzeRoute,
  globalTotals,
  groupWorst,
} from './asset-budget.mjs';

const webRoot = fileURLToPath(new URL('..', import.meta.url));

function buildPinned(outDir) {
  const { BASE_URL: _dropBaseUrl, ...inheritedEnv } = process.env;
  execFileSync(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build', '--outDir', outDir], {
    cwd: webRoot,
    stdio: 'inherit',
    env: {
      ...inheritedEnv,
      NODE_ENV: 'production',
      BASE_PATH: '/ModelTree/',
      SITE_URL: 'https://abdeslam-menacere.github.io',
    },
  });
}

const distArg = process.argv[2];
let dist;
if (distArg) {
  dist = distArg;
} else {
  dist = fileURLToPath(new URL('../dist', import.meta.url));
  buildPinned(dist);
}

const FIXED = [
  ['home', 'index.html'],
  ['catalog', 'models/index.html'],
  ['benchmarks', 'benchmarks/index.html'],
  ['tree', 'tree/index.html'],
  ['compare', 'compare/index.html'],
  ['updates', 'updates/index.html'],
];
const GROUPS = [
  ['passport', 'models'],
  ['providers', 'providers'],
];

const caches = { importCache: new Map(), fontCache: new Map() };
const kb = (n) => `${(n / 1024).toFixed(1)}kB`;

function line(label, t) {
  const cell = (c) => `${String(c.raw).padStart(8)} / ${String(c.gzip).padStart(7)}`;
  console.log(
    `  ${label.padEnd(26)} html ${cell(t.html)}  js ${cell(t.js)}  css ${cell(t.css)}  crit ${cell(t.critical)}`,
  );
}

console.log('raw / gzip bytes  (gate is on raw; gzip shown for realism)');
if (distArg) {
  console.log(`reporting existing build at ${distArg} as-is (base path not assumed)\n`);
} else {
  console.log('built at BASE_PATH=/ModelTree/ (the deploy base the gate measures)\n');
}
console.log('Fixed routes:');
for (const [id, path] of FIXED) line(id, analyzeRoute(dist, path, caches).totals);

console.log('\nRoute groups (worst-case page):');
for (const [id, dir] of GROUPS) {
  const worst = groupWorst(dist, dir, caches);
  line(`${id} (${worst.route})`, worst.totals);
}

const g = globalTotals(dist);
console.log('\nGlobals (_astro/):');
console.log(`  js    ${String(g.js).padStart(8)}  (${kb(g.js)})`);
console.log(`  css   ${String(g.css).padStart(8)}  (${kb(g.css)})`);
console.log(`  font  ${String(g.font).padStart(8)}  (${kb(g.font)})`);
console.log(`  other ${String(g.other).padStart(8)}  (${kb(g.other)})`);
console.log(`  dir   ${String(g.astroDir).padStart(8)}  (${kb(g.astroDir)})`);
