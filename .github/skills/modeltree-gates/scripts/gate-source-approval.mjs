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
//   1. `web/src/data/sources.json` **as committed at the anchor commit** - every
//      source that reached it did so through a merged, reviewed change. Read
//      from git, never from the working tree, because the working tree is what
//      the run is about to write. Reading the file on disk would let a run apply
//      its own patch and then be approved by it, which does not close the
//      circle, it just moves it.
//   2. `tools/updater/profiles/**/*.json` `source_catalog[].url` - the reviewed
//      catalogues. `gate-scope.mjs` refuses any change touching
//      `tools/updater/`, so a refresh cannot edit this anchor at all.
//
// **Which commit is the anchor is not the run's choice to make.** Anchor 2 is
// unforgeable because the scope gate bars the path outright, but anchor 1 is a
// file the refresh is explicitly allowed to patch; the only thing that makes it
// safe is being read at a commit the run did not author. So the anchor is
// computed, not supplied: `git merge-base HEAD refs/remotes/origin/main`, the
// point at which this branch left published history. A run that commits its
// source and then invokes the gate moves `HEAD`, but the merge base stays where
// it was, so the committed-then-cited source is not in the anchor tree and is
// refused exactly as an uncommitted one is. Defaulting the anchor to `HEAD`
// would have left the whole gate resting on the caller passing the right ref,
// and the caller is the agent under test.
//
// `refs/remotes/origin/main` is what the remote says `main` is. A run cannot
// move it without pushing to a protected branch, which is the auditable path ADR
// 0003 asks for. A stale one only moves the anchor *backwards*, which narrows
// trust and is safe; a missing one - a shallow or single-branch clone - is a
// gate that cannot run, so it exits 2 rather than guessing.
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
// `--base` is optional and can only ever **narrow**. The anchor is the merge
// base with `refs/remotes/origin/main` whether or not it is passed; supplying it
// pins an older commit that is already an ancestor of that merge base, which is
// useful for re-gating an older bundle. A ref that is not an ancestor of the
// merge base - anything this branch authored, `HEAD` included - exits 2. Making
// the flag *required* rather than narrowing would not have helped: a required
// value is still a value the agent under test supplies. There is no `--force`,
// no `--skip`, and no environment variable; an unrecognised flag exits 2.
//
// Exit 0 = every citation rests on inherited trust. Exit 1 = at least one does
// not, or the bundle is malformed in a way that hides whether it does. Exit 2 =
// the gate could not run, which is never treated as a pass.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASET_SOURCES = 'web/src/data/sources.json';
const PROFILE_DIR = 'tools/updater/profiles';

// What the remote says `main` is. Not a local branch: a local `main` is a ref
// this working copy can move, and an anchor the run can move is not an anchor.
const PUBLISHED_REF = 'refs/remotes/origin/main';

const GATE = 'source-approval';

const failures = [];

function fail(message, where) {
  failures.push({ gate: GATE, message, where });
}

function parseArgs(argv) {
  // `base` starts as null, not `HEAD`: absence must not be the most permissive
  // setting, and here it resolves to the merge base rather than to the run's own
  // commit. `null` means "not supplied" and is distinct from a supplied but
  // unusable value, which exits 2.
  const args = { claims: null, base: null, repo: null, json: false, help: false };
  const value = (i, flag) => {
    const next = argv[i];
    if (typeof next !== 'string' || next.length === 0) {
      process.stderr.write(`gate-source-approval: ${flag} needs a value\n`);
      process.exit(2);
    }
    return next;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--claims') args.claims = value(++i, '--claims');
    else if (flag === '--base') args.base = value(++i, '--base');
    else if (flag === '--repo') args.repo = value(++i, '--repo');
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`gate-source-approval: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * The commit the anchors are read at, and the one decision in this gate that
 * the run is not allowed to make.
 *
 * It is the merge base of `HEAD` with the published `main`: the last commit
 * this branch shares with reviewed history. Committing a source only moves
 * `HEAD`, never the merge base, so commit-then-gate buys the run nothing.
 *
 * A caller-supplied `--base` may only narrow - it has to be an ancestor of that
 * merge base, so it can pin something older and reviewed but can never select
 * anything this branch authored.
 */
function resolveAnchor(cwd, requested) {
  let published;
  try {
    published = git(cwd, 'rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`).trim();
  } catch {
    throw new Error(
      `cannot resolve ${PUBLISHED_REF}, so there is no published history to anchor trust in. `
      + `A shallow or single-branch clone will do this; fetch main before gating`,
    );
  }

  let anchor;
  try {
    anchor = git(cwd, 'merge-base', 'HEAD', published).trim();
  } catch {
    throw new Error(`HEAD shares no history with ${PUBLISHED_REF} (${published.slice(0, 10)})`);
  }
  if (anchor.length === 0) throw new Error(`no merge base between HEAD and ${PUBLISHED_REF}`);

  if (requested === null) return { anchor, published, requested: null };

  let pinned;
  try {
    pinned = git(cwd, 'rev-parse', '--verify', `${requested}^{commit}`).trim();
  } catch {
    throw new Error(`--base ${requested} is not a commit in this repository`);
  }
  try {
    // `--is-ancestor` exits non-zero when it does not hold, which throws here.
    // A commit is its own ancestor, so pinning the merge base itself is allowed.
    git(cwd, 'merge-base', '--is-ancestor', pinned, anchor);
  } catch {
    throw new Error(
      `--base ${requested} (${pinned.slice(0, 10)}) is not an ancestor of the merge base with `
      + `${PUBLISHED_REF} (${anchor.slice(0, 10)}), so it is not trust this run inherited. `
      + `--base may only narrow the anchor to an older reviewed commit, never widen it to one `
      + `this branch authored`,
    );
  }
  return { anchor: pinned, published, requested };
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

