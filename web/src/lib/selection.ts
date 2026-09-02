export const MODEL_QUERY_PARAMETER = 'model';
export const PROVIDER_QUERY_PARAMETER = 'provider';
/**
 * A single boolean flag: is the shareable lineage trail focused?
 *
 * Kept deliberately narrow, per issue #39's non-goals ("no arbitrary graph
 * queries"). Only the string `1` counts as on; every other value, and every
 * absence, means off — so a stale or hand-edited value fails safe to "trail
 * not focused" rather than to a partial state.
 */
export const TRAIL_QUERY_PARAMETER = 'trail';
const TRAIL_ACTIVE_VALUE = '1';

export function readSelectedModel(
  search: string,
  validSlugs: readonly string[],
  fallback: string,
) {
  const candidate = new URLSearchParams(search).get(MODEL_QUERY_PARAMETER);
  return candidate && validSlugs.includes(candidate) ? candidate : fallback;
}

export function createModelSelectionUrl(input: string | URL, slug: string) {
  const url = input instanceof URL ? new URL(input) : new URL(input, 'https://modeltree.local');
  url.searchParams.set(MODEL_QUERY_PARAMETER, slug);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readOptionalSelectedModel(search: string, validIds: readonly string[]) {
  const candidate = new URLSearchParams(search).get(MODEL_QUERY_PARAMETER);
  return candidate && validIds.includes(candidate) ? candidate : undefined;
}

/**
 * The provider half of the homepage's `provider` + `model` state, which
 * `docs/product/INFORMATION-ARCHITECTURE.md` fixes as the parameters for that
 * route. It is read separately from the model because a provider can be browsed
 * before anything is selected; where both are present and disagree, the caller
 * resolves the model first, since a model implies exactly one provider.
 */
export function readOptionalSelectedProvider(search: string, validSlugs: readonly string[]) {
  const candidate = new URLSearchParams(search).get(PROVIDER_QUERY_PARAMETER);
  return candidate && validSlugs.includes(candidate) ? candidate : undefined;
}

/**
 * Writes both halves at once, leaving every other parameter and the fragment
 * alone. The pair is always re-emitted in the same order, so the URL a reader
 * copies after following a shared link is identical to the one they were sent.
 */
export function createLineageSelectionUrl(
  input: string | URL,
  providerSlug: string,
  modelSlug: string,
) {
  const url = input instanceof URL ? new URL(input) : new URL(input, 'https://modeltree.local');
  url.searchParams.delete(PROVIDER_QUERY_PARAMETER);
  url.searchParams.delete(MODEL_QUERY_PARAMETER);
  url.searchParams.set(PROVIDER_QUERY_PARAMETER, providerSlug);
  url.searchParams.set(MODEL_QUERY_PARAMETER, modelSlug);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Reads the trail flag, treating anything other than the canonical `1` as off.
 *
 * Kept as a lenient reader with a strict writer: someone typing a URL by hand
 * with `?trail=true` gets the safer fallback ("not focused"), and the writer
 * never emits anything else, so a copy of a copy stays byte-identical.
 */
export function readOptionalTrailFlag(search: string) {
  return new URLSearchParams(search).get(TRAIL_QUERY_PARAMETER) === TRAIL_ACTIVE_VALUE;
}

/**
 * Writes the same provider/model pair as `createLineageSelectionUrl` plus the
 * trail flag, or clears the flag when `active` is false. Emit order is fixed
 * (`provider`, `model`, then `trail`) so a link shared, followed, and copied
 * again round-trips as the same string. Every other parameter and the fragment
 * are preserved.
 */
export function createLineageTrailUrl(
  input: string | URL,
  providerSlug: string,
  modelSlug: string,
  active: boolean,
) {
  const url = input instanceof URL ? new URL(input) : new URL(input, 'https://modeltree.local');
  url.searchParams.delete(PROVIDER_QUERY_PARAMETER);
  url.searchParams.delete(MODEL_QUERY_PARAMETER);
  url.searchParams.delete(TRAIL_QUERY_PARAMETER);
  url.searchParams.set(PROVIDER_QUERY_PARAMETER, providerSlug);
  url.searchParams.set(MODEL_QUERY_PARAMETER, modelSlug);
  if (active) url.searchParams.set(TRAIL_QUERY_PARAMETER, TRAIL_ACTIVE_VALUE);
  return `${url.pathname}${url.search}${url.hash}`;
}