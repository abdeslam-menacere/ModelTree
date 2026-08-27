"""Why a configuration guard may not decide for itself whether to run.

#357. Three modules in this suite -- `test_publication_workflow.py`,
`test_adr_numbers.py` and `test_instruction_references.py` -- assert properties
of files under `.github/workflows/`: that the publication workflow holds no
write scope, and that the path filters deciding whether the ADR-numbering and
instruction-reference guards run at all still name the paths they must. Those
assertions read parsed YAML, so they need PyYAML.

All four sites used to spell that need as
`pytest.importorskip("yaml", reason="PyYAML is part of the dev extra")`. Without
PyYAML the suite then reported `1044 passed, 10 skipped, 3 deselected` and
exited 0 -- green, with eight guards not run and the whole of
`test_publication_workflow.py` dropped at collection, which is the stronger case
because a module that never collected contributes no skip anyone would read as
missing. A guard whose purpose is to catch CI quietly not checking something is
worth nothing if it can itself quietly not run.

The issue named two ways out and asked for the choice to be recorded rather than
guessed.

*Hard-require PyYAML* -- chosen. `yaml` appears nowhere under `src/`, so it is
test-only and stays declared in the `dev` extra of `pyproject.toml`, where it
already was, rather than moving to `[project].dependencies` where it would ship
in a wheel that never imports it. Nothing new is asked of contributors:
`pip install -e ".[dev]"` (README) and `pip install '.[dev]'`
(`.github/workflows/updater-tests.yml`) already install it, so the only
environment newly refused is one the project never claimed to support. The
guards now `import yaml` at module level, making its absence a collection error
-- the loudest available signal, and one no summary line can round to a pass.

*Refuse a run in which a config guard skipped* -- not chosen. It needs a marker
or naming convention to say which tests are config guards, which is a second
thing that can silently go wrong, and it leaves the dependency's real status
unstated. It is also more machinery for a weaker result: it would report the
skip, where hard-requiring removes the ability to skip at all.

Every test below carries its own positive control, because a detector that found
nothing and a detector that could not have found anything print the same result.
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = TESTS_DIR.parent

# The modules whose assertions read a parsed workflow file. Derived below rather
# than trusted: `test_the_set_of_workflow_config_guards_is_the_expected_three`
# recomputes it from the sources and fails if a fourth appears.
EXPECTED_GUARD_MODULES = {
    "test_adr_numbers.py",
    "test_instruction_references.py",
    "test_publication_workflow.py",
}

# A source file that still carries the defect, used as the positive control for
# every detector here. Kept as text rather than a fixture on disk so that no
# collected module can accidentally satisfy the check it is meant to prove.
DEFECTIVE_SOURCE = '''
import pytest

yaml = pytest.importorskip("yaml", reason="PyYAML is part of the dev extra")


def test_something():
    assert yaml.safe_load("a: 1") == {"a": 1}
'''

# The same file written the way the fix requires.
FIXED_SOURCE = '''
import pytest
import yaml


def test_something():
    assert yaml.safe_load("a: 1") == {"a": 1}
'''

# A form that reads as an unconditional import to a careless scan but is not one:
# the name is bound whether or not the module exists, so the guard would run with
# `yaml` as `None` and fail on an attribute rather than on the workflow.
CONDITIONAL_SOURCE = '''
try:
    import yaml
except ImportError:
    yaml = None
'''

# Blocks PyYAML for a subprocess without touching the installed environment.
# `sitecustomize` is imported by `site` at interpreter start, so this is in place
# before pytest, its plugins or any conftest run.
YAML_BLOCKER = '''\
import sys
from importlib.abc import MetaPathFinder


class _BlockYaml(MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "yaml" or fullname.startswith("yaml."):
            raise ModuleNotFoundError("No module named 'yaml'", name=fullname)
        return None


sys.modules.pop("yaml", None)
sys.meta_path.insert(0, _BlockYaml())
'''


def _test_sources() -> dict[str, str]:
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(TESTS_DIR.glob("test_*.py"))
    }


def _importorskip_yaml_sites(source: str, filename: str) -> list[int]:
    """Line numbers of every `*.importorskip("yaml", ...)` call in `source`."""
    sites = []
    for node in ast.walk(ast.parse(source, filename)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
        if name != "importorskip":
            continue
        if node.args and isinstance(node.args[0], ast.Constant):
            if node.args[0].value == "yaml":
                sites.append(node.lineno)
    return sites


def _imports_yaml_unconditionally(source: str, filename: str) -> bool:
    """True only for a plain `import yaml` in the module's own top-level body.

    Walking the tree would accept the `try`/`except ImportError` form, which
    binds the name either way and so fails on an attribute access rather than on
    the workflow it was supposed to read. Only `tree.body` is unconditional.
    """
    for node in ast.parse(source, filename).body:
        if isinstance(node, ast.Import) and any(a.name == "yaml" for a in node.names):
            return True
    return False


def _parses_a_workflow(source: str) -> bool:
    return "yaml.safe_load" in source


def _run_guard_modules(tmp_path: Path, *, block_yaml: bool) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if block_yaml:
        blocker_dir = tmp_path / "noyaml"
        blocker_dir.mkdir(exist_ok=True)
        (blocker_dir / "sitecustomize.py").write_text(YAML_BLOCKER, encoding="utf-8")
        env["PYTHONPATH"] = os.pathsep.join(
            [str(blocker_dir), env.get("PYTHONPATH", "")]
        ).rstrip(os.pathsep)
    return subprocess.run(
        [
            sys.executable,
            "-B",
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            "--tb=line",
            *[str(TESTS_DIR / name) for name in sorted(EXPECTED_GUARD_MODULES)],
        ],
        cwd=str(PROJECT_DIR),
        env=env,
        capture_output=True,
        text=True,
    )


def _counts(output: str) -> dict[str, int]:
    return {
        word: int(number)
        for number, word in re.findall(
            r"(\d+) (passed|failed|skipped|error|errors|deselected)", output
        )
    }


# --- the detectors can detect ------------------------------------------------


def test_the_importorskip_detector_finds_the_defect_it_is_pointed_at():
    """Anchors the scan below. Without this, "no module uses the idiom" and "the
    scan cannot see the idiom" are the same green."""
    assert _importorskip_yaml_sites(DEFECTIVE_SOURCE, "<control>") == [4]
    assert _importorskip_yaml_sites(FIXED_SOURCE, "<control>") == []


