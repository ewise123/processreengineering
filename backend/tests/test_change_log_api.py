"""Tests for GET /projects/{project_id}/nodes/{node_id}/history
and GET /projects/{project_id}/edges/{edge_id}/history (Task 15).

Reuses _seed_version_for_endpoint from test_ai_edit to create a minimal
project/model/version/lane/node fixture, then drives the existing update_node
and create_edge endpoints to produce ChangeEvent rows, and exercises the
new history endpoints directly (no TestClient needed).
"""
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import change_log as cl_api
from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.models.identity import Organization, User
from app.models.process import ProcessEdge, ProcessLane, ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.schemas.change_event import ChangeEventRead, ChangeLogPage
from app.schemas.process_map import EdgeCreate, EdgeUpdate, NodeUpdate
from tests.test_ai_edit import _seed_version_for_endpoint


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _seed_edge(db, version, n1):
    """Create a second node and an edge n1→n2 directly (no endpoint),
    so we can later check edge history via the endpoint."""
    n2 = ProcessNode(
        version_id=version.id,
        lane_id=n1.lane_id,
        type="task",
        name="Approve",
        position={},
        properties={},
    )
    db.add(n2)
    db.flush()
    edge = ProcessEdge(
        version_id=version.id,
        source_node_id=n1.id,
        target_node_id=n2.id,
        label=None,
    )
    db.add(edge)
    db.commit()
    return n2, edge


# ---------------------------------------------------------------------------
# ChangeEventRead schema
# ---------------------------------------------------------------------------

def test_change_log_page_defined():
    """ChangeLogPage exists and carries items + next_cursor (needed by Task 19)."""
    page = ChangeLogPage(items=[], next_cursor=None)
    assert page.items == []
    assert page.next_cursor is None


def test_change_event_read_has_thinking_computed():
    """has_thinking is derived from reasoning_trace, not stored."""
    from datetime import datetime, timezone

    ev_with = ChangeEventRead(
        id=uuid4(),
        created_at=datetime.now(tz=timezone.utc),
        target_type="node",
        target_id=uuid4(),
        kind="relabel",
        reason="r",
        actor_kind="human",
        before=None,
        after=None,
        cited_claim_ids=None,
        reasoning_trace=[{"type": "thinking", "thinking": "..."}],
        source="manual",
        version_id=None,
    )
    assert ev_with.has_thinking is True

    ev_without = ev_with.model_copy(update={"reasoning_trace": None})
    assert ev_without.has_thinking is False


# ---------------------------------------------------------------------------
# Node history endpoint
# ---------------------------------------------------------------------------

def test_node_history_empty_for_no_events(db):
    """History endpoint returns [] for a node with no change events."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # No events were written yet (seed helper doesn't call record_change).
    result = cl_api.get_node_history(project=project, node_id=n1.id, db=db)
    assert isinstance(result, list)
    assert result == []


def test_node_history_ordered_oldest_newest(db):
    """Two semantic updates on the same node → two events in created_at order."""
    project, version, n1, claim = _seed_version_for_endpoint(db)

    # First edit
    pm_api.update_node(
        project=project,
        node_id=n1.id,
        payload=NodeUpdate(name="Receive PO", reason="Corrected name"),
        db=db,
    )
    # Second edit
    pm_api.update_node(
        project=project,
        node_id=n1.id,
        payload=NodeUpdate(name="Receive Invoice", reason="Business renamed it"),
        db=db,
    )

    result = cl_api.get_node_history(project=project, node_id=n1.id, db=db)
    assert len(result) == 2

    # Oldest first
    assert result[0].created_at <= result[1].created_at

    # Correct kind and reason on each
    assert result[0].kind == "relabel"
    assert result[0].reason == "Corrected name"
    assert result[1].reason == "Business renamed it"


def test_node_history_has_thinking_false_for_manual(db):
    """Manual updates have no reasoning_trace → has_thinking is False."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    pm_api.update_node(
        project=project,
        node_id=n1.id,
        payload=NodeUpdate(name="Receive PO", reason="Rename"),
        db=db,
    )
    result = cl_api.get_node_history(project=project, node_id=n1.id, db=db)
    assert len(result) >= 1
    for ev in result:
        assert ev.has_thinking is False


def test_node_history_returns_change_event_read_instances(db):
    """Each item in the returned list is a ChangeEventRead."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    pm_api.update_node(
        project=project,
        node_id=n1.id,
        payload=NodeUpdate(name="Step 1", reason="Initial rename"),
        db=db,
    )
    result = cl_api.get_node_history(project=project, node_id=n1.id, db=db)
    assert len(result) == 1
    ev = result[0]
    assert isinstance(ev, ChangeEventRead)
    assert ev.target_type == "node"
    assert ev.target_id == n1.id


# ---------------------------------------------------------------------------
# Edge history endpoint
# ---------------------------------------------------------------------------

def test_edge_history_empty_for_no_events(db):
    """History endpoint returns [] for an edge created without the API endpoint."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    n2, edge = _seed_edge(db, version, n1)
    result = cl_api.get_edge_history(project=project, edge_id=edge.id, db=db)
    assert result == []


