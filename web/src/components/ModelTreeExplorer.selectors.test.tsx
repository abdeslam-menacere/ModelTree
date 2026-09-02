// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  datasetWithPrefixCollidingNames,
  prefixCollidingFamilies,
  prefixCollidingReleases,
} from '../../tests/fixtures/model-tree-dataset';
import { familyDisclosure, releaseButton } from '../../tests/helpers/model-tree-queries';
import { buildModelTree } from '../lib/model-tree';
import ModelTreeExplorer from './ModelTreeExplorer';

/**
 * The permanent regression guard for issue #777.
 *
 * The defect was `getByRole('button', { name: /^Claude 5/ })`: anchored at the
 * start of the accessible name and open-ended at the finish, so it matched
 * `Claude 5` and any later `Claude 5.x` at once. Nothing in the reviewed catalog
 * exercised it, which is exactly why it survived -- the ambiguity only appears
 * on the day a point release is recorded, and on that day it appears as twelve
 * failures in two files that are about disclosure behaviour.
 *
 * A fix proved only against today's dataset would therefore prove nothing: the
 * dataset has no `Claude 5.1` in it, and this branch must not add one (that data
 * belongs to its own change). So the collision is held in the fixture instead,
 * permanently, under invented names -- `Prism 5` beside `Prism 5.1`, and
 * `Prism Opus 5` beside `Prism Opus 5.1`. The first test below asserts the
 * collision is real before any of the others claim to survive it; a guard whose
 * fixture had quietly stopped colliding would otherwise pass while testing
 * nothing.
 */

const tree = buildModelTree(datasetWithPrefixCollidingNames);

const baseFamily = prefixCollidingFamilies.find(({ id }) => id === 'other-prism-5')!;
const pointFamily = prefixCollidingFamilies.find(({ id }) => id === 'other-prism-5-1')!;
const baseRelease = prefixCollidingReleases.find(({ id }) => id === 'other-prism-opus-5')!;
const pointRelease = prefixCollidingReleases.find(({ id }) => id === 'other-prism-opus-5-1')!;

function renderExplorer() {
  return render(
    <ModelTreeExplorer tree={tree} sourceByReleaseId={{}} basePath="/ModelTree/" />,
  );
}

function creatorDisclosure() {
  // Selected by the creator's own stable id, for the same reason as everything
  // else here. The only name-prefix queries in this file are the two that exist
  // to demonstrate that a name prefix is ambiguous.
  return document.querySelector<HTMLButtonElement>(
    '[aria-controls="tree-creator-other-prism"]',
  ) as HTMLButtonElement;
}

async function openCreator(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(creatorDisclosure().getAttribute('aria-expanded')).toBe('false'));
  await user.click(creatorDisclosure());
}

beforeEach(() => {
  window.history.replaceState({}, '', '/ModelTree/tree/');
});

afterEach(() => {
  cleanup();
});

describe('lineage tree queries under prefix-colliding display names', () => {
  it('puts two families and two releases with prefix-sharing names in one creator', async () => {
    // The control for every other test in this file. If these stop being prefix
    // extensions of one another the fixture no longer reproduces #777, and the
    // guard below would pass for the wrong reason.
    expect(pointFamily.name.startsWith(baseFamily.name)).toBe(true);
    expect(pointRelease.displayName.startsWith(baseRelease.displayName)).toBe(true);

    const user = userEvent.setup();
    renderExplorer();
    await openCreator(user);

    // Written in the exact shape the old selectors used, because the point is
    // that this shape resolves to two elements and `getByRole` would throw.
    expect(screen.getAllByRole('button', { name: /^Prism 5/ })).toHaveLength(2);
  });

  it('resolves each colliding family disclosure to exactly one button', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await openCreator(user);

    const base = familyDisclosure(baseFamily);
    const point = familyDisclosure(pointFamily);

    expect(base).not.toBe(point);
    expect(base.getAttribute('aria-controls')).toBe('tree-family-other-prism-5');
    expect(point.getAttribute('aria-controls')).toBe('tree-family-other-prism-5-1');
  });

  it('opens the family it was asked for and leaves its prefix twin closed', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await openCreator(user);

    await user.click(familyDisclosure(baseFamily));

    // Uniqueness alone would be satisfied by a query that reliably found the
    // wrong element, so the identification is checked by behaviour too.
    expect(familyDisclosure(baseFamily).getAttribute('aria-expanded')).toBe('true');
    expect(familyDisclosure(pointFamily).getAttribute('aria-expanded')).toBe('false');
  });

  it('resolves each colliding release to exactly one button and selects it alone', async () => {
    const user = userEvent.setup();
    renderExplorer();
    await openCreator(user);
    await user.click(familyDisclosure(baseFamily));
    await user.click(familyDisclosure(pointFamily));

    expect(screen.getAllByRole('button', { name: /^Prism Opus 5/ })).toHaveLength(2);

    const base = releaseButton(baseRelease);
    const point = releaseButton(pointRelease);
    expect(base).not.toBe(point);

    await user.click(base);
    expect(base.getAttribute('aria-pressed')).toBe('true');
    expect(point.getAttribute('aria-pressed')).toBe('false');
    expect(window.location.search).toBe(`?model=${baseRelease.id}`);
  });
});
