// Source link-health checking, as a library. The CLI beside this file
// (`check-source-links.mjs`) is a thin shell over it; everything with a decision
// in it lives here so it can be tested against fixtures instead of the network.
//
// Why this exists: ModelTree's claim is that every important fact carries a
// primary source and a verification date. When a primary link rots, the evidence
// evaporates while the site goes on asserting the fact -- a silent failure, and
// the worst kind for a source-backed product.
//
// Why it is built defensively: a naive checker that reddens on a rate limit is
// worse than no checker, because it teaches people to ignore it. The dataset's
// two largest host groups are exactly the ones that rate-limit and serve
// anti-bot responses to unfamiliar clients, so a 429 or a 403 here is the common
// case rather than a theoretical branch. The design consequence is the state
// vocabulary below: "the server refused our client" and "we could not get an
// answer" are kept apart from "the resource is gone", and only the last of those
// is ever treated as actionable.
//
// Nothing in this module reaches the network by itself. `fetch` and `sleep` are
// injected, defaulted to the real ones, so every test in `link-health.test.mjs`
// is hermetic and instant.
//
// Nothing in this module writes anything, anywhere. It reads source records and
// returns findings. Updating `lastCheckedDate`, or replacing a rotted URL, is a
// reviewed human edit and is expressly out of scope (issue #29 non-goals).
//
// ---------------------------------------------------------------------------
// WHAT A RESULT FROM THIS MODULE CANNOT ESTABLISH
// ---------------------------------------------------------------------------
//
// Written here, in the file, because this checker's entire output is a set of
// claims about resources nobody here controls, and the boundary of what it can
// actually prove is the part most easily overstated by a later reader -- or by a
// summary that says "all sources healthy". Every line below is a limit of the
// method, not a defect to be fixed:
//
//   1. `ok` means "this URL answered 2xx to this client, from this vantage
//      point, at this moment". It does NOT mean the page still supports the
//      claim the record cites it for. A vendor who rewrites an announcement in
//      place returns 200 for the old and the new text alike, and this module
//      never reads a body (checking reachability is not scraping -- a stated
//      non-goal), so content drift is invisible to it BY CONSTRUCTION. That is
//      the failure mode closest to the product's actual claim, and it is the one
//      this tool does not address.
//
//   2. Therefore `ok` can never renew a `lastCheckedDate`. That field asserts a
//      human read the page and found the fact in it. Nothing here observes that,
//      which is the reason this module writes nothing rather than merely being
//      configured not to.
//
//   3. An actionable count of zero does NOT mean every recorded URL is alive. A
//      genuinely dead URL behind a rate limiter reports `blocked`, and `blocked`
//      is deliberately not actionable. The design trades false negatives for
//      false positives on purpose, so a clean sweep is evidence of "nothing
//      proven rotten", never of "everything verified".
//
//   4. `blocked` and `transient` are the absence of a verdict, not a benign one.
//      A run in which every request was refused produces the same actionable
//      count as a run in which every request succeeded. Read the per-state
//      counts from `summarise`, never the actionable count alone.
//
//   5. A soft 404 -- 200 with "page not found" in the body -- is reported `ok`.
//      Detecting one requires reading bodies, see (1).
//
//   6. The observation is single-vantage and single-moment. A CI runner's IP
//      gets CDN, geo and anti-bot treatment that a human browser does not, so a
//      403 here may be a 200 to a reader and vice versa. Nothing here
//      establishes what any particular person will see, nor what the URL served
//      yesterday or will serve tomorrow.
//
//   7. It cannot establish that a URL is the RIGHT source for the record citing
//      it. Whether the citation supports the claim is an editorial judgement and
//      is out of scope.
//
//   8. De-duplication is proven by fixture, not by the dataset. At the time of
//      writing every URL in `sources.json` is unique, so the real data exercises
//      that path zero times and a green suite is not evidence it works. See the
//      test file, which counts requests issued rather than results returned.
//
//   9. `normalised` says a redirect is a property of the host, and nothing more.
//      It is established by asking the host about a path that does not exist and
//      watching it receive the identical rewrite -- which proves the rewrite is
//      blind, because the host cannot know a segment this tool invented. It does
//      NOT establish that the recorded URL is the publisher's canonical one, and
//      it deliberately covers only a trailing slash: see the section on host
//      normalisation below for why a scheme or host rewrite stays actionable.

/** The resource answered. No redirect, or only temporary ones. */
export const OK = 'ok';
/** The resource answered, but only after a permanent redirect: the recorded URL is stale. */
export const REDIRECTED = 'redirected';
/** The server deliberately refused this client. Says nothing about whether the resource exists. */
export const BLOCKED = 'blocked';
/** No verdict was obtained. Retrying later plausibly gets one. */
export const TRANSIENT = 'transient';
/** The resource is gone. This is the only state that means the evidence has actually rotted. */
export const BROKEN = 'broken';
/** A reviewed exclusion suppressed the check. */
export const EXCLUDED = 'excluded';
/**
 * The resource answered 2xx through a permanent redirect that this host applies
 * to every path, including one that does not exist. The redirect is a property
 * of the host, not evidence about the recorded URL.
 */
