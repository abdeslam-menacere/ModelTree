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
  // A flag whose value is missing is refused here rather than carried onward as
  // `undefined`, because every consumer below turns `undefined` into a default:
  // `--data` falls back to this repository's own `web/src/data` at main() and
  // `--today` falls back to the wall clock. Either substitution gates an input
  // the caller never named and exits 0 -- a green verdict about something else,
  // which is the one failure this gate set exists to prevent (#372). An empty
  // string is the same defect arriving without anyone typing a malformed
  // command: PowerShell strips embedded double quotes from native-command
  // arguments, so `--data ""` reaches here as a value-less flag.
  //
  // This is a fourth copy of the closure `gate-scope.mjs` and
  // `gate-source-approval.mjs` already carry, not an import, and deliberately
  // so: these four scripts share no module and import only `node:` builtins, the
  // same reason `PUBLISHED_REF` is duplicated between two of them on purpose.
  // The idiom is copied verbatim rather than varied -- a third parsing style is
  // what #168 is open on.
  const value = (i, flag) => {
    const next = argv[i];
    if (typeof next !== 'string' || next.length === 0) {
      process.stderr.write(`gate-dataset: ${flag} needs a value\n`);
      process.exit(2);
    }
    return next;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--data') args.data = value(++i, '--data');
    else if (flag === '--today') args.today = value(++i, '--today');
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

/**
 * The latest instant a date could denote, mirroring `startOf`.
 *
 * `2026` ends on 31 December 2026 and `2026-03` on 31 March, so together the two
 * helpers make a partial date the closed interval of days it actually denotes.
 * An ordering check can then ask whether two dates are *definitely* out of
 * order, rather than whether one string happens to sort below another. For a
 * full `YYYY-MM-DD` value the interval is a single day and `endOf` equals
 * `startOf`, so every check below is unchanged for day-precision data.
 */
function endOf(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  if (d !== undefined) return Date.UTC(y, m - 1, d);
  // Day 0 of the following month is the last day of this one.
  if (m !== undefined) return Date.UTC(y, m, 0);
  return Date.UTC(y, 11, 31);
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
// Gate: every family is pointed at by at least one release.
//
// This is the *reverse* of every other `familyId` check in this file, and the
// direction is the whole point. The three checks above and below all run
// release -> family: `gateReferences` asserts a release's `familyId` resolves,
// the entity-boundary rule asserts the family it resolves to shares its owner,
// and the date rule asserts it does not predate that family. Each starts from a
// release. None starts from a family, so a family that no release points at was
// not merely unchecked here -- it was *unreachable* by this gate as written, and
// no amount of data could have made it fire (#441).
//
// The state is not hypothetical. PR #417 added seven families and gave all
// seven zero releases; `npm run validate`, `web-ci` and the Pages deploy all
// stayed green, and `web/src/lib/model-tree.ts` dropped them with
// `.filter(({ releases }) => releases.length > 0)`, so the published tree went
// quietly smaller than the dataset claimed. Nothing was malformed. That is the
// "well-formed but wrong" residual ADR 0003 names, arriving through a direction
// the gates could not see.
//
// REFUSE rather than RENDER EXPLICITLY, decided rather than defaulted into
// (#441 AC2). Both were defensible and they are not equivalent, so the reason
// is recorded here rather than left to be re-derived:
//
//   Rendering an empty family explicitly is the option that matches this
//   project's rule that unknown data stays explicit instead of being smoothed
//   over, and it is the better option *if* the dataset can say that a family is
//   deliberately awaiting its first release. It cannot. `lifecycleStatus` in
//   `web/src/data/schema.ts` is exactly
//   `['preview', 'current', 'legacy', 'deprecated', 'research']` -- there is no
//   `announced`, `upcoming` or `unreleased` member -- and the doc comment above
//   it states that the absence of an escape hatch is deliberate, that a record
//   which cannot be mapped is withheld rather than guessed, and in as many
//   words that "a tree branch rendering rows of blanks is not a fact this
//   dataset states".
//
//   So an announced-but-unreleased family and a data error are byte-for-byte
//   indistinguishable in this dataset. Rendering the empty case would therefore
//   publish bugs on /tree/ with the site's authority behind them, presented
//   exactly as legitimate announcements -- worse than dropping them silently,
//   because it makes an error look like a fact. The seven families #417
//   introduced were a side effect, not announcements.
//
// The reasoning rests on that absent vocabulary, so it is conditional and says
// so: if a genuinely announced family ever needs recording, the honest fix is
// to add a lifecycle member deliberately, in its own issue, with the rendering
// that goes with it -- and to revisit this gate at the same time. Adding one
// here would have been the escape hatch the schema refuses.
//
// Stated as coverage rather than as a count: "every family is referenced by
// some release", never "there are N families". A dataset that grows keeps
// passing, and the rule holds for any dataset rather than for the one that
// happens to exist today.
// ---------------------------------------------------------------------------
function gateFamilyHasRelease(docs) {
  const referenced = new Set();
  for (const release of docs.releases) {
    // Only a usable reference counts: treating a non-string `familyId` as
    // coverage would let a malformed release vouch for a family it cannot
    // actually name.
    //
    // Which gate then reports that release is measured, not assumed, and it
    // splits by value (#441 QA). For `null` or `undefined`, this rule is the
    // *only* in-gate signal: `gateReferences`' `check()` returns early on
    // exactly those two values, and `well-formed` checks document shape and
    // that each entry is an object, never the type of a field -- so neither
    // sees it, the family simply goes uncovered, and it is named here. Zod
    // rejects it independently at `npm run validate`, since `familyId` is a
    // required `entityId` (`z.string()`), but that is outside this script.
    // For any other non-string -- a number, say -- `references` fires too,
    // because `check()` does run and the id set holds only strings.
    //
    // That early-return is pre-existing and deliberately left alone: #441 adds
    // the family-side rule and does not repair the release-side check.
    if (typeof release.familyId === 'string') referenced.add(release.familyId);
  }
  for (const family of docs.families) {
    if (!referenced.has(family.id)) {
      fail(
        'family-has-release',
        'no release belongs to this family, so the build contradicts itself: /tree/ drops the family '
          + '(model-tree.ts filters out families with no releases) while the homepage still counts it '
          + 'and renders it as an empty branch, so one page hides the error and the other publishes it '
          + '(the dataset cannot express "announced but unreleased", so this is a data error rather '
          + 'than a fact)',
        `families:${family.id}`,
      );
    }
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
// Dates *we* recorded. We were the observer, so the day is always known and
// anything less than a full calendar date is a mistake rather than a limit of
// the source.
const EXACT_DATE_FIELDS = ['verifiedAt', 'lastCheckedDate', 'publishedDate', 'effectiveFrom', 'effectiveTo'];
// Dates a *source* stated, which it may have stated only to the year or month.
// `releaseDate` and `firstReleaseDate` moved here from `EXACT_DATE_FIELDS`: a
// creator whose announcement gives only a month was previously unrecordable,
// since the only way past this gate was to invent a day. The precision-agreement
// rule below is what replaces the constraint that move gives up — it is not
// enough to be partial, the record must also declare the same precision it
// carries, which the exact-date rule could not express at all.
const PARTIAL_DATE_FIELDS = ['windowStart', 'windowEnd', 'evaluationDate', 'releaseDate', 'firstReleaseDate'];

const PRECISION_SEGMENTS = { year: 1, month: 2, day: 3 };

// Date fields that carry a `datePrecision` companion stating how much of the
// date the source actually gave. The value's own shape states the same thing, so
// the two are required to agree: a record claiming `month` while carrying a full
// day has invented that day, and one claiming `day` while carrying only a month
// has lost one. Either way a reader downstream cannot tell which part is
// sourced, so both are refused here.
const PRECISION_COMPANIONS = [
  ['releaseDate', 'datePrecision'],
  ['firstReleaseDate', 'datePrecision'],
  ['date', 'datePrecision'],
];

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
    for (const [field, companion] of PRECISION_COMPANIONS) {
      const value = entry[field];
      const declared = entry[companion];
      if (value === undefined || declared === undefined) continue;
      // A malformed value is already reported above; reporting it twice would
      // only make the real fault harder to find.
      if (!isRealPartialDate(value)) continue;
      if (!Object.hasOwn(PRECISION_SEGMENTS, declared)) {
        fail('dates', `${companion} "${declared}" is not one of year, month, day`, `${collection}:${entry.id}`);
        continue;
      }
      const carried = String(value).split('-').length;
      if (carried !== PRECISION_SEGMENTS[declared]) {
        fail(
          'dates',
          `${field} "${value}" does not state the precision "${declared}" recorded beside it`,
          `${collection}:${entry.id}`,
        );
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

  // A release cannot predate the family it belongs to. Compared as intervals, so
  // a release the source dated only to a year is flagged only when *every* day
  // that year could mean falls before the family's earliest possible start. An
  // overlap means the sources do not settle the order, which is not the same
  // thing as a contradiction and must not be reported as one.
  const familyById = new Map(docs.families.map((family) => [family.id, family]));
  for (const release of docs.releases) {
    const family = familyById.get(release.familyId);
    if (family && isRealPartialDate(release.releaseDate) && isRealPartialDate(family.firstReleaseDate)
      && endOf(release.releaseDate) < startOf(family.firstReleaseDate)) {
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
        if (isRealPartialDate(release.releaseDate) && isRealPartialDate(ancestor.releaseDate)
          && endOf(release.releaseDate) < startOf(ancestor.releaseDate)) {
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
  gateFamilyHasRelease(docs);
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
