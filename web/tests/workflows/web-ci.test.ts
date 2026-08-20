import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseYaml, readWorkflow } from './read-workflow';
import type { YamlMapping, YamlValue } from './read-workflow';

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

function stepNamed(owner: YamlMapping, label: string, name: string): YamlMapping {
  const step = steps(owner, label).find((candidate) => candidate.name === name);

  if (step === undefined) {
    throw new Error(`Expected a step named "${name}" in ${label}`);
  }

  return step;
}

/** Every `permissions:` block in a document, top level and per job. */
function permissionBlocks(document: YamlMapping): YamlMapping[] {
  const blocks: YamlMapping[] = [];

  if (document.permissions !== undefined) {
    blocks.push(mapping(document.permissions, 'top-level permissions'));
  }

  for (const [id, definition] of Object.entries(mapping(document.jobs, 'jobs'))) {
    const block = mapping(definition, `jobs.${id}`).permissions;
    if (block !== undefined) blocks.push(mapping(block, `jobs.${id}.permissions`));
  }

  return blocks;
}

const webCi = readWorkflow('web-ci.yml');
const pages = readWorkflow('pages.yml');
const workflowDocs = readFileSync(
  new URL('../../../.github/workflows/README.md', import.meta.url),
  'utf8',
);

const webCiJob = job(webCi.document, 'web-ci');
const deployJob = job(pages.document, 'deploy');
const reportJob = job(pages.document, 'report-failure');

describe('web-ci.yml triggers', () => {
  const triggers = mapping(webCi.document.on, 'on');

  it('runs on pull requests and can be dispatched by hand', () => {
    expect(Object.keys(triggers)).toContain('pull_request');
    expect(Object.keys(triggers)).toContain('workflow_dispatch');
  });

  // The anti-deadlock design rests on this. A trigger path filter makes a
  // non-matching pull request report no check at all, and a required check that
  // never reports leaves that pull request pending forever (#80). The filtering
  // happens inside the job instead, so the check always reports.
  it('carries no trigger-level path filter, so the check reports on every pull request', () => {
    expect(triggers.pull_request).toBeNull();
  });

  // pages.yml already builds main on every push, and now fails loudly. A second
  // full build per merge would be duplication.
  it('leaves main to pages.yml', () => {
    expect(Object.keys(triggers)).not.toContain('push');
  });
});

describe('web-ci.yml check name', () => {
  it('reports exactly one check', () => {
    expect(Object.keys(mapping(webCi.document.jobs, 'jobs'))).toEqual(['web-ci']);
  });

  // Branch protection identifies a check by its job name. A name that varies per
  // matrix leg or per run cannot be required, which is what #90 asks for and
  // what #80 needs.
  it('names the job with a literal that cannot vary per run', () => {
    expect(webCiJob.name).toBe('web-ci');
    expect(String(webCiJob.name)).not.toContain('${{');
    expect(webCiJob.strategy).toBeUndefined();
  });

  it('documents that name for whoever configures branch protection', () => {
    expect(workflowDocs).toContain('`web-ci`');
  });
});

describe('web-ci.yml permissions', () => {
  it('grants read access to repository contents and nothing else', () => {
    expect(webCi.document.permissions).toEqual({ contents: 'read' });
  });

  it('gives no job any write scope at all', () => {
    for (const block of permissionBlocks(webCi.document)) {
      for (const [scope, level] of Object.entries(block)) {
        expect(level, `Permission "${scope}" must not be writable`).not.toBe('write');
      }
    }
  });

  it('keeps no credentials in the checkout, because the job never pushes', () => {
    const checkout = stepNamed(webCiJob, 'jobs.web-ci', 'Check out repository');

    expect(mapping(checkout.with, 'checkout.with')['persist-credentials']).toBe(false);
  });
});

describe('web-ci.yml scope detection', () => {
  const scope = steps(webCiJob, 'jobs.web-ci').find((step) => step.id === 'scope');
  const script = String(mapping(scope ?? null, 'the step with id "scope"').run);

  /**
   * The pattern the workflow actually greps with, pulled out of the committed
   * script rather than restated here, so these assertions cover the shipped
   * behaviour and not a copy of it. The ERE the workflow uses is also a valid
   * JavaScript regular expression.
   */
  const pattern = script.match(/grep -Eq '([^']+)'/)?.[1];
  const matchesPath = new RegExp(pattern ?? '(?!)');

  it('greps for the paths that matter', () => {
    expect(pattern).toBeDefined();
  });

  it('diffs against the base commit, which shallow history would not contain', () => {
    const checkout = stepNamed(webCiJob, 'jobs.web-ci', 'Check out repository');

    expect(mapping(checkout.with, 'checkout.with')['fetch-depth']).toBe(0);
    expect(script).toContain('git diff --name-only "$BASE_SHA...$HEAD_SHA"');
  });

  it('builds for any change under web/', () => {
    expect(matchesPath.test('web/src/data/releases.json')).toBe(true);
    expect(matchesPath.test('web/package-lock.json')).toBe(true);
    expect(matchesPath.test('web/tests/workflows/web-ci.test.ts')).toBe(true);
  });

  it('builds when this workflow itself changes, so it verifies its own edits', () => {
    expect(matchesPath.test('.github/workflows/web-ci.yml')).toBe(true);
  });

  // Acceptance criterion: a pull request touching only tools/updater/ is
  // unaffected. That package belongs to updater-tests.yml.
  it('skips a change confined to tools/updater/', () => {
    expect(matchesPath.test('tools/updater/pyproject.toml')).toBe(false);
    expect(matchesPath.test('tools/updater/src/modeltree_updater/run.py')).toBe(false);
    expect(matchesPath.test('.github/workflows/updater-tests.yml')).toBe(false);
  });

  it('does not over-match paths that merely begin with the letters web', () => {
    expect(matchesPath.test('webhooks/handler.ts')).toBe(false);
    expect(matchesPath.test('docs/product/BACKLOG.md')).toBe(false);
  });

  // Reporting green for work that was never verified is the exact failure this
  // workflow exists to remove, so an uncomputable diff must build, not skip.
  it('builds rather than skips when the diff cannot be computed', () => {
    const branch = script.slice(script.indexOf('Could not diff'));

    expect(branch.slice(0, branch.indexOf('fi'))).toContain('run=true');
  });

  it('builds on a manual dispatch, which has no base to diff against', () => {
    const branch = script.slice(script.indexOf('!= "pull_request"'));

    expect(branch.slice(0, branch.indexOf('fi'))).toContain('run=true');
  });
});

