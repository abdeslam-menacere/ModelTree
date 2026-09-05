import type { Dataset, SourceReference } from '../data/schema';

type Release = Dataset['releases'][number];

/** What a page renders for the one source slot it gives a release. */
export interface ReleaseSourceLink {
  title: string;
  url: string;
}

/**
 * Which kind of source a release cites when it cites several, as a declared
 * editorial policy rather than as a side effect of where an id sits in
 * `releases.json`.
 *
 * `sourceIds` order carries no meaning: `schema.ts` declares it 13 times as
 * `z.array(entityId).min(1)`, never with a `.max()` and never with an ordering
 * comment, and nothing between the JSON and the page sorts it. Permuting the
 * array is therefore a semantically null edit, and any selection that reads
 * position decides a sourcing question by file layout.
 *
 * Documentation is preferred first, which is the preference these pages already
 * expressed; the rest follow the order `sourceSchema` declares. This deliberately
 * differs from `SOURCE_TYPE_PRIORITY` in `release-pulse.ts`, which leads with
 * `official-announcement` because it is describing an *event*. Reconciling the
 * two is a real question and a separate one -- adopting the pulse order here
 * would re-rank the cited source on many releases, which this change is not for.
 */
export const RELEASE_SOURCE_TYPE_PRIORITY: readonly SourceReference['type'][] = [
  'official-docs',
  'official-announcement',
  'model-card',
  'repository',
  'benchmark-owner',
  'independent-evaluation',
];

function rank(source: SourceReference): number {
  const index = RELEASE_SOURCE_TYPE_PRIORITY.indexOf(source.type);
  return index === -1 ? RELEASE_SOURCE_TYPE_PRIORITY.length : index;
}

/** Codepoint order, so output does not vary with the host's locale. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * How many releases cite each source.
 *
 * Counted over distinct releases, so a source listed twice by one release is
 * still one citation, and computed from a set per release so the count cannot
 * depend on `sourceIds` order.
 */
export function countReleaseCitations(
  releases: readonly Release[],
): ReadonlyMap<string, number> {
  const citations = new Map<string, number>();
  for (const release of releases) {
    for (const sourceId of new Set(release.sourceIds)) {
      citations.set(sourceId, (citations.get(sourceId) ?? 0) + 1);
    }
  }
  return citations;
}

/**
 * A total order over the sources a release cites: declared type, then how
 * specific the document is to this release, then the source id.
 *
 * The middle term is the editorial one. Two `official-docs` pages are both
 * legitimately official and the schema ranks neither, but a page cited by one
 * release is about that release while a page cited by thirty-six is about
 * everything -- so "Claude Fable 5" beats "Models overview", and a model's own
 * licence beats the OSI licence index. It is a statement a reviewer can read
 * and disagree with, which is the whole point: the policy today is "whichever
 * id was typed first", which is unwritten and unreviewable.
 *
 * `publishedDate` was measured as the alternative and carries no signal here --
 * it is unset on 75 of the 77 `official-docs` sources on the releases that need
 * a tiebreak. `lastCheckedDate` moves on every refresh, so ordering on it would
 * flip citations for reasons unrelated to the sources.
 *
 * The id is last and is arbitrary on purpose: it exists to make the order
 * *total*. Ids are unique, so no two candidates ever compare equal and the
 * result never depends on sort stability or on input order.
 */
export function releaseSourceOrder(
  citations: ReadonlyMap<string, number> = new Map(),
): (a: SourceReference, b: SourceReference) => number {
  const breadth = (source: SourceReference) => citations.get(source.id) ?? 0;
  return (a, b) => rank(a) - rank(b) || breadth(a) - breadth(b) || compareIds(a.id, b.id);
}

/**
 * The one source a page cites for a release.
 *
 * Deliberately a single ordering over every resolved candidate rather than a
 * preferred-type lookup with a positional fallback. A two-arm form leaves the
 * fallback indexing the raw id array, so it stays order-dependent even after
 * the preferred arm is sorted; with one total order there is no position read
 * anywhere and no second arm to forget.
 */
export function selectReleaseSource(
  sourceIds: readonly string[],
  sourceById: ReadonlyMap<string, SourceReference>,
  releaseId: string,
  citations?: ReadonlyMap<string, number>,
): SourceReference {
  const [source] = sourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter((candidate): candidate is SourceReference => candidate !== undefined)
    .sort(releaseSourceOrder(citations));

  if (!source) throw new Error(`No source found for ${releaseId}`);
  return source;
}

/**
 * Every release's cited source, keyed by release id -- the shape the homepage,
 * the tree page, and each provider page all pass to their explorer islands.
 * One function so the selection is defined once and can be tested once.
 */
export function buildReleaseSourceIndex(
  releases: readonly Release[],
  sourceById: ReadonlyMap<string, SourceReference>,
): Record<string, ReleaseSourceLink> {
  const citations = countReleaseCitations(releases);
  return Object.fromEntries(
    releases.map((release) => {
      const source = selectReleaseSource(release.sourceIds, sourceById, release.id, citations);
      return [release.id, { title: source.title, url: source.url }];
    }),
  );
}
