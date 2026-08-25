#!/usr/bin/env node
// The approved-source binding, and the skill set's equivalent of
// `tools/updater/src/modeltree_updater/gates.py`'s `source-approval` gate
// (`_claim_source_approval_issues`). ADR 0003 names it as precondition 2.
//
// The rule, in one sentence: **a run may rest a claim only on trust it
// inherited, never on trust it granted itself.**
//
// Why this cannot be left to the other checks. `sources.json` is one of the nine
// documents a refresh may patch, and both `npm run validate` and
// `gate-dataset.mjs` check citations *referentially* - that a cited id resolves
// to a record in the dataset. A run that adds a source record and cites it in
// the same change satisfies that perfectly while citing something nobody
// approved. Referential integrity proves the citation resolves; it cannot prove
// the thing cited was ever trusted. This gate is the difference.
//
// Where trust comes from, and why neither anchor is writable by the run:
//
//   1. `web/src/data/sources.json` **as committed at `--base`** - every source
//      that reached the base ref did so through a merged, reviewed change.
//      Read from git, never from the working tree, because the working tree is
//      what the run is about to write. Reading the file on disk would let a run
//      apply its own patch and then be approved by it, which does not close the
//      circle, it just moves it.
//   2. `tools/updater/profiles/**/*.json` `source_catalog[].url` - the reviewed
//      catalogues. `gate-scope.mjs` refuses any change touching
//      `tools/updater/`, so a refresh cannot edit this anchor at all.
//
// Trust attaches to an **origin** (scheme + host), not to a URL, exactly as the
// Python side's `is_newly_discovered` does. A creator announcing a new model on
// a new page of its own newsroom is the ordinary case and the whole point of the
// refresh; a source appearing on a host nobody ever stood behind is the case
// this gate exists to refuse. `sources.json` records one entry per page - 47 of
// them across 13 hosts - so a rule phrased as "no new source record" would stop
// the refresh recording any release at all, while a rule phrased as "no new
// origin" stops precisely the substitution that matters.
//
// This is deliberately **stricter** than `gates.py`, which also approves a newly
// discovered source on an unknown origin once the panel votes for it. Under ADR
// 0003 no human sees the merge, so a run's own panel approving a source the same
// run introduced is the run approving itself. ADR 0003 permits the publishing
// path to be stricter and forbids it being more permissive; extending the trust
// boundary to a new host therefore stays a human act. The `type` field that
// `PRIMARY_SOURCE_TYPES` consults is likewise run-authored, and is left as-is
// here on purpose: this gate constrains *where a source may come from*, which is
// the part a run cannot honestly self-certify, rather than trying to referee a
// label it would only be checking against itself.
//
// Usage:
//   node gate-source-approval.mjs --claims <path> [--base <ref>] [--repo <dir>] [--json]
//
// `--base` names a git ref, not a file: it defaults to `HEAD` and selects the
// committed tree the run started from. Pass the merge base when gating a branch
// that already carries the run's commit. It is not a bypass - moving the anchor
// means committing the source to a ref first, which is the auditable path ADR
// 0003 asks for. There is no `--force`, no `--skip`, and no environment
// variable; an unrecognised flag exits 2.
//
// Exit 0 = every citation rests on inherited trust. Exit 1 = at least one does
// not. Exit 2 = the gate could not run, which is never treated as a pass.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASET_SOURCES = 'web/src/data/sources.json';
const PROFILE_DIR = 'tools/updater/profiles';

const GATE = 'source-approval';

const failures = [];

function fail(message, where) {
  failures.push({ gate: GATE, message, where });
}

