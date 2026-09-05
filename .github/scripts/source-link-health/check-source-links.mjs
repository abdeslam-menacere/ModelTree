#!/usr/bin/env node
// Reports the health of every primary source URL in the ModelTree dataset, and
// on a full sweep every `license.url` a release records as well.
//
//   node .github/scripts/source-link-health/check-source-links.mjs [flags]
//
// Flags:
//   --dry-run            Extract and de-duplicate targets; make no requests.
//   --baseline <file>    A previous sources.json. Only URLs this change added or
//                        re-pointed are checked, which is what makes a pull
//                        request run targeted rather than a full sweep.
//   --report <file>      Write the markdown report here as well as to stdout.
//   --json <file>        Write the machine summary here.
//   --concurrency <n>    Requests in flight across all hosts.
//   --attempts <n>       Attempts per URL, including the first.
//   --timeout <ms>       Per-attempt deadline.
//   --help
//
// Exit 0 = ran, nothing actionable. Exit 1 = ran, found something actionable.
// Exit 2 = the checker itself could not run, which is never treated as a pass.
//
// ## Why licence URLs are swept here and not on a pull request (ADR 0017, #931)
//
// A release's `license.url` is not a citation, so no registration rule covers
// it, and until #931 nothing in the repository fetched one: 57 records asserted
// a licence URL that no instrument had ever requested, and one of them had been
// a 404 since before it was recorded.
//
// The failure that produced that is *upstream decay* -- a URL that was live
// when a human verified it and died afterwards, with no change in this
// repository involved. A pull-request-scoped check inspects what a diff
// touches, so it is structurally incapable of catching decay: it would have
// been green on every run before the URL died and green on every run after.
// Only a check that re-asks the question on a clock closes that. So licence
// URLs are *requested* on the scheduled sweep and the manual dispatch, and on
// neither of those does a finding fail anything -- it is reported and filed.
//
// The mechanism is deliberately the absence of `--baseline` rather than a flag
// of its own. `--baseline` is passed on pull requests only and only ever
// narrows, so keying on it means there is no way to spell "sweep, but skip the
// licence URLs" -- the same reasoning that keeps `--data` and `--exclusions`
// off this CLI. A run that narrows is answerable for what the change
// introduced; a run that does not is answerable for everything.
//
// `--dry-run` is the exception, and it costs nothing. The workflow invokes it
// with no baseline, so it takes the full-sweep branch and extracts licence URLs
// on every run including a pull request -- which is safe precisely because it
// issues no request at all. That is what makes a malformed licence URL a
// pull-request-time failure while an unreachable one is not.
//
// There is deliberately no `--data`, no `--exclusions`, and no `--today`. Each
// would let a caller aim this at an emptier dataset, a more permissive
// exclusions file, or a date that un-expires an exclusion, and a green verdict
// about something other than the committed data is the one outcome this tool
// must not be able to produce. It follows `instruction-references` and
// `adr-numbers` in this repository, which take no arguments for the same reason,
// and there is no `--skip` or `--force`: a genuine exception is a reviewed
// exclusion, which carries a reason and two dates and is itself reviewable.
//
// `--baseline` only ever narrows, which is safe on a pull request -- the author
// is answerable for what they changed -- and would be a bypass on the scheduled
// sweep, so the workflow passes it on pull requests only and this script says
// loudly when it is narrowing.
//
// This script never writes to `web/src/data/`. That is not left to convention:
// an output path resolving inside the dataset is refused below. `lastCheckedDate`
// is a claim that a human verified a source, and a link checker is not a human.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyExclusions,
  checkAll,
  extractLicenceTargets,
  extractTargets,
  mergeTargets,
  parseExclusions,
  renderReport,
  selectChanged,
  summarise,
} from './link-health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** .github/scripts/source-link-health/check-source-links.mjs -> up three. */
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DATA_DIR = resolve(REPO_ROOT, 'web', 'src', 'data');
const SOURCES_FILE = resolve(DATA_DIR, 'sources.json');
const RELEASES_FILE = resolve(DATA_DIR, 'releases.json');
const EXCLUSIONS_FILE = resolve(HERE, 'exclusions.json');

