import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import {
  buildBreadcrumbJsonLd,
  buildDatasetJsonLd,
  buildOrganizationJsonLd,
  buildWebsiteJsonLd,
  SCHEMA_ORG_CONTEXT,
} from './structured-data';

/**
 * Keys that would encode a rating, ranking, score, or review. This repository
 * emits none of them anywhere, and JSON-LD is the worst place to start: a machine
 * consumes it as a claim. Every builder's output is walked for these.
 */
const FORBIDDEN_KEY = /rating|ranking|score|review|aggregate|best|top|popular/i;

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
  }
  return [];
}

const anOrganization = dataset.organizations[0];

describe('every builder', () => {
  const objects = [
    buildWebsiteJsonLd({ url: 'https://example.test/ModelTree/', description: 'A description.' }),
    buildDatasetJsonLd({
      url: 'https://example.test/ModelTree/',
      name: 'ModelTree',
      description: 'A description.',
    }),
    buildOrganizationJsonLd(anOrganization),
    buildBreadcrumbJsonLd([{ name: 'Home', url: 'https://example.test/ModelTree/' }]),
  ];

  it('sets the schema.org context on every object', () => {
    for (const object of objects) {
      expect(object['@context']).toBe(SCHEMA_ORG_CONTEXT);
    }
  });

  it('emits no rating, ranking, score, or review field anywhere', () => {
    for (const object of objects) {
      const offending = keysOf(object).filter((key) => FORBIDDEN_KEY.test(key));
      expect(offending, `unexpected evaluative key in ${object['@type']}`).toEqual([]);
    }
  });

  it('serializes to JSON without throwing', () => {
    for (const object of objects) {
      expect(() => JSON.stringify(object)).not.toThrow();
    }
  });
});

describe('buildWebsiteJsonLd', () => {
  it('is a WebSite named ModelTree with no SearchAction', () => {
    const website = buildWebsiteJsonLd({ url: 'https://example.test/', description: 'D.' });
    expect(website['@type']).toBe('WebSite');
    expect(website.name).toBe('ModelTree');
    expect(website).not.toHaveProperty('potentialAction');
  });
});

describe('buildOrganizationJsonLd', () => {
  it('carries the recorded label, website, description, and release page as sameAs', () => {
    const jsonLd = buildOrganizationJsonLd(anOrganization);
    expect(jsonLd['@type']).toBe('Organization');
    expect(jsonLd.name).toBe(anOrganization.shortName);
    expect(jsonLd.url).toBe(anOrganization.website);
    expect(jsonLd.description).toBe(anOrganization.description);
    expect(jsonLd.sameAs).toEqual([anOrganization.releasePage]);
  });
});

describe('buildBreadcrumbJsonLd', () => {
  it('assigns 1-based positions in order', () => {
    const crumb = buildBreadcrumbJsonLd([
      { name: 'Home', url: 'https://example.test/' },
      { name: 'Models', url: 'https://example.test/models/' },
      { name: 'GPT', url: 'https://example.test/models/gpt/' },
    ]);
    expect(crumb['@type']).toBe('BreadcrumbList');
    expect(crumb.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.test/' },
      { '@type': 'ListItem', position: 2, name: 'Models', item: 'https://example.test/models/' },
      { '@type': 'ListItem', position: 3, name: 'GPT', item: 'https://example.test/models/gpt/' },
    ]);
  });
});
