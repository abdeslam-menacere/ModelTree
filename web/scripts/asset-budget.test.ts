import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { analyzeRoute } from './asset-budget.mjs';

/**
 * #1081, the case that actually costs something: a route whose budget is BORN
 * WRONG.
 *
 * `asset-drift.mjs` compares a measurement against a recorded baseline, so it
 * detects change and never wrongness. A stylesheet missed at the moment a new
 * route's budget is first recorded therefore produces a baseline that is wrong
 * from birth, a drift delta of zero forever, and no report from anything. The
 * miss is silent and in the reassuring direction -- the route measures SMALLER,
 * so its ceiling passes.
 *
 * Proving the scanner can now see a stylesheet is the weaker claim. What is
 * asserted here is the whole consequence: two routes with byte-identical assets,
 * differing only in how their `<link>` is spelled, must record the SAME budget,
 * and the retired pattern is run in the same test to show what that budget would
 * otherwise have been born as.
 *
 * The fixture is a hand-built dist rather than a real build, deliberately. Astro
 * emits `<link rel="stylesheet" href="...">` today, which the retired pattern
 * handles, so a real build cannot exhibit the defect -- the issue's own comment
 * records that matrix. A fixture is the only instrument that reaches it.
 */

/** The pattern this issue retired, quoted exactly as it stood in `asset-budget.mjs`. */
function legacyCssNames(html: string): string[] {
  return [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) =>
    m[1].slice(m[1].lastIndexOf('/') + 1),
  );
}

const FONT_BYTES = 4096;
const CSS = [
  '@font-face{font-family:Probe;font-display:swap;src:url(./probe.woff2) format("woff2")}',
  `:root{--probe:1}${'/* padding so the stylesheet is unmistakably non-empty */'.repeat(20)}`,
].join('\n');

const dist = mkdtempSync(join(tmpdir(), 'modeltree-budget-1081-'));
mkdirSync(join(dist, '_astro'), { recursive: true });
writeFileSync(join(dist, '_astro', 'probe.css'), CSS);
writeFileSync(join(dist, '_astro', 'probe.woff2'), Buffer.alloc(FONT_BYTES, 7));

const BODY = '<!doctype html><html><head>{LINK}</head><body><h1>Probe</h1></body></html>';

/**
 * One route per spelling. Identical assets, identical body, identical bytes
 * except inside the `<link>` itself -- so any difference in the recorded budget
 * is caused by the spelling and by nothing else.
 */
const ROUTES: Array<{ id: string; link: string; visibleToLegacy: boolean }> = [
  {
    id: 'astro-today',
    link: '<link rel="stylesheet" href="/_astro/probe.css">',
    visibleToLegacy: true,
  },
  { id: 'href-first', link: '<link href="/_astro/probe.css" rel="stylesheet">', visibleToLegacy: false },
  { id: 'single-quoted', link: "<link rel='stylesheet' href='/_astro/probe.css'>", visibleToLegacy: false },
  { id: 'unquoted', link: '<link rel=stylesheet href=/_astro/probe.css>', visibleToLegacy: false },
  { id: 'uppercase', link: '<LINK REL="STYLESHEET" HREF="/_astro/probe.css">', visibleToLegacy: false },
];

for (const route of ROUTES) {
  mkdirSync(join(dist, route.id), { recursive: true });
  writeFileSync(join(dist, route.id, 'index.html'), BODY.replace('{LINK}', route.link));
}

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

const measure = (id: string) => analyzeRoute(dist, `${id}/index.html`);

