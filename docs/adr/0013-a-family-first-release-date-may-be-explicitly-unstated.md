# ADR 0013: A Family First Release Date May Be Explicitly Unstated

- Status: Accepted
- Date: 2026-09-02
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It **does not extend ADR 0008 or ADR 0011 to a third
  field**, and it is not entitled to. ADR 0008 closed by ruling that its
  `unknown` does not generalise — each field is "its own decision with its own
  justification" — and ADR 0011 opens by saying it argues from the ledger rather
  than from precedent. Both are about *controlled vocabularies*, where the fix is
  a new enum member. `firstReleaseDate` is a date, and a date has no vocabulary
  to add a member to, so the shape of their argument transfers and their remedy
  does not. What is borrowed here is the standard those two decisions were held
  to, not their conclusion: absence stays a hard failure, the contradiction the
  affordance makes possible is refused, and the value renders as its own words.
  This does **not** widen the ADR 0003 qualifying class — a schema change is
  outside that class, so this decision takes the ordinary reviewed path and does
  not reach `main` unattended.

## Context

`familySchema.firstReleaseDate` was a required `partialDate`. `partialDate`
accepts `YYYY`, `YYYY-MM` and `YYYY-MM-DD`, so the schema could already say how
*much* of a date a source gave. It could not say that a source gave none of it.

Those are different claims about different things. "Cohere states March 2025 and
no day" is a statement about a source. "No primary source states when Cohere's
Rerank family began" is a statement about the world. The repository's standing
rule is that unknown and conflicting data stay explicit rather than being
smoothed over, and this field was the one place that rule could not be followed:
every family record had to assert a first release date, whether or not anybody
publishes one.

### What the gap has already cost

Cohere's Rerank family was researched, sourced and then dropped —
abdeslam-menacere/ModelTree#740 — not for want of evidence about the models but
because the family record could not be written at all. Three candidate dates
were each considered and rejected there, and the rejections are the argument:

| Candidate | Why it was rejected |
|---|---|
| `2024-12-02` | Rerank **v3.5's** own release date, not the family's first |
| `2024-04-09` | **Rerank 3's** date — the same error one generation earlier |
| `2023-05-01` | JSON-LD on a JS-rendered page; the earliest Wayback snapshot is `2024-04-19`, so it could not be corroborated |

The first two are the failure mode this field invites: a family's earliest
*recorded* release is not the family's first release, and writing one into the
other silently converts "the earliest one we found" into "when this family
began". The dock refused, and refused to narrow the family definition to fit an
available date either. That is why this is a schema problem and not a research
problem — more scouting does not produce a fact that nobody published. Four
records were preserved in abdeslam-menacere/ModelTree#807 when the draft
abdeslam-menacere/ModelTree#772 was closed, and they have been waiting on this
decision.

### Why a date is not a vocabulary, and what follows from that

`status` and `accessType` are controlled vocabularies: a fixed set of dataset
terms onto which a source's wording is mapped. Adding `unknown` to one of them
adds a term, and every consumer already switches on terms, so the compiler makes
each of them account for the new one.

A date has no such set. The three candidate representations for "no date" — an
absent field, a sentinel string, a looser pattern — differ almost entirely in
**what the type system can see**, and that is the axis this decision turns on,
because there is no reviewer step between a schema that accepts a value and a
page that renders it.

Measured on this tree: `firstReleaseDate` is read in five production modules
outside the schema (`web/src/data/validate.ts`, `web/src/lib/format.ts`,
`web/src/lib/model-fit.ts`, `web/src/components/LineageExplorer.tsx`,
`web/src/data/model-fit-rubric.ts`). That is a small enough surface to enumerate
by hand and exactly large enough to get wrong by hand.

### What sorts on this field, measured rather than assumed

Nothing. Every ordering call site in the repository —
`comparePartialDates`/`comparePartialDatesDescending` in `catalog.ts`,
`lineage-view.ts`, `model-tree.ts`, `provider-profile.ts`,
`refresh-log-links.ts`, `release-pulse.ts`, `updates.ts` and
`variant-positioning.ts` — reads a `release.releaseDate` or a release event's
`date`. `buildModelTree` orders a creator's families by each family's *newest
release*, and `timeline.ts` is built from releases and events and is typed to
`ModelRelease['datePrecision']`.

