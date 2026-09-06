/**
 * `npm run assets:runway` -- how many creators fit before a ceiling reddens.
 *
 * WHAT IT DOES
 *
 * Builds the site TWICE from this working tree: arm A on the dataset exactly as
 * committed, arm B on the same tree plus a synthetic tranche of N cloned
 * creators. The difference between the two arms, divided by N, is a growth rate
 * per creator -- measured here, in this run, on this commit. Spare bytes divided
 * by that rate is a runway in creators, which is the unit a data dock plans in.
 *
 * WHY IT BUILDS RATHER THAN READS
 *
 * `asset-budgets.json` cannot supply a rate. `measuredRaw` there is a record of
 * a past measurement that moves only on re-record, so its history is a sawtooth
 * of re-record events and not a growth curve, and in that file "did not grow"
 * and "was not measured" are byte-identical. Four of the six fixed routes have
 * never had a growth rate measured at all, and it cannot be back-filled from
 * history -- obtaining one requires deliberately building both arms, which is
 * what this does.
 *
 * WHEN TO RUN IT
 *
 * At the START of a data tranche, before the primary-source research. A dataset
 * change cannot be trimmed -- the records ARE the change -- so a route that
 * cannot take the tranche has to be found before the sources are read, not after
 * `npm run validate` refuses the result.
 *
 * It is deliberately NOT wired into `npm run validate` or `npm run build`: it
 * costs two full builds, it asserts nothing, and it permits nothing. The
 * required CI check's step list is pinned by `tests/workflows/web-ci.test.ts` to
 * exactly `npm run build`, and this stays outside it.
 *
 *   npm run assets:runway                       # default 3-creator tranche
 *   npm run assets:runway -- --creators 6       # can I afford six?
 *   npm run assets:runway -- --donors meta,ibm  # model a specific tranche
 *   npm run assets:runway -- --creators 0       # mechanism control, see below
 *
 * Exit 0 the tranche fits, 1 a figure refuses it, 2 the probe could not answer.
 * Exit 2 is never a pass.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { analyzeRoute, globalTotals, groupWorst } from './asset-budget.mjs';
import { describeProvenance } from './asset-drift.mjs';
import {
  UsageError,
  formatRunwayReport,
  formatTrancheManifest,
  parseArgs,
  rateOf,
  runwayVerdict,
} from './asset-runway.mjs';
import { DATA_FILES, buildTranche } from './dataset-tranche.mjs';
import { probeTreeProvenance } from './tree-provenance.mjs';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const budgets = JSON.parse(readFileSync(join(webRoot, 'asset-budgets.json'), 'utf8'));

// Under node_modules/ so it is ignored by git without a new ignore rule, and so
// a run that dies part way cannot leave anything in the working tree for the
// next agent's `git status` to trip over.
const workRoot = join(webRoot, 'node_modules/.cache/asset-runway');

function parseArgsOrExit(argv) {
  try {
    return parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`asset-runway: ${error.message}`);
    console.error('  Exit 2: the probe could not answer. Exit 1 means a figure REFUSED the tranche,');
    console.error('  which is a measurement, so a bad command line must never borrow that code.');
    console.error('  usage: npm run assets:runway -- [--creators N] [--percentile P] [--donors a,b,c] [--keep]');
    process.exit(2);
  }
}

const args = parseArgsOrExit(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      'usage: npm run assets:runway -- [--creators N] [--percentile P] [--donors a,b,c] [--keep]',
      '',
      '  --creators N    creators in the tranche being asked about (default 3; 0 runs the',
      '                  mechanism control, which requires the two arms to come out identical)',
      '  --percentile P  footprint percentile donors are drawn from (default 75)',
      '  --donors a,b,c  name donors explicitly, to model a tranche you already know.',
      '                  An id that names no creator is refused (exit 2), never skipped:',
      '                  a donor that clones nothing would still consume a slot and dilute',
      '                  the measured rate, over-stating how many creators fit.',
      '  --keep          leave both builds on disk for inspection',
      '',
      'exit 0 the tranche fits, 1 a figure refuses it, 2 the probe could not answer.',
    ].join('\n'),
  );
  process.exit(0);
}

function readDataset() {
  const dataset = {};
  for (const [key, file] of Object.entries(DATA_FILES)) {
    dataset[key] = JSON.parse(readFileSync(join(webRoot, 'src/data', file), 'utf8'));
  }
  return dataset;
}

/**
 * Build one arm with its dataset overlaid onto `src/data/`.
 *
 * The overlay is a Vite `resolveId` redirect installed by a throwaway config
 * that re-exports the real `astro.config.mjs`. Nothing in the working tree is
 * written, moved or restored, so a crashed run cannot leave a mutated dataset
 * behind -- which a write-then-restore approach can, and this worktree sits
 * beside others whose agents would inherit the mess.
 *
 * BOTH arms go through this path, including the one whose data is unchanged.
 * Identical machinery on both arms is what makes a difference between them
 * attributable to the records rather than to the mechanism.
 */
