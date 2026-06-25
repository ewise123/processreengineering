"""generate-best-practices seeds a starter map from generic best-practice
knowledge (no client documents). Each node/edge gets an origin change_event
with source=generation, actor_kind=ai, EMPTY cited_claim_ids, and the
best-practice reason. No claims are loaded and no NodeClaimLinks are created.

Also covers Task 22: additive re-ingest guarantee — feeding a correction
transcript through the reconcile path (apply_suggestion/add_step) preserves
existing nodes and their origin change_events untouched."""
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.v2 import processes as proc_api
from app.db.session import get_db
from app.enums import (
    ChangeActorKind,
    ChangeKind,
    ChangeSource,
    ChangeTargetType,
)
from app.factory import create_app
from app.models.change_event import ChangeEvent
from app.models.identity import Organization, User
from app.models.process import (
    EdgeClaimLink,
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.claim import Claim
from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion
from app.models.project import Project
from app.services.change_log import record_change
from app.services.process_generation import GeneratedStructure


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.commit()
    return proj


BEST_PRACTICE_REASON = "Best-practice assumption (no source document)"


def test_best_practices_seed_creates_map_with_origin_provenance(client, db):
    proj = _seed(db)
    structure = GeneratedStructure(
        process_name="Procure to Pay",
        steps=[
            {"id": "s1", "name": "Raise requisition", "role": "Requester", "type": "userTask", "claim_refs": []},
            {"id": "s2", "name": "Approve purchase order", "role": "Manager", "type": "userTask", "claim_refs": []},
        ],
        gateways=[
            {"id": "gw1", "type": "exclusive", "name": "Budget available?", "after_step": "s1",
             "yes_to": "s2", "no_to": "End_1", "claim_refs": []},
        ],
    )
    captured = {}

    def _fake_bp(**kwargs):
        captured.update(kwargs)
        return structure

    with patch(
        "app.api.v2.process_maps.generate_structure_from_best_practices",
        side_effect=_fake_bp,
    ):
        r = client.post(
            f"/api/v2/projects/{proj.id}/generate-best-practices",
            json={"name": "Procure to Pay", "level": "2", "focus": "AP"},
        )
    assert r.status_code == 201, r.text
    body = r.json()

    # No scope_input_ids / process_id were passed to the generator — it's
    # driven purely by name/level/focus.
    assert captured.get("process_name") == "Procure to Pay"

    # Model + version were created.
    model = db.get(ProcessModel, body["model_id"])
    assert model is not None and model.project_id == proj.id
    assert model.process_id is None  # best-practice maps are unlinked
    version = db.get(ProcessVersion, body["version_id"])
    assert version is not None and version.version_number == 1

    nodes = list(db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == version.id)
    ).all())
    edges = list(db.scalars(
        select(ProcessEdge).where(ProcessEdge.version_id == version.id)
    ).all())
    assert len(nodes) > 0, "expected generated nodes"
    assert len(edges) > 0, "expected generated edges"
    assert body["node_count"] == len(nodes)
    assert body["edge_count"] == len(edges)

    # No claim links of any kind — there are no claims.
    assert body["node_link_count"] == 0
    assert db.scalar(select(NodeClaimLink).limit(1)) is None
    assert db.scalar(select(EdgeClaimLink).limit(1)) is None

    # Every node has exactly one generation/ai create event with the
    # best-practice reason and EMPTY cited_claim_ids.
    for node in nodes:
        events = list(db.scalars(
            select(ChangeEvent).where(ChangeEvent.target_id == node.id)
        ).all())
        gen = [
            e for e in events
            if e.kind == "create" and e.source == "generation" and e.actor_kind == "ai"
        ]
        assert len(gen) == 1, f"node {node.id} has {len(gen)} gen events"
        assert gen[0].reason == BEST_PRACTICE_REASON
        assert not gen[0].cited_claim_ids  # None or []

    # Every edge has exactly one generation/ai create event, best-practice reason.
    for edge in edges:
        events = list(db.scalars(
            select(ChangeEvent).where(ChangeEvent.target_id == edge.id)
        ).all())
        gen = [
            e for e in events
            if e.kind == "create" and e.source == "generation" and e.actor_kind == "ai"
        ]
        assert len(gen) == 1, f"edge {edge.id} has {len(gen)} gen events"
        assert gen[0].reason == BEST_PRACTICE_REASON
        assert not gen[0].cited_claim_ids


def test_best_practices_seed_works_with_no_existing_claims(client, db):
    """No claims, no documents — the endpoint must still succeed (the
    claim-based generator would 422 here)."""
    proj = _seed(db)
    structure = GeneratedStructure(
        process_name="Onboarding",
        steps=[{"id": "s1", "name": "Send offer", "role": "HR", "type": "sendTask", "claim_refs": []}],
        gateways=[],
    )
    with patch(
        "app.api.v2.process_maps.generate_structure_from_best_practices",
        return_value=structure,
    ):
        r = client.post(
            f"/api/v2/projects/{proj.id}/generate-best-practices",
            json={"name": "Onboarding", "level": "1"},
        )
    assert r.status_code == 201, r.text
    assert r.json()["process_name"] == "Onboarding"


# ---------------------------------------------------------------------------
# Task 22: Additive re-ingest — the provenance trail accrues, never resets
# ---------------------------------------------------------------------------

