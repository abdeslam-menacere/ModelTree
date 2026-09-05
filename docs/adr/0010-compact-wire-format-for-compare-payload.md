# ADR 0010: Compact Wire Format for /compare Payload

- Status: Accepted
- Date: 2026-08-31
- Decision owners: ModelTree maintainers
- Superseded by: nothing. The decision below — the compact wire format — is
  unchanged and still in force, and so is its stopping rule. One figure this
  document quotes has since moved: **the absolute /compare ceiling was raised
  from 143,360 to 174,080 bytes on 2026-09-05** by commit `9eee41c5`, merged as
  abdeslam-menacere/ModelTree#958 for abdeslam-menacere/ModelTree#935. That
  raise took the ordinary reviewed path ADR 0015 requires of a ceiling change,
  and it applied this ADR's stopping rule rather than bypassing it. Every
  occurrence of 143,360 below is therefore a reading of a past state — true when
  it was written, kept because this is the record of a decision taken then, and
  **not a statement of what the ceiling is now**. The enforced value lives in
  exactly one place and is the only authority for it: the `toBeLessThanOrEqual`
  assertion on `size.totalBytes` in `web/src/lib/comparison.test.ts`, which also
  carries the ledger of every raise this ratchet has taken. Read that assertion
  rather than any prose figure, here or anywhere else. See the amendment note in
  Guardrails.
- Supersedes: nothing. It changes how the /compare payload is serialized for
  delivery, not what it contains. Neither the absolute page-weight ceiling
  (143,360 bytes as it stood at the date above) nor the per-release instrument
  (1,600 bytes) is moved by this decision. The stopping rule from #602 is
  unchanged. This decision does not widen the ADR 0003 qualifying class — it
  modifies shipped code, so it takes the ordinary human-reviewed path.

## Context

The `/compare` page ships the entire catalogue as JSON so the browser can
assemble any comparison the reader asks for without a round-trip. The payload
is budgeted by `measureComparisonPayload` in `comparison.test.ts`, with two
guards: a per-release instrument at 1,600 bytes and, at the date of this
decision, an absolute ceiling at 143,360 bytes.

