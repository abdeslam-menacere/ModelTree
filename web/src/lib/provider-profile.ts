import type {
  Dataset,
  Organization,
  Product,
  ReleaseEvent,
  ModelRelease,
  ServingPlatform,
  SourceReference,
} from '../data/schema';
import { comparePartialDatesDescending } from '../data/partial-date';
import { organizationLabel } from './organization-name';

/**
 * The normalized view model behind a `/providers/[slug]` page.
 *
 * Everything here is derived from validated records and from relationships
 * expressed as ids, never from an organization's name or its `type`. The builder
 * makes no claim of its own: a section it cannot support from the data comes back
 * empty, and the page renders nothing for it rather than inventing a placeholder.
 * In particular there is no computed ranking, no composite score, and no tier
 * taxonomy synthesised here -- the dataset carries none, and manufacturing one
 * would be a claim no source states.
 *
 * Creator, product, and serving platform stay separate entities. A product is
 * the creator's own offering; a serving platform is a place a model is reached,
 * and the fact that this creator operates one of its own does not merge the two
 * roles -- each platform is labelled with who operates it.
 */

export interface ProviderReleaseRow {
  release: ModelRelease;
  familyName: string;
  /** The release's Model Passport. Always a generated route. */
  route: string;
}

/** How a product relates to the models this creator publishes. */
export interface ProviderProductView {
  product: Product;
  /** Plain-words statement of the product-to-model relationship. */
  relationshipLabel: string;
  /** The releases this product explicitly names, resolved to display names. */
  namedReleases: Array<{ id: string; name: string; route: string | null }>;
}

/** A serving platform related to this creator, with the relationship stated. */
export interface ProviderPlatformView {
  platform: ServingPlatform;
  operatorName: string;
  /** True when this creator is itself the platform's operator. */
  operatedByProvider: boolean;
  /** Plain-words statement of the platform-to-creator relationship. */
  relationshipLabel: string;
  /** Distinct releases of this creator recorded as deployed on the platform. */
  servedReleaseCount: number;
  /**
   * {@link servedReleaseCount} said out loud, with the scope it was counted in.
   * Always use this to render the count -- see {@link servedReleaseLabel}.
   */
  servedReleaseLabel: string;
}

/** A recorded lifecycle change to one of this creator's releases. */
export interface ProviderChangeView {
  event: ReleaseEvent;
  releaseName: string;
  releaseRoute: string;
  typeLabel: string;
  sources: SourceReference[];
}

