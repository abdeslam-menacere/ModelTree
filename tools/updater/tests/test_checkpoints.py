"""Runs are durable: state is checkpointed and a run can be resumed."""

from __future__ import annotations

import asyncio
import inspect

import pytest

from modeltree_updater import checkpoints as checkpoints_module
from modeltree_updater import runner as runner_module
from modeltree_updater.checkpoints import (
    ALLOWED_CHECKPOINT_TYPES,
    CHECKPOINT_SCHEMA_VERSION,
    TOOL_VERSION,
    CheckpointVersion,
    create_checkpoint_storage,
    list_checkpoint_summaries,
    load_checkpoint,
    recorded_providers,
    recorded_version_marker,
)
from modeltree_updater.contracts import ProposalStatus
from modeltree_updater.runner import (
    CheckpointVersionMismatch,
    ProviderMismatch,
    resume_creator_run,
    run_creator,
    run_creators,
)
from modeltree_updater.safety import ProposalOnlyViolation
from modeltree_updater.workflow import WORKFLOW_NAME


async def _list(storage):
    checkpoints = storage.list_checkpoints(workflow_name=WORKFLOW_NAME)
    if inspect.isawaitable(checkpoints):
        checkpoints = await checkpoints
    return sorted(checkpoints, key=lambda item: item.iteration_count)


async def _stored_creator_id(storage, checkpoint_id):
    """The creator named by a checkpoint's stored messages, read independently.

    This is the test-local reader #125 had to write to tell one checkpoint from
    another. It is kept here deliberately: the summary is checked against a separate
    reading of the same payload, so the multi-creator assertions below cannot pass by
    agreeing with themselves.
    """
    checkpoint = await load_checkpoint(storage, checkpoint_id)
    if checkpoint is None:
        return None
    for envelopes in (getattr(checkpoint, "messages", None) or {}).values():
        for envelope in envelopes:
            creator = getattr(getattr(envelope, "data", None), "creator", None)
            if creator is not None:
                return creator.creator_id
    return None


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


