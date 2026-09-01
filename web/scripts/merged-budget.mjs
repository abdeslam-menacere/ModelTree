// Reports the `/compare` and picker byte budgets **for the merge**, not for the
// branch in isolation (issue #753).
//
// The defect this closes: a dock branches at commit X, measures a byte budget
// there, and trunk then moves. The dock's figure silently stops being a claim
// about what will ship and becomes a claim about history. It cost half of #740,
// which cut three researched creators at `picker 11,219 of 11,264 - 45 bytes
// spare`, measured against a merge-base two commits behind #748. #748 had
// trimmed the picker row shape; on the actual merge the figure was 7,556 of
// 11,264. The ceiling it obeyed had already been removed and nothing could have
// told it.
//
// The reverse direction is the dangerous one. If another tranche lands while
// yours is in flight, trunk *consumes* headroom. You measure at your stale base,
// see room, and add records that do not fit. Every gate on the branch passes,
// because `gate-dataset`, `gate-scope` and `npm run validate` all read the
// branch and not the merge; the ceiling breaks after the squash-merge, on main,
// where the post-merge run is the first test of the combination. This tool is
// able to say that before the merge.
//
// How it works, and why this shape:
//
//   1. **The anchor is derived, never supplied.** `git merge-base HEAD
//      refs/remotes/origin/main`, computed here. Identical to the way
//      `gate-scope.mjs` and `gate-source-approval.mjs` anchor, deliberately: two
//      instruments answering "which commit do I trust" two different ways is how
//      this class of bug survives. There is no `--base`. A missing
//      `refs/remotes/origin/main` is exit 2, never a guess, and never a fallback
//      to a local `main` — a local branch is a ref this working copy can move,
//      and an anchor the run can move is not an anchor.
//   2. **The merged state is produced without touching the branch.**
//      `git merge-tree --write-tree` writes the merged tree into the object
//      store and prints its id; nothing is checked out, no branch moves, no
//      worktree is registered, and no commit is created. A conflicted merge
//      exits non-zero there and is exit 2 here: a tree carrying conflict markers
//      is not a comparable artefact, so nothing is concluded from it.
//   3. **Both trees are materialized and measured the same way.** `HEAD`'s
//      `web/` and the merged `web/` are written to temp directories from the
//      object store, and *each tree's own* `scripts/comparison-budget.mjs` runs
//      inside it. If trunk changed the instruments, the merged figure is
//      produced by the merged instruments. Symmetry matters here: the only
//      difference between the two numbers must be the merge.
//
// Both figures are reported, labelled, with the difference stated. The reader
// has to be able to *see* the staleness rather than infer it.
//
// Exit codes: **0** the merged result is within every ceiling — including when
// it has more room than the branch-only figure suggested, because "you have
// more headroom than you thought" is advice and not a failure, and an advisory
// that fires on good news gets ignored. **1** the merged result breaches a
// ceiling. **2** the comparison could not be made. **2 is never a pass.**
//
// There is no `--force`, no `--skip`, and no environment variable that lowers a
// threshold. The ceilings are read out of `src/lib/comparison.test.ts` by the
// measurer and are not writable from here. An unrecognised flag exits 2.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the remote says `main` is. Identical to `gate-scope.mjs`'s, on purpose. */
const PUBLISHED_REF = 'refs/remotes/origin/main';

/** The subtree both measurements need. Everything the site imports lives here. */
const MEASURED_PATHSPEC = 'web';

