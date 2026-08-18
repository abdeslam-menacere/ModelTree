"""The three-lens semantic review panel and its 2-of-3 aggregation.

Three reviewers is not three votes on the same question. Each lens is a different
job, and — crucially — is handed a different view of the run, so that agreement
between two of them is evidence rather than an echo:

``provenance``
    Does the cited source *directly* support this exact value? Sees the claim, its
    quoted evidence, and the sources those quotes came from. Sees no other claims,
    so it cannot be talked into a value by the surrounding narrative.
``consistency``
    Does this claim sit consistently beside the run's other claims and sources?
    Sees the claim and its siblings, with the quotes stripped: its job is
    cross-source and lineage coherence, not re-reading the page.
``editorial``
    Is this the right field, on the right entity, expressed the way the dataset
    means it? Sees the claim and the dataset's expectation for that field, and no
    evidence at all, so it cannot be persuaded by a convincing quote.

Aggregation rules, from the program specification:

* A 2-of-3 majority accepts or rejects a claim, and may approve a newly discovered
  source for use in this run's proposal.
* Abstentions never count as consent; two positive votes are always required.
* The majority is **advisory about semantic judgment only**. A failed deterministic
  gate vetoes it (see `gates.py`), and this module never lets a vote outrank one.
* Disagreement is recorded as a conflict, never averaged away or dropped.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence
from urllib.parse import urlsplit

from .contracts import (
    ClaimAdjudication,
    ClaimCandidate,
    ClaimDecision,
    Conflict,
    ConflictKind,
    CreatorRequest,
    EntityKind,
    Evidence,
    GateResult,
    ReviewLens,
    ReviewVerdict,
    SourceApproval,
    SourceCandidate,
    SourceVerdict,
)
from .gates import failed_gates
from .validation import FIELD_REGISTRY

__all__ = [
    "ClaimReviewRequest",
    "FieldExpectation",
    "LENS_BRIEFS",
    "MAJORITY",
    "PANEL_SIZE",
    "SourceReviewRequest",
    "adjudicate_claim",
    "approve_source",
    "build_claim_request",
    "build_source_request",
    "disagreement_conflicts",
    "is_newly_discovered",
]

PANEL_SIZE = 3
MAJORITY = 2

LENS_BRIEFS: Mapping[ReviewLens, str] = {
    ReviewLens.PROVENANCE: (
        "Judge only whether the quoted evidence directly states this exact value for "
        "this exact entity. Inference, paraphrase, and a search snippet are not "
        "support. Abstain if you cannot tell from the quote alone."
    ),
    ReviewLens.CONSISTENCY: (
        "Judge only whether this claim is consistent with the run's other claims and "
        "with the creator's lineage: contradictory values, a release attributed to the "
        "wrong family, or a fact that cannot hold alongside its siblings. Abstain if "
        "there is nothing to compare against."
    ),
    ReviewLens.EDITORIAL: (
        "Judge only whether this is the correct field on the correct entity, expressed "
        "as the dataset means it, with creator, model, product, and serving platform "
        "kept separate. Abstain if the field's intent is genuinely ambiguous."
    ),
}


@dataclass(frozen=True)
class FieldExpectation:
    """What the dataset expects for the claimed field. The editorial lens's input."""

    entity_kind: EntityKind
    field_path: str
    kind: str | None
    allowed: tuple[str, ...]
    known_field_paths: tuple[str, ...]


@dataclass(frozen=True)
class ClaimReviewRequest:
    """A lens-scoped view of one claim.

    The empty collections are deliberate, not incidental: a lens is not shown the
    material that belongs to another lens's job.
    """

    lens: ReviewLens
    brief: str
    creator: CreatorRequest
    claim: ClaimCandidate
    evidence: tuple[Evidence, ...] = ()
    cited_sources: tuple[SourceCandidate, ...] = ()
    sibling_claims: tuple[ClaimCandidate, ...] = ()
    creator_sources: tuple[SourceCandidate, ...] = ()
    expectation: FieldExpectation | None = None


@dataclass(frozen=True)
class SourceReviewRequest:
    """A lens-scoped view of one newly discovered source."""

    lens: ReviewLens
    brief: str
    creator: CreatorRequest
    source: SourceCandidate
    configured_origins: tuple[str, ...] = ()
    known_sources: tuple[SourceCandidate, ...] = ()


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{(parts.hostname or '').lower()}"


