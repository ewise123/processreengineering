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

    def fake_chat(*, history, user_message, map_context_text):
        captured["called"] = True
        return "A plain answer."

    with patch.object(map_chat_suggest, "chat", fake_chat):
        message, raw = map_chat_suggest.run_chat_suggest(
            history=[], user_message="what is N1?", map_context_text="...",
            mode=ChatMode.ASK,
        )
    assert captured["called"] is True
    assert raw == []
    assert message == "A plain answer."


def test_suggest_mode_ignores_non_list_suggestions():
    from app.services import map_chat_suggest
    from app.schemas.version_chat_suggest import ChatMode
    fake = _FakeClient([_ToolBlock("propose_changes", {"suggestions": {"oops": "not a list"}})])
    with patch.object(map_chat_suggest, "_get_client", return_value=fake):
        message, raw = map_chat_suggest.run_chat_suggest(
            history=[], user_message="x", map_context_text="...", mode=ChatMode.SUGGEST)
    assert raw == []
