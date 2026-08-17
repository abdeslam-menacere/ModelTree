"""Provider boundaries: everything that could reach the network or a model.

The workflow only ever talks to these protocols, so CI can run the whole pipeline
against deterministic fixtures with no network and no cloud credentials.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence, runtime_checkable

from ..contracts import (
    ClaimCandidate,
    CreatorRequest,
    FetchedPage,
    ReviewVerdict,
    SourceCandidate,
)

__all__ = [
    "ClaimExtractor",
    "ClaimReviewer",
    "ExtractionResult",
    "ProviderError",
    "ProviderBundle",
    "ReviewResult",
    "SourceProvider",
]


class ProviderError(RuntimeError):
    """A provider failed. `retryable` decides whether the retry budget is spent."""

    def __init__(self, message: str, *, provider: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable


@dataclass(frozen=True)
class ExtractionResult:
    claims: tuple[ClaimCandidate, ...]
    tokens_used: int


@dataclass(frozen=True)
class ReviewResult:
    verdict: ReviewVerdict
    tokens_used: int


@runtime_checkable
class SourceProvider(Protocol):
    """Finds and reads candidate sources for one creator."""

    name: str

    def discover(self, creator: CreatorRequest, *, limit: int) -> Sequence[SourceCandidate]: ...

    def fetch(self, candidate: SourceCandidate) -> FetchedPage: ...


@runtime_checkable
class ClaimExtractor(Protocol):
    """Turns one page into atomic claim candidates with evidence."""

    name: str

    def extract(self, creator: CreatorRequest, page: FetchedPage) -> ExtractionResult: ...


@runtime_checkable
class ClaimReviewer(Protocol):
    """Judges a single claim. A reviewer never sees the extractor's reasoning."""

    name: str

    def review(self, creator: CreatorRequest, claim: ClaimCandidate) -> ReviewResult: ...


@dataclass(frozen=True)
class ProviderBundle:
    """The three provider boundaries a run needs, resolved once by the CLI."""

    sources: SourceProvider
    extractor: ClaimExtractor
    reviewer: ClaimReviewer

    @property
    def descriptor(self) -> dict[str, str]:
        return {
            "sources": self.sources.name,
            "extractor": self.extractor.name,
            "reviewer": self.reviewer.name,
        }
