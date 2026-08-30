import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import type { Dataset, Organization } from '../data/schema';
import { buildCatalogIndex } from './catalog';
import { defaultCatalogState, filterAndSortModels } from './catalog-view';
import {
  buildComparisonCandidates,
  buildComparisonPickerIndex,
  buildModelComparison,
} from './comparison';
import { buildHomepageHierarchy } from './homepage';
import { buildHomepageSearchIndex, normalizeText, releaseMatchesQuery } from './homepage-search';
import { homeSuggestionsFor } from './homepage-search-view';
import { buildLineageEcosystems } from './lineage-view';
import { buildModelTree } from './model-tree';
import {
  compareLabels,
  organizationFullName,
  organizationFullNameIfDistinct,
  organizationLabel,
  organizationSearchTerms,
} from './organization-name';
import { buildModelPassport } from './passport';
import { buildProviderDirectory, directoryInitial, matchesDirectorySearch } from './provider-directory';
import { buildTimelineIndex } from './timeline';

/**
 * The creator naming rule -- abdeslam-menacere/ModelTree#479.
 *
 * The defect was not one bad record. It was that every surface picked a name
 * field for itself, all of them picked `name`, and nothing said they had to
 * agree. So these tests assert the rule at the surfaces rather than only at the
 * helper: a helper nobody calls fixes nothing, and that is exactly the shape of
 * the original defect.
 *
 * Nothing here hard-codes how many organizations exist. The dataset grows
 * without a code change, and a test that counted would have to be edited every
 * time it did -- which is how a test stops being read.
 */

const BASE = '/';
// Any fixed date works here: nothing below asserts on staleness, and a fixed
// value keeps the sweep from changing behaviour with the calendar.
const TODAY = '2026-01-01';

function everyOrganization(): Organization[] {
  return dataset.organizations;
}

describe('the creator naming rule', () => {
  it('has organizations to check, so a passing sweep below means something', () => {
    // The control for every "for each organization" assertion in this file: an
    // empty dataset would satisfy all of them vacuously.
    expect(everyOrganization().length).toBeGreaterThan(0);
  });

  it('labels an organization by its shortName', () => {
    for (const organization of everyOrganization()) {
      expect(organizationLabel(organization)).toBe(organization.shortName);
      expect(organizationFullName(organization)).toBe(organization.name);
    }
  });

  it('names the fuller recorded form only where it differs from the label', () => {
    for (const organization of everyOrganization()) {
      const distinct = organizationFullNameIfDistinct(organization);
      if (organization.name === organization.shortName) expect(distinct).toBeNull();
      else expect(distinct).toBe(organization.name);
    }
  });

  it('keeps both recorded forms searchable, label first', () => {
    for (const organization of everyOrganization()) {
      const terms = organizationSearchTerms(organization);
      expect(terms[0]).toBe(organizationLabel(organization));
      expect(terms).toContain(organization.name);
      expect(terms).toContain(organization.shortName);
      // De-duplicated, so an organization whose two forms agree is not listed twice.
      expect(new Set(terms).size).toBe(terms.length);
    }
  });
});

