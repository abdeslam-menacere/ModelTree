"""Version-controlled creator profiles and the trusted source catalog.

Specialised creator research is *one* implementation instantiated with data, not a
family of creator-specific code paths. Everything that differs between OpenAI,
Anthropic, Google DeepMind, and Meta — their terminology, how they name families and
releases, which sources are trusted, what may be extracted, and where they are known
to be ambiguous — lives in ``profiles/<id>.json`` and is loaded here.

Two rules this module exists to keep:

* **No creator-specific branches.** There is deliberately no ``if creator == "openai"``
  anywhere; the four profiles travel through the same code. A profile is data.
* **A trusted source is not fetched here.** This module describes *which* sources are
  trusted and *what* may be extracted from them, with an owner and a verification
  date. It never reaches the network — runtime fetching is a separate concern.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

from .contracts import CreatorRequest, SourceKind, _Serialisable

__all__ = [
    "DEFAULT_PROFILES_DIR",
    "CreatorProfile",
    "ExtractionRules",
    "NamingRule",
    "ProfileError",
    "ProfileLibrary",
    "SourceAmbiguity",
    "TrustedSource",
    "load_profile",
    "load_profile_library",
    "origin_of",
]

# Profiles live beside the offline fixtures: reviewable, version-controlled data that
# the tool reads, never bytes it writes.
DEFAULT_PROFILES_DIR = Path(__file__).resolve().parents[2] / "profiles"


class ProfileError(ValueError):
    """A profile file is missing a required field or is internally inconsistent."""


def origin_of(url: str) -> str:
    """Scheme + lowercased host, the unit at which a source's ownership is judged.

    Origin, not exact URL: a creator's news feed and its release notes share an
    origin, and comparing whole paths would make "is this a configured source?"
    meaningless.
    """
    parts = urlsplit(url)
    return f"{parts.scheme}://{(parts.hostname or '').lower()}"


@dataclass(frozen=True)
class TrustedSource(_Serialisable):
    """One entry in a creator's trusted source catalog.

    It records who owns the source, which paths and content types may be extracted
    from it, how far it is trusted, and when a human last verified it. It carries no
    page text and no extracted facts — it is a description of a source, not a claim.
    """

    id: str
    owner: str
    url: str
    kind: SourceKind
    # What may be read from this source, and how far to trust it. Paths are prefix
    # matched against a candidate URL's path; content types are advisory labels for
    # the extractor.
    allowed_paths: tuple[str, ...] = ()
    allowed_content_types: tuple[str, ...] = ()
    trust: str = "primary"
    trust_notes: str | None = None
    # Verification metadata: every important fact carries a primary source and a date.
    verified_at: str | None = None
    verification: str | None = None

    @property
    def origin(self) -> str:
        return origin_of(self.url)

    def allows_path(self, url: str) -> bool:
        """Whether a candidate URL sits under one of this source's allowed paths.

        With no allowed paths configured, the whole origin is in scope; otherwise the
        candidate's path must begin with one of them.
        """
        if origin_of(url) != self.origin:
            return False
        if not self.allowed_paths:
            return True
        path = urlsplit(url).path or "/"
        return any(path.startswith(prefix) for prefix in self.allowed_paths)


@dataclass(frozen=True)
class NamingRule(_Serialisable):
    """How this creator names one kind of thing, with an example."""

    subject: str  # family | model | release | api-alias | product
    rule: str
    example: str | None = None


@dataclass(frozen=True)
class SourceAmbiguity(_Serialisable):
    """A place this creator is known to be ambiguous.

    Recorded, not resolved: the guidance is what a human should do, so the tool never
    silently smooths a conflict away.
    """

    topic: str
    note: str
    guidance: str = "leave explicit; do not guess"


@dataclass(frozen=True)
class ExtractionRules(_Serialisable):
    """What a run is allowed to extract for this creator, and how."""

    entity_kinds: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class CreatorProfile(_Serialisable):
    """A single creator's research profile, loaded from version-controlled data."""

    creator_id: str
    creator_name: str
    creator_type: str
    aliases: tuple[str, ...]
    terminology: Mapping[str, str]
    naming_rules: tuple[NamingRule, ...]
    catalog: tuple[TrustedSource, ...]
    extraction: ExtractionRules
    ambiguities: tuple[SourceAmbiguity, ...]
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def configured_origins(self) -> frozenset[str]:
        """Every origin the profile already trusts. A source outside this set is a
        discovery and must earn its place through review."""
        return frozenset(source.origin for source in self.catalog)

    def trusted_source_for(self, url: str) -> TrustedSource | None:
        """The catalog entry that admits ``url``, if any (owner and allowed paths)."""
        for source in self.catalog:
            if source.allows_path(url):
                return source
        return None

    def is_configured_origin(self, url: str) -> bool:
        return origin_of(url) in self.configured_origins

    def to_creator_request(self) -> CreatorRequest:
        """The workflow's view of this creator.

        The entry URLs are the catalog's trusted origins, so the pipeline's
        newly-discovered-source test agrees with the profile: a source from a
        configured origin is trusted, anything else is routed through the panel.
        """
        entry_urls = tuple(dict.fromkeys(source.url for source in self.catalog))
        return CreatorRequest(
            creator_id=self.creator_id,
            creator_name=self.creator_name,
            entry_urls=entry_urls,
            notes=self.notes[0] if self.notes else None,
        )


