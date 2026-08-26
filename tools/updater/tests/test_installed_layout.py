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


def _climbs_from_file_root(module_source: str) -> list[str]:
    """Every expression in ``module_source`` that walks >=2 levels up from ``__file__``.

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

    We parse the module and, for every attribute/subscript chain rooted at
    ``Path(__file__)`` (optionally through ``.resolve()`` and optionally through a
    local variable that was itself bound to such a chain), we sum how many directory
    levels the chain climbs: each ``.parent`` is one level, ``.parents[k]`` for a
    constant ``k`` is ``k`` levels. A subscript whose index is *not* a provable
    non-negative constant — a negative literal, an arithmetic expression, a name — is
    the evasion this exists to stop, so it counts as "unknown, therefore suspect".

    Two levels is the boundary because it is the smallest climb that leaves the
    package: ``modeltree_updater/foo.py`` -> ``.parent`` is the package dir, a second
    ``.parent`` is ``src``/``site-packages`` and everything above is outside. One
    ``.parent`` (staying inside the package) is legitimate and stays quiet.

    Known limits, stated rather than papered over: this reasons about ``pathlib``
    chains written in the module's own text. It does not evaluate ``os.path.dirname``
    nesting, string ``"../.."`` joins, ``PurePath`` used under an alias it cannot see,
    or a climb assembled across a function-call boundary. It is a stronger net than
    the literal grep, not a proof of the negative. The list it returns is offenders,
    each rendered back to source for the failure message.
    """
    UNKNOWN = 10_000  # a climb we cannot bound is treated as "definitely too far"

    def _is_file_root(node: ast.AST) -> bool:
        # Path(__file__)  (optionally .resolve()) — the anchor every walk starts at.
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
            and isinstance(target.args[0], ast.Name)
            and target.args[0].id == "__file__"
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
            if rooted and levels >= 2:
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
}

# Walks that stay inside the package, or do not root at __file__ at all, which the
# guard must leave alone or it would flag every legitimate `.parent`.
GUARD_NON_OFFENDERS = {
    "single .parent stays in package": "Path(__file__).parent / 'data.json'",
    "parents[0] is the package dir": "Path(__file__).resolve().parents[0]",
    "not rooted at __file__": "other = Path('/etc'); root = other.parent.parent",
    "resolve does not climb": "Path(__file__).resolve() / 'data.json'",
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
    """
    offenders = sorted(
        path.relative_to(PACKAGE_DIR).as_posix()
        for path in PACKAGE_DIR.rglob("*.py")
        if path.name != "layout.py"
        and _climbs_from_file_root(path.read_text(encoding="utf-8"))
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

    This is pinned against a widening of the catch: see the companion test below,
    which shows that catching `FileNotFoundError` there turns this refusal into a
    `ProfileMismatch` and loses the "installed distribution" diagnosis.
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


def test_widening_the_resume_catch_would_swallow_the_installed_layout_refusal(
    monkeypatch,
) -> None:
    """Why the catch stays narrow: widening it converts the refusal into the wrong thing.

    Demonstrates the failure the test above pins against. `runner.py` catches
    `ProfileError` around the profile rebuild and re-raises it as `ProfileMismatch`.
    If that catch were widened to swallow `FileNotFoundError` too, the installed-layout
    refusal — a broken installation — would be reshaped into a `ProfileMismatch` that
    reads "not in the reviewed set", a disagreement about *which* profile applies. This
    reproduces that widening in-process and shows the diagnosis is lost, so a future
    author who widens the catch sees this go red.

    It does not modify `runner.py`; it stands in a widened rebuild step and confirms
    the shape of the wrong outcome, which is what the production catch must never do.
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
