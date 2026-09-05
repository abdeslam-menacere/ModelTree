#!/usr/bin/env node
// Self-tests for the deterministic gates. Run with:
//   node --test .github/skills/modeltree-gates/scripts/
//
// The point of these is narrow and specific: a gate that has only ever been
// seen to pass is indistinguishable from a gate that cannot fail. Every rule
// below is proved to fire by breaking the data in exactly the way it exists to
// catch, and the live repository dataset is asserted to pass, so the suite
// fails both when a gate goes blind and when a gate goes paranoid.
//
// No dependencies. Node's built-in runner only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, cpSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DATA = join(REPO, 'web', 'src', 'data');
const GATE_DATASET = join(HERE, 'gate-dataset.mjs');
const GATE_EVIDENCE = join(HERE, 'gate-evidence.mjs');
const GATE_SCOPE = join(HERE, 'gate-scope.mjs');
const GATE_LEDGER = join(HERE, 'gate-ledger.mjs');
const GATE_SOURCE_APPROVAL = join(HERE, 'gate-source-approval.mjs');
const GATE_REVERSALS = join(HERE, 'gate-reversals.mjs');

// ---------------------------------------------------------------------------
// Two clocks, and which tests may use which (#318)
//
// A gate that reads dates has to be told what "today" is, and the honest answer
// differs between a fixture and the live dataset. Both kinds live in this file,
// so the rule is written here rather than left to be inferred per test.
//
// PINNED (`TODAY`) -- every fixture test, meaning everything from the
// `gate-evidence` block down. A fixture's dates are literals written next to the
// assertion, so anchoring them to a fixed day is what makes a suite that passes
// today still pass in a year. Real "today" is never used there: those tests
// would then drift.
//
// REAL (no `--today` at all) -- the `gate-dataset` block, which gates the *live*
// repository dataset, directly or through a mutated copy. Its dates are claims
// about the real world, and "no record is dated after today" is a claim only the
// real clock can settle. Omitting the flag lets `gate-dataset.mjs` use its own
// clock, which is also the code path `node gate-dataset.mjs` takes in CI, so
// there is no second clock here that could disagree with the gate's.
//
// Pinning a day for the live data is exactly what turned main red in #318: the
// 2026-08-26 refresh landed, a frozen 2026-08-25 read it as the future, and
// every data refresh thereafter would have needed a correlated edit to this
// file. Do not re-merge the two clocks.
//
// Rejected alternative: derive the live clock from the data, e.g. the maximum
// `verifiedAt` present. It cannot drift, which is the appeal, but it is
// self-fulfilling -- the maximum date present is by construction never after
// itself, so the future-date rule could no longer fail on the live data at all.
// That rule catches a real thing (a refresh writing tomorrow's date, a machine
// with a skewed clock), so deriving the clock would have bought a green suite by
// giving up a live check.
//
// The cost accepted instead is that the live-dataset tests' verdict depends on
// the wall clock. That is the correct dependency rather than drift: drift is
// when an assertion's *meaning* changes as the clock moves, and here the meaning
// is fixed while only its referent moves -- which is the rule itself.
//
// A test that simulates some *other* day passes it explicitly via
// `gateDatasetAt`, so a supplied clock in this file always means "a day being
// simulated on purpose", never "today".
// ---------------------------------------------------------------------------

/** The pinned clock. Fixtures only -- never aim this at the live dataset. */
const TODAY = '2026-08-25';

/** The real clock, in the same UTC form `gate-dataset.mjs` computes for itself. */
function realToday() {
  return new Date().toISOString().slice(0, 10);
}

/** `days` after `date` (negative for before), as YYYY-MM-DD. */
function shiftDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function run(script, args) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    return { code: error.status, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * A scratch copy of the real dataset, mutated by `edit`, then gated on the real
 * clock. The copy is still the live data, so its dates are still claims about
 * the real world; see the clock note above. Use `gateDatasetAt` when a test
 * means to simulate a particular day.
 *
 * `touches` is the mutation's declared footprint and is not optional; see the
 * note on `assertTouched` for the grammar and for why it has to be stated.
 */
function gateMutatedDataset(edit, touches) {
  return gateDatasetCopy(edit, touches, []);
}

/**
 * As `gateMutatedDataset`, but judged on a stated day. Only for tests that
 * simulate a specific date on purpose -- never as a stand-in for "today".
 */
function gateDatasetAt(today, edit, touches) {
  return gateDatasetCopy(edit, touches, ['--today', today]);
}

function gateDatasetCopy(edit, touches, clockArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
  try {
    cpSync(DATA, dir, { recursive: true });
    const before = snapshotDocuments(dir);
    const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const write = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
    edit({ read, write });
    assertTouched(datasetFootprint(before, snapshotDocuments(dir)), touches, documentSizes(before));
    return run(GATE_DATASET, ['--data', dir, ...clockArgs, '--json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The input side of attribution (#866)
//
// `assertFailed` below closes the *output* side: it refuses a test whose result
// carries a gate failure the test never declared. It cannot close the input
// side, because it never sees the mutation -- `edit({ read, write })` reaches
// the harness as an opaque closure and may change one field or fifty.
//
// The gap that leaves is precise. If a mutation changes two things and both
// provoke the same declared gate, the report is clean, `alsoFails` is empty and
// correct, every assertion passes -- and the test still has not established
// which component caused the failure. The output-side check is satisfied
// exactly as well by an attributable test as by an unattributable one, because
// it inspects the wrong end. Worse, a bundle with an *inert* component is
// byte-identical in its output to the sole effective component, so nothing in
// the report distinguishes them at all. That is what happened on #840: a probe
// reported as a truncation test whose truncation removed zero flagged records,
// so its exit 1 came entirely from a deletion bundled beside it.
//
// So the mutation declares its own footprint, and the footprint is measured
// rather than trusted: `gateDatasetCopy` already holds the dataset immediately
// before and immediately after `edit` runs, so the measurement is a diff of two
// in-memory states and no new machinery. The declaration is checked in **both**
// directions for the same reason `alsoFails` is -- a declaration that only had
// to be an upper bound would decay into a wildcard, which is the defect this is
// modelled on rather than a defect to re-introduce on the other side.
//
// There is deliberately no way to opt out. `touches` is a required argument, an
// omitted one is refused, and `[]` is not a bypass but the strictest possible
// declaration: it says the edit changed nothing, and any change at all then
// fails.
// ---------------------------------------------------------------------------

/**
 * A JSON value in a form that two structurally equal values always render
 * identically, so an object whose keys were rewritten in a different order does
 * not read as a change. Arrays keep their order, because for these documents
 * order is content.
 *
 * `undefined` renders distinctly from `null` and from a missing key rendering
 * as anything else, which is what lets `delete entry.status` be a change rather
 * than silence.
 */
function stableJson(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isJsonRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isJsonRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every leaf path at which two records differ, as dotted field paths.
 *
 * Plain objects are recursed into so that `parameters.overallScore` is reported
 * rather than `parameters`; arrays and scalars are leaves compared whole, so
 * `sourceIds` is one path rather than one path per member. That asymmetry is
 * the useful one: a nested object is a namespace, where an array is a value.
 */
function changedFieldPaths(before, after, prefix = '') {
  const keys = [
    ...new Set([
      ...(isJsonRecord(before) ? Object.keys(before) : []),
      ...(isJsonRecord(after) ? Object.keys(after) : []),
    ]),
  ].sort();
  const paths = [];
  for (const key of keys) {
    const a = isJsonRecord(before) ? before[key] : undefined;
    const b = isJsonRecord(after) ? after[key] : undefined;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isJsonRecord(a) && isJsonRecord(b)) {
      paths.push(...changedFieldPaths(a, b, path));
      continue;
    }
    if (stableJson(a) !== stableJson(b)) paths.push(path);
  }
  return paths;
}

/** A sentinel for a document that is present but did not parse. */
const UNPARSEABLE = Symbol('unparseable');

/** Every `*.json` document in `dir`, parsed, keyed by file name. */
function snapshotDocuments(dir) {
  const snapshot = new Map();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      snapshot.set(entry, JSON.parse(readFileSync(join(dir, entry), 'utf8')));
    } catch {
      snapshot.set(entry, UNPARSEABLE);
    }
  }
  return snapshot;
}

/** How many records each document held, keyed by the label a descriptor uses. */
function documentSizes(snapshot) {
  const sizes = new Map();
  for (const [file, value] of snapshot) {
    sizes.set(documentLabel(file), Array.isArray(value) ? value.length : null);
  }
  return sizes;
}

function documentLabel(file) {
  return file.replace(/\.json$/, '');
}

/**
 * The records of `entries` keyed by id, or `null` when they cannot be: a
 * non-object, a missing id, or a duplicate id all defeat identity matching.
 *
 * Matching on id rather than on position is what keeps a declaration stable as
 * the dataset grows. A test that edits `entries[0]` declares the same thing
 * next month; a test that removes one record declares one removal rather than a
 * path for every index the removal shifted.
 */
function recordsById(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!isJsonRecord(entry) || typeof entry.id !== 'string' || byId.has(entry.id)) return null;
    byId.set(entry.id, entry);
  }
  return byId;
}

function tallied(verb, label, counts) {
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, count]) => `${verb} ${count} ${label}${path ? `.${path}` : ''}`);
}

/** What one document's before/after states say the edit did to it. */
function documentFootprint(label, before, after) {
  if (before === UNPARSEABLE || after === UNPARSEABLE || !Array.isArray(before) || !Array.isArray(after)) {
    return stableJson(before) === stableJson(after) ? [] : [`replaced ${label}`];
  }

  const beforeById = recordsById(before);
  const afterById = recordsById(after);
  // Identity matching is the readable case and the one every gate document
  // admits today. Where it is unavailable the footprint degrades to a single
  // coarse descriptor rather than to silence: a mutation that duplicates an id
  // still has to be declared, it just cannot be described finely.
  if (!beforeById || !afterById) {
    return stableJson(before) === stableJson(after) ? [] : [`replaced ${label}`];
  }

  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id));
  const added = [...afterById.keys()].filter((id) => !beforeById.has(id));
  const surviving = [...beforeById.keys()].filter((id) => afterById.has(id));
  const stillOrdered = [...afterById.keys()].filter((id) => beforeById.has(id));

  const paths = new Map();
  for (const id of surviving) {
    for (const path of changedFieldPaths(beforeById.get(id), afterById.get(id))) {
      paths.set(path, (paths.get(path) ?? 0) + 1);
    }
  }

  const descriptors = tallied('changed', label, paths);
  if (removed.length > 0) descriptors.push(`removed ${removed.length} ${label}`);
  if (added.length > 0) descriptors.push(`added ${added.length} ${label}`);
  if (stableJson(surviving) !== stableJson(stillOrdered)) descriptors.push(`reordered ${label}`);
  return descriptors;
}

/** What the whole dataset's before/after states say the edit did. */
function datasetFootprint(before, after) {
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  const descriptors = [];
  for (const file of files) {
    const label = documentLabel(file);
    if (!before.has(file)) descriptors.push(`added document ${label}`);
    else if (!after.has(file)) descriptors.push(`removed document ${label}`);
    else descriptors.push(...documentFootprint(label, before.get(file), after.get(file)));
  }
  return descriptors.sort();
}

/**
 * The grammar a declared descriptor has to be written in. Anything else is
 * refused rather than ignored: a typo that silently matched nothing would be an
 * over-declaration reported against the wrong name, and a declaration nobody
 * can parse is the one shape that could quietly become permission.
 */
const DESCRIPTOR = new RegExp(
  '^(?:'
  + 'changed (?:\\d+|all) [a-z0-9-]+\\.[A-Za-z0-9_.[\\]-]+'
  + '|added \\d+ [a-z0-9-]+'
  + '|removed (?:\\d+|all) [a-z0-9-]+'
  + '|reordered [a-z0-9-]+'
  + '|replaced [a-z0-9-]+'
  + '|(?:added|removed) document [a-z0-9-]+'
  + ')$',
);

/**
 * `all` in a declaration, resolved against how many records the document
 * actually held before the edit.
 *
 * `all` is not a wildcard. It is the claim that the change reached every record
 * in the collection, and it is expanded to that number and then compared
 * exactly, so a mutation that reached all but one fails. It exists because the
 * alternative for a whole-collection edit is a literal count that a data
 * refresh would have to keep re-editing, which is a rule the dataset would
 * break rather than a rule the test would keep.
 *
 * A document that held no records is refused outright. `removed all X` over an
 * empty X is a component that did nothing, and an inert component is precisely
 * what this check exists to make visible.
 */
function expandDeclared(descriptor, sizes) {
  const match = /^(changed|removed) all ([a-z0-9-]+)((?:\.[A-Za-z0-9_.[\]-]+)?)$/.exec(descriptor);
  if (!match) return descriptor;
  const [, verb, label, path] = match;
  const size = sizes.get(label);
  assert.ok(
    typeof size === 'number',
    `touches declares "${descriptor}", but ${label} is not a dataset document that holds records. `
      + `Documents: ${[...sizes.keys()].sort().join(', ')}.`,
  );
  assert.ok(
    size > 0,
    `touches declares "${descriptor}", but ${label} held no records before the edit, so "all" of it is `
      + 'nothing. A component that cannot change anything is an inert component, and naming one here is '
      + 'the declaration claiming work the mutation did not do.',
  );
  return `${verb} ${size} ${label}${path}`;
}

/**
 * Asserts the edit changed exactly what the test said it would change.
 *
 * The declaration is a list of descriptors in one of these forms, where the
 * label is a dataset document's file name without `.json`:
 *
 *   changed <n|all> <label>.<field.path>   n records changed at that path
 *   removed <n|all> <label>                n records left the collection
 *   added <n> <label>                      n records joined it
 *   reordered <label>                      the surviving records moved
 *   replaced <label>                       the document changed in a way
 *                                          identity matching cannot describe
 *   added|removed document <label>         the file itself appeared or vanished
 *
 * Both directions are checked, and the symmetry is the point rather than
 * politeness. Under-declaring is the failure this exists to catch -- a second
 * component riding along unnamed. Over-declaring is checked because a
 * declaration that only had to be an upper bound would decay into a wildcard,
 * which is exactly what `alsoFails` was hardened against on the output side; it
 * also happens to be the only thing that can see an inert component, since a
 * component that changed nothing leaves nothing in the footprint to match.
 *
 * A wrong *count* under a right name is reported as its own third thing rather
 * than as one of those two, because it is neither and reading it as either
 * misdirects: "changed 1 releases.verifiedAt" against a mutation that changed
 * two of them is a component that did more than it said, not a component that
 * did nothing and not a component nobody named.
 */
function assertTouched(touched, declared, sizes) {
  assert.ok(
    Array.isArray(declared),
    'every mutated-dataset run must declare what its mutation touches, as an array of descriptors. '
      + `This one declared ${JSON.stringify(declared) ?? 'nothing'}. `
      + `The edit touched: ${touched.join(', ') || '(nothing)'}.`,
  );
  for (const descriptor of declared) {
    assert.ok(
      typeof descriptor === 'string' && DESCRIPTOR.test(descriptor),
      `touches contains ${JSON.stringify(descriptor)}, which is not a descriptor this harness can read. `
        + 'Use "changed <n|all> <document>.<field.path>", "removed <n|all> <document>", '
        + '"added <n> <document>", "reordered <document>", "replaced <document>", '
        + 'or "added|removed document <document>".',
    );
  }

  const expanded = declared.map((descriptor) => expandDeclared(descriptor, sizes));
  const touchedBy = new Map(touched.map((descriptor) => [descriptorName(descriptor), descriptor]));
  const declaredBy = new Map(expanded.map((descriptor) => [descriptorName(descriptor), descriptor]));
  assert.equal(
    declaredBy.size,
    expanded.length,
    `touches names the same component twice: ${expanded.join(', ')}. One descriptor per component.`,
  );

  const stale = expanded.filter((descriptor) => !touchedBy.has(descriptorName(descriptor)));
  assert.deepEqual(
    stale,
    [],
    `touches declares ${stale.join(', ')}, but the edit did nothing under that name. `
      + `What it did touch: ${touched.join(', ') || '(nothing)'}. `
      + 'A declared component that changes nothing is an inert component: the mutation and the '
      + 'component that is actually doing the work produce identical output, so nothing downstream '
      + 'can tell them apart. Delete it, or make it do something.',
  );

  const undeclared = touched.filter((descriptor) => !declaredBy.has(descriptorName(descriptor)));
  assert.deepEqual(
    undeclared,
    [],
    `the edit made ${undeclared.length} change(s) this test never declared, so its result is not `
      + 'attributable to a single component of its own mutation:\n'
      + undeclared.map((descriptor) => `  ${descriptor}`).join('\n')
      + `\nDeclared: ${expanded.join(', ') || '(nothing)'}.`
      + `\nTouched: ${touched.join(', ') || '(nothing)'}.`
      + '\nIf the mutation is genuinely meant to be a bundle, declare every component in touches -- and '
      + 'run each component alone first, so you know which one the result came from.',
  );

  const miscounted = touched.filter(
    (descriptor) => declaredBy.get(descriptorName(descriptor)) !== descriptor,
  );
  assert.deepEqual(
    miscounted,
    [],
    'the edit reached a different number of records than this test declared, so the result is not '
      + 'attributable to the component the test names:\n'
      + miscounted
        .map((descriptor) => `  touched "${descriptor}", declared "${declaredBy.get(descriptorName(descriptor))}"`)
        .join('\n')
      + `\nDeclared: ${expanded.join(', ') || '(nothing)'}.`
      + `\nTouched: ${touched.join(', ') || '(nothing)'}.`,
  );
}

/**
 * A descriptor with its count removed, so that two descriptors about the same
 * component compare equal however many records each reached. `removed document
 * families` keeps its shape, since `document` is not a count.
 */
function descriptorName(descriptor) {
  return descriptor.replace(/^(changed|added|removed) \d+ /, '$1 ');
}

/** A committed dataset document, read straight from `web/src/data`. */
function committedDocument(file) {
  return JSON.parse(readFileSync(join(DATA, file), 'utf8'));
}

/**
 * The documents among `files` that hold at least one record today.
 *
 * Used by the mutations that empty a set of documents at once. The set is
 * derived from the committed data rather than written out because
 * `usage-syntheses.json` is legitimately empty, so emptying it is a component
 * that does nothing and `removed all usage-syntheses` would be a declaration of
 * work never done. Deriving it from the *input* keeps the declaration true as
 * the dataset grows, and constrains nothing about what else the edit may do --
 * every other change still has to be declared.
 */
function documentsHoldingRecords(files) {
  const holding = files.filter((file) => committedDocument(file).length > 0);
  assert.ok(
    holding.length > 0,
    'no document in this set holds a record, so emptying them all would change nothing',
  );
  return holding;
}

/** The footprint of writing `[]` over each of `files` that holds anything. */
function emptied(files) {
  return documentsHoldingRecords(files).map((file) => `removed all ${documentLabel(file)}`);
}

/**
 * The footprint of writing `value` at `field` on every record of each of
 * `files`, as the diff will actually see it.
 *
 * A whole-collection assignment is not a whole-collection *change*: a record
 * that already carries the value is untouched, and 66 of the 117 releases
 * already read `current`. So the count is derived from the committed data
 * rather than declared as `all`, and a document where every record already
 * carries the value contributes no descriptor at all -- which is the honest
 * reading, since for that document the mutation is inert.
 */
function assignedEverywhere(files, field, value) {
  return files
    .map((file) => [file, committedDocument(file).filter((entry) => entry[field] !== value).length])
    .filter(([, count]) => count > 0)
    .map(([file, count]) => `changed ${count} ${documentLabel(file)}.${field}`);
}

/**
 * The footprint of applying `reverified` to every record of every document.
 *
 * Which documents carry which stamp is a property of the committed data and not
 * of any test: `sources.json` carries `lastCheckedDate` and no `verifiedAt`,
 * `publishers.json` carries `control.verifiedAt` on a minority of its records
 * and no top-level `verifiedAt`, and `usage-syntheses.json` is empty and so is
 * touched by nothing. Writing that out by hand would be a fourth copy of the
 * dataset's shape, kept correct by whoever next refreshes the data; counting it
 * from the *input* keeps it true without loosening it, because every change the
 * edit makes outside this footprint still has to be declared beside it.
 */
function reverifiedFootprint(day) {
  const stamps = [
    ['verifiedAt', (entry) => entry.verifiedAt],
    ['lastCheckedDate', (entry) => entry.lastCheckedDate],
    ['control.verifiedAt', (entry) => (isJsonRecord(entry.control) ? entry.control.verifiedAt : undefined)],
  ];
  return DATASET_DOCUMENTS.flatMap((file) => {
    const records = committedDocument(file);
    return stamps
      .map(([path, valueAt]) => [path, records.filter((entry) => {
        const value = valueAt(entry);
        return value !== undefined && value !== day;
      }).length])
      .filter(([, count]) => count > 0)
      .map(([path, count]) => (count === records.length
        ? `changed all ${documentLabel(file)}.${path}`
        : `changed ${count} ${documentLabel(file)}.${path}`));
  });
}

/**
 * Every document `gate-dataset.mjs` loads, exactly as its own `DOCUMENTS` map
 * names them. This *is* a second hand-written copy of a list that file owns, and
 * saying so is the point: `gate-dataset.mjs` states its own coupling to
 * `web/src/data/raw.ts` rather than denying it, and this comment used to claim
 * the opposite about itself. What the constant buys is de-duplication between
 * the two tests below that need the whole set; that does not stop it being a
 * copy.
 *
 * Six documents joined it with abdeslam-menacere/ModelTree#495, which is also
 * why the drift check below matters more than it reads: those six sat in
 * `gate-scope.mjs`'s `ALLOWED_PATHS` -- cleared to auto-merge unattended -- while
 * this gate loaded none of them. `the qualifying class is exactly what
 * gate-dataset validates` further down is the assertion that now holds those two
 * lists to each other; this one holds the test file to the gate.
 *
 * The copy drifts in two directions and only one of them used to be audible. If
 * the gate gains a document this list does not name, `a wholesale-empty dataset
 * is refused` fails loudly -- it empties only the documents this list names, the
 * gate still finds records in the one it does not, and the expected `non-empty`
 * failure never arrives. But `a dataset refreshed on a later day still passes`
 * would re-verify only the documents it knows, leave the new one's dates in the
 * past where they are comfortably below the simulated day, and stay green while
 * covering less: the 400-day forward guard narrowing without a sound. `the
 * document list still matches the one gate-dataset.mjs owns` below is what makes
 * that half audible.
 */
const DATASET_DOCUMENTS = [
  'sources.json', 'publishers.json', 'organizations.json', 'families.json',
  'releases.json', 'products.json', 'serving-platforms.json',
  'deployments.json', 'benchmarks.json', 'benchmark-results.json',
  'release-events.json', 'usage-observations.json', 'usage-syntheses.json',
  'model-fit-statements.json', 'model-fit-evidence-gaps.json',
];

/**
 * The collections that may not be empty, written out here as the expected
 * answer rather than derived.
 *
 * `gate-dataset.mjs` derives its floors from `web/src/data/schema.ts` at run
 * time, and that asymmetry is deliberate. The gate must not restate the set,
 * because a gate and a schema disagreeing about which collections are
 * load-bearing *was* abdeslam-menacere/ModelTree#548, and a second hand-kept
 * list would only have moved the disagreement rather than closed it. A test has
 * the opposite duty: an expectation computed the way the code computes it agrees
 * with the code by construction and proves nothing, so these four are literals,
 * in the same spirit as the literal `[]` the wholesale-empty test expects.
 * `the gate derives its floors from the schema` below pins the gate's derived
 * set against them, so a `.min(1)` added to or dropped from the schema arrives
 * here as a named failure instead of as silent agreement.
 *
 * Keyed name -> file because both are needed: the gate reports a failure by
 * collection name, and a mutation empties a file.
 */
const LOAD_BEARING = {
  sources: 'sources.json',
  organizations: 'organizations.json',
  families: 'families.json',
  releases: 'releases.json',
};

/**
 * The vocabulary `lifecycleStatus` admits, written out here as the expected
 * answer rather than derived.
 *
 * The same asymmetry as `LOAD_BEARING` above, and for the same reason.
 * `gate-dataset.mjs` derives these members from `web/src/data/schema.ts` at run
 * time and must not restate them -- a gate and a schema disagreeing about which
 * lifecycle states exist *was* abdeslam-menacere/ModelTree#761, and a second
 * hand-kept list in the gate would only have moved the disagreement rather than
 * closed it. A test has the opposite duty: an expectation computed the way the
 * code computes it agrees with the code by construction and proves nothing, so
 * these six are literals. `the gate derives the lifecycle vocabulary from the
 * schema` below pins the gate's derived set against them, so a member added to
 * or removed from the schema arrives here as a named failure instead of as
 * silent agreement.
 *
 * Order matters here and does not in `LOAD_BEARING`: this is the order
 * `schema.ts` declares, and the gate reports what it read in the order it read
 * it, so comparing in order also notices a derivation that returned the right
 * members by some other route.
 */
const LIFECYCLE_STATUS = ['preview', 'current', 'legacy', 'deprecated', 'research', 'unknown'];

/**
 * The vocabulary `accessType` admits, written out here for exactly the reasons
 * given for `LIFECYCLE_STATUS` above: derived in the gate, literal in the test.
 *
 * `unknown` is last because `schema.ts` declares it last, and that placement is
 * itself deliberate there -- see
 * `docs/adr/0011-access-type-carries-an-explicit-unknown-member.md`. A member
 * arriving in the middle of this list would change the reported order and fail
 * the comparison below, which is the intended behaviour: the order is part of
 * what is being pinned.
 */
const ACCESS_TYPE = ['proprietary-hosted', 'open-weight', 'source-available', 'both', 'unknown'];

/**
 * `entry` as a refresh dated `day` would leave it: the fields a refresh rewrites
 * move to that day, and nothing else does. Three fields move, not two --
 * `verifiedAt` and `lastCheckedDate` at the top level, and the *nested*
 * `control.verifiedAt`. A second nested date-bearing structure would have to be
 * handled here too, or the dataset this returns would only look refreshed.
 * `releaseDate` and `publishedDate` are facts about the past, so moving them
 * would test a dataset no refresh produces.
 */
function reverified(entry, day) {
  const moved = { ...entry };
  for (const field of ['verifiedAt', 'lastCheckedDate']) {
    if (moved[field] !== undefined) moved[field] = day;
  }
  if (moved.control && moved.control.verifiedAt !== undefined) {
    moved.control = { ...moved.control, verifiedAt: day };
  }
  return moved;
}

/**
 * Asserts the gate failed, that it failed for the stated reason rather than any
 * reason, and -- the upper bound -- that no gate this test did not name failed
 * alongside it (#369).
 *
 * Without that upper bound every assertion here is existential: `report.failures`
 * is filtered down to `gate` and everything outside the filter is discarded
 * unexamined, so a report carrying the expected failure *plus* two unexpected
 * ones satisfies the helper exactly as well as a clean one. The test then proves
 * something weaker than its name advertises -- "this mutation causes at least
 * this failure, among an unknown number of others" rather than "this mutation
 * causes this failure".
 *
 * The harm is realised, not theoretical. During #318 the harness pinned a clock
 * the live dataset had moved past, so every test routing through
 * `gateMutatedDataset` gated genuinely-future-dated data and carried a spurious
 * `dates` failure beside the failure it was proving -- and stayed green. The
 * outage surfaced only through the tests that assert `code === 0`, which is why
 * it presented as a couple of failures rather than as the twenty-odd it was.
 *
 * A test that legitimately provokes more than one gate declares the others in
 * `alsoFails`, and a declaration is checked in **both** directions: an
 * undeclared gate that fires fails, and a declared gate that does *not* fire
 * fails too. That second half is what stops `alsoFails` decaying into the
 * wildcard this helper exists to remove -- a declaration whose cause has gone is
 * deleted rather than left standing as permanent permission to fail.
 */
function assertFailed(result, gate, fragment, { alsoFails = [] } = {}) {
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false);
  const matching = report.failures.filter((failure) => failure.gate === gate);
  assert.ok(
    matching.length > 0,
    `expected a "${gate}" failure, got: ${report.failures.map((f) => f.gate).join(', ') || '(none)'}`,
  );
  if (fragment) {
    assert.ok(
      matching.some((failure) => failure.message.includes(fragment)),
      `expected a "${gate}" failure mentioning "${fragment}", got:\n${matching.map((f) => f.message).join('\n')}`,
    );
  }

  const fired = new Set(report.failures.map((failure) => failure.gate));
  const stale = alsoFails.filter((extra) => !fired.has(extra));
  assert.deepEqual(
    stale,
    [],
    `alsoFails declares ${stale.join(', ')}, but nothing failed under that name. `
      + `Gates that did fail: ${[...fired].join(', ') || '(none)'}. `
      + 'A declaration whose cause has gone is deleted, not left standing.',
  );

  const declared = new Set([gate, ...alsoFails]);
  const undeclared = report.failures.filter((failure) => !declared.has(failure.gate));
  assert.deepEqual(
    undeclared.map((failure) => failure.gate),
    [],
    `the run also failed ${undeclared.length} gate failure(s) this test never declared, so its "${gate}" `
      + 'result is not attributable to its own mutation:\n'
      + undeclared.map((failure) => `  ${failure.gate}: ${failure.message}`).join('\n')
      + `\nDeclared: ${[...declared].join(', ')}. If these are genuinely expected, name them in alsoFails.`,
  );
}

/**
 * A throwaway repository holding a *copy of the gate itself*, so the gate can be
 * run the way the workflows run it: with no `--repo` at all.
 *
 * Both `gate-scope.mjs` and `gate-source-approval.mjs` choose their working
 * directory with
 *
 *     const cwd = args.repo ? resolve(args.repo) : repoRoot();
 *
 * and every other test in this file supplies `--repo`, which is right for
 * isolation but leaves the `repoRoot()` arm executed by nothing. Running the
 * ambient checkout instead is not an option: these two gates anchor on
 * `refs/remotes/origin/main`, and a CI clone has no such ref -- the same reason
 * the `gate-source-approval` block builds its own repository rather than gating
 * this one.
 *
 * The copy is planted at the path the original occupies **relative to this
 * repository's root**, derived rather than written out. That is what gives the
 * copy the same directory arithmetic to do as the original, so the test fails
 * both when the `..` count changes and when a gate is moved to a different depth
 * without its count being adjusted -- and it is a claim about location only, so
 * nothing here depends on the checkout's commit or on data that changes.
 *
 * `build` fills the tree and returns the argv to run the planted copy with.
 * `root` comes back resolved through `realpathSync`, because the platform temp
 * directory is a symlink on some systems and Node resolves a module's own path
 * before `import.meta.url` ever reaches `repoRoot()`.
 */
function fallbackRepo(script, build) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-fallback-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'gate@example.com');
    git('config', 'user.name', 'Gate Test');
    const planted = join(dir, relative(REPO, script));
    mkdirSync(dirname(planted), { recursive: true });
    cpSync(script, planted);
    mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'scratch\n');
    const commit = (message) => {
      git('add', '-A');
      git('commit', '-qm', message);
      return git('rev-parse', 'HEAD').trim();
    };
    const publish = () => git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
    const args = build({ dir, git, commit, publish });
    const root = realpathSync(dir);
    return { ...run(planted, args), root };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

/**
 * The helper the rest of this file leans on, exercised against synthetic reports
 * rather than by running a gate: what is under test is `assertFailed`'s own
 * arithmetic over `report.failures`, and spawning a real gate would make that
 * slower and less controllable without making it more true. An upper bound that
 * is never itself exercised is the same unproved claim this suite exists to
 * refuse -- a guard that has only ever been seen to pass is indistinguishable
 * from a guard that cannot fire (#369).
 */
describe('assertFailed', () => {
  const report = (...gates) => ({
    code: 1,
    stdout: JSON.stringify({
      passed: false,
      failures: gates.map((gate) => ({ gate, message: `${gate} went wrong` })),
    }),
  });

  test('a report carrying only the expected gate still passes, so the bound is not blanket', () => {
    assertFailed(report('dates'), 'dates');
    assertFailed(report('dates'), 'dates', 'went wrong');
  });

  test('an undeclared second gate is refused, and the refusal names it', () => {
    assert.throws(
      () => assertFailed(report('dates', 'references'), 'dates'),
      (error) => error.message.includes('references') && error.message.includes('never declared'),
      'an undeclared failure must be reported by name rather than filtered away unexamined',
    );
  });

  test('a second gate the test declares is accepted', () => {
    assertFailed(report('dates', 'references'), 'dates', undefined, { alsoFails: ['references'] });
  });

  test('a declaration that no longer fires is refused, so alsoFails cannot rot into a wildcard', () => {
    assert.throws(
      () => assertFailed(report('dates'), 'dates', undefined, { alsoFails: ['references'] }),
      /alsoFails declares references/,
    );
  });

  test('the expected gate still has to have failed at all', () => {
    assert.throws(() => assertFailed(report('references'), 'dates'), /expected a "dates" failure/);
  });
});

describe('gate-dataset', () => {
  test('the repository dataset passes as it stands', () => {
    // No `--today`: the live dataset is judged on the gate's own clock. The
    // sampled comparison below is the guard against this quietly being re-pinned
    // -- a frozen constant here passes only until the data moves past it, which
    // is #318. The UTC midnight race between this sample and the gate's own
    // `new Date()` runs one way only, so the tolerance is one-sided: `sampled` is
    // taken before the gate is spawned, and both clocks are UTC -- `realToday()`
    // here, `new Date().toISOString().slice(0, 10)` at `gate-dataset.mjs` -- so
    // the gate's day is never earlier than the sample. Only `sampled` and the day
    // after it are reachable. A third arm for the day *before* would cost the one
    // thing this assertion exists to do: a `--today` re-pinned to yesterday would
    // satisfy it, which is #318 arriving again through its own tripwire.
    const sampled = realToday();
    const result = run(GATE_DATASET, ['--data', DATA, '--json']);
    const report = JSON.parse(result.stdout);
    assert.ok(
      [sampled, shiftDays(sampled, 1)].includes(report.today),
      `the live dataset must be gated on the real clock, but ran at "${report.today}" against a real ${sampled}`,
    );
    assert.deepEqual(report.failures, [], 'the live dataset must pass its own gates');
    assert.equal(result.code, 0);
    assert.ok(report.counts.releases > 0, 'the fixture-free dataset should not be empty');
  });

  test('an unchanged copy of the dataset also passes, so the harness itself is honest', () => {
    const result = gateMutatedDataset(() => {}, []);
    assert.equal(result.code, 0, result.stdout);
  });

  // -------------------------------------------------------------------------
  // The input side of attribution, proved to discriminate (#866).
  //
  // `assertFailed` refuses a *result* that is not attributable to the test's own
  // mutation. It cannot refuse a *mutation* that is not attributable to one
  // component, because it never sees the mutation. `touches` is that second
  // guarantee, and it is held to the standard `assertFailed` itself is held to:
  // a guard shown only by tests that pass has not been shown to discriminate,
  // so both directions are exercised here and both are exercised on the same
  // fixture, one argument apart.
  //
  // The first two tests are the whole argument. They run the same assertion,
  // against the same gate, with the same message fragment, and `assertFailed`
  // is satisfied identically by both -- one release dated 1823 and two releases
  // dated 1823 trip `dates` and nothing else either way. Only the input side can
  // tell them apart, and it does.
  // -------------------------------------------------------------------------
  describe('a mutation is attributable to one component, not merely its result', () => {
    /**
     * One release backdated below the 1950 floor, plus whatever `also` adds.
     * The bundle arms differ from the single arm in `also` and in `touches`,
     * and in nothing else, so what the guard reacts to is not in doubt.
     */
    const backdate = (touches, also = () => {}) => gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = '1823-04-05';
      also(releases);
      write('releases.json', releases);
    }, touches);

    /** Trips nothing on its own: two untouched records swap places. */
    const inert = (releases) => {
      const last = releases.length - 1;
      [releases[last - 1], releases[last]] = [releases[last], releases[last - 1]];
    };

    const failuresOf = (result) => JSON.parse(result.stdout).failures;

    test('a single-component mutation, declared, is accepted', () => {
      const result = backdate(['changed 1 releases.verifiedAt']);
      assertFailed(result, 'dates', 'predates 1950');
    });

    test('an inert component leaves the report identical, which is why the output side cannot see it', () => {
      // #840 in miniature: a bundle whose second component provokes nothing.
      // Declared honestly, so the harness admits it -- and what comes back is
      // indistinguishable from the single-component run above, gate for gate and
      // record for record. Everything downstream of the report is blind here,
      // `assertFailed` included, and that is the gap `touches` closes.
      const bundled = backdate(['changed 1 releases.verifiedAt', 'reordered releases'], inert);
      assertFailed(bundled, 'dates', 'predates 1950');
      assert.deepEqual(
        failuresOf(bundled),
        failuresOf(backdate(['changed 1 releases.verifiedAt'])),
        'the inert component must leave the report untouched, or this is not the case #840 hit',
      );
    });

    test('that same bundle, declared as the single component it looks like, is refused', () => {
      assert.throws(
        () => backdate(['changed 1 releases.verifiedAt'], inert),
        (error) => {
          assert.match(error.message, /never declared/);
          assert.match(error.message, /reordered releases/);
          return true;
        },
      );
    });

    test('a second component that provokes the same gate is refused too, though nothing in the report shows it', () => {
      // The sharper half of the same defect: both components trip `dates`, so
      // `alsoFails` is empty and correct and every output-side assertion passes.
      const second = (releases) => { releases[1].verifiedAt = '1823-04-05'; };
      assertFailed(
        backdate(['changed 2 releases.verifiedAt'], second),
        'dates',
        'predates 1950',
      );
      assert.throws(
        () => backdate(['changed 1 releases.verifiedAt'], second),
        (error) => {
          assert.match(error.message, /a different number of records than this test declared/);
          assert.match(error.message, /touched "changed 2 releases\.verifiedAt", declared "changed 1 releases\.verifiedAt"/);
          return true;
        },
      );
    });

    test('over-declaring is refused as well, so the declaration cannot decay into a wildcard', () => {
      // Same component, overstated reach.
      assert.throws(
        () => backdate(['changed 2 releases.verifiedAt']),
        (error) => {
          assert.match(error.message, /a different number of records than this test declared/);
          assert.match(error.message, /touched "changed 1 releases\.verifiedAt", declared "changed 2 releases\.verifiedAt"/);
          return true;
        },
      );
      // A component that is not there at all.
      assert.throws(
        () => backdate(['changed 1 releases.verifiedAt', 'removed 3 families']),
        /touches declares removed 3 families, but the edit did nothing under that name/,
      );
    });

    test('a component in another document is named rather than absorbed', () => {
      assert.throws(
        () => gateMutatedDataset(({ read, write }) => {
          const releases = read('releases.json');
          releases[0].verifiedAt = '1823-04-05';
          write('releases.json', releases);
          write('benchmarks.json', read('benchmarks.json').slice(1));
        }, ['changed 1 releases.verifiedAt']),
        /removed 1 benchmarks/,
      );
    });

    test('"all" is a counted claim about every record, not a wildcard', () => {
      // True, so accepted: every release moves.
      assertFailed(
        gateMutatedDataset(({ read, write }) => {
          write('releases.json', read('releases.json').map((entry) => ({ ...entry, verifiedAt: '1823-04-05' })));
        }, ['changed all releases.verifiedAt']),
        'dates',
        'predates 1950',
      );
      // False, so refused: one release moved, and `all` is expanded to the
      // collection's real size before it is compared.
      assert.throws(
        () => backdate(['changed all releases.verifiedAt']),
        /a different number of records than this test declared/,
      );
    });

    test('a declaration the harness cannot parse is refused rather than ignored', () => {
      // A typo would otherwise match nothing and be reported as an
      // over-declaration against a name that does not exist, which is the one
      // shape of declaration that could quietly become permission.
      assert.throws(
        () => backdate(['releases.verifiedAt']),
        /not a descriptor this harness can read/,
      );
      assert.throws(() => backdate('changed 1 releases.verifiedAt'), /must declare what its mutation touches/);
      assert.throws(() => backdate(undefined), /must declare what its mutation touches/);
    });
  });

  // #318 in one assertion: a record verified *today* is not the future. The
  // pinned clock failed exactly here the morning after a refresh landed, so this
  // is the regression guard rather than a restatement of the test above -- that
  // one passes whenever the data happens to be older than the pin, this one only
  // when the boundary itself is right.
  test('a record verified today is accepted rather than read as the future', () => {
    const today = realToday();
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = today;
      write('releases.json', releases);
    }, ['changed 1 releases.verifiedAt']);
    assert.equal(result.code, 0, result.stdout);
  });

  // `DATASET_DOCUMENTS` is a copy of a list `gate-dataset.mjs` owns, and one
  // direction of that copy drifting is silent (see the note on the constant).
  // This is what makes it audible: the gate's `DOCUMENTS` map is scraped back
  // out of its own source and compared against the copy.
  //
  // Compared as a directional diff rather than in order, because both consumers
  // iterate with `for..of`, where order carries no meaning -- membership is the
  // whole coupling, so reordering the gate's map is not drift and must not fail
  // here. The message names which side each stray document sits on, since
  // "a document was added to the gate" and "a document was removed from this
  // file" need different fixes.
  //
  // The scrape refuses rather than returning an empty list, the same way
  // `allowedPathsFrom` does further down: two empty lists compare equal, so a
  // parser that silently matched nothing would leave this guard green while
  // checking nothing -- the exact failure mode the constant's comment used to
  // have. The synthetic sources at the end hold the parser to its claim and
  // prove both refusals fire, so this test cannot pass vacuously. It asserts on
  // the parsed list, never on an exit code: gates in this file exit 0 while
  // broken, and no gate is run here at all.
  test('the document list still matches the one gate-dataset.mjs owns', () => {
    const documentsFrom = (source) => {
      const decl = /const\s+DOCUMENTS\s*=\s*\{([\s\S]*?)\}\s*;/.exec(source);
      if (!decl) throw new Error('no DOCUMENTS = { ... } declaration found');
      const files = [...decl[1].matchAll(/['"]([^'"]+\.json)['"]/g)].map((m) => m[1]);
      if (files.length === 0) throw new Error('DOCUMENTS declaration names no documents');
      return files;
    };

    const owned = documentsFrom(readFileSync(GATE_DATASET, 'utf8'));
    const onlyInGate = owned.filter((file) => !DATASET_DOCUMENTS.includes(file)).sort();
    const onlyInTest = DATASET_DOCUMENTS.filter((file) => !owned.includes(file)).sort();
    assert.deepEqual(
      { onlyInGate, onlyInTest },
      { onlyInGate: [], onlyInTest: [] },
      'DATASET_DOCUMENTS has drifted from the DOCUMENTS map gate-dataset.mjs owns -- '
        + `loaded by the gate but not named here: ${onlyInGate.join(', ') || '(none)'}; `
        + `named here but not loaded by the gate: ${onlyInTest.join(', ') || '(none)'}`,
    );

    // The parser reads what it claims to, and fails closed when it does not.
    assert.deepEqual(
      documentsFrom("const DOCUMENTS = {\n  a: 'a.json',\n  b: \"b.json\",\n};\n"),
      ['a.json', 'b.json'],
    );
    assert.throws(() => documentsFrom('const OTHER = 1;'), /no DOCUMENTS/);
    assert.throws(() => documentsFrom('const DOCUMENTS = {};'), /names no documents/);
  });

  // The other half of #318: the suite has to survive the *next* refresh, not
  // just today's. A refresh dated later only exists on a later day, so this moves
  // the data and the clock together -- moving the data alone would be a genuinely
  // future-dated dataset, which must stay refused (proved below). Every date here
  // is computed from the real clock, so nothing in this test can expire.
  test('a dataset refreshed on a later day still passes, so no ceiling is pinned', () => {
    const laterDay = shiftDays(realToday(), 400);
    const result = gateDatasetAt(laterDay, ({ read, write }) => {
      for (const file of DATASET_DOCUMENTS) {
        write(file, read(file).map((entry) => reverified(entry, laterDay)));
      }
    }, reverifiedFootprint(laterDay));
    assert.equal(result.code, 0, result.stdout);
  });

  // A refresh that writes structurally valid but empty arrays wipes the
  // dataset while every coherence gate stays green -- an empty set has no
  // dangling references, no duplicate ids, nothing to fail. ADR 0003 lets an
  // agent-gated refresh auto-merge, so this all-empty case must be refused
  // outright with a named `non-empty` failure and exit 1 (#185). The literal
  // `[]` written to every document is the expectation, computed from nothing
  // the gate itself produces.
  test('a wholesale-empty dataset is refused rather than reported as coherent', () => {
    const result = gateMutatedDataset(({ write }) => {
      for (const file of DATASET_DOCUMENTS) {
        write(file, []);
      }
    }, emptied(DATASET_DOCUMENTS));
    assertFailed(result, 'non-empty', 'found 0');
  });

  // The floor used to be the all-empty case *only*, and that was the bug
  // (#548). `usage-syntheses.json` is legitimately empty in the live data, so
  // the rule could not be "every document is non-empty" -- but the conclusion
  // drawn from that, "no document has a floor of its own", let the whole tree go
  // to zero behind three intact support documents. The collections that may be
  // empty are now the ones the schema declares `.default([])`, and this is that
  // direction: all four emptied at once, not one at a time.
  //
  // This replaces `a dataset emptied to a single record still passes`, whose
  // setup -- everything empty except one surviving source -- is now a dataset
  // the gate must refuse rather than accept, since organizations, families and
  // releases are floored. That test's purpose survives here; only its mutation
  // had to move, because the premise it was named for ("the floor is not a
  // per-document rule") is the half of the old rule this issue corrects.
  //
  // `publishers.json` is `.default([])` too and is still excluded: 217 sources
  // carry a `publisherId`, so emptying it fails `references` and would prove
  // something about that gate rather than this one. Whether publishers should be
  // floored is a question for the schema, and it is not answered here.
  //
  // The six documents abdeslam-menacere/ModelTree#495 added are all genuinely
  // emptiable together, and that is a property of the set rather than of each
  // one: `deployments` points at `servingPlatforms` and `benchmarkResults` at
  // `benchmarks`, but both targets are in this set too, so no reference is left
  // dangling by emptying all of them at once. Emptying one of a pair alone would
  // fail `references`, which is the case the per-document tests below cover.
  test('the collections the schema leaves optional may all be empty at once', () => {
    const optional = DATASET_DOCUMENTS.filter(
      (file) => !Object.values(LOAD_BEARING).includes(file) && file !== 'publishers.json',
    );
    // What the setup claims about itself, checked rather than assumed. The
    // gate's silence cannot carry it: a derivation that quietly emptied one
    // document produces exactly the silence a complete one produces, which is
    // #423 -- so the set is asserted before it is used, and by equality rather
    // than by count, since re-filtering on a different document need not change
    // the length.
    assert.deepEqual(
      [...optional].sort(),
      [
        'benchmark-results.json', 'benchmarks.json', 'deployments.json',
        'model-fit-evidence-gaps.json', 'model-fit-statements.json',
        'products.json', 'release-events.json', 'serving-platforms.json',
        'usage-observations.json', 'usage-syntheses.json',
      ],
      'the optional set must be every gate document that is neither load-bearing nor publishers.json',
    );
    const result = gateMutatedDataset(({ write }) => {
      for (const file of optional) write(file, []);
    }, emptied(optional));
    assert.equal(result.code, 0, result.stdout);
  });

  // The gate reads its floors out of `web/src/data/schema.ts` rather than
  // restating them, so what it derived is reported and pinned here.
  //
  // This is the only assertion in the file that notices `.min(1)` being added to
  // or removed from a collection in the schema. Removing one is the quiet
  // direction: Zod would stop refusing an empty collection, the gate would
  // follow it silently -- correctly, by SKILL.md's "the schema is the last word"
  // -- and every other test below would keep passing while covering less.
  test('the gate derives its floors from the schema, and they are the collections named here', () => {
    const report = JSON.parse(run(GATE_DATASET, ['--data', DATA, '--json']).stdout);
    assert.deepEqual(
      [...report.requiredCollections].sort(),
      Object.keys(LOAD_BEARING).sort(),
      'datasetSchema has changed which collections it floors at .min(1). That is a decision about '
        + 'the data model rather than drift to paper over: move LOAD_BEARING and the tests around '
        + 'it deliberately, and say in the pull request which collection changed and why.',
    );
  });

  // #548 itself, in one mutation. Emptying a collection while the records that
  // point into it stand also dangles every one of those references, and that
  // side effect is what made this gap look covered -- each single-document case
  // below does fail, just under `references` rather than for being empty. Wipe
  // the referrers too and the dataset left behind is perfectly coherent and
  // almost entirely gone: measured on trunk before this rule, 472 records became
  // 305 and the gate still printed "all gates passed".
  //
  // The survivors are the three documents the original report left intact, so
  // this is that report's mutation, restricted to the documents the gate loads.
  test('a tree wiped together with everything that points at it is refused, not called coherent', () => {
    const survivors = ['sources.json', 'publishers.json', 'organizations.json'];
    const wiped = DATASET_DOCUMENTS.filter((file) => !survivors.includes(file));
    assert.deepEqual(
      [...wiped, ...survivors].sort(),
      [...DATASET_DOCUMENTS].sort(),
      'the wipe must cover every gate document except the three support documents kept intact',
    );
    const result = gateMutatedDataset(({ write }) => {
      for (const file of wiped) write(file, []);
    }, emptied(wiped));
    // No `alsoFails`: the point of the case is that nothing else can see it.
    assertFailed(result, 'non-empty', 'families holds no records');
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.failures.map((failure) => failure.where).sort(),
      ['families', 'releases'],
      'the wipe must be refused for the two floored collections it emptied, by name',
    );
  });

  // Each floor proved to fire on its own, and to name its own collection rather
  // than reporting the dataset. `references` is declared everywhere because
  // emptying one collection while its referrers stand dangles every reference
  // into it -- the side effect described above, present here and deliberately
  // absent from the test before this one. `releases` additionally strands all 64
  // families, which is #441's rule doing its job.
  const alsoBrokenBy = {
    sources: ['references'],
    organizations: ['references'],
    families: ['references'],
    releases: ['references', 'family-has-release'],
  };
  for (const [collection, file] of Object.entries(LOAD_BEARING)) {
    test(`an empty ${file} is refused, and the refusal names ${collection}`, () => {
      const result = gateMutatedDataset(({ write }) => write(file, []), [`removed all ${documentLabel(file)}`]);
      assertFailed(result, 'non-empty', `${collection} holds no records`, {
        alsoFails: alsoBrokenBy[collection],
      });
      const report = JSON.parse(result.stdout);
      assert.deepEqual(
        report.failures.filter((failure) => failure.gate === 'non-empty').map((failure) => failure.where),
        [collection],
        `emptying ${file} must trip the floor for ${collection} and for no other collection`,
      );
    });
  }

  // Deriving the floors creates a state that did not exist before: the gate
  // being unable to work out its own rule. That must never be a pass, and this
  // file's header already fixes the code for it -- exit 2, the runner could not
  // run. Each case is a different way of failing to read the schema, because a
  // parser that silently matched nothing would return no floors, and no floors
  // is indistinguishable from a dataset that satisfies them all.
  //
  // The positive control at the end is what makes those refusals attributable. A
  // planted copy that could not run at all, or a harness that never reached the
  // gate, would produce the same six exit-2s and read as proof; the control
  // supplies a schema the parser *can* read and gets exit 1 out of the same
  // empty documents, so the difference is the schema and nothing else.
  describe('a schema it cannot derive floors from is exit 2, never a pass', () => {
    // Every derived rule has to be satisfiable for a fixture to reach a verdict
    // about the *floors*, so every planted schema carries a readable
    // `lifecycleStatus` and a readable `accessType` alongside its
    // `datasetSchema`. Without them the positive control below would exit 2 for
    // a vocabulary being underivable and read as proof that the floors could not
    // be derived either -- different refusals wearing the same exit code, which
    // is the confusion this block exists to remove. Each vocabulary's own
    // refusals are proved separately, further down, by planting a readable
    // `datasetSchema` and breaking only that declaration.
    const object = (body) =>
      `export const lifecycleStatus = z.enum(['preview', 'current']);\n`
      + `export const accessType = z.enum(['open-weight']);\n`
      + `export const datasetSchema = z.object({\n${body}});\n`;
    const withSchema = (schema) => fallbackRepo(GATE_DATASET, ({ dir }) => {
      const data = join(dir, 'web', 'src', 'data');
      for (const file of DATASET_DOCUMENTS) writeFileSync(join(data, file), '[]');
      if (schema !== null) writeFileSync(join(data, 'schema.ts'), schema);
      return ['--data', data];
    });

    const refusals = [
      ['no schema file at all', null, /cannot read .*schema\.ts/],
      ['a schema declaring no datasetSchema', 'export const other = 1;\n', /declares no "export const datasetSchema"/],
      ['a datasetSchema naming no collections', object(''), /names no collections/],
      ['a datasetSchema flooring nothing', object('  sources: z.array(sourceSchema).default([]),\n'), /floors no collection at \.min\(1\)/],
      [
        'an entry in a shape the parser cannot read',
        object('  sources: z.array(sourceSchema).min(1),\n  ...spread,\n'),
        /cannot read as a collection/,
      ],
      [
        'a floor over a document the gate never loads',
        object('  pricing: z.array(pricingRecordSchema).min(1),\n'),
        /floors pricing, which this gate does not load/,
      ],
      // The two below are modifier-level, not entry-level: both entries match
      // the scan and are counted, so the completeness check over the block is
      // satisfied and cannot see them. Read as "no floor here" they are silent
      // and permissive, which is the shape that took the gate back to #548.
      [
        'a floor whose argument this gate would have to execute TypeScript to know',
        object('  sources: z.array(sourceSchema).min(MIN_SOURCES),\n'),
        /qualifies sources in a way this gate cannot read: \.min\(MIN_SOURCES\)/,
      ],
      [
        'a floor spelt in a form this gate does not know, carrying no .min( at all',
        object('  sources: z.array(sourceSchema).nonempty(),\n'),
        /qualifies sources in a way this gate cannot read: \.nonempty\(\)/,
      ],
    ];

    for (const [label, schema, expected] of refusals) {
      test(label, () => {
        const result = withSchema(schema);
        assert.equal(result.code, 2, `expected exit 2, got ${result.code}:\n${result.stdout}`);
        assert.match(result.stdout, expected);
      });
    }

    test('a schema it can read reaches exit 1 on the same documents, so the refusals are the schema', () => {
      const result = withSchema(object('  sources: z.array(sourceSchema).min(1),\n'));
      assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
      assert.match(result.stdout, /\[non-empty\] sources: sources holds no records/);
    });
  });

  // A schema edit that means nothing to Zod must mean nothing to this gate. The
  // gate exists to follow the schema, so a distinction the schema does not draw
  // is not one the gate may draw either -- and the direction that bites is the
  // permissive one. Respacing `.min(1)` to `.min( 1 )` used to drop that
  // collection's floor in silence and take the gate straight back to what #548
  // was filed about: `"passed": true` over the wipe. The entry still matched, so
  // the completeness check over the block was satisfied; only the *modifier*
  // went unread, and losing some floors returned the rest while losing all of
  // them threw. The loud half was already covered, which is why the quiet half
  // survived.
  //
  // Whitespace is the case worth pinning because it needs no human intent: a
  // formatter can introduce it. Each pair below differs in the schema's spelling
  // and in nothing else -- same documents, written the same way -- so identical
  // verdicts across the pair is the whole claim.
  describe('a schema respelt without changing what it means changes no verdict', () => {
    const SURVIVORS = ['sources.json', 'publishers.json', 'organizations.json'];
    const SCHEMA = readFileSync(join(DATA, 'schema.ts'), 'utf8');

    const verbatim = (source) => source;
    /** `.min(1)` -> `.min( 1 )`: a no-op for Zod, and for a human reader. */
    const respaced = (source) => source.replace(/\.min\(1\)/g, '.min( 1 )');
    /**
     * The same respacing over two floors rather than all four, and the case that
     * carries this block. Respelling *every* floor loses every floor, and losing
     * every floor was already refused out loud -- so a whole-schema respacing
     * exercises the guard that existed, not the gap that did not. Losing *some*
     * of them returned the rest, satisfied every check in the file, and printed
     * `"passed": true` over the #548 wipe. Two floors and not four is the whole
     * difference between reproducing that and missing it.
     */
    const respacedPartly = (source) =>
      source.replace(/\b(families|releases): (z\.array\(\w+Schema\))\.min\(1\)/g, '$1: $2.min( 1 )');
    /** A JSDoc note on a field: ordinary TypeScript, and invisible to Zod. */
    const annotated = (source) =>
      source.replace(/(\n(\s*))(families: z\.array\()/, '$1/** the trees themselves. */$1$3');

    /**
     * The real data and the real schema, the schema rewritten by `respell` and
     * the #548 wipe applied when asked for. Planted rather than gated in place
     * because the schema has to be edited and the gate reads it from its own
     * repository root, never from `--data` -- which is the property that stops
     * `--data` lowering the rule it is judged against.
     */
    const respelt = (respell, { wipe }) => fallbackRepo(GATE_DATASET, ({ dir }) => {
      const data = join(dir, 'web', 'src', 'data');
      cpSync(DATA, data, { recursive: true });
      writeFileSync(join(data, 'schema.ts'), respell(SCHEMA));
      if (wipe) {
        for (const file of DATASET_DOCUMENTS.filter((name) => !SURVIVORS.includes(name))) {
          writeFileSync(join(data, file), '[]');
        }
      }
      return ['--data', data, '--json'];
    });

    const floorsOf = (result) => JSON.parse(result.stdout).requiredCollections.slice().sort();
    const refusedFor = (result) => JSON.parse(result.stdout).failures.map((failure) => failure.where).sort();

    // Without this the block below could assert nothing at all: a respelling
    // that quietly stopped applying would leave every case running the
    // committed schema, and every one of them would pass for that reason.
    test('the respellings this block relies on do change the schema', () => {
      assert.notEqual(respaced(SCHEMA), SCHEMA, 'the .min( 1 ) respacing must actually apply');
      assert.notEqual(respacedPartly(SCHEMA), SCHEMA, 'the two-floor respacing must actually apply');
      assert.notEqual(
        respacedPartly(SCHEMA),
        respaced(SCHEMA),
        'the two-floor respacing must leave the other floors spelt as committed: respelling all of '
          + 'them loses all of them, which is the loud case that was never the bug',
      );
      assert.notEqual(annotated(SCHEMA), SCHEMA, 'the block comment must actually be inserted');
      assert.equal(verbatim(SCHEMA), SCHEMA, 'the control must leave the schema exactly as committed');
    });

    // The reproduction of the regression itself. Same documents as the case
    // above, same rule, and a schema differing from the committed one by two
    // space characters that Zod cannot see -- which used to be the difference
    // between refusing the wipe and reporting `"passed": true` over it.
    test('respacing only some floors still refuses the wipe, the case that reported "passed": true', () => {
      const result = respelt(respacedPartly, { wipe: true });
      assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
      assert.deepEqual(
        floorsOf(result),
        Object.keys(LOAD_BEARING).sort(),
        'a floor written .min( 1 ) is still a floor; dropping it kept the other two and passed',
      );
      assert.deepEqual(refusedFor(result), ['families', 'releases']);
    });

    test('respacing every floor loses none of them', () => {
      const result = respelt(respaced, { wipe: false });
      assert.equal(result.code, 0, `expected the live dataset to pass, got ${result.code}:\n${result.stdout}`);
      assert.deepEqual(
        floorsOf(result),
        Object.keys(LOAD_BEARING).sort(),
        'a respaced .min(1) is still a floor: dropping one silently is how #548 came back',
      );
    });

    test('the wipe is refused identically whichever way the floors are spelt', () => {
      const plain = respelt(verbatim, { wipe: true });
      const spaced = respelt(respaced, { wipe: true });
      for (const [label, result] of [['.min(1)', plain], ['.min( 1 )', spaced]]) {
        assert.equal(result.code, 1, `${label}: expected exit 1, got ${result.code}:\n${result.stdout}`);
      }
      assert.deepEqual(refusedFor(plain), ['families', 'releases']);
      assert.deepEqual(
        refusedFor(spaced),
        refusedFor(plain),
        'the same documents judged against the same rule spelt two ways must reach the same verdict',
      );
    });

    // A `/* */` note on a field is ordinary TypeScript and must not be what
    // stops this gate running -- an unreadable schema is exit 2, so a routine
    // annotation would take the refresh path's own gate offline. Both
    // directions, because a comment that swallowed the entries after it would
    // pass the first half by flooring nothing.
    test('a block comment on a field neither hides its floor nor stops the gate', () => {
      const live = respelt(annotated, { wipe: false });
      assert.equal(live.code, 0, `expected exit 0, got ${live.code}:\n${live.stdout}`);
      assert.deepEqual(floorsOf(live), Object.keys(LOAD_BEARING).sort());

      const wiped = respelt(annotated, { wipe: true });
      assert.equal(wiped.code, 1, `expected exit 1, got ${wiped.code}:\n${wiped.stdout}`);
      assert.deepEqual(refusedFor(wiped), ['families', 'releases']);
    });
  });

  // -------------------------------------------------------------------------
  // abdeslam-menacere/ModelTree#761: a `status` outside `lifecycleStatus`.
  //
  // The reported instance, verbatim: a family carrying `status: "active"` --
  // which is not a member -- and this gate answering exit 0, `"passed": true`,
  // `"failures": []` while Zod refused the identical dataset at `npm run
  // validate`. It was found by the #751 dock during red-then-green testing of
  // its own remediation: it set a deliberately bogus value to confirm its change
  // was being detected, and discovered the gate did not care.
  //
  // Both directions, in the terms this file's header sets. The bogus value must
  // be refused, or the gate is blind; every member the schema does declare must
  // be accepted, or it is paranoid. A rule with no demonstrated failing case is
  // not known to work, and the defect being fixed here was itself a check that
  // returned success without having examined the thing -- so a test that
  // asserted only an exit code would have the same shape as the bug, surviving
  // the guard being deleted and replaced by any unrelated error. Every refusal
  // below pins the gate's own message.
  // -------------------------------------------------------------------------
  test('the gate derives the lifecycle vocabulary from the schema, and it is the members named here', () => {
    const report = JSON.parse(run(GATE_DATASET, ['--data', DATA, '--json']).stdout);
    assert.deepEqual(
      report.lifecycleStatus,
      LIFECYCLE_STATUS,
      'lifecycleStatus in web/src/data/schema.ts has changed which states exist. That is a decision '
        + 'about the data model rather than drift to paper over: move LIFECYCLE_STATUS and the tests '
        + 'around it deliberately, and say in the pull request which member changed and why.',
    );
  });

  for (const collection of ['families', 'releases']) {
    const file = `${collection}.json`;
    test(`a ${collection} status outside lifecycleStatus is refused, and the refusal names the record`, () => {
      let broken;
      const result = gateMutatedDataset(({ read, write }) => {
        const entries = read(file);
        broken = entries[0].id;
        entries[0].status = 'active';
        write(file, entries);
      }, [`changed 1 ${collection}.status`]);
      assertFailed(
        result,
        'vocabulary',
        'status "active" is not a member of lifecycleStatus, which web/src/data/schema.ts declares as '
          + 'preview, current, legacy, deprecated, research, unknown',
      );
      const report = JSON.parse(result.stdout);
      assert.deepEqual(
        report.failures.map((failure) => failure.where),
        [`${collection}:${broken}`],
        `one illegal status must be refused once, naming the record that carries it`,
      );
    });

    // Omission and a wrong value are the same fault by the same authority:
    // `status` is required by both schemas. Covered because dropping the field
    // is the cheapest way to hold no legal lifecycle state at all, and a rule
    // written as "if it is present, it must be a member" would not see it --
    // leaving the gate blind to the very case that is easiest to reach by
    // accident when a claim is applied.
    test(`a ${collection} record with no status at all is refused too`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        const entries = read(file);
        delete entries[0].status;
        write(file, entries);
      }, [`changed 1 ${collection}.status`]);
      assertFailed(result, 'vocabulary', 'status undefined is not a member of lifecycleStatus');
    });
  }

  // The paranoid direction. Refusing everything would satisfy every assertion
  // above, so each member the schema declares is put on every family and every
  // release in turn and the whole dataset has to still pass. Six runs rather
  // than one sampled member: a vocabulary that lost exactly one member would
  // pass a spot check on any of the other five.
  for (const member of LIFECYCLE_STATUS) {
    test(`"${member}" is accepted on every family and release, so the gate is not simply refusing`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        for (const file of ['families.json', 'releases.json']) {
          write(file, read(file).map((entry) => ({ ...entry, status: member })));
        }
      }, assignedEverywhere(['families.json', 'releases.json'], 'status', member));
      assert.equal(result.code, 0, `"${member}" is a declared member and must be accepted:\n${result.stdout}`);
    });
  }

  // -------------------------------------------------------------------------
  // ADR 0011: `accessType`, the second field this gate holds to its schema's
  // vocabulary, added in the commit that gave that field an `unknown` member.
  //
  // The absence case below is the one carrying the ADR's guardrail. `unknown`
  // there means "no accessible primary source states an access type", and it is
  // reached by asserting it -- never by leaving the field out. If omission were
  // tolerated, dropping a field would be the most permissive move available to
  // a run applying claims, and the member added to make honest records
  // publishable would instead be a way to publish records nobody researched.
  // The rule is the same one lifecycle has, applied to `releases` alone because
  // `accessType` is a release-level field; families carry no such property and
  // are not checked for one.
  // -------------------------------------------------------------------------
  test('the gate derives the access-type vocabulary from the schema, and it is the members named here', () => {
    const report = JSON.parse(run(GATE_DATASET, ['--data', DATA, '--json']).stdout);
    assert.deepEqual(
      report.accessType,
      ACCESS_TYPE,
      'accessType in web/src/data/schema.ts has changed which access types exist. That is a decision '
        + 'about the data model rather than drift to paper over: move ACCESS_TYPE and the tests around '
        + 'it deliberately, and say in the pull request which member changed and why.',
    );
  });

  test('a releases accessType outside accessType is refused, and the refusal names the record', () => {
    let broken;
    const result = gateMutatedDataset(({ read, write }) => {
      const entries = read('releases.json');
      broken = entries[0].id;
      entries[0].accessType = 'api-only';
      write('releases.json', entries);
    }, ['changed 1 releases.accessType']);
    assertFailed(
      result,
      'vocabulary',
      'accessType "api-only" is not a member of accessType, which web/src/data/schema.ts declares as '
        + 'proprietary-hosted, open-weight, source-available, both, unknown',
    );
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.failures.map((failure) => failure.where),
      [`releases:${broken}`],
      'one illegal access type must be refused once, naming the record that carries it',
    );
  });

  test('a releases record with no accessType at all is refused too, so absence never reads as unknown', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const entries = read('releases.json');
      delete entries[0].accessType;
      write('releases.json', entries);
    }, ['changed 1 releases.accessType']);
    assertFailed(result, 'vocabulary', 'accessType undefined is not a member of accessType');
  });

  // The paranoid direction again, `unknown` among them: the member this ADR adds
  // has to be *accepted* by the gate, or the schema change would be unreachable
  // through the pipeline that applies claims and the ADR would have unblocked
  // nothing.
  for (const member of ACCESS_TYPE) {
    test(`"${member}" is accepted as an access type on every release, so the gate is not simply refusing`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        write('releases.json', read('releases.json').map((entry) => ({ ...entry, accessType: member })));
      }, assignedEverywhere(['releases.json'], 'accessType', member));
      assert.equal(result.code, 0, `"${member}" is a declared member and must be accepted:\n${result.stdout}`);
    });
  }

  // -------------------------------------------------------------------------
  // That the vocabulary is *read from* the schema rather than copied beside it.
  //
  // This is the acceptance criterion the issue was most specific about: "Do not
  // hand-copy the list into the script without a mechanism or a test that fails
  // when the two drift." The two tests here are that mechanism proved, and they
  // are the only ones in the file a hand-copied list would fail -- every other
  // assertion above passes just as well against six members written into
  // `gate-dataset.mjs`, because the committed schema and a faithful copy of it
  // agree by definition. Only moving the schema and watching the gate move with
  // it can tell a derivation from a copy that is currently correct.
  //
  // The dataset is left exactly as committed in both; the schema is the only
  // thing that changes, so the change in verdict is attributable to it alone.
  // -------------------------------------------------------------------------
  describe('the vocabulary follows the schema rather than a copy of it', () => {
    const SCHEMA = readFileSync(join(DATA, 'schema.ts'), 'utf8');
    const DECLARATION = /export const lifecycleStatus = z\.enum\(\[[^\]]*\]\);/;

    /**
     * The live dataset, judged against a schema whose vocabulary is `members`,
     * with `edit` given the chance to change the data as well.
     *
     * Planted rather than gated in place because the schema has to be edited and
     * the gate reads it from its own repository root, never from `--data` --
     * which is the property that stops `--data` lowering the rule it is judged
     * against.
     */
    const withVocabulary = (members, edit = () => {}) => fallbackRepo(GATE_DATASET, ({ dir }) => {
      const data = join(dir, 'web', 'src', 'data');
      cpSync(DATA, data, { recursive: true });
      const declaration = `export const lifecycleStatus = z.enum([${members.map((m) => `'${m}'`).join(', ')}]);`;
      const respelt = SCHEMA.replace(DECLARATION, declaration);
      assert.notEqual(respelt, SCHEMA, 'the lifecycleStatus declaration must actually have been rewritten');
      writeFileSync(join(data, 'schema.ts'), respelt);
      edit({
        read: (file) => JSON.parse(readFileSync(join(data, file), 'utf8')),
        write: (file, value) => writeFileSync(join(data, file), JSON.stringify(value, null, 2)),
      });
      return ['--data', data, '--json'];
    });

    // Narrowing the schema narrows the gate. `current` is carried by more
    // families and releases than any other member, so removing it turns a
    // passing dataset into a large, specific set of refusals -- which a gate
    // holding its own copy of the six members could not produce.
    test('a member removed from the schema stops being accepted in the data', () => {
      const kept = LIFECYCLE_STATUS.filter((member) => member !== 'current');
      const result = withVocabulary(kept);
      assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.lifecycleStatus, kept, 'the gate must report the narrowed vocabulary it read');
      const refused = report.failures.filter((failure) => failure.gate === 'vocabulary');
      assert.equal(
        refused.length,
        report.failures.length,
        `only the vocabulary rule may fire here, got: ${report.failures.map((f) => f.gate).join(', ')}`,
      );
      assert.ok(
        refused.length > 0 && refused.every((failure) => failure.message.includes('status "current" is not a member')),
        `every refusal must name the withdrawn member, got:\n${refused.map((f) => f.message).join('\n')}`,
      );
    });

    // The converse, and the half that catches a copy the other way round: a
    // member the schema admits has to be admitted here, even one nobody would
    // want. `active` is the exact value from the report, so this is the bug's
    // own fixture asserted to *pass* once the schema says it may.
    test('a member added to the schema is accepted in the data', () => {
      const widened = [...LIFECYCLE_STATUS, 'active'];
      const result = withVocabulary(widened, ({ read, write }) => {
        const families = read('families.json');
        families[0].status = 'active';
        write('families.json', families);
      });
      assert.equal(result.code, 0, `expected exit 0, got ${result.code}:\n${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout).lifecycleStatus, widened);
    });
  });

  // A vocabulary the gate cannot derive is exit 2, never a pass -- the same
  // rule, and the same reasoning, as the floors above. A parser that silently
  // matched nothing would be worse here than there: an empty vocabulary refuses
  // every record, which is at least loud, but a *partial* one refuses only the
  // members it lost and passes everything else. That is #761 again, in the one
  // direction nobody is watching, so every shape this cannot express is refused
  // out loud instead.
  //
  // Each fixture plants a `datasetSchema` the gate reads without complaint, so
  // the exit 2 is attributable to the vocabulary and not to the floors. The
  // positive control at the end supplies a readable declaration and gets exit 1
  // out of the same documents, so the difference is this declaration alone.
  describe('a schema it cannot derive the lifecycle vocabulary from is exit 2, never a pass', () => {
    const withLifecycle = (declaration) => fallbackRepo(GATE_DATASET, ({ dir }) => {
      const data = join(dir, 'web', 'src', 'data');
      for (const file of DATASET_DOCUMENTS) writeFileSync(join(data, file), '[]');
      writeFileSync(
        join(data, 'schema.ts'),
        // A readable `accessType` throughout, so every exit 2 below is
        // attributable to the lifecycle declaration under test rather than to
        // the other vocabulary this gate also derives.
        `${declaration}export const accessType = z.enum(['open-weight']);\n`
        + `export const datasetSchema = z.object({\n  sources: z.array(sourceSchema).min(1),\n});\n`,
      );
      return ['--data', data];
    });

    const refusals = [
      ['no lifecycleStatus declaration at all', '', /declares no "export const lifecycleStatus"/],
      // The shape `datePrecision` is actually written in, one declaration above
      // `lifecycleStatus` in the committed schema. It is the form most likely to
      // arrive here for real, and the gate cannot follow the indirection without
      // executing TypeScript -- which it deliberately does none of -- so it says
      // so rather than deriving nothing and calling that a vocabulary.
      //
      // The trailing `z.enum(['a'])` is the case that matters and the reason
      // this fixture is not simply the declaration on its own: a parser that
      // searched forward for the next `[` would find *that* list, derive
      // `['a']`, and report a real, plausible, wrong vocabulary belonging to
      // another field. Silently deriving the wrong rule is worse than deriving
      // none, and this test failed in exactly that way while it was being
      // written.
      [
        'a vocabulary this gate would have to execute TypeScript to know',
        'export const lifecycleStatus = z.enum(LIFECYCLE_STATES);\nexport const other = z.enum([\'a\']);\n',
        /does not list its members literally: z\.enum\(LIFECYCLE_STATES\)/,
      ],
      // Written down, but not written down in full. The members that *are*
      // literal would be read and the rest lost, which is the partial-vocabulary
      // case: it refuses the members it lost and passes everything else.
      [
        'a list this gate can only partly read',
        "export const lifecycleStatus = z.enum([...BASE, 'current']);\n",
        /lists a member this gate cannot read: \.\.\.BASE/,
      ],
      [
        'a member that is not a string literal',
        "export const lifecycleStatus = z.enum(['preview', CURRENT]);\n",
        /lists a member this gate cannot read: CURRENT/,
      ],
      [
        'a vocabulary with no members',
        'export const lifecycleStatus = z.enum([]);\n',
        /yields no members/,
      ],
      // A list assembled rather than written down: the `]` is there, but it does
      // not close the call, so what the gate can read is not the whole
      // vocabulary. Refused for the same reason as the partial list above.
      [
        'a list the call goes on to modify',
        "export const lifecycleStatus = z.enum(['preview'].concat(REST));\n",
        /does not list its members literally/,
      ],
      // Not a `z.enum` at all. Without the check that `z.enum(` follows the
      // name before any `;`, this would run on to the next declaration and gate
      // against a vocabulary belonging to a different field entirely.
      [
        'a lifecycleStatus that is not an enum',
        'export const lifecycleStatus = z.string();\nexport const other = z.enum([\'a\']);\n',
        /is not a z\.enum\(\[ \.\.\. \]\) this gate can read/,
      ],
    ];

    for (const [label, declaration, expected] of refusals) {
      test(label, () => {
        const result = withLifecycle(declaration);
        assert.equal(result.code, 2, `expected exit 2, got ${result.code}:\n${result.stdout}`);
        assert.match(result.stdout, expected);
      });
    }

    test('a vocabulary it can read reaches exit 1 on the same documents, so the refusals are the declaration', () => {
      const result = withLifecycle("export const lifecycleStatus = z.enum(['preview', 'current']);\n");
      assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
      assert.match(result.stdout, /\[non-empty\] sources: sources holds no records/);
    });
  });

  // The same refusal, proved for the second vocabulary rather than assumed from
  // the first. `enumMembers` is shared, so it would be tempting to treat the
  // lifecycle cases above as covering `accessType` too -- but what is under test
  // here is that the *rule for `accessType`* is wired to that reader at all. A
  // vocabulary derived by a lenient path of its own, or defaulted when the
  // schema could not be read, would pass every assertion in the block above and
  // gate releases against a list nobody declared.
  //
  // The comment case is not hypothetical. `accessType` was added to this gate
  // with its members written across several lines and a comment among them, and
  // the gate refused the run rather than deriving a vocabulary missing whatever
  // the comment displaced. That refusal is why the member list in `schema.ts`
  // carries its explanation above the declaration instead of inside it.
  describe('a schema it cannot derive the access-type vocabulary from is exit 2, never a pass', () => {
    const withAccessType = (declaration) => fallbackRepo(GATE_DATASET, ({ dir }) => {
      const data = join(dir, 'web', 'src', 'data');
      for (const file of DATASET_DOCUMENTS) writeFileSync(join(data, file), '[]');
      writeFileSync(
        join(data, 'schema.ts'),
        // Readable lifecycle throughout: it is derived first, so leaving it out
        // would refuse every fixture here for the other field's reason.
        `export const lifecycleStatus = z.enum(['preview', 'current']);\n${declaration}`
        + `export const datasetSchema = z.object({\n  sources: z.array(sourceSchema).min(1),\n});\n`,
      );
      return ['--data', data];
    });

    const refusals = [
      ['no accessType declaration at all', '', /declares no "export const accessType"/],
      [
        'a member list with a comment inside the brackets',
        "export const accessType = z.enum([\n  'open-weight',\n  // added by ADR 0011\n  'unknown',\n]);\n",
        /lists a member this gate cannot read: \/\/ added by ADR 0011/,
      ],
      [
        'a vocabulary this gate would have to execute TypeScript to know',
        'export const accessType = z.enum(ACCESS_TYPES);\nexport const other = z.enum([\'a\']);\n',
        /does not list its members literally: z\.enum\(ACCESS_TYPES\)/,
      ],
    ];

    for (const [label, declaration, expected] of refusals) {
      test(label, () => {
        const result = withAccessType(declaration);
        assert.equal(result.code, 2, `expected exit 2, got ${result.code}:\n${result.stdout}`);
        assert.match(result.stdout, expected);
      });
    }

    test('a vocabulary it can read reaches exit 1 on the same documents, so the refusals are the declaration', () => {
      const result = withAccessType("export const accessType = z.enum(['open-weight', 'unknown']);\n");
      assert.equal(result.code, 1, `expected exit 1, got ${result.code}:\n${result.stdout}`);
      assert.match(result.stdout, /\[non-empty\] sources: sources holds no records/);
    });
  });

  // -------------------------------------------------------------------------
  // #441: a family that no release points at.
  //
  // The bug these cover is a *direction*, not a value. Every `familyId` check in
  // `gate-dataset.mjs` used to run release -> family, so a family nothing points
  // at could not fail the gate however broken it was -- and `model-tree.ts`
  // dropped it with `.filter(({ releases }) => releases.length > 0)`, so the
  // published tree went quietly smaller than the dataset while every check
  // stayed green. PR #417 did exactly that to seven families at once.
  //
  // Both halves of that sentence are history as of #554: the filter now reads
  // `.filter(hasRecordedRelease)` and lives in `web/src/lib/family-branch.ts`,
  // shared by all three hierarchy builders, and `validateDataset` refuses an
  // empty family before any page renders. These tests are unchanged by that --
  // they assert this gate's behaviour, which is deliberately independent of the
  // web build.
  //
  // Refuse rather than render, decided in the gate's own header: the dataset has
  // no `announced`/`upcoming` member in `lifecycleStatus`, so a deliberately
  // empty family and a data error cannot be told apart, and rendering the empty
  // case would publish the error as if it were an announcement.
  // -------------------------------------------------------------------------

  /** Historical fact, fixed by PR #417 and not a property of today's data. */
  const EMPTIED_BY_417 = [
    'anthropic-claude-4-6', 'anthropic-claude-4-7', 'anthropic-claude-4-8',
    'openai-gpt-5-1', 'openai-gpt-5-2', 'openai-gpt-5-3-codex', 'openai-gpt-image',
  ];

  /**
   * Adds `EMPTIED_BY_417.length` families carrying no releases, by the same
   * mechanism PR #417 used: new family records appear and no release is ever
   * pointed at them.
   *
   * Each new family is a *clone of a live one* with only its id changed, so
   * every other rule in the gate is satisfied by construction -- its
   * `organizationId` resolves, its `sourceIds` resolve and are non-empty, its
   * dates are real and past, its precision agrees. That isolation is the point:
   * it lets `assertFailed` demand that `family-has-release` is the *only* gate
   * that fires, which is what makes the result attributable to the missing
   * release rather than to a fixture that is broken in several ways at once.
   *
   * Ids are synthetic rather than the seven real ones because all seven exist in
   * the live dataset today *carrying releases* -- reusing them would collide on
   * `identity` and prove nothing. The historical ids are pinned against the real
   * commit further down, where they are still historical.
   *
   * `attachRelease` gives each new family exactly one release, which is the
   * control: identical setup, one difference, and the opposite verdict.
   */
  function withEmptyFamilies({ attachRelease = false } = {}) {
    return gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      const releases = read('releases.json');

      // The fixture's own inputs, checked rather than assumed. A copy of the
      // dataset that failed to load would make every assertion below pass for
      // the wrong reason: no families means no empty families to find.
      assert.ok(Array.isArray(families) && families.length > 0, 'families.json must load as a non-empty array');
      assert.ok(Array.isArray(releases) && releases.length > 0, 'releases.json must load as a non-empty array');

      // Cloned from a family that *has* a release, so the attached-release arm
      // inherits a release whose dates and owner already agree with it.
      const donorFamily = families.find((family) => releases.some((release) => release.familyId === family.id));
      assert.ok(donorFamily, 'the live dataset must contain a family with at least one release to clone');
      const donorRelease = releases.find((release) => release.familyId === donorFamily.id);

      const added = EMPTIED_BY_417.map((_, index) => `fixture-empty-family-${index + 1}`);
      const existing = new Set(families.map((family) => family.id));
      for (const id of added) {
        assert.ok(!existing.has(id), `fixture id "${id}" must not collide with a real family`);
      }

      for (const id of added) {
        families.push({ ...donorFamily, id });
        if (attachRelease) {
          releases.push({
            ...donorRelease,
            id: `${id}-release`,
            familyId: id,
            // Lineage stripped: a clone that kept its donor's edges would be
            // judged on those edges too, and this fixture is about one thing.
            predecessorIds: [],
            successorIds: [],
            siblingIds: [],
            derivedFromIds: [],
          });
        }
      }

      // What the setup claims about itself. `#423` on the non-empty floor above
      // is the precedent: the gate's silence cannot carry a setup, because a
      // narrowed setup produces exactly the silence a complete one produces.
      assert.equal(families.length, existing.size + EMPTIED_BY_417.length, 'every fixture family must be added');
      const pointedAt = new Set(releases.map((release) => release.familyId));
      const stillEmpty = added.filter((id) => !pointedAt.has(id));
      assert.deepEqual(
        stillEmpty,
        attachRelease ? [] : added,
        attachRelease
          ? 'the control arm must leave no fixture family empty'
          : 'the fixture must leave every added family with zero releases, or it reproduces nothing',
      );

      write('families.json', families);
      write('releases.json', releases);
    }, [
      `added ${EMPTIED_BY_417.length} families`,
      ...(attachRelease ? [`added ${EMPTIED_BY_417.length} releases`] : []),
    ]);
  }

  test('a family that no release points at is refused', () => {
    const result = withEmptyFamilies();
    assertFailed(result, 'family-has-release', 'no release belongs to this family');

    // Every empty family is named, not merely the first. A rule that reported
    // one of seven would still exit 1 and still look like a pass here without
    // this, and a refresh would then be told to fix one seventh of its mistake.
    const report = JSON.parse(result.stdout);
    const named = report.failures
      .filter((failure) => failure.gate === 'family-has-release')
      .map((failure) => failure.where)
      .sort();
    assert.deepEqual(
      named,
      EMPTIED_BY_417.map((_, index) => `families:fixture-empty-family-${index + 1}`).sort(),
      'the gate must name every family carrying no releases',
    );
  });

  test('the same families each carrying one release pass, so the rule is not "a new family fails"', () => {
    const result = withEmptyFamilies({ attachRelease: true });
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.failures.filter((failure) => failure.gate === 'family-has-release'),
      [],
      'a family with a release must not be refused',
    );
    assert.equal(result.code, 0, result.stdout);
  });

  // -------------------------------------------------------------------------
  // The same rule, driven by the real commit rather than by a fixture.
  //
  // A fixture proves the rule fires on the shape. This proves it fires on the
  // *data that actually shipped*, which is the claim #441 makes and the one a
  // fixture can only stand in for. Both are kept: the fixture is immune to
  // history being unavailable, and this is immune to the fixture drifting away
  // from what really happened.
  //
  // The two commits are an immutable pair -- the refresh that introduced the
  // seven empty families and the commit before it -- so the expected values are
  // historical facts and can be written as literals without pinning anything
  // about today's dataset. The parent is the control, and its expected value is
  // deliberately the *opposite* of the child's: a check that reported seven
  // empty families at both commits, or none at both, would be measuring
  // something other than this rule.
  //
  // Real clock, no `--today`: these dates are real-world claims that only
  // recede further into the past, so nothing here expires. Note that `TODAY`
  // (2026-08-25) would be *wrong* here -- it predates both commits, and every
  // record would read as the future.
  //
  // Fails closed. Any commit this cannot read throws, because a `git show` that
  // quietly returned nothing would leave a dataset with no families, and a
  // dataset with no families trivially has no empty ones -- the exact vacuous
  // pass this block exists to rule out. It needs full history: CI checks out
  // with `fetch-depth: 0`.
  //
  // Both commits predate six of the documents `DATASET_DOCUMENTS` now names,
  // which arrived with abdeslam-menacere/ModelTree#495 rather than with the
  // documents themselves -- the files existed, and the gate simply never loaded
  // them. "The commit predates this file" and "history is unreadable here" look
  // identical to `git show`, and only the first is a historical fact, so they
  // are told apart by asking the tree what it holds rather than by catching a
  // failure: `git ls-tree` names the documents that existed, an unreadable tree
  // still throws, and a document the tree lists but `git show` cannot produce
  // throws too. The set that was absent is written as a literal for the same
  // reason the family and release counts are -- it is a fact about two immutable
  // commits, so a mis-read history changes it and turns this red rather than
  // quietly reconstructing a different dataset. The load-bearing four are
  // asserted present on top of that, because those are the documents whose
  // absence would make the whole check vacuous.
  // -------------------------------------------------------------------------
  const REFRESH_417 = '547691aafd75a7a79eb2904470ef737d0ec62ce5';
  const BEFORE_417 = '9016420124778a8f7e07167d5e57fa774f75c1b5';

  const ABSENT_AT_417 = [
    'products.json', 'serving-platforms.json', 'deployments.json',
    'benchmarks.json', 'benchmark-results.json', 'release-events.json',
  ];

  /** The dataset documents `sha`'s tree actually holds, read from the tree. */
  function datasetDocumentsAt(sha) {
    let listing;
    try {
      listing = execFileSync('git', ['ls-tree', '-r', '--name-only', sha, '--', 'web/src/data/'], {
        cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(
        `cannot list web/src/data/ at ${sha}: ${error.message}. `
          + 'This test reads real committed history and needs a full clone (fetch-depth: 0); '
          + 'it fails rather than skips, because a silent skip would read as a pass.',
      );
    }
    const present = new Set(listing.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('web/src/data/'))
      .map((line) => line.slice('web/src/data/'.length))
      .filter((file) => DATASET_DOCUMENTS.includes(file)));
    if (present.size === 0) {
      throw new Error(`${sha} lists no dataset documents under web/src/data/, which cannot be true of either commit`);
    }
    return present;
  }

  function gateDatasetAtCommit(sha) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-history-'));
    try {
      const present = datasetDocumentsAt(sha);

      assert.deepEqual(
        DATASET_DOCUMENTS.filter((file) => !present.has(file)).sort(),
        [...ABSENT_AT_417].sort(),
        `the documents missing from ${sha} are a historical fact; a different set means history was mis-read`,
      );
      for (const file of Object.values(LOAD_BEARING)) {
        assert.ok(present.has(file), `${file} must exist at ${sha}, or this check is vacuous`);
      }

      for (const file of DATASET_DOCUMENTS) {
        if (!present.has(file)) {
          // The document did not exist yet. An empty array is what the dataset
          // held at this commit, and it keeps the gate's input well-formed so
          // this block still measures `family-has-release` and not the gate's
          // reaction to a file that was never there.
          writeFileSync(join(dir, file), '[]\n');
          continue;
        }
        let text;
        try {
          text = execFileSync('git', ['show', `${sha}:web/src/data/${file}`], {
            cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          throw new Error(
            `cannot read web/src/data/${file} at ${sha}: ${error.message}. `
              + 'This test reads real committed history and needs a full clone (fetch-depth: 0); '
              + 'it fails rather than skips, because a silent skip would read as a pass.',
          );
        }
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error(`${file} at ${sha} is not a JSON array`);
        writeFileSync(join(dir, file), text);
      }
      const result = run(GATE_DATASET, ['--data', dir, '--json']);
      const report = JSON.parse(result.stdout);
      return {
        code: result.code,
        report,
        emptyFamilies: report.failures
          .filter((failure) => failure.gate === 'family-has-release')
          .map((failure) => failure.where.replace(/^families:/, ''))
          .sort(),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('the tree reader is commit-specific, so the absent-document literal is not vacuous', () => {
    // At HEAD every document exists, so the absent set is empty -- which is not
    // `ABSENT_AT_417`. That is the whole point: if `datasetDocumentsAt` returned
    // the same thing whatever commit it was handed, the assertion above would
    // pass for a reconstructed dataset that never matched either commit.
    const here = datasetDocumentsAt('HEAD');
    assert.deepEqual(
      DATASET_DOCUMENTS.filter((file) => !here.has(file)),
      [],
      'every dataset document exists at HEAD',
    );
    assert.ok(ABSENT_AT_417.length > 0, 'the two historical commits really do predate some documents');
    for (const file of ABSENT_AT_417) {
      assert.ok(here.has(file), `${file} must exist at HEAD, or it is not merely absent from history`);
      assert.ok(DATASET_DOCUMENTS.includes(file), `${file} must be a document the gate loads today`);
    }
  });

  test('a commit the reader cannot resolve throws rather than reconstructing an empty dataset', () => {
    assert.throws(
      () => datasetDocumentsAt('0000000000000000000000000000000000000000'),
      /cannot list web\/src\/data\/ at 0{40}/,
    );
  });

  test('the seven empty families PR #417 shipped are refused, from that commit\'s own data', () => {
    const { code, report, emptyFamilies } = gateDatasetAtCommit(REFRESH_417);

    // The bad input was real and non-empty when it was gated. Without this the
    // assertion below could be satisfied by a dataset that never loaded.
    assert.equal(report.counts.families, 19, 'the dataset at 547691a held 19 families');
    assert.equal(report.counts.releases, 35, 'the dataset at 547691a held 35 releases');

    assert.deepEqual(
      emptyFamilies,
      [...EMPTIED_BY_417].sort(),
      'the gate must refuse exactly the seven families PR #417 shipped with no releases',
    );
    assert.equal(code, 1, 'a refresh in this state must exit non-zero rather than ship');
  });

  test('the commit before PR #417 is not refused, so the rule tracks the data and not the clock', () => {
    const { report, emptyFamilies } = gateDatasetAtCommit(BEFORE_417);

    assert.equal(report.counts.families, 12, 'the dataset before 547691a held 12 families');
    assert.equal(report.counts.releases, 31, 'the dataset before 547691a held 31 releases');

    // Asserted on this gate alone rather than on exit 0: a later rule that
    // refuses some *other* aspect of two-year-old data must not turn this
    // control red, because the claim here is only that no family was empty.
    assert.deepEqual(emptyFamilies, [], 'no family was empty before PR #417');
  });

  test('a broken source reference is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].sourceIds = ['a-source-that-was-never-added'];
      write('releases.json', releases);
    }, ['changed 1 releases.sourceIds']);
    assertFailed(result, 'references', 'does not resolve to a source');
  });

  // -------------------------------------------------------------------------
  // The singular label a `references` failure names its target by (#549)
  //
  // The message used to build that label by stripping a trailing `s` from the
  // collection name, which is right for six of the eight collections a failure
  // can name and renders `families` as "familie". The failure text is the
  // entire product of a gate that fires, and it is read by somebody who is
  // already debugging broken data, so a word that looks like a fourth entity
  // kind costs exactly the reader who can least afford it.
  //
  // Three things are asserted here and they fail for different reasons:
  //
  //   1. the rendered message, whole, for every target a failure can name;
  //   2. that the table below still lists every such target, scraped from the
  //      gate rather than recalled -- so a new reference edge cannot add a
  //      ninth target whose label nobody checked;
  //   3. that the gate's map covers exactly the collections it loads, which is
  //      what makes a sixteenth document arrive as a red suite rather than as
  //      a mangled word in an operator's terminal.
  //
  // The messages are compared **whole** rather than by `includes`. That is not
  // fastidiousness: `"...a familie".includes("...a famil")` is true, so a
  // fragment assertion is satisfied by a superstring and would have passed
  // against the very defect this block exists to pin. `assertFailed` is still
  // called for its exit-code and attribution discipline, with its fragment
  // argument omitted because the equality below is strictly stronger.
  // -------------------------------------------------------------------------

  /** Every `references` message in a gate report, exactly as rendered. */
  function referenceMessages(result) {
    return JSON.parse(result.stdout).failures
      .filter((failure) => failure.gate === 'references')
      .map((failure) => failure.message);
  }

  // One row per target a `references` failure can name. Every row's `alsoFails`
  // was measured against the live dataset rather than assumed: only the
  // `publishers.organizationId` edge disturbs a second gate, because an
  // unresolvable owner is also an entity-boundary violation.
  //
  // Six of these eight labels are unchanged by #549 and are pinned precisely so
  // that they stay that way -- a fix that quietly improved a label that was
  // already right would be a regression, and without these rows nothing would
  // say so. `organization` is the sharpest of them: the article in front of it
  // reads "a organization", which is wrong English and is deliberately pinned
  // as-is, because correcting an article is a different change from correcting
  // a plural and this issue is scoped to the plural.
  const REFERENCE_LABELS = [
    {
      target: 'sources',
      singular: 'source',
      file: 'releases.json',
      field: 'sourceIds',
      mutate: (entries) => { entries[0].sourceIds = ['no-such-source']; },
      message: 'sourceIds "no-such-source" does not resolve to a source',
    },
    {
      target: 'publishers',
      singular: 'publisher',
      file: 'sources.json',
      field: 'publisherId',
      mutate: (entries) => { entries[0].publisherId = 'no-such-publisher'; },
      message: 'publisherId "no-such-publisher" does not resolve to a publisher',
    },
    {
      target: 'organizations',
      singular: 'organization',
      file: 'publishers.json',
      field: 'organizationId',
      mutate: (entries) => { entries[0].organizationId = 'no-such-organization'; },
      message: 'organizationId "no-such-organization" does not resolve to a organization',
      alsoFails: ['entity-boundary'],
    },
    {
      // The defect. `families`.replace(/s$/, '') is "familie".
      target: 'families',
      singular: 'family',
      file: 'releases.json',
      field: 'familyId',
      mutate: (entries) => { entries[0].familyId = 'no-such-family'; },
      message: 'familyId "no-such-family" does not resolve to a family',
    },
    {
      target: 'releases',
      singular: 'release',
      file: 'usage-observations.json',
      field: 'releaseId',
      mutate: (entries) => { entries[0].releaseId = 'no-such-release'; },
      message: 'releaseId "no-such-release" does not resolve to a release',
    },
    {
      target: 'servingPlatforms',
      singular: 'servingPlatform',
      file: 'deployments.json',
      field: 'platformId',
      mutate: (entries) => { entries[0].platformId = 'no-such-platform'; },
      message: 'platformId "no-such-platform" does not resolve to a servingPlatform',
    },
    {
      target: 'benchmarks',
      singular: 'benchmark',
      file: 'benchmark-results.json',
      field: 'benchmarkId',
      mutate: (entries) => { entries[0].benchmarkId = 'no-such-benchmark'; },
      message: 'benchmarkId "no-such-benchmark" does not resolve to a benchmark',
    },
    {
      target: 'usageObservations',
      singular: 'usageObservation',
      file: 'usage-observations.json',
      field: 'conflictsWithIds',
      mutate: (entries) => { entries[0].conflictsWithIds = ['no-such-observation']; },
      message: 'conflictsWithIds "no-such-observation" does not resolve to a usageObservation',
    },
  ];

  for (const edge of REFERENCE_LABELS) {
    test(`a dangling ${edge.file}.${edge.field} calls its target a "${edge.singular}"`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        const entries = read(edge.file);
        edge.mutate(entries);
        write(edge.file, entries);
      }, [`changed 1 ${documentLabel(edge.file)}.${edge.field}`]);

      assertFailed(result, 'references', undefined, { alsoFails: edge.alsoFails ?? [] });
      assert.deepEqual(
        referenceMessages(result),
        [edge.message],
        `the "${edge.target}" reference failure must name its target "${edge.singular}"`,
      );
    });
  }

  test('the table above still names every collection a references failure can name', () => {
    // `check(collection, entry, field, value, target)` and
    // `checkList(collection, entry, field, target)` both take the target last,
    // and both are always written on one line in this gate. Read the last
    // string literal of each call rather than counting commas, so a call that
    // gains a comment or a differently-spelled argument still parses.
    const targetsFrom = (source) => {
      const targets = new Set();
      for (const line of source.split(/\r?\n/)) {
        for (const call of line.matchAll(/\bcheck(?:List)?\(([^)]*)\)/g)) {
          const literals = [...call[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
          const commas = call[1].split(',').length;
          // 5 arguments for `check`, 4 for `checkList`; anything else is not one
          // of these two calls and must not contribute a target.
          if ((commas === 5 || commas === 4) && literals.length > 0) {
            targets.add(literals[literals.length - 1]);
          }
        }
      }
      if (targets.size === 0) throw new Error('no reference targets found');
      return [...targets].sort();
    };

    const reachable = targetsFrom(readFileSync(GATE_DATASET, 'utf8'));
    const pinned = REFERENCE_LABELS.map((edge) => edge.target).sort();
    assert.deepEqual(
      reachable,
      pinned,
      'gate-dataset.mjs can name a collection in a references failure that no row above pins. '
        + `Reachable from the gate: ${reachable.join(', ')}; pinned here: ${pinned.join(', ')}. `
        + 'Add a row rather than leaving the new label unread.',
    );

    // The scrape reads what it claims to, and fails closed when it does not --
    // two empty lists compare equal, so a parser that silently matched nothing
    // would leave the assertion above green while checking nothing.
    assert.deepEqual(
      targetsFrom("check('a', b, 'c', d, 'releases');\ncheckList('a', b, 'c', 'sources');\n"),
      ['releases', 'sources'],
    );
    assert.throws(() => targetsFrom('const OTHER = 1;'), /no reference targets/);
  });

  test('the gate maps every collection it loads to an explicit singular label', () => {
    const objectLiteral = (source, name) => {
      const decl = new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}\\s*;`).exec(source);
      if (!decl) throw new Error(`no ${name} = { ... } declaration found`);
      const pairs = [...decl[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*'([^']*)'/gm)];
      if (pairs.length === 0) throw new Error(`${name} declaration names no entries`);
      return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
    };

    const source = readFileSync(GATE_DATASET, 'utf8');
    const singulars = objectLiteral(source, 'COLLECTION_SINGULAR');
    const documents = objectLiteral(source, 'DOCUMENTS');

    // Exact equality in both directions. A document with no label is the defect
    // this pins; a label for a document the gate does not load is dead weight
    // that would make the "closed set" claim false.
    assert.deepEqual(
      Object.keys(singulars).sort(),
      Object.keys(documents).sort(),
      'COLLECTION_SINGULAR and DOCUMENTS disagree about what the collections are. '
        + 'Every document the gate loads needs a singular label written out, so that a '
        + 'references failure naming it cannot fall back to guessing.',
    );

    // The two irregular plurals, named. `usageSyntheses` is not reachable as a
    // reference target today -- no field points at that collection, and
    // `usage-syntheses.json` is empty -- so it has no row in REFERENCE_LABELS
    // and cannot be asserted through a rendered message. It is asserted here
    // instead, because the moment an edge does point at it the naive rule would
    // have rendered "usageSynthese".
    assert.equal(singulars.families, 'family');
    assert.equal(singulars.usageSyntheses, 'usageSynthesis');

    // No label may be its collection's key verbatim, which is what a plural
    // pasted in as its own singular looks like.
    //
    // The check here was first written as "no label ends in `s`" and that was
    // wrong on its first contact with the data: `usageSyntheses` is correctly
    // labelled `usageSynthesis`, which ends in `s` because the English singular
    // does. The heuristic is left recorded rather than quietly deleted, because
    // it is the same mistake as the defect being fixed, made a second time by
    // somebody who had just finished arguing against it -- an inflection rule
    // reads as obviously right until it meets the word it is wrong about. The
    // replacement asserts a structural property that cannot be wrong about any
    // English word, which is the only kind of rule that belongs here.
    for (const [collection, singular] of Object.entries(singulars)) {
      assert.ok(singular.length > 0, `${collection} has an empty singular label`);
      assert.notEqual(
        singular,
        collection,
        `${collection} is labelled with its own plural key rather than a singular`,
      );
    }

    // The parser holds to its claim, positively and negatively.
    assert.deepEqual(
      objectLiteral("const X = {\n  a: 'one',\n  b: 'two',\n};\n", 'X'),
      { a: 'one', b: 'two' },
    );
    assert.throws(() => objectLiteral('const OTHER = 1;', 'X'), /no X = \{ \.\.\. \} declaration/);
    assert.throws(() => objectLiteral('const X = {\n};\n', 'X'), /names no entries/);
  });

  test('a verification date in the future is caught', () => {
    // Computed from the real clock, not written as a literal: under the live
    // clock a fixed date stops being "the future" the moment it arrives, so
    // `2027-01-01` would have quietly stopped testing anything in 2027. The
    // wide margin also clears the UTC midnight race with the gate's own clock.
    const future = shiftDays(realToday(), 366);
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = future;
      write('releases.json', releases);
    }, ['changed 1 releases.verifiedAt']);
    assertFailed(result, 'dates', 'is in the future');
  });

  test('a date that never existed is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].releaseDate = '2026-02-30';
      write('releases.json', releases);
    }, ['changed 1 releases.releaseDate']);
    // `releaseDate` is a partial-date field since #468, so the message no longer
    // names the `YYYY-MM-DD` shape. What it rejects is unchanged: 30 February is
    // not a real day at any precision.
    assertFailed(result, 'dates', 'is not a real date');
  });

  test('a release date coarser than the precision recorded beside it is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].releaseDate = releases[0].releaseDate.slice(0, 7);
      write('releases.json', releases);
    }, ['changed 1 releases.releaseDate']);
    // The record still says `day` while carrying only a month, so a reader would
    // be told a day exists that the value does not contain.
    assertFailed(result, 'dates', 'does not state the precision "day" recorded beside it');
  });

  test('a release date finer than the precision recorded beside it is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].datePrecision = 'month';
      write('releases.json', releases);
    }, ['changed 1 releases.datePrecision']);
    // The invented-day path in the direction that actually ships: a full day
    // sitting behind a `month` claim. Nothing in the old gate could see this,
    // because `datePrecision` was never compared to anything.
    assertFailed(result, 'dates', 'does not state the precision "month" recorded beside it');
  });

  test('a family first-release date that disagrees with its precision is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      families[0].datePrecision = 'year';
      write('families.json', families);
    }, ['changed 1 families.datePrecision']);
    assertFailed(result, 'dates', 'does not state the precision "year" recorded beside it');
  });

  test('a precision that is not one of year, month, day is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].datePrecision = 'quarter';
      write('releases.json', releases);
    }, ['changed 1 releases.datePrecision']);
    assertFailed(result, 'dates', 'is not one of year, month, day');
  });

  // -------------------------------------------------------------------------
  // `unstated`, the family-only zero of that scale (ADR 0013). A family may
  // record that no primary source states its first release date at any
  // precision, by omitting the date and saying so in the companion. The three
  // properties below are what make that a claim rather than a hole, and they
  // are asserted here because the schema cannot reach a refresh: this gate runs
  // before anything is written.
  // -------------------------------------------------------------------------

  test('a family whose first release date no source states passes', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      delete families[0].firstReleaseDate;
      delete families[0].dateBasis;
      families[0].datePrecision = 'unstated';
      write('families.json', families);
    }, ['changed 1 families.datePrecision', 'changed 1 families.firstReleaseDate']);
    // The point of the change, and simultaneously the false-positive control
    // for the collection scoping: release events carry `date` beside their own
    // `datePrecision`, and releases carry `releaseDate` beside theirs, so a rule
    // keyed on field name alone would now read every one of them as a record
    // whose date had gone missing. A clean exit is what proves it does not.
    assert.equal(result.code, 0, result.stdout);
  });

  test('a family that drops its first release date without saying so is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      delete families[0].firstReleaseDate;
      write('families.json', families);
    }, ['changed 1 families.firstReleaseDate']);
    // Absence is never self-authorising. A record that simply loses its date
    // looks from the outside exactly like one nobody checked, which is the
    // state `unstated` exists to be distinguishable from.
    assertFailed(result, 'dates', 'firstReleaseDate is absent while datePrecision "day" states one');
  });

  test('a family that claims its date is unstated while carrying one is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      families[0].datePrecision = 'unstated';
      write('families.json', families);
    }, ['changed 1 families.datePrecision']);
    // The contradiction guard. The record asserts that no source states this
    // date, beside the date, and a reader cannot tell which half to believe.
    assertFailed(result, 'dates', 'datePrecision "unstated" is recorded beside a firstReleaseDate');
  });

  test('a release may not claim its date is unstated', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].datePrecision = 'unstated';
      write('releases.json', releases);
    }, ['changed 1 releases.datePrecision']);
    // The scope of the member, enforced rather than described. A release is an
    // event, and a record of an event nobody can date at all is not a release.
    assertFailed(result, 'dates', 'is not one of year, month, day');
  });

  test('a release event may not claim its date is unstated', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const events = read('release-events.json');
      events[0].datePrecision = 'unstated';
      write('release-events.json', events);
    }, ['changed 1 release-events.datePrecision']);
    assertFailed(result, 'dates', 'is not one of year, month, day');
  });

  test('a release event that loses its date is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const events = read('release-events.json');
      delete events[0].date;
      write('release-events.json', events);
    }, ['changed 1 release-events.date']);
    // The same absence rule where `unstated` is not admissible, which is what
    // keeps the field required for the two collections that never gained it.
    assertFailed(result, 'dates', 'date is absent while datePrecision');
  });

  test('a sourced partial release date passes', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].releaseDate = releases[0].releaseDate.slice(0, 7);
      releases[0].datePrecision = 'month';
      write('releases.json', releases);
    }, ['changed 1 releases.datePrecision', 'changed 1 releases.releaseDate']);
    // The point of the whole change. A month the source actually stated is a
    // recordable fact, where before it could only reach the dataset wearing an
    // invented day.
    assert.equal(result.code, 0, result.stdout);
  });

  // -------------------------------------------------------------------------
  // The 1950 floor (abdeslam-menacere/ModelTree#488). `tools/updater`'s
  // `gates.py` has carried
  // `EARLIEST_YEAR = 1950` throughout; this file carried no lower bound at all,
  // which is a *permissive* divergence and the one direction ADR 0003 stops the
  // automation for. These tests are what makes the floor's presence here a fact
  // rather than a claim.
  //
  // Written as literals, unlike the future-date tests above, and the asymmetry
  // is real rather than an oversight: a literal *future* date stops being the
  // future when it arrives, so those must be computed from the clock. 1823 was
  // before 1950 when this was written and will be in every year this repository
  // sees. A past literal cannot rot.
  // -------------------------------------------------------------------------

  test('a date before 1950 is caught, and the refusal names the field, the value and the floor', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      // `verifiedAt` rather than `releaseDate`: it is an exact-date field with
      // no precision companion and no ordering rule pointed at it, so the only
      // thing this mutation can provoke is the floor.
      releases[0].verifiedAt = '1823-04-05';
      write('releases.json', releases);
    }, ['changed 1 releases.verifiedAt']);
    assertFailed(result, 'dates', 'predates 1950');

    // The whole message, not a fragment. The acceptance criteria ask for all
    // three parts, and a fragment assertion passes on a message that dropped
    // the value -- which is the part a reader needs to find the record.
    const report = JSON.parse(result.stdout);
    const floor = report.failures.filter((failure) => failure.message.includes('predates'));
    assert.deepEqual(
      floor.map((failure) => failure.message),
      ['verifiedAt "1823-04-05" predates 1950'],
      'the refusal must name the field, the offending value and the floor',
    );
  });

  test('the floor reads the year segment, so a partial date is judged by its year alone', () => {
    // Exactly the three shapes the issue enumerates. `windowStart` carries no
    // `datePrecision` companion, so each arm can vary precision freely without
    // provoking the precision-agreement rule and muddying what is being proved.
    for (const value of ['1823', '1823-04', '1823-04-05']) {
      const result = gateMutatedDataset(({ read, write }) => {
        const observations = read('usage-observations.json');
        assert.ok(observations.length > 0, 'usage-observations.json must load as a non-empty array');
        observations[0].windowStart = value;
        write('usage-observations.json', observations);
      }, ['changed 1 usage-observations.windowStart']);
      assertFailed(result, 'dates', `windowStart "${value}" predates 1950`);
    }
  });

  test('the floor covers the shared fields the divergence was measured on', () => {
    // `releaseDate` and `firstReleaseDate` are registered on both sides and were
    // the fields #488 named. A pre-1950 release also lands before its family, so
    // the ordering rule speaks too -- same gate, and declaring the floor message
    // specifically is what keeps this attributable.
    const release = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].releaseDate = '1823';
      releases[0].datePrecision = 'year';
      write('releases.json', releases);
    }, ['changed 1 releases.datePrecision', 'changed 1 releases.releaseDate']);
    assertFailed(release, 'dates', 'releaseDate "1823" predates 1950');

    const family = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      families[0].firstReleaseDate = '1823';
      families[0].datePrecision = 'year';
      write('families.json', families);
    }, ['changed 1 families.datePrecision', 'changed 1 families.firstReleaseDate']);
    assertFailed(family, 'dates', 'firstReleaseDate "1823" predates 1950');
  });

  test('the floor is exclusive: 1949 is refused and 1950 is accepted', () => {
    // One field, one difference, opposite verdicts. Without the accepting arm
    // the refusing one is satisfied just as well by a rule that refuses every
    // date, which would be a far larger defect wearing this test as cover.
    const refused = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = '1949-12-31';
      write('releases.json', releases);
    }, ['changed 1 releases.verifiedAt']);
    assertFailed(refused, 'dates', 'verifiedAt "1949-12-31" predates 1950');

    const accepted = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = '1950-01-01';
      write('releases.json', releases);
    }, ['changed 1 releases.verifiedAt']);
    assert.equal(accepted.code, 0, accepted.stdout);

    // And the same boundary on the partial path, where the year *is* the whole
    // value. `1950` must survive being read as a year segment rather than being
    // expanded into something the comparison then mishandles.
    const partial = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      families[0].firstReleaseDate = '1950';
      families[0].datePrecision = 'year';
      write('families.json', families);
    }, ['changed 1 families.datePrecision', 'changed 1 families.firstReleaseDate']);
    assert.equal(partial.code, 0, partial.stdout);
  });

  test('the floor reaches the nested control.verifiedAt, not only the top-level fields', () => {
    // No committed record carries a `control` block today, so this path is
    // reachable only by fixture -- which is exactly why it needs one. A date
    // rule applied to two of its three call sites is the divergence #488 closed,
    // reproduced one level down.
    const mutate = (verifiedAt) => gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].control = { verifiedAt };
      write('releases.json', releases);
    }, ['changed 1 releases.control']);

    assertFailed(mutate('1823-01-01'), 'dates', 'control.verifiedAt "1823-01-01" predates 1950');
    // The control: an identical fixture differing only in the year. It proves
    // the refusal above came from the date rather than from the gate disliking a
    // `control` block it had never seen.
    assert.equal(mutate('1950-01-01').code, 0);
  });

  // -------------------------------------------------------------------------
  // Years 0001-0099 reach the floor rather than being called malformed
  // (abdeslam-menacere/ModelTree#586). `isRealDate` used to build its
  // comparison date with `Date.UTC`, which remaps a year in 0-99 to 1900-1999,
  // so `0049-12-31` failed the round-trip and was reported as *not a real
  // date*. Nothing got through -- the value was refused either way -- but the
  // message named date parsing when the rule that should have spoken is the
  // 1950 floor, and the message is the only thing a gate failure hands a human.
  //
  // The two paths are tested separately on purpose: `isRealPartialDate` returns
  // true at its year- and month-precision branches *without* calling
  // `isRealDate`, so `0049` and `0049-12` already reached the floor while
  // `0049-12-31` did not. One value moving does not move the other, and a test
  // on either path alone would miss it.
  //
  // `publishedDate` carries the exact-date arm and `windowStart` the partial
  // one: neither has a precision companion, `publishedDate` is only compared
  // against a `lastCheckedDate` that is later still, and neither is read by the
  // evidence gate -- so a refusal here can have come from nothing but the date
  // rules.
  // -------------------------------------------------------------------------

  /** Every `dates` message a mutated-dataset run produced, in order. */
  const dateMessages = (result) => JSON.parse(result.stdout).failures
    .filter((failure) => failure.gate === 'dates')
    .map((failure) => failure.message);

  const withExactDate = (value) => gateMutatedDataset(({ read, write }) => {
    const sources = read('sources.json');
    assert.ok(sources.length > 0, 'sources.json must load as a non-empty array');
    sources[0].publishedDate = value;
    write('sources.json', sources);
  }, ['changed 1 sources.publishedDate']);

  const withPartialDate = (value) => gateMutatedDataset(({ read, write }) => {
    const observations = read('usage-observations.json');
    assert.ok(observations.length > 0, 'usage-observations.json must load as a non-empty array');
    observations[0].windowStart = value;
    write('usage-observations.json', observations);
  }, ['changed 1 usage-observations.windowStart']);

  test('an early full date is refused by the floor rather than reported as malformed', () => {
    const result = withExactDate('0049-12-31');
    assertFailed(result, 'dates', 'publishedDate "0049-12-31" predates 1950');
    // The upper bound, and the half that actually regresses: asserting the
    // floor fired says nothing if the malformed-date message fired beside it.
    assert.deepEqual(
      dateMessages(result).filter((message) => message.includes('is not a real')),
      [],
      '0049-12-31 is a well-formed date, so nothing may report it as unreal',
    );
  });

  test('all three precisions of an early year are refused by the same rule', () => {
    // Acceptance criterion 2, read literally: not "each is refused" but "each
    // names the same rule". Comparing the messages to one another rather than
    // to a literal is what makes that a single assertion instead of three
    // independent ones that could drift apart.
    const rules = ['0049', '0049-12', '0049-12-31'].map((value) => {
      const result = withPartialDate(value);
      assertFailed(result, 'dates', `windowStart "${value}" predates 1950`);
      return dateMessages(result).map((message) => message.replace(value, '<value>'));
    });
    assert.deepEqual(rules[1], rules[0], '0049-12 must be refused for the same reason as 0049');
    assert.deepEqual(rules[2], rules[0], '0049-12-31 must be refused for the same reason as 0049');

    // And the same day-precision value on the exact-date path, which reaches
    // `isRealDate` directly rather than through `isRealPartialDate`.
    assertFailed(withExactDate('0049-12-31'), 'dates', 'predates 1950');
  });

  test('year 0000 is still refused, at every precision', () => {
    // The remap used to refuse `0000-12-31` as a side effect. An explicit guard
    // now carries that verdict, so this is the test that would notice if the
    // fix had taken year 0 along with the years it meant to admit.
    assertFailed(withExactDate('0000-12-31'), 'dates', 'publishedDate "0000-12-31" is not a real');
    for (const value of ['0000', '0000-12', '0000-12-31']) {
      // No fragment: what criterion 3 asks is that the value is refused. Which
      // rule speaks differs by precision here -- the floor at year and month
      // precision, unreality at day precision -- and narrowing the partial
      // branch to match is a behaviour change #586 does not ask for.
      assertFailed(withPartialDate(value), 'dates');
    }
  });

  test('genuinely malformed dates are still refused as unreal on both paths', () => {
    // The other side of the fix. Admitting years 0001-0099 must not admit a
    // month of 13, a 30th of February, or a value that is not a date at all --
    // and each takes a different route out: `not-a-date` fails the shape test,
    // `2023-13-01` fails the month range, and `2023-02-30` survives both and is
    // caught only by the calendar round-trip.
    for (const value of ['2023-13-01', '2023-02-30', 'not-a-date']) {
      assertFailed(withExactDate(value), 'dates', `publishedDate "${value}" is not a real`);
      assertFailed(withPartialDate(value), 'dates', `windowStart "${value}" is not a real date`);
    }
  });

  // -------------------------------------------------------------------------
  // The ordering half of the same remap (abdeslam-menacere/ModelTree#596).
  //
  // #586 fixed `isRealDate` and, in doing so, *widened* what reaches the rules
  // below it: a year in 0001-0099 used to be classified unreal and so never got
  // as far as an ordering comparison. It does now. `startOf` and `endOf` were
  // still building with `Date.UTC`, which maps a year in 0-99 to 1900-1999, so
  // every such value was silently relocated by nineteen centuries *for the
  // purpose of comparison only* -- the floor still refused it, so nothing got
  // through and nothing here changes which datasets the gate accepts.
  //
  // What it changed is what the gate *says*. A family dated 0050-01-01 read as
  // 1950-01-01, so a release dated 1200-01-01 -- genuinely eight centuries
  // later -- was reported as predating its own family. The floor refuses both
  // values either way, so this is a wrong message sitting beside a right one,
  // which is the same defect #586 fixed one rule earlier.
  // -------------------------------------------------------------------------

  /** The `dates` messages that accuse a release of predating its family. */
  const familyOrderingMessages = (result) => JSON.parse(result.stdout).failures
    .filter((failure) => failure.gate === 'dates'
      && failure.message.includes("precedes its family's firstReleaseDate"))
    .map((failure) => failure.message);

  /** A dataset whose first release and its family carry the given dates. */
  const withFamilyAndRelease = (familyDate, releaseDate) => gateMutatedDataset(({ read, write }) => {
    const releases = read('releases.json');
    const families = read('families.json');
    const family = families.find((entry) => entry.id === releases[0].familyId);
    assert.ok(family, 'the first release must belong to a family for this fixture to mean anything');
    // Asserted rather than assigned. Both are already day-precision, so writing
    // `day` back would be an inert component -- the harness refuses those, and
    // rightly: it would look like part of the mutation while changing nothing.
    // Stated as a precondition instead, so that a dataset which stops meeting
    // it fails here rather than quietly making these fixtures mean something
    // else. Day precision is what makes `endOf` equal `startOf`, which is what
    // keeps this a test about the year rather than about interval width.
    assert.equal(family.datePrecision, 'day', 'this fixture assumes a day-precision family');
    assert.equal(releases[0].datePrecision, 'day', 'this fixture assumes a day-precision release');
    family.firstReleaseDate = familyDate;
    releases[0].releaseDate = releaseDate;
    write('families.json', families);
    write('releases.json', releases);
  }, ['changed 1 families.firstReleaseDate', 'changed 1 releases.releaseDate']);

  test('a release is not accused of predating a family whose year is in the 0001-0099 band', () => {
    // The issue's own pair. Both values are refused by the 1950 floor, so the
    // run fails either way and the exit code says nothing; what is measured is
    // whether the ordering accusation appears *beside* the floor's refusal.
    assert.deepEqual(
      familyOrderingMessages(withFamilyAndRelease('0050-01-01', '1200-01-01')),
      [],
      'a release in 1200 is eight centuries after a family in 0050 and must not be reported as preceding it',
    );

    // The control, and the reason the assertion above carries information. An
    // empty result proves nothing unless the same filter, on the same rule,
    // can be shown to find the message when it belongs there -- otherwise a
    // mistyped fragment reads exactly like a fixed bug.
    assert.deepEqual(
      familyOrderingMessages(withFamilyAndRelease('2023-01-01', '2022-01-01')),
      ['releaseDate "2022-01-01" precedes its family\'s firstReleaseDate "2023-01-01"'],
      'a release genuinely before its family must still be caught',
    );

    // And the same contradiction stated wholly inside the band, which is the
    // half that a fix could break by making the comparison unconditionally
    // false rather than correct.
    assert.deepEqual(
      familyOrderingMessages(withFamilyAndRelease('0050-01-01', '0040-01-01')),
      ['releaseDate "0040-01-01" precedes its family\'s firstReleaseDate "0050-01-01"'],
      'ordering must still work inside the band, not merely stop firing there',
    );
  });

  test('the floor still refuses the band, so the ordering fix accepts nothing new', () => {
    // The other direction, and the one that would notice if correcting the
    // comparison had quietly become a relaxation. #596 asks for the helpers to
    // compute the right instant; it does not ask for any value to become
    // acceptable that was not acceptable before.
    const banded = withFamilyAndRelease('0050-01-01', '1200-01-01');
    assert.equal(banded.code, 1, `the band must still be refused:\n${banded.stdout}`);
    const messages = dateMessages(banded);
    assert.ok(
      messages.some((message) => message.includes('firstReleaseDate "0050-01-01" predates 1950')),
      `the floor must still speak for the family:\n${messages.join('\n')}`,
    );
    assert.ok(
      messages.some((message) => message.includes('releaseDate "1200-01-01" predates 1950')),
      `the floor must still speak for the release:\n${messages.join('\n')}`,
    );

    // The control: the identical fixture with both years above the floor is
    // accepted, so the refusal above came from the dates and not from the
    // fixture being malformed in some way the assertions do not name.
    const modern = withFamilyAndRelease('2023-01-01', '2024-01-01');
    assert.equal(modern.code, 0, `a well-ordered modern pair must pass:\n${modern.stdout}`);
  });

  test('a release that predates its predecessor is still caught when stated as a year', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[1].predecessorIds = [releases[0].id];
      releases[1].releaseDate = '2000';
      releases[1].datePrecision = 'year';
      write('releases.json', releases);
    }, ['changed 1 releases.datePrecision', 'changed 1 releases.predecessorIds', 'changed 1 releases.releaseDate']);
    // The ordering check reads intervals now, so this proves the relaxation did
    // not buy its breadth by going blind: every day the year 2000 could mean is
    // before the predecessor, so it is still a contradiction and still caught.
    assertFailed(result, 'dates', 'precedes predecessor', { alsoFails: ['lineage'] });
  });

  test('a partial date that merely overlaps its predecessor is not called a contradiction', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[1].predecessorIds = [releases[0].id];
      // The predecessor's own year. The sources do not settle which came first
      // inside it, and "unsettled" is not "impossible" -- reporting it as a
      // contradiction would be the gate inventing a fact of its own.
      releases[1].releaseDate = releases[0].releaseDate.slice(0, 4);
      releases[1].datePrecision = 'year';
      write('releases.json', releases);
    }, ['changed 1 releases.datePrecision', 'changed 1 releases.predecessorIds', 'changed 1 releases.releaseDate']);
    const report = JSON.parse(result.stdout);
    const ordering = report.failures.filter(
      (failure) => failure.gate === 'dates' && failure.message.includes('precedes predecessor'),
    );
    assert.deepEqual(ordering, [], `an overlap is not a contradiction:\n${result.stdout}`);
  });

  test('a release that predates the model it descends from is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      // Make the second release descend from the first, then date it earlier.
      releases[1].predecessorIds = [releases[0].id];
      releases[1].releaseDate = '2000-01-01';
      write('releases.json', releases);
    }, ['changed 1 releases.predecessorIds', 'changed 1 releases.releaseDate']);
    assertFailed(result, 'dates', 'precedes predecessor', {
      // Declared rather than tolerated (#369). Backdating the second release is
      // not a single-gate mutation: it also makes that release a lineage
      // neighbour of a family sibling, which `lineage` refuses on its own terms.
      // Both failures are consequences of this one edit, so both are the test's
      // to state -- and the declaration is checked in both directions, so if the
      // lineage consequence ever stops arriving this line fails rather than
      // standing as permanent permission.
      alsoFails: ['lineage'],
    });
  });

  test('a release that is its own predecessor is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].predecessorIds = [releases[0].id];
      write('releases.json', releases);
    }, ['changed 1 releases.predecessorIds']);
    assertFailed(result, 'lineage', 'contains the release itself');
  });

  test('a predecessor cycle between two releases is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].predecessorIds = [releases[1].id];
      releases[1].predecessorIds = [releases[0].id];
      write('releases.json', releases);
    }, ['changed 2 releases.predecessorIds']);
    assertFailed(result, 'lineage');
  });

  // Succession is a partial order over time, so a chain of successorIds can
  // never lead back to where it began. The gate long walked the predecessor
  // graph for cycles but not the successor graph, and the "each claim to
  // precede the other" check reads only predecessorIds -- so a pure
  // successorIds cycle, with predecessors left empty, was accepted (issue #868,
  // a shape an unattended ADR-0003 refresh can produce by applying two
  // successor-adding claims without their matching predecessor edges).
  //
  // These subjects are fixed rather than positional, and deliberately so. The
  // issue's first probe picked releases that happened to be siblings, and every
  // lineage edge between siblings is refused for that reason alone -- which made
  // the broken gate look like it already refused the cycle. So each mutation
  // arm below names releases verified lineage-free, in different families, and
  // non-siblings in both directions, and the block carries an arm whose expected
  // result is *pass* (`a consistent reciprocal edge still passes`): without it a
  // fixture that failed everything would read as a working gate.
  const CYCLE_A = 'openai-gpt-4-1-2025-04-14';
  const CYCLE_B = 'openai-gpt-5-6-sol';
  const CYCLE_C = 'anthropic-claude-opus-4-6';
  const findRelease = (releases, id) => {
    const release = releases.find((candidate) => candidate.id === id);
    assert.ok(release, `fixture expected release "${id}" to exist`);
    return release;
  };
  // The subjects have to stay the lineage-free, non-sibling, cross-family shape
  // the arms below rely on; if the dataset ever entangles them, the mutation no
  // longer isolates the cycle and the arms would mislead. Assert that here so the
  // fixture fails loudly rather than silently testing the wrong thing.
  test('the successor-cycle subjects are lineage-free non-siblings, so the mutations isolate the cycle', () => {
    const releases = JSON.parse(readFileSync(join(DATA, 'releases.json'), 'utf8'));
    const ids = [CYCLE_A, CYCLE_B, CYCLE_C];
    const subjects = ids.map((id) => findRelease(releases, id));
    for (const subject of subjects) {
      for (const field of ['predecessorIds', 'successorIds', 'siblingIds', 'derivedFromIds']) {
        const list = subject[field] ?? [];
        for (const other of ids) {
          assert.ok(
            !list.includes(other),
            `subject "${subject.id}" already lists "${other}" in ${field}; pick different subjects`,
          );
        }
      }
    }
    const families = new Set(subjects.map((subject) => subject.familyId));
    assert.equal(families.size, ids.length, 'successor-cycle subjects must be in different families');
  });

  test('a successor 2-cycle with empty predecessors is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      findRelease(releases, CYCLE_A).successorIds = [CYCLE_B];
      findRelease(releases, CYCLE_B).successorIds = [CYCLE_A];
      write('releases.json', releases);
    }, ['changed 2 releases.successorIds']);
    assertFailed(result, 'lineage', 'successor cycle');
  });

  test('a longer successor cycle (A -> B -> C -> A) is caught too, so the check is not 2-only', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      findRelease(releases, CYCLE_A).successorIds = [CYCLE_B];
      findRelease(releases, CYCLE_B).successorIds = [CYCLE_C];
      findRelease(releases, CYCLE_C).successorIds = [CYCLE_A];
      write('releases.json', releases);
    }, ['changed 3 releases.successorIds']);
    assertFailed(result, 'lineage', 'successor cycle');
  });

  // The passing arm. A consistent reciprocal edge -- one side names the other as
  // successor, the other names it back as predecessor -- is legitimate and must
  // keep passing. This is what stops the fix from being "refuse reciprocal
  // lineage wholesale", and it is the arm that reveals a fixture failing for the
  // wrong reason, because it fails with the same message as a real cycle would.
  test('a consistent reciprocal successor/predecessor edge still passes', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      findRelease(releases, CYCLE_A).successorIds = [CYCLE_B];
      findRelease(releases, CYCLE_B).predecessorIds = [CYCLE_A];
      write('releases.json', releases);
    }, ['changed 1 releases.predecessorIds', 'changed 1 releases.successorIds']);
    assert.equal(result.code, 0, `expected exit 0, got ${result.code}:\n${result.stdout}`);
  });

  test('a release attributed away from its family owner is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      const organizations = read('organizations.json');
      const other = organizations.find((organization) => organization.id !== releases[0].organizationId);
      releases[0].organizationId = other.id;
      write('releases.json', releases);
    }, ['changed 1 releases.organizationId']);
    assertFailed(result, 'entity-boundary', 'belongs to');
  });

  test('a publisher squatting on a creator id without being its voice is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const publishers = read('publishers.json');
      const impostor = publishers.find((publisher) => publisher.organizationId);
      delete impostor.organizationId;
      write('publishers.json', publishers);
    }, ['changed 1 publishers.organizationId']);
    assertFailed(result, 'entity-boundary', 'without declaring organizationId');
  });

  test('an http source url is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      sources[0].url = 'http://openai.com/news/';
      write('sources.json', sources);
    }, ['changed 1 sources.url']);
    assertFailed(result, 'urls', 'is not https');
  });

  test('a source hosted on localhost is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      sources[0].url = 'https://localhost/news/';
      write('sources.json', sources);
    }, ['changed 1 sources.url']);
    assertFailed(result, 'urls', 'cannot stand behind a public fact');
  });

  test('a fact with no primary source is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const families = read('families.json');
      families[0].sourceIds = [];
      write('families.json', families);
    }, ['changed 1 families.sourceIds']);
    assertFailed(result, 'evidence', 'no primary source');
  });

  test('a composite score field is caught wherever it is buried', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].parameters = { ...releases[0].parameters, overallScore: 91 };
      write('releases.json', releases);
    }, ['changed 1 releases.parameters']);
    assertFailed(result, 'no-composite-score', 'ranking or composite score');
  });

  // -------------------------------------------------------------------------
  // abdeslam-menacere/ModelTree#495: the six documents this gate did not read.
  //
  // Each of these mutations exits 0 against the gate as it stood at this
  // branch's merge-base -- not because the data was fine, but because the file
  // was never opened. They are written against the rules the documents are now
  // held to, one fault at a time, so a rule quietly losing its new collection
  // shows up as a specific green test rather than as a smaller run.
  // -------------------------------------------------------------------------

  /**
   * One dangling id per newly-validated edge. `list` says whether the field
   * holds an array, since a bad member and a bad scalar reach the rule by
   * different paths in `gateReferences`.
   */
  const NEW_REFERENCE_EDGES = [
    { file: 'products.json', field: 'organizationId', target: 'organization' },
    { file: 'products.json', field: 'releaseIds', target: 'release', list: true },
    { file: 'products.json', field: 'sourceIds', target: 'source', list: true },
    { file: 'serving-platforms.json', field: 'organizationId', target: 'organization' },
    { file: 'serving-platforms.json', field: 'sourceIds', target: 'source', list: true },
    { file: 'deployments.json', field: 'releaseId', target: 'release' },
    { file: 'deployments.json', field: 'platformId', target: 'servingPlatform' },
    { file: 'deployments.json', field: 'sourceIds', target: 'source', list: true },
    { file: 'benchmarks.json', field: 'sourceIds', target: 'source', list: true },
    { file: 'benchmark-results.json', field: 'benchmarkId', target: 'benchmark' },
    { file: 'benchmark-results.json', field: 'releaseId', target: 'release' },
    { file: 'benchmark-results.json', field: 'sourceIds', target: 'source', list: true },
    { file: 'release-events.json', field: 'releaseId', target: 'release' },
    { file: 'release-events.json', field: 'sourceIds', target: 'source', list: true },
  ];

  for (const { file, field, target, list } of NEW_REFERENCE_EDGES) {
    test(`a dangling ${field} in ${file} is caught`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        const entries = read(file);
        entries[0][field] = list ? ['no-such-thing'] : 'no-such-thing';
        write(file, entries);
      }, [`changed 1 ${documentLabel(file)}.${field}`]);
      assertFailed(result, 'references', `does not resolve to a ${target}`);
    });
  }

  // The evidence rule over the collections that joined `SOURCED_COLLECTIONS`.
  // Both halves, because they fail for different reasons and a collection can
  // lose one without losing the other.
  const NEWLY_SOURCED = [
    'products.json', 'serving-platforms.json', 'deployments.json',
    'benchmarks.json', 'benchmark-results.json', 'release-events.json',
  ];

  for (const file of NEWLY_SOURCED) {
    test(`a fact in ${file} with no primary source is caught`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        const entries = read(file);
        entries[0].sourceIds = [];
        write(file, entries);
      }, [`changed 1 ${documentLabel(file)}.sourceIds`]);
      assertFailed(result, 'evidence', 'no primary source');
    });

    test(`a fact in ${file} with no usable verifiedAt is caught`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        const entries = read(file);
        entries[0].verifiedAt = 'sometime in April';
        write(file, entries);
      }, [`changed 1 ${documentLabel(file)}.verifiedAt`]);
      // `verifiedAt` is an exact-date field as well as the evidence rule's
      // freshness stamp, so one unparseable value is genuinely two faults. Both
      // are declared rather than the assertion being loosened, because losing
      // either rule over this collection should still turn this test red.
      assertFailed(result, 'evidence', 'no usable verifiedAt', { alsoFails: ['dates'] });
    });
  }

  test('a serving platform reachable only over http is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const platforms = read('serving-platforms.json');
      platforms[0].website = 'http://ai.azure.com/';
      write('serving-platforms.json', platforms);
    }, ['changed 1 serving-platforms.website']);
    assertFailed(result, 'urls', 'is not https');
  });

  test('a serving platform reachable only on an internal host is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const platforms = read('serving-platforms.json');
      platforms[0].website = 'https://console.internal/';
      write('serving-platforms.json', platforms);
    }, ['changed 1 serving-platforms.website']);
    assertFailed(result, 'urls', 'cannot stand behind a public fact');
  });

  // `date` was named in PRECISION_COMPANIONS but in neither date-field list, and
  // the companion rule skips a value it cannot parse. So a malformed release
  // event date was checked by nothing at all, even once the document was loaded.
  test('a malformed release event date is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const events = read('release-events.json');
      events[0].date = '2026-13-45';
      write('release-events.json', events);
    }, ['changed 1 release-events.date']);
    assertFailed(result, 'dates', 'is not a real date');
  });

  test('a release event dated in the future is caught', () => {
    const result = gateDatasetAt('2026-01-01', ({ read, write }) => {
      const events = read('release-events.json');
      events[0].date = '2026-06-01';
      write('release-events.json', events);
    }, ['changed 1 release-events.date']);
    // Every other date in the live dataset is judged against the same stated
    // day, and the dataset holds records later than it, so the declaration is
    // the clock's doing rather than this mutation's.
    assertFailed(result, 'dates', 'is in the future');
  });

  test('a release event whose declared precision contradicts its date is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const events = read('release-events.json');
      events[0].date = '2026-08';
      events[0].datePrecision = 'day';
      write('release-events.json', events);
    }, ['changed 1 release-events.date']);
    assertFailed(result, 'dates', 'does not state the precision');
  });

  // -------------------------------------------------------------------------
  // The bound score. `no-composite-score` refuses the vocabulary outright, and
  // `benchmarkResults` is the single place the dataset states a number the
  // product does want published. What is admitted is a score *bound* to a named
  // benchmark and a unit -- never the word `score` on its own -- so every case
  // a plain exemption would have let through is enumerated here and watched
  // failing. If any of these ever goes green the rule has become an exemption.
  // -------------------------------------------------------------------------

  test('the live benchmark results really do carry a top-level score', () => {
    // Without this the whole block below could be vacuous: a dataset with no
    // `score` anywhere would satisfy every refusal here and prove nothing about
    // the admission, which is the half that carries risk.
    const results = JSON.parse(readFileSync(join(DATA, 'benchmark-results.json'), 'utf8'));
    const bound = results.filter((entry) => Object.hasOwn(entry, 'score')
      && typeof entry.benchmarkId === 'string' && typeof entry.unit === 'string');
    assert.ok(
      bound.length > 0,
      'no committed benchmark result carries a bound score, so the admission below is untested by the live run',
    );
  });

  test('a benchmark result score with no benchmarkId to bind it is refused', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const results = read('benchmark-results.json');
      delete results[0].benchmarkId;
      write('benchmark-results.json', results);
    }, ['changed 1 benchmark-results.benchmarkId']);
    assertFailed(result, 'no-composite-score', 'carries no benchmarkId and unit to bind it');
  });

  test('a benchmark result score with no unit to bind it is refused', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const results = read('benchmark-results.json');
      delete results[0].unit;
      write('benchmark-results.json', results);
    }, ['changed 1 benchmark-results.unit']);
    assertFailed(result, 'no-composite-score', 'carries no benchmarkId and unit to bind it');
  });

  test('a benchmarkId that is not a string binds nothing, so the score is refused', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const results = read('benchmark-results.json');
      results[0].benchmarkId = 42;
      write('benchmark-results.json', results);
    }, ['changed 1 benchmark-results.benchmarkId']);
    // `references` is the same fault seen from the other side: a non-string id
    // resolves to no benchmark either. Both firing is the binding being checked
    // rather than assumed, which is why the admission can rest on it.
    assertFailed(result, 'no-composite-score', 'carries no benchmarkId and unit to bind it', {
      alsoFails: ['references'],
    });
  });

  test('an overallScore on a benchmark result is refused, bound or not', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const results = read('benchmark-results.json');
      results[0].overallScore = 91;
      write('benchmark-results.json', results);
    }, ['changed 1 benchmark-results.overallScore']);
    assertFailed(result, 'no-composite-score', 'reads as a ranking or composite score');
  });

  for (const field of ['rank', 'tier', 'rating', 'compositeScore', 'leaderboard', 'percentile']) {
    test(`a ${field} on a benchmark result is refused`, () => {
      const result = gateMutatedDataset(({ read, write }) => {
        const results = read('benchmark-results.json');
        results[0][field] = 1;
        write('benchmark-results.json', results);
      }, [`changed 1 benchmark-results.${field}`]);
      assertFailed(result, 'no-composite-score', 'reads as a ranking or composite score');
    });
  }

  test('a score nested inside a benchmark result is refused, whatever the record binds', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const results = read('benchmark-results.json');
      results[0].summary = { score: 91 };
      write('benchmark-results.json', results);
    }, ['changed 1 benchmark-results.summary']);
    assertFailed(result, 'no-composite-score', 'field "summary.score" reads as a ranking');
  });

  test('a score inside an array on a benchmark result is refused', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const results = read('benchmark-results.json');
      results[0].runs = [{ score: 91 }];
      write('benchmark-results.json', results);
    }, ['changed 1 benchmark-results.runs']);
    assertFailed(result, 'no-composite-score', 'field "runs[0].score" reads as a ranking');
  });

  test('a bound-looking score in another collection is still refused', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      // Carrying both halves of the binding, so this fails for being in the
      // wrong collection rather than for being unbound: the admission is keyed
      // on benchmarkResults and not on the presence of two field names.
      releases[0].score = 74.3;
      releases[0].benchmarkId = 'mmlu-pro';
      releases[0].unit = 'percent';
      write('releases.json', releases);
    }, ['changed 1 releases.benchmarkId', 'changed 1 releases.score', 'changed 1 releases.unit']);
    assertFailed(result, 'no-composite-score', 'field "score" reads as a ranking or composite score');
  });

  test('a benchmark definition carrying a score is refused, though it names benchmarks', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const benchmarks = read('benchmarks.json');
      benchmarks[0].score = 91;
      benchmarks[0].unit = 'percent';
      write('benchmarks.json', benchmarks);
    }, ['changed 1 benchmarks.score', 'changed 1 benchmarks.unit']);
    assertFailed(result, 'no-composite-score', 'reads as a ranking or composite score');
  });

  test('a source checked before it was published is caught', () => {
    const result = gateMutatedDataset(({ read, write }) => {
      const sources = read('sources.json');
      const dated = sources.find((source) => source.publishedDate);
      dated.lastCheckedDate = '2000-01-01';
      write('sources.json', sources);
    }, ['changed 1 sources.lastCheckedDate']);
    assertFailed(result, 'dates', 'precedes publishedDate');
  });

  test('a malformed dataset document fails rather than being skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
    try {
      cpSync(DATA, dir, { recursive: true });
      writeFileSync(join(dir, 'releases.json'), '{not json');
      const result = run(GATE_DATASET, ['--data', dir, '--json']);
      assertFailed(result, 'well-formed', 'not valid JSON', {
        // Declared rather than tolerated (#369). An unparseable `releases.json`
        // loads as no releases at all, so every record in the other documents
        // that points at a release dangles and `references` fires a dozen times
        // over. That cascade is the direct consequence of this mutation, not
        // noise from somewhere else, so the test states it.
        //
        // `family-has-release` joins it for the same reason and by the same
        // arithmetic (#441): with zero releases loaded, no family is pointed at
        // by one, so every family in the dataset is genuinely empty and the rule
        // reports each. Declaring it is not a relaxation -- `assertFailed`
        // checks a declaration in both directions, so this line fails the day
        // the cascade stops happening, and the upper bound on undeclared gates
        // is untouched. The alternative, silencing the rule when `releases` is
        // empty, would have put a blind spot exactly where the dataset is most
        // broken.
        //
        // `non-empty` joined them with #548, and it is the fail-closed half of
        // that rule rather than a third piece of fallout. `loadDocuments`
        // degrades an unparseable document to `[]`, which is the one input a
        // collection floor must not read as "a collection that happens to be
        // empty"; it does not, so an unreadable `releases.json` is now refused
        // both for being unreadable and for leaving a load-bearing collection at
        // zero. Two reports of one fault, and the second is the one that would
        // still fire if `well-formed` ever stopped looking.
        alsoFails: ['references', 'family-has-release', 'non-empty'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // The three states of one dataset document (#312). A document can be
  // **absent**, **unknown** (present but not what it claims to be), or
  // **present-but-stale**. They fail differently and none implies another, so
  // each is stated rather than inferred from its neighbour.
  //
  // The stale cell is deliberately empty and is not a gap: this gate applies no
  // freshness floor to a record, and nothing here caches a document between
  // runs, so a document has no stale state to test. Inventing one to fill the
  // row would be worse than saying so.
  //
  // The absent *directory* test below is a fourth thing again, and covers none
  // of these: it exits 2 before any document is looked for.
  // -------------------------------------------------------------------------

  // `usage-syntheses.json` is the document to delete, and the choice is the
  // whole test. Nothing references it, so the missing-document rule is the only
  // thing standing between a deleted document and exit 0 -- delete
  // `releases.json` instead and a wall of dangling-reference failures fires,
  // which would pass this assertion while proving nothing about the rule under
  // test. Removing the rule leaves the suite green and the gate publishing a
  // dataset with a document silently gone.
  test('a dataset document that is absent entirely is caught, not read as an empty collection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
    try {
      cpSync(DATA, dir, { recursive: true });
      rmSync(join(dir, 'usage-syntheses.json'));
      const result = run(GATE_DATASET, ['--data', dir, '--json']);
      assertFailed(result, 'well-formed', 'dataset document is missing');
      const report = JSON.parse(result.stdout);
      assert.ok(
        report.failures.some((failure) => failure.where === 'usage-syntheses.json'),
        `the refusal must name the document that vanished:\n${result.stdout}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The sibling of `a malformed dataset document fails rather than being
  // skipped` above, which reaches only the *unparseable* branch. A document that
  // parses cleanly but is an object, a string or a number takes a different
  // branch entirely, and without this rule would load as an empty collection --
  // which every other gate in this file accepts, because an empty collection has
  // no dangling references, no duplicate ids and no out-of-range dates.
  test('a dataset document that parses but is not an array is caught, not loaded as empty', () => {
    for (const body of ['{"usageSyntheses": []}', '"a string"', '42', 'null']) {
      const dir = mkdtempSync(join(tmpdir(), 'modeltree-gate-'));
      try {
        cpSync(DATA, dir, { recursive: true });
        writeFileSync(join(dir, 'usage-syntheses.json'), body);
        const result = run(GATE_DATASET, ['--data', dir, '--json']);
        assertFailed(result, 'well-formed', 'must be a JSON array');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // `--today`'s three states, and this is the one that fails open. **Absent** is
  // the live path, asserted at the top of this block. **Present-but-stale** -- an
  // older day supplied on purpose -- is what `gateDatasetAt` exists for and what
  // the later-day test above exercises. **Unknown** is here.
  //
  // Why it is the dangerous one: every future-date rule in this gate is a `>`
  // comparison against `startOf(today)`, and `startOf("tomorrow")` is NaN. NaN
  // loses every comparison, so an unvalidated `--today` does not shift the clock
  // by a day, it deletes the entire future-date gate while still exiting 0.
  //
  // `''` used to sit in the list below and no longer does. It is not a day that
  // failed to parse -- it is the flag arriving with no value at all, which #372
  // moved earlier, to `parseArgs`, where it exits 2 naming the flag rather than
  // the date. The case is still asserted, in `--today with no value exits 2
  // rather than falling back to the wall clock`; it changed owner, not verdict.
  test('--today that is not a real date exits 2 rather than disabling every future-date rule', () => {
    for (const bad of ['not-a-date', 'tomorrow', '2026-13-01', '2026-02-30', '26-08-25']) {
      const result = run(GATE_DATASET, ['--data', DATA, '--today', bad, '--json']);
      assert.equal(result.code, 2, `--today ${JSON.stringify(bad)} must not be accepted:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes('is not a real date'),
        `the refusal must name the flag, not fail for some other reason:\n${result.stdout}`,
      );
    }

    // The consequence the guard exists to prevent, stated as a scenario so the
    // test above is anchored to something observable rather than to an exit
    // code: on a real clock a record dated far in the future is caught, so a
    // `--today` that waved it through would be this gate going blind.
    const future = gateMutatedDataset(({ read, write }) => {
      const releases = read('releases.json');
      releases[0].verifiedAt = '2099-01-01';
      write('releases.json', releases);
    }, ['changed 1 releases.verifiedAt']);
    assertFailed(future, 'dates', 'is in the future');
  });

  // The mirror of gate-scope's `an unknown flag exits 2 rather than being
  // ignored`, and stated per gate rather than inferred across them: these four
  // scripts each hand-roll their own `parseArgs`, so a guarantee proved on one
  // is not a guarantee about another. #168 is open on exactly that drift.
  test('an unknown flag on the dataset gate exits 2 rather than being ignored', () => {
    for (const flag of ['--force', '--skip', '--skip-gates', '--yes']) {
      const result = run(GATE_DATASET, ['--data', DATA, flag, '--json']);
      assert.equal(result.code, 2, `${flag} must not be recognised, and must never be a pass:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes(`unknown flag ${flag}`),
        `the refusal must name the flag it did not recognise:\n${result.stdout}`,
      );
    }
  });

  // `--data` in its **absent** state. The test below is a different cell and
  // does not cover this one: it supplies `--data <a path that does not exist>`,
  // which is the *unknown* state. Absent means the flag is not passed at all,
  // and the two take different branches where `gate-dataset.mjs` resolves
  // `dataDir`:
  //
  //     const dataDir = args.data ? resolve(args.data) : join(repoRoot(), ...);
  //
  // Every other `run(GATE_DATASET, ...)` call site in this file passes `--data`,
  // so before this test the fallback arm was never executed once. A `repoRoot()`
  // with the wrong number of `..` segments -- the ordinary way that line breaks,
  // since it counts directories by hand -- was caught by nothing.
  //
  // Asserting the resolved directory, and not just the exit code, is the point.
  // A gate that fell back to the wrong place but happened to find some dataset
  // there would still exit 0, so the code alone cannot tell the two apart. The
  // counts assertion then proves it actually loaded what it named, rather than
  // reporting a path it never opened.
  //
  // No `--today`: this reads the live dataset, so it is bound by the two-clock
  // rule at the top of this file exactly as the first test in this block is.
  test('with no --data at all the gate falls back to this repository, not to nothing', () => {
    const result = run(GATE_DATASET, ['--json']);
    assert.equal(result.code, 0, `the live dataset must pass when found by fallback:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(
      resolve(report.dataDir),
      resolve(DATA),
      'the fallback must resolve to this repository\'s own web/src/data',
    );
    assert.ok(report.counts.sources > 0, `the fallback directory must be the one actually read:\n${result.stdout}`);
  });

  // The **unknown** state of the same input: supplied, but naming nothing.
  //
  // Exit 2 on its own did not establish that this guard is what fired
  // (abdeslam-menacere/ModelTree#637). `gate-dataset.mjs` refuses at 2 from four
  // places -- the two `parseArgs` guards, this one, and the `--today` check --
  // so the bare assertion this test used to make read a code without being able
  // to say which of them produced it. Measured, not assumed: rename `--data` in
  // `parseArgs` and the argv below becomes an unrecognised flag, the run refuses
  // with `gate-dataset: unknown flag --data` at the same exit code, this guard is
  // never reached at all, and the test stayed green while pinning a behaviour it
  // no longer exercised.
  //
  // Each assertion has a job, and the order is deliberate:
  //
  //  * the positive one names the path that must have fired, and comes first
  //    because it is the claim the test is named for. Deleting the guard
  //    outright drops the run to exit **1** -- every document then reads as
  //    missing and `non-empty` refuses, which is a verdict about the directory
  //    rather than a refusal to gate it -- so a code-first ordering reports
  //    `1 !== 2` where this one names the regression.
  //  * the negative one rules out the two `parseArgs` refusals, the only other
  //    exit-2 text this argv can reach, so a flag surface drifting away from
  //    `--data` cannot keep this test green.
  //  * the code is asserted last and is still load-bearing: strip only the
  //    `return 2` and the guard warns without refusing, which satisfies both
  //    message assertions and is caught by nothing else.
  //
  // The positive assertion stops at the identifying clause and never reaches the
  // interpolated directory, which is a machine-specific temporary path carrying
  // Windows backslashes -- the same reasoning recorded for `"dataDir"` below.
  test('a missing data directory exits 2 rather than passing', () => {
    const result = run(GATE_DATASET, ['--data', join(tmpdir(), 'modeltree-does-not-exist'), '--json']);
    assert.match(
      result.stdout,
      /gate-dataset: no data directory at/,
      `the refusal must name the missing directory, not merely exit 2:\n${result.stdout}`,
    );
    assert.ok(
      !/unknown flag|needs a value/.test(result.stdout),
      'a directory that does not exist must be refused as missing, never as a flag this gate '
      + `does not recognise nor as a flag carrying no value:\n${result.stdout}`,
    );
    assert.equal(result.code, 2, `a gate that cannot run must not report success:\n${result.stdout}`);
  });

  // `--data` in a fourth state, and the only one of the four that failed open:
  // **supplied, but carrying nothing**. `argv[++i]` on a flag written last is
  // `undefined`, which is falsy, so the fallback arm two tests up ran and gated
  // this repository's own `web/src/data` -- a directory the caller never named
  // -- and exited 0. A green verdict about a different input is indistinguishable
  // from a green verdict, which is the failure this gate set exists to prevent
  // occurring in the gate set itself (#372).
  //
  // The exit code alone cannot state that, which is why the third assertion is
  // here rather than implied: the fallback dataset *passes*, so the defect's
  // signature is `code === 0` **plus a report about a directory nobody asked
  // for**, and a gate that refuses must produce no verdict at all. `"dataDir"`
  // is the key every `--json` report carries, so its absence is that claim.
  // Asserting the path itself instead would not survive JSON's backslash
  // escaping on Windows -- the substring would be absent either way, and the
  // assertion would pass while proving nothing.
  //
  // `''` is the same state reached without anyone typing a malformed command:
  // PowerShell strips embedded double quotes from native-command arguments, so
  // `--data ""` arrives here as an empty string.
  test('--data with no value exits 2 rather than falling back to this repository', () => {
    for (const argv of [['--json', '--data'], ['--data', '', '--json']]) {
      const result = run(GATE_DATASET, argv);
      assert.equal(result.code, 2, `${JSON.stringify(argv)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-dataset: --data needs a value/);
      assert.ok(
        !result.stdout.includes('"dataDir"'),
        `a refused invocation must report no verdict about any directory:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass: the guard must refuse a value-less
    // flag without making the flag unusable. No `--today` here, per the
    // two-clock rule at the top of this file.
    const control = run(GATE_DATASET, ['--data', DATA, '--json']);
    assert.equal(control.code, 0, `--data with a real value must still gate:\n${control.stdout}`);
    assert.equal(
      resolve(JSON.parse(control.stdout).dataDir),
      resolve(DATA),
      'and must gate the directory it was given',
    );
  });

  // The same defect on this gate's other value-taking flag, and a quieter one:
  // `--today` has no directory to name, so a value that went missing left
  // `undefined` for `args.today ?? new Date()...` to replace with the wall
  // clock. The gate then judged the dataset against a day the caller never
  // chose and exited 0 -- which, on a run pinning an older day on purpose, is
  // the future-date rule silently evaluated at the wrong instant (#372).
  //
  // `"today"` is the report key that carries the claim: a refused invocation
  // must not have reported a day at all. Note the second argv exits 2 either
  // way -- an empty string reached `isRealDate` before the fix -- so the code
  // assertion cannot separate them and the message is what does.
  test('--today with no value exits 2 rather than falling back to the wall clock', () => {
    for (const argv of [['--data', DATA, '--json', '--today'], ['--data', DATA, '--today', '', '--json']]) {
      const result = run(GATE_DATASET, argv);
      assert.equal(result.code, 2, `${JSON.stringify(argv)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-dataset: --today needs a value/);
      assert.ok(
        !result.stdout.includes('"today"'),
        `a refused invocation must report no verdict against any day:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass. Tomorrow is a day simulated on
    // purpose, which is what a supplied clock means in this file -- never
    // "today" -- and every live record is dated on or before today, so this
    // passes for as long as the first test in this block does. The reported day
    // is asserted because it is what separates "the value was carried through"
    // from "the wall clock was used and happened to agree".
    const simulated = shiftDays(realToday(), 1);
    const control = run(GATE_DATASET, ['--data', DATA, '--today', simulated, '--json']);
    assert.equal(control.code, 0, `--today with a real value must still gate:\n${control.stdout}`);
    assert.equal(JSON.parse(control.stdout).today, simulated, 'and must be judged on the day it was given');
  });
});

// ---------------------------------------------------------------------------

const HASH = `sha256:${'a'.repeat(64)}`;

function claim(overrides = {}) {
  return {
    id: 'openai-gpt-5-7-release-date',
    kind: 'change',
    collection: 'releases',
    targetId: 'openai-gpt-5-7',
    field: 'releaseDate',
    currentValue: '2026-08-01',
    proposedValue: '2026-08-20',
    statement: 'GPT-5.7 was released on 20 August 2026.',
    evidence: [{
      sourceId: 'openai-gpt-5-7-announcement',
      url: 'https://openai.com/index/gpt-5-7/',
      contentHash: HASH,
      fetchedAt: '2026-08-25',
      quote: 'Today we are releasing GPT-5.7 to all API customers.',
      retrieval: 'fetch',
    }],
    verdicts: [
      { reviewer: 'provenance', vote: 'accept', rationale: 'The announcement states the date directly.' },
      { reviewer: 'consistency', vote: 'accept', rationale: 'Consistent with the family timeline.' },
      { reviewer: 'editorial', vote: 'accept', rationale: 'Release, not product; boundary respected.' },
    ],
    ...overrides,
  };
}

// A bundle's policy is derived from its creator (#233), so every bundle now
// names one. Tests that are not about derivation take a reviewed (pilot) creator
// by default, so their declared `pilot` matches the policy derived from the
// reviewed-profile set; the derivation tests below set `creator` explicitly to
// exercise the long-tail and mismatch cases. A bundle carrying no `policy` is
// left untouched, so the absent-policy refusal still sees the bundle as written.
const DEFAULT_PILOT_CREATOR = 'openai';

function gateBundle(bundle, options = {}) {
  const withCreator = Object.hasOwn(bundle, 'creator') || !Object.hasOwn(bundle, 'policy')
    ? bundle
    : { ...bundle, creator: DEFAULT_PILOT_CREATOR };
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
  try {
    const path = join(dir, 'claims.json');
    writeFileSync(path, JSON.stringify(withCreator, null, 2));
    const extra = options.repo ? ['--repo', options.repo] : [];
    return run(GATE_EVIDENCE, ['--claims', path, '--today', TODAY, '--json', ...extra]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A scratch repository whose reviewed-profile set holds exactly `entries`, for
 * the loader's own rules (#251). A string value is written verbatim, an object
 * is written as JSON, and `null` makes a directory of that name -- which is how
 * the "a directory is never a candidate" case is stated.
 */
function repoWithProfiles(entries) {
  const repo = mkdtempSync(join(tmpdir(), 'modeltree-reviewed-set-'));
  const dir = join(repo, 'tools', 'updater', 'profiles');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(entries)) {
    if (body === null) mkdirSync(join(dir, name), { recursive: true });
    else writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return repo;
}

/**
 * As `gateBundle`, but the argument list is stated in full: no `--today` is
 * supplied unless `args` carries one.
 *
 * `gateBundle` always pins the clock, which is right for a fixture and wrong for
 * the tests that are *about* the clock flag -- an absent `--today` and an
 * unknown one are states of that input in their own right (#312), and neither is
 * reachable through a helper that always supplies a good value.
 */
function gateBundleWithArgs(bundle, args) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
  try {
    const path = join(dir, 'claims.json');
    writeFileSync(path, JSON.stringify(bundle, null, 2));
    return run(GATE_EVIDENCE, ['--claims', path, '--json', ...args]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gate-evidence', () => {
  test('a fully evidenced, unanimously accepted claim passes', () => {
    const result = gateBundle({ runId: 'r1', creator: 'openai', policy: 'pilot', claims: [claim()] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 1);
  });

  test('a search snippet is refused as evidence', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], retrieval: 'search-snippet' }] })],
    });
    assertFailed(result, 'evidence', 'a search snippet is never evidence');
  });

  test('evidence with no content hash is refused', () => {
    const evidence = { ...claim().evidence[0] };
    delete evidence.contentHash;
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [evidence] })] });
    assertFailed(result, 'evidence', 'is not shaped sha256:<64 hex>');
  });

  test('a hash that is not a sha256 digest is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], contentHash: 'sha256:short' }] })],
    });
    assertFailed(result, 'evidence', 'is not shaped sha256:<64 hex>');
  });

  test('a quote too short to show the source stating the claim is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], quote: 'yes' }] })],
    });
    assertFailed(result, 'evidence', 'shorter than');
  });

  // ADR 0005: the evidence gate verifies the FORM of contentHash and quote, never
  // that they correspond to the remote page. It fetches nothing, so a fabricated
  // digest and an invented quote pass provided both are well-formed. This test
  // pins that accepted limit as executable characterisation (#240 AC1). The digest
  // is a literal, deliberately not the fixture's default and not computed by any
  // hashing helper, so the test cannot silently become a tautology against a hash
  // function. It is capable of failing: were the gate to gain real content
  // verification, or were the shape/length checks tightened to reject these
  // well-formed values, this claim would stop passing.
  test('a fabricated content hash and an invented quote still pass, because the gate checks only form (ADR 0005)', () => {
    const fabricated = `sha256:${'0123456789abcdef'.repeat(4)}`;
    const fixtureHash = claim().evidence[0].contentHash;
    assert.notEqual(fabricated, fixtureHash, 'the fabricated hash must differ from the fixture default');
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        evidence: [{
          ...claim().evidence[0],
          contentHash: fabricated,
          quote: 'This sentence never appeared on the cited page and was invented wholesale.',
        }],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.equal(report.applicable, 1);
    assert.equal(
      report.failures.filter((f) => f.gate === 'evidence').length,
      0,
      'the gate raises no evidence failure for a well-formed but fabricated citation',
    );
  });

  test('a claim with no evidence at all is refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [] })] });
    assertFailed(result, 'evidence', 'no evidence at all');
  });

  test('a 1-of-3 minority cannot apply a change', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'ok' },
          { reviewer: 'consistency', vote: 'reject', rationale: 'contradicts the family timeline' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'conflates product with release' },
        ],
      })],
    });
    assertFailed(result, 'review', 'only reached 1 of 2 required accepts');
  });

  test('a 2-of-3 majority is enough for a pilot creator', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
  });

  test('the same 2-of-3 majority is NOT enough for a long-tail creator', () => {
    const result = gateBundle({
      creator: 'some-long-tail-creator',
      policy: 'long-tail',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assertFailed(result, 'review', 'only reached 2 of 3 required accepts');
  });

  test('an incomplete panel is refused even when every reported vote accepts', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
        ],
      })],
    });
    assertFailed(result, 'review', 'never reported');
  });

  test('one reviewer voting twice cannot manufacture a majority', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly again' },
          { reviewer: 'editorial', vote: 'accept', rationale: 'fine' },
        ],
      })],
    });
    assertFailed(result, 'review', 'voted twice');
  });

  test('a verdict with no rationale is refused as unauditable', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: '' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'accept', rationale: 'fine' },
        ],
      })],
    });
    assertFailed(result, 'review', 'no rationale');
  });

  test('a change that changes nothing is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ currentValue: '2026-08-20', proposedValue: '2026-08-20' })],
    });
    assertFailed(result, 'shape', 'equals the current value');
  });

  test('a claim aimed at a file outside the dataset is refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim({ collection: 'schema' })] });
    assertFailed(result, 'shape', 'is not a dataset document');
  });

  test('two claims sharing an id are refused', () => {
    const result = gateBundle({ policy: 'pilot', claims: [claim(), claim()] });
    assertFailed(result, 'shape', 'appears more than once');
  });

  test('evidence fetched in the future is refused', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], fetchedAt: '2027-01-01' }] })],
    });
    assertFailed(result, 'evidence', 'is in the future');
  });

  test('an unchanged finding needs evidence but not a majority', () => {
    const result = gateBundle({
      policy: 'pilot',
      claims: [claim({
        kind: 'unchanged',
        verdicts: [
          { reviewer: 'provenance', vote: 'reject', rationale: 'no change found' },
          { reviewer: 'consistency', vote: 'reject', rationale: 'no change found' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'no change found' },
        ],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 0, 'an unchanged finding applies nothing');
  });

  // The code on its own does not say which rule fired (#251, #374). Delete the
  // `existsSync` guard and `readFileSync` throws `ENOENT` straight into the JSON
  // catch, which exits 2 as well -- while telling the caller their bundle is
  // malformed. That is a different fault reported to someone whose file is not
  // there at all, so the message is what separates the two refusals, not the
  // code. The path is pinned too: a refusal that does not name what it looked
  // for cannot be acted on.
  test('a missing bundle exits 2 rather than passing', () => {
    const result = run(GATE_EVIDENCE, ['--claims', join(tmpdir(), 'no-such-bundle.json'), '--json']);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /gate-evidence: no claim bundle at .*no-such-bundle\.json/);
    assert.ok(
      !result.stdout.includes('is not valid JSON'),
      `an absent bundle must not be reported as a malformed one:\n${result.stdout}`,
    );
  });

  // -------------------------------------------------------------------------
  // Valid JSON is not yet a bundle (#186). These are written as three separate
  // blocks rather than one table because they do not fail the same way at the
  // merge-base, and collapsing them would hide which of them is evidence for the
  // change and which is only a pin on what was already true.
  // -------------------------------------------------------------------------

  // **The regression, and the only one.** `null` is the single input the guard
  // repairs. The first read of the bundle is `Object.hasOwn(bundle, 'policy')`;
  // `Object.hasOwn` throws on `null`, nothing catches it, and node exits **1**.
  //
  // Exit 1 is this gate's verdict channel -- "the bundle was read and a claim in
  // it is not admissible" -- so a crash arriving there reports a could-not-run
  // as a decided verdict, in the direction that looks more authoritative rather
  // than less. `modeltree-publish` reads this exit code as a precondition, and
  // its rules say never to treat a 2 as a pass; nobody wrote a rule for a 1 that
  // is really a stack trace, because nobody expected one.
  //
  // This test fails at the merge-base on the code assertion, with the trace in
  // the output. It is the load-bearing case for the change.
  test('a null bundle exits 2 rather than stack-tracing to the verdict code 1', () => {
    const result = gateBundleWithArgs(null, ['--today', TODAY]);
    assert.equal(
      result.code,
      2,
      `a bundle that was never read cannot have produced a verdict:\n${result.stdout}`,
    );
    assert.match(result.stdout, /is not a claim bundle: expected a JSON object, found null/);
    assert.ok(
      !/TypeError|\bat main \(/.test(result.stdout),
      `every other refusal here names what was wrong; a stack trace is not a diagnosis:\n${result.stdout}`,
    );
  });

  // **Pins on existing behaviour, plus one genuine correction.** An array, a
  // string, a number and a boolean were *not* broken before the guard, and this
  // block must not be read as evidence that they were. `Object.hasOwn` coerces
  // its first argument, so each of them boxed harmlessly, found `policy`
  // genuinely absent, and exited 2 already. The code assertion below therefore
  // holds at the merge-base exactly as it holds here, and proves nothing about
  // this change.
  //
  // The message assertion is the half that is new. At the merge-base each of
  // these four is told its bundle has no `policy` and offered the two acceptable
  // policy values -- which sends whoever handed over a JSON array off to add a
  // `policy` field to an array. Naming the actual fault is the correction.
  //
  // The guard is worth having for them even so, because their old refusal was
  // accidental rather than chosen: it rested on a coercion nobody selected and
  // no test pinned, so a refactor reading `bundle.policy` directly -- an
  // ordinary, well-intentioned change -- would have turned all four into crashes
  // at once, and the suite would not have noticed.
  for (const [label, bundle, found] of [
    ['an array', [], 'an array'],
    ['a string', 'x', 'a string'],
    ['a number', 0, 'a number'],
    ['a boolean', true, 'a boolean'],
  ]) {
    test(`${label} bundle keeps its exit 2 (a pin) and names the type as the cause (new)`, () => {
      const result = gateBundleWithArgs(bundle, ['--today', TODAY]);
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stdout, new RegExp(`is not a claim bundle: expected a JSON object, found ${found}`));
      assert.ok(
        !result.stdout.includes('bundle has no policy'),
        `a value that was never an object must not be reported as an object missing a field:\n${result.stdout}`,
      );
    });
  }

  // The boundary control, without which the block above is unreadable. Exit 2
  // does not discriminate here: a well-formed object carrying no `policy`
  // produces exit 2 and always did. So a guard wrong in the other direction --
  // one that swallowed real objects -- would leave every assertion above still
  // passing. This pins the far side: an object goes to the policy refusal and
  // never to the type refusal.
  //
  // It holds at the merge-base too, so it is a pin and not evidence for the
  // change. That is exactly what a control is for.
  test('an empty object is a bundle, so it reaches the policy refusal and not the type guard', () => {
    const result = gateBundleWithArgs({}, ['--today', TODAY]);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /gate-evidence: bundle has no policy/);
    assert.ok(
      !result.stdout.includes('is not a claim bundle'),
      `an object must never be refused as a non-object:\n${result.stdout}`,
    );
  });

  // -------------------------------------------------------------------------
  // `--today`, across its three states (#312). Every other test in this block
  // pins the clock through `gateBundle`, which covers the **present-but-stale**
  // cell -- a day supplied on purpose that is not the real one -- and leaves the
  // other two unexercised. Both are closed here, and they fail differently.
  // -------------------------------------------------------------------------

  // **Absent.** The default path, and the one every documented invocation of
  // this gate takes: `node gate-evidence.mjs --claims <path>` supplies no clock.
  // Until now no test in this file ran it, so the fallback could have been any
  // constant at all -- including one far enough forward to make the future-date
  // rule unreachable -- without the suite noticing.
  test('with no --today the gate falls back to the real clock, so a future fetchedAt is still caught', () => {
    const future = shiftDays(realToday(), 400);
    const result = gateBundleWithArgs({
      runId: 'r1',
      creator: DEFAULT_PILOT_CREATOR,
      policy: 'pilot',
      claims: [claim({ evidence: [{ ...claim().evidence[0], fetchedAt: future }] })],
    }, []);
    assertFailed(result, 'evidence', 'is in the future');
    assert.ok(
      result.stdout.includes(future),
      `the refusal must name the date it read as the future:\n${result.stdout}`,
    );
    // And the clock it compared against is the real one, not a constant that
    // happens to sit before the fixture. A frozen fallback would satisfy the
    // assertion above while being exactly the defect (#318 is the same shape).
    assert.ok(
      [shiftDays(realToday(), -1), realToday()].some((day) => result.stdout.includes(`today is ${day}`)),
      `the fallback clock must be the real one:\n${result.stdout}`,
    );
  });

  // **Unknown.** The dangerous half, for the same reason it is in `gate-dataset`:
  // the future-date rule is a `>` comparison against `startOf(today)`, and
  // `startOf("soon")` is NaN. NaN loses every comparison, so an unvalidated
  // `--today` would not shift the clock, it would delete the rule while still
  // reporting a pass.
  //
  // `''` left this list in #372 for the reason given on the `gate-dataset`
  // sibling above: an empty value is the flag carrying nothing, refused at
  // `parseArgs` and asserted by its own test below, not a date that failed to
  // parse.
  test('--today that is not a real date exits 2 rather than being carried into the comparison', () => {
    for (const bad of ['soon', 'not-a-date', '2026-13-01', '2026-02-30', '26-08-25']) {
      const result = gateBundleWithArgs(
        { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] },
        ['--today', bad],
      );
      assert.equal(result.code, 2, `--today ${JSON.stringify(bad)} must not be accepted:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes('is not a real date'),
        `the refusal must name the flag, not fail for some other reason:\n${result.stdout}`,
      );
    }
  });

  // The mirror of gate-scope's and gate-source-approval's unknown-flag tests.
  // Stated per gate rather than inferred across them: all four scripts hand-roll
  // their own `parseArgs`, and #168 is open on nothing detecting drift between
  // them. ADR 0003's "no escape hatch" guardrail is a claim about every gate.
  test('an unknown flag on the evidence gate exits 2 rather than being ignored', () => {
    for (const flag of ['--force', '--skip', '--skip-gates', '--yes']) {
      const result = gateBundleWithArgs(
        { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] },
        ['--today', TODAY, flag],
      );
      assert.equal(result.code, 2, `${flag} must not be recognised, and must never be a pass:\n${result.stdout}`);
      assert.ok(
        result.stdout.includes(`unknown flag ${flag}`),
        `the refusal must name the flag it did not recognise:\n${result.stdout}`,
      );
    }
  });

  // The three flags this gate takes a value for, each refused when the value is
  // missing rather than replaced by a default (#372). Split one test per flag,
  // because the defaults differ and so does what each substitution costs.
  //
  // `--repo` is the expensive one: it selects the reviewed-profile set the
  // policy threshold is *derived* from, so a value that went missing had this
  // gate hold a bundle to a threshold computed from a tree the caller never
  // named, and report a pass. The report key `"passed"` is the claim that no
  // verdict was reached at all; asserting the root path instead would not
  // survive JSON's backslash escaping on Windows and would pass vacuously.
  test('--repo with no value exits 2 rather than falling back to the tree this script sits in', () => {
    const bundle = { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] };
    for (const args of [['--today', TODAY, '--repo'], ['--today', TODAY, '--repo', '']]) {
      const result = gateBundleWithArgs(bundle, args);
      assert.equal(result.code, 2, `${JSON.stringify(args)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-evidence: --repo needs a value/);
      assert.ok(
        !result.stdout.includes('"passed"'),
        `a refused invocation must reach no verdict about any tree:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass: the flag still selects a root when it
    // is given one, and the report still names it.
    const control = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', REPO]);
    assert.equal(control.code, 0, `--repo with a real value must still gate:\n${control.stdout}`);
    assert.equal(resolve(JSON.parse(control.stdout).repo), resolve(REPO), 'and must gate the tree it was given');
  });

  // `--today`'s missing value fell through to the wall clock, so a run pinning a
  // day on purpose would have had its date rules evaluated at some other
  // instant and still exited 0. The second argv exited 2 before the fix as well
  // -- an empty string reached `isRealDate` -- so the message is what separates
  // the two refusals, not the code.
  test('--today with no value exits 2 rather than falling back to the wall clock', () => {
    const bundle = { runId: 'r1', creator: DEFAULT_PILOT_CREATOR, policy: 'pilot', claims: [claim()] };
    for (const args of [['--today'], ['--today', '']]) {
      const result = gateBundleWithArgs(bundle, args);
      assert.equal(result.code, 2, `${JSON.stringify(args)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-evidence: --today needs a value/);
      assert.ok(
        !result.stdout.includes('"passed"'),
        `a refused invocation must reach no verdict at all:\n${result.stdout}`,
      );
    }

    // Positive control, expected to pass, on the pinned fixture clock.
    const control = gateBundleWithArgs(bundle, ['--today', TODAY]);
    assert.equal(control.code, 0, `--today with a real value must still gate:\n${control.stdout}`);
  });

  // `--claims` is the honest exception in this group, and the test says so
  // rather than borrowing credit from its siblings: this flag never had a
  // default to fall back to, so nothing here was failing open and the exit code
  // was 2 before the fix as well. What changed is that the refusal now names
  // what happened. "`--claims <path>` is required" is what a caller who omitted
  // the flag entirely is told, and reporting that to a caller who *did* pass it
  // -- whose value expanded to nothing under a shell that strips quotes -- sends
  // them looking for the wrong bug. The message assertion is therefore the whole
  // test; an exit-code-only assertion here could not fail and would be one more
  // check that cannot fail.
  test('--claims with no value is refused as a value-less flag, not as an absent one', () => {
    for (const argv of [['--json', '--claims'], ['--claims', '', '--json']]) {
      const result = run(GATE_EVIDENCE, argv);
      assert.equal(result.code, 2, `${JSON.stringify(argv)} must never be a pass:\n${result.stdout}`);
      assert.match(result.stdout, /gate-evidence: --claims needs a value/);
      assert.ok(
        !result.stdout.includes('is required'),
        `a flag that was passed must not be reported as one that was omitted:\n${result.stdout}`,
      );
    }

    // The refusal the message above must stay distinct from: the flag genuinely
    // absent. A control in the other direction, and the reason the assertion
    // above is worth making.
    const omitted = run(GATE_EVIDENCE, ['--json']);
    assert.equal(omitted.code, 2, `an absent --claims must still be refused:\n${omitted.stdout}`);
    assert.match(omitted.stdout, /gate-evidence: --claims <path> is required/);

    // Positive control, expected to pass: a real bundle path still gates.
    const control = gateBundle({ runId: 'r1', policy: 'pilot', claims: [claim()] });
    assert.equal(control.code, 0, `--claims with a real value must still gate:\n${control.stdout}`);
  });

  // Masked by the derivation check further down (#374). With the membership test
  // gone, `"whatever"` is not rejected here; it survives to contradict the policy
  // derived from the reviewed-profile set and is refused *there* instead, at the
  // same exit code under a different message. So the code alone cannot tell the
  // two apart, and only the message can: a value that is not a policy at all is
  // refused as unknown, never as a mismatch between two real policies.
  test('an unknown policy exits 2 rather than falling back to the loose one', () => {
    const result = gateBundle({ policy: 'whatever', claims: [claim()] });
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /gate-evidence: unknown policy "whatever"/);
    assert.ok(
      !result.stdout.includes('but the bundle declares'),
      `a value that is not a policy must be refused as unknown, not as a derivation mismatch:\n${result.stdout}`,
    );
  });

  // The sibling of the test above, and the more dangerous half. An unknown
  // policy is a typo; a *missing* one is the field simply not being reported by
  // the agent whose work this gate exists to check. Defaulting it picks the
  // looser threshold from silence, so a long-tail claim that never reached
  // unanimity would publish under the pilot bar. `tools/updater` refuses the
  // same way -- naming a long-tail profile without choosing its threshold exits
  // 2 -- because the threshold a change was decided under must be a choice.
  //
  // These two guards are adjacent in the gate and each absorbs the other's case:
  // with this one gone, `declaredPolicy` is `undefined`, which `THRESHOLDS` does
  // not have, so the unknown-policy check immediately after it refuses the bundle
  // and still exits 2 (#374). The gate itself states the equivalence -- "an
  // absent policy is refused exactly as an unknown one is" -- which is precisely
  // why a code-only assertion here could never tell the pair apart. The message
  // can, so it is pinned.
  test('a missing policy exits 2 rather than defaulting to the loose one', () => {
    const bundle = { runId: 'r1', creator: 'some-long-tail-creator', claims: [claim()] };
    assert.ok(!Object.hasOwn(bundle, 'policy'), 'the fixture must not carry a policy');
    const result = gateBundle(bundle);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /gate-evidence: bundle has no policy/);
    assert.ok(
      !result.stdout.includes('unknown policy'),
      `a policy that was never reported must be refused as absent, not as the string "undefined":\n${result.stdout}`,
    );
  });

  // The failure this protects against, stated as the scenario rather than as a
  // property: a long-tail creator, a 2-accept/1-reject panel, and no policy.
  // That is 2 of the 3 accepts unanimity requires, and it must not pass.
  test('a 2-of-3 panel with no policy cannot publish by defaulting to pilot', () => {
    const result = gateBundle({
      runId: 'r1',
      creator: 'some-long-tail-creator',
      claims: [claim({
        verdicts: [
          { reviewer: 'provenance', vote: 'accept', rationale: 'stated directly' },
          { reviewer: 'consistency', vote: 'accept', rationale: 'consistent' },
          { reviewer: 'editorial', vote: 'reject', rationale: 'phrasing' },
        ],
      })],
    });
    assert.notEqual(result.code, 0, `a claim that never chose a threshold must not pass: ${result.stdout}`);
  });

  // ---------------------------------------------------------------------------
  // Policy is derived from the reviewed-profile set, not believed from the
  // bundle (#233). The gate validated that `policy` was present and one of the
  // two known strings, but never that it was the *correct* threshold for the
  // creator -- so a long-tail creator could declare "pilot" and be held to a
  // 2-of-3 majority instead of the unanimity ADR 0002 requires.
  // ---------------------------------------------------------------------------

  // The defect, demonstrated. A creator with no reviewed profile is long-tail,
  // so it must clear a unanimous panel; declaring "pilot" must not lower that bar
  // to a majority. Against the pre-#233 gate this bundle passed with exit 0 --
  // which is exactly the hole this issue closes.
  test('a long-tail creator declaring "policy": "pilot" is refused, not held to the pilot bar', () => {
    const result = gateBundle({
      runId: 'r1',
      creator: 'some-long-tail-creator',
      policy: 'pilot',
      claims: [claim()],
    });
    assert.equal(result.code, 2, `a long-tail creator must not publish under the pilot bar: ${result.stdout}`);
    assert.match(result.stdout, /some-long-tail-creator/, 'the refusal must name the creator');
    assert.match(result.stdout, /pilot/, 'the refusal must name the declared policy');
    assert.match(result.stdout, /long-tail/, 'the refusal must name the derived policy');
  });

  // The mirror: a reviewed (pilot) creator declaring long-tail is also a
  // contradiction. The declared value is checked against ground truth in both
  // directions, and never silently overridden -- a run that believes it is
  // publishing under the wrong bar is itself a defect worth surfacing.
  test('a pilot creator declaring "policy": "long-tail" is refused as a contradiction', () => {
    const result = gateBundle({
      runId: 'r1',
      creator: 'openai',
      policy: 'long-tail',
      claims: [claim()],
    });
    assert.equal(result.code, 2, `a declared/derived policy mismatch must be refused: ${result.stdout}`);
    assert.match(result.stdout, /openai/, 'the refusal must name the creator');
  });

  // Derivation admits the honest bundle: a reviewed creator whose declared
  // policy matches the one derived from disk still passes and still applies.
  test('a reviewed creator whose declared policy matches the derived one still passes', () => {
    const result = gateBundle({ runId: 'r1', creator: 'anthropic', policy: 'pilot', claims: [claim()] });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).applicable, 1);
  });

  // Fails closed on an unclassifiable creator. A bundle naming no creator has
  // nothing to derive a policy from, so it exits 2 rather than falling through to
  // the declared (looser) value. Built inline rather than through `gateBundle`,
  // which would supply a default creator and hide the case under test.
  //
  // Exit 2 on its own did not establish that (abdeslam-menacere/ModelTree#616).
  // Delete the no-creator guard and `bundle.creator` is `undefined`, which the
  // reviewed set does not hold; the derivation check immediately below it then
  // calls the bundle long-tail, finds it declared "pilot", and refuses the same
  // fixture at the same exit code under a different message. So the bare
  // assertion this test used to make stayed green against a gate that no longer
  // contained the rule the test is named after -- it read the right code off the
  // wrong behaviour, exactly as the `--repo` test below records for itself. The
  // two assertions added here are what make it discriminate, and both halves are
  // load-bearing: pinning only this refusal still passes if some other guard
  // happens to emit matching text, and refusing only the mismatch still passes on
  // any third exit-2 path.
  test('a bundle with no creator cannot be classified and exits 2', () => {
    const bundle = { runId: 'r1', policy: 'pilot', claims: [claim()] };
    assert.ok(!Object.hasOwn(bundle, 'creator'), 'the fixture must not carry a creator');
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
    try {
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      const result = run(GATE_EVIDENCE, ['--claims', path, '--today', TODAY, '--json']);
      assert.equal(result.code, 2, `an unclassifiable creator must exit 2: ${result.stdout}`);
      assert.match(
        result.stdout,
        /gate-evidence: bundle names no creator to classify/,
        `the refusal must name the missing creator, not merely exit 2:\n${result.stdout}`,
      );
      assert.ok(
        !result.stdout.includes('but the bundle declares'),
        'a bundle naming no creator must be refused as unclassifiable, never as a derivation '
        + `mismatch against the string "undefined":\n${result.stdout}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other limb of that same guard (#638). The fixture above carries no
  // `creator` at all, so `typeof creator !== 'string'` refuses it and the
  // `|| creator.length === 0` clause beside it is never evaluated -- the suite
  // could not tell that clause from its own absence. An empty string passes the
  // type check, so the length check is what refuses it here. The two fixtures
  // are distinct inputs on purpose, not two spellings of one, and the assertion
  // on `bundle.creator` below is what keeps them distinct if this fixture is
  // ever edited.
  //
  // Not a hypothetical value. A bundle is JSON assembled by a refresh run, and
  // `"creator": ""` is what a truncated interpolation or an unset variable
  // serialises to -- a value that arrives precisely when something upstream has
  // already gone wrong.
  //
  // Built inline rather than through `gateBundle` for the same reason as above:
  // the empty string must reach the gate exactly as written, without depending
  // on the helper's rule for when it supplies a default creator.
  //
  // Discriminating, because exit 2 alone establishes nothing here either. This
  // was measured rather than reasoned: with `|| creator.length === 0` deleted,
  // this fixture still exits 2, printing `gate-evidence: creator "" is a
  // long-tail creator, but the bundle declares policy "pilot"` -- the reviewed
  // set does not hold "", so the derivation check below the guard refuses the
  // same bundle at the same code under a different message. A bare `code === 2`
  // assertion on this exact fixture was run against that deletion and stayed
  // green. So the assertion that goes red is the one below pinning the guard's
  // own sentence, stopping before the ";" tail, and the negative one beside it
  // refuses the mismatch text that is what actually prints in the clause's
  // absence.
  test('a bundle whose creator is the empty string cannot be classified and exits 2', () => {
    const bundle = { runId: 'r1', creator: '', policy: 'pilot', claims: [claim()] };
    assert.equal(bundle.creator, '', 'the fixture must carry an empty-string creator, not an absent one');
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-claims-'));
    try {
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      const result = run(GATE_EVIDENCE, ['--claims', path, '--today', TODAY, '--json']);
      assert.equal(result.code, 2, `an empty-string creator must exit 2: ${result.stdout}`);
      assert.match(
        result.stdout,
        /gate-evidence: bundle names no creator to classify/,
        `the refusal must be the no-creator guard itself, not merely exit 2:\n${result.stdout}`,
      );
      assert.ok(
        !result.stdout.includes('but the bundle declares'),
        'a bundle whose creator is the empty string must be refused as unclassifiable, never as a '
        + `derivation mismatch against "":\n${result.stdout}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Fails closed when the reviewed-profile set itself cannot be read. Pointed at
  // a repository with no profiles directory, the gate exits 2 rather than
  // classifying every creator against nothing.
  //
  // Exit 2 on its own does not establish that (#251). A gate that has never heard
  // of `--repo` rejects it as an unknown flag and exits 2 as well, so the bare
  // assertion this test used to make passed against a gate that did not handle
  // the case at all -- it read the right code off the wrong behaviour. The two
  // assertions below are what make it discriminate: the refusal must not be the
  // unknown-flag one, and it must name the set it could not read.
  test('an unreadable reviewed-profile set fails closed with exit 2, naming the set', () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), 'modeltree-no-profiles-'));
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'openai', policy: 'pilot', claims: [claim()] },
        { repo: emptyRepo },
      );
      assert.equal(result.code, 2, `an unreadable reviewed set must fail closed: ${result.stdout}`);
      assert.ok(
        !result.stdout.includes('unknown flag'),
        `--repo must be honoured, not rejected as unknown; exit 2 from that path proves nothing:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes('reviewed-profile set'),
        `the refusal must say what was unreadable:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes(resolve(emptyRepo, 'tools', 'updater', 'profiles')),
        `the refusal must name the directory it could not read:\n${result.stdout}`,
      );
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  // The other half of that tightening. Refusing to read a directory shows `--repo`
  // was not ignored; it does not show the flag *selects* the set the policy is
  // derived from. Pointed at a scratch repository whose reviewed set holds one
  // creator this repository has never heard of, the derivation has to follow that
  // set in both directions -- the invented creator is a pilot there, and `openai`,
  // a pilot here, is long-tail there.
  test('--repo selects the reviewed set the policy is derived from', () => {
    const repo = mkdtempSync(join(tmpdir(), 'modeltree-other-profiles-'));
    try {
      const dir = join(repo, 'tools', 'updater', 'profiles');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'acme.json'), JSON.stringify({ creator: { id: 'acme-labs' } }));

      const pilotThere = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(pilotThere.code, 0, `acme-labs has a reviewed profile in that repository: ${pilotThere.stdout}`);
      assert.equal(JSON.parse(pilotThere.stdout).threshold, 2, 'a pilot there is held to 2 of 3');

      const longTailHere = gateBundle(
        { runId: 'r1', creator: 'openai', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(longTailHere.code, 2, `openai has no reviewed profile there: ${longTailHere.stdout}`);
      assert.ok(
        longTailHere.stdout.includes('long-tail'),
        `the refusal must derive long-tail from the set --repo named:\n${longTailHere.stdout}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Which root the verdict was about (#381). `--repo` selects the tree this gate
  // reads its reviewed set from, and until now the report never said which tree
  // that was -- so a run pointed at the wrong one produced a report identical in
  // every field to a run pointed at the right one.
  //
  // Presence is not the claim; the value is. The two roots below hold *identical
  // contents* and differ only in path, so every other field of the two reports
  // is equal and the assertion can only be carried by `repo` itself. A field
  // hard-wired to any one value fails here rather than passing twice.
  test('the evidence report names the root the reviewed set was read from', () => {
    const bundle = { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] };
    const profiles = { 'acme.json': { creator: { id: 'acme-labs' } } };
    const first = repoWithProfiles(profiles);
    const second = repoWithProfiles(profiles);
    try {
      const a = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', first]);
      const b = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', second]);
      assert.equal(a.code, 0, `the first root must be gateable:\n${a.stdout}`);
      assert.equal(b.code, 0, `the second root must be gateable:\n${b.stdout}`);

      const reportA = JSON.parse(a.stdout);
      const reportB = JSON.parse(b.stdout);
      assert.equal(typeof reportA.repo, 'string', `the report must name a root:\n${a.stdout}`);
      assert.equal(typeof reportB.repo, 'string', `the report must name a root:\n${b.stdout}`);
      assert.equal(reportA.repo, resolve(first), 'the reported root must be the one --repo selected');
      assert.equal(reportB.repo, resolve(second), 'the reported root must be the one --repo selected');
      assert.notEqual(
        reportA.repo,
        reportB.repo,
        'two runs over two different roots must not report the same root',
      );

      // And it is the resolved path the gate used, not the argument it was
      // handed: spelled through a directory that does not exist and back out
      // again, so an echo of `args.repo` and the resolved root cannot be the
      // same string. `resolve` is lexical, so the missing segment is normalised
      // away before anything opens it.
      const detour = `${first}/nowhere/..`;
      const wobbly = gateBundleWithArgs(bundle, ['--today', TODAY, '--repo', detour]);
      assert.equal(wobbly.code, 0, `the same root spelled differently must still gate:\n${wobbly.stdout}`);
      const reportWobbly = JSON.parse(wobbly.stdout);
      assert.equal(reportWobbly.repo, resolve(first), 'the report must name the resolved root');
      assert.notEqual(reportWobbly.repo, detour, 'the report must not echo the argument as given');
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  // The sharper half of #381: the report must name the root the gate *used*, and
  // the one root a caller cannot read off their own command line is the fallback
  // one -- `repoRoot()`, four `..` segments counted by hand. It is also the way
  // `.github/workflows` and the skill documentation invoke this gate, and every
  // other `gate-evidence` test here supplies `--repo`, so without this test that
  // arm is executed by nothing.
  //
  // This test used to reach the fallback by writing `--repo` last and letting
  // #372's silent substitution carry it there, and its own note said to update
  // it to the new refusal rather than delete it when that defect was fixed.
  // Done: the argv below omits `--repo` altogether, which is the same branch at
  // `gate-evidence.mjs`'s `args.repo ? ... : repoRoot()` reached honestly, and
  // every claim the test made about the *report* is unchanged. The refusal it
  // used to depend on is asserted by `--repo with no value exits 2 rather than
  // falling back to the repository this script sits in` below.
  //
  // That the fallback root was genuinely read, and not merely named, is carried
  // by the policy: `acme-labs` has a reviewed profile only in the planted tree,
  // so any other root derives `long-tail`, contradicts the declared `pilot`, and
  // exits 2 with no report at all.
  test('with no --repo at all the evidence gate reports the fallback root it used', () => {
    const result = fallbackRepo(GATE_EVIDENCE, ({ dir }) => {
      mkdirSync(join(dir, 'tools', 'updater', 'profiles'), { recursive: true });
      writeFileSync(
        join(dir, 'tools', 'updater', 'profiles', 'acme.json'),
        JSON.stringify({ creator: { id: 'acme-labs' } }),
      );
      const bundle = join(dir, 'claims.json');
      writeFileSync(
        bundle,
        JSON.stringify({ runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] }, null, 2),
      );
      // No `--repo`, which is how the workflows and the skill docs call it.
      return ['--claims', bundle, '--today', TODAY, '--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.repo, 'string', `the report must name a root:\n${result.stdout}`);
    assert.equal(
      resolve(report.repo),
      result.root,
      `the report must name the fallback root the gate resolved for itself:\n${result.stdout}`,
    );
    assert.equal(report.policy, 'pilot', 'the fallback root must be the tree actually read');
    assert.equal(report.threshold, 2, 'and the threshold must follow from that tree');
  });

  // The reviewed-profile **directory**, in its three states (#312). **Absent** is
  // the test above, which cannot `readdirSync` it at all. **Present-but-stale**
  // is not a state it has: it is read once per run, straight from disk, and
  // nothing caches it -- the closest thing, a set that disagrees with this
  // checkout, is what `--repo` selects on purpose and is tested as such above.
  // **Unknown** is this test, and it is a genuinely different branch: the
  // directory reads fine and simply holds nothing that is a profile.
  //
  // The refusal must be the second one, not the first. A directory holding only
  // a README is readable, so the failure has to come from `holds no profiles`;
  // without that rule the gate loads an empty reviewed set and quietly
  // classifies every creator in the world as long-tail against nothing.
  // `long-tail` is declared here deliberately, so a pass could not be mistaken
  // for the declared/derived mismatch refusal firing instead.
  test('a reviewed-profile directory that exists but holds no profiles fails closed', () => {
    const sets = {
      'nothing at all': {},
      'a note nobody meant as a profile': { 'README.md': '# not a profile\n' },
      'only a dotfile': { '.hidden.json': { creator: { id: 'hidden-labs' } } },
      'only a directory': { generic: null },
    };
    for (const [description, entries] of Object.entries(sets)) {
      const repo = repoWithProfiles(entries);
      try {
        const result = gateBundle(
          { runId: 'r1', creator: 'acme-labs', policy: 'long-tail', claims: [claim()] },
          { repo },
        );
        assert.equal(result.code, 2, `${description}: an empty reviewed set must fail closed:\n${result.stdout}`);
        assert.ok(
          result.stdout.includes('holds no profiles'),
          `${description}: the refusal must be the empty-set one, not another:\n${result.stdout}`,
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  // A reviewed **profile** that is not valid JSON. Its siblings are all covered
  // below and none of them reaches this branch: a padded id, a duplicate id, a
  // `.JSON` case-variant and an invisible id all parse first. This one does not
  // parse at all, and the loader's stated contract -- "throws rather than
  // returning a partial set" -- is what makes it a refusal instead of a profile
  // that vanishes from the reviewed set with nobody told. A skipped profile is
  // the silent half: the creator it was written for becomes long-tail, and the
  // only symptom is a bundle refused for a policy mismatch it did not cause.
  test('a reviewed profile that is not valid JSON is refused, not skipped', () => {
    for (const [name, body] of Object.entries({
      truncated: '{"creator": {"id": "broken-labs"',
      'not json at all': 'creator: broken-labs\n',
      empty: '',
    })) {
      const repo = repoWithProfiles({
        'acme.json': { creator: { id: 'acme-labs' } },
        'broken.json': body,
      });
      try {
        const result = gateBundle(
          { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
          { repo },
        );
        assert.equal(result.code, 2, `${name}: an unparseable profile must be refused:\n${result.stdout}`);
        assert.ok(
          result.stdout.includes('broken.json'),
          `${name}: the refusal must name the document to fix:\n${result.stdout}`,
        );
        assert.ok(
          result.stdout.includes('not valid JSON'),
          `${name}: the refusal must say what is wrong with it:\n${result.stdout}`,
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  // -------------------------------------------------------------------------
  // The reviewed-set loader's own rules, brought level with the Python
  // ProfileLibrary that reads the same directory (#251, a named instance of the
  // drift #168 records). None of these lowers the bar for a genuinely long-tail
  // creator and none is reachable from a claim bundle -- each needs a malformed
  // profile committed to the repository. They are closed because two
  // implementations of one rule that disagree about what is valid will
  // eventually disagree about something that matters, and because a profile
  // skipped rather than refused makes a creator vanish from the reviewed set
  // without anyone being told.
  // -------------------------------------------------------------------------

  // A padded id is reachable by no lookup: the set is keyed by the exact declared
  // string, so a document declaring " acme-labs" answers only to " acme-labs" and
  // never to the id its author plainly meant. Admitting it loads a profile that
  // classifies nobody, and the creator it was written for is quietly long-tail.
  test('a reviewed profile whose creator.id is padded is refused, not admitted', () => {
    const repo = repoWithProfiles({ 'acme.json': { creator: { id: ' acme-labs ' } } });
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(result.code, 2, `a padded creator id must be refused: ${result.stdout}`);
      assert.ok(
        result.stdout.includes('whitespace'),
        `the refusal must name the padding, not something else:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes('acme.json'),
        `the refusal must name the document:\n${result.stdout}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Two documents answering to one id make the answer depend on which was read
  // last. The loader deduped them into a Set and said nothing, so whichever
  // profile lost was invisible. Ids differing only in case, or only in how they
  // space themselves, are one id to the reader this rule exists for.
  test('two reviewed profiles declaring one creator id are refused, not silently deduped', () => {
    const pairs = [
      ['acme-labs', 'acme-labs'],
      ['acme-labs', 'Acme-Labs'],
      ['acme labs', 'acme  labs'],
      ['acme labs', 'acme\u00a0labs'],
    ];
    for (const [left, right] of pairs) {
      for (const [first, second] of [[left, right], [right, left]]) {
        const repo = repoWithProfiles({
          'a.json': { creator: { id: first } },
          'b.json': { creator: { id: second } },
        });
        try {
          const result = gateBundle(
            { runId: 'r1', creator: first, policy: 'pilot', claims: [claim()] },
            { repo },
          );
          assert.equal(result.code, 2, `${first} / ${second}: a duplicate creator id must be refused: ${result.stdout}`);
          assert.ok(
            result.stdout.includes('duplicate'),
            `the refusal must say what is wrong:\n${result.stdout}`,
          );
          assert.ok(
            result.stdout.includes('a.json') && result.stdout.includes('b.json'),
            `the refusal must name both documents:\n${result.stdout}`,
          );
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      }
    }
  });

  // The platform-split case (#246). `.JSON` and `.json` are one file on Windows,
  // where every gate agent here runs, and two files on the Linux that CI runs.
  // Skipping the case-variant makes the two platforms disagree about what the
  // reviewed set contains; refusing makes them agree, loudly, on both. The
  // refusal is the rule `tools/updater` already applies to the same directory.
  test('a filename differing from .json only in case is refused, not silently skipped', () => {
    const repo = repoWithProfiles({
      'acme.json': { creator: { id: 'acme-labs' } },
      'other.JSON': { creator: { id: 'other-labs' } },
    });
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(result.code, 2, `a .JSON case-variant must be refused: ${result.stdout}`);
      assert.ok(
        result.stdout.includes('other.JSON'),
        `the refusal must name the file to rename:\n${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes('case-sensitive'),
        `the refusal must say why the case matters:\n${result.stdout}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The refusal above has to stay narrow, or the suite only proves the gate went
  // paranoid. A neighbour nobody meant as a profile is ignored exactly as before:
  // a note, an extensionless file, a dotfile, and a directory -- including one
  // named as though it were a case-variant, because a directory was never a
  // document and refusing it would be the wrong answer to the wrong question.
  test('a neighbour that was never meant as a profile is still ignored', () => {
    const repo = repoWithProfiles({
      'acme.json': { creator: { id: 'acme-labs' } },
      'notes.md': '# not a profile\n',
      'README': 'not a profile either\n',
      '.hidden.json': { creator: { id: 'hidden-labs' } },
      'generic': null,
      'archive.JSON': null,
    });
    try {
      const result = gateBundle(
        { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
        { repo },
      );
      assert.equal(result.code, 0, `only real profiles are candidates: ${result.stdout}`);
      assert.equal(JSON.parse(result.stdout).threshold, 2, 'acme-labs is the reviewed creator there');

      const hidden = gateBundle(
        { runId: 'r1', creator: 'hidden-labs', policy: 'long-tail', claims: [claim()] },
        { repo },
      );
      assert.equal(hidden.code, 0, `a dotfile is not part of the reviewed set: ${hidden.stdout}`);
      assert.equal(JSON.parse(hidden.stdout).threshold, 3, 'a dotfile profile classifies nobody as a pilot');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Fail-closed, stated as a property rather than as four anecdotes. These are
  // the four id values this repository has met that no reader can tell from
  // another: the empty string, and U+200B ZERO WIDTH SPACE, U+202E RIGHT-TO-LEFT
  // OVERRIDE and U+FEFF ZERO WIDTH NO-BREAK SPACE. Whether each is refused at
  // load or merely fails to classify differs -- JS `trim()` treats U+FEFF as
  // whitespace and Python's `strip()` does not, and neither treats the other two
  // as whitespace at all -- and the property deliberately does not care which.
  // What it pins is the one thing that must never happen: none of them may end
  // with the gate applying the looser pilot threshold to a creator the reviewed
  // set does not plainly name.
  test('an invisible or empty creator id never selects the pilot threshold', () => {
    const INVISIBLE = ['', '\u200b', '\u202e', '\ufeff'];
    const named = (id) => JSON.stringify(id);

    // The control, so a passing property is not just a harness that cannot pass.
    const clean = repoWithProfiles({ 'acme.json': { creator: { id: 'acme-labs' } } });
    try {
      const ok = gateBundle({ runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] }, { repo: clean });
      assert.equal(ok.code, 0, `the unmangled id is what a pilot looks like: ${ok.stdout}`);
      assert.equal(JSON.parse(ok.stdout).threshold, 2);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }

    const mangled = [];
    for (const ch of INVISIBLE) {
      mangled.push(ch, `${ch}acme-labs`, `acme-labs${ch}`);
    }
    for (const id of mangled) {
      if (id === 'acme-labs') continue;
      const repo = repoWithProfiles({ 'acme.json': { creator: { id } } });
      try {
        const result = gateBundle(
          { runId: 'r1', creator: 'acme-labs', policy: 'pilot', claims: [claim()] },
          { repo },
        );
        assert.notEqual(
          result.code,
          0,
          `a profile declaring ${named(id)} must not hand "acme-labs" the pilot bar: ${result.stdout}`,
        );
        if (result.code === 1) {
          assert.notEqual(
            JSON.parse(result.stdout).threshold,
            2,
            `a profile declaring ${named(id)} must not select the pilot threshold: ${result.stdout}`,
          );
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('gate-source-approval', () => {
  // The dataset the real repository stands behind, used as the anchor content.
  // The tests build their own git repository around it rather than gating this
  // checkout: the anchor is the merge base with `refs/remotes/origin/main`, and
  // a CI checkout has no such ref, so gating the ambient tree would make the
  // suite depend on how it was cloned. Seeding a scratch repository with the
  // real file keeps the anchor real and the test hermetic.
  const REAL_SOURCES = JSON.parse(readFileSync(join(DATA, 'sources.json'), 'utf8'));
  const REAL = REAL_SOURCES[0];
  const REAL_ORIGIN = new URL(REAL.url).origin;

  /** A source on a host nothing in the repository has ever stood behind. */
  const EVIL = {
    id: 'evil-source',
    url: 'https://contoso-model-notes.example/a',
    title: 'E',
    type: 'official-announcement',
    publisherId: 'p',
    lastCheckedDate: TODAY,
  };

  /**
   * A throwaway git repository, so the test never depends on this checkout.
   *
   * `publish` is the piece that matters: it points `refs/remotes/origin/main` at
   * the commit standing in for reviewed history. Everything committed after that
   * is history the run authored, and the gate must not treat it as trust.
   */
  function approvalRepo(build, bundle, extra = []) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-approval-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const publish = () => git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      const sources = join(dir, 'web', 'src', 'data', 'sources.json');
      const writeSources = (records) => writeFileSync(sources, JSON.stringify(records, null, 2));
      const commit = (message) => {
        git('add', '-A');
        git('commit', '-qm', message);
        return git('rev-parse', 'HEAD').trim();
      };
      build({ dir, git, sources, writeSources, commit, publish });
      const path = join(dir, 'claims.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      return run(GATE_SOURCE_APPROVAL, ['--claims', path, '--repo', dir, '--json', ...extra]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A bundle gated against the real dataset, committed and published. */
  function gateSources(bundle, extra = []) {
    return approvalRepo(
      ({ writeSources, commit, publish }) => {
        writeSources(REAL_SOURCES);
        commit('the reviewed dataset');
        publish();
      },
      bundle,
      extra,
    );
  }

  /** Evidence citing `sourceId`, read from `url`. */
  function evidence(sourceId, url) {
    return {
      sourceId,
      url,
      contentHash: HASH,
      fetchedAt: TODAY,
      quote: 'Today we are releasing this model to all API customers.',
      retrieval: 'fetch',
    };
  }

  /** A `sources` claim adding `id` at `url`, unanimously accepted by the panel. */
  function addSource(id, url) {
    return claim({
      id: `add-${id}`,
      kind: 'add',
      collection: 'sources',
      targetId: id,
      field: undefined,
      currentValue: null,
      proposedValue: {
        id,
        url,
        title: 'A source',
        type: 'official-announcement',
        publisherId: 'openai',
        lastCheckedDate: TODAY,
      },
      statement: `${url} is a primary source for this creator.`,
      evidence: [evidence(id, url)],
    });
  }

  test('a claim resting on a source already in the dataset passes', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(REAL.id, REAL.url)] })],
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.inheritedSources, [REAL.id]);
    assert.ok(report.anchors.approvedOrigins.length > 0, 'the gate must have a trust anchor');
  });

  // The probe that found this hole. Before this gate existed, exactly this
  // bundle produced `all gates passed over 105 records` and exit 0: a source
  // nobody approved, added and cited in the same run, satisfying referential
  // integrity the whole way. It is the load-bearing case in #167 and the reason
  // ADR 0003 holds this as a precondition rather than an accepted cost.
  test('a fabricated source on an unrelated domain, cited from a real release, is refused', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const result = gateSources({
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [
        addSource('contoso-model-notes', url),
        claim({ evidence: [evidence('contoso-model-notes', url)] }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.failures.some((failure) => failure.where === 'claim:openai-gpt-5-7-release-date#evidence[0]'),
      'the claim that cites the invented source must be named, not only the claim that adds it',
    );
  });

  // The gates run after review and cannot be outvoted (ADR 0003). A unanimous
  // panel is the strongest thing the run can produce, and it changes nothing.
  test('no panel majority can approve a source on an origin nobody stands behind', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const unanimous = [
      { reviewer: 'provenance', vote: 'accept', rationale: 'The page states it plainly.' },
      { reviewer: 'consistency', vote: 'accept', rationale: 'Agrees with the timeline.' },
      { reviewer: 'editorial', vote: 'accept', rationale: 'Entity boundary respected.' },
    ];
    const source = addSource('contoso-model-notes', url);
    const result = gateSources({
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [
        { ...source, verdicts: unanimous },
        claim({ evidence: [evidence('contoso-model-notes', url)], verdicts: unanimous }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
  });

  // The other direction, and the reason the rule is drawn at the origin rather
  // than at "no new source record". `sources.json` holds one entry per page, so
  // every new release announcement is a new source record. A rule that refused
  // those would refuse the refresh its entire purpose.
  test('a new page on an origin the dataset already stands behind is allowed', () => {
    const url = `${REAL_ORIGIN}/a-page-published-since-the-last-refresh`;
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [
        addSource('a-newly-announced-page', url),
        claim({ evidence: [evidence('a-newly-announced-page', url)] }),
      ],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).proposedSources, ['a-newly-announced-page']);
  });

  test('a claim citing a source that is neither in the dataset nor proposed is refused', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence('a-source-nobody-ever-added', REAL.url)] })],
    });
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // Without this, an approved id is just a label a run can staple onto any page
  // it likes, and the binding is decorative.
  test('evidence read from a different origin than the source it cites is refused', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(REAL.id, 'https://mirror-of-everything.example/page')] })],
    });
    assertFailed(result, 'source-approval', 'evidence must come from the source it cites');
  });

  test('repointing an approved source at a new origin is refused', () => {
    const url = 'https://contoso-model-notes.example/relocated';
    const result = gateSources({
      runId: 'r1',
      creator: 'openai',
      policy: 'pilot',
      claims: [
        claim({
          id: 'repoint-the-source',
          kind: 'change',
          collection: 'sources',
          targetId: REAL.id,
          field: 'url',
          currentValue: REAL.url,
          proposedValue: url,
          statement: 'The source moved.',
          evidence: [evidence(REAL.id, url)],
        }),
      ],
    });
    assertFailed(result, 'source-approval', 'a run cannot approve its own source');
  });

  /** A throwaway git repository, so the test never depends on the real tree. */
  const scratchRepo = approvalRepo;

  // The whole gate turns on this. `sources.json` is a file the run is about to
  // write, so a gate that read it from disk could be satisfied by the run's own
  // uncommitted patch - which would not close the circle, only move it. The
  // anchor is the committed blob, and this proves it.
  test('a source written into the working tree does not approve itself', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('base');
        publish();
        // The run applies its own patch before the gate runs.
        writeSources([good, EVIL]);
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
    );
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // And the same attack one step further on, which is the one that matters most.
  // Patching the working tree was already refused; *committing* the source first
  // was not, back when the anchor defaulted to `HEAD` - the gate then read the
  // run's own commit and reported the fabricated source as inherited trust. The
  // anchor is the merge base with published history, so a commit on this branch
  // cannot move it, and no flag is needed to get this right.
  test('a source the run commits before gating is still not approved, with no --base given', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
        writeSources([good, EVIL]);
        commit('the run commits its own source, then calls the gate');
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
    );
    assertFailed(result, 'source-approval', 'nothing approved it');
  });

  // `--base` exists to re-gate an older bundle, and may only ever narrow. A
  // required flag would not have been enough here: the agent under test supplies
  // it either way, so what is checked is the ref, not whether it was passed.
  test('--base cannot select a commit this branch authored', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
        writeSources([good, EVIL]);
        commit('the run commits its own source');
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })],
      },
      // `HEAD` is the run's own commit, which is exactly the ref that must not
      // be selectable. It was the default until #167's review found it.
      ['--base', 'HEAD'],
    );
    assert.equal(result.code, 2, `a run-authored anchor must not be selectable:\n${result.stdout}`);
    assert.match(result.stdout, /may only narrow/);
  });

  test('--base may pin an older reviewed commit, and pins it for real', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const later = { id: 'later-source', url: 'https://later.example/a', title: 'L', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const build = ({ writeSources, commit, publish }) => {
      writeSources([good]);
      commit('the first reviewed commit');
      writeSources([good, later]);
      commit('a second reviewed commit');
      publish();
    };
    const cite = (id, url) => ({
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(id, url)] })],
    });

    const pinned = scratchRepo(build, cite(good.id, good.url), ['--base', 'HEAD~1']);
    assert.equal(pinned.code, 0, pinned.stdout);
    const report = JSON.parse(pinned.stdout);
    assert.equal(report.anchors.datasetSources, 1, 'the pinned anchor must be the older tree');
    assert.equal(report.anchor.requestedBase, 'HEAD~1');

    // Narrower means narrower: the source added in the *second* reviewed commit
    // is outside a pin at the first, so pinning cannot be turned into widening.
    const outside = scratchRepo(build, cite(later.id, later.url), ['--base', 'HEAD~1']);
    assertFailed(outside, 'source-approval', 'nothing approved it');
  });

  // The **unresolvable** state of `--base`, which is a different cell from the
  // two above: those supply a ref that resolves and is then judged against the
  // merge base, and this one supplies a ref that resolves to nothing at all. The
  // two are separated by distinct guards in `resolveAnchor`, and only the second
  // guard -- the ancestry one -- had a catcher here; a typo'd or stale ref went
  // straight past the first.
  //
  // The direction that matters is fail-open. `gate-scope.mjs` carries the same
  // function and states the hazard at its own copy of this test: "the dangerous
  // shape would be falling back to the computed anchor and passing". That is
  // precisely what an unguarded first branch does, and it is silent -- the run
  // reports `"passed": true` with `requestedBase: null`, so the operator who
  // typed the ref never learns it was ignored.
  //
  // The bundle is deliberately one that *would* pass at the computed anchor, so
  // a fallback would exit 0 rather than merely exiting differently. That is what
  // makes exit 2 here a claim about the guard and not about the bundle.
  test('--base naming a ref that does not exist exits 2 rather than falling back to the computed anchor', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([good]);
        commit('the reviewed base');
        publish();
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(good.id, good.url)] })],
      },
      ['--base', 'no-such-ref'],
    );
    assert.equal(result.code, 2, `an unresolvable --base must not fall back:\n${result.stdout}`);
    assert.match(result.stdout, /--base no-such-ref is not a commit in this repository/);
  });

  // `--repo` in its **absent** state -- how `gate-source-approval.mjs` runs when
  // invoked without the flag, and the arm every test above skips, since they all
  // route through `approvalRepo` and always pass `--repo <scratch>`.
  //
  // The exit code alone cannot carry this claim, and neither can the dataset
  // anchor. A `repoRoot()` landing one directory short resolves to `.github`,
  // which exists and sits inside the same git repository -- and `datasetAnchor`
  // reads `git show <base>:web/src/data/sources.json`, whose path git resolves
  // from the top of the working tree no matter which subdirectory git was run
  // in. So a wrong-but-inside-the-repo root still finds the same sources.
  //
  // The profile catalogue is what separates them: `catalogAnchor` passes
  // `tools/updater/profiles` as a **pathspec**, which git resolves relative to
  // the directory it was run in. From the real root the catalogue is found; from
  // `.github` it matches nothing and is silently treated as absent, since an
  // absent catalogue is a tolerated state rather than an error. Asserting that
  // the catalogued origin was picked up therefore pins the resolved root itself.
  //
  // Neither origin appears in any real dataset, so this cannot pass by having
  // read some other repository either.
  test('with no --repo at all the approval gate falls back to the repository its own file sits in', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = fallbackRepo(GATE_SOURCE_APPROVAL, ({ dir, commit, publish }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'sources.json'), JSON.stringify([good], null, 2));
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the reviewed dataset and its catalogue');
      publish();
      const bundle = join(dir, 'claims.json');
      writeFileSync(bundle, JSON.stringify({
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(good.id, good.url)] })],
      }, null, 2));
      return ['--claims', bundle, '--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(
      report.anchors.profileCatalogues,
      1,
      `the fallback must resolve to the root the catalogue is read from, not to a directory inside it:\n${result.stdout}`,
    );
    // Sorted by the gate, so this is the whole set and not a subset.
    assert.deepEqual(
      report.anchors.approvedOrigins,
      [CATALOGUED, 'https://good.example'],
      'the fallback must anchor trust in the repository the script sits in, not in another tree',
    );
    assert.equal(report.anchors.datasetSources, 1, 'the fallback root must be the tree actually read');
  });

  // The identity field this block previously had to infer (#381). `--repo`
  // selects the root, and until now nothing in the report said which root that
  // was -- the test above pins it through `anchors.profileCatalogues`, a count,
  // precisely because there was no field naming the thing it cares about.
  //
  // The wrong root here is a real directory *inside the same git repository*,
  // which is the failure mode rather than an invented one. `datasetAnchor` reads
  // `git show <base>:web/src/data/sources.json`, a path git resolves from the
  // top of the working tree no matter which subdirectory it ran in, so the wrong
  // root finds the same dataset anchor. Both runs below exit 0 and both report
  // `passed: true`; measured on the same fixture, the reports differ in exactly
  // two fields, and one of them is an incidental count. Only `repo` answers
  // "which tree was this verdict about".
  test('the approval report names the root it resolved against, so a wrong root is visible in it', () => {
    const bundle = {
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: [evidence(ANCHORED.id, ANCHORED.url)] })],
    };
    let root = null;
    let wrong = null;
    let wobbly = null;

    const right = approvalRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the reviewed dataset and its catalogue');
      publish();
      root = dir;

      const path = join(dir, 'inside.json');
      writeFileSync(path, JSON.stringify(bundle, null, 2));
      const at = (repo) => run(GATE_SOURCE_APPROVAL, ['--claims', path, '--repo', repo, '--json']);

      // A directory that exists and sits inside the same repository, which is
      // what a miscounted `repoRoot()` or a wrapper passing the wrong path lands
      // on. `.github` is exactly the directory one segment short resolves to.
      mkdirSync(join(dir, '.github'), { recursive: true });
      wrong = at(join(dir, '.github'));

      // The right root, spelled through a directory that does not exist and back
      // out again, so an echo of the argument and the resolved path cannot be
      // the same string. `resolve` is lexical, so nothing opens the gap.
      wobbly = at(`${dir}/nowhere/..`);
    }, bundle);

    assert.equal(right.code, 0, `the right root must be gateable:\n${right.stdout}`);
    assert.equal(wrong.code, 0, `the wrong root exits 0 too, which is the whole problem:\n${wrong.stdout}`);
    assert.equal(wobbly.code, 0, `the same root spelled differently must still gate:\n${wobbly.stdout}`);

    const rightReport = JSON.parse(right.stdout);
    const wrongReport = JSON.parse(wrong.stdout);
    assert.equal(typeof rightReport.repo, 'string', `the report must name a root:\n${right.stdout}`);
    assert.equal(typeof wrongReport.repo, 'string', `the report must name a root:\n${wrong.stdout}`);
    assert.equal(rightReport.repo, resolve(root), 'the reported root must be the one --repo selected');
    assert.equal(
      wrongReport.repo,
      resolve(join(root, '.github')),
      'a run over the wrong root must say so rather than reporting the tree it accidentally read from',
    );
    assert.notEqual(
      rightReport.repo,
      wrongReport.repo,
      'two runs over two different roots must not report the same root',
    );

    // The verdict cannot separate them, which is why the field is needed.
    assert.equal(rightReport.passed, true);
    assert.equal(wrongReport.passed, true);
    // And the two really did read different trees: only the right root's
    // catalogue pathspec matched.
    assert.equal(rightReport.anchors.profileCatalogues, 1, 'the right root reads its catalogue');
    assert.equal(wrongReport.anchors.profileCatalogues, 0, 'the wrong root silently reads none');

    const wobblyReport = JSON.parse(wobbly.stdout);
    assert.equal(wobblyReport.repo, resolve(root), 'the report must name the resolved root');
    assert.notEqual(wobblyReport.repo, `${root}/nowhere/..`, 'the report must not echo the argument as given');
  });

  // The fallback arm of the same field, and the one place the reported root
  // cannot be an echo of anything: with no `--repo` at all the gate resolves its
  // own location, and the report has to name the root it arrived at. Without
  // this, a `repo` field spelled `args.repo` rather than the resolved root would
  // report `null` here and every test above would still pass.
  //
  // The fixture is the one directly above this block, on purpose: that test
  // proves the fallback landed on the right root by way of the catalogue count,
  // and this one asserts the same fact directly, which is what #381 makes
  // possible. Both are kept -- the count is a separate claim, and #344 is open
  // on how it is computed.
  test('with no --repo at all the approval report names the fallback root it used', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = fallbackRepo(GATE_SOURCE_APPROVAL, ({ dir, commit, publish }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'sources.json'), JSON.stringify([good], null, 2));
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the reviewed dataset and its catalogue');
      publish();
      const bundle = join(dir, 'claims.json');
      writeFileSync(bundle, JSON.stringify({
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [evidence(good.id, good.url)] })],
      }, null, 2));
      return ['--claims', bundle, '--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(typeof report.repo, 'string', `the report must name a root:\n${result.stdout}`);
    assert.equal(
      resolve(report.repo),
      result.root,
      `the report must name the fallback root the gate resolved for itself:\n${result.stdout}`,
    );
    assert.equal(report.anchors.profileCatalogues, 1, 'and that root must be the tree actually read');
  });

  test('a repository with no published main cannot be gated', () => {
    const good = { id: 'good-source', url: 'https://good.example/a', title: 'G', type: 'official-announcement', publisherId: 'p', lastCheckedDate: TODAY };
    const result = scratchRepo(
      ({ writeSources, commit }) => {
        writeSources([good]);
        commit('a base nobody published');
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim({ evidence: [evidence(good.id, good.url)] })] },
    );
    assert.equal(result.code, 2, `no published history means the gate cannot run:\n${result.stdout}`);
    assert.match(result.stdout, /cannot resolve refs\/remotes\/origin\/main/);
  });

  test('an anchor commit with no dataset file at all exits 2 rather than passing', () => {
    const result = scratchRepo(
      ({ commit, publish }) => {
        commit('no dataset here');
        publish();
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim()] },
    );
    assert.equal(result.code, 2, `a gate with no trust anchor must not report success:\n${result.stdout}`);
    assert.match(result.stdout, /cannot read web\/src\/data\/sources\.json/);
  });

  // Distinct from the above, and reached only when the file parses: a dataset
  // that is present but stands behind nothing leaves the gate with an empty
  // approved set, which would otherwise refuse every citation for a reason that
  // has nothing to do with the citation.
  test('an anchor that yields no approved origin exits 2 rather than refusing everything', () => {
    const result = scratchRepo(
      ({ writeSources, commit, publish }) => {
        writeSources([]);
        commit('a dataset standing behind nothing');
        publish();
      },
      { runId: 'r1', creator: 'someone', policy: 'pilot', claims: [claim({ evidence: [evidence(EVIL.id, EVIL.url)] })] },
    );
    assert.equal(result.code, 2, `an empty anchor is not a verdict:\n${result.stdout}`);
    assert.match(result.stdout, /no approved origin at/);
  });

  // -------------------------------------------------------------------------
  // The **second** trust anchor: `tools/updater/profiles/**` `source_catalog`.
  //
  // Until now no test in this block reached it. `approvalRepo` never creates
  // `tools/updater/profiles`, so `catalogAnchor` returned an empty set in every
  // case and the whole function could have been deleted outright without the
  // suite noticing -- which is precisely the "one covered case reads as a
  // covered axis" pattern #312 exists to stop, with the dataset anchor's own
  // absent/unknown/stale tests above standing in for it.
  //
  // What the two tests below cover, and what they do not. The happy path is
  // stated separately from the axis, because it is not one of the three states:
  //
  //   present -- at the anchor commit, the first test below. Not an axis cell;
  //              it is the control that proves the anchor is read at all, and
  //              without it the two cells beneath could both pass vacuously.
  //              Trust attaches to the origin, so a new page on a catalogued
  //              origin is admissible.
  //
  //   absent  -- every other test in this block, which is why the dataset anchor
  //              carries them alone; the gate reports `profileCatalogues: 0`.
  //   unknown -- present at the anchor but unparseable. Still **not refused**,
  //              and since #344 that is a recorded decision rather than an
  //              oversight: the `catch` in `catalogAnchor` skips it because this
  //              anchor is additive, so a skip can only withhold trust and never
  //              extend it. What has changed is that it is no longer swallowed
  //              with nobody told -- the file is named in
  //              `anchors.profilesUnreadable`, so a typo that narrows the trust
  //              boundary is legible in the report instead of silent. The
  //              reporting is covered, by the second of the two #344 tests at
  //              the end of this block. **Refusing is still not covered**,
  //              because it is still not done; that remains open on #312, and
  //              the two tests directly below do not cover it either.
  //   stale   -- present, but not at the anchor: only in the working tree, or
  //              committed by this branch after it left published history. The
  //              second test below. This is the cell that fails open.
  // -------------------------------------------------------------------------

  /** A source on an origin the dataset anchor stands behind, so it is not the one under test. */
  const ANCHORED = {
    id: 'anchored-source',
    url: 'https://good.example/a',
    title: 'G',
    type: 'official-announcement',
    publisherId: 'p',
    lastCheckedDate: TODAY,
  };

  /** An origin only a reviewed profile catalogue ever stands behind. */
  const CATALOGUED = 'https://catalogued.example';

  function writeCatalogue(dir, url) {
    mkdirSync(join(dir, 'tools', 'updater', 'profiles'), { recursive: true });
    writeFileSync(
      join(dir, 'tools', 'updater', 'profiles', 'acme.json'),
      JSON.stringify({ creator: { id: 'acme-labs' }, source_catalog: [{ url }] }, null, 2),
    );
  }

  test('a reviewed profile catalogue at the anchor is a trust anchor in its own right', () => {
    const result = scratchRepo(
      ({ dir, writeSources, commit, publish }) => {
        writeSources([ANCHORED]);
        writeCatalogue(dir, `${CATALOGUED}/newsroom`);
        commit('the reviewed dataset and its catalogue');
        publish();
      },
      {
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        // A *different page* on the catalogued origin. Trust attaches to the
        // origin, so a creator announcing on a new page of its own newsroom is
        // the ordinary case and the whole point of the refresh.
        claims: [addSource('acme-launch', `${CATALOGUED}/launch`)],
      },
    );
    assert.equal(result.code, 0, `a catalogued origin is inherited trust:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.anchors.profileCatalogues, 1, 'the catalogue must actually have been read');
    assert.ok(
      report.anchors.approvedOrigins.includes(CATALOGUED),
      `the catalogued origin must be approved:\n${result.stdout}`,
    );
    // And it came from the catalogue rather than from the dataset: the anchor
    // tree holds exactly one source, on a different origin. Without this the
    // test would pass on the dataset anchor alone.
    assert.equal(report.anchors.datasetSources, 1, 'the dataset anchor holds only the unrelated source');
    assert.equal(report.inheritedSources.length, 0, 'nothing here was inherited from sources.json');
  });

  // The mirror of `a source written into the working tree does not approve
  // itself`, for the other anchor -- and the fail-open half of this input. A run
  // that could write itself a catalogue would extend the trust boundary to any
  // host it liked, which is exactly what ADR 0003 keeps as a human act.
  //
  // `gate-scope.mjs` refuses any change touching `tools/updater/`, so in the
  // pipeline this is barred twice. That is not a reason to leave it untested: a
  // gate that is only closed because another one runs first is not closed, and
  // this file already states that rule for the claim-shape checks above.
  test('a profile catalogue this run wrote, rather than inherited, approves nothing', () => {
    const bundle = {
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [addSource('acme-launch', `${CATALOGUED}/launch`)],
    };

    // Written into the working tree, never committed.
    const onDisk = scratchRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      commit('the reviewed base');
      publish();
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
    }, bundle);
    assertFailed(onDisk, 'source-approval', 'a run cannot approve its own source');
    const onDiskReport = JSON.parse(onDisk.stdout);
    assert.equal(onDiskReport.anchors.profileCatalogues, 0, 'an uncommitted catalogue is not at the anchor');
    assert.ok(
      !onDiskReport.anchors.approvedOrigins.includes(CATALOGUED),
      `an uncommitted catalogue must not widen the trust boundary:\n${onDisk.stdout}`,
    );

    // And one step further on, which is the half that survived the equivalent
    // dataset-anchor bug: committed by this branch *after* it left published
    // history. Committing moves HEAD and never the merge base, so this buys the
    // run nothing either.
    const committed = scratchRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      commit('the reviewed base');
      publish();
      writeCatalogue(dir, `${CATALOGUED}/newsroom`);
      commit('the run commits its own catalogue, then calls the gate');
    }, bundle);
    assertFailed(committed, 'source-approval', 'a run cannot approve its own source');
    assert.equal(
      JSON.parse(committed.stdout).anchors.profileCatalogues,
      0,
      'a catalogue committed on this branch is not at the merge base',
    );
  });

  // -------------------------------------------------------------------------
  // #344. `profileCatalogues` was assigned `catalog.files.length` -- the list
  // `git ls-tree` returned -- while the loop that reads those files drops any
  // that will not parse and any without a `source_catalog` array, and neither
  // exit reduced the count. So the gate reported how many profiles were
  // *there*, under a name that claims how many it *consulted*.
  //
  // The direction of the error is the bad one. A profile that loses its
  // catalogue in an edit stops contributing origins while the reported breadth
  // does not move: a run can narrow its own trust anchor and publish an
  // identical-looking account of it. The gap is not hypothetical: measured on
  // `a7cee47` the live profile tree listed one more profile than it had
  // catalogues to read. The current numbers are whatever the tree now holds,
  // and are derived by the gate rather than restated here.
  //
  // **What the assertions already on this field do not cover.** #381 uses
  // `profileCatalogues` as a proxy for *which tree the gate resolved* (1 from
  // the right root, 0 from the wrong one), which is a different question from
  // how many catalogues were consulted. Every one of those fixtures holds
  // exactly one profile, with a valid catalogue, so "listed" and "read" cannot
  // disagree there and no miscount can redden them. They are untouched and
  // still pass; they simply never had to distinguish the two. The two tests
  // below are the first fixture in this file where the numbers differ.
  // -------------------------------------------------------------------------

  /**
   * Three profiles at the anchor, one of which yields origins: the smallest
   * fixture in which listed, read, deliberate-empty and damaged are four
   * different facts.
   */
  function mixedProfiles(dir) {
    const profiles = join(dir, 'tools', 'updater', 'profiles');
    mkdirSync(join(profiles, 'generic'), { recursive: true });
    // Read: parses, and carries a catalogue.
    writeFileSync(
      join(profiles, 'acme.json'),
      JSON.stringify({ creator: { id: 'acme-labs' }, source_catalog: [{ url: `${CATALOGUED}/newsroom` }] }, null, 2),
    );
    // A choice: parses, configures no origins. The `generic/long-tail.json`
    // case, which is legitimate as it stands and must not be edited to make a
    // count come true.
    writeFileSync(
      join(profiles, 'generic', 'long-tail.json'),
      JSON.stringify({ creator: { id: 'long-tail' }, notes: 'no origin list' }, null, 2),
    );
    // Damage: present at the anchor, and not parseable.
    writeFileSync(join(profiles, 'broken.json'), '{ "creator": { "id": "broken" ');
  }

  /** A bundle citing a new page on the origin only `acme.json` stands behind. */
  const MIXED_BUNDLE = {
    runId: 'r1',
    creator: 'someone',
    policy: 'pilot',
    claims: [addSource('acme-launch', `${CATALOGUED}/launch`)],
  };

  test('the approval report counts catalogues it read, not profiles it listed', () => {
    const result = scratchRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      mixedProfiles(dir);
      commit('three profiles, one of which has a catalogue');
      publish();
    }, MIXED_BUNDLE);
    assert.equal(result.code, 0, `a catalogued origin is inherited trust:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);

    // The field named for catalogues counts catalogues. One of the three
    // profiles was consulted; the old assignment reported three.
    assert.equal(report.anchors.profileCatalogues, 1, `one profile carried a catalogue:\n${result.stdout}`);
    // The listing is still reported, under its own name, because it is a real
    // fact about the anchor and losing it would trade one blind spot for
    // another.
    assert.equal(report.anchors.profileFiles, 3, `three profiles were listed:\n${result.stdout}`);
    // The two must actually differ here, so neither assertion above can be
    // satisfied by a gate that reports the same number twice.
    assert.notEqual(
      report.anchors.profileCatalogues,
      report.anchors.profileFiles,
      'this fixture exists precisely because the two numbers disagree',
    );

    // And every listed profile is accounted for, so the gap cannot be reported
    // as a smaller total with the reason quietly dropped.
    assert.equal(
      report.anchors.profileCatalogues
        + report.anchors.profilesWithoutCatalogue.length
        + report.anchors.profilesUnreadable.length,
      report.anchors.profileFiles,
      `every listed profile must land in exactly one bucket:\n${result.stdout}`,
    );
  });

  test('a listed profile that contributes no origins is named, with damage told apart from choice', () => {
    const result = scratchRepo(({ dir, writeSources, commit, publish }) => {
      writeSources([ANCHORED]);
      mixedProfiles(dir);
      commit('three profiles, one of which has a catalogue');
      publish();
    }, MIXED_BUNDLE);
    assert.equal(result.code, 0, `a catalogued origin is inherited trust:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);

    // Sorted by the gate, so these are whole sets rather than subsets, and each
    // names a path a reader can go and open.
    assert.deepEqual(
      report.anchors.profilesWithoutCatalogue,
      ['tools/updater/profiles/generic/long-tail.json'],
      `a profile that configures no origins must be named:\n${result.stdout}`,
    );
    assert.deepEqual(
      report.anchors.profilesUnreadable,
      ['tools/updater/profiles/broken.json'],
      `a profile that would not parse must be named:\n${result.stdout}`,
    );
    // The whole point of two lists rather than one: a deliberate no-catalogue
    // profile and a damaged one are different events, and a reader who cannot
    // tell them apart cannot tell a design choice from a typo.
    assert.notDeepEqual(
      report.anchors.profilesWithoutCatalogue,
      report.anchors.profilesUnreadable,
      'choice and damage must not be reported as the same thing',
    );

    // The recorded decision on the unparseable profile (#344): it is a skip,
    // not a refusal. This anchor is additive -- an absent profile tree is
    // already tolerated -- so a skip can only withhold trust, never extend it,
    // and refusing would give one corrupt file a veto over runs that never
    // cited it. Pinned here so that flipping it is a deliberate act with a test
    // to change, rather than a quiet edit.
    assert.equal(report.passed, true, `an unparseable profile does not fail the gate:\n${result.stdout}`);
    assert.deepEqual(report.failures, [], `and contributes no failure:\n${result.stdout}`);

    // Which origins are approved has not moved: the readable catalogue still
    // anchors trust, and neither skipped profile added or removed anything.
    assert.deepEqual(
      report.anchors.approvedOrigins,
      [CATALOGUED, 'https://good.example'],
      `the skipped profiles must not change the trust boundary:\n${result.stdout}`,
    );
  });

  // Malformed shapes are refused, not skipped. A missing `sourceId` already
  // refuses, so a missing `evidence` that silently passed would make absence the
  // most permissive input in a gate about what a run leaves out. `gate-evidence`
  // refuses these too, but relying on that would make this gate closed only
  // while the two are run in a particular order.
  test('a bundle that is not a claim bundle object cannot be gated', () => {
    for (const notABundle of ['a string', 42, null, ['an', 'array']]) {
      const result = gateSources(notABundle);
      assert.equal(result.code, 2, `${JSON.stringify(notABundle)} is not a bundle, and is not a pass`);
    }
  });

  test('a bundle with no claims array cannot be gated', () => {
    const result = gateSources({ runId: 'r1', creator: 'someone', policy: 'pilot' });
    assert.equal(result.code, 2, `a bundle with no claims is not a pass:\n${result.stdout}`);
  });

  test('a claim that is not an object is refused rather than skipped', () => {
    const result = gateSources({ runId: 'r1', creator: 'someone', policy: 'pilot', claims: ['not a claim'] });
    assertFailed(result, 'source-approval', 'is not a claim object');
  });

  test('a claim with no evidence array is refused rather than skipped', () => {
    const result = gateSources({
      runId: 'r1',
      creator: 'someone',
      policy: 'pilot',
      claims: [claim({ evidence: undefined })],
    });
    assertFailed(result, 'source-approval', 'has no evidence array');
  });

  test('evidence entries that are not objects are refused rather than skipped', () => {
    for (const notEvidence of ['https://openai.com/index/gpt-5-7/', null, 7, ['x']]) {
      const result = gateSources({
        runId: 'r1',
        creator: 'someone',
        policy: 'pilot',
        claims: [claim({ evidence: [notEvidence] })],
      });
      assertFailed(result, 'source-approval', 'rather than an evidence object');
    }
  });

  // ADR 0003's "no escape hatch" guardrail, as a test rather than as a promise.
  test('there is no flag that lets a refused bundle through', () => {
    const url = 'https://contoso-model-notes.example/claude-4-6';
    const bundle = {
      runId: 'r1',
      creator: 'anthropic',
      policy: 'pilot',
      claims: [addSource('contoso-model-notes', url), claim({ evidence: [evidence('contoso-model-notes', url)] })],
    };
    for (const flag of ['--force', '--skip', '--skip-gates', '--yes']) {
      const result = gateSources(bundle, [flag]);
      assert.equal(result.code, 2, `${flag} must not be recognised, and must never be a pass`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('gate-scope', () => {
  // The path #210 reproduced against: a reviewed updater profile. It is absent
  // from ALLOWED_PATHS, which is the only thing making the profiles unforgeable,
  // so it is the right file to prove the gate still refuses.
  const OUT_OF_CLASS = 'tools/updater/profiles/anthropic.json';

  function writeOutOfClass(dir, body = '{"id":"anthropic"}\n') {
    mkdirSync(join(dir, 'tools', 'updater', 'profiles'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'updater', 'profiles', 'anthropic.json'), body);
  }

  /**
   * A throwaway git repository, so the test never depends on the real tree's
   * state. `body` gets the directory, a `git`, and a `gate` that runs the gate
   * against it.
   *
   * `publish` writes `refs/remotes/origin/main`, which is where the gate computes
   * its anchor from. A real clone gets that ref from the remote; setting it here
   * explicitly is what lets a test say which commit counts as reviewed - and
   * omitting it is a degraded case in its own right, not an oversight.
   */
  function withScratchRepo(body, { publish = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-scope-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[]');
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      if (publish) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return body({
        dir,
        git,
        gate: (...args) => run(GATE_SCOPE, ['--repo', dir, ...args]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The common shape: build a state, then gate it as JSON. */
  function scratchRepo(build, extraArgs = []) {
    return withScratchRepo(({ dir, git, gate }) => {
      build({ dir, git });
      return gate('--json', ...extraArgs);
    });
  }

  test('a dataset-only change is in class', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
    });
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.inClass, ['web/src/data/releases.json']);
  });

  test('a schema change alongside a dataset change disqualifies the whole thing', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      writeFileSync(join(dir, 'web', 'src', 'data', 'schema.ts'), 'export const x = 1;\n');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['web/src/data/schema.ts']);
  });

  test('an untracked new file cannot sneak past by never being added', () => {
    const result = scratchRepo(({ dir }) => {
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['sneaky.mjs']);
  });

  test('a same-named data file outside web/src/data does not qualify', () => {
    const result = scratchRepo(({ dir }) => {
      mkdirSync(join(dir, 'elsewhere'), { recursive: true });
      writeFileSync(join(dir, 'elsewhere', 'releases.json'), '[]');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['elsewhere/releases.json']);
  });

  // -------------------------------------------------------------------------
  // The three-state table from #210. One test per row. The same out-of-class
  // edit is gated uncommitted, committed, and committed with an explicit
  // `--base`; every row must refuse.
  //
  // Each row asserts the **message**, not just the exit code. The broken gate
  // got rows A and C right, so a suite that checked `code === 1` on those and
  // `code === 0` on B would have passed against it in full. Row B's bug is a
  // *wrong success*, and the only thing that distinguishes it from a real pass
  // is what the gate said it examined.
  // -------------------------------------------------------------------------

  test('State A - an uncommitted out-of-class change is refused', () => {
    const result = withScratchRepo(({ dir, gate }) => {
      writeOutOfClass(dir);
      return gate();
    });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
  });

  test('State B - the same change, committed, is refused with no flag passed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      // The precondition that used to blind the gate: nothing left on disk.
      assert.equal(git('status', '--porcelain').trim(), '', 'the working tree must be clean here');
      return gate();
    });
    assert.equal(result.code, 1, `a committed out-of-class change must be refused:\n${result.stdout}`);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
    // The exact wrong success this issue is about. Exit 1 alone would not catch a
    // regression that reported absence of work while examining nothing.
    assert.doesNotMatch(result.stdout, /nothing changed/);
    assert.doesNotMatch(result.stdout, /nothing to publish/);
  });

  test('State C - the same commit with --base origin/main is still refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'origin/main');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /OUT OF CLASS - 1 file\(s\) outside the dataset documents/);
    assert.ok(result.stdout.includes(OUT_OF_CLASS), `expected ${OUT_OF_CLASS} named:\n${result.stdout}`);
  });

  test('a change split across a commit and the working tree is reported whole', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'half of it');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      return gate('--json');
    });
    assert.equal(result.code, 1, result.stdout);
    // Committed and uncommitted halves both present: neither mode replaced the
    // other, which is what keeps AC 4 and AC 7 from trading off.
    assert.deepEqual(JSON.parse(result.stdout).outOfClass, ['sneaky.mjs', OUT_OF_CLASS]);
  });

  // The scenario named on the issue, in the fixture shape the sibling schema test
  // already established. `empty` is the assertion target rather than the exit code
  // because it is the observable signature of the blind state: on `main` this same
  // callback yields `empty: true`, and a naive fix could exit 1 for another reason
  // while still reporting the tree as empty.
  test('a committed schema change is not empty, which is what the blind state claimed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'schema.ts'), 'export const x = 1;\n');
      git('add', '-A');
      git('commit', '-qm', 'schema change, committed');
      assert.equal(git('status', '--porcelain').trim(), '', 'the working tree must be clean here');
      return gate('--json');
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.empty, false, 'a committed change must never be reported as an empty tree');
    assert.deepEqual(report.outOfClass, ['web/src/data/schema.ts']);
    assert.equal(result.code, 1, result.stdout);
  });

  // The pair below is the proof, and neither half carries it alone. This one
  // shows empty-means-empty; the `empty: false` assertion in the committed test
  // above shows committed-does-not-mean-empty. Restored verbatim from `main`
  // rather than rewritten: exit 0 on a genuinely empty tree is the correct
  // answer and a fix that broke this test would be the wrong fix.
  test('a clean tree reports nothing to publish rather than passing silently', () => {
    const result = scratchRepo(() => {});
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).empty, true);
  });

  test('nothing changed is a finding about the anchor, not a fallthrough', () => {
    const result = withScratchRepo(({ gate }) => ({ text: gate(), json: gate('--json') }));
    assert.equal(result.text.code, 0, result.text.stdout);
    // It has to say what it established, so a reader can tell this apart from the
    // gate having looked in the wrong place.
    assert.match(result.text.stdout, /nothing changed since [0-9a-f]{10} and the working tree is clean/);
    assert.equal(JSON.parse(result.json.stdout).empty, true);
  });

  test('the anchor is reported as a resolved commit, not as the flag that was passed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      return { report: JSON.parse(gate('--json').stdout), head: git('rev-parse', 'HEAD').trim() };
    });
    assert.match(result.report.base, /^[0-9a-f]{40}$/);
    assert.equal(result.report.base, result.head, 'the anchor is the merge base, here HEAD');
    assert.equal(result.report.anchor.publishedRef, 'refs/remotes/origin/main');
    assert.equal(result.report.anchor.requestedBase, null);
    // Byte-identical to gate-source-approval.mjs's, because #168 is open on the
    // absence of drift detection between the two and this is where drift starts.
    assert.equal(result.report.anchor.selectedBy, 'merge-base with refs/remotes/origin/main');
  });

  // The fourth half of the working-tree question, and the one #210's three-state
  // table did not reach (#312). `changedPaths` asks four things and unions the
  // answers: the committed diff, the unstaged diff, the **staged** diff, and
  // untracked files. Three have tests -- committed is State B above, unstaged is
  // the dataset-only and schema-change tests, untracked is the sneaky-file test.
  // Staged-but-not-committed had none, because every `git add` in this block is
  // followed immediately by a commit, which moves the change into the first
  // question and out of this one.
  //
  // It is invisible to all three siblings by construction, which is why none of
  // them covers it: `git add` puts the file in the index, so `ls-files --others`
  // stops listing it; the worktree then matches the index, so the unstaged diff
  // is empty; and nothing is committed, so `<anchor>...HEAD` is empty too. Only
  // `--cached` sees it. Dropping that one line makes the gate report
  // `empty: true` and exit 0 over an out-of-class change -- the same wrong
  // success as #210, on a different half of the same input, which is why `empty`
  // is asserted here rather than only the exit code.
  test('State D - a staged but uncommitted out-of-class change is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      // The preconditions that isolate this half. Without them the test could
      // pass on the strength of one of the three siblings instead.
      assert.equal(
        git('status', '--porcelain').trim(),
        `A  ${OUT_OF_CLASS}`,
        'the change must be staged, and only staged',
      );
      assert.equal(git('diff', '--name-only').trim(), '', 'nothing may be left unstaged');
      assert.equal(git('ls-files', '--others', '--exclude-standard').trim(), '', 'nothing may be left untracked');
      assert.equal(git('rev-list', '--count', 'refs/remotes/origin/main..HEAD').trim(), '0', 'nothing may be committed');
      return gate('--json');
    });
    assert.equal(result.code, 1, `a staged out-of-class change must be refused:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.empty, false, 'a staged change must never be reported as an empty tree');
    assert.deepEqual(report.outOfClass, [OUT_OF_CLASS]);
  });

  // -------------------------------------------------------------------------
  // `--base` may only narrow. The flag is supplied by the agent under test, so
  // it must never be able to select a commit this branch authored.
  // -------------------------------------------------------------------------

  test('--base HEAD cannot be used to hide what this branch committed', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'HEAD');
    });
    assert.equal(result.code, 2, `widening --base must exit 2, not pass:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
    assert.match(result.stdout, /may only narrow/);
  });

  // The rest of the widening set #167's review proved out by execution on
  // `gate-source-approval.mjs`. Kept in step deliberately: #168 is open because
  // nothing detects drift between the two gates, and a rejection this gate
  // accepts while the other refuses is exactly that drift. Every one exits 2
  // with no fallback - never 0, and never a quiet reversion to the merge base.
  test('--base pointing at a post-merge-base commit that is not HEAD is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'first branch commit');
      const middle = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'second branch commit');
      return gate('--base', middle);
    });
    assert.equal(result.code, 2, `a mid-branch commit must not become the anchor:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base pointing at a tag on a branch commit is refused, not resolved past', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      // An annotated tag: `^{commit}` peels it, so the check runs on the commit
      // it names rather than being sidestepped by the object type.
      git('tag', '-a', 'v-branch', '-m', 'tag on a branch commit');
      return gate('--base', 'v-branch');
    });
    assert.equal(result.code, 2, `a tag naming a branch commit must not widen:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base pointing at a sibling branch tip is refused', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      git('checkout', '-q', '-b', 'sibling');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'sibling work');
      const siblingTip = git('rev-parse', 'HEAD').trim();
      git('checkout', '-q', '-');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', siblingTip);
    });
    assert.equal(result.code, 2, `a sibling tip is not inherited trust:\n${result.stdout}`);
    assert.match(result.stdout, /is not an ancestor of the merge base/);
  });

  test('--base naming a ref that does not exist exits 2 rather than falling back', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--base', 'no-such-ref');
    });
    // The dangerous shape would be falling back to the computed anchor and
    // passing, or worse to the working tree. Neither: it refuses to run.
    assert.equal(result.code, 2, `an unresolvable --base must not fall back:\n${result.stdout}`);
    assert.match(result.stdout, /--base no-such-ref is not a commit in this repository/);
  });

  test('--base may pin an older reviewed commit, and still sees the later change', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      const first = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'README.md'), 'scratch, reviewed\n');
      git('add', '-A');
      git('commit', '-qm', 'second reviewed commit');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return { pinned: gate('--json', '--base', first), first };
    });
    assert.equal(result.pinned.code, 1, result.pinned.stdout);
    const report = JSON.parse(result.pinned.stdout);
    assert.equal(report.anchor.commit, result.first, 'the pinned ancestor is the anchor');
    // Narrowing widens the diff, so it can only ever add refusals.
    assert.deepEqual(report.outOfClass, ['README.md', OUT_OF_CLASS]);
  });

  test('--base with no value exits 2 rather than swallowing the next argument', () => {
    const result = withScratchRepo(({ gate }) => gate('--base'));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /--base needs a value/);
  });

  // `--repo` in its **absent** state, which is how `.github/workflows` and the
  // skill documentation invoke this gate, and the one input cell no test above
  // reaches: `withScratchRepo`'s `gate` always passes `--repo <scratch>`, so
  // `repoRoot()` -- four `..` segments counted by hand -- was executed by
  // nothing.
  //
  // Asserting the resolved root, and not just the exit code, is the point. The
  // ordinary way this line breaks is a miscounted segment, and one segment short
  // resolves to `.github`: a directory that exists, and one that git happily
  // answers from because it walks up to the enclosing repository. The gate would
  // then exit 0 having measured a tree nobody asked about. Only the reported
  // root separates that from the correct answer.
  //
  // Per the note on `fallbackRepo`, this is a claim about location alone -- no
  // commit and no dataset content is asserted -- so it cannot rot as the
  // repository changes.
  test('with no --repo at all the scope gate falls back to the repository its own file sits in', () => {
    const result = fallbackRepo(GATE_SCOPE, ({ dir, commit, publish }) => {
      commit('base');
      publish();
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      return ['--json'];
    });
    assert.equal(result.code, 0, `the fallback root must be gateable:\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(
      resolve(report.repo),
      result.root,
      'the fallback must resolve to the repository the script sits in, not to a neighbour of it',
    );
    assert.deepEqual(
      report.inClass,
      ['web/src/data/releases.json'],
      'the fallback root must be the tree actually measured, not just the one named',
    );
  });

  // -------------------------------------------------------------------------
  // Degraded anchors. A gate that cannot establish what changed exits 2; it
  // never exits 0. A missing ref that passed would be a worse bug than the one
  // this replaces.
  // -------------------------------------------------------------------------

  test('a repository with no refs/remotes/origin/main refuses rather than passing', () => {
    const result = withScratchRepo(({ dir, gate }) => {
      writeOutOfClass(dir);
      return gate();
    }, { publish: false });
    assert.equal(result.code, 2, `a missing published ref must not pass:\n${result.stdout}`);
    assert.match(result.stdout, /cannot resolve refs\/remotes\/origin\/main/);
  });

  test('a clean tree with no refs/remotes/origin/main still refuses, so absence never reads as a pass', () => {
    const result = withScratchRepo(({ gate }) => gate(), { publish: false });
    assert.equal(result.code, 2, `an unresolvable anchor must never exit 0:\n${result.stdout}`);
    assert.match(result.stdout, /fetch main before gating/);
  });

  test('a HEAD sharing no history with the published ref refuses', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      git('checkout', '-q', '--orphan', 'unrelated');
      writeFileSync(join(dir, 'sneaky.mjs'), 'console.log(1)\n');
      git('add', '-A');
      git('commit', '-qm', 'unrelated root');
      return gate();
    });
    assert.equal(result.code, 2, `an unrelated history must not pass:\n${result.stdout}`);
    assert.match(result.stdout, /shares no history with refs\/remotes\/origin\/main/);
  });

  test('a stale published ref only moves the anchor backwards, which adds refusals', () => {
    const result = withScratchRepo(({ dir, git, gate }) => {
      // origin/main stays at the first commit while the branch moves on twice.
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      git('add', '-A');
      git('commit', '-qm', 'dataset change, already on main upstream');
      writeOutOfClass(dir);
      git('add', '-A');
      git('commit', '-qm', 'out of class');
      return gate('--json');
    });
    assert.equal(result.code, 1, result.stdout);
    const report = JSON.parse(result.stdout);
    // Everything since the stale anchor, which is a superset of what a current
    // ref would have shown. Staleness costs precision, never safety.
    assert.deepEqual(report.outOfClass, [OUT_OF_CLASS]);
    assert.deepEqual(report.inClass, ['web/src/data/releases.json']);
  });

  test('an unknown flag exits 2 rather than being ignored', () => {
    const result = withScratchRepo(({ gate }) => gate('--force'));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /unknown flag --force/);
  });

  // -------------------------------------------------------------------------
  // ADR 0015: `web/asset-budgets.json` is in class ONLY when the change is
  // confined to the regenerable measurement figures and prose. A refresh that
  // moves a ceiling (`criticalMaxRaw`, `jsMaxRaw`, a whole-build `*MaxRaw`) or
  // widens the drift guard (`measuredDrift.maxFraction`) has left the class,
  // because those are the fields `asset-budgets.test.ts` enforces and a
  // self-approving performance guard is exactly the move an unattended pipeline
  // must never have. Each mutation names the record it changes, never a count.
  // -------------------------------------------------------------------------

  const BUDGETS_BASELINE = {
    '$schema-note': 'baseline schema note',
    'headroom-note': 'baseline headroom note',
    'drift-note': 'baseline drift note',
    measuredDrift: { maxFraction: 0.02, reason: 'baseline guard reason' },
    fixedRoutes: [
      { id: 'tree', path: 'tree/index.html', criticalMaxRaw: 760000, measuredRaw: 532352, reason: 'tree reason' },
      { id: 'compare', path: 'compare/index.html', criticalMaxRaw: 820000, measuredRaw: 749971, reason: 'compare reason' },
    ],
    routeGroups: [
      {
        id: 'passport', dir: 'models', criticalMaxRaw: 200000,
        measuredWorstRaw: 171952, jsMaxRaw: 20000, measuredWorstJsRaw: 0, reason: 'passport reason',
      },
    ],
    globals: {
      jsTotalMaxRaw: 520000, jsTotalMeasuredRaw: 444484,
      cssTotalMaxRaw: 125000, cssTotalMeasuredRaw: 106489,
      fontTotalMaxRaw: 210000, fontTotalMeasuredRaw: 187036,
      astroDirMaxRaw: 860000, astroDirMeasuredRaw: 738009,
      reason: 'globals reason',
    },
  };
  const BUDGETS_PATH = 'web/asset-budgets.json';

  /**
   * A scratch repo whose anchor carries `BUDGETS_BASELINE`, then `mutate` edits
   * the working tree. `mutate` may return an object (written as JSON), a string
   * (written verbatim, for malformed input), or undefined (it wrote the tree
   * itself). It is handed a deep clone of the baseline to mutate in place.
   */
  function gateBudgets(mutate, { seed = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-budgets-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      mkdirSync(join(dir, 'web', 'src', 'data'), { recursive: true });
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[]');
      if (seed) {
        writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(BUDGETS_BASELINE, null, 2));
      }
      writeFileSync(join(dir, 'README.md'), 'scratch\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');

      const budgets = JSON.parse(JSON.stringify(BUDGETS_BASELINE));
      const outcome = mutate({ dir, git, budgets });
      if (outcome !== undefined) {
        const text = typeof outcome === 'string' ? outcome : JSON.stringify(outcome, null, 2);
        writeFileSync(join(dir, BUDGETS_PATH), text);
      }
      const result = run(GATE_SCOPE, ['--repo', dir, '--json']);
      let report = null;
      try {
        report = JSON.parse(result.stdout);
      } catch {
        report = null;
      }
      return { ...result, report };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a measuredRaw-only re-record is in class (the whole point)', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.fixedRoutes[0].measuredRaw = 544346; // tree
      return budgets;
    });
    assert.equal(code, 0, JSON.stringify(report));
    assert.deepEqual(report.inClass, [BUDGETS_PATH]);
    assert.deepEqual(report.outOfClass, []);
  });

  test('re-recording every measurement figure and prose field is in class', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.fixedRoutes[0].measuredRaw = 544346;
      budgets.fixedRoutes[1].measuredRaw = 766171;
      budgets.routeGroups[0].measuredWorstRaw = 173000;
      budgets.routeGroups[0].measuredWorstJsRaw = 0;
      budgets.globals.jsTotalMeasuredRaw = 450000;
      budgets.globals.cssTotalMeasuredRaw = 107000;
      budgets.globals.fontTotalMeasuredRaw = 187036;
      budgets.globals.astroDirMeasuredRaw = 740000;
      budgets.fixedRoutes[0].reason = 'rewritten to explain the re-record';
      budgets.measuredDrift.reason = 'rewritten guard prose';
      budgets['drift-note'] = 'RE-RECORDED against a newer trunk';
      return budgets;
    });
    assert.equal(code, 0, JSON.stringify(report));
    assert.deepEqual(report.inClass, [BUDGETS_PATH]);
  });

  test('raising a route criticalMaxRaw is out of class', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.fixedRoutes[0].criticalMaxRaw = 900000; // tree ceiling raised
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /criticalMaxRaw/);
  });

  test('widening measuredDrift.maxFraction from 0.02 is out of class', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.measuredDrift.maxFraction = 0.5;
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /measuredDrift\.maxFraction/);
  });

  test('changing a route-group jsMaxRaw tripwire is out of class', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.routeGroups[0].jsMaxRaw = 200000;
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.match(report.assetBudgets.join('\n'), /jsMaxRaw/);
  });

  test('changing a whole-build globals ceiling is out of class', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.globals.jsTotalMaxRaw = 999999;
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.match(report.assetBudgets.join('\n'), /jsTotalMaxRaw/);
  });

  test('a permitted measuredRaw edit cannot launder a forbidden ceiling raise', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.fixedRoutes[0].measuredRaw = 544346; // permitted
      budgets.fixedRoutes[0].criticalMaxRaw = 900000; // forbidden, in the same diff
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /criticalMaxRaw/);
  });

  test('malformed asset-budgets JSON is refused, never passed', () => {
    const { code, report } = gateBudgets(() => '{ this is not valid json');
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /not valid JSON/);
  });

  test('adding a route entry is out of class (it adds an enforced ceiling)', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.fixedRoutes.push({
        id: 'new', path: 'new/index.html', criticalMaxRaw: 300000, measuredRaw: 100000, reason: 'new route',
      });
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
  });

  test('removing a route entry is out of class (it drops enforcement)', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.fixedRoutes.pop();
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
  });

  test('renaming a route id is out of class', () => {
    const { code, report } = gateBudgets(({ budgets }) => {
      budgets.fixedRoutes[0].id = 'renamed';
      return budgets;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
  });

  test('adding the budgets file with no baseline at the anchor is refused', () => {
    const { code, report } = gateBudgets(({ budgets }) => budgets, { seed: false });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /no baseline/);
  });

  test('deleting the budgets file is refused', () => {
    const { code, report } = gateBudgets(({ dir }) => {
      rmSync(join(dir, BUDGETS_PATH));
      return undefined;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
  });

  test('an out-of-class page change is still refused with budgets untouched', () => {
    const { code, report } = gateBudgets(({ dir }) => {
      mkdirSync(join(dir, 'web', 'src', 'pages'), { recursive: true });
      writeFileSync(join(dir, 'web', 'src', 'pages', 'tree.astro'), '<html></html>\n');
      return undefined; // budgets file untouched
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, ['web/src/pages/tree.astro']);
    assert.deepEqual(report.assetBudgets, []);
  });

  test('a measurement re-record alongside a dataset change is wholly in class', () => {
    const { code, report } = gateBudgets(({ dir, budgets }) => {
      writeFileSync(join(dir, 'web', 'src', 'data', 'releases.json'), '[{"id":"x"}]');
      budgets.fixedRoutes[0].measuredRaw = 544346;
      return budgets;
    });
    assert.equal(code, 0, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, []);
    assert.deepEqual(report.inClass.sort(), [BUDGETS_PATH, 'web/src/data/releases.json'].sort());
  });

  // HEAD != working tree. The content check must read the committed tip as well
  // as the disk, because HEAD is what auto-merges: a ceiling raised in a commit
  // and reverted on disk leaves the raise on HEAD, where `web-ci` cannot catch it
  // (the raised ceiling makes its own assertion pass). These drive the tip and
  // the disk apart deliberately. The suite did not exercise this axis before, so
  // the fail-open lived under 390 green tests.

  test('a committed criticalMaxRaw raise reverted on disk is refused (HEAD is what merges)', () => {
    const { code, report } = gateBudgets(({ dir, git }) => {
      const raised = JSON.parse(JSON.stringify(BUDGETS_BASELINE));
      raised.fixedRoutes[0].criticalMaxRaw = 900000; // tree
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(raised, null, 2));
      git('add', '-A');
      git('commit', '-qm', 'raise tree ceiling');
      // Revert on disk only: HEAD still carries the raise.
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(BUDGETS_BASELINE, null, 2));
      return undefined;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    const note = report.assetBudgets.join('\n');
    assert.match(note, /criticalMaxRaw/);
    assert.match(note, /HEAD/);
  });

  test('a committed measuredDrift.maxFraction widening reverted on disk is refused', () => {
    const { code, report } = gateBudgets(({ dir, git }) => {
      const widened = JSON.parse(JSON.stringify(BUDGETS_BASELINE));
      widened.measuredDrift.maxFraction = 0.05;
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(widened, null, 2));
      git('add', '-A');
      git('commit', '-qm', 'widen drift guard');
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(BUDGETS_BASELINE, null, 2));
      return undefined;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /maxFraction/);
  });

  test('a ceiling raise committed with a measurement and reverted on disk cannot launder past HEAD', () => {
    const { code, report } = gateBudgets(({ dir, git }) => {
      // Commit a permitted measurement edit AND a forbidden ceiling raise together.
      const committed = JSON.parse(JSON.stringify(BUDGETS_BASELINE));
      committed.fixedRoutes[0].measuredRaw = 540000;
      committed.fixedRoutes[1].criticalMaxRaw = 900000; // compare
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(committed, null, 2));
      git('add', '-A');
      git('commit', '-qm', 'measurement plus hidden ceiling raise');
      // On disk, keep only the permitted measurement and put the ceiling back.
      const disk = JSON.parse(JSON.stringify(BUDGETS_BASELINE));
      disk.fixedRoutes[0].measuredRaw = 540000;
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(disk, null, 2));
      return undefined;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /criticalMaxRaw/);
  });

  // The pass-expected arm (the discipline from #866/#868): a control that only
  // ever fails cannot tell a real refusal from a fixture confounded for an
  // unrelated reason. This proves HEAD != working tree does not itself refuse, so
  // the refusals above are attributable to the enforcing-field move and not to
  // the tip-reading machinery.
  test('a measurement committed then further re-recorded on disk stays in class (HEAD != working tree)', () => {
    const { code, report } = gateBudgets(({ dir, git }) => {
      const committed = JSON.parse(JSON.stringify(BUDGETS_BASELINE));
      committed.fixedRoutes[0].measuredRaw = 540000;
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(committed, null, 2));
      git('add', '-A');
      git('commit', '-qm', 're-record tree measurement');
      const disk = JSON.parse(JSON.stringify(BUDGETS_BASELINE));
      disk.fixedRoutes[0].measuredRaw = 545000;
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(disk, null, 2));
      return undefined;
    });
    assert.equal(code, 0, JSON.stringify(report));
    assert.deepEqual(report.inClass, [BUDGETS_PATH]);
    assert.deepEqual(report.outOfClass, []);
  });

  test('a committed deletion restored on disk is refused (HEAD has no budgets file)', () => {
    const { code, report } = gateBudgets(({ dir, git }) => {
      git('rm', '-q', BUDGETS_PATH);
      git('commit', '-qm', 'delete budgets');
      // Restore on disk only: HEAD carries the deletion.
      writeFileSync(join(dir, BUDGETS_PATH), JSON.stringify(BUDGETS_BASELINE, null, 2));
      return undefined;
    });
    assert.equal(code, 1, JSON.stringify(report));
    assert.deepEqual(report.outOfClass, [BUDGETS_PATH]);
    assert.match(report.assetBudgets.join('\n'), /gone at HEAD|committed deletion/);
  });
});

// ---------------------------------------------------------------------------

// gate-scope's ALLOWED_PATHS and raw.ts's JSON imports are a hand-maintained
// mirror: the gate permits a refresh to touch exactly the documents raw.ts
// composes. Nothing enforced that they stay equal, and #237 records that the
// dangerous direction fails open - ALLOWED_PATHS keeping a path raw.ts no longer
// imports lets the gate wave through a write to a file that has left the reviewed
// dataset surface. This block derives both sides from their source files and
// asserts set equality, naming any path and the side it is missing from.
//
// Both sides are DERIVED, never restated: no filename or count from either file
// appears here as a literal. The comparison logic (`diffAllowedPaths`) is unit-
// tested below against synthetic sources that disagree in each direction, so it
// is proved able to fail without perturbing the committed files - which is also
// why deriving the real expectation is not a tautology: a wrong ALLOWED_PATHS
// value would change one derived set but not the other, and the diff would fire.
describe('gate-scope ALLOWED_PATHS mirrors raw.ts', () => {
  const RAW_TS = join(REPO, 'web', 'src', 'data', 'raw.ts');
  const DATA_PREFIX = 'web/src/data/';

  // -------------------------------------------------------------------------
  // The mirror, and the one hole ADR 0006 punched in it
  //
  // #237's invariant was set equality: the qualifying class is exactly what
  // raw.ts composes, so a document could not be admitted to auto-merge by
  // editing one file. ADR 0006 widens the class by one document that raw.ts
  // deliberately does not compose - the run ledger, which holds facts about
  // runs rather than facts about models - so that a refresh run can record
  // itself in the pull request that carries it instead of relying on a human to
  // transcribe the entry afterwards, which is the step that was missed on every
  // published run to date (#419).
  //
  // The exception is therefore enumerated rather than inferred. `allowed` may
  // exceed `imported` by exactly the members of SANCTIONED_EXTRAS and by
  // nothing else, and it may never fall short of `imported` at all. A second
  // undocumented entry appearing in ALLOWED_PATHS still turns this red, which
  // is the whole point of #237's guard and is preserved intact.
  // -------------------------------------------------------------------------
  const LEDGER = `${DATA_PREFIX}refresh-runs.json`;

  /** Documents in the qualifying class that raw.ts does not compose, and the ADR admitting each. */
  const SANCTIONED_EXTRAS = new Map([[LEDGER, 'docs/adr/0006-a-refresh-run-records-itself-in-its-own-pull-request.md']]);

  // Fails closed: a source that cannot be read or from which no set can be
  // extracted throws, and every caller turns that into a refusal rather than an
  // empty set that would spuriously compare equal to another empty set.
  function readOrRefuse(file) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message}`);
    }
    if (text.length === 0) throw new Error(`${file} is empty`);
    return text;
  }

  // The repo-relative paths named inside `const ALLOWED_PATHS = new Set([ ... ])`.
  // Extracts the array body by brackets, then every single- or double-quoted
  // string in it. Refuses if the declaration is absent or names nothing.
  function allowedPathsFrom(source) {
    const decl = /const\s+ALLOWED_PATHS\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/.exec(source);
    if (!decl) throw new Error('no ALLOWED_PATHS = new Set([...]) declaration found');
    const paths = [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (paths.length === 0) throw new Error('ALLOWED_PATHS declaration names no paths');
    return new Set(paths);
  }

  // The JSON documents raw.ts imports, resolved to their repo-relative paths.
  // Only `.json` imports count - raw.ts imports nothing else, and a non-JSON
  // import would not be a dataset document. Refuses if there are none.
  function rawImportsFrom(source) {
    const specs = [...source.matchAll(/import\s+[^;]*?\bfrom\s+['"](\.\/[^'"]+\.json)['"]/g)]
      .map((m) => m[1].replace(/^\.\//, DATA_PREFIX));
    if (specs.length === 0) throw new Error('raw.ts imports no .json documents');
    return new Set(specs);
  }

  // The directional diff #237 asks for: what only the gate allows, and what only
  // raw.ts composes. Returned as sorted arrays so a failure message is stable.
  // `sanctioned` is subtracted from the first direction only - a document raw.ts
  // composes is never excusable as an exception.
  function diffAllowedPaths(allowed, imported, sanctioned = new Set()) {
    return {
      onlyInAllowed: [...allowed].filter((p) => !imported.has(p) && !sanctioned.has(p)).sort(),
      onlyInRaw: [...imported].filter((p) => !allowed.has(p)).sort(),
    };
  }

  function describeDrift({ onlyInAllowed, onlyInRaw }) {
    const parts = [];
    if (onlyInAllowed.length > 0) {
      parts.push(`allowed by gate-scope but not composed by raw.ts: ${onlyInAllowed.join(', ')}`);
    }
    if (onlyInRaw.length > 0) {
      parts.push(`composed by raw.ts but not allowed by gate-scope: ${onlyInRaw.join(', ')}`);
    }
    return parts.join('; ');
  }

  test('the live ALLOWED_PATHS and raw.ts imports are equal as sets, up to the sanctioned extras', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    const imported = rawImportsFrom(readOrRefuse(RAW_TS));
    const drift = diffAllowedPaths(allowed, imported, new Set(SANCTIONED_EXTRAS.keys()));
    assert.deepEqual(
      drift,
      { onlyInAllowed: [], onlyInRaw: [] },
      `gate-scope ALLOWED_PATHS and raw.ts imports have drifted - ${describeDrift(drift)}`,
    );
  });

  test('every sanctioned extra is actually in ALLOWED_PATHS, so the exception is not stale', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    for (const [path, adr] of SANCTIONED_EXTRAS) {
      assert.ok(
        allowed.has(path),
        `${path} is listed here as a sanctioned exception but gate-scope no longer allows it - `
        + `either restore it or remove it here and revisit ${adr}`,
      );
    }
  });

  test('every sanctioned extra cites an ADR that exists and admits it', () => {
    for (const [path, adr] of SANCTIONED_EXTRAS) {
      const text = readOrRefuse(join(REPO, adr));
      assert.match(
        text,
        new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${adr} is cited as admitting ${path} but does not name it`,
      );
    }
  });

  test('the sanctioned extras are genuinely uncomposed, so none is a vacuous exception', () => {
    const imported = rawImportsFrom(readOrRefuse(RAW_TS));
    for (const path of SANCTIONED_EXTRAS.keys()) {
      assert.ok(
        !imported.has(path),
        `${path} is excused from the mirror as uncomposed, but raw.ts now imports it - `
        + 'drop the exception rather than keeping a rule that excuses nothing',
      );
    }
  });

  test('an undocumented extra still fails, so the widening did not disable the guard', () => {
    const allowed = new Set([...SANCTIONED_EXTRAS.keys(), 'web/src/data/a.json', 'web/src/data/smuggled.json']);
    const imported = new Set(['web/src/data/a.json']);
    const drift = diffAllowedPaths(allowed, imported, new Set(SANCTIONED_EXTRAS.keys()));
    assert.deepEqual(drift.onlyInAllowed, ['web/src/data/smuggled.json']);
  });

  test('drift is detected and named when raw.ts drops a path the gate still allows', () => {
    const allowed = new Set(['web/src/data/a.json', 'web/src/data/b.json']);
    const imported = new Set(['web/src/data/a.json']);
    const drift = diffAllowedPaths(allowed, imported);
    assert.deepEqual(drift.onlyInAllowed, ['web/src/data/b.json']);
    assert.deepEqual(drift.onlyInRaw, []);
    assert.match(describeDrift(drift), /allowed by gate-scope but not composed by raw\.ts: web\/src\/data\/b\.json/);
  });

  test('drift is detected and named when raw.ts adds a path the gate does not allow', () => {
    const allowed = new Set(['web/src/data/a.json']);
    const imported = new Set(['web/src/data/a.json', 'web/src/data/c.json']);
    const drift = diffAllowedPaths(allowed, imported);
    assert.deepEqual(drift.onlyInRaw, ['web/src/data/c.json']);
    assert.deepEqual(drift.onlyInAllowed, []);
    assert.match(describeDrift(drift), /composed by raw\.ts but not allowed by gate-scope: web\/src\/data\/c\.json/);
  });

  test('a sanctioned extra cannot excuse a path raw.ts does compose', () => {
    const allowed = new Set(['web/src/data/a.json']);
    const imported = new Set(['web/src/data/a.json', LEDGER]);
    const drift = diffAllowedPaths(allowed, imported, new Set([LEDGER]));
    assert.deepEqual(drift.onlyInRaw, [LEDGER]);
  });

  test('the ALLOWED_PATHS derivation actually reads the gate source', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    // A lower bound stated as a literal count would restate the file; instead we
    // only assert non-empty, and prove the parser's shape against a synthetic
    // source below.
    assert.ok(allowed.size > 0);
    for (const p of allowed) assert.ok(p.startsWith(DATA_PREFIX), `unexpected allowed path ${p}`);
  });

  test('allowedPathsFrom extracts exactly the quoted paths in the Set literal', () => {
    const source = "const ALLOWED_PATHS = new Set([\n  'web/src/data/x.json',\n  \"web/src/data/y.json\",\n]);\n";
    assert.deepEqual([...allowedPathsFrom(source)].sort(), ['web/src/data/x.json', 'web/src/data/y.json']);
  });

  test('rawImportsFrom resolves ./ JSON specifiers and ignores non-JSON imports', () => {
    const source = "import a from './a.json';\nimport b from './b.json';\nimport { z } from './helper.ts';\n";
    assert.deepEqual([...rawImportsFrom(source)].sort(), ['web/src/data/a.json', 'web/src/data/b.json']);
  });

  test('both derivations fail closed rather than returning an empty set', () => {
    assert.throws(() => allowedPathsFrom('const OTHER = 1;'), /no ALLOWED_PATHS/);
    assert.throws(() => allowedPathsFrom('const ALLOWED_PATHS = new Set([]);'), /names no paths/);
    assert.throws(() => rawImportsFrom('export const x = 1;'), /imports no \.json/);
    assert.throws(() => readOrRefuse(join(REPO, 'no', 'such', 'file.xyz')), /cannot read/);
  });
});

// ---------------------------------------------------------------------------

// abdeslam-menacere/ModelTree#495. The block above holds `ALLOWED_PATHS` to
// `raw.ts` -- what a refresh may *touch*. This one holds it to `DOCUMENTS` --
// what `gate-dataset.mjs` will actually *read* when it judges the result. Those
// are different questions, and they had different answers: `ALLOWED_PATHS`
// carried sixteen paths while `DOCUMENTS` loaded nine, so six documents were
// cleared to auto-merge unattended under ADR 0003 with no coherence check
// applied to them at all. Nothing was malformed and nothing failed; the gate
// simply never opened those files. `products.json` could have been rewritten
// wholesale on `main` without a human, and every gate would have said yes.
//
// Two lists agreeing today is not the property worth having -- they agreed
// before #613 too, and one widening put them six apart with no test to notice.
// The property is that they cannot be *changed* apart. So this asserts the
// relation rather than either list:
//
//     ALLOWED_PATHS == DOCUMENTS union {the ledger}
//
// and it is asserted in every direction that can go wrong. A path added to
// `ALLOWED_PATHS` alone -- exactly what #613 did -- fails here. A document
// dropped from `DOCUMENTS` while it stays in the class fails here. A document
// added to `DOCUMENTS` that the class does not admit fails here too, because
// the gate reading a file no refresh may touch means one of the two is wrong
// about the dataset. The one permitted asymmetry is the ledger, enumerated with
// the ADR that admits it and proved non-vacuous below.
//
// Both sides are DERIVED. No filename and no count appears here as a literal, so
// the assertion cannot agree with the code by construction; and every parser is
// exercised against synthetic sources that drift in each direction, so it is
// proved able to fail without touching the committed files.
describe('the ADR 0003 qualifying class is exactly what gate-dataset validates', () => {
  const DATA_PREFIX = 'web/src/data/';
  const LEDGER = `${DATA_PREFIX}refresh-runs.json`;

  /**
   * The ledger, and the four independent reasons it is the one member of the
   * class this gate does not load. Enumerated rather than inferred, and each
   * reason is checked by a test below rather than taken on trust: an exception
   * nobody re-examines is how the gap this block closes stayed open.
   */
  const ADMITTED_UNVALIDATED = new Map([[
    LEDGER,
    'docs/adr/0006-a-refresh-run-records-itself-in-its-own-pull-request.md',
  ]]);

  function readOrRefuse(file) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message}`);
    }
    if (text.length === 0) throw new Error(`${file} is empty`);
    return text;
  }

  function allowedPathsFrom(source) {
    const decl = /const\s+ALLOWED_PATHS\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/.exec(source);
    if (!decl) throw new Error('no ALLOWED_PATHS = new Set([...]) declaration found');
    const paths = [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (paths.length === 0) throw new Error('ALLOWED_PATHS declaration names no paths');
    return new Set(paths);
  }

  // The files named inside `const DOCUMENTS = { ... }`, resolved to the same
  // repo-relative shape `ALLOWED_PATHS` uses so the two are comparable at all.
  // Reads only the object body, so the prose above the declaration -- which
  // names the ledger, and must, since that is where the exception is explained
  // -- cannot be mistaken for a document the gate loads.
  function documentPathsFrom(source) {
    const decl = /const\s+DOCUMENTS\s*=\s*\{([\s\S]*?)\}\s*;/.exec(source);
    if (!decl) throw new Error('no DOCUMENTS = { ... } declaration found');
    const files = [...decl[1].matchAll(/['"]([^'"]+\.json)['"]/g)].map((m) => `${DATA_PREFIX}${m[1]}`);
    if (files.length === 0) throw new Error('DOCUMENTS declaration names no documents');
    return new Set(files);
  }

  /**
   * Both directions at once. `admitted` is subtracted from the first only: a
   * document the gate loads is never excusable as an exception, because the
   * exception exists to name things the gate deliberately does not read.
   */
  function diffClass(allowed, validated, admitted = new Set()) {
    return {
      allowedButNotValidated: [...allowed].filter((p) => !validated.has(p) && !admitted.has(p)).sort(),
      validatedButNotAllowed: [...validated].filter((p) => !allowed.has(p)).sort(),
    };
  }

  function describeClassDrift({ allowedButNotValidated, validatedButNotAllowed }) {
    const parts = [];
    if (allowedButNotValidated.length > 0) {
      parts.push(
        'may auto-merge unattended but gate-dataset never reads them: '
          + `${allowedButNotValidated.join(', ')}`,
      );
    }
    if (validatedButNotAllowed.length > 0) {
      parts.push(`read by gate-dataset but outside the qualifying class: ${validatedButNotAllowed.join(', ')}`);
    }
    return parts.join('; ');
  }

  test('every path that may auto-merge is a path gate-dataset validates', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    const validated = documentPathsFrom(readOrRefuse(GATE_DATASET));
    const drift = diffClass(allowed, validated, new Set(ADMITTED_UNVALIDATED.keys()));
    assert.deepEqual(
      drift,
      { allowedButNotValidated: [], validatedButNotAllowed: [] },
      'the ADR 0003 qualifying class and the documents gate-dataset validates have drifted - '
        + `${describeClassDrift(drift)}. Widening one without the other is #495: a document that may `
        + 'reach main unattended with no coherence check is the hole this asserts shut. Add it to '
        + 'both, or record it in ADMITTED_UNVALIDATED with the ADR that admits it and the gate that '
        + 'covers it instead.',
    );
  });

  test('order is not load-bearing on either side, so a reordering is not drift', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    const validated = documentPathsFrom(readOrRefuse(GATE_DATASET));
    const reversed = (set) => new Set([...set].reverse());
    assert.deepEqual(
      diffClass(reversed(allowed), reversed(validated), new Set(ADMITTED_UNVALIDATED.keys())),
      { allowedButNotValidated: [], validatedButNotAllowed: [] },
      'both lists are compared as sets, so reversing either must change no verdict. If this fails, '
        + 'the comparison has become order-sensitive and would report a formatting change as a hole.',
    );
  });

  test('a path added to ALLOWED_PATHS alone is refused, which is what #613 did', () => {
    const drift = diffClass(
      new Set([`${DATA_PREFIX}a.json`, `${DATA_PREFIX}widened.json`]),
      new Set([`${DATA_PREFIX}a.json`]),
    );
    assert.deepEqual(drift.allowedButNotValidated, [`${DATA_PREFIX}widened.json`]);
    assert.deepEqual(drift.validatedButNotAllowed, []);
    assert.match(describeClassDrift(drift), /may auto-merge unattended but gate-dataset never reads them/);
  });

  test('a document dropped from DOCUMENTS while it stays in the class is refused', () => {
    const drift = diffClass(
      new Set([`${DATA_PREFIX}a.json`, `${DATA_PREFIX}b.json`]),
      new Set([`${DATA_PREFIX}a.json`]),
    );
    assert.deepEqual(drift.allowedButNotValidated, [`${DATA_PREFIX}b.json`]);
  });

  test('a document added to DOCUMENTS alone is refused, so the guard cuts both ways', () => {
    const drift = diffClass(
      new Set([`${DATA_PREFIX}a.json`]),
      new Set([`${DATA_PREFIX}a.json`, `${DATA_PREFIX}unadmitted.json`]),
    );
    assert.deepEqual(drift.validatedButNotAllowed, [`${DATA_PREFIX}unadmitted.json`]);
    assert.deepEqual(drift.allowedButNotValidated, []);
    assert.match(describeClassDrift(drift), /read by gate-dataset but outside the qualifying class/);
  });

  test('a path removed from ALLOWED_PATHS while the gate still loads it is refused', () => {
    const drift = diffClass(new Set([]), new Set([`${DATA_PREFIX}a.json`]));
    assert.deepEqual(drift.validatedButNotAllowed, [`${DATA_PREFIX}a.json`]);
  });

  test('the admitted exception excuses one direction only, never a document the gate loads', () => {
    const drift = diffClass(new Set([`${DATA_PREFIX}a.json`]), new Set([`${DATA_PREFIX}a.json`, LEDGER]), new Set([LEDGER]));
    assert.deepEqual(
      drift.validatedButNotAllowed,
      [LEDGER],
      'the ledger being excused from validation must not also excuse it from the class',
    );
  });

  test('a second undocumented extra still fails, so enumerating one did not disable the guard', () => {
    const drift = diffClass(
      new Set([...ADMITTED_UNVALIDATED.keys(), `${DATA_PREFIX}a.json`, `${DATA_PREFIX}smuggled.json`]),
      new Set([`${DATA_PREFIX}a.json`]),
      new Set(ADMITTED_UNVALIDATED.keys()),
    );
    assert.deepEqual(drift.allowedButNotValidated, [`${DATA_PREFIX}smuggled.json`]);
  });

  test('the admitted exception is in the class, so it is not a stale entry', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    for (const [path, adr] of ADMITTED_UNVALIDATED) {
      assert.ok(
        allowed.has(path),
        `${path} is excused from validation here but gate-scope no longer admits it to the class - `
          + `either restore it or drop this entry and revisit ${adr}`,
      );
    }
  });

  test('the admitted exception is genuinely unvalidated, so the entry is not vacuous', () => {
    const validated = documentPathsFrom(readOrRefuse(GATE_DATASET));
    for (const path of ADMITTED_UNVALIDATED.keys()) {
      assert.ok(
        !validated.has(path),
        `${path} is listed as admitted-but-unvalidated, yet gate-dataset now loads it - `
          + 'drop the exception rather than keeping a rule that excuses nothing',
      );
    }
  });

  test('the admitted exception cites an ADR that exists and names it', () => {
    for (const [path, adr] of ADMITTED_UNVALIDATED) {
      const text = readOrRefuse(join(REPO, adr));
      assert.match(
        text,
        new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${adr} is cited as admitting ${path} but does not name it`,
      );
    }
  });

  // The exception's load-bearing half. Excusing a path from *this* gate is only
  // acceptable because another one covers it; an exception that meant "nothing
  // checks this" would be the hole rather than a documented edge of it.
  test('the admitted exception is covered by gate-ledger instead', () => {
    const ledger = readOrRefuse(GATE_LEDGER);
    for (const path of ADMITTED_UNVALIDATED.keys()) {
      assert.ok(
        ledger.includes(path.slice(DATA_PREFIX.length)),
        `${path} is excused from gate-dataset on the grounds that gate-ledger covers it, but `
          + 'gate-ledger.mjs does not name it',
      );
    }
  });

  test('both derivations read their real sources and fail closed rather than returning empty', () => {
    const allowed = allowedPathsFrom(readOrRefuse(GATE_SCOPE));
    const validated = documentPathsFrom(readOrRefuse(GATE_DATASET));
    assert.ok(allowed.size > 0);
    assert.ok(validated.size > 0);
    for (const path of validated) {
      assert.ok(path.startsWith(DATA_PREFIX), `unexpected validated path ${path}`);
    }
    assert.deepEqual(
      [...documentPathsFrom("const DOCUMENTS = {\n  a: 'a.json',\n  b: \"b.json\",\n};\n")].sort(),
      [`${DATA_PREFIX}a.json`, `${DATA_PREFIX}b.json`],
    );
    assert.throws(() => allowedPathsFrom('const OTHER = 1;'), /no ALLOWED_PATHS/);
    assert.throws(() => allowedPathsFrom('const ALLOWED_PATHS = new Set([]);'), /names no paths/);
    assert.throws(() => documentPathsFrom('const OTHER = 1;'), /no DOCUMENTS/);
    assert.throws(() => documentPathsFrom('const DOCUMENTS = {};'), /names no documents/);
    assert.throws(() => readOrRefuse(join(REPO, 'no', 'such', 'file.xyz')), /cannot read/);
  });
});

// ---------------------------------------------------------------------------
// ADR 0005 Decision item 2: the gate makes no claim, "in code comments,
// messages, or documentation", that it verifies the hash is the hash of the
// cited page or that the quote appears there. Three of the four instances #278
// removed were code comments, so a test that inspected only refusal output
// would have missed them; the scan below is over the script's whole source.
//
// The decision forbids two claims, so the patterns cover two halves: the
// hash-and-retrieval half, which is where all four of #278's instances were,
// and the quote half. The quote half is the easier one to drift into, because
// no contentHash check sits beside it to make the limit obvious.
//
// The vocabulary is chosen to be *presupposing*: each pattern asserts that a
// retrieval happened, or asserts correspondence between a value the producer
// declared and a remote page, and none can appear in an honest disclaimer
// without rewording. That is a deliberate cost. A disclaimer in this file must
// say what the gate does not do without borrowing the phrasing that does the
// overclaiming -- writing "never that a page was retrieved" trips the same wire
// as claiming it, because a substring scan cannot read negation. It is also why
// the scan is scoped to gate-evidence.mjs alone: ADR 0005 and
// reference/claim-bundle.md state the same limit correctly and, in doing so,
// use the forbidden phrasings, so scanning them would red honest text.
//
// That last point is a rule rather than a local convenience, and it is the same
// rule the skill-doc count check states at its own scan root (#316):
//
//   A substring scanner cannot be pointed at the prose that documents it,
//   because accurate documentation of a forbidden pattern necessarily contains
//   the forbidden pattern.
//
// Both scans meet it, independently, and both answer it by staying narrow. So
// widening this one past gate-evidence.mjs is a decision to be argued, not
// housekeeping: ADR 0005 and reference/claim-bundle.md would go red on the day
// it happened, and they would be right and the scan would be wrong.
//
// What this scan is not: a fixed vocabulary cannot recognise every way of
// overclaiming, and phrasings outside it pass -- #278's QA demonstrated several.
// A clean run means no *known* phrasing is present in this one file, never that
// the file is free of overclaims. Item 2 is a standing obligation on all three
// channels, and this test discharges a part of it on one of them.
// ---------------------------------------------------------------------------
describe('gate-evidence claims no retrieval it cannot perform (ADR 0005)', () => {
  const OVERCLAIMS = [
    { label: 'names a page as fetched/retrieved/downloaded', re: /\b(fetched|retrieved|downloaded)\s+page\b/i },
    { label: 'claims something was actually fetched/read/retrieved', re: /\bactually\s+(fetched|read|retrieved|downloaded)\b/i },
    { label: 'claims a check proves a retrieval happened', re: /\bprove[sdn]?\b[^.\n]{0,60}\b(read|fetched|retrieved|downloaded)\b/i },
    { label: 'claims the hash corresponds to the page', re: /\b(hash|digest)\s+of\s+the\s+(\w+\s+){0,2}page\b/i },
    // The quote half of Decision item 2. gate-evidence.mjs does check that a
    // quote is present and long enough, so the drift this watches for is one
    // word wide: "present in the bundle" becoming "present in the source".
    {
      label: 'claims the quote was located in the cited source',
      re: /\bquot(?:e|es|ed|ation)\b[^.\n]{0,60}\b(appears?|occurs?|found|present)\b[^.\n]{0,30}\b(page|source|document|article|site|url|there)\b/i,
    },
  ];

  function matchOverclaims(text) {
    return OVERCLAIMS.filter(({ re }) => re.test(text)).map(({ label }) => label);
  }

  // One probe per pattern, each phrased so that pattern and no other matches it.
  // Deliberately a separate list rather than a field on each OVERCLAIMS entry: a
  // probe that lived on its own pattern would be deleted along with it, and the
  // coverage test below would stay green through exactly the deletion it exists
  // to catch. Kept apart, deleting a pattern orphans its probe and goes red.
  const PATTERN_PROBES = [
    ['names a page as fetched/retrieved/downloaded', 'no hash and no fetched page for this citation'],
    ['claims something was actually fetched/read/retrieved', 'the url was actually retrieved by the gate'],
    ['claims a check proves a retrieval happened', 'a well-formed hash proves the source was read'],
    ['claims the hash corresponds to the page', 'the digest of the page it names'],
    ['claims the quote was located in the cited source', 'the quote appears in the source document'],
  ];

  test('every pattern is the sole match for some probe, so none can be deleted unnoticed', () => {
    for (const [label, text] of PATTERN_PROBES) {
      assert.deepEqual(
        matchOverclaims(text),
        [label],
        `the probe for "${label}" is not matched by that pattern and only that pattern: ${text}`,
      );
    }
    assert.deepEqual(
      PATTERN_PROBES.map(([label]) => label).sort(),
      OVERCLAIMS.map(({ label }) => label).sort(),
      'every pattern needs a probe only it matches, and every probe needs a live pattern',
    );
  });

  // The strings #278 removed, kept as fixtures -- verbatim apart from leading
  // indentation and, on the last, the trailing comma that followed it in the
  // argument list. Each pins one historical regression against silent
  // reintroduction, and the test below shows the scan still fires on real
  // removed text rather than only on text written to be caught.
  //
  // What they do not show is that each pattern individually can fire: all four
  // are hash-and-retrieval-half text, so none reaches the quote pattern, and the
  // only one reaching the hash-corresponds-to-page pattern is matched by a
  // second pattern too. Per-pattern capability is PATTERN_PROBES' job.
  const REMOVED_BY_278 = [
    '// fetched page, no hash, or a review that never reached a majority. Search',
    '// Gate: the evidence behind a claim was actually retrieved.',
    '// field that must say `fetch` and a hash that proves something was read.',
    '`contentHash "${item.contentHash ?? \'missing\'}" is not a sha256:<64 hex> digest of the fetched page`',
  ];

  test('every removed overclaim is still detected, so the scan is not vacuous', () => {
    for (const fixture of REMOVED_BY_278) {
      assert.ok(
        matchOverclaims(fixture).length > 0,
        `no pattern detects the overclaim: ${fixture}`,
      );
    }
  });

  test('honest descriptions of the same checks are not flagged', () => {
    // Guards the patterns against being so broad that conforming text cannot be
    // written: these are the shapes the corrected file actually uses.
    const honest = [
      'a field that must say `fetch` and a hash that must be well-formed',
      'contentHash is not shaped sha256:<64 hex> - this gate checks that shape only',
      'it cannot judge whether a quote supports a claim, nor whether anyone ever visited the cited url',
      'fetchedAt "2026-01-01" is not a real YYYY-MM-DD date',
      'retrieval is "search-snippet", but only "fetch" is admissible',
      'the reviewed-profile set is read from disk, not taken from the bundle',
      // The quote half. These are the shapes an honest description of the quote
      // check takes, including the live refusal message with its template
      // resolved: the quote pattern must leave every one of them alone, or the
      // gate cannot describe what it does without tripping its own scanner.
      'quote is missing or shorter than 24 characters, so it cannot show the source stating this',
      'a quote short enough to be a coincidence is not corroboration',
      'the quote field is checked for length only, never against the cited url',
      'the quote and the url are both values the producer declared in the bundle',
      'a quote is copied from the source by the scout, and this gate never sees the source',
      'the quote is present and non-empty',
    ];
    for (const text of honest) {
      assert.deepEqual(matchOverclaims(text), [], `honest text was flagged: ${text}`);
    }
  });

  test('the gate-evidence source makes no remote-content claim', () => {
    const source = readFileSync(GATE_EVIDENCE, 'utf8');
    assert.ok(source.length > 0, 'gate-evidence.mjs is empty');
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1, labels: matchOverclaims(line) }))
      .filter((entry) => entry.labels.length > 0);
    assert.deepEqual(
      offenders.map((o) => `${o.number}: ${o.line.trim()} [${o.labels.join('; ')}]`),
      [],
      'gate-evidence.mjs claims a retrieval or correspondence it never establishes (ADR 0005)',
    );
  });

  // The #155/#261 pattern applied to this vocabulary: the refusal an operator
  // actually sees must not describe a fetch that never happened.
  test('the contentHash refusal describes only what was checked', () => {
    const evidence = { ...claim().evidence[0] };
    delete evidence.contentHash;
    const result = gateBundle({ policy: 'pilot', claims: [claim({ evidence: [evidence] })] });
    assert.equal(result.code, 1, result.stdout);
    const messages = JSON.parse(result.stdout).failures
      .filter((failure) => failure.gate === 'evidence')
      .map((failure) => failure.message);
    assert.ok(messages.length > 0, 'expected an evidence failure');
    for (const message of messages) {
      assert.deepEqual(matchOverclaims(message), [], `refusal overclaims: ${message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// check-skill-doc-test-counts.mjs: SKILLS_DIR is the whole scope of that check
//
// `SKILLS_DIR` is a scan root, which is the same shape of constant as
// gate-scope's ALLOWED_PATHS above, and #237's asymmetry applies to it
// unchanged: the constant *is* the entire extent of what the check guarantees,
// so nothing about a green run distinguishes a correct root from a wrong one.
// Until #388 nothing in this repository named it, so no test could notice.
//
// ## Which direction fails open, and why that is the one this block exists for
//
// NARROWING. A root reaching fewer files produces a green run over less of the
// tree, and that is indistinguishable from a clean repository: the exit code is
// 0 either way, and the only trace is a file count inside a success message.
// Measured on this repository at cbef9e7, before this block existed -- pointing
// the root at `.github/skills/modeltree-gates` took the scan from eight markdown
// files to two while the checker still exited 0 and this suite still passed
// whole. Those numbers are evidence at that commit, never a live claim about
// what the tree holds now. The checker still exits 0 under that edit today; what
// changed is that this suite no longer does.
//
// Widening is loud today, but only by accident, and the difference matters.
// `.github/workflows/README.md` currently states counts, so a root reaching it
// exits 1. That is a fact about that file's present contents rather than a
// guarantee -- the checker's own header records that it does not read that file
// and so cannot keep any claim about it true. Correct those lines and widening
// goes quiet too. The pin below is therefore on the exact value in both
// directions, never a floor.
//
// ## What is pinned, and what is deliberately not
//
// Pinned: the declared value of `SKILLS_DIR`, derived from the checker's source
// rather than restated, and the scan root the checker *names to a reader*, taken
// from the live process rather than from its source. The messages are IN SCOPE
// (#388 AC 5). Every message that names the root renders it through
// `posix(relative(REPO_ROOT, SKILLS_DIR))`, so today they follow the constant
// for free; pinning them is what catches the single edit that would separate the
// two, which is a message rewritten to name a root it no longer computes. A
// reader told the scan covered `.github/skills` when it did not is the same
// fail-open failure one level up, in the only channel anyone actually reads.
//
// Not pinned: what the checker scans. #316 weighed widening this root and chose
// to keep it narrow; that decision stands and #388 does not disturb it. This
// block turns "widening is a deliberate act" from an aspiration into a
// mechanism, and moves nothing.
//
// The derivation reads one declaration and never the whole file, so an unrelated
// edit to the checker leaves it green -- an assertion that fired on every change
// to that file would be pinning the file, not the constant. That property is a
// test below rather than a claim here.
// ---------------------------------------------------------------------------
describe('check-skill-doc-test-counts SKILLS_DIR is pinned to .github/skills', () => {
  const SKILL_DOC_CHECK = join(REPO, '.github', 'scripts', 'check-skill-doc-test-counts.mjs');

  // The only literal expectation in this block. A change that moves the root has
  // to edit this line, which is the whole mechanism.
  const PINNED_SEGMENTS = ['.github', 'skills'];
  const PINNED_ROOT = PINNED_SEGMENTS.join('/');

  // Fails closed: a source that cannot be read, or that is empty, throws rather
  // than yielding text from which no declaration is found for the wrong reason.
  function sourceOf(file) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.message}`);
    }
    if (text.length === 0) throw new Error(`${file} is empty`);
    return text;
  }

  // The path segments named in `const SKILLS_DIR = join(REPO_ROOT, ...)`,
  // derived from that declaration and nothing else. Every way of not finding an
  // answer throws: a missing declaration, a base that is not REPO_ROOT, and a
  // join naming no segments would each otherwise produce a value that could
  // compare equal to something by accident.
  function skillsDirSegmentsFrom(source) {
    const decl = /const\s+SKILLS_DIR\s*=\s*join\(([^)]*)\)/.exec(source);
    if (!decl) throw new Error('no const SKILLS_DIR = join(...) declaration found');
    const args = decl[1];
    const base = args.split(',')[0].trim();
    if (base !== 'REPO_ROOT') throw new Error(`SKILLS_DIR is not anchored at REPO_ROOT but at ${base}`);
    const segments = [...args.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
    if (segments.length === 0) throw new Error('SKILLS_DIR names no path segments below REPO_ROOT');
    return segments;
  }

  // One pattern per message the checker uses to name its scan root -- success,
  // refusal, and empty scan -- so this reads whichever the live tree produces
  // and is deliberately not coupled to the skill docs being clean today: a real
  // count landing in a skill doc must red that checker, not this block as well.
  // Naming no root at all throws rather than being read as agreement.
  const ROOT_NAMED = [
    /markdown file\(s\) under (.+?) state no test count/,
    /is stated in the skill documentation under (.+?)\.\n/,
    /found no markdown under (.+?)\. A scan of nothing/,
  ];

  function scanRootNamedByChecker() {
    const { code, stdout } = run(SKILL_DOC_CHECK, []);
    for (const pattern of ROOT_NAMED) {
      const match = pattern.exec(stdout);
      if (match) return match[1];
    }
    throw new Error(`the checker named no scan root (exit ${code}): ${stdout.trim().slice(0, 400)}`);
  }

  test('the declared SKILLS_DIR is exactly .github/skills', () => {
    assert.deepEqual(
      skillsDirSegmentsFrom(sourceOf(SKILL_DOC_CHECK)),
      PINNED_SEGMENTS,
      'check-skill-doc-test-counts.mjs SKILLS_DIR has moved. That constant is the entire scope of ' +
        'the check, and narrowing it yields a green run over fewer files that reads exactly like a ' +
        'clean repository. #316 weighed widening this root and chose to keep it narrow; read that ' +
        'decision in the checker header, and re-measure it, before editing this expectation.',
    );
  });

  test('the scan root the checker names to a reader is the one it is pinned to', () => {
    assert.equal(
      scanRootNamedByChecker(),
      PINNED_ROOT,
      'the checker reports a scan root other than the pinned one, so what it tells a reader and ' +
        'what it actually reads can no longer be read as the same claim',
    );
  });

  test('a moved root is detected rather than absorbed, in both directions', () => {
    // The fail-open direction first, since it is the one nothing else catches.
    const narrowed = 'const SKILLS_DIR = join(REPO_ROOT, ".github", "skills", "modeltree-gates");';
    assert.deepEqual(skillsDirSegmentsFrom(narrowed), ['.github', 'skills', 'modeltree-gates']);
    assert.notDeepEqual(skillsDirSegmentsFrom(narrowed), PINNED_SEGMENTS);
    const widened = 'const SKILLS_DIR = join(REPO_ROOT, ".github");';
    assert.deepEqual(skillsDirSegmentsFrom(widened), ['.github']);
    assert.notDeepEqual(skillsDirSegmentsFrom(widened), PINNED_SEGMENTS);
  });

  test('an unrelated edit to the checker leaves the derived value alone', () => {
    // The control #388 AC 3 asks for. An assertion that fired on every edit to
    // the checker would be pinning the file rather than the constant, and would
    // red on any honest change to it.
    //
    // Stated as a relationship between two derivations rather than against
    // PINNED_SEGMENTS, deliberately: compared to the pinned value it would also
    // red whenever the constant moved, which would make it a second copy of the
    // pin above instead of a control on it. It has to stay green under exactly
    // the mutation that reds the pin, and it does.
    const source = sourceOf(SKILL_DOC_CHECK);
    const lines = source.split('\n');
    const at = lines.findIndex((line) => line.includes('const SKILLS_DIR = join('));
    assert.notEqual(at, -1, 'the declaration this control edits around is not present');
    // Comments directly above and directly below the declaration and nothing
    // else: the most adversarial innocent edit available, because every line
    // around the constant moves while the constant itself does not.
    const innocent = [
      ...lines.slice(0, at),
      '// an unrelated comment directly above the declaration',
      lines[at],
      '// an unrelated comment directly below it',
      ...lines.slice(at + 1),
    ].join('\n');
    // The control on the control: an innocent edit that edited nothing would
    // prove nothing.
    assert.notEqual(innocent, source, 'the innocent edit changed nothing, so this control proves nothing');
    assert.deepEqual(
      skillsDirSegmentsFrom(innocent),
      skillsDirSegmentsFrom(source),
      'an edit that never touched the SKILLS_DIR declaration changed the value derived from it',
    );
  });

  test('the derivation reads the join arguments in order, in either quote style', () => {
    assert.deepEqual(skillsDirSegmentsFrom('const SKILLS_DIR = join(REPO_ROOT, ".a", \'b\', "c");'), ['.a', 'b', 'c']);
  });

  test('the derivation fails closed rather than returning a value that could compare equal', () => {
    assert.throws(
      () => skillsDirSegmentsFrom('const OTHER_DIR = join(REPO_ROOT, ".github", "skills");'),
      /no const SKILLS_DIR/,
    );
    assert.throws(
      () => skillsDirSegmentsFrom('const SKILLS_DIR = join(HERE, ".github", "skills");'),
      /not anchored at REPO_ROOT/,
    );
    assert.throws(() => skillsDirSegmentsFrom('const SKILLS_DIR = join(REPO_ROOT);'), /names no path segments/);
    assert.throws(() => sourceOf(join(REPO, 'no', 'such', 'file.mjs')), /cannot read/);
  });
});

// ---------------------------------------------------------------------------
// gate-ledger (#419, ADR 0006)
//
// The gate exists because the run ledger was a document with a schema, a page,
// four test suites and no writer: every published run's entry was transcribed
// by hand afterwards, and on three runs out of three the transcription was the
// step that got missed. ADR 0006 lets the run write its own entry, and this
// gate is the compensating control that makes a self-authored report card
// worth reading - so a gate that cannot fail would leave the ADR's widening
// unpaid for. Each rule below is proved to fire against data broken in exactly
// the way that rule exists to catch.
//
// Fixtures only, so no clock is involved and the note at the top of this file
// about the two clocks does not apply here.
// ---------------------------------------------------------------------------
describe('gate-ledger', () => {
  const LEDGER = 'web/src/data/refresh-runs.json';

  /** A ledger entry reduced to the fields the gate reads. */
  function entry(id, documents = []) {
    return { id, posted: { documents } };
  }

  function doc(document, recordsBefore, recordsAfter) {
    return { document, recordsBefore, recordsAfter };
  }

  function writeJson(dir, relPath, value) {
    const target = join(dir, ...relPath.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * A throwaway repository holding one dataset document and a ledger, with
   * `refs/remotes/origin/main` published at the base commit. Mirrors the
   * gate-scope harness deliberately: the two gates share an anchor convention,
   * and a test that built the anchor differently would stop being evidence
   * about the thing they share.
   */
  function withLedgerRepo(body, { publish = true, ledger = [], releases = [{ id: 'r1' }] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'modeltree-ledger-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'gate@example.com');
      git('config', 'user.name', 'Gate Test');
      writeJson(dir, 'web/src/data/releases.json', releases);
      writeJson(dir, 'web/src/data/families.json', [{ id: 'f1' }]);
      writeJson(dir, LEDGER, ledger);
      git('add', '-A');
      git('commit', '-qm', 'base');
      if (publish) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return body({
        dir,
        git,
        writeJson: (relPath, value) => writeJson(dir, relPath, value),
        gate: (...args) => run(GATE_LEDGER, ['--repo', dir, ...args]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Build a state, then gate it as JSON. */
  function ledgerRepo(build, extraArgs = [], options = {}) {
    return withLedgerRepo(({ dir, git, writeJson: w, gate }) => {
      build({ dir, git, writeJson: w });
      return gate('--json', ...extraArgs);
    }, options);
  }

  function report(result) {
    return JSON.parse(result.stdout);
  }

  // -------------------------------------------------------------------------
  // The two cases that must pass untouched. These come first because the
  // failure mode this gate could most easily introduce is not blindness but
  // paranoia - blocking the ordinary human data pull request, which is the
  // majority of data traffic in this repository and records no run at all.
  // -------------------------------------------------------------------------

  test('an ordinary data change that records no run is not required to write an entry', () => {
    // Out of class - it carries a test alongside the data, which is what the
    // ordinary human data pull request looks like: 15 of the last 22 commits
    // touching a dataset document also touched something outside the class.
    // Rule 5 deliberately does not reach these, because they cannot auto-merge.
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w('web/src/data/schema-note.txt', 'a file outside the qualifying class');
    });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.deepEqual(r.entriesAdded, []);
    assert.deepEqual(r.failures, []);
    assert.equal(r.transcription, false);
    assert.equal(r.unattended, false);
  });

  test('a branch that changes nothing at all passes', () => {
    const result = ledgerRepo(() => {});
    assert.equal(result.code, 0, result.stdout);
    assert.equal(report(result).passed, true);
  });

  test('a run that reports itself accurately passes, and says what it reconciled', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
    });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.entriesAdded, ['2026-09-01-aaaaaa']);
    assert.deepEqual(r.changedDatasetDocuments, ['web/src/data/releases.json']);
    assert.equal(r.transcription, false);
  });

  // -------------------------------------------------------------------------
  // Rule 1, both directions. The entry's document list must be the set of
  // dataset documents the branch actually changed.
  // -------------------------------------------------------------------------

  test('Rule 1 - a document changed but not declared is caught as under-reporting', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w('web/src/data/families.json', [{ id: 'f1' }, { id: 'f2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.equal(failures.length, 1, failures.join(' | '));
    assert.match(failures[0], /families\.json changed but posted\.documents does not mention it/);
  });

  test('Rule 1 - a document declared but unchanged is caught as over-reporting', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2), doc('families.json', 1, 1)])]);
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.ok(
      failures.some((f) => /posted\.documents claims families\.json changed, but it is identical to the anchor/.test(f)),
      failures.join(' | '),
    );
  });

  // -------------------------------------------------------------------------
  // Rule 2. The record counts are counted at both ends, never believed. This is
  // the rule that makes the entry a measurement rather than a claim, so both
  // ends get their own test - a gate that checked only one would pass a report
  // that got the other wrong.
  // -------------------------------------------------------------------------

  test('Rule 2 - a wrong recordsBefore is caught by counting at the anchor', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 9, 2)])]);
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.ok(
      failures.some((f) => /releases\.json reports recordsBefore 9 but held 1 records at the anchor/.test(f)),
      failures.join(' | '),
    );
  });

  test('Rule 2 - a wrong recordsAfter is caught by counting the working tree', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 7)])]);
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.ok(
      failures.some((f) => /releases\.json reports recordsAfter 7 but holds 2 records now/.test(f)),
      failures.join(' | '),
    );
  });

  test('Rule 2 - the counts are read from the tree, so an unchanged count is not assumed', () => {
    // A run may edit fields in place without adding or removing records - the
    // 2026-08-30 run did exactly that, 82 releases before and after. The gate
    // must accept the equal counts as measured rather than treating "no change
    // in count" as suspicious.
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1', verifiedAt: '2026-09-01' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 1)])]);
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(report(result).failures, []);
  });

  test('Rule 2 - a document outside the dataset cannot be reported on', () => {
    const result = ledgerRepo(({ dir, writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2), doc('secrets.json', 0, 1)])]);
      assert.ok(dir);
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.ok(
      failures.some((f) => /secrets\.json, which is not a dataset document a run may change/.test(f)),
      failures.join(' | '),
    );
  });

  test('Rule 2 - the same document declared twice is refused rather than silently deduplicated', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2), doc('releases.json', 1, 2)])]);
    });
    assert.equal(result.code, 1, result.stdout);
    assert.ok(report(result).failures.some((f) => /names releases\.json twice/.test(f)));
  });

  // -------------------------------------------------------------------------
  // Rule 3. One branch, one run. Two entries would mean two runs squashed into
  // a single revertable commit, which is the property ADR 0003 leans on when it
  // argues a bad run is one revert away from undone.
  // -------------------------------------------------------------------------

  test('Rule 3 - two new entries on one branch are refused', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [
        entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)]),
        entry('2026-09-02-bbbbbb', [doc('releases.json', 1, 2)]),
      ]);
    });
    assert.equal(result.code, 1, result.stdout);
    assert.ok(report(result).failures.some((f) => /adds 2 ledger entries/.test(f)));
  });

  test('Rule 3 - an entry already present at the anchor is not counted as new', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [
        entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)]),
        entry('2026-08-01-000000'),
      ]);
    }, [], { ledger: [entry('2026-08-01-000000')] });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(report(result).entriesAdded, ['2026-09-01-aaaaaa']);
  });

  // -------------------------------------------------------------------------
  // Rule 4. The rule that actually closes #419: a commit that names its run id
  // has promised an entry, and the gate holds it to that promise. Rules 1-3
  // only bite once an entry exists, so without this one the original failure -
  // publishing a run and writing no entry at all - would still pass.
  // -------------------------------------------------------------------------

  test('Rule 4 - a commit declaring a run id with no entry is refused', () => {
    const result = ledgerRepo(({ git, writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      git('add', '-A');
      git('commit', '-qm', 'data(refresh): apply 2 accepted claims (run 2026-09-01-aaaaaa)');
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.ok(
      failures.some((f) => /declares run 2026-09-01-aaaaaa, but no entry for it reaches/.test(f)),
      failures.join(' | '),
    );
  });

  test('Rule 4 - the same commit passes once the entry is there', () => {
    const result = ledgerRepo(({ git, writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
      git('add', '-A');
      git('commit', '-qm', 'data(refresh): apply 2 accepted claims (run 2026-09-01-aaaaaa)');
    });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.runIdsDeclared, ['2026-09-01-aaaaaa']);
  });

  test('Rule 4 - a commit subject with no run id declares nothing', () => {
    const result = ledgerRepo(({ git, writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      // Out of class, so rule 5 does not also fire and this stays a test about
      // rule 4 alone.
      w('web/src/data/schema-note.txt', 'outside the class');
      git('add', '-A');
      git('commit', '-qm', 'data: correct a release date');
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(report(result).runIdsDeclared, []);
  });

  // -------------------------------------------------------------------------
  // Transcription. An entry added on a branch that changes no dataset document
  // describes work published earlier, so there is no diff here to reconcile it
  // against. This is the shape of every hand repair made so far (#422, #577,
  // #607) and of any future correction to a historical entry; refusing it would
  // leave a wrong entry unfixable. What the gate must not do is pass it while
  // implying the numbers were checked.
  // -------------------------------------------------------------------------

  test('a transcription of already-published work is accepted', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w(LEDGER, [entry('2026-08-30-c0b6e9', [doc('releases.json', 82, 82)])]);
    });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.changedDatasetDocuments, []);
  });

  test('a transcription is reported as one, so its numbers are not read as verified', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w(LEDGER, [entry('2026-08-30-c0b6e9', [doc('releases.json', 999, 999)])]);
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(report(result).transcription, true);
  });

  test('the transcription flag is false when there was a diff to reconcile against', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
    });
    assert.equal(report(result).transcription, false);
  });

  test('the human-readable output names a transcription rather than claiming a reconciliation', () => {
    const result = withLedgerRepo(({ writeJson: w, gate }) => {
      w(LEDGER, [entry('2026-08-30-c0b6e9', [doc('releases.json', 82, 82)])]);
      return gate();
    });
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /transcription/);
    assert.match(result.stdout, /NOT checked/);
    assert.doesNotMatch(result.stdout, /reconciles with the change it describes/);
  });

  test('a transcription still has to satisfy rule 4', () => {
    const result = ledgerRepo(({ git, writeJson: w }) => {
      w(LEDGER, [entry('2026-08-30-c0b6e9')]);
      git('add', '-A');
      git('commit', '-qm', 'docs(data): transcribe a run (run 2026-09-09-ffffff)');
    });
    assert.equal(result.code, 1, result.stdout);
    assert.ok(report(result).failures.some((f) => /declares run 2026-09-09-ffffff/.test(f)));
  });

  // -------------------------------------------------------------------------
  // The three states from #210, which every anchor-computing gate in this
  // directory owes: an out-of-order edit must be caught whether it is
  // uncommitted, committed, or committed with an explicit --base.
  // -------------------------------------------------------------------------

  test('State A - an uncommitted bad entry is caught', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 9, 9)])]);
    });
    assert.equal(result.code, 1, result.stdout);
  });

  test('State B - a committed bad entry is caught, because the anchor is the merge-base', () => {
    const result = ledgerRepo(({ git, writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 9, 9)])]);
      git('add', '-A');
      git('commit', '-qm', 'data: a committed run');
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.ok(failures.some((f) => /recordsBefore 9 but held 1/.test(f)), failures.join(' | '));
  });

  test('State C - an explicit --base cannot hide a committed bad entry', () => {
    const result = withLedgerRepo(({ git, writeJson: w, gate }) => {
      const base = git('rev-parse', 'HEAD').trim();
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 9, 9)])]);
      git('add', '-A');
      git('commit', '-qm', 'data: a committed run');
      return gate('--json', '--base', base);
    });
    assert.equal(result.code, 1, result.stdout);
  });

  test('--base may only narrow, never move the anchor forward past the merge-base', () => {
    const result = withLedgerRepo(({ git, writeJson: w, gate }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 9, 9)])]);
      git('add', '-A');
      git('commit', '-qm', 'data: a committed run');
      const tip = git('rev-parse', 'HEAD').trim();
      return gate('--json', '--base', tip);
    });
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /ancestor/);
  });

  test('a repository with no published ref is refused rather than gated against nothing', () => {
    const result = withLedgerRepo(({ gate }) => gate('--json'), { publish: false });
    assert.equal(result.code, 2, result.stdout);
  });

  // -------------------------------------------------------------------------
  // --history, which is #419's fourth acceptance criterion: the ledger is
  // complete over published history, not merely over this branch. This is the
  // check that would have gone red on 2026-08-27, 2026-08-29 and 2026-08-30
  // instead of the gap reaching the site three times unnoticed.
  // -------------------------------------------------------------------------

  test('--history refuses when published history declares a run the ledger never recorded', () => {
    const result = withLedgerRepo(({ git, writeJson: w, gate }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      git('add', '-A');
      git('commit', '-qm', 'data(refresh): apply claims (run 2026-09-01-aaaaaa)');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return gate('--json', '--history');
    });
    assert.equal(result.code, 1, result.stdout);
    const { failures } = report(result);
    assert.ok(
      failures.some((f) => /publishing run 2026-09-01-aaaaaa, which has no entry/.test(f)),
      failures.join(' | '),
    );
    assert.ok(failures.some((f) => /\/refresh page is missing a run it published/.test(f)));
  });

  test('--history passes when every declared run has an entry', () => {
    const result = withLedgerRepo(({ git, writeJson: w, gate }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
      git('add', '-A');
      git('commit', '-qm', 'data(refresh): apply claims (run 2026-09-01-aaaaaa)');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return gate('--json', '--history');
    });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.equal(r.runsDeclared, 1);
    assert.equal(r.passed, true);
  });

  test('--history ignores commits predating the run-id convention rather than reddening on them', () => {
    // Everything published before the convention existed names no run id, so it
    // declares nothing and cannot be missing an entry. The gate reports only
    // declared-but-unrecorded ids, which is what makes it safe to point at
    // history that predates it.
    const result = withLedgerRepo(({ git, writeJson: w, gate }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      git('add', '-A');
      git('commit', '-qm', 'data(refresh): an older run with no id in its subject');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return gate('--json', '--history');
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(report(result).runsDeclared, 0);
  });

  test('--history rejects --base, which would be meaningless over whole history', () => {
    const result = withLedgerRepo(({ gate }) => gate('--history', '--base', 'HEAD'));
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stdout, /meaningless/);
  });

  // -------------------------------------------------------------------------
  // The two gates share an anchor and a notion of what a dataset document is.
  // If they drift, one of them is enforcing a class the other is not, and the
  // ADR 0006 grant - which is stated as gate-scope's class *plus* gate-ledger's
  // reconciliation over that same class - quietly stops meaning what it says.
  // -------------------------------------------------------------------------

  test('gate-ledger DATASET_PATHS is gate-scope ALLOWED_PATHS minus the ledger itself', () => {
    function setLiteral(source, name) {
      const decl = new RegExp(`const\\s+${name}\\s*=\\s*new\\s+Set\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`).exec(source);
      if (!decl) throw new Error(`no ${name} declaration found`);
      const paths = [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      if (paths.length === 0) throw new Error(`${name} names no paths`);
      return new Set(paths);
    }
    const allowed = setLiteral(readFileSync(GATE_SCOPE, 'utf8'), 'ALLOWED_PATHS');
    const dataset = setLiteral(readFileSync(GATE_LEDGER, 'utf8'), 'DATASET_PATHS');
    assert.ok(allowed.has(LEDGER), 'gate-scope must admit the ledger for ADR 0006 to mean anything');
    assert.ok(!dataset.has(LEDGER), 'the ledger is not a document a run reports on; it is the report');
    assert.deepEqual(
      [...dataset].sort(),
      [...allowed].filter((p) => p !== LEDGER).sort(),
      'gate-scope and gate-ledger disagree about what a dataset document is',
    );
  });

  test('both gates compute the same anchor from the same commit', () => {
    const anchors = withLedgerRepo(({ dir, git, writeJson: w }) => {
      const base = git('rev-parse', 'HEAD').trim();
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      git('add', '-A');
      git('commit', '-qm', 'data: a change');
      const scope = JSON.parse(run(GATE_SCOPE, ['--repo', dir, '--json']).stdout);
      const ledger = JSON.parse(run(GATE_LEDGER, ['--repo', dir, '--json']).stdout);
      return { base, scope: scope.anchor?.commit, ledger: ledger.anchor?.commit };
    });
    assert.equal(anchors.ledger, anchors.base, 'gate-ledger did not anchor at the merge-base');
    assert.equal(anchors.scope, anchors.ledger, 'the two gates anchored at different commits');
  });

  test('the ledger itself is not treated as a dataset document a run must declare', () => {
    // Changing only the ledger is the transcription case, not an undeclared
    // dataset change. If LEDGER_PATH ever leaked into DATASET_PATHS, every run
    // would be required to report the ledger as one of its own outputs, and
    // every transcription would be misread as a run.
    const result = ledgerRepo(({ writeJson: w }) => {
      w(LEDGER, [entry('2026-09-01-aaaaaa')]);
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(report(result).changedDatasetDocuments, []);
  });

  // -------------------------------------------------------------------------
  // Rule 5. A change that may merge unattended records itself.
  //
  // The #419 failure was never a wrong entry - it was a missing one, three
  // times. Rules 1-4 all reason about an entry that exists, so before this rule
  // the cheapest way through the gate was to write nothing at all. That inverts
  // this skill's own rule that absence must never be the more permissive
  // option, which is why the trigger is the diff's shape and not a marker the
  // run writes: a run that stays silent cannot silence the anchor.
  // -------------------------------------------------------------------------

  test('Rule 5 - a dataset change confined to the qualifying class must record itself', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
    });
    assert.equal(result.code, 1, result.stdout);
    const r = report(result);
    assert.equal(r.unattended, true);
    assert.deepEqual(r.outOfClass, []);
    assert.deepEqual(r.entriesAdded, []);
    assert.match(r.failures.join('\n'), /adds no entry/);
    assert.match(r.failures.join('\n'), /auto-merge unattended/);
  });

  test('Rule 5 - the same change with its entry passes', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(report(result).failures, []);
  });

  test('Rule 5 - a change touching anything outside the class is not required to record a run', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w('web/src/components/Thing.tsx', 'export const Thing = () => null;\n');
    });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.equal(r.unattended, false);
    assert.deepEqual(r.outOfClass, ['web/src/components/Thing.tsx']);
    assert.deepEqual(r.failures, []);
  });

  test('Rule 5 - changing only the ledger is a transcription, not an unrecorded publish', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
    });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.equal(r.transcription, true);
    assert.deepEqual(r.failures, []);
  });

  // -------------------------------------------------------------------------
  // Rule 6. The ledger is append-only.
  //
  // The defect this rule exists for: every other rule asks what the working
  // tree *gained*, so a removal plus an equal-sized addition nets out and is
  // invisible to all of them. The first test is that swap exactly - the fixture
  // deletes a published run while adding a correctly reconciled one, and every
  // other rule in this gate is satisfied by it.
  // -------------------------------------------------------------------------

  test('Rule 6 - deleting a published run while adding a valid one is refused', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      // 2026-08-28-cff539 was recorded at the anchor and is simply gone. The
      // added entry reconciles perfectly, so rules 1, 2, 3 and 4 all pass.
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 1, result.stdout);
    const r = report(result);
    assert.deepEqual(r.entriesRemoved, ['2026-08-28-cff539']);
    assert.deepEqual(r.entriesAdded, ['2026-09-01-aaaaaa']);
    assert.match(r.failures.join('\n'), /removes 1 recorded run/);
    assert.match(r.failures.join('\n'), /append-only/);
  });

  test('Rule 6 - a deletion with no addition at all is refused', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w(LEDGER, []);
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 1, result.stdout);
    assert.deepEqual(report(result).entriesRemoved, ['2026-08-28-cff539']);
  });

  test('Rule 6 - a deletion is refused in transcription mode too', () => {
    // No dataset document changes here, so this is a transcription and rules 1
    // and 2 are relaxed. The no-deletion half is not relaxed with them.
    const result = ledgerRepo(({ writeJson: w }) => {
      w(LEDGER, [entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)])]);
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 1, result.stdout);
    const r = report(result);
    assert.equal(r.transcription, true);
    assert.deepEqual(r.entriesRemoved, ['2026-08-28-cff539']);
  });

  test('Rule 6 - rewriting a prior entry in place while publishing is refused', () => {
    // The id set is unchanged, so an id-only comparison sees nothing. The
    // numbers inside a published entry moved, and there is no diff in front of
    // this gate to re-derive them from.
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [
        entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)]),
        entry('2026-08-28-cff539', [doc('families.json', 0, 99)]),
      ]);
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 1, result.stdout);
    const r = report(result);
    assert.deepEqual(r.entriesRemoved, []);
    assert.match(r.failures.join('\n'), /alters 1 entry/);
  });

  test('Rule 6 - correcting a historical entry in transcription mode is allowed', () => {
    // The repair route ADR 0006 keeps open: no dataset document changes, so
    // there is no run being published and nothing for the edit to contradict.
    const result = ledgerRepo(({ writeJson: w }) => {
      w(LEDGER, [entry('2026-08-28-cff539', [doc('families.json', 0, 7)])]);
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 0, result.stdout);
    const r = report(result);
    assert.deepEqual(r.entriesRemoved, []);
    assert.deepEqual(r.failures, []);
  });

  test('Rule 6 - appending while leaving prior entries untouched passes', () => {
    const result = ledgerRepo(({ writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [
        entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)]),
        entry('2026-08-28-cff539', [doc('families.json', 0, 1)]),
      ]);
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(report(result).failures, []);
  });

  // -------------------------------------------------------------------------
  // Rule 4, reused ids. Declaring an id the anchor already records is not
  // satisfied by the entry that was already there.
  // -------------------------------------------------------------------------

  test('Rule 4 - declaring an id the ledger already recorded is refused', () => {
    const result = ledgerRepo(({ git, writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      git('add', '-A');
      git('commit', '-qm', 'chore(data): re-verify records (run 2026-08-28-cff539)');
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 1, result.stdout);
    const r = report(result);
    assert.deepEqual(r.entriesAdded, []);
    assert.match(r.failures.join('\n'), /already recorded/);
  });

  test('Rule 4 - a declared id must be satisfied by an entry this branch adds', () => {
    const result = ledgerRepo(({ git, writeJson: w }) => {
      w('web/src/data/releases.json', [{ id: 'r1' }, { id: 'r2' }]);
      w(LEDGER, [
        entry('2026-09-01-aaaaaa', [doc('releases.json', 1, 2)]),
        entry('2026-08-28-cff539', [doc('families.json', 0, 1)]),
      ]);
      git('add', '-A');
      git('commit', '-qm', 'chore(data): re-verify records (run 2026-09-01-aaaaaa)');
    }, [], { ledger: [entry('2026-08-28-cff539', [doc('families.json', 0, 1)])] });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(report(result).failures, []);
  });

  // -------------------------------------------------------------------------
  // The class this gate computes must be the class `gate-scope.mjs` enforces.
  // Two gates disagreeing about which paths are in class is how a file ends up
  // auto-mergeable by one and not the other.
  // -------------------------------------------------------------------------

  test('the qualifying class this gate computes equals gate-scope ALLOWED_PATHS', () => {
    const scopeSource = readFileSync(GATE_SCOPE, 'utf8');
    const ledgerSource = readFileSync(GATE_LEDGER, 'utf8');
    const between = (source, marker) => {
      const start = source.indexOf(marker);
      assert.notEqual(start, -1, `${marker} not found`);
      const open = source.indexOf('[', start);
      const close = source.indexOf(']', open);
      return new Set([...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]));
    };
    const scope = between(scopeSource, 'const ALLOWED_PATHS');
    const dataset = between(ledgerSource, 'const DATASET_PATHS');
    dataset.add('web/src/data/refresh-runs.json');
    assert.deepEqual([...dataset].sort(), [...scope].sort());
  });


  test('the live repository ledger records every run its published history declares', () => {
    const result = run(GATE_LEDGER, ['--repo', REPO, '--history', '--json']);
    if (result.code === 2) return; // no origin/main ref here, e.g. a shallow CI checkout
    assert.equal(result.code, 0, result.stdout);
  });
});

// ===========================================================================
// gate-reversals.mjs -- a claim the panel rejected is on trunk (#835)
//
// The gate answers one question: is every panel-rejected record that is in the
// dataset today annotated in `rejection-reversals.json`? It does not judge
// whether the annotation's reasoning is good. So the tests below are about
// discrimination -- that the gate refuses a reversal nobody wrote down, and
// passes one that somebody did -- and never about whether an objection was
// well answered, which is a reviewer's job and not a script's.
//
// Fixtures rather than the live dataset wherever a test needs a specific
// shape, because the live ledger is 62 rejections deep and a mutation buried
// in it is unreadable next to the assertion. The live data is exercised too,
// at the top, since a gate that only ever sees fixtures can drift away from
// the thing it gates.
// ===========================================================================

/**
 * A three-file dataset directory: the ledger, one collection, and the register.
 * Enough for this gate, which reads nothing else, and small enough that the
 * fixture fits beside its assertion.
 */
function gateReversalsFixture({ ledger, families, register }, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-reversals-'));
  try {
    writeFileSync(join(dir, 'refresh-runs.json'), JSON.stringify(ledger, null, 2));
    writeFileSync(join(dir, 'families.json'), JSON.stringify(families ?? [], null, 2));
    if (register !== undefined) {
      writeFileSync(join(dir, 'rejection-reversals.json'), JSON.stringify(register, null, 2));
    }
    return run(GATE_REVERSALS, ['--data', dir, '--json', ...args]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The live dataset, mutated by `edit`, then gated. */
function gateReversalsMutated(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'modeltree-reversals-live-'));
  try {
    cpSync(DATA, dir, { recursive: true });
    const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const write = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
    edit({ read, write });
    return run(GATE_REVERSALS, ['--data', dir, '--json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One rejection, in the ledger shape the panel actually writes. */
const rejection = (id, detail) => ({ id, category: 'rejected-by-panel', detail, blockedBy: [] });

/** A ledger holding exactly the rejections given. The run's own key is `id`. */
const ledgerOf = (...withheld) => [{ id: 'fixture-run', startedAt: '2026-01-01T00:00:00Z', withheld }];

/** A register entry that satisfies every shape rule, so a test can break one thing. */
const annotation = (over = {}) => ({
  runId: 'fixture-run',
  withheldId: 'w-1',
  collection: 'families',
  recordId: 'acme-widget',
  landedVia: '#1 (abc1234)',
  recordedOn: '2026-01-02',
  objections: [{ summary: 'The panel wanted a quote.', disposition: 'answered', evidence: 'The record now carries one.' }],
  ...over,
});

const REJECTED_WIDGET = rejection('w-1', 'families record acme-widget for acme. No quote was supplied.');
const WIDGET = [{ id: 'acme-widget' }];

describe('gate-reversals.mjs', () => {
  // -------------------------------------------------------------------------
  // The live dataset, and the two directions that make a pass mean something.
  // -------------------------------------------------------------------------

  test('the live dataset annotates every panel-rejected record that is in it', () => {
    const result = run(GATE_REVERSALS, ['--json']);
    assert.equal(result.code, 0, result.stdout);
  });

  test('dropping one live annotation is refused, naming the record it dropped', () => {
    // The difference control for the test above. Same gate, same data, one
    // entry removed: if this passed too, the passing run would be measuring
    // nothing.
    const result = gateReversalsMutated(({ read, write }) => {
      const register = read('rejection-reversals.json');
      const kept = register.filter((entry) => entry.recordId !== 'ai2-molmo');
      assert.equal(kept.length, register.length - 1, 'the live register should annotate ai2-molmo');
      write('rejection-reversals.json', kept);
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /families\/ai2-molmo/);
  });

  test('a dataset with no annotations at all is refused once per reversal', () => {
    // #835 as it stood: the records on trunk, the rejections in the ledger,
    // and nothing reconciling them.
    const result = gateReversalsMutated(({ write }) => write('rejection-reversals.json', []));
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.failures.length, parsed.reversals.length);
    assert.ok(parsed.reversals.includes('families/ai2-molmo'));
  });

  // -------------------------------------------------------------------------
  // Rule 1 -- a rejected record in the dataset needs an annotation, and a
  // rejected record that is *not* in the dataset needs nothing.
  // -------------------------------------------------------------------------

  test('a rejected record that is in the dataset and unannotated is refused', () => {
    const result = gateReversalsFixture({ ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET, register: [] });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /families\/acme-widget is in the dataset/);
  });

  test('the same rejection with the record absent passes -- the rejection still stands', () => {
    // The clean case for the test above, differing in one thing only: whether
    // the record is there. A gate that refused here would be forbidding
    // rejections rather than requiring reversals to be visible.
    const result = gateReversalsFixture({ ledger: ledgerOf(REJECTED_WIDGET), families: [], register: [] });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).reversals, []);
  });

  test('the same rejection, annotated, passes with the record present', () => {
    const result = gateReversalsFixture({ ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET, register: [annotation()] });
    assert.equal(result.code, 0, result.stdout);
  });

  test('a withheld entry in another category is not this gate\u2019s business', () => {
    const ledger = ledgerOf(REJECTED_WIDGET, {
      id: 'w-2', category: 'dropped-after-acceptance', detail: 'families record acme-other for acme.', blockedBy: [],
    });
    const result = gateReversalsFixture({
      ledger, families: [...WIDGET, { id: 'acme-other' }], register: [annotation()],
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).reversals, ['families/acme-widget']);
  });

  // -------------------------------------------------------------------------
  // Rule 2 -- an annotation has to point at a rejection that exists, and at the
  // record that rejection is about. An annotation nobody can trace back is a
  // note, not a reconciliation.
  // -------------------------------------------------------------------------

  test('an annotation naming no such rejection is refused', () => {
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation(), annotation({ withheldId: 'w-99', recordId: 'acme-widget' })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /annotates no rejection/);
  });

  test('an annotation naming the wrong record for a real rejection is refused', () => {
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation({ recordId: 'acme-something-else' })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /but that rejection is about families\/acme-widget/);
  });

  // -------------------------------------------------------------------------
  // Rule 3 -- an annotation whose record has since gone is stale. The rejection
  // stands again, and a register still claiming it was revisited misleads.
  // -------------------------------------------------------------------------

  test('an annotation for a record no longer in the dataset is refused as stale', () => {
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: [], register: [annotation()],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /is not in the dataset/);
  });

  // -------------------------------------------------------------------------
  // Rule 4 -- one rejection, at most one annotation. Two annotations of the
  // same rejection can disagree, and then the register has no single answer.
  // -------------------------------------------------------------------------

  test('two annotations of one rejection are refused', () => {
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation(), annotation({ landedVia: '#2 (def5678)' })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /is a duplicate/);
  });

  // -------------------------------------------------------------------------
  // Rule 5 -- shape. Each of these is one field away from the passing entry
  // above, so what the assertion demonstrates is that field and not the rest.
  // -------------------------------------------------------------------------

  for (const field of ['runId', 'withheldId', 'collection', 'recordId', 'landedVia', 'recordedOn']) {
    test(`an annotation missing ${field} is refused`, () => {
      const entry = annotation();
      delete entry[field];
      const result = gateReversalsFixture({ ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET, register: [entry] });
      assert.equal(result.code, 1);
      assert.match(result.stdout, new RegExp(field));
    });
  }

  test('an annotation with no objections is refused', () => {
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET, register: [annotation({ objections: [] })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /objections/);
  });

  test('an objection claiming it was answered, with no evidence, is refused', () => {
    // The failure this whole gate exists to make impossible to do quietly: a
    // reversal recorded as resolved without saying what resolved it.
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation({ objections: [{ summary: 'wanted a quote', disposition: 'answered' }] })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /evidence/);
  });

  test('an objection recorded as unanswered, with no wouldAnswer, is refused', () => {
    // The honest disposition is still not a free pass: saying an objection
    // stands open obliges you to say what would close it.
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation({ objections: [{ summary: 'wanted a quote', disposition: 'unanswered' }] })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /wouldAnswer/);
  });

  test('an objection recorded as unanswered, saying what would answer it, passes', () => {
    // The pair for the test above. An unanswered objection must be recordable,
    // or the gate would push its user toward claiming a resolution they do not
    // have -- which is worse than the defect it was written for.
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation({
        objections: [{ summary: 'wanted a quote', disposition: 'unanswered', wouldAnswer: 'A quote from the model card.' }],
      })],
    });
    assert.equal(result.code, 0, result.stdout);
  });

  test('a disposition outside the closed vocabulary is refused', () => {
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation({ objections: [{ summary: 'wanted a quote', disposition: 'resolved', evidence: 'x' }] })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /disposition/);
  });

  test('a field filled with whitespace does not count as filled', () => {
    const result = gateReversalsFixture({
      ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET,
      register: [annotation({ objections: [{ summary: 'wanted a quote', disposition: 'answered', evidence: '   ' }] })],
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /evidence/);
  });

  // -------------------------------------------------------------------------
  // Which rejections the gate can read at all. It reads the record id out of
  // the panel's prose, so the pattern's discrimination is load-bearing: too
  // greedy and it invents reversals, too narrow and it misses them silently.
  // -------------------------------------------------------------------------

  test('the record-naming pattern reads both shapes the panel writes and no prose', () => {
    const ledger = ledgerOf(
      rejection('m-1', 'families record acme-widget for acme. No quote.'),
      rejection('m-2', 'families record acme-widget. No creator clause on this one.'),
      rejection('p-1', 'No quote was supplied for the families record in question.'),
      rejection('p-2', 'releases/acme-widget.verifiedAt is not supported by the cited page.'),
      rejection('p-3', 'acme, as a creator, is not established by the sources consulted.'),
    );
    const result = gateReversalsFixture({ ledger, families: WIDGET, register: [annotation({ withheldId: 'm-1' })] });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.rejectionsRead, 5);
    assert.equal(parsed.rejectionsNamingARecord, 2, 'both structured shapes, neither more nor fewer');
    assert.deepEqual(parsed.unresolved.map((u) => u.withheldId).sort(), ['p-1', 'p-2', 'p-3']);
  });

  test('a pass says how many rejections it could not read', () => {
    // A pass that read as coverage of the whole ledger would be the wrong
    // reassurance. `unresolved` is the gate's own blind spot, reported.
    const result = run(GATE_REVERSALS, []);
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /name no record in their detail/);
    assert.match(result.stdout, /Not checked is not passed/);
  });

  // -------------------------------------------------------------------------
  // Exit 2 -- could not run. Never a pass, and distinct from a refusal.
  // -------------------------------------------------------------------------

  test('a ledger holding no panel rejection at all exits 2, not 0', () => {
    // The subject vanished -- a renamed category, a restructured ledger, a
    // wrong directory. A gate with nothing to check must not report a pass.
    const ledger = ledgerOf({ id: 'w-1', category: 'dropped-after-acceptance', detail: 'families record acme-widget.', blockedBy: [] });
    const result = gateReversalsFixture({ ledger, families: WIDGET, register: [] });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /no withheld entry with category/);
  });

  test('a missing register is a refusal when there are reversals, not a pass', () => {
    // Deleting the file must not be a way through. `register` omitted here
    // means the file is not written at all.
    const result = gateReversalsFixture({ ledger: ledgerOf(REJECTED_WIDGET), families: WIDGET });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /is in the dataset/);
  });

  test('a data directory that does not exist exits 2', () => {
    const result = run(GATE_REVERSALS, ['--data', join(tmpdir(), 'modeltree-no-such-dir-zzz'), '--json']);
    assert.equal(result.code, 2);
  });

  for (const flag of ['--force', '--skip-gates', '--allow', '--no-verify']) {
    test(`${flag} is not a flag this gate has`, () => {
      // Bypasses belong in branch protection, where they are auditable. An
      // unrecognised flag is a gate that could not run, never a pass.
      const result = run(GATE_REVERSALS, [flag]);
      assert.equal(result.code, 2);
    });
  }

  test('the gate source offers no bypass', () => {
    // Scanned with comments stripped, because this file's own header discusses
    // the flags it refuses to have and an unscoped search would match that
    // prose -- a test that fails on the documentation of the property it is
    // checking would teach the next reader to delete the documentation.
    const code = readFileSync(GATE_REVERSALS, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const bypass of ['--force', '--skip', 'process.env']) {
      assert.equal(code.includes(bypass), false, `${bypass} appears in gate-reversals.mjs`);
    }
    // The stripper has to be shown to leave code behind, or an empty string
    // would satisfy every assertion above.
    assert.match(code, /function gate\(/);
  });

  test('the unresolved set is a real blind spot, not an empty formality', () => {
    // abdeslam-menacere/ModelTree#835's review caught this gate's header
    // asserting that the rejections it cannot parse hold nothing that landed.
    // That was false, and a false claim in a committed document is the exact
    // defect #835 was filed about, so the correction is locked here rather than
    // left in prose that can rot again.
    //
    // The assertion is deliberately an invariant and not a count. A hand-written
    // number is right only against one merge-base -- two branches could each land
    // a rejected record, each state a total right for themselves, and both go
    // green while their merge is wrong. That is the #276 lesson, and the reason
    // the skill docs are forbidden a test count; the same trap applies here.
    const result = run(GATE_REVERSALS, ['--json']);
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.ok(report.unresolved.length > 0, 'no unresolved rejections, so this test measures nothing');

    const present = new Set();
    for (const file of ['families.json', 'releases.json', 'sources.json', 'organizations.json', 'publishers.json']) {
      for (const record of JSON.parse(readFileSync(join(DATA, file), 'utf8'))) present.add(record.id);
    }
    // Control: the id set must be able to answer "no", or "yes" below is noise.
    assert.equal(present.has('zzz-not-a-real-record'), false);

    const SUFFIXES = ['-release-add', '-add-release', '-release', '-family', '-source', '-add'];
    const landed = report.unresolved.filter(({ withheldId }) => {
      if (typeof withheldId !== 'string' || /\.verifiedAt$/.test(withheldId)) return false;
      const candidates = [withheldId];
      for (const s of SUFFIXES) if (withheldId.endsWith(s)) candidates.push(withheldId.slice(0, -s.length));
      return candidates.some((c) => present.has(c));
    });
    assert.ok(
      landed.length > 0,
      'The gate\'s documented blind spot claims unreadable rejections name records that are '
      + 'present. None do. Either the gap closed -- in which case update the header, SKILL.md, '
      + 'skills-ci.yml and web/src/data/README.md, which all state it -- or this probe broke.',
    );
  });
});