@dataclass(frozen=True)
class ProfileLibrary:
    """The loaded profiles, keyed by creator id."""

    profiles: Mapping[str, CreatorProfile]

    def __getitem__(self, creator_id: str) -> CreatorProfile:
        try:
            return self.profiles[creator_id]
        except KeyError as error:
            raise ProfileError(f"no profile for creator {creator_id!r}") from error

    def __iter__(self):
        return iter(self.profiles.values())

    def __len__(self) -> int:
        return len(self.profiles)

    @property
    def creator_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self.profiles))

    @property
    def catalog(self) -> tuple[TrustedSource, ...]:
        """The whole trusted source catalog across every loaded profile."""
        return tuple(source for profile in self for source in profile.catalog)


def _require(document: Mapping[str, Any], key: str, *, path: Path) -> Any:
    if key not in document:
        raise ProfileError(f"{path.name}: missing required field {key!r}")
    return document[key]


def _source_kind(value: Any, *, path: Path) -> SourceKind:
    try:
        return SourceKind(value)
    except ValueError as error:
        raise ProfileError(f"{path.name}: unknown source kind {value!r}") from error


def _trusted_source(raw: Mapping[str, Any], *, path: Path) -> TrustedSource:
    return TrustedSource(
        id=_require(raw, "id", path=path),
        owner=_require(raw, "owner", path=path),
        url=_require(raw, "url", path=path),
        kind=_source_kind(_require(raw, "kind", path=path), path=path),
        allowed_paths=tuple(raw.get("allowed_paths", ())),
        allowed_content_types=tuple(raw.get("allowed_content_types", ())),
        trust=raw.get("trust", "primary"),
        trust_notes=raw.get("trust_notes"),
        verified_at=raw.get("verified_at"),
        verification=raw.get("verification"),
    )


def _naming_rule(raw: Mapping[str, Any], *, path: Path) -> NamingRule:
    return NamingRule(
        subject=_require(raw, "subject", path=path),
        rule=_require(raw, "rule", path=path),
        example=raw.get("example"),
    )


def _ambiguity(raw: Mapping[str, Any], *, path: Path) -> SourceAmbiguity:
    return SourceAmbiguity(
        topic=_require(raw, "topic", path=path),
        note=_require(raw, "note", path=path),
        guidance=raw.get("guidance", "leave explicit; do not guess"),
    )


def load_profile(path: Path | str) -> CreatorProfile:
    """Load one creator profile from JSON, failing loudly on a malformed file."""
    path = Path(path)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except (OSError, json.JSONDecodeError) as error:
        raise ProfileError(f"{path.name}: could not be read: {error}") from error

    creator = _require(document, "creator", path=path)
    catalog = tuple(
        _trusted_source(raw, path=path)
        for raw in _require(document, "source_catalog", path=path)
    )
    if not catalog:
        raise ProfileError(f"{path.name}: source_catalog must list at least one source")

    extraction_raw = document.get("extraction_rules", {})
    profile = CreatorProfile(
        creator_id=_require(creator, "id", path=path),
        creator_name=_require(creator, "name", path=path),
        creator_type=creator.get("type", "company"),
        aliases=tuple(creator.get("aliases", ())),
        terminology=dict(document.get("terminology", {})),
        naming_rules=tuple(
            _naming_rule(raw, path=path) for raw in document.get("naming_rules", ())
        ),
        catalog=catalog,
        extraction=ExtractionRules(
            entity_kinds=tuple(extraction_raw.get("entity_kinds", ())),
            notes=tuple(extraction_raw.get("notes", ())),
        ),
        ambiguities=tuple(
            _ambiguity(raw, path=path) for raw in document.get("ambiguities", ())
        ),
        notes=tuple(document.get("notes", ())),
    )
    return profile


def load_profile_library(directory: Path | str = DEFAULT_PROFILES_DIR) -> ProfileLibrary:
    """Load every ``*.json`` profile in a directory through the one shared path."""
    directory = Path(directory)
    if not directory.is_dir():
        raise FileNotFoundError(f"profiles directory not found: {directory}")

    profiles: dict[str, CreatorProfile] = {}
    for path in sorted(directory.glob("*.json")):
        profile = load_profile(path)
        if profile.creator_id in profiles:
            raise ProfileError(
                f"duplicate creator id {profile.creator_id!r} in {path.name}"
            )
        profiles[profile.creator_id] = profile
    if not profiles:
        raise FileNotFoundError(f"no creator profiles found in {directory}")
    return ProfileLibrary(profiles=profiles)
