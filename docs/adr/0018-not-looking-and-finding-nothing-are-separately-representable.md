# ADR 0018: Not Looking And Finding Nothing Are Separately Representable

- Status: Accepted
- Date: 2026-09-05
- Decision owners: ModelTree maintainers
- Supersedes: nothing. This ADR generalises a shape the repository has already
  adopted twice for its **data** — ADR 0008 and ADR 0011 each gave an enum an
  explicit `unknown` member so that "no accessible source states this" stops
  sharing a representation with a stated value — and applies the same shape to
  **readings**: what a probe, a checker, a gate or a sweep returns. Neither of
  those ADRs is altered, no schema changes, and no enum gains a member. ADR 0005
  is likewise untouched and is named here as the earliest instance of the
  property rather than as something replaced: it fixes the evidence gate's claim
  at *form*, and its whole substance is refusing to let that instrument's limit
  read as a claim about remote content. Nothing here widens the ADR 0003
  qualifying class — this decision authorises no dataset edit — and nothing here
  changes gate behaviour, thresholds, or CI configuration.

## Context

### The finding, and why it had nowhere to live

A generalisation covering defects this repository has filed separately at least
eight times was stated once, in a comment on abdeslam-menacere/ModelTree#903:

> Every one is a fact about the instrument or its vantage point, presented as a
> fact about the subject. The fix is always the same and always cheap: make the
> two states **separately representable**, so "I did not look" cannot be encoded
> in the same value as "I looked and nothing had changed".

That issue is closed. The rest of the finding lived in session transcripts,
which end. Nothing routed a later agent to either, which made rediscovery the
only retrieval mechanism — and rediscovery is exactly what the eight instances
below demonstrate is unreliable.

This is the reasoning the governing instructions already apply to `DOCK.md`:
that file is untracked, so anything recorded only there is beyond the reach of
every later reader and of the gates, which judge from the issue text and the
diff. A comment on a closed issue is better than that and not by much.

### The instances

Five were catalogued on abdeslam-menacere/ModelTree#903:

1. A matcher reporting `absent` that was never shown able to report `present`.
2. A preflight check that was **not selected** read as **passed**.
3. A conflicted `merge-tree` whose well-formed tree OID was compared while its
   non-zero exit status went unread.
4. A ledger read from a stale working tree, reported as the state of the dataset.
5. A refresh run that examined 3 of 44 creators and closed `no-change` — a claim
   about *what was examined*, published as a claim about *the world*.

Three more were measured on 2026-09-05 and are recorded on
abdeslam-menacere/ModelTree#971 and abdeslam-menacere/ModelTree#186:

6. Counting a parsed JSON result inline in PowerShell 5.1 destroys the arity it
   appears to report. This is the worst member found so far, because it defeats
   the standard remedy: a two-arm control returns the expected shape on both
   arms, so it looks like it passed while having lost all discriminating power.
7. `.github/skills/modeltree-gates/scripts/gate-evidence.mjs` returns the same
   status for "refused correctly", "could not run" and "you called me wrong".
   Read as a status alone, one of those is a confident false pass.
8. Probing the wrong tool entirely: abdeslam-menacere/ModelTree#166 concerns the
   Python updater, and a Node gate of a similar name was probed instead. Its
   clean refusal was shaped exactly like a fix.

Three more were committed by the coordinating session on 2026-09-05, *after* it
wrote abdeslam-menacere/ModelTree#974, and they are the strongest available
argument that this needs a document rather than a memory:

9. A dock's own "not landed" report adopted rather than measured. **A dock is
   the party structurally least able to know whether it has landed**, because
   nothing inside a worktree changes when its branch merges. Its report is a
   fact about its vantage point.
10. A branch name generated from a change description rather than resolved from
    the bound SHA. Two refs pointed at that SHA, so a name is not an identity
    here — and a name derived from what a change *does* looks right while being
    wrong.
11. Rows of a staleness sweep whose `merge-tree` status was non-zero — meaning
    conflict markers were written into the printed tree, which supports no
    comparison at all — printed under a heading asserting they were live.

They share one structure, and so do the further instances recorded in the two
subsections below:

| Instrument or vantage fact | Reported as a subject fact |
|---|---|
| a dock cannot observe its own merge | "this work is unlanded" |
| a name generated from a description | "this is the branch" |
| a tree containing conflict markers | "this branch is live" |
| a scan that covered part of a set | "the set is unchanged" |
| a check that was not selected | "the check passed" |
| a reference ref last refreshed hours ago | "trunk is at this commit" |
| an empty branch merging cleanly | "this work already shipped" |
| a merge that would change trunk | "this branch never landed" |
| a count that excludes blank lines | "the file is this long" |
| an instant re-expressed in local time | "this happened at this UTC time" |

### The sharpest instance: a control proves discrimination, not currency

The stale-reference and empty-branch rows above were added on 2026-09-05 and
they are the reason this ADR has four obligations rather than three. Two docks
handed back `NOT LANDED` about
work already on `main`, and neither failed for want of a control.

**abdeslam-menacere/ModelTree#709** reported both conjuncts with a positive
control, a negative control and a flagless control, having already caught and
corrected a false `PRESENT` in its own content probe. The same fix was already
on trunk via abdeslam-menacere/ModelTree#919, and the issue was closed.

**abdeslam-menacere/ModelTree#866** ran the whole procedure with a control on
every instrument — a closed issue against an open one, a real pull request
against a fabricated branch, a real marker against a fabricated token — and
concluded its markers were absent from trunk. They were present. Its comparison
was taken against one trunk commit while trunk stood at another, and it recorded
its anchor as verified current, which it had been earlier in the same session.

The mechanism is not a defective control, and this is what makes the case worth
its own subsection:

> **A control proves that the instrument discriminates. It says nothing about
> whether the instrument is pointed at the present.**

Both docks proved their probes could tell present from absent, then aimed them
at a trunk from hours before. A remote-tracking ref moves only when something
fetches, so a probe that does not fetch reports the time of its last fetch with
total confidence and a full set of passing controls. That is the same
instrument-fact confusion at one remove — *my reference ref says X*, published
as *trunk is X* — and control-doubling cannot reach it, because every control is
equally stale.

The failure has a direction, and the direction is why it survives. A stale
anchor errs toward "not landed", which is the safe answer for correctness and an
expensive one for a pipeline: it buys a redundant review-and-QA cycle over a
question trunk had already settled. Both docks also measured early and reported
late, and the interval is where the change they were looking for arrived.

**And one committed inside the sweep that produced the evidence for this ADR.**
That per-session sweep labelled two branches as landed while they carried zero
commits — freshly created docks, one of them the dock that wrote this document.
An empty branch merges into trunk trivially, so "no work yet" and "work already
shipped" came out as the same value, in the very measurement gathering support
for a rule that says to keep them apart.

### The second limit of a control: which quantity is being measured

The currency case above is one thing a control cannot reach. There is a second,
and it is worse because it survives every remedy in this document up to this
point:

> **A control proves that an instrument discriminates between inputs. It cannot
> reveal that the instrument measures a different quantity than the one you
> named.**

A two-arm control passes perfectly against an instrument of this kind, because a
larger subject really does return a larger number and a different input really
does return a different value. The call succeeds, the value is well-formed,
nothing is refused, and the answer is to a question nobody asked.

**The instance that lands on this document's own probe.** Tree equality asks
*would merging this branch change trunk?* Landedness asks *did this branch's
work reach trunk?* Those are different questions, and they diverge the moment a
later commit **edits** the landed content: re-merging would reintroduce the
superseded wording, so the resulting tree legitimately differs from trunk. That
is a correct answer to the question the command asks and a wrong answer to the
question a dock is asking. It therefore fails hardest exactly where a project
edits its own documents most, which in this repository is the instructions file.

Measured here at trunk `04b233dd5363f07a4f7b382cf49ec6a465e398fe` on 2026-09-05,
on two branches whose pull requests the record reports as merged —
abdeslam-menacere/ModelTree#891 and abdeslam-menacere/ModelTree#895:

| branch tip | record | `merge-tree --write-tree` vs trunk | equals trunk tree |
|---|---|---|---|
| `f6dbed39` | MERGED 2026-09-04T19:35:06Z | status 0 | no |
| `a17d4ae2` | MERGED 2026-09-04T22:06:02Z | status 0 | no |

