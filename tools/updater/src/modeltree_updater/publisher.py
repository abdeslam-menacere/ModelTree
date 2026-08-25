"""Turn an audited proposal into exactly one open GitHub issue per creator.

Three rules define this module, and each exists because its opposite is a way to
lose information a reviewer needs:

**Only publish something material.** A run that found nothing has nothing to say.
A no-change creator produces no issue and makes *no* GitHub request at all — not
even a read — so a quiet week leaves no noise to wade through. An earlier open
proposal is left exactly as it is: whether a stale proposal should be closed is a
human's judgment, and closing it would destroy the review context it holds.

**One issue per creator, identified by its first line.** Identity is a hidden
marker that must be the *canonical first line* of the body, compared for equality.
It is never searched for as a substring: the rest of the body is proposal content
— claims, quotes, reviewer prose — and content that happens to look like another
creator's marker must never redirect an update onto that creator's issue.

**Never make a destructive write.** If more than one open issue carries a
creator's marker, the lowest-numbered one is canonical and gets the update; the
others are reported loudly, in the CLI output and in the body this run writes, and
are left open. The Issues API has no conditional write, so "check it is still the
proposal, then close it" is a race the tool cannot win — between the check and the
close, an issue can be edited into something else entirely. Duplicates are instead
*prevented* by the repository-global concurrency group on the publication
workflow, and *reported* if they appear anyway.

**Never replace a body without a trace.** An update overwrites the previous run's
evidence wholesale, and a reviewer who was reading it would otherwise have no way
to see that anything was replaced. So before a body written by a *different* run
is overwritten, that run is recorded in a comment — its id and its material
counts — and the new body names it in the header table. The comment is filed
before the rewrite, not after: it exists to survive the thing it describes. If the
body being replaced cannot be read, the comment says exactly that instead of
guessing at counts or staying quiet.

Rendering is deterministic: the body is a pure function of the proposal, any
duplicate issue numbers, and the run it supersedes, with no render-time clock and
no local file paths, so a `--dry-run` prints byte-for-byte what a real publication
would send. Re-rendering the *same* run carries the earlier supersession forward
unchanged, so a repeated publication is byte-identical and adds no comment.

Determinism covers *measured* time as well as render time. Elapsed seconds are
still measured and still enforced — the ledger stops a run that overruns — but
the measurement is not printed. Two surfaces carry it and both are rendered from
structure rather than from a measured number: the budget table, and the failure a
stopped run records, where `BudgetExhausted` puts the elapsed time in its message
*and* in its detail. Elapsed time is a property of the run, and two executions of
one run differ by a timer tick, so printing it would make every re-render a
spurious edit whose diff says nothing about the data. The run artefact keeps the
measurement; this body is the proposal.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Sequence

from .contracts import (
    ClaimAdjudication,
    ClaimCandidate,
    ClaimDecision,
    CreatorProposal,
    FailureKind,
    ProposalStatus,
    RunFailure,
    RunReport,
)
from .github_issues import MAX_BODY_CHARS, Issue, IssuesClient

__all__ = [
    "IssuePayload",
    "MARKER_VERSION",
    "PriorState",
    "PublicationAction",
    "PublicationError",
    "PublicationFailure",
    "PublicationOutcome",
    "PublicationReport",
    "STATE_VERSION",
    "UNREADABLE_RUN",
    "find_open_proposals",
    "identity_marker",
    "is_material",
    "issue_title",
    "matches_identity",
    "publish_proposal",
    "publish_report",
    "read_state",
    "render_body",
    "render_issue",
    "state_marker",
    "supersession_comment",
]

MARKER_VERSION = "v1"
STATE_VERSION = "v1"

# A creator id reaches both the hidden marker and the issue title, so it is
# checked rather than interpolated on trust: an id carrying `-->` could otherwise
# close the marker comment early and forge a second identity inside one body.
CREATOR_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

# A run id reaches the state marker for the same reason, so it gets the same
# treatment. The character set excludes `>` and whitespace, so no value that
# passes can terminate the comment it is written into.
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# What the body prints where a measured wall-clock value would otherwise go. The
# emphasised form is for a table cell, where markdown emphasis renders; the plain
# form is for the inside of a JSON string and of a sentence, where it does not.
NOT_RENDERED_TEXT = "not rendered"
NOT_RENDERED = f"_{NOT_RENDERED_TEXT}_"

# The one budget whose "used" value is measured rather than counted, and so the
# one whose value differs between two executions of the same run. Pages, tokens
# and retries are counters and are rendered exactly.
MEASURED_RESOURCE = "seconds"

# Sentinels for the `supersedes=` field of the state marker. Neither can be a
# valid run id, so neither can be confused with one.
NO_SUPERSEDED_RUN = "-"
UNREADABLE_RUN = "?"


class PublicationError(RuntimeError):
    """A proposal cannot be published as written."""


class PublicationAction(str, Enum):
    CREATED = "created"
    UPDATED = "updated"
    # A dry run: the exact payload was produced and nothing was sent.
    RENDERED = "rendered"
    # Nothing material to say; deliberately no GitHub request was made.
    SKIPPED_NO_CHANGE = "skipped-no-change"


@dataclass(frozen=True)
class IssuePayload:
    """Exactly what would be sent to GitHub."""

    title: str
    body: str


@dataclass(frozen=True)
class PublicationOutcome:
    creator_id: str
    action: PublicationAction
    payload: IssuePayload | None = None
    issue_number: int | None = None
    duplicates: tuple[int, ...] = ()
    # The run whose body this update replaced, recorded in a comment before the
    # rewrite. `UNREADABLE_RUN` means a body was replaced but could not be read.
    superseded_run: str | None = None


@dataclass(frozen=True)
class PublicationFailure:
    """One creator could not be published. The others still were."""

    creator_id: str
    message: str


@dataclass(frozen=True)
class PublicationReport:
    outcomes: tuple[PublicationOutcome, ...] = ()
    failures: tuple[PublicationFailure, ...] = field(default_factory=tuple)

    @property
    def issue_numbers(self) -> tuple[int, ...]:
        return tuple(
            outcome.issue_number
            for outcome in self.outcomes
            if outcome.issue_number is not None
        )


# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------


def _checked_creator_id(creator_id: str) -> str:
    if not CREATOR_ID.match(creator_id or ""):
        raise PublicationError(
            f"refusing to publish a proposal for creator id {creator_id!r}: expected "
            "lowercase letters, digits, dot, underscore, or hyphen"
        )
    return creator_id


def _checked_run_id(run_id: str) -> str:
    if not RUN_ID.match(run_id or ""):
        raise PublicationError(
            f"refusing to publish a proposal for run id {run_id!r}: expected letters, "
            "digits, dot, underscore, or hyphen"
        )
    return run_id


def identity_marker(creator_id: str) -> str:
    """The stable proposal identity, and the only thing that identifies an issue."""
    return f"<!-- modeltree-proposal: {MARKER_VERSION} creator={_checked_creator_id(creator_id)} -->"


def issue_title(creator_id: str) -> str:
    return f"ModelTree proposal: {_checked_creator_id(creator_id)}"


def matches_identity(body: str | None, creator_id: str) -> bool:
    """True only when the *first* line of the body is exactly this creator's marker.

    Anchored on purpose. A substring match would let one creator's rendered claims
    or quotes — which are attacker-influenced content from a fetched page — carry
    another creator's marker and steer this run's update onto the wrong issue.
    """
    first_line = (body or "").partition("\n")[0]
    return first_line.strip() == identity_marker(creator_id)


def find_open_proposals(issues: Iterable[Issue], creator_id: str) -> tuple[Issue, ...]:
    """Open issues carrying this creator's identity, lowest number first.

    The lowest number is the canonical proposal: it is the oldest, it holds the
    longest review history, and picking it is deterministic for every publisher.
    """
    matches = [
        issue
        for issue in issues
        if issue.state == "open" and matches_identity(issue.body, creator_id)
    ]
    return tuple(sorted(matches, key=lambda issue: issue.number))


# ---------------------------------------------------------------------------
# supersession state
# ---------------------------------------------------------------------------

# Written as line 2 of every body, immediately under the identity marker. The
# visible header table names the superseded run for a human; this line is what
# the *next* run reads, so it is a strict machine format rather than something
# recovered by parsing rendered markdown — a body's summary must not depend on
# how a table happens to be formatted.
_STATE = re.compile(
    r"^<!--\s*modeltree-run:\s*v1\s+"
    r"run=(?P<run>[A-Za-z0-9][A-Za-z0-9._-]*)\s+"
    r"supersedes=(?P<supersedes>[-?]|[A-Za-z0-9][A-Za-z0-9._-]*)\s+"
    r"claims=(?P<claims>\d+)\s+"
    r"accepted=(?P<accepted>\d+)\s+"
    r"conflicts=(?P<conflicts>\d+)\s+"
    r"failures=(?P<failures>\d+)\s*-->$"
)


@dataclass(frozen=True)
class PriorState:
    """What the body about to be overwritten said about itself."""

    run_id: str
    supersedes: str | None
    claims: int
    accepted: int
    conflicts: int
    failures: int


def _supersedes_token(supersedes: str | None) -> str:
    if supersedes is None:
        return NO_SUPERSEDED_RUN
    if supersedes == UNREADABLE_RUN:
        return UNREADABLE_RUN
    return _checked_run_id(supersedes)


def state_marker(proposal: CreatorProposal, supersedes: str | None = None) -> str:
    """The machine-readable summary of this body, for the run that replaces it."""
    return (
        f"<!-- modeltree-run: {STATE_VERSION} "
        f"run={_checked_run_id(proposal.run_id)} "
        f"supersedes={_supersedes_token(supersedes)} "
        f"claims={len(proposal.claims)} "
        f"accepted={len(proposal.accepted_claim_ids)} "
        f"conflicts={len(proposal.conflicts)} "
        f"failures={len(proposal.failures)} -->"
    )


def read_state(body: str | None) -> PriorState | None:
    """The state this tool wrote into a body, or `None` if it cannot be read.

    Anchored to the second line for the same reason identity is anchored to the
    first: proposal content is attacker-influenced text, and a quoted page that
    happens to contain a state marker must not be able to describe the issue.

    `None` means "this body was not written by this tool, or was hand-edited, or
    came from a format this version does not know" — all of which are reported as
    unreadable rather than guessed at.
    """
    lines = (body or "").split("\n")
    if len(lines) < 2:
        return None
    match = _STATE.match(lines[1].strip())
    if match is None:
        return None
    supersedes = match.group("supersedes")
    return PriorState(
        run_id=match.group("run"),
        supersedes=None if supersedes == NO_SUPERSEDED_RUN else supersedes,
        claims=int(match.group("claims")),
        accepted=int(match.group("accepted")),
        conflicts=int(match.group("conflicts")),
        failures=int(match.group("failures")),
    )


def _supersedes_for(prior: PriorState | None, run_id: str) -> str | None:
    """What this run's body should name as the run it replaced.

    Re-rendering the same run must not disturb the record: the earlier
    supersession is carried forward unchanged so the body stays byte-identical
    and no second comment is filed.
    """
    if prior is None:
        return UNREADABLE_RUN
    if prior.run_id == run_id:
        return prior.supersedes
    return prior.run_id


# ---------------------------------------------------------------------------
# materiality
# ---------------------------------------------------------------------------


def is_material(proposal: CreatorProposal) -> bool:
    """Whether this proposal is worth a human's attention.

    Any candidate claim counts — including one the panel rejected or a gate
    vetoed, because "we looked and refused it" is a reviewable outcome and hiding
    it would make the refusal invisible. Conflicts, failures, and any status other
    than `complete` count too. Only a complete run that produced nothing at all is
    silent.
    """
    return bool(
        proposal.claims
        or proposal.conflicts
        or proposal.failures
        or proposal.status is not ProposalStatus.COMPLETE
    )


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------


def _cell(value: Any) -> str:
    """One markdown table cell: never breaks the row, never ends the table."""
    text = "" if value is None else str(value)
    return (
        text.replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("\r\n", "<br>")
        .replace("\r", "<br>")
        .replace("\n", "<br>")
    )


def _code(value: Any) -> str:
    """Inline code that survives backticks in the value."""
    text = _cell(value)
    if not text:
        return ""
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{fence}{pad}{text}{pad}{fence}"


def _value(value: Any) -> str:
    """A claim value rendered exactly, whatever JSON type it is."""
    return _code(json.dumps(value, sort_keys=True, ensure_ascii=False))


def _quote(text: str) -> list[str]:
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return [f"> {line}" if line else ">" for line in lines]


def _table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> list[str]:
    if not rows:
        return []
    return [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join("---" for _ in headers) + "|",
        *["| " + " | ".join(row) + " |" for row in rows],
    ]


def _votes(accept: int, reject: int, abstain: int) -> str:
    return f"{accept} accept / {reject} reject / {abstain} abstain"


def _joined(values: Sequence[str]) -> str:
    return ", ".join(_code(value) for value in values) if values else "—"


@dataclass(frozen=True)
class _Section:
    key: str
    heading: str
    lines: tuple[str, ...]
    # Sections are dropped in this order when a proposal is too large for one
    # issue body. `None` means never dropped: the reader must always be told the
    # status, the conflicts, the budget, and what was omitted.
    drop_rank: int | None
    entries: int


def _adjudication_index(
    proposal: CreatorProposal,
) -> dict[str, ClaimAdjudication]:
    return {item.claim_id: item for item in proposal.adjudications}


def _binding_decision(
    claim: ClaimCandidate, adjudications: dict[str, ClaimAdjudication]
) -> ClaimDecision | None:
    adjudication = adjudications.get(claim.id)
    return adjudication.decision if adjudication else None


def _patch_section(proposal: CreatorProposal) -> _Section:
    adjudications = _adjudication_index(proposal)
    accepted_ids = set(proposal.accepted_claim_ids)
    accepted = [claim for claim in proposal.claims if claim.id in accepted_ids]
    rejected = [claim for claim in proposal.claims if claim.id not in accepted_ids]

    lines: list[str] = [
        "Suggested changes, as logical operations on ModelTree entities. They are "
        "**not applied**: this tool proposes, a human decides, and the change lands "
        "through the normal reviewed path.",
        "",
    ]

    if accepted:
        lines += ["### Accepted candidates", ""]
        lines += _table(
            ["Entity kind", "Entity id", "Field", "Proposed value", "Claim", "Confidence"],
            [
                [
                    _code(claim.entity_kind.value),
                    _code(claim.entity_id),
                    _code(claim.field_path),
                    _value(claim.value),
                    _code(claim.id),
                    f"{claim.confidence:.2f}",
                ]
                for claim in accepted
            ],
        )
        operations = [
            {
                "claim_id": claim.id,
                "entity_kind": claim.entity_kind.value,
                "entity_id": claim.entity_id,
                "field_path": claim.field_path,
                "value": claim.value,
            }
            for claim in accepted
        ]
        lines += [
            "",
            "```json",
            json.dumps(operations, indent=2, ensure_ascii=False),
            "```",
        ]
    else:
        lines += ["No candidate was accepted in this run.", ""]

    if rejected:
        escalated = [
            claim
            for claim in rejected
            if _binding_decision(claim, adjudications) is ClaimDecision.NEEDS_HUMAN_REVIEW
        ]
        lines += ["", "### Candidates not accepted", ""]
        if escalated:
            lines += [
                f"{len(escalated)} of these are **`needs-human-review`**: the panel "
                "did not reach this run's threshold, so nothing was decided and "
                "nothing was guessed. They are open questions, not refusals — the "
                "binding decision column below says which is which.",
                "",
            ]
        lines += _table(
            ["Claim", "Entity", "Field", "Value", "Binding decision", "Vetoed by"],
            [
                [
                    _code(claim.id),
                    _code(f"{claim.entity_kind.value}:{claim.entity_id}"),
                    _code(claim.field_path),
                    _value(claim.value),
                    _cell(
                        (decision.value if (decision := _binding_decision(claim, adjudications)) else "not adjudicated")
                    ),
                    _joined(
                        adjudications[claim.id].vetoed_by
                        if claim.id in adjudications
                        else ()
                    ),
                ]
                for claim in rejected
            ],
        )

    return _Section(
        key="candidate-patch",
        heading="Candidate patch",
        lines=tuple(lines),
        drop_rank=5,
        entries=len(proposal.claims),
    )


def _evidence_section(proposal: CreatorProposal) -> _Section:
    lines: list[str] = [
        "Every claim with the exact words it rests on, the source that served them, "
        "the hash of the bytes read, and the date it was verified.",
        "",
    ]
    if not proposal.claims:
        lines.append("No claim was extracted in this run.")
    for claim in proposal.claims:
        lines += [
            f"### {_code(claim.id)} — {_code(claim.entity_kind.value + ':' + claim.entity_id)} "
            f"· {_code(claim.field_path)}",
            "",
            f"Proposed value: {_value(claim.value)} · extracted by {_code(claim.extractor)} "
            f"at {_code(claim.extracted_at)} · confidence {claim.confidence:.2f}",
            "",
        ]
        if not claim.evidence:
            lines += ["_No evidence was attached to this claim._", ""]
        for evidence in claim.evidence:
            lines += [
                f"- source {_code(evidence.source_id)} — <{evidence.url}> "
                f"(verified {_code(evidence.verified_at)}, content hash "
                f"{_code(evidence.content_hash)})",
                "",
            ]
            lines += _quote(evidence.quote)
            lines += [""]
    return _Section(
        key="evidence",
        heading="Atomic evidence",
        lines=tuple(lines),
        drop_rank=1,
        entries=sum(len(claim.evidence) for claim in proposal.claims),
    )


def _source_section(proposal: CreatorProposal) -> _Section:
    lines: list[str] = ["### Sources read", ""]
    lines += _table(
        ["Source", "Title", "Publisher", "Kind", "Published", "URL"],
        [
            [
                _code(source.id),
                _cell(source.title),
                _cell(source.publisher),
                _code(source.kind.value),
                _cell(source.published_date or "unknown"),
                f"<{source.url}>",
            ]
            for source in proposal.sources
        ],
    ) or ["No source was read in this run.", ""]

    if proposal.source_approvals:
        lines += ["", "### Source decisions", ""]
        lines += _table(
            ["Source", "Newly discovered", "Approved", "Votes", "Vetoed by", "Rationale"],
            [
                [
                    _code(approval.source_id),
                    "yes" if approval.newly_discovered else "no",
                    "yes" if approval.approved else "**no**",
                    _cell(
                        _votes(
                            approval.accept_votes,
                            approval.reject_votes,
                            approval.abstain_votes,
                        )
                    ),
                    _joined(approval.vetoed_by),
                    _cell(approval.rationale),
                ]
                for approval in proposal.source_approvals
            ],
        )
        source_verdicts = [
            (approval.source_id, verdict)
            for approval in proposal.source_approvals
            for verdict in approval.verdicts
        ]
        if source_verdicts:
            lines += ["", "#### Reviewer verdicts on sources", ""]
            lines += _table(
                ["Source", "Lens", "Reviewer", "Decision", "Rationale"],
                [
                    [
                        _code(source_id),
                        _code(verdict.lens.value if verdict.lens else "unattributed"),
                        _code(verdict.reviewer),
                        _cell(verdict.decision.value),
                        _cell(verdict.rationale),
                    ]
                    for source_id, verdict in source_verdicts
                ],
            )
    return _Section(
        key="source-decisions",
        heading="Sources and source decisions",
        lines=tuple(lines),
        drop_rank=4,
        entries=len(proposal.sources) + len(proposal.source_approvals),
    )


def _verdict_section(proposal: CreatorProposal) -> _Section:
    lines: list[str] = [
        "Every reviewer verdict is kept, including the dissenting ones. "
        "`Panel` is what the three semantic lenses concluded; `binding` is what "
        "actually decided the claim after the deterministic gates ran.",
        "",
    ]
    if proposal.adjudications:
        lines += ["### Adjudications", ""]
        lines += _table(
            ["Claim", "Panel", "Binding", "Votes", "Unanimous", "Vetoed by", "Rationale"],
            [
                [
                    _code(item.claim_id),
                    _cell(item.semantic_decision.value),
                    _cell(item.decision.value),
                    _cell(
                        _votes(item.accept_votes, item.reject_votes, item.abstain_votes)
                    ),
                    "yes" if item.unanimous else "no",
                    _joined(item.vetoed_by),
                    _cell(item.rationale),
                ]
                for item in proposal.adjudications
            ],
        )
    if proposal.verdicts:
        lines += ["", "### Individual verdicts", ""]
        lines += _table(
            ["Claim", "Lens", "Reviewer", "Decision", "Evidence cited", "Rationale"],
            [
                [
                    _code(verdict.claim_id),
                    _code(verdict.lens.value if verdict.lens else "unattributed"),
                    _code(verdict.reviewer),
                    _cell(verdict.decision.value),
                    _joined(verdict.evidence_refs),
                    _cell(verdict.rationale),
                ]
                for verdict in proposal.verdicts
            ],
        )
    if not proposal.adjudications and not proposal.verdicts:
        lines.append("No claim reached review in this run.")
    return _Section(
        key="reviewer-verdicts",
        heading="Reviewer verdicts",
        lines=tuple(lines),
        drop_rank=2,
        entries=len(proposal.verdicts) + len(proposal.adjudications),
    )


def _validation_section(proposal: CreatorProposal) -> _Section:
    lines: list[str] = [
        "Objective checks. A failed gate is a veto no reviewer majority can "
        "overturn, and there is no way to waive one.",
        "",
    ]
    if proposal.gates:
        lines += ["### Deterministic gates", ""]
        lines += _table(
            ["Gate", "Subject", "Status", "Issues"],
            [
                [
                    _code(gate.gate),
                    _code(f"{gate.subject_kind}:{gate.subject_id}"),
                    "**failed**" if gate.failed else _cell(gate.status.value),
                    _cell("; ".join(gate.issues) if gate.issues else "—"),
                ]
                for gate in proposal.gates
            ],
        )
    if proposal.validations:
        lines += ["", "### Schema validation", ""]
        lines += _table(
            ["Claim", "Status", "Issues"],
            [
                [
                    _code(result.claim_id),
                    _cell(result.status.value),
                    _cell("; ".join(result.issues) if result.issues else "—"),
                ]
                for result in proposal.validations
            ],
        )
    if not proposal.gates and not proposal.validations:
        lines.append("Nothing reached deterministic validation in this run.")
    return _Section(
        key="validation",
        heading="Deterministic validation",
        lines=tuple(lines),
        drop_rank=3,
        entries=len(proposal.gates) + len(proposal.validations),
    )


def _conflict_section(proposal: CreatorProposal) -> _Section:
    if proposal.conflicts:
        lines = [
            "Contradictions are recorded, never resolved. Nothing here picks a winner.",
            "",
            *_table(
                ["Conflict", "Kind", "Entity", "Field", "Claims", "Values"],
                [
                    [
                        _code(conflict.id),
                        _cell(conflict.kind.value),
                        _code(f"{conflict.entity_kind.value}:{conflict.entity_id}"),
                        _code(conflict.field_path),
                        _joined(conflict.claim_ids),
                        _cell(
                            " vs ".join(
                                json.dumps(value, sort_keys=True, ensure_ascii=False)
                                for value in conflict.values
                            )
                        ),
                    ]
                    for conflict in proposal.conflicts
                ],
            ),
        ]
    else:
        lines = ["No conflict was detected in this run."]
    return _Section(
        key="conflicts",
        heading="Conflicts",
        lines=tuple(lines),
        drop_rank=None,
        entries=len(proposal.conflicts),
    )


def _budget_section(proposal: CreatorProposal) -> _Section:
    budget = proposal.budget
    lines = _table(
        ["Resource", "Used", "Limit"],
        [
            ["pages", str(budget.pages_fetched), str(budget.max_pages)],
            ["tokens", str(budget.tokens_used), str(budget.max_tokens)],
            # Measured and enforced, deliberately not rendered. Elapsed time is
            # the one budget whose "used" value differs between two executions of
            # the same run, so printing it here would make every re-render an
            # edit. The limit stays, because a run stopped by it has to be
            # readable against something. The note below says so in the body.
            ["seconds", NOT_RENDERED, f"{budget.max_seconds:g}"],
            ["retries", str(budget.retries_used), str(budget.max_retries)],
        ],
    )
    lines += [""]
    if budget.exhausted_by:
        lines.append(
            "**Exhausted:** "
            + _joined(budget.exhausted_by)
            + ". Coverage is partial — this is not the same as "
            "\"there was nothing to find\"."
        )
    else:
        lines.append("No budget was exhausted.")
    lines += [
        "",
        "Elapsed time is measured and enforced — a run that reaches its seconds "
        "limit is stopped, and the failures table below records the limit it "
        "was stopped at — but the measurement itself is not printed, here or "
        "there. It is a property of the run, not of the proposal, and two "
        "executions of the same run differ by a timer tick, so a number would "
        "make every re-render of this issue a spurious edit. The run artefact "
        f"for run {_code(proposal.run_id)} "
        f"({_code(proposal.creator_id + '.json')}) records the measured value.",
    ]
    return _Section(
        key="budget",
        heading="Budget usage",
        lines=tuple(lines),
        drop_rank=None,
        entries=1,
    )


def _failure_row(failure: RunFailure) -> list[str]:
    """One row of the failures table, carrying no measured wall-clock value.

    A run stopped by the seconds limit records the measured elapsed time twice —
    `BudgetExhausted` puts it in its message *and* in its detail's `used` field —
    so the failures table is a second way for the clock to reach the body, and it
    churns for exactly the reason the budget table did: two executions of one
    overrunning run stop a timer tick apart and print different numbers.

    Such a failure is therefore rendered from its *structure*, not from its
    recorded text. Editing the recorded message instead would be worse than it
    looks: the measured value and the limit can be equal, and one is a substring
    of the other besides, so removing the measurement by substring can silently
    take the limit with it.

    Both values in the rebuilt sentence come from the failure itself, never from
    the proposal's budget. Those two disagree whenever a run is resumed: `resume`
    takes no budget flags, so the resumed proposal carries the default limit
    while the failure carries the one actually enforced when the run stopped. The
    failure is the record of what happened, so it is the only truthful source —
    and reading the limit from beside the measurement keeps this cell and the
    JSON cell next to it from contradicting each other.

    Only `seconds` is treated this way. Pages, tokens and retries are counters,
    a reviewer needs their exact values, and they are rendered verbatim.

    This happens here and not where the failure is built, because the run
    artefact has to keep the measurement. The issue is what gets rendered, not
    what gets measured.
    """
    message = failure.message
    detail = dict(failure.detail)
    if (
        failure.kind is FailureKind.BUDGET_EXHAUSTED
        and detail.get("resource") == MEASURED_RESOURCE
    ):
        limit = detail.get("limit")
        stated = (
            f"its {limit:g} second limit"
            if isinstance(limit, (int, float)) and not isinstance(limit, bool)
            else "its seconds budget"
        )
        # "reached", not "passed": `check_time` exhausts on `>=`, so a run that
        # lands exactly on its limit is stopped without ever exceeding it.
        message = (
            f"{MEASURED_RESOURCE} budget exhausted: this run reached {stated} "
            f"and was stopped. The measured elapsed time is "
            f"{NOT_RENDERED_TEXT} here."
        )
        if "used" in detail:
            detail["used"] = NOT_RENDERED_TEXT
    return [
        _code(failure.stage.value),
        _code(failure.kind.value),
        "yes" if failure.retryable else "no",
        _cell(message),
        _cell(
            json.dumps(detail, sort_keys=True, ensure_ascii=False) if detail else "—"
        ),
    ]


def _completion_section(proposal: CreatorProposal) -> _Section:
    lines = [f"**Status: {proposal.status.value}**", ""]
    if proposal.status is ProposalStatus.COMPLETE:
        lines.append("The run finished every stage for this creator.")
    else:
        lines.append(
            "This creator's run did **not** finish cleanly. What follows is "
            "partial, and the failures below say why."
        )
    if proposal.failures:
        lines += ["", "### Failures", ""]
        lines += _table(
            ["Stage", "Kind", "Retryable", "Message", "Detail"],
            [_failure_row(failure) for failure in proposal.failures],
        )
    if proposal.notes:
        lines += ["", "### Notes", ""]
        lines += [f"- {_cell(note)}" for note in proposal.notes]
    return _Section(
        key="completion",
        heading="Completion status",
        lines=tuple(lines),
        drop_rank=None,
        entries=len(proposal.failures),
    )


def _promotion_section(proposal: CreatorProposal) -> _Section:
    """Rendered only for a creator processed under the generic long-tail profile."""
    promotion = proposal.promotion
    assert promotion is not None  # only built when there is one
    verdict = (
        "**A dedicated profile is recommended for this creator.**"
        if promotion.recommended
        else "**No dedicated profile is recommended for this creator on this run.**"
    )
    lines = [
        "This creator has no reviewed dedicated profile, so it was processed under "
        f"the generic profile {_code(promotion.profile_id)} and every claim and "
        "newly discovered source needed all three reviewers, not two.",
        "",
        verdict,
        "",
        _cell(promotion.rationale),
        "",
        *_table(
            ["Criterion", "Observed", "Threshold", "Met", "Why it matters"],
            [
                [
                    _code(criterion.id),
                    str(criterion.observed),
                    str(criterion.threshold),
                    "yes" if criterion.met else "no",
                    _cell(criterion.description),
                ]
                for criterion in promotion.criteria
            ],
        ),
        "",
        _cell(promotion.next_step),
    ]
    return _Section(
        key="promotion",
        heading="Profile and promotion",
        lines=tuple(lines),
        drop_rank=None,
        entries=len(promotion.criteria),
    )


def _sections(proposal: CreatorProposal) -> tuple[_Section, ...]:
    sections = [
        _patch_section(proposal),
        _evidence_section(proposal),
        _source_section(proposal),
        _verdict_section(proposal),
        _validation_section(proposal),
        _conflict_section(proposal),
    ]
    # Absent for a creator with a reviewed dedicated profile, so those bodies are
    # unchanged. There is no equivalent "promote" section to omit for them.
    if proposal.promotion is not None:
        sections.append(_promotion_section(proposal))
    sections += [
        _budget_section(proposal),
        _completion_section(proposal),
    ]
    return tuple(sections)


def _header(proposal: CreatorProposal, supersedes: str | None) -> list[str]:
    providers = (
        ", ".join(f"{name}={value}" for name, value in sorted(proposal.providers.items()))
        or "unrecorded"
    )
    if supersedes is None:
        superseded_cell = "—"
    elif supersedes == UNREADABLE_RUN:
        superseded_cell = "_a body that could not be read — see the note below_"
    else:
        superseded_cell = _code(supersedes)
    return [
        identity_marker(proposal.creator_id),
        state_marker(proposal, supersedes),
        f"# {issue_title(proposal.creator_id)}",
        "",
        "A proposal from the source-backed ModelTree updater. **Nothing here has "
        "been applied.** The tool cannot write dataset files, create a branch, or "
        "open a pull request; this issue is the whole of its output.",
        "",
        *_table(
            ["", ""],
            [
                ["Creator", _code(proposal.creator_id)],
                ["Run", _code(proposal.run_id)],
                ["Supersedes run", superseded_cell],
                ["Generated at", _code(proposal.generated_at)],
                ["Completion status", f"**{proposal.status.value}**"],
                ["Providers", _cell(providers)],
                *(
                    [["Review policy", _cell(proposal.review_policy.decision_label)]]
                    if proposal.review_policy is not None
                    else []
                ),
                ["Candidate claims", str(len(proposal.claims))],
                ["Accepted", str(len(proposal.accepted_claim_ids))],
                ["Conflicts", str(len(proposal.conflicts))],
                ["Failures", str(len(proposal.failures))],
            ],
        ),
    ]


def _omission_notice(section: _Section, proposal: CreatorProposal) -> tuple[str, ...]:
    return (
        f"_Omitted: {section.entries} entr{'y' if section.entries == 1 else 'ies'}. "
        "This proposal is larger than a GitHub issue body can hold. The complete "
        f"record is in the run artefact for run {_code(proposal.run_id)} "
        f"({_code(proposal.creator_id + '.json')})._",
    )


def _publication_notes(
    duplicates: Sequence[int],
    dropped: Sequence[_Section],
    proposal: CreatorProposal,
    supersedes: str | None,
) -> list[str]:
    unreadable = supersedes == UNREADABLE_RUN
    if not duplicates and not dropped and not unreadable:
        return []
    lines = ["## Publication notes", ""]
    if unreadable:
        lines += [
            "> [!WARNING]",
            "> This run replaced a body it could not read: the previous body did not "
            "carry the state marker this tool writes, so it was hand-edited or "
            "produced by an older version. Its run id and counts are unknown and are "
            "not guessed at here. A comment filed just before the rewrite records "
            "that the replacement happened.",
            "",
        ]
    if duplicates:
        lines += [
            "> [!WARNING]",
            "> More than one open issue carries this creator's proposal identity. "
            f"This issue is the canonical one (lowest number); {', '.join('#' + str(number) for number in duplicates)} "
            "also matched and were **left open and untouched**. A human should close "
            "the duplicates. Nothing is closed automatically, because an issue can be "
            "edited between the check and the close.",
            "",
        ]
    if dropped:
        lines += [
            "The following sections were omitted to fit a GitHub issue body: "
            + ", ".join(_code(section.heading) for section in dropped)
            + ". The run artefact holds them in full.",
            "",
        ]
    return lines


def _assemble(
    proposal: CreatorProposal,
    sections: Sequence[_Section],
    *,
    dropped_keys: Sequence[str],
    duplicates: Sequence[int],
    supersedes: str | None,
) -> str:
    dropped = [section for section in sections if section.key in dropped_keys]
    lines = _header(proposal, supersedes)
    for section in sections:
        body = (
            _omission_notice(section, proposal)
            if section.key in dropped_keys
            else section.lines
        )
        lines += ["", f"## {section.heading}", "", *body]
    lines += ["", *_publication_notes(duplicates, dropped, proposal, supersedes)]
    return "\n".join(lines).rstrip() + "\n"


def _hard_truncate(body: str) -> str:
    notice = (
        "\n\n---\n_This body was truncated to fit GitHub's issue size limit. The "
        "run artefact holds the complete proposal._\n"
    )
    return body[: MAX_BODY_CHARS - len(notice)] + notice


def render_body(
    proposal: CreatorProposal,
    *,
    duplicates: Sequence[int] = (),
    supersedes: str | None = None,
) -> str:
    """The exact issue body for this proposal. A pure function of its inputs."""
    sections = _sections(proposal)
    droppable = [
        section.key
        for section in sorted(
            (section for section in sections if section.drop_rank is not None),
            key=lambda section: section.drop_rank or 0,
        )
    ]
    dropped: list[str] = []
    while True:
        body = _assemble(
            proposal,
            sections,
            dropped_keys=dropped,
            duplicates=duplicates,
            supersedes=supersedes,
        )
        if len(body) <= MAX_BODY_CHARS:
            return body
        if len(dropped) == len(droppable):
            return _hard_truncate(body)
        dropped.append(droppable[len(dropped)])


def render_issue(
    proposal: CreatorProposal,
    *,
    duplicates: Sequence[int] = (),
    supersedes: str | None = None,
) -> IssuePayload:
    return IssuePayload(
        title=issue_title(proposal.creator_id),
        body=render_body(proposal, duplicates=duplicates, supersedes=supersedes),
    )


def supersession_comment(
    proposal: CreatorProposal, prior: PriorState | None
) -> str:
    """The record filed before a body written by another run is overwritten."""
    lines = [
        f"### Run {_code(proposal.run_id)} is replacing this issue's body",
        "",
        "Filed before the rewrite, so the run being replaced is not lost with it. "
        "This issue always holds the newest run only; once the body above is "
        "overwritten this tool cannot recover what it said.",
        "",
    ]
    if prior is None:
        lines += [
            "> [!WARNING]",
            "> **The body being replaced could not be read.** It did not carry the "
            "state marker this tool writes, so it was hand-edited or produced by an "
            "older version. Its run id and its counts are unknown, and are not "
            "guessed at here.",
        ]
    else:
        lines += [
            f"It held run {_code(prior.run_id)}, which reported:",
            "",
            *_table(
                ["", ""],
                [
                    ["Candidate claims", str(prior.claims)],
                    ["Accepted", str(prior.accepted)],
                    ["Conflicts", str(prior.conflicts)],
                    ["Failures", str(prior.failures)],
                ],
            ),
            "",
            f"The complete record of run {_code(prior.run_id)} — its evidence, "
            "verdicts, and validation — is in that run's artefact "
            f"({_code(proposal.creator_id + '.json')}). Only the counts above are "
            "kept here.",
        ]
    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------------------
# publication
# ---------------------------------------------------------------------------


def publish_proposal(
    proposal: CreatorProposal, client: IssuesClient
) -> PublicationOutcome:
    """Create or update this creator's single open proposal issue."""
    if not is_material(proposal):
        return PublicationOutcome(
            creator_id=proposal.creator_id,
            action=PublicationAction.SKIPPED_NO_CHANGE,
        )

    existing = find_open_proposals(client.list_open_issues(), proposal.creator_id)
    duplicates = tuple(issue.number for issue in existing[1:])

    if not existing:
        payload = render_issue(proposal, duplicates=duplicates)
        created = client.create_issue(title=payload.title, body=payload.body)
        return PublicationOutcome(
            creator_id=proposal.creator_id,
            action=PublicationAction.CREATED,
            payload=payload,
            issue_number=created.number,
        )

    canonical = existing[0]
    prior = read_state(canonical.body)
    replacing = prior is None or prior.run_id != proposal.run_id
    supersedes = _supersedes_for(prior, proposal.run_id)
    payload = render_issue(
        proposal, duplicates=duplicates, supersedes=supersedes
    )

    if replacing:
        # Before the overwrite, never after. If the update below fails, an
        # accurate record of what this run was about to replace still exists and
        # the failure is reported; if the order were reversed, a failed comment
        # would leave the previous run's evidence gone with nothing to show for
        # it — the one outcome this is here to prevent.
        client.create_comment(
            canonical.number, body=supersession_comment(proposal, prior)
        )

    updated = client.update_issue(
        canonical.number, title=payload.title, body=payload.body
    )
    return PublicationOutcome(
        creator_id=proposal.creator_id,
        action=PublicationAction.UPDATED,
        payload=payload,
        issue_number=updated.number,
        duplicates=duplicates,
        superseded_run=supersedes if replacing else None,
    )


