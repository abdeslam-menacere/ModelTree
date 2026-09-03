#!/usr/bin/env node
// The rejection-reversal cross-check from abdeslam-menacere/ModelTree#835.
//
// `web/src/data/refresh-runs.json` records, permanently, every claim the review
// panel refused and why. Nothing records that a refused claim later arrived
// anyway. It can: the panel gates the *unattended* refresh path, and an ordinary
// reviewed pull request may legitimately be more permissive than it — ADR 0003's
// stricter-not-looser rule constrains the automated path, not the human one. So
// a reversal is allowed. What is not allowed is a reversal nobody can see.
//
// That is not hypothetical and it is not a one-off. Measured at trunk
// `ca67bc10` while #835 was open, nine claims the panel rejected are in the
// dataset today, from one run (`2026-08-31-b7c2d9`) and four creators, landed by
// three separate pull requests. The rejections are still on the /refresh page,
// still saying these records were refused for want of a quote. Both documents
// are committed, they disagree, and until this gate existed nothing read them
// together.
//
// **What this gate verifies, exactly.** That every visible reversal is
// *annotated* — that a human-authored register entry exists naming the rejection,
// the record, the change that landed it, and what became of each objection. It
// does **not** verify that the objections were well answered, and it cannot:
// `disposition` is self-authored prose and there is no non-subject source for it
// in this repository, on the same terms `gate-ledger.mjs` accepts for an entry's
// summary and ADR 0005 accepts for a content hash. Do not describe this gate as
// verifying that a rejection was correctly overturned. It verifies that somebody
// wrote down that they overturned it, and made the unanswered objections
// countable. Visibility is the whole of the claim.
//
// **Why the annotation lives where it does.** `web/src/data/rejection-reversals.json`,
// beside the ledger it reconciles and deliberately outside `raw.ts` — the same
// placement, for the same reason, as `refresh-runs.json`, `glossary.json` and
// `variant-positioning.json` (see `web/src/data/README.md`). That keeps it
// outside `gate-scope.mjs`'s `ALLOWED_PATHS`, which is the load-bearing part: a
// refresh run that tried to write its own absolution would leave the ADR 0003
// qualifying class by construction and forfeit its auto-merge. Only a change a
// human reviews can annotate a reversal. An annotation the unattended path could
// author would be worth nothing.
//
// The rules, and what each refuses:
//
//   1. **An unannotated reversal.** A `rejected-by-panel` entry whose `detail`
//      names a dataset record that is present today, with no register entry, is
//      refused. This is the rule #835 asked for.
//   2. **An annotation of nothing.** A register entry whose `runId` +
//      `withheldId` is not a `rejected-by-panel` entry in the ledger, or which
//      names a different record than that entry does, is refused. Without this
//      the register could be padded with entries that absolve nothing, and rule
//      1 would be satisfiable by writing noise.
//   3. **An annotation of a record that is gone.** If the record was later
//      removed, the rejection stands again and the entry claims a reversal that
//      no longer exists. Refused, so the register cannot accumulate stale
//      absolutions.
//   4. **Two annotations of one rejection.** Refused, so "which entry governs
//      this reversal" always has one answer.
//   5. **Shape.** Every entry carries the fields below, and each objection
//      carries a `disposition` from a closed vocabulary. `answered` and
//      `overruled` require `evidence`; `unanswered` requires `wouldAnswer`.
//      That asymmetry is deliberate: it makes the honest "this objection is
//      still open, and here is what would close it" the *cheapest* entry to
//      write, and makes a false claim of resolution cost somebody the trouble of
//      writing evidence down where a reader can check it.
//
// **There is no `who` field, and its absence is a finding rather than an
// oversight.** #835 asks for "who revisited the rejection". Every session in
// this repository commits and comments as the same account, so "who" is not
// answerable from any artefact here and a required field for it would be filled
// with a guess. `landedVia` asks the answerable question instead — *which
// change* brought the record in — which is a fact a reader can check against
// `git log`. This gate requires that field to be filled and deliberately does
// **not** resolve it: doing so would be a network call, and a gate that needs
// one cannot run where these gates run. `landedVia` is a claim a reader can
// check, not one the gate has checked.
//
// **The blind spot, stated rather than hidden.** The record id is extracted from
// the `detail` prose, because that is the only place a withheld entry names one:
// the `id` field is a free-form claim id (`ai2-family-molmo-add`), and the
// record it produced (`ai2-molmo`) is not derivable from it. Measured at
// `ca67bc10`, 18 of 62 `rejected-by-panel` entries name a record in the
// recognised form and 44 do not — those 44 are prose about a creator, a
// field-level re-verification, or a claim that never became a record. This gate
// cannot see a reversal among them. It counts them, names them under
// `unresolved` in the JSON report, and says so on every passing run, because a
// gate that quietly skipped two thirds of its subject while printing a pass is
// the failure this whole directory exists to prevent. Widening the coverage
// means giving withheld entries a machine-readable record id at the moment a run
// writes them, which is a change to the refresh skill and not to this gate.
//
// Usage:
//   node gate-reversals.mjs [--data <dir>] [--json]
//
// `--data` changes the *subject* — the directory the ledger, the register and
// the dataset are read from — exactly as in `gate-dataset.mjs`, so the
// self-tests can gate a mutated copy. It never changes the verdict for a given
// subject. There is no `--force`, no `--skip`, and no environment variable, and
// an unrecognised flag exits 2.
//
// Exit 0 = every visible reversal is annotated. Exit 1 = one is not, do not
// merge. Exit 2 = the gate could not run, which is never treated as a pass.

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, four levels up from `.github/skills/modeltree-gates/scripts/`. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** The default subject. `--data` may point this elsewhere; nothing else may. */
const DEFAULT_DATA_DIR = join(REPO_ROOT, 'web', 'src', 'data');

