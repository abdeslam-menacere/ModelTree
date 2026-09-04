---
name: modeltree-gates
description: Run ModelTree's deterministic hard gates over a refresh run - claim evidence, review majorities, dataset coherence, and the ADR 0003 qualifying class. Use after semantic review and before any dataset change is committed, or on its own to check that the current dataset is still coherent.
---

# ModelTree deterministic gates

These gates are mechanical. No model, no judgement, no vote. They run **after**
semantic review and **cannot be outvoted by it** — that ordering is the whole
point, and ADR 0003 forbids reversing it.

Six scripts, all dependency-free Node, all safe to run at any time:

| Script | Question it answers |
|---|---|
| `scripts/gate-evidence.mjs` | Was this claim actually established? |
| `scripts/gate-source-approval.mjs` | Did anyone approve the source it rests on? |
| `scripts/gate-dataset.mjs` | Is the resulting dataset coherent? |
| `scripts/gate-scope.mjs` | Is this change even allowed to auto-merge? |
| `scripts/gate-ledger.mjs` | Does the run's own record of itself match what it did? |
| `scripts/gate-reversals.mjs` | Is a claim the panel rejected back in the dataset without anyone saying so? |

Exit codes are uniform: **0** passed, **1** a gate failed, **2** the gate could
not run. Treat 2 as a failure. A gate that could not run has not passed, and the
one thing that must never happen here is a broken checker reading as a green one.

## Running them

**How to invoke what follows.** Commands here are written by name — what to run,
not the form your shell resolves. Sequence steps with `;`, never `&&`: Windows
PowerShell 5.1 rejects `&&` as a *parse* error, which discards the whole block
rather than the one line and blames a token instead of naming a tool, while `;`
separates statements in PowerShell, bash and zsh alike. And `npm` may not be the
form that runs: on Windows npm installs a `.cmd` shim and a PowerShell one side
by side, and which of them your shell resolves — and whether it is allowed to
run — are facts about your machine, not about this document. Where no `.cmd`
shim exists the bare name is the only form, so `npm.cmd --version` failing there
is expected and means nothing on its own. Run both, use whichever printed a
version, and read a refusal as installed-and-blocked rather than missing — a
fact about the execution policy, not a licence to change one.

From the repository root:

```bash
# 1. Are the claims admissible? Run this before touching web/src/data.
node .github/skills/modeltree-gates/scripts/gate-evidence.mjs --claims .modeltree-refresh/runs/<run-id>/claims.json --json

# 2. Does every claim rest on a source somebody already approved? Also before
#    touching web/src/data - it reads the committed dataset as its anchor.
node .github/skills/modeltree-gates/scripts/gate-source-approval.mjs --claims .modeltree-refresh/runs/<run-id>/claims.json --json

# 3. Is the dataset coherent? Run this after applying accepted claims.
node .github/skills/modeltree-gates/scripts/gate-dataset.mjs --json

# 4. Does the change qualify to auto-merge? Run this before opening the PR.
node .github/skills/modeltree-gates/scripts/gate-scope.mjs --json

# 5. Does the run's ledger entry match the change it describes? Run this after
#    writing the entry, before opening the PR.
node .github/skills/modeltree-gates/scripts/gate-ledger.mjs --json

# 5b. Is the ledger complete over everything published so far? No bundle needed;
#     safe to run at any time, and skills-ci runs it on every pull request.
node .github/skills/modeltree-gates/scripts/gate-ledger.mjs --history --json

# 6. Is a claim this ledger records as rejected sitting in the dataset with
#    nothing saying who put it back? No bundle needed; safe at any time, and
#    skills-ci runs it on every pull request that touches web/src/data/.
node .github/skills/modeltree-gates/scripts/gate-reversals.mjs --json
```

Keep the JSON from step 2. Its `anchor`, `anchors`, `inheritedSources`, and
`proposedSources` are what the pull request body has to carry, and they are the
only place a later reader can see which origins the run was allowed to trust —
and, in `anchor.selectedBy`, that the run did not pick that anchor for itself.

