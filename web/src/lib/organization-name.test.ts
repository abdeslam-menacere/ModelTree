import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dataset } from '../data/dataset';
import type { Organization } from '../data/schema';
import { buildCatalogIndex } from './catalog';
import { buildComparisonCandidates, buildComparisonPickerIndex } from './comparison';
import { buildModelTree } from './model-tree';
import {
  organizationFullName,
  organizationFullNameIfDistinct,
  organizationLabel,
  organizationSearchTerms,
} from './organization-name';
import { buildProviderDirectory, directoryInitial } from './provider-directory';

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
 * The rule has to survive surfaces that do not exist yet.
 *
 * #504 extracted the lineage tree's detail panel into a new component after this
 * rule landed, and carried the raw `organization.name` across with it -- so the
 * defect reappeared on a surface no existing test covered. The behavioural guard
 * for that specific component lives beside it, in
 * `components/LineageModelDrawer.test.tsx`. This is the general tripwire: it asks
 * which components hold a raw `Organization` record at all, because only those
 * can pick the wrong field. A component handed a prepared directory entry already
 * carries the label in its `name` and is correctly not swept here.
 */
describe('the creator naming rule on surfaces added later', () => {
  const componentsDirectory = fileURLToPath(new URL('../components', import.meta.url));
  const components = readdirSync(componentsDirectory)
    .filter((file) => file.endsWith('.tsx') && !file.includes('.test.'))
    .map((file) => ({ file, source: readFileSync(join(componentsDirectory, file), 'utf8') }));

  it('reads a non-empty corpus of components, so the sweep below means something', () => {
    expect(components.length).toBeGreaterThan(0);
  });

  it('renders no raw recorded name in a component that holds an Organization record', () => {
    const holdsOrganizations = components.filter(({ source }) => (
      /import\s+type\s*\{[^}]*\bOrganization\b[^}]*\}\s*from\s*'\.\.\/data\/schema'/.test(source)
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
