# ADR 0011: Access Type Carries an Explicit unknown Member

- Status: Accepted
- Date: 2026-09-01
- Decision owners: ModelTree maintainers
- Supersedes: nothing, but it **amends one guardrail of ADR 0008**. That ADR
  closed by ruling that "`categories`, `accessType` and the modality lists gain
  no `unknown` and no escape hatch", while stating in the same sentence that
  each "would be its own decision with its own justification". This is that
  decision, for `accessType` alone. `categories`, `inputModalities` and
  `outputModalities` keep the discipline ADR 0008 gave them, untouched and for
  the reason ADR 0008 gave. Nothing else here changes: it does **not** widen the
  ADR 0003 qualifying class — a schema change is outside that class, so this
  decision takes the ordinary reviewed path and does not reach `main`
  unattended — and it leaves ADR 0005's finding that the evidence gate verifies
  form rather than remote content standing, which is why the evidence half of
  this decision is enforced by review rather than by a gate.

## Context

`web/src/data/schema.ts` defines the access vocabulary as a required field on
`releaseSchema` with four members and no way out:

```ts
export const accessType = z.enum(['proprietary-hosted', 'open-weight', 'source-available', 'both']);
```

There is no `.default()` and no `.optional()`; `accessType` is required on every
release. So every release must assert one of four claims about how it is
obtained, and #767 reports that a class of well-sourced releases cannot assert
any of them.

That is the shape of the problem ADR 0008 fixed for `lifecycleStatus`, and it is
deliberately **not** an argument from that precedent. ADR 0008 considered this
exact field and ruled against it, on the ground that "a card that omits its
access type or its modalities is not publishing a model, whereas a card that
omits a lifecycle term routinely *is*." Before adding a member on the strength of
an analogy, that ground was tested against the committed ledger. It holds in one
direction and fails in the other, and the two are not symmetric.

### What the ledger measures

`web/src/data/refresh-runs.json` is committed, so this is a measurement rather
than a recollection. Twenty-six strings in it mention `accessType`; fifteen are
record-level `detail` or `objection` entries — a named record that did not land,
or landed over a recorded dissent.

**The dominant direction is `open-weight`, and it is not this ADR's case.** Ten
of those fifteen entries sit in run `2026-08-31-b7c2d9`, and eight of the ten
are release records naming `accessType` among their provenance failures —
`eleutherai-gpt-neo-2-7b`, `ai2-molmo-7b-d`,
`tii-falcon-3-10b-instruct`, `tii-falcon-3-7b-base`,
`nvidia-nemotron-nano-9b-v2`, `nvidia-nemotron-nano-12b-v2-base`,
`ibm-granite-4-0-h-small` and `ibm-granite-4-0-h-tiny`. Each proposed
`open-weight` on the strength of a licence name, a download link, or the word
"Open" in a licence title. The panel was right to refuse all of them, and the
run's own follow-up says what the fix is:

> "accessType: open-weight was rejected on five releases because it rested on a
> licence name, a download link, or the word "open" in a licence title, none of
> which states that weights are downloadable. Several of the cards do carry such
> a statement in prose — the GPT-Neo README says the weights can be freely
> downloaded a sentence before the link that was quoted instead — **so this
> particular gap is a scouting defect and not a structural one**."

A better quote fixes those records. A schema member would only let a scout skip
the sentence that was there to be quoted. So the numerically larger direction
argues *against* loosening the vocabulary, and this ADR must not be read as
addressing it.

**The other direction is structural, and the ledger names four records across
four runs.** Each is a case where no accessible primary source states any access
type at all:

- `google-gemini-2-5-flash-lite`, run `2026-09-01-b41087` — "none of the five
  cited quotes says anything about how the model is released or whether weights
  are downloadable, so that field had no quoted fact behind it."
- `microsoft-mai-image-2-6`, withheld twice, in runs `2026-08-31-ae0342` and
  `2026-08-30-c0b6e9` — "its only availability statement names a product and a
  serving platform rather than the creator's own release, so accessType has no
  creator-level statement."
- `microsoft-mai-thinking-1`, run `2026-08-27-4f1c9e` — "No approved-origin page
  states an accessType or an input/output modality set... The only availability
  statement found — 'available in public preview on Microsoft Foundry' —
  describes a serving platform, not the model's access type, and treating it as
  one would collapse creator and platform into a single entity. **Recorded as
  unknown rather than inferred.**"
- Cohere `rerank-v3.5`, run `2026-08-28-cff539` — "the Rerank table has no Status
  column, no approved origin states its accessType... Three required fields
  unstated."

