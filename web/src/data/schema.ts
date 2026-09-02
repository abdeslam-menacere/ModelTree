import { z } from 'zod';
import { DATE_PRECISIONS, FAMILY_DATE_PRECISIONS } from './partial-date';
import {
  FAMILY_FACT_FIELDS,
  FIT_CLASSIFICATIONS,
  FIT_GAP_REASONS,
  FIT_RUBRIC_DIMENSIONS,
  RELEASE_FACT_FIELDS,
  findUniversalClaim,
} from './model-fit-rubric';

const entityId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const slug = entityId;

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, 'must be a real calendar date in YYYY-MM-DD format');

/** A date a source states only to the year or month. Precision is never guessed. */
export const partialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  if (month !== undefined && (month < 1 || month > 12)) return false;
  if (day === undefined) return true;

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, 'must be a real date written as YYYY, YYYY-MM, or YYYY-MM-DD');

export const datePrecision = z.enum(DATE_PRECISIONS);

/**
 * The family-only precision vocabulary, `datePrecision` plus `unstated`
 * (ADR 0012). Built from `FAMILY_DATE_PRECISIONS` for the reason
 * `partial-date.ts` gives: the edge runs one way, so the two cannot drift.
 *
 * One consequence is worth recording where a reader will meet it.
 * `enumMembers` in `.github/skills/modeltree-gates/scripts/gate-dataset.mjs`
 * executes no TypeScript, so it refuses `z.enum(SOME_CONSTANT)` rather than
 * guessing past the indirection — it cannot derive these members any more than
 * it can derive `datePrecision`'s. That gate therefore checks this pairing
 * through its own segment table, exactly as it already does for the three-member
 * vocabulary, and the duplication is the one that file already documents rather
 * than a new one this decision introduces.
 */
export const familyDatePrecision = z.enum(FAMILY_DATE_PRECISIONS);

/**
 * How a committed date came to be known, recorded **only** where it is known not
 * to be a creator statement (ADR 0009).
 *
 * `platform-repository-created` means: the value is a hosting platform's own
 * record of when a repository was created — a Hugging Face Hub `createdAt`, say
 * — no creator statement of a release date was found, and the date is kept
 * because it bounds when the model existed, not because a creator stated it.
 *
 * The member is named for repository *creation* and not for publication, which
 * is narrower than it may look and deliberately so. `createdAt` is the moment
 * the repository row was made. Where that has been checked against a
 * repository's own history — the Kimi K2 Instruct and ERNIE 4.5 300B Hub
 * records, and only those — it lands on an "initial commit" that predates the
 * weights: exactly on it for Kimi K2 Instruct, one second ahead of it for
 * ERNIE. Every other record carrying this member asserts no such check, so read
 * the marker as naming the artefact the date rests on and not as a claim that
 * its relationship to the repository's history has been established.
 * A repository may also be created private and made public later, so the field
 * cannot attest that anything was visible at that instant. Naming the member
 * `platform-first-published` would assert a publication event the platform never
 * recorded — the same kind of overstatement, one step smaller, that this field
 * exists to stop.
 *
 * -- READ THIS BEFORE ADDING A MEMBER OR MAKING THE FIELD REQUIRED --
 *
 * **Absence asserts nothing.** A record without `dateBasis` is not thereby
 * claiming its date is creator-stated; it is claiming nothing at all, because no
 * basis has been established either way. There is deliberately no
 * `creator-stated` member: adding one makes the absent case look like a third
 * state that somebody forgot to fill in, and the way that gets "fixed" is a
 * sweep that writes `creator-stated` across every unmarked record on the
 * strength of nothing. That would convert an unverified field into a positive
 * claim across the whole dataset, which is the silent platform-fact-as-creator-
 * claim conversion of #682 rebuilt one level up. ADR 0009's Guardrails forbid
 * any text — here, in `web/README.md`, or in a gate message — that reads absence
 * as verification.
 *
 * The one-member enum is therefore the point rather than an unfinished sketch.
 */
export const dateBasis = z.enum(['platform-repository-created']);

