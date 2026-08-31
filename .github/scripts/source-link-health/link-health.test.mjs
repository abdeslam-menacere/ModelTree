// Tests for the source link-health checker. Run with:
//
//   node --test .github/scripts/source-link-health/link-health.test.mjs
//
// Every test here is hermetic. `fetch` and `sleep` are injected, so nothing
// reaches the network and nothing waits, and the suite gives the same answer on
// a runner with no egress as on a laptop.
//
// Two things are tested against synthetic fixtures on purpose, because the
// committed dataset cannot exercise them:
//
//   * De-duplication. Measured at the time of writing: `sources.json` held 86
//     URLs and 86 of them were unique, so de-duplication removed zero requests
//     and a test driven by real data would never enter the code path at all --
//     dead code wearing a passing suite. The fixtures below contain deliberate
//     duplicates, and the assertion counts the *requests issued*, not the
//     results returned, because only the request count can tell "checked once"
//     apart from "checked twice and reported once".
//
//   * The classifications. A 429, a 403 and a 301 cannot be conjured on demand
//     from a real host, and a suite that waited for one would be neither
//     deterministic nor hermetic.
//
// One test does read the committed dataset, and it asserts properties rather
// than sizes: three other work streams are adding source records, so any
// assertion of the form "86 sources" is a merge conflict waiting to happen and
// says nothing about correctness anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ACTIONABLE_STATES,
  BLOCKED,
  BROKEN,
  DEFAULTS,
  EXCLUDED,
  NORMALISED,
  OK,
  REDIRECTED,
  TRANSIENT,
  applyExclusions,
  canonicaliseUrl,
  checkAll,
  checkTarget,
  classifyObservation,
  classifyStatus,
  extractTargets,
  fabricateControlUrl,
  parseExclusions,
  renderReport,
  selectChanged,
  slashNormalisation,
  summarise,
} from './link-health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SOURCES_FILE = resolve(REPO_ROOT, 'web', 'src', 'data', 'sources.json');
const CLI = resolve(HERE, 'check-source-links.mjs');

/* -------------------------------------------------------------------------- */
/* Test doubles                                                               */
/* -------------------------------------------------------------------------- */

/** A minimal Response stand-in that records whether its body was cancelled or read. */
function reply(status, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const state = { cancelled: false, read: false };

  return {
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    body: {
      cancel: async () => {
        state.cancelled = true;
      },
    },
    text: async () => {
      state.read = true;
      return 'body';
    },
    bodyState: state,
  };
}

/**
 * A fetch double.
 *
 * `handler(url, method, callIndex)` returns a reply, or throws to simulate a
 * network failure. Every call is recorded, which is what the de-duplication test
 * asserts on.
 */
function stubFetch(handler) {
  const calls = [];

  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, signal: init.signal });
    return handler(url, init.method, calls.length);
  };

  return { fetchImpl, calls };
}

/** A sleep double that records what it was asked to wait rather than waiting. */
function stubSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

function target(url, recordIds = [], titles = []) {
  const canonical = canonicaliseUrl(url);
  return { canonical, host: new URL(canonical).host, recordIds, titles, rawUrls: [url] };
}

/** Options that make a check instant and offline. */
function offline(handler, extra = {}) {
  const { fetchImpl, calls } = stubFetch(handler);
  const { sleep, waits } = stubSleep();
  return { options: { fetchImpl, sleep, hostDelayMs: 0, ...extra }, calls, waits };
}

/* -------------------------------------------------------------------------- */
/* Extraction and de-duplication (acceptance criterion 1)                     */
/* -------------------------------------------------------------------------- */

const DUPLICATE_FIXTURE = [
  { id: 'alpha-announcement', url: 'https://example.test/posts/alpha', title: 'Alpha announced' },
  { id: 'alpha-model-card', url: 'https://example.test/posts/alpha', title: 'Alpha model card' },
  { id: 'alpha-benchmarks', url: 'https://example.test/posts/alpha#benchmarks', title: 'Alpha benchmarks' },
  { id: 'beta-announcement', url: 'https://other.test/posts/beta', title: 'Beta announced' },
];

test('extractTargets collapses records that name the same URL', () => {
  const { targets } = extractTargets(DUPLICATE_FIXTURE);

  assert.equal(targets.length, 2);
  const alpha = targets.find((t) => t.canonical === 'https://example.test/posts/alpha');
  assert.deepEqual(alpha.recordIds, ['alpha-announcement', 'alpha-model-card', 'alpha-benchmarks']);
});

test('extractTargets treats a fragment-only difference as the same request', () => {
  // The fragment is never sent to the server, so two records differing only by
  // `#section` are the same request by definition.
  const { targets } = extractTargets([
    { id: 'a', url: 'https://example.test/p' },
    { id: 'b', url: 'https://example.test/p#later' },
  ]);

  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0].recordIds, ['a', 'b']);
});

test('extractTargets does not collapse URLs a server could answer differently', () => {
  // A trailing slash, a query string, and path case can each change the
  // response, so folding them would check a URL nobody recorded.
  const { targets } = extractTargets([
    { id: 'a', url: 'https://example.test/p' },
    { id: 'b', url: 'https://example.test/p/' },
    { id: 'c', url: 'https://example.test/p?v=2' },
    { id: 'd', url: 'https://example.test/P' },
  ]);

  assert.equal(targets.length, 4);
});

test('a duplicated URL is requested exactly once', async () => {
  // The assertion that matters for AC1, and it counts requests rather than
  // reading them off the result list: a checker that requested the URL three
  // times and reported it once would satisfy any result-shaped assertion while
  // failing the criterion outright.
  const { targets } = extractTargets(DUPLICATE_FIXTURE);
  const { options, calls } = offline(() => reply(200));

  const results = await checkAll(targets, options);

  const alphaCalls = calls.filter((call) => call.url === 'https://example.test/posts/alpha');
  assert.equal(alphaCalls.length, 1, 'the three records naming the same URL must produce one request');
  assert.equal(calls.length, 2, 'four records, two distinct URLs, two requests');
  assert.equal(results.length, 2);
});

test('the single result for a duplicated URL still names every affected record', () => {
  // De-duplication must not cost the report its per-record precision, which the
  // issue requires: "Reports identify every affected record slug".
  const { targets } = extractTargets(DUPLICATE_FIXTURE);
  const alpha = targets.find((t) => t.canonical === 'https://example.test/posts/alpha');
  const report = renderReport([{ ...alpha, state: BROKEN, status: 404, hops: [], outcome: 'status' }]);

  for (const id of ['alpha-announcement', 'alpha-model-card', 'alpha-benchmarks']) {
    assert.ok(report.includes(`\`${id}\``), `report must name ${id}`);
  }
});