The last of those is the finding in miniature. A run reached for the word
*unknown* as the honest description, wrote it into its own narrative, and could
not write it into the dataset, because the vocabulary has no such member.

### Why the two directions differ

The asymmetry is a fact about what creators publish, not about how well runs
scout. A creator announces what a model **is**. Nobody publishes the sentence
"our weights are not downloadable," so `proprietary-hosted` is the one member of
this vocabulary that a quote can almost never force. The ledger records a panel
reaching precisely this conclusion, in run `2026-08-29-34e751`, as a dissent on a
claim that was applied anyway:

> "accessType "proprietary-hosted" is not forced by the quotes, because hosted
> availability does not exclude downloadable weights."

`open-weight` is the opposite: a card that distributes weights normally says so,
which is why its gap is recoverable by re-quoting. The rule ADR 0008 relied on —
that a card omitting its access type is not publishing a model — is true of the
open-weight direction and false of the hosted one. A model card can describe a
model completely, in a way that leaves a reader in no doubt it is a real
released product, and still never state how the model is obtained. In that case
the vocabulary offers only a guess.

One run states the underlying question directly, and lists this field in it:

> "The three rubrics have no shared rule for whether dataset-vocabulary fields —
> status, categories, accessType, license.osiApproved — are assertions about the
> world needing their own verbatim quote, or encodings of facts already quoted."

ADR 0008 settled that question for `status`. This settles it for `accessType`:
it is an assertion about the world, it needs its own quote, and when no quote
exists the honest recording is `unknown`.

### What the corpus looks like today

Measured on this checkout, `web/src/data/releases.json` holds 100 releases: 56
`open-weight`, 38 `proprietary-hosted`, 6 `both`, 0 `source-available`. The 38
hosted records were each asserted from something a panel accepted. This decision
is not a claim that they are wrong, and nothing about them changes.

## Decision

**`accessType` gains an `unknown` member, declared last:**

```ts
export const accessType = z.enum([
  'proprietary-hosted',
  'open-weight',
  'source-available',
  'both',
  'unknown',
]);
```

`accessType: 'unknown'` records that no accessible primary source states how the
release is obtained. It is a stated value in the same sense `status: 'unknown'`
and `modelSelection: 'unknown'` are — the record stays complete and renders its
own label — and it is **not** a claim that weights are unavailable. That claim
is `proprietary-hosted`, and it still needs a source of its own.

**It stays coherent with the licence rules by construction.** `claimsWeights` in
`releaseSchema.superRefine` is `open-weight || both`, so `unknown` requires no
`license` object. That is the right coupling: a release whose access type cannot
be established is one the dataset must not assert downloadable weights for, and
the licence requirement exists to back exactly that assertion.

**The contradiction the new member makes possible is refused in the schema.** A
release carrying `accessType: 'unknown'` together with a `license` whose
`weightsDownloadable` is `true` is rejected at `schema.ts:570`, because a licence
record asserting the weights *are* downloadable states the access type. Whichever
half is right, the record is not unknown. Nothing else in the schema would have
noticed this, and it is the cheapest way for the new member to go wrong: a record
drifting to `unknown` while still carrying the evidence that contradicts it.

**Every consumer of `accessType` was enumerated and handled** (the discipline
ADR 0008 records as AC3), split by whether the compiler would have caught an
omission:

Compile-forced — a missing key is a build error:

- `web/src/lib/format.ts` — `accessLabel` is an object literal keyed by the
  union. `unknown: 'Unknown'` was added; the build would not link without it.
- `web/src/lib/methodology.ts` — `accessTypeGlossary` maps over
  `accessType.options` and indexes an object literal of definitions, and
  `web/src/lib/passport.ts:638` additionally *throws* at build time when an
  access value has no glossary entry. A definition was authored, stating that
  `unknown` is not a claim that weights are unavailable.

Silent unless handled — the class ADR 0008 flagged, and where the real defect
was:

- `web/src/lib/comparison.ts` — the `self-hosting` takeaway filters the compared
  releases into `open-weight || both` and `proprietary-hosted` and writes a
  sentence about each group. An `unknown` release falls out of **both** lists
  while the headline still claims the row decides self-hosting. Its existing
  guard, `access.fullyStated`, cannot catch this: the access row is built from
  `accessLabel`, which returns a string for every member, so a rendered
  "Unknown" counts as *stated*. The takeaway is now additionally gated on the
  two lists accounting for every compared release. The guard is keyed on that
  arithmetic rather than on the member's name, so it also closes the identical
  hole `source-available` has always had — unnoticed only because the corpus
  holds none.
