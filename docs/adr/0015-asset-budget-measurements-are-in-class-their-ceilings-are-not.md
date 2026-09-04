# ADR 0015: Asset-Budget Measurements Are In Class, Their Ceilings Are Not

- Status: Accepted
- Date: 2026-09-03
- Decision owners: ModelTree maintainers
- Supersedes: nothing. **Amends ADR 0003** by widening the qualifying class it
  defines to include one further file, `web/asset-budgets.json`, and — unlike
  ADR 0006, which admitted `web/src/data/refresh-runs.json` as a whole path —
  admits it only for a named subset of its fields. Every other bound in ADR 0003
  is unchanged, and the ADR 0006 widening is untouched. Read ADR 0003 for the
  qualifying class this narrows an admission into, and ADR 0006 for the precedent
  that a widening is paid for by a companion check rather than taken on trust.
  This does **not** disturb ADR 0001's guardrail that branch protection and Pages
  settings remain explicit owner actions.

## Context

ADR 0003 lets a source-backed refresh auto-merge only when every file it touches
is in the qualifying class `gate-scope.mjs` enforces: the dataset documents
`web/src/data/raw.ts` composes, plus the refresh ledger ADR 0006 added. One file
outside that list disqualifies the whole change, and `gate-scope.mjs` decides on
the path alone — across its source it parses no document, so its answer to "does
this change qualify" is purely a question about paths.

A guard added on 2026-09-02 by abdeslam-menacere/ModelTree#813 collides with that
class. `web/asset-budgets.json` records, per route, the raw byte size the
production build actually produces (`measuredRaw` and its siblings), and
`web/tests/build/asset-budgets.test.ts` now asserts that each recorded figure
stays within `measuredDrift.maxFraction` — 2% — of the build's real output. That
guard exists for a good reason: before it, the recorded figures drifted up to
11% stale while 23 commits of data and markup landed, and the stale numbers
misled abdeslam-menacere/ModelTree#811 into believing a fully-researched data
tranche was unaffordable. Documentation no test reads is documentation that
decays.

The collision is structural. A refresh that adds a normal data tranche inlines
records into island props on `/tree` and `/compare`, which moves those pages'
raw byte size. A tranche large enough moves them past the 2% guard, and the only
fix the failing test itself prescribes is to re-run `npm run assets:report` and
re-record `measuredRaw`. That write lands in `web/asset-budgets.json`, which is
not in the qualifying class, so `gate-scope.mjs` exits 1 and ADR 0003 does not
authorise auto-merging the result. An unattended refresh of ordinary size can
therefore only produce a red pull request or stop. One already stopped: refresh
run `2026-09-03-660be8`, stranding a cleanly-gated tranche and filing
abdeslam-menacere/ModelTree#833. This blocks the whole ADR 0003 path, because the
drift budget is spent by ordinary trunk activity within about a day, so every
future refresh hits it.

### Why the file cannot be admitted as a whole path

The obvious remedy — add `web/asset-budgets.json` to `ALLOWED_PATHS`, the way
ADR 0006 added the ledger — is unsafe, and the reason is that `gate-scope.mjs`
cannot see fields. It admits or refuses a path; it has no way to admit some of a
file's contents and refuse the rest. And `web/asset-budgets.json` mixes three
kinds of value under one path:

- **Regenerable measurements** — `measuredRaw`, `measuredWorstRaw`,
  `measuredWorstJsRaw` and the `globals` `*MeasuredRaw` figures. These are
  documentation: the number the build produces, rewritten by
  `npm run assets:report`. This is exactly what a refresh legitimately needs to
  re-record, and re-recording it changes no limit.
- **Enforced ceilings** — every `criticalMaxRaw`, every `jsMaxRaw`, and the
  whole-build `jsTotalMaxRaw` / `cssTotalMaxRaw` / `fontTotalMaxRaw` /
  `astroDirMaxRaw` under `globals`. `asset-budgets.test.ts` asserts the build
  stays at or under each of these. They are the actual performance limits.
- **The drift guard itself** — `measuredDrift.maxFraction`, the 2% tolerance the
  guard enforces.

