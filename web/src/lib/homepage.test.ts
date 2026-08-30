import { describe, expect, it } from 'vitest';
import { datasetWithOtherCreators } from '../../tests/fixtures/model-tree-dataset';
import { dataset } from '../data/dataset';
import { buildHomepageHierarchy, firstHomepageRelease } from './homepage';
import { buildModelTree } from './model-tree';

function hierarchyIds() {
  return buildHomepageHierarchy(dataset).map(({ organization, families }) => ({
    organization: organization.id,
    families: families.map(({ family, releases }) => ({
      family: family.id,
      releases: releases.map((release) => release.id),
    })),
  }));
}

describe('homepage hierarchy', () => {
  it('includes every validated record under its organization and family', () => {
    const hierarchy = buildHomepageHierarchy(dataset);

    expect(hierarchy).toHaveLength(dataset.organizations.length);
    expect(hierarchy.flatMap(({ families }) => families)).toHaveLength(dataset.families.length);
    expect(hierarchy.flatMap(({ families }) => families.flatMap(({ releases }) => releases)))
      .toHaveLength(dataset.releases.length);

    for (const { organization, families } of hierarchy) {
      expect(families.every(({ family }) => family.organizationId === organization.id)).toBe(true);
      for (const { family, releases } of families) {
        expect(releases.every((release) => release.familyId === family.id)).toBe(true);
      }
    }
  });

  it('is codepoint-sorted and independent of source record order', () => {
    const reversed = {
      ...dataset,
      organizations: [...dataset.organizations].reverse(),
      families: [...dataset.families].reverse(),
      releases: [...dataset.releases].reverse(),
    };

    expect(buildHomepageHierarchy(reversed).map(({ organization, families }) => ({
      organization: organization.id,
      families: families.map(({ family, releases }) => ({
        family: family.id,
        releases: releases.map((release) => release.id),
      })),
    }))).toEqual(hierarchyIds());
  });

  it('orders creators case-insensitively, families and releases by codepoint, with stable ID and slug tie-breakers', () => {
    const organization = dataset.organizations[0];
    const family = dataset.families.find((candidate) => candidate.organizationId === organization.id)!;
    const release = dataset.releases.find((candidate) => candidate.familyId === family.id)!;
    const hierarchy = buildHomepageHierarchy({
      ...dataset,
      organizations: [
        // Two variables at once, and this fixture separates them. The label is
        // what the comparator reads, so it is the label that varies; `name` is
        // a decoy ordering these three the other way round, so the expectation
        // fails if the sort goes back to reading the recorded name. And because
        // `alpha` is lowercase, it also fails if the comparator goes back to
        // comparing code units, which would put `Zeta` first. Both regressions
        // are caught here; which one it was is named by the tests in
        // `organization-name.test.ts` and `model-tree.test.ts`.
        { ...organization, id: 'org-lower', name: 'ZZZ decoy', shortName: 'alpha' },
        { ...organization, id: 'org-z', name: 'AAA decoy', shortName: 'Zeta' },
        { ...organization, id: 'org-a', name: 'AAA decoy', shortName: 'Zeta' },
      ],
      families: [
        // Family and release ordering is not the creator label rule and stays
        // codepoint-ordered: `Beta` before `beta`. That this still holds is the
        // evidence the creator change was scoped to creators.
        { ...family, id: 'family-lower', organizationId: 'org-a', name: 'beta' },
        { ...family, id: 'family-z', organizationId: 'org-a', name: 'Beta' },
        { ...family, id: 'family-a', organizationId: 'org-a', name: 'Beta' },
      ],
      releases: [
        { ...release, id: 'release-lower', familyId: 'family-a', displayName: 'gamma', slug: 'gamma' },
        { ...release, id: 'release-z', familyId: 'family-a', displayName: 'Gamma', slug: 'gamma-z' },
        { ...release, id: 'release-a', familyId: 'family-a', displayName: 'Gamma', slug: 'gamma-a' },
        // One release each, so the ordering fixture survives the empty-family
        // filter (#554) and this test keeps measuring order rather than
        // membership. They sit in the other two families, so `family-a`'s three
        // releases above still carry the release-ordering assertion alone.
        { ...release, id: 'release-fz', familyId: 'family-z', displayName: 'Delta', slug: 'delta-z' },
        { ...release, id: 'release-fl', familyId: 'family-lower', displayName: 'Delta', slug: 'delta-l' },
      ],
    });

    expect(hierarchy.map(({ organization: item }) => item.id)).toEqual(['org-lower', 'org-a', 'org-z']);
    expect(hierarchy[1].families.map(({ family: item }) => item.id)).toEqual(['family-a', 'family-z', 'family-lower']);
    expect(hierarchy[1].families[0].releases.map((item) => item.id)).toEqual(['release-a', 'release-z', 'release-lower']);
  });

  it('drops a family with no releases, exactly as the model tree does', () => {
    // The #554 defect. `buildModelTree` filtered a family holding no releases
    // out of `/tree/`; this builder did not, so the homepage's `<noscript>`
    // hierarchy rendered `other-zulu-void` as a heading above an empty list
    // while `/tree/` showed nothing. One page hid the data error and the other
    // published it.
    //
    // Asserted as agreement between the two builders rather than as a fixed
    // list, because the defect was a disagreement and a fixed list on one side
    // cannot see it.
    const empty = buildHomepageHierarchy(datasetWithOtherCreators)
      .flatMap(({ families }) => families)
      .filter(({ releases }) => releases.length === 0);

    expect(empty).toEqual([]);

    const homepageFamilyIds = buildHomepageHierarchy(datasetWithOtherCreators)
      .flatMap(({ families }) => families.map(({ family }) => family.id))
      .sort();
    const tree = buildModelTree(datasetWithOtherCreators);
    const treeFamilyIds = [...tree.featured, ...tree.others]
      .flatMap(({ families }) => families.map(({ family }) => family.id))
      .sort();

    expect(homepageFamilyIds).not.toContain('other-zulu-void');
    expect(treeFamilyIds).not.toContain('other-zulu-void');
    expect(homepageFamilyIds).toEqual(treeFamilyIds);
  });

  it('has an empty family to drop and populated siblings to keep, so the assertions above discriminate', () => {
    // The control for the test above, and it shares that test's failure mode:
    // both read family membership out of the same fixture. A fixture holding no
    // empty family would satisfy every assertion there while proving nothing —
    // `not.toContain` passes trivially on an id that was never a candidate, and
    // two hierarchies that drop nothing agree by default.
    const emptyInFixture = datasetWithOtherCreators.families.filter(
      ({ id }) => !datasetWithOtherCreators.releases.some((release) => release.familyId === id),
    );

    expect(emptyInFixture.map(({ id }) => id)).toEqual(['other-zulu-void']);

    // And the builders must still keep that family's populated siblings, or
    // "drops the empty one" would be indistinguishable from "drops the lot".
    const zulu = buildHomepageHierarchy(datasetWithOtherCreators)
      .find(({ organization }) => organization.id === 'other-zulu')!;

    expect(zulu.families.map(({ family }) => family.id).sort())
      .toEqual(['other-zulu-atlas', 'other-zulu-nova', 'other-zulu-orion']);
  });

  it('renders one branch per family the page counts, because the validator refuses an empty one', () => {
    // #554 AC2: the homepage prints `dataset.families.length` in its coverage
    // list and again through `buildCoverageStats`, while this builder renders
    // only the families that hold releases. Those two agree only while every
    // family holds a release, which is what `validateDataset` now enforces —
    // see `it('refuses a family that no release belongs to')` in
    // `src/data/validate.test.ts`.
    //
    // So filtering alone could not have settled this issue: it would have
    // traded a hollow branch for a printed count that overstates the page by
    // one. The two halves of the fix are load-bearing together.
    const rendered = buildHomepageHierarchy(dataset).flatMap(({ families }) => families);

    expect(rendered.length).toBe(dataset.families.length);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('finds the first release when empty organizations sort first', () => {
    const organization = dataset.organizations[0];
    const hierarchy = buildHomepageHierarchy({
      ...dataset,
      organizations: [{ ...organization, id: 'aaa-empty', name: 'A Empty', shortName: 'A Empty' }, ...dataset.organizations],
    });

    expect(hierarchy[0].families).toEqual([]);
    expect(firstHomepageRelease(hierarchy).id).toBe(hierarchy[1].families[0].releases[0].id);
  });

  it('includes a validated organization with no families', () => {
    const organization = dataset.organizations[0];
    const familylessOrganization = { ...organization, id: 'familyless', name: 'Familyless' };
    const hierarchy = buildHomepageHierarchy({
      ...dataset,
      organizations: [...dataset.organizations, familylessOrganization],
    });

    expect(hierarchy.find(({ organization: item }) => item.id === familylessOrganization.id)).toEqual({
      organization: familylessOrganization,
      families: [],
    });
  });
});