describe('a route whose budget would have been born wrong', () => {
  it('the fixture reaches the defect: the retired pattern sees one route and misses four', () => {
    // Discrimination first. If the retired pattern missed every route here, the
    // fixture would be proving that the pattern is broken rather than that these
    // four spellings are the ones it cannot read.
    const visible = ROUTES.filter((r) => legacyCssNames(BODY.replace('{LINK}', r.link)).length > 0);
    expect(visible.map((r) => r.id)).toEqual(['astro-today']);
    expect(ROUTES.length - visible.length).toBe(4);
  });

  it.each(ROUTES)('records the correct critical budget for $id', ({ id }) => {
    const { totals } = measure(id);
    expect(totals.css.count).toBe(1);
    expect(totals.css.raw).toBe(Buffer.byteLength(CSS));
    expect(totals.critical.raw).toBe(totals.html.raw + totals.css.raw);
  });

  it('gives every spelling the same budget as the one Astro emits today', () => {
    const reference = measure('astro-today').totals;
    for (const route of ROUTES) {
      const totals = measure(route.id).totals;
      // The HTML differs by the length of the link itself, so critical is
      // compared net of it. Everything downstream of discovery must be equal.
      expect({ css: totals.css, font: totals.font, js: totals.js }).toEqual({
        css: reference.css,
        font: reference.font,
        js: reference.js,
      });
      expect(totals.critical.raw - totals.html.raw).toBe(
        reference.critical.raw - reference.html.raw,
      );
    }
  });

  it('carries the font cascade with the stylesheet it was missed with', () => {
    // The amplification the issue names: fonts are derived from the stylesheet
    // set, so a missed <link> silently removes TWO categories, not one.
    for (const route of ROUTES) {
      const { totals } = measure(route.id);
      expect(totals.font.count).toBe(1);
      expect(totals.font.raw).toBe(FONT_BYTES);
    }
  });

  it('quantifies what each budget would have been born as', () => {
    const bornWrong = ROUTES.filter((r) => !r.visibleToLegacy);
    expect(bornWrong.length).toBeGreaterThan(0);

    for (const route of bornWrong) {
      const { totals } = measure(route.id);
      // What the retired pattern would have attributed: no stylesheet, so no
      // css bytes and -- through the cascade -- no font bytes either.
      const wouldHaveSeen = legacyCssNames(BODY.replace('{LINK}', route.link));
      expect(wouldHaveSeen).toEqual([]);

      const bornCritical = totals.html.raw;
      const trueCritical = totals.critical.raw;
      expect(trueCritical).toBeGreaterThan(bornCritical);
      expect(trueCritical - bornCritical).toBe(totals.css.raw);
      // And the font total the global budget would never have been charged.
      expect(totals.font.raw).toBe(FONT_BYTES);
    }
  });

  it('under-counts, which is why nothing ever reported it', () => {
    // The direction is the whole danger: a miss makes a route look SMALLER, so
    // its ceiling passes. Pinned so a future change cannot make the failure
    // loud in one direction and assume it was always so.
    const truthful = measure('astro-today').totals.critical.raw;
    const wrong = measure('href-first').totals.html.raw;
    expect(wrong).toBeLessThan(truthful);
  });
});

describe('the sibling scanners, on the same fixture', () => {
  it('reads a single-quoted script src, which the retired pattern could not', () => {
    writeFileSync(join(dist, '_astro', 'probe.js'), 'export const probe = 1;\n');
    const id = 'sibling-script';
    mkdirSync(join(dist, id), { recursive: true });
    writeFileSync(
      join(dist, id, 'index.html'),
      BODY.replace('{LINK}', `<script src='/_astro/probe.js'></script>`),
    );

    const { totals } = measure(id);
    expect(totals.js.count).toBe(1);
    expect(totals.js.raw).toBe(Buffer.byteLength('export const probe = 1;\n'));

    // Same call, same run, a route that genuinely has no script: the count above
    // is a property of the input and not a scanner that answers 1 to everything.
    expect(measure('astro-today').totals.js.count).toBe(0);
  });

  it('reads an unquoted img src, which the retired pattern could not', () => {
    writeFileSync(join(dist, '_astro', 'probe.png'), Buffer.alloc(512, 3));
    const id = 'sibling-img';
    mkdirSync(join(dist, id), { recursive: true });
    writeFileSync(
      join(dist, id, 'index.html'),
      BODY.replace('{LINK}', '<img alt="" src=/_astro/probe.png>'),
    );

    const { totals } = measure(id);
    expect(totals.img.count).toBe(1);
    expect(totals.img.raw).toBe(512);
    expect(measure('astro-today').totals.img.count).toBe(0);
  });

  it('does not charge a route for markup that only appears inside a script body', () => {
    const id = 'script-body';
    mkdirSync(join(dist, id), { recursive: true });
    writeFileSync(
      join(dist, id, 'index.html'),
      BODY.replace(
        '{LINK}',
        `<script>const s = '<link rel="stylesheet" href="/_astro/probe.css">';</script>`,
      ),
    );
    expect(measure(id).totals.css.count).toBe(0);
    // The control: the same stylesheet, spelled as markup, is charged.
    expect(measure('astro-today').totals.css.count).toBe(1);
  });
});
