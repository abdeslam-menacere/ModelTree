#!/usr/bin/env node
// Deterministic gates over a refresh run's claim bundle, before any of it
// reaches `web/src/data`. Where `gate-dataset.mjs` asks "is the resulting
// dataset coherent", this asks "was this claim actually established".
//
// It is the mechanical half of the source policy: it cannot judge whether a
// quote supports a claim, nor whether anyone ever visited the cited url, but it
// can refuse a claim that has no quote, a `retrieval` field that does not say
// `fetch`, a malformed hash, or a review that never reached a majority. Those
// are checks on the form of what the producer declared, never on remote content
// -- see ADR 0005. Search snippets are refused here, by contract, rather than
// by anyone remembering.
//
// Usage:
//   node gate-evidence.mjs --claims <path> [--today YYYY-MM-DD] [--repo <dir>] [--json]
//
// Exit 0 = every claim in the bundle is admissible. Exit 1 = at least one is
// not. Exit 2 = the runner could not run, which is never treated as a pass.
//
// Bundle contract (see ../reference/claim-bundle.md):
//   { "runId": "...", "creator": "...", "policy": "pilot" | "long-tail",
//     "claims": [ { id, kind, collection, targetId, field?, currentValue,
//                   proposedValue, statement, evidence: [...], verdicts: [...] } ] }

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The three rubrics from #59's review panel. A bundle must carry exactly these,
// once each: a panel missing a rubric has not been independently reviewed, and
// a panel carrying one twice has counted one reviewer's opinion as two.
const REQUIRED_REVIEWERS = ['provenance', 'consistency', 'editorial'];

// A pilot creator's claim needs 2 of 3. A long-tail creator is a creator nobody
// has written a reviewed profile for, so #59 and ADR 0002 require unanimity.
const THRESHOLDS = { pilot: 2, 'long-tail': 3 };

// The reviewed-profile set is this repository's ground truth for which creators
// are pilots. A creator with a reviewed profile here is a pilot; one without is
// long-tail. It is read from disk, not taken from the bundle, which is the whole
// point of #233 -- see the derivation in main().
const PROFILE_DIR = 'tools/updater/profiles';

const VALID_KINDS = ['add', 'change', 'remove', 'unchanged', 'conflict'];
const VALID_COLLECTIONS = [
  'sources', 'publishers', 'organizations', 'families', 'releases',
  'usageObservations', 'usageSyntheses', 'modelFitStatements', 'modelFitEvidenceGaps',
];

// A quote short enough to be a coincidence is not corroboration.
const MINIMUM_QUOTE_LENGTH = 24;

const FORBIDDEN_HOSTS = [/^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/i, /\.local$/i, /\.internal$/i];

// What counts as whitespace inside a declared creator id. JS `trim()` and Python
// `str.strip()` do not agree on it -- JS treats U+FEFF as whitespace and Python
// does not; Python treats U+001C-U+001F and U+0085 as whitespace and JS does not
// -- and the reviewed set is read by both. This is their union, so each side
// refuses at least everything the other does. Widening what is *refused* is safe
// in a way widening what is *matched* is not: a refusal exits 2.
//
// Not included, deliberately: U+200B and U+202E are whitespace to neither, and
// guessing at invisible characters one at a time is how a fold starts shrinking
// instead of growing. `tools/updater` makes the same call for the same reason.
const ID_WHITESPACE = '\\s\\u0085\\u001c-\\u001f';
const PADDED_ID = new RegExp(`^[${ID_WHITESPACE}]|[${ID_WHITESPACE}]$`);
const ID_WHITESPACE_RUN = new RegExp(`[${ID_WHITESPACE}]+`, 'g');

// JS has no `String.prototype.casefold`. Upper-then-lower is the nearest
// equivalent and folds at least as much as `toLowerCase` alone: it maps U+00DF
// to "ss" and U+017F to "s", as Python's `casefold` does.
function foldCase(value) {
  return value.toUpperCase().toLowerCase();
}

