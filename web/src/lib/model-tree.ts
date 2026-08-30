import type { Dataset, ModelFamily, ModelRelease, Organization } from '../data/schema';
import { comparePartialDates, comparePartialDatesDescending } from '../data/partial-date';
import { hasRecordedRelease } from './family-branch';
import { compareLabels, organizationLabel } from './organization-name';

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
      newest === '' || comparePartialDates(release.releaseDate, newest) > 0
        ? release.releaseDate
        : newest
    ), '');
}

/**
 * Both branches are the same shape and obey the same ordering rules; only the
 * membership test differs. Keeping one builder is what guarantees they cannot
 * drift apart.
 */
function buildCreators(dataset: Dataset, organizations: Organization[]): ModelTreeCreator[] {
  // Copy before sorting: the caller passes a filtered view of dataset.organizations
  // and must not have its own array reordered underneath it.
  // Ordered by the creator label, not by `name`: a creator must appear where the
  // string the reader sees says it will. See `organization-name.ts`.
  return [...organizations]
    .sort((a, b) => compareLabels(organizationLabel(a), organizationLabel(b)) || compare(a.id, b.id))
    .map((organization) => ({
      organization,
      families: dataset.families
        .filter(({ organizationId }) => organizationId === organization.id)
        .sort((a, b) => (
          comparePartialDatesDescending(
            newestFamilyReleaseDate(dataset, a.id),
            newestFamilyReleaseDate(dataset, b.id),
          )
          || compare(a.id, b.id)
        ))
        .map((family) => ({
          family,
          releases: dataset.releases
            .filter(({ familyId }) => familyId === family.id)
            .sort((a, b) => (
              comparePartialDatesDescending(a.releaseDate, b.releaseDate)
              || compare(a.id, b.id)
            )),
        }))
        // The shared rule, not a local one: `homepage.ts` reads the same
        // predicate, which is what stops the two hierarchies answering
        // differently again (#554).
        .filter(hasRecordedRelease),
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
