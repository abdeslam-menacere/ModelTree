import { describe, expect, it } from 'vitest';

import { isStylesheetRel, startTags, stylesheetHrefs } from './html-scan.mjs';

/**
 * #1081: the critical-path scanner found stylesheets with a pattern that
 * demanded `rel` before `href` and double quotes around both, so valid markup
 * spelled any other way was invisible to it. A miss subtracts bytes rather than
 * raising, so the route came out SMALLER and its budget passed when it should
 * have failed.
 *
 * The first block below is the red-before-green arm, kept executable rather than
 * described: the retired pattern is quoted verbatim and RUN against the same
 * inputs as the replacement, so the failure it was reported for is demonstrated
 * on every run instead of asserted once in a commit message.
 *
 * Every absence asserted here is paired with a presence from the same call in
 * the same run. A scanner that returned nothing for everything would satisfy all
 * the `rel="preload"` arms on its own, and would be exactly the defect under
 * repair -- so those arms are only worth something next to a spelling the same
 * call is required to find.
 */

/** The pattern this issue retired, quoted exactly as it stood in `asset-budget.mjs`. */
const LEGACY = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g;

function legacyHrefs(html: string): string[] {
  return [...html.matchAll(new RegExp(LEGACY.source, 'g'))].map((m) => m[1]);
}

const HREF = '/_astro/page.css';

/** One stylesheet, written the ways a browser treats identically. */
const SPELLINGS: Array<{ label: string; html: string; legacyFinds: boolean }> = [
  { label: 'rel first, double quotes', html: `<link rel="stylesheet" href="${HREF}">`, legacyFinds: true },
  { label: 'href first, double quotes', html: `<link href="${HREF}" rel="stylesheet">`, legacyFinds: false },
  { label: 'single quotes', html: `<link rel='stylesheet' href='${HREF}'>`, legacyFinds: false },
  { label: 'unquoted values', html: `<link rel=stylesheet href=${HREF}>`, legacyFinds: false },
  { label: 'uppercase names', html: `<LINK REL="STYLESHEET" HREF="${HREF}">`, legacyFinds: false },
  { label: 'mixed quoting, href first', html: `<link href='${HREF}' rel="stylesheet">`, legacyFinds: false },
  { label: 'self-closing', html: `<link rel="stylesheet" href="${HREF}" />`, legacyFinds: true },
  { label: 'newline-separated attributes', html: `<link\n  rel="stylesheet"\n  href="${HREF}"\n>`, legacyFinds: true },
  { label: 'newline-separated, href first', html: `<link\n  href="${HREF}"\n  rel="stylesheet"\n>`, legacyFinds: false },
  { label: 'media between rel and href', html: `<link rel="stylesheet" media="all" href="${HREF}">`, legacyFinds: true },
  { label: 'media first, href second', html: `<link media="all" href="${HREF}" rel="stylesheet">`, legacyFinds: false },
  { label: 'rel token list, spaced', html: `<link rel=" stylesheet " href="${HREF}">`, legacyFinds: false },
];

describe('the defect this replaces, demonstrated rather than asserted', () => {
  it('the retired pattern misses valid spellings that the replacement finds', () => {
    const missedByLegacy = SPELLINGS.filter((s) => legacyHrefs(s.html).length === 0);
    const foundByNew = SPELLINGS.filter((s) => stylesheetHrefs(s.html).length === 1);

    // The instrument discriminates: the legacy pattern is not blind to
    // everything, it is blind to a specific and large subset.
    expect(missedByLegacy.length).toBeGreaterThan(0);
    expect(missedByLegacy.length).toBeLessThan(SPELLINGS.length);
    expect(foundByNew).toHaveLength(SPELLINGS.length);

    expect(missedByLegacy.map((s) => s.label)).toEqual(
      SPELLINGS.filter((s) => !s.legacyFinds).map((s) => s.label),
    );
  });

  it.each(SPELLINGS)('finds $label', ({ html, legacyFinds }) => {
    expect(stylesheetHrefs(html)).toEqual([HREF]);
    // Pinned in both directions so the row above cannot quietly stop being a
    // regression arm if someone "improves" the retired pattern in this file.
    expect(legacyHrefs(html).length > 0).toBe(legacyFinds);
  });

  it('resolves every spelling to the same stylesheet set', () => {
    const sets = SPELLINGS.map((s) => JSON.stringify(stylesheetHrefs(s.html)));
    expect(new Set(sets).size).toBe(1);
  });
});

