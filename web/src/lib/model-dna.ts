/**
 * The Model DNA identity strip's view model (issue #37).
 *
 * A compact summary of what a release *is*, assembled from the identity fields
 * the schema already validates. Four rules shape every line below, and each one
 * exists to keep the "DNA" metaphor from doing work the data cannot support.
 *
 * 1. **Every segment names one field, and reads only that field.** A dimension
 *    declares the `releaseSchema` key it comes from in {@link ModelDnaDimension.field},
 *    and `model-dna.test.ts` asserts that key is genuinely part of the parsed
 *    schema output. Nothing here combines two fields into a third value, and
 *    nothing infers one field from another — the two failures that would turn a
 *    summary into a claim of its own.
 *
 * 2. **Order comes from {@link MODEL_DNA_DIMENSIONS}, never from the data.**
 *    Iterating a record's own keys would let two releases render the same
 *    dimensions in different places, which is exactly what a scannable strip
 *    cannot do. The constant is the order, for every model, always.
 *
 * 3. **A dimension with nothing recorded says so and keeps its place.** Dropping
 *    it would make an unrecorded fact and a fact that does not apply look
 *    identical, and would move every segment after it. `license` is the one
 *    `.optional()` field among the nine, so this is a branch real pages take
 *    rather than dead code: a hosted-only release carries no licence record.
 *
 * 4. **Nothing here is a score, a rating, or a ranking.** There is no number, no
 *    ordering key, and no aggregate. The builder is handed a release, its
 *    creator, and its family, and nothing else — no benchmark result, no price,
 *    no usage figure can reach it, which is a property of the signature rather
 *    than a promise in a comment.
 */
import type { ModelFamily, ModelRelease, Organization } from '../data/schema';
import { accessLabel, categoryLabel } from './format';
import { glossaryEntryHref } from './glossary';
import { organizationLabel } from './organization-name';

/**
 * The identity fields a segment may read, as they are spelled in
 * `releaseSchema`. Written as a union rather than as a free string so a typo
 * cannot ship a segment claiming provenance it does not have; the test then
 * checks the names against the schema itself, which is the half a type cannot
 * do.
 */
export type ModelDnaField =
  | 'organizationId'
  | 'familyId'
  | 'version'
  | 'variant'
  | 'inputModalities'
  | 'outputModalities'
  | 'categories'
  | 'accessType'
  | 'license';

export type ModelDnaDimensionId =
  | 'creator'
  | 'family'
  | 'generation'
  | 'tier'
  | 'input'
  | 'output'
  | 'specialization'
  | 'access'
  | 'weights';

export interface ModelDnaDimension {
  id: ModelDnaDimensionId;
  /** The visible label. Short, because it sits above the value in a narrow chip. */
  label: string;
  /** The `releaseSchema` key this segment reads, and the only one it may read. */
  field: ModelDnaField;
  /** ModelTree's own sentence saying what the dimension is. Never a value's meaning. */
  definition: string;
  /**
   * Where the site documents this dimension's value set, if it does. Built from
   * the base path so a project-page deploy keeps working; `null` where no page
   * defines the values, because a link to a page that does not answer the
   * question is worse than no link.
   */
  definitionHref: ((base: string) => string) | null;
  /** The link's own words, so it says where it goes rather than "learn more". */
  definitionLinkText: string | null;
}

/**
 * The nine dimensions, in the order they render. This array is the ordering
 * contract: `ModelDna.test.tsx` compares the rendered `data-dimension` sequence
 * against it for a complete release, a sparse release, and every release in the
 * shipped dataset.
 *
 * Lifecycle status is deliberately absent. It is a state rather than an
 * identity, the issue's own list of dimensions omits it, and the passport hero
 * already stamps it — a second copy would summarise nothing.
 */
