"""What an installed updater can and cannot find.

The publisher workflow installs the package and then runs `python -m
modeltree_updater`, so every default the CLI derives from `__file__` is derived
from inside site-packages. The fixtures default was written for the source
layout only, and the workflow died on a path nobody had ever typed:
`/opt/hostedtoolcache/Python/3.13.15/x64/lib/python3.13/fixtures/creators`
(#139).

The decision recorded here is that fixtures stay **test data**. They are
synthetic pages for invented creators, and a production artefact that carried
them could be run against fabricated sources by accident — in a project whose
premise is that every fact is traceable to a primary source, that is the wrong
thing to ship. So the wheel does not carry them, an installed copy has no
default, and the CLI says which flag to pass and where the directory is.

The reviewed creator profiles and the reviewed long-tail profiles stay out of
the wheel for a neighbouring reason (#147): a profile decides which sources are
trusted and what may be extracted from them, so a packaged copy could drift from
the reviewed set in the repository with nothing to say which one a run had used.
Their defaults carried the original `parents[2]` guess after #139 fixed the
fixtures one, because the rule lived at each call site with nothing relating the
copies. It lives in `modeltree_updater.layout` now, and the tests below check the
three defaults against one another as well as against the installed layout, so a
fourth call site cannot quietly grow a fourth answer.

Both halves of that decision are pinned below, because either one alone would
let the workflow break again: packaging could be turned on by a stray
`force-include`, and the default could quietly go back to guessing.

Everything here is offline. The "installed" layout is built by copying the
package into a directory shaped like site-packages, which reproduces the one
thing under test — the walk from `__file__` — exactly as `pip install` does,
with no download and no wheel build. #77 covers exercising a genuinely built
wheel in CI; that is not this issue.
"""

from __future__ import annotations

import ast
import functools
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

import modeltree_updater
from modeltree_updater import cli, layout, longtail, profiles
from modeltree_updater.budgets import CreatorBudget
from modeltree_updater.checkpoints import TOOL_VERSION
from modeltree_updater.cli import EXIT_OK, EXIT_USAGE, main
from modeltree_updater.workflow import RunSettings

_ZERO_BUDGET = CreatorBudget()

PROJECT_DIR = Path(__file__).resolve().parents[1]
PACKAGE_DIR = PROJECT_DIR / "src" / "modeltree_updater"
PYPROJECT = PROJECT_DIR / "pyproject.toml"

# An installed distribution puts the package one level under site-packages, so
# the walk that used to produce the default lands on the Python prefix instead
# of on this repository. This is the literal shape from the failing run.
INSTALLED_CLI = Path("/opt/hostedtoolcache/Python/3.13.15/x64/lib/python3.13")
INSTALLED_CLI = INSTALLED_CLI / "site-packages" / "modeltree_updater" / "cli.py"
INSTALLED_PROFILES = INSTALLED_CLI.with_name("profiles.py")
INSTALLED_LONGTAIL = INSTALLED_CLI.with_name("longtail.py")

# Every default that points at data this repository deliberately keeps out of the
# wheel, as (name, resolver, subpath below `tools/updater`). Held in one list so a
# new one is added here rather than tested on its own terms.
CHECKOUT_DEFAULTS = (
    ("fixtures", cli.source_checkout_fixtures, ("fixtures", "creators")),
    ("profiles", profiles.source_checkout_profiles, ("profiles",)),
    (
        "long-tail profiles",
        longtail.source_checkout_long_tail_profiles,
        ("profiles", "generic"),
    ),
)


@pytest.fixture(params=CHECKOUT_DEFAULTS, ids=[item[0] for item in CHECKOUT_DEFAULTS])
def checkout_default(request):
    return request.param


