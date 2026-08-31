import { describe, expect, it } from 'vitest';
import { dataset, sourceById } from './dataset';

/**
 * Guards the reading a bare context abbreviation is recorded by, the rule set
 * out beside `releaseSchema.contextWindow` in `schema.ts`.
 *
 * The dataset once read "K" two contradictory ways with nothing detecting it:
 * every bare "128k"/"256k" was stored decimally (128000, 256000), while a lone
 * "4K" was stored as 4096 — the binary reading — and no test bound a recorded
 * figure to the abbreviation its source stated (issue #557). The schema's
 * decision is that a bare abbreviation is read decimally by default ("K" = 1000,
 * "M" = 1,000,000), and the binary reading is taken only where the source itself
 * fixes a binary buffer, in which case the record's note must make that reading
 * explicit — stating the resulting figure and the basis for it, so the reading
 * is legible rather than silent.
 *
 * This test detects the shape that decision forbids leaving silent: a
 * `contextWindow` equal to the *binary* (x1024) expansion of a bare abbreviation
 * in the record's own notes, where the decimal reading would have given a
 * different number and the notes never state the resulting integer at all. That
 * was the `upstage` "4K" -> 4096 pattern before its note recorded the 4096 and
 * the Phi-3-4K lineage behind it. A record that states its integer in the note
 * (as `upstage` now does, and as any record quoting an exact figure does) is not
 * silent and is not flagged; a new binary reading added with no such note is.
 *
 * The classifier keys on the recorded value and the abbreviations in the notes,
 * never on prose alone, so unrelated abbreviations do not trip it — MiniMax's
 * "M1-40k"/"M1-80k" build names sit beside a 1,000,000-token window and are
 * ignored because neither 40000/40960 nor 80000/81920 equals the recorded value.
 * Keeping the stated-integer test is what stops a route-1 record from being
 * flagged: Granite stores an exactly stated 131072 whose notes also contain
 * "128K" (128 x 1024 = 131072), and only the stated 131072 keeps it clear.
 */

interface Reading {
  decimalHit?: string;
  binaryHit?: string;
  integerStated: boolean;
}

const BARE_ABBR = /(\d[\d.,]*)\s*([kKmM])\b/g;

function notesFor(sourceIds: readonly string[]): string {
  return sourceIds
    .map((id) => sourceById.get(id)?.notes ?? '')
    .join(' \u0000 ');
}

function statesInteger(text: string, value: number): boolean {
  const plain = String(value);
  const commas = value.toLocaleString('en-US').replace(/,/g, '\\,');
  return new RegExp(`(?<![\\d.,])(?:${plain}|${commas})(?![\\d.,])`).test(text);
}

/** How a recorded contextWindow relates to the abbreviations and integers in its notes. */
function readingOf(contextWindow: number, notes: string): Reading {
  let decimalHit: string | undefined;
  let binaryHit: string | undefined;
  for (const match of notes.matchAll(BARE_ABBR)) {
    const n = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const unit = match[2].toLowerCase();
    const decimal = unit === 'k' ? n * 1000 : n * 1_000_000;
    const binary = unit === 'k' ? n * 1024 : n * 1024 * 1024;
    if (decimal === contextWindow) decimalHit = `${match[1]}${match[2]}`;
    if (binary === contextWindow) binaryHit = `${match[1]}${match[2]}`;
  }
  return { decimalHit, binaryHit, integerStated: statesInteger(notes, contextWindow) };
}

/**
 * A record whose value is the binary reading of a bare abbreviation, the decimal
 * reading would differ, and the notes never state the resulting integer — the
 * silent contradiction #557 was filed about.
 */
function isSilentBinaryReading(reading: Reading): boolean {
  return Boolean(reading.binaryHit) && !reading.decimalHit && !reading.integerStated;
}

describe('context window abbreviations read one way', () => {
  it('leaves no bare abbreviation silently read in the binary sense', () => {
    const offenders = dataset.releases
      .filter((release) => typeof release.contextWindow === 'number')
      .map((release) => ({
        id: release.id,
        contextWindow: release.contextWindow as number,
        reading: readingOf(release.contextWindow as number, notesFor(release.sourceIds)),
      }))
      .filter((row) => isSilentBinaryReading(row.reading));

    expect(
      offenders,
      'a contextWindow equals the binary (x1024) expansion of a bare abbreviation in its notes, '
      + 'the decimal reading would differ, and no note states the resulting integer. Read the '
      + 'abbreviation decimally, or — only where the source itself fixes a binary size — record the '
      + 'figure and its basis in a source note so the reading is explicit rather than silent.',
    ).toEqual([]);
  });

  it('keeps the one binary-read record (Solar Pro Preview) explicit and evidenced', () => {
    // upstage stores 4096 for a card that states only "4K". The value stands —
    // the card's own Phi-3-medium-4K comparison fixes the binary buffer — but the
    // reading must not go silent again: its note has to carry both the figure and
    // the lineage that licenses it, which is what keeps it out of the test above.
    const solar = dataset.releases.find((release) => release.id === 'upstage-solar-pro-preview-instruct');
    expect(solar, 'the Solar Pro Preview release this rule was written around is gone; re-point or drop this test')
      .toBeDefined();
    if (!solar) return;

    expect(solar.contextWindow, 'Solar Pro Preview no longer stores 4096; re-read its card before changing this')
      .toBe(4096);

    const notes = notesFor(solar.sourceIds);
    expect(notes, 'the Solar Pro Preview note no longer states the 4096 its 4K resolves to').toMatch(/4096/);
    expect(notes, 'the Solar Pro Preview note no longer states the Phi-3 lineage that fixes the binary reading')
      .toMatch(/Phi-3/);
    expect(
      isSilentBinaryReading(readingOf(4096, notes)),
      'the Solar Pro Preview note has gone silent on its integer again and would now trip the detector',
    ).toBe(false);
  });

  it('classifies the shapes it is meant to, and no others (control)', () => {
    // A fabricated "8K" that maps to the binary 8192 with no stated integer must be caught...
    expect(
      isSilentBinaryReading(readingOf(8192, 'a maximum context length of 8K and nothing more precise')),
    ).toBe(true);
    // ...while the same "8K" read decimally to 8000 must not be...
    expect(
      isSilentBinaryReading(readingOf(8000, 'a maximum context length of 8K and nothing more precise')),
    ).toBe(false);
    // ...nor a note that states the exact integer, even though 8192 also equals 8 x 1024...
    expect(
      isSilentBinaryReading(readingOf(8192, 'a context window of 8K, recorded as 8192 tokens')),
    ).toBe(false);
    // ...nor an unrelated build-name abbreviation beside a different window (the MiniMax shape).
    expect(
      isSilentBinaryReading(readingOf(1_000_000, 'MiniMax-M1-40k and M1-80k, both a 1M context window')),
    ).toBe(false);
  });
});