test('extractTargets reports a record whose url is unusable rather than dropping it', () => {
  const { targets, malformed } = extractTargets([
    { id: 'fine', url: 'https://example.test/ok' },
    { id: 'no-url', title: 'Missing' },
    { id: 'not-a-url', url: 'not a url at all' },
    { id: 'wrong-scheme', url: 'ftp://example.test/file' },
  ]);

  assert.equal(targets.length, 1);
  assert.deepEqual(
    malformed.map((entry) => entry.id),
    ['no-url', 'not-a-url', 'wrong-scheme'],
  );
});

test('extractTargets refuses a document that is not an array', () => {
  assert.throws(() => extractTargets({ sources: [] }), TypeError);
});

/* -------------------------------------------------------------------------- */
/* Classification (acceptance criterion 2)                                    */
/* -------------------------------------------------------------------------- */
//
// Each of these asserts the *specific* state. Asserting "not ok" would pass
// equally for `broken`, `blocked` and `transient`, which is precisely the
// distinction the criterion is about, so such a test would be vacuous.

test('a 200 with no redirect is ok', async () => {
  const { options } = offline(() => reply(200));
  const result = await checkTarget(target('https://example.test/a'), options);

  assert.equal(result.state, OK);
  assert.equal(result.status, 200);
});

test('a 404 is broken, not blocked', async () => {
  const { options } = offline(() => reply(404));
  const result = await checkTarget(target('https://example.test/gone'), options);

  assert.equal(result.state, BROKEN);
  assert.notEqual(result.state, BLOCKED);
});

test('a 410 is broken', async () => {
  const { options } = offline(() => reply(410));
  assert.equal((await checkTarget(target('https://example.test/gone'), options)).state, BROKEN);
});

test('a 403 that survives the GET escalation is blocked, not broken', async () => {
  // The anti-bot case. Calling this broken would put a working source into the
  // maintenance issue, which is the false positive the whole design avoids.
  const { options, calls } = offline(() => reply(403));
  const result = await checkTarget(target('https://example.test/guarded'), options);

  assert.equal(result.state, BLOCKED);
  assert.notEqual(result.state, BROKEN);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['HEAD', 'GET'],
    'a 403 to HEAD must be re-tried once as GET before being believed',
  );
});

test('a 401 is blocked', async () => {
  const { options } = offline(() => reply(401));
  assert.equal((await checkTarget(target('https://example.test/private'), options)).state, BLOCKED);
});

test('a persistent 429 settles as blocked after the full retry budget', async () => {
  const { options, calls } = offline(() => reply(429, { 'retry-after': '2' }), { attempts: 3 });
  const result = await checkTarget(target('https://example.test/busy'), options);

  assert.equal(result.state, BLOCKED);
  assert.notEqual(result.state, BROKEN);
  assert.notEqual(result.state, TRANSIENT);
  assert.equal(calls.length, 3, 'a 429 is retried up to the attempt budget');
  assert.equal(result.attempts.length, 3);
});

test('a 500 is transient, not broken', async () => {
  const { options } = offline(() => reply(500), { attempts: 2 });
  const result = await checkTarget(target('https://example.test/oops'), options);

  assert.equal(result.state, TRANSIENT);
  assert.notEqual(result.state, BROKEN);
});

test('a network error is transient and carries the error code', async () => {
  const { options } = offline(() => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNRESET' };
    throw error;
  }, { attempts: 2 });

  const result = await checkTarget(target('https://example.test/down'), options);

  assert.equal(result.state, TRANSIENT);
  assert.match(result.error.message, /ECONNRESET/);
});

test('a timeout is transient', async () => {
  const { options } = offline(() => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  }, { attempts: 1 });

  const result = await checkTarget(target('https://example.test/slow'), options);

  assert.equal(result.state, TRANSIENT);
  assert.equal(result.error.name, 'TimeoutError');
});

test('a permanent redirect to a 200 is redirected, and names where it went', async () => {
  const { options } = offline((url) =>
    url === 'https://example.test/old'
      ? reply(301, { location: 'https://example.test/new' })
      : reply(200),
  );

  const result = await checkTarget(target('https://example.test/old'), options);

  assert.equal(result.state, REDIRECTED);
  assert.notEqual(result.state, OK);
  assert.equal(result.hops.at(-1).to, 'https://example.test/new');
});

test('a 308 is a permanent redirect too', async () => {
  const { options } = offline((url) =>
    url === 'https://example.test/old' ? reply(308, { location: '/new' }) : reply(200),
  );

  assert.equal((await checkTarget(target('https://example.test/old'), options)).state, REDIRECTED);
});

test('a temporary redirect to a 200 is ok, because the recorded URL is still right', async () => {
  // The low-noise decision. `redirect: 'follow'` cannot make this distinction --
  // it renders a 302 and a 301 as the same 200 -- which is why the chain is
  // walked by hand.
  const { options } = offline((url) =>
    url === 'https://example.test/a' ? reply(302, { location: 'https://cdn.test/a' }) : reply(200),
  );

  const result = await checkTarget(target('https://example.test/a'), options);

  assert.equal(result.state, OK);
  assert.notEqual(result.state, REDIRECTED);
  assert.equal(result.hops.length, 1, 'the temporary hop is still recorded, just not reported as staleness');
});

test('a permanent redirect that lands on a 404 is broken, not redirected', async () => {
  const { options } = offline((url) =>
    url === 'https://example.test/old' ? reply(301, { location: 'https://example.test/new' }) : reply(404),
  );

  assert.equal((await checkTarget(target('https://example.test/old'), options)).state, BROKEN);
});

test('a redirect loop is reported as redirected rather than followed forever', async () => {
  const { options, calls } = offline((url) =>
    reply(302, { location: url.endsWith('/a') ? 'https://example.test/b' : 'https://example.test/a' }),
  );

  const result = await checkTarget(target('https://example.test/a'), { ...options, maxRedirects: 3 });

  assert.equal(result.state, REDIRECTED);
  assert.equal(result.outcome, 'too-many-redirects');
  assert.equal(calls.length, 4, 'the hop budget bounds the walk');
});

