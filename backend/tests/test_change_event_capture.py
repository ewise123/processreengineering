from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.models.process import ProcessLane
from app.schemas.process_map import EdgeCreate, EdgeUpdate, LaneCreate, LaneUpdate, NodeCreate, NodeUpdate
from tests.test_ai_edit import _seed_version_for_endpoint


def _events_for(db, target_id):
    return list(db.scalars(select(ChangeEvent).where(ChangeEvent.target_id == target_id)).all())


def test_update_node_semantic_requires_reason(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.update_node(project=project, node_id=n1.id,
                           payload=NodeUpdate(name="Receive PO"), db=db)
    assert exc.value.status_code == 422


def test_update_node_semantic_with_reason_logs_one_event(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(name="Receive PO", reason="Per interview"), db=db)
    events = _events_for(db, n1.id)
    assert len(events) == before + 1
    ev = max(events, key=lambda e: e.created_at)
    assert ev.kind == "relabel"
    assert ev.after == {"name": "Receive PO"}
    assert ev.reason == "Per interview"


def test_update_node_multifield_logs_single_event_highest_priority(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # change name (relabel) AND description (describe) -> one event, kind=relabel
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(name="X", description="Y", reason="r"), db=db)
    events = _events_for(db, n1.id)
    assert len(events) == before + 1
    ev = max(events, key=lambda e: e.created_at)
    assert ev.kind == "relabel"  # relabel > describe
    assert ev.before["name"] == "Receive" and ev.after["name"] == "X"
    assert "description" in ev.after


def test_update_node_cosmetic_only_logs_nothing_and_needs_no_reason(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(x=99.0, relative_y=10.0), db=db)
    assert len(_events_for(db, n1.id)) == before  # no new event


def test_update_node_noop_logs_nothing(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    before = len(_events_for(db, n1.id))
    pm_api.update_node(project=project, node_id=n1.id,
                       payload=NodeUpdate(name="Receive", reason="r"), db=db)  # same name
    assert len(_events_for(db, n1.id)) == before  # value unchanged -> no event


def _seed_edge(db, project, version, n1):
    # second node + edge n1->n2
    from app.models.process import ProcessNode, ProcessEdge
    n2 = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task",
                     name="Approve", position={}, properties={})
    db.add(n2); db.flush()
    edge = ProcessEdge(version_id=version.id, source_node_id=n1.id, target_node_id=n2.id, label=None)
    db.add(edge); db.commit()
    return edge


def test_update_edge_label_requires_reason_and_logs(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    with pytest.raises(HTTPException) as exc:
        pm_api.update_edge(project=project, edge_id=edge.id,
                           payload=EdgeUpdate(label="if approved"), db=db)
    assert exc.value.status_code == 422
    pm_api.update_edge(project=project, edge_id=edge.id,
                       payload=EdgeUpdate(label="if approved", reason="branch label"), db=db)
    evs = _events_for(db, edge.id)
    assert any(e.kind == "relabel" and e.after.get("label") == "if approved" for e in evs)


def test_update_edge_bend_only_logs_nothing(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    before = len(_events_for(db, edge.id))
    pm_api.update_edge(project=project, edge_id=edge.id,
                       payload=EdgeUpdate(bend_x=10.0, bend_y=20.0), db=db)
    assert len(_events_for(db, edge.id)) == before


# ---------------------------------------------------------------------------
# Lane tests
# ---------------------------------------------------------------------------

def test_update_lane_name_requires_reason(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    lane = db.get(ProcessLane, n1.lane_id)
    with pytest.raises(HTTPException) as exc:
        pm_api.update_lane(project=project, lane_id=lane.id,
                           payload=LaneUpdate(name="New Lane Name"), db=db)
    assert exc.value.status_code == 422


def test_update_lane_name_with_reason_logs_one_relabel_event(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    lane = db.get(ProcessLane, n1.lane_id)
    old_name = lane.name
    before = len(_events_for(db, lane.id))
    pm_api.update_lane(project=project, lane_id=lane.id,
                       payload=LaneUpdate(name="New Lane Name", reason="Renamed per workshop"), db=db)
    events = _events_for(db, lane.id)
    assert len(events) == before + 1
    ev = max(events, key=lambda e: e.created_at)
    assert ev.kind == "relabel"
    assert ev.target_id == lane.id
    assert ev.before == {"name": old_name}
    assert ev.after == {"name": "New Lane Name"}
    assert ev.reason == "Renamed per workshop"


def test_update_lane_cosmetic_only_logs_nothing(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    lane = db.get(ProcessLane, n1.lane_id)
    before = len(_events_for(db, lane.id))
    pm_api.update_lane(project=project, lane_id=lane.id,
                       payload=LaneUpdate(color="#aabbcc", collapsed=True, height_px=200), db=db)
    assert len(_events_for(db, lane.id)) == before


def test_update_lane_noop_name_logs_nothing(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    lane = db.get(ProcessLane, n1.lane_id)
    before = len(_events_for(db, lane.id))
    # Same name value — should be a no-op, no event written
    pm_api.update_lane(project=project, lane_id=lane.id,
                       payload=LaneUpdate(name=lane.name, reason="no-op check"), db=db)
    assert len(_events_for(db, lane.id)) == before


# ---------------------------------------------------------------------------
# Create tests
# ---------------------------------------------------------------------------

def test_create_node_logs_one_create_event(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    new_node = pm_api.create_node(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=NodeCreate(type="task", name="New Step", lane_id=n1.lane_id, x=100.0, relative_y=0.0),
        db=db,
    )
    events = _events_for(db, new_node.id)
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "create"
    assert ev.target_type == "node"
    assert ev.source == "manual"
    assert ev.after["name"] == "New Step"
    assert ev.after["type"] == "task"


def test_create_edge_logs_one_connect_event(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # Create a second node to connect to
    from app.models.process import ProcessNode
    n2 = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task",
                     name="Second Step", position={}, properties={})
    db.add(n2)
    db.flush()
    db.commit()

    new_edge = pm_api.create_edge(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=EdgeCreate(source_node_id=n1.id, target_node_id=n2.id),
        db=db,
    )
    events = _events_for(db, new_edge.id)
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "connect"
    assert ev.target_type == "edge"
    assert ev.source == "manual"
    assert ev.after["source_node_id"] == str(n1.id)
    assert ev.after["target_node_id"] == str(n2.id)


def test_add_lane_logs_one_create_event(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    new_lane = pm_api.add_lane(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=LaneCreate(name="New Lane", order_index=1),
        db=db,
    )
    events = _events_for(db, new_lane.id)
    assert len(events) == 1
    ev = events[0]
    assert ev.kind == "create"
    assert ev.target_type == "lane"
    assert ev.source == "manual"
    assert ev.after["name"] == "New Lane"


# ---------------------------------------------------------------------------
# Delete tests
# ---------------------------------------------------------------------------

def test_delete_node_logs_delete_event_and_node_is_gone(db):
    from app.models.process import ProcessNode
    project, version, n1, claim = _seed_version_for_endpoint(db)
    node_id = n1.id
    # capture identifying fields before deletion
    node_name = n1.name
    node_type = n1.type

    pm_api.delete_node(project=project, node_id=node_id, db=db)

    # event survives
    events = _events_for(db, node_id)
    assert len(events) >= 1
    ev = max(events, key=lambda e: e.created_at)
    assert ev.kind == "delete"
    assert ev.target_type == "node"
    assert ev.target_id == node_id
    assert ev.source == "manual"
    assert ev.before["name"] == node_name
    assert ev.before["type"] == node_type

    # object is gone
    assert db.get(ProcessNode, node_id) is None


def test_delete_edge_logs_delete_event_and_edge_is_gone(db):
    from app.models.process import ProcessEdge
    project, version, n1, claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    edge_id = edge.id
    src_id = edge.source_node_id
    tgt_id = edge.target_node_id

    pm_api.delete_edge(project=project, edge_id=edge_id, db=db)

    # event survives
    events = _events_for(db, edge_id)
    assert len(events) >= 1
    ev = max(events, key=lambda e: e.created_at)
    assert ev.kind == "delete"
    assert ev.target_type == "edge"
    assert ev.target_id == edge_id
    assert ev.source == "manual"
    assert ev.before["source_node_id"] == str(src_id)
    assert ev.before["target_node_id"] == str(tgt_id)
    assert "label" in ev.before

    # object is gone
    assert db.get(ProcessEdge, edge_id) is None


def test_delete_lane_logs_delete_event_and_lane_is_gone(db):
    from app.models.process import ProcessLane
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # add a second lane so deletion is allowed
    new_lane = pm_api.add_lane(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=LaneCreate(name="Lane To Delete", order_index=1),
        db=db,
    )
    lane_id = new_lane.id
    lane_name = new_lane.name

    pm_api.delete_lane(project=project, lane_id=lane_id, db=db)

    # event survives
    events = _events_for(db, lane_id)
    # filter to delete events only (add_lane logs a create event above)
    delete_events = [e for e in events if e.kind == "delete"]
    assert len(delete_events) == 1
    ev = delete_events[0]
    assert ev.target_type == "lane"
    assert ev.target_id == lane_id
    assert ev.source == "manual"
    assert ev.before["name"] == lane_name

    # object is gone
    assert db.get(ProcessLane, lane_id) is None
