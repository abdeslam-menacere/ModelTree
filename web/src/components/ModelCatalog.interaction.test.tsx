// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildCatalogIndex } from '../lib/catalog';
import { CATALOG_PAGE_SIZE } from '../lib/catalog-view';
import ModelCatalog from './ModelCatalog';

const index = buildCatalogIndex(dataset, '/');
const total = index.models.length;
const firstCreator = index.facets.creators[0];

function renderCatalog() {
  return render(<ModelCatalog models={index.models} facets={index.facets} />);
}

function tableRowCount() {
  return document.querySelectorAll('.catalog-table tbody tr').length;
}

function creatorCheckbox(name: string) {
  return screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/models/');
});

afterEach(() => {
  cleanup();
});

describe('ModelCatalog', () => {
  it('lists the first page and links every result to its passport route', async () => {
    renderCatalog();
    await waitFor(() => expect(document.querySelector('.model-catalog')?.getAttribute('data-enhanced')).toBe('true'));

    expect(tableRowCount()).toBe(Math.min(CATALOG_PAGE_SIZE, total));

    const firstRow = index.models[0];
    const link = screen.getByRole('link', { name: firstRow.name });
    expect(link.getAttribute('href')).toBe(firstRow.route);

    expect(screen.getByRole('status').textContent).toContain(String(total));
  });

  it('announces the result count through a polite live region', async () => {
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('filters by a creator facet and matches its recorded count', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));

    await user.click(creatorCheckbox(firstCreator.label));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(String(firstCreator.count)));
    expect(window.location.search).toContain(`creator=${firstCreator.value}`);
  });

  it('restores filter, sort, view, and page from the URL', async () => {
    window.history.replaceState({}, '', `/models/?creator=${firstCreator.value}&sort=name&view=list`);
    renderCatalog();

    await waitFor(() => expect(creatorCheckbox(firstCreator.label).getAttribute('aria-checked') ?? (creatorCheckbox(firstCreator.label) as HTMLInputElement).checked).toBeTruthy());
    expect((creatorCheckbox(firstCreator.label) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('name');
    // List view renders an un-nested list rather than the table.
    expect(document.querySelector('.catalog-list')).not.toBeNull();
    expect(document.querySelector('.catalog-table')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(String(firstCreator.count));
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

  it('offers per-filter and clear-all actions from the no-result state', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));

    await user.type(screen.getByLabelText('Search models'), 'zzzznomatchzzzz');

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No models match'));
    expect(tableRowCount()).toBe(0);

    await user.click(screen.getByRole('button', { name: /clear all filters/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(String(total)));
  });

  it('paginates with the keyboard, keeps focus, and stays bounded', async () => {
    if (total <= CATALOG_PAGE_SIZE) return;
    const user = userEvent.setup();
    renderCatalog();
    await waitFor(() => screen.getByRole('status'));

    const nav = screen.getByRole('navigation', { name: 'Catalog pages' });
      const lastPage = Math.ceil(total / CATALOG_PAGE_SIZE);
      expect((within(nav).getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);

      // Clicking Next onto the final page disables Next, so focus must move to the
      // now-current page button rather than being stranded on a disabled control.
      await user.click(within(nav).getByRole('button', { name: 'Next' }));

      const lastButton = within(nav).getByRole('button', { name: `Page ${lastPage}` });
      await waitFor(() => expect(lastButton.getAttribute('aria-current')).toBe('page'));
      expect(document.activeElement).toBe(lastButton);
      expect((within(nav).getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
      expect(tableRowCount()).toBe(total - CATALOG_PAGE_SIZE * (lastPage - 1));

      // Home key returns to the first page and moves focus with it.
      nav.focus();
      await user.keyboard('{Home}');
      const firstButton = within(nav).getByRole('button', { name: 'Page 1' });
      await waitFor(() => expect(firstButton.getAttribute('aria-current')).toBe('page'));
      expect(document.activeElement).toBe(firstButton);
      expect((within(nav).getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
