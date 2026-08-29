import type { Dataset, Organization, ServingPlatform } from '../data/schema';
import { buildProviderRouteResolver } from './catalog';
import { FILTER_DIMENSIONS } from './catalog-view';
import { organizationLabel, organizationSearchTerms } from './organization-name';

/**
 * The A-Z directory of model creators and serving platforms.
 *
 * "Provider" is the word this page exists to stop using. A model creator and a
 * serving platform are different entities in this dataset -- one trains and
 * publishes model families, the other makes releases reachable -- and one
 * organization can be both without the two roles collapsing. So the directory
 * keeps them in separately labelled groups, states each role in words, and
 * derives membership from relationships in the data rather than from an
 * organization's name or its `type` field. `type` says company or research-lab;
 * it says nothing about whether anything was created or served.
 *
 * Every count here is derived. Nothing in this file, its tests, or the page it
 * feeds asserts how many organizations, platforms, or letters exist: when
 * sourced records land, the directory grows without a code change.
 */

/**
 * The Latin alphabet the jump bar offers. This is a property of the alphabet,
 * not of the dataset, so it is the one list here that is written down rather
 * than derived. Read its length instead of restating a number.
 */
export const DIRECTORY_LETTERS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
] as const;

/** The bucket for a name that does not start with an unaccented A-Z letter. */
export const OTHER_INITIAL = '#';

/** Fragment-safe stand-in for {@link OTHER_INITIAL}, which `#` cannot be. */
const OTHER_SLUG = 'other';

export const DIRECTORY_SEARCH_PARAM = 'q';

/**
 * The catalog's own query key for a creator filter, read from the catalog's
 * declaration rather than written out again. If the catalog ever renames the
 * parameter, the links this directory emits follow it instead of quietly
 * pointing at a filter the catalog no longer parses.
 */
const CREATOR_FILTER_PARAM = FILTER_DIMENSIONS.find(
  (dimension) => dimension.key === 'creators',
)!.param;

export type DirectoryGroupId = 'creators' | 'serving-platforms';

interface DirectoryEntryBase {
  id: string;
  slug: string;
  /**
   * The string this row is displayed as, sorted by, and filed under. For a
   * creator that is the organization label -- see `organization-name.ts` -- and
   * for a serving platform it is the platform's own name.
   */
  name: string;
  initial: string;
  /** The role in plain words, because the row must not rely on its group alone. */
  roleText: string;
  /** The entity's own kind: organization type, or serving-platform type. */
  typeText: string;
  verifiedAt: string;
  /**
   * Where the row leads, or null when this build generates nothing for it. A
   * null route is rendered as an explicit statement of what is not built yet,
   * never as a link that would 404.
   */
  href: string | null;
  /** Why {@link href} is null. Always set when href is null, else null. */
  unlinkedNote: string | null;
  /** Lowercased strings the search box matches against. */
  terms: string[];
}

export interface CreatorEntry extends DirectoryEntryBase {
  kind: 'creator';
  /**
   * The organization's recorded short form. Equal to {@link name} under the
   * current label rule, and kept as its own field because it is a recorded
   * value rather than a rendering decision.
   */
  shortName: string;
  organizationType: Organization['type'];
  familyCount: number;
  releaseCount: number;
  categories: string[];
  /**
   * How many serving platforms this same organization operates. Above zero it
   * is the multi-role case: the organization stays one record, is listed here
   * as a creator, and its platforms are listed under their own names in the
   * platform group. The number is stated on the row so the second role is
   * visible without cross-referencing.
   */
  operatedPlatformCount: number;
}

export interface PlatformEntry extends DirectoryEntryBase {
  kind: 'serving-platform';
  platformType: ServingPlatform['type'];
  operatorName: string;
  operatorSlug: string;
  /** True when the operator also creates model families: stated, not implied. */
  operatorIsCreator: boolean;
  /** Distinct releases recorded as deployed here, from validated deployments. */
  servedReleaseCount: number;
}

export type DirectoryEntry = CreatorEntry | PlatformEntry;

export interface DirectoryLetter {
  letter: string;
  /** Fragment id fragment; `#` is not usable in a URL fragment. */
  key: string;
  entries: DirectoryEntry[];
}

export interface DirectoryGroup {
  id: DirectoryGroupId;
  label: string;
  /** One sentence stating what membership of this group does and does not mean. */
  roleDescription: string;
  /** Singular/plural noun for counts, so the summary reads as a sentence. */
  noun: { one: string; many: string };
  entries: DirectoryEntry[];
  /**
   * Every letter of the alphabet, in order, plus `#` only when something is
   * filed under it. Letters with no entries are kept rather than dropped -- see
   * {@link buildDirectoryLetters}.
   */
  letters: DirectoryLetter[];
  total: number;
  /** Shown in place of rows when the group has no entries at all. */
  emptyMessage: string;
}

