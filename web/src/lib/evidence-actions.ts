/**
 * URL builders for the lineage drawer's evidence actions.
 *
 * `docs/product/INFORMATION-ARCHITECTURE.md` fixes the shared query state:
 * evidence uses `models=<slug,slug>`. Both `/benchmarks` and `/compare` read the
 * same `models` parameter, carrying release *slugs* (the tree's own deep-link
 * parameter `?model=<release-id>` is a separate concern and is left untouched).
 *
 * `/compare` (issue #24) and `/benchmarks` (issue #23) both now exist and
 * resolve these URLs; these builders produce the stable URLs those routes
 * consume, so the cap logic lives here regardless of what is on the other end of
 * the link.
 */

export const EVIDENCE_MODELS_PARAMETER = 'models';

/** `/compare` is a two-to-four-model comparison; four is the hard ceiling. */
export const COMPARE_MODEL_LIMIT = 4;

const PLACEHOLDER_ORIGIN = 'https://modeltree.local';

function withTrailingSlash(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

/** Distinct, non-blank slugs from the `models` parameter, in first-seen order. */
function readModelSlugs(input: string | URL) {
  const url = input instanceof URL ? input : new URL(input, PLACEHOLDER_ORIGIN);
  const raw = url.searchParams.get(EVIDENCE_MODELS_PARAMETER) ?? '';
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const candidate of raw.split(',')) {
    const slug = candidate.trim();
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Slugs match `[a-z0-9-]+`, so a literal comma-joined list needs no escaping and
 * reads back exactly as written — which keeps the URL a reader copies identical
 * to the one the drawer produced.
 */
function modelsQuery(base: string, route: string, slugs: readonly string[]) {
  return `${withTrailingSlash(base)}${route}/?${EVIDENCE_MODELS_PARAMETER}=${slugs.join(',')}`;
}

/** `/benchmarks?models=<slug>` for the single selected release. */
export function createEvidenceUrl(base: string, slug: string) {
  return modelsQuery(base, 'benchmarks', [slug]);
}

export interface CompareUrlResult {
  href: string;
  /** The resulting comparison set, never longer than {@link COMPARE_MODEL_LIMIT}. */
  models: string[];
  /** `true` when the slug could not be added because the set is already full. */
  atLimit: boolean;
}

/**
 * Adds `slug` to whatever `models` are already in `input`'s query state and
 * returns the `/compare` URL for the result. The incoming set is first reduced
 * to its distinct slugs and clamped to {@link COMPARE_MODEL_LIMIT}, so the
 * result is always distinct and never longer than the ceiling. Adding is
 * idempotent (a slug already present is a no-op) and bounded: once the set holds
 * {@link COMPARE_MODEL_LIMIT} models a further, different slug is refused rather
 * than pushing the set past the ceiling.
 */
export function createCompareUrl(
  input: string | URL,
  base: string,
  slug: string,
): CompareUrlResult {
  const existing = readModelSlugs(input).slice(0, COMPARE_MODEL_LIMIT);

  if (existing.includes(slug)) {
    return { href: modelsQuery(base, 'compare', existing), models: existing, atLimit: false };
  }

  if (existing.length >= COMPARE_MODEL_LIMIT) {
    return { href: modelsQuery(base, 'compare', existing), models: existing, atLimit: true };
  }

  const models = [...existing, slug];
  return { href: modelsQuery(base, 'compare', models), models, atLimit: false };
}
