# ADR 0003: One Class of Change May Publish Itself

- Status: Accepted
- Date: 2026-08-25
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It narrows the human-merge half of the invariant stated in
  `.github/copilot-instructions.md` for exactly one class of change, and leaves
  ADR 0002 untouched.
- Amends: ADR 0001, in two guardrails and no more. *"Do not publish unreviewed
  facts from automation"* becomes *do not publish facts from automation that no
  reviewer and no gate has judged* — the review is real, adversarial, and
  recorded; what it is not is human. And *"do not move branch protection through
  application code"* stands as written: the protection rule this decision relies
  on was set once, by the owner, as an explicit account-level action. No skill,
  script, or workflow in this repository may change it, and the guardrails below
  say so again in the terms this ADR is enforced by.

## Context

This repository's invariant is *one issue → one branch → one worktree → one agent
→ policy-gated merge*, and until now the last step meant a human pressing the
button. Everything else follows from that: gate verdicts bind to a commit SHA,
`drydock land` stops at a reviewable commit, and the agent's work ends before
publication.

That is the right default for code. It is a poor fit for the one thing this
project exists to do. ModelTree is a map of model releases, and a map that is
correct on the day it is written and stale a month later has failed at its
purpose rather than merely aged. #86 records the shape of the failure: the Meta
dataset is missing an entire product line and is roughly sixteen months behind.
Nothing was broken. Nobody merged anything wrong. The data simply went unrefreshed
because refreshing it required a person to decide to do it.

#59 was the first answer, and it is a good one that does not solve this. It builds
a proposal-only Python updater on Microsoft Agent Framework: it researches, reviews
by 2-of-3 semantic majority, gates deterministically, and files a proposal issue.
Its refusal to publish is not a convention but a property — `tools/updater/tests/
test_proposal_only.py` parses every module and fails the build if any code path
constructs a write outside the guard. That refusal stays. It is the correct design
for a tool a human drives.

Two things about it are load-bearing here. First, it terminates at a proposal,
so the last mile is still a person reading evidence and hand-applying a patch —
the exact step that did not happen for sixteen months. Second, it has never run.
#93 records that no Azure Foundry endpoint, deployment, or Entra federated
credential has ever been configured, so the pilot has only ever executed against
fixtures; #139 records that the publisher workflow cannot locate its fixtures once
the package is installed. The engine is unavailable, and making it available is a
cloud-provisioning project rather than a code change.

Meanwhile the GitHub Copilot app is an agent runtime that is already authenticated,
already running on the maintainer's machine, already able to fetch pages, run
commands, and spawn independent sub-agents, and already schedulable through
Automations. Every capability #59 needed from Foundry is present without Foundry.

So the question this ADR answers is not "should agents be trusted with data" —
#59 settled that, and the answer was yes with 2-of-3 review and unoutvotable
deterministic gates. It is: **having satisfied that bar, must the result still
wait for a human?** For dataset refreshes, waiting is the failure mode we are
trying to fix.

## Decision

**A dataset refresh produced by the `modeltree-refresh` skill set may open a pull
request and merge it without human approval.** Nothing else may.

The class is defined by what the change touches, not by who authored it. A change
qualifies only if every modified file is one of the dataset documents composed by
`web/src/data/raw.ts` — `sources.json`, `publishers.json`, `organizations.json`,
`families.json`, `releases.json`, `usage-observations.json`, `usage-syntheses.json`,
`model-fit-statements.json`, `model-fit-evidence-gaps.json`. A refresh that finds
it needs to touch a schema, a component, a workflow, or a script has left its class
and must stop and file an issue instead. There is no partial case: one
non-dataset file in the diff disqualifies the whole change.

To merge, such a change must clear all three of the following, in order:

1. **Independent semantic review.** Three reviewer sub-agents run concurrently over
   each claim, with the rubrics #59 established: provenance and direct source
   support; cross-source and lineage consistency; editorial correctness and
   entity-boundary discipline. Each sees the claim and its fetched evidence and
   nothing else — not the scout's reasoning, not another reviewer's verdict.
   Acceptance is a 2-of-3 majority, and every verdict and rationale is carried into
   the pull request body.
2. **Deterministic hard gates**, which run after review and cannot be outvoted:
   unsafe URLs, malformed records, impossible or future dates, broken entity
   references, lineage violations, entity-boundary violations, and any attempt to
   introduce a composite or universal score. The last gate is `npm run validate`
   run against the patched dataset, so the Zod contracts in `web/src/data/schema.ts`
   are the final word. A claim that fails is dropped and the remainder revalidated.
