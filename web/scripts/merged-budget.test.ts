// The merged-budget instrument's own tests (issue #753).
//
// Two things are pinned here, and they are pinned for the same reason the tool
// exists: a measurement of the wrong state is indistinguishable from a
// measurement of the right one, so every place this tool could quietly measure
// the wrong thing needs something that fails loudly when it starts to.
//
//   * **The ceilings are read, not restated.** `readCeilings` parses
//     `src/lib/comparison.test.ts`. The tests below run it against that real
//     file — not a fixture — so a change to how the budgets are asserted turns
//     this red instead of leaving the tool reporting headroom against a stale
//     copy. Every failure mode of the parse is a refusal, and each refusal is
//     asserted, because a parser that silently returned a default would
//     reintroduce the defect at one remove.
//   * **The picker byte count mirrors the test's own.** `comparison.ts` exports
//     no measurer for the picker index, so `measurePickerIndex` reproduces the
//     expression the budget test uses. The mirror is asserted against that
//     expression over the live dataset.
//   * **Which subject a figure belongs to is stated on every line** (issue
//     #693). The picker ceilings guard an artefact nothing ships, and a breach
//     of one read as a page-weight regression is what cost #740 three
//     researched creators. The tag and the escalation are asserted in both
//     directions, and so is the fact that neither changes a verdict.
//
// The verdict logic is tested in both directions, and the benign one matters as
// much as the dangerous one: an advisory that fires when trunk has *freed*
// headroom gets ignored, and then the dangerous case goes unread with it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CEILING_SUBJECTS,
  isShipped,
  measurePickerIndex,
  readCeilings,
  renderMeasurement,
} from './comparison-budget.mjs';
import { decide, render } from './merged-budget.mjs';
import { dataset } from '../src/data/dataset';
import {
  buildComparisonPayload,
  buildComparisonPickerIndex,
  measureComparisonPayload,
} from '../src/lib/comparison';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const budgetTestPath = join(webRoot, 'src', 'lib', 'comparison.test.ts');
const budgetTestSource = readFileSync(budgetTestPath, 'utf8');

/** A measurement in the shape `comparison-budget.mjs` emits. */
function measurement(values: Record<string, [number, number]>) {
  return {
    releaseCount: 96,
    pickerRowCount: 96,
    metrics: CEILING_SUBJECTS.filter(({ id }) => id in values).map(({ id, label, unit, shipped }) => {
      const [value, ceiling] = values[id]!;
      return {
        id,
        label,
        unit,
        shipped,
        value,
        ceiling,
        headroom: ceiling - value,
        within: value <= ceiling,
      };
    }),
  };
}

/** A resolved anchor in the shape `merged-budget.mjs` reports about. */
const anchorFixture = {
  head: 'aaaaaaaaaaaa1111111111111111111111111111',
  published: 'bbbbbbbbbbbb2222222222222222222222222222',
  anchor: 'cccccccccccc3333333333333333333333333333',
  mergedTree: 'dddddddddddd4444444444444444444444444444',
  trunkCommitsSinceAnchor: 2,
};

