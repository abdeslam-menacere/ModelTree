import type { Organization } from '../data/schema';
import { organizationLabel } from './organization-name';
import { SITE_NAME } from './seo';

/**
 * schema.org structured data (JSON-LD), built only from recorded, sourced fields.
 *
 * The discipline here is the same one the rest of the repository applies to prose:
 * a field is emitted only when a recorded value backs it, and anything that would
 * require asserting an unrecorded fact is omitted rather than filled. That is why
 * there are no ratings, rankings, scores, or superlatives anywhere below, and no
 * `SearchAction` on the site (there is no query endpoint, so advertising one would
 * be a false capability) and no `Article` on model or provider pages (they are not
 * articles, and emitting one would invent an author and a publication date the
 * data does not hold). Every builder returns a plain object the caller serializes
 * into a `<script type="application/ld+json">`.
 */

export const SCHEMA_ORG_CONTEXT = 'https://schema.org';

export interface JsonLd {
  '@context': string;
  '@type': string;
  [key: string]: unknown;
}

/** The site itself: name, canonical URL, and its one-line description. */
export function buildWebsiteJsonLd(input: { url: string; description: string }): JsonLd {
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'WebSite',
    name: SITE_NAME,
    url: input.url,
    description: input.description,
  };
}

/** ModelTree as the dataset it is: a curated, source-backed record of AI model lineage. */
export function buildDatasetJsonLd(input: {
  url: string;
  name: string;
  description: string;
}): JsonLd {
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'Dataset',
    name: input.name,
    description: input.description,
    url: input.url,
  };
}

/**
 * A creator organization, from its recorded identity fields. `name` is the label
 * the rest of the site files the creator under; `url` and `sameAs` are the
 * organization's own recorded surfaces; `description` is its recorded summary. No
 * field here is derived or ranked.
 */
export function buildOrganizationJsonLd(organization: Organization): JsonLd {
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'Organization',
    name: organizationLabel(organization),
    url: organization.website,
    description: organization.description,
    sameAs: [organization.releasePage],
  };
}

/** One crumb in a breadcrumb trail: a visible name and the absolute URL it points at. */
export interface BreadcrumbItem {
  name: string;
  url: string;
}

/** A navigational breadcrumb trail, positions assigned in the order given. */
export function buildBreadcrumbJsonLd(items: BreadcrumbItem[]): JsonLd {
  return {
    '@context': SCHEMA_ORG_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