/**
 * `lifecycleStatus`, `modelCategory`, `accessType` and `modality` are a
 * **controlled vocabulary**: a fixed set of dataset terms onto which a source's
 * own wording is mapped. No source speaks them. A creator writes "Live",
 * "Active (legacy)" or "generally available"; the terms below are what the
 * record can hold. The numeric fields pose the same step in another form — a
 * page states "128K" and `contextWindow` stores `128000`. That mapping is the
 * commonest way a stated context length reaches a numeric field and it is not
 * the only one; what the column actually holds, and the reason a figure in it
 * is never rewritten to match a rule, are set out beside
 * `releaseSchema.contextWindow` below.
 *
 * Choosing the member a quoted term denotes is a *recording* step, not a new
 * fact, and it is permitted only on the terms the `provenance` rubric in
 * `.github/skills/modeltree-review/SKILL.md` sets out: the underlying fact is
 * quoted verbatim from an approved primary source, the quote is about the same
 * entity at the same level, and exactly one member fits. A source that says
 * nothing on the point, wording that fits two members equally well, and a term
 * that adds a precision or scope the source never gave all remain rejections.
 * Nothing here licenses filling a field the source left unstated.
 *
 * **`status` and `accessType` each carry an explicit `unknown` member;
 * `modelCategory` and `modality` do not, and every part of that is
 * deliberate.** The test a field has to pass to earn one is not "is this
 * sometimes hard to source" — it is whether an approved primary source can
 * state the fact *at all*. Two fields here fail that test, for two different
 * reasons, and each was decided separately rather than by analogy.
 *
 * `status` fails it because a bare model card names an architecture, a
 * parameter count and a licence yet says nothing about whether the vendor still
 * offers the model. So `status: 'unknown'` is the faithful recording of "the
 * source states no lifecycle state" — see
 * `docs/adr/0008-lifecycle-status-carries-an-explicit-unknown-member.md`.
 *
 * `accessType` fails it in one direction only, and the asymmetry is the whole
 * of the reasoning. `open-weight`, `source-available` and `both` are positive
 * claims a creator does publish: a card that says the weights can be downloaded
 * states one outright. `proprietary-hosted` is the odd one, because it asserts a
 * universal negative — no weights are distributed — and **nobody announces an
 * absence.** A creator's pages state what a model is, name its context window
 * and its modalities, and simply stop; there is no sentence saying "our weights
 * are unavailable" to quote, because there is nothing to announce. A release
 * whose access story is unstated in that direction had no expressible value at
 * all, so it could not be recorded however well every other field was sourced.
 * `accessType: 'unknown'` records that, and it is
 * `docs/adr/0011-access-type-carries-an-explicit-unknown-member.md`.
 *
 * That ADR measured which direction actually blocks records, and the answer
 * bounds this member tightly. The dominant recorded failure is the *other*
 * direction: in one run, eight release records were refused with `accessType`
 * among their provenance failures, and every one of them proposed
 * `open-weight` on the strength of a licence name, a download link, or the word
 * "Open" in a licence title. That run's own follow-up records the gap as a
 * scouting defect rather than a structural one — the GPT-Neo README states
 * downloadable weights a sentence before the link the scout quoted instead.
 * **`unknown` is not for those.** Where a card states its access type, quoting
 * it is the work; mapping a stated access type to `unknown` is a provenance
 * failure exactly as mapping an unstated one to `open-weight` is.
 *
 * Both members are first-class sourced values in the same sense `modelSelection`
 * below carries `unknown` for a product that discloses no selection policy — not
 * escape hatches, and each renders as its own label rather than a blank.
 *
 * None of this weakens the rule for the fields around them. `familySchema` and
 * `releaseSchema` below still require `categories` and both modality lists to
 * map to a stated term; there is no member meaning "left open" for them, and a
 * tree branch rendering rows of blanks is not a fact this dataset states. A card
 * that omits its modalities is not publishing a model, and unlike a lifecycle or
 * an absent-weights fact, those are things a source states whenever it publishes
 * at all. Where one of them cannot be mapped from an approved source, the whole
 * record is withheld rather than guessed. `unknown` says nothing about whether a
 * release exists, so neither member reopens the empty-family rule in
 * `gate-dataset.mjs`. Fields that may honestly be absent are `.optional()`
 * instead, and `partialDate` above is the same principle applied to how much of
 * a date a source actually gave.
 */
export const lifecycleStatus = z.enum(['preview', 'current', 'legacy', 'deprecated', 'research', 'unknown']);
export const modality = z.enum(['text', 'image', 'audio', 'video']);

export const modelCategory = z.enum([
  'language-reasoning',
  'multimodal-generalist',
  'coding',
  'image',
  'video',
  'audio-speech',
  'embedding-reranking',
  'scientific',
  'robotics-world',
]);

// `unknown` is deliberately last, so the four original members keep their order
// and their index for any consumer that restates the vocabulary as an array.
// The note above the enum group says what it means and, just as importantly,
// what it is not for. The members are listed as bare literals with nothing else
// between the brackets because `enumMembers` in
// `.github/skills/modeltree-gates/scripts/gate-dataset.mjs` derives this
// vocabulary by reading this declaration as text -- it executes no TypeScript,
// so a comment sitting inside the list is a member it cannot read, and it
// refuses the whole run rather than gate against a vocabulary it has misread.
export const accessType = z.enum([
  'proprietary-hosted',
  'open-weight',
  'source-available',
  'both',
  'unknown',
]);

// Downloadable weights and OSI-approved licensing are separate claims. A model
// may permit the first while failing the second, so neither implies the other.
//
// What evidences `osiApproved` (abdeslam-menacere/ModelTree#461): a licence
// *name* never evidences OSI *status*. That a model card says "Apache 2.0" is a
// fact about the name; whether OSI approved that licence is a distinct fact only
// OSI states, so `osiApproved` must rest on a source that states OSI approval —
// OSI's own published licence list at opensource.org, an approved origin (see
// tools/updater/profiles/origins/open-source-initiative.json). This is exactly
// what the `provenance` rubric in .github/skills/modeltree-review/SKILL.md
// requires, so schema and rubric give the same answer for the same claim: an
// `spdxId` or a licence `url` alone is not evidence of OSI status. The
// `spdxId`/`url` requirement in `releaseSchema.superRefine` below is a structural
// floor — it ensures a licence is identified — not the evidence rule for the
// field's truth, which is the reviewer's to apply.
//
// Whether `osiApproved: false` needs a source too, left open by #461 and decided
// in abdeslam-menacere/ModelTree#481: **it does**, and `validateDataset`
// enforces it. `false` asserts that OSI has not approved the named licence,
// which is as much a claim about the world as `true` is, and it is one OSI's own
// publication can settle rather than merely fail to contradict: the approved
// list is exhaustive by construction, so a licence absent from it has not been
// approved. Absence there is a reading of the register, not an argument from
// silence. Leaving `false` unevidenced would have made the unsourced value the
// cheapest one in the schema to assert, which inverts the point of the rule
// above. So every release carrying `osiApproved`, at either value, must cite a
// source published by the Open Source Initiative.
//
// The *structural floor* stays asymmetric, and that part is deliberate rather
// than left over. `superRefine` still demands an `spdxId` or a licence `url` for
// `true` alone. A `true` claim has to be matched against a named entry on OSI's
// list, and matching needs the licence pinned to something more canonical than a
// free-text name. A `false` claim is the complement of that list, and the
// licences it covers are largely bespoke vendor terms; one carrying no SPDX id
// and no canonical URL is the case where `false` is least in doubt, so demanding
// an identifier there would push a record towards inventing one to state
// something the sources already support. Requiring evidence and requiring an
// identifier are different requirements, and this field now takes the first
// symmetrically and the second only where it does work.
//
// What that enforcement does and does not settle: `validateDataset` checks that
// an OSI-published source is cited. It never reads that source, so it cannot
// confirm the page says what the record claims — the same division of labour as
// the rule above, where the check is structural and the judgement is the
// reviewer's.
export const licenseSchema = z.object({
  name: z.string().min(1),
  spdxId: z.string().min(1).optional(),
  url: z.url().optional(),
  weightsDownloadable: z.boolean(),
  osiApproved: z.boolean(),
});

