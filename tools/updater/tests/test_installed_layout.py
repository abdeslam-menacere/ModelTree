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
    monkeypatch, capsys
) -> None:
    """What the installed console entry point says when it has nothing to read."""
    monkeypatch.setattr(cli, "DEFAULT_FIXTURES", None)

    code = main(["creators"], env={})
    output = capsys.readouterr().out

    assert code == EXIT_USAGE
    assert "--fixtures" in output
    assert "tools/updater/fixtures/creators" in output
    assert "not packaged" in output
    assert "Traceback" not in output


def test_a_missing_fixtures_directory_is_more_than_a_bare_path(tmp_path, capsys) -> None:
    """The path is still named — it just is not the whole message any more."""
    missing = tmp_path / "not-here"

    code = main(["creators", "--fixtures", str(missing)], env={})
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
    installed_package,
) -> None:
    """End to end, as a subprocess: the failure in #139, now answered."""
    result = _python(installed_package, "-m", "modeltree_updater", "creators")
    output = result.stdout + result.stderr

    assert result.returncode == EXIT_USAGE, output
    assert "--fixtures" in output
    assert "tools/updater/fixtures/creators" in output
    assert "lib/python3.13/fixtures/creators" not in output
    assert "Traceback" not in output


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

    `force-include`, `artifacts` and `shared-data` are the three ways fixtures
    could re-enter the wheel. None of them is a bad idea by accident — but each
    would silently reverse the choice recorded in this file, so each fails here.
    """
    config = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    build = config["tool"]["hatch"]["build"]

    assert build["targets"]["wheel"]["packages"] == ["src/modeltree_updater"]
    for target in (build, *build["targets"].values()):
        for key in ("force-include", "artifacts", "shared-data"):
            assert key not in target, f"{key} would ship fixtures as distribution data"


def test_the_fixtures_are_not_inside_the_package() -> None:
    """A fixtures directory under `src/` would be packaged by `packages =`."""
    assert not (PACKAGE_DIR / "fixtures").exists()
