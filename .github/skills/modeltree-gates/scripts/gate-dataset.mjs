#!/usr/bin/env node
// Deterministic dataset gates. These run AFTER semantic review and cannot be
// outvoted by it (ADR 0003). Everything here is mechanical: no model, no
// network, no judgement. A check belongs in this file only if a wrong answer
// is provably wrong from the data alone.
//
// This is the skill set's own implementation. `tools/updater` has a parallel
// one in `gates.py` that this deliberately does not share, on the maintainer's
// instruction that #59's subsystem stay untouched. ADR 0003 records that drift
// as an accepted cost; if you change a rule here, say in the pull request how
// it relates to the Python side.
//
// Usage:
//   node gate-dataset.mjs [--data <dir>] [--today YYYY-MM-DD] [--json]
//
// Exit 0 = every gate passed. Exit 1 = at least one gate failed. Exit 2 = the
// gate runner itself could not run, which is never treated as a pass.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The dataset documents, exactly as `web/src/data/raw.ts` composes them. This
// list is also the qualifying class in ADR 0003: a refresh may touch these and
// nothing else.
const DOCUMENTS = {
  sources: 'sources.json',
  publishers: 'publishers.json',
  organizations: 'organizations.json',
  families: 'families.json',
  releases: 'releases.json',
  usageObservations: 'usage-observations.json',
  usageSyntheses: 'usage-syntheses.json',
  modelFitStatements: 'model-fit-statements.json',
  modelFitEvidenceGaps: 'model-fit-evidence-gaps.json',
};

// Field names that would express a composite or universal ranking. The product
// forbids one outright and #67 is blocked pending a decision, so the cheapest
// enforcement is to refuse the vocabulary anywhere in the dataset. Matched
// against whole key names and their camelCase segments.
const RANKING_WORDS = [
  'score', 'scores', 'rank', 'ranking', 'rankings', 'rating', 'ratings',
  'overall', 'composite', 'popularity', 'leaderboard', 'grade', 'tier',
  'percentile', 'index',
];

// Hosts that can never stand behind a public fact.
const FORBIDDEN_HOSTS = [/^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/i, /\.local$/i, /\.internal$/i];

const failures = [];
const counts = {};

function fail(gate, message, where) {
  failures.push({ gate, message, where });
}

function parseArgs(argv) {
  const args = { data: null, today: null, json: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--data') args.data = argv[++i];
    else if (flag === '--today') args.today = argv[++i];
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`gate-dataset: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

/** The repository root, found from this script's own location. */
function repoRoot() {
  // .github/skills/modeltree-gates/scripts/gate-dataset.mjs -> up five.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isRealPartialDate(value) {
  if (typeof value !== 'string' || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m !== undefined && (m < 1 || m > 12)) return false;
  if (d === undefined) return true;
  return isRealDate(value);
}

/** Compares dates of possibly different precision by their earliest instant. */
function startOf(value) {
  const [y, m = 1, d = 1] = String(value).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// Gate: every document parses and is an array of objects carrying a string id.
// ---------------------------------------------------------------------------
function loadDocuments(dataDir) {
  const loaded = {};
  for (const [name, file] of Object.entries(DOCUMENTS)) {
    const path = join(dataDir, file);
    if (!existsSync(path)) {
      fail('well-formed', 'dataset document is missing', file);
      loaded[name] = [];
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      fail('well-formed', `is not valid JSON: ${error.message}`, file);
      loaded[name] = [];
      continue;
    }
    if (!Array.isArray(parsed)) {
      fail('well-formed', 'must be a JSON array', file);
      loaded[name] = [];
      continue;
    }
    parsed.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        fail('well-formed', `entry ${index} is not an object`, file);
      }
    });
    loaded[name] = parsed.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
    counts[name] = loaded[name].length;
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Gate: ids are well formed and unique within their collection.
//
// Deliberately NOT checked: that an id is unique *across* collections. Sharing
// one is normal and meaningful here. A single-release family carries the family
// name, so `openai-gpt-5` names both; and a publisher that is the official
// voice of a creator takes that creator's id on purpose. References are typed
// by field name, so neither is ambiguous. What is checked instead is the case
// where a shared id would mislead: see the publisher rule below.
// ---------------------------------------------------------------------------
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function gateIdentity(docs) {
  const seenPerCollection = {};
  for (const [name, entries] of Object.entries(docs)) {
    const seen = new Set();
    entries.forEach((entry, index) => {
      const id = entry.id;
      if (typeof id !== 'string' || id.length === 0) {
        fail('identity', `entry ${index} has no string id`, name);
        return;
      }
      if (!ID_PATTERN.test(id)) {
        fail('identity', `id "${id}" is not lowercase-kebab-case`, name);
      }
      if (seen.has(id)) fail('identity', `id "${id}" appears more than once`, name);
      seen.add(id);
    });
    seenPerCollection[name] = seen;
  }

  // A publisher that takes a creator's id must be that creator's voice. The
  // collision is fine when asserted and misleading when not: an unrelated
  // publisher squatting on "openai" would read as OpenAI speaking.
  const organizationIds = seenPerCollection.organizations ?? new Set();
  for (const publisher of docs.publishers) {
    if (organizationIds.has(publisher.id) && publisher.organizationId !== publisher.id) {
      fail(
        'entity-boundary',
        `publisher takes the id of organization "${publisher.id}" without declaring organizationId "${publisher.id}", so it reads as that creator's own voice without being it`,
        `publishers:${publisher.id}`,
      );
    }
  }

  return seenPerCollection;
}

