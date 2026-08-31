/**
 * Variant positioning records written against `passport-dataset.ts`.
 *
 * The passport fixture's `complete-family` carries two variant names, `base` and
 * `mini`, which is the smallest catalog that can show all three coverage states:
 * position both and it is complete, position one and it is partial, position
 * neither and it is absent. The shipped document is exercised against the
 * shipped catalog in `src/lib/variant-positioning.test.ts`; these exist so the
 * *rendering* of each state is proven rather than assumed, which real data
 * cannot do because no shipped family is absent and rendered at once.
 *
 * The prose deliberately names no organization but the fixture's own
 * `Example Lab`. `assertStaysWithinCreator` throws on a sentence that reaches
 * another creator, and a fixture that trips a guard it was not written to test
 * only obscures the guard that matters.
 */
import type { VariantPositioning } from '../../src/data/variant-positioning-schema';

const officialBase = {
  effectiveAsOf: '2026-08-20',
  sources: [
    {
      url: 'https://example-lab.test/docs/models',
      title: 'Model line-up',
      publisher: 'Example Lab',
      type: 'official-docs' as const,
      quote: 'Our general-purpose model for long-running document work',
      lastCheckedDate: '2026-08-20',
    },
  ],
};

const officialMini = {
  effectiveAsOf: '2026-08-20',
  sources: [
    {
      url: 'https://example-lab.test/docs/models',
      title: 'Model line-up',
      publisher: 'Example Lab',
      type: 'official-docs' as const,
      quote: 'A smaller build of the same line for short, high-volume calls',
      lastCheckedDate: '2026-08-20',
    },
  ],
};

const baseEntry = {
  variant: 'base',
  official: officialBase,
  editorial: {
    summary: 'Example Lab describes the base name as the whole-line default, and says nothing '
      + 'about how it compares to any model outside this line.',
    verifiedAt: '2026-08-20',
  },
};

/** Both names in use are positioned, so coverage is measured as complete. */
export const completePositioning: VariantPositioning = [
  {
    id: 'positioning-complete-family',
    familyId: 'complete-family',
    note: 'Example Lab publishes one sentence per name in this line, and those sentences are '
      + 'what is recorded here rather than any reading of the model behind them.',
    variants: [
      baseEntry,
      {
        variant: 'mini',
        official: officialMini,
        editorial: {
          summary: 'Example Lab words the mini name around call volume and length rather than '
            + 'around capability, and records no ordering between the two names.',
          verifiedAt: '2026-08-20',
        },
      },
    ],
    verifiedAt: '2026-08-20',
  },
];

/** `mini` is in use and unpositioned, so coverage is measured as partial. */
export const partialPositioning: VariantPositioning = [
  {
    id: 'positioning-complete-family',
    familyId: 'complete-family',
    note: 'Example Lab publishes one sentence per name in this line, and those sentences are '
      + 'what is recorded here rather than any reading of the model behind them.',
    variants: [baseEntry],
    verifiedAt: '2026-08-20',
  },
];

/** No record at all, which is the state most families in the catalog are in. */
export const absentPositioning: VariantPositioning = [];

/** The second page cited by {@link multiSourcePositioning} for the `base` name. */
export const SECOND_BASE_SOURCE = {
  url: 'https://example-lab.test/cards/base',
  title: 'Base model card',
  publisher: 'Example Lab',
  type: 'model-card' as const,
  quote: 'The base build is the one we document for long-running document work',
  lastCheckedDate: '2026-08-21',
};

/**
 * `base` cited to two pages, which the schema has always permitted.
 *
 * `sources` is `min(1)` and unbounded because a creator routinely explains one
 * name across a model card, a docs page and a launch post. Both pages here carry
 * the same publisher, because that is the ordinary multi-source case: what tells
 * them apart on the page has to be their titles, URLs, check dates and quotes,
 * all of which are text, rather than the order they happen to sit in.
 */
export const multiSourcePositioning: VariantPositioning = [
  {
    ...completePositioning[0],
    variants: completePositioning[0].variants.map((entry) => (
      entry.variant === 'base'
        ? {
          ...entry,
          official: {
            ...entry.official,
            sources: [...entry.official.sources, SECOND_BASE_SOURCE],
          },
        }
        : entry
    )),
  },
];