/**
 * An organization the data does not yet place in either role: it publishes no
 * model family and operates no serving platform. It is named rather than
 * dropped, because a silent omission would read as "no such organization", and
 * it is not filed under a role, because `type` is not evidence of one.
 */
export interface UnclassifiedOrganization {
  id: string;
  slug: string;
  /** The organization label -- see `organization-name.ts`. */
  name: string;
  verifiedAt: string;
}

export interface DirectoryModel {
  groups: DirectoryGroup[];
  unclassified: UnclassifiedOrganization[];
  totalEntries: number;
  latestVerifiedAt: string;
}

/** Codepoint order, so output does not vary with the host's locale. */
function compare(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function normalizeBase(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * The letter a name files under.
 *
 * Combining marks are stripped first, so an accented initial files with its
 * base letter instead of under `#`. Only decomposable accents fold: a letter
 * such as O-slash, which Unicode does not decompose, files under `#` rather
 * than being guessed into a letter, because mapping it is a collation decision
 * this repository has not made and inventing one would be a claim about the
 * name that no source states.
 */
export function directoryInitial(name: string): string {
  const first = name
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .slice(0, 1)
    .toUpperCase();
  return /^[A-Z]$/.test(first) ? first : OTHER_INITIAL;
}

export function letterKey(letter: string): string {
  return letter === OTHER_INITIAL ? OTHER_SLUG : letter.toLowerCase();
}

/** The DOM id of one letter's section, unique across both groups. */
export function letterSectionId(groupId: DirectoryGroupId, letter: string): string {
  return `directory-${groupId}-${letterKey(letter)}`;
}

/**
 * The catalog view filtered to one creator. This is the fallback destination for
 * a creator that has no generated `/providers/<slug>/` page of its own: rather
 * than link a route that does not exist, or leave the row dead, the creator
 * points at the model catalog narrowed to its own releases. That is a route this
 * build really generates, and the query key comes from the catalog's own filter
 * declaration so the two cannot drift apart. Creators that do have a generated
 * page link to it instead -- see {@link buildProviderDirectory}.
 */
export function creatorCatalogHref(base: string, slug: string): string {
  return `${normalizeBase(base)}models/?${CREATOR_FILTER_PARAM}=${encodeURIComponent(slug)}`;
}

const ORGANIZATION_TYPE_TEXT: Record<Organization['type'], string> = {
  company: 'Company',
  'research-lab': 'Research lab',
  nonprofit: 'Nonprofit',
  community: 'Community',
};

const PLATFORM_TYPE_TEXT: Record<ServingPlatform['type'], string> = {
  'first-party-api': 'First-party API',
  'cloud-platform': 'Cloud platform',
  aggregator: 'Aggregator',
  'model-hub': 'Model hub',
  'local-runtime': 'Local runtime',
};

export function organizationTypeText(type: Organization['type']): string {
  return ORGANIZATION_TYPE_TEXT[type];
}

export function platformTypeText(type: ServingPlatform['type']): string {
  return PLATFORM_TYPE_TEXT[type];
}

/**
 * Buckets entries by initial and keeps every letter of the alphabet, including
 * the ones nothing files under.
 *
 * Dropping empty letters was the alternative. It was rejected because the bar
 * would then change shape with the data, and a reader who cannot find D cannot
 * tell "no creator starts with D" from "the bar is broken". Keeping the letter
 * makes the absence itself the answer. The empty ones are rendered as inert
 * text rather than links -- a link to a section with nothing in it is a dead
 * control and, on this dataset, most of the bar would be dead controls.
 *
 * `#` is different: it is not part of the alphabet, so it appears only when
 * something is actually filed under it, and never as a permanently empty slot.
 */
export function buildDirectoryLetters(entries: readonly DirectoryEntry[]): DirectoryLetter[] {
  const byInitial = new Map<string, DirectoryEntry[]>();
  for (const entry of entries) {
    const bucket = byInitial.get(entry.initial);
    if (bucket) bucket.push(entry);
    else byInitial.set(entry.initial, [entry]);
  }

  const letters: DirectoryLetter[] = DIRECTORY_LETTERS.map((letter) => ({
    letter,
    key: letterKey(letter),
    entries: byInitial.get(letter) ?? [],
  }));

  const other = byInitial.get(OTHER_INITIAL);
  if (other?.length) {
    letters.push({ letter: OTHER_INITIAL, key: OTHER_SLUG, entries: other });
  }

  return letters;
}

function sortEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug));
}

