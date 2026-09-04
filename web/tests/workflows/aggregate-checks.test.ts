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
 * pull request is not green (abdeslam-menacere/ModelTree#710). It reports on
 * every merge queue entry too, for the same reason and by the same reading
 * (abdeslam-menacere/ModelTree#877).
 *
 * Its whole value rests on one distinction: a check that was *skipped* and a
 * check that *never triggered* are both green, while a check that failed, was
 * cancelled, timed out, or was expected and never reported is not. An
 * aggregator that cannot tell those apart is worse than no aggregator, because
 * it launders a real failure into a required green.
 *
 * So the behaviour is not read off the source here, it is executed. Each case
 * below stands up a local HTTP server that answers the GitHub endpoints the
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
 * above, not asserted here. The merge-group cases are further from their
 * subject still: no merge queue exists on this repository yet, so no
 * `merge_group` event has ever reached this script. They run it with the
 * environment GitHub documents for that event; the first live queue entry is
 * the integration test, which is why every path below fails closed.
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
 * Every status check a committed workflow can report on one event, under the
 * name GitHub reports it. A job skipped by its own `if:` still reports, so it
 * counts here and has to be accounted for one way or the other.
 */
function reportedChecksFor(event: string): { check: string; workflowFile: string }[] {
  const reported: { check: string; workflowFile: string }[] = [];

  for (const [file, parsed] of workflows) {
    const triggers = mapping(parsed.on, `${file}.on`);
    if (!Object.hasOwn(triggers, event)) continue;

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

function reportedPullRequestChecks(): { check: string; workflowFile: string }[] {
  return reportedChecksFor('pull_request');
}

interface WatchedEntry {
  workflow: string;
  job: string;
  checks: string[];
  triggers: Record<string, WatchedTrigger | undefined>;
}

type WatchedTrigger =
  | { kind: 'workflow-paths'; paths: string[] }
  | { kind: 'always' }
  | { kind: 'not-triggered' };

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
  /** Which status only the commit-comparison endpoint answers with. */
  failCompareWith?: number;
  /**
   * How many files the comparison reports, when the fixture needs a list longer
   * than `files`. Filled with distinct synthetic paths, so a run that reaches
   * the endpoint's own ceiling can be measured without writing 300 names out.
   */
  compareFileCount?: number;
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

/** The fixture API, serving the endpoints the script reads and nothing else. */
function apiServer(fixture: ApiFixture): Promise<{ server: Server; origin: string; requested: string[] }> {
  // Recorded so a test can assert *which* commit the check runs were read for,
  // rather than only that the exit code came out right. On a merge group the
  // head SHA is the whole of what makes the reading about the projected merge.
  const requested: string[] = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requested.push(url.pathname);

    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (fixture.failWith !== undefined) {
      send(fixture.failWith, { message: 'fixture failure' });
      return;
    }

    if (url.pathname.includes('/compare/')) {
      if (fixture.failCompareWith !== undefined) {
        send(fixture.failCompareWith, { message: 'fixture compare failure' });
        return;
      }
      const perPage = Number(url.searchParams.get('per_page') ?? '100');
      const page = Number(url.searchParams.get('page') ?? '1');
      const all = fixture.compareFileCount === undefined
        ? fixture.files
        : Array.from({ length: fixture.compareFileCount }, (_unused, index) => `web/src/generated/file-${index}.ts`);
      const start = (page - 1) * perPage;
      send(200, { files: all.slice(start, start + perPage).map((filename) => ({ filename })) });
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
      resolve({ server, origin: `http://127.0.0.1:${address.port}`, requested });
    });
  });
}

interface RunOutcome extends Outcome {
  /** Every API path the run asked for, in order. */
  requested: string[];
}

/**
 * Run the real script against a fixture API and return its real exit code.
 *
 * `spawn` rather than `spawnSync` is load-bearing: the fixture server lives in
 * this process, and a synchronous spawn blocks the event loop that would have
 * answered it.
 *
 * `GITHUB_EVENT_NAME` is set here rather than left to the ambient environment,
 * and that is not tidiness. The env is inherited from the process running the
 * suite, and `web-ci` now runs on `merge_group` too -- so on a queue entry the
 * real `GITHUB_EVENT_NAME=merge_group` would leak into every case below and the
 * pull-request ones would all end undetermined, inside the queue only. Pinning
 * it makes each case say which event it is about.
 */
async function runAgainst(fixture: ApiFixture, overrides: Record<string, string> = {}): Promise<RunOutcome> {
  const { server, origin, requested } = await apiServer(fixture);

  try {
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          GITHUB_API_URL: origin,
          GITHUB_REPOSITORY: 'abdeslam-menacere/ModelTree',
          GITHUB_TOKEN: 'fixture-token',
          GITHUB_EVENT_NAME: 'pull_request',
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

    return { ...outcome, requested };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The head and base a merge-group case runs under, and the event that selects them. */
const MERGE_GROUP_HEAD = 'f2f0f9b1c3a24d5e6f708192a3b4c5d6e7f80912';
const MERGE_GROUP_BASE = '216bdaed488595c6ab6b25e4568d59507079f1c5';
const MERGE_GROUP_ENV = {
  GITHUB_EVENT_NAME: 'merge_group',
  MERGE_GROUP_HEAD_SHA: MERGE_GROUP_HEAD,
  MERGE_GROUP_BASE_SHA: MERGE_GROUP_BASE,
  // Present and ignored, exactly as they are on a real queue entry where the
  // pull-request context interpolates to nothing. Set here to something valid
  // so that a case which passes only because they are absent cannot pass.
  PR_NUMBER: '710',
  PR_HEAD_SHA: '0cc77e908785ba8e8277229cb81a4c0b4cf963a7',
};

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

describe('a merge queue entry is read the same way, from the event it actually ran under', () => {
  // Nothing here runs on a real merge queue, and nothing can until one exists:
  // a `merge_group` event is produced by the queue, and the queue cannot safely
  // be enabled while a required context is unable to answer on that event
  // (abdeslam-menacere/ModelTree#877). So these cases run the real script with
  // the environment GitHub sets on that event and assert the real exit code.
  // What they establish is the script's reading; what they cannot establish is
  // GitHub's production of the event, which the first live queue entry tests.

  it('passes when every watched check reported and succeeded on the queue entry', async () => {
    // The positive control for this event, matching the pull-request one above.
    const outcome = await runAgainst({ files: ADR_FILES, checkRuns: allGreen() }, MERGE_GROUP_ENV);

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('Event: merge_group');
    expect(outcome.stdout).toContain('Every watched check passed, was skipped, or was never triggered.');
  });

  it('reads the check runs of the merge group head, not of any pull request', async () => {
    // The reading is only about the projected merge if it is anchored to the
    // commit GitHub built for it. Both SHAs are in the environment, so an
    // implementation that kept using the pull-request one would still come out
    // green above -- this is what separates them.
    const outcome = await runAgainst({ files: ADR_FILES, checkRuns: allGreen() }, MERGE_GROUP_ENV);

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain(`Head commit: ${MERGE_GROUP_HEAD}`);
    expect(outcome.requested.some((path) => path === `/repos/abdeslam-menacere/ModelTree/commits/${MERGE_GROUP_HEAD}/check-runs`)).toBe(true);
    expect(outcome.requested.some((path) => path.includes('/pulls/710'))).toBe(false);
  });

  it('takes the changed files from the base..head comparison', async () => {
    const outcome = await runAgainst({ files: ADR_FILES, checkRuns: allGreen() }, MERGE_GROUP_ENV);

    expect(outcome.requested).toContain(
      `/repos/abdeslam-menacere/ModelTree/compare/${MERGE_GROUP_BASE}...${MERGE_GROUP_HEAD}`,
    );
  });

  it('fails when a watched check failed on the queue entry', async () => {
    // Every failure the pull-request path closes has to stay closed here, or
    // the queue becomes a way to merge a red commit.
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: withCheck('adr-numbers', { conclusion: 'failure' }) },
      MERGE_GROUP_ENV,
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(1);
    expect(outcome.stdout).toContain('FAIL  adr-numbers: concluded failure');
  });

  it('refuses to pass while a watched check is still running on the queue entry', async () => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: withCheck('adr-numbers', { status: 'in_progress', conclusion: null }) },
      { ...MERGE_GROUP_ENV, AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('still running: adr-numbers');
  });

  it('expects the unfiltered-in-a-queue checks even when the change touches none of their paths', async () => {
    // The load-bearing difference between the two events, and the reason #860
    // is closed by a queue at all. `merge_group` supports no `paths:` filter,
    // so `adr-numbers` runs on every entry. Reading its absence through the
    // pull-request filter would call it never-triggered and pass -- which is
    // exactly the ADR collision walking through the queue unexamined.
    const files = WEB_ONLY_FILES;
    const checkRuns = withoutChecks(['adr-numbers', 'instruction-references', 'pytest (Python 3.11)', 'pytest (Python 3.13)']);

    const inQueue = await runAgainst({ files, checkRuns }, { ...MERGE_GROUP_ENV, AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' });
    const onPullRequest = await runAgainst({ files, checkRuns });

    // The pair is the control: the same fixture is a legitimate green on a pull
    // request, so the red below is the event and not the fixture.
    expect(onPullRequest.status, onPullRequest.stdout + onPullRequest.stderr).toBe(0);
    expect(inQueue.status, inQueue.stdout + inQueue.stderr).toBe(2);
    expect(inQueue.stderr).toContain('expected and never reported: adr-numbers');
  });

  it('passes when a workflow that has no merge_group trigger reports nothing', async () => {
    // `source-link-health.yml` is deliberately left off the queue: it requests
    // third-party URLs, and a network sweep must never be able to eject a merge.
    // Its absence there is legitimate, and the message says which reason it is.
    const outcome = await runAgainst(
      { files: WEB_ONLY_FILES, checkRuns: withoutChecks(['source-link-health-tests']) },
      MERGE_GROUP_ENV,
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain(
      'PASS  source-link-health-tests: its workflow has no merge_group trigger, so it does not run here',
    );
  });

  it('still fails a check that did report, from a workflow it does not expect to run there', async () => {
    // The absence rule above must not become an excuse. If the sweep does
    // report on a queue entry, its own conclusion decides.
    const outcome = await runAgainst(
      { files: WEB_ONLY_FILES, checkRuns: withCheck('source-link-health-tests', { conclusion: 'failure' }) },
      MERGE_GROUP_ENV,
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(1);
    expect(outcome.stdout).toContain('FAIL  source-link-health-tests: concluded failure');
  });

  it.each([
    ['MERGE_GROUP_HEAD_SHA', { MERGE_GROUP_HEAD_SHA: '' }],
    ['MERGE_GROUP_BASE_SHA', { MERGE_GROUP_BASE_SHA: '' }],
  ])('refuses to pass when %s is not set', async (name, missing) => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: allGreen() },
      { ...MERGE_GROUP_ENV, ...missing, AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain(`${name} is not set`);
  });

  it('refuses to pass when the comparison cannot be read', async () => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: allGreen(), failCompareWith: 500 },
      { ...MERGE_GROUP_ENV, AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('could not read the changed-file list');
  });

  it('refuses to pass when the comparison reached the ceiling the endpoint imposes', async () => {
    // The compare endpoint caps its file list at 300 and does not say so, and a
    // short list shrinks the expected set -- the one direction that turns an
    // absence into a false pass. So it ends the run instead.
    const outcome = await runAgainst(
      { files: [], checkRuns: allGreen(), compareFileCount: 300 },
      { ...MERGE_GROUP_ENV, AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('300-file ceiling');
  });

  it('reads a comparison that ends short of the ceiling', async () => {
    // The control for the case above: paginating at all must still work, or
    // that refusal is indistinguishable from a paginator that never terminates.
    const outcome = await runAgainst(
      { files: [], checkRuns: allGreen(), compareFileCount: 150 },
      MERGE_GROUP_ENV,
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain('Changed files: 150');
  });

  it.each(['push', 'workflow_dispatch', 'schedule', 'issue_comment'])(
    'refuses to answer at all on a %s event',
    async (eventName) => {
      // The exit-2 floor under the whole change: an event this script cannot
      // measure gets no verdict, rather than the green that an empty expected
      // set would otherwise produce.
      const outcome = await runAgainst(
        { files: ADR_FILES, checkRuns: allGreen() },
        { GITHUB_EVENT_NAME: eventName, AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
      );

      expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
      expect(outcome.stderr).toContain(`cannot measure a ${eventName} event`);
    },
  );

  it('refuses to answer when the event name is missing entirely', async () => {
    const outcome = await runAgainst(
      { files: ADR_FILES, checkRuns: allGreen() },
      { GITHUB_EVENT_NAME: '', AGGREGATE_CHECKS_TIMEOUT_SECONDS: '5' },
    );

    expect(outcome.status, outcome.stdout + outcome.stderr).toBe(2);
    expect(outcome.stderr).toContain('GITHUB_EVENT_NAME is not set');
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

  it('starts on a merge group too, or the queue it is required on would never see it', () => {
    // A required context that does not run on `merge_group` never reports
    // there, and a queue entry with a required check that never reports is
    // ejected. That is the same deadlock the path-filtered workflows have on
    // pull requests, moved into the queue.
    expect(Object.keys(mapping(aggregate().on, 'on'))).toContain('merge_group');
  });

  it('passes both events head commits to the script, and nothing else', () => {
    // A `${{ }}` interpolation for an event that did not fire yields the empty
    // string, so both pairs are always present and the script decides between
    // them by event name. What matters here is that the merge-group pair is
    // passed at all: without it the script has no head commit to read on a
    // queue entry and every entry ends undetermined.
    const step = sequence(aggregateJob().steps, 'steps')
      .map((raw, index) => mapping(raw, `steps[${index}]`))
      .find((candidate) => typeof candidate.run === 'string');
    if (step === undefined) throw new Error('the job runs nothing');

    const environment = mapping(step.env, 'steps[].env');
    expect(String(environment.MERGE_GROUP_HEAD_SHA)).toContain('github.event.merge_group.head_sha');
    expect(String(environment.MERGE_GROUP_BASE_SHA)).toContain('github.event.merge_group.base_sha');
    expect(String(environment.PR_HEAD_SHA)).toContain('github.event.pull_request.head.sha');
  });

  it('does not cancel a merge group run in progress', () => {
    // Cancellation is a non-verdict, and a required check with no verdict
    // ejects the entry. The guard is already written for pull requests only;
    // this pins it, because widening it would break the queue silently.
    const concurrency = mapping(aggregate().concurrency, 'concurrency');
    expect(String(concurrency['cancel-in-progress'])).toContain("github.event_name == 'pull_request'");
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
    const filtered = watched.filter((entry) => entry.triggers.pull_request?.kind === 'workflow-paths');
    expect(filtered.length).toBeGreaterThan(0);

    for (const entry of filtered) {
      const parsed = workflows.get(entry.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${entry.workflow}`);

      const pullRequest = mapping(mapping(parsed.on, 'on').pull_request, `${entry.workflow} on.pull_request`);
      const paths = sequence(pullRequest.paths, `${entry.workflow} on.pull_request.paths`).map(String);

      const trigger = entry.triggers.pull_request;
      expect(
        trigger !== undefined && trigger.kind === 'workflow-paths' ? trigger.paths : [],
        `${entry.workflow} filter must be copied exactly, or an absent check is misread`,
      ).toEqual(paths);
    }
  });

  it('claims no filter for a workflow that has one, and none for one that has not', async () => {
    const { watched } = await readConfiguration();
    const always = watched.filter((entry) => entry.triggers.pull_request?.kind === 'always');
    expect(always.length).toBeGreaterThan(0);

    for (const entry of always) {
      const parsed = workflows.get(entry.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${entry.workflow}`);

      const pullRequest = mapping(parsed.on, 'on').pull_request;
      const hasPaths = pullRequest !== null && Object.hasOwn(mapping(pullRequest, 'on.pull_request'), 'paths');

      expect(hasPaths, `${entry.workflow} is treated as unfiltered and must be one`).toBe(false);
    }
  });

  it('records a trigger for both events for every watched workflow', async () => {
    // An entry with nothing to say about an event is not a green there, it is
    // an undetermined run -- so a new watched workflow cannot be added with
    // only half its reading filled in and quietly pass in a queue.
    const { watched } = await readConfiguration();

    for (const entry of watched) {
      for (const event of ['pull_request', 'merge_group']) {
        expect(entry.triggers[event], `${entry.workflow} records no ${event} trigger`).toBeDefined();
      }
    }
  });

  it('reads every watched workflow that carries a merge_group trigger as unconditional there', async () => {
    // `merge_group` supports no `paths:` filter, so a workflow triggered on it
    // runs on every entry. Claiming a filter there would read a running check
    // as never-triggered, which launders a pending failure into a green.
    const { watched } = await readConfiguration();

    for (const entry of watched) {
      const parsed = workflows.get(entry.workflow.replace('.github/workflows/', ''));
      if (parsed === undefined) throw new Error(`no committed workflow at ${entry.workflow}`);

      const triggered = Object.hasOwn(mapping(parsed.on, 'on'), 'merge_group');
      const trigger = entry.triggers.merge_group;

      expect(
        trigger?.kind,
        `${entry.workflow} ${triggered ? 'runs' : 'does not run'} on merge_group and must be read that way`,
      ).toBe(triggered ? 'always' : 'not-triggered');
    }
  });

  it('watches every check the queue can eject an entry over', async () => {
    // The merge-group counterpart of the accounting property below: a workflow
    // that reports in a queue and is neither watched nor excluded is a check
    // the aggregate cannot see, on the one event where an unseen red check is
    // what stops the merge.
    const { watched, excluded } = await readConfiguration();
    const accounted = new Set([...watched.flatMap((entry) => entry.checks), ...excluded.map((entry) => entry.check)]);

    const unaccounted = reportedChecksFor('merge_group')
      .map(({ check }) => check)
      .filter((check) => !accounted.has(check));

    expect(
      unaccounted,
      'a workflow reports a merge-group check that aggregate-checks neither watches nor excludes',
    ).toEqual([]);
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
