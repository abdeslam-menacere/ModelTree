# ADR 0012: Lifecycle Status Does Not Decide Editorial Featuring

- Status: Accepted
- Date: 2026-09-02
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It settles a question the `featured` procedure recorded
  beside `releaseSchema.featured` left open, and adds one step to that
  procedure. It does **not** touch ADR 0008's `lifecycleStatus` vocabulary, and
  it does **not** widen the ADR 0003 qualifying class — a schema and policy
  change is outside that class, so this decision takes the ordinary reviewed
  path and does not reach `main` unattended.

## Context

Issue #788 (consolidating #801) reports that the catalog holds, and has held
since Claude 5.1 landed in #778:

```
anthropic-claude-fable-5     status=legacy   featured=true
anthropic-claude-fable-5-1   status=current  featured=false
```

Nothing here is unsourced, no gate is wrong, and no test is missing. The dataset
is telling the truth. What the issue asks is a policy question, and it is the
question the pinned procedure does not answer: **may `featured` coexist with
`status: legacy`?** The issue frames the choice as whether `featured` means
"a good entry point into this creator's work today" or merely "notable", and
observes that those give opposite answers.

### What the flag actually is

The procedure beside `releaseSchema.featured` answers neither, because the flag
is not a statement about the release. It says, verbatim, that a release is
flagged so "that each one reaches the Featured branch, **because a creator is
featured exactly when it holds a featured release and the schema carries no
organization-level flag**".

Two consumers say the same thing in code:

- `web/src/lib/model-tree.ts:88` — "Featured membership is decided at creator
  level, not release level: one featured release makes the whole creator
  featured, and every one of its releases stays with it rather than being split
  across the two branches."
- `web/src/lib/lineage-view.ts:280` — "A creator is featured when it has at
  least one featured release … there is no organization-level flag in the
  schema."

So the release-level flag is the **carrier for a creator-level routing
decision**. Its four ordered steps select *creators*; none of them says which
release inside a creator to flag, beyond "at least one". The dichotomy the issue
offers is therefore a false one, and the honest answer is that the procedure
underdetermines the choice rather than that it settles it either way.

### What the site does with it, measured

The issue's body says the site "puts forward" the legacy release. Measured
against trunk `fb189231`, that is not what any surface does:

- `/tree` groups at creator level and shows **all ten** Anthropic releases,
  `claude-fable-5-1` included. No release renders a featured badge.
- The homepage lead view admits a *family* holding a featured release. Family
  `anthropic-claude-5` also holds `anthropic-claude-opus-5` and
  `anthropic-claude-sonnet-5`, both `current` and both flagged, so it reaches
  the homepage whatever `claude-fable-5` does.
- `ModelPassport.tsx:277` publishes the rationale verbatim, as "Featured in
  ModelTree because …", on the release's own page.

Only the third is reader-facing for this record, and it is the rationale rather
than the flag that a reader sees.

### The state of the featured set

24 releases are flagged, across the five named creators. Six are not `current`:

| release | status | creator |
|---|---|---|
| `anthropic-claude-fable-5` | legacy | anthropic |
| `meta-llama-3-1-405b` | legacy | meta |
| `meta-llama-3-3-70b` | legacy | meta |
| `google-gemini-3-5-flash` | legacy | google-deepmind |
| `google-gemini-3-1-pro-preview` | preview | google-deepmind |
| `microsoft-mai-thinking-1` | preview | microsoft |

Two of those rationales feature the release **because** it is old:
`meta-llama-3-1-405b` reads "Historically important: the largest Llama 3.1
size". Featuring a superseded release is therefore existing, deliberate
practice, not an oversight confined to Anthropic.

## Decision

**Lifecycle status does not decide the `featured` flag, in either direction.** A
`legacy` release may stay flagged; a `current` release is not owed the flag.
What a flagged release owes instead is a `featuredRationale` that says why *that*
release carries its creator's placement, in terms that stay true once the
release is superseded and that could not be written of another release of the
same creator.

Three measurements drove it.

**1. Deriving the list from `status` would make it a ranking.** `status` is a
sourced measurement. A rule of the form "featured must not be legacy" makes
membership a function of recency, which is an order, computed from data. The
procedure states that the list "records what this site leads with, which is a
choice about its own entry point rather than a measurement of the creators" and
that "it states no order, no score". A recency rule contradicts that directly,
and #788 names it out of scope in the same words: this issue must not become the
thing that makes featuring a ranking.

**2. The strict form is structurally impossible.** `featured ⇒ current` cannot
be enforced without either breaching the schema's own at-least-one requirement or
making an unreviewed editorial change. Microsoft holds exactly two releases —
`microsoft-mai-thinking-1` (`preview`, flagged) and `microsoft-fara-1-5-27b`
(`current`, unflagged). Enforcing "current" takes Microsoft to zero featured
releases, and the only escape is to re-flag Microsoft, which nobody reviewed.

