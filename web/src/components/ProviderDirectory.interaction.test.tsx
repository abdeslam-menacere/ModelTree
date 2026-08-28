// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import type { Dataset } from '../data/schema';
import { validateDataset } from '../data/validate';
import {
  buildProviderDirectory,
  DIRECTORY_LETTERS,
  letterSectionId,
  type DirectoryModel,
} from '../lib/provider-directory';
import ProviderDirectory from './ProviderDirectory';

const SOURCE = {
  id: 'src-a',
  url: 'https://example.com/a',
  title: 'Announcement',
  type: 'official-announcement',
  publisherId: 'example',
  lastCheckedDate: '2026-01-01',
};

function organization(id: string, name: string) {
  return {
    id,
    slug: id,
    name,
    shortName: name.split(' ')[0],
    type: 'company',
    website: `https://${id}.example/`,
    releasePage: `https://${id}.example/news`,
    description: 'Fixture organization.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
  };
}

function family(id: string, organizationId: string) {
  return {
    id,
    slug: id,
    organizationId,
    name: id,
    description: 'Fixture family.',
    categories: ['language-reasoning'],
    firstReleaseDate: '2025-01-01',
    datePrecision: 'day',
    status: 'current',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
  };
}

function release(id: string, organizationId: string, familyId: string) {
  return {
    id,
    slug: id,
    canonicalName: id,
    displayName: id,
    organizationId,
    familyId,
    version: '1',
    variant: 'Standard',
    releaseDate: '2025-06-01',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    summary: 'A fixture release.',
    intendedUse: 'Fixture use.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
  };
}

/**
 * A dataset with both roles populated. The seed data holds no serving platform,
 * so rendering it alone would leave every platform-group assertion agreeing
 * about an empty list; this fixture is what makes those assertions able to fail.
 * It also carries a deliberately long name, for the narrow-width requirement.
 */
const LONG_NAME = 'Zetterberg Institute for Extraordinarily Long Organization Names';