@pytest.fixture(scope="module")
def installed_package(tmp_path_factory) -> Path:
    """The package alone, laid out the way an install leaves it.

    Only the package is copied, because only the package is in the wheel. That
    is the point: the fixtures directory is not somewhere else on this path, it
    is absent.
    """
    site_packages = tmp_path_factory.mktemp("prefix") / "lib" / "python3.13"
    site_packages = site_packages / "site-packages"
    site_packages.mkdir(parents=True)
    shutil.copytree(
        PACKAGE_DIR,
        site_packages / "modeltree_updater",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    return site_packages


def _python(site_packages: Path, *args: str) -> subprocess.CompletedProcess:
    """Run a child interpreter that can only see the installed copy.

    `PYTHONPATH` is set to the fake site-packages alone and takes precedence
    over any real install of this package, and the working directory is a
    temporary one, so a relative `fixtures/creators` cannot resolve by accident.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = str(site_packages)
    return subprocess.run(
        [sys.executable, *args],
        cwd=site_packages.parent,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


# Every subcommand that loads the fixture library, so no single call site can
# regress on its own. `run` is first because `run` is what actually failed in
# production: the message the two tests below assert is the message that would
# have replaced the prefix path in run 32808297418. A subcommand added here
# without routing through the shared loader fails both.
FIXTURE_COMMANDS = ("run", "resume", "creators")


def _command(name: str, tmp_path: Path) -> list[str]:
    """Minimal argv for one fixture-loading subcommand.

    Each is filled out only as far as argparse requires. Nothing here is
    reachable — the library is loaded before any checkpoint is opened, so
    `resume` fails on the fixtures, not on the checkpoint id.
    """
    if name == "run":
        return ["run", "--creator", "contoso-ai"]
    if name == "resume":
        return [
            "resume",
            "--checkpoint-id",
            "any",
            "--checkpoint-dir",
            str(tmp_path / "checkpoints"),
        ]
    return ["creators"]


@pytest.fixture(params=FIXTURE_COMMANDS)
def command(request) -> str:
    return request.param


def test_a_source_checkout_still_defaults_to_the_bundled_fixtures() -> None:
    """The working case has to keep working: `run` with no flags, in a checkout."""
    assert cli.DEFAULT_FIXTURES == PROJECT_DIR / "fixtures" / "creators"
    assert cli.DEFAULT_FIXTURES.is_dir()


def test_an_installed_layout_has_no_default_fixtures_directory() -> None:
    """The root cause of #139, stated as the thing that must stay false.

    The old expression returned a path here — the prefix path in the failing
    run — and a path that exists nowhere is worse than no path at all, because
    it is reported as if someone had asked for it.
    """
    assert cli.source_checkout_fixtures(INSTALLED_CLI) is None


def test_the_default_is_not_guessed_from_an_arbitrary_install_prefix(tmp_path) -> None:
    """Not even when a `fixtures/creators` happens to sit at the same offset."""
    package = tmp_path / "lib" / "python3.13" / "site-packages" / "modeltree_updater"
    package.mkdir(parents=True)
    (package.parents[1] / "fixtures" / "creators").mkdir(parents=True)

    assert cli.source_checkout_fixtures(package / "cli.py") is None


# --------------------------------------------------------------------------
# The same question, asked once (#147)
# --------------------------------------------------------------------------
# #139 fixed the fixtures default and left the identical guess at
# `profiles.DEFAULT_PROFILES_DIR` and `longtail.REVIEWED_LONG_TAIL_DIR`, which is
# what a rule written out at each call site buys: nothing relates the copies, so
# fixing one says nothing about the others. These check the three defaults
# against each other, not just each against the installed layout — a fourth
# answer to "where is the repository?" fails here rather than in a workflow run.


def test_every_repository_default_resolves_through_the_one_layout_check(
    tmp_path, checkout_default
) -> None:
    """One resolver, three defaults: each is its own subpath of the same root."""
    name, resolve, subpath = checkout_default
    package = tmp_path / "tools" / "updater" / "src" / "modeltree_updater"
    package.mkdir(parents=True)
    module_file = package / "anything.py"

    root = layout.source_checkout_dir(module_file)

    assert root == tmp_path / "tools" / "updater"
    assert resolve(module_file) == root.joinpath(*subpath), name


def test_no_repository_default_is_guessed_from_an_install_prefix(checkout_default) -> None:
    """The root cause of #139 and #147, stated as the thing that must stay false.

    The old expression returned a path for every one of these — a directory under
    the Python prefix that exists nowhere — and a path that exists nowhere is
    worse than no path at all, because it is reported as if someone had asked
    for it.
    """
    name, resolve, _ = checkout_default

    assert resolve(INSTALLED_CLI) is None, name
    assert resolve(INSTALLED_PROFILES) is None, name
    assert resolve(INSTALLED_LONGTAIL) is None, name


def test_no_repository_default_is_guessed_from_a_prefix_that_happens_to_match(
    tmp_path, checkout_default
) -> None:
    """Not even when the directory it wants sits at exactly the old offset."""
    name, resolve, subpath = checkout_default
    package = tmp_path / "lib" / "python3.13" / "site-packages" / "modeltree_updater"
    package.mkdir(parents=True)
    package.parents[1].joinpath(*subpath).mkdir(parents=True)

    assert resolve(package / "profiles.py") is None, name


# --------------------------------------------------------------------------
# `src` is the parent's *name*, not a substring of the path (#212)
# --------------------------------------------------------------------------
# Every install prefix used above happens to have no `src` anywhere in it, so a
# check that merely looked for `src` *somewhere* in the path passed all of them
# and nothing distinguished it from the rule this module actually states. That
# is not a weaker test of the same behaviour, it is #139 again: with the
# substring form, `source_checkout_dir` answers
# `/home/src/venv/lib/python3.13` for a virtualenv made inside a directory
# called `src` — a directory under the Python prefix, in this repository's name,
# that nobody wrote. The prefixes below therefore carry `src` while the
# immediate parent still is not it, one for each way a relaxed check finds it.

SRC_IN_THE_PREFIX_BUT_NOT_THE_PARENT = (
    # A virtualenv made inside a directory named `src`, which is where the
    # substring form reproduces #139's failing shape exactly.
    "/home/src/venv/lib/python3.13/site-packages/modeltree_updater/cli.py",
    # The same, from a home or project directory named `src`.
    "/Users/src/.venv/lib/python3.11/site-packages/modeltree_updater/cli.py",
    # `src` does not have to be a whole path component to be found in the string.
    "/build/mysrc/venv/lib/python3.13/site-packages/modeltree_updater/cli.py",
    # `src` as a *suffix* of the immediate parent's name, which `endswith` takes.
    "/build/mysrc/modeltree_updater/cli.py",
    # `src` as a *prefix* of the immediate parent's name, which `startswith` takes.
    "/build/srclib/modeltree_updater/cli.py",
)


@pytest.mark.parametrize("module_file", SRC_IN_THE_PREFIX_BUT_NOT_THE_PARENT)
def test_src_elsewhere_in_the_path_is_not_a_source_checkout(module_file) -> None:
    """An install prefix containing `src` is still an install prefix.

    The rule is the package directory's parent being *named* `src`, and these
    are the paths that tell that rule apart from every looser reading of it:
    `"src" in str(package_dir)`, `.startswith("src")` and `.endswith("src")`
    each accept at least one of them and hand back a directory under the
    install prefix. No filesystem is involved — `module_file` is a parameter
    precisely so a synthetic installed path can be handed in.
    """
    assert layout.source_checkout_dir(module_file) is None


def test_a_checkout_below_a_directory_named_src_still_resolves() -> None:
    """The other half, so the check cannot be tightened into a new bug.

    A developer whose checkout lives under `~/src` has `src` in the prefix *and*
    a real `src` as the package directory's parent. Rejecting the paths above by
    refusing `src` anywhere in the path would take this with it, and it is the
    ordinary case. Only the immediate parent decides, wherever the checkout sits.
    """
    module_file = "/home/src/ModelTree/tools/updater/src/modeltree_updater/cli.py"

    assert layout.source_checkout_dir(module_file) == (
        Path("/home/src/ModelTree/tools/updater").resolve()
    )


def test_a_source_checkout_still_defaults_to_the_reviewed_profiles() -> None:
    """The working case has to keep working: the checkout's own reviewed sets."""
    assert profiles.DEFAULT_PROFILES_DIR == PROJECT_DIR / "profiles"
    assert profiles.DEFAULT_PROFILES_DIR.is_dir()
    assert longtail.REVIEWED_LONG_TAIL_DIR == PROJECT_DIR / "profiles" / "generic"
    assert longtail.REVIEWED_LONG_TAIL_DIR.is_dir()
    assert longtail.DEFAULT_LONG_TAIL_PROFILE == (
        PROJECT_DIR / "profiles" / "generic" / "long-tail.json"
    )
    assert longtail.DEFAULT_LONG_TAIL_PROFILE.is_file()


def _climbs_from_file_root(module_source: str, *, depth: int = 0) -> list[str]:
    """Every expression in ``module_source`` that walks out of the package from ``__file__``.

    This is the structural replacement for grepping the literal string ``parents[2]``.
    That grep saw one spelling of one idea; the idea is "root an ``os``-style path
    walk at this module's own ``__file__`` and climb far enough up to leave the
    installed package", and it has many spellings that all mean it:

        Path(__file__).resolve().parents[2]
        Path(__file__).parent.parent.parent
        Path(__file__).resolve().parents[3]
        here = Path(__file__).resolve(); here.parents[2]        # via a variable
        Path(__file__).parents[1 + 1]                           # arithmetic index
        Path(__file__).parents[-1]                              # negative index

    The root has spellings of its own, on an axis independent of the climb — the
    module's path can be named, fetched out of a mapping, read off a module
    object, or interpolated:

        Path(globals().get('__file__')).parents[2]              # fetched, not named
        Path(getattr(sys.modules[__name__], '__file__')).parents[2]
        Path(f'{__file__}').parents[2]

    We parse the module and, for every attribute/subscript chain rooted at
    ``Path(__file__)`` (optionally through ``.resolve()`` and optionally through a
    local variable that was itself bound to such a chain), we sum how many directory
    levels the chain climbs: each ``.parent`` is one level, ``.parents[k]`` for a
    constant ``k`` is ``k`` levels. A subscript whose index is *not* a provable
    non-negative constant — a negative literal, an arithmetic expression, a name — is
    the evasion this exists to stop, so it counts as "unknown, therefore suspect".

    Two levels is the boundary for a module that sits directly under
    ``modeltree_updater/`` because it is the smallest climb that leaves the
    package: ``modeltree_updater/foo.py`` -> ``.parent`` is the package dir, a second
    ``.parent`` is ``src``/``site-packages`` and everything above is outside. One
    ``.parent`` (staying inside the package) is legitimate and stays quiet.

    The boundary tracks the module's own depth rather than being a fixed two.
    ``depth`` is how many directories the module sits below ``modeltree_updater/``,
    and a climb is flagged only once it exceeds ``depth + 1`` levels — the number it
    takes to reach the package root — so it is caught only when it actually leaves
    the package. A module one level deeper, ``modeltree_updater/providers/foo.py``,
    needs three levels to clear the package, so its two-level climb lands back on
    ``modeltree_updater/`` and stays quiet; a fixed two-level boundary would flag it
    even though nothing left the package. Callers that scan a real module pass its
    depth; the default of ``0`` matches a bare source snippet at the package root.

    Known limits, stated rather than papered over. What this proves is narrow, and
    worth stating as a sentence rather than as a list of spellings it happens to
    catch: *within one module's own text*, a ``pathlib`` chain whose root
    expression mentions this module's path — the ``__file__`` global, a
    ``'__file__'`` mapping key, a ``.__file__`` attribute, or a local bound to one
    of those — and which then climbs past the package boundary via
    ``.parent``/``.parents`` is reported. Everything outside that sentence is open,
    and the rest of this block is the honest reading of it.

    The ``globals()`` channel is **not** closed, and cannot be closed here.
    ``globals()`` returns an ordinary dict, and a dict can be read in unboundedly
    many ways, so no finite matcher owns the channel. Matching on the key *text*
    covers the ways the fetch is actually written — ``globals()['__file__']``,
    ``globals().get('__file__')`` with or without a default, ``vars()``/``locals()``,
    ``globals().pop('__file__')``, an aliased ``g = globals()``, and even
    ``globals()[k]`` after ``k = '__file__'`` — because every one of them spells the
    key out somewhere in the module's own text. It does not cover a key whose text
    is never written here: ``globals()['__fi' + 'le__']`` assembles it at runtime,
    and ``globals()[k]`` slips whenever ``k`` arrives from a function parameter or
    an import. Each of those was tried rather than assumed, and each came back
    quiet. So this is a net over the ways the fetch gets written, never a proof that
    the channel is shut. #255 listed the subscript form as resolved, and that reads
    as the channel being closed while the near-twin ``.get`` still walked through it
    (#273); this paragraph is the wording that stops the same misreading recurring.

    Also open, each confirmed by trying it: a path taken from a different dunder
    (``__spec__.origin``, ``__loader__.get_filename()``) or from the interpreter
    (``inspect.getfile``, ``inspect.currentframe().f_code.co_filename``,
    ``sys.argv[0]``), none of which mentions ``__file__`` at all; a climb that never
    appears as ``.parent``/``.parents`` because it is written as ``os.path.dirname``
    nesting, a ``'../..'`` join, or text surgery on the path itself — note the
    asymmetry that ``Path(f'{__file__}')`` is matched as a *root* while a climb
    spelled inside that same string, ``Path(f'{__file__}/../..')``, is not seen; a
    constructor this cannot recognise as ``Path``, which is ``PurePath``, ``Path``
    imported under an alias, and a subclass of ``Path`` — one limit with three
    spellings rather than three limits, since the root is unrecognisable for the
    same reason in each and closing one without the others would be arbitrary; a
    binding chain read backwards (``b = a`` written above ``a = __file__``, which
    the single pre-pass below resolves in the other direction only); a root wrapped
    in a walrus (``(p := Path(__file__).resolve()).parents[2]``), which the level
    counter has no case for and which the pre-passes do not record because they
    learn bindings only from ``Assign``/``AnnAssign``; a root read back off a class
    object (``class C: p = Path(__file__).resolve()`` then ``C.p.parents[2]``),
    where the binding *is* recorded under the bare name ``p`` but the counter
    resolves a bare ``Name`` and never an attribute of one; and a climb assembled
    across a function-call boundary. It is a stronger net than the literal grep,
    not a proof of the negative. ``GUARD_KNOWN_LIMITS`` below runs every one of
    these, so the list is measured rather than asserted and goes red if one is ever
    closed silently. That claim is only worth what its coverage is: every construct
    named in this block has a row in that table, and a construct named here without
    one would be exactly the failure this paragraph exists to prevent (#273).

    That coupling runs one way only, and #317 is what reading it the other way
    looks like. A row for every construct named here is not a row for every
    construct that is open: the three constructs #317 named — the subclass, the
    walrus and the class object — sat open with nothing naming them, while the
    table's evident rigour invited the conclusion that it was a survey of the gap
    rather than a sample of it. Naming them closes that particular hole and does
    not change the shape of the claim, so neither this block nor the table below
    should be read as bounding what escapes.

    Two widenings are deliberate rather than incidental (#273), and are recorded
    here so the next reader meets them as decisions rather than surprises.

    The first is the ``.__file__`` attribute arm, which does not ask *whose* module
    object it reads, so ``Path(other_module.__file__).resolve().parents[2]`` is
    flagged as well as the module's own. That is wanted: climbing out of another
    module's file to guess a repository path is the same defect with a worse blast
    radius, because the climbing module does not even own the layout it is assuming.
    A module that genuinely needs another package's directory has the remedy the
    failure message already names, ``layout.source_checkout_dir``.

    The second is ``file_vars``, which is module-wide and scope-blind. A name bound
    to the module's path anywhere in the module marks that name *everywhere* in it,
    with no notion of scope, shadowing, reachability or rebinding. Five constructs
    were tried where the name is not the module's path at the point of use — a
    parameter that shadows it, a class-body attribute, a binding in a branch that
    never runs, a name later rebound to something else, and an unrelated function's
    local — and all five flag. This is the larger of the two vectors and it is kept
    anyway, because it errs toward over-reporting rather than toward missing a real
    climb, the failure it produces names the expression so a reader can dismiss it
    in seconds, and there are zero live instances in the package. The alternative is
    a scope-aware pass, which is a different piece of work; if one of these ever
    fires on a legitimate module, that is the trigger to do it rather than to
    loosen the arm.

    The list it returns is offenders, each rendered back to source for the failure
    message.
    """
    UNKNOWN = 10_000  # a climb we cannot bound is treated as "definitely too far"

    # Locals bound to the module's own path, so a root reached through a plain
    # variable (``_HERE = __file__``) is not invisible. Filled by the pre-pass below.
    file_vars: set[str] = set()

    def _is_file_expr(node: ast.AST) -> bool:
        """Does this expression name the running module's own path?

        One structural rule rather than one arm per spelling: an expression that
        *mentions* ``__file__`` anywhere inside it is treated as that path —
        whether as the global itself, as a ``.__file__`` attribute on some module
        object, as the string key ``'__file__'`` handed to a mapping, or through a
        local bound to one of those. ``globals()['__file__']``,
        ``globals().get('__file__')``, ``vars()``/``locals()``, an aliased
        ``g = globals()``, ``getattr(mod, '__file__')`` and ``Path(f'{__file__}')``
        then all follow from the rule instead of each needing its own case, which
        is what stops the next near-twin spelling from being a fresh gap. It
        over-approximates deliberately; the known limits above say what it still
        cannot see, and why a general rule does not exist for the rest.
        """
        for inner in ast.walk(node):
            if isinstance(inner, ast.Name) and (
                inner.id == "__file__" or inner.id in file_vars
            ):
                return True
            if isinstance(inner, ast.Attribute) and inner.attr == "__file__":
                return True
            if isinstance(inner, ast.Constant) and inner.value == "__file__":
                return True
        return False

    def _is_file_root(node: ast.AST) -> bool:
        # Path(<file-expr>)  (optionally .resolve()) — the anchor every walk starts at.
        target = node
        if (
            isinstance(target, ast.Call)
            and isinstance(target.func, ast.Attribute)
            and target.func.attr == "resolve"
        ):
            target = target.func.value
        return (
            isinstance(target, ast.Call)
            and isinstance(target.func, ast.Name)
            and target.func.id == "Path"
            and len(target.args) == 1
            and _is_file_expr(target.args[0])
        )

    # Locals bound to a file-rooted path, and how far up they already climbed, so a
    # walk routed through an intermediate variable is not invisible.
    rooted_vars: dict[str, int] = {}

    def _levels_and_rooted(node: ast.AST) -> tuple[int, bool]:
        """Return (levels climbed, whether the chain is rooted at ``__file__``)."""
        if _is_file_root(node):
            return 0, True
        if isinstance(node, ast.Name):
            if node.id in rooted_vars:
                return rooted_vars[node.id], True
            return 0, False
        if isinstance(node, ast.Call):
            # Ignore .resolve()/.absolute() etc.: they do not climb.
            if isinstance(node.func, ast.Attribute):
                base, rooted = _levels_and_rooted(node.func.value)
                return base, rooted
            return 0, False
        if isinstance(node, ast.Attribute):
            base, rooted = _levels_and_rooted(node.value)
            if not rooted:
                return 0, False
            if node.attr == "parent":
                return base + 1, True
            if node.attr == "parents":
                # `.parents` on its own contributes nothing; the Subscript adds it.
                return base, True
            return base, True
        if isinstance(node, ast.Subscript):
            base, rooted = _levels_and_rooted(node.value)
            if not rooted:
                return 0, False
            is_parents = (
                isinstance(node.value, ast.Attribute) and node.value.attr == "parents"
            )
            if not is_parents:
                return base, True
            index = node.slice
            if isinstance(index, ast.Constant) and isinstance(index.value, int):
                if index.value < 0:
                    return base + UNKNOWN, True  # negative index: unbounded, suspect
                # parents[k] is the (k+1)-th ancestor: k levels above `.parent`,
                # counted as k+1 climbs from the file so parents[2] == 3 levels,
                # the same three-deep walk as `.parent.parent.parent`.
                return base + index.value + 1, True
            return base + UNKNOWN, True  # name / arithmetic / anything non-constant
        return 0, False

    tree = ast.parse(module_source)
    offenders: list[str] = []

    # Learn locals bound to the module's own path before anything else, so a root
    # written as ``Path(_HERE)`` resolves. This pass finishes before the offender
    # scan, so a binding written below its use still counts; what it does not do is
    # iterate to a fixpoint, so a chain is transitive only when written in
    # dependency order (``a = __file__`` then ``b = a``, not the reverse).
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value: ast.AST | None = node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            names = [node.target.id] if isinstance(node.target, ast.Name) else []
            value = node.value
        else:
            continue
        if names and value is not None and _is_file_expr(value):
            file_vars.update(names)

    for node in ast.walk(tree):
        # Learn variables bound to a file-rooted path first, so later references resolve.
        if isinstance(node, ast.Assign):
            levels, rooted = _levels_and_rooted(node.value)
            if rooted:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        rooted_vars[target.id] = levels
        elif isinstance(node, (ast.AnnAssign,)) and node.value is not None:
            levels, rooted = _levels_and_rooted(node.value)
            if rooted and isinstance(node.target, ast.Name):
                rooted_vars[node.target.id] = levels

    for node in ast.walk(tree):
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            levels, rooted = _levels_and_rooted(node)
            if rooted and levels >= depth + 2:
                offenders.append(ast.unparse(node))

    # De-duplicate while collapsing sub-chains: a full `a.parent.parent` also matches
    # its own `a.parent.parent` prefix once, so unique rendered forms are enough.
    return sorted(set(offenders))


# The evasions the structural guard blocks, each a spelling of the same three-deep
# walk out of the installed package. Held in one table so the guard's own test and
# the demonstration test below draw the offenders from the same source of truth
# rather than each asserting its own list.
GUARD_EVASIONS = {
    "literal parents[2]": "Path(__file__).resolve().parents[2] / 'profiles'",
    "chained .parent": "Path(__file__).parent.parent.parent / 'profiles'",
    "deeper parents[3]": "Path(__file__).resolve().parents[3] / 'profiles'",
    "intermediate variable": (
        "here = Path(__file__).resolve()\n"
        "root = here.parents[2] / 'profiles'"
    ),
    "arithmetic index": "Path(__file__).parents[1 + 1] / 'profiles'",
    "negative index": "Path(__file__).parents[-1] / 'profiles'",
    "variable index": "n = 2\nroot = Path(__file__).parents[n] / 'profiles'",
    "split across lines": (
        "root = (\n    Path(__file__).resolve()\n    .parents[2]\n)"
    ),
    "globals()['__file__'] fetch": (
        "Path(globals()['__file__']).resolve().parents[2] / 'profiles'"
    ),
    "sys.modules __file__ attribute": (
        "Path(sys.modules[__name__].__file__).parent.parent.parent / 'profiles'"
    ),
    # #273: the near-twin of the subscript form above, which #255 left open while
    # its docstring read as though the globals() channel were closed. The rest of
    # this block is the same channel written the other natural ways, plus the two
    # non-globals() forms #273 names, plus the ones invented while closing it.
    "globals().get fetch": (
        "Path(globals().get('__file__')).resolve().parents[2] / 'profiles'"
    ),
    "globals().get with a default": (
        "Path(globals().get('__file__', '')).resolve().parents[2] / 'profiles'"
    ),
    "globals().pop fetch": (
        "Path(globals().pop('__file__')).resolve().parents[2] / 'profiles'"
    ),
    "vars() mapping fetch": (
        "Path(vars()['__file__']).resolve().parents[2] / 'profiles'"
    ),
    "locals() mapping fetch": (
        "Path(locals()['__file__']).resolve().parents[2] / 'profiles'"
    ),
    "aliased globals mapping": (
        "g = globals()\n"
        "root = Path(g['__file__']).resolve().parents[2] / 'profiles'"
    ),
    "key held in a local literal": (
        "k = '__file__'\n"
        "root = Path(globals()[k]).resolve().parents[2] / 'profiles'"
    ),
    "getattr on a module object": (
        "Path(getattr(sys.modules[__name__], '__file__')).resolve().parents[2]"
    ),
    "f-string interpolation": (
        "Path(f'{__file__}').resolve().parents[2] / 'profiles'"
    ),
    "str() coercion": "Path(str(__file__)).resolve().parents[2] / 'profiles'",
    "os.fspath coercion": "Path(os.fspath(__file__)).resolve().parents[2]",
    "variable bound to __file__": (
        "_HERE = __file__\n"
        "root = Path(_HERE).resolve().parents[2] / 'profiles'"
    ),
    "annotated variable bound to __file__": (
        "_HERE: str = globals()['__file__']\n"
        "root = Path(_HERE).parents[2] / 'profiles'"
    ),
    "importlib module attribute": (
        "Path(importlib.import_module(__name__).__file__).resolve().parents[2]"
    ),
}

# Walks that stay inside the package, or do not root at __file__ at all, which the
# guard must leave alone or it would flag every legitimate `.parent`.
GUARD_NON_OFFENDERS = {
    "single .parent stays in package": "Path(__file__).parent / 'data.json'",
    "parents[0] is the package dir": "Path(__file__).resolve().parents[0]",
    "not rooted at __file__": "other = Path('/etc'); root = other.parent.parent",
    "resolve does not climb": "Path(__file__).resolve() / 'data.json'",
    # #273 widened the matcher from three named spellings to "mentions __file__
    # anywhere in the root expression", which is a much larger net, so these pin
    # the ordinary reasons a module touches __file__ or a mapping and must not be
    # dragged in with it.
    "reads __file__ only for a message": "print(f'loaded from {__file__}')",
    "__file__ in a variable that is only printed": "_HERE = __file__\nprint(_HERE)",
    "package data beside the module": (
        "DATA = Path(__file__).parent / 'schemas' / 'x.json'"
    ),
    "one .parent from a globals fetch": "Path(globals()['__file__']).parent / 'x'",
    "globals().get of something else": "Path(globals().get('DATA_DIR', '.')) / 'x'",
    "a literal path that contains the word": "Path('/tmp/__file__/data')",
    "an unrelated mapping key": "Path(cfg['data_dir']).parent.parent",
    "a module attribute that is not __file__": (
        "Path(sys.modules[__name__].__spec__.name)"
    ),
}


# Forms tried against the guard that it does **not** catch, each run rather than
# assumed. This table exists so the residual-limits block in
# ``_climbs_from_file_root`` is measured instead of asserted: #255 shortened that
# list without proving the shortening, which is what #273 was filed about. Locking
# a weakness in is the point — if a later widening closes one of these, this test
# goes red, and the fix is to move the entry up into ``GUARD_EVASIONS`` *and*
# strike it from the docstring, so the code and its stated limits cannot drift.
#
# What a row asserts is narrow and worth stating: the guard does not flag this
# source. It does not assert that every row is a working escape. Executing all
# nineteen in a throwaway package showed sixteen genuinely landing outside it,
# and three that do not: "binding chain read backwards" raises ``NameError`` as
# written, so it documents the pre-pass's single-direction ordering rather than a
# runnable attack; "climb by string surgery" splits on ``'/'``, so it climbs
# three levels on POSIX and is a no-op on a Windows path; and "a subclass of
# Path" raises ``AttributeError: type object 'MyPath' has no attribute
# '_flavour'`` on 3.11, the floor ``requires-python`` declares, because pathlib
# supports subclassing ``Path`` only from 3.12 on. All three are still real blind
# spots in the matcher; none is a live exploit on every supported version, and
# saying so here costs a sentence and keeps this table from making the same
# oversized claim #273 was filed about.
#
# This is a sample of the forms that are open, and never a survey of them (#317).
# The rows are the forms somebody thought to try; the thing they sample is every
# source the guard does not flag, which is not a finite set and so cannot be
# enumerated here or anywhere. A form's absence from this table is therefore
# evidence about who has probed the guard and no evidence at all about the guard.
# #317 was filed because the opposite reading is the natural one — a measured,
# evidently-tested table reads as exhaustive — and it was filed about three forms
# that had sat open with nothing naming them. They are rows now, which changes
# how much of the gap is written down and does not change that it is a sample.
# The next form found open belongs here too, and is a row to add rather than a
# contradiction of anything this table ever claimed.
GUARD_KNOWN_LIMITS = {
    # The globals() channel is a dict read, and a dict read is not a finite set of
    # spellings. These are the ways the key text never appears in this module.
    "key assembled at runtime": "Path(globals()['__fi' + 'le__']).resolve().parents[2]",
    "key from a function parameter": (
        "def f(k):\n    return Path(globals()[k]).resolve().parents[2]"
    ),
    "key imported from elsewhere": (
        "from cfg import KEY\nroot = Path(globals()[KEY]).resolve().parents[2]"
    ),
    # A different channel to the same path, mentioning __file__ nowhere.
    "__spec__.origin": "Path(__spec__.origin).resolve().parents[2]",
    "__loader__.get_filename()": "Path(__loader__.get_filename()).resolve().parents[2]",
    "inspect.getfile": "Path(inspect.getfile(sys.modules[__name__])).parents[2]",
    "the running frame's co_filename": (
        "Path(inspect.currentframe().f_code.co_filename).parents[2]"
    ),
    "sys.argv[0]": "Path(sys.argv[0]).resolve().parents[2]",
    # The root is seen; the climb is not, because it is never .parent/.parents.
    "climb spelled inside the f-string": "Path(f'{__file__}/../../..').resolve()",
    "climb by string surgery": "Path(__file__.rsplit('/', 3)[0])",
    "os.path.dirname nesting": (
        "os.path.dirname(os.path.dirname(os.path.dirname(__file__)))"
    ),
    "string '../..' join": "Path(__file__).joinpath('..', '..', '..')",
    # Neither the root nor the climb is legible in this module's text.
    "aliased Path import": "from pathlib import Path as P\nroot = P(__file__).parents[2]",
    # The same limit as the alias above, spelled the other way: `_is_file_root`
    # recognises the constructor by the name `Path`, so any other name that
    # produces a path object is invisible. #273 scopes closing this out, and it
    # would be arbitrary to close one spelling and leave the other.
    "PurePath instead of Path": (
        "from pathlib import PurePath\nroot = PurePath(__file__).parents[2]"
    ),
    # And the third spelling of it (#317). `Path` subclassed is unrecognisable for
    # exactly the reason the two above are: `_is_file_root` asks whether the
    # constructor is spelled `Path`, not whether it produces a path. Runnable from
    # 3.12 on; see the note above for what it does on the 3.11 floor.
    "a subclass of Path": (
        "class MyPath(Path):\n    pass\nroot = MyPath(__file__).parents[2]"
    ),
    "binding chain read backwards": (
        "b = a\na = __file__\nroot = Path(b).resolve().parents[2]"
    ),
    "assembled across a function boundary": (
        "def here():\n    return Path(__file__).resolve()\nroot = here().parents[2]"
    ),
    # Root and climb are both plainly legible in these two; what is missing is the
    # link between them. The pre-passes learn bindings only from `Assign` and
    # `AnnAssign` targets, so a walrus binds nothing they see, and `_levels_and_rooted`
    # resolves a bare `Name` against `rooted_vars` and never an attribute of one, so
    # the class-body binding it does record under `p` is unreachable when the read
    # is spelled `C.p`. Both were probed for #317 rather than reasoned about.
    "walrus-bound root": "root = (p := Path(__file__).resolve()).parents[2]",
    "class attribute read off the class": (
        "class C:\n    p = Path(__file__).resolve()\nroot = C.p.parents[2]"
    ),
}


@pytest.mark.parametrize("case", sorted(GUARD_EVASIONS), ids=lambda name: name)
def test_the_structural_guard_flags_every_evasion_of_the_literal_walk(case) -> None:
    """Each spelling of the three-deep walk is caught, demonstrated one at a time.

    This is the "before the guard is widened, each fixture goes red" evidence
    (#198 acceptance 1): the detector is handed a module containing exactly one
    offending walk and must return it. The literal ``parents[2]`` case is included
    so the structural check is shown to still catch what the grep caught.
    """
    module_source = GUARD_EVASIONS[case]
    offenders = _climbs_from_file_root(module_source)
    assert offenders, (
        f"the {case!r} spelling walked out of the package but the structural "
        f"guard did not flag it:\n{module_source}"
    )


@pytest.mark.parametrize("case", sorted(GUARD_NON_OFFENDERS), ids=lambda name: name)
def test_the_structural_guard_leaves_legitimate_walks_alone(case) -> None:
    """A single ``.parent`` and unrelated paths must not trip the guard.

    Without this the guard would fail against its own tree the moment any module
    used ``Path(__file__).parent`` legitimately, which is #198 acceptance 2 in
    miniature: widening must add no false positives.
    """
    offenders = _climbs_from_file_root(GUARD_NON_OFFENDERS[case])
    assert not offenders, (
        f"the legitimate {case!r} path was wrongly flagged as walking out: {offenders}"
    )


@pytest.mark.parametrize("case", sorted(GUARD_KNOWN_LIMITS), ids=lambda name: name)
def test_the_structural_guard_s_documented_limits_are_still_its_limits(case) -> None:
    """Every limit the docstring claims is open is checked to actually be open.

    #273: the failure mode this repository keeps hitting is a limits list edited to
    look better than the code. #255 moved two entries off it correctly and left a
    near-twin of one of them uncaught, so the list read as covering a channel it did
    not cover. A limits list nobody executes is a comment, and comments do not fail.

    So this asserts the *absence* of coverage on purpose. Going red here is not a
    regression — it means a widening closed one of these, and the entry should move
    into ``GUARD_EVASIONS`` and out of the docstring in the same commit. That
    coupling is the whole point: the code and its stated limits cannot drift apart
    without a test naming the one that moved.
    """
    offenders = _climbs_from_file_root(GUARD_KNOWN_LIMITS[case])
    assert not offenders, (
        f"the {case!r} form is now caught, but it is still listed as a known limit "
        f"of _climbs_from_file_root: {offenders}. Move it into GUARD_EVASIONS and "
        "strike it from that function's docstring, so the documented limits keep "
        "matching the code (#273)."
    )


# Every way the module globals are read for `__file__` that spells the key out in
# the module's own text. #255 covered the first of these and its docstring then read
# as though the channel were shut; `.get` is the single most natural way to write
# the same fetch and it walked straight through (#273).
GLOBALS_CHANNEL_FETCHES = {
    "subscript": "Path(globals()['__file__']).resolve().parents[2]",
    ".get": "Path(globals().get('__file__')).resolve().parents[2]",
    ".get with a default": "Path(globals().get('__file__', '')).resolve().parents[2]",
    ".pop": "Path(globals().pop('__file__')).resolve().parents[2]",
    "vars()": "Path(vars()['__file__']).resolve().parents[2]",
    "locals()": "Path(locals()['__file__']).resolve().parents[2]",
    "an aliased dict": "g = globals()\nroot = Path(g['__file__']).parents[2]",
    "a key held in a local": "k = '__file__'\nroot = Path(globals()[k]).parents[2]",
}

# The same channel, written so the key text never appears here at all.
GLOBALS_CHANNEL_ESCAPES = {
    "a key assembled at runtime": "Path(globals()['__fi' + 'le__']).parents[2]",
    "a key from a parameter": "def f(k):\n    return Path(globals()[k]).parents[2]",
}


def test_the_globals_channel_is_matched_by_key_text_and_is_not_closed() -> None:
    """#273, both halves in one place: what the globals() arm buys, and what it isn't.

    The first half is the fix. Reading ``__file__`` out of the module globals is
    matched by the key *text* rather than by one blessed spelling, so every fetch
    that writes the key here is caught — subscript, ``.get`` with and without a
    default, ``.pop``, ``vars()``, ``locals()``, an aliased dict, and a key parked in
    a local. Enumerating spellings is what left ``.get`` open after #255; matching
    the text is the general rule that makes the near-twins fall out for free.

    The second half is the honesty, and it is why the docstring must not say the
    channel is closed. ``globals()`` is an ordinary dict, and reading a key from a
    dict has no finite set of forms: once the key text is assembled at runtime or
    arrives from outside this module, nothing in the source says ``__file__`` and
    there is nothing left to match on. These two are asserted uncaught so the claim
    "not closed" is a measurement rather than a hedge.
    """
    for name, source in sorted(GLOBALS_CHANNEL_FETCHES.items()):
        assert _climbs_from_file_root(source), (
            f"the globals() fetch spelled with {name} walked out of the package "
            f"and was not flagged:\n{source}"
        )

    for name, source in sorted(GLOBALS_CHANNEL_ESCAPES.items()):
        assert not _climbs_from_file_root(source), (
            f"the globals() fetch using {name} is now caught; the docstring still "
            f"says the channel is open there, so update both together:\n{source}"
        )


def test_a_climb_out_of_another_module_s_file_is_flagged_too() -> None:
    """The latent false-positive vector from #255, ruled on rather than discovered.

    Matching ``.__file__`` as an attribute does not ask whose module object it reads,
    so ``Path(other_module.__file__).resolve().parents[2]`` is flagged as well as the
    module's own. There are no live instances, so nothing forces the question — which
    is exactly why #273 asks for it to be decided here instead of when some future
    module trips it.

    The ruling is that this is wanted, and pinned so it cannot be narrowed by
    accident. Climbing out of another module's file to guess a repository path is
    the same defect as climbing out of your own, with a worse blast radius: the
    climbing module does not own the layout it is assuming, so it breaks when a
    package it merely imports is installed differently. The remedy is the one the
    failure message already names — ``layout.source_checkout_dir``, which checks the
    layout instead of assuming it.
    """
    source = "import other_pkg\nroot = Path(other_pkg.__file__).resolve().parents[2]"

    assert _climbs_from_file_root(source), (
        "a deep climb out of another module's __file__ must be flagged too; if that "
        "is ever narrowed to the module's own file, say so in the docstring"
    )


# A two-level climb: the smallest walk that leaves a module sitting directly under
# `modeltree_updater/`, but one that lands back on the package root from a module one
# directory deeper (e.g. `providers/foo.py` -> `modeltree_updater/`).
_TWO_LEVEL_CLIMB = "root = Path(__file__).parent.parent / 'data.json'"


def test_a_two_level_climb_is_read_against_the_module_s_own_depth() -> None:
    """The climb boundary tracks depth, so a deeper module's in-package walk is quiet.

    Issue #255 part 2: the matcher measured levels from ``__file__`` and flagged at a
    fixed two regardless of how deep the module sat, which would trap the first
    sub-package module that legitimately climbed two levels back to
    ``modeltree_updater/``. The same two-level climb must read as an evasion from the
    package root (``depth`` 0, where two levels leaves the package) and as legitimate
    from one level deeper (``depth`` 1, where two levels lands on the package root).
    """
    assert _climbs_from_file_root(_TWO_LEVEL_CLIMB, depth=0), (
        "a two-level climb from the package root leaves the package and must be flagged"
    )
    assert not _climbs_from_file_root(_TWO_LEVEL_CLIMB, depth=1), (
        "a two-level climb from a module one directory deeper lands back inside "
        "modeltree_updater/ and must stay quiet"
    )


def test_a_deeper_module_that_still_clears_the_package_is_flagged() -> None:
    """Depth-awareness does not go soft: a deeper walk that does leave is still caught.

    The counterpart to the test above — raising the boundary by the module's depth must
    not let a genuine escape through. From ``depth`` 1 it takes three levels to clear
    the package, and that three-level climb must be flagged.
    """
    source = "root = Path(__file__).parent.parent.parent / 'data.json'"
    assert _climbs_from_file_root(source, depth=1), (
        "a three-level climb from a module one directory deep leaves the package and "
        "must be flagged"
    )


def test_no_module_walks_out_to_the_repository_on_its_own() -> None:
    """The guess, as a shape, confined to the module that checks it.

    ``Path(__file__).resolve().parents[2]`` is the expression #139 named and #147
    found two more of. A new one would be a second answer to a question that has
    one, and it would be invisible to the tests above, which can only compare the
    resolvers they already know about. `layout.py` is excluded because quoting the
    expression it replaces is what that module is for.

    Matched structurally rather than textually (#198): the guard parses each module
    and reasons about what the path expression *evaluates to* — how many levels it
    climbs from ``__file__`` — so it catches ``.parent.parent.parent``, ``parents[3]``,
    a walk routed through a variable, and non-constant indices, not just the one
    spelling ``parents[2]``. ``_climbs_from_file_root`` documents what it does and
    does not catch; the widening is a stronger net, not a proof.

    Each module is scanned against its own depth below ``modeltree_updater/``, so a
    two-level climb from a sub-package module that lands back inside the package is
    not mistaken for one that leaves it.
    """
    offenders = sorted(
        path.relative_to(PACKAGE_DIR).as_posix()
        for path in PACKAGE_DIR.rglob("*.py")
        if path.name != "layout.py"
        and _climbs_from_file_root(
            path.read_text(encoding="utf-8"),
            depth=len(path.relative_to(PACKAGE_DIR).parts) - 1,
        )
    )

    assert not offenders, (
        f"{', '.join(offenders)} walks out of the package to guess a repository "
        "path; derive it from modeltree_updater.layout.source_checkout_dir "
        "instead, which checks the layout rather than assuming it"
    )


def test_no_default_is_a_usage_error_that_names_the_flag_and_the_path(
    monkeypatch, capsys, command, tmp_path
) -> None:
    """What the installed console entry point says when it has nothing to read."""
    monkeypatch.setattr(cli, "DEFAULT_FIXTURES", None)

    code = main(_command(command, tmp_path), env={})
    output = capsys.readouterr().out

    assert code == EXIT_USAGE
    assert "--fixtures" in output
    assert "tools/updater/fixtures/creators" in output
    assert "not packaged" in output
    assert "Traceback" not in output


def test_a_missing_fixtures_directory_is_more_than_a_bare_path(
    tmp_path, capsys, command
) -> None:
    """The path is still named — it just is not the whole message any more."""
    missing = tmp_path / "not-here"

    code = main([*_command(command, tmp_path), "--fixtures", str(missing)], env={})
    output = capsys.readouterr().out

    assert code == EXIT_USAGE
    assert str(missing) in output
    assert "--fixtures" in output
    assert "tools/updater/fixtures/creators" in output


def test_the_installed_copy_is_the_one_being_tested(installed_package) -> None:
    """Otherwise every assertion below could be about the source tree."""
    result = _python(
        installed_package,
        "-c",
        "import json, modeltree_updater.cli as cli; "
        "print(json.dumps([cli.__file__, str(cli.DEFAULT_FIXTURES)]))",
    )

    assert result.returncode == 0, result.stderr
    module_file, default = json.loads(result.stdout)
    assert Path(module_file).is_relative_to(installed_package)
    assert default == "None"


def test_the_installed_entry_point_refuses_with_an_actionable_message(
    installed_package, tmp_path, command
) -> None:
    """End to end, as a subprocess: the failure in #139, now answered."""
    result = _python(installed_package, "-m", "modeltree_updater", *_command(command, tmp_path))
    output = result.stdout + result.stderr

    assert result.returncode == EXIT_USAGE, output
    assert "--fixtures" in output
    assert "tools/updater/fixtures/creators" in output
    assert "lib/python3.13/fixtures/creators" not in output
    assert "Traceback" not in output


def test_the_production_run_invocation_no_longer_reports_a_path_nobody_wrote(
    installed_package, tmp_path
) -> None:
    """The exact command that failed, in the exact shape the workflow sends it.

    `run` is what run 32808297418 executed, and `run` is what the other tests
    here did not cover: with the shared loader reverted on this one call site,
    every other assertion in this file still passed. So this pins the command
    rather than the code path — same subcommand, same flags, same installed
    layout, with only `--fixtures` removed, which is precisely the difference
    between the failing run and the fixed one.
    """
    result = _python(
        installed_package,
        "-m",
        "modeltree_updater",
        "run",
        "--creator",
        "openai",
        "--creator",
        "anthropic",
        "--run-id",
        "run-139-1",
        "--output",
        str(tmp_path / "proposals"),
    )
    output = result.stdout + result.stderr

    assert result.returncode == EXIT_USAGE, output
    # The shape of the reported failure: a prefix path was the whole message.
    assert not re.search(r"fixture directory not found: \S*python3\.\d+/fixtures", output)
    assert "--fixtures" in output
    assert "tools/updater/fixtures/creators" in output
    assert "Traceback" not in output
    assert not (tmp_path / "proposals").exists(), "a refused run writes nothing"


def test_the_installed_entry_point_runs_when_given_the_checkout_fixtures(
    installed_package, tmp_path, fixture_dir
) -> None:
    """The workflow's invocation form: installed package, fixtures from the tree."""
    output_dir = tmp_path / "proposals"
    result = _python(
        installed_package,
        "-m",
        "modeltree_updater",
        "run",
        "--creator",
        "contoso-ai",
        "--fixtures",
        str(fixture_dir),
        "--output",
        str(output_dir),
        "--run-id",
        "run-installed",
        "--timestamp",
        "2026-06-01T00:00:00+00:00",
    )
    output = result.stdout + result.stderr

    assert result.returncode == EXIT_OK, output
    assert "contoso-ai: complete" in output
    report = json.loads(
        (output_dir / "run-installed" / "report.json").read_text(encoding="utf-8")
    )
    assert report["settings"]["mode"] == "proposal-only"


def test_the_installed_copy_has_no_reviewed_profiles_default_either(
    installed_package,
) -> None:
    """The #147 constants, read out of a real installed layout in a child process.

    In process these resolve from the working tree no matter what, which is why
    the suite stayed green at 486 while the installed path was broken. Here the
    only copy on the path is the one under a directory shaped like site-packages,
    so what is printed is what the publisher workflow's interpreter would see.
    """
    result = _python(
        installed_package,
        "-c",
        "import json; "
        "from modeltree_updater import longtail, profiles; "
        "print(json.dumps([profiles.__file__, "
        "str(profiles.DEFAULT_PROFILES_DIR), "
        "str(longtail.REVIEWED_LONG_TAIL_DIR), "
        "str(longtail.DEFAULT_LONG_TAIL_PROFILE)]))",
    )

    assert result.returncode == 0, result.stderr
    module_file, profiles_dir, long_tail_dir, long_tail_profile = json.loads(result.stdout)
    assert Path(module_file).is_relative_to(installed_package)
    assert [profiles_dir, long_tail_dir, long_tail_profile] == ["None", "None", "None"]


def test_the_installed_profiles_command_refuses_with_an_actionable_message(
    installed_package,
) -> None:
    """`profiles` from an installed distribution: the flag and the repository path."""
    result = _python(installed_package, "-m", "modeltree_updater", "profiles")
    output = result.stdout + result.stderr

    assert result.returncode == EXIT_USAGE, output
    assert "--profiles" in output
    assert "tools/updater/profiles" in output
    assert "not packaged" in output
    # The failure mode being replaced: the prefix path the old default produced.
    assert not re.search(r"python3\.\d+[/\\]profiles", output)
    assert "Traceback" not in output


# Both branches of `_long_tail_profile`: the default id, and one named explicitly.
LONG_TAIL_INVOCATIONS = (
    ("default id", ("--long-tail",)),
    ("named id", ("--long-tail", "--long-tail-profile", "long-tail-generic")),
)


@pytest.mark.parametrize(
    "long_tail_flags",
    [flags for _, flags in LONG_TAIL_INVOCATIONS],
    ids=[name for name, _ in LONG_TAIL_INVOCATIONS],
)
def test_an_installed_long_tail_run_refuses_with_an_actionable_message(
    installed_package, tmp_path, fixture_dir, long_tail_flags
) -> None:
    """`run --long-tail` installed: refused for the reviewed set, not the fixtures.

    `--fixtures` is supplied so the run gets past #139's failure and reaches the
    one under test. Both ways of asking for a generic profile are covered because
    they take different branches to the same reviewed set, and only one of them
    would have been exercised by testing the default alone.
    """
    output_dir = tmp_path / "proposals"
    result = _python(
        installed_package,
        "-m",
        "modeltree_updater",
        "run",
        "--creator",
        "contoso-ai",
        "--fixtures",
        str(fixture_dir),
        *long_tail_flags,
        "--output",
        str(output_dir),
        "--run-id",
        "run-147-1",
    )
    output = result.stdout + result.stderr

    assert result.returncode == EXIT_USAGE, output
    assert "--long-tail" in output
    assert "tools/updater/profiles/generic" in output
    assert "not packaged" in output
    assert not re.search(r"python3\.\d+[/\\]profiles", output)
    assert "Traceback" not in output
    assert not output_dir.exists(), "a refused run writes nothing"


def test_the_installed_profiles_command_runs_when_given_the_checkout_profiles(
    installed_package,
) -> None:
    """The other half of failing closed: pointing it at the repository works."""
    result = _python(
        installed_package,
        "-m",
        "modeltree_updater",
        "profiles",
        "--profiles",
        str(PROJECT_DIR / "profiles"),
    )
    output = result.stdout + result.stderr

    assert result.returncode == EXIT_OK, output
    assert "openai" in output


def test_a_pth_based_editable_install_still_resolves_the_checkout(tmp_path) -> None:
    """The case a stricter check would have broken, and #139's review called out.

    An editable install puts a `.pth` naming this repository's `src` on the path,
    so the imported module file *is* the working tree's own and the layout check
    passes for the honest reason — not because "editable" was recognised. Run
    with `-S` and an explicit `site.addsitedir`, so the `.pth` is processed and
    nothing else on the path can answer instead: whichever copy CI has installed,
    this asserts about the one the `.pth` points at.
    """
    site_dir = tmp_path / "site-packages"
    site_dir.mkdir()
    # The name and the content hatchling actually writes for `pip install -e .`:
    # one line naming this project's `src`, no import hook.
    (site_dir / "_editable_impl_modeltree_updater.pth").write_text(
        f"{PROJECT_DIR / 'src'}\n", encoding="utf-8"
    )
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    result = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            "import json, site; "
            f"site.addsitedir({str(site_dir)!r}); "
            "from modeltree_updater import longtail, profiles; "
            "print(json.dumps([profiles.__file__, "
            "str(profiles.DEFAULT_PROFILES_DIR), "
            "str(longtail.REVIEWED_LONG_TAIL_DIR)]))",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    module_file, profiles_dir, long_tail_dir = json.loads(result.stdout)
    assert Path(module_file) == PACKAGE_DIR / "profiles.py"
    assert Path(profiles_dir) == PROJECT_DIR / "profiles"
    assert Path(long_tail_dir) == PROJECT_DIR / "profiles" / "generic"


def test_every_refusal_is_printable_wherever_the_updater_runs() -> None:
    """A hint that cannot be encoded is not a hint.

    These strings are written to stdout by a console entry point, which on a
    Windows console encodes to the active code page rather than UTF-8, so a
    stray dash could turn an actionable refusal into a UnicodeEncodeError with
    the path still unsaid. `FIXTURES_ARE_TEST_DATA` was already ASCII; it is
    included so the shape being matched is the thing asserted.
    """
    hints = {
        "FIXTURES_ARE_TEST_DATA": cli.FIXTURES_ARE_TEST_DATA,
        "PROFILES_ARE_REPOSITORY_DATA": profiles.PROFILES_ARE_REPOSITORY_DATA,
        "LONG_TAIL_PROFILES_ARE_REPOSITORY_DATA": (
            longtail.LONG_TAIL_PROFILES_ARE_REPOSITORY_DATA
        ),
    }

    for name, hint in hints.items():
        assert hint.isascii(), f"{name} is not printable on every console"
        assert "hint: " in hint, name


def test_the_distribution_ships_the_package_and_nothing_else() -> None:
    """The other half of the decision: turning packaging on has to be deliberate.

    Asserted as the whole configuration rather than as a list of forbidden keys.
    An earlier version named `force-include`, `artifacts` and `shared-data` and
    called them "the three ways", which was wrong twice over: the list was not
    complete, and `artifacts` does not do what it claimed.

    Measured by building real wheels under each configuration and counting the
    fixture files that came out. Twelve exist on disk, and with `packages` set
    as it is below:

        only-include                          12
        force-include                         12
        shared-data                           12
        packages widened to add "fixtures"    12
        include                                0
        artifacts                              0

    `only-include` ships them from the wheel target and from `[tool.hatch.build]`
    alike. `packages` acts as `only-include` plus `sources`, so while it is set
    `include` and `artifacts` only select from what `packages` already narrowed
    and cannot widen it. Drop `packages`, keep `include = ["fixtures"]`, and the
    wheel carries 12 fixture files and no package at all — the control that
    separates "not a vector in this configuration" from "the build was broken".

    So the vectors are `only-include`, `force-include`, `shared-data` and the
    value of `packages` itself. That last one is why this asserts equality over
    the whole table rather than checking which keys are present: widening a key
    that is already permitted adds no key to notice.
    """
    config = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    hatch = config["tool"]["hatch"]

    assert set(hatch) == {"build"}, f"unreviewed hatch configuration: {sorted(hatch)}"
    assert set(hatch["build"]) == {"targets"}, (
        "keys directly under [tool.hatch.build] apply to every target, so an "
        f"include rule here reaches the wheel: {sorted(hatch['build'])}"
    )
    assert set(hatch["build"]["targets"]) == {"wheel"}
    assert hatch["build"]["targets"]["wheel"] == {"packages": ["src/modeltree_updater"]}


def test_the_fixtures_are_not_inside_the_package() -> None:
    """A fixtures directory under `src/` would be packaged by `packages =`."""
    assert not (PACKAGE_DIR / "fixtures").exists()


def test_the_reviewed_profiles_are_not_inside_the_package() -> None:
    """Nor a profiles directory, for the same reason and by the same mechanism.

    `packages = ["src/modeltree_updater"]` ships everything under that directory,
    so moving the reviewed sets inside the package is the one way to package them
    that the table assertion above cannot see. Both reviewed sets are checked:
    the dedicated creator profiles and the generic long-tail ones (#147).
    """
    assert not (PACKAGE_DIR / "profiles").exists()
    assert (PROJECT_DIR / "profiles" / "generic").is_dir()


def test_the_packaged_version_pins_the_checkpoint_marker_to_pyproject() -> None:
    """`TOOL_VERSION` is `__version__` is `pyproject.toml`'s version — all one number.

    `TOOL_VERSION` is the identity a checkpoint marker records (#140), and the
    `resume` gate keys on marker equality (ADR 0002). If the build that stamps a
    checkpoint drifts *behind* the packaged version, the marker compares equal to
    a genuinely different build and an incompatible checkpoint is accepted — the
    exact failure #140 exists to catch, defeated by forgetting to bump one of two
    hand-maintained copies of the same fact (#191).

    `checkpoints.TOOL_VERSION` already derives from `modeltree_updater.__version__`,
    so in code there is one source between those two. The remaining drift is
    between that literal and `pyproject.toml`'s `[project].version`, which nothing
    otherwise checks. This closes it with a test rather than by deriving
    `__version__` from `importlib.metadata.version` at runtime (the other candidate
    fix): `__version__` is set at module import, and this package is run both
    installed and from a bare source checkout — `test_installed_layout.py` exists
    because that distinction is delicate. In a source tree with no installed
    distribution, `importlib.metadata.version("modeltree-updater")` raises
    `PackageNotFoundError`, which at module scope would break `import
    modeltree_updater` entirely. A metadata lookup would therefore trade a
    forgotten bump for an import that fails wherever the package is not installed,
    so the literal stays and this test guards it. Asserted over the whole chain,
    not just the manifest-versus-`__version__` pair, so that breaking the
    `TOOL_VERSION = __version__` line is caught here too.
    """
    manifest_version = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"][
        "version"
    ]

    assert modeltree_updater.__version__ == manifest_version, (
        f"__init__.py declares {modeltree_updater.__version__!r} but "
        f"pyproject.toml declares {manifest_version!r}; bump both together"
    )
    assert TOOL_VERSION == manifest_version, (
        f"checkpoints.TOOL_VERSION is {TOOL_VERSION!r}, which no longer tracks "
        f"the packaged version {manifest_version!r}; the checkpoint marker would "
        "record a build identity that is not this build's"
    )


