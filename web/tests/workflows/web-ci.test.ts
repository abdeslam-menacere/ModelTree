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

/**
 * The `gh issue list | jq` pipeline a script actually looks the stale-site issue
 * up with, pulled out of the committed workflow rather than restated here, so
 * the assertions cover the shipped rule and not a copy of it.
 */
function issueLookup(script: string, label: string): string {
  const found = script.match(/existing="\$\(gh issue list[\s\S]*?\)"/);

  if (found === null) {
    throw new Error(`Expected ${label} to find the stale-site issue with gh issue list`);
  }

  return found[0].replace(/\\\n\s*/g, ' ').replace(/\s+/g, ' ');
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

/**
 * A workflow file as committed, alongside the document `yaml` parses out of it.
 * The source is kept because some assertions are about the bytes rather than the
 * structure: counting how many times a string appears in the file, for one.
 */
function readWorkflow(fileName: string): { source: string; document: YamlMapping } {
  const path = new URL(`../../../.github/workflows/${fileName}`, import.meta.url);
  const source = readFileSync(path, 'utf8');

  return { source, document: mapping(parse(source), fileName) };
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
const recoveryJob = job(pages.document, 'report-recovery');

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

describe('pages.yml resolves the alert once the site recovers', () => {
  const recover = steps(recoveryJob, 'jobs.report-recovery')[0] ?? {};
  const script = String(recover.run);

  it('runs only after a deploy that actually succeeded on main', () => {
    expect(recoveryJob.needs).toBe('deploy');
    expect(String(recoveryJob.if)).toContain("needs.deploy.result == 'success'");
  });

  // success() is also true when a needed job was *skipped*, which is what deploy
  // does on a fork, where its github.repository guard does not hold. A deploy
  // that never ran has unfrozen nothing and must not resolve an alert.
  it('does not read a skipped deploy as a recovery', () => {
    expect(String(recoveryJob.if)).not.toContain('success()');
  });

  // deploy carries no ref guard of its own, so a workflow_dispatch from a branch
  // really does deploy that branch. Closing a genuine alert off the back of that
  // would report the site recovered while main is still broken.
  it('guards the ref with the same clause the failure path uses', () => {
    const guard = "github.ref == 'refs/heads/main'";

    expect(String(reportJob.if)).toContain(guard);
    expect(String(recoveryJob.if)).toContain(guard);
  });

  it('closes the alert and says which run and commit resolved it', () => {
    expect(script).toContain('gh issue comment');
    expect(script).toContain('gh issue close');
    expect(mapping(recover.env, 'report-recovery.env')).toMatchObject({
      RECOVERED_SHA: '${{ github.sha }}',
    });
    expect(script).toContain('$RECOVERED_SHA');
    expect(script).toContain('$RUN_URL');
  });

  // A successful deploy with no alert open is the ordinary case, and by far the
  // most common one. It must not turn the workflow red.
  it('succeeds quietly when no alert is open', () => {
    const branch = script.slice(script.indexOf('-z "$existing"'));

    expect(branch.slice(0, branch.indexOf('fi'))).toContain('exit 0');
  });

  it('resolves alerts without ever filing one', () => {
    expect(script).not.toContain('gh issue create');
  });

  it('never checks out, and touches no action at all', () => {
    expect(recoveryJob.environment).toBeUndefined();

    for (const step of steps(recoveryJob, 'jobs.report-recovery')) {
      expect(step.uses).toBeUndefined();
    }
  });
});

describe('pages.yml keeps the failure and recovery paths on one definition', () => {
  const title = mapping(pages.document.env, 'pages.yml env').STALE_SITE_TITLE;
  const failureScript = String((steps(reportJob, 'jobs.report-failure')[0] ?? {}).run);
  const recoveryScript = String((steps(recoveryJob, 'jobs.report-recovery')[0] ?? {}).run);

  // Pinned rather than read back, because renaming the alert orphans every issue
  // the previous title already opened: the recovery job would stop matching them
  // and they would stay open forever, which is the bug this job exists to fix.
  it('names the alert at the workflow level', () => {
    expect(title).toBe('GitHub Pages deploy failed - the published site is stale');
  });

  // The two jobs identify the same issue only because there is one string to
  // identify it by. Counting occurrences in the committed file is what makes
  // that structural rather than conventional: a second copy anywhere fails here,
  // so there is nothing for a later edit to drift away from.
  it('carries no second copy of that title to drift away from', () => {
    expect(pages.source.split(String(title)).length - 1).toBe(1);
  });

  it('has both jobs read that one definition', () => {
    expect(failureScript).toContain('$STALE_SITE_TITLE');
    expect(recoveryScript).toContain('$STALE_SITE_TITLE');
  });

  // Sharing the title is not sufficient on its own: matching it loosely on one
  // path and exactly on the other diverges just as badly, and the recovery job
  // would close whatever the search happened to rank first. Both lookups are
  // read out of the committed scripts, so editing one alone fails here.
  it('looks the issue up by an identical rule on both paths', () => {
    expect(issueLookup(recoveryScript, 'jobs.report-recovery')).toBe(
      issueLookup(failureScript, 'jobs.report-failure'),
    );
  });

  it('matches the title exactly, rather than trusting search relevance', () => {
    expect(issueLookup(failureScript, 'jobs.report-failure')).toContain('select(.title == $t)');
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

  // The recovery job resolves an issue. It needs no source, so it is granted no
  // source: every scope left out of a job-level block is none, which makes this
  // strictly narrower than the failure job rather than a copy of it.
  it('lets the recovery job write issues and nothing else', () => {
    expect(recoveryJob.permissions).toEqual({ issues: 'write' });
  });

  // Stated over every job rather than the two that exist today, so a third
  // reporting job cannot quietly arrive holding the keys to the deployment.
  it('gives no job outside deploy any way to publish the site', () => {
    for (const [id, definition] of Object.entries(mapping(pages.document.jobs, 'jobs'))) {
      if (id === 'deploy') continue;

      const block = mapping(mapping(definition, `jobs.${id}`).permissions, `jobs.${id}.permissions`);

      expect(block.pages, `jobs.${id} must not publish`).toBeUndefined();
      expect(block['id-token'], `jobs.${id} must not mint an OIDC token`).toBeUndefined();
      expect(block.contents, `jobs.${id} must not write repository contents`).not.toBe('write');
    }
  });
});

describe('the YAML parser these assertions rest on', () => {
  it('keeps on as a key rather than the boolean a YAML 1.1 parser would produce', () => {
    expect(parse('on:\n  pull_request:\n')).toEqual({ on: { pull_request: null } });
  });

  it('reads sequences of scalars and sequences of mappings', () => {
    const document = parse(
      ['paths:', "  - 'web/**'", 'steps:', '  - name: One', '    run: go', '  - name: Two'].join('\n'),
    );

    expect(document.paths).toEqual(['web/**']);
    expect(document.steps).toEqual([{ name: 'One', run: 'go' }, { name: 'Two' }]);
  });

  it('preserves a block scalar verbatim and drops comments outside it', () => {
    const document = parse(
      ['# dropped', 'run: |', '  set -eu', '  # kept', 'after: 1  # dropped'].join('\n'),
    );

    expect(document.run).toBe('set -eu\n# kept\n');
    expect(document.after).toBe(1);
  });
});
