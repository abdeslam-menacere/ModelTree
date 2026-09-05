import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { scopeStepRunner } from './scope-step';

// Workflow-shape assertions for `.github/workflows/source-link-health.yml`,
// following the pattern the three files beside this one already use: parse the
// committed YAML and assert the properties that prose would otherwise only
// claim.
//
// Two of those properties are the ones issue #29 asks to be machine-checked --
// that the workflow parses at all, and that its permissions are least privilege.
// The third is this repository's own hard-won rule: a check that never reports a
// conclusion blocks a pull request forever, so both jobs must conclude on every
// event.
//
// The fourth is specific to this workflow and matters more than the rest. It
// files a maintenance issue, and a guard that let a pull request run reach that
// code would put noise into the live tracker from any branch. The guard is
// asserted here rather than trusted.
//
// Every assertion below reads the committed workflow. None reads the dataset, so
// a data refresh cannot redden this file.

type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping;

interface YamlMapping {
  [key: string]: YamlValue;
}

function mapping(value: YamlValue, label: string): YamlMapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a mapping, found ${JSON.stringify(value)}`);
  }

  return value;
}

function sequence(value: YamlValue, label: string): YamlValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a sequence, found ${JSON.stringify(value)}`);
  }

  return value;
}

function job(document: YamlMapping, id: string): YamlMapping {
  return mapping(mapping(document.jobs, 'jobs')[id], `jobs.${id}`);
}

function steps(owner: YamlMapping, label: string): YamlMapping[] {
  return sequence(owner.steps, `${label}.steps`).map((step, index) =>
    mapping(step, `${label}.steps[${index}]`),
  );
}

const WORKFLOW_PATH = '../../../.github/workflows/source-link-health.yml';
const source = readFileSync(new URL(WORKFLOW_PATH, import.meta.url), 'utf8');
const workflow = mapping(parse(source), 'source-link-health.yml');

const jobIds = Object.keys(mapping(workflow.jobs, 'jobs'));
const testsJob = job(workflow, 'source-link-health-tests');
const checkJob = job(workflow, 'source-link-health');
const issueJob = job(workflow, 'maintenance-issue');
const resolveJob = job(workflow, 'resolve-issue');

describe('source-link-health.yml parses and is wired to the right events', () => {
  it('is valid YAML with the four jobs the design describes', () => {
    expect(jobIds).toEqual(['source-link-health-tests', 'source-link-health', 'maintenance-issue', 'resolve-issue']);
  });

  it('sweeps on a schedule, which is what catches rot nobody is currently editing', () => {
    const schedule = sequence(mapping(workflow.on, 'on').schedule, 'on.schedule');

    expect(schedule.length).toBeGreaterThan(0);
    expect(String(mapping(schedule[0], 'on.schedule[0]').cron)).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
  });

  it('also runs on pull requests, so a source added with a dead URL is caught before it lands', () => {
    expect(Object.keys(mapping(workflow.on, 'on'))).toContain('pull_request');
  });

  it('is not filtered by on.pull_request.paths, because a filtered check can report nothing at all', () => {
    // The trap this repository has already documented twice: a trigger path
    // filter is all-or-nothing, so a pull request matching none of the paths
    // gets no check rather than a green one. Both jobs decide their own scope
    // inside the job instead.
    const pullRequest = mapping(workflow.on, 'on').pull_request;

    expect(pullRequest === null || Object.keys(mapping(pullRequest, 'on.pull_request')).length === 0).toBe(true);
  });

  it('can be run by hand, with filing an issue off by default', () => {
    const dispatch = mapping(mapping(workflow.on, 'on').workflow_dispatch, 'on.workflow_dispatch');
    const fileIssue = mapping(mapping(dispatch.inputs, 'inputs').file_issue, 'inputs.file_issue');

    expect(fileIssue.type).toBe('boolean');
    // Off by default is the difference between a manual run being safe to try
    // and a manual run filing into the live tracker.
    expect(fileIssue.default).toBe(false);
  });

  it('cancels superseded pull request runs but never a scheduled sweep', () => {
    const concurrency = mapping(workflow.concurrency, 'concurrency');

    expect(String(concurrency.group)).toContain('github.workflow');
    expect(String(concurrency['cancel-in-progress'])).toContain("github.event_name == 'pull_request'");
  });
});

