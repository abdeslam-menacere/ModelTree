// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GlossaryEntry } from '../data/glossary-schema';
import { GLOSSARY_SEARCH_PARAM } from '../lib/glossary';
import Glossary from './Glossary';

/**
 * The glossary page's search and anchors: shareable, restorable, and never
 * capable of hiding the entry a shared link points at.
 *
 * The fixture is local so a data refresh cannot redden this file.
 */

function entry(overrides: Partial<GlossaryEntry> & Pick<GlossaryEntry, 'id' | 'term'>): GlossaryEntry {
  return {
    category: 'parameters',
    aliases: [],
    short: 'A short explanation.',
    definition: 'A longer definition.',
    distinctions: [],
    examples: [],
    related: [],
    conflicts: [],
    sources: [{
      url: 'https://example.com/docs',
      title: 'Docs',
      publisher: 'Example',
      type: 'official-docs',
      quote: 'Quoted verbatim.',
      lastCheckedDate: '2026-08-28',
    }],
    verifiedAt: '2026-08-28',
    ...overrides,
  };
}

const entries: GlossaryEntry[] = [
  entry({
    id: 'active-parameters',
    term: 'Active parameters',
    aliases: ['activated parameters'],
    short: 'The weights used per token.',
    definition: 'A router selects a few experts for each token.',
    related: ['mixture-of-experts'],
  }),
  entry({
    id: 'mixture-of-experts',
    term: 'Mixture of experts',
    category: 'architecture',
    aliases: ['MoE'],
    short: 'Routes each token to a few experts.',
    definition: 'Many experts, a few of them used at a time.',
    conflicts: [{ note: 'Publishers label this inconsistently.', urls: ['https://example.com/a'] }],
  }),
  entry({
    id: 'quantization-tag',
    term: 'Quantization tag',
    category: 'precision',
    aliases: ['Q4_K_M'],
    short: 'Names the stored numeric precision.',
    definition: 'Applied after training by whoever converted the file.',
  }),
];

function renderGlossary() {
  return render(<Glossary entries={entries} />);
}

function visibleEntryIds() {
  return [...document.querySelectorAll('.glossary-entry')].map((node) => node.id);
}

function searchBox() {
  return document.getElementById('glossary-search') as HTMLInputElement;
}

function countText() {
  return document.querySelector('.glossary-count')?.textContent ?? '';
}

beforeEach(() => {
  window.history.replaceState({}, '', '/ModelTree/glossary/');
});

afterEach(() => {
  cleanup();
});

describe('the glossary before any interaction', () => {
  it('renders every entry, so a reader with no JavaScript loses nothing', () => {
    renderGlossary();

    expect(visibleEntryIds()).toEqual([
      'active-parameters',
      'mixture-of-experts',
      'quantization-tag',
    ]);
  });

  it('gives every entry a stable anchor id and a link to it', () => {
    renderGlossary();

    for (const id of ['active-parameters', 'mixture-of-experts', 'quantization-tag']) {
      const article = document.getElementById(id);
      expect(article, id).not.toBeNull();
      expect(article?.querySelector(`.glossary-anchor[href="#${id}"]`), `anchor for ${id}`)
        .not.toBeNull();
    }
  });

  it('shows the primary source, its check date, and the publisher\u2019s own words', () => {
    renderGlossary();

    const article = document.getElementById('active-parameters') as HTMLElement;

    expect(article.querySelector('.glossary-sources a')?.getAttribute('href'))
      .toBe('https://example.com/docs');
    expect(article.querySelector('.glossary-source-meta')?.textContent)
      .toContain('checked 2026-08-28');
    expect(article.querySelector('blockquote')?.textContent).toBe('Quoted verbatim.');
    expect(article.querySelector('.glossary-verified')?.textContent)
      .toContain('verified 2026-08-28');
  });

  it('labels the search field, rather than relying on the placeholder alone', () => {
    renderGlossary();

    const label = document.querySelector('label[for="glossary-search"]');
    expect(label?.textContent).toContain('Search terms');
    expect(searchBox()).not.toBeNull();
  });
});

describe('searching the glossary', () => {
  it('narrows to the matching entries and states the count in words', async () => {
    const user = userEvent.setup();
    renderGlossary();

    await user.type(searchBox(), 'router');

    await waitFor(() => expect(visibleEntryIds()).toEqual(['active-parameters']));
    expect(countText()).toContain('Showing 1 of 3 terms');
  });

  it('finds a canonical entry through an alias and says which alias matched', async () => {
    const user = userEvent.setup();
    renderGlossary();

    await user.type(searchBox(), 'MoE');

    await waitFor(() => expect(visibleEntryIds()).toEqual(['mixture-of-experts']));
    expect(document.querySelector('.glossary-alias-hit')?.textContent)
      .toContain('Matched the alias \u201cMoE\u201d, which resolves to Mixture of experts.');
  });

  it('says which query matched nothing rather than falling back to everything', async () => {
    const user = userEvent.setup();
    renderGlossary();

    await user.type(searchBox(), 'flux capacitor');

    await waitFor(() => expect(visibleEntryIds()).toEqual([]));
    expect(countText()).toContain('No recorded term matches \u201cflux capacitor\u201d');
    expect(document.querySelector('.glossary-empty')).not.toBeNull();
  });

  it('writes the query to the URL and clears it again when the box is emptied', async () => {
    const user = userEvent.setup();
    renderGlossary();

    await user.type(searchBox(), 'MoE');
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get(GLOSSARY_SEARCH_PARAM)).toBe('MoE');
    });

    await user.clear(searchBox());
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get(GLOSSARY_SEARCH_PARAM)).toBeNull();
    });
  });

  it('preserves an unrelated parameter and the fragment while searching', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/ModelTree/glossary/?theme=dark#mixture-of-experts');
    renderGlossary();

    await user.type(searchBox(), 'router');

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.searchParams.get('theme')).toBe('dark');
      expect(url.searchParams.get(GLOSSARY_SEARCH_PARAM)).toBe('router');
      expect(url.hash).toBe('#mixture-of-experts');
    });
  });
});