/** The permanent record of what each unattended run decided. Never edited by this gate's rules. */
const LEDGER_FILE = 'refresh-runs.json';

/** The human-authored reconciliation. Deliberately outside `raw.ts` and outside `ALLOWED_PATHS`. */
const REGISTER_FILE = 'rejection-reversals.json';

/** The only withheld category this gate reads. A `dropped-after-acceptance` entry was not refused on its merits. */
const REJECTED = 'rejected-by-panel';

/**
 * The collections a withheld entry may name, mapped to the document that holds
 * them. Keyed by the word the ledger prose actually uses, which is the plural
 * document stem in every case measured.
 */
const COLLECTIONS = {
  families: 'families.json',
  releases: 'releases.json',
  sources: 'sources.json',
  organizations: 'organizations.json',
  publishers: 'publishers.json',
  products: 'products.json',
};

/**
 * How a withheld entry names the record it refused, as its `detail` opens:
 *
 *   families record ai2-molmo for ai2. [provenance] ...
 *   sources record cohere-command-r-08-2024-model-card. [editorial] ...
 *
 * The creator clause is optional because one measured entry omits it. The
 * pattern is anchored at the start and requires the terminating full stop, so
 * prose that merely mentions a collection name mid-sentence cannot match. Its
 * discrimination — that it matches both shapes above and none of the three
 * prose forms that name no record — is asserted in `gates.test.mjs` rather than
 * assumed here.
 */
const NAMES_RECORD = new RegExp(
  `^(${Object.keys(COLLECTIONS).join('|')}) record ([a-z0-9][a-z0-9-]*)(?: for [a-z0-9][a-z0-9-]*)?\\.`,
);

/** What a `disposition` may say. Closed, so a new value is a deliberate edit here. */
const DISPOSITIONS = new Set(['answered', 'overruled', 'unanswered']);

/** Dispositions that assert the objection is closed, and so must show their working. */
const NEEDS_EVIDENCE = new Set(['answered', 'overruled']);

function parseArgs(argv) {
  const args = { json: false, help: false, data: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--data') {
      i += 1;
      if (i >= rest.length) throw new Error('--data needs a directory');
      args.data = rest[i];
    } else throw new Error(`unrecognised argument ${arg}`);
  }
  return args;
}

