# ModelTree Web

Static Astro application for **ModelTree - AI Model Lineage**.

The first vertical slice renders one source-backed OpenAI family as an
interactive lineage and generates a Model Passport for each seeded release.
Astro renders the full hierarchy to HTML; one React island enhances model
selection and stable `?model=<slug>` state.

## Commands

Run commands from `web/`:

| Command | Action |
|---|---|
| `npm ci` | Install dependencies exactly from the lockfile |
| `npm test` | Run data-integrity and URL-state tests |
| `npm run check` | Run Astro and TypeScript diagnostics |
| `npm run validate` | Run tests and diagnostics |
| `npm run build` | Validate and generate the static site in `dist/` |
| `npm run dev` | Start the local Astro development server |

### The lockfile resolves through a mirror, with SHA-1 integrity

Every `resolved` URL in `package-lock.json` points at an Azure DevOps
`1es-public` mirror, and each of those entries carries `sha1-` integrity rather
than npm's default `sha512-`. This is a **known and accepted constraint, not an
oversight**: the mirror publishes no `integrity` field at all, only a SHA-1
`shasum`, so npm has no `sha512` to record. Regenerating the lockfile cannot
change this.

Two consequences to expect:

- **`npm install` on a different registry rewrites the whole file.** If your npm
  is not pointed at that mirror, expect a full-tree diff on any dependency
  change. Keep it in its own commit so a real change is not lost in the noise.
- **npm 11.9.0 strips `libc` selectors.** The native Linux packages carry a
  `libc` selector, and it is what npm chooses a glibc or a musl binary on.
  Losing one is silent where it happens and surfaces as a wrong or missing
  native package on some other platform, so a command that rewrites the lockfile
  is the risk event. Checking for that by hand is no longer the mechanism:
  `tests/lockfile/libc-selectors.test.ts` runs in `npm test`, reads the
  committed lockfile, and names the offending package and the direction when a
  selector is dropped, swapped to the wrong C library, written in a shape npm
  does not read, or added to a package the expectation list does not know about.

Neither bullet states a count, and that is deliberate rather than an omission.
A number that measures the lockfile is correct only against one merge-base: two
branches that each add a native Linux package can both state a correct total and
still merge to a wrong one, with no pull request left to notice. So the packages
are enumerated in `tests/lockfile/libc-selectors.ts`, which is compared against
the lockfile on every run and therefore cannot quietly disagree with it, and the
number is left to that list rather than restated in prose nothing checks.
`.github/scripts/check-skill-doc-test-counts.mjs` refuses hand-written test
counts in the skill documentation on the same reasoning. A *chosen threshold* is
a different thing from a *measurement* and is safe to write down, because it
moves only when someone decides to move it and never as a side effect of
unrelated work.

Do not hand-write `integrity` values, and do not change the registry as a
side-effect of a dependency bump. The reasoning, the evidence, and the full
guardrails are in
[ADR 0004](../docs/adr/0004-sha-1-lockfile-integrity-is-a-mirror-constraint.md),
which records its measurements as dated observations. Read a count there as
evidence for the decision it supports, not as a claim about the lockfile today.

## Data

Editable source records live in `src/data/*.json`. `src/data/schema.ts` defines
the entity contracts, and `src/data/validate.ts` enforces cross-record rules.

| Entity | Holds |
|---|---|
| `organization` | A creator, lab, or platform operator |
| `family` | A named model lineage belonging to one organization |
| `release` | A dated model version, its tier, limits, licence, and relationships |
| `product` | A user-facing application, which may route between models |
| `servingPlatform` | Somewhere a model can be accessed, rarely its creator |
| `deployment` | One release made available on one platform |
| `pricingRecord` | Rates for one deployment, with currency, unit, and effective date |
| `benchmarkDefinition` | What a benchmark measures, in which unit and direction |
| `benchmarkResult` | One score for one exact release, with its evaluation setup |
| `releaseEvent` | A dated lifecycle event such as announced or deprecated |
| `usageObservation` | One source-qualified usage reading: metric, population, window, method, and caveats |
| `usageSynthesis` | A cross-source statement over comparable observations from two independent publishers |
| `modelFitStatement` | One conditional fit statement about one release: its classification, condition, disclosed rubric dimensions, the recorded facts it rests on, scope, and caveats |
| `modelFitEvidenceGap` | A rubric dimension that yields no guidance for a release, and why |
| `source` | The primary reference and the date it was last checked |
| `publisher` | Who a source speaks for, plus an optional sourced, dated controlling-company link |

