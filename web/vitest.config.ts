// The vitest configuration for `web/`, and the answer to issue #720.
//
// -- Why this file exists --
//
// Until it did, `web/` had no vitest configuration of any kind: no
// `vitest.config.*`, no `vitest` key in `package.json`, and no test block in
// `astro.config.mjs` (which vitest does not read in any case). Every value the
// suite ran under was therefore vitest's shipped default, and the load-bearing
// word is *shipped* rather than *chosen* -- there was no file in which a
// timeout could have been read, so nobody had ever decided one.
//
// That distinction is the whole of why this file is allowed to exist. This
// repository refuses a threshold raised until a failing thing passes. Setting a
// value that was never set is a decision, not a weakened one. The numbers below
// are therefore derived from a measured distribution of how long these tests
// actually take, and the measurement is recorded here rather than in a commit
// message, because the next person to doubt a number needs it next to the
// number.
//
// -- What was measured --
//
// The full suite (114 files, 2540 tests) run four ways on one 8-core Windows
// machine, warm cache every time, with vitest's JSON reporter supplying
// per-test durations. "Default-governed" means the 2425 tests that take the
// global budget; it excludes the 115 in the six files that already declare
// their own. "Loaded" means eight spinning CPU hogs against eight cores, which
// is the ordinary state of a machine running several dock agents at once.
//
//   run                 load    budget   wall     default-governed outcome
//   ------------------  ------  -------  -------  ---------------------------
//   A  idle             none    5 s      82.7 s   green; slowest test 4767 ms
//   B  loaded           8 hogs  5 s      292.1 s  14 failures, every one
//                                                 "Test timed out in 5000ms",
//                                                 zero assertion failures
//   C  loaded           8 hogs  120 s    412.7 s  green; slowest test 11753 ms,
//                                                 19 tests over 5 s
//   D  loaded, pool     8 hogs  5 s      718.8 s  1 failure, still at 5000 ms
//      capped to 2
//
// -- Why 30 seconds --
//
// Run A says the heaviest test taking this budget needs 4767 ms on an idle
// machine. Against 5000 ms that is 4.9% headroom, which is not a budget so much
// as a coin toss, and run B is what the toss looks like when it loses.
//
// Run C is the number that actually sets this one, because it is run B with the
// budget lifted out of the way and the durations therefore uncensored. A test
// killed at 5000 ms tells you nothing about how long it wanted, and sizing a
// budget from censored data is exactly how one arrives at a number that merely
// clears today's failures. Uncensored, the slowest default-governed test takes
// 11753 ms under ordinary multi-agent load -- about 2.4x the default it was
// being given. That is the floor.
//
// 30 s is 2.55x that measured worst case, and 6.3x the idle worst case. The
// margin is there because eight hogs on eight cores is one point on a curve and
// a CI runner's cores are slower than this machine's -- not because a rounder,
// larger number felt safer. Had run C come back with a tail at 2 s, this method
// would have said the 5000 ms default was fine and the fault lay elsewhere.
//
// The ceiling matters as much as the floor: a budget big enough to hide a
// genuine hang has thrown away the only thing a timeout is for. 30 s keeps a
// hung test visible within 30 s of an 83 s suite, and stays an order of
// magnitude below the budgets this repository has already chosen deliberately
// where a test really does need one -- 120 s in `ci-preflight.test.ts`, 180 s in
// `run-check.test.ts` and `run-tests.test.ts`, 300 s in `asset-budgets.test.ts`
// and `base-path.test.ts`. Those files keep their own numbers: a per-test
// budget still overrides this one, which is the point of having both.
//
// -- Is this file actually doing anything? --
//
// Runs A-D were driven by a harness that spawned vitest directly and set each
// budget on the CLI: `--testTimeout=120000` for run C, a pool option for run D.
// Runs A and B sat at 5000 ms because when they ran this file did not yet exist
// and vitest fell back to its shipped default. That table is therefore evidence
// about *values* and none at all about *this file*: an inert config that vitest
// never reads produces the same four rows. The first review of this change made
// exactly that objection, and it was right to.
//
// So the file is checked directly, through the command the repository actually
// runs. `npm run test` calls `scripts/run-tests.mjs`, whose FULL_RUN_ARGS are
// frozen at `run --reporter=default --reporter=json
// --outputFile=.vitest/report.json` -- no `--config`, no timeout flag. This file
// is the only surface in that process that can set a timeout, so any change in
// behaviour is attributable to it and to nothing else.
//
//   control  this file said                   result of `npm run test`
//   -------  -------------------------------  ------------------------------
//   R1       testTimeout 1, hookTimeout 30 s  RED, exit 1. 975 x "Test timed
//                                             out in 1ms", 0 hook timeouts.
//                                             110 of 114 files fail.
//   R2       testTimeout 30 s, hookTimeout 1  RED, exit 1. 40 x "Hook timed
//                                             out in 1ms", 0 test timeouts.
//                                             24 of 114 files fail.
//   G1       30 s / 30 s, exactly as shipped  GREEN, exit 0. 114/114 files,
//                                             2540/2540 tests, no timeouts.
//
// The controls are crossed deliberately: each key moves its own signature and
// only its own, and the absurd value comes back verbatim in the failure text. A
// file that cannot make this suite fail when it says 1 ms is a file nothing is
// reading, so the red runs are what let the green one mean anything.
//
// (Four files survive R1. Three of them -- `asset-budgets`, `base-path`,
// `ci-preflight` -- carry their own budgets, which override this one. The
// fourth, `pages-deploy.test.ts`, contains no `await` at all, so its 13 tests
// are synchronous and no timeout can fire on them.)
//
// -- The shipped value, run repeatedly --
//
// One green run does not establish stability for a change whose whole purpose is
// stability, and this failure is intermittent by definition. So the shipped
// configuration was run four more times under the same eight-hog load that
// produced run B's 14 failures:
//
//   run  wall     files    tests      timeouts  worst default-governed test
//   ---  -------  -------  ---------  --------  ---------------------------
//   L1   312.1 s  114/114  2540/2540  none      8441 ms (28.1% of budget)
//   L2   272.7 s  114/114  2540/2540  none      9156 ms (30.5%)
//   L3   273.5 s  114/114  2540/2540  none      8526 ms (28.4%)
//   L4   347.6 s  114/114  2540/2540  none      7508 ms (25.0%)
//
// N = 4, all green, none discarded and none re-rolled. Wall clock stays in run
// B's range (292 s), so the value is not buying green by making the suite
// slower: it is the same work, no longer being killed part way through.
//
// The load-bearing observation is not that these passed. It is that 15 to 18
// default-governed tests per run exceeded 5000 ms -- 18 distinct tests in all,
// every one a test the inherited default would have killed. By number of
// over-5 s observations across the four runs:
//
//   32  src/components/LineageModelDrawer.interaction.test.tsx   peak 7608 ms
//   19  scripts/verify-test-coverage.test.ts                     peak 9156 ms
//   16  src/components/ModelTreeExplorer.interaction.test.tsx    peak 8162 ms
//
// The first is the exact test issues #517 and #744 orbit, reported timing out at
// 5000 ms and once seen at 5224 ms; eight of its tests ran over 5 s in all four
// runs here. That is the failure this value prevents, observed rather than
// inferred from run C's single sample.
//
// The worst test observed at the shipped value used 30.5% of it. The worst
// across every measurement here is still run C's 11753 ms, or 39% of 30 s. The
// margin is real, and it is not enormous.
//
// -- Corroboration from CI, on hardware none of the above used --
//
// Every measurement above was taken on one 8-core Windows workstation under
// synthetic load, which is a stand-in for a shared machine rather than a
// measurement of CI. That gap has since been closed from the other side:
// `ModelTreeExplorer.interaction.test.tsx` failed Web CI on `main` at 5073 ms
// against the inherited default -- a 1.5% overshoot -- and then passed on a
// re-run of the identical SHA.
//
// Two things follow, and it is worth keeping them apart.
//
// It confirms the shape of the problem. A failure that reverses on a re-run of
// the same commit is not a defect in the test, because nothing about the test
// changed between the two runs; and this is the second file to do it, after the
// `LineageModelDrawer` of #517. So the inherited 5000 ms is tight against a
// *class* of interaction tests rather than against one slow outlier, which is
// what this file's existence turns on. The same file shows 16 over-5 s
// observations in the loaded runs above, peaking at 8162 ms, so the two
// platforms agree about which tests sit near the line.
//
// It does not size the budget, and must not be read as doing so. A 5073 ms
// observation justifies "more than 5000 ms" and nothing beyond it; sizing from
// it would produce about 6 s, and would be the precise error this file refuses
// elsewhere -- fitting a number to the failures that happen to have been seen.
// The 30 s above comes from the uncensored distribution in run C and the four
// loaded runs, and it would stand unchanged had this CI failure never occurred.
//
// -- And once without any synthetic load at all --
//
// The runs above lean on eight spinning hogs, which is a stand-in for a busy
// shared machine rather than a measurement of one. So the plainest single
// observation here is one that used no load model whatever: during an ordinary
// `node .github/scripts/ci-preflight.mjs` on this branch, with nothing
// artificial running, `LineageModelDrawer.interaction.test.tsx`'s "opens a
// labelled modal dialog and moves focus into it when a release is selected"
// took 5023 ms and passed. The same test had taken 4675 ms in the equivalent
// run shortly before.
//
// Under the inherited default that run is red, by 23 ms, on a gate nobody was
// stress-testing. It is the same overshoot the CI failure above shows -- both
// about 1.5% past 5000 ms, on two different tests and two different machines --
// and it is the clearest statement of what was wrong: not that these tests are
// slow, but that the budget they were handed was never chosen, and sits close
// enough to their ordinary duration that ordinary variance crosses it.
//
// -- What issue #744 changed underneath this, and why the value stands --
//
// The over-5 s table above names three files, and #744 has since made two of
// them substantially cheaper without touching any budget. Both were paying a
// query cost that scaled with the dataset: `getByRole('button', { name })`
// computes an accessible name for every candidate in its container, and the
// explorer renders the whole catalog up front with collapsed branches carrying
// `hidden` rather than being unmounted, so each such lookup walked all 237
// buttons at today's 110 releases and grew with every tranche added. Those
// lookups now resolve through the id helpers in
// `tests/helpers/model-tree-queries.ts`.
//
// Measured on this machine, both files in one run, median of three, with no
// synthetic load: the sum of test durations went from 39679 ms to 15611 ms.
// The two peaks this file names moved from 3694 ms to 1372 ms
// (`LineageModelDrawer`) and from 4215 ms to 1330 ms (`ModelTreeExplorer`).
//
// That is deliberately not a re-run of runs A-D or L1-L4. It is unloaded, and
// it is two files rather than 114, so it updates no number in any table above
// and is not offered as doing so. What it changes is how the over-5 s list
// should be read: two of its three entries no longer belong near the top.
// `verify-test-coverage.test.ts` -- 19 observations, peak 9156 ms -- is
// untouched by #744, and run C's uncensored 11753 ms is what sizes 30 s in the
// first place. The budget therefore still rests on the evidence it was chosen
// on, with one fewer class of test pressing against it.
//
// The direction of travel is the point. #744 decoupled these two files from
// dataset size, so the creators queued in #820 no longer spend the headroom
// this file bought. A budget is a ceiling, not an allowance.
//
// -- Why the worker pool is not capped here --
//
// Issue #720 proposed a pool cap as the more honest lever, reasoning that a
// starved suite should be made to contend less rather than handed a longer
// clock. That was measured rather than assumed, and it did not hold. Run D caps
// the pool to 2 workers under the same load and still fails at 5000 ms, while
// taking 2.5x the wall clock of run B: it reduces the failure count without
// closing the failure, and charges every dock and the Pages deploy for the
// privilege.
//
// The reason is that the contention is mostly not vitest's own. A dock machine
// is shared with sibling agents vitest cannot see, so capping its pool only
// shrinks its share of a machine it does not control. On CI the lever is inert
// anyway: `ubuntu-latest` gives this public repository 4 vCPUs, vitest's default
// pool size is `availableParallelism - 1` = 3, so any cap high enough to be safe
// on an 8-core workstation is above 3 and changes nothing on the runner whose
// red `validate` stopped a Pages deploy.
//
// -- What this deliberately does not fix --
//
// Under heavy load a fork worker can fail to start at all, dropping a whole file
// while the reporter still prints a plausible count: run D lost
// `LineageModelDrawer.interaction.test.tsx` and reported 113 of 114. That budget
// is `WORKER_START_TIMEOUT`, a hard-coded 90 s constant inside vitest with no
// configuration surface, so no value in this file reaches it. It is precisely
// what `scripts/verify-test-coverage.mjs` exists to catch, and it still does.

