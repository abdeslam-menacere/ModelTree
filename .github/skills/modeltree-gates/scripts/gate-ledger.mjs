#!/usr/bin/env node
// The ledger cross-check from ADR 0006.
//
// ADR 0003 bounded an auto-merging refresh to the dataset documents `raw.ts`
// composes, which left `web/src/data/refresh-runs.json` outside the class. A run
// therefore could not record itself without failing `gate-scope.mjs` and
// forfeiting its auto-merge, so every unattended run published data and left the
// `/refresh` page one run stale. Three runs were repaired by hand before anyone
// noticed the pattern; that is #419.
//
// ADR 0006 widens the class by this one file so the run writes its own entry in
// the same pull request. That grant is conditional on this gate, and the reason
// is the objection #419 raised against widening: it lets an unreviewed run write
// its own report card. So the numbers in that report card are checked against the
// change they describe.
//
// **What this gate verifies, exactly.** The entry's *numbers*, against the diff:
// which documents changed, and how many records each held before and after. It
// does not verify `summary`, `caveats`, the stage notes, or any other prose -
// those are self-authored and there is no non-subject source for them in this
// repository, on the same terms ADR 0005 accepts for a content hash. Do not
// describe this gate as verifying the entry. It verifies the entry's numbers.
//
// **The anchor is computed, not supplied**, identically to `gate-scope.mjs` and
// `gate-source-approval.mjs`: `git merge-base HEAD refs/remotes/origin/main`.
// Committing moves `HEAD` and never the merge base, so a run cannot commit its
// way to a smaller diff. Three gates answering "which commit do I trust" three
// different ways is how this class of bug survives, so they answer it the same
// way and a self-test pins that they agree.
//
// The six rules, and what each refuses:
//
//   1. **Declared documents match changed documents.** A run may not quietly
//      edit a document its entry does not mention, nor claim one it never
//      touched.
//   2. **Record counts are counted, not asserted.** Each declared document is
//      read at the anchor and at the working tree and its records counted. A run
//      that adds nine releases and reports three fails here. This is the rule
//      that makes the entry something other than a self-assessment, and the one
//      an internally-coherent lie does not survive.
//   3. **A run id is added at most once, and is new.** The branch may add one
//      entry, and its id may not already exist at the anchor.
//   4. **A declared run has an entry added here.** Any commit subject on this
//      branch of the form `(run <id>)` must have a matching entry *that this
//      branch adds*. Matching it against the whole ledger would let a run
//      declare an id the anchor already records and satisfy the rule with an
//      entry someone else wrote, which is id reuse passing as compliance.
//   5. **A change that may merge unattended records itself.** If this branch
//      changes a dataset document and touches nothing outside the qualifying
//      class, it is by construction a change ADR 0003 permits to reach `main`
//      with no human approving it, and it must add an entry. Without this rule
//      omitting the entry is the cheapest way through the gate, which inverts
//      `modeltree-gates`' own rule that absence must never be the more
//      permissive option - and it is exactly the #419 failure, which was an
//      entry that never existed rather than a wrong one.
//   6. **The ledger is append-only.** An id recorded at the anchor must still be
//      there, and in run mode the prior entries must be untouched and in the
//      same order. Rules 1-4 all reason about *added* entries, so without this
//      one a deletion is invisible to every one of them: remove a published run
//      and add a correctly reconciled one and every aggregate nets out. That
//      would let the runs this page audits rewrite the audit trail.
//
// Rules 1 and 2 fire only when an entry was added *and* this branch changed a
// dataset document; rule 4 only when a run id was declared; rule 5 only for a
// change confined to the qualifying class. So an ordinary human data change
// bundled with anything outside that class - a schema edit, a test, a component -
// is out of class, cannot merge unattended, and is not required to file a report
// about a run that never happened. What rule 5 does catch is the *pure* data
// change, because that one is indistinguishable from a refresh at the only
// boundary that matters: it auto-merges. Anything that reaches `main` unattended
// belongs on the page that exists to audit what reached `main` unattended.
//
// An entry added on a branch that changes no dataset document is a
// *transcription* of already-published work, which has no diff here to be
// reconciled against; the report marks it `transcription: true` and says the
// numbers went unchecked, rather than passing it silently as though they had
// been. Transcription relaxes rules 1 and 2 and the ordering half of rule 6,
// because repairing a historical entry is editing one in place and that is the
// repair route ADR 0006 preserves. It never relaxes the no-deletion half.
//
// `--history <ref>` answers #419's fourth acceptance criterion over published
// history instead of over a branch: every run id that appears in a commit subject
// reachable from that ref must have an entry in the ledger at that ref. That is
// what makes a silently reopened gap loud.
//
// Usage:
//   node gate-ledger.mjs [--base <ref>] [--repo <dir>] [--json]
//   node gate-ledger.mjs --history [<ref>] [--repo <dir>] [--json]
//
// `--base` may only **narrow**, exactly as in `gate-scope.mjs`: it must be an
// ancestor of the computed merge base, so it can pin an older reviewed commit and
// can never select anything this branch authored. There is no `--force`, no
// `--skip`, and no environment variable; ADR 0006's guardrails forbid adding one.
// An unrecognised flag exits 2.
//
// Exit 0 = the entry reconciles with the change. Exit 1 = it does not, do not
// auto-merge. Exit 2 = the gate could not run, which is never treated as a pass.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The ledger itself. In the qualifying class as of ADR 0006, and never counted as a dataset document. */
const LEDGER_PATH = 'web/src/data/refresh-runs.json';

