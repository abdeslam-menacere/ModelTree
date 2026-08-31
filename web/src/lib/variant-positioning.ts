import type { Dataset, ModelFamily, ModelRelease } from '../data/schema';
import type {
  VariantEditorialPositioning,
  VariantOfficialPositioning,
  VariantPositioning,
  VariantPositioningRecord,
} from '../data/variant-positioning-schema';
import { variantPositioning as defaultVariantPositioning } from '../data/variant-positioning';
import { comparePartialDates } from '../data/partial-date';

/**
 * Reading `variant-positioning.json` against the catalog it describes.
 *
 * The schema in `data/variant-positioning-schema.ts` can check one record in
 * isolation. Three things it structurally cannot check need the dataset, and all
 * three are enforced here, at build time, because each is a way the feature could
 * quietly start saying something it must never say.
 *
 * **A recorded variant must exist.** `Opus` is only meaningful because releases
 * in that family carry `variant: "Opus"`. A record naming a variant no release
 * uses is either a typo or a claim about a model that is not in the catalog, and
 * both would render a line beneath nothing.
 *
 * **Coverage is measured, not declared.** Whether a family's naming is fully
 * explained is derived by comparing the recorded variants against the variants
 * its releases actually use. There is no field an author can set to say
 * "complete", so a partial record cannot present itself as a whole one, and a
 * family with no record at all reads as an explicit absence rather than as
 * silence.
 *
 * **No creator is positioned against another.** This is issue #38's flat
 * non-goal, and the reason it is enforced by a throw rather than by review
 * attention is that the sentence which breaks it is the most natural sentence in
 * the world to write. Two creators' variant ladders are not commensurable: they
 * are marketing vocabularies over different model line-ups, built to different
 * intentions, and a sentence mapping one onto the other states something neither
 * creator said and no source supports. So prose here may not name another
 * organization, nor a family belonging to one.
 *
 * A sibling generation from the *same* creator is allowed, and deliberately so:
 * "Google words Gemini 2.5 Pro differently" is exactly the generation-scoping the
 * issue asks to be made visible, and it is not a claim across vendors. What is
 * blocked is the analogy that crosses creators.
 */

export type VariantPositioningCoverage = 'complete' | 'partial' | 'absent';

/** A variant whose positioning the creator has stated and ModelTree has read. */
export interface PositionedVariantView {
  variant: string;
  /** Releases in this family carrying this variant name, oldest first. */
  releases: ModelRelease[];
  official: VariantOfficialPositioning;
  editorial: VariantEditorialPositioning;
}

/** A variant used by this family's releases that no source positions. */
export interface UnpositionedVariantView {
  variant: string;
  releases: ModelRelease[];
}

/**
 * The one line rendered beside a release in the lineage explorer.
 *
 * Both shapes carry the variant name, because the name is the thing the reader is
 * trying to decode and it stays useful even when nothing else is recorded. The
 * unrecorded shape carries nothing else at all — there is no partial guess to
 * fall back on.
 */
export type VariantPositioningLine =
  | { recorded: true; variant: string; publisher: string; quote: string }
  | { recorded: false; variant: string };

export interface FamilyVariantPositioningView {
  family: ModelFamily;
  coverage: VariantPositioningCoverage;
  /** ModelTree's framing of the family's naming. Absent when nothing is recorded. */
  note?: string;
  verifiedAt?: string;
  /** Positioned variants, oldest member release first. */
  positioned: PositionedVariantView[];
  /** Variants in use with nothing recorded, in the same order. */
  unpositioned: UnpositionedVariantView[];
  variantCount: number;
  positionedVariantCount: number;
  lineByReleaseId: Map<string, VariantPositioningLine>;
}

export type VariantPositioningIndex = ReadonlyMap<string, VariantPositioningRecord>;

/** The parts of the catalog a positioning record is checked against. */
export type PositioningCatalog = Pick<Dataset, 'organizations' | 'families' | 'releases'>;

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `text` names `term` as a term rather than as a fragment of a longer
 * word, so that "Meta" is found in "Meta says" and not in "metadata".
 *
 * Boundaries are asserted only where the term's own edge is a word character.
 * A name like "01.AI" ends in a letter but begins with a digit, and a name like
 * "Command A" ends in a single letter; `\b` around a term whose edge is already
 * punctuation would never match.
 */
function namesTerm(text: string, term: string) {
  const escaped = escapeForRegExp(term);
  const prefix = /^\w/.test(term) ? '\\b' : '';
  const suffix = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i').test(text);
}

