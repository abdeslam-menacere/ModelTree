import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * The brand mark (issue #31).
 *
 * The mark exists in four places, for four reasons that cannot be collapsed:
 *
 *   BrandMark.astro          inline, so it reads the token layer and the theme
 *   public/favicon.svg       standalone, because `<link rel="icon">` needs a file
 *   public/mask-icon.svg     monochrome silhouette for Safari pinned tabs
 *   docs/assets/…-logo.svg   literal colours, because GitHub strips style blocks
 *
 * Four copies of one drawing is four chances to drift. The geometry is therefore
 * extracted from each file and compared, rather than trusted to the comments in
 * them that say they match.
 *
 * What this file cannot do is tell whether the result is legible. jsdom does not
 * rasterise, so "the stroke is thick enough at 16px" is checked here as the
 * arithmetic it is, and `e2e/brand-mark.e2e.ts` renders the file in a real engine
 * and measures the ink.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const SOURCES = {
  inline: here('./BrandMark.astro'),
  favicon: here('../../public/favicon.svg'),
  maskIcon: here('../../public/mask-icon.svg'),
  docsLogo: here('../../../docs/assets/modeltree-logo.svg'),
} as const;

const read = (key: keyof typeof SOURCES) => readFileSync(SOURCES[key], 'utf8');

/** The `d` of the branch path, whitespace-normalised. */
function pathData(source: string): string | undefined {
  return source.match(/d="([^"]+)"/)?.[1].replace(/\s+/g, ' ').trim();
}

function strokeWidth(source: string): number | undefined {
  const raw = source.match(/stroke-width="([\d.]+)"/)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

/** Every node circle, as `cx,cy,r`. */
function nodes(source: string): string[] {
  return [...source.matchAll(/<circle\s+cx="([\d.]+)"\s+cy="([\d.]+)"\s+r="([\d.]+)"/g)].map(
    (match) => `${match[1]},${match[2]},${match[3]}`,
  );
}

/** The viewBox edge length. Every copy is square. */
function viewBox(source: string): number | undefined {
  const raw = source.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!raw) return undefined;

  expect(raw[1], 'the mark is not square, so one edge cannot stand for both').toBe(raw[2]);
  return Number(raw[1]);
}

/**
 * Horizontal extent of a path, walking the line commands this mark uses.
 *
 * Reading coordinates straight out of the `d` string with a regex does not work
 * and fails quietly: this path states its width entirely in *relative* segments
 * (`l19 20 19-20`), so a pattern anchored on absolute commands sees only the two
 * `M` points and under-reports the span by half.
 */
function xExtent(d: string): { min: number; max: number } {
  let x = 0;
  let min = Infinity;
  let max = -Infinity;
  const mark = () => {
    min = Math.min(min, x);
    max = Math.max(max, x);
  };

  for (const segment of d.match(/[MmLlHhVv][^MmLlHhVvZz]*/g) ?? []) {
    const args = (segment.slice(1).match(/-?[\d.]+/g) ?? []).map(Number);

    switch (segment[0]) {
      case 'M':
      case 'L':
        for (let i = 0; i < args.length; i += 2) {
          x = args[i];
          mark();
        }
        break;
      case 'm':
      case 'l':
        for (let i = 0; i < args.length; i += 2) {
          x += args[i];
          mark();
        }
        break;
      case 'H':
        for (const arg of args) {
          x = arg;
          mark();
        }
        break;
      case 'h':
        for (const arg of args) {
          x += arg;
          mark();
        }
        break;
      // Vertical segments cannot move x, but they still occupy the current one.
      case 'V':
      case 'v':
        mark();
        break;
    }
  }

  return { min, max };
}

describe('the four copies of the mark are one drawing', () => {
  const keys = Object.keys(SOURCES) as (keyof typeof SOURCES)[];

  it('draws the same branch path in every copy', () => {
    const drawn = keys.map((key) => [key, pathData(read(key))] as const);

    for (const [key, data] of drawn) {
      expect(data, `${key} has no path data at all`).toBeDefined();
    }

    const [, reference] = drawn[0];
    for (const [key, data] of drawn.slice(1)) {
      expect(data, `${key} has drifted from ${drawn[0][0]}`).toBe(reference);
    }
  });

  it('uses the same stroke weight and the same three nodes in every copy', () => {
    const reference = { width: strokeWidth(read('favicon')), nodes: nodes(read('favicon')) };

    expect(reference.nodes, 'the mark should carry three release nodes').toHaveLength(3);

    for (const key of keys) {
      const source = read(key);
      expect(strokeWidth(source), `${key} stroke weight has drifted`).toBe(reference.width);
      expect(nodes(source), `${key} nodes have drifted`).toEqual(reference.nodes);
    }
  });

  it('keeps every copy on the same square viewBox', () => {
    for (const key of keys) {
      expect(viewBox(read(key)), `${key} viewBox has drifted`).toBe(64);
    }
  });
});

