# ModelTree Web

Static Astro application for **ModelTree - AI Model Lineage**.

The first vertical slice renders one source-backed OpenAI family as an
interactive lineage and generates a Model Passport for each seeded release.
Astro renders the full hierarchy to HTML; one React island enhances model
selection and stable `?model=<slug>` state.

## Commands

Run commands from `web/`:

| Command | Action |
|---|---|
| `npm ci` | Install dependencies exactly from the lockfile |
| `npm test` | Run data-integrity and URL-state tests |
| `npm run check` | Run Astro and TypeScript diagnostics |
| `npm run validate` | Run tests and diagnostics |
| `npm run build` | Validate and generate the static site in `dist/` |
| `npm run dev` | Start the local Astro development server |

## Data

Editable source records live in `src/data/*.json`. `src/data/schema.ts` defines
the entity contracts, and `src/data/validate.ts` enforces cross-record rules.

| Entity | Holds |
|---|---|
| `organization` | A creator, lab, or platform operator |
| `family` | A named model lineage belonging to one organization |
| `release` | A dated model version, its tier, limits, licence, and relationships |
| `product` | A user-facing application, which may route between models |
| `servingPlatform` | Somewhere a model can be accessed, rarely its creator |
| `deployment` | One release made available on one platform |
| `pricingRecord` | Rates for one deployment, with currency, unit, and effective date |
| `benchmarkDefinition` | What a benchmark measures, in which unit and direction |
| `benchmarkResult` | One score for one exact release, with its evaluation setup |
| `releaseEvent` | A dated lifecycle event such as announced or deprecated |
| `source` | The primary reference and the date it was last checked |

The build fails for duplicate identifiers or slugs, impossible or partial dates
that contradict their stated precision, broken references, non-reciprocal
siblings, effective ranges that end before they start, prices with no rate,
benchmark results whose unit contradicts their benchmark or that duplicate an
existing setup, and featured releases without a primary source.

Downloadable weights and OSI-approved licensing are separate fields. Claiming
`accessType: "open-weight"` requires a licence that actually releases weights,
and claiming `osiApproved` requires an SPDX identifier or a licence URL.

The seed data was checked against these official pages on 2026-08-14:

- <https://openai.com/index/gpt-4-1/>
- <https://developers.openai.com/api/docs/models/gpt-4.1>
- <https://developers.openai.com/api/docs/models/gpt-4.1-mini>
- <https://developers.openai.com/api/docs/models/gpt-4.1-nano>

Anthropic, Google DeepMind, and Meta records were checked against the pages
listed in `src/data/sources.json` on 2026-08-15. Every URL there returned HTTP
200 during that pass. Recorded titles are the document's own title without the
site suffix a publisher appends to the browser `<title>`, so "Models overview"
is recorded where the browser tab reads "Models overview - Claude Platform Docs".

Unknown facts remain omitted. Family membership does not imply an undocumented
predecessor, successor, or architecture relationship.

### Data notes

Where sources disagree or fall short, the dataset records the conservative
reading and the disagreement is written down here rather than resolved silently.

- **Claude Haiku 4.5 date.** The model identifier is `claude-haiku-4-5-20251001`
  but the launch announcement is dated 15 October 2025. The announcement date is
  recorded, because a dated announcement is a stronger claim than a date embedded
  in an identifier. Identifier dates are not treated as release dates anywhere.
- **Llama 3.3 date.** The `meta-llama/llama-models` README table says 12/04/2024
  while the model card and the licence both say 6 December 2024. The model card
  date is recorded.
- **Gemini 2.5 shutdown.** `ai.google.dev` states that no shutdown date has been
  announced for Gemini 2.5 Pro and Flash, while the Cloud platform model pages
  give a retirement date of 2026-10-20. Both models are recorded as `current`
  and no shutdown date is asserted.
- **Gemini 3.7 Flash is excluded.** Its documentation gives only "August 2026".
  `releaseDate` is a full ISO date, so a month-only release cannot be represented
  without inventing a day. Tracked as issue #48.
- **Llama 4 Maverick parameter count.** The model card's own table gives 400B
  total, while the Hugging Face repository metadata on the same page reports
  402B. The model card figure is recorded, because it is the count Meta states in
  prose rather than one derived from the uploaded weights.
- **Gemini 2.5 Pro and Flash are siblings** because a single technical report
  covers "our Gemini 2.5 models" as one set, not merely because they shared a
  general-availability date.
- **Claude Mythos 5 records no derivation.** Anthropic's docs say Mythos 5 "shares
  the same capabilities" as Claude Fable 5 and that the two "share the same specs
  and pricing". That is a statement of equivalence, not of parentage — it does not
  say either was produced from the other, and the docs note a real difference
  (Mythos 5 omits the safety classifiers that can decline a request).
  `derivedFromIds` is therefore empty and the relationship is carried by the
  sibling link. Mythos 5 is not featured, because it is only available to invited
  customers.
- **Gemini 3.1 Flash-Lite's successor is a migration recommendation.** The
  deprecations table names Gemini 3.5 Flash-Lite as its recommended replacement.
  That is recorded as `successorIds` because the two are the same tier in the same
  family; a recommended replacement in a different tier would not be.
- **No Meta lineage is recorded.** The Llama 4 announcement does state that Llama
  4 Maverick was codistilled from Llama 4 Behemoth, but Behemoth was never
  released and has no record here, so there is no id to point at. `derivedFromIds`
  is empty because the parent cannot be referenced, not because no source names
  one. The Llama 3 cards state no derivation at all.
- **Claude 4.5 lifecycle wording differs between two cited pages.** The
  deprecations table lists `claude-sonnet-4-5-20250929` and
  `claude-haiku-4-5-20251001` as Active, while the models overview places Sonnet
  4.5 in its Legacy accordion. The family follows the overview's grouping and is
  recorded as `legacy`; no retirement date is asserted for either model.
- **Llama licences are open-weight, not open source.** Each Llama Community
  License requires a separate licence from Meta above 700 million monthly active
  users, which is incompatible with free redistribution, so `osiApproved` is
  `false` on every Meta release.
- **Lifecycle mapping.** Anthropic "Retired" maps to `deprecated`, invitation-only
  availability maps to `preview`, and the docs' "Legacy models" section maps to
  `legacy`. On Hugging Face, Meta's "Current" and "History" groupings map to
  `current` and `legacy`.

## Catalog indexes

The build emits `dist/catalog-index.json`: normalized model, provider, alias,
facet, and release-date indexes derived from the validated dataset. They are
generated artifacts, never an editable source of truth.

- Generation is deterministic. Identical data produces an identical file, and the
  index carries a `contentHash` instead of a build timestamp.
- Listing rows carry no detail payload. Summaries, sources, and API aliases stay
  on the detail route and in the alias index.
- Sorting compares by codepoint, so output does not vary with the host locale.
- Aliases and providers keep their entity role, so a name shared by a model and
  an organization stays two distinguishable rows.
- Every model row must resolve to a generated detail route or the build fails.
  `src/lib/routes.ts` is the single list the model route and that check share.
- Budget: **600 bytes per model row**, keeping a 24-row catalog page under 20 KB.
  Current measurement is 557 bytes per row across 16 models.

`planPagination` slices a sorted slug list into fixed page boundaries, so adding
a record that sorts onto the end leaves earlier pages unchanged.
