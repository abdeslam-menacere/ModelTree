import { describe, expect, it } from 'vitest';
import { dataset as seedDataset } from '../data/dataset';
import type { Dataset } from '../data/schema';
import { validateDataset } from '../data/validate';
import { buildCatalogIndex } from './catalog';
import { parseCatalogState } from './catalog-view';
import {
  buildDirectoryLetters,
  buildProviderDirectory,
  creatorCatalogHref,
  DIRECTORY_LETTERS,
  directoryInitial,
  filterDirectory,
  letterSectionId,
  matchesDirectorySearch,
  OTHER_INITIAL,
  parseDirectoryQuery,
  serializeDirectoryQuery,
  type CreatorEntry,
  type DirectoryEntry,
  type DirectoryGroupId,
  type PlatformEntry,
} from './provider-directory';

const SOURCE = {
  id: 'src-a',
  url: 'https://example.com/a',
  title: 'Announcement',
  type: 'official-announcement',
  publisherId: 'example',
  lastCheckedDate: '2026-01-01',
};

function makeOrganization(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    name,
    // These fixtures do not exercise the two recorded name forms, so both
    // agree and `name` stays the displayed label. Pass `extra` to make them
    // differ where a test is about the label rule itself.
    shortName: name,
    type: 'company',
    website: `https://${id}.example/`,
    releasePage: `https://${id}.example/news`,
    description: 'Fixture organization.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
    ...extra,
  };
}

function makeFamily(id: string, organizationId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    organizationId,
    name: id,
    description: 'Fixture family.',
    categories: ['language-reasoning'],
    firstReleaseDate: '2025-01-01',
    datePrecision: 'day',
    status: 'current',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
    ...extra,
  };
}

function makeRelease(id: string, organizationId: string, familyId: string) {
  return {
    id,
    slug: id,
    canonicalName: id,
    displayName: id,
    organizationId,
    familyId,
    version: '1',
    variant: 'Standard',
    releaseDate: '2025-06-01',
    datePrecision: 'day',
    status: 'current',
    featured: false,
    categories: ['language-reasoning'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    accessType: 'proprietary-hosted',
    apiAliases: [],
    predecessorIds: [],
    successorIds: [],
    siblingIds: [],
    summary: 'A fixture release.',
    intendedUse: 'Fixture use.',
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
  };
}

function makePlatform(
  id: string,
  name: string,
  organizationId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    slug: id,
    name,
    organizationId,
    type: 'first-party-api',
    website: `https://${id}.example/`,
    sourceIds: ['src-a'],
    verifiedAt: '2026-01-01',
    ...extra,
  };
}

function makeDataset(overrides: Record<string, unknown> = {}): Dataset {
  return validateDataset({
    sources: [SOURCE],
    publishers: [{ id: 'example', name: 'Example' }],
    organizations: [makeOrganization('alpha', 'Alpha Labs')],
    families: [makeFamily('alpha-one', 'alpha')],
    releases: [makeRelease('alpha-new', 'alpha', 'alpha-one')],
    ...overrides,
  });
}

/**
 * A fixture that is populated in every dimension the seed data currently is not:
 * a creator that operates no platform, a creator that also operates one, an
 * organization that only operates a platform, an organization with neither role,
 * and names that exercise initial normalization. The seed dataset holds no
 * serving platform at all, so without this fixture every platform assertion in
 * this file would pass by having nothing to check.
 */
