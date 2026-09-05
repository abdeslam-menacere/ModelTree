# ModelTree Web

Static Astro application for **ModelTree - AI Model Lineage**.

The homepage renders the featured ecosystems the reviewed catalog defines as an
interactive lineage, and every seeded release gets a Model Passport. Astro
renders the full hierarchy to HTML; React islands enhance creator and model
selection and keep `?provider=<slug>&model=<slug>` state shareable. Which
creators and families appear is derived from the records at build time, so
seeding a creator adds it to the explorer without a code change.

## Commands

Run commands from `web/`:

| Command | Action |
|---|---|
| `npm ci` | Install dependencies exactly from the lockfile |
| `npm test` | Run data-integrity and URL-state tests |
| `npm run test -- <path>` | Run only the test files matching `<path>`; refuses if none do |
| `npm run check` | Run Astro and TypeScript diagnostics |
| `npm run validate` | Run tests and diagnostics |
| `npm run budget:compare` | Print `/compare` payload and picker index headroom for the working tree |
| `npm run budget:merged` | Print the same headroom for the **merge** with `origin/main`, next to the branch-only figures — [run this before cutting scope for bytes](../docs/product/PERFORMANCE-BUDGETS.md#measure-the-merge-not-the-merge-base) |
| `npm run budget:proof` | Prove `budget:merged` returns exit 1 when only the merge breaches a ceiling, and exit 0 when it does not |
| `npm run build` | Validate and generate the static site in `dist/` |
| `npm run dev` | Start the local Astro development server |

Before writing a test, read the
[testing conventions](../CONTRIBUTING.md#testing-conventions) — an assertion is
only coverage if it can fail, and this repository has shipped several that could
not.

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

<!-- date-basis-policy:start -->
A release or family may record an optional `dateBasis`. Its single value,
`platform-repository-created`, means the committed date is a hosting platform's
own record of when a repository was created — a Hugging Face Hub `createdAt`,
say — that no creator statement of a release date was found, and that the date is
kept because it bounds when the model existed rather than because a creator stated
it. The member is named for creation and not publication because that is all the
field attests: `createdAt` matches the repository's own oldest commit, and a
repository may be created private and made public later, so it cannot show when
anything first became visible. **The absence of `dateBasis` asserts nothing.** It
does not mean the date is creator-stated; it means no basis has been established
either way, which is why there is no `creator-stated` value to reach for. Equality
between a committed date and a cited repository's `createdAt` is evidence and not
proof — a creator may genuinely release on the day they upload — so a record is
marked only when the date appears in its cited sources solely as platform
metadata. ADR 0009 records the decision.
<!-- date-basis-policy:end -->

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
it. ModelTree speaks in its own words in more than one document — the editorial
summaries in `variant-positioning.json` and the definitions in `glossary.json`
are two others — but this is the one that turns recorded facts into guidance, so
it carries the strictest rules in the repository.

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

### Sibling variant positioning

`variant-positioning.json` records what a creator says one of its own variant
names — the tier names readers see, `Opus`, `Flash`, `Nano` — is for. A record is
keyed on a `familyId`, never on a model name, because a family in this dataset is
already generation-scoped: `google-gemini-2-5` "Pro" and `google-gemini-3` "Pro"
are two independent records, and neither inherits the other's meaning. Membership
is derived rather than asserted — a record names a variant name, and its members
are every release in that family whose `variant` matches — so a record cannot
name a release outside its own family.

Each variant entry has two structurally separate halves, and the separation is
the point:

- `official` holds **only** verbatim quotes and their source metadata. There is
  no ModelTree-authored string in it. Each source carries `url`, `title`,
  `publisher`, the `quote` itself, and `lastCheckedDate`; the entry carries
  `effectiveAsOf`. `sources` is `min(1)` and deliberately unbounded, because a
  creator often explains one name across a model card, a docs page and a launch
  post — and **every** cited page is rendered, both in the Passport and on the
  line beside the node in the lineage explorer. Showing the first and dropping
  the rest was issue #650: silent, gate-clean, and the one failure this document
  cannot afford, since it makes the evidence trail on the page read shorter than
  the evidence in the record. Where a name rests on more than one page the
  Passport says so in words above the quotes, and each page keeps its own title,
  link and check date, so two pages from the same publisher stay distinguishable
  by their own text rather than by which one is printed first.
- `editorial.summary` is ModelTree's reading of that claim, with its own
  `verifiedAt`. It is ModelTree-authored prose, as is the record-level `note`,
  and both are held to the wording rules described below.

Both are rendered with visible text labels rather than by colour, italics, or
position, so the two voices stay distinguishable in reading order and to a screen
reader.

What the shape makes unsayable is as important as what it records. No field can
reference another organization, family, or release, so a cross-creator analogy
("this vendor's mid tier is like that vendor's fast tier") is not expressible —
and the view builder additionally throws at build time if ModelTree's prose names
another creator or another creator's family. That check is **best-effort, not a
guarantee**: it matches each other creator by the forms the dataset registers for
it — its `name`, its `shortName`, and any colloquial short forms recorded in its
`aliases` — and by each other creator's family `name`, on word boundaries so a
name inside a longer word is left alone. A short form a creator is commonly
called but that is registered under none of those fields is therefore *not*
caught; the guard closes the natural sentences, not every conceivable one, and
adding a creator's colloquial form to its `aliases` is how a newly noticed
bypass is closed in data rather than in code. There is no price field and no fact
reference of any kind, so tier meaning can never be derived from cost. Both
`note` and `editorial.summary` run through the repository's universal-claim
filter plus a positioning-specific vocabulary filter covering recommendations,
prescriptive advice, price wording, letter grades, and ordered-ladder framing.

Coverage is derived, never declared. A family with no record is `absent`, a
family whose every variant is recorded is `complete`, and anything between is
`partial` — with the uncovered variants named explicitly. There is no settable
completeness flag, so a record cannot claim coverage it does not have, and an
undocumented tier ladder stays visibly unknown instead of being guessed at.

Two deliberate departures from the rest of the dataset, both shared with
`glossary.json`:

- The document is **not** part of `raw.ts`, so it is outside the auto-merge
  qualifying class in ADR 0003. These are ModelTree editorial claims and should
  not merge without review.
- Sources are recorded inline rather than as ids into `sources.json`, because a
  per-source verbatim quote is what makes the creator's voice visible. The cost
  is that `source-link-health` does not sweep these URLs.

Code, field, and file names say `variant` and `positioning` rather than `tier`,
because `gate-dataset.mjs` classes `tier` as ranking vocabulary; the rendered
prose still says "tier", which is the reader's word. `variant-positioning.test.ts`
parses that word list out of the gate script and asserts no key in the committed
document matches it.

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

That structural requirement is not the evidence rule, and the two are easy to
confuse at exactly the moment a claim is written:

<!-- osi-approved-evidence-policy:start -->
`osiApproved` must rest on a source that states OSI approval — OSI's own
published licence list at opensource.org. An `spdxId` or a licence `url` alone
is not evidence of OSI status: where the schema requires one, that requirement
is a structural floor — it ensures a licence is identified — not the evidence
rule for the field's truth, which is the reviewer's to apply.
<!-- osi-approved-evidence-policy:end -->

The seed data was checked against these official pages on 2026-08-14:

- <https://openai.com/index/gpt-4-1/>
- <https://developers.openai.com/api/docs/models/gpt-4.1>
- <https://developers.openai.com/api/docs/models/gpt-4.1-mini>
- <https://developers.openai.com/api/docs/models/gpt-4.1-nano>

Anthropic, Google DeepMind, and Meta records were checked against the pages
listed in `src/data/sources.json` on 2026-08-15. Every URL cited by those records
returned HTTP 200 during that pass. Records added later carry their own
`lastCheckedDate`, which is the date to read for them; this paragraph describes
one pass and not the whole file. Recorded titles are the document's own title
without the site suffix a publisher appends to the browser `<title>`, so "Models
overview" is recorded where the browser tab reads "Models overview - Claude
Platform Docs".

xAI, Mistral AI, and DeepSeek records were checked against the pages listed in
`src/data/sources.json` on 2026-08-28, under the same rules.

Unknown facts remain omitted. Family membership does not imply an undocumented
predecessor, successor, or architecture relationship.

### Data notes

Where sources disagree or fall short, the dataset records the conservative
reading and the disagreement is written down here rather than resolved silently.

<!-- data-notes-anchors: A bullet below that states something checkable about a
     named record carries one machine-readable anchor per atomic claim, written
     as an HTML comment opening with "claim:" and holding one JSON object,
     indented inside the bullet it belongs to.
     src/data/data-notes-claims.test.ts reads those anchors and asserts each one
     against the composed dataset. It never reads the prose: the anchor is the
     claim. The kinds are records, omits, lists, absent, and none-matching; that
     test defines each one and pins which bullets are deliberately unanchored. A
     bullet that only judges, explains, or states policy takes no anchor and is
     added to that pin instead. -->

- **Claude Haiku 4.5 date.** The model identifier is `claude-haiku-4-5-20251001`
  but the launch announcement is dated 15 October 2025. The announcement date is
  recorded, because a dated announcement is a stronger claim than a date embedded
  in an identifier. Identifier dates are not treated as release dates anywhere.
  <!-- claim: {"kind":"records","entity":"releases","id":"anthropic-claude-haiku-4-5","field":"releaseDate","value":"2025-10-15"} -->
- **Llama 3.3 date.** The `meta-llama/llama-models` README table says 12/04/2024
  while the model card and the licence both say 6 December 2024. The model card
  date is recorded.
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-3-70b","field":"releaseDate","value":"2024-12-06"} -->
- **Gemini 2.5 shutdown.** `ai.google.dev` states that no shutdown date has been
  announced for Gemini 2.5 Pro and Flash, while the Cloud platform model pages
  give a retirement date of 2026-10-20. Both models are recorded as `current`
  and no shutdown date is asserted.
  <!-- claim: {"kind":"records","entity":"releases","id":"google-gemini-2-5-pro","field":"status","value":"current"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"google-gemini-2-5-flash","field":"status","value":"current"} -->
  <!-- claim: {"kind":"none-matching","entity":"releaseEvents","where":{"releaseId":"google-gemini-2-5-pro","type":"retired"}} -->
  <!-- claim: {"kind":"none-matching","entity":"releaseEvents","where":{"releaseId":"google-gemini-2-5-pro","type":"deprecated"}} -->
  <!-- claim: {"kind":"none-matching","entity":"releaseEvents","where":{"releaseId":"google-gemini-2-5-flash","type":"retired"}} -->
  <!-- claim: {"kind":"none-matching","entity":"releaseEvents","where":{"releaseId":"google-gemini-2-5-flash","type":"deprecated"}} -->
- **Gemini 3.7 Flash release date precision.** The Gemini API documentation
  announces "August 2026" without a day, while the Gemini Enterprise Agent
  Platform documentation gives 2026-08-13. The platform date is recorded at `day`
  precision, and that source is cited for it.
  <!-- claim: {"kind":"records","entity":"releases","id":"google-gemini-3-7-flash","field":"releaseDate","value":"2026-08-13"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"google-gemini-3-7-flash","field":"datePrecision","value":"day"} -->
  <!-- claim: {"kind":"lists","entity":"releases","id":"google-gemini-3-7-flash","field":"sourceIds","value":"google-gemini-3-7-flash-platform-docs"} -->
- **Kimi K2 Instruct date is the Hub's, not Moonshot AI's.** No Moonshot-published
  page states a release date for this model. The committed 2025-07-11 is the
  Hugging Face Hub `createdAt` of `moonshotai/Kimi-K2-Instruct`; on the cited card
  page that string occurs only inside `"createdAt":"2025-07-11T00:55:12.000Z"`,
  never in Moonshot AI's prose, whose own changelog instead lists 2025.7.15,
  2025.7.18 and 2025.8.11 — card revisions, the earliest four days later. The date
  is kept because it bounds when the model existed, and it declares `dateBasis`
  `platform-repository-created` so it is not read as a creator claim (ADR 0009).
  <!-- claim: {"kind":"records","entity":"releases","id":"moonshot-ai-kimi-k2-instruct","field":"releaseDate","value":"2025-07-11"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"moonshot-ai-kimi-k2-instruct","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"lists","entity":"releases","id":"moonshot-ai-kimi-k2-instruct","field":"sourceIds","value":"hugging-face-kimi-k2-instruct-hub-record"} -->
  <!-- claim: {"kind":"records","entity":"families","id":"moonshot-ai-kimi-k2","field":"dateBasis","value":"platform-repository-created"} -->
- **ERNIE 4.5 300B A47B date is the Hub's, not Baidu's.** Same shape, and the
  record already cited the Hub API endpoint it rests on. The committed 2025-06-28
  is the `createdAt` of `baidu/ERNIE-4.5-300B-A47B-PT`; the card carries no
  occurrence of it, and no Baidu-published page read for this record states a
  release date. It declares `dateBasis` `platform-repository-created` rather than
  leaving that basis stated only in a source note.
  <!-- claim: {"kind":"records","entity":"releases","id":"baidu-ernie-4-5-300b-a47b","field":"releaseDate","value":"2025-06-28"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"baidu-ernie-4-5-300b-a47b","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"records","entity":"families","id":"baidu-ernie-4-5","field":"dateBasis","value":"platform-repository-created"} -->
- **OpenELM 3B Instruct date is the Hub's, not Apple's.** Its own committed source
  notes already said so — Apple's research page "states no release date for the
  weights, which is why this release's date rests on the Hub record instead" —
  leaving the conclusion in prose while the record stayed unmarked. The committed
  2024-04-12 is the `createdAt` of `apple/OpenELM-3B-Instruct`, and no Apple page
  read for this record states a release date. It now declares `dateBasis`
  `platform-repository-created`.
  <!-- claim: {"kind":"records","entity":"releases","id":"apple-openelm-3b-instruct","field":"releaseDate","value":"2024-04-12"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"apple-openelm-3b-instruct","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"records","entity":"families","id":"apple-openelm","field":"dateBasis","value":"platform-repository-created"} -->
- **Sarvam-M's date is the Hub's, and the creator's own page gives a different
  day.** The committed 2025-05-20 is the `createdAt` of `sarvamai/sarvam-m`, while
  Sarvam AI's announcement — already cited on this record — is dated 2025-05-23,
  three days later, and states no release date for the weights. Both are kept and
  neither is presented as the other: the release keeps the date that bounds when
  the weights existed and declares `dateBasis` `platform-repository-created`. This
  is the clearest instance of #682 in the dataset, because a creator-dated page
  exists and disagrees.
  <!-- claim: {"kind":"records","entity":"releases","id":"sarvam-ai-sarvam-m-v1","field":"releaseDate","value":"2025-05-20"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"sarvam-ai-sarvam-m-v1","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"records","entity":"families","id":"sarvam-ai-sarvam-m","field":"dateBasis","value":"platform-repository-created"} -->
- **All three DeepSeek dates are repository-creation timestamps, and the records
  already said so in their own summaries.** `deepseek-v4-pro` and
  `deepseek-v4-flash` each state in their committed `summary` that "the release
  date is the day the repository was published on the creator's verified Hugging
  Face organization, because no dated announcement on the creator's own domain
  could be reached", and all three cite a Hub repository record and no dated
  creator announcement. A 2026-08-31 re-read confirmed it: on every card page each
  occurrence of the committed date sits inside `createdAt`, `lastModified`, or an
  "Updated" timestamp, and the creator README contains it zero times. The basis
  was therefore established in prose and is now recorded in the field. The
  `deepseek-v4` family cited only the two model cards, so both Hub records were
  added to it — a marked record cites the platform record its date rests on.
  <!-- claim: {"kind":"records","entity":"releases","id":"deepseek-v4-pro","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"deepseek-v4-flash","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"deepseek-v3-2","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"records","entity":"families","id":"deepseek-v4","field":"dateBasis","value":"platform-repository-created"} -->
  <!-- claim: {"kind":"records","entity":"families","id":"deepseek-v3-2","field":"dateBasis","value":"platform-repository-created"} -->
- **GLM-4.5-Air is not a third case of that pattern.** Its Hub `createdAt` is
  2025-07-20 and the committed value is `2025-07` at month precision, which that
  timestamp matches only because a month matches all 31 of its days. Zhipu AI's own
  announcement is dated 2025-07-28 and falls in the same month, so the recorded
  month rests on a creator-dated announcement rather than on the platform
  timestamp, and no `dateBasis` is recorded. A day-precision upgrade to 2025-07-28
  was declined: the cited URL serves a client-rendered shell containing no date,
  and the string is reachable only from a build-hashed script bundle that the
  site's next deploy will rename.
  <!-- claim: {"kind":"records","entity":"releases","id":"zhipu-ai-glm-4-5-air","field":"releaseDate","value":"2025-07"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"zhipu-ai-glm-4-5-air","field":"datePrecision","value":"month"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"zhipu-ai-glm-4-5-air","field":"dateBasis"} -->
  <!-- claim: {"kind":"omits","entity":"families","id":"zhipu-ai-glm-4-5","field":"dateBasis"} -->
- **The full `releaseDate == createdAt` sweep, named rather than counted.** Every
  release whose committed date equals its cited Hub repository's `createdAt`, as
  measured on 2026-08-31 against `/api/models` by raw string prefix. Naming them
  is the point: an earlier count of "17 releases" hid records whose own source
  notes and summaries had already concluded the date rests on the Hub, and they
  stayed invisible until someone re-read them. Equality alone authorises no edit
  (ADR 0009 item 5), so this is a register of what was checked, not a list of
  defects.
  - *Creator source states the same date — genuine same-day release, no defect (4):*
    `nvidia-nemotron-4-340b-base`, `stability-ai-stable-diffusion-3-5-large`,
    `liquid-lfm2-1-2b`, `alibaba-qwen3-5-397b-a17b`. These are why equality is
    evidence and not proof.
  - *Coarse precision, so the match proves nothing (3):* `zhipu-ai-glm-4-5-air`,
    `sakana-ai-evollm-jp-v1-7b`, `ai-singapore-llama-sea-lion-v3-8b`. A month
    matches all of its days.
  - *Established as platform-based and marked (7):* `moonshot-ai-kimi-k2-instruct`,
    `baidu-ernie-4-5-300b-a47b`, `apple-openelm-3b-instruct`,
    `sarvam-ai-sarvam-m-v1`, `deepseek-v4-pro`, `deepseek-v4-flash`,
    `deepseek-v3-2`.
  - *Checked and deliberately left unmarked (3),* each for a stated reason rather
    than for want of looking. `hugging-face-smollm3-3b`: its creator is Hugging
    Face, and the creator's own announcement carries `datePublished`
    `2025-07-08T00:00:00.593Z`, so the date is corroborated by a creator-published
    artefact and does not rest on platform metadata alone — a different case that
    needs its own adjudication, not this marker.
    `bytedance-seed-oss-36b-instruct` cites no Hub API record at all, and
    `xiaomi-mimo-7b-rl-0530` cites the creator's GitHub repository rather than the
    Hub record whose `createdAt` its date matches; marking either would mean
    adding a source it does not currently cite, which is new research rather than
    recording an established basis. All three creator READMEs contain the
    committed date zero times, which is a finding and not a licence to edit.
- **Llama 4 Maverick parameter count.** The model card's own table gives 400B
  total, while the Hugging Face repository metadata on the same page reports
  402B. The model card figure is recorded, because it is the count Meta states in
  prose rather than one derived from the uploaded weights.
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-4-maverick","field":"parameters.totalBillions","value":400} -->
- **Gemini 2.5 Pro and Flash are siblings** because a single technical report
  covers "our Gemini 2.5 models" as one set, not merely because they shared a
  general-availability date.
  <!-- claim: {"kind":"lists","entity":"releases","id":"google-gemini-2-5-pro","field":"siblingIds","value":"google-gemini-2-5-flash"} -->
  <!-- claim: {"kind":"lists","entity":"releases","id":"google-gemini-2-5-flash","field":"siblingIds","value":"google-gemini-2-5-pro"} -->
- **Claude Mythos 5 records no derivation.** Anthropic's docs say Mythos 5 "shares
  the same capabilities" as Claude Fable 5 and that the two "share the same specs
  and pricing". That is a statement of equivalence, not of parentage — it does not
  say either was produced from the other, and the docs note a real difference
  (Mythos 5 omits the safety classifiers that can decline a request).
  `derivedFromIds` is therefore empty and the relationship is carried by the
  sibling link. Mythos 5 is not featured, because it is only available to invited
  customers.
  <!-- claim: {"kind":"records","entity":"releases","id":"anthropic-claude-mythos-5","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"lists","entity":"releases","id":"anthropic-claude-mythos-5","field":"siblingIds","value":"anthropic-claude-fable-5"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"anthropic-claude-mythos-5","field":"featured","value":false} -->
- **Gemini 3.1 Flash-Lite's successor is a migration recommendation.** The
  deprecations table names Gemini 3.5 Flash-Lite as its recommended replacement.
  That is recorded as `successorIds` because the two are the same tier in the same
  family; a recommended replacement in a different tier would not be.
  <!-- claim: {"kind":"lists","entity":"releases","id":"google-gemini-3-1-flash-lite","field":"successorIds","value":"google-gemini-3-5-flash-lite"} -->
- **No Meta lineage is recorded.** The Llama 4 announcement does state that Llama
  4 Maverick was codistilled from Llama 4 Behemoth, but Behemoth was never
  released and has no record here, so there is no id to point at. `derivedFromIds`
  is empty because the parent cannot be referenced, not because no source names
  one. The Llama 3 cards state no derivation at all.
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-4-maverick","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"absent","entity":"releases","id":"meta-llama-4-behemoth"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-1-405b","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-3-70b","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-1b","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-3b","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-11b-vision","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-90b-vision","field":"derivedFromIds","value":[]} -->
- **Claude 4.5 lifecycle wording differs between two cited pages.** The
  deprecations table lists `claude-sonnet-4-5-20250929` and
  `claude-haiku-4-5-20251001` as Active, while the models overview places Sonnet
  4.5 in its Legacy accordion. The family follows the overview's grouping and is
  recorded as `legacy`; no retirement date is asserted for either model.
  <!-- claim: {"kind":"records","entity":"families","id":"anthropic-claude-4-5","field":"status","value":"legacy"} -->
  <!-- claim: {"kind":"none-matching","entity":"releaseEvents","where":{"releaseId":"anthropic-claude-haiku-4-5","type":"retired"}} -->
  <!-- claim: {"kind":"none-matching","entity":"releaseEvents","where":{"releaseId":"anthropic-claude-haiku-4-5","type":"deprecated"}} -->
- **Llama licences are open-weight, not open source.** Each Llama Community
  License requires a separate licence from Meta above 700 million monthly active
  users, which is incompatible with free redistribution, so `osiApproved` is
  `false` on every Meta release.
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-4-scout","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-4-maverick","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-1-405b","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-3-70b","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-1b","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-3b","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-11b-vision","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"meta-llama-3-2-90b-vision","field":"license.osiApproved","value":false} -->
- **Lifecycle mapping.** Anthropic "Retired" maps to `deprecated`, invitation-only
  availability maps to `preview`, and the docs' "Legacy models" section maps to
  `legacy`. On Hugging Face, Meta's "Current" and "History" groupings map to
  `current` and `legacy`.
- **Conditional fit guidance is seeded, not exhaustive.** The statements recorded
  span Llama 4 Scout, Claude Mythos 5, Claude Haiku 4.5, and GPT-5. Their count and
  per-release breakdown are owned by `src/data/model-fit.test.ts`, which reads the
  live seed and reddens when a statement is added or removed; this note points at
  that test rather than restating a number nothing checks. Each statement is
  derived from facts already recorded here and cites only sources those facts
  already carry, so guidance introduces no new external claim and every
  statement's `verifiedAt` is the verification date of the evidence beneath it. A
  release with no statement is a release where no derivable guidance was found,
  not one judged unsuitable.
- **The Claude Haiku 4.5 lifecycle disagreement is published as a conflict.** The
  release is recorded `current` while its family is recorded `legacy`, because the
  vendor's own deprecation table and models overview group it differently (see the
  Claude 4.5 note above). Both readings are published as conflicting statements,
  linked reciprocally, and neither is marked correct. This is the intended
  behaviour of the conflict state, not an error awaiting correction.
  <!-- claim: {"kind":"records","entity":"releases","id":"anthropic-claude-haiku-4-5","field":"status","value":"current"} -->
  <!-- claim: {"kind":"records","entity":"families","id":"anthropic-claude-4-5","field":"status","value":"legacy"} -->
- **Evidence gaps are recorded for Llama 4 Scout and GPT-5.** Their count and
  per-release breakdown are owned by `src/data/model-fit.test.ts` alongside the
  statement counts, so this note names the releases without restating a number
  nothing checks. Each gap names a rubric dimension that was looked at and could
  not be supported — a missing usage observation for Llama 4 Scout, a missing
  benchmark result for GPT-5 — so the absence is visible rather than silent.
  <!-- claim: {"kind":"records","entity":"modelFitEvidenceGaps","id":"gap-llama-4-scout-usage","field":"releaseId","value":"meta-llama-4-scout"} -->
  <!-- claim: {"kind":"records","entity":"modelFitEvidenceGaps","id":"gap-llama-4-scout-usage","field":"dimension","value":"usage-evidence"} -->
  <!-- claim: {"kind":"records","entity":"modelFitEvidenceGaps","id":"gap-gpt-5-benchmarks","field":"releaseId","value":"openai-gpt-5"} -->
  <!-- claim: {"kind":"records","entity":"modelFitEvidenceGaps","id":"gap-gpt-5-benchmarks","field":"dimension","value":"measured-benchmark-evidence"} -->
- **xAI is recorded once, under both of the names it uses for itself.** The
  creator's own site titles its pages "… | SpaceXAI" and carries the footer
  "© 2026 SpaceXAI LLC", while its developer documentation calls the product
  surface "the xAI API". Rather than pick a winner, `name` is "SpaceXAI" and
  `shortName` is "xAI", so both stay searchable as organization aliases. No
  rename, succession, or corporate relationship between the two names is
  asserted, because no source states one.
  <!-- claim: {"kind":"records","entity":"organizations","id":"xai","field":"name","value":"SpaceXAI"} -->
  <!-- claim: {"kind":"records","entity":"organizations","id":"xai","field":"shortName","value":"xAI"} -->
- **No Grok release records a parameter count.** xAI publishes none on either the
  announcements or the model documentation pages, so `parameters` is omitted
  entirely rather than zeroed or estimated.
  <!-- claim: {"kind":"omits","entity":"releases","id":"xai-grok-4-6","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"xai-grok-4-5","field":"parameters"} -->
- **Nine name-only parameter counts document their gap in `summary`, not
  `intendedUse`.** These releases assert a parameter count in their identifier —
  a `34B`, `7B`, `2B` and so on — but record no `parameters` block, because no
  primary source states a total that could be cited; the "count" exists only in
  the name. Each one explains that absence, and the explanation lives in
  `summary` rather than `intendedUse` for a measurable reason:
  `buildComparisonPayload` ships an allow-list that includes `intendedUse` and
  excludes `summary`, so a note in `intendedUse` pays `/compare` payload bytes on
  every render while the same note in `summary` costs zero (see the payload
  budget in `src/lib/comparison.test.ts`). An explanation of an *absent* field is
  editorial context and belongs in the editorial field; `intendedUse` is
  reserved for what the model is for. `src/data/parameter-gap-field.test.ts`
  pins the set and the field, so the tenth such record does not have to guess.
  A model whose count appears only as approximate prose on a source, with no
  count in its identifier, is not one of these nine — but it follows the same
  field convention, which the next bullet records.
  <!-- claim: {"kind":"omits","entity":"releases","id":"01-ai-yi-1-5-34b-chat","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"01-ai-yi-34b-chat","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"apple-fastvlm-7b","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"zhipu-ai-cogvideox-2b","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"lg-ai-research-exaone-4-0-32b","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"maritaca-ai-sabia-7b","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"nvidia-nemotron-nano-9b-v2","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"ai2-molmo-7b-d","field":"parameters"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"nvidia-cosmos-1-0-diffusion-7b-text2world","field":"parameters"} -->
- **The `summary` convention follows the absent count, not the identifier.** The
  bullet above is gated on the identifier stating a count, which left one
  question open: does a record that documents an absent count *without* one
  belong to the same convention, or is it correctly outside it?
  `tencent-hunyuan-video-t2v` was the case — its card says the model has "over
  13 billion parameters" and states no exact figure, so nothing is citable, and
  its identifier says `t2v` rather than `13b`. It belongs. The identifier gate
  describes how such a record gets *noticed*; it never described where the note
  goes, and the catalogue had already outgrown it. Measured for #943: of the
  fifteen releases that record no `parameters` block and explain the absence in
  prose, five state no count in their identifier — both Grok releases,
  `deepseek-v3-2`, `kyutai-moshiko-pytorch-bf16` and this one — and four of
  those five already carried the explanation in `summary`, which left this
  record the only one in the catalogue explaining a missing count in the field
  that ships. So the convention was never really conditional on the name, and
  the boundary that mattered is the absence itself. Its sentence moved to
  `summary` verbatim; `intendedUse` keeps what the model is for.
  `src/data/parameter-gap-field.test.ts` pins all fifteen, and pins that the
  widened filter still refuses records that record the count they discuss — a
  guard that stops widening from turning into a tautology. No `parameters` block
  was added: no primary source states an exact total, and that absence is the
  finding rather than a gap to fill.
  <!-- claim: {"kind":"omits","entity":"releases","id":"tencent-hunyuan-video-t2v","field":"parameters"} -->
- **Grok 4 anchors its family but is not itself a release record.** The Grok 4
  announcement is dated 9 July 2025 and that date is the family's
  `firstReleaseDate`, but the model's documentation page is no longer served, so
  its modalities and context window cannot be sourced and no release is recorded
  for it. A family is dated to its first release whether or not that release is
  represented, which is the same reading the Gemini 3 family already uses.
  <!-- claim: {"kind":"records","entity":"families","id":"xai-grok-4","field":"firstReleaseDate","value":"2025-07-09"} -->
  <!-- claim: {"kind":"absent","entity":"releases","id":"xai-grok-4"} -->
- **Mistral Large 3 parameter count disagreement.** The model card's header gives
  675B total and 41B active, while its body text gives "673B params and 39B
  active" alongside "a 2.5B Vision Encoder" — the two readings differ by roughly
  the size of that encoder. The header figures are recorded, because they are the
  counts the card states for the model as published, and the disagreement is
  written down here rather than averaged away.
  <!-- claim: {"kind":"records","entity":"releases","id":"mistral-large-3-675b-instruct","field":"parameters.totalBillions","value":675} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"mistral-large-3-675b-instruct","field":"parameters.activeBillions","value":41} -->
- **Downloadable weights are recorded separately from licensing, and the two do
  not track each other.** Mistral Large 3 is offered both through a hosted API and
  as downloadable weights under Apache-2.0, so its `accessType` is `both` and
  `osiApproved` is true. Devstral 2 123B is equally downloadable under a Modified
  MIT licence with an added condition, so its weights are downloadable while
  `osiApproved` is false. The Grok releases are hosted only and carry no `license`
  object at all, rather than a licence recorded as unknown.
  <!-- claim: {"kind":"records","entity":"releases","id":"mistral-large-3-675b-instruct","field":"accessType","value":"both"} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"mistral-large-3-675b-instruct","field":"license.osiApproved","value":true} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"mistral-devstral-2-123b-instruct","field":"license.weightsDownloadable","value":true} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"mistral-devstral-2-123b-instruct","field":"license.osiApproved","value":false} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"xai-grok-4-6","field":"license"} -->
  <!-- claim: {"kind":"omits","entity":"releases","id":"xai-grok-4-5","field":"license"} -->
- **DeepSeek dates come from repository publication, not from an announcement.**
  The creator's own domain could not be reached from this environment during the
  2026-08-28 pass, using two independent tools, so no dated first-party
  announcement was available. The recorded dates are the days the model
  repositories were published on the creator's verified Hugging Face
  organization. This is a weaker claim than a dated announcement and is labelled
  as such in each release's own summary. It is weaker in a specific way worth
  naming: Mistral's repositories were created before its announcements — the
  Mistral Large 3 repository predates the Mistral 3 post — so repository
  publication is a bound on when a model appeared, not proof of when it was
  announced.
- **No DeepSeek derivation or distillation is recorded.** The DeepSeek-V4 card
  describes consolidating the creator's own domain-specialist models by on-policy
  distillation. That is internal post-training within one release, not a parent
  model that exists separately, so it is not a `derivedFromIds` edge.
  DeepSeek-V3.2 declares a base model of DeepSeek-V3.2-Exp-Base, which has no
  record here, so there is no id to point at. Naming similarity between
  repositories is not treated as evidence of lineage anywhere.
  <!-- claim: {"kind":"records","entity":"releases","id":"deepseek-v4-pro","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"deepseek-v4-flash","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"records","entity":"releases","id":"deepseek-v3-2","field":"derivedFromIds","value":[]} -->
  <!-- claim: {"kind":"absent","entity":"releases","id":"deepseek-v3-2-exp-base"} -->

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
