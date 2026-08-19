"""The published issue must be the artefact on disk, not a re-derivation of it.

`publish` reads `report.json` back rather than re-running the workflow, so the
reader has to be lossless and it has to fail loudly rather than quietly dropping
a field a reviewer would have wanted to see.
"""

from __future__ import annotations

import json

import pytest

from modeltree_updater.parsing import (
    ArtifactError,
    load_run_report,
    proposal_from_dict,
    report_from_dict,
)


def test_a_written_report_round_trips_without_losing_a_field(report_factory) -> None:
    report = report_factory("contoso-ai", "fabrikam-ai")

    restored = report_from_dict(json.loads(json.dumps(report.to_dict())))

    assert restored.to_dict() == report.to_dict()


def test_every_fixture_proposal_round_trips(proposal_factory, library) -> None:
    for creator_id in sorted(library.creator_ids):
        proposal = proposal_factory(creator_id)

        restored = proposal_from_dict(json.loads(json.dumps(proposal.to_dict())))

        assert restored.to_dict() == proposal.to_dict(), creator_id


def test_the_report_is_loaded_from_the_path_the_run_wrote(
    tmp_path, report_factory
) -> None:
    report = report_factory("contoso-ai")
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report.to_dict()), encoding="utf-8")

    assert load_run_report(path).to_dict() == report.to_dict()


def test_a_missing_report_names_the_path_it_looked_for(tmp_path) -> None:
    with pytest.raises(ArtifactError) as error:
        load_run_report(tmp_path / "nope" / "report.json")

    assert "report.json" in str(error.value)


def test_a_report_that_is_not_json_is_refused(tmp_path) -> None:
    path = tmp_path / "report.json"
    path.write_text("{not json", encoding="utf-8")

    with pytest.raises(ArtifactError):
        load_run_report(path)


def test_an_unknown_field_is_refused_rather_than_ignored(report_factory) -> None:
    """A field this reader silently dropped is a field a reviewer never saw."""
    data = report_factory("contoso-ai").to_dict()
    data["proposals"][0]["surprise"] = "hello"

    with pytest.raises(ArtifactError) as error:
        report_from_dict(data)

    assert "surprise" in str(error.value)


def test_a_missing_required_field_is_refused(report_factory) -> None:
    data = report_factory("contoso-ai").to_dict()
    del data["proposals"][0]["creator_id"]

    with pytest.raises(ArtifactError) as error:
        report_from_dict(data)

    assert "creator_id" in str(error.value)


def test_an_unknown_enum_value_says_what_was_expected(report_factory) -> None:
    data = report_factory("contoso-ai").to_dict()
    data["proposals"][0]["status"] = "probably-fine"

    with pytest.raises(ArtifactError) as error:
        report_from_dict(data)

    message = str(error.value)
    assert "probably-fine" in message
    assert "complete" in message


def test_a_report_that_is_not_an_object_is_refused() -> None:
    with pytest.raises(ArtifactError):
        report_from_dict([])
