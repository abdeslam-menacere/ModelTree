import type { Organization } from '../data/schema';

/**
 * The creator naming rule, in one place.
 *
 * An organization record carries two name fields, and both are recorded facts:
 * `shortName` is the form the creator is commonly known and searched by, and
 * `name` is the fuller form its own surfaces also use. The two disagree for
 * more than one creator, and for `xai` they disagree because the creator's own
 * surfaces disagree -- a conflict this dataset records rather than resolves.
 *
 * Before this rule existed every surface read `name`, so a creator whose fuller
 * recorded form is the less recognisable of the two was displayed, sorted, and
 * filed under a string its readers do not use. `xai` was displayed as
 * "SpaceXAI" and filed under S, so a reader looking under X found nothing even
 * though search found it through the alias
 * (abdeslam-menacere/ModelTree#479).
 *
 * **The rule: `shortName` is the label.** It is the one string an organization
 * is displayed as, sorted on, and filed under, for every organization, with no
 * per-creator exceptions.
 *
 * `name` is not deleted and not demoted to decoration. It stays in the dataset,
 * it stays a search term so either recorded form finds the creator, and it is
 * shown as the full recorded form on the creator's own profile page wherever it
 * says something the label does not. A recorded name conflict therefore stays
 * visible to a reader instead of being resolved by the renderer.
 *
 * Choosing the field here rather than at each call site is the point: the five
 * display, sort, and filing sites the defect was found in could each have been
 * fixed on their own, and would then have been free to drift apart again.
 *
 * This rule decides *which recorded name is used*, and how two of the chosen
 * strings compare -- see {@link compareLabels}, which exists because choosing
 * the label as the sort key does not by itself put a creator where a reader
 * looks. It never touches `id` or `slug`, which are identity, not presentation.
 */
export type OrganizationNames = Pick<Organization, 'name' | 'shortName'>;

/**
 * The label: what an organization is displayed as, sorted on, and filed under.
 */
export function organizationLabel(organization: OrganizationNames): string {
  return organization.shortName;
}

/** The fuller recorded form. Never the label, never discarded. */
export function organizationFullName(organization: OrganizationNames): string {
  return organization.name;
}

/**
 * The full recorded form when it says something the label does not, else null.
 *
 * Null means the two recorded forms agree, so repeating the label would state
 * a distinction the record does not make.
 */
export function organizationFullNameIfDistinct(
  organization: OrganizationNames,
): string | null {
  const full = organizationFullName(organization);
  return full === organizationLabel(organization) ? null : full;
}

/**
 * Every recorded name form, label first, de-duplicated.
 *
 * Both forms are searchable: leading with the recognisable one must not cost a
 * reader who knows the other. This is what keeps `name` functional after it
 * stops being the label.
 */
export function organizationSearchTerms(organization: OrganizationNames): string[] {
  return [...new Set([organizationLabel(organization), organizationFullName(organization)])];
}

/**
 * Ordering for creator labels: the same comparison the label rule implies.
 *
 * Choosing the label as the sort *key* is only half of "a creator appears where
 * the reader looks for it". The other half is the comparison, and a raw code
 * unit `<` is not it: uppercase letters occupy 65-90 and lowercase 97-122, so
 * any label beginning with a lowercase letter sorts after every label beginning
 * with an uppercase one. `xAI` filed correctly under X while rendering after
 * `Zhipu AI`, which is the same "not where a reader looks" complaint that this
 * rule exists to answer, just moved from the letter to the position.
 *
 * Case is folded and everything else is left alone, deliberately. A
 * locale-aware comparison would also reorder accents and punctuation, which is
 * a larger behavioural change than the defect calls for and is not something
 * any source states. Labels that differ only by case fall back to the code unit
 * order so the result stays total and stable; callers still add their own id or
 * slug tiebreak.
 */
export function compareLabels(a: string, b: string): number {
  const folded = a.toLowerCase();
  const other = b.toLowerCase();
  if (folded !== other) return folded < other ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
