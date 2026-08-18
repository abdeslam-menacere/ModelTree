"""Test bootstrap: make `src` importable and share offline fixtures."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from modeltree_updater.budgets import CreatorBudget  # noqa: E402
from modeltree_updater.providers.fixtures import (  # noqa: E402
    build_fixture_bundle,
    load_fixture_library,
)
from modeltree_updater.workflow import RunSettings  # noqa: E402

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "creators"
# Later than every fixture's `verified_at`: the date gate refuses evidence that
# claims to have been checked after the run that read it.
TIMESTAMP = "2026-06-01T00:00:00+00:00"


@pytest.fixture()
def fixture_dir() -> Path:
    return FIXTURE_DIR


@pytest.fixture()
def library():
    return load_fixture_library(FIXTURE_DIR)


@pytest.fixture()
def settings_factory(library):
    def factory(budget: CreatorBudget | None = None) -> RunSettings:
        return RunSettings(
            build_fixture_bundle(library, timestamp=TIMESTAMP),
            budget=budget or CreatorBudget(),
            timestamp=TIMESTAMP,
        )

    return factory


@pytest.fixture()
def settings(settings_factory) -> RunSettings:
    return settings_factory()
