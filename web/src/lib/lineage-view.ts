import type { Dataset, ModelFamily, ModelRelease, Organization } from '../data/schema';
import { comparePartialDates, comparePartialDatesDescending } from '../data/partial-date';

/**
 * Normalized view models for the homepage lineage explorer.
 *
 * Everything here is derived from validated records. Nothing in this module, and
 * nothing in the component that renders it, names a creator: adding an
 * organization to the dataset adds it to the explorer, and removing one removes
 * it, with no code change either way.
 *
 * The load-bearing rule is that **structure is recorded lineage, never inferred
 * lineage**. A release is nested under another only where the catalog records a
 * predecessor/successor relationship between them. Releases the catalog says
 * nothing about are siblings at the root of their family, so a family with no
 * recorded relationships renders as a flat list with no connectors at all. Order
 * of publication is not evidence of descent, and rendering it as descent would
 * be inventing a fact the sources never stated.
 */

/** How one release relates to the current selection. Drives emphasis and labels. */
export type LineageRelation = 'selected' | 'ancestor' | 'successor' | 'sibling' | 'unrelated';

export interface LineageNode {
  release: ModelRelease;
  /** 0 for a root. Rendering caps indentation; the tree itself is never truncated. */
  depth: number;
  children: LineageNode[];
  /**
   * Recorded predecessors this node is *not* nested under, because a tree gives
   * each node one parent. They are named in the output and never drawn as a
   * second connector, so a converging lineage stays visible without implying a
   * shape the data does not have.
   */
  additionalPredecessorIds: string[];
}

export interface LineageFamilyView {
  family: ModelFamily;
  /** Every release of the family, in deterministic order. */
  releases: ModelRelease[];
  roots: LineageNode[];
  /** Parent-to-child connectors this family renders. Zero when nothing is recorded. */
  linkCount: number;
  /** True when the catalog records any predecessor, successor, or sibling here. */
  hasRecordedLineage: boolean;
  maxDepth: number;
}

export interface LineageEcosystem {
  organization: Organization;
  families: LineageFamilyView[];
  releaseCount: number;
}

export interface LineageHighlight {
  selectedId?: string;
  ancestorIds: ReadonlySet<string>;
  successorIds: ReadonlySet<string>;
  siblingIds: ReadonlySet<string>;
}

export interface LineagePlacement {
  organization: Organization;
  family: LineageFamilyView;
  release: ModelRelease;
}

function compare(a: string, b: string) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Newest first, with an id tiebreak so equal dates never reorder between builds. */
function byNewestRelease(a: ModelRelease, b: ModelRelease) {
  return comparePartialDatesDescending(a.releaseDate, b.releaseDate) || compare(a.id, b.id);
}

function newestReleaseDate(releases: readonly ModelRelease[]) {
  return releases.reduce((newest, release) => (
    newest === '' || comparePartialDates(release.releaseDate, newest) > 0
      ? release.releaseDate
      : newest
  ), '');
}

/**
 * Directed edges within one family, read as the union of both directions.
 *
 * `validate.ts` requires sibling relationships to be reciprocal but imposes no
 * such rule on predecessor/successor, so the same fact may be recorded on either
 * end. Reading only one field would render the same lineage differently
 * depending on which side a curator happened to write it down.
 *
 * `derivedFromIds` is deliberately excluded. `validate.ts` permits derivation to
 * cross families and organizations, so it is not a within-family tree edge; it is
 * surfaced as a labelled reference instead.
 */
function familyEdges(releases: readonly ModelRelease[]) {
  const present = new Set(releases.map(({ id }) => id));
  const parents = new Map<string, Set<string>>(releases.map(({ id }) => [id, new Set<string>()]));
  const children = new Map<string, Set<string>>(releases.map(({ id }) => [id, new Set<string>()]));

  function link(parentId: string, childId: string) {
    if (parentId === childId) return;
    if (!present.has(parentId) || !present.has(childId)) return;
    parents.get(childId)?.add(parentId);
    children.get(parentId)?.add(childId);
  }

  for (const release of releases) {
    for (const predecessorId of release.predecessorIds) link(predecessorId, release.id);
    for (const successorId of release.successorIds) link(release.id, successorId);
  }

  return { parents, children };
}

