import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataset } from '../data/dataset';
import { buildHomepageHierarchy } from '../lib/homepage';
import LineageExplorer from './LineageExplorer';

const hookState = vi.hoisted(() => ({ selectedSlug: undefined as string | undefined }));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  startTransition: (callback: () => void) => callback(),
  useEffect: () => undefined,
  useRef: <T,>(initialValue: T) => ({ current: initialValue }),
  useState: <T,>(initialValue: T) => [
    (hookState.selectedSlug ?? initialValue) as T,
    (nextValue: T) => { hookState.selectedSlug = nextValue as string; },
  ],
}));

function releaseLinks(element: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (!element || typeof element !== 'object' || !('props' in element)) return [];

  const reactElement = element as React.ReactElement<Record<string, unknown>>;
  const children = reactElement.props.children as React.ReactNode;
  const descendants = Array.isArray(children)
    ? children.flatMap((child) => releaseLinks(child))
    : releaseLinks(children);

  return reactElement.type === 'a' && reactElement.props.className === 'release-node'
    ? [reactElement, ...descendants]
    : descendants;
}

describe('LineageExplorer', () => {
  beforeEach(() => {
    hookState.selectedSlug = undefined;
  });

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
      expect(markup).toContain(`<article class="family-branch" aria-labelledby="family-${family.id}">`);
      expect(markup).toContain(`<h3 id="family-${family.id}">${family.name}</h3>`);
    }
    for (const release of dataset.releases) {
      expect(markup).toContain(`>${release.displayName}<`);
      expect(markup).toContain(`href="/catalog/models/${release.slug}/"`);
    }
  });

  it('keeps focus and hover preview state out of navigation-current semantics', () => {
    const props = {
      hierarchy: buildHomepageHierarchy(dataset),
      sourceByReleaseId: {},
      basePath: '/',
    };
    let links = releaseLinks(LineageExplorer(props));

    expect(links[0].props['data-selected']).toBe('true');
    expect(links.every((link) => link.props['aria-current'] === undefined)).toBe(true);

    (links[1].props.onFocus as () => void)();
    links = releaseLinks(LineageExplorer(props));
    expect(links[1].props['data-selected']).toBe('true');
    expect(links.every((link) => link.props['aria-current'] === undefined)).toBe(true);

    (links[2].props.onMouseEnter as () => void)();
    links = releaseLinks(LineageExplorer(props));
    expect(links[2].props['data-selected']).toBe('true');
    expect(links.every((link) => link.props['aria-current'] === undefined)).toBe(true);
  });
});