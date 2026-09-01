# ADR 0010: Compact Wire Format for /compare Payload

- Status: Accepted
- Date: 2026-08-31
- Decision owners: ModelTree maintainers
- Supersedes: nothing. It changes how the /compare payload is serialized for
  delivery, not what it contains. The absolute page-weight ceiling (143,360
  bytes) and the per-release instrument (1,600 bytes) are unchanged. The
  stopping rule from #602 is unchanged. This decision does not widen the
  ADR 0003 qualifying class — it modifies shipped code, so it takes the
  ordinary human-reviewed path.

## Context

The `/compare` page ships the entire catalogue as JSON so the browser can
assemble any comparison the reader asks for without a round-trip. The payload
is budgeted by `measureComparisonPayload` in `comparison.test.ts`, with two
guards: a per-release instrument at 1,600 bytes and an absolute ceiling at
143,360 bytes.

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
  stays at 143,360.
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
  to prevent.
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
- **The absolute ceiling (143,360 bytes) is not raised.** The trim made it
  unnecessary. If a future catalogue outgrows the ceiling, the stopping rule
  still applies: trim first, raise only when trimming cannot close the gap.
- **Key maps are the single source of truth.** The compact and expand functions
  derive their reverse maps mechanically (via `invert`), so a one-sided change
  is not possible.
- **The round-trip is tested.** A dedicated assertion
  `expandComparisonPayload(compactComparisonPayload(payload)).toEqual(payload)`
  runs over the real dataset so that a field present in the live data but absent
  from a key map surfaces as a structural mismatch rather than passing silently.
- **Key-map completeness is tested.** A second assertion verifies that every key
  in the compact output is a single character. Because `rekey` passes unmapped
  keys through under their long name, a missing map entry would produce a
  multi-character key and fail this test. Without it, the pass-through is silent.
- **This does not widen the ADR 0003 qualifying class.** A code change to the
  serialization boundary is outside that class and takes the ordinary reviewed
  path.