const MEASURER = join('web', 'scripts', 'comparison-budget.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The commit this branch left published history at, and the published commit
 * itself.
 *
 * Every failure throws, and every throw ends as exit 2. There is no anchor to
 * fall back to: an unresolvable anchor means the tool does not know what it is
 * comparing against, and "I do not know" is never a pass.
 */
function resolveAnchor(cwd) {
  let published;
  try {
    published = git(cwd, 'rev-parse', '--verify', `${PUBLISHED_REF}^{commit}`).trim();
  } catch {
    throw new Error(
      `cannot resolve ${PUBLISHED_REF}, so there is no published history to measure the merge `
      + 'against. A shallow or single-branch clone will do this; fetch main and re-run. A local '
      + '`main` is deliberately not used as a fallback: it is a ref this working copy can move.',
    );
  }

  const head = git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}').trim();

  let anchor;
  try {
    anchor = git(cwd, 'merge-base', 'HEAD', published).trim();
  } catch {
    throw new Error(`HEAD shares no history with ${PUBLISHED_REF} (${published.slice(0, 10)})`);
  }
  if (anchor.length === 0) throw new Error(`no merge base between HEAD and ${PUBLISHED_REF}`);

  return {
    head,
    published,
    anchor,
    publishedRef: PUBLISHED_REF,
    // How far the anchor has fallen behind. This is the staleness, in one
    // number: 0 means the branch-only figure and the merged figure are measured
    // over the same trunk and cannot diverge for trunk-side reasons.
    trunkCommitsSinceAnchor: Number(
      git(cwd, 'rev-list', '--count', `${anchor}..${published}`).trim(),
    ),
  };
}

/**
 * The tree id of merging `HEAD` into the published commit, written into the
 * object store without checking anything out.
 *
 * The exit status is the whole of the discrimination and is read from an
 * unpiped invocation. `merge-tree` prints a tree id when the merge is clean and
 * *equally when it conflicts* — in the conflicted case it writes conflict
 * markers into the blobs and prints the id of the tree holding them. Reading the
 * id without the status would measure a tree full of `<<<<<<<` markers and
 * report it as the merged result.
 */
