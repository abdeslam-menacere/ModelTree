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
    PROTECTED_RELATIVE_PATHS,
    REPOSITORY_MARKERS,
    ProposalOnlyViolation,
    assert_proposal_output_path,
    find_repository_root,
    find_repository_roots,
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

# Anything that puts bytes on disk or brings a path into existence: a write
# helper, a directory creation, or `open` in a writing mode. A coarse tripwire
# that does not depend on the syntax-tree rules further down being exhaustive.
WRITE_CALL = re.compile(
    r"\.write_text\(|\.write_bytes\(|\.touch\(|\.mkdir\(|\bmakedirs\("
    r"|\bopen\(\s*[^)]*['\"][wxa]"
)

# The only modules allowed to touch the filesystem at all: `cli.py` writes the
# proposal artefacts and `checkpoints.py` creates the checkpoint directory. Both
# go through the guard — the syntax-tree test below is what proves that, and this
# list is what notices a third module appearing.
FILESYSTEM_BOUNDARY = ["checkpoints.py", "cli.py"]


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


def test_only_allow_listed_modules_touch_the_filesystem() -> None:
    """Two call sites, and both are ones the output guard protects."""
    writers = sorted(
        path.name for path in _sources() if WRITE_CALL.search(path.read_text(encoding="utf-8"))
    )

    assert writers == FILESYSTEM_BOUNDARY


def test_only_the_issues_boundary_names_the_github_api() -> None:
    offenders = sorted(
        path.name
        for path in _sources()
        if GITHUB_API.search(path.read_text(encoding="utf-8"))
    )

    assert offenders == [ISSUES_BOUNDARY]


def test_the_issues_boundary_can_only_address_issues() -> None:
    """Every URL path this package can build, read straight out of the syntax tree.

    `/comments` is here because supersession continuity needs to file a record
    before it overwrites a body. It is still under `/issues`, and this pin is what
    stops the set from quietly growing past that.
    """
    tree = ast.parse((PACKAGE_ROOT / ISSUES_BOUNDARY).read_text(encoding="utf-8"))
    paths = {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node.value.startswith("/")
    }

    assert paths <= {"/", "/repos/", "/issues", "/comments"}, paths


def test_every_filesystem_call_in_the_package_passes_through_the_guard() -> None:
    """Parsed, not string-matched, and across every module rather than just the CLI.

    The property is stated positively: each path this package brings into
    existence roots in a name the output guard returned. That makes the rule an
    allowlist of *guarded call sites* rather than a denylist of forbidden
    functions, so a new module that writes fails by default and nothing has to be
    added here to keep the boundary honest.
    """
    offenders: list[str] = []
    touching: set[str] = set()

    for path in _sources():
        relative = path.relative_to(PACKAGE_ROOT).as_posix()
        calls, unguarded = _filesystem_calls(path.read_text(encoding="utf-8"))
        if calls:
            touching.add(relative)
        offenders.extend(f"{relative}:{report}" for report in unguarded)

    assert offenders == [], f"filesystem calls that never passed the guard: {offenders}"
    # Both sites are deliberate: the proposal writer and the checkpoint directory.
    # A third is a new place this tool can reach, and it should be argued for.
    assert sorted(touching) == FILESYSTEM_BOUNDARY


# --------------------------------------------------------------------------
# The filesystem detector
# --------------------------------------------------------------------------
# Only the *spellings* of "touches the filesystem" are enumerated here; whether a
# given call is acceptable is decided by the guard rule above, not by this list.

GUARD = "assert_proposal_output_path"

# Path methods that create, replace, or remove something on disk. `replace` and
# `copy` are deliberately absent: `str.replace` and `dict.copy` are pervasive in
# this package and indistinguishable from `Path.replace`/`shutil.copy` without
# type inference. The module-qualified rule below catches those spellings instead.
PATH_MUTATORS = frozenset(
    {
        "hardlink_to",
        "mkdir",
        "rename",
        "rmdir",
        "symlink_to",
        "touch",
        "unlink",
        "write_bytes",
        "write_text",
    }
)

# Module-qualified spellings of the same thing: `os.makedirs(p)`, `shutil.move(p)`.
# `tempfile` is in scope on purpose. Its functions take no path that could be
# guarded, so any use is reported: this tool has no reason to create temporary
# files, and if it ever does that is a decision for review, not a silent pass.
FILESYSTEM_MODULES = frozenset({"os", "shutil", "tempfile"})
FILESYSTEM_FUNCTIONS = frozenset(
    {
        "NamedTemporaryFile",
        "TemporaryDirectory",
        "TemporaryFile",
        "copy",
        "copy2",
        "copyfile",
        "copytree",
        "link",
        "make_archive",
        "makedirs",
        "mkdir",
        "mkdtemp",
        "mkstemp",
        "move",
        "open",
        "remove",
        "removedirs",
        "rename",
        "renames",
        "replace",
        "rmdir",
        "rmtree",
        "symlink",
        "unlink",
        "unpack_archive",
    }
)

