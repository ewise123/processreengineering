# backend/tests/test_conflict_resolution.py
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.enums import ConflictStatus
from app.models.claim import Claim, ClaimConflict
from app.models.identity import Organization, User
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_conflict(db) -> tuple[Project, ClaimConflict]:
    org = Organization(name="t")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    a = Claim(project_id=proj.id, kind="threshold", subject="a", normalized={}, source="extracted")
    b = Claim(project_id=proj.id, kind="threshold", subject="b", normalized={}, source="extracted")
    db.add_all([a, b])
    db.flush()
    conflict = ClaimConflict(
        claim_a_id=a.id, claim_b_id=b.id, kind="threshold_mismatch",
        detected_by="ai", resolution_status=ConflictStatus.DETECTED.value,
        detection_reason="500 vs 1000",
    )
    db.add(conflict)
    db.commit()
    return proj, conflict


def test_resolve_conflict_sets_status_and_notes(client, db):
    proj, conflict = _seed_conflict(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "resolved", "resolution_notes": "Picked 1000 per SLA"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["resolution_status"] == "resolved"
    assert body["resolution_notes"] == "Picked 1000 per SLA"
    assert body["detection_reason"] == "500 vs 1000"  # untouched
    db.expire_all()
    fresh = db.get(ClaimConflict, conflict.id)
    assert fresh.resolution_status == "resolved"


def test_resolve_conflict_rejects_bad_status(client, db):
    proj, conflict = _seed_conflict(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "bogus"},
    )
    assert resp.status_code == 422, resp.text


def test_resolve_conflict_cross_project_404(client, db):
    proj, conflict = _seed_conflict(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.commit()
    resp = client.patch(
        f"/api/v2/projects/{other.id}/conflicts/{conflict.id}",
        json={"resolution_status": "dismissed"},
    )
    assert resp.status_code == 404, resp.text


def test_resolve_conflict_omitting_notes_preserves_existing(client, db):
    proj, conflict = _seed_conflict(db)
    # First, a user sets a note via a full PATCH.
    r1 = client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "resolved", "resolution_notes": "Keep this note"},
    )
    assert r1.status_code == 200, r1.text
    # Later, a status-only PATCH (e.g. from the canvas) must NOT wipe the note.
    r2 = client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "dismissed"},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["resolution_status"] == "dismissed"
    assert r2.json()["resolution_notes"] == "Keep this note"  # preserved


def test_resolve_conflict_explicit_null_clears_notes(client, db):
    proj, conflict = _seed_conflict(db)
    client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "resolved", "resolution_notes": "temp"},
    )
    r = client.patch(
        f"/api/v2/projects/{proj.id}/conflicts/{conflict.id}",
        json={"resolution_status": "resolved", "resolution_notes": None},
    )
    assert r.status_code == 200, r.text
    assert r.json()["resolution_notes"] is None  # explicit null still clears
