import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

/**
 * `.github/scripts/ci-preflight.mjs` runs the repository's pull-request CI
 * locally, selected by what the branch changed, because a change could pass both
 * dock gates and still merge a red `main` (abdeslam-menacere/ModelTree#560).
 *
 * A preflight is only worth running if it stays the same as the CI it stands in
 * for, so nothing about the workflows is restated here. Both sides are read --
 * the committed YAML, and the script's own plan, obtained by running it -- and
 * compared. A workflow that gains a check, moves a path filter, or changes the
 * command a job runs turns this file red rather than leaving the preflight
 * quietly narrower than the thing it predicts.
 *
 * The selection cases run against a throwaway git repository rather than this
 * checkout, for two reasons: the answer must not depend on what the branch
 * running the suite happens to have changed, and `refs/remotes/origin/main` is
 * not present in every CI checkout. Same arrangement, and same reason, as the
 * `gate-source-approval` cases in `gates.test.mjs`.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, '.github', 'scripts', 'ci-preflight.mjs');
const workflowDir = join(repoRoot, '.github', 'workflows');

// Almost every case here runs git and then the script itself in a child process,
// which is far slower than the default per-test budget allows for -- and slower
// again when the suite is running inside the preflight, on a machine already
// busy building the site. A timeout in that position reports a script defect
// that is not there, so the budget is raised rather than the work made cheaper.
vi.setConfig({ testTimeout: 120_000 });

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

const workflowFiles = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));

function workflow(file: string): YamlMapping {
  return mapping(parse(readFileSync(join(workflowDir, file), 'utf8')) as YamlValue, file);
}

const workflows = new Map(workflowFiles.map((file) => [file, workflow(file)]));

/**
 * Every status check a committed workflow can report on a pull request, under
 * the name GitHub reports it: the job's `name:`, with each matrix leg expanded,
 * because that is what branch protection and the checks list actually show.
 *
 * A job whose `if:` skips it on a pull request still reports, so it is counted
 * here and has to be accounted for by the script one way or the other.
 */
function reportedPullRequestChecks(): { check: string; workflowFile: string; job: string }[] {
  const reported: { check: string; workflowFile: string; job: string }[] = [];

  for (const [file, parsed] of workflows) {
    // `on: pull_request:` with no value parses as a null-valued key, so presence
    // is the test rather than truthiness.
    const triggers = mapping(parsed.on, `${file}.on`);
    if (!Object.hasOwn(triggers, 'pull_request')) continue;

    for (const [jobId, rawJob] of Object.entries(mapping(parsed.jobs, `${file}.jobs`))) {
      const job = mapping(rawJob, `${file}.jobs.${jobId}`);
      const name = typeof job.name === 'string' ? job.name : jobId;
      const legs = matrixLegs(job, `${file}.jobs.${jobId}`);

      for (const leg of legs) {
        reported.push({ check: expand(name, leg), workflowFile: file, job: jobId });
      }
    }
  }

  return reported;
}

/**
 * The matrix values a job's name can interpolate, as a list of substitutions.
 * A job with no matrix has exactly one leg and no substitutions.
 */
function matrixLegs(job: YamlMapping, label: string): Record<string, string>[] {
  if (job.strategy === undefined) return [{}];

  const matrix = mapping(mapping(job.strategy, `${label}.strategy`).matrix, `${label}.strategy.matrix`);
  const legs: Record<string, string>[] = [{}];

  for (const [key, rawValues] of Object.entries(matrix)) {
    const values = sequence(rawValues, `${label}.strategy.matrix.${key}`);
    const widened: Record<string, string>[] = [];

    for (const leg of legs) {
      for (const value of values) widened.push({ ...leg, [key]: String(value) });
    }

    legs.length = 0;
    legs.push(...widened);
  }

  return legs;
}

function expand(name: string, leg: Record<string, string>): string {
  return name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (whole, key: string) => leg[key] ?? whole);
}

interface PlanCommand {
  label: string;
  cwd: string;
  local: string;
  ciRun: string;
}

interface PlanCheck {
  id: string;
  checks: string[];
  workflow: string;
  job: string;
  trigger: { kind: string; paths?: string[]; pattern?: string };
  commands: PlanCommand[];
  selectedBy?: string[];
}

interface Plan {
  anchor: string;
  changed: string[];
  selected: PlanCheck[];
  notSelected: PlanCheck[];
  notCovered: { check?: string; what: string; why: string }[];
  verified: boolean;
}