describe('reading the ceilings out of comparison.test.ts', () => {
  it('finds every ceiling the budget tests actually enforce', () => {
    const ceilings = readCeilings(budgetTestSource);

    expect(Object.keys(ceilings).sort()).toEqual(CEILING_SUBJECTS.map(({ id }) => id).sort());
    for (const [id, value] of Object.entries(ceilings)) {
      expect(Number.isSafeInteger(value), `${id} is a whole number`).toBe(true);
      expect(value, `${id} is a positive bound`).toBeGreaterThan(0);
    }
  });

  it('reads bounds that the live dataset is genuinely measured against', () => {
    // Non-vacuity, and the check that the parse latched onto the right
    // assertions rather than four numbers that happen to parse. Every figure
    // the tool reports is computed here with the repository's own instruments
    // and must sit under the bound the parse returned -- which is only true if
    // the parse found the budget assertions and not, say, a count in a comment.
    const ceilings = readCeilings(budgetTestSource);
    const payload = measureComparisonPayload(buildComparisonPayload(dataset));
    const picker = measurePickerIndex(buildComparisonPickerIndex(dataset));

    expect(payload.totalBytes).toBeLessThanOrEqual(ceilings['payload.totalBytes']!);
    expect(payload.bytesPerRelease).toBeLessThanOrEqual(ceilings['payload.bytesPerRelease']!);
    expect(picker.bytes).toBeLessThanOrEqual(ceilings['picker.totalBytes']!);
    expect(picker.bytesPerRelease).toBeLessThanOrEqual(ceilings['picker.bytesPerRelease']!);

    // And the bounds are of the order the figures are, so a parse that returned
    // some unrelated large literal could not pass the four assertions above by
    // being generous. Each ceiling is within one order of magnitude of what it
    // bounds.
    expect(ceilings['payload.totalBytes']!).toBeLessThan(payload.totalBytes * 10);
    expect(ceilings['picker.totalBytes']!).toBeLessThan(picker.bytes * 10);
  });

  it('does not confuse `bytes` with the `bytes` inside `size.totalBytes`', () => {
    // The picker's total is asserted about a bare `bytes`, and the payload's
    // about `size.totalBytes`. A subject match that did not pin what precedes
    // the subject would pair the picker's ceiling with the payload's assertion.
    const ceilings = readCeilings(budgetTestSource);
    expect(ceilings['picker.totalBytes']).not.toBe(ceilings['payload.totalBytes']);
    expect(ceilings['picker.totalBytes']).toBeLessThan(ceilings['payload.totalBytes']!);
  });

  it('reads numeric separators as the numbers they are', () => {
    const source = CEILING_SUBJECTS
      .map(({ subject }, index) => `expect(${subject}, 'm').toBeLessThanOrEqual(1_${index}00);`)
      .join('\n');

    expect(readCeilings(source)).toEqual({
      'payload.totalBytes': 1000,
      'payload.bytesPerRelease': 1100,
      'picker.totalBytes': 1200,
      'picker.bytesPerRelease': 1300,
    });
  });

  it('refuses a file that stopped asserting one of the ceilings', () => {
    const source = CEILING_SUBJECTS
      .slice(1)
      .map(({ subject }) => `expect(${subject}, 'm').toBeLessThanOrEqual(10);`)
      .join('\n');

    expect(() => readCeilings(source)).toThrow(/no .*assertion for payload\.totalBytes/);
  });

  it('refuses a file that bounds the same subject twice', () => {
    const source = `${CEILING_SUBJECTS
      .map(({ subject }) => `expect(${subject}, 'm').toBeLessThanOrEqual(10);`)
      .join('\n')}\nexpect(bytes, 'm').toBeLessThanOrEqual(20);`;

    expect(() => readCeilings(source)).toThrow(/ambiguous/);
  });

  it('refuses rather than defaulting when nothing parses', () => {
    // The one behaviour this parser may not have. A ceiling it could not read is
    // a ceiling it cannot report headroom against, and a fallback literal is the
    // exact drift the tool exists to close.
    expect(() => readCeilings('')).toThrow(/cannot read the byte ceilings/);
  });
});

describe('the picker measurement mirrors the budget test', () => {
  it('agrees with the expression comparison.test.ts counts with', () => {
    const index = buildComparisonPickerIndex(dataset);
    const mirrored = measurePickerIndex(index);

    const bytes = new TextEncoder().encode(JSON.stringify(index)).length;
    const bytesPerRelease = index.length === 0 ? 0 : Math.round(bytes / index.length);

    expect(mirrored).toEqual({ bytes, bytesPerRelease });
    expect(mirrored.bytes).toBeGreaterThan(0);
  });

  it('reports zero rather than dividing by zero on an empty index', () => {
    expect(measurePickerIndex([])).toEqual({ bytes: 2, bytesPerRelease: 0 });
  });
});

