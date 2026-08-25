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

Keep the JSON from step 2. Its `anchors`, `inheritedSources`, and
`proposedSources` are what the pull request body has to carry, and they are the
only place a later reader can see which origins the run was allowed to trust.

Then the final hard gate, which is not in this skill because it belongs to the
site and always has:

```bash
cd web && npm run validate
```

That runs vitest plus `astro check`, which parses the dataset through the Zod
contracts in `web/src/data/schema.ts`. The schema is the last word. If these
scripts and Zod ever disagree, Zod wins and the script is wrong.

## What each gate refuses

**`gate-evidence.mjs`** reads a claim bundle (contract:
[`reference/claim-bundle.md`](reference/claim-bundle.md)) and refuses:

- evidence whose `retrieval` is anything but `fetch`. **A search snippet is
  never evidence.** This is the single most important rule in the file — it is
  the mechanical form of the source policy, so it holds when nobody remembers it;
- evidence with no `sha256:` content hash of the page that was actually read, no
  real `fetchedAt`, or a quote too short to show the source stating the claim;
- a review panel that is incomplete, that let one rubric vote twice, or that gave
  a verdict without a rationale;
- a change that did not reach its threshold — 2-of-3 for a pilot creator,
  **unanimous 3-of-3 for a long-tail creator**, per #59 and ADR 0002;
- a claim that changes nothing, names no field, or targets a file that is not a
  dataset document.

`unchanged` and `conflict` findings need full evidence but no majority. They
apply nothing; they are published in the summary as findings.

**`gate-source-approval.mjs`** is the approved-source binding — ADR 0003's
precondition 2, and the skill-set equivalent of `gates.py`'s `source-approval`.
It reads the same bundle and refuses:

- a claim resting on a source that is neither in the committed dataset nor
  proposed by this bundle, so nothing ever approved it;
- a source this run proposes on an **origin** (scheme + host) that no reviewed
  profile catalogue and no source already in the dataset stands behind — whatever
  the panel voted;
- an existing source repointed at such an origin;
- evidence read from one origin and filed under a source that is another.

Why it exists at all, given `gate-dataset.mjs` and `npm run validate` both check
citations: they check them *referentially*, and `sources.json` is a document the
run may patch. A run that adds a source record and cites it in the same change
satisfies referential integrity perfectly while citing something nobody approved.
Referential integrity proves the citation resolves; it cannot prove the thing
cited was ever trusted.

Both of its anchors are things the run cannot write. The dataset anchor is read
from git at `--base` (default `HEAD`), never from the working tree — the working
tree is what the run is about to write, so reading the file on disk would let a
run apply its own patch and then be approved by it. The catalogue anchor is
`tools/updater/profiles/**/*.json`, which `gate-scope.mjs` forbids a refresh to
touch at all.

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
resolve, lineage that is self-referential or cyclic or contradicts itself, a
release attributed away from its family's owner, a publisher taking a creator's
id without being that creator's voice, dates that never existed or lie in the
future, a release predating its family or its own predecessor, a source checked
before it was published, non-https or credential-bearing URLs, a fact with no
`sourceIds` or no `verifiedAt`, and any field whose name reads as a ranking or
composite score.

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

A refresh that trips this gate has not failed. It has correctly discovered work
for a human: stop, and file an issue describing what it needed and why.

## Verifying the gates themselves

```bash
node --test .github/skills/modeltree-gates/scripts/gates.test.mjs
```

53 tests. Every rule is proved to fire by breaking the data in exactly the way
that rule exists to catch, and the live repository dataset is asserted to pass —
so the suite fails both when a gate goes blind and when a gate goes paranoid.
Run it after any change to these scripts.

## Rules

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
