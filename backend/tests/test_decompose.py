"""Tests for SP-5b decompose-to-next-level: helpers, service, endpoints."""
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
from app.services import map_ai_edit


def test_next_level_increments_and_caps():
    assert pm_api._next_level("L1") == "L2"
    assert pm_api._next_level("L2") == "L3"
    assert pm_api._next_level("L3") == "L4"
    assert pm_api._next_level("L4") is None          # capped
    assert pm_api._next_level("3") == "L4"            # accepts bare digit
    assert pm_api._next_level("garbage") is None      # unparseable


def _seed_neighbors(db):
    """A linear graph n1 -> n2 -> n3, with claims c1@n1, c2@n2, c3@n3 and a
    detached claim c4 attached to no node. Returns (project, version, n2, ids)."""
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()
    def node(name):
        n = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name=name,
                        position={}, properties={}); db.add(n); db.flush(); return n
    n1, n2, n3 = node("n1"), node("n2"), node("n3")
    db.add(ProcessEdge(version_id=version.id, source_node_id=n1.id, target_node_id=n2.id))
    db.add(ProcessEdge(version_id=version.id, source_node_id=n2.id, target_node_id=n3.id))
    claims = {}
    for key, owner in [("c1", n1), ("c2", n2), ("c3", n3), ("c4", None)]:
        c = Claim(project_id=project.id, kind="task", subject=key, normalized={})
        db.add(c); db.flush(); claims[key] = c
        if owner is not None:
            db.add(NodeClaimLink(node_id=owner.id, claim_id=c.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    return project, version, n2, claims


def test_neighbor_claim_ids_includes_self_and_one_hop(db):
    project, version, n2, claims = _seed_neighbors(db)
    scope = pm_api._neighbor_claim_ids(db, version.id, n2.id)
    # n2 plus its neighbors n1, n3 -> c1, c2, c3 in scope; c4 (detached) excluded.
    assert scope == {claims["c1"].id, claims["c2"].id, claims["c3"].id}


def test_resolve_refs_scoped_drops_out_of_scope(db):
    project, version, n2, claims = _seed_neighbors(db)
    scope = pm_api._neighbor_claim_ids(db, version.id, n2.id)
    ref_to_id = {"C1": claims["c2"].id, "C2": claims["c4"].id}  # C2 -> detached claim
    kept = pm_api._resolve_refs_scoped(["C1", "C2"], ref_to_id, scope)
    assert kept == [claims["c2"].id]  # C2 dropped: c4 not in node+neighbor scope


def test_decompose_schemas_roundtrip_and_validate():
    from app.schemas.version_ai_edit import (
        AiEditAction, AiEditResponse, DecomposeProposal, DecomposeRequest, SubStep,
    )
    assert AiEditAction("decompose") == AiEditAction.DECOMPOSE
    step = SubStep(proposed_name="Check budget", proposed_type="task", role="Finance",
                   edge_label="if > $10k", rationale="r", cited_claim_ids=[])
    proposal = DecomposeProposal(sub_steps=[step])
    resp = AiEditResponse(action=AiEditAction.DECOMPOSE, decompose=proposal)
    wire = resp.model_dump(by_alias=True)
    assert wire["action"] == "decompose"
    assert wire["decompose"]["sub_steps"][0]["role"] == "Finance"
    # apply request reuses SubStep
    req = DecomposeRequest(sub_steps=[step])
    assert req.sub_steps[0].proposed_type == "task"


def test_substep_rejects_unknown_type():
    from app.schemas.version_ai_edit import SubStep
    with pytest.raises(ValueError):
        SubStep(proposed_name="X", proposed_type="not_a_type", role="R", rationale="r")


class _FakeToolClient:
    """Returns a single tool_use block with the given name + input."""
    def __init__(self, tool_name, payload):
        self._tool_name = tool_name
        self._payload = payload

    class _Messages:
        def __init__(self, outer): self._outer = outer
        def create(self, **kwargs):
            block = SimpleNamespace(type="tool_use", name=self._outer._tool_name,
                                    input=self._outer._payload)
            return SimpleNamespace(content=[block])

    @property
    def messages(self): return _FakeToolClient._Messages(self)


def test_propose_decompose_parses_sub_steps():
    fake = _FakeToolClient(
        "propose_decompose",
        {"sub_steps": [
            {"proposed_name": "Open ticket", "proposed_type": "task", "role": "Support",
             "edge_label": None, "rationale": "C1 mentions ticketing.", "cited_claim_refs": ["C1"]},
            {"proposed_name": "Triage", "proposed_type": "task", "role": "Support",
             "edge_label": "after open", "rationale": "C2.", "cited_claim_refs": ["C2"]},
        ]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_decompose(map_context_text="...", selected_label="N1")
    assert len(out["sub_steps"]) == 2
    assert out["sub_steps"][0]["role"] == "Support"
    assert out["sub_steps"][1]["cited_claim_refs"] == ["C2"]


def test_propose_decompose_endpoint_filters_to_neighbor_scope(db):
    project, version, n2, claims = _seed_neighbors(db)
    # Model cites C2 (n2's own claim, in scope) and a project claim that is NOT
    # in the node+neighbor scope -> only the in-scope one survives.
    from app.services.map_context import assemble_map_context
    ctx = assemble_map_context(db, version, selected_node_id=n2.id)
    id_to_ref = {v: k for k, v in ctx.claim_ref_to_id.items()}
    in_ref = id_to_ref[claims["c2"].id]
    out_ref = id_to_ref[claims["c4"].id]
    fake = {"sub_steps": [
        {"proposed_name": "Sub A", "proposed_type": "task", "role": "Ops",
         "edge_label": None, "rationale": "r", "cited_claim_refs": [in_ref, out_ref]},
    ]}
    with patch.object(pm_api, "propose_decompose", return_value=fake):
        resp = pm_api.ai_edit_node(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n2.id, payload=pm_api.AiEditRequest(action="decompose"), db=db,
        )
    step = resp.decompose.sub_steps[0]
    assert step.cited_claim_ids == [claims["c2"].id]  # out-of-scope c4 dropped


def test_propose_decompose_endpoint_422_at_l4(db):
    project, version, n2, claims = _seed_neighbors(db)
    model = db.get(ProcessModel, version.model_id)
    model.level = "L4"; db.commit()
    with patch.object(pm_api, "propose_decompose", return_value={"sub_steps": []}):
        with pytest.raises(HTTPException) as exc:
            pm_api.ai_edit_node(
                project=project, model_id=version.model_id, version_id=version.id,
                node_id=n2.id, payload=pm_api.AiEditRequest(action="decompose"), db=db,
            )
    assert exc.value.status_code == 422
    assert "level" in exc.value.detail.lower() or "L4" in exc.value.detail


# ---------------------------------------------------------------------------
# Task 6: apply_decompose endpoint tests
# ---------------------------------------------------------------------------

def _decompose_payload(claim_id=None):
    from app.schemas.version_ai_edit import DecomposeRequest, SubStep
    cited = [claim_id] if claim_id else []
    return DecomposeRequest(sub_steps=[
        SubStep(proposed_name="Open ticket", proposed_type="task", role="Support",
                edge_label=None, rationale="r", cited_claim_ids=cited),
        SubStep(proposed_name="Triage", proposed_type="task", role="Triage Team",
                edge_label="after open", rationale="r", cited_claim_ids=[]),
    ])


def test_apply_decompose_creates_child_model_version_and_links(db):
    project, version, n2, claims = _seed_neighbors(db)
    result = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(claims["c2"].id), db=db,
    )
    child = db.get(ProcessModel, result.child_model_id)
    assert child.parent_model_id == version.model_id
    assert child.level == "L3"                       # parent L2 -> L3
    assert child.name == "n2"                          # parent step label
    cv = db.get(ProcessVersion, result.child_version_id)
    assert cv.model_id == child.id and cv.version_number == 1
    nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == cv.id)).all())
    assert len(nodes) == 2 and all(n.properties["ai_proposed"] is True for n in nodes)
    assert all(n.properties["_lineage_id"] == str(n.id) for n in nodes)
    lanes = list(db.scalars(select(ProcessLane).where(ProcessLane.version_id == cv.id)).all())
    assert len(lanes) == 2
    edges = list(db.scalars(select(ProcessEdge).where(ProcessEdge.version_id == cv.id)).all())
    assert len(edges) == 1
    links = list(db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id.in_([n.id for n in nodes]))).all())
    assert len(links) == 1 and links[0].link_kind == "ai_proposed"
    db.refresh(n2)
    assert n2.properties["child_model_id"] == str(child.id)


