"""Every site in `budgets.py` that charges a spending counter is accounted for.

`FailureKind.INTERNAL_ERROR` is constructed at exactly one site
(`runner.py::_failed_proposal`) and is currently unreachable from the budget
path only by convention: every `BudgetLedger` method that spends a resource
calls `check_time()` before it spends, so a time overrun surfaces as a
structured `BudgetExhausted("seconds")` rather than escaping as an
internal-error traceback. Nothing else in the suite pins that convention, so a
sixth charging site added without the guard would break it silently.

Two things could make this file decay into decoration, and both are closed here
rather than accepted:

*Stale method list.* The charging methods are **discovered** from `budgets.py`,
never listed. Adding a charging method changes what these tests analyse.

*Stale counter list.* The counters a charge spends are **derived** too. Naming
them in a frozenset here — as this file used to — only moved the staleness from
method names to counter names: a brand-new counter (`self.bytes_downloaded +=
n`) was the likeliest shape of a real sixth charge site and was silently
uncovered, because it was not in the hardcoded set. `_spending_counters` now
reads them out of `BudgetLedger.__init__` (public `self.<name>` seeded from a
numerically annotated parameter), and
`test_the_counter_set_matches_the_constructed_ledger` cross-checks that
derivation against runtime introspection of a real `BudgetLedger`, so a counter
the AST rule cannot see fails loudly instead of narrowing the coverage. See #249.

The detector also has to be hard to walk around, without crying wolf. It reads
`+=`, plain re-assignment, annotated assignment, `for`/`with` binding, and
`setattr(self, ...)` (including a computed attribute name, which is an opaque
bypass in a ledger), and it follows `self._helper(...)` delegation in both
directions: an unguarded caller is reported through its helper, while a caller
that guards *before* delegating clears the helper it calls. Counterweights below
pin what must stay quiet — reads, private attributes, another object's counters,
and the constructor seeding every counter it owns.

Ordering is pinned, not just presence. `check_time()` must precede the charge on
the path, which is what "refused *before* work happens" in the `budgets.py`
module docstring means and what the word "first" in this file used to assert
without any test holding it. Both directions are reported separately:
`_unguarded` is the invariant that keeps `INTERNAL_ERROR` unreachable (which
holds whatever the order), and `_late_guard` is the weaker ordering claim.

The non-vacuity proofs analyse the real module with one edit spliced in, and
subtract the real module's own report, so each proof measures only its own
injection. A regression in `budgets.py` then fails the module-level tests once
rather than reddening every proof at the same time.

`record_retry` deliberately does **not** call `check_time()` and must not be
"fixed": a retry does not consume the time budget, and its only caller
(`workflow.py`) is off the timed charging path. It is the single documented
exemption, asserted narrowly below so the exemption cannot quietly widen.

*Stale scope.* The analysed region is the **module**, not the ledger class. This
file used to walk one `ast.ClassDef` and nothing else, so a charge site written
anywhere else in `budgets.py` — a module-level function, a module-level
statement, another class — was not merely uncovered, it was invisible, and the
whole suite stayed green on it. That is the #249 defect one scope level up, and
it fails *open*: green read as "the guard is enforced everywhere". See #335.

Widening the guard rule itself was not possible, and pretending otherwise would
have been the quiet kind of wrong. That rule keys on `self`, on delegation
between methods of one class, and on a guard spelled `self.check_time()`; none
of those exist at module level. So `budgets.py` is covered by two rules that
between them leave nothing out, and the boundary between them is stated rather
than left to a traversal:

*Inside `BudgetLedger`* — spend, but guard the clock first. Unchanged.

*Everywhere else in the module* — do not spend at all. A counter write outside
the ledger is refused whether or not it consults the clock, and that asymmetry
is the point rather than an oversight: `check_time()` is only one of the two
things a charging method does. `charge_pages` also tests the page limit and
routes the refusal through `_exhaust`, so an outside writer that dutifully
called `check_time()` would still spend past `max_pages` without ever raising
`BudgetExhausted("pages")`. The clock guard cannot restore a property that
encapsulation was carrying. The counters belong to the ledger, and the fix for
any such site is a ledger method. There are no such sites today, so there is no
exemption list to keep honest; if one is ever genuinely justified it belongs
here, named and reasoned, in the shape `GUARD_EXEMPT` already uses.

Two limits of that second rule, stated because a reader will otherwise assume
they were handled. It is name-based, so `self.pages_fetched` on some *other*
class in this module reads as a charge; in a module this small a second object
holding a ledger counter's name is worth a look either way, and the failure
names the site so the look is cheap. And a class nested *inside* `BudgetLedger`
falls between both rules — inside the ledger's subtree, so the module rule skips
it, but not a method of the ledger, so the guard rule never walks it. Rather
than build machinery for a shape that has never existed, that gap is closed by
refusal: `test_the_guard_rule_reaches_every_function_inside_the_ledger_class`
compares what the guard rule walks against every function the class contains, so
the shape cannot arrive quietly — it arrives red.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from modeltree_updater.budgets import BudgetLedger, CreatorBudget

PACKAGE_ROOT = Path(__file__).resolve().parent.parent / "src" / "modeltree_updater"
BUDGETS_SOURCE = PACKAGE_ROOT / "budgets.py"

LEDGER_CLASS = "BudgetLedger"
GUARD = "check_time"

# The constructor establishes starting state rather than spending it: it seeds
# every counter by plain assignment, and a ledger cannot overrun a clock it is
# only just starting. Excluded from the charge analysis for that reason, and
# `test_the_constructor_seeds_every_counter_and_is_not_a_charge` pins that the
# exclusion is load-bearing rather than vacuous.
CONSTRUCTOR = "__init__"

# The one method allowed to spend without guarding, and why. A retry does not
# consume wall-clock budget, so it needs no time check; it is charged off the
# timed path. Kept as a single named exemption so widening it is a visible edit.
GUARD_EXEMPT = frozenset({"record_retry"})

# Annotations that mark a constructor parameter as a usage counter rather than
# collaborating state. `budget: CreatorBudget` and `clock: Callable[[], float]`
# are neither, which is what keeps them out of the derived set.
NUMERIC_ANNOTATIONS = frozenset({"int", "float"})

# Stands in for `setattr(self, name, ...)` where the attribute name is computed.
# It cannot be resolved to a counter, so it is treated as one: an unresolvable
# write to the ledger is exactly the shape of a deliberate bypass.
COMPUTED = "<computed>"

# Which receiver a write has to be on to count. The guard rule inside the class
# means `self` and only `self` — `other.tokens_used` is another run's budget and
# that ledger's methods' business, which the counterweights below pin. The
# module rule outside the class has no `self` to key on and nothing to learn
# from the object being written to, so it matches any receiver.
SELF = "self"
ANY_RECEIVER = "<any>"

# What a charge outside every function is reported against.
MODULE_SCOPE = "<module>"

_METHOD_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)


# --- Reading budgets.py ------------------------------------------------------


def _read_source() -> str:
    return BUDGETS_SOURCE.read_text(encoding="utf-8")


def _ledger_class_in(tree: ast.Module) -> ast.ClassDef:
    """The ledger class inside an already-parsed module.

    Takes the tree rather than the source because the module rule compares the
    class against the whole module by node identity, and two `ast.parse` calls
    on the same text produce two disjoint sets of nodes.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == LEDGER_CLASS:
            return node
    raise AssertionError(f"{LEDGER_CLASS} not found in {BUDGETS_SOURCE}")


