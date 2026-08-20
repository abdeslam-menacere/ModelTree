"""The generic long-tail profile: one profile, every creator without a dedicated one.

Covering minor and niche creators must not mean writing another agent. This module
loads a single reviewed document — ``profiles/generic/long-tail.json`` — and turns it
into the same :class:`~modeltree_updater.profiles.CreatorProfile` the pilot creators
use, so a long-tail run travels through exactly the same executors, the same three
lenses, the same deterministic hard gates, and the same proposal-only boundary.

Three things differ, and all three are consequences of one fact — nobody has reviewed
this creator:

* **Acceptance is unanimous.** The profile carries a
  :class:`~modeltree_updater.contracts.ReviewPolicy` requiring all three lenses to
  accept a claim or approve a newly discovered source. The loader refuses a profile
  that declares anything weaker, so the threshold cannot be edited down in data.
* **Unknown naming, ownership, and lineage stay conflicts.** A claim on one of those
  topics that the panel could not settle is recorded as an explicit
  ``unresolved-mapping`` conflict rather than quietly failing to be accepted. This
  closes a real gap: a claim all three lenses *abstain* on is unanimous, so it raises
  no reviewer-disagreement conflict, and without this it would leave no trace at all.
* **Every processed creator is assessed for promotion.** The criteria are published in
  the profile, measured from the run, and recorded whether or not they are met.
  Promotion is a *flag*: creating a dedicated profile is a human act, and there is no
  code path here that writes one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from .contracts import (
    ClaimAdjudication,
    ClaimCandidate,
    ClaimDecision,
    Conflict,
    ConflictKind,
    CreatorRequest,
    EntityKind,
    PromotionAssessment,
    PromotionCriterion,
    ReviewPolicy,
    SourceApproval,
    SourceKind,
    _Serialisable,
)
from .gates import url_safety_issues
from .profiles import (
    CreatorProfile,
    ExtractionRules,
    NamingRule,
    ProfileError,
    SourceAmbiguity,
    TrustedSource,
    origin_of,
)
from .review import PANEL_SIZE, REVIEW_POLICIES

__all__ = [
    "DEFAULT_LONG_TAIL_PROFILE",
    "KNOWN_PROMOTION_CRITERIA",
    "LongTailProfile",
    "PromotionRules",
    "PromotionThreshold",
    "UnresolvedTopic",
    "assess_promotion",
    "load_long_tail_profile",
    "unresolved_mapping_conflicts",
]

# The generic profile lives in its own directory: `profiles/*.json` is the set of
# reviewed *per-creator* profiles, and this is a template applied to many creators,
# not a fifth creator. `load_profile_library` therefore never picks it up.
DEFAULT_LONG_TAIL_PROFILE = (
    Path(__file__).resolve().parents[2] / "profiles" / "generic" / "long-tail.json"
)

# Every criterion has to be measurable from a finished run. An id with no measurement
# behind it would silently never be met, so the loader refuses one it cannot compute.
KNOWN_PROMOTION_CRITERIA: tuple[str, ...] = (
    "accepted-claims",
    "approved-sources",
    "escalated-mappings",
)


@dataclass(frozen=True)
class UnresolvedTopic(_Serialisable):
    """One area where a guess would be worse than an admitted unknown."""

    topic: str
    note: str
    guidance: str
    entity_kinds: tuple[EntityKind, ...]
    field_paths: tuple[str, ...]

    def matches(self, claim: ClaimCandidate) -> bool:
        return claim.entity_kind in self.entity_kinds and claim.field_path in self.field_paths


@dataclass(frozen=True)
class PromotionThreshold(_Serialisable):
    """One published promotion criterion, before a run has measured it."""

    id: str
    description: str
    threshold: int


@dataclass(frozen=True)
class PromotionRules(_Serialisable):
    """When a creator is flagged as meriting a dedicated profile.

    ``rule`` is ``"all"``: every criterion must be met. A partial match is still
    recorded in full, so a near miss is visible rather than rounded to "no".
    """

    description: str
    criteria: tuple[PromotionThreshold, ...]
    rule: str = "all"


@dataclass(frozen=True)
class LongTailProfile(_Serialisable):
    """The reviewed generic profile, instantiated per creator at run time."""

    id: str
    kind: str
    name: str
    applies_to: str
    review_policy: ReviewPolicy
    terminology: Mapping[str, str]
    naming_rules: tuple[NamingRule, ...]
    extraction: ExtractionRules
    ambiguities: tuple[SourceAmbiguity, ...]
    unresolved_topics: tuple[UnresolvedTopic, ...]
    promotion: PromotionRules
    seed_kind: SourceKind
    seed_trust: str
    seed_trust_notes: str
    notes: tuple[str, ...] = ()

    def for_creator(self, creator: CreatorRequest) -> CreatorProfile:
        """Build this creator's profile from the seeds the run was given.

        **Where the seeds come from.** They are ``creator.entry_urls`` — the entry
        URLs carried by the run's :class:`CreatorRequest`, which the operator
        supplied (in a fixture run, the ``entry_urls`` recorded in the creator's
        fixture file). They are *not* discovered by this module, not fetched here,
        and not inferred from the creator's name. Nothing in this tool invents a URL
        for a creator it knows nothing about.

        They are therefore marked ``unverified-seed`` and carry **no**
        ``verified_at``: nobody reviewed them, and stamping a verification date on
        an unreviewed URL would invent provenance. Lower trust buys a seed nothing —
        it still goes through the same URL safety check and the same deterministic
        hard gates as a catalogued source, and everything off these origins is a
        discovery needing the unanimous vote.
        """
        catalog: list[TrustedSource] = []
        seen: set[str] = set()
        for url in creator.entry_urls:
            # A seed is trusted less than a catalogued source, so it is checked at
            # least as hard. Building a catalog entry from a URL that fails the
            # objective safety check would let low trust buy a lighter path.
            issues = url_safety_issues(f"seed url for {creator.creator_id}", url)
            if issues:
                raise ProfileError("; ".join(issues))
            origin = origin_of(url)
            if origin in seen:
                continue
            seen.add(origin)
            catalog.append(
                TrustedSource(
                    id=f"{creator.creator_id}-seed-{len(catalog) + 1}",
                    owner=creator.creator_name,
                    url=url,
                    kind=self.seed_kind,
                    # No allowed paths: the whole seed origin is what the run was
                    # pointed at, which is also how the workflow decides whether a
                    # source is newly discovered. The two must not disagree.
                    allowed_paths=(),
                    trust=self.seed_trust,
                    trust_notes=self.seed_trust_notes,
                    # Deliberately no verified_at: nobody checked this seed.
                    verified_at=None,
                    verification=None,
                )
            )
        if not catalog:
            raise ProfileError(
                f"creator {creator.creator_id!r} has no entry URL, so the long-tail "
                "profile has nothing to treat as a seed source"
            )
        return CreatorProfile(
            creator_id=creator.creator_id,
            creator_name=creator.creator_name,
            creator_type="unknown",
            aliases=(),
            terminology=dict(self.terminology),
            naming_rules=self.naming_rules,
            catalog=tuple(catalog),
            extraction=self.extraction,
            ambiguities=self.ambiguities,
            notes=(
                f"generic long-tail profile {self.id!r}: this creator has no reviewed "
                "dedicated profile, so acceptance requires all three lenses",
                *self.notes,
            ),
        )

    def topic_for(self, claim: ClaimCandidate) -> UnresolvedTopic | None:
        """The first topic this claim belongs to, if any. Order is the file's order."""
        for topic in self.unresolved_topics:
            if topic.matches(claim):
                return topic
        return None


