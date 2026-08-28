/**
 * The Model Passport's build-time view model.
 *
 * The page joins seven entity types that a model name blurs together — release,
 * family, creator, serving platform, deployment, pricing record, and release
 * event — and every one of them is a separate record with its own sources and
 * verification date. Doing that join in the `.astro` file would put the
 * editorial rules (which relationship label, which openness wording, when a
 * section disappears) somewhere no test can reach them, so it happens here and
 * the page renders the result.
 *
 * Three properties of this dataset shape everything below.
 *
 * 1. Whole entity types are empty. `raw.ts` composes eleven JSON files and none
 *    of them is pricing, deployments, serving platforms, products, or release
 *    events; those arrays reach the page through Zod `.default([])`. So on the
 *    shipped data the availability, pricing, and change-history sections have
 *    *no* records at all, and the only branch real data exercises is the absent
 *    one. The populated branches are proven against fixtures in
 *    `passport.test.ts`. Nothing here invents a record to fill a section:
 *    every fact in this repository carries a primary source and a verification
 *    date, and a fabricated one would carry neither.
 *
 * 2. Absence is a fact, not a blank. A section with no records disappears from
 *    the body — an empty shell of column headings tells a reader nothing — but
 *    it is then named in {@link ModelPassportView.notRecorded} with the reason
 *    it is missing. That is what "disappears coherently" has to mean here, since
 *    silently dropping a section is indistinguishable from never having built
 *    it.
 *
 * 3. Wording that carries an editorial commitment is derived, never retyped.
 *    Access and lifecycle prose comes from `methodology.ts`, relationship hrefs
 *    from `catalog.ts`'s `modelRoute`, and the compare link from
 *    `compare-route.ts`, which is where the comparison page's own URL contract
 *    is defined. A second copy of any of them would be free to drift from the
 *    page that documents it.
 */
import type {
  Dataset,
  Deployment,
  ModelFamily,
  ModelRelease,
  Organization,
  PricingRecord,
  ReleaseEvent,
  ServingPlatform,
  SourceReference,
} from '../data/schema';
import { modelRoute } from './catalog';
import { compareUrl } from './compare-route';
import {
  accessLabel,
  categoryLabel,
  formatDate,
  formatDateWithPrecision,
  formatNumber,
  statusLabel,
} from './format';
import { accessTypeGlossary, lifecycleStatusGlossary, methodologyReferences } from './methodology';
import { daysSince } from './usage-evidence';

/**
 * How long a price or an availability record is shown without a staleness note.
 *
 * Deliberately shorter than the 180 days `usage-evidence.ts` allows its figures:
 * a vendor can reprice or withdraw a region between two of this repository's
 * refresh runs, and the issue calls those two sections out as the volatile ones.
 * Model metadata — context window, modalities, licence — gets no staleness
 * verdict here at all, because it does not go out of date on a clock and the
 * page already stamps its verification date in the hero.
 */
export const VOLATILE_STALE_AFTER_DAYS = 90;

// ---------------------------------------------------------------------------
// Labels. Every map is a total `Record` over its enum, so adding a value to the
// schema fails `astro check` here instead of rendering a blank cell.
// ---------------------------------------------------------------------------

export type RelationshipKind = 'predecessor' | 'successor' | 'sibling' | 'derivation';

/**
 * The four lineage relationships, each with wording that says what it claims.
 *
 * They are kept distinct because they are different claims: a predecessor is a
 * version ordering, a sibling is a shared family, and a derivation is a
 * statement about training provenance. Collapsing any two would assert
 * something no source in this dataset states.
 */
export const RELATIONSHIP_KINDS: readonly RelationshipKind[] = [
  'predecessor',
  'successor',
  'sibling',
  'derivation',
];

const RELATIONSHIP_LABELS: Record<RelationshipKind, string> = {
  predecessor: 'Predecessors',
  successor: 'Successors',
  sibling: 'Sibling variants',
  derivation: 'Derived from',
};

const RELATIONSHIP_DESCRIPTIONS: Record<RelationshipKind, string> = {
  predecessor: 'Earlier releases this one is recorded as following in its own version line.',
  successor: 'Later releases recorded as following this one. It does not mean this release is withdrawn.',
  sibling: 'Releases published as variants of the same family. It implies no ordering between them.',
  derivation: 'Releases this one is recorded as being built from, such as a fine-tune or a distillation of another model.',
};

