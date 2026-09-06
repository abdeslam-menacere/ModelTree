import type { Dataset } from '../data/schema';

/**
 * A licence cross-check that is a **pure offline function** of
 * `(spdxId, recordedUrl, finalUrl)` against a canonical-URL identity table.
 *
 * ## What this is for
 *
 * The scheduled sweep over `license.url` is a **reachability** instrument. It
 * asks whether a URL answers, and a 200 is the whole of what it establishes. It
 * cannot see that a publisher repaired a dead licence URL by repointing it at a
 * *different but live* document, because that repoint answers 200 exactly as the
 * correct document does. So the widening in #931 made a wrong-target repoint
 * less visible than the 404 it replaced: the 404 was loud, the repoint reads as
 * green. That defect is the subject of #1057.
 *
 * This module is the narrow instrument that closes the part of that gap which
 * can be closed with certainty and no new network traffic. Some URLs *are* their
 * own licence identity: `https://www.apache.org/licenses/LICENSE-2.0.txt` is the
 * Apache-2.0 licence, published by the body that wrote it, at a path that body
 * controls. Comparing an `spdxId` against that identity needs no document read,
 * so it has no rate limit, no flake, no retry policy, and behaves identically in
 * CI and locally. It also cannot confuse a network error with a licence
 * mismatch, because it makes no requests at all.
 *
 * ## Why `finalUrl` is the sharper input
 *
 * The sweep already fetches these URLs to establish reachability, and a fetch
 * reports the URL it *landed on*. Reading licence identity off that landing URL
 * is a second fact extracted from a request that already happened, and it is the
 * one that catches a **server-side repoint**: the recorded URL still says
 * Apache-2.0 while the server now serves something else from it.
 *
 * `finalUrl` is therefore an **optional input** here rather than something this
 * module goes and gets. When it is supplied, it is what gets classified. When it
 * is not, the recorded URL is classified and the result says so in
 * `identifiedFrom`, so a caller can never read an unfetched run as a fetched one
 * that found no redirect. Not-looked and looked-and-found-nothing stay
 * separately representable (ADR 0018).
 *
 * ## Failing toward "cannot determine"
 *
 * Every outcome that is not a certainty is an abstention carrying a **named
 * structural reason** drawn from {@link LicenceAbstentionReason} -- an enumerable
 * set of values, never free text. That is the property that makes an abstention
 * usable: `model-landing-page` converts into a work item (read the model card's
 * frontmatter), where an unexplained "unknown" is noise that gets filtered out
 * until the check is deleted as dead weight.
 *
 * It also means the check never fails *toward* correctness. If a recorded URL is
 * canonically Apache-2.0 but the request landed somewhere unidentifiable, the
 * verdict is not `agrees` on the strength of the recorded URL -- it is an
 * abstention naming why the landing URL could not be identified. A fetch that
 * succeeds but whose target cannot be classified is not evidence of agreement.
 *
 * ## What it deliberately does not do
 *
 * It reads no licence document bodies and makes no requests, which is the
 * adjudicated design decision on #1057 rather than a shortfall. It also never
 * repairs anything: a disagreement is *reported*. Nothing here writes to
 * `web/src/data/`, for the same reason `check-licence-links.mjs` refuses to --
 * repointing a record is a reviewed human edit, and a comparator is not a
 * reviewer.
 *
 * Reading `license:` out of Hugging Face model-card YAML frontmatter is a
 * complementary population, not a competing design: it covers exactly the
 * records this module abstains on as `model-landing-page`. It is out of scope
 * here and proposed separately.
 */

/** The three outcomes. There is no fourth, and no implicit default. */
export const LICENCE_VERDICTS = ['agrees', 'disagrees', 'cannot-determine'] as const;

export type LicenceVerdict = (typeof LICENCE_VERDICTS)[number];

/**
 * Why an abstention abstained, as an enumerable value.
 *
 * Each of these is a *structural* fact about the input rather than a description
 * of a failure: it says which shape of thing was in hand, so a reader can tell
 * "there is nothing to compare against" from "there is something to compare
 * against and this instrument cannot reach it". Those convert into different
 * work items, and collapsing them into one string loses the distinction.
 *
 * Every value here is proven emittable by `licence-url-identity.test.ts`. A
 * reason that no input can produce is a reason that does not exist, and the test
 * asserts the set of reasons the classifier can actually reach is exactly this
 * set -- so adding a value without an input that produces it fails.
 */
