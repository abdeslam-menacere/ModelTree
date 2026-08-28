# <img src="docs/assets/modeltree-logo.svg" alt="" width="30" height="30"> ModelTree

**The living family tree of AI models.**

**[Open the live site →](https://abdeslam-menacere.github.io/ModelTree/)**

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
ingestion without sources, review, and gates.

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
  src/data/        seed data — organizations, families, releases, benchmarks, sources
  src/pages/       routes, including generated Model Passport pages
  src/lib/         data loading, validation, URL state
tools/updater/     proposal-only data updater (Python, run separately)
.github/skills/    the agent skills that refresh the data end to end
.github/agents/    the Drydock role contracts — dev, reviewer, QA
.github/workflows/ CI, the Pages deploy, and scheduled source-link health
.drydock/          per-dock records and the gate verdicts bound to each commit
docs/product/      product brief, information architecture, backlog, deployment runbook
docs/adr/          architecture decision records
docs/assets/       repository images
```

Data lives in versioned JSON under `web/src/data/`, validated with
[Zod](https://zod.dev). A data correction is an ordinary pull request — which is
the point of principle 8.

[`tools/updater/`](tools/updater/README.md) is a separate Python tool that only
*proposes* sourced updates for a human to review. It cannot write dataset JSON,
create a branch, or open a pull request.

### Keeping the data current

`refresh ModelTree data`, said once, runs the whole loop:
[`.github/skills/`](.github/skills/README.md) researches every creator from
primary sources, has three independent reviewers judge each claim, applies
deterministic gates that no majority can outvote, and opens a pull request that
merges itself once CI is green — after which the site deploys.

```mermaid
flowchart TD
    A1["Daily scheduled Copilot session<br/>operator's machine — not .github/workflows"]
    A2["A person says:<br/>'refresh ModelTree data'"]
    A1 --> R
    A2 --> R
    R["<b>modeltree-refresh</b> — orchestrates stages 0–5<br/>0. Preflight: clean tree, authenticated gh,<br/>no earlier refresh PR still open"]

    P[("Primary sources<br/>reviewed catalogues")] --> S
    R --> S["<b>1. modeltree-scout</b><br/>fetch, never recall"]
    S --> B["<b>Claim bundle</b> — one atomic claim per fact<br/>URL · SHA-256 of page as fetched<br/>fetch date · verbatim quote<br/><i>search snippets refused outright</i>"]

    B --> V["<b>2. modeltree-review</b><br/>three rubrics, independent,<br/>issue text + diff only"]
    V --> V1["<b>provenance</b><br/>does the source actually say this?"]
    V --> V2["<b>consistency</b><br/>does it fit what we already know?"]
    V --> V3["<b>editorial</b><br/>is it saying the right kind of thing?"]
    V1 --> T
    V2 --> T
    V3 --> T
    T{"Threshold met?<br/>2-of-3 reviewed profile<br/>3-of-3 long-tail"}
    T -- no --> DROP["Claim dropped"]

    T -- yes --> G["<b>3. modeltree-gates</b> — deterministic<br/><i>no majority can outvote these</i>"]
    G --> G1["<b>gate-scope</b><br/>only ALLOWED_PATHS touched,<br/>measured from merge-base with origin/main"]
    G --> G2["<b>gate-evidence</b><br/>evidence well-formed (ADR 0005)"]
    G --> G3["<b>gate-source-approval</b><br/>a run never approves its own source"]
    G --> G4["<b>gate-dataset</b><br/>schema + dataset coherence"]
    G1 --> GG
    G2 --> GG
    G3 --> GG
    G4 --> GG
    GG{"All gates pass?"}
    GG -- no --> STOP["Run stops and files an issue<br/><i>the correct outcome, not a failure</i>"]

    GG -- yes --> PUB["<b>4. modeltree-publish</b><br/>apply accepted claims, commit,<br/>open PR with full evidence trail,<br/>enable auto-merge"]
    PUB --> CI{"<b>web-ci</b> green?<br/>required by branch protection"}
    CI -- no --> STOP
    CI -- yes --> M["GitHub merges to main<br/>no human approval — ADR 0003"]
    M --> PGS["<b>pages.yml</b> builds and deploys<br/>abdeslam-menacere.github.io/ModelTree"]
    PGS --> SUM["<b>5.</b> Confirm deploy · file summary issue<br/>failed deploy opens a stale-site issue;<br/>recovery closes it"]
```

That is genuinely automatic ingestion, and it narrows principle 8: a data change
is still a reviewable pull request carrying every quote, hash, and verdict, but
no human approves it before it merges. Only the dataset documents listed in
`ALLOWED_PATHS` in
[`.github/skills/modeltree-gates/scripts/gate-scope.mjs`](.github/skills/modeltree-gates/scripts/gate-scope.mjs)
may change that way — that list is the authority, and no count of it is repeated
here to go stale. Anything outside it stops the run and files an issue.
[ADR 0003](docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md) records the
decision and is honest about what it costs.

The daily run is **scheduled outside this repository**, by the operator, as a
recurring agent session on their own machine. `.github/workflows/` contains no
cron that triggers it, so nothing here will start a refresh on its own.

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

Live, and expanding. Shipped so far: the interactive lineage at `/tree`; the
`/models` catalog with filters, sort, and pagination; a generated Model Passport
page per release; the `/refresh` log browser; a seeded benchmark corpus with
comparability recorded rather than assumed; and several reviewed creators
alongside long-tail profiles.

The refresh log reads `web/src/data/refresh-runs.json`, which is loaded by
`web/src/data/refresh-log.ts` and by nothing else. It is not written by the
refresh run — no skill names it, and it is absent from `ALLOWED_PATHS`, so a
refresh cannot touch it.

Coverage expands from here — see
[`docs/product/BACKLOG.md`](docs/product/BACKLOG.md).

## License

MIT — see [LICENSE](LICENSE).
