// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATLAS_EXTRA,
  ATLAS_MINI,
  ATLAS_OPEN,
  ATLAS_PRO,
  BOREALIS_AIR,
  COMPARISON_BASE,
  COMPARISON_TODAY,
  comparisonFixtures,
} from '../../tests/fixtures/comparison-dataset';
import { compactComparisonPayload, MAX_COMPARISON_MODELS } from '../lib/comparison';
import ModelComparison from './ModelComparison';

const ROUTE = '/ModelTree/compare/';

function renderComparison() {
  return render(
    <ModelComparison
      dataset={compactComparisonPayload(comparisonFixtures)}
      initialSlugs={[]}
      base={COMPARISON_BASE}
      today={COMPARISON_TODAY}
    />,
  );
}

function at(search: string) {
  window.history.replaceState({}, '', `${ROUTE}${search}`);
}

function columnHeaders() {
  const table = document.querySelector('.comparison-table');
  if (!table) return [];
  return Array.from(table.querySelectorAll('thead th'))
    .map((node) => node.textContent?.trim() ?? '')
    .filter((name) => name !== 'Attribute');
}

function selectedSlugs() {
  return new URLSearchParams(window.location.search).get('models');
}

beforeEach(() => {
  at('');
});

afterEach(() => {
  cleanup();
});

describe('the selection comes from the address', () => {
  it('renders the comparison a shared link asked for', async () => {
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();

    await waitFor(() => expect(columnHeaders()).toEqual(['Atlas Pro', 'Borealis Air']));
    expect(screen.getByText(/Comparing 2 models/)).toBeTruthy();
  });

  it('honours the order the link gave, rather than a sorted one', async () => {
    at(`?models=${BOREALIS_AIR},${ATLAS_PRO}`);
    renderComparison();

    await waitFor(() => expect(columnHeaders()).toEqual(['Borealis Air', 'Atlas Pro']));
  });

  it('follows a Back navigation to the previous selection', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    await user.click(screen.getByRole('link', { name: /^Add Atlas Mini to the comparison$/ }));
    await waitFor(() => expect(columnHeaders()).toHaveLength(3));

    // pushState put the two-model view in history, so Back must restore it.
    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(columnHeaders()).toEqual(['Atlas Pro', 'Borealis Air']));
  });
});

describe('adding and removing a model', () => {
  it('adds at the end, so the column order stays the reader\u2019s own', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    await user.click(screen.getByRole('link', { name: /^Add Atlas Mini to the comparison$/ }));

    await waitFor(() => expect(columnHeaders()).toEqual(['Atlas Pro', 'Borealis Air', 'Atlas Mini']));
    expect(selectedSlugs()).toBe(`${ATLAS_PRO},${BOREALIS_AIR},${ATLAS_MINI}`);
  });

  it('removes the model the control names, not the last one', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR},${ATLAS_MINI}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(3));

    // Scoped to the column cards: the picker offers a link with the same
    // accessible name and the same destination, which is correct because it is
    // the same action, but it makes an unscoped query ambiguous.
    const cards = document.querySelector('.comparison-column-cards') as HTMLElement;
    await user.click(
      within(cards).getByRole('link', { name: /^Remove Borealis Air from the comparison$/ }),
    );

    await waitFor(() => expect(columnHeaders()).toEqual(['Atlas Pro', 'Atlas Mini']));
    expect(selectedSlugs()).toBe(`${ATLAS_PRO},${ATLAS_MINI}`);
  });

  it('works from the keyboard alone', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    const add = screen.getByRole('link', { name: /^Add Atlas Mini to the comparison$/ });
    add.focus();
    expect(document.activeElement).toBe(add);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(columnHeaders()).toHaveLength(3));
  });

  it('moves focus to the status line, so the change is announced', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    await user.click(screen.getByRole('link', { name: /^Add Atlas Mini to the comparison$/ }));

    await waitFor(() => {
      expect((document.activeElement as HTMLElement)?.className).toContain('comparison-status');
    });
    expect(document.activeElement?.textContent).toContain('Atlas Mini');
  });

  it('drops the table back to the picker when a selection falls below two', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    const picker = document.querySelector('.comparison-candidates') as HTMLElement;
    await user.click(
      within(picker).getByRole('link', { name: /^Remove Borealis Air from the comparison$/ }),
    );

    await waitFor(() => expect(document.querySelector('.comparison-table')).toBeNull());
    expect(screen.getByText(/Choose 1 more to compare/)).toBeTruthy();
  });
});

