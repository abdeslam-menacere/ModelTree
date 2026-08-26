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


# -- the artefact is loaded before the dry-run path writes anything -------------
#
# `_publish` calls `load_run_report` before the `--dry-run` branch runs at all,
# so both of the things that branch can emit early -- the destination line from
# #129 and the malformed-`--repo` refusal from #155 -- come after the artefact
# has been read. An artefact that cannot be loaded is therefore reported as
# itself, rather than behind a line describing a run that cannot happen.
#
# Until now a comment in `_publish` was the only thing saying so, and a comment
# stops nothing: hoisting the dry-run block above the load looks like a tidy-up
# and the whole suite stayed green. These are what make it fail instead.
#
# They assert the *absence* of the earlier output, not merely the presence of
# the error. Printing both is the exact regression, so a test that only looked
# for the error would pass straight through it.

UNLOADABLE_ARTEFACTS = {
    # Nothing at the path at all: an `OSError` inside `load_run_report`.
    "missing": None,
    # Present but not parseable, and the empty file that #129 called out
    # separately because it is what a half-written artefact looks like.
    "malformed-json": "{ not json",
    "empty": "",
    # Parseable JSON that is not a report: the failure furthest down
    # `load_run_report`, and so the one with the most code above it to reorder.
    "not-a-report": "{}",
}


@pytest.fixture()
def unloadable_artefact(tmp_path):
    """A `--report` path `load_run_report` refuses, one per way it can fail."""

    def factory(kind: str):
        body = UNLOADABLE_ARTEFACTS[kind]
        if body is None:
            return tmp_path / "gone.json"
        path = tmp_path / f"{kind}.json"
        path.write_text(body, encoding="utf-8")
        return path

    return factory


def _sole_line(output: str) -> str:
    """The one line written, or a failure naming everything that was."""
    lines = output.splitlines()
    assert len(lines) == 1, f"expected a single line, got {lines!r}"
    return lines[0]


@pytest.mark.parametrize("kind", sorted(UNLOADABLE_ARTEFACTS))
def test_an_unloadable_artefact_under_dry_run_reports_only_itself(
    kind, unloadable_artefact, monkeypatch
) -> None:
    """The artefact problem is the whole output, not the second half of it."""
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)
    report_path = unloadable_artefact(kind)

    # A well-shaped `--repo` and a `GITHUB_REPOSITORY` are both set, so if the
    # destination line were reached at all it would certainly be written, and
    # `--repo` winning over the environment makes it obvious which line it was.
    code, output = _run(
        [
            "publish",
            "--report",
            str(report_path),
            "--repo",
            "octo/other-repo",
            "--dry-run",
        ],
        env={"GITHUB_REPOSITORY": "octo/modeltree"},
    )

    assert code == EXIT_USAGE
    line = _sole_line(output)
    assert line.startswith("error: ")
    assert report_path.name in line
    # No destination line, in any of the three forms `_dry_run_destination`
    # takes -- each would have had to be written before the error to appear.
    assert "dry run:" not in output
    assert "octo/other-repo" not in output
    assert "octo/modeltree" not in output
    # And nothing downstream of the load ran either.
    assert f"title: {issue_title(MATERIAL)}" not in output


def test_an_unloadable_artefact_is_reported_ahead_of_a_malformed_repo(
    unloadable_artefact, monkeypatch
) -> None:
    """Two things are wrong at once, and the artefact is the one reported.

    #155 added a second early exit to the dry-run path, so the ordering this
    pins is no longer "the load before one `stream.write`" -- it is the load
    before *everything* the branch can emit. The refusal answers "where would
    this go?", which is not the operator's problem when there is no run to send.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)
    report_path = unloadable_artefact("missing")

    code, output = _run(
        [
            "publish",
            "--report",
            str(report_path),
            "--repo",
            MALFORMED_NO_SLASH,
            "--dry-run",
        ]
    )

    assert code == EXIT_USAGE
    line = _sole_line(output)
    assert line.startswith("error: ")
    assert report_path.name in line
    # Not the #155 refusal: it would have had to run first to be seen at all.
    assert MALFORMED_NO_SLASH not in output
    assert "owner/name" not in output


def test_a_loadable_artefact_still_gets_its_destination_line_first(
    artefact, monkeypatch
) -> None:
    """The counterweight, without which the pins above are satisfiable by silence.

    Every assertion in the two tests above is an absence, so deleting the
    destination line entirely would satisfy all of them. #129 shipped that line
    and it is still the first thing a loadable dry run writes -- which is also
    the positive half of the ordering: after the load, and before the payload.
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

    lines = output.splitlines()
    assert code == EXIT_OK
    assert lines[0] == "dry run: would publish to octo/other-repo (from --repo)"
    assert f"title: {issue_title(MATERIAL)}" in output
    assert "error:" not in output


# -- GITHUB_REPOSITORY is shape-checked on both channels and both paths ---------
#
# #155 refused a malformed `--repo`, but left the `GITHUB_REPOSITORY` channel --
# the one GitHub Actions sets and workflows actually use -- unchecked. Under
# `--dry-run` a malformed env var was echoed as `would publish to <garbage>` and
# exited 0; on the real path shape was validated only inside `RestIssuesClient`,
# after `GITHUB_TOKEN` was demanded. #261 closes both, refusing (exit 2) on the
# effective destination -- `--repo` if given, else `GITHUB_REPOSITORY` -- so the
# two channels reach the identical verdict for any identical value.