describe('the verdict', () => {
  const ceiling = 11_264;

  it('fails when the merge breaches a ceiling the branch alone did not', () => {
    // The dangerous direction: trunk consumed headroom while this branch was in
    // flight. Every gate on the branch passes, because they all read the branch.
    const verdict = decide(
      measurement({ 'picker.totalBytes': [11_000, ceiling] }),
      measurement({ 'picker.totalBytes': [11_900, ceiling] }),
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.newBreaches).toHaveLength(1);
    expect(verdict.newBreaches[0]!.finding).toBe('new-breach');
    expect(verdict.newBreaches[0]!.merged.headroom).toBe(-636);
    expect(verdict.metrics[0]!.head!.within).toBe(true);
  });

  it('passes, and says so, when trunk has freed headroom the branch cannot see', () => {
    // #740's direction. "You have more room than you thought" is advice: an
    // advisory that fires on good news gets ignored, and the dangerous case goes
    // unread with it.
    const verdict = decide(
      measurement({ 'picker.totalBytes': [11_219, ceiling] }),
      measurement({ 'picker.totalBytes': [7_556, ceiling] }),
    );

    expect(verdict.exitCode).toBe(0);
    expect(verdict.breaches).toEqual([]);
    expect(verdict.freed).toHaveLength(1);
    expect(verdict.freed[0]!.headroomDelta).toBe(3_663);
    expect(verdict.diverged).toBe(true);
  });

  it('passes when trunk consumed headroom but the merge still fits', () => {
    const verdict = decide(
      measurement({ 'picker.totalBytes': [7_000, ceiling] }),
      measurement({ 'picker.totalBytes': [9_000, ceiling] }),
    );

    expect(verdict.exitCode).toBe(0);
    expect(verdict.consumed).toHaveLength(1);
    expect(verdict.consumed[0]!.headroomDelta).toBe(-2_000);
  });

  it('separates a breach the branch already had from one the merge introduces', () => {
    // Over on both sides is the branch's own tests refusing it, which is not a
    // merge-staleness finding -- but it is still not a pass, because the exit
    // code answers "is the merged result within every ceiling".
    const verdict = decide(
      measurement({ 'picker.totalBytes': [12_000, ceiling] }),
      measurement({ 'picker.totalBytes': [12_400, ceiling] }),
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.newBreaches).toEqual([]);
    expect(verdict.breaches).toHaveLength(1);
    expect(verdict.breaches[0]!.finding).toBe('breach');
  });

  it('lets the merged ceiling bind when trunk moved the ceiling itself', () => {
    // A budget the branch measured against is as capable of going stale as the
    // dataset is. The merged ceiling is the one that will be enforced.
    const verdict = decide(
      measurement({ 'picker.totalBytes': [10_500, 11_264] }),
      measurement({ 'picker.totalBytes': [10_500, 10_240] }),
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.ceilingChanges).toHaveLength(1);
    expect(verdict.ceilingChanges[0]!.ceilingDelta).toBe(-1_024);
    expect(verdict.metrics[0]!.head!.within).toBe(true);
  });

  it('reports no divergence when trunk has not moved', () => {
    const same = () => measurement({ 'picker.totalBytes': [7_360, ceiling] });
    const verdict = decide(same(), same());

    expect(verdict.exitCode).toBe(0);
    expect(verdict.diverged).toBe(false);
    expect(verdict.metrics[0]!.finding).toBe('unchanged');
    expect(verdict.freed).toEqual([]);
    expect(verdict.consumed).toEqual([]);
  });

  it('carries a metric that only the merged side has', () => {
    // Trunk added a budget this branch never measured. There is no branch-only
    // figure to contrast, and the merged one still binds.
    const verdict = decide(
      measurement({ 'picker.totalBytes': [7_360, ceiling] }),
      measurement({ 'picker.totalBytes': [7_360, ceiling], 'payload.totalBytes': [9, 8] }),
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.breaches[0]!.head).toBeNull();
    expect(verdict.breaches[0]!.valueDelta).toBeNull();
    expect(verdict.breaches[0]!.finding).toBe('breach');
  });
});

describe('what the report says', () => {
  const anchor = anchorFixture;

  it('prints both numbers, labelled, and states the difference', () => {
    const report = render(
      anchor,
      decide(
        measurement({ 'picker.totalBytes': [11_000, 11_264] }),
        measurement({ 'picker.totalBytes': [11_900, 11_264] }),
      ),
      [],
    );

    expect(report).toContain('branch-only');
    expect(report).toContain('MERGED');
    // Both figures, and the difference stated rather than left to be inferred.
    expect(report).toContain('11,000');
    expect(report).toContain('11,900');
    expect(report).toContain('value +900');
    expect(report).toContain('OVER BUDGET ON THE MERGE.');
    expect(report).toContain('within budget on this branch alone');
    // The anchor is shown, because a reader has to be able to see which commit
    // the branch-only figure was taken at.
    expect(report).toContain('cccccccccc');
    expect(report).toContain('2 commit(s) ahead of the anchor');
  });

  it('names freed headroom as advice rather than as a failure', () => {
    const report = render(
      anchor,
      decide(
        measurement({ 'picker.totalBytes': [11_219, 11_264] }),
        measurement({ 'picker.totalBytes': [7_556, 11_264] }),
      ),
      [],
    );

    expect(report).toContain('FREED headroom');
    expect(report).toContain('advice, not a failure');
    expect(report).not.toContain('OVER BUDGET');
    expect(report).toContain('do not cut scope against the smaller number');
  });

  it('says plainly that uncommitted work is in neither figure', () => {
    const report = render(
      anchor,
      decide(
        measurement({ 'picker.totalBytes': [7_360, 11_264] }),
        measurement({ 'picker.totalBytes': [7_360, 11_264] }),
      ),
      [' M web/src/data/releases.json'],
    );

    expect(report).toContain('uncommitted change(s) under web/ are in NEITHER figure');
    expect(report).toContain('web/src/data/releases.json');
  });
});

