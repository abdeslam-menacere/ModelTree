// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NAV_DISCLOSURE_SELECTOR,
  NAV_HOVER_QUERY,
  NAV_TRIGGER_SELECTOR,
  enhancePrimaryNavigation,
} from './nav-menu';
import { buildPrimaryNavigation, navigationDestinations, type NavItem } from './navigation';

/**
 * The header's submenus, exercised as behaviour rather than as markup.
 *
 * The fixture is generated from `buildPrimaryNavigation` and from the selector
 * constants the enhancement itself exports, so it cannot describe a menu the
 * shipped one does not have: rename an attribute hook and this file follows it.
 * `BaseLayout` is held to the same hooks by `base-layout.test.ts`.
 *
 * What is being defended here is the accessibility contract, because a submenu
 * that only answers to a mouse strands every keyboard and touch user:
 *   - the disclosure is native, so it works with this module absent entirely;
 *   - `aria-expanded` exists only while something keeps it truthful;
 *   - Escape closes and hands focus back;
 *   - hover is an addition, gated on the pointer actually being one.
 */

const navigation = buildPrimaryNavigation({
  base: '/probe/',
  passportHref: '/probe/models/some-release/',
});

/** `[data-nav-disclosure]` -> `data-nav-disclosure`. */
function attributeOf(selector: string): string {
  const name = selector.replace(/^\[/, '').replace(/\]$/, '');

  expect(name, `${selector} is expected to be a bare attribute selector`).toMatch(/^[a-z-]+$/);
  return name;
}

const disclosureAttribute = attributeOf(NAV_DISCLOSURE_SELECTOR);
const triggerAttribute = attributeOf(NAV_TRIGGER_SELECTOR);

function renderItem(item: NavItem): string {
  if (item.kind === 'destination') {
    return `<li><a href="${item.href}">${item.label}</a></li>`;
  }

  const children = item.items
    .map((child) => `<li><a href="${child.href}">${child.label}</a></li>`)
    .join('');

  return `<li>
    <details ${disclosureAttribute}>
      <summary ${triggerAttribute}>${item.label}</summary>
      <ul class="nav-submenu" id="${item.id}">${children}</ul>
    </details>
  </li>`;
}

function renderNav(): HTMLElement {
  document.body.innerHTML = `
    <nav aria-label="Primary navigation" data-primary-nav>
      <ul class="nav-row">${navigation.map(renderItem).join('')}</ul>
    </nav>
    <main id="main-content"><a href="/probe/elsewhere/">Somewhere else</a></main>
  `;

  const nav = document.querySelector<HTMLElement>('[data-primary-nav]');

  if (!nav) throw new Error('fixture did not render a primary navigation');
  return nav;
}

function disclosures(nav: HTMLElement): HTMLDetailsElement[] {
  return Array.from(nav.querySelectorAll<HTMLDetailsElement>(NAV_DISCLOSURE_SELECTOR));
}

function triggerOf(disclosure: HTMLDetailsElement): HTMLElement {
  const trigger = disclosure.querySelector<HTMLElement>(NAV_TRIGGER_SELECTOR);

  if (!trigger) throw new Error('a disclosure rendered without a trigger');
  return trigger;
}

/** What a browser does when a details opens: set the state, then announce it. */
function setOpen(disclosure: HTMLDetailsElement, open: boolean): void {
  disclosure.open = open;
  disclosure.dispatchEvent(new Event('toggle'));
}

function stubHover(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === NAV_HOVER_QUERY ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  stubHover(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the menu works before the enhancement runs', () => {
  it('puts every destination in the static markup, behind a native disclosure', () => {
    const nav = renderNav();
    const rendered = Array.from(nav.querySelectorAll('a[href]')).map((link) => link.getAttribute('href'));

    for (const destination of navigationDestinations(navigation)) {
      expect(rendered, `destination "${destination.id}"`).toContain(destination.href);
    }

    for (const disclosure of disclosures(nav)) {
      expect(disclosure.tagName).toBe('DETAILS');
      expect(triggerOf(disclosure).tagName).toBe('SUMMARY');
    }
  });

  it('claims no expanded state that nothing is keeping true', () => {
    const nav = renderNav();

    for (const disclosure of disclosures(nav)) {
      expect(triggerOf(disclosure).hasAttribute('aria-expanded')).toBe(false);
    }
  });
});

