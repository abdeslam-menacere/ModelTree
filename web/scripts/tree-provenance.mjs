// Which tree was just measured, and whether it is the tree CI measures --
// abdeslam-menacere/ModelTree#832.
//
// A raw-byte figure is a claim about a source tree, and there are two trees in
// play whenever trunk has moved. A local `astro build` builds the branch alone.
// `.github/workflows/web-ci.yml` checks out with no `ref:` override, so a
// `pull_request` run builds `refs/pull/N/merge` -- the branch merged with
// trunk. Nothing before this told a reader which of the two they were holding,
// so a figure recorded on the first was routinely offered as a description of
// the second.
//
// This probe answers that in one number: how far HEAD sits behind the published
// trunk. Zero means the two trees cannot diverge for trunk-side reasons.
//
// Three properties, each deliberate:
//
//   * **It never throws and never fails a caller.** It is an advisory reading
//     attached to a report, not a gate. A test that reddened because git was
//     unavailable would be a new false failure added while removing a false
//     pass.
//   * **`undetermined` is a state of its own**, never rounded to "level with
//     trunk". A probe that could not answer has not established that the branch
//     is current, and reading it as though it had restores the false green.
//   * **The anchor is `refs/remotes/origin/main`**, the same ref
//     `scripts/merged-budget.mjs` and `gate-scope.mjs` anchor on. A local `main`
//     is deliberately not a fallback: it is a ref this working copy can move,
//     and an anchor the run can move is not an anchor.
//
// Every git call goes through `spawnSync` with an argument array, so the
// revision range is passed to git as one argv element and never reaches a
// shell. That is not stylistic: in PowerShell an unquoted `$a..$b` is split
// into two arguments, git answers a different question, and it answers it
// successfully -- exit 0, no warning, wrong number.

import { spawnSync } from 'node:child_process';

/** What the remote says `main` is. Identical to `merged-budget.mjs`'s, on purpose. */
export const PUBLISHED_REF = 'refs/remotes/origin/main';

function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // `spawnSync` sets `error` when git itself could not be launched -- most
  // commonly not on PATH. That is a different cause from a ref that does not
  // resolve, and it needs different advice, so it is flagged rather than folded
  // into a generic failure (#847, finding 4b).
  if (run.error) {
    return { ok: false, unrunnable: true, reason: `could not run git: ${run.error.message}` };
  }
  // The exit status is the whole of the discrimination and is read from an
  // unpiped invocation: empty output from a command that failed is not an empty
  // result.
  if (run.status !== 0) {
    return {
      ok: false,
      reason: `git ${args.join(' ')} exited ${run.status}: ${(run.stderr ?? '').trim() || 'no stderr'}`,
    };
  }
  return { ok: true, value: (run.stdout ?? '').trim() };
}

const short = (sha) => sha.slice(0, 10);

/**
 * @returns {{status: 'level'|'behind'|'undetermined', ref: string, head?: string,
 *            trunk?: string, behind?: number, reason?: string}}
 */
export function probeTreeProvenance(cwd) {
  const undetermined = (reason) => ({ status: 'undetermined', ref: PUBLISHED_REF, reason });

  try {
    const trunk = git(cwd, ['rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`]);
    if (!trunk.ok) {
      // git absent from PATH is not a ref that fails to resolve, and `git fetch`
      // cannot fix a missing git. Pass its own reason through for that cause
      // (#847, finding 4b), and reserve the fetch advice for a genuinely
      // unresolved ref -- a shallow or single-branch clone.
      if (trunk.unrunnable) return undetermined(trunk.reason);
      return undetermined(
        `${PUBLISHED_REF} does not resolve here, so there is no published trunk to compare ` +
          'against; a shallow or single-branch clone does this. `git fetch origin main` fixes it',
      );
    }

    const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!head.ok) return undetermined(head.reason);

    // Commits on trunk that this HEAD does not have. Not ancestry: this
    // repository squash-merges, so a landed branch is a permanent non-ancestor
    // of trunk and `--is-ancestor` answers a different question wrongly.
    const behind = git(cwd, ['rev-list', '--count', `${head.value}..${trunk.value}`]);
    if (!behind.ok) return undetermined(behind.reason);

    const count = Number(behind.value);
    if (!Number.isSafeInteger(count) || count < 0) {
      return undetermined(`git rev-list --count returned ${JSON.stringify(behind.value)}`);
    }

    return {
      status: count === 0 ? 'level' : 'behind',
      ref: PUBLISHED_REF,
      head: short(head.value),
      trunk: short(trunk.value),
      behind: count,
    };
  } catch (error) {
    return undetermined(`the provenance probe threw: ${error?.message ?? String(error)}`);
  }
}
