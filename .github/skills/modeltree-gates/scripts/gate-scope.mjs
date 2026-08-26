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
// **Which commit the change is measured from is not the run's choice to make.**
// This gate used to answer "what changed" by asking the working tree only -
// unstaged, staged, untracked - whenever no `--base` was passed, which was every
// documented invocation. A run that committed its work first emptied all three
// questions at once, so the gate reported `nothing changed` and exited 0 having
// examined nothing, and `tools/updater/profiles/**` was unforgeable only for as
// long as nobody committed. Of the failure modes available to a gate, passing
// green while inspecting nothing is the worst, because the safe-looking outcome
// is the one that carries no information.
//
// So the anchor is computed, not supplied: `git merge-base HEAD
// refs/remotes/origin/main`, the point at which this branch left published
// history. Committing moves `HEAD` but never the merge base, so commit-then-gate
// buys the run nothing. This is the same anchor, resolved the same way, as
// `gate-source-approval.mjs` - deliberately, because two gates answering "which
// commit do I trust" two different ways is how this class of bug survives.
//
// The change measured is the union of two things, and both are always consulted:
// what this branch committed since the anchor, and what the working tree holds
// on top of it (unstaged, staged, untracked). Neither replaces the other. Gating
// an uncommitted edit is the normal interactive loop and still refuses; gating
// after a commit now refuses identically. Every path the old gate would have
// reported is still reported, in both modes, and more besides.
//
// `refs/remotes/origin/main` is what the remote says `main` is. A run cannot move
// it without pushing to a protected branch, which is the auditable path ADR 0003
// asks for. A stale one only moves the anchor *backwards*, which widens the diff
// and can only add refusals - safe, and stated here so it is not mistaken for a
// hole. A missing one - a shallow or single-branch clone, or a `--repo` with no
// such remote - is a gate that cannot run, so it exits 2 rather than guessing; a
// missing anchor that exited 0 would be a worse bug than the one this replaces.
//
// Usage:
//   node gate-scope.mjs [--base <ref>] [--repo <dir>] [--json]
//
// `--base` is optional and can only ever **narrow**. The anchor is the merge base
// with `refs/remotes/origin/main` whether or not it is passed; supplying it pins
// an older commit that is already an ancestor of that merge base, which is useful
// for re-gating an older bundle. A ref that is not an ancestor of the merge base
// - anything this branch authored, `HEAD` included - exits 2. Making the flag
// *required* would not have helped: a required value is still a value the agent
// under test supplies. There is no `--force`, no `--skip`, and no environment
// variable; an unrecognised flag exits 2.
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

// What the remote says `main` is. Not a local branch: a local `main` is a ref
// this working copy can move, and an anchor the run can move is not an anchor.
// Identical to `gate-source-approval.mjs`'s, on purpose.
const PUBLISHED_REF = 'refs/remotes/origin/main';

