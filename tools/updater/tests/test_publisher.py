"""Publication: what counts as material, what identifies a proposal, what the
issue body has to say, and what must never happen.

Every test here runs offline against a fake issues client.
"""

from __future__ import annotations

import asyncio
import dataclasses
import re

import pytest

from modeltree_updater.budgets import CreatorBudget
from modeltree_updater.checkpoints import (
    create_checkpoint_storage,
    list_checkpoint_summaries,
)
from modeltree_updater.contracts import FailureKind, ProposalStatus
from modeltree_updater.github_issues import MAX_BODY_CHARS, Issue
from modeltree_updater.parsing import proposal_from_dict
from modeltree_updater.publisher import (
    UNREADABLE_RUN,
    PublicationAction,
    PublicationError,
    find_open_proposals,
    identity_marker,
    is_material,
    issue_title,
    matches_identity,
    publish_proposal,
    publish_report,
    read_state,
    render_body,
    render_issue,
    state_marker,
)
from modeltree_updater.runner import resume_creator_run, run_creator
from modeltree_updater.workflow import WORKFLOW_NAME

MATERIAL = "contoso-ai"
INCOMPLETE = "fabrikam-ai"
QUIET = "quiet-ai"


def _issue(number: int, body: str, *, state: str = "open") -> Issue:
    return Issue(number=number, title="whatever", body=body, state=state)


# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------


def test_the_marker_is_the_first_line_of_the_body(proposal_factory) -> None:
    body = render_body(proposal_factory(MATERIAL))

    assert body.splitlines()[0] == identity_marker(MATERIAL)


def test_identity_is_anchored_to_the_first_line_only() -> None:
    """The regression this issue's first attempt shipped.

    Rendered bodies contain quotes from fetched pages, so marker-shaped text can
    appear anywhere in the content. Only line one is identity.
    """
    marker = identity_marker(MATERIAL)

    assert matches_identity(marker + "\n\nbody", MATERIAL)
    assert matches_identity(marker + "\r\nbody", MATERIAL)
    assert not matches_identity("Some preamble\n" + marker, MATERIAL)
    assert not matches_identity("> quoted: " + marker, MATERIAL)
    assert not matches_identity(marker, INCOMPLETE)
    assert not matches_identity(None, MATERIAL)
    assert not matches_identity("", MATERIAL)


def test_another_creators_open_proposal_is_never_matched() -> None:
    issues = [
        _issue(101, identity_marker(MATERIAL) + "\ncontoso body"),
        _issue(102, "chatter mentioning " + identity_marker(MATERIAL)),
        _issue(103, identity_marker(INCOMPLETE) + "\nfabrikam body", state="closed"),
    ]

    assert [issue.number for issue in find_open_proposals(issues, MATERIAL)] == [101]
    assert find_open_proposals(issues, INCOMPLETE) == ()


def test_duplicates_are_ordered_with_the_lowest_number_first() -> None:
    issues = [
        _issue(number, identity_marker(MATERIAL) + "\nx") for number in (204, 101, 190)
    ]

    assert [issue.number for issue in find_open_proposals(issues, MATERIAL)] == [
        101,
        190,
        204,
    ]


def test_a_creator_id_that_could_forge_an_identity_is_refused() -> None:
    for creator_id in ("contoso --><!-- modeltree-proposal: v1 creator=evil", "", "A/B"):
        with pytest.raises(PublicationError):
            identity_marker(creator_id)
        with pytest.raises(PublicationError):
            issue_title(creator_id)


def test_the_title_is_stable_and_names_the_creator() -> None:
    assert issue_title(MATERIAL) == "ModelTree proposal: contoso-ai"


# ---------------------------------------------------------------------------
# materiality
# ---------------------------------------------------------------------------


def test_a_run_with_candidates_is_material(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)

    assert proposal.claims
    assert is_material(proposal)


def test_a_complete_run_that_found_nothing_is_not_material(proposal_factory) -> None:
    proposal = proposal_factory(QUIET)

    assert proposal.status is ProposalStatus.COMPLETE
    assert (proposal.claims, proposal.conflicts, proposal.failures) == ((), (), ())
    assert not is_material(proposal)


def test_an_incomplete_run_is_material_even_with_nothing_to_propose(
    proposal_factory,
) -> None:
    proposal = dataclasses.replace(
        proposal_factory(QUIET), status=ProposalStatus.INCOMPLETE
    )

    assert is_material(proposal)


def test_a_claim_the_panel_refused_is_still_material(proposal_factory) -> None:
    """"We looked and rejected it" is a reviewable outcome, not silence."""
    quiet = proposal_factory(QUIET)
    with_refused_claim = dataclasses.replace(
        quiet, claims=proposal_factory(MATERIAL).claims[:1], adjudications=()
    )

    assert is_material(with_refused_claim)


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------


def test_the_body_carries_every_section_the_issue_requires(proposal_factory) -> None:
    body = render_body(proposal_factory(MATERIAL))

    for heading in (
        "## Candidate patch",
        "## Atomic evidence",
        "## Sources and source decisions",
        "## Reviewer verdicts",
        "## Deterministic validation",
        "## Conflicts",
        "## Budget usage",
        "## Completion status",
    ):
        assert heading in body, heading