def _ledger_class(source: str) -> ast.ClassDef:
    return _ledger_class_in(ast.parse(source))


def _ledger_methods(source: str) -> dict[str, ast.AST]:
    """Every method defined on the ledger class, keyed by name."""
    return {
        child.name: child
        for child in _ledger_class(source).body
        if isinstance(child, _METHOD_NODES)
    }


# --- What counts as writing to the ledger ------------------------------------


def _receiver_attr(node: ast.AST | None, receiver: str) -> str | None:
    """`<receiver>.<name>` -> `<name>`; anything else -> None.

    `ANY_RECEIVER` matches whatever the write is made on, including a chained
    expression like `run.ledger.pages_fetched`. Both rules read attributes
    through here so that neither can learn a form the other has not.
    """
    if not isinstance(node, ast.Attribute):
        return None
    if receiver == ANY_RECEIVER:
        return node.attr
    if isinstance(node.value, ast.Name) and node.value.id == receiver:
        return node.attr
    return None


def _self_attr(node: ast.AST | None) -> str | None:
    """`self.<name>` -> `<name>`; anything else -> None."""
    return _receiver_attr(node, SELF)


def _target_attrs(target: ast.AST | None, receiver: str) -> set[str]:
    """The `<receiver>.<name>` attributes an assignment target binds."""
    if target is None:
        return set()
    if isinstance(target, (ast.Tuple, ast.List)):
        found: set[str] = set()
        for element in target.elts:
            found |= _target_attrs(element, receiver)
        return found
    if isinstance(target, ast.Starred):
        return _target_attrs(target.value, receiver)
    attr = _receiver_attr(target, receiver)
    return {attr} if attr is not None else set()


def _setattr_attrs(node: ast.Call, receiver: str) -> set[str]:
    """`setattr(self, "x", ...)` -> {"x"}; a computed name -> the sentinel."""
    if not (isinstance(node.func, ast.Name) and node.func.id == "setattr"):
        return set()
    if len(node.args) < 2:
        return set()
    if receiver != ANY_RECEIVER and not (
        isinstance(node.args[0], ast.Name) and node.args[0].id == receiver
    ):
        return set()
    name = node.args[1]
    if isinstance(name, ast.Constant) and isinstance(name.value, str):
        return {name.value}
    return {COMPUTED}


def _written_attrs(node: ast.AST, receiver: str) -> set[str]:
    """The `<receiver>.<name>` attributes this single node writes.

    Every binding form Python offers for an attribute, so that a plain
    re-assignment is not a free bypass of a detector that only reads `+=`.
    """
    if isinstance(node, ast.AugAssign):
        return _target_attrs(node.target, receiver)
    if isinstance(node, ast.AnnAssign):
        return _target_attrs(node.target, receiver) if node.value is not None else set()
    if isinstance(node, ast.Assign):
        found: set[str] = set()
        for target in node.targets:
            found |= _target_attrs(target, receiver)
        return found
    if isinstance(node, (ast.For, ast.AsyncFor)):
        return _target_attrs(node.target, receiver)
    if isinstance(node, (ast.With, ast.AsyncWith)):
        found = set()
        for item in node.items:
            found |= _target_attrs(item.optional_vars, receiver)
        return found
    if isinstance(node, ast.Call):
        return _setattr_attrs(node, receiver)
    return set()


# --- Deriving the counters from the production type --------------------------


def _is_numeric_annotation(node: ast.AST | None) -> bool:
    if isinstance(node, ast.Name):
        return node.id in NUMERIC_ANNOTATIONS
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value.strip() in NUMERIC_ANNOTATIONS
    return False


def _spending_counters(source: str) -> frozenset[str]:
    """The counters a charge spends, read out of `BudgetLedger.__init__`.

    A spending counter is a public `self.<name>` seeded from a constructor
    parameter annotated `int` or `float`. That excludes `self.budget` (a
    `CreatorBudget`) and `self._carried_elapsed` (private: elapsed time is
    measured by the clock, not charged), and it picks up any counter a later
    change adds without this file being edited.
    """
    init = _ledger_methods(source).get(CONSTRUCTOR)
    if init is None:
        raise AssertionError(f"{LEDGER_CLASS}.{CONSTRUCTOR} not found in {BUDGETS_SOURCE}")
    arguments = init.args
    numeric = {
        argument.arg
        for argument in (
            *arguments.posonlyargs,
            *arguments.args,
            *arguments.kwonlyargs,
        )
        if _is_numeric_annotation(argument.annotation)
    }
    counters: set[str] = set()
    for node in ast.walk(init):
        if isinstance(node, ast.Assign):
            value, targets = node.value, node.targets
        elif isinstance(node, ast.AnnAssign):
            value, targets = node.value, [node.target]
        else:
            continue
        if not (isinstance(value, ast.Name) and value.id in numeric):
            continue
        for target in targets:
            counters |= {
                attr
                for attr in _target_attrs(target, SELF)
                if not attr.startswith("_")
            }
    return frozenset(counters)


