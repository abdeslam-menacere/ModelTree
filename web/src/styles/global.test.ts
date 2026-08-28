import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const globalStyles = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

function ruleFor(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = globalStyles.match(new RegExp(`^${escapedSelector}\\s*\\{([^}]*)\\}`, 'm'));

  expect(rule, `Expected a rule for ${selector}`).not.toBeNull();
  return rule?.[1] ?? '';
}

describe('global viewport sizing', () => {
  it('does not impose a minimum width on page-level elements', () => {
    expect(ruleFor('html')).not.toMatch(/\bmin-(?:inline-size|width)\s*:/);
    expect(ruleFor('body')).not.toMatch(/\bmin-(?:inline-size|width)\s*:/);
  });
});

/**
 * A layout engine is what actually decides whether the page overflows, and there
 * is none in this environment. These assert the specific rules that would cause
 * it: an intrinsic width the viewport cannot shrink, a fixed column count a
 * narrow viewport cannot honour, and text that refuses to wrap.
 */
describe('a large featured family cannot push the page sideways', () => {
  it('gives no explorer container an intrinsic width', () => {
    for (const selector of ['.tree-level', '.release-node', '.ecosystem-option']) {
      expect(ruleFor(selector)).not.toMatch(/\bwidth\s*:\s*max-content\b/);
      expect(ruleFor(selector)).not.toMatch(/\bmin-width\s*:\s*[1-9]/);
    }
  });

  it('lets every nesting level shrink inside its column', () => {
    for (const selector of [
      '.lineage-directory',
      '.organization-branch',
      '.family-list',
      '.family-branch',
      '.lineage-branch',
      '.lineage-branch li',
      '.release-node',
    ]) {
      expect(ruleFor(selector), `${selector} must be shrinkable`).toMatch(/\bmin-width\s*:\s*0\b/);
    }
  });

  it('collapses the family columns on width rather than on a breakpoint', () => {
    expect(ruleFor('.family-list')).toMatch(/grid-template-columns:\s*repeat\(auto-fit,/);
    expect(ruleFor('.family-list')).toMatch(/minmax\(min\(100%,/);
  });

  it('wraps long identifiers instead of letting them extend the line', () => {
    for (const selector of ['.tree-level', '.release-node', '.summary-lineage dd']) {
      expect(ruleFor(selector)).toMatch(/\boverflow-wrap\s*:\s*anywhere\b/);
    }
  });

  it('shrinks indentation as a lineage deepens, and caps it', () => {
    const nested = ruleFor('.lineage-branch--nested');

    expect(nested).toMatch(/padding-inline-start:\s*max\(/);
    expect(nested).toMatch(/var\(--lineage-depth/);
  });

  it('lets the creator switcher wrap onto more rows as creators are added', () => {
    expect(ruleFor('.ecosystem-selector')).toMatch(/\bflex-wrap\s*:\s*wrap\b/);
  });
});

describe('nothing in the explorer rests on colour alone', () => {
  it('pairs the selected emphasis with an outline, not only a hue', () => {
    expect(ruleFor('.release-node[data-relation="selected"]')).toMatch(/box-shadow:/);
  });

  it('styles the written relation chip rather than only dimming the rest', () => {
    expect(ruleFor('.node-relation')).toMatch(/border:/);
    expect(ruleFor('.release-node[data-relation="unrelated"]')).toMatch(/opacity:/);
  });
});

describe('motion preferences are respected', () => {
  it('neutralises transitions and animations under reduced motion', () => {
    const block = globalStyles.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);

    expect(block, 'Expected a reduced-motion block').not.toBeNull();
    expect(block?.[1]).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block?.[1]).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    // The explorer's own transitions are covered because the block targets `*`.
    expect(block?.[1]).toMatch(/^\s*\*,$/m);
  });
});
