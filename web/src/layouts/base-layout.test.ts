import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NAV_DISCLOSURE_SELECTOR,
  NAV_TRIGGER_SELECTOR,
} from '../lib/nav-menu';

/**
 * `BaseLayout.astro` is the one place the navigation model becomes markup, and
 * the one place it can silently stop being wired to anything.
 *
 * Two couplings are checked here because nothing else would notice them break.
 * The attribute hooks are read from `nav-menu.ts`'s own exported selectors, so
 * renaming one there and forgetting the layout reddens this file rather than
 * quietly shipping a submenu that no script is enhancing. And the disclosure has
 * to stay native: a `<button>` with a scripted panel would leave a no-JS reader
 * with destinations they cannot reach at all.
 */

const layout = readFileSync(new URL('./BaseLayout.astro', import.meta.url), 'utf8');

function attributeOf(selector: string): string {
  return selector.replace(/^\[/, '').replace(/\]$/, '');
}

describe('the layout renders the navigation model rather than a copy of it', () => {
  it('builds its links from the navigation module', () => {
    expect(layout).toMatch(/import\s*\{[^}]*\bbuildPrimaryNavigation\b[^}]*\}\s*from\s*'\.\.\/lib\/navigation'/s);
    expect(layout).toMatch(/buildPrimaryNavigation\(\{\s*base,\s*passportHref\s*\}\)/);
  });

  it('takes its currentPage type from the same module, so the two cannot drift', () => {
    expect(layout).toMatch(/import\s*\{[^}]*\btype NavPageId\b[^}]*\}\s*from\s*'\.\.\/lib\/navigation'/s);
    expect(layout).toMatch(/currentPage\?:\s*NavPageId;/);
  });

  it('hardcodes no header destination of its own', () => {
    const header = layout.slice(layout.indexOf('<nav'), layout.indexOf('</nav>'));

    expect(header).not.toMatch(/href=\{`\$\{base\}/);
    expect(header).toMatch(/href=\{item\.href\}/);
    expect(header).toMatch(/href=\{child\.href\}/);
  });
});

describe('the disclosure stays native, and reachable without JavaScript', () => {
  it('uses details and summary, not a scripted button', () => {
    expect(layout).toMatch(/<details[^>]*\bclass="nav-disclosure"/);
    expect(layout).toMatch(/<summary/);
    expect(layout).not.toMatch(/<button[^>]*nav-trigger/);
  });

  it('carries the hooks the enhancement selects on', () => {
    expect(layout).toContain(attributeOf(NAV_DISCLOSURE_SELECTOR));
    expect(layout).toContain(attributeOf(NAV_TRIGGER_SELECTOR));
  });

  it('writes no static aria-expanded, which nothing would keep true', () => {
    // With the script absent the browser's own details semantics are accurate.
    // A baked-in `aria-expanded="false"` would contradict them on first open.
    expect(layout).not.toMatch(/aria-expanded/);
  });

  it('loads the enhancement rather than inlining a second copy of it', () => {
    expect(layout).toMatch(/import\s*\{\s*enhancePrimaryNavigation\s*\}\s*from\s*'\.\.\/lib\/nav-menu'/);
  });
});

describe('existing header behaviour is not regressed', () => {
  it('keeps the skip link ahead of the header', () => {
    expect(layout.indexOf('class="skip-link" href="#main-content"')).toBeGreaterThan(-1);
    expect(layout.indexOf('class="skip-link"')).toBeLessThan(layout.indexOf('<nav'));
  });

  it('keeps the navigation landmark and its accessible name', () => {
    expect(layout).toMatch(/<nav aria-label="Primary navigation"/);
  });

  it('marks the current page on the destination, never on a trigger', () => {
    const trigger = layout.slice(layout.indexOf('<summary'), layout.indexOf('</summary>'));

    expect(trigger).not.toMatch(/aria-current/);
    expect(layout).toMatch(/<a href=\{item\.href\} aria-current=\{ariaCurrentFor\(item, currentPage\)\}/);
    expect(layout).toMatch(/<a href=\{child\.href\} aria-current=\{ariaCurrentFor\(child, currentPage\)\}/);
  });

  it('hints on the trigger when the page it hides is the current one', () => {
    expect(layout).toMatch(/data-holds-current=\{groupHoldsCurrentPage\(item, currentPage\)/);
  });
});
