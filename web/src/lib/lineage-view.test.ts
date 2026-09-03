import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import {
  CYCLE_FAMILY_ID,
  DEEP_FAMILY_ID,
  FLAT_FAMILY_ID,
  LONG_TAIL_FAMILY_ID,
  MULTI_PREDECESSOR_FAMILY_ID,
  MULTI_ROOT_FAMILY_ID,
  SHALLOW_FAMILY_ID,
  lineageFixtureDataset,
} from '../../tests/fixtures/lineage-dataset';
import {
  buildCreatorEcosystems,
  buildLineageEcosystems,
  buildLineageHighlight,
  buildLineageTrail,
  findLineagePlacement,
  firstEcosystemRelease,
  lineageRelation,
  lineageReleaseSlugs,
  type LineageEcosystem,
  type LineageFamilyView,
  type LineageNode,
} from './lineage-view';

const fixtureEcosystems = buildLineageEcosystems(lineageFixtureDataset);
const catalogEcosystems = buildLineageEcosystems(dataset);

function allFamilies(ecosystems: readonly LineageEcosystem[]): LineageFamilyView[] {
  return ecosystems.flatMap(({ families }) => families);
}

function familyView(ecosystems: readonly LineageEcosystem[], familyId: string) {
  const found = allFamilies(ecosystems).find(({ family }) => family.id === familyId);
  expect(found, `expected family ${familyId} to be rendered`).toBeDefined();
  return found!;
}

/** Every node in render order, so assertions can talk about the whole tree. */
function flatten(nodes: readonly LineageNode[]): LineageNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** Every parent-to-child connector the tree would draw. */
function connectors(nodes: readonly LineageNode[]): [string, string][] {
  return nodes.flatMap((node) => [
    ...node.children.map((child): [string, string] => [node.release.id, child.release.id]),
    ...connectors(node.children),
  ]);
}

/** Whether the catalog records a predecessor/successor link between two releases, in either direction. */
function isRecordedLink(family: LineageFamilyView, parentId: string, childId: string) {
  const parent = family.releases.find(({ id }) => id === parentId);
  const child = family.releases.find(({ id }) => id === childId);

  return Boolean(
    parent?.successorIds.includes(childId) || child?.predecessorIds.includes(parentId),
  );
}

describe('featured ecosystem derivation', () => {
  it('keeps only creators and families that hold a featured release', () => {
    const familyIds = allFamilies(fixtureEcosystems).map(({ family }) => family.id);

    expect(familyIds).toContain(SHALLOW_FAMILY_ID);
    // Same creator, no featured release: the homepage is not the long-tail view.
    expect(familyIds).not.toContain(LONG_TAIL_FAMILY_ID);
  });

  it('renders a featured family whole, including its non-featured releases', () => {
    const flat = familyView(fixtureEcosystems, FLAT_FAMILY_ID);

    expect(flat.releases.some(({ featured }) => featured)).toBe(true);
    expect(flat.releases.some(({ featured }) => !featured)).toBe(true);
  });

  it('orders creators by name and releases newest first, with id tiebreaks', () => {
    expect(fixtureEcosystems.map(({ organization }) => organization.name))
      .toEqual(['Alpha Foundry', 'Beta Collective', 'Gamma Works']);

    for (const family of allFamilies(fixtureEcosystems)) {
      const dates = family.releases.map(({ releaseDate }) => releaseDate);
      expect([...dates].sort().reverse()).toEqual(dates);
    }
  });

  it('exposes every rendered release through its slug index and placement lookup', () => {
    const slugs = lineageReleaseSlugs(fixtureEcosystems);

    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(findLineagePlacement(fixtureEcosystems, slug)?.release.slug).toBe(slug);
    }
    expect(findLineagePlacement(fixtureEcosystems, 'fixture-alpha-longtail-one')).toBeUndefined();
    expect(findLineagePlacement(fixtureEcosystems, undefined)).toBeUndefined();
  });
});

