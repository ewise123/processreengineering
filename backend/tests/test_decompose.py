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
