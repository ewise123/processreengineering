"""Tests for the chat-suggest backend: schemas, service, endpoint, resolution."""
import pytest


def test_op_relabel_node_requires_node_ref_and_label():
    from app.schemas.version_chat_suggest import SuggestionOp, OpKind
    op = SuggestionOp(kind=OpKind.RELABEL_NODE, node_ref="N1", new_label="Receive PO")
    assert op.kind == OpKind.RELABEL_NODE
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.RELABEL_NODE, node_ref="N1")  # missing new_label


def test_op_add_node_requires_temp_id_lane_and_type():
    from app.schemas.version_chat_suggest import SuggestionOp, OpKind
    op = SuggestionOp(
        kind=OpKind.ADD_NODE, temp_id="tmp:1", lane_ref="L1",
        node_type="task", new_label="Verify budget",
    )
    assert op.temp_id == "tmp:1"
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.ADD_NODE, temp_id="tmp:1", lane_ref="L1", node_type="task")


def test_op_add_node_rejects_unknown_node_type():
    from app.schemas.version_chat_suggest import SuggestionOp, OpKind
    with pytest.raises(ValueError):
        SuggestionOp(kind=OpKind.ADD_NODE, temp_id="tmp:1", lane_ref="L1",
                     node_type="not_a_type", new_label="X")


def test_substep_rejects_unknown_proposed_type():
    from app.schemas.version_chat_suggest import SubStepInput
    with pytest.raises(ValueError):
        SubStepInput(proposed_name="X", proposed_type="not_a_type")
    SubStepInput(proposed_name="X", proposed_type="task")  # valid, no raise


def test_chat_suggest_request_defaults():
    from app.schemas.version_chat_suggest import ChatSuggestRequest, ChatMode
    req = ChatSuggestRequest(user_message="hi", mode="ask")
    assert req.mode == ChatMode.ASK
    assert req.history == []
    assert req.context_refs == []


# ---------------------------------------------------------------------------
# Service tests (Task 3)
# ---------------------------------------------------------------------------
from types import SimpleNamespace
from unittest.mock import patch


class _TextBlock:
    def __init__(self, text):
        self.type = "text"; self.text = text


class _ToolBlock:
    def __init__(self, name, payload):
        self.type = "tool_use"; self.name = name; self.input = payload


class _FakeClient:
    def __init__(self, blocks):
        self._blocks = blocks

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        return SimpleNamespace(content=self._blocks)


def test_suggest_mode_returns_message_and_raw_suggestions():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([
        _TextBlock("Here is one improvement."),
        _ToolBlock("propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
             "title": "Clarify step name", "rationale": "C1 says so.",
             "cited_claim_refs": ["C1"]}]}),
    ])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        message, raw, groups = map_chat_suggest.run_chat_suggest(
            history=[], user_message="improve N1", map_context_text="...",
            mode=ChatMode.SUGGEST,
        )
    assert "improvement" in message
    assert groups == []
    assert raw[0]["kind"] == "relabel_node"
    assert raw[0]["cited_claim_refs"] == ["C1"]


def test_suggest_mode_no_tool_call_returns_empty_suggestions():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([_TextBlock("That looks correct as-is; no change needed.")])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        message, raw, _groups = map_chat_suggest.run_chat_suggest(
            history=[], user_message="is N1 ok?", map_context_text="...",
            mode=ChatMode.SUGGEST,
        )
    assert raw == []
    assert "no change" in message.lower()


def test_ask_mode_never_calls_tools():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    captured = {}

    def fake_chat(*, history, user_message, map_context_text, extra_instructions=""):
        captured["called"] = True
        captured["extra_instructions"] = extra_instructions
        return "A plain answer."

    with patch.object(map_chat_suggest, "chat", fake_chat):
        message, raw, _groups = map_chat_suggest.run_chat_suggest(
            history=[], user_message="what is N1?", map_context_text="...",
            mode=ChatMode.ASK,
        )
    assert captured["called"] is True
    assert raw == []
    assert message == "A plain answer."
    assert captured["extra_instructions"]  # MENTION_INSTRUCTIONS was passed


