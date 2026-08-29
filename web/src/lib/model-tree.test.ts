import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { datasetWithOtherCreators, expectedOtherCreatorIds } from '../../tests/fixtures/model-tree-dataset';
import type { Dataset } from '../data/schema';
import {
  buildModelTree,
  findModelTreePath,
  modelTreeReleaseIds,
  restoreModelTreeSelection,
  toggleModelTreeBranch,
} from './model-tree';

/**
 * The membership rule `buildModelTree` implements for `others`, derived from the
 * dataset independently of the builder: a creator that holds releases but none
 * marked featured. A creator with no releases at all belongs to neither branch.
 */
function creatorIdsWithoutFeaturedRelease(source: Dataset) {
  return source.organizations
    .filter(({ id }) => (
      source.releases.some((release) => release.organizationId === id)
      && !source.releases.some((release) => release.organizationId === id && release.featured)
    ))
    .map(({ id }) => id)
    .sort();
}

/**
 * The releases `buildModelTree` renders, derived from the dataset independently
 * of the builder: creator -> family -> release, for every creator that holds at
 * least one release. This is the builder's own guarantee and nothing more: a
 * release whose family is absent from the catalog, or whose family belongs to a
 * creator that holds no releases of its own, is unreachable and does not render.
 */
function renderedReleaseIds(source: Dataset) {
  const creatorIds = new Set(
    source.organizations
      .filter(({ id }) => source.releases.some((release) => release.organizationId === id))
      .map(({ id }) => id),
  );
  const familyIds = new Set(
    source.families
      .filter(({ organizationId }) => creatorIds.has(organizationId))
      .map(({ id }) => id),
  );

  return source.releases
    .filter(({ familyId }) => familyIds.has(familyId))
    .map(({ id }) => id)
    .sort();
}

/**
 * The families `buildModelTree` shows for one creator, in render order, derived
 * from the dataset independently of the builder: the creator's families that
 * hold at least one release, newest release first with id ties broken lexically
 * (model-tree.ts:55-73). A family holding no release is dropped rather than
 * rendered empty.
 */
function renderedFamilies(source: Dataset, organizationId: string) {
  const newestReleaseDate = (familyId: string) => source.releases
    .filter((release) => release.familyId === familyId)
    .map(({ releaseDate }) => releaseDate)
    .sort()
    .at(-1);

  return source.families
    .filter((family) => family.organizationId === organizationId)
    .map((family) => ({ family, newest: newestReleaseDate(family.id) }))
    .filter((entry): entry is { family: typeof entry.family; newest: string } => (
      entry.newest !== undefined
    ))
    .sort((a, b) => (
      (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0)
      || (a.family.id < b.family.id ? -1 : a.family.id > b.family.id ? 1 : 0)
    ))
    .map(({ family }) => family);
}

