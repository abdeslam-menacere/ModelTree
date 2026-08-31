import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

describe('skills-ci.yml reports on every pull request, so it can be required', () => {
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

  it('leaves main alone; this check is about pull requests', () => {
    expect(Object.keys(triggers)).not.toContain('push');
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

  it('runs the gates on a manual dispatch, which has no base to diff against', () => {
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
