"""Provider boundaries: everything that could reach the network or a model.

The workflow only ever talks to these protocols, so CI can run the whole pipeline
against deterministic fixtures with no network and no cloud credentials.

Every provider method is ``async``. Real providers are I/O — HTTP fetches and model
deployments — and their clients are awaitable; a synchronous boundary would force
every implementation to either block the workflow's event loop or, worse, return an
un-awaited coroutine that silently looks like an empty result.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence, runtime_checkable

from ..contracts import (
    ClaimCandidate,
    CreatorRequest,
    FetchedPage,
    ReviewLens,
    ReviewVerdict,
    SourceCandidate,
    SourceVerdict,
)
from ..review import ClaimReviewRequest, SourceReviewRequest

__all__ = [
    "ClaimExtractor",
    "ExtractionResult",
    "LensReviewer",
    "ProviderError",
    "ProviderBundle",
    "ReviewPanel",
    "ReviewResult",
    "SourceProvider",
    "SourceReviewResult",
]


class ProviderError(RuntimeError):
    """A provider failed. `retryable` decides whether the retry budget is spent."""

    def __init__(
        self,
        message: str,
        *,
        provider: str,
        retryable: bool = False,
        tokens_used: int = 0,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable
        # Work a failed attempt already paid for. Charged like a successful call, so
        # a provider that fails late cannot spend tokens outside the budget.
        self.tokens_used = tokens_used


@dataclass(frozen=True)
class ExtractionResult:
    claims: tuple[ClaimCandidate, ...]
    tokens_used: int


@dataclass(frozen=True)
class ReviewResult:
    verdict: ReviewVerdict
    tokens_used: int


@dataclass(frozen=True)
class SourceReviewResult:
    verdict: SourceVerdict
    tokens_used: int


@runtime_checkable
class SourceProvider(Protocol):
    """Finds and reads candidate sources for one creator."""

    name: str

    async def discover(
        self, creator: CreatorRequest, *, limit: int
    ) -> Sequence[SourceCandidate]: ...

    async def fetch(self, candidate: SourceCandidate) -> FetchedPage: ...


@runtime_checkable
class ClaimExtractor(Protocol):
    """Turns one page into atomic claim candidates with evidence."""

    name: str

    async def extract(self, creator: CreatorRequest, page: FetchedPage) -> ExtractionResult: ...


@runtime_checkable
class LensReviewer(Protocol):
    """Judges one claim or source through exactly one lens.

    A reviewer never sees the extractor's reasoning, never sees the other lenses'
    verdicts, and is handed only the material its own lens needs — the request is
    built by `review.build_claim_request`, which withholds the rest on purpose.
    """

    name: str
    lens: ReviewLens

    async def review_claim(self, request: ClaimReviewRequest) -> ReviewResult: ...

    async def review_source(self, request: SourceReviewRequest) -> SourceReviewResult: ...


@dataclass(frozen=True)
class ReviewPanel:
    """The three semantic lenses, in a fixed order so runs stay reproducible."""

    provenance: LensReviewer
    consistency: LensReviewer
    editorial: LensReviewer

    def __post_init__(self) -> None:
        expected = dict(
            zip(
                ("provenance", "consistency", "editorial"),
                (ReviewLens.PROVENANCE, ReviewLens.CONSISTENCY, ReviewLens.EDITORIAL),
            )
        )
        for attribute, lens in expected.items():
            reviewer = getattr(self, attribute)
            if getattr(reviewer, "lens", None) is not lens:
                raise ValueError(
                    f"panel slot {attribute!r} must hold a reviewer whose lens is "
                    f"{lens.value!r}, got {getattr(reviewer, 'lens', None)!r}"
                )

    @property
    def reviewers(self) -> tuple[LensReviewer, ...]:
        return (self.provenance, self.consistency, self.editorial)

    def reviewer_for(self, lens: ReviewLens) -> LensReviewer:
        for reviewer in self.reviewers:
            if reviewer.lens is lens:
                return reviewer
        raise KeyError(f"no reviewer for lens {lens!r}")  # pragma: no cover - guarded above

    @property
    def descriptor(self) -> dict[str, str]:
        return {f"reviewer:{reviewer.lens.value}": reviewer.name for reviewer in self.reviewers}


@dataclass(frozen=True)
class ProviderBundle:
    """The provider boundaries a run needs, resolved once by the CLI."""

    sources: SourceProvider
    extractor: ClaimExtractor
    panel: ReviewPanel

    @property
    def descriptor(self) -> dict[str, str]:
        return {
            "sources": self.sources.name,
            "extractor": self.extractor.name,
            **self.panel.descriptor,
        }
