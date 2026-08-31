#!/usr/bin/env node
// The local stand-in for the repository's pull-request CI, selected by what this
// branch actually changed.
//
// Why it exists (abdeslam-menacere/ModelTree#560). A change can pass both dock
// gates and still merge a red `main`, because the gates and CI check different
// things and nothing reconciled them. On abdeslam-menacere/ModelTree#441 /
// PR #558 the review and QA gates both passed at `6925d5a`, having run the three
// commands `.github/skills/modeltree-gates/SKILL.md` names, and the merge turned
// `instruction-references` and both `pytest` legs red on `main`. No local command
// invoked any of those three checks, so no diligence at the gate could have
// caught it. The failure was coverage, not care.
//
// So this script does not add a rule. It runs the commands CI already runs, on
// the paths this branch already changed, before the pull request is opened. It
// widens what is verified and lowers nothing: there is no `--force`, no `--skip`,
// no environment variable that relaxes a check, and no flag that turns a red
// result green. An unrecognised flag exits 2.
//
// Usage:
//   node .github/scripts/ci-preflight.mjs [--repo <dir>] [--json]
//   node .github/scripts/ci-preflight.mjs --plan [--json]
//
// Exit 0 = every selected check ran and passed. Exit 1 = a selected check
// failed. Exit 2 = a check could not be run, or the script could not decide what
// to run. **Exit 2 is never a pass**, the same rule the gates hold themselves to:
// a check that did not run has not passed, and the worst outcome available to a
// verifier is looking green while inspecting nothing.
//
// `--plan` prints what would run and exits **2**, not 0, precisely because it
// verifies nothing. `--help` exits 2 for the same reason. So does a run that
// selected no checks at all -- with nothing executed there is no failure and no
// unknown to count, and returning 0 there would report a pass from a run that
// inspected nothing. The only zero this script emits means "everything selected
// ran and passed", so a caller cannot obtain a pass from it without one.
//
// Because exit 2 now covers both "a check could not run" and "there was nothing
// to check", `--json` carries `empty` so the two can be told apart without
// parsing prose. Exit 0 in `gate-scope.mjs` has the same dual reading and is
// separated the same way.
//
// -- What decides which checks run --
//
// The same anchor the gates use: `git merge-base HEAD refs/remotes/origin/main`,
// the point this branch left published history, unioned with whatever the
// working tree still holds. Committing moves `HEAD` and never the merge base, so
// running this before or after a commit gives the same selection. That is
// deliberately identical to `gate-scope.mjs` and `gate-source-approval.mjs`; two
// tools answering "which commit do I trust" two different ways is how this class
// of bug survives.
//
// The trigger conditions below are **copies of the committed workflows**, and
// `web/tests/workflows/ci-preflight.test.ts` reads both sides and asserts they
// agree -- the `paths:` list out of the workflow YAML for a path-filtered
// workflow, and the scope step's own `grep -E` pattern for a workflow that
// filters inside the job. That test also asserts that every job reporting a
// pull-request check is either covered here or named in `NOT_COVERED` below. A
// new workflow therefore cannot be added without this file following it, which
// is the drift this script would otherwise acquire.
//
// -- What it does not cover --
//
// Stated in `NOT_COVERED`, printed on every run including a passing one, and not
// buried in this comment, because the failure being closed here is a reader
// inferring a completeness that was never there.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// What the remote says `main` is. Not a local branch: a local `main` is a ref
// this working copy can move, and an anchor the run can move is not an anchor.
const PUBLISHED_REF = 'refs/remotes/origin/main';

/**
 * Every pull-request status check this script knows how to run locally.
 *
 * `checks` holds the status-check names GitHub reports, which are job `name:`
 * values, expanded per matrix leg. `trigger` is a copy of how the committed
 * workflow decides to run, in one of two forms:
 *
 *   - `workflow-paths`: the workflow's own `on.pull_request.paths` list;
 *   - `in-job-scope`: the ERE its scope step greps the changed-file list with,
 *     used by the workflows that deliberately carry no trigger filter so their
 *     check always reports and can therefore be required.
 *
 * `commands` is the local command list, in the workflow's own order, each
 * labelled with the workflow step it stands for. `ciRun` names the workflow's
 * own `run:` line when it differs from the local invocation; the test asserts
 * every command corresponds to a real step of the real job, so the one place the
 * two deliberately differ is written down rather than left to be noticed.
 */
