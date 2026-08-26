"""What an uncaught error publishes into the issue body — the #181 part-2 decision, executable.

Issue #181 part 2 asked for a *decision*, recorded where the next reader meets
it, about an arbitrary exception's `str()` reaching the published GitHub issue
body through `runner._failed_proposal`. The decision lives in that function's
docstring: the exposure is real, the whole-body `MAX_BODY_CHARS` truncation does
not cover it, bounding it is a behaviour change filed as its own issue (#282),
and the `"traceback"` key rename is deferred with it.

These tests make that decision executable rather than merely written down. They
pin the two halves the docstring credits and one it does not — so a future
bounding change (#282) cannot land silently: it must come here and update
`test_the_exception_message_and_detail_reach_the_published_body_verbatim`, which
is exactly the conscious edit the decision defers.

They are deliberately two-directional, and every assertion is scoped to what its
test's name promises. One test asserts the exposure is present today (both the
message and the detail cell reach the body verbatim); its counterweight asserts
the credited mitigation holds, and does so *about the body*. A stack frame can
reach the body two ways — as a frame *name* or as a frame *location*
(`filename:lineno`) — so the counterweight pins both: at baseline the body
carries exactly one `discover` (the `discover-sources` stage cell), and it
carries no `.py` source-file reference at all. Any full traceback reaching the
body by any route breaks one or both. So this file is not a battery that only
ever fails in one direction, and its body-named counterweight binds on the body
rather than on a detail key, covering frame locations as well as frame names.

Scope: this reads through `run_creators` and `publisher.render_body`; it does
not touch `test_budget_time_guard_invariant.py` (#248/#266 own that) nor
`publisher.py` (held by other docks).
"""

from __future__ import annotations

import asyncio
import json
import re

from modeltree_updater.contracts import FailureKind, ProposalStatus
from modeltree_updater.publisher import render_body
from modeltree_updater.runner import run_creators

# A marker shaped like the content the decision is about: a filesystem path and a
# URL, of the kind a real `OSError`/`urllib` message carries. Distinctive enough
# that finding it in the body cannot be a coincidence.
SENSITIVE_MARKER = "/secret/state/token-abc123 while fetching https://internal.example/private"

# A name that exists only as a local at the crash site. A traceback renders
# frame *lines* (the `raise`), never the *values* of locals, so this string
# never reaches the body even under a full-traceback regression: the assertion
# on it below is a documented belt-and-braces check that cannot independently
# fail. The mitigation is instead pinned by what a full traceback *would* render
# and `format_exception_only` does not — the frame *name* `discover` and any
# frame *location* (`filename:lineno`).
CRASH_SITE_LOCAL = "a_local_that_only_the_stack_frame_would_show"

# A rendered stack-frame *location*, in every form a leak would take by the time
# it reaches the body: the `File "<path>.py", line <n>` form
# `traceback.format_exception` prints, the terser `<path>.py:<n>` form
# `extract_tb`/a `co_filename:tb_lineno` walk yields, and — crucially — the
# double-escaped shape either takes once it passes through a `detail` cell, where
# `json.dumps` turns `"` into `\"` and `_cell` then doubles the backslashes, so
# the body actually carries `<path>.py\\", line <n>`. The `\\*` before the quote
# absorbs that escaping; with zero backslashes it still matches the raw idioms.
# Matching the `.py` + line-number shape rather than a bare `.py` is deliberate:
# a legitimate exception *message* may name a `.py` file (`No module named
# 'x.py'`), and banning that outright would make the counterweight fire on honest
# content — as broken as one that never fires. A file paired with a line number
# is specifically a frame location, not prose.
_FRAME_LOCATION = re.compile(r'\.py(?:\\*", line |:)\d+')


