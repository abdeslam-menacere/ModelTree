import type { APIRoute } from 'astro';
import { dataset } from '../data/dataset';
import { assertRoutesResolve, buildCatalogIndex } from '../lib/catalog';
import { modelStaticPaths } from '../lib/routes';

export const prerender = true;

export const GET: APIRoute = () => {
  const index = buildCatalogIndex(dataset, import.meta.env.BASE_URL);

  // Provider detail pages are not generated, so provider rows publish a null
  // route. Passing no provider slugs holds every route in the index to a page
  // this build actually generates.
  assertRoutesResolve(index, {
    models: modelStaticPaths().map((path) => path.params.slug),
  });

  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json' },
  });
};
