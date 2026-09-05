#!/usr/bin/env node
/**
 * One status check that reports on every pull request -- and on every merge
 * queue entry, once a queue exists -- and is red whenever a path-filtered check
 * on the same commit is not green.
 *
 * -- What this closes --
 *
 * Branch protection on `main` requires three contexts. `adr-numbers`,
 * `instruction-references` and the two `pytest` legs are not among them, and
 * they are not required for a reason that is sound rather than an oversight:
 * each is filtered at its trigger by `on.pull_request.paths`, so on a pull
 * request that touches none of those paths the workflow never starts and
 * reports *no check at all* -- and a required check that never reports leaves a
 * pull request pending forever. `adr-numbers.yml` says exactly this in its own
 * header.
 *
 * The consequence is that those checks run, and go red, and stop nothing.
 * `mergeStateStatus` still reads `CLEAN`, because that field means "mergeable,
 * and nothing that blocks is red", not "everything passed". Anyone merging on
 * it -- a human, an agent, or auto-merge -- merges a red pull request.
 *
 * This job is the standard resolution: it carries no `paths` filter, so it
 * always reports and is therefore safe to require, and it is red unless every
 * watched check either passed or was legitimately skipped or never triggered.
 * It converts *skipped* and *not triggered* into one green signal without ever
 * converting *failed* into one.
 *
 * Requiring it was a branch-protection change and an owner action, and that
 * action has been taken: `aggregate-checks` is one of the required contexts on
 * `main` -- measured 2026-09-04. So what this script concludes now decides what
 * can merge. Requirable and required stay separate facts, and only the second
 * lives outside this tree, so that reading is a dated measurement rather than a
 * standing guarantee.
 *
 * -- Why it reads the API rather than `needs` --
 *
 * The obvious shape for an aggregator is a job with `needs:` on the jobs it
 * summarises, reading `needs.<job>.result`. That shape cannot be used here, and
 * not for want of trying: `needs` names jobs *in the same workflow*, and every
 * check this aggregates lives in a different workflow file. There is no syntax
 * that declares a dependency across workflows.
 *
 * `workflow_run` is the other tempting answer and is worse. It fires only when
 * the workflow it names actually ran, which is precisely the case this job
 * exists to distinguish from the case where nothing ran.
 *
 * So the information this needs is not available to YAML at all. It is
 * available to the checks API, which is what this reads:
 * `GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs` returns every check
 * run reported on the pull request's head commit. Measured against pull request
 * 715, that endpoint returned exactly the seven entries GitHub also shows in
 * `statusCheckRollup` -- same names, same conclusions -- so the head SHA is the
 * right anchor and this is the same list a reviewer sees.
 *
 * -- Which event it is running under --
 *
 * Two events reach this script, and they answer its two inputs -- the head
 * commit, and the changed-file list -- from different places. `GITHUB_EVENT_NAME`
 * decides which, and anything else is refused rather than guessed at
 * (abdeslam-menacere/ModelTree#877):
 *
 *   - `pull_request`: the head commit is `github.event.pull_request.head.sha`
 *     and the changed files come from the pull request's own files endpoint,
 *     which is the list GitHub itself compares against a `paths:` filter.
 *   - `merge_group`: there is no pull request in the payload at all, so both
 *     `PR_NUMBER` and `PR_HEAD_SHA` arrive empty. The head commit is
 *     `github.event.merge_group.head_sha` -- the commit GitHub built for the
 *     projected merge, and the commit every check run in the queue is reported
 *     against -- and the changed files come from comparing
 *     `github.event.merge_group.base_sha...head_sha`.
 *
 * The expectation model differs between them, and that difference is the part
 * that must not be flattened. **`paths:` filters do not apply on a
 * `merge_group` event**: a workflow carrying a `merge_group` trigger runs on
 * every queue entry whatever the change touched. So on that event a watched
 * check is expected whenever its workflow triggers there, full stop, and the
 * changed-file list decides nothing about it. Applying the pull request's
 * path-filter reading to a merge group would mark a check that really is
 * running as "never triggered", and an absence read that way is exactly the
 * laundering of a pending failure into a required green that the whole job
 * exists to prevent.
 *
 * A watched check whose workflow carries no `merge_group` trigger is not
 * expected there and its absence is green -- for the same reason a
 * never-triggered check is green on a pull request, and with the same limit: if
 * it does report, its own conclusion is read and nothing about it is assumed.
 *
 * The changed-file list is still read on both events. On a merge group it feeds
 * no expectation, and it is not decoration either: it is what turns a head or
 * base SHA that names nothing into a 404 and an undetermined run, rather than
 * an empty check-run list quietly read as a settled one.
 *
 * An event this script has no way to measure -- a push, a dispatch, anything
 * added later -- is undetermined and red. That is not a gap to be filled with a
 * default; it is the same refusal as everywhere else here, because reporting a
 * green aggregate for an event whose checks it never read is the unearned green
 * this job exists to remove.
 *
 * -- The distinction the whole job turns on --
 *
 * A check that GitHub *skipped* and a check that *never triggered* are
 * different states and look different here:
 *
 *   - skipped: the check run exists, `status` is `completed`, `conclusion` is
 *     `skipped`. Measured on pull request 715, where the two link-health issue
 *     jobs report exactly that.
 *   - never triggered: there is no check run with that name. Measured on the
 *     same pull request, which touched no `docs/adr/` file: `adr-numbers` is
 *     not absent-with-a-conclusion, it is simply not in the list.
 *
 * Both are green here. The danger is that a *third* state also looks like the
 * second one from a distance -- a check that was triggered, has not yet created
 * its check run, and is going to fail. Reading that absence as "never
 * triggered" is how an aggregator launders a real failure into a required
 * green, which would make this job worse than not existing.
 *
 * Two things stop it, and the first is the real guard:
 *
 *   1. Expectation. This script computes, from the pull request's own changed
 *      file list, which watched checks GitHub's path filters *should* have
 *      triggered. An expected check that is absent is never accepted as "never
 *      triggered": the run waits for it, and fails as undetermined if it never
 *      arrives. The path filters are a copy of the committed workflows and
 *      `web/tests/workflows/aggregate-checks.test.ts` compares the copy against
 *      the original, so a filter that changes in one place turns that test red
 *      rather than quietly narrowing this one.
 *   2. A settle period. Absence is only accepted once SETTLE_MS has passed, so
 *      a check run created moments after this job starts is seen rather than
 *      missed. This is a margin rather than a measurement, and it is defence in
 *      depth behind (1) rather than a substitute for it.
 *
 * -- How each conclusion is read --
 *
 * `success` and `skipped` pass. Everything else fails, `cancelled` and
 * `timed_out` included, and that is a decision rather than an oversight.
 *
 * `cancelled` is neither success nor failure: it is the absence of a verdict.
 * Converting it to green would be the same laundering as above with a different
 * label on it. Several of these workflows set `cancel-in-progress: true` for
 * pull requests, so cancellation is routine -- but it is routine *for a
 * superseded head commit*, because the concurrency group is keyed on the ref
 * and a new push cancels the previous run. The check runs read here belong to
 * one head SHA, and a cancelled check on the SHA being merged means that SHA
 * was not verified. This job is cancelled by the same mechanism on the same
 * event, so the stale run reddens a commit nobody is merging while the new head
 * gets its own verdict. A cancellation that is not superseded -- a manual stop,
 * a runner lost -- genuinely leaves the commit unverified, and re-running
 * restores green.
 *
 * `timed_out`, `action_required`, `stale` and `neutral` fail for the same
 * reason: none of them is evidence the check passed. This mirrors the reading
 * the repository owner already applies by hand when merging.
 *
 * -- Exit codes --
 *
 *   0  every watched check passed, was skipped, or never triggered
 *   1  a watched check did not pass
 *   2  this script could not determine an answer
 *
 * 2 is never a pass, and the job goes red on it exactly as it does on 1. The
 * two are separate so that a reader can tell "a check failed" from "the
 * aggregator could not read the checks", which have different fixes. Nothing in
 * this script turns a non-zero into a zero: there is no flag, no environment
 * variable and no branch that can.
 *
 * -- What it deliberately does not watch --
 *
 * Named in EXCLUDED below, with a reason each, and asserted complete by the
 * tests: every check a committed workflow can report on a pull request is
 * either watched here or excluded there, so a new path-filtered workflow cannot
 * be added without this file being confronted with it.
 */