test('a redirect with no Location header is transient, not a finding', async () => {
  const { options } = offline(() => reply(301), { attempts: 1 });
  const result = await checkTarget(target('https://example.test/a'), options);

  assert.equal(result.state, TRANSIENT);
  assert.equal(result.outcome, 'redirect-without-location');
});

test('the four states stay distinct across one mixed run', async () => {
  // The criterion is that they remain *distinguishable*, so this asserts the set
  // of states rather than each in isolation.
  const targets = [
    target('https://a.test/gone'),
    target('https://b.test/guarded'),
    target('https://c.test/oops'),
    target('https://d.test/old'),
  ];

  const { options } = offline((url) => {
    if (url.startsWith('https://a.test')) return reply(404);
    if (url.startsWith('https://b.test')) return reply(403);
    if (url.startsWith('https://c.test')) return reply(503);
    if (url === 'https://d.test/old') return reply(301, { location: 'https://d.test/new' });
    return reply(200);
  }, { attempts: 1 });

  const results = await checkAll(targets, options);

  assert.deepEqual(
    results.map((result) => result.state),
    [BROKEN, BLOCKED, TRANSIENT, REDIRECTED],
  );
});

test('classifyStatus keeps every 4xx that is not gone out of the broken set', () => {
  for (const status of [400, 401, 402, 403, 405, 406, 409, 418, 422, 451]) {
    assert.equal(classifyStatus(status), BLOCKED, `HTTP ${status} must be blocked, not broken`);
  }
  assert.equal(classifyStatus(404), BROKEN);
  assert.equal(classifyStatus(410), BROKEN);
});

test('classifyObservation refuses to call an unfollowable redirect a finding', () => {
  assert.equal(classifyObservation({ outcome: 'redirect-location-unparseable', status: 301 }), TRANSIENT);
});

test('blocked and transient are deliberately not actionable', () => {
  assert.equal(ACTIONABLE_STATES.has(BLOCKED), false);
  assert.equal(ACTIONABLE_STATES.has(TRANSIENT), false);
  assert.equal(ACTIONABLE_STATES.has(BROKEN), true);
  assert.equal(ACTIONABLE_STATES.has(REDIRECTED), true);
});

/* -------------------------------------------------------------------------- */
/* Host path normalisation                                                    */
/* -------------------------------------------------------------------------- */

// The case this exists for, reproduced from the one measured on
// `nousresearch.com`: the host strips a trailing slash from *every* path before
// routing it, so `/releases/` 308s to `/releases` and so does a path that was
// never created. The redirect is a property of the host, and reporting it as a
// stale URL produces a finding nothing in the dataset can resolve.
const CONTROL_PATH = 'modeltree-link-health-control-does-not-exist';

/** A host that strips trailing slashes blindly, then answers the stripped path. */
function slashStrippingHost(existing) {
  return (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      return reply(308, { location: parsed.pathname.slice(0, -1) });
    }
    return reply(existing.has(parsed.pathname) ? 200 : 404);
  };
}

test('fabricateControlUrl replaces the last segment and keeps the shape', () => {
  assert.equal(
    fabricateControlUrl('https://example.test/releases/'),
    `https://example.test/${CONTROL_PATH}/`,
  );
  assert.equal(
    fabricateControlUrl('https://example.test/blog/a-post'),
    `https://example.test/blog/${CONTROL_PATH}`,
  );
  // A query is part of what a rewrite rule may key on, so the control keeps it.
  assert.equal(
    fabricateControlUrl('https://example.test/a/?v=2'),
    `https://example.test/${CONTROL_PATH}/?v=2`,
  );
  assert.equal(fabricateControlUrl('not a url'), null);
});

test('slashNormalisation names a trailing-slash rewrite and refuses everything else', () => {
  assert.equal(slashNormalisation('https://a.test/p/', 'https://a.test/p'), 'removed');
  assert.equal(slashNormalisation('https://a.test/p', 'https://a.test/p/'), 'added');

  // The narrow boundary, asserted rather than described. Each of these is just
  // as host-wide, and each stays a finding because editing the record resolves
  // it.
  assert.equal(slashNormalisation('http://a.test/p', 'https://a.test/p'), null, 'a scheme upgrade is not this');
  assert.equal(slashNormalisation('https://a.test/p', 'https://www.a.test/p'), null, 'a host rewrite is not this');
  assert.equal(slashNormalisation('https://a.test/p/', 'https://a.test/q'), null, 'a moved page is not this');
  assert.equal(slashNormalisation('https://a.test/p/?v=1', 'https://a.test/p'), null, 'a dropped query is not this');
  assert.equal(slashNormalisation('https://a.test/p', 'https://a.test/p'), null, 'nothing changed at all');
});

test('a redirect a fabricated path receives too is not a finding about the URL', async () => {
  const { options } = offline(slashStrippingHost(new Set(['/releases'])));

  const result = await checkTarget(target('https://example.test/releases/'), options);

  assert.equal(result.state, NORMALISED);
  assert.notEqual(result.state, REDIRECTED);
  assert.equal(ACTIONABLE_STATES.has(result.state), false);
  assert.equal(result.normalisation.hops[0].direction, 'removed');
  assert.equal(result.normalisation.hops[0].controlUrl, `https://example.test/${CONTROL_PATH}/`);
  assert.equal(result.normalisation.hops[0].controlTo, `https://example.test/${CONTROL_PATH}`);
});

test('a control that is answered rather than rewritten leaves the finding actionable', async () => {
  // The discriminating case. Without it the test above would pass on a checker
  // that demoted every trailing-slash redirect without ever asking the host
  // anything, which is the mechanism this whole change is built to avoid.
  const { options, calls } = offline((url) => {
    const path = new URL(url).pathname;
    if (path === '/releases/') return reply(308, { location: '/releases' });
    if (path === '/releases') return reply(200);
    // The control is answered outright rather than rewritten, so this host does
    // not strip slashes blindly and its 308 does mean something about the URL.
    return reply(404);
  });

  const result = await checkTarget(target('https://example.test/releases/'), options);

  assert.equal(result.state, REDIRECTED);
  assert.equal(result.normalisation, null);
  assert.ok(
    calls.some((call) => call.url === `https://example.test/${CONTROL_PATH}/`),
    'the control must actually have been requested',
  );
});