def _require(document: Mapping[str, Any], key: str, *, path: Path) -> Any:
    if key not in document:
        raise ProfileError(f"{path.name}: missing required field {key!r}")
    return document[key]


def _entity_kind(value: Any, *, path: Path) -> EntityKind:
    try:
        return EntityKind(value)
    except ValueError as error:
        raise ProfileError(f"{path.name}: unknown entity kind {value!r}") from error


def _review_policy(raw: Mapping[str, Any], *, path: Path) -> ReviewPolicy:
    """Resolve the declared policy against the ones the code actually implements.

    The file *declares* a policy; it does not *define* one. The declaration is
    matched field by field against the named constant in ``review.py`` and the
    constant is what the run uses, so editing this file can only ever produce a
    load error — never a quieter gate, and never a rationale string that says
    something the aggregation does not do.

    Anything short of unanimity is refused outright: a long-tail profile asking
    for a 2-of-3 accept would be a bypass of the one rule it exists to apply.
    """
    declared_id = _require(raw, "id", path=path)
    policy = REVIEW_POLICIES.get(str(declared_id))
    if policy is None:
        known = ", ".join(sorted(REVIEW_POLICIES))
        raise ProfileError(
            f"{path.name}: unknown review policy {declared_id!r}; the code implements {known}"
        )
    if policy.required_accepts != PANEL_SIZE:
        raise ProfileError(
            f"{path.name}: the long-tail profile requires unanimous acceptance, so "
            f"the review policy must ask for {PANEL_SIZE} accepts, but "
            f"{policy.id!r} asks for {policy.required_accepts}"
        )
    for field in ("required_accepts", "required_rejects", "decision_label", "description"):
        declared = _require(raw, field, path=path)
        actual = getattr(policy, field)
        if declared != actual:
            raise ProfileError(
                f"{path.name}: review policy {policy.id!r} declares {field}={declared!r}, "
                f"but the implemented policy is {actual!r}; the file must restate the "
                "policy exactly or the proposal would record a bar nobody applied"
            )
    return policy


