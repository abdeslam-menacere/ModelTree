# ADR 0017: Licence URLs Are Swept On The Clock, Not On The Diff

- Status: Accepted
- Date: 2026-09-05
- Decision owners: ModelTree maintainers
- Supersedes: nothing. No ADR governs the source link-health sweep; it was built
  under issue #29 and its decisions live in the checker's own header and in
  `.github/workflows/README.md`. This ADR **extends that instrument** — its
  four-state classification, its refusal to treat a rate limit as a finding, and
  its advisory-not-required status — to a second kind of recorded URL, altering
  none of them. It changes no schema, so ADR 0008's ruling on `unknown` members
  is untouched and no field gains one. It does not widen the ADR 0003 qualifying
  class: nothing here is an automated dataset edit, and the one data correction
  in the change that introduced this ADR is an ordinary reviewed human edit on
  the ordinary path.

## Context

A ModelTree release records where its licence lives. `licenseSchema` in
`web/src/data/schema.ts` carries `url: z.url().optional()`, and 57 of the 120
committed releases fill it in.

Nothing ever fetched one. The link-health checker reads `record.url` over
`web/src/data/sources.json` and nothing else, so a licence URL was outside every
instrument this repository has. There was no registration rule tying it to a
source record either: `license.url` is not a citation, so the discipline that
covers citations — a primary source, a `lastCheckedDate`, a sweep that re-asks —
never reached it. Fifty-seven assertions about where somebody else's licence
terms live, none of them ever checked after the day a human typed them.

The predictable thing had happened. Measured on 2026-09-05 with a rate-limited,
controlled sweep of all 41 unique URLs those 57 records reduce to, two were
definitively broken:

| release | recorded `license.url` | status |
|---|---|---|
| `aleph-alpha-pharia-1-llm-7b-control` | `https://github.com/Aleph-Alpha/.github/blob/main/oal.pdf` | 404 |
| `xiaomi-mimo-7b-rl-0530` | `https://huggingface.co/XiaomiMiMo/MiMo-7B-RL-0530/blob/main/LICENSE` | 404 |

Both are discriminated rather than assumed: each repository's root answers 200
in the same pass, and a coined path inside each answers 404, so the reading is
about the file and not about the host refusing an unfamiliar client.

**The shape of that failure is what this ADR turns on.** The Aleph Alpha record
carried `verifiedAt: 2026-09-01`. The URL was live when a human wrote it down
and died afterwards, upstream, with no pull request in this repository involved
at any point. That is *decay*, and it is the only failure mode anybody has
produced evidence for here.

The instrument the repository already owns comes in two scopes. On a pull
request the checker is handed `--baseline`, the previous `sources.json`, and
narrows to the URLs that diff introduced or re-pointed. On the weekly schedule
it is handed no baseline and sweeps everything. The narrowing is not a
performance nicety — it is what makes a pull-request run answerable for what its
author wrote rather than for eighty-odd URLs they never touched.

That narrowing is also structurally incapable of catching decay. A diff-scoped
check inspects what a diff touches; the Aleph Alpha URL was touched by no diff
between the day it was verified and the day it died. Such a check would have
been green on every run before the URL rotted and green on every run after, and
it would be green today.

## Decision

**A release's `license.url` is swept for reachability on the scheduled full
sweep and the manual dispatch, and never on a pull request.**

Three parts make that concrete.

**Extraction is separate from citation extraction and the two provenances stay
apart end to end.** `extractLicenceTargets` reads `license.url` from
`releases.json`; `mergeTargets` unions its output with the source targets on the
canonical URL. That merge is load-bearing rather than tidy: 21 of the 41 unique
licence URLs are *already* cited as a source somewhere in `sources.json`, so
concatenating instead of merging would issue those 21 requests twice — at the
two hosts this checker is most careful about — and split one rotted link into two
report entries. The merged entry keeps `recordIds` as the union and
`licenceRecordIds` as the licence subset, so the report and the maintenance issue
can say "affected source records" of one set and "named as `license.url` by" of
the other. A release is never presented as a source record, because it is not
one.

**The scope discriminator is the absence of `--baseline`, not a new flag.**
`--baseline` is passed on pull requests only and only ever narrows, so keying on
it means there is no way to spell "sweep, but skip the licence URLs". A
`--no-licences` flag would be exactly that, and this CLI already refuses `--data`,
`--exclusions`, `--today`, `--skip` and `--force` on the same reasoning: a green
verdict about something other than the committed data is the one outcome the tool
must not be able to produce.

**Wellformedness and reachability are split, and only reachability is
scheduled-only.** The `--dry-run` step runs on pull requests with no baseline, so
it extracts licence URLs there too and fails on one that cannot be turned into a
request at all. That costs nothing and asks nothing of anybody: it issues no
request. So a `license.url` that is malformed is a pull-request-time failure,
while a `license.url` that is merely unreachable is a scheduled finding. The
question "is this a URL?" is about this repository's own data and is answerable
from the diff; the question "does this still resolve?" is about somebody else's
server and is not.

The measured cost of the widening is **20 net new requests per weekly sweep** —
41 unique licence URLs, 21 of which the sweep already made — against a baseline
of 285.

## Consequences

### Positive

- The 57 licence URLs are re-asked on a clock, which is the only mechanism that
  can see the failure that actually occurred. Decay is now detected in at most a
  week rather than never.
- The 20 net new requests are a 7% increase on an already-weekly sweep. No new
  host is introduced; every licence host is a host the sweep already visits.
- A malformed licence URL now fails on the pull request that introduces it, at
  zero network cost, closing the introduction-time half of the problem for free
  and without a diff-scoped network check.
- One URL cited by both a source record and a release is requested once and
  reported once. A maintainer reading the report can tell one rotted link from
  two.
