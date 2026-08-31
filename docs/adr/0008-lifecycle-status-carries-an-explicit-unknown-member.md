# ADR 0008: Lifecycle Status Carries an Explicit unknown Member

- Status: Accepted
- Date: 2026-08-31
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It adds one member to the `lifecycleStatus` enum in
  `web/src/data/schema.ts` and leaves every other decision here untouched. It
  does **not** widen the ADR 0003 qualifying class — a schema change is outside
  that class, so this decision takes the ordinary human-reviewed path and does
  not reach `main` unattended. It does not modify ADR 0001's guardrail that
  branch protection and Pages settings remain explicit owner actions, and it
  revisits — without changing — the empty-family rule that
  `.github/skills/modeltree-gates/SKILL.md` instructs be revisited on any
  vocabulary change (see Guardrails).

## Context

The public site's standing goal is to show more of the AI ecosystem than the
handful of giants, and it does not: 30 of 40 creators hold exactly one model
family, so `/tree/` renders broad and flat. Issue #689 tried to add a second
family for six long-tail creators — EleutherAI, Ai2, TII, NVIDIA, IBM and
Cohere. The refresh run scouted them, produced 30 claims with 69 evidence
entries, passed `gate-source-approval` on all six bundles with every quote
machine-verified verbatim against stored bytes, and landed **zero** families and
**zero** releases. Issue #701 is the structural blocker it hit.

The mechanism is in the schema, and it was re-measured against this branch's
checkout rather than taken on trust. `web/src/data/schema.ts` defined:

```ts
export const lifecycleStatus = z.enum(['preview', 'current', 'legacy', 'deprecated', 'research']);
```

`status` is required on **both** `familySchema` and `releaseSchema`. There is no
`.default()`, `.optional()` or fallback on either — a grep for `status.*(default|optional)`
in `schema.ts` returns zero matches. So every family and every release must
assert one of five lifecycle terms.

A bare model card — which is all most long-tail creators publish — **states no
lifecycle term at all**. It names an architecture, a parameter count and a
licence, and says nothing about whether the vendor still offers the model. The
`provenance` rubric in `.github/skills/modeltree-review/SKILL.md` requires a
mapped field to be forced by a quote read alone, so with nothing to map from,
the only way to fill the required `status` was to guess a term the source never
gave. The review panel correctly rejected that guess. This was checked before it
was reported: the panel *accepted* the mapping wherever a status was actually
stated (Cohere's quoted `Live` → `current`; Ai2's quoted `preview`) and rejected
only where no quote states any lifecycle at all. It was reading, not
rubber-stamping.

The closed loop, then, is not a review failure and not a source-quality failure.
The schema compels an assertion the sources do not support, so a whole class of
honest, well-sourced records cannot be written. This collides head-on with a
rule this repository states as a requirement:

> Unknown and conflicting data stay explicit rather than being smoothed over.

Today `status` cannot stay explicit. The schema forces every record to assert a
lifecycle, so the only route to publishing a bare model card is to smooth the
absence over — the exact thing the rule forbids.

The precedent for the fix is one file over, and it was already committed and
current: `schema.ts` defines `modelSelection: z.enum(['fixed', 'routed', 'unknown'])`
— a **required** field (no `.optional()`) carrying an explicit `unknown` as a
deliberate vocabulary member, not a nullable escape hatch, for a product that
discloses no selection policy. That is precisely the shape `status` needs.

## Decision

**`lifecycleStatus` gains an `unknown` member:**

```ts
export const lifecycleStatus = z.enum(['preview', 'current', 'legacy', 'deprecated', 'research', 'unknown']);
```

