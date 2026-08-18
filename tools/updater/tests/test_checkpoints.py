"""Runs are durable: state is checkpointed and a run can be resumed."""

from __future__ import annotations

import asyncio
import inspect

import pytest

from modeltree_updater.checkpoints import (
    ALLOWED_CHECKPOINT_TYPES,
    create_checkpoint_storage,
    list_checkpoint_summaries,
    recorded_providers,
)
from modeltree_updater.contracts import ProposalStatus
from modeltree_updater.runner import ProviderMismatch, resume_creator_run, run_creator
from modeltree_updater.workflow import WORKFLOW_NAME


async def _list(storage):
    checkpoints = storage.list_checkpoints(workflow_name=WORKFLOW_NAME)
    if inspect.isawaitable(checkpoints):
        checkpoints = await checkpoints
    return sorted(checkpoints, key=lambda item: item.iteration_count)


def test_message_types_are_allow_listed_for_restore() -> None:
    assert "modeltree_updater.messages:CreatorTask" in ALLOWED_CHECKPOINT_TYPES
    assert "modeltree_updater.contracts:ClaimCandidate" in ALLOWED_CHECKPOINT_TYPES


def test_a_run_writes_checkpoints_and_can_be_resumed(tmp_path, library, settings) -> None:
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def scenario():
        original = await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        checkpoints = await _list(storage)
        resumed = await resume_creator_run(
            settings,
            checkpoint_id=checkpoints[0].checkpoint_id,
            checkpoint_storage=storage,
        )
        summaries = await list_checkpoint_summaries(storage, workflow_name=WORKFLOW_NAME)
        return original, resumed, checkpoints, summaries

    original, resumed, checkpoints, summaries = asyncio.run(scenario())

    assert len(checkpoints) > 1
    assert any(tmp_path.joinpath("checkpoints").iterdir())
    assert resumed.status is ProposalStatus.COMPLETE
    assert resumed.claims == original.claims
    assert resumed.verdicts == original.verdicts
    assert [summary["iteration"] for summary in summaries] == sorted(
        summary["iteration"] for summary in summaries
    )


def test_checkpoints_survive_a_new_storage_handle(tmp_path, library, settings) -> None:
    directory = tmp_path / "checkpoints"

    asyncio.run(
        run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=create_checkpoint_storage(directory),
        )
    )

    reopened = create_checkpoint_storage(directory)
    checkpoints = asyncio.run(_list(reopened))
    resumed = asyncio.run(
        resume_creator_run(
            settings,
            checkpoint_id=checkpoints[0].checkpoint_id,
            checkpoint_storage=reopened,
        )
    )

    assert checkpoints
    assert resumed.creator_id == "contoso-ai"


def test_a_checkpoint_records_the_providers_that_produced_it(
    tmp_path, library, settings
) -> None:
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def scenario():
        proposal = await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        checkpoints = await _list(storage)
        recorded = await recorded_providers(storage, checkpoints[0].checkpoint_id)
        return proposal, recorded

    proposal, recorded = asyncio.run(scenario())

    assert recorded == settings.providers.descriptor
    # The artefact states its own provenance, not just the checkpoint.
    assert proposal.providers == settings.providers.descriptor


def test_resuming_with_different_providers_is_refused(tmp_path, library, settings) -> None:
    """Provenance must survive a resume: substituting providers is not allowed."""
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    class Impostor:
        name = "impostor:sources"

        async def discover(self, creator, *, limit):  # pragma: no cover - never reached
            raise AssertionError

        async def fetch(self, candidate):  # pragma: no cover - never reached
            raise AssertionError

    substituted = type(settings)(
        type(settings.providers)(
            sources=Impostor(),
            extractor=settings.providers.extractor,
            panel=settings.providers.panel,
        ),
        budget=settings.budget,
        timestamp=settings.timestamp,
    )

    async def scenario():
        await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        checkpoints = await _list(storage)
        return checkpoints[0].checkpoint_id

    checkpoint_id = asyncio.run(scenario())

    with pytest.raises(ProviderMismatch) as error:
        asyncio.run(
            resume_creator_run(
                substituted,
                checkpoint_id=checkpoint_id,
                checkpoint_storage=storage,
            )
        )

    assert "impostor:sources" in str(error.value)
    assert error.value.recorded == settings.providers.descriptor