def _promotion_rules(raw: Mapping[str, Any], *, path: Path) -> PromotionRules:
    rule = raw.get("rule", "all")
    if rule != "all":
        raise ProfileError(
            f"{path.name}: only the 'all' promotion rule is implemented, got {rule!r}"
        )
    criteria = tuple(
        PromotionThreshold(
            id=_require(item, "id", path=path),
            description=_require(item, "description", path=path),
            threshold=int(_require(item, "threshold", path=path)),
        )
        for item in _require(raw, "criteria", path=path)
    )
    if not criteria:
        raise ProfileError(f"{path.name}: promotion_criteria must list at least one criterion")
    unknown = sorted({item.id for item in criteria} - set(KNOWN_PROMOTION_CRITERIA))
    if unknown:
        raise ProfileError(
            f"{path.name}: no measurement exists for promotion criterion(s) "
            f"{', '.join(unknown)}; expected one of {', '.join(KNOWN_PROMOTION_CRITERIA)}"
        )
    return PromotionRules(
        description=_require(raw, "description", path=path),
        criteria=criteria,
        rule=rule,
    )


def _unresolved_topic(raw: Mapping[str, Any], *, path: Path) -> UnresolvedTopic:
    return UnresolvedTopic(
        topic=_require(raw, "topic", path=path),
        note=_require(raw, "note", path=path),
        guidance=_require(raw, "guidance", path=path),
        entity_kinds=tuple(
            _entity_kind(value, path=path)
            for value in _require(raw, "entity_kinds", path=path)
        ),
        field_paths=tuple(_require(raw, "field_paths", path=path)),
    )


def load_long_tail_profile(path: Path | str = DEFAULT_LONG_TAIL_PROFILE) -> LongTailProfile:
    """Load the generic profile from JSON, failing loudly on a malformed file."""
    path = Path(path)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except (OSError, json.JSONDecodeError) as error:
        raise ProfileError(f"{path.name}: could not be read: {error}") from error

    profile = _require(document, "profile", path=path)
    seed = _require(document, "seed_source", path=path)
    extraction_raw = document.get("extraction_rules", {})
    topics = tuple(
        _unresolved_topic(raw, path=path)
        for raw in _require(document, "unresolved_topics", path=path)
    )
    if not topics:
        raise ProfileError(
            f"{path.name}: unresolved_topics must name the mappings that stay explicit"
        )
    try:
        seed_kind = SourceKind(_require(seed, "kind", path=path))
    except ValueError as error:
        raise ProfileError(f"{path.name}: unknown seed source kind {seed.get('kind')!r}") from error

    return LongTailProfile(
        id=_require(profile, "id", path=path),
        kind=profile.get("kind", "long-tail"),
        name=_require(profile, "name", path=path),
        applies_to=_require(profile, "applies_to", path=path),
        review_policy=_review_policy(
            _require(document, "review_policy", path=path), path=path
        ),
        terminology=dict(document.get("terminology", {})),
        naming_rules=tuple(
            NamingRule(
                subject=_require(raw, "subject", path=path),
                rule=_require(raw, "rule", path=path),
                example=raw.get("example"),
            )
            for raw in document.get("naming_rules", ())
        ),
        extraction=ExtractionRules(
            entity_kinds=tuple(extraction_raw.get("entity_kinds", ())),
            notes=tuple(extraction_raw.get("notes", ())),
        ),
        ambiguities=tuple(
            SourceAmbiguity(
                topic=_require(raw, "topic", path=path),
                note=_require(raw, "note", path=path),
                guidance=raw.get("guidance", "leave explicit; do not guess"),
            )
            for raw in document.get("ambiguities", ())
        ),
        unresolved_topics=topics,
        promotion=_promotion_rules(
            _require(document, "promotion_criteria", path=path), path=path
        ),
        seed_kind=seed_kind,
        seed_trust=seed.get("trust", "unverified-seed"),
        seed_trust_notes=_require(seed, "trust_notes", path=path),
        notes=tuple(document.get("notes", ())),
    )


