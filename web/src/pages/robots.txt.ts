import type { APIContext } from 'astro';
import { absoluteUrl, renderRobots } from '../lib/seo';

// A build-time static file (ADR 0001), rendered once during `astro build`.
export const prerender = true;

/**
 * A permissive robots policy pointing at the sitemap. There are no private routes
 * on this static site to disallow; whether an individual route is indexed is
 * decided by the `robots` meta tag it emits, not here.
 */
export function GET(context: APIContext): Response {
  const origin = context.site?.origin ?? '';
  const base = import.meta.env.BASE_URL;
  const sitemapUrl = absoluteUrl(origin, `${base}sitemap.xml`);

  return new Response(renderRobots(sitemapUrl), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
