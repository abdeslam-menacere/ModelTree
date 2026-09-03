// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildModelTree } from '../lib/model-tree';
import { datasetWithOtherCreators } from '../../tests/fixtures/model-tree-dataset';
import {
  creatorDisclosure,
  familyDisclosure,
  releaseButton,
} from '../../tests/helpers/model-tree-queries';
import ModelTreeExplorer from './ModelTreeExplorer';

const tree = buildModelTree(dataset);
const otherTree = buildModelTree(datasetWithOtherCreators);
const selectedRelease = dataset.releases.find(({ id }) => id === 'anthropic-claude-opus-5')!;
const siblingRelease = dataset.releases.find(({ id }) => id === 'anthropic-claude-sonnet-5')!;
// Families and releases are selected through the ids the component emits rather
// than by a name prefix (issue #777): `/^Claude 5/` matched `Claude 5` and every
// future `Claude 5.x` at once, which stopped a reviewed Anthropic release from
// being recordable at all. See `tests/helpers/model-tree-queries.ts`.
const claudeFiveFamily = dataset.families.find(({ id }) => id === 'anthropic-claude-5')!;
// Creators are selected the same way, and for the second reason recorded on
// `creatorDisclosure`: a role-by-name lookup computes an accessible name for
// every button in the rendered catalog, so it cost 10.6ms more per release added
// while an id lookup costs 0.9ms (issue #744). The organization records are read
// from the dataset rather than hard-coded, so neither recorded name form is
// duplicated here.
const anthropic = dataset.organizations.find(({ id }) => id === 'anthropic')!;
const google = dataset.organizations.find(({ id }) => id === 'google-deepmind')!;
const zenith = datasetWithOtherCreators.organizations.find(({ id }) => id === 'other-alpha')!;
const zenithCore = datasetWithOtherCreators.families.find(({ id }) => id === 'other-alpha-core')!;
const zenithFlagship = datasetWithOtherCreators.releases
  .find(({ id }) => id === 'other-alpha-core-one')!;
const zuluAtlas = datasetWithOtherCreators.families.find(({ id }) => id === 'other-zulu-atlas')!;
const atlasPrime = datasetWithOtherCreators.releases
  .find(({ id }) => id === 'other-zulu-atlas-one')!;

function renderExplorer() {
  return render(<ModelTreeExplorer tree={tree} sourceByReleaseId={{}} basePath="/ModelTree/" />);
}

/**
 * A structural disclosure -- the tree root, `Featured ecosystems`, `Others` --
 * reached through the fixed `aria-controls` id the component emits for it.
 *
 * These three name no dataset entity, so there is no record to read an id from
 * the way `creatorDisclosure` does; the ids are constants in the component and
 * are constants here. The visible label is asserted for the same reason the
 * shared helpers assert theirs: selecting by id says nothing about what the
 * button is called, and a disclosure that stopped being named for its branch
 * would otherwise still be found.
 */