def test_suggest_mode_ignores_non_list_suggestions():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([_ToolBlock("propose_changes", {"suggestions": {"oops": "not a list"}})])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        _message, raw, _groups = map_chat_suggest.run_chat_suggest(
            history=[], user_message="x", map_context_text="...", mode=ChatMode.SUGGEST)
    assert raw == []


# ---------------------------------------------------------------------------
# Resolution helpers (Task 4)
# ---------------------------------------------------------------------------


def _ctx_stub():
    """A minimal object with the resolution maps the helpers read."""
    from uuid import uuid4
    n1, n2, e1, l1, c1 = uuid4(), uuid4(), uuid4(), uuid4(), uuid4()
    return SimpleNamespace(
        node_ref_to_id={"N1": n1, "N2": n2},
        edge_ref_to_id={"E1": e1},
        lane_ref_to_id={"L1": l1},
        claim_ref_to_id={"C1": c1},
        node_name_by_id={n1: "Receive invoice", n2: "Approve"},
        edge_label_by_id={e1: "if approved"},
        lane_name_by_id={l1: "Finance"},
    ), (n1, n2, e1, l1, c1)


def test_build_suggestion_resolves_node_ref_and_claims():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, _e1, _l1, c1) = _ctx_stub()
    raw = {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
           "title": "Clarify", "rationale": "C1 says so.",
           "cited_claim_refs": ["C1", "C99"]}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s.op.node_ref == str(n1)           # short ref resolved to UUID string
    assert s.cited_claim_ids == [c1]          # C99 dropped
    assert s.affected_refs[0].id == n1
    assert s.affected_refs[0].kind.value == "node"


def test_build_suggestion_captures_before_label_for_rename_family():
    # The card freezes the target's name as it was when proposed, so it can show
    # a stable "old -> new" instead of collapsing to the new name after apply.
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, e1, l1, _c1) = _ctx_stub()

    node = pm_api._build_suggestion(
        {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
         "title": "t", "rationale": "r", "cited_claim_refs": []}, ctx, index=0)
    assert node.before_label == "Receive invoice"

    lane = pm_api._build_suggestion(
        {"kind": "rename_lane", "lane_ref": "L1", "name": "Procurement",
         "title": "t", "rationale": "r", "cited_claim_refs": []}, ctx, index=1)
    assert lane.before_label == "Finance"

    edge = pm_api._build_suggestion(
        {"kind": "relabel_edge", "edge_ref": "E1", "new_label": "if rejected",
         "title": "t", "rationale": "r", "cited_claim_refs": []}, ctx, index=2)
    assert edge.before_label == "if approved"


def test_build_suggestion_before_label_none_for_non_rename_ops():
    from app.api.v2 import process_maps as pm_api
    ctx, (_n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    s = pm_api._build_suggestion(
        {"kind": "move_to_lane", "node_ref": "N1", "lane_ref": "L1",
         "title": "t", "rationale": "r", "cited_claim_refs": []}, ctx, index=0)
    assert s.before_label is None


def test_build_suggestion_keeps_temp_ids_for_new_objects():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, _e1, l1, _c1) = _ctx_stub()
    raw = {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1",
           "node_type": "task", "new_label": "Verify budget", "near_node_ref": "N1",
           "title": "Add budget check", "rationale": "needed", "cited_claim_refs": []}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s.op.temp_id == "tmp:1"            # temp id untouched
    assert s.op.lane_ref == str(l1)           # existing lane resolved
    assert s.op.near_node_ref == str(n1)
    # affected_refs holds only resolvable existing objects (the lane + near node)
    assert {r.id for r in s.affected_refs} == {l1, n1}


def test_build_suggestion_returns_none_for_malformed_op():
    from app.api.v2 import process_maps as pm_api
    ctx, _ = _ctx_stub()
    raw = {"kind": "relabel_node", "node_ref": "N1",  # missing new_label
           "title": "x", "rationale": "y", "cited_claim_refs": []}
    assert pm_api._build_suggestion(raw, ctx, index=0) is None


