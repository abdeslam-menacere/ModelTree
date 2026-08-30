import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./global.css', import.meta.url)), 'utf8');

/**
 * The `/tree/` explorer at a 320px viewport, and the drawer's motion.
 *
 * `global.test.ts` already guards the homepage explorer against pushing the page
 * sideways. The Model Tree page has the same acceptance criterion and no guard at
 * all, and it is the more fragile of the two: three separate rules give its nodes
 * an intrinsic width that a 320px viewport cannot honour --
 *
 *   .model-tree-list ul > li  { min-width: 245px }
 *   .tree-disclosure          { width: max-content; min-width: 245px }
 *   .tree-release-node        { min-width: 270px }
 *
 * -- and every one of them is neutralised only by the `@media (max-width: 700px)`
 * block, which ties them on specificity and wins on source order alone. That is
 * the exact shape that made the mobile drawer unpositioned in issue #11: reorder
 * the file, or append a rule that looks harmless, and the page silently starts
 * overflowing again.
 *
 * What this file is, and is not: a scoped cascade resolver over the committed
 * stylesheet, not a CSS engine and not a layout engine. It answers "which
 * declaration wins for this element at this viewport width", which is a question
 * about the stylesheet and can be answered exactly. It cannot answer "does the
 * page overflow", which is a question about layout; `e2e/lineage-narrow-viewport
 * .e2e.ts` answers that one in a real browser at a real 320px viewport.
 */

const VIEWPORT = 320;

interface Compound {
  /** `' '` for a descendant combinator, `'>'` for a child combinator. */
  combinator: ' ' | '>';
  tag: string;
  classes: string[];
}

interface Rule {
  group: string;
  compounds: Compound[];
  declarations: string;
  specificity: [number, number];
  order: number;
}

interface Node {
  tag: string;
  classes: string[];
}

/**
 * Walks the stylesheet brace-aware, yielding each leaf declaration block together
 * with the at-rule preludes it is nested inside. Unlike the walk in
 * `tree-drawer-position.test.ts`, the preludes are kept: a media condition decides
 * whether a rule is in force at 320px, which is the whole question here.
 */
function leafRules(source: string): Array<{ selector: string; declarations: string; media: string[] }> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<{ selector: string; declarations: string; media: string[] }> = [];
  const stack: string[] = [];
  let buffer = '';

  for (const character of withoutComments) {
    if (character === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (character === '}') {
      const declarations = buffer.trim();
      const selector = stack.pop() ?? '';
      if (declarations && !selector.startsWith('@')) {
        rules.push({ selector, declarations, media: stack.filter((entry) => entry.startsWith('@')) });
      }
      buffer = '';
    } else {
      buffer += character;
    }
  }

  return rules;
}

/**
 * Whether every width constraint in the enclosing at-rules holds at `width`.
 *
 * Only `min-width` and `max-width` are evaluated. Any other feature is treated as
 * matching, which is safe in the direction that matters: it can only let more
 * rules into the resolution, never hide one that is in force. The stylesheet's one
 * non-width media block is `prefers-reduced-motion`, which declares no width at
 * all, so nothing it contains can reach the assertions below.
 */
function appliesAt(media: string[], width: number): boolean {
  return media.every((prelude) => {
    for (const [, feature, value] of prelude.matchAll(/\(\s*(min-width|max-width)\s*:\s*(\d+)px\s*\)/g)) {
      const bound = Number(value);
      if (feature === 'max-width' && width > bound) return false;
      if (feature === 'min-width' && width < bound) return false;
    }
    return true;
  });
}

/**
 * Splits a selector group into compounds. Returns `undefined` for anything this
 * resolver cannot evaluate exactly -- an id, an attribute, a pseudo-class, or a
 * sibling combinator. Skipping such a group can only ever remove a rule from the
 * resolution, so the non-vacuity assertions below exist to prove that the rules
 * this file is about were not among the ones skipped.
 */
