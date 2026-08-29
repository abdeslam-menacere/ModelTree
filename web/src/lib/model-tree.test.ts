import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import { datasetWithOtherCreators, expectedOtherCreatorIds } from '../../tests/fixtures/model-tree-dataset';
import type { Dataset, Organization } from '../data/schema';
import { compareLabels, organizationLabel } from './organization-name';
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
 * The five creators this site leads with, in the order `/tree` renders them
 * (`buildCreators` sorts by creator name then id, so this reads Anthropic,
 * Google DeepMind, Meta, Microsoft, OpenAI).
 *
 * This is an editorial choice about the site's entry point, not a measurement
 * and not a ranking: the list states no order of merit, no score, and no claim
 * that a creator on it is larger, better, or more important than one off it. The
 * procedure that governs it is pinned beside `releaseSchema.featured` in
 * `src/data/schema.ts`, published word for word on the methodology page and in
 * `docs/product/INFORMATION-ARCHITECTURE.md`, and held to the catalog by
 * `src/data/featured-policy.test.ts`.
 *
 * Written out here rather than derived, because deriving it from the same
 * `featured` flag this file is checking would assert nothing, and because there
 * is nothing else to derive it from: an editorial choice has no measurable
 * property standing behind it, and inventing one would be inventing the
 * universal ranking this repository forbids.
 *
 * Featuring decides where the site starts a reader and nothing else. It does not
 * decide coverage: a creator this list omits keeps every release, its place on
 * the Others branch, and its own generated provider page (`lib/routes.ts`).
 */
const CREATORS_THE_SITE_LEADS_WITH = [
  'anthropic',
  'google-deepmind',
  'meta',
  'microsoft',
  'openai',
];

/**
 * Catalog creators the lead list omits, which is the whole of why they render
 * under Others. Nothing about their records, sources, or coverage differs.
 *
 * The order here is not alphabetical convenience: it is whatever the creator
 * comparator in `buildCreators` produces, which is the creator *label*,
 * compared case-insensitively, then the id. Both halves carry weight and both
 * are pinned by tests below rather than described here -- one asserts the key
 * is the label rather than the recorded name, the other that the comparison
 * folds case. If that comparator changes, this list changes with it, and those
 * assertions are meant to go red until it does.
 */
const CREATORS_THE_SITE_DOES_NOT_LEAD_WITH = [
  'ai2',
  'ai21-labs',
  'alibaba-cloud',
  'amazon',
  'cohere',
  'deepseek',
  'mistral-ai',
  'moonshot-ai',
  'nvidia',
  'tii',
  'xai',
  'zhipu-ai',
];