def test_a_dry_run_refuses_a_malformed_github_repository(
    artefact, monkeypatch
) -> None:
    """The env channel now catches the typo the `--repo` channel already did.

    On `main` this returned EXIT_OK and printed
    `dry run: would publish to octo-modeltree (from GITHUB_REPOSITORY)`.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        ["publish", "--report", str(artefact(MATERIAL)), "--dry-run"],
        env={"GITHUB_REPOSITORY": MALFORMED_NO_SLASH},
    )

    assert code == EXIT_USAGE
    assert MALFORMED_NO_SLASH in output
    assert "owner/name" in output
    # No unqualified destination line for a value that cannot name a repository.
    assert "would publish to" not in output
    # Refused instead of rendered: nothing downstream ran.
    assert f"title: {issue_title(MATERIAL)}" not in output


def test_the_env_refusal_names_the_environment_channel(artefact, monkeypatch) -> None:
    """An operator who never typed `--repo` must be told where the value came from."""
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        ["publish", "--report", str(artefact(MATERIAL)), "--dry-run"],
        env={"GITHUB_REPOSITORY": MALFORMED_NO_SLASH},
    )

    refusal = output.splitlines()[0]
    assert code == EXIT_USAGE
    assert "GITHUB_REPOSITORY" in refusal
    assert "environment" in refusal


def test_the_env_refusal_is_about_shape_and_says_nothing_about_existence(
    artefact, monkeypatch
) -> None:
    """The existence disclaimer #155 pinned for `--repo` holds for the env channel too."""
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    _, output = _run(
        ["publish", "--report", str(artefact(MATERIAL)), "--dry-run"],
        env={"GITHUB_REPOSITORY": MALFORMED_NO_SLASH},
    )

    refusal = output.splitlines()[0]
    assert "shape" in refusal
    assert "not a claim that any repository does or does not exist" in refusal
    lowered = refusal.lower()
    for lookup_claim in ("not found", "no such", "unreachable", "404", "does not exist."):
        assert lookup_claim not in lowered, lookup_claim
    # And it does not borrow `split_repository`'s own existence-flavoured text.
    assert "is not a valid repository" not in refusal


@pytest.mark.parametrize(
    "argv_extra,env",
    [
        (["--repo", MALFORMED_NO_SLASH], {}),
        ([], {"GITHUB_REPOSITORY": MALFORMED_NO_SLASH}),
    ],
    ids=["--repo", "GITHUB_REPOSITORY"],
)
def test_the_real_publish_path_refuses_a_malformed_repo_before_the_token(
    artefact, monkeypatch, argv_extra, env
) -> None:
    """Criterion 3: a typo must not require a credential to discover, from either channel.

    No `GITHUB_TOKEN` is provided. On `main` the malformed value was present but
    unchecked, so the token check fired first and the operator was told to supply
    a credential before ever learning the destination was malformed -- and on the
    real path a value from either channel reached `RestIssuesClient` at all only
    once a token was in hand.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        ["publish", "--report", str(artefact(MATERIAL)), *argv_extra],
        env=env,
    )

    assert code == EXIT_USAGE
    assert MALFORMED_NO_SLASH in output
    assert "owner/name" in output
    # The shape verdict is reached before the token is demanded.
    assert "GITHUB_TOKEN" not in output


def test_both_channels_agree_on_shape_for_every_value(artefact, monkeypatch) -> None:
    """Criterion 4: `--repo <v>` and `GITHUB_REPOSITORY=<v>` give the same verdict.

    A differential table, run over both channels rather than asserted by reading,
    with `split_repository` as the oracle for what each verdict should be.
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
        via_repo, _ = _run(
            ["publish", "--report", str(report_path), "--repo", value, "--dry-run"]
        )
        via_env, _ = _run(
            ["publish", "--report", str(report_path), "--dry-run"],
            env={"GITHUB_REPOSITORY": value},
        )
        assert via_repo == via_env, f"{value!r} disagreed across channels"
        try:
            split_repository(value)
        except GitHubError:
            assert via_env == EXIT_USAGE, f"{value!r} should have been refused"
        else:
            assert via_env == EXIT_OK, f"{value!r} should have been accepted"


def test_a_well_formed_github_repository_is_completely_unaffected(
    artefact, monkeypatch
) -> None:
    """Criterion 6: a correct CI run gains no new failure mode.

    GitHub Actions always sets `GITHUB_REPOSITORY` to a well-shaped `owner/name`,
    and that run must still render and name its destination exactly as before.
    This passes on `main` and must keep passing.
    """
    monkeypatch.setattr(cli, "RestIssuesClient", _blocked_client, raising=True)

    code, output = _run(
        ["publish", "--report", str(artefact(MATERIAL)), "--dry-run"],
        env={"GITHUB_REPOSITORY": "octo/modeltree"},
    )

    assert code == EXIT_OK
    assert "dry run: would publish to octo/modeltree (from GITHUB_REPOSITORY)" in output
    assert f"title: {issue_title(MATERIAL)}" in output
    assert "error:" not in output