def _constructed_counters() -> frozenset[str]:
    """The same set, read off a real ledger instead of out of its source."""
    ledger = BudgetLedger(CreatorBudget())
    return frozenset(
        name
        for name, value in vars(ledger).items()
        if not name.startswith("_")
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
    )


# --- Charge paths ------------------------------------------------------------


@dataclass(frozen=True, order=True)
class Charge:
    """A counter written on a path that did not guard the clock first."""

    entry: str
    method: str
    counter: str


def _is_guard_call(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == GUARD
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "self"
    )


def _delegate(node: ast.AST, methods: dict[str, ast.AST]) -> str | None:
    """`self.<other_method>(...)` -> the method's name, so helpers are followed."""
    if not isinstance(node, ast.Call):
        return None
    attr = _self_attr(node.func)
    if attr is None or attr == GUARD or attr not in methods:
        return None
    return attr


def _events(
    method: ast.AST, methods: dict[str, ast.AST], counters: frozenset[str]
) -> list[tuple[tuple[int, int], str, str]]:
    """Guards, charges and delegations in this method, in source order.

    Source order stands in for execution order. It is an approximation, and a
    deliberately one-sided one: it can miss a guard that only runs on some
    branches, but it never invents a violation for straight-line code, so the
    error is toward silence rather than toward crying wolf.
    """
    events: list[tuple[tuple[int, int], str, str]] = []
    for node in ast.walk(method):
        position = (getattr(node, "lineno", 0), getattr(node, "col_offset", 0))
        if _is_guard_call(node):
            events.append((position, "guard", GUARD))
            continue
        for attr in sorted(_written_attrs(node, SELF)):
            if attr in counters or attr == COMPUTED:
                events.append((position, "charge", attr))
        delegate = _delegate(node, methods)
        if delegate is not None:
            events.append((position, "call", delegate))
    events.sort(key=lambda event: event[0])
    return events


def _entry_points(methods: dict[str, ast.AST]) -> list[str]:
    """Where a charge path can start: the public API, plus any private helper
    nothing on the class calls (which callers cannot clear on its behalf)."""
    called = {
        delegate
        for method in methods.values()
        for node in ast.walk(method)
        if (delegate := _delegate(node, methods)) is not None
    }
    return sorted(
        name
        for name in methods
        if name != CONSTRUCTOR and (not name.startswith("_") or name not in called)
    )


def _reaches_guard(
    name: str, methods: dict[str, ast.AST], seen: frozenset[str] = frozenset()
) -> bool:
    """True when the clock guard is called anywhere on or below this method."""
    if name in seen:
        return False
    seen = seen | {name}
    method = methods[name]
    if any(_is_guard_call(node) for node in ast.walk(method)):
        return True
    return any(
        _reaches_guard(delegate, methods, seen)
        for node in ast.walk(method)
        if (delegate := _delegate(node, methods)) is not None
    )


# --- Charges outside the ledger class ----------------------------------------
#
# The second of the two rules. The first one above cannot be stretched to cover
# this ground — it keys on `self`, on delegation between methods of one class,
# and on `self.check_time()`, none of which exist at module level — so the
# widening happens here, and refuses rather than guards. The module docstring
# gives the reasoning; this is the mechanism.


@dataclass(frozen=True, order=True)
class OutsideCharge:
    """A spending counter written by code that is not a `BudgetLedger` method."""

    scope: str
    counter: str


def _scopes(tree: ast.Module) -> dict[int, str]:
    """Every node keyed to the qualified name of the scope that lexically holds it.

    Reporting only. Violations are found by walking nodes rather than scopes, so
    a charge site that sits in no function at all is found like any other and
    named `<module>` here.
    """
    scopes: dict[int, str] = {id(tree): MODULE_SCOPE}

    def descend(node: ast.AST, scope: str, prefix: str) -> None:
        for child in ast.iter_child_nodes(node):
            scopes[id(child)] = scope
            if isinstance(child, (*_METHOD_NODES, ast.ClassDef)):
                qualified = f"{prefix}{child.name}"
                descend(child, qualified, f"{qualified}.")
            else:
                descend(child, scope, prefix)

    descend(tree, MODULE_SCOPE, "")
    return scopes


def _charges_outside_the_ledger(source: str) -> frozenset[OutsideCharge]:
    """Every write to a spending counter that is not inside `BudgetLedger`.

    `ast.walk` over the whole module minus the ledger's own subtree, which is
    what makes this rule scope-blind by construction: module-level statements,
    module-level functions, other classes and anything nested in them are all
    covered without any of those shapes being enumerated, so the next shape
    nobody thought of is covered too. The counters come from the same derivation
    the guard rule uses and the write forms from the same `_written_attrs`, so
    widening either widens both rules at once rather than one of them.
    """
    tree = ast.parse(source)
    inside_the_ledger = {id(node) for node in ast.walk(_ledger_class_in(tree))}
    counters = _spending_counters(source)
    scopes = _scopes(tree)
    return frozenset(
        OutsideCharge(scopes[id(node)], attr)
        for node in ast.walk(tree)
        if id(node) not in inside_the_ledger
        for attr in _written_attrs(node, ANY_RECEIVER)
        if attr in counters or attr == COMPUTED
    )