describe('model tree', () => {
  it('features exactly the creators with a featured release and lists every release once', () => {
    // `modelTreeReleaseIds` spans both branches (model-tree.ts:124-130 via
    // :103-105), so comparing it against the featured creators' releases alone
    // held only while Others was empty. Both datasets are held to one rule, and
    // the fixture supplies the populated case.
    for (const source of [dataset, datasetWithOtherCreators]) {
      const tree = buildModelTree(source);
      const expectedCreatorIds = [...new Set(
        source.releases.filter(({ featured }) => featured).map(({ organizationId }) => organizationId),
      )].sort();
      const actualCreatorIds = tree.featured.map(({ organization }) => organization.id).sort();
      const actualReleaseIds = modelTreeReleaseIds(tree).sort();

      expect(actualCreatorIds).toEqual(expectedCreatorIds);
      expect(actualReleaseIds).toEqual(renderedReleaseIds(source));
      // Reachability is all the builder promises; validateDataset is what makes
      // it the whole catalog, refusing a release whose familyId is missing or
      // whose organizationId disagrees with its family (validate.ts:503-513).
      // Asserted separately so a release silently vanishing from the tree is
      // caught rather than mirrored by the derivation above.
      expect(actualReleaseIds).toEqual(source.releases.map(({ id }) => id).sort());
      expect(new Set(actualReleaseIds).size).toBe(actualReleaseIds.length);
    }

    // Guards the loop against going vacuous: unless the fixture actually feeds
    // releases through Others, both iterations exercise the same empty-Others
    // shape and prove nothing the old assertion did not.
    const fixtureOtherReleaseIds = buildModelTree(datasetWithOtherCreators).others
      .flatMap(({ families }) => families.flatMap(({ releases }) => releases.map(({ id }) => id)));

    expect(fixtureOtherReleaseIds.length).toBeGreaterThan(0);
  });

  it('orders creators deterministically and families/releases newest first with ID ties', () => {
    const tree = buildModelTree(dataset);

    expect(tree.featured.map(({ organization }) => organization.name)).toEqual(
      [...tree.featured.map(({ organization }) => organization.name)].sort(),
    );
    for (const creator of tree.featured) {
      // Which families a creator shows, and in what order, derived from the
      // dataset for every featured creator rather than named for one. Naming
      // Anthropic's two families here made adding any Claude generation fail
      // this test, so a researched release could not ship without editing it —
      // the block issue #439 records. The rule below holds whatever families
      // the catalog grows.
      const expectedFamilies = renderedFamilies(dataset, creator.organization.id);

      expect(creator.families.map(({ family }) => family.id))
        .toEqual(expectedFamilies.map(({ id }) => id));
      expect(creator.families.map(({ family }) => family.name))
        .toEqual(expectedFamilies.map(({ name }) => name));

      const familyKeys = creator.families.map(({ family, releases }) => ({
        id: family.id,
        newestReleaseDate: releases[0].releaseDate,
      }));
      expect(familyKeys).toEqual([...familyKeys].sort((a, b) => (
        b.newestReleaseDate < a.newestReleaseDate
          ? -1
          : b.newestReleaseDate > a.newestReleaseDate
            ? 1
            : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      )));
      for (const { releases } of creator.families) {
        const keys = releases.map(({ releaseDate, id }) => `${releaseDate}\0${id}`);
        const expected = [...keys].sort((a, b) => {
          const [aDate, aId] = a.split('\0');
          const [bDate, bId] = b.split('\0');
          return bDate.localeCompare(aDate) || (aId < bId ? -1 : aId > bId ? 1 : 0);
        });
        expect(keys).toEqual(expected);
      }
    }

    // Guards the derivation against being trivially satisfiable: unless some
    // creator carries more than one family, the ordering claim above holds for
    // any implementation at all.
    expect(tree.featured.some(({ families }) => families.length > 1)).toBe(true);
  });

  it('puts exactly the creators that hold releases but none featured in Others', () => {
    // Asserting only against the live catalog would prove nothing: its Others is
    // empty today, so a broken derivation would pass too. The fixture carries the
    // populated case, and both datasets are held to the same rule.
    for (const source of [dataset, datasetWithOtherCreators]) {
      const tree = buildModelTree(source);

      expect(tree.others.map(({ organization }) => organization.id).sort())
        .toEqual(creatorIdsWithoutFeaturedRelease(source));
    }

    expect(creatorIdsWithoutFeaturedRelease(datasetWithOtherCreators).length).toBeGreaterThan(0);
  });

  it('resolves a deep link to a release and rejects ids outside the tree', () => {
    const tree = buildModelTree(dataset);
    const first = tree.featured[0].families[0].releases[0];

    expect(findModelTreePath(tree, first.id)).toEqual({
      creatorId: first.organizationId,
      familyId: first.familyId,
      releaseId: first.id,
    });
    expect(findModelTreePath(tree, 'not-a-release')).toBeUndefined();
    expect(findModelTreePath(tree, null)).toBeUndefined();
  });

  it('restores a valid deep link by opening its creator and family only', () => {
    const tree = buildModelTree(dataset);
    const release = tree.featured.at(-1)!.families.at(-1)!.releases.at(-1)!;

    expect(restoreModelTreeSelection(tree, release.id)).toEqual({
      selectedReleaseId: release.id,
      openCreatorIds: [release.organizationId],
      openFamilyIds: [release.familyId],
    });
    expect(restoreModelTreeSelection(tree, 'invalid')).toEqual({
      openCreatorIds: [],
      openFamilyIds: [],
    });
  });

  it('toggles disclosures independently so multiple branches can remain open', () => {
    const withFirst = toggleModelTreeBranch(new Set<string>(), 'first');
    const withBoth = toggleModelTreeBranch(withFirst, 'second');
    const withoutFirst = toggleModelTreeBranch(withBoth, 'first');

    expect([...withBoth]).toEqual(['first', 'second']);
    expect([...withoutFirst]).toEqual(['second']);
  });
});

