"""Integration tests for SP-2 node-type and lane color/collapse editing."""
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
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


def _seed_map(db):
    """Create org/dev-user/project + a one-lane, one-node process version with
    a claim linked to the node (to assert provenance survives a type change).
    Returns (project, version, lane, node, claim)."""
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L1")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="Lane A", order_index=0, height_px=150)
    db.add(lane)
    db.flush()
    node = ProcessNode(
        version_id=version.id,
        lane_id=lane.id,
        type="task",
        name="Do work",
        position={"x": 120.0, "relative_y": 40.0},
        properties={},
    )
    db.add(node)
    db.flush()
    inp = Input(
        project_id=proj.id, type="interview_transcript", name="i.txt",
        file_path="i.txt", file_size=10, mime_type="text/plain",
        status="parsed", uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec)
    db.flush()
    ch = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    db.add(ch)
    db.flush()
    claim = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    db.add(claim)
    db.flush()
    db.add(ClaimCitation(claim_id=claim.id, chunk_id=ch.id, quote="a", confidence=0.9))
    db.add(NodeClaimLink(node_id=node.id, claim_id=claim.id))
    db.commit()
    return proj, version, lane, node, claim


def test_patch_node_type_persists(client, db):
    proj, _version, _lane, node, _claim = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}",
        json={"type": "gateway_exclusive", "reason": "Convert task to gateway"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["type"] == "gateway_exclusive"
    db.expire_all()
    assert db.get(ProcessNode, node.id).type == "gateway_exclusive"


def test_patch_node_type_invalid_rejected(client, db):
    proj, _v, _l, node, _c = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}",
        json={"type": "bogus_type"},
    )
    assert resp.status_code == 422, resp.text


def test_patch_node_type_preserves_claim_links(client, db):
    proj, _v, _l, node, claim = _seed_map(db)
    client.patch(
        f"/api/v2/projects/{proj.id}/nodes/{node.id}",
        json={"type": "subprocess", "reason": "Convert task to subprocess"},
    )
    db.expire_all()
    links = (
        db.query(NodeClaimLink).filter(NodeClaimLink.node_id == node.id).all()
    )
    assert len(links) == 1
    assert links[0].claim_id == claim.id


from sqlalchemy import text as _sa_text


def test_lane_columns_exist(test_engine):
    with test_engine.connect() as conn:
        rows = conn.execute(
            _sa_text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='process_lanes' AND column_name IN ('color','collapsed')"
            )
        ).fetchall()
    assert {r[0] for r in rows} == {"color", "collapsed"}


def test_patch_lane_color_and_collapsed(client, db):
    proj, _v, lane, _n, _c = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/lanes/{lane.id}",
        json={"color": "#aabbcc", "collapsed": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["color"] == "#aabbcc"
    assert body["collapsed"] is True
    db.expire_all()
    fresh = db.get(ProcessLane, lane.id)
    assert fresh.color == "#aabbcc"
    assert fresh.collapsed is True


def test_patch_lane_color_invalid_rejected(client, db):
    proj, _v, lane, _n, _c = _seed_map(db)
    resp = client.patch(
        f"/api/v2/projects/{proj.id}/lanes/{lane.id}",
        json={"color": "red"},
    )
    assert resp.status_code == 422, resp.text


def test_lane_read_defaults_when_unset(client, db):
    proj, version, _lane, _n, _c = _seed_map(db)
    resp = client.get(
        f"/api/v2/projects/{proj.id}/process-maps/{version.model_id}/versions/{version.id}"
    )
    assert resp.status_code == 200, resp.text
    lane0 = resp.json()["lanes"][0]
    assert lane0["color"] is None
    assert lane0["collapsed"] is False
