// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildModelTree } from '../lib/model-tree';
import { creatorDisclosure, familyDisclosure, releaseButton } from '../../tests/helpers/model-tree-queries';
import ModelTreeExplorer from './ModelTreeExplorer';

const tree = buildModelTree(dataset);
// Selected through the ids the component emits rather than by a name prefix
// (issue #777): `/^Claude 5/` matched `Claude 5` and every future `Claude 5.x`
// at once. See `tests/helpers/model-tree-queries.ts`.
const claudeFiveFamily = dataset.families.find(({ id }) => id === 'anthropic-claude-5')!;
const opusFive = dataset.releases.find(({ id }) => id === 'anthropic-claude-opus-5')!;
// The creator is selected the same way, for the cost reason recorded on
// `creatorDisclosure` (issue #744). This helper is shared by all eight tests in
// this file and previously ran two whole-catalog role-by-name scans per call.
const anthropic = dataset.organizations.find(({ id }) => id === 'anthropic')!;

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

async function selectClaudeOpus(user: ReturnType<typeof userEvent.setup>) {
  const anthropicBranch = creatorDisclosure(anthropic);
  await waitFor(() => expect(anthropicBranch.getAttribute('aria-expanded')).toBe('false'));
  await user.click(anthropicBranch);
  await user.click(familyDisclosure(claudeFiveFamily));
  const release = releaseButton(opusFive);
  await user.click(release);
  return release;
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

  it('reopens for the same release after dismissal when it is re-selected', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    renderExplorer();

    const releaseButton = await selectClaudeOpus(user);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Selecting the very same node again must bring the drawer back, even though
    // the selected release id is unchanged.
    await user.click(releaseButton);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('dismisses on a backdrop click and restores focus', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    renderExplorer();

    const releaseButton = await selectClaudeOpus(user);
    await screen.findByRole('dialog');

    await user.click(document.querySelector('.tree-drawer-backdrop') as HTMLElement);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(releaseButton);
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

  it('keeps the explorer region named on mobile regardless of drawer state', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    renderExplorer();

    // Before any selection the modal drawer renders nothing, yet the explorer
    // section must still carry an accessible name (the merge-base regression).
    expect(screen.getByRole('region', { name: 'Model lineage explorer' })).toBeTruthy();

    const releaseButton = await selectClaudeOpus(user);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // ...and still after the drawer has been dismissed back to null.
    expect(screen.getByRole('region', { name: 'Model lineage explorer' })).toBeTruthy();
    expect(releaseButton).toBeTruthy();
  });
});
