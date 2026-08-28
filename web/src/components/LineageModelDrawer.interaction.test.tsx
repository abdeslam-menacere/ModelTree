// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildModelTree } from '../lib/model-tree';
import ModelTreeExplorer from './ModelTreeExplorer';

const tree = buildModelTree(dataset);

function installMatchMedia(isMobile: boolean) {
  (window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = (
    query: string,
  ) => {
    const listeners = new Set<EventListener>();
    return {
      matches: query === '(max-width: 700px)' ? isMobile : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
      addListener: (listener: EventListener) => listeners.add(listener),
      removeListener: (listener: EventListener) => listeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
}

function renderExplorer() {
  return render(<ModelTreeExplorer tree={tree} sourceByReleaseId={{}} basePath="/ModelTree/" />);
}

function creatorButton(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

async function selectClaudeOpus(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(creatorButton('Anthropic').getAttribute('aria-expanded')).toBe('false'));
  await user.click(creatorButton('Anthropic'));
  await user.click(screen.getByRole('button', { name: /^Claude 5/ }));
  const releaseButton = screen.getByRole('button', { name: /^Claude Opus 5/ });
  await user.click(releaseButton);
  return releaseButton;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/ModelTree/tree/');
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('LineageModelDrawer modal behaviour on mobile', () => {
  it('opens a labelled modal dialog and moves focus into it when a release is selected', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    renderExplorer();

    await selectClaudeOpus(user);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('model-tree-heading');

    const closeButton = within(dialog).getByRole('button', { name: /Close release details/ });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
  });

  it('closes on Escape and restores focus to the invoking release node', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    renderExplorer();

    const releaseButton = await selectClaudeOpus(user);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(releaseButton);
  });

  it('closes on the close control and restores focus to the invoking release node', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    renderExplorer();

    const releaseButton = await selectClaudeOpus(user);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /Close release details/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(releaseButton);
  });

  it('traps Tab focus within the dialog', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    renderExplorer();

    await selectClaudeOpus(user);
    const dialog = await screen.findByRole('dialog');
    const closeButton = within(dialog).getByRole('button', { name: /Close release details/ });
    const compareLink = within(dialog).getByRole('link', { name: 'Compare' });

    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(compareLink);
    await user.tab();
    expect(document.activeElement).toBe(closeButton);
  });

  it('presents an anchored non-modal panel on desktop with no dialog semantics', async () => {
    installMatchMedia(false);
    const user = userEvent.setup();
    renderExplorer();

    const releaseButton = await selectClaudeOpus(user);

    expect(screen.queryByRole('dialog')).toBeNull();
    const surface = document.querySelector('.tree-details') as HTMLElement;
    expect(within(surface).getByRole('heading', { name: /Claude Opus 5/ })).toBeTruthy();
    // Focus is never moved away from the release the user activated.
    expect(document.activeElement).toBe(releaseButton);
  });
});
