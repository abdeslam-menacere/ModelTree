// Tests for the introduction-time licence check (ADR 0019, #957).
//
// The instrument under test is deliberately narrow: it reports on the licence
// URLs a change introduces, and it has no full-sweep mode. Two properties carry
// most of the weight and each is asserted in both directions, because a probe
// that cannot demonstrate it would have noticed the opposite has measured
// nothing:
//
//   * a 404 on an introduced licence URL IS a finding, and
//   * a 429, a 403 and a timeout on the same URL are NOT findings.
//
// Asserting only the second would pass for an instrument that never reports
// anything at all, which is the exact failure ADR 0017's guardrail is about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ACTIONABLE_STATES,
  BLOCKED,
  BROKEN,
  OK,
  TRANSIENT,
  canonicaliseUrl,
  checkAll,
  extractLicenceTargets,
  selectChanged,
  summarise,
} from './link-health.mjs';

import { baselineLicencePairs, render } from './check-licence-links.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const RELEASES_FILE = resolve(REPO_ROOT, 'web', 'src', 'data', 'releases.json');
const CLI = resolve(HERE, 'check-licence-links.mjs');

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    return handler(url, init.method, calls.length);
  };
  return { fetchImpl, calls };
}

function offline(handler) {
  const { fetchImpl, calls } = stubFetch(handler);
  return { options: { fetchImpl, sleep: async () => {}, hostDelayMs: 0 }, calls };
}

function reply(status, headers = {}) {
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, url: 'https://example.test/' };
}

function licenceTarget(url, ids) {
  const canonical = canonicaliseUrl(url);
  return {
    canonical,
    host: new URL(canonical).host,
    recordIds: [...ids],
    licenceRecordIds: [...ids],
    titles: [],
    rawUrls: [url],
  };
}

function runCli(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
}

