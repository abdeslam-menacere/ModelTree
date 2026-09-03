# ModelTree Launch Runbook

The single audited procedure a maintainer executes to publish a ModelTree
release. It separates **owner UI steps** (settings changed in GitHub's web
interface) from **maintainer commands** (things a person with the repository
checked out runs on their machine), because they fail in different ways and a
runbook that mixes them is a runbook that hides half of what went wrong.

This document assumes the deploy pipeline itself is already working —
[`DEPLOYMENT-RUNBOOK.md`](DEPLOYMENT-RUNBOOK.md) is that document — and adds
the wider check a first-release or public-launch pass needs.

- **Audience.** The repository owner and any maintainer they add.
- **When to use it.** Before a new tag, after a substantial change to what the
  site publishes, or when preparing to make the repository, its Pages site, or
  its branch protections public for the first time.
- **What it will not do.** Change owner-controlled settings automatically, add
  analytics, or claim the site's model coverage is complete.

Every command below runs from `web/` unless it explicitly says otherwise. The
repository root is not a Node project.

## 0. Preflight

Before anything else, confirm the tools this runbook assumes are on the machine
you are running from:

```sh
node --version   # >=22.12.0, matching web/package.json engines
npm --version
gh --version
git --version
```

On Windows, `npm` and `gh` may resolve to a PowerShell shim that is refused by
the default execution policy. If that happens, the `.cmd` shim of the same name
runs, and every `npm` command below can be replaced with `npm.cmd`. Do not
change the execution policy machine-wide to make the PowerShell shim work.

## 1. Owner UI steps — repository settings

These are done in the GitHub web interface by the repository owner. **No
workflow, skill, or command in this repository will perform any of them**, and
none should. Verify each even if you believe it is already done: the failure
mode of a launch is a setting that was true once and is not true now.

For each item, the runbook lists **where** to change it and **how to verify
the setting is right**, so a check does not depend on trusting the UI.

### 1.1 Repository visibility

- **Where.** Settings → General → Danger Zone → Change repository visibility.
- **Required.** Public. GitHub Pages on the Free plan requires it, and the
  audience for ModelTree is public.
- **Verify.**

  ```sh
  gh api repos/abdeslam-menacere/ModelTree --jq '.visibility,.private'
  # expected: public, false
  ```

### 1.2 Repository description and homepage

- **Where.** The gear icon at the top of the repository page → *Details*.
- **Required for launch.** A one-line description and a homepage URL. The
  homepage should be the deployed Pages URL,
  `https://abdeslam-menacere.github.io/ModelTree/`.
- **Verify.**

  ```sh
  gh api repos/abdeslam-menacere/ModelTree --jq '.description,.homepage'
  # both should be non-empty. If either is "", the launch checklist below is
  # not satisfied.
  ```

### 1.3 GitHub Pages source

- **Where.** Settings → Pages → Build and deployment → Source.
- **Required.** *GitHub Actions*, **not** *Deploy from a branch*. This is the
  step [`DEPLOYMENT-RUNBOOK.md`](DEPLOYMENT-RUNBOOK.md) calls out as most
  easily got wrong; the branch source publishes committed files and ignores
  [`pages.yml`](../../.github/workflows/pages.yml) entirely, producing a
  quiet failure.
- **Verify.** Trigger a manual run of *Actions → Deploy personal GitHub Pages
  site → Run workflow*, and check the deploy step succeeds. If the deploy job
  is skipped or fails on the deploy step, the source is set wrong.

### 1.4 Branch protection on `main`

- **Where.** Settings → Branches → Branch protection rules.
- **Required.** A rule matching `main` that:
  - Requires a pull request before merging.
  - Requires the `web-ci` status check to pass.
  - Requires branches to be up to date before merging.
  - Does **not** allow force pushes.
  - Does **not** allow deletions.
- **Notes.** Requiring reviews from Code Owners is safe to enable —
  [`.github/CODEOWNERS`](../../.github/CODEOWNERS) is written for that
  possibility and clears ownership on the dataset paths ADR 0003 permits an
  automated refresh to touch, so enabling it does not block the automated
  refresh pipeline.