describe("featured membership follows the site's editorial lead list", () => {
  const tree = buildModelTree(dataset);
  const creatorName = (id: string) => dataset.organizations.find((item) => item.id === id)!.name;

  it('features exactly the five creators the site leads with', () => {
    // Render order, not a sorted comparison: `buildCreators` orders by creator
    // Render order, not a sorted comparison: `buildCreators` orders by the
    // creator label, then the id.
    //
    // Note for anyone reading this as comparator coverage: it is not. Every
    // featured creator's label sits in the same slot as its recorded name, and
    // none of them begins with a lowercase letter, so this ordering is
    // identical under either sort key and under either comparator -- it would
    // still pass with both reverted. The Others tests below are what pin them,
    // and they carry guards saying so.
    expect(tree.featured.map(({ organization }) => organization.id))
      .toEqual(CREATORS_THE_SITE_LEADS_WITH);
    expect(tree.featured.map(({ organization }) => organization.name))
      .toEqual([
        'Anthropic',
        'Google DeepMind',
        'Meta',
        'Microsoft',
        'OpenAI',
      ]);
  });

  it('puts every catalog creator the list omits under Others', () => {
    // Also render order, and what pins it is the comparator in `buildCreators`.
    // This is an assertion about the code, not about the alphabet: where a
    // creator's recorded name and its label disagree on an order, this list is
    // sensitive to which of the two the comparator reads, so a comparator
    // change cannot pass it unnoticed the way an alphabetical coincidence
    // would.
    expect(tree.others.map(({ organization }) => organization.id))
      .toEqual(CREATORS_THE_SITE_DOES_NOT_LEAD_WITH);
    // The recorded names in that same render order. This list is deliberately
    // *not* alphabetical: that it reads out of order is the rule working, since
    // the sort key is the label and these are the fuller recorded forms.
    expect(tree.others.map(({ organization }) => organization.name))
      .toEqual([
        'Allen Institute for AI',
        'AI21 Labs',
        'Alibaba Cloud',
        'Amazon',
        'Cohere',
        'DeepSeek',
        'Mistral AI',
        'Moonshot AI',
        'NVIDIA',
        'Technology Innovation Institute',
        'SpaceXAI',
        'Zhipu AI',
      ]);
    // The branch this change exists to populate must not be empty, and the two
    // branches must partition the catalog rather than merely both being present.
    expect(tree.others.length).toBeGreaterThan(0);
    expect([...tree.featured, ...tree.others].map(({ organization }) => organization.id).sort())
      .toEqual([...CREATORS_THE_SITE_LEADS_WITH, ...CREATORS_THE_SITE_DOES_NOT_LEAD_WITH].sort());
  });

  it('orders Others by a key that recorded-name order would get wrong', () => {
    // Vacuity guard for the expectation above. An ordering assertion can only
    // pin a sort key while the two candidate keys actually disagree on this
    // data; if they ever agree, the expectation silently stops testing anything
    // and would pass against a reverted key. That is not hypothetical: when
    // this test was written the expectation above had, until shortly before,
    // listed only creators that sorted identically under both keys, so it was
    // structurally incapable of detecting the thing it exists to pin. Hence
    // assert the disagreement rather than assuming it persists.
    //
    // The *comparator* is held constant here and varied in the test below, so
    // that a failure names which of the two moved.
    const sortedBy = (key: (organization: Organization) => string) => (
      [...tree.others.map(({ organization }) => organization)]
        .sort((a, b) => compareLabels(key(a), key(b)) || compareLabels(a.id, b.id))
        .map(({ id }) => id)
    );

    const byLabel = sortedBy(organizationLabel);
    const byRecordedName = sortedBy(({ name }) => name);

    expect(byLabel).not.toEqual(byRecordedName);
    expect(tree.others.map(({ organization }) => organization.id)).toEqual(byLabel);
    // Name the crossing, so a future data change that removes it fails here
    // with a readable reason instead of quietly halving the guard.
    expect(byLabel.indexOf('ai2')).toBeLessThan(byLabel.indexOf('ai21-labs'));
    expect(byRecordedName.indexOf('ai2')).toBeGreaterThan(byRecordedName.indexOf('ai21-labs'));
  });

  it('orders creators case-insensitively, so a lowercase label is not exiled to the end', () => {
    // Choosing the label as the sort key is only half of "a creator appears
    // where the reader looks for it". A raw code-unit comparison puts every
    // lowercase initial after every uppercase one, which filed `xai` correctly
    // under X while rendering it after the Zs -- the same complaint #479 exists
    // to answer, moved from the letter to the position.
    const creators = tree.others.map(({ organization }) => organization);
    const startsLowercase = ({ shortName }: Organization) => (
      shortName.slice(0, 1) !== shortName.slice(0, 1).toUpperCase()
    );

    // Vacuity guard: with no lowercase-initial label the two comparators agree
    // and every assertion below passes for free. Say so rather than pass.
    expect(creators.filter(startsLowercase).length).toBeGreaterThan(0);

    const rendered = creators.map(({ id }) => id);
    // The property, not the arrangement: `xai` belongs between `tii` and
    // `zhipu-ai`, where a reader scanning A-Z looks for X. Pinning it relative
    // to its neighbours survives new creators landing either side of it, which
    // a frozen list of every creator would not.
    expect(rendered.indexOf('tii')).toBeLessThan(rendered.indexOf('xai'));
    expect(rendered.indexOf('xai')).toBeLessThan(rendered.indexOf('zhipu-ai'));

    // ...and the comparator is what puts it there. Sorting the same records by
    // the same key under a code-unit comparison is the ordering this test
    // exists to reject, so assert the two differ rather than trusting that
    // they would.
    const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byCodeUnit = [...creators]
      .sort((a, b) => (
        codeUnit(organizationLabel(a), organizationLabel(b)) || codeUnit(a.id, b.id)
      ))
      .map(({ id }) => id);

    expect(byCodeUnit.at(-1)).toBe('xai');
    expect(rendered).not.toEqual(byCodeUnit);
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

    for (const creatorId of CREATORS_THE_SITE_DOES_NOT_LEAD_WITH) {
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

  it('leaves the creators the list omits with no featured release and no stale rationale', () => {
    for (const creatorId of CREATORS_THE_SITE_DOES_NOT_LEAD_WITH) {
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
    expect(CREATORS_THE_SITE_LEADS_WITH.map(creatorName)).toEqual([
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
    expect(page).toContain('a creator is featured when it is one of the five this site leads with');
    // The superseded criterion must not survive anywhere in this copy.
    expect(page).not.toContain('reviewed source profile');
    // The page must also say what featuring does not cost a creator, because the
    // whole risk of an editorial lead list is reading as a coverage judgement.
    expect(page).toContain('keeps every release, its place under Others, and its own provider page');
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
    // below any printable character, so this is label first, then id. The
    // ordering key is the creator label (`shortName`) — see
    // `organization-name.ts` — not the fuller recorded `name`, and the
    // comparator is that module's, not a second one written here: a lowercase
    // label orders among the uppercase ones rather than after all of them.
    const orderKeys = tree.others.map(
      ({ organization }) => `${organizationLabel(organization)}\0${organization.id}`,
    );

    expect(orderKeys).toEqual([...orderKeys].sort(compareLabels));

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
