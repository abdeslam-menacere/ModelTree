# Agent skills

Five skills that keep ModelTree's data current. Copilot loads them from this
directory; you invoke them by describing what you want, not by naming a file.

```
refresh ModelTree data
```

That one line runs everything below. The same set also runs daily as a
scheduled automation.

| Skill | Does |
|---|---|
| [`modeltree-refresh`](modeltree-refresh/SKILL.md) | Orchestrates the whole loop and owns what happens between stages |
| [`modeltree-scout`](modeltree-scout/SKILL.md) | Researches creators from primary sources and produces claims with quoted evidence |
| [`modeltree-review`](modeltree-review/SKILL.md) | Judges each claim with three independent rubrics — 2-of-3 for a reviewed creator, unanimous for a long-tail one |
| [`modeltree-gates`](modeltree-gates/SKILL.md) | Deterministic checks that no majority can outvote |
| [`modeltree-publish`](modeltree-publish/SKILL.md) | Applies what survived, opens the pull request, merges, deploys, and reports |

Each is usable alone. `modeltree-gates` in particular is worth running by hand
against any data change, agent-authored or not:

```bash
node .github/skills/modeltree-gates/scripts/gate-dataset.mjs
```

## The shape of it

```
scout  ->  review  ->  gates  ->  publish  ->  Pages
           3 agents    scripts   auto-merge
```

Two ideas carry the design.

**Agents review; scripts decide.** The three reviewers are semantic — they can
tell that a release date is plausible, that a quote supports the claim it is
attached to, that a lineage edge matches how the creator describes it. They can
also all be wrong in the same way, because they are instances of the same model
reading the same page. So the deterministic gates run *after* the vote and
cannot be outvoted by it. A unanimous panel does not get to publish a URL with
credentials in it.

**Evidence is fetched, never recalled.** A claim must carry the URL, a SHA-256 of
the page as fetched, the fetch date, and a verbatim quote long enough to be
checked. Search snippets are refused outright. This is the rule that separates
this pipeline from a model writing down what it remembers about GPT-5.

And the corollary that makes it worth anything: **a run never approves its own
source.** `sources.json` is one of the documents a refresh may patch, so "cite a
source" is not a constraint until something says which sources may be cited.
`gate-source-approval.mjs` anchors that on the committed dataset and the reviewed
profile catalogues — neither of which the run can write, read at the merge base
with published `main`, which the run cannot move — so a source invented by a run
and cited by the same run is refused however the panel voted, and whether or not
the run commits it first.

## What it is allowed to change

Only the nine JSON documents that `web/src/data/raw.ts` composes.
`gate-scope.mjs` enforces that against the actual diff, and one file outside the
list disqualifies the entire change. A refresh that needs a schema change, a
component change, or a workflow change stops and files an issue instead — which
is the correct outcome, not a failure.

## Why it can merge without a human

[ADR 0003](../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md). Read
it before changing a threshold, a gate, or the qualifying class. It states the
residual risk plainly: the gates catch data that is malformed, impossible, or
unreferenced, and they do not catch a claim that is well-formed and simply wrong.
The reviewers are the only defence there, and the revert is the last one.

`main` is protected and requires the `web-ci` check, so GitHub — not a prompt —
is what refuses to merge a red pull request.

## Changing a gate

The gates have a self-test suite. Run it:

```bash
node --test .github/skills/modeltree-gates/scripts/gates.test.mjs
```

The run reports its own totals, so no count is repeated here to go stale — one
was, and it did (abdeslam-menacere/ModelTree#276). Every rule is proved to fire
by breaking real data in exactly the way that rule exists to catch, and the live
dataset is asserted to pass. A gate change without a test change is a gate change
nobody verified.

## Related

- [`../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md`](../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md) — the authorising decision
- [`modeltree-gates/reference/claim-bundle.md`](modeltree-gates/reference/claim-bundle.md) — the interface all five skills share
- [`../../tools/updater/`](../../tools/updater/README.md) — the separate Python subsystem that only *proposes* changes. These skills do not use it and never modify it.