This matters twice. It means a family with no first release date has somewhere
to sort, because it was never sorted on this field to begin with; and it means
this decision cannot be assumed harmless for `releaseDate`, which is what every
one of those orderings does read.

### The corpus today

78 families: 74 at `day` precision, 4 at `month`. Not one is at `year`, and the
four at `month` are each recorded with a note saying which source stopped there.
The dataset is not full of vagueness looking for a home — which is the point.
This is a narrow affordance for a state that is currently unwritable, not a
loosening of a field that is working.

## Decision

**`familySchema.firstReleaseDate` becomes optional, and its absence is licensed
only by an explicit `datePrecision: 'unstated'` recorded beside it.**

```ts
firstReleaseDate: partialDate.optional(),
datePrecision: familyDatePrecision,   // year | month | day | unstated
```

**The positive claim lives in the companion, which is a vocabulary.** This is the
whole of the design. The field that cannot express "no source states one" is the
date; the field sitting beside it already exists, already says how much of a date
a source gave, and *is* a controlled vocabulary — so it is where a new member
belongs. `unstated` is the zero of the same scale `year`, `month` and `day`
measure, and `FAMILY_PRECISION_SEGMENTS` in `web/src/data/partial-date.ts`
records it as exactly that: zero segments carried.

**The pair is enforced as a biconditional, so neither half can drift.**
`familySchema.superRefine` refuses an absent date beside a stated precision and a
present date beside `unstated`. A record therefore cannot reach the unstated
state by omission, and cannot claim it while contradicting it.

**Absence stays a hard failure**, which is the property that keeps this from
becoming a shortcut. A family that simply drops `firstReleaseDate` because nobody
looked is refused — by Zod, by `validateDataset` at the build boundary, and by
`gate-dataset.mjs` at the moment a refresh writes it. `datePrecision` itself
stays required, so silence remains unwritable: the only way past the schema is to
state, in the record, that no source gives a date.

**The member is scoped to families and to nothing else.** `releaseSchema` and
`releaseEventSchema` keep the three-member `datePrecision`, and their date fields
stay required. A release is an event; a record of an event nobody can date at all
is not a release, it is a rumour. Scoping it also means the ~10 ordering call
sites measured above cannot be handed a state they have no rule for.

**It renders as its own words.** `formatFamilyFirstRelease` returns
`Not stated by any source` and `familyFirstReleaseLine` returns `First release
date not stated by any source`, and both are asserted in
`web/src/data/first-release-date-unstated.test.ts`. A blank would put the reader
back where this decision found them — looking at a family the site does not
show — while the dataset believed it had published a claim.

**No new glossary vocabulary.** ADR 0011 required a glossary entry because
`accessType` renders as a *badge*: a bare word on a card needs a definition
somewhere, and `passport.ts` throws at build time for a badge value with no
entry. This value renders as a sentence that already says what it means, so a
glossary entry would restate it. The disclosure instead goes where the reader
meets the rule rather than the record: one paragraph under
`methodology.astro`'s "Dates and partial precision", which is where the three
precisions are already explained.

**Every consumer was enumerated by the compiler, not by hand.** `web/tsconfig.json`
extends `astro/tsconfigs/strict`, so making the field `string | undefined` turned
each of the five reads into a compile error until it was handled. That is the
reason this representation was chosen over the sentinel — see below — and
`npm run check` reports 0 errors over 255 files with the change in place.

**`dateBasis` may not be recorded without a date.** It says where a *recorded*
date came from; with no date recorded there is nothing for it to describe, and
admitting it would let a record cite a basis for a fact it does not state.

**The deterministic gate is extended, and its companion rules are scoped by
collection.** `PRECISION_COMPANIONS` in
`.github/skills/modeltree-gates/scripts/gate-dataset.mjs` previously named a
field and a companion; `inspect` applies every rule to every collection, so a
rule that reasons about an *absent* value keyed on field name alone would read
every release event as a release whose `releaseDate` had gone missing. Each rule
now names its collection, which is what lets the gate refuse an absent date at
all. Three failures are distinct and separately tested: the date absent while a
precision states one, `unstated` beside a date, and `unstated` declared anywhere
but `families`.