def is_newly_discovered(source: SourceCandidate, creator: CreatorRequest) -> bool:
    """A source is new when its origin is not one the creator profile configured.

    Origin, not exact URL: a creator's own release page linking to its own blog post
    is the ordinary case, and treating every path as a new source would make the
    approval vote meaningless noise.
    """
    configured = {_origin(url) for url in creator.entry_urls}
    return _origin(source.url) not in configured


def build_claim_request(
    lens: ReviewLens,
    *,
    creator: CreatorRequest,
    claim: ClaimCandidate,
    claims: Sequence[ClaimCandidate],
    sources: Sequence[SourceCandidate],
) -> ClaimReviewRequest:
    """Give one lens exactly the material its job needs, and nothing else."""
    brief = LENS_BRIEFS[lens]

    if lens is ReviewLens.PROVENANCE:
        cited = {evidence.source_id for evidence in claim.evidence}
        return ClaimReviewRequest(
            lens=lens,
            brief=brief,
            creator=creator,
            claim=claim,
            evidence=tuple(claim.evidence),
            cited_sources=tuple(source for source in sources if source.id in cited),
        )

    if lens is ReviewLens.CONSISTENCY:
        return ClaimReviewRequest(
            lens=lens,
            brief=brief,
            creator=creator,
            claim=claim,
            sibling_claims=tuple(other for other in claims if other.id != claim.id),
            creator_sources=tuple(sources),
        )

    fields = FIELD_REGISTRY.get(claim.entity_kind, {})
    spec = fields.get(claim.field_path)
    return ClaimReviewRequest(
        lens=lens,
        brief=brief,
        creator=creator,
        claim=claim,
        expectation=FieldExpectation(
            entity_kind=claim.entity_kind,
            field_path=claim.field_path,
            kind=spec.kind if spec else None,
            allowed=spec.allowed if spec else (),
            known_field_paths=tuple(sorted(fields)),
        ),
    )


def build_source_request(
    lens: ReviewLens,
    *,
    creator: CreatorRequest,
    source: SourceCandidate,
    sources: Sequence[SourceCandidate],
) -> SourceReviewRequest:
    return SourceReviewRequest(
        lens=lens,
        brief=brief_for_source(lens),
        creator=creator,
        source=source,
        configured_origins=tuple(sorted({_origin(url) for url in creator.entry_urls})),
        known_sources=tuple(other for other in sources if other.id != source.id),
    )


def brief_for_source(lens: ReviewLens) -> str:
    """The same three jobs, asked of a source rather than a claim."""
    if lens is ReviewLens.PROVENANCE:
        return (
            "Judge whether this source is a primary publisher for this creator: an "
            "official announcement, documentation, model card, or repository, rather "
            "than commentary about one."
        )
    if lens is ReviewLens.CONSISTENCY:
        return (
            "Judge whether this source is consistent with the creator's known sources "
            "and does not duplicate or contradict them."
        )
    return (
        "Judge whether this source is about this creator's own models rather than "
        "another creator's, a product review, or a serving platform's description."
    )


def _tally(decisions: Sequence[ClaimDecision]) -> tuple[int, int, int]:
    """Accept, reject, and abstain counts. `needs-human-review` abstains from the
    majority — it is an escalation, not consent — while the raw verdict keeps saying
    which of the two it was."""
    accept = sum(1 for decision in decisions if decision is ClaimDecision.ACCEPT)
    reject = sum(1 for decision in decisions if decision is ClaimDecision.REJECT)
    return accept, reject, len(decisions) - accept - reject


def _semantic_decision(accept: int, reject: int) -> ClaimDecision:
    if accept >= MAJORITY:
        return ClaimDecision.ACCEPT
    if reject >= MAJORITY:
        return ClaimDecision.REJECT
    return ClaimDecision.NEEDS_HUMAN_REVIEW


