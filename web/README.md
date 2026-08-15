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
The build fails for duplicate identifiers or slugs, impossible dates, broken
references, non-reciprocal siblings, and featured releases without a primary
source.

The seed data was checked against these official pages on 2026-08-14:

- <https://openai.com/index/gpt-4-1/>
- <https://developers.openai.com/api/docs/models/gpt-4.1>
- <https://developers.openai.com/api/docs/models/gpt-4.1-mini>
- <https://developers.openai.com/api/docs/models/gpt-4.1-nano>

Unknown facts remain omitted. Family membership does not imply an undocumented
predecessor, successor, or architecture relationship.