const CHECKS = [
  {
    id: 'web-ci',
    kind: 'mirror',
    checks: ['web-ci'],
    workflow: '.github/workflows/web-ci.yml',
    job: 'web-ci',
    trigger: {
      kind: 'in-job-scope',
      pattern:
        '^(web/|\\.github/workflows/|\\.github/scripts/ci-preflight\\.mjs$'
        + '|\\.github/skills/modeltree-gates/scripts/gate-(dataset|evidence|scope)\\.mjs$'
        + '|\\.github/skills/modeltree-review/SKILL\\.md$|\\.github/ISSUE_TEMPLATE/'
        + '|\\.github/CODEOWNERS$|\\.github/pull_request_template\\.md$|CONTRIBUTING\\.md$'
        + '|docs/contributing/minimal-dataset-example\\.json$'
        + '|docs/product/INFORMATION-ARCHITECTURE\\.md$'
        + '|docs/product/FRESHNESS-POLICY\\.md$'
        + '|tools/updater/profiles/[^/]+\\.[jJ][sS][oO][nN]$)',
    },
    // Three commands rather than one `npm run build`, matching the workflow's
    // three separately-named steps, so a red preflight names which one failed.
    // `npm run build` is `npm run validate && astro build` and `npm run
    // validate` is `npm run test && npm run check`, so this is the same command
    // list the Pages deploy gates on.
    commands: [
      { label: 'Run the web test suite', cwd: 'web', bin: 'npm', args: ['run', 'test'] },
      { label: 'Check Astro and TypeScript diagnostics', cwd: 'web', bin: 'npm', args: ['run', 'check'] },
      { label: 'Build the production site', cwd: 'web', bin: 'npm', args: ['run', 'astro', '--', 'build'] },
    ],
    requires: [
      {
        kind: 'path',
        path: 'web/node_modules',
        hint: 'install the site dependencies first: cd web && npm ci',
      },
    ],
  },
  {
    id: 'skills-ci',
    kind: 'mirror',
    checks: ['skills-ci'],
    workflow: '.github/workflows/skills-ci.yml',
    job: 'skills-ci',
    trigger: {
      kind: 'in-job-scope',
      pattern: '^(\\.github/skills/|\\.github/scripts/|\\.github/workflows/skills-ci\\.yml$|web/src/data/)',
    },
    commands: [
      {
        label: 'Run the gate self-tests',
        cwd: '.',
        bin: 'node',
        args: ['--test', '.github/skills/modeltree-gates/scripts/gates.test.mjs'],
      },
      {
        label: 'Run the dataset gate against the live data',
        cwd: '.',
        bin: 'node',
        args: ['.github/skills/modeltree-gates/scripts/gate-dataset.mjs'],
      },
      {
        label: 'Refuse a hand-written test count in the skill documentation',
        cwd: '.',
        bin: 'node',
        args: ['.github/scripts/check-skill-doc-test-counts.mjs'],
      },
    ],
    requires: [],
  },
  {
    id: 'instruction-references',
    kind: 'mirror',
    checks: ['instruction-references'],
    workflow: '.github/workflows/instruction-references.yml',
    job: 'instruction-references',
    trigger: {
      kind: 'workflow-paths',
      paths: [
        '.github/copilot-instructions.md',
        '.github/skills/**',
        'tools/instruction_refs/**',
        '.github/workflows/instruction-references.yml',
      ],
    },
    // No arguments, exactly as the workflow invokes it, so the local run cannot
    // be pointed at a smaller covered set than CI reads.
    commands: [
      {
        label: 'Resolve the references in the covered documents',
        cwd: '.',
        bin: 'python',
        args: ['tools/instruction_refs/check_instruction_references.py'],
      },
    ],
    requires: [],
  },
  {
    id: 'adr-numbers',
    kind: 'mirror',
    checks: ['adr-numbers'],
    workflow: '.github/workflows/adr-numbers.yml',
    job: 'adr-numbers',
    trigger: {
      kind: 'workflow-paths',
      paths: ['docs/adr/**', 'tools/adr_numbers/**', '.github/workflows/adr-numbers.yml'],
    },
    commands: [
      {
        label: 'Check that no two ADRs claim the same number, and each agrees with its own',
        cwd: '.',
        bin: 'python',
        args: ['tools/adr_numbers/check_adr_numbers.py'],
      },
    ],
    requires: [],
  },
  {
    id: 'updater-pytest',
    kind: 'mirror',
    // One local run stands for both matrix legs. They are one suite on two
    // interpreters, and the historical case is the reason that matters: the two
    // red `pytest` checks on `3d3f4b1` were a single root cause reported twice,
    // because `tools/updater/tests/test_instruction_references.py` runs the same
    // checker in-process. Reading them as two independent failures produces a
    // fix verified against a third of the damage.
    checks: ['pytest (Python 3.11)', 'pytest (Python 3.13)'],
    workflow: '.github/workflows/updater-tests.yml',
    job: 'pytest',
    trigger: {
      kind: 'workflow-paths',
      paths: [
        'tools/updater/**',
        '.github/workflows/updater-tests.yml',
        '.github/workflows/publish-updater-proposals.yml',
        'tools/instruction_refs/**',
        '.github/skills/**',
        '.github/workflows/instruction-references.yml',
        'tools/adr_numbers/**',
        '.github/workflows/adr-numbers.yml',
        'docs/adr/**',
      ],
    },
    commands: [
      {
        label: 'Run pytest',
        cwd: 'tools/updater',
        bin: 'python',
        args: ['-m', 'pytest'],
        // The workflow can say `pytest` because it just installed the package
        // into the interpreter it set up. Here the interpreter is whatever the
        // environment provides, so the runner is invoked through it rather than
        // through whichever `pytest` shim happens to be first on PATH.
        ciRun: 'pytest',
      },
    ],
    // The suite imports the installed package and hard-requires PyYAML, so an
    // environment missing either collects errors that look like test failures
    // but are not. Probing first turns that into an honest "could not run".
    requires: [
      {
        kind: 'python-module',
        module: 'modeltree_updater',
        hint: "install the updater and its test dependencies: cd tools/updater && python -m pip install '.[dev]'",
      },
      {
        kind: 'python-module',
        module: 'yaml',
        hint: "PyYAML is a hard requirement of the suite: cd tools/updater && python -m pip install '.[dev]'",
      },
      {
        kind: 'python-module',
        module: 'pytest',
        hint: "cd tools/updater && python -m pip install '.[dev]'",
      },
    ],
  },
  {
    id: 'source-link-health-tests',
    kind: 'mirror',
    checks: ['source-link-health-tests'],
    workflow: '.github/workflows/source-link-health.yml',
    job: 'source-link-health-tests',
    trigger: {
      kind: 'in-job-scope',
      pattern:
        '^(\\.github/scripts/source-link-health/|\\.github/workflows/source-link-health\\.yml$|web/src/data/sources\\.json$)',
    },
    // The hermetic half of that workflow. `--dry-run` makes no request, so this
    // stays offline; the half that reaches the network is in NOT_COVERED.
    commands: [
      {
        label: 'Run the link-health tests',
        cwd: '.',
        bin: 'node',
        args: ['--test', '.github/scripts/source-link-health/link-health.test.mjs'],
      },
      {
        label: 'Dry-run extraction over the seed dataset',
        cwd: '.',
        bin: 'node',
        args: ['.github/scripts/source-link-health/check-source-links.mjs', '--dry-run'],
      },
    ],
    requires: [],
  },
  /*
   * Preflight verifying itself. Not a mirror of any CI check, which is why it
   * carries `kind: 'self'` and an empty `checks` -- no workflow reports it, and
   * claiming otherwise would be a lie the tests below rightly refuse.
   *
   * It exists because every entry above is a *copy* of a workflow's triggers and
   * commands, and a copy can drift from its original. The tests in
   * `web/tests/workflows/ci-preflight.test.ts` compare both sides and catch that
   * drift -- but they ran under `web-ci`, whose scope was
   * `^(web/|\.github/workflows/web-ci\.yml$)`, so a change to
   * `.github/workflows/skills-ci.yml` selected `skills-ci` alone and never ran
   * them. The guard existed and was simply never chosen: editing a workflow
   * could make this script's copy wrong while the run still reported PASS, which
   * is the unearned green this script exists to remove, one level up.
   *
   * The fix is selection, not a YAML interpreter. When the change touches a
   * workflow -- or this script, or its tests -- run the fidelity tests directly.
   *
   * `web-ci`'s own scope has since been widened to cover `.github/workflows/`
   * and this script (#477), so these paths now select `web-ci` as well. That
   * does not make this entry redundant. `web-ci` runs the whole suite, the
   * diagnostics and a production build and needs `web/node_modules` to do any of
   * it; this runs the one file that compares the copies, so the fidelity answer
   * survives a `web-ci` leg that could not run. It also keeps the fidelity tests
   * selected on their own terms rather than as a consequence of another check's
   * scope, which is the coupling that produced the gap in the first place.
   *
   * Note it deliberately does **not** mirror `web-ci`'s trigger, then or now.
   * Copying that pattern here would break `copies the in-job scope pattern of
   * every unfiltered workflow exactly`, which asserts each copy equals its
   * committed original -- reddening the very test this entry exists to run.
   */
  {
    id: 'preflight-self-check',
    kind: 'self',
    checks: [],
    trigger: {
      kind: 'self-paths',
      paths: [
        '.github/workflows/**',
        '.github/scripts/ci-preflight.mjs',
        'web/tests/workflows/ci-preflight.test.ts',
      ],
    },
    commands: [
      {
        label: 'Check this script still matches the committed workflows',
        cwd: 'web',
        // vitest's own entry point rather than `npm run test`, which runs the
        // whole suite and then a coverage verifier that requires every
        // discovered file to have reported. A single-file filter fails it.
        bin: 'node',
        args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/workflows/ci-preflight.test.ts'],
      },
    ],
    requires: [
      {
        kind: 'path',
        path: 'web/node_modules',
        hint: 'run `npm ci` in web/ so the fidelity tests can run',
      },
    ],
  },
];

