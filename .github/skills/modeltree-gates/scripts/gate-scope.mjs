#!/usr/bin/env node
// The qualifying-class gate from ADR 0003.
//
// A refresh may auto-merge only if every file it touches is one of the dataset
// documents composed by `web/src/data/raw.ts`. This is drawn by file path
// deliberately, so "does this change qualify" has a mechanical answer rather
// than a judgement call. One file outside the list disqualifies the whole
// change - there is no partial case, and no flag that relaxes it.
//
// A refresh that finds it needs a schema change, a component change, or a
// workflow change has left its class. That is not a failure of the run; it is
// the run correctly discovering it has work for a human. It stops and files an
// issue.
//
// Usage:
//   node gate-scope.mjs [--base <ref>] [--repo <dir>] [--json]
//
// With --base, compares against that ref (what the pull request will contain).
// Without it, inspects the working tree including untracked files.
//
// Exit 0 = in class. Exit 1 = out of class, do not auto-merge. Exit 2 = the
// runner could not run, which is never treated as a pass.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exactly the documents `web/src/data/raw.ts` imports. Kept as full repo-
// relative paths so a same-named file elsewhere cannot pass by accident.
const ALLOWED_PATHS = new Set([
  'web/src/data/sources.json',
  'web/src/data/publishers.json',
  'web/src/data/organizations.json',
  'web/src/data/families.json',
  'web/src/data/releases.json',
  'web/src/data/usage-observations.json',
  'web/src/data/usage-syntheses.json',
  'web/src/data/model-fit-statements.json',
  'web/src/data/model-fit-evidence-gaps.json',
]);

function parseArgs(argv) {
  const args = { base: null, repo: null, json: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--base') args.base = argv[++i];
    else if (flag === '--repo') args.repo = argv[++i];
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(`gate-scope: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
}

function repoRoot() {
  // .github/skills/modeltree-gates/scripts/gate-scope.mjs -> up five.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function changedPaths(cwd, base) {
  const lines = new Set();
  const add = (output) => {
    for (const line of output.split('\n')) {
      const path = line.trim();
      if (path.length > 0) lines.add(path);
    }
  };

  if (base) {
    // Three-dot: what this branch added, not what main moved on to.
    add(git(cwd, 'diff', '--name-only', `${base}...HEAD`));
  } else {
    add(git(cwd, 'diff', '--name-only'));
    add(git(cwd, 'diff', '--name-only', '--cached'));
    add(git(cwd, 'ls-files', '--others', '--exclude-standard'));
  }
  return [...lines].sort();
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('usage: gate-scope.mjs [--base <ref>] [--repo <dir>] [--json]\n');
    return 0;
  }

  const cwd = args.repo ? resolve(args.repo) : repoRoot();
  if (!existsSync(cwd)) {
    process.stderr.write(`gate-scope: no directory at ${cwd}\n`);
    return 2;
  }

  let paths;
  try {
    paths = changedPaths(cwd, args.base);
  } catch (error) {
    process.stderr.write(`gate-scope: git failed: ${error.message}\n`);
    return 2;
  }

  const outOfClass = paths.filter((path) => !ALLOWED_PATHS.has(path));
  const inClass = paths.filter((path) => ALLOWED_PATHS.has(path));
  const passed = outOfClass.length === 0;

  const result = {
    repo: cwd,
    base: args.base,
    changed: paths.length,
    inClass,
    outOfClass,
    passed,
    empty: paths.length === 0,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (paths.length === 0) {
    process.stdout.write('gate-scope: nothing changed, so there is nothing to publish\n');
  } else if (passed) {
    process.stdout.write(`gate-scope: in class - ${inClass.length} dataset document(s) changed\n`);
    for (const path of inClass) process.stdout.write(`  ${path}\n`);
  } else {
    process.stdout.write(
      `gate-scope: OUT OF CLASS - ${outOfClass.length} file(s) outside the dataset documents. `
      + 'ADR 0003 does not authorise auto-merging this; stop and file an issue.\n',
    );
    for (const path of outOfClass) process.stdout.write(`  ${path}\n`);
  }

  return passed ? 0 : 1;
}

process.exit(main());
