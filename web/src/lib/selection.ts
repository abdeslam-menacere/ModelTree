export const MODEL_QUERY_PARAMETER = 'model';

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