function populatedDataset(): Dataset {
  return validateDataset({
    sources: [SOURCE],
    publishers: [{ id: 'example', name: 'Example' }],
    organizations: [
      organization('alpha', 'Alpha Labs'),
      organization('hostco', 'Hosting Co'),
      organization('zetterberg', LONG_NAME),
    ],
    families: [family('alpha-one', 'alpha'), family('zetterberg-one', 'zetterberg')],
    releases: [
      release('alpha-new', 'alpha', 'alpha-one'),
      release('zetterberg-new', 'zetterberg', 'zetterberg-one'),
    ],
    servingPlatforms: [
      {
        id: 'alpha-api',
        slug: 'alpha-api',
        name: 'Alpha API',
        organizationId: 'alpha',
        type: 'first-party-api',
        website: 'https://alpha.example/api',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
      {
        id: 'hosting-cloud',
        slug: 'hosting-cloud',
        name: 'Hosting Cloud',
        organizationId: 'hostco',
        type: 'cloud-platform',
        website: 'https://hostco.example/cloud',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
    ],
  });
}

const populated = buildProviderDirectory(populatedDataset(), '/');
const seed = buildProviderDirectory(seedDataset, '/');

const CREATOR_LABEL = populated.groups.find((group) => group.id === 'creators')!.label;
const PLATFORM_LABEL = populated.groups.find((group) => group.id === 'serving-platforms')!.label;

function renderDirectory(directory: DirectoryModel = populated) {
  return render(<ProviderDirectory directory={directory} />);
}

function creatorNav() {
  return screen.getByRole('navigation', { name: `Jump to a letter in ${CREATOR_LABEL}` });
}

function letterLink(nav: HTMLElement, letter: string) {
  return within(nav).getByRole('link', { name: new RegExp(`^${letter}(,|$)`) });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/providers/');
});

afterEach(() => {
  cleanup();
});

describe('ProviderDirectory groups and roles', () => {
  it('renders creators and serving platforms as separately labelled sections', async () => {
    renderDirectory();
    await waitFor(() => screen.getByRole('heading', { name: 'Model creators and labs', level: 2 }));

    const creators = screen.getByRole('heading', { name: 'Model creators and labs', level: 2 });
    const platforms = screen.getByRole('heading', { name: 'Serving platforms', level: 2 });

    expect(creators.closest('section')).not.toBe(platforms.closest('section'));
    // Positive control: both groups have entries in this fixture, so a mix-up
    // between them would be visible rather than hidden behind an empty list.
    expect(populated.groups.map((group) => group.total).every((total) => total > 0)).toBe(true);
  });

  it('states each role in the row text, not only by which group it is in', async () => {
    renderDirectory();
    await waitFor(() => screen.getByText('Alpha API'));

    const creatorRow = screen.getByText('Alpha Labs').closest('.directory-row') as HTMLElement;
    const platformRow = screen.getByText('Alpha API').closest('.directory-row') as HTMLElement;

    expect(within(creatorRow).getByText('Model creator and serving-platform operator')).toBeDefined();
    expect(within(creatorRow).getByText(/also operates 1 serving platform/)).toBeDefined();
    expect(within(platformRow).getByText('Serving platform, operated by a model creator')).toBeDefined();
    expect(within(platformRow).getByText(/operated by Alpha Labs/)).toBeDefined();
  });

  it('links a creator to its filtered catalog and says so when nothing is generated', async () => {
    renderDirectory();
    await waitFor(() => screen.getByText('Alpha API'));

    const creatorRow = screen.getByText('Alpha Labs').closest('.directory-row') as HTMLElement;
    const platformRow = screen.getByText('Alpha API').closest('.directory-row') as HTMLElement;

    expect(within(creatorRow).getByRole('link', { name: 'Alpha Labs' }).getAttribute('href'))
      .toBe('/models/?creator=alpha');
    expect(within(platformRow).queryByRole('link')).toBeNull();
    expect(within(platformRow).getByText('A serving-platform page is not generated yet.')).toBeDefined();
  });

  it('explains an empty group instead of rendering an empty alphabet bar', async () => {
    // The seed dataset now holds sourced serving platforms, so the empty state
    // is proven against a dataset explicitly stripped of them rather than
    // against whatever the data happens to contain. Left resting on the seed,
    // this coverage would have disappeared silently the day the first platform
    // record landed -- which is the day it did.
    renderDirectory(buildProviderDirectory({ ...seedDataset, servingPlatforms: [] }, '/'));
    await waitFor(() => screen.getByRole('heading', { name: 'Serving platforms', level: 2 }));

    const platforms = screen.getByRole('heading', { name: 'Serving platforms', level: 2 })
      .closest('section') as HTMLElement;

    expect(within(platforms).getByText(/No serving platform has been added/)).toBeDefined();
    expect(screen.queryByRole('navigation', { name: `Jump to a letter in ${PLATFORM_LABEL}` })).toBeNull();
    expect(creatorNav()).toBeDefined();
  });

  it('renders the seed serving platforms rather than the empty message', async () => {
    // The counterpart to the test above, and the reason it had to change: the
    // shipped data reaches this group now, so the populated branch is real.
    expect(seedDataset.servingPlatforms.length).toBeGreaterThan(0);
    renderDirectory(seed);
    await waitFor(() => screen.getByRole('heading', { name: 'Serving platforms', level: 2 }));

    const platforms = screen.getByRole('heading', { name: 'Serving platforms', level: 2 })
      .closest('section') as HTMLElement;

    expect(within(platforms).queryByText(/No serving platform has been added/)).toBeNull();
    for (const platform of seedDataset.servingPlatforms) {
      expect(within(platforms).getByText(platform.name)).toBeDefined();
    }
  });
});

describe('ProviderDirectory A to Z navigation', () => {
  it('links only the letters that have entries and leaves the rest as inert text', async () => {
    renderDirectory();
    await waitFor(() => creatorNav());

    const nav = creatorNav();
    const linked = within(nav).getAllByRole('link').filter((node) =>
      node.classList.contains('directory-letter'));
    const inert = Array.from(nav.querySelectorAll('.directory-letter.is-empty'));

    expect(linked.map((node) => node.textContent?.trim().slice(0, 1))).toEqual(['A', 'Z']);
    // Every remaining letter of the alphabet is still shown, and none of them is
    // focusable, so the bar keeps its shape without offering dead controls.
    expect(inert.length).toBe(DIRECTORY_LETTERS.length - linked.length);
    expect(inert.every((node) => node.tagName === 'SPAN')).toBe(true);
    expect(inert.every((node) => !node.hasAttribute('href'))).toBe(true);
  });

  it('moves focus to the labelled letter section when a letter is clicked', async () => {
    const user = userEvent.setup();
    renderDirectory();
    await waitFor(() => creatorNav());

    await user.click(letterLink(creatorNav(), 'A'));

    const section = document.getElementById(letterSectionId('creators', 'A'));
    expect(section).not.toBeNull();
    expect(document.activeElement).toBe(section);
    // The section is a labelled region, so the jump announces where it landed.
    const labelledBy = section!.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent)
      .toContain(`A in ${CREATOR_LABEL}, 1 creator`);
  });

  it('reaches a letter and activates it with the keyboard alone', async () => {
    const user = userEvent.setup();
    renderDirectory();
    await waitFor(() => creatorNav());

    const target = letterLink(creatorNav(), 'Z');
    target.focus();
    expect(document.activeElement).toBe(target);

    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(document.getElementById(letterSectionId('creators', 'Z')));
  });

  it('offers a skip link that jumps focus past the alphabet to the entries', async () => {
    const user = userEvent.setup();
    renderDirectory();
    await waitFor(() => creatorNav());

    const skip = within(creatorNav()).getByRole('link', { name: 'Skip the A to Z links' });
    await user.click(skip);

    const entries = document.getElementById('directory-creators-entries');
    expect(entries).not.toBeNull();
    expect(document.activeElement).toBe(entries);
  });

  it('gives the two groups distinct section ids for the same letter', async () => {
    renderDirectory();
    await waitFor(() => creatorNav());

    expect(document.getElementById(letterSectionId('creators', 'A'))).not.toBeNull();
    expect(document.getElementById(letterSectionId('serving-platforms', 'A'))).not.toBeNull();
    expect(letterSectionId('creators', 'A')).not.toBe(letterSectionId('serving-platforms', 'A'));
  });
});

