"""apply_suggestion dispatch for SP-7c reconcile ops (add_step + recite_node)."""
from uuid import uuid4

from sqlalchemy import select

from app.api.v2 import processes as proc_api
from app.enums import ClaimLinkKind
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion
from app.models.project import Project


def _seed_map(db):
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    process = Process(project_id=project.id, name="P1"); db.add(process); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2", process_id=process.id); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()
    n1 = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name="Receive", position={"x": 0, "relative_y": 0}, properties={})
    db.add(n1); db.flush()
    claim = Claim(project_id=project.id, kind="task", subject="A claim", normalized={}); db.add(claim); db.flush()
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim.id)); db.commit()
    return project, process, version, lane, n1, claim


def _suggestion(db, project, process, version, op, payload):
    s = ProcessSuggestion(
        batch_id=uuid4(), project_id=project.id, kind="map_reconcile",
        process_id=process.id, version_id=version.id, op=op, payload=payload,
        rationale="r", status="pending",
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def test_apply_add_step(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "add_step", {
        "name": "Verify budget", "type": "task", "after_node_id": str(n1.id),
        "lane_ref": None, "lane_name": None, "edge_label": "if over $10k",
        "cited_claim_ids": [str(claim.id)],
    })
    result = proc_api.apply_suggestion(db, project, s)
    db.commit()
    assert result.status == "accepted"
    assert result.outcome == "applied"
    new_nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == version.id, ProcessNode.name == "Verify budget")).all())
    assert len(new_nodes) == 1
    new_node = new_nodes[0]
    assert new_node.properties["ai_proposed"] is True
    edge = db.scalars(select(ProcessEdge).where(ProcessEdge.target_node_id == new_node.id)).one()
    assert edge.source_node_id == n1.id
    links = list(db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id == new_node.id)).all())
    assert [l.claim_id for l in links] == [claim.id]


def test_apply_add_step_target_gone(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "add_step", {
        "name": "Orphan", "type": "task", "after_node_id": str(uuid4()),
        "lane_ref": None, "lane_name": None, "edge_label": None, "cited_claim_ids": [],
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    assert db.scalars(select(ProcessNode).where(ProcessNode.name == "Orphan")).first() is None
    assert result.outcome == "target_gone"
    assert result.status == "accepted"


def test_apply_recite_node_add_and_remove(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    other = Claim(project_id=project.id, kind="task", subject="Other", normalized={}); db.add(other); db.flush()
    db.add(NodeClaimLink(node_id=n1.id, claim_id=other.id, link_kind=ClaimLinkKind.SUPPORTS.value)); db.commit()
    s = _suggestion(db, project, process, version, "recite_node", {
        "node_id": str(n1.id), "add_claim_ids": [str(claim.id)], "remove_claim_ids": [str(other.id)],
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    links = {l.claim_id for l in db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id == n1.id)).all()}
    assert claim.id in links and other.id not in links
    assert result.status == "accepted" and result.outcome == "applied"


def test_apply_recite_node_target_gone(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "recite_node", {
        "node_id": str(uuid4()), "add_claim_ids": [str(claim.id)], "remove_claim_ids": [],
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    assert result.outcome == "target_gone"


def test_apply_recite_node_idempotent_add(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    # Claim already cited on n1 — re-citing it must not duplicate the link.
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    s = _suggestion(db, project, process, version, "recite_node", {
        "node_id": str(n1.id), "add_claim_ids": [str(claim.id)], "remove_claim_ids": [],
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    links = list(db.scalars(select(NodeClaimLink).where(
        NodeClaimLink.node_id == n1.id, NodeClaimLink.claim_id == claim.id)).all())
    assert len(links) == 1  # no duplicate
    assert result.status == "accepted" and result.outcome == "applied"


def test_apply_recite_node_skips_foreign_project_claim(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    # A claim in a DIFFERENT project (same org) must not be linkable onto this node.
    other_project = Project(org_id=project.org_id, name="P2", created_by=project.created_by)
    db.add(other_project); db.flush()
    foreign = Claim(project_id=other_project.id, kind="task", subject="Foreign", normalized={})
    db.add(foreign); db.commit()
    s = _suggestion(db, project, process, version, "recite_node", {
        "node_id": str(n1.id), "add_claim_ids": [str(foreign.id)], "remove_claim_ids": [],
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    links = {l.claim_id for l in db.scalars(select(NodeClaimLink).where(
        NodeClaimLink.node_id == n1.id)).all()}
    assert foreign.id not in links  # foreign-project claim rejected by ownership check
    assert result.status == "accepted"
