"""Deterministic fixture providers.

These are the CI and local-development providers: no network, no credentials, no
model calls. The same fixture always produces the same proposal, so a diff in the
output is a diff in the code.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from ..contracts import (
    ClaimCandidate,
    ClaimDecision,
    CreatorRequest,
    EntityKind,
    Evidence,
    FetchedPage,
    ReviewVerdict,
    SourceCandidate,
    SourceKind,
    content_hash,
)
from .base import ExtractionResult, ProviderBundle, ProviderError, ReviewResult

__all__ = [
    "FixtureClaimExtractor",
    "FixtureClaimReviewer",
    "FixtureLibrary",
    "FixtureSourceProvider",
    "build_fixture_bundle",
    "load_fixture_library",
]

DEFAULT_TIMESTAMP = "2026-01-01T00:00:00+00:00"
DEFAULT_DATE = "2026-01-01"


@dataclass(frozen=True)
class FixtureLibrary:
    """Creator fixtures loaded from a directory of JSON files."""

    creators: Mapping[str, CreatorRequest]
    documents: Mapping[str, Mapping[str, Any]]

    def document(self, creator_id: str) -> Mapping[str, Any]:
        if creator_id not in self.documents:
            raise ProviderError(
                f"no fixture for creator {creator_id!r}",
                provider="fixtures",
                retryable=False,
            )
        return self.documents[creator_id]

    @property
    def creator_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self.creators))


def load_fixture_library(directory: Path) -> FixtureLibrary:
    directory = Path(directory)
    if not directory.is_dir():
        raise FileNotFoundError(f"fixture directory not found: {directory}")

    creators: dict[str, CreatorRequest] = {}
    documents: dict[str, Mapping[str, Any]] = {}
    for path in sorted(directory.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        creator = document["creator"]
        request = CreatorRequest(
            creator_id=creator["creator_id"],
            creator_name=creator["creator_name"],
            entry_urls=tuple(creator.get("entry_urls", ())),
            notes=creator.get("notes"),
        )
        creators[request.creator_id] = request
        documents[request.creator_id] = document
    if not creators:
        raise FileNotFoundError(f"no creator fixtures found in {directory}")
    return FixtureLibrary(creators=creators, documents=documents)


def _fail(source: Mapping[str, Any], provider: str) -> None:
    failure = source.get("failure")
    if failure:
        raise ProviderError(
            failure.get("message", "fixture provider failure"),
            provider=provider,
            retryable=bool(failure.get("retryable", False)),
        )


class FixtureSourceProvider:
    name = "fixtures:sources"

    def __init__(self, library: FixtureLibrary, *, timestamp: str = DEFAULT_TIMESTAMP) -> None:
        self._library = library
        self._timestamp = timestamp

    def discover(self, creator: CreatorRequest, *, limit: int) -> Sequence[SourceCandidate]:
        document = self._library.document(creator.creator_id)
        _fail(document, self.name)
        candidates: list[SourceCandidate] = []
        for source in document.get("sources", []):
            candidates.append(
                SourceCandidate(
                    id=source["id"],
                    creator_id=creator.creator_id,
                    url=source["url"],
                    title=source["title"],
                    publisher=source["publisher"],
                    kind=SourceKind(source.get("kind", SourceKind.OFFICIAL_DOCS.value)),
                    discovered_at=self._timestamp,
                    published_date=source.get("published_date"),
                )
            )
        return tuple(candidates[:limit])

    def fetch(self, candidate: SourceCandidate) -> FetchedPage:
        source = self._source_document(candidate)
        _fail(source, self.name)
        text = source.get("text", "")
        return FetchedPage(
            source=candidate,
            text=text,
            retrieved_at=self._timestamp,
            content_hash=content_hash(text),
        )

    def _source_document(self, candidate: SourceCandidate) -> Mapping[str, Any]:
        document = self._library.document(candidate.creator_id)
        for source in document.get("sources", []):
            if source["id"] == candidate.id:
                return source
        raise ProviderError(
            f"fixture source {candidate.id!r} not found",
            provider=self.name,
            retryable=False,
        )


class FixtureClaimExtractor:
    name = "fixtures:extractor"

    def __init__(
        self,
        library: FixtureLibrary,
        *,
        timestamp: str = DEFAULT_TIMESTAMP,
        verified_at: str = DEFAULT_DATE,
    ) -> None:
        self._library = library
        self._timestamp = timestamp
        self._verified_at = verified_at

    def extract(self, creator: CreatorRequest, page: FetchedPage) -> ExtractionResult:
        document = self._library.document(creator.creator_id)
        source = next(
            (item for item in document.get("sources", []) if item["id"] == page.source.id),
            None,
        )
        if source is None:
            raise ProviderError(
                f"fixture source {page.source.id!r} not found",
                provider=self.name,
                retryable=False,
            )
        if source.get("extraction_failure"):
            failure = source["extraction_failure"]
            raise ProviderError(
                failure.get("message", "fixture extraction failure"),
                provider=self.name,
                retryable=bool(failure.get("retryable", False)),
            )

        claims: list[ClaimCandidate] = []
        for raw in source.get("claims", []):
            evidence = Evidence(
                source_id=page.source.id,
                url=page.source.url,
                quote=raw.get("quote", ""),
                content_hash=page.content_hash,
                verified_at=raw.get("verified_at", self._verified_at),
            )
            claims.append(
                ClaimCandidate(
                    id=raw["id"],
                    creator_id=creator.creator_id,
                    entity_kind=EntityKind(raw["entity_kind"]),
                    entity_id=raw["entity_id"],
                    field_path=raw["field_path"],
                    value=raw["value"],
                    evidence=(evidence,),
                    confidence=float(raw.get("confidence", 0.5)),
                    extracted_at=self._timestamp,
                    extractor=self.name,
                )
            )
        # Deterministic accounting: a fixed cost per 4 characters read.
        tokens = max(1, len(page.text) // 4)
        return ExtractionResult(claims=tuple(claims), tokens_used=tokens)


class FixtureClaimReviewer:
    name = "fixtures:reviewer"

    def __init__(
        self,
        library: FixtureLibrary,
        *,
        timestamp: str = DEFAULT_TIMESTAMP,
        tokens_per_claim: int = 64,
    ) -> None:
        self._library = library
        self._timestamp = timestamp
        self._tokens_per_claim = tokens_per_claim

    def review(self, creator: CreatorRequest, claim: ClaimCandidate) -> ReviewResult:
        raw = self._claim_document(creator.creator_id, claim.id)
        review = raw.get("review", {})
        if review.get("failure"):
            raise ProviderError(
                review["failure"].get("message", "fixture review failure"),
                provider=self.name,
                retryable=bool(review["failure"].get("retryable", False)),
            )
        decision = ClaimDecision(review.get("decision", ClaimDecision.NEEDS_HUMAN_REVIEW.value))
        verdict = ReviewVerdict(
            claim_id=claim.id,
            decision=decision,
            rationale=review.get("rationale", "recorded by fixture reviewer"),
            reviewer=self.name,
            reviewed_at=self._timestamp,
        )
        return ReviewResult(verdict=verdict, tokens_used=self._tokens_per_claim)

    def _claim_document(self, creator_id: str, claim_id: str) -> Mapping[str, Any]:
        document = self._library.document(creator_id)
        for source in document.get("sources", []):
            for raw in source.get("claims", []):
                if raw["id"] == claim_id:
                    return raw
        raise ProviderError(
            f"fixture claim {claim_id!r} not found",
            provider=self.name,
            retryable=False,
        )


def build_fixture_bundle(
    library: FixtureLibrary, *, timestamp: str = DEFAULT_TIMESTAMP
) -> ProviderBundle:
    return ProviderBundle(
        sources=FixtureSourceProvider(library, timestamp=timestamp),
        extractor=FixtureClaimExtractor(library, timestamp=timestamp),
        reviewer=FixtureClaimReviewer(library, timestamp=timestamp),
    )
