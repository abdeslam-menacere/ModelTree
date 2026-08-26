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
  that is exactly what taking an id buys. What #140 closed is narrower than "resume": a
  checkpoint now records the tool version and the checkpoint schema version
  that wrote it, and one that records neither — which is precisely what a build from when
  `--long-tail-profile` still took a path wrote — is refused outright rather than resumed.
  So a pre-#94 checkpoint carrying whatever id that unreviewed document declared no longer
  reaches the colliding case below *through the CLI*; it does not reach a resume at all.
  Resuming such a run does not restore the unreviewed document either way, and the two
  cases differ: an id outside the reviewed set stops the resume with `ProfileMismatch`,
  while an id that **collides** with a reviewed one resumes silently under the
  *reviewed* document — #94's substitution, which survives on a route with two halves,
  only the first of which the Python API keeps to itself. **Starting** a run under an
  unreviewed document is in-process only: the loader still accepts a path, and
  `--long-tail-profile` refuses one with exit 2. **Resuming** into the substitution is
  not. The checkpoint that in-process run writes is stamped with this build's tool
  version and checkpoint schema version like any other, so
  `modeltree-updater resume --checkpoint-dir <dir> --checkpoint-id <id>` satisfies the
  #140 version gate, rebuilds the profile from the recorded id, and finishes under the
  reviewed document — exit 0, nothing said. Executed rather than reasoned (#206,
  2026-08-26): a CLI `resume` of the iteration-0 checkpoint of a run started in-process
  under a colliding document declaring `accepted-claims` at 99 wrote a proposal carrying
  the reviewed profile's `accepted-claims` 3, `approved-sources` 2 and
  `escalated-mappings` 1, recommended 3/3. That is accepted rather than
  chased. What the operator boundary buys is that no CLI invocation can *introduce* an
  unreviewed document, which is not the same as keeping the CLI out of the resume that
  substitutes one; what is accepted is what that substitution can reach, which the rest
  of this bullet sets out: a recommendation, never acceptance. Resolving towards the reviewed document
  is separately the safe direction for **provenance** — you land on a document this
  repository reviewed. It is not necessarily the *stricter* document, and the pinning
  test's own fixture is the counter-example: it declares a single `accepted-claims`
  criterion at 99, so the substitution lowers that bar to the reviewed profile's 3 —
  while adding the `approved-sources` and `escalated-mappings` criteria the reviewed
  document also requires under `rule: "all"`. Strictness is not
  ordered between the two documents: the substitution can loosen one axis and tighten
  another in the same move. What that can cost is bounded, and belongs beside the
  correction: promotion criteria shape a **recommendation**, not acceptance.
  Acceptance is pinned independently by the unanimous 3-of-3 review policy, which this
  path does not touch. So the consequence is a proposal recommended for promotion that
  the document the run started under would not have recommended, or the reverse — not
  an unreviewed change reaching the dataset.
  `test_an_in_process_colliding_profile_resumes_under_the_reviewed_document` pins the
  behavioural half of that, and only that half: a resume in this state ends up under the
  reviewed document rather than the unreviewed one. It pins *which document is read*. It
  asserts nothing about thresholds, criteria counts, or which way the promotion bar
  moves, so it cannot hold the strictness comparison above upright. Those thresholds are
  read off that test's fixture and the reviewed profile, and no assertion holds either at
  its value: lower the fixture's and the test stays green while the comparison here
  quietly goes false. Check them against those two documents rather than against a green
  run. The strictness reading they support was reached in review, by reading the fixture
  against the evaluator, which is why this bullet names specific criteria rather than
  "the bar".
  `test_a_cli_resume_of_a_current_build_checkpoint_substitutes_the_document` pins the
  *route* rather than the document: it drives the CLI `resume` named above against a
  checkpoint this build wrote and reads which document the emitted proposal came back
  under, so "the CLI does not reach it" cannot be written here again without a test
  going red. It holds no threshold at a literal either, for the reason just given.
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
