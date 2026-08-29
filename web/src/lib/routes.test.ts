import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildCatalogIndex } from './catalog';
import { buildLineageEcosystems } from './lineage-view';
import { modelStaticPaths, providerStaticPaths } from './routes';

describe('generated routes', () => {
  it('generates a model page for every release', () => {
    expect(modelStaticPaths().map((path) => path.params.slug).sort())
      .toEqual(dataset.releases.map(({ slug }) => slug).sort());
  });

  it('generates a provider page for every organization that has a release', () => {
    // Derived from the dataset independently of the builder, so this states the
    // rule rather than restating the implementation.
    const expected = [...new Set(dataset.releases.map(({ organizationId }) => organizationId))]
      .map((id) => dataset.organizations.find((organization) => organization.id === id)!.slug)
      .sort();

    expect(providerStaticPaths().map((path) => path.params.slug).sort()).toEqual(expected);
  });

  it('no longer derives that list from the featured flag', () => {
    // Differential control. A page list that still tracked `featured` would pass
    // every assertion above on a catalog where the two sets happened to agree;
    // it cannot pass this one, which requires a creator the site does not lead
    // with to keep its page. Derived rather than named, so it states the rule and
    // does not need editing each time the editorial list changes.
    const featuredSlugs = new Set(
      buildLineageEcosystems(dataset).map((ecosystem) => ecosystem.organization.slug),
    );
    const routedSlugs = providerStaticPaths().map((path) => path.params.slug);
    const notLedWith = [...new Set(dataset.releases.map(({ organizationId }) => organizationId))]
      .map((id) => dataset.organizations.find((organization) => organization.id === id)!.slug)
      .filter((slug) => !featuredSlugs.has(slug));

    // Positive controls: both sets must be populated, or the sweep is vacuous.
    expect(featuredSlugs.size).toBeGreaterThan(0);
    expect(notLedWith.length).toBeGreaterThan(0);
    expect(routedSlugs.length).toBeGreaterThan(featuredSlugs.size);
    for (const slug of notLedWith) {
      expect(routedSlugs, `${slug} still has a page`).toContain(slug);
    }
  });

  it('keeps the catalog index and the generated pages in exact agreement', () => {
    // routes.ts states this invariant in both directions: a row can never
    // advertise a page this list does not generate, and this list can never
    // generate a page no row points at.
    const index = buildCatalogIndex(dataset, '/ModelTree');
    const routedSlugs = providerStaticPaths().map((path) => path.params.slug).sort();
    const advertised = index.providers
      .filter(({ route }) => route !== null)
      .map(({ slug }) => slug)
      .sort();

    expect(advertised).toEqual(routedSlugs);
    for (const provider of index.providers) {
      expect(provider.route === null, `${provider.slug} route nullity`)
        .toBe(!routedSlugs.includes(provider.slug));
    }
  });
});
