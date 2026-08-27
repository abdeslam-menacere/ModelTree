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
`+=`, plain re-assignment, annotated assignment, `for`/`with` binding,
`setattr(self, ...)` (including a computed attribute name, which is an opaque
bypass in a ledger), and the instance-dictionary spelling of all of those —
see *Dynamic writes* below — and it follows `self._helper(...)` delegation in both
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

*Another ledger's counters.* A second receiver, and a third rule. Until #373 a
`BudgetLedger` method writing `other.pages_fetched` was read by neither of the
two rules above — inside the class, so the module rule skips it; not a write to
`self`, so the guard rule ignored it — and the whole suite stayed green on it.
That was latent rather than live, because `budgets.py` writes every one of its
counters on a bare `self`, which is the only reason it is recorded here as a
decision rather than as a defect.

The decision is that a charge is what the *counter* says it is, not what the
receiver says it is, so the write is reported. The assertion that used to hold
the opposite gave a reason that argues against its own conclusion:
`other.tokens_used` is "that ledger's methods' business" — which is the case
for *refusing* it here, not for ignoring it. The counters belong to the ledger,
and the fix for such a site is a method on the ledger that owns them —
`other.charge_tokens(n)`, which consults `other`'s clock and routes `other`'s
limit through `other._exhaust`.

Refusal, not guarding, for the same reason the module rule refuses one scope
out. `self.check_time()` reads `self._started_at` and `self.budget.max_seconds`;
`other` has its own of each. A guard on `self` therefore restores nothing
whatever about `other`, and widening the *guard* rule to match any receiver
would have been worse than the gap it closed: a method that called
`self.check_time()` and then spent `other.pages_fetched` would come back clear,
and a false negative that reads as covered is the one outcome this file exists
to prevent.

`NOT_SELF` is the complement of `SELF` over the same expressions rather than a
second list of shapes, so a receiver reached *through* self is still not self
and `self.parent.pages_fetched += n` — the parent/child rollup — is read. The
cost is the name-based one the module rule already accepts, accepted here for
the same reason: `report.pages_fetched = ...` on an object that merely borrows a
counter's name reads as a charge, which in a module this small is worth a look
either way, and the failure names the site. The rule exempts neither `__init__`
nor `record_retry`: both of those exemptions are about the clock, and the clock
is not what makes this a violation. Both in-class rules walk the same functions
via `_ledger_method_nodes`, so the coverage check above is one statement about
both of them and the nested-class seam stays the only seam.

*Dynamic writes.* An attribute write has spellings that are not attribute
syntax, and a rule reading only `ast.Attribute` targets is walked around by
picking one. `self.__dict__["pages_fetched"] += n` spends the same counter as
`self.pages_fetched += n`, and is an `ast.Subscript` rather than an
`ast.Attribute` in the tree, so it was invisible to both rules at once —
including inside `BudgetLedger`, where the guard rule's entire job is that no
counter is spent before the clock is checked. The whole suite stayed green on
it. See #347.

Read now, by both rules, because both reach write forms through `_target_attrs`
and `_written_attrs`: `<receiver>.__dict__[key]` and `vars(<receiver>)[key]` as
the target of every binding form an attribute already had, and
`<receiver>.__dict__.update(...)` for the keys it can read. A key, or an
`update()` argument, that is not a literal is treated as `COMPUTED`, exactly as
a computed `setattr` name already was.

Not read, and that is a boundary rather than a backlog. Each of these reaches
the counter through a value that is not named where the write happens: an alias
(`state = self.__dict__`, then `state[...] = n`); any callable handed the
dictionary (`operator.setitem(self.__dict__, ...)`, `dict.__setitem__`); and
reflection routed through another object (`object.__setattr__(self, ...)`).
Closing them means following a value between statements — dataflow analysis,
which this file does not do and should not grow — and every extra special case
is one more shape to get subtly wrong in a detector whose worth depends on not
crying wolf. `test_the_dynamic_write_forms_that_stay_open_are_named` holds them
open by measurement, so the boundary cannot decay into a claim nobody checks.

Those three are what has been probed, **not** an enumeration of what gets
through: any spelling that puts a value between the receiver and the write is
open by the same argument whether or not it is named above. So the covered list
must not be read as "this axis is closed" — it is not, and it cannot be made so
syntactically. The narrower claim is the one worth having and is the one made
here: every form that reads like ordinary code is read, and what stays open is
conspicuously reflective in a module this small.

Both new forms inherit the receiver-blindness recorded above rather than
widening it. Outside the ledger the module rule matches any receiver, so
`vars(anything)["pages_fetched"] = n` is reported exactly as
`anything.pages_fetched = n` already was, and for the same reason. Inside it
they are read on the receiver axis too, so `vars(other)["tokens_used"] = n` is
the cross-ledger charge `other.tokens_used = n` is.
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

# The instance dictionary, and the two ways to reach it without leaving the
# expression the write is in. `self.__dict__["pages_fetched"] = n` and
# `vars(self)["pages_fetched"] = n` both write the counter `self.pages_fetched`
# names, so both are read as writes to it. See #347 and *Dynamic writes* above.
INSTANCE_DICT = "__dict__"
VARS = "vars"
DICT_UPDATE = "update"

# Which receiver a write has to be on for a rule to see it. Three rules, three
# answers, and between them every receiver a write can name.
#
# `SELF` is the guard rule inside the class: spend, but guard the clock first.
# `NOT_SELF` is the foreign-receiver rule, also inside the class, and it refuses
# rather than guards — a guard on `self` says nothing about another object's
# clock or limit. `ANY_RECEIVER` is the module rule outside the class, which has
# no `self` to key on and nothing to learn from the object being written to.
# See *Another ledger's counters* in the module docstring, and #373.
SELF = "self"
NOT_SELF = "<not-self>"
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


def _ledger_method_nodes(
    ledger: ast.ClassDef,
) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    """The class body's own methods: the functions both in-class rules analyse.

    Shared so the guard rule and the foreign-receiver rule cannot drift apart on
    which functions they cover, which is what lets
    `test_the_guard_rule_reaches_every_function_inside_the_ledger_class` be one
    statement about both of them rather than about the older of the two.
    """
    return [child for child in ledger.body if isinstance(child, _METHOD_NODES)]


def _ledger_methods(source: str) -> dict[str, ast.AST]:
    """Every method defined on the ledger class, keyed by name."""
    return {child.name: child for child in _ledger_method_nodes(_ledger_class(source))}


# --- What counts as writing to the ledger ------------------------------------