describe('source-link-health.yml permissions are least privilege', () => {
  it('grants nothing at the top, so a job that declares no scope gets none', () => {
    expect(mapping(workflow.permissions, 'permissions')).toEqual({});
  });

  it('gives the hermetic test job no scope at all', () => {
    // It reads the checkout the runner already made and talks to nothing.
    expect(testsJob.permissions).toBeUndefined();
  });

  it('gives the checking job read access to repository contents and nothing else', () => {
    expect(mapping(checkJob.permissions, 'jobs.source-link-health.permissions')).toEqual({ contents: 'read' });
  });

  it('gives each issue job issues:write and nothing else', () => {
    expect(mapping(issueJob.permissions, 'jobs.maintenance-issue.permissions')).toEqual({ issues: 'write' });
    expect(mapping(resolveJob.permissions, 'jobs.resolve-issue.permissions')).toEqual({ issues: 'write' });
  });

  it('never grants write access to repository contents anywhere', () => {
    // The dataset is not this workflow's to change. `lastCheckedDate` is a claim
    // that a human verified a source, and no token here can write one.
    for (const id of jobIds) {
      const permissions = job(workflow, id).permissions;
      if (permissions === undefined) continue;

      const declared = mapping(permissions, `jobs.${id}.permissions`);
      expect(declared.contents ?? 'read').toBe('read');

      // `issues` is the only write scope this workflow may ever hold, and only
      // the two jobs that maintain the alert hold it. Anything else appearing
      // here is a widening that should be argued for rather than absorbed.
      for (const [scope, level] of Object.entries(declared)) {
        if (level !== 'write') continue;
        expect(scope, `jobs.${id} must not hold ${scope}: write`).toBe('issues');
      }
    }
  });

  it('keeps the checkout credential-free, because no job here pushes', () => {
    for (const owner of [
      { id: 'source-link-health-tests', value: testsJob },
      { id: 'source-link-health', value: checkJob },
    ]) {
      const checkout = steps(owner.value, `jobs.${owner.id}`).find((step) =>
        String(step.uses ?? '').startsWith('actions/checkout@'),
      );

      expect(mapping(checkout?.with ?? null, `${owner.id} checkout.with`)['persist-credentials']).toBe(false);
    }
  });

  it('pins every action to a version rather than tracking a moving branch', () => {
    for (const id of jobIds) {
      for (const step of sequence(job(workflow, id).steps, `jobs.${id}.steps`)) {
        const uses = mapping(step, `jobs.${id} step`).uses;
        if (uses === undefined) continue;
        expect(String(uses), `${String(uses)} must carry a version`).toMatch(/@v\d[\w.-]*$/);
      }
    }
  });
});

describe('source-link-health.yml always reports a conclusion', () => {
  // A required check that never reports leaves a pull request pending forever.
  // This workflow is advisory and must not be required, but a check that hangs
  // as "expected" is confusing whether or not it blocks, and the fix is the same
  // one `web-ci` and `skills-ci` use.
  it.each([
    ['source-link-health-tests', testsJob],
    ['source-link-health', checkJob],
  ])('%s decides its own scope and records the skip', (id, value) => {
    const stepList = steps(value, `jobs.${id}`);
    const scope = stepList.find((step) => step.id === 'scope');

    expect(scope, `jobs.${id} must have a scope step`).toBeDefined();

    const recorded = stepList.filter((step) => String(step.if ?? '').includes("steps.scope.outputs.run != 'true'"));

    expect(recorded.length, `jobs.${id} must record a conclusion when it skips`).toBe(1);
    expect(String(recorded[0].run)).toContain('GITHUB_STEP_SUMMARY');
  });

  it('keeps the reported check names stable and matrix-free', () => {
    // A required status check is matched by job name. Neither of these is
    // required today, and both should still be stable: renaming one silently
    // orphans any rule that ever comes to reference it.
    expect(testsJob.name).toBe('source-link-health-tests');
    expect(checkJob.name).toBe('source-link-health');
    expect(testsJob.strategy).toBeUndefined();
    expect(checkJob.strategy).toBeUndefined();
  });

  it('bounds both jobs with a timeout, so neither can hang on an unresponsive host', () => {
    expect(Number(testsJob['timeout-minutes'])).toBeGreaterThan(0);
    expect(Number(checkJob['timeout-minutes'])).toBeGreaterThan(0);
  });
});

