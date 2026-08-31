import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { scopeStepRunner } from './scope-step';

// Workflow-shape assertions for `.github/workflows/web-e2e.yml`, following the
// pattern the files beside this one already use: parse the committed YAML and
// assert the properties that prose would otherwise only claim.
//
// The file exists for #691. `web-e2e` is a required check whose every step is
// gated on one scope output, and until now nothing under `web/` read this
// workflow at all -- so the decision that gates the browser suite was the only
// scope step in the repository with no test of any kind.
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

function steps(owner: YamlMapping, label: string): YamlMapping[] {
  return sequence(owner.steps, `${label}.steps`).map((step, index) =>
    mapping(step, `${label}.steps[${index}]`),
  );
}

const source = readFileSync(
  new URL('../../../.github/workflows/web-e2e.yml', import.meta.url),
  'utf8',
);
const workflow = mapping(parse(source), 'web-e2e.yml');
const e2eJob = mapping(mapping(workflow.jobs, 'jobs')['web-e2e'], 'jobs.web-e2e');

// Throws when no step carries the id, so a rename reddens this file by name
// rather than leaving the assertions below to exercise an empty script.
const scopeStep = steps(e2eJob, 'jobs.web-e2e').find((step) => step.id === 'scope');
const scopeScript = String(mapping(scopeStep ?? null, 'the step with id "scope"').run);

/**
 * The pattern the workflow actually greps the changed-file list with, pulled out
 * of the committed script rather than restated here, so these assertions cover
 * the shipped behaviour and not a copy of it. The ERE the workflow uses is also
 * a valid JavaScript regular expression.
 */
const pattern = scopeScript.match(/grep -Eq '([^']+)'/)?.[1];
const matchesPath = new RegExp(pattern ?? '(?!)');

describe('web-e2e.yml reports a conclusion on every pull request', () => {
  // The reason the scope decision lives inside the job at all. A trigger path
  // filter is all-or-nothing: a pull request touching no web/ file would report
  // no check, and a check that never reports leaves a pull request that requires
  // it pending forever (#80).
  it('carries no trigger-level path filter', () => {
    const triggers = mapping(workflow.on, 'on');

    expect(Object.keys(triggers)).toContain('pull_request');
    expect(triggers.pull_request).toBeNull();
  });

  it('keeps the reported check name stable and matrix-free', () => {
    // A required status check is matched by job name. Renaming either the job id
    // or its name silently orphans any branch protection rule referencing it.
    expect(e2eJob.name).toBe('web-e2e');
    expect(e2eJob.strategy).toBeUndefined();
  });

  it('holds no write scope and keeps no credentials in the checkout', () => {
    expect(mapping(workflow.permissions, 'permissions')).toEqual({ contents: 'read' });

    const checkout = steps(e2eJob, 'jobs.web-e2e').find((step) =>
      String(step.uses ?? '').startsWith('actions/checkout'),
    );

    expect(mapping(mapping(checkout ?? null, 'checkout').with, 'checkout.with')['persist-credentials']).toBe(false);
  });
});

describe('web-e2e.yml scope detection', () => {
  it('greps with a single-quoted ERE, so the pattern can be read out of the script', () => {
    expect(pattern, 'jobs.web-e2e must grep with a single-quoted ERE').toBeDefined();
  });

  it('runs the browser suite for a change under web/', () => {
    expect(matchesPath.test('web/src/pages/index.astro')).toBe(true);
    expect(matchesPath.test('web/tests/e2e/lineage.spec.ts')).toBe(true);
  });

  it('runs the browser suite when this workflow itself changes', () => {
    // A change to the workflow is verified by the workflow it changes.
    expect(matchesPath.test('.github/workflows/web-e2e.yml')).toBe(true);
  });

  it('leaves the suite alone for a change no browser could observe', () => {
    // The other half of a scope filter. Without these it could be widened to
    // everything and still look correct.
    expect(matchesPath.test('docs/product/BACKLOG.md')).toBe(false);
    expect(matchesPath.test('tools/updater/profiles/openai.json')).toBe(false);
  });

  it('anchors the pattern, so a path merely containing web/ does not match', () => {
    expect(matchesPath.test('docs/web/notes.md')).toBe(false);
  });
});

// #691, the same defect #609 fixed in web-ci.yml. `grep` exits 0 on a match, 1
// on no match and 2 on an error, and this step used to truth-test it with `if`,
// which collapses 1 and 2 into one branch. A matcher that could not run
// therefore reported "nothing matched": every step below it is gated on
// `steps.scope.outputs.run == 'true'`, so the browser suite skipped and
// `web-e2e` -- a required check on main -- reported green over a commit it never
// exercised. The diff guard above it already refuses that trade and runs.
//
// These assertions run the committed script through a real bash rather than
// reading its text, because the defect lives in what the shell *does* with an
// exit code and no substring check can see that. Statuses 0 and 1 come from the
// real `grep` against the real committed ERE; 2 and 127 are injected, because
// the committed ERE is well-formed and a here-string cannot fail to be read.
// That a malformed ERE really does exit 2 while a clean miss exits 1 is measured
// in `web-ci.test.ts`, which shares this suite; it is a fact about `grep` rather
// than about this workflow.
describe('web-e2e.yml scope detection tells a broken matcher from a clean miss', () => {
  const runner = scopeStepRunner(scopeScript, {
    GITHUB_EVENT_NAME: 'pull_request',
    PR_BASE_SHA: 'a1b2c3d',
    PR_HEAD_SHA: 'e4f5a6b',
    PUSH_BEFORE_SHA: 'c7d8e9f',
    GITHUB_SHA: 'e4f5a6b',
  });

  afterAll(() => {
    runner.cleanup();
  });

  it('extracts the step under test, so a mis-read cannot pass as a green run', () => {
    // Guards every assertion below: an empty or wrong script would otherwise run
    // clean and prove nothing at all.
    expect(scopeStep, 'jobs.web-e2e must have a step with id `scope`').toBeDefined();
    expect(scopeScript).toContain('grep -Eq');
    expect(scopeScript).toContain('GITHUB_OUTPUT');
  });

  it('runs the suite when the matcher finds a web path', () => {
    const outcome = runner.run('web/src/pages/index.astro\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
  });

  // The over-broad direction, which the fix must not reach for. A step that
  // always runs satisfies "never skip on an error" while destroying the scope
  // filter and putting a browser download on every unrelated pull request.
  // `not.toContain` is the half that catches it.
  it('still skips when the matcher runs and no web file changed', () => {
    const outcome = runner.run('docs/product/BACKLOG.md\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=false');
    expect(outcome.githubOutput ?? '').not.toContain('run=true');
  });

  // The regression this block exists for. Reverting the fix leaves the two cases
  // above green and turns these red.
  //
  // 2 is grep's own "an error occurred"; 127 is the shell's "command not found",
  // which is how a `grep` missing from the runner image would present. Neither
  // is a statement about the changed-file list, so neither may decide to skip.
  it.each([[2], [127]])('runs the suite rather than skipping when the matcher exits %i', (grepExit) => {
    const outcome = runner.run('docs/product/BACKLOG.md\n', grepExit);

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
  });

  it('names the status it could not interpret, so a runner log says what happened', () => {
    const outcome = runner.run('docs/product/BACKLOG.md\n', 2);

    expect(outcome.stdout).toContain('grep exited 2');
  });
});