def _matches_receiver(node: ast.AST | None, receiver: str) -> bool:
    """True when `node` is the receiver expression a rule matches writes on.

    The one place a receiver is recognised, so the three rules cannot drift
    apart on what "the object being written to" means, and so the instance
    dictionary forms below — which have to identify a receiver with no attribute
    hanging off it to read — ask the same question the attribute forms do.

    `NOT_SELF` is the complement of `SELF` over the same expressions rather than
    a second list of shapes. A ledger reached *through* self is still not self,
    so `self.parent.pages_fetched` is matched by it and `self.pages_fetched` is
    not.
    """
    if node is None:
        return False
    if receiver == ANY_RECEIVER:
        return True
    if receiver == NOT_SELF:
        return not (isinstance(node, ast.Name) and node.id == SELF)
    return isinstance(node, ast.Name) and node.id == receiver


def _receiver_attr(node: ast.AST | None, receiver: str) -> str | None:
    """`<receiver>.<name>` -> `<name>`; anything else -> None.

    `ANY_RECEIVER` matches whatever the write is made on, including a chained
    expression like `run.ledger.pages_fetched`. All three rules read attributes
    through here so that none can learn a form the others have not.
    """
    if not isinstance(node, ast.Attribute):
        return None
    return node.attr if _matches_receiver(node.value, receiver) else None


def _self_attr(node: ast.AST | None) -> str | None:
    """`self.<name>` -> `<name>`; anything else -> None."""
    return _receiver_attr(node, SELF)


def _is_instance_dict(node: ast.AST | None, receiver: str) -> bool:
    """True when `node` evaluates to `<receiver>`'s own instance dictionary.

    Both direct spellings, so that neither is a bypass of the other: the
    attribute `<receiver>.__dict__`, and `vars(<receiver>)`, which the builtin
    documents as returning that same dictionary. A dictionary reached any other
    way is deliberately not matched — see *Dynamic writes* in the module
    docstring for what that leaves open and why.
    """
    if isinstance(node, ast.Attribute) and node.attr == INSTANCE_DICT:
        return _matches_receiver(node.value, receiver)
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == VARS
        and len(node.args) == 1
        and not node.keywords
        and _matches_receiver(node.args[0], receiver)
    )


def _key_name(node: ast.AST | None) -> str:
    """A subscript or mapping key as an attribute name, or the sentinel.

    A key that is not a literal string cannot be resolved to a counter, so it
    is treated as one for the same reason a computed `setattr` name is.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return COMPUTED


def _instance_dict_key(node: ast.AST | None, receiver: str) -> set[str]:
    """`<receiver>.__dict__["x"]` / `vars(<receiver>)["x"]` -> `{"x"}`.

    `ast.Subscript.slice` holds the key expression directly rather than an
    `ast.Index` wrapper, which has been true since the 3.9 grammar and so holds
    on both Python versions CI runs.
    """
    if not isinstance(node, ast.Subscript):
        return set()
    if not _is_instance_dict(node.value, receiver):
        return set()
    return {_key_name(node.slice)}


def _target_attrs(target: ast.AST | None, receiver: str) -> set[str]:
    """The `<receiver>` attributes an assignment target binds.

    Written as an attribute, or as a key in the receiver's instance dictionary,
    which binds the same attribute. Every binding form routes through here, so
    the dictionary spelling is covered wherever plain attribute syntax is.
    """
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
    if attr is not None:
        return {attr}
    return _instance_dict_key(target, receiver)


def _setattr_attrs(node: ast.Call, receiver: str) -> set[str]:
    """`setattr(self, "x", ...)` -> {"x"}; a computed name -> the sentinel."""
    if not (isinstance(node.func, ast.Name) and node.func.id == "setattr"):
        return set()
    if len(node.args) < 2:
        return set()
    if not _matches_receiver(node.args[0], receiver):
        return set()
    name = node.args[1]
    if isinstance(name, ast.Constant) and isinstance(name.value, str):
        return {name.value}
    return {COMPUTED}


def _dict_update_attrs(node: ast.Call, receiver: str) -> set[str]:
    """`<receiver>.__dict__.update(...)` -> the attributes it binds.

    The bulk spelling of the same bypass: one call writes as many counters as
    it has keys. Literal keys and keyword names resolve to attribute names; a
    mapping the rule cannot read into keys — a name, a call, `**kwargs` — is
    `COMPUTED`, since an unreadable bulk write to the ledger is if anything a
    broader bypass than an unreadable single one.
    """
    if not (
        isinstance(node.func, ast.Attribute)
        and node.func.attr == DICT_UPDATE
        and _is_instance_dict(node.func.value, receiver)
    ):
        return set()
    written = {
        keyword.arg if keyword.arg is not None else COMPUTED for keyword in node.keywords
    }
    for argument in node.args:
        if isinstance(argument, ast.Dict):
            written |= {_key_name(key) for key in argument.keys}
        else:
            written.add(COMPUTED)
    return written


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
        return _setattr_attrs(node, receiver) | _dict_update_attrs(node, receiver)
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
    """`(functions the in-class rules walk, functions the ledger class contains)`.

    Read off one parse, because they are compared by node identity. Both
    in-class rules start from `_ledger_method_nodes` and follow `ast.walk` into
    each, so a function the ledger holds some other way — inside a nested class,
    say — is in the second set and not the first, and is analysed by none of the
    three rules. That difference is what the coverage test refuses.
    """
    tree = ast.parse(source)
    ledger = _ledger_class_in(tree)
    walked = {
        id(node)
        for child in _ledger_method_nodes(ledger)
        for node in ast.walk(child)
        if isinstance(node, _METHOD_NODES)
    }
    contained = {id(node) for node in ast.walk(ledger) if isinstance(node, _METHOD_NODES)}
    return walked, contained


# --- Charges on a receiver that is not `self` --------------------------------
#
# The third rule, and the receiver half of the first one. The guard rule asks
# what these same functions spend on `self`; this asks what they spend on
# anything else, and refuses it rather than guarding it. See *Another ledger's
# counters* in the module docstring for why guarding is the wrong frame, and
# #373 for the gap this closes.


@dataclass(frozen=True, order=True)
class ForeignCharge:
    """A spending counter a ledger method writes on something that is not `self`."""

    scope: str
    counter: str


def _charges_on_another_receiver(source: str) -> frozenset[ForeignCharge]:
    """Every counter a ledger method writes on a receiver other than `self`.

    Walks `_ledger_method_nodes`, exactly as the guard rule does, so neither
    in-class rule can cover a function the other does not; and reads write forms
    through the same `_written_attrs`, so neither can learn a spelling the other
    has not. `NOT_SELF` does the rest, which is why nothing here enumerates a
    shape.

    Exempts neither `__init__` nor `record_retry`. Both of those exemptions are
    about the clock — a ledger cannot overrun a clock it is starting, and a retry
    does not consume wall-clock budget — and neither has anything to say about
    spending an object that is not this one.
    """
    tree = ast.parse(source)
    counters = _spending_counters(source)
    scopes = _scopes(tree)
    return frozenset(
        ForeignCharge(scopes[id(node)], attr)
        for method in _ledger_method_nodes(_ledger_class_in(tree))
        for node in ast.walk(method)
        for attr in _written_attrs(node, NOT_SELF)
        if attr in counters or attr == COMPUTED
    )


def _report(
    source: str,
) -> tuple[
    frozenset[Charge],
    frozenset[Charge],
    frozenset[OutsideCharge],
    frozenset[ForeignCharge],
]:
    """`(never guarded, guarded late, spent outside the ledger, spent on another)`."""
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
        _charges_on_another_receiver(source),
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

# --- Another ledger's counters. The fixture above is the one #373 names, and it
# is a *positive* now rather than a counterweight; these are the other spellings
# the same decision covers, and the counterweights that keep the rule from
# crying wolf on the receiver axis. See *Another ledger's counters* above.

# The decision itself, in one fixture: the clock is guarded and the write is
# still refused, because `self.check_time()` reads `self._started_at` and
# `self.budget`, neither of which is `other`'s.
_FOREIGN_GUARDED = """
    def copy_widgets_into(self, other: "BudgetLedger") -> None:
        self.check_time()
        other.tokens_used += self.tokens_used