def test_re_decompose_appends_new_child_version(db):
    project, version, n2, claims = _seed_neighbors(db)
    first = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    second = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    assert first.child_model_id == second.child_model_id    # same child model
    v1 = db.get(ProcessVersion, first.child_version_id)
    v2 = db.get(ProcessVersion, second.child_version_id)
    assert v2.version_number == 2 and v2.parent_version_id == v1.id


def test_apply_decompose_ignores_foreign_claim_ids(db):
    project, version, n2, claims = _seed_neighbors(db)
    result = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(uuid4()), db=db,  # bogus claim id
    )
    cv = db.get(ProcessVersion, result.child_version_id)
    nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == cv.id)).all())
    links = list(db.scalars(select(NodeClaimLink).where(NodeClaimLink.node_id.in_([n.id for n in nodes]))).all())
    assert links == []   # foreign id silently dropped


def test_apply_decompose_422_at_l4(db):
    project, version, n2, claims = _seed_neighbors(db)
    model = db.get(ProcessModel, version.model_id); model.level = "L4"; db.commit()
    with pytest.raises(HTTPException) as exc:
        pm_api.apply_decompose(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n2.id, payload=_decompose_payload(), db=db,
        )
    assert exc.value.status_code == 422


def test_apply_decompose_recovers_from_corrupt_child_model_id(db):
    project, version, n2, claims = _seed_neighbors(db)
    # Simulate a corrupt stored link; apply should not 500 — it creates a fresh child.
    n2.properties = {**(n2.properties or {}), "child_model_id": "not-a-uuid"}
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(n2, "properties")
    db.commit()
    result = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    child = db.get(ProcessModel, result.child_model_id)
    assert child is not None and child.parent_model_id == version.model_id
    db.refresh(n2)
    assert n2.properties["child_model_id"] == str(child.id)  # link repaired


