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

/**
 * A GitHub `on.<event>.paths` glob as a regular expression. `**` crosses path
 * separators and `*` does not, which is the only distinction these assertions
 * depend on.
 */
function pathFilter(glob: string): RegExp {
  const pattern = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');

  return new RegExp(`^${pattern}$`);
}

const skillsCiSource = readFileSync(
  new URL('../../../.github/workflows/skills-ci.yml', import.meta.url),
  'utf8',
);
const skillsCi = mapping(parse(skillsCiSource), 'skills-ci.yml');
const skillsCiJob = mapping(mapping(skillsCi.jobs, 'jobs')['skills-ci'], 'jobs.skills-ci');
const workflowDocs = readFileSync(
  new URL('../../../.github/workflows/README.md', import.meta.url),
  'utf8',
);

const triggerPaths = sequence(
  mapping(mapping(skillsCi.on, 'on').pull_request, 'on.pull_request').paths,
  'on.pull_request.paths',
).map(String);

const matchesAnyPath = (file: string) => triggerPaths.some((glob) => pathFilter(glob).test(file));

/**
 * The dataset documents `gate-dataset.mjs` reads, taken from the script itself
 * rather than restated here, so this file cannot drift away from the set the
 * gate actually loads. The script resolves them against `web/src/data`.
 */
const gateSource = readFileSync(
  new URL('../../../.github/skills/modeltree-gates/scripts/gate-dataset.mjs', import.meta.url),
  'utf8',
);
const gateDocuments = [...gateSource.matchAll(/'([a-z-]+\.json)'/g)].map((match) => match[1]);

describe('skills-ci.yml runs the dataset gate on a data change', () => {
  // The bug in #189: the workflow was filtered to the gates alone, so the step
  // that runs gate-dataset against the live dataset could never fire on the data
  // change it exists to catch. A pull request touching only web/src/data got
  // web-ci and nothing else.
  it('triggers on a change to the dataset it gates', () => {
    expect(matchesAnyPath('web/src/data/releases.json')).toBe(true);
    expect(matchesAnyPath('web/src/data/sources.json')).toBe(true);
  });

  // The filter is only as good as its coverage of what the gate reads. Every
  // document the script loads must be inside it, or the hole simply moves.
  it('covers every dataset document the gate actually loads', () => {
    expect(gateDocuments.length).toBeGreaterThan(0);

    for (const document of gateDocuments) {
      expect(matchesAnyPath(`web/src/data/${document}`), `${document} must trigger skills-ci`).toBe(true);
    }
  });

  it('still triggers on the gates themselves, and on this workflow', () => {
    expect(matchesAnyPath('.github/skills/modeltree-gates/scripts/gate-dataset.mjs')).toBe(true);
    expect(matchesAnyPath('.github/workflows/skills-ci.yml')).toBe(true);
  });

  // Filtering is the whole reason this check is not required. It must stay off
  // pull requests that touch neither the gates nor the data.
  it('stays off a pull request that touches neither the gates nor the data', () => {
    expect(matchesAnyPath('tools/updater/pyproject.toml')).toBe(false);
    expect(matchesAnyPath('docs/product/BACKLOG.md')).toBe(false);
    expect(matchesAnyPath('web/src/components/ModelTreeExplorer.tsx')).toBe(false);
  });

  it('can still be dispatched by hand', () => {
    expect(Object.keys(mapping(skillsCi.on, 'on'))).toContain('workflow_dispatch');
  });

  it('runs the dataset gate against the live data', () => {
    const step = steps(skillsCiJob, 'jobs.skills-ci').find((candidate) =>
      String(candidate.run ?? '').includes('gate-dataset.mjs'),
    );

    expect(step, 'skills-ci must run gate-dataset.mjs').toBeDefined();
  });
});

describe('skills-ci.yml stays safe to leave unrequired', () => {
  it('grants read access to repository contents and nothing else', () => {
    expect(skillsCi.permissions).toEqual({ contents: 'read' });
  });

  it('keeps no credentials in the checkout, because the job never pushes', () => {
    const checkout = steps(skillsCiJob, 'jobs.skills-ci').find(
      (step) => String(step.uses ?? '').startsWith('actions/checkout'),
    );

    expect(mapping(mapping(checkout ?? null, 'checkout').with, 'checkout.with')['persist-credentials']).toBe(false);
  });

  // Documented so that whoever configures branch protection reads why this one
  // is not on the list before adding it (#169).
  it('is documented as a check that is not safe to require', () => {
    expect(workflowDocs).toContain('`skills-ci`');
    expect(workflowDocs).toContain('### Nor is `skills-ci`');
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