"""

_FOREIGN_ASSIGN = """
    def copy_widgets_into(self, other: "BudgetLedger") -> None:
        other.tokens_used = self.tokens_used
"""

_FOREIGN_SETATTR = """
    def copy_widgets_into(self, other: "BudgetLedger") -> None:
        setattr(other, "tokens_used", self.tokens_used)
"""

_FOREIGN_COMPUTED_SETATTR = """
    def copy_widgets_into(self, other: "BudgetLedger", name: str) -> None:
        setattr(other, name, self.tokens_used)
"""

_FOREIGN_DICT_AUG = """
    def copy_widgets_into(self, other: "BudgetLedger") -> None:
        other.__dict__["tokens_used"] += self.tokens_used
"""

_FOREIGN_VARS_ASSIGN = """
    def copy_widgets_into(self, other: "BudgetLedger") -> None:
        vars(other)["tokens_used"] = self.tokens_used
"""

_FOREIGN_DICT_UPDATE_KEYWORD = """
    def copy_widgets_into(self, other: "BudgetLedger") -> None:
        other.__dict__.update(tokens_used=self.tokens_used)
"""

# The parent/child rollup #373 names, and the shape a receiver rule written as
# "a bare name that is not `self`" would miss: the ledger being spent is reached
# *through* `self` and is still not `self`.
_FOREIGN_CHAINED = """
    def roll_up(self, count: int) -> None:
        self.parent.pages_fetched += count
"""

# Both receivers bound by one statement. A rule built by subtracting the `self`
# writes from the any-receiver writes cancels to nothing here, because the two
# targets carry the same attribute name; `NOT_SELF` resolves each target on its
# own, so the foreign half survives. The `self` half is guarded, so this variant
# reports on exactly one axis and cannot pass by reddening the other.
_FOREIGN_AND_SELF_TUPLE = """
    def split_widgets(self, other: "BudgetLedger", count: int) -> None:
        self.check_time()
        self.tokens_used, other.tokens_used = count, count
"""

_FOREIGN_READ = """
    def widgets_behind(self, other: "BudgetLedger") -> int:
        return other.tokens_used - self.tokens_used
"""

_FOREIGN_OTHER_ATTRIBUTE = """
    def label_other(self, other: "BudgetLedger", note: str) -> None:
        other.note = note
"""

_FOREIGN_LOCAL_MAPPING = """
    def stash_widgets_for(self, other: "BudgetLedger") -> None:
        counts = {}
        counts["tokens_used"] = other.tokens_used
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

# --- Instance-dictionary writes inside the ledger. The same charge as the
# attribute injections above, one AST node type over. See #347. ---------------

_UNGUARDED_DICT_AUG = """
    def charge_widgets(self, count: int) -> None:
        self.__dict__["tokens_used"] += count
"""

_UNGUARDED_DICT_ASSIGN = """
    def charge_widgets(self, count: int) -> None:
        self.__dict__["tokens_used"] = self.tokens_used + count
"""

_UNGUARDED_DICT_COMPUTED_KEY = """
    def charge_widgets(self, name: str, count: int) -> None:
        self.__dict__[name] = count
"""

_UNGUARDED_VARS_AUG = """
    def charge_widgets(self, count: int) -> None:
        vars(self)["tokens_used"] += count
"""

_UNGUARDED_DICT_UPDATE = """
    def charge_widgets(self, count: int) -> None:
        self.__dict__.update({"tokens_used": self.tokens_used + count})
"""

_UNGUARDED_DICT_UPDATE_OPAQUE = """
    def charge_widgets(self, state: dict) -> None:
        self.__dict__.update(state)
"""

# `dict.update` takes keywords as well as a mapping, and the keyword spelling is
# the one that reads least like a dictionary write — `update(tokens_used=n)` is
# the same charge as `self.tokens_used = n` with no subscript and no literal key
# anywhere in the call. Both arms of the keyword limb are planted separately,
# because a probe that deletes the whole comprehension cannot tell them apart.
# See #355.

_UNGUARDED_DICT_UPDATE_KEYWORD = """
    def charge_widgets(self, count: int) -> None:
        self.__dict__.update(tokens_used=self.tokens_used + count)
"""

_UNGUARDED_DICT_UPDATE_KWARGS = """
    def charge_widgets(self, changes: dict) -> None:
        self.__dict__.update(**changes)
"""

_GUARDED_DICT_AUG = """
    def charge_widgets(self, count: int) -> None:
        self.check_time()
        self.__dict__["tokens_used"] += count
"""

_READS_A_COUNTER_THROUGH_THE_DICT = """
    def widgets_left(self) -> int:
        return self.budget.max_tokens - self.__dict__["tokens_used"]
"""

