from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.schemas.process_map import NodeUpdate
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