import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The checks this job is red for.
 *
 * `checks` holds the status-check names GitHub reports, which are job `name:`
 * values with each matrix leg expanded. `triggers` is a copy of how the
 * committed workflow decides to run, one entry per event this script can
 * measure, because the same workflow decides differently on each:
 *
 *   - `workflow-paths`: the workflow's own `on.<event>.paths` list. The check is
 *     expected only when a changed file matches one of them. Only a
 *     `pull_request` trigger can carry this, because GitHub does not support
 *     `paths:` on `merge_group` at all.
 *   - `always`: the workflow starts on every event of that kind, so its check
 *     always reports. Always expected.
 *   - `not-triggered`: the workflow carries no trigger for that event, so it
 *     never starts and never reports there. Never expected, and its absence is
 *     read the same way a never-triggered check is on a pull request.
 *
 * Every form is compared against the committed YAML by the tests, on both
 * events, so a trigger that changes in one place turns that test red rather
 * than quietly narrowing what this expects.
 */
const WATCHED = [
  {
    workflow: '.github/workflows/adr-numbers.yml',
    job: 'adr-numbers',
    checks: ['adr-numbers'],
    triggers: {
      pull_request: {
        kind: 'workflow-paths',
        paths: ['docs/adr/**', 'tools/adr_numbers/**', '.github/workflows/adr-numbers.yml'],
      },
      // Unconditional in a merge queue, which is the whole point of
      // abdeslam-menacere/ModelTree#860: two pull requests each claiming the
      // same ADR number do not touch, so nothing else in the queue looks at
      // decision-record numbering.
      merge_group: { kind: 'always' },
    },
  },
  {
    workflow: '.github/workflows/instruction-references.yml',
    job: 'instruction-references',
    checks: ['instruction-references'],
    triggers: {
      pull_request: {
        kind: 'workflow-paths',
        paths: [
          '.github/copilot-instructions.md',
          '.github/skills/**',
          'tools/instruction_refs/**',
          '.github/workflows/instruction-references.yml',
        ],
      },
      merge_group: { kind: 'always' },
    },
  },
  {
    workflow: '.github/workflows/updater-tests.yml',
    job: 'pytest',
    // One workflow, two reported checks: the job's name interpolates the matrix
    // leg. Both are watched, because a failure on either interpreter is a
    // failure of the suite.
    checks: ['pytest (Python 3.11)', 'pytest (Python 3.13)'],
    triggers: {
      pull_request: {
        kind: 'workflow-paths',
        paths: [
          'tools/updater/**',
          '.github/workflows/updater-tests.yml',
          '.github/workflows/publish-updater-proposals.yml',
          'tools/instruction_refs/**',
          '.github/skills/**',
          '.github/workflows/instruction-references.yml',
          'tools/adr_numbers/**',
          '.github/workflows/adr-numbers.yml',
          'docs/adr/**',
        ],
      },
      merge_group: { kind: 'always' },
    },
  },
  {
    workflow: '.github/workflows/source-link-health.yml',
    job: 'source-link-health-tests',
    checks: ['source-link-health-tests'],
    triggers: {
      // Unfiltered at the trigger and scoped inside the job, so it reports on
      // every pull request and is always expected. `.github/workflows/README.md`
      // already records it as safe to require and not required; watching it here
      // is what makes that reachable without a second required context.
      pull_request: { kind: 'always' },
      // That workflow carries no `merge_group` trigger, so it does not run in a
      // queue and reports nothing there. Read as never-triggered rather than as
      // missing -- and if it ever does report, the run's own conclusion decides,
      // so this line cannot excuse a failure.
      merge_group: { kind: 'not-triggered' },
    },
  },
];

