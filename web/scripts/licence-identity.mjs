// The CLI behind `npm run licence:identity`, and the reporting half of #1057.
//
//   node scripts/licence-identity.mjs [--sweep <file>] [--report <file>] [--json <file>]
//
// Flags:
//   --sweep <file>   A sweep summary carrying `finalUrl` per licence URL. Its
//                    findings are what let this run classify the URL a request
//                    *landed on* rather than the URL a record cites. Optional,
//                    and its absence is reported rather than papered over.
//   --report <file>  Write the markdown report here as well as to stdout.
//   --json <file>    Write the machine summary here.
//   --help
//
// Exit 0 = ran, no disagreement. Exit 1 = ran, a record's `spdxId` contradicts
// the licence its URL identifies. Exit 2 = this script could not run, which is
// never treated as a pass.
//
// ## This makes no requests
//
// The check it drives is a pure offline function of `(spdxId, recordedUrl,
// finalUrl)` against a canonical-URL identity table -- the design adjudicated on
// #1057. It reads no licence document bodies and opens no sockets, so a network
// error and a licence mismatch can never arrive here wearing the same shape.
// `finalUrl` is consumed as an input from a run that already fetched; this
// script never fetches to obtain one.
//
// It drives the site's TypeScript through Vite rather than importing it as plain
// Node modules, for the reason `data-health.mjs` records: `src/data/dataset.ts`
// and `src/lib/licence-url-identity.ts` are TypeScript with extensionless
// imports, which Node's own loader will not resolve. `ssrLoadModule` loads them
// exactly the way the app does, so the report is computed over the same
// validated dataset the site renders rather than a second, drifting copy.
//
// ## A finding is reported, never repaired
//
// Nothing here writes to `web/src/data/`, and `--report` and `--json` refuse a
// path that resolves inside it -- the same refusal `check-licence-links.mjs`
// makes, for the same reason. Correcting an `spdxId` or repointing a record is a
// reviewed human edit; a comparator is not a reviewer.
//
// ## A green run is the expected result
//
// The checkable population is `Apache-2.0` and `MIT` cited at canonical URLs and
// it is already correct, so zero disagreements is this instrument confirming the
// population rather than failing to find work. The value is prospective: a
// future repoint to a live-but-wrong document, or a mistyped `spdxId`, stops
// being invisible. The rendered report says so in its own words, so that the
// zero cannot be read six months from now as evidence that this check is dead
// weight.

import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reportsDir = join(webRoot, 'reports');
const dataDir = join(webRoot, 'src', 'data');