3. **A green `web-ci` on the pull request**, enforced by GitHub as a required status
   check on a protected `main`.

The merge itself is `gh pr merge --auto --squash`. The distinction between that and
a skill that watches CI and then merges is the whole point of this clause: with
native auto-merge against a protected branch, the refusal to merge a red pull
request is GitHub's, not the skill's. A bug in our own automation cannot
manufacture consent it did not receive.

Publication follows from the merge rather than being a separate power: `pages.yml`
already deploys on push to `main`. The skills are given no deployment capability of
their own, and the run's last act is to confirm the deployment succeeded and revert
the merge commit if it did not.

Every run files a summary issue. A run that changed nothing files its summary and
closes it immediately, so that the daily record is complete without the open-issue
list accumulating a year of silence.

The agent runtime is the Copilot app itself. This decision does not adopt, extend,
or deprecate `tools/updater/`; that subsystem is untouched and its proposal-only
property is unaffected.

## Consequences

### Positive

- The gap that produced #86 closes structurally rather than by resolve. A release
  announced today is researched, reviewed, gated, and published without anyone
  remembering to do it.
- The bar for publishing did not move. What moved is who waits. Every claim still
  faces 2-of-3 independent review and gates that cannot be outvoted — the same bar
  #59 set, now actually reached rather than reached and parked in an issue.
- The dependency on #93 is gone for this path. A refresh needs `gh` auth and
  nothing else: no Foundry endpoint, no Entra federated credential, no secret.
- Every published change is still an ordinary reviewable pull request with an
  ordinary diff, an evidence trail in its body, and an ordinary revert. Unattended
  is not the same as unrecorded, and nothing here is harder to audit after the fact
  than a human-merged change.
- Requiring `web-ci` on `main` is a strict improvement independent of this decision,
  and is most of #80.

### Costs

- **The blast radius is not bounded by a budget, and that was a deliberate choice.**
  The refresh sweeps the widest scope on every run, including the long-tail profile,
  and no cap limits how many claims one run may accept or how many facts it may
  rewrite. A single wrongly-accepted claim can therefore overwrite an
  already-verified fact and publish it within the hour. The brakes are real but
  partial, and it is worth being exact about what each one does *not* catch. The
  deterministic gates catch malformed, impossible, unreferenced, and
  boundary-violating data; they do not catch a well-formed claim that is simply
  wrong. `web-ci` catches anything that fails schema or tests; a plausible wrong
  date passes it. The three reviewers are the only defence against a wrong-but-valid
  claim, and they share a failure mode by construction: they are instances of the
  same model family reading the same fetched page, so a source that is itself wrong,
  or a page whose phrasing misleads, can carry all three. 2-of-3 buys independence
  of *reasoning*, not independence of *training*. What remains after all of that is
  a revert — which is fast, complete, and after the fact. The residual accepted
  here is a window, measured in hours, during which a confidently wrong fact is
  live on a site whose entire proposition is being right.
- **Two implementations of the same rules now exist.** The deterministic gates are
  reimplemented inside `.github/skills/modeltree-gates/` rather than shared with
  `tools/updater/src/modeltree_updater/gates.py`, on the maintainer's explicit
  instruction that #59's subsystem not be touched. They will drift, and the drift
  will be silent: nothing compares them, and no test fails when one tightens and the
  other does not. The mitigation is narrow and should not be oversold — `npm run
  validate` is shared, so the *Zod contracts* cannot drift and the most consequential
  class of check has exactly one implementation. Everything above the schema —
  URL safety, date sanity, lineage, entity boundaries — genuinely has two. Whichever
  is looser is the one that decides what publishes, and today that is the skill-side
  one, because it is the only one in the merge path.
- **A daily unattended run makes the source catalogue a live dependency.** If a
  seed URL starts serving something else, the scout fetches it in good faith. The
  gates check that a URL is well-formed and permitted by the profile, not that the
  page behind it is still what the profile believed it was.
- **The stale-site failure mode gains a new trigger.** `pages.yml` gates on
  `npm run build`, so a red `main` freezes the published site on its previous build
  rather than breaking it. Requiring `web-ci` before merge makes that far less
  likely, and the revert step handles it when it happens, but a daily automated
  merge cadence means more chances to hit it than a human cadence did.
