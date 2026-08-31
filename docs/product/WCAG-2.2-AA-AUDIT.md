# WCAG 2.2 AA audit

An independent, end-to-end accessibility audit of ModelTree's core journeys,
recorded for issue #32. It is deliberately separate from the component-level
work that preceded it — #14 (lineage view), #24, #26, and #31 (visual system and
brand mark) each hardened one surface — because a set of individually accessible
components is not the same claim as an accessible site. This is the site-level
claim, with re-runnable evidence for every part of it that a machine can re-run,
and an honest record of the parts it cannot.

Written from what the code does and what the tests observe, not from intent.
Every automated row names the spec that fails when the property stops holding.
The measured contrast figures are not re-derived here; they live in
[`INTERACTION-CONTRACT.md`](./INTERACTION-CONTRACT.md#the-measured-palette) and
this audit tests against them.

- **Standard:** WCAG 2.2, Level AA.
- **Trunk audited:** `0b5cc206` (the commit at which #31 landed).
- **Non-goals (binding):** no third-party certification claim; no redesign of
  unrelated features; no repaint of the visual identity #31 established; native
  semantics preferred over custom ARIA. An automated scanner is explicitly *not*
  the complete audit — hence the manual matrix and the residual-risk register.

## Core journeys audited

The routes from [`INFORMATION-ARCHITECTURE.md`](./INFORMATION-ARCHITECTURE.md),
which is the definition of "core journey" this audit uses.

| Route | Journey | Detail-page resolution |
|---|---|---|
| `/` | Homepage lineage explorer (+ release drawer) | — |
| `/tree/` | Full ecosystem tree explorer | — |
| `/models` | Model catalog (search + filters) | — |
| `/models/[slug]` | Model Passport | First link off `/models` |
| `/providers` | Provider directory | — |
| `/providers/[slug]` | Provider profile | First link off `/providers` |
| `/benchmarks` | Evidence explorer | — |
| `/compare` | Model comparison | — |
| `/timeline` | Release timeline | — |
| `/updates` | Recorded release updates | — |
| `/methodology` | How ModelTree decides what to record | — |

The two `[slug]` pages are resolved at runtime by following the first link off
their index (`web/e2e/site-helpers.ts`), never by naming a slug, so a dataset
refresh cannot silently drop them from the audit or redden it.

## Findings and fixes

Phase 0 was a discovery scan: full-page axe (`wcag2a` through `wcag22aa`, failing
on `serious`/`critical`) across every core route at 1280px and 320px, plus
forced-colors rendering and reflow bands. It found **exactly two blocking
violations**, both the same defect class:

| # | Severity | Rule | Where | WCAG | Fix |
|---|---|---|---|---|---|
| 1 | critical | `aria-allowed-attr` | `<a class="evidence-candidate">` carried `aria-pressed` | `/benchmarks` | 4.1.2 | Removed `aria-pressed`; selection is exposed through the link's accessible name (`Add …` / `Remove …`) |
| 2 | critical | `aria-allowed-attr` | `<a class="comparison-candidate">` carried `aria-pressed` | `/compare` | 4.1.2 | Same: removed `aria-pressed`, name flips `Add …`/`Remove …` |

`aria-pressed` is not an allowed attribute on `role="link"`, which is what an
`<a href>` is. Both candidates are progressive-enhancement anchors — they carry a
real `href` to the toggle URL and work without JavaScript — so the honest native
control is the link, and its *state* belongs in its accessible name, not in a
toggle-button attribute it is not allowed to have.

Two sibling facet chips in the same component (`<a class="evidence-chip">`, the
domain and benchmark filters) carried the same invalid `aria-pressed`. They were
not flagged by the discovery scan because the real dataset does not render an
active facet on load, but they are the identical defect, so they were fixed in
the same pass — changed to `aria-current="true"` when active, which is this
repository's established idiom for "the current item" on a link (see the selected
release in `LineageExplorer` and catalog pagination). All visual state is keyed
on `data-active` / `data-selected` in the stylesheet, not on the ARIA attribute,
so the fix changes the accessibility tree without repainting anything.

No contrast, keyboard, reflow, or forced-colors *defects* were found: #31's
palette retune brought every text token clear of 4.5:1 (the measured table in the
interaction contract), and the reflow and forced-colors work below confirms those
surfaces at the rendered level for the first time.

### Files changed

| File | Why |
|---|---|
| `web/src/components/BenchmarkExplorer.tsx` | Removed `aria-pressed` from the evidence candidate link; changed the two facet chips from `aria-pressed` to `aria-current` |
| `web/src/components/ModelComparison.tsx` | Removed `aria-pressed` from the comparison candidate link |
| `web/src/components/BenchmarkExplorer.interaction.test.tsx` | Regression guard: an applied facet exposes `aria-current` and no link ever carries `aria-pressed` |
| `web/src/components/ModelComparison.interaction.test.tsx` | Regression guard: a candidate is marked through its accessible name, never `aria-pressed` |
| `web/e2e/site-helpers.ts` | New: all core routes + fingerprint-gated navigation, shared by the three new specs |
| `web/e2e/site-a11y.e2e.ts` | New: axe across every core route at desktop and mobile |
| `web/e2e/zoom.e2e.ts` | New: explicit 200% and 400% reflow evidence |
| `web/e2e/forced-colors.e2e.ts` | New: rendered forced-colors proof |
| `docs/product/WCAG-2.2-AA-AUDIT.md` | This document |

## Automated evidence map

Every row is a spec in `web/e2e/` (browser) or a `*.test.ts` (unit), run under
the same `retries: 0` policy as the rest of the suite — a flaky accessibility
result is a finding, not noise to retry past. Each browser spec carries at least
one control that proves it can fail, so a green is never vacuous.

| Property | WCAG | Evidence | Control that proves it can fail |
|---|---|---|---|
| No serious/critical violations, every core route, 1280 + 320 | 1.1.1, 1.3.1, 4.1.2, … | `e2e/site-a11y.e2e.ts` | Planted unlabelled input is reported `critical`; scan reports >5 passing checks |
| Reflow at 200% (640 CSS px) and 400% (320 CSS px), every route | 1.4.10 | `e2e/zoom.e2e.ts` | A planted 3000px element is caught as an offender |
| Forced-colors: tree connectors + timeline spine still paint | 1.4.1, 1.4.11 | `e2e/forced-colors.e2e.ts` | With the restoring rule mutated to `Canvas`, the connector test goes red (observed) |
| Forced-colors: focus ring survives | 2.4.7, 1.4.11 | `e2e/forced-colors.e2e.ts` | The preference-reached-page control asserts both directions of `matchMedia` |
| Lineage keyboard operability + visible focus | 2.1.1, 2.4.7 | `e2e/lineage-keyboard.e2e.ts` (pre-existing, #14) | In-spec focus-ring and negative controls |
| Reduced motion respected | 2.3.3 | `e2e/lineage-reduced-motion.e2e.ts` (pre-existing) | Computes a duration *without* the preference |
| Narrow-viewport lineage reflow | 1.4.10 | `e2e/lineage-narrow-viewport.e2e.ts` (pre-existing) | `findOverflow` detector control |
| Contrast tokens clear 4.5:1 / 3:1 | 1.4.3, 1.4.11 | `src/styles/contrast.test.ts` (pre-existing, #31) | Asserts a deliberately failing pair is reported failing |
| Forced-colors block present + no raw colour literals | 1.4.1 | `src/styles/visual-system.test.ts` (pre-existing, #31) | — (source-level) |
| Candidate/facet state exposed without invalid ARIA | 4.1.2 | `BenchmarkExplorer.interaction.test.tsx`, `ModelComparison.interaction.test.tsx` | Re-introducing `aria-pressed` reddens the guard (observed) |
| Resize text to 200% without loss of content or function | 1.4.4 | **Not assessed** — see R6 | — |

### The two gaps #31's QA gate handed this issue

1. **Zoom had no dedicated assertion** anywhere in the repo — only indirect
   coverage via the 320-CSS-px lineage reflow test. `e2e/zoom.e2e.ts` closes it
   with explicit 200% and 400% bands (the WCAG viewport-equivalence: at a 1280px
   base, zoom N% ≡ 1280 ÷ (N/100) CSS px, so 200% ≡ 640 and 400% ≡ 320), applied
   to every core route, permitting horizontal extent only inside a designated
   `overflow-x: auto|scroll` region.
2. **Forced-colors was verified at source level only.** `visual-system.test.ts`
   parses the `@media (forced-colors: active)` block; it cannot see what the
   engine paints. `e2e/forced-colors.e2e.ts` renders under
   `emulateMedia({ forcedColors: 'active' })` and measures the pseudo-element
   backgrounds directly. This is the test that was missing when #31 discovered —
   by screenshot, not by reasoning — that forced-colors rewrote the tree's branch
   connectors to `Canvas` and collapsed the tree into a flat list. The connector
   assertion resolves the real `Canvas` system colour via a probe element and
   fails if the connector background equals it; the mutation proof above confirms
   it does.

### Runtime budget

`web-e2e` is a **required** status check on `main`, so every test added here
gates every future merge, including the unattended data-refresh PRs. That makes
wall-clock a first-class design concern, and the numbers are stated rather than
assumed. Measured on this branch's machine at `CI=1` (single worker), back to
back under the same shared-runner contention:

| Suite | Tests | Wall-clock |
|---|---|---|
| Merge base `0b5cc206` (pre-existing e2e only) | 36 | ~1.2m |
| This branch (with the three new specs) | 65 | ~2.0–2.2m typical; 4.1m once under heavy contention |

So the 29 added tests roughly **double** the suite's typical wall-clock (about
+50–60s), and this machine's contention can push either figure up several-fold
on a bad run — the before/after were captured adjacently to keep the delta
attributable rather than inferred. The added cost is dominated by the 22
full-page axe scans (`site-a11y.e2e.ts`: nine static routes plus the two resolved
detail pages, each at desktop and mobile widths); the zoom and forced-colors
specs are comparatively cheap. The budget this sets: the site-level axe scan
scales with routes × viewports, so a materially larger route set or a third
viewport is the thing that would need sharding or a representative-route subset
rather than another full sweep. This is recorded for the coordinator's decision;
no `retries` were added and no assertions were trimmed to move the number.


An automated scanner cannot judge reading order in context, the sense of a
label, or whether a screen-reader announcement is *useful*. This matrix records
the manual journeys the audit relies on and, honestly, which were executed here
versus which are documented procedures backed by automated checks.

### Keyboard-only journeys

Executed by reasoning from the accessibility tree the specs assert plus the
enforcing e2e. Keyboard operability of the lineage surfaces is directly asserted
by `e2e/lineage-keyboard.e2e.ts` (Tab reaches the scroll region and disclosures,
`:focus-visible` computes a ring, expanded/selected state is in the tree).

| Journey | Expectation | Backing |
|---|---|---|
| Tab through `/tree/` | Scroll region is a tab stop; every disclosure reachable; visible ring throughout | `lineage-keyboard.e2e.ts` (executed) |
| Open a release drawer by keyboard | Enter/Space opens; focus is managed; Escape returns | `lineage-keyboard.e2e.ts` (executed) |
| Filter the catalog `/models` | Search field and facet controls reachable and operable | axe name/role/value on `/models` (executed); manual pass documented |
| Toggle a comparison candidate `/compare` | Link reachable; name announces `Add …` → `Remove …` on activation | `ModelComparison.interaction.test.tsx` (executed) |
| Apply an evidence facet `/benchmarks` | Facet reachable; `aria-current` set on the active one | `BenchmarkExplorer.interaction.test.tsx` (executed) |

### Screen-reader smoke — support matrix

A live screen reader was **not** driven in this CI environment; doing so is not
re-runnable here and no claim is made that it was. What is executed is the
name/role/state layer a screen reader reads, via axe (`aria-allowed-attr`,
`aria-required-attr`, `button-name`, `link-name`, `label`, `aria-valid-attr`) on
every core route. The table below is the documented support target and the smoke
procedure to run before a release; results are an attestation item, recorded as a
residual risk rather than asserted as passed.

| Screen reader + browser | Target | Executed here |
|---|---|---|
| NVDA + Firefox (Windows) | Primary | Documented procedure; not run in CI |
| VoiceOver + Safari (macOS/iOS) | Primary | Documented procedure; not run in CI |
| Narrator + Edge (Windows) | Secondary | Documented procedure; not run in CI |
| Orca + Firefox (Linux) | Best-effort | Documented procedure; not run in CI |

Smoke procedure: land on each core route, confirm the page has a programmatic
heading and landmark structure; on `/tree/` confirm the tree announces as a tree
with expandable nodes; on `/compare` and `/benchmarks` confirm a candidate/facet
announces its `Add/Remove` / current state on activation; confirm the release
drawer announces on open and that focus is placed inside it.

### Content-variability fixtures

Accessibility has to hold across the shapes real data takes, not just the tidy
one. These states are exercised by the comparison and catalog interaction
fixtures and by the axe scan running against the live dataset.

| Shape | Where it shows | Covered by |
|---|---|---|
| Sparse (few models, missing fields) | Passport with empty sections | axe on resolved `/models/[slug]` |
| Complete | Fully populated Passport | axe on resolved `/models/[slug]` |
| Stale / superseded | Timeline + updates entries | axe on `/timeline`, `/updates` |
| Conflicting / unknown values | Kept explicit, never smoothed | Data layer (Zod); axe on rendering |
| Long labels | Comparison columns, facet chips | Reflow at 320 CSS px (`zoom.e2e.ts`) |

## Residual-risk register

Findings and limits deliberately **not** fixed under this issue, each with its
reason. Recording an accepted residual risk is a deliverable of this issue, not a
failure.

| # | Item | Severity | Decision | Reason |
|---|---|---|---|---|
| R1 | axe `moderate` findings (e.g. page-level heading order across independently authored components) | moderate | Accepted | The issue's automated bar is serious/critical. Moderate heading-order across a page assembled from separate islands is a judgement call a machine cannot settle; documented, not smuggled into a fix here. |
| R2 | Live screen-reader passes (NVDA/VoiceOver/Narrator/Orca) | — | Accepted as attestation | Not re-runnable in CI. The name/role/state layer they read is asserted by axe on every route; the manual smoke is a documented pre-release procedure. |
| R3 | `--cp-border` grouping hairline measures 1.40:1 | n/a | By design | It is a grouping hairline, never the sole indicator of a control's boundary or state (`--cp-border-strong` is that token). Per the interaction contract, it is exempt from 1.4.11's 3:1. |
| R4 | `.timeline-stop-head::before` excluded from the forced-colors connector fill | n/a | By design | It has a real border and is a ring; filling its background under forced colors would turn the ring into a blob. #31's deliberate exclusion, preserved. |
| R5 | Zoom verified by viewport-equivalence, not by the browser's own zoom control | low | Accepted | WCAG 1.4.10 is defined at 400% on a 1280px viewport, which is the CSS-px equivalence used here; Playwright cannot drive the chrome zoom control, and the equivalence is the same model the pre-existing 320px reflow test uses. |
| R6 | WCAG 1.4.4 Resize Text (200% text-only scaling) — **not assessed** | low–moderate | Accepted, documented | 1.4.4 is a distinct AA criterion from the 1.4.10 reflow covered above: it scales *text* (via the browser's text-zoom / root font-size), not the viewport, and a layout that reflows correctly at 320 CSS px can still clip or truncate text enlarged to 200% inside a fixed-height box. It was not assessed rather than assumed passing. A font-scale-plus-overflow proxy was considered and declined: overflow is the wrong signal (text clipping inside a bounded box does not overflow the document), a faithful clipping check is more flake-prone than its value here, and it would add to the very `web-e2e` budget flagged above. Recorded as an explicit gap for a manual pass or a dedicated future issue. |

The distinction R6 draws matters for how this matrix reads: a AA criterion that
is silently absent looks assessed-and-passing to anyone scanning it, so 1.4.4 is
named as *not assessed* exactly as the live screen-reader passes (R2) are, rather
than left off.


## Assumptions

Recorded here and in the issue summary, per this repository's rule that ambiguity
is written down and then proceeded on, never guessed silently.

- "Evidence" = `/benchmarks`; "Passport" = `/models/[slug]`.
- "No serious or critical automated violations remain" is the binding acceptance
  bar, so those were fixed; moderate/manual/exempt findings became documented
  residual risks above.
- Zoom is tested by the WCAG viewport-equivalence model (200% ≡ 640, 400% ≡ 320
  at a 1280 base), matching how the existing 320px reflow test was framed.
- Facet state on a link is expressed with `aria-current`, consistent with the
  repository's existing idiom, rather than a toggle-button pattern.
