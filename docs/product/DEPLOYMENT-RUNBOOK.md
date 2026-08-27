# ModelTree Deployment Runbook

The owner-side steps behind the published site. Everything here is a repository
*setting* rather than repository *content*: no workflow, skill, or agent in this
repository may perform any of it, and none of them try. That separation is
deliberate and is restated as a non-goal on the deployment issue itself.

This document lives in `docs/product/` because it records owner decisions about
the product's public surface — the same class of decision as the launch
constraint in [`PRODUCT-BRIEF.md`](PRODUCT-BRIEF.md) and the owner gates in
[`BACKLOG.md`](BACKLOG.md) — and not in `docs/adr/`, which is reserved for
architecture decisions written in the ADR format.

## Current state

Verified 2026-08-27 against the GitHub API and the live site:

| Setting | Value |
|---|---|
| Repository visibility | public |
| Pages | enabled |
| Pages build type | `workflow` (GitHub Actions) |
| Pages source | branch `main`, path `/` |
| Published origin | `https://abdeslam-menacere.github.io` |
| Published base path | `/ModelTree/` |
| HTTPS enforced | yes |

The base path is not a choice this repository makes. A project site is published
at `http(s)://<owner>.github.io/<repositoryname>` ([What is GitHub
Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#types-of-github-pages-sites),
retrieved 2026-08-27), so every internal link and asset has to carry the
`/ModelTree/` prefix or it resolves against the wrong root.

`https://abdeslam-menacere.github.io/ModelTree/` serves the current build, and
direct navigation to a generated route under that base path — `/ModelTree/tree/`
and `/ModelTree/refresh/` were the two checked — returns `200` rather than
falling back to the homepage.

A route that has not been built yet returns `404`, which is correct rather than
broken: GitHub Pages offers no arbitrary SPA fallback, so every supported route
must be generated at build time. `/ModelTree/models/` and `/ModelTree/methodology/`
are `404` today because the issues that add those pages have not landed.

## The private-repository limitation, and why it no longer applies

It applied, and it is resolved. The brief and the backlog were written on
2026-08-14, when the repository was private. On a GitHub Free account a Pages
site requires a public repository — *"If the account that owns the repository
uses GitHub Free or GitHub Free for organizations, the repository must be
public"* ([Creating a GitHub Pages
site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site),
retrieved 2026-08-27) — so until the owner made the repository public there was
no public URL to deploy to, and the deployment issue and launch-readiness issue
were both blocked on an owner action that no amount of implementation work could
substitute for.

The owner has since made the repository public and enabled Pages with GitHub
Actions as the source. The constraint is therefore historical. It is recorded
here, rather than deleted, because the dependency it created is still visible in
the backlog's critical path, and a reader who meets those dashed owner gates
needs to know they have been satisfied.

What has *not* changed is the rule the constraint expressed: visibility, Pages
settings, and branch protection remain owner decisions, and no implementation
issue may change them.

## Enabling Pages from scratch

These are the steps an owner would take on a fresh fork or a restored
repository. They are already done here; this section exists so that "already
done" is checkable rather than assumed.

1. **Make the repository public.** *Settings → General → Danger Zone → Change
   repository visibility*. Skip this only if the account carries a plan that
   includes Pages on private repositories; the site is unreachable to the public
   either way until it is done.
2. **Select GitHub Actions as the Pages source.** *Settings → Pages → Build and
   deployment → Source → GitHub Actions*. This is the step that matters most and
   the one most easily got wrong: the default is *Deploy from a branch*, which
   publishes committed files and ignores
   [`pages.yml`](../../.github/workflows/pages.yml) entirely. With the branch
   source selected, the workflow's deploy step fails, and because the site keeps
   serving whatever was published before, the failure is quiet.
3. **Let the workflow run.** `pages.yml` deploys on every push to `main` and can
   also be started by hand from *Actions → Deploy personal GitHub Pages site →
   Run workflow*. No secret has to be configured: the deploy authenticates with
   the OIDC token minted by the job's own `id-token: write` permission.
4. **Confirm the environment.** The first successful run creates the
   `github-pages` environment and records the deployment URL on it. If the
   environment carries a protection rule requiring a reviewer, every deploy waits
   for one — which is a legitimate owner choice, but it makes the site stale by
   default rather than current by default.

## What the workflow does, and what it will not do

[`pages.yml`](../../.github/workflows/pages.yml) builds with `npm run build`,
which is `npm run validate && astro build` — the test suite and the Astro and
TypeScript diagnostics, then the static build. A red suite on `main` therefore
stops the deploy, and the deployed artifact is always one that passed the same
checks CI runs.

It passes `SITE_URL` and `BASE_PATH` into that build, which is where the
published origin and the `/ModelTree/` base path in the table above come from:
`astro.config.mjs` reads both from the environment, so a local build without them
defaults to a root base path and no configured origin.

A failed deploy leaves the previously published build in place. The site does
not break, it freezes — stale content behind a healthy-looking page — so the
workflow files a stale-site issue when the deploy fails and closes it when a
later deploy succeeds. An open stale-site issue means the published site is
older than `main`.

## If the site is stale

1. Read the failed run linked from the stale-site issue. The failure is usually
   `npm run validate`, not the deployment.
2. Fix it on `main`. Pushing to `main` redeploys, and a successful deploy closes
   the stale-site issue by itself.
3. If the deploy step rather than the build failed, re-check step 2 above: a
   Pages source that has been switched back to *Deploy from a branch* produces
   exactly this failure.
