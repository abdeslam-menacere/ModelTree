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

  it('uses codepoint ordering with stable ID and slug tie-breakers', () => {
    const organization = dataset.organizations[0];
    const family = dataset.families.find((candidate) => candidate.organizationId === organization.id)!;
    const release = dataset.releases.find((candidate) => candidate.familyId === family.id)!;
    const hierarchy = buildHomepageHierarchy({
      ...dataset,
      organizations: [
        // The label is what this comparator reads, so it is the label that
        // varies here. `name` is set to a decoy that would order these three
        // differently -- org-lower first -- so the expectation below fails if
        // the sort ever goes back to reading the recorded name.
        { ...organization, id: 'org-lower', name: 'AAA decoy', shortName: 'alpha' },
        { ...organization, id: 'org-z', name: 'ZZZ decoy', shortName: 'Zeta' },
        { ...organization, id: 'org-a', name: 'ZZZ decoy', shortName: 'Zeta' },
      ],
      families: [
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

    expect(hierarchy.map(({ organization: item }) => item.id)).toEqual(['org-a', 'org-z', 'org-lower']);
    expect(hierarchy[0].families.map(({ family: item }) => item.id)).toEqual(['family-a', 'family-z', 'family-lower']);
    expect(hierarchy[0].families[0].releases.map((item) => item.id)).toEqual(['release-a', 'release-z', 'release-lower']);
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