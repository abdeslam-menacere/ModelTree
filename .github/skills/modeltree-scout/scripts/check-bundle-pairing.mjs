#!/usr/bin/env node
// Bundle-time check that a scout run does not leave a source uncited.
//
// A source added to `sources.json` is only useful if some record cites it. The
// dataset test `web/src/data/validate.test.ts` treats an unreferenced source as
// dead provenance and refuses to load a dataset with one. That check is correct
// and out of scope for this script (see #403); the point of this script is to
// catch the same failure earlier — at bundle time, before review — so a scout
// cannot ship a source-add claim without the paired `sourceIds` edit that wires
// it into a record.
//
// The check operates on the bundle's proposed additions and changes, not on
// verdicts (which are absent when the scout writes the bundle). It refuses:
//
//   - a bundle whose accepted `add`/`change` set adds a source that nothing in
//     the same accepted set cites, naming the orphaned source ids;
//   - a bundle whose scout output already contains a source-add claim with no
//     paired citation claim (the common case at scout-write time), naming both
//     the source and the fact that the paired claim is missing.
//
// A bundle with no source-add claim passes trivially. A bundle where both a
// source-add and its paired citation edit are present passes. A bundle where
// the source-add is dropped by review but the citation edit is kept is caught
// by `validateDataset` at publish time (that citation now references a missing
// source), so it does not need a separate rule here.
//
// Exit codes:
//   0   the bundle is coherent
//   1   the bundle has one or more uncited source additions
//   2   the bundle is malformed (missing file, invalid JSON, wrong shape)
//
// The check is deliberately narrow: it does not judge sources, verdicts, or
// evidence. Those belong to the review panel and the gates.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { argv, exit, stderr, stdout } from 'node:process';

/** The nine dataset collections that carry `sourceIds` today, per validate.ts. */
const SOURCE_ID_COLLECTIONS = new Set([
  'organizations',
  'families',
  'releases',
  'publishers',
  'usageObservations',
  'modelFitStatements',
  'products',
  'servingPlatforms',
  'deployments',
  'pricing',
  'benchmarks',
  'benchmarkResults',
  'releaseEvents',
]);

/**
 * Pull every source id cited by a single proposed record. `add` claims carry
 * the whole record as `proposedValue`, `change` claims carry only the new value
 * of one field. This function walks either shape defensively.
 */
function citedSourceIdsFromValue(value) {
  const cited = new Set();
  if (!value || typeof value !== 'object') return cited;
  if (Array.isArray(value.sourceIds)) {
    for (const id of value.sourceIds) if (typeof id === 'string') cited.add(id);
  }
  // Publishers carry `sourceIds` under `control`; walk one level in for that.
  if (value.control && Array.isArray(value.control.sourceIds)) {
    for (const id of value.control.sourceIds) if (typeof id === 'string') cited.add(id);
  }
  return cited;
}

function citedSourceIdsFromChange(claim) {
  const cited = new Set();
  if (claim.field === 'sourceIds' && Array.isArray(claim.proposedValue)) {
    for (const id of claim.proposedValue) if (typeof id === 'string') cited.add(id);
  }
  // A `change` claim that replaces `control` on a publisher, or that swaps a
  // whole record's `sourceIds` under a different field name, is not a shape a
  // scout produces today. If one appears, the union with citedSourceIdsFromValue
  // below still catches it.
  for (const id of citedSourceIdsFromValue(claim.proposedValue)) cited.add(id);
  return cited;
}

/**
 * Analyse a parsed bundle. Returns { addedSources, citedSources, orphans }.
 * `orphans` is the list of source ids added by this bundle that nothing in the
 * same bundle cites — the failure mode this script exists to catch.
 */
export function analyseBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.claims)) {
    throw new Error('bundle must be an object with a `claims` array');
  }

  const addedSources = new Set();
  const citedSources = new Set();

  for (const claim of bundle.claims) {
    if (!claim || typeof claim !== 'object') continue;
    if (!SOURCE_ID_COLLECTIONS.has(claim.collection) && claim.collection !== 'sources') {
      // Unknown collection is a gate concern, not this script's; skip it here
      // rather than double-report.
      continue;
    }

    if (claim.collection === 'sources' && claim.kind === 'add') {
      // proposedValue is the whole source record; its id is what would land in
      // sources.json. Fall back to targetId, which the bundle contract says
      // carries the same id.
      const id = claim.proposedValue?.id ?? claim.targetId;
      if (typeof id === 'string' && id.length > 0) addedSources.add(id);
    }

    if (claim.kind === 'add') {
      for (const id of citedSourceIdsFromValue(claim.proposedValue)) citedSources.add(id);
    } else if (claim.kind === 'change') {
      for (const id of citedSourceIdsFromChange(claim)) citedSources.add(id);
    }
  }

  const orphans = [...addedSources].filter((id) => !citedSources.has(id)).sort();
  return { addedSources, citedSources, orphans };
}

function main() {
  const [, , bundlePath] = argv;
  if (!bundlePath) {
    stderr.write('usage: check-bundle-pairing.mjs <bundle.json>\n');
    exit(2);
  }

  let raw;
  try {
    raw = readFileSync(bundlePath, 'utf8');
  } catch (error) {
    stderr.write(`could not read ${bundlePath}: ${error.message}\n`);
    exit(2);
  }

  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch (error) {
    stderr.write(`could not parse ${bundlePath} as JSON: ${error.message}\n`);
    exit(2);
  }

  let result;
  try {
    result = analyseBundle(bundle);
  } catch (error) {
    stderr.write(`bundle at ${bundlePath} is malformed: ${error.message}\n`);
    exit(2);
  }

  if (result.orphans.length === 0) {
    stdout.write(`ok: ${result.addedSources.size} source add(s) all paired with a citation claim\n`);
    exit(0);
  }

  stderr.write(
    `bundle would add source(s) that no claim in the same bundle cites, so ` +
      `applying it would fail validate.test.ts (an unreferenced source is dead ` +
      `provenance):\n`,
  );
  for (const id of result.orphans) {
    stderr.write(`  - ${id}\n`);
  }
  stderr.write(
    `each orphaned source needs a paired claim wiring it into some record's ` +
      `sourceIds, or the source claim must be dropped.\n`,
  );
  exit(1);
}

// Run only when invoked as a script, not when imported by tests.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) main();
