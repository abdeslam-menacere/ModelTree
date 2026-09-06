# ADR 0019: Introduction-Time Licence URLs Are Checked On The Diff, By A Separate Instrument

- Status: Accepted
- Date: 2026-09-05
- Decision owners: ModelTree maintainers
- Supersedes: **one clause of ADR 0017, and nothing else.** ADR 0017's first
  guardrail opens "**A pull-request run must never request a licence URL.**"
  That sentence is superseded: a pull-request run may now request a licence URL,
  under the conditions set out below. The rest of that guardrail — that
  `args.baseline === null` is the discriminator inside `check-source-links.mjs`,
  that the scheduled sweep inverts silently if the workflow starts passing a
  baseline on the schedule or stops passing one on pull requests — is **not**
  superseded and is not touched: this decision adds a second file rather than
  changing the discriminator in the first. Every other ADR 0017 guardrail is
  **extended** to the new instrument verbatim, and they are restated under
  `## Guardrails` so that a reader of this ADR alone cannot miss one. ADR 0017's
  substantive decision — that licence *decay* is swept on the clock, weekly,
  over the whole dataset — stands unaltered; this ADR adds a different question
  rather than re-answering that one. Nothing here widens the ADR 0003 qualifying
  class: this decision authorises no dataset edit. ADR 0018 is not superseded
  and is applied — the new instrument carries a denominator so that "checked
  nothing" cannot be read as "found nothing".

## Context

### The gap, named by the decision that left it open

ADR 0017 put licence URLs on the scheduled sweep rather than on the diff. It was
right about the failure it had evidence for — a licence URL that *rots* after
being written down — and it recorded, in its own Costs, the failure it was not
closing:

> **A pull request that introduces an already-dead licence URL is not caught at
> introduction.** This is a real gap and is deliberately left open here rather
> than closed quietly. It is a different failure mode from the one evidenced, it
> has a different cost profile — it asks third-party servers on every data pull
> request — and it deserves to be argued on its own merits rather than smuggled
> in beside a decay fix.

abdeslam-menacere/ModelTree#957 is that argument, and it explicitly blesses
"accept the gap and shorten the window" as a legitimate outcome. This ADR does
not accept it, because both of the objections ADR 0017 raised turned out to be
answerable with a measurement, and both measurements came back against them.

The window being closed is up to seven days wide. During it the site displays a
licence pointer that has never resolved, carrying the same visual authority as
one that has. ADR 0017 itself makes the point that decides this: "A plausible
URL that has not been fetched is worse than no URL, because it looks verified."
That sentence was written about the sweep. It applies with more force at
introduction, because at introduction the URL has *never* been fetched by
anything, whereas a decayed one at least resolved on the day it was recorded.

### Objection 1 — "it asks third-party servers on every data pull request"

Measured at trunk `82582b6c0956bda1aef2b9a6ea39f6f57436c833`, over the **whole
history of `web/src/data/releases.json`** at that commit: 51 commits touch the
file, of which **50 are analysable** — the commit that creates it has no parent
revision to diff a baseline against, so it is excluded. Those 50 span
2026-08-15 → 2026-09-05.

The population is named as the file's whole history, rather than as a slice of
recent commits, because the two are different denominators and every figure
below is only meaningful against the one it was taken over. The two do not
coincide, and the difference is stated here so that neither figure can later be
welded to the other's frame: of the last 300 commits at that trunk, **47** touch
the file (15.7%), while the full ancestry there is **451** commits.

| quantity | measured |
|---|---|
| gross new licence URLs across those 50 commits | 49 |
| **net-new requests** — new licence URLs minus those the source run already requests in the same commit | **28** |
| commits needing ≥1 net-new request | 13 of 50 (26%) |
| commits needing **0** net-new requests | **37 of 50 (74%)** |
| mean net-new per `releases.json`-touching commit | **0.56** |
| mean net-new per commit across the 451-commit ancestry | **0.062** |
| maximum by any single commit | 5 |

"Every data pull request" is not what the history says. Three quarters of the
commits that touch the file at all introduce **nothing** this instrument would
request, because a release very often reuses a licence URL another release
already carries or a source already cites. The distribution is
`{0: 37, 1: 8, 2: 1, 3: 1, 5: 3}` — a long flat floor with a short tail.

The comparison that settles the cost question is against the sweep this
repository already runs and already accepted. `check-source-links.mjs --dry-run`
reports that the committed dataset's "285 source record(s) and 41 licence URL(s)
reduce to 304 unique URL(s)". The scheduled sweep requests all 304, weekly
(`cron: '37 6 * * 1'`). Across the 21 days those 50 commits span, 28 net-new
requests are ≈ **9.3 requests per week**.

So the instrument ADR 0017 declined on cost grounds costs about **3% of the one
it approved** — 9.3 against 304 requests a week, on the same servers, many of
them the same URLs. That is the measurement that changed the answer.

