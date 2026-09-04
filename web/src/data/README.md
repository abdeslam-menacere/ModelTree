# `web/src/data` — source-citation coverage

ModelTree's standing rule is that every important fact carries a primary source
and a verification date. The only automated re-verification of those sources —
the `Source link health` workflow — takes **`sources.json` alone** as its
subject. A source cited in any other document but absent from `sources.json`
would therefore be verified by no automated run.

`source-registration.test.ts` closes that gap: it enumerates this **directory**
(not `raw.ts`'s import graph, which omits several documents by design) and asserts
that every URL a document cites as a source is registered in `sources.json`.

## Which documents are covered, and how

| Document | How it cites sources | Covered by the guard |
| --- | --- | --- |
| `sources.json` | It *is* the registry; each record holds a top-level `url` | Registry, not a subject of itself |
| `variant-positioning.json` | Inline `sources[].url` citations | Yes — every URL must be registered |
| `glossary.json` | Inline `sources[].url` / `sources[].urls[]` citations | Yes — every URL must be registered |
| `rejection-reversals.json` | It cites no sources; it records *why a rejected record was allowed back*, and points at `refresh-runs.json` by run and withheld id | Yes — it carries no inline citation URLs |
| Every remaining document | By `sourceIds` referencing `sources.json` records | Yes — they carry no inline citation URLs, so they are covered by construction |

A "source citation" is a `url` string, or a member of a `urls` array, that
appears inside a `sources` array. URLs that are not citations — homepage and
news links in `organizations.json`, licence links in `releases.json`, pull
request / issue / commit references and prose in `refresh-runs.json`, and URLs
quoted inside a `quote` or `note` field — are deliberately **not** treated as
sources and are not required to be registered.

## Deliberately not covered

- **`raw.ts`'s module graph is not the subject.** `glossary.json`,
  `refresh-runs.json`, `variant-positioning.json` and `rejection-reversals.json`
  sit outside `raw.ts` to keep the ADR-0003 auto-merge qualifying class narrow.
  The guard walks the directory precisely so that decision does not blind it.
- **`refresh-runs.json`** carries no inline `sources[]` citations, so it
  contributes no citation URLs. Its PR/issue/commit references and its prose
  descriptions of fetched pages are process records, not fact provenance.
- **`rejection-reversals.json`** is the same kind of thing and is outside
  `raw.ts` for a second reason on top of the narrow-class one. It reconciles
  `refresh-runs.json` with the dataset: when the automated panel rejected a
  claim and an ordinary reviewed change later landed that record anyway, this is
  where the reversal is written down (#835). Being outside the qualifying class
  is load-bearing rather than incidental — a refresh run that tried to annotate
  away its own rejection would leave the class and forfeit auto-merge, so only a
  human-reviewed change can record a reversal. Its `evidence` and `wouldAnswer`
  fields quote records and sources already committed elsewhere; it introduces no
  new source of its own, and `gate-reversals.mjs` checks that a reversal is
  *recorded*, never that the reasoning is sound. That judgement is a reviewer's.
  Its coverage is partial and the shortfall is quantified rather than implied:
  the gate reads a record id out of each rejection's `detail` prose, which only
  18 of 62 `rejected-by-panel` entries write in a usable form, and **17 of the
  other 44 also name a record that is present in this directory today**. Those 17
  are unchecked, not cleared. Closing the gap means having refresh runs emit a
  machine-readable record id, which is its own reviewed change; loosening the
  extractor instead would make the gate's own prose true by widening its scope,
  which is the worse trade.

## Standing exceptions to source registration

There are none. Every URL cited as a source in this directory is registered in
`sources.json`, so `KNOWN_UNREGISTERED_CITATIONS` in
`source-registration.test.ts` is empty and the rule that every important fact
carries a primary source and a verification date holds across the whole data
directory with no standing exception. That list is pinned by equality, so an
exception cannot be added without the change being visible in that file, and
registering the URL in `sources.json` is what removes an entry again.

Because `glossary.json` cites its sources inline by URL rather than by
`sourceIds`, and sits outside `raw.ts`, the records backing those citations are
reached by no `sourceIds` reference. `validate.test.ts` resolves the glossary's
inline citations when it checks for orphaned sources, so a record cited only by
the glossary counts as cited rather than reading as dead provenance.