function buildArm(label, dataset) {
  const armDir = join(workRoot, label);
  const dataDir = join(armDir, 'data');
  const dist = join(armDir, 'dist');
  rmSync(armDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const overlay = {};
  for (const [key, file] of Object.entries(DATA_FILES)) {
    const target = join(dataDir, file);
    writeFileSync(target, JSON.stringify(dataset[key]));
    overlay[file] = target.replace(/\\/g, '/');
  }

  const configRel = `node_modules/.cache/asset-runway/${label}/astro.config.mjs`;
  writeFileSync(
    join(armDir, 'astro.config.mjs'),
    [
      `import base from ${JSON.stringify(pathToFileURL(join(webRoot, 'astro.config.mjs')).href)};`,
      `const OVERLAY = ${JSON.stringify(overlay)};`,
      'const plugin = {',
      "  name: 'asset-runway-overlay',",
      "  enforce: 'pre',",
      '  resolveId(source, importer) {',
      "    if (!importer) return null;",
      "    const from = importer.replace(/\\\\/g, '/');",
      "    if (!from.includes('/src/data/')) return null;",
      "    const name = source.replace(/\\\\/g, '/').split('/').pop();",
      '    return OVERLAY[name] ?? null;',
      '  },',
      '};',
      'const vite = base.vite ?? {};',
      'export default { ...base, vite: { ...vite, plugins: [plugin, ...(vite.plugins ?? [])] } };',
      '',
    ].join('\n'),
  );

  // Same pinned deploy environment `assets:report` uses, for the same reason:
  // the gate measures the /ModelTree/ base path, and BASE_URL leaking in from a
  // parent process would silently move every route's byte count.
  const { BASE_URL: _dropBaseUrl, ...inheritedEnv } = process.env;
  execFileSync(
    process.execPath,
    ['node_modules/astro/bin/astro.mjs', 'build', '--config', configRel, '--outDir', dist],
    {
      cwd: webRoot,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...inheritedEnv,
        NODE_ENV: 'production',
        BASE_PATH: '/ModelTree/',
        SITE_URL: 'https://abdeslam-menacere.github.io',
      },
    },
  );
  return dist;
}

const FIXED = [
  ['home', 'index.html'],
  ['catalog', 'models/index.html'],
  ['benchmarks', 'benchmarks/index.html'],
  ['tree', 'tree/index.html'],
  ['compare', 'compare/index.html'],
  ['updates', 'updates/index.html'],
];

/** Every figure that has a ceiling, read from the budget file rather than restated. */
function figuresFor(dist) {
  const caches = { importCache: new Map(), fontCache: new Map(), sizeCache: new Map() };
  const out = new Map();

  for (const [id, path] of FIXED) {
    const budget = budgets.fixedRoutes.find((r) => r.id === id);
    if (!budget) continue;
    out.set(`route:${id}`, {
      ceiling: budget.criticalMaxRaw,
      value: analyzeRoute(dist, path, caches).totals.critical.raw,
    });
  }

  for (const group of budgets.routeGroups) {
    const worst = groupWorst(dist, group.dir, caches);
    out.set(`group:${group.id}`, { ceiling: group.criticalMaxRaw, value: worst.totals.critical.raw });
    if (typeof group.jsMaxRaw === 'number') {
      out.set(`group:${group.id} js`, { ceiling: group.jsMaxRaw, value: worst.totals.js.raw });
    }
  }

  const totals = globalTotals(dist);
  const g = budgets.globals;
  out.set('global:js', { ceiling: g.jsTotalMaxRaw, value: totals.js });
  out.set('global:css', { ceiling: g.cssTotalMaxRaw, value: totals.css });
  out.set('global:font', { ceiling: g.fontTotalMaxRaw, value: totals.font });
  out.set('global:_astro dir', { ceiling: g.astroDirMaxRaw, value: totals.astroDir });

  return out;
}

