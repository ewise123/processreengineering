"""generate-best-practices seeds a starter map from generic best-practice
knowledge (no client documents). Each node/edge gets an origin change_event
with source=generation, actor_kind=ai, EMPTY cited_claim_ids, and the
best-practice reason. No claims are loaded and no NodeClaimLinks are created."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.session import get_db
from app.factory import create_app
from app.models.change_event import ChangeEvent
from app.models.identity import Organization, User
from app.models.process import (
    EdgeClaimLink,
    NodeClaimLink,
    ProcessEdge,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project
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
