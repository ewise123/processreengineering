# backend/tests/test_node_issues.py
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.enums import ConflictStatus
from app.models.claim import Claim, ClaimConflict
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


def _seed_node_with_conflict(db, detection_reason: str = "X vs Y"):
    """Create a project, node, two claims linked to the node, and one
    DETECTED ClaimConflict between them with the given detection_reason."""
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
    c1 = Claim(project_id=proj.id, kind="threshold", subject="c1", normalized={}, source="extracted")
    c2 = Claim(project_id=proj.id, kind="threshold", subject="c2", normalized={}, source="extracted")
    db.add_all([c1, c2])
    db.flush()
    db.add(NodeClaimLink(node_id=node.id, claim_id=c1.id))
    db.flush()
    conflict = ClaimConflict(
        claim_a_id=c1.id,
        claim_b_id=c2.id,
        kind="threshold_mismatch",
        detected_by="ai",
        resolution_status=ConflictStatus.DETECTED.value,
        detection_reason=detection_reason,
    )
    db.add(conflict)
    db.commit()
    return proj, node, c1, c2, conflict


def test_node_issues_carries_detection_reason(client, db):
    """get_node_issues must expose detection_reason so the canvas issue card
    can show the AI explanation rather than a blank string."""
    proj, node, _c1, _c2, conflict = _seed_node_with_conflict(db, "500 vs 1000")
    resp = client.get(f"/api/v2/projects/{proj.id}/nodes/{node.id}/issues")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["issues"]) == 1
    issue = body["issues"][0]
    assert issue["conflict_id"] == str(conflict.id)
    assert issue["detection_reason"] == "500 vs 1000"


def test_node_issues_returns_empty_when_no_links(client, db):
    """A node with no claim links must return an empty issues list."""
    org = Organization(name="t2")
    db.add(org)
    db.flush()
    db.add(User(email="dev@local", name="dev", org_id=org.id))
    db.flush()
    proj = Project(name="p2", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    model = ProcessModel(project_id=proj.id, name="m2", level="L2")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="L2", order_index=0, height_px=150)
    db.add(lane)
    db.flush()
    node = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="n2",
        position={}, properties={},
    )
    db.add(node)
    db.commit()
    resp = client.get(f"/api/v2/projects/{proj.id}/nodes/{node.id}/issues")
    assert resp.status_code == 200, resp.text
    assert resp.json()["issues"] == []


def test_node_issues_excludes_resolved_conflicts(client, db):
    """Resolved conflicts must not appear in the node issues list."""
    proj, node, c1, _c2, conflict = _seed_node_with_conflict(db, "original reason")
    # Resolve the conflict directly in DB.
    conflict.resolution_status = ConflictStatus.RESOLVED.value
    db.commit()
    resp = client.get(f"/api/v2/projects/{proj.id}/nodes/{node.id}/issues")
    assert resp.status_code == 200, resp.text
    assert resp.json()["issues"] == []