def adjudicate_claim(
    claim_id: str,
    verdicts: Sequence[ReviewVerdict],
    gate_results: Sequence[GateResult],
    *,
    decided_at: str,
) -> ClaimAdjudication:
    """Combine the three lens verdicts with the deterministic gates.

    The gates win. Always. A unanimous panel cannot admit a candidate that failed an
    objective check, and the adjudication records both answers so the disagreement
    between judgment and validation is visible rather than resolved silently.
    """
    decisions = [verdict.decision for verdict in verdicts]
    accept, reject, abstain = _tally(decisions)
    semantic = _semantic_decision(accept, reject)
    vetoed_by = failed_gates(gate_results)

    if vetoed_by:
        decision = ClaimDecision.REJECT
        rationale = (
            "rejected by deterministic gate(s) " + ", ".join(vetoed_by) + "; a semantic "
            f"majority cannot override an objective failure (votes: {accept} accept, "
            f"{reject} reject, {abstain} abstain)"
        )
    else:
        decision = semantic
        if semantic is ClaimDecision.ACCEPT:
            rationale = f"{accept} of {PANEL_SIZE} reviewers accepted; all gates passed"
        elif semantic is ClaimDecision.REJECT:
            rationale = f"{reject} of {PANEL_SIZE} reviewers rejected"
        else:
            rationale = (
                f"no {MAJORITY}-of-{PANEL_SIZE} majority ({accept} accept, {reject} "
                f"reject, {abstain} abstain); escalated for a human decision"
            )

    return ClaimAdjudication(
        claim_id=claim_id,
        decision=decision,
        semantic_decision=semantic,
        accept_votes=accept,
        reject_votes=reject,
        abstain_votes=abstain,
        vetoed_by=vetoed_by,
        unanimous=len(set(decisions)) == 1 and len(decisions) == PANEL_SIZE,
        rationale=rationale,
        verdicts=tuple(verdicts),
        decided_at=decided_at,
    )


def approve_source(
    source: SourceCandidate,
    verdicts: Sequence[SourceVerdict],
    gate_results: Sequence[GateResult],
    *,
    newly_discovered: bool,
    decided_at: str,
) -> SourceApproval:
    """Decide whether a source may back claims in this run.

    A configured source is trusted without a vote. A newly discovered one needs a
    2-of-3 majority — the agreed policy, permissive on purpose — and a failed gate
    still refuses it whatever the panel said.
    """
    decisions = [verdict.decision for verdict in verdicts]
    accept, reject, abstain = _tally(decisions)
    vetoed_by = failed_gates(gate_results)

    if vetoed_by:
        approved = False
        rationale = (
            "refused by deterministic gate(s) " + ", ".join(vetoed_by) + "; no majority "
            "can approve a source that failed an objective check"
        )
    elif not newly_discovered:
        approved = True
        rationale = "configured source for this creator; no discovery vote required"
    elif accept >= MAJORITY:
        approved = True
        rationale = (
            f"newly discovered source approved by {accept} of {PANEL_SIZE} reviewers "
            "for use in this run's proposal"
        )
    else:
        approved = False
        rationale = (
            f"newly discovered source not approved ({accept} accept, {reject} reject, "
            f"{abstain} abstain); claims resting on it are rejected"
        )

    return SourceApproval(
        source_id=source.id,
        newly_discovered=newly_discovered,
        approved=approved,
        accept_votes=accept,
        reject_votes=reject,
        abstain_votes=abstain,
        vetoed_by=vetoed_by,
        rationale=rationale,
        verdicts=tuple(verdicts),
        decided_at=decided_at,
    )


def disagreement_conflicts(
    claims: Sequence[ClaimCandidate],
    adjudications: Sequence[ClaimAdjudication],
    *,
    detected_at: str,
) -> tuple[Conflict, ...]:
    """Surface every split panel as a conflict.

    A 2-of-1 accept is still a decision made over a dissent. Recording it is what
    keeps "the reviewers disagreed" from disappearing into "accepted".
    """
    by_id = {claim.id: claim for claim in claims}
    conflicts: list[Conflict] = []

    for adjudication in adjudications:
        if adjudication.unanimous or not adjudication.verdicts:
            continue
        claim = by_id.get(adjudication.claim_id)
        if claim is None:  # pragma: no cover - adjudications are built from claims
            continue
        conflicts.append(
            Conflict(
                id=f"conflict:reviewers:{adjudication.claim_id}",
                entity_kind=claim.entity_kind,
                entity_id=claim.entity_id,
                field_path=claim.field_path,
                kind=ConflictKind.REVIEWER_DISAGREEMENT,
                claim_ids=(adjudication.claim_id,),
                values=tuple(
                    f"{verdict.lens.value if verdict.lens else verdict.reviewer}: "
                    f"{verdict.decision.value}"
                    for verdict in adjudication.verdicts
                ),
                detected_at=detected_at,
            )
        )
    return tuple(conflicts)
