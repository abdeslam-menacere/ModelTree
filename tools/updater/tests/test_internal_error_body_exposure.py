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

#328 then put a different question to the location half — not whether a leak can
slip past it, but what *honest* content could wear the shape it keys on. A
`SyntaxError` can: `format_exception_only` renders its file and line with the
same `File "<path>", line N` idiom a traceback frame uses, so the check reddens
on a body that leaked no frame at all. The decision taken there — that the red
is accepted and the pattern is *not* narrowed — is recorded at `_FRAME_LOCATION`
below, beside the pattern, where a reader meeting the red will be looking. The
two tests at the end of this file hold the code to it.

#364 then found that #334's own two hunks disagreed with each other. The guard
finding 1 added to `_body_without_the_detail_cell` fires *before* the assertion
the exposure test's docstring said a severed detail would redden, so the named
assertion was never reached, the message assertion said to survive green beside
it was never evaluated, and the failure a reader would meet pointed at the strip
helper rather than at the severed channel. The guard is right and is untouched;
what was wrong was the prose describing it. The corrected account lives in
`test_the_exception_message_and_detail_reach_the_published_body_verbatim`'s
docstring, and — because a claim about which check fires is worth no more than a
claim about coverage unless it is executed — two new tests hold it to the code:
`test_severing_the_detail_reddens_the_strip_guard_before_these_assertions` and
`test_an_empty_rendered_detail_cell_is_refused_by_the_no_op_guard`.