export interface ProviderProfile {
  organization: Organization;
  /** The organization's own primary sources. */
  sources: SourceReference[];
  familyCount: number;
  releaseCount: number;
  /** Every release of this creator, newest first. */
  releases: ProviderReleaseRow[];
  /** Distinct lifecycle statuses present among the releases, in a fixed order. */
  statusesPresent: ModelRelease['status'][];
  products: ProviderProductView[];
  servingPlatforms: ProviderPlatformView[];
  recentChanges: ProviderChangeView[];
  /** True when this creator also operates at least one serving platform. */
  operatesServingPlatform: boolean;
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

function modelRoute(base: string, slug: string) {
  return `${normalizeBase(base)}models/${slug}/`;
}

/** Newest first, with an id tiebreak so equal dates never reorder between builds. */
function byNewestRelease(a: ModelRelease, b: ModelRelease) {
  return comparePartialDatesDescending(a.releaseDate, b.releaseDate) || compare(a.id, b.id);
}

/**
 * The lifecycle statuses in their published order, so a filter bar keeps one
 * shape regardless of which statuses a given creator happens to have. Read from
 * the schema's own enum order rather than restated as a literal list elsewhere.
 */
const STATUS_ORDER: ModelRelease['status'][] = [
  'preview',
  'current',
  'legacy',
  'deprecated',
  'research',
];

const PRODUCT_SELECTION_LABEL: Record<Product['modelSelection'], string> = {
  fixed: 'Names specific models',
  routed: 'Routes across models',
  unknown: 'Model selection not disclosed',
};

const RELEASE_EVENT_LABEL: Record<ReleaseEvent['type'], string> = {
  announced: 'Announced',
  preview: 'Preview',
  'api-available': 'API available',
  'generally-available': 'Generally available',
  deprecated: 'Deprecated',
  retired: 'Retired',
  corrected: 'Corrected',
};

export function releaseEventTypeLabel(type: ReleaseEvent['type']): string {
  return RELEASE_EVENT_LABEL[type];
}

export function productRelationshipLabel(selection: Product['modelSelection']): string {
  return PRODUCT_SELECTION_LABEL[selection];
}

/**
 * States a served-release count together with the scope it was counted in.
 *
 * The count is creator-scoped: it is how many of *this* creator's releases the
 * platform is recorded as serving, never how many releases the platform serves
 * in total. The page rendered it as a bare "N releases served", a phrase whose
 * plain reading is the total, and the two readings only visibly disagree at
 * zero -- `/providers/amazon/` listed Amazon SageMaker JumpStart under a heading
 * about where models are reached and then said "0 releases served", which reads
 * as a contradiction and not as a fact (abdeslam-menacere/ModelTree#578). The
 * data was right and the sentence was wrong: JumpStart is on that page because
 * Amazon *operates* it, and the only release recorded as served there is
 * Alibaba Cloud's.
 *
 * So the creator's label goes into the words. Every count then reads as an
 * answer to a stated question rather than as a total, and zero stops being
 * self-contradictory: a platform can serve none of its own operator's models
 * and still be a serving platform. Operator-of and server-of stay two
 * relationships, stated in two separate strings -- {@link ProviderPlatformView}
 * carries `relationshipLabel` for the first and this for the second.
 *
 * Zero is worded "no", not "0". The count itself is untouched; only the sentence
 * around it changes, and no branch here reads or re-derives the number.
 */
export function servedReleaseLabel(count: number, creatorLabel: string): string {
  if (count === 0) return `Serves no ${creatorLabel} releases`;
  if (count === 1) return `Serves 1 ${creatorLabel} release`;
  return `Serves ${count} ${creatorLabel} releases`;
}

/**
 * Builds one creator's profile, or returns `undefined` when the organization id
 * is not in the dataset. Nothing here reads `featured`: the profile describes an
 * organization whole -- every family, every release, in whatever lifecycle state
 * -- and which organizations get a page is decided upstream in `routes.ts`.
 */
export function buildProviderProfile(
  dataset: Dataset,
  organizationId: string,
  base = '/',
): ProviderProfile | undefined {
  const organization = dataset.organizations.find((item) => item.id === organizationId);
  if (!organization) return undefined;

  const sourceById = new Map(dataset.sources.map((item) => [item.id, item]));
  const familyById = new Map(dataset.families.map((item) => [item.id, item]));
  const releaseById = new Map(dataset.releases.map((item) => [item.id, item]));

  const resolveSources = (ids: readonly string[]) => ids
    .map((id) => sourceById.get(id))
    .filter((source): source is SourceReference => Boolean(source));

  const ownReleases = dataset.releases
    .filter((release) => release.organizationId === organization.id)
    .sort(byNewestRelease);

  const releases: ProviderReleaseRow[] = ownReleases.map((release) => ({
    release,
    familyName: familyById.get(release.familyId)?.name ?? release.familyId,
    route: modelRoute(base, release.slug),
  }));

  const statusesPresent = STATUS_ORDER.filter((status) => (
    ownReleases.some((release) => release.status === status)
  ));

  const familyCount = dataset.families
    .filter((family) => family.organizationId === organization.id).length;

  // Products this creator publishes. A product is the creator's, so it is
  // matched on `organizationId`; the model relationship it carries is stated
  // separately so a routed product is never read as naming a single model.
  const products: ProviderProductView[] = dataset.products
    .filter((product) => product.organizationId === organization.id)
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map((product) => ({
      product,
      relationshipLabel: productRelationshipLabel(product.modelSelection),
      namedReleases: product.releaseIds.map((releaseId) => {
        const release = releaseById.get(releaseId);
        return {
          id: releaseId,
          name: release?.displayName ?? releaseId,
          route: release ? modelRoute(base, release.slug) : null,
        };
      }),
    }));

  // Serving platforms related to this creator, from two directions that stay
  // labelled apart: platforms this creator operates itself, and platforms other
  // organizations operate that carry a deployment of this creator's releases.
  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));
  const ownReleaseIds = new Set(ownReleases.map((release) => release.id));
  const servedByPlatform = new Map<string, Set<string>>();
  for (const deployment of dataset.deployments) {
    if (!ownReleaseIds.has(deployment.releaseId)) continue;
    const bucket = servedByPlatform.get(deployment.platformId);
    if (bucket) bucket.add(deployment.releaseId);
    else servedByPlatform.set(deployment.platformId, new Set([deployment.releaseId]));
  }

  const relatedPlatforms = dataset.servingPlatforms.filter((platform) => (
    platform.organizationId === organization.id || servedByPlatform.has(platform.id)
  ));

  const servingPlatforms: ProviderPlatformView[] = relatedPlatforms
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map((platform) => {
      const operatedByProvider = platform.organizationId === organization.id;
      const operator = organizationById.get(platform.organizationId);
      const operatorName = operator ? organizationLabel(operator) : platform.organizationId;
      const servedReleaseCount = servedByPlatform.get(platform.id)?.size ?? 0;
      return {
        platform,
        operatorName,
        operatedByProvider,
        relationshipLabel: operatedByProvider
          ? `First-party serving platform, operated by ${organizationLabel(organization)}`
          : `Third-party serving platform, operated by ${operatorName}`,
        servedReleaseCount,
        servedReleaseLabel: servedReleaseLabel(
          servedReleaseCount,
          organizationLabel(organization),
        ),
      };
    });

  const operatesServingPlatform = dataset.servingPlatforms
    .some((platform) => platform.organizationId === organization.id);

  // Recorded lifecycle changes to this creator's releases, newest first. Each
  // links back to the release it changed and to its own primary sources, so a
  // reader can check the change rather than take the label on trust.
  const recentChanges: ProviderChangeView[] = dataset.releaseEvents
    .filter((event) => ownReleaseIds.has(event.releaseId))
    .sort((a, b) => compare(b.date, a.date) || compare(a.id, b.id))
    .map((event) => {
      const release = releaseById.get(event.releaseId);
      return {
        event,
        releaseName: release?.displayName ?? event.releaseId,
        releaseRoute: release ? modelRoute(base, release.slug) : modelRoute(base, event.releaseId),
        typeLabel: releaseEventTypeLabel(event.type),
        sources: resolveSources(event.sourceIds),
      };
    });

  const verificationDates = [
    organization.verifiedAt,
    ...ownReleases.map((release) => release.verifiedAt),
  ].sort(compare);

  return {
    organization,
    sources: resolveSources(organization.sourceIds),
    familyCount,
    releaseCount: ownReleases.length,
    releases,
    statusesPresent,
    products,
    servingPlatforms,
    recentChanges,
    operatesServingPlatform,
    latestVerifiedAt: verificationDates.at(-1) ?? organization.verifiedAt,
  };
}