/**
 * Every origin a reviewed creator profile configured, and what the sweep
 * actually managed to read.
 *
 * Listing a profile and consulting its catalogue are two different facts, and
 * the gap between them is where the trust anchor silently narrows: a profile
 * that loses its `source_catalog` in an edit, or stops parsing, contributes no
 * origins while remaining just as countable as before. Reporting the listing as
 * though it were the catalogues read let that happen with nothing in the output
 * moving (#344), so the two are tracked apart here and the files in the gap are
 * carried out by name rather than folded into a total.
 *
 * `urls` is unchanged by that bookkeeping. Which origins this anchor approves is
 * decided exactly as before; only the account of how wide it was got honest.
 */
function catalogAnchor(cwd, base) {
  let listing;
  try {
    listing = git(cwd, 'ls-tree', '-r', '--name-only', base, '--', PROFILE_DIR);
  } catch {
    // The profiles are an additive anchor. Their absence is reported in the
    // output rather than guessed at, and the dataset anchor still applies.
    return { files: [], urls: [], catalogues: [], withoutCatalogue: [], unreadable: [] };
  }

  const files = listing.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.json'));
  const urls = [];
  // Consulted: parsed, and carried a `source_catalog` array the loop below read.
  const catalogues = [];
  // The two ways a listed profile contributes nothing, kept apart because one is
  // a choice and the other is damage, and a reader has to be able to tell which.
  const withoutCatalogue = [];
  const unreadable = [];
  for (const file of files) {
    let profile;
    try {
      profile = JSON.parse(git(cwd, 'show', `${base}:${file}`));
    } catch {
      unreadable.push(file);
      continue;
    }
    const catalog = profile?.source_catalog;
    if (!Array.isArray(catalog)) {
      withoutCatalogue.push(file);
      continue;
    }
    catalogues.push(file);
    for (const entry of catalog) {
      if (entry !== null && typeof entry === 'object' && typeof entry.url === 'string') urls.push(entry.url);
    }
  }
  return { files, urls, catalogues, withoutCatalogue, unreadable };
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

  let anchor;
  let baseline;
  let catalog;
  try {
    anchor = resolveAnchor(cwd, args.base);
    baseline = datasetAnchor(cwd, anchor.anchor);
    catalog = catalogAnchor(cwd, anchor.anchor);
  } catch (error) {
    process.stderr.write(`gate-source-approval: ${error.message}\n`);
    return 2;
  }
  const anchorAt = anchor.anchor.slice(0, 10);

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
      `gate-source-approval: no approved origin at ${anchorAt} - neither ${DATASET_SOURCES} nor `
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
    // Malformed shapes are refused rather than skipped. Skipping them would make
    // absence the most permissive input in a gate whose whole subject is what a
    // run may leave out - a missing `sourceId` already refuses, so a missing
    // `evidence` must too. `gate-evidence.mjs` happens to refuse these as well,
    // but that is a coincidence of ordering, and a gate that is only closed
    // because another one runs first is not closed.
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      fail(
        'is not a claim object, so whether it rests on an approved source cannot be established',
        `claim:#${index}`,
      );
      return;
    }
    const where = `claim:${claim.id ?? `#${index}`}`;
    if (!Array.isArray(claim.evidence)) {
      fail(
        'has no evidence array, so there is nothing to bind to an approved source; an explicitly '
        + 'empty one is a different thing and is left to gate-evidence to judge',
        where,
      );
      return;
    }

    claim.evidence.forEach((item, position) => {
      const at = `${where}#evidence[${position}]`;
      citations += 1;

      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        fail(
          `is ${item === null ? 'null' : Array.isArray(item) ? 'an array' : `a ${typeof item}`} `
          + `rather than an evidence object, so the source it rests on cannot be identified`,
          at,
        );
        return;
      }

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
          `rests on source "${sourceId}", which is neither in the dataset at ${anchorAt} nor `
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
    // Which tree this verdict is about, and the field that makes a wrong one
    // visible. `datasetAnchor` reads `git show <base>:web/src/data/sources.json`,
    // a path git resolves from the top of the working tree no matter which
    // subdirectory it was run in, so a root one directory off still finds the
    // same dataset anchor and still exits 0. Only the catalogue anchor's
    // pathspec is cwd-relative, and an absent catalogue is a tolerated state.
    // Until this field existed, such a run's report was indistinguishable from a
    // correct one, and a test that wanted to pin the resolved root had to infer
    // it from `anchors.profileCatalogues` instead of reading it (#381).
    //
    // The name is `repo`, the spelling `gate-scope.mjs` already uses, because it
    // is the same fact. `gate-dataset.mjs` reports `dataDir` and that is not an
    // inconsistency to be tidied: it resolves a directory of documents from
    // `--data`, never a repository, so `repo` would name something it does not
    // have. The rule the four follow is that a gate resolving a repository root
    // reports it as `repo`, and the one resolving a data directory reports
    // `dataDir`.
    //
    // It is the resolved root the gate used, never the flag as given. The two
    // cannot diverge here - `--repo` with no value exits 2 - but reporting `cwd`
    // rather than `args.repo` is what keeps that true if that ever changes, and
    // it is what makes the value a real absolute path rather than whatever
    // string arrived.
    repo: cwd,
    bundle: bundlePath,
    runId: bundle.runId ?? null,
    creator: bundle.creator ?? null,
    // Not just which commit, but how it was arrived at. A human reading the pull
    // request has to be able to see that the anchor was the merge base with
    // published history rather than something the run picked.
    base: anchor.anchor,
    anchor: {
      commit: anchor.anchor,
      publishedRef: PUBLISHED_REF,
      publishedCommit: anchor.published,
      selectedBy: anchor.requested === null
        ? `merge-base with ${PUBLISHED_REF}`
        : `--base ${anchor.requested}, narrowed from the merge-base with ${PUBLISHED_REF}`,
      requestedBase: anchor.requested,
    },
    anchors: {
      datasetSources: baseline.size,
      // How wide the profile anchor was, told as two numbers because it is two
      // facts. `profileCatalogues` counts the profiles whose `source_catalog`
      // this run actually consulted - what the name has always claimed - and
      // `profileFiles` is the listing it was drawn from. Reporting the listing
      // under the catalogue name overstated the anchor by every profile that
      // was present but contributed nothing, and did so in the direction that
      // hides harm: a profile losing its catalogue narrows what the run may
      // trust while the reported breadth stays put (#344).
      //
      // The gap is not quietly subtracted. A bare `4` fixes the arithmetic and
      // buries the reason; the point is that a reader can tell "5 files, 4
      // catalogues, 1 without one" from this block alone, so the files in the
      // gap are named, split by which of the two things happened to them.
      //
      // `profilesWithoutCatalogue` is the deliberate case: a profile is allowed
      // to configure no origins at all, and `generic/long-tail.json` is the
      // standing example. It is legitimate as it stands and is not something
      // for a later run to go and "fix" - editing the data so the old count
      // came true would be correcting the evidence to match the claim.
      //
      // `profilesUnreadable` is the damaged case, and it stays a skip rather
      // than becoming a refusal. This anchor is additive: a wholly absent
      // profile tree is already tolerated a few lines up, so one corrupt file
      // being fatal while losing all five is fine would be incoherent, and it
      // would hand any single unparseable profile a veto over runs that never
      // cited it. The skip also fails in the safe direction - it can only
      // withhold trust, never extend it, so it cannot approve anything it
      // should not. What it must not do is stay invisible: being
      // indistinguishable from a deliberate no-catalogue file is the defect
      // itself, and naming the two separately settles that without moving the
      // verdict a millimetre.
      profileFiles: catalog.files.length,
      profileCatalogues: catalog.catalogues.length,
      profilesWithoutCatalogue: [...catalog.withoutCatalogue].sort(),
      profilesUnreadable: [...catalog.unreadable].sort(),
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
      + `(${inherited.size} inherited from the dataset at ${anchorAt}, the merge base with `
      + `${PUBLISHED_REF}; ${proposed.size} proposed on ${approvedOrigins.size} already-trusted `
      + `origin(s))\n`,
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