/**
 * The creators this repository keeps a dedicated reviewed source profile for, as
 * the files at the top level of `tools/updater/profiles/`. That set is the
 * featured criterion: featuring says this repository has vetted a creator's
 * sources in depth, which is a fact about our own editorial coverage and not a
 * claim about the models, their size, or their standing.
 *
 * Written out here rather than read from that directory, for two reasons.
 * `web-ci` skips the web build entirely when a change touches only
 * `tools/updater/`, so a test that read those files could go red on main with no
 * check reporting it. And listing them makes granting a profile and moving a
 * creator one reviewable change, which is the coupling the criterion wants.
 *
 * Neither sibling directory counts. `tools/updater/profiles/generic/` holds the
 * long-tail review policy, and `tools/updater/profiles/origins/` holds approved
 * source hosts for cohere, microsoft, mistral-ai and xai; its README states that
 * those documents "are **not** profiles, and they join neither reviewed set" and
 * that adding a creator there "does **not** promote it to a pilot creator".
 */
const CREATORS_WITH_A_REVIEWED_PROFILE = [
  'alibaba-cloud',
  'amazon',
  'anthropic',
  'google-deepmind',
  'meta',
  'microsoft',
  'openai',
];

/** Catalog creators that hold releases but no reviewed source profile. */
const CREATORS_WITHOUT_A_REVIEWED_PROFILE = ['cohere', 'deepseek', 'mistral-ai', 'xai'];

describe('featured membership follows the reviewed source profile set', () => {
  const tree = buildModelTree(dataset);
  const creatorName = (id: string) => dataset.organizations.find((item) => item.id === id)!.name;

  it('features exactly the creators with a reviewed source profile', () => {
    // Render order, not a sorted comparison: `buildCreators` orders by creator
    // name then id (model-tree.ts:52), which here reads Alibaba Cloud, Amazon,
    // Anthropic, Google DeepMind, Meta, Microsoft, OpenAI.
    expect(tree.featured.map(({ organization }) => organization.id))
      .toEqual(CREATORS_WITH_A_REVIEWED_PROFILE);
    expect(tree.featured.map(({ organization }) => organization.name))
      .toEqual([
        'Alibaba Cloud',
        'Amazon',
        'Anthropic',
        'Google DeepMind',
        'Meta',
        'Microsoft',
        'OpenAI',
      ]);
  });

  it('puts every catalog creator without a reviewed profile under Others', () => {
    // Also render order. The names are what decide it: Cohere, DeepSeek,
    // Mistral AI, then SpaceXAI, whose recorded name sorts under S while its id
    // sorts last anyway -- so this ordering is asserted by name below rather
    // than resting on the two happening to agree.
    expect(tree.others.map(({ organization }) => organization.id))
      .toEqual(CREATORS_WITHOUT_A_REVIEWED_PROFILE);
    expect(tree.others.map(({ organization }) => organization.name))
      .toEqual(['Cohere', 'DeepSeek', 'Mistral AI', 'SpaceXAI']);
    // The branch this change exists to populate must not be empty, and the two
    // branches must partition the catalog rather than merely both being present.
    expect(tree.others.length).toBeGreaterThan(0);
    expect([...tree.featured, ...tree.others].map(({ organization }) => organization.id).sort())
      .toEqual([...CREATORS_WITH_A_REVIEWED_PROFILE, ...CREATORS_WITHOUT_A_REVIEWED_PROFILE].sort());
  });

  it('moves creators between branches without dropping a single release', () => {
    // The risk this change carries: a reader would experience a release that
    // fell out of the tree as the site being wrong. Set equality rather than a
    // count, which is both exact and stronger -- a count of the catalog's
    // releases still passes if one release is swapped for another -- and which
    // does not have to be edited every time a researched release lands.
    expect(modelTreeReleaseIds(tree).sort()).toEqual(dataset.releases.map(({ id }) => id).sort());

    const othersReleaseIds = tree.others.flatMap(({ families }) => (
      families.flatMap(({ releases }) => releases.map(({ id }) => id))
    ));
    const featuredReleaseIds = tree.featured.flatMap(({ families }) => (
      families.flatMap(({ releases }) => releases.map(({ id }) => id))
    ));

    for (const creatorId of CREATORS_WITHOUT_A_REVIEWED_PROFILE) {
      const owned = dataset.releases
        .filter(({ organizationId }) => organizationId === creatorId)
        .map(({ id }) => id);

      // Positive control: a creator contributing nothing would satisfy every
      // assertion below without proving anything, so require it to hold
      // releases before asking where they went.
      expect(owned.length).toBeGreaterThan(0);
      expect(othersReleaseIds).toEqual(expect.arrayContaining(owned));
      for (const releaseId of owned) expect(featuredReleaseIds).not.toContain(releaseId);
    }

    // Every one of those releases is reachable by deep link too, not merely
    // present in the branch arrays.
    for (const release of dataset.releases) {
      expect(findModelTreePath(tree, release.id)).toBeDefined();
    }
  });

  it('leaves the reclassified creators with no featured release and no stale rationale', () => {
    for (const creatorId of CREATORS_WITHOUT_A_REVIEWED_PROFILE) {
      const owned = dataset.releases.filter(({ organizationId }) => organizationId === creatorId);

      expect(owned.length).toBeGreaterThan(0);
      expect(owned.filter(({ featured }) => featured)).toEqual([]);
      // A rationale for a placement that no longer applies would read as a live
      // editorial claim about a creator on the Others branch.
      expect(owned.filter(({ featuredRationale }) => featuredRationale !== undefined)).toEqual([]);
    }

    // And the criterion has not quietly emptied the other branch: the page
    // invariant at tree.astro:21 needs a featured release to exist at all.
    expect(dataset.releases.some(({ featured }) => featured)).toBe(true);
    expect(CREATORS_WITH_A_REVIEWED_PROFILE.map(creatorName)).toEqual([
      'Alibaba Cloud',
      'Amazon',
      'Anthropic',
      'Google DeepMind',
      'Meta',
      'Microsoft',
      'OpenAI',
    ]);
  });
});

