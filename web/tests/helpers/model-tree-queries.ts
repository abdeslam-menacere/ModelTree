import { expect } from 'vitest';
import { organizationLabel, type OrganizationLabelName } from '../../src/lib/organization-name';

/**
 * Queries for the lineage tree's disclosures and release nodes, selecting on the
 * stable ids the component already emits rather than on display prose.
 *
 * -- The defect these exist to close (issue #777) --
 *
 * A role query anchored only at the start of a name --
 * `getByRole('button', { name: /^Claude 5/ })` -- matches the family `Claude 5`
 * and every future `Claude 5.x` alike. That was not merely fragile. It made the
 * dataset unable to *represent* a `Claude 5.1` family at all: a reviewed
 * Anthropic release that had cleared every data gate had to be withheld,
 * because adding it turned five queries in two files into twelve
 * `Found multiple elements with the role "button"` failures, in tests that are
 * about disclosure behaviour and have nothing to say about Anthropic.
 *
 * Widening the pattern, or reaching for `getAllByRole(...)[0]`, would have made
 * those failures go away while leaving the query ambiguous -- the test would
 * then pass by silently taking whichever of two elements the DOM happened to
 * order first. So these helpers select by id and *assert that exactly one
 * element matched*: an ambiguity becomes a named failure here, once, instead of
 * an arbitrary choice at every call site.
 *
 * -- Which ids, and why they are the stable ones --
 *
 * The component already emits both. `tree-family-<familyId>` is the
 * `aria-controls` of a family disclosure and the `id` of the release list it
 * opens; a release is located by the slug in the passport link beside it. Both
 * derive from dataset identifiers, so neither moves when a display name is
 * edited, and neither moves when the `4 releases` count in the button's
 * accessible name changes -- which is the second latent break in the old
 * selectors, and it fires every single time a release is added to a family.
 *
 * This is the shape `ModelCatalog.interaction.test.tsx`'s `creatorCheckbox`
 * already uses for the same reason: select on the stable identifier, then assert
 * the name, so that id-based selection cannot quietly stop being *named* for the
 * thing it selects.
 *
 * -- A second reason, since issue #744 --
 *
 * Selecting by id is also what keeps these lookups' cost off the dataset, which
 * is the thing this repository is deliberately growing. That is why
 * {@link creatorDisclosure} was added: not to resolve an ambiguity, but because
 * the name-based creator lookup it replaces was the last query in these files
 * still priced by the size of the whole catalog. The measurements are on it.
 */

function only<T extends Element>(nodes: ArrayLike<T>, what: string): T {
  const found = Array.from(nodes);
  // The message is the whole value of this helper over `[0]`: it names what was
  // being looked for and how many things answered to it, which is the sentence
  // the old selectors could not produce.
  expect(found.length, `expected exactly one ${what}, found ${found.length}`).toBe(1);
  return found[0] as T;
}

/**
 * The disclosure button for one creator, selected by the organization id in its
 * `aria-controls`.
 *
 * -- Why this is not `getByRole('button', { name: /^Anthropic/ })` (issue #744) --
 *
 * The two are not equally priced. `getByRole(..., { name })` computes an
 * accessible name for every button in its container and, because the default
 * `hidden: false` also filters on accessibility-visibility, resolves computed
 * style for each one as well. The explorer renders the whole dataset up front --
 * collapsed branches carry the `hidden` attribute, they are not unmounted -- so
 * that container is the entire catalog: 237 buttons at 110 releases, growing
 * with every tranche. Measured here, on the failing test's own four-click
 * sequence with only this lookup varied:
 *
 *   releases  buttons   by name   by id
 *       110       237    2005ms   892ms
 *       210       454    2596ms   913ms
 *       310       671    4115ms  1063ms
 *
 * 10.6 ms per added release by name against 0.9 by id. The point is the slope,
 * not the intercept: this repository is deliberately growing the dataset, so a
 * test priced by name gets worse with every creator added, and one priced by id
 * does not.
 *
 * The id is the same `aria-controls` wiring {@link familyDisclosure} uses, one
 * level up, so reaching the button this way exercises the disclosure's
 * association with its panel rather than assuming it.
 */
export function creatorDisclosure(
  organization: { id: string } & OrganizationLabelName,
): HTMLButtonElement {
  const button = only(
    document.querySelectorAll<HTMLButtonElement>(
      `button[aria-controls="tree-creator-${organization.id}"]`,
    ),
    `creator disclosure for "${organization.id}"`,
  );
  // Same reason as below: selecting by id says nothing about what the button is
  // called, so the label is asserted rather than assumed.
  expect(button.querySelector('span')?.textContent).toBe(organizationLabel(organization));
  return button;
}

/**
 * The disclosure button for one family, selected by the family id in its
 * `aria-controls`.
 */
export function familyDisclosure(family: { id: string; name: string }): HTMLButtonElement {
  const button = only(
    document.querySelectorAll<HTMLButtonElement>(
      `button[aria-controls="tree-family-${family.id}"]`,
    ),
    `family disclosure for "${family.id}"`,
  );
  // Selecting by id says nothing about what the button is called, so a
  // disclosure that stopped being named for its family would still be found
  // here. The name is asserted rather than assumed.
  expect(button.querySelector('span')?.textContent).toBe(family.name);
  return button;
}

/**
 * The release button inside its own family's list, located by the release slug
 * in the passport link beside it.
 *
 * The button carries no id of its own -- the component gives it `aria-pressed`
 * and nothing else -- so the nearest stable hook is the passport `href`, built
 * from `release.slug`. That href is deliberately not assumed unique in the
 * document, because it is not: the details drawer renders a `View model` link to
 * the very same URL for whichever release is selected. Scoping the lookup to
 * `#tree-family-<familyId>`, the release list the component already gives an id,
 * is what makes it unambiguous.
 *
 * Nothing here asks the component for a new hook. If one is ever added to the
 * release button itself, this is the single place that would change.
 */
export function releaseButton(
  release: { familyId: string; slug: string; displayName: string },
): HTMLButtonElement {
  const list = document.getElementById(`tree-family-${release.familyId}`);
  expect(list, `no release list rendered for family "${release.familyId}"`).not.toBeNull();

  const passport = only(
    (list as HTMLElement).querySelectorAll<HTMLAnchorElement>(
      `a[href$="/models/${release.slug}/"]`,
    ),
    `passport link for release "${release.slug}"`,
  );
  const node = passport.closest('.tree-release-node');
  expect(node, `passport link for "${release.slug}" is not inside a release node`).not.toBeNull();

  const button = only(
    (node as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    `release button for "${release.slug}"`,
  );
  expect(button.querySelector('strong')?.textContent).toBe(release.displayName);
  return button;
}
