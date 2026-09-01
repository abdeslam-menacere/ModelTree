# ADR 0009: A Platform API Record Is Corroborating Metadata, Never a Creator Claim

- Status: Accepted
- Date: 2026-08-31
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It **narrows** what an already-approved source may be cited
  *for*, without removing any source or origin from the approved set, and it adds
  one optional field to `releaseSchema` and `familySchema`. It does not modify ADR
  0003's qualifying class, ADR 0005's statement of what `gate-evidence.mjs` proves,
  or ADR 0006's ledger rules. It leaves ADR 0007's entity-boundary rule and ADR
  0008's `lifecycleStatus` enum untouched, and touches a different part of
  `web/src/data/schema.ts` than ADR 0008 does. Like ADR 0008, it changes the
  schema, so it sits outside the ADR 0003 qualifying class and takes the ordinary
  human-reviewed path rather than reaching `main` unattended. It is the first
  decision here to distinguish the *kinds of fact* one source can carry, which is
  a distinction the approved-origin set was never built to express.

## Context

`gate-source-approval.mjs` decides whether a citation rests on an origin somebody
already trusted. It reasons about `scheme://hostname` and nothing else. That is
the right question for "may this run cite this site at all", and it is silent on
the question this ADR is about: **which facts on that page are the creator's, and
which are the hosting platform's.**

A Hugging Face model page carries both, interleaved. The prose is the creator's
model card. The `createdAt` timestamp is the Hub's own measurement of when a
repository was first pushed. Both arrive from `huggingface.co`, an approved
origin, over one fetch, and every gate treats them identically.

