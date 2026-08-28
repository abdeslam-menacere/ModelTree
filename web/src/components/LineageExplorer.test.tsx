import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { FLAT_FAMILY_ID, lineageFixtureDataset } from '../../tests/fixtures/lineage-dataset';
import { buildLineageEcosystems, type LineageEcosystem } from '../lib/lineage-view';
import { parseComparisonSelection } from '../lib/comparison';
import LineageExplorer from './LineageExplorer';

const fixtureEcosystems = buildLineageEcosystems(lineageFixtureDataset);
const catalogEcosystems = buildLineageEcosystems(dataset);

function labelsFor(releases: readonly { id: string; displayName: string }[]) {
  return Object.fromEntries(releases.map(({ id, displayName }) => [id, displayName]));
}

function renderExplorer(ecosystems: LineageEcosystem[], labels: Record<string, string>) {
  return renderToStaticMarkup(
    <LineageExplorer
      ecosystems={ecosystems}
      sourceByReleaseId={{}}
      releaseLabels={labels}
      basePath="/ModelTree/"
    />,
  );
}

const fixtureMarkup = renderExplorer(fixtureEcosystems, labelsFor(lineageFixtureDataset.releases));
const catalogMarkup = renderExplorer(catalogEcosystems, labelsFor(dataset.releases));

function occurrences(markup: string, pattern: RegExp) {
  return markup.match(pattern)?.length ?? 0;
}

describe('the server-rendered explorer is a complete text alternative', () => {
  it('renders every featured creator, family, and release before any script runs', () => {
    expect(catalogEcosystems.length).toBeGreaterThan(0);

    for (const { organization, families } of catalogEcosystems) {
      expect(catalogMarkup).toContain(organization.name);
      for (const { family, releases } of families) {
        expect(catalogMarkup).toContain(family.name);
        for (const release of releases) expect(catalogMarkup).toContain(release.displayName);
      }
    }
  });

  it('exposes the hierarchy as nested lists rather than an ARIA tree', () => {
    expect(catalogMarkup).toContain('<ul class="lineage-branch"');
    expect(catalogMarkup).not.toContain('role="tree"');
    expect(catalogMarkup).not.toContain('role="treeitem"');
  });

  it('states status and access as text, so no meaning rests on colour alone', () => {
    for (const { families } of catalogEcosystems) {
      for (const { releases } of families) {
        for (const release of releases) {
          expect(catalogMarkup).toContain(`data-status="${release.status}"`);
        }
      }
    }
    // The emphasis attribute is never the only carrier: each node also spells the
    // relation out, and unrelated nodes carry no chip to spell out.
    expect(catalogMarkup).toContain('data-relation="selected"');
    expect(catalogMarkup).toContain('class="node-relation">Selected<');
  });

  it('marks exactly one release as current', () => {
    expect(occurrences(catalogMarkup, /aria-current="true"/g)).toBe(1);
  });

  it('keeps the long tail reachable without rendering it', () => {
    const longTail = dataset.families.filter((family) => (
      !dataset.releases.some((release) => release.familyId === family.id && release.featured)
    ));
    expect(longTail.length, 'catalog must hold a family with no featured release')
      .toBeGreaterThan(0);

    expect(catalogMarkup).toContain('href="/ModelTree/models/"');
    expect(catalogMarkup).toContain('href="/ModelTree/tree/"');

    // The family name may still appear inside sourced prose about other records,
    // so the claim is about rendered nodes: no heading and no selectable release.
    for (const family of longTail) {
      expect(catalogMarkup).not.toContain(`id="family-${family.id}"`);
      for (const release of dataset.releases.filter(({ familyId }) => familyId === family.id)) {
        expect(catalogMarkup).not.toContain(`data-release="${release.slug}"`);
      }
    }
  });
});