def _proposal_from_a_crash(library, settings, *, message: str = SENSITIVE_MARKER):
    """Run one creator whose source provider raises, and return its proposal.

    `message` is the text of the raised `RuntimeError`; it defaults to the
    path-and-URL `SENSITIVE_MARKER` the exposure tests care about, and can be
    overridden with an ordinary path-free string for the positive control that
    proves the body-scoped `.py` check does not fire on legitimate content."""

    class Exploding:
        name = "exploding:sources"

        async def discover(self, creator, *, limit):
            a_local_that_only_the_stack_frame_would_show = CRASH_SITE_LOCAL  # noqa: F841
            raise RuntimeError(message)

        async def fetch(self, candidate):  # pragma: no cover - never reached
            raise AssertionError

    broken = type(settings)(
        type(settings.providers)(
            sources=Exploding(),
            extractor=settings.providers.extractor,
            panel=settings.providers.panel,
        ),
        budget=settings.budget,
        timestamp=settings.timestamp,
    )
    report = asyncio.run(
        run_creators([library.creators["contoso-ai"]], broken, run_id="run-test")
    )
    return report.proposals[0]


def test_the_crash_becomes_an_internal_error_carrying_the_exception_text(library, settings) -> None:
    """The recorded state: message is `type: str(error)`, detail holds the
    narrow (frame-free) formatted exception under the misnamed `traceback` key."""
    proposal = _proposal_from_a_crash(library, settings)

    assert proposal.status is ProposalStatus.FAILED
    failure = proposal.failures[0]
    assert failure.kind is FailureKind.INTERNAL_ERROR
    assert failure.message == f"RuntimeError: {SENSITIVE_MARKER}"
    assert SENSITIVE_MARKER in failure.detail["traceback"]
    assert failure.retryable is False


def test_the_exception_message_and_detail_reach_the_published_body_verbatim(
    library, settings
) -> None:
    """The exposure the decision documents: an arbitrary exception's text reaches
    the published issue body unbounded and unredacted, through *both* channels,
    and each channel is pinned so it can fail *independently* of the other.

    The `message` and `detail["traceback"]` fields happen to carry byte-identical
    text today, so asserting the raw marker twice would be one assertion wearing
    two hats — severing either channel alone would leave the other's copy in the
    body and the test green. To bind the channels apart, each assertion keys on a
    signature only *its* channel produces in the rendered body:

    - The message cell renders the marker as bare cell text, so a marker that is
      *not* wrapped in the detail's JSON is the message channel's signature.
    - The detail cell renders as `json.dumps({"traceback": ...})`, so the
      `{"traceback": "<marker>"}` wrapper is a substring the message cell never
      produces. Severing the detail (`detail={}` -> cell becomes the em dash)
      removes it while the message copy survives, so this assertion — and only
      this one — goes red. That is the `detail -> body` link, genuinely bound:
      #282 cannot bound or drop either channel without failing here.

    Intended to hold *today*; when #282 bounds or redacts it, these assertions
    must be updated here consciously — the point of pinning."""
    proposal = _proposal_from_a_crash(library, settings)
    body = render_body(proposal)

    # The message channel reaches the body. The marker appears outside any
    # detail-JSON wrapper, which is the message cell's own contribution: strip
    # every detail-JSON occurrence and the marker must still be present.
    detail_json = json.dumps(
        proposal.failures[0].detail, sort_keys=True, ensure_ascii=False
    )
    body_without_detail = body.replace(detail_json, "")
    assert SENSITIVE_MARKER in body_without_detail
    # The detail channel reaches the body too, via a signature the message cell
    # cannot produce: the rendered `{"traceback": "<marker>"}` JSON wrapper. This
    # binds `detail -> body` on its own — severing the detail cell fails this
    # assertion while leaving the message assertion above green.
    assert detail_json in body
    assert SENSITIVE_MARKER in detail_json