async def _stored_version_marker(storage, checkpoint_id):
    """The version marker a checkpoint's stored messages carry, read independently.

    A second reading of the same payload, like `_stored_creator_id` above, so the
    assertions below cannot pass merely by agreeing with
    `checkpoints.recorded_version_marker` — the reader under test would otherwise be
    checked against itself.

    `(tool_version, schema_version)` from the first stored message that names either;
    `(None, None)` for a checkpoint that stores messages and no marker; `None` where
    there is nothing to read a marker from at all.
    """
    checkpoint = await load_checkpoint(storage, checkpoint_id)
    if checkpoint is None:
        return None
    stored_a_message = False
    for envelopes in (getattr(checkpoint, "messages", None) or {}).values():
        for envelope in envelopes:
            stored_a_message = True
            data = getattr(envelope, "data", None)
            tool = getattr(data, "tool_version", None)
            schema = getattr(data, "checkpoint_schema_version", None)
            if tool is not None or schema is not None:
                return (tool, schema)
    return (None, None) if stored_a_message else None


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

    Four separate things are then asserted, because no one of them would prove the others:

    * the restored ledger is non-empty, and the resumed run's bill is at least what that
      checkpoint had already charged — measured against the checkpoint's own recorded
      state, so it is the assertion that fires when a ledger comes back empty;
    * the resumed run re-read nothing. A resume that replayed the whole run with a reset
      ledger would report exactly the original totals, so the counting provider is what
      separates "continued" from "started over";
    * the checkpoint is strictly cheaper than the finished run, so charging work genuinely
      remains beyond the boundary and the totals below have something to catch;
    * those totals match the uninterrupted run rather than the sum of the two segments,
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

    # Non-empty at the point of resume. Judged on its own terms, with no reference to the
    # finished run, so this stands even if a regression has moved the live ledger.
    assert chosen_state["pages_fetched"] > 0, (
        f"the checkpoint at iteration {chosen.iteration_count} records "
        f"{chosen_state}, which has paid for no pages"
    )
    assert chosen_state["tokens_used"] > 0

    # The resume boundary itself: work the checkpoint had already paid for is still on
    # the bill afterwards. Compared against the checkpoint's *own* recorded ledger rather
    # than against the finished run, because that is the number a reset ledger loses and
    # it cannot be moved by whatever the live ledger is doing.
    assert resumed.budget.pages_fetched >= chosen_state["pages_fetched"], (
        f"the resumed run reports {resumed.budget.pages_fetched} page(s) but the "
        f"checkpoint it restored had already charged {chosen_state['pages_fetched']}: "
        "the ledger came back empty, so pages already paid for can be spent again"
    )
    assert resumed.budget.tokens_used >= chosen_state["tokens_used"], (
        f"the resumed run reports {resumed.budget.tokens_used} token(s) but the "
        f"checkpoint it restored had already charged {chosen_state['tokens_used']}"
    )

    # Progress was restored, not replayed. Nothing was discovered or read a second time.
    assert counted.discover_calls == 0, (
        f"the resumed run discovered sources {counted.discover_calls} time(s); it "
        "restarted from the beginning instead of continuing from the checkpoint"
    )
    assert counted.fetch_calls == 0, (
        f"the resumed run re-read {counted.fetch_calls} page(s) it had already paid for"
    )

    # Partway rather than finished: pages are only charged while extracting and the panel
    # charges tokens after that, so a strictly cheaper ledger means charging work still
    # remains beyond the resume boundary and the equalities below have something to catch.
    assert chosen_state["pages_fetched"] <= original.budget.pages_fetched
    assert chosen_state["tokens_used"] < original.budget.tokens_used, (
        f"the resumed checkpoint records {chosen_state['tokens_used']} of the run's "
        f"{original.budget.tokens_used} token(s), so no charging work remains after it "
        "and the comparison below could not tell a restored ledger from a reset one"
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


def test_a_multi_creator_run_names_the_creator_on_every_checkpoint_row(
    tmp_path, library, settings
) -> None:
    """The listing has to tell four creators apart, because one run produces all four.

    `run_creators` writes every creator's checkpoints into the same storage, so this is
    the case the summary exists to serve and the single-creator run cannot catch: with
    one creator every row trivially names the only creator there is, and a reader that
    returned a constant, the first creator it ever saw, or the wrong message's creator
    would still pass.

    Each row is checked against a *separate* reading of the same stored payload rather
    than against the creator list, so a row is wrong if it names a creator other than
    the one its own checkpoint recorded — not merely if it names one that was not in
    the run.
    """
    creator_ids = ["contoso-ai", "fabrikam-ai", "northwind-ai", "litware-ai"]
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def scenario():
        report = await run_creators(
            [library.creators[creator_id] for creator_id in creator_ids],
            settings,
            run_id="run-multi",
            checkpoint_storage=storage,
        )
        summaries = await list_checkpoint_summaries(storage, workflow_name=WORKFLOW_NAME)
        stored = [
            await _stored_creator_id(storage, summary["checkpoint_id"])
            for summary in summaries
        ]
        return report, summaries, stored

    report, summaries, stored = asyncio.run(scenario())

    assert [proposal.creator_id for proposal in report.proposals] == creator_ids
    assert summaries

    # Row by row: the summary names the creator that row's own checkpoint recorded.
    mismatched = [
        (summary["checkpoint_id"], summary["creator_id"], recorded)
        for summary, recorded in zip(summaries, stored)
        if summary["creator_id"] != recorded
    ]
    assert not mismatched, (
        "these rows name a creator other than the one their checkpoint stored "
        f"(checkpoint_id, summary, stored): {mismatched}"
    )

    named = [summary["creator_id"] for summary in summaries if summary["creator_id"]]
    assert set(named) == set(creator_ids), (
        f"the listing names {sorted(set(named))} after a run of {sorted(creator_ids)}: "
        "an operator cannot map every row back to the creator it belongs to"
    )
    # Distinguishable in both directions: every creator is reachable, and no creator
    # has swallowed the listing.
    assert all(named.count(creator_id) > 0 for creator_id in creator_ids)
    assert len(set(named)) == len(creator_ids)

    # Additive, and the order the command promises is untouched.
    expected_keys = {
        "checkpoint_id",
        "creator_id",
        "workflow_id",
        "iteration",
        "timestamp",
    }
    assert all(set(summary) == expected_keys for summary in summaries)
    assert [summary["iteration"] for summary in summaries] == sorted(
        summary["iteration"] for summary in summaries
    )


def test_a_checkpoint_with_no_creator_identity_lists_as_unknown() -> None:
    """A checkpoint that names no creator degrades to `None`; it never breaks the list.

    Three shapes that carry no creator, listed alongside one that does. The first is
    what an older checkpoint looks like to this reader — a stored message whose data
    has no creator on it at all — and it must not take the listing down with it. The
    second is the checkpoint the runner writes after the final superstep, which has
    nothing left to deliver and so records no message to read. The third is a payload
    this reader cannot make sense of.

    The row that *can* be named is in the same listing on purpose: it fails if the
    unreadable neighbours have been made safe by giving up on all of them.
    """

    class _Envelope:
        def __init__(self, data):
            self.data = data

    class _NoCreator:
        budget_state = {}

    class _Creator:
        creator_id = "contoso-ai"

    class _WithCreator:
        creator = _Creator()

    class _Checkpoint:
        def __init__(self, checkpoint_id, iteration_count, messages):
            self.checkpoint_id = checkpoint_id
            self.iteration_count = iteration_count
            self.messages = messages
            self.timestamp = "2026-06-01T00:00:00+00:00"

    class _Storage:
        def list_checkpoints(self, *, workflow_name):
            return [
                _Checkpoint("legacy", 0, {"discover-sources": [_Envelope(_NoCreator())]}),
                _Checkpoint("terminal", 1, {}),
                _Checkpoint("unreadable", 2, ["not-a-mapping"]),
                _Checkpoint("named", 3, {"extract-claims": [_Envelope(_WithCreator())]}),
            ]

    summaries = asyncio.run(
        list_checkpoint_summaries(_Storage(), workflow_name=WORKFLOW_NAME)
    )

    assert [summary["checkpoint_id"] for summary in summaries] == [
        "legacy",
        "terminal",
        "unreadable",
        "named",
    ]
    assert [summary["creator_id"] for summary in summaries] == [
        None,
        None,
        None,
        "contoso-ai",
    ]
    # Unknown, not absent: the key is there to be read either way.
    assert all("creator_id" in summary for summary in summaries)


def test_every_checkpoint_a_run_writes_names_the_build_that_wrote_it(
    tmp_path, library, settings
) -> None:
    """The marker reaches every checkpoint, not just the entry one.

    The entry checkpoint holds the `CreatorTask` the runner stamps directly, so it
    would carry the marker even if no stage forwarded it. The mid-run checkpoints are
    the ones that would go unmarked if `DiscoveredSources`, `ExtractedClaims` or
    `ReviewedClaims` dropped the fields — and those are exactly the checkpoints worth
    resuming, so a marker that only reached the entry one would leave the resumes
    that matter refusing themselves as legacy.

    Each checkpoint is read twice: once through `recorded_version_marker`, and once
    through a separate walk of the same stored payload, so this cannot pass by the
    reader agreeing with itself. Checkpoints that store no message at all are
    excluded rather than asserted about — the runner writes one after the final
    superstep, it has nothing left to deliver, and there is no message in it to carry
    a marker.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def scenario():
        await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        rows = []
        for checkpoint in await _list(storage):
            rows.append(
                (
                    checkpoint.checkpoint_id,
                    await _stored_version_marker(storage, checkpoint.checkpoint_id),
                    await recorded_version_marker(storage, checkpoint.checkpoint_id),
                )
            )
        return rows

    rows = asyncio.run(scenario())

    assert rows, "the run wrote no checkpoints, so there is nothing to check"

    with_messages = [row for row in rows if row[1] is not None]
    assert len(with_messages) > 1, (
        "only one checkpoint stores a message, so this cannot tell a marker that was "
        f"forwarded through the stages from one that was only stamped at the start: {rows}"
    )

    unmarked = [
        (checkpoint_id, stored) for checkpoint_id, stored, _ in with_messages if stored == (None, None)
    ]
    assert not unmarked, (
        "these checkpoints store a message that names no tool or schema version, so "
        f"resuming them would be refused as legacy state: {unmarked}"
    )

    # The stored value is the build's own, and the production reader agrees with the
    # independent walk on every row.
    for checkpoint_id, stored, read in with_messages:
        assert stored == (TOOL_VERSION, CHECKPOINT_SCHEMA_VERSION), (
            f"{checkpoint_id} records {stored}, not this build's "
            f"{(TOOL_VERSION, CHECKPOINT_SCHEMA_VERSION)}"
        )
        assert read == CheckpointVersion(TOOL_VERSION, CHECKPOINT_SCHEMA_VERSION), (
            f"{checkpoint_id}: the reader returned {read} where the stored payload "
            f"says {stored}"
        )


def test_resuming_a_checkpoint_this_build_wrote_is_unaffected(
    tmp_path, library, settings
) -> None:
    """Regression pin, not new coverage: the normal path gains no friction.

    This passes against the code before the version check existed as well as after,
    because resuming a checkpoint you just wrote has always worked. It is here to
    catch the version check turning into a refusal on the path it is supposed to
    leave alone — a marker compared against the wrong thing, or an equality that is
    never satisfiable, would make every resume fail and every other test in this file
    would still be able to pass.
    """
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
        return original, resumed

    original, resumed = asyncio.run(scenario())

    assert resumed.status is ProposalStatus.COMPLETE
    assert resumed.claims == original.claims


def test_resuming_a_checkpoint_written_by_a_different_tool_version_is_refused(
    tmp_path, library, settings, monkeypatch
) -> None:
    """A build change across a resume stops the run; it does not warn and continue.

    The checkpoint is written by this build and then read by a *different* one, which
    is simulated by moving the reading build's version rather than by editing stored
    state: rewriting the checkpoint would test the edit, not the check.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def write():
        await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        return (await _list(storage))[0].checkpoint_id

    checkpoint_id = asyncio.run(write())

    monkeypatch.setattr(checkpoints_module, "TOOL_VERSION", "99.0.0")

    with pytest.raises(CheckpointVersionMismatch) as error:
        asyncio.run(
            resume_creator_run(
                settings, checkpoint_id=checkpoint_id, checkpoint_storage=storage
            )
        )

    message = str(error.value)
    assert error.value.recorded == CheckpointVersion(TOOL_VERSION, CHECKPOINT_SCHEMA_VERSION)
    assert error.value.reading == CheckpointVersion("99.0.0", CHECKPOINT_SCHEMA_VERSION)
    assert error.value.retryable is False
    # Actionable means an operator can tell from the message alone what wrote the
    # checkpoint, what is reading it, which number moved, and what to do next.
    assert TOOL_VERSION in message and "99.0.0" in message
    assert "tool version differs" in message
    assert "schema version differs" not in message
    assert "start this creator again" in message.lower()


def test_resuming_a_checkpoint_written_under_a_different_schema_version_is_refused(
    tmp_path, library, settings, monkeypatch
) -> None:
    """The schema version refuses on its own, with the tool version identical.

    Two numbers are recorded because they answer different questions, and this is the
    half a single combined marker would lose: the same release can change the shape
    of the checkpointed state, and a check that only compared tool versions would
    resume straight into it.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def write():
        await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        return (await _list(storage))[0].checkpoint_id

    checkpoint_id = asyncio.run(write())

    monkeypatch.setattr(
        checkpoints_module, "CHECKPOINT_SCHEMA_VERSION", CHECKPOINT_SCHEMA_VERSION + 1
    )

    with pytest.raises(CheckpointVersionMismatch) as error:
        asyncio.run(
            resume_creator_run(
                settings, checkpoint_id=checkpoint_id, checkpoint_storage=storage
            )
        )

    message = str(error.value)
    assert error.value.recorded.schema_version == CHECKPOINT_SCHEMA_VERSION
    assert error.value.reading.schema_version == CHECKPOINT_SCHEMA_VERSION + 1
    assert error.value.recorded.tool_version == error.value.reading.tool_version
    assert "schema version differs" in message
    assert "tool version differs" not in message


def test_a_refusal_names_both_versions_when_both_moved(
    tmp_path, library, settings, monkeypatch
) -> None:
    """Both numbers moving is reported as both, not as whichever was checked first.

    The two mismatches above each leave the other number equal, so either could pass
    against a refusal that stopped at the first difference it found and named only
    that one. An operator reading such a message would upgrade or downgrade one
    version and get the same refusal again for a reason nobody had mentioned.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def write():
        await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        return (await _list(storage))[0].checkpoint_id

    checkpoint_id = asyncio.run(write())

    monkeypatch.setattr(checkpoints_module, "TOOL_VERSION", "99.0.0")
    monkeypatch.setattr(
        checkpoints_module, "CHECKPOINT_SCHEMA_VERSION", CHECKPOINT_SCHEMA_VERSION + 1
    )

    with pytest.raises(CheckpointVersionMismatch) as error:
        asyncio.run(
            resume_creator_run(
                settings, checkpoint_id=checkpoint_id, checkpoint_storage=storage
            )
        )

    message = str(error.value)
    assert "tool version differs" in message
    assert "schema version differs" in message


def test_resuming_a_checkpoint_that_records_no_version_is_refused(
    tmp_path, library, settings, monkeypatch
) -> None:
    """An unmarked checkpoint is refused. Absence is not the permissive branch.

    This is the decision the change had to make explicitly rather than fall into.
    State written before the marker existed cannot be *shown* to have been written by
    the build now reading it, and "cannot be shown to match" must not resolve to
    "proceed" merely because the evidence is missing. The unmarked checkpoints that
    can exist are the ones ADR 0002 names in its residual — written when
    `--long-tail-profile` still took a filesystem path, so they carry an id from a
    document the reviewed set never saw. Admitting them as legacy would keep open the
    hole this change exists to close.

    The pre-marker build is simulated at the point it differs: it stamped nothing.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    monkeypatch.setattr(runner_module, "TOOL_VERSION", None)
    monkeypatch.setattr(runner_module, "CHECKPOINT_SCHEMA_VERSION", None)

    async def write_unmarked():
        await run_creator(
            library.creators["contoso-ai"],
            settings,
            run_id="run-test",
            checkpoint_storage=storage,
        )
        checkpoint_id = (await _list(storage))[0].checkpoint_id
        return checkpoint_id, await _stored_version_marker(storage, checkpoint_id)

    checkpoint_id, stored = asyncio.run(write_unmarked())

    # The scenario is what it claims to be: this checkpoint really carries no marker.
    assert stored == (None, None), (
        f"the simulated pre-marker run still stamped {stored}, so this test would be "
        "exercising a mismatch rather than an absence"
    )

    monkeypatch.undo()

    with pytest.raises(CheckpointVersionMismatch) as error:
        asyncio.run(
            resume_creator_run(
                settings, checkpoint_id=checkpoint_id, checkpoint_storage=storage
            )
        )

    message = str(error.value)
    assert error.value.recorded == CheckpointVersion(None, None)
    assert error.value.recorded.is_marked is False
    assert error.value.retryable is False
    assert "no tool or checkpoint schema version" in message
    assert "predates the version marker" in message
    assert "start this creator again" in message.lower()
