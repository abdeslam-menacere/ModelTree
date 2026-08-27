// The `libc` selectors in `web/package-lock.json`, and the rules the test beside
// this file holds them to. Issue #292; the two rewrites that already dropped them
// are recorded on #190.
//
// A `libc` selector is what makes npm pick the right optional native binary on
// Linux: `@img/sharp-linux-x64` is glibc-only, `@img/sharp-linuxmusl-x64` is
// musl-only, and without the field npm has nothing to choose on. Losing one is
// silent at the moment it happens -- the lockfile still installs cleanly on the
// machine that rewrote it -- and surfaces later as a wrong or missing native
// package on some other platform. npm 11.9.0 strips the field on rewrite.
//
// -- The decision issue #292 asks for: count, or packages? --
//
// This asserts the **specific packages**, as an explicit membership list, and
// derives each package's expected *value* from its name. Not an exact count.
//
// An exact count (34) was rejected on three grounds, in increasing order of
// weight. It cannot say which package lost its selector, so the failure hands a
// reader a number and no lead. It goes stale on any legitimate dependency change
// -- but so does a list, and a list at least shows the change as a named add or
// remove in the diff rather than as `34 -> 36`. And decisively: a count is blind
// to the failure that costs the same as a drop. Swap `["glibc"]` for `["musl"]`
// on one entry and the count is still 34, while npm now installs the musl binary
// on a glibc host. That is the same wrong-binary outcome the issue is about, so a
// check that cannot see it is not a check on the thing being protected.
//
// -- The derivation that looks right and is not --
//
// The tempting third option is to derive membership and assert nothing by hand:
// every optional Linux package should carry a selector. It is false on this very
// lockfile, and the counterexamples are worth naming so the next reader does not
// spend the afternoon rediscovering them. Eleven optional `os: ["linux"]`
// packages here carry no `libc` field at all:
//
//     @esbuild/linux-{arm,arm64,ia32,loong64,mips64el,ppc64,riscv64,s390x,x64}
//     @rolldown/binding-linux-arm-gnueabihf
//     lightningcss-linux-arm-gnueabihf
//
// esbuild ships one statically linked binary per architecture that runs on both
// C libraries, so it has nothing to select on. Whether a package carries a
// selector is a publishing decision made upstream, and the lockfile records it
// without encoding it anywhere else. A derived rule would therefore fail on the
// true file, which is the one thing a guard must never do. Membership has to be
// written down, and written-down membership is safe here in a way a documented
// count is not: it is compared against the artefact on every run, so it cannot
// quietly disagree with it -- it fails loudly instead. That is the difference
// between a test expectation and the documented-number defect class this program
// keeps finding.
//
// -- What is still derived, and why --
//
// The *value* is not written down. Across all 34, a name containing `musl` takes
// `["musl"]` and every other name takes `["glibc"]`, exactly. So the expectation
// is computed from the name and no table of 34 values exists to drift. Known
// limit, stated rather than papered over: if some upstream ever ships a
// musl-named package built against glibc, this rule is wrong and the test will
// say so on the true lockfile. The fix then is to correct the rule, never to
// loosen it until the old sentence becomes true.
//
// The list below is checked in deliberately and must be updated by hand when a
// dependency legitimately adds or drops a native Linux package. That cost is the
// price of naming the packages, and it is paid with a failure message that says
// which package and in which direction.

/** The C library a native binary is built against, as npm records it. */
export type Libc = 'glibc' | 'musl';

/**
 * Every package in `web/package-lock.json` that carries a `libc` selector, by
 * its lockfile key. Verified against `origin/main`: 34 entries, 22 glibc and 12
 * musl. Sorted, so the diff of any change to it reads as one add or one remove.
 */
export const EXPECTED_LIBC_PACKAGES: readonly string[] = [
  'node_modules/@astrojs/compiler-binding-linux-arm64-gnu',
  'node_modules/@astrojs/compiler-binding-linux-arm64-musl',
  'node_modules/@astrojs/compiler-binding-linux-x64-gnu',
  'node_modules/@astrojs/compiler-binding-linux-x64-musl',
  'node_modules/@bruits/satteri-linux-arm64-gnu',
  'node_modules/@bruits/satteri-linux-arm64-musl',
  'node_modules/@bruits/satteri-linux-x64-gnu',
  'node_modules/@bruits/satteri-linux-x64-musl',
  'node_modules/@img/sharp-libvips-linux-arm',
  'node_modules/@img/sharp-libvips-linux-arm64',
  'node_modules/@img/sharp-libvips-linux-ppc64',
  'node_modules/@img/sharp-libvips-linux-riscv64',
  'node_modules/@img/sharp-libvips-linux-s390x',
  'node_modules/@img/sharp-libvips-linux-x64',
  'node_modules/@img/sharp-libvips-linuxmusl-arm64',
  'node_modules/@img/sharp-libvips-linuxmusl-x64',
  'node_modules/@img/sharp-linux-arm',
  'node_modules/@img/sharp-linux-arm64',
  'node_modules/@img/sharp-linux-ppc64',
  'node_modules/@img/sharp-linux-riscv64',
  'node_modules/@img/sharp-linux-s390x',
  'node_modules/@img/sharp-linux-x64',
  'node_modules/@img/sharp-linuxmusl-arm64',
  'node_modules/@img/sharp-linuxmusl-x64',
  'node_modules/@rolldown/binding-linux-arm64-gnu',
  'node_modules/@rolldown/binding-linux-arm64-musl',
  'node_modules/@rolldown/binding-linux-ppc64-gnu',
  'node_modules/@rolldown/binding-linux-s390x-gnu',
  'node_modules/@rolldown/binding-linux-x64-gnu',
  'node_modules/@rolldown/binding-linux-x64-musl',
  'node_modules/lightningcss-linux-arm64-gnu',
  'node_modules/lightningcss-linux-arm64-musl',
  'node_modules/lightningcss-linux-x64-gnu',
  'node_modules/lightningcss-linux-x64-musl',
];