/**
 * Every other check a committed workflow can report on a pull request, and why
 * this job does not read it.
 *
 * The tests assert this list plus WATCHED accounts for all of them, so a
 * workflow that gains a check cannot slip past unwatched and unexplained.
 */
const EXCLUDED = [
  {
    check: 'web-ci',
    why: 'already a required context, so branch protection blocks on it directly. Watching it '
      + 'would add no signal and would make this job wait for the slowest check in the repository.',
  },
  {
    check: 'skills-ci',
    why: 'already a required context, for the same reason.',
  },
  {
    check: 'web-e2e',
    why: 'already a required context, for the same reason.',
  },
  {
    check: 'source-link-health',
    why: 'it requests every recorded source URL, so it is red when somebody else\'s server is. '
      + '`.github/workflows/README.md` records that it must never be required, and aggregating it '
      + 'into a required check would require it by the back door. It went red on pull request 772 '
      + 'with all three required checks green, which is the case this exclusion exists for.',
  },
  {
    check: 'Open or update the link-health issue',
    why: 'issue bookkeeping, skipped on every pull request by its own `if:`, and gated behind '
      + '`needs: source-link-health` -- so watching it would couple this job to the runtime of the '
      + 'network sweep excluded above.',
  },
  {
    check: 'Resolve the link-health issue',
    why: 'the same job pair, the same reason.',
  },
  {
    check: 'aggregate-checks',
    why: 'this job. It reads the checks on its own commit, so watching itself would be a wait '
      + 'that only its own timeout could end.',
  },
];