function parseArgs(argv) {
  // `base` starts as null, not `HEAD`: absence must not be the most permissive
  // setting, and here it resolves to the merge base rather than to the run's own
  // commit. `null` means "not supplied" and is distinct from a supplied but
  // unusable value, which exits 2.
  const args = { base: null, repo: null, json: false, help: false };
  const value = (i, flag) => {
    const next = argv[i];
    if (typeof next !== 'string' || next.length === 0) {
      process.stderr.write(`gate-scope: ${flag} needs a value\n`);
      process.exit(2);
    }
    return next;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--base') args.base = value(++i, '--base');
    else if (flag === '--repo') args.repo = value(++i, '--repo');
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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * The commit the change is measured from, and the one decision in this gate that
 * the run is not allowed to make.
 *
 * It is the merge base of `HEAD` with the published `main`: the last commit this
 * branch shares with reviewed history. Committing only moves `HEAD`, never the
 * merge base, so commit-then-gate buys the run nothing.
 *
 * A caller-supplied `--base` may only narrow - it has to be an ancestor of that
 * merge base, so it can pin something older and reviewed but can never select
 * anything this branch authored.
 *
 * Every failure here throws, and every throw ends as exit 2. There is no anchor
 * this can fall back to: an unresolvable anchor means the gate does not know what
 * changed, and "I do not know" is never a pass.
 */
function resolveAnchor(cwd, requested) {
  let published;
  try {
    published = git(cwd, 'rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`).trim();
  } catch {
    throw new Error(
      `cannot resolve ${PUBLISHED_REF}, so there is no published history to measure this change `
      + 'against. A shallow or single-branch clone will do this; fetch main before gating',
    );
  }

  let anchor;
  try {
    anchor = git(cwd, 'merge-base', 'HEAD', published).trim();
  } catch {
    throw new Error(`HEAD shares no history with ${PUBLISHED_REF} (${published.slice(0, 10)})`);
  }
  if (anchor.length === 0) throw new Error(`no merge base between HEAD and ${PUBLISHED_REF}`);

  if (requested === null) return { anchor, published, requested: null };

  let pinned;
  try {
    pinned = git(cwd, 'rev-parse', '--verify', `${requested}^{commit}`).trim();
  } catch {
    throw new Error(`--base ${requested} is not a commit in this repository`);
  }
  try {
    // `--is-ancestor` exits non-zero when it does not hold, which throws here.
    // A commit is its own ancestor, so pinning the merge base itself is allowed.
    git(cwd, 'merge-base', '--is-ancestor', pinned, anchor);
  } catch {
    throw new Error(
      `--base ${requested} (${pinned.slice(0, 10)}) is not an ancestor of the merge base with `
      + `${PUBLISHED_REF} (${anchor.slice(0, 10)}), so it would hide commits this branch `
      + 'authored. --base may only narrow the anchor to an older reviewed commit, never widen '
      + 'it to one this branch authored',
    );
  }
  return { anchor: pinned, published, requested };
}

/**
 * Every path this change touches, relative to the anchor.
 *
 * Both halves are always asked, and the answer is their union:
 *
 *   1. **Committed** - `<anchor>...HEAD`. Three-dot: what this branch added, not
 *      what main moved on to. This is the half that used to be skipped entirely
 *      whenever `--base` was absent.
 *   2. **Working tree** - unstaged, staged, untracked. This is the half that
 *      already worked, and it is kept because editing files and gating before
 *      committing is the normal interactive loop. Dropping it would trade one
 *      blind spot for another.
 *
 * Neither is conditional on the other, so a change that is half committed and
 * half still on disk is reported whole.
 */
function changedPaths(cwd, anchor) {
  const lines = new Set();
  const add = (output) => {
    for (const line of output.split('\n')) {
      const path = line.trim();
      if (path.length > 0) lines.add(path);
    }
  };

  add(git(cwd, 'diff', '--name-only', `${anchor}...HEAD`));
  add(git(cwd, 'diff', '--name-only'));
  add(git(cwd, 'diff', '--name-only', '--cached'));
  add(git(cwd, 'ls-files', '--others', '--exclude-standard'));

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

  let anchor;
  let paths;
  try {
    anchor = resolveAnchor(cwd, args.base);
    paths = changedPaths(cwd, anchor.anchor);
  } catch (error) {
    process.stderr.write(`gate-scope: ${error.message}\n`);
    return 2;
  }
  const anchorAt = anchor.anchor.slice(0, 10);

  const outOfClass = paths.filter((path) => !ALLOWED_PATHS.has(path));
  const inClass = paths.filter((path) => ALLOWED_PATHS.has(path));
  const passed = outOfClass.length === 0;

  const result = {
    repo: cwd,
    // The resolved commit, never the flag. A reader of this report has to be able
    // to see which commit the change was actually measured from.
    base: anchor.anchor,
    anchor: {
      commit: anchor.anchor,
      publishedRef: PUBLISHED_REF,
      publishedCommit: anchor.published,
      selectedBy: anchor.requested === null
        ? `merge-base of HEAD with ${PUBLISHED_REF}`
        : `--base ${anchor.requested}, narrowed from the merge-base with ${PUBLISHED_REF}`,
      requestedBase: anchor.requested,
    },
    changed: paths.length,
    inClass,
    outOfClass,
    passed,
    empty: paths.length === 0,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (paths.length === 0) {
    // Reachable only once the anchor resolved and both halves came back empty,
    // which is a finding rather than a fallthrough. "Not checked" does not print
    // here at all - it exited 2 above.
    process.stdout.write(
      `gate-scope: nothing changed since ${anchorAt} and the working tree is clean, `
      + 'so there is nothing to publish\n',
    );
  } else if (passed) {
    process.stdout.write(
      `gate-scope: in class - ${inClass.length} dataset document(s) changed since ${anchorAt}\n`,
    );
    for (const path of inClass) process.stdout.write(`  ${path}\n`);
  } else {
    process.stdout.write(
      `gate-scope: OUT OF CLASS - ${outOfClass.length} file(s) outside the dataset documents `
      + `since ${anchorAt}. `
      + 'ADR 0003 does not authorise auto-merging this; stop and file an issue.\n',
    );
    for (const path of outOfClass) process.stdout.write(`  ${path}\n`);
  }

  return passed ? 0 : 1;
}

process.exit(main());
