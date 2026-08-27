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

/** web/package.json's scripts, the one definition every command below expands from. */
const webScripts = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * The leaf commands a shell command actually runs, following every
 * `npm run <name>` indirection through web/package.json.
 *
 * This is what makes web-ci.yml's split verification steps provable rather than
 * merely plausible. `npm run build` is what pages.yml gates the deploy on, and
 * splitting it into a step per check buys failure attribution at the risk of the
 * CI path drifting away from the deploy path -- the precise failure web-ci.yml
 * exists to prevent. Expanding both sides to leaves and comparing them removes
 * the risk: neither side is restated here, so editing any script in package.json
 * moves the expectation rather than invalidating it silently.
 */
function leafCommands(command: string): string[] {
  return command
    .split('&&')
    .map((part) => part.trim())
    .flatMap((part) => {
      const invocation = part.match(/^npm run ([A-Za-z0-9:_-]+)(?:\s+--\s+(.+))?$/);

      if (invocation === null) return [part];

      const [, name, forwarded] = invocation;
      const body = webScripts[name];

      if (body === undefined) throw new Error(`web/package.json defines no script "${name}"`);

      const expanded = leafCommands(body);

      if (forwarded === undefined) return expanded;

      // `npm run x -- args` appends args to the command the script ends with.
      return expanded.map((leaf, index) =>
        index === expanded.length - 1 ? `${leaf} ${forwarded}` : leaf,
      );
    });
}

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
    expect(mapping(triggers.push, 'on.push').paths).toBeUndefined();
  });

  // Reversed deliberately by #5. This asserted the opposite until then, on the
  // grounds that pages.yml already builds main on every push and a second build
  // per merge is duplication. The duplication is real and is now accepted:
  // pages.yml's build is a step of a deployment, skipped entirely on a fork by
  // its `github.repository` guard, and reported under a name that cannot tell a
  // broken site apart from broken publishing -- so it is not a check on main.
  // The cost is paid down rather than swallowed, because the scope step below
  // diffs a push exactly as it diffs a pull request: only a main push that
  // actually touched web/ builds twice.
  it('also runs on pushes to main, so main carries the check by name', () => {
    expect(Object.keys(triggers)).toContain('push');
    expect(mapping(triggers.push, 'on.push').branches).toEqual(['main']);
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

  /**
   * One arm of the scope step's `case`, so an assertion about a range endpoint
   * is tied to the event whose data computes it. A substring check against the
   * whole script would also pass if the two arms were cross-wired.
   */
  const caseArm = (event: string): string => {
    const start = script.indexOf(`${event})`);

    return start === -1 ? '' : script.slice(start, script.indexOf(';;', start));
  };

  it('greps for the paths that matter', () => {
    expect(pattern).toBeDefined();
  });

  it('diffs against the base commit, which shallow history would not contain', () => {
    const checkout = stepNamed(webCiJob, 'jobs.web-ci', 'Check out repository');

    expect(mapping(checkout.with, 'checkout.with')['fetch-depth']).toBe(0);
    expect(script).toContain('git diff --name-only "$base...$head"');
  });

  // What makes the push trigger affordable. pages.yml rebuilds main on every
  // push regardless, so a skip here leaves main no less verified than before,
  // while a main push that touches only docs or tools/ stops costing a second
  // full build. Event data still reaches the shell as environment variables
  // rather than being interpolated into the script.
  it('scopes a push by its own range, not by always rebuilding main', () => {
    expect(mapping(mapping(scope ?? null, 'the scope step').env, 'scope.env')).toMatchObject({
      PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      PUSH_BEFORE_SHA: '${{ github.event.before }}',
    });
    expect(caseArm('push')).toContain('base="$PUSH_BEFORE_SHA"');
    expect(caseArm('push')).toContain('head="$GITHUB_SHA"');
  });

  // The env block above pins what the two pull request variables hold; this
  // pins which end of the range each is bound to, which nothing else covers.
  // Swapping these two lines diffs head...base, and because base is an
  // ancestor of head that range is empty rather than an error -- so the
  // fail-safe above never fires, run=false, no build happens, and web-ci (the
  // only required check on main) reports green for an unverified commit.
  it('scopes a pull request to its base...head range, in that order', () => {
    expect(caseArm('pull_request')).toContain('base="$PR_BASE_SHA"');
    expect(caseArm('pull_request')).toContain('head="$PR_HEAD_SHA"');
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
    const branch = script.slice(script.indexOf('*)'));

    expect(branch.slice(0, branch.indexOf(';;'))).toContain('run=true');
  });
});

