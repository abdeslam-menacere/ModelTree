import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import { buildLineageEcosystems } from './lineage-view';
import {
  buildProviderProfile,
  productRelationshipLabel,
  releaseEventTypeLabel,
} from './provider-profile';
import {
  providerProfileFixtureDataset as fixture,
  PRIME_ORG_ID,
  SPARE_ORG_ID,
  HUB_ORG_ID,
  PRIME_CURRENT_RELEASE_ID,
  PRIME_LEGACY_RELEASE_ID,
  FIXED_PRODUCT_ID,
  ROUTED_PRODUCT_ID,
  UNKNOWN_PRODUCT_ID,
  FIRST_PARTY_PLATFORM_ID,
  THIRD_PARTY_PLATFORM_ID,
} from '../../tests/fixtures/provider-profile-dataset';

describe('buildProviderProfile against a controlled dataset', () => {
  it('returns undefined for an organization the dataset does not hold', () => {
    expect(buildProviderProfile(fixture, 'not-an-org')).toBeUndefined();
  });

  it('describes the whole organization, not only its featured releases', () => {
    const profile = buildProviderProfile(fixture, PRIME_ORG_ID);
    expect(profile).toBeDefined();
    const view = profile!;

    // Neither fixture release is featured, so a builder that read `featured`
    // would show an empty page here. Both must still appear.
    expect(fixture.releases.filter((r) => r.organizationId === PRIME_ORG_ID)
      .every((r) => r.featured === false)).toBe(true);
    expect(view.releaseCount).toBe(2);
    expect(view.familyCount).toBe(1);
  });

  it('orders releases newest first with a stable id tiebreak', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID)!;
    expect(view.releases.map((row) => row.release.id))
      .toEqual([PRIME_CURRENT_RELEASE_ID, PRIME_LEGACY_RELEASE_ID]);
  });

  it('reports lifecycle statuses present in the schema enum order', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID)!;
    // current before legacy, the schema's own order, regardless of release date.
    expect(view.statusesPresent).toEqual(['current', 'legacy']);
  });

  it('builds a model route for each release row under the given base', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID, '/ModelTree')!;
    expect(view.releases[0].route).toBe(`/ModelTree/models/${PRIME_CURRENT_RELEASE_ID}/`);
  });

  it('states each product\'s model relationship without collapsing routed into fixed', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID)!;
    const byId = new Map(view.products.map((p) => [p.product.id, p]));

    expect(byId.get(FIXED_PRODUCT_ID)!.relationshipLabel).toBe('Names specific models');
    expect(byId.get(FIXED_PRODUCT_ID)!.namedReleases.map((r) => r.id))
      .toEqual([PRIME_CURRENT_RELEASE_ID]);

    expect(byId.get(ROUTED_PRODUCT_ID)!.relationshipLabel).toBe('Routes across models');
    expect(byId.get(ROUTED_PRODUCT_ID)!.namedReleases).toHaveLength(2);

    expect(byId.get(UNKNOWN_PRODUCT_ID)!.relationshipLabel).toBe('Model selection not disclosed');
    expect(byId.get(UNKNOWN_PRODUCT_ID)!.namedReleases).toHaveLength(0);
  });

  it('resolves a product\'s named releases to a display name and a route', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID, '/ModelTree')!;
    const named = view.products.find((p) => p.product.id === FIXED_PRODUCT_ID)!.namedReleases[0];
    expect(named.name).toBe('Prime Core V2');
    expect(named.route).toBe(`/ModelTree/models/${PRIME_CURRENT_RELEASE_ID}/`);
  });

  it('labels a first-party platform and a third-party one distinctly', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID)!;
    const byId = new Map(view.servingPlatforms.map((p) => [p.platform.id, p]));

    const firstParty = byId.get(FIRST_PARTY_PLATFORM_ID)!;
    expect(firstParty.operatedByProvider).toBe(true);
    expect(firstParty.operatorName).toBe('Prime Labs');
    expect(firstParty.relationshipLabel).toContain('First-party');
    expect(firstParty.servedReleaseCount).toBe(1);

    const thirdParty = byId.get(THIRD_PARTY_PLATFORM_ID)!;
    expect(thirdParty.operatedByProvider).toBe(false);
    expect(thirdParty.operatorName).toBe('Open Hub');
    expect(thirdParty.relationshipLabel).toContain('Third-party');
    // Two distinct releases are deployed there; the count is releases, not rows.
    expect(thirdParty.servedReleaseCount).toBe(2);
  });

  it('keeps the creator and the platform it operates as separate roles', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID)!;
    expect(view.operatesServingPlatform).toBe(true);
    // The operated platform is still a serving platform with its own operator
    // label, never merged into the creator entity.
    const operated = view.servingPlatforms.find((p) => p.platform.id === FIRST_PARTY_PLATFORM_ID)!;
    expect(operated.platform.organizationId).toBe(PRIME_ORG_ID);
    expect(operated.operatedByProvider).toBe(true);
  });

  it('orders recent changes newest first and links each to its release and sources', () => {
    const view = buildProviderProfile(fixture, PRIME_ORG_ID, '/ModelTree')!;
    expect(view.recentChanges.map((c) => c.event.date))
      .toEqual(['2025-06-15', '2025-06-01', '2025-01-01']);
    const latest = view.recentChanges[0];
    expect(latest.typeLabel).toBe('Generally available');
    expect(latest.releaseRoute).toBe(`/ModelTree/models/${PRIME_CURRENT_RELEASE_ID}/`);
    expect(latest.sources.length).toBeGreaterThan(0);
  });

  it('leaves every optional section empty for a creator that has no such records', () => {
    const view = buildProviderProfile(fixture, SPARE_ORG_ID)!;
    expect(view.releaseCount).toBe(1);
    expect(view.products).toHaveLength(0);
    expect(view.servingPlatforms).toHaveLength(0);
    expect(view.recentChanges).toHaveLength(0);
    expect(view.operatesServingPlatform).toBe(false);
  });

  it('surfaces a platform operator even when the operator publishes no models', () => {
    // Open Hub operates a platform but has no releases of its own. Its profile is
    // still buildable, and it lists the platform it operates.
    const view = buildProviderProfile(fixture, HUB_ORG_ID)!;
    expect(view.releaseCount).toBe(0);
    expect(view.operatesServingPlatform).toBe(true);
    expect(view.servingPlatforms.map((p) => p.platform.id)).toContain(THIRD_PARTY_PLATFORM_ID);
  });
});

