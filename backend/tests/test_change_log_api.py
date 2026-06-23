"""Tests for GET /projects/{project_id}/nodes/{node_id}/history
and GET /projects/{project_id}/edges/{edge_id}/history (Task 15),
and GET /projects/{project_id}/models/{model_id}/log (Task 19).

Reuses _seed_version_for_endpoint from test_ai_edit to create a minimal
project/model/version/lane/node fixture, then drives the existing update_node
and create_edge endpoints to produce ChangeEvent rows, and exercises the
new history endpoints directly (no TestClient needed).
"""
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

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
# Task 19 helpers
# ---------------------------------------------------------------------------

def _seed_events_for_model(db, model, version, node_a, node_b):
    """Insert 5 ChangeEvent rows with explicit, spaced created_at values so
    ordering is deterministic (server_default=now() would be the same for
    rapid consecutive inserts).

    Events (newest → oldest when fetched desc):
      ev5  node_a  actor_kind=user     source=manual      t+40
      ev4  node_b  actor_kind=user     source=reconcile   t+30
      ev3  node_a  actor_kind=ai       source=generation  t+20
      ev2  node_b  actor_kind=user     source=manual      t+10
      ev1  node_a  actor_kind=user     source=manual      t+00
    """
    base = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    rows = [
        ChangeEvent(
            model_id=model.id,
            version_id=version.id,
            target_type="node",
            target_id=node_a.id,
            actor_kind="user",
            kind="relabel",
            reason="first",
            source="manual",
            created_at=base + timedelta(seconds=0),
        ),
        ChangeEvent(
            model_id=model.id,
            version_id=version.id,
            target_type="node",
            target_id=node_b.id,
            actor_kind="user",
            kind="relabel",
            reason="second",
            source="manual",
            created_at=base + timedelta(seconds=10),
        ),
        ChangeEvent(
            model_id=model.id,
            version_id=version.id,
            target_type="node",
            target_id=node_a.id,
            actor_kind="ai",
            kind="relabel",
            reason="third",
            source="generation",
            created_at=base + timedelta(seconds=20),
        ),
        ChangeEvent(
            model_id=model.id,
            version_id=version.id,
            target_type="node",
            target_id=node_b.id,
            actor_kind="user",
            kind="relabel",
            reason="fourth",
            source="reconcile",
            created_at=base + timedelta(seconds=30),
        ),
        ChangeEvent(
            model_id=model.id,
            version_id=version.id,
            target_type="node",
            target_id=node_a.id,
            actor_kind="user",
            kind="relabel",
            reason="fifth",
            source="manual",
            created_at=base + timedelta(seconds=40),
        ),
    ]
    for ev in rows:
        db.add(ev)
    db.commit()
    # Reload to get ids assigned
    for ev in rows:
        db.refresh(ev)
    return rows  # ev1..ev5 in ascending created_at order


def _seed_second_project(db):
    """Create an independent project + model; return (project2, model2)."""
    org2 = Organization(name=f"OtherOrg-{uuid4()}")
    db.add(org2)
    db.flush()
    user2 = User(org_id=org2.id, email=f"other-{uuid4()}@x.io", name="U2")
    db.add(user2)
    db.flush()
    project2 = Project(org_id=org2.id, name="P2", created_by=user2.id)
    db.add(project2)
    db.flush()
    model2 = ProcessModel(project_id=project2.id, name="M2", level="L2")
    db.add(model2)
    db.flush()
    db.commit()
    return project2, model2


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


# ---------------------------------------------------------------------------
# Task 19: Model-wide log endpoint — GET /models/{model_id}/log
# ---------------------------------------------------------------------------

def _setup_log_fixture(db):
    """Return (project, model, version, node_a, node_b, [ev1..ev5])."""
    project, version, node_a, claim = _seed_version_for_endpoint(db)
    # Retrieve the model (version.model_id)
    model = db.get(ProcessModel, version.model_id)

    # Create a second node in the same version so we have two targets
    node_b = ProcessNode(
        version_id=version.id,
        lane_id=node_a.lane_id,
        type="task",
        name="Approve",
        position={},
        properties={},
    )
    db.add(node_b)
    db.commit()
    db.refresh(node_b)

    events = _seed_events_for_model(db, model, version, node_a, node_b)
    return project, model, version, node_a, node_b, events


def test_log_default_feed_newest_first(db):
    """Model log returns all events newest-first (default, no filters)."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
    )

    assert isinstance(page, ChangeLogPage)
    assert len(page.items) == 5

    # Verify descending created_at order
    for i in range(len(page.items) - 1):
        assert page.items[i].created_at >= page.items[i + 1].created_at

    # First item should be the last-inserted (ev5, reason="fifth")
    assert page.items[0].reason == "fifth"
    # Last item should be the first-inserted (ev1, reason="first")
    assert page.items[-1].reason == "first"


def test_log_filter_by_target_id(db):
    """?target_id= returns only events for that target."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        target_id=node_a.id,
    )

    assert isinstance(page, ChangeLogPage)
    # ev1, ev3, ev5 belong to node_a → 3 events
    assert len(page.items) == 3
    for item in page.items:
        assert item.target_id == node_a.id


def test_log_filter_by_source(db):
    """?source=reconcile returns only reconcile events."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        source="reconcile",
    )

    assert isinstance(page, ChangeLogPage)
    # Only ev4 has source=reconcile
    assert len(page.items) == 1
    assert page.items[0].source == "reconcile"
    assert page.items[0].reason == "fourth"


def test_log_filter_by_actor_kind(db):
    """?actor_kind=ai returns only AI-authored events."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        actor_kind="ai",
    )

    assert isinstance(page, ChangeLogPage)
    # Only ev3 has actor_kind=ai
    assert len(page.items) == 1
    assert page.items[0].actor_kind == "ai"
    assert page.items[0].reason == "third"


