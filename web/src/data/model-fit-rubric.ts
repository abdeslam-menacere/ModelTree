/**
 * The disclosed editorial rubric behind conditional model-fit guidance.
 *
 * This module holds plain constants and imports nothing, so `schema.ts` can
 * build its Zod enums from the same tables that `validate.ts`, the view builder,
 * and the tests read. One table, one source of truth.
 *
 * The rubric is a disclosure mechanism, not a scoring system. A dimension names
 * which recorded facts a statement was derived from; dimensions are never
 * weighted, summed, or compared across models, and there is no composite score.
 */

/** Every guidance statement is exactly one of these. There is no fourth, neutral kind. */
export const FIT_CLASSIFICATIONS = ['good-fit-when', 'trade-off', 'avoid-when'] as const;

/**
 * The kinds of structured fact a statement may be derived from. Each names a
 * record that already exists in this repository and already carries its own
 * primary sources and verification date.
 */
export const FIT_FACT_KINDS = [
  'release-field',
  'family-field',
  'release-event',
  'benchmark-result',
  'usage-observation',
  'pricing-record',
] as const;

/**
 * Release fields that record a fact a source stated. `summary` is deliberately
 * absent: it is ModelTree's own prose, so deriving guidance from it would cite
 * ModelTree as evidence for ModelTree.
 */
export const RELEASE_FACT_FIELDS = [
  'accessType',
  'license',
  'contextWindow',
  'maximumOutput',
  'inputModalities',
  'outputModalities',
  'categories',
  'parameters',
  'status',
  'releaseDate',
  'intendedUse',
] as const;

export const FAMILY_FACT_FIELDS = ['status', 'firstReleaseDate', 'categories'] as const;

export const FIT_RUBRIC_DIMENSIONS = [
  'context-window',
  'documented-limits',
  'modality-coverage',
  'access-and-licensing',
  'lifecycle-stability',
  'cost-structure',
  'measured-benchmark-evidence',
  'usage-evidence',
] as const;

/** Why a dimension yields no guidance. Absence is recorded, never inferred. */
export const FIT_GAP_REASONS = [
  'no-qualifying-source',
  'evidence-below-threshold',
  'sources-conflict',
] as const;

export type FitClassification = (typeof FIT_CLASSIFICATIONS)[number];
export type FitFactKind = (typeof FIT_FACT_KINDS)[number];
export type ReleaseFactField = (typeof RELEASE_FACT_FIELDS)[number];
export type FamilyFactField = (typeof FAMILY_FACT_FIELDS)[number];
export type FitRubricDimension = (typeof FIT_RUBRIC_DIMENSIONS)[number];
export type FitGapReason = (typeof FIT_GAP_REASONS)[number];

interface DimensionSupport {
  /** What the dimension asks of the record, shown to readers as the disclosed rubric. */
  question: string;
  /** Fact kinds that can answer it. A dimension with no matching cited fact is rejected. */
  factKinds: readonly FitFactKind[];
  /** For field-shaped facts, the exact fields that count as an answer. */
  releaseFields?: readonly ReleaseFactField[];
  familyFields?: readonly FamilyFactField[];
}

/**
 * The rubric itself: which recorded facts may support which dimension. A
 * statement that declares a dimension without citing a fact of a listed kind is
 * rejected, so a dimension can never be asserted as an unbacked opinion.
 */
export const RUBRIC_DIMENSION_SUPPORT: Record<FitRubricDimension, DimensionSupport> = {
  'context-window': {
    question: 'How much input and output length does the documentation state?',
    factKinds: ['release-field'],
    releaseFields: ['contextWindow', 'maximumOutput'],
  },
  'documented-limits': {
    question: 'What limits and intended uses does the documentation state outright?',
    factKinds: ['release-field'],
    releaseFields: ['contextWindow', 'maximumOutput', 'intendedUse', 'parameters'],
  },
  'modality-coverage': {
    question: 'Which inputs and outputs are documented?',
    factKinds: ['release-field'],
    releaseFields: ['inputModalities', 'outputModalities', 'categories'],
  },
  'access-and-licensing': {
    question: 'How can it be obtained, and what does its licence permit?',
    factKinds: ['release-field'],
    releaseFields: ['accessType', 'license'],
  },
  'lifecycle-stability': {
    question: 'What lifecycle stage do the vendor records place it in?',
    factKinds: ['release-field', 'family-field', 'release-event'],
    releaseFields: ['status', 'releaseDate'],
    familyFields: ['status'],
  },
  'cost-structure': {
    question: 'What rates are recorded, in which unit and currency?',
    factKinds: ['pricing-record'],
  },
  'measured-benchmark-evidence': {
    question: 'What did a recorded evaluation measure, under which setup?',
    factKinds: ['benchmark-result'],
  },
  'usage-evidence': {
    question: 'What source-qualified usage has been observed, over which population?',
    factKinds: ['usage-observation'],
  },
};