def test_build_suggestion_add_node_accepts_name_as_label():
    """The model commonly fills `name` (not `new_label`) for a new node's label.
    Accept it as the label so the add_node isn't dropped — a dropped producer
    orphans the add_edge ops that point at its temp_id and sinks the bundle."""
    from app.api.v2 import process_maps as pm_api
    ctx, (_n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    raw = {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1",
           "node_type": "task", "name": "Manager Approval", "near_node_ref": "N1",
           "title": "Add approval", "rationale": "needed", "cited_claim_refs": []}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s is not None                       # not dropped
    assert s.op.new_label == "Manager Approval"  # name coalesced into new_label


def test_build_suggestion_prefers_new_label_over_name_for_add_node():
    """When both are present, new_label wins; name is only a fallback."""
    from app.api.v2 import process_maps as pm_api
    ctx, (_n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    raw = {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1",
           "node_type": "task", "new_label": "Real label", "name": "Other",
           "title": "t", "rationale": "r", "cited_claim_refs": []}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s.op.new_label == "Real label"


def test_drop_orphaned_consumers_removes_dangling_tmp_refs():
    """A suggestion that consumes a tmp: ref with no producer in the set is
    dropped, so the frontend never rejects a whole bundle over a dangling ref."""
    from app.api.v2 import process_maps as pm_api
    ctx, (_n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    # add_edge from a NEW (missing) node tmp:1 to existing N1 -> orphan.
    orphan = pm_api._build_suggestion(
        {"kind": "add_edge", "from_ref": "tmp:1", "to_ref": "N1",
         "title": "wire", "rationale": "r", "cited_claim_refs": []}, ctx, index=0)
    # relabel of an existing node -> no tmp deps, must survive.
    keeper = pm_api._build_suggestion(
        {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
         "title": "t", "rationale": "r", "cited_claim_refs": []}, ctx, index=1)
    kept = pm_api._drop_orphaned_consumers([orphan, keeper])
    assert kept == [keeper]


def test_drop_orphaned_consumers_keeps_satisfied_tmp_refs():
    """A consumer whose producer IS present survives."""
    from app.api.v2 import process_maps as pm_api
    ctx, (_n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    producer = pm_api._build_suggestion(
        {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1",
         "node_type": "task", "new_label": "New step",
         "title": "t", "rationale": "r", "cited_claim_refs": []}, ctx, index=0)
    consumer = pm_api._build_suggestion(
        {"kind": "add_edge", "from_ref": "N1", "to_ref": "tmp:1",
         "title": "wire", "rationale": "r", "cited_claim_refs": []}, ctx, index=1)
    kept = pm_api._drop_orphaned_consumers([producer, consumer])
    assert kept == [producer, consumer]


def test_repair_new_lane_links_missing_temp_id_to_move_consumer():
    """The model creates a lane and moves a step into it but omits the add_lane's
    temp_id, referencing the new lane only via a tmp lane_ref on the move. Recover
    the link (matched by the shared group) so the add_lane validates and its
    consumer isn't pruned as an orphan — the exact live-repro'd bug."""
    from app.api.v2 import process_maps as pm_api
    raw = [
        {"kind": "add_lane", "name": "Approvals", "group": "approvals-lane",
         "title": "Add lane", "rationale": "r", "cited_claim_refs": []},
        {"kind": "move_to_lane", "node_ref": "N1", "lane_ref": "tmp:approvals-lane",
         "group": "approvals-lane", "title": "Move", "rationale": "r", "cited_claim_refs": []},
    ]
    pm_api._repair_new_lane_temp_ids(raw)
    assert raw[0]["temp_id"] == "tmp:approvals-lane"  # add_lane adopts the consumer's tmp ref

    # And end to end: both ops now survive build + prune with a consistent link.
    ctx, (n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    built = [pm_api._build_suggestion(r, ctx, index=i) for i, r in enumerate(raw)]
    assert all(b is not None for b in built)
    kept = pm_api._drop_orphaned_consumers([b for b in built if b])
    kinds = {b.op.kind.value for b in kept}
    assert kinds == {"add_lane", "move_to_lane"}


def test_repair_new_lane_links_unambiguously_without_group():
    """With no group but a single temp_id-less add_lane and a single consumed tmp
    lane ref, the link is unambiguous and still recovered."""
    from app.api.v2 import process_maps as pm_api
    raw = [
        {"kind": "add_lane", "name": "Approvals",
         "title": "Add lane", "rationale": "r", "cited_claim_refs": []},
        {"kind": "move_to_lane", "node_ref": "N1", "lane_ref": "tmp:9",
         "title": "Move", "rationale": "r", "cited_claim_refs": []},
    ]
    pm_api._repair_new_lane_temp_ids(raw)
    assert raw[0]["temp_id"] == "tmp:9"


def test_repair_new_lane_leaves_valid_temp_id_untouched():
    """An add_lane that already carries a temp_id is not rewritten."""
    from app.api.v2 import process_maps as pm_api
    raw = [
        {"kind": "add_lane", "name": "Approvals", "temp_id": "tmp:keep", "group": "g",
         "title": "Add lane", "rationale": "r", "cited_claim_refs": []},
        {"kind": "move_to_lane", "node_ref": "N1", "lane_ref": "tmp:keep", "group": "g",
         "title": "Move", "rationale": "r", "cited_claim_refs": []},
    ]
    pm_api._repair_new_lane_temp_ids(raw)
    assert raw[0]["temp_id"] == "tmp:keep"


def test_repair_new_lane_skips_when_ambiguous():
    """Two temp_id-less add_lanes with no group to disambiguate are left alone
    rather than guessing (they'll drop; the prompt rule is the primary guard)."""
    from app.api.v2 import process_maps as pm_api
    raw = [
        {"kind": "add_lane", "name": "A", "title": "t", "rationale": "r", "cited_claim_refs": []},
        {"kind": "add_lane", "name": "B", "title": "t", "rationale": "r", "cited_claim_refs": []},
        {"kind": "move_to_lane", "node_ref": "N1", "lane_ref": "tmp:1",
         "title": "t", "rationale": "r", "cited_claim_refs": []},
    ]
    pm_api._repair_new_lane_temp_ids(raw)
    assert "temp_id" not in raw[0] and "temp_id" not in raw[1]


def test_build_suggestion_resolves_lowercase_ref():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    raw = {"kind": "relabel_node", "node_ref": "n1", "new_label": "Receive PO",
           "title": "Clarify", "rationale": "r", "cited_claim_refs": []}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s.op.node_ref == str(n1)
    assert s.affected_refs[0].id == n1


# ---------------------------------------------------------------------------
# Endpoint tests (Task 5)
# ---------------------------------------------------------------------------
import pytest as _pytest
from fastapi import HTTPException
from uuid import uuid4


def _seed(db):
    from app.enums import ClaimLinkKind
    from app.models.identity import Organization, User
    from app.models.project import Project
    from app.models.claim import Claim
    from app.models.process import (
        NodeClaimLink, ProcessModel, ProcessVersion, ProcessLane, ProcessNode,
    )
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    model = ProcessModel(project_id=project.id, name="M", level="L2"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1); db.add(version); db.flush()
    lane = ProcessLane(version_id=version.id, name="Ops", order_index=0); db.add(lane); db.flush()
    n1 = ProcessNode(version_id=version.id, lane_id=lane.id, type="task", name="Receive", position={}, properties={})
    db.add(n1); db.flush()
    claim = Claim(project_id=project.id, kind="task", subject="Clerk receives order", normalized={})
    db.add(claim); db.flush()
    db.add(NodeClaimLink(node_id=n1.id, claim_id=claim.id, link_kind=ClaimLinkKind.SUPPORTS.value))
    db.commit()
    return project, version, n1, claim


def test_chat_suggest_endpoint_resolves_suggestion(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)

    def fake_service(*, history, user_message, map_context_text, mode):
        return ("Here is a fix.", [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
             "title": "Clarify", "rationale": "C1 supports it.",
             "cited_claim_refs": ["C1", "C99"]}], [])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="improve N1", mode="suggest"),
            db=db,
        )
    # When suggestion cards are returned, the top-level prose is suppressed — the
    # cards ARE the response, and stray prose only restates the change as noise.
    assert resp.message == ""
    assert len(resp.suggestions) == 1
    assert resp.suggestions[0].op.node_ref == str(n1.id)
    assert resp.suggestions[0].cited_claim_ids == [claim.id]   # C99 dropped


def test_chat_suggest_endpoint_ask_mode_has_no_suggestions(db):
    # Ask mode now routes to the agent loop (run_chat_agent), not run_chat_suggest.
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    from app.services.map_chat_agent import AgentResult
    project, version, n1, claim = _seed(db)
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent",
                   lambda **k: AgentResult(answer="Plain answer."))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="what is N1?", mode="ask"),
            db=db,
        )
    assert resp.suggestions == []
    assert resp.message == "Plain answer."