The build fails for duplicate identifiers or slugs, impossible or partial dates
that contradict their stated precision, broken references, non-reciprocal
siblings, effective ranges that end before they start, prices with no rate,
benchmark results whose unit contradicts their benchmark or that duplicate an
existing setup, and featured releases without a primary source.

Usage evidence carries its own rules. An observation is rejected when it cites
no source, states no caveat, measures a window that closes after its own
verification date or begins before the release existed, labels itself
independent while citing a source published by the model's creator, or labels
itself a creator self-report without one. Conflicts must be reciprocal and must
describe the same metric, unit, and population; incomparable readings are not
conflicts. A `usageSynthesis` is rejected unless it cites at least two
non-creator observations from at least two independent publishers over one
comparability group, so a single-source observation can never become a
cross-source statement. Nothing normalizes, weights, or ranks observations, and
`usage-observations.json` and `usage-syntheses.json` stay empty until a real
source supports an entry.

### Conditional fit guidance

`model-fit-statements.json` holds ModelTree's own editorial reading of the
records: when a release is a good fit, where it is a trade-off, and when to avoid
it. It is the only place in the dataset where ModelTree speaks in its own voice,
so it carries the strictest rules in the repository.

A statement is filed as exactly one of `good-fit-when`, `trade-off`, or
`avoid-when`, and states the `condition` it applies under. There is no fourth,
unconditional kind. Guidance never compares one release with another, and no
composite score, weighting, or ordering exists anywhere in the rubric.

Every statement must be traceable, which is enforced rather than encouraged:

- It cites at least one `fact` — a release or family field, a lifecycle event, a
  benchmark result, a usage observation, or a pricing record — and every cited
  fact must describe the statement's own release (or that release's family).
- Its `sourceIds` must be a subset of the sources those facts already cite, so
  guidance cannot pull in a source no recorded fact carries.
- It cannot be dated earlier than the evidence beneath it.
- Each declared entry in `rubricDimensions` must be answered by a cited fact of a
  kind the rubric allows for that dimension. The rubric lives in
  `src/data/model-fit-rubric.ts`; a dimension is a disclosure of which question
  was asked, never a score.
- `summary` is not a citable release field. It is ModelTree's prose, so deriving
  guidance from it would cite ModelTree as evidence for ModelTree.

