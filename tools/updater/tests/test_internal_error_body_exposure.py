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

#334 then fixed two assertions here that were binding by accident rather than by
property. The detail comparison compared a raw `json.dumps` against a body that
had been through `publisher._cell`, so it held only while the shipped detail
happened to contain no backslash, no pipe and no newline, and its `str.replace`
companion failed *open* when it did not. And the frame-*name* half of the
counterweight had no positive control, unlike the location half. Both fixes live
below, at `_detail_cell_as_the_body_carries_it` and at `_FRAME_NAME`.

Scope: this reads through `run_creators` and `publisher.render_body`; it does
not touch `test_budget_time_guard_invariant.py` (#248/#266 own that) nor
`publisher.py` (held by other docks).
"""

from __future__ import annotations

import asyncio
import json
import re

import pytest

from modeltree_updater.contracts import FailureKind, ProposalStatus

# `_cell` is private, and importing it is the deliberate half of the #334
# decision recorded at `_detail_cell_as_the_body_carries_it`: an expectation
# about the *body* has to be written in the body's own alphabet, and `_cell` is
# what defines that alphabet. The tautology that risks is closed there too.
from modeltree_updater.publisher import _cell, render_body
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

# A rendered stack-frame *name* in a frame's own context — the #334 finding-2
# half. `body.count("discover") == 1` below binds on the bare word, which cannot
# tell a leaked frame name from honest prose: "could not discover any sources
# for this creator" raises that count, and so does "rediscovery pass aborted" by
# substring. This pattern binds instead on the shape a frame name only ever has
# when a traceback renders it — a line number immediately followed by `in
# <name>` — which prose does not produce.
#
# Two forms are pinned by construction below: `format_exception`'s `, line N, in
# <name>` and the `FrameSummary` repr's `line N in <name>` that `extract_tb`
# yields. The second matters on its own account: it writes its location as
# `runner.py, line 118`, with neither the colon nor the quote `_FRAME_LOCATION`
# requires, so the location check does not see it at all. Neither list is
# exhaustive, and a leak shaped like neither is not thereby covered — in
# particular a *bare* frame name carrying no location context (a `detail` key
# holding just `["discover", "run_creators"]`, say) matches nothing here, which
# is why the bare-word count is kept alongside rather than replaced by this.
# Each catches what the other misses.
_FRAME_NAME = re.compile(r"line \d+,? in [A-Za-z_]\w*")

# Messages whose serialised `detail` exercises one of `_cell`'s three
# transformations, so the raw-versus-rendered gap #334 finding 1 describes is
# covered by example rather than assumed for two of the three. Only the
# backslash case has been observed in the wild — the QA gate on #181 hit it with
# a live Windows `co_filename` — so the other two are pinned here precisely
# because nothing has yet demonstrated they are benign.
_CELL_TRANSFORMING_MESSAGES = {
    # `json.dumps` doubles each separator, and `_cell` doubles them again: the
    # body carries `C:\\\\secrets`, the raw serialisation `C:\\secrets`.
    "backslash": SENSITIVE_MARKER + r" (C:\secrets\token.txt)",
    # `_cell` escapes the pipe so it cannot end the markdown row.
    "pipe": SENSITIVE_MARKER + " | shell stage",
    # A newline survives `json.dumps` as the two characters `\` and `n`, which
    # `_cell` then doubles. (The newline inside the *message* cell separately
    # becomes `<br>`.)
    "newline": SENSITIVE_MARKER + "\nsecond line of the message",
}


def _detail_json(proposal) -> str:
    """The failure's detail exactly as `publisher._failure_row` serialises it.

    Kept in one place so the tests below cannot drift from the call site they
    are asserting about."""
    return json.dumps(proposal.failures[0].detail, sort_keys=True, ensure_ascii=False)


def _detail_cell_as_the_body_carries_it(detail_json: str) -> str:
    """The serialised detail in the form the *rendered body* actually carries.

    THE #334 FINDING-1 DECISION, recorded where the next reader meets it.

    Criterion 1 offered two ways to stop comparing unlike with unlike: pass the
    expectation through the same rendering the body received, or compare against
    the pre-render value. **This file takes the first.** The comparison now made
    is `_cell(json.dumps(detail)) in body` — the rendered detail cell against the
    rendered body — and it is *not* `json.dumps(detail) in body`, which is what
    used to be written and what held only while the shipped detail contained no
    backslash, no pipe and no newline.

    The second option was rejected because it cannot be taken without severing
    the `detail -> body` link this assertion exists to bind. `_cell` has no
    inverse — `\\r\\n`, `\\r` and `\\n` all collapse to a single `<br>`, so the
    body cannot be read back to its pre-render form — which leaves "compare
    against the pre-render value" meaning "assert about `detail_json` alone and
    stop asserting about the body". That is strictly less than what is asserted
    today, and criterion 6 forbids it.

    Rendering the expectation through the production function does risk a
    tautology: an expectation computed by the same code that produced the body
    cannot, by itself, notice that code changing. That hole is closed at the call
    sites, which additionally assert the sensitive marker survives *into* the
    rendered expectation. A `_cell` that began redacting or dropping the payload
    would take the marker with it and redden those assertions; a `_cell` that
    merely changed its escaping would not, and should not, because the exposure
    being pinned would be unchanged. Redaction on the `_failure_row` path (the
    #282 change) is caught either way, because `detail_json` is built from the
    recorded failure rather than from anything the renderer returns."""
    return _cell(detail_json)


def _body_without_the_detail_cell(body: str, detail_json: str) -> str:
    """`body` with every copy of the rendered detail cell removed — or a failure.

    Never a silent no-op. `body.replace(x, "")` returns the body unchanged when
    `x` is absent, so the old raw-comparison version of this step failed *open*:
    a mismatch removed nothing and the marker scan that follows then passed on
    the strength of the detail copy it was supposed to have excluded, which is
    exactly the copy that would remain if the message channel were severed. The
    assertions below make that outcome a failure instead.

    The second assertion is not implied by the first: `"" in body` is true for
    every body, and `body.replace("", "")` returns it unchanged, so an empty
    rendered cell would slip past the membership check and be caught only here.
    """
    rendered = _detail_cell_as_the_body_carries_it(detail_json)
    assert rendered in body, (
        "the detail cell is not in the body in the form the body carries it, so "
        f"removing it would remove nothing; expected {rendered!r}"
    )
    stripped = body.replace(rendered, "")
    assert stripped != body, (
        "removing the detail cell changed nothing, so any scan of the result "
        "would run over a body that still carries the detail it must exclude"
    )
    assert rendered not in stripped, "a copy of the detail cell survived removal"
    return stripped


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

    Both halves are stated in the *body's* alphabet rather than in the raw
    serialisation's, per the #334 decision at
    `_detail_cell_as_the_body_carries_it`.

    Intended to hold *today*; when #282 bounds or redacts it, these assertions
    must be updated here consciously — the point of pinning."""
    proposal = _proposal_from_a_crash(library, settings)
    body = render_body(proposal)

    # The message channel reaches the body. The marker appears outside any
    # detail-JSON wrapper, which is the message cell's own contribution: strip
    # every rendered detail cell and the marker must still be present. The strip
    # refuses to remove nothing, so this cannot pass on a detail copy it failed
    # to find (#334 finding 1).
    detail_json = _detail_json(proposal)
    body_without_detail = _body_without_the_detail_cell(body, detail_json)
    assert SENSITIVE_MARKER in body_without_detail
    # The detail channel reaches the body too, via a signature the message cell
    # cannot produce: the rendered `{"traceback": "<marker>"}` JSON wrapper. This
    # binds `detail -> body` on its own — severing the detail cell fails this
    # assertion while leaving the message assertion above green.
    assert _detail_cell_as_the_body_carries_it(detail_json) in body
    # ...and the exposure survives that rendering. Without this, the assertion
    # above could go green against an expectation `_cell` had itself redacted;
    # with it, a `_cell` that dropped the payload reddens here.
    assert SENSITIVE_MARKER in _detail_cell_as_the_body_carries_it(detail_json)
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
    - Frame *name in a frame's context*: `_FRAME_NAME`, added by #334. The bare
      `discover` count above is sensitive to honest content — "could not
      discover any sources for this creator" raises it, and "rediscovery pass
      aborted" raises it by substring — so on its own it cannot say whether a
      rise is a leak. `line N, in <name>` is a shape prose does not write, so it
      can. It is an addition rather than a replacement: it does not see a frame
      name rendered with no location beside it, which the count does.

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
    # Body-scoped, binding on a frame name in a frame's *context*: `line N, in
    # <name>`. This catches a rendered frame name whatever it is called, and —
    # unlike the count above — it does not rise on honest prose that happens to
    # contain the word `discover`, which is the distinction #334 finding 2 asked
    # for. It also sees the `FrameSummary` location form (`runner.py, line 118`)
    # that `_FRAME_LOCATION` misses, and misses the bare frame name that the
    # count catches; all three are kept because none subsumes another.
    assert _FRAME_NAME.search(body) is None
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
    """Positive control for both body-scoped shape checks, so neither is a
    mechanism that fails on honest content. A real internal error whose message
    is ordinary prose — and, harder, one that *names* a `.py` file the way a real
    `ModuleNotFoundError` does — still renders a body with no rendered frame
    location and no rendered frame name, so the counterweight's `_FRAME_LOCATION`
    and `_FRAME_NAME` assertions both pass. This proves they bind on the
    line-numbered shape of a leaked frame, not on any mention of a source file,
    and that the counterweight would still hold for a normal failure rather than
    only for the contrived crash above.

    The honest message that names `discover` is not here but in
    `test_an_honest_message_naming_discover_is_distinguished_from_a_frame_leak`,
    because it separates the two name checks rather than passing both."""
    ordinary = _proposal_from_a_crash(
        library, settings, message="could not parse the configuration"
    )
    ordinary_body = render_body(ordinary)
    assert _FRAME_LOCATION.search(ordinary_body) is None
    assert _FRAME_NAME.search(ordinary_body) is None

    names_a_module = _proposal_from_a_crash(
        library, settings, message="No module named 'contoso.py'"
    )
    names_a_module_body = render_body(names_a_module)
    # The message names a `.py` file and reaches the body verbatim...
    assert "contoso.py" in names_a_module_body
    # ...yet it is not a frame location, so the check does not misfire on it.
    assert _FRAME_LOCATION.search(names_a_module_body) is None
    assert _FRAME_NAME.search(names_a_module_body) is None


@pytest.mark.parametrize(
    ("case", "raw_still_matches"),
    [
        # The control, and the reason this test is not a tautology: with no
        # transforming character the raw serialisation *is* what the body
        # carries, so the mismatches below are caused by the character under
        # test rather than by the comparison always failing. This is also the
        # accident finding 1 named — the shipped content happens to be this row.
        ("no transformation", True),
        ("backslash", False),
        ("pipe", False),
        ("newline", False),
    ],
)
def test_only_a_cell_transformed_character_makes_the_raw_detail_json_stop_matching(
    library, settings, case, raw_still_matches
) -> None:
    """#334 finding 1, isolated: `json.dumps(detail) in body` is a statement
    about the shipped content, not about the rendering.

    `_cell` doubles every backslash, escapes every pipe and turns every newline
    into `<br>`, so the raw serialisation and the body's copy are equal only
    while the detail contains none of the three. Each is pinned here, against a
    control that contains none of them and does match — so the technique
    discriminates instead of merely always reddening."""
    message = (
        SENSITIVE_MARKER
        if raw_still_matches
        else _CELL_TRANSFORMING_MESSAGES[case]
    )
    proposal = _proposal_from_a_crash(library, settings, message=message)
    body = render_body(proposal)
    detail_json = _detail_json(proposal)

    assert (detail_json in body) is raw_still_matches
    # ...while the rendered form is what the body carries, in every row.
    assert _detail_cell_as_the_body_carries_it(detail_json) in body


@pytest.mark.parametrize("case", sorted(_CELL_TRANSFORMING_MESSAGES))
def test_removing_the_raw_detail_json_fails_open_where_the_rendering_differs(
    library, settings, case
) -> None:
    """#334 finding 1's dangerous half, made executable: the old
    `body.replace(detail_json, "")` did not merely mismatch, it mismatched
    *silently*.

    `str.replace` returns the subject unchanged when the pattern is absent, so
    the "body without the detail" it produced still carried the entire detail
    cell. The marker scan that followed then passed on the detail's copy — the
    one it existed to exclude — which means it would have stayed green with the
    message channel severed altogether. That is the fail-open, asserted here
    rather than described, for each of `_cell`'s three transformations."""
    proposal = _proposal_from_a_crash(
        library, settings, message=_CELL_TRANSFORMING_MESSAGES[case]
    )
    body = render_body(proposal)
    detail_json = _detail_json(proposal)

    # The raw serialisation is not what the body carries...
    assert detail_json not in body
    # ...so removing it removes nothing, and says nothing about having failed.
    would_be_stripped = body.replace(detail_json, "")
    assert would_be_stripped == body
    # And this is the exposure: what the old code called "the body without the
    # detail" still contains the whole rendered detail cell, marker included.
    assert _detail_cell_as_the_body_carries_it(detail_json) in would_be_stripped
    assert SENSITIVE_MARKER in would_be_stripped


@pytest.mark.parametrize(
    "case", ["no transformation", *sorted(_CELL_TRANSFORMING_MESSAGES)]
)
def test_the_guarded_strip_removes_the_detail_cell_through_every_transformation(
    library, settings, case
) -> None:
    """The fix, held to the same four rows: `_body_without_the_detail_cell`
    finds the cell in the form the body carries it, removes it for real, and
    leaves a residue the message-channel scan can be trusted over.

    The final assertion is the one the old code could not honestly make: the
    marker that remains is the *message* cell's copy, because the detail cell is
    now provably gone from the string being scanned."""
    message = (
        SENSITIVE_MARKER
        if case == "no transformation"
        else _CELL_TRANSFORMING_MESSAGES[case]
    )
    proposal = _proposal_from_a_crash(library, settings, message=message)
    body = render_body(proposal)
    detail_json = _detail_json(proposal)

    stripped = _body_without_the_detail_cell(body, detail_json)
    assert stripped != body
    assert _detail_cell_as_the_body_carries_it(detail_json) not in stripped
    assert SENSITIVE_MARKER in stripped


def test_the_guarded_strip_refuses_to_remove_nothing(library, settings) -> None:
    """Acceptance criterion 2, directly: the strip cannot silently no-op.

    Handed an expectation the body does not carry, the helper raises instead of
    returning the body unchanged. `str.replace` on its own returns it unchanged
    and reports nothing, which is precisely the behaviour being removed — so
    both are exercised side by side here, one refusing and one not.

    `match` pins *which* guard fired: a bare `pytest.raises(AssertionError)`
    would be satisfied by any assertion in the helper failing for any reason,
    including one unrelated to the no-op this test is about."""
    proposal = _proposal_from_a_crash(library, settings)
    body = render_body(proposal)
    not_what_the_body_carries = json.dumps(
        {"traceback": "a detail this body does not contain"},
        sort_keys=True,
        ensure_ascii=False,
    )

    # The bare call is a silent no-op...
    assert body.replace(not_what_the_body_carries, "") == body
    # ...and the guarded one is a failure.
    with pytest.raises(AssertionError, match="removing it would remove nothing"):
        _body_without_the_detail_cell(body, not_what_the_body_carries)


# Rendered frame names, in the forms a leak would take by the time it reaches
# the body. The flag records whether `_FRAME_LOCATION` sees the same text: the
# `FrameSummary` row is the case where it does not, so `_FRAME_NAME` is adding
# coverage there rather than repeating it.
_FRAME_NAME_LEAKS = {
    "format_exception": (
        "Traceback (most recent call last):\n"
        '  File "/srv/app/modeltree_updater/runner.py", line 118, in discover\n'
        "    raise RuntimeError\n"
        "RuntimeError: boom",
        True,
    ),
    "frame_summary": (
        "<FrameSummary file /srv/app/runner.py, line 118 in discover>",
        False,
    ),
}


@pytest.mark.parametrize("case", sorted(_FRAME_NAME_LEAKS))
def test_a_rendered_frame_name_reddens_the_frame_name_checks(
    library, settings, case
) -> None:
    """Acceptance criterion 4, first half: the positive control the frame-*name*
    check lacked, to the standard #181 set for the location half.

    Both name checks in the counterweight are shown going red on a body that
    carries a rendered frame name — the bare `discover` count rises above its
    baseline of one, and `_FRAME_NAME` matches — so neither is vacuous. The
    `FrameSummary` row additionally pins what `_FRAME_NAME` adds: its location is
    written `runner.py, line 118`, with neither the colon nor the escaped quote
    `_FRAME_LOCATION` requires, so that check does not see it and this one
    does."""
    message, location_check_sees_it = _FRAME_NAME_LEAKS[case]
    leaked = render_body(_proposal_from_a_crash(library, settings, message=message))

    assert _FRAME_NAME.search(leaked) is not None
    assert leaked.count("discover") > 1
    assert (_FRAME_LOCATION.search(leaked) is not None) is location_check_sees_it


@pytest.mark.parametrize(
    "message",
    [
        "could not discover any sources for this creator",
        # By substring, which is the easy one to miss.
        "rediscovery pass aborted",
    ],
)
def test_an_honest_message_naming_discover_is_distinguished_from_a_frame_leak(
    library, settings, message
) -> None:
    """Acceptance criterion 4, second half: an honest message containing
    `discover` is told apart from a leaked frame name.

    The bare-word count cannot do it — both messages below raise it, exactly as
    a leak would, so on that evidence alone the two are indistinguishable. That
    is asserted here rather than assumed, because it is the reason `_FRAME_NAME`
    exists. `_FRAME_NAME` then makes the distinction: no line number stands
    beside the word, so there is no frame here and it does not fire.

    The counterweight keeps both checks. This test is why neither is sufficient
    alone, not an argument for dropping either."""
    honest = render_body(_proposal_from_a_crash(library, settings, message=message))

    # Indistinguishable from a leak by the count alone: it rises just the same.
    assert honest.count("discover") > 1
    # Distinguished by shape: honest prose is not a rendered frame.
    assert _FRAME_NAME.search(honest) is None
    assert _FRAME_LOCATION.search(honest) is None

