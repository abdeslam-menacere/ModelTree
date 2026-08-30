# ADR 0006: A Refresh Run Records Itself in the Same Pull Request It Publishes

- Status: Accepted
- Date: 2026-08-30
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It **widens** the qualifying class ADR 0003 defined, by
  exactly one file — `web/src/data/refresh-runs.json` — and leaves every other
  bound in that decision untouched: the scope is still drawn by file path, the
  review thresholds are unchanged, the deterministic gates still cannot be
  outvoted, and GitHub still performs the merge. It does not modify ADR 0005,
  and it does not touch ADR 0001's guardrail that branch protection and Pages
  settings remain explicit owner actions.

## Context

ADR 0003 bounds an auto-merging refresh to the dataset documents `raw.ts`
composes, and `gate-scope.mjs` enforces that bound as a literal path list.
`web/src/data/refresh-runs.json` — the ledger the `/refresh` page renders — is
deliberately not on that list. `refresh-log-schema.ts` says why: it holds facts
about runs, not facts about models, and it is the *reviewed transcription* of a
record whose durable form is the pull request body and the summary issue.

The consequence was not anticipated and is now measured. **A run cannot record
itself.** Writing its own ledger line puts a file outside the qualifying class
into the change, `gate-scope.mjs` correctly reports `outOfClass`, and the run
forfeits the auto-merge that is the entire point of ADR 0003. So an unattended
run publishes data and leaves the page one run stale — every time, silently.

Nothing backfilled it either. Until this decision, `grep -r 'refresh-runs' .github/`
returned zero matches: none of `modeltree-refresh`, `modeltree-scout`,
`modeltree-review`, `modeltree-gates` or `modeltree-publish` was aware the ledger
existed. The ledger was a document with a schema, a page, four test suites, and
no writer.

This was filed as #419 on 2026-08-27. It has recurred on every published run
since, and each was repaired the same way — by a human, after the fact:

| Run | Published | Ledger entry reached `main` |
|---|---|---|
| `2026-08-27-ab1644` | #417 | by hand, #422 |
| `2026-08-29-34e751` | #529 | by hand, #577, a day late |
| `2026-08-30-c0b6e9` | #597 | by hand, #607, after the page was noticed stale |

Three hand repairs is the evidence that the mechanism, not the diligence, is
wrong. A daily unattended publisher whose public record of itself depends on
somebody noticing has no record of itself.

The repair is also where the drift gets worse rather than better. #419's own
comment records two findings from doing it by hand: the pull request body and
the summary issue **disagreed** on counts for the 2026-08-27 run, and two schema
fields (`reviewers`, `verdictsCast`) have no verbatim source in either record and
had to be derived. A transcription written days later from two records that
disagree is a worse artifact than one the run emits from its own working state.

## Decision

**`web/src/data/refresh-runs.json` joins the ADR 0003 qualifying class, and a
refresh run writes its own ledger entry into the same pull request that carries
its dataset changes.**

The obvious objection is the one #419 raised and it is answered rather than
waved through: this lets an unreviewed run write its own report card. So the
grant is paired with a control that did not exist before.

**`gate-ledger.mjs` cross-checks the entry against the change it describes.** It
is deterministic, offline, and anchored the same way every other gate here is —
`git merge-base HEAD refs/remotes/origin/main`, computed rather than supplied. It
enforces six things:

1. **Every dataset document the branch changed is declared**, and every document
   the entry declares was really changed. A run cannot quietly edit a document it
   does not mention, and cannot claim one it did not touch.
2. **`recordsBefore` and `recordsAfter` are counted, not asserted.** The gate
   reads each document at the anchor and at `HEAD` and compares. A run that adds
   nine releases and reports three fails here.
3. **A run id is declared exactly once.** The entry's `id` must be new against
   the anchor's ledger, and the branch may add only one.
4. **A declared run has an entry added by this branch.** Any commit subject on
   the branch carrying `(run <id>)` must have a matching ledger entry *that the
   branch adds*, which is the specific recurrence above made impossible rather
   than merely discouraged. Matching against the whole ledger instead would let a
   run declare an id the anchor already recorded and be credited with an entry
   somebody else wrote.
