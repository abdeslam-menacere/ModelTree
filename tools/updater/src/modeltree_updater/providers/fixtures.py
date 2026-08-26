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
    ReviewLens,
    ReviewVerdict,
    SourceCandidate,
    SourceKind,
    SourceVerdict,
    content_hash,
)
from ..profiles import (
    _DuplicateIdGuard,
    _refuse_padded_id,
    _reviewed_profile_paths,
)
from ..review import ClaimReviewRequest, SourceReviewRequest
from .base import (
    ExtractionResult,
    ProviderBundle,
    ProviderError,
    ReviewPanel,
    ReviewResult,
    SourceReviewResult,
)

__all__ = [
    "FixtureClaimExtractor",
    "FixtureLensReviewer",
    "FixtureLibrary",
    "FixtureSourceProvider",
    "build_fixture_bundle",
    "build_fixture_panel",
    "load_fixture_library",
]

DEFAULT_TIMESTAMP = "2026-06-01T00:00:00+00:00"
DEFAULT_DATE = "2026-06-01"


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
    """Load every creator fixture in a directory, keyed by declared id.

    Which files are candidates is
    :func:`~modeltree_updater.profiles._reviewed_profile_paths`' decision — the same
    decision, made by the same code, that discovers the reviewed creator profiles and
    the reviewed long-tail profiles. This loader is the third and last place that
    decided it for itself: it globbed ``*.json``, which is case-insensitive on Windows
    and case-sensitive on Linux, matches a dot-prefixed name, and matches a *directory*
    called ``archive.json`` that is then handed to the parser. Sharing the rule rather
    than restating it is the point — two copies are what let the reviewed sets drift
    into disagreeing about what a document is (#108, #151).

    A duplicate creator id is **refused**, naming both files and both declared ids,
    where before the second document silently overwrote the first. That these are test
    doubles sharpens the argument rather than softening it. ``mode=fixtures`` is the
    mode the publisher workflow dispatches, so a dropped fixture creator does not fail:
    it produces a green run carrying fewer proposals than the author wrote, which is
    the "smoothed-over" outcome this repository exists to refuse and is invisible in a
    way a red run never is.

    Two deliberate points about the shared rule, neither of them re-decided here:

    * The collision key folds case and normalises whitespace; the **lookup does not**.
      ``self.documents`` and ``self.creators`` stay keyed by the exact declared string,
      so ``document()`` keeps answering only to the id it was given. Folding widens what
      is *refused*, never what an id matches.
    * A leading dot is judged before the extension, so ``.draft.JSON`` is skipped as
      the author's stated "not part of the working set" rather than refused for its
      case.

    A creator id padded with whitespace is refused outright by
    :func:`~modeltree_updater.profiles._refuse_padded_id` before it can be counted,
    which is this loader adopting a rule the long-tail set already had rather than a
    rule invented for it (#199).

    One wording divergence is inherited, not chosen: the shared refusal for a
    case-variant extension says "the reviewed set", which here names the set of
    fixtures being discovered. Fixtures are not a reviewed set, but the reason the
    sentence gives — that keeping the file would make discovery depend on whether the
    filesystem is case-sensitive — is true unchanged, and re-wording it would mean
    forking a message that is pinned byte-for-byte by its own tests.

    The refusal type is :class:`~modeltree_updater.profiles.ProfileError` for the same
    reason the rule is shared: a caller catching one of these refusals catches both,
    and the shared helper already raises it for the extension case. It is also already
    in the CLI's handled set, so a bad fixture directory exits as a usage error rather
    than a traceback. Loading is not provider I/O, so ``ProviderError`` — which carries
    a provider name and a retry decision — would be describing the wrong thing.
    """
    directory = Path(directory)
    if not directory.is_dir():
        raise FileNotFoundError(f"fixture directory not found: {directory}")

    creators: dict[str, CreatorRequest] = {}
    documents: dict[str, Mapping[str, Any]] = {}
    guard = _DuplicateIdGuard(
        subject="creator id",
        reason=(
            "an id has to name exactly one fixture, because a run resolves each "
            "creator through this library and a silently dropped fixture is a "
            "green run that quietly did less than it was asked"
        ),
    )
    for path in _reviewed_profile_paths(directory, kind="a creator fixture"):
        document = json.loads(path.read_text(encoding="utf-8"))
        creator = document["creator"]
        request = CreatorRequest(
            creator_id=_refuse_padded_id(
                creator["creator_id"], path=path, subject="creator id"
            ),
            creator_name=creator["creator_name"],
            entry_urls=tuple(creator.get("entry_urls", ())),
            notes=creator.get("notes"),
        )
        guard.register(request.creator_id, path)
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

    async def discover(self, creator: CreatorRequest, *, limit: int) -> Sequence[SourceCandidate]:
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

    async def fetch(self, candidate: SourceCandidate) -> FetchedPage:
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

    async def extract(self, creator: CreatorRequest, page: FetchedPage) -> ExtractionResult:
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


