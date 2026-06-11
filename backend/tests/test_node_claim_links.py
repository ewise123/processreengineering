# backend/tests/test_node_claim_links.py
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_node_and_claims(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L2")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="L", order_index=0, height_px=150)
    db.add(lane)
    db.flush()
    node = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="n",
        position={}, properties={},
    )
    db.add(node)
    db.flush()
    c1 = Claim(project_id=proj.id, kind="task", subject="c1", normalized={}, source="manual")
    c2 = Claim(project_id=proj.id, kind="task", subject="c2", normalized={}, source="manual")
    db.add_all([c1, c2])
    db.commit()
    return proj, node, c1, c2


def test_attach_claims_creates_links(client, db):
    proj, node, c1, c2 = _seed_node_and_claims(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(c1.id), str(c2.id)], "link_kind": "evidence"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["added_count"] == 2
    assert body["already_linked_count"] == 0
    db.expire_all()
    count = db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    assert count == 2


def test_attach_claims_idempotent(client, db):
    proj, node, c1, _c2 = _seed_node_and_claims(db)
    db.add(NodeClaimLink(node_id=node.id, claim_id=c1.id))
    db.commit()
    resp = client.post(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(c1.id)]},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["added_count"] == 0
    assert body["already_linked_count"] == 1
    db.expire_all()
    count = db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    assert count == 1  # no duplicate row


def test_detach_claim_removes_link(client, db):
    proj, node, c1, _c2 = _seed_node_and_claims(db)
    db.add(NodeClaimLink(node_id=node.id, claim_id=c1.id))
    db.commit()
    resp = client.delete(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims/{c1.id}"
    )
    assert resp.status_code == 204, resp.text
    db.expire_all()
    count = db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).count()
    assert count == 0


def test_attach_cross_project_node_404(client, db):
    proj, node, c1, _c2 = _seed_node_and_claims(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.commit()
    resp = client.post(
        f"/api/v2/projects/{other.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(c1.id)]},
    )
    assert resp.status_code == 404, resp.text


def test_attach_rejects_claim_from_other_project(client, db):
    proj, node, _c1, _c2 = _seed_node_and_claims(db)
    other = Project(name="other", org_id=proj.org_id, status="active")
    db.add(other)
    db.flush()
    foreign = Claim(project_id=other.id, kind="task", subject="x", normalized={}, source="manual")
    db.add(foreign)
    db.commit()
    resp = client.post(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}/claims",
        json={"claim_ids": [str(foreign.id)]},
    )
    assert resp.status_code == 422, resp.text