5. **A change that can merge unattended records itself.** If the branch changes a
   dataset document and touches nothing outside the qualifying class, it must add
   an entry. Rules 1–4 all reason about an entry that exists, so without this one
   the cheapest way through the gate is to write nothing — which is not a
   hypothetical, it is precisely what happened three times.
6. **The ledger is append-only.** A run id recorded at the anchor must still be
   recorded, and while publishing, the entries already there must be byte-identical
   and in the same order. Without this, a deletion is invisible to every rule
   above: they all ask what the branch *added*, and a removal paired with an
   equal-sized addition nets out of every count.

Rule 5's trigger is the shape of the diff, not the `(run <id>)` marker, and that
choice is load-bearing. The marker is written by the run, so a rule triggered by it
is satisfied by a run that stays silent — absence as the cheaper path, which is the
failure being fixed. A diff measured from a computed merge-base is the one thing
the run cannot influence. The cost is real and is accepted rather than hidden: the
gate cannot distinguish a hand edit confined to the dataset documents from a
refresh run, because at the boundary that matters they are the same thing. Measured
over the last 250 commits, 7 touch only in-class paths and roughly four of those
are hand edits that record no run; each would be asked for an entry it should not
need. Branch mode does not run in CI, so this never blocks such a pull request — it
fires for the publishing agent, which is where it is needed.

Rule 6's second half catches what an id comparison cannot: a run that keeps every
id and rewrites the numbers inside a published entry. Those numbers describe a diff
that is not in front of the gate, so there is nothing to re-derive them from and
the only safe rule is that they may not move.

The same script, run with `--history`, answers #419's fourth acceptance
criterion over `main`: every run id published in a commit subject has a ledger
entry, so the gap cannot silently reopen. `skills-ci` runs it that way on every
pull request, as `--history HEAD`.

Rules 1 and 2 are conditional on there being a change to reconcile against, and
the condition is mechanical: **did this branch change any dataset document?** If
it did, the entry describes that change and is checked against it. If it did not,
the entry describes work published under some earlier commit — a *transcription*,
which is the shape of all three hand repairs above and of any later correction to
a historical entry. There is no diff on such a branch to check the numbers
against, and refusing it would remove the only route by which a wrong entry can
ever be fixed. The gate accepts it, reports `transcription: true`, and says the
numbers went unchecked rather than passing it as though they had been. Rules 3
and 4 still apply. For a run that is publishing data, `transcription: true` is a
failure rather than a mode: it means the entry and its data were separated, and
they belong in one commit.

Transcription also relaxes rule 6's ordering half, since a correction *is* an edit
to a published entry, and relaxes rule 5, since a branch that changes no dataset
document publishes nothing that needs recording. It does not relax rule 6's
no-deletion half. There is no mode in which a published run may leave this page.

**`.github/CODEOWNERS` clears ownership on the ledger too.** The path list there
duplicates `ALLOWED_PATHS` because CODEOWNERS cannot import, and a test asserts
the two sets are equal. Leaving the ledger owned would request a code-owner review
on every automated refresh and would block the merge outright the moment
code-owner review became required — which would repeal this decision through a
file that never mentions it, exactly as that file's own header warns.

**What this does not do.** It does not verify the *prose*. `summary`, `caveats`
and the stage notes are self-authored and stay that way, for the same reason
ADR 0005 accepts that a content hash cannot be verified offline: there is no
non-subject source for them in this repository. This is a bounded control on the
numbers, and it is described as such — see the guardrail below.

The compensating structure is that the numbers are now the *cheapest* part of the
entry to get right and the *only* part a run can be caught lying about, whereas
before this decision every part of it was written by a human days later from
records that disagreed.

## Consequences

### Positive

- The `/refresh` page stops being stale by construction. The ledger line lands
  with the run, in the same squash commit, so there is no window in which the
  dataset has moved and the public record has not.
- The entry is written by the run from its own working state, which is the only
  moment at which `reviewers`, `verdictsCast`, `pagesFetched` and the per-document
  counts are known without inference. #419's two "had to be derived" fields stop
  being derived.
- A bad run is still exactly one revert: the ledger entry squashes into the same
  commit as the data, so reverting the data reverts the claim about it. Under the
  old arrangement a revert left the ledger asserting a run that no longer existed.
