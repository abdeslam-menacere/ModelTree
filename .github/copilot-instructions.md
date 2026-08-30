# Copilot instructions — this repository

This project uses **Drydock**: every GitHub issue gets its own branch, its own
git worktree, and its own agent session, and nothing opens a pull request until
review and QA have both passed against the current commit.

Read this before doing anything. If this worktree has a `DOCK.md` at its root,
read it first — it is your complete brief and it wins on scope. If there is no
`DOCK.md`, read the next paragraph.

**Do not assume the Drydock CLI is there — check with `drydock --version`.** It
has not been installed in any environment these docks have run in so far. If it
is not on your PATH, then none of the `drydock` commands named below are
available to you, and the manual posture applies: implement, commit, post your
summary, and stop at the review gate. With no `DOCK.md` at your root, your brief
is the issue itself plus whatever kicked off your session. Every rule in this
file still holds — only the tooling that would have carried it out is missing.

## The invariant

> One issue → one branch → one worktree → one agent → policy-gated merge.

Every rule below follows from it. A change that weakens it needs a decision
recorded as an ADR under `docs/adr/`, not a commit message.

ADRs are named `NNNN-kebab-case-title.md` — four digits, the next unused number,
never reused. Read the most recent one before writing another. Each opens with
`# ADR NNNN: Title`, then a metadata list (`Status`, `Date`, `Decision owners`,
and optionally `Supersedes`, which records the ADR's relationship to earlier
decisions — explicitly including "nothing" when it replaces none),
then `## Context`, `## Decision`, `## Consequences` split into `### Positive`
and `### Costs`, `## Alternatives Considered`, and `## Guardrails`.

Whether an ADR narrows the invariant for the change in front of you is a question
you answer by reading `docs/adr/`, not one this file can answer on your behalf.
Check for `docs/adr/0003-*.md` in particular. Where it is present, it scopes
itself to one bounded class of change and to nothing else: a source-backed
refresh of the dataset JSON that `web/src/data/raw.ts` composes, produced by the `modeltree-refresh` skill
set, may reach `main` without a human approving it. The ADR pairs that grant with
its own limit — every other change in this repository keeps the unmodified
invariant, human merge included — and that limit is the part that applies to you.
Read the file rather than this paragraph before deciding otherwise, and note what
is easy to overstate about it: adoption enables nothing on its own, because the
ADR sets preconditions and states that until they hold it authorises nothing to
merge; and what it drops once they do hold is the *human* reviewer, not review —
its agent reviewers and deterministic gates still run, and GitHub performs the
merge rather than the agent. So unless your change is that refresh, on that ADR's
terms, it takes the ordinary path, and the merge at the end of it is not yours to
make.

`drydock.config.json` does set `autonomy.level` to `full`, with `merge.enabled`
true and `retriesOnGateFail` 2. That is the policy an installed Drydock would
enforce, not permission to act on it yourself: where `drydock` is not on your
PATH, nothing is merging or retrying on your behalf. Gating still happens either
way — reviewer and QA agents run the gates and record their verdicts on the
issue — so it is never you who gates your own work. The posture described in
this file is the one in force.

## Where am I

`drydock status` answers this at any time, from anywhere in the repo, when the
CLI is available. Without it, work down this table — top row first, and stop at
the first row that matches.

| If you see | You are in | Do |
|---|---|---|
| `DOCK.md` at the root | a dock worktree | Work only on that one issue |
| no `DOCK.md`, and `git branch --show-current` reports the branch for the issue you were given | a dock worktree with no `DOCK.md` | Work only on that one issue; your brief is the issue plus whatever kicked off your session |
| no `DOCK.md`, and `git branch --show-current` reports the branch that `git symbolic-ref --short refs/remotes/origin/HEAD` names, which it prints as `origin/<branch>` | the main repo | Coordinate; don't implement features here |
| no `DOCK.md`, and `git branch --show-current` reports nothing (detached HEAD) or a branch you can't tie to the issue you were given | the table can't tell | Don't guess. Treat whatever kicked off your session as authoritative, and record which you assumed (rule 3 below) |

Do not use `drydock.config.json` as the test. It is tracked, so it is checked
out into every worktree including every dock, and a row keyed on it matches
everywhere. The first row is the one that goes unmatched when there is no
`DOCK.md` at your root; your branch then decides which of the rest applies.

A narrow gap between the two dock-worktree rows — a dock whose branch you cannot
tie to its issue reading as the last row rather than the second — is accepted
rather than closed: reaching it means the one-issue-one-branch invariant has
already been broken, so the table's guidance is moot by the time it bites, and
tightening the rows to catch it would cost more clarity than it buys.

Where `git symbolic-ref --short refs/remotes/origin/HEAD` exits non-zero — a
checkout carrying no remote-tracking refs is enough for that — the default
branch is not discoverable here, so the main-repo row cannot match and the row
that says the table can't tell is the one that applies. Do not put the name
`main` in place of the command: in a repository whose default branch was
renamed, that reads the main-repo row as matching when it does not.

## Working in a dock

1. **One issue only.** A bug, refactor, or missing test unrelated to your issue
   goes under `## Follow-ups` in `DOCK.md` if this worktree has one; otherwise it
   goes in the summary you post to the issue (see **Finishing**). Either way it is
   a proposed new issue, and it goes nowhere else: never record it in this
   file, because anything appended here reads to the next agent as sanctioned
   practice. Do not fix it.
   Out-of-scope changes fail review — this is the most common failure by far.
2. **Stay inside the worktree.** Sibling directories are other docks with other
   agents actively working. Never read or modify anything outside your root.
