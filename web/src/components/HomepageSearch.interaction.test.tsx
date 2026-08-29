// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildHomepageSearchIndex } from '../lib/homepage-search';
import { homeSuggestionsFor } from '../lib/homepage-search-view';
import HomepageSearch from './HomepageSearch';

const index = buildHomepageSearchIndex(dataset, '/');
const firstCategory = index.facets.categories[0];

// A query, derived from the index, that surfaces more than one suggestion, so a
// listbox-navigation test can observe wrapping. Uses the most common shared
// token across suggestion terms rather than pinning a value the data could drop.
const multiSuggestionQuery = (() => {
  const counts = new Map<string, number>();
  for (const suggestion of index.suggestions) {
    for (const token of new Set(suggestion.normalized.split(' '))) {
      if (token.length >= 2) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const token = ranked.find(([value]) => homeSuggestionsFor(index, value, 8).length > 1)?.[0];
  if (!token) throw new Error('index has no query surfacing multiple suggestions');
  return token;
})();

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

  it('closes the listbox on Escape, clearing the active option and keeping focus', async () => {
    const user = userEvent.setup();
    renderSearch();
    await waitFor(() => screen.getByRole('status'));

    const query = index.releases[0].name;
    await user.click(comboboxInput());
    await user.type(comboboxInput(), query);
    await screen.findByRole('listbox');

    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(comboboxInput().getAttribute('aria-activedescendant')).not.toBeNull());

    await user.keyboard('{Escape}');

    // The listbox is dismissed and no option stays active, but the typed query
    // and input focus are preserved so typing can continue.
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(comboboxInput().getAttribute('aria-expanded')).toBe('false');
    expect(comboboxInput().getAttribute('aria-activedescendant')).toBeNull();
    expect(document.activeElement).toBe(comboboxInput());
    expect((comboboxInput() as HTMLInputElement).value).toBe(query);
  });

  it('wraps to the last option with ArrowUp and tracks it via aria-activedescendant', async () => {
    const user = userEvent.setup();
    renderSearch();
    await waitFor(() => screen.getByRole('status'));

    const query = multiSuggestionQuery;
    const suggestions = homeSuggestionsFor(index, query, 8);
    // Positive control: more than one suggestion, so wrapping to the last is an
    // observable move rather than a no-op on a single-item list.
    expect(suggestions.length).toBeGreaterThan(1);

    await user.click(comboboxInput());
    await user.type(comboboxInput(), query);
    const listbox = await screen.findByRole('listbox');
    const options = within(listbox).getAllByRole('option');

    // From no active option, ArrowUp wraps to the last and the input's
    // aria-activedescendant points at exactly that option.
    await user.keyboard('{ArrowUp}');
    const last = options[options.length - 1];
    await waitFor(() => expect(last.getAttribute('aria-selected')).toBe('true'));
    expect(comboboxInput().getAttribute('aria-activedescendant')).toBe(last.id);

    // A second ArrowUp steps to the previous option, and the pointer follows.
    await user.keyboard('{ArrowUp}');
    const previous = options[options.length - 2];
    await waitFor(() => expect(previous.getAttribute('aria-selected')).toBe('true'));
    expect(comboboxInput().getAttribute('aria-activedescendant')).toBe(previous.id);
  });

  it('restores focus to the input after a pointer selection', async () => {
    const user = userEvent.setup();
    renderSearch();
    await waitFor(() => screen.getByRole('status'));

    const query = index.releases[0].name;
    await user.click(comboboxInput());
    await user.type(comboboxInput(), query);
    const listbox = await screen.findByRole('listbox');
    const option = within(listbox).getAllByRole('option')[0];

    // Move focus off the input first, so a passing assertion proves the component
    // actively restores focus rather than the input merely never losing it.
    comboboxInput().blur();
    expect(document.activeElement).not.toBe(comboboxInput());

    fireEvent.mouseDown(option);
    await waitFor(() => expect(document.activeElement).toBe(comboboxInput()));
  });

  it('drops a pinned selection from the URL once the query is edited', async () => {
    const user = userEvent.setup();
    const target = index.releases[0];
    window.history.replaceState({}, '', `/?q=${encodeURIComponent(target.canonicalName)}&sel=${target.slug}`);
    renderSearch();
    await waitFor(() => expect(window.location.search).toContain(`sel=${target.slug}`));

    // Editing the query must release the pin, so the shared link reflects the new
    // query rather than a stale selection.
    await user.type(comboboxInput(), 'x');
    await waitFor(() => expect(window.location.search).not.toContain('sel='));
    // Positive control: the URL is still populated, so the assertion above is the
    // pin being cleared, not the whole query string going empty.
    expect(window.location.search).toContain('q=');
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