# --- The intersection of #94 (profile identity in checkpoints) and #147 (install-
# layout resolution): a `resume` under an installed layout whose checkpoint records a
# long-tail profile id. It is correct today — the reviewed set cannot be loaded from
# an installed distribution, so `reviewed_long_tail_profile` raises `FileNotFoundError`,
# which is NOT `runner.py`'s `ProfileError` and so propagates past that catch to the
# CLI, which maps it to exit 2 and refuses. Nothing pinned that the propagation stays
# a broken-installation refusal rather than being reshaped into a profile disagreement.

_RECORDED_PROVIDERS = {"sources": "fixtures", "extractor": "fixtures"}


class _StubProviders:
    """Just enough of ``ProviderBundle`` for the resume gate to compare descriptors."""

    @property
    def descriptor(self) -> dict[str, str]:
        return dict(_RECORDED_PROVIDERS)


class _RecordedData:
    """One checkpointed message's payload, carrying the marks the resume gate reads."""

    def __init__(self, profile_id: str) -> None:
        self.providers = dict(_RECORDED_PROVIDERS)
        self.profile_id = profile_id
        self.tool_version = TOOL_VERSION
        self.checkpoint_schema_version = 1


class _Envelope:
    def __init__(self, data: _RecordedData) -> None:
        self.data = data