/**
 * The documents a run reports on. Exactly `gate-scope.mjs`'s `ALLOWED_PATHS`
 * minus the ledger, because an entry describes the dataset it changed and never
 * describes itself. A self-test asserts the two lists stay in step, so a document
 * cannot be added to one and forgotten in the other.
 */
const DATASET_PATHS = new Set([
  'web/src/data/sources.json',
  'web/src/data/publishers.json',
  'web/src/data/organizations.json',
  'web/src/data/families.json',
  'web/src/data/releases.json',
  'web/src/data/products.json',
  'web/src/data/serving-platforms.json',
  'web/src/data/deployments.json',
  'web/src/data/release-events.json',
  'web/src/data/benchmarks.json',
  'web/src/data/benchmark-results.json',
  'web/src/data/usage-observations.json',
  'web/src/data/usage-syntheses.json',
  'web/src/data/model-fit-statements.json',
  'web/src/data/model-fit-evidence-gaps.json',
]);

// Identical to `gate-scope.mjs`'s, on purpose. A local `main` is a ref this
// working copy can move, and an anchor the run can move is not an anchor.
const PUBLISHED_REF = 'refs/remotes/origin/main';

/** The run id form `refresh-log-schema.ts` enforces, matched where a commit subject declares one. */
const RUN_ID = /\(run (\d{4}-\d{2}-\d{2}-[0-9a-f]{6})\)/g;

function parseArgs(argv) {
  const args = { base: null, repo: null, json: false, help: false, history: null, historyMode: false };
  const value = (i, flag) => {
    const next = argv[i];
    if (typeof next !== 'string' || next.length === 0) {
      process.stderr.write(`gate-ledger: ${flag} needs a value\n`);
      process.exit(2);
    }
    return next;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--base') args.base = value(++i, '--base');
    else if (flag === '--repo') args.repo = value(++i, '--repo');
    else if (flag === '--json') args.json = true;
    else if (flag === '--history') {
      args.historyMode = true;
      // The ref is optional, so a following token is only consumed when it is
      // not itself a flag. `--history --json` must not eat `--json`.
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) args.history = argv[++i];
    } else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`gate-ledger: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  if (args.historyMode && args.base !== null) {
    process.stderr.write('gate-ledger: --base is meaningless with --history, which reads whole history\n');
    process.exit(2);
  }
  return args;
}

function repoRoot() {
  // .github/skills/modeltree-gates/scripts/gate-ledger.mjs -> up five.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The commit the change is measured from. Resolved exactly as `gate-scope.mjs`
 * resolves it, and every failure throws, because an anchor the gate cannot
 * resolve means it does not know what changed - and "I do not know" is never a
 * pass.
 */
function resolveAnchor(cwd, requested) {
  let published;
  try {
    published = git(cwd, 'rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`).trim();
  } catch {
    throw new Error(
      `cannot resolve ${PUBLISHED_REF}, so there is no published history to measure this change `
      + 'against. A shallow or single-branch clone will do this; fetch main before gating',
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
    git(cwd, 'merge-base', '--is-ancestor', pinned, anchor);
  } catch {
    throw new Error(
      `--base ${requested} (${pinned.slice(0, 10)}) is not an ancestor of the merge base with `
      + `${PUBLISHED_REF} (${anchor.slice(0, 10)}), so it would hide commits this branch authored. `
      + '--base may only narrow the anchor to an older reviewed commit, never widen it',
    );
  }
  return { anchor: pinned, published, requested };
}