function die(message) {
  process.stderr.write(`licence-identity: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { sweep: null, report: null, json: null, help: false };

  const value = (index, flag) => {
    const next = argv[index];
    if (typeof next !== 'string' || next.length === 0) die(`${flag} needs a value`);
    return next;
  };

  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--sweep') args.sweep = value((i += 1), '--sweep');
    else if (flag === '--report') args.report = value((i += 1), '--report');
    else if (flag === '--json') args.json = value((i += 1), '--json');
    else if (flag === '--help' || flag === '-h') args.help = true;
    else die(`unknown flag ${flag}`);
  }

  // Validated here rather than at write time so that a refused destination
  // costs nothing and, more importantly, cannot be reached after a partial
  // write: both outputs are settled before either is opened.
  if (args.report !== null) args.report = assertOutsideDataset(args.report, '--report');
  if (args.json !== null) args.json = assertOutsideDataset(args.json, '--json');

  return args;
}

/** Refuse any output path inside the dataset directory. */
function assertOutsideDataset(path, flag) {
  const absolute = resolve(process.cwd(), path);
  const rel = relative(dataDir, absolute);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    die(`${flag} would write inside ${dataDir}; this tool never mutates the dataset`);
  }
  return absolute;
}

/**
 * Pull `(url, finalUrl)` pairs out of a sweep summary.
 *
 * Accepts either a bare array or an object carrying `findings` or `results`,
 * because the sweep's own summary shape is not this script's to fix. An entry
 * without both fields is skipped rather than guessed at.
 */
export function extractFinalUrls(document) {
  const candidates = Array.isArray(document)
    ? document
    : Array.isArray(document?.findings)
      ? document.findings
      : Array.isArray(document?.results)
        ? document.results
        : [];

  const pairs = [];
  for (const entry of candidates) {
    const url = entry?.url ?? entry?.canonical;
    const finalUrl = entry?.finalUrl;
    if (typeof url !== 'string' || typeof finalUrl !== 'string') continue;
    if (url.length === 0 || finalUrl.length === 0) continue;
    pairs.push({ url, finalUrl });
  }
  return pairs;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
    process.stdout.write(`${source.split('\n\n')[0].replace(/^\/\/ ?/gm, '')}\n`);
    return 0;
  }

  let finalUrlPairs = [];
  if (args.sweep !== null) {
    const path = resolve(process.cwd(), args.sweep);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      die(`could not read the sweep summary at ${path}: ${error.message}`);
    }
    try {
      finalUrlPairs = extractFinalUrls(JSON.parse(text));
    } catch (error) {
      die(`the sweep summary at ${path} is not valid JSON: ${error.message}`);
    }
    process.stderr.write(
      `licence-identity: ${finalUrlPairs.length} licence URL(s) in ${args.sweep} carry a final URL\n`,
    );
  }

  const server = await createServer({
    root: webRoot,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  });

  let report;
  let markdown;
  try {
    const { dataset } = await server.ssrLoadModule('/src/data/dataset.ts');
    const { buildFinalUrlIndex, buildLicenceIdentityReport, renderLicenceIdentityMarkdown } =
      await server.ssrLoadModule('/src/lib/licence-url-identity.ts');

    report = buildLicenceIdentityReport(dataset.releases, buildFinalUrlIndex(finalUrlPairs));
    markdown = renderLicenceIdentityMarkdown(report);
  } finally {
    await server.close();
  }

  await mkdir(reportsDir, { recursive: true });
  const reportPath = args.report ?? join(reportsDir, 'licence-identity.md');
  const jsonPath = args.json ?? join(reportsDir, 'licence-identity.json');
  await writeFile(reportPath, markdown, 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const { coverage, tally } = report;
  const adjudicated = tally.agrees + tally.disagrees;
  process.stdout.write(
    `Licence URL identity cross-check (offline; no requests made): `
    + `${adjudicated} of ${coverage.checkable} checkable record(s) adjudicated — `
    + `${tally.agrees} agree, ${tally.disagrees} disagree; `
    + `${coverage.checkable - adjudicated} abstained with a named reason.\n`
    + `Coverage: ${coverage.checkable} of ${coverage.withUrl} swept licence URL(s) are cross-checkable at all; `
    + `${coverage.urlWithoutSpdxId} carry no spdxId, and a further ${coverage.spdxIdWithoutUrl} carry an spdxId `
    + `with no URL and are never swept.\n`
    + (report.classifiedAgainstFinalUrl === 0
      ? 'No fetch evidence was supplied: verdicts were taken on the URL each record cites, not on the URL a '
        + 'request for it lands on. A server-side repoint is invisible to a run in this mode.\n'
      : `${report.classifiedAgainstFinalUrl} record(s) classified against a fetched finalUrl; `
        + `${report.redirects} landed elsewhere.\n`),
  );

  if (tally.disagrees === 0) {
    process.stdout.write(
      'No disagreements. That is the expected result, not a null one: this check is prospective, and its value '
      + 'is that a future repoint or a mistyped spdxId stops being invisible.\n',
    );
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
  }

  return tally.disagrees > 0 ? 1 : 0;
}

/* c8 ignore start -- the module is imported by its tests; this runs only as a CLI. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`licence-identity: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
/* c8 ignore stop */

export { main };
