import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataset } from './dataset';
import { rawDataset } from './raw';
import { familySchema, organizationSchema, releaseSchema } from './schema';
import { buildCatalogIndex } from '../lib/catalog';
import { buildModelTree } from '../lib/model-tree';
import { providerStaticPaths } from '../lib/routes';

const schemaSource = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8');
const methodologyPage = readFileSync(new URL('../pages/methodology.astro', import.meta.url), 'utf8');
const informationArchitecture = readFileSync(
  new URL('../../../docs/product/INFORMATION-ARCHITECTURE.md', import.meta.url),
  'utf8',
);

const POLICY_BLOCK_START = '<!-- catalog-inclusion-policy:start -->';
const POLICY_BLOCK_END = '<!-- catalog-inclusion-policy:end -->';

// Same normalisation the organization-type and featured policy tests use, so
// the three published copies are compared on their words rather than on their
// markup or their line wrapping.
function normalizePolicyText(source: string): string {
  return source
    .replaceAll('<code>', '`')
    .replaceAll('</code>', '`')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('//', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function schemaPolicyStatement(): string {
  const policy = schemaSource.match(
    /\/\/ What earns a record a place[\s\S]*?export const datasetSchema/,
  )?.[0];
  if (!policy) throw new Error('catalog inclusion policy is missing beside datasetSchema');

  const normalized = normalizePolicyText(policy);
  const end = normalized.indexOf(' export const datasetSchema');
  if (end < 0) throw new Error('catalog inclusion policy is not machine-readable');
  return normalized.slice(0, end);
}

function schemaAdmissionSteps(): string[] {
  const normalized = schemaPolicyStatement();
  const start = normalized.indexOf('Apply in order:');
  const end = normalized.indexOf('Inclusion decides presence and nothing else.');
  if (start < 0 || end < 0) throw new Error('catalog inclusion policy has no ordered procedure');

  return normalized
    .slice(start + 'Apply in order:'.length, end)
    .replace(/\.$/, '')
    .split(';')
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

function publishedPolicyBlock(source: string, name: string): string {
  const starts = source.split(POLICY_BLOCK_START).length - 1;
  const ends = source.split(POLICY_BLOCK_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`${name} must contain exactly one delimited catalog inclusion policy block`);
  }

  const start = source.indexOf(POLICY_BLOCK_START) + POLICY_BLOCK_START.length;
  const end = source.indexOf(POLICY_BLOCK_END, start);
  if (end < start) throw new Error(`${name} catalog inclusion policy delimiters are out of order`);

  return normalizePolicyText(source.slice(start, end));
}

describe('catalog inclusion policy', () => {
  it('records one ordered admission procedure beside the dataset schema', () => {
    const statement = schemaPolicyStatement();

    // Control for every assertion below: an empty or unmatched slice would
    // satisfy none of them honestly, and `toContain` on '' passes for free.
    expect(statement.length).toBeGreaterThan(0);

    expect(statement).toContain('Apply in order:');
    expect(statement).toContain('exactly one entity kind per record');
    expect(statement).toContain('cite at least one primary source');
    expect(statement).toContain('carry the day it was read');
    expect(statement).toContain('leave a field unset when no cited source states it');
    expect(statement).toContain('withhold the whole record');
    expect(statement).toContain('record the gap rather than the guess');
    expect(statement).toContain('reviewed change to this repository');
    expect(statement).toContain('never as an open crawl');

    // The five ordered admission steps: entity boundary, source and date,
    // unset over guessed, withhold over invent, reviewed change.
    expect(schemaAdmissionSteps()).toHaveLength(5);
  });

  it('keeps inclusion separate from featuring, and says so in that order', () => {
    const statement = schemaPolicyStatement();

    expect(statement).toContain('Inclusion decides presence and nothing else.');
    expect(statement).toContain('no order, no score, and no rank');
    expect(statement).toContain('applied afterwards and only to releases already admitted here');
    expect(statement).toContain('whether or not any editorial list names it');

    // The ordering claim is the substance: admission is stated before the
    // featured procedure is mentioned, because one gates the other.
    const admission = statement.indexOf('Apply in order:');
    const featuring = statement.indexOf('`featured` procedure');
    expect(admission).toBeGreaterThanOrEqual(0);
    expect(featuring).toBeGreaterThan(admission);
  });

  it('publishes the admission procedure on both policy surfaces word for word', () => {
    const expectedPolicy = schemaPolicyStatement();
    const surfaces = [
      ['methodology', methodologyPage],
      ['information architecture', informationArchitecture],
    ] as const;

    // Positive control: an empty surface list would let this sweep pass while
    // publishing the policy nowhere at all.
    expect(surfaces.length).toBeGreaterThan(0);

    for (const [name, document] of surfaces) {
      expect(publishedPolicyBlock(document, name)).toBe(expectedPolicy);
    }
  });

  it('states a source-and-date requirement the record schemas really enforce', () => {
    // The policy claims every record-bearing schema requires a source and a
    // verification date "of itself". That is a claim about the code, so it is
    // exercised against the code rather than restated.
    const bearers = [
      ['organization', organizationSchema, rawDataset.organizations.at(0)],
      ['family', familySchema, rawDataset.families.at(0)],
      ['release', releaseSchema, rawDataset.releases.at(0)],
    ] as const;

    expect(bearers.length).toBeGreaterThan(0);

    for (const [name, schema, record] of bearers) {
      // Two controls, both sharing the probes' failure mode. A missing record
      // would make every rejection below succeed for the wrong reason, and a
      // record the schema already rejects would "fail" whatever was removed
      // from it, proving nothing about the field actually removed.
      expect(record, `${name} record must exist to strip`).toBeDefined();
      expect(schema.safeParse(record).success, `${name} parses unmodified`).toBe(true);

      expect(
        schema.safeParse({ ...record, sourceIds: [] }).success,
        `${name} rejects an uncited record`,
      ).toBe(false);

      const { verifiedAt: _dropped, ...withoutVerifiedAt } = record as Record<string, unknown> & {
        verifiedAt: string;
      };
      expect(
        schema.safeParse(withoutVerifiedAt).success,
        `${name} rejects an unverified record`,
      ).toBe(false);
    }
  });

  it('reaches every unfeatured creator without featuring any of them', () => {
    // The separation the policy claims, exercised in the direction that
    // actually matters for a long-tail batch: a creator earns the catalog, the
    // Others branch and its own provider route by being included, and earns
    // none of the featured surfaces by it. A record that appeared nowhere would
    // satisfy "not featured" trivially, so presence is asserted alongside.
    const tree = buildModelTree(dataset);
    const index = buildCatalogIndex(dataset);
    const routeSlugs = new Set(providerStaticPaths().map(({ params }) => params.slug));
    const indexedProviderSlugs = new Set(index.providers.map((provider) => provider.slug));
    const featuredIds = new Set(tree.featured.map(({ organization }) => organization.id));

    const withReleases = dataset.organizations.filter((organization) =>
      dataset.releases.some((release) => release.organizationId === organization.id),
    );
    const unfeatured = withReleases.filter((organization) => !featuredIds.has(organization.id));

    // Two positive controls. Without releases to place there would be nothing
    // to reach, and without a featured creator the flag would be doing no work
    // at all — in either case every assertion below would hold vacuously.
    expect(withReleases.length).toBeGreaterThan(0);
    expect(featuredIds.size).toBeGreaterThan(0);
    expect(unfeatured.length).toBeGreaterThan(0);

    for (const organization of unfeatured) {
      expect(indexedProviderSlugs, `${organization.id} is in the catalog`).toContain(organization.slug);
      expect(routeSlugs, `${organization.id} has a provider page`).toContain(organization.slug);
      expect(
        tree.others.some(({ organization: other }) => other.id === organization.id),
        `${organization.id} hangs off the Others branch`,
      ).toBe(true);
      expect(
        dataset.releases
          .filter((release) => release.organizationId === organization.id)
          .some((release) => release.featured),
        `${organization.id} leads with no release`,
      ).toBe(false);
    }
  });
});
