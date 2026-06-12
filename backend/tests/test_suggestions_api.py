"""Suggestion inbox: suggest-processes (mocked Claude), list/accept/reject,
batch-accept, apply_suggestion dispatch incl. stale no-ops and bad-op 422."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.factory import create_app
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion
from app.models.project import Project
from app.services.process_detection import DetectedSegment, DetectionResult


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    c1 = Claim(project_id=proj.id, kind="task", subject="AP", normalized={}, confidence=0.9, source="extracted")
    c2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9, source="extracted")
    db.add_all([c1, c2]); db.commit()
    return proj, [c1, c2]


def test_suggest_processes_writes_discovery_rows(client, db):
    proj, claims = _seed(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("Accounts Payable", "ap", [0], 0.9),
            DetectedSegment("Onboarding", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="grouped",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with patch("app.api.v2.processes.detect_segments_from_claims", return_value=fake):
        r = client.post(f"/api/v2/projects/{proj.id}/suggest-processes", json={})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["suggestion_count"] == 2
    batch_id = body["batch_id"]

    r = client.get(f"/api/v2/projects/{proj.id}/process-suggestions?status=pending&kind=process_discovery")
    rows = r.json()
    assert len(rows) == 2
    assert all(s["op"] == "create_process" for s in rows)
    assert all(s["batch_id"] == batch_id for s in rows)
    # Each create_process payload names the claim_ids it would assign.
    ap = next(s for s in rows if s["payload"]["name"] == "Accounts Payable")
    assert ap["payload"]["claim_ids"] == [str(claims[0].id)]


def test_accept_create_process_creates_process_and_links(client, db):
    proj, claims = _seed(db)
    fake = DetectionResult(
        segments=[DetectedSegment("Accounts Payable", "ap", [0, 1], 0.9)],
        unassigned_claim_refs=[], reasoning_summary="", model_used="m",
        prompt_tokens=1, output_tokens=1,
    )
    with patch("app.api.v2.processes.detect_segments_from_claims", return_value=fake):
        client.post(f"/api/v2/projects/{proj.id}/suggest-processes", json={})
    sid = client.get(f"/api/v2/projects/{proj.id}/process-suggestions").json()[0]["id"]

    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sid}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"
    assert r.json()["outcome"] == "applied"
    assert r.json()["linked"] == 2

    procs = db.query(Process).filter(Process.project_id == proj.id).all()
    assert len(procs) == 1 and procs[0].name == "Accounts Payable"
    links = db.query(ProcessClaimLink).filter(ProcessClaimLink.process_id == procs[0].id).all()
    assert len(links) == 2
    assert all(l.assigned_by == "ai_accepted" for l in links)


def test_accept_assign_claims_to_existing_process(client, db):
    proj, claims = _seed(db)
    proc = Process(project_id=proj.id, name="Existing", status="active")
    db.add(proc); db.commit()
    sug = ProcessSuggestion(
        batch_id=claims[0].id,  # any uuid works as a batch id for the test
        project_id=proj.id, kind="process_discovery",
        process_id=proc.id, op="assign_claims",
        payload={"process_id": str(proc.id), "claim_ids": [str(claims[0].id)]},
        rationale="", status="pending",
    )
    db.add(sug); db.commit()

    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["outcome"] == "applied"
    links = db.query(ProcessClaimLink).filter(ProcessClaimLink.process_id == proc.id).all()
    assert len(links) == 1


def test_accept_with_deleted_target_is_graceful_no_op(client, db):
    proj, claims = _seed(db)
    sug = ProcessSuggestion(
        batch_id=claims[0].id, project_id=proj.id, kind="process_discovery",
        process_id=None, op="assign_claims",
        payload={"process_id": "00000000-0000-0000-0000-000000000000", "claim_ids": [str(claims[0].id)]},
        rationale="", status="pending",
    )
    db.add(sug); db.commit()
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted"
    assert r.json()["outcome"] == "target_gone"
    assert db.query(ProcessClaimLink).count() == 0


def test_accept_unknown_op_kind_is_422(client, db):
    proj, claims = _seed(db)
    # recite_node became a real op in sp7c; use a genuinely unknown op to keep
    # exercising the dispatcher's 422 fallthrough.
    sug = ProcessSuggestion(
        batch_id=claims[0].id, project_id=proj.id, kind="map_reconcile",
        process_id=None, op="bogus_op",
        payload={"node_id": "x"}, rationale="", status="pending",
    )
    db.add(sug); db.commit()
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/accept")
    assert r.status_code == 422
    assert "bogus_op" in r.json()["detail"]
    # Status untouched on failure.
    db.refresh(sug)
    assert sug.status == "pending"


def test_reject_marks_rejected_without_side_effects(client, db):
    proj, claims = _seed(db)
    sug = ProcessSuggestion(
        batch_id=claims[0].id, project_id=proj.id, kind="process_discovery",
        process_id=None, op="create_process",
        payload={"name": "X", "description": "", "claim_ids": [str(claims[0].id)]},
        rationale="", status="pending",
    )
    db.add(sug); db.commit()
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestions/{sug.id}/reject")
    assert r.status_code == 200
    assert r.json()["status"] == "rejected"
    assert db.query(Process).count() == 0


def test_batch_accept_accepts_all_pending_in_batch(client, db):
    proj, claims = _seed(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("AP", "ap", [0], 0.9),
            DetectedSegment("OB", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[], reasoning_summary="", model_used="m",
        prompt_tokens=1, output_tokens=1,
    )
    with patch("app.api.v2.processes.detect_segments_from_claims", return_value=fake):
        batch_id = client.post(f"/api/v2/projects/{proj.id}/suggest-processes", json={}).json()["batch_id"]
    r = client.post(f"/api/v2/projects/{proj.id}/process-suggestion-batches/{batch_id}/accept")
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] == 2
    assert db.query(Process).filter(Process.project_id == proj.id).count() == 2