def test_the_body_shows_every_reviewer_verdict(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    assert proposal.verdicts
    for verdict in proposal.verdicts:
        assert verdict.reviewer in body
        assert verdict.lens.value in body
    for adjudication in proposal.adjudications:
        assert adjudication.claim_id in body


def test_the_body_shows_atomic_evidence_for_every_claim(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    for claim in proposal.claims:
        for evidence in claim.evidence:
            assert evidence.url in body
            assert evidence.content_hash in body
            assert evidence.verified_at in body
            assert evidence.quote.strip().splitlines()[0][:40] in body


def test_the_body_shows_every_deterministic_gate_including_failures(
    proposal_factory,
) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    assert proposal.gates
    for gate in proposal.gates:
        assert gate.gate in body
    if any(gate.failed for gate in proposal.gates):
        assert "**failed**" in body
    for validation in proposal.validations:
        assert validation.claim_id in body


def test_the_body_shows_source_decisions_with_their_vote_tally(
    proposal_factory,
) -> None:
    proposal = proposal_factory(MATERIAL)
    body = render_body(proposal)

    assert proposal.source_approvals
    for approval in proposal.source_approvals:
        assert approval.source_id in body


def test_the_body_shows_budget_usage(proposal_factory) -> None:
    body = render_body(proposal_factory(MATERIAL))

    assert "## Budget" in body
    assert "pages" in body and "tokens" in body


def test_an_incomplete_run_states_its_failures(proposal_factory) -> None:
    proposal = proposal_factory(INCOMPLETE)
    body = render_body(proposal)

    assert proposal.status is not ProposalStatus.COMPLETE
    assert proposal.status.value in body
    for failure in proposal.failures:
        assert failure.message[:40] in body
        assert failure.stage.value in body


def test_rendering_the_same_artefact_twice_is_byte_identical(
    proposal_factory,
) -> None:
    """No render-time clock, no dict ordering luck: reruns must not churn the issue."""
    proposal = proposal_factory(MATERIAL)

    assert render_body(proposal) == render_body(proposal)


# ---------------------------------------------------------------------------
# measured time never reaches the body
#
# Rendering the same *object* twice, above, cannot catch a wall-clock value: the
# measurement is frozen into the proposal before rendering starts. What has to be
# pinned is that two executions of one run, whose measured elapsed times differ,
# still produce the same bytes. These force that difference rather than racing
# for it.
# ---------------------------------------------------------------------------


# Windows' monotonic clock ticks at ~15.6 ms, so two executions of one run land
# on adjacent ticks. That is the granularity that surfaced this.
WINDOWS_TIMER_TICK = 0.015625

# Elapsed values chosen to fall in different buckets under every plausible way of
# printing measured time: raw, two decimal places, whole seconds, whole minutes.
ELAPSED_SPREAD = (0.0, WINDOWS_TIMER_TICK, 0.9, 1.0, 59.4, 119.999)


def _with_elapsed(proposal, seconds: float):
    """The same proposal with only its measured elapsed time changed."""
    return dataclasses.replace(
        proposal,
        budget=dataclasses.replace(proposal.budget, elapsed_seconds=seconds),
    )


def _stopped_clock(at: float = 1000.0):
    return lambda: at


def _ticking_clock(step: float = WINDOWS_TIMER_TICK, start: float = 1000.0):
    """A `time.monotonic` stand-in that advances one timer tick per read."""
    state = {"now": start}

    def clock() -> float:
        now = state["now"]
        state["now"] = now + step
        return now

    return clock


# Seconds per clock read in an overrunning run. Larger than the limit below, so
# the run's first budget check is already past it and the stop is not a race.
# Two runs are separated by varying this *step*, not the clock's start: shifting
# the start moves both reads equally and leaves elapsed time identical, which
# would make a difference test pass vacuously.
OVERRUN_STEP = 130.0
OVERRUN_LIMIT = 120.0

# A seconds limit whose lossy `:g` rendering and the publisher's real rendering
# disagree: `:g` gives `780.094` (six significant figures), `_seconds_limit`
# gives `780.09375`. From the byte-identity family #149 established. The old
# expectations used `120.0`, which both formatters render `120`, so they passed
# whether or not the publisher still used the `:g` that #180 removed. Assertions
# built on this value fail loudly if the formatter regresses to `:g` (#263).
DISCRIMINATING_LIMIT = 780.09375

# The limit the *original* run is stopped by, before it is resumed. Deliberately
# not the 120.0 default, because a resume falls back to that default and the two
# have to disagree for the test to prove anything; and deliberately a value `:g`
# would round differently, so the resumed sentence is pinned to the publisher's
# real rendering rather than to a format-insensitive one.
RESUME_LIMIT = DISCRIMINATING_LIMIT


def _measured_values(proposal) -> list[float]:
    """Every wall-clock measurement the run recorded, ledger and failures alike."""
    return [proposal.budget.elapsed_seconds] + [
        failure.detail["used"]
        for failure in proposal.failures
        if failure.kind is FailureKind.BUDGET_EXHAUSTED
        and failure.detail.get("resource") == "seconds"
    ]


def _overrunning(
    proposal_factory, *, step: float = OVERRUN_STEP, limit: float = OVERRUN_LIMIT
):
    """A run genuinely stopped by the seconds limit, not a hand-edited budget."""
    proposal = proposal_factory(
        MATERIAL,
        budget=CreatorBudget(max_seconds=limit),
        clock=_ticking_clock(step=step),
    )
    # Anti-vacuity. Without these, a run that quietly never overran would satisfy
    # every "the measurement is absent" assertion below for the wrong reason.
    assert proposal.status is not ProposalStatus.COMPLETE
    assert proposal.budget.exhausted_by == ("seconds",)
    assert proposal.budget.elapsed_seconds >= limit
    assert len(_measured_values(proposal)) > 1
    return proposal


def test_the_budget_section_prints_the_time_limit_and_no_measured_time(
    proposal_factory,
) -> None:
    """Pinned as an exact row, so a timing value cannot be slipped back into it.

    The limit stays: a run stopped by it has to be readable against something.
    """
    proposal = proposal_factory(
        MATERIAL, budget=CreatorBudget(max_seconds=DISCRIMINATING_LIMIT)
    )
    body = render_body(_with_elapsed(proposal, 47.31597))

    # A literal, not `{...:g}`. On the old default of `120.0` the `:g` expectation
    # agreed with the publisher's rendering by coincidence -- both give `120` --
    # so the row was pinned to a format #180 removed and would still have passed
    # had the publisher never stopped using it. `DISCRIMINATING_LIMIT` renders
    # `780.09375`, where `:g` gives `780.094`, so this row now fails if the
    # `Limit` cell regresses to `:g`.
    assert "| seconds | _not rendered_ | 780.09375 |" in body
    assert "47.31597" not in body
    assert "47.32" not in body
    assert "47.3" not in body


def test_the_body_is_identical_however_long_the_run_took(proposal_factory) -> None:
    """The property the existing no-churn test could only sample.

    Every value here would print differently under any scheme that renders or
    quantises measured time, so this fails if a timing-derived value is
    reintroduced in any form — including a bucketed one.
    """
    proposal = proposal_factory(MATERIAL)

    bodies = {render_body(_with_elapsed(proposal, s)) for s in ELAPSED_SPREAD}

    assert len(bodies) == 1


def test_two_renders_one_windows_timer_tick_apart_are_byte_identical(
    proposal_factory,
) -> None:
    """The reported case exactly: `0.00` against `0.02` at two decimal places.

    Linux's clock is fine-grained enough to hide this most of the time, which is
    why it is asserted here rather than left to be observed.
    """
    proposal = proposal_factory(MATERIAL)

    assert render_body(_with_elapsed(proposal, 0.0)) == render_body(
        _with_elapsed(proposal, WINDOWS_TIMER_TICK)
    )


def test_a_run_stopped_by_the_time_limit_says_so_without_the_measurement(
    proposal_factory,
) -> None:
    """Not printing the measurement must not hide the enforcement.

    Driven through the real `run_creator`, because the earlier version of this
    test hand-edited two budget fields onto a *complete* proposal with no
    failures — so its "the measurement is absent" assertion passed because there
    was no failure record to carry it, not because anything was suppressed. A
    genuine overrun records `BudgetExhausted`, which puts the measured elapsed
    time in the failure's message *and* in its detail, and both reach the body.
    """
    # `step` stays above `limit` so the first budget check already overruns, as
    # the default does; `limit` is the discriminating value so the rows below are
    # pinned to the publisher's real rendering rather than to a `:g` that would
    # coincide with it at `120.0`.
    proposal = _overrunning(proposal_factory, step=790.0, limit=DISCRIMINATING_LIMIT)

    body = render_body(proposal)

    # The stop is reported, in the budget section and in the failures table ...
    assert "**Exhausted:** `seconds`" in body
    # Literals, not `{...:g}`: `:g` renders `780.09375` as `780.094`, so these
    # fail if either the budget-table `Limit` cell or the failures sentence
    # regresses to it. At the old `120.0` both formatters agreed and could not.
    assert "| seconds | _not rendered_ | 780.09375 |" in body
    assert "`budget-exhausted`" in body
    assert "seconds budget exhausted" in body
    assert "reached its 780.09375 second limit" in body
    # ... and every measured value the run recorded is absent from it.
    for measured in _measured_values(proposal):
        assert str(measured) not in body
    # Absence alone is not enough: a *bucketed* measurement ("4m") would satisfy
    # the loop above while still being derived from the clock, and would still
    # churn whenever two executions straddle a bucket boundary. So the detail
    # cell is pinned positively — the field is present and is exactly the
    # sentinel, once per failure that carries one.
    stopped_by_seconds = [
        f for f in proposal.failures if f.detail.get("resource") == "seconds"
    ]
    assert stopped_by_seconds
    assert body.count('"used": "not rendered"') == len(stopped_by_seconds)
    assert render_body(proposal_from_dict(proposal.to_dict())) == body


def test_the_stated_limit_is_the_one_that_stopped_the_run_not_the_proposals(
    tmp_path, library, settings_factory
) -> None:
    """A resumed run's proposal carries a different limit than its failures do.

    `resume` takes no budget flags at all, so `cli._resume` falls through to
    `CreatorBudget.from_env` and the 120.0 default. A run started under a tighter
    limit and then resumed therefore ends up with a proposal whose budget says
    120.0 while the failure that actually stopped it says 5.0, and the two can
    only agree by coincidence.

    Rendering that sentence from the proposal's budget stated a limit the run was
    never judged against, contradicted the JSON cell beside it and the artefact on
    disk, and — being stable — read as trustworthy. The limit is therefore taken
    from the failure, which is the record of what was actually enforced.
    """
    storage = create_checkpoint_storage(tmp_path / "checkpoints")

    async def scenario():
        await run_creator(
            library.creators[MATERIAL],
            settings_factory(
                CreatorBudget(max_seconds=RESUME_LIMIT),
                clock=_ticking_clock(step=RESUME_LIMIT + 1.0),
            ),
            run_id="run-resume",
            checkpoint_storage=storage,
        )
        summaries = await list_checkpoint_summaries(storage, workflow_name=WORKFLOW_NAME)
        for summary in reversed(summaries):
            try:
                # No budget argument: exactly what `cli._resume` builds.
                resumed = await resume_creator_run(
                    settings_factory(),
                    checkpoint_id=summary["checkpoint_id"],
                    checkpoint_storage=storage,
                )
            except RuntimeError:
                continue  # a terminal checkpoint has nothing left to finish
            if any(f.detail.get("resource") == "seconds" for f in resumed.failures):
                return resumed
        return None

    resumed = asyncio.run(scenario())

    # Anti-vacuity: the two limits must genuinely disagree, or this proves nothing.
    assert resumed is not None, "no checkpoint carried a seconds failure forward"
    enforced = {
        f.detail["limit"] for f in resumed.failures if f.detail.get("resource") == "seconds"
    }
    assert enforced == {RESUME_LIMIT}
    assert resumed.budget.max_seconds != RESUME_LIMIT

    body = render_body(resumed)

    # Literal, not `{...:g}`: RESUME_LIMIT is now a value `:g` would round to
    # `780.094`, so this pins the publisher's real `780.09375` rendering.
    assert "reached its 780.09375 second limit" in body
    assert f"reached its {resumed.budget.max_seconds:g} second limit" not in body
    # The sentence and the JSON cell beside it must not contradict each other.
    assert f'"limit": {RESUME_LIMIT}' in body


def test_the_measurement_is_redacted_even_when_the_limit_is_not_recorded(
    proposal_factory,
) -> None:
    """The redaction must not be conditional on the limit being renderable.

    An artefact can reach the publisher with a seconds exhaustion whose detail
    carries no numeric `limit` — details are a plain mapping and the publisher
    reads artefacts it did not write. Gating the redaction on the limit would let
    the recorded message, measurement and all, through on exactly that path. So
    the redaction is unconditional and only the *phrasing* falls back.
    """
    real = _overrunning(proposal_factory)
    stripped = tuple(
        dataclasses.replace(
            failure,
            detail={k: v for k, v in failure.detail.items() if k != "limit"},
        )
        if failure.detail.get("resource") == "seconds"
        else failure
        for failure in real.failures
    )
    proposal = dataclasses.replace(real, failures=stripped)

    # Anti-vacuity: the recorded messages still carry the measurement.
    measured = _measured_values(real)
    assert any(str(v) in f.message for v in measured for f in proposal.failures)

    body = render_body(proposal)

    assert "reached its seconds budget" in body
    assert "second limit" not in body
    for value in measured:
        assert str(value) not in body


def test_a_run_stopped_exactly_on_its_limit_says_reached_not_passed(
    proposal_factory,
) -> None:
    """`check_time` exhausts on `>=`, so `used == limit` is a real stop.

    Such a run never exceeded anything, and saying it "passed" its limit would be
    false on the one boundary the enforcement is defined at.
    """
    proposal = _overrunning(
        proposal_factory,
        step=DISCRIMINATING_LIMIT / 2,
        limit=DISCRIMINATING_LIMIT,
    )
    exhausted = [f for f in proposal.failures if f.detail.get("resource") == "seconds"]

    # Anti-vacuity: this is the boundary case only if the two are actually equal.
    assert (
        exhausted[0].detail["used"]
        == exhausted[0].detail["limit"]
        == DISCRIMINATING_LIMIT
    )

    body = render_body(proposal)

    # Literal, not `{...:g}`: pins the publisher's `780.09375` and fails on the
    # `780.094` a `:g` regression would print; `120.0` could not tell them apart.
    assert "reached its 780.09375 second limit" in body
    assert "passed its" not in body


def test_two_overrunning_executions_one_timer_tick_apart_render_identically(
    proposal_factory,
) -> None:
    """The whole-body property, on the path a stopped run takes.

    Byte-identity across two executions is the catch-all: it fails if measured
    time reaches the body by *any* route, not only the ones asserted by name
    above. The measured values are asserted to differ first, so this cannot pass
    by both runs happening to record the same numbers.
    """
    fast = _overrunning(proposal_factory)
    slow = _overrunning(proposal_factory, step=OVERRUN_STEP + WINDOWS_TIMER_TICK)

    assert _measured_values(fast) != _measured_values(slow)
    assert render_body(fast) == render_body(slow)


def test_the_published_body_carries_no_measured_value(
    proposal_factory, fake_issues_client
) -> None:
    """The invariant #149 established, asserted by name and on the sent body.

    This is what `test_re_rendering_the_same_run_adds_no_comment_and_no_churn`
    was reaching for and could only reach by luck. That test published one run
    twice on the real clock and compared bytes, so it depended on two executions
    happening to record different elapsed times — and once #149 stopped
    rendering measured time at all, byte-identity stopped distinguishing
    "identical although the measurements differed" from "nothing time-varying is
    rendered". Every one of its assertions is made deterministically by
    `test_re_publishing_a_run_that_took_longer_adds_no_comment_and_no_churn`,
    which forces the difference instead of racing for it, so it was removed
    (#197) and the property it was standing in for is stated here directly.

    Stated *positively*, cell by cell: each place a measured wall-clock value
    would go holds the sentinel. Absence alone would not be enough. #149's QA
    found that bucketing `used` to whole minutes escaped a check that only
    looked for the measurement verbatim — `"4m"` is not the measured value, yet
    it is still derived from the clock and still churns whenever two executions
    straddle a bucket boundary. Pinning the cell's content rejects `"4m"` for
    the same reason it rejects `"247.03125"`: it is not the sentinel. So this
    fails deterministically on any rendering of a measurement, bucketed or
    reformatted, rather than intermittently on some of them.

    Run through `publish_proposal` rather than `render_body`, because the body
    that reaches GitHub is the one this invariant is about and nothing else here
    checks it on that path.
    """
    proposal = _overrunning(proposal_factory)
    client = fake_issues_client()

    publish_proposal(proposal, client)
    body = client.issues[0].body

    # Anti-vacuity: the run really did record several measurements, so the
    # sentinels below stand in for something rather than for nothing.
    measured = _measured_values(proposal)
    assert len(measured) > 1

    # The budget table. Only the `Used` cell is pinned: the `Limit` cell beside
    # it is a different property, asserted by name in #263's tests above.
    row = re.search(r"^\| seconds \| ([^|]*) \| [^|]* \|$", body, re.MULTILINE)
    assert row is not None, body
    assert row.group(1) == "_not rendered_"

    # Only the clock is redacted. Without this, "render nothing at all" would
    # satisfy every assertion here, and the counters are what a reviewer needs.
    for resource, used in (
        ("pages", proposal.budget.pages_fetched),
        ("tokens", proposal.budget.tokens_used),
        ("retries", proposal.budget.retries_used),
    ):
        assert f"| {resource} | {used} | " in body

    # The failures table, the second surface a measurement reaches: the sentinel
    # once in the `used` detail and once in the rebuilt sentence, per seconds
    # exhaustion. Counted, so a redaction that silently stopped covering one of
    # several failures is caught rather than masked by the others.
    stopped_by_seconds = [
        f for f in proposal.failures if f.detail.get("resource") == "seconds"
    ]
    assert stopped_by_seconds
    assert body.count('"used": "not rendered"') == len(stopped_by_seconds)
    sentence = "The measured elapsed time is not rendered here."
    assert body.count(sentence) == len(stopped_by_seconds)


# The seconds limit is printed twice — as prose in the failures table and, on the
# same row, as a JSON `Detail` cell — and the two used different formatters: `:g`
# for the sentence, `json.dumps` for the cell. `:g` keeps six significant figures
# and switches to exponent form past them, so above that width the sentence stops
# round-tripping and disagrees with the cell beside it (#180). These values are
# #180's own table, chosen to straddle the six-significant-digit boundary: the
# ones below it round-trip under `:g` already, the ones at and above it do not.
LIMIT_ROUND_TRIP_CASES = (5.0, 120.0, 999999.0, 1000000.0, 1234567.0, 10000000.0, 0.1, 12.5)


def _with_seconds_limit(proposal, limit: float):
    """The same overrunning proposal re-pinned to one seconds limit, in the
    budget and in every seconds failure's detail, leaving the measured values
    alone. `_failure_row` rebuilds the sentence from `detail["limit"]`, so this
    is what both the prose and the JSON cell are rendered from.
    """
    failures = tuple(
        dataclasses.replace(failure, detail={**failure.detail, "limit": limit})
        if failure.detail.get("resource") == "seconds"
        else failure
        for failure in proposal.failures
    )
    return dataclasses.replace(
        proposal,
        budget=dataclasses.replace(proposal.budget, max_seconds=limit),
        failures=failures,
    )


@pytest.mark.parametrize("limit", LIMIT_ROUND_TRIP_CASES)
def test_the_stated_limit_and_the_json_cell_state_the_same_number(
    proposal_factory, limit
) -> None:
    """The failures-table sentence and the JSON cell beside it must round-trip to
    one value, and read cleanly while doing so.

    Executed across the six-significant-digit boundary rather than asserted by
    eye: with `:g`, `1234567.0` renders `1.23457e+06` in the sentence and
    `1234567.0` in the cell, and `float("1.23457e+06")` is `1234570.0` — a
    different number printed beside the right one. Fails against `main` at
    `1000000.0`, `1234567.0` and `10000000.0`, where `:g` switches to exponent
    form; the readability clauses catch the exponent cases even where the value
    still happens to round-trip.
    """
    proposal = _with_seconds_limit(_overrunning(proposal_factory), limit)
    body = render_body(proposal)

    prose = re.search(r"reached its (\S+) second limit", body)
    cell = re.search(r'"limit": ([0-9.eE+-]+)', body)
    assert prose is not None and cell is not None, body

    # The two cells state the same number, and it is the one the run was stopped at.
    assert float(prose.group(1)) == float(cell.group(1)) == limit
    # Readable and lossless: never an exponent, and an integral limit is a bare
    # integer (`5`, not `5.0` or `5.000000`), which is the form #180 asked survive.
    assert "e" not in prose.group(1).lower()
    if float(limit).is_integer():
        assert prose.group(1) == str(int(limit))


@pytest.mark.parametrize("limit", LIMIT_ROUND_TRIP_CASES)
def test_the_budget_tables_seconds_limit_stays_round_trippable(
    proposal_factory, limit
) -> None:
    """The budget table's `Limit` cell is the second place the seconds limit is
    printed, and it used `:g` too — so above six significant digits it disagreed
    with the failures table across sections. It has no JSON cell beside it, but a
    reviewer still has to recover the number, so it must round-trip and not go
    exponential. Fails against `main` at `1000000.0`, `1234567.0`, `10000000.0`.
    """
    proposal = dataclasses.replace(
        proposal_factory(MATERIAL),
        budget=dataclasses.replace(
            proposal_factory(MATERIAL).budget, max_seconds=limit
        ),
    )
    body = render_body(proposal)

    cell = re.search(r"\| seconds \| _not rendered_ \| (\S+) \|", body)
    assert cell is not None, body
    assert float(cell.group(1)) == limit
    assert "e" not in cell.group(1).lower()


@pytest.mark.parametrize("limit", [True, False])
def test_a_boolean_seconds_limit_falls_back_to_the_unnumbered_phrasing(
    proposal_factory, limit
) -> None:
    """A bool limit must not be rendered as a number.

    `isinstance(True, int)` and `isinstance(False, int)` are both True, so a bool
    reaching `_seconds_limit` renders `repr(True)` -> `'True'`, and a formatter
    that leaned on bool-is-int would print `1`/`0`. The failures sentence excludes
    the type first and falls back to the unnumbered `its seconds budget`. That
    holds today only because of a guard on the sentence, not `_seconds_limit`
    itself, and nothing in the suite pinned it: a refactor that fed the value in
    directly would print `its True second limit` with no test objecting.
    """
    real = _overrunning(proposal_factory)
    failures = tuple(
        dataclasses.replace(failure, detail={**failure.detail, "limit": limit})
        if failure.detail.get("resource") == "seconds"
        else failure
        for failure in real.failures
    )
    proposal = dataclasses.replace(real, failures=failures)

    # Anti-vacuity: a seconds failure really is carrying the boolean limit, so the
    # fallback below is exercised on the bool path and not on an absent one.
    assert any(
        failure.detail.get("limit") is limit
        for failure in proposal.failures
        if failure.detail.get("resource") == "seconds"
    )

    body = render_body(proposal)

    assert "reached its seconds budget" in body
    # No numeric-limit sentence at all, and specifically none of the renderings a
    # bool would produce if its type were trusted.
    assert "second limit" not in body
    assert "its 1 second limit" not in body
    assert "its 0 second limit" not in body
    assert "its True second limit" not in body
    assert "its False second limit" not in body


def test_an_integer_and_a_float_seconds_limit_render_identically(
    proposal_factory,
) -> None:
    """`5` and `5.0` are one limit and must print as one string.

    `_seconds_limit` normalises the integral float (`5.0` -> `5`) so it matches
    the int; a formatter that used `str` would print `5.0` for the float and
    split the two. Only the budget table's `Limit` cell is compared -- the JSON
    `Detail` cell serialises `5` and `5.0` differently by design, so whole-body
    equality is not the property here.
    """
    base = proposal_factory(MATERIAL)
    as_int = render_body(
        dataclasses.replace(
            base, budget=dataclasses.replace(base.budget, max_seconds=5)
        )
    )
    as_float = render_body(
        dataclasses.replace(
            base, budget=dataclasses.replace(base.budget, max_seconds=5.0)
        )
    )

    pattern = r"\| seconds \| _not rendered_ \| (\S+) \|"
    int_cell = re.search(pattern, as_int)
    float_cell = re.search(pattern, as_float)
    assert int_cell is not None and float_cell is not None
    assert int_cell.group(1) == float_cell.group(1) == "5"


def test_a_run_stopped_by_the_token_limit_still_prints_its_count(
    proposal_factory,
) -> None:
    """Only measured time is withheld — the guard against over-correcting.

    Pages, tokens and retries are counters: identical across two executions of
    one run, and a reviewer needs to see exactly how many were spent. Their
    exhaustion records are rendered verbatim.
    """
    proposal = proposal_factory(MATERIAL, budget=CreatorBudget(max_tokens=40))
    exhausted = [
        failure
        for failure in proposal.failures
        if failure.kind is FailureKind.BUDGET_EXHAUSTED
    ]
    assert exhausted
    assert exhausted[0].detail["used"] > 0

    body = render_body(proposal)

    assert exhausted[0].message in body
    assert f'"used": {exhausted[0].detail["used"]}' in body
    assert "not rendered" not in body.split("## Completion status")[1]


def test_rendering_survives_a_json_round_trip_unchanged(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL)
    restored = proposal_from_dict(proposal.to_dict())

    assert render_body(restored) == render_body(proposal)


def test_table_content_cannot_break_out_of_its_row(proposal_factory) -> None:
    """Claim values come from fetched pages. A pipe or newline must not forge a row."""
    quiet = proposal_factory(QUIET)
    claim = proposal_factory(MATERIAL).claims[0]
    hostile = dataclasses.replace(
        quiet,
        claims=(
            dataclasses.replace(
                claim, value="a | b\nsecond line", field_path="x | y"
            ),
        ),
    )

    body = render_body(hostile)
    rows = [line for line in body.splitlines() if line.startswith("|")]

    assert "x \\| y" in body
    assert "second line" in body
    assert all(row.endswith("|") for row in rows)
    assert not any(row.strip() == "| second line |" for row in rows)


def test_an_oversized_proposal_is_truncated_explicitly(proposal_factory) -> None:
    """Nothing is dropped silently: the body names what it had to leave out."""
    proposal = proposal_factory(MATERIAL)
    huge = dataclasses.replace(proposal, claims=proposal.claims * 4000)

    body = render_body(huge)

    assert len(body) <= MAX_BODY_CHARS
    assert body.splitlines()[0] == identity_marker(MATERIAL)
    assert "## Publication notes" in body
    assert "omitted to fit a GitHub issue body" in body
    assert "## Completion status" in body


# ---------------------------------------------------------------------------
# publication
# ---------------------------------------------------------------------------


def test_a_first_run_creates_one_issue(proposal_factory, fake_issues_client) -> None:
    client = fake_issues_client()

    outcome = publish_proposal(proposal_factory(MATERIAL), client)

    assert outcome.action is PublicationAction.CREATED
    assert client.actions == ["list", "create"]
    assert len(client.issues) == 1
    assert client.issues[0].title == issue_title(MATERIAL)


def test_a_rerun_updates_the_same_issue_instead_of_duplicating(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()
    proposal = proposal_factory(MATERIAL)

    first = publish_proposal(proposal, client)
    second = publish_proposal(proposal, client)

    assert first.action is PublicationAction.CREATED
    assert second.action is PublicationAction.UPDATED
    assert second.issue_number == first.issue_number
    assert len(client.issues) == 1
    assert client.actions == ["list", "create", "list", "update"]


def test_a_no_change_run_makes_no_github_request_at_all(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()

    outcome = publish_proposal(proposal_factory(QUIET), client)

    assert outcome.action is PublicationAction.SKIPPED_NO_CHANGE
    assert outcome.issue_number is None
    assert client.calls == []


def test_a_no_change_run_leaves_an_existing_proposal_untouched(
    proposal_factory, fake_issues_client
) -> None:
    """A stale open proposal is a human's call. Closing it would destroy review context."""
    existing = _issue(101, identity_marker(QUIET) + "\nolder proposal")
    client = fake_issues_client([existing])

    publish_proposal(proposal_factory(QUIET), client)

    assert client.issues == [existing]


def test_publishing_one_creator_never_touches_another_creators_issue(
    proposal_factory, fake_issues_client
) -> None:
    foreign = _issue(101, identity_marker(MATERIAL) + "\ncontoso proposal")
    client = fake_issues_client([foreign])

    outcome = publish_proposal(proposal_factory(INCOMPLETE), client)

    assert outcome.action is PublicationAction.CREATED
    assert outcome.issue_number != 101
    assert client.issues[0] == foreign


def test_duplicates_are_reported_and_never_closed(
    proposal_factory, fake_issues_client
) -> None:
    """No conditional write exists on this API, so this tool does not close issues.

    It updates the lowest-numbered proposal, says so, and leaves the rest for a human.
    """
    canonical = _issue(101, identity_marker(MATERIAL) + "\nfirst")
    duplicate = _issue(102, identity_marker(MATERIAL) + "\nsecond")
    client = fake_issues_client([canonical, duplicate])

    outcome = publish_proposal(proposal_factory(MATERIAL), client)

    assert outcome.action is PublicationAction.UPDATED
    assert outcome.issue_number == 101
    assert outcome.duplicates == (102,)
    # The seeded body carries no state marker, so replacing it is recorded first.
    assert client.actions == ["list", "comment", "update"]
    assert [issue.number for issue in client.issues] == [101, 102]
    assert client.issues[1] == duplicate
    assert "#102" in client.issues[0].body


def test_one_creator_failing_does_not_stop_the_others(
    report_factory, fake_issues_client
) -> None:
    report = report_factory(MATERIAL, INCOMPLETE)
    client = fake_issues_client()
    original_create = client.create_issue

    def create(*, title: str, body: str):
        if MATERIAL in title:
            raise RuntimeError("issue creation refused")
        return original_create(title=title, body=body)

    client.create_issue = create

    result = publish_report(report, client)

    assert [failure.creator_id for failure in result.failures] == [MATERIAL]
    assert "issue creation refused" in result.failures[0].message
    assert [outcome.creator_id for outcome in result.outcomes] == [INCOMPLETE]
    assert [issue.title for issue in client.issues] == [issue_title(INCOMPLETE)]


def test_an_incomplete_creator_updates_its_own_proposal_with_the_failure(
    report_factory, fake_issues_client
) -> None:
    report = report_factory(MATERIAL, INCOMPLETE)
    client = fake_issues_client()

    publish_report(report, client)
    reran = publish_report(report, client)

    bodies = {issue.title: issue.body for issue in client.issues}
    incomplete = report.proposals[1]

    assert len(client.issues) == 2
    assert all(
        outcome.action is PublicationAction.UPDATED for outcome in reran.outcomes
    )
    assert incomplete.status.value in bodies[issue_title(INCOMPLETE)]
    for failure in incomplete.failures:
        assert failure.message[:40] in bodies[issue_title(INCOMPLETE)]


def test_a_dry_run_renders_the_payload_and_sends_nothing(
    report_factory, fake_issues_client
) -> None:
    report = report_factory(MATERIAL, QUIET)
    client = fake_issues_client()

    rendered = publish_report(report, None, dry_run=True)
    published = publish_report(report, client)

    assert [outcome.action for outcome in rendered.outcomes] == [
        PublicationAction.RENDERED,
        PublicationAction.SKIPPED_NO_CHANGE,
    ]
    assert rendered.outcomes[0].payload == published.outcomes[0].payload
    assert rendered.outcomes[0].issue_number is None


def test_publishing_without_a_client_is_refused(report_factory) -> None:
    with pytest.raises(PublicationError):
        publish_report(report_factory(QUIET), None)


def test_the_rendered_payload_is_what_gets_sent(
    proposal_factory, fake_issues_client
) -> None:
    proposal = proposal_factory(MATERIAL)
    client = fake_issues_client()

    outcome = publish_proposal(proposal, client)

    assert outcome.payload == render_issue(proposal)
    assert client.issues[0].body == outcome.payload.body
    assert client.issues[0].title == outcome.payload.title


# ---------------------------------------------------------------------------
# supersession continuity
#
# An update replaces a body wholesale, taking the previous run's evidence with
# it. "The previous run's evidence vanished with no trace" must not be reachable.
# ---------------------------------------------------------------------------


def test_the_state_marker_is_the_second_line_and_round_trips(proposal_factory) -> None:
    proposal = proposal_factory(MATERIAL, run_id="run-a")
    body = render_body(proposal, supersedes="run-older")

    state = read_state(body)

    assert body.split("\n")[1] == state_marker(proposal, "run-older")
    assert state is not None
    assert state.run_id == "run-a"
    assert state.supersedes == "run-older"
    assert state.claims == len(proposal.claims)
    assert state.accepted == len(proposal.accepted_claim_ids)
    assert state.conflicts == len(proposal.conflicts)
    assert state.failures == len(proposal.failures)


def test_state_is_anchored_to_the_second_line_only(proposal_factory) -> None:
    """Proposal content is fetched text. It must not be able to describe the issue."""
    proposal = proposal_factory(MATERIAL, run_id="run-a")
    forged = state_marker(proposal_factory(MATERIAL, run_id="run-forged"))
    body = render_body(proposal) + f"\nA quoted page said: {forged}\n"

    state = read_state(body)

    assert state is not None
    assert state.run_id == "run-a"


def test_a_body_without_a_state_marker_reads_as_unreadable() -> None:
    assert read_state(identity_marker(MATERIAL) + "\nhand written") is None
    assert read_state("") is None
    assert read_state(None) is None


def test_a_run_id_that_could_forge_a_state_marker_is_refused(proposal_factory) -> None:
    proposal = dataclasses.replace(
        proposal_factory(MATERIAL), run_id="run --> <!-- modeltree-run: v1 run=evil"
    )

    with pytest.raises(PublicationError):
        render_body(proposal)


def test_an_update_from_a_different_run_records_the_one_it_replaces(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()
    first = proposal_factory(MATERIAL, run_id="run-a")
    second = proposal_factory(MATERIAL, run_id="run-b")

    publish_proposal(first, client)
    outcome = publish_proposal(second, client)

    assert outcome.superseded_run == "run-a"
    assert client.actions == ["list", "create", "list", "comment", "update"]
    assert len(client.comments) == 1
    number, comment = client.comments[0]
    assert number == outcome.issue_number
    assert "run-a" in comment
    assert "run-b" in comment


def test_the_supersession_comment_carries_the_replaced_runs_counts(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()
    first = proposal_factory(MATERIAL, run_id="run-a")

    publish_proposal(first, client)
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)
    _, comment = client.comments[0]

    assert f"| Candidate claims | {len(first.claims)} |" in comment
    assert f"| Accepted | {len(first.accepted_claim_ids)} |" in comment
    assert f"| Conflicts | {len(first.conflicts)} |" in comment
    assert f"| Failures | {len(first.failures)} |" in comment


def test_the_comment_is_filed_before_the_body_is_overwritten(
    proposal_factory, fake_issues_client
) -> None:
    """The record exists to survive the rewrite, so it cannot be written after it.

    If the update fails, the run that was about to be replaced is still on record
    and the failure is reported; the reverse order can lose it silently.
    """
    client = fake_issues_client()
    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)

    def refuse(number: int, *, title: str, body: str):
        raise RuntimeError("update refused")

    client.update_issue = refuse

    with pytest.raises(RuntimeError):
        publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert len(client.comments) == 1
    assert "run-a" in client.comments[0][1]


def test_the_new_body_names_the_run_it_superseded(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()

    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert "| Supersedes run | `run-a` |" in client.issues[0].body


def test_a_first_publication_supersedes_nothing(
    proposal_factory, fake_issues_client
) -> None:
    client = fake_issues_client()

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)

    assert outcome.superseded_run is None
    assert client.comments == []
    assert "| Supersedes run | — |" in client.issues[0].body


def test_re_rendering_the_same_run_adds_no_comment_and_no_churn(
    proposal_factory, fake_issues_client
) -> None:
    """Byte-identical, and the earlier supersession is carried forward intact."""
    client = fake_issues_client()
    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)
    after_replacement = client.issues[0].body

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert outcome.superseded_run is None
    assert len(client.comments) == 1
    assert client.issues[0].body == after_replacement
    assert "| Supersedes run | `run-a` |" in client.issues[0].body


def test_re_publishing_a_run_that_took_longer_adds_no_comment_and_no_churn(
    proposal_factory, fake_issues_client
) -> None:
    """The test above, with the clock controlled instead of raced.

    Two executions of run `run-b`: one against a stopped clock, one against a
    clock that advances a Windows timer tick per read. Their measured elapsed
    times genuinely differ — asserted, not assumed — and the published issue must
    still be byte-identical with no second supersession comment. This is what the
    test above can only get by luck, and got wrong a few percent of the time.
    """
    client = fake_issues_client()
    publish_proposal(proposal_factory(MATERIAL, run_id="run-a"), client)

    instant = proposal_factory(MATERIAL, run_id="run-b", clock=_stopped_clock())
    publish_proposal(instant, client)
    after_replacement = client.issues[0].body

    slow = proposal_factory(MATERIAL, run_id="run-b", clock=_ticking_clock())
    outcome = publish_proposal(slow, client)

    assert instant.budget.elapsed_seconds != slow.budget.elapsed_seconds
    assert outcome.superseded_run is None
    assert len(client.comments) == 1
    assert client.issues[0].body == after_replacement
    assert "| Supersedes run | `run-a` |" in client.issues[0].body


def test_replacing_a_body_that_cannot_be_read_says_so_rather_than_guessing(
    proposal_factory, fake_issues_client
) -> None:
    hand_edited = _issue(101, identity_marker(MATERIAL) + "\nsomeone rewrote this")
    client = fake_issues_client([hand_edited])

    outcome = publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert outcome.superseded_run == UNREADABLE_RUN
    assert len(client.comments) == 1
    assert "could not be read" in client.comments[0][1]
    # No invented run id, and no invented counts.
    assert "Candidate claims |" not in client.comments[0][1]
    assert "could not be read" in client.issues[0].body


def test_an_unreadable_replacement_is_carried_forward_as_a_known_unknown(
    proposal_factory, fake_issues_client
) -> None:
    hand_edited = _issue(101, identity_marker(MATERIAL) + "\nsomeone rewrote this")
    client = fake_issues_client([hand_edited])
    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    publish_proposal(proposal_factory(MATERIAL, run_id="run-b"), client)

    assert len(client.comments) == 1
    assert read_state(client.issues[0].body).supersedes == UNREADABLE_RUN


def test_a_dry_run_records_no_supersession(report_factory, fake_issues_client) -> None:
    client = fake_issues_client()
    publish_proposal(
        report_factory(MATERIAL, run_id="run-a").proposals[0], client
    )

    result = publish_report(report_factory(MATERIAL, run_id="run-b"), None, dry_run=True)

    assert client.comments == []
    assert result.outcomes[0].superseded_run is None
    assert client.actions == ["list", "create"]


def test_a_no_change_run_never_comments(proposal_factory, fake_issues_client) -> None:
    existing = _issue(101, identity_marker(QUIET) + "\nolder proposal")
    client = fake_issues_client([existing])

    publish_proposal(proposal_factory(QUIET), client)

    assert client.comments == []
    assert client.calls == []