describe('ProviderDirectory search', () => {
  it('narrows both groups, updates the counts, and rewrites the shareable URL', async () => {
    const user = userEvent.setup();
    renderDirectory();
    await waitFor(() => screen.getByText('Alpha API'));

    await user.type(screen.getByLabelText('Search creators and serving platforms'), 'alpha');

    await waitFor(() => expect(window.location.search).toBe('?q=alpha'));
    expect(screen.getByText('Alpha Labs')).toBeDefined();
    expect(screen.getByText('Alpha API')).toBeDefined();
    expect(screen.queryByText('Hosting Cloud')).toBeNull();
    expect(screen.queryByText(LONG_NAME)).toBeNull();
    expect(screen.getByText('1 creator')).toBeDefined();
    expect(screen.getByText('1 serving platform')).toBeDefined();
  });

  it('drops the letters that no longer have entries from the jump bar', async () => {
    const user = userEvent.setup();
    renderDirectory();
    await waitFor(() => creatorNav());

    const before = within(creatorNav()).getAllByRole('link')
      .filter((node) => node.classList.contains('directory-letter'));
    expect(before.map((node) => node.textContent?.trim().slice(0, 1))).toEqual(['A', 'Z']);

    await user.type(screen.getByLabelText('Search creators and serving platforms'), 'alpha');

    await waitFor(() => {
      const after = within(creatorNav()).getAllByRole('link')
        .filter((node) => node.classList.contains('directory-letter'));
      expect(after.map((node) => node.textContent?.trim().slice(0, 1))).toEqual(['A']);
    });
  });

  it('finds a platform by its operator and by its type', async () => {
    const user = userEvent.setup();
    renderDirectory();
    await waitFor(() => screen.getByText('Hosting Cloud'));

    const input = screen.getByLabelText('Search creators and serving platforms');
    await user.type(input, 'cloud platform');

    await waitFor(() => expect(screen.getByText('Hosting Cloud')).toBeDefined());
    expect(screen.queryByText('Alpha API')).toBeNull();

    await user.clear(input);
    await user.type(input, 'hosting co');

    await waitFor(() => expect(screen.getByText('Hosting Cloud')).toBeDefined());
  });

  it('says which query matched nothing rather than falling back to everything', async () => {
    const user = userEvent.setup();
    renderDirectory();
    await waitFor(() => screen.getByText('Alpha API'));

    await user.type(screen.getByLabelText('Search creators and serving platforms'), 'zzznomatch');

    await waitFor(() => expect(screen.getByText('No creators match “zzznomatch”.')).toBeDefined());
    expect(screen.getByText('No serving platforms match “zzznomatch”.')).toBeDefined();
    expect(screen.getByText('0 entries matching “zzznomatch”.')).toBeDefined();
    expect(screen.queryByText('Alpha Labs')).toBeNull();
  });

  it('restores a copied query URL and clears back to a clean one', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/providers/?q=hosting');
    renderDirectory();

    await waitFor(() => {
      const input = screen.getByLabelText('Search creators and serving platforms') as HTMLInputElement;
      expect(input.value).toBe('hosting');
    });
    expect(screen.getByText('Hosting Cloud')).toBeDefined();
    expect(screen.queryByText('Alpha Labs')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.getByText('Alpha Labs')).toBeDefined();
  });

  it('restores the view again when the reader navigates back', async () => {
    renderDirectory();
    await waitFor(() => screen.getByText('Alpha Labs'));

    window.history.replaceState({}, '', '/providers/?q=hosting');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(screen.queryByText('Alpha Labs')).toBeNull());
    expect(screen.getByText('Hosting Cloud')).toBeDefined();
  });
});

