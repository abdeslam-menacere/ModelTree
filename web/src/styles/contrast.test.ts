import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The palette, checked as arithmetic rather than as taste.
 *
 * This repository already writes contrast ratios into prose — `global.css` has a
 * comment block recording that `--cp-link` `#0078d4` on `#f7f4ef` is 4.12:1, and
 * `e2e/lineage-a11y.e2e.ts` records the same number as the one violation it
 * tolerates. Prose does not fail when a token moves underneath it. This does.
 *
 * It exists because of where the alternative lives. The browser-side check is
 * `e2e/lineage-a11y.e2e.ts`, which runs axe in a real engine — the right tool,
 * and a required status check, but it needs a Chromium download and a full site
 * build to tell you that one hex is two points of luminance too light. Every
 * value it would catch is decidable from the stylesheet alone, in milliseconds,
 * inside `npm run validate`. So this runs first and that runs as the backstop.
 *
 * What it deliberately does not do is replace axe. It reads declared token
 * pairs; axe reads what actually rendered, including colours arriving from
 * component styles, inline attributes and compositing this file cannot see.
 * A green run here is a necessary condition, not a sufficient one.
 */

const globalStyles = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

// --- Reading the token layer -------------------------------------------------

/**
 * Every declaration a selector makes, merged in source order.
 *
 * Merging matters: `global.css` is append-only by convention, so `:root` appears
 * more than once — the base palette at the top and issue #14's appended
 * `--cp-*-accessible` pair near the bottom. A parser that took the first block
 * and stopped would model a cascade the browser does not have.
 */
function tokensFor(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...globalStyles.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm'))];

  expect(blocks.length, `no ${selector} block found in global.css`).toBeGreaterThan(0);

  const tokens = new Map<string, string>();

  for (const block of blocks) {
    for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(name, value.trim());
    }
  }

  return tokens;
}

const LIGHT = tokensFor(':root');
const DARK = tokensFor('html[data-theme="dark"]');

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Resolve a token to a colour, following `var()` indirection within its theme.
 *
 * The dark theme defines `--cp-link-accessible: var(--cp-link)`, so indirection
 * is real and not hypothetical. The depth limit is what stops a cycle — a token
 * defined in terms of itself — from hanging the suite instead of failing it.
 */
function resolve(theme: Map<string, string>, token: string, depth = 0): string {
  expect(depth, `--cp token indirection too deep at ${token}; is there a cycle?`).toBeLessThan(10);

  const raw = theme.get(token);
  expect(raw, `${token} is not defined in this theme`).toBeDefined();

  const reference = raw?.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (reference) return resolve(theme, reference[1], depth + 1);

  return raw ?? '';
}

function parseColor(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number.parseFloat(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }

  throw new Error(`cannot parse colour value: ${value}`);
}

