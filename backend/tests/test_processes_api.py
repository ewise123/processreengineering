"""Integration tests for the Process Inventory CRUD + curation endpoints."""
import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.factory import create_app
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.project import Project


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
    c1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9, source="extracted")
    c2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9, source="manual")
    db.add_all([c1, c2]); db.commit()
    return proj, [c1, c2]


def test_create_list_patch_delete_process(client, db):
    proj, _ = _seed(db)
    r = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "Order to Cash"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    assert r.json()["claim_count"] == 0
    assert r.json()["map_count"] == 0

    r = client.get(f"/api/v2/projects/{proj.id}/processes")
    assert r.status_code == 200
    assert [p["name"] for p in r.json()] == ["Order to Cash"]

    r = client.patch(f"/api/v2/projects/{proj.id}/processes/{pid}", json={"name": "O2C"})
    assert r.status_code == 200
    assert r.json()["name"] == "O2C"

    r = client.delete(f"/api/v2/projects/{proj.id}/processes/{pid}")
    assert r.status_code == 204
    # Soft-deleted → absent from list.
    r = client.get(f"/api/v2/projects/{proj.id}/processes")
    assert r.json() == []


def test_bulk_assign_is_idempotent_and_counts(client, db):
    proj, claims = _seed(db)
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    body = {"claim_ids": [str(claims[0].id), str(claims[1].id)]}

    r = client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json=body)
    assert r.status_code == 200, r.text
    assert r.json() == {"process_id": pid, "linked": 2, "already_linked": 0}

    # Re-assign the same claims — idempotent, no duplicate rows.
    r = client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json=body)
    assert r.json() == {"process_id": pid, "linked": 0, "already_linked": 2}

    r = client.get(f"/api/v2/projects/{proj.id}/processes")
    assert r.json()[0]["claim_count"] == 2


def test_bulk_unassign(client, db):
    proj, claims = _seed(db)
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    body = {"claim_ids": [str(claims[0].id), str(claims[1].id)]}
    client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json=body)

    r = client.request("DELETE", f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json={"claim_ids": [str(claims[0].id)]})
    assert r.status_code == 200, r.text
    assert r.json() == {"process_id": pid, "removed": 1}
    assert client.get(f"/api/v2/projects/{proj.id}/processes").json()[0]["claim_count"] == 1


def test_unassigned_lists_only_unlinked_claims(client, db):
    proj, claims = _seed(db)
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    client.post(f"/api/v2/projects/{proj.id}/processes/{pid}/claims", json={"claim_ids": [str(claims[0].id)]})

    r = client.get(f"/api/v2/projects/{proj.id}/claims/unassigned")
    assert r.status_code == 200
    ids = {c["id"] for c in r.json()}
    assert ids == {str(claims[1].id)}


def test_assign_ignores_claims_from_another_project(client, db):
    proj, _ = _seed(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.flush()
    foreign = Claim(
        project_id=other.id, kind="task", subject="foreign",
        normalized={}, confidence=0.9, source="extracted",
    )
    db.add(foreign)
    db.commit()
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    # A claim that belongs to a different project is silently ignored.
    r = client.post(
        f"/api/v2/projects/{proj.id}/processes/{pid}/claims",
        json={"claim_ids": [str(foreign.id)]},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"process_id": pid, "linked": 0, "already_linked": 0}
    assert client.get(f"/api/v2/projects/{proj.id}/processes").json()[0]["claim_count"] == 0


def test_process_mutations_404_across_projects(client, db):
    proj, _ = _seed(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.commit()
    pid = client.post(f"/api/v2/projects/{proj.id}/processes", json={"name": "X"}).json()["id"]
    # The process belongs to proj; reaching it via another project's route 404s.
    assert client.patch(f"/api/v2/projects/{other.id}/processes/{pid}", json={"name": "Y"}).status_code == 404
    assert client.delete(f"/api/v2/projects/{other.id}/processes/{pid}").status_code == 404
