# Performance and asset budgets

The performance contract for ModelTree, recorded for issue #33. It splits one
question everyone conflates — "is the site fast?" — into two that behave
completely differently under measurement, and treats each honestly:

- **Deterministic asset weight.** How many bytes each route makes a visitor
  download. Computed from the production build output; the same commit yields the
  same numbers on any machine. These **gate CI** and are merge-blocking.
- **Variable lab timing.** LCP, INP, and CLS. These depend on the CPU and network
  of the machine doing the measuring, and this box runs several agents at once.
  They are **measured and recorded here**, never gated.

The line between them is the whole point. A required check that can redden from
machine load alone blocks merges for reasons unrelated to the change under test.
This repository has already watched `astro preview` return a transient HTTP 404
on a route under CPU contention while the same route passed at another viewport
in the same run, and an isolation re-run went fully green. So a timing may never
sit on the merge path. Bytes can, because bytes are deterministic.

## What gates: deterministic byte budgets

Enforced by `web/tests/build/asset-budgets.test.ts`, which runs inside
`npm run test` and is therefore carried by the **required `web-ci`** status check
with no workflow change — the same route `tests/build/base-path.test.ts` takes.
The budgets themselves live in `web/asset-budgets.json`.

### Why this design cannot flake or be quietly bypassed

- **Reads files off disk, never console text.** The test spawns a production
  `astro build` into a temp directory and measures byte lengths with `fs`. It
  never regexes a build summary. That matters: a colouriser rewrites
  human-readable output between environments — vitest under `CI=true` injects
  ANSI escape codes *between* the words of its summary line, so a literal
  substring present locally is absent on CI (green locally, red on CI, looks
  exactly like flake). A file's byte length is the same number everywhere, so
  this entire class of environment-coupled failure cannot touch it.
- **Gates on RAW bytes only.** gzip and brotli are reported by
  `npm run assets:report` for realism but never gated, because a zlib or brotli
  version difference between machines would move a compressed number. Raw file
  size has no compressor in the loop, so for a given commit two machines building
  at the same time measure the identical byte count. The one build-time input that
  is not fixed by the commit is a `new Date()` build stamp rendered on two pages
  (`index.astro`, `compare.astro`); it is a fixed-width ISO date
  (`YYYY-MM-DD`, 10 bytes), identical on every machine building the same day, so
  it never moves a measured length and cannot manufacture a machine-to-machine
  disagreement — the property the gate depends on. "Reproducible byte-for-byte
  forever" is not claimed and is not needed; machine-independence at a point in
  time is.
- **`NODE_ENV=production` is forced on the child build, and pinned by an
  assertion.** Vitest sets `NODE_ENV=test`, and Astro copies `process.env` onto
  the build it spawns. Left alone, Vite would build React in development mode —
  roughly 250 kB of extra unminified JS that never ships (measured: 670,510 raw
  JS bytes vs the real 435,805) — and the test would measure a bundle no visitor
  downloads. The child build is forced to production. Because a forced value that
  lives only in a comment is one refactor from gone, a dedicated assertion fails
  the suite if any shipped `_astro/*.js` contains a React development-only
  internal (`disabledLog`, `captureOwnerStack` — verified present in a dev build
  and absent from every production chunk on 2026-08-30). The global
  `jsTotalMaxRaw` budget is the marker-independent backstop: the dev build's
  670,510 bytes exceed the 520,000 ceiling regardless of any React rename.
- **`BASE_PATH` and `SITE_URL` are pinned to the deploy's values, not
  inherited.** `web-ci.yml` sets `BASE_PATH=/ModelTree/` and
  `SITE_URL=https://abdeslam-menacere.github.io` at **job level**, and
  `astro.config.mjs` resolves `base: env.BASE_PATH ?? '/'`. So the child build
  the test spawns would inherit `/ModelTree/` under CI but build at `/` on a
  contributor's machine, where those variables are unset — base prefixes every
  root-relative href and asset URL, so the *same commit* would measure ~10 bytes
  less per internal URL locally than the build CI enforces against. That is the
  ANSI class again through a different door: ambient environment instead of
  colourised output, green locally and red on CI. The test therefore pins both
  variables explicitly on the child build (overriding whatever is ambient), so
  the measured number means "what ships" wherever it runs. `SITE_URL` is
  length-neutral here — its `astro.config` fallback already equals the deploy
  value — but is pinned anyway so the equality is by construction, not
  coincidence. `BASE_URL` is *dropped* rather than left unset, because vitest
  injects `BASE_URL=/` and Astro copies it onto `import.meta.env` where it would
  win over `base` and silently un-prefix every link.
