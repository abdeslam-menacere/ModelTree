/**
 * The `/compare` URL contract, and nothing else.
 *
 * This lives apart from `comparison.ts` because more than one feature links into
 * the comparison page — the Model Passport and the lineage drawer both do — and
 * `comparison.ts` reads formatting helpers out of `passport.ts`, so a passport
 * that imported the comparison would close a cycle. Keeping the contract in a
 * leaf module every caller can reach means the parameter name and the two-to-four
 * bound have exactly one definition, which is the property that stops two
 * features drifting into URLs the other cannot read.
 *
 * The information architecture pairs `models=` with an optional `domain` and
 * `benchmark`, which belong to the evidence route. This module gives them no
 * meaning and preserves them, rather than inventing behaviour for them here.
 */

/**
 * One query parameter holding an ordered, comma-separated slug list.
 *
 * Repeated `?model=a&model=b` parameters were the alternative and are rejected
 * for a specific reason: `URLSearchParams` preserves their order but a reader
 * editing the address bar cannot see the ordering rule, and every consumer that
 * re-serialises has to remember to emit them in the same sequence. A single
 * ordered list makes selection order visible in the URL, which is what
 * "selection order and copied URL restore deterministically" has to mean.
 *
 * Note `?model=` singular is the model tree's own deep-link parameter. It is a
 * different parameter with a different value space, and the two are not unified.
 */
export const COMPARE_QUERY_PARAMETER = 'models';

export const MIN_COMPARISON_MODELS = 2;
export const MAX_COMPARISON_MODELS = 4;

/** Split the query parameter's ordered list. */
export function readComparisonSlugs(search: string): string[] {
  const raw = new URLSearchParams(search).get(COMPARE_QUERY_PARAMETER);
  if (raw === null) return [];
  return raw.split(',');
}

/**
 * The query string for a selection. Empty for an empty selection, so a cleared
 * comparison yields a bare `/compare/` rather than a trailing `?models=`.
 *
 * Any other parameter already in `currentSearch` is carried through untouched, so
 * a link that arrived carrying `domain` or `benchmark` still carries them after a
 * reader adds or removes a model.
 */
export function serializeComparisonSelection(
  slugs: readonly string[],
  currentSearch = '',
) {
  const carried = new URLSearchParams(currentSearch);
  carried.delete(COMPARE_QUERY_PARAMETER);

  const params = new URLSearchParams();
  if (slugs.length > 0) params.set(COMPARE_QUERY_PARAMETER, slugs.join(','));
  for (const [key, value] of carried) params.append(key, value);

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

function normalizeBase(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

export function compareRoute(base: string) {
  return `${normalizeBase(base)}compare/`;
}

export function compareUrl(base: string, slugs: readonly string[]) {
  return `${compareRoute(base)}${serializeComparisonSelection(slugs)}`;
}