describe('ProviderDirectory presentation', () => {
  it('wraps a long organization name instead of widening the row', async () => {
    renderDirectory();
    await waitFor(() => screen.getByText(LONG_NAME));

    const name = screen.getByText(LONG_NAME).closest('.directory-name');
    expect(name).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    expect(css).toMatch(/\.directory-name\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('keeps a visible focus outline on the sections a jump link targets', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');

    expect(css).toMatch(/\.directory-letter-section:focus-visible\s*\{[^}]*outline:/);
    expect(css).toMatch(/\.directory-skip:focus-visible\s*\{[^}]*transform:\s*translateY\(0\)/);
  });

  it('names an organization with no evidenced role instead of dropping it', async () => {
    const withUnclassified = buildProviderDirectory(
      validateDataset({
        sources: [SOURCE],
        publishers: [{ id: 'example', name: 'Example' }],
        organizations: [organization('alpha', 'Alpha Labs'), organization('quiet', 'Quiet Holdings')],
        families: [family('alpha-one', 'alpha')],
        releases: [release('alpha-new', 'alpha', 'alpha-one')],
      }),
      '/',
    );
    renderDirectory(withUnclassified);

    await waitFor(() => screen.getByRole('heading', { name: 'Organizations with no role recorded yet' }));

    const notice = screen.getByRole('heading', { name: 'Organizations with no role recorded yet' })
      .closest('section') as HTMLElement;
    expect(within(notice).getByText(/Quiet Holdings/)).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Quiet Holdings' })).toBeNull();
  });

  it('omits the no-role notice when every organization has a role', async () => {
    renderDirectory();
    await waitFor(() => screen.getByText('Alpha Labs'));

    expect(populated.unclassified).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Organizations with no role recorded yet' })).toBeNull();
  });
});
