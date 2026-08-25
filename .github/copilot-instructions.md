# Copilot instructions — this repository

This project uses **Drydock**: every GitHub issue gets its own branch, its own
git worktree, and its own agent session, and nothing opens a pull request until
review and QA have both passed against the current commit.

Read this before doing anything. If you are inside a dock worktree and the CLI
generated a `DOCK.md`, read it first — it is your complete brief and it wins on
scope. If there is no `DOCK.md`, read the next paragraph.

**The Drydock CLI is not installed in the environments these docks currently run
in.** Check with `drydock --version`. If it is not on your PATH, then no
`DOCK.md` was generated, none of the `drydock` commands named below are
available to you, and the manual posture applies: implement, commit, post your
summary, and stop at the review gate. Your brief is then the issue itself plus
whatever kicked off your session. Every rule in this file still holds — only the
tooling that would have carried it out is missing.

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

No ADR records how much of the loop runs unattended. `drydock.config.json` does
set `autonomy.level` to `full`, with `merge.enabled` true and
`retriesOnGateFail` 2. That is the policy an installed Drydock would enforce,
not permission to act on it yourself: with the CLI absent nothing is gating,
merging, or retrying on your behalf. The posture described in this file is the
one in force.

## Where am I

`drydock status` answers this at any time, from anywhere in the repo, when the
CLI is available. Without it, work down this table — top row first, and stop at
the first row that matches.

| If you see | You are in | Do |
|---|---|---|
| `DOCK.md` at the root | a dock worktree | Work only on that one issue |
| no `DOCK.md`, and `git branch --show-current` reports the branch for the issue you were given | a dock worktree, no generated brief | Work only on that one issue; your brief is the issue plus whatever kicked off your session |
| no `DOCK.md`, and `git branch --show-current` reports `main` | the main repo | Coordinate; don't implement features here |
| no `DOCK.md`, and `git branch --show-current` reports nothing (detached HEAD) or a branch you can't tie to an issue | the table can't tell | Don't guess. Treat whatever kicked off your session as authoritative, and record which you assumed (rule 3 below) |

Do not use `drydock.config.json` as the test. It is tracked, so it is checked
out into every worktree including every dock, and a row keyed on it matches
everywhere. The first row is the one that goes unmatched when the CLI is absent,
because no `DOCK.md` is generated; your branch then decides which of the rest
applies.

## Working in a dock

1. **One issue only.** A bug, refactor, or missing test unrelated to your issue
   goes under `## Follow-ups` in `DOCK.md` if this worktree has one; otherwise it
   goes in the summary you post to the issue (see **Finishing**). Either way it is
   a proposed new issue, and those are its only two destinations: never record it
   in this file, because anything appended here reads to the next agent as
   sanctioned practice. Do not fix it.
   Out-of-scope changes fail review — this is the most common failure by far.
2. **Stay inside the worktree.** Sibling directories are other docks with other
   agents actively working. Never read or modify anything outside your root.
3. **Record assumptions.** Ambiguity gets written into `## Assumptions` in
   `DOCK.md` if this worktree has one, and otherwise into the summary you post to
   the issue; then you proceed. Silent guessing is the failure mode this entire
   system exists to prevent.
4. **Never switch branches, rebase, or merge by hand.** Landing is `drydock land`
   after the gates pass, and merging is GitHub's once CI is green. Your work ends
   at a reviewable commit.
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
  `DRYDOCK_ACTOR` environment variable. (`drydock gate --as` is not a flag
  today, and unknown flags are ignored rather than rejected.) It is only worth
  something if the reviewer and QA agents never saw the developer's summary or
  session — issue text and `git diff` only. Do not review your own work.

## Finishing

Post a summary containing: what changed in one paragraph, every file touched and
why, real test output, every assumption made, and anything you deliberately did
**not** do and why. Post it to the issue as well as to the session — with no
human watching the loop, the comment trail is the only oversight there is.

Then stop and hand off to the review gate. Whether that gate is run by a human
or by a reviewer agent is set by this repo's configuration; either way it is not
you, and you do not run it against your own work.

## This repo's own constraints

ModelTree is a source-backed map of AI creators, model families, and releases.
The site is a static Astro build; everything lives under `web/`.

- **Run every command from `web/`.** The repository root is not a Node project.
- `npm run validate` (tests + Astro/TypeScript diagnostics) must keep passing.
  `npm run build` runs it, so a broken change cannot ship.
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
in this repository, and — as noted at the top — it is not installed in the
environments these docks currently run in.
