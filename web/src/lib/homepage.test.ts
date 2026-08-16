import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildHomepageHierarchy } from './homepage';

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
});