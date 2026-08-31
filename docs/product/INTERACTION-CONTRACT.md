# Interaction contract

What a ModelTree interface owes the person using it, and where each obligation is
enforced. Written from what the code does, not from what it should do: every rule
below names the test that fails when it stops being true.

It exists because these properties keep being re-derived. Issue #10 built the
homepage explorer, #11 the release drawer, #12 search and filters, #523 the
grouped navigation, #14 hardened the lineage view across all of them, and #31
settled the visual system and the brand mark. Each one settled the same handful
of questions independently, and each one had to rediscover the answers by reading
the stylesheet. This is the answer written down.

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
text inside it, so a node dimmed to 0.72 rendered `#5c5c5c` on `#fdfcfb` as
`#898989` — 3.41:1, a WCAG 1.4.3 failure, on text that is enabled and therefore
exempt from nothing. (Those hexes are the pre-#31 palette; the mechanism is what
survives the retune, and the current value is measured in the table below.)
Dimming is safe as reinforcement only at a value that leaves the composited text
above 4.5:1, which is why the tree's dimming is 0.9 and not the 0.8 it looks like
it could be.

**Colour choices are measured, not eyeballed.** A hex that "looks fine" on a
white surface may sit on `--cp-bg` where it is a full ratio worse, and a link
recoloured without checking its background can land on a filled accent button at
1.14:1 — worse than what it was fixing. Read the background before changing a
foreground.

### The measured palette

Every text token is required to clear 4.5:1 on **any** of the four surfaces the
stylesheet can place it over — `--cp-bg`, `--cp-bg-elevated`, `--cp-surface`,
`--cp-surface-soft` — not merely on the one it happens to sit on today. Which
surface a component lands on is a fact about markup that moves; requiring the
cross product means nobody has to re-ask the question per component.