class FixtureLensReviewer:
    """One semantic lens, answered from the fixture file.

    A fixture claim may give one `review` block used by every lens, or a `reviews`
    map keyed by lens name to make the three disagree deliberately. Sources take the
    same shape under `source_review` / `source_reviews`.
    """

    def __init__(
        self,
        library: FixtureLibrary,
        lens: ReviewLens,
        *,
        timestamp: str = DEFAULT_TIMESTAMP,
        tokens_per_claim: int = 64,
    ) -> None:
        self._library = library
        self.lens = lens
        self.name = f"fixtures:reviewer:{lens.value}"
        self._timestamp = timestamp
        self._tokens_per_claim = tokens_per_claim

    async def review_claim(self, request: ClaimReviewRequest) -> ReviewResult:
        claim = request.claim
        raw = self._claim_document(claim.creator_id, claim.id)
        review = self._lens_review(raw, "review", "reviews")
        self._maybe_fail(review)
        verdict = ReviewVerdict(
            claim_id=claim.id,
            decision=ClaimDecision(
                review.get("decision", ClaimDecision.NEEDS_HUMAN_REVIEW.value)
            ),
            rationale=review.get("rationale", "recorded by fixture reviewer"),
            reviewer=self.name,
            reviewed_at=self._timestamp,
            lens=self.lens,
            evidence_refs=tuple(evidence.source_id for evidence in request.evidence),
        )
        return ReviewResult(verdict=verdict, tokens_used=self._tokens_per_claim)

    async def review_source(self, request: SourceReviewRequest) -> SourceReviewResult:
        raw = self._source_document(request.creator.creator_id, request.source.id)
        review = self._lens_review(raw, "source_review", "source_reviews")
        self._maybe_fail(review)
        verdict = SourceVerdict(
            source_id=request.source.id,
            # A fixture that says nothing about a newly discovered source abstains;
            # silence is never read as approval.
            decision=ClaimDecision(review.get("decision", ClaimDecision.ABSTAIN.value)),
            rationale=review.get("rationale", "recorded by fixture reviewer"),
            reviewer=self.name,
            reviewed_at=self._timestamp,
            lens=self.lens,
        )
        return SourceReviewResult(verdict=verdict, tokens_used=self._tokens_per_claim)

    def _lens_review(
        self, raw: Mapping[str, Any], single_key: str, per_lens_key: str
    ) -> Mapping[str, Any]:
        per_lens = raw.get(per_lens_key) or {}
        if self.lens.value in per_lens:
            return per_lens[self.lens.value]
        return raw.get(single_key, {})

    def _maybe_fail(self, review: Mapping[str, Any]) -> None:
        failure = review.get("failure")
        if failure:
            raise ProviderError(
                failure.get("message", "fixture review failure"),
                provider=self.name,
                retryable=bool(failure.get("retryable", False)),
            )

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

    def _source_document(self, creator_id: str, source_id: str) -> Mapping[str, Any]:
        document = self._library.document(creator_id)
        for source in document.get("sources", []):
            if source["id"] == source_id:
                return source
        raise ProviderError(
            f"fixture source {source_id!r} not found",
            provider=self.name,
            retryable=False,
        )


def build_fixture_panel(
    library: FixtureLibrary, *, timestamp: str = DEFAULT_TIMESTAMP
) -> ReviewPanel:
    return ReviewPanel(
        provenance=FixtureLensReviewer(library, ReviewLens.PROVENANCE, timestamp=timestamp),
        consistency=FixtureLensReviewer(library, ReviewLens.CONSISTENCY, timestamp=timestamp),
        editorial=FixtureLensReviewer(library, ReviewLens.EDITORIAL, timestamp=timestamp),
    )


def build_fixture_bundle(
    library: FixtureLibrary, *, timestamp: str = DEFAULT_TIMESTAMP
) -> ProviderBundle:
    return ProviderBundle(
        sources=FixtureSourceProvider(library, timestamp=timestamp),
        extractor=FixtureClaimExtractor(library, timestamp=timestamp),
        panel=build_fixture_panel(library, timestamp=timestamp),
    )