describe('aria-expanded tracks the disclosure', () => {
  it('reports every menu closed once the enhancement runs', () => {
    const nav = renderNav();

    enhancePrimaryNavigation(nav);

    for (const disclosure of disclosures(nav)) {
      expect(triggerOf(disclosure).getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('follows the disclosure open and shut', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);

    setOpen(first, true);
    expect(triggerOf(first).getAttribute('aria-expanded')).toBe('true');

    setOpen(first, false);
    expect(triggerOf(first).getAttribute('aria-expanded')).toBe('false');
  });

  it('reports an already-open menu as expanded on the first pass', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);

    first.open = true;
    enhancePrimaryNavigation(nav);

    expect(triggerOf(first).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('only one submenu is open at a time', () => {
  it('closes the other menu, and says so', () => {
    const nav = renderNav();
    const [first, second] = disclosures(nav);

    expect(second, 'the fixture needs two disclosures to test this').toBeDefined();
    enhancePrimaryNavigation(nav);

    setOpen(first, true);
    setOpen(second, true);

    expect(first.open).toBe(false);
    expect(triggerOf(first).getAttribute('aria-expanded')).toBe('false');
    expect(second.open).toBe(true);
    expect(triggerOf(second).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Escape closes and hands focus back', () => {
  it('closes the menu the focused link is in and returns focus to its trigger', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);
    const trigger = triggerOf(first);
    const focusReturned = vi.spyOn(trigger, 'focus');
    const link = first.querySelector<HTMLAnchorElement>('a[href]');

    enhancePrimaryNavigation(nav);
    setOpen(first, true);

    link?.focus();
    expect(document.activeElement).toBe(link);

    link?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(first.open).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(focusReturned).toHaveBeenCalled();
  });

  it('closes a menu opened by a pointer without stealing focus from elsewhere', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);
    const focusReturned = vi.spyOn(triggerOf(first), 'focus');
    const outside = document.querySelector<HTMLAnchorElement>('#main-content a');

    enhancePrimaryNavigation(nav);
    setOpen(first, true);

    outside?.focus();
    outside?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(first.open).toBe(false);
    expect(focusReturned).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it('leaves other keys, and a closed menu, alone', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);
    setOpen(first, true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(first.open).toBe(true);

    setOpen(first, false);
    const focusReturned = vi.spyOn(triggerOf(first), 'focus');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(focusReturned).not.toHaveBeenCalled();
  });
});

describe('the menu gets out of the way', () => {
  it('closes when a click lands outside it', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);
    setOpen(first, true);

    document.querySelector('#main-content')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(first.open).toBe(false);
  });

  it('stays open while the pointer is working inside it', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);
    setOpen(first, true);

    // Dispatched on the submenu itself rather than on a link: jsdom answers a
    // click on an `<a href>` with an unimplemented-navigation warning, and the
    // behaviour under test is containment, which the list exercises identically.
    first.querySelector('.nav-submenu')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(first.open).toBe(true);
  });

  it('closes behind a keyboard user who tabs past the last submenu link', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);
    const outside = document.querySelector<HTMLAnchorElement>('#main-content a');

    enhancePrimaryNavigation(nav);
    setOpen(first, true);

    outside?.focus();

    expect(first.open).toBe(false);
  });

  it('stays open while focus is still inside it', () => {
    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);
    setOpen(first, true);

    first.querySelector<HTMLAnchorElement>('a[href]')?.focus();

    expect(first.open).toBe(true);
  });
});

describe('hover is an addition, not the way in', () => {
  it('ignores hover where the pointer cannot hover', () => {
    stubHover(false);

    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);
    first.dispatchEvent(new MouseEvent('mouseenter'));

    expect(first.open).toBe(false);
  });

  it('opens and closes on hover where the pointer is a fine one', () => {
    stubHover(true);

    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);

    first.dispatchEvent(new MouseEvent('mouseenter'));
    expect(first.open).toBe(true);
    expect(triggerOf(first).getAttribute('aria-expanded')).toBe('true');

    first.dispatchEvent(new MouseEvent('mouseleave'));
    expect(first.open).toBe(false);
    expect(triggerOf(first).getAttribute('aria-expanded')).toBe('false');
  });

  it('does not let a wandering pointer close a menu the keyboard is using', () => {
    stubHover(true);

    const nav = renderNav();
    const [first] = disclosures(nav);

    enhancePrimaryNavigation(nav);

    first.dispatchEvent(new MouseEvent('mouseenter'));
    first.querySelector<HTMLAnchorElement>('a[href]')?.focus();
    first.dispatchEvent(new MouseEvent('mouseleave'));

    expect(first.open).toBe(true);
  });

  it('survives a browser that exposes no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined);

    const nav = renderNav();
    const [first] = disclosures(nav);

    expect(() => enhancePrimaryNavigation(nav)).not.toThrow();
    expect(triggerOf(first).getAttribute('aria-expanded')).toBe('false');
  });
});