describe('the rule is applied at every surface that names a creator', () => {
  it('orders the model tree by the label', () => {
    const tree = buildModelTree(dataset);
    for (const branch of [tree.featured, tree.others]) {
      const labels = branch.map(({ organization }) => organizationLabel(organization));
      expect(labels).toEqual([...labels].sort(compareLabels));
    }
  });

  it('displays and files directory creators by the label', () => {
    const directory = buildProviderDirectory(dataset, BASE);
    const creators = directory.groups.find((group) => group.id === 'creators')!.entries;
    expect(creators.length).toBeGreaterThan(0);

    const organizationById = new Map(everyOrganization().map((item) => [item.id, item]));
    for (const entry of creators) {
      const organization = organizationById.get(entry.id)!;
      expect(entry.name).toBe(organizationLabel(organization));
      // Filed under the letter of the string the reader actually sees. This is
      // the half of the defect that search hid: the A-Z bucket and the label
      // came from different places.
      expect(entry.initial).toBe(directoryInitial(organizationLabel(organization)));
      expect(entry.terms).toContain(organization.name.toLowerCase());
      expect(entry.terms).toContain(organization.shortName.toLowerCase());
    }
  });

  it('displays and files catalog provider rows by the label', () => {
    const index = buildCatalogIndex(dataset, BASE);
    const organizationBySlug = new Map(everyOrganization().map((item) => [item.slug, item]));
    expect(index.providers.length).toBeGreaterThan(0);

    for (const row of index.providers) {
      const organization = organizationBySlug.get(row.slug)!;
      const label = organizationLabel(organization);
      expect(row.name).toBe(label);
      expect(row.initial).toBe(/^[A-Z]$/.test(label.slice(0, 1).toUpperCase())
        ? label.slice(0, 1).toUpperCase()
        : '#');
    }
  });

  it('resolves every recorded name form to the label in the alias index', () => {
    const index = buildCatalogIndex(dataset, BASE);
    for (const organization of everyOrganization()) {
      for (const form of [organization.name, organization.shortName]) {
        const alias = index.aliases.find(
          (item) => item.entity === 'organization'
            && item.normalized === form.toLowerCase()
            && item.targetSlug === organization.slug,
        );
        expect(alias, `no alias for "${form}"`).toBeDefined();
        expect(alias!.label).toBe(organizationLabel(organization));
      }
    }
  });

  it('names the creator on a model row by the label', () => {
    const index = buildCatalogIndex(dataset, BASE);
    const organizationBySlug = new Map(everyOrganization().map((item) => [item.slug, item]));
    expect(index.models.length).toBeGreaterThan(0);

    for (const model of index.models) {
      const organization = organizationBySlug.get(model.organizationSlug)!;
      expect(model.organizationName).toBe(organizationLabel(organization));
    }
  });

  /**
   * The comparison picker was the last surface still reading `name`, and it is
   * the reason these assertions run against built surfaces rather than the
   * helper alone: it derives its own `organizationName` field, so a sweep for
   * the literal `organization.name` never saw it.
   */
  it('names the creator on a comparison picker entry by the label', () => {
    const organizationById = new Map(everyOrganization().map((item) => [item.id, item]));
    const releaseBySlug = new Map(dataset.releases.map((release) => [release.slug, release]));
    const candidates = buildComparisonCandidates(dataset, [], BASE);
    const rows = buildComparisonPickerIndex(dataset);
    expect(candidates.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);

    for (const entry of [...candidates, ...rows]) {
      const organization = organizationById.get(releaseBySlug.get(entry.slug)!.organizationId)!;
      expect(entry.organizationName).toBe(organizationLabel(organization));
    }
  });

  it('still matches a comparison candidate on the fuller recorded name', () => {
    const releaseBySlug = new Map(dataset.releases.map((release) => [release.slug, release]));
    const candidates = buildComparisonCandidates(dataset, [], BASE);

    // Chosen by the property under test: a creator whose two recorded forms
    // disagree is the only case where dropping `name` from search could lose a
    // reader, so a fixture whose forms happen to agree would prove nothing.
    const distinct = candidates.filter((candidate) => {
      const release = releaseBySlug.get(candidate.slug)!;
      const organization = everyOrganization().find((item) => item.id === release.organizationId)!;
      return organizationFullNameIfDistinct(organization) !== null;
    });
    expect(distinct.length).toBeGreaterThan(0);

    for (const candidate of distinct) {
      const release = releaseBySlug.get(candidate.slug)!;
      const organization = everyOrganization().find((item) => item.id === release.organizationId)!;
      expect(candidate.organizationSearchTerms).toContain(organizationFullName(organization));
      expect(candidate.organizationSearchTerms).toContain(organizationLabel(organization));
    }
  });

  it('still matches a catalog model row on the fuller recorded name', () => {
    // The reader-visible property, asserted through the real search predicate
    // rather than the field: before the label rule, typing a creator's fuller
    // recorded form into the catalog surfaced its models. It still must.
    const index = buildCatalogIndex(dataset, BASE);
    const search = (query: string) =>
      filterAndSortModels(index.models, { ...defaultCatalogState(), search: query })
        .map((row) => row.slug)
        .sort();

    const distinct = everyOrganization().filter(
      (organization) => organizationFullNameIfDistinct(organization) !== null,
    );
    // Vacuity guard: with no such creator every assertion below is trivially
    // true, so the sweep would pass over a dataset that cannot exercise it.
    expect(distinct.length).toBeGreaterThan(0);

    // Catalog search is a substring predicate, so a query that is contained in
    // another creator's recorded form legitimately surfaces that creator's
    // models too -- "AI2" is a substring of "AI21", so typing it reaches both
    // the Allen Institute and AI21 Labs. That is search working, not the label
    // rule leaking, and a reader narrows it by typing one more character.
    //
    // Rather than loosen the claim to "contains its own models", which would
    // stop noticing genuine over-matching, the expected set is computed
    // exactly: the creator's own models, plus the models of every other
    // creator whose own recorded forms contain the query.
    const modelsOf = (slug: string) => index.models
      .filter((row) => row.organizationSlug === slug)
      .map((row) => row.slug);
    const expectedFor = (query: string, organization: Organization) => {
      const needle = query.toLowerCase();
      const alsoReached = everyOrganization()
        .filter((other) => other.id !== organization.id)
        .filter((other) => organizationSearchTerms(other)
          .some((term) => term.toLowerCase().includes(needle)))
        .flatMap((other) => modelsOf(other.slug));
      return [...modelsOf(organization.slug), ...alsoReached].sort();
    };

    let strictCreators = 0;
    let collidingCreators = 0;

    for (const organization of distinct) {
      const own = modelsOf(organization.slug).sort();
      if (!own.length) continue;

      // Either recorded form reaches the creator's models; neither is privileged.
      for (const query of [organizationFullName(organization), organizationLabel(organization)]) {
        const expected = expectedFor(query, organization);
        expect(search(query)).toEqual(expected);
        // Reachability is the property #479 is actually about: whichever form a
        // reader types, every one of this creator's models is in the result.
        for (const slug of own) expect(search(query)).toContain(slug);
        if (expected.length === own.length) strictCreators += 1;
        else collidingCreators += 1;
      }

      // ...while what those rows display stays the label.
      for (const row of index.models.filter((item) => item.organizationSlug === organization.slug)) {
        expect(row.organizationName).toBe(organizationLabel(organization));
      }
    }

    // Two-directional vacuity guard on the branch structure above. Most
    // creators must still be matched exactly -- if collisions became the norm
    // the assertion would have stopped constraining anything -- and the
    // colliding branch must be exercised by the AI2/AI21 pair the dataset
    // holds, or this accounting is dead code pretending to be coverage.
    expect(strictCreators).toBeGreaterThan(0);
    expect(collidingCreators).toBeGreaterThan(0);
    expect(collidingCreators).toBeLessThan(strictCreators);

    // Control: the predicate is not simply matching everything. A string in no
    // recorded form returns nothing, so the counts above discriminate.
    expect(search('zzz-not-a-recorded-creator-name')).toEqual([]);
  });

  it('names the creator on the comparison table\'s Creator row by the label', () => {
    // The row a reader compares two models by, labelled "Creator" in words.
    // The comparison payload and picker were fixed earlier; this is the table
    // body, built separately, and it was missed by both.
    // The slice matters. Only some organizations record two different forms, so
    // a slice taken off the top of the release list can be satisfied by either
    // field and would prove nothing. Select releases whose creator actually
    // distinguishes the two, and guard that the selection did.
    const distinguishes = new Set(
      everyOrganization()
        .filter((organization) => organizationFullNameIfDistinct(organization) !== null)
        .map((organization) => organization.id),
    );
    const slugs = dataset.releases
      .filter((release) => distinguishes.has(release.organizationId))
      .slice(0, 4)
      .map((release) => release.slug);
    // Vacuity guard: with no such release the comparison below cannot tell the
    // label from the fuller recorded form.
    expect(slugs.length).toBeGreaterThan(1);

    const view = buildModelComparison(dataset, slugs, BASE, TODAY);
    const organizationById = new Map(everyOrganization().map((item) => [item.id, item]));
    const releaseBySlug = new Map(dataset.releases.map((release) => [release.slug, release]));

    const creatorRow = view.groups
      .flatMap((group) => group.rows)
      .find((row) => row.id === 'creator');
    // Vacuity guard: no such row and every assertion below is skipped silently.
    expect(creatorRow, 'no Creator row in the comparison view').toBeDefined();
    expect(creatorRow!.label).toBe('Creator');

    const fullOnly = new Set(
      everyOrganization()
        .map(organizationFullNameIfDistinct)
        .filter((name): name is string => name !== null),
    );
    expect(fullOnly.size).toBeGreaterThan(0);

    let stated = 0;
    for (const cell of creatorRow!.cells) {
      if (cell.state !== 'stated') continue;
      stated += 1;
      const organization = organizationById.get(releaseBySlug.get(cell.slug)!.organizationId)!;
      expect(cell.value).toBe(organizationLabel(organization));
      // The defect restated: the fuller recorded form must not be what a
      // reader sees in a row literally labelled "Creator".
      expect(fullOnly.has(cell.value)).toBe(false);
    }
    expect(stated).toBeGreaterThan(0);
  });

  it('names a serving-platform operator by the label', () => {
    // An operator is an Organization record, so the rule reaches it too. The
    // platform is a different entity and keeps its own name -- relabelling the
    // organization that operates it collapses nothing.
    //
    // Honest limit: measured on this dataset, every platform operator is an
    // organization whose two recorded forms are identical, while some
    // organizations elsewhere in the dataset do differ. So this sweep cannot by
    // itself distinguish the label from the fuller form, and it is not the
    // coverage that discriminates. That is `provider-directory.test.ts`, whose
    // fixture operator deliberately records two different forms and which also
    // pins that both stay searchable. This test guards the rule as the dataset
    // grows: the day a differing operator is recorded, it acquires teeth
    // without being edited.
    const directory = buildProviderDirectory(dataset, BASE);
    const organizationById = new Map(everyOrganization().map((item) => [item.id, item]));
    const platformBySlug = new Map(dataset.servingPlatforms.map((item) => [item.slug, item]));

    const platforms = directory.groups
      .find((group) => group.id === 'serving-platforms')!
      .entries.filter((entry) => entry.kind === 'serving-platform');
    // Vacuity guard: no platforms and the loop below asserts nothing at all.
    expect(platforms.length).toBeGreaterThan(0);

    for (const entry of platforms) {
      const platform = platformBySlug.get(entry.slug)!;
      const operator = organizationById.get(platform.organizationId)!;
      expect(entry.operatorName).toBe(organizationLabel(operator));
      expect(entry.name).toBe(platform.name);

      for (const term of organizationSearchTerms(operator)) {
        expect(entry.terms, `operator term "${term}" lost on ${entry.slug}`).toContain(
          term.toLowerCase(),
        );
      }
    }
  });

  it('names the operator on a model passport availability row by the label', () => {
    // Same honest limit as the directory sweep above: today's two platform
    // operators record identical forms, so this pins the code path rather than
    // discriminating between the two strings. It starts discriminating on its
    // own the day a differing operator is recorded.
    const organizationById = new Map(everyOrganization().map((item) => [item.id, item]));
    const platformById = new Map(dataset.servingPlatforms.map((item) => [item.id, item]));
    const deploymentById = new Map(dataset.deployments.map((item) => [item.id, item]));

    let checked = 0;
    for (const release of dataset.releases) {
      const passport = buildModelPassport(dataset, release.id, BASE, TODAY);
      for (const row of passport.availability) {
        const platform = platformById.get(deploymentById.get(row.id)!.platformId);
        if (!platform) continue;
        const operator = organizationById.get(platform.organizationId);
        if (!operator) continue;
        expect(row.operatorName).toBe(organizationLabel(operator));
        expect(row.platformName).toBe(platform.name);
        checked += 1;
      }
    }
    // Vacuity guard: a dataset recording no deployment would pass silently.
    expect(checked).toBeGreaterThan(0);
  });
});

/**
 * Ordering, and the derived fields that carry a creator's name into a surface
 * without ever naming the record.
 *
 * A comparator that destructures -- `(a, b) => compare(a.name, b.name)` -- never
 * spells `organization.name`, so no sweep for that spelling can reach it. It
 * also does not surface to a reader as a wrong name: it surfaces as a broken
 * alphabet. The homepage listed DeepMind after DeepSeek because it ordered on
 * "Google DeepMind" while printing "DeepMind", and nothing on the page said why.
 *
 * So these assertions ask the only question that survives a refactor: is the
 * order a reader sees the order of the strings the reader was shown.
 */
