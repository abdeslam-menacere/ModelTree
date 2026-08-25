"""The four pilot creators run offline through the recorded review path.

Each pilot fixture is a synthetic, offline exercise (RFC 2606 reserved hosts, invented
model names — the real seeds live in profiles/<id>.json). A run of each must produce
claim candidates, send exactly one newly discovered source through the recorded 2-of-3
approval path, and leave at least one unknown/conflict explicit as needs-human-review.
The pilot creator ids line up with the version-controlled profiles.

The tests above the divider run each pilot on its own. The ones below drive all four
through `run_creators` — the *multi-creator* path — in a single invocation, because
"processes the four pilot creators independently and resumes from checkpoints" is a
statement about the orchestration, and a `for` loop over four separate single-creator
runs does not exercise it. Independence has three parts and each is asserted rather
than implied: each creator gets its own budget, one creator crashing leaves the others
byte-identical, and a creator's checkpoint can be resumed out of a storage that four
creators share.
"""

from __future__ import annotations

import asyncio
import inspect

from modeltree_updater.checkpoints import create_checkpoint_storage, load_checkpoint
from modeltree_updater.contracts import ClaimDecision, FailureKind, ProposalStatus
from modeltree_updater.profiles import load_profile_library
from modeltree_updater.review import MAJORITY
from modeltree_updater.runner import resume_creator_run, run_creator, run_creators
from modeltree_updater.workflow import WORKFLOW_NAME

PILOT_CREATORS = ("openai", "anthropic", "google-deepmind", "meta")

# A middle creator, so both a creator before it and creators after it are covered.
FAILING_PILOT = "google-deepmind"
# Deliberately not the first creator in the run: resuming the first one would not
# show that the checkpoint was located by whose it is rather than by ordering.
RESUMED_PILOT = "anthropic"

GROUP_RUN_ID = "run-pilots"


def _run(creator_id, library, settings):
    return asyncio.run(run_creator(library.creators[creator_id], settings, run_id="run-" + creator_id))


def test_every_pilot_creator_has_a_matching_profile(library) -> None:
    profiles = load_profile_library()
    for creator_id in PILOT_CREATORS:
        assert creator_id in library.creators, f"missing pilot fixture for {creator_id}"
        assert creator_id in profiles.creator_ids, f"missing profile for {creator_id}"


