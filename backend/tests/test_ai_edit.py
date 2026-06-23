"""Tests for the per-node AI-edit feature: schemas, service, endpoints."""
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v2 import process_maps as pm_api
from app.enums import ClaimLinkKind
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink, ProcessEdge, ProcessLane, ProcessModel, ProcessNode, ProcessVersion,
)
from app.models.project import Project
from app.schemas.process_map import NodeUpdate
from app.schemas.version_ai_edit import AiEditAction, AiEditRequest
from app.services import map_ai_edit


def test_ai_edit_request_accepts_known_actions():
    for action in ["relabel", "describe", "validate", "suggest_next"]:
        req = AiEditRequest(action=action)
        assert req.action == AiEditAction(action)


def test_ai_edit_request_rejects_unknown_action():
    with pytest.raises(ValueError):
        AiEditRequest(action="delete_everything")


def test_validate_proposal_alias_serialization():
    """AiEditResponse serializes validate_ as 'validate' on the wire and round-trips."""
    from app.schemas.version_ai_edit import (
        AiEditAction, AiEditResponse, ValidateGap, ValidateProposal,
    )
    resp = AiEditResponse(
        action=AiEditAction.VALIDATE,
        validate_=ValidateProposal(gaps=[ValidateGap(summary="Missing owner", severity="high")]),
    )
    wire = resp.model_dump(by_alias=True)
    assert "validate" in wire and "validate_" not in wire
    resp2 = AiEditResponse.model_validate(wire)
    assert resp2.validate_.gaps[0].severity == "high"


def test_suggested_step_rejects_unknown_node_type():
    from app.schemas.version_ai_edit import SuggestedStep
    with pytest.raises(ValueError):
        SuggestedStep(proposed_name="X", proposed_type="not_a_type", rationale="r")


def test_validate_gap_severity_rejects_invalid():
    from app.schemas.version_ai_edit import ValidateGap
    with pytest.raises(ValueError):
        ValidateGap(summary="x", severity="critical")


class _FakeBlock:
    def __init__(self, name, payload):
        self.type = "tool_use"
        self.name = name
        self.input = payload


class _FakeClient:
    def __init__(self, name, payload):
        self._block = _FakeBlock(name, payload)

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        return SimpleNamespace(content=[self._block])


