#!/usr/bin/env node
// Reports whether the licence URLs a pull request *introduces* resolve, at the
// moment they are introduced. It is a separate instrument from the scheduled
// sweep in `check-source-links.mjs` and it never replaces or narrows it.
//
//   node .github/scripts/source-link-health/check-licence-links.mjs --baseline <file> [flags]
//
// Flags:
//   --baseline <file>    REQUIRED. A previous `releases.json`. Only the licence
//                        URLs this change added or re-pointed are requested.
//   --dry-run            Report what would be requested; make no requests.
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
// ## Why this exists, and why it is a separate file (ADR 0019, #957)
//
// ADR 0017 decided that a release's `license.url` is swept on the clock and
// never on a pull request, and listed the resulting gap among its own costs: a
// pull request that introduces an *already dead* licence URL is not caught at
// introduction. It asked for that to be argued on its own merits rather than
// smuggled in beside the decay fix. ADR 0019 is that argument, and it
// supersedes exactly one clause of ADR 0017 -- "a pull-request run must never
// request a licence URL" -- leaving every other part of that decision standing.
//
// Two measurements decided it, both taken on the committed history rather than
// estimated:
//
//   * **Cost.** Over the 50 analysable commits touching `releases.json`, the
//     net-new third-party requests this check adds -- licence URLs introduced or
//     re-pointed, minus those the source run already requests in the same commit
//     -- total 28. That is 0.56 per `releases.json`-touching commit, 0.09 per
//     commit overall, and **zero for 37 of those 50 commits**. ADR 0017's fear
//     that this "asks third-party servers on every data pull request" is
//     measurably not what it costs.
//   * **Actionability.** The state that matters here is a licence URL pointing
//     at a file that does not exist inside a repository that does. On
//     `huggingface.co` that answers **404**, cleanly distinct from the **401**
//     that a non-existent repository answers and from the **200** that a gated
//     but real model answers. The known counter-example -- a Space, where a
//     gated-but-real path and an invented one answer 401 with byte-identical
//     29-byte bodies -- is real and is why no probe here reasons from a status
//     code alone. It applies to **0 of this dataset's 41 licence URLs**; none is
//     a Space.
//
// ## The three properties that keep this safe
//
// **`--baseline` is mandatory, so this instrument has no full-sweep mode at
// all.** That is structural rather than conventional: there is no argument, and
// no combination of arguments, that makes this file request the whole dataset.
// It therefore cannot become a second sweep, cannot be aimed at the scheduled
// one, and cannot be the thing that narrows it. ADR 0017's guardrail -- no flag
// may narrow a scheduled sweep -- is untouched because the sweep lives in
// another file that this one does not import from, call, or configure.
//
// **A rate limit is not a finding.** `ACTIONABLE_STATES` is imported from
// `link-health.mjs` rather than restated, so `blocked`, `transient` and
// `normalised` are outside it here for exactly the reasons they are outside it
// there. A 429 from Hugging Face, an anti-bot 403 from GitHub, a timeout and a
// 5xx all classify out by construction and cannot reach the exit code.
//
// **This reports one provenance and never the other.** Every record id it names
// reached it through `license.url`, so the report says "named as `license.url`
// by" and never "affected source records". A release is not a source record, and
// the sweep's union of the two provenances (`recordIds` against
// `licenceRecordIds`) has no analogue here because there is nothing to union.
//
// A finding never edits the dataset. This script refuses an output path that
// resolves inside `web/src/data/`, exactly as the sweep does: `verifiedAt` is a
// claim that a human looked, and a link checker is not a human. The repair for a
// dead licence URL is a reviewed human edit re-pointing the record.
//
// ## Not-looked and looked-and-found-nothing stay apart (ADR 0018)
//
// A pull request touching no licence URL and a pull request whose introduced
// licence URLs all resolve are different outcomes, and this tool refuses to
// render them the same way. `introducedUrls` is the denominator and is reported
// beside `checkedUrls` in both the markdown and the JSON, so "0 of 0" is never
// readable as a clean bill of health for a set that was never examined.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIONABLE_STATES,
  BLOCKED,
  BROKEN,
  TRANSIENT,
  applyExclusions,
  checkAll,
  extractLicenceTargets,
  parseExclusions,
  selectChanged,
  summarise,
} from './link-health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** .github/scripts/source-link-health/check-licence-links.mjs -> up three. */
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DATA_DIR = resolve(REPO_ROOT, 'web', 'src', 'data');
const RELEASES_FILE = resolve(DATA_DIR, 'releases.json');
const EXCLUSIONS_FILE = resolve(HERE, 'exclusions.json');