def publish_report(
    report: RunReport,
    client: IssuesClient | None = None,
    *,
    dry_run: bool = False,
) -> PublicationReport:
    """Publish every material creator in a run, continuing past a failure.

    One creator failing to publish must not silence the others: each is handled
    independently and a failure is recorded, exactly as the run itself treats a
    creator that could not finish.
    """
    if not dry_run and client is None:
        raise PublicationError("publishing needs an issues client; pass dry_run=True to render only")

    outcomes: list[PublicationOutcome] = []
    failures: list[PublicationFailure] = []
    for proposal in report.proposals:
        try:
            if dry_run:
                outcomes.append(_render_only(proposal))
            else:
                assert client is not None  # guarded above
                outcomes.append(publish_proposal(proposal, client))
        except Exception as error:  # noqa: BLE001 - one creator must not sink the run
            failures.append(
                PublicationFailure(
                    creator_id=proposal.creator_id,
                    message=f"{type(error).__name__}: {error}",
                )
            )
    return PublicationReport(outcomes=tuple(outcomes), failures=tuple(failures))


def _render_only(proposal: CreatorProposal) -> PublicationOutcome:
    """A dry run: the exact payload, produced without touching GitHub.

    Nothing is read, so nothing is known about an existing issue: no duplicates
    can be reported and no superseded run can be named. The CLI says so rather
    than letting a clean dry run read as evidence that neither exists.
    """
    if not is_material(proposal):
        return PublicationOutcome(
            creator_id=proposal.creator_id,
            action=PublicationAction.SKIPPED_NO_CHANGE,
        )
    return PublicationOutcome(
        creator_id=proposal.creator_id,
        action=PublicationAction.RENDERED,
        payload=render_issue(proposal),
    )