def test_propose_relabel_parses_tool_output():
    fake = _FakeClient(
        "propose_relabel",
        {"proposed_name": "Receive purchase order", "unchanged": False,
         "rationale": "C1 says the clerk receives the order.", "cited_claim_refs": ["C1"]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_relabel(map_context_text="...", selected_label="N1")
    assert out["proposed_name"] == "Receive purchase order"
    assert out["cited_claim_refs"] == ["C1"]


def test_propose_suggest_next_parses_steps():
    fake = _FakeClient(
        "propose_next_steps",
        {"steps": [
            {"proposed_name": "Verify budget", "proposed_type": "task",
             "edge_label": None, "rationale": "C2 implies a budget check.",
             "cited_claim_refs": ["C2"]}]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_next_steps(map_context_text="...", selected_label="N1")
    assert out["steps"][0]["proposed_type"] == "task"


def test_propose_description_parses_tool_output():
    fake = _FakeClient(
        "propose_description",
        {"proposed_description": "Clerk logs the order in SAP.",
         "rationale": "C1 describes the logging step.", "cited_claim_refs": ["C1"]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_description(map_context_text="...", selected_label="N1")
    assert out["proposed_description"] == "Clerk logs the order in SAP."


def test_report_gaps_parses_tool_output():
    fake = _FakeClient(
        "report_gaps",
        {"gaps": [{"summary": "No rejection path defined", "severity": "high",
                   "cited_claim_refs": []}]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.report_gaps(map_context_text="...", selected_label="N1")
    assert out["gaps"][0]["severity"] == "high"


def test_service_raises_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    map_ai_edit._client = None
    with pytest.raises(RuntimeError):
        map_ai_edit._get_client()


# ---------------------------------------------------------------------------
# Task 4: propose endpoint + citation hygiene
# ---------------------------------------------------------------------------

def _seed_version_for_endpoint(db):
    org = Organization(name="O")
    db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U")
    db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id)
    db.add(project); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2")
    db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1)
    db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0)
    db.add(lane); db.flush()
    n1 = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name="Receive", position={}, properties={})
    db.add(n1); db.flush()
    claim = Claim(project_id=project.id, kind="task", subject="Clerk receives the order", normalized={})
    db.add(claim); db.flush()
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    return project, version, n1, claim


def test_propose_endpoint_resolves_and_filters_claim_refs(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    fake_payload = {
        "proposed_name": "Receive PO", "unchanged": False,
        "rationale": "C1 supports this.", "cited_claim_refs": ["C1", "C99"],
    }
    with patch.object(pm_api, "propose_relabel", return_value=fake_payload):
        resp = pm_api.ai_edit_node(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n1.id, payload=pm_api.AiEditRequest(action="relabel"), db=db,
        )
    assert resp.relabel.proposed_name == "Receive PO"
    assert resp.relabel.cited_claim_ids == [claim.id]  # C99 dropped


def test_propose_endpoint_404_for_foreign_node(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.ai_edit_node(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=uuid4(), payload=pm_api.AiEditRequest(action="relabel"), db=db,
        )
    assert exc.value.status_code == 404


def test_propose_relabel_empty_service_dict_falls_back_to_node_name(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    with patch.object(pm_api, "propose_relabel", return_value={}):
        resp = pm_api.ai_edit_node(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n1.id, payload=pm_api.AiEditRequest(action="relabel"), db=db,
        )
    assert resp.relabel.proposed_name == n1.name  # falls back, no 500
    assert resp.relabel.cited_claim_ids == []


def test_update_node_writes_description_preserving_other_properties(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # Seed an existing property so we can prove it's preserved.
    n1.properties = {"_lineage_id": str(n1.id)}
    db.commit()

    result = pm_api.update_node(
        project=project,
        node_id=n1.id,
        payload=NodeUpdate(description="Clerk logs the order into SAP.", reason="clarify step"),
        db=db,
    )
    assert result.properties["description"] == "Clerk logs the order into SAP."
    assert result.properties["_lineage_id"] == str(n1.id)


def test_apply_proposed_step_creates_ai_proposed_node_and_links(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    lane_id = n1.lane_id

    result = pm_api.apply_proposed_step(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=pm_api.AiProposedStepRequest(
            source_node_id=n1.id, name="Verify budget", type="task",
            lane_id=lane_id, x=400.0, relative_y=20.0,
            edge_label="if over $10k", cited_claim_ids=[claim.id, uuid4()],
        ),
        db=db,
    )

    new_node = db.get(ProcessNode, result.node.id)
    assert new_node.properties["ai_proposed"] is True
    assert new_node.properties["_lineage_id"] == str(new_node.id)
    edge = db.scalars(select(ProcessEdge).where(ProcessEdge.target_node_id == new_node.id)).one()
    assert edge.source_node_id == n1.id
    links = list(db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id == new_node.id)).all())
    assert len(links) == 1  # only the real claim; bogus uuid ignored
    assert links[0].claim_id == claim.id
    assert links[0].link_kind == "ai_proposed"


def test_apply_proposed_step_dedups_repeated_claim_ids(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    result = pm_api.apply_proposed_step(
        project=project, model_id=version.model_id, version_id=version.id,
        payload=pm_api.AiProposedStepRequest(
            source_node_id=n1.id, name="Y", type="task", lane_id=n1.lane_id,
            x=10.0, relative_y=0.0, edge_label=None,
            cited_claim_ids=[claim.id, claim.id],  # same id twice
        ),
        db=db,
    )
    from sqlalchemy import select as _sel
    links = list(db.scalars(_sel(NodeClaimLink).where(NodeClaimLink.node_id == result.node.id)).all())
    assert len(links) == 1  # no IntegrityError, single link


def test_deleting_proposed_node_cascades_edge(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    result = pm_api.apply_proposed_step(
        project=project, model_id=version.model_id, version_id=version.id,
        payload=pm_api.AiProposedStepRequest(
            source_node_id=n1.id, name="X", type="task", lane_id=n1.lane_id,
            x=400.0, relative_y=0.0, edge_label=None, cited_claim_ids=[],
        ),
        db=db,
    )
    new_id = result.node.id
    pm_api.delete_node(project=project, node_id=new_id, db=db)
    assert db.get(ProcessNode, new_id) is None
    assert db.scalars(select(ProcessEdge).where(ProcessEdge.target_node_id == new_id)).first() is None


def test_apply_proposed_step_logs_ai_create_change_event(db):
    """After apply_proposed_step, the new node has exactly one create change_event
    with actor_kind='ai', source='reconcile', and cited_claim_ids containing the
    real claim id that was passed in."""
    from app.models.change_event import ChangeEvent

    project, version, n1, claim = _seed_version_for_endpoint(db)
    bogus_id = uuid4()

    result = pm_api.apply_proposed_step(
        project=project,
        model_id=version.model_id,
        version_id=version.id,
        payload=pm_api.AiProposedStepRequest(
            source_node_id=n1.id, name="Verify budget", type="task",
            lane_id=n1.lane_id, x=400.0, relative_y=20.0,
            edge_label="if over $10k", cited_claim_ids=[claim.id, bogus_id],
        ),
        db=db,
    )

    new_node_id = result.node.id
    events = list(
        db.scalars(
            select(ChangeEvent).where(
                ChangeEvent.target_id == new_node_id,
                ChangeEvent.kind == "create",
            )
        ).all()
    )
    assert len(events) == 1, f"Expected 1 create event, got {len(events)}"
    ev = events[0]
    assert ev.actor_kind == "ai"
    assert ev.source == "reconcile"
    # cited_claim_ids on the event records what was passed (as strings); real claim must be present
    assert ev.cited_claim_ids is not None
    assert str(claim.id) in ev.cited_claim_ids

    # Also assert exactly one connect event for the created edge
    new_edge_id = result.edge.id
    edge_events = list(
        db.scalars(
            select(ChangeEvent).where(
                ChangeEvent.target_id == new_edge_id,
                ChangeEvent.kind == "connect",
            )
        ).all()
    )
    assert len(edge_events) == 1, f"Expected 1 connect event for edge, got {len(edge_events)}"
    edge_ev = edge_events[0]
    assert edge_ev.actor_kind == "ai"
    assert edge_ev.source == "reconcile"
