import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards `asset-budgets.json`'s prose against withdrawal-by-quotation (issue #1068).
 *
 * These `reason` fields are append-only narrative, and the append that withdraws an
 * earlier claim used to do it by QUOTING the claim it withdrew. That inverts the
 * cheapest available signal: the claim string then occurs twice, the second
 * occurrence IS its refutation, and a reader who greps the field and finds two hits
 * reads corroboration where the text holds a claim and its retraction.
 *
 * It is not hypothetical. The #820 dock proposed `/compare` payload projection as
 * follow-on work because the `reason` field "names itself as the same candidate
 * twice" -- a reading faithful to the text and wrong about the world, since #967
 * established that `/compare` has shipped a projected payload since #492, so the
 * saving was never available. That dock had, in the same message, correctly warned
 * about a structurally identical trap elsewhere. Being caught by the class you just
 * named is evidence the defect belongs to the artifact, not to the reader.
 *
 * The convention this enforces is that a superseded claim is marked WHERE IT IS
 * STATED, as `[SUPERSEDED by #N on YYYY-MM-DD: <the original claim, verbatim>]`,
 * rather than being left bare for a later paragraph to contradict. The history
 * survives, it carries a source and a verification date, and the later correction no
 * longer needs to re-quote the claim -- which is what removes the long verbatim
 * repeat that this file measures.
 *
 * Two things are asserted, and they fail independently:
 *
 *   A. No prose field contains a long verbatim self-repeat. This is the MECHANICAL
 *      signature of withdraw-by-quoting, and it is what stops the next append from
 *      recreating the defect. Marker prefixes are normalised away first, so the
 *      convention cannot trip its own guard.
 *   B. Every `[SUPERSEDED ...]` marker is well-formed -- issue reference, ISO date,
 *      and a closing bracket -- so a marker cannot decay into unattributed prose.
 *
 * Both are proved by mutation at the bottom of this file rather than by a green
 * suite: a check that has never been shown to refuse anything has not been shown to
 * do anything. Every control is two-sided.
 *
 * This file reads the JSON only. It runs no build, so it stays in milliseconds and
 * does not belong in `tests/build/asset-budgets.test.ts`, which builds the site.
 *
 * SCOPE, stated so a later reader does not over-read the guard: this does NOT make
 * the fields non-append-only. They are still single strings and can still be
 * appended to. What is closed is the one recreation path -- an append that withdraws
 * an earlier claim by quoting it now reddens here. An append stating new facts is
 * unaffected, and should be.
 */

/**
 * Longest verbatim self-repeat tolerated inside one prose field, in characters.
 *
 * Chosen from the measured distribution rather than picked round. At the time of
 * writing, with the #1068 rewrite applied, the largest self-repeat anywhere in the
 * file is 52 characters -- `". Ceiling unchanged and NOT raised; +4.4% headroom. "`
 * in the `/compare` entry, which is innocent re-record boilerplate. The defect this
 * guard exists to catch measured 100 characters in that same field: the projection
 * claim, quoted a second time in order to be refuted 3,753 characters later.
 *
 * 72 sits between them with margin on both sides -- 20 characters above the largest
 * innocent repeat, 28 below the defect. Raising this to accommodate a failure is
 * almost always the wrong fix: the boilerplate that approaches it is a sentence
 * template, whereas a claim quoted to be withdrawn is a clause with content.
 */
const MAX_VERBATIM_REPEAT = 72;