/** Conclusions that count as this check having passed. Nothing else does. */
const PASSING_CONCLUSIONS = new Set(['success', 'skipped']);

/** Prefix of the one machine-readable line every run prints. */
const CONFIGURATION_MARKER = 'aggregate-checks configuration: ';

/** How long between polls of the checks API. */
const POLL_MS = 10_000;

/**
 * How long before an absent check may be read as "never triggered".
 *
 * A margin, not a measurement: it exists so a check run created moments after
 * this job starts is seen rather than missed. The expectation model above is
 * what actually guards that direction, and this is the belt behind it. It is
 * paid only while some watched check is absent.
 */
const SETTLE_MS = 20_000;

/** The default deadline for the whole poll loop, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 20 * 60;

/** How many consecutive API failures are tolerated before the run is undetermined. */
const MAX_CONSECUTIVE_API_FAILURES = 5;

/**
 * The file ceiling the commit-comparison endpoint imposes.
 *
 * Documented by GitHub and reported nowhere in the response: measured here, a
 * 519-file comparison comes back with exactly 300 files and no field admitting
 * to the truncation, so a comparison at the ceiling cannot be told apart from
 * one merely ending there. Not a pagination bound -- the file list is not
 * paginated at all, which `comparedPaths` explains.
 */
const COMPARE_FILE_CAP = 300;

class Undetermined extends Error {}

/**
 * Does one workflow `paths:` glob match one changed path?
 *
 * Only the two forms the committed workflows actually use are implemented: a
 * literal file path, and a `dir/**` prefix. Anything else **throws**, which
 * ends as exit 2. That direction is the whole point -- a glob form this script
 * cannot read must stop it, never silently match nothing and leave a check
 * unexpected while an absence is read as "never triggered". Same rule, and same
 * two forms, as `globMatches` in `.github/scripts/ci-preflight.mjs`.
 */
function globMatches(glob, path) {
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -2);
    if (prefix.includes('*')) {
      throw new Error(`unsupported glob in a workflow path filter: ${glob}`);
    }
    return path.startsWith(prefix);
  }

  if (glob.includes('*')) {
    throw new Error(`unsupported glob in a workflow path filter: ${glob}`);
  }

  return path === glob;
}

/**
 * Whether a watched entry's workflow is triggered by this change, on this event.
 *
 * The event decides which trigger copy is read, and an entry that records
 * nothing for the event it is asked about stops the run rather than defaulting
 * either way: an unrecorded trigger is an unknown, and an unknown that resolved
 * to "not expected" would turn a pending failure into a green.
 */
function isExpected(entry, eventName, changedPaths) {
  const trigger = entry.triggers[eventName];
  if (trigger === undefined) {
    throw new Undetermined(`${entry.workflow} records no ${eventName} trigger for this script to read`);
  }

  if (trigger.kind === 'not-triggered') return false;
  if (trigger.kind === 'always') return true;
  return trigger.paths.some((glob) => changedPaths.some((path) => globMatches(glob, path)));
}

/**
 * Why an absent check is not expected, in the words of the event it ran under.
 *
 * The two reasons are genuinely different -- a filter that did not match, and a
 * workflow that does not run on this event at all -- and a log that conflates
 * them sends its reader to the wrong file.
 */
function absenceDetail(entry, eventName) {
  const trigger = entry.triggers[eventName];
  return trigger !== undefined && trigger.kind === 'not-triggered'
    ? `its workflow has no ${eventName} trigger, so it does not run here`
    : 'no changed file matches its path filter';
}

