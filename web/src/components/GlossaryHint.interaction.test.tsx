// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { GlossaryEntry } from '../data/glossary-schema';
import GlossaryHint from './GlossaryHint';

/**
 * The inline explanation's keyboard behaviour, which issue #44 makes an
 * acceptance criterion rather than a nicety: definitions must not be hover-only,
 * the control must take focus, and Escape must close it.
 *
 * Every assertion here goes through the keyboard or through the accessibility
 * tree. None reads a class name to decide whether the panel is open, because a
 * panel that is visually hidden but exposed to assistive technology, or the
 * reverse, would pass such a check while failing the requirement.
 */

const entry: GlossaryEntry = {
  id: 'active-parameters',
  term: 'Active parameters',
  category: 'parameters',
  aliases: ['active params'],
  short: 'The weights actually used to produce each token.',
  definition: 'A router selects a few experts per token.',
  distinctions: [],
  examples: [],
  related: [],
  conflicts: [],
  sources: [{
    url: 'https://example.com/card',
    title: 'Model card',
    publisher: 'Example',
    type: 'model-card',
    quote: '17B (Activated) 109B (Total)',
    lastCheckedDate: '2026-08-28',
  }],
  verifiedAt: '2026-08-28',
};

const HREF = '/ModelTree/glossary/#active-parameters';

function renderHint() {
  return render(
    <div>
      <button type="button">before</button>
      <GlossaryHint entry={entry} href={HREF} />
      <button type="button">after</button>
    </div>,
  );
}

function trigger() {
  return document.querySelector('.glossary-hint-trigger') as HTMLAnchorElement;
}

function panel() {
  return document.querySelector('.glossary-hint-panel') as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe('the inline hint before anything is activated', () => {
  it('starts closed and says so in the accessibility tree', () => {
    renderHint();

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(panel().hasAttribute('hidden')).toBe(true);
  });

  it('names the term it explains, so the control is not an unlabelled icon', () => {
    renderHint();

    expect(trigger().textContent).toContain('Active parameters');
  });

  it('points at the full entry, so it still works with no JavaScript at all', () => {
    renderHint();

    expect(trigger().getAttribute('href')).toBe(HREF);
  });

  it('associates the trigger with the panel it controls', () => {
    renderHint();

    expect(trigger().getAttribute('aria-controls')).toBe(panel().id);
    expect(panel().id).not.toBe('');
  });
});

describe('the inline hint is reachable and operable from the keyboard alone', () => {
  it('takes focus by tabbing to it', async () => {
    const user = userEvent.setup();
    renderHint();

    await user.tab();
    await user.tab();

    expect(document.activeElement).toBe(trigger());
  });

  it('opens on Enter and exposes the expanded state', async () => {
    const user = userEvent.setup();
    renderHint();

    trigger().focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(false));
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panel().textContent).toContain('The weights actually used to produce each token.');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderHint();

    trigger().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(false));

    await user.keyboard('{Escape}');

    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(true));
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('reaches the full-entry link from the panel by tabbing onward', async () => {
    const user = userEvent.setup();
    renderHint();

    trigger().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(false));

    await user.tab();

    expect((document.activeElement as HTMLAnchorElement).getAttribute('href')).toBe(HREF);
    expect(document.activeElement?.textContent).toContain('Read the full entry');
  });

  it('closes again when focus leaves the hint entirely', async () => {
    const user = userEvent.setup();
    renderHint();

    trigger().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(false));

    // Past the trigger and the panel's own link, onto the next link in the page.
    await user.tab();
    await user.tab();

    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(true));
  });
});

describe('the inline hint is not a hover tooltip', () => {
  it('stays closed when a pointer merely hovers over the trigger', async () => {
    const user = userEvent.setup();
    renderHint();

    await user.hover(trigger());

    expect(panel().hasAttribute('hidden')).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open when the pointer leaves, so a definition cannot escape a reader', async () => {
    const user = userEvent.setup();
    renderHint();

    await user.click(trigger());
    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(false));

    await user.unhover(trigger());

    expect(panel().hasAttribute('hidden')).toBe(false);
  });

  it('toggles shut on a second activation', async () => {
    const user = userEvent.setup();
    renderHint();

    await user.click(trigger());
    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(false));

    await user.click(trigger());

    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(true));
  });

  it('closes when a click lands outside it', async () => {
    const user = userEvent.setup();
    renderHint();

    await user.click(trigger());
    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(false));

    await user.click(document.querySelector('button') as HTMLElement);

    await waitFor(() => expect(panel().hasAttribute('hidden')).toBe(true));
  });
});
