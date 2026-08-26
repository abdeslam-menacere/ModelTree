# ADR 0005: The Evidence Gate Verifies the Form of a Citation, Not Its Remote Content

- Status: Accepted
- Date: 2026-08-26
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It records a bounded limit of `gate-evidence.mjs` and names
  what compensates for it. It neither narrows nor widens the invariant stated in
  `.github/copilot-instructions.md` §"The invariant". It does not modify ADR 0003;
  it describes a property of one of the gates ADR 0003's precondition 4 relies on,
  and its Guardrails below constrain how that limit may be described going forward.

## Context

`gate-evidence.mjs` requires every claim to carry, per evidence item, a
`contentHash` shaped `sha256:` + 64 hex characters and a `quote` of at least
`MINIMUM_QUOTE_LENGTH` characters. It validates the **shape** of both fields. It
does not — and cannot, as currently built — verify that the digest is the hash of
the page at `url`, nor that the quote appears on that page, because the gate
fetches nothing. It is deterministic and offline by construction (see ADR 0003's
reliance on a gate that runs the same way every time), and the ground truth for
both fields lives on a third party's web server, not in this repository.

Both fields are therefore **self-authored by the subject of the gate**: the
audited refresh run writes them, and the gate checks them against nothing but a
regular expression. A run can present a fabricated `contentHash` and an invented
`quote` and the evidence gate passes it. This was found by the QA gate on #209,
constructing a change that obeys #209's guardrail literally and still fails open,
and it is the same family as #233 (a self-declared value believed rather than
derived).

It is, however, the **hardest** member of that family. #233's policy is derivable
from committed repository state, so the fix there is to derive it. A content hash
is not: nothing in the repository is a trusted, non-subject source for "what the
page said on the day it was read". There is no offline path by which the value can
enter the bundle other than from the run that is being audited.

This matters concretely because ADR 0003 enables an unattended publisher: no human
reads the citation before merge. The evidence gate is the control that is supposed
to make a source-backed claim actually source-backed.

## Decision

**The evidence gate verifies the form of a citation, not its remote content, and
this limit is accepted and stated plainly rather than closed by a fetching gate.**

Concretely:

1. `gate-evidence.mjs` keeps refusing, closed, on any malformed or missing
   `contentHash`, `fetchedAt`, `quote`, `url`, or `retrieval`. Form is enforced;
   nothing about that is relaxed.
2. The gate makes **no** claim, in code comments, messages, or documentation, that
   it verifies the hash is the hash of the cited page or that the quote appears
   there. Any existing text implying otherwise is corrected. This is a standing
   obligation on all three channels, not a report that no such text remains:
   `SKILL.md` and `reference/claim-bundle.md` were corrected in the change that
   recorded this ADR, `gate-evidence.mjs` was outside that change's scope and was
   corrected in #278, and any instance found later is a regression to fix rather
   than an exception to this item.
3. What compensates for the unverified remote content is named and relied upon: the
   pull-request trail every refresh leaves, the revert path, the dataset-JSON-only
   scope of what a refresh may change (ADR 0003 precondition and the
   `gate-dataset` scope rule), and human review of the merged result. The evidence
   gate proves a citation was **formed**; these prove it can be **checked and
   undone** after the fact.

### Why the rejected options were rejected

- **Fetch and verify in the gate (option 1).** Rejected. It introduces a network
  dependency into a gate that is deterministic and offline, on which ADR 0003
  depends. Pages legitimately change after capture, so a hash correct at capture
  time would fail at gate time — turning a soundness control into a flaky one. The
  only way to keep it non-flaky is to downgrade a mismatch to a warning, and a
  warning re-opens exactly the hole this ADR is about. Fail-closed fetching would
  block honest refreshes on unrelated upstream edits; that is a worse failure than
  the documented limit.
- **Verify at capture time in a non-subject component (option 2).** Rejected as
  inapplicable here, though it is the right move for #233. For #233 the trusted
  component is repository state. For a content hash there is no non-subject
  component: the only actor that reads the remote page is the scout, and the scout
  *is* the audited run. Relabelling the scout "trusted" would not move trust out of
  the subject; it would only hide that it never left. The reviewer note on
  `gate-evidence` — "inference is the same defect wearing a heuristic" — and #209's
  corollary that a derivable value must be derived are reconciled by observing that
  this value is **not** derivable from any source the gate can trust, so neither
  rule compels inventing a derivation for it.

## Consequences

### Positive

- The gate stays deterministic, offline, and non-flaky; ADR 0003's reliance on it
  is unaffected.
- The documentation no longer overstates what the gate proves, so no reader treats
  a passing evidence gate as proof a source says what a claim asserts.
- The limit is now a written, auditable boundary with a named compensating control,
  rather than an unstated assumption a reader might mistake for verification.

### Costs

- A run that fabricates a well-formed `contentHash` and an invented `quote` still
  passes the evidence gate. This is the accepted limit; it is bounded by the
  compensating controls above and is not closed by this ADR.
- Anyone later tempted to add fetching must weigh the flakiness cost recorded here
  before reopening the question.

## Alternatives Considered

Options 1 and 2 above, both rejected for the recorded reasons. A hybrid — fetch but
only warn — was rejected with option 1 because a warning re-opens the hole. Doing
nothing and leaving the overstated documentation in place was rejected because AC4
of the originating issue requires the documentation not to overstate what the gate
proves.

## Guardrails

- No code comment, message, or documentation of `gate-evidence.mjs` may state or
  imply that it verifies a hash against its page or a quote against its source.
  It verifies **form**. Text asserting content verification is a regression
  against this ADR in any of those three channels. They are named here in the
  same terms as Decision item 2 because this Guardrail previously said only
  "documentation"; #278 resolved that disagreement in favour of the Decision,
  which is the operative statement, and found three surviving overclaims in code
  comments and one in a refusal message — precisely the channels the narrower
  wording had excluded. A refusal message is the channel that matters most in
  practice: it reaches an operator at the moment the gate refuses, which is when
  a false claim of verification is most likely to be believed.
- If a future change makes the gate fetch, it must fail **closed** on a mismatch
  (a warning is not admissible here), and it must state how it stays non-flaky
  against legitimate page changes, or it does not land.
- The compensating controls named in the Decision — PR trail, revert path,
  dataset-JSON-only scope, human review of the merged result — are what this limit
  rests on. A change that removes one of them without replacing it reopens this
  decision.
