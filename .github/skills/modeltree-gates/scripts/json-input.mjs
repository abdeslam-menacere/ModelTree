// Reading a JSON file that the *caller* handed a gate, and saying something a
// reader can act on when it will not parse.
//
// Both halves of this file are about the bytes of an input, never about what a
// gate accepts. Nothing here inspects a claim, a date, a source or a record, and
// nothing here can turn a refusal into a pass: `JSON.parse` still decides, and
// the exit code a caller reads is still produced at the call site. That
// separation is the point. The gates' whole value rests on 2 never being a pass
// (`SKILL.md`), so a change in this area has to be provably incapable of
// widening a rule.
//
// ---------------------------------------------------------------------------
// The decision, recorded here because five call sites have to agree (#1017)
// ---------------------------------------------------------------------------
//
// **A single leading U+FEFF is stripped before parsing. Everything else is
// refused exactly as before.**
//
// The alternative -- refuse the BOM too, with a diagnostic naming the encoding
// -- was available and is rejected on cost. The character is written by the
// idiomatic PowerShell command on the platform every dock in this repository
// runs on: under PowerShell 5.1, `Set-Content -Encoding utf8` emits `EF BB BF`
// and `[System.IO.File]::WriteAllText(p, s, UTF8Encoding($false))` does not, and
// the two files are otherwise byte-identical. Refusing would have been correct
// and would still have cost every such author a cycle, because the file is
// valid in every editor that opens it. Accepting is also what every other
// consumer of the same bytes already does: a BOM is legal at the head of a UTF-8
// stream, `git` transcodes it, ripgrep transcodes it, and only
// `readFileSync(..., 'utf8')` hands it through to `JSON.parse` verbatim -- which
// is #1021's point that "is this file corrupt?" has no answer until you name the
// consumer.
//
// **Exactly one, and only at position 0.** This is a stripping rule, not a
// tolerance. A second BOM is content by the time the first has gone, so it still
// fails; a BOM anywhere but position 0 is untouched; no whitespace, no comments,
// no trailing commas and no other encoding are forgiven. `readJsonInput` removes
// three bytes from one position or it removes nothing, and what reaches
// `JSON.parse` after that is the caller's file.
//
// **It cannot change a verdict.** A file with no BOM takes the identical path it
// took before -- `text.charCodeAt(0)` is not U+FEFF, `text` is passed through
// unchanged, `JSON.parse` sees the same string. A file with one gains a verdict
// it could not previously reach, and that verdict is whatever the gate would
// have returned for the same bytes without the BOM. There is no third case.
//
// ---------------------------------------------------------------------------
// Why the diagnostic is escaped as well
// ---------------------------------------------------------------------------
//
// Stripping the BOM removes the common cause; it does not make the *next*
// refusal readable. `JSON.parse` quotes the offending character into its own
// message, so a zero-width character arrives at a terminal as nothing at all and
// the gate appears to blame an empty token:
//
//   gate-evidence: <path> is not valid JSON: Unexpected token '', "{ ... is not valid JSON
//
// The quotes in that line are not empty. They contain U+FEFF. A reader whose
// file opens correctly everywhere has no visible signal, and the exit code
// cannot help -- on the `--claims` path a missing flag, an absent file and
// unparseable bytes all return 2, and the encoding case is the only one of the
// three a careful author hits while believing they did everything right.
//
// So every interpolated parse message is rendered through `escapeInvisible`
// first. This is a rendering rule for a diagnostic and touches no value any gate
// reads: invisible characters inside creator ids, quotes and claim text are a
// different position with a different fix, already pinned by the `INVISIBLE`
// property test in `gates.test.mjs` and tracked as #331.

import { readFileSync } from 'node:fs';

/** U+FEFF, as a code point rather than as a literal nobody reviewing this could see. */
const BYTE_ORDER_MARK = 0xfeff;

/**
 * Characters that reach a terminal as nothing, or as something they are not.
 *
 * The ranges, in order: C0 controls; DEL, the C1 controls and U+00A0 NO-BREAK
 * SPACE, which is a space that is not one; U+00AD SOFT HYPHEN; U+061C ARABIC
 * LETTER MARK; U+200B-U+200F, the zero-width and directional marks; U+2028 and
 * U+2029, the separators that end a line for a parser and not for a reader;
 * U+202A-U+202E, the bidi embeddings and overrides; U+2060-U+2064, the word
 * joiner and the invisible operators; U+2066-U+2069, the bidi isolates; and
 * U+FEFF itself.
 *
 * Three of these -- U+200B, U+202E and U+FEFF -- are exactly the class
 * `gates.test.mjs` already names as "the four id values this repository has met
 * that no reader can tell from another". The fourth of those is the empty
 * string, which is not a character and needs no escape.
 */
const INVISIBLE = /[\u0000-\u001F\u007F-\u00A0\u00AD\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** The three whose conventional escape reads better than their code point. */
const NAMED = new Map([['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t']]);

/**
 * `text` with every invisible or ambiguous character replaced by an escape a
 * reader can see and type. Visible characters are returned untouched, so an
 * ordinary diagnostic reads exactly as it did before.
 *
 * Newline, carriage return and tab are escaped too. That is deliberate rather
 * than incidental: `JSON.parse` embeds a snippet of the offending file in its
 * message, so an unescaped newline splits one diagnostic across two lines and
 * the second half arrives with no gate name on it.
 */
export function escapeInvisible(text) {
  return String(text).replace(INVISIBLE, (ch) => NAMED.get(ch)
    ?? `\\u${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * Parse a JSON file supplied by the caller, forgiving one leading U+FEFF and
 * nothing else.
 *
 * Throws whatever `readFileSync` or `JSON.parse` throws, unchanged and
 * uncaught: each call site already has a refusal shaped the way its own gate
 * reports, and a helper that swallowed the error would have to invent one.
 * Render the caught `error.message` through `escapeInvisible` before printing
 * it.
 */
export function readJsonInput(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
}