Universal-winner language is refused by the schema, and it is worth being precise
about what that check is. It matches a fixed list of vocabulary — superlatives,
best-in-class and go-to framing, beats-everything claims, numeric rankings,
universal quantifiers, and composite-score wording — in a statement's
`condition`, `statement`, `scope`, and `caveats`, and in an evidence gap's
`note`. The rejection names the phrase that failed. It is a vocabulary filter,
not a semantic one: a comparative claim written around those words ("no model
handles long context better than this one") passes it, and it errs toward
rejecting borderline wording an author can rephrase. `model-fit.test.ts` asserts
both directions, including a phrasing the filter knowingly does not catch, so the
limitation is recorded in the suite rather than only in prose. The rule with more
teeth is the provenance rule above: a statement may cite only the sources its own
facts cite, so a comparison cannot pull in a source no recorded fact carries. Be
precise about that one too — it constrains where evidence comes from, not what a
sentence means. Neither check verifies that a statement's content follows from
the facts it rests on; nothing here does semantic entailment. What the system
offers instead is that the facts and sources behind every statement are rendered
beside it, so a reader can check the derivation themselves. The filter runs over
ModelTree's editorial text only — creator-authored prose recorded elsewhere, such
as a release `summary` or `intendedUse`, is reported as the creator's claim
rather than asserted as ModelTree's.

A statement's `verifiedAt` is the verification date of the newest fact it cites,
not a record that an editor re-read the derivation, and it is labelled as
evidence verification wherever it is displayed. Nothing currently re-verifies
guidance independently of its evidence.

Contradictions are kept, not resolved: `conflictsWithIds` must be reciprocal,
must stay within one release, and must share at least one rubric dimension, since
guidance derived from different dimensions is not contradictory. Both readings
render side by side and neither is marked correct.

A `modelFitEvidenceGap` records a dimension that was looked at and could not be
supported, so an absence is not read as a silent negative. A gap carries no
source, because it asserts no fact about the model, and it may not name a
dimension that a published statement on the same release already derives guidance
from — a dimension cannot be both answered and unanswerable.

### Sources and publishers

Every `source` names a `publisherId`, and every id must resolve to an entry in
`src/data/publishers.json`. A publisher is a first-class entity, not a free-text
label, so two sources are "the same voice" only when they point at the same
publisher id — never because their names happen to match. Give genuinely
distinct organizations distinct ids even if they share a display name; the name
is for readers, the id decides independence.

A publisher carries two optional links, and the difference matters:

- `organizationId` marks the publisher as a creator's own voice. Set it only
  when the publisher *is* that creator (for example, publisher `openai` →
  organization `openai`). A source from such a publisher can never count as
  independent evidence about that creator's releases.
- `control` records that the publisher is owned or controlled by another
  publisher: `{ parentId, sourceIds, verifiedAt }`. Ownership is itself a fact,
  so `sourceIds` must cite at least one primary source for the relationship and
  `verifiedAt` dates when it was checked, exactly like any other claim here.
  Independence and the two-publisher synthesis bar both resolve a publisher to
  the root of its `control` chain, so sibling arms of one company (for example
  `google` and `google-cloud`, both under `alphabet`) count as a single voice.

Only encode a `control` link you can cite and are confident is true. If you are
unsure whether two publishers are related, leave them unlinked: an honest gap
that treats them as independent is preferable to an invented ownership claim.
The controlling company lives only in `publishers.json`; do not add it to
`organizations` unless it is itself a model creator, since organizations feed the
creator listings.


Downloadable weights and OSI-approved licensing are separate fields. Claiming
`accessType: "open-weight"` requires a licence that actually releases weights,
and claiming `osiApproved` requires an SPDX identifier or a licence URL.

The seed data was checked against these official pages on 2026-08-14:

- <https://openai.com/index/gpt-4-1/>
- <https://developers.openai.com/api/docs/models/gpt-4.1>
- <https://developers.openai.com/api/docs/models/gpt-4.1-mini>
- <https://developers.openai.com/api/docs/models/gpt-4.1-nano>

Anthropic, Google DeepMind, and Meta records were checked against the pages
listed in `src/data/sources.json` on 2026-08-15. Every URL there returned HTTP
200 during that pass. Recorded titles are the document's own title without the
site suffix a publisher appends to the browser `<title>`, so "Models overview"
is recorded where the browser tab reads "Models overview - Claude Platform Docs".

Unknown facts remain omitted. Family membership does not imply an undocumented
predecessor, successor, or architecture relationship.

### Data notes

Where sources disagree or fall short, the dataset records the conservative
reading and the disagreement is written down here rather than resolved silently.

- **Claude Haiku 4.5 date.** The model identifier is `claude-haiku-4-5-20251001`
  but the launch announcement is dated 15 October 2025. The announcement date is
  recorded, because a dated announcement is a stronger claim than a date embedded
  in an identifier. Identifier dates are not treated as release dates anywhere.
- **Llama 3.3 date.** The `meta-llama/llama-models` README table says 12/04/2024
  while the model card and the licence both say 6 December 2024. The model card
  date is recorded.
- **Gemini 2.5 shutdown.** `ai.google.dev` states that no shutdown date has been
  announced for Gemini 2.5 Pro and Flash, while the Cloud platform model pages
  give a retirement date of 2026-10-20. Both models are recorded as `current`
  and no shutdown date is asserted.
- **Gemini 3.7 Flash is excluded.** Its documentation gives only "August 2026".
  `releaseDate` is a full ISO date, so a month-only release cannot be represented
  without inventing a day. Tracked as issue #48.
- **Llama 4 Maverick parameter count.** The model card's own table gives 400B
  total, while the Hugging Face repository metadata on the same page reports
  402B. The model card figure is recorded, because it is the count Meta states in
  prose rather than one derived from the uploaded weights.
- **Gemini 2.5 Pro and Flash are siblings** because a single technical report
  covers "our Gemini 2.5 models" as one set, not merely because they shared a
  general-availability date.
- **Claude Mythos 5 records no derivation.** Anthropic's docs say Mythos 5 "shares
  the same capabilities" as Claude Fable 5 and that the two "share the same specs
  and pricing". That is a statement of equivalence, not of parentage — it does not
  say either was produced from the other, and the docs note a real difference
  (Mythos 5 omits the safety classifiers that can decline a request).
  `derivedFromIds` is therefore empty and the relationship is carried by the
  sibling link. Mythos 5 is not featured, because it is only available to invited
  customers.
- **Gemini 3.1 Flash-Lite's successor is a migration recommendation.** The
  deprecations table names Gemini 3.5 Flash-Lite as its recommended replacement.
  That is recorded as `successorIds` because the two are the same tier in the same
  family; a recommended replacement in a different tier would not be.
- **No Meta lineage is recorded.** The Llama 4 announcement does state that Llama
  4 Maverick was codistilled from Llama 4 Behemoth, but Behemoth was never
  released and has no record here, so there is no id to point at. `derivedFromIds`
  is empty because the parent cannot be referenced, not because no source names
  one. The Llama 3 cards state no derivation at all.
- **Claude 4.5 lifecycle wording differs between two cited pages.** The
  deprecations table lists `claude-sonnet-4-5-20250929` and
  `claude-haiku-4-5-20251001` as Active, while the models overview places Sonnet
  4.5 in its Legacy accordion. The family follows the overview's grouping and is
  recorded as `legacy`; no retirement date is asserted for either model.
- **Llama licences are open-weight, not open source.** Each Llama Community
  License requires a separate licence from Meta above 700 million monthly active
  users, which is incompatible with free redistribution, so `osiApproved` is
  `false` on every Meta release.
- **Lifecycle mapping.** Anthropic "Retired" maps to `deprecated`, invitation-only
  availability maps to `preview`, and the docs' "Legacy models" section maps to
  `legacy`. On Hugging Face, Meta's "Current" and "History" groupings map to
  `current` and `legacy`.
- **Conditional fit guidance is seeded, not exhaustive.** Seven statements are
  recorded, across Llama 4 Scout, Claude Mythos 5, Claude Haiku 4.5, and GPT-5.
  Each is derived from facts already recorded here and cites only sources those
  facts already carry, so guidance introduces no new external claim and every
  statement's `verifiedAt` is the verification date of the evidence beneath it. A
  release with no statement is a release where no derivable guidance was found,
  not one judged unsuitable.
- **The Claude Haiku 4.5 lifecycle disagreement is published as a conflict.** The
  release is recorded `current` while its family is recorded `legacy`, because the
  vendor's own deprecation table and models overview group it differently (see the
  Claude 4.5 note above). Both readings are published as conflicting statements,
  linked reciprocally, and neither is marked correct. This is the intended
  behaviour of the conflict state, not an error awaiting correction.