export const MODEL_DNA_DIMENSIONS: readonly ModelDnaDimension[] = [
  {
    id: 'creator',
    label: 'Creator',
    field: 'organizationId',
    definition:
      'The organization recorded as having built this release. A creator is not '
      + 'the same entity as a platform that serves the model or a product that ships it.',
    definitionHref: (base) => `${base}methodology/#separate-entities`,
    definitionLinkText: 'How ModelTree keeps creator, model, product and platform separate',
  },
  {
    id: 'family',
    label: 'Family',
    field: 'familyId',
    definition:
      'The model line this release belongs to, as its creator names it. A family '
      + 'groups releases; it is not itself a release.',
    definitionHref: (base) => `${base}methodology/#separate-entities`,
    definitionLinkText: 'How ModelTree keeps creator, model, product and platform separate',
  },
  {
    id: 'generation',
    label: 'Generation',
    field: 'version',
    definition:
      'The version string the creator published for this release, recorded as '
      + 'written. ModelTree does not renumber, normalise, or order versions.',
    definitionHref: null,
    definitionLinkText: null,
  },
  {
    id: 'tier',
    label: 'Tier',
    field: 'variant',
    definition:
      'The variant name the creator gave this release within its family. It is a '
      + 'name, not a rank: what a creator means by it is recorded only where the '
      + 'creator has stated it.',
    definitionHref: (base) => `${base}methodology/#guidance`,
    definitionLinkText: 'Why ModelTree publishes no universal ranking',
  },
  {
    id: 'input',
    label: 'Input',
    field: 'inputModalities',
    definition: 'The kinds of input this release is documented as accepting.',
    definitionHref: null,
    definitionLinkText: null,
  },
  {
    id: 'output',
    label: 'Output',
    field: 'outputModalities',
    definition: 'The kinds of output this release is documented as producing.',
    definitionHref: null,
    definitionLinkText: null,
  },
  {
    id: 'specialization',
    label: 'Specialization',
    field: 'categories',
    definition:
      'The documented focus of this release. Categories are labels, never summed '
      + 'or weighted into a score.',
    // No page on this site defines the category vocabulary, and a link to a page
    // that does not answer the question is worse than no link at all.
    definitionHref: null,
    definitionLinkText: null,
  },
  {
    id: 'access',
    label: 'Access',
    field: 'accessType',
    definition: 'How this release can be reached, as its creator documents it.',
    definitionHref: (base) => `${base}methodology/#access`,
    definitionLinkText: 'How ModelTree defines each access type',
  },
  {
    id: 'weights',
    label: 'Weights',
    field: 'license',
    definition:
      'Whether the licence record held for this release documents its weights as '
      + 'downloadable. Downloadable weights and an OSI-approved licence are '
      + 'separate claims, so this is not a statement that the release is open source.',
    definitionHref: (base) => glossaryEntryHref(base, 'open-weight'),
    definitionLinkText: 'What “open weight” means',
  },
] as const;

/**
 * Every modality the schema allows, in the words the strip prints. A map rather
 * than a `toUpperCase` call so the set is total and checkable: `model-dna.test.ts`
 * asserts every `modality` enum option has an entry, which means a modality
 * added to the schema cannot ship through this strip unlabelled. Capitalisation
 * is the whole of the transformation — no vocabulary is invented here.
 */
export const MODALITY_LABELS: Record<ModelRelease['inputModalities'][number], string> = {
  text: 'Text',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
};

export interface ModelDnaSegment {
  id: ModelDnaDimensionId;
  label: string;
  /** The `releaseSchema` key this value was read from, shown to the reader. */
  field: ModelDnaField;
  /** What the record states, or the words for its absence. Always renderable text. */
  value: string;
  /** False when the record holds nothing for this dimension. */
  recorded: boolean;
  definition: string;
  /**
   * Why this dimension is empty, when it is. Absence has a reason on this site,
   * and stating it is what stops "Not recorded" reading as a defect in the data.
   */
  absenceNote: string | null;
  definitionHref: string | null;
  definitionLinkText: string | null;
}

export interface ModelDnaView {
  /** Stable and unique within a passport page, so `aria-labelledby` resolves. */
  headingId: string;
  title: string;
  /** What the strip is and is not, in words, above the segments. */
  note: string;
  /** The disclosure's own label, naming what it contains rather than "more". */
  textEquivalentLabel: string;
  segments: ModelDnaSegment[];
}

