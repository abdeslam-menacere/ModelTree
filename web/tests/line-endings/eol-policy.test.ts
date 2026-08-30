import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type PathAttributes,
  describeFindings,
  inspectEolPolicy,
  parseCheckAttrZ,
} from './eol-policy';

/**
 * Guards the repository's line-ending policy (issue #570).
 *
 * Without a root `.gitattributes` the working-tree form of a checkout is
 * decided by whatever `core.autocrlf` the machine carries, which is per-user
 * config and is not versioned. On Windows that made `npm run validate` leave
 * `web/src/components/__snapshots__/ModelPassport.test.tsx.snap` reported as
 * modified with an empty `git diff`: vitest rewrites the snapshot with LF, the
 * index had cached the CRLF checkout's larger size, and git treats a size
 * mismatch as a modification without hashing the file. A path that reads as
 * modified with no diff is indistinguishable from a real uncommitted change,
 * and `git add -A` stages it either way.
 *
 * The regression this guards against is not the symptom -- which cannot be
 * reproduced on a Linux CI runner, because a Linux checkout is LF whether or
 * not the policy exists -- but the policy being deleted, moved, or narrowed to
 * a subset of paths. That is platform-independent and so is catchable here.
 *
 * Nothing about `.gitattributes` is restated below. The file's text is never
 * read; git is asked what it resolves for every tracked path, so the guard
 * holds against any rewording of the rules that keeps their effect, and fails
 * on any rewording that does not.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function git(args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const trackedPaths = git(['ls-files', '-z']).split('\0').filter(Boolean);
const records = parseCheckAttrZ(
  git(['check-attr', '-z', '--stdin', 'eol', 'text'], trackedPaths.join('\0')),
);
const findings = inspectEolPolicy(records);

/** The snapshot whose spurious dirtiness raised the issue. */
const snapshot = 'web/src/components/__snapshots__/ModelPassport.test.tsx.snap';

describe('repository line-ending policy', () => {
  it('checks out every tracked text path with LF endings', () => {
    expect(findings.withoutLfEol).toEqual([]);
  });

  it('reports an intact policy as having nothing to say', () => {
    expect(describeFindings(findings)).toEqual([]);
  });

  it('covers the snapshot that raised the issue rather than only its neighbours', () => {
    // Named on its own because an empty `withoutLfEol` also describes a repo
    // where this path stopped being tracked, which would not be a fix.
    expect(records.find((record) => record.path === snapshot)).toEqual({
      path: snapshot,
      eol: 'lf',
      text: 'auto',
    });
  });

  it('inspected every tracked path, so an empty result is not an empty question', () => {
    expect(trackedPaths.length).toBeGreaterThan(0);
    expect(findings.inspected).toBe(trackedPaths.length);
  });

  it('holds no path out of the policy as binary', () => {
    // Not a rule against ever adding a binary file: `inspectEolPolicy` exempts
    // `-text` paths deliberately. It records that today nothing is exempt, so
    // adding an exemption is a visible decision rather than a quiet one.
    expect(findings.binary).toEqual([]);
  });
});

/**
 * A guard that cannot fail protects nothing, and this one asserts emptiness
 * three times over -- so an inspection that finds nothing at all would report a
 * healthy repository exactly as loudly as a healthy repository does. These
 * cases hand it damage it must complain about. They build synthetic records
 * rather than editing `.gitattributes`, so the committed file is only ever read.
 */
describe('the guard itself', () => {
  const healthy: PathAttributes[] = [
    { path: 'web/src/lib/theme.ts', eol: 'lf', text: 'auto' },
    { path: snapshot, eol: 'lf', text: 'auto' },
  ];

  it('reports the known-good base these cases are built from as intact', () => {
    expect(describeFindings(inspectEolPolicy(healthy))).toEqual([]);
  });

  it('names every path when the policy is deleted outright', () => {
    const deleted = healthy.map((record) => ({
      ...record,
      eol: 'unspecified',
      text: 'unspecified',
    }));

    expect(inspectEolPolicy(deleted).withoutLfEol).toEqual(healthy.map((record) => record.path));
  });

  it('names the paths left behind when the policy is narrowed to one of them', () => {
    const narrowed = healthy.map((record) =>
      record.path === snapshot ? record : { ...record, eol: 'unspecified', text: 'unspecified' },
    );
    const damaged = inspectEolPolicy(narrowed);

    expect(damaged.withoutLfEol).toEqual(['web/src/lib/theme.ts']);
    expect(describeFindings(damaged).join('\n')).toContain('would not check this out with LF');
  });

  it('catches a policy that pins the working tree to CRLF instead', () => {
    const inverted = healthy.map((record) => ({ ...record, eol: 'crlf' }));

    expect(inspectEolPolicy(inverted).withoutLfEol).toEqual(healthy.map((record) => record.path));
  });

  it('exempts an explicitly binary path instead of demanding LF of it', () => {
    const withBinary = [...healthy, { path: 'web/public/logo.png', eol: 'unspecified', text: 'unset' }];
    const inspected = inspectEolPolicy(withBinary);

    expect(inspected.binary).toEqual(['web/public/logo.png']);
    expect(inspected.withoutLfEol).toEqual([]);
  });

  it('refuses to call an empty inspection a pass', () => {
    expect(describeFindings(inspectEolPolicy([]))).toEqual([
      'No paths were inspected, so the line-ending policy was not checked at all.',
    ]);
  });
});

describe('parsing git check-attr output', () => {
  it('folds the two attributes of one path into a single record', () => {
    expect(parseCheckAttrZ('a.ts\0eol\0lf\0a.ts\0text\0auto\0')).toEqual([
      { path: 'a.ts', eol: 'lf', text: 'auto' },
    ]);
  });

  it('keeps a path whose name contains the separator git quotes without -z', () => {
    const parsed = parseCheckAttrZ('we ird".ts\0eol\0lf\0we ird".ts\0text\0auto\0');

    expect(parsed).toEqual([{ path: 'we ird".ts', eol: 'lf', text: 'auto' }]);
  });

  it('reads an empty report as no paths rather than as a malformed one', () => {
    expect(parseCheckAttrZ('')).toEqual([]);
  });

  it('refuses output that does not divide into triples', () => {
    expect(() => parseCheckAttrZ('a.ts\0eol\0')).toThrow(/triples/);
  });

  it('refuses an attribute nobody asked about, rather than ignoring it', () => {
    expect(() => parseCheckAttrZ('a.ts\0diff\0set\0')).toThrow(/not asked for/);
  });
});
