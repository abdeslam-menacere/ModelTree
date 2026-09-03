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
  // 'mirror' stands in for a CI check; 'self' is the preflight verifying itself.
  // A self-check names no workflow and no job, so both are optional here.
  kind: 'mirror' | 'self';
  checks: string[];
  workflow?: string;
  job?: string;
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

/**
 * The two kinds of entry in the script's table, kept apart on purpose.
 *
 * A **mirror** stands in for a check some committed workflow reports on a pull
 * request. Every assertion below that reads a workflow -- that the trigger is
 * copied exactly, that each local command maps onto a real step, that no CI
 * check is invented -- applies to mirrors and only to mirrors, because only a
 * mirror has an original to be compared against.
 *
 * A **self-check** is the preflight verifying itself. It mirrors nothing, names
 * no workflow and no job, and claims no CI check, so those same assertions have
 * nothing to compare it to and would either throw or read it as a false claim.
 * Filtering it out is therefore not a weakening: it is the only reading under
 * which the assertion means what it says. The corresponding obligation -- that a
 * self-check claims no CI check at all -- is asserted directly below rather than
 * left to the entry's name to imply.
 */
function mirrors(): PlanCheck[] {
  return allChecks().filter((check) => check.kind === 'mirror');
}

function selfChecks(): PlanCheck[] {
  return allChecks().filter((check) => check.kind === 'self');
}

/**
 * The workflow and job a mirror stands for.
 *
 * Throws rather than substituting a placeholder: a mirror that names neither is
 * a self-check that slipped past the kind filter, and that must stop the test
 * rather than quietly compare nothing.
 */
function originOf(check: PlanCheck): { workflow: string; job: string } {
  const { workflow, job } = check;
  if (workflow === undefined || job === undefined) {
    throw new Error(`${check.id} names no workflow or job, so it mirrors nothing`);
  }
  return { workflow, job };
}