def test_no_stack_frame_reaches_the_published_body(library, settings) -> None:
    """The counterweight, proving the file is not one-directional and that the
    credited mitigation is real: `format_exception_only` yields type and message
    only, so no stack frame from the crash site reaches the *body*.

    A stack frame reaching the body would show up two ways, and this test binds
    on both, body-scoped:

    - Frame *name*: `body.count("discover") == 1`. At baseline the only
      `discover` in the body is the `discover-sources` stage cell; a full
      traceback rendered through `message` or a `detail` cell repeats the frame
      *name* `discover` and pushes the count above one.
    - Frame *location*: no rendered frame location reaches the body. At baseline
      the body carries none. A frame location (`filename:lineno`), the form
      `traceback.extract_tb` and a bare `co_filename:tb_lineno` walk produce,
      pairs a `.py` path with a line number but need not repeat any frame *name*
      — so the name count alone would miss it. This is the gap the location check
      closes: a traceback added under a fresh `detail` key such as `"frames"` or
      `"location"`, or a location appended in `publisher._failure_row` (the
      function #282 will change), leaks paths and line numbers without
      necessarily touching the `discover` count. `_FRAME_LOCATION` matches the
      location as it actually lands in the body, including the double-escaped
      `.py\\", line N` shape a `detail`-routed location takes after `json.dumps`
      escapes the quote and `_cell` doubles the backslashes — matching only the
      raw `.py", line N` would miss precisely the `detail["location"]` route this
      bullet names.

    A `detail`-scoped assertion could see none of those routes, which is the
    scope trap this test avoids: it asserts about `body`, which is what its name
    promises, and it covers frame locations as well as frame names.

    The `detail["traceback"]` assertion below stays as a supporting check on the
    narrow formatter at its source. The `CRASH_SITE_LOCAL` assertion is
    belt-and-braces only — a traceback renders frame lines, never local values,
    so it cannot independently fail and is not what proves the mitigation."""
    proposal = _proposal_from_a_crash(library, settings)
    body = render_body(proposal)

    # Body-scoped, binding on frame *names*: baseline has exactly one `discover`
    # (the `discover-sources` stage cell). A traceback rendered into the body
    # repeats the frame name `discover` and breaks this.
    assert body.count("discover") == 1
    # Body-scoped, binding on frame *locations*: no rendered frame location
    # reaches the body. A frame location pairs a `.py` file with a line number
    # (`extract_tb`, a `co_filename:tb_lineno` walk, or `format_exception`'s
    # `File "...", line N`, and its double-escaped `.py\\", line N` form once a
    # `detail` cell has been through `json.dumps` and `_cell`); the baseline body
    # carries none. This catches location leaks that add no frame name, which the
    # count above would miss, while a bare `.py` in a legitimate message does not
    # trip it.
    assert _FRAME_LOCATION.search(body) is None
    # Supporting, at the source: the narrow formatter puts no frame in `detail`.
    assert "discover" not in proposal.failures[0].detail["traceback"]
    # Belt-and-braces: cannot independently fail (locals' values are never
    # rendered into a traceback).
    assert CRASH_SITE_LOCAL not in body


def test_a_legitimate_internal_error_body_is_not_flagged_as_a_frame_leak(
    library, settings
) -> None:
    """Positive control for the frame-location check, so it is not a mechanism
    that fails on honest content. A real internal error whose message is ordinary
    prose — and, harder, one that *names* a `.py` file the way a real
    `ModuleNotFoundError` does — still renders a body with no rendered frame
    location, so the counterweight's `_FRAME_LOCATION` assertion passes. This
    proves the check binds on the `.py`+line-number shape of a leaked frame, not
    on any mention of a source file, and that the counterweight would still hold
    for a normal failure rather than only for the contrived crash above."""
    ordinary = _proposal_from_a_crash(
        library, settings, message="could not parse the configuration"
    )
    ordinary_body = render_body(ordinary)
    assert _FRAME_LOCATION.search(ordinary_body) is None

    names_a_module = _proposal_from_a_crash(
        library, settings, message="No module named 'contoso.py'"
    )
    names_a_module_body = render_body(names_a_module)
    # The message names a `.py` file and reaches the body verbatim...
    assert "contoso.py" in names_a_module_body
    # ...yet it is not a frame location, so the check does not misfire on it.
    assert _FRAME_LOCATION.search(names_a_module_body) is None