const DELIVERY_MODE_LABELS: Record<Deployment['deliveryMode'], string> = {
  'hosted-api': 'Hosted API',
  'managed-endpoint': 'Managed endpoint',
  'downloadable-weights': 'Downloadable weights',
  'local-runtime': 'Local runtime',
};

const PLATFORM_TYPE_LABELS: Record<ServingPlatform['type'], string> = {
  'first-party-api': 'First-party API',
  'cloud-platform': 'Cloud platform',
  aggregator: 'Aggregator',
  'model-hub': 'Model hub',
  'local-runtime': 'Local runtime',
};

const PRICING_UNIT_LABELS: Record<PricingRecord['unit'], string> = {
  'per-1m-tokens': 'per 1M tokens',
  'per-1k-tokens': 'per 1K tokens',
  'per-image': 'per image',
  'per-minute': 'per minute',
  'per-request': 'per request',
};

const EVENT_TYPE_LABELS: Record<ReleaseEvent['type'], string> = {
  announced: 'Announced',
  preview: 'Preview',
  'api-available': 'API available',
  'generally-available': 'Generally available',
  deprecated: 'Deprecated',
  retired: 'Retired',
  corrected: 'Corrected',
};

type RateKey = keyof PricingRecord['rates'];

/** Fixed so two pricing rows always list their rates in the same order. */
const RATE_ORDER: readonly RateKey[] = [
  'input',
  'cachedInput',
  'output',
  'batchInput',
  'batchOutput',
];

const RATE_LABELS: Record<RateKey, string> = {
  input: 'Input',
  cachedInput: 'Cached input',
  output: 'Output',
  batchInput: 'Batch input',
  batchOutput: 'Batch output',
};

export function relationshipLabel(kind: RelationshipKind) {
  return RELATIONSHIP_LABELS[kind];
}

export function relationshipDescription(kind: RelationshipKind) {
  return RELATIONSHIP_DESCRIPTIONS[kind];
}

export function deliveryModeLabel(mode: Deployment['deliveryMode']) {
  return DELIVERY_MODE_LABELS[mode];
}

export function platformTypeLabel(type: ServingPlatform['type']) {
  return PLATFORM_TYPE_LABELS[type];
}

export function pricingUnitLabel(unit: PricingRecord['unit']) {
  return PRICING_UNIT_LABELS[unit];
}

export function releaseEventLabel(type: ReleaseEvent['type']) {
  return EVENT_TYPE_LABELS[type];
}

// ---------------------------------------------------------------------------
// Dates and amounts
// ---------------------------------------------------------------------------

/**
 * Renders a date only as precisely as the source stated it. Defined in
 * `lib/format.ts` so there is exactly one implementation of the rule; this
 * module re-exports it because the passport view model and its tests were its
 * first callers.
 */
export { formatDateWithPrecision, formatPartialDate, precisionOfPartialDate } from './format';

/**
 * A rate with its currency code.
 *
 * Sub-unit token prices are the normal case — a per-1M-token rate is routinely
 * below 1 — so small amounts are formatted by significant digits rather than to
 * two decimal places, which would round a real published price to zero. The
 * ISO 4217 code is printed rather than a symbol: several currencies share "$",
 * and the schema stores the code precisely so the page does not have to guess.
 */
export function formatRate(amount: number, currency: string) {
  const formatted = amount !== 0 && Math.abs(amount) < 1
    ? new Intl.NumberFormat('en', { maximumSignificantDigits: 4 }).format(amount)
    : new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .format(amount);

  return `${currency} ${formatted}`;
}

/**
 * How an effective range reads. `effectiveTo` absent means the record is the
 * current one, which is a different statement from a range that has closed.
 */