Status 0 on both: no conflict, no error, nothing for a control to catch. The
control that makes those readings findings rather than an instrument saying one
thing to everything was run in the same session — the same invocation against
trunk itself returned status 0 and printed trunk's own tree. Both tips also
reported as non-ancestors of trunk, which is the squash-merge behaviour recorded
elsewhere in these documents rather than a further finding.

The coordinating session, which took the sweep this ADR quotes for scale,
reported on 2026-09-05 that across 430 local branches the tree-equality reading
answered cleanly for 27.2% and that 4 of its 9 *differs* answers named branches
whose pull requests had merged, while a single query of the merged-pull-request
record answered for 82.6% with no error found. Those are that session's dated
readings quoted for the order of the cost, not constants, and a decision turning
on them must re-measure. The mechanism is what carries forward: **a content
probe measures wording and a tree comparison measures would-merging-change-
anything, so post-merge editing defeats both — the same hazard reaching two
structurally different instruments, because both infer a historical event from
the repository's present state.** The record does not infer it; it is a record
of the event, which is why later rewording cannot touch it. That session also
recorded honestly what the record does not do: a rename defeats a lookup keyed
on the branch name, and it correctly says nothing about a branch that has no
merged pull request.

**How that instrument came to be trusted is itself an instance.** It was
promoted on the strength of watching a rival instrument fail once, and its own
error rate was never measured until the sweep above. **Comparative evidence
about instrument B is not a measurement of instrument A**, and "the alternative
failed" is a fact about the alternative.

**Two cheap instances of the same shape**, both measured here on 2026-09-05 on
`PSVersion 5.1.26100.9168`:

*A count that names one quantity and returns another.* On this branch's copy of
the instructions file, the line-counting measurement returned 1711 while the
file held 1996 lines, the difference being its 285 blank lines, which that
measurement does not count; 1711 + 285 recovered 1996 exactly. The number is
plausible on its own and no control detects it. What detected it was a
**contradiction between two readings that cannot both be true**: a heading
located at line 1927 in a file reported to have 1711 lines. That, and not the
implausibility of any single figure, is the tell worth generalising.

*A cast that silently changes the quantity's frame.* Casting an ISO instant
bearing `Z` to a date type on this host produced a value in local time —
`2026-09-04T19:35:06Z` became `15:35:06` at offset `-04:00`, with the value's own
kind field reading `Local`. The sharpest part is where the error hides: the
interval between two such values came out **identical** whether computed from the
shifted values or from the correctly parsed instants, so the derived column that
a careful reader cross-checks is invariant under the error. Cross-checking a
derived quantity is therefore not a check on the quantity it was derived from.

### What makes the class expensive rather than merely untidy

Every instance produces a **green reading from a broken instrument**. The
failure mode is not noise, it is false confidence, and the gates cannot catch it
because the gates use the same instruments.

One measurement fixes the scale. A sweep of local branches carrying commits
ahead of trunk, run by the coordinating session on 2026-09-05 and recorded on
abdeslam-menacere/ModelTree#974, read **379 branches, of which 108 — 28% — had
trees byte-identical to trunk**, meaning the work had already shipped. On that
reading, "a branch exists with commits on it" is evidence of outstanding work
that is wrong more than a quarter of the time. Narrowed by the same sweep to the
sessions created that day, 3 of 56 carried work that was both live and
comparable; the rest had landed or could not be compared, and "could not be
compared" is its own state rather than a quiet member of either other one. Those
figures are dated readings and not constants: they are quoted to show the order
of the cost, and a decision that turns on today's rate must re-measure rather
than cite them.

### Four readings taken while writing this ADR

These were measured here rather than adopted, which is the finding applied to
its own evidence. Each is a reading at a pinned anchor and an explicit date, not
an expectation about a future run; anything depending on one must re-measure it.

**A single status covering two outcomes, in the probe this repository leans on
most.** At trunk `04b233dd5363f07a4f7b382cf49ec6a465e398fe` on 2026-09-05, on
`git 2.53.0.windows.4`, `git merge-tree --write-tree` returned status 1 both for
a genuine content conflict — printing a well-formed 40-character tree OID on
stdout, with `CONFLICT (content)` lines naming the files — and for an operand
that did not resolve to anything mergeable, where the message went to stderr and
no OID was printed. The status alone did not separate "these two commits
conflict" from "I could not read one of your operands", and the first of those
printed something that a caller reading stdout alone has no way to reject.

