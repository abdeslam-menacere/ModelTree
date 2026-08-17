import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import {
  buildModelTree,
  findModelTreePath,
  modelTreeReleaseIds,
  restoreModelTreeSelection,
} from './model-tree';

describe('model tree', () => {
  it('includes only creators with a featured release, then every release for those creators once', () => {
    const tree = buildModelTree(dataset);
    const expectedCreatorIds = [...new Set(
      dataset.releases.filter(({ featured }) => featured).map(({ organizationId }) => organizationId),
    )].sort();
    const actualCreatorIds = tree.featured.map(({ organization }) => organization.id).sort();
    const expectedReleaseIds = dataset.releases
      .filter(({ organizationId }) => expectedCreatorIds.includes(organizationId))
      .map(({ id }) => id)
      .sort();
    const actualReleaseIds = modelTreeReleaseIds(tree).sort();

    expect(actualCreatorIds).toEqual(expectedCreatorIds);
    expect(actualReleaseIds).toEqual(expectedReleaseIds);
    expect(new Set(actualReleaseIds).size).toBe(actualReleaseIds.length);
  });

  it('uses deterministic creator/family order and newest-first release order with ID ties', () => {
    const tree = buildModelTree(dataset);

    expect(tree.featured.map(({ organization }) => organization.name)).toEqual(
      [...tree.featured.map(({ organization }) => organization.name)].sort(),
    );
    for (const creator of tree.featured) {
      expect(creator.families.map(({ family }) => family.name)).toEqual(
        [...creator.families.map(({ family }) => family.name)].sort(),
      );
      for (const { releases } of creator.families) {
        const keys = releases.map(({ releaseDate, id }) => `${releaseDate}\0${id}`);
        const expected = [...keys].sort((a, b) => {
          const [aDate, aId] = a.split('\0');
          const [bDate, bId] = b.split('\0');
          return bDate.localeCompare(aDate) || (aId < bId ? -1 : aId > bId ? 1 : 0);
        });
        expect(keys).toEqual(expected);
      }
    }
  });

  it('keeps Others visible and empty and resolves only valid release paths', () => {
    const tree = buildModelTree(dataset);
    const first = tree.featured[0].families[0].releases[0];

    expect(tree.others).toEqual([]);
    expect(findModelTreePath(tree, first.id)).toEqual({
      creatorId: first.organizationId,
      familyId: first.familyId,
      releaseId: first.id,
    });
    expect(findModelTreePath(tree, 'not-a-release')).toBeUndefined();
    expect(findModelTreePath(tree, null)).toBeUndefined();
  });

  it('restores a valid deep link by opening its creator and family only', () => {
    const tree = buildModelTree(dataset);
    const release = tree.featured.at(-1)!.families.at(-1)!.releases.at(-1)!;

    expect(restoreModelTreeSelection(tree, release.id)).toEqual({
      selectedReleaseId: release.id,
      openCreatorIds: [release.organizationId],
      openFamilyIds: [release.familyId],
    });
    expect(restoreModelTreeSelection(tree, 'invalid')).toEqual({
      openCreatorIds: [],
      openFamilyIds: [],
    });
  });
});
