import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
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

/**
 * The body of one arm of the scope step's `case`, so an assertion about a range
 * endpoint is tied to the event whose data computes it: a substring check against
 * the whole script passes just as well when the two arms are cross-wired.
 *
 * Throws rather than returning a best guess, like every other extractor above.
 * This one guards which commits get verified at all, so it has to fail closed.
 * `;&` and `;;&` are valid bash that fall through into the next arm, and an arm
 * missing its terminator runs into the next one; in either case a slice that
 * simply ran to the next `;;` would hand these assertions the values of a
 * different event and pass. Rejecting a fall-through is deliberate even where
 * bash allows it, because an arm that does more than its own body says is not
 * something these assertions can describe.
 */
function caseArm(script: string, event: string): string {
  const opened = script.indexOf(`${event})`);
  const closed = script.indexOf('esac', opened);

  if (opened === -1 || closed === -1) {
    throw new Error(`Expected the scope step to handle ${event} inside a case statement`);
  }

  const terminator = script.slice(opened, closed).match(/;;&|;&|;;/);

  if (terminator?.[0] !== ';;') {
    throw new Error(
      `Expected the ${event} arm to end in ';;', found ${terminator?.[0] ?? 'no terminator'}`,
    );
  }

  const arm = script.slice(opened, opened + (terminator.index ?? 0));

  // A terminator found beyond the next label is that arm's, not this one's.
  if (/^[ \t]*[^\s)]+\)[ \t]*$/m.test(arm.slice(`${event})`.length))) {
    throw new Error(`Expected the ${event} arm to end before the next arm begins`);
  }

  return arm;
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
    expect(caseArm(script, 'push')).toContain('base="$PUSH_BEFORE_SHA"');
    expect(caseArm(script, 'push')).toContain('head="$GITHUB_SHA"');
  });

  // The env block above pins what the two pull request variables hold; this
  // pins which end of the range each is bound to, which nothing else covers.
  // Swapping these two lines diffs head...base, and because base is an
  // ancestor of head that range is empty rather than an error -- so the
  // fail-safe above never fires, run=false, no build happens, and web-ci (a
  // required check on main) reports green for an unverified commit.
  it('scopes a pull request to its base...head range, in that order', () => {
    expect(caseArm(script, 'pull_request')).toContain('base="$PR_BASE_SHA"');
    expect(caseArm(script, 'pull_request')).toContain('head="$PR_HEAD_SHA"');
  });

  it('builds for any change under web/', () => {
    expect(matchesPath.test('web/src/data/releases.json')).toBe(true);
    expect(matchesPath.test('web/package-lock.json')).toBe(true);
    expect(matchesPath.test('web/tests/workflows/web-ci.test.ts')).toBe(true);
  });

  it('builds when this workflow itself changes, so it verifies its own edits', () => {
    expect(matchesPath.test('.github/workflows/web-ci.yml')).toBe(true);
  });

  // #477. `web/tests/workflows/` holds a test per workflow, and the scope step
  // decided by `^(web/|\.github/workflows/web-ci\.yml$)` -- so a pull request
  // changing only `skills-ci.yml` ran no web test at all, including the one
  // whose entire subject is that workflow. The test that guards a workflow did
  // not run when that workflow changed.
  //
  // Read out of the real directory rather than from a list, so a workflow added
  // later is covered without anyone remembering to extend this test. Same
  // arrangement, and same reason, as the per-workflow case in
  // `ci-preflight.test.ts`.
  it('builds when any workflow changes, since a test under web/ reads each one', () => {
    const workflowDir = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
    const entries = readdirSync(workflowDir);

    expect(entries.length).toBeGreaterThan(1);

    for (const entry of entries) {
      expect(
        matchesPath.test(`.github/workflows/${entry}`),
        `a change to .github/workflows/${entry} must run the web suite`,
      ).toBe(true);
    }
  });

  /**
   * The rest of the derived set: every path outside `web/` that a file under
   * `web/` reads, paired with the reader that makes it qualify. The scope
   * comment in the workflow records the same derivation; this pins it, so
   * narrowing the regex fails here rather than silently leaving a test
   * unselected when its own subject changes.
   */
  const readOutsideWeb: [path: string, reader: string][] = [
    ['.github/workflows/README.md', 'web-ci.test.ts and skills-ci.test.ts'],
    ['.github/scripts/ci-preflight.mjs', 'tests/workflows/ci-preflight.test.ts'],
    [
      '.github/skills/modeltree-gates/scripts/gate-dataset.mjs',
      'tests/workflows/skills-ci.test.ts',
    ],
    [
      '.github/skills/modeltree-gates/scripts/gate-evidence.mjs',
      'src/data/featured-creator-profile.test.ts, which imports it',
    ],
    [
      '.github/skills/modeltree-gates/scripts/gate-scope.mjs',
      'tests/contributing/issue-forms.test.ts',
    ],
    [
      '.github/skills/modeltree-review/SKILL.md',
      'src/data/organization-type-policy.test.ts and osi-approved-evidence-policy.test.ts',
    ],
    ['.github/ISSUE_TEMPLATE/data-correction.yml', 'tests/contributing/issue-forms.test.ts'],
    ['.github/CODEOWNERS', 'tests/contributing/issue-forms.test.ts'],
    ['.github/pull_request_template.md', 'tests/contributing/issue-forms.test.ts'],
    ['CONTRIBUTING.md', 'tests/contributing/issue-forms.test.ts'],
    [
      'docs/contributing/minimal-dataset-example.json',
      'tests/contributing/issue-forms.test.ts',
    ],
    [
      'docs/product/INFORMATION-ARCHITECTURE.md',
      'src/data/catalog-inclusion-policy.test.ts, featured-policy.test.ts and '
        + 'organization-type-policy.test.ts',
    ],
    [
      'docs/product/FRESHNESS-POLICY.md',
      'src/data/freshness-policy.test.ts',
    ],
    [
      'tools/updater/profiles/anthropic.json',
      'src/data/featured-creator-profile.test.ts, through the gate-evidence.mjs it imports',
    ],
  ];

  it.each(readOutsideWeb)('builds when %s changes, which %s reads', (path) => {
    expect(matchesPath.test(path)).toBe(true);
  });

  // #477, second instance and the one the first derivation missed.
  // `src/data/featured-creator-profile.test.ts` imports `reviewedCreatorIds`
  // from `gate-evidence.mjs`, and that function reads `tools/updater/profiles/`
  // off disk -- so a profile document changes the set that test asserts over,
  // while the literal naming the directory lives in the imported module and
  // nowhere under `web/`. Deriving the scope from literals inside `web/` alone
  // therefore selected the script but not the data the script reads, leaving
  // the same defect standing one level down: editing a profile could redden the
  // web suite with `web-ci` never running.
  //
  // Read out of the real directory rather than from a list, so a creator
  // profile added later is covered without anyone remembering to extend this.
  it('builds when a reviewed profile document changes', () => {
    const profileDir = fileURLToPath(new URL('../../../tools/updater/profiles/', import.meta.url));
    const documents = readdirSync(profileDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));

    expect(documents.length).toBeGreaterThan(0);

    for (const entry of documents) {
      expect(
        matchesPath.test(`tools/updater/profiles/${entry.name}`),
        `a change to tools/updater/profiles/${entry.name} must run the web suite`,
      ).toBe(true);
    }
  });

  // The extension is matched case-insensitively because `reviewedCreatorIds`
  // *throws* on a name whose extension differs from `.json` only in case rather
  // than skipping it: that file is one document alongside its lowercase twin on
  // Windows and two documents on the Linux CI runs, so the reviewed set would
  // otherwise depend on which filesystem read it (#246). A throw reddens the
  // importing test, so such a rename has to select this workflow -- an
  // extension-exact pattern would leave precisely the platform divergence that
  // reader exists to refuse sitting unbuilt.
  it('builds for a profile whose extension is misspelled only in case', () => {
    expect(matchesPath.test('tools/updater/profiles/anthropic.JSON')).toBe(true);
    expect(matchesPath.test('tools/updater/profiles/anthropic.Json')).toBe(true);
  });

  // The paired control, and the reason the entry above names documents in one
  // directory rather than the directory itself. That read is not recursive and
  // skips anything that is not a file, so nothing nested here can change its
  // answer -- the long-tail profiles under `generic/` and `origins/` least of
  // all. The rest of the Python package is not read by any test under `web/`
  // and belongs to `updater-tests.yml`.
  //
  // `.github/workflows/updater-tests.yml` was itself asserted as a non-match
  // until #477. It is a workflow, and `ci-preflight.test.ts` parses every
  // workflow, so a change to it can redden the web suite; it now matches on
  // purpose. The Python package it covers still does not.
  it('skips a change confined to the rest of tools/updater/', () => {
    expect(matchesPath.test('tools/updater/pyproject.toml')).toBe(false);
    expect(matchesPath.test('tools/updater/src/modeltree_updater/run.py')).toBe(false);
    expect(matchesPath.test('tools/updater/profiles/README.md')).toBe(false);
    expect(matchesPath.test('tools/updater/profiles/generic/long-tail.json')).toBe(false);
    expect(matchesPath.test('tools/updater/profiles/origins/cohere.json')).toBe(false);
    expect(matchesPath.test('tools/updater/profiles/origins/README.md')).toBe(false);
  });

  // The paired control, and the one that stops the widening above turning into
  // "run the suite on everything". Each of these sits in a directory the scope
  // step does match part of, so a regex that reached for the directory instead
  // of the file would fail here -- which is the whole difference between a
  // derived predicate and a broad one.
  it('does not match a neighbour of a derived path that no web test reads', () => {
    expect(matchesPath.test('.github/skills/modeltree-gates/SKILL.md')).toBe(false);
    expect(matchesPath.test('.github/skills/modeltree-gates/scripts/gate-source-approval.mjs'))
      .toBe(false);
    expect(matchesPath.test('.github/scripts/check-skill-doc-test-counts.mjs')).toBe(false);
    expect(matchesPath.test('.github/copilot-instructions.md')).toBe(false);
    expect(matchesPath.test('docs/adr/0001-static-first-architecture.md')).toBe(false);
    expect(matchesPath.test('docs/product/BACKLOG.md')).toBe(false);
    expect(matchesPath.test('README.md')).toBe(false);
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
    expect(caseArm(script, '*')).toContain('run=true');
  });
});