### Objection 2 — "an HF probe cannot cleanly distinguish absence from refusal"

This is true, it is well-evidenced, and it is **inapplicable to this dataset**.

The evidence is real. Re-measured live on 2026-09-05, with every arm paired
against a control invented at the moment of use so that a probe answering the
same thing to everything could not pass:

```
space-resolve-real-gated   401     29B  sha256:45b71fe98efe5f53…
space-resolve-INVENTED     401     29B  sha256:45b71fe98efe5f53…
  => status IDENTICAL, body BYTE-IDENTICAL
api-space-real-gated       401     41B  sha256:65842e3d84e6b7f6…
api-space-INVENTED         401     41B  sha256:65842e3d84e6b7f6…
  => status IDENTICAL, body BYTE-IDENTICAL
```

For a Hugging Face **Space**, "gated but real" and "does not exist" are not
merely hard to tell apart — they are byte-identical, 29 bytes reading
`Invalid username or password.` No status code and no body inspection can
separate them. That reproduces the finding from abdeslam-menacere/ModelTree#918
exactly.

The step ADR 0017 did not take is to ask how many licence URLs in this dataset
are Spaces. Measured over all 41 unique licence URLs:

| shape | count | share |
|---|---|---|
| Hugging Face model, file inside the repo | 14 | 34% |
| Hugging Face model, repo root | 12 | 29% |
| other host | 9 | 22% |
| GitHub, file inside the repo | 5 | 12% |
| `raw.githubusercontent.com` | 1 | 2% |
| **Hugging Face Space** | **0** | **0%** |

**Zero.** The ambiguity is a Spaces phenomenon and this dataset contains no
Space licence URLs at all. For the 26 Hugging Face **model** URLs that do exist
here, the same live run shows the discrimination is clean:

```
model-file-known-present   200      file present in a real repo
model-file-known-absent    404      file ABSENT in a real repo
model-repo-INVENTED        401      repo does not exist
api-model-real-gated       200      genuinely gated model, via the Hub API
```

`200` / `404` / `401` separate present, absent-inside-a-real-repo, and
does-not-exist. And the failure mode this ADR is about — a pull request naming a
`LICENSE` file that is not there — produces the **404**, which is exactly the
one that is unambiguous. A genuinely gated model answers **200**, so gating does
not manufacture a false finding either.

This is not a claim that the ambiguity has gone away. It is a claim about where
it lands: on a shape this dataset does not use, and — crucially — on the `401`
side, which `link-health.mjs` already classifies as `BLOCKED` and therefore
already keeps out of `ACTIONABLE_STATES`. A Space licence URL added tomorrow
would be reported as blocked, not as broken. The ambiguity degrades this
instrument to silence rather than to a false accusation.

### What the two known-broken URLs tell us about the cheaper alternatives

ADR 0017 measured two licence URLs as broken:
`aleph-alpha-pharia-1-llm-7b-control` and `xiaomi-mimo-7b-rl-0530`. Both are
already repaired on trunk, and the repairs are instructive:

| release | shape of the failure |
|---|---|
| `aleph-alpha-pharia-1-llm-7b-control` | `…/blob/main/LICENSE` — the repo exists, the **file** does not |
| `xiaomi-mimo-7b-rl-0530` | repo root — re-pointed rather than deleted |

Both had `prefixCitedBySource=true`: the repository they live in was **already
cited** by a source record. That number is the one that kills the no-network
alternative, and it is developed under `## Alternatives Considered`.

## Decision

**Introduce a second, separate, advisory instrument that checks only the licence
URLs a change introduces or re-points, and leave the scheduled sweep exactly as
ADR 0017 built it.**

Concretely:

1. **A new file, `.github/scripts/source-link-health/check-licence-links.mjs`.**
   It has **no full-sweep mode**. `--baseline` is mandatory; there is no
   argument combination — none, not `--all`, not omitting flags — that makes it
   request the whole dataset. Invoked without a baseline it exits **2** and says
   so. This is the structural guarantee that it cannot become a second sweep,
   cannot be aimed at the scheduled one, and cannot be the thing that narrows
   one.