/**
 * What this script deliberately does not run, and why.
 *
 * Printed on every run, passing ones included. The defect this whole script
 * closes is a reader taking a green result for more coverage than it carries, so
 * the limits travel with the result rather than living in a document the reader
 * of the result may never open.
 *
 * `web/tests/workflows/ci-preflight.test.ts` asserts every pull-request check
 * reported by a committed workflow is either in CHECKS above or named here by
 * its `check` field, so this list cannot go quietly out of date. The entries
 * with no `check` are limits of this script rather than whole checks it skips,
 * and they are stated for the same reason.
 */
const NOT_COVERED = [
  {
    check: 'source-link-health',
    what: 'the `source-link-health` check',
    why:
      'it requests every recorded source URL. It is advisory, never required, and reports only '
      + 'about URLs the pull request itself introduced; running it here would make a preflight '
      + 'depend on the network and on other people\'s uptime.',
  },
  {
    check: 'Open or update the link-health issue',
    what: 'the link-health issue jobs',
    why:
      'they only file or close a maintenance issue, and their `if:` restricts them to the '
      + 'schedule and to a dispatch that asks for it, so on a pull request they do nothing there '
      + 'is anything to verify.',
  },
  {
    check: 'Resolve the link-health issue',
    what: 'the link-health resolve job',
    why: 'same jobs, same reason: issue bookkeeping, skipped on a pull request.',
  },
  {
    check: 'web-e2e',
    what: 'the `web-e2e` browser check',
    why:
      'it drives a real Chromium over a built preview, so running it here would put a browser '
      + 'download in the pre-merge path of every dock and every gate agent -- the same cost that '
      + 'keeps it out of `npm run validate`, and the reason it is a separate workflow at all. What '
      + 'it does catch is a rendering, focus, motion or accessibility regression that jsdom '
      + 'cannot see, so run it deliberately with `npm run test:e2e` in `web/` when touching the '
      + 'lineage view, and read its result on the pull request otherwise.',
  },
  {
    what: 'the second Python interpreter',
    why:
      'CI runs the updater suite on 3.11 and 3.13. This runs it once, on whatever `python` '
      + 'resolves to here, so a failure specific to the other interpreter is not visible.',
  },
  {
    what: "the updater's optional-dependency resolve step",
    why:
      '`pip install --dry-run \'.[foundry]\'` resolves Azure packages from the index, so it needs '
      + 'the network. An unsatisfiable pin in that group still reaches CI unseen.',
  },
  {
    what: 'the `pages.yml` deploy',
    why:
      'it runs on push to `main` and publishes; it reports no pull-request check and there is '
      + 'nothing about it to run before a merge.',
  },
  {
    what: 'the runner itself',
    why:
      'these are the same commands, not the same machine. Node and Python versions, the OS, '
      + 'and an already-populated `node_modules` all differ from a clean ubuntu-latest checkout, '
      + 'so a green preflight predicts CI rather than binding it.',
  },
  {
    what: 'the merge result',
    why:
      'selection is anchored at the merge base with `' + PUBLISHED_REF + '`, so this judges this '
      + 'branch and not this branch merged into a `main` that has since moved.',
  },
  {
    what: 'workflow edits beyond this script\'s copy of them',
    why:
      'a change under `.github/workflows/**` selects `preflight-self-check`, which runs the '
      + 'fidelity tests and so catches this script\'s table drifting from the committed YAML. It '
      + 'is a comparison of two files, not an interpretation of one: it never executes the edited '
      + 'workflow, so an edit that is faithfully copied here and still wrong on the runner -- a '
      + 'bad `runs-on`, a missing secret, an action version that no longer resolves -- passes it.',
  },
  {
    what: 'branch protection',
    why:
      'which checks are required lives outside the repository tree. A green preflight says the '
      + 'checks passed, never that the pull request is mergeable.',
  },
];

