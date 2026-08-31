# The claim bundle

The single interface between the four refresh skills. `modeltree-scout` writes
it, `modeltree-review` annotates it, `modeltree-gates` judges it, and
`modeltree-publish` applies and reports it. Nothing else passes between them.

It lives at `.modeltree-refresh/runs/<run-id>/<creator>.claims.json`, which is
git-ignored: a run's working state is not repository data and must never be
committed.

## Shape

```json
{
  "runId": "2026-08-25-a1b2c3",
  "creator": "openai",
  "policy": "pilot",
  "startedAt": "2026-08-25T09:04:11Z",
  "sourcesConsulted": [
    { "sourceId": "openai-news", "url": "https://openai.com/news/",
      "contentHash": "sha256:...", "fetchedAt": "2026-08-25", "status": "ok" }
  ],
  "claims": [ ... ],
  "budget": { "pagesFetched": 12, "pageBudget": 40, "exhausted": false },
  "incomplete": []
}
```

`policy` is `pilot` for a creator with a reviewed profile under
`tools/updater/profiles/`, and `long-tail` for one without. It sets the review
threshold and is not a stylistic choice: `pilot` accepts on 2-of-3,
`long-tail` requires unanimity. It is **required, and never defaulted** — a
bundle that omits it is refused with exit 2, exactly as one naming an unknown
policy is. Silence must not select the looser bar.

The gate does not take this on the bundle's word. `gate-evidence` derives the
same classification from the reviewed-profile set on disk — a creator with a
reviewed profile is `pilot`, one without is `long-tail` — and applies *that*
threshold. A bundle whose declared `policy` contradicts the derived one is
refused, naming the creator, the declared policy and the derived one; if the
reviewed set cannot be read or the creator cannot be classified, the gate exits
2 rather than fall back to the looser bar.

`incomplete` records what the run could not finish — a source that would not
load, a budget that ran out — as strings. It is published rather than hidden. A
run that quietly did less than it claims is worse than one that failed loudly.

## A claim

```json
{
  "id": "openai-gpt-5-7-release-date",
  "kind": "change",
  "collection": "releases",
  "targetId": "openai-gpt-5-7",
  "field": "releaseDate",
  "currentValue": "2026-08-01",
  "proposedValue": "2026-08-20",
  "statement": "GPT-5.7 was released on 20 August 2026.",
  "evidence": [
    {
      "sourceId": "openai-gpt-5-7-announcement",
      "url": "https://openai.com/index/gpt-5-7/",
      "contentHash": "sha256:3f2a...64 hex total",
      "fetchedAt": "2026-08-25",
      "quote": "Today we are releasing GPT-5.7 to all API customers.",
      "retrieval": "fetch"
    }
  ],
  "verdicts": [
    { "reviewer": "provenance",  "vote": "accept", "rationale": "The announcement states the date in its own voice." },
    { "reviewer": "consistency", "vote": "accept", "rationale": "Later than GPT-5.6 and consistent with the family timeline." },
    { "reviewer": "editorial",   "vote": "accept", "rationale": "Attributed to the release, not to ChatGPT the product." }
  ]
}
```

### Fields

| Field | Rule |
|---|---|
| `id` | Unique within the bundle. Kebab-case, descriptive enough to read in a pull request body. |
| `kind` | `add`, `change`, `remove`, `unchanged`, or `conflict`. Only the first three touch the dataset. |
| `collection` | One of the nine dataset documents. Anything else is refused — a claim cannot reach a schema or a component. |
| `targetId` | The entity id being added or changed. |
| `field` | Required for `change`. The single field the claim moves. |
| `currentValue` | What the dataset says now, or `null` for an addition. Recorded so the diff is legible without re-deriving it. |
| `proposedValue` | For `add`, the whole record. For `change`, the new value of `field`. |
| `statement` | One sentence a human can read and a reviewer can vote on. Reviewers vote on this, not on JSON. |
| `evidence` | At least one entry. See below. |
| `verdicts` | Exactly three, one per rubric, each with a rationale. |

### Evidence

Every entry must carry all six fields. The gate refuses anything less, and each
field is refusing a specific way of being wrong:

- **`retrieval`** must be `"fetch"`. A search result is a pointer to a source,
  never the source. This is the mechanical form of "search snippets are never
  evidence"; it is the rule most likely to be skipped under time pressure, so it
  is the one most worth having a machine enforce.
- **`url`** must be https, credential-free, and not a local or internal host.
- **`contentHash`** must be `sha256:` plus 64 hex characters, and the run must take
  it over the page body it actually read. The gate checks this **form** only: it
  fetches nothing, so it never confirms the digest is the hash of the cited page.
  A well-formed hash records "this page said this on this date" as an assertion the
  PR trail and revert path can act on later; the evidence gate does not verify it.
  ADR 0005 records this limit and what compensates for it.
- **`fetchedAt`** must be a real date and not in the future.
- **`quote`** must be at least 24 characters, taken verbatim. A quote short
  enough to be a coincidence is not corroboration. Like `contentHash`, the gate
  checks its shape and length, never that it appears on the cited page.
- **`sourceId`** is the id this evidence will carry into `sources.json`. If the
  source is new, the run must also propose a `sources` claim adding it, or the
  reference will not resolve when the dataset gate runs. That claim's url must sit
  on an origin the committed dataset or a profile catalogue already stands behind:
  `gate-source-approval.mjs` refuses a citation to any other origin, and refuses
  it whatever the panel voted, because a source a run introduces and cites in the
  same breath has been approved by nobody.

### Verdicts

Exactly three, one per rubric — `provenance`, `consistency`, `editorial` — each
with `vote` (`accept` or `reject`) and a non-empty `rationale`.

The rationale is not decoration. It is carried verbatim into the pull request
body, and it is most of what makes an unattended merge auditable after the fact.
A verdict with no rationale is refused for that reason alone.

Two rubrics reporting is not a panel, and one rubric voting twice is not two
reviewers. The gate refuses both, because both are ways a majority can be
manufactured without independent review actually happening.

## Applying a bundle

Only claims whose `kind` is `add`, `change`, or `remove` **and** which reached
their threshold are applied. Everything else is reported and dropped.

Apply in this order, so references always resolve at the moment they are needed:

1. `sources` and `publishers` — the evidence itself
2. `organizations`
3. `families`
4. `releases`
5. `usageObservations`, `usageSyntheses`, `modelFitStatements`,
   `modelFitEvidenceGaps`

Then run `gate-dataset.mjs`, and run `npm run validate` from `web/` — as
`npm.cmd` where the bare name is a shim your shell refuses. If either fails,
drop the offending claim, record why, and revalidate the remainder. Never edit a
claim to make it pass — that is the run overruling its own gates.