test('a control redirected by a different rule does not explain the finding', async () => {
  // Same shape of rewrite, different status. A host that 301s the fabricated
  // path and 308s the recorded one is not applying one blind rule to both.
  const { options } = offline((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/${CONTROL_PATH}/`) return reply(301, { location: `/${CONTROL_PATH}` });
    if (parsed.pathname === '/releases/') return reply(308, { location: '/releases' });
    return reply(parsed.pathname === '/releases' ? 200 : 404);
  });

  assert.equal((await checkTarget(target('https://example.test/releases/'), options)).state, REDIRECTED);
});

test('a control sent somewhere else entirely does not explain the finding', async () => {
  // A host that funnels unknown paths to a fixed destination is not normalising;
  // it is routing. The recorded URL's redirect still means what it says.
  const { options } = offline((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/${CONTROL_PATH}/`) return reply(308, { location: '/not-found' });
    if (parsed.pathname === '/releases/') return reply(308, { location: '/releases' });
    return reply(parsed.pathname === '/not-found' ? 404 : 200);
  });

  assert.equal((await checkTarget(target('https://example.test/releases/'), options)).state, REDIRECTED);
});

test('a scheme upgrade and a www rewrite stay actionable even though every path gets them', async () => {
  // Deliberate, not an oversight: a record can be edited to the upgraded URL and
  // the finding goes away for good, which is exactly what an actionable finding
  // is supposed to mean.
  const upgrade = offline((url) =>
    url.startsWith('http://') ? reply(301, { location: url.replace('http://', 'https://') }) : reply(200),
  );
  assert.equal((await checkTarget(target('http://example.test/p'), upgrade.options)).state, REDIRECTED);

  const www = offline((url) =>
    url.startsWith('https://example.test/')
      ? reply(308, { location: url.replace('https://example.test/', 'https://www.example.test/') })
      : reply(200),
  );
  assert.equal((await checkTarget(target('https://example.test/p'), www.options)).state, REDIRECTED);
});

test('normalisation never rescues a chain that lands on a 404', async () => {
  // `/gone/` is stripped to `/gone`, which does not exist. The host's blindness
  // is real and irrelevant: the resource is still gone.
  const { options } = offline(slashStrippingHost(new Set()));

  const result = await checkTarget(target('https://example.test/gone/'), options);

  assert.equal(result.state, BROKEN);
  assert.equal(result.normalisation, null);
});

test('a chain with one unexplained permanent hop stays actionable', async () => {
  // `/old/` -> `/old` is host normalisation; `/old` -> `/new` is a real move.
  // Explaining the first must not launder the second.
  const { options } = offline((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      return reply(308, { location: parsed.pathname.slice(0, -1) });
    }
    if (parsed.pathname === '/old') return reply(301, { location: '/new' });
    return reply(200);
  });

  assert.equal((await checkTarget(target('https://example.test/old/'), options)).state, REDIRECTED);
});

test('no control request is issued for a URL that was never going to be reported', async () => {
  // The cost control. A sweep of healthy URLs must not double its request count.
  const { options, calls } = offline(() => reply(200));

  await checkTarget(target('https://example.test/fine'), options);

  assert.deepEqual(calls.map((call) => call.url), ['https://example.test/fine']);
});

test('the control is asked once for the many URLs that fabricate the same one', async () => {
  const { options, calls } = offline(slashStrippingHost(new Set(['/a', '/b', '/c'])));

  const results = await checkAll(
    [target('https://example.test/a/'), target('https://example.test/b/'), target('https://example.test/c/')],
    options,
  );

  assert.deepEqual(results.map((result) => result.state), [NORMALISED, NORMALISED, NORMALISED]);
  assert.equal(
    calls.filter((call) => call.url === `https://example.test/${CONTROL_PATH}/`).length,
    1,
    'three redirected URLs sharing a control must ask the host once',
  );
});

test('a control that cannot be reached leaves the finding actionable', async () => {
  // Conservative on purpose: an unobtainable control is not evidence of
  // anything, and the finding was already being reported.
  const { options } = offline((url) => {
    if (url === `https://example.test/${CONTROL_PATH}/`) throw new TypeError('fetch failed');
    return new URL(url).pathname === '/releases/' ? reply(308, { location: '/releases' }) : reply(200);
  });

  assert.equal((await checkTarget(target('https://example.test/releases/'), options)).state, REDIRECTED);
});

test('a failed control is not cached, so it cannot decide the whole host', async () => {
  let controlCalls = 0;
  const { options } = offline((url) => {
    if (url === `https://example.test/${CONTROL_PATH}/`) {
      controlCalls += 1;
      if (controlCalls === 1) throw new TypeError('fetch failed');
      return reply(308, { location: `/${CONTROL_PATH}` });
    }
    const path = new URL(url).pathname;
    if (path.length > 1 && path.endsWith('/')) return reply(308, { location: path.slice(0, -1) });
    return reply(200);
  });

  const results = await checkAll([target('https://example.test/a/'), target('https://example.test/b/')], options);

  assert.deepEqual(results.map((result) => result.state), [REDIRECTED, NORMALISED]);
  assert.equal(controlCalls, 2, 'the second URL must re-ask rather than inherit the failure');
});

// The two tests below defend the *shape* of the memoisation key, which is what
// binds a measurement to the thing it measured. The control probe's whole safety
// argument is "we only suppress what we measured", and a key coarser than the
// fabricated control URL silently reattributes one directory's -- or one host's
// -- measurement to a URL nobody asked about. It fails in the unsafe direction,
// suppressing a real finding, so no other test in this file notices.
//
// Both assert on the resulting classification rather than on how the key is
// built, so a refactor of the cache is free to change its internals as long as
// the answers stay right.

