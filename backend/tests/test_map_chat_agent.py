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
        focus_items=[], history=[], user_message="how are invoices approved?",
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


def test_selection_is_injected_into_the_user_turn():
    # A selection must land in the user's OWN message (not only the system prompt)
    # so the model reliably resolves deictic "this" and can't claim it can't see it.
    fake = _FakeClient([_resp([_Text("These steps have problems. [[C1]]")])])
    _run(fake, focus_items=[{"ref": "N4", "label": "Approve invoice"}],
         user_message="this looks really wrong")
    sent = fake.calls[0]["messages"][-1]["content"]
    assert "SELECTED" in sent
    assert "N4" in sent and "Approve invoice" in sent
    assert "this looks really wrong" in sent


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
    # The synthesis turn drops the read tools but keeps propose_changes so a
    # budget-capped, change-heavy request can still emit cards.
    assert [t["name"] for t in fake.calls[-1]["tools"]] == ["propose_changes"]


def test_wall_clock_budget_forces_synthesis():
    # Round 1 asks for a tool; the wall-clock deadline is exceeded before round 2,
    # forcing a graceful-synthesis turn with stop_reason time_cap.
    fake = _FakeClient([
        _resp([_ToolUse("t1", "find_node", {"query": "x"})]),
        _resp([_Text("Out of time — answering with what I have.")]),
    ])
    mono = iter([1000.0, 1000.0 + map_chat_agent.MAX_WALL_SECONDS + 1])
    with patch.object(map_chat_agent.time, "monotonic", lambda: next(mono, 9e9)):
        result = _run(fake)
    assert result.stop_reason == "time_cap"


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


def _ctx_for_agent():
    from uuid import uuid4
    n1 = uuid4()
    return SimpleNamespace(
        node_ref_to_id={"N1": n1}, edge_ref_to_id={}, lane_ref_to_id={},
        claim_ref_to_id={}, node_name_by_id={n1: "Receive"}, lane_name_by_id={}, edge_label_by_id={},
    )


def _run_with_ctx(fake, ctx, **over):
    from app.services import suggestion_ops
    kwargs = dict(skeleton_text="NODES:\n  N1 [task]: Receive Invoice",
                  focus_items=[], history=[], user_message="add a step")
    kwargs.update(over)
    def fake_dispatch(tool_ctx, *, name, args):
        return ({"ok": True}, f"ran {name}", set())
    with patch.object(map_chat_agent, "_get_client", return_value=fake), \
         patch.object(map_chat_agent, "dispatch_tool", fake_dispatch), \
         patch.object(map_chat_agent, "validate_proposal_batch",
                      lambda ops, c, *, start_index: suggestion_ops.validate_proposal_batch(ops, ctx, start_index=start_index)):
        return map_chat_agent.run_chat_agent(tool_ctx=SimpleNamespace(mapctx=ctx), **kwargs)


def test_propose_changes_accumulates_accepted_proposals():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([_ToolUse("t1", "propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice", "title": "Rename", "rationale": ""}]})]),
        _resp([_Text("Proposed the rename.")]),
    ])
    result = _run_with_ctx(fake, ctx)
    assert result.stop_reason == "normal"
    assert len(result.proposals) == 1
    assert result.proposals[0].op.kind.value == "relabel_node"


