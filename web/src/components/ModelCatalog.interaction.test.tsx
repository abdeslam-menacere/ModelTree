// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildCatalogIndex } from '../lib/catalog';
import type { ModelIndexRow } from '../lib/catalog';
import {
  CATALOG_PAGE_SIZE,
  defaultCatalogState,
  deriveCatalogResults,
} from '../lib/catalog-view';
import ModelCatalog from './ModelCatalog';

const index = buildCatalogIndex(dataset, '/');
const total = index.models.length;
const firstCreator = index.facets.creators[0];

// A synthetic set several pages deep, so pagination coverage never depends on
// the seed staying above one page and cannot silently go trivial as data grows.
const manyModels: ModelIndexRow[] = Array.from(
  { length: CATALOG_PAGE_SIZE * 3 + 5 },
  (_, i) => ({
    ...index.models[i % index.models.length],
    slug: `bulk-${i}`,
    route: `/models/bulk-${i}/`,
    name: `Bulk Model ${i}`,
  }),
);

function renderCatalog(models: ModelIndexRow[] = index.models) {
  return render(<ModelCatalog models={models} facets={index.facets} />);
}

function tableRowCount() {
  return document.querySelectorAll('.catalog-table tbody tr').length;
}

function creatorCheckbox(name: string) {
  return screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });
}

function firstPageRows(sort: ReturnType<typeof defaultCatalogState>['sort'] = 'release-date') {
  return deriveCatalogResults(
    index.models,
    { ...defaultCatalogState(), sort },
    index.facets,
    CATALOG_PAGE_SIZE,
  ).pageRows;
}

function linksIn(selector: string) {
  return Array.from(document.querySelectorAll(selector)).map((node) => ({
    name: node.textContent,
    href: node.getAttribute('href'),
  }));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/models/');
});

afterEach(() => {
  cleanup();
});

