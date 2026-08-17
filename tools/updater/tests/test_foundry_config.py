"""Foundry configuration is env-driven and keyless, and never needed offline."""

from __future__ import annotations

import pytest

from modeltree_updater.providers.base import ProviderError
from modeltree_updater.providers.foundry import (
    DEFAULT_API_VERSION,
    DEFAULT_SCOPE,
    FoundryConfig,
)


def test_config_reads_the_deployment_from_the_environment() -> None:
    config = FoundryConfig.from_env(
        {
            "MODELTREE_FOUNDRY_ENDPOINT": "https://example-foundry.services.ai.azure.com",
            "MODELTREE_FOUNDRY_DEPLOYMENT": "gpt-4.1-mini",
        }
    )

    assert config.deployment == "gpt-4.1-mini"
    assert config.api_version == DEFAULT_API_VERSION
    assert config.credential_scope == DEFAULT_SCOPE


def test_missing_configuration_is_an_explicit_error() -> None:
    with pytest.raises(ProviderError) as error:
        FoundryConfig.from_env({"MODELTREE_FOUNDRY_ENDPOINT": "https://example.invalid"})

    assert "MODELTREE_FOUNDRY_DEPLOYMENT" in str(error.value)


def test_the_descriptor_records_keyless_auth_and_no_secret() -> None:
    descriptor = FoundryConfig(
        endpoint="https://example-foundry.services.ai.azure.com",
        deployment="gpt-4.1-mini",
    ).descriptor

    assert descriptor["auth"] == "DefaultAzureCredential"
    assert not any("key" in key.lower() for key in descriptor)


def test_no_api_key_environment_variable_is_read() -> None:
    from modeltree_updater.providers import foundry

    source = foundry.__file__
    with open(source, encoding="utf-8") as handle:
        text = handle.read()

    assert "api_key" not in text
    assert "AZURE_OPENAI_API_KEY" not in text