def test_propose_rejected_op_is_returned_to_model_for_self_correction():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([_ToolUse("t1", "propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N9", "new_label": "x", "title": "t", "rationale": ""}]})]),
        _resp([_ToolUse("t2", "propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "x", "title": "t", "rationale": ""}]})]),
        _resp([_Text("Fixed and proposed.")]),
    ])
    result = _run_with_ctx(fake, ctx)
    round1_result = fake.calls[1]["messages"][-1]["content"][0]["content"]
    assert "N9" in round1_result and "reject" in round1_result.lower()
    assert len(result.proposals) == 1
    assert result.proposals[0].op.node_ref == str(ctx.node_ref_to_id["N1"])


def test_ops_per_run_cap_truncates_and_notes():
    ctx = _ctx_for_agent()
    many = [{"kind": "describe_node", "node_ref": "N1", "description": f"d{i}", "title": "t", "rationale": ""}
            for i in range(map_chat_agent.MAX_PROPOSED_OPS + 5)]
    fake = _FakeClient([
        _resp([_ToolUse("t1", "propose_changes", {"suggestions": many})]),
        _resp([_Text("done")]),
    ])
    result = _run_with_ctx(fake, ctx)
    assert len(result.proposals) == map_chat_agent.MAX_PROPOSED_OPS
    assert any("cap" in t["summary"].lower() or "over cap" in t["summary"].lower() for t in result.trace)


def test_suggest_instructions_are_in_the_system_prompt():
    ctx = _ctx_for_agent()
    fake = _FakeClient([_resp([_Text("ok")])])
    _run_with_ctx(fake, ctx)
    system = fake.calls[0]["system"]
    assert "propose_changes" in system  # the propose contract is present
    # a distinctive phrase from SUGGEST_INSTRUCTIONS:
    assert "One suggestion per discrete change" in system


def test_suggest_instructions_cover_gate_and_ask_and_op_selection():
    ctx = _ctx_for_agent()
    fake = _FakeClient([_resp([_Text("ok")])])
    _run_with_ctx(fake, ctx)
    system = fake.calls[0]["system"]
    # grounding gate
    assert "ask_user" in system
    assert "contradict" in system.lower()
    assert "not in your sources" in system.lower() or "no support" in system.lower()
    # ask once per decision, not per op (anti-nag)
    assert "per op" in system.lower() or "once per" in system.lower()
    # op-selection: set_edge_condition guard vs relabel_edge label
    assert "set_edge_condition" in system and "relabel_edge" in system
    assert "guard" in system.lower()
    # origin guidance
    assert "user_directed" in system and "ai_volunteered" in system


def test_propose_tool_schema_exposes_condition_text():
    # Regression: set_edge_condition requires condition_text (see SuggestionOp /
    # _REQUIRED_BY_KIND), but the tool schema the model sees historically omitted
    # it — the agent could never emit a valid set_edge_condition op.
    props = map_chat_agent.PROPOSE_TOOL["input_schema"]["properties"]["suggestions"]["items"]["properties"]
    assert "condition_text" in props
    assert props["condition_text"]["type"] == ["string", "null"]


def test_propose_tool_schema_exposes_every_suggestion_op_field():
    # Every field SuggestionOp accepts (besides `kind`, which is handled
    # separately as an enum) must appear in the tool schema the model sees, or
    # the agent has no way to populate it.
    from app.schemas.version_chat_suggest import SuggestionOp
    schema_props = set(map_chat_agent.PROPOSE_TOOL["input_schema"]["properties"]["suggestions"]["items"]["properties"])
    op_fields = set(SuggestionOp.model_fields) - {"kind"}
    missing = op_fields - schema_props
    assert not missing, f"SuggestionOp fields missing from PROPOSE_TOOL schema: {missing}"


def test_accepted_verdict_carries_op_index():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([_ToolUse("t1", "propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice", "title": "Rename", "rationale": ""}]})]),
        _resp([_Text("done")]),
    ])
    _run_with_ctx(fake, ctx)
    # The tool_result JSON sent back for the propose call carries accepted[0].index == 0.
    import json as _json
    propose_result = _json.loads(fake.calls[1]["messages"][-1]["content"][0]["content"])
    assert propose_result["accepted"][0]["index"] == 0


def test_ask_user_stops_loop_and_returns_question():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([
            _Text("That step isn't in your sources."),
            _ToolUse("a1", "ask_user", {"prompt": "Add it anyway?",
                     "options": [{"label": "Add it"}, {"label": "Skip it"}]}),
        ]),
    ])
    result = _run_with_ctx(fake, ctx, user_message="add a QA step")
    assert result.stop_reason == "ask_user"
    assert result.question["prompt"] == "Add it anyway?"
    assert [o["label"] for o in result.question["options"]] == ["Add it", "Skip it"]
    assert "isn't in your sources" in result.answer


