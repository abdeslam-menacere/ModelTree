import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import type { Dataset, Organization } from '../data/schema';
import { buildCatalogIndex } from './catalog';
import { buildComparisonCandidates, buildComparisonPickerIndex } from './comparison';
import { buildHomepageHierarchy } from './homepage';
import { buildLineageEcosystems } from './lineage-view';
import { buildModelTree } from './model-tree';
import {
  organizationFullName,
  organizationFullNameIfDistinct,
  organizationLabel,
  organizationSearchTerms,
} from './organization-name';
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
 * What it cannot do is catch a surface that never spells `organization.name` --
 * a destructured sort comparator reading `a.name` is invisible to any sweep for
 * a spelling. That class is guarded by the real-dataset assertions above, which
 * check the ordering a reader actually sees. Neither mechanism subsumes the
 * other, which is the reason both exist.
 */
describe('the creator naming rule on surfaces added later', () => {
  const roots = [
    { directory: fileURLToPath(new URL('../components', import.meta.url)), extension: '.tsx' },
    { directory: fileURLToPath(new URL('.', import.meta.url)), extension: '.ts' },
  ];

  // The rule module is the one place the raw field is read on purpose: it is
  // what every other module calls instead of reading it directly.
  const RULE_MODULE = 'organization-name.ts';

  const modules = roots.flatMap(({ directory, extension }) => readdirSync(directory)
    .filter((file) => (
      file.endsWith(extension) && !file.includes('.test.') && file !== RULE_MODULE
    ))
    .map((file) => ({ file, source: readFileSync(join(directory, file), 'utf8') })));

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
    const holdsOrganizations = modules.filter(({ source }) => (
      /import\s+type\s*\{[^}]*\bOrganization\b[^}]*\}\s*from\s*'\.\.\/data\/schema'/.test(source)
      || /\.organizations\b/.test(source)
    ));
    // The control that matters: if this ever reaches zero the sweep below passes
    // for free, and the tripwire has quietly stopped guarding anything.
    expect(holdsOrganizations.length).toBeGreaterThan(0);

    const offenders = holdsOrganizations
      .filter(({ source }) => /\borganization\.name\b/.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
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
