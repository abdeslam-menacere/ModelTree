# Workflows

What runs, when, with what permissions, and — the point of this file — the exact
**status check names**, so branch protection can require the right ones and only
the right ones.

## What runs

| Workflow | Triggers | Covers |
|---|---|---|
| [`web-ci.yml`](web-ci.yml) | `pull_request` (every one), `workflow_dispatch` | Validates and builds the Astro site under `web/` |
| [`updater-tests.yml`](updater-tests.yml) | `pull_request` and `push` to `main`, path-filtered to `tools/updater/**` | The updater's pytest suite |
| [`pages.yml`](pages.yml) | `push` to `main`, `workflow_dispatch` | Builds and deploys the site, and reports a failed deploy |
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

`updater-tests.yml` is path-filtered to `tools/updater/**`, so it reports nothing
on a pull request confined to `web/`. Requiring either leg would block every web
change indefinitely. Its names also carry the Python version, so adding or
dropping a version changes them.

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
| `publish-updater-proposals.yml` → `publish` | `issues: write`, `id-token: write` | Write proposal issues; sign in with workload identity |

`web-ci.yml` and `updater-tests.yml` hold no write scope at all. Nothing in this
directory can write repository content.

## A failed deploy is not a broken site

`pages.yml` builds with `npm run build`, which is `npm run validate && astro
build`. If the web suite or the Astro and TypeScript diagnostics go red on
`main`, the build fails, the deploy step never runs, and GitHub Pages carries on
serving the last successful build. The site does not break — it **freezes**,
serving stale content while looking perfectly healthy.

The `report-failure` job exists so that state cannot pass unnoticed: when the
deploy fails on `main` it opens an issue naming the failing commit and the run,
or comments on the open one rather than filing a duplicate for every failed push.

## Changing a workflow

`web/tests/workflows/web-ci.test.ts` asserts the structure of `web-ci.yml` and
`pages.yml`: their triggers, the absence of a trigger path filter, the paths the
scope step matches, the stable job name, and the permission model. It runs as
part of `npm run validate` from `web/`. If you change one of those properties on
purpose, update the test and this file in the same change.
