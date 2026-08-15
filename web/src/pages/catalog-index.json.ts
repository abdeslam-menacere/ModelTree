import type { APIRoute } from 'astro';
import { dataset } from '../data/dataset';
import { assertRoutesResolve, buildCatalogIndex } from '../lib/catalog';
import { modelStaticPaths } from '../lib/routes';

export const prerender = true;

export const GET: APIRoute = () => {
  const index = buildCatalogIndex(dataset, import.meta.env.BASE_URL);

  // Provider detail pages are not generated yet, so only model rows are held to
  // an existing route until #17 adds them.
  assertRoutesResolve(index, {
    models: modelStaticPaths().map((path) => path.params.slug),
  });

  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json' },
  });
};
