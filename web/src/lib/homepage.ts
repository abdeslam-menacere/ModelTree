import type { Dataset, ModelFamily, ModelRelease, Organization } from '../data/schema';
import { hasRecordedRelease } from './family-branch';
import { compareLabels, organizationLabel } from './organization-name';

export interface HomepageFamily {
  family: ModelFamily;
  releases: ModelRelease[];
}

export interface HomepageOrganization {
  organization: Organization;
  families: HomepageFamily[];
}

function compare(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function buildHomepageHierarchy(dataset: Dataset): HomepageOrganization[] {
  return [...dataset.organizations]
    // Ordered by the label, because the label is what the page prints. Sorting
    // on one recorded form while displaying the other is the #479 defect, and
    // it reads as a broken sort rather than as a naming bug.
    .sort((a, b) => compareLabels(organizationLabel(a), organizationLabel(b)) || compare(a.id, b.id))
    .map((organization) => ({
      organization,
      families: dataset.families
        .filter((family) => family.organizationId === organization.id)
        // A family carries one recorded name and the page prints that same
        // name, so this comparator is already sorting on what it displays.
        .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
        .map((family) => ({
          family,
          releases: dataset.releases
            .filter((release) => release.familyId === family.id)
            .sort((a, b) => compare(a.displayName, b.displayName) || compare(a.slug, b.slug)),
        }))
        // The same rule `/tree/` applies, read from one place so the two
        // hierarchies cannot answer differently again. Without it this builder
        // rendered a family with no releases as a heading above an empty list
        // while `buildModelTree` dropped it, so `/` published a data error that
        // `/tree/` hid (#554).
        .filter(hasRecordedRelease),
    }));
}

export function firstHomepageRelease(hierarchy: readonly HomepageOrganization[]) {
  for (const { families } of hierarchy) {
    for (const { releases } of families) {
      if (releases[0]) return releases[0];
    }
  }

  throw new Error('Homepage requires at least one model release');
}