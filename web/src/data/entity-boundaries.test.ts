import { describe, expect, it } from 'vitest';
import { rawDataset } from './raw';
import { validateDataset } from './validate';

/**
 * Creator, model family, product and serving platform are four separate entities.
 * These tests hold that separation down on the shipped data rather than on a
 * fixture, because the ways it collapses are specific and real: a product named
 * after its vendor being read as a model line, a cloud that serves a model being
 * read as its creator, a model hub being read as a family.
 *
 * Every test that could pass by describing an empty set carries a positive
 * control, so an accidentally emptied dataset fails here instead of going quiet.
 */
const dataset = validateDataset(structuredClone(rawDataset));

const releaseById = new Map(dataset.releases.map((release) => [release.id, release]));
const familyIds = new Set(dataset.families.map((family) => family.id));
const organizationIds = new Set(dataset.organizations.map((organization) => organization.id));

describe('the four entity kinds stay separate', () => {
  it('keeps products out of the family, release and organization namespaces', () => {
    expect(dataset.products.length).toBeGreaterThan(0);

    for (const product of dataset.products) {
      expect(familyIds.has(product.id)).toBe(false);
      expect(releaseById.has(product.id)).toBe(false);
      // A product is shipped *by* an organization; it is never one itself.
      expect(organizationIds.has(product.id)).toBe(false);
      expect(organizationIds.has(product.organizationId)).toBe(true);
    }
  });

  it('keeps serving platforms out of the family and release namespaces', () => {
    expect(dataset.servingPlatforms.length).toBeGreaterThan(0);

    for (const platform of dataset.servingPlatforms) {
      expect(familyIds.has(platform.id)).toBe(false);
      expect(releaseById.has(platform.id)).toBe(false);
      expect(organizationIds.has(platform.organizationId)).toBe(true);
    }
  });

  it('never lets operating a serving platform imply creating what it serves', () => {
    const platformById = new Map(
      dataset.servingPlatforms.map((platform) => [platform.id, platform]),
    );

    // Positive control: the rule is only under test if some platform actually
    // serves a release its operator did not create. That configuration is the
    // whole point — availability is not ownership.
    const crossCreator = dataset.deployments.filter((deployment) => {
      const platform = platformById.get(deployment.platformId);
      const release = releaseById.get(deployment.releaseId);
      return platform && release && platform.organizationId !== release.organizationId;
    });
    expect(crossCreator.length).toBeGreaterThan(0);

    for (const deployment of crossCreator) {
      const platform = platformById.get(deployment.platformId)!;
      const release = releaseById.get(deployment.releaseId)!;
      const family = dataset.families.find((candidate) => candidate.id === release.familyId);

      // The deployment records where the model is reached. Creation stays with
      // the creator on the release and on its family alike.
      expect(release.organizationId).not.toBe(platform.organizationId);
      expect(family?.organizationId).toBe(release.organizationId);
    }
  });

  it('attributes Qwen to Alibaba Cloud even though Amazon serves it', () => {
    const qwen = dataset.releases.find((release) => release.id === 'alibaba-qwen3-8-27b');
    expect(qwen?.organizationId).toBe('alibaba-cloud');

    const servingIt = dataset.deployments.filter(
      (deployment) => deployment.releaseId === 'alibaba-qwen3-8-27b',
    );
    expect(servingIt.length).toBeGreaterThan(0);

    // Served on a platform operated by someone else, and still not theirs.
    const operators = servingIt.map(
      (deployment) =>
        dataset.servingPlatforms.find((platform) => platform.id === deployment.platformId)
          ?.organizationId,
    );
    expect(operators).toContain('amazon');
    expect(operators).not.toContain('alibaba-cloud');
    expect(qwen?.organizationId).toBe('alibaba-cloud');
  });

  it('records Microsoft Copilot as a product with no model family standing in for it', () => {
    const copilot = dataset.products.find((product) => product.id === 'microsoft-copilot');
    expect(copilot).toBeDefined();
    expect(copilot?.organizationId).toBe('microsoft');

    // No family or release is named after the product, which is the collapse
    // this record exists to prevent.
    const namedFamilies = dataset.families.filter((family) => /copilot/i.test(family.name));
    const namedReleases = dataset.releases.filter((release) =>
      /copilot/i.test(release.displayName) || /copilot/i.test(release.canonicalName),
    );
    expect(namedFamilies).toEqual([]);
    expect(namedReleases).toEqual([]);
  });

  it('states model selection rather than guessing a backing model', () => {
    for (const product of dataset.products) {
      // A product may route across models without naming one. When routing is
      // undisclosed the record has to say so, and must not imply a model by
      // pointing at releases anyway.
      if (product.modelSelection === 'unknown') {
        expect(product.releaseIds).toEqual([]);
        expect(product.availabilityNotes).toBeTruthy();
      }
      for (const releaseId of product.releaseIds) {
        expect(releaseById.has(releaseId)).toBe(true);
      }
    }
  });

  it('gives every product, platform and deployment a source and a verification date', () => {
    const sourceIds = new Set(dataset.sources.map((source) => source.id));
    const records = [
      ...dataset.products,
      ...dataset.servingPlatforms,
      ...dataset.deployments,
      ...dataset.releaseEvents,
    ];
    expect(records.length).toBeGreaterThan(0);

    for (const record of records) {
      expect(record.sourceIds.length).toBeGreaterThan(0);
      for (const sourceId of record.sourceIds) expect(sourceIds.has(sourceId)).toBe(true);
      expect(record.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