def unresolved_mapping_conflicts(
    profile: LongTailProfile,
    claims: Sequence[ClaimCandidate],
    adjudications: Sequence[ClaimAdjudication],
    *,
    detected_at: str,
) -> tuple[Conflict, ...]:
    """Record every naming, ownership, or lineage mapping the run could not settle.

    Only escalated claims (``needs-human-review``) qualify. A rejected claim was
    decided, and a claim a gate vetoed is already recorded as a gate failure; an
    escalation is the one outcome that would otherwise leave nothing behind.
    """
    by_id = {claim.id: claim for claim in claims}
    conflicts: list[Conflict] = []

    for adjudication in adjudications:
        if adjudication.decision is not ClaimDecision.NEEDS_HUMAN_REVIEW:
            continue
        claim = by_id.get(adjudication.claim_id)
        if claim is None:  # pragma: no cover - adjudications are built from claims
            continue
        topic = profile.topic_for(claim)
        if topic is None:
            continue
        conflicts.append(
            Conflict(
                id=f"conflict:unresolved-{topic.topic}:{claim.id}",
                entity_kind=claim.entity_kind,
                entity_id=claim.entity_id,
                field_path=claim.field_path,
                kind=ConflictKind.UNRESOLVED_MAPPING,
                claim_ids=(claim.id,),
                values=(
                    f"{topic.topic} unresolved under the generic long-tail profile — "
                    f"{topic.guidance}",
                    claim.value,
                ),
                detected_at=detected_at,
            )
        )
    return tuple(conflicts)


def _accepted_claim_ids(adjudications: Sequence[ClaimAdjudication]) -> frozenset[str]:
    return frozenset(
        adjudication.claim_id
        for adjudication in adjudications
        if adjudication.decision is ClaimDecision.ACCEPT
    )


def _observations(
    claims: Sequence[ClaimCandidate],
    adjudications: Sequence[ClaimAdjudication],
    source_approvals: Sequence[SourceApproval],
    unresolved: Sequence[Conflict],
) -> dict[str, int]:
    """Measure each published criterion against what this run actually produced."""
    accepted_ids = _accepted_claim_ids(adjudications)
    accepted = [claim for claim in claims if claim.id in accepted_ids]
    approved_ids = {
        approval.source_id for approval in source_approvals if approval.approved
    }
    backing = {
        evidence.source_id
        for claim in accepted
        for evidence in claim.evidence
        if evidence.source_id in approved_ids
    }
    return {
        "accepted-claims": len(accepted),
        "approved-sources": len(backing),
        "escalated-mappings": len(unresolved),
    }


def assess_promotion(
    profile: LongTailProfile,
    *,
    creator_id: str,
    claims: Sequence[ClaimCandidate],
    adjudications: Sequence[ClaimAdjudication],
    source_approvals: Sequence[SourceApproval],
    unresolved: Sequence[Conflict],
    assessed_at: str,
) -> PromotionAssessment:
    """Flag whether this creator merits a reviewed dedicated profile.

    Produced for every creator the generic profile processes, recommended or not, so
    "not recommended" is a recorded measurement rather than an absence. It recommends;
    it never acts.
    """
    observed = _observations(claims, adjudications, source_approvals, unresolved)
    criteria = tuple(
        PromotionCriterion(
            id=threshold.id,
            description=threshold.description,
            threshold=threshold.threshold,
            observed=observed[threshold.id],
            met=observed[threshold.id] >= threshold.threshold,
        )
        for threshold in profile.promotion.criteria
    )
    recommended = all(criterion.met for criterion in criteria)
    unmet = [criterion.id for criterion in criteria if not criterion.met]

    if recommended:
        rationale = (
            f"every promotion criterion is met ({', '.join(f'{c.id} {c.observed}/{c.threshold}' for c in criteria)}); "
            "a reviewed dedicated profile would give this creator the terminology and "
            "source catalog the generic profile has to do without"
        )
    else:
        rationale = (
            f"not every promotion criterion is met (unmet: {', '.join(unmet)}; "
            f"observed {', '.join(f'{c.id} {c.observed}/{c.threshold}' for c in criteria)}); "
            "the generic profile continues to cover this creator"
        )

    return PromotionAssessment(
        creator_id=creator_id,
        profile_id=profile.id,
        recommended=recommended,
        criteria=criteria,
        rationale=rationale,
        assessed_at=assessed_at,
    )
