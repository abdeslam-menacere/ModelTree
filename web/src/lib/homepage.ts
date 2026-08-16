import type { Dataset, ModelFamily, ModelRelease, Organization } from '../data/schema';

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
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map((organization) => ({
      organization,
      families: dataset.families
        .filter((family) => family.organizationId === organization.id)
        .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
        .map((family) => ({
          family,
          releases: dataset.releases
            .filter((release) => release.familyId === family.id)
            .sort((a, b) => compare(a.displayName, b.displayName) || compare(a.slug, b.slug)),
        })),
    }));
}