class _FakeCheckpoint:
    def __init__(self, profile_id: str) -> None:
        self.messages = {"discover-sources": [_Envelope(_RecordedData(profile_id))]}


class _FakeStorage:
    """A storage whose one checkpoint records a long-tail id, providers, and version.

    Built by hand rather than by running a real long-tail run, because the fact under
    test is the *resolution* of the recorded id under an installed layout, not the
    run that recorded it — and the full long-tail run machinery lives in
    `test_long_tail.py`. The version marker matches this build so the resume gets past
    the version and provider checks and reaches the profile step, which is the step
    the installed layout breaks.
    """

    def __init__(self, profile_id: str) -> None:
        self._checkpoint = _FakeCheckpoint(profile_id)

    def load(self, checkpoint_id: str):  # noqa: ARG002 - one checkpoint, id ignored
        return self._checkpoint


def test_a_resume_under_an_installed_layout_refuses_a_recorded_long_tail_id(
    monkeypatch,
) -> None:
    """Installed + a checkpointed long-tail id: refuse loudly, do not fall back.

    #198 acceptance 3. An installed distribution has no reviewed long-tail set
    (`REVIEWED_LONG_TAIL_DIR is None`), so rebuilding the recorded profile from the
    id raises `FileNotFoundError` — a broken installation, not a disagreement about
    which profile applies. That error is deliberately *not* a `ProfileError`, so it
    is not caught by `resume_creator_run`'s `except ProfileError` and reshaped into a
    `ProfileMismatch`; it propagates, and the CLI maps it to exit 2. The alternative —
    resolving to an empty library and running under it — is the silent fallback this
    refuses.

    The installed layout is reproduced by binding the reviewed directory to ``None``,
    which is exactly what the module-level default `REVIEWED_LONG_TAIL_DIR` is when the
    package is imported from a wheel (there is no repository above it to find). The
    real loader runs and raises the real message.

    This is pinned against a widening of the catch by driving the real
    ``runner.resume_creator_run``; the companion demonstration below,
    ``test_demonstration_widening_the_resume_catch_would_swallow_the_installed_layout_refusal``,
    renders the wrong outcome in-process to show what this guard protects against,
    but it is that demonstration and not itself a guard.
    """
    import asyncio

    from modeltree_updater import runner
    from modeltree_updater.longtail import reviewed_long_tail_profile

    # The installed layout: no reviewed set to find. Bind the directory the real
    # loader consults to None, the value a wheel import produces, and let it raise.
    monkeypatch.setattr(
        runner,
        "reviewed_long_tail_profile",
        functools.partial(reviewed_long_tail_profile, directory=None),
    )

    settings = RunSettings(
        _StubProviders(),
        budget=_ZERO_BUDGET,
        timestamp="2026-01-01T00:00:00Z",
    )
    storage = _FakeStorage(profile_id="long-tail-generic")

    with pytest.raises(FileNotFoundError) as raised:
        asyncio.run(
            runner.resume_creator_run(
                settings,
                checkpoint_id="any",
                checkpoint_storage=storage,
            )
        )

    message = str(raised.value)
    assert "installed distribution" in message
    assert "long-tail" in message
    # Not reshaped into a profile disagreement: the diagnosis stays "broken install".
    assert "not in the reviewed set" not in message