export function formatEffectiveRange(effectiveFrom: string, effectiveTo?: string) {
  return effectiveTo
    ? `${formatDate(effectiveFrom)} to ${formatDate(effectiveTo)}`
    : `From ${formatDate(effectiveFrom)}`;
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

export interface PassportSourceView {
  id: string;
  title: string;
  url: string;
  typeLabel: string;
  publisherName: string;
  lastCheckedDate: string;
}

export interface PassportFact {
  term: string;
  value: string;
  /** True when no record states this, so the page can mark it rather than blank it. */
  unknown: boolean;
}

export interface RelationshipLink {
  slug: string;
  displayName: string;
  href: string;
}

export interface RelationshipGroup {
  kind: RelationshipKind;
  label: string;
  description: string;
  links: RelationshipLink[];
  /**
   * Ids this release names that resolve to no release here. Surfaced rather
   * than filtered away: a dangling relationship is a coverage gap, and dropping
   * it silently would present a partial lineage as a complete one.
   */
  unresolvedIds: string[];
}

export interface LicenseView {
  name: string;
  spdxId: string | null;
  url: string | null;
  weightsDownloadable: boolean;
  osiApproved: boolean;
  /** Derived from the two booleans, never from the licence's name. */
  weightsStatement: string;
  osiStatement: string;
}

export interface AccessView {
  value: ModelRelease['accessType'];
  label: string;
  /** The methodology page's own definition, read from its glossary. */
  definition: string;
  methodologyHref: string;
  license: LicenseView | null;
  /** Why no licence block renders, when there is none. */
  licenseAbsenceNote: string | null;
}

export interface AvailabilityRow {
  id: string;
  platformName: string;
  platformTypeLabel: string;
  operatorName: string;
  deliveryModeLabel: string;
  apiIdentifier: string | null;
  regions: string[];
  effectiveRange: string;
  isCurrent: boolean;
  verifiedAt: string;
  isStale: boolean;
  daysSinceVerified: number;
  sources: PassportSourceView[];
}

export interface PricingRateView {
  key: RateKey;
  label: string;
  amount: string;
}

export interface PricingRow {
  id: string;
  platformName: string;
  currency: string;
  unitLabel: string;
  rates: PricingRateView[];
  region: string | null;
  processingTier: string | null;
  effectiveRange: string;
  effectiveFrom: string;
  isCurrent: boolean;
  verifiedAt: string;
  isStale: boolean;
  daysSinceVerified: number;
  sources: PassportSourceView[];
}

export interface HistoryRow {
  id: string;
  typeLabel: string;
  date: string;
  note: string;
  sources: PassportSourceView[];
}

export type PassportActionKind = 'compare' | 'evidence' | 'report';

export interface PassportAction {
  kind: PassportActionKind;
  label: string;
  href: string;
  description: string;
  /** Leaves the site, so the page can mark it for a reader and a screen reader. */
  external: boolean;
}

export const PASSPORT_SECTION_ORDER = [
  'identity',
  'lineage',
  'technical',
  'access',
  'availability',
  'pricing',
  'history',
  'usage',
  'fit',
  'sources',
] as const;

export type PassportSectionId = (typeof PASSPORT_SECTION_ORDER)[number];

export interface PassportSection {
  id: PassportSectionId;
  /** Stable across renders and unique, so `aria-labelledby` always resolves. */
  headingId: string;
  eyebrow: string;
  title: string;
  present: boolean;
  /**
   * Display number, assigned over present sections only. A page that skipped
   * from 04 to 06 would show a reader a section they cannot find.
   */
  number: string | null;
}

export interface NotRecordedNote {
  id: PassportSectionId;
  title: string;
  reason: string;
}

export interface ModelPassportView {
  release: ModelRelease;
  organization: Organization;
  family: ModelFamily;

  canonicalName: string;
  slug: string;
  /** The one route that serves this release, shared with the catalog index. */
  canonicalRoute: string;
  displayName: string;
  summary: string;
  intendedUse: string;

  statusLabel: string;
  statusDefinition: string;
  releaseDate: string;
  verifiedAt: string;
  featuredRationale: string | null;

  identityFacts: PassportFact[];
  apiAliases: string[];
  /** Names the release is also known by, excluding the display name. */
  otherNames: string[];
  technicalFacts: PassportFact[];
  categories: string[];

  relationships: RelationshipGroup[];
  /** Only the groups with at least one resolved link or dangling id. */
  presentRelationships: RelationshipGroup[];

  access: AccessView;
  availability: AvailabilityRow[];
  pricing: PricingRow[];
  history: HistoryRow[];
  sources: PassportSourceView[];

  sections: PassportSection[];
  notRecorded: NotRecordedNote[];
  actions: PassportAction[];
  correctionUrl: string;
}

export class PassportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassportError';
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function compareHref(base: string, slug: string) {
  return compareUrl(base, [slug]);
}

/**
 * A correction link that names the record it is about.
 *
 * The slug travels in the query so the prefilled issue identifies the record
 * without the reader having to describe it, which is the difference between a
 * correction that can be acted on and one that cannot. It is put through
 * `URLSearchParams`, so a canonical name containing `&` or `#` cannot truncate
 * the link.
 */
export function correctionHref(release: Pick<ModelRelease, 'slug' | 'canonicalName' | 'verifiedAt'>) {
  const params = new URLSearchParams({
    title: `Data correction: ${release.canonicalName} (${release.slug})`,
    body: [
      `Record slug: ${release.slug}`,
      `Record: ${release.canonicalName}`,
      `Currently verified at: ${release.verifiedAt}`,
      '',
      'What is incorrect:',
      '',
      'Primary source that states the correct value (a URL is required):',
      '',
    ].join('\n'),
  });

  return `${methodologyReferences.repository}/issues/new?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export type PassportDataset = Pick<
  Dataset,
  | 'sources'
  | 'publishers'
  | 'organizations'
  | 'families'
  | 'releases'
  | 'servingPlatforms'
  | 'deployments'
  | 'pricing'
  | 'releaseEvents'
  | 'usageObservations'
  | 'modelFitStatements'
>;

function fact(term: string, value: string | null | undefined, unknownNote = 'Not recorded'): PassportFact {
  const known = value !== null && value !== undefined && value !== '';
  return { term, value: known ? value : unknownNote, unknown: !known };
}

/**
 * A record is current when nothing has closed its effective range. Compared
 * against the build date rather than read time, so a page states what was true
 * when it was generated instead of drifting silently in a stale tab.
 */
function isCurrentRange(today: string, effectiveTo?: string) {
  return effectiveTo === undefined || effectiveTo >= today;
}

export function buildModelPassport(
  dataset: PassportDataset,
  releaseId: string,
  base: string,
  today: string,
): ModelPassportView {
  const release = dataset.releases.find((candidate) => candidate.id === releaseId);
  if (!release) throw new PassportError(`unknown release "${releaseId}"`);

  const organization = dataset.organizations.find(({ id }) => id === release.organizationId);
  const family = dataset.families.find(({ id }) => id === release.familyId);
  if (!organization) {
    throw new PassportError(`release "${releaseId}" names missing organization "${release.organizationId}"`);
  }
  if (!family) {
    throw new PassportError(`release "${releaseId}" names missing family "${release.familyId}"`);
  }

  const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));
  const publisherById = new Map(dataset.publishers.map((publisher) => [publisher.id, publisher]));
  const releaseById = new Map(dataset.releases.map((item) => [item.id, item]));
  const organizationById = new Map(dataset.organizations.map((item) => [item.id, item]));
  const platformById = new Map(dataset.servingPlatforms.map((item) => [item.id, item]));

  const toSourceView = (source: SourceReference): PassportSourceView => ({
    id: source.id,
    title: source.title,
    url: source.url,
    // Formatted exactly as `SourceList.astro` renders it, so one source does not
    // read two ways on one page.
    typeLabel: source.type.replaceAll('-', ' '),
    publisherName: publisherById.get(source.publisherId)?.name ?? source.publisherId,
    lastCheckedDate: source.lastCheckedDate,
  });

  const resolveSources = (sourceIds: readonly string[]): PassportSourceView[] => sourceIds
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is SourceReference => Boolean(source))
    .map(toSourceView);

  // -------------------------------------------------------------------------
  // Lineage
  // -------------------------------------------------------------------------

  const relationshipIds: Record<RelationshipKind, readonly string[]> = {
    predecessor: release.predecessorIds,
    successor: release.successorIds,
    sibling: release.siblingIds,
    derivation: release.derivedFromIds,
  };

  const relationships: RelationshipGroup[] = RELATIONSHIP_KINDS.map((kind) => {
    const ids = relationshipIds[kind];
    const links: RelationshipLink[] = [];
    const unresolvedIds: string[] = [];

    for (const id of ids) {
      const related = releaseById.get(id);
      if (!related) {
        unresolvedIds.push(id);
        continue;
      }
      links.push({
        slug: related.slug,
        displayName: related.displayName,
        href: modelRoute(base, related.slug),
      });
    }

    return {
      kind,
      label: relationshipLabel(kind),
      description: relationshipDescription(kind),
      links,
      unresolvedIds,
    };
  });

  const presentRelationships = relationships.filter(
    (group) => group.links.length > 0 || group.unresolvedIds.length > 0,
  );

  // -------------------------------------------------------------------------
  // Access and licensing
  // -------------------------------------------------------------------------

  const accessEntry = accessTypeGlossary.find((entry) => entry.value === release.accessType);
  if (!accessEntry) {
    throw new PassportError(
      `access type "${release.accessType}" has no methodology definition, so the passport would `
      + 'describe it in wording the methodology page does not document',
    );
  }

  const statusEntry = lifecycleStatusGlossary.find((entry) => entry.value === release.status);
  if (!statusEntry) {
    throw new PassportError(
      `lifecycle status "${release.status}" has no methodology definition`,
    );
  }

  const licenseRecord = release.license;
  const license: LicenseView | null = licenseRecord
    ? {
      name: licenseRecord.name,
      spdxId: licenseRecord.spdxId ?? null,
      url: licenseRecord.url ?? null,
      weightsDownloadable: licenseRecord.weightsDownloadable,
      osiApproved: licenseRecord.osiApproved,
      // The two booleans are reported separately and neither is inferred from
      // the other. Downloadable weights under a licence the OSI has not
      // approved is the common case, and calling that "open source" is the
      // specific error the schema's two-field split exists to prevent.
      weightsStatement: licenseRecord.weightsDownloadable
        ? 'Weights are documented as downloadable.'
        : 'Weights are not documented as downloadable.',
      osiStatement: licenseRecord.osiApproved
        ? 'The licence is recorded as OSI-approved open source.'
        : 'The licence is not recorded as OSI-approved, so this release is not described as open source.',
    }
    : null;

  const access: AccessView = {
    value: release.accessType,
    label: accessLabel(release.accessType),
    definition: accessEntry.definition,
    methodologyHref: `${base.endsWith('/') ? base : `${base}/`}methodology/#access`,
    license,
    licenseAbsenceNote: license
      ? null
      : 'No licence record is held for this release. The schema requires one only where a release '
        + 'claims downloadable weights, so its absence here is not a claim that the model is unlicensed.',
  };

  // -------------------------------------------------------------------------
  // Availability and pricing. Pricing reaches a release only through a
  // deployment, which is what ties a price to the platform that charges it.
  // -------------------------------------------------------------------------

  const deployments = dataset.deployments.filter(
    (deployment) => deployment.releaseId === release.id,
  );
  const deploymentById = new Map(deployments.map((deployment) => [deployment.id, deployment]));

  const availability: AvailabilityRow[] = deployments.map((deployment) => {
    const platform = platformById.get(deployment.platformId);
    const daysSinceVerified = daysSince(deployment.verifiedAt, today);

    return {
      id: deployment.id,
      platformName: platform?.name ?? deployment.platformId,
      platformTypeLabel: platform ? platformTypeLabel(platform.type) : 'Not recorded',
      operatorName: platform
        ? organizationById.get(platform.organizationId)?.name ?? platform.organizationId
        : 'Not recorded',
      deliveryModeLabel: deliveryModeLabel(deployment.deliveryMode),
      apiIdentifier: deployment.apiIdentifier ?? null,
      regions: deployment.regions,
      effectiveRange: formatEffectiveRange(deployment.effectiveFrom, deployment.effectiveTo),
      isCurrent: isCurrentRange(today, deployment.effectiveTo),
      verifiedAt: deployment.verifiedAt,
      isStale: daysSinceVerified > VOLATILE_STALE_AFTER_DAYS,
      daysSinceVerified,
      sources: resolveSources(deployment.sourceIds),
    };
  });

  const pricing: PricingRow[] = dataset.pricing
    .filter((price) => deploymentById.has(price.deploymentId))
    .map((price) => {
      const deployment = deploymentById.get(price.deploymentId);
      const platform = deployment ? platformById.get(deployment.platformId) : undefined;
      const daysSinceVerified = daysSince(price.verifiedAt, today);

      return {
        id: price.id,
        platformName: platform?.name ?? deployment?.platformId ?? price.deploymentId,
        currency: price.currency,
        unitLabel: pricingUnitLabel(price.unit),
        rates: RATE_ORDER
          .filter((key) => price.rates[key] !== undefined)
          .map((key) => ({
            key,
            label: RATE_LABELS[key],
            amount: formatRate(price.rates[key] as number, price.currency),
          })),
        region: price.region ?? null,
        processingTier: price.processingTier ?? null,
        effectiveRange: formatEffectiveRange(price.effectiveFrom, price.effectiveTo),
        effectiveFrom: price.effectiveFrom,
        isCurrent: isCurrentRange(today, price.effectiveTo),
        verifiedAt: price.verifiedAt,
        isStale: daysSinceVerified > VOLATILE_STALE_AFTER_DAYS,
        daysSinceVerified,
        sources: resolveSources(price.sourceIds),
      };
    });

  // -------------------------------------------------------------------------
  // Change history. Sorted oldest first: this is a chronology, and a reader
  // follows what happened to a release forwards.
  // -------------------------------------------------------------------------

  const history: HistoryRow[] = dataset.releaseEvents
    .filter((event) => event.releaseId === release.id)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((event) => ({
      id: event.id,
      typeLabel: releaseEventLabel(event.type),
      date: formatDateWithPrecision(event.date, event.datePrecision),
      note: event.note,
      sources: resolveSources(event.sourceIds),
    }));

  const sources = resolveSources(release.sourceIds);

  // -------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------

  const parameters = release.parameters;
  const parameterText = parameters?.totalBillions !== undefined
    ? parameters.activeBillions !== undefined
      ? `${formatNumber(parameters.totalBillions)}B total, ${formatNumber(parameters.activeBillions)}B active`
      : `${formatNumber(parameters.totalBillions)}B total`
    : parameters?.activeBillions !== undefined
      ? `${formatNumber(parameters.activeBillions)}B active`
      : null;

  const releaseDate = formatDateWithPrecision(release.releaseDate, release.datePrecision);

  const identityFacts: PassportFact[] = [
    fact('Creator', organization.name),
    fact('Family', family.name),
    fact('Version', release.version),
    fact('Variant', release.variant),
    fact('Released', releaseDate),
    fact('Lifecycle status', statusLabel(release.status)),
    fact('Access', accessLabel(release.accessType)),
    fact('Record slug', release.slug),
  ];

  const technicalFacts: PassportFact[] = [
    fact('Input modalities', release.inputModalities.join(', ')),
    fact('Output modalities', release.outputModalities.join(', ')),
    fact(
      'Context window',
      release.contextWindow ? `${formatNumber(release.contextWindow)} tokens` : null,
    ),
    fact(
      'Maximum output',
      release.maximumOutput ? `${formatNumber(release.maximumOutput)} tokens` : null,
    ),
    fact('Parameters', parameterText),
  ];

  const otherNames = [release.canonicalName].filter((name) => name !== release.displayName);

  // -------------------------------------------------------------------------
  // Sections. Presence decides both what renders and what is named as missing,
  // so the two can never disagree.
  //
  // `usage` and `fit` are always present: their components render an explicit
  // "nothing qualifies" state that is itself the editorial point, so they are
  // never absent, only empty. `identity`, `technical`, and `sources` are
  // guaranteed by the schema — `sourceIds` has `.min(1)`, and modality and
  // category arrays likewise — so only availability, pricing, and history can
  // actually disappear.
  // -------------------------------------------------------------------------

  const definitions: Record<PassportSectionId, { eyebrow: string; title: string; present: boolean; reason: string }> = {
    identity: {
      eyebrow: 'Identity',
      title: 'What it is',
      present: true,
      reason: '',
    },
    lineage: {
      eyebrow: 'Lineage',
      title: 'Where it fits',
      present: presentRelationships.length > 0,
      reason: 'No predecessor, successor, sibling, or derivation is recorded for this release. '
        + 'ModelTree records a lineage link only where a source states it, and does not infer one '
        + 'from names or release dates.',
    },
    technical: {
      eyebrow: 'Technical record',
      title: 'Documented limits',
      present: true,
      reason: '',
    },
    access: {
      eyebrow: 'Access and licensing',
      title: 'How you can get it',
      present: true,
      reason: '',
    },
    availability: {
      eyebrow: 'Availability',
      title: 'Where it is served',
      present: availability.length > 0,
      reason: 'No deployment record ties this release to a serving platform. ModelTree has not yet '
        + 'reviewed platform availability for this record; absence is not a claim that the model is '
        + 'unavailable.',
    },
    pricing: {
      eyebrow: 'Pricing',
      title: 'What it costs',
      present: pricing.length > 0,
      reason: 'No published price is recorded for this release. A price is held only against a '
        + 'reviewed deployment on a named platform, with its currency, unit, and effective date; '
        + 'absence is not a claim that the model is free or unpriced.',
    },
    history: {
      eyebrow: 'Change history',
      title: 'What has changed',
      present: history.length > 0,
      reason: 'No dated release event is recorded for this release beyond its release date. '
        + 'Announcement, availability, and deprecation events are held as separate sourced records, '
        + 'and none has been reviewed for this one.',
    },
    usage: { eyebrow: 'Usage evidence', title: 'Who reports using it', present: true, reason: '' },
    fit: { eyebrow: 'Conditional fit', title: 'When it fits, and when it does not', present: true, reason: '' },
    sources: { eyebrow: 'Provenance', title: 'Primary sources', present: true, reason: '' },
  };

  let displayNumber = 0;
  const sections: PassportSection[] = PASSPORT_SECTION_ORDER.map((id) => {
    const definition = definitions[id];
    if (definition.present) displayNumber += 1;

    return {
      id,
      headingId: `${id}-title`,
      eyebrow: definition.eyebrow,
      title: definition.title,
      present: definition.present,
      number: definition.present ? String(displayNumber).padStart(2, '0') : null,
    };
  });

  const notRecorded: NotRecordedNote[] = PASSPORT_SECTION_ORDER
    .filter((id) => !definitions[id].present)
    .map((id) => ({ id, title: definitions[id].title, reason: definitions[id].reason }));

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const usageSection = sections.find((section) => section.id === 'usage');
  if (!usageSection) throw new PassportError('the usage section is missing from the section order');

  const correctionUrl = correctionHref(release);

  const actions: PassportAction[] = [
    {
      kind: 'compare',
      label: `Compare ${release.displayName} with another model`,
      href: compareHref(base, release.slug),
      description:
        'Opens the comparison with this release already chosen. Add one to three more to see them '
        + 'side by side, each value with the source it came from.',
      external: false,
    },
    {
      kind: 'evidence',
      label: 'See the evidence for this record',
      href: `#${usageSection.headingId}`,
      description: 'Jumps to the usage evidence, conditional fit guidance, and primary sources below.',
      external: false,
    },
    {
      kind: 'report',
      label: 'Report incorrect data',
      href: correctionUrl,
      description: `Opens a prefilled correction issue naming the record slug ${release.slug}.`,
      external: true,
    },
  ];

  return {
    release,
    organization,
    family,

    canonicalName: release.canonicalName,
    slug: release.slug,
    canonicalRoute: modelRoute(base, release.slug),
    displayName: release.displayName,
    summary: release.summary,
    intendedUse: release.intendedUse,

    statusLabel: statusLabel(release.status),
    statusDefinition: statusEntry.definition,
    releaseDate,
    verifiedAt: formatDate(release.verifiedAt),
    featuredRationale: release.featuredRationale ?? null,

    identityFacts,
    apiAliases: release.apiAliases,
    otherNames,
    technicalFacts,
    categories: release.categories.map((category) => categoryLabel(category)),

    relationships,
    presentRelationships,

    access,
    availability,
    pricing,
    history,
    sources,

    sections,
    notRecorded,
    actions,
    correctionUrl,
  };
}