function parseGroup(group: string): Compound[] | undefined {
  const trimmed = group.trim();
  if (trimmed === '' || /[#[\]:+~*]/.test(trimmed)) return undefined;

  const compounds: Compound[] = [];
  let combinator: ' ' | '>' = ' ';

  for (const token of trimmed.split(/\s+/)) {
    if (token === '>') {
      combinator = '>';
      continue;
    }
    const classes = (token.match(/\.[a-z0-9-]+/gi) ?? []).map((entry) => entry.slice(1));
    const tag = token.replace(/\.[a-z0-9-]+/gi, '');
    if (tag !== '' && !/^[a-z][a-z0-9]*$/i.test(tag)) return undefined;
    compounds.push({ combinator, tag, classes });
    combinator = ' ';
  }

  return compounds.length > 0 ? compounds : undefined;
}

function specificityOf(compounds: Compound[]): [number, number] {
  return compounds.reduce<[number, number]>(
    ([classes, tags], compound) => [
      classes + compound.classes.length,
      tags + (compound.tag === '' ? 0 : 1),
    ],
    [0, 0],
  );
}

function matchesCompound(node: Node, compound: Compound): boolean {
  if (compound.tag !== '' && compound.tag !== node.tag) return false;
  return compound.classes.every((name) => node.classes.includes(name));
}

/**
 * Right-to-left match of `compounds[0..compoundIndex]` against `path[0..nodeIndex]`,
 * where `path` runs from the document root down to the element under test.
 */
function matchesPath(
  path: Node[],
  compounds: Compound[],
  compoundIndex: number,
  nodeIndex: number,
): boolean {
  if (compoundIndex < 0) return true;
  if (nodeIndex < 0) return false;

  const compound = compounds[compoundIndex];
  if (!matchesCompound(path[nodeIndex], compound)) {
    // A descendant combinator may skip ancestors; a child combinator may not, and
    // neither may the rightmost compound, which is anchored on the element itself.
    if (compoundIndex === compounds.length - 1) return false;
    return compounds[compoundIndex + 1].combinator === ' '
      ? matchesPath(path, compounds, compoundIndex, nodeIndex - 1)
      : false;
  }

  if (matchesPath(path, compounds, compoundIndex - 1, nodeIndex - 1)) return true;

  // The compound matched here but the rest of the chain did not. Under a descendant
  // combinator the same compound may still match further up the path.
  return compoundIndex < compounds.length - 1 && compounds[compoundIndex + 1].combinator === ' '
    ? matchesPath(path, compounds, compoundIndex, nodeIndex - 1)
    : false;
}

const rules: Rule[] = [];
leafRules(css).forEach(({ selector, declarations, media }, order) => {
  if (!appliesAt(media, VIEWPORT)) return;
  for (const group of selector.split(',')) {
    const compounds = parseGroup(group);
    if (!compounds) continue;
    rules.push({
      group: group.trim(),
      compounds,
      declarations,
      specificity: specificityOf(compounds),
      order,
    });
  }
});

function declarationValue(declarations: string, property: string): string | undefined {
  const matches = [...declarations.matchAll(
    new RegExp(String.raw`(?:^|;)\s*${property}\s*:\s*([^;]+)`, 'gi'),
  )];
  return matches.at(-1)?.[1].trim();
}

/** The declaration in force for `property` on `path` at a 320px viewport. */
function resolve(path: Node[], property: string): { value: string; group: string } | undefined {
  const candidates = rules
    .filter((rule) => declarationValue(rule.declarations, property) !== undefined)
    .filter((rule) => matchesPath(path, rule.compounds, rule.compounds.length - 1, path.length - 1))
    .sort((a, b) => (
      a.specificity[0] !== b.specificity[0] ? a.specificity[0] - b.specificity[0]
        : a.specificity[1] !== b.specificity[1] ? a.specificity[1] - b.specificity[1]
          : a.order - b.order
    ));

  const winner = candidates.at(-1);
  if (!winner) return undefined;
  return { value: declarationValue(winner.declarations, property)!, group: winner.group };
}

/** Every rule declaring `property` that matches `path`, in no particular order. */
function competing(path: Node[], property: string) {
  return rules
    .filter((rule) => declarationValue(rule.declarations, property) !== undefined)
    .filter((rule) => matchesPath(path, rule.compounds, rule.compounds.length - 1, path.length - 1))
    .map((rule) => ({ group: rule.group, value: declarationValue(rule.declarations, property)! }));
}

const el = (tag: string, ...classes: string[]): Node => ({ tag, classes });

// The paths mirror ModelTreeExplorer's markup exactly: a root disclosure, then the
// Featured branch, then a creator, then a family, then the release list.
const TREE_ROOT = [
  el('section', 'model-tree-explorer'),
  el('div', 'tree-workspace'),
  el('div', 'tree-scroll'),
  el('ul', 'model-tree-list', 'model-tree-root'),
];

const CREATOR_ITEM = [...TREE_ROOT, el('li'), el('ul'), el('li'), el('ul'), el('li')];
const CREATOR_DISCLOSURE = [...CREATOR_ITEM, el('button', 'tree-disclosure', 'tree-creator-node')];
const ROOT_DISCLOSURE = [...TREE_ROOT, el('li'), el('button', 'tree-disclosure', 'tree-root-node')];
const RELEASE_ITEM = [
  ...CREATOR_ITEM,
  el('ul'),
  el('li'),
  el('ol', 'tree-release-list'),
  el('li'),
];
const RELEASE_NODE = [...RELEASE_ITEM, el('div', 'tree-release-node')];

/**
 * An intrinsic width is one a 320px viewport cannot shrink below: a positive
 * length, or a content-derived keyword. `0`, `none`, `100%` and `auto` are all
 * shrinkable.
 */
function isIntrinsic(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (/\b(max-content|min-content|fit-content)\b/.test(value)) return true;
  return /^[1-9]\d*(?:\.\d+)?(px|rem|em|ch)$/.test(value.trim());
}

describe('the Model Tree cannot push the page sideways at 320px', () => {
  it('has the intrinsic minimums this suite exists to police', () => {
    // Guards against a vacuous pass. If these disappear, the assertions below stop
    // proving anything and this test says so rather than staying quietly green.
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).toMatch(/\.tree-disclosure,\s*\n\.tree-empty-node \{[^}]*width: max-content/);
    expect(source).toMatch(/\.tree-disclosure,\s*\n\.tree-empty-node \{[^}]*min-width: 245px/);
    expect(source).toMatch(/\.tree-release-node \{[^}]*min-width: 270px/);
    expect(source).toMatch(/\.tree-release-list > li \{|\.tree-release-list > li,/);
  });

  it('sees those minimums as real competitors, not as rules it skipped', () => {
    // The resolver ignores selector groups it cannot evaluate exactly. This proves
    // the intrinsic rules were evaluated and lost, rather than never considered.
    expect(competing(CREATOR_DISCLOSURE, 'min-width').map(({ value }) => value)).toContain('245px');
    expect(competing(RELEASE_NODE, 'min-width').map(({ value }) => value)).toContain('270px');
    expect(competing(RELEASE_ITEM, 'min-width').map(({ value }) => value)).toContain('245px');
  });

  it('leaves no tree node with an intrinsic width in force', () => {
    const surfaces: Array<[string, Node[]]> = [
      ['the root disclosure', ROOT_DISCLOSURE],
      ['a creator disclosure', CREATOR_DISCLOSURE],
      ['a creator list item', CREATOR_ITEM],
      ['a release list item', RELEASE_ITEM],
      ['a release node', RELEASE_NODE],
    ];

    for (const [label, path] of surfaces) {
      for (const property of ['min-width', 'width', 'max-width']) {
        const resolved = resolve(path, property);
        expect(
          isIntrinsic(resolved?.value),
          `${label}: \`${property}: ${resolved?.value}\` from \`${resolved?.group}\` cannot shrink to 320px`,
        ).toBe(false);
      }
    }
  });

  it('keeps the tree list scrolling rather than clipping at this width', () => {
    // `overflow-x: auto` is what makes the desktop tree scrollable, and what the
    // markup's `role="region"` and `tabIndex` exist to keep reachable. At 320px it
    // is switched to `visible` so a narrow screen scrolls the page, not a box.
    expect(resolve(TREE_ROOT.slice(0, 3), 'overflow-x')?.value).toBe('visible');
  });
});

describe('the lineage surfaces stay inside the reduced-motion killswitch', () => {
  const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1];

  it('animates the mobile drawer, so there is something to neutralise', () => {
    expect(css).toMatch(/@keyframes tree-drawer-rise/);
    expect(css).toMatch(/animation:\s*tree-drawer-rise\s+\d+ms/);
  });

  it('declares no motion the universal !important override cannot reach', () => {
    // The killswitch wins by `!important`. The only thing that can outrank it is
    // another `!important`, so nothing outside the block may declare one.
    const offenders = leafRules(css)
      .filter(({ media }) => !media.some((prelude) => prelude.includes('prefers-reduced-motion')))
      .filter(({ declarations }) => /(animation|transition)[a-z-]*\s*:[^;]*!important/i.test(declarations))
      .map(({ selector }) => selector);

    expect(offenders).toEqual([]);
  });

  it('neutralises both durations for every element, pseudo-elements included', () => {
    expect(reducedMotion, 'Expected a reduced-motion block').toBeDefined();
    expect(reducedMotion).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(reducedMotion).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(reducedMotion).toMatch(/^\s*\*,$/m);
    expect(reducedMotion).toMatch(/^\s*\*::before,$/m);
    expect(reducedMotion).toMatch(/^\s*\*::after \{$/m);
  });
});

describe('the appended issue #14 block keeps its own rules reachable', () => {
  it('gives the focusable tree scroll region a visible ring', () => {
    expect(css).toMatch(/\.tree-scroll:focus-visible \{[^}]*outline:\s*\d+px solid/);
  });

  it('outranks the muted node text so the selected chip is legible', () => {
    // `.tree-release-node button span` is (0,1,2). A lone `.tree-release-selected`
    // would be (0,1,0) and lose, taking the chip back to the muted body colour.
    const chip = rules.find(({ group }) => group.endsWith('.tree-release-selected'));
    const mutedText = rules.find(({ group }) => group === '.tree-release-node button span');

    expect(chip, 'Expected a rule for the selected chip').toBeDefined();
    expect(mutedText, 'Expected the muted node text rule it has to outrank').toBeDefined();
    expect(chip!.specificity[0]).toBeGreaterThan(mutedText!.specificity[0]);
  });

  it('floors the standalone text actions at the 24px target minimum', () => {
    expect(resolve([el('a', 'text-action')], 'min-height')?.value).toBe('24px');
  });
});