function die(message) {
  process.stderr.write(`check-licence-links: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    baseline: null,
    dryRun: false,
    report: null,
    json: null,
    concurrency: undefined,
    attempts: undefined,
    timeoutMs: undefined,
    help: false,
  };

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
    if (flag === '--baseline') args.baseline = value((i += 1), '--baseline');
    else if (flag === '--dry-run') args.dryRun = true;
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

/**
 * Reduce baseline release records to the shape `selectChanged` compares against.
 *
 * `selectChanged` keys on the (record id, canonical URL) pair and reads the URL
 * from `record.url`, because it was written for source records. Mapping the
 * baseline into that shape reuses the rule verbatim rather than reimplementing
 * it, which matters: re-pointing an existing release at a new licence URL must
 * count as introduced, while a release whose licence *name* changed and whose
 * URL did not must not. A record carrying no `license.url` maps to `undefined`,
 * which `canonicaliseUrl` rejects and `selectChanged` skips.
 */
export function baselineLicencePairs(records) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => ({ id: record?.id, url: record?.license?.url }));
}

/**
 * The markdown report.
 *
 * Deliberately not `renderReport` from `link-health.mjs`. That one is titled
 * "Source link health" and speaks of affected *source records*; every id here
 * arrived through `license.url` and calling it a source record is the
 * entity-boundary error ADR 0017 guards against.
 */
function render({ introduced, results, excluded, scope }) {
  const summary = summarise(results);
  const byState = (state) => results.filter((result) => result.state === state);
  const lines = ['## Licence link introduction check', ''];

  if (introduced === 0) {
    lines.push(
      'This pull request introduces or re-points **no** `license.url`, so no licence URL was requested.',
      '',
      'That is a statement about scope, not a clean bill of health: nothing was examined, ' +
        'and the licence URLs already in the dataset are the scheduled sweep\'s business (ADR 0017).',
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    `Requested ${summary.checkedUrls} of the ${introduced} licence URL(s) ${scope}. ` +
      `${summary.actionableUrls} need attention. ` +
      `${byState(BLOCKED).length} were refused by the site and ${byState(TRANSIENT).length} gave no answer; ` +
      'neither is evidence that a licence URL has rotted, and neither counts as a finding.',
    '',
    'Nothing in `web/src/data/` was changed by this check, and nothing will be: ' +
      'a dead licence URL is repaired by a reviewed human edit re-pointing the record.',
    '',
  );

  const trouble = results.filter((result) => ACTIONABLE_STATES.has(result.state));
  if (trouble.length > 0) {
    lines.push(`### Introduced licence URLs that need attention (${trouble.length})`, '');
    for (const result of trouble) {
      const named = result.licenceRecordIds ?? result.recordIds ?? [];
      const detail =
        result.state === BROKEN
          ? `\`${result.status ?? 'no status'}\``
          : `permanently moved to \`${result.finalUrl ?? 'unknown'}\``;
      lines.push(
        `- \`${result.canonical}\` — ${detail}`,
        `  - named as \`license.url\` by ${named.map((id) => `\`${id}\``).join(', ') || '_no id_'}`,
      );
    }
    lines.push('');
  }

  const quiet = results.filter((result) => !ACTIONABLE_STATES.has(result.state));
  if (quiet.length > 0) {
    lines.push(`### Introduced licence URLs that raised nothing (${quiet.length})`, '');
    for (const result of quiet) {
      lines.push(`- \`${result.canonical}\` — ${result.state}${result.status === null ? '' : ` (${result.status})`}`);
    }
    lines.push('');
  }

  if (excluded.length > 0) {
    lines.push(`### Covered by a live reviewed exclusion (${excluded.length})`, '');
    for (const target of excluded) lines.push(`- \`${target.canonical}\``);
    lines.push('');
  }

  lines.push(
    '_Advisory. This check reports what a pull request introduces; it is not a required check ' +
      'and the scheduled decay sweep is unaffected by it._',
    '',
  );

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0].replace(/^\/\/ ?/gm, ''));
    process.stdout.write('\n');
    return 0;
  }

  // The one argument without which this tool does not run. Refusing here rather
  // than defaulting to the whole dataset is the property that keeps this from
  // becoming a second sweep: there is no such thing as an unnarrowed run of this
  // file, so there is nothing for a caller to widen by omission.
  if (args.baseline === null) {
    die('--baseline is required; this checker only ever reports on what a change introduced, and has no full-sweep mode (ADR 0019)');
  }

  const releases = readJson(RELEASES_FILE, 'the release records');
  if (!Array.isArray(releases)) die(`${RELEASES_FILE} is not a JSON array`);

  const baseline = readJson(resolve(process.cwd(), args.baseline), 'the baseline release records');
  if (!Array.isArray(baseline)) die('the baseline release records file is not a JSON array');

  const { targets, malformed } = extractLicenceTargets(releases);
  const introduced = selectChanged(targets, baselineLicencePairs(baseline));
  const scope = 'this change introduced or re-pointed';

  process.stderr.write(
    `check-licence-links: ${introduced.length} of ${targets.length} licence URL(s) were introduced or re-pointed ` +
      `by this change; ${targets.length - introduced.length} untouched URL(s) are the scheduled sweep's business\n`,
  );

  // Malformed licence URLs are reported for transparency and deliberately do not
  // reach the exit code. `extractLicenceTargets` collects them across the whole
  // dataset, before the narrowing above, so keying red on them would fail every
  // pull request for one pre-existing bad record -- the same reasoning the sweep
  // applies to malformed source records. A licence URL that this change makes
  // malformed is already a pull-request failure, caught for free and with no
  // request at all by the `--dry-run` step in `source-link-health-tests`.
  if (malformed.length > 0) {
    process.stderr.write(
      `check-licence-links: ${malformed.length} release(s) carry a licence url that cannot be requested at all; ` +
        'these are reported by the dry-run extraction step and are not this check\'s to act on\n',
    );
  }

  const exclusionsDocument = readJson(EXCLUSIONS_FILE, 'the reviewed exclusions');
  const { entries, errors } = parseExclusions(exclusionsDocument);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`check-licence-links: ${EXCLUSIONS_FILE}: ${error}\n`);
    return 2;
  }

  const today = new Date().toISOString().slice(0, 10);
  const { checked, excluded } = applyExclusions(introduced, entries, today);

  if (args.dryRun) {
    const lines = [
      '## Licence link introduction check — dry run',
      '',
      `${introduced.length} of ${targets.length} licence URL(s) were introduced or re-pointed by this change.`,
      `${checked.length} would be requested; ${excluded.length} are covered by a live reviewed exclusion.`,
      '',
    ];
    for (const target of checked) {
      lines.push(
        `- \`${target.canonical}\` — named as \`license.url\` by ` +
          `${(target.licenceRecordIds ?? []).map((id) => `\`${id}\``).join(', ') || '_no id_'}`,
      );
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
            totalLicenceUrls: targets.length,
            introducedUrls: introduced.length,
            wouldRequest: checked.length,
            excluded: excluded.length,
            malformedRecords: malformed.length,
            checkedUrls: 0,
            actionableUrls: 0,
            findings: [],
          },
          null,
          2,
        )}\n`,
        '--json',
      );
    }
    return 0;
  }

  const results = await checkAll(checked, {
    concurrency: args.concurrency,
    attempts: args.attempts,
    timeoutMs: args.timeoutMs,
  });

  const report = `${render({ introduced: introduced.length, results, excluded, scope })}\n`;

  const summary = summarise(results, {
    scope,
    // The denominator, carried so that "requested 0" is readable as "there was
    // nothing to request" rather than as "everything passed" (ADR 0018).
    totalLicenceUrls: targets.length,
    introducedUrls: introduced.length,
    excludedUrls: excluded.length,
    malformedRecords: malformed.length,
    generatedAt: new Date().toISOString(),
    findings: results
      .filter((result) => ACTIONABLE_STATES.has(result.state))
      .map((result) => ({
        url: result.canonical,
        state: result.state,
        status: result.status,
        finalUrl: result.finalUrl,
        // One provenance only. Every id here reached this tool through
        // `license.url`, so there is no union to report and no source record to
        // confuse it with.
        licenceRecordIds: result.licenceRecordIds ?? result.recordIds ?? [],
      })),
  });

  process.stdout.write(report);
  if (args.report !== null) write(args.report, report, '--report');
  if (args.json !== null) write(args.json, `${JSON.stringify(summary, null, 2)}\n`, '--json');

  return summary.actionableUrls > 0 ? 1 : 0;
}

/* c8 ignore start -- the module is imported by its tests; this runs only as a CLI. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`check-licence-links: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
/* c8 ignore stop */

export { main, render };
