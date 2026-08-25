"""Durable checkpoint storage for creator runs.

Agent Framework persists workflow state between supersteps. Because checkpoints
restore Python objects, every ModelTree type that can appear in a message is
allow-listed explicitly rather than relaxing the framework's deserialisation guard.

The checkpoint directory is a caller-supplied path, so it passes the same
proposal-only guard as `--output`. Checkpoint state is workflow bookkeeping
rather than a proposal, but it is still this tool creating directories from a
flag, and the boundary is about where the tool may write at all — not about what
it happens to be writing.
"""

from __future__ import annotations

import inspect
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Sequence

from agent_framework import FileCheckpointStorage, InMemoryCheckpointStorage

from . import contracts, messages
from .safety import assert_proposal_output_path

__all__ = [
    "ALLOWED_CHECKPOINT_TYPES",
    "create_checkpoint_storage",
    "create_in_memory_checkpoint_storage",
    "list_checkpoint_summaries",
    "load_checkpoint",
    "recorded_profile_id",
    "recorded_providers",
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
        contracts.ClaimAdjudication,
        contracts.CreatorProposal,
        contracts.CreatorRequest,
        contracts.EntityKind,
        contracts.Evidence,
        contracts.FailureKind,
        contracts.FetchedPage,
        contracts.GateResult,
        contracts.GateStatus,
        contracts.ProposalStatus,
        contracts.ReviewLens,
        contracts.ReviewPolicy,
        contracts.ReviewVerdict,
        contracts.RunFailure,
        contracts.SourceApproval,
        contracts.SourceCandidate,
        contracts.SourceKind,
        contracts.SourceVerdict,
        contracts.ValidationResult,
        contracts.ValidationStatus,
        contracts.WorkflowStage,
    )
)


def create_checkpoint_storage(directory: str | Path) -> FileCheckpointStorage:
    """File-backed storage so a run survives the process that started it.

    Guarded before the directory is created: `--checkpoint-dir` reaches this from
    `run`, `resume`, and `checkpoints` alike, so refusing here covers every entry
    point instead of trusting each command to remember.
    """
    path = assert_proposal_output_path(directory)
    path.mkdir(parents=True, exist_ok=True)
    return FileCheckpointStorage(path, allowed_checkpoint_types=list(ALLOWED_CHECKPOINT_TYPES))


def create_in_memory_checkpoint_storage() -> InMemoryCheckpointStorage:
    return InMemoryCheckpointStorage()


def _recorded_creator_id(checkpoint: Any) -> str | None:
    """The creator a checkpoint belongs to, read out of the messages it stored.

    Every workflow message carries the `CreatorRequest` it is working on, so the
    identity is already in the payload and this reads it there — the same way
    `recorded_providers` reads provenance. It is deliberately not parsed out of
    `workflow_id` or any other composite identifier: that would be a guess about a
    string format rather than a fact the run recorded.

    `None` where the checkpoint records no message naming a creator. The checkpoint
    written after the final superstep is exactly that: it has nothing left to
    deliver, so there is no message to read a creator from, and it is not a
    resumable choice in the first place. Unknown is reported as unknown rather than
    inferred, and a checkpoint whose messages cannot be read this way returns `None`
    instead of taking the whole listing down with it.
    """
    messages = getattr(checkpoint, "messages", None)
    if not isinstance(messages, Mapping):
        return None
    for envelopes in messages.values():
        for envelope in envelopes or ():
            creator = getattr(getattr(envelope, "data", None), "creator", None)
            creator_id = getattr(creator, "creator_id", None)
            if creator_id:
                return str(creator_id)
    return None


async def list_checkpoint_summaries(
    storage: Any, *, workflow_name: str
) -> Sequence[dict[str, Any]]:
    """Human-readable checkpoint list for `modeltree-updater checkpoints`.

    `run_creators` writes every creator's checkpoints into one storage, so without a
    creator on each row an operator choosing one for `resume --checkpoint-id` after a
    multi-creator run is picking between opaque ids — and a wrong pick silently
    resumes a different creator rather than failing.
    """
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
                "creator_id": _recorded_creator_id(checkpoint),
                "workflow_id": getattr(checkpoint, "workflow_id", None),
                "iteration": getattr(checkpoint, "iteration_count", None),
                "timestamp": getattr(checkpoint, "timestamp", None),
            }
        )
    return summaries


async def _resolve(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def load_checkpoint(storage: Any, checkpoint_id: str) -> Any:
    """Load one checkpoint, tolerating the sync and async storage variants."""
    return await _resolve(storage.load(checkpoint_id))


async def recorded_providers(storage: Any, checkpoint_id: str) -> dict[str, str] | None:
    """The providers the checkpointed run was started with, if it recorded any.

    Messages carry the provider descriptor, so this reads the provenance out of the
    checkpoint itself rather than trusting whatever the resuming command asks for.
    """
    checkpoint = await load_checkpoint(storage, checkpoint_id)
    if checkpoint is None:
        return None
    for envelopes in (getattr(checkpoint, "messages", None) or {}).values():
        for envelope in envelopes:
            providers = getattr(getattr(envelope, "data", None), "providers", None)
            if providers:
                return dict(providers)
    return None


async def recorded_profile_id(storage: Any, checkpoint_id: str) -> str | None:
    """The profile the checkpointed run was started under, if it recorded one.

    Read for the same reason as the providers, and with more at stake: the review
    threshold rides on it. A resumed long-tail run must be judged on the bar it
    began with, so the checkpoint answers that question rather than the flags of
    whoever resumes it.
    """
    checkpoint = await load_checkpoint(storage, checkpoint_id)
    if checkpoint is None:
        return None
    for envelopes in (getattr(checkpoint, "messages", None) or {}).values():
        for envelope in envelopes:
            profile_id = getattr(getattr(envelope, "data", None), "profile_id", None)
            if profile_id:
                return str(profile_id)
    return None