**The array-arity collapse, on this machine.** On `PSVersion 5.1.26100.9168`,
the mechanism is structural rather than incidental: the JSON conversion emits a
parsed array as a *single* object, so wrapping that object in an array
subexpression yields a one-element array whatever the parsed array contained.
Measured on that host, the resulting count was identical for input arrays of
zero, one and two elements. A control built from two such arms therefore agrees
with itself no matter which arm is which. The same host separated the cases when
the raw output string was compared before parsing, and when a filter's result
was wrapped before its count was read. Re-measure against your own
`$PSVersionTable.PSVersion` rather than carrying those readings forward.

**The vacuous reading, taken on this branch before it had committed anything.**
At the same anchor, with the branch that produced this document standing zero
commits ahead of its merge base, `git merge-tree --write-tree` against trunk
exited 0 and printed a tree byte-identical to trunk's own. That is the reading a
wholly landed branch produces, and the two are not separable in it: the datum
that tells them apart is the commit count, which the equality does not carry.
The sweep instance above is that collapse committed at scale; this is the same
collapse reproduced deliberately, on the dock writing the rule against it.

**The positive half, which deserves stating as loudly as the warnings.** At the
same anchor, `git merge-tree --write-tree` was run against the commit that
preceded abdeslam-menacere/ModelTree#978 on trunk and the head that pull request
merged. It exited 0 and printed
`71dca6e8e10d4982323a4137098caefc4e8ab29b`, which is byte-identical to the tree
of the squash commit that landed — so the probe computed the real post-merge
result rather than approximating it, and did so **despite squash merging**,
which is precisely what defeats `git merge-base --is-ancestor` and `git cherry`.
The control that makes that a finding rather than an instrument saying one thing
to everything was run in the same session: the same invocation on a pair that
must not produce that tree printed a different OID at status 0, and an
unresolvable operand was refused. This ADR is not an argument for distrusting
instruments. It is an argument for reading what they actually say.

Read that reading for exactly what it is, because the subsection above measures
the limit of the same command. What was established is that the probe computes a
real post-merge tree, which is a fact about *merging*. It is not an endorsement
of tree equality as an answer to *did this land*, and the two branches measured
above are why: both landed, and both returned a differing tree at status 0.

### The rule already implemented here, which is the shape to copy

Nothing in this decision is novel to the repository — one script already does
all of it, and it is a better anchor than any invented example.
`web/scripts/asset-drift.mjs` prints a tree-provenance block beside its figures.
It names which tree it measured and which tree CI builds; it prints the ref it
compared against, that ref's commit, and how far behind it stands; it carries
three states rather than two, and its own comment records that the undetermined
one is never rounded to level, because a probe that could not answer has not
established that the branch is level with trunk. It states in the level case
that the ref is a local cache which moves only when something fetches, so
"level" means level with the last trunk the checkout saw. It even names the
exception where its figure would come out *lower* than CI's rather than higher,
so a reader is not left to assume the error has one direction. And the report
prints its denominator next to its counts, on the stated ground that a count of
zero problems proves nothing unless what was counted over is visible.

That is a reading published with its instrument, its vantage, its currency and
its coverage attached. Read that module rather than taking this paragraph's word
for what it prints, so the description and the script cannot drift apart. The
obligations below are that practice generalised.

### Why the class keeps returning

Each instance was fixed where it was found: a scanner hardened, a checker's exit
contract documented, a control widened. The instructions file already carries
the negative half of the property — a negative result is a claim, and a claim
needs a control that would have come back positive — but it carries it inside
the landedness procedure, attached to the probes of that procedure, which is not
where an agent writing a gate or a refresh report is reading. Instances 6, 7 and
8 all sit outside landedness entirely.

Fixing instances finds instances. Only the property finds the class, and the
property has never been written down anywhere durable.

## Decision

**A reading is a fact about the instrument that produced it and about the
vantage point it was taken from. It becomes a fact about the subject only once
the instrument has been shown able to return something else.**

The general form is representational: **"I did not look" must never share a
representation with "I looked and nothing was there."** Where one value carries
both, the report is not wrong so much as unable to be right, and no amount of
care downstream recovers the distinction.

Four obligations make that checkable. They are stated as properties, so that
they apply to a command, a flag, a shell construct or a report format that
nobody has enumerated:

**1. Discrimination before evidence.** A control earns its keep by *differing*
from the subject, in the same run, with the same quoting and the same arguments.
What must be established is that the arms came back different — not that one arm
returned the shape that was anticipated. A control whose arms agree has measured
nothing, however many arms it has, and it fails in the direction that looks like
success. The same reasoning forbids the tempting shortcut of validating a
questionable form by agreeing with a sound one: two forms returning the same
answer on one input does not establish that they answer the same question, and a
coincidence is indistinguishable from equivalence at a single point.

A control has two limits, and neither is repaired by adding more controls.
**It cannot show that the instrument is pointed at the present** — obligation 3
— and **it cannot show that the instrument measures the quantity you named for
it.** A control passes cleanly against an instrument that answers a neighbouring
question, because a different input really does return a different value. So
name the quantity the instrument returns, in its own terms, before naming the
quantity you wanted; where the two differ, establish what makes them diverge and
report the reading in the terms it was actually taken. Comparative evidence is
not a substitute: watching a rival instrument fail is a fact about the rival,
and it measures nothing about the one adopted in its place.

**2. A value covering several outcomes is not evidence on its own.** Where one
exit status, one empty result or one output value can be produced by more than
one distinct outcome, it must be read alongside something that separates them,
and the report must say which outcome was observed. Statuses that fold "refused
correctly", "could not run" and "called wrongly" together are the common case
here, and so is an empty result that a failed call and a successful search both
produce. A **degenerate input** belongs to this obligation and is the member
most often missed: where an empty, trivial or zero-sized subject produces the
same value as a real one, that value cannot be read at all until the subject's
size is established and reported beside it.

**3. A reading carries the vantage it was taken from, in space and in time.**
Where the observer stood and when it looked are properties of the reading, and
neither is recoverable from the value afterwards, so both are reported with it.
In space: **an observer that cannot see a state is not evidence about that
state**, however confidently it reports, and where the vantage point is itself
what is being asked about, the answer has to come from an instrument standing
somewhere else. This is what makes a dock's report about its own landedness
inadmissible. In time: a comparison against a cached or mirrored reference is
only as current as the last thing that refreshed it, so the identity of that
reference is part of the result — report the anchor, not only the verdict — and
the reading is taken at the moment it is reported rather than earlier in the
session. A control cannot substitute for either half: it establishes that the
instrument discriminates, and says nothing about where or when it was pointed.

**4. Not-looked stays separately representable from looked-and-found-nothing.**
Any report that could have been produced without looking must carry that
distinction in a form a later reader can see: what was selected and what was
not, what was examined out of what set, what refused. A check that was not
selected is not a check that passed. A scan covering part of a set has not
reported on the set, and a count of zero findings means nothing without the
denominator it was counted over.

**This ADR is the normative statement, and
`.github/copilot-instructions.md` carries a short pointer to it rather than a
copy.** The instructions bind behaviour and are read by every agent
automatically; an ADR records a decision and holds the evidence. Duplicating the
full text into both is how two statements of one rule drift apart, so the
instructions name the property and the four obligations and point here for the
instances and the measurements.

**Nothing written under this decision may name a probe and also predict that
probe's result.** The instructions state that rule about themselves and it binds
this ADR with full force: a predicted result is not re-tested, so a wrong
prediction and a false negative confirm each other and survive every reading.
Every measurement above is therefore pinned to an anchor and a date and marked
as a reading rather than an expectation. Say how to find out; never say what
will be found.

## Consequences

### Positive

- The finding survives the sessions that produced it, and is reachable by a
  reader who does not know which issue it came from — which is the acceptance
  criterion abdeslam-menacere/ModelTree#974 was filed to meet.
- The rule is stated as a property, so it reaches constructs nobody has
  enumerated. The four obligations apply to a shell idiom, a checker's exit
  contract and a refresh report equally, and none of them names a command.
- The negative-result rule already in the instructions is given its general
  form. It stops being a rule about landedness probes that happens to be true
  elsewhere.
- **Currency is separated from discrimination**, which is the part no existing
  rule here covered. Two docks with complete control apparatus were wrong on the
  same day for the same reason, and neither would have been caught by a further
  control.