describe('the creator naming rule where creators are ordered', () => {
  // The comparator the surfaces under test use, rather than a second one
  // written here. Ordering is case-insensitive so that a lowercase label is
  // filed where a reader scanning A-Z looks for it; re-deriving that rule in
  // the oracle is how an oracle comes to disagree with the code it checks.
  // Deliberately not a locale collation: this asserts that ordering and
  // display agree, and is not the place to change how either sorts.
  const isNonDecreasing = (values: string[]) => values.every(
    (value, index) => index === 0 || compareLabels(values[index - 1], value) <= 0,
  );

  const idsSortedBy = (key: (organization: Organization) => string) => [...everyOrganization()]
    .sort((a, b) => (
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
    ) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id }) => id);

  it('orders creators differently by label than by recorded name, so the assertions below can fail', () => {
    // The vacuity guard for this whole block. If the two recorded forms happened
    // to sort every creator the same way, an assertion that the emitted order
    // matches the label order would pass against the defect it exists to catch.
    expect(idsSortedBy(organizationLabel)).not.toEqual(idsSortedBy(organizationFullName));
  });

  it('lists creators on the homepage in the order of the names the homepage prints', () => {
    const hierarchy = buildHomepageHierarchy(dataset);
    expect(hierarchy.length).toBeGreaterThan(0);
    const ids = hierarchy.map((entry) => entry.organization.id);
    const labels = hierarchy.map((entry) => organizationLabel(entry.organization));
    expect(isNonDecreasing(labels)).toBe(true);

    // The same records ordered by the other candidate key, so the crossing below
    // is measured rather than assumed.
    const orderedBy = (key: (organization: Organization) => string) => hierarchy
      .map((entry) => entry.organization)
      .slice()
      .sort((a, b) => compareLabels(key(a), key(b)) || compareLabels(a.id, b.id))
      .map(({ id }) => id);
    const byRecordedName = orderedBy(organizationFullName);

    // The defect exactly as it shipped, on a pair this data still crosses:
    // `ai2` prints "AI2" and is recorded as "Allen Institute for AI", so the
    // label files it before `ai21-labs` and the recorded name files it after.
    //
    // Until #531 this anchor was "DeepMind" before "DeepSeek". That creator now
    // displays as "Google DeepMind", so its two forms agree and it can no longer
    // witness a disagreement between them -- and left alone the assertion would
    // not have failed, because `indexOf` of a label the page no longer prints
    // returns -1, which is less than any real position. It would have gone on
    // passing while testing nothing, so it was re-anchored rather than deleted.
    expect(ids).not.toEqual(byRecordedName);
    expect(ids.indexOf('ai2')).toBeLessThan(ids.indexOf('ai21-labs'));
    expect(byRecordedName.indexOf('ai2')).toBeGreaterThan(byRecordedName.indexOf('ai21-labs'));
  });

  it('lists creators in the lineage tree in the order of the names that tree prints', () => {
    const ecosystems = buildLineageEcosystems(dataset);
    expect(ecosystems.length).toBeGreaterThan(0);
    expect(isNonDecreasing(ecosystems.map((entry) => organizationLabel(entry.organization)))).toBe(true);
  });

  it('orders lineage ecosystems by the label even where the two orderings disagree', () => {
    // The assertion above cannot fail on today's data, and saying so is the
    // point: every creator on the featured set records the same string in both
    // name fields, so label order and recorded-name order coincide there and a
    // reverted sort key would pass. A guard that only holds while a release flag
    // happens not to change is not a guard.
    //
    // Featuring one release from each of two creators whose forms *do* differ --
    // the sole input the derivation reads -- restores the distinction without
    // inventing an organization or editing the dataset. The fixture is chosen by
    // the property under test: `ai2` prints "AI2" and is recorded as "Allen
    // Institute for AI", so it files before `ai21-labs` under the label and
    // after it under the recorded name.
    //
    // This was `google-deepmind` against `deepseek` until #531 decided that
    // creator displays as "Google DeepMind". Its two forms now agree, so it
    // cannot witness a disagreement between them; the fixture moved to a pair
    // that still can rather than the assertion being weakened.
    const witnesses = ['ai2', 'ai21-labs'];
    const promoted = witnesses.map((creatorId) => {
      const release = dataset.releases.find((item) => item.organizationId === creatorId);
      expect(release, `no ${creatorId} release available to feature`).toBeDefined();
      return release!.id;
    });

    const withWitnessesFeatured: Dataset = {
      ...dataset,
      releases: dataset.releases.map((release) => (
        promoted.includes(release.id) ? { ...release, featured: true } : release
      )),
    };

    const ecosystems = buildLineageEcosystems(withWitnessesFeatured);
    const ids = ecosystems.map((entry) => entry.organization.id);
    const labels = ecosystems.map((entry) => organizationLabel(entry.organization));

    // The vacuity guard: without both creators present the ordering below is
    // satisfied trivially.
    expect(ids).toContain('ai2');
    expect(ids).toContain('ai21-labs');
    expect(isNonDecreasing(labels)).toBe(true);

    const byRecordedName = ecosystems
      .map((entry) => entry.organization)
      .slice()
      .sort((a, b) => (
        compareLabels(organizationFullName(a), organizationFullName(b))
        || compareLabels(a.id, b.id)
      ))
      .map(({ id }) => id);

    // The defect restated. Ordering on the recorded name files this creator
    // under "Allen", which puts it after AI21 Labs.
    expect(ids.indexOf('ai2')).toBeLessThan(ids.indexOf('ai21-labs'));
    expect(byRecordedName.indexOf('ai2')).toBeGreaterThan(byRecordedName.indexOf('ai21-labs'));
  });

  it('names the creator on a timeline entry by the label', () => {
    const index = buildTimelineIndex(dataset, BASE);
    const organizationBySlug = new Map(everyOrganization().map((item) => [item.slug, item]));
    expect(index.entries.length).toBeGreaterThan(0);

    for (const entry of index.entries) {
      const organization = organizationBySlug.get(entry.creatorSlug)!;
      expect(entry.creatorName).toBe(organizationLabel(organization));
    }
  });

  it('labels the timeline creator filter by the label', () => {
    // The filter chips are counted off the entries above, so this follows from
    // the previous test -- which is exactly the reasoning that let the comparison
    // picker render "SpaceXAI" for a whole release. Asserted, not inferred.
    const index = buildTimelineIndex(dataset, BASE);
    const labels = new Set(everyOrganization().map(organizationLabel));
    expect(index.facets.creators.length).toBeGreaterThan(0);

    for (const facet of index.facets.creators) {
      expect(labels.has(facet.label), `unexpected creator facet "${facet.label}"`).toBe(true);
    }
  });
});

/**
 * The rule has to survive surfaces that do not exist yet.
 *
 * This has now happened three times. #504 extracted the lineage tree's detail
 * panel into a new component and carried the raw `organization.name` across with
 * it; #499 then added `lib/timeline.ts`, which did the same. Both landed on
 * `main` after this rule did, so no existing test covered either.
 *
 * The first version of this tripwire swept `components/*.tsx` only, which is
 * one reason `lib/timeline.ts` got through it -- but only one. Widening the
 * corpus alone still missed it, because the gate asked whether a module imports
 * the `Organization` *type*, and `timeline.ts` imports `Dataset` and reaches
 * organizations through it. So the gate asks the question it actually means:
 * does this module hold raw organization records, however it obtained them.
 * A module handed a prepared directory entry -- `ProviderDirectory.tsx`, whose
 * `organization.name` is an already-labelled view model -- does neither, and is
 * still correctly not swept.
 *
 * The third widening is the spelling. `comparison.ts` was inside the corpus and
 * satisfied the gate, and the sweep passed anyway, because that file never
 * writes `organization.name`: it reads the record back out of a Map, as
 * `organizationById.get(id)?.name`. Four sites were hiding behind that shape --
 * the comparison table's Creator row and three platform-operator names -- and
 * the same file had already cost this rule one miss for the same reason. So the
 * sweep now recognises the record by where it came from rather than by what the
 * variable holding it is called: it reads which Maps are built from
 * `dataset.organizations`, and flags a raw `.name` read off one of those, taken
 * directly or through a local alias. The identifier set is derived from the
 * source, so renaming `organizationById` does not blind it.
 *
 * The fourth widening is the file type. The sweep read `.tsx` and `.ts` only,
 * so the `.astro` surfaces where the site's pages actually render were outside
 * it entirely -- including three `.astro` files sitting inside the swept
 * `components/` directory, stepped over on suffix. Nothing displayed a raw
 * recorded name there, so this closed a latent gap rather than a live defect;
 * the guard is shown to fire on `.astro` by mutation instead, since correct
 * code staying green proves nothing. A citation surface complicates the
 * widening: `SourceList.astro` renders `publisher.name`, which is the recorded
 * first-party name of a distinct entity and correctly not a creator label, so
 * it is exempt by the same record-following gate -- it holds no Organization
 * record -- rather than by a path rule that would re-blind the surface.
 *
 * Two stages decide whether a surface is actually checked, and only the second
 * -- `holdsOrganizationRecords` -- reads the file. Discovery reaches every
 * `.astro`, but the gate judges a minority of the corpus by design, because
 * most swept modules hold already-labelled view models rather than raw records
 * (`ProviderDirectory.tsx` is the asserted case). So this is *not* blanket
 * `.astro` coverage: a file is guarded only once it trips a gate clause, and
 * the gate, not the corpus, bounds reach. Widening the corpus to `.astro`
 * surfaced this directly -- `index.astro` unpacks a real record in a callback
 * parameter, `hierarchy.map(({ organization }) => ...)`, a shape the gate did
 * not recognise, so it rendered a raw name unjudged until that clause was
 * added. The 'judges at least one .astro surface, so discovery is not the whole
 * story' assertion pins the judged `.astro` count above zero so a corpus that is
 * discovered but never judged fails loudly rather than passing on `lib/*.ts` alone.
 *
 * The gate now recognises a record by four routes: the schema type import, a
 * mention of `.organizations`, a `const { ... } =` destructure, and a
 * destructured callback parameter. A module that reaches a record any other way
 * is swept but not judged -- some correctly, because they hold a prepared view
 * model, which is exactly why `ProviderDirectory.tsx` is excluded by mechanism
 * rather than by path. One residual route is known and tracked as #546: a record
 * reached as a *property* of a prepared view, `view.organization`, which leaves
 * `ModelPassport.tsx` and `pages/models/[slug].astro` swept but unjudged even
 * though `passport.ts` declares that field as an `Organization`. It is named
 * here as a followable pointer rather than closed in this change.
 *
 * What it still cannot do is catch a surface that never names the record at
 * all -- a destructured sort comparator reading `a.name` is invisible to any
 * sweep for a shape. That class is guarded by the real-dataset assertions
 * above, which check the ordering a reader actually sees. Neither mechanism
 * subsumes the other, which is the reason both exist.
 */
