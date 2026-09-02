"""What the publication workflow is allowed to do.

#66 requires that this workflow cannot modify repository content, create a
branch, or open a pull request, and that Foundry access is federated rather than
key-based. #30 adds a weekly schedule, so it must also hold those properties
when nobody is watching the run. Those are properties of a YAML file, so they are
asserted against the parsed YAML rather than trusted to review.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "publish-updater-proposals.yml"
TESTS_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "updater-tests.yml"

# The repository's other scheduled sweeps. Read from disk rather than restated as
# literals so that "these three do not contend" keeps being checked after one of
# them is retimed, instead of quietly becoming a claim about the past.
OTHER_SCHEDULED_WORKFLOWS = (
    REPO_ROOT / ".github" / "workflows" / "data-health.yml",
    REPO_ROOT / ".github" / "workflows" / "source-link-health.yml",
)


def _triggers_of(document: dict) -> dict:
    # YAML 1.1 reads a bare `on` key as the boolean True.
    return document.get("on", document.get(True))


def _crons(document: dict) -> list[str]:
    schedule = _triggers_of(document).get("schedule") or []
    return [entry["cron"] for entry in schedule]


@pytest.fixture(scope="module")
def workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def triggers(workflow) -> dict:
    return _triggers_of(workflow)


@pytest.fixture(scope="module")
def job(workflow) -> dict:
    jobs = workflow["jobs"]
    assert list(jobs) == ["publish"], "one job, so there is one permission surface"
    return jobs["publish"]


@pytest.fixture(scope="module")
def steps_by_name(job) -> dict:
    return {step.get("name"): step for step in job["steps"]}


@pytest.fixture(scope="module")
def raw() -> str:
    return WORKFLOW_PATH.read_text(encoding="utf-8")


def test_the_workflow_exists() -> None:
    assert WORKFLOW_PATH.is_file()


def test_the_workflow_runs_on_a_schedule_and_on_demand(triggers) -> None:
    """#30's whole scope: the publisher had no schedule and now has one.

    Stated as an equality rather than as "schedule is present", so a third
    trigger -- a `push`, or a `pull_request` that would run the publisher on
    every proposed change -- is a failure rather than something nobody notices.
    """
    assert set(triggers) == {"schedule", "workflow_dispatch"}


def test_the_schedule_is_weekly_and_off_the_hour(workflow) -> None:
    crons = _crons(workflow)

    assert len(crons) == 1, "one cadence, so there is one thing to reason about"
    minute, hour, day_of_month, month, day_of_week = crons[0].split()
    assert (day_of_month, month) == ("*", "*")
    assert day_of_week == "1", "Monday"
    assert minute != "0", "off the hour: the top of the hour is the congested slot"
    assert 0 <= int(hour) <= 23


def test_the_three_scheduled_sweeps_do_not_contend(workflow) -> None:
    """A shared minute would have them queue behind each other every week."""
    ours = _crons(workflow)
    assert ours, "this workflow is one of the scheduled sweeps"

    for path in OTHER_SCHEDULED_WORKFLOWS:
        theirs = _crons(yaml.safe_load(path.read_text(encoding="utf-8")))
        assert theirs, f"{path.name} is a scheduled workflow"
        for mine in ours:
            for other in theirs:
                mine_minute, mine_hour = mine.split()[:2]
                other_minute, other_hour = other.split()[:2]
                assert (mine_minute, mine_hour) != (other_minute, other_hour), (
                    f"{path.name} already sweeps at {other_hour}:{other_minute}"
                )


def test_the_dispatch_defaults_to_a_dry_run(triggers) -> None:
    inputs = triggers["workflow_dispatch"]["inputs"]

    assert inputs["dry_run"]["default"] is True
    assert inputs["mode"]["default"] == "fixtures"
    assert set(inputs["mode"]["options"]) == {"fixtures", "live"}


def test_the_default_permission_grants_nothing(workflow) -> None:
    """A job added later inherits no scope and has to ask for its own.

    Tighter than the `contents: read` this replaced, and tightened because of the
    schedule: a default that is merely narrow is a different risk once something
    runs every week with nobody reading the log.
    """
    assert workflow["permissions"] == {}



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


# ---------------------------------------------------------------------------
# The scheduled path (#30)
# ---------------------------------------------------------------------------
# A `schedule` event supplies no `inputs`, so every parameter this workflow acts
# on has to be resolved from the event rather than read from a null. The tests
# below pin that resolution, and then run the real script to prove the pinning
# describes something that works.


@pytest.fixture(scope="module")
def resolve_step(steps_by_name) -> dict:
    step = steps_by_name["Resolve what this run does"]
    assert step["id"] == "params", "the later steps address this step by id"
    return step


def test_the_scheduled_sweep_names_the_creators_it_watches(workflow) -> None:
    """Blank would mean the whole fixture library, including the synthetic ones.

    `cli.py` reads an empty `--creator` list as "every creator in the library",
    and that library carries eight invented creators that exist to exercise the
    pipeline offline. A live sweep over those would be fetching pages that were
    never real. Each id is resolved against the library rather than merely
    matched, for the same reason `--fixtures` is resolved below: a name that is
    not in the repository fails the same way, just with a different string.
    """
    creators = workflow["env"]["SCHEDULED_CREATORS"].split(",")

    assert creators and all(creators), "the sweep names its creators explicitly"
    library = REPO_ROOT / "tools" / "updater" / "fixtures" / "creators"
    for creator in creators:
        assert (library / f"{creator}.json").is_file(), creator


def test_the_run_and_publish_steps_read_the_resolved_parameters(steps_by_name) -> None:
    """The regression this whole step exists to prevent.

    `inputs.dry_run` is null on a `schedule`, and the publish step's old test
    `[ "$DRY_RUN" = "true" ]` read null as "not a dry run" -- so a bare
    `schedule:` trigger would have inverted the workflow's safest default without
    changing a line of the publishing logic. Every value the two steps act on
    must therefore come from the resolution step.
    """
    for name in ("Run the updater", "Publish the proposals"):
        env = steps_by_name[name]["env"]
        for key, value in env.items():
            assert "inputs." not in str(value), f"{name}.{key}"

    run_env = steps_by_name["Run the updater"]["env"]
    assert run_env["CREATORS"] == "${{ steps.params.outputs.creators }}"
    assert run_env["MODE"] == "${{ steps.params.outputs.mode }}"

    publish_env = steps_by_name["Publish the proposals"]["env"]
    assert publish_env["DRY_RUN"] == "${{ steps.params.outputs.dry_run }}"


def test_the_mode_conditioned_steps_use_the_resolved_mode(steps_by_name) -> None:
    """`if: inputs.mode == 'live'` is never true on a schedule.

    Left as it was, the Foundry install and the Azure sign-in would be skipped on
    every scheduled run, and a live sweep would reach the network without either.
    """
    for name in ("Install the Foundry client", "Sign in to Azure with workload identity"):
        assert steps_by_name[name]["if"] == "steps.params.outputs.mode == 'live'", name


def test_publishing_refuses_a_dry_run_value_it_cannot_read(steps_by_name) -> None:
    """Enumerated, so an unanticipated value refuses instead of publishing."""
    script = steps_by_name["Publish the proposals"]["run"]

    assert "case \"$DRY_RUN\" in" in script
    assert re.search(r"^\s*true\)\s*args\+=\(--dry-run\)\s*;;", script, re.M)
    assert re.search(r"^\s*\*\)", script, re.M), "an unrecognised value is handled"
    assert "::error::" in script


def test_a_source_that_cannot_be_reached_still_reaches_a_human(steps_by_name) -> None:
    """Exit 3 carries the report; aborting on it would throw the report away.

    `cli.py` writes the artefact and only then returns `EXIT_CREATOR_FAILED`, and
    the failures inside it are what `is_material` counts to decide the proposal
    is worth publishing. Under `set -e` the step aborted before `publish` ran, so
    an unreachable page produced no review issue at all -- survivable while a
    human was watching the log, and a silent hole once this runs weekly.
    """
    script = steps_by_name["Run the updater"]["run"]

    assert "|| code=$?" in script, "the exit code is captured, not left to -e"
    assert re.search(
        r'if \[ "\$code" -eq 3 \] && \[ "\$MODE" = "live" \]; then', script
    ), "exit 3 is tolerated in live mode only"
    assert "::warning::" in script, "and reported rather than swallowed"
    assert "::error::" in script, "any other non-zero code still fails loudly"


# ---------------------------------------------------------------------------
# Running the resolution script for real
# ---------------------------------------------------------------------------
# The assertions above describe the script. These execute it, because a shape
# nobody has run is not evidence that it resolves anything. `bash` is present on
# `ubuntu-latest`, where both pytest legs run, and in Git for Windows; where it
# genuinely is not, the structural tests above still cover every row of this
# table, so the skip below narrows what is checked rather than emptying it.

BASH = shutil.which("bash")

# event, live client id, expected (mode, dry_run) -- the table in the workflow
# header, as data.
RESOLUTIONS = [
    ("schedule", "", "fixtures", "true"),
    ("schedule", "00000000-0000-0000-0000-000000000000", "live", "false"),
]


def _resolve(script: str, scheduled_creators: str, tmp_path, **env: str) -> dict[str, str]:
    output = tmp_path / "github_output"
    summary = tmp_path / "github_step_summary"
    output.touch()
    summary.touch()

    environment = {
        "SCHEDULED_CREATORS": scheduled_creators,
        "EVENT": "",
        "LIVE_CLIENT_ID": "",
        "DISPATCH_CREATORS": "",
        "DISPATCH_MODE": "",
        "DISPATCH_DRY_RUN": "",
        # Git Bash reads a forward-slashed drive path; a backslashed one it
        # treats as escapes.
        "GITHUB_OUTPUT": output.as_posix(),
        "GITHUB_STEP_SUMMARY": summary.as_posix(),
        **env,
    }
    result = subprocess.run(
        [BASH, "-c", script],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    resolved = {}
    for line in output.read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        resolved[key] = value
    return resolved


@pytest.mark.skipif(BASH is None, reason="bash is not installed on this machine")
@pytest.mark.parametrize("event,client_id,mode,dry_run", RESOLUTIONS)
def test_a_scheduled_run_resolves_the_documented_row(
    resolve_step, workflow, tmp_path, event, client_id, mode, dry_run
) -> None:
    resolved = _resolve(
        resolve_step["run"],
        workflow["env"]["SCHEDULED_CREATORS"],
        tmp_path,
        EVENT=event,
        LIVE_CLIENT_ID=client_id,
    )

    assert resolved["mode"] == mode
    assert resolved["dry_run"] == dry_run
    assert resolved["creators"] == workflow["env"]["SCHEDULED_CREATORS"]


@pytest.mark.skipif(BASH is None, reason="bash is not installed on this machine")
def test_an_unconfigured_scheduled_run_cannot_publish(
    resolve_step, workflow, tmp_path
) -> None:
    """The configuration that exists today, stated as what it forbids.

    While no workload identity is provisioned -- #93 -- the weekly run must
    resolve to a dry run, which `publisher.py`'s `_render_only` serves without
    making a single GitHub request.
    """
    resolved = _resolve(
        resolve_step["run"],
        workflow["env"]["SCHEDULED_CREATORS"],
        tmp_path,
        EVENT="schedule",
        LIVE_CLIENT_ID="",
    )

    assert resolved["dry_run"] == "true"


@pytest.mark.skipif(BASH is None, reason="bash is not installed on this machine")
@pytest.mark.parametrize("dry_run", ["true", "false"])
def test_a_dispatch_still_gets_exactly_what_it_asked_for(
    resolve_step, workflow, tmp_path, dry_run
) -> None:
    """Adding the schedule must not quietly retune the manual path."""
    resolved = _resolve(
        resolve_step["run"],
        workflow["env"]["SCHEDULED_CREATORS"],
        tmp_path,
        EVENT="workflow_dispatch",
        DISPATCH_CREATORS="openai",
        DISPATCH_MODE="live",
        DISPATCH_DRY_RUN=dry_run,
    )

    assert resolved == {"creators": "openai", "mode": "live", "dry_run": dry_run}