export const NORMALISED = 'normalised';

/**
 * The states worth a maintainer's attention.
 *
 * `blocked` and `transient` are deliberately absent, and that absence is the
 * single most important decision in this file. Both are properties of the
 * checker's conversation with a server, not of the source. Promoting either to
 * actionable is how a link checker becomes noise, and the issue's non-goals rule
 * it out in as many words.
 *
 * `normalised` is absent for the same reason and by the same test, applied to a
 * redirect rather than to a status: a rewrite that a fabricated path receives
 * just as readily says nothing about the URL that received it. The difference is
 * that this one is *measured* per host rather than assumed -- see
 * `explainHostNormalisation`.
 */
export const ACTIONABLE_STATES = new Set([BROKEN, REDIRECTED]);

/**
 * Statuses that mean the resource is gone, rather than that we were refused.
 *
 * Deliberately just these two. A 400 or a 403 to a HEAD from an unfamiliar user
 * agent is overwhelmingly an anti-bot response rather than evidence of rot, and
 * calling one "broken" is precisely the false positive that trains people to
 * ignore the report.
 */
const BROKEN_STATUSES = new Set([404, 410]);

/** Statuses that are explicitly "try again", so they never reach a verdict on their own. */
const RETRY_STATUSES = new Set([408, 425, 429]);

/**
 * Statuses where a site is known to answer HEAD differently from GET. A CDN
 * refusing HEAD is common enough that treating it as a finding would bury the
 * real ones, so the check escalates to GET once and judges that instead.
 *
 * The escalated request still never reads the response body -- see
 * `discardBody`. The issue's non-goals forbid scraping source content, and
 * asking whether a URL resolves is not the same as reading what it says.
 */
const METHOD_ESCALATION_STATUSES = new Set([400, 403, 405, 406, 501]);

/** 3xx codes that mean "this URL has moved for good", so the recorded URL is stale. */
const PERMANENT_REDIRECTS = new Set([301, 308]);

/**
 * The path segment substituted into a fabricated control URL.
 *
 * Fixed rather than random, for two reasons. It is reproducible, so a control
 * result can be cached across the targets sharing a host and a later reader can
 * re-run the exact request by hand. And it names the tool, so a webmaster
 * meeting it in a log knows what asked and why. A host that has somehow created
 * this path answers 2xx instead of redirecting, which fails the control and
 * leaves the finding actionable -- the safe direction.
 */
const CONTROL_SEGMENT = 'modeltree-link-health-control-does-not-exist';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A reason shorter than this is treated as absent.
 *
 * The floor is arbitrary and is kept anyway. "Exclusions require a reason" is
 * satisfied by `"x"` under a merely-non-empty test, which meets the letter of
 * the acceptance criterion while abandoning its purpose: an exclusion is a claim
 * that a human looked at this URL and decided the checker is wrong about it, and
 * a one-character reason cannot carry that. A floor makes a placeholder fail
 * loudly where it is written rather than quietly a year later.
 */
const MINIMUM_REASON_LENGTH = 20;

export const DEFAULTS = Object.freeze({
  /** Requests in flight across all hosts. Small on purpose: politeness beats speed on a weekly job. */
  concurrency: 4,
  /** Attempts per URL, including the first. Bounded so a dead host cannot stall the run. */
  attempts: 3,
  /** Per-attempt deadline. */
  timeoutMs: 15_000,
  /** First backoff step; doubles per attempt, capped by `maxBackoffMs`. */
  backoffMs: 1_000,
  maxBackoffMs: 30_000,
  /** Redirect hops followed before the chain is called a loop. */
  maxRedirects: 5,
  /** Spacing between consecutive requests to the same host, on top of per-host serialisation. */
  hostDelayMs: 250,
  /**
   * A descriptive user agent naming the project and a contact URL. This is not
   * decoration: an unfamiliar or absent user agent is what most of the anti-bot
   * responses in this dataset's host mix are triggered by, so this string is
   * load-bearing for the false-positive rate.
   */
  userAgent:
    'ModelTree-link-health/1.0 (+https://github.com/abdeslam-menacere/ModelTree; source link verification; HEAD/GET only, no content read)',
});

/* -------------------------------------------------------------------------- */
/* Extraction and de-duplication                                              */
/* -------------------------------------------------------------------------- */

/**
 * The key two source records must share to count as the same request.
 *
 * The fragment is dropped because it is never sent to the server, so two records
 * differing only by `#section` are the same request by definition. Nothing else
 * is normalised: a trailing slash, a query parameter, or letter case in a path
 * can all change what a server returns, so folding them would make the checker
 * verify a URL nobody recorded.
 *
 * Returns null for anything that is not an absolute http(s) URL, which the
 * caller reports rather than silently drops.
 */
