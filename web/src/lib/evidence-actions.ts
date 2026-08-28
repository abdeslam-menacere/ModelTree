/**
 * URL builders for the lineage drawer's evidence actions.
 *
 * `docs/product/INFORMATION-ARCHITECTURE.md` fixes the shared query state:
 * evidence uses `models=<slug,slug>`. Both `/benchmarks` and `/compare` read the
 * same `models` parameter, carrying release *slugs* (the tree's own deep-link
 * parameter `?model=<release-id>` is a separate concern and is left untouched).
 *
 * The `/benchmarks` and `/compare` routes do not exist yet (backlog #22 and #23);
 * these builders produce the stable URLs those routes will consume, so the cap
 * logic lives here regardless of what is on the other end of the link. Only URL
 * *generation* is testable today, not resolution.
 */

export const EVIDENCE_MODELS_PARAMETER = 'models';

/** `/compare` is a two-to-four-model comparison; four is the hard ceiling. */
export const COMPARE_MODEL_LIMIT = 4;

const PLACEHOLDER_ORIGIN = 'https://modeltree.local';

function withTrailingSlash(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

function readModelSlugs(input: string | URL) {
  const url = input instanceof URL ? input : new URL(input, PLACEHOLDER_ORIGIN);
  const raw = url.searchParams.get(EVIDENCE_MODELS_PARAMETER) ?? '';
  return raw
    .split(',')
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
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
 * returns the `/compare` URL for the result. Adding is idempotent (a slug
 * already present is a no-op) and bounded: once the set holds
 * {@link COMPARE_MODEL_LIMIT} distinct models a further, different slug is
 * refused rather than pushing the set past the ceiling.
 */
export function createCompareUrl(
  input: string | URL,
  base: string,
  slug: string,
): CompareUrlResult {
  const existing = readModelSlugs(input);

  if (existing.includes(slug)) {
    return { href: modelsQuery(base, 'compare', existing), models: existing, atLimit: false };
  }

  if (existing.length >= COMPARE_MODEL_LIMIT) {
    return { href: modelsQuery(base, 'compare', existing), models: existing, atLimit: true };
  }

  const models = [...existing, slug];
  return { href: modelsQuery(base, 'compare', models), models, atLimit: false };
}