**The vocabulary is not derived there, and that is stated rather than hidden.**
`enumMembers` executes no TypeScript and so refuses `z.enum(SOME_CONSTANT)`;
both `datePrecision` and `familyDatePrecision` are declared that way. A
`VOCABULARY_RULES` entry would have no derived list to check against, only a
second hand-written one. `gateDates` remains the one place a precision
vocabulary is written down twice, which is the standing duplication that file
already documents — this decision adds a member to it, not a new instance of it.

**The Python side is kept in lockstep.**
`tools/updater/src/modeltree_updater/validation.py` gains
`FAMILY_DATE_PRECISIONS` and applies it to `EntityKind.FAMILY` only; `gates.py`
refuses a claim proposing `unstated` in the same batch as the date itself. The
mirror exists so the updater is never *more permissive* than the schema; it is
equally important that it not be stricter, or a record the schema accepts
becomes unproposable.

**No dataset record changes value under this decision.** The restoration of
Cohere Rerank is a separate commit and a separate reviewable act.

## Consequences

### Positive

- A family whose first release date no source states can be recorded honestly.
  Cohere Rerank is unblocked, and with it any creator whose family predates its
  own documentation.
- The claim is *visible*. A reader sees "Not stated by any source" and can
  challenge it; the previous behaviour — the family absent from the site
  entirely — gave them nothing to challenge.
- Vagueness and absence stay distinguishable. `2023` still means "the year, and
  no finer"; it does not have to double as "we do not know".
- The invented-date pressure is removed at its source. The two rejected
  candidates in #740 were both a *release* date standing in for a family date,
  which is a specific and repeatable error that a required field manufactures.
- The precision companion becomes a complete scale rather than a partial one,
  and the pairing rule that already existed now covers its zero without a
  special case.

### Costs

- **A fourth state at every family date consumer.** Five modules now branch on
  it. The compiler enumerated them once; it will enumerate them again for the
  sixth, which is the cost being accepted rather than avoided.
- **Two precision vocabularies where there was one.** `datePrecision` and
  `familyDatePrecision` differ by one member, and a reader has to know which
  applies where. The narrower one is the default and the wider one is named for
  its scope, but this is genuinely a thing to remember.
- **A third vocabulary the Python mirror must track**, after `LIFECYCLE_STATUS`
  and `ACCESS_TYPE`. Drift in the permissive direction is what ADR 0003 stops
  the automation for; drift in the strict direction silently makes a legal record
  unproposable, and nothing gates that.
- **`unstated` can be over-applied.** It is one word, and it is easier to write
  than to research. Only review can tell a family nobody publishes a date for
  from a family nobody looked up — the schema cannot, and no gate here claims
  to.
- **The gate's companion rules are now collection-scoped**, so adding a fourth
  date/precision pair means adding a rule rather than inheriting one. That is a
  deliberate trade: inheriting one is what made the absence rule unstatable.

## Alternatives Considered

- **`firstReleaseDate: partialDate.optional()` and nothing else.** Rejected for
  ADR 0008's reason, which holds here unchanged: an absent field is silent about
  *why* it is absent. It cannot distinguish "no source states this" from "nobody
  checked" from "the refresh dropped it", and those need different responses from
  a reviewer. It is also the one option that makes the honest record the *easy*
  record to produce by accident. The chosen design keeps the optionality — it is
  how the type system sees the state — but refuses it unless something else says
  it was established.

- **A sentinel: `z.union([partialDate, z.literal('unknown')])`.** Rejected, and
  the reason is measurable rather than aesthetic. The inferred type stays
  `string`, so the compiler flags **zero** of the five call sites; every one of
  them would keep compiling and quietly do the wrong thing. `earliestDay('unknown')`
  returns `'unknown-01-01'` and the comparisons are lexical, so `'u' > '2'` —
  which means `isDefinitelyAfter(family.firstReleaseDate, family.verifiedAt)` in
  `validate.ts` would report a contradiction that does not exist, and
  `formatDateWithPrecision` would render a sentinel to the page. A representation
  whose failure mode is "renders the word `unknown` where a date goes, and
  invents an ordering for it" is worse than the gap it closes.

- **Keep the field required and relax `partialDate` to admit an empty string.**
  Rejected twice over. It is the sentinel with a worse sentinel: `''.split('-')`
  has length 1, so an empty value would read as `year` precision and pass the
  pairing rule, and `earliestDay('')` yields `'undefined-01-01'`. It also breaks
  the field's own contract — `partialDate` is "a date a source stated", and an
  empty string is not a date at any precision, so every consumer that treats the
  value as a date would be right to and wrong to at once.