function readArray(dir, file) {
  const path = join(dir, file);
  if (!existsSync(path)) return { present: false, records: [], path };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not readable JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array`);
  return { present: true, records: parsed, path };
}

/** Non-empty string, with whitespace-only refused so a field cannot be filled with a space. */
function filled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Every `rejected-by-panel` entry across every run, with the record it names
 * resolved where the prose permits. Ordering follows the ledger so a report
 * reads in the order a person would find them on the page.
 */
function collectRejections(ledger) {
  const resolved = [];
  const unresolved = [];
  for (const run of ledger) {
    const runId = run?.id;
    for (const [index, entry] of (run?.withheld ?? []).entries()) {
      if (entry?.category !== REJECTED) continue;
      const match = NAMES_RECORD.exec(typeof entry.detail === 'string' ? entry.detail : '');
      const common = { runId, index, withheldId: entry?.id };
      if (match) resolved.push({ ...common, collection: match[1], recordId: match[2] });
      else unresolved.push(common);
    }
  }
  return { resolved, unresolved };
}

function gate(dataDir) {
  const ledger = readArray(dataDir, LEDGER_FILE);
  if (!ledger.present) throw new Error(`no ${LEDGER_FILE} at ${dataDir}, so there are no rejections to read`);

  const { resolved, unresolved } = collectRejections(ledger.records);

  // A gate that can pass by matching nothing has proved nothing. If the ledger
  // holds no rejection at all, its subject has vanished -- a restructured
  // ledger, a wrong directory, a renamed category -- and that is a gate that
  // could not run rather than a repository with nothing to answer for.
  if (resolved.length + unresolved.length === 0) {
    throw new Error(
      `${LEDGER_FILE} holds no withheld entry with category '${REJECTED}'. Either the ledger `
      + 'moved or the category was renamed; this gate has no subject and will not report a pass',
    );
  }

  // Which records exist today. Only the collections actually named are loaded,
  // so a ledger that never mentions `products` does not require that document.
  const idsByCollection = new Map();
  for (const rejection of resolved) {
    if (idsByCollection.has(rejection.collection)) continue;
    const file = COLLECTIONS[rejection.collection];
    const doc = readArray(dataDir, file);
    if (!doc.present) throw new Error(`${LEDGER_FILE} names collection '${rejection.collection}' but there is no ${file} at ${dataDir}`);
    idsByCollection.set(rejection.collection, new Set(doc.records.map((record) => record?.id)));
  }

  const reversals = resolved.filter((r) => idsByCollection.get(r.collection).has(r.recordId));
  const key = (runId, withheldId) => `${runId}\u0000${withheldId}`;

  const register = readArray(dataDir, REGISTER_FILE);
  const failures = [];

  // Rule 5, first, because the rules below index the register by its keys and a
  // malformed entry has no trustworthy key to index by.
  const wellFormed = [];
  for (const [index, entry] of register.records.entries()) {
    const where = `${REGISTER_FILE}[${index}]`;
    const problems = [];
    for (const field of ['runId', 'withheldId', 'collection', 'recordId', 'landedVia', 'recordedOn']) {
      if (!filled(entry?.[field])) problems.push(`${field} must be a non-empty string`);
    }
    if (entry?.collection !== undefined && !Object.hasOwn(COLLECTIONS, entry.collection)) {
      problems.push(`collection '${entry.collection}' is not one of ${Object.keys(COLLECTIONS).join(', ')}`);
    }
    if (!Array.isArray(entry?.objections) || entry.objections.length === 0) {
      problems.push('objections must be a non-empty array');
    } else {
      for (const [j, objection] of entry.objections.entries()) {
        if (!filled(objection?.summary)) problems.push(`objections[${j}].summary must be a non-empty string`);
        const disposition = objection?.disposition;
        if (!DISPOSITIONS.has(disposition)) {
          problems.push(`objections[${j}].disposition must be one of ${[...DISPOSITIONS].join(', ')}`);
        } else if (NEEDS_EVIDENCE.has(disposition) && !filled(objection?.evidence)) {
          problems.push(`objections[${j}] says '${disposition}', so it must carry evidence saying on what`);
        } else if (disposition === 'unanswered' && !filled(objection?.wouldAnswer)) {
          problems.push(`objections[${j}] says 'unanswered', so it must carry wouldAnswer naming what would close it`);
        }
      }
    }
    if (problems.length === 0) wellFormed.push(entry);
    else for (const problem of problems) failures.push(`${where}: ${problem}`);
  }

  // Rules 2, 3 and 4, over the entries that are shaped well enough to judge.
  const rejectionByKey = new Map(resolved.map((r) => [key(r.runId, r.withheldId), r]));
  const seen = new Map();
  for (const entry of wellFormed) {
    const entryKey = key(entry.runId, entry.withheldId);
    const where = `${REGISTER_FILE} entry for ${entry.runId}/${entry.withheldId}`;

    if (seen.has(entryKey)) {
      failures.push(`${where} is a duplicate; one rejection is annotated at most once`);
      continue;
    }
    seen.set(entryKey, entry);

    const rejection = rejectionByKey.get(entryKey);
    if (!rejection) {
      failures.push(
        `${where} annotates no rejection: ${LEDGER_FILE} has no run ${entry.runId} holding a `
        + `'${REJECTED}' entry with id ${entry.withheldId} that names a record`,
      );
      continue;
    }
    if (rejection.collection !== entry.collection || rejection.recordId !== entry.recordId) {
      failures.push(
        `${where} names ${entry.collection}/${entry.recordId}, but that rejection is about `
        + `${rejection.collection}/${rejection.recordId}`,
      );
      continue;
    }
    if (!idsByCollection.get(rejection.collection).has(rejection.recordId)) {
      failures.push(
        `${where} records a reversal, but ${rejection.collection}/${rejection.recordId} is not in the `
        + 'dataset. The rejection stands again, so the annotation is stale and should be removed',
      );
    }
  }

  // Rule 1 -- the one #835 asked for.
  const unannotated = [];
  for (const reversal of reversals) {
    if (seen.has(key(reversal.runId, reversal.withheldId))) continue;
    unannotated.push(reversal);
    failures.push(
      `${reversal.collection}/${reversal.recordId} is in the dataset, but run ${reversal.runId} `
      + `rejected it (withheld[${reversal.index}], id ${reversal.withheldId}) and ${REGISTER_FILE} `
      + 'does not say who revisited that rejection or on what evidence. A reversal is allowed; an '
      + 'invisible one is not',
    );
  }

  return {
    dataDir,
    rejectionsRead: resolved.length + unresolved.length,
    rejectionsNamingARecord: resolved.length,
    unresolved,
    reversals: reversals.map((r) => `${r.collection}/${r.recordId}`),
    annotations: register.records.length,
    unannotated: unannotated.map((r) => `${r.collection}/${r.recordId}`),
    failures,
    passed: failures.length === 0,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    process.stderr.write(`gate-reversals: ${error.message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write('usage: gate-reversals.mjs [--data <dir>] [--json]\n');
    return 0;
  }

  const dataDir = args.data ? resolve(args.data) : DEFAULT_DATA_DIR;
  if (!existsSync(dataDir)) {
    process.stderr.write(`gate-reversals: no directory at ${dataDir}\n`);
    return 2;
  }

  let result;
  try {
    result = gate(dataDir);
  } catch (error) {
    process.stderr.write(`gate-reversals: ${error.message}\n`);
    return 2;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.passed ? 0 : 1;
  }

  if (!result.passed) {
    process.stdout.write(`gate-reversals: REFUSED - ${result.failures.length} finding(s).\n`);
    for (const failure of result.failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  process.stdout.write(
    `gate-reversals: ${result.reversals.length} of ${result.rejectionsNamingARecord} rejected record(s) `
    + `are in the dataset, and ${REGISTER_FILE} annotates every one.\n`,
  );
  // Say what was NOT checked on the passing path too. A pass that reads as
  // coverage of the whole ledger would be the more comfortable line to print
  // and the wrong one.
  process.stdout.write(
    `  ${result.unresolved.length} of ${result.rejectionsRead} rejection(s) name no record in their `
    + 'detail, so this gate cannot tell whether they were reversed. Not checked is not passed.\n',
  );
  return 0;
}

process.exit(main());
