# ADR 0003: An Agent-Gated Data Refresh May Auto-Merge and Publish

- Status: Accepted
- Date: 2026-08-25
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It narrows the invariant stated in
  `.github/copilot-instructions.md` §"The invariant" for one class of change, and
  it reads ADR 0001's guardrail "Do not publish unreviewed facts from automation"
  as a rule about *review*, not about *humans*. ADR 0001's other guardrail — that
  branch protection and Pages settings "remain explicit owner actions" — is
  untouched and is load-bearing here: this decision **requires** settings it
  deliberately does not apply.

## Context

Every change in this repository lands the same way:

> One issue → one branch → one worktree → one agent → policy-gated merge.

The policy gate at the end of that line is a person. An agent implements, gates
run, and a maintainer presses merge. Because `pages.yml` deploys on every push to
`main`, that press is also the publish button: the human merge is the last point
at which anything reaches the public site.

The requirement decided with the maintainer is a source-backed dataset refresh
that runs **fully unattended end to end, including deployment** — daily, over the
widest scope including the long tail, with no per-run claim budget. So this is a
decision about unattended *publication*, not merely unattended committing.

The obvious candidate is the updater built in #59, and it does not satisfy the
requirement — for two independent reasons, either of which is sufficient.

- **It refuses to publish, on purpose.** `tools/updater/` proposes; it never
  writes ModelTree JSON, creates a branch, or opens a pull request, and
  `tools/updater/tests/test_proposal_only.py` enforces that as a structural
  property of the source tree rather than a convention. Its publisher workflow,
  `publish-updater-proposals.yml`, is `workflow_dispatch` only and holds exactly
  `contents: read`, `issues: write`, and `id-token: write` — the last mints the
  Entra workload-identity token and grants no repository write — so it cannot
  commit even if asked. That constraint is deliberate and this ADR does not
  weaken it.
- **It has never run end to end.** It is blocked on #93 — no Azure Foundry or
  Entra configuration exists, and `gh variable list` and `gh secret list` are both
  empty — and on #139. Fixing both would produce a working *proposal* pipeline,
  which is the first reason again.

So the requirement needs a different mechanism, not a loosened #59. #146 supplies
one: a `modeltree-refresh` skill set using Copilot sub-agents as the agent
runtime, which removes the Foundry dependency entirely. What it cannot supply is
permission to merge without a human. That is what this ADR grants.

## Decision

**A source-backed dataset refresh produced by the `modeltree-refresh` skill set
may open a pull request and auto-merge to `main` with no human approval, and
therefore publish.** Every other change in this repository keeps the unmodified
invariant, human merge included.

The authorisation is bounded on all four of the following, and a run that cannot
satisfy any one of them does not merge:

- **Scope.** Only the dataset JSON under `web/src/data/` that `raw.ts` composes.
  Not `schema.ts`, not `validate.ts`, not components, pages, workflows, repository
  settings, or `tools/updater/`. A refresh pull request touching anything else is
  an ordinary change and takes the ordinary path.
- **Semantic review.** Three reviewer sub-agents with distinct rubrics —
  provenance and direct source support; cross-source and lineage consistency;
  editorial correctness and entity-boundary discipline. Each sees the claim and
  its fetched evidence only: not the scout's rationale, and not another
  reviewer's verdict. Acceptance is **2-of-3 for a creator with a reviewed
  profile and unanimous 3-of-3 for a long-tail creator** — the proposal-only
  path's thresholds. Where each actually comes from, precisely: both are
  implemented in `tools/updater/src/modeltree_updater/review.py`, as
  `MAJORITY = 2` and `PANEL_SIZE = 3` carried by `MAJORITY_POLICY` and
  `UNANIMOUS_POLICY`; the two-policy design and its rationale are documented on
  `ReviewPolicy` in `contracts.py`; and
  `tools/updater/profiles/generic/long-tail.json` restates the unanimous one for
  the long-tail profile — `"id": "unanimous-3-of-3"`, `"required_accepts": 3` —
  carrying the reasoning verbatim: *"a single dissent or abstention leaves it for
  a human. The reject bar stays at two — refusing a thinly-evidenced candidate
  must not get harder than accepting one."* That file states of itself that it is
  a restatement rather than a definition, and ADR 0002 is the document requiring
  the restatement be exact. **ADR 0002 sets neither number**, and this ADR does
  not cite it as though it did. The publishing path does not get a lower bar than
  the proposal-only path. Every verdict and rationale is carried into the pull
  request body, so the reasoning is reviewable after the fact even though nobody
  reviewed it before.