# ---------------------------------------------------------------------------
# Task 7: remove_sub_process endpoint tests
# ---------------------------------------------------------------------------

def test_remove_sub_process_soft_deletes_child_and_clears_link(db):
    project, version, n2, claims = _seed_neighbors(db)
    result = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    child_id = result.child_model_id
    pm_api.remove_sub_process(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, db=db,
    )
    db.refresh(n2)
    assert "child_model_id" not in n2.properties
    child = db.get(ProcessModel, child_id)
    assert child.deleted_at is not None   # soft-deleted (drops out of the maps list)


def test_remove_sub_process_404_when_no_child(db):
    project, version, n2, claims = _seed_neighbors(db)
    with pytest.raises(HTTPException) as exc:
        pm_api.remove_sub_process(
            project=project, model_id=version.model_id, version_id=version.id,
            node_id=n2.id, db=db,
        )
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# Task 8: get-model + ancestry endpoints
# ---------------------------------------------------------------------------

def test_get_process_map_returns_level_and_latest_version(db):
    project, version, n2, claims = _seed_neighbors(db)
    out = pm_api.get_process_map(project=project, model_id=version.model_id, db=db)
    assert out.level == "L2"
    assert out.latest_version_id == version.id
    assert out.latest_version_number == 1


def test_ancestry_returns_root_to_leaf_chain(db):
    project, version, n2, claims = _seed_neighbors(db)
    res = pm_api.apply_decompose(
        project=project, model_id=version.model_id, version_id=version.id,
        node_id=n2.id, payload=_decompose_payload(), db=db,
    )
    cv = db.get(ProcessVersion, res.child_version_id)
    child_node = db.scalars(select(ProcessNode).where(ProcessNode.version_id == cv.id)).first()
    res2 = pm_api.apply_decompose(
        project=project, model_id=res.child_model_id, version_id=cv.id,
        node_id=child_node.id, payload=_decompose_payload(), db=db,
    )
    chain = pm_api.get_map_ancestry(project=project, model_id=res2.child_model_id, db=db)
    levels = [c.level for c in chain]
    assert levels == ["L2", "L3", "L4"]                  # root first
    assert chain[0].model_id == version.model_id
    assert chain[-1].model_id == res2.child_model_id
    # crumb label for the L3 map is the parent step it was decomposed from ("n2")
    assert chain[1].label == "n2"


def test_ancestry_single_for_root_map(db):
    project, version, n2, claims = _seed_neighbors(db)
    chain = pm_api.get_map_ancestry(project=project, model_id=version.model_id, db=db)
    assert len(chain) == 1 and chain[0].model_id == version.model_id
