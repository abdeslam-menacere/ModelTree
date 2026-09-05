# Source link health

Checks that recorded URLs still resolve, and reports what it finds. It reads the
dataset and **writes nothing back** — not a replacement URL, not a
`lastCheckedDate`. Both of those are claims that a human verified something, and
a link checker is not a human.

Two kinds of URL are swept, and they are kept apart end to end:

| kind | lives in | requested on |
|---|---|---|
| a **primary source** cited as evidence | `record.url` in `web/src/data/sources.json` | every run — narrowed to what the diff introduced on a pull request |
| a **licence pointer** | `record.license.url` in `web/src/data/releases.json` | the scheduled sweep and the manual dispatch only |

```
node .github/scripts/source-link-health/check-source-links.mjs --dry-run
node .github/scripts/source-link-health/check-source-links.mjs --report report.md --json summary.json
```

Run by [`.github/workflows/source-link-health.yml`](../../workflows/source-link-health.yml).

## Licence URLs, and why only the clock asks about them

See [ADR 0017](../../../docs/adr/0017-licence-urls-are-swept-on-the-clock-not-on-the-diff.md).
The short version, because it is easy to read the asymmetry as an oversight:

A `license.url` is not a citation. Nothing registers it, nothing ties it to a
source record, and until #931 nothing fetched it — 57 releases asserted where a
licence lived and no instrument had ever asked. Two of those URLs had rotted by
the time anybody looked.

Both rotted *upstream*, after a human had verified them, with no change in this
repository involved. A diff-scoped check inspects what a diff touches, so it
cannot see that: it would have been green before the URL died and green after.
Only a run on a clock re-asks the question, which is why licence URLs are
requested on the schedule and never on a pull request.

The scope is derived from the absence of `--baseline` rather than from a flag of
its own, so there is no way to spell "sweep, but skip the licence URLs". Both
directions are pinned by tests.

`--dry-run` is the exception and it is free: the workflow runs it with no
baseline on pull requests too, so a licence URL that cannot be turned into a
request *at all* fails on the pull request that introduced it. Wellformedness is
about this repository's own data and is answerable from a diff; reachability is
about somebody else's server and is not.

Measured when this was added: 57 releases carry a `license.url`, those reduce to
41 unique URLs, and 21 of the 41 are already cited as a source — so the widening
costs **20 net new requests** per weekly sweep, against a baseline of 285. The
merge is what keeps that number down and what stops one rotted link being
reported as two.

## The states, and why two of them are not findings

The whole design rests on keeping four outcomes apart. Collapsing them is what
turns a link checker into noise, and the point of a source-backed product is
that a report about its evidence is worth reading.

| State | Means | Actionable |
|---|---|---|
| `ok` | 2xx, directly or through temporary redirects only | no |
| `redirected` | 2xx, but the chain contained a 301 or 308 — the recorded URL is stale | **yes** |
| `broken` | 404 or 410 — the resource is gone and the citation no longer supports anything | **yes** |
| `blocked` | The server refused this client: 401, 403, 405, 429, or another non-404 4xx | no |
| `transient` | No verdict: a network error, a timeout, a 408, or a 5xx, after the full retry budget | no |
| `normalised` | 2xx through a permanent redirect that a fabricated path receives identically — the rewrite is the host's, not the URL's | no |
| `excluded` | A reviewed exclusion covers this URL and has not expired | no |

`blocked` and `transient` are excluded from the actionable set on purpose. Both
describe the checker's conversation with a server rather than the source itself.
The dataset's two largest host groups are `huggingface.co` and `github.com`,
which rate-limit and serve anti-bot responses to unfamiliar clients, so a 429 or
a 403 here is the ordinary case — and a check that reddens on those is one people
learn to ignore, which is worse than having none. The issue's non-goals say the
same thing: do not fail pull requests for transient external errors.

Only 404 and 410 are read as `broken`. Every other 4xx is `blocked`. A 400 or a
403 to a `HEAD` from an unfamiliar user agent is far more often an anti-bot
response than evidence of rot, and putting a working source in a maintenance
issue costs more trust than missing a rotted one for a week.

Only **permanent** redirects make a URL `redirected`. A 302, 303 or 307 means the
recorded URL is still the right one to record, so a chain of those resolving to a
2xx is plain `ok`. Following redirects by hand rather than with
`redirect: 'follow'` is what makes that distinction possible at all — `follow`
collapses both into an identical 200.

## Host path normalisation, and the finding nothing could resolve

Some hosts rewrite every request path before routing it. `nousresearch.com`
strips a trailing slash from anything, so `/releases/` 308s to `/releases` — and
so does a path nobody ever created, which then 404s. **A 308 from a host like
that carries no information about whether the URL that received it is valid**, as
it is emitted just as readily for a path that does not exist.

