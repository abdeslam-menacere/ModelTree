// Non-vacuity tests for check-bundle-pairing.mjs. Each test either exercises
// the failure the check was written to catch (a lone source-add), or the shape
// the check must not flag (a paired source-add plus the citation edit that
// wires it in). Run with `node --test .github/skills/modeltree-scout/tests/check-bundle-pairing.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { analyseBundle } from '../scripts/check-bundle-pairing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', 'scripts', 'check-bundle-pairing.mjs');
const orphanFixture = resolve(here, 'fixtures', 'orphan-source.claims.json');
const pairedFixture = resolve(here, 'fixtures', 'paired-source.claims.json');

function readBundle(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('analyseBundle reports the orphaned source id on a lone source-add', () => {
  const bundle = readBundle(orphanFixture);
  const result = analyseBundle(bundle);
  assert.deepEqual([...result.addedSources], ['openai-deprecations']);
  assert.deepEqual(result.orphans, ['openai-deprecations']);
});

test('analyseBundle reports no orphans when the citation edit is present', () => {
  const bundle = readBundle(pairedFixture);
  const result = analyseBundle(bundle);
  assert.deepEqual([...result.addedSources], ['openai-deprecations']);
  assert.ok(result.citedSources.has('openai-deprecations'));
  assert.deepEqual(result.orphans, []);
});

test('analyseBundle passes when no source is being added', () => {
  const bundle = {
    runId: 'x',
    creator: 'y',
    policy: 'pilot',
    claims: [
      {
        id: 'change-only',
        kind: 'change',
        collection: 'releases',
        targetId: 'openai-gpt-5',
        field: 'status',
        currentValue: 'active',
        proposedValue: 'deprecated',
      },
    ],
  };
  const result = analyseBundle(bundle);
  assert.deepEqual(result.orphans, []);
  assert.equal(result.addedSources.size, 0);
});

test('analyseBundle throws on a malformed bundle', () => {
  assert.throws(() => analyseBundle({}), /claims/);
  assert.throws(() => analyseBundle(null), /claims/);
});

test('CLI exits 1 and names the orphaned source when a source is unpaired', () => {
  const proc = spawnSync(process.execPath, [script, orphanFixture], { encoding: 'utf8' });
  assert.equal(proc.status, 1, `expected exit 1, got ${proc.status}. stderr:\n${proc.stderr}`);
  assert.match(proc.stderr, /openai-deprecations/);
  assert.match(proc.stderr, /dead provenance/);
});

test('CLI exits 0 when every added source has a paired citation', () => {
  const proc = spawnSync(process.execPath, [script, pairedFixture], { encoding: 'utf8' });
  assert.equal(proc.status, 0, `expected exit 0, got ${proc.status}. stderr:\n${proc.stderr}`);
  assert.match(proc.stdout, /1 source add/);
});

test('CLI exits 2 when the bundle file is missing', () => {
  const proc = spawnSync(process.execPath, [script, resolve(here, 'fixtures', 'does-not-exist.json')], {
    encoding: 'utf8',
  });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /could not read/);
});

test('CLI exits 2 with no argument', () => {
  const proc = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /usage/);
});

// --- Fail-closed and coverage partitions (review feedback on b85d01d) ---

test('analyseBundle fails closed on a sources add with no identifier', () => {
  // Neither targetId nor proposedValue.id — the checker cannot know the name of
  // the source being added, so it cannot verify pairing. Silent skip would be
  // fail-open, which is the class of defect this program treats as highest
  // severity. Report the claim index instead.
  const bundle = {
    claims: [
      { id: 'anon', kind: 'add', collection: 'sources', proposedValue: { title: 'no id here' } },
    ],
  };
  const result = analyseBundle(bundle);
  assert.deepEqual(result.unidentifiedSourceAdds, [0]);
  assert.equal(result.addedSources.size, 0);
});

