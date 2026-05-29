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


def _seed(db, n_nodes=2, suffix=""):
    """One model, one version (v1), two lanes, n_nodes nodes, 1 edge.

    Pass a unique ``suffix`` when seeding a second org in the same test to
    avoid unique-constraint violations on the users.email column.
    """
    org = Organization(name=f"t{suffix}"); db.add(org); db.flush()
    user = User(email=f"dev{suffix}@local", name=f"dev{suffix}", org_id=org.id); db.add(user); db.flush()
    proj = Project(name=f"p{suffix}", org_id=org.id, status="active"); db.add(proj); db.flush()
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


def test_list_versions_404_for_foreign_model(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    proj2, model2, version2, _, _ = _seed(db, suffix="2")
    # model2 belongs to proj2, so listing it under proj must 404.
    r = client.get(_versions_url(proj, model2))
    assert r.status_code == 404, r.text


def _copy_url(proj, model, version):
    return f"{_versions_url(proj, model)}/{version.id}/copy"


def test_copy_creates_new_version_snapshot(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    r = client.post(_copy_url(proj, model, version), json={"note": "Branched from v1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version_number"] == 2
    assert body["status"] == "draft"
    assert body["notes"] == "Branched from v1"
    new_id = body["id"]
    new_version = db.get(ProcessVersion, new_id)
    assert str(new_version.parent_version_id) == str(version.id)
    listing = client.get(_versions_url(proj, model)).json()
    by_num = {row["version_number"]: row for row in listing}
    assert by_num[2]["node_count"] == 2
    assert by_num[2]["lane_count"] == 2
    assert by_num[2]["edge_count"] == 1

    new_nodes = db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == new_id)
    ).all()
    new_node_ids = {n.id for n in new_nodes}
    new_edges = db.scalars(
        select(ProcessEdge).where(ProcessEdge.version_id == new_id)
    ).all()
    assert len(new_edges) == 1
    assert new_edges[0].source_node_id in new_node_ids
    assert new_edges[0].target_node_id in new_node_ids


def test_copy_preserves_claim_links(client, db):
    from app.models.claim import Claim

    proj, model, version, lanes, nodes = _seed(db)
    claim = Claim(project_id=proj.id, kind="fact", subject="c")
    db.add(claim); db.flush()
    db.add(NodeClaimLink(node_id=nodes[0].id, claim_id=claim.id))
    db.commit()

    r = client.post(_copy_url(proj, model, version), json={})
    assert r.status_code == 200, r.text
    new_id = r.json()["id"]
    new_nodes = db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == new_id)
    ).all()
    links = db.scalars(
        select(NodeClaimLink).where(
            NodeClaimLink.node_id.in_([n.id for n in new_nodes])
        )
    ).all()
    assert len(links) == 1
    assert str(links[0].claim_id) == str(claim.id)


def test_copy_seeds_and_inherits_lineage(client, db):
    proj, model, version, lanes, nodes = _seed(db)  # pre-lineage nodes (no _lineage_id)
    src_node_id = str(nodes[0].id)

    r1 = client.post(_copy_url(proj, model, version), json={})
    v2_id = r1.json()["id"]
    v2_nodes = db.scalars(select(ProcessNode).where(ProcessNode.version_id == v2_id)).all()
    seeded = {n.name: n.properties.get("_lineage_id") for n in v2_nodes}
    assert seeded["n0"] == src_node_id

    v2 = db.get(ProcessVersion, v2_id)
    r2 = client.post(_copy_url(proj, model, v2), json={})
    v3_id = r2.json()["id"]
    v3_nodes = db.scalars(select(ProcessNode).where(ProcessNode.version_id == v3_id)).all()
    inherited = {n.name: n.properties.get("_lineage_id") for n in v3_nodes}
    assert inherited["n0"] == src_node_id


def test_restore_parents_on_old_version(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    client.post(_copy_url(proj, model, version), json={})
    r = client.post(_copy_url(proj, model, version), json={"note": "Restored from v1"})
    assert r.json()["version_number"] == 3
    v3 = db.get(ProcessVersion, r.json()["id"])
    assert str(v3.parent_version_id) == str(version.id)


def test_copy_404_for_foreign_version(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    proj2, model2, version2, _, _ = _seed(db, suffix="2")
    r = client.post(_copy_url(proj, model, version2), json={})
    assert r.status_code == 404, r.text


def test_copy_has_fresh_review_slate(client, db):
    proj, model, version, lanes, nodes = _seed(db)
    db.add(Review(
        project_id=proj.id,
        target_type=ReviewTargetType.PROCESS_NODE.value,
        target_id=nodes[0].id,
        status="approved",
    ))
    db.commit()
    r = client.post(_copy_url(proj, model, version), json={})
    new_id = r.json()["id"]
    new_nodes = db.scalars(select(ProcessNode).where(ProcessNode.version_id == new_id)).all()
    reviews = db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id.in_([n.id for n in new_nodes]),
        )
    ).all()
    assert reviews == []
