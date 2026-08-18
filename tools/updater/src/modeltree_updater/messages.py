"""Messages passed between workflow executors.

They are small, immutable, and picklable so a run can be checkpointed between
supersteps and resumed later. Page text never travels in a message: only the
sources, claims, verdicts, failures, and budget counters do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .contracts import (
    ClaimCandidate,
    CreatorRequest,
    ReviewVerdict,
    RunFailure,
    SourceCandidate,
    SourceVerdict,
)

__all__ = [
    "CreatorTask",
    "DiscoveredSources",
    "ExtractedClaims",
    "ReviewedClaims",
    "MESSAGE_TYPES",
]


@dataclass(frozen=True)
class CreatorTask:
    """The unit of work handed to the workflow: exactly one creator."""

    run_id: str
    creator: CreatorRequest
    budget_state: Mapping[str, float] = field(default_factory=dict)
    # Which providers produced this run. It travels with the message so a resumed
    # run can be checked against the providers that started it: a proposal whose
    # provenance changed mid-run is not the proposal it claims to be.
    providers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class DiscoveredSources:
    run_id: str
    creator: CreatorRequest
    sources: tuple[SourceCandidate, ...]
    failures: tuple[RunFailure, ...]
    budget_state: Mapping[str, float]
    providers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ExtractedClaims:
    run_id: str
    creator: CreatorRequest
    sources: tuple[SourceCandidate, ...]
    claims: tuple[ClaimCandidate, ...]
    failures: tuple[RunFailure, ...]
    budget_state: Mapping[str, float]
    providers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ReviewedClaims:
    run_id: str
    creator: CreatorRequest
    sources: tuple[SourceCandidate, ...]
    claims: tuple[ClaimCandidate, ...]
    verdicts: tuple[ReviewVerdict, ...]
    failures: tuple[RunFailure, ...]
    budget_state: Mapping[str, float]
    providers: Mapping[str, str] = field(default_factory=dict)
    # Every lens verdict on a newly discovered source. The approval decision itself
    # is deterministic and is made once, in the bundling stage.
    source_verdicts: tuple[SourceVerdict, ...] = ()
    newly_discovered_source_ids: tuple[str, ...] = ()


MESSAGE_TYPES: tuple[type[Any], ...] = (
    CreatorTask,
    DiscoveredSources,
    ExtractedClaims,
    ReviewedClaims,
)