function die(message) {
  process.stderr.write(`check-source-links: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    baseline: null,
    report: null,
    json: null,
    concurrency: undefined,
    attempts: undefined,
    timeoutMs: undefined,
    help: false,
  };

  // A flag whose value is missing is refused here rather than carried onward as
  // `undefined`, because every consumer turns `undefined` into a default -- so a
  // malformed command would silently check something the caller never asked
  // for. The idiom is the one `gate-dataset.mjs` already uses, copied rather
  // than varied.
  const value = (i, flag) => {
    const next = argv[i];
    if (typeof next !== 'string' || next.length === 0) die(`${flag} needs a value`);
    return next;
  };

  const count = (i, flag) => {
    const raw = value(i, flag);
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) die(`${flag} needs a positive whole number, got ${raw}`);
    return parsed;
  };

  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--baseline') args.baseline = value((i += 1), '--baseline');
    else if (flag === '--report') args.report = value((i += 1), '--report');
    else if (flag === '--json') args.json = value((i += 1), '--json');
    else if (flag === '--concurrency') args.concurrency = count((i += 1), '--concurrency');
    else if (flag === '--attempts') args.attempts = count((i += 1), '--attempts');
    else if (flag === '--timeout') args.timeoutMs = count((i += 1), '--timeout');
    else if (flag === '--help' || flag === '-h') args.help = true;
    else die(`unknown flag ${flag}`);
  }

  return args;
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    die(`could not read ${label} at ${path}: ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    die(`${label} at ${path} is not valid JSON: ${error.message}`);
  }
}

/** Refuse any output path inside the dataset directory. */
function assertOutsideDataset(path, flag) {
  const absolute = resolve(process.cwd(), path);
  const rel = relative(DATA_DIR, absolute);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    die(`${flag} would write inside ${DATA_DIR}; this tool never mutates the dataset`);
  }
  return absolute;
}