- **The invariant is now conditional, and conditional rules erode.** "One issue, one
  branch, human merge" was previously answerable without qualification, which is
  most of what made it enforceable. The class defined above is deliberately drawn
  by file path so that the question "does this qualify" has a mechanical answer, but
  every future request to widen it will arrive citing this ADR as precedent. The
  widening is what needs watching, not this decision.
- The daily cadence spends model tokens on days when nothing was published, since
  a no-change run is only known to be a no-change run after the research is done.

## Alternatives Considered

- **Keep the human merge; automate only up to the pull request.** Rejected, and it
  is the closest call here. It preserves the invariant intact and costs only
  latency — in principle. In practice it is the status quo that produced #86 and
  left #59's proposals unapplied: the mechanism was never the bottleneck, the
  attention was. An automation whose last step waits indefinitely for a person is
  the thing being replaced, not a smaller version of it.
- **Auto-merge inside a claim budget, with anything larger waiting for a human.**
  Rejected by the maintainer as the decision was taken, and worth recording why the
  rejection is defensible rather than merely recorded. A budget bounds the *size* of
  a bad run, not its *badness*: one wrong claim published is the failure mode, and
  every budget above zero permits it. Its real benefit is catching runaway behaviour
  — a scout that suddenly proposes two hundred changes — and the summary issue plus
  a visible daily pull request covers that case by observation instead. The cost it
  avoids is the one that matters: a threshold that routinely defers to a human
  recreates the queue that nobody drains, and does so precisely on the largest and
  most valuable runs.
- **Fix #93 and make `tools/updater` the engine.** Rejected as a prerequisite, not
  as an idea. It is a cloud-provisioning project — Foundry deployment, Entra
  federated credential, workload identity — gating a capability that needs none of
  it. It also would not have sufficed alone: the updater is proposal-only by
  property, so making it publish would mean dismantling
  `test_proposal_only.py`, which is a worse trade than leaving it as the
  human-driven proposal tool it was designed to be.
- **Let the skill watch CI and merge when it turns green, changing no repository
  settings.** Rejected. It produces the same outcome when everything works and a
  categorically worse one when it does not: the guarantee "a red pull request cannot
  merge" would be a property of our own prompt rather than of the platform. Making
  GitHub the enforcer costs one settings change and removes our automation from the
  trusted path entirely.
- **Commit straight to `main`, skipping the pull request.** Rejected. It is faster
  by a few minutes and gives up the diff, the evidence trail, the required check,
  and the single-commit revert. `web-ci` runs on pull requests, so this would also
  move the only pre-publication validation to after publication.

## Guardrails

- **Do not add a bypass.** No `--force`, no `--skip-gates`, no environment variable
  that lowers the bar, no "the gates were flaky" retry that proceeds without them.
  This applies to the skills exactly as `.github/copilot-instructions.md` applies it
  to Drydock. A genuine exception belongs in branch protection, where it is
  auditable.
- **Do not remove `web-ci` from `main`'s required checks, and do not add a `paths:`
  filter to `.github/workflows/web-ci.yml`.** The workflow is deliberately unfiltered
  so it reports on every pull request; a filtered required check that never reports
  leaves a pull request pending forever, and the fix chosen under pressure will be
  to drop the requirement.
- **The skills reach `main` only through an auto-merged pull request.** No direct
  push, no `git merge`, no `--admin`, no branch deletion or force-push on `main`.
- **No skill, script, or workflow changes repository settings.** Branch protection,
  the required-check list, auto-merge, visibility, and Pages configuration are owner
  actions, exactly as ADR 0001 requires. A pipeline that can unlock the door it is
  standing behind is not gated at all.
- **The qualifying class is defined by file path and is not widened casually.** A
  refresh that needs to touch anything outside the dataset documents listed in
  `web/src/data/raw.ts` stops and files an issue. Widening the class — to schemas,
  components, or workflows — requires a new ADR, not a commit.
- **Deterministic gates run after semantic review and cannot be outvoted.** Do not
  reorder them so a majority can wave one through, and do not let a reviewer verdict
  suppress a gate failure.
- **A no-change run publishes nothing.** It files and closes its summary issue and
  opens no pull request.
- **If the gates in `.github/skills/modeltree-gates/` are changed, state in the pull
  request how the change relates to `tools/updater/src/modeltree_updater/gates.py`.**
  The drift is accepted above; letting it go unremarked is not. If the two are ever
  reconciled into one implementation, that is a change worth its own ADR.
