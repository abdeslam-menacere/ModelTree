import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { dataset } from '../data/dataset';
import { buildModelTree, modelTreeReleaseIds } from '../lib/model-tree';
import { datasetWithOtherCreators } from '../../tests/fixtures/model-tree-dataset';
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
    for (const releaseId of modelTreeReleaseIds(tree)) {
      const release = dataset.releases.find(({ id }) => id === releaseId)!;
      expect(markup).toContain(`>${release.displayName}</strong>`);
      expect(markup).toContain(`href="/ModelTree/models/${release.slug}/"`);
    }
  });

  it('states the Others branch is empty without implying work in progress', () => {
    // Construct the empty-Others condition rather than borrowing it from the
    // catalog. The empty state is what #435 added, and it must keep rendering
    // whenever Others is genuinely empty -- which stops being true of the live
    // dataset the moment a non-featured creator lands.
    const tree = { ...buildModelTree(dataset), others: [] };
    const markup = renderToStaticMarkup(
      <ModelTreeExplorer tree={tree} sourceByReleaseId={{}} basePath="/ModelTree/" />,
    );
    // Scoped to the Others node: unrelated catalog prose must not be able to
    // fail or pass this assertion.
    const emptyNode = markup.match(/<div class="tree-empty-node">.*?<\/div>/)?.[0];

    expect(tree.others).toEqual([]);
    expect(emptyNode).toBeDefined();
    expect(emptyNode).toContain('<strong>Others</strong>');
    expect(emptyNode).toContain('No non-featured creators in the reviewed catalog');
    for (const phrase of ['waiting', 'ending', 'Coming soon', 'in progress', 'queue', 'soon']) {
      expect(emptyNode).not.toContain(phrase);
    }
    expect(markup).not.toContain('model-tree-other-creators');
  });

  it('renders others creators as real disclosure branches when the data has them', () => {
    const tree = buildModelTree(datasetWithOtherCreators);
    const markup = renderToStaticMarkup(
      <ModelTreeExplorer tree={tree} sourceByReleaseId={{}} basePath="/ModelTree/" />,
    );

    expect(tree.others.length).toBeGreaterThan(0);
    expect(markup).not.toContain('tree-empty-node');
    expect(markup).toContain('aria-expanded="true" aria-controls="model-tree-other-creators"');
    expect(markup).toContain('aria-controls="tree-creator-other-zulu"');
    expect(markup).toContain('aria-controls="tree-family-other-zulu-nova"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('>Nova Alpha</strong>');
    expect(markup).toContain('href="/ModelTree/models/other-zulu-nova-one/"');
    expect(markup).toContain(
      'Passport<span class="visually-hidden"> for Nova Alpha</span>',
    );
    // The dropped empty family never reaches the markup.
    expect(markup).not.toContain('tree-family-other-zulu-void');

    const ids = markup.match(/ id="([^"]+)"/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts with no selected release and a useful prompt', () => {
    const markup = renderToStaticMarkup(
      <ModelTreeExplorer tree={buildModelTree(dataset)} sourceByReleaseId={{}} basePath="/" />,
    );

    expect(markup).toContain('Choose a model release');
    expect(markup).not.toContain('data-selected="true"');
  });
});
