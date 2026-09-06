#!/usr/bin/env node
//
// Voids a gate's arm reading that another gate sharing the worktree may have
// corrupted, before the arm's exit code is read (#1056).
//
// ## The defect
//
// A gate proves a guard catches something by mutating a file, running the
// guard, reading the exit code, and restoring. `review-863d` and `qa-863` were
// dispatched in parallel against one dock worktree and both did that to the
// same two files. The restore is what makes the collision silent:
// `git checkout -- <path>` does not undo *my* edit, it restores *the file*, so
// one gate's restore reverts another gate's live mutation with no error, no
// output, and nothing in either transcript.
//
// Four interleavings, and only the sign of the last one matters:
//
//   1. B mutates, A restores, B measures      -> exits 0, "the guard does not
//      fire"                                     -- false FAIL, recoverable
//   2. A mutates, B measures its clean arm    -> exits 1, "a clean tree
//      reddens"                                  -- false FAIL, recoverable
//   3. B restores, A mutates, B measures clean-> exits 1
//      -- false FAIL, recoverable
//   4. A mutates, B's own mutation is already gone, B measures its red arm
//      -> exits 1 from *A's* mutation, read as "my mutation fired the guard"
//      -- false PASS, UNRECOVERABLE
//
// Row 4 is the reason this file exists. A red arm is the only evidence a gate
// has that a guard catches anything; if it passes for a reason the gate did not
// create, the gate certifies a guard that does not catch what it claims. Rows
// 1-3 make a gate complain loudly about a change that is fine, which costs a
// cycle. Row 4 makes it stay quiet about a guard that is broken, and nothing
// downstream ever revisits a passed arm.
//
// ## What this measures, in its own terms before the terms anyone wanted
//
// It answers exactly one question: *is the difference between this worktree and
// `HEAD` still, byte for byte, the difference this arm recorded when it made
// its mutation?*
//
// That is a question about the worktree, not about the guard under test and not
// about any other process. It does **not** detect another gate, it does not
// know one exists, and it cannot tell a concurrent gate's edit from a stray
// editor save or a half-finished manual experiment. It reports residue; it does
// not attribute it. Attribution is not needed, because the disposition is the
// same either way: a reading taken over a difference the arm did not create is
// not a reading of that arm.
//
// It is also blind, by construction, to anything already present when the
// snapshot was taken. A neighbour that arrived *before* the mutation is carried
// as baseline. That is deliberate -- a gate's own scratch files are legitimately
// present and must not void its own arms -- and it is why this is a per-arm
// check and not a start-of-run cleanliness check. The start-of-run check is the
// one that misses row 4 entirely, because row 4 needs only that the neighbour
// arrive *during* the arm, which is what happened in #1056: the reviewer watched
// the other gate's probe files appear mid-run.
//
// ## Decision 1 -- content hashes, not a path list
//
// Comparing the *set of paths* differing from `HEAD` is not enough, and it fails
// on exactly the input this is for. In #1056 both gates were mutating the same
// two files, so a path-level check sees "the file I declared is modified" and
// "nothing unexpected is present" and reports clean while reading someone
// else's edit. Every entry is therefore hashed, and a declared mutation whose
// content changed under it is `mutation-altered` -- the same-file collision,
// caught because the bytes are asserted rather than the filename.
//
// A declared mutation that stopped differing from `HEAD` is `mutation-reverted`:
// that is rows 1 and 4 seen from the measuring gate's side, and it is the single
// most important finding this reports.
//
// ## Decision 2 -- three exit codes, because void is not a verdict
//
//   0  the only difference from `HEAD` is the declared mutation, unchanged.
//      The arm's exit code is a real reading.
//   1  residue, or the declared mutation was reverted or overwritten. The arm
//      is VOID.
//   2  this guard could not answer. The arm is VOID for the same reason: a
//      check that did not run is not a check that passed.
//
// Exit 1 does **not** mean the arm failed, and a caller that folds it into a
// fail has reintroduced the defect from the other side. Void is a third outcome
// and must not collapse into either of the other two. Exit 2 is never a pass.
//
// ## Decision 3 -- no override, by construction rather than by enumeration
//
// There is no flag that suppresses a finding, and unrecognised arguments are
// refused wholesale rather than ignored. Refusing the whole class is the point:
// a list of blocked spellings is a list, and the next author invents a spelling
// that is not on it. Nothing here can be pointed at a narrower tree either --
// the paths come from `git`, not from the caller.
//
// What this cannot stop is a gate that lies about what it mutated, and it does
// not pretend to: a gate declaring a path it did not touch is not using an
// override this repository handed it. The snapshot does refuse a declared path
// that is identical to `HEAD`, which catches the honest version of that mistake
// -- snapshotting before mutating rather than after.
//
// ## Decision 4 -- the guard's own artefact is excluded from what it measures
//
// A snapshot file written inside the worktree would appear between snapshot and
// verify and void every arm it was supposed to protect. Its own path is
// therefore recorded and excluded on both sides. Writing it outside the
// worktree entirely is still the better habit, and then nothing is excluded.
//
// ## Decision 5 -- fail-closed, with controls that land on the failing path
//
// A check that can only ever report "nothing wrong" is precisely the failure
// #1056 is about, so this one proves its detectors fire before it reads any
// file. `selfCheck` runs the comparison over synthetic states in both
// directions -- an identical pair that must yield no finding, and one planted
// discrepancy per finding kind that must yield exactly that kind at exactly
// that path -- and the clean arm and the planted arm are asserted to come back
// *differing*. A control that only ever exercises the healthy path cannot
// detect a comparison that is blind on the failing one.
//
// It runs on every invocation, including `snapshot` and `verify`, so a gate
// cannot take a reading from a guard whose detectors have not just fired.
//
// Node built-ins only -- `skills-ci` installs nothing.
//
// Usage:
//
//     node .github/scripts/gate-arm-guard.mjs snapshot --out <file> [--mutated <path>]...
//     node .github/scripts/gate-arm-guard.mjs verify --baseline <file>
//     node .github/scripts/gate-arm-guard.mjs self-test
//
// `--mutated` is repeatable and may be omitted: an arm that mutates nothing is
// a clean arm, and it is verified the same way. The clean arm is where the
// second loud ordering lands, so it is not exempt.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, relative, sep } from "node:path";

