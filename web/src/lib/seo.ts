import { modelRoute, providerRoute } from './catalog';

/**
 * Build-time SEO primitives: absolute URLs, the Open Graph card, and the two
 * generated text files (sitemap and robots). ADR 0001 requires all of this to be
 * generated at build, so every function here is pure over an explicit origin and
 * base -- no runtime fetch, no ambient global -- which is what lets the same
 * functions be unit-tested against a fixed origin and then fed `context.site`
 * and `import.meta.env.BASE_URL` by the endpoints and the layout.
 */

/** The site's own name. Not a sourced claim about the world; the product's name. */
export const SITE_NAME = 'ModelTree';

/**
 * The single social card, served at the site root under the base path. One
 * ModelTree-branded raster site-wide: the text a human reads on a social card is
 * `og:title`/`og:description`, and the per-page entity name is carried by
 * `og:image:alt`, so the image itself is a fixed branded backdrop.
 */
export const OG_CARD_FILE = 'og-card.png';
export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;
export const OG_CARD_TYPE = 'image/png';

/**
 * Every canonical, indexable top-level route, as a path segment under the base.
 * The empty string is the home route. `refresh/` is the *canonical* refresh view
 * (all runs, page 1); the filtered and paginated refresh permutations are
 * deliberately absent -- they are noindexed and kept out of the sitemap so the
 * site does not ask crawlers to index every filter combination.
 */
export const STATIC_ROUTE_SEGMENTS = [
  '',
  'tree/',
  'timeline/',
  'benchmarks/',
  'compare/',
  'glossary/',
  'methodology/',
  'models/',
  'providers/',
  'updates/',
  'refresh/',
] as const;

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/** The Open Graph card's path under the base, e.g. `/ModelTree/og-card.png`. */
export function ogCardHref(base: string): string {
  return `${normalizeBase(base)}${OG_CARD_FILE}`;
}

/**
 * Joins an origin (`https://host`, no trailing slash required) with a root-relative
 * path into one absolute URL with exactly one slash at the seam. The path is
 * expected to already carry the base prefix; this function never invents one.
 */
export function absoluteUrl(origin: string, path: string): string {
  const left = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  const right = path.startsWith('/') ? path : `/${path}`;
  return `${left}${right}`;
}

/** The five XML metacharacters, escaped so a URL with `&` cannot break the sitemap. */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** One sitemap URL: a path under the base, and the day it was last verified where we have one. */
export interface SitemapEntry {
  /** Root-relative path including the base prefix and a trailing slash. */
  path: string;
  /** `YYYY-MM-DD`, present only for entity pages whose record carries a verification date. */
  lastmod?: string;
}

/** An entity route's slug and the verification date to record as its `lastmod`. */
export interface DatedRoute {
  slug: string;
  lastmod: string;
}

/**
 * The complete set of canonical, indexable routes, in a stable order: the fixed
 * top-level routes first, then a route per model release, then a route per
 * generated provider page. Static routes carry no `lastmod` -- there is no honest
 * per-page date for them -- while entity routes carry their record's verification
 * date. By construction this never contains a refresh filter or pagination
 * variant, so a caller cannot accidentally advertise one.
 */
export function collectCanonicalRoutes(input: {
  base: string;
  models: DatedRoute[];
  providers: DatedRoute[];
}): SitemapEntry[] {
  const base = normalizeBase(input.base);

  const staticEntries: SitemapEntry[] = STATIC_ROUTE_SEGMENTS.map((segment) => ({
    path: `${base}${segment}`,
  }));

  const modelEntries: SitemapEntry[] = input.models.map((model) => ({
    path: modelRoute(base, model.slug),
    lastmod: model.lastmod,
  }));

  const providerEntries: SitemapEntry[] = input.providers.map((provider) => ({
    path: providerRoute(base, provider.slug),
    lastmod: provider.lastmod,
  }));

  return [...staticEntries, ...modelEntries, ...providerEntries];
}

/** Serializes sitemap entries to an XML document, resolving each path against the origin. */
export function renderSitemap(origin: string, entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const loc = escapeXml(absoluteUrl(origin, entry.path));
      const lastmod = entry.lastmod ? `\n    <lastmod>${entry.lastmod}</lastmod>` : '';
      return `  <url>\n    <loc>${loc}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * A permissive robots policy that points crawlers at the sitemap. There are no
 * private routes on a static Pages site to disallow; per-page indexability is
 * decided by the `robots` meta tag each page emits, not here.
 */
export function renderRobots(sitemapUrl: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;
}