describe('the mark survives favicon scale', () => {
  const source = read('favicon');
  const edge = viewBox(source)!;
  const width = strokeWidth(source)!;
  const radius = Number(nodes(source)[0].split(',')[2]);

  /** What one viewBox unit becomes on a 16px favicon at 1x. */
  const at16 = 16 / edge;

  it('draws a stroke at least one and a half device pixels wide at 16px', () => {
    // The pre-#31 mark was stroke 5 on a 64 viewBox, which is 1.25 device pixels
    // at 16px -- thin enough to be antialiased into a grey smear on a 1x display.
    // 1.5 is the floor at which a line still reads as a line.
    expect(width * at16).toBeGreaterThanOrEqual(1.5);
  });

  it('keeps the nodes visibly larger than the branches they cap', () => {
    // If a node is not clearly wider than the stroke it terminates, it stops
    // reading as a node and the mark becomes an undifferentiated glyph. The
    // previous mark had a diameter-to-stroke ratio of 1.6; this asserts the
    // refinement did not regress it.
    expect((radius * 2) / width).toBeGreaterThanOrEqual(1.75);
  });

  it('uses enough of the canvas to carry weight at small sizes', () => {
    // Ink inset in the middle of its own box wastes the few pixels a favicon
    // gets. Measured from the path's own extents rather than assumed, and the
    // floor is set where the previous mark fell short: it spanned 34 of 64
    // units (0.53), this one spans 38 (0.59).
    const { min, max } = xExtent(pathData(source)!);

    expect(max - min).toBeGreaterThan(0);
    expect((max - min) / edge).toBeGreaterThanOrEqual(0.55);
  });
});