Admitting the path wholesale would grant permission to change every one of those
fields. An unattended refresh that overshot a ceiling could raise the ceiling; a
refresh that tripped the drift guard could widen the tolerance to 50%. Either
would then pass `gate-scope` (path in class), pass `npm run validate` (having
edited the very field that was failing), and auto-merge with no human in the
loop. That is a self-approving performance guard — the single move an unattended
pipeline must never have, and worse than the problem being solved: a stale
`measuredRaw` misleads a reader, whereas a silently raised `criticalMaxRaw`
removes the enforcement entirely and leaves a green build behind it. The
repository's standing rule is absolute — never lower or widen a threshold,
ceiling, tolerance or budget to make a failing delivery pass — and whole-path
admission would put exactly that move inside the auto-merging class.

## Decision

**Admit `web/asset-budgets.json` to the ADR 0003 qualifying class only for its
regenerable measurement figures and non-enforcing prose, and give
`gate-scope.mjs` its first content-aware check to enforce that bound.**

The gate parses the document at both ends of the diff it already computes — the
merge base with `refs/remotes/origin/main`, and the working-tree copy that would
merge — and admits the change only when every difference between them lands in a
field a refresh may move. Those fields are named explicitly: the measurement
figures `measuredRaw`, `measuredWorstRaw`, `measuredWorstJsRaw`,
`jsTotalMeasuredRaw`, `cssTotalMeasuredRaw`, `fontTotalMeasuredRaw` and
`astroDirMeasuredRaw`; the per-entry `reason` prose; and the top-level
`$schema-note`, `headroom-note` and `drift-note`. Any difference in any other
field — every ceiling and the tolerance among them — makes the change out of
class exactly as before.

**The permitted set is named, not the forbidden set.** The check enumerates the
fields that may move and refuses every other difference, rather than listing the
ceilings and permitting the rest. This is deliberate: a ceiling introduced by a
future entry is protected by default, and the check has nothing it must keep in
sync with `asset-budgets.test.ts` as that test's enforced fields change. On any
doubt the change is refused, which is the safe direction.

**Structure must match, so adding or removing an entry is out of class.** The
comparison requires the two documents to have the same shape: an object gaining
or losing a key, an array changing length, or a value changing kind is itself a
refusal. Adding a route or route-group entry adds a new enforced ceiling, and
removing one drops enforcement; both are judgements a human must make, so both
leave the class. Renaming an `id`, `path`, `dir` or `match` is refused for the
same reason — it is not a measurement.

**Prose may change.** `reason` strings and the `*-note` keys are documentation
the gate and the test both leave unenforced, and forbidding them would force a
refresh to re-record a number without saying why — the silent decay this guard
exists to stop. The enforcing-field check is independent of prose, so permitting
prose cannot launder a forbidden change: a ceiling raise riding alongside a
re-record and a re-worded `reason` is still caught on the ceiling.

**What cannot be read is refused, never passed.** A file that did not exist at
the anchor, a deletion, or JSON that will not parse at either end all mean the
enforcing fields cannot be compared. A guard that cannot see whether a ceiling
moved must assume it did, so each of these exits out of class rather than green.

## Consequences

### Positive

- An unattended refresh of ordinary size can once again auto-merge. The party
  that moved a page's byte size — the refresh — is the party that re-records the
  measurement, which is where the responsibility belongs, and the ADR 0003 path
  is unblocked without a human re-recording numbers by hand.
- The 2% drift guard and every ceiling keep their full force under automation.
  The one field-scoped admission is strictly narrower than whole-path admission
  and weakens no enforcement: raising a limit still faces a human.
- `gate-scope.mjs` gains a content-aware check that is proved to fail on each
  forbidden mutation, so the distinction between documentation and enforcement —
  which the file's own prose already draws — is now mechanically enforced rather
  than merely stated.

### Costs

- **`gate-scope.mjs` is no longer purely path-based.** It now parses one document
  and compares its fields, which is more machinery and a new failure surface: a
  bug in the walker could admit a forbidden change or refuse a permitted one. The
  cost is bounded to a single path and covered by tests that drive the check to
  fail on a moved ceiling, a widened tolerance, a moved `jsMaxRaw`, a moved
  `globals` ceiling, a combined edit, malformed JSON, a structural add/remove and
  a missing baseline — but it is real, and it is the first time this gate depends
  on the shape of a file's contents rather than its name.
- **The qualifying class is genuinely wider.** A file that was entirely outside
  the auto-merging class is now partly inside it, and an unattended run can write
  it. The widening is real and is accepted because it is confined to figures that
  carry no enforcement and can be regenerated deterministically from the build;
  but it is a widening, not a reshuffle, and the enforcing fields sit one walker
  bug away from it.
