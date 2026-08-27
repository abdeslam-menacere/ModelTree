# Workflows

What runs, when, with what permissions, and — the point of this file — the exact
**status check names**, so branch protection can require the right ones and only
the right ones.

## What runs

| Workflow | Triggers | Covers |
|---|---|---|
| [`web-ci.yml`](web-ci.yml) | `pull_request` (every one), `workflow_dispatch` | Validates and builds the Astro site under `web/` |
| [`skills-ci.yml`](skills-ci.yml) | `pull_request`, path-filtered to `.github/skills/**`, `.github/scripts/**`, `.github/workflows/skills-ci.yml` and `web/src/data/**`, `workflow_dispatch` | The data-refresh gates' self-tests, `gate-dataset` run against the live dataset, and a refusal of a hand-written test count in the skill documentation — a numeral described as tests, self-tests, test cases or assertions, in either order, with markdown emphasis tolerated around the numeral, and a table column whose heading is one of those nouns and whose body cell is a bare number. Noun-first needs a real separator, of the kind a label or a table cell supplies (`tests: 103`), so the verb reading — "the gate tests 4 kinds of emptiness" — is not a count, and nor is a year after `in` or `since`, a written-out number, a singular `N test`, or `N checks`, which in this repository usually means a status check. It reads one line at a time, so a count split across two lines of prose is not seen, and where it errs it over-matches: "adds 3 tests" is flagged although it sizes a change rather than the suite. The script header carries the same list with the reasoning |
| [`updater-tests.yml`](updater-tests.yml) | `pull_request` and `push` to `main`, path-filtered to `tools/updater/**`, `.github/workflows/updater-tests.yml`, `.github/workflows/publish-updater-proposals.yml`, `tools/instruction_refs/**`, `.github/skills/**`, `.github/workflows/instruction-references.yml`, `tools/adr_numbers/**`, `.github/workflows/adr-numbers.yml` and `docs/adr/**`, `workflow_dispatch` | The updater's pytest suite, which is also where this repository's stdlib-Python invariants are asserted |
| [`instruction-references.yml`](instruction-references.yml) | `pull_request` and `push` to `main`, path-filtered to `.github/copilot-instructions.md`, `.github/skills/**`, `tools/instruction_refs/**` and `.github/workflows/instruction-references.yml`, `workflow_dispatch` | Resolves the paths, issue citations, and section markers in the instructions file, and every issue citation in the skill documents. A `#NNN` inside a fenced code block is not read as a citation — it is sample content such as a colour or a quoted shell argument — and each is reported as a named exemption rather than skipped in silence. The delimiter lines stay in scope, so a citation in an info string, or on the line above or below a block, is still refused; indented code blocks and inline `` `#N` `` spans are deliberately still scanned, for reasons the checker's module docstring records. Only the citation rule consults that fence model, so a broken path inside a fenced example is still reported. Not every path, and the shortfall has two parts worth stating separately. A backticked reference the file wraps across two lines is read as one span when neither fragment carries whitespace, which keeps the backtick pairing in phase so the reference after it is still checked; the wrapped one is not itself resolved, because what the document renders is its two fragments joined by a space, which is not a path, and joining them without the space would be a guess at what the author meant. Where either fragment does carry whitespace — a wrapped command line, say, which is the shape this repository actually contains today — the pairing still goes out of phase and the next reference on that line is still missed, unreported rather than reported wrong. That one stays open because such a wrap and a stray unpaired backtick followed by prose are the same text, and admitting the first admits the second, which was measured to lose a broken path the narrower rule catches |
| [`adr-numbers.yml`](adr-numbers.yml) | `pull_request` and `push` to `main`, path-filtered to `docs/adr/**`, `tools/adr_numbers/**` and `.github/workflows/adr-numbers.yml`, `workflow_dispatch` | Refuses two decision records under `docs/adr/` that claim the same four-digit number, and a record whose `# ADR NNNN:` heading disagrees with the number in its filename |
| [`pages.yml`](pages.yml) | `push` to `main`, `workflow_dispatch` | Builds and deploys the site, reports a failed deploy, and resolves that report when the deploy recovers |
| [`publish-updater-proposals.yml`](publish-updater-proposals.yml) | `workflow_dispatch` only | Files creator proposals as issues |