describe('the creator naming rule on surfaces added later', () => {
  const LIB_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

  // The corpus is every source surface that can hold a creator record and render
  // it. The React components and lib modules the rule has always swept, plus the
  // `.astro` surfaces that are where the site's pages actually render: three sit
  // literally inside the swept `components/` directory and were skipped only on
  // suffix, the page tree lives under `pages/`, and the shared chrome under
  // `layouts/`. `.astro` is folded into the existing corpus rather than swept in
  // parallel, so the same record-following gate below judges every surface by
  // one rule. See abdeslam-menacere/ModelTree#528: the pages are correct today,
  // so this closes a latent gap rather than a live defect, and is proved to fire
  // by mutation rather than by watching already-correct code stay green.
  const roots = [
    { directory: fileURLToPath(new URL('../components', import.meta.url)), extensions: ['.tsx', '.astro'] },
    { directory: LIB_DIRECTORY, extensions: ['.ts'] },
    { directory: fileURLToPath(new URL('../pages', import.meta.url)), extensions: ['.astro'] },
    { directory: fileURLToPath(new URL('../layouts', import.meta.url)), extensions: ['.astro'] },
  ];

  // The walk recurses. `pages/` nests creator surfaces under `models/`,
  // `providers/` and `refresh/`, and a flat `readdirSync` would step over every
  // one of them -- which is the same "surface added later" failure mode this
  // tripwire exists to catch. Recursing also closes the secondary latent gap the
  // issue names: a future subdirectory under `lib/` or `components/` was invisible
  // before. `__snapshots__` is excluded because it holds generated snapshot data,
  // not source that can render a name.
  const EXCLUDED_DIRECTORIES = new Set(['__snapshots__']);

  function sourceFilesUnder(directory: string, extensions: string[]): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : sourceFilesUnder(full, extensions);
      }
      return extensions.some((extension) => entry.name.endsWith(extension)) ? [full] : [];
    });
  }

  // The rule module is the one place the raw field is read on purpose: it is
  // what every other module calls instead of reading it directly.
  const RULE_MODULE = 'organization-name.ts';

  const modules = roots.flatMap(({ directory, extensions }) => sourceFilesUnder(directory, extensions)
    .filter((path) => !path.includes('.test.') && basename(path) !== RULE_MODULE)
    .map((path) => ({
      file: relative(directory, path).split(sep).join('/'),
      directory,
      source: readFileSync(path, 'utf8'),
    })));

  /**
   * Identifiers of every Map in a module whose values are organization records.
   *
   * Derived from where the records come from -- `dataset.organizations` -- not
   * from what the variable is called, so the sweep still follows the record
   * after a rename.
   */
  function organizationMapIdentifiers(source: string): string[] {
    return [...source.matchAll(
      /const\s+([A-Za-z0-9_]+)\s*=\s*new Map\([^;]*?\.organizations\b[^;]*?\)/g,
    )].map(([, identifier]) => identifier);
  }

  /**
   * How near a `shortName` read must sit to a raw recorded-name read for the two
   * to read as one deliberate both-forms *search* construction rather than a
   * display. Reading the recorded name for matching is not the defect -- this
   * rule depends on it, because a creator must stay findable under either
   * recorded form -- so the sweep has to tell the two intents apart or it would
   * force a discoverability regression to go green.
   *
   * The window is measured rather than guessed: on the surface that motivated
   * it, every both-forms search construction sat an order of magnitude closer
   * to its `shortName` than any display read did, and this value falls inside
   * that gap and nearer the search end. So the first thing a careless widening
   * would swallow is a display site -- which is the direction that fails
   * loudly. The distances are not restated here, because a comment cannot fail
   * when the file they were measured from changes; the exemption is asserted
   * in both directions, including at distance, by 'exempts a both-forms search
   * construction and still flags a lone display read' below.
   */
  const BOTH_FORMS_WINDOW = 120;

  /**
   * Whether the read at `index` is accompanied by a read of the label form, and
   * so is building a term set from both recorded names rather than displaying
   * one of them.
   */
  function readsBothForms(source: string, index: number): boolean {
    for (const match of source.matchAll(/\.shortName\b/g)) {
      if (Math.abs((match.index ?? 0) - index) <= BOTH_FORMS_WINDOW) return true;
    }
    return false;
  }

  /**
   * Every raw read of an organization's recorded `name`, in any of the shapes
   * the defect has actually taken: named directly, taken straight out of an
   * organization Map, or taken out of one through a local alias -- less those
   * that read both forms together, which are search-term constructions.
   */
  function rawRecordedNameReads(source: string): string[] {
    const hits: Array<{ hit: string; index: number }> = [];
    const record = (match: RegExpMatchArray) => {
      hits.push({ hit: match[0].replace(/\s+/g, ' '), index: match.index ?? 0 });
    };

    for (const match of source.matchAll(/\borganization\.name\b/g)) record(match);

    for (const map of organizationMapIdentifiers(source)) {
      const direct = new RegExp(`\\b${map}\\.get\\([^)]*\\)\\s*[?!]?\\.name\\b`, 'g');
      for (const match of source.matchAll(direct)) record(match);

      // `const operator = organizationById.get(id)` -- optionally guarded by a
      // ternary, which is how two of the four operator sites were written --
      // followed anywhere by a `.name` read off that alias.
      const aliased = new RegExp(
        `const\\s+([A-Za-z0-9_]+)\\s*=\\s*(?:[A-Za-z0-9_]+\\s*\\?\\s*)?${map}\\.get\\(`,
        'g',
      );
      for (const [, alias] of source.matchAll(aliased)) {
        const use = new RegExp(`\\b${alias}\\s*[?!]?\\.name\\b`, 'g');
        for (const match of source.matchAll(use)) record(match);
      }
    }

    return [...new Set(
      hits.filter(({ index }) => !readsBothForms(source, index)).map(({ hit }) => hit),
    )];
  }

  /**
   * The name of the callback-parameter route, so the assertion that pins its
   * judged-set membership can refer to it without restating its pattern.
   */
  const CALLBACK_PARAMETER_ROUTE = 'a record destructured in a callback parameter';

  /**
   * The four routes by which the gate below recognises a held record.
   *
   * These are the gate's clauses, named rather than written inline as a bare
   * `||` chain, because *which* route reached a module is itself a property
   * worth asserting: a clause that is the sole route to a real surface can be
   * narrowed until that surface silently leaves the judged set, and a gate that
   * only ever answers yes-or-no cannot tell that from a surface that was never
   * judged in the first place. See 'judges at least one real swept surface
   * through the callback-parameter clause alone' -- the naming exists to make
   * that assertion expressible without duplicating a pattern that could then
   * drift away from the one actually in use.
   *
   * The patterns are unchanged and the gate is still their disjunction, so this
   * is a decomposition of the gate and not a widening of it.
   */
  const RECORD_ROUTES: ReadonlyArray<{ route: string; pattern: RegExp }> = [
    {
      route: 'the Organization type import',
      pattern: /import\s+type\s*\{[^}]*\bOrganization\b[^}]*\}\s*from\s*'(?:\.\.\/)+data\/schema'/,
    },
    { route: 'a dataset.organizations read', pattern: /\.organizations\b/ },
    // ...or destructures one out of a prepared view: `const { organization } =
    // ecosystem`. `homepage-search.ts` arrived with a later surface holding
    // real records exactly this way -- naming neither the type nor the
    // collection -- and the gate skipped the whole module, so five raw reads
    // were never even offered to the sweep. A module handed an
    // already-labelled view model still matches none of the four.
    { route: 'a record destructured out of a prepared view', pattern: /\{\s*organization\s*(?:,[^}]*)?\}\s*=/ },
    // ...or destructures one in a callback *parameter*, the shape the homepage
    // and the two lineage explorers use to walk a hierarchy:
    // `hierarchy.map(({ organization, families }) => ...)`. The record is real
    // and raw -- it never passed through the label -- but it is named in an
    // arrow parameter rather than a `const`, so the clause above steps over it.
    // This is the original #504 regression shape on a fresh surface, and
    // `index.astro` rendered a raw name through it while the gate skipped the
    // whole file. Matched here so the record is judged wherever it is unpacked.
    //
    // The braces are load-bearing: this matches a *destructured* parameter and
    // deliberately not a bare one. `ProviderDirectory.tsx` maps
    // `(organization) => <li>{organization.name}</li>` over a prepared
    // `DirectoryEntry` whose `.name` is already the label, so rendering it is
    // correct; widening to bare parameters would judge that file and fail on
    // correct code. Requiring `{ ... }` keeps the bare-parameter view model out
    // by mechanism, which is why this clause adds three judged modules
    // (`index.astro`, `LineageExplorer.tsx`, `ModelTreeExplorer.tsx`) and
    // reddens none.
    { route: CALLBACK_PARAMETER_ROUTE, pattern: /\(\s*\{[^}]*\borganization\b[^}]*\}\s*\)\s*=>/ },
  ];

  /** Which of the gate's routes reach a record in this source. */
  function recordRoutes(source: string): string[] {
    return RECORD_ROUTES.filter(({ pattern }) => pattern.test(source)).map(({ route }) => route);
  }

  /**
   * Whether a module holds an actual Organization record, as opposed to a view
   * model built from one. This is the sweep's gate, and it is what correctly
   * excludes `ProviderDirectory.tsx`.
   *
   * This gate -- not the corpus -- is what bounds the sweep's reach, and it is
   * deliberately narrow: it recognises a module by the four routes in
   * `RECORD_ROUTES` -- it imports the `Organization` type, reads
   * `dataset.organizations`, destructures a record out of a prepared view with
   * `const { organization } = ...`, or destructures one in a callback parameter
   * with `({ organization }) => ...`. The two
   * destructure forms are distinct shapes, and the distinction is load-bearing:
   * the callback-parameter form is the one `index.astro` used, and the sweep was
   * blind to it until it was added. Most swept modules match none of the four
   * and are correctly not judged, because they hold already-labelled view models
   * rather than records (`ProviderDirectory.tsx` is the asserted example). So
   * after every widening of the corpus, the judged set stays a minority of it on
   * purpose, and a surface is only guarded once it trips one of these clauses --
   * see the 'judges at least one .astro surface, so discovery is not the whole
   * story' assertion, which pins the judged count above zero so a corpus that is
   * discovered but never judged still fails.
   */
  function holdsOrganizationRecords(source: string): boolean {
    return recordRoutes(source).length > 0;
  }

  /**
   * The word characters `\b` treats as part of an identifier, spelled out so the
   * recogniser below can find a whole-word `organization` without a regex.
   */
  const IDENTIFIER_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';

  /** The index of the last non-whitespace character at or before `from`. */
  function lastNonSpace(source: string, from: number): number {
    let at = from;
    while (at >= 0 && source[at].trim() === '') at -= 1;
    return at;
  }

  /** Whether `bindings` names the record itself, as a whole identifier. */
  function namesTheRecord(bindings: string): boolean {
    let token = '';
    for (const character of `${bindings} `) {
      if (IDENTIFIER_CHARACTERS.includes(character)) {
        token += character;
        continue;
      }
      if (token === 'organization') return true;
      token = '';
    }
    return false;
  }

  /**
   * Whether a module unpacks a record in a braced callback parameter --
   * the same shape clause four of `RECORD_ROUTES` recognises, decided by a
   * different mechanism: a backward scan from each `=>` for `)`, `}`, the `{`
   * that opens it, and the `(` before it, with no regex anywhere in the shape
   * test.
   *
   * This is deliberately a *second opinion* and never the finder. A test that
   * located the clause's surfaces with its own copy of the clause's pattern
   * would agree with a narrowed clause by construction and pass while real
   * surfaces left the judged set -- which is the reason the sole-route
   * assertion below asks the gate which route reached a module rather than
   * re-deriving it. Used differentially the duplication inverts: the two
   * mechanisms are only ever asserted to *agree*, so narrowing one and not the
   * other is exactly what reddens. That is the membership pin, and it is what
   * non-emptiness alone cannot give -- see the two assertions that follow.
   *
   * It mirrors the clause's semantics, not its syntax: `[^}]*` forbids a nested
   * `}` inside the destructuring, so the backward walk to `{` refuses to cross
   * one; `\(\s*\{` and `\}\s*\)` allow only whitespace on either side, so the
   * scan skips whitespace and nothing else. Both forms are therefore blind to
   * the same things -- a typed parameter `({ organization }: Props) =>`, a bare
   * one, a comment -- and neither is blind to what follows the arrow, which is
   * the axis a narrowing attacks.
   *
   * Keeping the two in step is a real cost, paid deliberately: a future
   * *legitimate* change to the clause has to be made here too, and until it is,
   * the pair below reddens. That is the alarm working, not a false one -- it
   * says the shape the gate recognises has moved and no longer matches the shape
   * the suite believes it recognises.
   */
  function unpacksRecordInBracedCallbackParameter(source: string): boolean {
    for (let arrow = source.indexOf('=>'); arrow !== -1; arrow = source.indexOf('=>', arrow + 2)) {
      const closeParen = lastNonSpace(source, arrow - 1);
      if (source[closeParen] !== ')') continue;

      const closeBrace = lastNonSpace(source, closeParen - 1);
      if (source[closeBrace] !== '}') continue;

      let openBrace = closeBrace - 1;
      while (openBrace >= 0 && source[openBrace] !== '{' && source[openBrace] !== '}') openBrace -= 1;
      if (openBrace < 0 || source[openBrace] !== '{') continue;

      if (source[lastNonSpace(source, openBrace - 1)] !== '(') continue;
      if (namesTheRecord(source.slice(openBrace + 1, closeBrace))) return true;
    }
    return false;
  }

  it('reads a non-empty corpus from every swept directory, so the sweep below means something', () => {
    expect(modules.length).toBeGreaterThan(0);
    // Per-directory, not just in total: a corpus that silently lost one whole
    // directory is the defect this tripwire was widened to fix, and a combined
    // count would still look healthy while that happened.
    //
    // This filters by directory rather than by extension, so it no longer pins a
    // per-extension floor on its own. That floor is instead carried by named
    // tests: 'excludes ProviderDirectory.tsx by mechanism, not by convention'
    // pins a `.tsx` in components/, 'does not flag SourceList.astro, because a
    // citation names the publisher entity and not a creator' pins an `.astro`
    // there, and 'sweeps a module that only ever destructures an organization
    // record' pins a `.ts` in lib/; pages/ and layouts/ are single-extension
    // roots, so their directory floor is their extension floor.
    for (const { directory } of roots) {
      const swept = modules.filter((module) => module.directory === directory);
      expect(swept.length, `nothing swept in ${directory}`).toBeGreaterThan(0);
    }
  });

  it('discovers the .astro surfaces, so their silence is coverage and not an empty glob', () => {
    // The vacuity guard for the widening this issue is about. An `.astro` sweep
    // that matched nothing would pass exactly as quietly as one that matched
    // clean pages -- which is the failure mode this repository has shipped
    // before. So the discovery is asserted, and the count named in the failure
    // message, so a future reader can tell coverage from silence rather than
    // trusting a green run over an empty corpus.
    const astro = modules.filter(({ file }) => file.endsWith('.astro'));
    expect(
      astro.length,
      `no .astro surfaces discovered -- the sweep matched nothing (found: ${astro.map(({ file }) => file).join(', ')})`,
    ).toBeGreaterThan(0);
  });

  it('judges at least one .astro surface, so discovery is not the whole story', () => {
    // Discovery and judgement are two stages, and only the second checks a file:
    // a surface can be discovered and then dropped by `holdsOrganizationRecords`,
    // in which case the sweep never reads it. The discovery guard above cannot
    // see that -- discovery succeeded -- and the global `holdsOrganizations` count
    // is satisfied by `lib/*.ts` alone, so both stay green while the `.astro`
    // judged count sits at zero. That is exactly how a raw `{organization.name}`
    // read on `index.astro` went unjudged until the callback-parameter clause was
    // added. This assertion pins the judged `.astro` count above zero, and names
    // the surfaces so a reader can tell judgement from mere discovery.
    const judgedAstro = modules.filter(({ file, source }) => (
      file.endsWith('.astro') && holdsOrganizationRecords(source)
    ));
    expect(
      judgedAstro.length,
      'no .astro surface is judged -- every discovered .astro file was dropped by the record gate',
    ).toBeGreaterThan(0);
  });

  it('does not flag SourceList.astro, because a citation names the publisher entity and not a creator', () => {
    // The first hit a naive `.astro` widening produces, and a false one:
    // `publisherById.get(source.publisherId)?.name` is the recorded first-party
    // name of the *publisher* of a cited source -- a distinct entity from the
    // creator this rule governs, and one no creator label applies to. It is
    // exempt by that entity boundary, not by path or by silencing the shape: the
    // file holds no Organization record, and `publisherById` is not a Map built
    // from `dataset.organizations`, so neither of the sweep's record shapes
    // reaches it. Relabelling the citation was proposed and rejected as #513.
    const component = modules.find(({ file }) => file === 'SourceList.astro');
    // Control: the exemption below means nothing if the file is not swept at all.
    expect(component, 'SourceList.astro is not in the swept corpus').toBeDefined();
    expect(/\?\.name\b/.test(component!.source)).toBe(true);
    expect(holdsOrganizationRecords(component!.source)).toBe(false);
    expect(organizationMapIdentifiers(component!.source)).toEqual([]);
    expect(rawRecordedNameReads(component!.source)).toEqual([]);
  });

  it('renders no raw recorded name in a module that holds an Organization record', () => {
    const holdsOrganizations = modules.filter(({ source }) => holdsOrganizationRecords(source));
    // The control that matters: if this ever reaches zero the sweep below passes
    // for free, and the tripwire has quietly stopped guarding anything.
    expect(holdsOrganizations.length).toBeGreaterThan(0);

    const offenders = holdsOrganizations
      .flatMap(({ file, source }) => rawRecordedNameReads(source).map((hit) => `${file}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it('recognises an organization Map in every module that builds one, so the sweep can follow it', () => {
    // The sweep above is only as good as this set. An empty set makes every
    // lookup-shaped read invisible, which is exactly how four sites survived
    // the previous version, so it is asserted rather than assumed.
    const withMaps = modules.filter(({ source }) => organizationMapIdentifiers(source).length > 0);
    expect(withMaps.length).toBeGreaterThan(0);

    // ...and it must find them by derivation, not by matching a fixed name: a
    // module that builds one from `dataset.organizations` is found whatever it
    // called the variable.
    const renamed = 'const byCreator = new Map(dataset.organizations.map((item) => [item.id, item]));';
    expect(organizationMapIdentifiers(renamed)).toEqual(['byCreator']);
    expect(rawRecordedNameReads(`${renamed}\nconst n = byCreator.get(id)?.name;`))
      .toEqual(['byCreator.get(id)?.name']);

    // Control: a Map over a different entity is not an organization Map, so the
    // sweep does not claim reach it does not have. Family, platform, publisher
    // and benchmark records carry one name each and are not relabelled.
    const family = 'const familyById = new Map(dataset.families.map((item) => [item.id, item]));';
    expect(organizationMapIdentifiers(family)).toEqual([]);
    expect(rawRecordedNameReads(`${family}\nconst n = familyById.get(id)?.name;`)).toEqual([]);
  });

  it('excludes ProviderDirectory.tsx by mechanism, not by convention', () => {
    // Widening the sweep is only a fix if it did not also loosen the gate. This
    // module spells `organization.name` and is deliberately not an offender:
    // the value it names is a prepared `DirectoryEntry`, not an Organization
    // record, and `provider-directory.ts` set that field to the label already.
    const component = modules.find(({ file }) => file === 'ProviderDirectory.tsx');
    // Control: the exclusion below means nothing if the file is not swept at all.
    expect(component, 'ProviderDirectory.tsx is not in the swept corpus').toBeDefined();
    expect(/\borganization\.name\b/.test(component!.source)).toBe(true);
    expect(holdsOrganizationRecords(component!.source)).toBe(false);

    // The mechanical reason, asserted at its source rather than trusted: the
    // entry's `name` is the label, so rendering it is already the rule.
    const builder = readFileSync(join(LIB_DIRECTORY, 'provider-directory.ts'), 'utf8');
    expect(builder).toContain('name: organizationLabel(organization)');
  });

  it('judges a record destructured in a braced callback parameter, and not a bare one', () => {
    // The positive control for the clause `fcac61d` added -- the whole point of
    // this issue. A record unpacked in a callback *parameter*,
    // `hierarchy.map(({ organization, families }) => ...)`, is the shape
    // `index.astro` used and the gate was blind to. Deleting that clause leaves
    // the corpus green everywhere else -- the `judges at least one .astro
    // surface` guard survives because `providers/[slug].astro` is still judged
    // through a different clause -- so nothing else here reddens when the clause
    // that closes this issue is removed. This does: delete the clause and the
    // first expectation fails, which is what makes the clause coverage rather
    // than an unguarded decision.
    //
    // Asserted at the *shape* level, on a synthetic source, deliberately not by
    // pinning `index.astro` by name: a filename pin couples the gate to a file a
    // refactor may legitimately move or rename, and would then fail for a reason
    // unrelated to the rule. The braced destructuring shape is what the clause is
    // about.
    const bracedParameter = [
      'hierarchy.map(({ organization, families }) => (',
      '  <li>{organization.name}</li>',
      '));',
    ].join('\n');
    expect(holdsOrganizationRecords(bracedParameter)).toBe(true);

    // ...and the braces are load-bearing in this direction too: a *bare*
    // parameter must stay unjudged, because it is the `ProviderDirectory.tsx`
    // shape -- a prepared view model whose `.name` is already the label -- and
    // judging it would fail on correct code. The exclusion test above asserts
    // this against the live file; this asserts the same distinction at the shape
    // level, so the two forms are shown mutually exclusive without a filename.
    const bareParameter = [
      'directory.unclassified.map((organization) => (',
      '  <li>{organization.name}</li>',
      '));',
    ].join('\n');
    expect(holdsOrganizationRecords(bareParameter)).toBe(false);
  });

  it('recognises the braced callback parameter whatever follows the arrow, and never a bare one', () => {
    // The recogniser's own contract, asserted at the shape level so it is a
    // stated property rather than something inferred from today's corpus.
    //
    // The first three fixtures are the same parameter shape with three different
    // callback bodies -- parenthesised, an expression, a block -- and that is the
    // point rather than padding: the demonstrated narrowing in #573 works by
    // making the gate care what follows the arrow, and the surfaces it drops are
    // exactly the ones whose bodies are not parenthesised. A recogniser that
    // shared that sensitivity would agree with the narrowed clause and the
    // membership assertion would go quiet. So its blindness to the body is the
    // property under test.
    const bodies = [
      'hierarchy.map(({ organization, families }) => (\n  <li>{organization.name}</li>\n));',
      'ecosystems.map(({ organization }) => organization.slug);',
      'creators.map(({ organization, families }) => {\n  return organization.id;\n});',
    ];
    for (const body of bodies) {
      expect(unpacksRecordInBracedCallbackParameter(body), body).toBe(true);
    }

    // ...and the exclusions the clause makes, made here too, because the pair of
    // assertions below is an agreement check and a recogniser that judged the
    // bare-parameter view model would report the gate as having narrowed past a
    // surface it is correct to skip. `ProviderDirectory.tsx` is that shape.
    const notRecords = [
      'directory.unclassified.map((organization) => (\n  <li>{organization.name}</li>\n));',
      'families.map(({ family, releases }) => family.id);',
      'items.map(({ organizationId }) => organizationId);',
    ];
    for (const source of notRecords) {
      expect(unpacksRecordInBracedCallbackParameter(source), source).toBe(false);
    }
  });

  it('judges at least one real swept surface through the callback-parameter clause alone', () => {
    // The assertion above pins the clause's *verdict on synthetic strings*.
    // This one pins its *membership of the judged set*, and the two are not the
    // same guarantee. The review of #528 showed the gap by mutation: narrow the
    // clause so it still matches the braced fixture but no longer matches the
    // real homepage -- the fixture's callback body opens with `<li>`, the
    // homepage's with `<section>` -- then render a raw `{organization.name}` on
    // that homepage. Every assertion in this file stayed green while the page
    // shipped the exact defect this tripwire exists to catch.
    //
    // The asymmetry is the whole point. A *widening* of the clause reddens
    // loudly, because it pulls extra real files into the judged set and they
    // fail on correct code -- that is what the permissive mutation in #528
    // proved. A *narrowing* is silent, because it drops real files out, and
    // until this assertion nothing said they were ever in. The clause is the
    // sole route by which three live surfaces are judged at all, so when it
    // narrows past them they leave the judged set and are simply never read.
    //
    // Non-emptiness, not a floor and not a count. A count moves whenever a page
    // is added; a floor pins today's carriers from below, so deleting or
    // refactoring one of them would redden this suite for a reason that has
    // nothing to do with the creator-naming rule -- the same coupling objection
    // that rules out pinning a filename.
    //
    // Non-emptiness is necessary and *not* sufficient, and the difference was
    // measured rather than argued (#573). Narrowing this clause to require a
    // parenthesised callback body leaves the homepage judged and drops the two
    // lineage explorers -- three sole-route surfaces become one -- and this
    // assertion stays green on the survivor while two real surfaces stop being
    // read at all. So the set can thin without emptying, which is the same class
    // of silent coverage loss one level in. What closes that is a membership
    // pin, and it is the pair of assertions below; this one stays because a set
    // that empties outright must still fail here, and because it is what makes
    // the sole-route notion the next two build on worth asserting at all.
    //
    // Structural, not by path. No filename appears here: carriers are found by
    // asking the gate which of its routes reached each swept module, so a
    // legitimate rename or move of the homepage changes nothing.
    const carriers = modules.filter(({ source }) => (
      recordRoutes(source).includes(CALLBACK_PARAMETER_ROUTE)
    ));
    const soleRoute = carriers.filter(({ source }) => recordRoutes(source).length === 1);

    expect(
      soleRoute.length,
      `no swept surface is judged through ${CALLBACK_PARAMETER_ROUTE} alone, `
      + 'so narrowing that clause would drop real surfaces out of the judged set '
      + `unnoticed (clause carriers: ${carriers.map(({ file }) => file).join(', ') || 'none'})`,
    ).toBeGreaterThan(0);
  });

  it('keeps every surface that unpacks a record in a braced callback parameter inside the judged set', () => {
    // The membership pin. The assertion above says the sole-route set is not
    // empty; this says no member of it silently leaves, which is the gap #573
    // measured: narrow the clause to require a parenthesised callback body and
    // the judged set goes from three of these surfaces to one while every
    // assertion in this file stays green.
    //
    // Stated as a property, not as a list: every module that unpacks a record in
    // a braced callback parameter must be judged by *some* route. No filename
    // appears, so a rename or a move changes nothing; no count appears, so a new
    // surface of this shape joins the corpus and passes on its own merits, and
    // deleting one leaves an empty violation set rather than a missed floor.
    // Judgement is asked of the whole gate rather than of clause four, because
    // the defect is a surface that stops being read at all -- a future clause
    // that reaches the same module by another route has lost nothing, and should
    // not redden here.
    //
    // The independent recogniser is what makes this more than a tautology: ask
    // the clause which modules it reaches and the answer moves with the clause,
    // so a narrowing agrees with itself. See
    // `unpacksRecordInBracedCallbackParameter` for why the duplication is the
    // mechanism rather than a smell, and for the cost it carries.
    const unpacking = modules.filter(({ source }) => (
      unpacksRecordInBracedCallbackParameter(source)
    ));

    // Vacuity guard, in the same assertion rather than a separate test: an empty
    // corpus, a broken sweep, or a recogniser that matches nothing would make the
    // check below pass by having nothing to check.
    expect(
      unpacking.length,
      'no swept surface unpacks a record in a braced callback parameter -- the recogniser '
      + 'found nothing, so the membership check below is vacuous',
    ).toBeGreaterThan(0);

    const dropped = unpacking.filter(({ source }) => !holdsOrganizationRecords(source));

    expect(
      dropped.map(({ file }) => file),
      'these surfaces unpack a record in a braced callback parameter but are no longer judged '
      + 'by any route, so the sweep never reads them -- the record gate has narrowed past real '
      + 'surfaces that were previously in the judged set',
    ).toEqual([]);
  });

  it('recognises every surface the callback-parameter clause alone carries, so the membership check cannot go vacuous', () => {
    // The other direction, and the reason the pair is a pin rather than a pair of
    // one-way checks. The assertion above compares the recogniser against the
    // gate; it would pass just as quietly if the *recogniser* were the thing that
    // narrowed, because a recogniser that finds fewer surfaces has fewer to find
    // unjudged. This catches that: a surface whose only route into the judged set
    // is clause four must be one the recogniser also sees. Narrow either side
    // alone and exactly one of these two assertions reddens.
    //
    // Scoped to sole-route carriers rather than to every clause carrier, because
    // the clause's `[^}]*` can run past a `{` that opens an object literal and
    // close on a `}` belonging to a later, inner destructuring -- so a module can
    // match the clause without unpacking anything in a callback parameter at all.
    // `model-tree.ts` did exactly that at the time of writing, and it is judged
    // through the type import and a `.organizations` read regardless, so nothing
    // about its coverage rests on the clause. Asserting agreement on every
    // carrier would fail on that accident and teach the next reader to delete the
    // check; asserting it where the clause is the only route is where agreement
    // actually has to hold.
    const soleRoute = modules.filter(({ source }) => {
      const routes = recordRoutes(source);
      return routes.length === 1 && routes.includes(CALLBACK_PARAMETER_ROUTE);
    });

    expect(
      soleRoute.length,
      `no swept surface is judged through ${CALLBACK_PARAMETER_ROUTE} alone, so this `
      + 'agreement check has nothing to compare',
    ).toBeGreaterThan(0);

    const unrecognised = soleRoute.filter(({ source }) => (
      !unpacksRecordInBracedCallbackParameter(source)
    ));

    expect(
      unrecognised.map(({ file }) => file),
      'the record gate judges these surfaces through the callback-parameter clause alone, but '
      + 'the independent recogniser no longer sees the shape in them -- the two have drifted '
      + 'apart, and the membership assertion above can no longer be trusted',
    ).toEqual([]);
  });

  it('sweeps a module that only ever destructures an organization record', () => {
    // The shape that arrived with a later surface and defeated the gate: no
    // `Organization` import, no `.organizations` read, real records all the
    // same. Asserted against the live module rather than a fixture, so the gate
    // cannot pass here while the file it was widened for slips out of reach.
    const module = modules.find(({ file }) => file === 'homepage-search.ts');
    expect(module, 'homepage-search.ts is not in the swept corpus').toBeDefined();
    expect(/\.organizations\b/.test(module!.source)).toBe(false);
    expect(holdsOrganizationRecords(module!.source)).toBe(true);
  });

  it('exempts a both-forms search construction and still flags a lone display read', () => {
    // Both directions, because an exemption that never fires would silently
    // blind the sweep and an exemption that always fires would be no sweep at
    // all. The recorded name may be read to stay *matchable*; it may not be
    // read to be *shown*, and only the accompanying label tells them apart.
    const search = 'const terms = new Set([organization.name, organization.shortName]);';
    expect(rawRecordedNameReads(search)).toEqual([]);

    const display = 'const heading = `${organization.name} family`;';
    expect(rawRecordedNameReads(display)).toEqual(['organization.name']);

    // Distance is the discriminator, so it is asserted: the same two reads stop
    // reading as a pair once they are far enough apart to be unrelated code.
    const far = `const shown = organization.name;${' '.repeat(400)}const t = organization.shortName;`;
    expect(rawRecordedNameReads(far)).toEqual(['organization.name']);
  });
});