describe('source-link-health.yml cannot file an issue from a pull request', () => {
  // The guard that keeps development and testing out of the live tracker.
  it.each([
    ['maintenance-issue', issueJob],
    ['resolve-issue', resolveJob],
  ])('%s runs only on a schedule or an explicit manual opt-in', (id, value) => {
    const guard = String(value.if ?? '');

    expect(guard, `jobs.${id} must be guarded`).not.toBe('');
    expect(guard).toContain("github.event_name == 'schedule'");
    expect(guard).toContain("github.event_name == 'workflow_dispatch' && inputs.file_issue");
    expect(guard).not.toContain('pull_request');
  });

  it.each([
    ['maintenance-issue', issueJob],
    ['resolve-issue', resolveJob],
  ])('%s runs only in this repository, so a fork files nothing here', (id, value) => {
    expect(String(value.if ?? ''), `jobs.${id} must be repository-guarded`).toMatch(
      /github\.repository == '[^/']+\/[^/']+'/,
    );
  });

  it('opens the issue only when there is something a person can act on', () => {
    // `clean != 'true'` rather than a URL count: the checker exits 1 both for an
    // actionable URL and for a source record whose URL cannot be requested at
    // all, and only the first reaches `.actionableUrls`.
    expect(String(issueJob.if ?? '')).toContain("needs.source-link-health.outputs.clean != 'true'");
    expect(String(issueJob.if ?? '')).toContain("needs.source-link-health.outputs.ran == 'true'");
  });

  it('resolves the alert only when a sweep actually ran and found nothing', () => {
    // `ran == 'true'` is load-bearing: a skipped check produces an empty
    // actionable count, and closing an alert because nothing was checked would
    // report a recovery that never happened.
    //
    // `clean == 'true'` is load-bearing for a second reason. Closing is the one
    // action here that destroys information, so it answers to the checker's own
    // exit 0 and not to `actionable == '0'`, which is a different question: a
    // sweep whose only finding is a malformed source record reports zero
    // actionable *URLs* while the checker is saying it found something. Gated on
    // the count, that sweep closed the standing alert and posted an all-clear
    // over its own finding (#632).
    expect(String(resolveJob.if ?? '')).toContain("needs.source-link-health.outputs.clean == 'true'");
    expect(String(resolveJob.if ?? '')).toContain("needs.source-link-health.outputs.ran == 'true'");
    expect(
      String(resolveJob.if ?? ''),
      'closing must not be gated on the URL count, which is zero for a malformed-record finding',
    ).not.toContain('outputs.actionable');
  });

  it('makes the two issue jobs exact complements, so no sweep leaves the alert unanswered', () => {
    // One question, asked once, in two directions. If these ever key on
    // different facts, a sweep can fall into the gap between them -- opening
    // nothing and closing nothing -- or into the overlap, doing both.
    expect(String(issueJob.if ?? '')).toContain("outputs.clean != 'true'");
    expect(String(resolveJob.if ?? '')).toContain("outputs.clean == 'true'");
  });

  it('files and closes under one title defined once, so the two cannot drift apart', () => {
    const title = mapping(workflow.env, 'env').LINK_HEALTH_ISSUE_TITLE;

    expect(typeof title).toBe('string');
    expect(String(title).length).toBeGreaterThan(0);

    for (const value of [issueJob, resolveJob]) {
      const script = steps(value, 'issue job')
        .map((step) => String(step.run ?? ''))
        .join('\n');

      expect(script).toContain('$LINK_HEALTH_ISSUE_TITLE');
      // The exact-title match after the search, the way pages.yml does it: a
      // looser rule would act on whatever the search happened to return.
      expect(script).toContain('map(select(.title == $t))');
    }
  });

  it('never checks out the repository in a job that can write issues', () => {
    for (const value of [issueJob, resolveJob]) {
      for (const step of steps(value, 'issue job')) {
        expect(String(step.uses ?? '')).not.toContain('actions/checkout');
      }
    }
  });
});