function env(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

/**
 * The poll deadline.
 *
 * Configurable only downwards in effect: a shorter deadline can end a run
 * sooner as *undetermined*, which is exit 2 and a red job. No value of it can
 * turn a failing or unresolved check into a pass, which is why it is allowed to
 * be a knob at all -- the tests need one, and this one cannot relax a verdict.
 */
function timeoutMs() {
  const raw = env('AGGREGATE_CHECKS_TIMEOUT_SECONDS');
  if (raw === null) return DEFAULT_TIMEOUT_SECONDS * 1000;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Undetermined(`AGGREGATE_CHECKS_TIMEOUT_SECONDS is not a positive number: ${raw}`);
  }
  return seconds * 1000;
}

async function api(path) {
  const base = env('GITHUB_API_URL') ?? 'https://api.github.com';
  const token = env('GITHUB_TOKEN');
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'modeltree-aggregate-checks',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GET ${path} responded ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Every path this pull request changes, as GitHub itself compares them for a
 * `paths:` filter.
 *
 * The count is checked against the pull request's own `changed_files`, because
 * this endpoint is capped at 3000 files. A truncated list would silently shrink
 * the expected set, which is the one direction that turns an absence into a
 * false pass, so a short read is undetermined rather than accepted.
 */
async function changedPaths(repo, number) {
  const pull = await api(`/repos/${repo}/pulls/${number}`);
  const paths = [];

  // 30 pages of 100 is the 3000-file ceiling the endpoint itself imposes, so a
  // loop that runs past it is a paginator that has stopped terminating rather
  // than a very large pull request.
  const maxPages = 30;
  let complete = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await api(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('the pull request files endpoint returned no array');
    for (const file of batch) paths.push(file.filename);
    if (batch.length < 100) {
      complete = true;
      break;
    }
  }

  if (!complete) {
    throw new Undetermined(`the changed-file list did not end within ${maxPages} pages`);
  }

  const declared = pull.changed_files;
  if (typeof declared === 'number' && paths.length < declared) {
    throw new Undetermined(
      `the pull request reports ${declared} changed files and the files endpoint returned `
      + `${paths.length}; the expected-check set cannot be computed from a truncated list`,
    );
  }

  return paths;
}

/**
 * Every path a merge group changes, as GitHub compares them.
 *
 * `base_sha...head_sha` is the same three-dot comparison a `paths:` filter
 * would use, and on a queue entry the base is an ancestor of the head, so it is
 * the files that entry proposes to add to `main`.
 *
 * Deliberately not paginated, which is the opposite of the pull request path
 * above and is a property of the endpoint rather than a preference. `per_page`
 * and `page` here page the *commits*. The whole `files` array arrives on the
 * first page however small `per_page` is -- measured against this repository, a
 * 141-file comparison returns all 141 at `per_page=1` -- and every later page
 * carries commits with no `files` key at all. So a reader that pages until a
 * short page reads the complete list on page 1, asks for page 2, finds no array
 * there and calls the response malformed: exit 2 for every merge group of 100
 * files or more, which as a required context would eject the entry and rebuild
 * the very deadlock this script exists to clear. Asking only for the page the
 * files are on is what makes that unreachable.
 *
 * The cap is the one thing that must still stop the run, and it is a different
 * condition from the end of the list rather than a special case of it. GitHub
 * truncates the array at COMPARE_FILE_CAP and admits it nowhere: the comparison
 * declares no file total, so unlike a pull request's `changed_files` there is
 * nothing to check a short list against, and a comparison returning exactly the
 * cap is indistinguishable from one truncated by it. Both end the run. That
 * refuses the rare merge group that genuinely changes exactly COMPARE_FILE_CAP
 * files along with every truncated one, which is the direction this script
 * always errs in: a silently shortened list shrinks the expected set, and a
 * check that should have run then reads as a legitimate absence, which is a
 * false pass.
 */
async function comparedPaths(repo, baseSha, headSha) {
  const comparison = await api(`/repos/${repo}/compare/${baseSha}...${headSha}`);

  const files = comparison.files;
  if (!Array.isArray(files)) throw new Error('the compare endpoint returned no files array');

  if (files.length >= COMPARE_FILE_CAP) {
    throw new Undetermined(
      `the comparison ${baseSha}...${headSha} returned ${files.length} changed files, which is the `
      + `${COMPARE_FILE_CAP}-file ceiling the endpoint imposes; the comparison declares no file `
      + 'total, so a list at the ceiling cannot be shown to be the whole list',
    );
  }

  return files.map((file) => file.filename);
}

/**
 * The head commit and the changed-file reader for the event this run is under.
 *
 * Every branch here either returns both, or throws. There is no default event
 * and no fallback set of environment variables: an event whose inputs this
 * cannot obtain is undetermined, which is exit 2 and a red job.
 */
function resolveEvent() {
  const eventName = env('GITHUB_EVENT_NAME');
  if (eventName === null) throw new Undetermined('GITHUB_EVENT_NAME is not set');

  if (eventName === 'pull_request') {
    const number = env('PR_NUMBER');
    const headSha = env('PR_HEAD_SHA');
    if (number === null) throw new Undetermined('PR_NUMBER is not set');
    if (headSha === null) throw new Undetermined('PR_HEAD_SHA is not set');

    return { eventName, headSha, readChangedPaths: (repo) => changedPaths(repo, number) };
  }

  if (eventName === 'merge_group') {
    // Both arrive empty on any other event, because `github.event.merge_group`
    // exists only here -- which is why the event name decides, rather than
    // whichever variables happen to be populated.
    const headSha = env('MERGE_GROUP_HEAD_SHA');
    const baseSha = env('MERGE_GROUP_BASE_SHA');
    if (headSha === null) throw new Undetermined('MERGE_GROUP_HEAD_SHA is not set');
    if (baseSha === null) throw new Undetermined('MERGE_GROUP_BASE_SHA is not set');

    return { eventName, headSha, readChangedPaths: (repo) => comparedPaths(repo, baseSha, headSha) };
  }

  throw new Undetermined(
    `this script cannot measure a ${eventName} event: it reads a pull request and a merge group, `
    + 'and an aggregate reported green over checks it never read is worse than no aggregate at all',
  );
}

/**
 * The check runs on one commit, latest run per name.
 *
 * `filter=latest` is the endpoint's own default and is passed explicitly so the
 * behaviour is stated rather than inherited: a job re-run creates a further
 * check run under the same name, and the latest one is the verdict that stands.
 */
async function checkRuns(repo, sha) {
  const runs = [];
  const maxPages = 20;
  let complete = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await api(`/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`);
    const found = batch.check_runs;
    if (!Array.isArray(found)) throw new Error('the check-runs endpoint returned no check_runs array');
    runs.push(...found);

    const total = typeof batch.total_count === 'number' ? batch.total_count : null;
    if (found.length < 100 || (total !== null && runs.length >= total)) {
      complete = true;
      break;
    }
  }

  if (!complete) throw new Error(`the check-run list did not end within ${maxPages} pages`);

  // Defensive against a name reported twice: keep the one that started last, so
  // a re-run supersedes the run it repeats rather than racing it.
  const latest = new Map();
  for (const run of runs) {
    const existing = latest.get(run.name);
    if (existing === undefined || String(run.started_at ?? '') >= String(existing.started_at ?? '')) {
      latest.set(run.name, run);
    }
  }
  return latest;
}

