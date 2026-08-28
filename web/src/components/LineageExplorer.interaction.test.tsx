// @vitest-environment jsdom

import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { lineageFixtureDataset } from '../../tests/fixtures/lineage-dataset';
import {
  buildLineageEcosystems,
  firstEcosystemRelease,
  type LineageEcosystem,
} from '../lib/lineage-view';
import LineageExplorer from './LineageExplorer';

const ecosystems = buildLineageEcosystems(dataset);
const fixtureEcosystems = buildLineageEcosystems(lineageFixtureDataset);

function renderExplorer(views: LineageEcosystem[] = ecosystems, records = dataset.releases) {
  return render(
    <LineageExplorer
      ecosystems={views}
      sourceByReleaseId={{}}
      releaseLabels={Object.fromEntries(records.map(({ id, displayName }) => [id, displayName]))}
      basePath="/ModelTree/"
    />,
  );
}

function providerButton(name: string) {
  return within(document.querySelector('.ecosystem-selector') as HTMLElement)
    .getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
}

function detailsPanel() {
  return document.querySelector('.model-summary') as HTMLElement;
}

/** Every creator the data yields, so a newly seeded one is covered on arrival. */
const everyEcosystem = ecosystems.map((ecosystem) => [ecosystem.organization.name, ecosystem] as const);

beforeEach(() => {
  window.history.replaceState({}, '', '/ModelTree/');
});

afterEach(() => {
  cleanup();
});

describe('switching creators preserves deterministic selection', () => {
  it.each(everyEcosystem)('selects the same release every time for %s', async (_name, ecosystem) => {
    const user = userEvent.setup();
    renderExplorer();
    const expected = firstEcosystemRelease(ecosystem);

    await user.click(providerButton(ecosystem.organization.name));

    await waitFor(() => {
      expect(within(detailsPanel()).getByRole('heading', { name: expected.displayName })).toBeTruthy();
    });
    expect(providerButton(ecosystem.organization.name).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(document.querySelector('[aria-current="true"]')?.getAttribute('data-release'))
      .toBe(expected.slug);
    expect(window.location.search)
      .toBe(`?provider=${ecosystem.organization.slug}&model=${expected.slug}`);
  });

  it('returns to the identical selection when a creator is revisited', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const [first, second] = ecosystems;
    if (!second) return;

    await user.click(providerButton(second.organization.name));
    await user.click(providerButton(first.organization.name));
    const afterReturn = window.location.search;

    await user.click(providerButton(second.organization.name));
    await user.click(providerButton(first.organization.name));

    expect(window.location.search).toBe(afterReturn);
    expect(afterReturn).toBe(
      `?provider=${first.organization.slug}&model=${firstEcosystemRelease(first).slug}`,
    );
  });

  it('shows one creator at a time once interactive, and leaves the rest switchable', async () => {
    const user = userEvent.setup();
    renderExplorer();

    await waitFor(() => {
      expect(document.querySelectorAll('.organization-branch')).toHaveLength(1);
    });
    for (const { organization } of ecosystems) {
      expect(providerButton(organization.name)).toBeTruthy();
    }

    const last = ecosystems[ecosystems.length - 1];
    await user.click(providerButton(last.organization.name));
    const heading = document.querySelector('.organization-branch strong');
    expect(heading?.textContent).toBe(last.organization.name);
  });

  it('keeps focus on the creator the user activated', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const target = ecosystems[ecosystems.length - 1];

    const button = providerButton(target.organization.name);
    await user.click(button);

    expect(document.activeElement).toBe(providerButton(target.organization.name));
  });

  it('drives an unfamiliar catalog of creators with no code path of its own', async () => {
    const user = userEvent.setup();
    renderExplorer(fixtureEcosystems, lineageFixtureDataset.releases);

    for (const ecosystem of fixtureEcosystems) {
      await user.click(providerButton(ecosystem.organization.name));
      const expected = firstEcosystemRelease(ecosystem);

      await waitFor(() => {
        expect(within(detailsPanel()).getByRole('heading', { name: expected.displayName }))
          .toBeTruthy();
      });
      expect(window.location.search)
        .toBe(`?provider=${ecosystem.organization.slug}&model=${expected.slug}`);
    }
  }, 30_000);
});