test('a control cached for one directory never explains a redirect in another', async () => {
  // One host, two directories that behave differently.
  //
  //   /blind/  is rewritten without being looked at: everything under it loses a
  //            trailing slash, including a segment this tool invented. Its
  //            redirect says nothing about the URL that received it.
  //   /moved/  is routed, not rewritten. The single redirect it serves is a
  //            deliberate per-page one, so it is a real statement about that URL
  //            and the recorded URL is the thing to edit.
  //
  // Both hops are 308s in the same direction, so everything downstream of the
  // control agrees -- the only thing standing between `/moved/page/` and being
  // silenced is that it is measured on its own control rather than `/blind/`'s.
  const { options, calls } = offline((url) => {
    const path = new URL(url).pathname;

    if (path.startsWith('/blind/') && path.endsWith('/')) return reply(308, { location: path.slice(0, -1) });
    if (path === '/blind/page') return reply(200);

    if (path === '/moved/page/') return reply(308, { location: '/moved/page' });
    if (path === '/moved/page') return reply(200);

    return reply(404);
  });

  const results = await checkAll(
    [target('https://example.test/blind/page/'), target('https://example.test/moved/page/')],
    options,
  );

  assert.deepEqual(
    results.map((result) => result.state),
    [NORMALISED, REDIRECTED],
    'a real move must stay actionable however the neighbouring directory behaves',
  );
  assert.equal(results[1].normalisation, null, 'nothing was measured about /moved/, so nothing explains it');
  assert.equal(ACTIONABLE_STATES.has(results[1].state), true);

  // Diagnostic rather than a second contract: this is what "measured on its own"
  // looks like at the wire, and it names the failure when the assertion above
  // goes red.
  assert.ok(
    calls.some((call) => call.url === `https://example.test/moved/${CONTROL_PATH}/`),
    'the second directory must be asked about itself, not answered from the first',
  );
});

test('a control cached for one host never explains a redirect on another', async () => {
  // The same recorded path on two hosts, so both fabricate the same control
  // *path* and only the host tells the two measurements apart.
  //
  // A host-blind key can only be caught once one host's control is on record and
  // a second host asks: two probes that both miss the cache each answer from
  // their own measurement and agree whatever the key looks like. So this test
  // needs the recording to precede the second question, and it establishes that
  // ordering itself rather than borrowing it. The hosts are swept one after the
  // other over a cache this test owns and hands to both, so the ordering is the
  // `await` between the two calls -- a single target per sweep leaves a worker
  // pool nothing to reorder, and `DEFAULTS.concurrency`, a dropped option, or a
  // `Promise.all` rewrite cannot reach it.
  //
  // That is not an artificial arrangement: workers pick up a new host as queues
  // drain, so measuring a host against a cache some earlier host already wrote
  // to is the ordinary case in a real sweep, not the exception.
  //
  // An earlier revision instead pinned `{ concurrency: 1 }` and described the
  // ordering as a property of the fixture. It was a property of the scheduler:
  // at the default concurrency the two hosts raced, both probes missed, and
  // deleting those three tokens left the test passing over a broken key with
  // nothing to say so (#700).
  const { options, calls } = offline((url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (parsed.host === 'blind.test') {
      if (path.length > 1 && path.endsWith('/')) return reply(308, { location: path.slice(0, -1) });
      return reply(path === '/releases' ? 200 : 404);
    }

    if (path === '/releases/') return reply(308, { location: '/releases' });
    return reply(path === '/releases' ? 200 : 404);
  });

  const normalisationCache = new Map();
  const [blind] = await checkAll([target('https://blind.test/releases/')], { ...options, normalisationCache });

  // The precondition, asserted rather than assumed. With nothing recorded, the
  // second sweep has nothing to inherit and would pass over any key at all --
  // the vacuum this test exists to avoid. It asks whether a measurement was
  // recorded, never how it was keyed, so the cache stays free to change shape.
  assert.ok(normalisationCache.size > 0, 'the first host must be on record before the second host asks');
  assert.ok(
    calls.some((call) => call.url === `https://blind.test/${CONTROL_PATH}/`),
    'what that record is made of, at the wire',
  );

  const [routed] = await checkAll([target('https://routed.test/releases/')], { ...options, normalisationCache });

  assert.deepEqual(
    [blind.state, routed.state],
    [NORMALISED, REDIRECTED],
    'one host being blind says nothing about another host',
  );
  assert.equal(routed.normalisation, null);
  assert.ok(
    calls.some((call) => call.url === `https://routed.test/${CONTROL_PATH}/`),
    'the second host must be asked about itself, not answered from the first',
  );
});

test('normalised URLs are counted, reported, and kept out of the finding set', async () => {
  const { options } = offline(slashStrippingHost(new Set(['/releases'])));
  const results = await checkAll([target('https://example.test/releases/', ['nous-releases'])], options);

  const summary = summarise(results);
  assert.equal(summary.actionableUrls, 0);
  assert.equal(summary.counts[NORMALISED], 1);
  assert.deepEqual(summary.affectedRecordIds, []);

  const report = renderReport(results);
  assert.match(report, /### Host path normalisation — not actionable \(1\)/);
  assert.match(report, /this host strips a trailing slash from every path/);
  assert.ok(report.includes('`nous-releases`'), 'the report still names the affected record');
  assert.ok(
    report.includes(`https://example.test/${CONTROL_PATH}/`),
    'the report must show the control request a reader can re-run',
  );
  assert.doesNotMatch(report, /### Permanently moved/);
});

/* -------------------------------------------------------------------------- */
/* Retries, method escalation, and politeness                                 */
/* -------------------------------------------------------------------------- */

test('a 503 that clears on the second attempt reports ok', async () => {
  const { options, calls } = offline((_url, _method, index) => (index === 1 ? reply(503) : reply(200)), {
    attempts: 3,
  });

  const result = await checkTarget(target('https://example.test/flaky'), options);

  assert.equal(result.state, OK);
  assert.equal(calls.length, 2, 'it stops retrying as soon as it has a verdict');
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.state),
    [TRANSIENT, OK],
  );
});

test('a 404 is never retried, because retrying cannot change it', async () => {
  const { options, calls } = offline(() => reply(404), { attempts: 3 });
  await checkTarget(target('https://example.test/gone'), options);

  assert.equal(calls.length, 1);
});

test('backoff grows and honours a Retry-After that exceeds it', async () => {
  const { options, waits } = offline(() => reply(429, { 'retry-after': '9' }), {
    attempts: 3,
    backoffMs: 1000,
    maxBackoffMs: 30_000,
  });

  await checkTarget(target('https://example.test/busy'), options);

  // 9 seconds from the server beats the 1s and 2s exponential steps.
  assert.deepEqual(waits, [9000, 9000]);
});

test('backoff uses its own exponential step when the server suggests nothing', async () => {
  const { options, waits } = offline(() => reply(503), { attempts: 4, backoffMs: 100, maxBackoffMs: 30_000 });

  await checkTarget(target('https://example.test/oops'), options);

  assert.deepEqual(waits, [100, 200, 400]);
});