describe('the single-tree report', () => {
  it('marks a breached figure as over and a fitting one as ok', () => {
    const rendered = renderMeasurement(measurement({
      'picker.totalBytes': [11_900, 11_264],
      'payload.totalBytes': [116_650, 143_360],
    }));

    expect(rendered).toContain('OVER picker index, total');
    expect(rendered).toContain('636 over');
    expect(rendered).toContain('ok   /compare payload, total');
    expect(rendered).toContain('26,710 spare');
  });
});

// ---------------------------------------------------------------------------
// Which subject a figure belongs to (issue #693).
//
// The picker ceilings guard an artefact nothing ships, and the cost of that
// going unsaid is measured: three 1,024-byte raises, #740's three dropped
// creators and #754 to recover them. So the classification is asserted here in
// both directions — the tag must appear on the unshipped lines, and it must NOT
// appear on the shipped ones, because a label that is always printed carries no
// information and would be read straight past.
//
// Every assertion below is about *what the report says*. None of them touches a
// ceiling or a verdict, and the two tests that pin the verdicts are here to keep
// it that way: an "explanation" that quietly turned a breach into advice would
// be the exact weakening this issue refuses.
// ---------------------------------------------------------------------------

describe('shipped and unshipped subjects are told apart', () => {
  it('classifies every ceiling subject, picker unshipped and payload shipped', () => {
    for (const subject of CEILING_SUBJECTS) {
      expect(typeof subject.shipped, subject.id).toBe('boolean');
      expect(subject.shipped, subject.id).toBe(!subject.id.startsWith('picker.'));
    }
  });

  it('defaults an unclassified metric to shipped, never to unshipped', () => {
    // The unshipped tag is a claim that nobody downloads these bytes, and it is
    // the tag that licenses "do not cut data". Guessing it for a subject nobody
    // classified would excuse a real page-weight breach, so the default runs the
    // other way.
    expect(isShipped({ id: 'something.nobody.classified' })).toBe(true);
    expect(isShipped({ id: 'picker.totalBytes' })).toBe(false);
    expect(isShipped({ id: 'picker.totalBytes', shipped: true })).toBe(true);
  });

  it('tags every line of the single-tree report with which subject it is', () => {
    const rendered = renderMeasurement(measurement({
      'picker.totalBytes': [7_360, 11_264],
      'payload.totalBytes': [111_893, 143_360],
    }));

    expect(rendered).toMatch(/picker index, total.*\[UNSHIPPED/);
    expect(rendered).toMatch(/\/compare payload, total.*\[shipped\]/);
  });

  it('prints the escalation on an unshipped breach and not on a shipped one', () => {
    const pickerOver = renderMeasurement(measurement({ 'picker.totalBytes': [11_900, 11_264] }));
    const payloadOver = renderMeasurement(measurement({ 'payload.totalBytes': [150_000, 143_360] }));
    const nothingOver = renderMeasurement(measurement({ 'picker.totalBytes': [7_360, 11_264] }));

    expect(pickerOver).toContain('no production consumer');
    expect(pickerOver).toContain('cutting dataset records');
    expect(pickerOver).toContain('must NOT be resolved by raising the ceiling');
    expect(payloadOver).not.toContain('no production consumer');
    expect(nothingOver).not.toContain('no production consumer');
  });

  it('says which subject each merged row is, and escalates an unshipped breach', () => {
    const report = render(
      anchorFixture,
      decide(
        measurement({ 'picker.totalBytes': [11_000, 11_264] }),
        measurement({ 'picker.totalBytes': [11_900, 11_264] }),
      ),
      [],
    );

    expect(report).toMatch(/picker index, total.*\[UNSHIPPED\]/);
    expect(report).toContain('no production consumer');
    // The reflex this replaces. "Cut scope" is the right advice for the shipped
    // payload and the wrong advice for an artefact nobody downloads.
    expect(report).toContain('Do NOT cut scope');
    expect(report).not.toContain('Cut scope or trim the row shape');
  });

  it('still tells a shipped breach to cut scope, and does not escalate it', () => {
    const report = render(
      anchorFixture,
      decide(
        measurement({ 'payload.totalBytes': [140_000, 143_360] }),
        measurement({ 'payload.totalBytes': [150_000, 143_360] }),
      ),
      [],
    );

    expect(report).toContain('Cut scope or trim the row shape');
    expect(report).not.toContain('no production consumer');
  });

  it('changes no verdict: an unshipped breach is still a breach and still exits 1', () => {
    const verdict = decide(
      measurement({ 'picker.totalBytes': [11_000, 11_264] }),
      measurement({ 'picker.totalBytes': [11_900, 11_264] }),
    );

    expect(verdict.exitCode).toBe(1);
    expect(verdict.breaches).toHaveLength(1);
    expect(verdict.metrics[0]!.merged.within).toBe(false);
  });
});
