"""Deleting a step, connection, or lane requires a reason.

Delete is the most provenance-critical edit in the map: every other edit
rewrites a field on something that survives, while a delete removes the target
itself, so the map loses the very thing a future reader would have questioned.
That earns it the same hard 422 as a rename or a lane move. These tests pin the
rule itself; `test_change_event_capture.py` pins the events the deletes write.
"""
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.api.v2.deps import DEV_USER_EMAIL
from app.db.session import get_db
from app.enums import ReviewTargetType
from app.factory import create_app
from app.models.change_event import ChangeEvent
from app.models.identity import User
from app.models.process import ProcessEdge, ProcessNode
from app.models.workflow import Review
from app.schemas.process_map import DeleteRequest
from tests.test_ai_edit import _seed_version_for_endpoint
from tests.test_change_event_capture import _seed_edge


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _events_for(db, target_id):
    return list(db.scalars(select(ChangeEvent).where(ChangeEvent.target_id == target_id)).all())


# Every endpoint's rejection test runs the same four shapes of "no reason
# given". Sharing the model instances across sections is safe: the handlers
# only read the payload, and `_require_delete_reason` never mutates it.
_NO_REASON = pytest.mark.parametrize(
    "payload",
    [None, DeleteRequest(), DeleteRequest(reason=""), DeleteRequest(reason="   ")],
    ids=["no_body", "empty_payload", "blank_reason", "whitespace_reason"],
)


def _seed_edge_for_client(db):
    """Seed an edge whose project the dev user can actually reach.

    `get_project_or_404` resolves the caller through the `dev@local` user and
    404s on an org mismatch, so the wire tests need that user in the seeded org.
    The direct-call tests below never go through that dependency.
    """
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    db.add(User(org_id=project.org_id, email=DEV_USER_EMAIL, name="Dev"))
    db.commit()
    return project, _seed_edge(db, project, version, n1)


# --- edge ------------------------------------------------------------------

@_NO_REASON
def test_delete_edge_without_reason_is_rejected(db, payload):
    project, version, n1, _claim = _seed_version_for_endpoint(db)
    edge = _seed_edge(db, project, version, n1)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_edge(project=project, edge_id=edge.id, db=db, payload=payload)
    assert exc.value.status_code == 422
    # Pinned in full: a copy-paste into delete_node that kept "connection"
    # would still satisfy a substring match, and would tell someone deleting a
    # step that a connection needs a reason.
    assert exc.value.detail == "A reason is required to delete a connection."
    # The edge survives and nothing was logged — a gate that ran after
    # record_change would leave a phantom delete in the change log.
    assert db.get(ProcessEdge, edge.id) is not None
    assert [e for e in _events_for(db, edge.id) if e.kind == "delete"] == []


def test_delete_edge_unknown_id_is_404_not_422(db):
    # Existence is resolved before the reason gate, so a bad id reads as "no
    # such edge" rather than sending the caller off to write a reason for
    # something that was never there.
    project, _version, _n1, _claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_edge(project=project, edge_id=uuid4(), db=db, payload=None)
    assert exc.value.status_code == 404


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


# --- edge, over the wire ---------------------------------------------------
# The tests above call the handler directly and so never exercise FastAPI's
# body parsing. An optional, non-embedded JSON body on a DELETE is the one
# genuinely new thing in this change, so it gets pinned end to end.

def test_delete_edge_over_http_without_a_body_is_422(client, db):
    project, edge = _seed_edge_for_client(db)
    edge_id = edge.id
    resp = client.delete(f"/api/v2/projects/{project.id}/edges/{edge_id}")
    assert resp.status_code == 422, resp.text
    # Our message, not a pydantic validation envelope.
    assert resp.json()["detail"] == "A reason is required to delete a connection."
    assert db.get(ProcessEdge, edge_id) is not None


def test_delete_edge_over_http_accepts_a_top_level_reason(client, db):
    project, edge = _seed_edge_for_client(db)
    edge_id = edge.id
    # `.delete()` takes no `json=` — httpx omits the shorthand for DELETE
    # bodies — so the request goes through the generic form.
    resp = client.request(
        "DELETE",
        f"/api/v2/projects/{project.id}/edges/{edge_id}",
        # Top level, NOT nested under "payload" — the body is a lone
        # non-embedded model, and the frontend posts it flat.
        json={"reason": "Superseded by the direct route"},
    )
    assert resp.status_code == 204, resp.text
    db.expire_all()
    assert db.get(ProcessEdge, edge_id) is None
    ev = [e for e in _events_for(db, edge_id) if e.kind == "delete"][0]
    assert ev.reason == "Superseded by the direct route"


# --- node ------------------------------------------------------------------

@_NO_REASON
def test_delete_node_without_reason_is_rejected(db, payload):
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_node(project=project, node_id=n1.id, db=db, payload=payload)
    assert exc.value.status_code == 422
    # Pin the whole string, not a substring: a copied "connection" message here
    # would keep the suite green while telling the user the wrong noun.
    assert exc.value.detail == "A reason is required to delete a step."
    assert db.get(ProcessNode, n1.id) is not None
    assert [e for e in _events_for(db, n1.id) if e.kind == "delete"] == []


def test_delete_node_unknown_id_is_404_not_422(db):
    # Existence is resolved before the reason gate, so a bad id reads as "no
    # such node" rather than sending the caller off to write a reason for
    # something that was never there.
    project, _version, _n1, _claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.delete_node(project=project, node_id=uuid4(), db=db, payload=None)
    assert exc.value.status_code == 404


def test_rejected_node_delete_leaves_review_rows_intact(db):
    """The gate runs before the Review cleanup, so a rejected delete must not
    have stripped the node's review rows on its way to the 422."""
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    db.add(Review(
        project_id=project.id,
        target_type=ReviewTargetType.PROCESS_NODE.value,
        target_id=n1.id,
        status="approved",
    ))
    db.commit()
    with pytest.raises(HTTPException):
        pm_api.delete_node(project=project, node_id=n1.id, db=db, payload=None)
    db.expire_all()
    rows = list(db.scalars(
        select(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id == n1.id,
        )
    ).all())
    assert len(rows) == 1


def test_delete_node_with_reason_records_it(db):
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    node_id = n1.id
    pm_api.delete_node(
        project=project,
        node_id=node_id,
        db=db,
        payload=DeleteRequest(reason="  Duplicate of the intake step  "),
    )
    events = [e for e in _events_for(db, node_id) if e.kind == "delete"]
    assert len(events) == 1
    ev = events[0]
    assert ev.reason == "Duplicate of the intake step"  # stored trimmed
    assert ev.source == "manual"
    assert ev.actor_kind == "user"
    assert db.get(ProcessNode, node_id) is None


def test_delete_node_ai_applied_records_chat_source_and_ai_actor(db):
    project, _version, n1, _claim = _seed_version_for_endpoint(db)
    node_id = n1.id
    pm_api.delete_node(
        project=project,
        node_id=node_id,
        db=db,
        payload=DeleteRequest(reason="Not supported by any source", ai_applied=True),
    )
    ev = [e for e in _events_for(db, node_id) if e.kind == "delete"][0]
    assert ev.reason == "Not supported by any source"
    assert ev.source == "chat"
    assert ev.actor_kind == "ai"
