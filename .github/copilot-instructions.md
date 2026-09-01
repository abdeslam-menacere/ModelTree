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

**Establish whether your work has already landed, before you post.** Nothing
inside a worktree changes when its branch merges into trunk, which makes the
dock structurally the last party able to notice that it shipped; a summary that
offers finished work for review buys a redundant gate cycle over a question
trunk has already settled. From your worktree:

```bash
git merge-tree --write-tree refs/remotes/origin/main HEAD
git rev-parse 'refs/remotes/origin/main^{tree}'
```

The quotes on the second line are load-bearing, and single quotes specifically:
they are inert in bash and in PowerShell alike, so one written form is correct
in both. Unquoted, a shell can rewrite the rev-spec before git sees it, and a
rewritten rev-spec can still name a real object — so that failure reaches you as
a well-formed OID rather than as an error. The general property, worth carrying
past this one line: **an argument that literally contains `^`, `{`, `}`, `$`,
`@`, `<`, `>`, or a backtick is shell-dependent and must be single-quoted**; a
placeholder you substitute before running is not yet an argument. Sweeping for
known-bad commands finds instances, and only the property finds the class.

Capture the **exit code** of the first command. It is not decoration, it is the
whole of the discrimination, and reading stdout without it is the one way this
probe fails while looking like it worked. `merge-tree` prints a tree OID when
the merge is clean *and equally when it conflicts* — in the conflicted case it
writes conflict markers into the blobs and prints the OID of the tree holding
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
| `git merge-tree --write-tree refs/remotes/origin/main HEAD`, captured to a variable | 0 | the truth |
| the same, piped into `Select-Object -First 1` | -1 | corrupted |
| `git rev-parse HEAD`, piped into `Select-Object -First 1` | -1 | corrupted: one line printed, one line asked for |
| `node --version` and `npm.cmd --version`, piped the same way | -1 | so this is the shell's doing, not git's |
| `git rev-parse --verify nosuchref_zzz` | 128 | control: a genuine failure keeps its own value |

Because -1 is non-zero, a corrupted read sends a clean merge down the non-zero
branch below and reports landed work as unlanded. That is the safe direction,
which is exactly why it survives: it manufactures a redundant gate cycle rather
than a visibly wrong claim. It is not hypothetical — it was hit while verifying
that abdeslam-menacere/ModelTree#731 had landed, in a report that printed two
identical tree OIDs with a verdict of NO between them.

Unlike the quoting note above, no single written form serves both shells here:
the command is shared, the variable carrying its status is not. Capture, then
read on the next statement, and only then slice.

```bash
out=$(git merge-tree --write-tree refs/remotes/origin/main HEAD); code=$?
```

```powershell
$out = git merge-tree --write-tree refs/remotes/origin/main HEAD; $code = $LASTEXITCODE
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

So there are three readings, not two. Exit zero with the printed OID equal to
trunk's tree: merging your branch into trunk would change trunk in no way, so
your work is already there. Exit zero with a different OID: it is not. Non-zero:
fall back to the paths themselves, comparing every path your branch changed
against trunk with `git rev-parse <ref>:<path>` on each side, since identical
blob OIDs across all of them are that same finding reached without the
conflicted tree. Any of the three is only as current as
`refs/remotes/origin/main`, which moves when something fetches and not
otherwise; a stale ref errs toward "not landed", which is the safe direction to
err in.

`git merge-base --is-ancestor` and `git cherry` answer a different question and
will mislead you here. Both reason about commits, and this repository squash
merges: trunk carries your content under a new commit that is neither your tip
nor patch-equivalent to anything you wrote, so both report "not merged" about
work that is wholly present on trunk. Content is what is being asked about, and
the tree comparison above is what asks about content.

If the probe says you have landed, report exactly that — the SHA, the count, and
the comparison that establishes it — and stop there. Do not post a
ready-for-review summary. If it says you have not, you have spent two commands
and two lines and everything below applies unchanged. This is the general form
stated near the top of this file, moved from invocation to status: an
instruction that names a probe must not predict the probe's result, and a
summary must not either.

Then stop and hand off to the review gate. Whether that gate is run by a human
or by a reviewer agent is set by this repo's configuration; either way it is not
you, and you do not run it against your own work.

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