describe('the homepage search surface renders the label', () => {
  // This surface arrived after the rule and reintroduced the defect on the most
  // visited page, which is the case for asserting it against real data rather
  // than trusting the source sweep alone: the sweep reads shapes, and a term
  // taken from a loop variable never names the record at all.
  const index = () => buildHomepageSearchIndex(dataset, BASE);

  const relabelled = () => everyOrganization()
    .filter((item) => item.name !== item.shortName);

  it('shows no creator under a recorded name that differs from its label', () => {
    const built = index();
    // Control first: an assertion over an empty set of differing records would
    // pass for free, and it is exactly the records that differ that matter.
    expect(relabelled().length).toBeGreaterThan(0);

    for (const organization of relabelled()) {
      const shown = [
        ...built.suggestions.map((item) => item.term),
        ...built.suggestions.map((item) => item.context),
        ...built.releases.map((item) => item.organizationName),
      ];
      expect(shown, `${organization.id} rendered under its recorded name`)
        .not.toContain(organization.name);
      expect(shown).not.toContain(`${organization.name} family`);
    }
  });

  it('keeps both recorded names findable, so the label did not cost discoverability', () => {
    const built = index();

    for (const organization of relabelled()) {
      const rows = built.releases.filter((row) => row.organizationSlug === organization.slug);
      if (!rows.length) continue;

      for (const form of [organization.name, organization.shortName]) {
        const matched = rows.filter((row) => releaseMatchesQuery(row, form));
        expect(matched.length, `${organization.id} unfindable by "${form}"`).toBe(rows.length);
      }
    }

    // Control: the probe discriminates rather than matching everything.
    const anyRow = built.releases[0];
    expect(releaseMatchesQuery(anyRow, 'zzzznotacreator')).toBe(false);
  });
});