- **Bypass policy.** The owner is the only party allowed to bypass. Any
  bypass list beyond that widens the trusted set silently; if it exists,
  record why in an ADR under [`docs/adr/`](../adr/) rather than in this
  runbook.
- **Verify.**

  ```sh
  gh api repos/abdeslam-menacere/ModelTree/branches/main/protection \
    --jq '.required_status_checks.contexts,.enforce_admins.enabled,.required_pull_request_reviews'
  ```

  Read the JSON: `contexts` should include `web-ci`, and the pull-request
  requirement should be non-null.

### 1.5 Optional — custom domain

- **Where.** Settings → Pages → Custom domain.
- **Required.** No, and there is no plan to add one. Recorded here so that
  the decision is visible: the base path `/ModelTree/` in
  [`DEPLOYMENT-RUNBOOK.md`](DEPLOYMENT-RUNBOOK.md) is a consequence of
  publishing at `abdeslam-menacere.github.io/ModelTree/`, and changing to a
  custom domain would move the base path and invalidate every link the site
  emits until a rebuild.

### 1.6 Vulnerability reporting

- **Where.** Settings → Code security → Private vulnerability reporting →
  *Enable*.
- **Required.** Yes. [`SECURITY.md`](../../SECURITY.md) directs reporters at
  this channel; leaving it disabled makes that link a dead end.
- **Verify.** The *Security* tab of the repository shows a *Report a
  vulnerability* button.

## 2. Maintainer commands — the final checks

These are the checks the acceptance criteria in issue #35 name explicitly:
data, link, accessibility, performance, SEO, responsive, production. Each
runs from a clean checkout of `main`, and each reports its own real output.
Never quote intended output in a summary; quote what actually ran.

### 2.1 Baseline

```sh
git checkout main
git pull --ff-only origin main
cd web
npm ci
npm run validate
```

`npm run validate` is `npm run test && npm run check` — the data-integrity
tests, URL-state tests, and Astro/TypeScript diagnostics together. It is the
single command whose green output is a prerequisite for every check below.

### 2.2 Preflight against the PR checks a diff would trigger

From the repository root:

```sh
node .github/scripts/ci-preflight.mjs
```

Exit **0** passed, **1** a check failed, **2** the runner could not run a
check or nothing needed running. **2 is never a pass.** The script prints
what it does *not* cover — most importantly the networked source-link-health
sweep and any Python-side coverage — read that list before treating a green
preflight as a green CI. See
[`.github/workflows/README.md`](../../.github/workflows/README.md) for the
mapping and its limits.

### 2.3 Data health

```sh
cd web
npm run data-health
```

Reads every dataset document under [`src/data/`](../../web/src/data/) and
reports freshness, unresolved references, and source coverage. A row with
`missing primaries` on a featured record is a launch blocker; the criterion
"do not waive missing primary sources for featured records" is in the issue
brief itself. Long-tail rows without a primary are covered by the reviewed
posture in
[ADR 0002](../adr/0002-long-tail-profiles-are-a-reviewed-set.md) and are
not blockers on their own.

### 2.4 Source-link health

The link-health sweep is networked and runs on a schedule as
[`source-link-health.yml`](../../.github/workflows/source-link-health.yml).
For a launch check, invoke it manually and read the run rather than trusting
the last scheduled result:

```sh
gh workflow run source-link-health.yml
gh run watch --workflow=source-link-health.yml
```

Failures come in two shapes. A `4xx` or `5xx` against a primary source cited
by a featured record is a launch blocker: the citation is dead and the
featured claim it supports has no primary. A `4xx` against a long-tail
citation is a data problem tracked separately, not a launch blocker.

### 2.5 Accessibility

The independent WCAG 2.2 AA audit and its findings live in
[`docs/product/WCAG-2.2-AA-AUDIT.md`](WCAG-2.2-AA-AUDIT.md), which is what
issue #32 delivered. The audit is the evidence; this step verifies that the
built site still holds against it.