function parseArgs(argv) {
  const args = { repo: null, json: false, plan: false, help: false };
  const value = (i, flag) => {
    const next = argv[i];
    if (typeof next !== 'string' || next.length === 0) {
      process.stderr.write(`ci-preflight: ${flag} needs a value\n`);
      process.exit(2);
    }
    return next;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--repo') args.repo = value(++i, '--repo');
    else if (flag === '--json') args.json = true;
    else if (flag === '--plan') args.plan = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`ci-preflight: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

function repoRoot() {
  // .github/scripts/ci-preflight.mjs -> up three.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * The commit the change is measured from, and not a decision this script makes
 * for itself. Identical to `gate-scope.mjs`: the merge base of `HEAD` with the
 * published `main`. Every failure here ends as exit 2, because a script that
 * does not know what changed cannot know what to run, and "I do not know" is
 * never a pass.
 */
function resolveAnchor(cwd) {
  let published;
  try {
    published = git(cwd, 'rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`).trim();
  } catch {
    throw new Error(
      `cannot resolve ${PUBLISHED_REF}, so there is no published history to measure this change `
      + 'against. A shallow or single-branch clone will do this; fetch main first',
    );
  }
  let anchor;
  try {
    anchor = git(cwd, 'merge-base', 'HEAD', published).trim();
  } catch {
    throw new Error(`HEAD shares no history with ${PUBLISHED_REF} (${published.slice(0, 10)})`);
  }
  if (anchor.length === 0) throw new Error(`no merge base between HEAD and ${PUBLISHED_REF}`);
  return anchor;
}