describe('source-link-health.yml runs the checker the way it is meant to be run', () => {
  const testScript = steps(testsJob, 'jobs.source-link-health-tests')
    .map((step) => String(step.run ?? ''))
    .join('\n');
  const checkScript = steps(checkJob, 'jobs.source-link-health')
    .map((step) => String(step.run ?? ''))
    .join('\n');

  it('runs the checker tests with node --test against the file, not the directory', () => {
    // `node --test <directory>` resolves differently and finds nothing.
    expect(testScript).toContain('node --test .github/scripts/source-link-health/link-health.test.mjs');
  });

  it('dry-runs extraction over the seed dataset, which issue #29 asks for by name', () => {
    expect(testScript).toContain('check-source-links.mjs --dry-run');
  });

  it('watches the source records, so a new record cannot slip past the tests', () => {
    const scope = steps(testsJob, 'jobs.source-link-health-tests').find((step) => step.id === 'scope');

    expect(String(scope?.run)).toContain('web/src/data/(sources|releases)\\.json');
    expect(String(scope?.run)).toContain('\\.github/scripts/source-link-health/');
    // A change to this workflow is verified by the workflow it changes.
    expect(String(scope?.run)).toContain('\\.github/workflows/source-link-health\\.yml');
  });

  it('watches the release records too, because a licence URL lives there and nowhere else', () => {
    // #931. The dry run below is the only thing that catches a `license.url`
    // that cannot be turned into a request at all, and a pull request that
    // edits `releases.json` alone would not otherwise run it.
    const scope = String(
      steps(testsJob, 'jobs.source-link-health-tests').find((step) => step.id === 'scope')?.run,
    );

    // Assert the alternation admits each name, not merely that both strings
    // appear somewhere in the script: a comment naming `releases.json` would
    // satisfy a bare `toContain` while the grep still ignored the file.
    const pattern = /grep -Eq '(\^\([^']+)'/.exec(scope)?.[1];
    if (pattern === undefined) throw new Error('no scope grep found');

    const matcher = new RegExp(pattern);
    expect(matcher.test('web/src/data/releases.json')).toBe(true);
    expect(matcher.test('web/src/data/sources.json')).toBe(true);
    // The negative control: a neighbouring data file the suite does not read.
    expect(matcher.test('web/src/data/families.json')).toBe(false);
  });

  it('narrows a pull request run to the URLs that pull request introduced', () => {
    // Without the baseline the check would sweep every external URL on every
    // data change and start flaking on sources nobody touched.
    expect(checkScript).toContain('--baseline');
    expect(checkScript).toContain('git show "$PR_BASE_SHA:web/src/data/sources.json"');
  });

  it('leaves the networked pull request job keyed on the source records alone', () => {
    // ADR 0017. The licence sweep is scheduled-only, so a pull request that
    // touches `releases.json` must not start requesting licence URLs: the
    // defect that sweep exists to catch is upstream decay, which no
    // diff-scoped run can see. Widening this grep would be the bypass.
    const scope = String(steps(checkJob, 'jobs.source-link-health').find((step) => step.id === 'scope')?.run);

    // Read the grep, not the prose around it. The step's own comment names
    // `releases.json` to explain why it is excluded, so a textual assertion
    // here would fail on the very sentence that documents the rule.
    const greps = [...scope.matchAll(/^\s*grep -[A-Za-z]*\s+'([^']+)'/gm)].map((match) => match[1]);

    expect(greps).toEqual(['web/src/data/sources.json']);
  });

  it('treats a checker that cannot run as a failure rather than a clean sweep', () => {
    // Exit 1 is "found something"; exit 2 is "the tool is broken". Collapsing
    // the two would let a crashed checker report an empty finding set.
    expect(checkScript).toContain('if [ "$code" -ge 2 ]');
  });

  it('publishes the report rather than leaving it in the log', () => {
    expect(checkScript).toContain('GITHUB_STEP_SUMMARY');
    expect(checkScript).toContain('--report');
    expect(checkScript).toContain('--json');
  });

  it('never passes the checker a flag that would let it check something easier', () => {
    for (const flag of ['--data', '--exclusions', '--today', '--skip', '--force']) {
      expect(checkScript).not.toContain(flag);
      expect(testScript).not.toContain(flag);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The checking step, executed rather than read                               */
/* -------------------------------------------------------------------------- */

// Everything above asserts the shape of the workflow. This block runs one step
// of it, because the defect in #632 was invisible to every assertion that reads
// the file: the script said `set -uo pipefail` under a comment claiming that
// left `-e` off, and it does not -- `set -uo` enables `u` and `pipefail` and
// disables nothing, while the runner has already supplied `-e` through
// `bash --noprofile --norc -e -o pipefail {0}`. So the checker's documented
// exit 1, "found something actionable", aborted the step at the `node` call
// before the exit code could be captured. No outputs, no job summary, no
// artefact, and both issue jobs skipped -- on exactly the runs that had
// something to report. The machinery was exercised only when it had nothing to
// do, which is why it looked healthy.
//
// Running the step rather than reading it also showed the damage was wider than
// the shape suggested: the exit-2 branch, the one that tells a broken checker
// apart from a rotted link, never executed either. That case still failed,
// because `-e` propagated the status, so it *looked* preserved -- but its
// `::error::` was never printed, and a maintainer reading the run could not tell
// "the checker is broken" from "a source is gone". Both are covered below, and
// the second is the case a fix must not quietly collapse into the first.
//
// A text assertion could have caught that particular spelling and nothing else.
// These tests take the step's own `run:` script out of the committed YAML and
// execute it under the runner's exact shell invocation, so what is verified is
// the behaviour rather than the wording -- and any other correct fix, such as
// bracketing the call in `set +e` / `set -e`, passes them just as well.
//
// The step's two external collaborators are replaced by shell *functions*
// defined ahead of the script. A function is found before PATH, so this needs
// neither a `node` stub file nor a real `jq`, and needs no PATH manipulation --
// which on Windows would have to survive MSYS's rewriting of that one variable.
// It is the same hermeticity the checker's own suite gets by injecting `fetch`
// and `sleep`: the collaborators are stubbed, the subject is not. The script
// itself is used verbatim.

const checkStep = steps(checkJob, 'jobs.source-link-health').find((step) => step.id === 'check');

// `.gitattributes` pins the working tree to LF, but 75 blobs are still stored
// with CRLF and a checkout elsewhere could carry one. A stray CR would make
// bash fail on `$'\r': command not found`, which reads as an unrelated defect.
const checkStepScript = String(checkStep?.run ?? '').replace(/\r\n/g, '\n');

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

interface StepOutcome {
  /** The step's exit status. 0 is what GitHub reads as a successful step. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** `$GITHUB_OUTPUT` as written, or null when the step never wrote it. */
  githubOutput: string | null;
  /** `$GITHUB_STEP_SUMMARY` as written, or null when the step never wrote it. */
  stepSummary: string | null;
}

/** The fields of the sweep's JSON that the step's outputs are derived from. */
interface CheckerJson {
  /** `.actionableUrls`: URLs found definitively broken or permanently moved. */
  actionableUrls?: number;
  /** `.malformedRecords`: records whose URL could not be requested at all. */
  malformedRecords?: number;
}

/**
 * Run the `check` step's script the way the runner would, with a checker that
 * exits `checkerExit` after writing `json`.
 *
 * The exit code and the JSON are set independently on purpose. They are two
 * different channels and the whole of #632's second defect was assuming they
 * agree: the checker exits 1 when `actionableUrls` is 0 but a source record is
 * malformed, and a harness that could not express that combination could not
 * catch it.
 */
function runCheckStep(checkerExit: number, json: CheckerJson = {}): StepOutcome {
  const actionableUrls = json.actionableUrls ?? 3;
  const malformedRecords = json.malformedRecords ?? 0;

  const directory = mkdtempSync(join(tmpdir(), 'source-link-health-'));
  temporaryDirectories.push(directory);

  const stubs = `
node() {
  printf '# link health report\\n' > "$RUNNER_TEMP/link-health.md"
  printf '{"actionableUrls":${actionableUrls},"malformedRecords":${malformedRecords}}\\n' > "$RUNNER_TEMP/link-health.json"
  return ${checkerExit}
}

jq() {
  case "$*" in
    *actionableUrls*) printf '${actionableUrls}\\n' ;;
    *malformedRecords*) printf '${malformedRecords}\\n' ;;
    *findings*) printf '[{"url":"https://example.invalid/"}]\\n' ;;
    *) printf 'unstubbed jq filter: %s\\n' "$*" >&2 ; return 1 ;;
  esac
}
`;

  writeFileSync(join(directory, 'step.sh'), `${stubs}\n${checkStepScript}\n`, 'utf8');

  const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', 'step.sh'], {
    // `cwd` here and `RUNNER_TEMP=.` below are load-bearing on Windows: an
    // absolute path such as `C:\Users\...` inside a bash double-quoted string
    // has its backslashes eaten as escapes. Relative paths have none.
    cwd: directory,
    env: {
      ...process.env,
      RUNNER_TEMP: '.',
      GITHUB_OUTPUT: './github-output',
      GITHUB_STEP_SUMMARY: './step-summary',
      // Empty is the scheduled sweep: no `--baseline`, so the whole dataset.
      BASELINE: '',
    },
    encoding: 'utf8',
  });

  if (run.error !== undefined) {
    // Never a skip. A test that did not run is not a test that passed, and the
    // shell semantics this file exists to pin are exactly what CI would stop
    // checking. `bash` is present on `ubuntu-latest`, where these run in CI, and
    // ships with Git for Windows.
    throw new Error(`could not run bash, which these tests require: ${run.error.message}`);
  }

  const readIfWritten = (name: string): string | null =>
    existsSync(join(directory, name)) ? readFileSync(join(directory, name), 'utf8') : null;

  return {
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    githubOutput: readIfWritten('github-output'),
    stepSummary: readIfWritten('step-summary'),
  };
}

describe('source-link-health.yml reports an actionable finding instead of aborting on it', () => {
  it('extracts the step under test, so a mis-read cannot pass as a green run', () => {
    // Guards every assertion below: an empty or wrong script would otherwise
    // run clean and prove nothing at all.
    expect(checkStep, 'the checking job must have a step with id `check`').toBeDefined();
    expect(checkStepScript).toContain('check-source-links.mjs');
    expect(checkStepScript).toContain('GITHUB_OUTPUT');
  });

  it('writes its outputs and its summary when the checker exits 1', () => {
    // Exit 1 is the checker's documented "ran, and found something actionable".
    // This is the case that produced nothing at all before #632.
    const outcome = runCheckStep(1);

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('ran=true');
    expect(outcome.githubOutput ?? '').toContain('actionable=3');
    expect(outcome.githubOutput ?? '').toContain('clean=false');
    expect(outcome.githubOutput ?? '').toContain('findings<<');
    // The report reaches the job summary, and the artefact step's `ran` gate is
    // satisfied, so the run that had something to say can say it.
    expect(outcome.stepSummary ?? '').toContain('link health report');
  });

  it('writes its outputs and its summary when the checker exits 0', () => {
    const outcome = runCheckStep(0, { actionableUrls: 0 });

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('ran=true');
    expect(outcome.githubOutput ?? '').toContain('clean=true');
    expect(outcome.stepSummary ?? '').toContain('link health report');
  });

  it('does not call a malformed-record finding clean, so the alert is never closed over it', () => {
    // The checker exits 1 for two reasons, and this is the second: a source
    // record whose URL cannot be turned into a request at all. `summarise()`
    // never counts those into `actionableUrls`, so this sweep reports zero
    // actionable URLs while the checker is saying it found something.
    //
    // Gated on that count, `resolve-issue` ran and *closed* the standing
    // maintenance issue, posting an all-clear over a finding the checker had
    // just raised -- strictly worse than the abort this fix replaced, which at
    // least said nothing. `clean` is derived from the exit code precisely so
    // this combination cannot read as a clean sweep.
    const outcome = runCheckStep(1, { actionableUrls: 0, malformedRecords: 1 });

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('ran=true');
    expect(outcome.githubOutput ?? '').toContain('actionable=0');
    expect(outcome.githubOutput ?? '').toContain('malformed=1');
    expect(
      outcome.githubOutput ?? '',
      'a sweep the checker flagged must never report clean=true, or resolve-issue closes the alert',
    ).toContain('clean=false');
  });

  it('keeps the two counts apart, so a whole-dataset defect cannot redden a pull request', () => {
    // `actionable` is a URL count and stays one. Malformed records are collected
    // by `extractTargets` over every record, before the baseline narrowing a
    // pull-request run depends on, so summing them into `actionable` would fail
    // every pull request for one pre-existing bad record it did not introduce.
    const outcome = runCheckStep(1, { actionableUrls: 0, malformedRecords: 4 });

    expect(outcome.githubOutput ?? '').toContain('actionable=0');
    expect(outcome.githubOutput ?? '').toContain('malformed=4');
  });

  it.each([[2], [3]])('fails loudly and reports nothing when the checker exits %i', (checkerExit) => {
    // "The checker could not run" must never read as a clean sweep. It is a
    // fault in the checker or its inputs rather than a finding about a source,
    // and collapsing it into exit 1 would let a crashed checker report an empty
    // finding set -- and, through `ran`, let the issue jobs act on it.
    const outcome = runCheckStep(checkerExit);

    expect(outcome.status).not.toBe(0);
    expect(outcome.stdout).toContain('::error::The link checker could not run');
    expect(outcome.githubOutput ?? '', 'a checker that could not run must set no outputs').not.toContain('ran=true');
    expect(
      outcome.githubOutput ?? '',
      'a checker that could not run must never report a clean sweep',
    ).not.toContain('clean=true');
    expect(outcome.stepSummary).toBeNull();
  });

  it('exposes clean and malformed as job outputs, so the issue jobs can read them', () => {
    // A guard `if:` reading an output the job never declares is silently empty,
    // which for `clean != 'true'` would open the issue on every sweep and for
    // `clean == 'true'` would close it on none.
    const outputs = mapping(checkJob.outputs, 'jobs.source-link-health.outputs');

    expect(String(outputs.clean)).toContain('steps.check.outputs.clean');
    expect(String(outputs.malformed)).toContain('steps.check.outputs.malformed');
    expect(String(outputs.ran)).toContain('steps.check.outputs.ran');
  });

  it('leaves the issue jobs gated on the sweep succeeding, with no always()', () => {
    // The design decision this fix records, asserted rather than remembered. A
    // finding is reported and the sweep still concludes green, so the two issue
    // jobs keep their implicit `success()` and need no `always()`. That is what
    // makes a checker which could not run skip both of them: it can neither
    // file a false alarm nor close a real one. Adding `always()` here would
    // have to rebuild that guard by hand.
    for (const [id, value] of [
      ['maintenance-issue', issueJob],
      ['resolve-issue', resolveJob],
    ] as const) {
      expect(String(value.if ?? ''), `jobs.${id} must not weaken its gate to always()`).not.toContain('always(');
    }
  });

  it('still fails a pull request for the URLs that pull request introduced', () => {
    // Advisory does not mean never red. It means never red for somebody else's
    // outage. A pull request owns the URLs it added, so this is the one place
    // the check fails -- and it runs after the outputs and the summary are
    // written, so failing there costs no reporting.
    const stepList = steps(checkJob, 'jobs.source-link-health');
    const reportStep = stepList.find((step) =>
      String(step.if ?? '').includes("steps.check.outputs.actionable != '0'"),
    );

    expect(reportStep, 'the pull-request report step must exist').toBeDefined();
    expect(String(reportStep?.if)).toContain("github.event_name == 'pull_request'");
    expect(String(reportStep?.run)).toContain('exit 1');
    // Keyed on the URL count and deliberately not on `malformed` or `clean`:
    // malformed records are whole-dataset, so either of those would redden a
    // pull request for a defect it did not introduce. The scheduled sweep's
    // maintenance issue is where those are reported.
    expect(
      String(reportStep?.if),
      'a pull request must not go red for a whole-dataset finding it did not introduce',
    ).not.toContain('malformed');
    expect(stepList.indexOf(reportStep as YamlMapping)).toBeGreaterThan(stepList.indexOf(checkStep as YamlMapping));
  });
});

// #691, the same defect #609 fixed in web-ci.yml, in both of this workflow's
// scope steps. `grep` exits 0 on a match, 1 on no match and 2 on an error, and
// both steps used to truth-test it -- one with `if`, one with `if !` -- which
// collapses 1 and 2 into a single branch. A matcher that could not run therefore
// read as "nothing matched" and the job skipped, reporting a conclusion over a
// change nothing had read.
//
// These assertions run the committed scripts through a real bash rather than
// reading their text, because the defect lives in what the shell *does* with an
// exit code and no substring check can see that. Statuses 0 and 1 come from the
// real `grep` against the real committed matcher; 2 and 127 are injected,
// because the committed patterns are well-formed and a here-string cannot fail
// to be read. That a malformed ERE really does exit 2 while a clean miss exits 1
// is measured in `web-ci.test.ts`, which shares this suite; it is a fact about
// `grep` rather than about this workflow.
describe('source-link-health.yml tests-job scope tells a broken matcher from a clean miss', () => {
  // `mapping` throws when no step carries the id, so a rename reddens this file
  // by name rather than leaving the assertions to exercise an empty script.
  const step = steps(testsJob, 'jobs.source-link-health-tests').find((candidate) => candidate.id === 'scope');
  const script = String(mapping(step ?? null, 'jobs.source-link-health-tests step "scope"').run);

  const runner = scopeStepRunner(script, {
    GITHUB_EVENT_NAME: 'pull_request',
    PR_BASE_SHA: 'a1b2c3d',
    PR_HEAD_SHA: 'e4f5a6b',
  });

  afterAll(() => {
    runner.cleanup();
  });

  it('extracts the step under test, so a mis-read cannot pass as a green run', () => {
    expect(step, 'jobs.source-link-health-tests must have a step with id `scope`').toBeDefined();
    expect(script).toContain('grep -Eq');
    expect(script).toContain('GITHUB_OUTPUT');
  });

  it('runs the tests when the matcher finds a checker input', () => {
    const outcome = runner.run('web/src/data/sources.json\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
  });

  // The over-broad direction, which the fix must not reach for. A step that
  // always runs satisfies "never skip on an error" while destroying the scope
  // filter this job exists to apply. `not.toContain` is the half that catches it.
  it('still skips when the matcher runs and no checker input changed', () => {
    const outcome = runner.run('docs/product/BACKLOG.md\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=false');
    expect(outcome.githubOutput ?? '').not.toContain('run=true');
  });

  // The regression this block exists for. Reverting the fix leaves the two cases
  // above green and turns these red. 2 is grep's own "an error occurred"; 127 is
  // the shell's "command not found", which is how a `grep` missing from the
  // runner image would present.
  it.each([[2], [127]])('runs the tests rather than skipping when the matcher exits %i', (grepExit) => {
    const outcome = runner.run('docs/product/BACKLOG.md\n', grepExit);

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
  });
});

// The fifth site named in #691, and the one a find-and-replace keyed on the
// positive form leaves standing: this matcher is negated, so `if ! grep` reads
// as a different shape while collapsing the same statuses. `!` inverts all
// three at once -- a match is 0 and falls through to the check, no match is 1
// and skips, an error is 2 and skips as well -- and only the middle one is a
// statement about the changed-file list.
//
// Routing the error to the checking path is cheap here, which is what makes it a
// different judgement from the diff guard immediately above it rather than a
// reversal of that guard. A failed diff points at an unusable base commit, which
// empties the baseline and turns every URL in the dataset into a "new" one; a
// failed match leaves both `$changed` and the base revision intact, so the
// baseline still narrows the run to the URLs the pull request introduced.
describe('source-link-health.yml link-check scope tells a broken matcher from a clean miss', () => {
  const step = steps(checkJob, 'jobs.source-link-health').find((candidate) => candidate.id === 'scope');
  const script = String(mapping(step ?? null, 'jobs.source-link-health step "scope"').run);

  const runner = scopeStepRunner(script, {
    GITHUB_EVENT_NAME: 'pull_request',
    PR_BASE_SHA: 'a1b2c3d',
    PR_HEAD_SHA: 'e4f5a6b',
  });

  afterAll(() => {
    runner.cleanup();
  });

  it('extracts the negated step under test, so a mis-read cannot pass as a green run', () => {
    expect(step, 'jobs.source-link-health must have a step with id `scope`').toBeDefined();
    // `-Fxq`, not `-Eq`. Asserted so this block cannot drift onto the positive
    // matcher in the other job and quietly test it twice.
    expect(script).toContain('grep -Fxq');
    expect(script).toContain('GITHUB_OUTPUT');
  });

  it('checks the new URLs when the source records are in the changed list', () => {
    const outcome = runner.run('web/src/data/sources.json\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
    // The baseline is what keeps a pull-request run from becoming a full sweep.
    expect(outcome.githubOutput ?? '').toContain('baseline=');
  });

  // The over-broad direction. This job reaches third-party hosts, so a scope
  // step that always ran would be worse than the bug it was fixing.
  it('still skips when the matcher runs and no source record changed', () => {
    const outcome = runner.run('docs/product/BACKLOG.md\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=false');
    expect(outcome.githubOutput ?? '').not.toContain('run=true');
  });

  it('matches the whole line, so a neighbouring path does not stand in for it', () => {
    // `-Fx` is a fixed whole-line match. This is the property that makes the
    // real `grep` the right thing to run here rather than a stub.
    const outcome = runner.run('web/src/data/sources.json.bak\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=false');
  });

  // The regression this block exists for, and the one the issue predicts will be
  // missed. Reverting the negated form leaves every case above green and turns
  // these red.
  it.each([[2], [127]])('checks rather than skipping when the negated matcher exits %i', (grepExit) => {
    const outcome = runner.run('docs/product/BACKLOG.md\n', grepExit);

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
    expect(outcome.stdout).toContain(`grep exited ${grepExit}`);
  });
});