function makePopulatedDataset(): Dataset {
  return makeDataset({
    organizations: [
      makeOrganization('alpha', 'Alpha Labs'),
      makeOrganization('eclair', 'Éclair Research', { type: 'research-lab' }),
      makeOrganization('hostco', 'Hosting Co'),
      makeOrganization('quiet', 'Quiet Holdings'),
      makeOrganization('numeric', '01 Systems'),
    ],
    families: [
      makeFamily('alpha-one', 'alpha'),
      makeFamily('eclair-one', 'eclair', { categories: ['coding'] }),
      makeFamily('numeric-one', 'numeric'),
    ],
    releases: [
      makeRelease('alpha-new', 'alpha', 'alpha-one'),
      makeRelease('alpha-old', 'alpha', 'alpha-one'),
      makeRelease('numeric-new', 'numeric', 'numeric-one'),
    ],
    servingPlatforms: [
      makePlatform('alpha-api', 'Alpha API', 'alpha'),
      makePlatform('hosting-cloud', 'Hosting Cloud', 'hostco', { type: 'cloud-platform' }),
    ],
    deployments: [
      {
        id: 'alpha-new-on-alpha-api',
        releaseId: 'alpha-new',
        platformId: 'alpha-api',
        deliveryMode: 'hosted-api',
        regions: [],
        effectiveFrom: '2025-06-01',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
      {
        id: 'alpha-old-on-alpha-api',
        releaseId: 'alpha-old',
        platformId: 'alpha-api',
        deliveryMode: 'hosted-api',
        regions: [],
        effectiveFrom: '2025-06-01',
        sourceIds: ['src-a'],
        verifiedAt: '2026-01-01',
      },
    ],
  });
}

function group(dataset: Dataset, id: DirectoryGroupId, base = '/') {
  const found = buildProviderDirectory(dataset, base).groups.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} group`);
  return found;
}

function slugs(entries: readonly DirectoryEntry[]) {
  return entries.map((entry) => entry.slug);
}

function creator(dataset: Dataset, slug: string): CreatorEntry {
  const found = group(dataset, 'creators').entries.find((entry) => entry.slug === slug);
  if (!found || found.kind !== 'creator') throw new Error(`no creator ${slug}`);
  return found;
}

function platform(dataset: Dataset, slug: string): PlatformEntry {
  const found = group(dataset, 'serving-platforms').entries.find((entry) => entry.slug === slug);
  if (!found || found.kind !== 'serving-platform') throw new Error(`no platform ${slug}`);
  return found;
}

describe('directory initials', () => {
  it('files a plain name under its own uppercase letter', () => {
    expect(directoryInitial('Anthropic')).toBe('A');
    expect(directoryInitial('meta')).toBe('M');
    expect(directoryInitial('  Zephyr Labs')).toBe('Z');
  });

  it('folds a decomposable accent onto its base letter', () => {
    expect(directoryInitial('Éclair Research')).toBe('E');
    expect(directoryInitial('Ångström AI')).toBe('A');
  });

  it('files anything that is not an A-Z letter under the other bucket', () => {
    expect(directoryInitial('01 Systems')).toBe(OTHER_INITIAL);
    expect(directoryInitial('Ørsted Intelligence')).toBe(OTHER_INITIAL);
    expect(directoryInitial('深度求索')).toBe(OTHER_INITIAL);
    expect(directoryInitial('')).toBe(OTHER_INITIAL);
  });
});

describe('letter buckets', () => {
  const dataset = makePopulatedDataset();

  it('keeps every letter of the alphabet even when nothing files under it', () => {
    const { letters } = group(dataset, 'creators');
    const alphabetLetters = letters.filter((entry) => entry.letter !== OTHER_INITIAL);

    expect(alphabetLetters.map((entry) => entry.letter)).toEqual([...DIRECTORY_LETTERS]);
  });

  it('reports empty letters as empty rather than dropping them', () => {
    const { letters, entries } = group(dataset, 'creators');
    const populated = letters.filter((entry) => entry.entries.length > 0);
    const empty = letters.filter((entry) => entry.entries.length === 0);

    expect(populated.map((entry) => entry.letter)).toEqual(['A', 'E', OTHER_INITIAL]);
    // The absence is the point: most of the alphabet has nothing under it, and
    // the bar still lists it. Derived from the letter list, never a literal 26.
    expect(empty.length).toBe(DIRECTORY_LETTERS.length - 2);
    expect(populated.flatMap((entry) => entry.entries).length).toBe(entries.length);
  });

  it('adds the other bucket only when a name actually falls in it', () => {
    const withOther = buildDirectoryLetters(group(dataset, 'creators').entries);
    const withoutOther = buildDirectoryLetters(
      group(dataset, 'creators').entries.filter((entry) => entry.initial !== OTHER_INITIAL),
    );

    expect(withOther.at(-1)?.letter).toBe(OTHER_INITIAL);
    expect(withoutOther.some((entry) => entry.letter === OTHER_INITIAL)).toBe(false);
    expect(withoutOther.length).toBe(DIRECTORY_LETTERS.length);
  });

  it('gives each group its own section id so both can hold the same letter', () => {
    expect(letterSectionId('creators', 'A')).toBe('directory-creators-a');
    expect(letterSectionId('serving-platforms', 'A')).toBe('directory-serving-platforms-a');
    expect(letterSectionId('creators', OTHER_INITIAL)).toBe('directory-creators-other');
  });
});

describe('grouping by evidenced role', () => {
  const dataset = makePopulatedDataset();

  it('lists an organization as a creator only when it publishes a family', () => {
    const creators = group(dataset, 'creators');

    // hostco operates a platform and publishes nothing, so it is not a creator.
    // quiet publishes nothing and operates nothing, so it is not one either.
    expect(slugs(creators.entries)).toEqual(['numeric', 'alpha', 'eclair']);
    expect(creators.total).toBe(3);
  });

  it('lists serving platforms under their own names, not their operators', () => {
    const platforms = group(dataset, 'serving-platforms');

    expect(slugs(platforms.entries)).toEqual(['alpha-api', 'hosting-cloud']);
    expect(platforms.entries.map((entry) => entry.name)).toEqual(['Alpha API', 'Hosting Cloud']);
    expect(platforms.entries.every((entry) => entry.kind === 'serving-platform')).toBe(true);
  });

  it('never files a serving platform in the creator group', () => {
    const creators = group(dataset, 'creators');

    // The operator of a platform-only organization must not leak in here, and
    // the platform record itself must not appear as a creator under any name.
    expect(slugs(creators.entries)).not.toContain('hostco');
    expect(slugs(creators.entries)).not.toContain('alpha-api');
    expect(creators.entries.every((entry) => entry.kind === 'creator')).toBe(true);
  });

  it('states both roles on an organization that creates and serves', () => {
    const both = creator(dataset, 'alpha');
    const onlyCreates = creator(dataset, 'eclair');

    expect(both.operatedPlatformCount).toBe(1);
    expect(both.roleText).toBe('Model creator and serving-platform operator');
    expect(onlyCreates.operatedPlatformCount).toBe(0);
    expect(onlyCreates.roleText).toBe('Model creator');
  });

  it('names the operator on a platform row and says whether it also creates', () => {
    const firstParty = platform(dataset, 'alpha-api');
    const thirdParty = platform(dataset, 'hosting-cloud');

    expect(firstParty.operatorName).toBe('Alpha Labs');
    expect(firstParty.operatorIsCreator).toBe(true);
    expect(firstParty.roleText).toBe('Serving platform, operated by a model creator');
    expect(thirdParty.operatorName).toBe('Hosting Co');
    expect(thirdParty.operatorIsCreator).toBe(false);
    expect(thirdParty.roleText).toBe('Serving platform');
  });

  it('names an organization with neither role instead of defaulting it into one', () => {
    const directory = buildProviderDirectory(dataset, '/');

    expect(directory.unclassified.map((entry) => entry.slug)).toEqual(['quiet']);
    expect(slugs(group(dataset, 'creators').entries)).not.toContain('quiet');
    expect(slugs(group(dataset, 'serving-platforms').entries)).not.toContain('quiet');
  });

  it('states each entity kind in words on the row', () => {
    expect(creator(dataset, 'eclair').typeText).toBe('Research lab');
    expect(creator(dataset, 'alpha').typeText).toBe('Company');
    expect(platform(dataset, 'alpha-api').typeText).toBe('First-party API');
    expect(platform(dataset, 'hosting-cloud').typeText).toBe('Cloud platform');
  });
});

describe('derived counts', () => {
  const dataset = makePopulatedDataset();

  it('counts an organization families and releases from its own relationships', () => {
    expect(creator(dataset, 'alpha').familyCount).toBe(1);
    expect(creator(dataset, 'alpha').releaseCount).toBe(2);
    expect(creator(dataset, 'eclair').releaseCount).toBe(0);
  });

  it('counts distinct releases served by a platform from its deployments', () => {
    expect(platform(dataset, 'alpha-api').servedReleaseCount).toBe(2);
    expect(platform(dataset, 'hosting-cloud').servedReleaseCount).toBe(0);
  });

  it('collects a creator categories from its families', () => {
    expect(creator(dataset, 'eclair').categories).toEqual(['coding']);
    expect(creator(dataset, 'alpha').categories).toEqual(['language-reasoning']);
  });

  it('grows with the data rather than with a code change', () => {
    const grown = makeDataset({
      organizations: [makeOrganization('alpha', 'Alpha Labs'), makeOrganization('delta', 'Delta AI')],
      families: [makeFamily('alpha-one', 'alpha'), makeFamily('delta-one', 'delta')],
      releases: [makeRelease('alpha-new', 'alpha', 'alpha-one'), makeRelease('delta-new', 'delta', 'delta-one')],
    });
    const before = group(makeDataset(), 'creators');
    const after = group(grown, 'creators');

    expect(after.total).toBe(before.total + 1);
    expect(slugs(after.entries)).toEqual(['alpha', 'delta']);
    expect(after.letters.find((entry) => entry.letter === 'D')?.entries.map((e) => e.slug))
      .toEqual(['delta']);
  });

  it('matches the seed dataset relationships it is derived from', () => {
    // Positive control: the seed has creators, so the assertions below are
    // checking a populated group rather than agreeing about an empty one.
    const creators = group(seedDataset, 'creators');
    const expected = seedDataset.organizations
      .filter((organization) => seedDataset.families.some((f) => f.organizationId === organization.id))
      .map((organization) => organization.slug)
      .sort();

    expect(expected.length).toBeGreaterThan(0);
    expect(slugs(creators.entries).sort()).toEqual(expected);
    for (const entry of creators.entries) {
      const releases = seedDataset.releases.filter((r) => {
        const organization = seedDataset.organizations.find((o) => o.slug === entry.slug);
        return organization ? r.organizationId === organization.id : false;
      });
      expect((entry as CreatorEntry).releaseCount).toBe(releases.length);
    }
  });

  it('reports the seed serving-platform group from the records the data holds', () => {
    // These are the first sourced platform records this dataset has carried, so
    // the group is no longer empty. Derived from the data rather than counted,
    // so a later sourced platform does not force an unrelated edit here; the
    // fixture-backed tests above remain the proof of the group's shape.
    const platforms = seedDataset.servingPlatforms;
    expect(platforms.length).toBeGreaterThan(0);
    expect(group(seedDataset, 'serving-platforms').total).toBe(platforms.length);
    expect(slugs(group(seedDataset, 'serving-platforms').entries).sort())
      .toEqual(platforms.map((platform) => platform.slug).sort());
  });

  it('still explains the empty group when no platform is recorded', () => {
    // Kept because the message is what a reader sees before a creator's first
    // platform lands, and the seed stopped proving it the moment one did.
    const empty = { ...seedDataset, servingPlatforms: [] };
    expect(group(empty, 'serving-platforms').total).toBe(0);
    expect(group(empty, 'serving-platforms').emptyMessage).toContain('primary sources');
  });
});

describe('where a row leads', () => {
  it('points a creator at the catalog filtered to that creator', () => {
    const dataset = makePopulatedDataset();

    expect(creator(dataset, 'alpha').href).toBe('/models/?creator=alpha');
    expect(creator(dataset, 'alpha').unlinkedNote).toBeNull();
  });

  it('respects a deployed base path', () => {
    expect(creatorCatalogHref('/ModelTree', 'openai')).toBe('/ModelTree/models/?creator=openai');
    expect(creatorCatalogHref('/ModelTree/', 'openai')).toBe('/ModelTree/models/?creator=openai');
  });

  it('produces a link the catalog itself restores to that creator filter', () => {
    // End-to-end against the catalog's own parser: if the emitted query key or
    // value ever stopped matching what the catalog reads, this fails rather than
    // silently linking to an unfiltered catalog.
    const index = buildCatalogIndex(seedDataset, '/');
    const entry = group(seedDataset, 'creators').entries[0] as CreatorEntry;
    const href = entry.href;
    if (!href) throw new Error('seed creator should link to the catalog');

    const state = parseCatalogState(new URL(href, 'https://example.test').search, index.facets);

    expect(state.filters.creators).toEqual([entry.slug]);
  });

  it('links nothing and says why when a creator has no release yet', () => {
    const entry = creator(makePopulatedDataset(), 'eclair');

    expect(entry.releaseCount).toBe(0);
    expect(entry.href).toBeNull();
    expect(entry.unlinkedNote).toBe('No release recorded yet, so there is no catalog view to open.');
  });

  it('marks a serving platform as having no generated page yet', () => {
    const entry = platform(makePopulatedDataset(), 'alpha-api');

    expect(entry.href).toBeNull();
    expect(entry.unlinkedNote).toBe('A serving-platform page is not generated yet.');
  });
});

describe('search', () => {
  const dataset = makePopulatedDataset();
  const directory = buildProviderDirectory(dataset, '/');

  it('matches a creator by full name and by short name, ignoring case', () => {
    const entry = creator(dataset, 'alpha');

    expect(matchesDirectorySearch(entry, 'alpha labs')).toBe(true);
    expect(matchesDirectorySearch(entry, 'ALPHA')).toBe(true);
    expect(matchesDirectorySearch(entry, '  alpha  ')).toBe(true);
    expect(matchesDirectorySearch(entry, 'hosting')).toBe(false);
  });

  it('matches a platform by its own name, its operator, and its type', () => {
    const entry = platform(dataset, 'hosting-cloud');

    expect(matchesDirectorySearch(entry, 'hosting cloud')).toBe(true);
    expect(matchesDirectorySearch(entry, 'hosting co')).toBe(true);
    expect(matchesDirectorySearch(entry, 'cloud platform')).toBe(true);
    expect(matchesDirectorySearch(entry, 'alpha')).toBe(false);
  });

  it('narrows both groups and rebuilds their counts and letters', () => {
    const filtered = filterDirectory(directory, 'alpha');
    const creators = filtered.groups.find((entry) => entry.id === 'creators')!;
    const platforms = filtered.groups.find((entry) => entry.id === 'serving-platforms')!;

    expect(slugs(creators.entries)).toEqual(['alpha']);
    expect(creators.total).toBe(1);
    expect(slugs(platforms.entries)).toEqual(['alpha-api']);
    expect(filtered.totalEntries).toBe(2);
    expect(creators.letters.filter((entry) => entry.entries.length > 0).map((e) => e.letter))
      .toEqual(['A']);
  });

  it('keeps the whole alphabet in the bar while a search is active', () => {
    const filtered = filterDirectory(directory, 'alpha');
    const creators = filtered.groups.find((entry) => entry.id === 'creators')!;

    expect(creators.letters.filter((e) => e.letter !== OTHER_INITIAL).map((e) => e.letter))
      .toEqual([...DIRECTORY_LETTERS]);
  });

  it('returns an empty directory rather than everything when nothing matches', () => {
    const filtered = filterDirectory(directory, 'no such organization');

    expect(filtered.totalEntries).toBe(0);
    expect(filtered.groups.every((entry) => entry.entries.length === 0)).toBe(true);
  });

  it('returns the directory untouched for an empty search', () => {
    expect(filterDirectory(directory, '   ')).toBe(directory);
    expect(filterDirectory(directory, '').totalEntries).toBe(directory.totalEntries);
  });
});

describe('shareable search url', () => {
  it('round-trips a search through the query string', () => {
    expect(serializeDirectoryQuery('Alpha Labs')).toBe('?q=Alpha+Labs');
    expect(parseDirectoryQuery(serializeDirectoryQuery('Alpha Labs'))).toBe('Alpha Labs');
  });

  it('writes nothing for an empty search and reads nothing back', () => {
    expect(serializeDirectoryQuery('   ')).toBe('');
    expect(parseDirectoryQuery('')).toBe('');
    expect(parseDirectoryQuery('?other=x')).toBe('');
  });

  it('survives characters that need encoding', () => {
    const query = 'Ünicode & co ?';

    expect(parseDirectoryQuery(serializeDirectoryQuery(query))).toBe(query);
  });
});

describe('ordering and verification', () => {
  it('sorts entries by name within each group', () => {
    const dataset = makePopulatedDataset();

    // "01 Systems" sorts ahead of the letters by codepoint; the letter bucket it
    // renders in is separate from this order.
    expect(group(dataset, 'creators').entries.map((entry) => entry.name))
      .toEqual(['01 Systems', 'Alpha Labs', 'Éclair Research']);
  });

  it('reports the latest verification date across both entity kinds', () => {
    const dataset = makeDataset({
      organizations: [makeOrganization('alpha', 'Alpha Labs')],
      servingPlatforms: [makePlatform('alpha-api', 'Alpha API', 'alpha', { verifiedAt: '2026-03-04' })],
    });

    expect(buildProviderDirectory(dataset, '/').latestVerifiedAt).toBe('2026-03-04');
  });
});
