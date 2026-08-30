/**
 * The primary navigation, as data rather than as markup.
 *
 * Issue #523: eleven flat links had grown into a row that overflows its bar. The
 * fix is grouping, not deletion -- every destination that was reachable from the
 * header before is still reachable from it, some of them one disclosure deeper.
 *
 * Keeping the structure here rather than inline in `BaseLayout.astro` is what
 * lets `navigation.test.ts` assert the properties that matter (no destination
 * lost, no group of one, the row genuinely shorter than the destination list)
 * against the same value the layout renders, instead of against a copy of it.
 */

/**
 * Every page identity the header can mark as current.
 *
 * This is the runtime source for `BaseLayout`'s `currentPage` prop type, so the
 * union and this array cannot drift apart. It is also the denominator the
 * reachability test divides by: add an id here without giving it a home in the
 * navigation and that test reddens by construction.
 */
export const NAV_PAGE_IDS = [
  'explore',
  'tree',
  'catalog',
  'updates',
  'directory',
  'timeline',
  'compare',
  'benchmarks',
  'passport',
  'refresh',
  'methodology',
  'glossary',
] as const;

export type NavPageId = (typeof NAV_PAGE_IDS)[number];

/** A link in the header. Exactly one page identity, exactly one href. */
export interface NavDestination {
  readonly kind: 'destination';
  readonly id: NavPageId;
  readonly label: string;
  readonly href: string;
}

/** A top-level trigger that discloses a submenu. It is not itself a destination. */
export interface NavGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavDestination[];
}

export type NavItem = NavDestination | NavGroup;

export interface NavigationInput {
  /** `import.meta.env.BASE_URL`, which already carries its trailing slash. */
  readonly base: string;
  /**
   * The passport link is dynamic: on a model page it is that model's canonical
   * route, and elsewhere it is the first release the homepage hierarchy yields.
   * The layout receives it as a prop, so it arrives here as one too.
   */
  readonly passportHref: string;
}

function destination(id: NavPageId, label: string, href: string): NavDestination {
  return { kind: 'destination', id, label, href };
}

export function buildPrimaryNavigation({ base, passportHref }: NavigationInput): readonly NavItem[] {
  return [
    destination('explore', 'Home', base),
    destination('tree', 'Tree', `${base}tree/`),
    destination('timeline', 'Timeline', `${base}timeline/`),
    {
      kind: 'group',
      id: 'catalog-menu',
      label: 'Catalog',
      items: [
        destination('catalog', 'Browse models', `${base}models/`),
        // Grouped under Catalog rather than under "How it works", and the
        // distinction is an entity one. "How it works" documents ModelTree's own
        // process -- `/refresh/` is a log of *our* refresh runs. This route is
        // the recorded change history of the *models*, so it belongs with the
        // surfaces that browse the dataset.
        destination('updates', 'Release updates', `${base}updates/`),
        // Not "per Creator". This route is an A-Z of model *creators and serving
        // platforms*, which this dataset holds as two roles that never merge, so
        // a creator-only label here would collapse an entity boundary the
        // directory page exists to keep.
        destination('directory', 'Creators and platforms', `${base}providers/`),
        destination('compare', 'Compare models', `${base}compare/`),
        destination('benchmarks', 'Benchmarks', `${base}benchmarks/`),
        destination('passport', 'Model Passport', passportHref),
      ],
    },
    {
      kind: 'group',
      id: 'how-it-works-menu',
      label: 'How it works',
      items: [
        destination('refresh', 'Data refresh', `${base}refresh/`),
        destination('glossary', 'Explain this name', `${base}glossary/`),
        destination('methodology', 'Methodology', `${base}methodology/`),
      ],
    },
  ];
}

/** Every destination in the navigation, flattened out of its groups. */
export function navigationDestinations(items: readonly NavItem[]): readonly NavDestination[] {
  return items.flatMap((item) => (item.kind === 'destination' ? [item] : [...item.items]));
}

/**
 * `aria-current="page"` stays on the destination itself and never moves to the
 * trigger above it: the trigger is not a page, and marking it one would tell a
 * screen reader the user is somewhere they are not.
 */
export function ariaCurrentFor(
  item: NavDestination,
  currentPage: NavPageId | undefined,
): 'page' | undefined {
  return item.id === currentPage ? 'page' : undefined;
}

/**
 * Whether a group holds the page being viewed. This drives a visual hint on the
 * closed trigger only -- the current page would otherwise be invisible in the
 * header whenever it lives behind a disclosure.
 */
export function groupHoldsCurrentPage(
  group: NavGroup,
  currentPage: NavPageId | undefined,
): boolean {
  return group.items.some((item) => item.id === currentPage);
}
