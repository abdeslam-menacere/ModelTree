"""Provider boundaries for the ModelTree updater."""

from .base import (
    ClaimExtractor,
    ClaimReviewer,
    ExtractionResult,
    ProviderBundle,
    ProviderError,
    ReviewResult,
    SourceProvider,
)
from .fixtures import (
    FixtureClaimExtractor,
    FixtureClaimReviewer,
    FixtureLibrary,
    FixtureSourceProvider,
    build_fixture_bundle,
    load_fixture_library,
)

__all__ = [
    "ClaimExtractor",
    "ClaimReviewer",
    "ExtractionResult",
    "FixtureClaimExtractor",
    "FixtureClaimReviewer",
    "FixtureLibrary",
    "FixtureSourceProvider",
    "ProviderBundle",
    "ProviderError",
    "ReviewResult",
    "SourceProvider",
    "build_fixture_bundle",
    "load_fixture_library",
]