export function canonicaliseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  parsed.hash = '';
  return parsed.toString();
}

/**
 * Collapse source records into the set of URLs actually worth requesting.
 *
 * A measurement, so the reader knows what this buys today: when this was
 * written, `web/src/data/sources.json` held no duplicate URL at all, so
 * de-duplication removed exactly zero requests. It is here for two other
 * reasons, both of which apply now. First, the dataset grows continuously and
 * one announcement post is a plausible citation for several records. Second, and
 * independent of duplicates ever appearing: grouping is what lets a single
 * result name *every* affected record slug, which the issue requires of the
 * report. A per-record loop cannot report that without the group.
 */
export function extractTargets(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('extractTargets expects an array of source records');
  }

  const byUrl = new Map();
  const malformed = [];

  for (const [index, record] of records.entries()) {
    const id = typeof record?.id === 'string' ? record.id : null;
    const where = id ?? `record at index ${index}`;
    const raw = record?.url;

    if (typeof raw !== 'string' || raw.trim().length === 0) {
      malformed.push({ id, url: null, reason: 'record carries no url string', where });
      continue;
    }

    const canonical = canonicaliseUrl(raw);
    if (canonical === null) {
      malformed.push({ id, url: raw, reason: 'url is not an absolute http(s) URL', where });
      continue;
    }

    let target = byUrl.get(canonical);
    if (target === undefined) {
      target = {
        canonical,
        host: new URL(canonical).host,
        recordIds: [],
        titles: [],
        rawUrls: [],
      };
      byUrl.set(canonical, target);
    }

    if (id !== null && !target.recordIds.includes(id)) target.recordIds.push(id);
    if (typeof record?.title === 'string' && record.title.length > 0 && !target.titles.includes(record.title)) {
      target.titles.push(record.title);
    }
    if (!target.rawUrls.includes(raw)) target.rawUrls.push(raw);
  }

  return { targets: [...byUrl.values()], malformed };
}

/**
 * Narrow a target list to the URLs a change actually introduced.
 *
 * This is what makes a pull-request run targeted rather than a full sweep: a
 * pull request is answerable for the sources it adds or edits and for nothing
 * else, and re-checking eighty-odd untouched URLs on every data change is how a
 * check earns a reputation for flaking on things its author never wrote.
 *
 * The comparison is on the (record id, canonical URL) pair, so re-pointing an
 * existing record at a new URL counts as new work while a record that only had
 * its title corrected does not.
 */
export function selectChanged(targets, baselineRecords) {
  const baseline = new Set();

  for (const record of Array.isArray(baselineRecords) ? baselineRecords : []) {
    const canonical = canonicaliseUrl(record?.url);
    if (canonical === null) continue;
    baseline.add(`${typeof record?.id === 'string' ? record.id : ''}\u0000${canonical}`);
  }

  return targets.filter((target) =>
    target.recordIds.length === 0
      ? !baseline.has(`\u0000${target.canonical}`)
      : target.recordIds.some((id) => !baseline.has(`${id}\u0000${target.canonical}`)),
  );
}

/* -------------------------------------------------------------------------- */
/* Reviewed exclusions                                                        */
/* -------------------------------------------------------------------------- */

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  // Left on `Date.UTC` on purpose (#596). The remap that makes a year in 0-99
  // read as 1900-1999 is a defect, but it is also the only thing here that
  // refuses such a year: this tool carries no 1950 floor, so unlike
  // `gate-dataset.mjs` there is no second rule to catch the value once this
  // one stops rejecting it. Measured, committed against patched, an exclusion
  // dated `reviewedOn "0049-12-31"` moves from refused-as-unreal to accepted.
  // Removing the remap is therefore a decision about what an exclusion may be
  // dated, which #596 does not ask for and did not decide.
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Validate the reviewed-exclusions document.
 *
 * Every problem is an error rather than a skipped entry, and the caller is
 * expected to refuse to run rather than continue. An exclusions file is the one
 * place in this tool where a mistake makes the checker quieter, so a malformed
 * one must not be able to degrade into "checked nothing, found nothing, green".
 */
