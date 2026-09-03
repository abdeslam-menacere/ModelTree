import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

/**
 * `.github/workflows/aggregate-checks.yml` is the one status check that reports
 * on every pull request and is red whenever a path-filtered check on the same
 * pull request is not green (abdeslam-menacere/ModelTree#710).
 *
 * Its whole value rests on one distinction: a check that was *skipped* and a
 * check that *never triggered* are both green, while a check that failed, was
 * cancelled, timed out, or was expected and never reported is not. An
 * aggregator that cannot tell those apart is worse than no aggregator, because
 * it launders a real failure into a required green.
 *
 * So the behaviour is not read off the source here, it is executed. Each case
 * below stands up a local HTTP server that answers the two GitHub endpoints the
 * script reads, runs the real script against it, and asserts the real exit
 * code. The fixtures are shaped after real measurements: pull request 715,
 * whose rollup carries seven checks and no `adr-numbers` at all because it
 * touched no decision record, and pull request 816, whose rollup carries ten
 * including `adr-numbers` and both `pytest` legs.
 *
 * The structural cases read the committed YAML and compare it against the
 * script's copy of it, for the same reason `ci-preflight.test.ts` does: a copy
 * can drift from its original, and a path filter that changes in one place must
 * turn this red rather than quietly narrowing what the aggregator expects.
 *
 * What this cannot test is stated rather than implied: nothing here runs on
 * GitHub's infrastructure, so it verifies the script's reading of check-run
 * JSON and not GitHub's production of it. The claim that a non-triggered
 * workflow reports no check run at all is measured from real pull requests
 * above, not asserted here.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, '.github', 'scripts', 'aggregate-checks.mjs');
const workflowDir = join(repoRoot, '.github', 'workflows');

// One case waits out the script's settle period, which is deliberately longer
// than the default per-test budget, and several more spawn a child process and
// a server. Raised for the same reason `ci-preflight.test.ts` raises its own.
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
const workflows = new Map(
  workflowFiles.map((file) => [
    file,
    mapping(parse(readFileSync(join(workflowDir, file), 'utf8')) as YamlValue, file),
  ]),
);

function expand(name: string, leg: Record<string, string>): string {
  return name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (whole, key: string) => leg[key] ?? whole);
}

function matrixLegs(job: YamlMapping, label: string): Record<string, string>[] {
  if (job.strategy === undefined) return [{}];

  const matrix = mapping(mapping(job.strategy, `${label}.strategy`).matrix, `${label}.strategy.matrix`);
  let legs: Record<string, string>[] = [{}];

  for (const [key, rawValues] of Object.entries(matrix)) {
    const values = sequence(rawValues, `${label}.strategy.matrix.${key}`);
    legs = legs.flatMap((leg) => values.map((value) => ({ ...leg, [key]: String(value) })));
  }

  return legs;
}

/**
 * Every status check a committed workflow can report on a pull request, under
 * the name GitHub reports it. A job skipped by its own `if:` still reports, so
 * it counts here and has to be accounted for one way or the other.
 */
function reportedPullRequestChecks(): { check: string; workflowFile: string }[] {
  const reported: { check: string; workflowFile: string }[] = [];

  for (const [file, parsed] of workflows) {
    const triggers = mapping(parsed.on, `${file}.on`);
    if (!Object.hasOwn(triggers, 'pull_request')) continue;

    for (const [jobId, rawJob] of Object.entries(mapping(parsed.jobs, `${file}.jobs`))) {
      const job = mapping(rawJob, `${file}.jobs.${jobId}`);
      const name = typeof job.name === 'string' ? job.name : jobId;
      for (const leg of matrixLegs(job, `${file}.jobs.${jobId}`)) {
        reported.push({ check: expand(name, leg), workflowFile: file });
      }
    }
  }

  return reported;
}

interface WatchedEntry {
  workflow: string;
  job: string;
  checks: string[];
  trigger: { kind: 'workflow-paths'; paths: string[] } | { kind: 'always' };
}

interface Configuration {
  watched: WatchedEntry[];
  excluded: { check: string; why: string }[];
}

interface CheckRunFixture {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  started_at?: string;
}