export const parameterCountSchema = z.object({
  totalBillions: z.number().positive().optional(),
  activeBillions: z.number().positive().optional(),
});

export const sourceSchema = z.object({
  id: entityId,
  url: z.url(),
  title: z.string().min(1),
  type: z.enum([
    'official-announcement',
    'official-docs',
    'model-card',
    'repository',
    'benchmark-owner',
    'independent-evaluation',
  ]),
  // Publisher identity is an entity reference, never a free-text label: two
  // corporate siblings must resolve to one voice and two unrelated publishers
  // that share a display name must stay distinct. The string lived here before;
  // it now lives on the referenced publisher.
  publisherId: entityId,
  publishedDate: isoDate.optional(),
  lastCheckedDate: isoDate,
  notes: z.string().min(1).optional(),
});

/**
 * Who stands behind a source. A publisher is its own entity, separate from the
 * creating organization, the product, and the serving platform. Independence
 * and the two-independent-publisher synthesis bar are decided on publisher
 * identity, so a publisher must be resolvable to a stable id and, where it is an
 * arm of a larger company, to that company.
 */
export const publisherSchema = z.object({
  id: entityId,
  name: z.string().min(1),
  // The creator organization this publisher is the official voice of, when it
  // is one. Independent analysts, platform operators, and holding companies
  // leave it unset. This replaces the old name/shortName string comparison.
  organizationId: entityId.optional(),
  // An ownership/control fact: this publisher is an arm of a parent publisher
  // (the controlling company). Sibling arms of one parent collapse to a single
  // voice. Ownership is a claim like any other in this repository, so it
  // carries its own primary sources and a verification date.
  control: z
    .object({
      parentId: entityId,
      sourceIds: z.array(entityId).min(1),
      verifiedAt: isoDate,
    })
    .optional(),
});

/**
 * A creator organization.
 *
 * Two name fields, and the rule for them is not a matter of taste at the point
 * of use: **`shortName` is the label** -- the one string an organization is
 * displayed as, sorted on, and filed under, uniformly, with no per-creator
 * exceptions. `name` is the fuller recorded form. It is never deleted, it stays
 * searchable so either form finds the creator, and it is shown as the full
 * recorded form where the two differ.
 *
 * The rule lives in `src/lib/organization-name.ts`, which is the only place
 * that decides it; read it before adding a surface that names a creator, and
 * call it rather than reading either field directly. Reading `name` directly is
 * how abdeslam-menacere/ModelTree#479 happened: every surface picked the field
 * independently, so `xai` rendered as "SpaceXAI" and filed under S.
 *
 * The two forms are allowed to disagree, and for `xai` they disagree because
 * the creator's own surfaces do. That conflict is data, recorded in
 * `description` with its sources; a refresh must not collapse it by editing one
 * field to match the other. Neither field is an identifier -- `id` and `slug`
 * are -- so a naming change is never a reason to touch either.
 */