function buildGroup(
  id: DirectoryGroupId,
  label: string,
  roleDescription: string,
  noun: { one: string; many: string },
  emptyMessage: string,
  entries: DirectoryEntry[],
): DirectoryGroup {
  const sorted = sortEntries(entries);
  return {
    id,
    label,
    roleDescription,
    noun,
    entries: sorted,
    letters: buildDirectoryLetters(sorted),
    total: sorted.length,
    emptyMessage,
  };
}

const CREATOR_GROUP = {
  label: 'Model creators and labs',
  roleDescription:
    'Organizations that publish model families of their own. Membership follows the '
    + 'families and releases recorded against an organization, not its name or its '
    + 'company type. Serving a model does not put an organization here.',
  noun: { one: 'creator', many: 'creators' },
  emptyMessage:
    'No organization in the reviewed data publishes a model family yet.',
} as const;

const PLATFORM_GROUP = {
  label: 'Serving platforms',
  roleDescription:
    'Places a model can be reached: first-party APIs, cloud platforms, aggregators, '
    + 'model hubs, and local runtimes. A platform is listed under its own name and is '
    + 'never treated as the creator of the models it serves.',
  noun: { one: 'serving platform', many: 'serving platforms' },
  emptyMessage:
    'No serving platform has been added to the reviewed data yet. Platforms are '
    + 'listed here only once a record carries its primary sources and a verification '
    + 'date, so this group stays empty rather than being filled with unsourced entries.',
} as const;

/**
 * Derives the whole directory from the dataset.
 *
 * A creator is an organization with at least one model family. A platform row
 * is a serving-platform record, listed under its own name with its operator
 * named alongside. An organization that only operates platforms gets no creator
 * row -- it appears as the operator of its platforms -- and an organization
 * with neither is reported as unclassified rather than defaulted into a role.
 */