export function parseExclusions(document) {
  const errors = [];
  const entries = [];

  if (!Array.isArray(document)) {
    return { entries, errors: ['the exclusions document is not a JSON array'] };
  }

  const seen = new Map();

  for (const [index, entry] of document.entries()) {
    const where = `exclusion at index ${index}`;

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${where}: is not an object`);
      continue;
    }

    const canonical = canonicaliseUrl(entry.url);
    if (canonical === null) {
      errors.push(`${where}: url is missing or is not an absolute http(s) URL`);
      continue;
    }

    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (reason.length < MINIMUM_REASON_LENGTH) {
      errors.push(
        `${where} (${canonical}): reason must be at least ${MINIMUM_REASON_LENGTH} characters explaining why the checker is wrong about this URL`,
      );
    }

    if (!isRealDate(entry.reviewedOn)) {
      errors.push(`${where} (${canonical}): reviewedOn must be a real YYYY-MM-DD date`);
    }

    if (!isRealDate(entry.expiresOn)) {
      errors.push(`${where} (${canonical}): expiresOn must be a real YYYY-MM-DD date`);
    }

    if (isRealDate(entry.reviewedOn) && isRealDate(entry.expiresOn) && entry.expiresOn <= entry.reviewedOn) {
      errors.push(`${where} (${canonical}): expiresOn must fall after reviewedOn`);
    }

    if (seen.has(canonical)) {
      errors.push(`${where} (${canonical}): duplicates the exclusion at index ${seen.get(canonical)}`);
    } else {
      seen.set(canonical, index);
    }

    entries.push({
      canonical,
      url: entry.url,
      reason,
      reviewedOn: entry.reviewedOn ?? null,
      expiresOn: entry.expiresOn ?? null,
    });
  }

  return { entries, errors };
}

/**
 * Split targets into the ones a live exclusion covers and the ones to check.
 *
 * An expired exclusion suppresses nothing. It puts its target back in the
 * checked set *and* raises a finding of its own, because the expiry date is what
 * the review date promises: it is the thing that stops an exclusion written once
 * from silencing a URL forever. An exclusion that quietly kept working past its
 * own expiry would be strictly worse than none, since the file would then read
 * as reviewed when it is not.
 */
export function applyExclusions(targets, entries, today) {
  const live = new Map();
  const expired = new Map();

  for (const entry of entries) {
    if (typeof entry.expiresOn === 'string' && entry.expiresOn < today) expired.set(entry.canonical, entry);
    else live.set(entry.canonical, entry);
  }

  const checked = [];
  const excluded = [];
  const expiredFindings = [];

  for (const target of targets) {
    const liveEntry = live.get(target.canonical);
    if (liveEntry !== undefined) {
      excluded.push({ ...target, state: EXCLUDED, exclusion: liveEntry });
      continue;
    }

    const expiredEntry = expired.get(target.canonical);
    if (expiredEntry !== undefined) {
      expiredFindings.push({ ...target, exclusion: expiredEntry });
      checked.push({ ...target, expiredExclusion: expiredEntry });
      continue;
    }

    checked.push(target);
  }

  const present = new Set(targets.map((target) => target.canonical));
  const unmatched = [...live.values(), ...expired.values()].filter((entry) => !present.has(entry.canonical));

  return { checked, excluded, expired: expiredFindings, unmatched };
}

/* -------------------------------------------------------------------------- */
/* Requesting                                                                 */
/* -------------------------------------------------------------------------- */

function withDefaults(options = {}) {
  const provided = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));

  const merged = {
    ...DEFAULTS,
    fetchImpl: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...provided,
  };

  // Shared across a whole run when `checkAll` builds it, and created here for a
  // standalone `checkTarget` so the function still works on its own.
  if (!(merged.normalisationCache instanceof Map)) merged.normalisationCache = new Map();

  return merged;
}

/**
 * Release the response body without reading it.
 *
 * Two reasons, and the first is a correctness one: an undrained body holds its
 * socket open, and enough of them stall a bounded-concurrency run. The second is
 * the issue's non-goal -- this tool checks that a URL resolves and never looks
 * at what it says.
 */
async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // A body that cannot be cancelled has already been consumed or was never
    // there (HEAD). Neither affects the verdict.
  }
}

function retryAfterMs(response, now) {
  const header = response?.headers?.get?.('retry-after');
  if (typeof header !== 'string' || header.trim().length === 0) return null;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - now());

  return null;
}

/**
 * Map an HTTP status onto a state.
 *
 * The 4xx default is `blocked`, not `broken`, and that is the conservative
 * choice on purpose: outside 404 and 410, a 4xx from a site that dislikes
 * automated clients tells us about our request rather than about the resource.
 * Calling those broken would put a working source in the maintenance issue,
 * which costs far more trust than missing one rotted link for a week.
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return OK;
  if (BROKEN_STATUSES.has(status)) return BROKEN;
  if (RETRY_STATUSES.has(status)) return status === 429 ? BLOCKED : TRANSIENT;
  if (status >= 500) return TRANSIENT;
  if (status >= 400) return BLOCKED;
  return TRANSIENT;
}

function describeError(error) {
  const code = error?.cause?.code ?? error?.code ?? null;
  const name = error?.name ?? 'Error';
  const message = error?.message ?? String(error);
  return { name, code, message: code === null ? message : `${message} (${code})` };
}

function request(url, method, opts) {
  const init = {
    method,
    redirect: 'manual',
    headers: { 'user-agent': opts.userAgent, accept: '*/*' },
  };

  if (opts.timeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
    init.signal = AbortSignal.timeout(opts.timeoutMs);
  }

  return opts.fetchImpl(url, init);
}

/**
 * Walk one URL's redirect chain and return the raw observation, unclassified.
 *
 * Redirects are followed by hand rather than by `redirect: 'follow'` because the
 * classification needs the shape of the chain, not just its endpoint. A
 * permanent redirect means the recorded URL is stale and someone should fix the
 * record; a temporary one means the recorded URL is still correct and there is
 * nothing to do. `redirect: 'follow'` collapses the two into an identical 200.
 */
async function walkRedirects(target, opts) {
  const hops = [];
  let current = target.canonical;
  let sawPermanent = false;

  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    let method = 'HEAD';
    let response = await request(current, method, opts);

    if (METHOD_ESCALATION_STATUSES.has(response.status)) {
      await discardBody(response);
      method = 'GET';
      response = await request(current, method, opts);
    }

    await discardBody(response);
    const status = response.status;

    if (REDIRECT_STATUSES.has(status)) {
      const location = response.headers?.get?.('location');
      if (typeof location !== 'string' || location.trim().length === 0) {
        // A redirect with nowhere to go is a server fault, not evidence about
        // the resource, so it resolves to "no verdict" rather than to a finding.
        return { outcome: 'redirect-without-location', status, hops, sawPermanent, finalUrl: current, method };
      }

      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        return { outcome: 'redirect-location-unparseable', status, hops, sawPermanent, finalUrl: current, method };
      }

      if (PERMANENT_REDIRECTS.has(status)) sawPermanent = true;
      hops.push({ from: current, to: next, status });
      current = next;
      continue;
    }

    return {
      outcome: 'status',
      status,
      hops,
      sawPermanent,
      finalUrl: current,
      method,
      retryAfterMs: retryAfterMs(response, opts.now),
    };
  }

  return { outcome: 'too-many-redirects', status: null, hops, sawPermanent, finalUrl: current, method: 'HEAD' };
}

/* -------------------------------------------------------------------------- */
/* Host normalisation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Why this exists.
 *
 * Some hosts rewrite every request path before routing it. `nousresearch.com`
 * strips a trailing slash from anything: `/releases/` 308s to `/releases` and so
 * does `/a-path-nobody-ever-created/`, which then 404s. A 308 from a host like
 * that carries no information about whether the URL that received it is valid --
 * it is emitted just as readily for a path that does not exist.
 *
 * Reported as `redirected`, such a hop is a finding no workflow can resolve. The
 * dataset holds what the publisher's own `rel="canonical"` declares, so there is
 * nothing to correct; the alternative remedy, a reviewed exclusion, asserts that
 * a *human* looked at the URL, which no automated run can truthfully write. The
 * finding would therefore re-report for ever. Measuring the host's behaviour
 * removes it without weakening either guard, and the measurement validates
 * itself: the host cannot know a segment this tool invented, so a rewrite that
 * survives on the fabricated path is demonstrably blind.
 *
 * ## The deliberately narrow boundary
 *
 * Only a trailing slash, on the same scheme and the same host, is ever explained
 * away. A `http` -> `https` upgrade or an apex -> `www` rewrite is just as
 * host-wide and just as mechanical, and both stay `redirected` on purpose:
 * editing the record to the upgraded URL genuinely resolves those, and there is
 * no conflicting authority about which form the publisher wants. The trailing
 * slash is the case where the publisher's edge and the publisher's markup
 * disagree with each other, and a link checker is not the thing that should
 * adjudicate that.
 *
 * A redirect that changes the path at all is never explained away either, so
 * this can not hide a page that genuinely moved.
 */

/**
 * Describe a redirect that changes nothing but a trailing slash.
 *
 * Returns `'added'`, `'removed'`, or null. Null covers every difference that is
 * not a trailing slash -- a different scheme, host, path, or query -- and is what
 * keeps the boundary above narrow, so it is a refusal rather than an error.
 */
export function slashNormalisation(fromUrl, toUrl) {
  let from;
  let to;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    return null;
  }

  if (from.protocol !== to.protocol || from.host !== to.host || from.search !== to.search) return null;

  const trailing = (path) => path.length > 1 && path.endsWith('/');
  const strip = (path) => (trailing(path) ? path.slice(0, -1) : path);

  if (strip(from.pathname) !== strip(to.pathname)) return null;
  if (trailing(from.pathname) === trailing(to.pathname)) return null;

  return trailing(to.pathname) ? 'added' : 'removed';
}

/**
 * A sibling of this URL that cannot exist, in the same directory and with the
 * same trailing-slash shape.
 *
 * Same directory and same shape because the claim being tested is "this host
 * rewrites paths without looking at them", and a control that differed in depth
 * or in shape would be answered by a different rule. Returns null for anything
 * unparseable.
 */
export function fabricateControlUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const path = url.pathname;
  const trailing = path.length > 1 && path.endsWith('/');
  const segments = (trailing ? path.slice(0, -1) : path).split('/');
  segments[segments.length - 1] = CONTROL_SEGMENT;
  url.pathname = `${segments.join('/')}${trailing ? '/' : ''}`;

  return url.toString();
}

/**
 * Ask the host about the fabricated path, once, and report only what it said.
 *
 * One attempt and no retry budget: a control that cannot be obtained leaves the
 * redirect actionable, which is the conservative reading and costs at most one
 * more week of reporting a finding that was already being reported.
 */
async function observeControl(controlUrl, opts) {
  let response;

  try {
    response = await request(controlUrl, 'HEAD', opts);
    if (METHOD_ESCALATION_STATUSES.has(response.status)) {
      await discardBody(response);
      response = await request(controlUrl, 'GET', opts);
    }
  } catch (error) {
    return { url: controlUrl, status: null, location: null, error: describeError(error) };
  }

  await discardBody(response);
  const location = response.headers?.get?.('location');

  return {
    url: controlUrl,
    status: response.status,
    location: typeof location === 'string' && location.trim().length > 0 ? location : null,
    error: null,
  };
}

/**
 * The control probe, memoised per fabricated URL.
 *
 * Every URL on a host that shares a directory and a trailing-slash shape
 * fabricates the same control, so a host with many redirected URLs is asked
 * once. A control that produced no status is not cached: one blip must not
 * decide the classification of every other redirect on that host for the rest of
 * the run.
 */
async function probeControl(controlUrl, opts) {
  const cached = opts.normalisationCache.get(controlUrl);
  if (cached !== undefined) return cached;

  if (opts.hostDelayMs > 0) await opts.sleep(opts.hostDelayMs);
  const control = await observeControl(controlUrl, opts);
  if (control.status !== null) opts.normalisationCache.set(controlUrl, control);

  return control;
}

/**
 * Establish whether every permanent hop in a chain is host-wide normalisation.
 *
 * All of them, or none: a chain with one explained hop and one unexplained one
 * still contains a redirect that says something about this URL, and reporting it
 * is the point. Returns the evidence so the report can show its working, or null
 * if the chain is not explained.
 */
async function explainHostNormalisation(hops, opts) {
  const permanent = hops.filter((hop) => PERMANENT_REDIRECTS.has(hop.status));
  if (permanent.length === 0) return null;

  const evidence = [];

  for (const hop of permanent) {
    const direction = slashNormalisation(hop.from, hop.to);
    if (direction === null) return null;

    const controlUrl = fabricateControlUrl(hop.from);
    if (controlUrl === null) return null;

    const control = await probeControl(controlUrl, opts);
    if (control.status !== hop.status || control.location === null) return null;

    let controlTo;
    try {
      controlTo = new URL(control.location, control.url).toString();
    } catch {
      return null;
    }

    if (slashNormalisation(control.url, controlTo) !== direction) return null;

    evidence.push({
      from: hop.from,
      to: hop.to,
      status: hop.status,
      direction,
      controlUrl,
      controlStatus: control.status,
      controlTo,
    });
  }

  return { hops: evidence };
}

/** Turn a raw observation into one of the five states. */
export function classifyObservation(observation) {
  switch (observation.outcome) {
    case 'too-many-redirects':
      // Actionable: a chain this long is either a loop or a URL that has moved
      // more than once, and either way the recorded URL should be replaced.
      return REDIRECTED;
    case 'redirect-without-location':
    case 'redirect-location-unparseable':
      return TRANSIENT;
    case 'error':
      return TRANSIENT;
    default: {
      const base = classifyStatus(observation.status);
      if (base === OK && observation.sawPermanent) return REDIRECTED;
      return base;
    }
  }
}

/**
 * Check one URL, retrying only what retrying can help.
 *
 * A 429 is retried and then, if it persists, settles as `blocked` rather than
 * `transient`. That is deliberate: after the full budget of refusals, spaced by
 * the server's own `Retry-After`, "we are being rate-limited" is a stable fact
 * about the relationship rather than a blip -- but it is still not evidence
 * about the resource, so it stays out of the actionable set either way.
 *
 * A network error, a timeout, and a 5xx are all retried and all settle as
 * `transient`, which is the state that says "no verdict" rather than "fine".
 *
 * A settled `redirected` gets one more question asked about it, and only then:
 * whether this host hands the same rewrite to a path that does not exist. The
 * probe costs at most one request per host per directory shape and never runs on
 * a result that was not going to be reported, so the common case pays nothing.
 */
export async function checkTarget(target, options = {}) {
  const opts = withDefaults(options);
  const attempts = [];
  let observation = null;
  let state = TRANSIENT;

  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      observation = await walkRedirects(target, opts);
    } catch (error) {
      observation = { outcome: 'error', status: null, hops: [], sawPermanent: false, error: describeError(error) };
    }

    state = classifyObservation(observation);
    attempts.push({ attempt, state, status: observation.status ?? null, outcome: observation.outcome });

    const retryable = state === TRANSIENT || observation.status === 429;
    if (!retryable || attempt === opts.attempts) break;

    const exponential = Math.min(opts.backoffMs * 2 ** (attempt - 1), opts.maxBackoffMs);
    const suggested = observation.retryAfterMs ?? 0;
    await opts.sleep(Math.min(Math.max(exponential, suggested), opts.maxBackoffMs));
  }

  // Only a chain that reached a 2xx is a candidate. `too-many-redirects` has no
  // endpoint to have normalised, and a chain landing on a 404 is `broken` for a
  // reason the redirect had nothing to do with.
  let normalisation = null;
  if (state === REDIRECTED && observation?.outcome === 'status' && classifyStatus(observation.status) === OK) {
    normalisation = await explainHostNormalisation(observation.hops, opts);
    if (normalisation !== null) state = NORMALISED;
  }

  return {
    ...target,
    state,
    status: observation?.status ?? null,
    outcome: observation?.outcome ?? 'error',
    finalUrl: observation?.finalUrl ?? target.canonical,
    hops: observation?.hops ?? [],
    method: observation?.method ?? 'HEAD',
    error: observation?.error ?? null,
    normalisation,
    attempts,
  };
}

/**
 * Check every target under a global concurrency cap and one request per host.
 *
 * The per-host limit is the part that matters for this dataset. Its largest host
 * group is big enough that a naive pool would open several parallel connections
 * to the same site and manufacture the very rate-limit responses this tool is
 * built to tolerate -- a checker whose own impatience creates its false
 * positives. Hosts are drained sequentially with `hostDelayMs` between requests,
 * and a worker that finishes one host picks up another.
 */
export async function checkAll(targets, options = {}) {
  const opts = withDefaults(options);
  const results = new Array(targets.length);

  const hostQueues = new Map();
  for (const [index, target] of targets.entries()) {
    const queue = hostQueues.get(target.host) ?? [];
    queue.push({ index, target });
    hostQueues.set(target.host, queue);
  }

  const pending = [...hostQueues.values()];
  let nextQueue = 0;

  const worker = async () => {
    for (;;) {
      const queue = pending[nextQueue];
      if (queue === undefined) return;
      nextQueue += 1;

      for (const [position, { index, target }] of queue.entries()) {
        if (position > 0 && opts.hostDelayMs > 0) await opts.sleep(opts.hostDelayMs);
        results[index] = await checkTarget(target, opts);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(opts.concurrency, pending.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

export function summarise(results, extra = {}) {
  const counts = {
    [OK]: 0,
    [REDIRECTED]: 0,
    [BLOCKED]: 0,
    [TRANSIENT]: 0,
    [BROKEN]: 0,
    [EXCLUDED]: 0,
    [NORMALISED]: 0,
  };
  for (const result of results) counts[result.state] = (counts[result.state] ?? 0) + 1;

  const actionable = results.filter(
    (result) => ACTIONABLE_STATES.has(result.state) || result.expiredExclusion !== undefined,
  );

  return {
    checkedUrls: results.length,
    counts,
    actionableUrls: actionable.length,
    affectedRecordIds: [...new Set(actionable.flatMap((result) => result.recordIds))].sort(),
    ...extra,
  };
}

/** A human label for a URL, never the bare URL on its own (accessibility requirement). */
function label(result) {
  if (Array.isArray(result.titles) && result.titles.length > 0) return result.titles[0];
  const url = new URL(result.canonical);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

function recordList(result) {
  return result.recordIds.length === 0
    ? '_no source record id_'
    : result.recordIds.map((id) => `\`${id}\``).join(', ');
}

