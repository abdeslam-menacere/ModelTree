"""Proposal-only guardrails.

This tool proposes; it never publishes. There is deliberately no code path that
writes ModelTree JSON, creates a branch, or opens a pull request — and the output
guard below refuses to write anywhere near the dataset even if asked to.
"""

from __future__ import annotations

from pathlib import Path

__all__ = [
    "PROTECTED_RELATIVE_PATHS",
    "REPOSITORY_MARKERS",
    "ProposalOnlyViolation",
    "assert_proposal_output_path",
    "find_repository_root",
    "find_repository_roots",
]

PROTECTED_RELATIVE_PATHS: tuple[str, ...] = ("web",)

# What marks a checkout root, ordered by how little of a checkout has to exist for
# the marker to be there. `.git` comes first because it is the only one present in
# *every* state of one — sparse, partial, shallow, mid-clone, or a linked worktree
# where it is a file rather than a directory. The others widen detection to trees
# that have no `.git`: a vendored copy, or an export that kept the source layout.
# Read this as "any of these", never "all of these". A marker that is absent can
# only ever cost detection, so extra independent markers are strictly safer, and a
# marker that matches a tree which is not ModelTree costs only a loud refusal to
# write into that tree's `web/` — never a silent write into a real one.
REPOSITORY_MARKERS: tuple[tuple[str, ...], ...] = (
    (".git",),
    ("drydock.config.json",),
    ("tools", "updater", "pyproject.toml"),
    ("web", "src", "data"),
)


class ProposalOnlyViolation(RuntimeError):
    """Raised when this tool refuses to write where it was asked to.

    The rule is an exclusion, not a containment. Nothing confines this tool to a
    proposal area it has to stay inside: `assert_proposal_output_path` refuses
    `PROTECTED_RELATIVE_PATHS` — `web/` — in every enclosing checkout, and leaves
    the rest writable by design, `.github/`, `docs/`, `tools/`, and the checkout
    root included, because proposals and checkpoints have to land somewhere.

    The CLI raises this same type for a second, narrower refusal: an id whose
    shape could steer a write out of the chosen output directory. That one is
    about a name, not about a protected region, and it does not widen the rule
    above.
    """


def find_repository_roots(start: Path | None = None) -> tuple[Path, ...]:
    """Every checkout enclosing `start`, nearest first.

    Detection is never keyed on the directory this module protects. Testing for
    `web/src/data` made the boundary disappear in exactly the checkouts that still
    needed it: a sparse checkout or partial clone that has not materialised
    `web/`, a worktree inspected before checkout finished, or any future move of
    `src/data`. The markers are read as "any of these" and every one but the
    trailing legacy entry sits outside `web/`, so an absent dataset directory no
    longer reads as "not a checkout".

    All of them are returned rather than just the nearest, because stopping at
    the nearest would let a repository nested *inside* `web/` — a scratch clone,
    a linked worktree — become the root and take the enclosing checkout's `web/`
    out of scope. A boundary that a subdirectory can shrink is not a boundary.
    """
    current = (start or Path.cwd()).resolve()
    return tuple(
        candidate
        for candidate in (current, *current.parents)
        if any(candidate.joinpath(*marker).exists() for marker in REPOSITORY_MARKERS)
    )


def find_repository_root(start: Path | None = None) -> Path | None:
    """Locate the ModelTree checkout containing `start`, if there is one.

    The nearest enclosing checkout, or `None`. `find_repository_roots` is what the
    guard uses; this is the single-answer form for callers that want to know where
    they are rather than what they must not touch.
    """
    roots = find_repository_roots(start)
    return roots[0] if roots else None


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

    An unlocatable root returns the path unchecked, and that is a decision rather
    than an oversight. With `.git` among the markers, "no root" means the target
    sits inside no checkout at all, so there is no reviewed repository data there
    for this guard to stand in front of; refusing would break `--output
    ~/proposals`, which is the ordinary way to run this tool, and the only way
    back would be an opt-out flag this module must never grow.

    The residual it leaves is narrower than "a tree holding a copy of `web/`"
    suggests, because `web/src/data` is itself one of the markers: a faithful
    copy brings it along and the tree is detected one directory up, and an
    export that kept the source layout carries three of the four even with no
    `.git`. What is left is a tree with none of the four whose `web/` belongs
    to an unrelated project, or is a partial copy of this repository's that did
    not bring `src/data` — an assets-only extract, or a copy of the build
    output. Such a tree is not recognised as a checkout, so its `web/` is not
    protected.
    """
    resolved = Path(path).expanduser().resolve()
    # Search from the requested path itself: a directory that does not exist yet
    # still sits inside a checkout, and falling back to the process's working
    # directory would look for the boundary in the wrong repository.
    roots = (repo_root,) if repo_root is not None else find_repository_roots(resolved)

    for root in roots:
        for relative in PROTECTED_RELATIVE_PATHS:
            protected = (root / relative).resolve()
            if _is_within(resolved, protected):
                raise ProposalOnlyViolation(
                    f"refusing to write proposals to {resolved}: {protected} holds reviewed "
                    "repository data, and this tool only produces proposals — choose an "
                    "output directory outside it"
                )
    return resolved
