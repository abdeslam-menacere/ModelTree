// @vitest-environment jsdom

import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import { buildUpdateIndex } from '../lib/updates';
import ReleaseUpdates from './ReleaseUpdates';

const BASE = '/ModelTree';
const index = buildUpdateIndex(seedDataset, `${BASE}/`);
const { records, facets } = index;

const ALIBABA = 'alibaba-cloud';
const MICROSOFT = 'microsoft';

function renderUpdates() {
  return render(<ReleaseUpdates records={records} facets={facets} />);
}

function visibleEventIds(): string[] {
  return [...document.querySelectorAll('.updates-item')]
    .map((node) => node.id.replace(/^event-/, ''));
}

function creatorCheckbox(label: string) {
  return filterCheckbox('Creator', label);
}

function categoryCheckbox(label: string) {
  return filterCheckbox('Category', label);
}

function filterCheckbox(dimension: string, label: string) {
  const group = [...document.querySelectorAll('.updates-filter-group')]
    .find((node) => node.querySelector('legend')?.textContent === dimension) as HTMLElement;
  return within(group).getByRole('checkbox', { name: new RegExp(label, 'i') });
}

function countText(): string {
  return document.querySelector('.updates-count')?.textContent ?? '';
}

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE}/updates/`);
});

afterEach(() => {
  cleanup();
});

describe('the ledger a reader gets before any interaction', () => {
  it('renders every recorded change, so a no-JS reader loses nothing', () => {
    renderUpdates();

    expect(visibleEventIds()).toEqual(records.map((record) => record.id));
    expect(records.length).toBeGreaterThan(1);
  });

  it('puts every permalink target in the markup, not behind hydration', () => {
    renderUpdates();

    for (const record of records) {
      expect(document.getElementById(record.anchorId), `anchor for ${record.id}`).not.toBeNull();
    }
  });

  it('orders newest first, by the date the sources stated', () => {
    renderUpdates();

    const dates = [...document.querySelectorAll('.updates-item-date')]
      .map((node) => node.getAttribute('datetime'));

    expect(dates).toEqual(records.map((record) => record.date));
    expect(dates[0]! >= dates[dates.length - 1]!).toBe(true);
  });

  it('groups into year and month headings a screen reader can walk', () => {
    renderUpdates();

    const years = [...document.querySelectorAll('.updates-year-label')].map((n) => n.textContent);
    const months = [...document.querySelectorAll('.updates-month-label')].map((n) => n.textContent);

    expect(years).toEqual(['2026', '2025']);
    expect(months[0]).toBe('August 2026');
    expect(new Set(months).size).toBe(months.length);
  });

  it('reports the count in a live region', () => {
    renderUpdates();

    const count = document.querySelector('.updates-count')!;

    expect(count.getAttribute('role')).toBe('status');
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(count.textContent).toBe(`${records.length} recorded changes`);
  });
});

describe('every entry carries the evidence that makes it checkable', () => {
  it('states what changed, in the source\'s own words', () => {
    renderUpdates();

    const notes = [...document.querySelectorAll('.updates-item-note')].map((n) => n.textContent);

    for (const record of records) {
      expect(notes).toContain(record.note);
    }
  });

  it('names the kind of change in words, never by colour alone', () => {
    renderUpdates();

    const types = [...document.querySelectorAll('.updates-item-type')].map((n) => n.textContent);

    expect(types).toEqual(records.map((record) => record.typeLabel));
    for (const type of types) {
      expect(type?.trim()).not.toBe('');
    }
  });

  it('links every entry to at least one primary source', () => {
    renderUpdates();

    for (const item of document.querySelectorAll('.updates-item')) {
      const links = item.querySelectorAll('.updates-item-evidence a');

      expect(links.length, `sources for ${item.id}`).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.getAttribute('href')).toMatch(/^https?:\/\//);
      }
    }
  });

  it('marks both dates up as machine-readable times', () => {
    renderUpdates();

    for (const time of document.querySelectorAll('time')) {
      expect(time.getAttribute('datetime')).toMatch(/^\d{4}(-\d{2}){0,2}$/);
    }

    // Two per entry: the source's date and the day we last re-checked it.
    expect(document.querySelectorAll('time').length).toBe(records.length * 2);
  });

  it('says the verification date is a check, not the date of the change', () => {
    renderUpdates();

    const hints = [...document.querySelectorAll('.updates-item-hint')].map((n) => n.textContent);

    expect(hints).toHaveLength(records.length);
    for (const hint of hints) {
      expect(hint).toMatch(/not when the change happened/);
    }
  });

  it('links each entry to the model it affects', () => {
    renderUpdates();

    const links = [...document.querySelectorAll('.updates-item-model a')]
      .map((node) => node.getAttribute('href'));

    expect(links).toEqual(records.map((record) => record.modelRoute));
    for (const link of links) {
      expect(link).toMatch(new RegExp(`^${BASE}/models/`));
    }
  });

  it('attributes a change to the model\'s creator, not to the announcing platform', () => {
    // The seed records Amazon announcing an Alibaba model on SageMaker. The
    // model's creator is Alibaba Cloud, and the entry must keep saying so.
    renderUpdates();

    const item = document.getElementById('event-qwen3-8-27b-on-sagemaker-jumpstart');

    expect(item, 'the cross-creator record is still in the seed').not.toBeNull();
    expect(item!.querySelector('.updates-item-creator')?.textContent).toBe('Alibaba Cloud');
    expect(item!.querySelector('.updates-item-evidence a')?.getAttribute('href'))
      .toMatch(/amazon/i);
  });

  it('offers a permalink that names the update it points at', () => {
    renderUpdates();

    const permalinks = [...document.querySelectorAll('.updates-item-permalink a')];

    expect(permalinks).toHaveLength(records.length);
    for (const [position, link] of permalinks.entries()) {
      expect(link.getAttribute('href')).toBe(`#${records[position].anchorId}`);
      expect(link.textContent).toContain(records[position].modelName);
    }
  });

  it('counts the kinds of change present without offering them as a filter', () => {
    // Deliberate: a type filter could hide a deprecation from a reader who did
    // not think to ask for one.
    renderUpdates();

    const legend = document.querySelector('.updates-legend')!;
    const terms = [...legend.querySelectorAll('dt')].map((node) => node.textContent);

    expect(terms.sort()).toEqual(facets.types.map((type) => type.label).sort());
    expect(within(legend as HTMLElement).queryByRole('checkbox')).toBeNull();
  });
});