export const organizationSchema = z.object({
  id: entityId,
  slug,
  // The fuller recorded form. See the note above: this is NOT the label.
  name: z.string().min(1),
  // The label: displayed, sorted on, and filed under. See the note above.
  shortName: z.string().min(1),
  // Colloquial short forms of this creator that are registered as neither `name`
  // nor `shortName` -- "Google" for "Google DeepMind", say. This is not a display
  // or sort field and no surface renders it; it exists so a guard that must reason
  // about every way a creator is *referred to* can match the forms readers use in
  // prose, not only the two recorded forms. Its one consumer today is the
  // cross-creator guard in `lib/variant-positioning.ts`, which rejects a
  // positioning record whose ModelTree-authored prose names a *different* creator.
  // The list is not exhaustive by construction -- no field can enumerate every
  // colloquial form -- so a guard reading it stays best-effort; see the note on
  // reach in `web/README.md`. Omit it, or leave it empty, when a creator has no
  // short form beyond its two recorded names.
  //
  // **This field carries no `sourceIds` and no `verifiedAt`, and that is a
  // decision rather than an omission** (abdeslam-menacere/ModelTree#687). Every
  // other fact here is a published claim a reader can encounter and is entitled
  // to trace, so it is sourced and dated. An alias is not published: it renders
  // on no surface, and its only reader is the build-time guard named above. It
  // is machine input to a check, so the per-fact citation rule does not reach
  // it, and inventing a citation for "this creator is commonly called X" would
  // dress a usage judgement as a sourced fact.
  //
  // The exemption is bounded, and the bound is checked in
  // `organization-aliases.test.ts` rather than left to this comment. An alias
  // must differ from `name` and `shortName` -- the guard skips forms equal to
  // either, so a duplicate is dead data -- and must be attested in its own
  // record's already-sourced `description`, `website`, or `releasePage`. So an
  // alias is a restatement of a form this record already uses, under the
  // `sourceIds` and `verifiedAt` that record already carries, never a new claim
  // entering the dataset unsourced. Adding one is therefore not a
  // re-verification and is not a reason to move `verifiedAt`.
  //
  // What that check cannot do is judge whether a form is *contested*, and this
  // is stated because the limit is easy to miss: attestation is a floor, not a
  // licence. `alibaba-cloud` is the standing example -- bare "Alibaba" is
  // attested in quoted sources, and is deliberately not registered, because
  // this dataset records an unresolved conflict over whether the creator is
  // Alibaba Cloud or Alibaba Group and that bare form is exactly the ambiguity.
  // Registering it would resolve by implication a conflict the record keeps
  // open. A contested short form stays out, and the reason is written down.
  aliases: z.array(z.string().min(1)).optional(),
  // Editorial functional classification, not a sourced claim. Choose the first
  // match: `community` when independent contributors outside any one entity's
  // employment or appointment chain can initiate and decide its model releases,
  // not merely submit work; `company` when the entity offers model products or
  // access for payment under its name (a parent's sales do not count);
  // `research-lab` when one standalone institution or named unit controls
  // releases and exists primarily for research; `nonprofit` when a centrally
  // governed nonprofit matches none above; otherwise `company` for the
  // centrally operated creator that runs the model work.
  type: z.enum(['company', 'research-lab', 'nonprofit', 'community']),
  website: z.url(),
  releasePage: z.url(),
  description: z.string().min(1),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

/**
 * `firstReleaseDate` is a date a *source* stated, so it is a `partialDate` and
 * carries the precision that source supported. A creator that announces a
 * family in month-precision prose is recorded at month precision rather than
 * withheld, and the day is never filled in to satisfy the type.
 *
 * -- READ THIS BEFORE MAKING THE FIELD REQUIRED AGAIN, OR OPTIONAL ANYWHERE ELSE --
 *
 * The field is optional and its absence is **not** self-authorising (ADR 0012).
 * `partialDate` expresses vagueness at three precisions and cannot express
 * absence, and the two are different claims: "the source gave only the year" is
 * a statement about how much was said, while "no primary source states when
 * this family began" is a statement about the world. Cohere's Rerank family is
 * the second, and was dropped from the dataset rather than published with an
 * invented date.
 *
 * So the absence is carried by the companion rather than by the field. A record
 * omitting `firstReleaseDate` must declare `datePrecision: 'unstated'`, and the
 * `superRefine` below refuses both halves of the contradiction: a date missing
 * beside a stated precision, and a date present beside `unstated`. Omitting the
 * field because nobody looked is therefore still a hard failure — the only way
 * past the schema is to say, in the record, that no source states one.
 *
 * The companion is named `datePrecision`, matching `releaseSchema` below and
 * `releaseEventSchema` further down. Both name the companion for the idea, not
 * for the field beside it (`date` there, `releaseDate` here), so the shared
 * name is the existing convention rather than a third one. A family holds
 * exactly one source-stated date — `verifiedAt` is ours, and always a day — so
 * there is nothing for the shorter name to be ambiguous between. Its type is
 * the wider `familyDatePrecision`, which is what makes every consumer of a
 * family's date handle the unstated case or fail to compile.
 *
 * `validateDataset` requires the value's shape and the declared precision to
 * agree, which is what stops a `month` record from carrying an invented day.
 *
 * `dateBasis` is optional and, where present, says this date is not a creator
 * statement. See its declaration above; absence asserts nothing.
 */
export const familySchema = z.object({
  id: entityId,
  slug,
  organizationId: entityId,
  name: z.string().min(1),
  description: z.string().min(1),
  categories: z.array(modelCategory).min(1),
  firstReleaseDate: partialDate.optional(),
  datePrecision: familyDatePrecision,
  dateBasis: dateBasis.optional(),
  status: lifecycleStatus,
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
}).superRefine((family, context) => {
  if (family.datePrecision === 'unstated') {
    if (family.firstReleaseDate !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['datePrecision'],
        message:
          'cannot be unstated when the family records a first release date, which is a source stating one',
      });
    }
    if (family.dateBasis !== undefined) {
      // `dateBasis` says where a *recorded* date came from. With no date
      // recorded there is nothing for it to describe, and leaving it admissible
      // would let a record cite a basis for a fact it does not state.
      context.addIssue({
        code: 'custom',
        path: ['dateBasis'],
        message: 'cannot be recorded when no first release date is stated',
      });
    }
    return;
  }

  if (family.firstReleaseDate === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['firstReleaseDate'],
      message:
        'is required unless datePrecision is "unstated", which records that no source states one',
    });
  }
});

