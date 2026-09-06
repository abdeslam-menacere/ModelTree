/**
 * Synthetic dataset tranche construction, for the route-runway probe (#1018).
 *
 * WHY THIS EXISTS
 *
 * `asset-budgets.json` records a `measuredRaw` per route. That number is a
 * RECORD of a past measurement, not a measurement of the current tree: it moves
 * only when somebody re-records it. So its history across commits is a sawtooth
 * of re-record events, not a growth curve, and a growth RATE cannot be mined out
 * of it. `catalog` read byte-identical across a real three-creator tranche and
 * then jumped +11,926 on a later re-record that released accumulated drift --
 * the file cannot tell "did not grow" from "was not measured", because in that
 * file the two are byte-identical.
 *
 * The only way to obtain a rate is therefore to BUILD BOTH ARMS: the dataset as
 * committed, and the same dataset plus a synthetic tranche of N creators. This
 * module builds the second arm's data. It is pure -- it takes a raw dataset
 * object and returns a new one, touching no files and no working tree.
 *
 * WHAT A SYNTHETIC CREATOR IS
 *
 * A deep clone of a real creator that already sits in the dataset, with every
 * identifier and every uniqueness-constrained field suffixed so the clone
 * coexists with its donor. Cloning a real creator rather than inventing one is
 * deliberate: the rendered weight of a creator is dominated by its prose --
 * `reason` fields, source titles, quotes -- and an invented creator would carry
 * whatever prose length the author happened to type, which measures the author
 * and not the dataset.
 *
 * CLONE EVERYTHING THAT TRACES TO THE DONOR. Cloning less under-counts growth,
 * which over-states runway, which is the direction that loses work: a dock told
 * it can afford six creators when it can afford three writes three creators'
 * worth of research that cannot land. Cloning slightly more -- the suffixes
 * below add a few bytes per slug -- over-states growth and under-states runway,
 * which is the recoverable direction.
 *
 * WHAT IS DELIBERATELY NOT CLONED
 *
 * `benchmarks` are shared reference entities (MMLU, GPQA). A new creator brings
 * results against existing benchmarks, not new benchmarks, so the collection is
 * carried through unchanged. References from cloned records to entities that are
 * NOT cloned -- a shared publisher, a serving platform owned by somebody else --
 * legitimately keep pointing at the original, which is what a real new creator's
 * records would do too.
 */

/**
 * Collection key -> file name under `web/src/data/`.
 *
 * Every file here is overlaid in BOTH arms of the probe, including the ones a
 * tranche never changes. Identical machinery on both arms is what makes a
 * difference between them attributable to the records rather than to the
 * mechanism: with `creators: 0` the two arms must come out byte-identical, and
 * that is a control the probe runs.
 *
 * `variant-positioning.json` is in this list even though `src/data/raw.ts` does
 * not import it -- it is imported by `src/data/variant-positioning.ts`, and a
 * cloned family that owned a positioning record would otherwise lose it.
 */
export const DATA_FILES = Object.freeze({
  sources: 'sources.json',
  publishers: 'publishers.json',
  organizations: 'organizations.json',
  families: 'families.json',
  releases: 'releases.json',
  products: 'products.json',
  servingPlatforms: 'serving-platforms.json',
  deployments: 'deployments.json',
  releaseEvents: 'release-events.json',
  benchmarks: 'benchmarks.json',
  benchmarkResults: 'benchmark-results.json',
  usageObservations: 'usage-observations.json',
  usageSyntheses: 'usage-syntheses.json',
  modelFitStatements: 'model-fit-statements.json',
  modelFitEvidenceGaps: 'model-fit-evidence-gaps.json',
  variantPositioning: 'variant-positioning.json',
});

/** Collections owned directly by an organization, via `organizationId`. */
const ORG_OWNED = Object.freeze([
  'publishers',
  'families',
  'releases',
  'products',
  'servingPlatforms',
]);

/** Collections owned by a release, via `releaseId`. */
const RELEASE_OWNED = Object.freeze([
  'deployments',
  'releaseEvents',
  'benchmarkResults',
  'usageObservations',
  'modelFitStatements',
  'modelFitEvidenceGaps',
]);

/**
 * Text fields carrying a uniqueness constraint that `validateDataset` enforces.
 * A clone that reused these would be rejected at build time, and a rejected
 * build reports as "the overlay did not take" rather than as a rate.
 */
const UNIQUE_TEXT_FIELDS = Object.freeze({
  organizations: ['slug'],
  families: ['slug'],
  releases: ['slug'],
  products: ['slug'],
  servingPlatforms: ['slug'],
});

/** Uniqueness-constrained fields holding a list of strings. */
const UNIQUE_LIST_FIELDS = Object.freeze({
  releases: ['apiAliases'],
});

