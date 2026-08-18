"""The source scout: turn leads into sources *for review*, never into evidence.

A scout works from leads — the kind of thing a search returns: a URL, a title, and
maybe a snippet of surrounding text. A lead is not proof. Its snippet may hint at why
a page is worth reading, but it is never stored as a claim's evidence; only the bytes
a source actually serves, quoted after the page is read, can back a claim.

So the scout's whole job is triage, expressed through the profile's trusted catalog:

* A lead from an origin the profile already trusts becomes a **configured** source —
  a known seed, usable without a discovery vote.
* A lead from anywhere else becomes a **newly discovered** source, proposed for the
  recorded 2-of-3 review path. A reviewer decides; the scout does not.

The types here make the evidence boundary structural rather than a matter of
discipline: a :class:`ScoutFinding` and a :class:`SourceProposal` have nowhere to put
an :class:`~modeltree_updater.contracts.Evidence` record, and the scout produces
neither evidence nor claims. A snippet travels only as ``search_snippet`` — a
human-readable reason to review the page.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence
from urllib.parse import urlsplit

from .contracts import Evidence, SourceCandidate, SourceKind, _Serialisable
from .profiles import CreatorProfile, TrustedSource, origin_of

__all__ = [
    "ScoutFinding",
    "SourceProposal",
    "SourceScout",
    "snippet_is_never_evidence",
]


@dataclass(frozen=True)
class ScoutFinding(_Serialisable):
    """A lead: a pointer to a page, and at most a snippet hinting at its relevance.

    The snippet is deliberately typed as free text, not evidence. It is a reason to
    go and read the page, never a substitute for having read it.
    """

    url: str
    title: str
    publisher: str
    snippet: str | None = None
    # The kind the *finder* guessed. It is a proposal; review confirms or rejects it.
    proposed_kind: SourceKind = SourceKind.OFFICIAL_ANNOUNCEMENT


@dataclass(frozen=True)
class SourceProposal(_Serialisable):
    """A scouted source put forward for the pipeline, with its triage recorded.

    ``newly_discovered`` decides whether it must pass the 2-of-3 review path. When the
    lead matched a catalog entry, ``trusted_source_id`` names it. ``search_snippet``
    carries the lead's snippet as a review aid only — it never becomes evidence.
    """

    candidate: SourceCandidate
    newly_discovered: bool
    reason: str
    trusted_source_id: str | None = None
    search_snippet: str | None = None


def snippet_is_never_evidence(finding: ScoutFinding) -> Evidence:
    """There is no conversion from a lead to evidence. Calling this always fails.

    It exists so the rule is executable and greppable: a search snippet cannot be
    laundered into a claim's evidence. Evidence is only ever built after a source is
    fetched and quoted, in the extraction stage — not from a scouted lead.
    """
    raise TypeError(
        "a search snippet is a lead, not evidence: read the source and quote the "
        "served bytes instead. Nothing may turn a ScoutFinding into an Evidence record."
    )


@dataclass(frozen=True)
class SourceScout:
    """Triage leads for one creator against that creator's trusted catalog."""

    profile: CreatorProfile

    def classify(self, finding: ScoutFinding) -> tuple[bool, TrustedSource | None]:
        """Return ``(newly_discovered, matched_catalog_source)`` for one lead.

        A lead is configured only when it matches a catalog entry's origin *and* one
        of its allowed paths. A trusted origin reached by an un-admitted path is still
        a discovery — the seed's scope is part of what was reviewed.
        """
        trusted = self.profile.trusted_source_for(finding.url)
        if trusted is not None:
            return False, trusted
        return True, None

    def propose(self, finding: ScoutFinding, *, discovered_at: str) -> SourceProposal:
        """Turn one lead into a source proposal — carrying no evidence."""
        newly_discovered, trusted = self.classify(finding)
        candidate = SourceCandidate(
            id=_candidate_id(self.profile.creator_id, finding.url),
            creator_id=self.profile.creator_id,
            url=finding.url,
            title=finding.title,
            publisher=finding.publisher,
            kind=trusted.kind if trusted is not None else finding.proposed_kind,
            discovered_at=discovered_at,
        )
        if trusted is not None:
            reason = (
                f"configured source {trusted.id!r} (owner {trusted.owner!r}); usable "
                "without a discovery vote"
            )
        elif self.profile.is_configured_origin(finding.url):
            reason = (
                "trusted origin but outside its allowed paths; proposed for review "
                "before any claim may rest on it"
            )
        else:
            reason = (
                "origin is not in this creator's trusted catalog; proposed for the "
                "2-of-3 review path before use"
            )
        return SourceProposal(
            candidate=candidate,
            newly_discovered=newly_discovered,
            reason=reason,
            trusted_source_id=trusted.id if trusted is not None else None,
            # The snippet is a review aid, nothing more. It is never evidence.
            search_snippet=finding.snippet,
        )

    def scout(
        self, findings: Sequence[ScoutFinding], *, discovered_at: str
    ) -> tuple[SourceProposal, ...]:
        """Triage a batch of leads, preserving their order."""
        return tuple(self.propose(finding, discovered_at=discovered_at) for finding in findings)

    def newly_discovered(
        self, findings: Sequence[ScoutFinding], *, discovered_at: str
    ) -> tuple[SourceProposal, ...]:
        """Only the proposals that must pass the recorded review path."""
        return tuple(
            proposal
            for proposal in self.scout(findings, discovered_at=discovered_at)
            if proposal.newly_discovered
        )


def _candidate_id(creator_id: str, url: str) -> str:
    """A stable, slug-shaped id for a scouted source, derived from its origin+path."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().replace(".", "-")
    path = (parts.path or "").strip("/").replace("/", "-")
    tail = "-".join(filter(None, (host, path)))
    cleaned = "".join(character if character.isalnum() or character == "-" else "-" for character in tail)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    cleaned = cleaned.strip("-") or "source"
    return f"{creator_id}-scouted-{cleaned}"
