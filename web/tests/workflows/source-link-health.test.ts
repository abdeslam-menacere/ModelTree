import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
    expect(String(issueJob.if ?? '')).toContain("needs.source-link-health.outputs.actionable != '0'");
    expect(String(issueJob.if ?? '')).toContain("needs.source-link-health.outputs.ran == 'true'");
  });

  it('resolves the alert only when a sweep actually ran and found nothing', () => {
    // `ran == 'true'` is load-bearing: a skipped check produces an empty
    // actionable count, and closing an alert because nothing was checked would
    // report a recovery that never happened.
    expect(String(resolveJob.if ?? '')).toContain("needs.source-link-health.outputs.actionable == '0'");
    expect(String(resolveJob.if ?? '')).toContain("needs.source-link-health.outputs.ran == 'true'");
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

    expect(String(scope?.run)).toContain('web/src/data/sources\\.json');
    expect(String(scope?.run)).toContain('\\.github/scripts/source-link-health/');
    // A change to this workflow is verified by the workflow it changes.
    expect(String(scope?.run)).toContain('\\.github/workflows/source-link-health\\.yml');
  });

  it('narrows a pull request run to the URLs that pull request introduced', () => {
    // Without the baseline the check would sweep every external URL on every
    // data change and start flaking on sources nobody touched.
    expect(checkScript).toContain('--baseline');
    expect(checkScript).toContain('git show "$PR_BASE_SHA:web/src/data/sources.json"');
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