/**
 * The verdict for every watched check, given what the API reported.
 *
 * Pure, and the whole of the decision: the poll loop decides *when* to call
 * this, never what it answers.
 */
function classify(expectedChecks, runsByName, eventName) {
  const verdicts = [];

  for (const entry of WATCHED) {
    for (const check of entry.checks) {
      const run = runsByName.get(check);
      const expected = expectedChecks.has(check);

      if (run === undefined) {
        verdicts.push(
          expected
            ? { check, state: 'never-reported', passed: false, detail: 'expected from the changed files and never reported' }
            : { check, state: 'not-triggered', passed: true, detail: absenceDetail(entry, eventName) },
        );
        continue;
      }

      if (run.status !== 'completed') {
        verdicts.push({ check, state: 'incomplete', passed: false, detail: `still ${run.status}` });
        continue;
      }

      const conclusion = run.conclusion ?? 'none';
      verdicts.push({
        check,
        state: conclusion,
        passed: PASSING_CONCLUSIONS.has(conclusion),
        detail: `concluded ${conclusion}`,
      });
    }
  }

  return verdicts;
}

/** Watched checks that are absent from the API's answer. */
function absentChecks(runsByName) {
  return WATCHED.flatMap((entry) => entry.checks).filter((check) => !runsByName.has(check));
}

/** Watched checks that have reported and not yet finished. */
function pendingChecks(runsByName) {
  return WATCHED.flatMap((entry) => entry.checks).filter((check) => {
    const run = runsByName.get(check);
    return run !== undefined && run.status !== 'completed';
  });
}

