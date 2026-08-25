"""Local CLI for the proposal-only ModelTree updater.

Typical use, with no network and no cloud credentials::

    python -m modeltree_updater run --creator anthropic --output out/proposals
    python -m modeltree_updater publish --report out/proposals/<run-id>/report.json --dry-run

The CLI selects creators, applies per-creator budgets, writes proposal JSON to a
directory outside the web app, and reports what it could not finish. `publish`
turns a written artefact into one GitHub issue per material creator; `--dry-run`
prints the exact payload and sends nothing.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

from .budgets import CreatorBudget, InvalidBudget
from .checkpoints import (
    create_checkpoint_storage,
    list_checkpoint_summaries,
)
from .contracts import ProposalStatus, RunReport
from .github_issues import DEFAULT_API_URL, GitHubError, RestIssuesClient
from .longtail import DEFAULT_LONG_TAIL_PROFILE_ID, reviewed_long_tail_profile
from .parsing import ArtifactError, load_run_report
from .providers.base import ProviderBundle, ProviderError
from .providers.fixtures import (
    FixtureClaimExtractor,
    FixtureSourceProvider,
    build_fixture_panel,
    load_fixture_library,
)
from .providers.network import NetworkSourceProvider
from .publisher import (
    UNREADABLE_RUN,
    PublicationAction,
    PublicationError,
    PublicationReport,
    publish_report,
)
from .runner import resume_creator_run, run_creators
from .safety import ProposalOnlyViolation, assert_proposal_output_path
from .profiles import DEFAULT_PROFILES_DIR, ProfileError, load_profile_library
from .workflow import WORKFLOW_NAME, RunSettings

__all__ = ["main", "build_parser"]

DEFAULT_FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "creators"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CREATOR_FAILED = 3
EXIT_PUBLISH_FAILED = 4


def _default_timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="modeltree-updater",
        description=(
            "Propose source-backed ModelTree updates. This tool never writes dataset "
            "JSON, never creates a branch, and never opens a pull request."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="run the workflow for one or more creators")
    run.add_argument(
        "--creator",
        dest="creators",
        action="append",
        default=[],
        help="creator id to update; repeat for several. Defaults to every fixture creator.",
    )
    run.add_argument(
        "--fixtures",
        type=Path,
        default=DEFAULT_FIXTURES,
        help="directory of creator fixture files",
    )
    run.add_argument(
        "--provider",
        choices=("fixtures", "foundry"),
        default="fixtures",
        help="fixtures runs offline; foundry uses a Microsoft Foundry deployment for the models",
    )
    run.add_argument(
        "--sources",
        choices=("fixtures", "network"),
        default="fixtures",
        help=(
            "where sources come from: fixtures reads synthetic pages offline (default); "
            "network fetches the creator's real seed URLs over HTTPS"
        ),
    )
    run.add_argument("--output", type=Path, help="directory to write proposal JSON into")
    run.add_argument(
        "--long-tail",
        dest="long_tail",
        action="store_true",
        help=(
            "process these creators under the generic long-tail profile: acceptance "
            "needs all three reviewers, unsettled naming/ownership/lineage mappings "
            "are recorded as conflicts, and each creator is assessed for whether it "
            "merits a dedicated profile. Opt in explicitly - it is not a fallback, "
            "because the threshold a proposal was decided under must be a choice."
        ),
    )
    run.add_argument(
        "--long-tail-profile",
        dest="long_tail_profile",
        metavar="ID",
        default=None,
        help=(
            "id of the reviewed generic profile --long-tail applies; omitted, "
            f"--long-tail applies {DEFAULT_LONG_TAIL_PROFILE_ID}. Requires "
            "--long-tail, and without it the command is refused rather than "
            "ignored, so naming a profile cannot leave a run at the ordinary "
            "majority bar. Only the profiles reviewed into profiles/generic/ can "
            "be named: a profile decides the promotion criteria and which mappings "
            "stay explicit, so it is a reviewed artefact of this repository, not a "
            "file handed in at run time."
        ),
    )
    run.add_argument("--checkpoint-dir", type=Path, help="directory for durable checkpoints")
    run.add_argument("--run-id", help="identifier recorded in the proposals")
    run.add_argument("--timestamp", help="ISO timestamp recorded in the proposals")
    run.add_argument("--max-pages", type=int, help="page budget per creator")
    run.add_argument("--max-tokens", type=int, help="token budget per creator")
    run.add_argument("--max-seconds", type=float, help="wall-clock budget per creator")
    run.add_argument("--max-retries", type=int, help="retry budget per creator")

    creators = subparsers.add_parser("creators", help="list creators available in the fixtures")
    creators.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)

    publish = subparsers.add_parser(
        "publish",
        help="create or update one GitHub proposal issue per material creator",
        description=(
            "Publish a written run artefact as GitHub issues. One open issue per "
            "creator, updated in place on a rerun. A creator with nothing material "
            "to report creates no issue and causes no GitHub request at all. This "
            "command can only create and edit issues; it cannot touch repository "
            "content, a branch, or a pull request."
        ),
    )
    publish.add_argument(
        "--report",
        type=Path,
        required=True,
        help="the report.json written by `run --output`",
    )
    publish.add_argument(
        "--repo",
        help="target repository as owner/name; defaults to $GITHUB_REPOSITORY",
    )
    publish.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "print the exact issue title and body that would be sent, and send "
            "nothing. Needs no repository, no token, and no network."
        ),
    )

    profiles = subparsers.add_parser(
        "profiles",
        help="list version-controlled creator profiles and their trusted source catalog",
    )
    profiles.add_argument(
        "--profiles",
        dest="profiles_dir",
        type=Path,
        default=DEFAULT_PROFILES_DIR,
        help="directory of creator profile files",
    )
    profiles.add_argument(
        "--json",
        dest="as_json",
        action="store_true",
        help="emit the catalog as JSON instead of a summary table",
    )

    checkpoints = subparsers.add_parser("checkpoints", help="list stored checkpoints")
    checkpoints.add_argument("--checkpoint-dir", type=Path, required=True)

    resume = subparsers.add_parser("resume", help="resume a checkpointed creator run")
    resume.add_argument("--checkpoint-id", required=True)
    resume.add_argument("--checkpoint-dir", type=Path, required=True)
    resume.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    resume.add_argument(
        "--provider",
        choices=("fixtures", "foundry"),
        default="fixtures",
        help="must match the providers recorded in the checkpoint; a resume never substitutes them",
    )
    resume.add_argument(
        "--sources",
        choices=("fixtures", "network"),
        default="fixtures",
        help="must match the source provider recorded in the checkpoint",
    )
    resume.add_argument("--output", type=Path)
    resume.add_argument("--run-id")
    resume.add_argument("--timestamp")
    # Deliberately no --long-tail here. The review policy and the profile are read
    # out of the checkpoint, so resuming cannot change the bar a run is judged by,
    # and forgetting a flag cannot silently downgrade it.

    return parser


def _budget(args: argparse.Namespace, env: Mapping[str, str]) -> CreatorBudget:
    base = CreatorBudget.from_env(env)
    return CreatorBudget(
        max_pages=args.max_pages if getattr(args, "max_pages", None) is not None else base.max_pages,
        max_tokens=(
            args.max_tokens if getattr(args, "max_tokens", None) is not None else base.max_tokens
        ),
        max_seconds=(
            args.max_seconds if getattr(args, "max_seconds", None) is not None else base.max_seconds
        ),
        max_retries=(
            args.max_retries if getattr(args, "max_retries", None) is not None else base.max_retries
        ),
    )


def _build_providers(
    provider: str,
    library,
    *,
    sources_kind: str = "fixtures",
    timestamp: str,
    env: Mapping[str, str],
) -> ProviderBundle:
    if sources_kind == "network":
        sources = NetworkSourceProvider()
    else:
        sources = FixtureSourceProvider(library, timestamp=timestamp)
    if provider == "fixtures":
        return ProviderBundle(
            sources=sources,
            extractor=FixtureClaimExtractor(library, timestamp=timestamp),
            panel=build_fixture_panel(library, timestamp=timestamp),
        )

    # Imported here so an offline run never needs the Azure packages installed.
    from .providers.foundry import (
        FoundryClaimExtractor,
        FoundryConfig,
        build_chat_client,
        build_foundry_panel,
    )

    config = FoundryConfig.from_env(env)
    client = build_chat_client(config)
    return ProviderBundle(
        sources=sources,
        extractor=FoundryClaimExtractor(
            client, config, timestamp=timestamp, verified_at=timestamp[:10]
        ),
        panel=build_foundry_panel(client, config, timestamp=timestamp),
    )


SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def _safe_filename(value: str, *, kind: str) -> str:
    """Names that reach the filesystem are checked, not interpolated on trust.

    Creator and run ids come from fixture files, so a traversal-shaped id would
    otherwise steer a write out of the guarded output directory.
    """
    if not SAFE_NAME.match(value):
        raise ProposalOnlyViolation(
            f"refusing to use {value!r} as a {kind} filename: expected lowercase "
            "letters, digits, dot, underscore, or hyphen"
        )
    return value


def _write_report(report: RunReport, output: Path | None, stream) -> None:
    if output is None:
        stream.write(report.to_json())
        return

    root = assert_proposal_output_path(output)
    directory = assert_proposal_output_path(
        root / _safe_filename(report.run_id, kind="run id")
    )
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "report.json").write_text(report.to_json(), encoding="utf-8")
    for proposal in report.proposals:
        name = _safe_filename(proposal.creator_id, kind="creator id")
        path = assert_proposal_output_path(directory / f"{name}.json")
        path.write_text(proposal.to_json(), encoding="utf-8")
    stream.write(f"wrote {len(report.proposals)} proposal(s) to {directory}\n")


def _summarise(report: RunReport, stream) -> int:
    for proposal in report.proposals:
        stream.write(
            f"{proposal.creator_id}: {proposal.status.value} "
            f"({len(proposal.claims)} claim(s), {len(proposal.accepted_claim_ids)} accepted, "
            f"{len(proposal.conflicts)} conflict(s), {len(proposal.failures)} failure(s))\n"
        )
        if proposal.promotion is not None:
            verdict = "recommended" if proposal.promotion.recommended else "not recommended"
            met = sum(1 for item in proposal.promotion.criteria if item.met)
            stream.write(
                f"  dedicated profile {verdict} "
                f"({met}/{len(proposal.promotion.criteria)} criteria met); "
                "a human decides whether to create one\n"
            )
    return EXIT_CREATOR_FAILED if report.failed_creator_ids else EXIT_OK


def _long_tail_profile(args: argparse.Namespace):
    """The generic profile for this run, or None when none was asked for.

    Resolved by id against the reviewed set. A path is refused rather than loaded:
    an unreviewed document would decide this run's promotion criteria and its
    unresolved-mapping topics, and a checkpoint records only the profile *id*, so a
    file that is not in the reviewed set could not be reattached on resume anyway.

    ``--long-tail-profile`` without ``--long-tail`` is refused rather than either
    ignored or read as an implied opt-in. Ignoring it was the defect: the run went
    ahead under the ordinary majority policy while the operator had named the
    profile carrying the unanimous one, and nothing said so. Inferring the opt-in
    would fix the silence but decide the review threshold on the operator's behalf,
    which is what ``--long-tail``'s own help refuses ("it is not a fallback, because
    the threshold a proposal was decided under must be a choice"). Refusing states
    the mismatch and makes the operator name the bar; it also stays reversible,
    since the only invocation that changes behaviour is the one that was silently
    mis-running, and a later decision could still relax this to an implied opt-in.
    """
    requested = getattr(args, "long_tail_profile", None)
    if not getattr(args, "long_tail", False):
        if requested is not None:
            raise ProfileError(
                f"--long-tail-profile ({requested!r}) needs --long-tail: the named "
                "profile is applied only by the long-tail path, so on its own this "
                "flag would leave the run at the ordinary 2-of-3 majority bar. Pass "
                "--long-tail as well to run under it, or drop --long-tail-profile."
            )
        return None
    if requested is None:
        return reviewed_long_tail_profile(DEFAULT_LONG_TAIL_PROFILE_ID)
    requested = str(requested)
    if requested.endswith(".json") or "/" in requested or "\\" in requested:
        raise ProfileError(
            f"--long-tail-profile takes the id of a reviewed profile, not a path "
            f"({requested!r}); the reviewed profiles live in profiles/generic/"
        )
    return reviewed_long_tail_profile(requested)


def _run(args: argparse.Namespace, env: Mapping[str, str], stream) -> int:
    library = load_fixture_library(args.fixtures)
    creator_ids = args.creators or list(library.creator_ids)
    unknown = [creator_id for creator_id in creator_ids if creator_id not in library.creators]
    if unknown:
        stream.write(f"unknown creator id(s): {', '.join(sorted(unknown))}\n")
        return EXIT_USAGE

    # Resolved before any provider is built, so a refused flag pair is reported as
    # itself rather than behind whatever a half-configured provider complains about.
    long_tail = _long_tail_profile(args)

    timestamp = args.timestamp or _default_timestamp()
    run_id = args.run_id or "run-" + re.sub(r"[^a-z0-9]+", "", timestamp.lower())
    providers = _build_providers(
        args.provider,
        library,
        sources_kind=args.sources,
        timestamp=timestamp,
        env=env,
    )
    settings = RunSettings(
        providers,
        budget=_budget(args, env),
        timestamp=timestamp,
        long_tail=long_tail,
    )

    storage = (
        create_checkpoint_storage(args.checkpoint_dir) if args.checkpoint_dir else None
    )
    report = asyncio.run(
        run_creators(
            [library.creators[creator_id] for creator_id in creator_ids],
            settings,
            run_id=run_id,
            checkpoint_storage=storage,
        )
    )
    _write_report(report, args.output, stream)
    return _summarise(report, stream)


def _resume(args: argparse.Namespace, env: Mapping[str, str], stream) -> int:
    library = load_fixture_library(args.fixtures)
    timestamp = args.timestamp or _default_timestamp()
    providers = _build_providers(
        args.provider,
        library,
        sources_kind=args.sources,
        timestamp=timestamp,
        env=env,
    )
    settings = RunSettings(providers, budget=_budget(args, env), timestamp=timestamp)
    storage = create_checkpoint_storage(args.checkpoint_dir)

    proposal = asyncio.run(
        resume_creator_run(
            settings,
            checkpoint_id=args.checkpoint_id,
            checkpoint_storage=storage,
        )
    )
    report = RunReport(
        run_id=args.run_id or proposal.run_id,
        started_at=timestamp,
        completed_at=timestamp,
        proposals=(proposal,),
        settings={
            "resumed_from": args.checkpoint_id,
            "providers": providers.descriptor,
            "mode": "proposal-only",
        },
    )
    _write_report(report, args.output, stream)
    return _summarise(report, stream)


def _summarise_publication(result: PublicationReport, stream) -> int:
    """Report exactly what was, or would be, sent.

    A dry run prints the payload verbatim — the same string a real publication
    would send — so it can be reviewed, diffed, or piped somewhere before anyone
    grants this tool a token.
    """
    for outcome in result.outcomes:
        creator = outcome.creator_id
        if outcome.action is PublicationAction.SKIPPED_NO_CHANGE:
            stream.write(
                f"{creator}: nothing material to report; no issue created or updated\n"
            )
            continue
        if outcome.action is PublicationAction.RENDERED:
            payload = outcome.payload
            assert payload is not None  # RENDERED always carries its payload
            stream.write(f"=== {creator}: dry run, nothing was sent ===\n")
            stream.write(
                "note: nothing was read from GitHub, so this run has NOT checked "
                "for duplicate open proposals and cannot name a superseded run. A "
                "clean dry run is not evidence that neither exists; a real "
                "publication may add a publication-notes block, a superseded run, "
                "and a supersession comment.\n"
            )
            stream.write(f"title: {payload.title}\n")
            stream.write("body:\n")
            stream.write(payload.body)
            stream.write(f"=== end {creator} ===\n")
            continue
        duplicates = (
            " (duplicate open proposals left untouched: "
            + ", ".join(f"#{number}" for number in outcome.duplicates)
            + ")"
            if outcome.duplicates
            else ""
        )
        if outcome.superseded_run == UNREADABLE_RUN:
            superseded = "; replaced a body that could not be read, recorded in a comment"
        elif outcome.superseded_run:
            superseded = f"; superseded run {outcome.superseded_run}, recorded in a comment"
        else:
            superseded = ""
        stream.write(
            f"{creator}: {outcome.action.value} issue #{outcome.issue_number}"
            f"{superseded}{duplicates}\n"
        )

    for failure in result.failures:
        stream.write(f"{failure.creator_id}: publication failed: {failure.message}\n")
    return EXIT_PUBLISH_FAILED if result.failures else EXIT_OK


def _publish(args: argparse.Namespace, env: Mapping[str, str], stream) -> int:
    report = load_run_report(args.report)

    if args.dry_run:
        return _summarise_publication(
            publish_report(report, None, dry_run=True), stream
        )

    repository = args.repo or env.get("GITHUB_REPOSITORY", "")
    if not repository:
        stream.write(
            "error: --repo (or GITHUB_REPOSITORY) is required to publish; "
            "use --dry-run to render the payload instead\n"
        )
        return EXIT_USAGE

    token = env.get("GITHUB_TOKEN", "")
    if not token:
        stream.write(
            "error: GITHUB_TOKEN is required to publish; --dry-run needs no credentials\n"
        )
        return EXIT_USAGE

    client = RestIssuesClient(
        repository=repository,
        token=token,
        api_url=env.get("GITHUB_API_URL") or DEFAULT_API_URL,
    )
    return _summarise_publication(publish_report(report, client), stream)


def _checkpoints(args: argparse.Namespace, stream) -> int:
    storage = create_checkpoint_storage(args.checkpoint_dir)
    summaries = asyncio.run(list_checkpoint_summaries(storage, workflow_name=WORKFLOW_NAME))
    stream.write(json.dumps(list(summaries), indent=2, default=str) + "\n")
    return EXIT_OK


def _creators(args: argparse.Namespace, stream) -> int:
    library = load_fixture_library(args.fixtures)
    for creator_id in library.creator_ids:
        creator = library.creators[creator_id]
        stream.write(f"{creator.creator_id}\t{creator.creator_name}\n")
    return EXIT_OK


def _profiles(args: argparse.Namespace, stream) -> int:
    """List the loaded creator profiles and their trusted source catalog.

    Read-only: the one shared loader parses every ``profiles/<id>.json`` and this
    command only reports what it found. It never fetches a source and never writes.
    """
    library = load_profile_library(args.profiles_dir)
    if args.as_json:
        catalogue = {
            profile.creator_id: {
                "creator_name": profile.creator_name,
                "aliases": list(profile.aliases),
                "terminology_keys": sorted(profile.terminology),
                "naming_rules": [rule.to_dict() for rule in profile.naming_rules],
                "ambiguities": [item.to_dict() for item in profile.ambiguities],
                "source_catalog": [source.to_dict() for source in profile.catalog],
            }
            for profile in library
        }
        stream.write(json.dumps(catalogue, indent=2, default=str) + "\n")
        return EXIT_OK

    for profile in library:
        stream.write(
            f"{profile.creator_id}\t{profile.creator_name}\t"
            f"{len(profile.catalog)} source(s), {len(profile.naming_rules)} naming rule(s), "
            f"{len(profile.ambiguities)} ambiguity note(s)\n"
        )
        for source in profile.catalog:
            stream.write(
                f"    - {source.id}\t{source.kind.value}\t{source.url}\t"
                f"(owner {source.owner}, trust {source.trust}, verified {source.verified_at})\n"
            )
    return EXIT_OK


def main(
    argv: Sequence[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    stream=None,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    env = env if env is not None else os.environ
    stream = stream or sys.stdout

    try:
        if args.command == "run":
            return _run(args, env, stream)
        if args.command == "resume":
            return _resume(args, env, stream)
        if args.command == "publish":
            return _publish(args, env, stream)
        if args.command == "checkpoints":
            return _checkpoints(args, stream)
        if args.command == "creators":
            return _creators(args, stream)
        if args.command == "profiles":
            return _profiles(args, stream)
    except ProposalOnlyViolation as error:
        stream.write(f"proposal-only guard: {error}\n")
        return EXIT_USAGE
    except (
        ProviderError,
        ProfileError,
        ArtifactError,
        GitHubError,
        InvalidBudget,
        PublicationError,
        FileNotFoundError,
    ) as error:
        stream.write(f"error: {error}\n")
        return EXIT_USAGE

    parser.error(f"unknown command {args.command!r}")
    return EXIT_USAGE  # pragma: no cover - argparse exits first


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
