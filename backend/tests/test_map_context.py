"""Unit test for the shared map-context builder used by chat + ai-edit."""
from uuid import uuid4

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
from app.models.project import Project
from app.services.map_context import assemble_map_context


def _seed_version(db):
    org = Organization(name="O")
    db.add(org)
    db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U")
    db.add(user)
    db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id)
    db.add(project)
    db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2")
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1)
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0)
    db.add(lane)
    db.flush()
    n1 = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Receive",
        position={}, properties={},
    )
    n2 = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Approve",
        position={}, properties={},
    )
    db.add_all([n1, n2])
    db.flush()
    db.add(ProcessEdge(version_id=version.id, source_node_id=n1.id, target_node_id=n2.id))
    claim = Claim(project_id=project.id, kind="task", subject="Clerk receives the order", normalized={})
    db.add(claim)
    db.flush()
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    return project, version, n1, claim


def test_assemble_map_context_text_and_refs(db):
    project, version, n1, claim = _seed_version(db)
    ctx = assemble_map_context(db, version, selected_node_id=n1.id)

    assert "Receive" in ctx.text and "Approve" in ctx.text
    assert "Clerk receives the order" in ctx.text
    # Selected label names the selected node.
    assert "Receive" in (ctx.selected_label or "")
    # The single project claim is presented as C1 and maps back to its UUID.
    assert ctx.claim_ref_to_id["C1"] == claim.id


def test_assemble_map_context_no_selection(db):
    project, version, n1, claim = _seed_version(db)
    ctx = assemble_map_context(db, version, selected_node_id=None)
    assert ctx.selected_label is None
    assert "Approve" in ctx.text