export const LICENCE_ABSTENTION_REASONS = [
  /** The record cites a licence URL but asserts no `spdxId`: nothing to contradict. */
  'no-spdx-id',
  /** The record asserts an `spdxId` but cites no URL: the sweep never sees this record at all. */
  'no-licence-url',
  /** The recorded URL is not a URL. Malformed input is a finding for the schema, not for this. */
  'malformed-url',
  /** A `finalUrl` was supplied and is not a URL. The supplier is broken; this abstains rather than falling back. */
  'malformed-final-url',
  /**
   * A model repository landing page. The licence is asserted in the card body,
   * not in the URL, so the URL carries no identity to compare. This is the
   * correct classification for `xiaomi-mimo-7b-rl-0530`.
   */
  'model-landing-page',
  /**
   * A file path inside a source repository. The path names a file; a file named
   * `LICENSE` may contain any licence, or none, and may be re-written in place
   * without the URL changing.
   */
  'repository-hosted-document',
  /**
   * The host is one this table knows, but the path is not a shape it can
   * classify. Distinguished from `unrecognised-host` because it is the shape
   * that a mistyped path, or a newly-published canonical one, takes — and that
   * is worth reviewing rather than dismissing.
   */
  'unrecognised-path-on-known-host',
  /** The host is not in the identity table at all. */
  'unrecognised-host',
] as const;

export type LicenceAbstentionReason = (typeof LICENCE_ABSTENTION_REASONS)[number];

/** Which URL the verdict was actually taken on. Never inferred by a caller. */
export type LicenceIdentitySource = 'final-url' | 'recorded-url' | 'none';

export interface LicenceIdentityInput {
  /** `license.spdxId` as the record asserts it, or absent. */
  spdxId?: string | undefined;
  /** `license.url` as the record cites it, or absent. */
  recordedUrl?: string | undefined;
  /**
   * The URL a request for `recordedUrl` landed on, if one has been made. Absent
   * means *no fetch was supplied*, which is a different state from *fetched and
   * did not redirect*; the latter supplies a `finalUrl` equal to the recorded one.
   */
  finalUrl?: string | undefined;
}

export interface LicenceIdentityResult {
  verdict: LicenceVerdict;
  /** Set on `cannot-determine`, and `null` on every other verdict. */
  reason: LicenceAbstentionReason | null;
  /** The SPDX id the identity table assigns to the classified URL, or `null`. */
  identifiedSpdxId: string | null;
  /** Which URL was classified. `'none'` when classification never got that far. */
  identifiedFrom: LicenceIdentitySource;
  /**
   * True when a `finalUrl` was supplied and canonicalises differently from the
   * recorded URL. A redirect is not itself a finding -- `http` to `https` and a
   * trailing slash are both redirects -- but it is the condition under which a
   * disagreement means "the server repointed this", so callers report it.
   */
  redirected: boolean;
}

/**
 * The canonical-URL identity table.
 *
 * An entry here is a factual claim that a given host serves a given licence at a
 * given path, so the table is deliberately small and contains only publishers
 * that are the licence's own steward: the Apache Software Foundation for its own
 * licences, and the Open Source Initiative for the register it maintains. A URL
 * that is merely *about* a licence, or that happens to hold a copy of one, is
 * not in here -- a copy can be replaced in place without its URL changing, which
 * is the exact failure mode this module exists to catch.
 *
 * Paths are matched after {@link canonicalisePath}: lowercased, with any
 * trailing slash removed. Host matching is exact after `www.` is stripped, so
 * `apache.org` and `www.apache.org` are the same publisher.
 */