**3. The weaker form has a measured cost.** `featured ⇒ ¬legacy` is
structurally possible — no creator drops below one — but family
`meta-llama-3` (`status: legacy`) reaches the homepage **only** through
`meta-llama-3-1-405b` and `meta-llama-3-3-70b`, the two flagged legacy releases.
Clearing both removes the entire Llama 3 generation from the homepage, and
deletes a recorded editorial judgment ("Historically important: the largest
Llama 3.1 size") to satisfy a lifecycle field. That is the smoothing-over this
repository forbids.

The reader-facing defect #788 identifies is real, and it is the rationale. On
trunk, `claude-fable-5` carried "A widely released Claude model with a dated
general-availability statement in the official model documentation" — true
verbatim of `claude-fable-5-1`, and of `opus-5`, `sonnet-5` and `haiku-4-5`
besides. A rationale that cannot distinguish its release from its successor
records no decision at all, and it is what a reader actually sees on the
passport. That is what this change fixes.

## Consequences

### Positive

- The question is settled as a rule about every creator, written where the next
  refresh will read it, so it stops being re-raised per release.
- The rule has teeth that reviewer vigilance did not: a flagged `legacy` release
  must now state why it keeps its placement, enforced in
  `web/src/data/featured-policy.test.ts`.
- The `featured` list stays an editorial choice rather than becoming a
  derivation from lifecycle data, so the "not a ranking" guarantee survives
  intact.
- Anthropic's featured count is unchanged at four, and no creator's featured set
  changes at all.
- Claude Fable 5's passport now tells a reader that Anthropic files it under
  Legacy models and directs new work to Claude Fable 5.1 — strictly more
  information than the flag alone conveyed, and the thing the issue found
  missing.

### Costs

- The rule is enforced over flagged `legacy` releases only. A `current` flagged
  release whose rationale is equally generic is not caught, and two exist:
  `google-gemini-3-6-flash`'s rationale is true as written of
  `google-gemini-3-7-flash`, and the three GPT-4.1 seed rationales are identical
  to one another. Widening the class would force edits to creators #788 places
  out of scope, so the shortfall is recorded here rather than closed, and is
  filed as a follow-up.
- The discrimination check is a documented list of reference kinds, not a
  decision procedure for English. It can pass a rationale that happens to
  contain "only" incidentally. It fails safe — a false pass weakens the check,
  it does not break a build — and the negative control pins that it still
  refuses the sentence this issue was filed about.
- One rationale outside Anthropic changed. `meta-llama-3-3-70b` read "The model
  card and licence agree on its release date", which is a sourcing statement
  rather than a reason, and is true of `meta-llama-3-1-405b` as well. A rule
  that exempted the one record violating it would not be a rule, so it was swept
  under the same rule. Its flag, and Meta's featured count of five, are
  untouched.

## Alternatives Considered

- **Move the flag from `claude-fable-5` to `claude-fable-5-1`.** Rejected on
  measurement 1: it makes featuring track recency. It also fixes nothing a
  reader sees — family `anthropic-claude-5` reaches the homepage through
  `opus-5` and `sonnet-5` regardless, and `/tree` already lists
  `claude-fable-5-1` under Anthropic.
- **Flag both releases.** Rejected as an unreviewed editorial addition. It grows
  the featured set to answer a question about what the flag means, and it leaves
  the actual defect — a rationale that discriminates nothing — in place.
- **Enforce `featured ⇒ current` mechanically.** Rejected on measurement 2: it
  breaches the at-least-one requirement for Microsoft, and this issue may not
  change that requirement.
- **Enforce `featured ⇒ ¬legacy` with a dataset-wide sweep.** Rejected on
  measurement 3: it removes the Llama 3 generation from the homepage and deletes
  two deliberate historical-importance judgments.
- **Leave everything as it is and record only that.** Rejected. It is a
  legitimate outcome for the *flag*, and it is the outcome for the flag; it is
  not a legitimate outcome for the rationale, which the issue correctly
  identifies as the genuine weakness, and it leaves the policy silent so the
  next refresh raises this again.
- **Introduce an ordering, tier or score among featured releases so the current
  one leads.** Rejected outright: forbidden by the schema, by #788, and by this
  repository's standing rule against a universal ranking.

## Guardrails

- `schema.ts`'s "not a ranking and not a sourced claim" language stays, as does
  "no order, no score". Nothing here introduces an ordering, a tier or a score
  among featured releases.
- The at-least-one-per-named-creator requirement is unchanged, and every named
  creator's featured count is unchanged by this decision.
- No threshold, budget or policy was loosened. The procedure gained a step; it
  lost none, and `featured-policy.test.ts` asserts five clauses where it
  asserted four.
- The lifecycle rule is published on all three pinned surfaces — the schema
  comment, `web/src/pages/methodology.astro`, and
  `docs/product/INFORMATION-ARCHITECTURE.md` — and the existing equality test
  keeps them from drifting.
- A `featured` flag still may not appear on any creator outside the five, and
  `featuredRationale` still appears on exactly the flagged releases.