- The report and the maintenance issue label each provenance, so nobody has to
  guess whether `aleph-alpha-pharia-1-llm-7b-control` is a source id.
- Widening the tests job's trigger to `releases.json` means a data-only pull
  request can no longer introduce an unusable licence URL unchallenged.

### Costs

- **A licence URL that dies between two Monday sweeps is wrong on the site for
  up to seven days.** That is inherent to a scheduled instrument and is accepted:
  the alternative on offer is not "faster" but "never".
- **A pull request that introduces an already-dead licence URL is not caught at
  introduction.** This is a real gap and is deliberately left open here rather
  than closed quietly. It is a different failure mode from the one evidenced, it
  has a different cost profile — it asks third-party servers on every data pull
  request — and it deserves to be argued on its own merits rather than smuggled
  in beside a decay fix.
- **The sweep will now report findings nobody in this repository can fix.** A
  licence URL that rots is somebody else's file; the repair is a human deciding
  what the record should point at instead, which is exactly what happened for
  Aleph Alpha and is not automatable. Findings are reported and filed, never
  applied.
- **`releases.json` becomes an input to the link-health workflow**, so a change
  to it now runs a job that previously ignored it. That is a slightly longer
  pull-request run on data changes, and it is the price of the wellformedness
  guarantee above.
- The `xiaomi-mimo-7b-rl-0530` 404 is reported as a finding and deliberately not
  fixed in the change that introduced this ADR, so the dataset ships with one
  known-broken licence URL. The scheduled sweep will file it; a reviewed human
  edit will resolve it. Fixing it here would have been an out-of-scope data
  change on an issue that explicitly asked for anything else found to be reported
  "as data, not as a fix".

## Alternatives Considered

**Sweep licence URLs on pull requests too, scoped by the diff.** Rejected as the
primary mechanism because it cannot see the evidenced failure: it would have been
green throughout the life of the Aleph Alpha 404. It also aims third-party
requests at every data pull request, which is the cost the `--baseline` narrowing
exists to avoid. It addresses introduction-time error, which is a genuine failure
mode with no instance recorded here, and it is written up as a follow-up so it can
be judged on that distinction rather than adopted as a side effect of this one.

**Sweep licence URLs on every run, scheduled and pull request alike, unscoped.**
Rejected outright. It multiplies third-party traffic by the pull-request rate for
no additional detection, and it reddens pull requests on somebody else's outage —
the failure the whole workflow is shaped to avoid, and the reason
`source-link-health` is advisory rather than required.

**Add a `--licences` or `--no-licences` flag and let the workflow choose.**
Rejected. Every flag on this CLI that could narrow what is checked is a bypass
waiting to be passed on the scheduled sweep, and the tool already refuses four
others for that reason. Deriving the scope from `--baseline`, which the workflow
must pass anyway and which only ever narrows, leaves nothing to misuse.

**Register licence URLs as source records so the existing sweep picks them up
with no code change.** Rejected. A source is evidence cited for a claim, with a
publisher, a type and a human verification date. A licence URL is a pointer to
terms. Collapsing the two would put 41 non-citations into `sources.json`,
overstate the evidence behind every affected release, and cost the report its
ability to say which kind of thing rotted. It is the entity-boundary error this
repository refuses elsewhere.

**Drop `license.url` from the Aleph Alpha record instead of re-pointing it.**
Genuinely balanced, and legitimate: the schema makes the field optional precisely
because a bespoke non-OSI licence may have no canonical URL, and the Open Aleph
License deed could not be found at any stable location. Rejected because 25 of
the 41 licence URLs in this dataset already point at a model repository's own
LICENSE file — that is the dataset's dominant convention, and the org-wide PDF was
the anomaly. The linked file is the licensor's own notice carrying a verbatim
excerpt of the grant, which is a better answer for a reader than nothing. What
makes that defensible rather than a smoothing-over is that the source note says
exactly what the file is, quotes it, and records that the deed it names is dead.

**Invent a replacement URL for the Open Aleph License.** Never considered
seriously and recorded here because it is the tempting move. A web search offered
`raw.githubusercontent.com/Aleph-Alpha/.github/main/oal.pdf`; it was probed and is
also 404. A plausible URL that has not been fetched is worse than no URL, because
it looks verified.

## Guardrails

- **A pull-request run must never request a licence URL.** The discriminator is
  `args.baseline === null`. If a future change makes the workflow pass a baseline
  on the schedule, or stop passing one on pull requests, this decision inverts
  silently — the CLI writes its scope to stderr on every run for that reason, and
  the two dry-run scopes are asserted in `link-health.test.mjs`.
- **No flag may be added that narrows a scheduled sweep.** That includes the
  obvious `--no-licences`, and it includes `--data`, `--exclusions` and `--today`,
  which remain absent.
- **A licence finding never edits the dataset.** The sweep reports; a human
  re-points a record. `lastCheckedDate` and `verifiedAt` are claims that a person
  looked, and a link checker is not a person.
- **A rate limit is not a finding.** `BLOCKED` and `TRANSIENT` stay outside
  `ACTIONABLE_STATES` for licence URLs exactly as for source URLs. Both of this
  dataset's largest licence hosts are `huggingface.co` and `github.com`, both of
  which rate-limit; widening the sweep must not widen what counts as broken.
- **The two provenances must not be merged in the report.** `recordIds` is the
  union and `licenceRecordIds` the licence subset; a release id appearing under
  "Affected source records" is a defect, and there is a test that fails on it.
- **`web/src/data/releases.json` must stay in the tests job's trigger list.**
  Removing it restores the gap where a data-only pull request introduces a
  malformed licence URL that nothing reads.