export const releaseSchema = z.object({
  id: entityId,
  slug,
  canonicalName: z.string().min(1),
  displayName: z.string().min(1),
  organizationId: entityId,
  familyId: entityId,
  version: z.string().min(1),
  variant: z.string().min(1),
  releaseDate: partialDate,
  datePrecision,
  dateBasis: dateBasis.optional(),
  status: lifecycleStatus,
  // Editorial lead selection, not a ranking and not a sourced claim. Apply in
  // order: flag `featured` only on a release whose creator is one of the five
  // this site leads with -- `anthropic`, `google-deepmind`, `meta`,
  // `microsoft`, `openai`; flag at least one release for each of those five, so
  // that each one reaches the Featured branch, because a creator is featured
  // exactly when it holds a featured release and the schema carries no
  // organization-level flag; flag no release of any other creator, which is what
  // places every creator the list omits on the Others branch; write a
  // `featuredRationale` on exactly the releases flagged, so that no rationale
  // outlives the placement it explains; and let no lifecycle status decide the
  // flag in either direction: `status` is a sourced measurement, and deriving
  // this list from it would make the list track recency, which is an order this
  // procedure refuses -- so a `legacy` release may stay flagged and a `current`
  // one is not owed the flag, and what a flagged release owes instead is a
  // `featuredRationale` saying why it carries its creator's placement, in terms
  // that stay true once it is superseded and that could not be written of
  // another release of the same creator. The list records what this site leads
  // with, which is a choice about its own entry point rather than a measurement
  // of the creators: it states no order, no score, and no claim that a listed
  // creator is larger, better, or more important than one it omits. A creator
  // the list omits keeps every catalog entry, every release, its place on the
  // Others branch, and its own provider page. Changing the five is an editorial
  // change to this list, reviewed like any other change here.
  featured: z.boolean(),
  featuredRationale: z.string().min(1).optional(),
  categories: z.array(modelCategory).min(1),
  inputModalities: z.array(modality).min(1),
  outputModalities: z.array(modality).min(1),
  accessType,
  license: licenseSchema.optional(),
  parameters: parameterCountSchema.optional(),
  // Two routes carry a stated context length into `contextWindow`, and what the
  // source literally says decides which of the two applies. They are the common
  // routes, not an exhaustive account of this column — see the third case below,
  // which is why this comment describes what the data holds rather than issuing
  // a rule the data must satisfy.
  //
  // 1. THE SOURCE STATES AN EXACT INTEGER, so it is recorded verbatim and no
  //    mapping happens at all. GPT-4.1's model documentation is the clearest
  //    case, because it gives both forms on one page: prose describing "a 1M
  //    token context window", and a model-details line reading "1,047,576
  //    context window". `openai-gpt-4-1-2025-04-14` stores `1047576` — the
  //    figure the page states exactly, not the figure it rounds to. Alibaba's
  //    Qwen3 cards state "Context Length: 262,144" the same way, so
  //    `alibaba-qwen3-8-27b` stores `262144`.
  // 2. THE SOURCE STATES ONLY AN ABBREVIATION, and then the mapping above
  //    applies: "K" reads as a thousand, "M" as a million. The Llama 3.1 model
  //    card's Context length column says "128k" and gives nothing more precise,
  //    so `meta-llama-3-1-405b` stores `128000`. Mistral's "256k" gives
  //    `256000`, and "10M" on the Llama 4 Scout card gives `10000000`.
  //
  // Between those two, prefer what the source literally states. Route 1 is not
  // an exception to route 2 — it is the case where the creator already published
  // a number, and copying it is the faithful act. Route 2 is a recording step
  // under the `provenance` rubric above; route 1 is not a step at all.
  //
  // 3. AN ABBREVIATION READ IN THE BINARY SENSE, used only where the source
  //    itself fixes the binary size, which is the case that stops the two
  //    routes above from being the whole story.
  //    `upstage-solar-pro-preview-instruct` stores `4096` against a card that
  //    states "a maximum context length of 4K" and no integer anywhere. Route 2
  //    read literally would give `4000`; the recorded value is `4 × 1024`. The
  //    reading is not a free choice: the same card's comparison table names
  //    `Phi-3-medium-4K-instruct`, and Solar Pro Preview is a depth-upscaled
  //    Phi-3-medium, so its "4K" is the Phi-3 "-4K" build's known 4096-token
  //    buffer rather than a loose "about four thousand". Its source note records
  //    that basis, so the binary reading is shown on the record and not merely
  //    observed here.
  //
  //    THE DECISION a bare "K"/"M" abbreviation is read by, when a *new* record
  //    is written, follows from those three routes rather than sitting open:
  //    read it decimally — "K" is 1000, "M" is 1,000,000 — which is route 2 and
  //    the default a bare-abbreviation record takes. Depart from that only when
  //    the source's own context establishes a binary buffer, as `upstage`'s
  //    Phi-3-`4K` lineage does; when it does, the record's note must state the
  //    resulting integer and that basis so the departure is legible. How many
  //    records read which way is not a count this comment carries — the
  //    `context-window-reading.test.ts` guard is the authority, flagging any
  //    stored value that is the binary reading of a bare abbreviation in its
  //    notes when no note states the resulting integer. A stored binary value
  //    whose source fixes no such buffer is not a sanctioned reading but an
  //    unresolved one: its note must say so and flag it, to be answered by its
  //    own source and its own issue per the rule below, never by editing the
  //    datum here. The
  //    binary reading is rejected as the *default* for a bare abbreviation
  //    because adopting it there would silently expand a card's bare "128k" to
  //    `131072` across many records — replacing a figure taken from a creator
  //    with a computed one no source states, the very harm the rule below
  //    guards. The decimal default never invents beyond a stated abbreviation's
  //    plainest reading; the binary exception is taken only on stated evidence,
  //    never to make a column tidy.
  //
  // So near-neighbour values sit beside each other in this column — `1047576`,
  // `1048576` and `1000000`; `128000`, `131072` and `4096` — and that is several
  // readings of what creators published, not drift between records that should
  // have agreed.
  //
  // THE RULE THAT MATTERS IS THEREFORE NOT WHICH ROUTE APPLIES BUT THIS: never
  // reconcile a recorded figure to a route. Rewriting a stated `1047576` down to
  // `1000000`, expanding a card's bare "128k" up to `131072`, or trimming
  // `upstage`'s `4096` to `4000` because the mapping above says "K" is a
  // thousand, would each replace a figure this dataset took from a creator with
  // one no source states. A value this comment does not account for, or one it
  // accounts for without recording why, is a question for its own source and
  // its own issue, never a warrant to edit the datum: the comment answers to
  // the data, not the other way round. A recorded figure changes only on fresh
  // evidence from its own source — that source changing, or a re-reading of it
  // quoted anew — and always with a fresh `verifiedAt`.
  contextWindow: z.number().int().positive().optional(),
  maximumOutput: z.number().int().positive().optional(),
  apiAliases: z.array(z.string().min(1)),
  predecessorIds: z.array(entityId),
  successorIds: z.array(entityId),
  siblingIds: z.array(entityId),
  derivedFromIds: z.array(entityId).default([]),
  summary: z.string().min(1),
  intendedUse: z.string().min(1),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
}).superRefine((release, context) => {
  if (release.featured && !release.featuredRationale) {
    context.addIssue({
      code: 'custom',
      path: ['featuredRationale'],
      message: 'is required for a featured release',
    });
  }

  const claimsWeights = release.accessType === 'open-weight' || release.accessType === 'both';
  if (claimsWeights && !release.license) {
    context.addIssue({
      code: 'custom',
      path: ['license'],
      message: 'is required when a release claims downloadable weights',
    });
  }
  if (claimsWeights && release.license && !release.license.weightsDownloadable) {
    context.addIssue({
      code: 'custom',
      path: ['license', 'weightsDownloadable'],
      message: 'contradicts an open-weight access type',
    });
  }
  // The other half of that contradiction, and the one ADR 0011 adds. `unknown`
  // records that no accessible primary source states how the release is
  // obtained. A licence record asserting the weights *are* downloadable states
  // exactly that, so the two cannot both be true of one release: whichever is
  // right, the record is not "unknown". Refusing it here keeps `unknown` from
  // becoming the value a record drifts to while still carrying the evidence
  // that contradicts it -- the cheap failure this member is most likely to
  // produce, since nothing else in the schema would notice.
  if (release.accessType === 'unknown' && release.license?.weightsDownloadable) {
    context.addIssue({
      code: 'custom',
      path: ['accessType'],
      message:
        'cannot be unknown when the release records downloadable weights, which states its access type',
    });
  }
  if (release.license?.osiApproved && !release.license.spdxId && !release.license.url) {
    context.addIssue({
      code: 'custom',
      path: ['license'],
      // Says what this refusal is for. The earlier wording called the identifier
      // "evidence", which is the one inference the note beside `licenseSchema`
      // exists to forbid, and a refusal message is where a false claim of
      // verification is most likely to be believed — it reaches an operator at
      // the moment the check fires (the reasoning ADR 0005 records for
      // `gate-evidence.mjs` refusals). Identifying the licence is the floor;
      // OSI's own page is the evidence.
      message: 'an OSI-approved claim must identify the licence with an spdxId or a licence URL',
    });
  }
});

