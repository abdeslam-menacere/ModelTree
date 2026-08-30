import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The header submenu's styling, held to the two things a layout engine would
 * otherwise be needed to check.
 *
 * First, motion: this repository treats `prefers-reduced-motion` as an
 * acceptance criterion, and the reliable way to honour it is to have no motion
 * to suppress. A transition added to this block later would need its own
 * reduced-motion escape hatch, which is exactly the thing that gets forgotten,
 * so the block is asserted to contain none.
 *
 * Second, the cascade. The 700px rule `nav a:first-child { display: none }` was
 * written when the header was eleven bare links and hid the first of them to buy
 * room. Every link now sits in its own `<li>`, so that selector matches all of
 * them, and a menu whose every link is `display: none` on a phone is the exact
 * regression this change could ship without anyone seeing it in a diff. The
 * override is therefore checked to win on specificity, not on source order --
 * `global.css` is append-only and shared, so source order is not ours to keep.
 */

const globalStyles = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

const BLOCK_MARKER = '/* --- Primary navigation grouping (issue #523)';
const blockStart = globalStyles.indexOf(BLOCK_MARKER);
const navBlock = blockStart === -1 ? '' : globalStyles.slice(blockStart);

function ruleFor(selector: string, source = navBlock): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = source.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));

  expect(rule, `Expected a rule for ${selector}`).not.toBeNull();
  return rule?.[1] ?? '';
}

/**
 * CSS specificity as (ids, classes/attributes/pseudo-classes, elements), for the
 * flat compound selectors this file compares. Enough to answer "which of these
 * two rules wins", which is the only question asked of it.
 */
function specificity(selector: string): [number, number, number] {
  const ids = selector.match(/#[\w-]+/g) ?? [];
  const classesAndAttributes = selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? [];
  const elements = selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? [];

  return [ids.length, classesAndAttributes.length, elements.length];
}

function beats(winner: string, loser: string): boolean {
  const a = specificity(winner);
  const b = specificity(loser);

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }

  return false;
}

describe('the appended block exists and is self-contained', () => {
  it('is present at the end of the stylesheet', () => {
    expect(blockStart, 'the primary navigation block is missing from global.css').toBeGreaterThan(-1);
  });
});

describe('the submenu needs no reduced-motion escape hatch', () => {
  it('declares no transition, animation, or transform', () => {
    expect(navBlock).not.toMatch(/\btransition\s*:/);
    expect(navBlock).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/);
    expect(navBlock).not.toMatch(/\btransform\s*:/);
  });

  it('changes the open-state marker by shape rather than by moving it', () => {
    expect(ruleFor('.nav-trigger::after')).toMatch(/border-top:\s*5px solid currentcolor/);
    expect(ruleFor('.nav-disclosure[open] > .nav-trigger::after')).toMatch(/border-bottom:\s*5px solid currentcolor/);
  });
});

describe('the mobile rule that hid the first link cannot hide the whole menu', () => {
  it('still contains the original rule, untouched', () => {
    // Append-only: this asserts the pre-existing rule is intact, so the override
    // below is proven to be an override and not a quiet edit of someone else's.
    expect(globalStyles).toMatch(/^\s*nav a:first-child \{\s*\n?\s*display: none;/m);
  });

  it('restores every navigation link with a more specific rule', () => {
    expect(ruleFor('.primary-nav a[href]')).toMatch(/\bdisplay\s*:\s*inline-flex\b/);
    expect(beats('.primary-nav a[href]', 'nav a:first-child')).toBe(true);
  });

  it('keeps the submenu links laid out by a rule more specific still', () => {
    expect(ruleFor('.primary-nav .nav-submenu a[href]')).toMatch(/\bdisplay\s*:\s*flex\b/);
    expect(beats('.primary-nav .nav-submenu a[href]', '.primary-nav a[href]')).toBe(true);
  });
});

describe('the submenu is usable by a pointer and a finger', () => {
  it('opens flush against its trigger, leaving no gap to fall through', () => {
    // WCAG 2.1 1.4.13 wants hover-revealed content to stay reachable by pointer.
    // A gap between trigger and panel is what breaks that.
    expect(ruleFor('.nav-submenu')).toMatch(/\btop\s*:\s*100%/);
    expect(ruleFor('.nav-submenu')).toMatch(/\bposition\s*:\s*absolute\b/);
  });

  it('grows leftwards from the right edge, where the header puts the menu', () => {
    expect(ruleFor('.nav-submenu')).toMatch(/\bright\s*:\s*0\b/);
    expect(ruleFor('.nav-submenu')).toMatch(/\bleft\s*:\s*auto\b/);
  });

  it('paints an opaque panel so the page beneath cannot show through it', () => {
    expect(ruleFor('.nav-submenu')).toMatch(/\bbackground\s*:/);
    expect(ruleFor('.nav-submenu')).toMatch(/\bborder\s*:/);
  });

  it('gives the trigger the same 44px target the links have', () => {
    expect(ruleFor('.nav-trigger')).toMatch(/\bmin-height\s*:\s*44px\b/);
    expect(ruleFor('.nav-trigger')).toMatch(/\bcursor\s*:\s*pointer\b/);
  });

  it('hides the native marker in every engine that draws one', () => {
    expect(ruleFor('.nav-trigger')).toMatch(/\blist-style\s*:\s*none\b/);
    expect(ruleFor('.nav-trigger::-webkit-details-marker')).toMatch(/\bdisplay\s*:\s*none\b/);
  });

  it('wraps the row instead of pushing the page sideways', () => {
    expect(ruleFor('.primary-nav .nav-row')).toMatch(/\bflex-wrap\s*:\s*wrap\b/);
  });
});

describe('the current page is still findable when a menu hides it', () => {
  it('marks the trigger by shape as well as colour', () => {
    const rule = ruleFor('.nav-trigger[data-holds-current="true"]');

    expect(rule).toMatch(/\bbox-shadow\s*:/);
  });
});
