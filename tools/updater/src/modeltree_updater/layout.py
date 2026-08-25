"""Where this package's *repository* data is — when there is a repository at all.

Some of what the updater reads is deliberately not in the wheel: the creator
fixtures because they are synthetic test pages (#139), and the reviewed creator
and long-tail profiles because a packaged copy could drift from the reviewed set
in the repository (#147). Every default that points at one of those has to answer
the same question first — "am I running out of a checkout?" — and this module is
the single place that answers it.

It exists because the expression that used to answer it did not::

    Path(__file__).resolve().parents[2] / "fixtures"

That reads as a fact about the install layout and is only a guess. In a checkout
the package sits at ``tools/updater/src/modeltree_updater``, so the walk lands on
``tools/updater``; in an installed distribution the identical walk lands on
whatever encloses ``site-packages`` — ``…/lib/python3.13`` — which has nothing to
do with this repository. The publisher workflow installs the package, so it ran
the second reading every time, and had never once worked: it died naming
``/opt/hostedtoolcache/Python/3.13.15/x64/lib/python3.13/fixtures/creators``, a
path nobody had written.

Two things follow, and both are the point of putting the rule here rather than at
each call site. The layout is **checked**, so an installed distribution gets
``None`` instead of a path that exists nowhere. And it is checked **once**: #139
fixed the fixtures default alone, leaving the same guess at two other constants
to be found later, and three copies of a rule are three chances for it to drift
(#151 landed for exactly that reason). A caller holding ``None`` owes the reader
the flag to pass and the path in the repository to point it at — a bare prefix
path is the failure mode being replaced, not an acceptable substitute.
"""

from __future__ import annotations

from pathlib import Path

__all__ = ["source_checkout_dir"]


def source_checkout_dir(module_file: Path | str) -> Path | None:
    """``tools/updater`` when ``module_file`` is imported from a checkout, else ``None``.

    The test is the ``src`` directory of this project's src layout: the package
    directory's parent is named ``src`` in the working tree and is named
    ``site-packages`` (or a ``.zip``, or whatever a vendoring tool arranged) in an
    installed distribution. It is a check rather than an assumption, so an install
    prefix that happens to have a ``profiles`` or ``fixtures`` directory sitting at
    the same offset is still not this repository and is still not accepted.

    An **editable** install goes on resolving, which is the case a stricter test
    would have broken. A ``.pth``-based editable install puts the real
    ``tools/updater/src`` on ``sys.path``, so ``module_file`` is the working tree's
    own file and the parent directory genuinely is ``src`` — the checkout is
    reached because the layout says it is there, not because the install method
    was recognised.

    ``module_file`` is passed in rather than read from this module, so a caller
    resolves relative to *its own* file and a test can hand in a synthetic
    installed path without moving anything on disk.
    """
    package_dir = Path(module_file).resolve().parent
    if package_dir.parent.name != "src":
        return None
    return package_dir.parents[1]