describe('creator ecosystem derivation', () => {
  const fixtureCreators = buildCreatorEcosystems(lineageFixtureDataset);
  const catalogCreators = buildCreatorEcosystems(dataset);

  it('reads no flag: every creator with a release is present, featured or not', () => {
    for (const source of [
      { name: 'fixture', data: lineageFixtureDataset, built: fixtureCreators },
      { name: 'catalog', data: dataset, built: catalogCreators },
    ]) {
      const expected = [...new Set(
        source.data.releases.map(({ organizationId }) => organizationId),
      )].sort();

      expect(source.built.map(({ organization }) => organization.id).sort(), source.name)
        .toEqual(expected);
    }
  });

  it('includes a family whose releases are none of them featured', () => {
    // Differential control: this is precisely the family the featured view drops
    // (`fixtureEcosystems` above asserts its absence), so seeing it here proves
    // the two views are actually different derivations rather than one alias.
    const familyIds = fixtureCreators.flatMap(({ families }) => families.map(({ family }) => family.id));

    expect(familyIds).toContain(LONG_TAIL_FAMILY_ID);
    expect(familyIds).toContain(SHALLOW_FAMILY_ID);
    expect(familyView(fixtureCreators, LONG_TAIL_FAMILY_ID).releases.some(({ featured }) => featured))
      .toBe(false);
  });

  it('is a superset of the featured view and loses no release from it', () => {
    const featuredSlugs = lineageReleaseSlugs(buildLineageEcosystems(dataset));
    const creatorSlugs = new Set(lineageReleaseSlugs(catalogCreators));

    // Positive control: an empty featured view would satisfy containment without
    // proving anything.
    expect(featuredSlugs.length).toBeGreaterThan(0);
    for (const slug of featuredSlugs) expect(creatorSlugs.has(slug)).toBe(true);
    // And the coverage view really is wider, on the live catalog.
    expect(creatorSlugs.size).toBeGreaterThan(featuredSlugs.length);
  });

  it('renders every catalog release exactly once across the creator view', () => {
    const slugs = lineageReleaseSlugs(catalogCreators);

    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual(dataset.releases.map(({ slug }) => slug).sort());
  });
});

describe('hierarchy transformation', () => {
  it('nests a deep chain and reads one-sided edges from either end', () => {
    const deep = familyView(fixtureEcosystems, DEEP_FAMILY_ID);

    expect(deep.roots.map(({ release }) => release.id)).toEqual(['fixture-beta-chain-gen1']);
    expect(deep.maxDepth).toBe(3);
    expect(connectors(deep.roots)).toEqual([
      // gen1 -> gen2 exists only on the child's predecessorIds.
      ['fixture-beta-chain-gen1', 'fixture-beta-chain-gen2'],
      ['fixture-beta-chain-gen2', 'fixture-beta-chain-gen3'],
      // gen3 -> gen4 exists only on the parent's successorIds.
      ['fixture-beta-chain-gen3', 'fixture-beta-chain-gen4'],
    ]);
  });

  it('keeps a shallow family flat', () => {
    const shallow = familyView(fixtureEcosystems, SHALLOW_FAMILY_ID);

    expect(shallow.maxDepth).toBe(0);
    expect(shallow.linkCount).toBe(0);
    expect(shallow.roots).toHaveLength(1);
  });

  it('keeps independent roots independent', () => {
    const roots = familyView(fixtureEcosystems, MULTI_ROOT_FAMILY_ID);

    expect(roots.roots.map(({ release }) => release.id))
      .toEqual(['fixture-beta-roots-second', 'fixture-beta-roots-first']);
    expect(connectors(roots.roots))
      .toEqual([['fixture-beta-roots-first', 'fixture-beta-roots-child']]);
  });

  it('nests a converging release once and names the predecessor it could not nest under', () => {
    const converge = familyView(fixtureEcosystems, MULTI_PREDECESSOR_FAMILY_ID);
    const merged = flatten(converge.roots)
      .find(({ release }) => release.id === 'fixture-gamma-converge-merged')!;

    expect(connectors(converge.roots))
      .toEqual([['fixture-gamma-converge-right', 'fixture-gamma-converge-merged']]);
    // The other recorded predecessor is reported, not drawn as a second line.
    expect(merged.additionalPredecessorIds).toEqual(['fixture-gamma-converge-left']);
    expect(flatten(converge.roots)).toHaveLength(converge.releases.length);
  });

  it('terminates on a cyclic pair and still renders each release exactly once', () => {
    const cycle = familyView(fixtureEcosystems, CYCLE_FAMILY_ID);
    const rendered = flatten(cycle.roots).map(({ release }) => release.id);

    expect(rendered).toHaveLength(cycle.releases.length);
    expect(new Set(rendered).size).toBe(cycle.releases.length);
  });

  it('never renders a release twice or drops one, in any fixture family', () => {
    for (const family of allFamilies(fixtureEcosystems)) {
      const rendered = flatten(family.roots).map(({ release }) => release.id);

      expect(new Set(rendered)).toEqual(new Set(family.releases.map(({ id }) => id)));
      expect(rendered).toHaveLength(family.releases.length);
      expect(family.linkCount).toBe(connectors(family.roots).length);
    }
  });
});

