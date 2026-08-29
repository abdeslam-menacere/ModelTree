import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./global.css', import.meta.url)), 'utf8');

// The mobile dialog element carries both of these classes.
const DIALOG_CLASSES = new Set(['tree-details', 'tree-drawer-dialog']);

interface Rule {
  selector: string;
  position: string;
  specificity: number;
  order: number;
}

/**
 * Walks the stylesheet brace-aware, yielding every leaf declaration block as
 * `[selectorText, declarationsText]`. At-rule preludes (e.g. `@media`) are
 * discarded — media queries add no specificity — but the rules nested inside
 * them are still collected, which is the whole point: the conflicting
 * `.tree-details { position: static }` lives inside a media block.
 */
function leafRules(source: string): Array<[string, string]> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<[string, string]> = [];
  const stack: string[] = [];
  let buffer = '';
  for (const ch of withoutComments) {
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      const declarations = buffer.trim();
      const selector = stack.pop() ?? '';
      if (declarations && !selector.startsWith('@')) {
        rules.push([selector, declarations]);
      }
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return rules;
}

/**
 * A class-only selector group matches the dialog element when its final
 * compound references the drawer and uses only classes the element actually
 * carries, with no tag/id/attribute/pseudo that would exclude it.
 */
function matchesDialog(group: string): boolean {
  const compound = group.split(/\s*[>+~\s]\s*/).filter(Boolean).pop() ?? '';
  const classes = (compound.match(/\.[a-z0-9-]+/gi) ?? []).map((c) => c.slice(1));
  if (classes.length === 0) return false;
  const leftover = compound.replace(/\.[a-z0-9-]+/gi, '').trim();
  const onlyDialogClasses = classes.every((c) => DIALOG_CLASSES.has(c));
  const referencesDrawer = classes.includes('tree-details') || classes.includes('tree-drawer-dialog');
  return leftover === '' && onlyDialogClasses && referencesDrawer;
}

function classSpecificity(group: string): number {
  return (group.match(/\.[a-z0-9-]+/gi) ?? []).length;
}

function readPosition(declarations: string): string | null {
  const match = declarations.match(/(?:^|;)\s*position\s*:\s*([^;]+)/i);
  return match ? match[1].trim() : null;
}

describe('mobile lineage drawer positioning (B1 regression guard)', () => {
  const competing: Rule[] = [];
  leafRules(css).forEach(([selector, declarations], order) => {
    const position = readPosition(declarations);
    if (!position) return;
    for (const group of selector.split(',')) {
      if (matchesDialog(group)) {
        competing.push({ selector: group.trim(), position, specificity: classSpecificity(group), order });
        break;
      }
    }
  });

  it('finds both the drawer rule and the conflicting `.tree-details` static rule', () => {
    // Guards against a vacuous pass: the conflict this test exists to police must
    // actually be present in the parsed stylesheet.
    expect(competing.some((r) => r.position === 'static')).toBe(true);
    expect(competing.some((r) => r.selector.includes('tree-drawer-dialog'))).toBe(true);
  });

  it('resolves the dialog to a positioned box so its z-index is not inert', () => {
    const winner = [...competing].sort((a, b) =>
      a.specificity !== b.specificity ? a.specificity - b.specificity : a.order - b.order,
    ).at(-1);
    expect(winner).toBeDefined();
    expect(winner?.position).not.toBe('static');
  });
});
