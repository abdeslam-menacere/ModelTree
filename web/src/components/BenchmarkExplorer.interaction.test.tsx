// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATLAS_MINI,
  ATLAS_PRO,
  BOREALIS_AIR,
  COMPARABLE_BENCHMARK,
  COMPARISON_BASE,
  benchmarkExplorerFixtures,
} from '../../tests/fixtures/comparison-dataset';
import BenchmarkExplorer from './BenchmarkExplorer';
import { NO_FILTERS } from '../lib/benchmark-explorer';

const ROUTE = '/ModelTree/benchmarks/';

function renderExplorer() {
  return render(
    <BenchmarkExplorer
      dataset={benchmarkExplorerFixtures}
      initialSlugs={[]}
      initialFilters={NO_FILTERS}
      base={COMPARISON_BASE}
    />,
  );
}

function at(search: string) {
  window.history.replaceState({}, '', `${ROUTE}${search}`);
}

function groupHeadings() {
  return Array.from(document.querySelectorAll('.evidence-group-head h3')).map(
    (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

function selectedModels() {
  return new URLSearchParams(window.location.search).get('models');
}

beforeEach(() => {
  at('');
});

afterEach(() => {
  cleanup();
});

describe('the selection comes from the address', () => {
  it('preselects the models a shared evidence link names', async () => {
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderExplorer();

    await waitFor(() =>
      expect(screen.getByText(/Showing evidence for Atlas Pro, Borealis Air/)).toBeTruthy(),
    );
    // Positive control: a real evidence link must render at least one group,
    // never a silently empty view.
    expect(groupHeadings().length).toBeGreaterThan(0);
  });

  it('groups two models measured the same way as comparable', async () => {
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderExplorer();

    // Atlas Bench agrees on every blocking dimension, so both releases share one
    // cross-model group under the Comparable evidence heading.
    await waitFor(() => expect(screen.getByText('Comparable evidence')).toBeTruthy());
    const comparable = screen
      .getByRole('heading', { name: 'Comparable evidence' })
      .closest('section') as HTMLElement;
    expect(within(comparable).getByRole('heading', { name: /Atlas Bench/ })).toBeTruthy();
    const rows = comparable.querySelectorAll('tbody tr[data-result]');
    expect(rows.length).toBe(2);
  });

  it('keeps an incompatible benchmark out of the comparable section and explains why', async () => {
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderExplorer();

    await waitFor(() => expect(groupHeadings().length).toBeGreaterThan(0));

    // Strict Bench disagrees on harness, a blocking dimension, so it never joins
    // the comparable section; it appears under Direct evidence instead.
    const comparable = screen
      .getByRole('heading', { name: 'Comparable evidence' })
      .closest('section') as HTMLElement;
    expect(within(comparable).queryByRole('heading', { name: /Strict Bench/ })).toBeNull();

    const direct = screen
      .getByRole('heading', { name: 'Direct evidence' })
      .closest('section') as HTMLElement;
    // A blocking harness difference splits Strict Bench into one single-model
    // group per harness, so it appears here rather than as one shared table.
    expect(within(direct).getAllByRole('heading', { name: /Strict Bench/ }).length).toBe(2);
  });
});

describe('a model with no recorded evidence', () => {
  it('says the gap is coverage, not a score of zero', async () => {
    at(`?models=${ATLAS_MINI}`);
    renderExplorer();

    await waitFor(() =>
      expect(screen.getByText(/No benchmark evidence recorded yet/)).toBeTruthy(),
    );
    expect(screen.getByText(/not a score of zero/)).toBeTruthy();
    // A valid next action: open the passport that still holds what is known.
    expect(
      screen.getByRole('link', { name: /Open Atlas Mini's passport/ }),
    ).toBeTruthy();
  });
});

describe('adding and removing a model', () => {
  it('adds the model the picker link names, appending to the address', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO}`);
    renderExplorer();
    await waitFor(() => expect(selectedModels()).toBe(ATLAS_PRO));

    await user.click(
      screen.getByRole('link', { name: /^Add Borealis Air to the evidence view$/ }),
    );

    await waitFor(() => expect(selectedModels()).toBe(`${ATLAS_PRO},${BOREALIS_AIR}`));
  });

  it('works from the keyboard alone', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO}`);
    renderExplorer();
    await waitFor(() => expect(selectedModels()).toBe(ATLAS_PRO));

    const add = screen.getByRole('link', { name: /^Add Borealis Air to the evidence view$/ });
    add.focus();
    expect(document.activeElement).toBe(add);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(selectedModels()).toBe(`${ATLAS_PRO},${BOREALIS_AIR}`));
  });
});

describe('filtering the evidence', () => {
  it('narrows to one benchmark and keeps the selection', async () => {
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderExplorer();
    await waitFor(() => expect(groupHeadings().length).toBeGreaterThan(1));

    const filters = screen
      .getByRole('heading', { name: 'Filter evidence' })
      .closest('section') as HTMLElement;
    await user.click(within(filters).getByRole('link', { name: /^Atlas Bench/ }));

    await waitFor(() => {
      const headings = groupHeadings();
      expect(headings.length).toBe(1);
      expect(headings[0]).toContain('Atlas Bench');
    });
    // The filter travels in the address without dropping the models.
    const params = new URLSearchParams(window.location.search);
    expect(params.get('benchmark')).toBe(COMPARABLE_BENCHMARK);
    expect(params.get('models')).toBe(`${ATLAS_PRO},${BOREALIS_AIR}`);
  });

  it('exposes an applied facet with aria-current, and never aria-pressed on a link', async () => {
    // Regression guard for issue #32. Candidate and facet toggles are anchors
    // (progressive-enhancement links), and `aria-pressed` is not a valid ARIA
    // attribute on role="link" -- axe rates it a critical `aria-allowed-attr`
    // violation. Selected candidates carry their state in the accessible name
    // ("Add"/"Remove"); applied facets carry it in `aria-current`, the idiom
    // this codebase already uses for a current item on a link.
    const user = userEvent.setup();
    at(`?models=${ATLAS_PRO},${BOREALIS_AIR}`);
    renderExplorer();
    await waitFor(() => expect(groupHeadings().length).toBeGreaterThan(1));

    const filters = screen
      .getByRole('heading', { name: 'Filter evidence' })
      .closest('section') as HTMLElement;

    // Positive control: both link kinds are actually on the page, so the
    // no-aria-pressed assertion below is not vacuous.
    expect(document.querySelectorAll('a.evidence-candidate').length).toBeGreaterThan(0);
    expect(within(filters).getAllByRole('link').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('a[aria-pressed]')).toHaveLength(0);

    const facet = within(filters).getByRole('link', { name: /^Atlas Bench/ });
    expect(facet.getAttribute('aria-current')).toBeNull();
    await user.click(facet);

    await waitFor(() => {
      const applied = within(filters).getByRole('link', { name: /^Atlas Bench/ });
      expect(applied.getAttribute('aria-current')).toBe('true');
    });
    expect(document.querySelectorAll('a[aria-pressed]')).toHaveLength(0);
  });
});

describe('links this page did not invent', () => {
  it('offers every candidate as a followable URL before any script runs', () => {
    renderExplorer();
    const links = Array.from(document.querySelectorAll('a.evidence-candidate'));

    // Positive control: an empty candidate list would pass every per-link
    // assertion below vacuously.
    expect(links.length).toBe(benchmarkExplorerFixtures.releases.length);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toContain('/ModelTree/benchmarks/');
      expect(link.getAttribute('aria-label')).toMatch(/^(Add|Remove) /);
    }
  });

  it('names an address\u2019s unknown model instead of ignoring it', async () => {
    at(`?models=${ATLAS_PRO},no-such-model`);
    renderExplorer();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no-such-model');
    // The known model still renders its evidence.
    await waitFor(() => expect(groupHeadings().length).toBeGreaterThan(0));
  });

  it('does not crash on a duplicated slug, keeping one selection', async () => {
    at(`?models=${ATLAS_PRO},${ATLAS_PRO}`);
    renderExplorer();

    await waitFor(() =>
      expect(screen.getByText(/Showing evidence for Atlas Pro\./)).toBeTruthy(),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(ATLAS_PRO);
    expect(alert.textContent).toMatch(/listed more than once/);
  });
});