/**
 * Every path this change touches: what the branch committed since the anchor,
 * unioned with what the working tree holds on top of it. Same union, and same
 * reasoning, as `gate-scope.mjs` -- a change that is half committed and half
 * still on disk selects the same checks either way.
 */
function changedPaths(cwd, anchor) {
  const paths = new Set();
  const add = (output) => {
    for (const line of output.split('\n')) {
      const path = line.trim();
      if (path.length > 0) paths.add(path);
    }
  };
  add(git(cwd, 'diff', '--name-only', `${anchor}...HEAD`));
  add(git(cwd, 'diff', '--name-only'));
  add(git(cwd, 'diff', '--name-only', '--cached'));
  add(git(cwd, 'ls-files', '--others', '--exclude-standard'));
  return [...paths].sort();
}

/**
 * Does one workflow `paths:` glob match one changed path?
 *
 * Only the two forms the committed workflows actually use are implemented: a
 * literal file path, and a `dir/**` prefix. Anything else **throws**, which ends
 * as exit 2. That direction is the whole point: a glob form this script cannot
 * read must stop it, never silently match nothing and leave a check unselected
 * while the run still reports green.
 */
function globMatches(glob, path) {
  if (glob.endsWith('/**')) {
    const prefix = `${glob.slice(0, -3)}/`;
    if (prefix.includes('*')) {
      throw new Error(`unsupported glob in a workflow path filter: ${glob}`);
    }
    return path.startsWith(prefix);
  }
  if (glob.includes('*')) {
    throw new Error(`unsupported glob in a workflow path filter: ${glob}`);
  }
  return path === glob;
}