function withTempDir(fn) {
  const dir = mkdtempSync(resolve(tmpdir(), 'licence-links-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* The structural guarantee: this instrument cannot sweep                     */
/* -------------------------------------------------------------------------- */

test('the CLI refuses to run without a baseline, so it has no full-sweep mode', () => {
  const run = runCli([]);

  assert.equal(run.status, 2, `expected exit 2, got ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, /--baseline is required/);
  assert.match(run.stderr, /no full-sweep mode/);
});

test('the same invocation WITH a baseline runs, so the refusal above is about the flag', () => {
  withTempDir((dir) => {
    const baseline = resolve(dir, 'baseline.json');
    writeFileSync(baseline, readFileSync(RELEASES_FILE, 'utf8'), 'utf8');

    const run = runCli(['--dry-run', '--baseline', baseline]);

    // The control for the test above. Without it, an instrument that exited 2
    // unconditionally would pass that assertion while being entirely broken.
    assert.equal(run.status, 0, `expected exit 0, got ${run.status}: ${run.stderr}`);
    assert.match(run.stdout, /Licence link introduction check — dry run/);
  });
});

test('the CLI refuses an unknown flag rather than ignoring it', () => {
  withTempDir((dir) => {
    const baseline = resolve(dir, 'baseline.json');
    writeFileSync(baseline, '[]', 'utf8');

    const run = runCli(['--baseline', baseline, '--no-licences']);

    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown flag --no-licences/);
  });
});

test('the CLI refuses to write inside the dataset', () => {
  withTempDir((dir) => {
    const baseline = resolve(dir, 'baseline.json');
    writeFileSync(baseline, '[]', 'utf8');

    const run = runCli(['--dry-run', '--baseline', baseline, '--report', 'web/src/data/report.md']);

    assert.equal(run.status, 2);
    assert.match(run.stderr, /never mutates the dataset/);
  });
});

/* -------------------------------------------------------------------------- */
/* Narrowing: what counts as "introduced"                                     */
/* -------------------------------------------------------------------------- */

const RELEASE_FIXTURE = [
  { id: 'alpha-1', license: { url: 'https://example.test/alpha/LICENSE' } },
  { id: 'beta-1', license: { url: 'https://example.test/beta/LICENSE' } },
  { id: 'gamma-1', license: { name: 'Bespoke, no URL' } },
];

test('a release whose licence URL is unchanged is not introduced', () => {
  const { targets } = extractLicenceTargets(RELEASE_FIXTURE);
  const introduced = selectChanged(targets, baselineLicencePairs(RELEASE_FIXTURE));

  assert.equal(introduced.length, 0);
});

test('a release re-pointed at a new licence URL counts as introduced', () => {
  const after = [
    { id: 'alpha-1', license: { url: 'https://example.test/alpha/LICENSE.txt' } },
    ...RELEASE_FIXTURE.slice(1),
  ];

  const { targets } = extractLicenceTargets(after);
  const introduced = selectChanged(targets, baselineLicencePairs(RELEASE_FIXTURE));

  assert.deepEqual(
    introduced.map((t) => t.canonical),
    ['https://example.test/alpha/LICENSE.txt'],
  );
});

test('a brand-new release carrying a licence URL counts as introduced', () => {
  const after = [...RELEASE_FIXTURE, { id: 'delta-1', license: { url: 'https://example.test/delta/LICENSE' } }];

  const { targets } = extractLicenceTargets(after);
  const introduced = selectChanged(targets, baselineLicencePairs(RELEASE_FIXTURE));

  assert.deepEqual(
    introduced.map((t) => t.licenceRecordIds),
    [['delta-1']],
  );
});

test('a release that only changed its licence NAME is not introduced', () => {
  const after = [
    { id: 'alpha-1', license: { name: 'Apache-2.0', url: 'https://example.test/alpha/LICENSE' } },
    ...RELEASE_FIXTURE.slice(1),
  ];

  const { targets } = extractLicenceTargets(after);

  assert.equal(selectChanged(targets, baselineLicencePairs(RELEASE_FIXTURE)).length, 0);
});

test('baselineLicencePairs survives a baseline that is not an array', () => {
  assert.deepEqual(baselineLicencePairs(null), []);
  assert.deepEqual(baselineLicencePairs({ releases: [] }), []);
});

test('an empty baseline treats every licence URL as introduced', () => {
  const { targets } = extractLicenceTargets(RELEASE_FIXTURE);

  assert.equal(selectChanged(targets, baselineLicencePairs([])).length, targets.length);
  assert.equal(targets.length, 2, 'the fixture release with no licence URL must not become a target');
});

/* -------------------------------------------------------------------------- */
/* What is and is not a finding                                               */
/* -------------------------------------------------------------------------- */
//
// Both directions, in the same file, on the same target. This is the guardrail
// ADR 0017 sets and ADR 0019 keeps: a rate limit is not a finding.

test('an introduced licence URL that 404s IS a finding', async () => {
  const { options } = offline(() => reply(404));
  const results = await checkAll([licenceTarget('https://example.test/gone/LICENSE', ['alpha-1'])], options);

  assert.equal(results[0].state, BROKEN);
  assert.ok(ACTIONABLE_STATES.has(results[0].state));
  assert.equal(summarise(results).actionableUrls, 1);
});

test('an introduced licence URL that is rate-limited is NOT a finding', async () => {
  const { options } = offline(() => reply(429));
  const results = await checkAll([licenceTarget('https://example.test/busy/LICENSE', ['alpha-1'])], options);

  assert.equal(results[0].state, BLOCKED);
  assert.ok(!ACTIONABLE_STATES.has(results[0].state));
  assert.equal(summarise(results).actionableUrls, 0);
});

test('an introduced licence URL that times out is NOT a finding', async () => {
  const { options } = offline(() => {
    throw new Error('socket hang up');
  });
  const results = await checkAll([licenceTarget('https://example.test/slow/LICENSE', ['alpha-1'])], options);

  assert.equal(results[0].state, TRANSIENT);
  assert.ok(!ACTIONABLE_STATES.has(results[0].state));
  assert.equal(summarise(results).actionableUrls, 0);
});

test('an introduced licence URL that resolves is not a finding either', async () => {
  const { options } = offline(() => reply(200));
  const results = await checkAll([licenceTarget('https://example.test/live/LICENSE', ['alpha-1'])], options);

  assert.equal(results[0].state, OK);
  assert.equal(summarise(results).actionableUrls, 0);
});

/* -------------------------------------------------------------------------- */
/* The report: one provenance, and a visible denominator                      */
/* -------------------------------------------------------------------------- */

test('the report names licence provenance and never calls a release a source record', () => {
  const report = render({
    introduced: 1,
    excluded: [],
    scope: 'this change introduced or re-pointed',
    results: [
      {
        canonical: 'https://example.test/gone/LICENSE',
        host: 'example.test',
        recordIds: ['xiaomi-mimo-7b-rl-0530'],
        licenceRecordIds: ['xiaomi-mimo-7b-rl-0530'],
        titles: [],
        rawUrls: ['https://example.test/gone/LICENSE'],
        state: BROKEN,
        status: 404,
        finalUrl: 'https://example.test/gone/LICENSE',
        attempts: 1,
        observations: [],
      },
    ],
  });

  assert.ok(report.includes('named as `license.url` by `xiaomi-mimo-7b-rl-0530`'));
  assert.ok(!/[Ss]ource record/.test(report), 'a release must never be presented as a source record');
});

test('introducing nothing reads as scope, not as a clean bill of health', () => {
  const report = render({ introduced: 0, results: [], excluded: [], scope: 'x' });

  assert.ok(report.includes('introduces or re-points **no** `license.url`'));
  assert.ok(
    report.includes('not a clean bill of health'),
    'not-looked and looked-and-found-nothing must stay separately representable (ADR 0018)',
  );
  assert.ok(!/need attention/.test(report), 'a run that requested nothing must not report a pass');
});

test('a run that requested something and found nothing reads differently from one that requested nothing', () => {
  const looked = render({
    introduced: 1,
    excluded: [],
    scope: 'this change introduced or re-pointed',
    results: [
      {
        canonical: 'https://example.test/live/LICENSE',
        host: 'example.test',
        recordIds: ['alpha-1'],
        licenceRecordIds: ['alpha-1'],
        titles: [],
        rawUrls: ['https://example.test/live/LICENSE'],
        state: OK,
        status: 200,
        finalUrl: 'https://example.test/live/LICENSE',
        attempts: 1,
        observations: [],
      },
    ],
  });
  const didNotLook = render({ introduced: 0, results: [], excluded: [], scope: 'x' });

  assert.notEqual(looked, didNotLook);
  assert.ok(looked.includes('Requested 1 of the 1 licence URL(s)'));
  assert.ok(looked.includes('0 need attention'));
});

/* -------------------------------------------------------------------------- */
/* Against the committed dataset                                              */
/* -------------------------------------------------------------------------- */

test('the committed dataset against itself introduces nothing', () => {
  const releases = JSON.parse(readFileSync(RELEASES_FILE, 'utf8'));
  const { targets } = extractLicenceTargets(releases);

  assert.equal(selectChanged(targets, baselineLicencePairs(releases)).length, 0);
  // The control: the same dataset against an empty baseline must select all of
  // it, or the assertion above would pass for a selector that returns nothing.
  assert.equal(selectChanged(targets, baselineLicencePairs([])).length, targets.length);
  assert.ok(targets.length > 0, 'the dataset is expected to record licence URLs at all');
});

test('the CLI reports the introduced count against the committed dataset', () => {
  withTempDir((dir) => {
    const baseline = resolve(dir, 'baseline.json');
    const releases = JSON.parse(readFileSync(RELEASES_FILE, 'utf8'));

    // Drop one release's licence URL, so exactly one is "introduced".
    const withUrl = releases.findIndex((r) => typeof r?.license?.url === 'string');
    assert.ok(withUrl >= 0, 'the dataset is expected to record licence URLs at all');
    const trimmed = releases.map((r, i) => (i === withUrl ? { ...r, license: { ...r.license, url: undefined } } : r));
    writeFileSync(baseline, JSON.stringify(trimmed), 'utf8');

    const json = resolve(dir, 'out.json');
    const run = runCli(['--dry-run', '--baseline', baseline, '--json', json]);

    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(payload.dryRun, true);
    assert.ok(payload.introducedUrls >= 1, 'dropping a licence URL from the baseline must introduce it');
    assert.equal(payload.checkedUrls, 0, 'a dry run requests nothing');
    assert.ok(payload.totalLicenceUrls > payload.introducedUrls, 'the denominator must be the whole set');
  });
});
