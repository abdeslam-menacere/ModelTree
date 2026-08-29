import { describe, expect, it } from 'vitest';
import {
  NAV_PAGE_IDS,
  type NavDestination,
  type NavGroup,
  type NavItem,
  ariaCurrentFor,
  buildPrimaryNavigation,
  groupHoldsCurrentPage,
  navigationDestinations,
} from './navigation';

/**
 * Issue #523 collapsed eleven flat header links into five top-level items. The
 * risk in that shape of change is silent loss: a destination that stops being
 * reachable, or a page whose `aria-current` marker quietly moves or disappears.
 *
 * So almost nothing here is a recited list. The assertions divide the rendered
 * structure by `NAV_PAGE_IDS`, which is the same array `BaseLayout` derives its
 * `currentPage` prop type from -- adding a page to the union without giving it a
 * place in the menu reddens these by construction rather than by anyone
 * remembering to update a number.
 */

const BASE = '/probe/';
const PASSPORT = '/probe/models/some-release/';

const navigation = buildPrimaryNavigation({ base: BASE, passportHref: PASSPORT });

function groups(items: readonly NavItem[]): NavGroup[] {
  return items.filter((item): item is NavGroup => item.kind === 'group');
}

function topLevelDestinations(items: readonly NavItem[]): NavDestination[] {
  return items.filter((item): item is NavDestination => item.kind === 'destination');
}

describe('the header still reaches everywhere it used to', () => {
  it('gives every page identity exactly one destination', () => {
    const destinations = navigationDestinations(navigation);

    for (const id of NAV_PAGE_IDS) {
      const matches = destinations.filter((destination) => destination.id === id);

      expect(matches.map((match) => match.label), `page id "${id}"`).toHaveLength(1);
    }
  });

  it('invents no destination that is not a known page identity', () => {
    const known = new Set<string>(NAV_PAGE_IDS);

    for (const destination of navigationDestinations(navigation)) {
      expect(known.has(destination.id), `unknown page id "${destination.id}"`).toBe(true);
    }
  });

  it('gives every destination a non-empty label and href', () => {
    for (const destination of navigationDestinations(navigation)) {
      expect(destination.label.trim(), `label for "${destination.id}"`).not.toBe('');
      expect(destination.href.trim(), `href for "${destination.id}"`).not.toBe('');
    }
  });
});

describe('the row is genuinely shorter than what it leads to', () => {
  // The point of the issue. Stated as a relation rather than as a count, so it
  // keeps meaning something as the site grows: a new page must land inside a
  // group, and cannot quietly re-lengthen the row.
  it('shows fewer top-level items than there are destinations', () => {
    expect(navigation.length).toBeLessThan(navigationDestinations(navigation).length);
  });

  it('puts more than one destination behind every disclosure', () => {
    const disclosures = groups(navigation);

    expect(disclosures.length).toBeGreaterThan(0);

    for (const group of disclosures) {
      expect(group.items.length, `group "${group.label}"`).toBeGreaterThan(1);
    }
  });

  it('gives each group its own identifier, distinct from every page identity', () => {
    const ids = groups(navigation).map((group) => group.id);
    const pageIds = new Set<string>(NAV_PAGE_IDS);

    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      expect(pageIds.has(id), `group id "${id}" collides with a page id`).toBe(false);
    }
  });

  /**
   * The one place labels are asserted, because here the label *is* the issue's
   * acceptance criterion: "Home (instead of explore)", "Model Tree becomes
   * Tree", Timeline, then two grouping words. Site growth does not falsify this
   * -- a new page belongs in a submenu, which is the whole point above.
   */
  it('shows the top level the issue asked for, in order', () => {
    expect(navigation.map((item) => item.label)).toEqual([
      'Home',
      'Tree',
      'Timeline',
      'Catalog',
      'How it works',
    ]);
  });
});

describe('entity boundaries survive the relabelling', () => {
  /**
   * The issue's wording for `/providers` was "per Creator". That route is an A-Z
   * of creators *and* serving platforms, which this dataset holds as two roles
   * that never merge, so a creator-only label would collapse a boundary the page
   * itself exists to keep. This fails if anyone shortens it back.
   */
  it('does not describe the creator and serving-platform directory as creators alone', () => {
    const directory = navigationDestinations(navigation).find((item) => item.id === 'directory');

    expect(directory).toBeDefined();
    expect(directory?.href).toBe(`${BASE}providers/`);
    expect(directory?.label).toMatch(/creator/i);
    expect(directory?.label, 'the directory is not creators-only').toMatch(/platform/i);
  });
});

describe('links respect the deployed base path', () => {
  it('prefixes every href it builds itself', () => {
    for (const destination of navigationDestinations(navigation)) {
      if (destination.id === 'passport') continue;

      expect(destination.href, `href for "${destination.id}"`).toMatch(/^\/probe\//);
    }
  });

  it('passes the caller-supplied passport route through untouched', () => {
    const passport = navigationDestinations(navigation).find((item) => item.id === 'passport');

    expect(passport?.href).toBe(PASSPORT);
  });

  it('rebuilds every href when the base path changes', () => {
    const rootBased = navigationDestinations(buildPrimaryNavigation({
      base: '/',
      passportHref: '/models/some-release/',
    }));

    for (const destination of rootBased) {
      expect(destination.href, `href for "${destination.id}"`).not.toMatch(/^\/probe\//);
      expect(destination.href.startsWith('/')).toBe(true);
    }
  });
});

describe('aria-current marks the page and nothing else', () => {
  it('marks exactly one destination for every page identity', () => {
    const destinations = navigationDestinations(navigation);

    for (const id of NAV_PAGE_IDS) {
      const marked = destinations.filter((destination) => ariaCurrentFor(destination, id) === 'page');

      expect(marked.map((match) => match.id), `page id "${id}"`).toEqual([id]);
    }
  });

  it('marks nothing when the layout is given no current page', () => {
    for (const destination of navigationDestinations(navigation)) {
      expect(ariaCurrentFor(destination, undefined)).toBeUndefined();
    }
  });

  it('flags the group holding the current page, and only that group', () => {
    const disclosures = groups(navigation);

    for (const id of NAV_PAGE_IDS) {
      const holding = disclosures.filter((group) => groupHoldsCurrentPage(group, id));
      const owner = disclosures.find((group) => group.items.some((item) => item.id === id));

      expect(holding, `page id "${id}"`).toEqual(owner ? [owner] : []);
    }
  });

  it('flags no group when a top-level destination is the current page', () => {
    for (const destination of topLevelDestinations(navigation)) {
      for (const group of groups(navigation)) {
        expect(groupHoldsCurrentPage(group, destination.id)).toBe(false);
      }
    }
  });
});
