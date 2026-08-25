#!/usr/bin/env node
// Deterministic gates over a refresh run's claim bundle, before any of it
// reaches `web/src/data`. Where `gate-dataset.mjs` asks "is the resulting
// dataset coherent", this asks "was this claim actually established".
//
// It is the mechanical half of the source policy: it cannot judge whether a
// quote supports a claim, but it can refuse a claim that has no quote, no
// fetched page, no hash, or a review that never reached a majority. Search
// snippets are refused here, by contract, rather than by anyone remembering.
//
// Usage:
//   node gate-evidence.mjs --claims <path> [--today YYYY-MM-DD] [--json]
//
// Exit 0 = every claim in the bundle is admissible. Exit 1 = at least one is
// not. Exit 2 = the runner could not run, which is never treated as a pass.
//
// Bundle contract (see ../reference/claim-bundle.md):
//   { "runId": "...", "creator": "...", "policy": "pilot" | "long-tail",
//     "claims": [ { id, kind, collection, targetId, field?, currentValue,
//                   proposedValue, statement, evidence: [...], verdicts: [...] } ] }

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The three rubrics from #59's review panel. A bundle must carry exactly these,
// once each: a panel missing a rubric has not been independently reviewed, and
// a panel carrying one twice has counted one reviewer's opinion as two.
const REQUIRED_REVIEWERS = ['provenance', 'consistency', 'editorial'];

// A pilot creator's claim needs 2 of 3. A long-tail creator is a creator nobody
// has written a reviewed profile for, so #59 and ADR 0002 require unanimity.
const THRESHOLDS = { pilot: 2, 'long-tail': 3 };

const VALID_KINDS = ['add', 'change', 'remove', 'unchanged', 'conflict'];
const VALID_COLLECTIONS = [
  'sources', 'publishers', 'organizations', 'families', 'releases',
  'usageObservations', 'usageSyntheses', 'modelFitStatements', 'modelFitEvidenceGaps',
];

// A quote short enough to be a coincidence is not corroboration.
const MINIMUM_QUOTE_LENGTH = 24;

const FORBIDDEN_HOSTS = [/^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/i, /\.local$/i, /\.internal$/i];

const failures = [];

function fail(gate, message, where) {
  failures.push({ gate, message, where });
}

function parseArgs(argv) {
  const args = { claims: null, today: null, json: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--claims') args.claims = argv[++i];
    else if (flag === '--today') args.today = argv[++i];
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`gate-evidence: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function startOf(value) {
  const [y, m = 1, d = 1] = String(value).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// Gate: the evidence behind a claim was actually retrieved.
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
    // field that must say `fetch` and a hash that proves something was read.
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
        `contentHash "${item.contentHash ?? 'missing'}" is not a sha256:<64 hex> digest of the fetched page`,
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
    process.stdout.write('usage: gate-evidence.mjs --claims <path> [--today YYYY-MM-DD] [--json]\n');
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

  // Required, never defaulted. An absent policy is refused exactly as an
  // unknown one is: the field is self-reported by the agent this gate exists to
  // check, so treating silence as the *looser* threshold would let a long-tail
  // claim publish on a pilot majority it never had to reach. Do not infer it
  // from `creator` either -- inference is the same defect wearing a heuristic.
  if (!Object.hasOwn(bundle, 'policy')) {
    process.stderr.write('gate-evidence: bundle has no policy; expected pilot or long-tail (it is never defaulted)\n');
    return 2;
  }
  const policy = bundle.policy;
  if (!Object.hasOwn(THRESHOLDS, policy)) {
    process.stderr.write(`gate-evidence: unknown policy "${policy}"; expected pilot or long-tail\n`);
    return 2;
  }
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

process.exit(main());