- **Deterministic gates, which cannot be outvoted.** They run *after* review and
  no number of accepts overrides one failure: unsafe URLs, malformed records,
  impossible or future dates, broken entity references, lineage violations,
  entity-boundary violations, **every claim bound to an approved source**, and
  any attempt to introduce a composite or universal score. The final hard gate is
  `npm run validate` from `web/` against the patched dataset. A rejected claim is
  dropped and the remainder re-validated, so a bad claim costs itself and not the
  run.

  The approved-source binding is `tools/updater/`'s `source-approval` gate
  (`gates.py`), and it is required here rather than assumed because the dataset
  validator cannot stand in for it. `sources.json` is itself part of the dataset
  the run may patch, and `validateDataset` checks `sourceIds` *referentially* —
  that every cited id resolves to a record in the dataset. A run that adds a
  source record and cites it therefore satisfies referential integrity while
  citing something nobody approved. `npm run validate` catches a claim with **no**
  source; only this gate catches a claim whose source the run invented for it.
- **GitHub, not the agent, performs the merge.** `gh pr merge --auto --squash`
  hands the decision to the repository: the merge happens when `web-ci` is green
  and not before. The skill does not poll and then merge, and it never pushes to
  `main`. After merge it confirms the Pages deployment and reverts the merge
  commit if the deploy failed. Every run files a summary issue; a run that changed
  nothing files one and closes it immediately.

**Adopting this ADR does not enable the automation.** It states the terms on
which the automation may be enabled, and there are three preconditions, none of
which this document can apply to itself:

1. `allow_auto_merge` is enabled and `main` is protected with `web-ci` as a
   required status check. These are settings, and ADR 0001 keeps them explicit
   owner actions.
2. The skill set's deterministic gates enforce the approved-source binding above.
   As of this ADR they do not — see the divergence bullet under `### Costs` — so
   this precondition is open, and it is a gap to close in #146 rather than a cost
   accepted here.
3. Review thresholds are per-profile as stated above, not flat.

Until all three hold, this ADR authorises nothing to merge. That is the ordinary
reading of the permissive-divergence guardrail below rather than an exception to
it: the automation stays stopped until the skill set is corrected, which is
exactly what that guardrail requires.

The human is not removed from the loop. They move from approving each claim to
owning the rules, the required check, and the revert.

## Consequences

### Positive

- The dataset can be as fresh as its sources without anyone being awake, which is
  the product's entire premise and something a human-merge queue has never
  actually delivered.
- Auto-merge *via a pull request* rather than direct commits keeps every change a
  reviewable diff with an evidence trail attached to it, and a squash merge makes
  a bad run exactly one commit to revert.
- Using Copilot sub-agents as the runtime means the mechanism has no credential,
  no Azure dependency, and no #93.
- `tools/updater/` is untouched. Its proposal-only guarantee remains true and
  remains tested; this decision runs alongside it rather than through it.

### Costs

- **The blast radius is the whole dataset, daily, unattended.** The refresh runs
  every day, over the widest scope, with no per-run claim budget, and merging
  `main` deploys Pages. So a single wrongly-accepted claim can overwrite a fact a
  human already verified and publish it to the public site, and the first person
  who could notice is whoever reads the summary issue afterwards — which, by the
  design of an unattended system, may be nobody for a long time.
- **The brakes are real but narrow.** They are: the deterministic gates, which
  cannot be outvoted; `web-ci` as a required status check, which for these pull
  requests runs the full build because they touch `web/` by definition; and the
  revert path. What they cover is *shape*: malformed records, unsafe URLs,
  impossible dates, dangling references, lineage and entity-boundary violations, a
  dataset that no longer validates. What they do not cover is *truth*. A claim
  that is well-formed, carries a real fetched page, a verbatim quote, a
  plausible-looking source URL, and today's date passes every gate and can still
  be wrong — misread, superseded, or correct about a different entity. `npm run
  validate` proves the dataset is internally consistent; it cannot prove it is
  true. The failure this decision accepts is precisely the one nobody notices:
  plausible, well-cited, false, and live.
