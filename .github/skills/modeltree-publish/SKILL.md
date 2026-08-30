---
name: modeltree-publish
description: Turn a gated ModelTree claim bundle into a pull request that auto-merges and deploys - apply accepted claims, commit, open the PR with its full evidence trail, enable auto-merge, verify the GitHub Pages deploy, and file the run summary issue. Use only after modeltree-gates has passed.
---

# ModelTree publish

The last stage. You apply what survived, publish it through a pull request that
GitHub merges once CI is green, confirm the site actually deployed, and file the
summary that makes the whole run auditable after the fact.

ADR 0003 authorises this and bounds it. Read
[`../../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md`](../../../docs/adr/0003-an-agent-gated-data-refresh-may-auto-merge.md)
before changing anything here.

## Preconditions — all six, no exceptions

Refuse to publish unless every one holds:

1. `gate-evidence.mjs` exited 0 on the bundle.
2. `gate-source-approval.mjs` exited 0 on the bundle, run **before** any claim
   was applied.
3. Accepted claims are applied and `gate-dataset.mjs` exited 0.
4. `cd web && npm run validate` passed.
5. `gate-scope.mjs` exited 0 **and its `--json` report shows `changed` above
   zero** — every changed path is a dataset document, and there was a change to
   judge.
6. The run's ledger entry is written and `gate-ledger.mjs` exited 0, with its
   `--json` report showing `transcription: false` — see **Recording the run**.

`gate-scope.mjs` is the one precondition on this list whose exit code is
ambiguous on its own, so read its report rather than its status. Exit 0
establishes that every path the gate measured is a dataset document. It does not
establish that the gate measured anything: `changed: 0` with `empty: true` means
there was no change, which is a legitimate outcome and is **not** a licence to
publish. Publish nothing, and file the run summary saying the run found nothing
to change. Never read an empty result as an approved change — that is the exact
move this precondition exists to refuse, and it would satisfy a checklist that
only looked at the exit code while establishing nothing at all.

The gate measures from `git merge-base HEAD refs/remotes/origin/main` and reports
that commit as `anchor.commit` alongside `anchor.selectedBy`. **Publish both in
the run summary**, for the same reason `gate-source-approval.mjs` does: it is
what shows the change was judged against reviewed history rather than against the
run's own commit. An anchor the gate cannot resolve is exit 2, which is never a
pass.

If **2** fails, a claim rests on a source nobody approved. Drop the claim and
every claim citing that source, record why, and re-run the gate. Never add the
source to `sources.json` to make the citation resolve — that is the exact move
the gate exists to refuse, and it would pass `npm run validate` while passing
nothing that matters. If the source is genuinely worth having, it is a follow-up
issue for a human, not part of this run.

If **4** fails, you have a claim that is valid on its own and invalid in context.
Drop it, record why, and revalidate. Never edit a claim to make it pass; that is
the run overruling its own gates.

If **5** fails, the refresh needs a schema, component, or workflow change. That
is not a failure — it is the run correctly finding work for a human. Stop, file
an issue describing what it needed and why, and publish nothing.

If **6** fails, the entry disagrees with the change it describes. Correct the
entry to match what the diff actually did — never the reverse. The gate counts
records at both ends of the diff itself, so an entry edited to satisfy it is an
entry made true, but a *dataset* edited to satisfy it is the run altering
published facts to flatter its own report card, which is the one repair this
gate must never be used to justify.

A `transcription: true` report is also a failure of precondition 6, and a
specific one: it means an entry was added on a branch that changed no dataset
document, so the gate had no diff to check it against. During publishing that
can only mean the data and its entry got separated — commit them together.

## Applying claims

Only `add`, `change`, and `remove` claims that reached their threshold. Apply in
dependency order so references resolve as they are created: sources and
publishers, then organizations, then families, then releases, then usage
observations, syntheses, fit statements, and evidence gaps.

Move `verifiedAt` forward on any record whose facts were re-confirmed this run,
including `unchanged` findings — that is the point of recording them. Keep JSON
formatting exactly as the file already uses it, so the diff shows the change and
not a reformat.

## Recording the run

**The run writes its own entry in `web/src/data/refresh-runs.json`, in the same
commit as the data it describes.** This is a stage of publishing, not a courtesy
afterwards, and it is not optional for a run that changes anything.

