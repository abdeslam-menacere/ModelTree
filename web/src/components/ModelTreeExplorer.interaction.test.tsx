// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildModelTree } from '../lib/model-tree';
import { datasetWithOtherCreators } from '../lib/model-tree-fixture';
import ModelTreeExplorer from './ModelTreeExplorer';

const tree = buildModelTree(dataset);
const otherTree = buildModelTree(datasetWithOtherCreators);
const selectedRelease = dataset.releases.find(({ id }) => id === 'anthropic-claude-opus-5')!;

function renderExplorer() {
  return render(<ModelTreeExplorer tree={tree} sourceByReleaseId={{}} basePath="/ModelTree/" />);
}

function creatorButton(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/ModelTree/tree/');
});

afterEach(() => {
  cleanup();
});

describe('ModelTreeExplorer interactions', () => {
  it('opens and closes creator and family disclosures independently', async () => {
    const user = userEvent.setup();
    renderExplorer();
    expect(screen.getByRole('button', { name: /^AI Model Ecosystem/ }).getAttribute(
      'aria-expanded',
    )).toBe('true');
    const anthropic = creatorButton('Anthropic');
    const google = creatorButton('Google DeepMind');

    await waitFor(() => expect(anthropic.getAttribute('aria-expanded')).toBe('false'));
    expect(google.getAttribute('aria-expanded')).toBe('false');

    await user.click(anthropic);
    const claudeFive = screen.getByRole('button', { name: /^Claude 5/ });
    expect(anthropic.getAttribute('aria-expanded')).toBe('true');
    expect(claudeFive.getAttribute('aria-expanded')).toBe('false');

    await user.click(claudeFive);
    await user.click(google);
    expect(anthropic.getAttribute('aria-expanded')).toBe('true');
    expect(claudeFive.getAttribute('aria-expanded')).toBe('true');
    expect(google.getAttribute('aria-expanded')).toBe('true');

    await user.click(anthropic);
    expect(anthropic.getAttribute('aria-expanded')).toBe('false');
    expect(google.getAttribute('aria-expanded')).toBe('true');
  });

  it('selects a release, updates details, and preserves unrelated URL state', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/ModelTree/tree/?utm=kept#details');
    renderExplorer();

    await waitFor(() => expect(creatorButton('Anthropic').getAttribute('aria-expanded')).toBe('false'));
    await user.click(creatorButton('Anthropic'));
    await user.click(screen.getByRole('button', { name: /^Claude 5/ }));
    const releaseButton = screen.getByRole('button', { name: /^Claude Opus 5/ });
    await user.click(releaseButton);

    const details = document.querySelector('.tree-details') as HTMLElement;
    expect(within(details).getByRole('heading', { name: selectedRelease.displayName })).toBeTruthy();
    expect(within(details).getByText(selectedRelease.summary)).toBeTruthy();
    expect(releaseButton.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.pathname).toBe('/ModelTree/tree/');
    expect(window.location.search).toBe(`?utm=kept&model=${selectedRelease.id}`);
    expect(window.location.hash).toBe('#details');
  });

  it('restores a valid deep link and opens the selected release ancestors', async () => {
    window.history.replaceState(
      {},
      '',
      `/ModelTree/tree/?view=tree&model=${selectedRelease.id}#release`,
    );
    renderExplorer();

    await waitFor(() => {
      expect(creatorButton('Anthropic').getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('button', { name: /^Claude 5/ }).getAttribute('aria-expanded'))
        .toBe('true');
    });

    const releaseButton = screen.getByRole('button', { name: /^Claude Opus 5/ });
    expect(releaseButton.getAttribute('aria-pressed')).toBe('true');
    expect(within(document.querySelector('.tree-details') as HTMLElement).getByRole(
      'heading',
      { name: selectedRelease.displayName },
    )).toBeTruthy();
    expect(window.location.search).toBe(`?view=tree&model=${selectedRelease.id}`);
    expect(window.location.hash).toBe('#release');
  });

  it('fails safely to the empty state for an invalid deep link', async () => {
    window.history.replaceState({}, '', '/ModelTree/tree/?model=not-a-release&view=tree#safe');
    renderExplorer();

    await waitFor(() => expect(creatorButton('Anthropic').getAttribute('aria-expanded')).toBe('false'));
    expect(screen.getByRole('heading', { name: 'Choose a model release' })).toBeTruthy();
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(window.location.search).toBe('?model=not-a-release&view=tree');
    expect(window.location.hash).toBe('#safe');
  });

  it('selects a release under Others and fills the details panel', async () => {
    const user = userEvent.setup();
    render(<ModelTreeExplorer tree={otherTree} sourceByReleaseId={{}} basePath="/ModelTree/" />);
    const others = screen.getByRole('button', { name: /^Others/ });

    await waitFor(() => expect(creatorButton('Zenith Labs').getAttribute('aria-expanded')).toBe('false'));
    expect(others.getAttribute('aria-expanded')).toBe('true');

    await user.click(creatorButton('Zenith Labs'));
    await user.click(screen.getByRole('button', { name: /^Zenith Core/ }));
    const releaseButton = screen.getByRole('button', { name: /^Zenith Flagship/ });
    await user.click(releaseButton);

    const details = document.querySelector('.tree-details') as HTMLElement;
    expect(within(details).getByRole('heading', { name: 'Zenith Flagship' })).toBeTruthy();
    expect(within(details).getByText('Zenith Labs / Zenith Core')).toBeTruthy();
    expect(releaseButton.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search).toBe('?model=other-alpha-core-one');
  });

  it('restores a deep link to an Others release by opening its creator and family', async () => {
    window.history.replaceState({}, '', '/ModelTree/tree/?model=other-zulu-atlas-one');
    render(<ModelTreeExplorer tree={otherTree} sourceByReleaseId={{}} basePath="/ModelTree/" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Zulu Atlas/ }).getAttribute('aria-expanded')).toBe('true');
    });
    expect(screen.getByRole('button', { name: /^Atlas Prime/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(document.querySelector('.tree-details') as HTMLElement).getByRole(
      'heading',
      { name: 'Atlas Prime' },
    )).toBeTruthy();
  });

  it('collapses the Others branch on demand like any other disclosure', async () => {
    const user = userEvent.setup();
    render(<ModelTreeExplorer tree={otherTree} sourceByReleaseId={{}} basePath="/ModelTree/" />);
    const others = screen.getByRole('button', { name: /^Others/ });

    await waitFor(() => expect(creatorButton('Zenith Labs').getAttribute('aria-expanded')).toBe('false'));
    await user.click(others);

    expect(others.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('model-tree-other-creators')?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByRole('button', { name: /^Featured ecosystems/ }).getAttribute(
      'aria-expanded',
    )).toBe('true');
  });
});
