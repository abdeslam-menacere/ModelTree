// The red-then-green proof for the merged-budget instrument (issue #753, AC6).
//
// A tool that has never returned the failing answer has not been shown to be
// able to return it. This constructs, from the repository's real dataset and
// real instruments, three states that a dock can actually be in, runs the real
// `merged-budget.mjs` against each, and checks it reaches the right verdict:
//
//   1. **trunk consumed headroom** — the branch alone is within budget and the
//      merge is not. This is the dangerous direction. Every gate on the branch
//      passes; the ceiling breaks after the squash-merge, on main. Expect
//      **exit 1**, with the breach named as one the branch-only figure did not
//      show.
//   2. **trunk freed headroom** — #740's direction, where the branch-only figure
//      understates what will fit and scope gets cut for a ceiling that has
//      already moved. Expect **exit 0**: an advisory that fires on good news
//      gets ignored, and then the dangerous case goes unread with it.
//   3. **trunk has not moved** — the two figures are measured over the same
//      trunk and cannot diverge. Expect **exit 0** and no alarm.
//
// Each scenario is a throwaway git repository built in a temp directory from
// this repository's current `refs/remotes/origin/main`. Nothing here touches
// the dock's own branch, no remote is contacted, and nothing is pushed. The
// scenarios differ only in their data: `organizations.json` stands in for a
// tranche that landed on trunk, `families.json` for the one this branch is
// carrying. Both are ordinary string fields, so every state below is a dataset
// the schema accepts — the sizes are real measurements, not stubs.
//
// The pad sizes are computed from the live measurement rather than written
// down, so this keeps proving the same thing as the catalogue grows. A hard
// figure here would be one more number measured against a state it no longer
// binds to, which would be a poor joke in this file of all files.
//
// Run it with `npm run budget:proof` from web/. Exit 0 every scenario reached
// its expected verdict, 1 one did not, 2 the proof could not be constructed.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLISHED_REF, materialize } from './merged-budget.mjs';

const installedWebRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(installedWebRoot);

const IDENTITY = [
  '-c', 'user.name=merged-budget scenario',
  '-c', 'user.email=scenario@localhost',
  '-c', 'commit.gpgsign=false',
];

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