describe('a search is shareable', () => {
  it('restores the query from the URL on mount', async () => {
    window.history.replaceState({}, '', `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=router`);
    renderGlossary();

    await waitFor(() => expect(visibleEntryIds()).toEqual(['active-parameters']));
    expect(searchBox().value).toBe('router');
  });

  it('restores the query on a Back or Forward navigation', async () => {
    const user = userEvent.setup();
    renderGlossary();

    await user.type(searchBox(), 'router');
    await waitFor(() => expect(visibleEntryIds()).toEqual(['active-parameters']));

    window.history.replaceState({}, '', '/ModelTree/glossary/');
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(visibleEntryIds()).toHaveLength(3));
    expect(searchBox().value).toBe('');
  });
});

describe('a direct anchor is shareable, and never lands on nothing', () => {
  it('keeps the entry a fragment names visible even when the search excludes it', async () => {
    window.history.replaceState(
      {},
      '',
      `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=router#quantization-tag`,
    );
    renderGlossary();

    await waitFor(() => {
      expect(visibleEntryIds()).toEqual(['active-parameters', 'quantization-tag']);
    });
    expect(document.getElementById('quantization-tag')?.textContent)
      .toContain('Kept in view because the link you followed points at this entry');
  });

  it('does not count the pinned entry as a search result', async () => {
    window.history.replaceState(
      {},
      '',
      `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=router#quantization-tag`,
    );
    renderGlossary();

    await waitFor(() => expect(countText()).toContain('Showing 1 of 3 terms'));
  });

  it('adds no pinning notice when the anchored entry matches the search anyway', async () => {
    window.history.replaceState(
      {},
      '',
      `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=router#active-parameters`,
    );
    renderGlossary();

    await waitFor(() => expect(visibleEntryIds()).toEqual(['active-parameters']));
    expect(document.body.textContent).not.toContain('Kept in view because');
  });

  it('follows a hash change to a new entry without a reload', async () => {
    window.history.replaceState(
      {},
      '',
      `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=router#quantization-tag`,
    );
    renderGlossary();
    await waitFor(() => expect(visibleEntryIds()).toHaveLength(2));

    window.history.replaceState(
      {},
      '',
      `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=router#mixture-of-experts`,
    );
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() => {
      expect(visibleEntryIds()).toEqual(['active-parameters', 'mixture-of-experts']);
    });
  });

  it('ignores a fragment that names no recorded entry', async () => {
    window.history.replaceState(
      {},
      '',
      `/ModelTree/glossary/?${GLOSSARY_SEARCH_PARAM}=router#no-such-entry`,
    );
    renderGlossary();

    await waitFor(() => expect(visibleEntryIds()).toEqual(['active-parameters']));
  });
});

describe('related terms are navigable', () => {
  it('links a related term to its own anchor', () => {
    renderGlossary();

    const related = document
      .getElementById('active-parameters')
      ?.querySelector('.glossary-related a');

    expect(related?.getAttribute('href')).toBe('#mixture-of-experts');
    expect(related?.textContent).toBe('Mixture of experts');
  });
});

/**
 * The glossary's sibling of issue #650, checked rather than assumed.
 *
 * `glossary.json` shares the inline-source convention with
 * `variant-positioning.json`: `sources` is `min(1)` and unbounded, and four
 * committed entries already cite two pages. Both readers of the positioning
 * document took `sources[0]` and dropped the rest; this pins the finding that
 * the glossary renderer never did, so the divergence between "the schema
 * permits many" and "the page shows one" cannot open up here later either.
 */
describe('an entry citing several pages shows all of them', () => {
  const TWO_SOURCE_ENTRY = 'two-source-entry';

  const secondSource = {
    url: 'https://example.com/model-card',
    title: 'Model card',
    publisher: 'Example',
    type: 'model-card' as const,
    quote: 'Quoted verbatim from the second page.',
    lastCheckedDate: '2026-08-29',
  };

  function renderTwoSource() {
    return render(
      <Glossary
        entries={[entry({
          id: TWO_SOURCE_ENTRY,
          term: 'Two source entry',
          sources: [
            {
              url: 'https://example.com/docs',
              title: 'Docs',
              publisher: 'Example',
              type: 'official-docs',
              quote: 'Quoted verbatim.',
              lastCheckedDate: '2026-08-28',
            },
            secondSource,
          ],
        })]}
      />,
    );
  }

  it('renders one list item per cited page, not just the first', () => {
    renderTwoSource();
    const items = document.querySelectorAll(`#${TWO_SOURCE_ENTRY} .glossary-sources li`);

    expect(items).toHaveLength(2);
  });

  it('carries the quote, link and check date belonging to each page', () => {
    renderTwoSource();
    const block = document.querySelector(`#${TWO_SOURCE_ENTRY} .glossary-sources`);

    expect(block?.textContent).toContain('Quoted verbatim.');
    expect(block?.textContent).toContain(secondSource.quote);
    expect(block?.textContent).toContain(secondSource.title);
    expect(block?.textContent).toContain(secondSource.lastCheckedDate);
    expect(block?.querySelector(`a[href="${secondSource.url}"]`)).not.toBeNull();
  });
});