test('CLI exits 1 naming the claim index for an unidentifiable sources add', () => {
  const bundle = {
    claims: [
      { id: 'anon', kind: 'add', collection: 'sources', proposedValue: { title: 'no id' } },
    ],
  };
  const path = resolve(here, 'fixtures', 'tmp-anon.claims.json');
  writeFileSync(path, JSON.stringify(bundle));
  try {
    const proc = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(proc.status, 1, `expected exit 1, got ${proc.status}. stderr:\n${proc.stderr}`);
    assert.match(proc.stderr, /no identifier/);
    assert.match(proc.stderr, /claims\[0\]/);
    // Must not report `ok`. Fail-closed here would otherwise look like success.
    assert.doesNotMatch(proc.stdout, /ok:/);
  } finally {
    rmSync(path, { force: true });
  }
});

test('analyseBundle names only the orphan when many source-adds are paired but one is not', () => {
  // Three source adds, two paired via releases[].sourceIds edits, one left
  // orphaned. The check must name only the orphan, not the paired pair.
  const bundle = {
    claims: [
      { id: 'add-a', kind: 'add', collection: 'sources', targetId: 'src-a',
        proposedValue: { id: 'src-a' } },
      { id: 'add-b', kind: 'add', collection: 'sources', targetId: 'src-b',
        proposedValue: { id: 'src-b' } },
      { id: 'add-c', kind: 'add', collection: 'sources', targetId: 'src-c',
        proposedValue: { id: 'src-c' } },
      { id: 'wire-a', kind: 'change', collection: 'releases', targetId: 'r1',
        field: 'sourceIds', currentValue: [], proposedValue: ['src-a'] },
      { id: 'wire-c', kind: 'change', collection: 'releases', targetId: 'r2',
        field: 'sourceIds', currentValue: [], proposedValue: ['src-c'] },
    ],
  };
  const result = analyseBundle(bundle);
  assert.deepEqual([...result.addedSources].sort(), ['src-a', 'src-b', 'src-c']);
  assert.deepEqual(result.orphans, ['src-b']);
});

test('analyseBundle recognises citations under publishers[].control.sourceIds', () => {
  // Publishers carry their sourceIds one level in under `control`. The check
  // must recognise a citation added via a publisher record or a publisher
  // change, or a source paired to a publisher would look orphaned.
  const bundleAsAdd = {
    claims: [
      { id: 'add-src', kind: 'add', collection: 'sources', targetId: 'src-p',
        proposedValue: { id: 'src-p' } },
      { id: 'add-pub', kind: 'add', collection: 'publishers', targetId: 'pub-x',
        proposedValue: { id: 'pub-x', control: { sourceIds: ['src-p'] } } },
    ],
  };
  assert.deepEqual(analyseBundle(bundleAsAdd).orphans, []);

  const bundleAsChange = {
    claims: [
      { id: 'add-src', kind: 'add', collection: 'sources', targetId: 'src-p',
        proposedValue: { id: 'src-p' } },
      { id: 'change-pub', kind: 'change', collection: 'publishers', targetId: 'pub-x',
        field: 'control', currentValue: { sourceIds: [] },
        proposedValue: { sourceIds: ['src-p'] } },
    ],
  };
  assert.deepEqual(analyseBundle(bundleAsChange).orphans, []);
});

test('analyseBundle recognises citations under modelFitStatements', () => {
  // model-fit-statements.json is one of the collections `validate.ts` attaches
  // sourceIds to. The check must recognise a citation added via a
  // modelFitStatements record, or a source paired to a model-fit statement
  // would look orphaned.
  const bundle = {
    claims: [
      { id: 'add-src', kind: 'add', collection: 'sources', targetId: 'src-mf',
        proposedValue: { id: 'src-mf' } },
      { id: 'add-mf', kind: 'add', collection: 'modelFitStatements', targetId: 'mf-1',
        proposedValue: { id: 'mf-1', sourceIds: ['src-mf'] } },
    ],
  };
  assert.deepEqual(analyseBundle(bundle).orphans, []);
});