2. **`check-source-links.mjs` is not modified.** ADR 0017's `args.baseline ===
   null` discriminator is untouched, and this decision explicitly does **not**
   flip it. The scheduled sweep still requests every licence URL on the clock
   and still requests none on a pull request. Two files, two questions:
   *does this URL still resolve* stays on the clock; *did this URL ever resolve*
   goes on the diff.

3. **A new workflow job, `licence-link-introduction`,** gated
   `if: github.event_name == 'pull_request'` and scoped to changes that touch
   `web/src/data/releases.json`. It materialises the base revision of that file
   from `PR_BASE_SHA` and passes it as the baseline. The existing
   `source-link-health` job, its schedule, and its trigger list are unchanged.

4. **It is advisory,** in this repository's established sense: it is not a
   required status check. It emits `::error::` and exits 1 on a finding, so a
   red run is visible without blocking the merge — the same shape the existing
   pull-request report step uses.

5. **It reuses the classification rather than restating it.**
   `ACTIONABLE_STATES` is imported from `link-health.mjs`, so `BLOCKED`,
   `TRANSIENT` and `NORMALISED` stay outside it by construction and no rate
   limit, anti-bot 403, timeout or 5xx can reach the exit code. Keeping this a
   re-export rather than a re-declaration is deliberate: a restated set is a set
   that can drift.

6. **It carries a denominator.** The report states "Requested *n* of the *N*
   licence URL(s) …", and a run that introduced nothing says so in those words
   and adds that this is a statement about scope and **not a clean bill of
   health**. Per ADR 0018, "I did not look" must not share a representation with
   "I looked and nothing was there".

## Consequences

### Positive

- The seven-day window in which a never-resolving licence URL sits on the site
  looking verified is closed at introduction, for the shape of failure that is
  cleanly detectable.
- The cost is measured, not estimated: **28 net-new third-party requests across
  50 commits** spanning 21 days, 0 for 74% of them, ≈9.3 per week — about 3% of
  the weekly sweep this repository already runs.
- The two instruments cannot be confused for one another. They live in separate
  files, answer differently-worded questions, and the new one is structurally
  incapable of sweeping.
- The report speaks one provenance. Every id reaching this tool arrives via
  `license.url`, so it says "named as `license.url` by" and never "affected
  source records". There is no union to mislabel, so ADR 0017's two-provenance
  guardrail cannot be violated here even by accident.
- A licence URL added on a Space — the ambiguous shape — degrades to `BLOCKED`
  and is reported as such, never as a finding.

### Costs

- **Pull requests that change `releases.json` now reach third-party servers.**
  This is the clause of ADR 0017 being superseded and it is a real reversal, not
  a technicality. It is accepted on the measurement above and on the separation
  in point 2: the reversal is scoped to a new file that cannot sweep.
- **A pull-request run can now be slowed or reddened by somebody else's
  server.** Mitigated, not eliminated: only `BROKEN` and `REDIRECTED` are
  actionable, the check is advisory, and 74% of qualifying commits request
  nothing at all. A 500-ms-per-host courtesy delay on ≤5 URLs is the realistic
  worst case.
- **This does not catch every dead licence URL at introduction.** A URL on a
  host that answers 401 or 403 to everything is reported as blocked and passes.
  That is the correct behaviour and it is a real limit: this instrument closes
  the window for the *detectable* class and says nothing about the rest. It is
  not a guarantee that an introduced licence URL resolves.
- **A second job appears on data pull requests**, so the checks list is longer
  and a reviewer has one more thing to read. The job reports explicitly when it
  requested nothing, so the extra line always concludes.
- **`releases.json` gains a second consumer in CI.** ADR 0017 already made it a
  trigger for the tests job; this adds a second job keyed on it. A change to
  that file is now the most expensive kind of data change in this repository.
- **Two files must be kept honest about their scope.** If a future change gives
  `check-licence-links.mjs` a sweep mode, or points the new job at the schedule,
  this decision inverts. The mandatory `--baseline`, its exit-2 refusal, and the
  test asserting that refusal are what make the inversion loud rather than
  silent.

## Alternatives Considered

### Direction 2 — assert existence from data already held, with no network

Proposed shape: a licence URL is acceptable if the repository it points into is
already cited by a source record, checked offline. Free, no third-party request,
no flake.

**Rejected on measurement.** Of the 41 unique licence URLs, **31 sit inside a
repo some source record already cites**, and — decisively — *both* URLs ADR 0017
measured as broken had `prefixCitedBySource=true`. This assertion would have
answered **green on 2 of 2 known failures.**

The reason is structural rather than a tuning problem: 24 of the 41 point at a
**file inside** a repo, and the assertion can only ever speak about the repo.
Both evidenced failures were file-level — Aleph Alpha's repo existed and its
`LICENSE` did not. A check that is green on every failure it has ever been shown
is not a weaker version of the right check; it is an instrument that reports on
something else, and publishing it would be worse than the gap, because it would
look like coverage.

### Direction 3 — shorten the window by sweeping more often

Proposed shape: leave the introduction gap open, run the existing sweep daily
instead of weekly.

**Rejected on measurement and on scope.** It costs 304 × 7 − 304 = **1,824
net-new requests per week** against direction 1's ≈9.3 — roughly **196× more**
— and it *cannot close the window*, only narrow it from seven days to one. It
also changes the scheduled sweep, which abdeslam-menacere/ModelTree#957's own
criterion 4 requires to be left unchanged, so adopting it would require
superseding more of ADR 0017 than this decision does, to buy less.

### Direction 4 — record a `verifiedAt` on `license.url`

Proposed shape: extend the schema so a licence URL carries the date a human
verified it, and gate on its presence.

**Rejected, and out of scope here.** It is a schema change and would need its
own ADR. More importantly it records that somebody *claimed* to look; it does
not itself verify anything. ADR 0017's existing guardrail says this in as many
words — "`lastCheckedDate` and `verifiedAt` are claims that a person looked, and
a link checker is not a person" — and the inverse holds equally: a claim that a
person looked is not a check. It would add a field that reads as verification
while requesting nothing, which is the same defect as direction 2 wearing
different clothes.

### Direction 5 — accept the gap and shorten nothing

Proposed shape: record that the gap is accepted, and stop.

**Rejected, and it was a live option.** Criterion 5 of the issue blesses it
explicitly, and it would have been the right answer had either ADR 0017
objection survived contact with a measurement. Both failed: the cost is about 3%
of an already-accepted weekly sweep, and the ambiguity that motivated the second
objection applies to 0 of 41 URLs in this dataset. Accepting a gap because a
cost was *assumed* prohibitive, when 20 minutes of measurement shows it is not,
is not a decision — it is a deferral wearing a decision's clothes. Recorded here
so that a future reader can see it was weighed and on what evidence it lost.

### Reusing `renderReport` instead of writing a bespoke renderer

**Rejected on entity boundaries.** `renderReport` hardcodes the heading
`## Source link health` and the label "Affected source records". A release is
not a source record, and this repository's standing rule is that creator, model,
product and serving platform are separate entities that must not be collapsed.
Reusing that renderer would print releases under a source-record heading on
every run of the new job.