def test_ask_user_carries_accumulated_proposals():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([
            _ToolUse("p1", "propose_changes", {"suggestions": [
                {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice",
                 "title": "Rename", "rationale": ""}]}),
            _ToolUse("a1", "ask_user", {"prompt": "Also add QA?",
                     "options": [{"label": "Yes"}, {"label": "No"}]}),
        ]),
    ])
    result = _run_with_ctx(fake, ctx)
    assert result.stop_reason == "ask_user"
    assert result.question is not None
    assert len(result.proposals) == 1


def test_ask_user_tool_is_offered():
    ctx = _ctx_for_agent()
    fake = _FakeClient([_resp([_Text("ok")])])
    _run_with_ctx(fake, ctx)
    tool_names = {t["name"] for t in fake.calls[0]["tools"]}
    assert "ask_user" in tool_names


def test_normalize_question_falls_back_on_blank_prompt():
    q = map_chat_agent._normalize_question({"prompt": "  ", "options": []})
    assert q["prompt"]  # non-empty fallback
    assert q["options"] == []


def test_normalize_question_truncates_long_prompt():
    q = map_chat_agent._normalize_question({"prompt": "x" * 5000, "options": []})
    assert len(q["prompt"]) == 2000


def test_proposals_survive_round_cap():
    ctx = _ctx_for_agent()
    # Round 1 proposes a valid op; then the model keeps calling tools until the
    # round cap forces graceful synthesis — the accepted proposal must still return.
    # The loop runs exactly MAX_ROUNDS iterations total, so round 1 (propose) plus
    # MAX_ROUNDS - 1 more tool-use rounds fill the loop; the final response is the
    # graceful-synthesis turn (mirrors test_round_cap_forces_graceful_synthesis's count).
    rounds = [_resp([_ToolUse("t1", "propose_changes", {"suggestions": [
        {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice", "title": "Rename", "rationale": ""}]})])]
    rounds += [_resp([_ToolUse(f"t{i}", "find_node", {"query": "x"})]) for i in range(map_chat_agent.MAX_ROUNDS - 1)]
    rounds += [_resp([_Text("Answered with what I have.")])]  # graceful synthesis turn
    fake = _FakeClient(rounds)
    result = _run_with_ctx(fake, ctx)
    assert result.stop_reason == "round_cap"
    assert len(result.proposals) == 1  # the round-1 proposal survived the cap


def test_synthesis_can_still_propose():
    ctx = _ctx_for_agent()
    rounds = [_resp([_ToolUse(f"t{i}", "find_node", {"query": "x"})])
              for i in range(map_chat_agent.MAX_ROUNDS)]
    rounds += [_resp([
        _ToolUse("p1", "propose_changes", {"suggestions": [
            {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice",
             "title": "Rename", "rationale": ""}]}),
        _Text("Proposed what I could verify."),
    ])]
    fake = _FakeClient(rounds)
    result = _run_with_ctx(fake, ctx)
    assert result.stop_reason == "round_cap"
    assert len(result.proposals) == 1


def test_synthesis_turn_offers_only_propose_tool():
    ctx = _ctx_for_agent()
    rounds = [_resp([_ToolUse(f"t{i}", "find_node", {"query": "x"})])
              for i in range(map_chat_agent.MAX_ROUNDS)]
    rounds += [_resp([_Text("done")])]
    fake = _FakeClient(rounds)
    _run_with_ctx(fake, ctx)
    tool_names = [t["name"] for t in fake.calls[-1]["tools"]]
    assert tool_names == ["propose_changes"]


def test_max_rounds_is_eight():
    assert map_chat_agent.MAX_ROUNDS == 8
