"""Tests for SP-7c map reconcile: pure delta, forced-tool service, endpoint."""
from uuid import uuid4

import pytest

from app.enums import ClaimLinkKind
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process import (
    NodeClaimLink,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.process_inventory import Process, ProcessClaimLink
from app.models.project import Project
from app.services.map_reconcile import compute_claim_delta


def _seed(db):
    """A mapped process whose claim set has drifted from the map's citations.

    - claim_new: linked to the process, cited by NO node     -> new evidence
    - claim_kept: linked to the process AND cited by node n1  -> neither
    - claim_gone: cited by node n1 but NOT linked to process  -> vanished on n1
    - claim_deleted: cited by node n1 but the claim is deleted -> vanished on n1
    """
    org = Organization(name="O")
    db.add(org)
    db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U")
    db.add(user)
    db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id)
    db.add(project)
    db.flush()
    process = Process(project_id=project.id, name="Order to Cash")
    db.add(process)
    db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2", process_id=process.id)
    db.add(model)
    db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1)
    db.add(version)
    db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0)
    db.add(lane)
    db.flush()
    n1 = ProcessNode(
        version_id=version.id, lane_id=lane.id, type="task", name="Receive",
        position={}, properties={},
    )
    db.add(n1)
    db.flush()

    claim_new = Claim(project_id=project.id, kind="task", subject="New step appears", normalized={})
    claim_kept = Claim(project_id=project.id, kind="task", subject="Receive the order", normalized={})
    claim_gone = Claim(project_id=project.id, kind="task", subject="No longer in scope", normalized={})
    claim_deleted = Claim(project_id=project.id, kind="task", subject="Will be deleted", normalized={})
    db.add_all([claim_new, claim_kept, claim_gone, claim_deleted])
    db.flush()

    # Process links: new + kept... but claim_gone is NOT linked.
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim_new.id))
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim_kept.id))
    db.flush()

    # Node citations: kept (still linked), gone (not linked), deleted (claim removed).
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim_kept.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim_gone.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    deleted_link = NodeClaimLink(
        node_id=n1.id, claim_id=claim_deleted.id, link_kind=ClaimLinkKind.SUPPORTS.value
    )
    db.add(deleted_link)
    db.flush()
    # Deleting the claim cascades its NodeClaimLink away (FK ondelete), so a
    # *dangling* citation cannot occur — only live-but-unlinked claims vanish.
    db.delete(claim_deleted)
    db.commit()
    return process, version, n1, claim_new, claim_kept, claim_gone


def test_compute_claim_delta_new_and_vanished(db):
    process, version, n1, claim_new, claim_kept, claim_gone = _seed(db)
    delta = compute_claim_delta(db, version, process.id)

    # New evidence = claim linked to process but cited by no node.
    assert [c.id for c in delta.new_evidence] == [claim_new.id]

    # Vanished evidence keyed by node id; claim_gone is no longer linked to the
    # process. (claim_deleted's NodeClaimLink was cascade-removed when the claim
    # was deleted, so it cannot appear — only live citations can vanish.)
    assert n1.id in delta.vanished_evidence
    assert claim_gone.id in delta.vanished_evidence[n1.id]
    assert claim_kept.id not in delta.vanished_evidence.get(n1.id, [])


def test_compute_claim_delta_empty_when_in_sync(db):
    process, version, n1, claim_new, claim_kept, claim_gone = _seed(db)
    # Bring it into sync: link claim_gone to the process, and cite claim_new on n1.
    db.add(ProcessClaimLink(process_id=process.id, claim_id=claim_gone.id))
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim_new.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    delta = compute_claim_delta(db, version, process.id)
    assert delta.new_evidence == []
    assert delta.vanished_evidence == {}
    assert delta.is_empty()