- **The gates do not distinguish adding a fact from overwriting one.** An
  agent-accepted value replacing a human-verified one leaves the record
  structurally identical — `sourceIds` and `verifiedAt` are still present, and now
  they point at the agent's run. Nothing in the schema records that the previous
  value had been reviewed by a person.
- **Two implementations of the same rules will drift, and nothing measures it.**
  #146 reimplements the deterministic gates inside the skill set rather than
  sharing one implementation with `tools/updater/`, specifically so that
  subsystem is not touched. They have already diverged, in more than one
  direction, so the differences are recorded separately rather than netted off
  into a single verdict about which is safer:

  - *Permissive, and therefore a precondition rather than a cost.*
    `tools/updater/src/modeltree_updater/gates.py` defines `url-safety`,
    `typed-contract`, `schema-validation`, `date-sanity`, `reference-integrity`,
    `lineage-invariants`, and `source-approval`. The skill set names no
    `source-approval` equivalent, and relocates that function to the scout —
    dropping a claim whose only support is a search-result snippet, *before*
    review. That is pre-review and agent-mediated, which is the one thing the
    Decision says this class of check must not be, and it is not covered by
    `npm run validate` for the reason given in the Decision. This is not filed
    here as an accepted cost. It is precondition 2 above, to be closed in #146
    before first enablement.
  - *Stricter, and therefore a finding rather than a stop.* The skill set gates
    any attempt to introduce a composite or universal score. `gates.py` has no
    equivalent; #67 is held by review and by ADR 0001's guardrail rather than by
    a deterministic check. A publishing path that refuses more than the
    proposal-only path refuses is not a hazard, but it is still drift, and the
    check belongs in `tools/updater/` too.
  - *Neither — a naming difference that looks like drift.* The skill set names an
    entity-boundary check that does not appear in `gates.py`'s seven names, but
    the rule is enforced there, inside `lineage-invariants`
    (`_claim_lineage_issues`: "entity kinds must stay separate"). Same rule,
    different partition. This is the trap in the whole comparison: gate *names*
    are not the unit of equivalence, and comparing them produces false drift in
    both directions — a missing name that is enforced elsewhere, and, in
    principle, a shared name enforcing different things.

  The review thresholds do **not** diverge: both are 2-of-3 for a creator with a
  reviewed profile and unanimous 3-of-3 for a long-tail creator, on the reasoning
  cited in the Decision. That is stated as a requirement in the Decision so it
  stays true.

  What remains an accepted cost is the structural fact underneath all of this:
  two implementations exist, neither reads the other, and **no test compares
  them**. All three findings above came from a person reading two implementations
  side by side, and the third shows that the cheap comparison — match the gate
  names — is the wrong one. The next divergence will be found by someone doing
  the expensive version, or not at all.
- **Which is authoritative, and in which direction:** `tools/updater/` is the
  reviewed statement of these rules and the skill set's copy is the one that
  moves. But "correct the skill set" cannot mean "make it identical", because
  that would order the removal of a stricter check, so the rule is directional.
  The publishing path may be **stricter** than `tools/updater/`; it may never be
  **more permissive**. A permissive divergence stops the automation. A stricter
  one is a finding raised against `tools/updater/` and stops nothing. Neither is
  ever a licence to prefer the skill set's answer on the grounds that it is the
  one that actually runs.
- **Policy that governs this repository now lives outside it.** `allow_auto_merge`
  and `web-ci` as a required check are settings, not files, so they appear in no
  diff and no gate verifies them. If `web-ci` is ever dropped from branch
  protection, `--auto` degrades to merge-on-open and nothing in the repository
  notices. ADR 0001 keeps those as explicit owner actions, so this ADR can require
  them and cannot enforce them.
- **A summary issue every run, with no budget, is a stream nobody reads.** The
  audit trail is only oversight if it is read, and an unattended system is one
  whose output is by definition unattended.
