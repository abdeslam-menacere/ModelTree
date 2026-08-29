// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TimelineEntry, TimelineFacets } from '../lib/timeline';
import Timeline from './Timeline';

/**
 * Dates are built relative to the machine's clock rather than pinned, because
 * the relative range presets anchor to the reader's clock by design. A fixed
 * date would make "last 12 months" mean something different every day the suite
 * runs; deriving the fixture from the same clock the component reads keeps the
 * assertions true whenever it runs.
 */
function shiftMonths(months: number): string {
  const today = new Date();
  const shifted = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth() + months,
    15,
  ));
  return shifted.toISOString().slice(0, 10);
}

const RECENT = shiftMonths(-2);
const OLD = shiftMonths(-30);
const FUTURE = shiftMonths(2);
const OLD_YEAR = OLD.slice(0, 4);

function entry(
  id: string,
  date: string,
  overrides: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    id,
    kind: 'release',
    date,
    datePrecision: 'day',
    dateLabel: date,
    kindLabel: 'Released',
    modelName: id,
    modelSlug: id,
    route: `/models/${id}/`,
    creatorSlug: 'alpha',
    creatorName: 'Alpha Labs',
    categories: ['language-reasoning'],
    accessType: 'proprietary-hosted',
    accessTypeLabel: 'Hosted API',
    ...overrides,
  };
}

const entries: TimelineEntry[] = [
  entry('old-model', OLD),
  entry('recent-model', RECENT, {
    creatorSlug: 'beta',
    creatorName: 'Beta Corp',
    categories: ['image'],
    accessType: 'open-weight',
    accessTypeLabel: 'Open-weight',
  }),
  entry('recent-event', RECENT, {
    id: 'recent-event',
    kind: 'event',
    kindLabel: 'Generally available',
    modelName: 'recent-model',
    modelSlug: 'recent-model',
    route: '/models/recent-model/',
    creatorSlug: 'beta',
    creatorName: 'Beta Corp',
    categories: ['image'],
    accessType: 'open-weight',
    accessTypeLabel: 'Open-weight',
  }),
  entry('undated-event', OLD_YEAR, {
    kind: 'event',
    datePrecision: 'year',
    dateLabel: OLD_YEAR,
    kindLabel: 'Deprecated',
  }),
  entry('future-model', FUTURE),
];

const facets: TimelineFacets = {
  creators: [
    { value: 'alpha', label: 'Alpha Labs', count: 3 },
    { value: 'beta', label: 'Beta Corp', count: 2 },
  ],
  categories: [
    { value: 'image', label: 'Image', count: 2 },
    { value: 'language-reasoning', label: 'Language and reasoning', count: 3 },
  ],
  accessTypes: [
    { value: 'open-weight', label: 'Open-weight', count: 2 },
    { value: 'proprietary-hosted', label: 'Hosted API', count: 3 },
  ],
};

const years = [...new Set(entries.map((item) => item.date.slice(0, 4)))].sort().reverse();

function renderTimeline() {
  return render(<Timeline entries={entries} facets={facets} years={years} />);
}

async function hydrated() {
  await waitFor(() => {
    expect(document.querySelector('.model-timeline')?.getAttribute('data-enhanced')).toBe('true');
  });
}

function renderedNames() {
  return Array.from(document.querySelectorAll('.timeline-entry'))
    .map((node) => node.querySelector('.timeline-entry-name')?.textContent);
}

/** An event row carries its model's name, so the kind label is what tells them apart. */
function renderedKinds() {
  return Array.from(document.querySelectorAll('.timeline-entry'))
    .map((node) => node.querySelector('.timeline-entry-kind')?.textContent);
}

function stopLabels() {
  return Array.from(document.querySelectorAll('.timeline-stop-label')).map((node) => node.textContent);
}

beforeEach(() => {
  window.history.replaceState({}, '', '/timeline/');
});

afterEach(() => {
  cleanup();
});

