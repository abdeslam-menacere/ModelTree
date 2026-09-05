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
[`../../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md`](../../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md).

## Run it

```
refresh ModelTree data
```

Scope defaults to every creator in `web/src/data/organizations.json` plus the
long-tail profile. `refresh ModelTree data for meta` narrows it to one.

## Choosing scope, and reporting what you skipped

Narrowing is permitted and often right — but a narrowed run must not let a
creator go silently unscouted, and must not report "we did not look" in the same
shape as "we looked and nothing had changed". That confusion is the
abdeslam-menacere/ModelTree#903 defect:
run `2026-09-04-3a907e` closed `no-change` having examined 3 of 44 creators, and
nothing downstream carried the difference, so a run that did not look was
indistinguishable from one that looked and found nothing — and the
indistinguishable one is green.

- **Weigh per-creator staleness, not only gap-signal strength.** Before
  narrowing, look at how long each creator has gone unscouted — the ledger's
  `found.bundles[].creator` across recent runs tells you. A creator last scouted
  long ago is a reason to sweep it *regardless* of whether a gap signal ranks it
  in. OpenAI went unscouted across the exact window GPT-6 launched precisely
  because staleness was not weighed.
- **The Hugging Face / gap signal cannot rank a closed-weight creator.** A
  creator that ships no open weights produces no Hub rows, so a scope chosen only
  from that signal will never *rank it into* a narrowed pass — even though a full
  sweep sees it fine. Do not let a signal that is structurally blind to a creator
  be the sole reason that creator is skipped.
- **Name the creators you did not scout, in `found.unswept`.** Each entry carries
  the creator, its `lastScouted` date if known, and why it was skipped this pass.
  This is a *different field* from a scouted-and-unchanged creator (a
  `found.bundles` entry with `claimsFound: 0`), and the schema refuses to list a
  creator as both. A run that narrows and leaves `found.unswept` empty is
  claiming it swept everyone; do not make that claim falsely.
- **A degraded discovery channel is a per-creator condition.** When a creator's
  catalogued `official-announcement` source fails to fetch — OpenAI's
  `openai.com/news/` has returned a persistent 403 — record it in
  `found.degradedChannels` against that creator, not only as one line in a flat
  fetch-failure list. A creator's primary feed going dark is a fact about that
  creator's discovery, and burying it hides which creator you can no longer hear
  from. Report the 403 honestly; do not scrape around it or spoof a user agent.

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

### 1. Scout — `modeltree-scout`

One bundle per creator. Fetch real pages, hash them, quote them verbatim. Search
snippets are never evidence. One creator failing does not stop the others; record
it in `incomplete` and continue.

### 2. Review — `modeltree-review`

Three sub-agents per claim, in parallel, blind to each other and to the scout's
reasoning. 2-of-3 for a pilot creator, unanimous for a long-tail one. Every
verdict carries a rationale, and every rationale is published.

### 3. Gates — `modeltree-gates`

Deterministic, and they run **after** review so no majority can outvote them.
From the repository root, except the one step marked as running from `web/`:

```bash
node .github/skills/modeltree-gates/scripts/gate-evidence.mjs --claims <bundle> --json
node .github/skills/modeltree-gates/scripts/gate-source-approval.mjs --claims <bundle> --json
# apply accepted claims to web/src/data
node .github/skills/modeltree-gates/scripts/gate-dataset.mjs --json
# the site's own gate, from web/:
npm run validate
# back at the repository root:
node .github/skills/modeltree-gates/scripts/gate-scope.mjs --json
# write the run's own ledger entry, then check it against the diff it describes
node .github/skills/modeltree-gates/scripts/gate-ledger.mjs --json
```

Both bundle gates run **before** anything is applied. `gate-source-approval.mjs`
anchors on the committed dataset, so running it after the patch would be asking
the run's own writes whether the run's own sources are trustworthy. Keep its JSON
— the pull request body has to carry it.

`gate-ledger.mjs` runs last, because it reads the finished change. Its
`transcription` field must be `false` for a publishing run: `true` means the entry
was written on a branch with no data change, so nothing verified it.

Exit 2 is a failure, never a pass. A gate that could not run has not run.

### 4. Publish — `modeltree-publish`

Branch, conventional commits, pull request carrying the full evidence trail,
`gh pr merge --auto --squash`. GitHub refuses to merge until `web-ci` is green.
Merging `main` triggers `pages.yml`, which deploys the site.

**The run's `/refresh` entry ships in that same commit**, and the commit subject
carries `(run <run-id>)`. It is not a follow-up step and not a human's to
remember: it was, for three published runs in a row, and it was missed all three
times (abdeslam-menacere/ModelTree#419). ADR 0006 put the ledger in the qualifying
class precisely so the run can record itself while auto-merging.

### 5. Confirm and report

Wait for the Pages deploy. **If it failed, revert** — a red `main` freezes the
published site on its previous build rather than breaking it, which is the worst
available failure mode for a project whose whole point is being current.

Then file the summary issue. Every run files one. A run that changed nothing
files its summary and closes it immediately.

## Non-negotiable

- **Only dataset documents may change.** The fifteen JSON files that
  `web/src/data/raw.ts` composes, plus the run's own ledger
  `web/src/data/refresh-runs.json`, and nothing else. One file outside that list
  disqualifies the whole change — `gate-scope.mjs` enforces it mechanically, and
  every path it admits is a document `gate-dataset.mjs` validates or the ledger
  `gate-ledger.mjs` covers instead.
  A refresh needing a schema, component, or workflow change stops and files an
  issue.
- **No bypass, ever.** No `--force`, no skipped gate, no lowered threshold, no
  `gh pr merge --admin`, no direct push to `main`. If a gate blocks the run, the
  gate has done its job.
- **Never touch `tools/updater/`.** It is the proposal-only subsystem from
  abdeslam-menacere/ModelTree#59, read-only here. Its profiles are input; its
  code is out of scope.
- **A run never approves its own source.** A claim may only rest on a source the
  dataset already carries, or on a new page of an origin a reviewed profile
  catalogue or the committed dataset already stands behind.
  `gate-source-approval.mjs` enforces it, and no panel majority overrides it.
  A genuinely new publisher is work for a human: propose it as an ordinary
  change, not as part of a refresh.
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
