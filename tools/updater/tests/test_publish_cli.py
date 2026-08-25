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
from modeltree_updater.github_issues import GitHubError, split_repository
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


def test_a_dry_run_says_it_has_not_checked_for_duplicates(artefact) -> None:
    """A clean dry run must not read as evidence that no duplicate exists."""
    code, output = _run(["publish", "--report", str(artefact(MATERIAL)), "--dry-run"])

    assert code == EXIT_OK
    assert "has NOT checked" in output
    assert "duplicate open proposals" in output
    assert "superseded run" in output


def test_publishing_a_later_run_reports_what_it_superseded(
    artefact, fake_issues_client, monkeypatch
) -> None:
    client = fake_issues_client()
    monkeypatch.setattr(cli, "RestIssuesClient", lambda **kwargs: client, raising=True)
    env = {"GITHUB_TOKEN": "t0ken", "GITHUB_REPOSITORY": "octo/modeltree"}
    first = artefact(MATERIAL, run_id="run-one")
    second = artefact(MATERIAL, run_id="run-two")

    _run(["publish", "--report", str(first)], env=env)
    _, output = _run(["publish", "--report", str(second)], env=env)

    assert "superseded run run-one, recorded in a comment" in output
    assert len(client.comments) == 1


def test_a_dry_run_names_the_repository_it_would_publish_to(
    artefact, monkeypatch
) -> None:
    """`--repo` under `--dry-run` used to be read nowhere at all.

    The operator could not tell "my --repo was honoured" from "my --repo was
    thrown away", because the output was identical either way.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        [
            "publish",
            "--report",
            str(artefact(MATERIAL)),
            "--repo",
            "octo/other-repo",
            "--dry-run",
        ],
        env={"GITHUB_REPOSITORY": "octo/modeltree"},
    )

    assert code == EXIT_OK
    assert "octo/other-repo" in output
    assert "--repo" in output
    # Named, not contacted: `_blocked_client` fails the test if a client is built.
    assert "octo/modeltree" not in output


def test_a_dry_run_says_when_its_destination_came_from_the_environment(
    artefact, monkeypatch
) -> None:
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        ["publish", "--report", str(artefact(MATERIAL)), "--dry-run"],
        env={"GITHUB_REPOSITORY": "octo/modeltree"},
    )

    assert code == EXIT_OK
    assert "octo/modeltree" in output
    assert "GITHUB_REPOSITORY" in output


def test_a_dry_run_with_no_destination_says_so_and_still_renders(
    artefact, monkeypatch
) -> None:
    """The invocation people actually use. It must not become an error."""
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(["publish", "--report", str(artefact(MATERIAL)), "--dry-run"])

    assert code == EXIT_OK
    assert "no destination named" in output
    assert f"title: {issue_title(MATERIAL)}" in output


def test_naming_a_repository_does_not_change_what_a_dry_run_renders(
    artefact, monkeypatch
) -> None:
    """The destination is reported alongside the payload, never inside it.

    A dry run is only worth anything if it is the bytes a real publication would
    send, so `--repo` must add a line and change nothing else.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)
    report_path = artefact(MATERIAL)
    argv = ["publish", "--report", str(report_path), "--dry-run"]

    _, without = _run(argv)
    _, with_repo = _run(argv + ["--repo", "octo/other-repo"])

    marker = f"=== {MATERIAL}: dry run, nothing was sent ==="
    assert without[without.index(marker) :] == with_repo[with_repo.index(marker) :]


def test_repo_still_wins_over_the_environment_when_publishing_for_real(
    artefact, fake_issues_client, monkeypatch
) -> None:
    """The real publication path is untouched by the dry-run change."""
    built: dict[str, str] = {}
    client = fake_issues_client()

    def record(**kwargs):
        built.update(kwargs)
        return client

    monkeypatch.setattr(cli, "RestIssuesClient", record, raising=True)

    code, _ = _run(
        ["publish", "--report", str(artefact(MATERIAL)), "--repo", "octo/other-repo"],
        env={"GITHUB_TOKEN": "t0ken", "GITHUB_REPOSITORY": "octo/modeltree"},
    )

    assert code == EXIT_OK
    assert built["repository"] == "octo/other-repo"


# -- a malformed --repo is refused offline, not once a token is in hand ----------
#
# `split_repository` is pure, so the shape of a destination is knowable with no
# credentials and no network. These four go together: two values that must now
# be refused, one valid value that must be completely unaffected, and the
# no-destination case that must stay the ordinary, succeeding invocation it is.

MALFORMED_NO_SLASH = "octo-modeltree"
MALFORMED_PASTED_URL = "https://github.com/octo/modeltree"