function detail(result) {
  if (result.state === BROKEN || result.state === BLOCKED) return `HTTP ${result.status}`;

  if (result.state === REDIRECTED) {
    if (result.outcome === 'too-many-redirects') return 'redirect chain longer than the hop budget';
    const last = result.hops.at(-1);
    return `permanently redirected to ${last === undefined ? result.finalUrl : last.to}`;
  }

  if (result.state === NORMALISED) {
    const first = result.normalisation?.hops?.[0];
    const rule =
      first?.direction === 'added' ? 'adds a trailing slash to' : 'strips a trailing slash from';
    return `resolves; this host ${rule} every path`;
  }

  if (result.state === TRANSIENT) {
    if (result.error !== null && result.error !== undefined) return `request failed: ${result.error.message}`;
    if (result.status !== null) return `HTTP ${result.status}`;
    return result.outcome;
  }

  return `HTTP ${result.status ?? '-'}`;
}

function section(heading, results, note) {
  if (results.length === 0) return [];

  const lines = [`### ${heading} (${results.length})`, ''];
  if (note !== undefined) lines.push(note, '');

  for (const result of results) {
    lines.push(`- [${label(result)}](${result.canonical}) — ${detail(result)}`);
    lines.push(`  - Affected source records: ${recordList(result)}`);
    if (result.expiredExclusion !== undefined) {
      lines.push(
        `  - Its exclusion expired on ${result.expiredExclusion.expiresOn} and needs re-reviewing: ${result.expiredExclusion.reason}`,
      );
    }
    // The measurement, printed rather than summarised, because "not a finding"
    // is only worth reading if the reader can check the reasoning that made it
    // one -- and re-run the control request by hand from this line alone.
    for (const hop of result.normalisation?.hops ?? []) {
      lines.push(
        `  - \`${hop.from}\` → HTTP ${hop.status} → \`${hop.to}\`, and the fabricated control ` +
          `\`${hop.controlUrl}\` → HTTP ${hop.controlStatus} → \`${hop.controlTo}\`. The host cannot know ` +
          'that control path, so the rewrite is blind and says nothing about the recorded URL.',
      );
    }
  }

  lines.push('');
  return lines;
}