- **Add `unknown` to a date the way ADR 0008 and ADR 0011 added it to a
  vocabulary.** Rejected as a category error, stated explicitly because it is the
  option the two precedents make look obvious. Those fields *are* the set of
  values a record may hold, so a new member is a new legal value. A date field's
  legal values are dates. Putting a non-date in it is the sentinel above under a
  different name, and it inherits every one of that option's measured defects.

- **Widen `DATE_PRECISIONS` itself, so releases and release events get
  `unstated` too.** Rejected. It would make the state expressible in the ~10
  ordering call sites measured above, each of which would then need a rule for a
  release with no date — and there is no honest rule, because a release with no
  date is not a release. Symmetry is not a reason to make a state reachable.

- **Restore Cohere Rerank with a documented approximate date and a `dateBasis`.**
  Rejected as the thing the dock in #740 already refused. `dateBasis` records
  that a *recorded* date came from something other than a creator statement; it
  does not license recording a date no source gives. Using it here would convert
  a missing fact into a present one with a footnote, which is the smoothing-over
  the repository exists not to do.

- **Fix `license.name` and the other #807 fields in the same change.**
  Rejected. One field, one ADR, one decision — those are separate fields with
  separate justifications, exactly as ADR 0008's guardrail says.

## Guardrails

- **`unstated` means "no primary source states this family's first release date
  at any precision," and nothing else.** It is not "we have not looked yet", not
  "the sources disagree" — a disagreement is recorded in the description, as the
  `xai` organization record does — and not "the date is hard to find".
- **A release date is never promoted to a family date.** The two rejected
  candidates in #740 were exactly that, one generation apart. A family's earliest
  recorded release is evidence about a release; if that is all a source gives,
  the family's own date is `unstated`.
- **Absence never selects `unstated`.** A family with no `firstReleaseDate` and
  no `datePrecision: 'unstated'` is a hard failure in `familySchema`, and so in
  `validateDataset` and every consumer that calls it. `gate-dataset.mjs` does
  *not* also refuse it, and is not meant to: its companion rule fires on the two
  halves disagreeing and skips a record carrying neither, because a missing
  required field is the schema's finding rather than the gate's. This is the
  guardrail most likely to be quietly relaxed by a future change, and
  `web/src/data/first-release-date-unstated.test.ts` fails without it.
- **`unstated` and a first release date cannot coexist**, nor can `unstated` and
  a `dateBasis`. Both are refused by `familySchema`'s `superRefine`. Only the
  first is *also* refused by `gate-dataset.mjs`, whose `PRECISION_COMPANIONS`
  contradiction guard reasons about a value and its precision; the gate does not
  model `dateBasis` in any collection, so for that half the schema is the sole
  enforcement. Do not read the gate as a backstop for that half: weakening the
  `dateBasis` rule in `schema.ts` removes it outright, whereas weakening the
  first would still be caught by the gate.
- **The member is admissible on `families.datePrecision` only.** `releases` and
  `releaseEvents` keep the three-member vocabulary and keep requiring their
  dates. Extending it to either is a new decision with its own ADR, and it must
  answer the ordering question this one was able to sidestep by measurement.
- **No backfill.** Not one existing family changes value under this decision. A
  family already carrying a sourced date keeps it; rewriting one to `unstated`
  requires showing that the source it cites does not support it.
- **`unstated` renders as its own visible text, never a blank**, wherever a
  family's first release date is displayed. A consumer that renders it as an
  empty string is a defect, not a styling choice.
- **`validation.py`'s `FAMILY_DATE_PRECISIONS` mirrors the schema and may not
  drift in either direction.** Looser is what ADR 0003 stops the automation for;
  stricter makes a legal record unproposable and nothing would catch it.
- **This does not widen the ADR 0003 qualifying class.** A schema change is
  outside it. Restoring Cohere Rerank afterwards is a dataset change and is
  inside it, which is a further reason the two are separate commits.
- **The other date fields keep their discipline.** `verifiedAt`,
  `lastCheckedDate`, `publishedDate` and the licence windows are dates *we*
  observed, so the day is always known and nothing here touches them.
