"""Conflict detection across claim candidates.

Conflicting data stays explicit. Nothing here picks a winner, averages values, or
drops the loser — a conflict is reported so a human decides.
"""

from __future__ import annotations

import json
from typing import Any, Sequence

from .contracts import ClaimCandidate, Conflict, ConflictKind

__all__ = ["detect_conflicts"]


def _normalise(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        return json.dumps([_normalise(item) for item in value], sort_keys=True)
    if isinstance(value, dict):
        return json.dumps({k: _normalise(v) for k, v in value.items()}, sort_keys=True)
    if isinstance(value, str):
        return value.strip()
    return json.dumps(value, sort_keys=True)


def detect_conflicts(
    claims: Sequence[ClaimCandidate], *, detected_at: str
) -> tuple[Conflict, ...]:
    """Report every field where the candidate claims disagree.

    Two kinds are distinguished: different claims disagreeing about a field, and a
    single source backing two different values for the same field.
    """
    conflicts: list[Conflict] = []
    grouped: dict[tuple[str, str, str], list[ClaimCandidate]] = {}

    for claim in claims:
        key = (claim.entity_kind.value, claim.entity_id, claim.field_path)
        grouped.setdefault(key, []).append(claim)

    for (entity_kind, entity_id, field_path), group in sorted(grouped.items()):
        by_value: dict[str, list[ClaimCandidate]] = {}
        for claim in group:
            by_value.setdefault(_normalise(claim.value), []).append(claim)

        if len(by_value) > 1:
            conflicts.append(
                Conflict(
                    id=f"conflict:{entity_kind}:{entity_id}:{field_path}",
                    entity_kind=group[0].entity_kind,
                    entity_id=entity_id,
                    field_path=field_path,
                    kind=ConflictKind.CONTRADICTORY_VALUES,
                    claim_ids=tuple(sorted(claim.id for claim in group)),
                    values=tuple(claim.value for claim in group),
                    detected_at=detected_at,
                )
            )

        source_values: dict[str, set[str]] = {}
        for normalised, value_claims in by_value.items():
            for claim in value_claims:
                for evidence in claim.evidence:
                    source_values.setdefault(evidence.source_id, set()).add(normalised)

        self_contradicting = sorted(
            source_id for source_id, values in source_values.items() if len(values) > 1
        )
        if self_contradicting:
            conflicts.append(
                Conflict(
                    id=f"conflict:source:{entity_kind}:{entity_id}:{field_path}",
                    entity_kind=group[0].entity_kind,
                    entity_id=entity_id,
                    field_path=field_path,
                    kind=ConflictKind.CONTRADICTORY_SOURCES,
                    claim_ids=tuple(sorted(claim.id for claim in group)),
                    values=tuple(self_contradicting),
                    detected_at=detected_at,
                )
            )

    return tuple(conflicts)
