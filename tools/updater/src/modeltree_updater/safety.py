"""Proposal-only guardrails.

This tool proposes; it never publishes. There is deliberately no code path that
writes ModelTree JSON, creates a branch, or opens a pull request — and the output
guard below refuses to write anywhere near the dataset even if asked to.
"""

from __future__ import annotations

from pathlib import Path

__all__ = [
    "PROTECTED_RELATIVE_PATHS",
    "ProposalOnlyViolation",
    "assert_proposal_output_path",
    "find_repository_root",
]

PROTECTED_RELATIVE_PATHS: tuple[str, ...] = ("web",)


class ProposalOnlyViolation(RuntimeError):
    """Raised when an operation would leave the proposal-only boundary."""


def find_repository_root(start: Path | None = None) -> Path | None:
    """Locate the ModelTree checkout containing `start`, if there is one."""
    current = (start or Path.cwd()).resolve()
    for candidate in (current, *current.parents):
        if (candidate / "web" / "src" / "data").is_dir():
            return candidate
    return None


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def assert_proposal_output_path(path: Path | str, *, repo_root: Path | None = None) -> Path:
    """Return the resolved output path, refusing anything inside the web app.

    Proposals are review artefacts. Writing them into `web/` would blur the line
    between a suggestion and a reviewed repository change.
    """
    resolved = Path(path).expanduser().resolve()
    # Search from the requested path itself: a directory that does not exist yet
    # still sits inside a checkout, and falling back to the process's working
    # directory would look for the boundary in the wrong repository.
    root = repo_root or find_repository_root(resolved)
    if root is None:
        return resolved

    for relative in PROTECTED_RELATIVE_PATHS:
        protected = (root / relative).resolve()
        if _is_within(resolved, protected):
            raise ProposalOnlyViolation(
                f"refusing to write proposals to {resolved}: {protected} holds reviewed "
                "repository data, and this tool only produces proposals"
            )
    return resolved
