/**
 * The methodology page's content model.
 *
 * Every label a reader sees on this page is derived from the same enums and
 * label helpers the rest of the site renders from, so a badge cannot be
 * documented one way and displayed another. Adding an enum value without a
 * definition here fails `methodology.test.ts` rather than shipping an
 * undocumented label. The prose in each `definition` is ModelTree's own
 * editorial text; the `value` and `label` are not.
 *
 * Each definition traces to something enforced in this repository — a Zod
 * schema constraint, a deterministic gate, the dataset validator, or an ADR —
 * and the page cites where. Where a rule is *not* enforced, the page says so
 * plainly rather than implying it is.
 */
import {
  accessType,
  lifecycleStatus,
  modelCategory,
  sourceSchema,
  usageSourceCategory,
  type ModelRelease,
  type SourceReference,
  type UsageSourceCategory,
} from '../data/schema';
import {
  FIT_CLASSIFICATIONS,
  FIT_GAP_REASONS,
  type FitClassification,
  type FitGapReason,
} from '../data/model-fit-rubric';
import { PRIMARY_SOURCE_TYPES } from '../data/validate';
import { accessLabel, categoryLabel, statusLabel } from './format';
import { fitClassificationLabel, fitGapReasonLabel } from './model-fit';
import { usageProvenanceLabel } from './usage-evidence';

export interface GlossaryEntry<Value extends string> {
  value: Value;
  label: string;
  definition: string;
}

/** A source type, plus whether it counts as a primary source for the rules below. */
export interface SourceTypeEntry extends GlossaryEntry<SourceReference['type']> {
  primary: boolean;
}

const sourceTypeOptions = sourceSchema.shape.type.options;

/** The public source-type label, formatted exactly as `SourceList.astro` renders it. */
function sourceTypeLabel(type: SourceReference['type']) {
  return type.replaceAll('-', ' ');
}

// ---------------------------------------------------------------------------
// Glossaries. `value` and `label` come from the shared enums and label helpers;
// only `definition` is authored here.
// ---------------------------------------------------------------------------

export const lifecycleStatusGlossary: GlossaryEntry<ModelRelease['status']>[] =
  lifecycleStatus.options.map((value) => ({
    value,
    label: statusLabel(value),
    definition: {
      preview:
        'Announced and testable but not yet the vendor’s generally-available version. Recorded when the source calls it a preview, beta, or early access.',
      current:
        'The vendor’s currently offered version. Shown as “Available”. It is not a claim that the model is recommended or preferred — only that the vendor still offers it.',
      legacy:
        'Superseded by a newer version but still reachable. The vendor has pointed users at a successor without withdrawing this one.',
      deprecated:
        'Marked by the vendor for removal, usually with a retirement date. Recorded from the vendor’s own deprecation notice.',
      research:
        'Released as a research artefact rather than a supported product. Availability and support are not implied.',
    }[value],
  }));

export const accessTypeGlossary: GlossaryEntry<ModelRelease['accessType']>[] =
  accessType.options.map((value) => ({
    value,
    label: accessLabel(value),
    definition: {
      'proprietary-hosted':
        'Reachable only through a hosted API or product. No weights are distributed.',
      'open-weight':
        'Model weights can be downloaded. This alone says nothing about the licence: the schema records downloadable weights and OSI-approval as two separate booleans, so open-weight does not imply open-source.',
      'source-available':
        'Source or weights can be inspected or obtained under terms that are not OSI-approved. Kept distinct from open-source, which requires an OSI-approved licence.',
      both:
        'Offered as a hosted API and as downloadable weights. Shown as “Hosted and open-weight”.',
    }[value],
  }));

export const categoryGlossary: GlossaryEntry<ModelRelease['categories'][number]>[] =
  modelCategory.options.map((value) => ({
    value,
    label: categoryLabel(value),
    definition: {
      'language-reasoning':
        'Text-first models whose documented focus is language understanding and reasoning.',
      'multimodal-generalist':
        'Models documented as handling several modalities as general-purpose systems.',
      coding: 'Models whose documentation centres on code generation or understanding.',
      image: 'Models whose documented output is images.',
      video: 'Models whose documented output is video.',
      'audio-speech': 'Models documented for audio or speech input or output.',
      'embedding-reranking':
        'Models that produce embeddings or rerank results rather than generate content.',
      scientific: 'Models documented for scientific domains such as biology or chemistry.',
      'robotics-world':
        'Models documented for robotics or world-model tasks. Categories describe documented focus and are never summed into a score.',
    }[value],
  }));

