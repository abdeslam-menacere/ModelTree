# ADR 0016: Category-Specific Facts Are a Discriminated Extension

- Status: Accepted
- Date: 2026-09-02
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It **closes a remainder ADR 0007 left open**. That ADR
  admitted image and video releases under the shared release schema and recorded
  as a cost that "Resolution, duration, frame rate, and aspect-ratio support have
  nowhere to go", explicitly deferring the fix. This is that fix, for one
  category. It does **not** widen the ADR 0003 qualifying class — the new
  document is deliberately kept out of `web/src/data/raw.ts`, for reasons set out
  below — and it leaves untouched ADR 0008's ruling, as amended for `accessType`
  alone by ADR 0011, that `categories` and the modality lists gain no `unknown`
  member. Nothing here needs one: this ADR reads those lists and adds no member
  to any of them.

## Context

`web/src/data/schema.ts` declares nine model categories in `modelCategory`:
`language-reasoning`, `multimodal-generalist`, `coding`, `image`, `video`,
`audio-speech`, `embedding-reranking`, `scientific` and `robotics-world`. Every
release, whichever of those it belongs to, is validated by the same
`releaseSchema` and rendered by the same passport.

That schema was shaped by text models, and it shows. `contextWindow`,
`maximumOutput` and `parameters` are all optional, so an image release
validates without them — but the passport still lays out a row for each and
prints "Not recorded" when it finds nothing. For `openai-gpt-image-2` that is
false in a way worth naming: a maximum output measured in tokens is not a fact
about that model that ModelTree has failed to collect. It is not a quantity that
model has. Telling a reader the number is missing invites them to go and find
it, and there is nothing to find.

The reverse is also true and less visible. The facts these releases' own primary
sources do state — what sizes they emit, whether they can be asked for a shape,
whether they edit an image or only generate one, whether they take more than one
image in — have nowhere to be written down at all. Four image releases ship with
their creators' documentation cited on the record, and none of what that
documentation says about them as image models is anywhere in the dataset.

Meanwhile the evidence view had a third version of the same defect. Selecting an
image release and a language release produced an empty chart, because no
benchmark result joins them. An empty chart is not a neutral outcome: a reader
sees two models and no bars and reads it as a measurement, when what actually
happened is that the comparison was never possible.

The question this ADR answers is what belongs to every category and what belongs
to one, and where the second kind lives.

## Decision

**Shared concepts stay on `releaseSchema`.** Identity, dates and their declared
precision, lifecycle status, `categories`, the modality lists, access type,
`sourceIds` and `verifiedAt` describe a release as a release. They are asked of
every category, are answerable for every category, and do not move.

**Category-specific concepts live in a separate document, discriminated on
category.** `web/src/data/category-spec-schema.ts` defines a
`z.discriminatedUnion('category', ...)` whose only member today is `image`. A
record names one `releaseId`, carries its own `sourceIds` and its own
`verifiedAt`, and holds one entry per documented dimension. Each entry carries
both a verbatim `quote` from one cited source and ModelTree's own `statement` of
what that quote says — the two-part shape `variant-positioning.json` already
uses. A dimension no cited source states has no entry, and the page says so.

**Coverage is total and explicit.** `CATEGORY_SPEC_COVERAGE` maps all nine
`modelCategory` members to either a schema or an explicit declaration that the
category has none yet, so adding a tenth category without deciding what it means
is a type error rather than a silence. `PILOTED_CATEGORIES` is derived from that
map, not written twice.

**Applicability is derived from modalities, never asserted.** A token-denominated
output dimension is inapplicable when `outputModalities` excludes `text`. A
context window stays applicable wherever `inputModalities` includes `text`,
because a model that takes a text prompt and emits an image legitimately has one.
The passport therefore gains a third state beside recorded and not-recorded —
**not applicable** — computed from fields the release already validates. It
introduces no new claim about any model, which is why it needs no source of its
own.

**Comparability is a property of the comparison, not of a result.** Benchmark
definitions gain `appliesToCategories`, declaring which kinds of model a
benchmark is meant to measure, and the evidence view refuses a selection whose
members share no applicable benchmark. The refusal distinguishes two cases that
were previously one silence: models of different kinds, where more evidence would
never help, and models of the same kind that ModelTree has no benchmark for yet,
which is this repository's coverage gap and is described as such.

This constrains only the comparison. A release's `categories` say what a model is
*for*, never what it may be *measured on*, and the shipped data already depends
on that distinction: `llama-4-scout-livecodebench` records a general model on a
coding benchmark, is well sourced, and stays valid. A rule that required a
result's benchmark to share a category with its release would delete it.

**The pilot is one category.** Image was chosen because it has the most existing
non-text records, because ADR 0007 nominated exactly these records, because all
four cited sources resolve and state genuinely image-specific facts, and because
recording image *facts* requires no image *assets* and so does not touch the
asset budgets. Video, audio-speech, embedding-reranking, scientific and
robotics-world keep today's behaviour exactly.