import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

// -- The fork-pool bound, and the answer to the concurrency half of #786 --
//
// #720 (above) set the timeouts and deliberately left the concurrency knobs at
// their defaults, having measured one of them -- a pool capped to 2 workers,
// run D -- and found it did not help the 5000 ms interaction-test timeouts it
// was aimed at. That measurement stands, and this block does not reopen it: it
// is aimed at a different failure, with a different mechanism, that #720 did not
// address and explicitly listed under "what this deliberately does not fix".
//
// -- The failure this is for --
//
// A handful of test files do not merely compute in jsdom; they spawn *real
// operating-system subprocesses* and wait on them. `scripts/run-check.test.ts`
// is the worst: before this issue its "runs `--root .` and `--root=.` for real"
// case fired the two real `astro check` passes at once via `Promise.all` (a
// third, cheap, `runScript` refuses before spawning astro), each pass being a
// full astro/vite/tsc run. It now serialises those two passes (see that file);
// this bound addresses the cross-file amplification that remains.
// `tests/workflows/ci-preflight.test.ts`, `tests/build/asset-budgets.test.ts`,
// `scripts/run-tests.test.ts` and `scripts/asset-drift.test.ts` do the same kind
// of thing. These carry their own large per-test budgets (120 s, 180 s, 300 s)
// precisely because a single one of them is heavy.
//
// vitest's forks pool defaults to `availableParallelism() - 1` workers, so on
// an 8-core box it runs 7 test files at once. When several of those 7 slots hold
// heavy files simultaneously, the machine is asked to run many real astro
// subprocesses at the same instant -- on top of whatever sibling dock agents are
// already running, which vitest cannot see. The heavy tests then miss even their
// large budgets. This is not the timeout being too small; it is the process
// count being too high.
//
// -- What was measured, on this machine, 8 cores --
//
// The 'runs `--root .` ... for real' test body, wall clock, on an unchanged
// tree. The reproduction was done against the ORIGINAL code (three astro passes
// via `Promise.all`, default unbounded pool); the after-fix rows are with this
// bound and the two passes serialised:
//
//   condition                                              this test's body
//   -----------------------------------------------------  ----------------
//   BEFORE: standalone (this file only), quiet-ish box      ~106 s
//   BEFORE: full suite, ordinary sibling-dock load          130-168 s, once 180+
//   BEFORE: full suite, 8 extra non-yielding CPU hogs       180+ s  RED (timeout)
//   AFTER:  standalone (this file only)                     ~53 s
//   AFTER:  full suite, light sibling-dock load             53056 ms  green
//   AFTER:  full suite, heavy sibling-dock load             94612 ms  green
//
// Two distinct red signatures were reproduced against the original code, both
// from contention rather than any code change (a different file,
// `ModelCatalog.interaction.test.tsx`, failed alongside in one run -- #786's
// varying-subset signature):
//
//   * "Test timed out in 180000ms" -- the slowness signature from the #786/#885
//     sandboxes, seen at 180166 ms under the default pool and heavy load.
//   * `astro check` exiting `code 1` -- a spawned astro process dying under CPU
//     starvation, the resource-exhaustion cousin of `Failed to start forks
//     worker`. (Note: a `code 1` can ALSO be a genuine type error, since
//     `astro check` type-checks this config file too; the reproduction was
//     confirmed against a config that type-checks clean.) No timeout value
//     addresses this signature; only reducing the concurrent process count does.
//
// After the fix, repeated full-suite runs under both light and heavy load stayed
// green with none of these signatures recurring and no varying failing subset.
//
// -- Why `maxWorkers`, what it fixes, and what it honestly does not --
//
// This is a bound, not a timeout, and the two are not interchangeable: raising a
// timeout hides contention, bounding the pool removes the share of it this suite
// creates itself. vitest's forks pool defaults to `availableParallelism() - 1`,
// so on this 8-core box it runs 7 test files at once; when several of those
// slots hold heavy files, the machine is asked to run many real astro
// subprocesses at the same instant. Capping the worker count cuts that
// self-inflicted storm and directly targets the fork-worker-startup / `Failed to
// start forks worker` admission signature, which is genuinely a vitest-side
// resource decision. In vitest 4 the knob is the top-level `maxWorkers` -- the
// `poolOptions.forks.maxForks`/`minForks` surface of vitest 2/3 no longer exists
// on `InlineConfig` and does not type-check, which `astro check` (it type-checks
// this config too) reports as `error ts(2769)` and exits 1 on.
//
// It is set to 3, which is `availableParallelism - 1` on the 4-vCPU
// `ubuntu-latest` runner this repository's public CI uses -- i.e. exactly what
// vitest would pick there by default. So on CI the bound is inert and changes
// nothing: CI already passes `web-ci` cleanly and this must not regress its wall
// time. The bound only bites on machines with more than 4 usable cores -- the
// shared dock workstations where the storm happens -- dropping 7 concurrent
// slots to 3 there. `Math.min` with `availableParallelism()` keeps it from ever
// exceeding what the machine actually has, and `Math.max(1, ...)` keeps at least
// one worker on a single-core box.
//
// What it does NOT do, measured rather than assumed: it does not defeat external
// contention. Under sibling agents (or synthetic hogs) that saturate the cores
// vitest cannot see, a single spawned `astro check` is starved regardless of how
// few vitest workers there are -- the target test still overran its budget under
// heavy external load. That residual is covered by the larger,
// separately-justified per-test budget in `scripts/run-check.test.ts` and by
// serialising that test's two astro passes, not by this bound. #763 reached the
// same conclusion from the other direction (its run D capped the pool and did not
// close the timeout failures), which is why capping alone was never going to be
// the whole answer and is not offered as one here.
const CI_RUNNER_PARALLELISM = 3;
const maxForks = Math.max(1, Math.min(availableParallelism(), CI_RUNNER_PARALLELISM));

export default defineConfig({
  test: {
    // The fork-pool bound. vitest 4 exposes this as the top-level `maxWorkers`
    // (there is no `poolOptions.forks.maxForks` here any more, and no
    // `minWorkers`); the pool itself already defaults to 'forks', so it is left
    // implicit. See the block above for why 3, and why it is inert on CI.
    maxWorkers: maxForks,
    // Per test. Sized above against runs A and C, shown to be live by control
    // R1, and exercised at this exact value in G1 and L1-L4.
    testTimeout: 30_000,
    // Per hook, and the same number for the same reason: the `beforeEach` in
    // these suites renders the same jsdom trees the bodies do, so a budget that
    // is right for one is right for the other. No hook timeout was observed in
    // any run above -- this is the other half of one decision rather than a fix
    // for a failure, and leaving it at its own unchosen 10 s default would
    // reproduce this issue one layer down the first time a hook does what run C
    // measured a body doing. Control R2 shows the key is live rather than
    // decorative: set to 1 ms it fails 24 files with 40 hook timeouts, so this
    // is an unexercised value but not an unread one.
    hookTimeout: 30_000,
  },
});
