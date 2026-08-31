import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  collectCanonicalRoutes,
  escapeXml,
  ogCardHref,
  renderRobots,
  renderSitemap,
} from './seo';

const ORIGIN = 'https://example.test';
const BASE = '/ModelTree/';

describe('absoluteUrl', () => {
  it('joins an origin and a base-prefixed path with exactly one slash', () => {
    expect(absoluteUrl(ORIGIN, '/ModelTree/tree/')).toBe('https://example.test/ModelTree/tree/');
  });

  it('tolerates a trailing slash on the origin and a missing leading slash on the path', () => {
    expect(absoluteUrl('https://example.test/', 'ModelTree/')).toBe('https://example.test/ModelTree/');
  });
});

describe('ogCardHref', () => {
  it('resolves the card under the base path', () => {
    expect(ogCardHref(BASE)).toBe('/ModelTree/og-card.png');
  });

  it('normalises a base with no trailing slash', () => {
    expect(ogCardHref('/ModelTree')).toBe('/ModelTree/og-card.png');
  });
});

describe('escapeXml', () => {
  it('escapes every metacharacter so a query URL cannot break the document', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
});

describe('collectCanonicalRoutes', () => {
  const routes = collectCanonicalRoutes({
    base: BASE,
    models: [{ slug: 'openai-gpt-4-1', lastmod: '2026-01-02' }],
    providers: [{ slug: 'openai', lastmod: '2026-01-03' }],
  });
  const paths = routes.map((route) => route.path);

  it('includes the home route and the canonical refresh route', () => {
    expect(paths).toContain('/ModelTree/');
    expect(paths).toContain('/ModelTree/refresh/');
  });

  it('includes a route for a known model and provider slug', () => {
    expect(paths).toContain('/ModelTree/models/openai-gpt-4-1/');
    expect(paths).toContain('/ModelTree/providers/openai/');
  });

  it('records lastmod on entity routes and omits it on static routes', () => {
    const model = routes.find((route) => route.path === '/ModelTree/models/openai-gpt-4-1/');
    const home = routes.find((route) => route.path === '/ModelTree/');
    expect(model?.lastmod).toBe('2026-01-02');
    expect(home?.lastmod).toBeUndefined();
  });

  it('never emits a refresh filter or pagination variant', () => {
    const variants = paths.filter(
      (path) => path.includes('/refresh/') && path !== '/ModelTree/refresh/',
    );
    expect(variants).toEqual([]);
    expect(paths.some((path) => /\/page\/\d+\//.test(path))).toBe(false);
    expect(paths.some((path) => path.includes('/outcome/') || path.includes('/year/'))).toBe(false);
  });
});

describe('renderSitemap', () => {
  const xml = renderSitemap(ORIGIN, [
    { path: '/ModelTree/' },
    { path: '/ModelTree/models/openai-gpt-4-1/', lastmod: '2026-01-02' },
  ]);

  it('emits a urlset document with absolute locations', () => {
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://example.test/ModelTree/</loc>');
    expect(xml).toContain('<loc>https://example.test/ModelTree/models/openai-gpt-4-1/</loc>');
  });

  it('emits lastmod only where an entry carries one', () => {
    expect(xml).toContain('<lastmod>2026-01-02</lastmod>');
    expect(xml.match(/<lastmod>/g)?.length).toBe(1);
  });
});

describe('renderRobots', () => {
  it('allows all agents and points at the absolute sitemap URL', () => {
    const robots = renderRobots('https://example.test/ModelTree/sitemap.xml');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://example.test/ModelTree/sitemap.xml');
  });
});