## Status check names

A required status check is matched by the **job name**, not the workflow name. The
names below are part of the repository's configuration surface: renaming a job
silently stops the corresponding branch protection rule from ever being
satisfied, because GitHub waits for a check that no longer reports.

| Check name | Workflow | Safe to require? |
|---|---|---|
| `web-ci` | `web-ci.yml` | **Yes** |
| `pytest (Python 3.11)` | `updater-tests.yml` | No — see below |
| `pytest (Python 3.13)` | `updater-tests.yml` | No — see below |
| `instruction-references` | `instruction-references.yml` | No — see below |
| `adr-numbers` | `adr-numbers.yml` | No — see below |
| `skills-ci` | `skills-ci.yml` | No — see below |

### Why `web-ci` is safe to require

It runs on **every** pull request. It has no `on.pull_request.paths` filter;
instead its first step diffs the pull request against its base and decides
whether the site actually needs building. A pull request that touches nothing
under `web/` gets a green `web-ci` in a few seconds without installing Node or
running the suite.

That distinction matters. A workflow filtered at the trigger does not start at
all on a non-matching pull request, so it reports **no check** — and a required
check that never reports is treated as pending forever, which blocks the pull
request permanently rather than passing it. `web-ci` is deliberately built to
report unconditionally so it can be required without that trap.

The job id and its `name:` are both the literal string `web-ci`, and the job has
no `strategy.matrix`, so the reported name never varies per leg or per run.

### Why the `pytest` checks are not

`updater-tests.yml` is path-filtered to `tools/updater/**` (and to
`.github/workflows/updater-tests.yml`,
`.github/workflows/publish-updater-proposals.yml`, `tools/instruction_refs/**`,
`.github/skills/**`, `.github/workflows/instruction-references.yml`,
`tools/adr_numbers/**`, `.github/workflows/adr-numbers.yml` and `docs/adr/**`,
whose behaviour or structure the suite asserts), so it reports nothing on a pull
request confined to
`web/`. Requiring either leg would block every web change indefinitely. Its names
also carry the Python version, so adding or dropping a version changes them.

### Nor is `instruction-references`

Same trap, for the same reason: `instruction-references.yml` is path-filtered to
`.github/copilot-instructions.md` among other paths (see the table above), so it
reports no check at all on the great
majority of pull requests, and each of those would sit pending forever. Whether
it is ever required is a branch-protection decision — issue #80 in this
repository — not something this workflow decides.

The job installs nothing and reaches no network: the checker is standard library
only, so the whole job is a checkout, a Python, and one command. It takes no
arguments, so it always resolves the governing file and cannot be pointed at
something easier, and it has no `--skip` or `--force`. A genuine exception
belongs in branch protection, where it is auditable.

### Nor is `adr-numbers`

The same trap again: `adr-numbers.yml` is path-filtered to `docs/adr/**` among
other paths (see the table above), and
decision records change rarely, so it reports no check on almost every pull
request. Making it required is a branch-protection change and needs the
repository owner, because requiring a check that does not report is what
deadlocks a pull request — not something this workflow can decide for itself.

It is **not** part of #169, whose scope is stated once below under **What
issue #169 covers**. Nothing in this repository files the question of whether
`adr-numbers` should become required, so it is recorded here as unfiled rather
than settled with an issue number a reader cannot check.

It is built to the same shape as `instruction-references`: standard library only,
so the job is a checkout, a Python, and one command; no arguments, so it always
examines `docs/adr/` and cannot be aimed at an emptier directory; and no `--skip`
or `--force`. It fails when two files under `docs/adr/` share a leading
four-digit number, naming both paths and the number. Gaps and ordering are out of
scope — two pull requests each adding the next ADR would collide by construction
under a contiguity rule, and a check that fires on correct work gets worked
around rather than fixed.

