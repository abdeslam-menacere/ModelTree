# ADR 0014: Succession May Cross A Family Boundary, Siblings May Not

- Status: Accepted
- Date: 2026-09-03
- Decision owners: ModelTree maintainers
- Supersedes: nothing. No earlier ADR decided the within-family rule — it was
  established in code, in `validate.ts`, and has never been written down. This
  decision therefore records a constraint for the first time in the act of
  narrowing it, rather than replacing a prior ruling. It **does not disturb
  ADR 0007**, which rules that Muse is a meta-family: that decision is about what
  a family record *is*, and nothing here changes family membership, merges a
  family, or splits one. It leans on the precedent already set for
  `derivedFromIds`, which crosses both family and organization boundaries and has
  done so since the field existed — but it does not extend to that field, which
  stays excluded from lineage edges for the reason ADR 0007's entity discipline
  gives: derivation is not descent. This does **not** widen the ADR 0003
  qualifying class. A validator and renderer change is outside that class, so
  this decision takes the ordinary reviewed path and does not reach `main`
  unattended.

## Context

`validateReleaseRelationships` in `web/src/data/validate.ts` required that
`predecessorIds`, `successorIds` and `siblingIds` all point at a release in the
same family, and `validateDataset` throws on a violation. The practical effect
was not that cross-generation succession across a family boundary was
*unpopulated*. It was **unexpressible**: a dataset asserting it could not be
loaded at all.

That constraint was deliberate, not an oversight, and four sites agreed on it:

1. **`web/src/data/validate.ts`** — `validateReleaseRelationships` pushed
   `"must stay within family"` for all three fields. This is the binding one.
2. **`web/src/data/validate.test.ts`** — a test named `rejects a successor in
   another family`, sitting immediately before `allows derivedFromIds to cross
   family boundaries`. The pair is a deliberate contrast: it states that crossing
   a boundary is acceptable *in principle* in this dataset, and that succession
   specifically was not permitted to.
3. **`web/src/lib/lineage-view.ts`** — a rationale comment on the edge builder
   reading "Directed edges within one family… `derivedFromIds` is deliberately
   excluded", recording that the tree is a within-family structure by intent.
