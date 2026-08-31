// Deterministic asset-budget measurement for the built site.
//
// Issue #33 separates *deterministic byte budgets* (this module) from *variable
// lab metrics* (Lighthouse, reported not gated). Everything here is computed by
// reading the build output off disk -- file byte lengths and in-process
// gzip/brotli of those exact bytes -- so the same commit yields the same numbers
// on any machine. Nothing here parses another tool's console output, which is
// the class of check that reddens on CI alone when a colouriser rewrites a
// human-readable summary (the raw byte length of a file has no such ambiguity).
//
// Gating is on **raw** bytes: a pure file size, with no compressor and therefore
// no zlib-version variance between a contributor's Node and CI's. gzip and
// brotli are computed too, but only to *report* a realistic transfer figure.
//
// Per-route accounting sums only what a route's HTML references as a
// render/hydration resource: its linked stylesheets, the JavaScript an
// `astro-island` hydrates through (`component-url` + `renderer-url` and their
// transitive `_astro` imports), any `<script src>`, and content `<img>`. It does
// NOT sum every file in the build. An `og:image` *meta* tag (issue #34's single
// static card) is none of those, so that asset is excluded by construction --
// it is fetched by social scrapers, never by a visitor on a route.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

/** raw / gzip / brotli byte lengths of a buffer. */
export function sizes(buf) {
  return { raw: buf.length, gzip: gzipSync(buf).length, brotli: brotliCompressSync(buf).length };
}

/**
 * Sizes of an `_astro/` file, memoised by name. `_astro` names are
 * content-hashed and unique within a build, so caching by name is safe and lets
 * a group scan compress each shared chunk (the React runtime, a stylesheet)
 * once instead of once per page. Returns null for a named-but-absent asset.
 */
function astroFileSizes(astroDir, name, cache) {
  if (cache.has(name)) return cache.get(name);
  let value = null;
  try {
    value = { path: name, ...sizes(readFileSync(join(astroDir, name))) };
  } catch {
    value = null;
  }
  cache.set(name, value);
  return value;
}

/** Reduce a URL (site-absolute or relative, any base path) to its `_astro/` filename. */
function astroName(url) {
  const u = String(url).split('?')[0].split('#')[0];
  const i = u.indexOf('/_astro/');
  if (i >= 0) return u.slice(i + '/_astro/'.length);
  const m = u.match(/([^/]+\.(?:js|css|woff2?))$/);
  return m ? m[1] : null;
}

/** Static `import`/`export ... from` specifiers a bundled `_astro` module pulls in. */
function importsOf(astroDir, name, cache) {
  if (cache.has(name)) return cache.get(name);
  let out = [];
  try {
    const src = readFileSync(join(astroDir, name), 'utf8');
    const re = /(?:import|export)[^"'`]*?["'`](\.\/[^"'`]+\.js)["'`]/g;
    out = [...src.matchAll(re)].map((m) => m[1].replace('./', ''));
  } catch {
    out = [];
  }
  cache.set(name, out);
  return out;
}

/** Transitive closure of `_astro` JS reachable from a set of entry modules. */
function jsGraph(astroDir, entries, cache) {
  const seen = new Set();
  const stack = [...entries].filter(Boolean);
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    for (const dep of importsOf(astroDir, n, cache)) stack.push(dep);
  }
  return [...seen];
}

/** woff2 files a stylesheet references through `@font-face`. */
function fontsOf(astroDir, cssName, cache) {
  if (cache.has(cssName)) return cache.get(cssName);
  let refs = [];
  try {
    const css = readFileSync(join(astroDir, cssName), 'utf8');
    refs = [...css.matchAll(/url\(([^)]*\.woff2?)[^)]*\)/g)].map((m) => astroName(m[1])).filter(Boolean);
  } catch {
    refs = [];
  }
  cache.set(cssName, refs);
  return refs;
}

function sumField(list, field) {
  return list.reduce((total, entry) => total + entry[field], 0);
}

/**
 * Analyse one route's HTML into byte categories.
 * @param {string} dist  build output directory
 * @param {string} routeHtml  path of the HTML file relative to `dist`
 * @param {{importCache: Map, fontCache: Map}} caches shared across routes
 */