describe('keyboard behaviour', () => {
  it('moves between creators with arrows and Home/End without selecting', async () => {
    const user = userEvent.setup();
    renderExplorer();
    if (ecosystems.length < 2) return;

    const first = providerButton(ecosystems[0].organization.name);
    const second = providerButton(ecosystems[1].organization.name);
    const last = providerButton(ecosystems[ecosystems.length - 1].organization.name);

    await waitFor(() => expect(first.getAttribute('tabindex')).toBe('0'));
    first.focus();
    const before = window.location.search;

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(second);
    // Focus alone must not change what is selected.
    expect(window.location.search).toBe(before);
    expect(second.getAttribute('aria-pressed')).toBe('false');

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
    expect(window.location.search).toBe(before);
  });

  it('wraps at both ends of the creator toolbar', async () => {
    const user = userEvent.setup();
    renderExplorer();
    if (ecosystems.length < 2) return;

    const first = providerButton(ecosystems[0].organization.name);
    const last = providerButton(ecosystems[ecosystems.length - 1].organization.name);

    first.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(first);
  });

  it('keeps exactly one creator in the tab order', async () => {
    renderExplorer();

    await waitFor(() => {
      const stops = [...document.querySelectorAll('.ecosystem-option')]
        .filter((node) => node.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
    });
  });

  it('selects a focused creator with Enter and with Space', async () => {
    const user = userEvent.setup();
    renderExplorer();
    if (ecosystems.length < 2) return;
    const target = ecosystems[ecosystems.length - 1];

    providerButton(target.organization.name).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(providerButton(target.organization.name).getAttribute('aria-pressed')).toBe('true');
    });

    await user.click(providerButton(ecosystems[0].organization.name));
    providerButton(target.organization.name).focus();
    await user.keyboard(' ');
    await waitFor(() => {
      expect(providerButton(target.organization.name).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('selects a release with Enter and never moves focus on its own', async () => {
    const user = userEvent.setup();
    renderExplorer();

    const target = await waitFor(() => {
      const node = [...document.querySelectorAll('.release-node')]
        .find((candidate) => candidate.getAttribute('aria-current') !== 'true');
      expect(node).toBeTruthy();
      return node as HTMLButtonElement;
    });
    const slug = target.getAttribute('data-release');

    target.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(target.getAttribute('aria-current')).toBe('true'));
    expect(document.activeElement).toBe(target);
    expect(window.location.search).toContain(`model=${slug}`);
  });
});

describe('shared URLs restore creator, family, selection, and details', () => {
  it('restores every rendered release from its model link alone', async () => {
    for (const ecosystem of ecosystems) {
      for (const family of ecosystem.families) {
        for (const release of family.releases) {
          window.history.replaceState({}, '', `/ModelTree/?model=${release.slug}`);
          renderExplorer();

          await waitFor(() => {
            expect(within(detailsPanel()).getByRole('heading', { name: release.displayName }))
              .toBeTruthy();
          });
          expect(providerButton(ecosystem.organization.name).getAttribute('aria-pressed'))
            .toBe('true');
          expect(document.querySelector(`#family-${family.family.id}`)?.textContent)
            .toBe(family.family.name);
          expect(document.querySelector('[aria-current="true"]')?.getAttribute('data-release'))
            .toBe(release.slug);
          expect(window.location.search)
            .toBe(`?provider=${ecosystem.organization.slug}&model=${release.slug}`);

          cleanup();
        }
      }
    }
  }, 60_000);

  it('restores a creator on its own and picks that creator deterministic first release', async () => {
    for (const ecosystem of ecosystems) {
      window.history.replaceState({}, '', `/ModelTree/?provider=${ecosystem.organization.slug}`);
      renderExplorer();
      const expected = firstEcosystemRelease(ecosystem);

      await waitFor(() => {
        expect(within(detailsPanel()).getByRole('heading', { name: expected.displayName }))
          .toBeTruthy();
      });
      expect(window.location.search)
        .toBe(`?provider=${ecosystem.organization.slug}&model=${expected.slug}`);

      cleanup();
    }
  }, 30_000);

  it('lets the model settle a disagreement with the creator parameter', async () => {
    if (ecosystems.length < 2) return;
    const [first, second] = ecosystems;
    const release = firstEcosystemRelease(second);

    window.history.replaceState(
      {},
      '',
      `/ModelTree/?provider=${first.organization.slug}&model=${release.slug}`,
    );
    renderExplorer();

    await waitFor(() => {
      expect(within(detailsPanel()).getByRole('heading', { name: release.displayName })).toBeTruthy();
    });
    expect(providerButton(second.organization.name).getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search)
      .toBe(`?provider=${second.organization.slug}&model=${release.slug}`);
  });

  it('falls back to the first creator for an unknown model or creator', async () => {
    const first = ecosystems[0];
    window.history.replaceState({}, '', '/ModelTree/?provider=not-seeded&model=not-a-release');
    renderExplorer();

    await waitFor(() => {
      expect(
        within(detailsPanel()).getByRole('heading', { name: firstEcosystemRelease(first).displayName }),
      ).toBeTruthy();
    });
    expect(window.location.search)
      .toBe(`?provider=${first.organization.slug}&model=${firstEcosystemRelease(first).slug}`);
  });

  it('preserves unrelated query state and the fragment', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/ModelTree/?utm=kept#explorer');
    renderExplorer();
    const target = ecosystems[ecosystems.length - 1];

    await user.click(providerButton(target.organization.name));

    await waitFor(() => {
      expect(window.location.search).toBe(
        `?utm=kept&provider=${target.organization.slug}&model=${firstEcosystemRelease(target).slug}`,
      );
    });
    expect(window.location.pathname).toBe('/ModelTree/');
    expect(window.location.hash).toBe('#explorer');
  });
});

describe('highlighting a selected path', () => {
  it('labels related releases in words, not only by emphasis', async () => {
    const user = userEvent.setup();
    const withLineage = ecosystems
      .flatMap(({ organization, families }) => families.map((family) => ({ organization, family })))
      .find(({ family }) => family.linkCount > 0);

    expect(withLineage, 'catalog must record at least one lineage link').toBeDefined();
    const { organization, family } = withLineage!;
    const child = family.roots.flatMap(function collect(node): typeof node[] {
      return [node, ...node.children.flatMap(collect)];
    }).find((node) => node.children.length > 0)!;

    renderExplorer();
    await user.click(providerButton(organization.name));
    await user.click(
      document.querySelector(`[data-release="${child.release.slug}"]`) as HTMLButtonElement,
    );

    await waitFor(() => {
      const selected = document.querySelector(`[data-release="${child.release.slug}"]`);
      expect(selected?.getAttribute('data-relation')).toBe('selected');
    });

    const successor = document.querySelector(`[data-release="${child.children[0].release.slug}"]`);
    expect(successor?.getAttribute('data-relation')).toBe('successor');
    expect(successor?.textContent).toContain('Later in lineage');
  });
});