_WRITES_A_NON_COUNTER_DICT_KEY = """
    def note_widgets(self, text: str) -> None:
        self.__dict__["note"] = text
"""

_WRITES_ANOTHER_MAPPING = """
    def stash_widgets(self, count: int) -> None:
        self._notes = {}
        self._notes["tokens_used"] = count
"""

_UPDATES_ANOTHER_MAPPING = """
    def stash_widgets(self, count: int) -> None:
        self._notes = {}
        self._notes.update({"tokens_used": count})
"""

_UPDATES_ANOTHER_MAPPING_BY_KEYWORD = """
    def stash_widgets(self, count: int) -> None:
        self._notes = {}
        self._notes.update(tokens_used=count)
"""

_UPDATES_A_NON_COUNTER_DICT_KEYWORD = """
    def note_widgets(self, text: str) -> None:
        self.__dict__.update(note=text)
"""

# --- The write forms this file deliberately does not read. Each one reaches
# the counter through a value that is not named where the write happens, so
# seeing it takes dataflow analysis rather than a wider node match. Pinned as
# open by `test_the_dynamic_write_forms_that_stay_open_are_named`. -------------

_ALIASED_INSTANCE_DICT = """
    def charge_widgets(self, count: int) -> None:
        state = self.__dict__
        state["tokens_used"] += count
"""

_OBJECT_SETATTR = """
    def charge_widgets(self, count: int) -> None:
        object.__setattr__(self, "tokens_used", count)
"""

_OPERATOR_SETITEM = """
    def charge_widgets(self, count: int) -> None:
        import operator

        operator.setitem(self.__dict__, "tokens_used", count)
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

# --- Instance-dictionary writes outside the ledger. The module rule has to
# learn the same forms the guard rule just did, or the fix closes one scope and
# leaves the other open — #335's own defect, one node type over. See #347. -----

_OUTSIDE_DICT_AUG = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    ledger.__dict__["pages_fetched"] += count
'''

_OUTSIDE_VARS_ASSIGN = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    vars(ledger)["pages_fetched"] = count
'''

_OUTSIDE_DICT_UPDATE = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    ledger.__dict__.update({"pages_fetched": count})
'''

_OUTSIDE_DICT_UPDATE_KEYWORD = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", count: int) -> None:
    ledger.__dict__.update(pages_fetched=count)
'''

_OUTSIDE_DICT_UPDATE_KWARGS = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", changes: dict) -> None:
    ledger.__dict__.update(**changes)
'''

_OUTSIDE_DICT_COMPUTED_KEY = '''

def charge_widgets_outside_the_class(ledger: "BudgetLedger", name: str, n: int) -> None:
    ledger.__dict__[name] = n
'''

_OUTSIDE_DICT_MODULE_LEVEL = '''

_SHARED = BudgetLedger(CreatorBudget())
_SHARED.__dict__["pages_fetched"] = 1
'''

_OUTSIDE_DICT_READ = '''

def pages_left_through_the_dict(ledger: "BudgetLedger") -> int:
    return ledger.budget.max_pages - ledger.__dict__["pages_fetched"]
'''

_OUTSIDE_UNRELATED_SUBSCRIPT = '''

_CACHE: dict[str, int] = {}
_CACHE["pages_fetched"] = 1
'''

_OUTSIDE_UNRELATED_UPDATE_KEYWORD = '''

_CACHE: dict[str, int] = {}
_CACHE.update(pages_fetched=1)
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
        "foreign_guarded": _extend_ledger(real, _FOREIGN_GUARDED),
        "foreign_assign": _extend_ledger(real, _FOREIGN_ASSIGN),
        "foreign_setattr": _extend_ledger(real, _FOREIGN_SETATTR),
        "foreign_computed_setattr": _extend_ledger(real, _FOREIGN_COMPUTED_SETATTR),
        "foreign_dict_aug": _extend_ledger(real, _FOREIGN_DICT_AUG),
        "foreign_vars_assign": _extend_ledger(real, _FOREIGN_VARS_ASSIGN),
        "foreign_dict_update_keyword": _extend_ledger(
            real, _FOREIGN_DICT_UPDATE_KEYWORD
        ),
        "foreign_chained": _extend_ledger(real, _FOREIGN_CHAINED),
        "foreign_and_self_tuple": _extend_ledger(real, _FOREIGN_AND_SELF_TUPLE),
        "foreign_read": _extend_ledger(real, _FOREIGN_READ),
        "foreign_other_attribute": _extend_ledger(real, _FOREIGN_OTHER_ATTRIBUTE),
        "foreign_local_mapping": _extend_ledger(real, _FOREIGN_LOCAL_MAPPING),
        "writes_a_private_attribute": _extend_ledger(real, _WRITES_A_PRIVATE_ATTRIBUTE),
        "new_counter_seeded": with_counter,
        "new_counter_unguarded": _extend_ledger(with_counter, _NEW_COUNTER_UNGUARDED),
        "new_counter_guarded": _extend_ledger(with_counter, _NEW_COUNTER_GUARDED),
        "ledger_nested_class": _extend_ledger(real, _LEDGER_NESTED_CLASS),
        "unguarded_dict_aug": _extend_ledger(real, _UNGUARDED_DICT_AUG),
        "unguarded_dict_assign": _extend_ledger(real, _UNGUARDED_DICT_ASSIGN),
        "unguarded_dict_computed_key": _extend_ledger(real, _UNGUARDED_DICT_COMPUTED_KEY),
        "unguarded_vars_aug": _extend_ledger(real, _UNGUARDED_VARS_AUG),
        "unguarded_dict_update": _extend_ledger(real, _UNGUARDED_DICT_UPDATE),
        "unguarded_dict_update_opaque": _extend_ledger(
            real, _UNGUARDED_DICT_UPDATE_OPAQUE
        ),
        "unguarded_dict_update_keyword": _extend_ledger(
            real, _UNGUARDED_DICT_UPDATE_KEYWORD
        ),
        "unguarded_dict_update_kwargs": _extend_ledger(
            real, _UNGUARDED_DICT_UPDATE_KWARGS
        ),
        "guarded_dict_aug": _extend_ledger(real, _GUARDED_DICT_AUG),
        "reads_a_counter_through_the_dict": _extend_ledger(
            real, _READS_A_COUNTER_THROUGH_THE_DICT
        ),
        "writes_a_non_counter_dict_key": _extend_ledger(
            real, _WRITES_A_NON_COUNTER_DICT_KEY
        ),
        "writes_another_mapping": _extend_ledger(real, _WRITES_ANOTHER_MAPPING),
        "updates_another_mapping": _extend_ledger(real, _UPDATES_ANOTHER_MAPPING),
        "updates_another_mapping_by_keyword": _extend_ledger(
            real, _UPDATES_ANOTHER_MAPPING_BY_KEYWORD
        ),
        "updates_a_non_counter_dict_keyword": _extend_ledger(
            real, _UPDATES_A_NON_COUNTER_DICT_KEYWORD
        ),
        "aliased_instance_dict": _extend_ledger(real, _ALIASED_INSTANCE_DICT),
        "object_setattr": _extend_ledger(real, _OBJECT_SETATTR),
        "operator_setitem": _extend_ledger(real, _OPERATOR_SETITEM),
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
        "outside_dict_aug": _extend_module(real, _OUTSIDE_DICT_AUG),
        "outside_vars_assign": _extend_module(real, _OUTSIDE_VARS_ASSIGN),
        "outside_dict_update": _extend_module(real, _OUTSIDE_DICT_UPDATE),
        "outside_dict_update_keyword": _extend_module(
            real, _OUTSIDE_DICT_UPDATE_KEYWORD
        ),
        "outside_dict_update_kwargs": _extend_module(real, _OUTSIDE_DICT_UPDATE_KWARGS),
        "outside_dict_computed_key": _extend_module(real, _OUTSIDE_DICT_COMPUTED_KEY),
        "outside_dict_module_level": _extend_module(real, _OUTSIDE_DICT_MODULE_LEVEL),
        "outside_dict_read": _extend_module(real, _OUTSIDE_DICT_READ),
        "outside_unrelated_subscript": _extend_module(real, _OUTSIDE_UNRELATED_SUBSCRIPT),
        "outside_unrelated_update_keyword": _extend_module(
            real, _OUTSIDE_UNRELATED_UPDATE_KEYWORD
        ),
    }


VARIANTS = _variants()


def _injected(
    variant: str,
) -> tuple[
    frozenset[Charge],
    frozenset[Charge],
    frozenset[OutsideCharge],
    frozenset[ForeignCharge],
]:
    """What one injection adds to whatever `budgets.py` already reports.

    Every variant is the real module plus a single edit, so subtracting the
    module's own report keeps each proof below measuring its own injection. A
    real regression in `budgets.py` then fails the module-level tests once,
    instead of turning every proof and counterweight red at the same time and
    burying which idiom actually stopped working.
    """
    real_unguarded, real_late, real_outside, real_foreign = _report(_read_source())
    unguarded, late, outside, foreign = _report(VARIANTS[variant])
    return (
        unguarded - real_unguarded,
        late - real_late,
        outside - real_outside,
        foreign - real_foreign,
    )


def _injected_unguarded(variant: str) -> set[str]:
    return {charge.method for charge in _injected(variant)[0]}


def _injected_late(variant: str) -> set[str]:
    return {charge.method for charge in _injected(variant)[1]}


def _injected_outside(variant: str) -> set[tuple[str, str]]:
    return {(charge.scope, charge.counter) for charge in _injected(variant)[2]}


def _injected_foreign(variant: str) -> set[tuple[str, str]]:
    return {(charge.scope, charge.counter) for charge in _injected(variant)[3]}


def _injected_paths(variant: str) -> set[tuple[str, str]]:
    return {(charge.entry, charge.method) for charge in _injected(variant)[0]}


NOTHING: tuple[
    frozenset[Charge],
    frozenset[Charge],
    frozenset[OutsideCharge],
    frozenset[ForeignCharge],
] = (
    frozenset(),
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
    charge that runs ahead of its guard, nothing spending a counter from outside
    the ledger class, and no ledger method spending a counter on anything but
    itself. All four claims at once, which is what makes this the test a real
    regression in `budgets.py` fails on."""
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


