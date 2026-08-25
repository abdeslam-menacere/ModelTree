"""Runs are durable: state is checkpointed and a run can be resumed."""

from __future__ import annotations

import asyncio
import inspect

import pytest

from modeltree_updater.checkpoints import (
    ALLOWED_CHECKPOINT_TYPES,
    create_checkpoint_storage,
    list_checkpoint_summaries,
    load_checkpoint,
    recorded_providers,
)
from modeltree_updater.contracts import ProposalStatus
from modeltree_updater.runner import ProviderMismatch, resume_creator_run, run_creator
from modeltree_updater.safety import ProposalOnlyViolation
from modeltree_updater.workflow import WORKFLOW_NAME


async def _list(storage):
    checkpoints = storage.list_checkpoints(workflow_name=WORKFLOW_NAME)
    if inspect.isawaitable(checkpoints):
        checkpoints = await checkpoints
    return sorted(checkpoints, key=lambda item: item.iteration_count)


async def _pending_budget_state(storage, checkpoint_id):
    """The `budget_state` carried by a checkpoint's undelivered messages.

    Read out of the stored message, the way `checkpoints.recorded_providers` reads
    provenance, so a checkpoint is judged by what it records rather than by where it
    sits in the list.

    `None` means the checkpoint has nothing left to deliver. The runner writes one of
    those after the final superstep, so the *last* checkpoint is not a resumable one:
    restoring it would run no stage and produce no proposal at all.
    """
    checkpoint = await load_checkpoint(storage, checkpoint_id)
    if checkpoint is None:
        return None
    for envelopes in (getattr(checkpoint, "messages", None) or {}).values():
        for envelope in envelopes:
            state = getattr(getattr(envelope, "data", None), "budget_state", None)
            if state is not None:
                return dict(state)
    return None


def _records_spend(state) -> bool:
    """Whether a checkpointed ledger has already charged for work.

    This is what "mid-run" means here. The entry checkpoint holds the original
    `CreatorTask`, whose `budget_state` defaults to empty, so a checkpoint that
    records real spend is necessarily one taken after a stage has run.
    """
    if not state:
        return False
    return state.get("pages_fetched", 0) > 0 or state.get("tokens_used", 0) > 0


def _with_sources(settings, sources):
    """The same settings with the source provider swapped."""
    return type(settings)(
        type(settings.providers)(
            sources=sources,
            extractor=settings.providers.extractor,
            panel=settings.providers.panel,
        ),
        budget=settings.budget,
        timestamp=settings.timestamp,
    )


class _CountingSources:
    """The real source provider with a call counter wrapped around it.

    `name` is delegated as well, so `ProviderBundle.descriptor` is identical to the one
    the checkpoint recorded: this is the same provider being counted rather than a
    substituted one, and the resume's provenance check sees no change.
    """

    def __init__(self, inner) -> None:
        self._inner = inner
        self.discover_calls = 0
        self.fetch_calls = 0

    @property
    def name(self) -> str:
        return self._inner.name

    async def discover(self, creator, *, limit):
        self.discover_calls += 1
        return await self._inner.discover(creator, limit=limit)

    async def fetch(self, candidate):
        self.fetch_calls += 1
        return await self._inner.fetch(candidate)


def test_message_types_are_allow_listed_for_restore() -> None:
    assert "modeltree_updater.messages:CreatorTask" in ALLOWED_CHECKPOINT_TYPES
    assert "modeltree_updater.contracts:ClaimCandidate" in ALLOWED_CHECKPOINT_TYPES


def test_a_checkpoint_directory_inside_the_web_app_is_refused(tmp_path) -> None:
    """The storage factory is the guard's call site, so every caller inherits it."""
    repo_root = tmp_path / "repo"
    dataset = repo_root / "web" / "src" / "data"
    dataset.mkdir(parents=True)

    with pytest.raises(ProposalOnlyViolation):
        create_checkpoint_storage(dataset / "checkpoints")

    assert list(dataset.iterdir()) == []


def test_a_traversal_shaped_checkpoint_directory_is_refused(tmp_path) -> None:
    """`..` is resolved before the boundary is checked, not after."""
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)
    (repo_root / "out").mkdir()

    with pytest.raises(ProposalOnlyViolation):
        create_checkpoint_storage(repo_root / "out" / ".." / "web" / "checkpoints")

    assert not (repo_root / "web" / "checkpoints").exists()


def test_a_checkpoint_directory_outside_the_web_app_is_created(tmp_path) -> None:
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)

    create_checkpoint_storage(repo_root / "out" / "checkpoints")

    assert (repo_root / "out" / "checkpoints").is_dir()


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


