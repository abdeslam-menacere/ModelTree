/**
 * Progressive enhancement for the header's grouped submenus (issue #523).
 *
 * The markup works with this file absent: each group is a native
 * `<details>`/`<summary>` disclosure, so it opens by click, by tap, and by
 * Enter or Space from the keyboard with no script at all. Everything here is an
 * addition on top of that baseline, which is why nothing below is required for
 * a destination to be reachable.
 *
 * `aria-expanded` is set here rather than written into the static HTML on
 * purpose. Without JavaScript the browser's own details semantics report the
 * open state accurately; a hardcoded `aria-expanded="false"` that nothing
 * updates would override that with a value which is wrong the moment the user
 * opens the menu. So the attribute appears exactly when something is keeping it
 * true.
 */

export const NAV_DISCLOSURE_SELECTOR = '[data-nav-disclosure]';
export const NAV_TRIGGER_SELECTOR = '[data-nav-trigger]';

/**
 * Hover-to-open is gated on this. The issue asked for hover; a touch user has
 * none, and opening on a synthesised hover would leave them unable to close the
 * menu. Devices that fail this query keep the click/tap/keyboard baseline.
 */
export const NAV_HOVER_QUERY = '(hover: hover) and (pointer: fine)';

function disclosuresIn(nav: ParentNode): HTMLDetailsElement[] {
  return Array.from(nav.querySelectorAll<HTMLDetailsElement>(NAV_DISCLOSURE_SELECTOR));
}

function triggerOf(disclosure: HTMLDetailsElement): HTMLElement | null {
  return disclosure.querySelector<HTMLElement>(NAV_TRIGGER_SELECTOR);
}

function syncExpanded(disclosure: HTMLDetailsElement): void {
  triggerOf(disclosure)?.setAttribute('aria-expanded', disclosure.open ? 'true' : 'false');
}

function open(disclosure: HTMLDetailsElement): void {
  disclosure.open = true;
  syncExpanded(disclosure);
}

function close(disclosure: HTMLDetailsElement): void {
  disclosure.open = false;
  syncExpanded(disclosure);
}

/** One menu open at a time, so a second submenu cannot overlap the first. */
function closeOthers(all: readonly HTMLDetailsElement[], keep: HTMLDetailsElement): void {
  for (const other of all) {
    if (other !== keep && other.open) close(other);
  }
}

export function enhancePrimaryNavigation(nav: HTMLElement): void {
  const doc = nav.ownerDocument;
  const view = doc.defaultView;
  const all = disclosuresIn(nav);

  if (!view || all.length === 0) return;

  for (const disclosure of all) {
    syncExpanded(disclosure);
    disclosure.addEventListener('toggle', () => {
      syncExpanded(disclosure);
      if (disclosure.open) closeOthers(all, disclosure);
    });
  }

  // Escape closes, and returns focus to the trigger it came from so the user is
  // never dropped at the top of the tab order.
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    let restoreFocusTo: HTMLElement | null = null;

    for (const disclosure of all) {
      if (!disclosure.open) continue;
      if (disclosure.contains(doc.activeElement)) restoreFocusTo = triggerOf(disclosure);
      close(disclosure);
    }

    restoreFocusTo?.focus();
  });

  const closeAllOutside = (target: Node | null) => {
    for (const disclosure of all) {
      if (disclosure.open && !(target && disclosure.contains(target))) close(disclosure);
    }
  };

  // A pointer or the focus ring leaving the menu dismisses it. Focus is the one
  // that keeps tab order sane: tabbing past the last submenu link closes the
  // menu behind you rather than leaving it hanging open over the page.
  doc.addEventListener('click', (event) => closeAllOutside(event.target as Node | null));
  doc.addEventListener('focusin', (event) => closeAllOutside(event.target as Node | null));

  const hoverCapable = typeof view.matchMedia === 'function'
    && view.matchMedia(NAV_HOVER_QUERY).matches;

  if (!hoverCapable) return;

  for (const disclosure of all) {
    disclosure.addEventListener('mouseenter', () => {
      open(disclosure);
      closeOthers(all, disclosure);
    });

    disclosure.addEventListener('mouseleave', () => {
      // The submenu is a DOM child of the disclosure, so it counts as inside for
      // boundary events and the pointer can travel into it without this firing.
      // Focus wins over the pointer: a keyboard user who has tabbed in keeps the
      // menu even when the mouse wanders off it.
      if (disclosure.contains(doc.activeElement)) return;
      close(disclosure);
    });
  }
}