/**
 * Rejects a record whose prose reaches outside its own creator.
 *
 * Runs over ModelTree's authored strings only. A creator's own quote is left
 * alone: quotes are reported in the creator's voice, they routinely name the
 * creator, and rewriting one would make `official` no longer verbatim.
 */
function assertStaysWithinCreator(
  record: VariantPositioningRecord,
  family: ModelFamily,
  dataset: PositioningCatalog,
) {
  const foreignTerms: { term: string; kind: string }[] = [];

  for (const organization of dataset.organizations) {
    if (organization.id === family.organizationId) continue;
    foreignTerms.push({ term: organization.name, kind: 'creator' });
    if (organization.shortName !== organization.name) {
      foreignTerms.push({ term: organization.shortName, kind: 'creator' });
    }
  }

  for (const candidate of dataset.families) {
    if (candidate.organizationId === family.organizationId) continue;
    foreignTerms.push({ term: candidate.name, kind: "another creator's family" });
  }

  const prose: [string, string][] = [
    [`note on ${record.id}`, record.note],
    ...record.variants.map((entry): [string, string] => [
      `editorial summary for ${entry.variant} in ${record.id}`,
      entry.editorial.summary,
    ]),
  ];

  for (const [label, text] of prose) {
    const found = foreignTerms.find(({ term }) => namesTerm(text, term));
    if (!found) continue;

    throw new Error(
      `Variant positioning: the ${label} names ${found.kind} "${found.term}". `
      + 'Positioning is recorded strictly within one family; no creator is placed relative to another, '
      + 'because two creators\' variant names are not comparable and no source states such a comparison.',
    );
  }
}

function variantOrder(releases: readonly ModelRelease[]) {
  const earliest = new Map<string, string>();
  for (const release of releases) {
    const held = earliest.get(release.variant);
    if (held === undefined || comparePartialDates(release.releaseDate, held) < 0) {
      earliest.set(release.variant, release.releaseDate);
    }
  }
  return earliest;
}

/**
 * Groups a family's releases by variant, oldest variant first.
 *
 * Chronological because it is the one order that is a recorded fact rather than
 * a judgement: it says which name the family used first and nothing about which
 * name is preferable. Ties fall back to the variant name so the output is stable
 * between builds.
 */
function groupByVariant(releases: readonly ModelRelease[]) {
  const groups = new Map<string, ModelRelease[]>();
  for (const release of releases) {
    const bucket = groups.get(release.variant);
    if (bucket) bucket.push(release);
    else groups.set(release.variant, [release]);
  }

  const earliest = variantOrder(releases);
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => (
      comparePartialDates(a.releaseDate, b.releaseDate) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    ));
  }

  return [...groups.entries()].sort(([variantA], [variantB]) => (
    comparePartialDates(earliest.get(variantA) ?? '', earliest.get(variantB) ?? '')
    || (variantA < variantB ? -1 : variantA > variantB ? 1 : 0)
  ));
}

/** Every check a record must pass before any of it is rendered. */
function assertRecord(
  record: VariantPositioningRecord,
  family: ModelFamily,
  dataset: PositioningCatalog,
) {
  assertStaysWithinCreator(record, family, dataset);

  const variantsInUse = new Set(
    dataset.releases
      .filter((release) => release.familyId === record.familyId)
      .map((release) => release.variant),
  );

  for (const entry of record.variants) {
    if (variantsInUse.has(entry.variant)) continue;
    throw new Error(
      `Variant positioning: record ${record.id} positions variant "${entry.variant}", `
      + `which no release of ${record.familyId} uses. A variant is positioned only where the `
      + 'catalog records releases carrying that name.',
    );
  }
}

/**
 * Validates every record against the catalog and returns them keyed by family.
 *
 * The strict whole-document pass. It refuses a record naming a family the
 * catalog does not hold, which is how a typo'd `familyId` is caught — and it is
 * run against the shipped catalog by `variant-positioning.test.ts`, so that typo
 * fails `npm run validate` and therefore `npm run build`, which runs validate
 * first. It is deliberately *not* run by the page builders: they are handed test
 * fixtures holding a single synthetic family, and validating records about real
 * families against such a slice would fail on catalogs that were never claimed
 * to contain them.
 */