const raw = readDataset();

// The tranche is constructed BEFORE either build, so a refusal costs no build
// time. It is wrapped because `buildTranche` refuses a donor id that names no
// creator: uncaught, that throw would leave node's default exit 1 -- the code
// this probe documents as "a figure refused the tranche", which is a
// measurement. A bad donor list is the probe declining to answer, so it is 2.
let armA;
let armB;
try {
  armA = buildTranche(raw, { creators: 0 });
  armB = buildTranche(raw, {
    creators: args.creators,
    donors: args.donors,
    percentile: args.percentile,
  });
} catch (error) {
  console.error(`asset-runway: ${error.message}`);
  console.error('  UNDETERMINED (exit 2): no tranche was built, so there is no rate and no runway.');
  process.exit(2);
}

console.log('ROUTE RUNWAY PROBE -- two full builds, this tree, this run.');
console.log(describeProvenance(probeTreeProvenance(webRoot)).join('\n'));
console.log(formatTrancheManifest(armB.manifest).join('\n'));

let distA;
let distB;
try {
  console.log('building arm A (dataset as committed) ...');
  distA = buildArm('arm-a', armA.dataset);
  console.log(`building arm B (+${args.creators} synthetic creator(s)) ...`);
  distB = buildArm('arm-b', armB.dataset);
} catch (error) {
  console.error('');
  console.error(`UNDETERMINED: an arm failed to build -- ${error.message}`);
  console.error('  A build failure is not a runway of zero and not a runway of infinity. Most likely');
  console.error('  the synthetic tranche was rejected by validateDataset, in which case the clone');
  console.error('  rules in dataset-tranche.mjs need a constraint added, not the budget relaxing.');
  process.exit(2);
}

const figuresA = figuresFor(distA);
const figuresB = figuresFor(distB);

const rows = [];
for (const [label, a] of figuresA) {
  const b = figuresB.get(label);
  if (!b) continue;
  rows.push(rateOf(label, a.ceiling, a.value, b.value, args.creators));
}

// The mechanism control: with no creators added the two arms must agree, byte
// for byte, on every figure. They are built by identical machinery from
// identical data, so a disagreement is the mechanism moving under its own
// feet -- and a rate measured on a mechanism that does that is noise.
if (args.creators === 0) {
  const moved = rows.filter((row) => row.delta !== 0);
  console.log('');
  console.log('MECHANISM CONTROL -- 0 creators requested, so the two arms must agree.');
  for (const row of moved) {
    console.log(`  ${row.label}: arm A ${row.baseline}, arm B ${row.tranche}, delta ${row.delta}`);
  }
  console.log(
    `  ${rows.length} figure(s) compared, ${rows.length - moved.length} identical, ${moved.length} moved.`,
  );
  if (!args.keep) rmSync(workRoot, { recursive: true, force: true });
  if (moved.length > 0) {
    console.log('  FAIL: the overlay is not reproducible, so no rate it produces is trustworthy.');
    process.exit(2);
  }
  console.log('  PASS: identical arms from identical data. The probe adds nothing of its own.');
  console.log('  This proves reproducibility ONLY. That the arms CAN differ is the separate');
  console.log('  control a real run makes, by refusing to report when no figure moves.');
  process.exit(0);
}

console.log(formatRunwayReport(rows, armB.manifest, args.creators).join('\n'));

const verdict = runwayVerdict(rows, args.creators);
if (args.keep) {
  console.log(`  builds kept: ${distA}`);
  console.log(`               ${distB}`);
} else {
  rmSync(workRoot, { recursive: true, force: true });
}

process.exit(verdict.code);
