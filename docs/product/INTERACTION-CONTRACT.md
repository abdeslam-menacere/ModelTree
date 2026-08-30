# Interaction contract

What a ModelTree interface owes the person using it, and where each obligation is
enforced. Written from what the code does, not from what it should do: every rule
below names the test that fails when it stops being true.

It exists because these properties keep being re-derived. Issue #10 built the
homepage explorer, #11 the release drawer, #12 search and filters, #523 the
grouped navigation, and #14 hardened the lineage view across all of them. Each
one settled the same handful of questions independently, and each one had to
rediscover the answers by reading the stylesheet. This is the answer written
down.

## Motion

**The stylesheet has one motion policy and it is universal.** A single
`@media (prefers-reduced-motion: reduce)` block in `web/src/styles/global.css`
clamps `animation-duration`, `animation-iteration-count`, `transition-duration`
and `scroll-behavior` on `*`, `*::before` and `*::after` with `!important`.

The consequence is the useful part: **a new component does not need a
reduced-motion escape hatch, and must not add one.** Declaring an animation is
enough, because the killswitch already reaches it. A per-component
`@media (prefers-reduced-motion: reduce)` override is a signal that someone did
not know the global one existed.

The corollary is that motion must be *declared*, not simulated. An animation
driven from JavaScript — `setInterval`, a manual `requestAnimationFrame` loop, a
Web Animations call — is invisible to the killswitch and will keep moving for a
user who asked it not to.

*Enforced by:* `src/styles/global.test.ts` (the block exists and targets `*`);
`src/styles/primary-nav.test.ts` (the navigation declares no motion at all);
`e2e/lineage-reduced-motion.e2e.ts` (a real browser with the preference set
computes no perceptible duration anywhere on the lineage view, and — the control
that makes that mean something — *does* compute one without it).

## Focus

**Focus is visible everywhere by default.** A universal
`:focus-visible { outline: 3px solid var(--cp-accent) }` rule covers every
focusable element, and nothing in the stylesheet suppresses `outline`. A
component needs its own `:focus-visible` rule only to *tune* the ring — a tighter
offset on a scroll container, say — never to introduce one.

**Anything scrollable is focusable.** A container with `overflow: auto` holds
content a pointer can reach and a keyboard cannot, which fails WCAG 2.1.1. Two
exist: `.passport-table-scroll` and `.tree-scroll`. Both carry
`role="region"`, an `aria-label`, and `tabIndex={0}`.

`role` and `tabIndex` travel together here for a reason worth stating plainly:
**`aria-label` on a generic element is not exposed at all.** A `<div aria-label>`
with no role gives a screen reader nothing, so the label reads as present in the
source and is absent from the accessibility tree. The name needs a role to attach
to.

**Only a modal moves focus.** A disclosure that expands in place leaves focus on
its trigger. A dialog moves focus inside itself on open and returns it to the
element that opened it on close. Nothing else relocates focus, and nothing
relocates it on hover, on scroll, or on a state change the user did not cause.

*Enforced by:* `e2e/lineage-keyboard.e2e.ts` (the tree region is reachable by Tab
and paints a ring; every keyboard-focused stop has a non-`none` outline of
non-zero width; the drawer takes focus, returns it on Escape, and reopens for the
same release afterwards).

## State

**Every state a user can perceive is also programmatically exposed.** A
disclosure carries `aria-expanded` and `aria-controls`; a selectable item carries
`aria-pressed`; a current page carries `aria-current`; a modal carries
`role="dialog"`, `aria-modal="true"` and a resolvable accessible name.

**An `aria-labelledby` must point at an element that is rendered.** A reference to
an id that exists only at one breakpoint leaves the dialog nameless at the other,
and nothing reports it — the attribute is present, so it looks correct in the
markup. Where a name has a responsive source, assert that it resolves at each
width rather than that the attribute exists.

**A visual marker that duplicates an exposed state is `aria-hidden`.** The
"Selected" chip on a chosen release is decoration in the accessibility tree:
`aria-pressed` on the button is the single programmatic signal, and a visible
duplicate would be announced twice.

*Enforced by:* `src/components/ModelTreeExplorer.test.tsx`,
`src/components/ModelTreeExplorer.interaction.test.tsx`,
`src/components/LineageModelDrawer.interaction.test.tsx`, and
`e2e/lineage-keyboard.e2e.ts` for the name resolving at 320px.

