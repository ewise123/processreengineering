"""Changes saved as "Awaiting reason", and explaining them afterwards.

An explanation is its own `explain` event pointing at the change; the
original row is never rewritten (the trail stays append-only).
"""
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import change_log as cl_api
from app.api.v2 import process_maps as pm_api
from app.models.change_event import ChangeEvent
from app.schemas.change_event import ExplainRequest
from app.schemas.process_map import NodeUpdate
from app.services.change_log import PENDING_REASON
from tests.test_ai_edit import _seed_version_for_endpoint


def _rename(db, project, node, name, reason):
    pm_api.update_node(project=project, node_id=node.id,
                       payload=NodeUpdate(name=name, reason=reason), db=db)
    return db.scalars(
        select(ChangeEvent)
        .where(ChangeEvent.target_id == node.id)
        .order_by(ChangeEvent.created_at.desc())
        .limit(1)
    ).one()


def _setup(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    return project, version.model_id, n1


def test_pending_lists_only_unexplained_placeholders(db):
    project, model_id, n1 = _setup(db)
    a = _rename(db, project, n1, "One", PENDING_REASON)
    _rename(db, project, n1, "Two", "A real reason")
    c = _rename(db, project, n1, "Three", PENDING_REASON)
    pending = cl_api.get_pending_changes(project=project, model_id=model_id, db=db)
    assert [p.id for p in pending] == [a.id, c.id]  # oldest first


def test_explain_appends_events_and_empties_pending(db):
    project, model_id, n1 = _setup(db)
    a = _rename(db, project, n1, "One", PENDING_REASON)
    b = _rename(db, project, n1, "Two", PENDING_REASON)
    made = cl_api.explain_changes(
        project=project, model_id=model_id,
        payload=ExplainRequest(event_ids=[a.id, b.id], reason="  Per Jane's interview "), db=db,
    )
    assert {m.explains_id for m in made} == {a.id, b.id}
    assert all(m.kind == "explain" and m.reason == "Per Jane's interview" for m in made)
    assert all(m.target_id == n1.id for m in made)
    # Each explanation carries a copy of the change it explains.
    by_orig = {m.explains_id: m for m in made}
    assert by_orig[a.id].before == {"kind": "relabel", "before": a.before, "after": a.after}
    assert cl_api.get_pending_changes(project=project, model_id=model_id, db=db) == []
    # The originals are untouched.
    db.refresh(a)
    assert a.reason == PENDING_REASON


def test_log_page_shows_what_each_change_was_explained_as(db):
    project, model_id, n1 = _setup(db)
    a = _rename(db, project, n1, "One", PENDING_REASON)
    b = _rename(db, project, n1, "Two", PENDING_REASON)
    cl_api.explain_changes(project=project, model_id=model_id,
                           payload=ExplainRequest(event_ids=[a.id], reason="Tidying"), db=db)
    page = cl_api.get_model_log(project=project, model_id=model_id, db=db)
    by_id = {i.id: i for i in page.items}
    assert by_id[a.id].explained_reason == "Tidying"
    assert by_id[b.id].explained_reason is None


def test_explain_is_all_or_nothing(db):
    project, model_id, n1 = _setup(db)
    a = _rename(db, project, n1, "One", PENDING_REASON)
    real = _rename(db, project, n1, "Two", "Already explained")
    with pytest.raises(HTTPException) as exc:
        cl_api.explain_changes(project=project, model_id=model_id,
                               payload=ExplainRequest(event_ids=[a.id, real.id], reason="X"), db=db)
    assert exc.value.status_code == 422
    assert [p.id for p in cl_api.get_pending_changes(project=project, model_id=model_id, db=db)] == [a.id]


def test_explaining_twice_is_rejected(db):
    project, model_id, n1 = _setup(db)
    a = _rename(db, project, n1, "One", PENDING_REASON)
    cl_api.explain_changes(project=project, model_id=model_id,
                           payload=ExplainRequest(event_ids=[a.id], reason="First"), db=db)
    with pytest.raises(HTTPException) as exc:
        cl_api.explain_changes(project=project, model_id=model_id,
                               payload=ExplainRequest(event_ids=[a.id], reason="Second"), db=db)
    assert exc.value.status_code == 422


@pytest.mark.parametrize("bad", ["", "   ", PENDING_REASON])
def test_explain_needs_a_real_reason(db, bad):
    project, model_id, n1 = _setup(db)
    a = _rename(db, project, n1, "One", PENDING_REASON)
    with pytest.raises(HTTPException) as exc:
        cl_api.explain_changes(project=project, model_id=model_id,
                               payload=ExplainRequest(event_ids=[a.id], reason=bad), db=db)
    assert exc.value.status_code == 422


def test_pending_404_for_unknown_model(db):
    from uuid import uuid4
    project, model_id, n1 = _setup(db)
    with pytest.raises(HTTPException) as exc:
        cl_api.get_pending_changes(project=project, model_id=uuid4(), db=db)
    assert exc.value.status_code == 404