const IDENTITY_TABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'apache.org': {
    '/licenses/license-2.0': 'Apache-2.0',
    '/licenses/license-2.0.txt': 'Apache-2.0',
    '/licenses/license-2.0.html': 'Apache-2.0',
    '/licenses/license-1.1': 'Apache-1.1',
    '/licenses/license-1.0': 'Apache-1.0',
  },
  'opensource.org': {
    // The current slug scheme.
    '/license/mit': 'MIT',
    '/license/apache-2-0': 'Apache-2.0',
    '/license/bsd-3-clause': 'BSD-3-Clause',
    '/license/bsd-2-clause': 'BSD-2-Clause',
    '/license/mpl-2-0': 'MPL-2.0',
    '/license/isc-license-txt': 'ISC',
    // The legacy `/licenses/<SPDX id>` scheme, still widely cited.
    '/licenses/mit': 'MIT',
    '/licenses/apache-2.0': 'Apache-2.0',
    '/licenses/bsd-3-clause': 'BSD-3-Clause',
    '/licenses/bsd-2-clause': 'BSD-2-Clause',
    '/licenses/mpl-2.0': 'MPL-2.0',
    '/licenses/isc': 'ISC',
  },
};

/**
 * Hosts whose URLs are structurally incapable of carrying licence identity, and
 * how each one is shaped.
 *
 * Being in this list is not a demotion. It is the difference between "this
 * instrument does not know this host" and "no instrument of this kind can ever
 * adjudicate this host", and only the second converts into a specific follow-up.
 *
 * The two shapes are not interchangeable, and conflating them misclassified real
 * records. `raw.githubusercontent.com` serves **only** raw file bytes: it has no
 * landing pages at all, and its paths carry no `/blob/` marker to detect, so a
 * marker rule alone reads `…/MiniMax-M1/main/LICENSE` as a landing page. A
 * `browsable` host serves both, and there the shape of the path is what
 * separates them.
 */
const REPOSITORY_HOSTS: Readonly<Record<string, 'raw-only' | 'browsable'>> = {
  'raw.githubusercontent.com': 'raw-only',
  'huggingface.co': 'browsable',
  'github.com': 'browsable',
  'gitlab.com': 'browsable',
};

/** Path segments that mark a browsable repository URL as pointing at a file. */
const FILE_PATH_MARKERS = ['/blob/', '/raw/', '/resolve/', '/tree/'];

/** `/{owner}/{repo}` — the only path shape on a browsable host that is a landing page. */
const LANDING_PAGE_SEGMENTS = 2;

function canonicaliseHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function canonicalisePath(pathname: string): string {
  const lower = pathname.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.replace(/\/+$/, '') : lower;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The comparison rule for two SPDX ids.
 *
 * SPDX ids are compared case-insensitively. The register's own identifiers are
 * mixed case (`Apache-2.0`, `MIT`, `BSD-3-Clause`) and citations of them in the
 * wild are not, so a case-sensitive comparison would report `apache-2.0` against
 * `Apache-2.0` as a **disagreement** -- a false positive in the direction that
 * costs a reviewer a cycle arguing with a comparator that is wrong.
 */
function sameSpdxId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** What the identity table says a URL is, or why it cannot say. */
function identify(url: URL): { spdxId: string } | { reason: LicenceAbstentionReason } {
  const host = canonicaliseHost(url.hostname);
  const path = canonicalisePath(url.pathname);

  const known = IDENTITY_TABLE[host];
  if (known !== undefined) {
    const spdxId = known[path];
    if (spdxId !== undefined) return { spdxId };
    return { reason: 'unrecognised-path-on-known-host' };
  }

  const shape = REPOSITORY_HOSTS[host];
  if (shape !== undefined) {
    // A file inside a repository, versus the repository's own landing page.
    // Both abstain, and they abstain for different reasons that lead to
    // different follow-ups: a landing page states its licence in a card, which
    // is readable; a file is free text that must be identified against SPDX
    // templates before it can be compared to anything.
    if (shape === 'raw-only') return { reason: 'repository-hosted-document' };
    if (FILE_PATH_MARKERS.some((marker) => path.includes(marker))) return { reason: 'repository-hosted-document' };

    const segments = path.split('/').filter((segment) => segment.length > 0);
    if (segments.length === LANDING_PAGE_SEGMENTS) return { reason: 'model-landing-page' };
    if (segments.length > LANDING_PAGE_SEGMENTS) return { reason: 'repository-hosted-document' };
    // Shorter than `/{owner}/{repo}`: an organisation page, or the host itself.
    // Neither is a document and neither is a model, so naming it either would be
    // a false classification rather than a coarse one.
    return { reason: 'unrecognised-path-on-known-host' };
  }

  return { reason: 'unrecognised-host' };
}

/**
 * Classify one record's licence identity.
 *
 * Pure: no I/O, no clock, no global state. The same three strings always produce
 * the same result, which is what makes this testable to the standard #1057 asks
 * for -- every verdict and every abstention reason demonstrably emittable,
 * including a disagreement, without a network in the loop.
 */
export function classifyLicenceIdentity(input: LicenceIdentityInput): LicenceIdentityResult {
  const spdxId = input.spdxId?.trim();
  const recordedUrl = input.recordedUrl?.trim();
  const finalUrl = input.finalUrl?.trim();

  const abstain = (
    reason: LicenceAbstentionReason,
    extra: Partial<LicenceIdentityResult> = {},
  ): LicenceIdentityResult => ({
    verdict: 'cannot-determine',
    reason,
    identifiedSpdxId: null,
    identifiedFrom: 'none',
    redirected: false,
    ...extra,
  });

  // Order matters, and it runs from "there is nothing to compare" outwards.
  // Reporting `unrecognised-host` about a record that carries no `spdxId` would
  // name the wrong problem: the host is beside the point when there is no
  // assertion to contradict.
  if (spdxId === undefined || spdxId.length === 0) {
    return abstain(recordedUrl === undefined || recordedUrl.length === 0 ? 'no-licence-url' : 'no-spdx-id');
  }
  if (recordedUrl === undefined || recordedUrl.length === 0) return abstain('no-licence-url');

  const recorded = parse(recordedUrl);
  if (recorded === null) return abstain('malformed-url');

  let classified = recorded;
  let identifiedFrom: LicenceIdentitySource = 'recorded-url';
  let redirected = false;

  if (finalUrl !== undefined && finalUrl.length > 0) {
    const landed = parse(finalUrl);
    // A supplied-but-unparseable `finalUrl` abstains rather than falling back to
    // the recorded URL. Falling back would answer a question about the recorded
    // URL while the caller believes it answered one about the fetch, which is
    // the substitution this module exists to refuse.
    if (landed === null) return abstain('malformed-final-url');
    classified = landed;
    identifiedFrom = 'final-url';
    redirected =
      canonicaliseHost(landed.hostname) !== canonicaliseHost(recorded.hostname) ||
      canonicalisePath(landed.pathname) !== canonicalisePath(recorded.pathname);
  }

  const identified = identify(classified);
  if ('reason' in identified) {
    // The abstention keeps `identifiedFrom` and `redirected`, because "the
    // request landed somewhere I cannot identify" and "the recorded URL is
    // something I cannot identify" are different findings. The first is the
    // repoint this issue was filed about.
    return abstain(identified.reason, { identifiedFrom, redirected });
  }

  return {
    verdict: sameSpdxId(identified.spdxId, spdxId) ? 'agrees' : 'disagrees',
    reason: null,
    identifiedSpdxId: identified.spdxId,
    identifiedFrom,
    redirected,
  };
}

/** One release's classification, carried with the id that produced it. */
export interface LicenceIdentityRecord extends LicenceIdentityResult {
  releaseId: string;
  spdxId: string | null;
  recordedUrl: string | null;
  finalUrl: string | null;
}

/**
 * The four licence populations, derived rather than declared.
 *
 * #1057's second acceptance bullet is that this split is computed from the data
 * and never hard-coded, because a literal goes stale on the next release added
 * -- this repository has been bitten by exactly that in #1006, #997 and #941.
 * Every figure below is a count taken at run time.
 *
 * Four, not three. A record asserting an `spdxId` with no `url` is invisible to
 * the sweep entirely: it is neither checked nor checkable-but-unchecked, and
 * folding it into either would misreport what has been examined.
 */
export interface LicenceCoverage {
  releases: number;
  withLicence: number;
  /** Carries `license.url`: the population the sweep fetches. */
  withUrl: number;
  /** Carries `license.spdxId`. */
  withSpdxId: number;
  /** Carries both: the population where a cross-check is possible at all. */
  checkable: number;
  /** Carries a URL and no `spdxId`: swept, and impossible to cross-check. */
  urlWithoutSpdxId: number;
  /** Carries an `spdxId` and no URL: never swept, so not even reachability is known. */
  spdxIdWithoutUrl: number;
}

type Release = Dataset['releases'][number];

export function buildLicenceCoverage(releases: readonly Release[]): LicenceCoverage {
  let withLicence = 0;
  let withUrl = 0;
  let withSpdxId = 0;
  let checkable = 0;
  let urlWithoutSpdxId = 0;
  let spdxIdWithoutUrl = 0;

  for (const release of releases) {
    const licence = release.license;
    if (licence === undefined) continue;
    withLicence += 1;

    const hasUrl = typeof licence.url === 'string' && licence.url.length > 0;
    const hasSpdxId = typeof licence.spdxId === 'string' && licence.spdxId.length > 0;

    if (hasUrl) withUrl += 1;
    if (hasSpdxId) withSpdxId += 1;
    if (hasUrl && hasSpdxId) checkable += 1;
    else if (hasUrl) urlWithoutSpdxId += 1;
    else if (hasSpdxId) spdxIdWithoutUrl += 1;
  }

  return { releases: releases.length, withLicence, withUrl, withSpdxId, checkable, urlWithoutSpdxId, spdxIdWithoutUrl };
}

/**
 * A map from a licence URL to the URL a request for it landed on.
 *
 * Supplied by a caller that has already fetched -- the scheduled sweep writes
 * `finalUrl` into its JSON summary. Keys are compared after canonicalisation so
 * that a summary recording `https://www.apache.org/licenses/LICENSE-2.0.txt`
 * matches a record citing the same URL with different case or a trailing slash.
 */
export type FinalUrlIndex = ReadonlyMap<string, string>;

/** The key `buildLicenceIdentityReport` looks a recorded URL up under. */
export function finalUrlKey(url: string): string {
  const parsed = parse(url.trim());
  if (parsed === null) return url.trim().toLowerCase();
  return `${parsed.protocol}//${canonicaliseHost(parsed.hostname)}${canonicalisePath(parsed.pathname)}${parsed.search}`;
}

export function buildFinalUrlIndex(entries: Iterable<{ url: string; finalUrl: string }>): FinalUrlIndex {
  const index = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry?.url !== 'string' || typeof entry?.finalUrl !== 'string') continue;
    if (entry.url.length === 0 || entry.finalUrl.length === 0) continue;
    index.set(finalUrlKey(entry.url), entry.finalUrl);
  }
  return index;
}

