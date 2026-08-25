"""What the publication workflow is allowed to do.

#66 requires that this workflow cannot modify repository content, create a
branch, or open a pull request, that it runs only when a human dispatches it,
and that Foundry access is federated rather than key-based. Those are properties
of a YAML file, so they are asserted against the parsed YAML rather than trusted
to review.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml", reason="PyYAML is part of the dev extra")

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "publish-updater-proposals.yml"
TESTS_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "updater-tests.yml"


@pytest.fixture(scope="module")
def workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def triggers(workflow) -> dict:
    # YAML 1.1 reads a bare `on` key as the boolean True.
    return workflow.get("on", workflow.get(True))


@pytest.fixture(scope="module")
def job(workflow) -> dict:
    jobs = workflow["jobs"]
    assert list(jobs) == ["publish"], "one job, so there is one permission surface"
    return jobs["publish"]


@pytest.fixture(scope="module")
def raw() -> str:
    return WORKFLOW_PATH.read_text(encoding="utf-8")


def test_the_workflow_exists() -> None:
    assert WORKFLOW_PATH.is_file()


def test_the_workflow_only_runs_when_a_human_dispatches_it(triggers) -> None:
    """No schedule in this version: a run costs tokens and writes issues."""
    assert list(triggers) == ["workflow_dispatch"]


def test_the_dispatch_defaults_to_a_dry_run(triggers) -> None:
    inputs = triggers["workflow_dispatch"]["inputs"]

    assert inputs["dry_run"]["default"] is True
    assert inputs["mode"]["default"] == "fixtures"
    assert set(inputs["mode"]["options"]) == {"fixtures", "live"}


def test_the_default_permission_is_read_only(workflow) -> None:
    assert workflow["permissions"] == {"contents": "read"}


def test_the_job_can_write_issues_and_nothing_else(job) -> None:
    permissions = job["permissions"]

    assert permissions == {
        "contents": "read",
        "issues": "write",
        "id-token": "write",
    }


def test_the_job_cannot_modify_repository_content_or_open_a_pull_request(
    workflow, job
) -> None:
    """The acceptance criterion, stated as the two facts that make it true."""
    for permissions in (workflow["permissions"], job["permissions"]):
        assert permissions.get("contents", "read") == "read"
        assert "pull-requests" not in permissions
        assert "workflows" not in permissions


def test_the_checkout_keeps_no_pushable_credentials(job) -> None:
    checkout = [
        step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/checkout")
    ]

    assert checkout, "the workflow checks the repository out"
    assert checkout[0]["with"]["persist-credentials"] is False


def test_no_step_pushes_commits_branches_or_pull_requests(raw) -> None:
    for forbidden in (
        "git push",
        "git commit",
        "git checkout -b",
        "gh pr ",
        "peter-evans/create-pull-request",
        "stefanzweifel/git-auto-commit",
    ):
        assert forbidden not in raw, forbidden


def test_publication_is_serialised_across_the_whole_repository(workflow) -> None:
    """Two publishers at once could both create a first issue for one creator."""
    concurrency = workflow["concurrency"]

    assert concurrency["cancel-in-progress"] is False
    assert "github.ref" not in concurrency["group"]
    assert "github.run_id" not in concurrency["group"]


def test_foundry_access_is_federated_and_carries_no_secret(job, raw) -> None:
    login = [
        step for step in job["steps"] if str(step.get("uses", "")).startswith("azure/login")
    ]

    assert login, "live mode signs in to Azure"
    assert set(login[0]["with"]) == {"client-id", "tenant-id", "subscription-id"}
    assert "client-secret" not in raw
    assert not re.search(r"[A-Z_]*API_KEY", raw)
    assert not re.search(r"secrets\.AZURE", raw)


def test_the_only_secret_used_is_the_job_token(raw) -> None:
    assert set(re.findall(r"secrets\.([A-Za-z_]+)", raw)) == {"GITHUB_TOKEN"}


def test_dispatch_inputs_never_reach_a_shell_directly(job) -> None:
    """Inputs go through `env:` so a creator id cannot become a shell command."""
    for step in job["steps"]:
        script = step.get("run")
        if script:
            assert "inputs." not in script, step.get("name")
            assert "github.event." not in script, step.get("name")


def test_the_workflow_runs_the_publisher_through_the_cli(job) -> None:
    scripts = " ".join(step.get("run", "") for step in job["steps"])

    assert "modeltree_updater run" in scripts
    assert "modeltree_updater publish" in scripts


def test_the_run_step_points_the_installed_updater_at_the_checkout_fixtures(
    workflow, job
) -> None:
    """#139: the wheel does not carry fixtures, so the checkout has to supply them.

    The path is resolved rather than merely matched. A `--fixtures` flag naming a
    directory that is not in the repository is the same failure this fixes, just
    with a different string in the log.
    """
    steps = [step for step in job["steps"] if "modeltree_updater run" in step.get("run", "")]
    assert len(steps) == 1, "one place decides how the updater is invoked"

    match = re.search(r'--fixtures\s+"?([^"\s\\]+)"?', steps[0]["run"])
    assert match, "the run step passes --fixtures explicitly"

    declared = match.group(1).replace("$GITHUB_WORKSPACE", str(REPO_ROOT))
    resolved = Path(declared)
    if not resolved.is_absolute():
        working_directory = workflow.get("defaults", {}).get("run", {}).get(
            "working-directory", ""
        )
        resolved = REPO_ROOT / working_directory / declared

    assert resolved.is_dir(), f"{declared} is not a directory in this repository"
    assert list(resolved.glob("*.json")), "the fixtures directory has creator fixtures"


def test_the_run_step_supplies_fixtures_in_live_mode_too(job) -> None:
    """Creator definitions come from the fixture library whatever the sources are.

    `--sources network` changes where pages are fetched from, not where the list
    of creators comes from, so a `--fixtures` that were conditional on the mode
    would leave live runs failing exactly the way #139 failed.
    """
    step = next(step for step in job["steps"] if "modeltree_updater run" in step.get("run", ""))
    script = step["run"]
    conditional = re.search(r'if \[ "\$MODE" = "live" \].*?\nfi', script, re.S)

    assert conditional, "the run step branches on the mode"
    assert "--fixtures" not in conditional.group(0)
    assert "--fixtures" in script


def test_the_offline_test_workflow_still_needs_no_credentials() -> None:
    """CI must keep passing with no network and no cloud credentials."""
    raw = TESTS_WORKFLOW_PATH.read_text(encoding="utf-8")

    assert "azure/login" not in raw
    assert "AZURE_CLIENT_ID" not in raw
    assert "MODELTREE_LIVE_PUBLISH_REPO" not in raw