def test_chat_suggest_endpoint_404_for_foreign_model(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)
    with _pytest.raises(HTTPException) as exc:
        pm_api.chat_suggest(
            project=project, model_id=uuid4(), version_id=version.id,
            payload=ChatSuggestRequest(user_message="hi", mode="ask"), db=db,
        )
    assert exc.value.status_code == 404


def test_chat_suggest_endpoint_502_on_runtime_error(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)
    def boom(**k):
        raise RuntimeError("no key")
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", boom)
        with _pytest.raises(HTTPException) as exc:
            pm_api.chat_suggest(
                project=project, model_id=version.model_id, version_id=version.id,
                payload=ChatSuggestRequest(user_message="hi", mode="suggest"), db=db,
            )
    assert exc.value.status_code == 502


def test_consistency_endpoint_reports_findings(db):
    from app.api.v2 import process_maps as pm_api
    from app.models.process import ProcessNode
    project, version, n1, claim = _seed(db)
    # Add a duplicate-named node to trigger a finding.
    dup = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task",
                      name=n1.name, position={}, properties={})
    db.add(dup); db.commit()
    resp = pm_api.map_consistency(
        project=project, model_id=version.model_id, version_id=version.id, db=db,
    )
    assert any(f.code == "duplicate_name" for f in resp)


