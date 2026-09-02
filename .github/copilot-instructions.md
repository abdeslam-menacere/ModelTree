# Copilot instructions — this repository

This project uses **Drydock**: every GitHub issue gets its own branch, its own
git worktree, and its own agent session, and nothing opens a pull request until
review and QA have both passed against the current commit.

Read this before doing anything. If this worktree has a `DOCK.md` at its root,
read it first — it is your complete brief and it wins on scope. If there is no
`DOCK.md`, read the next paragraph.

**Do not assume whether the Drydock CLI is there — determine it, here, before
you either rely on it or rule it out.** This file deliberately does not tell you
the answer. What is installed on the machine you are running on is a fact about
your environment, and a document checked into a repository cannot know it.

Three outcomes matter, and they are genuinely different states: **installed and
runnable**, **installed but not runnable the way you invoked it**, and **not
installed**. Reading the middle one as the last is how an agent talks itself out
of tooling that is sitting right there. So run both forms before concluding
anything:

```
drydock --version
drydock.cmd --version
```

The bare name is the correct invocation everywhere, and on a non-Windows machine
it is the only one — no `.cmd` shim exists there, so "command not found" on the
second line is expected and means nothing on its own. On Windows, npm installs a
`.cmd` shim and a PowerShell one side by side; PowerShell resolves the bare name
to the PowerShell one, and the default execution policy refuses to run it. What
comes back is then an error about running scripts, which is a fact about the
policy and not a report about what is installed — the `.cmd` form can return a
version on the very same machine. This repository already carries the lesson for
a different command: `.github/scripts/ci-preflight.mjs` spawns npm through its
`.cmd` shim on Windows for exactly this reason. Do not change the execution
policy to make the first form work, and do not tell anyone else to: that is a
machine-wide security change made to satisfy a probe.

Read the result this way. If either form prints a version, the CLI is available
to you, and you use whichever form ran for every `drydock` command named below.
If both fail because the command was not found, it is not installed. If both
fail because something refused to run them, it is installed and blocked — which
you cannot use either, but say *blocked* rather than *absent* in your summary,
because the two send the next reader somewhere different. Where this file later
says a command is "on your PATH", it means available in the first sense: a form
of it that runs.

In both failing cases the manual posture applies: implement, commit, post your
summary, and stop at the review gate. With no `DOCK.md` at your root, your brief
is the issue itself plus whatever kicked off your session. Every rule in this
file still holds either way — tooling changes what would carry a rule out, never
whether it binds.

The general form, worth carrying past this one command: **an instruction that
names a probe must not also predict the probe's result.** A predicted result is
not re-tested, so a wrong prediction and a false negative confirm each other and
the pair survives every reading of the file. Say how to find out; never say what
will be found.

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

Two of those lines are measurements taken as you write, never facts recalled
from earlier in the session: the commit you are standing on now,
`git rev-parse HEAD`, and how many commits your branch carries,
`git rev-list --count <merge-base>..HEAD`, with the merge-base computed the way
the gates compute it. A SHA remembered from mid-session names a commit you have
since built on top of, so it under-reports your own work — the quiet direction,
and the one nobody checks. The dock for abdeslam-menacere/ModelTree#584 reported
the first of its three commits, and read against that SHA its record looked
strictly *worse* than trunk's, because everything that improved it sat in the
two commits it did not name.

**Establish that there is still a reason to open a gate, before you post.** A
dock can be redundant in three structurally different ways. They fail
independently, each has cost this repository whole cycles, and — the part that
governs everything below — **no one of the three instruments can see the other
two cases**:

| # | how the dock is redundant | the only instrument that sees it |
|---|---|---|
| 1 | your branch already merged | the record, step 2 |
| 2 | somebody closed your issue | issue state, step 0 |
| 3 | somebody did your specific work, issue still open | content, step 4 |

1. **Your branch already merged.** Nothing inside a worktree changes when its
   branch merges into trunk, which makes the dock structurally the last party
   able to notice that it shipped.
2. **Somebody else's pull request resolved your issue.** Your branch genuinely
   has *not* landed, so every branch-shaped comparison correctly says so and is
   useless: the work is done and the issue is closed.
3. **Somebody else did your specific work, and your issue is legitimately still
   open.** Neither of the first two fires, and neither is wrong to stay silent:
   the branch really is unmerged, the issue really is open. Only the content
   answers it.

Any of the three makes a summary offering finished work for review buy a
redundant gate cycle over a question that is already settled.

The second case is not a corner: the dock on abdeslam-menacere/ModelTree#682
implemented it, then spent a second cycle refining it, on an issue that had been
closed for over twenty-four hours — its work having shipped from a different
branch entirely, as abdeslam-menacere/ModelTree#731. A flawless
branch-landedness probe would have said "not landed" throughout and been right
every time.

The third is the one that survives both of the other checks, so it is worth
seeing in full. The dock on abdeslam-menacere/ModelTree#689 implemented two
model families, having first run the issue-state check and been cleared by it:

```
                     families   eleutherai            ibm
merge-base f69ea888      64     [pythia]              [granite-4-2]
dock tip   7ddbb27c      66     [pythia, gpt-neo]     [granite-4-2, granite-4-0]
trunk      be72a5db      72     [pythia, gpt-neo]     [granite-4-2, granite-4-0]
```

Both families were already on trunk, added by somebody else, with the records
byte-identical. Zero salvage after a full implementation cycle. The issue check
passed because abdeslam-menacere/ModelTree#689 is an **umbrella** — "30 of 40
creators are a single leaf" — which stays open by design until the last creator
is done, and so says nothing whatever about any particular creator inside it.

**Branch-level landedness is necessary and not sufficient, and that is the
contract of this whole section.** `NOT LANDED` means one thing only: *this
branch is not in trunk*. It does **not** mean the work still needs doing. A dock
that reads it as licence to proceed has been handed exactly the reassurance that
cost two docks a full cycle on the day this was written — and failing toward
reassurance is the specific danger, the same one `web/scripts/run-tests.mjs`
exists to name.

