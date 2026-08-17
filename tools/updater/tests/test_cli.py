"""The CLI runs offline, writes proposals, and reports failures honestly."""

from __future__ import annotations

import io
import json

from modeltree_updater.cli import EXIT_CREATOR_FAILED, EXIT_OK, EXIT_USAGE, main


def _run(args, env=None):
    stream = io.StringIO()
    code = main(args, env=env or {}, stream=stream)
    return code, stream.getvalue()


def test_creators_command_lists_fixture_creators(fixture_dir) -> None:
    code, output = _run(["creators", "--fixtures", str(fixture_dir)])

    assert code == EXIT_OK
    assert "contoso-ai" in output
    assert "northwind-ai" in output


def test_run_writes_proposal_files_without_network_or_credentials(
    tmp_path, fixture_dir
) -> None:
    output_dir = tmp_path / "proposals"
    code, output = _run(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(output_dir),
            "--run-id",
            "run-cli",
            "--timestamp",
            "2026-01-01T00:00:00+00:00",
        ]
    )

    report = json.loads((output_dir / "run-cli" / "report.json").read_text(encoding="utf-8"))
    proposal = json.loads((output_dir / "run-cli" / "contoso-ai.json").read_text(encoding="utf-8"))

    assert code == EXIT_OK
    assert "contoso-ai: complete" in output
    assert report["settings"]["mode"] == "proposal-only"
    assert proposal["claims"][0]["evidence"][0]["url"].startswith("https://")


def test_run_prints_the_report_when_no_output_directory_is_given(fixture_dir) -> None:
    code, output = _run(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--timestamp",
            "2026-01-01T00:00:00+00:00",
        ]
    )
    report = json.loads(output[: output.rindex("}") + 1])

    assert code == EXIT_OK
    assert report["proposals"][0]["creator_id"] == "contoso-ai"


def test_budget_flags_are_applied_per_creator(tmp_path, fixture_dir) -> None:
    output_dir = tmp_path / "proposals"
    code, _ = _run(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(output_dir),
            "--run-id",
            "run-budget",
            "--max-pages",
            "1",
        ]
    )
    proposal = json.loads(
        (output_dir / "run-budget" / "contoso-ai.json").read_text(encoding="utf-8")
    )

    assert code == EXIT_OK
    assert proposal["budget"]["exhausted_by"] == ["pages"]
    assert proposal["status"] == "incomplete"


def test_budget_environment_variables_are_honoured(tmp_path, fixture_dir) -> None:
    output_dir = tmp_path / "proposals"
    _run(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(output_dir),
            "--run-id",
            "run-env",
        ],
        env={"MODELTREE_UPDATER_MAX_TOKENS": "1"},
    )
    proposal = json.loads((output_dir / "run-env" / "contoso-ai.json").read_text(encoding="utf-8"))

    assert proposal["budget"]["max_tokens"] == 1
    assert proposal["budget"]["exhausted_by"] == ["tokens"]


def test_unknown_creator_is_a_usage_error(fixture_dir) -> None:
    code, output = _run(["run", "--creator", "nobody", "--fixtures", str(fixture_dir)])

    assert code == EXIT_USAGE
    assert "unknown creator id(s): nobody" in output


def test_a_failed_creator_sets_a_distinct_exit_code(tmp_path, fixture_dir, monkeypatch) -> None:
    from modeltree_updater import cli

    def explode(*args, **kwargs):
        raise MemoryError("provider crashed")

    monkeypatch.setattr(
        cli.FixtureSourceProvider, "discover", explode, raising=True
    )
    code, output = _run(["run", "--creator", "contoso-ai", "--fixtures", str(fixture_dir)])

    assert code == EXIT_CREATOR_FAILED
    assert "contoso-ai: failed" in output


def test_checkpoints_command_lists_stored_checkpoints(tmp_path, fixture_dir) -> None:
    checkpoint_dir = tmp_path / "checkpoints"
    _run(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--checkpoint-dir",
            str(checkpoint_dir),
            "--run-id",
            "run-ckpt",
        ]
    )
    code, output = _run(["checkpoints", "--checkpoint-dir", str(checkpoint_dir)])
    summaries = json.loads(output)

    assert code == EXIT_OK
    assert summaries
    assert summaries[0]["checkpoint_id"]


def test_resume_command_finishes_a_checkpointed_run(tmp_path, fixture_dir) -> None:
    checkpoint_dir = tmp_path / "checkpoints"
    _run(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
            "--checkpoint-dir",
            str(checkpoint_dir),
            "--run-id",
            "run-resume",
        ]
    )
    _, listed = _run(["checkpoints", "--checkpoint-dir", str(checkpoint_dir)])
    checkpoint_id = json.loads(listed)[0]["checkpoint_id"]

    code, output = _run(
        [
            "resume",
            "--checkpoint-id",
            checkpoint_id,
            "--checkpoint-dir",
            str(checkpoint_dir),
            "--fixtures",
            str(fixture_dir),
        ]
    )

    assert code == EXIT_OK
    assert "contoso-ai: complete" in output


def test_foundry_provider_requires_configuration(fixture_dir) -> None:
    code, output = _run(
        [
            "run",
            "--provider",
            "foundry",
            "--creator",
            "contoso-ai",
            "--fixtures",
            str(fixture_dir),
        ]
    )

    assert code == EXIT_USAGE
    assert "missing Foundry configuration" in output