describe('filtering narrows the ledger and the URL follows', () => {
  it('keeps only the selected creator', async () => {
    const user = userEvent.setup();
    renderUpdates();

    await user.click(creatorCheckbox('Alibaba Cloud'));

    await waitFor(() => {
      expect(visibleEventIds())
        .toEqual(records.filter((r) => r.creatorSlug === ALIBABA).map((r) => r.id));
    });
  });

  it('writes the selection into the query string', async () => {
    const user = userEvent.setup();
    renderUpdates();

    await user.click(creatorCheckbox('Alibaba Cloud'));

    await waitFor(() => {
      expect(window.location.search).toBe(`?creator=${ALIBABA}`);
    });
    expect(window.location.pathname).toBe(`${BASE}/updates/`);
  });

  it('updates the live count as the view narrows', async () => {
    const user = userEvent.setup();
    renderUpdates();

    await user.click(creatorCheckbox('Microsoft'));

    await waitFor(() => {
      expect(countText()).toBe('1 recorded change');
    });
  });

  it('drops a year heading that no longer has anything under it', async () => {
    const user = userEvent.setup();
    renderUpdates();

    // Only Amazon's recorded change falls in 2025.
    await user.click(creatorCheckbox('Microsoft'));

    await waitFor(() => {
      const years = [...document.querySelectorAll('.updates-year-label')].map((n) => n.textContent);
      expect(years).toEqual(['2026']);
    });
  });

  it('shows the selection as a chip that removes it', async () => {
    const user = userEvent.setup();
    renderUpdates();

    await user.click(creatorCheckbox('Alibaba Cloud'));
    await waitFor(() => expect(document.querySelector('.updates-chip')).not.toBeNull());

    const chip = document.querySelector('.updates-chip')!;

    expect(chip.textContent).toContain('Creator: Alibaba Cloud');

    await user.click(chip as HTMLElement);

    await waitFor(() => {
      expect(visibleEventIds()).toEqual(records.map((record) => record.id));
      expect(window.location.search).toBe('');
    });
  });

  it('clears everything back to the whole ledger and a clean URL', async () => {
    const user = userEvent.setup();
    renderUpdates();

    await user.click(creatorCheckbox('Alibaba Cloud'));
    await waitFor(() => expect(window.location.search).not.toBe(''));

    await user.click(document.querySelector('.updates-clear-all') as HTMLElement);

    await waitFor(() => {
      expect(visibleEventIds()).toEqual(records.map((record) => record.id));
      expect(window.location.search).toBe('');
    });
  });

  it('restores the view described by the URL on load', async () => {
    window.history.replaceState({}, '', `${BASE}/updates/?creator=${MICROSOFT}`);
    renderUpdates();

    await waitFor(() => {
      expect(visibleEventIds())
        .toEqual(records.filter((r) => r.creatorSlug === MICROSOFT).map((r) => r.id));
    });
  });

  it('ignores a creator the dataset no longer knows, rather than emptying the page', async () => {
    window.history.replaceState({}, '', `${BASE}/updates/?creator=a-creator-that-left`);
    renderUpdates();

    await waitFor(() => {
      expect(visibleEventIds()).toEqual(records.map((record) => record.id));
    });
  });

  it('says so, and offers a way back, when nothing matches', async () => {
    const user = userEvent.setup();
    renderUpdates();

    // Microsoft records no audio-speech release, so the two together match
    // nothing. Across dimensions the filters are "all of", not "either of".
    await user.click(creatorCheckbox('Microsoft'));
    await user.click(categoryCheckbox('Audio'));

    await waitFor(() => {
      expect(countText()).toBe('No updates match the current filters');
      expect(visibleEventIds()).toEqual([]);
    });

    const empty = document.querySelector('.updates-empty')!;

    expect(empty.textContent).toContain('No recorded change matches these filters.');

    await user.click(within(empty as HTMLElement).getByRole('button', { name: /clear all filters/i }));

    await waitFor(() => {
      expect(visibleEventIds()).toEqual(records.map((record) => record.id));
    });
  });

  it('distinguishes "nothing matches your filters" from "nothing is recorded"', async () => {
    const user = userEvent.setup();
    renderUpdates();

    await user.click(creatorCheckbox('Microsoft'));
    await user.click(categoryCheckbox('Audio'));

    await waitFor(() => {
      const empty = document.querySelector('.updates-empty')!;
      // The dataset is not empty, so the page must not claim it is.
      expect(empty.textContent).not.toContain('No release events are recorded yet');
    });
  });
});

