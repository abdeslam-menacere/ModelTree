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

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Per test. Justified above against runs A and C.
    testTimeout: 30_000,
    // Per hook, and the same number for the same reason: the `beforeEach` in
    // these suites renders the same jsdom trees the bodies do, so a budget that
    // is right for one is right for the other. No hook timeout was observed in
    // any run above -- this is the other half of one decision rather than a fix
    // for a failure, and leaving it at its own unchosen 10 s default would
    // reproduce this issue one layer down the first time a hook does what run C
    // measured a body doing.
    hookTimeout: 30_000,
  },
});