4. **`buildFamilyView`'s `link()` early return** — `if (!present.has(parentId) ||
   !present.has(childId)) return;`, which **silently drops** an edge with an
   endpoint outside the family. This is the site that makes the constraint real
   rather than merely enforced: it holds even when validation permits the edge.

A fifth, weaker site agreed with them — `buildEcosystems`' doc comment asserted
that "relationships are constrained to stay within a family" — which is worth
naming because it shows the assumption had spread past its enforcement point.

### Why the constraint stopped being right

The rule encodes an assumption that a model's successor is always a member of the
same family. That assumption is a fact about *how a particular creator names
things*, not about model lineage, and creators disagree.

Google models Gemini 3.1 and Gemini 3.5 inside one family, so their succession is
an ordinary within-family edge. Anthropic models each point release as its own
family, so the same relation — Claude Fable 5 to Claude Fable 5.1 — is a family
boundary. Anthropic's own primary sources state the relation plainly:
`anthropic-api-release-notes` says "We've launched Claude Fable 5.1
(`claude-fable-5-1`), the successor to Claude Fable 5", and `anthropic-fable-5-docs`
says "you should consider migrating to Claude Fable 5.1".

So the dataset could record a well-sourced succession for one creator and not for
another, purely because of naming convention. That is the repository's standing
rule about unknown and conflicting data failing in the wrong direction: the fact
was not unknown, it was known and unstatable.

Merging or reshaping the affected families was investigated as the alternative
route and **withdrawn on evidence** — abdeslam-menacere/ModelTree#844, closed.
That closes off the option of making the boundary go away, and leaves making the
edge crossable as the remaining path.

### Why `siblingIds` is different

`siblingIds` is not the same kind of relation. Succession is a claim about time
and descent between two things a source has ordered. Sibling is a claim about
membership of a set — the variants a creator shipped *as one thing*, which is
what a family record already is. A "sibling in another family" would either be a
statement that the two families should be one, which is a family-shape question
and not a relationship question, or it would be meaningless. There is no sourced
example of it, and no request for one.

## Decision

**Narrow the within-family rule to `siblingIds` alone.**

`predecessorIds` and `successorIds` may name a release in any family, of any
creator. `siblingIds` must continue to name a release in the same family, and
`validateDataset` continues to throw on a violation of that.

**Render a departing edge by naming it, never by drawing it.** A family panel
draws only its own releases, and each panel is a separate list, so a connector
between two panels is not available in the tree or in the DOM. Rather than leave
the edge silently absent, it is stated in three coordinated places:

- **On the node it departs from**, an aside naming the target *and the family it
  lives in*: `Continues into Alpha Mark Two Release (Alpha Mark Two)`. Naming the
  family is the substance of the presentation, not decoration — without it the
  line reads as a connector somebody forgot to draw. This reuses the existing
  `shown without a connector` idiom already used for a converging predecessor the
  tree could not nest, and the existing treatment of `derivedFromIds`.
- **On the family header**, a count of links that leave the family, kept
  **separate from `linkCount`**, because `linkCount` is what the panel draws and
  conflating the two would make the header contradict the picture beneath it.
  `hasRecordedLineage` likewise keeps its within-family meaning.
- **In the highlight and trail**, which now walk every release the view holds
  rather than one family, so selecting a release marks its cross-family successor
  and lists it. The trail panel already prints creator and family per entry, so
  it was already equipped to present a cross-family entry legibly; what was
  missing was that the highlight never found the edge.

**Read departing edges as a union of both directions, from a catalog-wide
graph.** Within a family the tree already reads predecessor and successor as a
union, because either end may be the one a curator wrote down. Across a boundary
that is not a convenience but a requirement: the far side is frequently the only
side written down, since a successor family naming what it succeeds is the
natural way to record it, and the predecessor's record was written before the
successor existed. Reading only a release's own two arrays would therefore find
one hop in two.

## Consequences

### Positive

- A sourced succession is recordable regardless of how its creator names
  families. The dataset stops encoding one creator's naming convention as a limit
  on what can be said about another's.
- The four sites now agree on a narrower rule instead of disagreeing with the
  data, and the rule they agree on is written down here rather than only in code.
- The renderer change is the part with user-visible effect. Relaxing the
  validator alone would have changed nothing a reader could see, because site 4
  dropped the edge anyway; the two had to move together, and now do.
- `derivedFromIds` keeps its distinct meaning. It crosses boundaries and is still
  never a lineage edge, so "derived from" and "succeeds" stay separable — the
  entity discipline this repository already keeps between creator, model, product
  and serving platform, applied to relations.

### Costs

- **The dataset can now express a cross-family succession that is wrong**, and
  the validator will not catch it. Within-family membership was doing a small
  amount of accidental sanity-checking, and that is now gone. The remaining
  defence is the source requirement: the relation needs a primary source and a
  verification date like any other important fact, and review is where a bad edge
  is caught. This is a real reduction in automated safety, accepted knowingly.
- **A departing edge is less visible than a connector.** A reader scanning the
  tree shape alone will not see it; they have to read the aside. This is a
  genuine asymmetry between a within-family and a cross-family succession, and it
  is accepted rather than solved, because the alternatives — drawing a line
  between two panels, or merging the panels — are respectively a layout the tree
  cannot express and the family reshaping that abdeslam-menacere/ModelTree#844
  withdrew.
- **The highlight is bounded by what the current view draws.** `buildLineageHighlight`
  receives the ecosystems being rendered, not the whole dataset, so an edge into a
  family the page does not draw is *named* on the node — the resolver is
  catalog-wide — but not *walked* into the highlight or trail. On a creator page
  showing one creator, an edge to another creator's release is named and not
  traversed. Widening this would mean threading the dataset through the page
  props, which is a larger change than the one this decision needs.
- `buildFamilyView` takes more parameters, and `buildEcosystems` now builds a
  catalog-wide edge graph once and passes it down. That is more machinery than a
  purely local computation, and it is the price of the union-of-directions read.

## Alternatives Considered

- **Merge or reshape the affected families so the edge is within-family.**
  Investigated at abdeslam-menacere/ModelTree#844 and **withdrawn on evidence**;
  the issue is closed. It also inverts the dependency: it would make the
  repository's family shapes answerable to a renderer limitation rather than to
  what creators publish, which is the opposite of the entity discipline the
  repository keeps elsewhere.
- **Relax the validator and leave the renderer alone.** Rejected because it
  achieves nothing observable. Site 4 drops the edge silently, so the data would
  validate and then not render, and the repository would carry a fact it does not
  show — worse than not carrying it, because the absence would look deliberate.
- **Express the relation with `derivedFromIds`, which already crosses
  boundaries.** Rejected because it is false. Derivation is not descent: a
  distilled or fine-tuned model derives from a parent without succeeding it, and
  several records in the catalog rely on that distinction. Overloading the field
  would destroy information to avoid a schema decision.
- **Relax all three fields uniformly, including `siblingIds`.** Rejected. It is
  the tidier-looking rule and the wrong one: `siblingIds` has a genuine
  within-family meaning, a cross-family sibling has no sourced example, and a
  uniform relaxation would silently turn a family-shape question into a
  relationship assertion.
- **Draw the cross-family edge as a connector between panels.** Rejected. Each
  family is a separate list; a connector across two of them has no correct
  representation in the nested-list structure the explorer commits to, and
  approximating one visually would assert a containment that is not true.
- **Add a distinct `crossFamilySuccessorIds` field.** Rejected. It is the same
  relation, and splitting it by where its endpoint happens to live would put the
  naming convention back into the schema at one remove — every consumer would
  have to read both fields and union them, which is the bug this decision fixes.

## Guardrails

- **`siblingIds` stays within-family and reciprocal.** The check in
  `validateReleaseRelationships` is now `field === 'siblingIds'`, and
  `validate.test.ts` pins both halves: `rejects a sibling in another family` and
  `allows a successor in another family`, on either side of the untouched
  `allows derivedFromIds to cross family boundaries`. That trio is a deliberate
  contrast and should stay legible as one; do not delete a member of it to
  simplify.
- **`derivedFromIds` stays excluded from lineage edges.** It may cross any
  boundary and must never become a connector or a succession edge.
- **A departing edge is never drawn as a connector.** `successionEdges`' `present`
  containment guard is what enforces this, and it is load-bearing: removing it
  fails five tests, including the pre-existing invariants that no release is
  drawn twice or dropped. It is not redundant with the validator and must not be
  removed as such.
- **Departing edges are read from the catalog-wide graph, not a release's own two
  arrays.** The lineage fixture records its two hops on opposite ends
  deliberately, so a change back to a self-only read fails rather than passing
  quietly.
- **`linkCount` and `hasRecordedLineage` keep their within-family meaning.**
  A departing edge is counted in `externalLinkCount`. Do not fold the two
  together: the first is what the panel draws, the second is what it names.
- **The highlight's bound is a known limit, not a bug to work around in place.**
  An edge into a family the current view does not draw is named and not walked.
  If that becomes unacceptable, the fix is to widen what the highlight receives,
  not to make the resolver narrower so the two agree.
- **A cross-family succession is still an important fact and carries a primary
  source and a verification date.** The validator no longer constrains where the
  endpoint lives, so review is the only thing standing between a sourced relation
  and an invented one.
- **This does not widen the ADR 0003 qualifying class.** A schema or renderer
  change takes the ordinary reviewed path.
