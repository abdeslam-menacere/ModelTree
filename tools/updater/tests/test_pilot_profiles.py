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
runs does not exercise it. Independence has four parts and each is asserted rather
than implied: each creator gets its own budget, one creator crashing outside the
provider contract leaves the others byte-identical, one creator being refused *inside*
the contract ends that creator partial rather than failed and likewise leaves the
others byte-identical, and a creator's checkpoint can be resumed out of a storage that
four creators share.
"""

from __future__ import annotations

import asyncio
import inspect

from modeltree_updater.checkpoints import (
    create_checkpoint_storage,
    load_checkpoint,
    recorded_creator_id,
)
from modeltree_updater.contracts import (
    ClaimDecision,
    FailureKind,
    ProposalStatus,
    WorkflowStage,
)
from modeltree_updater.profiles import load_profile_library
from modeltree_updater.providers.base import ProviderError
from modeltree_updater.review import MAJORITY
from modeltree_updater.runner import resume_creator_run, run_creator, run_creators
from modeltree_updater.workflow import WORKFLOW_NAME

PILOT_CREATORS = ("openai", "anthropic", "google-deepmind", "meta")

# A middle creator, so both a creator before it and creators after it are covered.
FAILING_PILOT = "google-deepmind"
# One configured source of that same pilot, refused rather than crashed. Not the
# newly discovered one: the discovery is what the recorded 2-of-3 path above the
# divider exercises, and refusing it would change two things at once.
REFUSED_SOURCE = "google-deepmind-fixture-unknown-max-output"
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


class _RefusesOneSourceForOnePilot:
    """Refuses one source of one creator *inside* the provider contract.

    The sibling of `_ExplodesForOnePilot`, and deliberately the opposite shape: a
    retryable `ProviderError` is what an unreachable source, a rate limit, or a
    refused fetch actually looks like, so the retry path handles it and the creator
    keeps the sources it did read. Only one of this pilot's three sources is refused,
    which is what makes the outcome partial rather than empty — a creator that lost
    everything would end `FAILED` for a different reason and prove nothing about the
    in-contract path.

    Counts its own calls so the test can check the provider was really reached the
    number of times the retry budget allows, independently of the ledger.
    """

    name = "refuses-one-source-for-one-pilot:sources"

    def __init__(self, inner, creator_id: str, source_id: str) -> None:
        self._inner = inner
        self._creator_id = creator_id
        self._source_id = source_id
        self.attempts = 0

    async def discover(self, creator, *, limit):
        return await self._inner.discover(creator, limit=limit)

    async def fetch(self, candidate):
        if candidate.creator_id == self._creator_id and candidate.id == self._source_id:
            self.attempts += 1
            raise ProviderError(
                f"{self._source_id} is unreachable",
                provider=self.name,
                retryable=True,
            )
        return await self._inner.fetch(candidate)


async def _checkpoints(storage):
    listed = storage.list_checkpoints(workflow_name=WORKFLOW_NAME)
    if inspect.isawaitable(listed):
        listed = await listed
    return sorted(listed, key=lambda item: item.iteration_count)


async def _checkpoint_creator_id(storage, checkpoint_id):
    """Which creator a checkpoint belongs to, read out of the checkpoint itself.

    Delegates to production `checkpoints.recorded_creator_id` rather than restating
    it: a multi-creator run puts every creator's checkpoints into one storage, and
    the property these tests assert — that a checkpoint resolves to the creator it
    recorded — is the production rule, so it must be checked through that rule and
    not a hand-copied variant of it (issue #221). Production tolerates a malformed
    payload by returning `None` instead of raising a bare `AttributeError`.
    """
    checkpoint = await load_checkpoint(storage, checkpoint_id)
    if checkpoint is None:
        return None
    return recorded_creator_id(checkpoint)


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


def test_a_pilot_refused_in_contract_ends_incomplete_and_spares_the_other_three(
    library, settings_factory
) -> None:
    """The in-contract sibling of the crash above: refused, retried, partial.

    `MemoryError` proves what happens when a provider breaks its contract. This
    proves the commoner case where it keeps it — a source is unreachable, the retry
    budget is spent on it, and the creator ends `INCOMPLETE` with the sources it did
    read rather than `FAILED` with nothing. `contracts.py` branches on that status,
    so calling partial progress a failure would lose the claims the run did make.

    Status alone would not establish this: a run that never retried at all also ends
    `INCOMPLETE`, and so does a healthy pilot with an open conflict. The retry
    counter in the budget ledger is the assertion that moves only if the retry path
    genuinely ran — it is 0 for this same pilot in the healthy baseline below.
    """
    healthy = _by_creator(_run_pilots(library, settings_factory()))
    baseline = healthy[FAILING_PILOT]
    max_retries = settings_factory().budget.max_retries

    # The premise: the refused source is one this pilot actually reads. Without it a
    # renamed fixture would leave nothing to refuse and every assertion below would
    # be measuring an ordinary healthy run.
    assert REFUSED_SOURCE in [source.id for source in baseline.sources]
    assert baseline.budget.retries_used == 0
    assert max_retries > 0

    working = settings_factory()
    refusing = _RefusesOneSourceForOnePilot(
        working.providers.sources, FAILING_PILOT, REFUSED_SOURCE
    )
    report = _run_pilots(library, _with_sources(working, refusing))
    proposals = _by_creator(report)
    refused = proposals[FAILING_PILOT]

    # The retry path ran and then gave up, rather than never running: the provider
    # was called once more than the retry budget allows, the ledger charged every
    # retry, and the run stopped because retries — not pages or tokens — ran out.
    assert refusing.attempts == max_retries + 1
    assert refused.budget.retries_used == max_retries
    assert "retries" in refused.budget.exhausted_by
    assert any(
        failure.kind is FailureKind.BUDGET_EXHAUSTED
        and failure.detail.get("resource") == "retries"
        for failure in refused.failures
    ), "the run did not stop because it ran out of retries"

    # Every refusal is recorded as a retryable provider failure at the stage that
    # read the page — not swallowed, and not the internal error a crash produces.
    refusals = [
        failure
        for failure in refused.failures
        if failure.detail.get("provider") == refusing.name
    ]
    assert len(refusals) == max_retries + 1
    assert all(failure.kind is FailureKind.PROVIDER_FAILURE for failure in refusals)
    assert all(failure.retryable for failure in refusals)
    assert all(failure.stage is WorkflowStage.EXTRACT for failure in refusals)
    assert all(
        failure.kind is not FailureKind.INTERNAL_ERROR for failure in refused.failures
    )

    # Partial, and explicitly so: the refused source is gone, the ones around it are
    # not, and the claims they carried survived.
    assert refused.status is ProposalStatus.INCOMPLETE
    assert report.failed_creator_ids == ()
    assert FAILING_PILOT in report.incomplete_creator_ids
    assert [source.id for source in refused.sources] == [
        source.id for source in baseline.sources if source.id != REFUSED_SOURCE
    ]
    assert 0 < len(refused.claims) < len(baseline.claims)

    # And the other three pilots are untouched, exactly as for the crash.
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

    That "four creators wrote to it" is the premise the rest of the test rests on,
    so it is asserted rather than left true by construction. Nothing downstream can
    see it: `owned` is the *filtered* view, so a regression that stopped
    checkpointing the other three creators would leave `resumed.creator_id`,
    `.status`, `.claims` and `.verdicts` all still true while this test quietly
    became indistinguishable from a single-creator one.
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
        # Every creator the shared storage can be shown to hold a checkpoint for,
        # collected from the same unfiltered walk that `owned` is narrowed out of.
        # `None` is the checkpoint written after the final superstep, which has no
        # message left to name a creator — see `checkpoints.recorded_creator_id`.
        attributed = set()
        for checkpoint in await _checkpoints(storage):
            creator_id = await _checkpoint_creator_id(storage, checkpoint.checkpoint_id)
            if creator_id is not None:
                attributed.add(creator_id)
            if creator_id == RESUMED_PILOT:
                owned.append(checkpoint)
        if not owned:
            return report, owned, attributed, None
        resumed = await resume_creator_run(
            settings,
            checkpoint_id=owned[0].checkpoint_id,
            checkpoint_storage=storage,
        )
        return report, owned, attributed, resumed

    report, owned, attributed, resumed = asyncio.run(scenario())

    # The premise, asserted against the unfiltered storage before the filtered
    # `owned` is relied on for anything.
    #
    # All four rather than "at least two", because all four completing is what this
    # run actually establishes — `test_all_four_pilots_go_through_the_multi_creator_path_in_one_run`
    # asserts `failed_creator_ids == ()` over the same call — so "at least two" would
    # still pass a regression that stopped checkpointing two of the four.
    #
    # The *set* rather than a count: four checkpoints belonging to one creator
    # satisfy a count, which is this same weakness one level down.
    assert attributed == set(PILOT_CREATORS), (
        f"the shared storage holds checkpoints for {sorted(attributed)}, not for all "
        f"four pilots {sorted(PILOT_CREATORS)}, so this is not the multi-creator run "
        f"the rest of this test reads it as — and {len(owned)} checkpoint(s) for "
        f"{RESUMED_PILOT} were still found, which is exactly why no assertion below "
        "can catch it"
    )

    assert owned, f"the multi-creator run wrote no checkpoint for {RESUMED_PILOT}"
    original = _by_creator(report)[RESUMED_PILOT]
    assert resumed.creator_id == RESUMED_PILOT
    assert resumed.status is original.status
    assert resumed.claims == original.claims
    assert resumed.verdicts == original.verdicts