export function buildProviderDirectory(dataset: Dataset, base: string): DirectoryModel {
  const resolveProviderRoute = buildProviderRouteResolver(dataset, base);

  const familiesByOrganization = new Map<string, typeof dataset.families>();
  for (const family of dataset.families) {
    const bucket = familiesByOrganization.get(family.organizationId);
    if (bucket) bucket.push(family);
    else familiesByOrganization.set(family.organizationId, [family]);
  }

  const releaseCountByOrganization = new Map<string, number>();
  for (const release of dataset.releases) {
    const current = releaseCountByOrganization.get(release.organizationId) ?? 0;
    releaseCountByOrganization.set(release.organizationId, current + 1);
  }

  const platformCountByOperator = new Map<string, number>();
  for (const platform of dataset.servingPlatforms) {
    const current = platformCountByOperator.get(platform.organizationId) ?? 0;
    platformCountByOperator.set(platform.organizationId, current + 1);
  }

  const servedReleasesByPlatform = new Map<string, Set<string>>();
  for (const deployment of dataset.deployments) {
    const bucket = servedReleasesByPlatform.get(deployment.platformId);
    if (bucket) bucket.add(deployment.releaseId);
    else servedReleasesByPlatform.set(deployment.platformId, new Set([deployment.releaseId]));
  }

  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));

  const creators: DirectoryEntry[] = [];
  const unclassified: UnclassifiedOrganization[] = [];

  for (const organization of dataset.organizations) {
    const families = familiesByOrganization.get(organization.id) ?? [];
    const operatedPlatformCount = platformCountByOperator.get(organization.id) ?? 0;

    if (!families.length) {
      // No family means no evidence of creating anything. If the organization
      // operates platforms it is already visible as their operator; if it does
      // not, it is named as unclassified so it is neither invented into a role
      // nor silently dropped.
      if (!operatedPlatformCount) {
        unclassified.push({
          id: organization.id,
          slug: organization.slug,
          name: organizationLabel(organization),
          verifiedAt: organization.verifiedAt,
        });
      }
      continue;
    }

    const releaseCount = releaseCountByOrganization.get(organization.id) ?? 0;
    const roleText = operatedPlatformCount
      ? 'Model creator and serving-platform operator'
      : 'Model creator';

    // Where the creator's name leads. A generated per-organization page is the
    // canonical destination, so it wins when one exists -- the set of pages is
    // read from the same rule the route generation uses, so a row never links a
    // page the build omits nor omits a link to one it produces. With no page,
    // the row falls back to the catalog filtered to this creator, and with no
    // release either it links nothing and says why.
    const providerPageHref = resolveProviderRoute(organization.slug);
    const href = providerPageHref
      ?? (releaseCount ? creatorCatalogHref(base, organization.slug) : null);

    creators.push({
      kind: 'creator',
      id: organization.id,
      slug: organization.slug,
      name: organizationLabel(organization),
      shortName: organization.shortName,
      initial: directoryInitial(organizationLabel(organization)),
      roleText,
      typeText: organizationTypeText(organization.type),
      organizationType: organization.type,
      familyCount: families.length,
      releaseCount,
      categories: [...new Set(families.flatMap((family) => family.categories))].sort(compare),
      operatedPlatformCount,
      verifiedAt: organization.verifiedAt,
      href,
      unlinkedNote: href
        ? null
        : 'No release recorded yet, so there is no catalog view to open.',
      // Both recorded name forms stay searchable. Leading with the label must
      // not cost a reader who knows the creator by its fuller recorded form.
      terms: organizationSearchTerms(organization).map((term) => term.toLowerCase()),
    });
  }

  const platforms: DirectoryEntry[] = dataset.servingPlatforms.map((platform) => {
    const operator = organizationById.get(platform.organizationId);
    const operatorName = operator?.name ?? platform.organizationId;
    const operatorIsCreator = Boolean(familiesByOrganization.get(platform.organizationId)?.length);

    return {
      kind: 'serving-platform',
      id: platform.id,
      slug: platform.slug,
      name: platform.name,
      initial: directoryInitial(platform.name),
      roleText: operatorIsCreator
        ? 'Serving platform, operated by a model creator'
        : 'Serving platform',
      typeText: platformTypeText(platform.type),
      platformType: platform.type,
      operatorName,
      operatorSlug: operator?.slug ?? platform.organizationId,
      operatorIsCreator,
      servedReleaseCount: servedReleasesByPlatform.get(platform.id)?.size ?? 0,
      verifiedAt: platform.verifiedAt,
      // Serving platforms have no generated page and no catalog facet of their
      // own in this build, so the row says so instead of linking anywhere.
      href: null,
      unlinkedNote: 'A serving-platform page is not generated yet.',
      terms: [platform.name, operatorName, platformTypeText(platform.type)].map((term) =>
        term.toLowerCase(),
      ),
    } satisfies PlatformEntry;
  });

  const groups: DirectoryGroup[] = [
    buildGroup(
      'creators',
      CREATOR_GROUP.label,
      CREATOR_GROUP.roleDescription,
      CREATOR_GROUP.noun,
      CREATOR_GROUP.emptyMessage,
      creators,
    ),
    buildGroup(
      'serving-platforms',
      PLATFORM_GROUP.label,
      PLATFORM_GROUP.roleDescription,
      PLATFORM_GROUP.noun,
      PLATFORM_GROUP.emptyMessage,
      platforms,
    ),
  ];

  const verificationDates = [
    ...dataset.organizations.map((item) => item.verifiedAt),
    ...dataset.servingPlatforms.map((item) => item.verifiedAt),
  ].sort(compare);

  return {
    groups,
    unclassified: [...unclassified].sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug)),
    totalEntries: groups.reduce((sum, group) => sum + group.total, 0),
    latestVerifiedAt: verificationDates.at(-1) ?? '',
  };
}

export function normalizeDirectorySearch(value: string): string {
  return value.trim().toLowerCase();
}

/** Substring match over the entry's own terms; no fuzzy matching, no ranking. */
export function matchesDirectorySearch(entry: DirectoryEntry, query: string): boolean {
  const needle = normalizeDirectorySearch(query);
  if (!needle) return true;
  return entry.terms.some((term) => term.includes(needle));
}

/**
 * The directory narrowed to a search. Letters and counts are rebuilt from the
 * surviving entries, so the jump bar offers exactly the sections the reader can
 * actually reach and a group heading never counts rows that are not shown.
 */
export function filterDirectory(directory: DirectoryModel, query: string): DirectoryModel {
  const needle = normalizeDirectorySearch(query);
  if (!needle) return directory;

  const groups = directory.groups.map((group) => {
    const entries = group.entries.filter((entry) => matchesDirectorySearch(entry, needle));
    return {
      ...group,
      entries,
      letters: buildDirectoryLetters(entries),
      total: entries.length,
    };
  });

  return {
    ...directory,
    groups,
    totalEntries: groups.reduce((sum, group) => sum + group.total, 0),
  };
}

/** Reads the shareable search out of a query string. */
export function parseDirectoryQuery(search: string): string {
  return new URLSearchParams(search).get(DIRECTORY_SEARCH_PARAM)?.trim() ?? '';
}

/** Writes the search back, emitting nothing when it is empty so a clean view has a clean URL. */
export function serializeDirectoryQuery(query: string): string {
  const value = query.trim();
  if (!value) return '';
  const params = new URLSearchParams();
  params.set(DIRECTORY_SEARCH_PARAM, value);
  return `?${params.toString()}`;
}
