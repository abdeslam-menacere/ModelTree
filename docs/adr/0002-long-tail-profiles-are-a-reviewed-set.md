# ADR 0002: Long-Tail Profiles Are a Reviewed Set, Named by Id

- Status: Accepted
- Date: 2026-08-20
- Decision owners: ModelTree maintainers
- Supersedes: nothing. Refines the updater's profile handling described in
  `tools/updater/README.md` §"The generic long-tail profile".

## Context

The updater's `run --long-tail` processes a creator nobody has reviewed under a
generic profile. That profile decides three things the run cannot reconstruct from
anywhere else: the acceptance threshold it restates, the promotion criteria measured
against the run, and which naming, ownership, and lineage mappings stay explicit as
`unresolved-mapping` conflicts.

Two facts about the implementation collided (issue #94):

- `--long-tail-profile` took an arbitrary filesystem path.
- A checkpoint records the profile **id**, not a path and not a content hash. On
  `resume`, the profile was rebuilt by loading the *default* file and checking only
  that its id equalled the recorded one.

So identity-by-id was assumed to imply identity-by-file. A run started with
`--long-tail-profile /somewhere/custom.json` whose document happened to declare
`id: "long-tail-generic"` resumed under `profiles/generic/long-tail.json` instead,
with no warning. The acceptance threshold was never at risk — the policy travels in
the checkpointed messages, and the loader refuses any profile that does not restate
the unanimous constant exactly — but the promotion criteria and the unresolved-mapping
topics silently became the default's.

## Decision

**A long-tail profile is a reviewed artefact of this repository, not operator input.**

- The profiles a run can be started under are the **reviewed set**: the `*.json`
  documents in `tools/updater/profiles/generic/`, each identified by the `id` it
  declares.
- `--long-tail-profile` takes an **id** from that set. A path, or an id the set does
  not contain, is refused with exit 2 and a message naming the reviewed ids.
- `load_long_tail_library()` refuses two documents answering to one id. This is the
  load-bearing rule: it makes an id name exactly one file.
- `resume` rebuilds its profile by looking the **checkpointed id** up in that set,
  rather than loading the default path and comparing ids. An id the set does not
  contain stops the run with `ProfileMismatch`; there is no nearest match and no
  fallback.

`resume` gains no profile flag. Its absence is deliberate and now has a test.

## Consequences

### Positive

- An id match *is* a file match, by construction, so rebuilding a profile from a
  recorded id is sound rather than hopeful. The checkpoint needs no path and no
  content hash.
- A proposal's promotion criteria and escalated mappings can be traced to a document
  in this repository, which is reviewable in a diff like every other fact here.
- The failure is loud and early — at run start, before anything is fetched — rather
  than at resume, after work has been done.

### Costs

- Trying a profile variant now means opening a pull request against
  `profiles/generic/`. That is the intended friction, but it is friction.
- A capability that existed (point the tool at a local profile file) is removed. A
  path passed to `--long-tail-profile` now fails instead of working; the error says
  so explicitly rather than guessing at an id.
- The residual, stated plainly: `load_long_tail_profile(path)` still accepts any path,
  because the loader's own failure modes are tested against temporary files. A test —
  or anything else running in-process — can therefore still build a profile the
  reviewed set does not contain. It cannot be reached through the CLI, and a run
  started that way cannot be resumed. The enforcement point is the operator boundary,
  not the Python API.

## Alternatives Considered

- **Checkpoint the profile path plus a content hash, and refuse on mismatch**
  (option 2 in #94): rejected. It keeps an unreviewed document in the trust path,
  records a machine-local absolute path in a reviewable artefact, and adds surface —
  hash algorithm, canonicalisation, what to do when the file moved but did not change
  — to defend a capability this repository does not want. It would make the swap
  detectable; it would not make the unreviewed profile legitimate.
- **Compare the whole profile document on resume rather than the id**: same objection,
  and it still requires the run to have recorded something more than an id.
- **Leave it and document the sharp edge**: rejected. The silent substitution changes
  what a proposal says was measured, and "unknown and conflicting data stay explicit"
  is the product's central promise.

## Guardrails

- Do not reintroduce a path-taking `--long-tail-profile`, and do not add `--long-tail`
  to `resume`. A resumed run's bar comes from its checkpoint.
- Do not let two reviewed generic profiles share an id. The loader refuses it; do not
  add an escape hatch.
- Adding a profile to `profiles/generic/` is a reviewed data change like any other:
  it must restate the unanimous policy exactly and declare only promotion criteria
  something measures.