describe('unknown relationships do not become connectors', () => {
  it('draws nothing in a family the catalog records no relationships for', () => {
    const flat = familyView(fixtureEcosystems, FLAT_FAMILY_ID);

    expect(flat.releases.length).toBeGreaterThan(1);
    expect(flat.hasRecordedLineage).toBe(false);
    expect(flat.linkCount).toBe(0);
    expect(connectors(flat.roots)).toEqual([]);
    // Publication order is not descent: every release stands as its own root.
    expect(flat.roots).toHaveLength(flat.releases.length);
  });

  it('never draws a connector that is not a recorded relationship, in any family', () => {
    const families = [...allFamilies(fixtureEcosystems), ...allFamilies(catalogEcosystems)];
    expect(families.length).toBeGreaterThan(0);

    const invented = families.flatMap((family) => (
      connectors(family.roots)
        .filter(([parentId, childId]) => !isRecordedLink(family, parentId, childId))
        .map(([parentId, childId]) => `${family.family.id}: ${parentId} -> ${childId}`)
    ));

    expect(invented, 'these connectors assert a lineage no source records').toEqual([]);
  });

  it('does not treat derivation as a within-family connector', () => {
    const derived = lineageFixtureDataset.releases
      .filter(({ derivedFromIds }) => derivedFromIds.length > 0);
    expect(derived.length, 'fixture must exercise derivation').toBeGreaterThan(0);

    for (const release of derived) {
      const family = familyView(fixtureEcosystems, release.familyId);
      const parentIds = connectors(family.roots)
        .filter(([, childId]) => childId === release.id)
        .map(([parentId]) => parentId);

      for (const derivedFromId of release.derivedFromIds) {
        expect(parentIds).not.toContain(derivedFromId);
      }
    }
  });
});