describe('rel is a case-insensitive token list, not a string', () => {
  it.each([
    ['stylesheet', true],
    ['StyleSheet', true],
    ['  stylesheet  ', true],
    ['stylesheet ', true],
    ['preload', false],
    ['modulepreload', false],
    ['icon', false],
    ['shortcut icon', false],
    ['manifest', false],
    ['prefetch', false],
    ['preconnect', false],
    ['dns-prefetch', false],
    ['alternate', false],
    ['alternate stylesheet', false],
    ['stylesheetish', false],
    ['', false],
  ])('rel=%j is a render-blocking stylesheet: %s', (rel, expected) => {
    expect(isStylesheetRel(rel)).toBe(expected);
  });

  it('treats a missing rel as not a stylesheet', () => {
    expect(isStylesheetRel(undefined)).toBe(false);
  });

  it('does not admit a preload hint pointing at a .css file', () => {
    const html = `<link rel="preload" as="style" href="/_astro/page.css">`;
    expect(stylesheetHrefs(html)).toEqual([]);
    // The positive control, same call, same run: absence above is a property of
    // the input rather than of the scanner.
    expect(stylesheetHrefs(`${html}<link rel="stylesheet" href="/_astro/real.css">`)).toEqual([
      '/_astro/real.css',
    ]);
  });

  it('does not admit an alternate stylesheet, which no first paint applies', () => {
    const alt = `<link rel="alternate stylesheet" href="/_astro/dark.css" title="Dark">`;
    const real = `<link rel="stylesheet" href="/_astro/page.css">`;
    expect(stylesheetHrefs(alt + real)).toEqual(['/_astro/page.css']);
  });
});

describe('attribute reading', () => {
  it('keeps the first value of a duplicated attribute, as a parser does', () => {
    const [tag] = [...startTags(`<link href="/first.css" href="/second.css" rel="stylesheet">`)];
    expect(tag.attrs.get('href')).toBe('/first.css');
  });

  it('records a valueless attribute as present and empty', () => {
    const [tag] = [...startTags(`<script defer src="/_astro/app.js"></script>`)];
    expect(tag.attrs.get('defer')).toBe('');
    expect(tag.attrs.has('defer')).toBe(true);
    expect(tag.attrs.has('async')).toBe(false);
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(stylesheetHrefs(`<link rel = "stylesheet"   href =  "/_astro/page.css" >`)).toEqual([
      '/_astro/page.css',
    ]);
  });

  it('ends an unquoted value at whitespace and at nothing else', () => {
    const [tag] = [...startTags(`<link rel=stylesheet href=/_astro/page.css/>`)];
    // A browser reads the trailing slash as part of an unquoted value too; the
    // scanner is not quietly tidier than the thing it measures.
    expect(tag.attrs.get('href')).toBe('/_astro/page.css/');
  });

  it('emits nothing for a stylesheet link with no href', () => {
    expect(stylesheetHrefs(`<link rel="stylesheet">`)).toEqual([]);
    expect(stylesheetHrefs(`<link rel="stylesheet" href="">`)).toEqual([]);
  });

  it('preserves document order across several links', () => {
    const html = [
      `<link rel="preload" as="style" href="/_astro/a.css">`,
      `<link href="/_astro/b.css" rel="stylesheet">`,
      `<link rel='stylesheet' href='/_astro/c.css'>`,
    ].join('\n');
    expect(stylesheetHrefs(html)).toEqual(['/_astro/b.css', '/_astro/c.css']);
  });
});