# --- Non-vacuity: the instance-dictionary spelling of the same charge --------


def test_an_unguarded_augmented_charge_through_the_instance_dict_is_detected() -> None:
    """#347's reproducer, inside the class it matters most. At runtime
    `self.__dict__["tokens_used"] += n` is `self.tokens_used += n`; in the tree
    it is a `Subscript`, and reading only `Attribute` targets made it invisible
    to the rule whose whole job is that no counter is spent unguarded."""
    assert _injected_unguarded("unguarded_dict_aug") == {"charge_widgets"}


def test_an_unguarded_plain_assignment_through_the_instance_dict_is_detected() -> None:
    """Both spellings of the bypass compose, so both are read. The attribute
    forms are covered one by one above for the same reason."""
    assert _injected_unguarded("unguarded_dict_assign") == {"charge_widgets"}


def test_an_instance_dict_write_with_a_computed_key_is_detected() -> None:
    """`self.__dict__[name] = n` cannot be resolved to a counter, so it is
    treated as one — the same call `setattr` with a computed name already gets,
    and for the same reason: `budgets.py` has no legitimate use for a write to
    the ledger whose target this file cannot name."""
    charges = _injected("unguarded_dict_computed_key")[0]
    assert {charge.counter for charge in charges} == {COMPUTED}
    assert _injected_unguarded("unguarded_dict_computed_key") == {"charge_widgets"}


def test_an_unguarded_charge_through_vars_is_detected() -> None:
    """`vars(self)` returns the same dictionary `self.__dict__` does. Covering
    one spelling and not the other would move the bypass rather than close it."""
    assert _injected_unguarded("unguarded_vars_aug") == {"charge_widgets"}


def test_an_unguarded_charge_through_instance_dict_update_is_detected() -> None:
    """The bulk spelling: one call, keys read out of the literal it is given."""
    charges = _injected("unguarded_dict_update")[0]
    assert {(charge.method, charge.counter) for charge in charges} == {
        ("charge_widgets", "tokens_used")
    }


def test_an_instance_dict_update_the_rule_cannot_read_is_detected() -> None:
    """`self.__dict__.update(state)` hands the ledger a mapping this file
    cannot open, so every counter in it is potentially charged. Reported as
    `COMPUTED` rather than ignored, because an unreadable bulk write is a wider
    bypass than an unreadable single one, not a narrower one."""
    charges = _injected("unguarded_dict_update_opaque")[0]
    assert {charge.counter for charge in charges} == {COMPUTED}
    assert _injected_unguarded("unguarded_dict_update_opaque") == {"charge_widgets"}