describe('xai, the record that prompted the rule', () => {
  const xai = () => everyOrganization().find((item) => item.id === 'xai')!;

  it('is still one organization carrying both recorded names', () => {
    // The rule is a presentation decision. It must not have edited the data, and
    // it must not have merged this creator with another.
    const record = xai();
    expect(record).toBeDefined();
    expect(record.name).toBe('SpaceXAI');
    expect(record.shortName).toBe('xAI');
    expect(everyOrganization().filter((item) => item.id === 'xai')).toHaveLength(1);
    expect(everyOrganization().filter((item) => item.slug === 'xai')).toHaveLength(1);
  });

  it('renders as xAI and files under X rather than S', () => {
    const record = xai();
    expect(organizationLabel(record)).toBe('xAI');
    expect(directoryInitial(organizationLabel(record))).toBe('X');
    expect(directoryInitial(organizationLabel(record))).not.toBe('S');
  });

  it('is reachable in the directory by either recorded name', () => {
    const directory = buildProviderDirectory(dataset, BASE);
    const entry = directory.groups
      .flatMap((group) => group.entries)
      .find((item) => item.id === 'xai')!;

    expect(entry.name).toBe('xAI');
    expect(entry.initial).toBe('X');
    expect(entry.terms).toContain('xai');
    expect(entry.terms).toContain('spacexai');
  });

  it('keeps the recorded conflict legible in its description', () => {
    // AC3: the conflict survives. The description is where it is explained with
    // its sources, so the label change must not have made that prose orphaned.
    const record = xai();
    expect(record.description).toContain('SpaceXAI');
    expect(record.description).toContain('xAI');
    expect(record.sourceIds.length).toBeGreaterThan(0);
  });
});

