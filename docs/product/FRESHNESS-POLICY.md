# Freshness policy

How old a verified fact may be before ModelTree's data-health report calls it
**stale**. This document is the human-readable statement of the policy; the
machine-readable source of truth for the numbers is
[`web/src/data/freshness-policy.ts`](../../web/src/data/freshness-policy.ts).
When the two could disagree, the module wins, and
`web/src/data/freshness-policy.test.ts` reads this document to keep them in step —
so a change to a threshold here that is not also made there fails the web suite.

Staleness is **reported, never enforced**. A record being old is a fact the
report surfaces so a maintainer can decide whether to re-verify it; it is never a
build failure. The only build-failing rules are the hard-integrity checks at the
end of this document, and ordinary age is not one of them.

## Policy version

Current version: **1.0.0**.

The version travels in the report artifacts (`reports/data-health.json` and
`reports/data-health.md`) and in `FRESHNESS_POLICY_VERSION`. Bump it — and add a
changelog line below — whenever a threshold value or a category assignment
changes, so a report can be read against the policy that produced it.

## Categories and thresholds

Thresholds are assigned by **volatility band**, not per field: facts that change
at the same rate share one clock. This is deliberate — the issue's non-goal is a
single threshold for every fact type, and also a per-field sprawl nobody can
reason about. Four bands cover every dated record.

| Category | Threshold (days) | Record kinds | Reasoning |
| --- | ---: | --- | --- |
| `volatile` | 90 | pricing, deployment | Prices, availability and delivery details change on short notice; a stale one misinforms a buyer, so the window is tight. Matches the public passport's `VOLATILE_STALE_AFTER_DAYS`. |
| `evidence` | 180 | usage-observation, usage-synthesis, model-fit-statement, model-fit-evidence-gap | Usage figures and conditional guidance age with the ecosystem; half a year unre-checked is presented as needing another look. Matches `STALE_AFTER_DAYS`. |
| `release-metadata` | 365 | release, family, release-event, benchmark, benchmark-result | A context window, modality set or licence rarely changes after launch, so a year is a reasonable re-verification cadence. The public passport shows no stale badge for these; the maintainer report still surfaces very old metadata so it is re-read, not silently trusted. |
| `structural` | 545 | organization, product, serving-platform, source, publisher-control | Organisation identity, ownership, product and platform facts change slowest of all, so the longest window applies. |

`source` records are dated by their `lastCheckedDate` and `publisher-control` by
the optional `control.verifiedAt`; every other kind by its required `verifiedAt`.

### Relationship to the two public-badge constants

The `volatile` (90) and `evidence` (180) thresholds equal the constants that
already drive per-fact staleness badges on public pages —
`passport.ts`'s `VOLATILE_STALE_AFTER_DAYS` and `usage-evidence.ts`'s
`STALE_AFTER_DAYS`. Those constants are left where they are rather than refactored
into the policy module (a wide change across unrelated files); instead
`freshness-policy.test.ts` asserts they stay equal to the policy, so the scattered
numbers cannot drift away from this table.

## What the report classifies

Distinct, named states — never a composite score, a per-record grade, or a
ranking. Every stale line in the report carries the date and the threshold that
produced it, so a maintainer reads *why*, not a bare number.

- **healthy** — verified within its category threshold, and not conflicted.
- **stale** — verified longer ago than its category threshold. Reported; never a
  CI failure.
- **conflicted** — party to a recorded, unresolved disagreement. Kept side by
  side; nothing picks a winner.

Alongside those, the report lists **missing optional coverage**: aspects a release
could carry but no source has been recorded for yet (a deployment, a price, a
benchmark result, usage evidence). This is the dataset's honest blank — "nobody
has sourced this yet" — reported so it is visible, not smoothed over. A
first-party fact with no independent echo is not a defect and is not flagged.

Featured releases are reported **separately** from the long tail, so a stale price
on a featured model is not buried among hundreds of long-tail records.

## Hard-integrity rules (these may fail CI)

Distinct from staleness. A hard-integrity violation is a self-contradiction in a
record, and it fails the required web suite:

- **No `verifiedAt` in the future** relative to the run date — a record cannot be
  verified in a future that has not happened. Deterministic: real data only ages
  further into the past, so this can newly-pass over time and never newly-fail.

The relational coherence rules (dangling, self-referential, or non-reciprocal
conflict ids; `effectiveFrom` after `verifiedAt`; dated events after verification;
a source `publishedDate` after its `lastCheckedDate`) are already enforced in
`web/src/data/validate.ts` and are not restated here.

## Changelog

- **1.0.0** — Initial policy. Four bands (volatile 90, evidence 180,
  release-metadata 365, structural 545). The first two adopt the existing public
  badge constants; the latter two are new, chosen by how often the underlying
  fact changes.
