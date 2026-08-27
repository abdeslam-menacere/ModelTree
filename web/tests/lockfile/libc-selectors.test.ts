import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_LIBC_PACKAGES,
  describeFindings,
  expectedLibcFor,
  inspectLibcSelectors,
  packagesOf,
} from './libc-selectors';

/**
 * Guards the `libc` selectors in `web/package-lock.json` (issue #292). The
 * reasoning behind asserting named packages rather than a count of 34 lives in
 * `./libc-selectors.ts`, next to the list it justifies.
 *
 * This reads the committed lockfile and nothing else: no `npm install`, no
 * `npm ci`, no network. The path is fixed here on purpose and there is no
 * environment override to point it somewhere friendlier -- a guard whose target
 * file can be swapped from outside is a guard that can be made to pass while the
 * real file is broken.
 */
const lockfilePath = new URL('../../package-lock.json', import.meta.url);
const lockfileSource = readFileSync(lockfilePath, 'utf8');
const findings = inspectLibcSelectors(lockfileSource);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }

  return value as Record<string, unknown>;
}

/** A lockfile rebuilt from its `packages` map, with one edit applied. */
function rebuild(source: string, edit: (packages: Record<string, unknown>) => void): string {
  const lockfile = asRecord(JSON.parse(source), 'the lockfile');
  const packages = packagesOf(source);

  edit(packages);
  lockfile.packages = packages;

  return JSON.stringify(lockfile, null, 2);
}

describe('package-lock.json libc selectors', () => {
  it('still carries a selector for every package that had one', () => {
    expect(findings.missing).toEqual([]);
  });

  it('has not lost any of the packages the selectors belong to', () => {
    expect(findings.absent).toEqual([]);
  });

  it('carries no selector the expectation list does not name', () => {
    expect(findings.unexpected).toEqual([]);
  });

  it('points every selector at the C library the package name calls for', () => {
    expect(findings.mismatched).toEqual([]);
  });

  it('writes every selector in the single-element shape npm reads', () => {
    expect(findings.malformed).toEqual([]);
  });

  it('reports an intact lockfile as having nothing to say', () => {
    expect(describeFindings(findings)).toEqual([]);
  });

  it('holds the selector total the expectation list accounts for', () => {
    // Both sides derive from EXPECTED_LIBC_PACKAGES rather than from a second
    // literal, so the 34/22/12 split cannot drift away from the list above it.
    const glibc = EXPECTED_LIBC_PACKAGES.filter((path) => expectedLibcFor(path) === 'glibc');
    const musl = EXPECTED_LIBC_PACKAGES.filter((path) => expectedLibcFor(path) === 'musl');

    expect(findings.selectorCount).toBe(EXPECTED_LIBC_PACKAGES.length);
    expect(findings.found).toHaveLength(EXPECTED_LIBC_PACKAGES.length);
    expect(findings.found.filter((entry) => entry.libc === 'glibc')).toHaveLength(glibc.length);
    expect(findings.found.filter((entry) => entry.libc === 'musl')).toHaveLength(musl.length);
  });

  it('reads the lockfile without writing to it', () => {
    expect(readFileSync(lockfilePath, 'utf8')).toBe(lockfileSource);
  });
});

/**
 * A guard that cannot fail protects nothing, and the way this one would fail
 * silently is subtle: every check above asserts emptiness, so a bug that finds no
 * packages at all reports a clean lockfile exactly as loudly as an intact one
 * does. These damage a copy held in memory -- the committed file is only ever
 * read -- and require the same inspection to complain about it.
 *
 * The fixtures are built from `healthySource`: the real lockfile with every
 * expected selector forced to its correct value. That base is used *only* here,
 * never by the assertions above, which read the committed bytes untouched. The
 * point is to keep a failure in this block meaning "the guard is broken" rather
 * than "the lockfile is broken" -- otherwise damage to the real file cascades
 * through these fixtures and buries the assertions that actually name it.
 */
describe('the guard itself', () => {
  const victim = 'node_modules/@img/sharp-linux-x64';
  const muslVictim = 'node_modules/@img/sharp-linuxmusl-x64';

  const healthySource = rebuild(lockfileSource, (packages) => {
    for (const path of EXPECTED_LIBC_PACKAGES) {
      const meta = packages[path];
      const entry = typeof meta === 'object' && meta !== null ? asRecord(meta, path) : {};

      entry.libc = [expectedLibcFor(path)];
      packages[path] = entry;
    }
  });

  it('reports the known-good base these fixtures are built from as intact', () => {
    expect(describeFindings(inspectLibcSelectors(healthySource))).toEqual([]);
  });

  it('names the package when a selector is dropped', () => {
    const damaged = inspectLibcSelectors(
      rebuild(healthySource, (packages) => {
        delete asRecord(packages[victim], victim).libc;
      }),
    );

    expect(damaged.missing).toEqual([victim]);
    expect(damaged.selectorCount).toBe(EXPECTED_LIBC_PACKAGES.length - 1);
    expect(describeFindings(damaged).join('\n')).toContain(
      `${victim}: the "libc" selector is gone`,
    );
  });

  it('names a musl package when its selector is dropped', () => {
    const damaged = inspectLibcSelectors(
      rebuild(healthySource, (packages) => {
        delete asRecord(packages[muslVictim], muslVictim).libc;
      }),
    );

    expect(damaged.missing).toEqual([muslVictim]);
    expect(describeFindings(damaged).join('\n')).toContain('Restore "libc": ["musl"]');
  });

  it('catches a selector swapped to the wrong C library, which a count cannot', () => {
    const damaged = inspectLibcSelectors(
      rebuild(healthySource, (packages) => {
        asRecord(packages[victim], victim).libc = ['musl'];
      }),
    );

    expect(damaged.selectorCount).toBe(EXPECTED_LIBC_PACKAGES.length);
    expect(damaged.mismatched).toEqual([{ path: victim, expected: 'glibc', actual: 'musl' }]);
  });

  it('catches a selector rewritten into a shape npm does not use', () => {
    const damaged = inspectLibcSelectors(
      rebuild(healthySource, (packages) => {
        asRecord(packages[victim], victim).libc = 'glibc';
      }),
    );

    expect(damaged.malformed).toEqual([{ path: victim, actual: '"glibc"' }]);
  });

  it('separates a package leaving the lockfile from a selector being stripped', () => {
    const damaged = inspectLibcSelectors(
      rebuild(healthySource, (packages) => {
        delete packages[victim];
      }),
    );

    expect(damaged.absent).toEqual([victim]);
    expect(damaged.missing).toEqual([]);
    expect(describeFindings(damaged).join('\n')).toContain('no longer in the lockfile');
  });

  it('notices a selector appearing on a package the list does not name', () => {
    const newcomer = 'node_modules/@esbuild/linux-x64';
    const damaged = inspectLibcSelectors(
      rebuild(healthySource, (packages) => {
        asRecord(packages[newcomer], newcomer).libc = ['glibc'];
      }),
    );

    expect(damaged.unexpected).toEqual([newcomer]);
  });
});
