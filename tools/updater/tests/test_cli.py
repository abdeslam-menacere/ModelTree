"""The CLI runs offline, writes proposals, and reports failures honestly."""

from __future__ import annotations

import io
import json

import pytest

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
            "2026-06-01T00:00:00+00:00",
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
            "2026-06-01T00:00:00+00:00",
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


@pytest.mark.parametrize("command", ["run", "creators"])
def test_a_malformed_fixture_exits_cleanly_naming_the_file(
    tmp_path, fixture_dir, command
) -> None:
    """Exit 2 and a sentence naming the file, like the missing-fixtures case (#166).

    At the merge base this exited **1** with a `JSONDecodeError` traceback that named a
    line and column but not which document carried them. `--fixtures` is the offline
    path CI and the gates run, and the path a contributor hand-edits, so it is where a
    syntax error is likeliest and where a stack trace helps least. The good neighbour
    proves the refusal identifies the offending document rather than merely failing.
    """
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    (fixtures / "keeper.json").write_text(
        (fixture_dir / "contoso-ai.json").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (fixtures / "broken.json").write_text('{"creator": {,}}', encoding="utf-8")

    code, output = _run([command, "--fixtures", str(fixtures)])

    assert code == EXIT_USAGE
    assert "error: broken.json: could not be read" in output
    assert "line 1 column" in output
    assert "Traceback" not in output
    assert "keeper.json" not in output


def test_a_malformed_fixture_writes_nothing(tmp_path, fixture_dir) -> None:
    """The refusal happens before any output directory is touched.

    `run --output` is the invocation that writes, so "nothing is written" is only
    meaningful when asserted against it. The library loads first, so the directory is
    never created — asserted rather than assumed, since a refusal that had already
    written a partial artefact would leave the next run reading it.
    """
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    (fixtures / "broken.json").write_text('{"creator": {,}}', encoding="utf-8")
    output_dir = tmp_path / "proposals"

    code, output = _run(
        ["run", "--fixtures", str(fixtures), "--output", str(output_dir)]
    )

    assert code == EXIT_USAGE
    assert "broken.json" in output
    assert not output_dir.exists()


def test_a_valid_fixture_directory_still_runs_unchanged(tmp_path, fixture_dir) -> None:
    """The guard is invisible to a well-formed run: same exit, same proposal written."""
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
            "run-166",
            "--timestamp",
            "2026-06-01T00:00:00+00:00",
        ]
    )

    assert code == EXIT_OK
    assert (output_dir / "run-166" / "report.json").exists()
    assert (output_dir / "run-166" / "contoso-ai.json").exists()


@pytest.mark.parametrize(
    "flag,value,expected",
    [
        ("--max-pages", "-1", "max_pages must be a non-negative integer"),
        ("--max-tokens", "-5", "max_tokens must be a non-negative integer"),
        ("--max-seconds", "0", "max_seconds must be positive"),
        ("--max-retries", "-2", "max_retries must be a non-negative integer"),
    ],
)
def test_an_invalid_budget_flag_exits_cleanly(fixture_dir, flag, value, expected) -> None:
    """Exit 2 and a sentence, like every other misconfiguration — not a traceback."""
    code, output = _run(
        ["run", "--creator", "contoso-ai", "--fixtures", str(fixture_dir), flag, value]
    )

    assert code == EXIT_USAGE
    assert f"error: {expected}" in output
    assert "Traceback" not in output


def test_an_invalid_budget_environment_variable_exits_cleanly(fixture_dir) -> None:
    code, output = _run(
        ["run", "--creator", "contoso-ai", "--fixtures", str(fixture_dir)],
        env={"MODELTREE_UPDATER_MAX_SECONDS": "soon"},
    )

    assert code == EXIT_USAGE
    assert "error: MODELTREE_UPDATER_MAX_SECONDS must be a number, got 'soon'" in output


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


def test_checkpoints_command_names_the_creator_after_a_multi_creator_run(
    tmp_path, fixture_dir
) -> None:
    """The printed rows are what an operator picks a `--checkpoint-id` from.

    Two creators share one checkpoint directory, so the command's own output has to
    say which is which — otherwise choosing between the rows is guesswork, and a wrong
    choice resumes the other creator without saying so.
    """
    checkpoint_dir = tmp_path / "checkpoints"
    _run(
        [
            "run",
            "--creator",
            "contoso-ai",
            "--creator",
            "northwind-ai",
            "--fixtures",
            str(fixture_dir),
            "--checkpoint-dir",
            str(checkpoint_dir),
            "--run-id",
            "run-ckpt-multi",
        ]
    )
    code, output = _run(["checkpoints", "--checkpoint-dir", str(checkpoint_dir)])
    summaries = json.loads(output)

    assert code == EXIT_OK
    assert {summary["creator_id"] for summary in summaries if summary["creator_id"]} == {
        "contoso-ai",
        "northwind-ai",
    }
    # Visible in the text the operator actually reads, not only after re-parsing it.
    assert '"creator_id": "contoso-ai"' in output


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