## Guardrails

These are ADR 0017's guardrails, extended verbatim to the new instrument, plus
the ones this decision adds. The single clause that is superseded rather than
extended is named in the metadata above and is not repeated here.

- **`check-licence-links.mjs` must never gain a full-sweep mode.** `--baseline`
  is mandatory and its absence exits 2. There must be no flag, no default and no
  environment variable that lets it request the whole dataset. This is what
  keeps the reversal in this ADR scoped to introduction-time checking. A test
  asserts the refusal, and a paired control asserts the same invocation *with* a
  baseline succeeds — a one-sided test would pass for a script that exits 2
  unconditionally.
- **No flag may be added that narrows a scheduled sweep.** `--no-licences`,
  `--data`, `--exclusions`, `--today`, `--skip` and `--force` remain absent from
  both files. The new instrument is not a way to opt out of the old one.
- **`check-source-links.mjs` and the `source-link-health` job stay unchanged by
  this decision.** The schedule, its trigger list and the `args.baseline ===
  null` discriminator are ADR 0017's and remain so.
- **A rate limit is not a finding.** `BLOCKED` and `TRANSIENT` stay outside
  `ACTIONABLE_STATES`, which the new checker **imports** and must never restate.
  Both of this dataset's largest licence hosts — `huggingface.co` (26 of 41) and
  `github.com` (5 of 41, plus 1 on `raw.githubusercontent.com`) — rate-limit.
- **A licence finding never edits the dataset.** The new checker refuses any
  `--report` or `--json` path that resolves inside `web/src/data/`, and there is
  no code path in it that writes a dataset file. A human re-points a record.
- **The two provenances must not be merged in the report.** In the scheduled
  sweep, `recordIds` is the union and `licenceRecordIds` the licence subset. In
  the new instrument there is only the licence provenance, and the report must
  never use the words "source record" for a release id. A test asserts the
  string is absent.
- **`web/src/data/releases.json` must stay in the tests job's trigger list**, and
  must stay the trigger for the new job. Removing it from either restores a gap.
- **The new instrument stays advisory.** It must not be added to branch
  protection or made a required status check. If it ever needs to block a merge,
  that is a new decision and needs a new ADR.
- **A malformed licence URL must not redden this job.** Malformed records are
  collected over the whole dataset, before the baseline narrowing, so keying red
  on them would fail every pull request for one pre-existing bad record. They
  are already caught with no request by the `--dry-run` step in
  `source-link-health-tests`, which is where they belong.
- **A run that requested nothing must say so, with its denominator.** "0 of 0"
  must never be renderable as a pass. Per ADR 0018, not-looked and
  looked-and-found-nothing stay separately representable, and the report must
  carry the total licence-URL count beside the checked count.
- **Net-new third-party request cost is measured, never estimated.** The figures
  in this ADR were derived from git history at trunk
  `82582b6c0956bda1aef2b9a6ea39f6f57436c833`. Any future claim that this
  instrument is cheap or expensive must be re-measured against the history of
  the day, not inherited from this document.