- **The quantity an instrument measures is separated from the quantity it is
  asked for.** This is the limit of a control that survives every other remedy
  here, and stating it protects the reader from the specific mistake of reading
  this document's own positive result about `merge-tree` as a landedness test.
- Reporting the anchor makes a stale reading detectable by a later reader rather
  than only by the reader who took it — the property the tree-provenance block in
  `web/scripts/asset-drift.mjs` already demonstrates.
- Instance 6 is recorded with its mechanism rather than its symptom, so a reader
  can recognise the same collapse in a construct that is spelled differently.
- The positive result is recorded beside the warnings, so the outcome of reading
  this is a probe used correctly rather than a probe distrusted.
- It composes with what the repository already decided about its data: ADR 0008
  and ADR 0011 made "no source states this" separately representable in the
  schema. This is the same move for readings, so one idea now covers both.

### Costs

- **A property is harder to comply with than a checklist, and nothing enforces
  it.** No code checks that a control discriminates. This is prose that binds an
  agent's judgement, and an unattended run that ignores it fails silently — the
  same standing limitation the instructions state about the gate-independence
  rule. It is accepted here rather than dressed up as enforcement that does not
  exist.
- **It adds a fourth obligation to reading any probe**, and the discrimination
  requirement in particular costs an extra invocation every time. That is a real
  tax on every measurement, paid on runs where the instrument was fine.
- **Taking a reading at report time costs a second measurement** on any run
  whose work spans hours, and the earlier one is then discarded. That is the
  price of the currency obligation, and it is paid on every run, including those
  where nothing moved underneath.
- **Reporting anchors makes reports longer.** A verdict with its anchor,
  denominator and vantage attached is several lines where one word used to do,
  and on a report nobody re-reads that is pure cost.
- **An ADR is not automatically read.** Nothing routes an agent to
  `docs/adr/` unless something points there, which is why the pointer in the
  instructions is load-bearing rather than decorative. If that paragraph is ever
  removed, this document goes quiet in exactly the way the comment on
  abdeslam-menacere/ModelTree#903 did.
- **The instructions file grows**, and it is already long and heavily read. The
  pointer is kept to a short section for that reason, which means the interesting
  material — the instances — is one hop away from where the rule is stated.
- **The measurements in this document decay.** They are pinned to a trunk SHA, a
  git version and a PowerShell version precisely so that a reader can tell a
  stale reading from a current one, but a reader who skips the anchor will carry
  a figure forward. That risk is inherent in recording evidence at all, and the
  alternative — a rule with no evidence — is worse.

## Alternatives Considered

