import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { scopeStepRunner } from './scope-step';

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

function stepNamed(owner: YamlMapping, label: string, name: string): YamlMapping {
  const step = steps(owner, label).find((candidate) => candidate.name === name);

  if (step === undefined) {
    throw new Error(`Expected a step named "${name}" in ${label}`);
  }

  return step;
}

const skillsCiSource = readFileSync(
  new URL('../../../.github/workflows/skills-ci.yml', import.meta.url),
  'utf8',
);
const skillsCi = mapping(parse(skillsCiSource), 'skills-ci.yml');
const skillsCiJob = mapping(mapping(skillsCi.jobs, 'jobs')['skills-ci'], 'jobs.skills-ci');
const skillsCiSteps = steps(skillsCiJob, 'jobs.skills-ci');
const workflowDocs = readFileSync(
  new URL('../../../.github/workflows/README.md', import.meta.url),
  'utf8',
);

/**
 * The gate script is the source of truth for what a dataset change is, so both
 * the directory it reads and the documents it loads are parsed out of it rather
 * than restated here. A new document, or a move of the data directory, has to
 * carry the workflow's scope decision with it or these assertions go red.
 */
const gateSource = readFileSync(
  new URL('../../../.github/skills/modeltree-gates/scripts/gate-dataset.mjs', import.meta.url),
  'utf8',
);
const gateDocuments = [...gateSource.matchAll(/'([a-z-]+\.json)'/g)].map((match) => match[1]);
const gateDataDirs = [...gateSource.matchAll(/join\(repoRoot\(\),\s*([^)]*)\)/g)].map((match) =>
  [...match[1].matchAll(/'([^']+)'/g)].map((segment) => segment[1]).join('/'),
);

const triggers = mapping(skillsCi.on, 'on');

const scopeStep = skillsCiSteps.find((step) => step.id === 'scope');
const scopeScript = String(mapping(scopeStep ?? null, 'the step with id "scope"').run);

/**
 * The pattern the workflow actually greps with, pulled out of the committed
 * script rather than restated here, so these assertions cover the shipped
 * behaviour and not a copy of it. The ERE the workflow uses is also a valid
 * JavaScript regular expression.
 */
const pattern = scopeScript.match(/grep -Eq '([^']+)'/)?.[1];
const matchesPath = new RegExp(pattern ?? '(?!)');

