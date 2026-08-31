import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSiteExclusively } from './exclusive-build';

// Issue #6 deploys this site to a GitHub *project* page, which is served from
// `/<repository>/` rather than from the domain root. Every other test in this
// repository exercises the site at a root base or passes `basePath` to a single
// component; neither notices the failure that matters here, because a build that
// emits `/tree/` instead of `/ModelTree/tree/` renders perfectly at the root and
// 404s everywhere in production.
//
// So this builds the real site the way the deploy builds it, under a base path
// that is deliberately *not* the production one -- a build that hard-coded
// `/ModelTree/` somewhere would pass a test that used `/ModelTree/` too.
//
// Nothing here counts pages or links. The dataset decides both, and an assertion
// on either would redden on the next data refresh while claiming to be about
// base paths.

const BASE_PATH = '/base-path-probe/';
const SITE_URL = 'https://example.invalid';

const outDir = mkdtempSync(join(tmpdir(), 'modeltree-base-path-'));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * The deploy job's environment, reproduced honestly.
 *
 * `BASE_URL` has to be removed rather than merely left unset. Vitest puts
 * `BASE_URL=/` into `process.env` for the worker, and Astro copies `process.env`
 * onto `import.meta.env`, where it wins over the value derived from `base`. An
 * inherited `BASE_URL` therefore un-prefixes every link in the child build and
 * this file fails against a site that is perfectly correct -- which is what
 * happened when it was first written. A GitHub Actions runner sets no
 * `BASE_URL`, so dropping it is what makes this build the deploy's build.
 */
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

/** Every root-relative `href` or `src` the build emitted, with the page it is on. */
const rootRelative = pages.flatMap(({ route, html }) =>
  [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => ({ route, url: match[1] })),
);

describe('a production build under a non-root base path', () => {
  it('builds at all, and generates pages', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  // The regression this whole file exists for. One `href="/tree/"` written as a
  // literal instead of through `import.meta.env.BASE_URL` lands here.
  it('prefixes every root-relative link and asset with the base path', () => {
    const escaped = rootRelative.filter(({ url }) => !url.startsWith(BASE_PATH));

    expect(
      escaped.map(({ route, url }) => `${route}: ${url}`),
      'these resolve above the project base path and 404 in production',
    ).toEqual([]);
  });

  it('emits root-relative URLs at all, so the check above is not vacuous', () => {
    expect(rootRelative.length).toBeGreaterThan(0);
  });

  // Direct navigation, named in the issue title. GitHub Pages has no SPA
  // fallback, so a route only works if the build wrote an index.html for it.
  it.each(['index.html', 'tree/index.html', 'refresh/index.html'])(
    'generates %s, so the route survives direct navigation',
    (route) => {
      expect(statSync(join(outDir, ...route.split('/'))).isFile()).toBe(true);
    },
  );

  it('ships the stylesheet and script assets under the base path too', () => {
    const assets = rootRelative.filter(({ url }) => /\.(?:css|js)(?:\?|$)/.test(url));

    expect(assets.length, 'expected the build to emit CSS or JS assets').toBeGreaterThan(0);

    for (const { route, url } of assets) {
      expect(url, `${route} loads an asset from outside the base path`).toMatch(BASE_PATH);
    }
  });

  it('resolves the favicon through the base path rather than the domain root', () => {
    const home = pages.find(({ route }) => route === 'index.html');
    const icon = String(home?.html.match(/<link rel="icon"[^>]*href="([^"]*)"/)?.[1]);

    expect(icon).toBe(`${BASE_PATH}favicon.svg`);
  });
}, 300_000);
