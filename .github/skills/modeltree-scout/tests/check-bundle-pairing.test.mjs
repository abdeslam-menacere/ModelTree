// Non-vacuity tests for check-bundle-pairing.mjs. Each test either exercises
// the failure the check was written to catch (a lone source-add), or the shape
// the check must not flag (a paired source-add plus the citation edit that
// wires it in). Run with `node --test .github/skills/modeltree-scout/tests/check-bundle-pairing.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
