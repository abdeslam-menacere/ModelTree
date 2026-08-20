"""Read a written proposal artefact back into the typed contracts.

Publication is deliberately a *separate* step from the run: `run --output` writes
`report.json`, and `publish --report report.json` reads it back. That split is what
makes the published issue provably the artefact a human can inspect on disk —
there is no second, in-memory rendering path that could drift from the file.

Reconstruction is strict. A missing required field, an unknown field, or a value
that is not a member of its enum is an :class:`ArtifactError`, never a silently
defaulted value: a proposal that cannot be read back exactly is not a proposal
anyone should publish. `contracts.py` remains the single definition of shape; this
module only maps JSON onto it.
"""

from __future__ import annotations

import json
from dataclasses import MISSING, fields
from pathlib import Path
from typing import Any, Callable, Mapping

from .contracts import (
    BudgetUsage,
    ClaimAdjudication,
    ClaimCandidate,
    ClaimDecision,
    Conflict,
    ConflictKind,
    CreatorProposal,
    EntityKind,
    Evidence,
    FailureKind,
    GateResult,
    GateStatus,
    ProposalStatus,
    ReviewLens,
    ReviewVerdict,
    RunFailure,
    RunReport,
    SourceApproval,
    SourceCandidate,
    SourceKind,
    SourceVerdict,
    ValidationResult,
    ValidationStatus,
    WorkflowStage,
)

__all__ = [
    "ArtifactError",
    "load_run_report",
    "proposal_from_dict",
    "report_from_dict",
]


class ArtifactError(ValueError):
    """The artefact is not the contract it claims to be."""


Converter = Callable[[Any, str], Any]


def _enum(enum_cls: type) -> Converter:
    def convert(value: Any, path: str) -> Any:
        try:
            return enum_cls(value)
        except ValueError as error:
            allowed = ", ".join(sorted(member.value for member in enum_cls))
            raise ArtifactError(
                f"{path}: {value!r} is not a valid {enum_cls.__name__}; expected one of {allowed}"
            ) from error

    return convert


def _optional(convert: Converter) -> Converter:
    def convert_optional(value: Any, path: str) -> Any:
        return None if value is None else convert(value, path)

    return convert_optional


def _sequence(convert: Converter) -> Converter:
    def convert_all(value: Any, path: str) -> tuple[Any, ...]:
        if not isinstance(value, (list, tuple)):
            raise ArtifactError(f"{path}: expected a list, got {type(value).__name__}")
        return tuple(
            convert(item, f"{path}[{index}]") for index, item in enumerate(value)
        )

    return convert_all


def _as_is(value: Any, path: str) -> Any:  # noqa: ARG001 - signature is the protocol
    return value


_as_tuple = _sequence(_as_is)


def _build(cls: type, converters: Mapping[str, Converter], data: Any, path: str) -> Any:
    """Construct one frozen contract, refusing anything it does not recognise."""
    if not isinstance(data, Mapping):
        raise ArtifactError(f"{path}: expected an object, got {type(data).__name__}")

    known = {spec.name: spec for spec in fields(cls)}
    unexpected = sorted(set(data) - set(known))
    if unexpected:
        raise ArtifactError(f"{path}: unexpected field(s): {', '.join(unexpected)}")

    kwargs: dict[str, Any] = {}
    for name, spec in known.items():
        if name not in data:
            if spec.default is MISSING and spec.default_factory is MISSING:
                raise ArtifactError(f"{path}: missing required field {name!r}")
            continue
        convert = converters.get(name)
        kwargs[name] = (
            convert(data[name], f"{path}.{name}") if convert else data[name]
        )
    return cls(**kwargs)


def _source(data: Any, path: str) -> SourceCandidate:
    return _build(SourceCandidate, {"kind": _enum(SourceKind)}, data, path)


def _evidence(data: Any, path: str) -> Evidence:
    return _build(Evidence, {}, data, path)


def _claim(data: Any, path: str) -> ClaimCandidate:
    return _build(
        ClaimCandidate,
        {
            "entity_kind": _enum(EntityKind),
            "evidence": _sequence(_evidence),
        },
        data,
        path,
    )


def _verdict(data: Any, path: str) -> ReviewVerdict:
    return _build(
        ReviewVerdict,
        {
            "decision": _enum(ClaimDecision),
            "lens": _optional(_enum(ReviewLens)),
            "evidence_refs": _as_tuple,
        },
        data,
        path,
    )


def _source_verdict(data: Any, path: str) -> SourceVerdict:
    return _build(
        SourceVerdict,
        {"decision": _enum(ClaimDecision), "lens": _optional(_enum(ReviewLens))},
        data,
        path,
    )


def _gate(data: Any, path: str) -> GateResult:
    return _build(
        GateResult, {"status": _enum(GateStatus), "issues": _as_tuple}, data, path
    )


def _adjudication(data: Any, path: str) -> ClaimAdjudication:
    return _build(
        ClaimAdjudication,
        {
            "decision": _enum(ClaimDecision),
            "semantic_decision": _enum(ClaimDecision),
            "vetoed_by": _as_tuple,
            "verdicts": _sequence(_verdict),
        },
        data,
        path,
    )


def _approval(data: Any, path: str) -> SourceApproval:
    return _build(
        SourceApproval,
        {"vetoed_by": _as_tuple, "verdicts": _sequence(_source_verdict)},
        data,
        path,
    )


def _validation(data: Any, path: str) -> ValidationResult:
    return _build(
        ValidationResult,
        {"status": _enum(ValidationStatus), "issues": _as_tuple},
        data,
        path,
    )


def _conflict(data: Any, path: str) -> Conflict:
    return _build(
        Conflict,
        {
            "entity_kind": _enum(EntityKind),
            "kind": _enum(ConflictKind),
            "claim_ids": _as_tuple,
            "values": _as_tuple,
        },
        data,
        path,
    )


def _budget(data: Any, path: str) -> BudgetUsage:
    return _build(BudgetUsage, {"exhausted_by": _as_tuple}, data, path)


def _failure(data: Any, path: str) -> RunFailure:
    return _build(
        RunFailure,
        {"stage": _enum(WorkflowStage), "kind": _enum(FailureKind)},
        data,
        path,
    )


def proposal_from_dict(data: Any, path: str = "proposal") -> CreatorProposal:
    """Rebuild one creator proposal from its artefact JSON."""
    return _build(
        CreatorProposal,
        {
            "status": _enum(ProposalStatus),
            "sources": _sequence(_source),
            "claims": _sequence(_claim),
            "verdicts": _sequence(_verdict),
            "validations": _sequence(_validation),
            "conflicts": _sequence(_conflict),
            "budget": _budget,
            "failures": _sequence(_failure),
            "notes": _as_tuple,
            "gates": _sequence(_gate),
            "adjudications": _sequence(_adjudication),
            "source_approvals": _sequence(_approval),
        },
        data,
        path,
    )


def report_from_dict(data: Any, path: str = "report") -> RunReport:
    """Rebuild a whole run report, proposals included."""
    return _build(
        RunReport, {"proposals": _sequence(proposal_from_dict)}, data, path
    )


def load_run_report(path: Path | str) -> RunReport:
    """Read a `report.json` written by `run --output`.

    Reading only: this never writes, and the parsed report is immutable.
    """
    source = Path(path)
    try:
        raw = source.read_text(encoding="utf-8")
    except OSError as error:
        raise ArtifactError(f"cannot read proposal artefact {source}: {error}") from error
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ArtifactError(f"{source} is not valid JSON: {error}") from error
    return report_from_dict(data, path=str(source))
