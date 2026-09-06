import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRANCHE_CREATORS,
  classifyRunway,
  formatRunwayReport,
  formatTrancheManifest,
  rateOf,
  runwayVerdict,
} from './asset-runway.mjs';

/**
 * The runway reading is only worth anything if it can come back the other way.
 * Every test below that asserts a negative -- "did not refuse", "reported flat"
 * -- is paired with a case that must come back positive from the same function,
 * because a classifier that answers the same thing to everything passes a
 * one-sided test and reports nothing.
 */

const manifest = {
  creators: 3,
  percentile: 75,
  donors: ['a', 'b', 'c'],
  addedRecords: 45,
  added: {},
  clones: [
    { tag: 'rw0', donorId: 'a', records: 15, footprint: { families: 2, releases: 3, sources: 8 } },
    { tag: 'rw1', donorId: 'b', records: 15, footprint: { families: 2, releases: 3, sources: 8 } },
    { tag: 'rw2', donorId: 'c', records: 15, footprint: { families: 2, releases: 3, sources: 9 } },
  ],
};

describe('rateOf', () => {
  it('divides the arm difference by the creators that produced it', () => {
    const row = rateOf('route:home', 1_105_000, 1_060_756, 1_080_799, 3);
    expect(row.delta).toBe(20_043);
    expect(row.perCreator).toBe(6681);
    expect(row.spare).toBe(44_244);
    expect(row.status).toBe('rated');
  });

  it('floors the affordable count, because a fraction of a creator is not writable', () => {
    // 1000 spare at 300 per creator is 3.33 creators; three is what can be written.
    const row = rateOf('f', 2000, 1000, 1300, 1);
    expect(row.affordable).toBe(3);
  });

  it('measures spare against the built arm-A figure, not against a recorded one', () => {
    // If this were computed from anything but `baseline`, a stale record would
    // silently move the runway of a tree nobody is standing in.
    const row = rateOf('f', 1000, 900, 950, 1);
    expect(row.spare).toBe(100);
    expect(row.affordable).toBe(2);
  });

  describe('a flat figure is a measurement, not a gap', () => {
    it('reports arms that agree as flat and not as unmeasured', () => {
      const row = rateOf('global:font', 210_000, 187_036, 187_036, 3);
      expect(row.status).toBe('flat');
      expect(row.affordable).toBeNull();
    });

    it('control: the same function reports a moved figure as rated', () => {
      // Without this arm, `status === 'flat'` above could be a constant.
      const row = rateOf('global:font', 210_000, 187_036, 187_040, 3);
      expect(row.status).toBe('rated');
      expect(row.affordable).not.toBeNull();
    });
  });

  it('treats a shrink between arms as an instrument fault, never as a windfall', () => {
    // Added records cannot make a build smaller. A negative delta would divide
    // into a negative rate and a nonsensically long runway if it were rated.
    const row = rateOf('f', 1000, 900, 880, 3);
    expect(row.status).toBe('shrunk');
    expect(row.affordable).toBeNull();
  });

  it('reports an already-over figure as over rather than as a runway of zero', () => {
    const row = rateOf('f', 1000, 1100, 1200, 3);
    expect(row.status).toBe('over');
    expect(row.spare).toBe(-100);
  });

  it('carries the headroom flag so the near-miss line decides something', () => {
    const near = rateOf('f', 1000, 950, 960, 3);
    const clear = rateOf('f', 1000, 500, 510, 3);
    expect(near.headroom).toBe('near-ceiling');
    expect(clear.headroom).toBe('ok');
  });
});

describe('classifyRunway', () => {
  const at = (spare: number, perCreator: number) =>
    rateOf('f', spare + 1000, 1000, 1000 + perCreator * 3, 3);

  it('refuses a tranche that does not fit', () => {
    expect(classifyRunway(at(1000, 400), 3)).toBe('refused');
  });

  it('control: the same threshold clears a tranche that does fit', () => {
    expect(classifyRunway(at(10_000, 400), 3)).toBe('clear');
  });

  it('flags a figure that affords this tranche but not the next as tight', () => {
    // 2000 spare at 400/creator is 5 creators: enough for 3, not for 6.
    expect(classifyRunway(at(2000, 400), 3)).toBe('tight');
  });

  it('never rounds an undetermined figure into a passing one', () => {
    expect(classifyRunway(rateOf('f', 1000, 900, 880, 3), 3)).toBe('undetermined');
    expect(classifyRunway(rateOf('f', 1000, 900, 900, 3), 3)).toBe('flat');
  });
});