def test_resuming_a_mid_run_checkpoint_restores_spend_without_recharging_it(
    tmp_path, library, settings
) -> None:
    """Resume a checkpoint taken *partway through*, so a non-empty ledger is restored.

    The test above resumes the entry checkpoint, which holds the original `CreatorTask`.
    Its `budget_state` is empty, so restoring it replays the whole run from the start
    executor and proves reproducibility-from-input rather than restoration-of-progress.
    Every stage rebuilds its `BudgetLedger` from the message's `budget_state`, and on an
    entry-checkpoint resume that is the trivial, empty case.

    The checkpoint resumed here is chosen by what it records, never by index. Each
    checkpoint's undelivered message is read and the first one whose ledger has already
    charged for work is taken — so if checkpoint numbering or cadence ever changes, this
    either still finds a genuinely mid-run checkpoint or fails saying it could not. It
    cannot quietly degrade into another entry-checkpoint resume. Index would be the wrong
    handle in both directions: the runner also writes a checkpoint after the *final*
    superstep, and that one has nothing left to deliver, so `checkpoints[-1]` would run
    no stage at all.

    Three separate things are then asserted, because equality alone would not prove any
    of them on its own:

    * the restored ledger is non-empty and strictly cheaper than the finished run, so
      there is spend to restore *and* spend still to come — the comparison below has
      something to catch;
    * the resumed run re-read nothing. A resume that replayed the whole run with a reset
      ledger would report exactly the original totals, so the counting provider is what
      separates "continued" from "started over";
    * the totals match the uninterrupted run rather than the sum of the two segments,
      which is the failure that would let a run quietly exceed its limit while every
      counter still looked plausible.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")
    counted = _CountingSources(settings.providers.sources)

    async def scenario():
        original = await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        recorded = []
        for checkpoint in await _list(storage):
            state = await _pending_budget_state(storage, checkpoint.checkpoint_id)
            recorded.append((checkpoint, state))

        mid_run = [
            (checkpoint, state) for checkpoint, state in recorded if _records_spend(state)
        ]
        if not mid_run:
            return original, recorded, None, None, None

        chosen, chosen_state = mid_run[0]
        resumed = await resume_creator_run(
            _with_sources(settings, counted),
            checkpoint_id=chosen.checkpoint_id,
            checkpoint_storage=storage,
        )
        return original, recorded, chosen, chosen_state, resumed

    original, recorded, chosen, chosen_state, resumed = asyncio.run(scenario())

    ledgers = [(checkpoint.iteration_count, state) for checkpoint, state in recorded]
    assert chosen is not None, (
        "no checkpoint holds an undelivered message whose ledger has charged for work, "
        "so there is nothing mid-run to resume and this test would prove only what the "
        f"entry-checkpoint resume above already proves; checkpointed ledgers were {ledgers}"
    )

    # The contrast this test exists for, made concrete rather than assumed.
    entry, entry_state = recorded[0]
    assert entry_state == {}, (
        f"the entry checkpoint carries {entry_state}, not the empty ledger that makes "
        "resuming it the trivial case"
    )
    assert chosen.checkpoint_id != entry.checkpoint_id

    # Non-empty at the point of resume, and partway rather than finished: pages are only
    # charged while extracting and the panel charges tokens after that, so a strictly
    # cheaper ledger means charging work still remains beyond the resume boundary.
    assert 0 < chosen_state["pages_fetched"] <= original.budget.pages_fetched
    assert 0 < chosen_state["tokens_used"] < original.budget.tokens_used, (
        f"the resumed checkpoint records {chosen_state['tokens_used']} of the run's "
        f"{original.budget.tokens_used} token(s), so no charging work remains after it "
        "and the comparison below could not tell a restored ledger from a reset one"
    )

    # Progress was restored, not replayed. Nothing was discovered or read a second time.
    assert counted.discover_calls == 0, (
        f"the resumed run discovered sources {counted.discover_calls} time(s); it "
        "restarted from the beginning instead of continuing from the checkpoint"
    )
    assert counted.fetch_calls == 0, (
        f"the resumed run re-read {counted.fetch_calls} page(s) it had already paid for"
    )

    # Spend crossed the boundary once. `elapsed_seconds` is wall-clock and excluded.
    assert original.status is ProposalStatus.COMPLETE
    assert resumed.status is original.status
    assert resumed.budget.pages_fetched == original.budget.pages_fetched, (
        f"the resumed run reports {resumed.budget.pages_fetched} page(s) against the "
        f"uninterrupted run's {original.budget.pages_fetched}: the restored ledger was "
        "either reset or charged twice"
    )
    assert resumed.budget.tokens_used == original.budget.tokens_used, (
        f"the resumed run reports {resumed.budget.tokens_used} token(s) against the "
        f"uninterrupted run's {original.budget.tokens_used}"
    )
    assert resumed.budget.retries_used == original.budget.retries_used
    assert resumed.budget.exhausted_by == original.budget.exhausted_by
    assert resumed.claims == original.claims
    assert resumed.verdicts == original.verdicts


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