`status: 'unknown'` is the faithful recording of "the source states no lifecycle
state." It is a first-class sourced value in the same sense `modelSelection:
'unknown'` is — the record stays complete and renders its own label, rather than
a blank or a withheld field. It is **not** an escape hatch that lets any
unmapped field be left open: the other required-mapping enums on family and
release (`categories`, `accessType`, `inputModalities`, `outputModalities`) keep
their existing discipline unchanged, because a card that omits its access type or
its modalities is not publishing a model, whereas a card that omits a lifecycle
term routinely *is*. Where one of those other fields cannot be mapped, the whole
record is still withheld rather than guessed.

**Every consumer of `status` was enumerated and handled** (AC3). A new member
that renders as a blank badge or silently sorts last would pass `astro check`
cleanly for the array cases and fail the build for the object-literal cases; both
were closed:

- `web/src/lib/format.ts` — `statusLabel` is an object literal keyed by the
  status union. TypeScript makes a missing key a compile error, so the build
  itself forced the addition: `unknown: 'Unknown'`.
- `web/src/lib/methodology.ts` — `lifecycleStatusGlossary` maps over
  `lifecycleStatus.options` and indexes an object literal of definitions by the
  member. A missing key is again a compile error, and the passport builder
  (`web/src/lib/passport.ts`) *throws* at build time when a status has no
  glossary entry. A definition for `unknown` was authored.
- `web/src/lib/provider-profile.ts` — `STATUS_ORDER` restates the enum order to
  drive the provider-page lifecycle filter. This is an array, so TypeScript does
  **not** flag an omission; leaving `unknown` out would silently drop
  `unknown`-status releases from the filter bar. `unknown` was appended, matching
  the schema's own order.
- `web/src/lib/comparison.ts` — the "superseded" note keys on
  `status === 'legacy' || status === 'deprecated'`. `unknown` is correctly not
  superseded, so no change is needed; a family whose lifecycle is unstated is not
  asserted to be replaced by anything.
- `.github/ISSUE_TEMPLATE/submit-release.yml` — the contributor "submit a
  release" issue form has a `status` dropdown, and
  `web/tests/contributing/issue-forms.test.ts` asserts it offers *exactly* the
  schema vocabulary and invents none. `unknown` was added to the dropdown so the
  form and the schema stay in step; omitting it fails that test.
- `.node-status`, `.release-status` and related CSS in
  `web/src/styles/global.css` colour by a single class, not per-status value, so
  no member renders as an unstyled or invisible badge.

**The Python side is kept in lockstep.** `tools/updater/src/modeltree_updater/validation.py`
carries its own `LIFECYCLE_STATUS` tuple, a deliberate duplicate of the schema's
vocabulary that `gates.py` and `validation.py` use to check records the updater
proposes. `web/src/data/schema.ts` is the source of truth; `validation.py`
mirrors it. `unknown` was added there too, because leaving it out would make the
Python validator reject — in the *permissive* direction — a record the web
schema accepts, which would re-block the very case this ADR unblocks whenever a
proposal flows through the updater path. The two vocabularies now agree member
for member.

**The proof against the real blocked input** (AC5). The decision was tested
against the preserved, read-only #689 archive (run `2026-08-31-b7c2d9`), whose 69
evidence quotes were re-verified verbatim against their stored bytes (69 checked,
0 failures, exit 0) before use — the exact bytes the panel rejected, not a
re-fetch. Reading the recorded `provenance` verdicts:

- **Four family claims were rejected with `status` as their *sole* provenance
  failure** — `eleutherai-family-gpt-neo-add`, `tii-family-falcon-3-add`,
  `ibm-family-granite-4-0-add` and `nvidia-family-nemotron-nano-2-add`. Each had
  its `firstReleaseDate` and its family definition sourced, and fell only because
  `status: 'current'` was "unsourced ... filled from what is usual." With
  `unknown` available, the honest mapping of "the card states no lifecycle" is
  `status: 'unknown'`, and that provenance failure is removed.
- **Cohere is publishable end to end.** The family claim
  `cohere-family-command-r-add` was rejected *only* because a family-level
  `status: 'current'` was "scoped, not supported" — no family-level lifecycle was
  stated anywhere — which `status: 'unknown'` now records honestly. Its release
  `cohere-release-command-r-08-2024-add` had every field properly sourced
  (`status: 'current'` mapped from the quoted `Live`, `accessType`,
  `contextWindow`, parameters) except one over-claimed `maximumOutput`, an
  **optional** field, which is simply dropped. The resulting family + release
  pair — reconstructed from only what the archive's own bytes support — validates
  against `familySchema` and `releaseSchema`.

`web/src/data/lifecycle-unknown.test.ts` encodes this proof as self-contained
fixtures (the archive is git-ignored and never committed), citing each claim id.
It also guards the AC3 regression directly: `statusLabel('unknown')` is
`'Unknown'`, the glossary carries a non-empty `unknown` definition, and
`lifecycleStatus.options` retains all five original members in order.

**No dataset records are added.** Per #701 the tranche is out of scope; adding
the six creators is #689's successor work and stays blocked on the releases'
*separate* evidence gaps (unsourced `accessType`, parameter counts read from
model names), which are scouting problems this schema decision does not touch.
AC5 asks the decision to be *demonstrated* publishable, not committed.

## Consequences

### Positive

- The long-tail is unblocked at the point it was stuck. A creator whose card
  states no lifecycle can now be published with `status: 'unknown'` instead of a
  guessed term, and the four families above plus Cohere are shown to clear the
  `status` blocker that sank them.
- The repository's "unknown data stays explicit" rule becomes expressible for
  `status`, where the schema previously prevented honouring it.
- The construct is an application of existing convention (`modelSelection`), not
  a new design, so the review rubric and the reader both already understand what
  an `unknown` in a controlled vocabulary means here.
- The blank-badge failure mode is closed by the type system for the two
  object-literal consumers and by an explicit test for the array consumer, so a
  future member cannot silently render empty.

### Costs

- **The vocabulary is looser.** A required field with an `unknown` member can be
  filled with `unknown` where a scout should have found a stated term. The
  mitigation is not in the schema but in review: `unknown` is faithful only when
  the source genuinely states no lifecycle, and mapping a stated term to
  `unknown` is as much a provenance failure as mapping an unstated one to
  `current`. The rubric already judges "exactly one member fits," and `unknown`
  fits exactly when nothing else is stated.
- **Two vocabularies to keep in step.** `validation.py` must track the schema
  enum. They were already duplicated deliberately; this adds one member that must
  stay mirrored, and the relationship is now documented at both sites.
- **`/compare`, `/tree/` and provider filters gain a member that reads as an
  absence.** "Unknown" beside "Available" and "Legacy" is honest but less crisp;
  a reader must understand it means "the creator did not say," which the
  methodology glossary now states.
- A schema change touches shipped types, so it takes the full reviewed path and
  cannot ride the ADR 0003 auto-merge lane. That is intended, not a cost to be
  engineered around.

## Alternatives Considered

- **Route 2 — an editorial convention that a published model with no stated
  lifecycle is `current`.** Rejected, and it is the one to argue against
  hardest. It is the cheapest option and the worst: it asserts a lifecycle fact
  the source does not state, then attaches a `sourceIds` citation to a source
  that does not support the assertion. That produces a citation which does not
  say what it is cited for — the exact failure #556 exists to prevent, committed
  deliberately and at scale across every long-tail record. It also fails the same
  provenance rubric the panel applied, so it does not even unblock the pipeline;
  a re-scout mapping absent-lifecycle to `current` would be rejected again. It
  trades a schema honesty problem for a citation honesty problem, which is worse.
- **Route 3 — add these families through the ordinary human-reviewed path,
  leaving the schema unchanged.** Rejected as a fix (fine only as a one-off). It
  routes around the blocker without removing it, and still requires a human to
  choose a `status` the source never stated — it relocates the invention from the
  automated path to a person rather than avoiding it, and leaves every future
  long-tail refresh blocked exactly as before.
- **Make `status` `.optional()` instead of adding a member.** Rejected. An
  optional field renders as an *absent* fact, and the schema's own doc comment
  and the empty-family reasoning both hold that "a tree branch rendering rows of
  blanks is not a fact this dataset states." `unknown` is a *stated* value — "the
  source is silent" — which is a different and honest claim, and it keeps every
  consumer total over the union rather than having to handle a missing field.
- **Add `announced`/`upcoming` at the same time.** Rejected as out of scope and
  as a different decision. Those members would reopen the empty-family rule (they
  assert a release does not yet exist); `unknown` deliberately does not. Mixing
  them would entangle this fix with a rendering change `/tree/` does not need.

## Guardrails

- **`unknown` means "the source states no lifecycle," and nothing else.** It is
  not a shortcut for "not sure which term," not a default for a scout who did not
  look, and not a way to publish a record whose *other* required fields are
  unmapped. Mapping a stated lifecycle term to `unknown` is a provenance failure,
  same as mapping an unstated one to `current`.
- **The empty-family rule in `gate-dataset.mjs` is revisited and unaffected, and
  this is stated rather than inferred** (AC2). That rule refuses a family with no
  releases, and its recorded reason is that `lifecycleStatus` has no
  `announced`/`upcoming` member, so the dataset cannot distinguish a family
  deliberately awaiting its first release from a data error. `unknown` says
  nothing about whether a release exists — a family with `status: 'unknown'`
  still needs a release, and still fails the rule if it has none — so it neither
  distinguishes an announced-but-unreleased family from a data error nor
  otherwise reopens the rule. The gate's own comment was updated to record the
  new member and this same conclusion. If `announced`/`upcoming` is ever added,
  *that* is the change that revisits the rule with teeth.
- **`validation.py`'s `LIFECYCLE_STATUS` mirrors the schema and may not drift
  from it.** The schema is the source of truth; a member added to one is added to
  the other in the same change. A divergence in the permissive direction
  (validator stricter than schema) silently re-blocks this decision.
- **This does not widen the ADR 0003 qualifying class.** A schema change is
  outside that class by construction and stays there. This decision authorises no
  auto-merge and grants no new path to `main`; it is reviewed like any other
  schema change here.
- **The other required-mapping enums keep their discipline.** `categories`,
  `accessType` and the modality lists gain no `unknown` and no escape hatch. The
  argument "we added `unknown` to `status`" is not a reason to loosen them; each
  would be its own decision with its own justification, and the reason `status`
  qualifies — a primary source routinely states no lifecycle at all — does not
  transfer to fields a real model card always carries.
