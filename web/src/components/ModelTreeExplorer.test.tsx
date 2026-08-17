import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { dataset } from '../data/dataset';
import { buildModelTree, modelTreeReleaseIds } from '../lib/model-tree';
import ModelTreeExplorer from './ModelTreeExplorer';

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: () => undefined,
}));

describe('ModelTreeExplorer', () => {
  it('server-renders the complete nested hierarchy with accessible disclosures', () => {
    const tree = buildModelTree(dataset);
    const markup = renderToStaticMarkup(
      <ModelTreeExplorer tree={tree} sourceByReleaseId={{}} basePath="/ModelTree/" />,
    );

    expect(markup).toContain('aria-expanded="true" aria-controls="model-tree-root-branches"');
    expect(markup).toContain('aria-expanded="true" aria-controls="model-tree-featured-creators"');
    expect(markup).toContain('>AI Model Ecosystem</span>');
    expect(markup).not.toContain('>Root</span>');
    expect(markup).toContain('Featured ecosystems');
    expect(markup).toContain('Editorially reviewed · not ranked');
    expect(markup).toContain('Others');
    expect(markup).toContain('Awaiting reviewed long-tail records');
    for (const releaseId of modelTreeReleaseIds(tree)) {
      const release = dataset.releases.find(({ id }) => id === releaseId)!;
      expect(markup).toContain(`>${release.displayName}</strong>`);
      expect(markup).toContain(`href="/ModelTree/models/${release.slug}/"`);
    }
  });

  it('starts with no selected release and a useful prompt', () => {
    const markup = renderToStaticMarkup(
      <ModelTreeExplorer tree={buildModelTree(dataset)} sourceByReleaseId={{}} basePath="/" />,
    );

    expect(markup).toContain('Choose a model release');
    expect(markup).not.toContain('data-selected="true"');
  });
});
