"""Integration tests for SP-4 version control."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.factory import create_app
from app.db.session import get_db
from app.enums import ReviewTargetType
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project
from app.models.workflow import Review


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed(db, n_nodes=2):
    """One model, one version (v1), two lanes, n_nodes nodes, 1 edge."""
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L1"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version); db.flush()
    laneA = ProcessLane(version_id=version.id, name="Lane A", order_index=0)
    laneB = ProcessLane(version_id=version.id, name="Lane B", order_index=1)
    db.add_all([laneA, laneB]); db.flush()
    nodes = []
    for i in range(n_nodes):
        nd = ProcessNode(
            version_id=version.id, lane_id=laneA.id, type="task",
            name=f"n{i}", position={}, properties={},
        )
        db.add(nd); nodes.append(nd)
    db.flush()
    edge = ProcessEdge(
        version_id=version.id,
        source_node_id=nodes[0].id,
        target_node_id=nodes[1].id,
        label=None,
    )
    db.add(edge); db.flush(); db.commit()
    return proj, model, version, [laneA, laneB], nodes


def _versions_url(proj, model):
    return f"/api/v2/projects/{proj.id}/process-maps/{model.id}/versions"


def test_list_versions_with_counts(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    resp = client.get(_versions_url(proj, model))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    row = body[0]
    assert row["version_number"] == 1
    assert row["parent_version_id"] is None
    assert row["node_count"] == 2
    assert row["lane_count"] == 2
    assert row["edge_count"] == 1