- `web/src/lib/catalog.ts`, `web/src/lib/catalog-view.ts` and
  `web/src/lib/homepage-search.ts` — access facets are built from the data with
  an `as never` cast, so TypeScript would not have flagged a new member. Checked:
  each derives its options from the records present and branches on no
  particular value, so `unknown` appears as a facet only once a record carries
  it, labelled by `accessLabel`.
- `web/src/lib/model-fit.ts`, `web/src/data/model-fit-rubric.ts`,
  `web/src/lib/model-dna.ts` and `web/src/lib/timeline.ts` — label-only
  consumers, verified to hold no per-value branch.
- `web/src/styles/global.css` colours access badges through a single
  `.node-access` class rather than per-value selectors, so no member renders
  unstyled or invisible. This is the same check ADR 0008 recorded for `status`,
  re-run for this field rather than assumed from it.

**The deterministic gate is extended to this field, and it is derived rather
than copied.** `.github/skills/modeltree-gates/scripts/gate-dataset.mjs` already
read the `lifecycleStatus` members out of `schema.ts` instead of restating them,
so a vocabulary change could not leave the gate behind. That machinery is now a
table of rules rather than a single hard-coded field, and `accessType` is its
second entry, applied to `releases`. The gate refuses any release whose access
type is outside the schema's own list, **and refuses one that omits the field
entirely** — absence must never read as `unknown`, or dropping a field would be
the most permissive move available to a run applying claims.

**The Python side is kept in lockstep.**
`tools/updater/src/modeltree_updater/validation.py` carries its own
`ACCESS_TYPE` tuple, a deliberate mirror of the schema vocabulary. `unknown` was
added there too. Leaving it out would make the updater reject, in the permissive
direction, a record the web schema accepts — re-blocking the exact case this ADR
unblocks whenever a proposal flows through that path.

**The contributor form follows the schema.**
`.github/ISSUE_TEMPLATE/submit-release.yml` gains `unknown` in its `access-type`
dropdown; `web/tests/contributing/issue-forms.test.ts` asserts the form offers
exactly the schema vocabulary, so omitting it fails that test.

**The evidence half is enforced by review, and this ADR does not pretend
otherwise.** `unknown` is an asserted claim — that the cited sources were read
and none states an access type — and no deterministic gate can verify it. ADR
0005 already records that the evidence gate verifies form, not remote content.
The gate here enforces the mechanical half: vocabulary membership, absence, and
internal contradiction. The evidence bar lives in the `provenance` rubric in
`.github/skills/modeltree-review/SKILL.md`, which is where it becomes operative
and where the open-weight scouting defect is named so `unknown` cannot absorb
it.

**The licence question raised alongside this one is deferred, not answered.**
#767 also asks whether `licenseSchema.name` should admit an unknown. It is a
separate decision with separate consumers, and it is filed as #782. The
measurement it should open with, taken here: of the 62 releases carrying a
licence, all 62 state a `name`, 33 state an `spdxId`, 49 state a `url`, and four
rest on a free-text name with neither identifier. Nothing in this ADR loosens
`licenseSchema`.

**No dataset record changes value, and none is added.** The four ledger records
above stay unpublished; proposing them is a scouting run's work, not this
decision's. `web/src/data/access-unknown.test.ts` demonstrates that they now
*can* be recorded, using self-contained fixtures — the `.modeltree-refresh`
archives are git-ignored and absent from this checkout, so unlike ADR 0008 this
proof re-verifies no claim hashes and does not claim to.

## Consequences

### Positive

- The one direction the ledger shows is structurally unsourceable becomes
  expressible. A release whose creator never states how it is obtained can be
  published honestly instead of withheld or guessed.
- The repository's "unknown and conflicting data stay explicit" rule becomes
  honourable for `accessType`, where the schema previously prevented it.
- The guess that would otherwise fill the field is the *worst* one available.
  Absent a member, the tempting default is `proprietary-hosted`, which is an
  affirmative claim that no weights are distributed — a stronger statement than
  the sources support and one the ledger already records a panel objecting to.
- Two silent defects are closed on the way: the comparison takeaway that dropped
  releases from both of its enumerated groups, and the gate's inability to see
  an access vocabulary at all.

### Costs

- **The vocabulary is looser, in the direction the ledger says is already the
  common failure.** Run `2026-08-31-b7c2d9` accounts for ten of the fifteen
  record-level entries on its own, and eight of those ten are release records
  blocked on `accessType` provenance — every one of them the open-weight
  direction, a claim that would "pass" by being recorded as `unknown` instead of
  by being re-quoted. (The other two of the ten are not that: one is a *families*
  record naming the field only to describe its release's defect, and one is a
  release whose `accessType` the panel called "properly sourced" and rejected on
  a missing licence instead.) That is the misuse this member invites, and it is
  guardrailed below rather than schema-enforced, because no schema can tell a
  missing quote from a missing fact.