const EXIT_VALID = 0;
const EXIT_VOID = 1;
const EXIT_UNANSWERABLE = 2;

const SNAPSHOT_VERSION = 1;
const ABSENT = "absent";
const UNREADABLE = "unreadable";

/** Every finding kind, with what it means for the arm. */
const KINDS = {
  "mutation-reverted":
    "the mutation this arm declared no longer differs from HEAD -- something restored the file "
    + "under you. This is interleaving 1 or 4: if this arm's check exited non-zero, it did so for "
    + "a reason this arm did not create.",
  "mutation-altered":
    "the mutation this arm declared is still present but its bytes changed -- something else "
    + "edited the same file. A path-level check would have called this clean.",
  appeared:
    "a difference from HEAD that was not here when this arm was snapshotted. The arm is being "
    + "measured over a tree it did not create.",
  vanished:
    "a difference from HEAD that was here when this arm was snapshotted has gone -- something "
    + "restored a file this arm did not declare.",
  changed:
    "a difference from HEAD that was here when this arm was snapshotted has different bytes now.",
  "head-moved":
    "HEAD is not the commit this arm was snapshotted against, so the two readings are not "
    + "comparable at all.",
};

/**
 * The comparison, as a pure function of two recorded states, so it can be
 * exercised in both directions without a repository. Returns findings in a
 * stable order: the declared mutation first, because it is the row-4 signal.
 */
function compare(baseline, current) {
  const findings = [];

  if (baseline.head !== current.head) {
    findings.push({
      kind: "head-moved",
      path: null,
      detail: `snapshotted against ${baseline.head}, now ${current.head}`,
    });
  }

  for (const [path, hash] of Object.entries(baseline.mutated)) {
    const now = current.entries[path];
    if (now === undefined) {
      findings.push({ kind: "mutation-reverted", path, detail: `recorded ${hash}` });
    } else if (now !== hash) {
      findings.push({ kind: "mutation-altered", path, detail: `recorded ${hash}, now ${now}` });
    }
  }

  const declared = new Set(Object.keys(baseline.mutated));

  for (const [path, hash] of Object.entries(baseline.carry)) {
    const now = current.entries[path];
    if (now === undefined) {
      findings.push({ kind: "vanished", path, detail: `recorded ${hash}` });
    } else if (now !== hash) {
      findings.push({ kind: "changed", path, detail: `recorded ${hash}, now ${now}` });
    }
  }

  for (const [path, hash] of Object.entries(current.entries)) {
    if (declared.has(path)) continue;
    if (Object.prototype.hasOwnProperty.call(baseline.carry, path)) continue;
    findings.push({ kind: "appeared", path, detail: `now ${hash}` });
  }

  return findings;
}

