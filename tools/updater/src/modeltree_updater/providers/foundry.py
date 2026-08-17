"""Microsoft Foundry model deployment configuration and providers.

Configuration is environment-driven and authentication is keyless: the tool asks
`DefaultAzureCredential` for a token and never reads or stores an API key. The
Azure SDK and the Foundry chat client are imported lazily so that fixture runs,
tests, and CI need neither the packages nor a cloud login.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
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
)
from .base import ExtractionResult, ProviderError, ReviewResult

__all__ = [
    "FoundryConfig",
    "FoundryClaimExtractor",
    "FoundryClaimReviewer",
    "MissingFoundryDependency",
    "build_credential",
    "build_chat_client",
]

ENV_ENDPOINT = "MODELTREE_FOUNDRY_ENDPOINT"
ENV_DEPLOYMENT = "MODELTREE_FOUNDRY_DEPLOYMENT"
ENV_API_VERSION = "MODELTREE_FOUNDRY_API_VERSION"
ENV_SCOPE = "MODELTREE_FOUNDRY_CREDENTIAL_SCOPE"

DEFAULT_API_VERSION = "2024-10-21"
DEFAULT_SCOPE = "https://cognitiveservices.azure.com/.default"


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
    api_version: str = DEFAULT_API_VERSION
    credential_scope: str = DEFAULT_SCOPE

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "FoundryConfig":
        missing = [name for name in (ENV_ENDPOINT, ENV_DEPLOYMENT) if not env.get(name)]
        if missing:
            raise ProviderError(
                "missing Foundry configuration: " + ", ".join(missing),
                provider="foundry",
                retryable=False,
            )
        return cls(
            endpoint=env[ENV_ENDPOINT],
            deployment=env[ENV_DEPLOYMENT],
            api_version=env.get(ENV_API_VERSION, DEFAULT_API_VERSION),
            credential_scope=env.get(ENV_SCOPE, DEFAULT_SCOPE),
        )

    @property
    def descriptor(self) -> dict[str, str]:
        """Safe to log: identifies the deployment without exposing a secret."""
        return {
            "endpoint": self.endpoint,
            "deployment": self.deployment,
            "api_version": self.api_version,
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
    """Build the Agent Framework chat client for the configured deployment."""
    try:
        from agent_framework.azure import AzureOpenAIChatClient  # type: ignore[attr-defined]
    except (ImportError, AttributeError) as error:  # pragma: no cover - needs extras
        raise MissingFoundryDependency("agent-framework-azure-ai") from error

    return AzureOpenAIChatClient(
        endpoint=config.endpoint,
        deployment_name=config.deployment,
        api_version=config.api_version,
        credential=credential or build_credential(),
    )


def _require_text(response: Any) -> str:
    text = getattr(response, "text", None)
    if not isinstance(text, str) or not text.strip():
        raise ProviderError(
            "model returned an empty response", provider="foundry", retryable=True
        )
    return text


def _parse_json_object(text: str) -> Mapping[str, Any]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise ProviderError(
            f"model response was not valid JSON: {error}", provider="foundry", retryable=True
        ) from error
    if not isinstance(parsed, dict):
        raise ProviderError(
            "model response was not a JSON object", provider="foundry", retryable=True
        )
    return parsed


EXTRACTION_INSTRUCTIONS = (
    "Extract atomic factual claims about AI creators, model families, and model releases "
    "from the supplied page. Return JSON: {\"claims\": [{\"id\", \"entity_kind\", "
    "\"entity_id\", \"field_path\", \"value\", \"quote\", \"confidence\"}]}. Quote text "
    "verbatim from the page. Never infer a value the page does not state."
)

REVIEW_INSTRUCTIONS = (
    "Judge a single claim against its quoted evidence. Return JSON: "
    "{\"decision\": \"accept\"|\"reject\"|\"needs-human-review\", \"rationale\"}. "
    "Choose needs-human-review whenever the evidence is ambiguous or incomplete."
)


class FoundryClaimExtractor:
    """Extracts claims with a Foundry deployment. Not exercised in tests by design."""

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

    def extract(self, creator: CreatorRequest, page: FetchedPage) -> ExtractionResult:
        response = self._client.get_response(
            f"{EXTRACTION_INSTRUCTIONS}\n\nCreator: {creator.creator_name}\n"
            f"Source: {page.source.url}\n\n{page.text}"
        )
        payload = _parse_json_object(_require_text(response))
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
        return ExtractionResult(claims=tuple(claims), tokens_used=_usage_tokens(response))


class FoundryClaimReviewer:
    """Reviews a claim with a Foundry deployment, seeing only the claim and evidence."""

    name = "foundry:reviewer"

    def __init__(self, client: Any, config: FoundryConfig, *, timestamp: str) -> None:
        self._client = client
        self._config = config
        self._timestamp = timestamp

    def review(self, creator: CreatorRequest, claim: ClaimCandidate) -> ReviewResult:
        response = self._client.get_response(
            f"{REVIEW_INSTRUCTIONS}\n\n{json.dumps(claim.to_dict(), indent=2)}"
        )
        payload = _parse_json_object(_require_text(response))
        try:
            decision = ClaimDecision(payload.get("decision", ""))
        except ValueError as error:
            raise ProviderError(
                f"model returned an unknown decision {payload.get('decision')!r}",
                provider="foundry",
                retryable=True,
            ) from error
        verdict = ReviewVerdict(
            claim_id=claim.id,
            decision=decision,
            rationale=str(payload.get("rationale", "")),
            reviewer=f"{self.name}:{self._config.deployment}",
            reviewed_at=self._timestamp,
        )
        return ReviewResult(verdict=verdict, tokens_used=_usage_tokens(response))


def _usage_tokens(response: Any) -> int:
    usage = getattr(response, "usage_details", None)
    total = getattr(usage, "total_token_count", None)
    return int(total) if isinstance(total, int) else 0


def unsupported_source_provider(_: Sequence[SourceCandidate] | None = None) -> None:
    """Foundry supplies models, not web sources. Source acquisition stays explicit."""
    raise ProviderError(
        "the Foundry provider does not fetch web pages; supply a source provider",
        provider="foundry",
        retryable=False,
    )
