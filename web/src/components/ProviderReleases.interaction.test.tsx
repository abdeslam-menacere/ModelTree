// @vitest-environment jsdom

import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProviderProfile } from '../lib/provider-profile';
import { RELEASE_STATUS_PARAM } from '../lib/provider-releases';
import {
  providerProfileFixtureDataset as fixture,
  PRIME_ORG_ID,
} from '../../tests/fixtures/provider-profile-dataset';
import ProviderReleases from './ProviderReleases';

const profile = buildProviderProfile(fixture, PRIME_ORG_ID, '/ModelTree')!;

function renderReleases() {
  return render(<ProviderReleases rows={profile.releases} statuses={profile.statusesPresent} />);
}

function filterButton(name: string) {
  return within(document.querySelector('.release-filter') as HTMLElement)
    .getByRole('button', { name });
}

function visibleReleaseIds() {
  return [...document.querySelectorAll('.release-row a')].map((node) => node.textContent);
}

beforeEach(() => {
  window.history.replaceState({}, '', '/ModelTree/providers/fixture-prime-labs/');
});

afterEach(() => {
  cleanup();
});

describe('ProviderReleases without JavaScript state', () => {
  it('server-renders the full list before any interaction', () => {
    renderReleases();
    // Both releases present with no filter applied, so a no-JS reader sees them.
    expect(visibleReleaseIds()).toEqual(['Prime Core V2', 'Prime Core V1']);
  });

  it('offers exactly the statuses the creator has, plus All', () => {
    renderReleases();
    const labels = [...document.querySelectorAll('.release-filter-option')]
      .map((node) => node.textContent);
    expect(labels).toEqual(['All', 'Available', 'Legacy']);
  });
});

describe('ProviderReleases filtering', () => {
  it('narrows the list to a selected status and marks the button pressed', async () => {
    const user = userEvent.setup();
    renderReleases();

    await user.click(filterButton('Legacy'));

    await waitFor(() => {
      expect(visibleReleaseIds()).toEqual(['Prime Core V1']);
    });
    expect(filterButton('Legacy').getAttribute('aria-pressed')).toBe('true');
    expect(filterButton('All').getAttribute('aria-pressed')).toBe('false');
  });

  it('writes the selection to the URL and clears it for All', async () => {
    const user = userEvent.setup();
    renderReleases();

    await user.click(filterButton('Legacy'));
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get(RELEASE_STATUS_PARAM)).toBe('legacy');
    });

    await user.click(filterButton('All'));
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get(RELEASE_STATUS_PARAM)).toBeNull();
    });
  });

  it('preserves an unrelated query parameter and the fragment when filtering', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/ModelTree/providers/fixture-prime-labs/?provider=x#tree');
    renderReleases();

    await user.click(filterButton('Available'));

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.searchParams.get('provider')).toBe('x');
      expect(url.searchParams.get(RELEASE_STATUS_PARAM)).toBe('current');
      expect(url.hash).toBe('#tree');
    });
  });

  it('restores the filter from the URL on mount', async () => {
    window.history.replaceState(
      {},
      '',
      `/ModelTree/providers/fixture-prime-labs/?${RELEASE_STATUS_PARAM}=legacy`,
    );
    renderReleases();

    await waitFor(() => {
      expect(visibleReleaseIds()).toEqual(['Prime Core V1']);
    });
    expect(filterButton('Legacy').getAttribute('aria-pressed')).toBe('true');
  });

  it('restores the filter on a Back/Forward navigation', async () => {
    const user = userEvent.setup();
    renderReleases();

    await user.click(filterButton('Legacy'));
    await waitFor(() => expect(visibleReleaseIds()).toEqual(['Prime Core V1']));

    // Simulate the browser restoring an earlier URL and firing popstate.
    window.history.replaceState({}, '', '/ModelTree/providers/fixture-prime-labs/');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => {
      expect(visibleReleaseIds()).toEqual(['Prime Core V2', 'Prime Core V1']);
    });
    expect(filterButton('All').getAttribute('aria-pressed')).toBe('true');
  });

  it('states the count in words, not by emphasis alone', async () => {
    const user = userEvent.setup();
    renderReleases();

    expect(document.querySelector('.release-filter-summary')?.textContent)
      .toContain('all 2 releases');

    await user.click(filterButton('Legacy'));
    await waitFor(() => {
      expect(document.querySelector('.release-filter-summary')?.textContent)
        .toContain('1 release');
    });
  });
});