## Colour

**Colour is never the only carrier of meaning.** Status, access, relation and
selection are each stated in words or in shape as well as in hue. A selected
release is not merely ringed in the accent colour — it says "Selected". An
unrelated node is not merely dimmed — it carries a written relation chip.

**Dimming composites text.** `opacity` on a container multiplies through to the
text inside it, so a node dimmed to 0.72 renders `#5c5c5c` on white as `#898989`
on `#fdfcfb` — 3.41:1, a WCAG 1.4.3 failure, on text that is enabled and
therefore exempt from nothing. Dimming is safe as reinforcement only at a value
that leaves the composited text above 4.5:1.

**Colour choices are measured, not eyeballed.** A hex that "looks fine" on a
white surface may sit on `--cp-bg` `#f7f4ef` where it is a full ratio worse, and
a link recoloured without checking its background can land on a filled accent
button at 1.14:1 — worse than what it was fixing. Read the background before
changing a foreground.

*Enforced by:* `e2e/lineage-a11y.e2e.ts` (axe at `wcag2a` through `wcag22aa`,
failing on `serious` and `critical`, at 1280px and 320px, on both lineage
surfaces and with the drawer open).

## Target size

Interactive controls clear **24 × 24 CSS px** (WCAG 2.2 AA 2.5.8). The primary
actions are larger by design — `.primary-action` at 44px, `.tree-disclosure` at
54px — but 24px is the floor nothing may fall under, including a text-styled
action in a row of links.

*Enforced by:* `e2e/lineage-keyboard.e2e.ts`, which measures every rendered
control against the floor and fails if it measured nothing at all.

## Narrow viewports

**The site is usable at 320 CSS px with no horizontal scrolling and no clipped
text.** That is a layout property, and it is enforced two ways because neither is
sufficient alone.

An intrinsic width — `min-width`, `width: max-content` — anywhere in a nested
structure sets a floor the whole ancestor chain inherits. Several exist in the
tree explorer, and each is neutralised by a `@media (max-width: 700px)` override
that wins **on source order at equal specificity**. That is fragile by
construction: `global.css` is append-only and shared, so a later block at the
same specificity silently takes precedence. This exact shape broke the issue #11
drawer, where a `.tree-details { position: static }` rule beat a later-needed one
and made `z-index` inert.

*Enforced by:* `src/styles/tree-narrow-viewport.test.ts`, which resolves the
cascade at 320px over the committed stylesheet and asserts both that no tree node
keeps an intrinsic width **and** that the competing rules are still there to be
overridden — a guard that stops finding anything is worse than no guard; and
`e2e/lineage-narrow-viewport.e2e.ts`, which measures the rendered document
against `documentElement.clientWidth` in a real engine.

## How these are tested

**jsdom cannot decide visibility, geometry, or colour.**
`getBoundingClientRect` returns a non-zero box for an element that is never
painted, computed styles do not composite ancestor opacity, and no layout is
performed. A claim about what a user can see is a claim jsdom cannot evaluate,
and asserting it there produces a test that passes for the wrong reason.

So the split is deliberate: **vitest asserts structure and cascade** — what the
markup exposes, what the stylesheet resolves to — and **Playwright asserts
rendering** — what the engine actually lays out, paints and composites.

**Every probe carries a control that proves it can fail.** This is not optional
rigour; it is the failure mode this repository keeps hitting. A green check that
never ran, never loaded the page, or never encountered the case it screens for is
indistinguishable from a correct one. So: the overflow detector is shown
detecting an injected 400px element; the axe scan is shown rating a planted
unlabelled input as blocking; the reduced-motion suite asserts the preference
actually reached the page and that the drawer *does* animate without it; and
every navigation asserts a 200 plus a content fingerprint, with a fabricated
route in the same spec that must fail that fingerprint.

The browser suite runs as `npm run test:e2e` and in `.github/workflows/web-e2e.yml`.
It is deliberately **not** part of `npm run validate`, because `validate` is
inside `npm run build` and a Chromium download does not belong in every install.
`web-e2e` is not a required status check; see
[`.github/workflows/README.md`](../../.github/workflows/README.md).