describe('the four-model limit', () => {
  it('refuses a fifth from an address, naming what it dropped', async () => {
    at(
      `?models=${ATLAS_PRO},${BOREALIS_AIR},${ATLAS_MINI},${ATLAS_OPEN},${ATLAS_EXTRA}`,
    );
    renderComparison();

    await waitFor(() => expect(columnHeaders()).toHaveLength(MAX_COMPARISON_MODELS));
    const alert = await screen.findByRole('alert');
    // The slug, not the display name: the resolver rejects before it has looked
    // a release up, and a slug is what the address holds, so naming it is what
    // lets a reader find the entry they need to edit out.
    expect(alert.textContent).toContain(ATLAS_EXTRA);
    expect(alert.querySelector('[data-code="over-capacity"]')).toBeTruthy();
  });

  it('names an address\u2019s unknown model instead of ignoring it', async () => {
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR},no-such-model`);
    renderComparison();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no-such-model');
    expect(columnHeaders()).toHaveLength(2);
  });
});

describe('links this page did not invent', () => {
  it('keeps an evidence deep link\u2019s other parameters through an edit', async () => {
    const user = userEvent.setup();
    // `domain` and `benchmark` belong to the evidence route, which this page
    // gives no meaning to. Losing them on the first click would break an inbound
    // link that arrived carrying them.
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}&domain=coding&benchmark=atlas-bench`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    await user.click(screen.getByRole('link', { name: /^Add Atlas Mini to the comparison$/ }));

    await waitFor(() => expect(columnHeaders()).toHaveLength(3));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('domain')).toBe('coding');
    expect(params.get('benchmark')).toBe('atlas-bench');
    expect(params.get('models')).toBe(`${ATLAS_PRO},${BOREALIS_AIR},${ATLAS_MINI}`);
  });

  it('offers every candidate as a followable URL before any script runs', () => {
    renderComparison();
    const links = Array.from(document.querySelectorAll('a.comparison-candidate'));

    expect(links).toHaveLength(comparisonFixtures.releases.length);
    for (const link of links) {
      expect(link.getAttribute('href')).toContain('/ModelTree/compare/');
      expect(link.getAttribute('aria-label')).toMatch(/^(Add|Remove) /);
    }
  });

  it('marks a candidate through its accessible name, never aria-pressed on a link', async () => {
    // Regression guard for issue #32: `aria-pressed` is invalid on role="link"
    // (axe critical `aria-allowed-attr`). The candidate is a progressive-
    // enhancement anchor, so its selected state rides the accessible name
    // ("Add" before, "Remove" after) rather than an attribute links cannot carry.
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    expect(document.querySelectorAll('a.comparison-candidate').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('a[aria-pressed]')).toHaveLength(0);

    const picker = document.querySelector('.comparison-candidates') as HTMLElement;
    const add = within(picker).getByRole('link', { name: /^Add Atlas Mini to the comparison$/ });
    await user.click(add);

    await waitFor(() =>
      expect(
        within(document.querySelector('.comparison-candidates') as HTMLElement).getByRole('link', {
          name: /^Remove Atlas Mini from the comparison$/,
        }),
      ).toBeTruthy(),
    );
    expect(document.querySelectorAll('a[aria-pressed]')).toHaveLength(0);
  });
});

describe('filtering the picker', () => {
  it('narrows the list without touching the selection', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderComparison();
    await waitFor(() => expect(columnHeaders()).toHaveLength(2));

    await user.type(screen.getByRole('searchbox', { name: /Filter models/ }), 'Borealis');

    await waitFor(() =>
      expect(document.querySelectorAll('a.comparison-candidate')).toHaveLength(1),
    );
    expect(columnHeaders()).toHaveLength(2);
    expect(selectedSlugs()).toBe(`${ATLAS_PRO},${BOREALIS_AIR}`);
  });

  it('says so when nothing matches, rather than showing an empty list', async () => {
    const user = userEvent.setup();
    renderComparison();

    await user.type(screen.getByRole('searchbox', { name: /Filter models/ }), 'zzqx');

    await waitFor(() => expect(screen.getByText(/No model matches/)).toBeTruthy());
  });
});