- **A third vocabulary to keep in step.** `validation.py` now mirrors two enums
  with an added member each. The relationship is documented at both sites and
  gated for the web side, but the Python side is still a manual mirror.
- **`/compare`, `/tree/` and the catalog facets gain a member that reads as an
  absence.** "Unknown" beside "Hosted API" and "Open-weight" is honest and less
  crisp; the methodology glossary states what it means.
- A schema change takes the full reviewed path and cannot ride the ADR 0003
  auto-merge lane. Intended, not a cost to engineer around.

## Alternatives Considered

- **Convention: an unstated access type is `proprietary-hosted`.** Rejected, and
  it is the option to argue against hardest, because it is what happens by
  default today. It asserts that no weights are distributed, then cites a source
  that says nothing of the kind — the citation-that-does-not-support-its-claim
  failure #556 exists to prevent, committed deliberately and at scale. The
  ledger already contains a panel member refusing exactly this inference
  ("hosted availability does not exclude downloadable weights"), so it would not
  even reliably clear review.
- **Re-scout instead: quote better and the problem disappears.** Rejected as a
  general fix and **adopted for the open-weight direction**, which is where it
  genuinely applies. It does not reach the four records above: there is no
  better quote to find, because the sentence does not exist on any approved
  origin. Re-scouting fixes eight records and leaves four permanently
  unpublishable.
- **Make `accessType` optional.** Rejected for ADR 0008's reason, unchanged. An
  optional field renders as an absent fact; `unknown` is a stated one — "the
  source is silent" — and it keeps every consumer total over the union instead
  of forcing each to handle a missing field.
- **Add `unknown` to `categories` and the modality lists at the same time.**
  Rejected as out of scope and as different decisions. The asymmetry argued
  above is specific to access: a card that describes what a model does states
  its modalities and its category by describing it, whereas nothing about a
  description states how the model is distributed. ADR 0008's discipline for
  those fields stands.
- **Fix the licence gaps in the same change** — `licenseSchema.name`, and #461's
  required `osiApproved`. Rejected as scope. Both are real, both are recorded in
  the ledger, and both change a different schema object with different
  consumers. Bundling them would make one review judge three decisions.

## Guardrails

- **`unknown` means "no accessible primary source states an access type," and
  nothing else.** It is not "not sure which member fits," not a default for a
  scout who did not look, and not a way to publish a record whose other required
  fields are unmapped. Mapping a *stated* access type to `unknown` is a
  provenance failure, exactly as mapping an unstated one to `open-weight` is.
- **The open-weight direction is a scouting defect and is not licensed by this
  member.** Where a card states in prose that weights can be downloaded, that
  sentence is quoted and the record is `open-weight`. Recording such a release as
  `unknown` because the first quote chosen was a licence name is a misuse of this
  ADR, and it is the likeliest one — the ledger says so, which is why it is named
  here and in the review rubric rather than left to judgement.
- **Absence never selects `unknown`.** A release with no `accessType` is a hard
  failure in the schema and in `gate-dataset.mjs`, and the gate carries a test
  for the omission case specifically.
- **`unknown` and downloadable weights cannot coexist.** The schema refuses
  `accessType: 'unknown'` alongside `license.weightsDownloadable: true`.
- **No backfill.** Not one existing record changes value under this decision. A
  record moves to `unknown` only through the ordinary claim path, with the
  reasoning recorded, and moving one there is a change to be argued for like any
  other.
- **`unknown` renders as its own visible label, never a blank**, and any consumer
  that enumerates access values must account for it explicitly rather than
  filtering it away silently.
- **`validation.py`'s `ACCESS_TYPE` mirrors the schema and may not drift.**
  `web/src/data/schema.ts` is the source of truth; a member added to one is added
  to the other in the same change.
- **This does not widen the ADR 0003 qualifying class.** A schema change is
  outside it by construction and stays outside it. This decision authorises no
  auto-merge and grants no new path to `main`.
- **`categories`, `inputModalities` and `outputModalities` keep ADR 0008's
  discipline.** "We added `unknown` to `accessType`" is not an argument for
  loosening them, any more than `status` was an argument for loosening
  `accessType`. Each remains its own decision requiring its own measured
  justification, and the measurement is the part that did the work here.