describe('tree page source', () => {
  const page = readFileSync(new URL('../pages/tree.astro', import.meta.url), 'utf8');

  it('cannot throw its missing-featured-release guard against the real catalog', () => {
    // The page derives its passport link from tree.featured[0].families[0]
    // .releases[0] and throws when that is absent (tree.astro:20-21). Reproduced
    // here rather than described, so a catalog that stopped satisfying it fails
    // a named test instead of a build step.
    const tree = buildModelTree(dataset);

    expect(tree.featured[0]?.families[0]?.releases[0]).toBeDefined();
    expect(() => {
      const firstRelease = tree.featured[0]?.families[0]?.releases[0];
      if (!firstRelease) throw new Error('Model Tree requires at least one featured ecosystem release');
    }).not.toThrow();
  });

  it('still guards rather than trusting the catalog to be non-empty', () => {
    // The assertion above is only worth something while the page actually
    // carries the guard it reproduces.
    expect(page).toContain('const firstRelease = tree.featured[0]?.families[0]?.releases[0];');
    expect(page).toContain('Model Tree requires at least one featured ecosystem release');
  });

  it('names the branches that really start open, Others included', () => {
    // ModelTreeExplorer.tsx:24-26 initialises rootOpen, featuredOpen and
    // othersOpen to true, so naming only two of the three understated the
    // disclosure state as soon as Others held anything.
    expect(page).toContain('AI Model Ecosystem, Featured ecosystems, and Others start open.');
    expect(page).not.toContain('AI Model Ecosystem and Featured ecosystems start open.');
  });

  it('states the featured criterion without ranking the models', () => {
    expect(page).toContain('Featured placement is editorial and non-ranked');
    expect(page).toContain('a creator is featured when this repository keeps a reviewed source profile for it');
    // No composite score, rank, or prominence claim may enter this copy.
    for (const word of ['leading', 'top ', 'major', 'most important', 'best', 'rank the', 'score']) {
      expect(page.toLowerCase()).not.toContain(word);
    }
  });
});