# Reading creates nothing, and `.open()` is also how urllib opens a URL, so an
# `open` call only counts when it asks for a writing mode.
WRITING_MODE = re.compile(r"[wxa+]")


def _filesystem_calls(source: str) -> tuple[list[str], list[str]]:
    """Every filesystem call in one module, and those not acting on a guarded path."""
    tree = ast.parse(source)
    guarded = _guard_result_names(tree)
    calls: list[str] = []
    unguarded: list[str] = []

    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and _touches_the_filesystem(node)):
            continue
        target = _path_expression(node)
        report = f"{node.lineno}: {_call_name(node)} on {_root_name(target)}"
        calls.append(report)
        if not _is_guarded(target, guarded):
            unguarded.append(report)

    return calls, unguarded


def _touches_the_filesystem(node: ast.Call) -> bool:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id == "open" and _opens_for_writing(node)
    if not isinstance(func, ast.Attribute):
        return False
    if func.attr in PATH_MUTATORS:
        return True
    if func.attr in FILESYSTEM_FUNCTIONS and _root_name(func.value) in FILESYSTEM_MODULES:
        return True
    return func.attr == "open" and _opens_for_writing(node)


def _path_expression(node: ast.Call) -> ast.expr | None:
    """The expression naming the path the call would act on."""
    func = node.func
    if isinstance(func, ast.Name):  # open(path, "w")
        return node.args[0] if node.args else None
    if _root_name(func.value) in FILESYSTEM_MODULES:  # os.makedirs(path)
        return node.args[0] if node.args else None
    return func.value  # path.mkdir(), path.open("w")


def _opens_for_writing(node: ast.Call) -> bool:
    mode = _mode_argument(node)
    return mode is not None and bool(WRITING_MODE.search(mode))


def _mode_argument(node: ast.Call) -> str | None:
    candidates = [node.args[1]] if len(node.args) > 1 else []
    candidates += [keyword.value for keyword in node.keywords if keyword.arg == "mode"]
    for candidate in candidates:
        if isinstance(candidate, ast.Constant) and isinstance(candidate.value, str):
            return candidate.value
    return None


def _call_name(node: ast.Call) -> str:
    func = node.func
    return f"{func.id}()" if isinstance(func, ast.Name) else f".{func.attr}()"


def _is_guard_call(node: ast.expr | None) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == GUARD
    )


def _is_guarded(node: ast.expr | None, guarded: set[str]) -> bool:
    """A path expression roots in the guard: a guarded name, or the guard inline."""
    while isinstance(node, ast.BinOp):
        node = node.left
    if _is_guard_call(node):
        return True
    return isinstance(node, ast.Name) and node.id in guarded