function mergedTreeOf(cwd, published) {
  const run = spawnSync('git', ['merge-tree', '--write-tree', published, 'HEAD'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (run.error) throw new Error(`could not run git merge-tree: ${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(
      `merging ${PUBLISHED_REF} (${published.slice(0, 10)}) with HEAD does not apply cleanly `
      + `(git merge-tree exit ${run.status}), so there is no merged state to measure. The tree it `
      + 'printed carries conflict markers and is not a comparable artefact; nothing is concluded '
      + 'from it. Resolve the conflict on the branch first — this tool does not rebase anything.',
    );
  }

  const tree = run.stdout.split('\n')[0]?.trim() ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`git merge-tree printed no tree id (got ${JSON.stringify(tree)})`);
  }
  return tree;
}

/**
 * Write `<treeish>:web` out to `dest`, straight from the object store.
 *
 * No worktree is registered and no commit is created, so nothing outside `dest`
 * is written and a crash leaves no state to prune. Every blob is fetched from
 * one `git cat-file --batch` process rather than one process per file.
 */
function materialize(cwd, treeish, dest) {
  const listing = git(cwd, 'ls-tree', '-r', '-z', treeish, '--', MEASURED_PATHSPEC);
  const entries = [];
  for (const record of listing.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    const [, type, oid] = record.slice(0, tab).split(' ');
    // Submodule entries are commits, not blobs, and nothing under web/ is one.
    if (type !== 'blob') continue;
    entries.push({ oid, path: record.slice(tab + 1) });
  }

  if (entries.length === 0) {
    throw new Error(`${treeish} holds no files under ${MEASURED_PATHSPEC}/`);
  }

  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    input: entries.map((entry) => entry.oid).join('\n'),
    maxBuffer: 512 * 1024 * 1024,
  });
  if (batch.error) throw new Error(`could not run git cat-file: ${batch.error.message}`);
  if (batch.status !== 0) {
    throw new Error(`git cat-file --batch exited ${batch.status}: ${batch.stderr}`);
  }

  const buffer = batch.stdout;
  let cursor = 0;
  for (const entry of entries) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline === -1) throw new Error(`git cat-file output ended before ${entry.path}`);
    const header = buffer.toString('utf8', cursor, newline).split(' ');
    const size = Number(header[2]);
    if (header[0] !== entry.oid || !Number.isSafeInteger(size)) {
      throw new Error(`git cat-file returned ${header.join(' ')} where ${entry.oid} was asked for`);
    }
    const start = newline + 1;
    const target = join(dest, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buffer.subarray(start, start + size));
    cursor = start + size + 1;
  }

  return entries.length;
}

/** Remove a directory link without following it into the real node_modules. */
function unlink(path) {
  if (!existsSync(path)) return;
  try {
    rmdirSync(path);
  } catch {
    unlinkSync(path);
  }
}

/**
 * Measure one materialized tree by running *its own* copy of the measurer.
 *
 * Dependencies are linked rather than installed: `npm ci` per tree would add
 * minutes to every run, and the packages a measurement needs are pinned by the
 * lockfile. Where the tree's lockfile or manifest differs from the installed
 * one, that link is no longer a faithful stand-in for what the tree would
 * install, so the measurement is refused rather than taken against the wrong
 * dependency set.
 */
function measure(dest, installedWebRoot, dependencyGuard) {
  const webRoot = join(dest, 'web');
  const measurer = join(dest, MEASURER);
  if (!existsSync(measurer)) {
    throw new Error(
      `${MEASURER} is not present in this tree, so it cannot be measured. Commit the measurer `
      + 'before comparing, and if it is missing from the merged tree, trunk has removed it.',
    );
  }

  dependencyGuard(webRoot);

  const link = join(webRoot, 'node_modules');
  symlinkSync(
    join(installedWebRoot, 'node_modules'),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  try {
    const run = spawnSync(process.execPath, [measurer, '--json'], {
      cwd: webRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) throw new Error(`could not run the measurer: ${run.error.message}`);
    // 0 is within budget and 1 is over it; both are measurements and both are
    // parsed. Anything else is the measurer refusing to measure.
    if (run.status !== 0 && run.status !== 1) {
      throw new Error(
        `the measurer exited ${run.status} rather than taking a measurement:\n${run.stderr.trim()}`,
      );
    }
    return JSON.parse(run.stdout);
  } finally {
    unlink(link);
  }
}

/**
 * Refuse a linked measurement whose tree would not install what is linked.
 *
 * The lockfile is the whole test, and deliberately the only one: `npm ci`
 * installs from it alone, so two trees with the same lockfile install the same
 * packages whatever else differs between them. Everything else the measurement
 * reads — the manifest, the config, the source — is materialized from the tree
 * itself and is not borrowed.
 *
 * Returns a guard closure bound to the dock's own lockfile.
 */
function dependencyGuardFor(installedWebRoot) {
  const name = 'package-lock.json';
  const installed = readFileSync(join(installedWebRoot, name), 'utf8');

  return (webRoot) => {
    const candidate = join(webRoot, name);
    if (!existsSync(candidate)) {
      throw new Error(`the tree under measurement has no web/${name}`);
    }
    if (readFileSync(candidate, 'utf8') !== installed) {
      throw new Error(
        `web/${name} differs between this checkout and the tree being measured, so the installed `
        + 'node_modules is not what that tree would install and a measurement taken against it '
        + 'would not be the one that binds. This happens when trunk changed a dependency: bring '
        + 'the branch level with trunk on web/package-lock.json, or re-run with --keep and run '
        + '`npm ci` inside the kept merged tree. Nothing here lowers a threshold to get past it.',
      );
    }
  };
}

/**
 * The verdict, from two measurements. Pure, so it can be tested without git.
 *
 * The merged side decides everything, including which ceiling applies: if trunk
 * moved a ceiling, the merged one is the one that will bind, and the difference
 * is reported rather than averaged away. The branch-only side is carried purely
 * so a reader can see what it would have concluded.
 */
export function decide(head, merged) {
  const headById = new Map(head.metrics.map((metric) => [metric.id, metric]));

  const metrics = merged.metrics.map((mergedMetric) => {
    const headMetric = headById.get(mergedMetric.id) ?? null;
    const row = {
      id: mergedMetric.id,
      label: mergedMetric.label,
      unit: mergedMetric.unit,
      head: headMetric,
      merged: mergedMetric,
      valueDelta: headMetric === null ? null : mergedMetric.value - headMetric.value,
      ceilingDelta: headMetric === null ? null : mergedMetric.ceiling - headMetric.ceiling,
      headroomDelta: headMetric === null ? null : mergedMetric.headroom - headMetric.headroom,
    };

    if (!mergedMetric.within) {
      row.finding = headMetric !== null && headMetric.within ? 'new-breach' : 'breach';
    } else if (row.headroomDelta === null || row.headroomDelta === 0) {
      row.finding = 'unchanged';
    } else {
      row.finding = row.headroomDelta > 0 ? 'freed' : 'consumed';
    }

    return row;
  });

  const of = (finding) => metrics.filter((metric) => metric.finding === finding);
  const newBreaches = of('new-breach');
  const breaches = [...newBreaches, ...of('breach')];

  return {
    metrics,
    newBreaches,
    breaches,
    freed: of('freed'),
    consumed: of('consumed'),
    ceilingChanges: metrics.filter((metric) => metric.ceilingDelta !== null && metric.ceilingDelta !== 0),
    diverged: metrics.some((metric) => metric.valueDelta !== 0 || metric.ceilingDelta !== 0),
    // 0 exactly when the merged result is within every ceiling. More room than
    // the branch thought is advice, so it is reported and not failed.
    exitCode: breaches.length === 0 ? 0 : 1,
  };
}

const group = (value) => value.toLocaleString('en-US');
const signed = (value) => `${value > 0 ? '+' : value < 0 ? '-' : '\u00b1'}${group(Math.abs(value))}`;

export function render(anchor, verdict, dirty) {
  const lines = [];
  const short = (sha) => sha.slice(0, 10);

  lines.push(
    `anchor      ${short(anchor.anchor)}  (git merge-base HEAD ${PUBLISHED_REF}, derived here)`,
    `HEAD        ${short(anchor.head)}`,
    `${PUBLISHED_REF.padEnd(11)} ${short(anchor.published)}  `
    + `${anchor.trunkCommitsSinceAnchor} commit(s) ahead of the anchor`,
    '',
  );

  if (anchor.trunkCommitsSinceAnchor === 0) {
    lines.push(
      'Trunk has not moved since this branch left it, so the branch-only figure and the merged',
      'figure are measured over the same trunk and agree by construction.',
      '',
    );
  }

  const width = Math.max(...verdict.metrics.map((metric) => metric.label.length));
  lines.push(
    `  ${'metric'.padEnd(width)}  ${'branch-only'.padStart(11)}  ${'MERGED'.padStart(11)}  `
    + `${'ceiling'.padStart(9)}  ${'merged spare'.padStart(12)}  difference`,
  );

  for (const metric of verdict.metrics) {
    const headCell = metric.head === null ? 'n/a' : group(metric.head.value);
    const difference = metric.valueDelta === null
      ? 'metric is new on the merged side'
      : metric.valueDelta === 0 && metric.ceilingDelta === 0
        ? 'same on both sides'
        : [
          metric.valueDelta === 0 ? null : `value ${signed(metric.valueDelta)}`,
          metric.ceilingDelta === 0 ? null : `ceiling ${signed(metric.ceilingDelta)}`,
          `headroom ${signed(metric.headroomDelta)}`,
        ].filter(Boolean).join(', ');

    lines.push(
      `  ${metric.label.padEnd(width)}  ${headCell.padStart(11)}  `
      + `${group(metric.merged.value).padStart(11)}  ${group(metric.merged.ceiling).padStart(9)}  `
      + `${(metric.merged.within ? group(metric.merged.headroom) : `OVER by ${group(-metric.merged.headroom)}`).padStart(12)}  `
      + difference,
    );
  }

  lines.push('');

  if (verdict.ceilingChanges.length > 0) {
    lines.push('Trunk moved a ceiling this branch measured against:');
    for (const metric of verdict.ceilingChanges) {
      lines.push(
        `  - ${metric.label}: ${group(metric.head.ceiling)} at HEAD, `
        + `${group(metric.merged.ceiling)} merged. The merged one is what binds.`,
      );
    }
    lines.push('');
  }

  if (verdict.breaches.length > 0) {
    lines.push('OVER BUDGET ON THE MERGE.');
    for (const metric of verdict.newBreaches) {
      lines.push(
        `  - ${metric.label}: within budget on this branch alone `
        + `(${group(metric.head.value)} of ${group(metric.head.ceiling)}, `
        + `${group(metric.head.headroom)} spare) and OVER on the merge `
        + `(${group(metric.merged.value)} of ${group(metric.merged.ceiling)}, `
        + `${group(-metric.merged.headroom)} over). Trunk consumed the headroom this branch is`,
        '    spending. Every gate on the branch will pass and the ceiling will break after the',
        '    squash-merge, on main. Cut scope or trim the row shape before handing off.',
      );
    }
    for (const metric of verdict.breaches.filter((m) => m.finding === 'breach')) {
      lines.push(
        `  - ${metric.label}: over on the merge (${group(metric.merged.value)} of `
        + `${group(metric.merged.ceiling)}) and over on this branch alone too, so the branch's own`,
        '    tests already refuse it. This is not a merge-staleness finding.',
      );
    }
  } else if (verdict.freed.length > 0) {
    lines.push(
      'Within every ceiling on the merge, and trunk has FREED headroom this branch cannot see:',
    );
    for (const metric of verdict.freed) {
      lines.push(
        `  - ${metric.label}: ${group(metric.head.headroom)} spare measured at HEAD, `
        + `${group(metric.merged.headroom)} spare on the merge (${signed(metric.headroomDelta)}).`,
      );
    }
    lines.push(
      '',
      'This is advice, not a failure. It is reported because the branch-only figure understates',
      'what will actually fit: do not cut scope against the smaller number.',
    );
  } else {
    lines.push('Within every ceiling on the merge.');
    for (const metric of verdict.consumed) {
      lines.push(
        `  - ${metric.label}: trunk consumed ${group(-metric.headroomDelta)} bytes of headroom `
        + `since the anchor; ${group(metric.merged.headroom)} still spare.`,
      );
    }
  }

  if (dirty.length > 0) {
    lines.push(
      '',
      `NOTE: ${dirty.length} uncommitted change(s) under web/ are in NEITHER figure. Both sides are`,
      'measured from committed state, because the merged side can only be built from commits.',
      'Commit and re-run if the change under measurement is still on disk:',
      ...dirty.slice(0, 10).map((path) => `  ${path}`),
    );
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { json: false, keep: false, help: false };
  for (const flag of argv.slice(2)) {
    if (flag === '--json') args.json = true;
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      process.stderr.write(
        `merged-budget: unknown flag ${flag}\n`
        + 'There is no --base: the anchor is derived. There is no --force and no --skip.\n',
      );
      process.exit(2);
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('usage: node scripts/merged-budget.mjs [--json] [--keep]\n');
    return 0;
  }

  const installedWebRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoRoot = dirname(installedWebRoot);

  if (!existsSync(join(installedWebRoot, 'node_modules', 'vite'))) {
    process.stderr.write(
      'merged-budget: web/node_modules is not installed, so no tree can be measured. '
      + 'Run `npm ci` from web/ and re-run.\n',
    );
    return 2;
  }

  let anchor;
  let mergedTree;
  let dirty;
  try {
    anchor = resolveAnchor(repoRoot);
    mergedTree = mergedTreeOf(repoRoot, anchor.published);
    dirty = git(repoRoot, 'status', '--porcelain', '--', MEASURED_PATHSPEC)
      .split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  } catch (error) {
    process.stderr.write(`merged-budget: ${error?.message ?? error}\n`);
    return 2;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'modeltree-merged-budget-'));
  let verdict;
  try {
    const guard = dependencyGuardFor(installedWebRoot);
    const trees = { head: `${anchor.head}^{tree}`, merged: mergedTree };
    const measured = {};
    for (const [side, treeish] of Object.entries(trees)) {
      const dest = join(scratch, side);
      mkdirSync(dest, { recursive: true });
      materialize(repoRoot, treeish, dest);
      measured[side] = measure(dest, installedWebRoot, guard);
    }
    verdict = decide(measured.head, measured.merged);
  } catch (error) {
    process.stderr.write(`merged-budget: ${error?.message ?? error}\n`);
    return 2;
  } finally {
    if (args.keep) process.stderr.write(`merged-budget: kept ${scratch}\n`);
    else rmSync(scratch, { recursive: true, force: true });
  }

  process.stdout.write(args.json
    ? `${JSON.stringify({
      anchor, mergedTree, workingTreeDirty: dirty, ...verdict,
    }, null, 2)}\n`
    : render({ ...anchor, mergedTree }, verdict, dirty));

  return verdict.exitCode;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(await main(process.argv));
}

export { PUBLISHED_REF, materialize, resolveAnchor };