// ---------------------------------------------------------------------------
// Gate: every id reference resolves to something that exists.
// ---------------------------------------------------------------------------
function gateReferences(docs, ids) {
  const check = (collection, entry, field, value, target) => {
    if (value === undefined || value === null) return;
    const set = ids[target] ?? new Set();
    if (!set.has(value)) {
      fail('references', `${field} "${value}" does not resolve to a ${target.replace(/s$/, '')}`, `${collection}:${entry.id}`);
    }
  };
  const checkList = (collection, entry, field, target) => {
    const list = entry[field];
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      fail('references', `${field} must be an array`, `${collection}:${entry.id}`);
      return;
    }
    list.forEach((value) => check(collection, entry, field, value, target));
  };

  for (const source of docs.sources) {
    check('sources', source, 'publisherId', source.publisherId, 'publishers');
  }
  for (const publisher of docs.publishers) {
    check('publishers', publisher, 'organizationId', publisher.organizationId, 'organizations');
    if (publisher.control) {
      check('publishers', publisher, 'control.parentId', publisher.control.parentId, 'publishers');
      (publisher.control.sourceIds ?? []).forEach((value) => check('publishers', publisher, 'control.sourceIds', value, 'sources'));
      if (publisher.control.parentId === publisher.id) {
        fail('lineage', 'a publisher cannot be its own parent', `publishers:${publisher.id}`);
      }
    }
  }
  for (const organization of docs.organizations) {
    checkList('organizations', organization, 'sourceIds', 'sources');
  }
  for (const family of docs.families) {
    check('families', family, 'organizationId', family.organizationId, 'organizations');
    checkList('families', family, 'sourceIds', 'sources');
  }
  for (const release of docs.releases) {
    check('releases', release, 'organizationId', release.organizationId, 'organizations');
    check('releases', release, 'familyId', release.familyId, 'families');
    checkList('releases', release, 'sourceIds', 'sources');
    for (const field of ['predecessorIds', 'successorIds', 'siblingIds', 'derivedFromIds']) {
      checkList('releases', release, field, 'releases');
    }
  }
  for (const observation of docs.usageObservations) {
    check('usageObservations', observation, 'releaseId', observation.releaseId, 'releases');
    checkList('usageObservations', observation, 'sourceIds', 'sources');
    checkList('usageObservations', observation, 'conflictsWithIds', 'usageObservations');
  }
  for (const synthesis of docs.usageSyntheses) {
    check('usageSyntheses', synthesis, 'releaseId', synthesis.releaseId, 'releases');
    checkList('usageSyntheses', synthesis, 'observationIds', 'usageObservations');
    checkList('usageSyntheses', synthesis, 'sourceIds', 'sources');
  }
  for (const statement of docs.modelFitStatements) {
    checkList('modelFitStatements', statement, 'sourceIds', 'sources');
    if (statement.releaseId !== undefined) {
      check('modelFitStatements', statement, 'releaseId', statement.releaseId, 'releases');
    }
    if (statement.familyId !== undefined) {
      check('modelFitStatements', statement, 'familyId', statement.familyId, 'families');
    }
  }
  for (const gap of docs.modelFitEvidenceGaps) {
    if (gap.releaseId !== undefined) check('modelFitEvidenceGaps', gap, 'releaseId', gap.releaseId, 'releases');
    if (gap.familyId !== undefined) check('modelFitEvidenceGaps', gap, 'familyId', gap.familyId, 'families');
  }
}