def test_an_unguarded_charge_through_a_dict_update_keyword_is_detected() -> None:
    """`self.__dict__.update(tokens_used=n)`: the same bulk write with no
    subscript, no literal key and no mapping anywhere in the call — the counter
    is named only by a keyword argument. `dict.update` accepts keywords as well
    as a mapping, so reading only the mapping argument would leave the shorter
    and more natural spelling of the bypass open. See #355.

    The counter is asserted by name rather than through `_injected_unguarded`
    alone, so this cannot pass on a detector that merely notices the call: the
    keyword has to resolve to `tokens_used` and not to `COMPUTED`."""
    charges = _injected("unguarded_dict_update_keyword")[0]
    assert {(charge.method, charge.counter) for charge in charges} == {
        ("charge_widgets", "tokens_used")
    }


def test_an_unguarded_dict_update_of_computed_keywords_is_detected() -> None:
    """`self.__dict__.update(**changes)` is the keyword limb's other arm, and it
    is a separate claim: a rule that reads keyword *names* still cannot see the
    names inside a `**` unpacking, because `ast.keyword.arg` is `None` there.
    Treated as `COMPUTED` for the same reason `update(state)` is — an unreadable
    bulk write to the ledger is a wider bypass than an unreadable single one.

    Pinned apart from the named-keyword test above because deleting the whole
    comprehension reddens both, and so cannot distinguish which arm is live."""
    charges = _injected("unguarded_dict_update_kwargs")[0]
    assert {charge.counter for charge in charges} == {COMPUTED}
    assert _injected_unguarded("unguarded_dict_update_kwargs") == {"charge_widgets"}


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


def test_writing_another_ledger_s_counter_is_a_charge() -> None:
    """The decision #373 asked for, recorded where the old assertion stood.

    This test used to be `test_writing_another_ledger_s_counter_is_not_a_charge`
    and asserted `NOTHING`, on the reasoning that `other.tokens_used` "spends
    another run's budget and is that ledger's methods' business". The premise
    was right and the conclusion did not follow from it: if those counters are
    that ledger's methods' business, then a method of *this* ledger writing them
    directly is the encapsulation break the module rule refuses one scope out,
    and the remedy is the same one — `other.charge_tokens(n)`, which consults
    `other`'s clock and routes `other`'s limit through `other._exhaust`.

    So a charge is what the *counter* says it is, not what the receiver says it
    is. Reported by the third rule, which refuses rather than guards; the guard
    rule is deliberately not the vehicle, because a guard on `self` restores
    nothing about `other` and widening it would have let a `self.check_time()`
    clear a cross-ledger spend. This test is what catches that mistake: the
    fixture is unguarded, so a widened guard rule reports it and the second
    assertion below goes red. Kept as the inverse of the assertion it replaces
    rather than deleted, so the reversal is visible in the diff.
    """
    assert _injected_foreign("writes_another_ledger") == {
        ("BudgetLedger.copy_widgets_into", "tokens_used")
    }
    assert _injected("writes_another_ledger")[:3] == NOTHING[:3], (
        "a cross-ledger charge must be reported by the foreign-receiver rule "
        "alone; the guard rule keys on `self` and the module rule skips the "
        "class, and neither claim should have moved"
    )


def test_writing_a_private_attribute_is_not_a_charge() -> None:
    """`_exhausted_by` and friends are bookkeeping, not spending."""
    assert _injected("writes_a_private_attribute") == NOTHING


def test_a_new_counter_charged_with_the_guard_is_not_flagged() -> None:
    """The counterweight to the #249 row: discovering a new counter must not
    make correctly guarded code fail."""
    assert _injected("new_counter_guarded") == NOTHING


# --- Counterweights for the dictionary forms: what must stay quiet -----------
#
# A matcher widened until it fires on ordinary code is a worse defect than the
# gap it closed, because the fix for noise is to stop trusting the test.


def test_the_same_instance_dict_charge_guarded_is_not_flagged() -> None:
    """The new forms key on the missing guard, exactly as the attribute forms
    do, rather than on the mutation being unusual."""
    assert _injected("guarded_dict_aug") == NOTHING


def test_reading_a_counter_through_the_instance_dict_is_not_a_charge() -> None:
    """`self.__dict__["tokens_used"]` in an expression loads the counter. Only
    a subscript in a binding position is a write, which is what keeps this rule
    from flagging every line that mentions a counter."""
    assert _injected("reads_a_counter_through_the_dict") == NOTHING


def test_writing_a_non_counter_key_in_the_instance_dict_is_not_a_charge() -> None:
    """The key is resolved and checked against the derived counters, so
    `self.__dict__["note"] = ...` is treated exactly as `self.note = ...` is —
    which is the claim, in both directions. Neither is a charge, and both are
    seen by `test_no_public_ledger_attribute_is_written_outside_the_derived_counters`
    as public state the derivation cannot classify. Measured: the two spellings
    produce the same one failure when planted in the real module."""
    assert _injected("writes_a_non_counter_dict_key") == NOTHING


def test_a_subscript_write_to_another_mapping_is_not_a_charge() -> None:
    """The receiver has to be the instance dictionary. A key that merely reads
    like a counter name in some other dict spends nothing, and matching on the
    key alone would flag any mapping in the module that borrowed the name."""
    assert _injected("writes_another_mapping") == NOTHING


def test_an_update_of_another_mapping_is_not_a_charge() -> None:
    """`update` is only read on the instance dictionary. `dict.update` is an
    ordinary method and flagging every call to it would be pure noise."""
    assert _injected("updates_another_mapping") == NOTHING


def test_a_keyword_update_of_another_mapping_is_not_a_charge() -> None:
    """The receiver check has to hold for the keyword spelling too, or closing
    the gap in #355 would buy coverage with noise: an `update` keyword naming a
    counter on some *other* mapping writes nothing on the ledger. This is the
    bracket on the other side of the keyword limb — the named-keyword test above
    goes red when the limb is too narrow, and this one goes red when it is too
    broad, so neither mistake passes both."""
    assert _injected("updates_another_mapping_by_keyword") == NOTHING


def test_updating_a_non_counter_key_by_keyword_is_not_a_charge() -> None:
    """`self.__dict__.update(note=text)` is on the instance dictionary and is
    still not a charge, because the keyword resolves to an attribute name that
    is checked against the derived counters exactly as a literal subscript key
    is.

    Measured against the collapse that reads every keyword as `COMPUTED`, rather
    than reasoned about: three tests redden, not this one alone, because the two
    named-keyword positives assert their counter by name and get `COMPUTED`
    instead. What this one adds is the *other* failure mode. Those two go red
    over a degraded name while still reporting a method that genuinely spends;
    only here does a method that spends nothing — `note_widgets`, writing a
    non-counter attribute — begin to be reported at all. Of the three, this is
    the only one that catches the collapse as a false positive, which is the
    half that gets a detector switched off rather than merely mistrusted."""
    assert _injected("updates_a_non_counter_dict_keyword") == NOTHING


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