/** A JSON array at a committed ref. A path absent at that ref reads as empty rather than throwing: a document this branch creates has no "before". */
function readArrayAtRef(cwd, ref, path) {
  let raw;
  try {
    raw = git(cwd, 'show', `${ref}:${path}`);
  } catch {
    return { present: false, records: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} at ${ref.slice(0, 10)} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} at ${ref.slice(0, 10)} is not a JSON array`);
  return { present: true, records: parsed };
}

/**
 * A JSON array as it will be committed: the working tree where the file exists,
 * which is what the interactive loop edits, and `HEAD` otherwise. Reading the
 * working tree rather than `HEAD` is deliberate - gating an uncommitted entry is
 * the normal loop, and a gate that only saw committed state would pass an entry
 * before it was written and fail it after.
 */
function readArrayAtWorkingTree(cwd, path) {
  const onDisk = join(cwd, path);
  if (!existsSync(onDisk)) return readArrayAtRef(cwd, 'HEAD', path);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(onDisk, 'utf8'));
  } catch (error) {
    throw new Error(`${path} in the working tree is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} in the working tree is not a JSON array`);
  return { present: true, records: parsed };
}

/**
 * Every path this change touches, relative to the anchor - the union of what the
 * branch committed and what the working tree holds on top of it. Neither half
 * replaces the other, for the reason `gate-scope.mjs` states at length: a change
 * that is half committed and half on disk has to be reported whole.
 */
function changedPaths(cwd, anchor) {
  const paths = new Set();
  const add = (output) => {
    for (const line of output.split('\n')) {
      const path = line.trim();
      if (path.length > 0) paths.add(path);
    }
  };
  add(git(cwd, 'diff', '--name-only', `${anchor}...HEAD`));
  add(git(cwd, 'diff', '--name-only'));
  add(git(cwd, 'diff', '--name-only', '--cached'));
  add(git(cwd, 'ls-files', '--others', '--exclude-standard'));
  return [...paths].sort();
}

/** Run ids declared in commit subjects, mapped to the commits declaring them. */
function declaredRunIds(cwd, range) {
  const out = git(cwd, 'log', '--no-merges', '--format=%H%x00%s', range);
  const declared = new Map();
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    const [sha, subject = ''] = line.split('\0');
    for (const match of subject.matchAll(RUN_ID)) {
      const id = match[1];
      if (!declared.has(id)) declared.set(id, []);
      declared.get(id).push(sha.slice(0, 10));
    }
  }
  return declared;
}

/** Rules 1 and 2: what the entry says about the dataset, against what the dataset did. */
function reconcileEntry(cwd, anchor, entry, changedDatasetPaths) {
  const failures = [];
  const documents = Array.isArray(entry?.posted?.documents) ? entry.posted.documents : [];

  const declared = new Map();
  for (const document of documents) {
    const name = typeof document?.document === 'string' ? basename(document.document) : '';
    if (name.length === 0) {
      failures.push('an entry in posted.documents has no document name');
      continue;
    }
    if (declared.has(name)) {
      failures.push(`posted.documents names ${name} twice`);
      continue;
    }
    declared.set(name, document);
  }

  const changedNames = new Set(changedDatasetPaths.map((path) => basename(path)));

  // Rule 1, both directions. A document changed but undeclared is the run
  // editing something it did not report; a document declared but unchanged is
  // the run reporting something it did not do.
  for (const name of [...changedNames].sort()) {
    if (!declared.has(name)) {
      failures.push(
        `${name} changed but posted.documents does not mention it, so the entry under-reports the change`,
      );
    }
  }
  for (const name of [...declared.keys()].sort()) {
    if (!changedNames.has(name)) {
      failures.push(
        `posted.documents claims ${name} changed, but it is identical to the anchor`,
      );
    }
  }

  // Rule 2. Counted at both ends, never taken from the entry.
  for (const [name, document] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `web/src/data/${name}`;
    if (!DATASET_PATHS.has(path)) {
      failures.push(`posted.documents names ${name}, which is not a dataset document a run may change`);
      continue;
    }
    const before = readArrayAtRef(cwd, anchor, path).records.length;
    const after = readArrayAtWorkingTree(cwd, path).records.length;
    if (document.recordsBefore !== before) {
      failures.push(
        `${name} reports recordsBefore ${document.recordsBefore} but held ${before} records at the anchor`,
      );
    }
    if (document.recordsAfter !== after) {
      failures.push(
        `${name} reports recordsAfter ${document.recordsAfter} but holds ${after} records now`,
      );
    }
  }

  return failures;
}

function gateBranch(cwd, args) {
  const anchor = resolveAnchor(cwd, args.base);

  const before = readArrayAtRef(cwd, anchor.anchor, LEDGER_PATH);
  const after = readArrayAtWorkingTree(cwd, LEDGER_PATH);
  const knownIds = new Set(before.records.map((run) => run?.id).filter((id) => typeof id === 'string'));
  const addedEntries = after.records.filter(
    (run) => typeof run?.id === 'string' && !knownIds.has(run.id),
  );
  const addedIds = new Set(addedEntries.map((run) => run.id));
  // The other direction, which is the whole point of rule 6. Everything above
  // asks what the working tree gained; only this asks what it lost. An additive
  // check nets out a swap - drop a published run, add a well-formed one, and
  // every count above agrees with itself.
  const afterIds = new Set(after.records.map((run) => run?.id).filter((id) => typeof id === 'string'));
  const removedIds = [...knownIds].filter((id) => !afterIds.has(id));

  const paths = changedPaths(cwd, anchor.anchor);
  const changedDatasetPaths = paths.filter((path) => DATASET_PATHS.has(path));
  // The qualifying class exactly as `gate-scope.mjs` computes it: the dataset
  // documents plus the ledger. Recomputed here rather than imported because the
  // two scripts are invoked independently and a gate that depends on another
  // gate having run is a gate that can be skipped. A self-test pins them equal.
  const outOfClass = paths.filter((path) => !DATASET_PATHS.has(path) && path !== LEDGER_PATH);

  const failures = [];

  // Rule 3. One run, once. Two entries in one branch means two runs squashed
  // into one revertable commit, which breaks the "a bad run is one revert"
  // property ADR 0003 relies on.
  if (addedEntries.length > 1) {
    failures.push(
      `adds ${addedEntries.length} ledger entries (${addedEntries.map((run) => run.id).join(', ')}); `
      + 'a branch records one run',
    );
  }

  // Rules 1 and 2, which have nothing to check when no entry was added. An
  // ordinary data change that records no run is not required to.
  //
  // The distinction that decides whether they apply is mechanical rather than a
  // judgement about intent: **did this branch change any dataset document?**
  //
  //   - It did. Then the entry describes a change this branch is making, which
  //     is a run recording itself, and the entry is checked against that change.
  //     This is the case ADR 0006 exists for and the case where a self-authored
  //     report card would otherwise go unchecked.
  //   - It did not. Then the entry describes work already published under some
  //     earlier commit, which is a transcription - the hand backfills of #422,
  //     #577 and #607, and any later correction to a historical entry. There is
  //     no diff on this branch to reconcile it against, and refusing it would
  //     block the only repair route available when an entry does turn out wrong.
  //     Rules 3 and 4 still apply, and the report says plainly that the numbers
  //     went unchecked rather than passing silently.
  //
  // Transcription is expected to be rare now: a run that records itself leaves
  // nothing to transcribe. If these start appearing again, the mechanism has
  // regressed and `--history` is the check that will say so.
  const transcription = changedDatasetPaths.length === 0;
  if (!transcription) {
    for (const entry of addedEntries) {
      for (const failure of reconcileEntry(cwd, anchor.anchor, entry, changedDatasetPaths)) {
        failures.push(`${entry.id}: ${failure}`);
      }
    }
  }

  // Rule 6, first half: nothing published may vanish. This half holds in every
  // mode, transcription included - repairing an entry is editing it, never
  // dropping it, and a branch that removes a published run is rewriting the
  // record of what reached `main` regardless of why it says it is doing so.
  if (removedIds.length > 0) {
    failures.push(
      `removes ${removedIds.length} recorded run(s) (${removedIds.sort().join(', ')}) from `
      + `${LEDGER_PATH}. The ledger is append-only: it is the public record of what `
      + 'reached `main` unattended, and a run may not edit that record (ADR 0006)',
    );
  }

  // Rule 6, second half: in run mode the entries that were already there must be
  // untouched and in the same order. Comparing ids alone would miss a run that
  // keeps every id and rewrites the numbers inside one - the counts in a prior
  // entry describe a diff that is not in front of this gate, so there is nothing
  // to re-derive them from and the only safe statement is that they may not move.
  // Transcription is exempt by design: editing a historical entry in place is
  // precisely the repair route ADR 0006 keeps open.
  if (!transcription) {
    const withId = (records) => records.filter((run) => typeof run?.id === 'string');
    const priorAfter = withId(after.records).filter((run) => !addedIds.has(run.id));
    const serialise = (records) => records.map((run) => JSON.stringify(run));
    const priorBefore = serialise(withId(before.records));
    const priorNow = serialise(priorAfter);
    if (priorBefore.length === priorNow.length) {
      const priorBeforeRecords = withId(before.records);
      const moved = [];
      for (let i = 0; i < priorBefore.length; i += 1) {
        if (priorBefore[i] !== priorNow[i]) moved.push(priorBeforeRecords[i]?.id ?? `index ${i}`);
      }
      if (moved.length > 0) {
        failures.push(
          `alters ${moved.length} entry/entries already recorded at the anchor (${moved.join(', ')}) `
          + 'while publishing a run. A run appends its own entry and leaves the rest alone; '
          + 'correcting a historical entry is a separate change that publishes no data (ADR 0006)',
        );
      }
    }
  }

  // Rule 5. A change confined to the qualifying class merges with nobody
  // watching, so it has to appear on the page that records what did.
  //
  // The trigger is deliberately not self-reported. A `(run <id>)` marker is
  // written by the run, so a run that omits both the marker and the entry would
  // satisfy a marker-triggered rule by staying silent - absence as the cheaper
  // path, which is the failure this whole gate exists to remove. What the run
  // cannot fake is the shape of its own diff, measured from an anchor it cannot
  // move: changing a dataset document and nothing outside the class *is* the
  // qualifying class, computed the same way `gate-scope.mjs` computes it.
  //
  // An ordinary human data change is not caught, because it is not in this set:
  // in practice it carries a test, a schema tweak, a component, or a source
  // note, all of which are out of class. One confined so exactly to the dataset
  // documents that it is indistinguishable from a refresh is treated as one -
  // correctly, because at the only boundary that matters it behaves like one.
  // The escape is not a flag; it is to stop being an unattended change, and a
  // human-merged pull request is out of class the moment it touches anything
  // else.
  if (!transcription && outOfClass.length === 0 && addedEntries.length === 0) {
    failures.push(
      `changes ${changedDatasetPaths.length} dataset document(s) and nothing outside the `
      + `qualifying class, so this may auto-merge unattended (ADR 0003), but adds no entry to `
      + `${LEDGER_PATH}. A change that can reach \`main\` with no human approving it records `
      + 'itself on the /refresh page (ADR 0006). This is the #419 failure exactly: the page went '
      + 'stale because publishing without recording was the cheaper path. If this is a refresh '
      + 'run, add its entry. If it is a hand edit that records no run, it is shaped exactly like '
      + 'an unattended publish and the gate cannot tell them apart from the diff, so say so in '
      + 'the pull request and let a human merge it - this gate does not run in CI and does not '
      + 'block that',
    );
  }

  // Rule 4. A commit that names its run id has promised an entry *here*. Matched
  // against the entries this branch adds and not against the whole ledger: an id
  // the anchor already records is not a new run, and letting a pre-existing entry
  // satisfy the promise is how a reused id passes as compliance.
  const declared = declaredRunIds(cwd, `${anchor.anchor}..HEAD`);
  for (const [id, commits] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    if (addedIds.has(id)) continue;
    if (knownIds.has(id)) {
      failures.push(
        `commit ${commits.join(', ')} declares run ${id}, which ${LEDGER_PATH} already recorded `
        + 'at the anchor. A run id names one run once, so this is either a reused id or an '
        + 'entry that was never added (ADR 0006)',
      );
      continue;
    }
    failures.push(
      `commit ${commits.join(', ')} declares run ${id}, but no entry for it reaches `
      + `${LEDGER_PATH}. A published run records itself (ADR 0006)`,
    );
  }

  return {
    mode: 'branch',
    repo: cwd,
    anchor: {
      commit: anchor.anchor,
      publishedRef: PUBLISHED_REF,
      publishedCommit: anchor.published,
      selectedBy: anchor.requested === null
        ? `merge-base with ${PUBLISHED_REF}`
        : `--base ${anchor.requested}, narrowed from the merge-base with ${PUBLISHED_REF}`,
      requestedBase: anchor.requested,
    },
    // `true` means the entry's numbers were NOT checked against a diff, because
    // there was none on this branch to check them against. A reader has to be
    // able to tell a reconciled entry from an unreconciled one, so this is
    // reported rather than inferred from the absence of failures.
    transcription: transcription && addedEntries.length > 0,
    changedDatasetDocuments: changedDatasetPaths,
    // Empty means this change is confined to the qualifying class and so may
    // merge unattended, which is what makes rule 5 apply. Reported because it is
    // the input to that rule and a reader should not have to re-derive it.
    outOfClass,
    unattended: outOfClass.length === 0 && changedDatasetPaths.length > 0,
    entriesAdded: addedEntries.map((run) => run.id),
    entriesRemoved: [...removedIds].sort(),
    runIdsDeclared: [...declared.keys()].sort(),
    failures,
    passed: failures.length === 0,
  };
}