- **`web-ci` skips the build when no `web/` file changed.** That is safe here only
  because the scope restriction above guarantees these pull requests touch
  `web/src/data/`. It is a restriction, not a mechanism: widen the scope and the
  required check can report green having verified nothing.

## Alternatives Considered

- **Keep the human merge — file a proposal issue, or open a pull request and wait
  for approval.** Rejected by the maintainer, who decided the requirement is
  unattended end to end *including deployment*. A refresh that waits reintroduces
  exactly the latency the freshness goal exists to remove, and the honest version
  of "a human approves each claim" in a daily, widest-scope pipeline is a backlog
  of unread proposals — which is not review, only delay with paperwork.
- **Auto-merge inside a per-run claim budget, with overflow waiting for a human.**
  Rejected deliberately, not overlooked. A budget makes *volume* the trigger for
  human attention when the failure mode that matters is a *single* wrong claim: it
  sails under any budget, while a large and entirely correct run is held. It also
  introduces a partially-applied run — some claims merged, the rest queued — whose
  state must be carried across days. #59 already has a budgets module; this is not
  the problem it solves.
- **Fix #93 so `tools/updater` becomes the engine.** Rejected. It requires
  provisioning Azure Foundry and Entra credentials this repository does not have
  and does not want to depend on, plus #139 on top, and the result would still be
  a proposal pipeline: refusing to publish is the tool's point and
  `test_proposal_only.py` is what makes the refusal true. Making it the publisher
  means deleting that constraint — a strictly larger and more damaging change to a
  subsystem that is working exactly as designed.
- **Let the skills commit to `main` directly and skip the pull request.**
  Rejected. It is simpler and it removes every brake at once: no required check
  before publication, no single object to revert, and no place to attach the
  evidence trail. The pull request is not ceremony here; it is the mechanism.

## Guardrails

- **No escape hatch.** Do not add `--force`, `--skip-gates`, `--yes`, or an
  environment variable that lets a claim reach a pull request without passing
  review and every deterministic gate. If a bypass is genuinely needed it belongs
  in branch protection, where it is auditable.
- **Do not remove `web-ci` from `main`'s required status checks** while this
  automation is enabled, and do not add a `paths:` filter to it. It reports on
  every pull request precisely so it is safe to require; auto-merge without a
  required check is merge-on-open.
- **The skills write to `main` by exactly one path: an auto-merged pull request.**
  No direct push, no contents-API write, no force-push, and no committing to
  `main` on the grounds that a pull request would obviously have passed.
- **Gates run after review and cannot be outvoted.** Do not reorder them, and do
  not let any number of reviewer accepts override a single gate failure.
- **Do not widen the authorisation beyond dataset JSON under `web/src/data/`.**
  Schema, validation code, components, workflows, and `tools/updater/` keep the
  unmodified invariant. Widening this needs a new ADR; turning it off needs
  nothing.
- **Do not weaken `tools/updater/`'s proposal-only constraint or its tests on the
  strength of this decision.** It authorises a different mechanism alongside that
  one, and says nothing in its favour.
- **If the skill set's gates are more permissive than `tools/updater/`'s at any
  point, the automation does not run until the skill set is corrected.** That
  applies to the `source-approval` gap that exists today — which is why the
  Decision makes closing it a precondition of first enablement — and to anything
  discovered later; there is no grandfathering and no carve-out for a divergence
  that predates adoption. A skill-set gate that is *stricter* than its
  counterpart is a finding raised against `tools/updater/`, not a reason to stop.
  Compare the rules enforced, not the gate names: the names partition the same
  work differently, so a name-level comparison reports drift that is not there
  and can miss drift that is. Compare **per rule, not per gate**, for that reason
  and one more: strictness is not ordered between two implementations. ADR 0002
  records exactly this trap — a substitution "can loosen one axis and tighten
  another in the same move" — so a single gate can be stricter on one rule and
  looser on another. A divergence that is more permissive in **any** respect stops
  the automation, even where the same gate is stricter in others. There is no
  netting off, and a gate is not "safe on balance". Do not pick whichever answer
  lets the run continue.
- **No run skips its summary issue**, including a run that changed nothing.
