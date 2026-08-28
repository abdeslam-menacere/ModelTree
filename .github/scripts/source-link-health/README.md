# Source link health

Checks that every primary source URL in `web/src/data/sources.json` still
resolves, and reports what it finds. It reads source records and **writes
nothing back** — not a replacement URL, not a `lastCheckedDate`. Both of those
are claims that a human verified something, and a link checker is not a human.

```
node .github/scripts/source-link-health/check-source-links.mjs --dry-run
node .github/scripts/source-link-health/check-source-links.mjs --report report.md --json summary.json
```

Run by [`.github/workflows/source-link-health.yml`](../../workflows/source-link-health.yml).

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

Hermetic: `fetch` and `sleep` are injected, so no test reaches the network or
waits. Two behaviours are tested against synthetic fixtures because the real
dataset cannot exercise them — de-duplication, since every URL in
`sources.json` is currently unique, and the `blocked`/`transient`/`redirected`
classifications, since a 429 or a 301 cannot be conjured on demand. One test does
run over the committed dataset, and it asserts properties rather than counts,
because the dataset grows.
