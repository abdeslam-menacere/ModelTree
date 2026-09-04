# Workflows

What runs, when, with what permissions, and — the point of this file — the exact
**status check names**, so branch protection can require the right ones and only
the right ones. [Running these checks before the
merge](#running-these-checks-before-the-merge) is how a dock sees them without
waiting for a merge to tell it.

## What runs

| Workflow | Triggers | Covers |
|---|---|---|
| [`web-ci.yml`](web-ci.yml) | `pull_request` (every one), `merge_group` (every queue entry) and `push` to `main`, both scoped **inside the job** to `web/**` and to every path outside `web/` that a test under `web/` reads — all of `.github/workflows/**`, `.github/scripts/ci-preflight.mjs`, `gate-dataset.mjs`, `gate-evidence.mjs` and `gate-scope.mjs` under `.github/skills/modeltree-gates/scripts/`, `.github/skills/modeltree-review/SKILL.md`, `.github/ISSUE_TEMPLATE/**`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `CONTRIBUTING.md`, `docs/contributing/minimal-dataset-example.json`, `docs/product/INFORMATION-ARCHITECTURE.md` and the top-level `*.json` documents in `tools/updater/profiles/`, which `src/data/featured-creator-profile.test.ts` reads through the `gate-evidence.mjs` it imports; `workflow_dispatch` | Validates and builds the Astro site under `web/`, as three separately-named steps — the vitest suite, the Astro and TypeScript diagnostics, and the production build — so a red run names which one failed |
| [`skills-ci.yml`](skills-ci.yml) | `pull_request` (every one), `merge_group` (every queue entry) and `push` to `main`, `workflow_dispatch`; scoped **inside the job** to `.github/skills/**`, `.github/scripts/**`, `.github/workflows/skills-ci.yml` and `web/src/data/**`, with every event other than a pull request running the gates outright | The data-refresh gates' self-tests, `gate-dataset` run against the live dataset, `gate-reversals` run over `refresh-runs.json` and the dataset together — refusing a record the automated panel rejected that is in `web/src/data/` today with no entry in `rejection-reversals.json` saying which change brought it back and on what evidence (#835); it gates *visibility*, so an ordinary reviewed change may overrule the panel and an objection may be recorded as still unanswered, but neither may happen silently — and a refusal of a hand-written test count in the skill documentation — a numeral described as tests, self-tests, test cases or assertions, in either order, with markdown emphasis tolerated around the numeral, and a table column whose heading is one of those nouns and whose body cell is a bare number. Noun-first needs a real separator, of the kind a label or a table cell supplies (`tests: 103`), so the verb reading — "the gate tests 4 kinds of emptiness" — is not a count, and nor is a year after `in` or `since`, a written-out number, a singular `N test`, or `N checks`, which in this repository usually means a status check. It reads one line at a time, so a count split across two lines of prose is not seen, and where it errs it over-matches: "adds 3 tests" is flagged although it sizes a change rather than the suite. The script header carries the same list with the reasoning |
| [`updater-tests.yml`](updater-tests.yml) | `pull_request` and `push` to `main`, path-filtered to `tools/updater/**`, `.github/workflows/updater-tests.yml`, `.github/workflows/publish-updater-proposals.yml`, `tools/instruction_refs/**`, `.github/skills/**`, `.github/workflows/instruction-references.yml`, `tools/adr_numbers/**`, `.github/workflows/adr-numbers.yml` and `docs/adr/**`; `merge_group` **unfiltered**, because that event supports no `paths:` filter; `workflow_dispatch` | The updater's pytest suite, which is also where this repository's stdlib-Python invariants are asserted |
| [`instruction-references.yml`](instruction-references.yml) | `pull_request` and `push` to `main`, path-filtered to `.github/copilot-instructions.md`, `.github/skills/**`, `tools/instruction_refs/**` and `.github/workflows/instruction-references.yml`; `merge_group` **unfiltered**, because that event supports no `paths:` filter; `workflow_dispatch` | Resolves the paths, issue citations, and section markers in the instructions file, and every issue citation in the skill documents. A `#NNN` inside a fenced code block is not read as a citation — it is sample content such as a colour or a quoted shell argument — and each is reported as a named exemption rather than skipped in silence. The delimiter lines stay in scope, so a citation in an info string, or on the line above or below a block, is still refused; indented code blocks and inline `` `#N` `` spans are deliberately still scanned, for reasons the checker's module docstring records. Only the citation rule consults that fence model, so a broken path inside a fenced example is still reported. Not every path, and the shortfall is narrower than it was. A backticked reference the file wraps across one line break is read as one span whether or not either fragment carries whitespace, so the backtick pairing stays in phase and the reference after it is still checked; the wrapped one is not itself resolved, because what the document renders is its fragments joined by a space, which is not a path, and joining them without the space would be a guess at what the author meant. A blank line inside a span is a paragraph break rather than a wrap, and is still not paired. What separates a wrap from a stray unpaired backtick followed by prose is the character immediately before the closing backtick: a wrap closes on its own last character, whereas a backtick *opening* the next reference is preceded by whatever prose puts there, which is a space or an opening bracket or quote, and each of those is refused. The residual is the case where that prose ends on some other non-whitespace character — `and then--` before a reference, say — which is still read as a wrap, so the pairing goes out of phase and the next reference on that line is missed, unreported rather than reported wrong. Closing that means pairing backticks the way CommonMark does, which the checker's module docstring records as a separate decision |
| [`adr-numbers.yml`](adr-numbers.yml) | `pull_request` and `push` to `main`, path-filtered to `docs/adr/**`, `tools/adr_numbers/**` and `.github/workflows/adr-numbers.yml`; `merge_group` **unfiltered**, because that event supports no `paths:` filter and a queue that does not run this check closes nothing [#860](https://github.com/abdeslam-menacere/ModelTree/issues/860) is about; `workflow_dispatch` | Refuses two decision records under `docs/adr/` that claim the same four-digit number, and a record whose `# ADR NNNN:` heading disagrees with the number in its filename |
| [`pages.yml`](pages.yml) | `push` to `main`, `workflow_dispatch` | Builds and deploys the site, reports a failed deploy, and resolves that report when the deploy recovers |
| [`source-link-health.yml`](source-link-health.yml) | `schedule` (weekly), `pull_request` (every one), `workflow_dispatch`; both jobs scoped **inside the job** to `web/src/data/sources.json`, `.github/scripts/source-link-health/**` and `.github/workflows/source-link-health.yml` | Requests every recorded primary source URL and reports the ones that are definitively broken (404, 410) or permanently moved (301, 308), grouped by URL so one dead link is one finding however many records cite it. A rate-limit, a block, a timeout and a 5xx are each classified and **never** reported as a finding, because none of them is evidence the link is bad. On a schedule it opens or updates one maintenance issue and closes it when a later sweep is clean; on a pull request it can only report, and only about URLs that pull request itself introduced. It never writes to `web/src/data/` |
| [`publish-updater-proposals.yml`](publish-updater-proposals.yml) | `schedule` (weekly, `52 5 * * 1`), `workflow_dispatch` | Files creator proposals as issues. A dispatch takes its creators, mode and `dry_run` from its inputs; a scheduled run has no inputs at all, so one step resolves both triggers to the same three parameters explicitly and writes the decision to the job summary — without that, `dry_run` reads as empty on a schedule and an empty value took the *publishing* branch. Where live mode is unconfigured (#93 — the repository has no Actions variables today), the scheduled run exercises the whole run→publish path against committed fixtures with `--dry-run` and publishes nothing, rather than reddening weekly on `azure/login`. A creator that could not be fetched still reaches a human: the CLI writes its report before returning 3, so the run step treats 3 in live mode as a finding to publish with a `::warning::`, not as an abort. It never writes to `web/src/data/` |
| [`data-health.yml`](data-health.yml) | `schedule` (weekly), `workflow_dispatch` | Generates the staleness / data-health report over the versioned dataset and uploads it as an artifact: every dated record classified healthy, stale or conflicted with the date and category threshold that produced the verdict, releases missing optional coverage, the primary-source-type mix, and unresolved conflicts kept side by side. No score and no ranking. Ordinary age is reported, never failed; the one build-failing rule — a `verifiedAt` in the future — rides `web-ci` as a vitest test, not this workflow. Reads the dataset only, writes nothing back, uses no secrets |
| [`web-e2e.yml`](web-e2e.yml) | `pull_request` (every one), `merge_group` (every queue entry) and `push` to `main`, both scoped **inside the job** to `web/**` and `.github/workflows/web-e2e.yml`; `workflow_dispatch` | The browser half of the site's checks: Playwright drives a real Chromium over `astro preview`, and asserts the lineage view's 320px layout, its keyboard journey, its reduced-motion behaviour, and axe accessibility scans at desktop and mobile widths. Separate from `web-ci.yml` because it needs a Chromium download, which does not belong inside `npm run build` and therefore inside every dock's and every gate agent's install |
| [`aggregate-checks.yml`](aggregate-checks.yml) | `pull_request` (every one) and `merge_group` (every queue entry), **no path filter at all**; `workflow_dispatch` is deliberately absent, because outside a pull request or a merge group there is no head SHA whose check runs it could read | Observes the check runs GitHub recorded against the head commit of this pull request, or of this queue entry's projected merge, and fails if any watched path-filtered check did not pass. It runs nothing itself — it is the one check whose whole job is to make the checks that *cannot* be required countable by the one that can. It is a required context on `main` today, so a run that cannot answer blocks the merge rather than merely reporting it: every path through the script ends in a verdict or in exit 2, and never in a pass it did not establish |

## Merge queue readiness

No merge queue exists on `main` today. These workflows are nevertheless written
so that one could be switched on without any of them being edited again, which
is what [#877](https://github.com/abdeslam-menacere/ModelTree/issues/877) landed
and what [#860](https://github.com/abdeslam-menacere/ModelTree/issues/860) needs.
Enabling the queue is a repository *setting* and an owner action; nothing in this
tree turns it on, and until somebody does, every `merge_group:` trigger below is
inert, because that event is produced only by a queue.

Three facts about the event drive everything here.

**A required context must report on `merge_group`, or the queue merges nothing.**
A queue re-tests each projected merge as its own event and waits for the required
contexts on it. A workflow with no `merge_group` trigger reports no check there,
and an entry whose required check never reports is ejected. That is the same
deadlock a trigger-level `paths:` filter causes on a pull request — the reason
`web-ci`, `skills-ci`, `web-e2e` and `aggregate-checks` are unfiltered — moved on
to a different event. So all four carry `merge_group:`.

**`merge_group` supports no `paths:` filter at all.** For a path-filtered
workflow the choice is therefore binary: run on every queue entry, or run on
none. `adr-numbers`, `instruction-references` and `updater-tests` run on every
entry. That is not a cost being tolerated for tidiness — it is the point. The
ADR-number collision in #860 is a *race*: two pull requests each claiming `0017`,
each green against a `main` that does not yet carry the other, colliding only in
the merged result. The queue exists to test that result. A queue that tested each
entry with only the four required contexts would check ADR numbering nowhere, and
would close nothing while appearing to.

**A check that cannot answer must stay red.** `aggregate-checks` reads a head
commit and a changed-file list, and where it takes them from depends on the
event: `github.event.pull_request` and the pull request files endpoint on a pull
request, `github.event.merge_group.head_sha` and the `base_sha...head_sha`
comparison in a queue. Any other event is `Undetermined` and exit 2, which is
red. That comparison carries one hard limit worth knowing before the queue is
switched on: GitHub truncates its changed-file list at 300 and declares no total,
so a queue entry changing 300 files or more cannot be shown to have been read
whole and is refused rather than judged on a short list. It fails closed, so such
an entry is ejected rather than merged on an incomplete reading. The scope steps
in `web-ci`, `web-e2e` and `skills-ci` fail open the same
way for the same reason: an event they have no base commit to diff against runs
the full suite rather than skipping it, and `web/tests/workflows/` pins that with
a test rather than asserting it in a comment.

What has **not** been exercised is the live event. No `merge_group` has ever
reached this repository, so every claim above is from unit tests that supply the
environment GitHub documents, plus a reading of the workflow files. The first
real queue entry is the integration test — which is exactly why each of these
paths is written to fail closed.

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
| `skills-ci` | `skills-ci.yml` | **Yes** — see below |
| `source-link-health-tests` | `source-link-health.yml` | **Yes** — see below |
| `source-link-health` | `source-link-health.yml` | **No, and never** — see below |
| `web-e2e` | `web-e2e.yml` | **Yes** — see below |
| `aggregate-checks` | `aggregate-checks.yml` | **Yes** — see below, and requiring it is the point |

### Why `web-ci` is safe to require

It runs on **every** pull request. It has no `on.pull_request.paths` filter;
instead its first step diffs the pull request against its base and decides
whether the site actually needs building. A pull request that touches nothing the
web suite reads gets a green `web-ci` in a few seconds without installing Node or
running the suite.

What "nothing the web suite reads" means is derived rather than assumed, and the
scope step's own comment records the derivation: `web/**` plus every path outside
`web/` that a file under `web/` opens. It was `web/**` and this workflow alone
until [#477](https://github.com/abdeslam-menacere/ModelTree/issues/477), which
meant a pull request changing only `skills-ci.yml` ran no web test — including
`web/tests/workflows/skills-ci.test.ts`, whose entire subject is that workflow.
The predicate had encoded a value that was true once, that every test under
`web/` tests `web/`, as though it were an invariant.

That distinction matters. A workflow filtered at the trigger does not start at
all on a non-matching pull request, so it reports **no check** — and a required
check that never reports is treated as pending forever, which blocks the pull
request permanently rather than passing it. `web-ci` is deliberately built to
report unconditionally so it can be required without that trap.

The job id and its `name:` are both the literal string `web-ci`, and the job has
no `strategy.matrix`, so the reported name never varies per leg or per run.

It also runs on **pushes to `main`**, which overlaps `pages.yml` — that workflow
builds `main` on every push too. The overlap is deliberate. `pages.yml`'s build
is a step of a *deployment*: its `deploy` job is gated on `github.repository`, so
on a fork `main` is verified by nothing at all, and when the job goes red the run
name cannot say whether the site is wrong or whether publishing is wrong. Those
have different owners and different fixes. A status called `web-ci` on the commit
itself answers "was this commit of `main` verified?" without the reader having to
know the answer lives inside a deploy workflow, and it covers a direct push to
`main`, which branch protection still permits for administrators.

The duplicate cost is paid down rather than accepted whole: the same in-job scope
step diffs a push's own range, so a `main` push that touched nothing the web
suite reads finishes green in seconds and only a push that really changed the
site builds twice.

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

### `aggregate-checks` makes the three above countable

The three sections above each end the same way — this check cannot be required,
because a path-filtered workflow reports nothing on a non-matching pull request
and a required check that never reports blocks forever. That is true, and it left
a hole that [#710](https://github.com/abdeslam-menacere/ModelTree/issues/710)
measured: `adr-numbers`, `instruction-references`, `pytest (Python 3.11)` and
`pytest (Python 3.13)` **do** run against the merged tree when they trigger,
because GitHub checks out the merge commit for `pull_request` — but nothing
blocks on their result. GitHub's `mergeStateStatus` reads `CLEAN` while one of
them is red, because that field means *mergeable, and nothing that blocks is
red*, not *everything passed*. A human or an agent merging on that signal merges
a red pull request. Pull request 772 is the recorded shape of it:
`source-link-health` red, `web-ci`, `skills-ci` and `web-e2e` all green.

`aggregate-checks` is the requirable check that fails when one of those failed.
It has **no** `on.pull_request.paths` filter, so it reports on every pull request
including one that touches nothing relevant — which is exactly the property the
path-filtered workflows lack and the only thing that makes a check safe to
require. Its job id and its `name:` are both the literal `aggregate-checks`, and
it has no `strategy.matrix`, so the reported name never varies.

It does not *run* any of those checks. It **observes** them, and the distinction
is forced rather than chosen. `needs:` names jobs in the same workflow file only;
there is no cross-workflow `needs`, so the familiar `needs.*.result` pattern
cannot see another workflow at all. `workflow_run` is worse here, not better: it
fires only when the named workflow actually ran, which is precisely the case the
aggregator has to tell apart from the other one. What is left is the single
source of truth GitHub does expose —
`GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs` — which was checked
against the `statusCheckRollup` of a real past pull request and returned the same
set, name for name and conclusion for conclusion.

**The distinction the whole thing exists for** is between a check that was
*skipped* and a check that *never triggered*. They are different states and only
one of them is visible as a check run:

| State | What the checks API shows |
|---|---|
| Passed | a run, `status: completed`, `conclusion: success` |
| Failed | a run, `status: completed`, `conclusion: failure` |
| Skipped | a run, `status: completed`, `conclusion: skipped` |
| Never triggered | **no run with that name at all** |

The last row is the trap. An absent check and a check whose run has not been
created *yet* look identical, so a naive reader that treats "absent" as "fine"
passes a pull request whose real checks had simply not started. So the script
does not treat absence as anything on its own. It reads
`GET /repos/{owner}/{repo}/pulls/{number}/files` — which is what GitHub itself
matches an `on.pull_request.paths` filter against — computes from the committed
path filters which watched checks *should* have triggered, and requires each of
those to be present and to have finished. An expected check that never appears is
**undetermined**, which is a red job, not a green one. Only a check that is both
absent and unexpected is read as never-triggered, and only after the run has
observed the check set hold still.

Two conclusions pass: `success` and `skipped`. Everything else fails, and
`cancelled` is the one worth stating a reason for, since several workflows here
set `cancel-in-progress: true` and cancellation is therefore routine rather than
exceptional. A cancelled check is the **absence of a verdict**, not a verdict of
success, so it fails. That costs nothing in the routine case: concurrency cancels
the runs belonging to a *superseded* head SHA, and the aggregator on that same
SHA is cancelled by the same rule at the same time, so the commit that goes red
is one nobody is merging. The newest head SHA gets a fresh set of runs and a
fresh aggregation. `timed_out`, `neutral`, `action_required`, `stale` and a null
conclusion all fail for the same reason: none of them is evidence the check
passed.

What it deliberately does **not** watch, and why:

| Not watched | Why |
|---|---|
| `web-ci`, `skills-ci`, `web-e2e` | already required, so aggregating them would only add a second way to say the same thing |
| `source-link-health` | must never be required — it depends on other people's uptime, and the section below explains at length why it is advisory |
| the two link-health issue jobs | they are `needs:`-gated issue bookkeeping and are skipped on every pull request |
| itself | for the obvious reason |

`source-link-health-tests` **is** watched: it is the in-job-scoped self-test half
of that workflow, which the section below already records as safe to require.

There is exactly one environment variable, `AGGREGATE_CHECKS_TIMEOUT_SECONDS`,
and it is fail-closed by construction: it can only end a run *sooner*, as
undetermined, which is a red job. There is no value of it that turns a
non-success into a pass. The job has no `continue-on-error`, no `if: always()`,
no `|| true`, and the script takes no arguments, so there is no flag to reach
for. Its exit codes are 0 passed, 1 a watched check did not pass, 2 the question
could not be answered — and 2 is a failing job, the same rule the gate scripts
hold: a check that could not run has not passed.

**Merging this workflow changes nothing on its own.** It reports, and a report
nobody requires is a report. Adding `aggregate-checks` to the required set on
`main` is a branch-protection change and needs the repository owner; until that
happens the hole #710 measured is still open, with one more green check beside
it.

Its decision logic is covered by `web/tests/workflows/aggregate-checks.test.ts`,
which runs the real script against a fixture checks API and asserts real exit
codes for each case above — failed, skipped, never-triggered, cancelled, timed
out, still-running and unreadable. What that cannot cover is GitHub's own
production of the check runs, which is evidenced from past runs rather than
executed locally. `.github/scripts/ci-preflight.mjs` names the same limit in its
`NOT_COVERED` list, so a green preflight does not silently claim it.

### `skills-ci` is safe to require

It was trigger-path-filtered until #294, which is why older text lists it with
the three above as the same trap. That reason has stopped being true.
`skills-ci.yml` carries no `on.pull_request.paths` filter, starts on **every**
pull request, and decides inside the job — by diffing the pull request against
its base, which is the shape `web-ci` already uses — whether the gates have
anything to read. A pull request touching none of `.github/skills/`,
`.github/scripts/`, `.github/workflows/skills-ci.yml` or `web/src/data/` gets a
green `skills-ci` in a few seconds without setting up Node, and says in its job
summary that no gate was run. The check always reports, so requiring it cannot
deadlock a pull request.

The job id and its `name:` are both the literal string `skills-ci`, and the job
has no `strategy.matrix`, so the reported name never varies per leg or per run.

It also runs on **every push to `main`**, added by
[#639](https://github.com/abdeslam-menacere/ModelTree/issues/639). Before that
its triggers named no push event, so the check reported on the pull request and
then nothing re-ran it on the commit that merged — a required context that never
appeared on `main`. That matters because `strict` is false — read live on
2026-08-31, when `required_status_checks.contexts` was `["web-ci", "skills-ci",
"web-e2e"]`, and dated for the reason every other protection reading in this file
is dated. Branches need not be up to date before merging, so two pull requests
can each be green against different bases, merge with no textual conflict, and
combine into a gate suite that is broken on `main`. `web-ci` and `web-e2e` re-run
on `main` and would catch their own equivalent of that; this one could not, and
what it guards is the ADR 0003 path from an unattended refresh to Pages.

The push trigger carries no path filter either, and — unlike `web-ci`, whose
scope step diffs a push's own range — the in-job decision runs the gates outright
for any event that is not a pull request. The trade differs because the cost
does: `web-ci` is skipping an `npm ci` and a production build, while these steps
install nothing and run dependency-free Node scripts, so the run a skip would
save is worth less here than the coverage it would cost.

Nothing in `concurrency` needed changing for that: `cancel-in-progress` is
`github.event_name == 'pull_request'`, so a superseded pull request run is
dropped and a `main` run is never cancelled by a later push. Every commit on
`main` keeps its own verdict, which is the whole point of running there.

Whether it is a required status check is a property of branch protection — a
repository setting this file cannot read and does not assert here, so that the
statement cannot rot the next time protection changes. Making a check required
is a branch-protection change and an owner action; #294 made this workflow
requirable and deliberately stopped there, the prerequisite rather than the
outcome. The problem family it belongs to is discussed on #80, #163 and #169.

It is **not** covered by #169, despite being the same family of problem: #169
places `skills-ci` expressly outside its own scope, as a related decision to be
settled alongside it rather than inside it. What #169 *does* cover is stated
once below, under **What issue #169 covers**.

The distinction worth stating plainly rather than leaving implied: a check
*running* is not the same as a check *blocking*, and a check being *requirable*
is not the same as its being *required*. Which of the reported checks branch
protection actually requires is not knowable from this file; read the live
settings when that answer matters.

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

### `source-link-health` must never be required, and `source-link-health-tests` could be

These two names come from one workflow and belong on opposite sides of the line,
which is why the workflow splits them into separate jobs rather than one.

`source-link-health` **makes network requests to third parties**. Its verdict
therefore depends on servers this repository does not run: Hugging Face and
GitHub are between them the two most-cited hosts in `sources.json`, and both
rate-limit and serve anti-bot responses to unfamiliar clients. A required check
whose result
depends on someone else's rate limiter goes red on work that is correct, and a
check that goes red on correct work gets worked around rather than fixed — the
same reasoning the `adr-numbers` section above applies to ADR contiguity. So the
checker is built not to report those cases as findings at all, and the job is
built not to be required even so. Requiring it would hand an outside party a
veto over merging here.

`source-link-health-tests` is the opposite: it runs `node --test` over the
checker's own suite, which stubs `fetch` and touches no network. It behaves like
`skills-ci` — no `on.pull_request.paths` filter, starts on every pull request,
decides inside the job whether anything it covers changed, and says so in its job
summary when it skips. It always reports, so requiring it could not deadlock a
pull request. It is genuinely not required: when the live settings were read on
2026-08-30, `required_status_checks.contexts` was `["web-ci", "skills-ci",
"web-e2e"]`, which does not include it. That it is requirable but unrequired is a
branch-protection decision an owner takes, and this change does not take it.

Both job ids and both `name:` values are the literal strings above, and neither
job has a `strategy.matrix`, so the reported names never vary per leg or per run.

Two behaviours are worth stating because they are easy to assume the other way
around. The maintenance issue can only be opened or closed from a **scheduled**
run, or from a manual run that explicitly opts in; a pull request run — from this
repository or a fork — cannot file into the tracker, which is asserted in
`web/tests/workflows/source-link-health.test.ts` rather than left to the reader.
And the closing comment says out loud that a URL which has stopped answering
altogether produces the same clean result as a healthy one, because a timeout is
deliberately not a finding.

A third, which decides what the check's colour means. **An actionable finding
does not turn the sweep red.** It is reported instead — step outputs, a job
summary, an uploaded artefact, and the maintenance issue — and the job still
concludes green. Advisory does not mean never red; it means never red for
somebody else's server, because a link rotting there is not a defect of any
change here, and a check that reddens on work nobody did is one people learn to
ignore. Where somebody here *is* answerable the check still fails: a pull request
owns the URLs it introduced, and `Report on the URLs this pull request
introduced` fails on those and only those, after the outputs and summary are
written. And a checker that **could not run** — exit 2 or above — still fails
loudly and writes no outputs, so it can never read as a clean sweep. That last
part is what lets the two issue jobs keep their implicit `success()` rather than
an `if: always()`: a broken checker fails the sweep, so it can neither file a
false alarm nor close a real one.

Until #632 none of that happened. `set -uo pipefail` in the checking step read as
clearing the `-e` the runner supplies and does not, so every non-zero checker
exit aborted the step before its code could be read: a finding produced no
outputs, no summary, no artefact and no issue, and the exit-2 branch never ran at
all. The reporting machinery worked only when it had nothing to report. The tests
in `web/tests/workflows/source-link-health.test.ts` now execute that step's
script under the runner's exact shell invocation rather than reading it, because
no assertion over the file's text had seen or could have seen this.

Which of the two issue jobs acts is decided by the checker's **exit code**,
carried across as the `clean` output, and never by the URL count. This matters
because the checker exits 1 for two different reasons — an actionable URL, or a
source record whose URL cannot be turned into a request at all — and only the
first is counted into `actionableUrls`. So "did it find anything?" and "is
`actionable` zero?" are different questions, and the second is not a safe
stand-in for the first. Gating the close on the count meant a sweep whose only
finding was a malformed record reported `actionable=0`, skipped the maintenance
issue, and ran `resolve-issue` — closing the standing alert and posting an
all-clear over a finding the checker had just raised. Fixing the abort above is
what made that path reachable at all, so the two were fixed together. `clean` is
true only on exit 0, the two job guards are exact complements, and `actionable`
stays a URL count because the pull-request step is keyed on it and malformed
records are whole-dataset rather than pull-request-scoped — summing them in would
redden a pull request for a record it did not introduce.

This complements, rather than duplicates, the `urls` rules in the table below:
`gate-dataset` refuses a URL that is malformed, non-https, credential-bearing or
pointed at a private host, all of which it can decide by reading the string.
Whether a well-formed URL still resolves is not knowable without asking, and no
gate asks.

### `web-e2e` runs in CI as a separate workflow

`web-e2e` reports on every pull request that touches `web/`, and it goes red when
the browser assertions fail. Whether that red stops a merge is a property of
branch protection — a repository setting this file cannot read and does not
assert here, precisely so the statement cannot rot the next time protection
changes. The job id and its `name:` are both the literal string `web-e2e` and the
job carries no `strategy.matrix`, so the name is stable and requirable.

It follows `web-ci`'s pattern in the way that matters for requirability: no
`on.pull_request.paths` filter, an in-job scope gate instead, so it reports
unconditionally and cannot become a check that never arrives. What it adds over
`web-ci` is `npx playwright install --with-deps chromium`, roughly a
150 MB download per run. That cost is the whole reason it is a separate
workflow — inside `web-ci` it would land in `npm run build`, and therefore in
every dock's install and both gate agents' runs, for a check almost none of them
need.

### `drydock-gates` does not exist

`drydock land` instructs the maintainer to require a `drydock-gates` check. **No
such workflow exists in this repository**, and requiring a check that no workflow
reports deadlocks every pull request. Do not add it to branch protection.

## Running these checks before the merge

Nothing in a dock's local loop used to invoke most of the checks above. The
gates run `npm run validate`, the deterministic gate scripts, and the gate
self-tests; none of those reads `.github/`, `tools/`, or `docs/adr/`. So a
change to an instruction document could pass both gates and redden `main` on
merge, and did: on #441 / PR #558, merged as
`3d3f4b1`, `review-441` and `qa-441` both passed at `6925d5a` and the merge
turned `instruction-references`, `pytest (Python 3.11)` and `pytest (Python
3.13)` red. One bare issue citation, three red checks, and no local command that
could have seen any of them (#560).

[`../scripts/ci-preflight.mjs`](../scripts/ci-preflight.mjs) closes that. From
the repository root:

```bash
node .github/scripts/ci-preflight.mjs          # run what this diff triggers
node .github/scripts/ci-preflight.mjs --plan   # print what it would run, run nothing
```

It diffs the branch against `git merge-base HEAD refs/remotes/origin/main` — the
same anchor `gate-scope.mjs` and `gate-source-approval.mjs` compute for
themselves, so committing first changes nothing — selects the checks whose
triggers that diff matches, and runs their commands. It adds no rule of its own:
every command it runs is a command one of the workflows above already runs.

Exit **0** means every selected check ran and passed; **1** that one failed;
**2** that one could not be run, which is never a pass. `--plan` exits 2 as
well, because it verifies nothing, and `--help` exits 2 for the same reason, so
the only zero this script emits is one that was earned.

A run that selects **no** checks exits 2 as well, and says `NOTHING SELECTED`.
That case is worth stating on its own, because it is the one that reads most
like a pass and is furthest from being one: with nothing selected there is no
failure and no unknown to count, so tallying only those two would return 0 from
a run in which no command executed. A dock told `PASS` there would conclude CI
is clear on the strength of a check that never ran — the inference this whole
section exists to prevent. Exit 2 also means the code carries two readings, "a
check could not run" and "there was nothing to check", so `--json` reports
`empty` to tell them apart; exit 0 in `gate-scope.mjs` is separated the same way
and for the same reason. An empty selection is not a licence to skip anything:
it says only that no *pull-request* check reads what changed, and `web-ci` still
reports on every pull request whatever the preflight selected.

A **failing** check carries its own output, in both modes. In the default mode
the child inherits the terminal and streams to it. Under `--json` it cannot —
interleaving a transcript onto stdout would corrupt the document — so the
combined stdout and stderr of the command that failed is attached to its entry
in `results[].commands[]` as `output`, with `outputBytes` and `outputTruncated`
beside it, and written to stderr as well so a reader needs no parser to see it.
Only the last 64 KiB is kept, because a runner prints its failure summary last;
when that bound bites, `outputTruncated` is true and the text says so, since an
excerpt presented as the whole is its own kind of wrong answer. Nothing is
attached to a command that passed, where the output is only noise.

This closed [#663](https://github.com/abdeslam-menacere/ModelTree/issues/663).
Before it, `--json` ran every child with `stdio: 'ignore'`, so a failure
survived only as `"npm run test" exited 1` — an exit code and nothing else — and
a flake, a real regression, a missing dependency and a typo in a script were
byte-identical. The cost is measured rather than theoretical:
[#517](https://github.com/abdeslam-menacere/ModelTree/issues/517) and
[#720](https://github.com/abdeslam-menacere/ModelTree/issues/720) turned out to
be one defect seen from two ends, and what made that visible was a report naming
the failing test and the 5000 ms figure it timed out at instead of saying
"flake". None of this touches the exit codes: capture changes what a failure
says, never what it counts as.

| Check | Run locally by the preflight as |
|---|---|
| `web-ci` | `npm run test`, `npm run check`, `npm run astro -- build`, from `web/` |
| `skills-ci` | the gate self-tests, `gate-dataset.mjs`, and the skill-doc test-count refusal |
| `instruction-references` | `python tools/instruction_refs/check_instruction_references.py` |
| `adr-numbers` | `python tools/adr_numbers/check_adr_numbers.py` |
| `pytest (Python 3.11)`, `pytest (Python 3.13)` | `python -m pytest` from `tools/updater`, **once** |
| `source-link-health-tests` | the link-health tests and the `--dry-run` extraction |

Every row above is a **mirror**: a copy, in the script, of what some workflow
already runs. A copy can drift from its original, so the script carries one more
group that is not a mirror of anything —

| Not a CI check | Run locally by the preflight as |
|---|---|
| `preflight-self-check` | `vitest run tests/workflows/ci-preflight.test.ts`, from `web/` |

— which compares the script's table against the committed workflow YAML and
fails if the two have parted. It is selected by a change to
`.github/workflows/**`, to `ci-preflight.mjs`, or to those tests. It reports no
CI check, prints as `preflight self-check, not a CI check`, and the two kinds are
labelled `mirror` and `self` in the table itself so that no assertion about
mirrors — that the trigger is copied exactly, that each command maps onto a real
step — is quietly read as applying to something with no original to be compared
against.

That group exists because the fidelity tests used to live under `web-ci` alone,
whose scope was then `^(web/|\.github/workflows/web-ci\.yml$)`. Editing
`skills-ci.yml` therefore selected `skills-ci` and nothing else, and the tests
written to catch exactly that drift were never chosen: a workflow edit could make
the script's copy wrong while the preflight still reported PASS. The guard was
not missing, it was not selected — the same shape of defect as #560 itself, one
level up.

`web-ci`'s own scope has since been widened to cover `.github/workflows/` and
`ci-preflight.mjs`, so those paths now select `web-ci` too
([#477](https://github.com/abdeslam-menacere/ModelTree/issues/477)). The
self-check stays: `web-ci` runs the whole suite, the diagnostics and a
production build and needs `web/node_modules` for any of it, while this runs the
single file that compares the copies, so the fidelity answer survives a `web-ci`
leg that could not run — and it keeps those tests selected on their own terms
rather than as a side effect of another check's scope, which is the coupling
that produced the gap.

### What the preflight does not cover

Printed on every run, passing runs included, because the failure being closed
here is a reader inferring a completeness that is not there:

- **`source-link-health`.** It requests every recorded URL. Advisory, never
  required, network-bound; a preflight that needed the network would fail for
  reasons that are not the change's.
- **The second Python interpreter.** CI runs the updater suite on 3.11 and 3.13.
  The preflight runs it once, on whatever `python` resolves to locally, so an
  interpreter-specific failure is still CI's to find first.
- **`pip install --dry-run '.[foundry]'`.** Resolving that optional group reaches
  the index, so an unsatisfiable pin in it still arrives unseen.
- **`pages.yml`.** It deploys on push to `main` and reports no pull-request
  check.
- **The runner.** Same commands, different machine: Node and Python versions,
  the OS, and a populated `node_modules` all differ from a clean
  `ubuntu-latest` checkout. A green preflight predicts CI; it does not bind it.
- **The merge result.** Selection is anchored at the merge base, so it judges
  this branch, not this branch merged into a `main` that has moved since.
- **Workflow edits beyond the script's copy of them.** `preflight-self-check`
  compares two files; it never executes the edited workflow. An edit that this
  script copies faithfully and that still fails on the runner — a bad
  `runs-on`, a missing secret, an action version that no longer resolves — passes
  it.
- **Branch protection.** Which checks are required lives outside the tree. A
  green preflight says the checks passed, never that the pull request is
  mergeable.

Two of those are worth stating as a rule rather than a list item. A check that
never ran reports the same absence as one that passed — the trap #560 was filed
about, where querying whether `instruction-references` had failed on `33b2222`
and `418b5e5` returned zero rows because it had never run on them. The preflight
refuses to reproduce that: a check whose prerequisites are missing is reported
`COULD NOT RUN` with a non-zero exit, never omitted and never green. And
`--plan` exits 2 for the same reason.

## What gates a dataset change

Two different checks read `web/src/data/`, and they do not enforce the same
rules. `web-ci` runs the vitest suite and the Astro and TypeScript diagnostics
as separate steps, which together are exactly what `npm run validate` runs, and
which validate the dataset through Zod and `web/src/data/validate.ts`.
`skills-ci` runs
`.github/skills/modeltree-gates/scripts/gate-dataset.mjs`, the deterministic
gate ADR 0003 places between an unattended refresh and Pages.

The overlap between them was previously unmeasured, which is not the same as
being covered. The table below is the measurement, taken by execution: for each
rule `gate-dataset` enforces, the dataset was mutated to violate **that rule
alone**, both checks were run, and the column records which refused. Every
mutation was reverted and the dataset verified byte-identical afterwards.

All 43 rules were refused by `gate-dataset`, so no rule in it is dead. 27 are
also refused by `npm run validate`. **16 are enforced by `gate-dataset` alone**,
shown in bold.

Two limits on how to read it. It samples one row per rule *and field*, not one
per edge, so a rule holding over more documents than it has rows is normal —
abdeslam-menacere/ModelTree#495 extended `references`, `evidence`, `urls` and
`dates` across six further documents without adding a rule to either column, and
moved the counts only by the one refusal it genuinely added. And it predates the
`non-empty` rules that abdeslam-menacere/ModelTree#548 introduced, which have no
row here; closing that gap is a separate measurement, not this table's to
assume.

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
| `no-composite-score` | `RANKING_WORDS`: a bare `score` field, outside `benchmarkResults` | refuses | **passes** |
|  | a `score` in `benchmarkResults` with no `benchmarkId` and `unit` to bind it | refuses | refuses |
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
  guardrail against a universal ranking, and `web-ci` does not enforce it. The
  one place the two agree is the row above: an unbound `score` in
  `benchmarkResults` is refused by both, because there the binding fields are
  *declared* by `benchmarkResultSchema` and so Zod misses them — measured, by
  deleting `benchmarkId` from a committed record and running `npm run validate`,
  which reported `benchmarkResults.0.benchmarkId: Invalid input: expected
  string, received undefined` and exited 1.
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

Every workflow pins its top-level `permissions:`, so no job can start from a wider
default. Most set `contents: read`; `data-health.yml`, `source-link-health.yml`
and `publish-updater-proposals.yml` set `{}` and grant `contents: read` on the
job that checks out, which is the stricter form — a job added to one of those
later inherits nothing at all. Write scopes are granted per job, never globally:

| Job | Extra scope | Why |
|---|---|---|
| `pages.yml` → `deploy` | `pages: write`, `id-token: write` | Publish the built site and mint the OIDC token `actions/deploy-pages` exchanges |
| `pages.yml` → `report-failure` | `issues: write` | File or update the stale-site issue |
| `pages.yml` → `report-recovery` | `issues: write` | Close the stale-site issue once a deploy succeeds |
| `publish-updater-proposals.yml` → `publish` | `issues: write`, `id-token: write` (over a `{}` default, so it also names `contents: read`) | Write proposal issues; sign in with workload identity. Unchanged by the weekly schedule #30 added: the same job holds the same three scopes whoever or whatever starts it, so scheduling grants nothing new, and `tools/updater/tests/test_publication_workflow.py` asserts it against the parsed YAML |

`web-ci.yml`, `skills-ci.yml`, `updater-tests.yml`, `instruction-references.yml`,
`adr-numbers.yml` and `web-e2e.yml` hold no write scope at all. Nothing in this
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
scope step matches, the stable job name, and the permission model. It also
expands `web/package.json`'s scripts and asserts that `web-ci.yml`'s three
verification steps decompose to exactly the `npm run build` the deploy gates on —
neither side is restated in the test, so adding a stage to `validate` without
adding a step to the workflow fails there rather than silently leaving the check
weaker than the deploy.
`web/tests/workflows/skills-ci.test.ts` does the same for `skills-ci.yml`, and
additionally reads the data directory and the dataset documents out of
`gate-dataset.mjs` to assert the in-job scope decision covers every one of them
— so a new dataset document cannot be added without the gate's scope following
it. Both run as part of
`npm run validate` from `web/`. If you change one of those properties on
purpose, update the test and this file in the same change.

`web-ci.test.ts` also pins the derived scope set: it reads `.github/workflows/`
off disk and asserts every entry matches, names each qualifying path outside
`web/` alongside the test that reads it, and asserts that a neighbour of one of
those paths which no `web/` test reads does **not** match. So adding a test under
`web/` that opens a new file outside `web/` without widening the scope step fails
there — and reaching for a directory where only some files qualify fails too.

`tools/updater/tests/test_adr_numbers.py` does the same job for `adr-numbers.yml`
— its path filters, its job name, its permission model, and that it invokes the
checker with no arguments. It also asserts `push.branches` is exactly `[main]`,
because verifying a new workflow before it reaches `main` means adding a branch
to that list for a commit, and a leftover entry is a trigger nobody expects.

`web/tests/workflows/ci-preflight.test.ts` is the one that will notice a *new*
workflow. It enumerates every job that can report a pull-request check, expands
the matrix legs, and asserts each reported name is either run by
[`../scripts/ci-preflight.mjs`](../scripts/ci-preflight.mjs) or named in that
script's uncovered list. It also reads each covered workflow's `paths:` filter
or in-job `grep -E` pattern and asserts the preflight copies it exactly, and
that every command the preflight runs is a `run:` step of the real job. So a
workflow cannot be added, retriggered, or have its command changed without the
local preflight following it — which is the drift that would otherwise put this
repository back where #560 found it.