def test_the_live_module_charges_no_counter_on_another_receiver() -> None:
    """The sibling invariant on the receiver axis, and the one #373 asks for.

    Verified independently against `main` before the rule existed: every one of
    the writes in `budgets.py` is on a bare `self`, so this was latent rather
    than a live fail-open. It goes red the moment a ledger method starts
    spending an object that is not itself — a merge, a transfer, or the
    parent/child rollup — which is the shape no rule could see before.
    """
    foreign = _charges_on_another_receiver(_read_source())
    assert foreign == frozenset(), (
        "BudgetLedger method(s) write a spending counter on a receiver that is "
        "not `self`, which bypasses that ledger's clock guard and its _exhaust "
        "together; the fix is a method on the ledger that owns the counter: "
        f"{sorted((charge.scope, charge.counter) for charge in foreign)}"
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


def test_an_out_of_class_instance_dict_charge_is_detected() -> None:
    """#347 in the module rule. Both rules read write forms through the same
    `_written_attrs`, so the dictionary spelling could not close in one scope
    and stay open in the other — which would have re-created #335's own defect,
    a rule that stops at a scope boundary, one node type over."""
    assert _injected_outside("outside_dict_aug") == {
        ("charge_widgets_outside_the_class", "pages_fetched")
    }


def test_an_out_of_class_vars_charge_is_detected() -> None:
    """`vars(ledger)["pages_fetched"] = n` out here too, for the same reason it
    is read inside: it is the same dictionary under a second name."""
    assert _injected_outside("outside_vars_assign") == {
        ("charge_widgets_outside_the_class", "pages_fetched")
    }


def test_an_out_of_class_instance_dict_update_is_detected() -> None:
    """The bulk write, refused outside the class like every other charge out
    here — the rule there is encapsulation, so guarding it would not help."""
    assert _injected_outside("outside_dict_update") == {
        ("charge_widgets_outside_the_class", "pages_fetched")
    }


def test_an_out_of_class_dict_update_keyword_is_detected() -> None:
    """`ledger.__dict__.update(pages_fetched=n)` out here too. Both rules read
    write forms through the same `_written_attrs`, so pinning the keyword limb
    in one scope and not the other would leave the module rule resting on a
    shared helper that no module-scope test measures — the exact shape of the
    unenforced coverage #355 records."""
    assert _injected_outside("outside_dict_update_keyword") == {
        ("charge_widgets_outside_the_class", "pages_fetched")
    }


def test_an_out_of_class_dict_update_of_computed_keywords_is_detected() -> None:
    """The `**` arm at module scope, pinned separately for the same reason it is
    inside the class: it is the arm a rule that reads keyword names still misses,
    and only a probe that deletes it alone can tell the two apart."""
    assert _injected_outside("outside_dict_update_kwargs") == {
        ("charge_widgets_outside_the_class", COMPUTED)
    }


def test_an_out_of_class_instance_dict_write_with_a_computed_key_is_detected() -> None:
    """An unreadable key is a charge outside the class for the same reason an
    unreadable `setattr` name is: it is the shape a bypass takes."""
    assert _injected_outside("outside_dict_computed_key") == {
        ("charge_widgets_outside_the_class", COMPUTED)
    }


def test_an_instance_dict_charge_at_module_level_is_detected() -> None:
    """In no function at all, through the dictionary. The module rule walks
    nodes rather than scopes, so this needs no handling of its own."""
    assert _injected_outside("outside_dict_module_level") == {
        (MODULE_SCOPE, "pages_fetched")
    }


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


def test_reading_a_counter_through_the_dict_outside_the_class_is_not_a_charge() -> None:
    """Headroom read through the dictionary instead of the attribute. A load is
    not a charge out here either."""
    assert _injected("outside_dict_read") == NOTHING


def test_an_unrelated_subscript_write_outside_the_class_is_not_a_charge() -> None:
    """`_CACHE["pages_fetched"] = 1` writes a module-level dict that has
    nothing to do with a ledger. The counter name in the key is not enough —
    the subscript has to be on an instance dictionary — which is what stops
    this rule from reddening every mapping that reuses a counter's name."""
    assert _injected("outside_unrelated_subscript") == NOTHING


def test_an_unrelated_keyword_update_outside_the_class_is_not_a_charge() -> None:
    """`_CACHE.update(pages_fetched=1)` is the keyword spelling of the line
    above, on a module-level dict that is not any object's instance dictionary.
    The module rule matches any *receiver*, which is not the same as matching
    any *mapping*, and this is what holds that distinction for the keyword
    limb — it goes red on a detector widened until `update` alone is enough."""
    assert _injected("outside_unrelated_update_keyword") == NOTHING


# --- Another ledger's counters: the receiver axis ----------------------------
#
# The third rule's own proofs. The write forms come from the same
# `_written_attrs` the other two rules read, so these pin that the shared helper
# is actually reached with `NOT_SELF` rather than resting on coverage no test
# measures — the unenforced-coverage shape #355 records.


def test_a_cross_ledger_charge_is_refused_even_when_it_guards_the_clock() -> None:
    """The decision, held by a test so it cannot erode into a habit. It is the
    exact counterpart, one scope in, of the out-of-class rule that refuses a
    charge site even when that site calls the guard.

    This method calls `self.check_time()` and is still refused, because that
    guard reads `self._started_at` and `self.budget.max_seconds` while the
    counter being spent belongs to `other`, which has its own of each — and
    because `charge_tokens` also tests `max_tokens` through `_exhaust`, which no
    guard on `self` performs for `other` either.

    This variant is also why the fix could not be "widen the guard rule's
    receiver", and that is measured rather than argued. Under such a change the
    guard here runs *before* the write, so the widened guard rule clears this
    site and reports nothing whatever — a false negative that reads as covered,
    which is strictly worse than the silence #373 started from. The refusal rule
    reports it either way, which is what the first assertion pins.

    The second assertion pins that the guard rule stays out of it, and is
    deliberately not claimed to catch the widening: a site the widened rule
    cleared and a site that was never the guard rule's business look identical
    from here. What catches the widening is the *unguarded* fixture in
    `test_writing_another_ledger_s_counter_is_a_charge`, which a widened guard
    rule does report and which therefore goes red. Probed, not assumed."""
    assert _injected_foreign("foreign_guarded") == {
        ("BudgetLedger.copy_widgets_into", "tokens_used")
    }
    assert _injected("foreign_guarded")[:3] == NOTHING[:3], (
        "a cross-ledger charge is the refusal rule's business alone: the guard "
        "rule keys on `self` and the module rule skips the class"
    )


def test_a_cross_ledger_plain_reassignment_is_detected() -> None:
    """A plain assign is no more a bypass on the receiver axis than it is on the
    other two, because all three read `_written_attrs`."""
    assert _injected_foreign("foreign_assign") == {
        ("BudgetLedger.copy_widgets_into", "tokens_used")
    }


def test_a_cross_ledger_setattr_is_detected() -> None:
    """`setattr(other, "tokens_used", ...)` names the counter as a string."""
    assert _injected_foreign("foreign_setattr") == {
        ("BudgetLedger.copy_widgets_into", "tokens_used")
    }


def test_a_cross_ledger_setattr_with_a_computed_name_is_detected() -> None:
    """An attribute name the rule cannot read is treated as a charge here for
    the same reason it is in the other two rules: it is the shape a deliberate
    bypass takes, and `budgets.py` has no legitimate computed `setattr`."""
    assert _injected_foreign("foreign_computed_setattr") == {
        ("BudgetLedger.copy_widgets_into", COMPUTED)
    }


def test_a_cross_ledger_instance_dict_charge_is_detected() -> None:
    """#347's forms on #373's axis. `other.__dict__["tokens_used"] += n` spends
    the counter `other.tokens_used` names, so it is the same charge — and a
    rule that closed the receiver axis for attribute syntax only would have
    re-created #347's defect one receiver over."""
    assert _injected_foreign("foreign_dict_aug") == {
        ("BudgetLedger.copy_widgets_into", "tokens_used")
    }


def test_a_cross_ledger_vars_charge_is_detected() -> None:
    """`vars(other)` is `other.__dict__` under a second name, out here too."""
    assert _injected_foreign("foreign_vars_assign") == {
        ("BudgetLedger.copy_widgets_into", "tokens_used")
    }


def test_a_cross_ledger_dict_update_keyword_is_detected() -> None:
    """#355's keyword limb on the receiver axis, asserted by counter name so it
    cannot pass on a rule that merely notices the call: the keyword has to
    resolve to `tokens_used` rather than to `COMPUTED`."""
    assert _injected_foreign("foreign_dict_update_keyword") == {
        ("BudgetLedger.copy_widgets_into", "tokens_used")
    }


def test_a_charge_on_a_ledger_reached_through_self_is_detected() -> None:
    """The parent/child rollup, and the reason `NOT_SELF` is the complement of
    `SELF` rather than a check for a bare name that is not `self`.
    `self.parent.pages_fetched += n` reaches another ledger *through* self, and
    a rule keyed on the receiver being a plain `Name` other than `self` would
    have read this as covered while it spent a whole second budget."""
    assert _injected_foreign("foreign_chained") == {
        ("BudgetLedger.roll_up", "pages_fetched")
    }


def test_a_statement_writing_both_receivers_still_reports_the_foreign_half() -> None:
    """`self.tokens_used, other.tokens_used = count, count` binds one counter
    name on two receivers in one statement.

    The obvious way to build this rule — take the any-receiver writes and
    subtract the `self` writes — cancels to nothing here, because both halves
    contribute the same attribute name and set difference cannot tell them
    apart. Resolving each target against `NOT_SELF` on its own is what survives
    it. The `self` half is guarded, so the guard rule stays quiet and this
    variant reports on exactly one axis rather than passing because something
    else went red."""
    assert _injected_foreign("foreign_and_self_tuple") == {
        ("BudgetLedger.split_widgets", "tokens_used")
    }
    assert _injected("foreign_and_self_tuple")[:3] == NOTHING[:3]


# --- Counterweights on the receiver axis: what must stay quiet ---------------


def test_reading_another_ledger_s_counter_is_not_a_charge() -> None:
    """A method comparing itself against another ledger spends nothing. The
    rule keys on writes here exactly as the other two do, or every method that
    took a second ledger as a parameter would be a violation."""
    assert _injected("foreign_read") == NOTHING


def test_writing_a_non_counter_attribute_on_another_object_is_not_a_charge() -> None:
    """The rule is receiver-blind, not attribute-blind: the attribute still has
    to resolve to a derived counter, so `other.note = ...` stays quiet. This is
    the bracket on the broad side — the positives above go red when the rule is
    too narrow, and this goes red when it is widened until any write on any
    other object is a charge."""
    assert _injected("foreign_other_attribute") == NOTHING


def test_a_subscript_write_to_a_local_mapping_is_not_a_cross_ledger_charge() -> None:
    """`counts["tokens_used"] = ...` on an ordinary local dict is not a write to
    any object's instance dictionary, so it is not a charge on the receiver axis
    either. `NOT_SELF` widens which receivers are matched and must not widen
    what counts as a *write*, which is what this holds."""
    assert _injected("foreign_local_mapping") == NOTHING


# --- The write forms that stay open, held open by measurement ----------------


DOCUMENTED_OPEN_WRITES = ("aliased_instance_dict", "object_setattr", "operator_setitem")


def test_the_dynamic_write_forms_that_stay_open_are_named() -> None:
    """The limits of a syntactic matcher, measured rather than asserted.

    Each variant here charges a counter and is *not* reported, because each
    reaches it through a value that is not named where the write happens: a
    local alias of `__dict__`, a callable handed the dictionary, and reflection
    routed through another object. Seeing them means following a value between
    statements, which is dataflow analysis and a different tool than this file.

    This list is what has been probed, **not** an enumeration of everything
    that gets through, and the covered forms above are not "this axis is
    closed" — no syntactic rule can close it. The test exists so that claim
    stays a measurement: if you close one of these, delete its entry and move
    it to the covered list in the module docstring. Do not delete the test to
    make a wider matcher green, and do not read a green run here as coverage.
    """
    for variant in DOCUMENTED_OPEN_WRITES:
        assert _injected(variant) == NOTHING, (
            f"{variant!r} is now reported. That is an improvement, not a "
            "failure: drop it from DOCUMENTED_OPEN_WRITES and record it as "
            "covered in the module docstring's *Dynamic writes* section."
        )


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
