"""apply_suggestion dispatch for SP-7c reconcile ops (add_step + recite_node)."""
from uuid import uuid4

from sqlalchemy import select

from app.api.v2 import processes as proc_api
from app.enums import ClaimLinkKind
from app.models.change_event import ChangeEvent
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


def test_apply_flag_stale_node(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "flag_stale_node", {
        "node_id": str(n1.id), "vanished_claim_ids": [str(claim.id)],
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    db.refresh(n1)
    assert n1.properties["evidence_stale"] is True
    assert result.status == "accepted" and result.outcome == "applied"


def test_apply_flag_stale_node_preserves_properties(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    n1.properties = {"_lineage_id": str(n1.id), "ai_proposed": True}
    db.commit()
    s = _suggestion(db, project, process, version, "flag_stale_node",
                    {"node_id": str(n1.id), "vanished_claim_ids": []})
    proc_api.apply_suggestion(db, project, s); db.commit()
    db.refresh(n1)
    assert n1.properties["evidence_stale"] is True
    assert n1.properties["_lineage_id"] == str(n1.id)
    assert n1.properties["ai_proposed"] is True


def test_apply_relabel_node(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "relabel_node", {
        "node_id": str(n1.id), "proposed_name": "Receive purchase order",
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    db.refresh(n1)
    assert n1.name == "Receive purchase order"
    assert result.status == "accepted" and result.outcome == "applied"


def test_apply_relabel_node_target_gone(db):
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "relabel_node", {
        "node_id": str(uuid4()), "proposed_name": "Nope",
    })
    result = proc_api.apply_suggestion(db, project, s); db.commit()
    assert result.outcome == "target_gone"


# ── Change-event tests (Task 12) ──────────────────────────────────────────────

def _change_events_for_target(db, target_id):
    return list(db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == target_id)
    ).all())


def test_relabel_node_writes_change_event(db):
    """Accepting a relabel_node suggestion writes a 'relabel' change_event with
    source='reconcile', actor_kind='ai', and suggestion_id == sug.id."""
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "relabel_node", {
        "node_id": str(n1.id), "proposed_name": "Receive purchase order",
    })
    result = proc_api.apply_suggestion(db, project, s)
    db.commit()

    assert result.outcome == "applied"
    events = _change_events_for_target(db, n1.id)
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "relabel"
    assert ev.source == "reconcile"
    assert ev.actor_kind == "ai"
    assert ev.suggestion_id == s.id
    assert ev.target_id == n1.id
    assert ev.before == {"name": "Receive"}
    assert ev.after == {"name": "Receive purchase order"}


def test_relabel_node_target_gone_writes_no_change_event(db):
    """TARGET_GONE path must NOT write a change_event."""
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "relabel_node", {
        "node_id": str(uuid4()), "proposed_name": "Ghost",
    })
    result = proc_api.apply_suggestion(db, project, s)
    db.commit()

    assert result.outcome == "target_gone"
    # No ChangeEvent should exist for a non-existent target; there's nothing to query,
    # but we can verify no events were written at all in this test session.
    all_events = list(db.scalars(select(ChangeEvent)).all())
    assert all_events == []


def test_add_step_writes_change_event(db):
    """Accepting an add_step suggestion writes a 'create' change_event for the new node."""
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "add_step", {
        "name": "Verify budget", "type": "task", "after_node_id": str(n1.id),
        "lane_ref": None, "lane_name": None, "edge_label": None,
        "cited_claim_ids": [str(claim.id)],
    })
    result = proc_api.apply_suggestion(db, project, s)
    db.commit()

    assert result.outcome == "applied"
    new_node = db.scalars(
        select(ProcessNode).where(
            ProcessNode.version_id == version.id, ProcessNode.name == "Verify budget"
        )
    ).one()
    events = _change_events_for_target(db, new_node.id)
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "create"
    assert ev.source == "reconcile"
    assert ev.actor_kind == "ai"
    assert ev.suggestion_id == s.id


def test_flag_stale_node_writes_change_event(db):
    """Accepting a flag_stale_node suggestion writes a 'flag_stale' change_event."""
    project, process, version, lane, n1, claim = _seed_map(db)
    s = _suggestion(db, project, process, version, "flag_stale_node", {
        "node_id": str(n1.id), "vanished_claim_ids": [str(claim.id)],
    })
    result = proc_api.apply_suggestion(db, project, s)
    db.commit()

    assert result.outcome == "applied"
    events = _change_events_for_target(db, n1.id)
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "flag_stale"
    assert ev.source == "reconcile"
    assert ev.actor_kind == "ai"
    assert ev.suggestion_id == s.id
    assert ev.after == {"evidence_stale": True}


def test_recite_node_writes_change_event(db):
    """Accepting a recite_node suggestion writes a 'recite' change_event."""
    project, process, version, lane, n1, claim = _seed_map(db)
    other = Claim(project_id=project.id, kind="task", subject="Other", normalized={})
    db.add(other)
    db.flush()  # ensure other.id is populated before creating the link
    db.add(NodeClaimLink(node_id=n1.id, claim_id=other.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    s = _suggestion(db, project, process, version, "recite_node", {
        "node_id": str(n1.id),
        "add_claim_ids": [str(claim.id)],
        "remove_claim_ids": [str(other.id)],
    })
    result = proc_api.apply_suggestion(db, project, s)
    db.commit()

    assert result.outcome == "applied"
    events = _change_events_for_target(db, n1.id)
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "recite"
    assert ev.source == "reconcile"
    assert ev.actor_kind == "ai"
    assert ev.suggestion_id == s.id