/** Exits 2 with a reason. Every unanswerable path funnels through here. */
function unanswerable(why) {
  console.error(`gate-arm-guard: ${why}`);
  console.error(
    "This guard could not answer, so the arm is VOID: do not score it as a pass and do not score "
      + "it as a fail. Exit 2 is never a pass.",
  );
  process.exit(EXIT_UNANSWERABLE);
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    unanswerable(`\`git ${args.join(" ")}\` failed: ${error.message.split("\n")[0]}`);
    return "";
  }
}

const nulList = (text) => text.split("\0").filter((entry) => entry.length > 0);

/**
 * Reads the worktree's difference from HEAD as `{ head, entries }`, where every
 * entry is a content hash. Tracked differences come from `git diff HEAD` with
 * rename detection off, so a rename reports both of its paths rather than being
 * summarised into one; untracked ones come from `ls-files --others`, which
 * honours `.gitignore`, so build output and the gitignored dock state are not
 * mistaken for residue.
 */
function readState(root, excluded) {
  const head = git(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    unanswerable(`\`git rev-parse HEAD\` did not return a commit: ${JSON.stringify(head)}`);
  }

  const tracked = nulList(git(["diff", "--name-only", "--no-renames", "-z", "HEAD"]));
  const untracked = nulList(git(["ls-files", "--others", "--exclude-standard", "-z"]));

  const entries = {};
  for (const path of [...tracked, ...untracked].sort()) {
    if (excluded && excluded === path) continue;
    entries[path] = hashWorktreeFile(resolve(root, path));
  }

  return { head, entries };
}

