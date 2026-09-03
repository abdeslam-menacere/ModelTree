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

/**
 * The tree as the hydrated island receives it: the recorded fields those
 * components render, and nothing else (abdeslam-menacere/ModelTree#813).
 *
 * `buildModelTree` returns whole `Organization`, `ModelFamily` and
 * `ModelRelease` records, which is right for a server-side caller reasoning
 * about the dataset. It is wrong for an island prop, because an island prop is
 * *shipped*: Astro serialises it into the page, so every recorded field the
 * components never read is paid for by every visitor. `/tree` was paying
 * 364,623 bytes of HTML attribute for a 100,652-byte view, and the route sat at
 * 99.0% of its critical-path budget with under one further creator of headroom.
 *
 * These are `Pick`s of the schema types rather than restatements of them, so
 * the field list cannot drift from the records it projects, and a full record
 * stays structurally assignable to its view — which is what lets the existing
 * component tests keep passing whole `buildModelTree` output.
 *
 * The selection helpers below take the view type for the same reason: they read
 * only ids, so narrowing their parameter costs no caller anything and lets the
 * island call them with what it actually holds.
 */
export type ModelTreeViewOrganization = Pick<Organization, 'id' | 'shortName'>;

export type ModelTreeViewFamilyRecord = Pick<ModelFamily, 'id' | 'name'>;

export type ModelTreeViewRelease = Pick<
  ModelRelease,
  | 'id'
  | 'slug'
  | 'displayName'
  | 'releaseDate'
  | 'datePrecision'
  | 'status'
  | 'accessType'
  | 'intendedUse'
  | 'summary'
  | 'verifiedAt'
>;

export interface ModelTreeViewFamily {
  family: ModelTreeViewFamilyRecord;
  releases: ModelTreeViewRelease[];
}

export interface ModelTreeViewCreator {
  organization: ModelTreeViewOrganization;
  families: ModelTreeViewFamily[];
}

export interface ModelTreeView {
  featured: ModelTreeViewCreator[];
  others: ModelTreeViewCreator[];
}

const VIEW_ORGANIZATION_FIELDS = ['id', 'shortName'] as const;
const VIEW_FAMILY_FIELDS = ['id', 'name'] as const;
const VIEW_RELEASE_FIELDS = [
  'id',
  'slug',
  'displayName',
  'releaseDate',
  'datePrecision',
  'status',
  'accessType',
  'intendedUse',
  'summary',
  'verifiedAt',
] as const;

/**
 * Copy exactly the listed keys, omitting any the record does not carry.
 *
 * Optional fields are omitted rather than emitted as `undefined` because
 * `JSON.stringify` drops an undefined value anyway: writing the key would only
 * make the two representations disagree.
 */
function pickFields<T extends object, K extends keyof T>(record: T, fields: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const field of fields) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

function projectCreators(creators: ModelTreeCreator[]): ModelTreeViewCreator[] {
  return creators.map(({ organization, families }) => ({
    organization: pickFields(organization, VIEW_ORGANIZATION_FIELDS),
    families: families.map(({ family, releases }) => ({
      family: pickFields(family, VIEW_FAMILY_FIELDS),
      releases: releases.map((release) => pickFields(release, VIEW_RELEASE_FIELDS)),
    })),
  }));
}

/** Reduce a built tree to the fields the island renders. Order is preserved. */
export function projectModelTree(tree: ModelTree): ModelTreeView {
  return {
    featured: projectCreators(tree.featured),
    others: projectCreators(tree.others),
  };
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
function modelTreeCreators(tree: ModelTreeView): ModelTreeViewCreator[] {
  return [...tree.featured, ...tree.others];
}

export function findModelTreePath(
  tree: ModelTreeView,
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

export function modelTreeReleaseIds(tree: ModelTreeView) {
  // A creator belongs to exactly one branch, so concatenating the two cannot
  // repeat a release.
  return modelTreeCreators(tree).flatMap(({ families }) => (
    families.flatMap(({ releases }) => releases.map(({ id }) => id))
  ));
}

export function restoreModelTreeSelection(
  tree: ModelTreeView,
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