describe('ModelCatalog', () => {
  it('links every rendered result to its passport route, in both table and list views', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('table'));

    const expected = firstPageRows().map((row) => ({ name: row.name, href: row.route }));

    const tableLinks = linksIn('.catalog-table tbody th a');
    expect(tableLinks).toHaveLength(expected.length);
    for (const entry of expected) {
      expect(tableLinks).toContainEqual(entry);
    }

    await user.click(screen.getByRole('button', { name: 'Compact list' }));
    await waitFor(() => expect(document.querySelector('.catalog-list')).not.toBeNull());

    const listLinks = linksIn('.catalog-list a.catalog-list-title');
    expect(listLinks).toHaveLength(expected.length);
    for (const entry of expected) {
      expect(listLinks).toContainEqual(entry);
    }
  });

  it('associates every data cell with a header: 8 column headers, a row header per row, and a caption', async () => {
    renderCatalog();
    await waitFor(() => screen.getByRole('table'));

    expect(document.querySelectorAll('.catalog-table thead th[scope="col"]')).toHaveLength(8);

    const rowHeaders = document.querySelectorAll('.catalog-table tbody th[scope="row"]');
    expect(rowHeaders).toHaveLength(tableRowCount());
    expect(rowHeaders.length).toBeGreaterThan(0);
    for (const header of Array.from(rowHeaders)) {
      expect(header.querySelector('a')).not.toBeNull();
    }

    const caption = document.querySelector('.catalog-table caption');
    expect(caption).not.toBeNull();
    expect(caption?.classList.contains('visually-hidden')).toBe(true);
  });

  it('announces the result count through a polite live region', async () => {
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('reorders results when the sort control changes', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('table'));

    const byDate = firstPageRows('release-date')[0].name;
    const byName = firstPageRows('name')[0].name;
    // The fixture must actually distinguish the two orders or this asserts nothing.
    expect(byName).not.toBe(byDate);

    const firstLink = () => document.querySelector('.catalog-table tbody th a')?.textContent;
    expect(firstLink()).toBe(byDate);

    await user.selectOptions(screen.getByLabelText('Sort by'), 'name');
    await waitFor(() => expect(firstLink()).toBe(byName));
    expect(window.location.search).toContain('sort=name');
  });

  it('filters by a creator facet and matches its recorded count', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));

    await user.click(creatorCheckbox(firstCreator.label));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(String(firstCreator.count)));
    expect(window.location.search).toContain(`creator=${firstCreator.value}`);
  });

  it('resets to the first page when a new search is entered', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('navigation', { name: 'Catalog pages' }));

    const nav = screen.getByRole('navigation', { name: 'Catalog pages' });
    await user.click(within(nav).getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(window.location.search).toContain('page=2'));

    // "a" matches many models, so results survive; the page must fall back to 1.
    await user.type(screen.getByLabelText('Search models'), 'a');
    await waitFor(() => expect(window.location.search).toContain('q=a'));
    expect(window.location.search).not.toContain('page=');
  });

  it('restores filter, sort, and view from the URL', async () => {
    window.history.replaceState({}, '', `/models/?creator=${firstCreator.value}&sort=name&view=list`);
    renderCatalog();

    await waitFor(() => expect((creatorCheckbox(firstCreator.label) as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('name');
    expect(document.querySelector('.catalog-list')).not.toBeNull();
    expect(document.querySelector('.catalog-table')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(String(firstCreator.count));
  });

  it('restores the active page from the URL', async () => {
    window.history.replaceState({}, '', '/models/?page=2');
    renderCatalog();

    await waitFor(() => screen.getByRole('navigation', { name: 'Catalog pages' }));
    const nav = screen.getByRole('navigation', { name: 'Catalog pages' });
    expect(within(nav).getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBe('page');

    const expectedFirst = deriveCatalogResults(
      index.models,
      { ...defaultCatalogState(), page: 2 },
      index.facets,
      CATALOG_PAGE_SIZE,
    ).pageRows[0];
    expect(document.querySelector('.catalog-table tbody th a')?.textContent).toBe(expectedFirst.name);
  });

  it('reflects browser back/forward navigation through popstate', async () => {
    renderCatalog();
    await waitFor(() => screen.getByRole('table'));
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('release-date');

    window.history.replaceState({}, '', '/models/?sort=name&view=list');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('name'));
    expect(document.querySelector('.catalog-list')).not.toBeNull();
  });

  it('clears an individual filter and clears all filters', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));

    await user.click(creatorCheckbox(firstCreator.label));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(String(firstCreator.count)));

    const activeFilters = screen.getByRole('list', { name: 'Active filters' });
    await user.click(within(activeFilters).getByRole('button'));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(String(total)));
    expect(window.location.search).toBe('');
  });

  it('offers per-filter and clear-all actions when a filter empties the results', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));

    // Reach the empty state via a FILTER (not search alone) so results.active is
    // non-empty and the per-filter clear branch actually renders.
    await user.click(creatorCheckbox(firstCreator.label));
    await user.type(screen.getByLabelText('Search models'), 'zzzznomatchzzzz');

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No models match'));
    expect(tableRowCount()).toBe(0);

    const empty = document.querySelector('.catalog-empty-actions') as HTMLElement;
    expect(empty).not.toBeNull();
    const perFilter = within(empty).getByRole('button', { name: new RegExp(`^Clear .+: ${firstCreator.label}`) });
    await user.click(perFilter);

    await waitFor(() => expect(window.location.search).not.toContain(`creator=${firstCreator.value}`));

    // The clear-all action is also offered and empties every filter and the search.
    await user.click(within(empty).getByRole('button', { name: /clear all filters/i }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('wraps the results table in a horizontally scrollable region for mobile overflow', async () => {
    renderCatalog();
    await waitFor(() => screen.getByRole('table'));

    const scroll = screen.getByRole('table').closest('.catalog-table-scroll');
    expect(scroll).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    expect(css).toMatch(/\.catalog-table-scroll\s*\{[^}]*overflow(?:-x)?:\s*auto/);
  });

  it('paginates with the keyboard, keeps focus on the active page, and stays bounded', async () => {
    const user = userEvent.setup();
    renderCatalog(manyModels);
    await waitFor(() => screen.getByRole('navigation', { name: 'Catalog pages' }));

    const nav = screen.getByRole('navigation', { name: 'Catalog pages' });
    const lastPage = Math.ceil(manyModels.length / CATALOG_PAGE_SIZE);
    expect(lastPage).toBeGreaterThanOrEqual(3);
    expect((within(nav).getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);

    // End key jumps to the final page; focus must land on the now-current page
    // button rather than being stranded, and Next must disable at the bound.
    await user.click(within(nav).getByRole('button', { name: 'Page 1' }));
    await user.keyboard('{End}');

    const lastButton = within(nav).getByRole('button', { name: `Page ${lastPage}` });
    await waitFor(() => expect(lastButton.getAttribute('aria-current')).toBe('page'));
    expect(document.activeElement).toBe(lastButton);
    expect((within(nav).getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect(tableRowCount()).toBe(manyModels.length - CATALOG_PAGE_SIZE * (lastPage - 1));

    // Home key returns to the first page and moves focus with it.
    await user.keyboard('{Home}');
    const firstButton = within(nav).getByRole('button', { name: 'Page 1' });
    await waitFor(() => expect(firstButton.getAttribute('aria-current')).toBe('page'));
    expect(document.activeElement).toBe(firstButton);
    expect((within(nav).getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);

    // A Next click advances one page and carries focus to that page's control.
    await user.click(within(nav).getByRole('button', { name: 'Next' }));
    const secondButton = within(nav).getByRole('button', { name: 'Page 2' });
    await waitFor(() => expect(secondButton.getAttribute('aria-current')).toBe('page'));
    expect(document.activeElement).toBe(secondButton);
  });
});