export interface LicenceIdentityReport {
  coverage: LicenceCoverage;
  /** Every release carrying a licence block, classified. */
  records: readonly LicenceIdentityRecord[];
  /** Counts per verdict, over the checkable population only. */
  tally: Readonly<Record<LicenceVerdict, number>>;
  /** Counts per abstention reason, over every classified record. */
  reasons: Readonly<Record<LicenceAbstentionReason, number>>;
  /**
   * How many checkable records were classified against a fetched `finalUrl`.
   *
   * The denominator that keeps an *unfetched* run from reading like a fetched
   * one that found no redirect. Zero here means no fetch evidence was supplied
   * at all, which the renderer states in those words rather than leaving the
   * absence to be inferred.
   */
  classifiedAgainstFinalUrl: number;
  redirects: number;
}

export function buildLicenceIdentityReport(
  releases: readonly Release[],
  finalUrls: FinalUrlIndex = new Map(),
): LicenceIdentityReport {
  const records: LicenceIdentityRecord[] = [];
  const tally: Record<LicenceVerdict, number> = { agrees: 0, disagrees: 0, 'cannot-determine': 0 };
  const reasons = Object.fromEntries(LICENCE_ABSTENTION_REASONS.map((reason) => [reason, 0])) as Record<
    LicenceAbstentionReason,
    number
  >;
  let classifiedAgainstFinalUrl = 0;
  let redirects = 0;

  for (const release of releases) {
    const licence = release.license;
    if (licence === undefined) continue;

    const recordedUrl = typeof licence.url === 'string' && licence.url.length > 0 ? licence.url : null;
    const spdxId = typeof licence.spdxId === 'string' && licence.spdxId.length > 0 ? licence.spdxId : null;
    const finalUrl = recordedUrl === null ? undefined : finalUrls.get(finalUrlKey(recordedUrl));

    const result = classifyLicenceIdentity({
      spdxId: spdxId ?? undefined,
      recordedUrl: recordedUrl ?? undefined,
      finalUrl,
    });

    tally[result.verdict] += 1;
    if (result.reason !== null) reasons[result.reason] += 1;
    if (result.identifiedFrom === 'final-url') classifiedAgainstFinalUrl += 1;
    if (result.redirected) redirects += 1;

    records.push({ ...result, releaseId: release.id, spdxId, recordedUrl, finalUrl: finalUrl ?? null });
  }

  return { coverage: buildLicenceCoverage(releases), records, tally, reasons, classifiedAgainstFinalUrl, redirects };
}