describe('path highlighting', () => {
  it('marks transitive ancestors and successors along a chain', () => {
    const highlight = buildLineageHighlight(fixtureEcosystems, 'fixture-beta-chain-gen3');

    expect([...highlight.ancestorIds].sort())
      .toEqual(['fixture-beta-chain-gen1', 'fixture-beta-chain-gen2']);
    expect([...highlight.successorIds]).toEqual(['fixture-beta-chain-gen4']);
    expect(lineageRelation(highlight, 'fixture-beta-chain-gen1')).toBe('ancestor');
    expect(lineageRelation(highlight, 'fixture-beta-chain-gen3')).toBe('selected');
    expect(lineageRelation(highlight, 'fixture-beta-chain-gen4')).toBe('successor');
  });

  it('marks reciprocal siblings without making them ancestors', () => {
    const highlight = buildLineageHighlight(fixtureEcosystems, 'fixture-beta-roots-first');

    expect(lineageRelation(highlight, 'fixture-beta-roots-second')).toBe('sibling');
    expect(lineageRelation(highlight, 'fixture-beta-roots-child')).toBe('successor');
  });

  it('highlights a converging predecessor that could not be drawn as a connector', () => {
    const highlight = buildLineageHighlight(fixtureEcosystems, 'fixture-gamma-converge-merged');

    expect([...highlight.ancestorIds].sort())
      .toEqual(['fixture-gamma-converge-left', 'fixture-gamma-converge-right']);
  });

  it('leaves every release unrelated when a family records nothing', () => {
    const flat = familyView(fixtureEcosystems, FLAT_FAMILY_ID);
    const highlight = buildLineageHighlight(fixtureEcosystems, flat.releases[0].slug);

    expect(highlight.ancestorIds.size).toBe(0);
    expect(highlight.successorIds.size).toBe(0);
    expect(highlight.siblingIds.size).toBe(0);
    for (const release of flat.releases.slice(1)) {
      expect(lineageRelation(highlight, release.id)).toBe('unrelated');
    }
  });

  it('terminates and excludes the selection itself on a cyclic pair', () => {
    const highlight = buildLineageHighlight(fixtureEcosystems, 'fixture-gamma-cycle-one');

    expect(highlight.ancestorIds.has('fixture-gamma-cycle-one')).toBe(false);
    expect(highlight.successorIds.has('fixture-gamma-cycle-one')).toBe(false);
    expect(highlight.successorIds.has('fixture-gamma-cycle-two')).toBe(true);
  });

  it('highlights nothing for an unknown or absent selection', () => {
    for (const slug of ['not-a-release', undefined, null]) {
      const highlight = buildLineageHighlight(fixtureEcosystems, slug);
      expect(highlight.selectedId).toBeUndefined();
      expect(highlight.ancestorIds.size + highlight.successorIds.size + highlight.siblingIds.size)
        .toBe(0);
      expect(highlight.derivationIds.size).toBe(0);
    }
  });
});

describe('derivation is a first-class relationship, not a hidden ancestor', () => {
  // The featured view drops the flat family (its releases are not featured), so
  // the derivation edge from `fixture-gamma-flat-two` to `fixture-alpha-solo-one`
  // is exercised through the coverage view instead. That is deliberate: the
  // trail must work for every creator the catalog holds, not only the ones the
  // homepage happens to lead with today.
  const creatorEcosystems = buildCreatorEcosystems(lineageFixtureDataset);

  it('reads derivation ids only from the selected release, not from siblings or ancestors', () => {
    const highlight = buildLineageHighlight(creatorEcosystems, 'fixture-gamma-flat-two');

    expect([...highlight.derivationIds]).toEqual(['fixture-alpha-solo-one']);
    // Derivation is not a within-family edge, so it never leaks into the family
    // walk: no ancestor, no successor, no sibling.
    expect(highlight.ancestorIds.size).toBe(0);
    expect(highlight.successorIds.size).toBe(0);
    expect(highlight.siblingIds.size).toBe(0);
    expect(lineageRelation(highlight, 'fixture-alpha-solo-one')).toBe('derivation');
  });

  it('excludes derivation ids that name a release the catalog does not hold', () => {
    // A stray id would be filtered out by the presence check, so the highlight
    // never asks the UI to render a phantom.
    const highlight = buildLineageHighlight(creatorEcosystems, 'fixture-gamma-flat-one');
    for (const id of highlight.derivationIds) {
      expect(id).not.toBe('fixture-does-not-exist');
    }
  });
});

