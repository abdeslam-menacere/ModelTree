"""Budgets refuse work before it happens and say which resource ran out."""

from __future__ import annotations

import pytest

from modeltree_updater.budgets import (
    BudgetExhausted,
    BudgetLedger,
    CreatorBudget,
    InvalidBudget,
)


def test_from_env_reads_every_limit() -> None:
    budget = CreatorBudget.from_env(
        {
            "MODELTREE_UPDATER_MAX_PAGES": "3",
            "MODELTREE_UPDATER_MAX_TOKENS": "500",
            "MODELTREE_UPDATER_MAX_SECONDS": "9.5",
            "MODELTREE_UPDATER_MAX_RETRIES": "1",
        }
    )

    assert (budget.max_pages, budget.max_tokens, budget.max_seconds, budget.max_retries) == (
        3,
        500,
        9.5,
        1,
    )


def test_page_budget_refuses_the_charge_that_would_exceed_it() -> None:
    ledger = BudgetLedger(CreatorBudget(max_pages=1), clock=lambda: 0.0)
    ledger.charge_pages(1)

    with pytest.raises(BudgetExhausted) as error:
        ledger.charge_pages(1)

    assert error.value.resource == "pages"
    assert ledger.pages_fetched == 1
    assert ledger.snapshot().exhausted_by == ("pages",)


def test_token_and_retry_budgets_are_tracked_separately() -> None:
    ledger = BudgetLedger(CreatorBudget(max_tokens=10, max_retries=1), clock=lambda: 0.0)
    ledger.charge_tokens(10)
    ledger.record_retry()

    with pytest.raises(BudgetExhausted):
        ledger.charge_tokens(1)
    with pytest.raises(BudgetExhausted):
        ledger.record_retry()

    usage = ledger.snapshot()
    assert usage.tokens_used == 10
    assert usage.retries_used == 1
    assert set(usage.exhausted_by) == {"tokens", "retries"}


def test_time_budget_uses_the_injected_clock() -> None:
    ticks = iter([0.0, 5.0, 5.0])
    ledger = BudgetLedger(CreatorBudget(max_seconds=2.0), clock=lambda: next(ticks))

    with pytest.raises(BudgetExhausted) as error:
        ledger.check_time()

    assert error.value.resource == "seconds"


def test_the_ledgers_time_resource_name_is_the_publishers_measured_resource() -> None:
    """The producer/owner coupling for the measured resource, pinned for its own sake.

    `budgets.py` *produces* the measured-resource name into `exhausted_by`; the
    constant `publisher.MEASURED_RESOURCE` *owns* it, and every
    `detail.get("resource") == MEASURED_RESOURCE` predicate in production and in
    the publisher tests reads that owner. Nothing else asserts the two agree by
    construction rather than by coincidence of spelling: before this test the pair
    was caught only incidentally, by a `test_publisher.py` assertion whose stated
    subject is exhaustion rendering, not this coupling. Deleting *this* test
    removes that guarantee visibly, which is the whole point of giving it its own
    name — see abdeslam-menacere/ModelTree#411.

    Both sides are DERIVED, never restated: the resource name appears nowhere in
    this test. The produced side is read back out of a ledger genuinely exhausted
    by its time limit, and compared against the imported constant. A unilateral
    edit of either side — the ledger's literal or the constant — breaks the
    equality and reddens here, in either direction.
    """
    from modeltree_updater.publisher import MEASURED_RESOURCE

    ticks = iter([0.0, 5.0, 5.0])
    ledger = BudgetLedger(CreatorBudget(max_seconds=2.0), clock=lambda: next(ticks))

    with pytest.raises(BudgetExhausted) as error:
        ledger.check_time()

    # Anti-vacuity: the ledger really did stop on the time budget, so the name
    # under test is the one the producer emits for an exhausted seconds limit
    # rather than an unset default.
    assert error.value.resource in ledger.snapshot().exhausted_by
    assert error.value.resource == MEASURED_RESOURCE


def test_state_round_trip_keeps_spending_the_same_budget() -> None:
    ledger = BudgetLedger(CreatorBudget(max_pages=2), clock=lambda: 0.0)
    ledger.charge_pages(1)

    resumed = BudgetLedger.from_state(CreatorBudget(max_pages=2), ledger.state(), clock=lambda: 0.0)
    resumed.charge_pages(1)

    assert resumed.pages_fetched == 2
    with pytest.raises(BudgetExhausted):
        resumed.charge_pages(1)


def test_invalid_budgets_are_rejected() -> None:
    with pytest.raises(InvalidBudget):
        CreatorBudget(max_pages=-1)
    with pytest.raises(InvalidBudget):
        CreatorBudget(max_seconds=0)


def test_an_invalid_budget_is_still_a_value_error() -> None:
    """A named type for the CLI to catch, without breaking callers that don't."""
    assert issubclass(InvalidBudget, ValueError)


@pytest.mark.parametrize(
    "variable,value",
    [
        ("MODELTREE_UPDATER_MAX_PAGES", "lots"),
        ("MODELTREE_UPDATER_MAX_TOKENS", ""),
        ("MODELTREE_UPDATER_MAX_SECONDS", "soon"),
        ("MODELTREE_UPDATER_MAX_RETRIES", "2.5"),
    ],
)
def test_a_non_numeric_environment_variable_names_itself(variable: str, value: str) -> None:
    """The message has to say which variable, or it is not actionable."""
    with pytest.raises(InvalidBudget) as error:
        CreatorBudget.from_env({variable: value})

    assert variable in str(error.value)
    assert repr(value) in str(error.value)


def test_an_unset_environment_keeps_the_defaults() -> None:
    assert CreatorBudget.from_env({}) == CreatorBudget()