- **No override, skip, or force.** There is no `--skip-gates` and no bypass flag,
  by design. An intentional exception is an explicit, reviewable entry in
  `asset-budgets.json` with a stated reason — never a flag that disables the
  check.
- **Non-vacuous at both scopes it measures.** A byte budget that quietly measures
  nothing is worse than none, because it manufactures confidence — so each scope
  that could collapse to zero carries an explicit floor. At the **route** scope,
  the suite asserts island JS accounting actually finds hydrated islands (at least
  one route ships non-zero JS), so a JS-inclusive route budget cannot pass
  trivially. At the **whole-build** scope, `globalTotals` classifies `_astro`
  files by filename suffix (`.js`/`.css`/`.woff2`) and the four global ceilings are
  one-sided `<=` checks; a suffix/format drift that matched nothing — a bundler
  emitting `.mjs`, a new font container — would zero that kind and pass its ceiling
  for free. So each per-kind global total (JS, CSS, fonts) additionally asserts
  it is non-zero. The `_astro` directory total needs no such floor: it sums every
  file regardless of suffix and is separately asserted non-empty, making it the
  classifier-independent backstop under the per-kind signals.

### Why enforcement lives in a vitest test, not a workflow step

The plan for this issue first proposed a dedicated CI **workflow step** that
measured the artifact the deploy already produces, rather than spawning a build
of its own. That was considered and **deliberately not taken**, and the deviation
is recorded here rather than left implicit. A workflow step speaks only at CI; a
vitest test runs inside `npm run validate`, so a contributor — or a dock — catches
a budget breach **locally, before CI**. On a night dominated by defects that were
structurally invisible to local runs, moving enforcement earlier was judged worth
its price. That price is concrete: one extra production `astro build` inside
`npm run test`. Measured on this contended machine on 2026-08-30: a standalone
production build is 6.2 s; the budget test file in isolation is 31.5 s (that build
plus vitest startup plus 20 assertions); at full-suite level, back-to-back
`npm run test` was 147 s with the test present and 85 s without — a 62 s delta,
inflated well beyond the isolated 31.5 s by CPU contention and by the concurrent-
build interaction described next.

### Windows build-concurrency: the shared build lock (adopted from #34)

Two `astro build` processes running concurrently crash libuv on Windows
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), aborting the build
with no test-level error. Vitest runs test files in parallel workers, and this
test and `tests/build/base-path.test.ts` each spawn a build at module load, so
once both exist they can race. It is Windows-only, so **invisible on the Linux CI
runner and only biting a local `npm run validate`** — the inverse of the ANSI
class above. Issue #34 introduced `web/tests/build/exclusive-build.ts`, a
`buildSiteExclusively(outDir, env)` helper that serialises builds behind a
cross-process `mkdir` lock. Now that #34 has landed, **this test uses that one
shared helper** rather than spawning its build inline; it deliberately does not
add a second lock, because two independent locks are each correct alone yet do
not exclude each other. The helper passes `env` through verbatim, so this test's
`NODE_ENV=production`, `BASE_PATH` and `SITE_URL` pins reach the child build
unchanged — and this test passes the deploy's *real* base path, not the fake
`/base-path-probe/` that `base-path.test.ts` uses for its own correctness checks.
Sharing the lock is not sharing the environment.


A route's **critical-path total** sums only the resources the browser fetches to
render and hydrate *that route*: its HTML, the JS import graph of its
`<astro-island>` components, any `<script src>`, its linked stylesheets, the
fonts it uses, and the **hashed** content `<img>` it references. Three deliberate
exclusions:

- **Fonts are accounted globally, not per route.** The six `woff2` files are
  shared across the site, cached after first load, and lazily fetched; charging
  every one to every route would triple-count shared weight. They have their own
  global ceiling instead.
