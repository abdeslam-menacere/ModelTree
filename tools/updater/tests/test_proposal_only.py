"""The tool proposes and never publishes.

These tests are the executable form of the issue's hard constraint: no code path
writes ModelTree JSON, creates a branch, or opens a pull request.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from modeltree_updater.safety import (
    ProposalOnlyViolation,
    assert_proposal_output_path,
    find_repository_root,
)

PACKAGE_ROOT = Path(__file__).resolve().parent.parent / "src" / "modeltree_updater"

FORBIDDEN_PATTERNS = {
    "shells out": re.compile(r"\b(subprocess|os\.system|os\.popen|pty\.spawn)\b"),
    "drives git": re.compile(r"""["'`]\s*git\s+(commit|push|checkout|branch|merge)"""),
    "imports a git library": re.compile(r"^\s*(import|from)\s+(git|pygit2|dulwich)\b", re.M),
    "calls the GitHub API": re.compile(r"api\.github\.com|/pulls\b|gh\s+pr\s+create"),
}


def _sources() -> list[Path]:
    return sorted(PACKAGE_ROOT.rglob("*.py"))


@pytest.mark.parametrize("description,pattern", sorted(FORBIDDEN_PATTERNS.items()))
def test_no_source_file_can_publish(description: str, pattern: re.Pattern[str]) -> None:
    offenders = [
        path.name
        for path in _sources()
        if pattern.search(path.read_text(encoding="utf-8"))
    ]

    assert offenders == [], f"{description}: {offenders}"


def test_the_package_never_opens_a_dataset_file_for_writing() -> None:
    offenders = []
    for path in _sources():
        text = path.read_text(encoding="utf-8")
        if "src/data" in text or "src\\\\data" in text:
            # Referring to the dataset in prose is fine; writing to it is not.
            if "write_text" in text or "open(" in text:
                offenders.append(path.name)

    assert offenders == []


def test_writing_proposals_into_the_web_app_is_refused(tmp_path) -> None:
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)

    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "web" / "src" / "data", repo_root=repo_root)
    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "web" / "public" / "proposals", repo_root=repo_root)


def test_writing_proposals_outside_the_web_app_is_allowed(tmp_path) -> None:
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)

    resolved = assert_proposal_output_path(repo_root / "out" / "proposals", repo_root=repo_root)

    assert resolved == (repo_root / "out" / "proposals").resolve()


def test_repository_root_detection_finds_the_dataset(tmp_path) -> None:
    repo_root = tmp_path / "repo"
    nested = repo_root / "tools" / "updater"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)
    nested.mkdir(parents=True)

    assert find_repository_root(nested) == repo_root.resolve()
    assert find_repository_root(tmp_path) is None