/** `[SUPERSEDED by #967 on 2026-09-06: <claim>]` -- source and verification date. */
const WELL_FORMED_MARKER = /\[SUPERSEDED by #\d+ on \d{4}-\d{2}-\d{2}: [^\]]+\]/g;

/** Anything that opens a marker, well-formed or not. Used to catch malformed ones. */
const MARKER_OPENER = /\[SUPERSEDED/g;

type ProseField = { readonly name: string; readonly text: string };

/**
 * Every human-readable field in the file, named so a failure says which one.
 *
 * Enumerated structurally rather than by walking for strings, so a new prose field
 * added elsewhere in the document is NOT silently covered -- an unguarded field that
 * looks guarded is the failure mode this whole file is about.
 */
export function proseFields(budgets: any): ProseField[] {
  const out: ProseField[] = [];
  const push = (name: string, text: unknown) => {
    if (typeof text === 'string' && text.length > 0) out.push({ name, text });
  };

  push('$schema-note', budgets['$schema-note']);
  push('headroom-note', budgets['headroom-note']);
  push('drift-note', budgets['drift-note']);
  push('measuredDrift.reason', budgets.measuredDrift?.reason);
  push('globals.reason', budgets.globals?.reason);
  (budgets.fixedRoutes ?? []).forEach((r: any, i: number) =>
    push(`fixedRoutes[${i}] (${r?.id}).reason`, r?.reason),
  );
  (budgets.routeGroups ?? []).forEach((r: any, i: number) =>
    push(`routeGroups[${i}] (${r?.id}).reason`, r?.reason),
  );
  (budgets.excludedFromRouteTotals ?? []).forEach((r: any, i: number) =>
    push(`excludedFromRouteTotals[${i}].reason`, r?.reason),
  );

  return out;
}

/**
 * Collapse marker PREFIXES to a constant before measuring repeats.
 *
 * Two markers citing the same issue on the same date share 36 verbatim characters,
 * which is a property of the convention and not a quoted claim. Without this, adding
 * a second marker to a field would push it toward a threshold that exists to catch
 * something else entirely -- the guard would fire on its own remedy.
 */
export function normaliseMarkers(text: string): string {
  return text.replace(/\[SUPERSEDED by #\d+ on \d{4}-\d{2}-\d{2}: /g, '[S: ');
}

/**
 * Longest substring occurring at least twice in `text`, occurrences non-overlapping.
 *
 * Binary search on length: if a repeat of length n exists then one of length n-1
 * does too, so the predicate is monotonic and the search is sound.
 */
export function longestRepeat(text: string): { len: number; text: string; at: number[] } {
  const findAt = (n: number) => {
    const seen = new Map<string, number>();
    for (let i = 0; i + n <= text.length; i += 1) {
      const sub = text.slice(i, i + n);
      const prev = seen.get(sub);
      if (prev !== undefined && i - prev >= n) return { text: sub, at: [prev, i] };
      if (prev === undefined) seen.set(sub, i);
    }
    return null;
  };

  let lo = 1;
  let hi = Math.floor(text.length / 2);
  let best = { len: 0, text: '', at: [] as number[] };
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const hit = findAt(mid);
    if (hit) {
      best = { len: mid, text: hit.text, at: hit.at };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Marker openers that are not well-formed markers. Empty means the field is clean. */
export function malformedMarkers(text: string): string[] {
  const wellFormed = new Set<number>();
  for (const m of text.matchAll(WELL_FORMED_MARKER)) wellFormed.add(m.index ?? -1);

  const bad: string[] = [];
  for (const m of text.matchAll(MARKER_OPENER)) {
    const at = m.index ?? -1;
    if (!wellFormed.has(at)) bad.push(text.slice(at, at + 90));
  }
  return bad;
}

const budgets = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../asset-budgets.json', import.meta.url)), 'utf8'),
);

describe('asset-budgets prose does not withdraw its own claims by quoting them', () => {
  const fields = proseFields(budgets);

  it('finds prose fields to measure at all', () => {
    // Without this, an enumeration that silently returned nothing would let every
    // assertion below pass while measuring no text -- "did not look" wearing the
    // clothes of "looked and found nothing".
    expect(fields.length).toBeGreaterThan(10);
  });

  it.each(fields.map((f) => [f.name, f.text] as const))(
    'has no long verbatim self-repeat: %s',
    (name, text) => {
      const repeat = longestRepeat(normaliseMarkers(text));
      expect(
        repeat.len,
        `${name} repeats ${repeat.len} characters verbatim at offsets ` +
          `[${repeat.at.join(', ')}]:\n\n  ${JSON.stringify(repeat.text)}\n\n` +
          'That is the mechanical signature of withdrawing a claim by quoting it ' +
          '(issue #1068), which inverts occurrence-counting for every later reader. ' +
          'Mark the claim where it is STATED as ' +
          '`[SUPERSEDED by #N on YYYY-MM-DD: <claim verbatim>]` and let the later ' +
          'correction state the current truth WITHOUT re-quoting it. Raising ' +
          `MAX_VERBATIM_REPEAT (${MAX_VERBATIM_REPEAT}) is the wrong fix unless the ` +
          'repeat is genuinely a sentence template rather than a claim.',
      ).toBeLessThan(MAX_VERBATIM_REPEAT);
    },
  );

  it.each(fields.map((f) => [f.name, f.text] as const))(
    'has only well-formed supersession markers: %s',
    (name, text) => {
      expect(
        malformedMarkers(text),
        `${name} contains a supersession marker that is not well-formed. Every ` +
          'marker must read `[SUPERSEDED by #N on YYYY-MM-DD: <claim>]` -- a ' +
          'superseding issue, an ISO verification date, and a closing bracket -- so ' +
          'that a withdrawn claim never decays into unattributed prose.',
      ).toEqual([]);
    },
  );

  it('actually carries supersession markers, so the well-formedness arm is live', () => {
    // The assertion above is satisfied vacuously by a file with no markers at all.
    // This is its positive control: the real file must contain some.
    const total = fields.reduce(
      (n, f) => n + [...f.text.matchAll(WELL_FORMED_MARKER)].length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});

// --- The checks above, proved by mutation ------------------------------------
//
// A guard that has only ever been observed to pass is indistinguishable from one
// that cannot fail. Each arm below is two-sided: an input the check MUST refuse and
// an input it MUST accept, evaluated together, so a detector that answered the same
// thing to everything would be caught here rather than in production.

describe('the guard refuses the right things', () => {
  const nonce = `zzz-nonce-${Math.random().toString(36).slice(2, 12)}`;

  describe('long verbatim self-repeat', () => {
    const claim =
      'this route still inlines whole records into island props and is a candidate for the same projection';

    // Deliberately NON-repeating filler. An earlier draft of this file used
    // `'...'.repeat(20)`, which is itself a colossal verbatim self-repeat: it would
    // have dominated every measurement below, passing the CATCHES arm for a reason
    // unrelated to the claim and failing the ACCEPTS arm outright. A control whose
    // padding is the thing under test measures nothing.
    const filler = Array.from(
      { length: 20 },
      (_, i) => `Intervening sentence ${i} is unique.`,
    ).join(' ');

    it('CATCHES a claim quoted a second time in order to be withdrawn', () => {
      const withdrawnByQuoting =
        `Measured at some anchor. ${claim}; out of scope. ${filler} ` +
        `The earlier claim that ${claim} is false, and a later issue corrects it.`;
      expect(longestRepeat(normaliseMarkers(withdrawnByQuoting)).len).toBeGreaterThanOrEqual(
        MAX_VERBATIM_REPEAT,
      );
    });

    it('ACCEPTS the same claim marked where it is stated and not re-quoted', () => {
      const markedInPlace =
        `Measured at some anchor. [SUPERSEDED by #967 on 2026-09-06: ${claim}; out of scope.] ` +
        `${filler} ` +
        'The projection claim marked superseded above is false, and a later issue corrects it.';
      expect(longestRepeat(normaliseMarkers(markedInPlace)).len).toBeLessThan(
        MAX_VERBATIM_REPEAT,
      );
    });

    it('ACCEPTS ordinary re-record boilerplate, which repeats by template', () => {
      const boilerplate =
        'Re-measured 749971 at 8e8ae6f9. Absorbed by headroom, ceiling unchanged. +9.3% headroom. ' +
        `Re-recorded 766171 at 34e78d1a for ${nonce}. Absorbed by headroom, ceiling unchanged. +6.6% headroom.`;
      expect(longestRepeat(normaliseMarkers(boilerplate)).len).toBeLessThan(
        MAX_VERBATIM_REPEAT,
      );
    });

    it('is NOT blinded by the marker normalisation it applies', () => {
      // Two markers citing the same issue and date must not be enough to trip the
      // repeat check, and normalisation must not erase a real quoted claim that
      // happens to sit inside one.
      const twoMarkers =
        `[SUPERSEDED by #967 on 2026-09-06: first withdrawn claim about ${nonce}.] ` +
        'Some intervening prose that differs entirely from everything else here. ' +
        '[SUPERSEDED by #967 on 2026-09-06: second withdrawn claim, unrelated wording.]';
      expect(longestRepeat(normaliseMarkers(twoMarkers)).len).toBeLessThan(
        MAX_VERBATIM_REPEAT,
      );

      const quotedInsideMarker =
        `[SUPERSEDED by #967 on 2026-09-06: ${claim}.] and later, plainly, ${claim}.`;
      expect(longestRepeat(normaliseMarkers(quotedInsideMarker)).len).toBeGreaterThanOrEqual(
        MAX_VERBATIM_REPEAT,
      );
    });
  });

  describe('marker well-formedness', () => {
    it('ACCEPTS a well-formed marker', () => {
      expect(malformedMarkers('[SUPERSEDED by #967 on 2026-09-06: a withdrawn claim.]')).toEqual(
        [],
      );
    });

    it('ACCEPTS prose whose only brackets are not markers', () => {
      // `providers/[slug].astro` and array literals appear legitimately in this file.
      expect(malformedMarkers('#675 changed providers/[slug].astro and emitted [0,"x"].')).toEqual(
        [],
      );
    });

    it('CATCHES a marker with no superseding issue', () => {
      expect(malformedMarkers('[SUPERSEDED by 967 on 2026-09-06: a claim.]')).toHaveLength(1);
    });

    it('CATCHES a marker with a non-ISO date', () => {
      expect(malformedMarkers('[SUPERSEDED by #967 on 06-09-2026: a claim.]')).toHaveLength(1);
    });

    it('CATCHES a marker with no date at all', () => {
      expect(malformedMarkers('[SUPERSEDED by #967: a claim.]')).toHaveLength(1);
    });

    it('CATCHES an unterminated marker', () => {
      expect(
        malformedMarkers(
          `[SUPERSEDED by #967 on 2026-09-06: a claim about ${nonce} that never closes`,
        ),
      ).toHaveLength(1);
    });

    it('CATCHES an empty claim body', () => {
      expect(malformedMarkers('[SUPERSEDED by #967 on 2026-09-06: ]')).toHaveLength(1);
    });
  });

  describe('the field enumeration', () => {
    it('names every prose field it finds, and finds none in an empty document', () => {
      expect(proseFields({})).toEqual([]);
      const found = proseFields({
        'drift-note': 'x',
        fixedRoutes: [{ id: 'home', reason: 'y' }],
        globals: { reason: 'z' },
      }).map((f) => f.name);
      expect(found).toEqual(['drift-note', 'globals.reason', 'fixedRoutes[0] (home).reason']);
    });
  });
});