describe('trail projection', () => {
  const creatorEcosystems = buildCreatorEcosystems(lineageFixtureDataset);

  it('groups every recorded relationship, ordered newest-first with placements resolved', () => {
    const trail = buildLineageTrail(fixtureEcosystems, 'fixture-beta-chain-gen3');

    expect(trail.selected?.release.id).toBe('fixture-beta-chain-gen3');
    expect(trail.isEmpty).toBe(false);
    // Newest first: gen2 before gen1.
    expect(trail.ancestors.map((entry) => entry.releaseId))
      .toEqual(['fixture-beta-chain-gen2', 'fixture-beta-chain-gen1']);
    expect(trail.successors.map((entry) => entry.releaseId)).toEqual(['fixture-beta-chain-gen4']);
    expect(trail.siblings).toEqual([]);
    expect(trail.derivations).toEqual([]);
    // Every entry inside a visible ecosystem resolves to a placement, so the UI
    // can link to it without a second lookup.
    for (const entry of [...trail.ancestors, ...trail.successors]) {
      expect(entry.placement?.release.id).toBe(entry.releaseId);
    }
    expect(trail.memberIds).toEqual(
      new Set(['fixture-beta-chain-gen1', 'fixture-beta-chain-gen2', 'fixture-beta-chain-gen4']),
    );
  });

  it('lists both predecessors when the tree could only draw one, and neither is a successor', () => {
    const trail = buildLineageTrail(fixtureEcosystems, 'fixture-gamma-converge-merged');

    expect(trail.ancestors.map((entry) => entry.releaseId).sort())
      .toEqual(['fixture-gamma-converge-left', 'fixture-gamma-converge-right']);
    expect(trail.successors).toEqual([]);
    expect(trail.memberIds.has('fixture-gamma-converge-merged')).toBe(false);
  });

  it('terminates on a cyclic pair, listing the other release exactly once and never the selection', () => {
    const trail = buildLineageTrail(fixtureEcosystems, 'fixture-gamma-cycle-one');
    const idsSeen = [
      ...trail.ancestors.map((entry) => entry.releaseId),
      ...trail.successors.map((entry) => entry.releaseId),
      ...trail.siblings.map((entry) => entry.releaseId),
      ...trail.derivations.map((entry) => entry.releaseId),
    ];

    expect(idsSeen).not.toContain('fixture-gamma-cycle-one');
    expect(idsSeen.filter((id) => id === 'fixture-gamma-cycle-two')).toHaveLength(1);
    expect(trail.isEmpty).toBe(false);
  });

  it('lists a cross-organization derivation as a derivation entry, not as an ancestor', () => {
    const trail = buildLineageTrail(creatorEcosystems, 'fixture-gamma-flat-two');

    expect(trail.derivations.map((entry) => entry.releaseId)).toEqual(['fixture-alpha-solo-one']);
    // The derivation's placement resolves against the catalog view where the
    // target release lives -- so a component can name its creator and family
    // without inventing them.
    expect(trail.derivations[0].placement?.organization.id).toBe('fixture-alpha');
    expect(trail.derivations[0].placement?.family.family.id).toBe(SHALLOW_FAMILY_ID);
    expect(trail.ancestors).toEqual([]);
  });

  it('marks a derivation whose target lives outside the visible ecosystems as external', () => {
    // Simulating "featured homepage that hides the derivation source" by
    // dropping the ecosystem the target sits in. The trail must still surface
    // the derivation -- the record exists whether or not this screen shows the
    // target -- but the placement is undefined so the UI cannot link it.
    const withoutAlpha = creatorEcosystems.filter(({ organization }) => organization.id !== 'fixture-alpha');
    const trail = buildLineageTrail(withoutAlpha, 'fixture-gamma-flat-two');

    expect(trail.derivations.map((entry) => entry.releaseId)).toEqual(['fixture-alpha-solo-one']);
    expect(trail.derivations[0].placement).toBeUndefined();
  });

  it('returns an empty trail for a release the catalog records no relationship for', () => {
    // Any release in the flat family qualifies, but flat-two carries a
    // derivation, so pick flat-one -- the release with nothing recorded at all.
    const trail = buildLineageTrail(creatorEcosystems, 'fixture-gamma-flat-one');

    expect(trail.selected?.release.id).toBe('fixture-gamma-flat-one');
    expect(trail.ancestors).toEqual([]);
    expect(trail.successors).toEqual([]);
    expect(trail.siblings).toEqual([]);
    expect(trail.derivations).toEqual([]);
    expect(trail.isEmpty).toBe(true);
    expect(trail.memberIds.size).toBe(0);
  });

  it('returns an empty trail with no selection for an unknown slug', () => {
    const trail = buildLineageTrail(fixtureEcosystems, 'not-a-release');

    expect(trail.selected).toBeUndefined();
    expect(trail.isEmpty).toBe(true);
    expect(trail.memberIds.size).toBe(0);
  });
});