def test_edge_history_after_label_update(db):
    """Updating an edge label via the endpoint writes one event."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    n2, edge = _seed_edge(db, version, n1)

    pm_api.update_edge(
        project=project,
        edge_id=edge.id,
        payload=EdgeUpdate(label="Yes", reason="Added decision label"),
        db=db,
    )

    result = cl_api.get_edge_history(project=project, edge_id=edge.id, db=db)
    assert len(result) == 1
    ev = result[0]
    assert isinstance(ev, ChangeEventRead)
    assert ev.target_type == "edge"
    assert ev.target_id == edge.id
    assert ev.kind == "relabel"
    assert ev.reason == "Added decision label"
    assert ev.has_thinking is False


def test_edge_history_multiple_events_ordered(db):
    """Two label changes → two events oldest-first."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    n2, edge = _seed_edge(db, version, n1)

    pm_api.update_edge(
        project=project,
        edge_id=edge.id,
        payload=EdgeUpdate(label="Yes", reason="First label"),
        db=db,
    )
    pm_api.update_edge(
        project=project,
        edge_id=edge.id,
        payload=EdgeUpdate(label="Approved", reason="Refined label"),
        db=db,
    )

    result = cl_api.get_edge_history(project=project, edge_id=edge.id, db=db)
    assert len(result) == 2
    assert result[0].created_at <= result[1].created_at
    assert result[0].reason == "First label"
    assert result[1].reason == "Refined label"


# ---------------------------------------------------------------------------
# Ownership / 404 guards
# ---------------------------------------------------------------------------

def test_node_history_404_for_unknown_node(db):
    """A completely unknown node_id raises 404."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        cl_api.get_node_history(project=project, node_id=uuid4(), db=db)
    assert exc.value.status_code == 404


def test_node_history_404_for_node_in_other_project(db):
    """A node that belongs to a different project raises 404."""
    project, version, n1, claim = _seed_version_for_endpoint(db)

    # Build a second independent project/model/version/node
    from app.models.identity import Organization, User as UserModel
    org2 = Organization(name="Other org")
    db.add(org2)
    db.flush()
    user2 = UserModel(org_id=org2.id, email=f"other-{uuid4()}@x.io", name="U2")
    db.add(user2)
    db.flush()
    project2 = Project(org_id=org2.id, name="Other project", created_by=user2.id)
    db.add(project2)
    db.flush()
    model2 = ProcessModel(project_id=project2.id, name="M2", level="L2")
    db.add(model2)
    db.flush()
    version2 = ProcessVersion(model_id=model2.id, version_number=1)
    db.add(version2)
    db.flush()
    lane2 = ProcessLane(version_id=version2.id, name="Lane", order_index=0)
    db.add(lane2)
    db.flush()
    other_node = ProcessNode(
        version_id=version2.id,
        lane_id=lane2.id,
        type="task",
        name="Foreign step",
        position={},
        properties={},
    )
    db.add(other_node)
    db.commit()

    # Asking project 1 for a node owned by project 2 should 404
    with pytest.raises(HTTPException) as exc:
        cl_api.get_node_history(project=project, node_id=other_node.id, db=db)
    assert exc.value.status_code == 404


def test_edge_history_404_for_unknown_edge(db):
    """A completely unknown edge_id raises 404."""
    project, version, n1, claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        cl_api.get_edge_history(project=project, edge_id=uuid4(), db=db)
    assert exc.value.status_code == 404


def test_edge_history_404_for_edge_in_other_project(db):
    """An edge that belongs to a different project raises 404."""
    project, version, n1, claim = _seed_version_for_endpoint(db)

    # Build a second project with its own edge
    from app.models.identity import Organization, User as UserModel
    org2 = Organization(name="Org2")
    db.add(org2)
    db.flush()
    user2 = UserModel(org_id=org2.id, email=f"o2-{uuid4()}@x.io", name="U2")
    db.add(user2)
    db.flush()
    project2 = Project(org_id=org2.id, name="P2", created_by=user2.id)
    db.add(project2)
    db.flush()
    model2 = ProcessModel(project_id=project2.id, name="M2", level="L2")
    db.add(model2)
    db.flush()
    version2 = ProcessVersion(model_id=model2.id, version_number=1)
    db.add(version2)
    db.flush()
    lane2 = ProcessLane(version_id=version2.id, name="L", order_index=0)
    db.add(lane2)
    db.flush()
    na = ProcessNode(version_id=version2.id, lane_id=lane2.id, type="task",
                     name="A", position={}, properties={})
    nb = ProcessNode(version_id=version2.id, lane_id=lane2.id, type="task",
                     name="B", position={}, properties={})
    db.add(na)
    db.add(nb)
    db.flush()
    foreign_edge = ProcessEdge(
        version_id=version2.id,
        source_node_id=na.id,
        target_node_id=nb.id,
        label=None,
    )
    db.add(foreign_edge)
    db.commit()

    with pytest.raises(HTTPException) as exc:
        cl_api.get_edge_history(project=project, edge_id=foreign_edge.id, db=db)
    assert exc.value.status_code == 404
