# Workflows

What runs, when, with what permissions, and — the point of this file — the exact
**status check names**, so branch protection can require the right ones and only
the right ones.

## What runs

| Workflow | Triggers | Covers |
|---|---|---|
| [`web-ci.yml`](web-ci.yml) | `pull_request` (every one), `workflow_dispatch` | Validates and builds the Astro site under `web/` |
| [`updater-tests.yml`](updater-tests.yml) | `pull_request` and `push` to `main`, path-filtered to `tools/updater/**`, `tools/instruction_refs/**`, `tools/adr_numbers/**` and `docs/adr/**` | The updater's pytest suite, which is also where this repository's stdlib-Python invariants are asserted |
| [`instruction-references.yml`](instruction-references.yml) | `pull_request` and `push` to `main`, path-filtered to `.github/copilot-instructions.md` and `tools/instruction_refs/**`, `workflow_dispatch` | Resolves every path, issue citation, and section marker in the instructions file |
| [`adr-numbers.yml`](adr-numbers.yml) | `pull_request` and `push` to `main`, path-filtered to `docs/adr/**` and `tools/adr_numbers/**`, `workflow_dispatch` | Refuses two decision records under `docs/adr/` that claim the same four-digit number |
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
`tools/instruction_refs/**`, `tools/adr_numbers/**` and `docs/adr/**`, whose
behaviour the suite asserts), so it reports nothing on a pull request confined to
`web/`. Requiring either leg would block every web change indefinitely. Its names
also carry the Python version, so adding or dropping a version changes them.

### Nor is `instruction-references`

Same trap, for the same reason: `instruction-references.yml` is path-filtered to
`.github/copilot-instructions.md`, so it reports no check at all on the great
majority of pull requests, and each of those would sit pending forever. Whether
it is ever required is a branch-protection decision — issue #80 in this
repository — not something this workflow decides.

The job installs nothing and reaches no network: the checker is standard library
only, so the whole job is a checkout, a Python, and one command. It takes no
arguments, so it always resolves the governing file and cannot be pointed at
something easier, and it has no `--skip` or `--force`. A genuine exception
belongs in branch protection, where it is auditable.

### Nor is `adr-numbers`

The same trap again: `adr-numbers.yml` is path-filtered to `docs/adr/**`, and
decision records change rarely, so it reports no check on almost every pull
request. Making it required is issue #169 and needs the repository owner, because
requiring a check that does not report is what deadlocks a pull request — not
something this workflow can decide for itself.

It is built to the same shape as `instruction-references`: standard library only,
so the job is a checkout, a Python, and one command; no arguments, so it always
examines `docs/adr/` and cannot be aimed at an emptier directory; and no `--skip`
or `--force`. It fails when two files under `docs/adr/` share a leading
four-digit number, naming both paths and the number. Gaps and ordering are out of
scope — two pull requests each adding the next ADR would collide by construction
under a contiguity rule, and a check that fires on correct work gets worked
around rather than fixed.

### `drydock-gates` does not exist

`drydock land` instructs the maintainer to require a `drydock-gates` check. **No
such workflow exists in this repository**, and requiring a check that no workflow
reports deadlocks every pull request. Do not add it to branch protection.

## Permissions

Every workflow sets `permissions: contents: read` at the top level, so no job can
start from a wider default. Write scopes are granted per job, never globally:

| Job | Extra scope | Why |
|---|---|---|
| `pages.yml` → `deploy` | `pages: write`, `id-token: write` | Publish the built site and mint the OIDC token `actions/deploy-pages` exchanges |
| `pages.yml` → `report-failure` | `issues: write` | File or update the stale-site issue |
| `pages.yml` → `report-recovery` | `issues: write` | Close the stale-site issue once a deploy succeeds |
| `publish-updater-proposals.yml` → `publish` | `issues: write`, `id-token: write` | Write proposal issues; sign in with workload identity |

`web-ci.yml`, `updater-tests.yml`, `instruction-references.yml` and
`adr-numbers.yml` hold no write scope at all. Nothing in this directory can write
repository content.

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
scope step matches, the stable job name, and the permission model. It runs as
part of `npm run validate` from `web/`. If you change one of those properties on
purpose, update the test and this file in the same change.

`tools/updater/tests/test_adr_numbers.py` does the same job for `adr-numbers.yml`
— its path filters, its job name, its permission model, and that it invokes the
checker with no arguments. It also asserts `push.branches` is exactly `[main]`,
because verifying a new workflow before it reaches `main` means adding a branch
to that list for a commit, and a leftover entry is a trigger nobody expects.