The Playwright end-to-end suite in [`web/e2e/`](../../web/e2e/) is not run
by `npm run validate` (it drives a real Chromium and would put a browser
download in the pre-merge path of every gate — see
[`.github/workflows/README.md`](../../.github/workflows/README.md)). It is
also the check that the paths-filter on `web-ci` does not select for a
docs-only change: on a pull request that touches only `docs/`, `README.md`,
`LICENSE`, or `SECURITY.md` / `SUPPORT.md`, the `web-e2e` workflow starts
and then skips without executing anything, so a green tick on it is not
accessibility evidence. A launch check has to run the suite by hand:

```sh
cd web
npm run test:e2e -- \
  e2e/site-a11y.e2e.ts \
  e2e/lineage-a11y.e2e.ts \
  e2e/lineage-keyboard.e2e.ts \
  e2e/lineage-narrow-viewport.e2e.ts \
  e2e/lineage-reduced-motion.e2e.ts \
  e2e/forced-colors.e2e.ts \
  e2e/zoom.e2e.ts
```

The specs are named by path deliberately rather than by a `--grep` selector:
there is no tag convention in `web/e2e/`, so a title-substring selector is
brittle and — because Playwright exits nonzero when it matches zero tests —
would fail this step loudly the first time a spec is renamed. Naming files
survives a title rewrite.

What each spec covers, verified against the files at HEAD:

- `site-a11y.e2e.ts` — axe-core scan of the core routes, plus a planted-defect
  test that proves the scan can fail (`test('the accessibility scan can fail,
  and rates a planted defect as blocking')`).
- `lineage-a11y.e2e.ts` — the same axe-core discipline applied to the lineage
  markup specifically.
- `lineage-keyboard.e2e.ts` — desktop and narrow-viewport keyboard operation
  of the lineage view.
- `lineage-narrow-viewport.e2e.ts` — 320 CSS px overflow, wrap, and clipping
  checks with a real overflow detector that has its own must-fail control.
- `lineage-reduced-motion.e2e.ts` — `prefers-reduced-motion` respected, with a
  vacuity guard that shows the drawer *does* animate without the preference.
- `forced-colors.e2e.ts` — Windows High Contrast / `forced-colors` still
  paints connectors, spine, and focus rings, with a control case.
- `zoom.e2e.ts` — reflow at 400% zoom does not overflow, with a real-overflow
  positive control.

Any `serious` or `critical` axe finding is a launch blocker. `moderate` and
`minor` findings are recorded and triaged; they do not block a launch on
their own, but they do not accumulate — if a launch would ship with more of
them than the previous release, record why.

Screen-reader coverage is by hand. Run the smoke matrix in
[`WCAG-2.2-AA-AUDIT.md`](WCAG-2.2-AA-AUDIT.md) on at least one desktop
browser and one screen reader before tagging.

If any spec above is renamed, moved, or removed, this section is wrong until
it is updated. That decay is manual (no test enforces the citation), and it
is called out here for the same reason `CONTRIBUTING.md` calls its own
citations an accepted gap.

### 2.6 Performance and asset budgets

The budget-enforcement work is issue #33 and lives as scripts in
[`web/scripts/`](../../web/scripts/):

```sh
cd web
npm run build
npm run assets:report
npm run budget:merged
npm run budget:compare
```

- `assets:report` prints per-file sizes in the built `dist/`.
- `budget:merged` enforces the whole-page budget for the merged-view route.
- `budget:compare` enforces the comparison-view budget.

A red budget script exits non-zero and names the file that busted its
limit. That is a launch blocker unless the ADR record for the limit is
updated in the same launch; do not raise a budget silently.
[`docs/product/PERFORMANCE-BUDGETS.md`](PERFORMANCE-BUDGETS.md) is the
policy the numbers come from.

### 2.7 SEO, sitemap, structured data

Issue #34's output lives on trunk as
[`web/src/pages/sitemap.xml.ts`](../../web/src/pages/sitemap.xml.ts),
[`web/src/pages/robots.txt.ts`](../../web/src/pages/robots.txt.ts),
[`web/src/lib/seo.ts`](../../web/src/lib/seo.ts), and
[`web/src/lib/structured-data.ts`](../../web/src/lib/structured-data.ts).
`npm run validate` already covers their unit tests; the launch check is a
build-time smoke that the routes emit real content:

```sh
cd web
npm run build
grep -c "<url>" dist/sitemap.xml
grep -c "<script type=\"application/ld+json\">" dist/models/*/index.html | head
```

`<url>` count on `sitemap.xml` above zero, structured-data count above zero
on model passport pages. Zero on either is a launch blocker: an empty
sitemap indexes nothing, and a missing `application/ld+json` block is what
issue #34 was written to add.

### 2.8 Responsive and production smoke

After the build in 2.6:

```sh
cd web
npm run preview
```

Open the local preview at the URL it prints and walk the core routes on a
mobile viewport (375×667 or narrower) with keyboard only:

- `/` (homepage search + filters)
- `/tree/` (lineage explorer)
- `/models/` (catalog)
- `/models/<slug>/` (a Model Passport of your choice)
- `/methodology/`
- `/refresh/`
- `/updates/`

Any of these hitting a horizontal scrollbar, a trap, or an unreadable label
at 375px is a launch blocker.

### 2.9 Production check — the deployed site itself

After the deploy in step 3, before tagging the release:

```sh
curl -sI https://abdeslam-menacere.github.io/ModelTree/ | head -1
# expected: HTTP/2 200

# spot-check the routes above:
for path in "" "tree/" "models/" "methodology/" "refresh/"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://abdeslam-menacere.github.io/ModelTree/$path")
  printf "%3s  %s\n" "$code" "$path"
done
```

Every response should be `200`. A `404` on a route that was `200` before
means the build did not emit it — the source of truth for that is the
`dist/` tree from step 2.6, not the last successful build.

## 3. Release checklist

Bind each item to a real artefact before ticking it. A checklist that is a
list of intentions is a list of things to forget.

