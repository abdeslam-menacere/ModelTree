"""The fixture-backed workflow runs offline and records what it could not do."""

from __future__ import annotations

import asyncio

from modeltree_updater.budgets import CreatorBudget
from modeltree_updater.contracts import (
    ClaimDecision,
    ConflictKind,
    FailureKind,
    ProposalStatus,
    ValidationStatus,
)
from modeltree_updater.runner import run_creator, run_creators


def _run(creator_id, library, settings):
    return asyncio.run(run_creator(library.creators[creator_id], settings, run_id="run-test"))


def test_a_clean_creator_produces_a_complete_proposal(library, settings) -> None:
    proposal = _run("contoso-ai", library, settings)

    assert proposal.status is ProposalStatus.COMPLETE
    assert proposal.failures == ()
    assert len(proposal.sources) == 2
    assert len(proposal.claims) == 4
    assert set(proposal.accepted_claim_ids) == {
        "contoso-ai-atlas-3-context-window",
        "contoso-ai-atlas-3-api-aliases",
        "contoso-ai-atlas-3-release-date",
    }
    assert all(claim.evidence for claim in proposal.claims)
    assert proposal.budget.pages_fetched == 2
    assert proposal.budget.tokens_used > 0


def test_runs_are_deterministic(library, settings_factory) -> None:
    first = _run("contoso-ai", library, settings_factory())
    second = _run("contoso-ai", library, settings_factory())

    assert first.claims == second.claims
    assert first.verdicts == second.verdicts
    assert first.validations == second.validations


def test_conflicting_sources_leave_the_proposal_incomplete(library, settings) -> None:
    proposal = _run("northwind-ai", library, settings)

    assert proposal.status is ProposalStatus.INCOMPLETE
    assert [conflict.kind for conflict in proposal.conflicts] == [
        ConflictKind.CONTRADICTORY_VALUES
    ]
    assert any("sources disagree" in note for note in proposal.notes)


def test_an_invalid_claim_is_downgraded_rather_than_accepted(library, settings) -> None:
    proposal = _run("northwind-ai", library, settings)

    verdict = next(
        item
        for item in proposal.verdicts
        if item.claim_id == "northwind-ai-harbor-2-release-date"
    )
    validation = next(
        item
        for item in proposal.validations
        if item.claim_id == "northwind-ai-harbor-2-release-date"
    )

    assert validation.status is ValidationStatus.INVALID
    assert verdict.decision is ClaimDecision.NEEDS_HUMAN_REVIEW
    assert "downgraded" in verdict.rationale


def test_provider_failures_are_typed_outcomes(library, settings) -> None:
    proposal = _run("fabrikam-ai", library, settings)

    provider_failures = [
        failure
        for failure in proposal.failures
        if failure.kind is FailureKind.PROVIDER_FAILURE
    ]

    assert proposal.status is ProposalStatus.INCOMPLETE
    assert provider_failures
    assert all(failure.retryable for failure in provider_failures)
    assert any(failure.kind is FailureKind.BUDGET_EXHAUSTED for failure in proposal.failures)
    # The healthy source was still proposed; one bad page does not sink the creator.
    assert [source.id for source in proposal.sources] == ["fabrikam-ai-summit-post"]


def test_a_retryable_failure_spends_the_retry_budget(library, settings_factory) -> None:
    settings = settings_factory(CreatorBudget(max_retries=1))
    proposal = _run("fabrikam-ai", library, settings)

    assert proposal.budget.retries_used == 1
    assert "retries" in proposal.budget.exhausted_by


def test_page_budget_exhaustion_is_recorded_not_hidden(library, settings_factory) -> None:
    settings = settings_factory(CreatorBudget(max_pages=1))
    proposal = _run("contoso-ai", library, settings)

    assert proposal.status is ProposalStatus.INCOMPLETE
    assert proposal.budget.exhausted_by == ("pages",)
    assert any(
        failure.kind is FailureKind.BUDGET_EXHAUSTED for failure in proposal.failures
    )
    assert any("budget exhausted" in note for note in proposal.notes)
    assert len(proposal.sources) == 1


def test_token_budget_exhaustion_stops_extraction_explicitly(
    library, settings_factory
) -> None:
    settings = settings_factory(CreatorBudget(max_tokens=1))
    proposal = _run("contoso-ai", library, settings)

    assert proposal.claims == ()
    assert proposal.budget.exhausted_by == ("tokens",)
    # Nothing survived the budget, so the creator is failed rather than "complete".
    assert proposal.status is ProposalStatus.FAILED
    assert all(
        failure.kind is FailureKind.BUDGET_EXHAUSTED for failure in proposal.failures
    )


def test_one_failing_creator_does_not_stop_the_others(library, settings) -> None:
    report = asyncio.run(
        run_creators(
            [
                library.creators["contoso-ai"],
                library.creators["fabrikam-ai"],
                library.creators["northwind-ai"],
            ],
            settings,
            run_id="run-test",
        )
    )

    statuses = {proposal.creator_id: proposal.status for proposal in report.proposals}

    assert statuses["contoso-ai"] is ProposalStatus.COMPLETE
    assert statuses["fabrikam-ai"] is ProposalStatus.INCOMPLETE
    assert statuses["northwind-ai"] is ProposalStatus.INCOMPLETE
    assert report.incomplete_creator_ids == ("fabrikam-ai", "northwind-ai")


def test_a_crashing_creator_becomes_an_explicit_failed_proposal(library, settings) -> None:
    class Exploding:
        name = "exploding:sources"

        def discover(self, creator, *, limit):
            raise MemoryError("provider crashed outside the provider contract")

        def fetch(self, candidate):  # pragma: no cover - never reached
            raise AssertionError

    broken = type(settings)(
        type(settings.providers)(
            sources=Exploding(),
            extractor=settings.providers.extractor,
            reviewer=settings.providers.reviewer,
        ),
        budget=settings.budget,
        timestamp=settings.timestamp,
    )

    report = asyncio.run(
        run_creators([library.creators["contoso-ai"]], broken, run_id="run-test")
    )
    proposal = report.proposals[0]

    assert proposal.status is ProposalStatus.FAILED
    assert report.failed_creator_ids == ("contoso-ai",)
    assert proposal.failures[0].kind is FailureKind.INTERNAL_ERROR
    assert proposal.claims == ()
