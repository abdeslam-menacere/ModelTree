# ADR 0007: Muse Is a Family Under Meta, and Image and Video Are in Scope

- Status: Accepted
- Date: 2026-08-31
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It records two entity-boundary decisions the dataset had
  already taken in data, and states the rule behind them. It does not modify ADR
  0003's qualifying class or ADR 0006's widening of it, it changes no schema, and
  it resolves nothing in #43 — see the guardrails, where that limit is the first
  entry rather than an afterthought.

## Context

#86 raised two questions and marked both as needing a human answer:

- **Is Muse a family under the existing Meta organization, or a distinct product
  line?**
- **Do image and video models belong in the current dataset, or wait on #43?**

It also ruled out silence in advance: *"Deciding 'not yet, and here is why' is an
acceptable outcome — but it must be recorded, not left silent."*

**Both questions were answered by data before either was answered in prose, and
this document is written after the fact.** That is stated plainly because the
alternative is to invent a deliberation. There was none. `meta-muse` and its four
releases entered in `0e9867b chore(data): source-backed dataset refresh
2026-08-26 (#302)` — a routine source-backed refresh, not anyone working #86. A
refresh applies claims; it does not write rationale, and it had no way to know a
human had escalated the entity-boundary question. Every mechanical check passed,
because every mechanical check was about the data. The reasoning below is
reconstructed from the dataset, the schema, and the cited sources, and is offered
as the repository's position now — not as a record of what anyone weighed then.

What the refresh left in the dataset, all four carrying `verifiedAt: 2026-08-26`:

| id | date | categories | in → out | source |
|---|---|---|---|---|
| `meta-muse-spark` | 2026-04-08 | `language-reasoning`, `multimodal-generalist` | text, image → text | `ai.meta.com/blog/introducing-muse-spark-msl/` |
| `meta-muse-image` | 2026-07-07 | `image` | text → image | `ai.meta.com/blog/introducing-muse-image-muse-video-msl/` |
| `meta-muse-video` | 2026-07-07 | `video` | text → video, audio | `ai.meta.com/blog/introducing-muse-image-muse-video-msl/` |
| `meta-muse-spark-1-1` | 2026-07-09 | `language-reasoning`, `multimodal-generalist` | text, image → text | `ai.meta.com/blog/introducing-muse-spark-meta-model-api/` |

The second question's history is sharper than #86 could have known, and it is the
part worth keeping. At `13276b0`, the parent of `0e9867b`, the dataset held 11
families and 22 releases, and **not one release carried an `image` or `video`
category, nor produced image or video output**. `meta-muse-image` and
`meta-muse-video` were the first. The crossing from a text-only dataset to one
that is not was made by an unattended refresh, and recorded nowhere.

Three later changes then built on a precedent nobody had written down. Each row
names the entity kind it added, because a family and a release are different
records and the distinction is this document's own subject:

| Commit | Date | What it added |
|---|---|---|
| `0e9867b` (#302) | 2026-08-26 | the `meta-muse-image` and `meta-muse-video` **releases** — the first image and video records |
| `547691a` (#417) | 2026-08-27 | the `openai-gpt-image` **family**, carrying `categories: ["image"]` and no release of its own |
| `0556ec7` (#438) | 2026-08-27 | `openai-gpt-image-2`, that family's first **release**, added under the subject *"add four OpenAI releases for families that rendered empty"* |
| `9f08149` (#562) | 2026-08-29 | the Stable Diffusion 3.5 and Hunyuan Video families **and** their first releases — under the subject *"widen beyond text-only models"* |

The last of those describes itself as the widening. It was three days late; the
widening had already happened. That is the cost of deciding by data, and it is
the concrete reason this ADR is worth the words rather than a formality.

## Decision

Two decisions, stated separately because they are separately citable.

### 1. Muse is a family under `meta`. An organization is the publisher of record.

`meta-muse` is a family whose `organizationId` is `meta`, a sibling of
`meta-llama-3` and `meta-llama-4`. No new organization, no new entity kind, no
new grouping.

The rule behind it, which is what makes this reusable rather than a one-off:

> **The organization is the entity that publishes the releases under its own name
> and at its own release page. A named internal unit is a fact for the family
> description until it becomes the publisher of record.**

That test is observable in the sources rather than a matter of taste, and it is
the test the dataset already passes:

- All three Muse announcements are published on `ai.meta.com/blog/`, and all
  three source records carry `publisherId: meta`. Meta Superintelligence Labs is
  named in the `meta-muse` family description and has, in this dataset, no
  website and no release page of its own to cite.
- The contrast that proves the rule bites rather than merely permitting what
  already happened: **`google-deepmind` *is* its own organization** — `type:
  research-lab`, `website: https://deepmind.google/`, publishing under its own
  name at its own domain. So a named unit inside a larger company can be a
  creator here. DeepMind qualifies; MSL does not, on the sources this dataset
  holds. The rule can return either answer, and does.

Three properties of Muse that might look like they force a new grouping, and why
none of them does:

- **Muse is not Llama.** True and irrelevant to *which creator it belongs to*. A
  family is a lineage under a creator; the creator is whoever publishes it. Meta
  publishes both. `familySchema` carries `organizationId`, and
  `organizationSchema` carries no parent field at all — the organization model is
  flat, deliberately, so "a line that is not the other line" is expressed by
  being a second family and there is no other shape available to express it in.
- **Muse spans text, image, and video.** `familySchema.categories` is
  `z.array(modelCategory).min(1)`, an array precisely so that a family may span
  categories; `microsoft-mai` currently spans four. A multi-category family is
  the schema working, not the schema being strained.
- **`Muse Spark 1.1` is a point release.** `releaseSchema` requires `version` and
  `variant`, and `meta-muse-spark-1-1` carries `version: "1.1"`, `variant:
  "Spark"` alongside `meta-muse-spark`'s `version: "1"`. A point release is a
  release. It needs no grouping of its own, and #86's open question about whether
  a 1.0 existed is answered by `meta-muse-spark` at 2026-04-08, from its own
  announcement URL.

### 2. Image and video releases are in scope, under the existing shared schema.

`modelCategory` already carried `image` and `video` among its nine values, and
`modality` already carried them for `inputModalities` and `outputModalities`.
The capability predates Muse; what was undecided was whether to use it.

Using it was right, and the reason is not that the schema permitted it. It is
that **the alternative asserts something false.** Meta announced Muse Image and
Muse Video in a single post, alongside the Spark lineage this dataset already
records. Recording Spark and withholding Image and Video would render Meta's 2026
line as text-only on the tree, the timeline, and Meta's provider page — a claim
no source supports, made by omission, where a reader has no way to see that
anything was withheld. Recording a properly sourced release with fields shaped
for a neighbouring kind is a lesser fault than that, and it is a visible one.

What is in scope is narrow and is worth stating as a bound rather than a
permission: **a record of an image or video model, carrying exactly the fields
every other release carries** — identity, dates and precision, lifecycle status,
categories, modalities, access type, at least one primary source, and a real
`verifiedAt`. Nothing else. Category-specific schema, category-specific
benchmarks, category navigation and filters, and media presentation are #43's,
and remain open.

## Consequences

### Positive

- The boundary rule is written down and can be applied by the next reader who
  meets a creator's new line, instead of being inferred from four rows by
  somebody who may infer something else.
- The rule is falsifiable against the dataset. `google-deepmind` and `meta-muse`
  are the two worked cases, and they fall on opposite sides, so a later change
  that gets it wrong is arguable against evidence rather than against taste.
- The dataset stops implying by omission that Meta's 2026 output is text-only,
  and the implication is now a recorded choice rather than an accident of what a
  refresh happened to apply.
- #43 inherits a smaller and better-defined remainder. Its scope asks for a pilot
  category with a small source-backed dataset; four image and video records now
  exist to pilot against, and the field shortfall they exhibit is exactly the
  evidence its design work needs.
- #86's two unmet acceptance criteria can be closed on their own terms — a
  recorded decision, with reasons — without touching a byte of `web/src/data/`.

### Costs

- **This is a rationale written after its data, and that gap is real.** The
  decision was taken by a run that could not know the question had been
  escalated. Nothing in the gate set caught it and nothing should have — gates
  check artefacts, and the missing artefact was a judgement. Writing it down now
  does not make the process that skipped it any safer; the last guardrail below
  is prose, and prose is not a gate.
- **The publisher-of-record test depends on the sources the dataset happens to
  hold.** If Meta Superintelligence Labs later publishes under its own name at
  its own release page, the same rule points the other way and `meta-muse` would
  need re-parenting — a data change, with its own review and its own migration of
  every id that names it. The rule is stable; its answer for MSL is not.
- **Image and video releases carry fields shaped for text models and lack fields
  that matter for their own kind.** Resolution, duration, frame rate, and
  aspect-ratio support have nowhere to go, and `contextWindow` and `parameters`
  are optional but conspicuously empty. The dataset therefore says less about
  `meta-muse-video` than about a language model, and the page says nothing about
  that shortfall. This is accepted deliberately, and it is the gap #43 closes.
- **`web/src/data/organizations.json` now under-describes `meta`.** Its
  description reads "Creator of the Llama models, published as downloadable
  weights under Meta's own community licences", which does not describe a creator
  that also ships four proprietary hosted Muse models; its `website` and
  `releasePage` are both Llama-specific. This ADR changes no data, so the
  correction is filed separately rather than smuggled in here.
- **Four families under one creator is not yet a crowd, and one day it will be.**
  Nothing in this decision says at what point a creator's families need
  intermediate grouping in the UI. It says only that the answer is not a new
  entity kind reached for the first time Muse appeared.

## Alternatives Considered

- **Model Meta Superintelligence Labs as its own organization, as
  `google-deepmind` is.** The strongest alternative, and rejected on the sources
  rather than on principle: the announcements are published by Meta, on Meta's
  blog, under `publisherId: meta`, and this dataset holds no MSL website or
  release page to cite. Adopting it would also strand `meta-llama-*` and
  `meta-muse` under different creators on no sourced basis and split Meta's
  provider page in two. If the sourcing changes, so does the answer.
- **Withhold Muse Image and Muse Video until #43 lands.** #86 named this as an
  acceptable outcome, so it gets a real answer rather than a dismissal. Rejected
  because #43 is a large design question with no date, so "until" is unbounded;
  because the two records are properly sourced and schema-valid today; and
  because withholding them makes the dataset state something false by omission,
  invisibly, for that whole unbounded period. An honest record with a known field
  shortfall beats a silent absence.
- **Introduce a "product line" entity between organization and family.** Rejected:
  it adds an entity kind to carry a distinction `family` already carries, against
  a repository rule that entity kinds stay separate and few. Nothing in the four
  Muse records needs it, and an entity kind introduced for one creator's naming
  is a structure that will be wrong for the next one.
- **Split Muse Image and Muse Video into a separate `meta-muse-media` family.**
  Rejected: one announcement launched both, they carry the Muse name, and
  `familySchema.categories` is an array specifically so that a family need not be
  single-category. Splitting on modality would also make the family boundary mean
  two different things depending on which family you are looking at.
- **Record this as a note under `docs/product/` instead of as an ADR.** Rejected
  on this repository's own stated split: `DEPLOYMENT-RUNBOOK.md` places owner
  decisions about the product's public surface in `docs/product/` and reserves
  `docs/adr/` for "architecture decisions written in the ADR format". Entity
  boundaries are the data model's architecture — the same class as ADR 0002's
  reviewed-artefact rule — and this decision needs a Guardrails section, which
  the product documents do not carry.

## Guardrails

- **This does not resolve #43, and may not be cited as resolving it.** #43 asks
  for discriminated category-specific schemas, category navigation and filters,
  benchmark views that refuse cross-category comparison, and — its first
  acceptance criterion — an ADR documenting shared versus category-specific
  concepts. **This is not that ADR and does not attempt to be.** It settles one
  narrow thing: an image or video release may be *recorded* under the existing
  shared schema. Every design question #43 names is still open, and closing #43
  on the strength of this document would close it on work nobody did.
- **Do not add a `modelCategory` member on the strength of this decision.** The
  nine values are the schema's; *using* one is a data change, *adding* one is a
  schema change, and schema changes for new categories are #43's.
- **A named internal unit becomes its own organization only when it is the
  publisher of record** — its own name on the announcement and its own release
  page, both cited from primary sources. "Meta Superintelligence Labs built it"
  is a fact for the family description, not grounds for a new creator.
- **Do not collapse the entities this keeps apart.** Muse is a family; MSL is
  prose in that family's description; any API that serves Muse Spark is a serving
  platform if it is ever recorded. None of the three is the other, and no
  composite score or universal ranking follows from any of them.
- **An unattended refresh may not be the thing that answers a question an issue
  escalated for human judgement.** Where a run's data would settle an open
  entity-boundary or scope question, the data is not the answer and publishing it
  is not recording it. Nothing enforces this — it is the one guardrail here with
  no script behind it, which is precisely how #86 happened and is stated as an
  open weakness rather than a solved one.
