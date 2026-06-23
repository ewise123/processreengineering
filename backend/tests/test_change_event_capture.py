from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.models.process import ProcessLane
from app.schemas.process_map import EdgeCreate, EdgeUpdate, LaneUpdate, NodeUpdate
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
