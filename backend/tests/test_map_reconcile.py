"""Tests for SP-7c map reconcile: pure delta, forced-tool service, endpoint."""
from types import SimpleNamespace
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
from app.schemas.version_reconcile import ReconcileOp, ReconcileSuggestionRead
from app.services import map_reconcile
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


def test_reconcile_op_vocabulary():
    for op in ["add_step", "recite_node", "flag_stale_node", "relabel_node"]:
        assert ReconcileOp(op).value == op


def test_reconcile_op_rejects_unknown():
    with pytest.raises(ValueError):
        ReconcileOp("delete_map")


def test_reconcile_suggestion_read_shape():
    sug = ReconcileSuggestionRead(
        id=uuid4(),
        batch_id=uuid4(),
        op=ReconcileOp.RELABEL_NODE,
        payload={"node_id": str(uuid4()), "proposed_name": "Receive PO"},
        rationale="C1 says PO, not order.",
        confidence=0.8,
        status="pending",
    )
    assert sug.op == ReconcileOp.RELABEL_NODE
    assert sug.payload["proposed_name"] == "Receive PO"


# ---------------------------------------------------------------------------
# Forced-tool service tests (faked client — no ANTHROPIC_API_KEY required)
# ---------------------------------------------------------------------------


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


def test_propose_reconcile_parses_ops():
    fake = _FakeClient(
        "propose_reconcile",
        {
            "ops": [
                {
                    "op": "add_step",
                    "name": "Verify budget",
                    "type": "task",
                    "after_node_ref": "N1",
                    "lane_ref": "L1",
                    "lane_name": None,
                    "edge_label": "if over $10k",
                    "cited_claim_refs": ["C1"],
                    "rationale": "C1 implies a budget check.",
                },
                {
                    "op": "flag_stale_node",
                    "node_ref": "N1",
                    "vanished_claim_refs": ["C2"],
                    "rationale": "C2 no longer scoped.",
                },
            ]
        },
    )
    out = map_reconcile.propose_reconcile(
        client=fake, model="m", context_block="...", delta_block="..."
    )
    assert out["ops"][0]["op"] == "add_step"
    assert out["ops"][1]["node_ref"] == "N1"


def test_propose_reconcile_empty_on_malformed():
    fake = _FakeClient("not_the_tool", {"junk": True})
    out = map_reconcile.propose_reconcile(
        client=fake, model="m", context_block="...", delta_block="..."
    )
    assert out == {"ops": []}


def test_propose_reconcile_empty_on_non_list_ops():
    # Forced tool_use present, but ``ops`` is not a list -> degrade, don't raise.
    fake = _FakeClient("propose_reconcile", {"ops": None})
    out = map_reconcile.propose_reconcile(
        client=fake, model="m", context_block="...", delta_block="..."
    )
    assert out == {"ops": []}


def test_get_client_raises_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    map_reconcile._client = None
    with pytest.raises(RuntimeError):
        map_reconcile._get_client()