- **`public/` content images are not charged to a route.** The accounting counts
  only `<img>` whose `src` resolves into the content-hashed `_astro/` output; an
  image served verbatim from `public/` (home and catalog each reference two) is
  skipped, because these are unhashed, long-lived, cacheable static assets rather
  than per-build render weight, and are not subject to the hashed-asset budgets
  the rest of the model tracks. This is a real exclusion, called out here so it is
  not silent: it lives in `asset-budget.mjs` where `astroFileSizes` returns null
  for a non-`_astro` path. Today those images are small SVG/PNG brand marks; if a
  route began shipping heavy `public/` imagery this exclusion would need
  revisiting, which is a follow-up, not decided here.
- **An `og:image` asset is never charged to a route.** Issue #34 added a single
  static Open Graph card, referenced only by an `og:image` `<meta>` tag. Social
  scrapers fetch it; a visitor on a route never does. Because the model sums only
  render/hydration resources, a `<meta>` asset is excluded *by construction* —
  and the test proves it by pointing an `og:image` meta at the largest real JS
  chunk and asserting the analyser still counts zero JS for that page. This is
  the distinction issue #34 asked to preserve. Note the scope of the exclusion:
  it covers #34's **asset**, never #34's **markup**. The canonical link, robots
  directive, Open Graph/Twitter tags and inline JSON-LD are bytes every visitor
  downloads on every page, so they stay fully inside the route budgets — they are
  a cause of the re-baseline below, not an exclusion from it.

Separately, `catalog-index.json` (a generated endpoint referenced by no route's
HTML) is kept out of route totals via `excludedFromRouteTotals`. Whether it has a
live consumer is a follow-up, not decided here.

### Representative routes and their measured weight

Measured on this machine from the production build at branch tip on the rebased
tree — merge-base `origin/main` `7c506bd1`, built at the deploy base path
`/ModelTree/` — on 2026-08-31. Every fixed route with an island is covered; the
two detail-page families are covered by their **worst-case page** (not a
hardcoded slug, which a data refresh could rename). Bytes are RAW; gzip shown for
realism only.

These numbers were re-measured after rebasing onto `7c506bd1`, not reused from a
prior baseline, and they moved — which is exactly why re-measuring on every rebase
is mandatory: a raw-byte budget is a claim about the whole built tree, so it goes
stale on any markup or data change by anyone, and no file-collision check can
detect that (the rebase touched none of this issue's files yet still moved every
route number). Five causes account for the movement, measured on this machine:

- **The `BASE_PATH=/ModelTree/` pin** (see the flake-proof list above). Isolated
  by building the same rebased tree at `base=/` and at `base=/ModelTree/` and
  differencing: **+380 to +5,449 bytes per route**, largest on `home` (most
  root-relative links).
- **#634's SEO head markup** (canonical, robots, 9 Open Graph + 5 Twitter tags,
  a small inline JSON-LD of 515–736 bytes) on every route. Uniform and small.
- **#647's `variant-positioning` dataset and its expanded
  `LineageExplorer`/`ModelPassport`.** It inlines more per-model tier data into
  the pages that embed those islands — `home` (search/lineage index, HTML +195k),
  `providers/openai` (+134k), `catalog` (+92k) — and grows the shared island JS
  graph, which re-chunks so more of it counts in some routes' critical path
  (`updates` critical JS +94k though its HTML is tiny; whole-build JS total moved
  only +11.6k, so this is re-chunking, not new shipped weight). Its ~119 added
  lines of `global.css` account for the +1.5k CSS.
- **#665's long-tail family depth (six creators).** Adds HTML to the routes that
  render those families — `compare` +7,790, `home` +7,066, `catalog` +4,574,
  `benchmarks` +2,782, `tree` +2,401, `providers/openai` +728; `updates` and the
  worst passport page were unchanged. Absorbed within headroom, no ceiling raised;
  it added no `_astro` JS/CSS/font.
