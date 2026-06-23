"""generate-process-map scopes claims to a process; list_process_maps surfaces
process info + unreconciled_claim_count; attach/detach toggles process_id."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.session import get_db
from app.factory import create_app
from app.models.change_event import ChangeEvent
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import ProcessEdge, ProcessNode
from app.models.process_inventory import Process, ProcessClaimLink
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
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    in_proc = Claim(project_id=proj.id, kind="task", subject="In process", normalized={}, confidence=0.9, source="extracted")
    out_proc = Claim(project_id=proj.id, kind="task", subject="Not in process", normalized={}, confidence=0.9, source="extracted")
    db.add_all([in_proc, out_proc]); db.flush()
    proc = Process(project_id=proj.id, name="O2C", status="active"); db.add(proc); db.flush()
    db.add(ProcessClaimLink(process_id=proc.id, claim_id=in_proc.id, assigned_by="user"))
    db.commit()
    return proj, proc, in_proc, out_proc


def test_generate_scopes_claims_to_process_and_stamps_model(client, db):
    proj, proc, in_proc, out_proc = _seed(db)
    structure = GeneratedStructure(
        process_name="O2C",
        steps=[{"id": "s1", "name": "Do thing", "role": "Ops", "type": "userTask", "claim_refs": [0]}],
        gateways=[],
    )
    captured = {}

    def _fake_generate(claim_payload, **kwargs):
        captured["claims"] = claim_payload
        return structure

    with patch("app.api.v2.process_maps.generate_structure_from_claims", side_effect=_fake_generate):
        r = client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={"name": "O2C", "level": "2", "process_id": str(proc.id)},
        )
    assert r.status_code == 201, r.text
    # Only the linked claim was sent to Claude.
    assert [c["subject"] for c in captured["claims"]] == ["In process"]

    # The model is stamped with process_id.
    from app.models.process import ProcessModel
    model = db.get(ProcessModel, r.json()["model_id"])
    assert model.process_id == proc.id


def test_list_process_maps_reports_process_and_unreconciled_count(client, db):
    proj, proc, in_proc, out_proc = _seed(db)
    # Link a second claim to the process so it's "in process but uncited".
    db.add(ProcessClaimLink(process_id=proc.id, claim_id=out_proc.id, assigned_by="user"))
    db.commit()
    structure = GeneratedStructure(
        process_name="O2C",
        steps=[{"id": "s1", "name": "Do thing", "role": "Ops", "type": "userTask", "claim_refs": [0]}],
        gateways=[],
    )
    with patch("app.api.v2.process_maps.generate_structure_from_claims", return_value=structure):
        client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={"name": "O2C", "level": "2", "process_id": str(proc.id)},
        )
    rows = client.get(f"/api/v2/projects/{proj.id}/process-maps").json()
    assert len(rows) == 1
    assert rows[0]["process_id"] == str(proc.id)
    assert rows[0]["process_name"] == "O2C"
    # in_proc is cited by the generated node; out_proc is linked but uncited → 1.
    assert rows[0]["unreconciled_claim_count"] == 1


def test_generation_writes_origin_change_events(client, db):
    """Each node and edge created by generate_process_map must have exactly one
    change_event with kind=create, source=generation, actor_kind=ai."""
    proj, proc, in_proc, out_proc = _seed(db)
    structure = GeneratedStructure(
        process_name="O2C",
        steps=[
            {"id": "s1", "name": "Step One", "role": "Ops", "type": "userTask", "claim_refs": [0]},
            {"id": "s2", "name": "Step Two", "role": "Ops", "type": "userTask", "claim_refs": []},
        ],
        gateways=[],
    )
    with patch("app.api.v2.process_maps.generate_structure_from_claims", return_value=structure):
        r = client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={"name": "O2C", "level": "2", "process_id": str(proc.id)},
        )
    assert r.status_code == 201, r.text
    body = r.json()
    version_id = body["version_id"]

    # Collect all nodes and edges for this version.
    nodes = list(db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == version_id)
    ).all())
    edges = list(db.scalars(
        select(ProcessEdge).where(ProcessEdge.version_id == version_id)
    ).all())

    assert len(nodes) > 0, "expected generated nodes"
    assert len(edges) > 0, "expected generated edges"

    # Every node must have a generation/ai create event.
    for node in nodes:
        events = list(db.scalars(
            select(ChangeEvent).where(ChangeEvent.target_id == node.id)
        ).all())
        gen_events = [
            e for e in events
            if e.kind == "create" and e.source == "generation" and e.actor_kind == "ai"
        ]
        assert len(gen_events) == 1, (
            f"node {node.id} ({node.name!r}) has {len(gen_events)} generation create events, expected 1"
        )

    # Every edge must have a generation/ai create event.
    for edge in edges:
        events = list(db.scalars(
            select(ChangeEvent).where(ChangeEvent.target_id == edge.id)
        ).all())
        gen_events = [
            e for e in events
            if e.kind == "create" and e.source == "generation" and e.actor_kind == "ai"
        ]
        assert len(gen_events) == 1, (
            f"edge {edge.id} has {len(gen_events)} generation create events, expected 1"
        )

    # Node with claim_ref [0] → cited_claim_ids must be populated.
    step_one_node = next(n for n in nodes if n.name == "Step One")
    ev = next(
        e for e in db.scalars(
            select(ChangeEvent).where(ChangeEvent.target_id == step_one_node.id)
        ).all()
        if e.kind == "create" and e.source == "generation"
    )
    assert ev.cited_claim_ids is not None and len(ev.cited_claim_ids) == 1

    # Node with no claim_refs → cited_claim_ids is None or empty.
    step_two_node = next(n for n in nodes if n.name == "Step Two")
    ev2 = next(
        e for e in db.scalars(
            select(ChangeEvent).where(ChangeEvent.target_id == step_two_node.id)
        ).all()
        if e.kind == "create" and e.source == "generation"
    )
    assert not ev2.cited_claim_ids  # None or []

    # node count in result == number of node-create generation events
    node_create_events = list(db.scalars(
        select(ChangeEvent)
        .join(ProcessNode, ChangeEvent.target_id == ProcessNode.id)
        .where(
            ProcessNode.version_id == version_id,
            ChangeEvent.kind == "create",
            ChangeEvent.source == "generation",
            ChangeEvent.actor_kind == "ai",
        )
    ).all())
    assert len(node_create_events) == body["node_count"]


def test_attach_and_detach_process(client, db):
    proj, proc, in_proc, out_proc = _seed(db)
    structure = GeneratedStructure(
        process_name="Blank", steps=[{"id": "s1", "name": "x", "role": "Ops", "type": "userTask", "claim_refs": []}], gateways=[]
    )
    with patch("app.api.v2.process_maps.generate_structure_from_claims", return_value=structure):
        model_id = client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={"name": "Blank", "level": "2"},
        ).json()["model_id"]

    r = client.patch(f"/api/v2/projects/{proj.id}/process-maps/{model_id}", json={"process_id": str(proc.id)})
    assert r.status_code == 200, r.text
    assert r.json()["process_id"] == str(proc.id)

    r = client.patch(f"/api/v2/projects/{proj.id}/process-maps/{model_id}", json={"process_id": None})
    assert r.status_code == 200
    assert r.json()["process_id"] is None
