"""The tool proposes and never publishes.

These tests are the executable form of the issue's hard constraint: no code path
writes ModelTree JSON, creates a branch, or opens a pull request.
"""

from __future__ import annotations

import ast
import json
import re
import tokenize
from io import StringIO
from pathlib import Path

import pytest

from modeltree_updater import cli
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
    "opens a pull request": re.compile(r"/pulls\b|gh\s+pr\s+create"),
    "writes repository content": re.compile(
        r"/contents/|/git/refs\b|/git/commits\b|/git/blobs\b|/git/trees\b"
        r"|/merges\b|/branches\b"
    ),
}

# Publication needs one place that knows the GitHub API exists. It does not need
# one in every module, so the rule is narrowed to a single allow-listed boundary
# rather than dropped. Everything above it depends on a protocol, not on HTTP.
GITHUB_API = re.compile(r"api\.github\.com")
ISSUES_BOUNDARY = "github_issues.py"

# Anything that puts bytes on disk: a write helper, or `open` in a writing mode.
WRITE_CALL = re.compile(r"\.write_text\(|\.write_bytes\(|\bopen\(\s*[^)]*['\"][wxa]")


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


def test_only_the_guarded_cli_writes_files() -> None:
    """One write site, and it is the one the output guard protects."""
    writers = sorted(
        path.name for path in _sources() if WRITE_CALL.search(path.read_text(encoding="utf-8"))
    )

    assert writers == ["cli.py"]


def test_only_the_issues_boundary_names_the_github_api() -> None:
    offenders = sorted(
        path.name
        for path in _sources()
        if GITHUB_API.search(path.read_text(encoding="utf-8"))
    )

    assert offenders == [ISSUES_BOUNDARY]


def test_the_issues_boundary_can_only_address_issues() -> None:
    """Every URL path this package can build, read straight out of the syntax tree."""
    tree = ast.parse((PACKAGE_ROOT / ISSUES_BOUNDARY).read_text(encoding="utf-8"))
    paths = {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node.value.startswith("/")
    }

    assert paths <= {"/", "/repos/", "/issues"}, paths


def test_every_written_path_passes_through_the_guard() -> None:
    """Parsed, not string-matched: each write target roots in a guarded name."""
    tree = ast.parse((PACKAGE_ROOT / "cli.py").read_text(encoding="utf-8"))
    guarded = _guard_result_names(tree)
    targets = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in {"write_text", "write_bytes", "open", "mkdir"}:
                targets.append(_root_name(node.func.value))

    assert targets, "expected the CLI to write proposals somewhere"
    assert guarded, "expected the CLI to derive paths from the output guard"
    for target in targets:
        assert target in guarded, f"write target {target!r} never passed the guard"


def _guard_result_names(tree: ast.Module) -> set[str]:
    """Names bound directly to the result of `assert_proposal_output_path(...)`."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        value = node.value
        if (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "assert_proposal_output_path"
        ):
            names.update(
                target.id for target in node.targets if isinstance(target, ast.Name)
            )
    return names


def _root_name(node: ast.expr) -> str:
    """The identifier a path expression is built from, e.g. `directory / "x.json"`."""
    while isinstance(node, ast.BinOp):
        node = node.left
    return node.id if isinstance(node, ast.Name) else ast.dump(node)


def test_the_cli_refuses_to_write_into_a_checkout_dataset(tmp_path, fixture_dir) -> None:
    """End to end: asking for the dataset directory writes nothing and fails."""
    repo_root = tmp_path / "repo"
    dataset = repo_root / "web" / "src" / "data"
    dataset.mkdir(parents=True)
    stream = StringIO()

    exit_code = cli.main(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(dataset / "proposals"),
            "--timestamp",
            "2026-06-01T00:00:00+00:00",
        ],
        env={},
        stream=stream,
    )

    assert exit_code == cli.EXIT_USAGE
    assert "proposal-only guard" in stream.getvalue()
    assert list(dataset.rglob("*")) == []


def test_a_traversal_shaped_id_cannot_escape_the_output_directory(tmp_path, fixture_dir) -> None:
    stream = StringIO()

    exit_code = cli.main(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(tmp_path / "out"),
            "--run-id",
            "../escaped",
        ],
        env={},
        stream=stream,
    )

    assert exit_code == cli.EXIT_USAGE
    assert not (tmp_path / "escaped").exists()


def test_a_proposal_written_by_the_cli_stays_a_proposal(tmp_path, fixture_dir) -> None:
    stream = StringIO()

    exit_code = cli.main(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(tmp_path / "out"),
            "--run-id",
            "run-test",
        ],
        env={},
        stream=stream,
    )
    written = json.loads((tmp_path / "out" / "run-test" / "contoso-ai.json").read_text("utf-8"))

    assert exit_code == cli.EXIT_OK
    # A proposal, not dataset shapes: claims carry verdicts and evidence, and the
    # file is nowhere near `web/src/data`.
    assert {"status", "claims", "verdicts", "validations", "providers"} <= set(written)
    # The audit trail travels with it: gates, adjudications, and source approvals.
    assert {"gates", "adjudications", "source_approvals"} <= set(written)


def test_the_review_and_gate_modules_are_inside_the_proposal_only_scan() -> None:
    """New modules must not quietly sit outside the boundary the scan enforces."""
    scanned = {path.name for path in _sources()}

    assert {
        "gates.py",
        "review.py",
        "github_issues.py",
        "parsing.py",
        "publisher.py",
    } <= scanned


BYPASS_PATTERN = re.compile(r"skip[_-]gates|force[_-]gates|ignore[_-]gates|no[_-]gates")


def _code_only(path: Path) -> str:
    """Source with comments and string literals removed.

    Prose *about* the absence of a bypass ("there is no --force") must not read as
    a bypass, so only executable tokens are searched.
    """
    tokens = []
    with tokenize.open(path) as handle:
        for token in tokenize.generate_tokens(handle.readline):
            if token.type in {tokenize.COMMENT, tokenize.STRING}:
                continue
            tokens.append(token.string)
    return " ".join(tokens)


def test_nothing_offers_a_way_to_bypass_a_deterministic_gate() -> None:
    """A gate that can be waived is not a gate.

    If a bypass is ever genuinely needed it belongs in branch protection, where it
    is auditable, not in this tool.
    """
    offenders = [path.name for path in _sources() if BYPASS_PATTERN.search(_code_only(path))]

    assert offenders == []


def test_writing_proposals_into_the_web_app_is_refused(tmp_path) -> None:
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)

    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "web" / "src" / "data", repo_root=repo_root)
    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "web" / "public" / "proposals", repo_root=repo_root)


def test_a_directory_that_does_not_exist_yet_is_still_guarded(tmp_path) -> None:
    """The guard must not fall back to the working directory for a new path."""
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)

    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "web" / "nested" / "not" / "created" / "yet")


def test_this_checkouts_dataset_directory_is_refused() -> None:
    repo_root = find_repository_root(PACKAGE_ROOT)
    if repo_root is None:  # pragma: no cover - only when run outside a checkout
        pytest.skip("not running inside a ModelTree checkout")

    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "web" / "src" / "data")


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