Until ADR 0006 it could not be: the ledger sat outside the ADR 0003 qualifying
class, so a run that wrote its own entry was refused by `gate-scope.mjs` and
forfeited the auto-merge it needed. The entry was therefore always transcribed by
a human afterwards, and on three published runs out of three
(abdeslam-menacere/ModelTree#422, abdeslam-menacere/ModelTree#577,
abdeslam-menacere/ModelTree#607) the transcription was missed and
the `/refresh` page ran a full run stale. ADR 0006 put the ledger in class so
this stage can exist. Read
[`../../../docs/adr/0006-a-refresh-run-records-itself-in-its-own-pull-request.md`](../../../docs/adr/0006-a-refresh-run-records-itself-in-its-own-pull-request.md).

The entry is a report a run writes about itself, which is exactly why
`gate-ledger.mjs` exists — it counts the records in every document the entry
names, at the merge base and in the working tree, and refuses an entry whose
numbers do not match. Write the entry from what the run actually did, then run
the gate; do not write it from the gate's output.

```bash
node .github/skills/modeltree-gates/scripts/gate-ledger.mjs --json
```

Prepend the entry — newest first, the order the `/refresh` page renders. Match
the file's existing formatting exactly, including its line endings; a reserialised
ledger buries a 40-line addition in a 600-line reformat that no reviewer can read.

**The commit subject must carry `(run <run-id>)`.** That marker is what makes the
promise enforceable: `gate-ledger.mjs --history` fails when a commit declares a
run id that the ledger does not record, and `skills-ci` runs it on every pull
request. A run that publishes data under a subject with no marker is not caught
by that check, so the marker is the difference between a rule and a habit.

```
data(refresh): move 36 verification dates forward (run 2026-08-30-c0b6e9)
```

Unknowns stay explicit. Any figure the run cannot source — a derived reviewer
count, an approximate page count — goes in the entry's `caveats` saying so
rather than being presented as measured.

## Publishing

```bash
git switch -c data/refresh-2026-08-25
git add web/src/data
git commit -m "data(refresh): add GPT-5.7 and refresh four creator datasets (run 2026-08-25-a1b2c3)"
git push -u origin data/refresh-2026-08-25
gh pr create --title "..." --body-file .modeltree-refresh/runs/<run-id>/pr-body.md
gh pr merge <number> --auto --squash --delete-branch
```

`git add web/src/data` stages the ledger along with the data, which is the point:
the entry and the change it describes land in one commit and revert as one.

Conventional messages: `feat(data):` for new entities, `fix(data):` for
corrections, `chore(data):` for verification dates moving with no fact changing.
Separate commits per creator when a run covers several — a bad creator is then
one revert, not all of them.

Follow that advice freely: it is the gate that was made order-independent, not
the advice that was withdrawn. `gate-scope.mjs` measures from the merge base with
`refs/remotes/origin/main` rather than from the working tree, so a commit made
partway through a run cannot hide itself from a gate invoked after it. Until
abdeslam-menacere/ModelTree#210 it could: the documented bare invocation
inspected uncommitted work only, so committing creator A before gating creator B
was enough to make the gate report nothing had changed and exit 0 having examined
nothing. **Never re-introduce a gate invocation that depends on being run before
the run commits** — an ordering rule no code enforces is one an unattended run
will break silently.

`--auto` is not decoration. `main` requires the `web-ci` check, so GitHub itself
refuses to merge a red pull request. Never poll CI and merge yourself: that moves
the guarantee from the platform into this prompt, which is precisely what ADR
0003 rejected.

Never use `--admin`, never push to `main`, never force-push.

## The pull request body

The body is the audit trail. An unattended merge nobody read is defensible only
if what merged is fully legible afterwards. Include:

- **Summary** — one paragraph: which creators, what changed, how many claims.
- **Every applied claim** — statement, `collection:targetId`, field,
  before → after, source URL, content hash, fetch date, and the verbatim quote.
- **Every verdict** — all three rubrics with their rationales, quoted, for every
  claim including rejected ones. Rejections with reasons are the most useful
  thing in the body.
- **Rejected claims** and which gate or rubric refused them.
- **Conflicts** — both sides quoted, left explicit and unresolved.
- **Deterministic gate output** — including passes, so a missing gate is visible.
- **The approved-source decision** — its own section, not a line in the gate
  output dump. Give `gate-source-approval.mjs`'s exit status, **the anchor
  commit and how it was chosen** (`anchor.commit` and `anchor.selectedBy` — for
  a normal run, the merge base with `refs/remotes/origin/main`), the number of
  approved origins it anchored on and where they came from
  (`anchors.datasetSources` / `anchors.profileCatalogues`), **any profile the
  anchor listed but did not draw on** (`anchors.profileFiles` against
  `anchors.profileCatalogues`, with the difference named in
  `anchors.profilesWithoutCatalogue` and `anchors.profilesUnreadable`) — a
  profile that configures no origins is a choice and one that will not parse is
  damage, and a narrowed anchor that nobody reported reads exactly like a full
  one — every source cited
  split into **inherited** (already in the dataset) and **proposed** (added by
  this run) with the origin each sits on, and any source the gate refused. This
  is the one part of the body that says which sources the run was *allowed* to
  trust, as opposed to which ones it used. Without it a reader can see every
  quote and still not know whether anybody had ever vouched for the page it came
  from. The anchor line matters as much as the rest: it is what shows the run was
  judged against reviewed history rather than against its own commit.
- **Budgets and incompleteness** — pages fetched, budgets hit, sources that
  failed to load.
- **Provenance footer** — run id, skill versions, and that no human reviewed it.

Write it to `.modeltree-refresh/runs/<run-id>/pr-body.md` and pass it with
`--body-file`. Never inline a long body into the shell.

## After the merge

Auto-merge is asynchronous. Poll until the pull request reports merged or the
check fails:

```bash
gh pr view <number> --json state,mergeStateStatus,statusCheckRollup
```

If `web-ci` fails, the pull request stays open and merges nothing. That is the
system working. Report it in the summary issue and leave the pull request for a
human — do not try to fix the data and re-push unattended, because a failing
gate you then edit around is a bypass by another name.

Once merged, `pages.yml` runs on `main`. Wait for it:

```bash
gh run list --workflow=pages.yml --branch main --limit 1 --json status,conclusion,databaseId
```

**If the deploy failed, revert.** A red `main` does not break the site, it
freezes it on the previous build — stale content, healthy appearance, no signal
anywhere. Because `main` is protected, a revert is itself a pull request:

```bash
git switch main && git pull
git switch -c data/revert-refresh-2026-08-25
git revert --no-edit <merge-sha>
git push -u origin data/revert-refresh-2026-08-25
gh pr create --title "revert(data): roll back the 2026-08-25 refresh" --body-file <path>
gh pr merge <number> --auto --squash --delete-branch
```

Then say so, prominently, in the summary issue.

## The summary issue

**Every run files one, without exception** — including runs that changed nothing.
The daily record has to be complete, or its gaps become unreadable: a missing day
could mean nothing changed, or that the automation silently stopped.

```bash
gh issue create --title "Data refresh 2026-08-25" --label data --body-file <path>
```

A run that published nothing files its summary and **closes it immediately**
(`gh issue close <n> --reason completed`), so the record exists without a year of
silence accumulating in the open list. A run that published, was blocked by CI,
reverted, or hit an out-of-class change leaves its issue **open**.

The body carries: creators processed, claims by kind, accepted and rejected
counts with reasons, conflicts, gate results — including the approved-source
decision and any source it refused — budget exhaustion, the pull request link and
merge state, the Pages deployment result, and any follow-up worth its own issue.

## Follow-ups

A refresh that finds real work outside its class — a schema that cannot express a
fact, a stale profile, a source that has moved — records it under `Follow-ups` in
the summary issue as a **proposed** issue. Do not fix it, and do not widen the
change to accommodate it. Out-of-scope changes are the most common review failure
in this repository, and here they would also trip `gate-scope.mjs` and block the
merge entirely.

## Rules

- **Never merge without `--auto`.** Let GitHub enforce the check.
- **Never `--admin`, never push to `main`, never force-push, never disable a
  required check** — not even to unblock a run.
- **Never commit run state.** `.modeltree-refresh/` is git-ignored and stays that
  way.
- **Never publish a claim that did not reach its threshold**, and never publish
  at all if any of the six preconditions failed.
- **Never publish data without its ledger entry**, and never write an entry the
  diff does not support. If `gate-ledger.mjs` refuses, the entry is wrong — fix
  the entry, never the data.
- **Never approve a source to make a claim pass.** If
  `gate-source-approval.mjs` refuses a citation, the claim goes, not the gate.
- **Never leave a failed deploy standing.** Revert, then report.
