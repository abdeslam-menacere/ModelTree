import type { APIRoute } from 'astro';
import { dataset } from '../data/dataset';
import { assertRoutesResolve, buildCatalogIndex } from '../lib/catalog';
import { modelStaticPaths, providerStaticPaths } from '../lib/routes';

export const prerender = true;

export const GET: APIRoute = () => {
  const index = buildCatalogIndex(dataset, import.meta.env.BASE_URL);

  // Every non-null route in the index is held to a page this build generates:
  // the model routes to their releases, and the provider routes -- now that
  // `/providers/[slug]` exists -- to the featured organizations it generates.
  assertRoutesResolve(index, {
    models: modelStaticPaths().map((path) => path.params.slug),
    providers: providerStaticPaths().map((path) => path.params.slug),
  });

  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json' },
  });
};
