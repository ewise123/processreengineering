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
        message, raw = map_chat_suggest.run_chat_suggest(
            history=[], user_message="improve N1", map_context_text="...",
            mode=ChatMode.SUGGEST,
        )
    assert "improvement" in message
    assert raw[0]["kind"] == "relabel_node"
    assert raw[0]["cited_claim_refs"] == ["C1"]


def test_suggest_mode_no_tool_call_returns_empty_suggestions():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([_TextBlock("That looks correct as-is; no change needed.")])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        message, raw = map_chat_suggest.run_chat_suggest(
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
        message, raw = map_chat_suggest.run_chat_suggest(
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
        message, raw = map_chat_suggest.run_chat_suggest(
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
             "cited_claim_refs": ["C1", "C99"]}])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="improve N1", mode="suggest"),
            db=db,
        )
    assert resp.message == "Here is a fix."
    assert len(resp.suggestions) == 1
    assert resp.suggestions[0].op.node_ref == str(n1.id)
    assert resp.suggestions[0].cited_claim_ids == [claim.id]   # C99 dropped


def test_chat_suggest_endpoint_ask_mode_has_no_suggestions(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest",
                   lambda **k: ("Plain answer.", []))
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
        ])

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
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, n1, claim = _seed(db)
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest",
                   lambda **k: ("See step [[N1]].", []))
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
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest, ObjectRef
    from app.models.process import ProcessNode
    project, version, n1, claim = _seed(db)
    n2 = ProcessNode(version_id=version.id, lane_id=n1.lane_id, type="task", name="Approve", position={}, properties={})
    db.add(n2); db.commit()
    captured = {}

    def fake_service(*, history, user_message, map_context_text, mode):
        captured["ctx"] = map_context_text
        return ("ok", [])

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_suggest", fake_service)
        pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(
                user_message="compare these", mode="ask",
                context_refs=[ObjectRef(kind="node", id=n1.id), ObjectRef(kind="node", id=n2.id)],
            ),
            db=db,
        )
    assert "N1" in captured["ctx"] and "N2" in captured["ctx"]
    assert "focus" in captured["ctx"].lower()


# ---------------------------------------------------------------------------
# Phase 2.1a Task 2: mention_sources on chat-suggest response
# ---------------------------------------------------------------------------


def test_chat_suggest_attaches_mention_sources_for_cited_claims(db):
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    from app.models.input import Chunk, DocumentSection, Input
    from app.models.claim import ClaimCitation
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
        mp.setattr(pm_api, "run_chat_suggest", lambda **k: ("Per [[C1]] this is logged.", []))
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
    from app.api.v2 import process_maps as pm_api
    from app.schemas.version_chat_suggest import ChatSuggestRequest
    project, version, _n1, _claim = _seed(db)

    with _pytest.MonkeyPatch.context() as mp:
        # "abc" is hex-ish (matches the regex) but not a valid UUID.
        mp.setattr(pm_api, "run_chat_suggest", lambda **k: ("See [[claim:abc]] here.", []))
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="x", mode="ask"), db=db)
    # No crash; the malformed token simply produces no source.
    assert resp.mention_sources == []
    assert "[[claim:abc]]" in resp.message