/** Prose for each abstention reason, so a report never prints a bare enum value. */
const REASON_PROSE: Readonly<Record<LicenceAbstentionReason, string>> = {
  'no-spdx-id': 'cites a licence URL but asserts no `spdxId`, so there is nothing to contradict',
  'no-licence-url': 'asserts an `spdxId` but cites no URL, so the sweep never sees this record at all',
  'malformed-url': 'the recorded `license.url` is not a URL',
  'malformed-final-url': 'a final URL was supplied for this record and is not a URL',
  'model-landing-page': 'URL is a model landing page; the licence is asserted in the card body, not in the URL',
  'repository-hosted-document':
    'URL is a file inside a source repository; the path names a file, and a file named `LICENSE` may be rewritten in place without its URL changing',
  'unrecognised-path-on-known-host':
    'the host is one this table knows, but this path is not a shape it can classify — worth a look, since that is the shape a mistyped path takes',
  'unrecognised-host': 'the host is not in the canonical-URL identity table',
};

/**
 * The markdown report.
 *
 * Three things it must say, and says unconditionally rather than only when they
 * happen to be interesting:
 *
 * 1. **Reachability is not correctness.** A 200 on a `license.url` is not an
 *    assertion that the licence is right, and the sweep's OK must not be read as
 *    one. #1057's first acceptance bullet asks for this where the *result* is
 *    reported, not only in a docblock.
 * 2. **A green first run is the expected result, not a null one.** This check's
 *    value is prospective: it catches a future repoint or a mistyped `spdxId`.
 *    A check whose first run is green and whose purpose is undocumented is the
 *    kind that gets deleted six months later as dead weight, so the reason to
 *    keep it is printed beside the zero.
 * 3. **What was not examined**, with its denominator, so that a coverage figure
 *    reading as "all of them" is impossible to write down.
 */
