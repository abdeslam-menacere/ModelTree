# ModelTree

**The living family tree of AI models.**

A source-backed map of AI creators, model families, releases, and the
relationships between them. ModelTree helps you tell a *model* apart from the
product or platform that serves it, see what came before and after it, and
inspect comparable evidence without treating any one benchmark as universal
truth.

> AI model names mix creators, products, families, tiers, versions, aliases, and
> API identifiers. Existing directories optimise for breadth, pricing, or
> ranking — they rarely explain lineage, or keep enough context to make
> historical and benchmark claims trustworthy.

## What you can answer in seconds

1. Who created this model?
2. Which family and tier does it belong to?
3. When was it released, and what is its lifecycle state?
4. What related releases came before, beside, or after it?
5. Is it hosted, downloadable, or both — and where?
6. Which source supports each important fact?
7. Which evidence is genuinely comparable with another model?

## Principles

1. Clarity before completeness.
2. History is a first-class feature.
3. Important facts carry provenance and a verification date.
4. Unknown and conflicting data stay explicit.
5. Creator, model, product, and serving platform are separate entities.
6. Benchmarks are contextual evidence, not universal truth.
7. Accessibility and speed are requirements, not polish.
8. Data changes are reviewable repository changes.

## Not goals

Complete historical coverage at launch · live API monitoring · original
large-scale benchmark runs · a proprietary universal score · user accounts ·
unreviewed automatic ingestion.

## Quick start

The site is an [Astro](https://astro.build) static build. All commands run from
`web/`:

```bash
cd web
npm ci
npm run dev
```

| Command | Action |
|---|---|
| `npm ci` | Install exactly from the lockfile |
| `npm test` | Data-integrity and URL-state tests |
| `npm run check` | Astro and TypeScript diagnostics |
| `npm run validate` | Tests and diagnostics together |
| `npm run build` | Validate, then build the static site to `dist/` |

## Layout

```
web/               the Astro site
  src/data/        seed data — organizations, families, releases, sources
  src/pages/       routes, including generated Model Passport pages
  src/lib/         data loading, validation, URL state
tools/updater/     proposal-only data updater (Python, run separately)
docs/product/      product brief, information architecture, backlog
docs/adr/          architecture decision records
.github/           agent contracts, issue forms, workflows
```

Data lives in versioned JSON under `web/src/data/`, validated with
[Zod](https://zod.dev). A data correction is an ordinary pull request — which is
the point of principle 8.

[`tools/updater/`](tools/updater/README.md) is a separate Python tool that only
*proposes* sourced updates for a human to review. It cannot write dataset JSON,
create a branch, or open a pull request, which keeps principle 8 and the "no
unreviewed automatic ingestion" not-goal intact.

## Contributing

Corrections are welcome, especially sourced ones. Every important fact needs a
primary source and a verification date; a change that adds a claim without one
will be sent back.

Open an issue using the feature form in `.github/ISSUE_TEMPLATE/`, and be
specific about what is **explicitly out of scope** — that field is what keeps a
change reviewable.

### How this repo is worked

ModelTree uses [Drydock](docs/product/): every issue gets its own branch, its
own git worktree, and its own agent session, and a pull request cannot open
until review and QA have both passed against the current commit. The gate
verdicts live in `.drydock/docks/`, and the role contracts in `.github/agents/`.

The Drydock CLI is installed separately — it is a tool, not a dependency of this
project.

## Status

Early. The first vertical slice proves the architecture on one OpenAI family: a
deployable shell, validated seed data, an interactive lineage, one Model
Passport, and visible primary-source attribution. Coverage expands from there —
see [`docs/product/BACKLOG.md`](docs/product/BACKLOG.md).

## License

MIT — see [LICENSE](LICENSE).