def test_the_unconditional_import_detector_rejects_the_conditional_form():
    assert _imports_yaml_unconditionally(FIXED_SOURCE, "<control>") is True
    assert _imports_yaml_unconditionally(DEFECTIVE_SOURCE, "<control>") is False
    assert _imports_yaml_unconditionally(CONDITIONAL_SOURCE, "<control>") is False


def test_the_yaml_blocker_actually_blocks(tmp_path):
    """The subprocess evidence below is only worth something if the environment
    it builds genuinely lacks PyYAML. Proven both ways: the same interpreter
    imports `yaml` fine without the blocker."""
    blocker_dir = tmp_path / "noyaml"
    blocker_dir.mkdir()
    (blocker_dir / "sitecustomize.py").write_text(YAML_BLOCKER, encoding="utf-8")

    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    without = subprocess.run(
        [sys.executable, "-B", "-c", "import yaml"],
        env=env,
        capture_output=True,
        text=True,
    )
    env["PYTHONPATH"] = str(blocker_dir)
    with_blocker = subprocess.run(
        [sys.executable, "-B", "-c", "import yaml"],
        env=env,
        capture_output=True,
        text=True,
    )

    assert without.returncode == 0, without.stderr
    assert with_blocker.returncode != 0
    assert "No module named 'yaml'" in with_blocker.stderr


# --- the guards themselves ---------------------------------------------------


def test_the_set_of_workflow_config_guards_is_the_expected_three():
    """Recomputed from the sources, so a fourth guard module cannot be added
    without this list noticing. An empty derived set would satisfy every
    per-module assertion below, so it is refused here first."""
    derived = {
        name
        for name, source in _test_sources().items()
        # This module is excluded by name, not by accident: its control sources
        # quote the marker verbatim, so a text scan reads it as a guard while it
        # asserts nothing about any workflow.
        if name != Path(__file__).name and _parses_a_workflow(source)
    }

    assert derived, "no module parses a workflow: the scan found nothing to check"
    assert derived == EXPECTED_GUARD_MODULES


def test_no_test_module_makes_pyyaml_optional():
    """The idiom was identical in all four places, which made it a house style
    rather than one author's slip -- so this scans the whole suite, not the three
    modules known to have carried it."""
    sources = _test_sources()

    # Coverage control. The claim above is about every module, and a scan
    # narrowed to the three already-fixed guards satisfies the assertion below
    # just as readily. Recounting the directory here rather than reusing the
    # helper's own glob is what makes that narrowing visible.
    on_disk = {path.name for path in TESTS_DIR.glob("test_*.py")}
    assert sources.keys() == on_disk, "the scan must cover the suite, not a list"
    assert on_disk - EXPECTED_GUARD_MODULES, "no non-guard module was scanned"

    offenders = {
        name: sites
        for name, source in sources.items()
        if (sites := _importorskip_yaml_sites(source, name))
    }

    assert offenders == {}, (
        "a workflow-configuration guard that skips itself when PyYAML is absent "
        "reports green without having checked anything (#357); import yaml "
        "unconditionally instead -- see this module's docstring"
    )


@pytest.mark.parametrize("module_name", sorted(EXPECTED_GUARD_MODULES))
def test_every_workflow_config_guard_imports_yaml_unconditionally(module_name):
    source = (TESTS_DIR / module_name).read_text(encoding="utf-8")

    assert _imports_yaml_unconditionally(source, module_name), (
        f"{module_name} must `import yaml` at module level so that a missing "
        "PyYAML is a collection error rather than a silent skip (#357)"
    )


def test_a_run_without_pyyaml_cannot_be_green(tmp_path):
    """The acceptance criterion, demonstrated rather than argued.

    PyYAML is genuinely made unimportable and the three guard modules are run in
    a real subprocess. Before the fix this exited 0 with eight skips; it must now
    exit non-zero with none, because a skipped configuration guard is invisible
    in the line that decides whether a run passed.
    """
    result = _run_guard_modules(tmp_path, block_yaml=True)
    counts = _counts(result.stdout + result.stderr)
    tail = (result.stdout + result.stderr)[-2000:]

    assert result.returncode != 0, f"a PyYAML-less run stayed green:\n{tail}"
    assert counts.get("skipped", 0) == 0, f"a config guard skipped:\n{tail}"
    assert counts.get("passed", 0) == 0, f"a config guard ran anyway:\n{tail}"


def test_the_module_level_guard_fails_rather_than_vanishing(tmp_path):
    """#357's fourth criterion. `test_publication_workflow.py` held its
    `importorskip` at module level, so PyYAML's absence removed all fourteen of
    its tests from collection -- not one skip against fourteen assertions, but a
    file that was never there. Absence must now name that file."""
    result = _run_guard_modules(tmp_path, block_yaml=True)
    output = result.stdout + result.stderr

    assert "test_publication_workflow.py" in output
    assert "ModuleNotFoundError" in output or "No module named 'yaml'" in output