**Put it only in `.github/copilot-instructions.md`.** This was the issue
author's stated weak preference for the *rule*, and it is adopted for the rule.
Rejected for the whole finding, because the instances are what make the property
recognisable and they run to several pages: instance 6 in particular is
counter-intuitive and needs its mechanism explained, and instance 11 needs a
worked reading of a status code. Putting all of that into the file every agent
reads first would bury the rule in its own evidence. The file is also the most
contended document in the repository, with five issues queued against it
(abdeslam-menacere/ModelTree#971, abdeslam-menacere/ModelTree#799,
abdeslam-menacere/ModelTree#828, abdeslam-menacere/ModelTree#909 and
abdeslam-menacere/ModelTree#927), and a large addition there collides with all
of them while a short one does not.

**Put it only in an ADR.** Rejected. Nothing routes an agent to `docs/adr/`
unless something points there, so an ADR alone reproduces the defect being
fixed: a durable record that no reader is sent to. The instructions already
demonstrate the working pattern, pointing at ADR 0003 for the one class of
change it governs rather than restating it.

**Write the rule as a list of constructs to avoid.** Rejected, and this is the
substance of the decision rather than a style preference. A list finds
instances; only a property finds the class. The repository has evidence on both
sides: the false-absent defect was fixed three times for three different
scanners — abdeslam-menacere/ModelTree#406,
abdeslam-menacere/ModelTree#350 and abdeslam-menacere/ModelTree#345 — without
the property being recorded, and returned against the next one each time. The
shell-quoting rule went the other way, naming the characters that make an
argument shell-dependent rather than the commands that had been seen to break,
and it has held.

**State the rule as "add more controls".** Rejected on the evidence that
prompted the fourth obligation. Two docks on 2026-09-05 carried a control on
every instrument, in both directions, and were wrong about the same thing for
the same reason: their controls were as stale as their subject, because a
control run against a stale anchor is stale too. Control density is orthogonal
to currency, and a rule that asks for more of the first while saying nothing
about the second buys effort and no accuracy. The same holds for the second
limit: a control passes cleanly against an instrument answering a neighbouring
question, so control density does not reach that either.

**Add a checker that enforces it.** Rejected here as out of scope and doubted on
the merits. Out of scope because abdeslam-menacere/ModelTree#974 explicitly
excludes changes to gate behaviour and CI configuration. Doubted because the
obligations are about whether a reading *means* what a report says it means,
which is not decidable from the text of a command: a control whose two arms
happen to agree is syntactically identical to one that discriminates. A checker
sweeping for known-bad spellings would report green while an unenumerated
construct returned the same wrong answer — which is itself an instance of the
property, one level up. Anything mechanical here belongs to a separate decision
with its own evidence.

**Fold it into abdeslam-menacere/ModelTree#971, which is instance 6 in
isolation.** Rejected, and deliberately left separate. That issue is a concrete
defect with a concrete remedy and can land on its own terms; this is the
generalisation that explains why the remedy matters. Folding them would make the
narrower fix wait on the broader argument, and the file that both would touch is
contended enough that a smaller diff on each is worth more than one large one.

**Leave it on abdeslam-menacere/ModelTree#903.** Rejected as the status quo
under examination. A comment on a closed issue is reachable only by a reader who
already knows it exists, which is the retrieval model that failed eight times.

## Guardrails

- **A control is reported with what its arms actually returned, and both arms
  are run in the same invocation with the same quoting.** A report that names a
  control without stating that its arms differed has not established
  discrimination, and the reading it guards is unestablished with it.
- **A status code is never the whole of a reading where the tool can produce it
  for more than one outcome.** Establish which outcomes the tool folds together
  — the gate scripts state their contract in
  `.github/skills/modeltree-gates/SKILL.md`, and a tool that documents none is
  one to probe — and report the accompanying output that separates them.
- **A refusal is reported as a refusal.** "Could not determine" is never rounded
  to whichever verdict is convenient, in either direction. This restates the
  rule the gate scripts already hold, that a status meaning "could not run" is
  never a pass, and generalises it to any reading.
- **A comparison is reported with the reference it was taken against**, named
  and resolved, and taken at the moment it is reported rather than earlier in
  the session. A cached or mirrored reference is only as current as whatever
  last refreshed it, and a reading that does not carry its anchor cannot be told
  from a current one by anybody downstream.
- **A degenerate subject is its own state.** Where an empty, trivial or
  zero-sized input produces the same value as a real one, the subject's size is
  established and reported before the value is read. A tree-equality check in
  particular states the commit count it was taken over.
- **A report states its own coverage.** What was selected and what was not, what
  was examined and out of what set. An unselected check is recorded as
  unselected; a partial scan states its denominator. This is what keeps a claim
  about a sample from being published as a claim about the population.
- **A reading is reported in the terms the instrument returns it.** Name the
  quantity the tool actually produces before naming the quantity that was
  wanted, and where they differ, say what makes them diverge. A tool that
  answers a neighbouring question does so at a clean exit with a well-formed
  value, so nothing downstream will raise it.
- **Two readings that cannot both be true are a finding, not a discrepancy to
  reconcile.** An index beyond a reported extent, a total that its own parts
  overrun, a member outside a reported set: these detect a mismeasured quantity
  that no control and no plausibility check will reach. Where a second reading
  of the same subject is available cheaply, take it for this reason.
- **A derived quantity is not a check on what it was derived from.** Where an
  error shifts several inputs equally, differences and ratios computed from them
  survive it unchanged, so agreement in a derived column is not evidence about
  the column it came from.
- **An instrument is adopted on its own measured behaviour, never on a rival's
  failure.** "The alternative was wrong" is a fact about the alternative.
- **No text added under this decision names a probe and predicts its result.**
  Measurements are pinned to an anchor and a date and marked as readings.
  Guidance says how to find out.
- **The pointer in `.github/copilot-instructions.md` stays.** It is the only
  thing routing a reader here. Removing it, or letting it drift into a second
  copy of this document, reopens the failure this ADR closes — the first by
  making the record unreachable, the second by creating two statements of one
  rule that can disagree.