export function buildVariantPositioningIndex(
  dataset: PositioningCatalog,
  records: VariantPositioning = defaultVariantPositioning,
): VariantPositioningIndex {
  const familyById = new Map(dataset.families.map((family) => [family.id, family]));
  const index = new Map<string, VariantPositioningRecord>();

  for (const record of records) {
    const family = familyById.get(record.familyId);
    if (!family) {
      throw new Error(
        `Variant positioning: record ${record.id} positions unknown family ${record.familyId}.`,
      );
    }

    assertRecord(record, family, dataset);
    index.set(record.familyId, record);
  }

  return index;
}

/**
 * The same view for one family, without requiring the whole document to describe
 * the catalog it is handed.
 *
 * This is what the pages use. Both the lineage explorer and the passport are
 * built against fixtures in tests, and a fixture holds one synthetic family
 * rather than the shipped catalog, so a whole-document pass there would fail on
 * records about families the fixture never claimed to have. The record that is
 * about to render is still fully checked — its variants must be in use, and its
 * prose must not cross to another creator — so nothing reaches a reader
 * unverified. The one check that needs the whole catalog, that every record
 * names a family that exists, is made against the shipped catalog in
 * `variant-positioning.test.ts` instead.
 */
export function buildVariantPositioningForFamily(
  dataset: PositioningCatalog,
  family: ModelFamily,
  releases: readonly ModelRelease[],
  records: VariantPositioning = defaultVariantPositioning,
): FamilyVariantPositioningView {
  const record = records.find((candidate) => candidate.familyId === family.id);
  const index = new Map<string, VariantPositioningRecord>();
  if (record) {
    assertRecord(record, family, dataset);
    index.set(record.familyId, record);
  }
  return buildFamilyVariantPositioning(family, releases, index);
}

/**
 * What is recorded about one family's variant names, and what is not.
 *
 * Pure: everything it needs has already been checked by
 * `buildVariantPositioningIndex`. A family with no record comes back `absent`
 * with empty lists, which is a renderable state rather than a missing one.
 */
export function buildFamilyVariantPositioning(
  family: ModelFamily,
  releases: readonly ModelRelease[],
  index: VariantPositioningIndex,
): FamilyVariantPositioningView {
  const record = index.get(family.id);
  const grouped = groupByVariant(releases);
  const positioned: PositionedVariantView[] = [];
  const unpositioned: UnpositionedVariantView[] = [];
  const lineByReleaseId = new Map<string, VariantPositioningLine>();

  for (const [variant, members] of grouped) {
    const entry = record?.variants.find((candidate) => candidate.variant === variant);

    if (entry) {
      positioned.push({ variant, releases: members, official: entry.official, editorial: entry.editorial });
      const [source] = entry.official.sources;
      for (const member of members) {
        lineByReleaseId.set(member.id, {
          recorded: true,
          variant,
          publisher: source.publisher,
          quote: source.quote,
        });
      }
      continue;
    }

    unpositioned.push({ variant, releases: members });
    for (const member of members) {
      lineByReleaseId.set(member.id, { recorded: false, variant });
    }
  }

  const coverage: VariantPositioningCoverage = record === undefined
    ? 'absent'
    : unpositioned.length === 0 ? 'complete' : 'partial';

  return {
    family,
    coverage,
    note: record?.note,
    verifiedAt: record?.verifiedAt,
    positioned,
    unpositioned,
    variantCount: grouped.length,
    positionedVariantCount: positioned.length,
    lineByReleaseId,
  };
}

/**
 * The family-level sentence, in words rather than in a count alone.
 *
 * Written here rather than in each component so the explorer and the Passport
 * cannot drift into describing the same state two different ways, and returned as
 * plain text so it reads identically to a screen reader and to a sighted reader.
 */
export function variantPositioningCoverageLine(view: FamilyVariantPositioningView): string {
  const { coverage, positionedVariantCount, variantCount } = view;

  if (coverage === 'absent') {
    return variantCount > 1
      ? `No creator statement of what these ${variantCount} variant names mean is recorded for ${view.family.name}.`
      : `No creator statement of what this variant name means is recorded for ${view.family.name}.`;
  }

  if (coverage === 'partial') {
    return `Creator positioning is recorded for ${positionedVariantCount} of the ${variantCount} variant names in ${view.family.name}; the rest are marked as not recorded.`;
  }

  return variantCount > 1
    ? `Creator positioning is recorded for all ${variantCount} variant names in ${view.family.name}.`
    : `Creator positioning is recorded for the one variant name in ${view.family.name}.`;
}