/**
 * One parent per release, chosen so the result is a forest even when the records
 * are not.
 *
 * Candidates are considered newest first, and a candidate is rejected when the
 * release is already reachable from it. Because assignments are only ever added
 * and each is checked against the chain built so far, no cycle can be created --
 * which matters because the validator does not reject a cyclic
 * predecessor/successor pair, and an unguarded walk over one would not terminate.
 */
function assignPrimaryParents(
  ordered: readonly ModelRelease[],
  parents: ReadonlyMap<string, Set<string>>,
) {
  const primaryParent = new Map<string, string>();
  const additional = new Map<string, string[]>();
  const order = new Map(ordered.map((release, index) => [release.id, index]));

  function reaches(fromId: string, targetId: string) {
    let current: string | undefined = fromId;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      if (current === targetId) return true;
      seen.add(current);
      current = primaryParent.get(current);
    }
    return false;
  }

  for (const release of ordered) {
    const candidates = [...(parents.get(release.id) ?? [])]
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const chosen = candidates.find((candidate) => !reaches(candidate, release.id));

    if (chosen !== undefined) primaryParent.set(release.id, chosen);
    additional.set(release.id, candidates.filter((candidate) => candidate !== chosen));
  }

  return { primaryParent, additional };
}

function buildFamilyView(family: ModelFamily, familyReleases: readonly ModelRelease[]): LineageFamilyView {
  const releases = [...familyReleases].sort(byNewestRelease);
  const { parents } = familyEdges(releases);
  const { primaryParent, additional } = assignPrimaryParents(releases, parents);

  function nodesFor(parentId: string | undefined, depth: number): LineageNode[] {
    return releases
      .filter((release) => primaryParent.get(release.id) === parentId)
      .map((release) => ({
        release,
        depth,
        children: nodesFor(release.id, depth + 1),
        additionalPredecessorIds: additional.get(release.id) ?? [],
      }));
  }

  const roots = nodesFor(undefined, 0);
  const present = new Set(releases.map(({ id }) => id));
  const hasRecordedLineage = releases.some((release) => (
    [...release.predecessorIds, ...release.successorIds, ...release.siblingIds]
      .some((relatedId) => relatedId !== release.id && present.has(relatedId))
  ));

  function deepest(nodes: readonly LineageNode[]): number {
    return nodes.reduce((max, node) => Math.max(max, node.depth, deepest(node.children)), 0);
  }

  return {
    family,
    releases,
    roots,
    // Every release is either a root or the child end of exactly one connector.
    linkCount: releases.length - roots.length,
    hasRecordedLineage,
    maxDepth: deepest(roots),
  };
}

/**
 * One ecosystem per organization the seed releases reach, with every family
 * those releases reach rendered *whole*.
 *
 * The seed decides membership and nothing else: an organization qualifies when a
 * seed release names it, and so does a family, but a qualifying family then
 * renders all of its releases rather than only the seeding ones. That is
 * deliberate -- relationships are constrained to stay within a family, so
 * dropping part of one would leave recorded relationships pointing at releases
 * that are not on the page.
 *
 * Both public views below are this function under different seeds, which is what
 * keeps them the same shape and stops them drifting apart.
 */
function buildEcosystems(
  dataset: Dataset,
  seeds: (release: ModelRelease) => boolean,
): LineageEcosystem[] {
  const seedReleases = dataset.releases.filter(seeds);
  const seedOrganizationIds = new Set(seedReleases.map(({ organizationId }) => organizationId));
  const seedFamilyIds = new Set(seedReleases.map(({ familyId }) => familyId));
  const releasesByFamily = new Map<string, ModelRelease[]>();
  for (const release of dataset.releases) {
    const bucket = releasesByFamily.get(release.familyId);
    if (bucket) bucket.push(release);
    else releasesByFamily.set(release.familyId, [release]);
  }

  return [...dataset.organizations]
    .filter(({ id }) => seedOrganizationIds.has(id))
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map((organization) => {
      const families = dataset.families
        .filter((family) => family.organizationId === organization.id && seedFamilyIds.has(family.id))
        .map((family) => buildFamilyView(family, releasesByFamily.get(family.id) ?? []))
        .filter(({ releases }) => releases.length > 0)
        .sort((a, b) => (
          compare(newestReleaseDate(b.releases), newestReleaseDate(a.releases))
          || compare(a.family.id, b.family.id)
        ));

      return {
        organization,
        families,
        releaseCount: families.reduce((count, { releases }) => count + releases.length, 0),
      };
    })
    .filter(({ families }) => families.length > 0);
}