/** Paint `fg` over `bg`, which is what a translucent token actually renders as. */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const [rl, gl, bl] = [r, g, b].map((channel) => {
    const normalised = channel / 255;
    return normalised <= 0.03928 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrast(fg: Rgba, bg: Rgba): number {
  const opaque = fg.a < 1 ? over(fg, bg) : fg;
  const [hi, lo] = [luminance(opaque), luminance(bg)].sort((a, b) => b - a);

  return (hi + 0.05) / (lo + 0.05);
}

function ratio(theme: Map<string, string>, fg: string, bg: string): number {
  return contrast(parseColor(resolve(theme, fg)), parseColor(resolve(theme, bg)));
}

// --- The contract ------------------------------------------------------------

/**
 * Surfaces a page can put text on. The cross product below is stricter than any
 * single rendered pair, and deliberately so: which surface a given component
 * sits on is a fact about markup that moves, so a text token is required to be
 * legible on *any* surface the stylesheet could place it over. That turns "is
 * this hex safe here" into a question nobody has to re-ask per component.
 */
const SURFACES = ['--cp-bg', '--cp-bg-elevated', '--cp-surface', '--cp-surface-soft'] as const;

/**
 * Tokens the stylesheet uses as `color`. Each is a real usage, counted rather
 * than assumed: `--cp-accent` appears as a text colour in 16 rules, `--cp-link`
 * in 5, `--cp-success` in 8, `--cp-warning` in 4, `--cp-danger` in 3.
 */
const TEXT_TOKENS = [
  '--cp-text',
  '--cp-text-muted',
  '--cp-text-soft',
  '--cp-accent',
  '--cp-link',
  '--cp-success',
  '--cp-warning',
  '--cp-danger',
  // Issue #14's escape hatches, still live on `.lineage-longtail a` and
  // `.verification-mark` -- both inside the lineage root, where the e2e
  // accessibility suite grants no site-wide amnesty. They are aliased to the
  // base tokens rather than hand-tuned, and this measures that rather than
  // assuming it: the hardcoded light-theme `#15803d` they replaced fell to
  // 4.42:1 once this issue moved `--cp-surface-soft` underneath it.
  '--cp-link-accessible',
  '--cp-success-accessible',
] as const;

/** WCAG 1.4.3 for text below 18.66px bold / 24px regular, which is all of it. */
const AA_TEXT = 4.5;
/** WCAG 1.4.11 for a boundary or ring that has to be perceivable. */
const AA_NON_TEXT = 3;

const THEMES = [
  { name: 'light', tokens: LIGHT },
  { name: 'dark', tokens: DARK },
] as const;

describe.each(THEMES)('$name theme text clears WCAG AA on every surface', ({ tokens }) => {
  for (const token of TEXT_TOKENS) {
    for (const surface of SURFACES) {
      it(`${token} on ${surface}`, () => {
        const measured = ratio(tokens, token, surface);

        expect(
          measured,
          `${token} on ${surface} is ${measured.toFixed(2)}:1, below the ${AA_TEXT}:1 floor`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }
});

describe.each(THEMES)('$name theme accent fills stay readable', ({ tokens }) => {
  // `--cp-accent` is a background in 6 rules -- `.primary-action` and the skip
  // link among them -- so the pairing that matters there is inverted.
  it('puts a legible foreground on a filled accent surface', () => {
    const measured = ratio(tokens, '--cp-accent-fg', '--cp-accent');

    expect(
      measured,
      `--cp-accent-fg on --cp-accent is ${measured.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps that foreground legible while the fill is hovered', () => {
    const measured = ratio(tokens, '--cp-accent-fg', '--cp-accent-hover');

    expect(
      measured,
      `--cp-accent-fg on --cp-accent-hover is ${measured.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe.each(THEMES)('$name theme non-text boundaries are perceivable', ({ tokens }) => {
  // The universal `:focus-visible` rule paints its outline in `--cp-accent`, so
  // the ring is only a focus indicator if it clears 3:1 against the page.
  it('paints a focus ring that can be seen against the page', () => {
    const measured = ratio(tokens, '--cp-accent', '--cp-bg');

    expect(
      measured,
      `the --cp-accent focus ring is ${measured.toFixed(2)}:1 on --cp-bg`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  // `--cp-border-strong` is the stylesheet's structural line -- 81 uses, and what
  // the issue's design note means by crisp branch lines. `--cp-border` is
  // decorative hairline separation and carries no floor here.
  it('draws structural borders strongly enough to read as structure', () => {
    const measured = ratio(tokens, '--cp-border-strong', '--cp-bg');

    expect(
      measured,
      `--cp-border-strong is ${measured.toFixed(2)}:1 on --cp-bg`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe.each(THEMES)('$name theme tinted backgrounds do not swallow their text', ({ tokens }) => {
  // `--cp-accent-soft` is translucent and used as a background in 8 rules -- the
  // current nav link and the tree disclosure among them. What sits on it is a
  // composite, so measuring the token against the surface underneath is the only
  // reading that corresponds to a pixel.
  for (const surface of SURFACES) {
    it(`--cp-text over --cp-accent-soft on ${surface}`, () => {
      const tint = over(
        parseColor(resolve(tokens, '--cp-accent-soft')),
        parseColor(resolve(tokens, surface)),
      );
      const measured = contrast(parseColor(resolve(tokens, '--cp-text')), tint);

      expect(
        measured,
        `--cp-text on --cp-accent-soft over ${surface} is ${measured.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});

/**
 * The homepage explorer dims unrelated release nodes with `opacity`, and opacity
 * composites the text inside them as well as the box. Issue #14 measured this
 * and settled on 0.9; the value is asserted here rather than left as a comment,
 * because the number that makes it safe depends on the palette this issue moved.
 */
describe.each(THEMES)('$name theme dimming stays above the floor it was set for', ({ tokens }) => {
  it('keeps muted text legible inside a dimmed node', () => {
    // Last match, not first. The rule is declared twice -- the original 0.72 and
    // issue #14's appended 0.9 override -- and it is the second that renders.
    // Reading the first would measure a value no user ever sees, and would have
    // reported this as failing at 3.42:1 while the page was in fact compliant.
    const dimming = [
      ...globalStyles.matchAll(
        /\.release-node\[data-relation="unrelated"\]\s*\{[^}]*?opacity:\s*([\d.]+)/g,
      ),
    ];

    expect(dimming.length, 'the dimmed-node rule is missing').toBeGreaterThan(0);

    const alpha = Number.parseFloat(dimming[dimming.length - 1][1]);
    const text = { ...parseColor(resolve(tokens, '--cp-text-muted')), a: alpha };
    const surface = { ...parseColor(resolve(tokens, '--cp-surface')), a: alpha };
    const page = parseColor(resolve(tokens, '--cp-bg'));
    const measured = contrast(over(text, over(surface, page)), over(surface, page));

    expect(
      measured,
      `muted text dimmed to ${alpha} renders at ${measured.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

// --- Controls ----------------------------------------------------------------

/**
 * A checker that cannot fail reports exactly what a correct palette reports, and
 * a parser that silently found nothing would make every assertion above vacuous.
 * Both halves are pinned.
 */
describe('the check is capable of failing', () => {
  it('read a real palette out of the stylesheet', () => {
    for (const { name, tokens } of THEMES) {
      expect(tokens.size, `${name} theme parsed almost no tokens`).toBeGreaterThan(15);
      expect(tokens.has('--cp-bg'), `${name} theme is missing --cp-bg`).toBe(true);
    }
  });

  it('merges every block a selector has, not just the first', () => {
    // Issue #14 appended a second `:root` carrying `--cp-link-accessible`. If the
    // parser stopped at the first block this would be absent, and any future
    // appended token would be measured as though it did not exist.
    const roots = [...globalStyles.matchAll(/^:root\s*\{/gm)];

    expect(roots.length, 'expected more than one :root block to merge').toBeGreaterThan(1);
    expect(LIGHT.has('--cp-link-accessible')).toBe(true);
  });

  it('rates a known-bad pairing as failing', () => {
    // The exact pair this repository already recorded in prose: #0078d4 on
    // #f7f4ef is 4.12:1. If the arithmetic ever stops reporting that, the
    // arithmetic is wrong.
    const measured = contrast(parseColor('#0078d4'), parseColor('#f7f4ef'));

    expect(measured).toBeLessThan(AA_TEXT);
    expect(measured).toBeCloseTo(4.12, 1);
  });

  it('agrees with the two ends of the scale', () => {
    expect(contrast(parseColor('#000000'), parseColor('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(parseColor('#ffffff'), parseColor('#ffffff'))).toBeCloseTo(1, 5);
  });

  it('accounts for alpha rather than ignoring it', () => {
    // Half-transparent black over white is mid-grey, not black. A parser that
    // dropped the alpha channel would report 21:1 here.
    const measured = contrast(parseColor('rgba(0, 0, 0, 0.5)'), parseColor('#ffffff'));

    expect(measured).toBeGreaterThan(3);
    expect(measured).toBeLessThan(6);
  });
});
