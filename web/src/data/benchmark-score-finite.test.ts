import { describe, expect, it } from 'vitest';

import { rawDataset } from './raw';
import { benchmarkResultSchema } from './schema';

/**
 * `score` is a benchmark result on published data, so what the schema admits is
 * a data-integrity question rather than a typing detail. `Infinity` and `NaN`
 * are both `typeof 'number'`, so a bare `z.number()` that did not exclude them
 * would let either through as a legitimate score — and no seed fixture supplies
 * a non-finite score, so nothing else in the suite would notice.
 *
 * These assertions exist to pin that boundary independently of *how* it is
 * expressed. They deliberately say nothing about which Zod call enforces it, so
 * they hold across a change of form and fail on a change of behaviour. That is
 * the whole of their value: they were written to be run once with
 * `z.number().finite()` in place and again after it was removed, and a silent
 * widening is exactly what the second run would have caught.
 */
function validResult(): Record<string, unknown> {
  const [first] = rawDataset.benchmarkResults;
  if (!first) throw new Error('seed data no longer carries a benchmark result');
  return structuredClone(first) as unknown as Record<string, unknown>;
}

/** Labelled so a failure names the value that got through, not just a count. */
const NON_FINITE: ReadonlyArray<readonly [string, number]> = [
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['NaN', Number.NaN],
];

describe('benchmarkResultSchema score', () => {
  /**
   * The positive control. Without it every assertion below could pass because
   * the fixture is malformed for some unrelated reason, and a rejection for the
   * wrong reason reads exactly like a rejection for the right one.
   */
  it('accepts the finite score a real seed record carries', () => {
    const result = benchmarkResultSchema.safeParse(validResult());
    expect(result.success).toBe(true);
  });

  it('rejects a non-finite score', () => {
    const verdicts = Object.fromEntries(
      NON_FINITE.map(([label, score]) => [
        label,
        benchmarkResultSchema.safeParse({ ...validResult(), score }).success,
      ]),
    );

    expect(verdicts).toEqual({ Infinity: false, '-Infinity': false, NaN: false });
  });

  /**
   * Rejection alone would still pass if a non-finite score were refused because
   * some *other* field had broken, so the failure has to be attributed to
   * `score` itself.
   */
  it('attributes each non-finite rejection to the score field', () => {
    const paths = Object.fromEntries(
      NON_FINITE.map(([label, score]) => {
        const result = benchmarkResultSchema.safeParse({ ...validResult(), score });
        const blamed = result.success
          ? []
          : result.error.issues.map((issue) => issue.path.join('.'));
        return [label, blamed];
      }),
    );

    expect(paths).toEqual({ Infinity: ['score'], '-Infinity': ['score'], NaN: ['score'] });
  });
});