// #609. `grep` exits 0 on a match, 1 on no match and 2 on an error, and this
// step used to truth-test it with `if`, which collapses 1 and 2 into one branch.
// A matcher that could not run therefore reported "nothing matched": every
// verification step below is gated on `steps.scope.outputs.run == 'true'`, so
// they all skipped, and `web-ci` -- a required check on main -- reported green
// over a commit nothing had built or tested. The diff guard a few lines above
// already refuses that trade and builds instead; this is the same decision
// applied to the other way the step can fail to produce an answer.
//
// These assertions run the committed script through a real bash rather than
// reading its text, because the defect lives in what the shell *does* with an
// exit code and no substring check can see that. The status is driven
// independently of the changed-file list on purpose: 0 and 1 come from the real
// `grep` against the real committed ERE, so the wiring is exercised end to end,
// and the error statuses are injected, because the committed ERE is well-formed
// and a here-string cannot fail to be read. That is exactly why the issue rates
// this Medium rather than High -- it is a robustness fix, and the harness has to
// be able to express a state the current inputs cannot reach or it could not
// test one.
describe('web-ci.yml scope detection tells a broken matcher from a clean miss', () => {
  const scopeStep = steps(webCiJob, 'jobs.web-ci').find((step) => step.id === 'scope');
  const scopeScript = String(mapping(scopeStep ?? null, 'the step with id "scope"').run);

  const temporaryDirectories: string[] = [];

  afterAll(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  interface ScopeOutcome {
    status: number | null;
    stdout: string;
    stderr: string;
    githubOutput: string | null;
  }

  /**
   * Run the committed scope script the way the runner would, for a pull request
   * whose changed-file list is `changed`.
   *
   * `grepExit` replaces `grep` with a stub returning that status. Left undefined,
   * the real `grep` runs against the real committed ERE.
   */
  function runScopeStep(changed: string, grepExit?: number): ScopeOutcome {
    const directory = mkdtempSync(join(tmpdir(), 'web-ci-scope-'));
    temporaryDirectories.push(directory);

    // `git` is stubbed rather than run: what is under test is what the step
    // decides from a changed-file list, not how it obtains one. The list arrives
    // in the environment so no path or filename is interpolated into the script.
    const gitStub = `
git() {
  printf '%s' "$CHANGED_FILES"
}
`;

    // Real grep writes a diagnostic and exits non-zero when it cannot run, so
    // the stub reproduces both channels and the script is judged on the same
    // evidence the runner would give it.
    const grepStub =
      grepExit === undefined
        ? ''
        : `
grep() {
  printf 'grep: stubbed failure\\n' >&2
  return ${grepExit}
}
`;

    writeFileSync(join(directory, 'step.sh'), `${gitStub}${grepStub}\n${scopeScript}\n`, 'utf8');

    const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', 'step.sh'], {
      // `cwd` here and the relative `GITHUB_OUTPUT` below are load-bearing on
      // Windows: an absolute path such as `C:\Users\...` inside a bash
      // double-quoted string has its backslashes eaten as escapes. Same
      // arrangement, and same reason, as source-link-health.test.ts.
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: 'a1b2c3d',
        PR_HEAD_SHA: 'e4f5a6b',
        PUSH_BEFORE_SHA: 'c7d8e9f',
        GITHUB_SHA: 'e4f5a6b',
        GITHUB_OUTPUT: './github-output',
        CHANGED_FILES: changed,
      },
      encoding: 'utf8',
    });

    if (run.error !== undefined) {
      // Never a skip. A test that did not run is not a test that passed, and the
      // shell semantics this block exists to pin are exactly what CI would stop
      // checking. `bash` is present on `ubuntu-latest`, where these run in CI,
      // and ships with Git for Windows.
      throw new Error(`could not run bash, which these tests require: ${run.error.message}`);
    }

    return {
      status: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      githubOutput: existsSync(join(directory, 'github-output'))
        ? readFileSync(join(directory, 'github-output'), 'utf8')
        : null,
    };
  }

  it('extracts the step under test, so a mis-read cannot pass as a green run', () => {
    // Guards every assertion below: an empty or wrong script would otherwise run
    // clean and prove nothing at all.
    expect(scopeStep, 'jobs.web-ci must have a step with id `scope`').toBeDefined();
    expect(scopeScript).toContain('grep -Eq');
    expect(scopeScript).toContain('GITHUB_OUTPUT');
  });

  // The premise the injected statuses rest on, measured rather than assumed: a
  // malformed ERE really does make `grep -E` exit 2, and that really is distinct
  // from the 1 it returns for a clean miss. Without this pair the stub would be
  // asserting against a status nothing produces, and the well-formed miss is the
  // half that would catch a `grep` reporting 2 for everything.
  it('is guarding a real distinction: a malformed ERE exits 2, a clean miss exits 1', () => {
    const bash = (command: string) =>
      spawnSync('bash', ['--noprofile', '--norc', '-c', command], { encoding: 'utf8' });

    const malformed = bash("grep -Eq '[' <<< 'web/src/index.astro'");
    const cleanMiss = bash("grep -Eq '^web/' <<< 'docs/product/BACKLOG.md'");

    if (malformed.error !== undefined || cleanMiss.error !== undefined) {
      throw new Error('could not run bash, which these tests require');
    }

    expect(malformed.status).toBe(2);
    expect(cleanMiss.status).toBe(1);
  });

  it('builds when the matcher finds a path the web suite reads', () => {
    const outcome = runScopeStep('web/src/pages/index.astro\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
  });

  it('skips when the matcher runs and nothing the web suite reads changed', () => {
    const outcome = runScopeStep('docs/product/BACKLOG.md\n');

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=false');
  });

  // The regression this block exists for. Reverting the fix leaves the two cases
  // above green and turns these red, which is the whole reason the status is
  // driven separately from the changed-file list: a test that only exercised
  // match and no-match cannot detect this coming back.
  //
  // 2 is grep's own "an error occurred"; 127 is the shell's "command not found",
  // which is how a `grep` missing from the runner image would present. Neither
  // is a statement about the changed-file list, so neither may decide to skip.
  it.each([[2], [127]])('builds rather than skips when the matcher exits %i', (grepExit) => {
    const outcome = runScopeStep('docs/product/BACKLOG.md\n', grepExit);

    expect(outcome.status, `step failed: ${outcome.stdout}${outcome.stderr}`).toBe(0);
    expect(outcome.githubOutput ?? '').toContain('run=true');
    expect(outcome.githubOutput ?? '').not.toContain('run=false');
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