describe('a link to one update that the filters would hide', () => {
  it('says the linked update is hidden rather than scrolling to nothing', async () => {
    const target = records.find((record) => record.creatorSlug === MICROSOFT)!;
    window.history.replaceState(
      {},
      '',
      `${BASE}/updates/?creator=${ALIBABA}#${target.anchorId}`,
    );
    renderUpdates();

    await waitFor(() => {
      const notice = document.querySelector('.updates-hidden-target');
      expect(notice).not.toBeNull();
      expect(notice!.textContent).toContain(target.modelName);
    });
  });

  it('reveals the linked update when the reader asks', async () => {
    const user = userEvent.setup();
    const target = records.find((record) => record.creatorSlug === MICROSOFT)!;
    window.history.replaceState(
      {},
      '',
      `${BASE}/updates/?creator=${ALIBABA}#${target.anchorId}`,
    );
    renderUpdates();

    await waitFor(() => expect(document.querySelector('.updates-show-target')).not.toBeNull());

    await user.click(document.querySelector('.updates-show-target') as HTMLElement);

    await waitFor(() => {
      expect(document.getElementById(target.anchorId)).not.toBeNull();
      expect(document.querySelector('.updates-hidden-target')).toBeNull();
    });
  });

  it('keeps the fragment while the filters change around it', async () => {
    const user = userEvent.setup();
    const target = records[0];
    window.history.replaceState({}, '', `${BASE}/updates/#${target.anchorId}`);
    renderUpdates();

    await user.click(creatorCheckbox('Alibaba Cloud'));

    await waitFor(() => {
      expect(window.location.hash).toBe(`#${target.anchorId}`);
      expect(window.location.search).toBe(`?creator=${ALIBABA}`);
    });
  });

  it('stays quiet about a fragment naming nothing in this ledger', async () => {
    window.history.replaceState({}, '', `${BASE}/updates/#event-never-existed`);
    renderUpdates();

    await waitFor(() => expect(document.querySelector('.release-updates')).not.toBeNull());
    expect(document.querySelector('.updates-hidden-target')).toBeNull();
  });
});

describe('one announcement covering several models', () => {
  it('keeps each model its own entry and links between them', () => {
    renderUpdates();

    const withCompanions = records.filter((record) => record.companions.length > 0);
    const rendered = document.querySelectorAll('.updates-item-companions');

    expect(rendered).toHaveLength(withCompanions.length);

    for (const node of rendered) {
      expect(node.textContent).toMatch(/recorded as its own change/);
      const link = node.querySelector('a');
      expect(link?.getAttribute('href')).toMatch(/^#event-/);
    }
  });
});