// ---------------------------------------------------------------------------
// Gate: lineage. Self-reference, contradictory direction, and cycles.
// ---------------------------------------------------------------------------
function gateLineage(docs) {
  const byId = new Map(docs.releases.map((release) => [release.id, release]));

  for (const release of docs.releases) {
    for (const field of ['predecessorIds', 'successorIds', 'siblingIds', 'derivedFromIds']) {
      const list = Array.isArray(release[field]) ? release[field] : [];
      if (list.includes(release.id)) {
        fail('lineage', `${field} contains the release itself`, `releases:${release.id}`);
      }
      if (new Set(list).size !== list.length) {
        fail('lineage', `${field} lists the same release twice`, `releases:${release.id}`);
      }
    }

    // A release cannot both precede and succeed the same release.
    const predecessors = new Set(release.predecessorIds ?? []);
    const successors = new Set(release.successorIds ?? []);
    for (const successor of successors) {
      if (predecessors.has(successor)) {
        fail('lineage', `"${successor}" is listed as both predecessor and successor`, `releases:${release.id}`);
      }
    }

    // Nor can it be a sibling of its own ancestor or descendant.
    for (const sibling of release.siblingIds ?? []) {
      if (predecessors.has(sibling) || successors.has(sibling)) {
        fail('lineage', `"${sibling}" is both a sibling and a lineage neighbour`, `releases:${release.id}`);
      }
    }

    // Declared direction must agree where the other side speaks.
    for (const predecessorId of predecessors) {
      const predecessor = byId.get(predecessorId);
      if (predecessor && (predecessor.predecessorIds ?? []).includes(release.id)) {
        fail('lineage', `"${predecessorId}" and this release each claim to precede the other`, `releases:${release.id}`);
      }
    }
  }

  // No cycles in the predecessor graph. A model cannot descend from itself.
  const state = new Map();
  const walk = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      fail('lineage', `predecessor cycle: ${[...trail, id].join(' -> ')}`, `releases:${id}`);
      return;
    }
    state.set(id, 'open');
    for (const next of byId.get(id)?.predecessorIds ?? []) {
      if (byId.has(next)) walk(next, [...trail, id]);
    }
    state.set(id, 'done');
  };
  for (const release of docs.releases) walk(release.id, []);

  // A release must belong to its family's organization. Attributing a model to
  // a family owned by someone else is the entity-boundary failure that matters
  // most here, because it silently reassigns authorship.
  const familyById = new Map(docs.families.map((family) => [family.id, family]));
  for (const release of docs.releases) {
    const family = familyById.get(release.familyId);
    if (family && family.organizationId !== release.organizationId) {
      fail(
        'entity-boundary',
        `release is attributed to "${release.organizationId}" but its family "${family.id}" belongs to "${family.organizationId}"`,
        `releases:${release.id}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Gate: dates. Impossible dates, and dates that claim the future.
// ---------------------------------------------------------------------------
const EXACT_DATE_FIELDS = ['verifiedAt', 'releaseDate', 'firstReleaseDate', 'lastCheckedDate', 'publishedDate', 'effectiveFrom', 'effectiveTo'];
const PARTIAL_DATE_FIELDS = ['windowStart', 'windowEnd', 'evaluationDate'];

function gateDates(docs, today) {
  const todayMs = startOf(today);

  const inspect = (collection, entry) => {
    for (const field of EXACT_DATE_FIELDS) {
      const value = entry[field];
      if (value === undefined) continue;
      if (!isRealDate(value)) {
        fail('dates', `${field} "${value}" is not a real YYYY-MM-DD date`, `${collection}:${entry.id}`);
        continue;
      }
      if (startOf(value) > todayMs) {
        fail('dates', `${field} "${value}" is in the future (today is ${today})`, `${collection}:${entry.id}`);
      }
    }
    for (const field of PARTIAL_DATE_FIELDS) {
      const value = entry[field];
      if (value === undefined) continue;
      if (!isRealPartialDate(value)) {
        fail('dates', `${field} "${value}" is not a real date`, `${collection}:${entry.id}`);
      } else if (startOf(value) > todayMs) {
        fail('dates', `${field} "${value}" is in the future (today is ${today})`, `${collection}:${entry.id}`);
      }
    }
    if (entry.control?.verifiedAt !== undefined) {
      if (!isRealDate(entry.control.verifiedAt)) {
        fail('dates', `control.verifiedAt "${entry.control.verifiedAt}" is not a real date`, `${collection}:${entry.id}`);
      } else if (startOf(entry.control.verifiedAt) > todayMs) {
        fail('dates', `control.verifiedAt "${entry.control.verifiedAt}" is in the future`, `${collection}:${entry.id}`);
      }
    }
  };

  for (const [collection, entries] of Object.entries(docs)) {
    for (const entry of entries) inspect(collection, entry);
  }

  // You cannot check a page before it was published.
  for (const source of docs.sources) {
    if (isRealDate(source.publishedDate) && isRealDate(source.lastCheckedDate)
      && startOf(source.lastCheckedDate) < startOf(source.publishedDate)) {
      fail('dates', `lastCheckedDate "${source.lastCheckedDate}" precedes publishedDate "${source.publishedDate}"`, `sources:${source.id}`);
    }
  }

  // A release cannot predate the family it belongs to.
  const familyById = new Map(docs.families.map((family) => [family.id, family]));
  for (const release of docs.releases) {
    const family = familyById.get(release.familyId);
    if (family && isRealDate(release.releaseDate) && isRealDate(family.firstReleaseDate)
      && startOf(release.releaseDate) < startOf(family.firstReleaseDate)) {
      fail(
        'dates',
        `releaseDate "${release.releaseDate}" precedes its family's firstReleaseDate "${family.firstReleaseDate}"`,
        `releases:${release.id}`,
      );
    }
  }

  // A release cannot be published before the model it descends from.
  const releaseById = new Map(docs.releases.map((release) => [release.id, release]));
  for (const release of docs.releases) {
    for (const field of ['predecessorIds', 'derivedFromIds']) {
      for (const ancestorId of release[field] ?? []) {
        const ancestor = releaseById.get(ancestorId);
        if (!ancestor) continue;
        if (isRealDate(release.releaseDate) && isRealDate(ancestor.releaseDate)
          && startOf(release.releaseDate) < startOf(ancestor.releaseDate)) {
          fail(
            'dates',
            `releaseDate "${release.releaseDate}" precedes ${field.replace(/Ids$/, '')} "${ancestorId}" (${ancestor.releaseDate})`,
            `releases:${release.id}`,
          );
        }
      }
    }
  }

  // A measurement window cannot end before it starts.
  for (const observation of docs.usageObservations) {
    if (isRealPartialDate(observation.windowStart) && isRealPartialDate(observation.windowEnd)
      && startOf(observation.windowEnd) < startOf(observation.windowStart)) {
      fail('dates', `windowEnd "${observation.windowEnd}" precedes windowStart "${observation.windowStart}"`, `usageObservations:${observation.id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Gate: URLs. A source URL is the evidence; a malformed one is not evidence.
// ---------------------------------------------------------------------------
function gateUrls(docs) {
  const inspect = (collection, id, field, value) => {
    if (value === undefined || value === null) return;
    let url;
    try {
      url = new URL(value);
    } catch {
      fail('urls', `${field} "${value}" is not a valid URL`, `${collection}:${id}`);
      return;
    }
    if (url.protocol !== 'https:') {
      fail('urls', `${field} "${value}" is not https`, `${collection}:${id}`);
    }
    if (url.username || url.password) {
      fail('urls', `${field} "${value}" carries embedded credentials`, `${collection}:${id}`);
    }
    if (FORBIDDEN_HOSTS.some((pattern) => pattern.test(url.hostname))) {
      fail('urls', `${field} host "${url.hostname}" cannot stand behind a public fact`, `${collection}:${id}`);
    }
  };

  for (const source of docs.sources) inspect('sources', source.id, 'url', source.url);
  for (const organization of docs.organizations) {
    inspect('organizations', organization.id, 'website', organization.website);
    inspect('organizations', organization.id, 'releasePage', organization.releasePage);
  }
  for (const release of docs.releases) {
    if (release.license?.url) inspect('releases', release.id, 'license.url', release.license.url);
  }
}

// ---------------------------------------------------------------------------
// Gate: evidence. Every fact carries a primary source and a verification date.
// Not redundant with Zod: the schema requires the fields to be present, this
// requires them to be non-empty and to point somewhere real.
// ---------------------------------------------------------------------------
const SOURCED_COLLECTIONS = ['organizations', 'families', 'releases', 'usageObservations', 'usageSyntheses', 'modelFitStatements'];

function gateEvidence(docs) {
  for (const collection of SOURCED_COLLECTIONS) {
    for (const entry of docs[collection] ?? []) {
      const sourceIds = entry.sourceIds;
      if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
        fail('evidence', 'carries no sourceIds, so it states a fact with no primary source', `${collection}:${entry.id}`);
      }
      if (!isRealDate(entry.verifiedAt)) {
        fail('evidence', 'carries no usable verifiedAt', `${collection}:${entry.id}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Gate: no composite score. ADR 0003 guardrail, enforced as vocabulary.
// ---------------------------------------------------------------------------
function gateNoRanking(docs) {
  const segments = (key) => key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((part) => part.toLowerCase());

  const walk = (value, path, collection, id) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, collection, id));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (segments(key).some((part) => RANKING_WORDS.includes(part))) {
        fail(
          'no-composite-score',
          `field "${here}" reads as a ranking or composite score, which this product does not publish (see #67)`,
          `${collection}:${id}`,
        );
      }
      walk(child, here, collection, id);
    }
  };

  for (const [collection, entries] of Object.entries(docs)) {
    for (const entry of entries) walk(entry, '', collection, entry.id);
  }
}