interface ApiFixture {
  /** The paths `/pulls/{n}/files` reports, which is what GitHub matches a `paths:` filter against. */
  files: string[];
  /** The check runs reported on the head commit. */
  checkRuns: CheckRunFixture[];
  /** What the pull request itself claims, so a truncated file list can be caught. */
  changedFilesCount?: number;
  /** Which status every endpoint answers with instead of data. */
  failWith?: number;
  /** Which status only the check-runs endpoint answers with, leaving the rest healthy. */
  failCheckRunsWith?: number;
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

const CONFIGURATION_MARKER = 'aggregate-checks configuration: ';

function configurationFrom(stdout: string): Configuration {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(CONFIGURATION_MARKER));
  if (line === undefined) {
    throw new Error(`the script printed no configuration line. stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(CONFIGURATION_MARKER.length)) as Configuration;
}

/** The fixture API, serving the two endpoints the script reads and nothing else. */
function apiServer(fixture: ApiFixture): Promise<{ server: Server; origin: string }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (fixture.failWith !== undefined) {
      send(fixture.failWith, { message: 'fixture failure' });
      return;
    }

    if (url.pathname.endsWith('/files')) {
      const page = Number(url.searchParams.get('page') ?? '1');
      send(200, page === 1 ? fixture.files.map((filename) => ({ filename })) : []);
      return;
    }

    if (url.pathname.endsWith('/check-runs')) {
      if (fixture.failCheckRunsWith !== undefined) {
        send(fixture.failCheckRunsWith, { message: 'fixture check-runs failure' });
        return;
      }
      const page = Number(url.searchParams.get('page') ?? '1');
      const runs = page === 1 ? fixture.checkRuns : [];
      send(200, { total_count: fixture.checkRuns.length, check_runs: runs });
      return;
    }

    if (/\/pulls\/\d+$/.test(url.pathname)) {
      send(200, { changed_files: fixture.changedFilesCount ?? fixture.files.length });
      return;
    }

    send(404, { message: `no fixture for ${url.pathname}` });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

/**
 * Run the real script against a fixture API and return its real exit code.
 *
 * `spawn` rather than `spawnSync` is load-bearing: the fixture server lives in
 * this process, and a synchronous spawn blocks the event loop that would have
 * answered it.
 */
async function runAgainst(fixture: ApiFixture, overrides: Record<string, string> = {}): Promise<Outcome> {
  const { server, origin } = await apiServer(fixture);

  try {
    return await new Promise<Outcome>((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          GITHUB_API_URL: origin,
          GITHUB_REPOSITORY: 'abdeslam-menacere/ModelTree',
          GITHUB_TOKEN: 'fixture-token',
          PR_NUMBER: '710',
          PR_HEAD_SHA: '0cc77e908785ba8e8277229cb81a4c0b4cf963a7',
          // Kept off, so nothing here writes to a summary file the runner owns.
          GITHUB_STEP_SUMMARY: '',
          ...overrides,
        },
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const WATCHED_NAMES = [
  'adr-numbers',
  'instruction-references',
  'pytest (Python 3.11)',
  'pytest (Python 3.13)',
  'source-link-health-tests',
];

/**
 * A rollup in which every watched check reported and passed, plus the unwatched
 * entries a real pull request carries. Shaped after pull request 816's real
 * rollup so the fixture is not a convenient subset of what GitHub sends.
 */
function allGreen(): CheckRunFixture[] {
  return [
    ...WATCHED_NAMES,
    'web-ci',
    'skills-ci',
    'web-e2e',
    'source-link-health',
  ].map((name) => ({ name, status: 'completed' as const, conclusion: 'success', started_at: '2026-09-01T00:00:00Z' }))
    .concat(
      ['Open or update the link-health issue', 'Resolve the link-health issue'].map((name) => ({
        name,
        status: 'completed' as const,
        conclusion: 'skipped',
        started_at: '2026-09-01T00:00:00Z',
      })),
    );
}

/** The same rollup with one watched check replaced. */
function withCheck(name: string, patch: Partial<CheckRunFixture>): CheckRunFixture[] {
  return allGreen().map((run) => (run.name === name ? { ...run, ...patch } : run));
}

/** The same rollup with one watched check removed entirely, as a never-triggered one is. */
function withoutChecks(names: string[]): CheckRunFixture[] {
  return allGreen().filter((run) => !names.includes(run.name));
}

/** A change that triggers no watched path filter. */
const WEB_ONLY_FILES = ['web/src/pages/index.astro', 'web/src/lib/comparison.ts'];

/** A change that triggers `adr-numbers` and both `pytest` legs. */
const ADR_FILES = ['docs/adr/0099-a-decision.md'];

describe('the aggregate check reads a rollup the way a reviewer has to', () => {
  it('passes when every watched check reported and succeeded', async () => {
    // The positive control. Every red result below is only worth something
    // because this harness can also produce a green one.
    const outcome = await runAgainst({ files: ADR_FILES, checkRuns: allGreen() });

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('Every watched check passed, was skipped, or was never triggered.');
  });

  it('fails when a watched check failed', async () => {
    const outcome = await runAgainst({
      files: ADR_FILES,
      checkRuns: withCheck('adr-numbers', { conclusion: 'failure' }),
    });

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(1);
    expect(outcome.stdout).toContain('FAIL  adr-numbers: concluded failure');
  });

  it('passes when a watched check was skipped', async () => {
    // The other half of the distinction the job exists for: a skip is a
    // legitimate green, and treating it as a failure would make the check
    // unrequirable for exactly the reason the path-filtered ones already are.
    const outcome = await runAgainst({
      files: ADR_FILES,
      checkRuns: withCheck('adr-numbers', { conclusion: 'skipped' }),
    });

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('PASS  adr-numbers: concluded skipped');
  });

  it('fails when a watched check was cancelled', async () => {
    // Cancellation is routine here -- several workflows set
    // `cancel-in-progress` for pull requests -- and it is still not a pass. It
    // is the absence of a verdict, and the commit it belongs to was not
    // verified.
    const outcome = await runAgainst({
      files: ADR_FILES,
      checkRuns: withCheck('adr-numbers', { conclusion: 'cancelled' }),
    });

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(1);
    expect(outcome.stdout).toContain('FAIL  adr-numbers: concluded cancelled');
  });

  it('fails when a watched check timed out', async () => {
    const outcome = await runAgainst({
      files: ADR_FILES,
      checkRuns: withCheck('pytest (Python 3.13)', { conclusion: 'timed_out' }),
    });

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(1);
    expect(outcome.stdout).toContain('FAIL  pytest (Python 3.13): concluded timed_out');
  });

  it.each(['neutral', 'action_required', 'stale', null])(
    'fails when a watched check concluded %s, which is not evidence it passed',
    async (conclusion) => {
      const outcome = await runAgainst({
        files: ADR_FILES,
        checkRuns: withCheck('instruction-references', { conclusion }),
      });

      expect(outcome.status, outcome.stdout + outcome.stderr).toBe(1);
    },
  );

  it('reads a re-run as the verdict that stands, in both directions', async () => {
    const failedThenPassed: CheckRunFixture[] = [
      ...withoutChecks(['adr-numbers']),
      { name: 'adr-numbers', status: 'completed', conclusion: 'failure', started_at: '2026-09-01T00:00:00Z' },
      { name: 'adr-numbers', status: 'completed', conclusion: 'success', started_at: '2026-09-01T01:00:00Z' },
    ];
    const passedThenFailed: CheckRunFixture[] = [
      ...withoutChecks(['adr-numbers']),
      { name: 'adr-numbers', status: 'completed', conclusion: 'success', started_at: '2026-09-01T00:00:00Z' },
      { name: 'adr-numbers', status: 'completed', conclusion: 'failure', started_at: '2026-09-01T01:00:00Z' },
    ];

    const recovered = await runAgainst({ files: ADR_FILES, checkRuns: failedThenPassed });
    const regressed = await runAgainst({ files: ADR_FILES, checkRuns: passedThenFailed });

    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
    expect(regressed.status, regressed.stdout + regressed.stderr).toBe(1);
  });
});

describe('an absent check is read by what the change touched, never by hope', () => {
  it('passes when a path-filtered check was never triggered', async () => {
    // Measured on pull request 715: a change confined to `web/` produces a
    // rollup with no `adr-numbers` entry at all. That is a green, and it is the
    // reason the naive fix of requiring `adr-numbers` deadlocks.
    const outcome = await runAgainst({
      files: WEB_ONLY_FILES,
      checkRuns: withoutChecks(['adr-numbers', 'instruction-references', 'pytest (Python 3.11)', 'pytest (Python 3.13)']),
    });

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('PASS  adr-numbers: no changed file matches its path filter');
  });

  it('refuses to pass when a check the change should have triggered never reported', async () => {
    // The case that separates this from a naive aggregator. The rollup looks
    // exactly like the one above -- `adr-numbers` simply absent -- and here it
    // is a change to `docs/adr/`, so absence is not "never triggered", it is
    // "not reported yet, or never going to". Neither is a pass.
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: withoutChecks(['adr-numbers']) },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('expected and never reported: adr-numbers');
  });

  it('expects a check whose filter matches one literal file, not only a directory', async () => {
    const outcome = await runAgainst(
      {
        files: ['.github/workflows/instruction-references.yml'],
        checkRuns: withoutChecks(['instruction-references']),
      },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('expected and never reported: instruction-references');
  });

  it('expects the unfiltered check on every change, because its workflow always starts', async () => {
    const outcome = await runAgainst(
      { files: WEB_ONLY_FILES, checkRuns: withoutChecks(['source-link-health-tests']) },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('expected and never reported: source-link-health-tests');
  });
});

describe('a run that could not answer is never a pass', () => {
  it('refuses to pass while a watched check is still running', async () => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: withCheck('adr-numbers', { status: 'in_progress', conclusion: null }) },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('still running: adr-numbers');
  });

  it('refuses to pass when the changed-file list cannot be read at all', async () => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: allGreen(), failWith: 500 },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('could not read the changed-file list');
  });

  it('refuses to pass when the checks API stops answering mid-poll', async () => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: allGreen(), failCheckRunsWith: 503 },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('the checks API is not answering');
  });

  it('refuses to pass when the changed-file list came back truncated', async () => {
    // A short list shrinks the expected set, which is the one direction that
    // turns an absence into a false pass. So it stops the run instead.
    const outcome = await runAgainst(
      { files: WEB_ONLY_FILES, checkRuns: allGreen(), changedFilesCount: 4000 },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('truncated list');
  });

  it('says so in the word, rather than reporting a failing check it did not see', async () => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: withoutChecks(['adr-numbers']) },
      { AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.stderr).toContain('could not determine an answer');
    expect(outcome.stderr).toContain('That is not a pass.');
  });

  it('states what it watched even on a run that ended undetermined', async () => {
    const outcome = await runAgainst({ files: [], checkRuns: [], failWith: 503 }, {
      AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5',
    });

    expect(outcome.status).toBe(2);
    expect(configurationFrom(outcome.stdout).watched.flatMap((entry) => entry.checks).sort()).toEqual(
      [...WATCHED_NAMES].sort(),
    );
  });
});

describe('the aggregate check always reports, which is what makes it requirable', () => {
  function aggregate(): YamlMapping {
    const parsed = workflows.get('aggregate-checks.yml');
    if (parsed === undefined) {
      throw new Error('aggregate-checks.yml is not committed, so nothing here can mean anything');
    }
    return parsed;
  }

  function aggregateJob(): YamlMapping {
    return mapping(mapping(aggregate().jobs, 'jobs')['aggregate-checks'], 'jobs.aggregate-checks');
  }

  it('carries no trigger path filter, so it starts on every pull request', () => {
    const triggers = mapping(aggregate().on, 'on');
    expect(Object.hasOwn(triggers, 'pull_request')).toBe(true);

    // `on: pull_request:` with no value parses as a null-valued key, which is
    // the shape that has no filter. Anything else must have no `paths` key.
    const pullRequest = triggers.pull_request;
    if (pullRequest !== null) {
      expect(Object.hasOwn(mapping(pullRequest, 'on.pull_request'), 'paths')).toBe(false);
    }
  });

  it('reports under a name branch protection can be given, with no matrix to vary it', () => {
    const jobs = mapping(aggregate().jobs, 'jobs');
    expect(Object.keys(jobs)).toEqual(['aggregate-checks']);

    const job = aggregateJob();
    expect(job.name).toBe('aggregate-checks');
    expect(job.strategy, 'a matrix would vary the reported check name per leg').toBeUndefined();
  });

  it('has no step that can hide or relax a verdict', () => {
    const job = aggregateJob();
    const steps = sequence(job.steps, 'steps').map((step, index) => mapping(step, `steps[${index}]`));

    expect(job['continue-on-error']).toBeUndefined();
    for (const step of steps) {
      expect(step['continue-on-error'], `${String(step.name)} must not swallow its own failure`).toBeUndefined();
    }

    const source = readFileSync(join(workflowDir, 'aggregate-checks.yml'), 'utf8');
    expect(source).not.toContain('always()');
    expect(source).not.toContain('|| true');
  });

  it('runs the script with no arguments, so there is no flag to relax', () => {
    const runs = sequence(aggregateJob().steps, 'steps')
      .map((step, index) => mapping(step, `steps[${index}]`))
      .filter((step) => typeof step.run === 'string')
      .map((step) => String(step.run).trim());

    expect(runs).toEqual(['node .github/scripts/aggregate-checks.mjs']);
  });
});

describe('the watched set is the workflows own triggers, not a restatement of them', () => {
  let configuration: Configuration | undefined;

  async function readConfiguration(): Promise<Configuration> {
    if (configuration === undefined) {
      const outcome = await runAgainst({ files: WEB_ONLY_FILES, checkRuns: allGreen() });
      configuration = configurationFrom(outcome.stdout);
    }
    return configuration;
  }

  it('copies the path filter of every watched path-filtered workflow exactly', async () => {
    const { watched } = await readConfiguration();
    const filtered = watched.filter((entry) => entry.trigger.kind === 'workflow-paths');
    expect(filtered.length).toBeGreaterThan(0);

    for (const entry of filtered) {
      const parsed = workflows.get(entry.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${entry.workflow}`);

      const pullRequest = mapping(mapping(parsed.on, 'on').pull_request, `${entry.workflow} on.pull_request`);
      const paths = sequence(pullRequest.paths, `${entry.workflow} on.pull_request.paths`).map(String);

      expect(
        entry.trigger.kind === 'workflow-paths' ? entry.trigger.paths : [],
        `${entry.workflow} filter must be copied exactly, or an absent check is misread`,
      ).toEqual(paths);
    }
  });

  it('claims no filter for a workflow that has one, and none for one that has not', async () => {
    const { watched } = await readConfiguration();
    const always = watched.filter((entry) => entry.trigger.kind === 'always');
    expect(always.length).toBeGreaterThan(0);

    for (const entry of always) {
      const parsed = workflows.get(entry.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${entry.workflow}`);

      const pullRequest = mapping(parsed.on, 'on').pull_request;
      const hasPaths = pullRequest !== null && Object.hasOwn(mapping(pullRequest, 'on.pull_request'), 'paths');

      expect(hasPaths, `${entry.workflow} is treated as unfiltered and must be one`).toBe(false);
    }
  });

  it('watches only check names a committed workflow actually reports', async () => {
    const { watched } = await readConfiguration();
    const reported = new Set(reportedPullRequestChecks().map(({ check }) => check));

    for (const check of watched.flatMap((entry) => entry.checks)) {
      expect(reported.has(check), `${check} is watched but no workflow reports it`).toBe(true);
    }
  });

  it('accounts for every check a workflow can report, either watching it or excluding it by name', async () => {
    // The property that keeps this from going quietly out of date: a new
    // path-filtered workflow cannot be added without this file being confronted
    // with it, which is the failure mode that produced #710 in the first place.
    const { watched, excluded } = await readConfiguration();
    const accounted = new Set([...watched.flatMap((entry) => entry.checks), ...excluded.map((entry) => entry.check)]);

    const unaccounted = reportedPullRequestChecks()
      .map(({ check }) => check)
      .filter((check) => !accounted.has(check));

    expect(
      unaccounted,
      'a workflow reports a pull-request check that aggregate-checks neither watches nor excludes',
    ).toEqual([]);
  });

  it('excludes its own check, so it cannot wait on itself', async () => {
    const { excluded, watched } = await readConfiguration();

    expect(excluded.map((entry) => entry.check)).toContain('aggregate-checks');
    expect(watched.flatMap((entry) => entry.checks)).not.toContain('aggregate-checks');
  });

  it('never watches the network sweep, which must never be required', async () => {
    // `source-link-health` requests third-party URLs and went red on pull
    // request 772 with every required check green. Aggregating it into a
    // required check would require it by the back door.
    const { excluded, watched } = await readConfiguration();

    expect(watched.flatMap((entry) => entry.checks)).not.toContain('source-link-health');
    expect(excluded.find((entry) => entry.check === 'source-link-health')?.why).toMatch(/never be required/);
  });

  it('gives a reason for every exclusion', async () => {
    const { excluded } = await readConfiguration();

    for (const entry of excluded) {
      expect(entry.why.length, `${entry.check} is excluded with no reason`).toBeGreaterThan(20);
    }
  });
});