describe('no provider-specific markup is required', () => {
  /**
   * A creator reaches the page only through the data. The check is run against a
   * catalog of creators that do not exist in the reviewed dataset, so nothing in
   * the component can have been written for them.
   */
  it('renders a catalog of entirely unfamiliar creators with the same component', () => {
    expect(fixtureEcosystems.length).toBeGreaterThan(0);

    for (const { organization, families } of fixtureEcosystems) {
      expect(fixtureMarkup).toContain(organization.name);
      expect(families.length).toBeGreaterThan(0);
    }
    expect(occurrences(fixtureMarkup, /class="organization-branch"/g))
      .toBe(fixtureEcosystems.length);
  });

  it('names no creator from the catalog anywhere in the explorer or its view model', () => {
    const sources = [
      'src/components/LineageExplorer.tsx',
      'src/lib/lineage-view.ts',
    ].map((path) => ({ path, text: readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8') }));

    const identifiers = dataset.organizations
      .flatMap(({ id, slug, name, shortName }) => [id, slug, name, shortName]);
    expect(identifiers.length, 'catalog must name creators for this to prove anything')
      .toBeGreaterThan(0);

    // Positive control: the same probe, run against a string these files really do
    // contain, must find it -- otherwise an empty result would prove nothing.
    for (const { path, text } of sources) {
      expect(matches(text, ['lineage']), `probe failed to find a known token in ${path}`)
        .not.toEqual([]);
    }

    for (const { path, text } of sources) {
      expect(matches(text, identifiers), `${path} names a creator from the catalog`).toEqual([]);
    }
  });
});

/** Case-sensitive, word-bounded, so `Meta` cannot be found inside `metadata`. */
function matches(text: string, needles: readonly string[]) {
  return needles.filter((needle) => (
    new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}([^A-Za-z0-9]|$)`).test(text)
  ));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('unknown relationships do not create implied connecting lines', () => {
  it('draws one connector per recorded lineage link and no others', () => {
    for (const [markup, ecosystems] of [
      [fixtureMarkup, fixtureEcosystems],
      [catalogMarkup, catalogEcosystems],
    ] as const) {
      const expected = ecosystems
        .flatMap(({ families }) => families)
        .reduce((total, { linkCount }) => total + linkCount, 0);

      expect(occurrences(markup, /data-lineage-link="/g)).toBe(expected);
    }
  });

  it('emits no connector and says so for a family the catalog records nothing about', () => {
    const owner = fixtureEcosystems
      .find(({ families }) => families.some(({ family }) => family.id === FLAT_FAMILY_ID))!;
    const flat = owner.families.find(({ family }) => family.id === FLAT_FAMILY_ID)!;
    const markup = renderExplorer(
      [{ ...owner, families: [flat] }],
      labelsFor(lineageFixtureDataset.releases),
    );

    expect(flat.releases.length).toBeGreaterThan(1);
    for (const release of flat.releases) expect(markup).toContain(release.displayName);
    expect(markup).not.toContain('lineage-branch--nested');
    expect(markup).not.toContain('data-lineage-link="');
    expect(markup).toContain('No recorded lineage links in this family');
  });

  it('names a predecessor it could not nest under instead of drawing a second line', () => {
    expect(fixtureMarkup).toContain('shown without a connector');
  });

  it('never draws a connector for a derivation, which may cross families', () => {
    const derived = lineageFixtureDataset.releases
      .filter(({ derivedFromIds }) => derivedFromIds.length > 0);
    expect(derived.length).toBeGreaterThan(0);

    for (const release of derived) {
      for (const derivedFromId of release.derivedFromIds) {
        expect(fixtureMarkup).not.toContain(`data-lineage-link="${derivedFromId}"`);
      }
    }
  });

  it('states the absence of each relationship rather than leaving it blank', () => {
    const withoutLineage = dataset.releases.find((release) => (
      release.predecessorIds.length === 0
      && release.successorIds.length === 0
      && catalogEcosystems.some(({ families }) => families.some(({ releases }) => (
        releases.some(({ id }) => id === release.id)
      )))
    ));

    expect(withoutLineage, 'catalog must hold a release with no recorded lineage').toBeDefined();
    const markup = renderExplorer(catalogEcosystems, labelsFor(dataset.releases));
    expect(markup).toMatch(/No recorded (predecessor|successor|sibling release|derivation)\./);
  });
});

describe('the drawer can start a comparison', () => {
  it('offers an add-to-comparison link for the selected release', () => {
    expect(occurrences(catalogMarkup, /Add to comparison/g)).toBeGreaterThan(0);
    expect(catalogMarkup).toMatch(/href="\/ModelTree\/compare\/\?models=[a-z0-9-]+"/);
  });

  it('names the model in the accessible label, not just "compare"', () => {
    const first = catalogEcosystems[0]!.families[0]!.releases[0]!;
    expect(catalogMarkup).toContain(`aria-label="Add ${first.displayName} to the comparison"`);
  });

  it('emits a link the comparison parses back to exactly that release', () => {
    const known = dataset.releases.map((release) => release.slug);
    const hrefs = Array.from(
      catalogMarkup.matchAll(/href="\/ModelTree\/compare\/(\?models=[^"]+)"/g),
    ).map((match) => match[1]!);

    expect(hrefs.length).toBeGreaterThan(0);
    for (const search of hrefs) {
      const selection = parseComparisonSelection(search, known);
      expect(selection.slugs).toHaveLength(1);
      expect(selection.rejections).toEqual([]);
    }
  });
});