describe('runwayVerdict', () => {
  const rated = (label: string, spare: number, perCreator: number) =>
    rateOf(label, 1000 + spare, 1000, 1000 + perCreator * 3, 3);
  const flat = (label: string) => rateOf(label, 2000, 1000, 1000, 3);

  it('passes when every rated figure affords the request', () => {
    const verdict = runwayVerdict([rated('a', 10_000, 100), flat('b')], 3);
    expect(verdict.code).toBe(0);
    expect(verdict.tally.rated).toBe(1);
    expect(verdict.tally.flat).toBe(1);
  });

  it('exits 1 when a figure cannot take the tranche', () => {
    expect(runwayVerdict([rated('a', 100, 100)], 3).code).toBe(1);
  });

  it('exits 2 when no figure moved, because that is the overlay failing to take', () => {
    // The arms-must-disagree control. Without it, a silently broken overlay
    // reports a wall of zeroes that is indistinguishable from a real pass.
    const verdict = runwayVerdict([flat('a'), flat('b')], 3);
    expect(verdict.code).toBe(2);
    expect(verdict.reason).toContain('did not take');
  });

  it('control: one moved figure among flat ones is enough to answer', () => {
    expect(runwayVerdict([flat('a'), rated('b', 10_000, 100)], 3).code).toBe(0);
  });

  it('exits 2 on a shrink even when other figures refuse, because a fault outranks a finding', () => {
    const verdict = runwayVerdict([rateOf('a', 1000, 900, 880, 3), rated('b', 100, 100)], 3);
    expect(verdict.code).toBe(2);
  });

  it('exits 2 on no figures at all rather than vacuously passing', () => {
    expect(runwayVerdict([], 3).code).toBe(2);
  });

  it('names the figure that runs out first, not the one closest to its ceiling', () => {
    // `slow` is at 95% of its ceiling; `fast` is at 50% and still runs out
    // first. The headroom report ranks these the other way round, and that
    // reordering is the whole reading this instrument adds.
    const slow = rateOf('slow', 1000, 950, 953, 3);
    const fast = rateOf('fast', 1000, 500, 800, 3);
    expect(slow.headroom).toBe('near-ceiling');
    expect(fast.headroom).toBe('ok');
    // Both must be rated for the comparison to mean anything: a null runway
    // would compare as 0 and manufacture the result this test is asserting.
    expect(typeof slow.affordable).toBe('number');
    expect(typeof fast.affordable).toBe('number');
    expect(Number(slow.affordable)).toBeGreaterThan(Number(fast.affordable));
    expect(runwayVerdict([slow, fast], 3).binding.label).toBe('fast');
  });
});

describe('formatRunwayReport', () => {
  const rows = [
    rateOf('route:compare', 820_000, 785_241, 810_963, 3),
    rateOf('global:font', 210_000, 187_036, 187_036, 3),
  ];

  it('states its own denominator so a partial reading cannot read as a whole one', () => {
    const text = formatRunwayReport(rows, manifest, 3).join('\n');
    expect(text).toContain('2 figure(s): 1 rated, 1 flat, 0 undetermined.');
  });

  it('says flat means measured-and-unmoved, which asset-budgets.json cannot say', () => {
    const text = formatRunwayReport(rows, manifest, 3).join('\n');
    expect(text).toContain('flat: measured twice, did not move');
    expect(text).toContain('FLAT is a measurement, not a gap');
  });

  it('prints on a pass as well as a refusal', () => {
    const clear = [rateOf('f', 1_000_000, 1000, 1300, 3)];
    const text = formatRunwayReport(clear, manifest, 3).join('\n');
    expect(text).toContain('ROUTE RUNWAY');
    expect(text).toContain('PASS');
  });

  it('control: a refusal prints the refusal wording and a pass does not', () => {
    const refused = formatRunwayReport([rateOf('f', 1100, 1000, 1300, 3)], manifest, 3).join('\n');
    const passed = formatRunwayReport([rateOf('f', 1_000_000, 1000, 1300, 3)], manifest, 3).join('\n');
    expect(refused).toContain('REFUSED');
    expect(passed).not.toContain('REFUSED');
  });
});

describe('formatTrancheManifest', () => {
  it('names the donors, because a rate whose unit is unstated is not checkable', () => {
    const text = formatTrancheManifest(manifest).join('\n');
    expect(text).toContain('3 creator(s), 45 record(s) added');
    expect(text).toContain('p75 footprint percentile');
    expect(text).toContain('rw0');
  });

  it('says so when donors were named explicitly rather than drawn by percentile', () => {
    const text = formatTrancheManifest({ ...manifest, percentile: null }).join('\n');
    expect(text).toContain('named explicitly');
    expect(text).not.toContain('percentile --');
  });
});

describe('defaults', () => {
  it('asks about a 3-creator tranche, the unit the budget prose already uses', () => {
    expect(DEFAULT_TRANCHE_CREATORS).toBe(3);
  });
});