describe('skills-ci.yml reports on every pull request and on every push to main', () => {
  // The whole point of #294. A trigger path filter is all-or-nothing: a
  // non-matching pull request reports no check at all, and a required check
  // that never reports leaves that pull request pending forever. The filtering
  // moved inside the job, exactly as web-ci.yml already does it, so the check
  // always concludes.
  it('carries no trigger-level path filter', () => {
    expect(Object.keys(triggers)).toContain('pull_request');
    expect(triggers.pull_request).toBeNull();
  });

  it('can still be dispatched by hand', () => {
    expect(Object.keys(triggers)).toContain('workflow_dispatch');
  });

  // #639. The reported check only exists on a commit the workflow was triggered
  // for, so without this trigger a required `skills-ci` never ran on `main`: it
  // reported on the pull request, and nothing re-ran it on the merge commit.
  // With `strict` false two pull requests can be green against different bases
  // and merge into a combination neither was gated in, which is precisely the
  // case a `main` run is there to catch.
  //
  // Unfiltered by path for the same reason the `pull_request` trigger is: the
  // job decides for itself whether the gates have anything to read.
  it('also runs on pushes to main, so main carries the check by name', () => {
    expect(Object.keys(triggers)).toContain('push');

    const push = mapping(triggers.push, 'on.push');

    expect(sequence(push.branches, 'on.push.branches')).toEqual(['main']);
    expect(push.paths).toBeUndefined();
  });

  // What makes that trigger safe, and the reason the concurrency block needed no
  // change alongside it. Every commit on `main` is verified on its own, so a run
  // cancelled by the next push would leave a commit whose required check never
  // reported — the same absence the push trigger exists to remove.
  it('cancels a superseded pull request run, and never a main run', () => {
    const concurrency = mapping(skillsCi.concurrency, 'concurrency');

    expect(String(concurrency.group)).toContain('github.ref');
    expect(String(concurrency['cancel-in-progress'])).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  // Branch protection identifies a check by its job name, so a name that varies
  // per matrix leg or per run cannot be required.
  it('reports exactly one check, under a name that cannot vary per run', () => {
    expect(Object.keys(mapping(skillsCi.jobs, 'jobs'))).toEqual(['skills-ci']);
    expect(skillsCiJob.name).toBe('skills-ci');
    expect(String(skillsCiJob.name)).not.toContain('${{');
    expect(skillsCiJob.strategy).toBeUndefined();
  });

  // A job whose every step is skipped still concludes, but it concludes
  // silently. This step is what makes the skip legible on the pull request.
  it('records why it did nothing, rather than skipping every step in silence', () => {
    const idle = stepNamed(skillsCiJob, 'jobs.skills-ci', 'Record that no gate run was needed');

    expect(idle.if).toBe("steps.scope.outputs.run != 'true'");
    expect(String(idle.run)).toContain('GITHUB_STEP_SUMMARY');
  });
});

describe('skills-ci.yml scope detection', () => {
  it('greps for the paths that matter', () => {
    expect(pattern).toBeDefined();
  });

  it('diffs against the base commit, which shallow history would not contain', () => {
    const checkout = stepNamed(skillsCiJob, 'jobs.skills-ci', 'Check out repository');

    expect(mapping(checkout.with, 'checkout.with')['fetch-depth']).toBe(0);
    expect(scopeScript).toContain('git diff --name-only "$BASE_SHA...$HEAD_SHA"');
  });

  // The bug in #189: the workflow was scoped to the gates alone, so the step
  // that runs gate-dataset against the live dataset could never fire on the data
  // change it exists to catch. A pull request touching only web/src/data got
  // web-ci and nothing else.
  it('runs the gates for a change to the dataset they gate', () => {
    expect(matchesPath.test('web/src/data/releases.json')).toBe(true);
    expect(matchesPath.test('web/src/data/sources.json')).toBe(true);
  });

  // The scope decision is only as good as its coverage of what the gate reads.
  // Every document the script loads, at the directory the script resolves, must
  // be inside it, or the hole simply moves.
  it('covers every dataset document the gate actually loads', () => {
    expect(gateDocuments.length).toBeGreaterThan(0);
    expect(gateDataDirs, 'gate-dataset.mjs must resolve exactly one data directory').toEqual([
      'web/src/data',
    ]);

    for (const document of gateDocuments) {
      expect(
        matchesPath.test(`${gateDataDirs[0]}/${document}`),
        `${document} must put skills-ci in scope`,
      ).toBe(true);
    }
  });

  it('runs the gates for a change to the gates themselves, and to their checker', () => {
    expect(matchesPath.test('.github/skills/modeltree-gates/scripts/gate-dataset.mjs')).toBe(true);
    expect(matchesPath.test('.github/skills/modeltree-gates/SKILL.md')).toBe(true);
    expect(matchesPath.test('.github/scripts/check-skill-doc-test-counts.mjs')).toBe(true);
  });

  it('runs the gates when this workflow itself changes, so it verifies its own edits', () => {
    expect(matchesPath.test('.github/workflows/skills-ci.yml')).toBe(true);
  });

  // Reporting green is now the skip path rather than an absent check, so what
  // matters here is that the expensive steps stay off a pull request with
  // nothing for them to read.
  //
  // `tools/updater/pyproject.toml` is here as one file, not as a claim about
  // its directory: `gates.test.mjs` does read the committed
  // `tools/updater/profiles/`, so that sibling is a real gap in the pattern
  // rather than a benign skip. The workflow comment records it.
  it('skips the gates for a change that touches none of their inputs', () => {
    expect(matchesPath.test('tools/updater/pyproject.toml')).toBe(false);
    expect(matchesPath.test('docs/product/BACKLOG.md')).toBe(false);
    expect(matchesPath.test('web/src/components/ModelTreeExplorer.tsx')).toBe(false);
    expect(matchesPath.test('.github/workflows/web-ci.yml')).toBe(false);
  });

  it('does not over-match a path that merely begins with a scoped prefix', () => {
    expect(matchesPath.test('webhooks/handler.ts')).toBe(false);
    expect(matchesPath.test('.github/workflows/skills-ci.yml.bak')).toBe(false);
  });

  // The pattern is anchored at `^`, and nothing else pinned that anchor: every
  // other case here fails for a reason that survives its removal. A scoped
  // prefix appearing further along a path is the one input that tells the two
  // apart, so without these the anchor could be dropped silently.
  it('matches a scoped prefix only at the start of the path', () => {
    expect(matchesPath.test('vendor/web/src/data/releases.json')).toBe(false);
    expect(matchesPath.test('vendor/.github/skills/modeltree-gates/SKILL.md')).toBe(false);
    expect(matchesPath.test('third_party/.github/scripts/check.mjs')).toBe(false);
  });

  // A green check over a change no gate ever read is the exact failure this
  // workflow exists to remove, so an uncomputable diff must run, not skip.
  it('runs the gates rather than skipping when the diff cannot be computed', () => {
    const branch = scopeScript.slice(scopeScript.indexOf('Could not diff'));

    expect(branch.slice(0, branch.indexOf('fi'))).toContain('run=true');
  });

  // Reached by a push to `main` as well as by a manual dispatch, which is what
  // makes the push trigger useful rather than decorative: a `main` run has no
  // pull-request base in the event payload, and this is the branch that decides
  // to run the gates anyway instead of skipping them.
  it('runs the gates for any event that is not a pull request', () => {
    const branch = scopeScript.slice(scopeScript.indexOf('!= "pull_request"'));

    expect(branch.slice(0, branch.indexOf('fi'))).toContain('run=true');
  });

  // Derived rather than listed: a gate step added later without the guard fails
  // here instead of quietly running on every pull request in the repository.
  // The decision step itself is excluded — it is what the guard reads — and the
  // node invocation is matched at the start of a line so that a comment naming
  // a script is not mistaken for running one.
  it('gates every expensive step on the scope decision', () => {
    const expensive = skillsCiSteps.filter(
      (step) =>
        step.id !== 'scope' &&
        (String(step.uses ?? '').startsWith('actions/setup-node') ||
          /(?:^|\n)\s*node\s/.test(String(step.run ?? ''))),
    );

    expect(expensive.length).toBeGreaterThan(0);

    for (const step of expensive) {
      expect(step.if, `${String(step.name)} must be gated on the scope decision`).toBe(
        "steps.scope.outputs.run == 'true'",
      );
    }
  });

  it('still runs the dataset gate against the live data', () => {
    const step = skillsCiSteps.find((candidate) =>
      String(candidate.run ?? '').includes('gate-dataset.mjs'),
    );

    expect(step, 'skills-ci must run gate-dataset.mjs').toBeDefined();
  });

  // ADR 0006 widened the ADR 0003 qualifying class by one document, the run
  // ledger, and paid for the widening with gate-ledger. The half of that gate
  // which is CI's to run is the completeness check: no commit may declare a run
  // id that the ledger does not record. If this step goes missing, the ledger
  // can silently fall behind published history again, which is the condition
  // #419 was filed about and which reached the live site three times.
  it('runs the ledger gate over published history', () => {
    const step = skillsCiSteps.find((candidate) =>
      String(candidate.run ?? '').includes('gate-ledger.mjs'),
    );

    expect(step, 'skills-ci must run gate-ledger.mjs').toBeDefined();

    // `--history` against an explicit ref, never the gate's default. The default
    // is `refs/remotes/origin/main`, which actions/checkout does not reliably
    // create; the gate would exit 2 there, and an exit 2 is not a pass.
    expect(String(step?.run ?? '')).toContain('--history HEAD');
  });

  // The complement of the assertion above, and the one that catches a step of a
  // kind this test did not anticipate: everything after the decision belongs to
  // one side of it or the other. Only the checkout and the decision itself may
  // run unconditionally.
  it('leaves no step running unscoped', () => {
    const ungated = skillsCiSteps.filter(
      (step) =>
        step.id !== 'scope' &&
        !String(step.uses ?? '').startsWith('actions/checkout') &&
        step.if === undefined,
    );

    expect(ungated.map((step) => String(step.name))).toEqual([]);
  });
});

describe('skills-ci.yml holds no more privilege than it needs', () => {
  it('grants read access to repository contents and nothing else', () => {
    expect(skillsCi.permissions).toEqual({ contents: 'read' });
  });

  it('keeps no credentials in the checkout, because the job never pushes', () => {
    const checkout = skillsCiSteps.find((step) =>
      String(step.uses ?? '').startsWith('actions/checkout'),
    );

    expect(mapping(mapping(checkout ?? null, 'checkout').with, 'checkout.with')['persist-credentials']).toBe(false);
  });

  // Documented so that whoever configures branch protection reads the current
  // state before adding it, or leaving it off, on purpose. The reason it was
  // previously unrequirable — the trigger path filter — is gone, so the entry
  // that said so must not survive this change. The docs must not hardcode
  // whether it is required: that is a branch-protection fact this file cannot
  // read, and asserting it here is how the sentence this replaces went stale.
  it('is documented as safe to require, and defers requiredness to branch protection', () => {
    expect(workflowDocs).toContain('`skills-ci`');
    expect(workflowDocs).toContain('### `skills-ci` is safe to require');
    expect(workflowDocs).not.toContain('is not yet required');
    expect(workflowDocs).not.toContain('**It is not required today.**');
    expect(workflowDocs).not.toContain('### Nor is `skills-ci`');
    expect(workflowDocs).toContain('| `skills-ci` | `skills-ci.yml` | **Yes**');
  });
});

describe('the measured overlap between the two dataset checks is recorded', () => {
  // The point of #189 is not only that the gate now runs, but that the
  // difference between it and `npm run validate` is written down. These pin the
  // findings that motivated the change, so deleting them is a deliberate act.
  it('records which rules gate-dataset enforces alone', () => {
    expect(workflowDocs).toContain('## What gates a dataset change');
    expect(workflowDocs).toContain('`RANKING_WORDS`');
    expect(workflowDocs).toContain('`FORBIDDEN_HOSTS`');
  });
});

// #691, the same defect #609 fixed in web-ci.yml. `grep` exits 0 on a match, 1
// on no match and 2 on an error, and this step used to truth-test it with `if`,
// which collapses 1 and 2 into one branch. A matcher that could not run
// therefore reported "nothing matched": every step below it is gated on
// `steps.scope.outputs.run == 'true'`, so the gates all skipped and `skills-ci`
// -- a required check on main -- reported green over a change no gate ever read.
// The diff guard above it already refuses that trade and runs the gates instead.
//
// These assertions run the committed script through a real bash rather than
// reading its text, because the defect lives in what the shell *does* with an
// exit code and no substring check can see that. Statuses 0 and 1 come from the
// real `grep` against the real committed ERE, so the wiring is exercised end to
// end; 2 and 127 are injected, because the committed ERE is well-formed and a
// here-string cannot fail to be read. That a malformed ERE really does exit 2
// while a clean miss exits 1 is measured in `web-ci.test.ts`, which shares this
// suite; it is a fact about `grep` rather than about this workflow.
describe('skills-ci.yml scope detection tells a broken matcher from a clean miss', () => {
  // Extracted at module scope through `mapping`, which throws when no step
  // carries the id. A rename cannot leave these tests quietly exercising an
  // empty script.
  const runner = scopeStepRunner(scopeScript, {
    GITHUB_EVENT_NAME: 'pull_request',
    BASE_SHA: 'a1b2c3d',
    HEAD_SHA: 'e4f5a6b',
  });

  afterAll(() => {
    runner.cleanup();
  });

  it('extracts the step under test, so a mis-read cannot pass as a green run', () => {
    // Guards every assertion below: an empty or wrong script would otherwise run
    // clean and prove nothing at all.
    expect(scopeStep, 'jobs.skills-ci must have a step with id `scope`').toBeDefined();
    expect(scopeScript).toContain('grep -Eq');
    expect(scopeScript).toContain('GITHUB_OUTPUT');
  });

  it('runs the gates when the matcher finds a gate input', () => {
    const outcome = runner.run('.github/skills/modeltree-gates/scripts/gate-dataset.mjs\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
  });

  // The over-broad direction, which the fix must not reach for. A step that
  // always builds satisfies "never skip on an error" while destroying the scope
  // filter and doubling what every unrelated pull request costs. `not.toContain`
  // is the half that catches it.
  it('still skips when the matcher runs and no gate input changed', () => {
    const outcome = runner.run('docs/product/BACKLOG.md\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=false');
    expect(outcome.githubOutput ?? '').not.toContain('run=true');
  });

  // The regression this block exists for. Reverting the fix leaves the two cases
  // above green and turns these red, which is why the status is driven
  // separately from the changed-file list: a test that only exercised match and
  // no-match could not detect this coming back.
  //
  // 2 is grep's own "an error occurred"; 127 is the shell's "command not found",
  // which is how a `grep` missing from the runner image would present. Neither
  // is a statement about the changed-file list, so neither may decide to skip.
  it.each([[2], [127]])('runs the gates rather than skipping when the matcher exits %i', (grepExit) => {
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
