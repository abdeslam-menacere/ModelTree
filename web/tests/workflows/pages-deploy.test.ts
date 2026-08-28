import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// What this file covers and what it deliberately leaves alone.
//
// `web-ci.test.ts` already parses pages.yml and asserts its permissions, its two
// stale-site alerting jobs, and that the deploy builds with the same command the
// CI checks decompose. None of that is repeated here. What was missing is the
// publishing half of issue #6: the deployment concurrency that pairs with those
// permissions, the three official Pages actions, the artifact path, and the two
// build variables that decide whether the published site resolves its own links.
//
// Every assertion below reads the committed workflow. None of them reads the
// dataset, so a data refresh cannot redden this file.

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

/** The `uses:` of the first step invoking `action`, without its version suffix. */
function actionUsed(owner: YamlMapping, label: string, action: string): string {
  const step = steps(owner, label).find((candidate) =>
    String(candidate.uses ?? '').startsWith(`${action}@`),
  );

  if (step === undefined) {
    throw new Error(`Expected ${label} to use ${action}`);
  }

  return String(step.uses);
}

const source = readFileSync(new URL('../../../.github/workflows/pages.yml', import.meta.url), 'utf8');
const pages = mapping(parse(source), 'pages.yml');
const deployJob = job(pages, 'deploy');
const deployLabel = 'jobs.deploy';

/**
 * The repository the deploy job restricts itself to, read out of its own
 * `if:` guard. Every expectation about the published URL below is derived from
 * this pair rather than restated, so renaming the repository moves the
 * expectations together instead of leaving one of them silently stale.
 */
const [owner, repository] = (() => {
  const guard = String(deployJob.if ?? '');
  const found = guard.match(/github\.repository == '([^/']+)\/([^/']+)'/);

  if (found === null) {
    throw new Error(`Expected jobs.deploy to guard on github.repository, found ${guard}`);
  }

  return [found[1], found[2]];
})();

const buildStep = stepNamed(deployJob, deployLabel, 'Build Astro site');
const buildEnv = mapping(buildStep.env, `${deployLabel} build env`);

describe('pages.yml deployment concurrency', () => {
  // The other half of acceptance criterion 1, whose permissions half
  // web-ci.test.ts already covers. Two deploys racing publish in whichever
  // order they finish, so the site can end up serving the older of two commits
  // with nothing anywhere recording that it happened.
  it('serialises deploys into a single named group', () => {
    const concurrency = mapping(pages.concurrency, 'concurrency');

    expect(concurrency.group).toBe('pages');
  });

  it('drops a superseded deploy rather than queueing it behind the newer one', () => {
    expect(mapping(pages.concurrency, 'concurrency')['cancel-in-progress']).toBe(true);
  });
});

describe('pages.yml publishes through the official Pages actions', () => {
  // Issue #6 asks for the configure, upload and deploy actions specifically.
  // Any of the three missing is a workflow that looks complete and publishes
  // nothing, or publishes without the base path Pages hands the build.
  it('configures, uploads, and deploys', () => {
    expect(actionUsed(deployJob, deployLabel, 'actions/configure-pages')).toBeTruthy();
    expect(actionUsed(deployJob, deployLabel, 'actions/upload-pages-artifact')).toBeTruthy();
    expect(actionUsed(deployJob, deployLabel, 'actions/deploy-pages')).toBeTruthy();
  });

  it('pins every action to a version rather than tracking a moving branch', () => {
    for (const step of steps(deployJob, deployLabel)) {
      const uses = step.uses;
      if (uses === undefined) continue;

      expect(String(uses), `${String(uses)} must carry a version`).toMatch(/@v\d[\w.-]*$/);
    }
  });

  it('builds before it uploads, so the artifact is the build that was validated', () => {
    const order = steps(deployJob, deployLabel);
    const built = order.findIndex((step) => step.name === 'Build Astro site');
    const uploaded = order.findIndex((step) =>
      String(step.uses ?? '').startsWith('actions/upload-pages-artifact@'),
    );

    expect(built).toBeGreaterThanOrEqual(0);
    expect(uploaded).toBeGreaterThan(built);
  });

  it('reports the deployed URL on the github-pages environment', () => {
    const environment = mapping(deployJob.environment, `${deployLabel}.environment`);
    const deploy = steps(deployJob, deployLabel).find((step) =>
      String(step.uses ?? '').startsWith('actions/deploy-pages@'),
    );

    expect(environment.name).toBe('github-pages');
    // The URL has to come from the deploy step's own output. A hard-coded one
    // keeps displaying a link after the real deployment has moved.
    expect(String(environment.url)).toContain(`steps.${String(deploy?.id)}.outputs.page_url`);
  });
});

describe('pages.yml artifact path', () => {
  // The failure this exists to catch: `defaults.run.working-directory` applies
  // to `run:` steps and never to an action's inputs, so `path: dist` resolves
  // against the workspace root, finds nothing, and fails the upload -- while
  // every `run:` step in the same job keeps working. The expectation is
  // composed from the job's own working directory rather than written out, so
  // moving the site out of `web/` moves this with it.
  it('uploads the build output relative to the workspace, not the working directory', () => {
    const workingDirectory = String(
      mapping(mapping(deployJob.defaults, `${deployLabel}.defaults`).run, `${deployLabel}.defaults.run`)[
        'working-directory'
      ],
    );
    const upload = steps(deployJob, deployLabel).find((step) =>
      String(step.uses ?? '').startsWith('actions/upload-pages-artifact@'),
    );

    expect(mapping(upload?.with ?? null, 'upload-pages-artifact.with').path).toBe(
      `${workingDirectory}/dist`,
    );
  });
});

describe('pages.yml build variables', () => {
  // Acceptance criteria 2 and 3. `astro.config.mjs` reads `site` from SITE_URL
  // and `base` from BASE_PATH, so these two strings are the whole reason the
  // published pages resolve their own assets and links. Both are checked
  // against the repository the job already names rather than against a literal.
  it('builds under the project base path GitHub publishes this repository at', () => {
    expect(buildEnv.BASE_PATH).toBe(`/${repository}/`);
  });

  it('keeps that base path non-root and directory-shaped', () => {
    const base = String(buildEnv.BASE_PATH);

    // A root base silently un-prefixes every generated link, which is exactly
    // the regression that only shows up once the site is behind a project path.
    expect(base).not.toBe('/');
    expect(base.startsWith('/')).toBe(true);
    // Astro joins `base` with a leading-slash-free path; without the trailing
    // slash the join produces `/ModelTreetree/`.
    expect(base.endsWith('/')).toBe(true);
  });

  it('canonicalises against the owner origin GitHub serves this repository from', () => {
    expect(buildEnv.SITE_URL).toBe(`https://${owner.toLowerCase()}.github.io`);
  });

  it('keeps the origin an origin, so the base path is not applied twice', () => {
    const site = new URL(String(buildEnv.SITE_URL));

    expect(site.protocol).toBe('https:');
    expect(site.pathname).toBe('/');
  });
});

describe('pages.yml triggers', () => {
  it('deploys every push to main, so the published site tracks the default branch', () => {
    const triggers = mapping(pages.on, 'on');
    const push = mapping(triggers.push, 'on.push');

    expect(sequence(push.branches, 'on.push.branches')).toContain('main');
  });

  it('can be run by hand, which is how an owner republishes after fixing Pages settings', () => {
    expect(Object.keys(mapping(pages.on, 'on'))).toContain('workflow_dispatch');
  });
});