/**
 * The selector a package's name says it should carry. Derived rather than
 * tabulated, for the reason in the header: a table of 34 values is 34 values
 * that can drift.
 */
export function expectedLibcFor(lockfileKey: string): Libc {
  return lockfileKey.includes('musl') ? 'musl' : 'glibc';
}

/** A selector as found in the lockfile. */
export interface LibcEntry {
  readonly path: string;
  readonly libc: Libc;
}

/** A selector whose value disagrees with what the package name calls for. */
export interface LibcMismatch {
  readonly path: string;
  readonly expected: Libc;
  readonly actual: string;
}

/** A selector present but not in the `["glibc"]`/`["musl"]` shape npm writes. */
export interface LibcMalformed {
  readonly path: string;
  readonly actual: string;
}

export interface LibcFindings {
  /** Expected packages whose selector is present, well formed, and correct. */
  readonly found: readonly LibcEntry[];
  /**
   * Expected packages still in the lockfile that have lost the field. This is
   * the #190 failure, and it is kept apart from `absent` because the two mean
   * opposite things: this one is damage, that one is a dependency change.
   */
  readonly missing: readonly string[];
  /** Expected packages no longer in the lockfile at all. */
  readonly absent: readonly string[];
  /** Packages carrying a selector that the list does not name. */
  readonly unexpected: readonly string[];
  readonly mismatched: readonly LibcMismatch[];
  readonly malformed: readonly LibcMalformed[];
  /** Every `libc` key in the file, however shaped -- the raw 34. */
  readonly selectorCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasLibc(meta: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(meta, 'libc');
}

/** The `packages` map of a lockfile, from its bytes. */
export function packagesOf(source: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source);

  if (!isRecord(parsed)) {
    throw new Error('Expected the lockfile to parse to an object');
  }

  const packages = parsed.packages;

  if (!isRecord(packages)) {
    throw new Error('Expected the lockfile to carry a "packages" object');
  }

  return packages;
}

/**
 * Compare a lockfile's `libc` selectors against the expectations above. Pure
 * over the file's bytes: no install, no npm invocation, no network. The mirror
 * this project resolves through is TLS-blocked and hands out a different shard
 * host per request, so anything reaching out would be flaky by construction.
 */
export function inspectLibcSelectors(source: string): LibcFindings {
  const packages = packagesOf(source);
  const expected = new Set(EXPECTED_LIBC_PACKAGES);

  const found: LibcEntry[] = [];
  const missing: string[] = [];
  const absent: string[] = [];
  const unexpected: string[] = [];
  const mismatched: LibcMismatch[] = [];
  const malformed: LibcMalformed[] = [];

  for (const path of EXPECTED_LIBC_PACKAGES) {
    const meta = packages[path];

    if (meta === undefined) {
      absent.push(path);
      continue;
    }

    if (!isRecord(meta)) {
      malformed.push({ path, actual: JSON.stringify(meta) });
      continue;
    }

    if (!hasLibc(meta)) {
      missing.push(path);
      continue;
    }

    const selector = meta.libc;

    if (!Array.isArray(selector) || selector.length !== 1 || typeof selector[0] !== 'string') {
      malformed.push({ path, actual: JSON.stringify(selector) });
      continue;
    }

    const actual: string = selector[0];
    const want = expectedLibcFor(path);

    if (actual !== want) {
      mismatched.push({ path, expected: want, actual });
      continue;
    }

    found.push({ path, libc: want });
  }

  let selectorCount = 0;

  for (const [path, meta] of Object.entries(packages)) {
    if (!isRecord(meta) || !hasLibc(meta)) continue;

    selectorCount += 1;
    if (!expected.has(path)) unexpected.push(path);
  }

  return { found, missing, absent, unexpected, mismatched, malformed, selectorCount };
}

/**
 * The findings as lines a reader can act on, or an empty array when the file is
 * intact. Each line says what changed and in which direction, because "34 became
 * 33" is the failure message this guard exists to avoid.
 */
export function describeFindings(findings: LibcFindings): string[] {
  const lines: string[] = [];

  for (const path of findings.missing) {
    lines.push(
      `${path}: the "libc" selector is gone, but the package is still in the lockfile. ` +
        `That is a rewrite stripping it (issue #190), not a dependency change. Restore ` +
        `"libc": ["${expectedLibcFor(path)}"].`,
    );
  }

  for (const path of findings.absent) {
    lines.push(
      `${path}: no longer in the lockfile. If a dependency change removed it on purpose, ` +
        `drop it from EXPECTED_LIBC_PACKAGES in the same commit.`,
    );
  }

  for (const path of findings.unexpected) {
    lines.push(
      `${path}: carries a "libc" selector but is not named in EXPECTED_LIBC_PACKAGES. ` +
        `If a dependency change added it on purpose, add it to the list in the same commit.`,
    );
  }

  for (const { path, expected, actual } of findings.mismatched) {
    lines.push(
      `${path}: selector is "${actual}" but the package name calls for "${expected}". ` +
        `npm would install the wrong native binary.`,
    );
  }

  for (const { path, actual } of findings.malformed) {
    lines.push(`${path}: "libc" is ${actual}, not a single-element array of one string.`);
  }

  return lines;
}