/** The words a segment with nothing recorded prints. Identical everywhere, by construction. */
export const MODEL_DNA_NOT_RECORDED = 'Not recorded';

/**
 * What the strip reads for one dimension, or `null` where the record holds
 * nothing.
 *
 * The switch is exhaustive over {@link ModelDnaDimensionId} and each arm touches
 * exactly the field its dimension declares, so "every segment maps directly to a
 * validated field" is visible in one place rather than spread across the file.
 */
function readDimension(
  dimension: ModelDnaDimension,
  release: ModelRelease,
  organization: Organization,
  family: ModelFamily,
): string | null {
  switch (dimension.id) {
    case 'creator':
      return organizationLabel(organization);
    case 'family':
      return family.name;
    case 'generation':
      return release.version;
    case 'tier':
      return release.variant;
    case 'input':
      return release.inputModalities.map((value) => MODALITY_LABELS[value]).join(', ');
    case 'output':
      return release.outputModalities.map((value) => MODALITY_LABELS[value]).join(', ');
    case 'specialization':
      return release.categories.map((value) => categoryLabel(value)).join(', ');
    case 'access':
      return accessLabel(release.accessType);
    case 'weights':
      // Read from the licence record and from nothing else. A release with no
      // licence record returns null and renders as unrecorded: reporting "not
      // downloadable" here would turn the absence of a record into a claim about
      // the model, which is the one inference this dimension must not make.
      return release.license
        ? (release.license.weightsDownloadable ? 'Downloadable' : 'Not downloadable')
        : null;
  }
}

/**
 * Why a dimension is empty, in the terms the schema actually sets. Only
 * `license` is optional, so only `license` has a reason to give; the other eight
 * are `.min(1)` or required, and a record that failed them would never have been
 * published.
 */
function absenceNote(dimension: ModelDnaDimension): string {
  if (dimension.id === 'weights') {
    return 'No licence record is held for this release. The schema requires one only where a '
      + 'release claims downloadable weights, so its absence is not a claim that the model is '
      + 'unlicensed.';
  }

  return 'The record holds no value for this dimension.';
}

/**
 * Builds the strip for one release.
 *
 * Takes the three records it reads and the base path, and nothing else. A
 * benchmark result, a price, or a usage figure cannot reach this function to be
 * summarised, which is how "only stable categorical facts belong in the strip"
 * is held — by the signature, not by discipline.
 *
 * @param base the site base path, used only to address definition pages
 */
export function buildModelDna(
  release: ModelRelease,
  organization: Organization,
  family: ModelFamily,
  base: string,
): ModelDnaView {
  const basePath = base.endsWith('/') ? base : `${base}/`;

  const segments: ModelDnaSegment[] = MODEL_DNA_DIMENSIONS.map((dimension) => {
    const value = readDimension(dimension, release, organization, family);
    const recorded = value !== null && value !== '';

    return {
      id: dimension.id,
      label: dimension.label,
      field: dimension.field,
      value: recorded ? (value as string) : MODEL_DNA_NOT_RECORDED,
      recorded,
      definition: dimension.definition,
      absenceNote: recorded ? null : absenceNote(dimension),
      definitionHref: dimension.definitionHref ? dimension.definitionHref(basePath) : null,
      definitionLinkText: dimension.definitionLinkText,
    };
  });

  return {
    headingId: 'model-dna-title',
    title: 'Model DNA',
    // Counted from the segments rather than written as a word, so the sentence
    // cannot disagree with the strip beneath it. It says "dimensions", not
    // "recorded facts": some of them are recorded as absent, and a count that
    // called those facts would be the strip's first false claim.
    note: `${segments.length} identity dimensions, each read from a single field of this release's `
      + 'record and shown in the same order on every model. Nothing here is a score, a rating, or a '
      + 'ranking, and a dimension the record does not carry says so rather than being left out.',
    textEquivalentLabel: 'What each segment means, and which field it comes from',
    segments,
  };
}