describe('the mark is decorative, and the wordmark carries the name', () => {
  const source = read('inline');

  it('hides the inline mark from assistive technology', () => {
    // The anchor is labelled and the wordmark repeats it in text. Naming the
    // mark as well would announce the brand three times for one link.
    expect(source).toMatch(/<svg[^>]*aria-hidden="true"/s);
    expect(source).toMatch(/<svg[^>]*focusable="false"/s);
  });

  it('labels the link and keeps the text fallback', () => {
    expect(source).toContain('aria-label="ModelTree home"');
    expect(source).toContain('<strong>ModelTree</strong>');
    expect(source).toContain('<small>AI Model Lineage</small>');
  });

  it('draws the inline copy from tokens, so it follows the theme', () => {
    // This is the whole reason the mark is inlined rather than left as an
    // `<img>`: a separate document cannot see `html[data-theme]`. The markup is
    // read with comments removed, because the comment above the markup discusses
    // the `<img>` it replaced and would otherwise match.
    const markup = source.replace(/<!--[\s\S]*?-->/g, '');

    expect(markup).toContain('stroke="var(--cp-accent)"');
    expect(markup).toContain('fill="var(--cp-text)"');
    expect(markup, 'the inline mark should not reintroduce an <img> request').not.toContain('<img');
    expect(source, 'comment stripping removed the markup as well').toContain('<svg');
  });

  it('keeps literal colours in the copy GitHub renders', () => {
    // The docs logo cannot use custom properties: GitHub's markdown sanitizer
    // strips style blocks, and an `<svg>` referencing undefined properties
    // renders as an empty square. Its own comment says so; this checks it.
    const docs = read('docsLogo');

    expect(docs).toMatch(/stroke="#[0-9a-f]{6}"/i);
    expect(docs).not.toContain('var(--');
    expect(docs).not.toContain('<style');
  });

  it('keeps the pinned-tab copy monochrome and unbounded', () => {
    // A mask icon is a silhouette. A filled ground would mask the entire square
    // and hide the mark inside it.
    const mask = read('maskIcon');

    expect(mask).not.toContain('<rect');
    expect([...mask.matchAll(/#[0-9a-f]{6}/gi)].map((match) => match[0].toLowerCase())).toEqual([
      '#000000',
      '#000000',
      '#000000',
      '#000000',
    ]);
  });
});

describe('the brand assets stay inside the byte budget', () => {
  // Every one of these is fetched or inlined on every page view. They are small
  // by construction -- hand-written SVG, no rasterised variants, no embedded
  // fonts -- and this keeps them that way. The numbers are roughly 3x current
  // size, which leaves room for an honest edit without leaving room for a
  // pasted export from a drawing tool.
  const BUDGET = 4096;

  it.each(['favicon', 'maskIcon', 'docsLogo'] as const)('%s is under 4KB', (key) => {
    expect(statSync(SOURCES[key]).size).toBeLessThan(BUDGET);
  });

  it('adds no binary asset alongside the vector ones', () => {
    // PNG and ICO variants would need a rasteriser this repo does not have, and
    // adding one for a cosmetic artefact is a dependency this issue declined to
    // take. Recorded so that a later change makes the decision deliberately.
    expect(() => statSync(here('../../public/favicon.png'))).toThrow();
    expect(() => statSync(here('../../public/apple-touch-icon.png'))).toThrow();
  });
});

describe('the standalone assets are well-formed XML', () => {
  // Not pedantry, and not hypothetical: this caught the favicon shipping with
  // `-- ` inside a comment, which is illegal XML. An HTML parser is lenient and
  // the inline copy renders fine, but a standalone `.svg` is parsed strictly, so
  // the file decoded to nothing while looking entirely correct in an editor.
  // Nothing else in the suite would have noticed -- the geometry assertions read
  // the text, not the rendering.
  const standalone = ['favicon', 'maskIcon', 'docsLogo'] as const;

  // jsdom is pulled in directly rather than by switching the whole file to the
  // jsdom environment: everything else here reads the filesystem and has no use
  // for a DOM, and only this block needs a strict XML parser.
  const { DOMParser } = new JSDOM().window;
  const parse = (source: string) => new DOMParser().parseFromString(source, 'image/svg+xml');

  it.each(standalone)('parses %s without an XML error', (key) => {
    const parsed = parse(read(key));

    expect(
      parsed.querySelector('parsererror')?.textContent ?? null,
      `${SOURCES[key]} is not well-formed XML, so a browser renders nothing`,
    ).toBeNull();
    expect(parsed.documentElement.tagName).toBe('svg');
  });

  it.each(standalone)('keeps %s free of a double hyphen inside a comment', (key) => {
    for (const comment of read(key).match(/<!--[\s\S]*?-->/g) ?? []) {
      expect(comment.slice(4, -3)).not.toContain('--');
    }
  });

  it('reports malformed XML as malformed', () => {
    // The control. A parser that silently accepts anything would make every
    // assertion above vacuous, so the exact defect that occurred is replayed.
    expect(
      parse('<svg xmlns="http://www.w3.org/2000/svg"><!-- issue #31 -- refined --></svg>')
        .querySelector('parsererror'),
    ).not.toBeNull();
  });
});

describe('the checks above can fail', () => {
  it('extracts geometry rather than returning undefined everywhere', () => {
    const source = read('favicon');

    expect(pathData(source)).toContain('M13 50');
    expect(strokeWidth(source)).toBe(6);
    expect(nodes(source)).toHaveLength(3);
    expect(viewBox(source)).toBe(64);
  });

  it('notices drift when a copy really has drifted', () => {
    const drifted = read('favicon').replace('stroke-width="6"', 'stroke-width="5"');

    expect(strokeWidth(drifted)).not.toBe(strokeWidth(read('favicon')));
  });

  it('would have failed the 16px floor on the previous mark', () => {
    // The refinement is only worth making if the old geometry did not clear the
    // bar. Stroke 5 on a 64 viewBox is 1.25 device pixels at 16px.
    expect((5 * 16) / 64).toBeLessThan(1.5);
  });

  it('measures relative path segments, not only absolute ones', () => {
    // Written after getting this wrong. The first version of the extent check
    // matched `[ML](\d+) (\d+)` and reported this mark as spanning 0.30 of its
    // canvas when it spans 0.59, because the width is stated in relative `l`
    // segments a pattern anchored on `M` and `L` never sees. An under-reporting
    // measurement fails safe here -- but the same blind spot in a check written
    // the other way round would pass a mark that had collapsed to a stripe.
    expect(xExtent('M13 50V17l19 20 19-20v33M32 37V18')).toEqual({ min: 13, max: 51 });
    expect(xExtent('M10 0H30')).toEqual({ min: 10, max: 30 });
    expect(xExtent('M10 0h20')).toEqual({ min: 10, max: 30 });
  });

  it('reports the previous mark as narrower than the floor', () => {
    // The same walker on the pre-#31 path, which spanned 15..49 of 64 units.
    const previous = xExtent('M15 48V18l17 18 17-18v30M32 36V19');

    expect((previous.max - previous.min) / 64).toBeLessThan(0.55);
  });
});
