"""Microsoft Foundry model deployment configuration and providers.

Configuration is environment-driven and authentication is keyless: the tool asks
`DefaultAzureCredential` for a token and never reads or stores an API key. The
Azure SDK and the Foundry chat client are imported lazily so that fixture runs,
tests, and CI need neither the packages nor a cloud login.

The client is `FoundryChatClient` from `agent-framework-foundry`, whose
`get_response` returns an *awaitable* rather than a result. That is precisely why
the provider methods are `async`: a synchronous provider would hand the workflow
an un-awaited coroutine that looks like an empty answer.

This path is covered by unit tests with a stub client. It has **not** been
verified against a live Foundry deployment — see `README.md`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping, Sequence

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
    SourceVerdict,
)
from .base import (
    ExtractionResult,
    ProviderError,
    ReviewPanel,
    ReviewResult,
    SourceReviewResult,
)

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from ..review import ClaimReviewRequest, SourceReviewRequest

__all__ = [
    "FoundryConfig",
    "FoundryClaimExtractor",
    "FoundryLensReviewer",
    "MissingFoundryDependency",
    "build_credential",
    "build_chat_client",
    "build_foundry_panel",
]

ENV_ENDPOINT = "MODELTREE_FOUNDRY_ENDPOINT"
ENV_DEPLOYMENT = "MODELTREE_FOUNDRY_DEPLOYMENT"


class MissingFoundryDependency(ProviderError):
    """The Foundry extras are not installed. Fixture runs never hit this."""

    def __init__(self, package: str) -> None:
        super().__init__(
            f"{package} is required for the Foundry provider. Install the extras with "
            "`pip install -e 'tools/updater[foundry]'` and sign in with `az login`.",
            provider="foundry",
            retryable=False,
        )


@dataclass(frozen=True)
class FoundryConfig:
    """Everything needed to reach one Foundry model deployment."""

    endpoint: str
    deployment: str

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "FoundryConfig":
        missing = [name for name in (ENV_ENDPOINT, ENV_DEPLOYMENT) if not env.get(name)]
        if missing:
            raise ProviderError(
                "missing Foundry configuration: " + ", ".join(missing),
                provider="foundry",
                retryable=False,
            )
        return cls(endpoint=env[ENV_ENDPOINT], deployment=env[ENV_DEPLOYMENT])

    @property
    def descriptor(self) -> dict[str, str]:
        """Safe to log: identifies the deployment without exposing a secret."""
        return {
            "endpoint": self.endpoint,
            "deployment": self.deployment,
            "auth": "DefaultAzureCredential",
        }


def build_credential() -> Any:
    """Keyless local authentication. Imported lazily; never called by fixture runs."""
    try:
        from azure.identity import DefaultAzureCredential
    except ImportError as error:  # pragma: no cover - exercised only with extras absent
        raise MissingFoundryDependency("azure-identity") from error
    return DefaultAzureCredential()


def build_chat_client(config: FoundryConfig, *, credential: Any | None = None) -> Any:
    """Build the Foundry chat client for the configured project and deployment."""
    try:
        from agent_framework_foundry import FoundryChatClient
    except ImportError as error:  # pragma: no cover - needs the extras installed
        raise MissingFoundryDependency("agent-framework-foundry") from error

    return FoundryChatClient(
        project_endpoint=config.endpoint,
        model=config.deployment,
        credential=credential or build_credential(),
    )


def _prompt(instructions: str, content: str) -> list[Any]:
    """Build the two-message prompt. Message contents are sequences, not bare strings."""
    from agent_framework import Message

    return [Message("system", [instructions]), Message("user", [content])]


async def _ask(client: Any, instructions: str, content: str) -> Any:
    """One model call. `get_response` returns an awaitable, so it is always awaited."""
    response = client.get_response(_prompt(instructions, content))
    if hasattr(response, "__await__"):
        response = await response
    return response


def _usage_tokens(response: Any) -> int:
    """Token usage, whether the framework reports a mapping or an object."""
    usage = getattr(response, "usage_details", None)
    if isinstance(usage, Mapping):
        total = usage.get("total_token_count")
        if isinstance(total, int):
            return total
        parts = (usage.get("input_token_count"), usage.get("output_token_count"))
        return sum(value for value in parts if isinstance(value, int))
    total = getattr(usage, "total_token_count", None)
    return int(total) if isinstance(total, int) else 0


def _require_text(response: Any) -> str:
    text = getattr(response, "text", None)
    if not isinstance(text, str) or not text.strip():
        raise ProviderError(
            "model returned an empty response",
            provider="foundry",
            retryable=True,
            tokens_used=_usage_tokens(response),
        )
    return text


def _parse_json_object(text: str, *, tokens_used: int = 0) -> Mapping[str, Any]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ProviderError(
            f"model response was not valid JSON: {error}",
            provider="foundry",
            retryable=True,
            tokens_used=tokens_used,
        ) from error
    if not isinstance(parsed, dict):
        raise ProviderError(
            "model response was not a JSON object",
            provider="foundry",
            retryable=True,
            tokens_used=tokens_used,
        )
    return parsed


EXTRACTION_INSTRUCTIONS = (
    "Extract atomic factual claims about AI creators, model families, and model releases "
    "from the supplied page. Return JSON: {\"claims\": [{\"id\", \"entity_kind\", "
    "\"entity_id\", \"field_path\", \"value\", \"quote\", \"confidence\"}]}. Quote text "
    "verbatim from the page. Never infer a value the page does not state."
)

REVIEW_INSTRUCTIONS = (
    "You are one of three independent reviewers, each with a different job. Judge "
    "only your own lens; do not speculate about the other two. Return JSON: "
    "{\"decision\": \"accept\"|\"reject\"|\"needs-human-review\"|\"abstain\", "
    "\"rationale\"}. Abstain when your lens has nothing to go on. Choose "
    "needs-human-review when your lens applies but the answer is genuinely unclear."
)


class FoundryLensReviewer:
    """One semantic lens, answered by a Foundry deployment.

    Each lens is a separate instance with a separate brief and a separate prompt,
    and is given only the material `review.build_claim_request` allocated to it, so
    the three reviewers are genuinely different jobs rather than one repeated three
    times.
    """

    def __init__(
        self,
        client: Any,
        config: FoundryConfig,
        lens: ReviewLens,
        *,
        timestamp: str,
    ) -> None:
        self._client = client
        self._config = config
        self.lens = lens
        self.name = f"foundry:reviewer:{lens.value}"
        self._timestamp = timestamp

    async def review_claim(self, request: "ClaimReviewRequest") -> ReviewResult:
        payload = {
            "lens": request.lens.value,
            "brief": request.brief,
            "creator": request.creator.creator_name,
            "claim": request.claim.to_dict(),
            "evidence": [item.to_dict() for item in request.evidence],
            "cited_sources": [item.to_dict() for item in request.cited_sources],
            "sibling_claims": [item.to_dict() for item in request.sibling_claims],
            "creator_sources": [item.to_dict() for item in request.creator_sources],
            "field_expectation": (
                {
                    "entity_kind": request.expectation.entity_kind.value,
                    "field_path": request.expectation.field_path,
                    "kind": request.expectation.kind,
                    "allowed": list(request.expectation.allowed),
                    "known_field_paths": list(request.expectation.known_field_paths),
                }
                if request.expectation
                else None
            ),
        }
        decision, rationale, tokens = await self._decide(request.brief, payload)
        verdict = ReviewVerdict(
            claim_id=request.claim.id,
            decision=decision,
            rationale=rationale,
            reviewer=f"{self.name}:{self._config.deployment}",
            reviewed_at=self._timestamp,
            lens=self.lens,
            evidence_refs=tuple(item.source_id for item in request.evidence),
        )
        return ReviewResult(verdict=verdict, tokens_used=tokens)

    async def review_source(self, request: "SourceReviewRequest") -> SourceReviewResult:
        payload = {
            "lens": request.lens.value,
            "brief": request.brief,
            "creator": request.creator.creator_name,
            "source": request.source.to_dict(),
            "configured_origins": list(request.configured_origins),
            "known_sources": [item.to_dict() for item in request.known_sources],
        }
        decision, rationale, tokens = await self._decide(request.brief, payload)
        verdict = SourceVerdict(
            source_id=request.source.id,
            decision=decision,
            rationale=rationale,
            reviewer=f"{self.name}:{self._config.deployment}",
            reviewed_at=self._timestamp,
            lens=self.lens,
        )
        return SourceReviewResult(verdict=verdict, tokens_used=tokens)

    async def _decide(
        self, brief: str, payload: Mapping[str, Any]
    ) -> tuple[ClaimDecision, str, int]:
        response = await _ask(
            self._client,
            f"{REVIEW_INSTRUCTIONS}\n\nYour lens: {brief}",
            json.dumps(payload, indent=2, default=str),
        )
        tokens = _usage_tokens(response)
        parsed = _parse_json_object(_require_text(response), tokens_used=tokens)
        try:
            decision = ClaimDecision(parsed.get("decision", ""))
        except ValueError as error:
            raise ProviderError(
                f"model returned an unknown decision {parsed.get('decision')!r}",
                provider="foundry",
                retryable=True,
                tokens_used=tokens,
            ) from error
        return decision, str(parsed.get("rationale", "")), tokens


def build_foundry_panel(
    client: Any, config: FoundryConfig, *, timestamp: str
) -> ReviewPanel:
    return ReviewPanel(
        provenance=FoundryLensReviewer(client, config, ReviewLens.PROVENANCE, timestamp=timestamp),
        consistency=FoundryLensReviewer(
            client, config, ReviewLens.CONSISTENCY, timestamp=timestamp
        ),
        editorial=FoundryLensReviewer(client, config, ReviewLens.EDITORIAL, timestamp=timestamp),
    )


class FoundryClaimExtractor:
    """Extracts claims with a Foundry deployment."""

    name = "foundry:extractor"

    def __init__(
        self,
        client: Any,
        config: FoundryConfig,
        *,
        timestamp: str,
        verified_at: str,
    ) -> None:
        self._client = client
        self._config = config
        self._timestamp = timestamp
        self._verified_at = verified_at

    async def extract(self, creator: CreatorRequest, page: FetchedPage) -> ExtractionResult:
        response = await _ask(
            self._client,
            EXTRACTION_INSTRUCTIONS,
            f"Creator: {creator.creator_name}\nSource: {page.source.url}\n\n{page.text}",
        )
        tokens = _usage_tokens(response)
        payload = _parse_json_object(_require_text(response), tokens_used=tokens)
        claims: list[ClaimCandidate] = []
        for raw in payload.get("claims", []):
            evidence = Evidence(
                source_id=page.source.id,
                url=page.source.url,
                quote=str(raw.get("quote", "")),
                content_hash=page.content_hash,
                verified_at=self._verified_at,
            )
            claims.append(
                ClaimCandidate(
                    id=str(raw["id"]),
                    creator_id=creator.creator_id,
                    entity_kind=EntityKind(raw["entity_kind"]),
                    entity_id=str(raw["entity_id"]),
                    field_path=str(raw["field_path"]),
                    value=raw.get("value"),
                    evidence=(evidence,),
                    confidence=float(raw.get("confidence", 0.0)),
                    extracted_at=self._timestamp,
                    extractor=f"{self.name}:{self._config.deployment}",
                )
            )
        return ExtractionResult(claims=tuple(claims), tokens_used=tokens)


def unsupported_source_provider(_: Sequence[SourceCandidate] | None = None) -> None:
    """Foundry supplies models, not web sources. Source acquisition stays explicit."""
    raise ProviderError(
        "the Foundry provider does not fetch web pages; supply a source provider",
        provider="foundry",
        retryable=False,
    )