function hashWorktreeFile(absolutePath) {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(absolutePath)).digest("hex")}`;
  } catch (error) {
    if (error.code === "ENOENT") return ABSENT;
    if (error.code === "EISDIR") return `${UNREADABLE}:directory`;
    return `${UNREADABLE}:${error.code ?? "error"}`;
  }
}

/**
 * Repo-relative POSIX form, or null when the path is outside the worktree.
 * Used both for `--mutated` and for the snapshot's own file.
 */
function repoRelative(root, candidate) {
  const rel = relative(root, resolve(candidate));
  if (rel === "" || rel.startsWith("..") || resolve(candidate) === resolve(root)) return null;
  return rel.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Self-check. Runs before anything real, on every invocation.
// ---------------------------------------------------------------------------

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function selfCheck(report) {
  const failures = [];
  const note = (name, ok, why) => {
    if (report) console.log(`  ${ok ? "fired" : "DID NOT FIRE"}  ${name}`);
    if (!ok) failures.push(`${name}: ${why}`);
  };

  const baseline = {
    head: HEAD_A,
    mutated: { "a/declared.md": "sha256:11" },
    carry: { "b/carried.txt": "sha256:22" },
  };
  const cleanCurrent = {
    head: HEAD_A,
    entries: { "a/declared.md": "sha256:11", "b/carried.txt": "sha256:22" },
  };

  // The clean arm. A comparison that reports on this is blind in the direction
  // that costs a cycle, and it is the control the planted arms are read against.
  const clean = compare(baseline, cleanCurrent);
  note(
    "clean arm scores normally (no finding)",
    clean.length === 0,
    `expected no finding, got ${JSON.stringify(clean)}`,
  );

  // A nonce path, invented now so it cannot be written into any fixture, must
  // not be reported by a comparison that saw nothing about it.
  const nonce = `zz-absent-${randomUUID()}.txt`;
  note(
    "a path in neither state is not reported",
    !clean.some((finding) => finding.path === nonce),
    "the comparison named a path it was never shown",
  );

  // One planted discrepancy per kind. Each must yield exactly that kind at
  // exactly that path -- a detector that fires on everything, or that fires
  // with the wrong path, is not a detector.
  const planted = [
    [
      "a foreign file appearing mid-arm voids it",
      { head: HEAD_A, entries: { ...cleanCurrent.entries, [nonce]: "sha256:99" } },
      "appeared",
      nonce,
    ],
    [
      "the declared mutation being restored voids it (rows 1 and 4)",
      { head: HEAD_A, entries: { "b/carried.txt": "sha256:22" } },
      "mutation-reverted",
      "a/declared.md",
    ],
    [
      "the declared mutation being overwritten in place voids it (same-file collision)",
      { head: HEAD_A, entries: { ...cleanCurrent.entries, "a/declared.md": "sha256:ff" } },
      "mutation-altered",
      "a/declared.md",
    ],
    [
      "a carried difference vanishing voids it",
      { head: HEAD_A, entries: { "a/declared.md": "sha256:11" } },
      "vanished",
      "b/carried.txt",
    ],
    [
      "a carried difference changing voids it",
      { head: HEAD_A, entries: { ...cleanCurrent.entries, "b/carried.txt": "sha256:ee" } },
      "changed",
      "b/carried.txt",
    ],
    [
      "HEAD moving under the arm voids it",
      { head: HEAD_B, entries: { ...cleanCurrent.entries } },
      "head-moved",
      null,
    ],
  ];

  for (const [name, current, kind, path] of planted) {
    const found = compare(baseline, current);
    const ok = found.length === 1 && found[0].kind === kind && found[0].path === path;
    note(name, ok, `expected one ${kind} at ${path}, got ${JSON.stringify(found)}`);

    // The two-sided requirement: the planted arm and the clean arm must come
    // back DIFFERING. Two arms that agree have measured nothing, however
    // confident either looks on its own.
    note(
      `  ...and differs from the clean arm`,
      found.length !== clean.length,
      "the planted arm and the clean arm agree, so the comparison discriminates nothing",
    );
  }

  // Every kind this reports must carry an explanation, or a voided arm arrives
  // as a bare token the next reader has to guess at.
  for (const kind of Object.keys(KINDS)) {
    note(`  ...${kind} is explained to the reader`, typeof KINDS[kind] === "string" && KINDS[kind].length > 0, "no explanation");
  }

  if (failures.length > 0) {
    console.error("gate-arm-guard: self-check failed --");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "The comparison cannot be trusted to report on a real worktree, so it must not be used to "
        + "validate an arm. Exit 2 is never a pass.",
    );
    process.exit(EXIT_UNANSWERABLE);
  }
}

// ---------------------------------------------------------------------------
// Argument handling. Unrecognised input is refused, never ignored.
// ---------------------------------------------------------------------------

function parseArgs(argv, spec) {
  const values = { mutated: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!spec.has(flag)) {
      unanswerable(
        `unrecognised argument \`${flag}\`. This guard has no flag that suppresses a finding and `
          + "no override; the accepted arguments here are "
          + `${[...spec].join(", ")}.`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || spec.has(value)) {
      unanswerable(`\`${flag}\` needs a value`);
    }
    index += 1;
    if (flag === "--mutated") values.mutated.push(value);
    else values[flag.replace(/^--/, "")] = value;
  }

  return values;
}

// ---------------------------------------------------------------------------
// Subcommands.
// ---------------------------------------------------------------------------