def test_a_dry_run_refuses_a_repo_with_no_slash(artefact, monkeypatch) -> None:
    """The typo a dry run exists to catch, caught before a token is handed over.

    On `main` this returned EXIT_OK and rendered the payload, and the value was
    rejected only by `RestIssuesClient.__init__` on a real publication.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        [
            "publish",
            "--report",
            str(artefact(MATERIAL)),
            "--repo",
            MALFORMED_NO_SLASH,
            "--dry-run",
        ]
    )

    assert code == EXIT_USAGE
    # The value received and the shape expected, so the typo is visible.
    assert MALFORMED_NO_SLASH in output
    assert "owner/name" in output
    # Refused instead of rendered: nothing downstream ran.
    assert f"title: {issue_title(MATERIAL)}" not in output


def test_a_dry_run_refuses_a_pasted_repository_url(artefact, monkeypatch) -> None:
    """The other way this is got wrong: a URL pasted where owner/name belongs."""
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        [
            "publish",
            "--report",
            str(artefact(MATERIAL)),
            "--repo",
            MALFORMED_PASTED_URL,
            "--dry-run",
        ]
    )

    assert code == EXIT_USAGE
    assert MALFORMED_PASTED_URL in output
    assert "owner/name" in output
    assert f"title: {issue_title(MATERIAL)}" not in output


def test_the_refusal_is_about_shape_and_says_nothing_about_existence(
    artefact, monkeypatch
) -> None:
    """Offline, only the shape is knowable, so only the shape may be claimed.

    A message that read as "no such repository" would be asserting something
    this run cannot know, and would be wrong for the opposite reason too: a
    well-shaped value is not looked up either.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    _, output = _run(
        [
            "publish",
            "--report",
            str(artefact(MATERIAL)),
            "--repo",
            MALFORMED_NO_SLASH,
            "--dry-run",
        ]
    )

    refusal = output.splitlines()[0]
    assert "shape" in refusal
    assert "not a claim that any repository does or does not exist" in refusal
    # Nothing that would only be knowable by looking the repository up.
    lowered = refusal.lower()
    for lookup_claim in ("not found", "no such", "unreachable", "404", "does not exist."):
        assert lookup_claim not in lowered, lookup_claim


def test_the_dry_run_refuses_exactly_what_a_real_publication_refuses(
    artefact, monkeypatch
) -> None:
    """No second, divergent parser: `split_repository` decides in both places.

    Asserted as agreement rather than by naming the validator, so a
    reimplementation that happened to be correct today but drifted tomorrow
    would still be caught.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)
    report_path = artefact(MATERIAL)
    candidates = [
        MALFORMED_NO_SLASH,
        MALFORMED_PASTED_URL,
        "octo/modeltree",
        "octo/model.tree",
        "octo/",
        "/modeltree",
        "octo/modeltree?x=1",
        "octo/../evil",
        "octo_name/modeltree",
        "octo/modeltree/extra",
    ]

    for value in candidates:
        code, _ = _run(
            ["publish", "--report", str(report_path), "--repo", value, "--dry-run"]
        )
        try:
            split_repository(value)
        except GitHubError:
            assert code == EXIT_USAGE, f"{value!r} should have been refused"
        else:
            assert code == EXIT_OK, f"{value!r} should have been accepted"


def test_a_valid_repo_under_dry_run_is_completely_unaffected(
    artefact, monkeypatch
) -> None:
    """The regression pin for the destination line added by #129.

    This passes on `main`; it is here so that adding the refusal cannot be
    mistaken for licence to disturb the case that already worked.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        [
            "publish",
            "--report",
            str(artefact(MATERIAL)),
            "--repo",
            "octo/modeltree",
            "--dry-run",
        ]
    )

    assert code == EXIT_OK
    assert "dry run: would publish to octo/modeltree (from --repo)" in output
    assert f"title: {issue_title(MATERIAL)}" in output
    assert "error:" not in output


def test_a_dry_run_with_no_destination_is_still_not_a_refusal(
    artefact, monkeypatch
) -> None:
    """The counterweight, and the ordinary invocation.

    `--dry-run` promises it needs no repository. Unset is not malformed, and
    turning the most common call into a usage error would be a worse defect
    than the one being fixed. This passes on `main` and must keep passing.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(["publish", "--report", str(artefact(MATERIAL)), "--dry-run"])

    assert code == EXIT_OK
    assert "dry run: no destination named" in output
    assert f"title: {issue_title(MATERIAL)}" in output
    assert "error:" not in output
    assert "owner/name" not in output