/**
 * Language that turns conditional guidance into a winner declaration.
 *
 * This is a vocabulary filter, not a semantic one. It matches known phrasings,
 * so it catches the usual ways a verdict gets written down but cannot detect a
 * comparative claim worded around them — "no model handles long context better
 * than this one" passes every pattern here. It is a backstop; the rule that
 * actually holds is provenance, enforced in `validate.ts`: a statement may cite
 * only sources the facts beneath it already cite, so it cannot introduce a claim
 * no recorded fact carries. The list deliberately errs toward rejection, since a
 * false positive costs an author a rewording and a false negative ships.
 *
 * These run over ModelTree's own editorial text only — the condition, the
 * statement, its scope and caveats, and the note on an evidence gap. They do not
 * run over creator-authored prose recorded elsewhere in the dataset, which is
 * reported as the creator's claim rather than asserted as ModelTree's.
 *
 * Each pattern is named so a rejection says which phrase failed rather than
 * leaving an author guessing.
 */
export const UNIVERSAL_CLAIM_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'superlative ranking', pattern: /\b(?:best|finest|greatest|smartest|strongest|fastest|cheapest)\b/i },
  { name: 'best-in-class framing', pattern: /\bbest[-\s](?:in[-\s]class|of[-\s]breed|available|choice|option)\b/i },
  { name: 'unqualified superlative', pattern: /\bmost\s+(?:capable|powerful|advanced|intelligent|accurate|reliable)\b/i },
  { name: 'state-of-the-art claim', pattern: /\b(?:state[-\s]of[-\s]the[-\s]art|sota)\b/i },
  { name: 'winner framing', pattern: /\b(?:winner|unbeatable|undisputed|dominates|dominant|king\s+of|gold\s+standard)\b/i },
  { name: 'beats-everything claim', pattern: /\b(?:outperforms|beats|surpasses|exceeds|better\s+than)\s+(?:all|every|any|everything|the\s+(?:rest|field|competition))\b/i },
  { name: 'superior-to-all claim', pattern: /\bsuperior\s+to\s+(?:all|every|any|the\s+(?:rest|field|competition))\b/i },
  { name: 'numeric ranking', pattern: /(?:\bnumber\s+one\b|\bno\.?\s?1\b|#1|\btop[-\s](?:model|choice|pick|ranked|rated)\b|\bfirst\s+place\b)/i },
  { name: 'market-leader claim', pattern: /\b(?:industry|market|class)[-\s]leading\b|\bleading\s+(?:model|models|llm|option|choice|system|provider)\b/i },
  { name: 'go-to claim', pattern: /\bgo[-\s]to\s+(?:model|choice|option)\b/i },
  { name: 'universal quantifier', pattern: /\b(?:universally|in\s+all\s+cases|for\s+everything|across\s+the\s+board)\b/i },
  { name: 'all-use-cases claim', pattern: /\bfor\s+(?:all|any|every)\s+(?:use[-\s]?cases?|workloads?|tasks?|purposes?|applications?)\b/i },
  { name: 'always-right claim', pattern: /\balways\s+(?:the\s+)?(?:best|right|correct|preferable|preferred)\b/i },
  { name: 'never-appropriate claim', pattern: /\bnever\s+(?:the\s+)?(?:right|correct|appropriate|worth)\b/i },
  { name: 'composite score', pattern: /\b(?:composite|overall|universal|aggregate)\s+(?:score|scores|rank|ranking|rating)\b/i },
  { name: 'leaderboard framing', pattern: /\b(?:leaderboard|ranked\s+(?:first|above|higher|top))\b/i },
];

/**
 * The first universal-winner phrase in a piece of editorial text, or `undefined`
 * when the text stays conditional.
 */
export function findUniversalClaim(text: string) {
  for (const { name, pattern } of UNIVERSAL_CLAIM_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { name, phrase: match[0] };
  }

  return undefined;
}