function commandSnapshot(argv) {
  const args = parseArgs(argv, new Set(["--out", "--mutated"]));
  if (!args.out) unanswerable("`snapshot` needs `--out <file>` to write the baseline to");

  const root = git(["rev-parse", "--show-toplevel"]).trim();
  if (root.length === 0) unanswerable("could not resolve the worktree root");

  const selfPath = repoRelative(root, args.out);
  const state = readState(root, selfPath);

  const mutated = {};
  for (const declared of args.mutated) {
    const path = repoRelative(root, declared) ?? declared.split(sep).join("/");
    if (!Object.prototype.hasOwnProperty.call(state.entries, path)) {
      unanswerable(
        `you declared a mutation to \`${path}\`, but it does not differ from HEAD. Snapshot `
          + "*after* making the arm's mutation, not before -- a baseline taken before the mutation "
          + "records the mutation itself as residue and voids the arm you are about to read.",
      );
    }
    mutated[path] = state.entries[path];
  }

  const carry = {};
  for (const [path, hash] of Object.entries(state.entries)) {
    if (!Object.prototype.hasOwnProperty.call(mutated, path)) carry[path] = hash;
  }

  const snapshot = {
    version: SNAPSHOT_VERSION,
    head: state.head,
    selfPath,
    mutated,
    carry,
    capturedAt: new Date().toISOString(),
  };

  try {
    writeFileSync(resolve(args.out), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch (error) {
    unanswerable(`could not write the baseline to ${args.out}: ${error.message}`);
  }

  const declaredCount = Object.keys(mutated).length;
  console.log(
    `gate-arm-guard: snapshot at HEAD ${state.head} -- `
      + `${declaredCount} declared mutation(s)${declaredCount === 0 ? " (clean arm)" : ""}, `
      + `${Object.keys(carry).length} carried difference(s).`,
  );
  for (const path of Object.keys(mutated)) console.log(`  declared  ${path}`);
  for (const path of Object.keys(carry)) console.log(`  carried   ${path}`);
  console.log(
    "Verify this immediately before you read the arm's exit code, not at the end of the run.",
  );

  return EXIT_VALID;
}

function commandVerify(argv) {
  const args = parseArgs(argv, new Set(["--baseline"]));
  if (!args.baseline) unanswerable("`verify` needs `--baseline <file>`, the snapshot this arm recorded");

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(resolve(args.baseline), "utf8"));
  } catch (error) {
    unanswerable(
      `could not read the baseline ${args.baseline}: ${error.message}. A baseline that could not `
        + "be read is not a baseline that recorded nothing.",
    );
  }

  if (snapshot?.version !== SNAPSHOT_VERSION) {
    unanswerable(`baseline version ${snapshot?.version} is not the ${SNAPSHOT_VERSION} this guard writes`);
  }
  if (typeof snapshot.head !== "string" || !snapshot.mutated || !snapshot.carry) {
    unanswerable("the baseline is missing fields this guard wrote, so it is not comparable");
  }

  const root = git(["rev-parse", "--show-toplevel"]).trim();
  if (root.length === 0) unanswerable("could not resolve the worktree root");

  const current = readState(root, snapshot.selfPath ?? null);
  const findings = compare(snapshot, current);

  const declaredCount = Object.keys(snapshot.mutated).length;
  const scope =
    `${declaredCount} declared mutation(s)${declaredCount === 0 ? " (clean arm)" : ""} and `
    + `${Object.keys(snapshot.carry).length} carried difference(s)`;

  if (findings.length === 0) {
    console.log(
      `gate-arm-guard: VALID -- the difference between this worktree and HEAD ${current.head} is `
        + `still exactly what this arm recorded (${scope}). The arm's exit code is a real reading; `
        + "score it.",
    );
    return EXIT_VALID;
  }

  console.error(
    `gate-arm-guard: VOID -- ${findings.length} discrepancy(ies) against the baseline `
      + `(${scope}). This arm was measured over a difference it did not create.`,
  );
  for (const finding of findings) {
    console.error(`  ${finding.kind}  ${finding.path ?? "(HEAD)"}`);
    console.error(`      ${finding.detail}`);
    console.error(`      ${KINDS[finding.kind]}`);
  }
  console.error("");
  console.error(
    "Do NOT score this arm. It is not a pass and it is not a fail -- \"I could not measure\" is a "
      + "third outcome, and folding it into either of the other two is the defect this guard "
      + "exists to prevent. Report the paths above, restore a clean tree, and re-measure. There is "
      + "no flag that makes this reading usable.",
  );

  return EXIT_VOID;
}

function commandSelfTest(argv) {
  if (argv.length > 0) {
    unanswerable(`\`self-test\` takes no arguments. Unrecognised: ${argv.join(" ")}`);
  }

  console.log("gate-arm-guard: self-test -- every detector, on a planted discrepancy and a control.");
  selfCheck(true);
  console.log(
    "gate-arm-guard: OK -- the clean arm yielded no finding, every planted discrepancy yielded "
      + "exactly its own kind at its own path, and each planted arm came back differing from the "
      + "clean arm. A check nobody has seen fire is not a check; this one has just fired.",
  );

  return EXIT_VALID;
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  snapshot: commandSnapshot,
  verify: commandVerify,
  "self-test": commandSelfTest,
};

const [command, ...rest] = process.argv.slice(2);

if (!command || !Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
  unanswerable(
    `expected one of ${Object.keys(COMMANDS).join(", ")}, got ${command ? `\`${command}\`` : "nothing"}. `
      + "Unrecognised input is refused rather than ignored, so there is no argument that turns this "
      + "guard off.",
  );
}

// Before anything real, in every mode: a comparison whose detectors have not
// just fired must not be used to validate an arm.
if (command !== "self-test") selfCheck(false);

process.exit(COMMANDS[command](rest));