function commit(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, ...IDENTITY, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

function link(webRoot) {
  symlinkSync(
    join(installedWebRoot, 'node_modules'),
    join(webRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function unlink(path) {
  if (!existsSync(path)) return;
  try {
    rmdirSync(path);
  } catch {
    unlinkSync(path);
  }
}

/** Lengthen one string field on every record of a dataset document. */
function pad(repo, document, field, characters) {
  const path = join(repo, 'web', 'src', 'data', document);
  const records = JSON.parse(readFileSync(path, 'utf8'));
  const suffix = ` ${'x'.repeat(Math.max(characters - 1, 0))}`;
  for (const record of records) record[field] = `${record[field]}${suffix}`;
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

/** Undo {@link pad}: restore a document to text captured before padding. */
function restore(repo, document, text) {
  writeFileSync(join(repo, 'web', 'src', 'data', document), text, 'utf8');
}

function documentText(repo, document) {
  return readFileSync(join(repo, 'web', 'src', 'data', document), 'utf8');
}

/**
 * A fresh repository holding this branch's `web/`, with no remote.
 *
 * Seeded from `HEAD` rather than from `refs/remotes/origin/main` because the
 * tool under test is on this branch and has to be present in every tree the
 * scenario builds. What the scenarios vary is the *data*, which is the variable
 * the defect is about; the instruments are held fixed at this branch's.
 */
function seedRepo(scratch, name) {
  const repo = join(scratch, name);
  mkdirSync(repo, { recursive: true });
  materialize(repoRoot, 'HEAD^{tree}', repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  return { repo, base: commit(repo, 'seed: web/ as this branch has it') };
}

function runMeasurer(webRoot) {
  const run = spawnSync(process.execPath, [join(webRoot, 'scripts', 'comparison-budget.mjs'), '--json'], {
    cwd: webRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`the measurer exited ${run.status}: ${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

function runDriver(webRoot) {
  const run = spawnSync(process.execPath, [join(webRoot, 'scripts', 'merged-budget.mjs')], {
    cwd: webRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/**
 * Pad sizes derived from a live measurement of the seeded tree.
 *
 * Every picker row carries its creator label and its family name, so padding a
 * creator's `shortName` by one character costs one byte on every release that
 * creator owns, and the same for a family's `name`. That is why a tranche on
 * trunk and a tranche on a branch each move this index, and why neither can see
 * the other's contribution from where it is standing.
 */
function planPads(measurement) {
  const picker = measurement.metrics.find((metric) => metric.id === 'picker.totalBytes');
  const rows = measurement.pickerRowCount;

  // Trunk takes most of the free headroom, staying inside its own ceiling --
  // trunk is green, or main would already be red.
  const trunk = Math.floor((picker.headroom * 0.92) / rows);
  // The branch adds enough on top to cross it, while being comfortably within
  // budget measured on its own.
  const branch = Math.ceil((picker.headroom - trunk * rows) / rows) + 6;

  return { trunk, branch, rows, picker };
}

const scenarios = [
  {
    name: 'trunk CONSUMED headroom while this branch was in flight',
    expect: 1,
    why: 'the branch alone fits and the merge does not -- the dangerous direction',
    build(scratch, pads) {
      const { repo, base } = seedRepo(scratch, 'consumed');

      pad(repo, 'organizations.json', 'shortName', pads.trunk);
      const trunk = commit(repo, 'trunk: a creator tranche lands while this branch is in flight');

      git(repo, 'checkout', '-q', '-b', 'dock', base);
      pad(repo, 'families.json', 'name', pads.branch);
      commit(repo, 'dock: the tranche this branch is carrying');

      git(repo, 'update-ref', PUBLISHED_REF, trunk);
      return repo;
    },
  },
  {
    name: 'trunk FREED headroom this branch cannot see',
    expect: 0,
    why: "#740's direction: the branch-only figure understates what will fit",
    build(scratch, pads) {
      const { repo } = seedRepo(scratch, 'freed');
      const original = documentText(repo, 'organizations.json');

      // The branch's merge-base is already carrying the weight, exactly as
      // #740's was carrying the pre-#748 picker row shape.
      pad(repo, 'organizations.json', 'shortName', Math.floor(pads.trunk / 2));
      const heavyBase = commit(repo, 'base: the state this branch left trunk at');

      restore(repo, 'organizations.json', original);
      const trunk = commit(repo, 'trunk: a trim lands, recovering the headroom (cf. #748)');

      git(repo, 'checkout', '-q', '-b', 'dock', heavyBase);
      pad(repo, 'families.json', 'name', 4);
      commit(repo, 'dock: the tranche this branch is carrying');

      git(repo, 'update-ref', PUBLISHED_REF, trunk);
      return repo;
    },
  },
  {
    name: 'trunk has NOT moved',
    expect: 0,
    why: 'the two figures are measured over the same trunk and agree by construction',
    build(scratch) {
      const { repo, base } = seedRepo(scratch, 'still');
      git(repo, 'checkout', '-q', '-b', 'dock', base);
      pad(repo, 'families.json', 'name', 4);
      commit(repo, 'dock: the tranche this branch is carrying');
      git(repo, 'update-ref', PUBLISHED_REF, base);
      return repo;
    },
  },
];

function main() {
  if (!existsSync(join(installedWebRoot, 'node_modules', 'vite'))) {
    process.stderr.write('merged-budget-scenario: run `npm ci` from web/ first\n');
    return 2;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'modeltree-budget-proof-'));
  const links = [];
  const failures = [];

  try {
    const seeded = seedRepo(scratch, 'baseline');
    link(join(seeded.repo, 'web'));
    links.push(join(seeded.repo, 'web', 'node_modules'));
    const pads = planPads(runMeasurer(join(seeded.repo, 'web')));

    process.stdout.write(
      `Seeded from HEAD: picker index ${pads.picker.value.toLocaleString('en-US')} of `
      + `${pads.picker.ceiling.toLocaleString('en-US')} bytes over ${pads.rows} rows, `
      + `${pads.picker.headroom.toLocaleString('en-US')} spare.\n`
      + `Trunk tranche pads every creator label by ${pads.trunk} characters; `
      + `the branch tranche pads every family name by ${pads.branch}.\n`,
    );

    for (const scenario of scenarios) {
      const repo = scenario.build(scratch, pads);
      const webRoot = join(repo, 'web');
      link(webRoot);
      links.push(join(webRoot, 'node_modules'));

      const { status, output } = runDriver(webRoot);
      const ok = status === scenario.expect;
      if (!ok) failures.push(`${scenario.name}: expected exit ${scenario.expect}, got ${status}`);

      process.stdout.write(
        `\n${'='.repeat(78)}\n${scenario.name}\n  ${scenario.why}\n`
        + `  expected exit ${scenario.expect}\n${'='.repeat(78)}\n\n`
        + `${output}\n  -> exit ${status}  ${ok ? 'as expected' : 'NOT AS EXPECTED'}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`merged-budget-scenario: ${error?.message ?? error}\n`);
    return 2;
  } finally {
    for (const path of links) unlink(path);
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} scenario(s) went the wrong way:\n`);
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    return 1;
  }

  process.stdout.write('\nEvery scenario reached its expected verdict.\n');
  return 0;
}

process.exit(main());