def _guard_result_names(tree: ast.Module) -> set[str]:
    """Names bound directly to the result of `assert_proposal_output_path(...)`."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and _is_guard_call(node.value):
            names.update(
                target.id for target in node.targets if isinstance(target, ast.Name)
            )
        elif isinstance(node, ast.AnnAssign) and _is_guard_call(node.value):
            if isinstance(node.target, ast.Name):
                names.add(node.target.id)
        elif isinstance(node, ast.NamedExpr) and _is_guard_call(node.value):
            names.add(node.target.id)
    return names


def _root_name(node: ast.expr | None) -> str:
    """The identifier a path expression is built from, e.g. `directory / "x.json"`."""
    while isinstance(node, ast.BinOp):
        node = node.left
    if node is None:
        return "no path argument"
    return node.id if isinstance(node, ast.Name) else ast.dump(node)


# A detector nobody has seen fail is not evidence. These pin both directions:
# what must be reported, and what must not be mistaken for a filesystem call.
UNGUARDED_SOURCES = {
    "a bare mkdir": "Path('state').mkdir(parents=True)",
    "a mkdir on an unguarded name": "directory.mkdir(parents=True, exist_ok=True)",
    "os.makedirs": "import os\nos.makedirs(directory)",
    "a write-mode open": "handle = open(target, 'w')",
    "a write-mode Path.open": "handle = target.open(mode='wb')",
    "a touch": "target.touch()",
    "a write_text": "target.write_text('{}', encoding='utf-8')",
    "a temporary directory": "import tempfile\ntempfile.mkdtemp()",
    "a tree removal": "import shutil\nshutil.rmtree(directory)",
    "a rename": "target.rename(other)",
}

GUARDED_SOURCES = {
    "a guarded mkdir": (
        "directory = assert_proposal_output_path(requested)\n"
        "directory.mkdir(parents=True, exist_ok=True)"
    ),
    "a guarded write under a guarded directory": (
        "root = assert_proposal_output_path(requested)\n"
        "(root / 'report.json').write_text('{}', encoding='utf-8')"
    ),
    "the guard used inline": "assert_proposal_output_path(requested).mkdir()",
    "an annotated binding": (
        "directory: Path = assert_proposal_output_path(requested)\ndirectory.touch()"
    ),
}

NOT_FILESYSTEM_SOURCES = {
    "reading a file": "text = path.read_text(encoding='utf-8')",
    "opening a url": "with opener.open(request, timeout=timeout) as response:\n    pass",
    "a read-mode open": "handle = open(target)",
    "a string replace": "value = text.replace('a', 'b')",
    "a mapping copy": "other = mapping.copy()",
    "a dataclass replace": "updated = replace(settings, timestamp=timestamp)",
}


@pytest.mark.parametrize("description", sorted(UNGUARDED_SOURCES))
def test_the_detector_reports_an_unguarded_filesystem_call(description: str) -> None:
    _, unguarded = _filesystem_calls(UNGUARDED_SOURCES[description])

    assert unguarded, f"{description} was not reported"


@pytest.mark.parametrize("description", sorted(GUARDED_SOURCES))
def test_the_detector_accepts_a_guarded_filesystem_call(description: str) -> None:
    calls, unguarded = _filesystem_calls(GUARDED_SOURCES[description])

    assert calls, f"{description} was not detected as a filesystem call at all"
    assert unguarded == []


@pytest.mark.parametrize("description", sorted(NOT_FILESYSTEM_SOURCES))
def test_the_detector_leaves_non_filesystem_calls_alone(description: str) -> None:
    calls, _ = _filesystem_calls(NOT_FILESYSTEM_SOURCES[description])

    assert calls == [], f"{description} was mistaken for a filesystem call"


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


@pytest.mark.parametrize("command", ["run", "checkpoints", "resume"])
def test_no_command_can_checkpoint_into_a_checkout_dataset(
    tmp_path, fixture_dir, command
) -> None:
    """End to end: `--checkpoint-dir` is refused wherever it is accepted.

    Checkpoint state is not dataset JSON, but it is still this tool creating
    directories from a flag, and `web/` is off limits to both.
    """
    repo_root = tmp_path / "repo"
    dataset = repo_root / "web" / "src" / "data"
    dataset.mkdir(parents=True)
    arguments = {
        "run": ["run", "--creator", "contoso-ai", "--fixtures", str(fixture_dir)],
        "checkpoints": ["checkpoints"],
        "resume": ["resume", "--checkpoint-id", "any", "--fixtures", str(fixture_dir)],
    }[command]
    stream = StringIO()

    exit_code = cli.main(
        [*arguments, "--checkpoint-dir", str(dataset / "checkpoints")],
        env={},
        stream=stream,
    )

    assert exit_code == cli.EXIT_USAGE
    assert "proposal-only guard" in stream.getvalue()
    assert list(dataset.rglob("*")) == []


def test_a_traversal_shaped_checkpoint_directory_cannot_reach_the_web_app(
    tmp_path, fixture_dir
) -> None:
    """`..` in `--checkpoint-dir` gets the same treatment `--output` already gave it."""
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)
    (repo_root / "out").mkdir()
    stream = StringIO()

    exit_code = cli.main(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--checkpoint-dir",
            str(repo_root / "out" / ".." / "web" / "checkpoints"),
        ],
        env={},
        stream=stream,
    )

    assert exit_code == cli.EXIT_USAGE
    assert "proposal-only guard" in stream.getvalue()
    assert not (repo_root / "web" / "checkpoints").exists()


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


def test_every_module_including_subpackages_is_inside_the_proposal_only_scan() -> None:
    """New modules must not quietly sit outside the boundary the scan enforces.

    Relative paths, not bare names: a scan that stopped recursing would still find
    `base.py`, so the subpackage entries are what actually pin the recursion.
    """
    scanned = {path.relative_to(PACKAGE_ROOT).as_posix() for path in _sources()}

    assert {
        "checkpoints.py",
        "cli.py",
        "gates.py",
        "github_issues.py",
        "longtail.py",
        "parsing.py",
        "publisher.py",
        "review.py",
        "safety.py",
        "providers/base.py",
        "providers/fixtures.py",
        "providers/foundry.py",
        "providers/network.py",
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


# The shape of a checkout that has not materialised the dataset directory: a
# sparse checkout or partial clone, a worktree read before checkout finished, or
# a future move of `src/data`. Each marker is written on its own so a regression
# in any one of them is named by the failing parameter rather than hidden behind
# the others.
CHECKOUT_MARKERS = {
    ".git as a directory": (".git", None),
    ".git as a worktree file": (".git", "gitdir: ../.git/worktrees/dock\n"),
    "the drydock config": ("drydock.config.json", "{}\n"),
    "this tool's manifest": ("tools/updater/pyproject.toml", "[project]\n"),
}


def _sparse_checkout(root: Path, marker: str, contents: str | None) -> Path:
    """A checkout carrying one marker and a `web/` with no `web/src/data`."""
    (root / "web" / "src").mkdir(parents=True)
    target = root / marker
    if contents is None:
        target.mkdir(parents=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents, encoding="utf-8")
    return root


@pytest.mark.parametrize(
    "marker,contents", list(CHECKOUT_MARKERS.values()), ids=list(CHECKOUT_MARKERS)
)
def test_a_checkout_missing_its_dataset_still_refuses_the_web_app(
    tmp_path, marker, contents
) -> None:
    """The fail-open case from #102: no `web/src/data`, so no boundary at all.

    Detection used to test for the protected directory itself, so its absence
    read as "not in a checkout" and `web/` became writable — including the
    dataset directory the guard exists to keep out of this tool's reach.
    """
    repo_root = _sparse_checkout(tmp_path / "repo", marker, contents)

    for target in (
        repo_root / "web" / "src" / "data" / "releases.json",
        repo_root / "web" / "src" / "proposals",
        repo_root / "web" / "proposals",
    ):
        with pytest.raises(ProposalOnlyViolation):
            assert_proposal_output_path(target)

    assert not (repo_root / "web" / "src" / "data").exists()


@pytest.mark.parametrize(
    "marker,contents", list(CHECKOUT_MARKERS.values()), ids=list(CHECKOUT_MARKERS)
)
def test_every_marker_locates_the_root_without_the_protected_directory(
    tmp_path, marker, contents
) -> None:
    repo_root = _sparse_checkout(tmp_path / "repo", marker, contents)

    assert find_repository_root(repo_root / "web" / "src") == repo_root.resolve()


def test_root_detection_never_rests_on_the_directory_it_protects() -> None:
    """Every protected path must have a marker that does not live inside it."""
    outside = [
        marker for marker in REPOSITORY_MARKERS if marker[0] not in PROTECTED_RELATIVE_PATHS
    ]

    assert outside, "at least one marker must sit outside the protected tree"


def test_an_unlocatable_root_permits_the_write_deliberately(tmp_path) -> None:
    """The documented outcome for "no checkout here", pinned so it stays a choice.

    A bare directory carries no marker, so there is no reviewed repository data
    to protect and `--output` keeps working — which is the ordinary way to run
    this tool. This also pins the known residual: a stray `web/` in such a tree
    is not covered, because nothing identifies that tree as a ModelTree checkout.
    """
    (tmp_path / "web").mkdir()

    assert find_repository_root(tmp_path) is None
    assert assert_proposal_output_path(tmp_path / "proposals") == (tmp_path / "proposals").resolve()
    assert (
        assert_proposal_output_path(tmp_path / "web" / "proposals")
        == (tmp_path / "web" / "proposals").resolve()
    )


def test_the_refusal_says_how_to_proceed(tmp_path) -> None:
    """Refusing loudly is only useful if the message names the way out."""
    repo_root = _sparse_checkout(tmp_path / "repo", ".git", None)

    with pytest.raises(ProposalOnlyViolation) as refusal:
        assert_proposal_output_path(repo_root / "web" / "proposals")

    message = str(refusal.value)
    assert str((repo_root / "web").resolve()) in message
    assert "outside it" in message


def test_a_repository_nested_inside_the_web_app_cannot_shrink_the_boundary(tmp_path) -> None:
    """A subdirectory must not be able to redefine where the boundary is.

    Root detection walks upwards, so a scratch clone or linked worktree sitting
    under `web/` carries a marker of its own. If the search stopped at the nearest
    one it would become the root, and the enclosing checkout's `web/` — the thing
    actually being protected — would fall outside the guard.
    """
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)
    nested = repo_root / "web" / "scratch"
    (nested / ".git").mkdir(parents=True)

    assert find_repository_roots(nested)[0] == nested.resolve()
    assert repo_root.resolve() in find_repository_roots(nested)
    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(nested / "out" / "proposals")


def _linked_directory(link: Path, target: Path) -> None:
    """Materialise `link` as a directory link to `target`, or skip the test.

    POSIX makes one unconditionally. Windows needs administrator rights or
    Developer Mode for a directory symlink, and a junction — which needs
    neither — has no portable spelling, so the shape is simply unreachable on an
    unprivileged Windows box. The mechanism under test is the same either way:
    resolution follows the link and lands outside the checkout.
    """
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError) as unavailable:  # pragma: no cover
        pytest.skip(f"cannot create a directory link here: {unavailable}")


WEB_APP_SHAPES = ("a real directory", "a link to a target outside the checkout")


@pytest.mark.parametrize("shape", WEB_APP_SHAPES, ids=WEB_APP_SHAPES)
def test_the_web_app_is_refused_whether_or_not_it_is_a_link(tmp_path, shape) -> None:
    """The fail-open from #120, pinned against its control.

    Resolving the output path before searching upward for markers moved the
    search origin to the link target, which encloses none of them. No root was
    found, the deliberate fail-open for "no checkout here" applied, and the
    write was allowed — into reviewed data, because the link target is where
    `web/` actually lives. Both shapes are asserted together so the verdict can
    never come to depend on how `web/` was materialised.

    The allowed half is the control that keeps this from being satisfied by a
    blanket refusal. Putting a large `web/` on another volume behind a link is
    an ordinary layout, and refusing on link-shape alone would break it while
    still passing the refused half.
    """
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)
    if shape == "a real directory":
        (repo_root / "web" / "src" / "data").mkdir(parents=True)
    else:
        elsewhere = tmp_path / "elsewhere"
        (elsewhere / "src" / "data").mkdir(parents=True)
        _linked_directory(repo_root / "web", elsewhere)
        # The shape is real, not a fixture artefact: it genuinely redirects.
        assert (repo_root / "web").resolve() == elsewhere.resolve()

    for refused in (
        repo_root / "web" / "proposals",
        repo_root / "web" / "src" / "data",
        repo_root / "out" / ".." / "web" / "checkpoints",
    ):
        with pytest.raises(ProposalOnlyViolation):
            assert_proposal_output_path(refused)

    for allowed in (repo_root / "out", repo_root / "web-assets", tmp_path / "proposals"):
        assert assert_proposal_output_path(allowed) == allowed.resolve()


def test_a_traversal_shaped_output_path_still_cannot_reach_the_web_app(tmp_path) -> None:
    """The hole resolution exists to close, pinned because #120's fix could reopen it.

    Searching from the unresolved path instead of the resolved one would close
    the link case and open this one, which is not a fix but a swap: `..` has to
    be collapsed before the path reads as being inside `web/`. Both spellings
    are consulted, so neither direction can be traded away without a failure
    here.
    """
    repo_root = tmp_path / "repo"
    (repo_root / "web" / "src" / "data").mkdir(parents=True)
    (repo_root / "notweb").mkdir()

    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "notweb" / ".." / "web" / "out")


def test_a_link_target_addressed_directly_is_the_documented_residual(tmp_path) -> None:
    """The half of #120 documented rather than closed, verified rather than asserted.

    An output path aimed at the link's target instead of through the link passes
    through no checkout in either spelling, so no marker is found and the
    deliberate fail-open applies. Only searching the filesystem for links
    pointing at that target could connect the two, and this guard looks nowhere
    but at the path it was given. Pinned so `safety.py`'s docstring and
    `tools/updater/README.md` cannot outlive the behaviour they describe.
    """
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "src" / "data").mkdir(parents=True)
    _linked_directory(repo_root / "web", elsewhere)

    with pytest.raises(ProposalOnlyViolation):
        assert_proposal_output_path(repo_root / "web" / "proposals")

    assert find_repository_root(elsewhere) is None
    assert (
        assert_proposal_output_path(elsewhere / "proposals") == (elsewhere / "proposals").resolve()
    )


def test_the_cli_refuses_output_inside_a_checkout_missing_its_dataset(
    tmp_path, fixture_dir
) -> None:
    """End to end: the guard's new reach is the one `--output` actually gets."""
    repo_root = _sparse_checkout(tmp_path / "repo", ".git", None)
    stream = StringIO()

    exit_code = cli.main(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(repo_root / "web" / "src" / "data" / "proposals"),
        ],
        env={},
        stream=stream,
    )

    assert exit_code == cli.EXIT_USAGE
    assert "proposal-only guard" in stream.getvalue()
    assert not (repo_root / "web" / "src" / "data").exists()