function gateHistory(cwd, args) {
  const ref = args.history ?? PUBLISHED_REF;
  let commit;
  try {
    commit = git(cwd, 'rev-parse', '--verify', `${ref}^{commit}`).trim();
  } catch {
    throw new Error(`cannot resolve ${ref}, so there is no history to check`);
  }

  const ledger = readArrayAtRef(cwd, commit, LEDGER_PATH);
  if (!ledger.present) throw new Error(`${LEDGER_PATH} does not exist at ${ref}`);
  const recordedIds = new Set(ledger.records.map((run) => run?.id));

  const declared = declaredRunIds(cwd, commit);
  const failures = [];
  for (const [id, commits] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    if (!recordedIds.has(id)) {
      failures.push(
        `${ref} holds commit ${commits.join(', ')} publishing run ${id}, which has no entry in `
        + `${LEDGER_PATH}. The /refresh page is missing a run it published`,
      );
    }
  }

  return {
    mode: 'history',
    repo: cwd,
    ref,
    commit,
    runsDeclared: declared.size,
    runsRecorded: recordedIds.size,
    failures,
    passed: failures.length === 0,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'usage: gate-ledger.mjs [--base <ref>] [--repo <dir>] [--json]\n'
      + '       gate-ledger.mjs --history [<ref>] [--repo <dir>] [--json]\n',
    );
    return 0;
  }

  const cwd = args.repo ? resolve(args.repo) : repoRoot();
  if (!existsSync(cwd)) {
    process.stderr.write(`gate-ledger: no directory at ${cwd}\n`);
    return 2;
  }

  let result;
  try {
    result = args.historyMode ? gateHistory(cwd, args) : gateBranch(cwd, args);
  } catch (error) {
    process.stderr.write(`gate-ledger: ${error.message}\n`);
    return 2;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.passed ? 0 : 1;
  }

  if (!result.passed) {
    process.stdout.write(
      `gate-ledger: REFUSED - ${result.failures.length} finding(s). ADR 0006 does not authorise `
      + 'auto-merging this.\n',
    );
    for (const failure of result.failures) process.stdout.write(`  ${failure}\n`);
    return 1;
  }

  if (result.mode === 'history') {
    process.stdout.write(
      `gate-ledger: ${result.ref} publishes ${result.runsDeclared} declared run(s), and the ledger `
      + `records ${result.runsRecorded}. Every published run has its entry.\n`,
    );
    return 0;
  }

  if (result.entriesAdded.length === 0) {
    process.stdout.write(
      `gate-ledger: no ledger entry added since ${result.anchor.commit.slice(0, 10)}, and no commit `
      + 'declares a run id.\n',
    );
    // Why that was allowed is the whole of rule 5, so say which branch of it
    // applied rather than leaving a reader to infer it from silence.
    if (result.changedDatasetDocuments.length === 0) {
      process.stdout.write('  This branch changes no dataset document, so it publishes no run.\n');
    } else {
      process.stdout.write(
        `  This branch changes ${result.changedDatasetDocuments.length} dataset document(s) but also `
        + `${result.outOfClass.length} file(s) outside the qualifying class, so it cannot merge `
        + 'unattended and is not a refresh run recording itself.\n',
      );
    }
    return 0;
  }

  if (result.transcription) {
    process.stdout.write(
      `gate-ledger: ${result.entriesAdded.join(', ')} is a transcription - this branch changes no `
      + 'dataset document, so the entry describes work published earlier and its record counts '
      + 'were NOT checked against a diff. Read it as unverified.\n',
    );
    return 0;
  }

  process.stdout.write(
    `gate-ledger: ${result.entriesAdded.join(', ')} reconciles with the change it describes - `
    + `${result.changedDatasetDocuments.length} dataset document(s) counted at `
    + `${result.anchor.commit.slice(0, 10)} and now.\n`,
  );
  return 0;
}

process.exit(main());
