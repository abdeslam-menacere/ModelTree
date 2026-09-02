# Security Policy

ModelTree is a static site: an [Astro](https://astro.build) build over
versioned JSON in [`web/src/data/`](web/src/data/), served by GitHub Pages.
There is no server we operate, no database, no user accounts, no session
cookies, and no runtime data fetching. [ADR 0001 — Static-first
architecture](docs/adr/0001-static-first-architecture.md) records why, and the
runtime property is enforced by the tests in [`web/`](web/): a change that
introduces a runtime fetch fails `npm run validate` before it can ship.

That shape does most of what a security policy usually promises for us. What
remains is a small, precise surface, and this file states it precisely.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** for this repository:
[Report a vulnerability](https://github.com/abdeslam-menacere/ModelTree/security/advisories/new).
That channel opens a private advisory visible only to the repository owner and
to reporters they add, which is the right route for anything that should not
be public until it is understood.

If private vulnerability reporting is not available to you, open a
[blank issue](https://github.com/abdeslam-menacere/ModelTree/issues/new)
titled `security:` with as little detail as needed to establish contact, and
we will move the details into a private advisory. Please do **not** paste an
exploit into a public issue.

There is no service-level promise here. This is a small project. What we can
say is that private advisories will be read, acknowledged, and either fixed on
`main` (which redeploys to Pages within one build) or documented as an
accepted risk.

## What we consider in scope

- **A vulnerability in the built site**, `https://abdeslam-menacere.github.io/ModelTree/`,
  reachable by a visitor: cross-site scripting, response-splitting, subresource
  integrity, malformed HTML that defeats a browser mitigation, or similar.
- **A supply-chain vulnerability in a runtime dependency** used by the built
  site (the `dependencies` block of [`web/package.json`](web/package.json)),
  when a fixed version exists and moving to it is compatible.
- **A vulnerability in an accepted GitHub Action** used by any workflow under
  [`.github/workflows/`](.github/workflows/), when a fixed version is
  available.
- **A path traversal, injection, or command-execution defect** in any script
  under [`.github/scripts/`](.github/scripts/) or
  [`.github/skills/*/scripts/`](.github/skills/) that a pull request could
  reach — those scripts run on GitHub-hosted runners with a `GITHUB_TOKEN`.
- **A defect in an issue or pull-request template** in
  [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) or
  [`.github/pull_request_template.md`](.github/pull_request_template.md) that
  causes credentials, private URLs, or personally identifying information to
  be captured in the resulting issue by default.

## What is out of scope

- **A wrong or missing fact in the dataset.** Corrections are welcome and are
  ordinary contributions: use the
  [Report incorrect data](https://github.com/abdeslam-menacere/ModelTree/issues/new?template=data-correction.yml)
  form. A fact ModelTree publishes without a primary source is a data problem,
  not a security problem, and [`CONTRIBUTING.md`](CONTRIBUTING.md) is where it
  is triaged.
- **Denial of service against `github.io`.** GitHub operates the origin. We
  cannot rate-limit or rotate a shared domain.
- **A missing security header we do not control.** `github.io` sets the
  headers on responses it serves; the site is a `<meta>`-only surface. If a
  header would meaningfully help and can be delivered from HTML, that is in
  scope.
- **A vulnerability in a *development-only* dependency** (the `devDependencies`
  block) whose defect does not affect the *built site* or a workflow. Test
  runners and type checkers do not ship in the public artefact. Reports are
  still welcome; they may be closed as "accepted risk" rather than fixed.
- **Findings from an unauthenticated automated scanner alone.** A tool
  reporting "server is missing header X" against `github.io` is not
  actionable. Please include a reproducer.

## What the site collects

Nothing. There are no analytics, no cookies, no tracking pixels, no
client-side telemetry, no third-party scripts loaded for measurement. See
[`docs/product/PRIVACY-DECISION.md`](docs/product/PRIVACY-DECISION.md) for the
dated decision and what a change to it would require.

## Where security-relevant claims are actually enforced

A rule that is only written down decays. The rules above have concrete
enforcement points in this repository, and the enforcement points are the
authority:

- The no-runtime-fetch rule is enforced by
  [`web/src/lib/`](web/src/lib/) tests and by
  [ADR 0001](docs/adr/0001-static-first-architecture.md).
- The dataset schema, and what may reach a public build without human review,
  is enforced by
  [`.github/skills/modeltree-gates/scripts/gate-scope.mjs`](.github/skills/modeltree-gates/scripts/gate-scope.mjs)
  and is bounded by
  [ADR 0003](docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md).
- The lockfile integrity property that keeps supply-chain review meaningful is
  recorded in
  [ADR 0004](docs/adr/0004-sha-1-lockfile-integrity-is-a-mirror-constraint.md).

If any of those cease to hold, this policy is wrong and the code is right.
Report that, too.