- **#674 — render every cited source for a variant-positioning record** (the sole
  structural mover in the 7-commit span `356989e9..7c506bd1`). It renders *all*
  cited sources instead of only the first, so `LineageExplorer`/`ModelPassport`
  gain per-source HTML on the lineage/variant routes (`home` +1,472 total: HTML
  +1,190, shared CSS +117, shared JS +165; `tree`/`compare` +617 each: HTML +500,
  CSS +117). Its ~16 added lines of `global.css` are the **+117 raw CSS that shows
  up on every route** (the stylesheet is shared), and a small `LineageExplorer.tsx`
  re-chunk moves whole-build JS +165. The remaining span commits — #675 (a +4-line
  `providers/[slug].astro` prose change, net ~0) and the five data/test-only commits
  #668/#671/#673/#676/#680 — net near-zero rendered bytes. All absorbed within
  headroom, no ceiling raised.

The four ceilings raised earlier (home, catalog, updates, providers) are each
attributed to their cause in the `reason` field in `asset-budgets.json`; on this
re-baseline no ceiling changed, and each `reason` records where #665's and #674's
growth landed and that headroom absorbed it.

**A prediction stated before measuring, and falsified by the measurement — recorded
honestly rather than quietly dropped.** `refresh-runs.json` was predicted to
contribute zero built output, on the static-import evidence that `raw.ts` imports
15 of the 18 files in `web/src/data/` and this is one of the three it does not.
That prediction was **wrong**: the file is imported directly by a `/refresh/` audit
route family (`/refresh/`, `/refresh/outcome/published/`, `/refresh/year/2026/`)
outside `raw.ts`, confirmed by finding a run-id token from it in those built pages.
The prediction's *conclusion for #33* still holds — `/refresh/` is not a budgeted
representative route and those pages carry none of the budgeted routes' or globals'
bytes — so it is budget-neutral here. But "zero built output" was false, and the
honest correction is that it renders on a route this issue does not budget. That
`/refresh/` pages grow append-only per refresh-run and are unbudgeted is a
follow-up, not decided here.

| Route | Path | Critical raw | Critical gzip | Budget (raw) | Headroom |
|---|---|---|---|---|---|
| home | `/` | 969,287 | 161,069 | 1,105,000 | +14% |
| catalog | `/models/` | 579,757 | 126,018 | 660,000 | +14% |
| benchmarks | `/benchmarks/` | 445,132 | 104,269 | 520,000 | +17% |
| tree | `/tree/` | 677,003 | 130,549 | 760,000 | +12% |
| compare | `/compare/` | 727,180 | 154,615 | 820,000 | +13% |
| updates | `/updates/` | 429,058 | 114,884 | 495,000 | +15% |
| passport (worst) | `/models/llama-4-scout/` | 162,852 | 29,412 | 200,000 | +23% |
| providers (worst) | `/providers/openai/` | 629,163 | 132,735 | 720,000 | +14% |

Passport pages are fully static today (**0 bytes of JS**) — #647 added tier
markup to `ModelPassport` but no `client:*` directive, so this held. They carry a
`jsMaxRaw` tripwire of 20,000 bytes: a stray `client:*` directive pulls the
~184 kB React runtime and trips it immediately, so an accidental hydration of a
static page is caught before it ships.

### Global (whole-build) ceilings

These catch shared-bundle and shared-stylesheet growth that no single route
surfaces on its own.

| Total | Measured raw | Budget (raw) | Headroom |
|---|---|---|---|
| JS (`_astro/*.js`) | 435,970 | 520,000 | +19% |
| CSS (`_astro/*.css`) | 103,389 | 125,000 | +21% |
| Fonts (`_astro/*.woff2`) | 187,036 | 210,000 | +12% |
| `_astro/` directory | 726,395 | 860,000 | +18% |

Ceilings sit ~12–26% above the value measured when they were set, leaving room
for normal catalog growth while still reddening on a real regression. The four
global ceilings were sized for #647 (JS +11.6k, CSS +1.5k; fonts unchanged) and
absorbed that growth without a raise. #665 added no `_astro` weight. On the
`7c506bd1` re-baseline, #674 (render every cited source) produced the first
`_astro` movement since: JS +165 (a `LineageExplorer.tsx` re-chunk), CSS +117
(its ~16 `global.css` lines), directory +282; fonts unchanged — each absorbed
without a raise. The fonts ceiling is held tightest (+12%) so a new weight or
subset is caught quickly. Each baseline is recorded in `asset-budgets.json` as
`measuredRaw` so the headroom is auditable.