export const sourceTypeGlossary: SourceTypeEntry[] = sourceTypeOptions.map((value) => ({
  value,
  label: sourceTypeLabel(value),
  primary: PRIMARY_SOURCE_TYPES.has(value),
  definition: {
    'official-announcement':
      'A launch post or announcement from the model’s creator. A primary source.',
    'official-docs':
      'The creator’s own documentation. A primary source, and the type the site prefers when several sources describe one release.',
    'model-card':
      'A model card published by the creator. A primary source for stated limits and intended use.',
    repository:
      'The creator’s own code or weights repository. A primary source.',
    'benchmark-owner':
      'The party that owns or publishes a benchmark. Authoritative for the benchmark’s definition, but not a primary source for a model’s own facts.',
    'independent-evaluation':
      'A third-party evaluation. Valuable as independent evidence, but not a primary source for what a model is or does.',
  }[value],
}));

export const usageProvenanceGlossary: GlossaryEntry<UsageSourceCategory>[] =
  usageSourceCategory.options.map((value) => ({
    value,
    label: usageProvenanceLabel(value),
    definition: {
      'creator-self-report':
        'A usage figure the model’s creator published about its own model. Kept in a separate labelled list and never counted toward a cross-source synthesis.',
      'platform-operator-report':
        'A figure from a platform that serves the model but did not create it.',
      'independent-measurement':
        'A measurement by a party independent of the creator.',
      'developer-survey':
        'A figure drawn from a survey of developers.',
      'community-signal':
        'A community signal such as repository or download activity. The coarsest evidence, never converted into another metric.',
    }[value],
  }));

export const fitClassificationGlossary: GlossaryEntry<FitClassification>[] =
  FIT_CLASSIFICATIONS.map((value) => ({
    value,
    label: fitClassificationLabel(value),
    definition: {
      'good-fit-when':
        'Conditions under which the recorded facts support choosing this model. It is never a claim that the model is preferable to any other.',
      'trade-off':
        'Conditions where the recorded facts cut both ways, so the decision depends on what the reader is willing to accept.',
      'avoid-when':
        'Conditions under which the recorded facts count against this model. It is never a claim that the model is deficient overall.',
    }[value],
  }));

export const fitGapReasonGlossary: GlossaryEntry<FitGapReason>[] =
  FIT_GAP_REASONS.map((value) => ({
    value,
    label: fitGapReasonLabel(value),
    definition: {
      'no-qualifying-source':
        'No source of a qualifying type was found for this rubric dimension, so no guidance is offered. The absence is recorded rather than read as a negative.',
      'evidence-below-threshold':
        'Some evidence exists but not enough to meet the bar for guidance.',
      'sources-conflict':
        'Qualifying sources disagree, so both readings stand and neither is presented as guidance.',
    }[value],
  }));

// ---------------------------------------------------------------------------
// Benchmark configuration fields. The schema records this configuration on every
// benchmark result so that setups can be told apart; its own comment marks these
// as "configuration that decides whether two results may be compared at all"
// (schema.ts). Each `field` below is a real key on `benchmarkResultSchema` —
// `methodology.test.ts` asserts it. The descriptions state what a field records,
// not a comparability verdict: no code transforms results into a comparison, and
// the dataset currently holds no benchmark results (see `deferredToImplementation`).
// ---------------------------------------------------------------------------

export interface BenchmarkConfigField {
  field: string;
  records: string;
}

export const benchmarkConfigurationFields: BenchmarkConfigField[] = [
  {
    field: 'benchmarkVersion',
    records:
      'Which version of the benchmark a score is from. Two versions are not the same set of questions.',
  },
  {
    field: 'reasoningMode',
    records: 'The reasoning setting the model ran under, when the source discloses it.',
  },
  {
    field: 'toolsEnabled',
    records: 'Whether the model could call tools during the run.',
  },
  {
    field: 'harness',
    records: 'The evaluation harness that produced the score.',
  },
  {
    field: 'resultType',
    records: 'Whether the score is an official self-report or an independent evaluation.',
  },
];

// ---------------------------------------------------------------------------
// Deferred work. Policy this page deliberately does NOT specify, because the
// system does not implement it yet. Naming the owning issue keeps the gap honest
// rather than smoothing it over — the same posture the dataset takes toward
// unknown and conflicting facts.
// ---------------------------------------------------------------------------

