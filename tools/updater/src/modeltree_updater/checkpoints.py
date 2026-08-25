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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from agent_framework import FileCheckpointStorage, InMemoryCheckpointStorage

from . import __version__, contracts, messages
from .safety import assert_proposal_output_path

__all__ = [
    "ALLOWED_CHECKPOINT_TYPES",
    "CHECKPOINT_SCHEMA_VERSION",
    "TOOL_VERSION",
    "CheckpointVersion",
    "create_checkpoint_storage",
    "create_in_memory_checkpoint_storage",
    "current_version_marker",
    "list_checkpoint_summaries",
    "load_checkpoint",
    "recorded_profile_id",
    "recorded_providers",
    "recorded_version_marker",
]


TOOL_VERSION: str = __version__
"""The build that writes a checkpoint, taken from the package rather than restated.

`modeltree_updater.__version__` and `pyproject.toml` already agree on one number,
and a second literal here would be a third place to forget.
"""

CHECKPOINT_SCHEMA_VERSION: int = 1
"""The shape of the state a checkpoint restores.

`1` because this is the first shape that says which build wrote it. Everything
earlier is unnumbered rather than version `0`: it carries no marker at all, which
is a different fact and is reported as such.

Increment it whenever a checkpoint written by the current build would be
misread by an older one, or the reverse — a message field added, removed, or
given a new meaning; a type added to `ALLOWED_CHECKPOINT_TYPES`; a change to
what a stage puts in `budget_state`. It is deliberately not tied to
`TOOL_VERSION`: the tool can be released without the checkpointed state changing
shape, and that release should not invalidate work in flight for no reason. Both
are recorded because they answer different questions — *which code* wrote this,
and *which shape* it wrote.
"""


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


@dataclass(frozen=True)
class CheckpointVersion:
    """Which build wrote a checkpoint, and which state shape it wrote.

    A return type, never a stored one. The marker travels in the checkpoint as two
    plain scalars on the message, so nothing here is pickled and
    `ALLOWED_CHECKPOINT_TYPES` is untouched — this class only gives the two values a
    name once they have been read back out.

    Either field is `None` where the checkpoint recorded nothing for it. Both are
    `None` for a checkpoint written before the marker existed; that is *unmarked*,
    and it is not the same fact as a marker that disagrees.
    """

    tool_version: str | None
    schema_version: int | None

    @property
    def is_marked(self) -> bool:
        return self.tool_version is not None or self.schema_version is not None

    def describe(self) -> str:
        if not self.is_marked:
            return "no tool or checkpoint schema version"
        return (
            f"modeltree-updater {self.tool_version or 'unknown'} "
            f"(checkpoint schema {self.schema_version if self.schema_version is not None else 'unknown'})"
        )


def current_version_marker() -> CheckpointVersion:
    """The marker this build stamps on the runs it starts, and checks resumes against."""
    return CheckpointVersion(
        tool_version=TOOL_VERSION, schema_version=CHECKPOINT_SCHEMA_VERSION
    )


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


async def recorded_version_marker(storage: Any, checkpoint_id: str) -> CheckpointVersion | None:
    """Which build wrote this checkpoint, read out of the state it stored.

    The same reading as `recorded_providers`, one step further along. The providers
    say where the evidence came from and `recorded_profile_id` says which bar it was
    judged by; neither says whether *the code that interprets the state* is still the
    code that wrote it. A run's earlier supersteps were adjudicated under one build
    and its later ones would be adjudicated under another, with the id matching
    throughout, and nothing in the proposal would say so.

    A **version marker, never a content hash.** A hash of the profile set would make
    every benign profile edit invalidate every outstanding checkpoint, and ADR 0002
    considered and rejected exactly that (its option 2). This detects the case that
    reasoning left open — the interpreting code changed — and nothing finer.

    Two different `None`s, kept apart on purpose:

    - The function returns `None` when there is nothing to read a marker *from* — no
      checkpoint at all, or a checkpoint storing no messages. The second is the one
      the runner writes after the final superstep: it has nothing left to deliver, so
      it records no message to carry a marker and it is not a resumable choice in the
      first place. Neither is a version disagreement, and calling either one
      "unmarked" would put a false sentence in a refusal. Both are left to fail the
      way they fail today.
    - It returns an **unmarked** `CheckpointVersion(None, None)` for a checkpoint that
      does store messages and none of them names a version. That is state written
      before this marker existed, and it is a fact the caller has to act on rather
      than one it may skip.

    Malformed payloads crash here rather than degrading, which is the settled
    convention for the readers on this path (`recorded_providers`,
    `recorded_profile_id`): the declared `dict[str, list[WorkflowMessage]]` shape is
    enforced at the storage layer, and a reader that quietly returned `None` for a
    payload it could not parse would turn *unreadable* into *unmarked* — the one
    confusion this marker exists to prevent. `_recorded_creator_id` is defensive for
    the opposite reason: it feeds a listing where one bad row must not take down the
    other rows. This feeds a refusal, so it fails loudly instead.
    """
    checkpoint = await load_checkpoint(storage, checkpoint_id)
    if checkpoint is None:
        return None
    stored_a_message = False
    for envelopes in (getattr(checkpoint, "messages", None) or {}).values():
        for envelope in envelopes:
            stored_a_message = True
            data = getattr(envelope, "data", None)
            tool_version = getattr(data, "tool_version", None)
            schema_version = getattr(data, "checkpoint_schema_version", None)
            if tool_version is not None or schema_version is not None:
                return CheckpointVersion(
                    tool_version=None if tool_version is None else str(tool_version),
                    schema_version=None if schema_version is None else int(schema_version),
                )
    if not stored_a_message:
        return None
    return CheckpointVersion(tool_version=None, schema_version=None)