function report(lines) {
  for (const line of lines) console.log(line);

  const summary = env('GITHUB_STEP_SUMMARY');
  if (summary === null) return;

  const body = [
    '## aggregate-checks',
    '',
    ...lines.map((line) => (line === '' ? '' : `    ${line}`)),
    '',
  ].join('\n');

  try {
    // Appending rather than replacing: the file is shared with any other step
    // that writes to it.
    appendFileSync(summary, `${body}\n`);
  } catch {
    // A summary that cannot be written changes no verdict, so it is not a
    // reason to fail. The same text has already gone to stdout.
  }
}

async function main() {
  const repo = env('GITHUB_REPOSITORY');

  // Printed first, before anything can fail, so that every run -- including one
  // that ends undetermined -- says exactly which checks it holds itself
  // responsible for and which it does not. The limits travel with the result
  // rather than living in a document the reader of the result may never open,
  // and `web/tests/workflows/aggregate-checks.test.ts` reads this line to
  // compare the triggers below against the committed workflows they copy.
  console.log(`${CONFIGURATION_MARKER}${JSON.stringify({ watched: WATCHED, excluded: EXCLUDED })}`);

  if (repo === null) throw new Undetermined('GITHUB_REPOSITORY is not set');

  // Before the deadline is computed, because an event with no inputs has
  // nothing to wait for.
  const { eventName, headSha, readChangedPaths } = resolveEvent();

  const deadline = Date.now() + timeoutMs();

  let changed;
  try {
    changed = await readChangedPaths(repo);
  } catch (error) {
    // An expectation set that could not be computed is the one input whose
    // absence turns a missing check into a false pass, so it ends the run
    // rather than defaulting to anything.
    if (error instanceof Undetermined) throw error;
    throw new Undetermined(`could not read the changed-file list: ${error.message}`);
  }

  const expectedChecks = new Set(
    WATCHED.filter((entry) => isExpected(entry, eventName, changed)).flatMap((entry) => entry.checks),
  );

  const started = Date.now();
  let runsByName = new Map();
  let failures = 0;

  for (;;) {
    try {
      runsByName = await checkRuns(repo, headSha);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_API_FAILURES) {
        throw new Undetermined(`the checks API failed ${failures} times in a row: ${error.message}`);
      }
      console.log(`Checks API failed (${failures}): ${error.message}`);
    }

    const pending = pendingChecks(runsByName);
    const absent = absentChecks(runsByName);
    const missing = absent.filter((check) => expectedChecks.has(check));
    const settled = Date.now() - started >= SETTLE_MS;

    if (failures === 0 && pending.length === 0 && missing.length === 0 && (absent.length === 0 || settled)) {
      break;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const why = [
        pending.length > 0 ? `still running: ${pending.join(', ')}` : null,
        missing.length > 0 ? `expected and never reported: ${missing.join(', ')}` : null,
        failures > 0 ? 'the checks API is not answering' : null,
      ].filter((part) => part !== null);

      throw new Undetermined(
        `gave up waiting after ${Math.round(timeoutMs() / 1000)}s (${why.join('; ') || 'not settled'})`,
      );
    }

    await sleep(Math.min(POLL_MS, remaining));
  }

  const verdicts = classify(expectedChecks, runsByName, eventName);
  const failed = verdicts.filter((verdict) => !verdict.passed);

  const lines = [
    `Event: ${eventName}`,
    `Head commit: ${headSha}`,
    `Changed files: ${changed.length}`,
    '',
    'Watched checks:',
    ...verdicts.map((verdict) => `  ${verdict.passed ? 'PASS' : 'FAIL'}  ${verdict.check}: ${verdict.detail}`),
    '',
    'Not watched, deliberately:',
    ...EXCLUDED.map((entry) => `  ${entry.check}: ${entry.why}`),
    '',
    failed.length === 0
      ? 'Every watched check passed, was skipped, or was never triggered.'
      : `${failed.length === 1 ? 'A watched check' : `${failed.length} watched checks`} did not pass: `
        + failed.map((verdict) => verdict.check).join(', '),
  ];

  report(lines);
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const undetermined = error instanceof Undetermined;
  console.error(
    undetermined
      ? `aggregate-checks could not determine an answer: ${error.message}`
      : `aggregate-checks failed unexpectedly: ${error.stack ?? error.message}`,
  );
  console.error('That is not a pass. Re-run this check once the cause is understood.');
  process.exitCode = 2;
}