/**
 * The featured ecosystems, derived from release flags alone: the view the
 * homepage leads with.
 *
 * A creator is featured when it has at least one featured release, matching the
 * derivation already established for `/tree` in `lib/model-tree.ts`; there is no
 * organization-level flag in the schema. A family is featured on the same test.
 * Families with no featured release do not reach the homepage at all.
 *
 * This is the *lead* view and never the coverage view. Do not derive a page list
 * from it: which creators the site leads with is an editorial choice (the
 * procedure recorded beside `releaseSchema.featured`), and a creator it does not
 * lead with is still recorded here whole. `buildCreatorEcosystems` is the
 * coverage view, and `routes.ts` uses that one.
 */
export function buildLineageEcosystems(dataset: Dataset): LineageEcosystem[] {
  return buildEcosystems(dataset, ({ featured }) => featured);
}

/**
 * Every creator the catalog records a release for, whether or not the site leads
 * with it, each with every one of its families that holds a release.
 *
 * This is the coverage view: it reads no flag at all, so an editorial change to
 * which creators are featured cannot add or remove a creator here. It is what
 * `providerStaticPaths` and the catalog index's routed-provider set are derived
 * from, which is what makes a provider page a fact about having releases rather
 * than about being led with.
 */
export function buildCreatorEcosystems(dataset: Dataset): LineageEcosystem[] {
  return buildEcosystems(dataset, () => true);
}

export function lineageReleaseSlugs(ecosystems: readonly LineageEcosystem[]) {
  return ecosystems.flatMap(({ families }) => (
    families.flatMap(({ releases }) => releases.map(({ slug }) => slug))
  ));
}

export function findLineagePlacement(
  ecosystems: readonly LineageEcosystem[],
  releaseSlug: string | null | undefined,
): LineagePlacement | undefined {
  if (!releaseSlug) return undefined;

  for (const { organization, families } of ecosystems) {
    for (const family of families) {
      const release = family.releases.find((candidate) => candidate.slug === releaseSlug);
      if (release) return { organization, family, release };
    }
  }

  return undefined;
}

/** The deterministic default selection for one ecosystem: its newest family's newest release. */
export function firstEcosystemRelease(ecosystem: LineageEcosystem): ModelRelease {
  const release = ecosystem.families[0]?.releases[0];
  if (!release) throw new Error(`Ecosystem ${ecosystem.organization.id} has no renderable release`);
  return release;
}

/**
 * Ancestors and successors are transitive; siblings are the direct, reciprocal
 * relationships the catalog records. All three are read from the recorded edge
 * graph rather than from the rendered tree, so a converging predecessor that
 * could not be drawn as a second connector is still highlighted as an ancestor.
 */
export function buildLineageHighlight(
  ecosystems: readonly LineageEcosystem[],
  releaseSlug: string | null | undefined,
): LineageHighlight {
  const placement = findLineagePlacement(ecosystems, releaseSlug);
  if (!placement) {
    return { ancestorIds: new Set(), successorIds: new Set(), siblingIds: new Set() };
  }

  const { family, release } = placement;
  const { parents, children } = familyEdges(family.releases);

  function walk(from: ReadonlyMap<string, Set<string>>) {
    const reached = new Set<string>();
    const queue = [...(from.get(release.id) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next === release.id || reached.has(next)) continue;
      reached.add(next);
      queue.push(...(from.get(next) ?? []));
    }
    return reached;
  }

  const present = new Set(family.releases.map(({ id }) => id));

  return {
    selectedId: release.id,
    ancestorIds: walk(parents),
    successorIds: walk(children),
    siblingIds: new Set(release.siblingIds.filter((id) => id !== release.id && present.has(id))),
  };
}

export function lineageRelation(highlight: LineageHighlight, releaseId: string): LineageRelation {
  if (highlight.selectedId === releaseId) return 'selected';
  if (highlight.ancestorIds.has(releaseId)) return 'ancestor';
  if (highlight.successorIds.has(releaseId)) return 'successor';
  if (highlight.siblingIds.has(releaseId)) return 'sibling';
  return 'unrelated';
}

export const LINEAGE_RELATION_LABELS: Record<Exclude<LineageRelation, 'unrelated'>, string> = {
  selected: 'Selected',
  ancestor: 'Earlier in lineage',
  successor: 'Later in lineage',
  sibling: 'Released alongside',
};