def _ledger_function_coverage(source: str) -> tuple[set[int], set[int]]:
    """`(functions the guard rule walks, functions the ledger class contains)`.

    Read off one parse, because they are compared by node identity. The guard
    rule starts from the class body's own methods and follows `ast.walk` into
    each, so a function the ledger holds some other way — inside a nested class,
    say — is in the second set and not the first, and is analysed by neither
    rule. That difference is what the coverage test refuses.
    """
    tree = ast.parse(source)
    ledger = _ledger_class_in(tree)
    walked = {
        id(node)
        for child in ledger.body
        if isinstance(child, _METHOD_NODES)
        for node in ast.walk(child)
        if isinstance(node, _METHOD_NODES)
    }
    contained = {id(node) for node in ast.walk(ledger) if isinstance(node, _METHOD_NODES)}
    return walked, contained


def _report(
    source: str,
) -> tuple[frozenset[Charge], frozenset[Charge], frozenset[OutsideCharge]]:
    """`(never guarded, guarded too late, spent outside the ledger)`."""
    methods = _ledger_methods(source)
    counters = _spending_counters(source)
    charges: set[Charge] = set()

    def visit(entry: str, name: str, guarded: bool, seen: frozenset[str]) -> bool:
        if name in seen:
            return guarded
        seen = seen | {name}
        for _position, kind, payload in _events(methods[name], methods, counters):
            if kind == "guard":
                guarded = True
            elif kind == "charge":
                if not guarded:
                    charges.add(Charge(entry, name, payload))
            else:
                guarded = visit(entry, payload, guarded, seen)
        return guarded

    for entry in _entry_points(methods):
        if entry in GUARD_EXEMPT:
            continue
        visit(entry, entry, False, frozenset())

    unguarded = {charge for charge in charges if not _reaches_guard(charge.entry, methods)}
    return (
        frozenset(unguarded),
        frozenset(charges - unguarded),
        _charges_outside_the_ledger(source),
    )


def _unguarded(source: str) -> set[str]:
    """Methods that write a counter on a path that never guards the clock."""
    return {charge.method for charge in _report(source)[0]}


def _late_guard(source: str) -> set[str]:
    """Methods that write a counter before the guard that covers them runs."""
    return {charge.method for charge in _report(source)[1]}


def _charging_methods(source: str) -> set[str]:
    """Every ledger method that writes a counter itself, constructor aside."""
    counters = _spending_counters(source)
    return {
        name
        for name, method in _ledger_methods(source).items()
        if name != CONSTRUCTOR
        and any(_written_attrs(node, SELF) & counters for node in ast.walk(method))
    }


# --- Scratch copies of the real module, for the non-vacuity proofs -----------


NEW_COUNTER = "bytes_downloaded"


def _extend_ledger(source: str, method_source: str) -> str:
    """A copy of `source` with `method_source` appended to the ledger class."""
    end = _ledger_class(source).end_lineno
    lines = source.splitlines(keepends=True)
    return "".join(lines[:end]) + method_source + "".join(lines[end:])


def _add_counter(source: str, counter: str) -> str:
    """A copy of `source` with one more spending counter on the ledger.

    The insertion points are found structurally — after the last keyword-only
    constructor parameter and after the last statement that seeds a counter — so
    this keeps working when `budgets.py` is reformatted or reordered.
    """
    init = _ledger_methods(source)[CONSTRUCTOR]
    if counter in _spending_counters(source):
        raise AssertionError(
            f"{LEDGER_CLASS} already has a {counter!r} counter, so injecting one "
            "would produce a duplicate parameter rather than a new counter. Pick "
            "another name for NEW_COUNTER."
        )
    parameter = init.args.kwonlyargs[-1]
    seeds = [
        node
        for node in ast.walk(init)
        if isinstance(node, ast.Assign)
        and _target_attrs(node.targets[0], SELF) & _spending_counters(source)
    ]
    last_seed = max(seeds, key=lambda node: node.lineno)
    lines = source.splitlines(keepends=True)
    # Later line first, so the earlier insertion point stays valid.
    lines.insert(
        last_seed.lineno,
        f"{' ' * last_seed.col_offset}self.{counter} = {counter}\n",
    )
    lines.insert(
        parameter.lineno,
        f"{' ' * parameter.col_offset}{counter}: int = 0,\n",
    )
    return "".join(lines)


def _extend_module(source: str, addition: str) -> str:
    """A copy of `source` with `addition` appended at module level.

    Column-zero code appended past the end of a file is module level whatever
    precedes it, so this needs no structural anchor the way `_extend_ledger`
    does — and it is the exact shape #335 planted in the real `budgets.py` to
    prove the class-scoped rule could not see it.
    """
    return source + addition


_UNGUARDED_AUG = """
    def charge_widgets(self, count: int) -> None:
        self.tokens_used += count
"""

_UNGUARDED_ASSIGN = """
    def charge_widgets(self, count: int) -> None:
        self.tokens_used = self.tokens_used + count
"""

_UNGUARDED_SETATTR = """
    def charge_widgets(self, count: int) -> None:
        setattr(self, "tokens_used", self.tokens_used + count)
"""

_UNGUARDED_COMPUTED_SETATTR = """
    def charge_widgets(self, name: str, count: int) -> None:
        setattr(self, name, count)
"""

_UNGUARDED_HELPER_AUG = """
    def charge_widgets(self, count: int) -> None:
        self._bump_widgets(count)

    def _bump_widgets(self, count: int) -> None:
        self.tokens_used += count
"""

_UNGUARDED_HELPER_ASSIGN = """
    def charge_widgets(self, count: int) -> None:
        self._bump_widgets(count)

    def _bump_widgets(self, count: int) -> None:
        self.tokens_used = self.tokens_used + count
"""

_LATE_GUARD = """
    def charge_widgets(self, count: int) -> None:
        self.tokens_used += count
        self.check_time()
"""

_GUARDED_AUG = """
    def charge_widgets(self, count: int) -> None:
        self.check_time()
        self.tokens_used += count
"""

_GUARDED_HELPER = """
    def charge_widgets(self, count: int) -> None:
        self.check_time()
        self._bump_widgets(count)

    def _bump_widgets(self, count: int) -> None:
        self.tokens_used += count
"""