const ALL_KEYS = Object.freeze(Object.keys(DATA_FILES));

/**
 * A dataset here is the raw JSON bag keyed by `DATA_FILES`, not the Zod-parsed
 * shape: this module reads and rewrites the files on disk, so it deliberately
 * types them as the loose records they are rather than borrowing a schema type
 * that would claim more than a JSON read establishes.
 *
 * @typedef {Record<string, any[]>} TrancheDataset
 */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * What one creator consists of, counted rather than assumed.
 *
 * `sources` is the transitive count -- every source id reachable from any record
 * the creator owns -- because sources are where a creator's rendered bytes
 * mostly live, and a footprint that counted only families and releases would
 * rank a prose-heavy creator alongside a bare one.
 *
 * @param {TrancheDataset} dataset
 * @param {string} organizationId
 */
export function creatorFootprint(dataset, organizationId) {
  const owned = collectOwned(dataset, organizationId);
  return {
    organizationId,
    families: owned.families.length,
    releases: owned.releases.length,
    sources: owned.sourceIds.length,
    records: ALL_KEYS.reduce((sum, key) => sum + (owned.byCollection[key]?.length ?? 0), 0),
  };
}

/**
 * Where in the footprint distribution donors are drawn from, by default.
 *
 * Above the median on purpose. The rate this probe measures is only as
 * representative as the creator it was measured from, and the two errors are not
 * symmetric: a rate taken from a below-typical creator UNDER-states growth,
 * which OVER-states runway, which tells a dock it can afford research it cannot
 * land -- and that dock discovers the refusal only after the research is done.
 * A rate taken from an above-typical creator errs the other way and costs a
 * conversation. So the default sits at the upper quartile, and the report says
 * so, rather than quietly reporting the friendliest number available.
 *
 * The distribution is right-skewed (measured at this writing: 44 creators,
 * median 11 records, mean 14.8, max 59), so the median is not the mean and
 * picking it would understate the typical creator as well as the large one.
 */
export const DEFAULT_DONOR_PERCENTILE = 75;

/**
 * Rank every creator by footprint, smallest first. Deterministic: two runs on
 * the same commit must select the same donors, or the rate is not reproducible
 * and a later reader cannot check it.
 *
 * @param {TrancheDataset} dataset
 */
export function rankCreators(dataset) {
  return asArray(dataset.organizations)
    .map((org) => creatorFootprint(dataset, org.id))
    .sort(
      (a, b) =>
        a.records - b.records ||
        a.releases - b.releases ||
        a.families - b.families ||
        a.sources - b.sources ||
        (a.organizationId < b.organizationId ? -1 : a.organizationId > b.organizationId ? 1 : 0),
    );
}

/**
 * Pick `count` donor creators from around the `percentile` of that ranking.
 *
 * A window rather than a point, so that asking for three creators measures three
 * different donors: a tranche of one creator cloned three times would measure
 * that creator's idiosyncrasies three times over and call it a rate.
 *
 * @param {TrancheDataset} dataset
 * @param {number} count
 * @param {{ percentile?: number }} [options]
 */
export function selectDonors(dataset, count, { percentile = DEFAULT_DONOR_PERCENTILE } = {}) {
  if (count <= 0) return [];
  const ranked = rankCreators(dataset);
  if (ranked.length === 0) return [];

  const want = Math.min(count, ranked.length);
  const pivot = Math.round(((ranked.length - 1) * percentile) / 100);
  // Centre the window on the pivot, then clamp so it stays inside the array.
  const start = Math.max(0, Math.min(ranked.length - want, pivot - Math.floor((want - 1) / 2)));
  return ranked.slice(start, start + want).map((entry) => entry.organizationId);
}

/** Every record traceable to one organization, plus its transitive source ids. */
function collectOwned(dataset, organizationId) {
  const byCollection = {};
  for (const key of ALL_KEYS) byCollection[key] = [];

  const org = asArray(dataset.organizations).find((o) => o.id === organizationId);
  if (org) byCollection.organizations.push(org);

  for (const key of ORG_OWNED) {
    byCollection[key] = asArray(dataset[key]).filter((r) => r.organizationId === organizationId);
  }

  const releaseIds = new Set(byCollection.releases.map((r) => r.id));
  for (const key of RELEASE_OWNED) {
    byCollection[key] = asArray(dataset[key]).filter((r) => releaseIds.has(r.releaseId));
  }

  const familyIds = new Set(byCollection.families.map((f) => f.id));
  byCollection.variantPositioning = asArray(dataset.variantPositioning).filter((v) =>
    familyIds.has(v.familyId),
  );

  // Sources are found by reachability rather than by a named field, because
  // `sourceIds` is not always top level -- it appears nested inside publisher
  // control blocks and model-fit facts too. Any string in an owned record that
  // is a known source id is a citation of that source.
  const sourceById = new Map(asArray(dataset.sources).map((s) => [s.id, s]));
  const reachable = new Set();
  for (const key of ALL_KEYS) {
    if (key === 'sources') continue;
    for (const record of byCollection[key]) collectSourceIds(record, sourceById, reachable);
  }
  const sourceIds = [...reachable].sort();
  byCollection.sources = sourceIds.map((id) => sourceById.get(id));

  return { byCollection, families: byCollection.families, releases: byCollection.releases, sourceIds };
}