**The document stays out of `web/src/data/raw.ts`.** `gate-scope.mjs` bounds the
ADR 0003 auto-merging refresh class to the documents `raw.ts` composes plus
`refresh-runs.json`, which ADR 0006 added, and the gate suite asserts that
correspondence. Adding a file there would widen
that class, which is an ADR-level decision about what may reach `main`
unattended, and it is not this issue's to take. The pilot follows the
`variant-positioning` precedent instead: side-loaded, separately validated,
reaching `main` by the ordinary reviewed path.

## Consequences

### Positive

- An image release's page now states what its own documentation says about it as
  an image model, sourced and dated, instead of stating nothing.
- Absence and inapplicability stop looking identical. "Not recorded" now means a
  fact ModelTree could hold and does not, and is worth chasing.
- The gaps that remain are visible rather than smoothed over.
  `meta-muse-image` has no recorded output sizing because its announcement states
  none, and the page says a cited source does not state it.
- A comparison that cannot be made is refused in words instead of drawn as an
  empty chart that reads like a score of zero.
- The next category is additive: one more union member, one more coverage entry,
  no change to anything already shipped.
- Nothing in the new shape can express a score, a ranking, or a comparison
  between two releases. There is no numeric field and no field that can name a
  second release, so the non-goal of a universal leaderboard is enforced by the
  schema rather than by review attention.

### Costs

- A second document to keep in step with `releases.json`. Cross-references are
  checked at load, so drift fails the build rather than shipping, but it is still
  a second place a release id appears.
- Eight categories still have no specific vocabulary. The coverage map makes that
  explicit rather than fixing it, and each remaining category is its own piece of
  research.
- `appliesToCategories` is editorial comparability policy, not a sourced claim
  about a benchmark. It is justified by the principle already recorded in
  `web/src/lib/comparability-policy.ts` — that such rules belong with benchmark
  definitions or a versioned policy rather than hardcoded per chart — but a
  reviewer must read it as a judgement, and widening a benchmark's declared
  categories is the documented fix if it ever proves too narrow.
- Category specs are not refreshable by the ADR 0003 pipeline, so they are
  updated by the ordinary reviewed path. That is deliberate, and it means a new
  image release does not get its spec automatically.

## Alternatives Considered

**Add the fields to `releaseSchema` as optionals.** Simplest, and wrong. Every
release would carry every category's fields, a language model would validate with
an aspect-ratio field set, and nothing would say which fields are meant to be
answerable for which kind of model. The optionality that already exists on
`contextWindow` is exactly what produced the "Not recorded" defect above;
repeating it nine times over would deepen the problem rather than fix it.

**Relabel the existing text fields per category.** Rejected outright.
Reinterpreting `maximumOutput` as a pixel count for image models would make one
field mean different things depending on a sibling field, break every consumer
that reads it as tokens, and destroy the comparability the field exists for.

**Give each category its own release schema.** A clean split, but it fractures
identity: a release would no longer be one kind of thing, every consumer that
walks `releases.json` would need to branch, and multi-category releases —
`multimodal-generalist` releases in particular — would have no home. The shared
core is real and worth keeping shared.

**Launch several categories at once.** The issue's own non-goals forbid it, and
the reason holds independently: each category needs its own source research, and
a diff that starts three of them cannot be reviewed for whether any one is right.

**Derive image facts from `outputModalities`.** Tempting, and it would need no
sources — but `outputModalities` says a model emits images, not what sizes it
emits or whether it can edit one. Inferring the second from the first would be
inventing a claim, which is the failure this repository's sourcing rule exists to
prevent. Modalities are used only for applicability, which asserts nothing new.

## Guardrails

- A category spec record states facts about **one release** and cannot reference
  a second release, a second category, or a benchmark. No numeric or ordering
  field may be added to it. A composite score or cross-category ranking is out of
  bounds here permanently, not merely absent today.
- Every fact carries a verbatim `quote`, a `sourceId` that is among the record's
  own `sourceIds`, and a record-level `verifiedAt`. A fact whose quote does not
  support its statement fails review.
- A dimension no cited source states must be **omitted**, never filled with a
  default, an inference, or a value carried over from a sibling release. The
  visible gap is the correct output.
- Adding a `modelCategory` member requires an entry in `CATEGORY_SPEC_COVERAGE`,
  either a schema or an explicit "none yet". The type system enforces this; do
  not widen the map's type to avoid it.
- Extending the pilot to a second category is a separate change with its own
  source research. Do not add a union member without records to put in it.
- `appliesToCategories` constrains comparisons only. It must never be used to
  reject, hide, or flag a benchmark result, and a benchmark result whose release
  sits outside the benchmark's declared categories stays valid data.
- Moving this document into `web/src/data/raw.ts` widens the ADR 0003 qualifying
  class and requires its own ADR. Adding the file to `raw.ts` without one is a
  change to what may reach `main` unattended, disguised as an import.
