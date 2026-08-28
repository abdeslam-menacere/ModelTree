import type { PostedDocument, PostedRecord, RefreshRun } from '../data/refresh-log-schema';
import { comparePartialDatesDescending } from '../data/partial-date';

/**
 * Links from a recorded run to the things it actually published.
 *
 * The log is a historical record and the dataset is the present, so the two are
 * allowed to disagree: a record a run added may since have been renamed, merged,
 * or removed. Every link here is resolved against today's dataset, and an id that
 * no longer resolves is reported as unresolved rather than linked to a page the
 * build does not generate.
 */

/** Where the dataset documents live, relative to the repository root. */
export const DATASET_DIRECTORY = 'web/src/data';

/** The slice of the dataset a posted record can point at. */
export interface LinkableDataset {
  organizations: readonly { readonly id: string; readonly name: string }[];
  families: readonly { readonly id: string; readonly name: string }[];
  releases: readonly {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly familyId: string;
    readonly organizationId: string;
    readonly releaseDate: string;
  }[];
}

export interface LinkOptions {
  /** Astro's BASE_URL. */
  base: string;
  /** Releases the tree can actually open. A release outside it has no tree link. */
  treeReleaseIds: readonly string[];
}

/** A model passport page, or the tree opened on a release inside the entity. */
export type PostedLinkTarget = 'passport' | 'tree';

export interface PostedRecordLink {
  record: PostedRecord;
  /** The entity's name in today's dataset, falling back to the id the run recorded. */
  label: string;
  href?: string;
  target?: PostedLinkTarget;
  /** False when the id this run recorded is not in today's dataset. */
  resolved: boolean;
}

export interface PostedDocumentLink {
  document: PostedDocument;
  /** The file as this run left it, when the run recorded a commit to anchor to. */
  href?: string;
}

function withTrailingSlash(base: string) {
  return base.endsWith('/') ? base : `${base}/`;
}

/** Newest first, with the id breaking a tie so the choice never depends on input order. */
function newestFirst<T extends { releaseDate: string; id: string }>(releases: readonly T[]) {
  return [...releases].sort((a, b) => (
    comparePartialDatesDescending(a.releaseDate, b.releaseDate) || (a.id < b.id ? 1 : -1)
  ));
}

/**
 * The tree deep link selects a release and opens its ancestors, so a family or a
 * creator is reached through its newest release that the tree actually carries.
 */
function treeHref(
  candidates: readonly LinkableDataset['releases'][number][],
  { base, treeReleaseIds }: LinkOptions,
) {
  const openable = newestFirst(candidates).find(({ id }) => treeReleaseIds.includes(id));
  return openable ? `${withTrailingSlash(base)}tree/?model=${encodeURIComponent(openable.id)}` : undefined;
}

export function postedRecordLink(
  record: PostedRecord,
  data: LinkableDataset,
  options: LinkOptions,
): PostedRecordLink {
  if (record.collection === 'releases') {
    const release = data.releases.find(({ id }) => id === record.id);
    if (!release) return { record, label: record.id, resolved: false };
    return {
      record,
      label: release.displayName,
      href: `${withTrailingSlash(options.base)}models/${release.slug}/`,
      target: 'passport',
      resolved: true,
    };
  }

  if (record.collection === 'families') {
    const family = data.families.find(({ id }) => id === record.id);
    if (!family) return { record, label: record.id, resolved: false };
    const href = treeHref(
      data.releases.filter(({ familyId }) => familyId === family.id),
      options,
    );
    return { record, label: family.name, href, target: href ? 'tree' : undefined, resolved: true };
  }

  if (record.collection === 'organizations') {
    const organization = data.organizations.find(({ id }) => id === record.id);
    if (!organization) return { record, label: record.id, resolved: false };
    const href = treeHref(
      data.releases.filter(({ organizationId }) => organizationId === organization.id),
      options,
    );
    return {
      record,
      label: organization.name,
      href,
      target: href ? 'tree' : undefined,
      resolved: true,
    };
  }

  return { record, label: record.id, resolved: false };
}

export function postedRecordLinks(run: RefreshRun, data: LinkableDataset, options: LinkOptions) {
  return run.posted.records.map((record) => postedRecordLink(record, data, options));
}

const COMMIT_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})$/;

/**
 * The commit a run recorded, as the repository slug and SHA needed to link a file
 * at that point in history. Undefined when the run named no parseable commit.
 */
export function runCommit(run: RefreshRun) {
  for (const reference of run.references) {
    if (reference.kind !== 'commit') continue;
    const match = COMMIT_URL.exec(reference.url);
    if (match) return { owner: match[1], repo: match[2], sha: match[3] };
  }

  return undefined;
}

/**
 * Documents link to the file as that run left it, never to the current file: the
 * point of the link is to show what the run did, and `main` has moved on since.
 */
export function postedDocumentLinks(run: RefreshRun): PostedDocumentLink[] {
  const commit = runCommit(run);

  return run.posted.documents.map((document) => ({
    document,
    href: commit
      ? `https://github.com/${commit.owner}/${commit.repo}/blob/${commit.sha}/${DATASET_DIRECTORY}/${document.document}`
      : undefined,
  }));
}
