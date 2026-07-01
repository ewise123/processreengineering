from types import SimpleNamespace
from unittest.mock import patch

from app.services import map_chat_agent


class _Text:
    def __init__(self, text): self.type = "text"; self.text = text


class _ToolUse:
    def __init__(self, id, name, inp): self.type = "tool_use"; self.id = id; self.name = name; self.input = inp


def _resp(blocks, stop="end_turn", inp=100, out=50):
    return SimpleNamespace(content=blocks, stop_reason=stop, usage=SimpleNamespace(input_tokens=inp, output_tokens=out))


class _FakeClient:
    def __init__(self, responses):
        self._responses = list(responses); self.calls = []
    @property
    def messages(self): return self
    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0)


def _run(fake, **over):
    kwargs = dict(
        skeleton_text="NODES:\n  N1 [task]: Receive Invoice",
        selected_label=None, focus_refs=[], history=[], user_message="how are invoices approved?",
    )
    kwargs.update(over)
    def fake_dispatch(ctx, *, name, args):
        return ({"ok": True}, f"ran {name}", set())
    with patch.object(map_chat_agent, "_get_client", return_value=fake), \
         patch.object(map_chat_agent, "dispatch_tool", fake_dispatch):
        return map_chat_agent.run_chat_agent(tool_ctx=object(), **kwargs)


def test_normal_stop_returns_answer_and_trace():
    fake = _FakeClient([
        _resp([_ToolUse("t1", "find_node", {"query": "invoice"})]),
        _resp([_Text("Invoices are approved by AP. [[C1]]")]),
    ])
    result = _run(fake)
    assert "approved by AP" in result.answer
    assert result.stop_reason == "normal"
    assert result.round_count == 2
    assert len(result.trace) == 1
    assert result.trace[0]["tool"] == "find_node"


def test_max_tokens_stop_is_recorded_honestly():
    # A tool-less final response that the API truncated (stop_reason max_tokens)
    # must NOT be mislabeled "normal".
    fake = _FakeClient([_resp([_Text("Partial answer that got cut off")], stop="max_tokens")])
    result = _run(fake)
    assert result.stop_reason == "max_tokens"


def test_refusal_stop_is_recorded_honestly():
    fake = _FakeClient([_resp([], stop="refusal")])
    result = _run(fake)
    assert result.stop_reason == "refusal"
    assert result.answer == "(no response)"


def test_multiple_tool_uses_in_one_round_all_dispatched():
    # Anthropic requires every tool_use in an assistant turn to get a tool_result;
    # verify the fan-out dispatches ALL blocks in a single round.
    fake = _FakeClient([
        _resp([
            _ToolUse("t1", "find_node", {"query": "a"}),
            _ToolUse("t2", "search_claims", {"query": "b"}),
        ]),
        _resp([_Text("Done. [[C1]]")]),
    ])
    result = _run(fake)
    assert result.stop_reason == "normal"
    assert len(result.trace) == 2
    assert {t["tool"] for t in result.trace} == {"find_node", "search_claims"}
    # The user turn following the assistant tool_use turn must carry BOTH tool_results.
    tool_turn = fake.calls[1]["messages"][-1]
    assert tool_turn["role"] == "user"
    assert len(tool_turn["content"]) == 2
    assert {b["tool_use_id"] for b in tool_turn["content"]} == {"t1", "t2"}


def test_round_cap_forces_graceful_synthesis():
    tool_rounds = [_resp([_ToolUse(f"t{i}", "find_node", {"query": "x"})]) for i in range(map_chat_agent.MAX_ROUNDS)]
    synthesis = _resp([_Text("Best answer with what I have; I could not verify X.")])
    fake = _FakeClient(tool_rounds + [synthesis])
    result = _run(fake)
    assert result.stop_reason == "round_cap"
    assert "could not verify" in result.answer
    assert "tools" not in fake.calls[-1]


def test_token_cap_forces_synthesis():
    fake = _FakeClient([
        _resp([_ToolUse("t1", "find_node", {"query": "x"})], inp=90_000, out=5_000),
        _resp([_Text("Answering now within budget.")]),
    ])
    result = _run(fake)
    assert result.stop_reason == "token_cap"


def test_assess_grounded():
    assert map_chat_agent.assess_grounded("long answer " * 20, ["C1"]) is True
    assert map_chat_agent.assess_grounded("long answer " * 20, []) is False
    assert map_chat_agent.assess_grounded("Short, no cites.", []) is True