def test_each_pilot_run_produces_claim_candidates(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        assert proposal.claims, f"{creator_id} produced no claim candidates"


def test_each_pilot_sends_one_discovery_through_the_recorded_review_path(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        discovered = [a for a in proposal.source_approvals if a.newly_discovered]
        assert len(discovered) == 1, f"{creator_id} should have exactly one discovery"
        approval = discovered[0]
        # It went through the 2-of-3 panel and a majority approved it — recorded, not
        # asserted: three lens verdicts and a majority of accepts.
        assert approval.approved is True
        assert len(approval.verdicts) == 3
        assert approval.accept_votes >= MAJORITY


def test_each_pilot_leaves_an_unknown_or_conflict_explicit(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        unresolved = [
            adjudication
            for adjudication in proposal.adjudications
            if adjudication.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
        ]
        assert unresolved, f"{creator_id} smoothed over its unknown/conflict"


def test_a_configured_source_needs_no_discovery_vote(library, settings) -> None:
    for creator_id in PILOT_CREATORS:
        proposal = _run(creator_id, library, settings)
        configured = [a for a in proposal.source_approvals if not a.newly_discovered]
        assert configured, f"{creator_id} has no configured source"
        assert all(approval.approved for approval in configured)


# --- The multi-creator path -------------------------------------------------


def _run_pilots(library, settings, *, checkpoint_storage=None):
    """All four pilots through `run_creators` — one invocation, not a loop of runs."""
    return asyncio.run(
        run_creators(
            [library.creators[creator_id] for creator_id in PILOT_CREATORS],
            settings,
            run_id=GROUP_RUN_ID,
            checkpoint_storage=checkpoint_storage,
        )
    )


def _by_creator(report):
    return {proposal.creator_id: proposal for proposal in report.proposals}


def _spend(usage):
    """The deterministic half of a budget snapshot.

    `elapsed_seconds` is wall-clock and would make any equality assertion flaky;
    everything else is a counter the run either charged or did not.
    """
    return (usage.pages_fetched, usage.tokens_used, usage.retries_used, usage.exhausted_by)


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


class _ExplodesForOnePilot:
    """Crashes for exactly one creator and delegates for every other one.

    The crash is deliberately *not* a `ProviderError`: the retry path handles those,
    and what needs proving here is that a creator failing outside the provider
    contract still does not sink the creators around it.
    """

    name = "explodes-for-one-pilot:sources"

    def __init__(self, inner, creator_id: str) -> None:
        self._inner = inner
        self._creator_id = creator_id

    async def discover(self, creator, *, limit):
        if creator.creator_id == self._creator_id:
            raise MemoryError(f"provider crashed for {self._creator_id}")
        return await self._inner.discover(creator, limit=limit)

    async def fetch(self, candidate):
        return await self._inner.fetch(candidate)


async def _checkpoints(storage):
    listed = storage.list_checkpoints(workflow_name=WORKFLOW_NAME)
    if inspect.isawaitable(listed):
        listed = await listed
    return sorted(listed, key=lambda item: item.iteration_count)


async def _checkpoint_creator_id(storage, checkpoint_id):
    """Which creator a checkpoint belongs to, read out of the checkpoint itself.

    Mirrors how `checkpoints.recorded_providers` reads provenance. A multi-creator
    run puts every creator's checkpoints into one storage, so the creator has to
    come from the stored message rather than from the order they were written in.
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


def test_all_four_pilots_go_through_the_multi_creator_path_in_one_run(
    library, settings
) -> None:
    """One `run_creators` call over all four pilots, each with its own proposal."""
    report = _run_pilots(library, settings)

    assert tuple(proposal.creator_id for proposal in report.proposals) == PILOT_CREATORS

    for proposal in report.proposals:
        assert proposal.run_id == GROUP_RUN_ID
        assert proposal.status is not ProposalStatus.FAILED, f"{proposal.creator_id} failed"
        assert proposal.claims, f"{proposal.creator_id} produced no claim candidates"
        # Nothing leaked between creators: a proposal carries only its own.
        assert all(claim.creator_id == proposal.creator_id for claim in proposal.claims)
        assert all(source.creator_id == proposal.creator_id for source in proposal.sources)

    assert report.failed_creator_ids == ()


def test_the_pilots_get_their_own_budget_rather_than_sharing_one(library, settings) -> None:
    """`run_creators` gives each creator its own budget; only the *limits* are shared.

    `settings.budget` is a frozen `CreatorBudget` holding limits and no counters.
    Spending lives in a `BudgetLedger` that every stage rebuilds from the message's
    `budget_state`, and each creator starts a fresh `CreatorTask` whose `budget_state`
    defaults to empty — so usage never crosses a creator boundary.

    Asserted rather than left implied, because a silently shared page budget would
    make "independently" false in a way nothing else here would catch: the four
    pilots together read more pages than the per-creator page limit allows, so a
    shared ledger would have run out partway through and truncated the later
    creators instead of every one of them completing on a full allowance.
    """
    report = _run_pilots(library, settings)

    for proposal in report.proposals:
        usage = proposal.budget
        # Each creator is judged against the whole limit, not a share of it.
        assert usage.max_pages == settings.budget.max_pages
        assert usage.max_tokens == settings.budget.max_tokens
        assert usage.exhausted_by == (), f"{proposal.creator_id} ran out of budget"
        assert usage.pages_fetched == len(proposal.sources)
        assert 0 < usage.tokens_used <= settings.budget.max_tokens

    total_pages = sum(proposal.budget.pages_fetched for proposal in report.proposals)
    assert total_pages > settings.budget.max_pages, (
        f"{total_pages} page(s) across the pilots does not exceed the per-creator "
        f"limit of {settings.budget.max_pages}, so this run cannot tell a per-creator "
        "budget apart from a shared one"
    )


def test_a_pilot_in_a_group_run_matches_the_same_pilot_run_alone(
    library, settings_factory
) -> None:
    """The strongest reading of "independently": being in a group changes nothing.

    Each solo run gets pristine settings, so anything the group run had carried
    across creators would show up here as a difference.
    """
    grouped = _by_creator(_run_pilots(library, settings_factory()))

    for creator_id in PILOT_CREATORS:
        solo = asyncio.run(
            run_creator(library.creators[creator_id], settings_factory(), run_id=GROUP_RUN_ID)
        )
        alongside = grouped[creator_id]

        assert alongside.status is solo.status
        assert alongside.sources == solo.sources
        assert alongside.claims == solo.claims
        assert alongside.verdicts == solo.verdicts
        assert alongside.adjudications == solo.adjudications
        assert alongside.source_approvals == solo.source_approvals
        assert alongside.conflicts == solo.conflicts
        assert _spend(alongside.budget) == _spend(solo.budget)


def test_one_failing_pilot_leaves_the_other_three_untouched(
    library, settings_factory
) -> None:
    """Per-creator failure isolation, over the pilots rather than fixture creators."""
    healthy = _by_creator(_run_pilots(library, settings_factory()))

    working = settings_factory()
    report = _run_pilots(
        library,
        _with_sources(working, _ExplodesForOnePilot(working.providers.sources, FAILING_PILOT)),
    )
    proposals = _by_creator(report)

    # The failure is explicit rather than an aborted run or an empty success.
    assert report.failed_creator_ids == (FAILING_PILOT,)
    assert FAILING_PILOT not in report.incomplete_creator_ids
    assert proposals[FAILING_PILOT].claims == ()
    assert proposals[FAILING_PILOT].failures[0].kind is FailureKind.INTERNAL_ERROR

    for creator_id in PILOT_CREATORS:
        if creator_id == FAILING_PILOT:
            continue
        survivor = proposals[creator_id]
        assert survivor.status is healthy[creator_id].status
        assert survivor.claims == healthy[creator_id].claims
        assert survivor.verdicts == healthy[creator_id].verdicts
        assert survivor.adjudications == healthy[creator_id].adjudications
        assert _spend(survivor.budget) == _spend(healthy[creator_id].budget)


def test_a_pilot_is_checkpointed_and_resumed_inside_a_multi_creator_run(
    tmp_path, library, settings
) -> None:
    """A pilot resumes from a checkpoint written during a four-creator run.

    Asserts the same round-trip `test_checkpoints.py` asserts for fixture creators —
    the resumed proposal reproduces the original's claims and verdicts — but from a
    storage four creators wrote to, which is the shape a real multi-creator run
    leaves behind.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def scenario():
        report = await run_creators(
            [library.creators[creator_id] for creator_id in PILOT_CREATORS],
            settings,
            run_id=GROUP_RUN_ID,
            checkpoint_storage=storage,
        )
        owned = []
        for checkpoint in await _checkpoints(storage):
            creator_id = await _checkpoint_creator_id(storage, checkpoint.checkpoint_id)
            if creator_id == RESUMED_PILOT:
                owned.append(checkpoint)
        if not owned:
            return report, owned, None
        resumed = await resume_creator_run(
            settings,
            checkpoint_id=owned[0].checkpoint_id,
            checkpoint_storage=storage,
        )
        return report, owned, resumed

    report, owned, resumed = asyncio.run(scenario())

    assert owned, f"the multi-creator run wrote no checkpoint for {RESUMED_PILOT}"
    original = _by_creator(report)[RESUMED_PILOT]
    assert resumed.creator_id == RESUMED_PILOT
    assert resumed.status is original.status
    assert resumed.claims == original.claims
    assert resumed.verdicts == original.verdicts
