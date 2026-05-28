"""Integration tests for the detection endpoints."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process_detection import DetectionRun, ProcessSegment
from app.models.project import Project
from app.services.process_detection import DetectedSegment, DetectionResult


@pytest.fixture()
def client(db):
    app = create_app()
    # Override get_db so the TestClient uses the same session as the test's `db`
    # fixture, which is connected to poet_test and already has the truncated tables.
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_project_with_two_claims(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="i.txt",
        file_path="i.txt",
        file_size=10,
        mime_type="text/plain",
        status="parsed",
        uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec)
    db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="b", tokens=1)
    db.add_all([ch1, ch2])
    db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2])
    db.flush()
    db.add_all(
        [
            ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="a", confidence=0.9),
            ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="b", confidence=0.9),
        ]
    )
    db.commit()
    return proj


def _fake_detection_result_two_segments():
    return DetectionResult(
        segments=[
            DetectedSegment("AP", "ap", [0], 0.9),
            DetectedSegment("OB", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="x",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )


def test_detect_processes_happy_path(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        resp = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes",
            json={},
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "draft"
    assert len(body["segments"]) == 2
    assert body["unassigned_segment"]["is_unassigned"] is True
    assert body["claim_count_at_run"] == 2


def test_detect_processes_409_when_draft_exists(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        resp1 = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        )
        assert resp1.status_code == 201
        resp2 = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        )
    assert resp2.status_code == 409


def test_detect_processes_422_when_no_claims(client, db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="empty", org_id=org.id, status="active")
    db.add(proj)
    db.commit()
    resp = client.post(f"/api/v2/projects/{proj.id}/detect-processes", json={})
    assert resp.status_code == 422


def test_detect_processes_422_when_zero_segments(client, db):
    proj = _seed_project_with_two_claims(db)
    empty = DetectionResult(
        segments=[], unassigned_claim_refs=[0, 1], reasoning_summary="",
        model_used="claude-sonnet-4-6", prompt_tokens=10, output_tokens=10,
    )
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=empty,
    ):
        resp = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        )
    assert resp.status_code == 422
    assert db.query(DetectionRun).count() == 0


def test_get_detection_run_returns_full_detail(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()

    resp = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == created["id"]
    assert len(body["segments"]) == 2


def test_list_detection_runs(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        client.post(f"/api/v2/projects/{proj.id}/detect-processes", json={})

    resp = client.get(f"/api/v2/projects/{proj.id}/detection-runs")
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["segment_count"] == 2
    assert rows[0]["status"] == "draft"