3. **Record assumptions.** Ambiguity gets written into the summary you post to
   the issue — every assumption, every time, whether or not this worktree has a
   `DOCK.md`. The reason is one you can check: `git ls-files DOCK.md` prints
   nothing, so that file is not repository content. It exists in the one
   worktree that holds it and goes when that worktree does, which puts anything
   recorded only there beyond the reach of the gates — they judge from the issue
   text and `git diff` — and of every later reader. `## Assumptions` in
   `DOCK.md` is a good place to collect assumptions as you work, and never the
   place they stop. Never write them into this file either, where they would
   read to the next agent as sanctioned practice. Then you proceed. Silent
   guessing is the failure mode this entire system exists to prevent.
4. **Never switch branches, rebase, or merge by hand.** Landing is `drydock land`
   after the gates pass if that command is on your PATH, and otherwise is not a
   step you perform at all; merging is GitHub's once CI is green. Your work ends
   at a reviewable commit. Opening the pull request is the coordinating session's
   step, taken only after both gates have passed against that commit — never the
   step of the dock agent that wrote it, whether or not `drydock` is on your PATH.
5. **Small, atomic commits.** Conventional messages (`feat:`, `fix:`, `test:`).
6. **Run the tests and report real output.** Never claim tests pass without
   running them. A behavioural change with no test fails QA.

## Gates

Gate verdicts bind to a commit SHA and go stale on any new commit. That is the
core of the product.

- Gates run in order: `review` → `qa`. QA is refused until review passes.
- If you commit after a gate passes, it goes stale and must be re-run. Working
  as intended.
- **Do not add an override, `--skip-gates`, or `--force` that bypasses
  verification.** If a bypass is genuinely needed it belongs in branch protection,
  where it is auditable.
- Do not edit `.drydock/docks/*.json` by hand. Do not hand-write a gate receipt
  into a PR body.
- A verdict may be recorded by an agent, attributed `agent:<role>` via the
  `DRYDOCK_ACTOR` environment variable. (Set that variable. Whether a flag
  such as `--as` is also accepted is what `drydock gate --help` reports, so do
  not assume an unrecognised flag is harmless.) It is only worth
  something if the reviewer and QA agents never saw the developer's summary or
  session — issue text and `git diff` only. That diff is the whole branch
  against its computed merge-base, never a single commit: measure scope as
  `git diff --stat <merge-base>...<tip>`, with the merge-base computed as
  `git merge-base HEAD refs/remotes/origin/main` and never supplied. `git show`
  reads one commit, so it is never a scope check on a branch — it can only
  under-report, silently, and that it agrees with the branch diff on a
  one-commit branch does not make it a check on any branch with more. This is
  not a discipline the reviewer path invents: the scripted gates already anchor
  the same way, and
  `.github/skills/modeltree-gates/scripts/gate-scope.mjs` computes this
  merge-base itself rather than trusting a supplied base — read it rather than
  restating its algorithm here, so the two cannot drift. Do not review your own
  work.

## Finishing

Post a summary containing: what changed in one paragraph, every file touched and
why, real test output, every assumption made, and anything you deliberately did
**not** do and why. Post it to the issue as well as to the session — with no
human watching the loop, the comment trail is what a later reader has to
reconstruct your work from, and the reviewer and QA gates are oversight in
their own right.

Then stop and hand off to the review gate. Whether that gate is run by a human
or by a reviewer agent is set by this repo's configuration; either way it is not
you, and you do not run it against your own work.

## This repo's own constraints

ModelTree is a source-backed map of AI creators, model families, and releases.
The site is a static Astro build; everything lives under `web/`.

- **Run every command from `web/`.** The repository root is not a Node project.
- `npm run validate` (tests + Astro/TypeScript diagnostics) must keep passing.
  `npm run build` runs it, so a broken change cannot ship.
- **`npm run validate` is not the whole verification set, and a diff that
  touches `.github/`, `tools/`, or `docs/adr/` needs more than it.** That
  command reads `web/`. It never reads the paths that trigger
  `instruction-references`, `adr-numbers`, or the `tools/updater` pytest suite,
  so a change to an instruction or skill document can satisfy every gate and
  still redden `main` on merge — which is what happened, over one bare issue
  citation, in abdeslam-menacere/ModelTree#560. Before you hand off, from the
  repository root:

  ```bash
  node .github/scripts/ci-preflight.mjs
  ```

  It selects the pull-request checks your branch's diff actually triggers,
  measured from `git merge-base HEAD refs/remotes/origin/main`, and runs their
  commands locally. Exit 0 passed, 1 a check failed, 2 a check could not run —
  and 2 is never a pass. It prints what it does **not** cover on every run,
  including the networked link-health sweep and the second Python interpreter;
  read that before treating a green preflight as a green CI.
  `.github/workflows/README.md` records the full mapping and its limits.
- **Data changes are reviewable repository changes.** Seed data is versioned
  JSON in `web/src/data/`, validated with Zod. Never fetch at runtime — there is
  no database and no live API monitoring.
- **Every important fact carries a primary source and a verification date.** A
  claim added without one fails review. Unknown and conflicting data stay
  explicit rather than being smoothed over.
- **Creator, model, product, and serving platform are separate entities.** Do
  not collapse them, and do not invent a composite score or universal ranking.
- Accessibility and performance are requirements, not polish: keyboard support,
  reduced-motion, and the asset budgets are acceptance criteria.
- Product context lives in `docs/product/`; architecture decisions in
  `docs/adr/`. Read them before changing structure.

The Drydock CLI is a tool, not a dependency of this project. Its source is not
in this repository, and — as noted at the top — whether it is on your PATH is
something you check with `drydock --version` rather than assume.
