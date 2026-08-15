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

Unknown facts remain omitted. Family membership does not imply an undocumented
predecessor, successor, or architecture relationship.

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
  Current measurement is 561 bytes per row.

`planPagination` slices a sorted slug list into fixed page boundaries, so adding
a record that sorts onto the end leaves earlier pages unchanged.
