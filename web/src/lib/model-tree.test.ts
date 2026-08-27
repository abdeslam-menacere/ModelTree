import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { datasetWithOtherCreators, expectedOtherCreatorIds } from './model-tree-fixture';
import {
  buildModelTree,
  findModelTreePath,
  modelTreeReleaseIds,
  restoreModelTreeSelection,
  toggleModelTreeBranch,
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

  it('orders creators deterministically and families/releases newest first with ID ties', () => {
    const tree = buildModelTree(dataset);

    expect(tree.featured.map(({ organization }) => organization.name)).toEqual(
      [...tree.featured.map(({ organization }) => organization.name)].sort(),
    );
    for (const creator of tree.featured) {
      const familyKeys = creator.families.map(({ family, releases }) => ({
        id: family.id,
        newestReleaseDate: releases[0].releaseDate,
      }));
      expect(familyKeys).toEqual([...familyKeys].sort((a, b) => (
        b.newestReleaseDate < a.newestReleaseDate
          ? -1
          : b.newestReleaseDate > a.newestReleaseDate
            ? 1
            : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      )));
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

    const anthropic = tree.featured.find(({ organization }) => organization.id === 'anthropic')!;
    expect(anthropic.families.map(({ family }) => family.name)).toEqual([
      'Claude 5',
      'Claude 4.5',
    ]);
  });

  it('keeps Others empty when every catalog creator has a featured release', () => {
    const tree = buildModelTree(dataset);
    const first = tree.featured[0].families[0].releases[0];

    expect(dataset.organizations.every(({ id }) => (
      dataset.releases.some((release) => release.organizationId === id && release.featured)
    ))).toBe(true);
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

  it('toggles disclosures independently so multiple branches can remain open', () => {
    const withFirst = toggleModelTreeBranch(new Set<string>(), 'first');
    const withBoth = toggleModelTreeBranch(withFirst, 'second');
    const withoutFirst = toggleModelTreeBranch(withBoth, 'first');

    expect([...withBoth]).toEqual(['first', 'second']);
    expect([...withoutFirst]).toEqual(['second']);
  });
});

describe('model tree Others branch', () => {
  const tree = buildModelTree(datasetWithOtherCreators);

  it('collects every creator that has releases but no featured release', () => {
    const expected = datasetWithOtherCreators.organizations
      .filter(({ id }) => (
        datasetWithOtherCreators.releases.some((release) => release.organizationId === id)
        && !datasetWithOtherCreators.releases.some(
          (release) => release.organizationId === id && release.featured,
        )
      ))
      .map(({ id }) => id)
      .sort();

    expect(tree.others.map(({ organization }) => organization.id).sort()).toEqual(expected);
    expect(tree.others.length).toBeGreaterThan(0);
  });

  it('places every creator in exactly one branch and keeps featured creators whole', () => {
    const featuredIds = tree.featured.map(({ organization }) => organization.id);
    const otherIds = tree.others.map(({ organization }) => organization.id);

    expect(otherIds.filter((id) => featuredIds.includes(id))).toEqual([]);
    // OpenAI carries non-featured releases; they stay with their featured creator.
    const openai = tree.featured.find(({ organization }) => organization.id === 'openai')!;
    const openaiReleaseIds = openai.families.flatMap(({ releases }) => releases.map(({ id }) => id));
    const nonFeatured = datasetWithOtherCreators.releases
      .filter(({ organizationId, featured }) => organizationId === 'openai' && !featured);

    expect(nonFeatured.length).toBeGreaterThan(0);
    for (const release of nonFeatured) expect(openaiReleaseIds).toContain(release.id);
  });

  it('orders others by creator name then id, families and releases newest first', () => {
    expect(tree.others.map(({ organization }) => organization.id)).toEqual(expectedOtherCreatorIds);

    const zulu = tree.others.find(({ organization }) => organization.id === 'other-zulu')!;

    // other-zulu-void holds no releases and is dropped rather than rendered.
    expect(zulu.families.map(({ family }) => family.id)).toEqual([
      'other-zulu-nova',
      'other-zulu-atlas',
      'other-zulu-orion',
    ]);
    expect(zulu.families[0].releases.map(({ id }) => id)).toEqual([
      'other-zulu-nova-one',
      'other-zulu-nova-two',
      'other-zulu-nova-old',
    ]);
  });

  it('reports release ids from both branches exactly once', () => {
    const ids = modelTreeReleaseIds(tree);
    const featuredIds = tree.featured.flatMap(({ families }) => (
      families.flatMap(({ releases }) => releases.map(({ id }) => id))
    ));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('other-zulu-nova-one');
    expect(ids).toContain('other-alpha-core-one');
    expect(ids.length).toBe(featuredIds.length + 7);
    expect(ids).toEqual(expect.arrayContaining(featuredIds));
  });

  it('resolves and restores a deep link to a release under others', () => {
    expect(findModelTreePath(tree, 'other-zulu-atlas-one')).toEqual({
      creatorId: 'other-zulu',
      familyId: 'other-zulu-atlas',
      releaseId: 'other-zulu-atlas-one',
    });
    expect(restoreModelTreeSelection(tree, 'other-zulu-atlas-one')).toEqual({
      selectedReleaseId: 'other-zulu-atlas-one',
      openCreatorIds: ['other-zulu'],
      openFamilyIds: ['other-zulu-atlas'],
    });
  });
});