/** The changed paths that select a check, in the order they were reported. */
function selectingPaths(check, paths) {
  if (check.trigger.kind === 'workflow-paths' || check.trigger.kind === 'self-paths') {
    return paths.filter((path) => check.trigger.paths.some((glob) => globMatches(glob, path)));
  }
  if (check.trigger.kind === 'in-job-scope') {
    // The ERE the workflow greps with is also a valid JavaScript regular
    // expression, which is what lets the pattern be copied rather than rewritten.
    const matches = new RegExp(check.trigger.pattern);
    return paths.filter((path) => matches.test(path));
  }
  throw new Error(`unknown trigger kind ${JSON.stringify(check.trigger.kind)} on ${check.id}`);
}

/**
 * Which interpreter `python` means here.
 *
 * An environment fact, resolved by asking, not a threshold the caller picks:
 * there is no flag to nominate one. If neither name responds, the checks that
 * need Python report "could not run" rather than passing without it.
 */
let pythonCache;
function resolvePython() {
  if (pythonCache !== undefined) return pythonCache;
  for (const candidate of ['python', 'python3']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) {
      pythonCache = candidate;
      return pythonCache;
    }
  }
  pythonCache = null;
  return pythonCache;
}

/**
 * How a command's `bin` is spawned, or null when it cannot be found.
 *
 * The shell is requested for exactly one case: npm on Windows is a `.cmd` shim,
 * which Node refuses to spawn directly. It must not be requested for anything
 * else, because cmd.exe re-splits the command on spaces -- and the interpreter
 * running this script is routinely at "C:\Program Files\nodejs\node.exe", where
 * shelling out silently ran "C:\Program" and reported the resulting exit 1 as a
 * failing check. A check that fails because its command never started is a false
 * report, and a preflight that cries wolf is one a reader learns to skip.
 */
function resolveBin(bin) {
  if (bin === 'node') return { file: process.execPath, shell: false };
  if (bin === 'npm') {
    return process.platform === 'win32'
      ? { file: 'npm.cmd', shell: true }
      : { file: 'npm', shell: false };
  }
  if (bin === 'python') {
    const python = resolvePython();
    return python === null ? null : { file: python, shell: false };
  }
  throw new Error(`unknown command binary ${JSON.stringify(bin)}`);
}

