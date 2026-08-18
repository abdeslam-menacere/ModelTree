"""Proposal-only ModelTree data updater.

Built on Microsoft Agent Framework workflows. It reads sources, extracts atomic
claims with evidence, reviews and validates them, and emits a proposal bundle for
a human to act on. It never writes ModelTree data, never creates a branch, and
never opens a pull request.
"""

from .budgets import BudgetExhausted, BudgetLedger, CreatorBudget
from .contracts import (
    BudgetUsage,
    ClaimAdjudication,
    ClaimCandidate,
    ClaimDecision,
    Conflict,
    CreatorProposal,
    CreatorRequest,
    Evidence,
    GateResult,
    GateStatus,
    ProposalStatus,
    ReviewLens,
    ReviewVerdict,
    RunFailure,
    RunReport,
    SourceApproval,
    SourceCandidate,
    SourceVerdict,
    ValidationResult,
)

__version__ = "0.1.0"

__all__ = [
    "BudgetExhausted",
    "BudgetLedger",
    "BudgetUsage",
    "ClaimAdjudication",
    "ClaimCandidate",
    "ClaimDecision",
    "Conflict",
    "CreatorBudget",
    "CreatorProposal",
    "CreatorRequest",
    "Evidence",
    "GateResult",
    "GateStatus",
    "ProposalStatus",
    "ReviewLens",
    "ReviewVerdict",
    "RunFailure",
    "RunReport",
    "SourceApproval",
    "SourceCandidate",
    "SourceVerdict",
    "ValidationResult",
    "__version__",
]
