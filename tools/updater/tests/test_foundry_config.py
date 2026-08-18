"""Foundry configuration is env-driven and keyless, and the client is awaited.

The question these answer: could this provider ever actually have worked? The
stub client below mirrors `FoundryChatClient.get_response`, which returns an
*awaitable* rather than a result — the shape a synchronous provider silently
mishandles, turning a real answer into "empty response".
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from modeltree_updater.contracts import (
    ClaimCandidate,
    ClaimDecision,
    CreatorRequest,
    EntityKind,
    Evidence,
    FetchedPage,
    ReviewLens,
    SourceCandidate,
    SourceKind,
)
from modeltree_updater.providers.base import ProviderError
from modeltree_updater.providers.foundry import (
    FoundryClaimExtractor,
    FoundryLensReviewer,
    FoundryConfig,
    build_foundry_panel,
)
from modeltree_updater.review import build_claim_request

CONFIG = FoundryConfig(
    endpoint="https://example-foundry.services.ai.azure.com/api/projects/demo",
    deployment="gpt-4.1-mini",
)
TIMESTAMP = "2026-01-01T00:00:00+00:00"
CREATOR = CreatorRequest(creator_id="contoso-ai", creator_name="Contoso AI")


class StubResponse:
    """The surface the framework returns: `.text` plus a usage mapping."""

    def __init__(self, text: str, tokens: int) -> None:
        self.text = text
        self.usage_details = {"input_token_count": tokens, "output_token_count": 0}


class StubChatClient:
    """`get_response` returns an awaitable, exactly like `FoundryChatClient`."""

    def __init__(self, payload: object, *, tokens: int = 120) -> None:
        self._payload = payload
        self._tokens = tokens
        self.calls: list[list[object]] = []
        self.awaited = 0

    def get_response(self, messages, **_: object):
        self.calls.append(list(messages))

        async def _respond() -> StubResponse:
            self.awaited += 1
            text = (
                self._payload
                if isinstance(self._payload, str)
                else json.dumps(self._payload)
            )
            return StubResponse(text, self._tokens)

        return _respond()


def _source() -> SourceCandidate:
    return SourceCandidate(
        id="contoso-ai-release-notes",
        creator_id="contoso-ai",
        url="https://www.example.com/contoso-ai/releases",
        title="Release notes",
        publisher="Contoso AI",
        kind=SourceKind.OFFICIAL_DOCS,
        discovered_at=TIMESTAMP,
    )


def _page() -> FetchedPage:
    return FetchedPage(
        source=_source(),
        text="Atlas 3 supports a 200,000 token context window.",
        retrieved_at=TIMESTAMP,
        content_hash="sha256:stub",
    )


def _claim() -> ClaimCandidate:
    evidence = Evidence(
        source_id="contoso-ai-release-notes",
        url="https://www.example.com/contoso-ai/releases",
        quote="Atlas 3 supports a 200,000 token context window.",
        content_hash="sha256:stub",
        verified_at="2026-01-01",
    )
    return ClaimCandidate(
        id="contoso-ai-atlas-3-context-window",
        creator_id="contoso-ai",
        entity_kind=EntityKind.RELEASE,
        entity_id="contoso-ai-atlas-3",
        field_path="context_window",
        value=200000,
        evidence=(evidence,),
        confidence=0.9,
        extracted_at=TIMESTAMP,
        extractor="foundry:extractor",
    )


def _extractor(client: StubChatClient) -> FoundryClaimExtractor:
    return FoundryClaimExtractor(
        client, CONFIG, timestamp=TIMESTAMP, verified_at="2026-01-01"
    )


def test_config_reads_the_deployment_from_the_environment() -> None:
    config = FoundryConfig.from_env(
        {
            "MODELTREE_FOUNDRY_ENDPOINT": "https://example.services.ai.azure.com",
            "MODELTREE_FOUNDRY_DEPLOYMENT": "gpt-4.1-mini",
        }
    )

    assert config.endpoint == "https://example.services.ai.azure.com"
    assert config.deployment == "gpt-4.1-mini"


def test_missing_configuration_is_an_explicit_error() -> None:
    with pytest.raises(ProviderError) as error:
        FoundryConfig.from_env({"MODELTREE_FOUNDRY_ENDPOINT": "https://example.invalid"})

    assert "MODELTREE_FOUNDRY_DEPLOYMENT" in str(error.value)
    assert error.value.retryable is False


def test_the_descriptor_records_keyless_auth_and_carries_no_secret() -> None:
    descriptor = CONFIG.descriptor

    assert descriptor["auth"] == "DefaultAzureCredential"
    assert not any("key" in key.lower() for key in descriptor)


def test_no_api_key_is_read_anywhere_in_the_provider() -> None:
    source = Path(
        __file__
    ).resolve().parents[1] / "src" / "modeltree_updater" / "providers" / "foundry.py"
    text = source.read_text(encoding="utf-8")

    assert "api_key" not in text
    assert "AZURE_OPENAI_API_KEY" not in text


def test_extraction_awaits_the_client_and_attaches_evidence() -> None:
    client = StubChatClient(
        {
            "claims": [
                {
                    "id": "contoso-ai-atlas-3-context-window",
                    "entity_kind": "release",
                    "entity_id": "contoso-ai-atlas-3",
                    "field_path": "context_window",
                    "value": 200000,
                    "quote": "Atlas 3 supports a 200,000 token context window.",
                    "confidence": 0.9,
                }
            ]
        }
    )

    result = asyncio.run(_extractor(client).extract(CREATOR, _page()))

    assert client.awaited == 1  # the coroutine body only runs when awaited
    assert result.tokens_used == 120
    assert result.claims[0].evidence[0].quote.startswith("Atlas 3")
    assert result.claims[0].extractor == "foundry:extractor:gpt-4.1-mini"


def _reviewer(client: object, lens: ReviewLens = ReviewLens.PROVENANCE) -> FoundryLensReviewer:
    return FoundryLensReviewer(client, CONFIG, lens, timestamp=TIMESTAMP)


def _request(lens: ReviewLens = ReviewLens.PROVENANCE):
    claim = _claim()
    return build_claim_request(
        lens, creator=CREATOR, claim=claim, claims=[claim], sources=[_source()]
    )


def test_review_awaits_the_client_and_returns_a_verdict() -> None:
    client = StubChatClient({"decision": "accept", "rationale": "the page states it"})

    result = asyncio.run(_reviewer(client).review_claim(_request()))

    assert client.awaited == 1
    assert result.verdict.decision is ClaimDecision.ACCEPT
    assert result.verdict.lens is ReviewLens.PROVENANCE
    assert result.verdict.reviewer == "foundry:reviewer:provenance:gpt-4.1-mini"


def test_each_lens_is_given_its_own_brief() -> None:
    briefs = set()
    for lens in ReviewLens:
        client = StubChatClient({"decision": "abstain", "rationale": ""})
        asyncio.run(_reviewer(client, lens).review_claim(_request(lens)))
        briefs.add(client.calls[0][0].text)

    # Three reviewers doing three different jobs, not one prompt sent three times.
    assert len(briefs) == 3


def test_the_panel_exposes_one_reviewer_per_lens() -> None:
    panel = build_foundry_panel(StubChatClient({}), CONFIG, timestamp=TIMESTAMP)

    assert [reviewer.lens for reviewer in panel.reviewers] == list(ReviewLens)


def test_the_prompt_sends_message_objects_not_bare_strings() -> None:
    client = StubChatClient({"claims": []})

    asyncio.run(_extractor(client).extract(CREATOR, _page()))
    messages = client.calls[0]

    assert [message.role for message in messages] == ["system", "user"]
    # A bare string content would be read one character at a time by the framework.
    assert "Atlas 3" in messages[1].text


def test_an_unusable_response_is_retryable_and_reports_its_cost() -> None:
    client = StubChatClient("not json at all", tokens=77)

    with pytest.raises(ProviderError) as error:
        asyncio.run(_reviewer(client).review_claim(_request()))

    assert error.value.retryable is True
    assert error.value.tokens_used == 77


def test_an_unknown_decision_is_never_silently_accepted() -> None:
    client = StubChatClient({"decision": "probably", "rationale": "unsure"})

    with pytest.raises(ProviderError) as error:
        asyncio.run(_reviewer(client).review_claim(_request()))

    assert "unknown decision" in str(error.value)