- [ ] All four dependency issues (#30, #32, #33, #34) resolved.
- [ ] All owner UI steps in section 1 verified against the API, not the UI.
- [ ] `npm run validate` green on the current `main` HEAD. Quote the tail.
- [ ] `node .github/scripts/ci-preflight.mjs` exit 0.
- [ ] `npm run data-health` — no missing primaries on featured records.
- [ ] `source-link-health` — no dead primaries on featured records.
- [ ] Accessibility E2E — no serious or critical findings, deltas from
      previous release recorded.
- [ ] Budget scripts green; if any changed, the ADR or policy note was
      updated in the same release.
- [ ] Sitemap and structured-data smokes non-zero on build.
- [ ] Responsive walk at 375px on the routes in 2.8.
- [ ] `SECURITY.md`, `SUPPORT.md`, `LICENSE`, `CONTRIBUTING.md`,
      `.github/CODEOWNERS`, and `docs/product/PRIVACY-DECISION.md` reviewed
      for accuracy at this HEAD.
- [ ] `docs/product/BACKLOG.md` reviewed — any launched-but-open MVP issue
      is either closed or has a note explaining why it stays open.
- [ ] Known data gaps and residual risks published honestly (see next
      section).
- [ ] No private URLs, personal tokens, or template branding remain in
      public output.

Only when all of the above are ticked:

```sh
git checkout main
git pull --ff-only origin main
git tag -a v<x.y.z> -m "ModelTree v<x.y.z>"
git push origin v<x.y.z>
gh release create v<x.y.z> --generate-notes
```

Then verify the tag reaches `https://abdeslam-menacere.github.io/ModelTree/`
by re-running section 2.9 against the commit the tag names. **This is the
"verified public URL before release tagging" acceptance criterion**, and its
mechanics are worth being exact about because a maintainer reading this
under release pressure has to know what they are waiting for.

`.github/workflows/pages.yml` triggers on `push` to `main` and on
`workflow_dispatch`. **It does not trigger on tag push.** A tag names a
commit that has already merged to `main`, so the deploy that brought the
site up to that commit ran when the merge landed, not when the tag was
pushed. Do not wait for a second deploy that will not come, and do not add
a tag trigger to `pages.yml` to make one — that is architecture rework in
a docs step.

The criterion is therefore satisfied by observing that the origin is
already serving the commit the tag names, before or after the tag is
pushed:

```sh
# 1. Confirm the tag names the current main tip. `git rev-parse` on an
#    annotated tag returns the tag *object* SHA, which is never equal to
#    the commit SHA; peel to the commit with ^{commit}.
git rev-parse "v<x.y.z>^{commit}"
git rev-parse origin/main
# these two commit SHAs should be equal.

# 2. Confirm the last successful pages.yml deploy is that commit. The
#    `headSha` field is the commit the workflow ran against; compare it
#    to the peeled tag above.
gh run list --workflow=pages.yml --branch=main --limit=1 \
  --json headSha,conclusion,createdAt

# 3. Re-run section 2.9 against the origin.
```

If step 1 disagrees, the tag is pointed at the wrong commit and the
release notes are about a build that is not the one deployed. Fix the tag
before announcing.

## 4. Publishing known gaps honestly

The launch-readiness issue requires that "known data gaps and residual risks
are published honestly". The following places carry that record on the site
itself and in the repository; the launch check is that they are current
rather than that they exist:

- **Coverage.** Nothing here should claim complete coverage. The Status
  section of [`README.md`](../../README.md) and the front matter of
  [`docs/product/BACKLOG.md`](BACKLOG.md) name what is shipped and what is
  not.
- **Long-tail profiles.** Reviewed and deliberately terse; see
  [ADR 0002](../adr/0002-long-tail-profiles-are-a-reviewed-set.md).
- **Unknown lifecycle states.**
  [ADR 0008](../adr/0008-lifecycle-status-carries-an-explicit-unknown-member.md)
  records why `unknown` is a first-class value rather than a papered-over
  default.
- **The refresh-run ledger.**
  [ADR 0006](../adr/0006-a-refresh-run-records-itself-in-its-own-pull-request.md)
  and the `/refresh` route document what each automated refresh touched. A
  missing entry for a landed refresh is a bug, not a gap.
- **The verification-date policy.** `CONTRIBUTING.md` states that a fact
  without a primary source is left absent rather than filled in. The count
  of absent fields is a *feature*, not a debt to hide.

## 5. Rollback

The site fails safe by staying stale: a failed deploy leaves the previous
build published rather than serving a broken page. Rollback exploits that.

### 5.1 If the last deploy is bad but a previous one was good

```sh
# 1. Confirm which commit last deployed successfully:
gh run list --workflow=pages.yml --branch=main --limit=10

# 2. Revert the offending commit on main:
git checkout main
git pull --ff-only origin main
git revert <bad-sha>          # produces one revert commit
git push origin main

# 3. Watch the redeploy:
gh run watch --workflow=pages.yml
```

The revert commit triggers `pages.yml`, which rebuilds and redeploys. Verify
with section 2.9 against the routes that were broken.

### 5.2 If the deploy pipeline itself is broken

Do not attempt to switch the Pages source, redeploy from a different branch,
or bypass CI. Every one of those defeats the fail-safe: the previously
published build stays served, which is the correct state while the pipeline
is repaired.

Open a stale-site issue if `pages.yml` did not open one automatically (see
[`DEPLOYMENT-RUNBOOK.md`](DEPLOYMENT-RUNBOOK.md)), repair the workflow on a
branch, land the fix through the ordinary reviewed path, and let the next
deploy close the stale-site issue.

### 5.3 If a bad tag is out

A tag is a name for a commit. Rolling back a tag is either:

- **Move the release notes to point at the revert commit** — `gh release
  edit v<x.y.z> --target <revert-sha>` — if the tag has to keep the same
  version number for external reasons.
- **Retire the version and cut a new one** — the ordinary path.

Never force-push a tag to a *different* commit than the one it originally
pointed at without an announcement. The tag is a public claim about a
specific artefact.

### 5.4 What rollback does not need

- A separate rollback deploy pipeline. Reverting on `main` reuses the
  ordinary pipeline; adding a second deploy path adds a second way for the
  site to be wrong.
- A snapshot of the previous `dist/`. The build is deterministic given the
  commit; the commit is the snapshot.

## 6. History

| Date | Change |
|---|---|
| 2026-09-02 | First recorded. Structure follows the scope of issue #35. |
