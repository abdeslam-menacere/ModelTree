"""Every ledger method that charges a spending counter guards on the clock.

`FailureKind.INTERNAL_ERROR` is constructed at exactly one site
(`runner.py::_failed_proposal`) and is currently unreachable from the budget
path only by convention: every `BudgetLedger` method that spends a resource
calls `check_time()` first, so a time overrun surfaces as a structured
`BUDGET_EXHAUSTED("seconds")` rather than escaping as an internal-error
traceback. Nothing in the suite pinned that convention, so a sixth charging
site added without the guard would break it silently — the suite would stay
green and the breakage would surface only as an internal-error proposal in
production. These tests pin it directly: they discover the charging methods by
introspection (not a hardcoded list, which would be its own stale-count
defect), so adding an unguarded charge makes them fail.

`record_retry` deliberately does **not** call `check_time()` and must not be
"fixed": a retry does not consume the time budget, and its only caller
(`workflow.py`) is off the timed charging path. It is the single documented
exemption, asserted narrowly below so the exemption cannot quietly widen.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent / "src" / "modeltree_updater"
BUDGETS_SOURCE = PACKAGE_ROOT / "budgets.py"

LEDGER_CLASS = "BudgetLedger"
GUARD = "check_time"

# The counters a charge spends. Membership here is not the invariant — the
# invariant is "a method that mutates one of these must guard on the clock";
# this set only names what "spending" means, and lives right next to the
# counter definitions in budgets.py, so a new counter is a visible change here.
SPENDING_COUNTERS = frozenset({"pages_fetched", "tokens_used", "retries_used"})

# The one method allowed to spend without guarding, and why. A retry does not
# consume wall-clock budget, so it needs no time check; it is charged off the
# timed path. Kept as a single named exemption so widening it is a visible edit.
GUARD_EXEMPT = frozenset({"record_retry"})


def _ledger_methods(source: str) -> dict[str, ast.FunctionDef]:
    """Every method defined on the ledger class, keyed by name."""
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == LEDGER_CLASS:
            return {
                child.name: child
                for child in node.body
                if isinstance(child, ast.FunctionDef)
            }
    raise AssertionError(f"{LEDGER_CLASS} not found in {BUDGETS_SOURCE}")


def _mutates_a_counter(method: ast.FunctionDef) -> bool:
    """True when the method does `self.<counter> += ...` for a spending counter."""
    for node in ast.walk(method):
        if not isinstance(node, ast.AugAssign):
            continue
        target = node.target
        if (
            isinstance(target, ast.Attribute)
            and isinstance(target.value, ast.Name)
            and target.value.id == "self"
            and target.attr in SPENDING_COUNTERS
        ):
            return True
    return False


def _calls_guard(method: ast.FunctionDef) -> bool:
    """True when the method calls `self.check_time()` somewhere in its body."""
    for node in ast.walk(method):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == GUARD
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "self"
        ):
            return True
    return False


def _charging_methods(source: str) -> dict[str, ast.FunctionDef]:
    return {
        name: method
        for name, method in _ledger_methods(source).items()
        if _mutates_a_counter(method)
    }


def _read_source() -> str:
    return BUDGETS_SOURCE.read_text(encoding="utf-8")


def test_the_discovery_actually_finds_the_known_charging_methods() -> None:
    """A detector that finds nothing would pass vacuously. The three known
    charging methods must be discovered, or the invariant test below is empty."""
    charging = set(_charging_methods(_read_source()))
    assert {"charge_pages", "charge_tokens", "record_retry"} <= charging


def test_every_charging_method_guards_on_the_clock_or_is_the_named_exemption() -> None:
    """The invariant nothing else pins: a ledger method that spends must call
    `check_time()` first, so a time overrun becomes a structured
    BUDGET_EXHAUSTED rather than an internal-error proposal in production."""
    source = _read_source()
    unguarded = {
        name
        for name, method in _charging_methods(source).items()
        if not _calls_guard(method) and name not in GUARD_EXEMPT
    }
    assert unguarded == set(), (
        "charging method(s) spend without calling check_time() and are not the "
        f"documented exemption: {sorted(unguarded)}"
    )


def test_record_retry_is_the_only_exemption_and_it_is_deliberately_unguarded() -> None:
    """`record_retry` must stay exempt-by-design: it charges a counter but does
    not call the clock guard, because a retry does not spend time budget. This
    pins that as correct, and pins that nothing else quietly joins it."""
    charging = _charging_methods(_read_source())
    assert "record_retry" in charging
    assert not _calls_guard(charging["record_retry"])

    exempt_in_practice = {
        name for name, method in charging.items() if not _calls_guard(method)
    }
    assert exempt_in_practice == set(GUARD_EXEMPT)


# --- Non-vacuity: the detector fails on an unguarded charge and passes on a
# guarded one. Without these, a detector that never fires would look like proof.

_UNGUARDED_CHARGE = (
    f"class {LEDGER_CLASS}:\n"
    "    def charge_widgets(self, count: int) -> None:\n"
    "        self.tokens_used += count\n"
)

_GUARDED_CHARGE = (
    f"class {LEDGER_CLASS}:\n"
    "    def charge_widgets(self, count: int) -> None:\n"
    "        self.check_time()\n"
    "        self.tokens_used += count\n"
)


def _unguarded_names(source: str) -> set[str]:
    return {
        name
        for name, method in _charging_methods(source).items()
        if not _calls_guard(method) and name not in GUARD_EXEMPT
    }


def test_a_sixth_unguarded_charge_site_is_detected() -> None:
    """The proof the invariant test is not vacuous: a new charging method with
    no clock guard is reported, which is exactly what would break in production."""
    assert _unguarded_names(_UNGUARDED_CHARGE) == {"charge_widgets"}


def test_the_same_charge_site_guarded_is_not_flagged() -> None:
    """The counterweight: adding the guard clears the report, so the detector
    keys on the missing guard and not merely on the counter mutation."""
    assert _unguarded_names(_GUARDED_CHARGE) == set()


def test_the_current_module_passes_its_own_detector() -> None:
    """The live budgets.py has no unguarded charge outside the exemption."""
    assert _unguarded_names(_read_source()) == set()