At 92 releases the payload measured 137,691 UTF-8 bytes (1,497/release),
leaving 5,669 bytes of headroom — about 3.8 releases. The project's breadth
goal (#689) needs at least three more creators, each contributing at least one
release. That does not fit. A complete, 3-of-3-accepted creator was held solely
by page weight, and the two goals — show more of the ecosystem, and keep page
weight bounded — were in direct conflict (#726).

The stopping rule (#602) requires that before the ceiling is raised, trimming
must be attempted and the per-release figure must have held. The question was
whether a trim exists that preserves every cited source and value.

It does. The payload's JSON key names repeat on every record: 24 keys per
release × 92 releases = 2,208 key occurrences. Verbose key names
(`canonicalName`, `organizationId`, `datePrecision`, …) account for
approximately 25,800 bytes — purely structural overhead that carries no
provenance, no cited source, and no value a reader sees. Shortening them to
single characters drops the same 25,800 bytes without removing a single field
or source citation.

## Decision

Introduce a compact wire format for the `/compare` payload:

1. `compactComparisonPayload(ds)` maps every key in every section to a
   single-character alias and shortens the top-level section keys
   (`releases` → `R`, `sources` → `S`, etc.).
2. `expandComparisonPayload(cp)` reverses the mapping, restoring a full
   `ComparisonDataset`.
3. `compare.astro` ships the compact form; `ModelComparison.tsx` expands it
   on hydration.
4. `measureComparisonPayload` measures the compact form, because that is what
   the page actually transfers.

The key maps are explicit constants in `comparison.ts`, one per section. A
forgotten entry passes the unmapped key through under its long name (the
`rekey` function uses `map[key] ?? key`), which round-trips cleanly and would
be invisible without a dedicated guard. A test ("compacts every key — no long
key survives in the wire format") asserts that every key in the compact output
is a single character, so a missing entry surfaces as a test failure rather
than a silent pass-through.

## Consequences

### Positive

- **Page-weight headroom goes from 3.8 releases to ~25.9 releases.** The
  measured total drops from 137,691 to 111,893 bytes (−25,798). The ceiling
  stayed at 143,360.
- **Per-release cost drops from 1,497 to 1,216.** The 1,600 instrument holds
  and is not weakened; it simply has more room before it fires.
- **No provenance loss.** Every cited source, every field value, and every
  verification date is preserved. Only JSON key names changed.
- **The stopping rule is satisfied by construction.** Trimming was done and
  succeeded; no raise was needed.
- **Breadth work is unblocked.** The constraint that prevented shipping a
  reviewed, accepted creator is removed.

### Costs

- **Maintenance: the key maps must stay in sync with the types.** Adding a field
  to `ComparisonRelease` requires adding it to `RELEASE_KEY_TO_SHORT`. The
  `rekey` function passes an unmapped key through under its long name, so a
  missing entry is silent at runtime; a test ("compacts every key") catches it
  by asserting every compact-form key is a single character.
- **Debugging shipped HTML is slightly harder.** The serialized JSON uses
  single-character keys. `expandComparisonPayload` is available in dev tools
  for inspection, and the key maps are documented inline.
- **The compact form is a second serialization concern.** It does not change the
  internal `ComparisonDataset` type or any builder/viewer logic — only the
  boundary between server and client.

## Alternatives Considered

- **Raise the ceiling from 143,360 to ~150,000.** Rejected. This buys ~8
  releases and kicks the conflict down the road. The stopping rule requires
  trimming to be attempted first, and trimming succeeded, so a raise was not
  needed. A raise that avoids a working trim is the failure mode #602 exists
  to prevent. (This rejection is a judgement on the evidence available on the
  date of this decision, when a working trim existed; it is not a standing
  prohibition on ever raising the ceiling. When the ceiling was in fact raised
  on 2026-09-05 by abdeslam-menacere/ModelTree#958 no trim was available, and
  that raise was sized against this very bullet's yardstick — enough headroom
  to be worth taking, rather than the ~8 releases rejected here.)
- **Omit null fields from the JSON.** Investigated; `buildComparisonPayload`
  produces no null fields (arrays are `[]`, not null), so this saves zero bytes.
- **Use positional arrays (tuples) instead of objects.** More compact but
  fragile: adding or reordering a field silently changes the wire format, and
  debugging requires counting positions. Single-character keys are nearly as
  compact and self-describing enough to debug.
- **gzip/brotli compression.** The payload is embedded in the HTML page, which
  is itself compressed at the transport layer. Structural compression (shorter
  keys) reduces the pre-compression size, which is what the budget measures,
  and also helps compression ratios since repeated short keys compress better
  than repeated long ones.

## Guardrails

- **The per-release instrument (1,600 bytes) is not weakened.** It stays as-is
  and continues to catch drift toward fatter records. The fact that the baseline
  dropped from 1,497 to 1,216 is a consequence of the trim, not a loosening of
  the guard.
- **The stopping rule governs every move of the absolute ceiling: trim first,
  raise only when trimming cannot close the gap.** That rule is unchanged, it
  is live policy, and nothing here licenses a raise on demand. What has
  changed since this ADR was accepted is the number the rule guards, not the
  rule. **Amendment, 2026-09-05.** As accepted, this guardrail read "the
  absolute ceiling (143,360 bytes) is not raised — the trim made it
  unnecessary", and added that if a future catalogue outgrew the ceiling the
  stopping rule would still apply. That conditional came true and the rule did
  its work. The catalogue outgrew 143,360, and commit `9eee41c5` — merged as
  abdeslam-menacere/ModelTree#958 for abdeslam-menacere/ModelTree#935 — raised
  the ceiling to **174,080 bytes**. It was raised *under* this rule rather than
  around it: the catalogue had simply grown, the per-release instrument held
  and in fact improved (1,191 → 1,188 of 1,600), and no trim closed the gap
  without dropping a cited source, which this repository does not do because
  provenance outranks page weight. The raise took the ordinary reviewed path
  that ADR 0015 requires of any ceiling change, so it is a legitimate
  application of this decision and not an exception to it.
- **Do not read any byte figure in this document as the current ceiling.** The
  enforced value lives in exactly one place — the `toBeLessThanOrEqual`
  assertion on `size.totalBytes` in `web/src/lib/comparison.test.ts` — and that
  assertion, not this prose, is the authority. That file also carries the
  ledger of every raise the ratchet has taken and the derivation of each one's
  size. This guardrail names the instrument instead of copying its output for a
  measured reason: the figure that was copied here went stale the moment the
  rule was correctly applied, and a dock reading it as standing policy
  (abdeslam-menacere/ModelTree#820) refused work it could have shipped and
  handed back a blocked cycle with zero commits. A number repeated in prose has
  nothing that notices when it moves; a named assertion cannot go stale.
- **Key maps are the single source of truth.** The compact and expand functions
  derive their reverse maps mechanically (via `invert`), so a one-sided change
  is not possible.
- **The round-trip is tested.** A dedicated assertion
  `expandComparisonPayload(compactComparisonPayload(payload)).toEqual(payload)`
  runs over the real dataset and proves losslessness: data survives the round
  trip unchanged. It catches key-map collisions (two long keys mapped to the
  same short key) but does **not** catch a missing entry, because `rekey` passes
  unmapped keys through under their long name and they round-trip perfectly.
- **Key-map completeness is tested separately.** A second assertion verifies
  that every key in the compact output is a single character, which is the sole
  guard against omitted entries. The section list is derived from the compact
  output itself so that an added section cannot silently escape coverage.
  Because `rekey` passes unmapped keys through under their long name, a missing
  map entry would produce a multi-character key and fail this test. Without it,
  the pass-through is silent.
- **This does not widen the ADR 0003 qualifying class.** A code change to the
  serialization boundary is outside that class and takes the ordinary reviewed
  path.