function collectSourceIds(value, sourceById, sink) {
  if (typeof value === 'string') {
    if (sourceById.has(value)) sink.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSourceIds(item, sourceById, sink);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectSourceIds(item, sourceById, sink);
  }
}

/**
 * Rewrite every cloned identifier, wherever it appears.
 *
 * A whole-value string match is the right granularity: ids in this dataset are
 * always a complete field value or a complete array element, never a substring
 * of prose. Matching substrings would corrupt `reason` text that happens to
 * mention a slug, and would change rendered bytes for a reason unrelated to the
 * tranche.
 */
function remapDeep(value, idMap) {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapDeep(item, idMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = remapDeep(item, idMap);
    return out;
  }
  return value;
}

/**
 * Make a cloned source url unique without making it invalid.
 *
 * A fragment is appended rather than a path segment: `validateDataset` parses
 * these as urls, and a fragment keeps the url well formed while making the
 * string distinct. The few bytes it adds inflate measured growth slightly, which
 * under-states runway -- the safe direction.
 */
function tagUrl(url, tag) {
  return typeof url === 'string' && url.length > 0 ? `${url}#${tag}` : url;
}

/**
 * Build a dataset carrying `creators` synthetic creators on top of the real one.
 *
 * Returns `{ dataset, manifest }`. The manifest is not decoration: the probe
 * prints it so a reader can see what a "creator" meant in the run that produced
 * the rate, and a rate whose unit is unstated is not checkable.
 *
 * @param {TrancheDataset} dataset
 * @param {{ creators?: number, donors?: string[] | null, percentile?: number }} [options]
 * @returns {{ dataset: TrancheDataset, manifest: any }}
 */
export function buildTranche(dataset, { creators = 3, donors = null, percentile = DEFAULT_DONOR_PERCENTILE } = {}) {
  const chosen = donors && donors.length > 0 ? donors : selectDonors(dataset, creators, { percentile });
  /** @type {TrancheDataset} */
  const out = {};
  for (const key of ALL_KEYS) out[key] = [...asArray(dataset[key])];

  const added = {};
  for (const key of ALL_KEYS) added[key] = 0;
  const clones = [];

  for (let index = 0; index < creators; index += 1) {
    if (chosen.length === 0) break;
    const donorId = chosen[index % chosen.length];
    const tag = `rw${index}`;
    const owned = collectOwned(dataset, donorId);

    // Pass 1: every cloned id, before anything is rewritten. A reference can
    // point forward as easily as backward, so the map has to be complete before
    // the first record is remapped.
    const idMap = new Map();
    for (const key of ALL_KEYS) {
      for (const record of owned.byCollection[key]) {
        if (record && typeof record.id === 'string') idMap.set(record.id, `${record.id}-${tag}`);
      }
    }

    // Pass 2: clone, remap, then break the uniqueness constraints that a
    // straight copy would violate.
    let cloneRecords = 0;
    for (const key of ALL_KEYS) {
      for (const record of owned.byCollection[key]) {
        const clone = remapDeep(record, idMap);
        for (const field of UNIQUE_TEXT_FIELDS[key] ?? []) {
          if (typeof clone[field] === 'string') clone[field] = `${clone[field]}-${tag}`;
        }
        for (const field of UNIQUE_LIST_FIELDS[key] ?? []) {
          if (Array.isArray(clone[field])) {
            clone[field] = clone[field].map((v) => (typeof v === 'string' ? `${v}-${tag}` : v));
          }
        }
        if (key === 'sources') clone.url = tagUrl(clone.url, tag);
        out[key].push(clone);
        added[key] += 1;
        cloneRecords += 1;
      }
    }

    clones.push({ donorId, tag, records: cloneRecords, footprint: creatorFootprint(dataset, donorId) });
  }

  const manifest = {
    creators,
    percentile: donors && donors.length > 0 ? null : percentile,
    donors: chosen,
    clones,
    added,
    addedRecords: ALL_KEYS.reduce((sum, key) => sum + added[key], 0),
  };
  return { dataset: out, manifest };
}