### Nor is `skills-ci`

Same trap again. `skills-ci.yml` is path-filtered to `.github/skills/**`,
`.github/scripts/**`, `.github/workflows/skills-ci.yml` and `web/src/data/**`,
so it reports no check at all on a pull request that touches none of them — a
documentation-only or `tools/updater/`-only change, for instance — and each of
those would sit pending forever if the check were required. Making it required
is a branch-protection change, and branch protection is an owner action.

It is **not** covered by #169, despite being the same family of problem: #169
places `skills-ci` expressly outside its own scope, as a related decision to be
settled alongside it rather than inside it. What #169 *does* cover is stated
once below, under **What issue #169 covers**.

The consequence is worth stating plainly rather than leaving implied: because
`skills-ci` is **not** required and `web-ci` is the only required context, a red
`gate-dataset` run makes a bad data change *visible* on the pull request but does
**not** stop it merging. Running is not blocking.

`web-ci` shows the shape of the fix — no trigger filter, an in-job diff that
decides whether the real work is needed, so the check always reports and is
therefore safe to require. Restructuring `skills-ci` the same way would make it
requirable without the deadlock. That is a proposal recorded here, not something
this file enacts.

### What issue #169 covers

This is the only place in this file that states #169's scope. The `adr-numbers`
and `skills-ci` sections above defer to it, so the question has one answer here
rather than two that can drift apart.

Issue #169 is **two specific gaps** in branch protection on `main`:

1. the `pytest` legs are not required contexts, so a pull request that breaks
   the Python suite while leaving `web-ci` green still satisfies protection; and
2. `strict: false` lets two individually-green pull requests merge into a
   combination neither was tested in.

Both gaps were still open when the live settings were read on 2026-08-26:
`required_status_checks.contexts` was `["web-ci"]` and `strict` was `false`.