export interface DeferredPolicy {
  area: string;
  issue: string;
  note: string;
}

export const deferredToImplementation: DeferredPolicy[] = [
  {
    area: 'Benchmark comparability and evidence transformations',
    issue: 'https://github.com/abdeslam-menacere/ModelTree/issues/22',
    note:
      'How benchmark results are normalised or transformed to be compared across models — beyond recording each result’s configuration and refusing duplicate results under an identical setup — is not implemented, and the dataset currently holds no benchmark results. That policy is issue #22, which itself depends on #21 for benchmark seed data. Until it lands, this page records the benchmark terminology and configuration the schema captures but states no rule for comparing results, because none yet exists to describe.',
  },
];

// ---------------------------------------------------------------------------
// Page outline. The page renders its headings and table of contents from this
// structure, so the rendered hierarchy is exactly what the tests validate: one
// h1, an h2 per section, an h3 per subsection, and a TOC link per section.
// ---------------------------------------------------------------------------

export interface MethodologySubsection {
  id: string;
  title: string;
}

export interface MethodologySection {
  id: string;
  title: string;
  summary: string;
  subsections: MethodologySubsection[];
}

export const methodologySections: MethodologySection[] = [
  {
    id: 'inclusion',
    title: 'Editorial inclusion and coverage',
    summary:
      'Why a record is here, and why coverage is deliberately incomplete.',
    subsections: [
      { id: 'featured-vs-complete', title: 'Featured versus complete coverage' },
      { id: 'reviewed-set', title: 'A reviewed set, not a ranking' },
    ],
  },
  {
    id: 'entities',
    title: 'Entities and terminology',
    summary:
      'The separate things a model name blurs together, and the words used for each.',
    subsections: [
      { id: 'separate-entities', title: 'Separate entities' },
      { id: 'lifecycle', title: 'Lifecycle statuses' },
      { id: 'access', title: 'Access and licensing' },
    ],
  },
  {
    id: 'provenance',
    title: 'Provenance, sources, and freshness',
    summary:
      'Where facts come from, which sources take priority, how conflicts are kept, and what a verification date means.',
    subsections: [
      { id: 'source-types', title: 'Source types and priority' },
      { id: 'conflicts', title: 'Conflicting and incomparable evidence' },
      { id: 'dates', title: 'Dates and partial precision' },
      { id: 'freshness', title: 'Verification and freshness' },
    ],
  },
  {
    id: 'evidence',
    title: 'Pricing and comparable evidence',
    summary:
      'How prices, benchmarks, usage figures, and model-fit guidance are recorded so unlike things are never compared.',
    subsections: [
      { id: 'pricing', title: 'Pricing' },
      { id: 'benchmarks', title: 'Benchmark comparability' },
      { id: 'usage', title: 'Usage evidence' },
      { id: 'guidance', title: 'Model-fit guidance and no universal ranking' },
    ],
  },
  {
    id: 'corrections',
    title: 'Corrections, contributions, and automation review',
    summary:
      'How to fix a fact, how to contribute, and how automated changes are reviewed.',
    subsections: [
      { id: 'correction-path', title: 'Reporting a correction' },
      { id: 'automation-review', title: 'How automated changes are reviewed' },
    ],
  },
];

export interface TocLink {
  href: string;
  title: string;
}

/** In-page anchors for the table of contents, one per top-level section. */
export const methodologyTableOfContents: TocLink[] = methodologySections.map((section) => ({
  href: `#${section.id}`,
  title: section.title,
}));

/**
 * External and internal references the page links to. Internal routes are bare
 * segments so the page can prefix `import.meta.env.BASE_URL`; the correction
 * path is the repository itself, which is where a data correction is filed as
 * an ordinary pull request or issue.
 */
export const methodologyReferences = {
  repository: 'https://github.com/abdeslam-menacere/ModelTree',
  correctionPath: 'https://github.com/abdeslam-menacere/ModelTree/issues/new/choose',
  dataRefreshRoute: 'refresh/',
} as const;

/** Every authored definition string, run through the schema’s own universal-claim filter by the tests. */
export const allMethodologyDefinitions: string[] = [
  ...lifecycleStatusGlossary,
  ...accessTypeGlossary,
  ...categoryGlossary,
  ...sourceTypeGlossary,
  ...usageProvenanceGlossary,
  ...fitClassificationGlossary,
  ...fitGapReasonGlossary,
].map((entry) => entry.definition);
