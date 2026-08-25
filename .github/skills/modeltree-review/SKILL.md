---
name: modeltree-review
description: Run ModelTree's three-rubric independent review panel over a claim bundle - provenance, cross-source consistency, and editorial/entity-boundary discipline - and record a verdict and rationale per claim. Use after modeltree-scout has produced claims and before any deterministic gate or dataset change.
---

# ModelTree review panel

Three reviewers, one vote each, no conferring. Acceptance is **2-of-3** for a
creator with a reviewed profile and **unanimous 3-of-3** for a long-tail creator
(#59, ADR 0002). The bundle's `policy` field says which applies; do not infer it.

You are the panel chair. You launch the reviewers, collect verdicts, and write
them into the bundle. **You do not vote, and you do not overrule.** A claim you
personally find obvious still needs three verdicts.

## Independence is the product

The 2-of-3 majority is worth exactly as much as the independence behind it, and
independence here is a property of what each reviewer is *shown*. Get this wrong
and you have one opinion reported three times.

Launch all three **in parallel, as separate sub-agents**. Each receives:

- the claim's `statement`, `collection`, `targetId`, `field`, `currentValue`,
  `proposedValue`;
- its `evidence` — url, verbatim quote, content hash, fetch date;
- the relevant slice of the current dataset;
- the creator profile's `terminology`, `naming_rules`, and `ambiguities`;
- its own rubric, below.

Each reviewer must **not** receive: the scout's reasoning or confidence, another
reviewer's verdict or rationale, the running tally, or any suggestion of what
outcome would be convenient. Do not tell a reviewer that two others have already
accepted. Do not re-run a reviewer that rejected in the hope of a different
answer — one vote each, and a rerun to get a better answer is vote-rigging
however it is framed.

Hold the limit of this in mind rather than trusting the number: three instances
of the same model family reading the same page share a failure mode. 2-of-3 buys
independence of *reasoning*, not independence of *training*. A source that is
itself wrong can carry all three.

## The three rubrics

### 1. `provenance` — does the source actually say this?

The narrowest and most literal rubric. Deliberately so.

- Does the quote, read alone, state the claim? Not imply it, not suggest it.
- Is the quote verbatim from the page at that URL?
- Is the source the right *kind* of authority for this field — an API reference
  for an API identifier, an announcement for a launch date, a model card for
  weights and licence?
- Is it primary? A news article about a company announcement is not the
  announcement.
- Does the claim state more than the source does — a precision, a scope, a
  qualifier the source never gave?

Reject if the claim needs a step of inference the quote does not contain. "The
source almost certainly means this" is a rejection.

### 2. `consistency` — does it fit what we already know?

- Does it contradict an existing dataset fact? If so, is the new source better,
  or is this genuinely a `conflict`?
- Is the lineage coherent — does a model postdate its predecessor, belong to a
  family owned by the same creator, avoid claiming to be its own ancestor?
- Are the dates possible relative to the family, the predecessor, and today?
- If it contradicts another *claim in this same bundle*, say so. The scout may
  have extracted two readings of one fact.
- For usage observations: is the population, window, and methodology stated, and
  is it being kept separate from incomparable figures rather than merged?

Reject a claim that is individually plausible but makes the dataset incoherent.
This rubric is the only one looking at the whole.

### 3. `editorial` — is it saying the right kind of thing?

- **Entity boundaries.** Creator, model, product, and serving platform are four
  separate things. ChatGPT is not GPT-5; Azure OpenAI is not OpenAI; Gemini the
  app is not Gemini the model. A claim that attributes a product's capability to
  a model release is a rejection even when every word of it is true of the
  product.
- **Naming.** Does it follow the creator's own terminology and the profile's
  `naming_rules` — dated snapshot as canonical name, dateless name as an API
  alias, families kept distinct?
- **No composite score, rank, or winner**, in the data or in the phrasing.
- **Unknown stays unknown.** Reject a filled-in field the source never stated,
  however reasonable the value.
- **Conditional guidance only.** Fit statements are `good fit when`,
  `trade-off`, or `avoid when` — never "the best model for X".

## Procedure

1. Read the bundle. Confirm `policy`, and derive the threshold from it: 2 for
   `pilot`, 3 for `long-tail`.
2. For each claim, launch the three reviewers in parallel with the inputs above.
3. Collect `{ reviewer, vote, rationale }`. **The rationale is mandatory and is
   published verbatim in the pull request body.** It is most of what makes an
   unattended merge auditable after the fact, so a rationale that says "looks
   fine" has failed at its only job. State what in the quote decided it.
4. Write all three verdicts into the claim. Record rejections in full — a
   rejected claim with its reasons is a finding worth publishing, not waste.
5. Do not delete rejected claims. The gates and the summary need them.
6. Report the tally: accepted, rejected, and each rejection's reason.

Batch claims per reviewer where volume demands it, but never batch *across*
reviewers, and never let one reviewer see another's output in a shared context.

## Rules

- **Never vote yourself, and never break a tie.** With three reviewers and two
  outcomes there are no ties; a claim that does not reach its threshold is
  rejected, and that is a complete answer.
- **Never re-run a reviewer to change an outcome.**
- **Never lower the threshold**, and never treat a long-tail creator as a pilot
  because a profile "basically" covers it. If a creator merits a profile, that is
  a finding for the summary and a proposed issue — not a threshold you adjust.
- **Never skip review because a claim is obvious.** The obvious ones are exactly
  where an unattended pipeline earns its keep.
- Semantic review comes **first**; the deterministic gates run after and cannot
  be outvoted by any majority you produce (ADR 0003).

## Handing off

Write the annotated bundle back, report the tally, then invoke
`modeltree-gates`.