def _seed_map_with_origin_events(db):
    """Seed a map whose two nodes each have a generation origin change_event.
    Also creates a Process + Claim so reconcile add_step has a valid anchor."""
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    process = Process(project_id=project.id, name="P1"); db.add(process); db.flush()
    model = ProcessModel(
        project_id=project.id, name="M", level="L2", process_id=process.id
    ); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()

    # Two original nodes (simulating a prior generation or manual creation).
    n1 = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="event_start", name="Start",
        position={"x": 0, "relative_y": 0}, properties={},
    )
    n2 = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Receive requisition",
        position={"x": 250, "relative_y": 0}, properties={},
    )
    db.add(n1); db.add(n2); db.flush()

    # Stamp origin change_events for both nodes (source=generation, actor=ai).
    for node in (n1, n2):
        record_change(
            db,
            target_type=ChangeTargetType.NODE.value,
            target_id=node.id,
            model_id=model.id,
            version_id=version.id,
            kind=ChangeKind.CREATE.value,
            reason="Best-practice assumption (no source document)",
            actor_kind=ChangeActorKind.AI.value,
            source=ChangeSource.GENERATION.value,
            after={"name": node.name, "type": node.type},
        )

    # A claim linked to the process (so reconcile add_step can cite it).
    claim = Claim(project_id=project.id, kind="task", subject="Verify budget", normalized={})
    db.add(claim); db.flush()
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim.id))
    db.commit()
    return project, process, version, lane, n1, n2, claim


def test_additive_reingest_preserves_origin_events(db):
    """Feeding a correction transcript through reconcile (add_step) must be
    ADDITIVE: the two original nodes keep their generation change_events intact,
    and the newly accepted node accrues its own source=reconcile create event.
    No generation events are destroyed or duplicated.

    This is Conclusion A: there is NO destructive re-ingest path — generate_process_map
    always creates a new version (never deletes an existing one), and the
    'Refresh from claims' path (reconcile_map + apply_suggestion) is purely additive.
    """
    project, process, version, lane, n1, n2, claim = _seed_map_with_origin_events(db)

    # Snapshot the original nodes' change_event ids before re-ingest.
    orig_n1_events = list(db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == n1.id)
    ).all())
    orig_n2_events = list(db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == n2.id)
    ).all())
    assert len(orig_n1_events) == 1, "seeding failed: n1 should have exactly 1 origin event"
    assert len(orig_n2_events) == 1, "seeding failed: n2 should have exactly 1 origin event"
    orig_n1_event_ids = {e.id for e in orig_n1_events}
    orig_n2_event_ids = {e.id for e in orig_n2_events}

    # Build an add_step reconcile suggestion directly (no LLM call required).
    sug = ProcessSuggestion(
        batch_id=uuid4(),
        project_id=project.id,
        kind="map_reconcile",
        process_id=process.id,
        version_id=version.id,
        op="add_step",
        payload={
            "name": "Verify budget",
            "type": "task",
            "after_node_id": str(n2.id),  # insert after n2
            "lane_ref": None,
            "lane_name": None,
            "edge_label": None,
            "cited_claim_ids": [str(claim.id)],
        },
        rationale="Correction transcript identified a missing budget verification step",
        status="pending",
    )
    db.add(sug); db.commit(); db.refresh(sug)

    # Apply the reconcile suggestion (the "re-ingest via reconcile" path).
    result = proc_api.apply_suggestion(db, project, sug)
    db.commit()
    assert result.outcome == "applied", f"expected applied, got {result.outcome}"

    # --- Assert 1: original nodes still exist ---
    assert db.get(ProcessNode, n1.id) is not None, "original node n1 was deleted"
    assert db.get(ProcessNode, n2.id) is not None, "original node n2 was deleted"

    # --- Assert 2: original change_events untouched (same ids, same count) ---
    post_n1_events = list(db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == n1.id)
    ).all())
    post_n2_events = list(db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == n2.id)
    ).all())
    assert len(post_n1_events) == 1, (
        f"n1 change_events changed: was 1, now {len(post_n1_events)}"
    )
    assert len(post_n2_events) == 1, (
        f"n2 change_events changed: was 1, now {len(post_n2_events)}"
    )
    assert {e.id for e in post_n1_events} == orig_n1_event_ids, "n1 event ids changed"
    assert {e.id for e in post_n2_events} == orig_n2_event_ids, "n2 event ids changed"

    # Verify original events still carry source=generation.
    assert post_n1_events[0].source == "generation"
    assert post_n2_events[0].source == "generation"

    # --- Assert 3: new node exists with source=reconcile create event ---
    new_node = db.scalars(
        select(ProcessNode).where(
            ProcessNode.version_id == version.id,
            ProcessNode.name == "Verify budget",
        )
    ).first()
    assert new_node is not None, "reconcile add_step did not create the new node"

    new_node_events = list(db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == new_node.id)
    ).all())
    assert len(new_node_events) == 1, (
        f"expected 1 change_event for new node, got {len(new_node_events)}"
    )
    ev = new_node_events[0]
    assert ev.kind == "create", f"expected kind=create, got {ev.kind}"
    assert ev.source == "reconcile", f"expected source=reconcile, got {ev.source}"
    assert ev.actor_kind == "ai", f"expected actor_kind=ai, got {ev.actor_kind}"
    assert ev.suggestion_id == sug.id, "change_event suggestion_id should match the suggestion"

    # --- Assert 4: total nodes in the version = original 2 + 1 new (additive) ---
    all_nodes = list(db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == version.id)
    ).all())
    assert len(all_nodes) == 3, (
        f"expected 3 nodes (2 original + 1 new), got {len(all_nodes)}"
    )
