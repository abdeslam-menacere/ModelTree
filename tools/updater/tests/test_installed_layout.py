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

import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from modeltree_updater import cli
from modeltree_updater.cli import EXIT_OK, EXIT_USAGE, main

PROJECT_DIR = Path(__file__).resolve().parents[1]
PACKAGE_DIR = PROJECT_DIR / "src" / "modeltree_updater"
PYPROJECT = PROJECT_DIR / "pyproject.toml"

# An installed distribution puts the package one level under site-packages, so
# the walk that used to produce the default lands on the Python prefix instead
# of on this repository. This is the literal shape from the failing run.
INSTALLED_CLI = Path("/opt/hostedtoolcache/Python/3.13.15/x64/lib/python3.13")
INSTALLED_CLI = INSTALLED_CLI / "site-packages" / "modeltree_updater" / "cli.py"


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