describe('what is markup and what is only text that looks like it', () => {
  it('ignores a link written inside a comment', () => {
    // The `>` before the link is load-bearing. Without it, a scanner that does
    // not understand comments at all still resynchronises on the link's own `>`
    // and skips it by accident -- so the obvious fixture passes whether or not
    // comments are handled, and asserts nothing. This one separates the two:
    // read as a comment it yields one href, read as markup it yields two.
    const html = `<!-- see also: a > b <link rel="stylesheet" href="/_astro/commented.css"> --><link rel="stylesheet" href="/_astro/real.css">`;
    expect(stylesheetHrefs(html)).toEqual(['/_astro/real.css']);
  });

  it('ends a comment at its own terminator and reads markup after it', () => {
    const html = `<!-- unclosed-looking > content --><link href="/_astro/after.css" rel="stylesheet">`;
    expect(stylesheetHrefs(html)).toEqual(['/_astro/after.css']);
  });

  it('ignores markup inside a script body', () => {
    const html = [
      `<script>const s = '<link rel="stylesheet" href="/_astro/injected.css">';</script>`,
      `<link rel="stylesheet" href="/_astro/real.css">`,
    ].join('');
    expect(stylesheetHrefs(html)).toEqual(['/_astro/real.css']);
  });

  it('still sees the script tag itself while skipping its body', () => {
    const html = `<script src="/_astro/app.js">var x = "<img src=/_astro/inner.png>";</script>`;
    const names = [...startTags(html)].map((t) => t.name);
    expect(names).toEqual(['script']);
  });

  it('skips nothing when a raw-text element is never closed', () => {
    // The recoverable direction. Swallowing the rest of the document would be a
    // silent under-count, which is the failure class this issue exists to end.
    const html = `<script src="/_astro/app.js"><link rel="stylesheet" href="/_astro/after.css">`;
    expect(stylesheetHrefs(html)).toEqual(['/_astro/after.css']);
  });

  it('treats a bare angle bracket in text as text', () => {
    const html = `<p>widths < 640px</p><link rel="stylesheet" href="/_astro/page.css">`;
    expect(stylesheetHrefs(html)).toEqual(['/_astro/page.css']);
  });

  it('skips the doctype and end tags without consuming what follows', () => {
    const html = `<!doctype html><html><head></head><link rel="stylesheet" href="/_astro/page.css"></html>`;
    expect(stylesheetHrefs(html)).toEqual(['/_astro/page.css']);
  });

  it('finds nothing in a document with no links at all', () => {
    expect(stylesheetHrefs(`<!doctype html><html><body><p>none</p></body></html>`)).toEqual([]);
  });
});

describe('the sibling scanners this issue also covers', () => {
  // These four shared the double-quote assumption with the stylesheet pattern.
  // They are read through the same tag stream now, so one set of arms covers
  // all of them.
  it.each([
    [`<script src='/_astro/app.js'></script>`, 'script', 'src', '/_astro/app.js'],
    [`<script src=/_astro/app.js></script>`, 'script', 'src', '/_astro/app.js'],
    [`<img alt="" src='/_astro/hero.png'>`, 'img', 'src', '/_astro/hero.png'],
    [`<astro-island component-url='/_astro/w.js'></astro-island>`, 'astro-island', 'component-url', '/_astro/w.js'],
    [`<astro-island renderer-url=/_astro/r.js></astro-island>`, 'astro-island', 'renderer-url', '/_astro/r.js'],
  ])('reads %s', (html, tagName, attr, expected) => {
    const tag = [...startTags(html)].find((t) => t.name === tagName);
    expect(tag?.attrs.get(attr)).toBe(expected);
  });
});