- **Two evidence gaps are recorded for Llama 4 Scout and one for GPT-5.** Each
  names a rubric dimension that was looked at and could not be supported — no
  benchmark result and no usage observation are recorded for those releases — so
  the absence is visible rather than silent.

## Catalog indexes

The build emits `dist/catalog-index.json`: normalized model, provider, alias,
facet, and release-date indexes derived from the validated dataset. They are
generated artifacts, never an editable source of truth.

- Generation is deterministic. Identical data produces an identical file, and the
  index carries a `contentHash` instead of a build timestamp.
- Listing rows carry no detail payload. Summaries, sources, and API aliases stay
  on the detail route and in the alias index.
- Sorting compares by codepoint, so output does not vary with the host locale.
- Aliases and providers keep their entity role, so a name shared by a model and
  an organization stays two distinguishable rows.
- Every model row must resolve to a generated detail route or the build fails.
  `src/lib/routes.ts` is the single list the model route and that check share.
- Budget: **600 bytes per model row**, keeping a 24-row catalog page under 20 KB.
  `src/lib/catalog.test.ts` measures the real dataset and enforces both. The
  budget is a chosen threshold, so it is stated here; the measurement it passes
  with is not, because that figure moves with every release added and nothing in
  this file could keep it true. The pair of numbers this bullet used to quote had
  already drifted on both counts before they were removed, which is the argument
  for not restating them.

`planPagination` slices a sorted slug list into fixed page boundaries, so adding
a record that sorts onto the end leaves earlier pages unchanged.
