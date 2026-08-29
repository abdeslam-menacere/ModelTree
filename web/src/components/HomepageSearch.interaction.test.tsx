// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildHomepageSearchIndex } from '../lib/homepage-search';
import { homeSuggestionsFor } from '../lib/homepage-search-view';
import HomepageSearch from './HomepageSearch';

const index = buildHomepageSearchIndex(dataset, '/');
const firstCategory = index.facets.categories[0];

function renderSearch() {
  return render(<HomepageSearch index={index} />);
}

function resultCount() {
  return document.querySelectorAll('.home-search-result').length;
}

function comboboxInput() {
  return screen.getByRole('combobox');
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
});

describe('HomepageSearch', () => {
  it('renders every featured release as a passport link in the broad default view', async () => {
    renderSearch();
    await waitFor(() => expect(document.querySelector('.home-search-results')).not.toBeNull());

    expect(resultCount()).toBe(index.releases.length);
    expect(resultCount()).toBeGreaterThan(0);

    const links = Array.from(document.querySelectorAll('.home-search-result-title')).map((node) => ({
      name: node.textContent,
      href: node.getAttribute('href'),
    }));
    for (const row of index.releases) {
      expect(links).toContainEqual({ name: row.name, href: row.route });
    }
  });

  it('announces the result count through a polite live region', async () => {
    renderSearch();
    await waitFor(() => screen.getByRole('status'));
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('offers a keyboard combobox that selects a model and writes shareable state', async () => {
    const user = userEvent.setup();
    renderSearch();
    await waitFor(() => screen.getByRole('status'));

    const query = index.releases[0].name;
    const suggestions = homeSuggestionsFor(index, query, 8);
    const targetPosition = suggestions.findIndex(
      (suggestion) => suggestion.entity === 'model' && suggestion.targetSlug,
    );
    // Positive control: the query must actually surface a selectable model.
    expect(targetPosition).toBeGreaterThanOrEqual(0);
    const target = suggestions[targetPosition];

    await user.click(comboboxInput());
    await user.type(comboboxInput(), query);

    const listbox = await screen.findByRole('listbox');
    expect(comboboxInput().getAttribute('aria-expanded')).toBe('true');
    expect(within(listbox).getAllByRole('option').length).toBe(suggestions.length);

    // Arrow down to the target option, then commit it with Enter.
    for (let step = 0; step <= targetPosition; step += 1) {
      await user.keyboard('{ArrowDown}');
    }
    const activeOption = within(listbox).getAllByRole('option')[targetPosition];
    await waitFor(() => expect(activeOption.getAttribute('aria-selected')).toBe('true'));

    await user.keyboard('{Enter}');

    await waitFor(() => expect(window.location.search).toContain(`sel=${target.targetSlug}`));
    expect(window.location.search).toContain('q=');
    // The chosen release is marked current in the results.
    const selectedCard = document.querySelector('.home-search-result[data-selected="true"]');
    expect(selectedCard).not.toBeNull();
    expect(selectedCard?.querySelector('.home-search-result-title')?.getAttribute('href'))
      .toBe(index.releases.find((row) => row.slug === target.targetSlug)?.route);
  });

  it('reaches the empty state on a non-matching query and resets from it', async () => {
    const user = userEvent.setup();
    renderSearch();
    await waitFor(() => screen.getByRole('status'));

    await user.type(comboboxInput(), 'zzqqxxnomatch');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No featured releases match'));
    expect(resultCount()).toBe(0);

    const reset = screen.getByRole('button', { name: /clear search and filters/i });
    await user.click(reset);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(resultCount()).toBe(index.releases.length);
  });

  it('narrows to a single-named release, proving search actually filters', async () => {
    const user = userEvent.setup();
    renderSearch();
    await waitFor(() => screen.getByRole('status'));

    const before = resultCount();
    const target = index.releases[0];
    await user.type(comboboxInput(), target.canonicalName);

    await waitFor(() => {
      const links = Array.from(document.querySelectorAll('.home-search-result-title')).map(
        (node) => node.getAttribute('href'),
      );
      expect(links).toContain(target.route);
    });
    // The set genuinely shrank rather than staying the full list.
    expect(resultCount()).toBeLessThan(before);
    expect(window.location.search).toContain('q=');
  });

  it('filters by a category facet and matches its recorded count', async () => {
    const user = userEvent.setup();
    renderSearch();
    await waitFor(() => screen.getByRole('status'));

    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    const checkbox = await screen.findByRole('checkbox', { name: new RegExp(`^${firstCategory.label}`) });
    await user.click(checkbox);

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(String(firstCategory.count)));
    expect(window.location.search).toContain(`category=${firstCategory.value}`);

    // Removing the active-filter chip returns to the full set.
    const active = screen.getByRole('list', { name: 'Active filters' });
    await user.click(within(active).getByRole('button'));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(resultCount()).toBe(index.releases.length);
  });

  it('restores query, filter, and selection from the URL on load (reload round trip)', async () => {
    const target = index.releases[0];
    window.history.replaceState({}, '', `/?q=${encodeURIComponent(target.canonicalName)}&category=${firstCategory.value}&sel=${target.slug}`);
    renderSearch();

    await waitFor(() => expect((comboboxInput() as HTMLInputElement).value).toBe(target.canonicalName));
    // The restored filter is reported as an active chip without opening the panel.
    const active = screen.getByRole('list', { name: 'Active filters' });
    expect(within(active).getByText(new RegExp(firstCategory.label))).not.toBeNull();
  });

  it('reflects browser back/forward navigation through popstate', async () => {
    renderSearch();
    await waitFor(() => screen.getByRole('status'));
    expect((comboboxInput() as HTMLInputElement).value).toBe('');

    const target = index.releases[0];
    window.history.replaceState({}, '', `/?q=${encodeURIComponent(target.canonicalName)}`);
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect((comboboxInput() as HTMLInputElement).value).toBe(target.canonicalName));
    const links = Array.from(document.querySelectorAll('.home-search-result-title')).map(
      (node) => node.getAttribute('href'),
    );
    expect(links).toContain(target.route);
  });
});