// Python's `str.split()`/`" ".join()` pair: drop the padding, collapse every
// internal run to one space. `"acme labs"` and `"acme\u00a0labs"` are one id to
// the eye and indistinguishable in any diff, so they are one id here.
function collapseWhitespace(value) {
  return value.replace(ID_WHITESPACE_RUN, ' ').trim();
}

const failures = [];

function fail(gate, message, where) {
  failures.push({ gate, message, where });
}

function parseArgs(argv) {
  const args = { claims: null, today: null, json: false, repo: null, help: false };
  // The same guard, for the same reason, as `gate-dataset.mjs`'s: a flag whose
  // value is missing must not survive into a default. Here `--repo` falls back
  // to `repoRoot()` and `--today` to the wall clock, so a value that went
  // missing would have this gate read a reviewed-profile set the caller never
  // named -- and derive a policy threshold from it -- while reporting a pass
  // (#372). `--claims` was already refused, but as "required" rather than as a
  // flag given no value; it goes through the same helper so all three refusals
  // say what actually happened.
  //
  // A fourth copy of the closure `gate-scope.mjs` and `gate-source-approval.mjs`
  // carry, not an import: these four scripts share no module and import only
  // `node:` builtins. Copied verbatim rather than varied, since a third parsing
  // style is what #168 is open on.
  const value = (i, flag) => {
    const next = argv[i];
    if (typeof next !== 'string' || next.length === 0) {
      process.stderr.write(`gate-evidence: ${flag} needs a value\n`);
      process.exit(2);
    }
    return next;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--claims') args.claims = value(++i, '--claims');
    else if (flag === '--today') args.today = value(++i, '--today');
    else if (flag === '--repo') args.repo = value(++i, '--repo');
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`gate-evidence: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

// The repository root, found from this script's own location so the reviewed set
// is read from the checkout the gate ships in rather than from wherever it was
// invoked. `.github/skills/modeltree-gates/scripts/gate-evidence.mjs` -> up four.
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

// The set of creator ids that have a reviewed profile, read from disk. Keyed by
// the declared `creator.id` inside each profile, exactly as tools/updater keys
// its ProfileLibrary -- the filename is incidental, the declared id is the id a
// bundle names. Throws rather than returning a partial set: an unreadable,
// malformed, or empty reviewed set must fail the gate closed, never quietly
// classify every creator as long-tail (or admit one as pilot) against nothing.
//
// It applies the same rules to the same directory that `tools/updater`'s
// ProfileLibrary does, because two implementations of one rule that disagree
// about what is valid will eventually disagree about something that matters
// (#251, an instance of the drift #168 records). Every disagreement it closes is
// closed by refusing more, never by admitting more: a refusal exits 2, so it can
// only ever stop a run, never let one publish under the looser bar.
export function reviewedCreatorIds(repo) {
  const dir = resolve(repo, PROFILE_DIR);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read the reviewed-profile set at ${dir}: ${error.message}`);
  }

  // Keyed by the folded id so a collision is caught, but the set returned holds
  // the ids as declared. Folding decides what *collides*; it must never widen
  // what an id *matches*, because a bundle is classified by exact lookup.
  const seen = new Map();
  for (const entry of entries) {
    // Skipped first, and deliberately. A leading dot is the author saying "not
    // part of the working set", and a directory -- the long-tail profiles live in
    // one -- was never a document at all, so refusing `archive.JSON` below for its
    // extension when it is a directory would answer a question nobody asked.
    if (entry.name.startsWith('.') || !entry.isFile()) continue;

    const suffix = extname(entry.name);
    if (suffix !== '.json') {
      // A neighbour nobody meant as a profile is ignored, exactly as before: a
      // note, a README, a lockfile. Only a name plainly meant as a profile, where
      // just the case of the extension is wrong, reaches the refusal.
      if (foldCase(suffix) !== '.json') continue;
      throw new Error(
        `reviewed profile ${entry.name} must end in ".json" exactly, not "${suffix}". `
        + 'Skipping it would leave the reviewed set to depend on whether the filesystem reading it is '
        + 'case-sensitive: it is one file alongside its lowercase twin on Windows and two files on the '
        + 'Linux that CI runs, so the same repository would classify the same creator differently on the '
        + 'two platforms. Rename the file.',
      );
    }

    const file = join(dir, entry.name);
    let profile;
    try {
      profile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`reviewed profile ${entry.name} is not valid JSON: ${error.message}`);
    }
    const id = profile?.creator?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`reviewed profile ${entry.name} declares no creator.id, so the reviewed set cannot be trusted`);
    }
    // Refused, not trimmed. The set is keyed by the exact declared string, so a
    // document declaring " acme-labs" answers only to " acme-labs" and never to
    // the id its author meant -- it loads, classifies nobody, and quietly leaves
    // that creator long-tail. Trimming instead would register the document under
    // a string it does not contain, which is worse: a reader of the JSON could no
    // longer tell which string resolves.
    if (PADDED_ID.test(id)) {
      throw new Error(
        `reviewed profile ${entry.name} declares creator.id ${JSON.stringify(id)} with leading or trailing `
        + 'whitespace; an id is matched exactly, so a padded one answers to no bundle and classifies '
        + 'nobody. Declare it without padding rather than relying on it being trimmed.',
      );
    }

    const key = foldCase(collapseWhitespace(id));
    const twin = seen.get(key);
    if (twin) {
      throw new Error(
        `duplicate creator id ${JSON.stringify(id)} in ${entry.name} and ${JSON.stringify(twin.id)} in `
        + `${twin.file}: an id has to name exactly one reviewed profile, because the threshold a bundle is `
        + 'held to is derived by asking this set about its creator, and two documents answering to one id '
        + 'would make that answer depend on which was read last.',
      );
    }
    seen.set(key, { id, file: entry.name });
  }

  if (seen.size === 0) {
    throw new Error(`the reviewed-profile set at ${dir} holds no profiles; refusing to classify a creator against nothing`);
  }
  return new Set([...seen.values()].map((profile) => profile.id));
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  // Left on `Date.UTC` on purpose (#596). Removing the remap here is not a
  // neutral correction the way it is in `startOf` below: this round-trip is
  // the only thing in this file that refuses a year in 0001-0099, because
  // unlike `gate-dataset.mjs` this gate carries no 1950 floor at the call
  // site. Measured, committed against patched, `fetchedAt "0049-12-31"` moves
  // from refused-as-unreal to accepted -- a change to what the gate admits,
  // which #596 explicitly does not ask for. Whoever removes it owes a decision
  // about the floor, not just an edit.
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * `Date.UTC` without its two-digit-year remap (#596), as in `gate-dataset.mjs`.
 *
 * `Date.UTC` maps a year in 0-99 to 1900-1999, so `Date.UTC(49, 11, 31)` is
 * 1949 rather than year 49. The signature mirrors `Date.UTC` -- year,
 * **zero-based** month, day -- so the call site changes only the name.
 */
function utcMs(year, monthIndex, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date.getTime();
}

function startOf(value) {
  const [y, m = 1, d = 1] = String(value).split('-').map(Number);
  return utcMs(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// Gate: the evidence behind a claim is well-formed and declares a fetch.
// ---------------------------------------------------------------------------
function gateEvidence(claim, today) {
  const where = `claim:${claim.id}`;
  const evidence = claim.evidence;

  if (!Array.isArray(evidence) || evidence.length === 0) {
    fail('evidence', 'carries no evidence at all', where);
    return;
  }

  evidence.forEach((item, index) => {
    const at = `${where}#evidence[${index}]`;

    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail('evidence', 'is not an object', at);
      return;
    }

    // The single most important rule in this file. A search result is a pointer
    // to a source, never the source. #59 states it as policy; here it is a
    // field that must say `fetch` and a hash that must be well-formed. Both are
    // values the producer declared, so their form is all this gate can check:
    // well-formedness is not evidence of correspondence (ADR 0005).
    if (item.retrieval !== 'fetch') {
      fail(
        'evidence',
        `retrieval is "${item.retrieval ?? 'missing'}", but only "fetch" is admissible - a search snippet is never evidence`,
        at,
      );
    }

    if (typeof item.url !== 'string' || item.url.length === 0) {
      fail('evidence', 'has no url', at);
    } else {
      let url;
      try {
        url = new URL(item.url);
      } catch {
        url = null;
        fail('urls', `url "${item.url}" is not a valid URL`, at);
      }
      if (url) {
        if (url.protocol !== 'https:') fail('urls', `url "${item.url}" is not https`, at);
        if (url.username || url.password) fail('urls', `url "${item.url}" carries embedded credentials`, at);
        if (FORBIDDEN_HOSTS.some((pattern) => pattern.test(url.hostname))) {
          fail('urls', `host "${url.hostname}" cannot stand behind a public fact`, at);
        }
      }
    }

    if (typeof item.contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.contentHash)) {
      fail(
        'evidence',
        `contentHash "${item.contentHash ?? 'missing'}" is not shaped sha256:<64 hex> - this gate checks that shape only, never correspondence to the cited url`,
        at,
      );
    }

    if (!isRealDate(item.fetchedAt)) {
      fail('evidence', `fetchedAt "${item.fetchedAt ?? 'missing'}" is not a real YYYY-MM-DD date`, at);
    } else if (startOf(item.fetchedAt) > startOf(today)) {
      fail('evidence', `fetchedAt "${item.fetchedAt}" is in the future (today is ${today})`, at);
    }

    if (typeof item.quote !== 'string' || item.quote.trim().length < MINIMUM_QUOTE_LENGTH) {
      fail(
        'evidence',
        `quote is missing or shorter than ${MINIMUM_QUOTE_LENGTH} characters, so it cannot show the source stating this`,
        at,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Gate: the review panel was complete, independent, and reached its threshold.
// ---------------------------------------------------------------------------
function gateReview(claim, policy) {
  const where = `claim:${claim.id}`;
  const verdicts = claim.verdicts;
  const threshold = THRESHOLDS[policy];

  if (!Array.isArray(verdicts)) {
    fail('review', 'carries no verdicts, so it was never reviewed', where);
    return { accepted: false, accepts: 0 };
  }

  const seen = new Map();
  for (const verdict of verdicts) {
    if (verdict === null || typeof verdict !== 'object') {
      fail('review', 'a verdict is not an object', where);
      continue;
    }
    if (!REQUIRED_REVIEWERS.includes(verdict.reviewer)) {
      fail('review', `unknown reviewer rubric "${verdict.reviewer}"`, where);
      continue;
    }
    if (seen.has(verdict.reviewer)) {
      fail('review', `rubric "${verdict.reviewer}" voted twice, which counts one reviewer as two`, where);
      continue;
    }
    if (verdict.vote !== 'accept' && verdict.vote !== 'reject') {
      fail('review', `rubric "${verdict.reviewer}" returned "${verdict.vote}" rather than accept or reject`, where);
      continue;
    }
    if (typeof verdict.rationale !== 'string' || verdict.rationale.trim().length === 0) {
      fail('review', `rubric "${verdict.reviewer}" gave no rationale, so its verdict is unauditable`, where);
    }
    seen.set(verdict.reviewer, verdict.vote);
  }

  for (const reviewer of REQUIRED_REVIEWERS) {
    if (!seen.has(reviewer)) {
      fail('review', `rubric "${reviewer}" never reported, so the panel was incomplete`, where);
    }
  }

  const accepts = [...seen.values()].filter((vote) => vote === 'accept').length;
  const complete = REQUIRED_REVIEWERS.every((reviewer) => seen.has(reviewer));
  return { accepted: complete && accepts >= threshold, accepts };
}

// ---------------------------------------------------------------------------
// Gate: the claim is shaped like something that can be applied.
// ---------------------------------------------------------------------------
function gateShape(claim, index) {
  const where = `claim:${claim.id ?? `#${index}`}`;

  if (typeof claim.id !== 'string' || claim.id.length === 0) {
    fail('shape', `claim ${index} has no id`, where);
  }
  if (!VALID_KINDS.includes(claim.kind)) {
    fail('shape', `kind "${claim.kind}" is not one of ${VALID_KINDS.join(', ')}`, where);
  }
  if (!VALID_COLLECTIONS.includes(claim.collection)) {
    fail('shape', `collection "${claim.collection}" is not a dataset document`, where);
  }
  if (typeof claim.targetId !== 'string' || claim.targetId.length === 0) {
    fail('shape', 'has no targetId, so nothing says what it changes', where);
  }
  if (typeof claim.statement !== 'string' || claim.statement.trim().length === 0) {
    fail('shape', 'has no statement, so the reviewers voted on nothing legible', where);
  }
  if (claim.kind === 'change') {
    if (claim.proposedValue === undefined) {
      fail('shape', 'is a change with no proposedValue', where);
    } else if (JSON.stringify(claim.currentValue) === JSON.stringify(claim.proposedValue)) {
      fail('shape', 'is a change whose proposedValue equals the current value', where);
    }
    if (typeof claim.field !== 'string' || claim.field.length === 0) {
      fail('shape', 'is a change with no field named', where);
    }
  }
  if (claim.kind === 'add' && claim.proposedValue === undefined) {
    fail('shape', 'is an addition with no proposedValue', where);
  }
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('usage: gate-evidence.mjs --claims <path> [--today YYYY-MM-DD] [--repo <dir>] [--json]\n');
    return 0;
  }
  if (!args.claims) {
    process.stderr.write('gate-evidence: --claims <path> is required\n');
    return 2;
  }

  const path = resolve(args.claims);
  if (!existsSync(path)) {
    process.stderr.write(`gate-evidence: no claim bundle at ${path}\n`);
    return 2;
  }

  let bundle;
  try {
    bundle = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(`gate-evidence: ${path} is not valid JSON: ${error.message}\n`);
    return 2;
  }

  const today = args.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) {
    process.stderr.write(`gate-evidence: --today "${today}" is not a real date\n`);
    return 2;
  }

  // `policy` is still required and still validated for membership: an absent
  // policy is refused exactly as an unknown one is, because the field is
  // self-reported by the agent this gate exists to check and silence must not
  // select the looser threshold. What changed in #233 is that presence and
  // membership are no longer enough -- the *applied* threshold is derived from
  // repository state below, and a declared value that contradicts the derived
  // one is refused rather than believed.
  if (!Object.hasOwn(bundle, 'policy')) {
    process.stderr.write('gate-evidence: bundle has no policy; expected pilot or long-tail (it is never defaulted)\n');
    return 2;
  }
  const declaredPolicy = bundle.policy;
  if (!Object.hasOwn(THRESHOLDS, declaredPolicy)) {
    process.stderr.write(`gate-evidence: unknown policy "${declaredPolicy}"; expected pilot or long-tail\n`);
    return 2;
  }

  // Derive the threshold from the reviewed-profile set on disk rather than
  // believing the bundle. A creator with a reviewed profile is a pilot; one
  // without is long-tail. This is the correction the earlier design forbade too
  // broadly: inferring the policy from the self-reported `creator` field would be
  // the same defect wearing a heuristic, but *deriving* it from the reviewed set
  // the gate already has on disk is ground truth, not self-report. The two are
  // different operations.
  //
  // It fails closed. If that set cannot be read, or the creator cannot be
  // classified, the gate exits 2 -- an unclassifiable creator never falls back to
  // the looser bar. And a bundle whose declared policy contradicts the derived
  // one is refused, naming both, rather than silently overridden: a run that
  // believes it is publishing under the wrong policy is itself a defect worth
  // surfacing.
  //
  // The root this gate resolves its inputs against, computed once here so the
  // report below can name the root that was actually *used*. Since #372 the two
  // can no longer diverge through a dropped `--repo` value -- a value-less flag
  // exits 2 at `parseArgs` rather than falling through here -- so this is now
  // the narrower claim it always should have been: `null` means the flag was
  // absent, and the fallback is then the tree this script sits in. Resolving the
  // supplied value also makes the reported path absolute rather than whatever
  // string arrived.
  const repo = args.repo ? resolve(args.repo) : repoRoot();
  let reviewed;
  try {
    reviewed = reviewedCreatorIds(repo);
  } catch (error) {
    process.stderr.write(`gate-evidence: ${error.message}\n`);
    return 2;
  }
  const creator = bundle.creator;
  if (typeof creator !== 'string' || creator.length === 0) {
    process.stderr.write(
      'gate-evidence: bundle names no creator to classify; the policy is derived from the creator, '
      + 'never taken on the bundle\'s word\n',
    );
    return 2;
  }
  const derivedPolicy = reviewed.has(creator) ? 'pilot' : 'long-tail';
  if (declaredPolicy !== derivedPolicy) {
    process.stderr.write(
      `gate-evidence: creator "${creator}" is a ${derivedPolicy} creator, but the bundle declares `
      + `policy "${declaredPolicy}". The review threshold is derived from the reviewed-profile set, `
      + 'not read from the bundle; refusing rather than publishing under the wrong bar.\n',
    );
    return 2;
  }
  // From here the applied policy is the derived one, never the bundle's word.
  const policy = derivedPolicy;

  if (!Array.isArray(bundle.claims)) {
    process.stderr.write('gate-evidence: bundle has no claims array\n');
    return 2;
  }

  const seenIds = new Set();
  const applicable = [];

  bundle.claims.forEach((claim, index) => {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
      fail('shape', `claim ${index} is not an object`, `claim:#${index}`);
      return;
    }
    if (typeof claim.id === 'string') {
      if (seenIds.has(claim.id)) fail('shape', `claim id "${claim.id}" appears more than once`, `claim:${claim.id}`);
      seenIds.add(claim.id);
    }

    gateShape(claim, index);

    // `unchanged` records that a fact was re-checked and still holds, and
    // `conflict` records that sources disagree. Neither is applied, so neither
    // needs a majority - but both still need real evidence, because both are
    // published in the summary as findings.
    gateEvidence(claim, today);
    const review = gateReview(claim, policy);

    const changesData = claim.kind === 'add' || claim.kind === 'change' || claim.kind === 'remove';
    if (changesData) {
      if (!review.accepted) {
        fail(
          'review',
          `is marked "${claim.kind}" but only reached ${review.accepts} of ${THRESHOLDS[policy]} required accepts under the ${policy} policy`,
          `claim:${claim.id}`,
        );
      } else {
        applicable.push(claim.id);
      }
    }
  });

  const result = {
    // Which tree this verdict is about. This gate takes a repository location as
    // input and, until #381, produced a report that never said which one it
    // used - so a reader could not answer "which tree was this about?" from the
    // report at all. That still matters when `--repo` is absent: the fallback
    // root is a path the caller never wrote down, and naming it is the only way
    // a reader can tell which reviewed-profile set the policy was derived from.
    // (A `--repo` whose value went missing used to reach that fallback too; it
    // exits 2 at `parseArgs` since #372.)
    //
    // The name is `repo`, the spelling `gate-scope.mjs` already uses, because it
    // is the same fact. `gate-dataset.mjs` reports `dataDir` and that is not an
    // inconsistency to be tidied: it resolves a directory of documents from
    // `--data`, never a repository. The rule the four follow is that a gate
    // resolving a repository root reports it as `repo`, and the one resolving a
    // data directory reports `dataDir`.
    repo,
    bundle: path,
    runId: bundle.runId ?? null,
    creator: bundle.creator ?? null,
    policy,
    threshold: THRESHOLDS[policy],
    claims: bundle.claims.length,
    applicable: applicable.length,
    passed: failures.length === 0,
    failures,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (failures.length === 0) {
    process.stdout.write(
      `gate-evidence: ${bundle.claims.length} claim(s) admissible under the ${policy} policy `
      + `(${applicable.length} apply to the dataset)\n`,
    );
  } else {
    process.stdout.write(`gate-evidence: ${failures.length} failure(s)\n`);
    for (const failure of failures) {
      process.stdout.write(`  [${failure.gate}] ${failure.where}: ${failure.message}\n`);
    }
  }

  return failures.length === 0 ? 0 : 1;
}

// Run the gate only when invoked as a script, not when a module imports the
// reviewed-set reader above. Node runs this file for `node gate-evidence.mjs`
// (argv[1] is this file) and skips it under `import`, so the CLI contract is
// unchanged while `reviewedCreatorIds` can be reused rather than reimplemented.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
