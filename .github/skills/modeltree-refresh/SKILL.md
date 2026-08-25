---
name: modeltree-refresh
description: Refresh all ModelTree data end to end from one instruction - research every creator from primary sources, review each claim with an independent three-rubric panel, apply deterministic hard gates, open a pull request that auto-merges, and deploy the site. Use for "refresh ModelTree data", "update the model data", "check for new model releases", or any scheduled ModelTree data update.
---

# ModelTree refresh

One instruction, four stages, a published site at the end.

```
scout  ->  review  ->  gates  ->  publish
```

Each stage is its own skill and can be run alone; this one runs the whole loop
and owns what happens between stages.

**This publishes to production without a human approving it.** ADR 0003
authorises that, defines exactly which changes qualify, and is honest about what
it costs. Read it before changing anything here:
[`../../../docs/adr/0003-unattended-data-refresh-may-auto-merge.md`](../../../docs/adr/0003-unattended-data-refresh-may-auto-merge.md).

## Run it

```
refresh ModelTree data
```

Scope defaults to every creator in `web/src/data/organizations.json` plus the
long-tail profile. `refresh ModelTree data for meta` narrows it to one.

## Stages

### 0. Preflight

- Confirm you are in a ModelTree checkout, on a clean tree, and `gh auth status`
  is good.
- Mint a run id: `YYYY-MM-DD-<6 hex>`. Create
  `.modeltree-refresh/runs/<run-id>/`. It is git-ignored; nothing in it is
  repository data.
- Check no open pull request from a previous refresh is still unmerged. If one
  is, stop and say so — two refreshes racing on the same files is how you get a
  conflict nobody is awake to resolve.

### 1. Scout — `modeltree-scout`

One bundle per creator. Fetch real pages, hash them, quote them verbatim. Search
snippets are never evidence. One creator failing does not stop the others; record
it in `incomplete` and continue.

### 2. Review — `modeltree-review`

Three sub-agents per claim, in parallel, blind to each other and to the scout's
reasoning. 2-of-3 for a pilot creator, unanimous for a long-tail one. Every
verdict carries a rationale, and every rationale is published.

### 3. Gates — `modeltree-gates`

Deterministic, and they run **after** review so no majority can outvote them:

```bash
node .github/skills/modeltree-gates/scripts/gate-evidence.mjs --claims <bundle> --json
# apply accepted claims to web/src/data
node .github/skills/modeltree-gates/scripts/gate-dataset.mjs --json
cd web && npm run validate
node .github/skills/modeltree-gates/scripts/gate-scope.mjs --json
```

Exit 2 is a failure, never a pass. A gate that could not run has not run.

### 4. Publish — `modeltree-publish`

Branch, conventional commits, pull request carrying the full evidence trail,
`gh pr merge --auto --squash`. GitHub refuses to merge until `web-ci` is green.
Merging `main` triggers `pages.yml`, which deploys the site.

### 5. Confirm and report

Wait for the Pages deploy. **If it failed, revert** — a red `main` freezes the
published site on its previous build rather than breaking it, which is the worst
available failure mode for a project whose whole point is being current.

Then file the summary issue. Every run files one. A run that changed nothing
files its summary and closes it immediately.

## Non-negotiable

- **Only dataset documents may change.** The nine JSON files that
  `web/src/data/raw.ts` composes, and nothing else. One file outside that list
  disqualifies the whole change — `gate-scope.mjs` enforces it mechanically.
  A refresh needing a schema, component, or workflow change stops and files an
  issue.
- **No bypass, ever.** No `--force`, no skipped gate, no lowered threshold, no
  `gh pr merge --admin`, no direct push to `main`. If a gate blocks the run, the
  gate has done its job.
- **Never touch `tools/updater/`.** It is #59's proposal-only subsystem, read-only
  here. Its profiles are input; its code is out of scope.
- **Never edit a claim to make it pass a gate.**
- **Unknown stays unknown.** A guessed field is worse than an empty one because
  it looks like knowledge.
- **No composite score, rank, or "best model" claim** — in data or in prose.
- **Creator, model, product, and serving platform stay four separate entities.**

## When to stop instead of finishing

Stop, publish nothing, and report — these are correct outcomes, not failures:

- a previous refresh's pull request is still open;
- the change leaves the qualifying class;
- `npm run validate` fails on something you did not introduce, so `main` was
  already red;
- `gh` is not authenticated, or the network is unreachable;
- every claim was rejected, and there is nothing to publish.

## What this run cannot catch

Worth holding in mind rather than trusting the pipeline's green:

The gates catch malformed, impossible, unreferenced, and boundary-violating data.
They do not catch a well-formed claim that is simply **wrong**. `web-ci` catches
schema and test failures; a plausible wrong date sails through it. The three
reviewers are the only defence against wrong-but-valid, and they share a failure
mode — three instances of the same model family reading the same page. A source
that is itself wrong can carry all three.

So the last real brake is the revert, and it is after the fact. That residual is
accepted in ADR 0003 rather than hidden, and it is why the summary issue and the
pull request body carry every quote and every rationale: when something wrong
does publish, the record has to be good enough to find out why.
