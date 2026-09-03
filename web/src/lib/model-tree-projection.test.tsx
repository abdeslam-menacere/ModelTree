import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import LineageModelDrawer, { type DrawerSelection } from '../components/LineageModelDrawer';
import ModelTreeExplorer from '../components/ModelTreeExplorer';
import { dataset } from '../data/dataset';
import { buildModelTree, projectModelTree } from './model-tree';

/**
 * The island payload projection — abdeslam-menacere/ModelTree#813.
 *
 * `/tree` serialises its island props into the page, so every recorded field the
 * components never read is shipped to every visitor. The route sat at 99.0% of
 * its critical-path budget (752,381 of 760,000) with the whole `Organization`,
 * `ModelFamily` and `ModelRelease` records inlined, which put dataset breadth --
 * the point of the site -- behind a payload ceiling rather than behind evidence.
 *
 * The safety property is not "the payload is smaller", which any deletion
 * achieves. It is **the payload is smaller and the surface is unchanged**, so
 * both halves are asserted here, and the second is asserted by rendering rather
 * than by re-listing the field names the components happen to read today. A
 * field list would be a copy of the components that is free to drift from them;
 * markup equality cannot drift, because it fails the moment a projected-away
 * field was one the surface rendered.
 */

const full = buildModelTree(dataset);
const projected = projectModelTree(full);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function findSelection(releaseId: string) {
  const fromTree = <T extends { organization: unknown; families: readonly any[] }>(
    branches: readonly T[],
  ) => {
    for (const { organization, families } of branches) {
      for (const { family, releases } of families) {
        const release = releases.find((item: { id: string }) => item.id === releaseId);
        if (release) return { organization, family, release };
      }
    }
    return undefined;
  };
  return {
    full: fromTree([...full.featured, ...full.others]),
    projected: fromTree([...projected.featured, ...projected.others]),
  };
}

describe('projectModelTree keeps the surface and drops the payload', () => {
  it('renders the explorer byte-identically from the projected tree', () => {
    const fromFullRecords = renderToStaticMarkup(
      <ModelTreeExplorer tree={full} sourceByReleaseId={{}} basePath="/ModelTree/" />,
    );
    const fromProjection = renderToStaticMarkup(
      <ModelTreeExplorer tree={projected} sourceByReleaseId={{}} basePath="/ModelTree/" />,
    );

    // Non-vacuous: an explorer that rendered nothing would compare equal to
    // itself and prove nothing about what the projection kept.
    expect(fromFullRecords.length, 'the explorer should render real markup').toBeGreaterThan(10_000);
    expect(fromProjection).toBe(fromFullRecords);
  });

  it('renders the drawer byte-identically from the projected selection', () => {
    // Every release, not one: the drawer prints `summary`, `intendedUse`,
    // `accessType` and `verifiedAt`, which vary per record, and a single
    // fixture would pass while a field absent from most records was dropped.
    const releaseIds = dataset.releases.map(({ id }) => id);
    expect(releaseIds.length, 'the dataset should carry releases').toBeGreaterThan(0);

    const source = { title: 'Example source', url: 'https://example.com/' };
    let compared = 0;

    for (const releaseId of releaseIds) {
      const { full: fullSelection, projected: projectedSelection } = findSelection(releaseId);
      // A release outside the tree (its creator holds no rendered family) is not
      // selectable, so there is nothing to compare for it.
      if (!fullSelection || !projectedSelection) continue;
      compared += 1;

      const fromFullRecords = renderToStaticMarkup(
        <LineageModelDrawer
          selected={fullSelection as DrawerSelection}
          source={source}
          basePath="/ModelTree/"
        />,
      );
      const fromProjection = renderToStaticMarkup(
        <LineageModelDrawer
          selected={projectedSelection as DrawerSelection}
          source={source}
          basePath="/ModelTree/"
        />,
      );

      expect(fromProjection, `drawer markup changed for ${releaseId}`).toBe(fromFullRecords);
    }

    expect(compared, 'no release was actually compared').toBeGreaterThan(0);
  });

  it('preserves branch membership, order and every release', () => {
    const shape = (branches: { organization: { id: string }; families: { family: { id: string }; releases: { id: string }[] }[] }[]) =>
      branches.map(({ organization, families }) => [
        organization.id,
        families.map(({ family, releases }) => [family.id, releases.map(({ id }) => id)]),
      ]);

    expect(shape(projected.featured)).toEqual(shape(full.featured));
    expect(shape(projected.others)).toEqual(shape(full.others));
  });

  it('ships less than half the bytes, and drops fields the records really carry', () => {
    // Positive control first: "absent from the projection" only means something
    // if the source record carries the field at all.
    const organization = full.featured[0].organization;
    const family = full.featured[0].families[0].family;
    const release = full.featured[0].families[0].releases[0];
    expect(organization.description, 'control: creators record a description').toBeTruthy();
    expect(family.description, 'control: families record a description').toBeTruthy();
    expect(release.sourceIds.length, 'control: releases record sourceIds').toBeGreaterThan(0);

    const projectedOrganization = projected.featured[0].organization;
    const projectedFamily = projected.featured[0].families[0].family;
    const projectedRelease = projected.featured[0].families[0].releases[0];
    expect(Object.keys(projectedOrganization).sort()).toEqual(['id', 'shortName']);
    expect(Object.keys(projectedFamily).sort()).toEqual(['id', 'name']);
    expect(Object.keys(projectedRelease).every((key) => [
      'accessType',
      'datePrecision',
      'displayName',
      'id',
      'intendedUse',
      'releaseDate',
      'slug',
      'status',
      'summary',
      'verifiedAt',
    ].includes(key)), `unexpected release field: ${Object.keys(projectedRelease).join(', ')}`).toBe(true);

    expect(
      bytes(projected) * 2,
      `projected ${bytes(projected)} B vs whole ${bytes(full)} B: the projection stopped paying for itself`,
    ).toBeLessThan(bytes(full));
  });
});