**This repository squash merges, and that is the fact the whole procedure turns
on.** A squash preserves your content and destroys your ancestry: trunk carries
your work under a new commit that is neither your tip nor patch-equivalent to
it, so your tip becomes a permanent non-ancestor of trunk. Every history-shaped
probe therefore degrades toward "not landed" — silently, and in the direction
nobody double-checks, because "not landed yet" is the expected answer for a
dock that has just finished. Nine docks reported merged work as ready for
review before this was written, and the last of them stood by for a review gate
for forty hours on work that had merged before it began waiting
(abdeslam-menacere/ModelTree#714).

So this measurement has **six** verdicts, not two, and the ones it exists to
have are the ones nobody thought to write down:

| verdict | what it means | what you do |
|---|---|---|
| `ISSUE CLOSED` | the work is no longer wanted, whoever did it | stop, whatever the diff says; report who closed it and with what |
| `LANDED` | trunk already carries **this branch** | report exactly that and stop; do not ask for a gate |
| `PARTIALLY LANDED` | an earlier commit of yours merged, your newest did not | name which commits, and treat only the remainder as unlanded |
| `SUPERSEDED` | trunk already asserts what your change adds, from somebody else's branch | stop; report what of yours is novel, which is often nothing |
| `NOT LANDED` | this branch is not in trunk **and** trunk does not already assert what it adds | hand off to the review gate |
| `UNDETERMINED` | the probe could not answer | say so, in that word; **never** round it to `NOT LANDED` |

`NOT LANDED` is the only verdict with two conjuncts, and that is deliberate.
Establishing the first alone is what every one of the failures on this page has
in common. You may not issue it having run only step 2: it requires step 4 to
have been reached and to have answered, and if step 4 could not answer then the
verdict is `UNDETERMINED` and not `NOT LANDED`.

**No instrument here subsumes another, and the tempting simplification is
measurably false.** Content looks like the general answer — it is the only thing
that sees case 3, and cases 1 and 2 both leave content on trunk. It fails at
both. Against case 1, on the known-landed control whose work is *wholly* on
trunk, `utf16` — a phrase straight off that branch — greps **absent** at exit 1
while `new TextEncoder().encode(` from the same diff is present, because trunk
edited the work after absorbing it; only the record answers that. Against case 2
it cannot answer in principle: an issue closed `NOT_PLANNED` with nothing merged
leaves content absent and the branch unmerged, both instruments truthfully
saying "keep working" about work nobody wants. Three cases, three instruments,
and the cost of collapsing them is a cycle each.

`UNDETERMINED` is not a politer spelling of `NOT LANDED`. The gate scripts hold
that **exit 2 is never a pass**; this is that rule with the sign flipped — a
probe that could not run has not established unlandedness either, and
collapsing the two is what turned each of those nine runs into a confident
wrong answer instead of a visible failure.

Work the steps in order. Stop at the first one that yields a verdict — with the
single exception the table already states: `NOT LANDED` is not available before
step 4, so an empty result at step 2 sends you on rather than ending the
procedure. Every other verdict, including `UNDETERMINED`, stops it where it is
found. Step 3 is not optional and not a formality: it is the step that decides
whether the later ones are readable at all, and the anchor section that follows
it governs both of the steps that compare against trunk.

### Step 0 — is the work still wanted?

The cheapest call in the whole procedure, and the one that dominates every
other: a closed issue means stop, whatever the trees, the blobs and the record
say about your branch.

```powershell
gh issue view <n> --json state,stateReason,closedAt; $cIssue = $LASTEXITCODE
```

- `CLOSED` ⇒ `ISSUE CLOSED`. Stop. Find out **who** closed it and with which
  pull request or commit, and say in your summary whether anything of your work
  survives in what landed — that is what the next reader needs, and it is not
  answerable from your worktree alone.
- `OPEN` ⇒ carry on to step 1. **This is not a result.** It is the absence of
  one, and it is the weakest reading in the procedure.
- `gh` failing, unauthenticated or offline ⇒ `UNDETERMINED`. Read the exit code;
  an empty string from a failed call is not an empty result.

**`OPEN` never clears you, and the way it fails is worth knowing before you lean
on it.** An issue open by design tells you nothing about any particular piece of
work inside it. Umbrella issues are the clean example — a tracking issue like
"30 of 40 creators are a single leaf" stays open until the last creator is done,
so it reads `OPEN` throughout, including for every creator already finished. The
dock on abdeslam-menacere/ModelTree#689 ran exactly this check, was cleared by
it, and implemented two families that were already on trunk. The check was not
skipped and it did not malfunction: it answered the question it was asked, which
was not the question the dock needed answered. Only step 4 asks that one.

`stateReason` is worth recording but is not load-bearing for the stop decision:
treat any `CLOSED` as `ISSUE CLOSED`, `NOT_PLANNED` included, since an issue
somebody deliberately closed is not one to keep working. Note also that the
field can read `REOPENED`, as abdeslam-menacere/ModelTree#689 does — issue state
is not monotonic, so a check that passed earlier in your session is not still
valid now. Ask again at the end.

Ask this first for a reason that is the whole thesis of this section. **It is a
network call, so it is immune to the frozen-anchor problem** that every other
instrument here inherits. A dock's `refs/remotes/origin/main` is pinned near its
merge-base and is structurally blind to anything that landed afterwards, so
every git-based check it runs is blind in the same way — including the ones that
pass. An issue-state query resolves against live GitHub and cannot go stale like
that. It is also the cheapest thing you can run, which means there is no
argument for deferring it.

### Step 1 — count your own commits before probing anything

```powershell
$trunk = git rev-parse 'refs/remotes/origin/main'; $cTrunk = $LASTEXITCODE
$base  = git merge-base HEAD $trunk;               $cBase  = $LASTEXITCODE
$mine  = git rev-list --count "$base..HEAD";       $cMine  = $LASTEXITCODE
```

Each call gets its own status variable because each is separately capable of
failing, and a single reused `$code` records only the last one — the same
collapse this section warns about everywhere else, in the one place it would be
easiest to excuse. Any of the three non-zero ⇒ `UNDETERMINED`.

A branch carrying **zero** commits of its own has nothing that could be missing
from trunk, so every content-shaped probe below reports `LANDED` about it —
vacuously, and with output indistinguishable from a real positive. Measured on
such a branch here: `merge-tree` exited 0 and printed trunk's own tree, exactly
as it does for genuinely landed work. Take the count first, so you cannot read
that as a result.

### Step 2 — the record, not the trees

This is the reading that works for case 1, it is one API call, and it is the
question a finishing dock actually has about its own branch. A tree probe
answers *"is this content on trunk?"*; the record answers *"was this branch
already merged?"*, and the second is the one being asked. Ask it before any tree
arithmetic. Like step 0 it goes to the network, so it too is free of the
frozen-anchor problem.

```powershell
$branch = git rev-parse --abbrev-ref HEAD; $cBranch = $LASTEXITCODE
$tip    = git rev-parse HEAD;              $cTip    = $LASTEXITCODE
gh pr list --state all --head $branch --json number,state,mergedAt,headRefOid
```

Read it this way, checking the exit code of every call and never inferring a
failure from empty output:

- A `MERGED` pull request whose `headRefOid` sits in your history with
  `git rev-list --count "$headRefOid..$tip"` returning **0** ⇒ `LANDED`. Under
  squash-merge that is decisive regardless of ancestry, trees or blobs, and it
  resolved every case tree equality could not answer.
- The same with a count **above** 0 ⇒ `PARTIALLY LANDED`. The commits after
  `headRefOid` are the only unlanded part; name them.
- An empty list with `gh` exiting **0** ⇒ no record *for that head name*. This
  is **not a verdict**: it settles only that your branch did not merge, which is
  one of the three ways you can be redundant. A branch renamed after its pull
  request was opened also hides its own record, so query the old name too before
  relying on the silence. Either way you continue to step 4, which is the step
  that can turn this into `NOT LANDED` or into `SUPERSEDED`.
- `gh` failing, unauthenticated or offline ⇒ `UNDETERMINED`. An empty string
  from a command that failed is not an empty result, which is why the exit code
  is read rather than the output.

Two identifiers appear here and they are not interchangeable. `headRefOid` is
the tip of the branch the pull request was opened from; the commit that carries
the work on trunk is the squash, with a different SHA and a different tree.
Measured on the pull request that closed abdeslam-menacere/ModelTree#682: head
ref `25a3cdbe10f89014f5d618daeaa98de0be6ec033`, trunk commit
`79de43cf6ac31cceb0e783daff02ae05ae8dd0ed`. Both are real, both resolve, and
they answer different questions — compare your tip against the former.

**Quote every rev-spec, and never leave one bare.** Unquoted, a shell can
rewrite the rev-spec before git sees it, and a rewritten rev-spec can still name
a real object, so that failure reaches you as a well-formed answer rather than
as an error. The general property, worth carrying past this
one line: **an argument that literally contains `^`, `{`, `}`, `$`,
`@`, `<`, `>`, or a backtick is shell-dependent and must be single-quoted**; a
placeholder you substitute before running is not yet an argument. Sweeping for
known-bad commands finds instances, and only the property finds the class.

Single quotes are for a *literal* rev-spec, and they are the right default
because they are inert in bash and in PowerShell alike, so one written form is
correct in both. Where the rev-spec has to interpolate a variable — most of the
commands on this page do — single quotes would defeat the interpolation, so
double-quote it there. What is never acceptable is bare.

A rev-*range* belongs to that class too, even though `.` is not in the list
above, and it fails without erring. Measured here against trunk pinned at
`be72a5db1b4405940674a8beb4076e2ad4e2c06d`, one range written two ways:

```
$tip = d18a7309aec5da5820d9d9a68f140e1e7a5eb357

git rev-list --count $tip..refs/remotes/origin/main     exit 0  ->  4
git rev-list --count "$tip..refs/remotes/origin/main"   exit 0  ->  30
```

PowerShell splits the bare form into two arguments — the tip, and a separate
`..refs/remotes/origin/main` — so git is handed a different question and
answers that one successfully. Both forms exit 0, neither prints a warning, and
nothing in the output says which question was answered. Widening the
enumeration itself to cover this belongs to
abdeslam-menacere/ModelTree#652, which argues that the enumeration rather than
any single command is the unit needing repair; this note exists so that nobody
reading the list concludes a range is safe bare while that is still open.

### Step 3 — controls, fixed before any real result is read

Write every expected classification down, then evaluate them all, and only if
each came back as written classify your own branch.

- **Must classify `ISSUE CLOSED`:** abdeslam-menacere/ModelTree#682, closed
  `2026-09-01T04:31:23Z` with a branch that never merged. It is a clean case-2
  fixture, and on its own it discriminates case 2 from case 1: a probe that only
  compares branches to trunk classifies it `NOT LANDED`, correctly and uselessly.
- **Must classify issue-open:** an issue you have confirmed open in the same
  run. abdeslam-menacere/ModelTree#652, abdeslam-menacere/ModelTree#688,
  abdeslam-menacere/ModelTree#703 and abdeslam-menacere/ModelTree#709 were all
  open when this was written; re-verify rather than trusting the list, and do
  **not** use the issue you are working on — if that one is closed the control
  has not failed, it has just delivered your verdict, which is not what a
  control is for.
- **Must classify `LANDED`:** branch `abdeslam-menacere-picker-index-budget-stopping-rule`
  at `84f3ae208b8854b0935b9888aff5e914d167a7c1`, merged as pull request
  abdeslam-menacere/ModelTree#673 at exactly that tip. A second, if you want the
  mechanism exercised twice: `abdeslam-menacere-compare-page-weight-guard-utf16-bytes`
  at `d18a7309aec5da5820d9d9a68f140e1e7a5eb357`, merged as
  abdeslam-menacere/ModelTree#715.
- **Must classify anything except `LANDED`:** your own branch name with a suffix
  that cannot exist. It is derived rather than hard-coded, so it never goes
  stale and never needs maintaining.
- **Must classify `SUPERSEDED`:** branch
  `abdeslam-menacere-long-tail-breadth-re-bundle` at
  `7ddbb27c0d16334416cff6c9757cca39a0cb7ae5`. Its issue,
  abdeslam-menacere/ModelTree#689, is open; its branch never merged;
  `merge-tree` against trunk exits 1 on all three data files; and both entities
  it adds, `eleutherai-gpt-neo` and `ibm-granite-4-0`, are already on trunk. It
  is the only control here that a branch-shaped probe gets *wrong while
  answering correctly*, which is exactly the property to pin: a procedure that
  reports "not landed, issue open" on this input has said something true and
  useless, and would have cleared a dock that then spent a full cycle
  reimplementing work already shipped.
- **Must detect difference:** run your comparison, in the same invocation with
  the same quoting and the same arguments, on a pair known to differ, and assert
  the result is non-empty:

  ```
  git diff --stat <a-merged-tip> <trunk>   ->  94 files changed, 15718 insertions(+), 1990 deletions(-)
  ```

  This is the one that catches an instrument which has gone uniformly blind, and
  neither of the branch controls can catch it alone.

The first two guard step 0, the next two guard step 2, the fifth guards step 4,
and the last guards every comparison in steps 4 and 5 — one per instrument,
because the three failure cases are independent and a control for one says
nothing about the others. That mapping is the point: if you find yourself with
fewer controls than instruments, one of your instruments is unguarded, and it
will be the one that fails.

A one-sided control cannot catch a probe that answers "not landed" to
everything, which is precisely the failure being guarded against. The dock at
abdeslam-menacere/ModelTree#650 carried controls on its comparison, every one
of them held, and the comparison was still fed the wrong input: controls on a
comparison cannot catch a wrong input to the comparison, while controls on the
*verdict*, in both directions, can.

The difference control exists because even a two-sided one can pass while
testing nothing. If the file your comparison reads is one your branch never
touched, it
is byte-identical on trunk **whether or not the work landed** — so the
comparison returns "same" for a reason unrelated to the question, and the
known-landed side duly classifies as landed, for the wrong reason. Measured on
the `LANDED` control above, which touched exactly one file:

```
84f3ae20 touched:  web/src/lib/comparison.test.ts

README.md              tip 915b0166   trunk 915b0166   identical
web/astro.config.mjs   tip 59b3fc4d   trunk 59b3fc4d   identical
```

Both are identical across a landed pair and would be identical across an
unlanded one, so a probe reading either learns nothing while appearing to
confirm. Asserting the comparison can see difference *at all*, on that pair, in
that invocation, is what makes "identical for precisely the path I touched"
carry information.

**The general rule, and it reaches well past this probe: a negative result is a
claim, and a claim needs a control that would have come back positive.** "Not
landed", "no difference", "no existing issue", "no matching file", "no such
label" are all negatives produced by instruments that fail silently toward
exactly that answer — a wrong path, a mangled rev-spec, an empty result read as
equality, an unauthenticated call. Each needs a companion case that must come
back positive, run the same way in the same invocation. A probe that cannot
demonstrate it would have noticed the opposite has not measured anything.

Say plainly what each control proves. The landed side is a real squash-merged
branch and exercises the whole mechanism. The unlanded side is fabricated,
because this repository has no stable counter-example to name — measured over
the last 60 closed pull requests, every one of them was merged — so it proves
only that the classifier does not answer `LANDED` unconditionally. The
difference control proves the comparison is live, and nothing about
landedness. If any control cannot be evaluated, the run is `UNDETERMINED` and
you do not read your own result at all.

### The trunk anchor, before steps 4 and 5

Steps 4 and 5 both compare against trunk, so both inherit whatever is wrong with
your trunk ref. `refs/remotes/origin/main` is a local cache that moves only when
something fetches, so inside a dock it is frozen by construction and can be
arbitrarily old. **Establish that your anchor is current, and if you cannot,
say so rather than answering against it.**

The reason this matters is that staleness does not degrade the answer evenly —
it is safe in one direction and silently fatal in the other. Trunk only moves
forward, so if your work is contained in a trunk that is an *ancestor* of the
current one, it is still contained now; that inference is sound and you can rely
on it. But the converse does not hold at all. Work absent from a stale anchor
may simply have merged in the window that anchor cannot see, and the probe
reports that absence with a clean exit 0 and nothing to flag it.

Measured here, one merged branch judged at two anchors, where
`f69ea8882a9c66ae339238a2d35248e21e603803` is an ancestor of
`be72a5db1b4405940674a8beb4076e2ad4e2c06d` (`--is-ancestor` exit 0):

```
84f3ae20  merged 08-31 07:52, before the old anchor
  vs old anchor f69ea888   merge-tree exit 0, tree EQUAL       -> LANDED       correct
  vs current    be72a5db   merge-tree exit 1                   -> UNDETERMINED safe

d18a7309  merged 09-01 00:16, AFTER the old anchor
  vs old anchor f69ea888   merge-tree exit 0, trees DIFFER     -> NOT LANDED   WRONG
```

The last line is the nine-dock failure reproduced deliberately: a wholly merged
branch reading `NOT LANDED`, at exit 0, with no conflict and no error, purely
because the anchor predates its merge. Note also that the fresher anchor gives
the *less* useful answer on the first branch — freshness is not simply better,
which is why the rule is to establish what your anchor is rather than to assume
a fetch settled it.

So: resolve trunk once into a variable, record which SHA you used, and check it.
If you can reach the network, `git ls-remote origin main` gives the real tip to
compare against. If you cannot, you may still conclude `LANDED` from an anchor
you have shown to be an ancestor of something newer, by the monotonicity above —
but you may **not** conclude `NOT LANDED` from a stale anchor at all. That
reading is `UNDETERMINED`, and steps 0 and 2, which ask GitHub directly and
so have no anchor to be stale, are how you resolve it.

### Step 4 — content, the only step that sees somebody else's work

Never skippable, and the reason is the contract above: steps 0 and 2 between
them establish that your issue is open and your branch is unmerged, and both of
those are true of a dock whose work somebody else has already shipped. This is
the step that tells the two apart, and it is the only one that can. It asks a
different question from every other step on this page — not *did my branch
land*, but **does trunk already assert what my change asserts**, from whatever
branch and whoever's hand.

Ask what the change *asserts* should now be true of trunk, and check it with a
negative control so that an empty read cannot pass as a match:

```powershell
git --no-pager grep -c -F 'a phrase from your newest commit' $trunk
```

`git grep` exits 0 on a match, 1 on no match, and 2 or above on an error, so
truth-testing it collapses "found nothing" into "could not look" — the same
class as abdeslam-menacere/ModelTree#609. Read the code: 0 present, 1 absent,
anything else `UNDETERMINED`.

Then read the result against the two questions, not one:

- Present, and absent at the merge-base ⇒ trunk asserts it and your branch did
  not put it there. With step 2 silent that is `SUPERSEDED`. Find out which
  pull request did, and report what of yours is novel — frequently nothing.
- Absent, with the positive and negative controls both behaving ⇒ this is the
  second conjunct of `NOT LANDED`, and only now may you issue that verdict.
- Absent with the positive control also absent, or `grep` exiting 2 or above ⇒
  `UNDETERMINED`.

**Choosing the marker is the part that goes wrong, and there is one test for
it: a marker is only usable if you can state what its absence would rule out.**
Say what absence would prove before you search, and if the answer is "nothing",
you have not got a marker. The same string can pass this test in one place and
fail it in another, which is why the test is about the pairing and not the
string. In trunk's *source*, the absence of `tier-source-count` rules the change
out — it greps present tree-wide on trunk at exit 0, and could not if the work
were missing. On a *rendered page*, the absence of the same string rules nothing
out, because it has two incompatible explanations — not deployed, or deployed
and correctly quiet — and an instrument that cannot distinguish those is not
measuring anything. This is the negative-result rule above applied one step
earlier: that one asks whether your control would have come back positive, this
one asks whether your marker could have come back negative.

**Search the whole tree first and narrow afterwards.** Adding `-- <path>` is an
optimisation, not a starting point, and reaching for it first means guessing
which files hold your marker — the guess is usually a subset, and a subset
manufactures exactly the false "absent" this step exists to prevent. Measured on
trunk: `line.sources` lives in **two** files,
`web/src/components/LineageExplorer.tsx` and
`tools/updater/tests/test_pilot_profiles.py`, so even a careful guess naming the
component alone is incomplete.

**Then read the context of every hit before calling it anything.** A surviving
match is not a defect and not a survival until you have looked at it. Both
remaining hits for `entry.official.sources[0]` on trunk are test fixtures rather
than production code — `web/src/lib/passport.test.ts` asserts that a quote
differs from a summary, and `web/src/lib/variant-positioning.test.ts` spreads
the first source to construct a case — so a probe reporting "still present"
about them would be reporting a defect that does not exist. Absent-versus-present
is the cheap half of the reading; which of them the match actually supports is
the half that needs eyes.

**`git grep` reads blob contents and never path names, which matters most to
exactly the change most likely to be duplicated: one that adds a file.** A dock
probing for its new file by name gets "absent" while the file sits on trunk.
Measured here:

```
git cat-file -e 'refs/remotes/origin/main:web/src/data/date-basis-policy.test.ts'   exit 0   EXISTS
git grep -c -F 'date-basis-policy' 'refs/remotes/origin/main' -- 'web/src/data/'    exit 1   "absent"
```

The file is on trunk and the content probe says it is not, at exit 1 — a clean
"no match", indistinguishable from a real absence. It fails toward "absent",
which is to say toward `NOT LANDED`, which is to say toward reassurance, in the
direction everything else on this page fails. For a path your change adds, test
the path with `git cat-file -e` (0 present, non-zero absent — a path that cannot
exist exits 128) or `git ls-tree`, and keep `grep` for what it can actually see.

Take the probe string from the branch's **newest** commit, or you prove
something about round one and nothing about round two. Take it narrow. A string
that is distinctive but over-specific produces a false negative in the same
direction as everything else on this page: measured on the known-landed control
above, whose work is wholly on trunk, the exact expression that branch added is
**absent**, because trunk later renamed one identifier inside it — while the
distinctive fragment `new TextEncoder().encode(` is present and the form the
change removed is gone. An absent positive control is `UNDETERMINED` until you
have checked whether the phrase itself was edited afterwards.

For a dataset change, the assertion is an entity id and the probe is exact.
`eleutherai-gpt-neo` greps present on trunk across
`web/src/data/families.json`, `web/src/data/releases.json`,
`web/src/data/sources.json` and `web/src/data/refresh-runs.json`, while
`zzz-not-a-real-creator-id` exits 1 in the same invocation — one query, run
before the first commit, that would have saved a full implementation cycle.

Step 3's difference control has a specific form here, and it is the one this
probe most needs. A phrase that was already on trunk *before* your branch
existed matches whether or not your work landed, so a match proves nothing —
the content equivalent of comparing a file you never touched. Before trusting a
match, establish that the phrase is yours: grep for it at the merge-base, where
it must be **absent**, in the same invocation with the same quoting. A phrase
present at the merge-base is not a probe, it is a constant.

Step 3's difference control has a specific form here, and it is the one this
probe most needs. A phrase that was already on trunk *before* your branch
existed matches whether or not your work landed, so a match proves nothing —
the content equivalent of comparing a file you never touched. Before trusting a
match, establish that the phrase is yours: grep for it at the merge-base, where
it must be **absent**, in the same invocation with the same quoting. A phrase
present at the merge-base is not a probe, it is a constant.

### Step 5 — tree arithmetic, corroboration only and never the verdict

Only after the steps above, and never as the thing you report. Fetch, then
**resolve the trunk SHA once into a variable and use that variable for every
subsequent command in the measurement.** Never resolve
`refs/remotes/origin/main` twice in one measurement and assume the two agree:
it is shared mutable state across every worktree in this setup, so it moves
when another session fetches, and a comparison whose halves were taken against
two different trunks is not a comparison
(abdeslam-menacere/ModelTree#703). Whether that one resolved SHA is *current*
is the separate question the anchor section above governs; fetching does not
settle it, and a `NOT LANDED` read against an anchor you have not checked is
`UNDETERMINED`.

```bash
git fetch origin main
trunk=$(git rev-parse 'refs/remotes/origin/main')
git merge-tree --write-tree "$trunk" HEAD
git rev-parse "$trunk^{tree}"
```

Capture the **exit code** of that merge-tree call. It is not decoration, it is
the whole of the discrimination, and reading stdout without it is the one way
this probe fails while looking like it worked. `merge-tree` prints a tree OID
when the merge is clean *and equally when it conflicts* — in the conflicted case
it writes conflict markers into the blobs and prints the OID of the tree holding
them, exiting non-zero. Since a tree carrying markers can never equal trunk's,
reading the OID alone makes every conflict report "unlanded". That is not
hypothetical: it was hit while adjudicating abdeslam-menacere/ModelTree#584,
where an already-landed branch was credited with delivering real work. The
conflicted OID is not even stable across equivalent invocations, because the
marker text embeds the label you supplied — naming a side by ref where you
could have named it by SHA changes the tree that is printed. A non-zero exit
means the printed tree is not a comparable artefact at all: do not compare it,
and conclude nothing from it.

**Read that exit code from an unpiped invocation, and read it on the statement
immediately after.** The OID is on the command's first line, so the natural way
to get at it in PowerShell — which is where this repository's docks run — is to
pipe into `Select-Object -First 1`, and that pipeline destroys the value the
paragraph above calls the whole of the discrimination. `-First N` stops the
pipeline as soon as it has N objects, which terminates the native process
upstream, and PowerShell reports that termination as `$LASTEXITCODE = -1`. It
does so **even when the command prints exactly one line and you asked for
exactly one line**, so there is no output small enough to be safe, and nothing
about the command you can inspect to tell. Measured here, against a branch whose
merge into trunk is clean and whose true exit code is therefore 0:

| invocation | `$LASTEXITCODE` | |
|---|---|---|
| `git merge-tree --write-tree "$trunk" HEAD`, captured to a variable | 0 | the truth |
| the same, piped into `Select-Object -First 1` | -1 | corrupted |
| `git rev-parse HEAD`, piped into `Select-Object -First 1` | -1 | corrupted: one line printed, one line asked for |
| `node --version` and `npm.cmd --version`, piped the same way | -1 | so this is the shell's doing, not git's |
| `git rev-parse --verify nosuchref_zzz` | 128 | control: a genuine failure keeps its own value |

Because -1 is non-zero, a corrupted read sends a clean merge down the non-zero
branch below, where it becomes `UNDETERMINED` — and a run that then rounds that
to `NOT LANDED` reports landed work as unlanded. That is the safe direction,
which is exactly why it survives: it manufactures a redundant gate cycle rather
than a visibly wrong claim. It is not hypothetical — it was hit while verifying
that abdeslam-menacere/ModelTree#731 had landed, in a report that printed two
identical tree OIDs with a verdict of NO between them.

Unlike the quoting note above, no single written form serves both shells here:
the command is shared, the variable carrying its status is not. Capture, then
read on the next statement, and only then slice.

```bash
out=$(git merge-tree --write-tree "$trunk" HEAD); code=$?
```

```powershell
$out = git merge-tree --write-tree $trunk HEAD; $code = $LASTEXITCODE
```

Slice the variable, never the command: in PowerShell the first line is
`@($out)[0]` and not `$out[0]`, because a capture of one line is a String while
a capture of several is an array, so the naive index returns the first
*character* of a clean merge's OID and the correct OID only in the conflicted
case you were going to discard. That is inverted precisely against where you
need it. The general property, worth carrying past this one probe: **a native
command's exit status must be read from an unpiped invocation, on the statement
immediately after it**, because a stage that stops the pipeline early kills the
process upstream of it before the shell can read a real status. Early
termination is the whole of the mechanism, which is what makes the rule
predictive rather than a list to memorise: `Select-Object -First 1` and
`-Index 0` corrupt, while `-Last 1`, `-First 1 -Wait`, `ForEach-Object`,
`Where-Object`, `Out-String` and post-capture indexing all preserve, because
each of those has to drain the producer before it can answer. You cannot tell
which you have by looking at the output, so capture first and slice the
variable. That is not `merge-tree`'s defect, nor git's.

These documents read three other families of probe by exit code, and the same
pipe corrupts each. `.github/scripts/ci-preflight.mjs`, where 2 is never a pass;
`npm run validate` the same way; and — the sharpest of the three — the gate
scripts under `.github/skills/modeltree-gates/scripts/`, whose contract
`.github/skills/modeltree-gates/SKILL.md` states as **0** passed, **1** a gate
failed, **2** the gate could not run, with 2 never a pass. Measured on
`.github/skills/modeltree-gates/scripts/gate-scope.mjs` here: a real refusal
exits 2 unpiped and -1 through `Select-Object -First 1`, and a real failure
exits 1 unpiped and -1 the same way. -1 is not 0, 1 or 2 — it is outside the
vocabulary every consumer of these scripts switches on, so a caller matching on
those three values has no branch for what it just got. That is precisely the
failure the gates exist to prevent, in that document's own words: a broken
checker reading as a green one.

So the printed tree is readable in exactly one case, and the exit code decides
which case you are in before stdout is touched at all.

**Exit 0 with the printed OID equal to trunk's tree.** Merging your branch into
trunk would change trunk in no way, so your work is already there — `LANDED`,
subject to step 1's count, because a branch carrying nothing produces this same
output.

**Exit 0 with a different OID.** Trunk does not carry it. That corroborates
`NOT LANDED`; report it alongside step 2's record rather than instead of it.

**Any non-zero exit ⇒ `UNDETERMINED`.** Do not compare the tree, do not print
its OID, and do not diff it. A conflicted tree holds conflict markers, so it
can never equal trunk's and diffing it presents those markers as though they
were the merge result. Report the `CONFLICT` paths instead, which are stable
and actionable, and never key a cache, a dedup or a cross-run identity on a
`merge-tree` OID unless the exit was 0.

Measured against the same pinned trunk
`be72a5db1b4405940674a8beb4076e2ad4e2c06d`, on two branches that had each squash
merged at their exact tips and are wholly present on it:

```
d18a7309  merged as PR 715   merge-tree exit 1   CONFLICT: web/src/lib/comparison.ts, comparison.test.ts
bf5abd4d  merged as PR 671   merge-tree exit 1   CONFLICT: web/src/data/sources.json
```

Neither conflict says anything about landedness. Trunk absorbed each change and
then evolved the same files, so what conflicts is the branch against its own
descendant — not against a rival change. Any structural probe compares the
branch to a trunk that has moved past it, which is why all of them read later
work as absence.

**The per-path blob fallback this section used to prescribe has been withdrawn,
not softened.** It said to compare every path your branch changed against trunk
with `git rev-parse <ref>:<path>` on each side and to read identical OIDs as
the same finding reached without the conflicted tree. It is broken two
independent ways, both of which return "differ", so it can only ever produce
one answer and cannot deliver the verdict it was added to deliver. A dock
following it exactly, with a clean transcript and no error visible, concludes
"genuinely unmerged" about merged work.

First, on a path missing from one side it exits 128 and prints the rev-spec
back **on stdout** — non-empty, stable, different per path, and opening with a
real 40-character SHA, so a caller testing for emptiness or reading a prefix
accepts it as an OID:

```
git rev-parse 'ed835b86827b524107328e79b28e00d1eddeaf4f:web/src/data/does-not-exist.json'

stderr:  fatal: path 'web/src/data/does-not-exist.json' does not exist in 'ed835b86...'
stdout:  ed835b86827b524107328e79b28e00d1eddeaf4f:web/src/data/does-not-exist.json
exit:    128
```

A path missing from trunk is the *normal* case here, not an exotic one: any
branch that adds a file has one, so the rescue is least reliable exactly where
it gets invoked.

Second, differing blobs do not mean absent work. On the known-landed control
above, both calls exit 0 and the OIDs still differ, because trunk evolved those
files after absorbing the change:

```
web/src/lib/comparison.ts        tip e1e7195a   trunk 767bccc8   differ
web/src/lib/comparison.test.ts   tip 734c225e   trunk 51cccbf2   differ
```

At scale that second break produces something worse than a wrong answer, which
is a *plausible* one. Measured on the branch for
abdeslam-menacere/ModelTree#650, whose work is on trunk and whose issue closed
`COMPLETED` on 2026-08-31:

```
tip bd56e242   merge-base 356989e9
merge-tree --write-tree <trunk> <tip>      exit 1   inconclusive, so the fallback is invoked
11 changed paths:   identical 5   differ 6
```

Read by the withdrawn rule that is `NOT LANDED`, and the six differing files are
simply the ones trunk edited after absorbing the squash. Note what the split
invites: an all-differ result at least looks like a definite answer, whereas
five-identical-six-differ tempts a reader to average it into `PARTIALLY LANDED`
— a third wrong answer, about a branch that is wholly present. The two prescribed
methods here, primary and fallback, fail on the same input class, so a dock
doing the documented thing after an inconclusive first probe is misled twice in
a row. That is why the fallback is gone rather than annotated, and it is the
strongest evidence for the position in abdeslam-menacere/ModelTree#652 that the
unit needing repair is the section rather than any one command.

### Ancestry is not a probe here

`git merge-base --is-ancestor`, `git branch --merged` and `git cherry` answer a
different question, and under squash-merge they answer it wrongly by
construction rather than by accident. Trunk carries your content under a commit
that is neither your tip nor patch-equivalent to anything you wrote. Measured
against the pinned trunk above, `--is-ancestor` returned 1 — not an ancestor —
for every landed branch tested, single-commit and multi-commit alike.

`git cherry` earns its own sentence, because it is the trap-shaped one. It
compares patch ids, so a **single-commit** branch squashed unchanged still
matches and it correctly prints `-`: measured on `d18a7309` and `bf5abd4d`,
which carry one commit each. As soon
as a branch carries more than one commit there is no individual patch left to
match, and it prints `+` for every commit of wholly landed work — measured on
three merged branches of three, four and four commits. So it is right on
exactly the branch shape somebody would first test it on and wrong on the rest,
which is worse than being uniformly wrong, because the check that would
establish trust in it is the one case it passes. Content is what is being asked
about, and the record in step 2 is what answers it.

If the probe says `ISSUE CLOSED`, report that first and stop: name who closed
it and with which pull request, and say what of your work survives in what
landed. Do not open a gate on a closed issue, and do not let a `NOT LANDED`
reading on your branch talk you out of it — under case 2 that reading is
correct and beside the point. If the probe says you have landed, report exactly
that — the SHA, the count,
and the evidence that establishes it — and stop there. Do not post a
ready-for-review summary. If it says `PARTIALLY LANDED`, name the commits that
landed and the ones that did not. If it says `SUPERSEDED`, name the pull request
that got there first and state what of your change is novel against it; where
the honest answer is nothing, that is the finding, and it is worth more to the
next reader than a gate cycle would have been. If it could not determine, write
`UNDETERMINED` in that word, say which step refused and why, and do not round it
to either answer. Only if it says `NOT LANDED` — both conjuncts, the record
silent *and* step 4 having positively established that trunk does not already
assert what you add — does everything below apply
unchanged. This is the general form stated near the top of this file, moved
from invocation to status: an instruction that names a probe must not predict
the probe's result, and a summary must not either.

Then stop and hand off to the review gate. Whether that gate is run by a human
or by a reviewer agent is set by this repo's configuration; either way it is not
you, and you do not run it against your own work.

### Your issue is closed — what happens to the branch in your hands

Everything above is a *detector*. It ends by naming a state of the world, and
the routing paragraph says what to **report** about it. Neither says what becomes
of the work. This section begins there, and it changes nothing upstream of
itself: the six verdicts keep their names and their meanings exactly, no verdict
is added, and you arrive here only once one of them has been issued. Arrive on
`ISSUE CLOSED` or `SUPERSEDED`, and on any `LANDED` or `PARTIALLY LANDED` where
you were about to throw something away.

**"Stand down" and "discard" are not the same instruction, and collapsing them
is how the value gets destroyed.** The recorded failure runs the other way — the
dock on abdeslam-menacere/ModelTree#714 never established that it had landed and
spent three addenda re-deriving a change already on trunk — but the correction
to that is not "assume nothing of mine survived". Work three questions in order.

#### Question 1 — is anything of mine absent from what landed?

A measurement, not a judgement, and it has exactly one comparand: **the squash
commit, never trunk's tip.**

```powershell
$sq  = gh pr view <n> --repo <owner>/<repo> --json mergeCommit --jq .mergeCommit.oid
$cSq = $LASTEXITCODE
```

The two are not interchangeable, and only one of them answers the question. The
squash commit is the moment of landing and is immutable, so something absent
from it did not land — that inference is sound. Trunk's tip moves, and a later
commit may edit or delete what your work added, so an absence read *there* has
two incompatible explanations — never landed, or landed and subsequently edited
— which carry opposite dispositions. This file already carries the measurement
that settles it: `utf16`, a phrase straight off a branch whose work is wholly on
trunk, greps **absent** at trunk's tip, because trunk edited that work after
absorbing it. An instrument that cannot separate "never landed" from "landed and
then edited" is not measuring landedness.

Reading that commit takes one of two paths, and which one you have is a fact to
establish rather than to assume:

```powershell
git cat-file -e "$sq^{commit}"; $cObj = $LASTEXITCODE
```

Exit 0 and the object is in your store, so ordinary git reads it. Non-zero and
it is not — which is the **normal** case for a dock whose own work merged during
its life, since the squash postdates the worktree and you are correctly
forbidden to fetch. Read it over the network instead, which has no anchor and so
cannot be stale:

```powershell
gh api "repos/<owner>/<repo>/contents/<path>?ref=$sq" -H "Accept: application/vnd.github.raw"
```

Read that call's exit code too, and never infer absence from an empty body: a
404 for a path you got wrong prints nothing and would otherwise read as "my work
is missing", which is the same collapse of "found nothing" into "could not look"
that the rest of this page refuses.

**Compare only the paths your branch authored.** A branch that was behind trunk
differs legitimately everywhere the merge took trunk's side, so "all paths
match" is the wrong test: it fails toward a false "something of mine is
missing", which is the reassuring direction and therefore the one nobody
re-checks. Take the list from the record rather than reconstructing it:

```powershell
gh pr view <n> --repo <owner>/<repo> --json files --jq '[.files[].path]'
```

Measured on abdeslam-menacere/ModelTree#777, whose branch merged at its exact
tip:

```
dock tip   1afcb121b77e80d11bda90fc5dccb45e43872e02
PR 784     headRefOid 1afcb121b77e80d11bda90fc5dccb45e43872e02   IDENTICAL
squash     a07c7420aab3464bb8c62923a904fb94f2287781   mergeCommit.oid, frozen

git diff --stat "$tip" "$sq" -- <the 5 authored paths>
  exit 0, no output                      nothing of mine is absent
git diff --stat "$tip" "$sq"
  exit 0, 2 files changed, +137          trunk's own work, not mine:
                                           tools/updater/profiles/origins/nvidia.json
                                           tools/updater/profiles/origins/tii.json
```

Neither differing path is one that branch authored. Read unrestricted it looks
to be missing 137 lines; read against the paths it actually wrote, it is missing
nothing. **The unrestricted run is the control for the restricted one** — same
command, same quoting, same two commits, one argument shorter — and it came back
non-empty, which is what makes "no output" a finding rather than a blind
instrument.

#### Question 2 — absent because it was refused, or absent because it was never seen?

Opposite dispositions, and the artefacts do not separate them on their own.
Re-proposing refused work is worse than discarding good work: it spends a
reviewer's cycle arguing with a decision that has already been made.

The instrument is `stateReason`, which step 0 has already read, together with
whatever closed the issue.

- `NOT_PLANNED` ⇒ unwanted. Discard, and do not re-propose it in any form.
- `COMPLETED` with a merged pull request ⇒ overtaken, not refused. Question 3
  applies to whatever question 1 found absent.
- `COMPLETED` with nothing merged ⇒ closed by hand. Treat it as unwanted, and
  say in your summary that you read it that way, because that reading is a
  judgement and the next reader may want to revisit it.

**Do not key any of this on *who* did something.** Every session in this
repository posts as the same account, so "who closed it" and "who pushed that
branch" are not answerable from any artefact here, and a rule that depends on
them cannot be carried out. The answerable question is *which pull request*,
never *whose hand*.

#### Question 3 — what carries the remainder forward?

You cannot push, cannot open a pull request, cannot rebase, and your worktree
does not survive you. `DOCK.md` is untracked and dies with the dock. So the
disposition has to be an artefact that outlives the worktree, and it has to be
readable without your branch: a comment or a new issue that **quotes the absent
hunks inline**, because a later reader cannot check out a branch that no longer
exists.

**Ask what the remainder *is*, not merely whether the code landed.** A dock's
output is not only its diff. Findings, inventories, audits, counter-examples and
negative results are output too, and they land on no branch at all, so a diff
being wholly present on trunk says nothing whatever about them.

That is not hypothetical, and it is the case the obvious table gets wrong. The
abdeslam-menacere/ModelTree#777 dock above measures as *fully landed* on
question 1 — five authored paths, zero difference against the squash. "Fully
landed ⇒ discard" is the natural reading and it would have destroyed real work:
that dock had also produced a 42-site audit of prefix-anchored selectors, which
merged with nothing because it was never code, and which
abdeslam-menacere/ModelTree#785 — open, and asking for exactly that inventory —
was waiting for. The disposition was neither "discard" nor "file a follow-up":
it was **stand down on the code and re-home the audit onto the open issue that
wanted it**, done at
https://github.com/abdeslam-menacere/ModelTree/issues/785#issuecomment-5515687691.

So before discarding on a fully-landed reading, ask which part of your output
was never a diff. Whatever was not, did not land, whatever the paths say.

#### The dispositions

| what the measurements say | what you do |
|---|---|
| `ISSUE CLOSED` with `stateReason` `NOT_PLANNED` | Discard. Do not re-propose and do not file a follow-up — the work was refused, not missed. Name what you discarded, so the refusal stays legible. |
| Fully landed — no authored path differs against the squash — and all of your output was diff | Stand down and discard. Report the identity that establishes it and stop. Do not ask for a gate. |
| Fully landed, but part of your output was never a diff — a finding, an audit, an inventory, a counter-example | Stand down on the code; **re-home the non-diff output** onto whichever open issue wants it, or file it as a new issue if none does. Landed code does not make a finding redundant. |
| `PARTIALLY LANDED` — some authored path differs against the squash | Name which paths and which commits, and file a follow-up issue quoting the absent hunks inline. Do not rebase, and do not reopen the closed issue. |
| `SUPERSEDED` | Read the superseding change before deciding anything. It may already contain your remainder, may contradict it, or may have solved a different problem under the same name. Only then apply one of the rows above. |
| `UNDETERMINED` at any step | Dispose of nothing. Report which step refused and why. Discarding on an undetermined reading is the only irreversible move here. |

None of this is a licence, and the standing prohibition is unchanged: you still
do not push, do not open a pull request, do not rebase, do not merge, and do not
record a gate verdict on your own work. Every disposition above is either
writing something down or stopping.

#### Which control guards which instrument

Three instruments, three controls, one each — the file's own rule is that fewer
controls than instruments leaves one unguarded, so the mapping is written out
here to be counted rather than asserted. Every control below was evaluated
before any real result was read, and each would have come back the other way.

| instrument | what it answers | its control, run the same way | which way the control must come back |
|---|---|---|---|
| `gh issue view --json state,stateReason` | question 2: refused, or overtaken | one known-closed and one known-open issue, in the same run | it must return **both** values. Measured: abdeslam-menacere/ModelTree#777 `CLOSED` / `COMPLETED`, abdeslam-menacere/ModelTree#785 `OPEN` |
| `gh pr list --search <sha>` and `gh pr view --json mergeCommit` | which pull request landed it, and the frozen comparand | a real merged head SHA and a fabricated one, in the same run | real must find the pull request, fabricated must come back empty **at exit 0**. Measured: `1afcb121…` found it, `ffffffff…00000000` returned an empty list |
| `git diff --stat <squash> <tip> -- <authored paths>` | question 1: what of mine is absent | the identical command with the path restriction removed | it must come back **non-empty**. Measured: restricted empty, unrestricted 2 files and +137 |

A one-sided control cannot catch an instrument that answers the same thing to
everything, and that is the failure being guarded against here: an issue check
that read `CLOSED` unconditionally, or a diff that reported "no difference"
because it was aimed at paths nobody touched, would each produce a confident
disposition and destroy work. Note also what the third control does **not**
prove — it establishes that the comparison is live, and says nothing about
landedness, which is question 1's own reading.

Two further calls appear above and are deliberately **not** counted as
instruments, because neither can produce a wrong disposition that survives.
`git cat-file -e` only routes you between the local read and the network one,
and both of its outcomes are handled: a false "not present" sends you to the
network path, which is strictly the more reliable of the two, so it fails in the
safe direction by construction. `gh api` is the read mechanism for the question-1
comparison rather than a measurement of its own, and it is guarded by its exit
code in the paragraph that introduces it. If you add a fourth thing that can
answer, it needs a fourth control; the count is the check, which is why it is
stated as a count.

## This repo's own constraints

ModelTree is a source-backed map of AI creators, model families, and releases.
The site is a static Astro build; everything lives under `web/`.

- **Run every command from `web/`.** The repository root is not a Node project.
- **`npm` has the same pair of shims this file describes for `drydock`, so
  establish which form runs here before you read anything into a failure from
  it.** The paragraph near the top is about npm's shims already — it borrows
  them to explain the mechanism — and it transfers to npm itself unchanged. Run
  both forms:

  ```
  npm --version
  npm.cmd --version
  ```

  The bare name is the correct invocation everywhere, and where no `.cmd` shim
  exists it is the only one, so "command not found" on the second line is the
  expected result there and means nothing on its own. Use whichever form printed
  a version for every `npm` command below; those are written by name, which says
  what to run and not which form your shell resolves. An `npm` that is refused
  rather than missing is installed and blocked — a fact about the execution
  policy, reported as that, and not repaired by changing the policy. The failure
  that costs something is quieter than a loud refusal: reading one as a missing
  toolchain and reporting a validation you never ran. Unrun is not passed.

  The same general form as above, moved from detection to invocation: an
  instruction that names a command must not assume the form it names is the form
  that runs.
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
  commands locally. Exit 0 passed, 1 a check failed, 2 a check could not run or
  there was nothing to run — and 2 is never a pass. It prints what it does
  **not** cover on every run, including the networked link-health sweep and the
  second Python interpreter; read that before treating a green preflight as a
  green CI.
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
in this repository, and — as noted at the top — whether it is available to you
is something you determine by running both probe forms, never something you
assume and never something this file can tell you.