export function analyzeRoute(dist, routeHtml, caches = { importCache: new Map(), fontCache: new Map(), sizeCache: new Map() }) {
  const astroDir = join(dist, '_astro');
  const sizeCache = caches.sizeCache ?? (caches.sizeCache = new Map());
  const html = readFileSync(join(dist, routeHtml), 'utf8');

  const jsEntries = new Set();
  for (const m of html.matchAll(/component-url="([^"]+)"/g)) jsEntries.add(astroName(m[1]));
  for (const m of html.matchAll(/renderer-url="([^"]+)"/g)) jsEntries.add(astroName(m[1]));
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const n = astroName(m[1]);
    if (n && n.endsWith('.js')) jsEntries.add(n);
  }

  const cssNames = new Set();
  for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
    const n = astroName(m[1]);
    if (n) cssNames.add(n);
  }

  const imgUrls = new Set();
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) imgUrls.add(m[1]);

  const fontNames = new Set();
  for (const c of cssNames) for (const f of fontsOf(astroDir, c, caches.fontCache)) fontNames.add(f);

  const jsFiles = jsGraph(astroDir, [...jsEntries], caches.importCache);

  const cats = { html: [], js: [], css: [], font: [], img: [] };
  cats.html.push({ path: routeHtml, ...sizes(Buffer.from(html)) });
  for (const n of jsFiles) {
    const s = astroFileSizes(astroDir, n, sizeCache);
    if (s) cats.js.push(s);
  }
  for (const n of cssNames) {
    const s = astroFileSizes(astroDir, n, sizeCache);
    if (s) cats.css.push(s);
  }
  for (const n of fontNames) {
    const s = astroFileSizes(astroDir, n, sizeCache);
    if (s) cats.font.push(s);
  }
  for (const u of imgUrls) {
    const n = astroName(u);
    if (!n) continue;
    // A content image outside _astro (e.g. /public) is not part of the hashed
    // budget; astroFileSizes returns null for it and it is skipped.
    const s = astroFileSizes(astroDir, n, sizeCache);
    if (s) cats.img.push(s);
  }

  const cat = (list) => ({
    raw: sumField(list, 'raw'),
    gzip: sumField(list, 'gzip'),
    brotli: sumField(list, 'brotli'),
    count: list.length,
  });
  const html_ = cat(cats.html);
  const js_ = cat(cats.js);
  const css_ = cat(cats.css);
  const font_ = cat(cats.font);
  const img_ = cat(cats.img);
  // Critical path: what a visitor pays to render + hydrate this route. Fonts are
  // shared, cached across routes and lazily fetched by glyph coverage, so they
  // are measured globally rather than charged to every route.
  const totals = {
    html: html_,
    js: js_,
    css: css_,
    font: font_,
    img: img_,
    critical: {
      raw: html_.raw + js_.raw + css_.raw,
      gzip: html_.gzip + js_.gzip + css_.gzip,
      brotli: html_.brotli + js_.brotli + css_.brotli,
    },
  };
  return { route: routeHtml, cats, totals };
}

/** List the `index.html` route files one level under `dist/<dir>/`. */
export function groupRoutes(dist, dir) {
  const base = join(dist, dir);
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${dir}/${e.name}/index.html`)
    .filter((rel) => {
      try {
        return statSync(join(dist, rel)).isFile();
      } catch {
        return false;
      }
    });
}

/** Worst-case (largest critical raw) route in a `dist/<dir>/` group of pages. */
export function groupWorst(dist, dir, caches) {
  const analyses = groupRoutes(dist, dir).map((rel) => analyzeRoute(dist, rel, caches));
  analyses.sort((a, b) => b.totals.critical.raw - a.totals.critical.raw);
  return analyses[0];
}

/** Whole-build sizes by asset kind across `_astro/`, plus the directory total. */
export function globalTotals(dist) {
  const astroDir = join(dist, '_astro');
  const kinds = { js: 0, css: 0, font: 0, other: 0 };
  let dirTotal = 0;
  for (const name of readdirSync(astroDir)) {
    let bytes = 0;
    try {
      bytes = statSync(join(astroDir, name)).size;
    } catch {
      continue;
    }
    dirTotal += bytes;
    if (name.endsWith('.js')) kinds.js += bytes;
    else if (name.endsWith('.css')) kinds.css += bytes;
    else if (name.endsWith('.woff') || name.endsWith('.woff2')) kinds.font += bytes;
    else kinds.other += bytes;
  }
  return { ...kinds, astroDir: dirTotal };
}