function write(path, contents, flag) {
  const absolute = assertOutsideDataset(path, flag);
  try {
    writeFileSync(absolute, contents, 'utf8');
  } catch (error) {
    die(`could not write ${flag} to ${absolute}: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0].replace(/^\/\/ ?/gm, ''));
    process.stdout.write('\n');
    return 0;
  }

  const records = readJson(SOURCES_FILE, 'the source records');
  if (!Array.isArray(records)) die(`${SOURCES_FILE} is not a JSON array`);

  const { targets: sourceTargets, malformed } = extractTargets(records);

  let scope = 'the full seed dataset';
  let targets = sourceTargets;
  let selected;
  let licenceUrls = 0;

  if (args.baseline === null) {
    // A full sweep, so the licence URLs join it. See the note at the head of
    // this file for why they are here and nowhere else.
    const releases = readJson(RELEASES_FILE, 'the release records');
    if (!Array.isArray(releases)) die(`${RELEASES_FILE} is not a JSON array`);

    const licence = extractLicenceTargets(releases);
    malformed.push(...licence.malformed);
    targets = mergeTargets(sourceTargets, licence.targets);
    licenceUrls = licence.targets.length;
    selected = targets;
    scope = 'the full seed dataset, including every licence URL a release records';

    process.stderr.write(
      `check-source-links: ${sourceTargets.length} source URL(s) and ${licenceUrls} licence URL(s) ` +
        `merge to ${targets.length} unique URL(s)\n`,
    );
  } else {
    const baseline = readJson(resolve(process.cwd(), args.baseline), 'the baseline source records');
    if (!Array.isArray(baseline)) die('the baseline source records file is not a JSON array');
    selected = selectChanged(sourceTargets, baseline);
    scope = 'the source URLs this change added or re-pointed';
    process.stderr.write(
      `check-source-links: narrowed by --baseline to ${selected.length} of ${sourceTargets.length} URL(s); ` +
        'this run is not a full sweep and requests no licence URL\n',
    );
  }

  const exclusionsDocument = readJson(EXCLUSIONS_FILE, 'the reviewed exclusions');
  const { entries, errors } = parseExclusions(exclusionsDocument);
  if (errors.length > 0) {
    // Refusing rather than dropping the bad entries: an exclusions file is the
    // one input here whose mistakes make the checker quieter, so it must not be
    // able to degrade into "checked nothing, found nothing, green".
    for (const error of errors) process.stderr.write(`check-source-links: ${EXCLUSIONS_FILE}: ${error}\n`);
    return 2;
  }

  const today = new Date().toISOString().slice(0, 10);
  const { checked, excluded, unmatched } = applyExclusions(selected, entries, today);

  if (args.dryRun) {
    // The extraction dry run: what would be requested, and for which records,
    // without a single request leaving the machine.
    const lines = [
      '## Source link health — extraction dry run',
      '',
      `${records.length} source record(s) and ${licenceUrls} licence URL(s) reduce to ${targets.length} unique URL(s).`,
      `${checked.length} would be requested; ${excluded.length} are covered by a live reviewed exclusion.`,
      '',
    ];

    for (const target of checked) {
      lines.push(`- \`${target.canonical}\` — ${target.recordIds.map((id) => `\`${id}\``).join(', ') || '_no id_'}`);
    }

    if (malformed.length > 0) {
      lines.push('', `### Records that could not be turned into a request (${malformed.length})`, '');
      for (const entry of malformed) lines.push(`- \`${entry.where}\` — ${entry.reason}`);
    }

    const report = `${lines.join('\n')}\n`;
    process.stdout.write(report);
    if (args.report !== null) write(args.report, report, '--report');
    if (args.json !== null) {
      write(
        args.json,
        `${JSON.stringify(
          {
            dryRun: true,
            recordCount: records.length,
            uniqueUrls: targets.length,
            licenceUrls,
            wouldRequest: checked.length,
            excluded: excluded.length,
            malformed: malformed.length,
          },
          null,
          2,
        )}\n`,
        '--json',
      );
    }

    return malformed.length > 0 ? 1 : 0;
  }

  const results = await checkAll(checked, {
    concurrency: args.concurrency,
    attempts: args.attempts,
    timeoutMs: args.timeoutMs,
  });

  const report = `${renderReport(results, {
    excluded,
    malformed,
    unmatchedExclusions: unmatched,
    scope,
  })}\n`;

  const summary = summarise(results, {
    scope,
    recordCount: records.length,
    uniqueUrls: targets.length,
    licenceUrls,
    excludedUrls: excluded.length,
    malformedRecords: malformed.length,
    generatedAt: new Date().toISOString(),
    findings: results
      .filter((result) => result.state === 'broken' || result.state === 'redirected' || result.expiredExclusion !== undefined)
      .map((result) => ({
        url: result.canonical,
        state: result.state,
        status: result.status,
        finalUrl: result.finalUrl,
        recordIds: result.recordIds,
        // The subset of `recordIds` that named this URL as `license.url` rather
        // than citing it as a source. Kept separate so the maintenance issue
        // can label each provenance correctly instead of calling a release a
        // source record.
        licenceRecordIds: result.licenceRecordIds ?? [],
        title: result.titles[0] ?? null,
        exclusionExpiredOn: result.expiredExclusion?.expiresOn ?? null,
      })),
  });

  process.stdout.write(report);
  if (args.report !== null) write(args.report, report, '--report');
  if (args.json !== null) write(args.json, `${JSON.stringify(summary, null, 2)}\n`, '--json');

  // Malformed records are the dataset's problem rather than the network's, so
  // they count as actionable too: a source record with an unusable URL is a
  // citation nobody can follow.
  return summary.actionableUrls > 0 || malformed.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`check-source-links: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  },
);