Three release records were committed with a `releaseDate` equal to the Hub
`createdAt` of the repository they cite (#682):

| Record | Committed `releaseDate` | Hub `createdAt` (UTC) |
|---|---|---|
| `moonshot-ai-kimi-k2-instruct` | `2025-07-11` | `2025-07-11T00:55:12Z` |
| `baidu-ernie-4-5-300b-a47b` | `2025-06-28` | `2025-06-28T05:38:53Z` |

For `baidu-ernie-4-5-300b-a47b` the provenance is not inferred, it is cited: the
record's `sourceIds` name `hugging-face-ernie-4-5-300b-hub-record`, whose `url` is
the Hub **API** endpoint the value came from, and whose own `notes` concede the
date "rests on the Hub's measurement of when Baidu first published the
repository".

Every gate passed throughout, and correctly so. Referential integrity proves a
citation **resolves**; it cannot prove the cited page **states** the fact. ADR
0005 already recorded the neighbouring limit for `contentHash` and `quote`. This
is the same family reached from a different direction: there the gate cannot
check that the quote is on the page, here the quote genuinely *is* on the page and
is still not a creator claim.

`createdAt` is not a release date, and the gap is not pedantry. An upload can
precede a public announcement by days while weights are staged, follow one by
weeks when a model is mirrored to the Hub after launching elsewhere, or belong to
a re-upload with no relationship to any release event. In the GLM-4.5 case
examined for #682 the creator's own dated announcement is **eight days after** the
Hub upload, so the two facts are genuinely different and the platform one is the
earlier.

The load-bearing point is what happens when the two are conflated: a **platform
fact is silently converted into a creator claim**, and separating creator from
platform is a distinction this dataset exists to keep — the same distinction that
keeps creator, model, product and serving platform four separate entities.

The obvious over-correction is to bar Hub API records outright. That is refused
below. Those records are the best available evidence for things that are
genuinely the platform's to state, and a rule that pushes runs toward citing the
human-readable page for a machine-readable fact would make provenance worse while
looking stricter.

## Decision

**A platform API record stays admissible as a source, and may be cited only for
facts the platform itself is the author of. No creator claim may rest on one.**

Concretely:

1. **Admissible, for platform-authored facts.** A Hub API record may be cited for
   repository existence and readability, the repository's own identifiers, and
   `cardData` metadata as the platform reports it. `createdAt` may be cited as
   what it is — the time a repository was created on the Hub.
2. **`releaseDate` and `firstReleaseDate` may never rest solely on `createdAt`.**
   A date is a creator claim. Where the only support for one is a platform
   timestamp, the claim is unsupported, and it does not become supported by being
   copied into a field whose name asserts otherwise.
3. **Where a committed date is nonetheless platform-observed, the record says so
   in the data.** `releaseSchema` and `familySchema` carry an optional `dateBasis`.
   The value `platform-repository-created` means: this date is a hosting platform's
   record of when a repository was created, no creator statement of a release
   date was found, and the value is retained because it bounds when the model
   existed — not because a creator stated it. The member is named for creation
   rather than publication because creation is all `createdAt` attests: on the
   records marked under this ADR it coincides with the repository's own oldest
   commit, an "initial commit" that predates the weights, and a repository may be
   created private and made public later. A member named `platform-first-published`
   would assert a visibility event the platform never recorded — this ADR's own
   defect, one step smaller.
4. **The absence of `dateBasis` asserts nothing.** It does not mean "creator
   stated". It means no basis has been established either way. This is stated in
   the schema, in `web/README.md`, and here, because a field that silently means
   "verified" when it is missing would rebuild the exact defect this ADR closes,
   one level up.
5. **Equality with `createdAt` is evidence, not proof.** A creator may genuinely
   release on the day they upload. A record is reclassified under item 3 only when
   the date is, within the cited sources, present *only* as platform metadata and
   the creator's own prose states no date or a different one. A sweep that finds
   equality reports it; it does not license an edit on its own.

### Why the rejected options were rejected

- **Bar Hub API records from `sources.json` entirely.** Rejected. It removes the
  best evidence for facts that really are the platform's, and it does not touch
  the defect: `createdAt` is on the human-readable page too, inside the same
  hydration payload, so a run barred from the API endpoint can reach the identical
  timestamp from a `model-card` source and cite it with no marker at all. The rule
  would move the citation without changing the claim — strictly worse, because the
  ERNIE record's honesty about where its date came from is precisely what made
  #682 findable.
- **Make `dateBasis` required, with a `creator-stated` member.** Rejected. It
  reads well and cannot be filled in honestly: it would require asserting a basis
  for all 92 committed releases when seven have an established one. The remaining
  85 would receive `creator-stated` because that is the default a writer reaches
  for, converting an unverified field into a positive claim across the whole
  dataset — the same silent conversion, at scale. An optional marker that is
  present only where the basis is established says less and is true.
- **Drop the marked dates and record the absence structurally.** Rejected as
  disproportionate rather than wrong in principle. `releaseDate` is required by
  `releaseSchema`; `gate-dataset.mjs` and `web/src/data/validate.ts` both refuse a
  family with no release; and `releaseDate` is read by the catalogue index, the
  `releaseYears` facet, sorting, the timeline, the comparison payload and the
  passport. Making it optional is a site-wide "undated release" feature touching
  321 references across 45 files, and it discards a true and useful fact — the
  model demonstrably existed by that date — to avoid mislabelling it, when
  labelling it correctly is available.
- **Fix the affected records and leave the rule unwritten.** Rejected because they
  were not a mistake anyone made carelessly; they are what the gates currently
  permit. Without a written rule the next run re-derives the same value from the
  same endpoint and passes. The sweep bears this out: the defect was not confined
  to the records the issue named, and two more were found only by re-reading
  source notes that had already concluded it.

## Consequences

### Positive

- The dataset can record that a committed date is a hosting platform's upload
  timestamp rather than a creator's release claim — the distinction #682 is
  about, which the schema previously had no way to express. This changes what is
  **recordable**, not what the site renders: `dateBasis` is read by no component,
  so page output is unchanged. Surfacing it to readers is a separate decision and
  belongs to its own issue.
- A reader and a later run can both tell, from the data alone, which dates are
  known not to be creator statements. That was previously recoverable only from
  prose in a source note, and only where a run happened to write it.
- Hub API records keep their real evidentiary value instead of being banned for
  being machine-readable.
- The equality-is-not-proof rule (item 5) makes the sweep in #682 safe to repeat:
  it reports candidates without authorising edits, so a genuine same-day release
  is not "corrected" into a falsehood.

### Costs

- `dateBasis` is self-declared by the run that writes it, exactly as ADR 0005's
  `contentHash` is. No offline gate can derive it, because the ground truth is the
  remote page. It rests on the same compensating controls ADR 0005 names.
- Absence remaining uninformative means the dataset cannot yet answer "which dates
  are creator-stated". It can only answer "which are known not to be". That is a
  smaller claim than a reader may want, and it is the one that is true.
- Records committed before this decision are unmarked and stay unmarked until
  something checks them. #682 sweeps 92 releases and finds 17 whose `releaseDate`
  equals a cited Hub repository's `createdAt`; seven are marked there and the rest
  are named individually in `web/README.md` — four as genuine same-day releases,
  three as coarse-precision matches that prove nothing, and three as checked and
  deliberately left unmarked for a stated reason, per item 5. They are named
  rather than counted because a bare count is how five of the seven marked
  records stayed invisible: each already stated in a committed source note or
  summary that its date rested on the Hub, and a summary saying "17 releases"
  made that impossible to notice.

## Alternatives Considered

The four options above, each rejected for the recorded reason. A fifth — having
`gate-dataset.mjs` refuse any `releaseDate` equal to a cited repository's
`createdAt` — was rejected because that gate is deterministic and offline by
construction (ADR 0003 depends on it) and the comparison needs a network fetch.
Caching the timestamp in the dataset to make it offline was rejected in turn: it
would make a legitimate same-day release permanently unrecordable, which is item
5's failure mode written into a gate.

## Guardrails

- No `releaseDate` or `firstReleaseDate` may cite a platform API record as its
  only support. A record whose date rests on `createdAt` carries
  `dateBasis: "platform-repository-created"` or it does not land.
- No code comment, schema doc, README bullet, or gate message may state or imply
  that a missing `dateBasis` means a date is creator-stated. Text asserting that
  is a regression against this ADR, on the same terms as ADR 0005's guardrail
  about `gate-evidence.mjs`, and for the same reason: absence read as verification
  is how the defect returns.
- A sweep that finds `releaseDate == createdAt` reports the record. Converting
  that report into a dataset edit requires establishing, per record, that the date
  appears in the cited sources *only* as platform metadata. Editing on equality
  alone is refused.
- If a future change makes `dateBasis` required, it must state how a basis was
  established for every existing record rather than defaulting one, or it does not
  land.