/**
 * abdeslam-menacere/ModelTree#531: `google-deepmind` displays as "Google
 * DeepMind".
 *
 * The decision is editorial and is argued in the issue; what needs a test is its
 * one measurable consequence. While the record carried two different forms,
 * "DeepMind" was a recorded search term in its own right, so every surface found
 * this creator by that word no matter how it compared terms. Making the two
 * forms agree deduplicates them to a single recorded form, and the bare word a
 * great many readers still type now reaches the creator only because these
 * matchers look *inside* a recorded form rather than at the whole of it.
 *
 * Nothing else here says they have to. Each of these four surfaces owns its own
 * matcher, and swapping any one of them to prefix or whole-term comparison would
 * silently stop bare "DeepMind" finding Google's AI lab --
 * `'google deepmind'.startsWith('deepmind')` is false -- while every other
 * assertion in this suite stayed green. So the behaviour is pinned per surface,
 * as behaviour a reader can feel rather than as an implementation detail: type
 * the word, get this creator.
 */
describe('bare "DeepMind" still reaches the creator that #531 relabelled', () => {
  const NEEDLE = 'DeepMind';
  const record = () => everyOrganization().find((item) => item.id === 'google-deepmind')!;
  const MISS = 'zzzznotacreator';

  it('carries the bare word only inside a recorded form, which is what makes the rest load-bearing', () => {
    // The guard for this whole block. While two forms were recorded, one of them
    // *was* this string, so everything below would have passed under any matcher
    // -- including the ones it exists to reject. Assert the precondition rather
    // than assume it still holds: no recorded form equals the word, and at least
    // one contains it.
    const terms = organizationSearchTerms(record());
    expect(terms.some((term) => normalizeText(term) === normalizeText(NEEDLE))).toBe(false);
    expect(terms.some((term) => normalizeText(term).includes(normalizeText(NEEDLE)))).toBe(true);
  });

  it('offers it as a homepage creator suggestion', () => {
    const built = buildHomepageSearchIndex(dataset, BASE);
    const matched = homeSuggestionsFor(built, NEEDLE)
      .filter((suggestion) => suggestion.entity === 'organization')
      .map(({ term }) => term);

    expect(matched).toContain(organizationLabel(record()));
    // Control: the probe discriminates rather than returning everything.
    expect(homeSuggestionsFor(built, MISS)).toEqual([]);
  });

  it('matches its releases in the homepage release rows', () => {
    const built = buildHomepageSearchIndex(dataset, BASE);
    const rows = built.releases.filter((row) => row.organizationSlug === record().slug);

    // Positive control: a creator with no homepage row would satisfy the
    // filters below without exercising the matcher.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => releaseMatchesQuery(row, NEEDLE))).toHaveLength(rows.length);
    expect(rows.filter((row) => releaseMatchesQuery(row, MISS))).toHaveLength(0);
  });

  it('matches it in the provider directory, which the decision refiled under G', () => {
    const directory = buildProviderDirectory(dataset, BASE);
    const entry = directory.groups
      .flatMap((group) => group.entries)
      .find((item) => item.id === 'google-deepmind');

    expect(entry, 'no directory entry for google-deepmind').toBeDefined();
    expect(matchesDirectorySearch(entry!, NEEDLE)).toBe(true);
    expect(matchesDirectorySearch(entry!, MISS)).toBe(false);
    // The intended consequence of the decision, written down so a later reader
    // does not take it for a regression: the label leads with "Google", so the
    // creator files under G. It filed under D while the label was the shorter
    // form, and a reader looking for Google's AI lab under G found nothing.
    expect(entry!.initial).toBe(directoryInitial(organizationLabel(record())));
    expect(entry!.initial).toBe('G');
  });

  it('matches its releases in the catalog search', () => {
    const catalog = buildCatalogIndex(dataset, BASE);
    const hits = (search: string) => filterAndSortModels(
      catalog.models,
      { ...defaultCatalogState(), search },
    ).filter((row) => row.organizationSlug === record().slug);

    expect(hits(NEEDLE).length).toBeGreaterThan(0);
    // The bare word reaches everything the full label does, so the shorter form
    // costs a reader nothing here.
    expect(hits(NEEDLE)).toHaveLength(hits(organizationLabel(record())).length);
    expect(hits(MISS)).toHaveLength(0);
  });
});