def test_build_suggestion_decompose_coerces_substeps():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, _e1, _l1, _c1) = _ctx_stub()
    raw = {"kind": "decompose", "node_ref": "N1",
           "sub_steps": [{"proposed_name": "Step A", "proposed_type": "task"},
                         {"proposed_name": "Step B", "proposed_type": "task"}],
           "title": "Break down", "rationale": "r", "cited_claim_refs": []}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s is not None
    assert s.op.node_ref == str(n1)
    assert len(s.op.sub_steps) == 2
    assert s.op.sub_steps[0].proposed_name == "Step A"  # coerced to SubStepInput


def test_build_suggestion_add_edge_between_two_temp_ids():
    from app.api.v2 import process_maps as pm_api
    ctx, _ = _ctx_stub()
    raw = {"kind": "add_edge", "from_ref": "tmp:1", "to_ref": "tmp:2",
           "edge_label": "yes", "title": "Connect new nodes", "rationale": "r",
           "cited_claim_refs": []}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert s is not None
    assert s.op.from_ref == "tmp:1" and s.op.to_ref == "tmp:2"  # temp ids untouched
    assert s.affected_refs == []  # neither endpoint is a real existing object


def test_chat_suggest_endpoint_drops_only_malformed_op_in_batch(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)

    def fake_service(*, history, user_message, map_context_text, mode):
        return ("Two ideas.", [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
             "title": "Good", "rationale": "r", "cited_claim_refs": []},
            {"kind": "relabel_node", "node_ref": "N1",  # malformed: missing new_label
             "title": "Bad", "rationale": "r", "cited_claim_refs": []},
        ], [])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="suggest"), db=db)
    assert len(resp.suggestions) == 1               # malformed dropped, good kept
    assert resp.suggestions[0].title == "Good"


# ---------------------------------------------------------------------------
# Phase 2 Task 1: mention ref resolution
# ---------------------------------------------------------------------------


def test_resolve_mention_refs_rewrites_known_refs_to_uuids():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, e1, l1, c1) = _ctx_stub()
    msg = "Step [[N1]] feeds edge [[E1]] per claim [[C1]] in lane [[L1]]."
    out = pm_api._resolve_mention_refs(msg, ctx)
    assert f"[[node:{n1}]]" in out
    assert f"[[edge:{e1}]]" in out
    assert f"[[claim:{c1}]]" in out
    assert f"[[lane:{l1}]]" in out


