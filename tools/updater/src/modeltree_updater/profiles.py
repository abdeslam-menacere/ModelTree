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
from .layout import source_checkout_dir

__all__ = [
    "DEFAULT_PROFILES_DIR",
    "PROFILES_ARE_REPOSITORY_DATA",
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
    "source_checkout_profiles",
]

# Profiles live beside the offline fixtures: reviewable, version-controlled data that
# the tool reads, never bytes it writes. They are deliberately not packaged, for a
# reason of this project's own rather than a packaging preference — a profile decides
# which sources are trusted and what may be extracted from them, so a copy inside a
# wheel could disagree with the reviewed set in the repository and nothing would say
# which one a run had used. The consequence is that a default only exists when the
# updater runs out of a checkout, and an installed distribution must be told where the
# repository is. #147.
PROFILES_ARE_REPOSITORY_DATA = (
    "hint: creator profiles are reviewed, version-controlled repository data, so "
    "they are deliberately not packaged into the modeltree-updater distribution, "
    "because a packaged copy could drift from the reviewed set. They live in the "
    "repository at tools/updater/profiles. Pass --profiles with a path to that "
    "directory (from tools/updater in a checkout: --profiles profiles)."
)


def source_checkout_profiles(module_file: Path | str = __file__) -> Path | None:
    """The reviewed creator profiles directory, or ``None`` when there is not one.

    The same layout check the fixtures default resolves through, applied to the
    other directory this repository keeps outside the wheel — see
    :func:`~modeltree_updater.layout.source_checkout_dir` for why the walk to
    ``tools/updater`` is a question rather than an answer.
    """
    project_dir = source_checkout_dir(module_file)
    if project_dir is None:
        return None
    return project_dir / "profiles"


DEFAULT_PROFILES_DIR = source_checkout_profiles()


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


def _reviewed_profile_paths(directory: Path, *, kind: str) -> list[Path]:
    """The documents in a reviewed set, decided the same way on every platform.

    ``glob("*.json")`` is case-insensitive on Windows and case-sensitive on Linux, so
    a file named ``profile.JSON`` was a reviewed profile on one and did not exist on
    the other. A contributor could add a profile, watch it work locally, and have it
    silently absent from CI. Discovery here matches the suffix ``.json`` exactly, which
    is the same answer everywhere because a directory listing preserves the name's case.

    A file whose extension differs from ``.json`` only by case is **refused**, not
    skipped. Matching lowercase alone would make the platforms agree, but it would agree
    on silence: the contributor still gets a file that is not a profile and no reason
    why. The refusal is narrow — a ``.txt`` or ``.md`` neighbour is ignored as before,
    so only a file plainly meant to be a profile trips it.

    A name beginning with a dot is skipped, and skipped *first*. That is the deliberate
    asymmetry: a leading dot is the author saying "not part of the working set", so
    honouring it is honouring a stated intent, whereas an uppercased extension is a file
    someone meant as a profile where only the case was incidental.

    ``kind`` names what the caller's set holds, so a refusal reads as a sentence about
    the directory the reader is looking at. It is the *only* thing that differs between
    the two reviewed sets. The reviewed creator profiles loaded here and the reviewed
    long-tail profiles loaded by :mod:`~modeltree_updater.longtail` share one rule and
    one implementation of it, because holding the rule in two copies is precisely what
    let them drift into disagreeing about what a profile file is.
    """
    paths: list[Path] = []
    for path in sorted(directory.iterdir()):
        # A directory is not a candidate under either rule: refusing `archive.JSON`
        # for its extension, and handing `archive.json` to the parser, are both the
        # wrong answer to something that was never a document.
        if path.name.startswith(".") or not path.is_file():
            continue
        if path.suffix == ".json":
            paths.append(path)
        elif path.suffix.casefold() == ".json":
            raise ProfileError(
                f"{path.name}: {kind} must end in '.json' exactly, "
                f"not {path.suffix!r}; keeping it would leave the reviewed set to depend "
                "on whether the filesystem reading it is case-sensitive, so rename the file"
            )
    return paths


def _duplicate_key(profile_id: str) -> str:
    """The key two documents collide on, which is broader than the key they load under.

    Two ids differing only in case are one id to the reader the duplicate check exists
    for: it is there so that nobody has to work out which of two similar documents won.
    Folding is not a *superset* of comparing declared ids, though, and does not replace
    it: ``True`` and ``1`` fold to different strings while being one dict key, so both
    loaders guard on both key spaces. What folding cannot do is widen what an id
    *matches*, because the mapping a run reads is still keyed by the exact declared
    string — a lookup must keep answering to the exact id it was given.

    ``str()`` because a document can declare a non-string id, and refusing that is a
    different question from this one.
    """
    return str(profile_id).casefold()


def load_profile_library(
    directory: Path | str | None = DEFAULT_PROFILES_DIR,
) -> ProfileLibrary:
    """Load every reviewed creator profile in a directory, keyed by declared id.

    Which files are candidates is :func:`_reviewed_profile_paths`' decision, and it is
    the same decision on every operating system — the reviewed set of *dedicated*
    profiles is what distinguishes a reviewed creator from a long-tail one, so a
    profile that is present locally and absent in CI silently downgrades a creator.

    A duplicate id is refused for the same reason it is in
    :func:`~modeltree_updater.longtail.load_long_tail_library`: a caller asks for a
    creator by id and :class:`ProfileLibrary` answers exactly, so two documents
    answering to one id would make that answer depend on how the asker spelled it.

    ``None`` is the installed distribution, which has no default because the profiles
    are not in the wheel. It is refused with the flag to pass and the directory in the
    repository to point it at, never with the path the old guess would have produced:
    a prefix path nobody wrote is reported as if someone had asked for it (#147).
    """
    if directory is None:
        raise FileNotFoundError(
            "no creator profiles directory: this updater is running from an "
            f"installed distribution, which has no default.\n{PROFILES_ARE_REPOSITORY_DATA}"
        )
    directory = Path(directory)
    if not directory.is_dir():
        raise FileNotFoundError(
            f"profiles directory not found: {directory}\n{PROFILES_ARE_REPOSITORY_DATA}"
        )

    profiles: dict[str, CreatorProfile] = {}
    sources: dict[Any, tuple[str, Path]] = {}
    for path in _reviewed_profile_paths(directory, kind="a reviewed creator profile"):
        profile = load_profile(path)
        key = _duplicate_key(profile.creator_id)
        # Neither key space contains the other. Folding catches 'x' against 'X'; the
        # declared id catches ids that fold apart but are one dict key, such as True
        # and 1, which plain dict equality already refused and which folding alone
        # would let overwrite in silence.
        if key in sources or profile.creator_id in profiles:
            twin_id, twin_path = sources.get(key) or sources[profile.creator_id]
            reason = (
                "an id has to name exactly one reviewed profile, because a caller asks "
                "for a creator by id and the library answers to that exact string"
            )
            if twin_id != profile.creator_id:
                reason = f"ids differing only in case are one id here, and {reason}"
            raise ProfileError(
                f"duplicate creator id {profile.creator_id!r} in {path.name} and "
                f"{twin_id!r} in {twin_path.name}: {reason}"
            )
        profiles[profile.creator_id] = profile
        sources[key] = (profile.creator_id, path)
        # Recorded under the declared id too, so the guard above can name the twin it
        # found through either key space.
        sources[profile.creator_id] = (profile.creator_id, path)
    if not profiles:
        raise FileNotFoundError(
            f"no creator profiles found in {directory}\n{PROFILES_ARE_REPOSITORY_DATA}"
        )
    return ProfileLibrary(profiles=profiles)