/**
 * These sweep whatever the reviewed catalog holds today rather than pinning what
 * it held when they were written. No count of creators, families, or releases is
 * asserted anywhere: a seeding change must extend this suite's coverage, never
 * redden it.
 */
describe('the reviewed catalog, whatever it currently contains', () => {
  it('yields a branch for every creator that has a featured release', () => {
    const expected = new Set(
      dataset.releases.filter(({ featured }) => featured).map(({ organizationId }) => organizationId),
    );
    expect(expected.size, 'catalog must contain at least one featured release').toBeGreaterThan(0);

    expect(new Set(catalogEcosystems.map(({ organization }) => organization.id))).toEqual(expected);
  });

  it('gives every ecosystem a deterministic first release', () => {
    for (const ecosystem of catalogEcosystems) {
      const first = firstEcosystemRelease(ecosystem);

      expect(first.id).toBe(ecosystem.families[0].releases[0].id);
      expect(firstEcosystemRelease(ecosystem).id).toBe(first.id);
      expect(findLineagePlacement(catalogEcosystems, first.slug)?.organization.id)
        .toBe(ecosystem.organization.id);
    }
  });

  it('renders each family whole and each release exactly once', () => {
    const rendered = allFamilies(catalogEcosystems).flatMap(({ roots }) => (
      flatten(roots).map(({ release }) => release.id)
    ));
    expect(rendered.length).toBeGreaterThan(0);
    expect(new Set(rendered).size).toBe(rendered.length);

    for (const { family, releases } of allFamilies(catalogEcosystems)) {
      const inCatalog = dataset.releases.filter(({ familyId }) => familyId === family.id);
      expect(releases.map(({ id }) => id).sort()).toEqual(inCatalog.map(({ id }) => id).sort());
    }
  });

  it('reports no recorded lineage exactly when it draws no connectors', () => {
    for (const family of allFamilies(catalogEcosystems)) {
      if (!family.hasRecordedLineage) expect(family.linkCount).toBe(0);
    }
  });

  it('resolves the highlight for every rendered release without escaping its family', () => {
    for (const slug of lineageReleaseSlugs(catalogEcosystems)) {
      const placement = findLineagePlacement(catalogEcosystems, slug)!;
      const highlight = buildLineageHighlight(catalogEcosystems, slug);
      const inFamily = new Set(placement.family.releases.map(({ id }) => id));

      for (const id of [...highlight.ancestorIds, ...highlight.successorIds, ...highlight.siblingIds]) {
        expect(inFamily.has(id), `${id} highlighted outside ${placement.family.family.id}`).toBe(true);
      }
      // Derivation may cross families and creators, so it is *not* asserted to
      // stay in the selected release's family. What it must not do is name a
      // release the catalog does not hold at all.
      const allIds = new Set(catalogEcosystems.flatMap(({ families }) => (
        families.flatMap(({ releases }) => releases.map(({ id }) => id))
      )));
      for (const id of highlight.derivationIds) {
        expect(allIds.has(id), `${id} derivation names a release not in the catalog`).toBe(true);
      }
    }
  });
});
