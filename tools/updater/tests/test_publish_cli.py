"""`publish` end to end, through the real CLI, with no network.

The whole point of the dry run is that a human can read the exact bytes before
anyone hands this tool a token, so these tests go through `main()` rather than
calling the publisher directly.
"""

from __future__ import annotations

import io
import json

import pytest

from modeltree_updater import cli
from modeltree_updater.cli import EXIT_OK, EXIT_PUBLISH_FAILED, EXIT_USAGE, main
from modeltree_updater.parsing import proposal_from_dict
from modeltree_updater.publisher import identity_marker, issue_title, render_body

MATERIAL = "contoso-ai"
QUIET = "quiet-ai"


def _run(args, env=None):
    stream = io.StringIO()
    code = main(args, env=env or {}, stream=stream)
    return code, stream.getvalue()


@pytest.fixture()
def artefact(tmp_path, fixture_dir, timestamp):
    """A real `run --output` artefact, produced by the real CLI."""

    def factory(*creator_ids: str, run_id: str = "run-publish"):
        output = tmp_path / creator_ids[0]
        args = [
            "run",
            "--fixtures",
            str(fixture_dir),
            "--output",
            str(output),
            "--run-id",
            run_id,
            "--timestamp",
            timestamp,
        ]
        for creator_id in creator_ids:
            args += ["--creator", creator_id]
        code, text = _run(args)
        assert code == EXIT_OK, text
        return output / run_id / "report.json"

    return factory


def _blocked_client(*args, **kwargs):
    raise AssertionError("a dry run must not construct a GitHub client")


def test_a_dry_run_prints_the_exact_payload_and_touches_nothing(
    artefact, monkeypatch
) -> None:
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)
    report_path = artefact(MATERIAL)

    code, output = _run(["publish", "--report", str(report_path), "--dry-run"])

    proposal = json.loads(report_path.read_text(encoding="utf-8"))["proposals"][0]
    assert code == EXIT_OK
    assert f"title: {issue_title(MATERIAL)}" in output
    assert identity_marker(MATERIAL) in output
    assert proposal["claims"][0]["evidence"][0]["url"] in output


def test_the_dry_run_body_is_byte_identical_to_the_rendered_artefact(
    artefact,
) -> None:
    """The dry run is only worth anything if it is the payload, not a preview of it."""
    report_path = artefact(MATERIAL)

    _, output = _run(["publish", "--report", str(report_path), "--dry-run"])
    data = json.loads(report_path.read_text(encoding="utf-8"))
    body = render_body(proposal_from_dict(data["proposals"][0]))

    assert body in output


def test_a_no_change_creator_says_so_and_creates_nothing(
    artefact, monkeypatch
) -> None:
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)
    report_path = artefact(QUIET)

    code, output = _run(["publish", "--report", str(report_path), "--dry-run"])

    assert code == EXIT_OK
    assert "nothing material to report" in output
    assert identity_marker(QUIET) not in output


def test_publishing_creates_then_updates_one_issue(
    artefact, fake_issues_client, monkeypatch
) -> None:
    client = fake_issues_client()
    monkeypatch.setattr(cli, "RestIssuesClient", lambda **kwargs: client, raising=True)
    report_path = artefact(MATERIAL, QUIET)
    env = {"GITHUB_TOKEN": "t0ken", "GITHUB_REPOSITORY": "octo/modeltree"}

    first_code, first = _run(["publish", "--report", str(report_path)], env=env)
    second_code, second = _run(["publish", "--report", str(report_path)], env=env)

    assert (first_code, second_code) == (EXIT_OK, EXIT_OK)
    assert "created issue #101" in first
    assert "updated issue #101" in second
    assert "nothing material to report" in first
    assert len(client.issues) == 1


def test_a_publication_failure_gets_its_own_exit_code(
    artefact, fake_issues_client, monkeypatch
) -> None:
    client = fake_issues_client()

    def explode(**kwargs):
        raise RuntimeError("the API said no")

    client.create_issue = explode
    monkeypatch.setattr(cli, "RestIssuesClient", lambda **kwargs: client, raising=True)
    report_path = artefact(MATERIAL)

    code, output = _run(
        ["publish", "--report", str(report_path)],
        env={"GITHUB_TOKEN": "t0ken", "GITHUB_REPOSITORY": "octo/modeltree"},
    )

    assert code == EXIT_PUBLISH_FAILED
    assert "publication failed" in output
    assert "the API said no" in output


def test_publishing_without_a_repository_is_a_usage_error(artefact) -> None:
    code, output = _run(
        ["publish", "--report", str(artefact(MATERIAL))],
        env={"GITHUB_TOKEN": "t0ken"},
    )

    assert code == EXIT_USAGE
    assert "--repo" in output


def test_publishing_without_a_token_is_a_usage_error(artefact) -> None:
    code, output = _run(
        ["publish", "--report", str(artefact(MATERIAL)), "--repo", "octo/modeltree"]
    )

    assert code == EXIT_USAGE
    assert "GITHUB_TOKEN" in output


def test_a_missing_artefact_is_reported_not_traced(tmp_path) -> None:
    code, output = _run(
        ["publish", "--report", str(tmp_path / "gone.json"), "--dry-run"]
    )

    assert code == EXIT_USAGE
    assert "gone.json" in output


def test_a_dry_run_needs_no_credentials_and_no_repository(artefact) -> None:
    code, _ = _run(["publish", "--report", str(artefact(MATERIAL)), "--dry-run"])

    assert code == EXIT_OK
