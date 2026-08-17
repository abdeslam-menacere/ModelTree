"""Durable checkpoint storage for creator runs.

Agent Framework persists workflow state between supersteps. Because checkpoints
restore Python objects, every ModelTree type that can appear in a message is
allow-listed explicitly rather than relaxing the framework's deserialisation guard.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any, Sequence

from agent_framework import FileCheckpointStorage, InMemoryCheckpointStorage

from . import contracts, messages

__all__ = [
    "ALLOWED_CHECKPOINT_TYPES",
    "create_checkpoint_storage",
    "create_in_memory_checkpoint_storage",
    "list_checkpoint_summaries",
]


def _type_name(cls: type[Any]) -> str:
    return f"{cls.__module__}:{cls.__qualname__}"


ALLOWED_CHECKPOINT_TYPES: tuple[str, ...] = tuple(
    _type_name(cls)
    for cls in (
        *messages.MESSAGE_TYPES,
        contracts.BudgetUsage,
        contracts.ClaimCandidate,
        contracts.ClaimDecision,
        contracts.Conflict,
        contracts.ConflictKind,
        contracts.CreatorProposal,
        contracts.CreatorRequest,
        contracts.EntityKind,
        contracts.Evidence,
        contracts.FailureKind,
        contracts.FetchedPage,
        contracts.ProposalStatus,
        contracts.ReviewVerdict,
        contracts.RunFailure,
        contracts.SourceCandidate,
        contracts.SourceKind,
        contracts.ValidationResult,
        contracts.ValidationStatus,
        contracts.WorkflowStage,
    )
)


def create_checkpoint_storage(directory: str | Path) -> FileCheckpointStorage:
    """File-backed storage so a run survives the process that started it."""
    path = Path(directory)
    path.mkdir(parents=True, exist_ok=True)
    return FileCheckpointStorage(path, allowed_checkpoint_types=list(ALLOWED_CHECKPOINT_TYPES))


def create_in_memory_checkpoint_storage() -> InMemoryCheckpointStorage:
    return InMemoryCheckpointStorage()


async def list_checkpoint_summaries(
    storage: Any, *, workflow_name: str
) -> Sequence[dict[str, Any]]:
    """Human-readable checkpoint list for `modeltree-updater checkpoints`."""
    checkpoints = storage.list_checkpoints(workflow_name=workflow_name)
    if inspect.isawaitable(checkpoints):
        checkpoints = await checkpoints
    summaries: list[dict[str, Any]] = []
    for checkpoint in sorted(
        checkpoints, key=lambda item: getattr(item, "iteration_count", 0)
    ):
        summaries.append(
            {
                "checkpoint_id": getattr(checkpoint, "checkpoint_id", None),
                "workflow_id": getattr(checkpoint, "workflow_id", None),
                "iteration": getattr(checkpoint, "iteration_count", None),
                "timestamp": getattr(checkpoint, "timestamp", None),
            }
        )
    return summaries
