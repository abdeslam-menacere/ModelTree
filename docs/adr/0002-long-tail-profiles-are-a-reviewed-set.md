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

- An id match *is* a match on one reviewed document, by construction, so rebuilding a
  profile from a recorded id is sound rather than hopeful. The checkpoint needs no path
  and no content hash.
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
  reviewed set does not contain. No **newly started** run reaches it through the CLI;
  that is exactly what taking an id buys. Resume is the qualification: a checkpoint
  records no schema or tool-version marker, so one written by an older build — when
  `--long-tail-profile` still took a path — carries whatever id that unreviewed
  document declared, and resuming it with today's CLI reaches the colliding case below
  *through the CLI*. That is pre-#94 behaviour rather than a new hole, and the window
  is narrow while the updater has never run end-to-end (#93), but it is not closed.
  Resuming such a run does not restore the unreviewed document either way, and the two
  cases differ: an id outside the reviewed set stops the resume with `ProfileMismatch`,
  while an id that **collides** with a reviewed one resumes silently under the
  *reviewed* document — #94's substitution, still reachable on the Python API. That is
  accepted rather than chased: the operator boundary is the enforcement point, and
  resolving towards the reviewed document is the safe direction for **provenance** —
  you land on a document this repository reviewed. It is not necessarily the *stricter*
  document, and the pinning test's own fixture is the counter-example: it declares a
  single `accepted-claims` criterion at 99, so the substitution lowers that bar to the
  reviewed profile's 3 — while adding the `approved-sources` and `escalated-mappings`
  criteria the reviewed document also requires under `rule: "all"`. Strictness is not
  ordered between the two documents: the substitution can loosen one axis and tighten
  another in the same move. What that can cost is bounded, and belongs beside the
  correction: promotion criteria shape a **recommendation**, not acceptance.
  Acceptance is pinned independently by the unanimous 3-of-3 review policy, which this
  path does not touch. So the consequence is a proposal recommended for promotion that
  the document the run started under would not have recommended, or the reverse — not
  an unreviewed change reaching the dataset. The colliding case is pinned by
  `test_an_in_process_colliding_profile_resumes_under_the_reviewed_document`, so this
  paragraph cannot quietly go stale. It has already needed that: the first correction
  of this bullet carried a smaller overclaim of its own on a different axis, which is
  why these numbers name specific criteria rather than "the bar".
- The second residual, equally plain: this pins *which document* a resumed run reads, not
  *what that document said when the run started*. Editing a reviewed profile in place
  between start and resume is not detected, because rejecting option 2 means there is no
  content hash to compare. The claim this decision supports is "a resumed run never
  silently reads a different document", not "a resumed run never sees changed criteria".

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