describe('negative control: the assertions fail when the rule is removed', () => {
  /**
   * The rule as it was before #479: the label is `name`. Every assertion below
   * re-runs a check from above against this, and requires it to FAIL.
   *
   * Without this, a green suite would be consistent with the rule never having
   * been applied -- most organizations record the same string in both fields, so
   * an assertion that only swept them would pass either way. These are the tests
   * that prove the sweeps above have teeth.
   */
  const labelWithoutRule = (organization: Organization) => organization.name;

  it('finds at least one organization whose two recorded forms differ', () => {
    // The control for this whole block: if no organization distinguished the two
    // fields, "the rule is removed" would be indistinguishable from "the rule
    // holds", and every expectation below would be vacuous.
    const differing = everyOrganization().filter((item) => item.name !== item.shortName);
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.map((item) => item.id)).toContain('xai');
  });

  it('fails the label assertion', () => {
    expect(() => {
      for (const organization of everyOrganization()) {
        expect(labelWithoutRule(organization)).toBe(organization.shortName);
      }
    }).toThrow();
  });

  it('fails the directory filing assertion', () => {
    const directory = buildProviderDirectory(dataset, BASE);
    const creators = directory.groups.find((group) => group.id === 'creators')!.entries;
    const organizationById = new Map(everyOrganization().map((item) => [item.id, item]));

    expect(() => {
      for (const entry of creators) {
        const organization = organizationById.get(entry.id)!;
        expect(entry.initial).toBe(directoryInitial(labelWithoutRule(organization)));
      }
    }).toThrow();
  });

  it('fails the xai filing assertion, which is the defect restated', () => {
    const record = everyOrganization().find((item) => item.id === 'xai')!;
    expect(directoryInitial(labelWithoutRule(record))).toBe('S');
    expect(() => {
      expect(directoryInitial(labelWithoutRule(record))).toBe('X');
    }).toThrow();
  });
});
