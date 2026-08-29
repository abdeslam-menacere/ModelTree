import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildHomepageHierarchy, firstHomepageRelease } from './homepage';

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
      ],
    });

    expect(hierarchy.map(({ organization: item }) => item.id)).toEqual(['org-lower', 'org-a', 'org-z']);
    expect(hierarchy[1].families.map(({ family: item }) => item.id)).toEqual(['family-a', 'family-z', 'family-lower']);
    expect(hierarchy[1].families[0].releases.map((item) => item.id)).toEqual(['release-a', 'release-z', 'release-lower']);
  });

  it('finds the first release when empty organizations and families sort first', () => {
    const organization = dataset.organizations[0];
    const family = dataset.families.find((candidate) => candidate.organizationId === organization.id)!;
    const hierarchy = buildHomepageHierarchy({
      ...dataset,
      organizations: [{ ...organization, id: 'aaa-empty', name: 'A Empty', shortName: 'A Empty' }, ...dataset.organizations],
      families: [{ ...family, id: 'aaa-empty', organizationId: 'aaa-empty', name: 'A Empty' }, ...dataset.families],
    });

    expect(hierarchy[0].families[0].releases).toEqual([]);
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