- The gate is a genuine tightening even for the human path. A hand-written entry
  that misstates a record count now fails, which is the class of error #419
  found in the 2026-08-27 transcription.

### Costs

- **The qualifying class is wider, and a wider class is a weaker bound.** One
  file is not nothing: this is the first widening of ADR 0003, and it establishes
  that widening is possible. The guardrail below is what keeps it from being a
  precedent for the next one.
- **A run now writes prose about itself that reaches the public site unreviewed.**
  The numbers are checked; the narrative is not. A run that describes a
  correct change misleadingly will publish that description.
- **`gate-ledger.mjs` is another gate to keep honest.** A gate that stopped
  firing would restore the old silence while looking greener than it did before,
  which is worse than the original bug. Its self-tests break the data in exactly
  the way each rule exists to catch, on the same principle as the rest of the
  suite.
- **The ledger stops being a reviewed artifact**, which is what
  `refresh-log-schema.ts` originally called it. That doc comment is corrected
  rather than left to contradict this decision.
- **Transcription mode is a hole in the numbers check, and a deliberate one.** An
  entry added on a branch touching no dataset document has its counts accepted
  unchecked, because there is nothing to check them against. The alternative was
  to refuse such branches, which would make a wrong historical entry permanently
  unfixable. The gate reports the mode rather than hiding it, `--history` still
  requires the entry to exist, and a publishing run cannot use the mode without
  splitting its data from its record — which the publish skill names as a
  failure.

## Alternatives Considered

- **A second, human-merged pull request carrying only the ledger entry.** #419
  names this as the likely better answer and it is the option this decision
  rejects. It keeps the ledger reviewed, and it does not fix the reported problem:
  the line still does not appear until a human merges it, which is precisely what
  failed three times. It also preserves the worst property of the current state —
  the entry is written after the run, from records that can disagree, rather than
  from the run's own working state.
- **Widen the class and rely on the existing schema refinements.** The
  refinements are strict and cross-consistent, but they are all *internal*: they
  check the entry against itself. An entry claiming `recordsBefore: 63,
  recordsAfter: 64` for a document that actually went 82 to 82 satisfies every
  one of them. Internal coherence cannot detect a report card that is coherent
  and false, which is the exact risk widening the class introduces.
- **Generate the entry mechanically from the diff and forbid hand-editing.** This
  removes the self-authorship worry entirely, and it cannot work: `dissents`,
  `notCovered`, `caveats` and the rubric objections are judgements the diff does
  not contain. A generator would have to invent them or leave the page's most
  useful content empty.
- **Leave `refresh-runs.json` out of the class and have CI open the backfill
  pull request.** This moves the write into a workflow with `contents: write`,
  which ADR 0001 and ADR 0003 both work hard to avoid, in exchange for the same
  outcome this decision reaches without a new credential.
- **Drop the ledger and render the page from the GitHub API.** ADR 0001 forbids
  it: the site is static and fetches nothing at runtime. It would also make the
  public record depend on an API that can rewrite its own history.

## Guardrails

- **This widens ADR 0003 by one file and by one file only.** Any further
  addition to `ALLOWED_PATHS` is its own ADR with its own compensating control.
  "ADR 0006 already widened it once" is not an argument, and citing it as one is
  the failure this guardrail exists to name.
- **`gate-ledger.mjs` may not gain a `--force`, a `--skip`, or an environment
  variable that relaxes it**, on the same terms as `gate-scope.mjs`. Its anchor
  stays computed rather than supplied; a `--base` may only narrow. An
  unrecognised flag exits 2, and exit 2 is never a pass.
- **The grant is conditional on the gate.** If `gate-ledger.mjs` is removed,
  disabled, or reduced to checking the entry against itself, the widening in this
  decision lapses with it and `refresh-runs.json` returns to being out of class.
  A widened class with no cross-check is a state this ADR does not authorise.
- **Do not describe the gate as verifying the entry.** It verifies the entry's
  *numbers* against the diff. Saying more than that is the description error ADR
  0005's guardrails were written to prevent, and the same rule applies here:
  the limit is stated wherever the control is claimed.
- **A run still may not touch anything else.** Widening the class does not widen
  what a run may do. A refresh that finds it needs a schema, component, or
  workflow change still stops and files an issue.
