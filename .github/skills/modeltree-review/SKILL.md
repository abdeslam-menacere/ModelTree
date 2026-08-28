---
name: modeltree-review
description: Run ModelTree's three-rubric independent review panel over a claim bundle - provenance, cross-source consistency, and editorial/entity-boundary discipline - and record a verdict and rationale per claim. Use after modeltree-scout has produced claims and before any deterministic gate or dataset change.
---

# ModelTree review panel

Three reviewers, one vote each, no conferring. Acceptance is **2-of-3** for a
creator with a reviewed profile and **unanimous 3-of-3** for a long-tail creator
(abdeslam-menacere/ModelTree#59, ADR 0002). The bundle's `policy` field says
which applies; do not infer it.

You are the panel chair. You launch the reviewers, collect verdicts, and write
them into the bundle. **You do not vote, and you do not overrule.** A claim you
personally find obvious still needs three verdicts.

## Measuring the change under review

Before any rubric, be sure what you are reviewing. A branch is the diff from its
merge-base to its tip, not a single commit. Measure scope as
`git diff --stat <merge-base>...<tip>`, with the merge-base computed as
`git merge-base HEAD refs/remotes/origin/main` and never supplied. Never reach
for `git show` here: it reads one commit, so on a branch with more than one it
under-reports silently — showing you a subset and telling you nothing is missing
— and the fact that it agrees with the branch diff when there is exactly one
commit does not make it a check on any branch with more. The scripted gates
already anchor exactly this way; `.github/skills/modeltree-gates/scripts/gate-scope.mjs`
computes this merge-base itself rather than trusting a supplied base, and this
path must not diverge from it.

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
source almost certainly means this" is a rejection. Recording a quoted fact in
the dataset's own vocabulary is not such a step — read the next part before
applying that sentence to an enum value or a unit.

#### Vocabulary mapping is a recording step, and where it stops

`status`, `categories`, `accessType`, `inputModalities` and `outputModalities`
are a **controlled vocabulary**: a fixed set of dataset terms, defined in
`web/src/data/schema.ts`, that no source speaks. A creator writes "Live",
"Active (legacy)" or "generally available"; the schema offers `preview`,
`current`, `legacy`, `deprecated`, `research` and nothing else. None of those
fields has an `unknown` member and `releaseSchema` requires every one of them,
so no release record can be written without mapping. Quantities pose the same
step in another form: the page says "128K", the record stores `128000`.

Selecting the member that a quoted term denotes, and normalising a quoted
quantity into the schema's unit, are **recording steps**, not new facts. Accept
them when all three of these hold:

1. **Quoted.** The underlying fact is quoted verbatim from an approved primary
   source of the right kind. Nothing here relaxes that — it is what the mapping
   is a mapping *of*.
2. **Same subject.** The quote is about the entity the claim is about: this
   model rather than a sibling, this release rather than its family, the
   creator's own release rather than a platform's offering of it.
3. **One member fits.** The quote read alone forces the choice, with no
   background knowledge and no tie to break.

Any of the three failing is a rejection, exactly as before. In particular,
still reject when:

- **The source states nothing on the point.** There is then no fact to record,
  and a value taken from a sibling model, from the family, or from what is
  usual for the field is a guess wearing a vocabulary term. Withholding the
  record is the correct outcome; a required field is not a licence to fill it.
- **Two members fit and the claim picks one silently.** "Available in preview
  to selected customers" does not by itself choose between `preview` and
  `current`. An ambiguity is a finding to record, not a coin to toss.
- **The mapping adds a precision, scope or qualifier the source never gave.** A
  status stated about one dated snapshot is not a status for the family; an
  approximate figure does not become exact by being stored as an integer; a
  page's publication timestamp is not a statement of a release date.
- **The quote is about a different entity.** `"available in public preview on
  Microsoft Foundry"` is not an `accessType` — it states what a serving
  platform offers, not how the creator releases the model, so there is no
  underlying fact to transcribe. Vocabulary mapping never repairs an
  entity-boundary error; see the `editorial` rubric.

#### Worked examples, from this repository's own runs

Accept — each of these was accepted by `provenance` in PR abdeslam-menacere/ModelTree#438:

| Claim | Quoted | Recorded |
|---|---|---|
| `openai-gpt-5-1-release-add` | `Input` / `Text, image` / `Output` / `Text` | `inputModalities ['text','image']`, `outputModalities ['text']` |
| `openai-gpt-5-1-release-add` | `400,000 context window`, `128,000 max output tokens` | `contextWindow 400000`, `maximumOutput 128000` |
| `anthropic-claude-opus-4-6-release-add` | `Status Active (legacy)`, with `Although Claude Opus 4.6 is still available, you should consider migrating to Claude Opus 5` | `status: 'legacy'` — still available rules out `deprecated`, so one member fits |

Accept, and the reversal this part of the rubric exists to make: in run
`2026-08-27-4f1c9e`, `co5-release-command-a-plus-add` quoted Cohere's own model
reference — Status `Live`, Modality `Text, Images`, Context Length `128k` —
and `provenance` rejected it, holding that mapping `Live` to `current` and
normalising `128K` to `128000` were "inferences the quotes do not contain".
Under this rubric all three are accepts: quoted, about that dated model, one
member each. The same claim's `accessType: 'open-weight'` remains a rejection,
because the quote about a licence is not a statement that weights are
downloadable — one claim, both outcomes.

Reject — each of these is a real rejection that stands unchanged:

| Claim | Attempted | Why it still fails |
|---|---|---|
| `openai-gpt-5-3-codex-release-add` (PR abdeslam-menacere/ModelTree#438) | `inputModalities ['text','image']` | The page states the modalities, but the claim attached no quote for them. The remedy is to attach the quote, not to map from nothing. |
| `mi4-release-large-3-add` (run `2026-08-27-4f1c9e`) | `status: 'current'`, `open-weight` | No quote states a lifecycle state at all, and `Start building: Ministral 3 and Large 3 on Hugging Face` does not state that weights are downloadable. Nothing to transcribe. |
| `microsoft-mai-thinking-1` (same run, withheld) | `accessType` from `available in public preview on Microsoft Foundry` | A serving platform's offering, not the creator's release. Wrong entity, so the record was withheld rather than filled. |
| `co5-family-command-a-add` (same run) | family `firstReleaseDate`, `status: 'current'`, `multimodal-generalist` | The date is the announcement page's `datePublished`, not a stated first release; the `Live` row describes one dated release, not the family; and the family took a modality from a later sibling while the same table lists Command A as text-only. Added scope on all three. |
| `mi3-release-large-3-add` (same run) | `intendedUse` asserting the model is "demanding to self-host" | Free-text, not vocabulary, and no quote says it. An added qualifier is a rejection wherever it appears. |

The dataset's own `openai-gpt-4-1` family takes its `firstReleaseDate` from an
announcement, which is the same step the fourth row above rejects. That is a
defect on the record, not a precedent to extend.

#### Why this is written down

The convention was always in force and never stated. Measured on `main` when
this was written, every published release carries a mapped `status` — 23
`current`, 13 `legacy`, 3 `preview` across all 39 — and 35 of them carry a
normalised `contextWindow` integer, while no source page anywhere says the word
`current` or the number `128000`. A rubric that treats the mapping as inference
therefore condemns records it has already passed.

The asymmetry made it decisive rather than latent. Under a 2-of-3 pilot bar a
lone provenance dissent on a mapped field is outvoted and the claim lands; under
the unanimous long-tail bar the same dissent blocks it outright, so no long-tail
creator could ever be published however good its sources were. This part of the
rubric removes that inconsistency by being precise about what a mapping is. It
changes no threshold, and it excuses no unsourced field.

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
