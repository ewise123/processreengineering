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


def test_patch_segment_renames(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    seg_id = created["segments"][0]["id"]

    resp = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{seg_id}",
        json={"name": "Accounts Payable", "description": "AP flow."},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Accounts Payable"
    assert body["description"] == "AP flow."


def test_patch_segment_409_on_non_draft_run(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    # Manually flip run to accepted via the model layer to simulate immutability.
    from app.models.process_detection import DetectionRun as _DR
    run = db.get(_DR, created["id"])
    run.status = "accepted"
    db.commit()

    seg_id = created["segments"][0]["id"]
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{seg_id}",
        json={"name": "New name"},
    )
    assert resp.status_code == 409


def test_patch_unassigned_segment_409(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    un_id = created["unassigned_segment"]["id"]
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{un_id}",
        json={"name": "Renamed unassigned"},
    )
    assert resp.status_code == 409


def test_create_empty_segment(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    run_id = created["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{run_id}/segments",
        json={"name": "Manual cluster"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Manual cluster"
    assert body["claim_count"] == 0
    assert body["is_unassigned"] is False


def test_merge_segment_moves_memberships(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    a_id = created["segments"][0]["id"]
    b_id = created["segments"][1]["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/segments/{a_id}/merge",
        json={"into_segment_id": b_id},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == b_id
    assert body["claim_count"] == 2

    # Source segment should be gone.
    resp2 = client.patch(
        f"/api/v2/projects/{proj.id}/segments/{a_id}",
        json={"name": "x"},
    )
    assert resp2.status_code == 404


def test_delete_segment_moves_claims_to_unassigned(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    seg = created["segments"][0]
    un_id = created["unassigned_segment"]["id"]

    resp = client.delete(
        f"/api/v2/projects/{proj.id}/segments/{seg['id']}"
    )
    assert resp.status_code == 204

    # Reload the run; expect 1 regular segment, unassigned with +1 claim.
    detail = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}"
    ).json()
    assert len(detail["segments"]) == 1
    assert detail["unassigned_segment"]["claim_count"] == seg["claim_count"]


def test_move_claim_between_segments(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    a = created["segments"][0]
    b = created["segments"][1]
    moving_claim_id = a["claims"][0]["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/segments/{b['id']}/claims",
        json={"claim_id": moving_claim_id},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["claim_count"] == 2
    detail = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}"
    ).json()
    a_after = next(s for s in detail["segments"] if s["id"] == a["id"])
    assert a_after["claim_count"] == 0


def test_move_claim_to_unassigned_is_allowed(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    a = created["segments"][0]
    un = created["unassigned_segment"]
    moving = a["claims"][0]["id"]

    resp = client.post(
        f"/api/v2/projects/{proj.id}/segments/{un['id']}/claims",
        json={"claim_id": moving},
    )
    assert resp.status_code == 200


def test_accept_run_supersedes_prior_accepted_run(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        first = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    # Name both regular segments so accept passes validation.
    for i, seg in enumerate(first["segments"]):
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": f"Process-{i}"},
        )

    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{first['id']}/accept"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["accepted_segment_count"] == 2

    # Re-detect.
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        second = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    for i, seg in enumerate(second["segments"]):
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": f"Round2-{i}"},
        )
    resp2 = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{second['id']}/accept"
    )
    assert resp2.status_code == 200

    # Original run should now be superseded.
    detail = client.get(
        f"/api/v2/projects/{proj.id}/detection-runs/{first['id']}"
    ).json()
    assert detail["status"] == "superseded"


def test_accept_run_422_when_a_regular_segment_is_unnamed(client, db):
    proj = _seed_project_with_two_claims(db)
    fake = DetectionResult(
        segments=[DetectedSegment("", "", [0, 1], 0.5)],  # blank name
        unassigned_claim_refs=[],
        reasoning_summary="",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}/accept"
    )
    assert resp.status_code == 422


def test_accept_run_422_on_duplicate_names(client, db):
    proj = _seed_project_with_two_claims(db)
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=_fake_detection_result_two_segments(),
    ):
        created = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    for seg in created["segments"]:
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": "Same name"},
        )
    resp = client.post(
        f"/api/v2/projects/{proj.id}/detection-runs/{created['id']}/accept"
    )
    assert resp.status_code == 422