def test_log_filter_by_since(db):
    """?since=<datetime> returns events at or after that time."""
    from datetime import datetime, timedelta, timezone

    project, model, version, node_a, node_b, events = _setup_log_fixture(db)
    # Base is 2025-01-01 12:00:00; ev3..ev5 are at t+20,30,40 seconds
    # Use t+15s as cutoff so ev3, ev4, ev5 are included
    base = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    since = base + timedelta(seconds=15)

    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        since=since,
    )

    assert isinstance(page, ChangeLogPage)
    assert len(page.items) == 3
    for item in page.items:
        assert item.created_at >= since



def test_log_naive_since_does_not_500(db):
    """A naive (no-timezone) since datetime must not cause a 500 error;
    it should be interpreted as UTC and filter sensibly."""
    from datetime import datetime, timedelta

    project, model, version, node_a, node_b, events = _setup_log_fixture(db)
    # Base is 2025-01-01 12:00:00; use a naive datetime 15s after base.
    # This simulates what happens when an ISO string without offset is parsed by FastAPI.
    naive_since = datetime(2025, 1, 1, 12, 0, 15)  # no tzinfo

    # Should return 200 (not 500), with ev3, ev4, ev5 (t+20, t+30, t+40)
    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        since=naive_since,
    )

    assert isinstance(page, ChangeLogPage)
    assert len(page.items) == 3
    # All returned items should be at or after the since cutoff (when treated as UTC)
    from datetime import timezone as _tz
    aware_since = naive_since.replace(tzinfo=_tz.utc)
    for item in page.items:
        assert item.created_at >= aware_since


def test_log_pagination_basic(db):
    """Requesting limit=2 returns 2 items + a next_cursor."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page1 = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=2,
    )

    assert isinstance(page1, ChangeLogPage)
    assert len(page1.items) == 2
    assert page1.next_cursor is not None

    # First page should contain the 2 newest (ev5=fifth, ev4=fourth)
    assert page1.items[0].reason == "fifth"
    assert page1.items[1].reason == "fourth"


def test_log_pagination_continues_without_overlap(db):
    """Page 2 cursor continues from page 1 with no overlap."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page1 = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=2,
    )
    assert page1.next_cursor is not None

    page2 = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=2,
        cursor=page1.next_cursor,
    )

    # No items from page1 should appear in page2
    page1_ids = {item.id for item in page1.items}
    page2_ids = {item.id for item in page2.items}
    assert page1_ids.isdisjoint(page2_ids)

    # Together they cover 4 of the 5 events
    assert len(page2.items) == 2
    # Page 2 should have ev3=third, ev2=second
    assert page2.items[0].reason == "third"
    assert page2.items[1].reason == "second"


def test_log_pagination_last_page_no_cursor(db):
    """The last page returns next_cursor = None."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page1 = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=3,
    )
    assert page1.next_cursor is not None

    page2 = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=3,
        cursor=page1.next_cursor,
    )

    # 5 events total; first page has 3, second page has 2 → last page
    assert len(page2.items) == 2
    assert page2.next_cursor is None


def test_log_pagination_full_page_exact(db):
    """When the result count equals the limit exactly, next_cursor is None."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=5,  # exactly 5 events exist
    )

    assert len(page.items) == 5
    assert page.next_cursor is None


def test_log_malformed_cursor_does_not_500(db):
    """A garbage cursor string must not raise a 500 (treat as no cursor or 422)."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    try:
        page = cl_api.get_model_log(
            project=project,
            model_id=model.id,
            db=db,
            cursor="not-a-valid-cursor!!!",
        )
        # If it ignores the bad cursor, it should still return a valid page
        assert isinstance(page, ChangeLogPage)
    except HTTPException as exc:
        # 422 is acceptable; 500 is not
        assert exc.status_code == 422


def test_log_limit_clamped_to_max(db):
    """limit > 200 is silently clamped to 200 (no error)."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    # Just verifies it doesn't error; with 5 events, all 5 are returned
    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=9999,
    )
    assert isinstance(page, ChangeLogPage)
    assert len(page.items) == 5


def test_log_limit_clamped_min_1(db):
    """limit < 1 is clamped to 1."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    page = cl_api.get_model_log(
        project=project,
        model_id=model.id,
        db=db,
        limit=0,
    )
    assert isinstance(page, ChangeLogPage)
    assert len(page.items) == 1
    # Should also have a next_cursor since 4 events remain
    assert page.next_cursor is not None


def test_log_404_for_model_in_other_project(db):
    """Model that exists but belongs to another project → 404."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)
    project2, model2 = _seed_second_project(db)

    # Ask project1 for model2 (which belongs to project2)
    with pytest.raises(HTTPException) as exc:
        cl_api.get_model_log(
            project=project,
            model_id=model2.id,
            db=db,
        )
    assert exc.value.status_code == 404


def test_log_404_for_unknown_model(db):
    """Completely unknown model_id → 404."""
    project, model, version, node_a, node_b, events = _setup_log_fixture(db)

    with pytest.raises(HTTPException) as exc:
        cl_api.get_model_log(
            project=project,
            model_id=uuid4(),
            db=db,
        )
    assert exc.value.status_code == 404