/**
 * Render the report.
 *
 * Structured with headings and lists, and every link carries the source's own
 * title as its text rather than being a bare URL, because the issue's
 * accessibility requirement asks for descriptive labels and a screen reader
 * announcing eighty raw URLs is unusable.
 *
 * The actionable sections come first and the non-actionable ones say so in their
 * own headings, so a reader who stops after the first screen has read the part
 * that needed them.
 */
export function renderReport(
  results,
  { excluded = [], malformed = [], unmatchedExclusions = [], scope = 'the full seed dataset' } = {},
) {
  const summary = summarise(results);
  const byState = (state) => results.filter((result) => result.state === state);
  const expired = results.filter((result) => result.expiredExclusion !== undefined);

  const lines = ['## Source link health', ''];

  lines.push(
    `Checked ${summary.checkedUrls} unique URL(s) from ${scope}. ` +
      `${summary.actionableUrls} need attention. ` +
      `${byState(BLOCKED).length} were refused by the site and ${byState(TRANSIENT).length} gave no answer; ` +
      'neither is evidence that a source has rotted. ' +
      `${byState(NORMALISED).length} were redirected by host-wide path normalisation, which is not evidence either.`,
    '',
  );

  lines.push(
    ...section(
      'Definitively broken',
      byState(BROKEN),
      'The server answered that the resource is gone. These citations no longer support the facts resting on them.',
    ),
  );

  lines.push(
    ...section(
      'Permanently moved',
      byState(REDIRECTED),
      'These resolve, but only through a permanent redirect, so the recorded URL is stale. Replacing a source URL is a reviewed human edit; this report never does it.',
    ),
  );

  if (expired.length > 0) {
    lines.push(`### Expired exclusions (${expired.length})`, '');
    lines.push(
      'These exclusions are past their expiry date, so they suppress nothing and need re-reviewing.',
      '',
    );
    for (const result of expired) {
      lines.push(
        `- [${label(result)}](${result.canonical}) — expired ${result.expiredExclusion.expiresOn}, reviewed ${result.expiredExclusion.reviewedOn}`,
      );
      lines.push(`  - Original reason: ${result.expiredExclusion.reason}`);
      lines.push(`  - Affected source records: ${recordList(result)}`);
    }
    lines.push('');
  }

  lines.push(
    ...section(
      'Refused by the site — not actionable',
      byState(BLOCKED),
      'The server declined this client. That says nothing about whether a person can open the page, so none of it is treated as a finding.',
    ),
  );

  lines.push(
    ...section(
      'No answer — not actionable',
      byState(TRANSIENT),
      'Timeouts, network errors, and server errors, after the full retry budget. Retried on the next run.',
    ),
  );

  lines.push(
    ...section(
      'Host path normalisation — not actionable',
      byState(NORMALISED),
      'These resolve through a permanent redirect that the host applies to every path, including a fabricated one that cannot exist. The redirect is a property of the host rather than of the recorded URL, so there is nothing in the dataset that would remove it. The control request is shown under each entry.',
    ),
  );

  if (excluded.length > 0) {
    lines.push(`### Excluded by review (${excluded.length})`, '');
    for (const result of excluded) {
      lines.push(`- [${label(result)}](${result.canonical}) — excluded until ${result.exclusion.expiresOn}`);
      lines.push(`  - Reason: ${result.exclusion.reason}`);
      lines.push(`  - Affected source records: ${recordList(result)}`);
    }
    lines.push('');
  }

  if (malformed.length > 0) {
    lines.push(`### Source records that could not be checked (${malformed.length})`, '');
    for (const entry of malformed) {
      lines.push(`- \`${entry.where}\` — ${entry.reason}`);
    }
    lines.push('');
  }

  if (unmatchedExclusions.length > 0) {
    lines.push(`### Exclusions matching no source record (${unmatchedExclusions.length})`, '');
    lines.push('Housekeeping: the record each was written for is gone, so the exclusion can be deleted.', '');
    for (const entry of unmatchedExclusions) {
      lines.push(`- \`${entry.canonical}\` — ${entry.reason}`);
    }
    lines.push('');
  }

  if (summary.actionableUrls === 0) {
    lines.push(
      byState(NORMALISED).length === 0
        ? 'No source URL is definitively broken or permanently moved.'
        : 'No source URL is definitively broken or permanently moved. The permanent redirects seen were host-wide path normalisation, each measured against a fabricated control path on the same host.',
      '',
    );
  }

  return lines.join('\n');
}
