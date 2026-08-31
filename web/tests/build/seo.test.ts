import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataset } from '../../src/data/dataset';
import { buildSiteExclusively } from './exclusive-build';

// Issue #34 emits canonical URLs, Open Graph/Twitter metadata, a sitemap, robots,
// and JSON-LD -- all generated at build (ADR 0001). Every fact of interest is a
// property of the real emitted HTML and the two generated text files, so this
// builds the site exactly as the deploy does and reads the artifacts off disk.
// It never scrapes a tool's console output: CI colourises summaries with escape
// codes between words, so an assertion on stdout passes locally and reddens on CI.
//
// The base path and origin here are deliberately NOT the production ones. A build
// that hard-coded `/ModelTree/` or the production origin into a canonical URL
// would pass a test that reused those same values; a probe base that differs from
// production is what proves the canonical is `origin + base + pathname` and not a
// literal. This mirrors the reasoning in base-path.test.ts.

const BASE_PATH = '/seo-probe/';
const SITE_URL = 'https://seo-probe.invalid';
const EXPECTED_PREFIX = `${SITE_URL}${BASE_PATH}`;
const OG_CARD_URL = `${EXPECTED_PREFIX}og-card.png`;
const SITEMAP_URL = `${EXPECTED_PREFIX}sitemap.xml`;

// The card is a fixed branded raster served to social scrapers only; it is never
// loaded on a visitor route. This ceiling is far above its measured size and
// exists to catch a regression that swaps the one shared card for per-page
// rasters or ships an unoptimised asset, not to track its exact bytes.
const OG_CARD_MAX_BYTES = 50 * 1024;

const outDir = mkdtempSync(join(tmpdir(), 'modeltree-seo-'));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

// `BASE_URL` must be removed, not just left unset: vitest injects `BASE_URL=/`
// into the worker's env and Astro copies `process.env` onto `import.meta.env`,
// where it would un-prefix every base-derived path in the child build. A GitHub
// Actions runner sets none, so dropping it is what makes this the deploy's build.
const { BASE_URL: _inheritedFromVitest, ...inheritedEnv } = process.env;

buildSiteExclusively(outDir, { ...inheritedEnv, BASE_PATH, SITE_URL });

function htmlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.isFile() && entry.name.endsWith('.html') ? [full] : [];
  });
}

const pages = htmlFiles(outDir).map((path) => ({
  route: relative(outDir, path).split(sep).join(posix.sep),
  html: readFileSync(path, 'utf8'),
}));

function pageByRoute(route: string) {
  const page = pages.find((candidate) => candidate.route === route);
  if (!page) throw new Error(`build did not emit ${route}`);
  return page;
}

function canonicalsOf(html: string): string[] {
  return [...html.matchAll(/<link rel="canonical"[^>]*href="([^"]*)"/g)].map((match) => match[1]);
}

function metaContent(html: string, property: string): string | undefined {
  const match = html.match(
    new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`),
  );
  return match?.[1];
}

function jsonLdBlocks(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => JSON.parse(match[1]),
  );
}

const sampleRelease = dataset.releases[0];

describe('the built site emits canonical SEO metadata', () => {
  it('builds and generates pages', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it('gives every page exactly one absolute canonical under the origin and base', () => {
    const offenders = pages
      .map(({ route, html }) => ({ route, canonicals: canonicalsOf(html) }))
      .filter(
        ({ canonicals }) =>
          canonicals.length !== 1 || !canonicals[0].startsWith(EXPECTED_PREFIX),
      );

    expect(
      offenders.map(({ route, canonicals }) => `${route}: ${JSON.stringify(canonicals)}`),
      'every page needs exactly one canonical resolving under origin + base',
    ).toEqual([]);
  });

  it('points the home page at itself, with Open Graph, Twitter, and JSON-LD', () => {
    const { html } = pageByRoute('index.html');

    expect(canonicalsOf(html)[0]).toBe(EXPECTED_PREFIX);
    expect(metaContent(html, 'og:url')).toBe(EXPECTED_PREFIX);
    expect(metaContent(html, 'og:image')).toBe(OG_CARD_URL);
    expect(metaContent(html, 'og:image:alt')).toBeTruthy();
    expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'twitter:image')).toBe(OG_CARD_URL);

    const types = jsonLdBlocks(html).map((block) => (block as { '@type': string })['@type']);
    expect(types).toContain('WebSite');
    expect(types).toContain('Dataset');
  });

  it('carries the real model name in a model page og:image:alt, not a generic string', () => {
    const { html } = pageByRoute(`models/${sampleRelease.slug}/index.html`);

    expect(metaContent(html, 'og:image:alt')).toBe(
      `${sampleRelease.displayName} — Model Passport on ModelTree`,
    );
    expect(canonicalsOf(html)[0]).toBe(`${EXPECTED_PREFIX}models/${sampleRelease.slug}/`);
    expect(metaContent(html, 'og:image')).toBe(OG_CARD_URL);

    const types = jsonLdBlocks(html).map((block) => (block as { '@type': string })['@type']);
    expect(types).toContain('BreadcrumbList');
  });
});

describe('the shared Open Graph card', () => {
  it('ships one PNG under the base path, within the asset ceiling', () => {
    const cardPath = join(outDir, 'og-card.png');
    const bytes = readFileSync(cardPath);

    // PNG magic number: an artefact that is not a real PNG never satisfies this.
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBeLessThan(OG_CARD_MAX_BYTES);
    expect(statSync(cardPath).isFile()).toBe(true);
  });
});

describe('the generated sitemap and robots', () => {
  const sitemap = readFileSync(join(outDir, 'sitemap.xml'), 'utf8');
  const robots = readFileSync(join(outDir, 'robots.txt'), 'utf8');

  it('lists absolute canonical routes including a known model', () => {
    expect(sitemap).toContain('<urlset');
    expect(sitemap).toContain(`<loc>${EXPECTED_PREFIX}</loc>`);
    expect(sitemap).toContain(`<loc>${EXPECTED_PREFIX}models/${sampleRelease.slug}/</loc>`);
    expect(sitemap).toContain(`<loc>${EXPECTED_PREFIX}refresh/</loc>`);
  });

  it('excludes refresh filter and pagination variants', () => {
    // The canonical refresh route is present; no deeper refresh permutation is.
    expect(sitemap).not.toMatch(/<loc>[^<]*\/refresh\/[^<]+<\/loc>/);
  });

  it('points robots at the absolute sitemap', () => {
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain(`Sitemap: ${SITEMAP_URL}`);
  });
});

describe('non-canonical refresh views', () => {
  const variant = pages.find(
    ({ route }) => /^refresh\/.+\/index\.html$/.test(route) && route !== 'refresh/index.html',
  );

  it('generates at least one filtered or paginated refresh view', () => {
    expect(variant, 'expected a non-default refresh permutation to exist').toBeDefined();
  });

  it('noindexes each variant and points its canonical at the default refresh view', () => {
    expect(variant).toBeDefined();
    if (!variant) return;

    expect(metaContent(variant.html, 'robots')).toBe('noindex,follow');
    expect(canonicalsOf(variant.html)[0]).toBe(`${EXPECTED_PREFIX}refresh/`);
  });
});
