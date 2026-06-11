import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text as sa_text

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.project import Project


def test_claim_source_and_detection_reason_columns_exist(test_engine):
    with test_engine.connect() as conn:
        claim_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claims' AND column_name='source'"
                )
            ).fetchall()
        }
        conflict_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claim_conflicts' "
                    "AND column_name='detection_reason'"
                )
            ).fetchall()
        }
    assert claim_cols == {"source"}
    assert conflict_cols == {"detection_reason"}


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_project(db) -> Project:
    org = Organization(name="t")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.commit()
    return proj


def test_create_manual_claim(client, db):
    proj = _seed_project(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/claims",
        json={"kind": "task", "subject": "Approve the invoice"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "task"
    assert body["subject"] == "Approve the invoice"
    assert body["source"] == "manual"
    assert body["normalized"] == {}
    db.expire_all()
    claim = db.get(Claim, body["id"])
    assert claim is not None and claim.source == "manual"


def test_create_claim_rejects_bad_kind(client, db):
    proj = _seed_project(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/claims",
        json={"kind": "not_a_kind", "subject": "x"},
    )
    assert resp.status_code == 422, resp.text