function disclosure(controls: string, label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-controls="${controls}"]`);
  expect(button?.querySelector('span')?.textContent).toBe(label);
  return button!;
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
    expect(disclosure('model-tree-root-branches', 'AI Model Ecosystem').getAttribute(
      'aria-expanded',
    )).toBe('true');
    const anthropicBranch = creatorDisclosure(anthropic);
    const googleBranch = creatorDisclosure(google);

    await waitFor(() => expect(anthropicBranch.getAttribute('aria-expanded')).toBe('false'));
    expect(googleBranch.getAttribute('aria-expanded')).toBe('false');

    await user.click(anthropicBranch);
    const claudeFive = familyDisclosure(claudeFiveFamily);
    expect(anthropicBranch.getAttribute('aria-expanded')).toBe('true');
    expect(claudeFive.getAttribute('aria-expanded')).toBe('false');

    await user.click(claudeFive);
    await user.click(googleBranch);
    expect(anthropicBranch.getAttribute('aria-expanded')).toBe('true');
    expect(claudeFive.getAttribute('aria-expanded')).toBe('true');
    expect(googleBranch.getAttribute('aria-expanded')).toBe('true');

    await user.click(anthropicBranch);
    expect(anthropicBranch.getAttribute('aria-expanded')).toBe('false');
    expect(googleBranch.getAttribute('aria-expanded')).toBe('true');
  });

  it('selects a release, updates details, and preserves unrelated URL state', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/ModelTree/tree/?utm=kept#details');
    renderExplorer();

    const anthropicBranch = creatorDisclosure(anthropic);
    await waitFor(() => expect(anthropicBranch.getAttribute('aria-expanded')).toBe('false'));
    await user.click(anthropicBranch);
    await user.click(familyDisclosure(claudeFiveFamily));
    const releaseButtonNode = releaseButton(selectedRelease);
    await user.click(releaseButtonNode);

    const details = document.querySelector('.tree-details') as HTMLElement;
    expect(within(details).getByRole('heading', { name: selectedRelease.displayName })).toBeTruthy();
    expect(within(details).getByText(selectedRelease.summary)).toBeTruthy();
    expect(releaseButtonNode.getAttribute('aria-pressed')).toBe('true');
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

    const anthropicBranch = creatorDisclosure(anthropic);
    await waitFor(() => {
      expect(anthropicBranch.getAttribute('aria-expanded')).toBe('true');
      expect(familyDisclosure(claudeFiveFamily).getAttribute('aria-expanded'))
        .toBe('true');
    });

    const releaseButtonNode = releaseButton(selectedRelease);
    expect(releaseButtonNode.getAttribute('aria-pressed')).toBe('true');
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

    const anthropicBranch = creatorDisclosure(anthropic);
    await waitFor(() => expect(anthropicBranch.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.getByRole('heading', { name: 'Choose a model release' })).toBeTruthy();
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(window.location.search).toBe('?model=not-a-release&view=tree');
    expect(window.location.hash).toBe('#safe');
  });

  it('selects a release under Others and fills the details panel', async () => {
    const user = userEvent.setup();
    render(<ModelTreeExplorer tree={otherTree} sourceByReleaseId={{}} basePath="/ModelTree/" />);
    const others = disclosure('model-tree-other-creators', 'Others');

    const zenithBranch = creatorDisclosure(zenith);
    await waitFor(() => expect(zenithBranch.getAttribute('aria-expanded')).toBe('false'));
    expect(others.getAttribute('aria-expanded')).toBe('true');

    await user.click(zenithBranch);
    await user.click(familyDisclosure(zenithCore));
    const releaseButtonNode = releaseButton(zenithFlagship);
    await user.click(releaseButtonNode);

    const details = document.querySelector('.tree-details') as HTMLElement;
    expect(within(details).getByRole('heading', { name: 'Zenith Flagship' })).toBeTruthy();
    expect(within(details).getByText('Zenith Labs / Zenith Core')).toBeTruthy();
    expect(releaseButtonNode.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search).toBe('?model=other-alpha-core-one');
  });

  it('restores a deep link to an Others release by opening its creator and family', async () => {
    window.history.replaceState({}, '', '/ModelTree/tree/?model=other-zulu-atlas-one');
    render(<ModelTreeExplorer tree={otherTree} sourceByReleaseId={{}} basePath="/ModelTree/" />);

    await waitFor(() => {
      expect(familyDisclosure(zuluAtlas).getAttribute('aria-expanded')).toBe('true');
    });
    expect(releaseButton(atlasPrime).getAttribute('aria-pressed')).toBe('true');
    expect(within(document.querySelector('.tree-details') as HTMLElement).getByRole(
      'heading',
      { name: 'Atlas Prime' },
    )).toBeTruthy();
  });

  it('collapses the Others branch on demand like any other disclosure', async () => {
    const user = userEvent.setup();
    render(<ModelTreeExplorer tree={otherTree} sourceByReleaseId={{}} basePath="/ModelTree/" />);
    const others = disclosure('model-tree-other-creators', 'Others');

    const zenithBranch = creatorDisclosure(zenith);
    await waitFor(() => expect(zenithBranch.getAttribute('aria-expanded')).toBe('false'));
    await user.click(others);

    expect(others.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('model-tree-other-creators')?.hasAttribute('hidden')).toBe(true);
    expect(disclosure('model-tree-featured-creators', 'Featured ecosystems').getAttribute(
      'aria-expanded',
    )).toBe('true');
  });

  it('says in words which release is selected, and moves the word with the selection', async () => {
    // Selection was otherwise a border colour and a coloured ring, which is
    // exactly the "colour is the only signal" failure. The word is `aria-hidden`
    // because `aria-pressed` already carries the state, so this asserts the two
    // signals separately: the attribute for assistive technology, the text for
    // everyone reading the screen.
    const user = userEvent.setup();
    renderExplorer();

    // This is the test that failed the Pages deploy at 96 releases (#744), and
    // the cost was in the queries rather than in the component. The creator
    // lookup below was a role-by-name query over every button in the rendered
    // catalog; measured on this exact four-click sequence with only that lookup
    // varied, it cost 10.6ms per added release against 0.9ms for the id lookup.
    // Same clicks, same real dataset, same assertions -- only the search is
    // priced differently.
    const anthropicBranch = creatorDisclosure(anthropic);
    await waitFor(() => expect(anthropicBranch.getAttribute('aria-expanded')).toBe('false'));
    await user.click(anthropicBranch);
    await user.click(familyDisclosure(claudeFiveFamily));

    const opus = releaseButton(selectedRelease);
    const marker = () => document.querySelectorAll('.tree-release-selected');
    expect(marker()).toHaveLength(0);

    await user.click(opus);
    expect(marker()).toHaveLength(1);
    expect(opus.querySelector('.tree-release-selected')?.textContent?.trim()).toBe('Selected');
    expect(opus.querySelector('.tree-release-selected')?.getAttribute('aria-hidden')).toBe('true');
    expect(opus.getAttribute('aria-pressed')).toBe('true');

    const sibling = releaseButton(siblingRelease);
    await user.click(sibling);
    expect(marker()).toHaveLength(1);
    expect(opus.querySelector('.tree-release-selected')).toBeNull();
    expect(sibling.querySelector('.tree-release-selected')?.textContent?.trim()).toBe('Selected');
  });

  it('exposes the scrollable hierarchy as a named region in the tab order', async () => {
    renderExplorer();
    const scroll = screen.getByRole('region', { name: 'Reviewed model ecosystem hierarchy' });

    expect(scroll.classList.contains('tree-scroll')).toBe(true);
    expect(scroll.getAttribute('tabindex')).toBe('0');

    // Verified by test only as far as jsdom can go: the element is in the tab
    // order and accepts focus. Whether the ring is painted is asserted in the
    // browser, in `e2e/lineage-keyboard.e2e.ts`.
    scroll.focus();
    expect(document.activeElement).toBe(scroll);
  });
});
