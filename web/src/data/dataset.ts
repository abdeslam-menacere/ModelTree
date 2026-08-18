import { rawDataset } from './raw';
import { validateDataset } from './validate';

export const dataset = validateDataset(rawDataset);

export const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));
export const publisherById = new Map(
  dataset.publishers.map((publisher) => [publisher.id, publisher]),
);
export const organizationById = new Map(
  dataset.organizations.map((organization) => [organization.id, organization]),
);
export const familyById = new Map(dataset.families.map((family) => [family.id, family]));
export const releaseById = new Map(dataset.releases.map((release) => [release.id, release]));
export const releaseBySlug = new Map(dataset.releases.map((release) => [release.slug, release]));