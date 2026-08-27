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
  others: ModelTreeCreator[];
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

function newestFamilyReleaseDate(dataset: Dataset, familyId: string) {
  return dataset.releases
    .filter((release) => release.familyId === familyId)
    .reduce((newest, release) => (
      compare(release.releaseDate, newest) > 0 ? release.releaseDate : newest
    ), '');
}

/**
 * Both branches are the same shape and obey the same ordering rules; only the
 * membership test differs. Keeping one builder is what guarantees they cannot
 * drift apart.
 */
function buildCreators(dataset: Dataset, organizations: Organization[]): ModelTreeCreator[] {
  return organizations
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map((organization) => ({
      organization,
      families: dataset.families
        .filter(({ organizationId }) => organizationId === organization.id)
        .sort((a, b) => (
          compare(
            newestFamilyReleaseDate(dataset, b.id),
            newestFamilyReleaseDate(dataset, a.id),
          )
          || compare(a.id, b.id)
        ))
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
}

export function buildModelTree(dataset: Dataset): ModelTree {
  // Featured membership is decided at creator level, not release level: one
  // featured release makes the whole creator featured, and every one of its
  // releases stays with it rather than being split across the two branches.
  const featuredCreatorIds = new Set(
    dataset.releases.filter(({ featured }) => featured).map(({ organizationId }) => organizationId),
  );
  const creatorIdsWithReleases = new Set(
    dataset.releases.map(({ organizationId }) => organizationId),
  );

  return {
    featured: buildCreators(
      dataset,
      dataset.organizations.filter(({ id }) => featuredCreatorIds.has(id)),
    ),
    others: buildCreators(
      dataset,
      dataset.organizations.filter(
        ({ id }) => creatorIdsWithReleases.has(id) && !featuredCreatorIds.has(id),
      ),
    ),
  };
}

/** Every creator branch in render order: featured first, then others. */
function modelTreeCreators(tree: ModelTree): ModelTreeCreator[] {
  return [...tree.featured, ...tree.others];
}

export function findModelTreePath(
  tree: ModelTree,
  releaseId: string | null | undefined,
): ModelTreePath | undefined {
  if (!releaseId) return undefined;

  for (const { organization, families } of modelTreeCreators(tree)) {
    for (const { family, releases } of families) {
      if (releases.some(({ id }) => id === releaseId)) {
        return { creatorId: organization.id, familyId: family.id, releaseId };
      }
    }
  }

  return undefined;
}

export function modelTreeReleaseIds(tree: ModelTree) {
  // A creator belongs to exactly one branch, so concatenating the two cannot
  // repeat a release.
  return modelTreeCreators(tree).flatMap(({ families }) => (
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

export function toggleModelTreeBranch(openIds: ReadonlySet<string>, id: string) {
  const next = new Set(openIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
