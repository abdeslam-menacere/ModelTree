/**
 * The inspection behind `./eol-policy.test.ts`, kept separate from it so the
 * guard can be aimed at input that is known to be broken (issue #570).
 *
 * Everything here is a pure function over the output of `git check-attr`. The
 * test spawns git; this file never does. That split is what lets the same
 * checks that judge the real repository also be shown to complain when handed a
 * repository whose line-ending policy has been removed or narrowed -- a guard
 * that has only ever seen a healthy input has not been shown to fail at all.
 */

/** The line-ending attributes git resolves for one tracked path. */
export interface PathAttributes {
  path: string;
  /** `lf`, `crlf`, or `unspecified` when no rule names the path. */
  eol: string;
  /** `auto`, `set`, `unset` (an explicitly binary path), or `unspecified`. */
  text: string;
}

export interface EolFindings {
  /** How many paths were looked at. Zero means the guard checked nothing. */
  inspected: number;
  /** Paths git would not check out with LF endings. */
  withoutLfEol: string[];
  /** Paths held out of conversion with `-text`, which are exempt above. */
  binary: string[];
}

/**
 * Parses `git check-attr -z --stdin eol text`, whose output is a flat run of
 * NUL-separated `<path>`, `<attribute>`, `<value>` triples. `-z` is not a
 * detail: without it git quotes paths containing unusual bytes, and a guard
 * that mis-parses a path silently drops it from the very list it is checking.
 */
export function parseCheckAttrZ(output: string): PathAttributes[] {
  const fields = output.split('\0');

  // A trailing NUL leaves one empty field, which is not the start of a triple.
  while (fields.length > 0 && fields[fields.length - 1] === '') {
    fields.pop();
  }

  if (fields.length % 3 !== 0) {
    throw new Error(
      `Expected NUL-separated triples from git check-attr, found ${fields.length} fields`,
    );
  }

  const byPath = new Map<string, PathAttributes>();

  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    const record = byPath.get(path) ?? { path, eol: 'unspecified', text: 'unspecified' };

    if (attribute === 'eol') {
      record.eol = value;
    } else if (attribute === 'text') {
      record.text = value;
    } else {
      throw new Error(`git check-attr reported an attribute that was not asked for: ${attribute}`);
    }

    byPath.set(path, record);
  }

  return [...byPath.values()];
}

/**
 * A path passes when git will check it out with LF endings. A path explicitly
 * marked binary (`-text`) is exempt rather than failing: line endings are not a
 * concept that applies to it, and a future image or font must not be forced
 * through a text conversion to keep this guard quiet.
 *
 * Deleting `.gitattributes` therefore does not slip through as "nothing to
 * check". It leaves every path with both attributes unspecified, so every path
 * lands in `withoutLfEol` and the guard names all of them.
 */
export function inspectEolPolicy(records: readonly PathAttributes[]): EolFindings {
  const binary = records.filter((record) => record.text === 'unset');
  const withoutLfEol = records.filter((record) => record.text !== 'unset' && record.eol !== 'lf');

  return {
    inspected: records.length,
    withoutLfEol: withoutLfEol.map((record) => record.path),
    binary: binary.map((record) => record.path),
  };
}

/** Human-readable findings, empty when the policy covers everything it should. */
export function describeFindings(findings: EolFindings): string[] {
  if (findings.inspected === 0) {
    return ['No paths were inspected, so the line-ending policy was not checked at all.'];
  }

  return findings.withoutLfEol.map(
    (path) =>
      `${path}: git would not check this out with LF endings. ` +
      'Restore the `* text=auto eol=lf` rule in the root .gitattributes (issue #570).',
  );
}
