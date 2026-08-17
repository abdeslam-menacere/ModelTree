import type { Dataset, ModelFamily, ModelRelease, Organization } from '../data/schema';

export interface ModelTreeFamily {
  family: ModelFamily;
  releases: ModelRelease[];
}

export interface ModelTreeCreator {
  organization: Organization;
  families: ModelTreeFamily[];
}

export interface ModelTree {
  featured: ModelTreeCreator[];
  others: never[];
}

export interface ModelTreePath {
  creatorId: string;
  familyId: string;
  releaseId: string;
}

export interface ModelTreeInteractionState {
  selectedReleaseId?: string;
  openCreatorIds: string[];
  openFamilyIds: string[];
}

function compare(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function buildModelTree(dataset: Dataset): ModelTree {
  const featuredCreatorIds = new Set(
    dataset.releases.filter(({ featured }) => featured).map(({ organizationId }) => organizationId),
  );

  const featured = dataset.organizations
    .filter(({ id }) => featuredCreatorIds.has(id))
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map((organization) => ({
      organization,
      families: dataset.families
        .filter(({ organizationId }) => organizationId === organization.id)
        .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
        .map((family) => ({
          family,
          releases: dataset.releases
            .filter(({ familyId }) => familyId === family.id)
            .sort((a, b) => (
              compare(b.releaseDate, a.releaseDate)
              || compare(a.id, b.id)
            )),
        }))
        .filter(({ releases }) => releases.length > 0),
    }));

  return { featured, others: [] };
}

export function findModelTreePath(
  tree: ModelTree,
  releaseId: string | null | undefined,
): ModelTreePath | undefined {
  if (!releaseId) return undefined;

  for (const { organization, families } of tree.featured) {
    for (const { family, releases } of families) {
      if (releases.some(({ id }) => id === releaseId)) {
        return { creatorId: organization.id, familyId: family.id, releaseId };
      }
    }
  }

  return undefined;
}

export function modelTreeReleaseIds(tree: ModelTree) {
  return tree.featured.flatMap(({ families }) => (
    families.flatMap(({ releases }) => releases.map(({ id }) => id))
  ));
}

export function restoreModelTreeSelection(
  tree: ModelTree,
  releaseId: string | null | undefined,
): ModelTreeInteractionState {
  const path = findModelTreePath(tree, releaseId);
  return path
    ? {
        selectedReleaseId: path.releaseId,
        openCreatorIds: [path.creatorId],
        openFamilyIds: [path.familyId],
      }
    : { openCreatorIds: [], openFamilyIds: [] };
}