describe('label maps stay total over the schema enums', () => {
  it('names every product model-selection mode', () => {
    for (const selection of ['fixed', 'routed', 'unknown'] as const) {
      expect(productRelationshipLabel(selection).length).toBeGreaterThan(0);
    }
  });

  it('names every release-event type', () => {
    const types = [
      'announced', 'preview', 'api-available', 'generally-available',
      'deprecated', 'retired', 'corrected',
    ] as const;
    for (const type of types) {
      expect(releaseEventTypeLabel(type).length).toBeGreaterThan(0);
    }
  });
});

describe('buildProviderProfile over the real seed dataset', () => {
  const featuredSlugs = buildLineageEcosystems(seedDataset).map((e) => e.organization.slug);

  it('has at least one featured organization to profile', () => {
    // Positive control: an empty catalog would make the sweep below vacuous.
    expect(featuredSlugs.length).toBeGreaterThan(0);
  });

  it('builds a profile for every featured organization the site generates a page for', () => {
    for (const ecosystem of buildLineageEcosystems(seedDataset)) {
      const profile = buildProviderProfile(seedDataset, ecosystem.organization.id, '/ModelTree');
      expect(profile, `profile for ${ecosystem.organization.id}`).toBeDefined();
      // Every featured organization has at least one release to lead with.
      expect(profile!.releaseCount).toBeGreaterThan(0);
      // Sources are the organization's own, resolved from ids.
      expect(profile!.sources.length).toBeGreaterThan(0);
    }
  });

  it('never invents a product, platform or change the seed does not record', () => {
    // The seed currently carries none of these; the profile must not synthesise
    // them. If a refresh adds them, this stays true by construction because the
    // builder only ever maps existing records.
    for (const ecosystem of buildLineageEcosystems(seedDataset)) {
      const view = buildProviderProfile(seedDataset, ecosystem.organization.id)!;
      expect(view.products.length).toBe(
        seedDataset.products.filter((p) => p.organizationId === ecosystem.organization.id).length,
      );
      expect(view.recentChanges.length).toBe(
        seedDataset.releaseEvents.filter((event) => {
          const release = seedDataset.releases.find((r) => r.id === event.releaseId);
          return release?.organizationId === ecosystem.organization.id;
        }).length,
      );
    }
  });
});