function planFor(repo: string): { plan: Plan; status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [script, '--plan', '--json', '--repo', repo], {
    encoding: 'utf8',
  });

  if (run.error) throw run.error;
  if (run.stdout.trim().length === 0) {
    throw new Error(`ci-preflight --plan produced no output. stderr: ${run.stderr}`);
  }

  return { plan: JSON.parse(run.stdout) as Plan, status: run.status, stderr: run.stderr };
}

/** A repository with published history and nothing changed on top of it. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ci-preflight-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  git('init', '-q');
  git('config', 'user.email', 'preflight@example.com');
  git('config', 'user.name', 'Preflight Test');
  // Keeps git from warning about line endings on Windows, which is noise in a
  // repository that exists for one diff.
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());

  // The platform temp directory is a symlink on some systems, so the resolved
  // path is what git and the script will agree on.
  return realpathSync(dir);
}

function touch(repo: string, path: string): void {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'scratch\n');
}

/** The check ids selected by a repository holding exactly these changed paths. */
function selectionFor(paths: string[]): string[] {
  const repo = scratchRepo();

  try {
    for (const path of paths) touch(repo, path);

    return planFor(repo)
      .plan.selected.map((entry) => entry.id)
      .sort();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

let baseline: Plan;
let scratch: string;

beforeAll(() => {
  scratch = scratchRepo();
  baseline = planFor(scratch).plan;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Every check the script knows about, selected or not. */
function allChecks(): PlanCheck[] {
  return [...baseline.selected, ...baseline.notSelected];
}

describe('the preflight knows about every check CI can report on a pull request', () => {
  it('accounts for each reported check, either by running it or by naming it as uncovered', () => {
    const reported = reportedPullRequestChecks();
    expect(reported.length).toBeGreaterThan(0);

    const covered = new Set(allChecks().flatMap((check) => check.checks));
    const declaredUncovered = new Set(
      baseline.notCovered.map((entry) => entry.check).filter((name): name is string => name !== undefined),
    );

    const unaccounted = reported
      .map(({ check }) => check)
      .filter((check) => !covered.has(check) && !declaredUncovered.has(check));

    expect(
      unaccounted,
      'a workflow reports a pull-request check that ci-preflight.mjs neither runs nor lists in '
        + 'NOT_COVERED; add it to one or the other',
    ).toEqual([]);
  });

  it('claims no check that no workflow reports', () => {
    const reported = new Set(reportedPullRequestChecks().map(({ check }) => check));
    const claimed = allChecks().flatMap((check) => check.checks);

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.filter((check) => !reported.has(check))).toEqual([]);
  });

  it('covers the three checks the historical merge turned red', () => {
    // `3d3f4b1` reddened exactly these. The preflight exists because nothing
    // local ran any of them, so this is the assertion the issue asks for.
    const covered = new Set(allChecks().flatMap((check) => check.checks));

    expect(covered.has('instruction-references')).toBe(true);
    expect(covered.has('pytest (Python 3.11)')).toBe(true);
    expect(covered.has('pytest (Python 3.13)')).toBe(true);
  });
});

describe('the preflight triggers are the workflows own triggers', () => {
  it('copies the path filter of every path-filtered workflow exactly', () => {
    const filtered = allChecks().filter((check) => check.trigger.kind === 'workflow-paths');
    expect(filtered.length).toBeGreaterThan(0);

    for (const check of filtered) {
      const parsed = workflows.get(check.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${check.workflow}`);

      const pullRequest = mapping(mapping(parsed.on, 'on').pull_request, `${check.workflow} on.pull_request`);
      const paths = sequence(pullRequest.paths, `${check.workflow} on.pull_request.paths`).map(String);

      expect(check.trigger.paths, `${check.id} must copy ${check.workflow}'s paths filter`).toEqual(paths);
    }
  });

  it('copies the in-job scope pattern of every unfiltered workflow exactly', () => {
    const scoped = allChecks().filter((check) => check.trigger.kind === 'in-job-scope');
    expect(scoped.length).toBeGreaterThan(0);

    for (const check of scoped) {
      const parsed = workflows.get(check.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${check.workflow}`);

      const job = mapping(mapping(parsed.jobs, 'jobs')[check.job], `jobs.${check.job}`);
      const scopeStep = sequence(job.steps, `jobs.${check.job}.steps`)
        .map((step, index) => mapping(step, `jobs.${check.job}.steps[${index}]`))
        .find((step) => step.id === 'scope');

      if (scopeStep === undefined) throw new Error(`no scope step in ${check.workflow} jobs.${check.job}`);

      // The ERE the workflow greps the changed-file list with, read out of the
      // committed script rather than restated, exactly as skills-ci.test.ts does.
      const pattern = String(scopeStep.run).match(/grep -Eq '([^']+)'/)?.[1];

      expect(pattern, `${check.workflow} jobs.${check.job} must grep with a single-quoted ERE`).toBeDefined();
      expect(check.trigger.pattern, `${check.id} must copy that pattern`).toBe(pattern);
    }
  });

  it('refuses a workflow path glob it cannot read, rather than matching nothing', () => {
    // The fail-closed direction. A glob form the matcher does not implement must
    // stop the run, because silently matching nothing leaves a check unselected
    // while the run still reports green -- the failure this script exists to
    // remove, reintroduced inside the script itself.
    const source = readFileSync(script, 'utf8');
    const matcher = source.slice(source.indexOf('function globMatches'), source.indexOf('/** The changed paths'));

    expect(matcher).toContain('unsupported glob in a workflow path filter');
    expect(matcher.match(/throw new Error/g)?.length).toBe(2);
  });
});

describe('the preflight runs the commands the workflow runs', () => {
  it('maps every local command onto a real step of the real job', () => {
    for (const check of allChecks()) {
      const parsed = workflows.get(check.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${check.workflow}`);

      const job = mapping(mapping(parsed.jobs, 'jobs')[check.job], `jobs.${check.job}`);
      const runs = sequence(job.steps, `jobs.${check.job}.steps`)
        .map((step, index) => mapping(step, `jobs.${check.job}.steps[${index}]`))
        .filter((step) => typeof step.run === 'string')
        .map((step) => String(step.run).trim());

      expect(check.commands.length).toBeGreaterThan(0);

      for (const command of check.commands) {
        expect(
          runs,
          `${check.id} runs "${command.local}" locally, which claims to stand for "${command.ciRun}" `
            + `in ${check.workflow} jobs.${check.job}, but that job runs no such step`,
        ).toContain(command.ciRun);
      }
    }
  });

  it('keeps the web commands identical to the three steps the deploy gates on', () => {
    const webCi = allChecks().find((check) => check.id === 'web-ci');
    if (webCi === undefined) throw new Error('no web-ci entry');

    expect(webCi.commands.map((command) => command.local)).toEqual([
      'npm run test',
      'npm run check',
      'npm run astro -- build',
    ]);
  });
});

describe('selection follows the change', () => {
  it('selects nothing when the branch has changed nothing', () => {
    expect(baseline.selected).toEqual([]);
    expect(baseline.notSelected.length).toBeGreaterThan(0);
  });

  it('selects the checks the bare-citation break reddened, on the file that carried it', () => {
    // The historical case, by path. `.github/skills/modeltree-gates/SKILL.md` is
    // the file whose bare `#441` citation turned three checks red on `main`
    // after both dock gates passed.
    expect(selectionFor(['.github/skills/modeltree-gates/SKILL.md'])).toEqual([
      'instruction-references',
      'skills-ci',
      'updater-pytest',
    ]);
  });

  it('selects the site and the gates on a dataset change, and nothing Python', () => {
    expect(selectionFor(['web/src/data/releases.json'])).toEqual(['skills-ci', 'web-ci']);
  });

  it('selects the ADR checks on a decision record', () => {
    expect(selectionFor(['docs/adr/0006-a-decision.md'])).toEqual(['adr-numbers', 'updater-pytest']);
  });

  it('selects the instruction checks on the instructions file itself', () => {
    expect(selectionFor(['.github/copilot-instructions.md'])).toEqual(['instruction-references']);
  });

  it('selects the link-health tests on a change to the source records', () => {
    expect(selectionFor(['web/src/data/sources.json'])).toEqual([
      'skills-ci',
      'source-link-health-tests',
      'web-ci',
    ]);
  });

  it('selects nothing for a change no pull-request check reads', () => {
    // The control. A selector that fires on everything carries no information,
    // so it has to be shown declining as well as firing.
    expect(selectionFor(['docs/product/BACKLOG.md', 'README.md'])).toEqual([]);
  });
});

describe('the preflight cannot be talked into a pass', () => {
  it('accepts no flag that skips, forces, or relaxes a check', () => {
    const source = readFileSync(script, 'utf8');
    const parseArgs = source.slice(source.indexOf('function parseArgs'), source.indexOf('function repoRoot'));
    const accepted = [...parseArgs.matchAll(/flag === '([^']+)'/g)].map((match) => match[1]).sort();

    expect(accepted).toEqual(['--help', '--json', '--plan', '--repo', '-h']);
  });

  it('exits 2 for an unrecognised flag rather than ignoring it', () => {
    const run = spawnSync(process.execPath, [script, '--force'], { encoding: 'utf8' });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown flag --force');
  });

  it('exits 2 from --plan, because a plan verifies nothing', () => {
    const { status, plan, stderr } = planFor(scratch);

    expect(status).toBe(2);
    expect(plan.verified).toBe(false);
    expect(stderr).toContain('verified nothing');
  });

  it('reports a check it could not run as unverified, never as a pass', () => {
    // web-ci needs the site dependencies. In a scratch repository they are
    // absent, so the check must come back as "could not run" with a non-zero
    // exit -- the one thing a verifier must never do is look green while
    // inspecting nothing.
    const repo = scratchRepo();

    try {
      touch(repo, 'web/src/pages/index.astro');
      const run = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' });

      expect(run.status).toBe(2);
      expect(run.stdout).toContain('COULD NOT RUN');
      expect(run.stdout).toContain('This is not a pass');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 1 and says so when a selected check fails', () => {
    // A scratch repository has the path that selects skills-ci but none of the
    // gate scripts that check runs, so the commands really fail.
    const repo = scratchRepo();

    try {
      touch(repo, '.github/scripts/something.mjs');
      const run = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain('FAIL');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 only when the commands really ran and really passed', () => {
    // The companion to the failure case, and the more important of the two. An
    // exit of 1 proves nothing on its own: a command that was never spawned also
    // exits non-zero, which is how a Windows quoting bug once turned every
    // node-based check red while this suite stayed green. Standing in the three
    // scripts that skills-ci runs, each exiting 0, distinguishes "the check ran
    // and passed" from "the check could not start".
    const repo = scratchRepo();

    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

      // The two gate scripts are published rather than changed, so they stand in
      // for commands that exist without widening the diff: the change itself is
      // the one file under .github/scripts/, which selects skills-ci alone.
      for (const stub of [
        '.github/skills/modeltree-gates/scripts/gates.test.mjs',
        '.github/skills/modeltree-gates/scripts/gate-dataset.mjs',
      ]) {
        const target = join(repo, stub);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'process.stdout.write("stub ok\\n");\n');
      }
      git('add', '-A');
      git('commit', '-qm', 'publish the gate scripts');
      git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());

      const changed = join(repo, '.github/scripts/check-skill-doc-test-counts.mjs');
      mkdirSync(dirname(changed), { recursive: true });
      writeFileSync(changed, 'process.stdout.write("stub ok\\n");\n');

      const run = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' });

      expect(run.stdout).toContain('stub ok');
      expect(run.stdout).toContain('PASS');
      expect(run.stdout).not.toContain('FAIL');
      expect(run.status).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 2 rather than guessing when there is no published history to measure against', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-preflight-unpublished-'));

    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 'preflight@example.com');
      git('config', 'user.name', 'Preflight Test');
      git('config', 'core.autocrlf', 'false');
      writeFileSync(join(dir, 'seed.txt'), 'seed\n');
      git('add', '-A');
      git('commit', '-qm', 'seed');

      const run = spawnSync(process.execPath, [script, '--repo', dir], { encoding: 'utf8' });

      expect(run.status).toBe(2);
      expect(run.stderr).toContain('refs/remotes/origin/main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the preflight states what it does not cover', () => {
  it('carries the uncovered list in its machine-readable output', () => {
    expect(baseline.notCovered.length).toBeGreaterThan(0);

    for (const entry of baseline.notCovered) {
      expect(entry.what.length).toBeGreaterThan(0);
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });

  it('prints the uncovered list on a run that failed, not only on a plan', () => {
    // The inference this whole issue is about is formed at the moment somebody
    // reads a result, so the limits have to travel with every result.
    const repo = scratchRepo();

    try {
      touch(repo, '.github/scripts/something.mjs');
      const run = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' });

      expect(run.stdout).toContain('does NOT cover');
      expect(run.stdout).toContain('the `source-link-health` check');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('names the source-link-health check as deliberately excluded rather than forgotten', () => {
    const excluded = baseline.notCovered.find((entry) => entry.check === 'source-link-health');

    expect(excluded).toBeDefined();
    expect(excluded?.why).toContain('network');
  });
});