describe('Timeline', () => {
  it('renders one stop per year at the default scale, newest first', async () => {
    renderTimeline();
    await hydrated();

    expect(stopLabels()).toEqual([...years]);
    expect(renderedNames()[0]).toBe('future-model');
    expect(document.querySelectorAll('.timeline-entry')).toHaveLength(entries.length);
  });

  it('links every entry to its Model Passport', async () => {
    renderTimeline();
    await hydrated();

    const links = Array.from(document.querySelectorAll('.timeline-entry a.timeline-entry-name'));
    expect(links).toHaveLength(entries.length);
    for (const link of links) {
      const match = entries.find((item) => item.modelName === link.textContent);
      expect(link.getAttribute('href')).toBe(match?.route);
    }
  });

  it('marks up every date as a machine-readable time, no more precise than its source', async () => {
    renderTimeline();
    await hydrated();

    const times = Array.from(document.querySelectorAll('.timeline-entry time'));
    expect(times).toHaveLength(entries.length);
    expect(times.map((node) => node.getAttribute('datetime')).sort())
      .toEqual(entries.map((item) => item.date).sort());

    // The attribute is machine-readable, so a segment it carries is a claim.
    // It must never state more than the entry's own precision does.
    const segments = { year: 1, month: 2, day: 3 };
    for (const item of entries) {
      const node = times.find((candidate) => candidate.getAttribute('datetime') === item.date);
      expect(node?.getAttribute('datetime')?.split('-')).toHaveLength(segments[item.datePrecision]);
    }

    const undated = times.find((node) => node.getAttribute('datetime') === OLD_YEAR);
    expect(undated?.textContent).toBe(OLD_YEAR);
  });

  it('names the creator and the kind of entry in text, not by colour alone', async () => {
    renderTimeline();
    await hydrated();

    const row = Array.from(document.querySelectorAll('.timeline-entry'))
      .find((node) => node.querySelector('.timeline-entry-name')?.textContent === 'recent-model')!;
    expect(row.querySelector('.timeline-entry-creator')?.textContent).toBe('Beta Corp');
    expect(row.querySelector('.timeline-entry-kind')?.textContent).toBe('Released');

    const eventRow = Array.from(document.querySelectorAll('.timeline-entry'))
      .find((node) => node.getAttribute('data-kind') === 'event')!;
    expect(eventRow.querySelector('.timeline-entry-kind')?.textContent?.length).toBeGreaterThan(0);
  });

  it('announces the entry count through a polite live region', async () => {
    renderTimeline();
    await hydrated();

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain(`${entries.length} entries`);
  });

  it('uses ordered lists for the rail and for the entries under each stop', async () => {
    renderTimeline();
    await hydrated();

    expect(document.querySelector('ol.timeline-rail')).not.toBeNull();
    const stops = document.querySelectorAll('.timeline-stop');
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of Array.from(stops)) {
      expect(stop.querySelector('ol.timeline-entries')).not.toBeNull();
      expect(stop.querySelector('h2.timeline-stop-label')).not.toBeNull();
    }
  });

  it('regroups on a scale change without dropping an entry, labelling the undated stop', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await hydrated();

    await user.selectOptions(screen.getByLabelText('Scale'), 'month');
    await waitFor(() => expect(window.location.search).toBe('?scale=month'));

    expect(document.querySelectorAll('.timeline-entry')).toHaveLength(entries.length);

    const undatedStop = document.querySelector('.timeline-stop[data-imprecise="true"]');
    expect(undatedStop).not.toBeNull();
    expect(undatedStop?.querySelector('.timeline-stop-label')?.textContent)
      .toBe(`${OLD_YEAR} · month not given`);
    expect(undatedStop?.querySelector('.timeline-stop-note')?.textContent)
      .toContain('is not given');
  });

  it('reverses the stream on an order change', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await hydrated();

    const newestFirst = renderedNames();
    await user.selectOptions(screen.getByLabelText('Order'), 'oldest');
    await waitFor(() => expect(window.location.search).toBe('?order=oldest'));

    expect(renderedNames()).toEqual([...newestFirst].reverse());
  });

  it('applies a relative range only after hydration, and never cuts off the newest entries', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await hydrated();

    await user.selectOptions(screen.getByLabelText('Range'), '12m');
    await waitFor(() => expect(window.location.search).toBe('?range=12m'));

    const shown = renderedNames();
    expect(shown).toContain('future-model');
    expect(shown).toContain('recent-model');
    expect(shown).not.toContain('old-model');
    expect(screen.getByRole('status').textContent).toContain('Last 12 months');
  });

  it('filters by creator and writes the catalog’s own param into the URL', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await hydrated();

    await user.click(screen.getByRole('checkbox', { name: /^Beta Corp/ }));
    await waitFor(() => expect(window.location.search).toBe('?creator=beta'));

    expect(renderedNames()).toEqual(['recent-model', 'recent-model']);
    expect(renderedKinds()).toEqual(['Released', 'Generally available']);
    expect(screen.getByRole('status').textContent).toContain('2 entries');
  });

  it('removes a filter through its chip and cleans the URL back to the default', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await hydrated();

    await user.click(screen.getByRole('checkbox', { name: /^Beta Corp/ }));
    await waitFor(() => expect(window.location.search).toBe('?creator=beta'));

    const chips = screen.getByRole('list', { name: 'Active filters' });
    await user.click(within(chips).getByRole('button', { name: /Creator: Beta Corp/ }));

    await waitFor(() => expect(window.location.search).toBe(''));
    expect(document.querySelectorAll('.timeline-entry')).toHaveLength(entries.length);
  });

  it('restores a shared view from the URL, dropping a value the facets do not know', async () => {
    window.history.replaceState({}, '', '/timeline/?creator=beta&creator=ghost&scale=quarter&order=oldest');
    renderTimeline();
    await hydrated();

    expect((screen.getByLabelText('Scale') as HTMLSelectElement).value).toBe('quarter');
    expect((screen.getByLabelText('Order') as HTMLSelectElement).value).toBe('oldest');
    expect((screen.getByRole('checkbox', { name: /^Beta Corp/ }) as HTMLInputElement).checked)
      .toBe(true);
    expect(renderedNames()).toEqual(['recent-model', 'recent-model']);
    expect(renderedKinds()).toEqual(['Generally available', 'Released']);
  });

  it('restores the view again when the reader navigates back', async () => {
    renderTimeline();
    await hydrated();

    // Driven by history alone, never by the controls: the island writes its
    // state with replaceState, like every other island here, so an in-page
    // control leaves nothing to navigate back to. Only an entry pushed from
    // outside — a link, or the reader's own history — reaches this path.
    window.history.pushState({}, '', '/timeline/?creator=beta');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(renderedNames()).toHaveLength(2));
    expect((screen.getByRole('checkbox', { name: /^Beta Corp/ }) as HTMLInputElement).checked)
      .toBe(true);

    window.history.back();
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(renderedNames()).toHaveLength(entries.length));
    expect((screen.getByRole('checkbox', { name: /^Beta Corp/ }) as HTMLInputElement).checked)
      .toBe(false);
  });

  it('offers a way out of an empty result, per filter and all at once', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await hydrated();

    await user.click(screen.getByRole('checkbox', { name: /^Beta Corp/ }));
    await user.click(screen.getByRole('checkbox', { name: /^Language and reasoning/ }));

    await waitFor(() => expect(document.querySelector('.timeline-empty')).not.toBeNull());
    expect(screen.getByRole('status').textContent).toContain('No entries match');

    const actions = document.querySelector('.timeline-empty-actions')!;
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Clear Creator: Beta Corp' }))
      .toBeDefined();

    await user.click(within(actions as HTMLElement).getByRole('button', { name: 'Clear all filters' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(document.querySelectorAll('.timeline-entry')).toHaveLength(entries.length);
  });

  it('disables Clear all while nothing is filtered', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await hydrated();

    const clearAll = screen.getByRole('button', { name: 'Clear all' });
    expect((clearAll as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /^Beta Corp/ }));
    await waitFor(() => expect((clearAll as HTMLButtonElement).disabled).toBe(false));
  });
});