export function renderLicenceIdentityMarkdown(report: LicenceIdentityReport): string {
  const { coverage, tally, reasons } = report;
  const adjudicated = tally.agrees + tally.disagrees;
  const checkableRecords = report.records.filter(
    (record) => record.recordedUrl !== null && record.spdxId !== null,
  );
  const lines: string[] = ['## Licence URL identity cross-check', ''];

  lines.push(
    'This is an **offline** check. It makes no requests and reads no licence document bodies: it is a pure ' +
      'function of `(spdxId, recordedUrl, finalUrl)` against a canonical-URL identity table, where some URLs — ' +
      "the Apache Software Foundation's own licence paths, and OSI's register — *are* their own licence identity.",
    '',
    '**Reachability is not correctness.** The scheduled sweep over `license.url` establishes that a URL answers, ' +
      'and that is the whole of what an `OK` from it means. It cannot see a publisher repointing a dead licence URL ' +
      'at a different but live document, because that repoint answers `200` exactly as the right document does. ' +
      'This check is the part of that gap that can be closed with certainty and no new network traffic.',
    '',
  );

  lines.push(
    '### Coverage, derived from the dataset',
    '',
    '| population | count |',
    '| --- | ---: |',
    `| releases | ${coverage.releases} |`,
    `| carrying a licence block | ${coverage.withLicence} |`,
    `| carrying \`license.url\` — what the sweep fetches | ${coverage.withUrl} |`,
    `| carrying \`license.spdxId\` | ${coverage.withSpdxId} |`,
    `| carrying **both** — where a cross-check is possible at all | ${coverage.checkable} |`,
    `| URL but no \`spdxId\` — swept, and impossible to cross-check | ${coverage.urlWithoutSpdxId} |`,
    `| \`spdxId\` but no URL — never swept, so not even reachability is known | ${coverage.spdxIdWithoutUrl} |`,
    '',
    `Four populations, not three. \`${coverage.checkable} of ${coverage.withUrl}\` swept URLs can be cross-checked; ` +
      `the other ${coverage.urlWithoutSpdxId} carry no \`spdxId\`, and for most of them none exists — those licences are ` +
      'vendor-bespoke, so the field is absent because it *cannot* be filled. That is a permanent ceiling rather than a ' +
      `backlog. A further ${coverage.spdxIdWithoutUrl} records assert an \`spdxId\` with no URL and are invisible to the ` +
      'sweep entirely: neither checked nor checkable-but-unchecked.',
    '',
    'Every figure above is counted at run time. None is a literal.',
    '',
  );

  lines.push(
    '### Verdicts over the checkable population',
    '',
    `- **agrees** — ${tally.agrees}`,
    `- **disagrees** — ${tally.disagrees}`,
    `- **cannot determine** — ${checkableRecords.length - adjudicated}`,
    '',
    `${adjudicated} of ${coverage.checkable} checkable record(s) were adjudicated with certainty from URL identity alone.`,
    '',
  );

  if (report.classifiedAgainstFinalUrl === 0) {
    lines.push(
      '**No fetch evidence was supplied to this run.** Every verdict above was taken on the URL the record *cites*, ' +
        'not on the URL a request for it *lands on*. That is a statement about what was examined, not a finding: a ' +
        'server-side repoint is invisible to a run in this mode, and reading it as "no repoint was found" would be ' +
        'exactly the substitution this check exists to refuse. Supply a sweep summary to classify against `finalUrl`.',
      '',
    );
  } else {
    lines.push(
      `${report.classifiedAgainstFinalUrl} record(s) were classified against a fetched \`finalUrl\` rather than the ` +
        `recorded URL, of which ${report.redirects} landed somewhere other than the URL the record cites. A redirect ` +
        'is not itself a finding — `http` to `https` and a trailing slash are both redirects — but it is the condition ' +
        'under which a disagreement means the server repointed the document.',
      '',
    );
  }

  const disagreements = report.records.filter((record) => record.verdict === 'disagrees');
  if (disagreements.length > 0) {
    lines.push(`### Disagreements (${disagreements.length})`, '');
    for (const record of disagreements) {
      lines.push(
        `- \`${record.releaseId}\` — record asserts \`${record.spdxId}\`, but ` +
          `\`${record.identifiedFrom === 'final-url' ? record.finalUrl : record.recordedUrl}\` is the ` +
          `\`${record.identifiedSpdxId}\` licence` +
          (record.redirected ? ' (reached by redirect from the recorded URL)' : ''),
      );
    }
    lines.push(
      '',
      '**Reported, not repaired.** Nothing in `web/src/data/` is changed by this check, and nothing will be: ' +
        'repointing a record or correcting an `spdxId` is a reviewed human edit, and a comparator is not a reviewer.',
      '',
    );
  } else {
    lines.push(
      '### No disagreements',
      '',
      '**A green run is the expected result here, not a null one.** The checkable population is `Apache-2.0` and ' +
        '`MIT` cited at canonical URLs, and it was already correct — so zero findings is the instrument confirming the ' +
        'population, not the instrument failing to find work. The reason to keep this check is **prospective**: a ' +
        'future repoint to a live-but-wrong document, or a mistyped `spdxId`, stops being invisible. Nothing else in ' +
        'CI would catch either today. Do not read this zero as a reason to widen scope until something falls out.',
      '',
    );
  }

  const abstained = LICENCE_ABSTENTION_REASONS.filter((reason) => reasons[reason] > 0);
  lines.push('### Abstentions, by named structural reason', '');
  if (abstained.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push(
      'Every abstention carries a reason from an enumerable set, never free text. An abstention with a specific ' +
        'reason converts into a work item; an unexplained one is noise that gets filtered out until the check is ' +
        'deleted as dead weight.',
      '',
    );
    for (const reason of abstained) {
      lines.push(`- **\`${reason}\`** × ${reasons[reason]} — ${REASON_PROSE[reason]}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
