---
name: modeltree-gates
description: Run ModelTree's deterministic hard gates over a refresh run - claim evidence, review majorities, dataset coherence, and the ADR 0003 qualifying class. Use after semantic review and before any dataset change is committed, or on its own to check that the current dataset is still coherent.
---

# ModelTree deterministic gates

These gates are mechanical. No model, no judgement, no vote. They run **after**
semantic review and **cannot be outvoted by it** — that ordering is the whole
point, and ADR 0003 forbids reversing it.

Four scripts, all dependency-free Node, all safe to run at any time:

| Script | Question it answers |
|---|---|
| `scripts/gate-evidence.mjs` | Was this claim actually established? |
| `scripts/gate-source-approval.mjs` | Did anyone approve the source it rests on? |
| `scripts/gate-dataset.mjs` | Is the resulting dataset coherent? |
| `scripts/gate-scope.mjs` | Is this change even allowed to auto-merge? |

Exit codes are uniform: **0** passed, **1** a gate failed, **2** the gate could
not run. Treat 2 as a failure. A gate that could not run has not passed, and the
one thing that must never happen here is a broken checker reading as a green one.

## Running them

From the repository root:

```bash
# 1. Are the claims admissible? Run this before touching web/src/data.
node .github/skills/modeltree-gates/scripts/gate-evidence.mjs \
  --claims .modeltree-refresh/runs/<run-id>/claims.json --json

# 2. Does every claim rest on a source somebody already approved? Also before
#    touching web/src/data - it reads the committed dataset as its anchor.
node .github/skills/modeltree-gates/scripts/gate-source-approval.mjs \
  --claims .modeltree-refresh/runs/<run-id>/claims.json --json

# 3. Is the dataset coherent? Run this after applying accepted claims.
node .github/skills/modeltree-gates/scripts/gate-dataset.mjs --json

# 4. Does the change qualify to auto-merge? Run this before opening the PR.
node .github/skills/modeltree-gates/scripts/gate-scope.mjs --json
```

Keep the JSON from step 2. Its `anchor`, `anchors`, `inheritedSources`, and
`proposedSources` are what the pull request body has to carry, and they are the
only place a later reader can see which origins the run was allowed to trust —
and, in `anchor.selectedBy`, that the run did not pick that anchor for itself.

Then the final hard gate, which is not in this skill because it belongs to the
site and always has:

```bash
cd web && npm run validate
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
resolve, a family that no release belongs to, lineage that is self-referential or
cyclic or contradicts itself, a
release attributed away from its family's owner, a publisher taking a creator's
id without being that creator's voice, dates that never existed or lie in the
future, a release predating its family or its own predecessor, a source checked
before it was published, non-https or credential-bearing URLs, a fact with no
`sourceIds` or no `verifiedAt`, and any field whose name reads as a ranking or
composite score.

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
must be one of the nine dataset documents that `web/src/data/raw.ts` composes.
One file outside that list disqualifies the whole change — there is no partial
case and no flag that relaxes it. It sees untracked files too, so a new file
cannot slip past by never being added.

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