describe('model tree Others branch', () => {
  const tree = buildModelTree(datasetWithOtherCreators);

  it('collects every creator that has releases but no featured release', () => {
    const expected = datasetWithOtherCreators.organizations
      .filter(({ id }) => (
        datasetWithOtherCreators.releases.some((release) => release.organizationId === id)
        && !datasetWithOtherCreators.releases.some(
          (release) => release.organizationId === id && release.featured,
        )
      ))
      .map(({ id }) => id)
      .sort();

    expect(tree.others.map(({ organization }) => organization.id).sort()).toEqual(expected);
    expect(tree.others.length).toBeGreaterThan(0);
  });

  it('places every creator in exactly one branch and keeps featured creators whole', () => {
    const featuredIds = tree.featured.map(({ organization }) => organization.id);
    const otherIds = tree.others.map(({ organization }) => organization.id);

    expect(otherIds.filter((id) => featuredIds.includes(id))).toEqual([]);
    // OpenAI carries non-featured releases; they stay with their featured creator.
    const openai = tree.featured.find(({ organization }) => organization.id === 'openai')!;
    const openaiReleaseIds = openai.families.flatMap(({ releases }) => releases.map(({ id }) => id));
    const nonFeatured = datasetWithOtherCreators.releases
      .filter(({ organizationId, featured }) => organizationId === 'openai' && !featured);

    expect(nonFeatured.length).toBeGreaterThan(0);
    for (const release of nonFeatured) expect(openaiReleaseIds).toContain(release.id);
  });

  it('orders others by creator name then id, families and releases newest first', () => {
    const otherIds = tree.others.map(({ organization }) => organization.id);
    // The fixture derives from the live dataset (fixtures/model-tree-dataset.ts:1),
    // so a non-featured creator in the catalog joins Others alongside the
    // synthetic ones. Filtering to the synthetic ids keeps the claim exact
    // without assuming the catalog contributes none: ordering is a total order,
    // so relative position survives whatever interleaves with them, and these
    // three still prove name ordering and the id tiebreak.
    expect(otherIds.filter((id) => expectedOtherCreatorIds.includes(id)))
      .toEqual(expectedOtherCreatorIds);

    // The ordering rule itself, over whatever Others actually holds. `\0` sorts
    // below any printable character, so this is name first, then id.
    const orderKeys = tree.others.map(({ organization }) => `${organization.name}\0${organization.id}`);

    expect(orderKeys).toEqual([...orderKeys].sort());

    const zulu = tree.others.find(({ organization }) => organization.id === 'other-zulu')!;

    // other-zulu-void holds no releases and is dropped rather than rendered.
    expect(zulu.families.map(({ family }) => family.id)).toEqual([
      'other-zulu-nova',
      'other-zulu-atlas',
      'other-zulu-orion',
    ]);
    expect(zulu.families[0].releases.map(({ id }) => id)).toEqual([
      'other-zulu-nova-one',
      'other-zulu-nova-two',
      'other-zulu-nova-old',
    ]);
  });

  it('reports release ids from both branches exactly once', () => {
    const ids = modelTreeReleaseIds(tree);
    const featuredIds = tree.featured.flatMap(({ families }) => (
      families.flatMap(({ releases }) => releases.map(({ id }) => id))
    ));
    const otherBranchIds = tree.others.flatMap(({ families }) => (
      families.flatMap(({ releases }) => releases.map(({ id }) => id))
    ));
    // What the fixture adds on top of the live catalog, whatever the catalog
    // itself now holds. The old `featuredIds.length + 7` assumed the catalog
    // contributed nothing to Others, which is the assumption this issue removes.
    const syntheticIds = datasetWithOtherCreators.releases
      .filter(({ id }) => !dataset.releases.some((release) => release.id === id))
      .map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('other-zulu-nova-one');
    expect(ids).toContain('other-alpha-core-one');
    expect(ids.length).toBe(featuredIds.length + otherBranchIds.length);
    expect(syntheticIds.length).toBeGreaterThan(0);
    expect(otherBranchIds).toEqual(expect.arrayContaining(syntheticIds));
    expect(ids).toEqual(expect.arrayContaining(featuredIds));
  });

  it('resolves and restores a deep link to a release under others', () => {
    expect(findModelTreePath(tree, 'other-zulu-atlas-one')).toEqual({
      creatorId: 'other-zulu',
      familyId: 'other-zulu-atlas',
      releaseId: 'other-zulu-atlas-one',
    });
    expect(restoreModelTreeSelection(tree, 'other-zulu-atlas-one')).toEqual({
      selectedReleaseId: 'other-zulu-atlas-one',
      openCreatorIds: ['other-zulu'],
      openFamilyIds: ['other-zulu-atlas'],
    });
  });
});