describe('web-ci.yml build steps', () => {
  const build = stepNamed(webCiJob, 'jobs.web-ci', 'Validate and build the site');
  const deployBuild = stepNamed(deployJob, 'jobs.deploy', 'Build Astro site');

  it('installs strictly from the lockfile', () => {
    expect(String(stepNamed(webCiJob, 'jobs.web-ci', 'Install dependencies').run)).toContain('npm ci');
  });

  // npm run build is npm run validate && astro build, so one command covers the
  // vitest suite, the Astro and TypeScript diagnostics, and the static build. A
  // green check here therefore means main can actually deploy.
  it('runs the same command the deploy gates on', () => {
    expect(String(build.run)).toContain('npm run build');
    expect(String(deployBuild.run)).toContain('npm run build');
  });

  it('builds the real site, with the variables the deploy uses', () => {
    expect(build.env).toEqual(deployBuild.env);
  });

  it('builds on the Node version the deploy uses', () => {
    const here = stepNamed(webCiJob, 'jobs.web-ci', 'Set up Node.js');
    const there = stepNamed(deployJob, 'jobs.deploy', 'Set up Node.js');

    expect(mapping(here.with, 'web-ci setup-node.with')['node-version']).toBe(
      mapping(there.with, 'deploy setup-node.with')['node-version'],
    );
  });

  it('gates every expensive step on the scope decision', () => {
    for (const name of ['Set up Node.js', 'Install dependencies', 'Validate and build the site']) {
      expect(stepNamed(webCiJob, 'jobs.web-ci', name).if).toBe("steps.scope.outputs.run == 'true'");
    }
  });
});

describe('pages.yml makes a failed deploy visible', () => {
  const report = steps(reportJob, 'jobs.report-failure')[0] ?? {};
  const script = String(report.run);

  it('reports only when the deploy has actually failed on main', () => {
    expect(reportJob.needs).toBe('deploy');
    expect(String(reportJob.if)).toContain('failure()');
    expect(String(reportJob.if)).toContain("github.ref == 'refs/heads/main'");
  });

  it('writes issues and nothing else', () => {
    expect(reportJob.permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  it('reuses the open report instead of filing a duplicate per failed push', () => {
    expect(script).toContain('gh issue list');
    expect(script).toContain('gh issue comment');
    expect(script).toContain('gh issue create');
  });

  it('names the failing commit and the run, so the staleness is traceable', () => {
    expect(mapping(report.env, 'report-failure.env')).toMatchObject({
      FAILED_SHA: '${{ github.sha }}',
    });
    expect(script).toContain('$RUN_URL');
  });
});

describe('pages.yml permissions', () => {
  it('starts every job from contents: read', () => {
    expect(pages.document.permissions).toEqual({ contents: 'read' });
  });

  // Deploying needs pages: write and id-token: write. Keeping them on the deploy
  // job is what stops the reporting job inheriting them.
  it('confines the deployment scopes to the deploy job', () => {
    const deploy = mapping(deployJob.permissions, 'jobs.deploy.permissions');
    const report = mapping(reportJob.permissions, 'jobs.report-failure.permissions');

    expect(deploy).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write' });
    expect(report.pages).toBeUndefined();
    expect(report['id-token']).toBeUndefined();
  });
});

describe('the workflow reader', () => {
  it('keeps on as a key rather than the boolean a YAML 1.1 parser would produce', () => {
    expect(parseYaml('on:\n  pull_request:\n')).toEqual({ on: { pull_request: null } });
  });

  it('reads sequences of scalars and sequences of mappings', () => {
    const document = parseYaml(
      ['paths:', "  - 'web/**'", 'steps:', '  - name: One', '    run: go', '  - name: Two'].join('\n'),
    );

    expect(document.paths).toEqual(['web/**']);
    expect(document.steps).toEqual([{ name: 'One', run: 'go' }, { name: 'Two' }]);
  });

  it('preserves a block scalar verbatim and drops comments outside it', () => {
    const document = parseYaml(
      ['# dropped', 'run: |', '  set -eu', '  # kept', 'after: 1  # dropped'].join('\n'),
    );

    expect(document.run).toBe('set -eu\n# kept\n');
    expect(document.after).toBe(1);
  });
});