_READS_A_COUNTER = """
    def widgets_left(self) -> int:
        return self.budget.max_tokens - self.tokens_used
"""

_WRITES_ANOTHER_LEDGER = """
    def copy_widgets_into(self, other: "BudgetLedger") -> None:
        other.tokens_used += self.tokens_used
"""

_WRITES_A_PRIVATE_ATTRIBUTE = """
    def note_widgets(self, count: int) -> None:
        self._widget_notes = count
"""

_NEW_COUNTER_UNGUARDED = f"""
    def charge_bytes(self, count: int) -> None:
        self.{NEW_COUNTER} += count
"""

_NEW_COUNTER_GUARDED = f"""
    def charge_bytes(self, count: int) -> None:
        self.check_time()
        self.{NEW_COUNTER} += count
"""

# A class nested inside the ledger: inside its subtree, so the module rule skips
# it, and not a method of it, so the guard rule never walks it. Both rules stay
# quiet and the coverage check is what refuses it.
_LEDGER_NESTED_CLASS = """
    class Nested:
        def charge_widgets(self, count: int) -> None:
            self.tokens_used += count
"""

# --- Injections outside the ledger class. Single-quoted so the reproducer from
# #335 can carry its own docstring verbatim, and the rest match it. -----------

_OUTSIDE_AUG = '''

def charge_pages_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    """A charge site that spends a counter without ever consulting the guard."""
    ledger.pages_fetched += count
'''

_OUTSIDE_ASSIGN = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    ledger.pages_fetched = ledger.pages_fetched + count
'''

_OUTSIDE_SETATTR = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    setattr(ledger, "pages_fetched", ledger.pages_fetched + count)
'''

_OUTSIDE_COMPUTED_SETATTR = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", name: str, n: int) -> None:
    setattr(ledger, name, n)
'''

_OUTSIDE_GUARDED = '''

def guarded_charge_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    ledger.check_time()
    ledger.pages_fetched += count
'''

_OUTSIDE_ANOTHER_CLASS = '''

class PageCounter:
    def charge(self, count: int) -> None:
        self.pages_fetched += count
'''

_OUTSIDE_MODULE_LEVEL = '''

_SHARED = BudgetLedger(CreatorBudget())
_SHARED.pages_fetched = 1
'''

_OUTSIDE_READ = '''

def pages_left(ledger: "BudgetLedger") -> int:
    return ledger.budget.max_pages - ledger.pages_fetched
'''

_OUTSIDE_LOCAL_NAME = '''

def summarise(ledger: "BudgetLedger") -> int:
    pages_fetched = ledger.pages_fetched
    return pages_fetched
'''

_OUTSIDE_OTHER_ATTRIBUTE = '''

def label(ledger: "BudgetLedger", note: str) -> None:
    ledger.note = note
'''

_OUTSIDE_NEW_COUNTER = f'''