function parseArgs(argv) {
  const args = { claims: null, base: 'HEAD', repo: null, json: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--claims') args.claims = argv[++i];
    else if (flag === '--base') args.base = argv[++i];
    else if (flag === '--repo') args.repo = argv[++i];
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`gate-source-approval: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

/** The repository root, found from this script's own location. */
function repoRoot() {
  // .github/skills/modeltree-gates/scripts/gate-source-approval.mjs -> up five.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** `scheme://host`, lowercased. `null` when the value is not a parseable URL. */
function originOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Every origin the committed dataset already stands behind. */
function datasetAnchor(cwd, base) {
  let raw;
  try {
    raw = git(cwd, 'show', `${base}:${DATASET_SOURCES}`);
  } catch (error) {
    throw new Error(`cannot read ${DATASET_SOURCES} at ${base}: ${error.message.trim()}`);
  }

  let records;
  try {
    records = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${DATASET_SOURCES} at ${base} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(records)) {
    throw new Error(`${DATASET_SOURCES} at ${base} is not an array of sources`);
  }

  const byId = new Map();
  for (const record of records) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue;
    byId.set(record.id, record);
  }
  return byId;
}

/** Every origin a reviewed creator profile configured. */
function catalogAnchor(cwd, base) {
  let listing;
  try {
    listing = git(cwd, 'ls-tree', '-r', '--name-only', base, '--', PROFILE_DIR);
  } catch {
    // The profiles are an additive anchor. Their absence is reported in the
    // output rather than guessed at, and the dataset anchor still applies.
    return { files: [], urls: [] };
  }

  const files = listing.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.json'));
  const urls = [];
  for (const file of files) {
    let profile;
    try {
      profile = JSON.parse(git(cwd, 'show', `${base}:${file}`));
    } catch {
      continue;
    }
    const catalog = profile?.source_catalog;
    if (!Array.isArray(catalog)) continue;
    for (const entry of catalog) {
      if (entry !== null && typeof entry === 'object' && typeof entry.url === 'string') urls.push(entry.url);
    }
  }
  return { files, urls };
}

/**
 * The sources this bundle proposes to write, by target id.
 *
 * These are candidates, never anchors: nothing here contributes an approved
 * origin. That asymmetry is the entire gate.
 */
function proposedSources(claims) {
  const proposed = new Map();
  claims.forEach((claim, index) => {
    if (claim === null || typeof claim !== 'object' || claim.collection !== 'sources') return;
    const id = typeof claim.targetId === 'string' ? claim.targetId : null;
    const where = `claim:${claim.id ?? `#${index}`}`;

    if (claim.kind === 'add') {
      const url = claim.proposedValue?.url;
      if (id === null) return;
      if (typeof url !== 'string' || url.length === 0) {
        fail(`proposes source "${id}" with no url, so there is no origin to approve`, where);
        return;
      }
      proposed.set(id, { url, where });
    } else if (claim.kind === 'change' && claim.field === 'url') {
      if (id === null) return;
      if (typeof claim.proposedValue !== 'string' || claim.proposedValue.length === 0) {
        fail(`repoints source "${id}" at a url that is not a string`, where);
        return;
      }
      proposed.set(id, { url: claim.proposedValue, where });
    }
  });
  return proposed;
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'usage: gate-source-approval.mjs --claims <path> [--base <ref>] [--repo <dir>] [--json]\n',
    );
    return 0;
  }
  if (!args.claims) {
    process.stderr.write('gate-source-approval: --claims <path> is required\n');
    return 2;
  }
  if (typeof args.base !== 'string' || args.base.length === 0) {
    process.stderr.write('gate-source-approval: --base needs a git ref\n');
    return 2;
  }

  const cwd = args.repo ? resolve(args.repo) : repoRoot();
  if (!existsSync(cwd)) {
    process.stderr.write(`gate-source-approval: no directory at ${cwd}\n`);
    return 2;
  }

  const bundlePath = resolve(args.claims);
  if (!existsSync(bundlePath)) {
    process.stderr.write(`gate-source-approval: no claim bundle at ${bundlePath}\n`);
    return 2;
  }

  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch (error) {
    process.stderr.write(`gate-source-approval: ${bundlePath} is not valid JSON: ${error.message}\n`);
    return 2;
  }

  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    process.stderr.write(`gate-source-approval: ${bundlePath} is not a claim bundle object\n`);
    return 2;
  }
  if (!Array.isArray(bundle.claims)) {
    process.stderr.write('gate-source-approval: bundle has no claims array\n');
    return 2;
  }

  let baseline;
  let catalog;
  try {
    baseline = datasetAnchor(cwd, args.base);
    catalog = catalogAnchor(cwd, args.base);
  } catch (error) {
    process.stderr.write(`gate-source-approval: ${error.message}\n`);
    return 2;
  }

  const approvedOrigins = new Set();
  for (const record of baseline.values()) {
    const origin = originOf(record.url);
    if (origin) approvedOrigins.add(origin);
  }
  for (const url of catalog.urls) {
    const origin = originOf(url);
    if (origin) approvedOrigins.add(origin);
  }

  // A gate with no trust anchor cannot judge anything, and an empty approved set
  // would refuse every citation for the wrong reason. Neither is a pass.
  if (approvedOrigins.size === 0) {
    process.stderr.write(
      `gate-source-approval: no approved origin at ${args.base} - neither ${DATASET_SOURCES} nor `
      + `${PROFILE_DIR} yielded one, so there is nothing to check against\n`,
    );
    return 2;
  }

  const proposed = proposedSources(bundle.claims);

  // A source this run proposes may not extend the trust boundary. Without this
  // the gate would only be deferred by one run: a first refresh banks an
  // unapproved origin into `sources.json`, and the next one cites it as
  // inherited trust.
  for (const [id, { url, where }] of proposed) {
    const origin = originOf(url);
    if (origin === null) {
      fail(`proposes source "${id}" with url "${url}", which is not a parseable URL`, where);
    } else if (!approvedOrigins.has(origin)) {
      fail(
        `proposes source "${id}" on origin ${origin}, which no reviewed profile catalogue and no `
        + `source already in the dataset stands behind; a run cannot approve its own source`,
        where,
      );
    }
  }

  const inherited = new Set();
  const cited = new Set();
  let citations = 0;

  bundle.claims.forEach((claim, index) => {
    if (claim === null || typeof claim !== 'object') return;
    const where = `claim:${claim.id ?? `#${index}`}`;
    if (!Array.isArray(claim.evidence)) return;

    claim.evidence.forEach((item, position) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return;
      const at = `${where}#evidence[${position}]`;
      citations += 1;

      const sourceId = item.sourceId;
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        fail('carries no sourceId, so nothing says which source it rests on', at);
        return;
      }
      cited.add(sourceId);

      const proposal = proposed.get(sourceId);
      const record = baseline.get(sourceId);
      if (proposal === undefined && record === undefined) {
        fail(
          `rests on source "${sourceId}", which is neither in the dataset at ${args.base} nor `
          + `proposed by this bundle, so nothing approved it`,
          at,
        );
        return;
      }
      if (proposal === undefined) inherited.add(sourceId);

      // A proposed source is judged on its proposed url; an inherited one on the
      // url it was merged with.
      const sourceUrl = proposal ? proposal.url : record.url;
      const sourceOrigin = originOf(sourceUrl);
      if (sourceOrigin === null) {
        fail(`rests on source "${sourceId}", whose url "${sourceUrl}" is not a parseable URL`, at);
        return;
      }
      if (!approvedOrigins.has(sourceOrigin)) {
        fail(
          `rests on source "${sourceId}" on origin ${sourceOrigin}, which this run did not `
          + `inherit and cannot approve for itself`,
          at,
        );
      }

      // The page actually read has to be the source it is filed under. Otherwise
      // an approved id becomes a label a run can staple onto anything.
      const readOrigin = originOf(item.url);
      if (readOrigin === null) {
        fail(
          `was read from "${item.url ?? 'missing'}", which is not a parseable URL, so the origin `
          + `it came from cannot be checked`,
          at,
        );
      } else if (readOrigin !== sourceOrigin) {
        fail(
          `was read from ${readOrigin} but is filed under source "${sourceId}", which is `
          + `${sourceOrigin}; evidence must come from the source it cites`,
          at,
        );
      }
    });
  });

  const result = {
    bundle: bundlePath,
    runId: bundle.runId ?? null,
    creator: bundle.creator ?? null,
    base: args.base,
    anchors: {
      datasetSources: baseline.size,
      profileCatalogues: catalog.files.length,
      approvedOrigins: [...approvedOrigins].sort(),
    },
    citations,
    citedSources: [...cited].sort(),
    inheritedSources: [...inherited].sort(),
    proposedSources: [...proposed.keys()].sort(),
    passed: failures.length === 0,
    failures,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (failures.length === 0) {
    process.stdout.write(
      `gate-source-approval: ${citations} citation(s) rest on approved sources `
      + `(${inherited.size} inherited from the dataset at ${args.base}, ${proposed.size} proposed `
      + `on ${approvedOrigins.size} already-trusted origin(s))\n`,
    );
  } else {
    process.stdout.write(`gate-source-approval: ${failures.length} failure(s)\n`);
    for (const failure of failures) {
      process.stdout.write(`  [${failure.gate}] ${failure.where}: ${failure.message}\n`);
    }
  }

  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