def test_demonstration_widening_the_resume_catch_would_swallow_the_installed_layout_refusal(
    monkeypatch,
) -> None:
    """An in-process demonstration of the failure mode, NOT a guard.

    This does not exercise ``runner.py``: it monkeypatches ``reviewed_long_tail_profile``
    with a locally widened rebuild step and shows that catching ``FileNotFoundError``
    there reshapes the installed-layout refusal — a broken installation — into a
    ``ProfileMismatch`` that reads "not in the reviewed set". It passes for the widened
    stand-in it installs, not for anything in the production catch, so it would stay
    green even if the real narrow catch were widened.

    The actual guard against that regression is
    ``test_a_resume_under_an_installed_layout_refuses_a_recorded_long_tail_id`` above,
    which drives the real ``runner.resume_creator_run`` and fails if the production
    catch is widened. This test is kept only for its explanatory value: it renders the
    wrong outcome concretely, so a reader can see what the guard above is protecting
    against. If the guard above is ever deleted, deleting this one too is correct —
    it does not cover the behaviour on its own.
    """
    import asyncio

    from modeltree_updater import runner
    from modeltree_updater.longtail import reviewed_long_tail_profile
    from modeltree_updater.profiles import ProfileError
    from modeltree_updater.workflow import ProfileMismatch

    def _widened_rebuild(profile_id: str):
        # The narrow catch reshapes only ProfileError; the widened one would also
        # reshape FileNotFoundError. Reproduce the widened behaviour to show its cost.
        try:
            return reviewed_long_tail_profile(profile_id, directory=None)
        except (ProfileError, FileNotFoundError) as error:
            raise ProfileMismatch(
                profile_id,
                None,
                reason=(
                    f"this checkpoint was produced under profile {profile_id!r}, "
                    f"which is not in the reviewed set ({error})"
                ),
            ) from error

    monkeypatch.setattr(runner, "reviewed_long_tail_profile", _widened_rebuild)

    settings = RunSettings(
        _StubProviders(),
        budget=_ZERO_BUDGET,
        timestamp="2026-01-01T00:00:00Z",
    )
    storage = _FakeStorage(profile_id="long-tail-generic")

    with pytest.raises(ProfileMismatch) as raised:
        asyncio.run(
            runner.resume_creator_run(
                settings,
                checkpoint_id="any",
                checkpoint_storage=storage,
            )
        )

    # The widening loses the broken-installation diagnosis — the regression pinned above.
    assert "not in the reviewed set" in str(raised.value)
