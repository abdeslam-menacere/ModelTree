import { dataset } from '../data/dataset';
import { buildCreatorEcosystems } from './lineage-view';

/**
 * The single list both the model route and the catalog index check read, so an
 * index row can never promise a detail page the build does not generate.
 */
export function modelStaticPaths() {
  return dataset.releases.map((release) => ({
    params: { slug: release.slug },
    props: { releaseId: release.id },
  }));
}

/**
 * The organizations that get a generated provider detail page, and the single
 * list both `/providers/[slug]` and the catalog index check read from.
 *
 * A provider page is generated for every organization the catalog records a
 * release for -- exactly the set `buildCreatorEcosystems` derives, because the
 * page leads with that organization's recorded family tree and an organization
 * with no releases has no tree to lead with. Nothing here reads `featured`: which
 * creators the site leads with is an editorial choice, and changing it must not
 * delete a creator's page, because the page describes what the catalog records
 * about that creator and not our decision about where to lead. Deriving the slugs
 * from the same function the catalog index uses to decide which provider routes
 * to publish is what keeps the two in step: a row can never advertise a page this
 * list does not generate, and this list can never generate a page no row points
 * at.
 */
export function providerStaticPaths() {
  return buildCreatorEcosystems(dataset).map((ecosystem) => ({
    params: { slug: ecosystem.organization.slug },
    props: { organizationId: ecosystem.organization.id },
  }));
}
