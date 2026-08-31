import type { APIContext } from 'astro';
import { dataset } from '../data/dataset';
import { buildCreatorEcosystems } from '../lib/lineage-view';
import { collectCanonicalRoutes, renderSitemap } from '../lib/seo';

// A build-time static file (ADR 0001): the site has no server, so this is
// rendered once during `astro build` and served as a plain artifact.
export const prerender = true;

/**
 * The sitemap lists only canonical, indexable routes: the fixed top-level pages,
 * every model release, every generated provider page, and the one canonical
 * refresh view. The filtered and paginated refresh permutations are deliberately
 * excluded -- they are noindexed -- which is why the route set comes from
 * `collectCanonicalRoutes` and not from every generated path.
 *
 * `lastmod` is a recorded verification date, never a build timestamp: a model's
 * from its release record, a provider's from its organization record. Static
 * pages carry none, because there is no honest per-page date to state.
 */
export function GET(context: APIContext): Response {
  const origin = context.site?.origin ?? '';
  const base = import.meta.env.BASE_URL;

  const models = dataset.releases.map((release) => ({
    slug: release.slug,
    lastmod: release.verifiedAt,
  }));

  const providers = buildCreatorEcosystems(dataset).map((ecosystem) => ({
    slug: ecosystem.organization.slug,
    lastmod: ecosystem.organization.verifiedAt,
  }));

  const entries = collectCanonicalRoutes({ base, models, providers });

  return new Response(renderSitemap(origin, entries), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