Then the final hard gate, which is not in this skill because it belongs to the
site and always has. From `web/`:

```bash
npm run validate
```

That runs vitest plus `astro check`, which parses the dataset through the Zod
contracts in `web/src/data/schema.ts`. The schema is the last word. If these
scripts and Zod ever disagree, Zod wins and the script is wrong.

### And that is not the whole verification set

`npm run validate` reads `web/`. It never reads this directory, so a change to
these documents or these scripts can pass every command above and still turn CI
red once it merges. That is not hypothetical: on
abdeslam-menacere/ModelTree#441 / PR abdeslam-menacere/ModelTree#558 both dock
gates passed at `6925d5a`, having run exactly the commands above, and the merge
reddened `instruction-references` and both `pytest` legs over one bare issue
citation in this file. Neither gate was careless; nothing local invoked those
checks at all (abdeslam-menacere/ModelTree#560).

So before opening a pull request, from the repository root:

```bash
node .github/scripts/ci-preflight.mjs
```

It works out which of the repository's pull-request checks this branch's diff
triggers — measured from `git merge-base HEAD refs/remotes/origin/main`, the
same anchor `gate-scope` and `gate-source-approval` use — and runs their
commands locally. A change under `.github/skills/` selects `skills-ci`,
`instruction-references` and the updater `pytest` suite, which are the checks
the break above needed and which no command in this file invokes.

Exit codes match the gates: **0** passed, **1** a check failed, **2** a check
could not run. `--plan` prints what it would run without running anything and
exits **2**, because a plan verifies nothing. A run that selects no check at all
exits **2** as well and says `NOTHING SELECTED`, because a run in which nothing
executed has verified nothing either — the zero is reserved for a check that
actually ran and actually passed.

Every run prints what it does **not** cover — the networked `source-link-health`
sweep, the second Python interpreter of the `pytest` matrix, the runner itself,
and branch protection. Read that list before reading a green preflight as a
green CI; treating it as complete is the same mistake, one level up.

## What each gate refuses

**`gate-evidence.mjs`** reads a claim bundle (contract:
[`reference/claim-bundle.md`](reference/claim-bundle.md)) and refuses:

- evidence whose `retrieval` is anything but `fetch`. **A search snippet is
  never evidence.** This is the single most important rule in the file — it is
  the mechanical form of the source policy, so it holds when nobody remembers it;
- evidence with no well-formed `sha256:` content hash, no real `fetchedAt`, or a
  quote too short to show the source stating the claim. The gate checks the
  **form** of the hash and quote, never that they match the remote page — it
  fetches nothing, so both are self-authored by the run and unverified against
  their source. That accepted limit and what compensates for it are recorded in
  ADR 0005;
- a review panel that is incomplete, that let one rubric vote twice, or that gave
  a verdict without a rationale;
- a change that did not reach its threshold — 2-of-3 for a pilot creator,
  **unanimous 3-of-3 for a long-tail creator**, per
  abdeslam-menacere/ModelTree#59 and ADR 0002;
- a claim that changes nothing, names no field, or targets a file that is not a
  dataset document.

`unchanged` and `conflict` findings need full evidence but no majority. They
apply nothing; they are published in the summary as findings.

Which threshold applies is derived from the reviewed-profile set on disk
(`tools/updater/profiles`), never from the bundle's own `policy`. That set is
read under the same rules `tools/updater`'s `ProfileLibrary` applies to the same
directory, so the gate refuses a profile whose `creator.id` is padded, two
profiles declaring one id, and a filename that differs from `.json` only in case.
The last is a **refusal, not a skip**, on purpose: `profile.JSON` is one file
beside its lowercase twin on Windows and two files on the Linux CI runs, so
skipping it lets the same repository classify the same creator differently on the
two platforms (abdeslam-menacere/ModelTree#246). Refusing is the only answer that
is the same on both. Every one of these refusals exits 2 — an unreadable or
malformed reviewed set never falls back to the looser bar.

**`gate-source-approval.mjs`** is the approved-source binding — ADR 0003's
precondition 2, and the skill-set equivalent of `gates.py`'s `source-approval`.
It reads the same bundle and refuses:

- a claim resting on a source that is neither in the committed dataset nor
  proposed by this bundle, so nothing ever approved it;
- a source this run proposes on an **origin** (scheme + host) that no reviewed
  profile catalogue and no source already in the dataset stands behind — whatever
  the panel voted;
- an existing source repointed at such an origin;
- evidence read from one origin and filed under a source that is another;
- a bundle whose shape hides the answer: a claim that is not an object, a claim
  with no `evidence` array, or an evidence entry that is not an object. A missing
  `sourceId` already refuses, so silently skipping a missing `evidence` would
  make absence the most permissive input in a gate about what a run leaves out.
  An explicitly empty `evidence: []` is a different thing and is
  `gate-evidence.mjs`'s to judge.

Why it exists at all, given `gate-dataset.mjs` and `npm run validate` both check
citations: they check them *referentially*, and `sources.json` is a document the
run may patch. A run that adds a source record and cites it in the same change
satisfies referential integrity perfectly while citing something nobody approved.
Referential integrity proves the citation resolves; it cannot prove the thing
cited was ever trusted.

Both of its anchors are things the run cannot write, and **which commit they are
read at is not the run's choice either**. The dataset anchor is read from git,
never from the working tree — the working tree is what the run is about to write,
so reading the file on disk would let a run apply its own patch and then be
approved by it. But `sources.json` is a file the refresh *is* allowed to patch,
so reading it from git is only safe at a commit the run did not author: the gate
computes that itself as `git merge-base HEAD refs/remotes/origin/main`, the point
this branch left published history. Committing a source and then invoking the
gate moves `HEAD` but not the merge base, so commit-then-gate is refused exactly
as patch-then-gate is. The catalogue anchor is `tools/updater/profiles/**/*.json`,
which `gate-scope.mjs` forbids a refresh to touch at all.

`--base` is optional and can only **narrow**. It has to name an ancestor of that
merge base, so it can pin something older and reviewed — useful for re-gating an
older bundle — but can never select a commit this branch authored. Anything else,
`HEAD` included, exits 2. Do not reach for it in a normal run: the gate is
already anchored correctly without it. If `refs/remotes/origin/main` is missing,
as in a shallow or single-branch clone, the gate exits 2 rather than guessing;
fetch `main` first.

Trust attaches to an origin, not to a URL, exactly as `is_newly_discovered` does
on the Python side. `sources.json` holds one record per page, so a new
announcement page on a creator's own newsroom is the ordinary case and is
allowed; a source appearing on a host nobody ever stood behind is refused. A rule
phrased as "no new source record" would instead refuse the refresh its entire
purpose.

This is deliberately **stricter** than `gates.py`, which also approves a newly
discovered source on an unknown origin once the panel votes for it. Under ADR
0003 nobody sees the merge, so a run's own panel approving a source the same run
introduced is the run approving itself. Extending the trust boundary to a new
host therefore stays a human act: add it to a profile catalogue, or cite it in a
change that takes the ordinary path. ADR 0003 permits the publishing path to be
stricter and forbids it being more permissive, so this is a finding to raise
against `tools/updater/` rather than drift that stops the automation.

**`gate-dataset.mjs`** reads `web/src/data/` and refuses malformed documents,
ids that are not kebab-case or repeat within a collection, references that do not
resolve, a family that no release belongs to, a collection standing empty that
`web/src/data/schema.ts` floors at one or more records, a family or release
`status` outside the `lifecycleStatus` vocabulary that file declares, lineage
that is self-referential or cyclic or contradicts itself, a release attributed
away from its family's owner, a publisher taking a creator's
id without being that creator's voice, dates that never existed, lie in the
future, or fall before 1950, a release predating its family or its own
predecessor, a source checked
before it was published, non-https or credential-bearing URLs, a fact with no
`sourceIds` or no `verifiedAt`, and any field whose name reads as a ranking or
composite score.

Two of those rules are *derived* from `web/src/data/schema.ts` at run time rather
than restated in the script: which collections are floored, and which lifecycle
states exist. Both are reported in `--json` — as `requiredCollections` and
`lifecycleStatus` — so a reader can see which rule was actually in force instead
of inferring it from a passing run, and a schema the gate cannot read either of
them out of is exit 2, never a pass. Deriving them is what makes "the schema is
the last word" true of this script rather than merely asserted by it: a
hand-copied vocabulary that drifted would reintroduce
abdeslam-menacere/ModelTree#761, where this gate reported `"passed": true` over a
`status` Zod rejected outright.

Which documents it reads is the ADR 0003 qualifying class itself, minus the one
document that class holds which is not part of the dataset. `gate-scope.mjs`
owns that class in `ALLOWED_PATHS`; every path in it is a document this gate
loads, except `web/src/data/refresh-runs.json`, which
`web/src/data/raw.ts` does not compose, `web/src/data/schema.ts` does not
declare, and `gate-ledger.mjs` covers on its own terms instead. That relation is
an assertion in the gates' own suite rather than a convention, and it fails in
every direction: a path added to either list alone, or dropped from either list
alone, turns it red. It was a hole before
abdeslam-menacere/ModelTree#495 — six documents sat inside the auto-mergeable
class with no coherence gate reading them, so a refresh could put a dangling
reference or an unsourced fact on `main` unattended, and the ranking rule, the
evidence rule and the reference rule all simply never saw the file.

The ranking rule carries one bounded admission, and it is narrower than an
exemption rather than a hole in the same shape. In `benchmarkResults` only, a
**top-level** `score` is admitted **iff** the record it sits on also carries a
string `benchmarkId` and a string `unit` — a number bound to one named
benchmark, in a stated unit, which is the evidence
`docs/product/PRODUCT-BRIEF.md` asks for by name. Everything a plain exemption
would have admitted is still refused, out loud and with its own message: a
`score` with either half of the binding missing, a `score` nested anywhere below
the record, an `overallScore` or `compositeScore` or `rank` or `tier` beside it,
and a `score` in any other collection however many binding fields are spelled
next to it. The binding is checked rather than asserted, because the same change
made `benchmarkId` a reference this gate resolves against `benchmarks.json`: a
score bound to a benchmark that does not exist fails twice.

`gates.py` has no ranking rule at all, so this adds no divergence to reconcile.
ADR 0003 records that absence deliberately and by name — abdeslam-menacere/ModelTree#67
is held on the proposal side by review and by ADR 0001's guardrail rather than by
a deterministic check — and it classes a stricter publishing path as a finding to
raise against `tools/updater/`, never as a reason to stop, while forbidding the
reverse. A narrower admission on the stricter side leaves that ordering intact.
The ADR's own wording is the test the admission is written against: what it
refuses is "a composite or universal score", and a number bound to one named
benchmark in a stated unit is neither.

Which collections those floors cover is not written in the gate. It reads them
out of `datasetSchema` at run time and reports them as `requiredCollections`,
which is this rule applying the paragraph above to itself: the gate and the
schema disagreeing about which collections are load-bearing was the defect
(abdeslam-menacere/ModelTree#548), and a hand-kept list in the script would have
been a second place for that disagreement to reappear. A collection becomes
load-bearing by gaining `.min(1)` in the schema, once, with Zod and the gate
moving together; the collections declared `.default([])` may be empty, which is
why `usage-syntheses.json` holding no records is not a defect. A schema the gate
cannot read, cannot parse, or that floors a collection it does not load is exit
2 rather than a pass.

"Cannot read" is judged per qualifier and not only per field. The gate
understands `.min(<digits>)` and `.default([])` written with any spacing, because
Zod makes nothing of the spacing either, and refuses any other qualifier — a
`.nonempty()`, or a `.min()` whose argument is a named constant it would have to
execute TypeScript to evaluate — by name and out loud. Reading an unrecognised
qualifier as "no floor here" would instead drop that one collection's floor and
keep the others, and the gate would then pass a dataset Zod refuses:
abdeslam-menacere/ModelTree#548 again, reached through a reformatting rather than
through a hand-kept list. Losing *every* floor already threw, which is precisely
why losing *some* went unnoticed.

`gates.py` cannot express this rule and is not expected to. It gates claim and
source candidates within a single creator's run and never loads the composed
dataset, so it has no collection to measure; the floor is a property of the
assembled documents, which only this gate and Zod ever see. That is a gap in
reach rather than the permissive divergence ADR 0003 stops the automation for.

Its date rules and `gates.py`'s stand in three different relations to each other,
and flattening them into "parity" would be its own defect, so read them
separately.

- **The 1950 floor now matches.** `EARLIEST_YEAR = 1950` was enforced only on
  the Python side until abdeslam-menacere/ModelTree#488 added it here, and a
  floor present there and missing here was the *permissive* direction — the one
  ADR 0003 stops the automation for, with no grandfathering for a gap that
  predates adoption. It is applied to the **year segment**, so a partial date is
  judged by its year alone; `gates.py` reaches the same verdict by expanding a
  partial value to its earliest possible day purely to read the year.
- **The future-date rule does not match, and is not meant to.** This gate
  refuses any date past the day it runs; `gates.py` allows a release date up to
  `MAX_YEARS_AHEAD` years ahead, on the reasoning that a preview can be
  announced before it ships. That is the publishing path being *stricter*, which
  the ADR permits, so it is a finding to raise against `tools/updater/` rather
  than drift that stops a run — the same disposition the source-approval
  difference above has.
- **The unregistered fields are neither.** `validation.py` registers only some
  of the date fields this gate checks; `lastCheckedDate`, `publishedDate`,
  `effectiveTo`, `windowStart`, `windowEnd` and `evaluationDate` were outside
  what it proposes at all when abdeslam-menacere/ModelTree#488 measured it. A
  field the updater never proposes is outside its scope, not governed by a
  stricter rule there, so registering those fields to "close" the difference
  would invent a divergence rather than close one.

The empty-family rule runs family → release, the opposite direction from every
other `familyId` check in that file, and it exists because the direction was the
gap: a family nothing pointed at was unreachable by the gate rather than merely
unchecked, and `web/src/lib/model-tree.ts` dropped such a family from `/tree/`
while the homepage still counted it and rendered it as an empty branch, so the
published tree went quietly smaller than the dataset while every check stayed
green (abdeslam-menacere/ModelTree#441). Since
abdeslam-menacere/ModelTree#554 the web build refuses an empty family outright
in `validateDataset`, so that divergence is history and this rule is now the
earlier of two independent refusals — keep it, because it names every offending
family while the change is still a claim bundle, before the build is reached.
It **refuses** rather than
rendering the family with an empty state, and the reason is recorded in full
above the rule itself: `lifecycleStatus` has no `announced`/`upcoming` member,
so the dataset cannot distinguish a family deliberately awaiting its first
release from a data error, and rendering the empty case would publish the error
as though it were an announcement. If that vocabulary is ever added
deliberately, revisit the rule with it.

Two things it deliberately does **not** check, so you do not assume coverage that
is not there. Ids may be shared across collections: a single-release family and
its release share a name, and a publisher that is a creator's official voice
takes that creator's id. Both are meaningful rather than accidental. And it does
not check that a source *still says* what it said — that is the scout's job on
the next run, and the gate has no network.

**`gate-scope.mjs`** enforces the ADR 0003 qualifying class: every changed path
must be one of the dataset documents that `web/src/data/raw.ts` composes, plus
`web/src/data/refresh-runs.json`, which ADR 0006 added so a run can record itself
in the pull request it publishes. The list lives in the script's `ALLOWED_PATHS`
and a self-test holds it to `raw.ts` import for import, so this document does not
restate its length and cannot go stale about it. One file outside that list
disqualifies the whole change — there is no partial case and no flag that relaxes
it. It sees untracked files too, so a new file cannot slip past by never being
added.

One member of the class is admitted conditionally rather than by path alone:
`web/asset-budgets.json`, under ADR 0015. A refresh that adds a normal data
tranche moves a page past the 2% `measuredDrift` guard, and the only fix is to
re-run `npm run assets:report` and re-record the measured figure in that file —
so the party that moved the number must be able to re-record it. But the same
file also holds the enforced ceilings (`criticalMaxRaw`, `jsMaxRaw`, the
whole-build `*MaxRaw`) and the drift guard itself (`measuredDrift.maxFraction`),
and admitting the path wholesale would let an unattended run raise its own
ceiling or widen the guard that caught it and auto-merge — a self-approving
performance guard. So this is the gate's one content-aware check: it reads the
document at the merge base and compares it against both states that could reach
`main` — the committed tip `HEAD`, which is what auto-merges, and the working
tree — admitting the change only when every difference at both ends lands in a
regenerable measurement figure or non-enforcing prose. Reading `HEAD` and not
only the disk is deliberate: a ceiling raised in a commit and reverted on disk
still merges on `HEAD`, so a disk-only read would be a fail-open. Any move to a
ceiling or the tolerance, any structural change such as adding or removing a
route entry, and anything it cannot read — a `HEAD` or working-tree deletion,
JSON that will not parse, or the file appearing with no baseline at the anchor —
is refused, so a permitted re-record can never launder a forbidden ceiling raise
riding alongside it.

It measures that change from a commit **it computes rather than one you pass**:
`git merge-base HEAD refs/remotes/origin/main`, the point this branch left
published history. Everything committed since that point and everything still in
the working tree is judged together, so gating before you commit and gating after
give the same verdict, and the bare invocation above is correct at either moment.
`--base` may only *narrow* to an ancestor of that merge base — useful for
re-gating an older bundle, refused with exit 2 for anything this branch authored,
`HEAD` included. This is the same anchor, resolved the same way, as
`gate-source-approval.mjs`; if you change one, change both.

Exit 0 therefore has two readings and they are not the same claim: every changed
path is a dataset document, **or** there was no change to judge. `--json` reports
`changed` and `empty` so a caller can tell them apart. An anchor that cannot be
resolved — no `refs/remotes/origin/main` in a shallow or single-branch clone, or
a `HEAD` sharing no history with it — is exit 2, never a pass. A stale
`refs/remotes/origin/main` only moves the anchor backwards, which widens the diff
and can only add refusals.

A refresh that trips this gate has not failed. It has correctly discovered work
for a human: stop, and file an issue describing what it needed and why.

**`gate-ledger.mjs`** is what pays for the widening above. Admitting
`refresh-runs.json` to the qualifying class lets a run publish a report card
about itself, so this gate reads that report against the change it describes
rather than against itself. Six rules: the documents the entry names must be
exactly the dataset documents the branch changed, in both directions; every
`recordsBefore` and `recordsAfter` is **counted** at the anchor and in the working
tree rather than believed; a branch adds at most one entry, so a bad run stays one
revert; a commit whose subject declares `(run <id>)` must have an entry for that id
that *this branch adds*, so a reused id cannot be satisfied by an entry that was
already there; a change confined to the qualifying class must add an entry at all,
because that is the shape that merges with nobody watching and writing nothing was
otherwise the cheapest way through; and the ledger is append-only, because every
other rule reasons about what was *added* and so a deletion paired with an equal
addition nets out and is invisible to all of them.

That fifth rule is keyed on the diff's shape rather than on the `(run <id>)`
marker, and the difference matters: the marker is written by the run, so a run that
omitted both the marker and the entry would satisfy a marker-triggered rule by
staying silent. The shape of a diff measured from a merge-base is the one thing a
run cannot talk its way out of. The cost is that it cannot tell a hand edit
confined to the dataset documents from a refresh — 7 of the last 250 commits are
that shape, and roughly four of them are hand edits. Those are asked for an entry
they should not have to write. It is accepted rather than solved: branch mode does
not run in CI, so it never blocks such a pull request, and the alternative is
letting absence be the more permissive option in the one gate added to stop exactly
that.

It anchors exactly as `gate-scope.mjs` does, and a self-test asserts the two
resolve the same commit and agree on what a dataset document is — if they drift,
one is enforcing a class the other is not.

What it does not check is the part no gate can: whether the run's prose is honest,
whether `pagesFetched` is right, whether a derived reviewer count means anything.
Those belong in `caveats`, and the schema's job — not this gate's — is to require
a published run to carry its pull request reference.

Two modes. Bare, it checks the branch as above. `--history [<ref>]` asks the
different question that abdeslam-menacere/ModelTree#419 was filed about: does the
ledger record every run that published history declares? That is the completeness
check, it needs no bundle, and `skills-ci` runs it on every pull request as
`--history HEAD`.

An entry added on a branch that changed no dataset document is a **transcription**
— it describes work already published, so there is no diff here to reconcile it
against. The gate accepts it and reports `transcription: true`, saying plainly
that the numbers went unchecked. That is the shape of a correction to a historical
entry. It is *not* an acceptable shape for a run that is publishing data: there,
`transcription: true` means the entry and its data got separated and belong in one
commit.

Transcription relaxes the reconciliation rules and the no-rewriting half of the
append-only rule, because editing a historical entry in place is exactly what a
correction is. It never relaxes the no-deletion half. A branch may repair what an
entry says; no branch may make a published run disappear from the page, whatever
it says it is doing.

---

**`gate-reversals.mjs`** reads `refresh-runs.json` and the dataset **together**,
which is the thing nothing did before abdeslam-menacere/ModelTree#835. Every
`withheld[]` entry with category `rejected-by-panel` is a claim the automated
panel refused. That refusal is permanent — the ledger is append-only — but the
record it refused can arrive later by the ordinary reviewed pull-request path,
which is a route the panel does not police. When it does, two committed
documents disagree and, until this gate, nothing read them together. Nine such
reversals were visible to this gate's extractor by the time anyone counted.

**Nine is a floor, not a population.** The record id is read out of the entry's
`detail` prose, and only 18 of the 62 `rejected-by-panel` entries write it in a
form the gate will act on. Of the other 44, measured at trunk `ca67bc10` with a
fabricated-id control in the same pass: 10 are `releases/<id>.verifiedAt` field
re-verifications of records that were already present, which are correctly not
reversals and must stay excluded from any future widening; **17 name a record
that is in `web/src/data/` today and unannotated**; and 17 name a record that is
absent. The gate does not act on those 17, and deliberately was not widened to:
presence is not reversal — sampled records entered the dataset the same day as
the run that refused them, so arrival order does not follow from the ledger.
Making them checkable means giving withheld entries a machine-readable record id
when a run writes them, which is its own reviewed change. Until then this is a
known, quantified gap, printed on every passing run.

The gate refuses a `rejected-by-panel` record that is in `web/src/data/` today
with no entry in `web/src/data/rejection-reversals.json` naming which change
brought it back and what became of each objection.

**Read what it verifies precisely, because the temptation is to read more.** It
verifies that a reversal is *written down*. It does not verify that the
objections were well answered, and it cannot: that is a judgement about
evidence, which is a reviewer's to make and a script's to stay out of. So a
green run here means the reversal is visible and reviewable, never that it was
right.

That is also why `unanswered` is a first-class `disposition` beside `answered`
and `overruled`. A gate that only accepted a resolution would be a gate that
rewarded inventing one, and a fabricated resolution is a worse outcome than the
silence the gate was written to end. Recording an objection as still open is not
free either — it obliges the entry to say what *would* answer it.

Two properties are deliberately absent. It does not resolve `landedVia`:
checking that a pull request reference is real is a network call, and a gate
that needs one cannot run where these run — so that field is a claim a reader
can check, not one the gate has. And it records no `who`, because every session
in this repository commits and comments as the same account, so a required field
for it would be filled with a guess. *Which change* is answerable; *whose hand*
is not.

Its blind spot is measured and printed on the passing path rather than left for
a reader to discover: the record id is only available where the panel's `detail`
prose opens with the structured `<collection> record <id>` form, which most
rejections do not. The pass line says how many rejections it could not read, and
says that not checked is not passed.

`rejection-reversals.json` sits **outside** the ADR 0003 qualifying class, and
that is load-bearing rather than incidental: a refresh run that tried to write
its own absolution would leave the class and forfeit auto-merge. Only a
human-reviewed change can record a reversal.

## Verifying the gates themselves

```bash
node --test .github/skills/modeltree-gates/scripts/gates.test.mjs
```

The run reports its own totals, so no count is repeated here to go stale — one
was, and it did (abdeslam-menacere/ModelTree#276). Every rule is proved to fire
by breaking the data in exactly the way that rule exists to catch, and the live
repository dataset is asserted to pass — so the suite fails both when a gate goes
blind and when a gate goes paranoid.
One test is a deliberate exception: it characterises the accepted limit of ADR
0005 — that `gate-evidence` checks the form of a citation, not its remote content
— by pinning that a well-formed but fabricated hash and quote pass.
The `gate-source-approval` cases build a throwaway git repository with its own
published `refs/remotes/origin/main`, because the anchor is defined against
published history and a CI checkout does not always have that ref; the dataset
they anchor on is the real one, copied in. Run it after any change to these
scripts.

## Rules

- **No gate input self-reported by the subject may have a default, and absence
  must never be the more permissive option.** When you write or change a gate,
  every input the run itself supplies — a bundle field, a flag it passes — must
  refuse absence explicitly, with the **same exit 2** it gives an unrecognised
  value, and must never let an omitted input select the looser threshold or the
  weaker anchor. Making the input *required* does not discharge this: a required
  flag is still supplied by the party under test. Where the value is derivable,
  derive it — `gate-scope` and `gate-source-approval` anchor on `git merge-base
  HEAD refs/remotes/origin/main`, never on a `--base` the run chooses. This does
  **not** forbid a default that is an environment fact (`--today` from the wall
  clock, `--data`/`--repo` from the canonical committed location) or one that
  resolves to a stricter derived value (an absent `--base` resolving to that
  merge base, which an explicit `--base` may only narrow). ADR 0003's Guardrails
  is the authoritative statement and the reasoning; this is the version you meet
  before writing the next gate.
- **Never add a bypass.** No `--force`, no `--skip`, no environment variable that
  lowers a threshold, no "the gate was flaky" retry that proceeds without it.
  ADR 0003 and `.github/copilot-instructions.md` both forbid it. A genuine
  exception belongs in branch protection, where it is auditable.
- **Never run these before review.** A deterministic gate that runs first becomes
  something reviewers can argue with.
- **Never treat exit 2 as a pass.**
- These scripts duplicate rules that also exist in
  `tools/updater/src/modeltree_updater/gates.py`. That duplication is deliberate
  and recorded in ADR 0003 as an accepted cost. If you change a rule here, say in
  the pull request how it relates to the Python side.