def test_resolve_mention_refs_flattens_unknown_refs():
    from app.api.v2 import process_maps as pm_api
    ctx, _ = _ctx_stub()
    out = pm_api._resolve_mention_refs("Unknown [[N9]] here.", ctx)
    assert out == "Unknown N9 here."  # brackets stripped, plain text kept


def test_chat_runs_extra_instructions_into_system(monkeypatch):
    from app.services import map_chat
    captured = {}

    class _Resp:
        content = [type("B", (), {"type": "text", "text": "ok"})()]

    class _Client:
        @property
        def messages(self):
            return self
        def create(self, **kwargs):
            captured["system"] = kwargs["system"]
            return _Resp()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(map_chat.anthropic, "Anthropic", lambda **k: _Client())
    map_chat.chat(history=[], user_message="hi", map_context_text="M",
                  extra_instructions="WRAP REFS LIKE [[N3]]")
    assert "WRAP REFS LIKE [[N3]]" in captured["system"]


def test_chat_suggest_ask_message_is_mention_resolved(db):
    # Ask mode now routes to the agent loop (run_chat_agent), not run_chat_suggest.
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    from app.services.map_chat_agent import AgentResult
    project, version, n1, claim = _seed(db)
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent",
                   lambda **k: AgentResult(answer="See step [[N1]]."))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="ask"), db=db)
    assert f"[[node:{n1.id}]]" in resp.message


# ---------------------------------------------------------------------------
# Phase 2.1a Task 1: ground on all context nodes; drop edge refs + parenthetical
# ---------------------------------------------------------------------------


def test_mention_instructions_drop_edges_and_parenthetical():
    from app.services.map_chat_suggest import MENTION_INSTRUCTIONS
    low = MENTION_INSTRUCTIONS.lower()
    assert "[[e" not in low                      # no edge-ref instruction
    assert "parenthes" in low or "do not repeat" in low  # tells model not to restate name


def test_chat_suggest_focuses_on_all_context_nodes(db):
    # Ask mode now routes to the agent loop (run_chat_agent), which receives the
    # attached nodes as an explicit `focus_refs` list rather than a text blob.
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest, ObjectRef
    from app.models.process import ProcessNode
    from app.services.map_chat_agent import AgentResult
    project, version, n1, claim = _seed(db)
    n2 = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task", name="Approve", position={}, properties={})
    db.add(n2); db.commit()
    captured = {}

    def fake_agent(*, tool_ctx, skeleton_text, selected_label, focus_refs, history, user_message):
        captured["focus_refs"] = focus_refs
        return AgentResult(answer="ok")

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent", fake_agent)
        pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(
                user_message="compare these", mode="ask",
                context_refs=[ObjectRef(kind="node", id=n1.id), ObjectRef(kind="node", id=n2.id)],
            ),
            db=db,
        )
    assert "N1" in captured["focus_refs"] and "N2" in captured["focus_refs"]


# ---------------------------------------------------------------------------
# Phase 2.1a Task 2: mention_sources on chat-suggest response
# ---------------------------------------------------------------------------


def test_chat_suggest_attaches_mention_sources_for_cited_claims(db):
    # Ask mode now routes to the agent loop (run_chat_agent), not run_chat_suggest.
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    from app.models.input import Chunk, DocumentSection, Input
    from app.models.claim import ClaimCitation
    from app.services.map_chat_agent import AgentResult
    project, version, n1, claim = _seed(db)
    inp = Input(project_id=project.id, name="SOP.pdf", type="document")
    db.add(inp); db.flush()
    sec = DocumentSection(
        input_id=inp.id, kind="section", order_index=0,
        ref={"page": 1}, text="The clerk receives it.",
    )
    db.add(sec); db.flush()
    chunk = Chunk(section_id=sec.id, char_start=0, char_end=22, text="the clerk receives it")
    db.add(chunk); db.flush()
    db.add(ClaimCitation(claim_id=claim.id, chunk_id=chunk.id, quote="the clerk receives it"))
    db.commit()

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent",
                   lambda **k: AgentResult(answer="Per [[C1]] this is logged."))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="ask"), db=db)
    assert f"[[claim:{claim.id}]]" in resp.message
    src = next(s for s in resp.mention_sources if s.claim_id == claim.id)
    assert src.input_id == inp.id and src.input_name == "SOP.pdf"
    assert src.quote == "the clerk receives it"