**That scope is stated in a comment on #169, not in its body** — [comment
5416970971](https://github.com/abdeslam-menacere/ModelTree/issues/169#issuecomment-5416970971),
under a `### Not in scope here` heading, which is also where `skills-ci` is
excluded by name. The body instead carries a differently-worded `## Out of
scope` section about auto-merge behaviour and admin override. So a reader who
checks the body alone will not find the exclusion and may conclude the two
sections above are wrong. They are not. Read the comments before changing them.

`adr-numbers`, `skills-ci` and `instruction-references` are named together once
on #169, in [an earlier
comment](https://github.com/abdeslam-menacere/ModelTree/issues/169#issuecomment-5409583217),
and only as a caution: a path-filtered check that never reports blocks pull
requests forever, so none of the three can simply be added to `contexts`. Being
named in that caution is not being in scope, and that same sentence is the proof
— `skills-ci` appears in it and is then excluded from #169 by name. Requiring
any of the three is therefore a decision separate from the two gaps above.

### `drydock-gates` does not exist

`drydock land` instructs the maintainer to require a `drydock-gates` check. **No
such workflow exists in this repository**, and requiring a check that no workflow
reports deadlocks every pull request. Do not add it to branch protection.

## What gates a dataset change

Two different checks read `web/src/data/`, and they do not enforce the same
rules. `web-ci` runs `npm run validate` (the vitest suite plus the Astro and
TypeScript diagnostics), which validates the dataset through Zod and
`web/src/data/validate.ts`. `skills-ci` runs
`.github/skills/modeltree-gates/scripts/gate-dataset.mjs`, the deterministic
gate ADR 0003 places between an unattended refresh and Pages.

The overlap between them was previously unmeasured, which is not the same as
being covered. The table below is the measurement, taken by execution: for each
rule `gate-dataset` enforces, the dataset was mutated to violate **that rule
alone**, both checks were run, and the column records which refused. Every
mutation was reverted and the dataset verified byte-identical afterwards.

All 42 rules were refused by `gate-dataset`, so no rule in it is dead. 26 are
also refused by `npm run validate`. **16 are enforced by `gate-dataset` alone**,
shown in bold.

| Gate | Rule exercised | `gate-dataset` | `npm run validate` |
|---|---|---|---|
| `well-formed` | every entry is an object | refuses | refuses |
|  | document is a JSON array | refuses | refuses |
|  | document parses as JSON | refuses | refuses |
| `identity` | id is lowercase-kebab-case | refuses | refuses |
|  | id unique within its collection | refuses | refuses |
|  | entry carries a string id | refuses | refuses |
| `entity-boundary` | publisher taking an organization id must declare it | refuses | refuses |
|  | release belongs to its family's organization | refuses | refuses |
| `references` | release.familyId resolves | refuses | refuses |
|  | source.publisherId resolves | refuses | refuses |
|  | organization.sourceIds resolve | refuses | refuses |
|  | usageObservation.releaseId resolves | refuses | refuses |
|  | modelFitStatement.sourceIds resolve | refuses | refuses |
|  | modelFitEvidenceGap.releaseId resolves | refuses | refuses |
| `lineage` | lineage list contains the release itself | refuses | refuses |
|  | publisher is its own control parent | refuses | refuses |
|  | lineage list names the same release twice | refuses | **passes** |
|  | same release listed as predecessor and successor | refuses | **passes** |
|  | sibling that is also a lineage neighbour | refuses | **passes** |
|  | two releases each claim to precede the other, and the predecessor cycle that forms | refuses | **passes** |
| `dates` | exact date is a real calendar date | refuses | refuses |
|  | partial date is a real date | refuses | refuses |
|  | partial date is not in the future | refuses | refuses |
|  | lastCheckedDate does not precede publishedDate | refuses | refuses |
|  | release does not predate its family | refuses | refuses |
|  | measurement window does not end before it starts | refuses | refuses |
|  | exact date is not in the future | refuses | **passes** |
|  | release does not predate its predecessor | refuses | **passes** |
| `urls` | source url parses as a URL | refuses | refuses |
|  | source url is https | refuses | **passes** |
|  | source url carries no embedded credentials | refuses | **passes** |
|  | `FORBIDDEN_HOSTS`: `localhost` | refuses | **passes** |
|  | `FORBIDDEN_HOSTS`: `127.` | refuses | **passes** |
|  | `FORBIDDEN_HOSTS`: `.internal` | refuses | **passes** |
|  | `FORBIDDEN_HOSTS`: `.local` | refuses | **passes** |
|  | organization website host is public | refuses | **passes** |
| `evidence` | sourced record carries at least one sourceId | refuses | refuses |
|  | sourced record carries a usable verifiedAt | refuses | refuses |
|  | model-fit statement carries at least one sourceId | refuses | refuses |
| `no-composite-score` | `RANKING_WORDS`: a bare `score` field | refuses | **passes** |
|  | `RANKING_WORDS`: a camelCase segment (`overallRating`) | refuses | **passes** |
|  | `RANKING_WORDS`: nested inside another object | refuses | **passes** |

### What that leaves uncovered

The gate-only rules are not a random remainder. They cluster on three things the
product brief treats as non-negotiable:

- **The composite-score refusal.** Zod object schemas here are not `.strict()`,
  so an unknown key is stripped rather than rejected. Adding `"score": 91` and
  `"overallRanking": "first"` to a release leaves `npm run validate` completely
  green — 372 tests passing, `astro check` reporting 0 errors — while
  `gate-dataset` reports two `no-composite-score` failures. This is the ADR 0003
  guardrail against a universal ranking, and `web-ci` does not enforce it.
- **Source URL trustworthiness.** `z.url()` accepts any parseable URL, so
  `http://`, `https://user:pass@example.com/`, `https://localhost/`,
  `https://127.0.0.1/`, and any host ending `.internal` or `.local` all pass
  validation. A "primary source" that resolves only inside somebody's network is
  not evidence.
- **Dates that claim the future, and lineage self-consistency.** Nothing under
  `web/src/` compares a date against today, so a `verifiedAt` of `2099-01-01`
  validates cleanly.

These are reported, not fixed. Widening `gate-dataset`'s rules is not this
file's business, and narrowing the difference by teaching `validate` the same
rules is a separate decision about where a rule should live.

## Permissions

Every workflow sets `permissions: contents: read` at the top level, so no job can
start from a wider default. Write scopes are granted per job, never globally:

| Job | Extra scope | Why |
|---|---|---|
| `pages.yml` → `deploy` | `pages: write`, `id-token: write` | Publish the built site and mint the OIDC token `actions/deploy-pages` exchanges |
| `pages.yml` → `report-failure` | `issues: write` | File or update the stale-site issue |
| `pages.yml` → `report-recovery` | `issues: write` | Close the stale-site issue once a deploy succeeds |
| `publish-updater-proposals.yml` → `publish` | `issues: write`, `id-token: write` | Write proposal issues; sign in with workload identity |

`web-ci.yml`, `skills-ci.yml`, `updater-tests.yml`, `instruction-references.yml`
and `adr-numbers.yml` hold no write scope at all. Nothing in this directory can
write repository content.

## A failed deploy is not a broken site

`pages.yml` builds with `npm run build`, which is `npm run validate && astro
build`. If the web suite or the Astro and TypeScript diagnostics go red on
`main`, the build fails, the deploy step never runs, and GitHub Pages carries on
serving the last successful build. The site does not break — it **freezes**,
serving stale content while looking perfectly healthy.

The `report-failure` job exists so that state cannot pass unnoticed: when the
deploy fails on `main` it opens an issue naming the failing commit and the run,
or comments on the open one rather than filing a duplicate for every failed push.

### And the alert resolves itself

An alert that never resolves is one you learn to ignore. `report-recovery` is
the mirror image of `report-failure`: when a deploy **succeeds** on `main` it
closes the open stale-site issue, commenting with the recovering commit and run.
So an open stale-site issue means the site is stale *right now*, not that it was
stale at some point in the past.

Both jobs find that issue through a single workflow-level
`env: STALE_SITE_TITLE`, matched exactly. That constant is shared rather than
restated on purpose — two copies of the title could drift apart, and a recovery
job matching a title the failure job no longer files under would close an
unrelated issue. The tests assert the string appears exactly once in `pages.yml`
and that both jobs look the issue up by a character-identical rule.

`report-recovery` runs on `needs.deploy.result == 'success'` rather than
`success()`, because `success()` is also true when a needed job was *skipped* —
as `deploy` is on a fork. It is gated to `refs/heads/main` for the same reason
`report-failure` is: `deploy` has no ref guard, so a `workflow_dispatch` from a
branch genuinely deploys that branch, and that must not resolve an alert about
`main`.

## Changing a workflow

`web/tests/workflows/web-ci.test.ts` asserts the structure of `web-ci.yml` and
`pages.yml`: their triggers, the absence of a trigger path filter, the paths the
scope step matches, the stable job name, and the permission model.
`web/tests/workflows/skills-ci.test.ts` does the same for `skills-ci.yml`, and
additionally reads the dataset documents out of `gate-dataset.mjs` to assert the
trigger filter covers every one of them — so a new dataset document cannot be
added without the gate's trigger following it. Both run as part of
`npm run validate` from `web/`. If you change one of those properties on
purpose, update the test and this file in the same change.

`tools/updater/tests/test_adr_numbers.py` does the same job for `adr-numbers.yml`
— its path filters, its job name, its permission model, and that it invokes the
checker with no arguments. It also asserts `push.branches` is exactly `[main]`,
because verifying a new workflow before it reaches `main` means adding a branch
to that list for a commit, and a leftover entry is a trigger nobody expects.