export const productSchema = z.object({
  id: entityId,
  slug,
  name: z.string().min(1),
  organizationId: entityId,
  description: z.string().min(1),
  // A product may route between models; that is not the same as naming one.
  modelSelection: z.enum(['fixed', 'routed', 'unknown']),
  releaseIds: z.array(entityId).default([]),
  availabilityNotes: z.string().min(1).optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const servingPlatformSchema = z.object({
  id: entityId,
  slug,
  name: z.string().min(1),
  // The organization operating the platform, which is rarely the model creator.
  organizationId: entityId,
  type: z.enum([
    'first-party-api',
    'cloud-platform',
    'aggregator',
    'model-hub',
    'local-runtime',
  ]),
  website: z.url(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const deploymentSchema = z.object({
  id: entityId,
  releaseId: entityId,
  platformId: entityId,
  deliveryMode: z.enum([
    'hosted-api',
    'managed-endpoint',
    'downloadable-weights',
    'local-runtime',
  ]),
  apiIdentifier: z.string().min(1).optional(),
  regions: z.array(z.string().min(1)).default([]),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const pricingRecordSchema = z.object({
  id: entityId,
  deploymentId: entityId,
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter ISO 4217 code'),
  unit: z.enum([
    'per-1m-tokens',
    'per-1k-tokens',
    'per-image',
    'per-minute',
    'per-request',
  ]),
  rates: z.object({
    input: z.number().nonnegative().optional(),
    cachedInput: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    batchInput: z.number().nonnegative().optional(),
    batchOutput: z.number().nonnegative().optional(),
  }),
  region: z.string().min(1).optional(),
  processingTier: z.string().min(1).optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const benchmarkDefinitionSchema = z.object({
  id: entityId,
  slug,
  name: z.string().min(1),
  domain: z.enum([
    'general-reasoning',
    'mathematics',
    'coding',
    'tool-use-agents',
    'multimodal',
    'long-context',
    'human-preference',
    'operational',
  ]),
  owner: z.string().min(1),
  metric: z.string().min(1),
  metricUnit: z.string().min(1),
  direction: z.enum(['higher-is-better', 'lower-is-better']),
  datasetVersion: z.string().min(1).optional(),
  methodologyNotes: z.string().min(1).optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const benchmarkResultSchema = z.object({
  id: entityId,
  benchmarkId: entityId,
  benchmarkVersion: z.string().min(1),
  releaseId: entityId,
  variantNote: z.string().min(1).optional(),
  score: z.number().finite(),
  unit: z.string().min(1),
  evaluationDate: partialDate,
  // Configuration that decides whether two results may be compared at all.
  reasoningMode: z.string().min(1).optional(),
  toolsEnabled: z.boolean().optional(),
  harness: z.string().min(1).optional(),
  resultType: z.enum(['official', 'independent']),
  caveats: z.string().min(1).optional(),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

export const releaseEventSchema = z.object({
  id: entityId,
  releaseId: entityId,
  type: z.enum([
    'announced',
    'preview',
    'api-available',
    'generally-available',
    'deprecated',
    'retired',
    'corrected',
  ]),
  date: partialDate,
  datePrecision,
  note: z.string().min(1),
  sourceIds: z.array(entityId).min(1),
  verifiedAt: isoDate,
});

/**
 * How a usage figure was produced. The category decides how the observation is
 * labelled and whether it may support a cross-source synthesis; it is never a
 * quality ranking of the source.
 */
export const usageSourceCategory = z.enum([
  'creator-self-report',
  'platform-operator-report',
  'independent-measurement',
  'developer-survey',
  'community-signal',
]);

/** The coarse shape of what was counted. Never converted between kinds. */
export const usageMetricKind = z.enum([
  'active-users',
  'developer-accounts',
  'requests',
  'tokens',
  'downloads',
  'deployments',
  'repository-signal',
  'survey-share',
]);

export const usageObservationSchema = z.object({
  id: entityId,
  releaseId: entityId,
  metric: usageMetricKind,
  // The metric as the source itself names it, so two figures are never merged
  // because a coarse kind happens to match.
  metricLabel: z.string().min(1),
  unit: z.string().min(1),
  // Exactly who or what was counted. Two observations of the same metric over
  // different populations are separate facts, not two readings of one fact.
  population: z.string().min(1),
  value: z.number().optional(),
  // Always required: the claim as stated, so a missing numeric value still
  // renders something a reader can check against the source.
  valueAsStated: z.string().min(1),
  windowStart: partialDate,
  windowEnd: partialDate,
  methodology: z.string().min(1),
  sourceCategory: usageSourceCategory,
  sourceIds: z.array(entityId).min(1),
  scope: z.string().min(1),
  caveats: z.array(z.string().min(1)).min(1),
  // Conflicting readings stay side by side; nothing picks a winner.
  conflictsWithIds: z.array(entityId).default([]),
  verifiedAt: isoDate,
});

export const usageSynthesisSchema = z.object({
  id: entityId,
  releaseId: entityId,
  statement: z.string().min(1),
  observationIds: z.array(entityId).min(2),
  // A synthesis may report agreement or disagreement; it may not resolve it.
  agreement: z.enum(['agreeing', 'conflicting']),
  comparabilityNote: z.string().min(1),
  caveats: z.array(z.string().min(1)).min(1),
  verifiedAt: isoDate,
});

/** Exactly one of these. Guidance is always conditional; there is no neutral verdict. */
export const fitClassification = z.enum(FIT_CLASSIFICATIONS);

/** The disclosed rubric dimension a statement was derived from. Never a score. */
export const fitRubricDimension = z.enum(FIT_RUBRIC_DIMENSIONS);

export const fitGapReason = z.enum(FIT_GAP_REASONS);

/**
 * A pointer to one structured fact already recorded in this dataset. Guidance
 * may not stand on prose: every statement resolves to records that each carry
 * their own primary sources and verification date, so the guidance itself
 * introduces no new external claim.
 */
export const fitFactRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('release-field'), releaseId: entityId, field: z.enum(RELEASE_FACT_FIELDS) }),
  z.object({ kind: z.literal('family-field'), familyId: entityId, field: z.enum(FAMILY_FACT_FIELDS) }),
  z.object({ kind: z.literal('release-event'), eventId: entityId }),
  z.object({ kind: z.literal('benchmark-result'), benchmarkResultId: entityId }),
  z.object({ kind: z.literal('usage-observation'), usageObservationId: entityId }),
  z.object({ kind: z.literal('pricing-record'), pricingRecordId: entityId }),
]);

/**
 * One piece of conditional model-fit guidance.
 *
 * The shape enforces the editorial position: a statement cannot exist without a
 * condition it applies under, the rubric dimensions it was derived from, the
 * facts it rests on, its scope, and at least one caveat. Nothing here ranks a
 * model against another, and the text is checked for winner language below.
 */
export const modelFitStatementSchema = z.object({
  id: entityId,
  releaseId: entityId,
  classification: fitClassification,
  // The "when". Conditionality is structural rather than a matter of phrasing.
  condition: z.string().min(1),
  statement: z.string().min(1),
  // The disclosed rubric. Each dimension must be answered by a cited fact.
  rubricDimensions: z.array(fitRubricDimension).min(1),
  facts: z.array(fitFactRefSchema).min(1),
  sourceIds: z.array(entityId).min(1),
  scope: z.string().min(1),
  caveats: z.array(z.string().min(1)).min(1),
  // Contradicting guidance is kept side by side; nothing picks a winner.
  conflictsWithIds: z.array(entityId).default([]),
  verifiedAt: isoDate,
}).superRefine((statement, context) => {
  const fields: [string, string[]][] = [
    ['condition', [statement.condition]],
    ['statement', [statement.statement]],
    ['scope', [statement.scope]],
    ['caveats', statement.caveats],
  ];

  for (const [field, values] of fields) {
    values.forEach((value, index) => {
      const found = findUniversalClaim(value);
      if (!found) return;
      context.addIssue({
        code: 'custom',
        path: field === 'caveats' ? [field, index] : [field],
        message: `uses unsupported universal-winner language ("${found.phrase}", ${found.name}); guidance is conditional and never declares an overall best model`,
      });
    });
  }
});

/**
 * A rubric dimension ModelTree looked at and could not support. Absence of
 * guidance is recorded rather than left to be read as a silent negative, and a
 * gap carries no source because it asserts no fact about the model.
 */
export const modelFitEvidenceGapSchema = z.object({
  id: entityId,
  releaseId: entityId,
  dimension: fitRubricDimension,
  reason: fitGapReason,
  note: z.string().min(1),
  verifiedAt: isoDate,
}).superRefine((gap, context) => {
  const found = findUniversalClaim(gap.note);
  if (found) {
    context.addIssue({
      code: 'custom',
      path: ['note'],
      message: `uses unsupported universal-winner language ("${found.phrase}", ${found.name}); guidance is conditional and never declares an overall best model`,
    });
  }
});

// What earns a record a place in this dataset, and what keeps it out. Apply in
// order: record exactly one entity kind per record, so a fact about a creator,
// a family, a release, a product, a serving platform, a source, or a publisher
// lives on that entity and never on a neighbour; cite at least one primary
// source and carry the day it was read, which every record-bearing schema above
// requires of itself rather than leaving to judgement; leave a field unset when
// no cited source states it, because a blank is a fact this dataset publishes
// happily -- nobody has sourced this yet -- and a plausible value no source
// states is not a fact at all; withhold the whole record when its required
// fields cannot be sourced that way, and record the gap rather than the guess,
// so that what is missing stays visible instead of being smoothed over; and
// admit the record only as a reviewed change to this repository, never as
// runtime input and never as an open crawl, per ADR 0002. Inclusion decides
// presence and nothing else. It states no order, no score, and no rank; it is
// not the `featured` procedure recorded beside that field, which is applied
// afterwards and only to releases already admitted here; and a record admitted
// by this procedure gains its catalog entry, its canonical route, and its
// correction path whether or not any editorial list names it.
export const datasetSchema = z.object({
  sources: z.array(sourceSchema).min(1),
  publishers: z.array(publisherSchema).default([]),
  organizations: z.array(organizationSchema).min(1),
  families: z.array(familySchema).min(1),
  releases: z.array(releaseSchema).min(1),
  products: z.array(productSchema).default([]),
  servingPlatforms: z.array(servingPlatformSchema).default([]),
  deployments: z.array(deploymentSchema).default([]),
  pricing: z.array(pricingRecordSchema).default([]),
  benchmarks: z.array(benchmarkDefinitionSchema).default([]),
  benchmarkResults: z.array(benchmarkResultSchema).default([]),
  releaseEvents: z.array(releaseEventSchema).default([]),
  usageObservations: z.array(usageObservationSchema).default([]),
  usageSyntheses: z.array(usageSynthesisSchema).default([]),
  modelFitStatements: z.array(modelFitStatementSchema).default([]),
  modelFitEvidenceGaps: z.array(modelFitEvidenceGapSchema).default([]),
});

export type SourceReference = z.infer<typeof sourceSchema>;
export type DatePrecision = z.infer<typeof datePrecision>;
export type FamilyDatePrecision = z.infer<typeof familyDatePrecision>;
export type Publisher = z.infer<typeof publisherSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type ModelFamily = z.infer<typeof familySchema>;
export type ModelRelease = z.infer<typeof releaseSchema>;
export type Product = z.infer<typeof productSchema>;
export type ServingPlatform = z.infer<typeof servingPlatformSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type PricingRecord = z.infer<typeof pricingRecordSchema>;
export type BenchmarkDefinition = z.infer<typeof benchmarkDefinitionSchema>;
export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;
export type ReleaseEvent = z.infer<typeof releaseEventSchema>;
export type UsageSourceCategory = z.infer<typeof usageSourceCategory>;
export type UsageMetricKind = z.infer<typeof usageMetricKind>;
export type UsageObservation = z.infer<typeof usageObservationSchema>;
export type UsageSynthesis = z.infer<typeof usageSynthesisSchema>;
export type FitClassification = z.infer<typeof fitClassification>;
export type FitRubricDimension = z.infer<typeof fitRubricDimension>;
export type FitGapReason = z.infer<typeof fitGapReason>;
export type FitFactRef = z.infer<typeof fitFactRefSchema>;
export type ModelFitStatement = z.infer<typeof modelFitStatementSchema>;
export type ModelFitEvidenceGap = z.infer<typeof modelFitEvidenceGapSchema>;
export type Dataset = z.infer<typeof datasetSchema>;