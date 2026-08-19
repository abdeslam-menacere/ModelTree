"""Test bootstrap: make `src` importable and share offline fixtures."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Sequence

import pytest

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from modeltree_updater.budgets import CreatorBudget  # noqa: E402
from modeltree_updater.contracts import CreatorProposal, RunReport  # noqa: E402
from modeltree_updater.github_issues import Issue  # noqa: E402
from modeltree_updater.providers.fixtures import (  # noqa: E402
    build_fixture_bundle,
    load_fixture_library,
)
from modeltree_updater.runner import run_creator, run_creators  # noqa: E402
from modeltree_updater.workflow import RunSettings  # noqa: E402

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "creators"
# Later than every fixture's `verified_at`: the date gate refuses evidence that
# claims to have been checked after the run that read it.
TIMESTAMP = "2026-06-01T00:00:00+00:00"


@pytest.fixture()
def fixture_dir() -> Path:
    return FIXTURE_DIR


@pytest.fixture()
def timestamp() -> str:
    return TIMESTAMP


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


@pytest.fixture()
def proposal_factory(library, settings):
    """Real proposals from a real fixture run — not hand-built stand-ins.

    Publication is only worth testing against what the workflow actually produces,
    so these come out of `run_creator` exactly as `run --output` would write them.
    """

    def factory(creator_id: str, *, run_id: str = "run-test") -> CreatorProposal:
        return asyncio.run(
            run_creator(library.creators[creator_id], settings, run_id=run_id)
        )

    return factory


@pytest.fixture()
def report_factory(library, settings):
    def factory(*creator_ids: str, run_id: str = "run-test") -> RunReport:
        return asyncio.run(
            run_creators(
                [library.creators[creator_id] for creator_id in creator_ids],
                settings,
                run_id=run_id,
            )
        )

    return factory


class FakeIssuesClient:
    """An in-memory `IssuesClient`. Nothing leaves the process, and every call is
    recorded so a test can assert what was *not* done as well as what was."""

    def __init__(self, issues: Sequence[Issue] = ()) -> None:
        self.issues = list(issues)
        self.calls: list[tuple] = []
        self._next_number = max((issue.number for issue in self.issues), default=100) + 1

    def list_open_issues(self) -> Sequence[Issue]:
        self.calls.append(("list",))
        return tuple(issue for issue in self.issues if issue.state == "open")

    def create_issue(self, *, title: str, body: str) -> Issue:
        self.calls.append(("create", title))
        issue = Issue(number=self._next_number, title=title, body=body, state="open")
        self._next_number += 1
        self.issues.append(issue)
        return issue

    def update_issue(self, number: int, *, title: str, body: str) -> Issue:
        self.calls.append(("update", number))
        for index, issue in enumerate(self.issues):
            if issue.number == number:
                self.issues[index] = Issue(
                    number=number, title=title, body=body, state=issue.state
                )
                return self.issues[index]
        raise AssertionError(f"no issue #{number} to update")

    @property
    def actions(self) -> list[str]:
        return [call[0] for call in self.calls]


@pytest.fixture()
def fake_issues_client():
    def factory(issues: Sequence[Issue] = ()) -> FakeIssuesClient:
        return FakeIssuesClient(issues)

    return factory