/** Quote one token for a shell that would otherwise re-split it on spaces. */
function quoteForShell(token) {
  return /[\s"]/.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token;
}

/**
 * Anything a check needs before its commands mean anything.
 *
 * An unmet precondition is reported as `unknown` -- the exit-2 state -- and
 * never as a pass and never as a failure. Running a suite that cannot import its
 * own package produces collection errors that read as test failures, which sends
 * the reader after the wrong bug.
 */
function unmetRequirements(cwd, check) {
  const unmet = [];
  for (const requirement of check.requires) {
    if (requirement.kind === 'path') {
      if (!existsSync(join(cwd, requirement.path))) {
        unmet.push(`${requirement.path} is missing - ${requirement.hint}`);
      }
    } else if (requirement.kind === 'python-module') {
      const python = resolvePython();
      if (python === null) {
        unmet.push(`no python interpreter on PATH - ${requirement.hint}`);
        continue;
      }
      const probe = spawnSync(python, ['-c', `import ${requirement.module}`], { stdio: 'ignore' });
      if (probe.error || probe.status !== 0) {
        unmet.push(`python cannot import ${requirement.module} - ${requirement.hint}`);
      }
    } else {
      throw new Error(`unknown requirement kind ${JSON.stringify(requirement.kind)}`);
    }
  }
  return unmet;
}

function runCheck(cwd, check, quiet) {
  const unmet = unmetRequirements(cwd, check);
  if (unmet.length > 0) return { status: 'unknown', reasons: unmet, commands: [] };

  const results = [];
  for (const command of check.commands) {
    const resolved = resolveBin(command.bin);
    if (resolved === null) {
      return {
        status: 'unknown',
        reasons: [`no python interpreter on PATH for "${command.label}"`],
        commands: results,
      };
    }
    const shown = `${command.bin} ${command.args.join(' ')}`;
    if (!quiet) process.stdout.write(`\n  ${check.id}: ${command.label}\n  $ ${shown}\n`);
    const run = spawnSync(
      resolved.shell ? quoteForShell(resolved.file) : resolved.file,
      resolved.shell ? command.args.map(quoteForShell) : command.args,
      {
        cwd: resolve(cwd, command.cwd),
        stdio: quiet ? 'ignore' : 'inherit',
        shell: resolved.shell,
      },
    );
    if (run.error) {
      results.push({ label: command.label, command: shown, status: 'unknown' });
      return {
        status: 'unknown',
        reasons: [`could not start "${shown}": ${run.error.message}`],
        commands: results,
      };
    }
    results.push({ label: command.label, command: shown, status: run.status === 0 ? 'pass' : 'fail', exitCode: run.status });
    if (run.status !== 0) {
      return { status: 'fail', reasons: [`"${shown}" exited ${run.status}`], commands: results };
    }
  }
  return { status: 'pass', reasons: [], commands: results };
}

function writeNotCovered(write) {
  write('\nWhat this preflight does NOT cover, so a pass is not read for more than it is:\n');
  for (const item of NOT_COVERED) write(`  - ${item.what}: ${item.why}\n`);
}

/**
 * How a check group is labelled in the printed report.
 *
 * A mirror is named by the CI checks it stands in for. The self-check stands in
 * for none, and says so, so a reader never takes it for a CI check that passed.
 */
function label(check) {
  return check.kind === 'self'
    ? 'preflight self-check, not a CI check'
    : check.checks.join(', ');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'usage: ci-preflight.mjs [--repo <dir>] [--json]\n'
      + '       ci-preflight.mjs --plan [--json]   (prints the plan, runs nothing, exits 2)\n'
      + '\n'
      + 'Exit 0 means every selected check ran and passed. Printing this text\n'
      + 'verifies nothing, so --help exits 2 for the same reason --plan does:\n'
      + 'the only zero this script emits is one that was earned.\n',
    );
    return 2;
  }

  const cwd = args.repo ? resolve(args.repo) : repoRoot();
  if (!existsSync(cwd)) {
    process.stderr.write(`ci-preflight: no directory at ${cwd}\n`);
    return 2;
  }

  let anchor;
  let paths;
  let plan;
  try {
    anchor = resolveAnchor(cwd);
    paths = changedPaths(cwd, anchor);
    plan = CHECKS.map((check) => ({ check, selectedBy: selectingPaths(check, paths) }));
  } catch (error) {
    process.stderr.write(`ci-preflight: ${error.message}\n`);
    return 2;
  }

  const selected = plan.filter((entry) => entry.selectedBy.length > 0);
  const skipped = plan.filter((entry) => entry.selectedBy.length === 0);

  if (args.plan) {
    const describe = (check) => ({
      id: check.id,
      kind: check.kind,
      checks: check.checks,
      workflow: check.workflow,
      job: check.job,
      trigger: check.trigger,
      commands: check.commands.map((command) => ({
        label: command.label,
        cwd: command.cwd,
        local: `${command.bin} ${command.args.join(' ')}`,
        // What the workflow itself runs. Defaulted rather than repeated, so the
        // only entries carrying one are the ones that genuinely differ.
        ciRun: command.ciRun ?? `${command.bin} ${command.args.join(' ')}`,
      })),
    });
    const report = {
      anchor,
      changed: paths,
      selected: selected.map((entry) => ({ ...describe(entry.check), selectedBy: entry.selectedBy })),
      notSelected: skipped.map((entry) => describe(entry.check)),
      notCovered: NOT_COVERED,
      // Said in the payload as well as on stderr, so a machine reader that never
      // looks at the exit code cannot mistake a plan for a result.
      verified: false,
    };
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`ci-preflight: plan against ${anchor.slice(0, 10)}, ${paths.length} file(s) changed\n`);
      for (const entry of selected) {
        process.stdout.write(`  would run ${entry.check.id} (${label(entry.check)})\n`);
        for (const command of entry.check.commands) {
          process.stdout.write(`    $ ${command.bin} ${command.args.join(' ')}\n`);
        }
      }
      for (const entry of skipped) process.stdout.write(`  not selected: ${entry.check.id}\n`);
      writeNotCovered((text) => process.stdout.write(text));
    }
    process.stderr.write('ci-preflight: --plan verified nothing, so this is not a pass\n');
    return 2;
  }

  if (!args.json) {
    process.stdout.write(
      `ci-preflight: ${paths.length} file(s) changed since ${anchor.slice(0, 10)}; `
      + `${selected.length} of ${CHECKS.length} local check group(s) selected\n`,
    );
    for (const entry of selected) {
      process.stdout.write(`  selected ${entry.check.id} (${label(entry.check)})`);
      process.stdout.write(` <- ${entry.selectedBy.slice(0, 3).join(', ')}`);
      if (entry.selectedBy.length > 3) process.stdout.write(` (+${entry.selectedBy.length - 3} more)`);
      process.stdout.write('\n');
    }
    for (const entry of skipped) process.stdout.write(`  not selected: ${entry.check.id}\n`);
  }

  const results = [];
  for (const entry of selected) {
    let outcome;
    try {
      outcome = runCheck(cwd, entry.check, args.json);
    } catch (error) {
      outcome = { status: 'unknown', reasons: [error.message], commands: [] };
    }
    results.push({
      id: entry.check.id,
      kind: entry.check.kind,
      label: label(entry.check),
      checks: entry.check.checks,
      workflow: entry.check.workflow,
      selectedBy: entry.selectedBy,
      ...outcome,
    });
  }

  const failed = results.filter((result) => result.status === 'fail');
  const unknown = results.filter((result) => result.status === 'unknown');
  const passed = results.filter((result) => result.status === 'pass');
  /*
   * An empty selection is not a pass, and this is the case worth being careful
   * about. When the branch changes nothing a pull-request check reads, no command
   * runs -- so there is no failure and no unknown, and counting only those two
   * returns zero from a run that verified nothing. A dock reading that PASS
   * concludes CI is clear on the strength of a check that never executed, which is
   * the exact inference abdeslam-menacere/ModelTree#560 exists to close, and it
   * would be reproduced here inside the fix for it.
   *
   * So it is reported as exit 2 -- nothing was verified -- and never as a pass.
   * `empty` is carried in the JSON as well, because "nothing to check" and
   * "everything checked and passed" are different claims and a caller has to be
   * able to tell them apart. Same reasoning, and the same field name, as the two
   * readings of exit 0 that `gate-scope.mjs` separates.
   */
  const empty = selected.length === 0;
  // A definite red dominates an unknown, because it is the actionable one. Both
  // are non-zero; neither is a pass.
  const code = failed.length > 0 ? 1 : (unknown.length > 0 || empty) ? 2 : 0;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      anchor,
      changed: paths,
      results,
      notSelected: skipped.map((entry) => ({ id: entry.check.id, checks: entry.check.checks })),
      notCovered: NOT_COVERED,
      empty,
      passed: code === 0,
      exitCode: code,
    }, null, 2)}\n`);
    return code;
  }

  process.stdout.write('\n');
  for (const result of results) {
    const verdict = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'COULD NOT RUN';
    process.stdout.write(`  ${verdict.padEnd(14)}${result.id} (${result.label})\n`);
    for (const reason of result.reasons) process.stdout.write(`                ${reason}\n`);
  }

  if (empty) {
    process.stdout.write(
      '\nci-preflight: NOTHING SELECTED - no pull-request check reads anything this '
      + 'branch changed.\nThis is not a pass: nothing was verified here, so it says '
      + 'nothing about what CI will report.\n',
    );
  } else if (code === 0) {
    process.stdout.write(`\nci-preflight: PASS - ${passed.length} selected check group(s) ran and passed\n`);
  } else if (code === 1) {
    process.stdout.write(
      `\nci-preflight: FAIL - ${failed.length} selected check group(s) failed. `
      + 'CI will report the same thing after a merge; fix it here.\n',
    );
  } else {
    process.stdout.write(
      `\nci-preflight: COULD NOT RUN - ${unknown.length} selected check group(s) never ran. `
      + 'This is not a pass: those checks are unverified.\n',
    );
  }

  writeNotCovered((text) => process.stdout.write(text));
  return code;
}

process.exit(main());