- **The list of permitted fields is coupled to the file's schema.** If a future
  change adds a new regenerable measurement field, `npm run assets:report` will
  write it and the gate will refuse the result until the field is added to the
  permitted set — a change that itself needs review. This is the safe direction
  (a new field fails closed), but it means the permitted set is a small piece of
  schema knowledge the gate must carry, tested by a self-test that re-records
  every measurement field and expects a pass.
- **Prose is admitted to the auto-merging class.** An unattended run can rewrite
  the `reason` and `*-note` strings, including the guard's own explanation that
  it "never permits more bytes". That prose is unenforced, so a rewrite changes
  no limit; but a reader trusts it, and a refresh could in principle degrade it.
  Accepted because the alternative — forbidding prose — reintroduces exactly the
  re-record-without-explanation decay the guard was built to prevent.

## Alternatives Considered

- **Add `web/asset-budgets.json` to `ALLOWED_PATHS` as a whole path (the issue's
  recommended Option 1).** Rejected as unsafe. `gate-scope.mjs` decides on the
  path alone, so whole-path admission grants permission to change every field in
  the file — including the ceilings and the 2% tolerance. It would let an
  unattended refresh raise its own performance limit or widen the guard that
  caught it and auto-merge, a self-approving performance guard, which is worse
  than the stale-documentation problem it solves. The field-scoped decision here
  is strictly narrower and weakens nothing.
- **Re-baseline the budgets on trunk periodically, independent of refresh runs
  (Option 2).** Rejected as a non-fix. It only keeps the drift budget near zero
  so tranches fit; it does not resolve the class conflict, because the moment a
  refresh does move a page it still has to re-record a file outside its class. It
  postpones the collision rather than removing it, and the issue's own drift
  table shows the budget is re-consumed by ordinary trunk activity within about a
  day, so the postponement is short.
- **Exempt `measuredDrift` from the required `web-ci` check and report it
  elsewhere (Option 3).** Rejected as the weakest option, and correctly rejected
  in the issue. It recreates precisely the silent decay abdeslam-menacere/ModelTree#813
  fixed: a drift check no required build reads is a check that stops being
  believed, and the stale figures return.
- **Enumerate the forbidden (enforcing) fields and permit everything else.**
  Rejected because it fails open. A ceiling added to a future entry, or a new
  enforcing field added to the test, would not be on the forbidden list and would
  slip through until someone noticed. Naming the permitted set instead fails
  closed, which is the direction this whole guard is built to fail in.

## Guardrails

- **The enforcing fields stay out of class, and that is the point of the
  decision.** Every `criticalMaxRaw`, every `jsMaxRaw`, the `globals` `*MaxRaw`
  ceilings and `measuredDrift.maxFraction` must never be admitted to the
  auto-merging class. A change to any of them is out of class and faces a human.
  If the field-scoped check is ever simplified to admit the whole path, this ADR
  lapses and the ADR 0003 class must drop the file entirely rather than keep it
  on unsafe terms.
- **The permitted set is a whitelist and stays one.** New fields are refused
  until explicitly added, and adding one is a reviewed change. Do not invert the
  check to a blacklist of ceilings for the tidier-looking rule; the fail-open
  behaviour that inversion buys is exactly what the decision rejects.
- **Structure changes leave the class.** Adding or removing a route or
  route-group entry, or renaming an identifier, is out of class. Do not relax the
  shape comparison to tolerate an added entry as "just more measurements": a new
  entry carries a new ceiling.
- **Unreadable is refused, not passed.** A missing baseline, a deletion, or
  unparseable JSON at either end is out of class. A guard that cannot compare the
  enforcing fields must assume they moved; do not add a fallback that treats an
  unreadable document as unchanged.
- **The check is proved by mutation, not by a green suite.** The self-tests in
  `gates.test.mjs` drive the check to fail on each forbidden edit — a moved
  ceiling, a widened tolerance, a moved `jsMaxRaw`, a moved `globals` ceiling, a
  combined permitted-plus-forbidden edit, malformed JSON, and a structural
  add/remove — and to pass on a measurement-only re-record. A change that makes
  the check pass unconditionally would leave those failing tests red; do not
  weaken them to green it.
- **This widening is confined to `web/asset-budgets.json`.** The content-aware
  check is scoped to that one path. No other file is parsed by `gate-scope.mjs`,
  and admitting another file's contents to the class is a separate decision.