## What is reported, not gated: lab metrics

Measured by `npm run lab` (`web/scripts/lab-metrics.mjs`), which drives the
Chromium that Playwright already installs — **no new dependency** (adding
Lighthouse would regenerate the mirror lockfile per ADR 0004, pure cost).

**These are throttled mobile-emulation numbers, not unthrottled desktop.** The
exact emulation, applied per page load over CDP, is:

- **Device:** Playwright `devices['Pixel 5']` — 393×851 viewport, device pixel
  ratio 2.75, mobile user-agent, touch enabled.
- **CPU:** `Emulation.setCPUThrottlingRate` rate **4** (4× slowdown).
- **Network:** `Network.emulateNetworkConditions` at a Slow-4G profile —
  download 1.6 Mbit/s (209,715 B/s), upload 750 kbit/s (96,000 B/s), latency
  150 ms.
- **Sampling:** each route loaded 5 times; **median and worst (max)** reported,
  because a single sample on a shared box is not trustworthy.
- **INP is a lab proxy:** the worst Event Timing duration (≥16 ms) after one
  scripted interaction (type into the search field, else click the first button).
  Real INP is a field metric; this is labelled a proxy wherever it appears.

Nothing this script prints can redden a merge.

**Targets** (documented, not enforced): LCP < 2500 ms · INP < 200 ms · CLS < 0.1.

### Recorded results

Captured 2026-08-31 on the shared Windows development machine while several agent
sessions ran concurrently — a deliberately contended condition, and busier than
the byte baseline above (four other docks live, one running a browser suite), so
these timing figures are measured under contention by design. On the rebased tree
(merge-base `origin/main` `7c506bd1`). Mobile emulation exactly as specified above,
5 runs each.

| Route | LCP median | LCP worst | CLS median | CLS worst | INP~ median | INP~ worst |
|---|---|---|---|---|---|---|
| home | 1860 ms | 2212 ms | 0.004 | 0.004 | 192 ms | 272 ms |
| catalog | 672 ms | 736 ms | 0.002 | 0.002 | 184 ms | 200 ms |
| benchmarks | 700 ms | 792 ms | 0.002 | 0.002 | 56 ms | 104 ms |
| compare | 704 ms | 784 ms | 0.029 | 0.029 | 72 ms | 168 ms |

CLS and LCP are within target everywhere, but **in this capture home's INP proxy
worst reached 272 ms — over the 200 ms target — and catalog's touched 200 ms**,
on a build whose byte weight is essentially unchanged from the one that measured
144/160 ms for home a capture earlier. That is not a regression in the change
under test; it is the same contention-driven instability, now landing on the
wrong side of the line. The swing is visible across captures: home's INP-proxy
worst has recorded **280 → 192 → 160 → 272 ms** on essentially unchanged byte
weight. This is exactly why these metrics report rather than gate — a threshold
anywhere in that band flips red or green on CPU load, not on the change, so the
numbers above are labelled as measured under contention rather than presented as
a clean result.

## Why lab metrics are not made to gate

The measurement above is the answer to "could a lab metric be made stable enough
to gate?" — no assertion, a measurement. Within a single earlier capture, home's
INP proxy spanned median 160 ms to worst 280 ms on an unchanged build; across
captures on essentially unchanged build weight the worst swung 280 → 192 → 160 →
272 ms, crossing back over the 200 ms target in the latest capture on a build
that is byte-for-byte within a few hundred bytes of the ones that stayed under it.
A threshold anywhere in that band flips red or green on CPU contention, not on the
change under test. Gating it would manufacture exactly the flaky required check
this issue exists to prevent, and `retries` would not fix it — retries convert a
deterministic environment defect into an intermittent one and bury it. `web-e2e`
runs with `retries: 0` and stays that way. The budgets that gate are the ones that
produce the same number on every machine.

## Reproducing

From `web/`:

- `npm run test` — runs the merge-blocking budget test (among the full suite).
- `npm run assets:report` — builds and prints the full per-route raw/gzip/brotli
  breakdown (report only).
- `npm run lab` — prints the mobile lab metrics above (report only; requires a
  built `dist/`, e.g. after `npm run assets:report` or `npx astro build`).
