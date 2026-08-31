import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Model DNA strip's styling (issue #37), held to the properties a rendered
 * page would otherwise be needed to check.
 *
 * The strip's job is to be scannable without becoming a chart. That makes four
 * things checkable in the source, and each of them is an acceptance criterion
 * rather than a preference:
 *
 * - **Nothing is carried by colour alone.** The one segment that differs from
 *   its neighbours -- a dimension with nothing recorded -- differs by border
 *   style, and prints its state in words besides.
 * - **Narrow viewports and zoom.** The strip wraps and no segment claims an
 *   intrinsic width, so 320px folds instead of scrolling sideways.
 * - **Forced colours.** Segments are drawn with borders rather than fills,
 *   because a background is dropped in a high-contrast mode and a border is not.
 * - **No motion to suppress.** `prefers-reduced-motion` is honoured most
 *   reliably by having nothing to reduce. `primary-nav.test.ts` guards the same
 *   property across everything after its marker, which includes this block; the
 *   assertion is repeated here so a reader of this file sees the constraint the
 *   block is under.
 */

const globalStyles = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

const BLOCK_MARKER = '/* --- Model DNA identity strip (issue #37)';
const blockStart = globalStyles.indexOf(BLOCK_MARKER);
const dnaBlock = blockStart === -1 ? '' : globalStyles.slice(blockStart);

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = dnaBlock.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));

  expect(rule, `Expected a rule for ${selector}`).not.toBeNull();
  return rule?.[1] ?? '';
}

describe('the block is present and is the last thing in the stylesheet', () => {
  it('is marked with its issue number so it can be found', () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(dnaBlock.length).toBeGreaterThan(0);
  });
});

describe('nothing is carried by colour alone', () => {
  it('distinguishes an unrecorded segment by border style, not only by colour', () => {
    // The words "Not recorded" are the fact; this is the second reading of it.
    // A colour-only difference would vanish for a reader who cannot separate the
    // two hues, and would vanish entirely under forced colours.
    expect(ruleFor('.model-dna-absent')).toMatch(/border-style:\s*dashed/);
  });

  it('declares no colour literal, so every colour comes from a token', () => {
    // `visual-system.test.ts` enforces this across the whole file; asserting it
    // here means a reader of this block sees the rule it is written under.
    expect(dnaBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(dnaBlock).not.toMatch(/\b(rgba?|hsla?)\(/);
  });

  it('uses the perceivable border token rather than the hairline', () => {
    // `--cp-border` is a 1.40:1 hairline and is not allowed to be the only thing
    // marking a boundary.
    expect(ruleFor('.model-dna-segment')).toContain('var(--cp-border-strong)');
    expect(ruleFor('.model-dna-segment')).not.toContain('var(--cp-border)');
  });
});

describe('the strip holds at narrow widths and under zoom', () => {
  it('wraps rather than scrolling sideways', () => {
    const strip = ruleFor('.model-dna-strip');
    expect(strip).toMatch(/flex-wrap:\s*wrap/);
    expect(strip).toMatch(/display:\s*flex/);
  });

  it('lets a segment shrink below its content width', () => {
    const segment = ruleFor('.model-dna-segment');
    expect(segment).toMatch(/min-width:\s*0/);
    expect(segment).toMatch(/max-width:\s*100%/);
  });

  it('claims no intrinsic width anywhere in the block', () => {
    // `max-content` / `fit-content` are how a strip like this quietly acquires a
    // horizontal scrollbar at 320px.
    expect(dnaBlock).not.toContain('max-content');
    expect(dnaBlock).not.toContain('fit-content');
    expect(dnaBlock).not.toMatch(/\bwhite-space:\s*nowrap/);
  });

  it('folds a long value inside its own segment', () => {
    expect(ruleFor('.model-dna-value')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(ruleFor('.model-dna-key dd')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('the disclosure is a usable target', () => {
  it('clears the 24px minimum the interaction contract sets', () => {
    const summary = ruleFor('.model-dna-key > summary');
    const minimum = summary.match(/min-block-size:\s*(\d+)px/);

    expect(minimum, 'summary should declare a minimum block size').not.toBeNull();
    expect(Number(minimum?.[1])).toBeGreaterThanOrEqual(24);
  });
});

describe('the block declares no motion', () => {
  const MOTION = /\b(transition|animation(-[a-z]+)?|transform)\s*:/;

  it('has none to suppress under reduced motion', () => {
    expect(dnaBlock).not.toMatch(MOTION);
  });

  it('would notice motion if it were added', () => {
    // Positive control. Without it, a broken pattern would report the block as
    // clean forever, and this is a guard whose failure mode is silence.
    expect(`${dnaBlock}\n.x { transition: opacity 1s; }`).toMatch(MOTION);
    expect(`${dnaBlock}\n.x { transform: scale(2); }`).toMatch(MOTION);
  });
});

describe('segments are drawn with borders, not fills', () => {
  it('sets no background on a segment, so forced colours keep the boundary', () => {
    expect(ruleFor('.model-dna-segment')).not.toMatch(/background/);
    expect(ruleFor('.model-dna-absent')).not.toMatch(/background/);
  });
});
