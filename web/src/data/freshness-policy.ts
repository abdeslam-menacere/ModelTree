/**
 * The category-aware freshness policy: how old a verified fact may be before the
 * data-health report calls it **stale**.
 *
 * This module is the single source of truth for those thresholds. Two staleness
 * constants predate it and are deliberately left where they are —
 * `usage-evidence.ts`'s `STALE_AFTER_DAYS` (180) and `passport.ts`'s
 * `VOLATILE_STALE_AFTER_DAYS` (90) drive per-fact staleness *badges on public
 * pages*, a separate concern from the maintainer report. Rather than refactor
 * those call sites (a wide change across unrelated files), the policy's
 * `volatile` and `evidence` thresholds are set to the same numbers and
 * `freshness-policy.test.ts` asserts they stay equal, so the scattered constants
 * cannot drift away from the documented policy.
 *
 * **Why a threshold is not a score.** A threshold names a category and a number
 * of days; a record older than that is reported as stale *with the date and the
 * threshold that produced the verdict*, so a maintainer sees why. Nothing here
 * ranks records, aggregates a quality number, or compares creators. Ordinary age
 * is a fact to report, never a build failure.
 *
 * **Versioned.** `FRESHNESS_POLICY_VERSION` travels in the report artifacts and
 * in `docs/product/FRESHNESS-POLICY.md`; bump it (and the doc's changelog) when a
 * threshold or a category assignment changes. `freshness-policy.test.ts` pins the
 * doc and the module together so the two cannot disagree.
 */

/** Bump together with the changelog in `docs/product/FRESHNESS-POLICY.md`. */
export const FRESHNESS_POLICY_VERSION = '1.0.0';

/**
 * The four volatility bands. A band, not a per-field number, because facts of
 * the same volatility age at the same rate: a price and a serving region move on
 * one clock, a context window and a modality list on a much slower one.
 */
export type FreshnessCategory = 'volatile' | 'evidence' | 'release-metadata' | 'structural';

/**
 * Maximum age in days before a record in each band is reported stale. The first
 * two match the public-badge constants named above; the last two are new and
 * chosen by how often the underlying fact actually changes.
 *
 * - `volatile` (90) — prices, availability and delivery details change on short
 *   notice and a stale one misinforms a buyer, so the window is tight.
 * - `evidence` (180) — usage figures and conditional guidance age with the
 *   ecosystem; half a year unre-checked is presented as needing another look.
 * - `release-metadata` (365) — a context window, modality set or licence rarely
 *   changes after launch, so a year is a reasonable re-verification cadence. The
 *   public passport shows no stale badge for these at all; the maintainer report
 *   still surfaces very old metadata so it is re-read, not silently trusted.
 * - `structural` (545) — organisation identity, ownership, product and platform
 *   facts change slowest of all, so the longest window applies.
 */
export const FRESHNESS_THRESHOLD_DAYS: Record<FreshnessCategory, number> = {
  volatile: 90,
  evidence: 180,
  'release-metadata': 365,
  structural: 545,
};

/**
 * Every record kind the report dates, and nothing else. `source` is dated by its
 * `lastCheckedDate` and `publisher-control` by the optional `control.verifiedAt`;
 * all others by their required `verifiedAt`. `model-fit-evidence-gap` is included
 * because it carries a `verifiedAt` even though it asserts no external fact — a
 * gap recorded long ago is worth re-checking too.
 */
export type RecordKind =
  | 'organization'
  | 'family'
  | 'release'
  | 'product'
  | 'serving-platform'
  | 'deployment'
  | 'pricing'
  | 'benchmark'
  | 'benchmark-result'
  | 'release-event'
  | 'usage-observation'
  | 'usage-synthesis'
  | 'model-fit-statement'
  | 'model-fit-evidence-gap'
  | 'source'
  | 'publisher-control';

export const RECORD_KIND_CATEGORY: Record<RecordKind, FreshnessCategory> = {
  pricing: 'volatile',
  deployment: 'volatile',
  'usage-observation': 'evidence',
  'usage-synthesis': 'evidence',
  'model-fit-statement': 'evidence',
  'model-fit-evidence-gap': 'evidence',
  release: 'release-metadata',
  family: 'release-metadata',
  'release-event': 'release-metadata',
  benchmark: 'release-metadata',
  'benchmark-result': 'release-metadata',
  organization: 'structural',
  product: 'structural',
  'serving-platform': 'structural',
  source: 'structural',
  'publisher-control': 'structural',
};

export function categoryOf(kind: RecordKind): FreshnessCategory {
  return RECORD_KIND_CATEGORY[kind];
}

export function thresholdDaysFor(kind: RecordKind): number {
  return FRESHNESS_THRESHOLD_DAYS[categoryOf(kind)];
}