Reported as `redirected`, that hop is a finding no workflow here can resolve. The
dataset holds what the publisher's own `rel="canonical"` and `og:url` declare, so
there is nothing to correct; the other remedy, a reviewed exclusion, asserts that
a *human* looked at the URL, which no automated run can truthfully write. The
finding would re-report on every sweep, for ever.

So the checker measures the host instead of guessing about it. When a chain would
otherwise be `redirected`, it asks the same host for a **fabricated sibling
path** — the same directory, the same trailing-slash shape, and a last segment of
`modeltree-link-health-control-does-not-exist`. If the control receives the
identical rewrite, the rewrite is demonstrably blind, because the host cannot
know a segment this tool invented. The result becomes `normalised`, which is not
actionable, and the report prints both requests so a reader can re-run them.

Anything less than a match leaves the finding exactly where it was. A control
that is answered rather than rewritten, one rewritten with a different status,
one sent somewhere else entirely, and one that could not be reached at all all
leave the URL `redirected`.

**The boundary is deliberately narrow: only a trailing slash, on the same scheme,
the same host, and with an identical query string.** A `http` → `https` upgrade
and an apex → `www` rewrite are just as host-wide and just as mechanical, and
both stay actionable on purpose, because editing the record to the upgraded URL
genuinely removes the finding and no authority disagrees about which form the
publisher wants. The trailing slash is the one case where the publisher's edge
and the publisher's own markup contradict each other, and a link checker is not
the thing that should adjudicate that. A redirect that changes the path at all is
never explained away, so this cannot launder a page that genuinely moved —
including one whose chain contains a normalisation hop and a real move.

The cost is one extra request per host per directory shape, memoised for the run,
and only ever on a result that was going to be reported. A control that produced
no status is not cached, so one blip cannot decide the classification of every
other redirect on that host.

What this does **not** establish is that the recorded URL is the publisher's
canonical one. It establishes that the redirect it received says nothing either
way.

## What it deliberately still cannot do

`exclusions.json` remains the only home for "a human looked at this URL and
decided the checker is wrong", it remains empty, and the test asserting that it
is empty is untouched. Nothing above widens what an automated run may assert:
`normalised` is a measurement the run took, not a judgement it recorded on a
human's behalf. Findings that are neither mechanically explainable nor
resolvable by a dataset edit still require a person, and still have no automated
route — which is the correct outcome and not a gap.

## How it avoids provoking the failures it tolerates

- **One request in flight per host**, on top of the global concurrency cap, with
  a delay between consecutive requests to the same host. A naive pool would open
  several parallel connections to the largest host group and manufacture the
  rate-limit responses the tool exists to tolerate.
- **A descriptive user agent** naming the project and a contact URL. This is
  load-bearing for the false-positive rate, not decoration.
- **`HEAD` first, escalating to `GET` once** on the statuses where sites are known
  to answer the two differently. The body is cancelled without being read either
  way: checking that a URL resolves is not scraping what it says, which the
  issue's non-goals forbid.
- **Bounded retries** with exponential backoff, honouring `Retry-After` when the
  server sends one. A 429 that survives the whole budget settles as `blocked`,
  not as `broken`.

## Reviewed exclusions

`exclusions.json` is a JSON array. It is **empty today**, deliberately: an entry
asserts that a human looked at a URL and decided the checker is wrong about it,
and there has been no such review to record. Adding one without the review would
be exactly the unsourced claim this repository refuses everywhere else.

Each entry:

```json
{
  "url": "https://example.com/a-page",
  "reason": "Serves 403 to every non-browser client; verified reachable by hand.",
  "reviewedOn": "2026-01-31",
  "expiresOn": "2026-07-31"
}
```

- `reason` — at least 20 characters. The floor is arbitrary and kept anyway:
  "requires a reason" is satisfied by `"x"` under a merely-non-empty test, which
  meets the letter of the requirement while abandoning its purpose.
- `reviewedOn` — the review date the requirement asks for. A real `YYYY-MM-DD`.
- `expiresOn` — a real `YYYY-MM-DD` after `reviewedOn`.

An **expired** exclusion suppresses nothing. Its URL goes back into the checked
set *and* the expiry is reported as a finding of its own, because the expiry date
is what the review date promises: it is what stops an exclusion written once from
silencing a URL forever.

A malformed entry is a hard error and the run exits 2 without checking anything.
This is the one input whose mistakes make the checker quieter, so it must not be
able to degrade into "checked nothing, found nothing, green".

## What a clean run cannot establish

This section is the counterpart to the states table, and it is here rather than
only in a pull request comment because the boundary of what a link checker can
prove is the part a later reader most easily overstates. The same limits are
written into the header of `link-health.mjs`, where someone reading the code
meets them without having to find this file.

A clean sweep means **"nothing was proven rotten"**. It does not mean
"every source verified". Specifically:

- **`ok` does not mean the page still supports the claim.** It means the URL
  answered 2xx. A vendor who rewrites an announcement in place serves 200 for
  the old text and the new one alike, and this tool never reads a body — that is
  the non-goal about scraping — so **content drift is invisible to it by
  construction**. That is the failure mode closest to what ModelTree actually
  claims, and this tool does not address it.
- **`ok` therefore cannot renew a `lastCheckedDate`.** That field asserts a human
  read the page and found the fact in it. Nothing here observes that. It is why
  the tool writes nothing at all rather than merely being configured not to.
- **An actionable count of zero does not mean every URL is alive.** A genuinely
  dead URL behind a rate limiter reports `blocked`, and `blocked` is deliberately
  not actionable. The design trades false negatives for false positives on
  purpose.
- **`blocked` and `transient` are the absence of a verdict, not a benign one.** A
  run in which every request was refused yields the same actionable count as one
  in which every request succeeded. Read the per-state counts, never the
  actionable count alone. The workflow's `resolve-issue` job closes the
  maintenance issue on `actionable == 0` and says this in the comment it posts.
- **A soft 404 — 200 with "page not found" in the body — is reported `ok`.**
  Catching one means reading bodies.
- **The observation is single-vantage, single-moment.** A CI runner's IP gets CDN,
  geo and anti-bot treatment a human browser does not, so a 403 here may be a 200
  to a reader. Nothing here establishes what a given person sees, or what the URL
  served yesterday.
- **It cannot say a URL is the *right* source for the record citing it.** That is
  an editorial judgement and is out of scope.
- **`normalised` says a redirect belongs to the host, and nothing more.** It is
  measured, not assumed — but it does not establish that the recorded URL is the
  publisher's canonical one, and it covers only a trailing slash.

## What it does not have

No `--skip`, no `--force`, no `--data`, no `--exclusions`, no `--today`. Each of
the last three would let a caller aim the check at an emptier dataset, a more
permissive exclusions file, or a date that un-expires an exclusion, and a green
verdict about something other than the committed data is the one result this tool
must not be able to produce. `instruction-references` and `adr-numbers` take no
arguments for the same reason.

`--baseline` only ever narrows the set, which is safe on a pull request — the
author is answerable for the sources they changed and not for the rest — and
would be a bypass on the scheduled sweep, so the workflow passes it on pull
requests only, and the script says on stderr when it is narrowing.

## Tests

```
node --test .github/scripts/source-link-health/link-health.test.mjs
```

**Hermetic by construction.** `fetch` and `sleep` are constructor arguments, so
no test opens a socket or waits on a timer. A suite whose result depends on a
third party's uptime reddens for reasons unrelated to any change, and people
learn to ignore it — the same argument that keeps `blocked` out of the
actionable set.

That is verified rather than asserted: with `fetch`, `net.connect`,
`tls.connect`, `dns.lookup`, `http.request` and `https.request` all replaced by
throwing stubs at process level — inherited by the CLI the suite spawns — all 90
tests still pass. A control confirms the same stubs make a real request fail, so
the pass is evidence and not a blocker that quietly failed to install.

What is proven against which data, stated rather than left to be inferred:

| Behaviour | Proven against | Why not the other |
|---|---|---|
| URL extraction, canonicalisation, record grouping | the committed `sources.json` | Real shape is the point; the test asserts properties, never counts |
| One named record id survives extraction into a report | the committed `sources.json` | A positive control: without it the two tests above would pass on an empty list |
| **De-duplication — one request per repeated URL** | **synthetic fixture** | Every URL in `sources.json` is unique, so real data exercises this **zero** times. The fixture repeats one URL across two records and the test counts the requests *issued* |
| `ok`, `redirected`, `blocked`, `transient`, `broken` | **synthetic fixtures** | A 429, a 301 or a 404 cannot be conjured from a live host on demand, and asking one would make the suite non-deterministic |
| **Host normalisation, and every way the control can fail to explain a redirect** | **synthetic fixtures** | The point is the *discrimination*: a host that strips slashes blindly and one that does not must be told apart, and only a fixture can supply both on demand. The control-answered case is the test that would fail a checker which demoted every trailing-slash redirect without asking |
| Retry, backoff, `Retry-After`, method escalation | **synthetic fixtures** | Same reason, plus a real backoff would make the suite slow |
| Exclusion parsing, reason floor, expiry | **synthetic fixtures** | `exclusions.json` is empty, so real data exercises the valid-entry path zero times |
| The committed `exclusions.json` parses | the committed file | It must not be able to rot into something the checker rejects at run time |
| CLI flag surface and the dataset-write refusal | the real CLI, spawned | The refusal is only worth anything if the real argument parsing enforces it |

No test adds a URL to `web/src/data/`, and no fixture URL is ever requested.
Every fixture host sits under the `.test` top-level domain, which RFC 6761
reserves for exactly this and guarantees is never globally resolvable — so even
a future bug that let a real `fetch` through could not reach a third party from
this suite. They exist only as strings handed to a stub.