// ---------------------------------------------------------------------------
// Gate: the dataset is not wholesale empty.
//
// Every other gate here is satisfied by an empty set: it has no dangling
// references, no duplicate ids, no out-of-range dates. That makes a broken
// generator that writes nine structurally valid but empty documents invisible
// to coherence checking, while it silently wipes the dataset. ADR 0003 lets an
// agent-gated refresh auto-merge, so this gate is the floor that stops a green
// run from taking the live data to zero (see #185).
//
// This is a floor, not a fixed count: it refuses only the all-empty case. A
// non-empty tree is accepted exactly as before, so `usage-syntheses.json` being
// legitimately empty today does not trip it. That is why the rule is "some
// document has a record", not "every document does".
// ---------------------------------------------------------------------------
function gateNonEmpty(docs) {
  const total = Object.values(docs).reduce((sum, entries) => sum + entries.length, 0);
  if (total === 0) {
    fail(
      'non-empty',
      'expected at least one record across the nine documents, found 0 (a wholesale-empty dataset)',
      'dataset',
    );
  }
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('usage: gate-dataset.mjs [--data <dir>] [--today YYYY-MM-DD] [--json]\n');
    return 0;
  }

  const dataDir = args.data ? resolve(args.data) : join(repoRoot(), 'web', 'src', 'data');
  if (!existsSync(dataDir)) {
    process.stderr.write(`gate-dataset: no data directory at ${dataDir}\n`);
    return 2;
  }

  const today = args.today ?? new Date().toISOString().slice(0, 10);
  if (!isRealDate(today)) {
    process.stderr.write(`gate-dataset: --today "${today}" is not a real date\n`);
    return 2;
  }

  const docs = loadDocuments(dataDir);
  gateNonEmpty(docs);
  const ids = gateIdentity(docs);
  gateReferences(docs, ids);
  gateLineage(docs);
  gateDates(docs, today);
  gateUrls(docs);
  gateEvidence(docs);
  gateNoRanking(docs);

  if (args.json) {
    // `dataDir`, not `repo`: this gate resolves a directory of documents from
    // `--data <dir>`, runs no git, and has no repository root to name. The three
    // gates that do resolve one report it as `repo`; this one names what it
    // actually opened, which is the fact a reader needs here. The four spellings
    // were reconciled to those two in #381 rather than to one.
    process.stdout.write(`${JSON.stringify({ dataDir, today, counts, passed: failures.length === 0, failures }, null, 2)}\n`);
  } else if (failures.length === 0) {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    process.stdout.write(`gate-dataset: all gates passed over ${total} records in ${dataDir}\n`);
  } else {
    process.stdout.write(`gate-dataset: ${failures.length} failure(s)\n`);
    for (const failure of failures) {
      process.stdout.write(`  [${failure.gate}] ${failure.where}: ${failure.message}\n`);
    }
  }

  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