The figures below are the **worst** of those four, computed from the committed
stylesheet (issue #31). They are the expectation an audit can test against
rather than re-derive.

| Token | Light | worst | Dark | worst |
|---|---|---|---|---|
| `--cp-text` | `#12191c` | 15.67 | `#e4edf1` | 12.99 |
| `--cp-text-muted` | `#4a565b` | 6.67 | `#9aabb2` | 6.49 |
| `--cp-text-soft` | `#5c696e` | 5.00 | `#b6c5cb` | 8.69 |
| `--cp-accent` | `#0b6a76` | 5.55 | `#3fd0e6` | 8.36 |
| `--cp-link` | `#0f5fa8` | 5.74 | `#63c8f5` | 8.16 |
| `--cp-success` | `#136c37` | 5.73 | `#6ad884` | 8.64 |
| `--cp-warning` | `#8a5300` | 5.58 | `#f0b542` | 8.37 |
| `--cp-danger` | `#b3261e` | 5.76 | `#ff8f85` | 6.99 |

Non-text and composited cases, against WCAG 1.4.11's 3:1:

| Pair | Light | Dark |
|---|---|---|
| `--cp-accent-fg` on `--cp-accent` (filled button label) | 6.29 | 9.79 |
| `--cp-accent` focus ring on `--cp-bg` | 5.80 | 10.06 |
| `--cp-border-strong` on `--cp-bg` | 3.32 | 3.44 |
| `--cp-border-strong` on `--cp-surface` | 3.60 | 3.10 |
| `--cp-text-muted` dimmed to `opacity: 0.9` on `--cp-bg` | 5.45 | 6.53 |

`--cp-border` is **not** in that table and is not required to reach 3:1 — it
measures 1.40 light and 1.37 dark. It is a grouping hairline, never the sole
indicator of a control's boundary or state; `--cp-border-strong` is the token for
anything a user has to perceive. Confusing the two is the easy mistake here.

**The accent is a hue family, not a hex.** `--cp-accent` is cyan in both themes
but not the *same* cyan: a value light enough to read as electric on near-black
is a deep teal by the time it has to be 13px text on paper. Dark carries the
identity; light is the adaptive case. Both are measured above, and neither is
allowed to fail the floor for the sake of matching the other.

**Colour never implies a category the data does not record.** Creator, model,
product and serving platform are separate entities, and no hue is assigned per
provider or per vendor. There is no composite score and no universal ranking, so
there is no scale for a colour ramp to encode. Status colours mean status.

### Forced colours

When `forced-colors: active`, the user has replaced the palette and the tokens no
longer apply. The stylesheet defers rather than resists: system keywords take
over the focus ring, selection fills, modal edges and button affordance, and the
brand mark draws in `CanvasText` so it does not vanish into a background it can
no longer see.

Nothing in the stylesheet sets `outline: none`, anywhere, so focus survives the
mode by construction rather than by a rule that has to be remembered.

*Enforced by:* `src/styles/contrast.test.ts`, which parses both token blocks,
resolves `var()` chains, composites translucent values and asserts the whole
cross product above — with controls asserting it found the tokens it expected and
that a deliberately failing pair is reported as failing;
`src/styles/visual-system.test.ts` for the forced-colors block and for no raw
colour literal surviving outside the token layer; and `e2e/lineage-a11y.e2e.ts`
(axe at `wcag2a` through `wcag22aa`, failing on `serious` and `critical`, at
1280px and 320px, on both lineage surfaces and with the drawer open).

## Visual system

The tokens are the contract. A component that needs a value should reach for a
token, and a value that has no token is a signal that the system is missing a
step rather than licence to write a literal.

**Motion** is `--cp-motion-fast` (160ms), `--cp-motion-slow` (600ms),
`--cp-motion-stagger` (120ms) and `--cp-motion-ease`. No duration is stated
inline. See the Motion section above for why no component needs its own
reduced-motion escape hatch.

**Elevation** is `--cp-shadow-soft` and `--cp-scrim`. There are two of them
because there are two things a raised surface does — cast a shadow, and dim what
is behind a modal — and neither is a gradient, a blur or a glow.

**Spacing, radius and type** exist as scales and are adopted at the surfaces
issue #31 touched. They are deliberately **not** retrofitted across the whole
stylesheet: a blanket sweep would be thousands of lines of churn with no visual
delta. New work should use the scale; existing literals are left where they are
until something else needs to change nearby.

A token that nothing references is a defect, not a spare part. `--cp-sheen` sat
declared and unused in both themes until #31 removed it, and the first draft of
the #31 scale declared eighteen more of the same kind. `visual-system.test.ts`
now fails on an unreferenced token, which is why the scale is the size it is.

### Prohibited decoration

Not stylistic preference — each of these either encodes something the data does
not record, or costs legibility that the rest of this document is spent
defending.

- **No hotlinked company logos or brand imagery.** Assets are repository-
  controlled files. A remote logo is a third-party request, a licensing
  question, and a broken image in someone's future.
- **No bokeh, orbs, glow, or glassmorphism.** Translucent panels put text on an
  unpredictable background, which makes every ratio in the table above
  unverifiable.
- **No per-provider or rainbow colour coding.** See above: it implies a category
  the dataset does not have.
- **No decorative tree illustration behind content.** A dramatic visual tree
  competes with the scanning task the explorer exists to serve. The palette
  carries the identity; the layout carries the meaning.
- **No composite score, badge, or ranking.** There is nothing to rank.

*Enforced by:* `src/styles/visual-system.test.ts` for the token hygiene and the
motion tokens; `src/components/brand-mark.test.ts` for the mark being a committed
file in every copy rather than a remote reference.

## Brand mark

The mark exists in four copies, for four reasons that cannot be collapsed:
inline in `BrandMark.astro` so it reads the token layer and the theme;
`public/favicon.svg` because `<link rel="icon">` needs a file;
`public/mask-icon.svg` as the monochrome silhouette Safari re-colours itself; and
`docs/assets/modeltree-logo.svg` with literal colours, because GitHub's sanitiser
strips embedded style blocks.

**The in-page copy is inline, not an `<img>`.** An `<img>` is a separate
document: it cannot see `html[data-theme]`, cannot read the token layer, and
cannot respond to forced colours. A themed mark has to be inline to be themed at
all.

**The mark is decorative.** The anchor is labelled and the wordmark repeats the
name in text, so the SVG is `aria-hidden` and the text stays the accessible name.
A named mark would announce the brand three times for one link.

**A standalone `.svg` is parsed as XML, which is strict.** A `--` inside a
comment or an unescaped `&` makes the file undecodable and the icon renders as
nothing, while looking entirely correct in an editor. This is not hypothetical —
it happened during #31 and was caught by the parser check, not by any assertion
that read the file as text.

*Enforced by:* `src/components/brand-mark.test.ts` (geometry parity across all
four copies, the 16px legibility arithmetic, XML well-formedness, and the byte
budget) and `e2e/brand-mark.e2e.ts`, which renders the served asset in a real
engine at 16px and 32px and measures ink coverage against a band set from
measurement — with controls proving a blank plate falls under it and a filled
block rises above it.

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
Whether `web-e2e` is a required status check is a branch-protection matter; see
[`.github/workflows/README.md`](../../.github/workflows/README.md). Branch
protection is the authority for that question, and it lives outside the tree, so
both documents are describing something neither of them controls.

A flaky assertion in a required suite blocks every merge in the repository, not
only the change that introduced it — which is why a threshold in it is expected
to arrive with the measurement it was set from and a stated margin, rather than a
round number that looked about right.

One consequence is easy to miss: **`web-ci` and `web-e2e` self-skip on a pull
request that touches no `web/` files, and still report SUCCESS.** That is a
conditional step inside the job rather than a `paths:` filter, so the check
appears green having executed nothing. A green tick is not evidence a suite ran;
the run's own test summary is.