def charge_bytes_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    ledger.{NEW_COUNTER} += count
'''


def _variants() -> dict[str, str]:
    """Every scratch source these tests analyse, built from the real module."""
    real = _read_source()
    with_counter = _add_counter(real, NEW_COUNTER)
    return {
        "unguarded_aug": _extend_ledger(real, _UNGUARDED_AUG),
        "unguarded_assign": _extend_ledger(real, _UNGUARDED_ASSIGN),
        "unguarded_setattr": _extend_ledger(real, _UNGUARDED_SETATTR),
        "unguarded_computed_setattr": _extend_ledger(real, _UNGUARDED_COMPUTED_SETATTR),
        "unguarded_helper_aug": _extend_ledger(real, _UNGUARDED_HELPER_AUG),
        "unguarded_helper_assign": _extend_ledger(real, _UNGUARDED_HELPER_ASSIGN),
        "late_guard": _extend_ledger(real, _LATE_GUARD),
        "guarded_aug": _extend_ledger(real, _GUARDED_AUG),
        "guarded_helper": _extend_ledger(real, _GUARDED_HELPER),
        "reads_a_counter": _extend_ledger(real, _READS_A_COUNTER),
        "writes_another_ledger": _extend_ledger(real, _WRITES_ANOTHER_LEDGER),
        "writes_a_private_attribute": _extend_ledger(real, _WRITES_A_PRIVATE_ATTRIBUTE),
        "new_counter_seeded": with_counter,
        "new_counter_unguarded": _extend_ledger(with_counter, _NEW_COUNTER_UNGUARDED),
        "new_counter_guarded": _extend_ledger(with_counter, _NEW_COUNTER_GUARDED),
        "ledger_nested_class": _extend_ledger(real, _LEDGER_NESTED_CLASS),
        "outside_aug": _extend_module(real, _OUTSIDE_AUG),
        "outside_assign": _extend_module(real, _OUTSIDE_ASSIGN),
        "outside_setattr": _extend_module(real, _OUTSIDE_SETATTR),
        "outside_computed_setattr": _extend_module(real, _OUTSIDE_COMPUTED_SETATTR),
        "outside_guarded": _extend_module(real, _OUTSIDE_GUARDED),
        "outside_another_class": _extend_module(real, _OUTSIDE_ANOTHER_CLASS),
        "outside_module_level": _extend_module(real, _OUTSIDE_MODULE_LEVEL),
        "outside_read": _extend_module(real, _OUTSIDE_READ),
        "outside_local_name": _extend_module(real, _OUTSIDE_LOCAL_NAME),
        "outside_other_attribute": _extend_module(real, _OUTSIDE_OTHER_ATTRIBUTE),
        "outside_new_counter": _extend_module(with_counter, _OUTSIDE_NEW_COUNTER),
    }


VARIANTS = _variants()


def _injected(
    variant: str,
) -> tuple[frozenset[Charge], frozenset[Charge], frozenset[OutsideCharge]]:
    """What one injection adds to whatever `budgets.py` already reports.

    Every variant is the real module plus a single edit, so subtracting the
    module's own report keeps each proof below measuring its own injection. A
    real regression in `budgets.py` then fails the module-level tests once,
    instead of turning every proof and counterweight red at the same time and
    burying which idiom actually stopped working.
    """
    real_unguarded, real_late, real_outside = _report(_read_source())
    unguarded, late, outside = _report(VARIANTS[variant])
    return unguarded - real_unguarded, late - real_late, outside - real_outside


def _injected_unguarded(variant: str) -> set[str]:
    return {charge.method for charge in _injected(variant)[0]}


def _injected_late(variant: str) -> set[str]:
    return {charge.method for charge in _injected(variant)[1]}


def _injected_outside(variant: str) -> set[tuple[str, str]]:
    return {(charge.scope, charge.counter) for charge in _injected(variant)[2]}


def _injected_paths(variant: str) -> set[tuple[str, str]]:
    return {(charge.entry, charge.method) for charge in _injected(variant)[0]}


NOTHING: tuple[frozenset[Charge], frozenset[Charge], frozenset[OutsideCharge]] = (
    frozenset(),
    frozenset(),
    frozenset(),
)


# --- The counter set is derived, not declared --------------------------------


def test_the_counter_set_matches_the_constructed_ledger() -> None:
    """The cross-check that keeps the derivation honest. `_spending_counters`
    reads `budgets.py`; `_constructed_counters` asks a real `BudgetLedger` what
    numeric public state it holds. A counter the AST rule cannot see — one added
    without a numeric annotation, say — makes these disagree and fails here,
    rather than quietly narrowing what the invariant below covers."""
    assert _spending_counters(_read_source()) == _constructed_counters()


def test_the_derivation_finds_the_known_counters() -> None:
    """A derivation that returned nothing would make every test below vacuous,
    so the three counters `budgets.py` has today are named once, here.

    This is the only place a counter name is written down, and it is an
    acknowledgement anchor rather than an input: nothing above or below reads
    it, so adding a fourth counter still widens the invariant's coverage
    automatically — it just cannot do so *silently*, because this equality goes
    red until someone has looked at the new counter and updated the list."""
    assert _spending_counters(_read_source()) == {
        "pages_fetched",
        "tokens_used",
        "retries_used",
    }


def test_the_budget_and_the_clock_are_not_mistaken_for_counters() -> None:
    """The counterweight to the test above: collaborating state on the ledger
    must stay out, or every method touching it would be read as a charge."""
    counters = _spending_counters(_read_source())
    assert "budget" not in counters
    assert not any(name.startswith("_") for name in counters)
    assert "elapsed_seconds" not in counters


def test_the_derivation_tracks_a_counter_this_file_has_never_heard_of() -> None:
    """The defect #249 records, closed: a counter added to `budgets.py` is
    discovered here without this file being edited. Under the hardcoded
    frozenset this replaced, `bytes_downloaded` was invisible and every test
    below silently stopped covering it."""
    real = _read_source()
    assert _spending_counters(VARIANTS["new_counter_seeded"]) == _spending_counters(
        real
    ) | {NEW_COUNTER}


def test_no_public_ledger_attribute_is_written_outside_the_derived_counters() -> None:
    """Soundness in the other direction: if a method writes public state the
    derivation did not classify as a counter, the derivation has a blind spot
    and it must be considered rather than assumed harmless."""
    source = _read_source()
    counters = _spending_counters(source)
    written = {
        attr
        for name, method in _ledger_methods(source).items()
        if name != CONSTRUCTOR
        for node in ast.walk(method)
        for attr in _written_attrs(node, SELF)
        if not attr.startswith("_")
    }
    assert written <= counters, (
        "ledger method(s) write public attributes the counter derivation does "
        f"not know about: {sorted(written - counters)}"
    )


# --- The invariant -----------------------------------------------------------


def test_the_discovery_actually_finds_the_known_charging_methods() -> None:
    """A detector that finds nothing would pass vacuously. The three known
    charging methods must be discovered, or the invariant test below is empty."""
    assert {"charge_pages", "charge_tokens", "record_retry"} <= _charging_methods(
        _read_source()
    )


def test_every_charging_method_guards_on_the_clock_or_is_the_named_exemption() -> None:
    """The invariant nothing else pins: a ledger method that spends must call
    `check_time()`, so a time overrun becomes a structured `BudgetExhausted`
    rather than an internal-error proposal in production."""
    unguarded = _report(_read_source())[0]
    assert unguarded == frozenset(), (
        "charge path(s) spend without ever calling check_time() and are not the "
        f"documented exemption: {sorted(unguarded)}"
    )


def test_the_clock_guard_runs_before_the_charge_it_covers() -> None:
    """The stronger, separately reported claim. `INTERNAL_ERROR` stays
    unreachable whichever side of the charge the guard sits, because
    `check_time()` raises `BudgetExhausted` either way — so this is not the
    invariant above. It is the `budgets.py` promise that a budget is "refused
    *before* work happens": a guard that runs afterwards has already spent the
    counter on an expired clock. Pinned here so the word "first" in this file's
    docstring is backed by a test rather than asserted at the reader."""
    late = _report(_read_source())[1]
    assert late == frozenset(), (
        "charge path(s) write a counter before the clock guard that covers them "
        f"runs: {sorted(late)}"
    )


def test_record_retry_is_the_only_exemption_and_it_is_deliberately_unguarded() -> None:
    """`record_retry` must stay exempt-by-design: it charges a counter but does
    not call the clock guard, because a retry does not spend time budget. This
    pins that as correct, and pins that nothing else quietly joins it."""
    source = _read_source()
    methods = _ledger_methods(source)
    assert "record_retry" in _charging_methods(source)
    assert not _reaches_guard("record_retry", methods)

    exempt_in_practice = {
        name
        for name in _entry_points(methods)
        if name in _charging_methods(source) and not _reaches_guard(name, methods)
    }
    assert exempt_in_practice == set(GUARD_EXEMPT)


def test_the_constructor_seeds_every_counter_and_is_not_a_charge() -> None:
    """The constructor plain-assigns all three counters and never calls the
    guard. Excluding it is therefore load-bearing, not a technicality — and the
    exclusion must not leak into the report."""
    source = _read_source()
    counters = _spending_counters(source)
    init = _ledger_methods(source)[CONSTRUCTOR]
    seeded = {
        attr for node in ast.walk(init) for attr in _written_attrs(node, SELF)
    } & counters
    assert seeded == counters
    assert not _reaches_guard(CONSTRUCTOR, _ledger_methods(source))
    assert _unguarded(source) == set()
    assert _late_guard(source) == set()


def test_the_current_module_is_clean_under_the_whole_detector() -> None:
    """The live `budgets.py` has no unguarded charge outside the exemption, no
    charge that runs ahead of its guard, and nothing spending a counter from
    outside the ledger class."""
    assert _report(_read_source()) == NOTHING


# --- Non-vacuity: every idiom the detector claims to read is watched to bite --


def test_an_unguarded_augmented_charge_is_detected() -> None:
    """`self.tokens_used += n` with no guard: the original shape, still caught."""
    assert _injected_unguarded("unguarded_aug") == {"charge_widgets"}


def test_an_unguarded_plain_reassignment_is_detected() -> None:
    """`self.tokens_used = self.tokens_used + n` was a free bypass of a detector
    that only read `ast.AugAssign`. It is not any more."""
    assert _injected_unguarded("unguarded_assign") == {"charge_widgets"}


def test_an_unguarded_setattr_charge_is_detected() -> None:
    """`setattr(self, "tokens_used", ...)` names the counter as a string, which
    no assignment-node check could see."""
    assert _injected_unguarded("unguarded_setattr") == {"charge_widgets"}


def test_a_setattr_with_a_computed_name_is_detected() -> None:
    """A `setattr` whose attribute is computed cannot be resolved to a counter,
    so it is treated as one: an unresolvable write to the ledger is the shape a
    deliberate bypass would take, and `budgets.py` has no legitimate use for it."""
    charges = _injected("unguarded_computed_setattr")[0]
    assert {charge.counter for charge in charges} == {COMPUTED}
    assert _injected_unguarded("unguarded_computed_setattr") == {"charge_widgets"}


def test_an_unguarded_charge_through_a_helper_names_both_methods() -> None:
    """Delegation is followed, and the report names the entry point as well as
    the helper, so the fix is obvious from the failure alone."""
    assert _injected_paths("unguarded_helper_aug") == {
        ("charge_widgets", "_bump_widgets")
    }


def test_an_unguarded_plain_assignment_through_a_helper_is_detected() -> None:
    """The two bypasses combined — indirection plus a plain assign — which the
    hardcoded-counter version of this file let through in both halves."""
    assert _injected_paths("unguarded_helper_assign") == {
        ("charge_widgets", "_bump_widgets")
    }


def test_a_brand_new_counter_charged_without_the_guard_is_detected() -> None:
    """The row from #249 that mattered: a new resource gets metered, a new
    counter appears, and the guard must not silently stop covering it."""
    charges = _injected("new_counter_unguarded")[0]
    assert {(charge.method, charge.counter) for charge in charges} == {
        ("charge_bytes", NEW_COUNTER)
    }


def test_a_guard_that_runs_after_the_charge_is_reported_as_late_not_missing() -> None:
    """The ordering pin biting, and biting in the right bucket: the invariant
    that keeps `INTERNAL_ERROR` unreachable still holds here, so this must not
    be reported as an unguarded charge."""
    assert _injected_late("late_guard") == {"charge_widgets"}
    assert _injected_unguarded("late_guard") == set()


# --- Counterweights: what must stay quiet ------------------------------------


def test_the_same_charge_site_guarded_is_not_flagged() -> None:
    """The detector keys on the missing guard, not merely on the mutation."""
    assert _injected("guarded_aug") == NOTHING


def test_a_guarded_caller_delegating_to_a_mutating_helper_is_not_flagged() -> None:
    """The false positive the old delegation handling produced: a helper that
    writes a counter is legitimate when every caller guards before calling it.
    A guard that cries wolf gets disabled, which is worse than one with gaps."""
    assert _injected("guarded_helper") == NOTHING


def test_a_brand_new_counter_that_is_only_seeded_is_not_flagged() -> None:
    """Adding a counter is not itself a violation. The derivation must widen
    quietly; only an unguarded write to it may go red."""
    assert _injected("new_counter_seeded") == NOTHING


def test_reading_a_counter_is_not_a_charge() -> None:
    """`snapshot()` and `state()` read every counter and guard nothing."""
    assert _injected("reads_a_counter") == NOTHING


def test_writing_another_ledger_s_counter_is_not_a_charge() -> None:
    """The write has to be to `self`; `other.tokens_used` spends another run's
    budget and is that ledger's methods' business."""
    assert _injected("writes_another_ledger") == NOTHING


def test_writing_a_private_attribute_is_not_a_charge() -> None:
    """`_exhausted_by` and friends are bookkeeping, not spending."""
    assert _injected("writes_a_private_attribute") == NOTHING


def test_a_new_counter_charged_with_the_guard_is_not_flagged() -> None:
    """The counterweight to the #249 row: discovering a new counter must not
    make correctly guarded code fail."""
    assert _injected("new_counter_guarded") == NOTHING


# --- The boundary is the module, not the ledger class ------------------------


def test_the_live_module_spends_no_counter_outside_the_ledger_class() -> None:
    """The invariant #335 asked for. `budgets.py` charges its counters from
    ledger methods and nowhere else, so the guard rule above is analysing every
    charge site the module has rather than every charge site it can see."""
    outside = _charges_outside_the_ledger(_read_source())
    assert outside == frozenset(), (
        "spending counter(s) are written outside BudgetLedger, which bypasses "
        "the clock guard and _exhaust together: "
        f"{sorted((charge.scope, charge.counter) for charge in outside)}"
    )


def test_the_guard_rule_reaches_every_function_inside_the_ledger_class() -> None:
    """The scope cross-check, in the spirit #249 applied to counters: the two
    rules must leave no function unanalysed, and the one seam between them —
    a function the ledger contains but no method of it reaches — fails here
    rather than being covered by neither and noticed by nobody."""
    walked, contained = _ledger_function_coverage(_read_source())
    assert walked == contained, (
        "function(s) inside BudgetLedger are analysed by neither rule, because "
        "the guard rule only walks the class body's own methods and the module "
        f"rule skips the class: {len(contained - walked)} unreached"
    )


def test_the_issue_reproducer_is_refused() -> None:
    """#335's reproducer, verbatim: a module-level function spending
    `pages_fetched` with no guard anywhere. The whole suite was green on this.

    Asserted against the variant's own report rather than through `_injected`,
    unlike its neighbours below. The claim here is one-directional — a module
    containing this site is refused — and a delta would cancel to nothing in the
    one case that matters most, the identical site landing in the real
    `budgets.py`. Reporting *that* is the two module-level tests' job."""
    reported = {
        (charge.scope, charge.counter)
        for charge in _charges_outside_the_ledger(VARIANTS["outside_aug"])
    }
    assert ("charge_pages_outside_the_class", "pages_fetched") in reported


def test_an_out_of_class_plain_reassignment_is_detected() -> None:
    """The write forms are read through the same `_written_attrs` as the guard
    rule, so a plain assign is no more a bypass out here than it is in there."""
    assert _injected_outside("outside_assign") == {
        ("charge_widgets_outside_the_class", "pages_fetched")
    }


def test_an_out_of_class_setattr_is_detected() -> None:
    """`setattr(ledger, "pages_fetched", ...)` names the counter as a string."""
    assert _injected_outside("outside_setattr") == {
        ("charge_widgets_outside_the_class", "pages_fetched")
    }


def test_an_out_of_class_setattr_with_a_computed_name_is_detected() -> None:
    """Unresolvable writes are treated as charges outside the class for the same
    reason as inside it: `budgets.py` has no legitimate computed `setattr`, and
    an attribute name the rule cannot read is the shape a bypass would take."""
    assert _injected_outside("outside_computed_setattr") == {
        ("charge_widgets_outside_the_class", COMPUTED)
    }


def test_an_out_of_class_charge_is_refused_even_when_it_guards_the_clock() -> None:
    """The decision this file makes, held by a test so it cannot erode into a
    habit. Outside the ledger the rule is encapsulation, not guarding: this
    site calls `check_time()` and is still refused, because `charge_pages` also
    checks `max_pages` through `_exhaust` and a guarded outside writer skips
    that half — spending past the page limit without a `BudgetExhausted`."""
    assert _injected_outside("outside_guarded") == {
        ("guarded_charge_outside_the_class", "pages_fetched")
    }


def test_a_charge_in_another_class_in_the_module_is_detected() -> None:
    """Another class in `budgets.py` writing `self.pages_fetched` is reported.
    The rule is name-based and cannot tell that object from a ledger, which is
    the stated cost of it: in a module this small a second holder of a ledger
    counter's name is worth a look, and the report names the site."""
    assert _injected_outside("outside_another_class") == {
        ("PageCounter.charge", "pages_fetched")
    }


def test_a_charge_at_module_level_is_detected() -> None:
    """A charge site in no function at all. The rule walks nodes rather than
    functions precisely so this needs no separate handling."""
    assert _injected_outside("outside_module_level") == {
        (MODULE_SCOPE, "pages_fetched")
    }


def test_a_brand_new_counter_spent_outside_the_class_is_detected() -> None:
    """#249's derivation feeds both rules. A counter added to `budgets.py` is
    protected outside the class too, without this file being edited."""
    assert _injected_outside("outside_new_counter") == {
        ("charge_bytes_outside_the_class", NEW_COUNTER)
    }


def test_a_class_nested_inside_the_ledger_is_refused_by_the_coverage_check() -> None:
    """The one seam between the two rules, watched to bite. A charging method
    on a class nested inside `BudgetLedger` is analysed by neither rule — the
    report stays empty, which is exactly why the coverage check exists and why
    it is not decoration."""
    assert _injected("ledger_nested_class") == NOTHING
    walked, contained = _ledger_function_coverage(VARIANTS["ledger_nested_class"])
    assert len(contained - walked) == 1


# --- Counterweights outside the class: what must stay quiet out there ---------


def test_reading_a_counter_outside_the_class_is_not_a_charge() -> None:
    """A helper computing headroom from a ledger spends nothing. The rule keys
    on writes, or every caller of `snapshot()` would be a violation."""
    assert _injected("outside_read") == NOTHING


def test_a_local_name_that_shadows_a_counter_is_not_a_charge() -> None:
    """`pages_fetched = ledger.pages_fetched` binds a local, not an attribute.
    Matching bare names would flag every readable line in the module."""
    assert _injected("outside_local_name") == NOTHING


def test_writing_a_non_counter_attribute_outside_the_class_is_not_a_charge() -> None:
    """The rule is scope-blind, not attribute-blind: `ledger.note = ...` writes
    to a ledger and spends nothing, and `BudgetExhausted.__init__` assigning
    `self.used` and `self.limit` in the live module depends on this staying
    quiet."""
    assert _injected("outside_other_attribute") == NOTHING


# --- The scratch sources are real modules, not strings that happen to parse ---

def test_every_scratch_variant_is_valid_python() -> None:
    """Proof the injections above are honest. A variant that did not compile
    could still be walked by `ast`, so a red result would prove nothing about
    code anyone could actually ship."""
    for name, source in VARIANTS.items():
        compile(source, f"<{name}>", "exec")


def test_every_scratch_variant_still_contains_the_real_ledger() -> None:
    """And that they are the real module plus an edit, not a stand-in class: the
    three production charging methods survive every injection."""
    for name, source in VARIANTS.items():
        assert {"charge_pages", "charge_tokens", "record_retry"} <= set(
            _ledger_methods(source)
        ), name
