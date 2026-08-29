import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { buildLineageEcosystems } from './lineage-view';
import { buildModelTree } from './model-tree';
import {
  organizationFullName,
  organizationFullNameIfDistinct,
  organizationLabel,
  organizationSearchTerms,
} from './organization-name';
import { buildModelPassport } from './passport';
import { buildProviderDirectory, directoryInitial } from './provider-directory';
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
      expect(labels).toEqual([...labels].sort());
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

    for (const organization of distinct) {
      const own = index.models
        .filter((row) => row.organizationSlug === organization.slug)
        .map((row) => row.slug)
        .sort();
      if (!own.length) continue;

      // Either recorded form reaches the creator's models; neither is privileged.
      expect(search(organizationFullName(organization))).toEqual(own);
      expect(search(organizationLabel(organization))).toEqual(own);

      // ...while what those rows display stays the label.
      for (const row of index.models.filter((item) => item.organizationSlug === organization.slug)) {
        expect(row.organizationName).toBe(organizationLabel(organization));
      }
    }

    // Control: the predicate is not simply matching everything. A string in no
    // recorded form returns nothing, so the counts above discriminate.
    expect(search('zzz-not-a-recorded-creator-name')).toEqual([]);
  });

  it('names the creator on the comparison table\'s Creator row by the label', () => {
    // The row a reader compares two models by, labelled "Creator" in words.
    // The comparison payload and picker were fixed earlier; this is the table
    // body, built separately, and it was missed by both.
    // The slice matters. Only 3 of 11 organizations record two different forms,
    // so a comparison of the first four releases can be satisfied by either
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
    // organization whose two recorded forms are identical (Microsoft, Amazon --
    // 0 of 2 differ, while 3 of 11 organizations overall do). So this sweep
    // cannot by itself distinguish the label from the fuller form, and it is
    // not the coverage that discriminates. That is `provider-directory.test.ts`,
    // whose fixture operator is deliberately "Alpha Labs" / "Alpha" and which
    // also pins that both forms stay searchable. This test guards the rule as
    // the dataset grows: the day a differing operator is recorded, it acquires
    // teeth without being edited.
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
  // Codepoint order, matching the comparators under test. Deliberately not a
  // locale collation: this asserts that ordering and display agree, and is not
  // the place to change how either sorts.
  const isNonDecreasing = (values: string[]) => values.every(
    (value, index) => index === 0 || values[index - 1] <= value,
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
    const labels = hierarchy.map((entry) => organizationLabel(entry.organization));
    expect(isNonDecreasing(labels)).toBe(true);
    // The defect exactly as it shipped: the page ordered on "Google DeepMind"
    // while printing "DeepMind", so DeepMind appeared after DeepSeek.
    expect(labels.indexOf('DeepMind')).toBeLessThan(labels.indexOf('DeepSeek'));
  });

  it('lists creators in the lineage tree in the order of the names that tree prints', () => {
    const ecosystems = buildLineageEcosystems(dataset);
    expect(ecosystems.length).toBeGreaterThan(0);
    expect(isNonDecreasing(ecosystems.map((entry) => organizationLabel(entry.organization)))).toBe(true);
  });

  it('orders lineage ecosystems by the label even where the two orderings disagree', () => {
    // The assertion above cannot fail on today's data, and saying so is the
    // point: the featured set contains DeepMind but not DeepSeek, so "DeepMind"
    // and "Google DeepMind" occupy the same slot either way. A guard that only
    // holds while a release flag happens not to change is not a guard.
    //
    // Featuring one DeepSeek release -- the sole input the derivation reads --
    // restores the distinction without inventing an organization or editing the
    // dataset. The fixture is chosen by the property under test.
    const deepseek = dataset.releases.find((release) => release.organizationId === 'deepseek');
    expect(deepseek, 'no deepseek release available to feature').toBeDefined();

    const withDeepSeekFeatured: Dataset = {
      ...dataset,
      releases: dataset.releases.map((release) => (
        release.id === deepseek!.id ? { ...release, featured: true } : release
      )),
    };

    const labels = buildLineageEcosystems(withDeepSeekFeatured)
      .map((entry) => organizationLabel(entry.organization));

    // The vacuity guard: without both creators present the ordering below is
    // satisfied trivially.
    expect(labels).toContain('DeepMind');
    expect(labels).toContain('DeepSeek');
    expect(isNonDecreasing(labels)).toBe(true);
    // The defect restated. Ordering on the recorded name files this creator
    // under "Google", which puts it after DeepSeek.
    expect(labels.indexOf('DeepMind')).toBeLessThan(labels.indexOf('DeepSeek'));
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
 * What it still cannot do is catch a surface that never names the record at
 * all -- a destructured sort comparator reading `a.name` is invisible to any
 * sweep for a shape. That class is guarded by the real-dataset assertions
 * above, which check the ordering a reader actually sees. Neither mechanism
 * subsumes the other, which is the reason both exist.
 */
describe('the creator naming rule on surfaces added later', () => {
  const LIB_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
  const roots = [
    { directory: fileURLToPath(new URL('../components', import.meta.url)), extension: '.tsx' },
    { directory: LIB_DIRECTORY, extension: '.ts' },
  ];

  // The rule module is the one place the raw field is read on purpose: it is
  // what every other module calls instead of reading it directly.
  const RULE_MODULE = 'organization-name.ts';

  const modules = roots.flatMap(({ directory, extension }) => readdirSync(directory)
    .filter((file) => (
      file.endsWith(extension) && !file.includes('.test.') && file !== RULE_MODULE
    ))
    .map((file) => ({ file, source: readFileSync(join(directory, file), 'utf8') })));

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
   * Every raw read of an organization's recorded `name`, in any of the shapes
   * the defect has actually taken: named directly, taken straight out of an
   * organization Map, or taken out of one through a local alias.
   */
  function rawRecordedNameReads(source: string): string[] {
    const hits = [...source.matchAll(/\borganization\.name\b/g)].map(([hit]) => hit);

    for (const map of organizationMapIdentifiers(source)) {
      const direct = new RegExp(`\\b${map}\\.get\\([^)]*\\)\\s*[?!]?\\.name\\b`, 'g');
      for (const [hit] of source.matchAll(direct)) hits.push(hit.replace(/\s+/g, ' '));

      // `const operator = organizationById.get(id)` -- optionally guarded by a
      // ternary, which is how two of the four operator sites were written --
      // followed anywhere by a `.name` read off that alias.
      const aliased = new RegExp(
        `const\\s+([A-Za-z0-9_]+)\\s*=\\s*(?:[A-Za-z0-9_]+\\s*\\?\\s*)?${map}\\.get\\(`,
        'g',
      );
      for (const [, alias] of source.matchAll(aliased)) {
        const use = new RegExp(`\\b${alias}\\s*[?!]?\\.name\\b`, 'g');
        for (const [hit] of source.matchAll(use)) hits.push(hit.replace(/\s+/g, ' '));
      }
    }

    return [...new Set(hits)];
  }

  /**
   * Whether a module holds an actual Organization record, as opposed to a view
   * model built from one. This is the sweep's gate, and it is what correctly
   * excludes `ProviderDirectory.tsx`.
   */
  function holdsOrganizationRecords(source: string): boolean {
    return (
      /import\s+type\s*\{[^}]*\bOrganization\b[^}]*\}\s*from\s*'\.\.\/data\/schema'/.test(source)
      || /\.organizations\b/.test(source)
    );
  }

  it('reads a non-empty corpus from every swept directory, so the sweep below means something', () => {
    expect(modules.length).toBeGreaterThan(0);
    // Per-directory, not just in total: a corpus that silently lost one whole
    // directory is the defect this tripwire was widened to fix, and a combined
    // count would still look healthy while that happened.
    for (const { directory, extension } of roots) {
      const swept = modules.filter(({ file }) => (
        file.endsWith(extension) && existsSync(join(directory, file))
      ));
      expect(swept.length, `nothing swept in ${directory}`).toBeGreaterThan(0);
    }
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