test('backoff is capped, so one hostile Retry-After cannot stall the run', async () => {
  const { options, waits } = offline(() => reply(429, { 'retry-after': '86400' }), {
    attempts: 2,
    backoffMs: 1000,
    maxBackoffMs: 5000,
  });

  await checkTarget(target('https://example.test/busy'), options);

  assert.deepEqual(waits, [5000]);
});

test('a HEAD-refusing site is judged on its GET response', async () => {
  const { options, calls } = offline((_url, method) => (method === 'HEAD' ? reply(405) : reply(200)));
  const result = await checkTarget(target('https://example.test/head-hostile'), options);

  assert.equal(result.state, OK);
  assert.equal(result.method, 'GET');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['HEAD', 'GET'],
  );
});

test('the response body is released and never read', async () => {
  // The non-goal: this checks that a URL resolves, it does not scrape what the
  // page says.
  const replies = [];
  const { options } = offline(() => {
    const response = reply(200);
    replies.push(response);
    return response;
  });

  await checkTarget(target('https://example.test/a'), options);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].bodyState.cancelled, true);
  assert.equal(replies[0].bodyState.read, false);
});

test('every request carries the descriptive user agent', async () => {
  const { options, calls } = offline(() => reply(200));
  await checkTarget(target('https://example.test/a'), options);

  assert.equal(calls[0].headers['user-agent'], DEFAULTS.userAgent);
  assert.match(calls[0].headers['user-agent'], /ModelTree/);
  assert.match(calls[0].headers['user-agent'], /github\.com/);
});

test('redirects are followed by hand, not by fetch', async () => {
  const { options, calls } = offline(() => reply(200));
  await checkTarget(target('https://example.test/a'), options);

  assert.equal(calls[0].method, 'HEAD');
  assert.equal(
    calls.length,
    1,
    'a manual walk is what lets a permanent redirect be told apart from a temporary one',
  );
});

test('one host is never asked two questions at once, and the global cap holds', async () => {
  const inFlight = new Map();
  const peakPerHost = new Map();
  let peakGlobal = 0;

  const fetchImpl = async (url) => {
    const host = new URL(url).host;
    const now = (inFlight.get(host) ?? 0) + 1;
    inFlight.set(host, now);
    peakPerHost.set(host, Math.max(peakPerHost.get(host) ?? 0, now));
    peakGlobal = Math.max(peakGlobal, [...inFlight.values()].reduce((a, b) => a + b, 0));

    await new Promise((resolve) => setTimeout(resolve, 1));

    inFlight.set(host, inFlight.get(host) - 1);
    return reply(200);
  };

  const targets = [
    ...['a', 'b', 'c'].map((p) => target(`https://busy.test/${p}`)),
    ...['a', 'b'].map((p) => target(`https://other.test/${p}`)),
    target('https://third.test/a'),
  ];

  await checkAll(targets, { fetchImpl, sleep: async () => {}, hostDelayMs: 0, concurrency: 2 });

  // The positive control. If this instrument never observed two requests in
  // flight it would also "prove" a per-host limit of one, and both zeros would
  // be the probe rather than the behaviour.
  assert.equal(peakGlobal, 2, 'the probe must actually observe concurrency, or it proves nothing');
  assert.equal(peakPerHost.get('busy.test'), 1);
  assert.equal(peakPerHost.get('other.test'), 1);
});

test('consecutive requests to one host are spaced', async () => {
  const { options, waits } = offline(() => reply(200), { hostDelayMs: 250, concurrency: 4 });
  const targets = ['a', 'b', 'c'].map((p) => target(`https://busy.test/${p}`));

  await checkAll(targets, options);

  assert.deepEqual(waits, [250, 250], 'three URLs on one host means two gaps');
});

test('results come back in the order the targets were given', async () => {
  const { options } = offline((url) => reply(url.includes('two') ? 404 : 200));
  const targets = [target('https://a.test/one'), target('https://b.test/two'), target('https://c.test/three')];

  const results = await checkAll(targets, options);

  assert.deepEqual(
    results.map((result) => result.canonical),
    targets.map((t) => t.canonical),
  );
  assert.equal(results[1].state, BROKEN);
});

/* -------------------------------------------------------------------------- */
/* Reviewed exclusions (acceptance criterion 3)                               */
/* -------------------------------------------------------------------------- */

const GOOD_EXCLUSION = {
  url: 'https://example.test/guarded',
  reason: 'Serves 403 to every non-browser client; opened by hand and confirmed present.',
  reviewedOn: '2026-01-31',
  expiresOn: '2026-07-31',
};

test('a well-formed exclusion parses', () => {
  const { entries, errors } = parseExclusions([GOOD_EXCLUSION]);

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].canonical, 'https://example.test/guarded');
});

