// Pins the ANSI stripper that the process-level tests in this directory run
// their captured output through.
//
// The stripper exists because of a real CI failure (#601): vitest colourises on
// a CI runner and not under a coding agent, so `toContain('Test Files  1 passed
// (1)')` was true here and false there. The fixtures below are the actual bytes
// from that failure, not invented ones.
//
// Every case that asserts a literal survives stripping first asserts the input
// was coloured at all. Without that, a stripper that matched nothing -- the
// classic dead regex -- would pass every test in this file, because a plain
// string trivially "still contains" its own text after a no-op replace.

import { describe, expect, it } from 'vitest';

import { AGENT_ENV_KEYS, ANSI_PATTERN, hasAnsi, stripAnsi } from './ansi.mjs';

/**
 * The line vitest wrote on the CI runner when `web-ci` failed, transcribed from
 * the raw log with escapes intact. The codes sit between `Test Files ` and
 * `1 passed`, which is precisely why the literal substring was absent.
 */
const CI_TEST_FILES_LINE =
  '\u001B[2m Test Files \u001B[22m \u001B[1m\u001B[32m1 passed\u001B[31m\u001B[22m\u001B[90m (1)\u001B[39m';

/** The same line reproduced locally by removing `AI_AGENT` from the child. */
const REPRODUCED_TEST_FILES_LINE =
  '\u001B[2m Test Files \u001B[22m \u001B[1m\u001B[32m1 passed\u001B[39m\u001B[22m\u001B[90m (1)\u001B[39m';

/** astro's own colouring, measured from `run-check.mjs` with colour forced on. */
const ASTRO_RESULT_LINE = '\u001B[1mResult (194 files): \u001B[22m';
const ASTRO_DIAGNOSTICS_LINE =
  '\u001B[2m21:31:16\u001B[22m \u001B[34m[check]\u001B[39m Getting diagnostics for Astro files';

describe('the escape stripper', () => {
  // The control on every other case in this file. If these fixtures were not
  // actually coloured, "the literal survives" would be a statement about plain
  // text and would hold for a stripper that did nothing at all.
  it.each([
    ['the CI failure', CI_TEST_FILES_LINE],
    ['the local reproduction', REPRODUCED_TEST_FILES_LINE],
    ['astro result', ASTRO_RESULT_LINE],
    ['astro diagnostics', ASTRO_DIAGNOSTICS_LINE],
  ])('has a fixture for %s that really does carry escapes', (_label, fixture) => {
    expect(fixture).toContain('\u001B');
    expect(hasAnsi(fixture)).toBe(true);
    // The stripper must be doing work on it, not returning its input.
    expect(stripAnsi(fixture)).not.toBe(fixture);
  });

  // The assertion CI made, on the bytes CI produced.
  it('recovers the exact literal that CI reported missing', () => {
    expect(CI_TEST_FILES_LINE).not.toContain('Test Files  1 passed (1)');
    expect(stripAnsi(CI_TEST_FILES_LINE)).toContain('Test Files  1 passed (1)');
    expect(stripAnsi(CI_TEST_FILES_LINE)).toBe(' Test Files  1 passed (1)');
  });

  it('recovers the same literal from the locally reproduced line', () => {
    expect(REPRODUCED_TEST_FILES_LINE).not.toContain('Test Files  1 passed (1)');
    expect(stripAnsi(REPRODUCED_TEST_FILES_LINE)).toBe(' Test Files  1 passed (1)');
  });

  it('leaves astro output readable as the phrases the check tests assert on', () => {
    expect(stripAnsi(ASTRO_RESULT_LINE)).toBe('Result (194 files): ');
    expect(stripAnsi(ASTRO_DIAGNOSTICS_LINE)).toBe(
      '21:31:16 [check] Getting diagnostics for Astro files',
    );
  });

  // The counts are the entire subject of the tests this serves, so a stripper
  // that ate a digit or a bracket would silently destroy the measurement.
  it('never touches the digits and brackets the counts are made of', () => {
    expect(stripAnsi('Matched 1 of 90 discovered test file(s)')).toBe(
      'Matched 1 of 90 discovered test file(s)',
    );
    expect(stripAnsi('Test Files  1 passed (1)')).toBe('Test Files  1 passed (1)');
    expect(stripAnsi('[2m not an escape [22m')).toBe('[2m not an escape [22m');
    expect(stripAnsi('')).toBe('');
  });

  it('removes the non-colour sequences a progress display emits', () => {
    // Erase-line and cursor-column, which vitest writes while a run is live.
    expect(stripAnsi('\u001B[2K\u001B[1GTest Files  1 passed (1)')).toBe(
      'Test Files  1 passed (1)',
    );
    // An OSC hyperlink, whose payload is a URL rather than a phrase.
    expect(stripAnsi('\u001B]8;;https://example.test\u0007label\u001B]8;;\u0007')).toBe('label');
    // The same, terminated by ST rather than BEL.
    expect(stripAnsi('\u001B]0;title\u001B\\after')).toBe('after');
    // A two-character Fe escape.
    expect(stripAnsi('before\u001BMafter')).toBe('beforeafter');
  });

  it('reports plain text as uncoloured, so the controls above cannot pass vacuously', () => {
    expect(hasAnsi('Test Files  1 passed (1)')).toBe(false);
    expect(hasAnsi('')).toBe(false);
  });

  // `ANSI_PATTERN` is global, so a leaked `lastIndex` would make a second call
  // skip the start of its input and strip only part of it.
  it('does not carry match state between calls', () => {
    expect(hasAnsi(CI_TEST_FILES_LINE)).toBe(true);
    expect(hasAnsi(CI_TEST_FILES_LINE)).toBe(true);
    expect(stripAnsi(CI_TEST_FILES_LINE)).toBe(stripAnsi(CI_TEST_FILES_LINE));
    expect(ANSI_PATTERN.global).toBe(true);
  });

  it('names the agent variables that suppress colour, including the one CI lacks', () => {
    // `AI_AGENT` is the variable that was set here and absent on the runner, so
    // it is the whole of the local/CI divergence. If it were dropped from this
    // list the coloured process case would stop being coloured.
    expect(AGENT_ENV_KEYS).toContain('AI_AGENT');
    expect(AGENT_ENV_KEYS.length).toBeGreaterThan(1);
  });
});