describe('the preflight knows about every check CI can report on a pull request', () => {
  it('labels every entry as either a mirror of a CI check or its own self-check', () => {
    // No third kind, and no entry without one: an unlabelled entry would fall
    // out of both the mirror assertions and the self-check assertion and be
    // verified by neither.
    expect(allChecks().length).toBe(mirrors().length + selfChecks().length);
    expect(mirrors().length).toBeGreaterThan(0);
    expect(selfChecks().length).toBeGreaterThan(0);
  });

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
    const claimed = mirrors().flatMap((check) => check.checks);

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.filter((check) => !reported.has(check))).toEqual([]);
  });

  it('lets no self-check pass itself off as a reported CI check', () => {
    // The other half of the mirror/self split. A self-check is exempted from the
    // assertion above only because it claims nothing; if one ever did claim a
    // check name, the exemption would become a hole and this fails instead.
    for (const check of selfChecks()) {
      expect(check.checks, `${check.id} is a self-check and must claim no CI check`).toEqual([]);
      expect(check.workflow, `${check.id} mirrors no workflow`).toBeUndefined();
      expect(check.job, `${check.id} mirrors no job`).toBeUndefined();
    }
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
      const { workflow } = originOf(check);
      const parsed = workflows.get(workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${workflow}`);

      const pullRequest = mapping(mapping(parsed.on, 'on').pull_request, `${workflow} on.pull_request`);
      const paths = sequence(pullRequest.paths, `${workflow} on.pull_request.paths`).map(String);

      expect(check.trigger.paths, `${check.id} must copy ${workflow}'s paths filter`).toEqual(paths);
    }
  });

  it('copies the in-job scope pattern of every unfiltered workflow exactly', () => {
    const scoped = allChecks().filter((check) => check.trigger.kind === 'in-job-scope');
    expect(scoped.length).toBeGreaterThan(0);

    for (const check of scoped) {
      const { workflow, job: jobName } = originOf(check);
      const parsed = workflows.get(workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${workflow}`);

      const job = mapping(mapping(parsed.jobs, 'jobs')[jobName], `jobs.${jobName}`);
      const scopeStep = sequence(job.steps, `jobs.${jobName}.steps`)
        .map((step, index) => mapping(step, `jobs.${jobName}.steps[${index}]`))
        .find((step) => step.id === 'scope');

      if (scopeStep === undefined) throw new Error(`no scope step in ${workflow} jobs.${jobName}`);

      // The ERE the workflow greps the changed-file list with, read out of the
      // committed script rather than restated, exactly as skills-ci.test.ts does.
      const pattern = String(scopeStep.run).match(/grep -Eq '([^']+)'/)?.[1];

      expect(pattern, `${workflow} jobs.${jobName} must grep with a single-quoted ERE`).toBeDefined();
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
    for (const check of mirrors()) {
      const { workflow, job: jobName } = originOf(check);
      const parsed = workflows.get(workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${workflow}`);

      const job = mapping(mapping(parsed.jobs, 'jobs')[jobName], `jobs.${jobName}`);
      const runs = sequence(job.steps, `jobs.${jobName}.steps`)
        .map((step, index) => mapping(step, `jobs.${jobName}.steps[${index}]`))
        .filter((step) => typeof step.run === 'string')
        .map((step) => String(step.run).trim());

      expect(check.commands.length).toBeGreaterThan(0);

      for (const command of check.commands) {
        expect(
          runs,
          `${check.id} runs "${command.local}" locally, which claims to stand for "${command.ciRun}" `
            + `in ${workflow} jobs.${jobName}, but that job runs no such step`,
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

  it('runs its own fidelity tests whenever a workflow changes, whichever mirrors were selected', () => {
    // The regression this test exists for. Every mirror above is a *copy* of a
    // workflow's trigger and commands, and the fidelity tests in this file are
    // what stop a copy drifting from its original -- but they run under
    // `web-ci`, whose scope is `^(web/|...web-ci\.yml$)`. So editing
    // `skills-ci.yml` selected `skills-ci` alone, the fidelity tests were never
    // chosen, and a workflow edit that made the script's copy wrong still
    // reported PASS. The guard was not missing; it was never selected.
    //
    // Asserted per workflow rather than on one example, so a workflow added
    // later is covered without anyone remembering to extend this list.
    for (const workflow of readdirSync(workflowDir).filter((name) => name.endsWith('.yml'))) {
      const selected = selectionFor([`.github/workflows/${workflow}`]);
      expect(
        selected,
        `a change to ${workflow} must select the preflight's own fidelity tests`,
      ).toContain('preflight-self-check');
    }
  });

  it('runs its own fidelity tests when the script or those tests change', () => {
    // The other two ways the copy and the original can be made to disagree:
    // editing the copy, and editing the test that compares them.
    expect(selectionFor(['.github/scripts/ci-preflight.mjs'])).toContain('preflight-self-check');
    expect(selectionFor(['web/tests/workflows/ci-preflight.test.ts'])).toContain('preflight-self-check');
  });

  it('does not run the self-check on a change that touches no workflow and no preflight file', () => {
    // The paired control. A self-check selected by everything would be noise,
    // and would say nothing about whether selection actually follows the change.
    expect(selectionFor(['web/src/data/releases.json'])).not.toContain('preflight-self-check');
    expect(selectionFor(['.github/skills/modeltree-gates/SKILL.md'])).not.toContain('preflight-self-check');
    expect(selectionFor(['docs/adr/0006-a-decision.md'])).not.toContain('preflight-self-check');
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

  it('exits 2 from --help, because printing usage verifies nothing', () => {
    // The same rule --plan is held to, and the one this script published about
    // itself: the only zero it emits is one that was earned. --help earns none.
    for (const flag of ['--help', '-h']) {
      const run = spawnSync(process.execPath, [script, flag], { encoding: 'utf8' });

      expect(run.stdout, `${flag} should still print usage`).toContain('usage: ci-preflight.mjs');
      expect(run.status, `${flag} must not exit 0`).toBe(2);
    }
  });

  it('exits 2 when it selected nothing, rather than reporting a pass for a run that did nothing', () => {
    // The dangerous reading of an empty selection. No check is selected, so
    // there is no failure and no unknown to count, and a tally of only those two
    // returns 0 from a run in which no command executed. A dock reading that
    // PASS concludes CI is clear on the strength of a check that never ran --
    // the exact inference this script exists to prevent.
    const repo = scratchRepo();

    try {
      // A path no pull-request check reads: not under web/, .github/, tools/ or
      // docs/adr/. The tree is otherwise identical to published history.
      touch(repo, 'docs/product/BACKLOG.md');
      const run = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' });

      expect(run.stdout).toContain('NOTHING SELECTED');
      expect(run.stdout).not.toContain('PASS');
      expect(run.status).toBe(2);

      // Exit 2 now carries two readings, so a caller that never parses the prose
      // still has to be able to tell "nothing to check" from "a check could not
      // run". Same separation gate-scope.mjs makes for its own exit 0.
      const json = spawnSync(process.execPath, [script, '--repo', repo, '--json'], { encoding: 'utf8' });
      const report = JSON.parse(json.stdout) as { empty: boolean; passed: boolean; exitCode: number };

      expect(report.empty).toBe(true);
      expect(report.passed).toBe(false);
      expect(report.exitCode).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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

/*
 * abdeslam-menacere/ModelTree#663. Under `--json` the script ran every child
 * with `stdio: 'ignore'`, so a failing check survived only as `"npm run test"
 * exited 1` -- an exit code and nothing else. A flake, a real regression, a
 * missing dependency and a typo in a script were byte-identical, and nobody
 * reading the result could tell which they had.
 *
 * The measured cost is cross-issue identity. #517 and #720 were one defect seen
 * from two ends, and the only reason that was noticed is that a report named
 * the failing test and the 5000 ms figure it timed out at instead of saying
 * "flake". Under `--json` that report could not have been written at all.
 *
 * So these cases assert the evidence exists *and* that it reaches a reader:
 * capturing output into a field nothing prints would be the same defect wearing
 * a different hat. Each one that proves new behaviour fails against the
 * `stdio: 'ignore'` implementation, which is the only kind of assertion worth
 * having here.
 */
describe('a failing check carries its own evidence', () => {
  // The two things a reader needs and an exit code cannot give: which test
  // failed, and the figure it failed on. Split across the two streams on
  // purpose, so an assertion finding both proves they were captured together
  // and in order rather than one of them being captured alone.
  const FAILING_TEST = 'tests/lineage/LineageModelDrawer.test.ts > opens the drawer';
  const TIMEOUT_FIGURE = 'Test timed out in 5000ms.';
  // Wide enough that a few thousand lines pass the retained-tail bound.
  const NOISE_LINES_OVER_THE_BOUND = 4000;

  interface RunCommand {
    label: string;
    command: string;
    status: 'pass' | 'fail' | 'unknown';
    exitCode?: number | null;
    output?: string;
    outputBytes?: number;
    outputTruncated?: boolean;
  }

  interface RunResult {
    id: string;
    status: 'pass' | 'fail' | 'unknown';
    reasons: string[];
    commands: RunCommand[];
  }

  interface RunReport {
    results: RunResult[];
    empty: boolean;
    passed: boolean;
    exitCode: number;
  }

  /**
   * A stand-in for a test runner that fails: coloured, across both streams, and
   * with the part a reader needs printed last, which is where a runner puts its
   * failure summary and why the tail is what gets kept.
   */
  function failingStub(noiseLines: number): string {
    return [
      `for (let i = 0; i < ${noiseLines}; i += 1) process.stdout.write("noise " + i + " ".repeat(60) + "\\n");`,
      // Coloured because CI is coloured. The codes land *inside* the phrase, so
      // a raw capture is not searchable for the test name -- the concrete
      // failure web/scripts/ansi.mjs was written for.
      `process.stdout.write("\\u001b[31mFAIL\\u001b[39m ${FAILING_TEST}\\n");`,
      `process.stderr.write("${TIMEOUT_FIGURE}\\n");`,
      'process.exit(1);',
      '',
    ].join('\n');
  }

  /**
   * A repository whose one changed file selects `skills-ci` alone, standing in
   * the gate scripts that check runs: the first passes, so the run reaches the
   * second, which fails. Published rather than changed, so the diff stays one
   * file and the selection stays the one the other cases here rely on.
   */
  function repoWithAFailingCheck(noiseLines = 0): string {
    const repo = scratchRepo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

    const stubs: [string, string][] = [
      [
        '.github/skills/modeltree-gates/scripts/gates.test.mjs',
        "import { test } from 'node:test';\ntest('stub passes', () => {});\n",
      ],
      ['.github/skills/modeltree-gates/scripts/gate-dataset.mjs', failingStub(noiseLines)],
    ];
    for (const [path, body] of stubs) {
      const target = join(repo, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    git('add', '-A');
    git('commit', '-qm', 'publish the gate scripts');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD').trim());

    touch(repo, '.github/scripts/something.mjs');
    return repo;
  }

  /** The machine-readable run, with stdout parsed rather than inspected. */
  function jsonRun(repo: string): {
    report: RunReport;
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const run = spawnSync(process.execPath, [script, '--repo', repo, '--json'], { encoding: 'utf8' });

    return {
      report: JSON.parse(run.stdout) as RunReport,
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  }

  function failingCommandOf(report: RunReport): RunCommand {
    const failed = report.results.find((result) => result.status === 'fail');
    const command = failed?.commands.find((entry) => entry.status === 'fail');

    expect(command, 'the run should have produced a failing command to report on').toBeDefined();
    return command as RunCommand;
  }

  it('puts the failing command output in the JSON, not only its exit code', () => {
    const repo = repoWithAFailingCheck();

    try {
      const { report, status } = jsonRun(repo);
      const command = failingCommandOf(report);

      // Both halves, so this cannot pass on a capture of one stream. The name
      // came from the child's stdout and the figure from its stderr.
      expect(command.output, 'the failing test name is the thing an exit code cannot give')
        .toContain(FAILING_TEST);
      expect(command.output, 'and the figure it failed on').toContain(TIMEOUT_FIGURE);
      expect(command.outputBytes).toBeGreaterThan(0);
      expect(command.outputTruncated).toBe(false);

      // The exit-code mapping is load-bearing and this changes none of it.
      expect(status).toBe(1);
      expect(report.exitCode).toBe(1);
      expect(report.passed).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps stdout a JSON document while it does that', () => {
    // `--json` exists to be machine-readable, so the evidence must not be
    // interleaved onto stdout. Parsed rather than eyeballed: a document that
    // merely looks like JSON is what a consumer would choke on.
    const repo = repoWithAFailingCheck();

    try {
      const run = spawnSync(process.execPath, [script, '--repo', repo, '--json'], { encoding: 'utf8' });

      expect(() => JSON.parse(run.stdout)).not.toThrow();
      expect(run.stdout.trimStart().startsWith('{'), 'nothing may precede the document').toBe(true);
      expect(run.stdout.trimEnd().endsWith('}'), 'and nothing may follow it').toBe(true);

      const report = JSON.parse(run.stdout) as RunReport;
      expect(report.results.length).toBeGreaterThan(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes the evidence to stderr too, where it needs no parser to be read', () => {
    // Captured into a field nobody prints is the same defect in a different
    // hat. stderr is free -- `--json` owns only stdout -- so the person running
    // the command sees the failing test without reaching for jq.
    const repo = repoWithAFailingCheck();

    try {
      const { stderr, stdout } = jsonRun(repo);

      expect(stderr).toContain(FAILING_TEST);
      expect(stderr).toContain(TIMEOUT_FIGURE);
      expect(stderr).toContain('skills-ci');
      // And the document on stdout is still intact beside it.
      expect(() => JSON.parse(stdout)).not.toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('strips the escape codes that would otherwise split the phrase being searched for', () => {
    const repo = repoWithAFailingCheck();

    try {
      // The live control first. In the default mode the child's bytes reach the
      // terminal untouched, so this proves the stub really did emit colour --
      // without it the stripping assertion below could pass vacuously.
      const inherited = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' });
      expect(inherited.stdout, 'the stub must really be colouring its output').toContain('\u001B[31m');

      const command = failingCommandOf(jsonRun(repo).report);

      expect(command.output).not.toContain('\u001B');
      expect(command.output, 'and the phrase survives whole rather than in fragments')
        .toContain(`FAIL ${FAILING_TEST}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('says when it kept only the tail, rather than passing an excerpt off as the whole', () => {
    // Silently truncated evidence that looks complete is this bug again, one
    // level down: a reader concludes from an excerpt what it does not support.
    const repo = repoWithAFailingCheck(NOISE_LINES_OVER_THE_BOUND);

    try {
      const { report, status } = jsonRun(repo);
      const command = failingCommandOf(report);

      expect(command.outputTruncated).toBe(true);
      expect(command.outputBytes).toBeGreaterThan(65536);
      expect(command.output, 'the cut is stated in the text as well as in the flag')
        .toContain('earlier output dropped');
      // The tail is kept because that is where a runner puts what failed. If
      // the head were kept instead, this is the assertion that would notice.
      expect(command.output).toContain(FAILING_TEST);
      expect(command.output).toContain(TIMEOUT_FIGURE);
      expect(status).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('attaches nothing to a command that passed, so the failure is not buried', () => {
    const repo = repoWithAFailingCheck();

    try {
      const failed = jsonRun(repo).report.results.find((result) => result.status === 'fail');
      const passed = failed?.commands.filter((entry) => entry.status === 'pass') ?? [];

      expect(passed.length, 'the first gate command should have passed').toBeGreaterThan(0);
      for (const entry of passed) {
        expect(Object.keys(entry)).not.toContain('output');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still streams to the terminal in the default mode, capturing nothing', () => {
    // The guard on the half that was never broken. Capture is for the mode that
    // cannot show output live; the human path must keep inheriting the terminal.
    const repo = repoWithAFailingCheck();

    try {
      const run = spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' });

      expect(run.stdout).toContain(FAILING_TEST);
      expect(run.stdout).toContain('FAIL');
      expect(run.status).toBe(1);

      // No capture happened, so no command carries an output field.
      const json = spawnSync(process.execPath, [script, '--repo', repo, '--plan', '--json'], {
        encoding: 'utf8',
      });
      expect(json.status, 'and --plan still verifies nothing').toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('leaves a check it could not run at exit 2, which capture must never make a pass', () => {
    // The direction that matters most. Capturing output changes what a failure
    // says, never what it counts as, and 2 is never a pass.
    const repo = scratchRepo();

    try {
      // web-ci needs web/node_modules, absent here, so it cannot run at all.
      touch(repo, 'web/src/pages/index.astro');
      const { report, status } = jsonRun(repo);

      expect(status).toBe(2);
      expect(report.exitCode).toBe(2);
      expect(report.passed).toBe(false);
      expect(report.empty, 'this is "could not run", not "nothing to check"').toBe(false);
      expect(report.results.some((result) => result.status === 'unknown')).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/*
 * abdeslam-menacere/ModelTree#678. `updater-pytest` declares three python-module
 * preconditions, and one of them tested something the suite never required.
 *
 * `tools/updater/tests/conftest.py` puts `tools/updater/src` on `sys.path`
 * before collection, so every test imports `modeltree_updater` whether or not
 * anything was installed. Probing it with a bare `import` therefore asked a
 * stricter question than the suite asks, and could fail in exactly one
 * direction: a false "could not run" where the suite passes completely. Four
 * sessions met that exit 2 -- on ADR-only and skills-only diffs, which select
 * this group too -- and every one of them ran the suite by hand and found it
 * green.
 *
 * The danger in fixing it is the opposite one, and it is the worse of the two: a
 * probe that stops exiting 2 by learning to say 0 is worse than the defect,
 * because the defect is at least loud. So the three cases below are the three
 * worlds the probe can be in, and the one that must still exit 2 is asserted as
 * hard as the one that must now run.
 */
describe('a precondition the suite bootstraps for itself is probed the way the suite imports it', () => {
  /** The interpreter the script would resolve, found the same way it finds it. */
  function resolvePython(): string | null {
    for (const candidate of ['python', 'python3']) {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
      if (!probe.error && probe.status === 0) return candidate;
    }
    return null;
  }

  const python = resolvePython();

  /** The environment the script runs in, with any inherited PYTHONPATH removed. */
  function envWithout(...extra: string[]): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of ['PYTHONPATH', ...extra]) delete env[name];
    return env;
  }

  /**
   * Whether this interpreter already has the package, asked with no PYTHONPATH.
   *
   * Two of the cases below need it absent, which is the state of every machine
   * this issue was reported from and of the runner this suite runs on -- nothing
   * in `web-ci` installs the updater. Where it is present the ordinary probe
   * legitimately succeeds and "could not run" would be the wrong assertion, so
   * those cases say so and skip rather than assert something false.
   */
  const installed = python !== null
    && spawnSync(python, ['-c', 'import modeltree_updater'], {
      stdio: 'ignore',
      env: envWithout(),
    }).status === 0;

  /** A directory holding an importable `modeltree_updater`, and nothing else. */
  function stubPackageIn(dir: string): string {
    const target = join(dir, 'modeltree_updater', '__init__.py');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '"""Stub: importable, and nothing more."""\n');
    return dir;
  }

  /** The phrase the run prints when, and only when, the fallback supplied it. */
  const FALLBACK_NOTE = 'was met through tools/updater/src';
  const UNMET = 'python cannot import modeltree_updater';

  it.skipIf(python === null || installed)(
    'exits 2 when the package is importable neither way, rather than running a suite that cannot import itself',
    () => {
      // The criterion that keeps this a fix and not a bypass. The scratch
      // repository has a path that selects the group and no `tools/updater/src`
      // for the fallback to find, so both attempts fail and the only honest
      // answer is could-not-run.
      const repo = scratchRepo();

      try {
        touch(repo, 'tools/updater/notes.txt');
        const run = spawnSync(process.execPath, [script, '--repo', repo], {
          encoding: 'utf8',
          env: envWithout(),
        });

        expect(run.stdout).toContain('COULD NOT RUN');
        expect(run.stdout).toContain(UNMET);
        expect(run.stdout).not.toContain(FALLBACK_NOTE);
        expect(run.stdout).not.toContain('PASS');
        expect(run.status).toBe(2);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(python === null || installed)(
    'runs the check when the package is importable only through the directory the suite bootstraps',
    () => {
      // The case the issue is about. Same interpreter and same absent install as
      // above; the only difference is that `tools/updater/src` now holds the
      // package, which is what the suite's own conftest.py puts on sys.path.
      const repo = scratchRepo();

      try {
        stubPackageIn(join(repo, 'tools', 'updater', 'src'));
        touch(repo, 'tools/updater/notes.txt');
        const run = spawnSync(process.execPath, [script, '--repo', repo], {
          encoding: 'utf8',
          env: envWithout(),
        });

        // The requirement is met, so the group is no longer refused over it.
        expect(run.stdout).not.toContain(UNMET);
        // And the reader is told which path met it, beside the verdict and in
        // the not-covered notice, because a result from a source tree and a
        // result from an installed package are different claims.
        expect(run.stdout).toContain(FALLBACK_NOTE);
        expect(run.stdout.match(new RegExp(FALLBACK_NOTE, 'g'))?.length ?? 0).toBeGreaterThan(1);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(python === null)(
    'never reaches for the fallback when the package imports on its own',
    () => {
      // The second criterion: with the package installed, behaviour is what it
      // was before the fallback existed. `PYTHONPATH` puts an importable
      // package on the interpreter's own search path, which is the state an
      // install produces, and `tools/updater/src` is deliberately left empty --
      // so a note here would mean the fallback ran when the ordinary import had
      // already answered.
      const repo = scratchRepo();
      const site = mkdtempSync(join(tmpdir(), 'ci-preflight-site-'));

      try {
        stubPackageIn(site);
        mkdirSync(join(repo, 'tools', 'updater', 'src'), { recursive: true });
        touch(repo, 'tools/updater/notes.txt');
        const run = spawnSync(process.execPath, [script, '--repo', repo], {
          encoding: 'utf8',
          env: { ...envWithout(), PYTHONPATH: site },
        });

        expect(run.stdout).not.toContain(UNMET);
        expect(run.stdout).not.toContain(FALLBACK_NOTE);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(site, { recursive: true, force: true });
      }
    },
  );
});