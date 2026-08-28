# Contributing to ModelTree

ModelTree is a source-backed map of AI creators, model families, and releases.
Contributions are welcome, and the most valuable ones are usually small: one
release that is missing, one number that is wrong, one date that turned out to
be an announcement rather than an availability date.

**You do not need to open a pull request, and you do not need to understand the
site's internals.** A well-sourced issue is a complete contribution.

- [Report incorrect data](https://github.com/abdeslam-menacere/ModelTree/issues/new?template=data-correction.yml)
  — something on the site is wrong or out of date
- [Submit a model or release](https://github.com/abdeslam-menacere/ModelTree/issues/new?template=submit-release.yml)
  — something is missing

Both forms live in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/), as
`data-correction.yml` and `submit-release.yml`. Every "Report incorrect data"
link on a Model Passport page opens a correction prefilled with the record it
came from, so the fastest way to report a specific fact is from the page showing
it.

## The one rule everything else follows from

**Every important fact carries a primary source and a verification date.**

A *primary source* is the party that would know first-hand: the creator's own
announcement, documentation, model card, or repository. For a benchmark's
definition, it is whoever owns the benchmark. A news article, a leaderboard
screenshot, or another directory is a good way to *find* a primary source and is
not one.

A *verification date* — the `verifiedAt` field — is the day you personally read
that source and saw it say what the record claims. It is not the publication
date, and it is not today by default. Pages change; a claim with no date has no
shelf life.

The [published methodology](https://abdeslam-menacere.github.io/ModelTree/methodology/)
is the full policy: what counts as evidence, how conflicts are treated, and why
nothing here is ranked overall. It is deliberately not repeated in this file, so
that the two cannot disagree.

### Three habits that get a contribution accepted

1. **Quote the sentence.** Reviewers confirm claims against the words on the
   page. A link plus the line that supports the claim is worth more than a long
   explanation.
2. **Leave unknowns blank.** A blank field is a fact ModelTree publishes happily:
   *nobody has sourced this yet.* A plausible value that no source states is the
   single most expensive thing you can add, because it looks identical to a
   verified one. If a source says "August 2026", record `2026-08` — do not
   complete the date.
3. **Record disagreements as disagreements.** If two sources give different
   numbers, say so and cite both. ModelTree keeps conflicts visible rather than
   averaging or quietly preferring one.

### Two things ModelTree will not accept

- **An overall score, rating, or universal ranking.** Benchmarks are contextual
  evidence recorded with the setup they were run under. There is no composite
  number, and a contribution that proposes one will be declined on principle
  rather than on quality.
- **A record that collapses two entities.** See below.

## The entities, and why they are separate

The most common modelling mistake is treating a name as one thing. "GPT-5" can
refer to a model, the product you chat with, and a string you pass to an API, and
those change independently of each other. ModelTree keeps them apart.

| Entity | What it is | What it is not |
|---|---|---|
| **Organization** | A creator or an operator: a lab, company, nonprofit, or community | Not the product it sells |
| **Family** | A model line, without a version — *Claude Sonnet*, *Llama 4* | Not a single release |
| **Release** | One specific version of one model, with its own dates and limits | Not the family, and not the API string |
| **Product** | Something a person uses, which may route between models | Not the model it runs on |
| **Serving platform** | Somewhere a model is offered, usually run by someone else | Not the creator |
| **Deployment** | One release, offered on one platform, over a date range | Not a price |
| **Pricing** | Rates for one deployment, in one currency, per stated unit | Not a rate card for a model |
| **Benchmark** | A test's definition: metric, unit, direction, owner | Not a score |
| **Benchmark result** | One score for one release, with the setup it ran under | Not comparable to a result under a different setup |
| **Source** | A citation: URL, title, type, and when it was last checked | Not a claim |
| **Publisher** | Who stands behind a source | Not necessarily the creator |

A useful test: *if this fact changed tomorrow, which record would change?* If the
answer is "two of them", it belongs to whichever one it is actually about.

## A minimal valid example of every entity

[`docs/contributing/minimal-dataset-example.json`](docs/contributing/minimal-dataset-example.json)
holds one canonical, minimal record for each entity above, wired together into a
dataset that passes this repository's real validator. It is checked by the test
suite on every run, so it cannot rot into an example that no longer validates.

Read it as a shape, not as data. Every record in it is fictional and every URL
points at `example.com`, which is reserved for exactly this purpose and can never
be mistaken for a real citation. It deliberately demonstrates two things the
schema allows but a hurried contribution often gets wrong: the serving platform
is operated by a *different* organization from the model's creator, and the
benchmark is owned by a third party who is not a primary source for anything
about the model itself.

## Where the data lives

Data is versioned JSON under `web/src/data/`, validated with
[Zod](https://zod.dev) in `schema.ts` and checked for referential integrity in
`validate.ts`. There is no database and no API: **the site never fetches data at
runtime.** Everything it shows was committed to this repository and built into a
static site, which is what makes a fact reviewable as a diff.

That is the point of the project's eighth principle — data changes are reviewable
repository changes — and it is why a correction is an ordinary pull request or
issue rather than a form submission that goes somewhere else.

## Adding one release yourself

You do not have to do any of this; the submission form is enough. If you would
rather send the change directly:

1. **Find the primary source first**, and note the date you read it. If you
   cannot find one, file an issue instead — that is a genuinely useful outcome
   and it saves the next person the same search.
2. **Install and confirm a clean baseline.** From `web/`, run `npm ci` and then
   `npm run validate`. Use `npm ci` rather than `npm install`: `install` rewrites
   `package-lock.json`, which this repository's tests guard, so it produces
   failures that look like your change broke something.
3. **Reuse the source if it already exists.** Look through
   `web/src/data/sources.json` for the URL before adding a new record; sources
   are shared by id, and a duplicate URL fails validation.
4. **Add the release** to `web/src/data/releases.json`, following the shape in
   the minimal example. Its `familyId` and `organizationId` must already exist,
   its `releaseDate` cannot precede its family's `firstReleaseDate`, and its
   `verifiedAt` cannot precede its `releaseDate`.
5. **Validate.** From `web/`, `npm run validate` runs the data tests and the
   TypeScript and Astro diagnostics together. It is the single command that has
   to pass, and `npm run build` runs it before building, so a broken data change
   cannot ship.
6. **Open a pull request** and fill in the *Factual changes* checklist in the
   template. Quote the real output of the command above.

If validation fails, read the message before changing anything: it names the
record and the field, and most failures are a missing `sourceIds` entry, a
`verifiedAt` earlier than the date it verifies, or an id that does not resolve.

### Running the site

From `web/`: `npm run dev` serves it locally, `npm run check` runs the
diagnostics on their own, and `npm run test` runs the suite on its own. Every
command in this project runs from `web/` — the repository root is not a Node
project.

## Accessibility and performance are acceptance criteria

They are not a polish pass, and a change is not finished without them. Keyboard
operation and screen-reader labelling must work; anything that animates must
respect `prefers-reduced-motion`; and the asset budgets are limits rather than
targets. A pull request that regresses any of these is sent back the same way one
with a missing source is.

The same applies to what you write here. Documentation uses semantic headings and
descriptive link text, so that a link makes sense read on its own, out of the
sentence around it.

## Review ownership and cadence

The repository owner, [@abdeslam-menacere](https://github.com/abdeslam-menacere),
reviews and merges changes, and is the code owner for everything except the
dataset documents an automated refresh is allowed to touch. See
[`.github/CODEOWNERS`](.github/CODEOWNERS), which explains that exception and why
it is drawn where it is.

What to expect:

- **Correction issues** are triaged as they arrive; ones that cite a primary
  source and quote it are the fastest to act on, because there is nothing left to
  research.
- **Submission issues** are queued against the automated refresh described below,
  which sweeps the creators it covers on a daily schedule. A submission for a
  creator already covered may be picked up by that run rather than by hand.
- **Pull requests** are reviewed against the checklist in the template. Scope is
  the most common reason for a change to be sent back: an unrelated fix bundled
  into a data correction makes both harder to judge.

Nothing here is a service-level promise. This is a small project, and a report
that sits for a while has not been rejected.

### The automated path, and its limits

Data refreshes also run automatically: agents research each creator from primary
sources, three independent reviewers judge every claim, deterministic gates run
that no majority can overrule, and a pull request opens and merges itself once CI
is green. That narrows the eighth principle rather than repealing it — the change
is still a reviewable pull request carrying every quote and verdict, but no human
approves it before it merges.

Only the dataset documents may change that way, and only through that pipeline.
[ADR 0003](docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md) records
the decision and what it costs. Everything else — including every change you
make by hand — takes the ordinary reviewed path.

## Changing code rather than data

Code contributions follow the same route, with two additions: behaviour that
changes needs a test that fails without the change, and the change must stay
inside the issue it belongs to.

This repository is worked with [Drydock](docs/product/): each issue gets its own
branch, worktree, and agent session, and a pull request cannot open until review
and QA have both passed against the current commit. Architecture decisions are
recorded in [`docs/adr/`](docs/adr/) and product context in
[`docs/product/`](docs/product/); read the relevant one before changing
structure.

## Reporting something that is not a data problem

A broken page, a keyboard trap, a slow route, or a confusing label is worth
reporting too. Use the correction form and say plainly that it is not a factual
error — describing what you did, what happened, and what you expected is enough.

## License

By contributing you agree that your contributions are licensed under the
repository's [MIT License](LICENSE).