describe('web-ci.yml verification steps', () => {
  const deployBuild = stepNamed(deployJob, 'jobs.deploy', 'Build Astro site');

  /** One check per step, in the order web-ci.yml runs them. */
  const verificationSteps = [
    'Run the web test suite',
    'Check Astro and TypeScript diagnostics',
    'Build the production site',
  ];

  it('installs strictly from the lockfile', () => {
    expect(String(stepNamed(webCiJob, 'jobs.web-ci', 'Install dependencies').run)).toContain('npm ci');
  });

  // A single `npm run build` step covered the vitest suite, the Astro and
  // TypeScript diagnostics and the static build at once, so a red run said only
  // that one of the three had failed (#5).
  it('gives each check a step of its own, so a red run names what broke', () => {
    for (const name of verificationSteps) {
      const run = String(stepNamed(webCiJob, 'jobs.web-ci', name).run).trim();

      // A step chaining two commands reports one failure for either, which is
      // exactly the attribution this split exists to restore.
      expect(run.split('\n'), `${name} must run exactly one command`).toHaveLength(1);
      expect(run, `${name} must run exactly one command`).not.toContain('&&');
    }
  });

  // Splitting is only safe while the split still runs what the deploy runs.
  // Both sides are expanded out of web/package.json rather than restated, so
  // adding a stage to `validate` fails here instead of quietly leaving this
  // check weaker than the deploy it is supposed to predict.
  it('runs exactly the commands the deploy gates on, in the same order', () => {
    const inCi = verificationSteps.flatMap((name) =>
      leafCommands(String(stepNamed(webCiJob, 'jobs.web-ci', name).run).trim()),
    );

    expect(inCi).toEqual(leafCommands('npm run build'));
  });

  it('leaves the deploy on the single command those steps decompose', () => {
    expect(String(deployBuild.run)).toContain('npm run build');
  });

  // At job level rather than per step: the deploy sets these once for one
  // command that runs all three checks, so every step of the split must see the
  // same environment, including a step added later.
  it('builds the real site, with the variables the deploy uses', () => {
    expect(webCiJob.env).toEqual(deployBuild.env);
  });

  it('builds on the Node version the deploy uses', () => {
    const here = stepNamed(webCiJob, 'jobs.web-ci', 'Set up Node.js');
    const there = stepNamed(deployJob, 'jobs.deploy', 'Set up Node.js');

    expect(mapping(here.with, 'web-ci setup-node.with')['node-version']).toBe(
      mapping(there.with, 'deploy setup-node.with')['node-version'],
    );
  });

  it('gates every expensive step on the scope decision', () => {
    for (const name of ['Set up Node.js', 'Install dependencies', ...verificationSteps]) {
      expect(stepNamed(webCiJob, 'jobs.web-ci', name).if).toBe("steps.scope.outputs.run == 'true'");
    }
  });

  it('uploads test diagnostics only when a run has actually failed', () => {
    const upload = stepNamed(webCiJob, 'jobs.web-ci', 'Upload test diagnostics');
    const options = mapping(upload.with, 'upload-artifact.with');

    expect(String(upload.if)).toContain('failure()');
    // Relative to the workspace root: `defaults.run.working-directory` applies
    // to run steps, never to an action.
    expect(options.path).toBe('web/.vitest/report.json');
    // A failure before the suite ran leaves no report, and missing diagnostics
    // must not turn an already-red run into a second, more confusing failure.
    expect(options['if-no-files-found']).toBe('ignore');
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
