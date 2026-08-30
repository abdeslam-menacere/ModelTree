import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Token hygiene and forced-colours support for the visual system (issue #31).
 *
 * `contrast.test.ts` next door answers "are the token *values* legible". This
 * file answers the two questions it cannot: whether the stylesheet actually goes
 * through the tokens rather than around them, and whether the one display mode
 * that discards the palette entirely is handled.
 *
 * Neither is checkable in a browser run cheaply. Forced-colours mode is a
 * platform setting Playwright can emulate but the repo's suite does not, and
 * "no rule hardcodes a colour" is a property of the source rather than of any
 * rendered page. Both are cheap and exact to assert here.
 */

const CSS_PATH = fileURLToPath(new URL('./global.css', import.meta.url));
const css = readFileSync(CSS_PATH, 'utf8');

/**
 * Comments carry measured hex values as evidence all through this file -- #14's
 * contrast rationale alone quotes six. They are documentation, not paint, so
 * every source check below runs on the stylesheet with comments removed.
 */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** A hex, `rgb()`, `rgba()`, `hsl()` or `hsla()` literal. */
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/;

/** Every `prop: value` pair in the stylesheet, with its property name split off. */
function declarations(source: string): { property: string; value: string }[] {
  return source
    .replace(/@[a-z-]+[^;{]*\{/gi, '{')
    .split(/[{}]/)
    .flatMap((chunk) => chunk.split(';'))
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes(':'))
    .map((entry) => {
      const at = entry.indexOf(':');
      return { property: entry.slice(0, at).trim(), value: entry.slice(at + 1).trim() };
    });
}

describe('the stylesheet paints through the token layer, not around it', () => {
  it('hardcodes no colour outside a custom property declaration', () => {
    // Custom properties are where colour is allowed to be a literal -- that is
    // what a token is. Anything else naming a colour directly has stepped around
    // the layer, and will not follow the theme or a future palette revision.
    const offenders = declarations(code)
      .filter(({ property }) => !property.startsWith('--'))
      .filter(({ value }) => COLOUR_LITERAL.test(value))
      .map(({ property, value }) => `${property}: ${value}`);

    expect(offenders, `rules painting a literal colour instead of a token:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('declares no token it never uses', () => {
    // `--cp-sheen` was declared in both themes and referenced zero times before
    // this issue removed it. A token nobody reads is a claim the system makes
    // about itself that nothing checks, so the whole class is asserted rather
    // than that one name.
    const declared = new Set(
      [...code.matchAll(/^\s*(--cp-[\w-]+)\s*:/gm)].map((match) => match[1]),
    );
    const referenced = new Set(
      [...code.matchAll(/var\(\s*(--cp-[\w-]+)/g)].map((match) => match[1]),
    );

    const unused = [...declared].filter((token) => !referenced.has(token)).sort();

    expect(unused, `declared but never read: ${unused.join(', ')}`).toEqual([]);
  });

  it('drives its motion from the motion tokens', () => {
    // The scale is only real if the rules use it. Asserted as "every duration
    // goes through a token" rather than "the tokens exist", because the second
    // is what `--cp-sheen` also satisfied.
    const timed = declarations(code).filter(({ property }) =>
      /^(animation|transition)$/.test(property),
    );

    expect(timed.length, 'no motion left to check, so this assertion proves nothing').toBeGreaterThan(0);

    const literal = timed
      .filter(({ value }) => /\b\d+m?s\b/.test(value))
      .map(({ property, value }) => `${property}: ${value}`);

    expect(literal, `motion still carrying literal durations:\n${literal.join('\n')}`).toEqual([]);
  });
});

describe('forced colours are handled where the palette stops applying', () => {
  const block = css.match(/@media \(forced-colors: active\) \{([\s\S]*?)\n\}/)?.[1];

  it('has a forced-colours block at all', () => {
    expect(block, 'no @media (forced-colors: active) block in global.css').toBeDefined();
  });

  it('pins the focus ring to the system focus colour', () => {
    // Focus survives forced colours only because nothing in this file suppresses
    // an outline. Naming `Highlight` decides *which* system colour it becomes
    // rather than leaving it to whatever the accent maps to.
    expect(block).toMatch(/:focus-visible\s*\{[^}]*outline-color:\s*Highlight/);
  });

  it('keeps selected controls distinguishable without the accent fill', () => {
    // A pressed control is painted as a filled accent with an inverted
    // foreground. Forced colours flatten both sides, so without this the state
    // is left legible only to assistive technology through `aria-pressed`.
    expect(block).toMatch(/aria-pressed="true"\]\s*\{[^}]*background:\s*Highlight/);
    expect(block).toMatch(/aria-pressed="true"\]\s*\{[^}]*color:\s*HighlightText/);
  });

  it('gives the modal drawer a drawn edge, since shadows are dropped', () => {
    expect(block).toMatch(/tree-drawer-dialog\s*\{[^}]*border:\s*1px solid CanvasText/);
  });

  it('uses only system colour keywords inside the block', () => {
    // A literal here would be substituted away by the user agent, so writing one
    // is always a mistake -- it reads as control the rule does not have.
    const offenders = declarations(block ?? '')
      .filter(({ value }) => COLOUR_LITERAL.test(value))
      .map(({ property, value }) => `${property}: ${value}`);

    expect(offenders, `literal colours inside the forced-colours block:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe("this issue's own appended block obeys the motion guard", () => {
  // `primary-nav.test.ts` guards from the #523 marker to end of file, so this
  // block is already covered by it. Stated separately anyway: that guard belongs
  // to another issue and could be re-scoped by it, and inheriting a constraint is
  // not the same as being held to one.
  const marker = '/* --- Visual system and brand mark (issue #31)';
  const start = css.indexOf(marker);

  it('is present and appended, not merged into the rules above', () => {
    expect(start, `no ${marker} marker found`).toBeGreaterThan(-1);
  });

  it('declares no motion', () => {
    const slice = css.slice(start);

    // Including in prose. The guard reads comments too, and `text-transform`
    // trips the third pattern because the word boundary sits between the hyphen
    // and the "t" -- which is why the block above cases its labels in their own
    // text rather than in CSS.
    expect(slice).not.toMatch(/\btransition\s*:/);
    expect(slice).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/);
    expect(slice).not.toMatch(/\btransform\s*:/);
  });

  it('can tell when a block does declare motion, so the check above is not vacuous', () => {
    const planted = `${css.slice(start)}\n.planted { transition: color 200ms ease; }`;

    expect(planted).toMatch(/\btransition\s*:/);
  });
});

describe('the checks above can fail', () => {
  it('strips comments rather than searching them', () => {
    // The whole source check rests on this. If comment stripping silently did
    // nothing, "no hardcoded colours" would be measuring #14's rationale prose
    // and would have failed loudly -- but a future edit could make it pass
    // vacuously instead, so the mechanism is pinned rather than assumed.
    expect(css).toContain('#0078d4');
    expect(code).not.toContain('#0078d4');
  });

  it('finds colour literals when they are there', () => {
    expect(COLOUR_LITERAL.test('#ffffff')).toBe(true);
    expect(COLOUR_LITERAL.test('rgba(0, 0, 0, 0.45)')).toBe(true);
    expect(COLOUR_LITERAL.test('var(--cp-accent)')).toBe(false);
    expect(COLOUR_LITERAL.test('1px solid CanvasText')).toBe(false);
  });

  it('splits declarations rather than returning the file whole', () => {
    const parsed = declarations('a { color: red; background: blue; }');

    expect(parsed).toEqual([
      { property: 'color', value: 'red' },
      { property: 'background', value: 'blue' },
    ]);
  });

  it('parsed a stylesheet of the expected shape, not an empty string', () => {
    expect(declarations(code).length).toBeGreaterThan(2000);
  });
});