Scope: this reads through `run_creators` and `publisher.render_body`; it does
not touch `test_budget_time_guard_invariant.py` (#248/#266 own that) nor
`publisher.py` (held by other docks).
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import replace

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

# THE #328 DECISION, recorded where the next reader meets it.
#
# If you are here because this check went red and you cannot find the leak: look
# at what the exception *was*. A `SyntaxError` reddens this line while leaking
# nothing, and that is accepted behaviour rather than a defect to fix.
#
# `traceback.format_exception_only` renders a `SyntaxError` as
#
#     File "contoso_config.py", line 1
#         x = (1
#             ^
#     SyntaxError: '(' was never closed
#
# The file and the line there are the exception's *own* message — not a stack
# frame the redaction failed to remove. Measured through the pipeline, the shape
# reaches the body by the `detail` channel alone, as `.py\\", line 1`: the
# `message` channel carries `str(error)`, which for a `SyntaxError` is the comma
# form `'(' was never closed (contoso_config.py, line 1)` and matches nothing
# here.
#
# So the failure fingerprint is one red of three — this check fires while both
# frame-*name* checks stay at baseline, because `_FRAME_NAME` does not match and
# the text carries no `discover`. A genuine frame leak reddens the name checks
# too (`test_a_rendered_frame_name_reddens_the_frame_name_checks`). That
# asymmetry is the diagnostic, and
# `test_a_syntax_error_message_reddens_only_the_location_check` pins it.
#
# The pattern is deliberately **not** narrowed to exclude the shape, for three
# reasons:
#
# 1. The two are not separable by shape. A `SyntaxError`'s location and a
#    traceback frame's are emitted by the same rendering code in the same
#    spelling, so nothing in that text *alone* tells them apart. The only
#    separators are context — a preceding `Traceback (most recent call last):`,
#    or a trailing `, in <name>` — and requiring `, in <name>` makes this
#    pattern a strict subset of `_FRAME_NAME`, destroying the one gap it exists
#    to close: a location leak that names no frame (`extract_tb`, a
#    `co_filename:tb_lineno` walk, a fresh `detail["location"]` key).
# 2. The two directions of failure do not cost the same. A spurious red costs
#    one reading of this comment; a pattern narrowed until it misses a real
#    location leak publishes paths and line numbers. The bias is chosen.
# 3. The content really is disclosed. This check is body-scoped: it asks what
#    the published body *carries*, not how it got there. A `SyntaxError`-derived
#    `INTERNAL_ERROR` does publish a filesystem path, a line number and the
#    offending line of source into a public issue body. The red is therefore a
#    true positive about the content, and a false positive only about the causal
#    story the counterweight's *name* tells. Bounding that content is #282's
#    job, not this check's — and if #282 lands a bound or a redaction on the
#    `INTERNAL_ERROR` detail, this red may disappear as a side effect rather
#    than needing anything done here.
#
# Do not widen it either. The block above declines a bare `.py` for the mirror
# image of reason 2, and `test_the_raw_frame_location_idioms_still_match` fails
# on a narrowing in either direction.

# A rendered stack-frame *name* in a frame's own context — the #334 finding-2
# half. `body.count("discover") == 1` below binds on the bare word, which cannot
# tell a leaked frame name from honest prose: "could not discover any sources
# for this creator" raises that count, and so does "rediscovery pass aborted" by
# substring. This pattern binds instead on the shape a frame name has when a
# traceback renders it — a line number immediately followed by `in <name>`.
#
# That shape is much rarer in prose than the bare word, and no message this
# updater ships has it. It is *not* something prose cannot produce, and saying
# so would repeat the overstatement this file is here to remove: `invalid syntax
# at line 42 in settings`, `parse error on line 7, in the manifest`, and `could
# not read line 3 in profile` all match, and are all plausible English. The
# narrowing is a large reduction in false positives, not an elimination, and the
# examples above are illustrations rather than the full set. `_FRAME_LOCATION`
# above declines a bare `.py` for the same reason in the opposite direction;
# this pattern accepts a smaller version of the same risk because the
# alternative — the bare word alone — carries far more of it.
#
# Two frame forms are pinned by construction below: `format_exception`'s `, line
# N, in <name>` and the `FrameSummary` repr's `line N in <name>` that
# `extract_tb` yields. The second matters on its own account: it writes its
# location as `runner.py, line 118`, with neither the colon nor the quote
# `_FRAME_LOCATION` requires, so the location check does not see it at all.
# Neither list is exhaustive, and a leak shaped like neither is not thereby
# covered — in particular a *bare* frame name carrying no location context (a
# `detail` key holding just `["discover", "run_creators"]`, say) matches nothing
# here, which is why the bare-word count is kept alongside rather than replaced
# by this. Each catches what the other misses.
_FRAME_NAME = re.compile(r"line \d+,? in [A-Za-z_]\w*")

# Messages whose serialised `detail` diverges between the raw `json.dumps` and
# the body's rendered copy, so the gap #334 finding 1 describes is covered by
# example rather than assumed. Only the backslash case has been observed in the
# wild — the QA gate on #181 hit it with a live Windows `co_filename` — so the
# others are pinned here precisely because nothing has demonstrated they are
# benign.
#
# Which of `_cell`'s transformations each row actually exercises is **not** one
# each, and saying so would be the defect this file exists to police. Measured
# by dropping each transformation from `_cell` in turn: removing the backslash
# doubling reddens the `backslash` *and* `newline` rows, removing the pipe
# escaping reddens `pipe`, and removing the newline-to-`<br>` conversion reddens
# none of them. The reason is that `json.dumps` runs first and escapes a real
# newline to the two characters `\` and `n`, so `_cell` never sees a newline in
# a *detail* cell at all and the `newline` row's divergence is backslash
# doubling reached by a different input. It is kept as its own row because a
# newline in the message is a distinct and realistic way to reach that
# divergence, not because it covers a third transformation.
#
# The newline-to-`<br>` conversion is real and load-bearing, and it is bound
# separately — on the *message* cell, which is the only cell a raw newline
# survives into. See `_MESSAGE_NEWLINE_FORMS` below.
_CELL_TRANSFORMING_MESSAGES = {
    # `json.dumps` doubles each separator, and `_cell` doubles them again: the
    # body carries `C:\\\\secrets`, the raw serialisation `C:\\secrets`.
    "backslash": SENSITIVE_MARKER + r" (C:\secrets\token.txt)",
    # `_cell` escapes the pipe so it cannot end the markdown row.
    "pipe": SENSITIVE_MARKER + " | shell stage",
    # Reaches the same backslash doubling as the row above, by way of the `\n`
    # escape `json.dumps` writes. Not the `<br>` transformation — see above.
    "newline": SENSITIVE_MARKER + "\nsecond line of the message",
}

# The three line endings `_cell` converts to `<br>`, each with its own
# replacement in `publisher._cell` and so each bound separately below. A raw
# newline reaches the body only through the *message* cell: the detail cell is
# serialised by `json.dumps` first, which escapes it out of existence.
_MESSAGE_NEWLINE_FORMS = {
    "lf": "\n",
    "crlf": "\r\n",
    "cr": "\r",
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
    would take the marker with it and redden the test — though not, in general,
    the marker assertion itself; #364 measured which check actually fires for
    four such `_cell`s and recorded it at that call site. A `_cell` that merely
    changed its escaping would not redden anything, and should not, because the
    exposure being pinned would be unchanged. Redaction on the `_failure_row`
    path (the #282 change) is caught either way, because `detail_json` is built
    from the recorded failure rather than from anything the renderer returns."""
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


def _proposal_from_a_crash(
    library, settings, *, message: str = SENSITIVE_MARKER, error: BaseException | None = None
):
    """Run one creator whose source provider raises, and return its proposal.

    `message` is the text of the raised `RuntimeError`; it defaults to the
    path-and-URL `SENSITIVE_MARKER` the exposure tests care about, and can be
    overridden with an ordinary path-free string for the positive control that
    proves the body-scoped `.py` check does not fire on legitimate content.

    `error`, when given, is raised in place of that `RuntimeError` and `message`
    is ignored. It exists for the #328 case, which needs a real `SyntaxError`
    rather than a `RuntimeError` whose text imitates one: the whole question
    there is what `format_exception_only` does with the genuine article, and it
    renders a `SyntaxError` specially, reading attributes only a real one
    carries."""

    class Exploding:
        name = "exploding:sources"

        async def discover(self, creator, *, limit):
            a_local_that_only_the_stack_frame_would_show = CRASH_SITE_LOCAL  # noqa: F841
            if error is not None:
                raise error
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
      produces. That is the `detail -> body` link, genuinely bound: #282 cannot
      bound or drop either channel without failing here.

    What severing the detail *does* to this test is not what this docstring used
    to say, and #364 corrects it. The old wording claimed the detail assertion
    below — "and only this one" — went red while the message assertion survived
    green beside it. Both halves were false, and the thing that falsified them
    was the guard added by the same change (#334 finding 1). `detail={}` renders
    the cell as the em dash while `_detail_json` still returns `"{}"`, so
    `_body_without_the_detail_cell` — called first, before either detail
    assertion is reached — refuses to strip a cell it cannot find, and the test
    stops there. Three consequences, all measured:

    - The red is at that guard, not at the detail assertion.
    - Its message names the *strip helper* ("removing it would remove nothing"),
      which reads as a broken fixture rather than as the severed channel it is
      actually reporting.
    - The message assertion below is never evaluated, so it cannot be observed
      to survive under the very mutation that was cited for it.

    "Only this one" was also wrong on its own terms: set the guard aside and
    `detail={}` falsifies the detail assertion *and* both assertions after it.
    What stays true is the substance — severing the detail really does redden
    this test, and the message channel's copy really does survive in the body.
    Both are now asserted where control reaches them, by
    `test_severing_the_detail_reddens_the_strip_guard_before_these_assertions`.

    The guard is correct and is deliberately left alone: catching a severed
    detail at the strip is the right order, because a scan that ran on an
    unstripped body would be the fail-open #334 removed. What was wrong here was
    the attribution, not the code.

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
    # binds `detail -> body` on its own: `detail={}` falsifies it. It is not what
    # *reddens* under a severed detail, though — the strip above fires first and
    # this line is never reached (#364; see the docstring, and
    # `test_severing_the_detail_reddens_the_strip_guard_before_these_assertions`).
    assert _detail_cell_as_the_body_carries_it(detail_json) in body
    # ...and the exposure survives that rendering. Without this, the assertion
    # above could go green against an expectation `_cell` had itself redacted.
    #
    # Which check a payload-dropping `_cell` reddens is *not* this one, in
    # general. #364 measured four of them rather than leaving the claim
    # standing, and three redden something earlier: a `_cell` returning `""`
    # reddens the strip's no-op guard, because an empty cell is "in" every body
    # and so passes the membership guard ahead of it — pinned by
    # `test_an_empty_rendered_detail_cell_is_refused_by_the_no_op_guard`. A
    # `_cell` that redacts every cell — including one redacting only the marker,
    # which is #282's likely shape — reddens the message-channel assertion
    # above, because the marker leaves the message cell with it. Only a `_cell`
    # redacting the serialised *detail* alone reaches this line. So the
    # tautology hole is closed — all four are caught — but by the test as a
    # whole rather than by this assertion.
    assert SENSITIVE_MARKER in _detail_cell_as_the_body_carries_it(detail_json)
    assert SENSITIVE_MARKER in detail_json


def _with_the_detail_severed(proposal):
    """`proposal` with its recorded failure detail emptied: the `detail={}` case.

    Built here rather than by hand-editing `runner._failed_proposal`, so the
    severed case is pinned by the suite instead of by a mutation each reader has
    to perform for themselves. Faithful by measurement, not by argument: the
    body this renders is character-for-character (3000 of them) the body the
    production mutation produces."""
    failure = proposal.failures[0]
    return replace(proposal, failures=(replace(failure, detail={}),))


def test_severing_the_detail_reddens_the_strip_guard_before_these_assertions(
    library, settings
) -> None:
    """#364: what `detail={}` actually does to the test above.

    That test's docstring claimed the detail assertion — "and only this one" —
    went red under a severed detail, with the message assertion surviving green
    beside it. Neither half held: `_body_without_the_detail_cell` runs first and
    its membership guard refuses a cell the body does not carry, so the run stops
    two lines short of the assertion being described. Every clause of the
    correction is asserted here, so the attribution cannot drift back.

    This is a statement about *which* check fires, so it is deliberately not
    satisfied by "something went red". `match` names the guard, and the two
    assertions the old wording got wrong are checked where control reaches
    them."""
    severed = _with_the_detail_severed(_proposal_from_a_crash(library, settings))
    body = render_body(severed)
    detail_json = _detail_json(severed)

    # The premise the old docstring had right: the cell becomes the em dash
    # while the raw serialisation is still `"{}"`, so the two cannot match.
    assert detail_json == "{}"
    assert "—" in body
    assert _detail_cell_as_the_body_carries_it(detail_json) not in body

    # And this is what it costs: the *strip guard* fires, not the detail
    # assertion. `match` pins which of the helper's three guards it was — a bare
    # `pytest.raises(AssertionError)` would be satisfied by any of them, which is
    # precisely the imprecision this test exists to remove.
    with pytest.raises(AssertionError, match="removing it would remove nothing"):
        _body_without_the_detail_cell(body, detail_json)

    # The one true half of the old claim, made demonstrable. The message copy
    # does survive a severed detail — and here it cannot be the detail's copy
    # being seen, because the detail cell is now the em dash and carries nothing.
    assert SENSITIVE_MARKER in body

    # "Only this one" was wrong on its own terms too. Set the guard aside and
    # `detail={}` falsifies both assertions that follow the detail assertion, so
    # even reached, it would not have been the only red.
    assert SENSITIVE_MARKER not in _detail_cell_as_the_body_carries_it(detail_json)
    assert SENSITIVE_MARKER not in detail_json


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
    # trip it. See the #328 decision at `_FRAME_LOCATION`: a `SyntaxError` reddens
    # this assertion while leaking no frame, which is accepted rather than fixed.
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


def test_an_empty_rendered_detail_cell_is_refused_by_the_no_op_guard(
    library, settings
) -> None:
    """The helper's *second* guard, which its docstring describes and nothing
    pinned — and #364's acceptance criterion 4, answered.

    The marker-survives assertion in
    `test_the_exception_message_and_detail_reach_the_published_body_verbatim`
    carried a comment saying a `_cell` that dropped its payload reddened *that*
    assertion. Measured against a `_cell` returning `""` for every cell, it does
    not: it reddens the guard exercised here, three checks earlier. An empty
    rendered cell is the one case the membership guard cannot catch, because
    `"" in body` is true for every body and `body.replace("", "")` returns it
    unchanged — so the emptiness passes the first guard and only the no-op guard
    refuses it.

    Both facts are asserted rather than described, and `match` names which guard
    fired, for the reason the test above gives."""
    proposal = _proposal_from_a_crash(library, settings)
    body = render_body(proposal)

    # An empty expectation defeats the membership guard, twice over...
    assert "" in body
    assert body.replace("", "") == body
    # ...so the no-op guard is what refuses it, with its own distinct message.
    with pytest.raises(AssertionError, match="changed nothing"):
        _body_without_the_detail_cell(body, "")


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


@pytest.mark.parametrize("form", sorted(_MESSAGE_NEWLINE_FORMS))
def test_a_newline_in_the_message_is_rendered_as_a_break_not_a_row_split(
    library, settings, form
) -> None:
    """Acceptance criterion 3's third transformation, bound where it is real.

    `_CELL_TRANSFORMING_MESSAGES` cannot reach this one. Every row there is
    observed through the *detail* cell, and `json.dumps` escapes a newline to
    the two characters `\\` and `n` before `_cell` is ever called, so no detail
    cell contains a newline to convert. Measured rather than reasoned: with
    `_cell`'s `<br>` conversion removed, those rows stay green.

    The message cell is the one a raw newline survives into, so the conversion
    is bound here. Two independent assertions, because the failure has two
    faces. The first is that the break is *present*. The second is that the row
    is *intact*: without the conversion the markdown row ends mid-message and
    the remainder becomes a new line of the document, which is the table
    corruption `_cell` exists to prevent and the more damaging of the two.

    Each line ending gets its own case because `_cell` gives each its own
    replacement, and a single case would leave two of the three unbound."""
    separator = _MESSAGE_NEWLINE_FORMS[form]
    tail = "second line of the message"
    message = SENSITIVE_MARKER + separator + tail
    body = render_body(_proposal_from_a_crash(library, settings, message=message))
    rendered = _cell(message)

    # The conversion happened: the cell carries a break, not the separator.
    # Scoped to the cell rather than the whole body, because the body is a
    # markdown document and is full of legitimate newlines of its own.
    assert "<br>" in rendered
    assert separator not in rendered
    assert "<br>" in body
    assert rendered in body

    # One line ending in, exactly one break out. `_cell` gives `\r\n` its own
    # replacement ahead of the single-character two, and this is the assertion
    # that binds it: without it a `\r\n` falls through both and renders as
    # `<br><br>`, which splits no row and so passes every check above.
    assert rendered.count("<br>") == 1

    # The row survived it. This is the assertion the one above cannot make: with
    # the conversion dropped, `_cell` returns the separator untouched and the
    # body embeds it, so `rendered in body` still holds while the markdown row
    # has silently become two. `splitlines` splits on every one of the three
    # separators, so an unconverted one shows up here as the message landing on
    # two lines of the document instead of one.
    carrying_the_marker = [
        line for line in body.splitlines() if SENSITIVE_MARKER in line
    ]
    assert len(carrying_the_marker) == 1
    row = carrying_the_marker[0]
    assert tail in row, "the message cell was split across two markdown rows"
    assert row.rstrip().endswith("|")


# Rendered frame *locations*, in the raw forms a leak wears before any cell
# rendering: the two `format_exception` spellings and the terser `extract_tb`
# one. The flag records whether the `detail` route double-escapes the row's
# quote, which is the difference between the two halves of `_FRAME_LOCATION`'s
# alternation — the colon form carries no quote to escape and so exercises the
# other branch.
_RAW_FRAME_LOCATIONS = {
    "extract_tb colon form": ("tests/test_x.py:84", False),
    "format_exception posix": (
        'File "/srv/app/modeltree_updater/runner.py", line 118, in discover',
        True,
    ),
    "format_exception windows": (
        r'File "C:\workspace\tools\updater\tests\test_x.py", line 84, in discover',
        True,
    ),
}


@pytest.mark.parametrize("case", sorted(_RAW_FRAME_LOCATIONS))
def test_the_raw_frame_location_idioms_still_match(library, settings, case) -> None:
    """#328 acceptance criterion 3's evidence half: the idioms this pattern must
    keep catching, pinned so that narrowing it goes red.

    The #328 decision recorded at `_FRAME_LOCATION` is to leave the pattern
    alone, so nothing here changes any behaviour today. These rows exist for the
    *next* edit. Widening and narrowing this pattern have each already broken it
    once, and criterion 4's instruction not to weaken the location check is only
    worth something if something actually fails when it is weakened. The obvious
    way to exclude the `SyntaxError` shape — requiring `, in <name>` after the
    line number — reddens the colon row below, which carries no frame name at
    all and is exactly the leak the location check exists to catch.

    Each idiom is checked on both routes into the body, because they are not the
    same string. Raw is what the `message` cell carries. The `detail` cell is
    put through `json.dumps`, which turns `"` into `\\"`, and then `_cell`, which
    doubles the backslash — so the body carries `.py\\\\", line N`, and a pattern
    that handled only the raw spelling would miss precisely the `detail`-routed
    location leak. The `doubles_the_quote` flag asserts which branch each row
    actually exercised, so a row cannot quietly pass on the wrong one.

    Distinct from `test_a_rendered_frame_name_reddens_the_frame_name_checks`,
    which covers two frame-*name* leaks and reads the location flag only in
    passing: it exercises neither the Windows form, nor the colon form, nor the
    raw-versus-rendered split."""
    raw, doubles_the_quote = _RAW_FRAME_LOCATIONS[case]

    # The `message` channel's spelling.
    assert _FRAME_LOCATION.search(raw) is not None

    # The `detail` channel's, taken from the real pipeline rather than
    # hand-escaped, so the escaping under test is the one production performs.
    proposal = _proposal_from_a_crash(library, settings, message=raw)
    rendered_detail = _detail_cell_as_the_body_carries_it(_detail_json(proposal))
    assert _FRAME_LOCATION.search(rendered_detail) is not None

    # And it matched the branch this row is here to exercise: the quoted forms
    # arrive double-escaped, the colon form arrives untouched. Without this, all
    # three rows could be passing on the raw spelling alone.
    assert (r'.py\\", line' in rendered_detail) is doubles_the_quote


def _a_real_syntax_error() -> SyntaxError:
    """A genuine `SyntaxError`, carrying the attributes the interpreter sets.

    Built by `compile` rather than constructed by hand, because
    `format_exception_only` renders a `SyntaxError` from its `filename`,
    `lineno` and `text` attributes; an instance raised as
    `SyntaxError("...")` has none of them and renders as an ordinary exception.
    That version of this test would pass for the wrong reason or not at all."""
    try:
        compile("x = (1", "contoso_config.py", "exec")
    except SyntaxError as error:
        return error
    raise AssertionError("compile() accepted a deliberately unclosed bracket")


def test_a_syntax_error_message_reddens_only_the_location_check(
    library, settings
) -> None:
    """#328, pinned: the accepted false positive, and the fingerprint that
    identifies it.

    This is the test to read if `_FRAME_LOCATION` has gone red and the leak
    cannot be found. The decision and its reasoning live at `_FRAME_LOCATION`;
    what is asserted here is that the code still behaves the way that decision
    describes, so the two cannot drift apart silently — which is the whole point
    of recording a decision next to the thing it is about.

    Three things are bound, and the third is what makes this more than a
    restatement of the issue:

    - **Nothing leaked.** `format_exception_only` renders no frame from the
      crash site, so the frame name `discover` does not reach the body and
      `_FRAME_NAME` finds nothing. Both name checks sit at their baseline.
    - **The location check fires anyway**, on the exception's own message.
    - **It fires through the `detail` channel alone.** `str()` of a
      `SyntaxError` is the comma form `'(' was never closed (contoso_config.py,
      line 1)`, which this pattern does not match, so the `message` cell
      contributes nothing. The `File "...", line 1` spelling exists only in
      `detail["traceback"]`. A reader who assumed the red came from the message
      would strip the wrong channel and still be red.

    The two literal assertions below read CPython's own `SyntaxError` rendering,
    which is the one version-sensitive thing in this file. Verified on 3.11; CI
    also runs 3.13. If a future interpreter reddens them, what changed is the
    rendering and not this repository — re-read the #328 decision at
    `_FRAME_LOCATION` and check whether its premise still holds, namely that a
    `SyntaxError` still spells its location the way a traceback frame does,
    before editing anything here."""
    error = _a_real_syntax_error()
    proposal = _proposal_from_a_crash(library, settings, error=error)
    failure = proposal.failures[0]
    body = render_body(proposal)

    assert failure.kind is FailureKind.INTERNAL_ERROR
    # The exception's own message names a file and a line...
    assert 'File "contoso_config.py", line 1' in failure.detail["traceback"]
    # ...and, measured rather than assumed, carries a line of source with it.
    # That contradicts the "no source line reaches the body" reading of
    # `format_exception_only`, and it is #282's exposure to bound, not something
    # this counterweight can do anything about.
    assert "x = (1" in failure.detail["traceback"]

    # No frame leaked: both frame-*name* checks hold exactly where
    # `test_no_stack_frame_reaches_the_published_body` leaves them.
    assert body.count("discover") == 1
    assert _FRAME_NAME.search(body) is None

    # The location check fires regardless. Accepted, per the decision above.
    assert _FRAME_LOCATION.search(body) is not None

    # ...and it fires by the `detail` route only. The message channel carries
    # the comma spelling, which this pattern does not see.
    assert failure.message == f"SyntaxError: {error}"
    assert _FRAME_LOCATION.search(_cell(failure.message)) is None
    assert (
        _FRAME_LOCATION.search(
            _detail_cell_as_the_body_carries_it(_detail_json(proposal))
        )
        is not None
    )