test('an exclusion without a reason is refused', () => {
  const { errors } = parseExclusions([{ ...GOOD_EXCLUSION, reason: undefined }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reason must be at least/);
});

test('a placeholder reason is refused as firmly as a missing one', () => {
  // "Requires a reason" is satisfied by "x" under a merely-non-empty test, which
  // meets the letter of the criterion and abandons its purpose.
  for (const reason of ['x', 'TBD', 'n/a', 'blocked']) {
    const { errors } = parseExclusions([{ ...GOOD_EXCLUSION, reason }]);
    assert.equal(errors.length, 1, `"${reason}" must be refused`);
    assert.match(errors[0], /reason must be at least/);
  }
});

test('an exclusion without a review date is refused', () => {
  const { errors } = parseExclusions([{ ...GOOD_EXCLUSION, reviewedOn: undefined }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reviewedOn must be a real/);
});

test('an exclusion without an expiry is refused', () => {
  const { errors } = parseExclusions([{ ...GOOD_EXCLUSION, expiresOn: undefined }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expiresOn must be a real/);
});

test('a date that is not a real calendar day is refused', () => {
  const { errors } = parseExclusions([{ ...GOOD_EXCLUSION, reviewedOn: '2026-02-30' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reviewedOn must be a real/);
});

test('an expiry that does not follow the review is refused', () => {
  const { errors } = parseExclusions([{ ...GOOD_EXCLUSION, expiresOn: '2026-01-31' }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expiresOn must fall after reviewedOn/);
});

test('two exclusions for the same URL are refused', () => {
  const { errors } = parseExclusions([GOOD_EXCLUSION, { ...GOOD_EXCLUSION }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicates the exclusion at index 0/);
});

test('an exclusions document that is not an array is refused', () => {
  assert.deepEqual(parseExclusions({ excluded: [] }).errors, ['the exclusions document is not a JSON array']);
});

test('a live exclusion suppresses its URL and nothing else', () => {
  const targets = [target('https://example.test/guarded', ['guarded-source']), target('https://example.test/other', ['other-source'])];
  const { entries } = parseExclusions([GOOD_EXCLUSION]);

  const { checked, excluded } = applyExclusions(targets, entries, '2026-03-01');

  assert.deepEqual(
    excluded.map((result) => result.canonical),
    ['https://example.test/guarded'],
  );
  assert.equal(excluded[0].state, EXCLUDED);
  assert.deepEqual(
    checked.map((t) => t.canonical),
    ['https://example.test/other'],
  );
});

test('an expired exclusion suppresses nothing and raises a finding of its own', () => {
  const targets = [target('https://example.test/guarded', ['guarded-source'])];
  const { entries } = parseExclusions([GOOD_EXCLUSION]);

  const { checked, excluded, expired } = applyExclusions(targets, entries, '2026-08-01');

  assert.deepEqual(excluded, []);
  assert.equal(checked.length, 1, 'the URL goes back into the checked set');
  assert.equal(checked[0].expiredExclusion.expiresOn, '2026-07-31');
  assert.equal(expired.length, 1);
});

test('an exclusion expiring today still holds', () => {
  const { entries } = parseExclusions([GOOD_EXCLUSION]);
  const { excluded } = applyExclusions([target('https://example.test/guarded')], entries, '2026-07-31');

  assert.equal(excluded.length, 1);
});

test('an exclusion matching no source record is reported as housekeeping', () => {
  const { entries } = parseExclusions([GOOD_EXCLUSION]);
  const { unmatched } = applyExclusions([target('https://example.test/other')], entries, '2026-03-01');

  assert.deepEqual(
    unmatched.map((entry) => entry.canonical),
    ['https://example.test/guarded'],
  );
});

test('an expired exclusion counts as actionable in the summary', () => {
  const summary = summarise([
    { ...target('https://example.test/guarded', ['guarded-source']), state: OK, expiredExclusion: { expiresOn: '2026-07-31' } },
  ]);

  assert.equal(summary.actionableUrls, 1);
  assert.deepEqual(summary.affectedRecordIds, ['guarded-source']);
});

test('the committed exclusions file parses and is empty', () => {
  // Empty on purpose: an entry asserts that a human reviewed a URL, and no such
  // review has happened. It is read here so a malformed edit fails a test rather
  // than only a workflow run.
  const document = JSON.parse(readFileSync(resolve(HERE, 'exclusions.json'), 'utf8'));
  const { entries, errors } = parseExclusions(document);

  assert.deepEqual(errors, []);
  assert.deepEqual(entries, []);
});

/* -------------------------------------------------------------------------- */
/* Targeting a pull request                                                   */
/* -------------------------------------------------------------------------- */

test('selectChanged keeps only the URLs a change added or re-pointed', () => {
  const baseline = [
    { id: 'kept', url: 'https://example.test/kept' },
    { id: 'moved', url: 'https://example.test/before' },
  ];
  const { targets } = extractTargets([
    { id: 'kept', url: 'https://example.test/kept' },
    { id: 'moved', url: 'https://example.test/after' },
    { id: 'added', url: 'https://example.test/added' },
  ]);

  assert.deepEqual(
    selectChanged(targets, baseline).map((t) => t.canonical),
    ['https://example.test/after', 'https://example.test/added'],
  );
});

test('selectChanged keeps a URL a new record started citing', () => {
  // The URL is unchanged but the record is new, so the pull request is
  // answerable for it.
  const baseline = [{ id: 'first', url: 'https://example.test/shared' }];
  const { targets } = extractTargets([
    { id: 'first', url: 'https://example.test/shared' },
    { id: 'second', url: 'https://example.test/shared' },
  ]);

  assert.equal(selectChanged(targets, baseline).length, 1);
});

test('selectChanged against an empty baseline keeps everything', () => {
  const { targets } = extractTargets(DUPLICATE_FIXTURE);
  assert.equal(selectChanged(targets, []).length, targets.length);
});

/* -------------------------------------------------------------------------- */
/* The report (acceptance criterion 5 and the accessibility requirement)      */
/* -------------------------------------------------------------------------- */

function reportFixture() {
  return [
    { ...target('https://a.test/gone', ['alpha-announcement', 'alpha-card'], ['Alpha announced']), state: BROKEN, status: 404, hops: [], outcome: 'status' },
    { ...target('https://b.test/old', ['beta-card'], ['Beta model card']), state: REDIRECTED, status: 200, outcome: 'status', hops: [{ from: 'https://b.test/old', to: 'https://b.test/new', status: 301 }] },
    { ...target('https://c.test/guarded', ['gamma-card'], ['Gamma model card']), state: BLOCKED, status: 403, hops: [], outcome: 'status' },
    { ...target('https://d.test/oops', ['delta-card'], ['Delta model card']), state: TRANSIENT, status: 503, hops: [], outcome: 'status' },
  ];
}

test('the report names every affected record slug', () => {
  const report = renderReport(reportFixture());

  for (const id of ['alpha-announcement', 'alpha-card', 'beta-card', 'gamma-card', 'delta-card']) {
    assert.ok(report.includes(`\`${id}\``), `report must name ${id}`);
  }
});

test('the report separates the two actionable states from the two that are not', () => {
  const report = renderReport(reportFixture());

  assert.match(report, /### Definitively broken \(1\)/);
  assert.match(report, /### Permanently moved \(1\)/);
  assert.match(report, /### Refused by the site — not actionable \(1\)/);
  assert.match(report, /### No answer — not actionable \(1\)/);
});

test('every link in the report carries a descriptive label rather than the bare URL', () => {
  const report = renderReport(reportFixture());

  for (const [, text, href] of report.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    assert.notEqual(text, href, 'a link whose text is its own URL is unusable to a screen reader');
    assert.ok(text.length > 0);
  }

  assert.ok(report.includes('[Alpha announced](https://a.test/gone)'));
});

test('the report says where a permanently moved URL now points', () => {
  assert.match(renderReport(reportFixture()), /permanently redirected to https:\/\/b\.test\/new/);
});

test('the report uses headings and lists rather than a wall of URLs', () => {
  const report = renderReport(reportFixture());

  assert.match(report, /^## Source link health$/m);
  assert.match(report, /^- \[/m);
  assert.match(report, /^ {2}- Affected source records: /m);
});

test('a clean run says so in words rather than leaving an empty report', () => {
  const report = renderReport([{ ...target('https://a.test/fine', ['fine-source']), state: OK, status: 200, hops: [], outcome: 'status' }]);

  assert.match(report, /No source URL is definitively broken or permanently moved\./);
});

test('summarise counts by state and treats only the two actionable states as actionable', () => {
  const summary = summarise(reportFixture());

  assert.equal(summary.counts[BROKEN], 1);
  assert.equal(summary.counts[REDIRECTED], 1);
  assert.equal(summary.counts[BLOCKED], 1);
  assert.equal(summary.counts[TRANSIENT], 1);
  assert.equal(summary.actionableUrls, 2, 'blocked and transient must not raise a maintenance issue');
  assert.deepEqual(summary.affectedRecordIds, ['alpha-announcement', 'alpha-card', 'beta-card']);
});

test('the report names an expired exclusion and the records it covered', () => {
  const report = renderReport([
    {
      ...target('https://a.test/guarded', ['guarded-source'], ['Guarded page']),
      state: OK,
      status: 200,
      hops: [],
      outcome: 'status',
      expiredExclusion: { expiresOn: '2026-07-31', reviewedOn: '2026-01-31', reason: 'Serves 403 to non-browser clients; confirmed by hand.' },
    },
  ]);

  assert.match(report, /### Expired exclusions \(1\)/);
  assert.ok(report.includes('`guarded-source`'));
  assert.match(report, /expired 2026-07-31/);
});

test('the report lists source records whose URL could not be used at all', () => {
  const report = renderReport([], { malformed: [{ where: 'broken-record', reason: 'url is not an absolute http(s) URL' }] });

  assert.match(report, /### Source records that could not be checked \(1\)/);
  assert.ok(report.includes('`broken-record`'));
});

/* -------------------------------------------------------------------------- */
/* The committed dataset, read but never written                              */
/* -------------------------------------------------------------------------- */
//
// The dry-run extraction the issue asks for. No assertion below names a count:
// source records are being added continuously, so a size assertion would be a
// merge conflict that says nothing about correctness.

const liveSources = JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));

test('every committed source record yields a checkable target', () => {
  const { targets, malformed } = extractTargets(liveSources);

  assert.deepEqual(malformed, [], 'every source record must carry a usable absolute http(s) URL');
  assert.ok(targets.length > 0, 'a run over an empty target list would pass while checking nothing');
  assert.ok(targets.length <= liveSources.length);
});

test('extraction over the committed dataset produces well-formed targets', () => {
  const { targets } = extractTargets(liveSources);

  for (const t of targets) {
    assert.ok(t.canonical.startsWith('https://'), `${t.canonical} must be https`);
    assert.equal(t.canonical.includes('#'), false, 'the fragment is never sent, so it is dropped');
    assert.ok(t.recordIds.length > 0, `${t.canonical} must name at least one source record`);
    assert.ok(t.host.length > 0);
  }
});

test('a known committed source id survives extraction and reaches the report', () => {
  // A positive control for the two tests above. If extraction silently produced
  // nothing they would still pass on an empty list, so this pins one id that is
  // known to be in the dataset and follows it all the way to the report text.
  const { targets } = extractTargets(liveSources);
  const found = targets.find((t) => t.recordIds.includes('openai-gpt-4-1-announcement'));

  assert.ok(found, 'openai-gpt-4-1-announcement must survive extraction');
  const report = renderReport([{ ...found, state: BROKEN, status: 404, hops: [], outcome: 'status' }]);
  assert.ok(report.includes('`openai-gpt-4-1-announcement`'));
});

test('de-duplication of the committed dataset is reported, never asserted as a count', (t) => {
  // The measurement, recorded as a diagnostic rather than as an expectation.
  //
  // At the time of writing every URL in sources.json is unique, so dedupe
  // removes zero work and is exercised only by the fixtures above. Asserting
  // that number would turn correct work by another author -- two records
  // legitimately citing one announcement -- into a red build here, which is the
  // failure mode this repository's workflow README already calls out. So this
  // reports the count and asserts only what must be true for any dataset:
  // grouping never invents a target, and never loses a record.
  const { targets } = extractTargets(liveSources);
  const withUrl = liveSources.filter((s) => typeof s.url === 'string' && s.url.trim() !== '');

  t.diagnostic(
    `${withUrl.length} source records with a url -> ${targets.length} unique URLs (${withUrl.length - targets.length} deduplicated)`,
  );

  assert.ok(targets.length <= withUrl.length, 'grouping cannot produce more targets than records');
  assert.equal(
    targets.reduce((n, target) => n + target.recordIds.length, 0),
    withUrl.length,
    'every record with a url must be named by exactly one target',
  );
  assert.equal(new Set(targets.map((target) => target.canonical)).size, targets.length, 'targets must be distinct');
});

/* -------------------------------------------------------------------------- */
/* The command line                                                           */
/* -------------------------------------------------------------------------- */

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
}

test('the CLI dry run extracts the committed dataset without touching the network', () => {
  const run = runCli(['--dry-run']);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /## Source link health — extraction dry run/);
  assert.match(run.stdout, /unique URL\(s\)/);
  assert.ok(run.stdout.includes('openai-gpt-4-1-announcement'));
});

test('the CLI refuses an unknown flag rather than ignoring it', () => {
  const run = runCli(['--force']);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown flag --force/);
});

test('the CLI refuses a flag whose value is missing', () => {
  const run = runCli(['--baseline']);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /--baseline needs a value/);
});

test('the CLI refuses to write its output inside the dataset', () => {
  // Structural rather than conventional: the tool reads source records and must
  // not be able to write one, `lastCheckedDate` included.
  const run = runCli(['--dry-run', '--json', 'web/src/data/link-health.json']);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /never mutates the dataset/);
});

test('the CLI offers no data, exclusions, or today override', () => {
  const source = readFileSync(CLI, 'utf8');
  const flags = [...source.matchAll(/flag === '(--[a-z-]+)'/g)].map((match) => match[1]);

  for (const forbidden of ['--data', '--exclusions', '--today', '--skip', '--skip-gates', '--force']) {
    assert.equal(flags.includes(forbidden), false, `${forbidden} would let a caller check something easier`);
  }

  assert.ok(flags.includes('--dry-run'));
  assert.ok(flags.includes('--baseline'));
});
