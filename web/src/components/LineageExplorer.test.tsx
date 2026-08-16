import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { buildHomepageHierarchy } from '../lib/homepage';
import LineageExplorer from './LineageExplorer';

describe('LineageExplorer', () => {
  it('renders every organization, family, and release with a passport route', () => {
    const sourceByReleaseId = Object.fromEntries(dataset.releases.map((release) => [
      release.id,
      { title: release.id, url: `https://example.com/${release.id}` },
    ]));
    const markup = renderToStaticMarkup(
      <LineageExplorer
        hierarchy={buildHomepageHierarchy(dataset)}
        sourceByReleaseId={sourceByReleaseId}
        basePath="/catalog/"
      />,
    );

    for (const organization of dataset.organizations) {
      expect(markup).toContain(`>${organization.name}<`);
    }
    for (const family of dataset.families) {
      expect(markup).toContain(`>${family.name}<`);
    }
    for (const release of dataset.releases) {
      expect(markup).toContain(`>${release.displayName}<`);
      expect(markup).toContain(`href="/catalog/models/${release.slug}/"`);
    }
  });
});