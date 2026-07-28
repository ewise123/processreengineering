"""Deleting a step, connection, or lane requires a reason.

Delete is the most provenance-critical edit in the map — it is the only one that
removes evidence — so it carries the same hard 422 as a rename or a lane move.
These tests pin the rule itself; `test_change_event_capture.py` pins the events
the deletes write.
"""
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.models.process import ProcessEdge
from app.schemas.process_map import DeleteRequest
from tests.test_ai_edit import _seed_version_for_endpoint
from tests.test_change_event_capture import _seed_edge


def _events_for(db, target_id):
    return list(db.scalars(select(ChangeEvent).where(ChangeEvent.target_id == target_id)).all())


# --- edge ------------------------------------------------------------------

@pytest.mark.parametrize("payload", [None, DeleteRequest(), DeleteRequest(reason="   ")])
def test_delete_edge_without_reason_is_rejected(db, payload):
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_edge(project=project, edge_id=edge.id, db=db, payload=payload)
    assert exc.value.status_code == 422
    assert "reason is required" in exc.value.detail
    # The edge survives and nothing was logged — a gate that ran after
    # record_change would leave a phantom delete in the change log.
    assert db.get(ProcessEdge, edge.id) is not None
    assert [e for e in _events_for(db, edge.id) if e.kind == "delete"] == []


def test_delete_edge_with_reason_records_it(db):
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    pm_api.delete_edge(
        project=project,
        edge_id=edge.id,
        db=db,
        payload=DeleteRequest(reason="  Superseded by the direct route  "),
    )
    events = [e for e in _events_for(db, edge.id) if e.kind == "delete"]
    assert len(events) == 1
    ev = events[0]
    assert ev.reason == "Superseded by the direct route"  # stored trimmed
    assert ev.source == "manual"
    assert ev.actor_kind == "user"
    assert db.get(ProcessEdge, edge.id) is None


def test_delete_edge_ai_applied_records_chat_source_and_ai_actor(db):
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    pm_api.delete_edge(
        project=project,
        edge_id=edge.id,
        db=db,
        payload=DeleteRequest(reason="Removed per the SOP", ai_applied=True),
    )
    ev = [e for e in _events_for(db, edge.id) if e.kind == "delete"][0]
    assert ev.reason == "Removed per the SOP"
    assert ev.source == "chat"
    assert ev.actor_kind == "ai"
