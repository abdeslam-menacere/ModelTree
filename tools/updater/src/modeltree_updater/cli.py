"""Local CLI for the proposal-only ModelTree updater.

Typical use, with no network and no cloud credentials::

    python -m modeltree_updater run --creator anthropic --output out/proposals

The CLI selects creators, applies per-creator budgets, writes proposal JSON to a
directory outside the web app, and reports what it could not finish.
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

from .budgets import CreatorBudget
from .checkpoints import (
    create_checkpoint_storage,
    list_checkpoint_summaries,
)
from .contracts import ProposalStatus, RunReport
from .providers.base import ProviderBundle, ProviderError
from .providers.fixtures import (
    FixtureClaimExtractor,
    FixtureSourceProvider,
    build_fixture_panel,
    load_fixture_library,
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
    run.add_argument("--output", type=Path, help="directory to write proposal JSON into")
    run.add_argument("--checkpoint-dir", type=Path, help="directory for durable checkpoints")
    run.add_argument("--run-id", help="identifier recorded in the proposals")
    run.add_argument("--timestamp", help="ISO timestamp recorded in the proposals")
    run.add_argument("--max-pages", type=int, help="page budget per creator")
    run.add_argument("--max-tokens", type=int, help="token budget per creator")
    run.add_argument("--max-seconds", type=float, help="wall-clock budget per creator")
    run.add_argument("--max-retries", type=int, help="retry budget per creator")

    creators = subparsers.add_parser("creators", help="list creators available in the fixtures")
    creators.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)

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
    resume.add_argument("--output", type=Path)
    resume.add_argument("--run-id")
    resume.add_argument("--timestamp")

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
    timestamp: str,
    env: Mapping[str, str],
) -> ProviderBundle:
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
    return EXIT_CREATOR_FAILED if report.failed_creator_ids else EXIT_OK


def _run(args: argparse.Namespace, env: Mapping[str, str], stream) -> int:
    library = load_fixture_library(args.fixtures)
    creator_ids = args.creators or list(library.creator_ids)
    unknown = [creator_id for creator_id in creator_ids if creator_id not in library.creators]
    if unknown:
        stream.write(f"unknown creator id(s): {', '.join(sorted(unknown))}\n")
        return EXIT_USAGE

    timestamp = args.timestamp or _default_timestamp()
    run_id = args.run_id or "run-" + re.sub(r"[^a-z0-9]+", "", timestamp.lower())
    providers = _build_providers(args.provider, library, timestamp=timestamp, env=env)
    settings = RunSettings(providers, budget=_budget(args, env), timestamp=timestamp)

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
    providers = _build_providers(args.provider, library, timestamp=timestamp, env=env)
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
        if args.command == "checkpoints":
            return _checkpoints(args, stream)
        if args.command == "creators":
            return _creators(args, stream)
        if args.command == "profiles":
            return _profiles(args, stream)
    except ProposalOnlyViolation as error:
        stream.write(f"proposal-only guard: {error}\n")
        return EXIT_USAGE
    except (ProviderError, ProfileError, FileNotFoundError) as error:
        stream.write(f"error: {error}\n")
        return EXIT_USAGE

    parser.error(f"unknown command {args.command!r}")
    return EXIT_USAGE  # pragma: no cover - argparse exits first


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
