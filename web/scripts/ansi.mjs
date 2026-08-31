// Removes ANSI escape sequences from text captured off a child process, so an
// assertion can be made about what a command *said* rather than how a terminal
// was asked to paint it.
//
// This exists because of a failure that was invisible locally and red on CI.
// `run-tests.test.ts` asserted `toContain('Test Files  1 passed (1)')`. On CI
// vitest emitted:
//
//     \u001B[2m Test Files \u001B[22m \u001B[1m\u001B[32m1 passed\u001B[...
//
// with the colour codes *between* `Test Files ` and `1 passed`, so the literal
// substring was genuinely absent and `toContain` was right to fail.
//
// The reason it passed locally is worth writing down, because it is the part
// that made the whole local verification set structurally blind. vitest calls
// tinyrainbow's `disableDefaultColors()` when std-env reports `isAgent`, and
// std-env reports that whenever an agent variable such as `AI_AGENT` is in the
// environment. A coding agent's shell sets one; a CI runner does not. So the
// same child emitted plain text here and coloured text there, and `npm run
// validate` and `ci-preflight.mjs` -- which both run in the local environment
// -- could not have caught it. Only a normalising step makes the assertion say
// the same thing in both places.
//
// Stripping is preferred over spawning the child with colour forced off. Colour
// is what CI actually produces, so suppressing it would leave the real
// condition untested and merely move the divergence somewhere quieter; the
// content assertions stay exact either way, which is the property that matters.

/**
 * The escape sequences a terminal-aware CLI emits. Three shapes, because
 * matching only the colour ones would leave a cursor movement or a hyperlink
 * embedded in the middle of a phrase under test:
 *
 *   - CSI  `ESC [` params intermediates final -- colours (`[32m`), and also
 *     erase and cursor codes (`[2K`, `[1G`) that a progress display emits.
 *   - OSC  `ESC ]` ... `BEL` or `ESC \` -- hyperlinks and window titles.
 *   - Fe   `ESC` followed by one byte in `@`-`_` -- the two-character escapes.
 *
 * Deliberately anchored on `ESC`: nothing without one can match, so this cannot
 * eat ordinary text, and in particular cannot eat the digits and parentheses
 * that the counts under test are made of.
 */
export const ANSI_PATTERN =
  /\u001B(?:\[[0-9;:?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\)|[@-Z\\-_])/gu;

/**
 * The same text with any escape sequence removed.
 *
 * @param {string} value text captured from a child's stdout or stderr
 * @returns {string} the text a reader would see, with no escapes in it
 */
export function stripAnsi(value) {
  // A fresh lastIndex every call: the pattern is global, and a shared global
  // regex carries state between `.test()`/`.exec()` calls. `.replace()` resets
  // it, but reading the export elsewhere should not depend on that.
  ANSI_PATTERN.lastIndex = 0;
  return value.replace(ANSI_PATTERN, '');
}

/**
 * Whether the text carries any escape sequence at all.
 *
 * Used by the tests as a live control on themselves: an assertion that some
 * literal survives stripping proves nothing if the input was never coloured, so
 * the coloured cases assert this first and fail loudly rather than passing
 * vacuously when colour turns out to be off.
 *
 * @param {string} value text captured from a child's stdout or stderr
 * @returns {boolean} true when at least one escape sequence is present
 */
export function hasAnsi(value) {
  ANSI_PATTERN.lastIndex = 0;
  return ANSI_PATTERN.test(value);
}

/**
 * Environment variables that make std-env report `isAgent`, which makes vitest
 * turn colour off. Cleared by the tests that need to observe the coloured path
 * that CI produces, so the reproduction does not depend on who is running it.
 *
 * Mirrors std-env's detection list. If it drifts, the test that clears these
 * asserts colour was actually produced, so drift surfaces as a red rather than
 * as a case that quietly stopped testing anything.
 */
export const AGENT_ENV_KEYS = Object.freeze([
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'REPL_ID',
  'GEMINI_CLI',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'OPENCODE',
  'AUGMENT_AGENT',
  'GOOSE_PROVIDER',
  'JUNIE_DATA',
  'JUNIE_SHIM_PATH',
  'CURSOR_AGENT',
]);