def test_chat_suggest_skips_malformed_claim_token_without_crashing(db):
    """A non-UUID [[claim:...]] token (e.g. echoed user text) must be skipped,
    not raise ValueError and turn the endpoint into a 500."""
    # Ask mode now routes to the agent loop (run_chat_agent), not run_chat_suggest.
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    from app.services.map_chat_agent import AgentResult
    project, version, _n1, _claim = _seed(db)

    with _pytest.MonkeyPatch.context() as mp:
        # "abc" is hex-ish (matches the regex) but not a valid UUID.
        mp.setattr(pm_api, "run_chat_agent",
                   lambda **k: AgentResult(answer="See [[claim:abc]] here."))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="ask"), db=db)
    # No crash; the malformed token simply produces no source.
    assert resp.mention_sources == []
    assert "[[claim:abc]]" in resp.message


# ---------------------------------------------------------------------------
# Suggest-mode UI feedback: bundle summaries + named refs in title/rationale
# ---------------------------------------------------------------------------


def test_service_extracts_group_summaries():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([
        _ToolBlock("propose_changes", {
            "suggestions": [{"kind": "relabel_node", "node_ref": "N1",
                             "new_label": "X", "title": "t", "rationale": "r",
                             "group": "g1"}],
            "groups": [{"id": "g1", "summary": "Tidy the naming."}],
        }),
    ])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        _msg, raw, groups = map_chat_suggest.run_chat_suggest(
            history=[], user_message="x", map_context_text="...", mode=ChatMode.SUGGEST)
    assert raw and groups == [{"id": "g1", "summary": "Tidy the naming."}]


def test_build_suggestion_resolves_mentions_in_title_and_rationale():
    from app.api.v2 import process_maps as pm_api
    ctx, (n1, _n2, _e1, _l1, c1) = _ctx_stub()
    raw = {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
           "title": "Rename [[N1]]", "rationale": "Per [[C1]], rename it.",
           "cited_claim_refs": ["C1"]}
    s = pm_api._build_suggestion(raw, ctx, index=0)
    assert f"[[node:{n1}]]" in s.title
    assert f"[[claim:{c1}]]" in s.rationale


def test_endpoint_returns_group_summaries_only_for_used_groups(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, _n1, _claim = _seed(db)

    def fake_service(*, history, user_message, map_context_text, mode):
        return ("Bundled.", [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
             "title": "t", "rationale": "r", "group": "g1", "cited_claim_refs": []},
        ], [
            {"id": "g1", "summary": "Clean up receiving."},
            {"id": "ghost", "summary": "Unused group, must be dropped."},
        ])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="suggest"), db=db)
    assert [(g.id, g.summary) for g in resp.group_summaries] == [("g1", "Clean up receiving.")]


def test_endpoint_mention_sources_include_claims_cited_in_rationale(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    from app.models.input import Chunk, DocumentSection, Input
    from app.models.claim import ClaimCitation
    project, version, _n1, claim = _seed(db)
    inp = Input(project_id=project.id, name="SOP.pdf", type="document"); db.add(inp); db.flush()
    sec = DocumentSection(input_id=inp.id, kind="section", order_index=0, ref={"page": 1}, text="t")
    db.add(sec); db.flush()
    chunk = Chunk(section_id=sec.id, char_start=0, char_end=1, text="t"); db.add(chunk); db.flush()
    db.add(ClaimCitation(claim_id=claim.id, chunk_id=chunk.id, quote="t")); db.commit()

    def fake_service(*, history, user_message, map_context_text, mode):
        return ("No prose mentions here.", [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Receive PO",
             "title": "Rename it", "rationale": "Backed by [[C1]].", "cited_claim_refs": ["C1"]},
        ], [])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="suggest"), db=db)
    # The claim was cited only in a suggestion rationale (not the prose) — still surfaced.
    assert any(s.claim_id == claim.id for s in resp.mention_sources)
