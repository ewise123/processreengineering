# Converse / Ask / Propose Redesign (Batch 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the map-chat agent investigate before proposing — proposing grounded changes directly, and asking the user first (via a new `ask_user` tool) when a change would contradict the sources, isn't in the sources, or is materially ambiguous — plus refine the grounding chip, let the budget-capped synthesis turn still emit cards, and nudge op selection for edge conditions.

**Architecture:** All work is on the git worktree at `/home/ewise/projects/poet-propose`, branch `design/agent-loop-write-propose` (updates PR #46). Backend loop is `app/services/map_chat_agent.py`; the read/propose tools are `app/services/agent_tools.py` + the `PROPOSE_TOOL` schema. `ask_user` is a **terminal** tool: when the model calls it, `run_chat_agent` stops and returns a `question` in the response; the frontend renders clickable options; selecting one sends an ordinary next message and the loop resumes statelessly from history. Grounding is a per-suggestion `origin` the model sets, layered over the deterministic "cites a claim" signal.

**Tech Stack:** Python 3.12 / FastAPI / Pydantic v2 / SQLAlchemy (backend, pytest); Next.js 15 / React 19 / TypeScript / Tailwind (frontend, vitest). Anthropic SDK tool-use loop.

**Conventions:**
- Backend tests: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest <path> -v` (this worktree's DB override; see Batch 1 note).
- Frontend tests: `npx vitest run <path>` ; typecheck: `npx tsc --noEmit` ; build: `npx next build`.
- Conventional commits; never commit to `main`. Commit footers as configured for this repo.

---

## File-by-file map

**Backend (modify):**
- `backend/app/enums.py` — add `AgentRunStopReason.ASK_USER`.
- `backend/app/schemas/version_chat_suggest.py` — add `origin` to `ChatSuggestion`; add `AgentOption`/`AgentQuestion`; add `question` to `ChatSuggestResponse`.
- `backend/app/services/suggestion_ops.py` — thread `origin` through `_build_suggestion_op`.
- `backend/app/services/map_chat_agent.py` — `ASK_USER_TOOL`, `origin` in `PROPOSE_TOOL`, terminal `ask_user` handling + `AgentResult.question`, synthesis-can-propose + token accounting, `MAX_ROUNDS` 6→8, rewritten `SUGGEST_INSTRUCTIONS` (gate + ask + op-selection).
- `backend/app/api/v2/process_maps.py` — build `question` onto `ChatSuggestResponse`; message-vs-question handling.

**Frontend (modify):**
- `src/lib/types.ts` — `origin` on `ChatSuggestion`; `AgentQuestion`/`AgentOption`; `question` on `ChatSuggestResponse`.
- `src/components/canvas/suggestion-display.ts` — new `groundingChip()` helper.
- `src/components/canvas/suggestion-card.tsx` — use `groundingChip()` for chip copy.
- `src/components/canvas/question-block.tsx` — **new** component (prompt + option buttons + "Something else").
- `src/components/canvas/chat-tab.tsx` — `question` on `ChatItem`; capture from response; render `QuestionBlock`; click → `submit(label)`.

**Tests:** alongside the above (`backend/tests/test_*.py`, `src/components/canvas/*.test.ts(x)`).

---

## Task 1: Add `ASK_USER` stop reason

**Files:**
- Modify: `backend/app/enums.py:257-267`
- Test: `backend/tests/test_agent_run_model.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_agent_run_model.py`:

```python
def test_ask_user_stop_reason_exists():
    from app.enums import AgentRunStopReason
    assert AgentRunStopReason.ASK_USER.value == "ask_user"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_agent_run_model.py::test_ask_user_stop_reason_exists -v`
Expected: FAIL with `AttributeError: ASK_USER`.

- [ ] **Step 3: Add the enum value**

In `backend/app/enums.py`, inside `class AgentRunStopReason`, after `TIME_CAP = "time_cap"`:

```python
    # The loop stopped to ask the analyst a clarifying question (ask_user tool).
    ASK_USER = "ask_user"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_agent_run_model.py::test_ask_user_stop_reason_exists -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/enums.py backend/tests/test_agent_run_model.py
git commit -m "feat(agent): add ASK_USER stop reason"
```

---

## Task 2: Per-suggestion `origin` field (schema + build + tool)

Adds the model-set `origin` (`user_directed` | `ai_volunteered`) that drives the chip copy. `supported` stays deterministic (cited claims) — `origin` only matters when there are no citations.

**Files:**
- Modify: `backend/app/schemas/version_chat_suggest.py:110-121`
- Modify: `backend/app/services/suggestion_ops.py:90-127`
- Modify: `backend/app/services/map_chat_agent.py:133-168` (PROPOSE_TOOL item properties)
- Test: `backend/tests/test_suggestion_ops.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_suggestion_ops.py` (uses the file's existing `_ctx`/build helpers — mirror an existing test's context construction; a minimal ctx with `node_ref_to_id={"N1": <uuid>}` and empty other maps suffices):

```python
def test_origin_is_carried_when_valid_and_dropped_otherwise():
    from uuid import uuid4
    from types import SimpleNamespace
    from app.services.suggestion_ops import build_suggestion
    n1 = uuid4()
    ctx = SimpleNamespace(
        node_ref_to_id={"N1": n1}, edge_ref_to_id={}, lane_ref_to_id={},
        claim_ref_to_id={}, node_name_by_id={n1: "Receive"},
        lane_name_by_id={}, edge_label_by_id={},
    )
    base = {"kind": "relabel_node", "node_ref": "N1", "new_label": "x", "title": "t", "rationale": ""}
    s_user, _ = build_suggestion({**base, "origin": "user_directed"}, ctx, 0)
    s_ai, _ = build_suggestion({**base, "origin": "ai_volunteered"}, ctx, 1)
    s_bad, _ = build_suggestion({**base, "origin": "nonsense"}, ctx, 2)
    s_none, _ = build_suggestion(base, ctx, 3)
    assert s_user.origin == "user_directed"
    assert s_ai.origin == "ai_volunteered"
    assert s_bad.origin is None   # unknown value coerced to None
    assert s_none.origin is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_suggestion_ops.py::test_origin_is_carried_when_valid_and_dropped_otherwise -v`
Expected: FAIL — `ChatSuggestion` has no `origin` field / build ignores it.

- [ ] **Step 3a: Add `origin` to the schema**

In `backend/app/schemas/version_chat_suggest.py`, add to `class ChatSuggestion` (after `before_label`):

```python
    # Why this change was proposed, when it cites no source claim: the analyst
    # directly commanded it ("user_directed") vs the agent volunteered it beyond
    # the sources ("ai_volunteered"). Drives the card's grounding chip copy.
    # None when unspecified. Ignored for a change that cites a claim (that is
    # "supported" deterministically).
    origin: str | None = Field(default=None)
```

- [ ] **Step 3b: Thread `origin` through build**

In `backend/app/services/suggestion_ops.py`, inside `_build_suggestion_op`, just before the `return ChatSuggestion(` call, add:

```python
    raw_origin = raw.get("origin")
    origin = raw_origin if raw_origin in ("user_directed", "ai_volunteered") else None
```

and add `origin=origin,` to the `ChatSuggestion(...)` keyword args.

- [ ] **Step 3c: Expose `origin` in the tool schema**

In `backend/app/services/map_chat_agent.py`, in `PROPOSE_TOOL["input_schema"]["properties"]["suggestions"]["items"]["properties"]`, add after `condition_text`:

```python
                        "origin": {
                            "type": ["string", "null"],
                            "enum": ["user_directed", "ai_volunteered", None],
                            "description": (
                                "Only set when the change cites NO source claim. "
                                "'user_directed' = the analyst explicitly commanded this exact change; "
                                "'ai_volunteered' = you are suggesting it beyond what they asked and the "
                                "sources say. A change that cites a claim needs no origin."
                            ),
                        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_suggestion_ops.py::test_origin_is_carried_when_valid_and_dropped_otherwise -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/version_chat_suggest.py backend/app/services/suggestion_ops.py backend/app/services/map_chat_agent.py backend/tests/test_suggestion_ops.py
git commit -m "feat(agent): per-suggestion origin (user_directed vs ai_volunteered)"
```

---

## Task 3: `ask_user` terminal tool in the loop

`ask_user` stops the loop and returns a question; grounded proposals already accumulated in the same turn ride along.

**Files:**
- Modify: `backend/app/services/map_chat_agent.py` (add `ASK_USER_TOOL`, `AgentResult.question`, `_normalize_question`, terminal handling in `run_chat_agent`, add tool to `tools`)
- Test: `backend/tests/test_map_chat_agent.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_map_chat_agent.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py -k ask_user -v`
Expected: FAIL — no `ask_user` tool; `AgentResult` has no `question`.

- [ ] **Step 3a: Add the tool schema + AgentResult field**

In `backend/app/services/map_chat_agent.py`, after `PROPOSE_TOOL = {...}`:

```python
ASK_USER_TOOL = {
    "name": "ask_user",
    "description": (
        "Pause and ask the analyst ONE clarifying question with 2-4 options, then "
        "STOP. Use this INSTEAD of propose_changes when a change would contradict a "
        "source-backed element, is not supported by the sources, or the command is "
        "materially ambiguous. Do not also ask in prose. The analyst can always type "
        "a free-form reply, so options need not be exhaustive."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "The question to ask."},
            "options": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "description": {"type": ["string", "null"]},
                    },
                    "required": ["label"],
                },
            },
        },
        "required": ["prompt", "options"],
    },
}
```

Add `question` to `AgentResult` (after `group_summaries`):

```python
    question: dict | None = None  # {prompt, options:[{label, description?}]} when the loop asked
```

- [ ] **Step 3b: Add the normalizer**

Add near `_handle_propose`:

```python
def _normalize_question(inp: dict) -> dict:
    """Coerce a raw ask_user input into a safe {prompt, options[]} dict:
    a string prompt and up to 4 options, each with a non-empty label."""
    prompt = str(inp.get("prompt") or "").strip()
    options: list[dict] = []
    for o in (inp.get("options") or [])[:4]:
        if not isinstance(o, dict):
            continue
        label = str(o.get("label") or "").strip()
        if not label:
            continue
        desc = o.get("description")
        options.append({"label": label[:120],
                        "description": (str(desc).strip()[:300] or None) if desc else None})
    return {"prompt": prompt, "options": options}
```

- [ ] **Step 3c: Offer the tool + handle it terminally**

In `run_chat_agent`, change the tools line (currently `tools = READ_TOOLS + [PROPOSE_TOOL]`):

```python
    tools = READ_TOOLS + [PROPOSE_TOOL, ASK_USER_TOOL]
```

Inside the `for tu in tool_uses:` loop, add an `ask_user` branch BEFORE the `propose_changes` branch, and track it:

```python
        ask_input = None
        for tu in tool_uses:
            if tu.name == "ask_user":
                ask_input = _normalize_question(dict(tu.input or {}))
                trace.append({
                    "tool": "ask_user",
                    "summary": f"Asked: {ask_input['prompt'][:80]}",
                    "detail": json.dumps(ask_input)[:4000],
                })
                continue
            if tu.name == "propose_changes":
                ...  # unchanged
                continue
            ...  # unchanged read-tool dispatch
```

(Move the existing `for tu in tool_uses:` body under this, keeping the propose/read branches as-is; only add the `ask_user` branch and the `ask_input = None` initializer above the loop.)

After the `for tu` loop, BEFORE `messages = messages + [{"role": "user", "content": tool_results}]`, add:

```python
        if ask_input is not None:
            result.question = ask_input
            result.answer = _text_of(resp.content)
            result.stop_reason = AgentRunStopReason.ASK_USER.value
            break
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py -k ask_user -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_chat_agent.py backend/tests/test_map_chat_agent.py
git commit -m "feat(agent): ask_user terminal tool — stop loop, return question, keep grounded cards"
```

---

## Task 4: Surface `question` through the endpoint

**Files:**
- Modify: `backend/app/schemas/version_chat_suggest.py` (add `AgentOption`, `AgentQuestion`, `ChatSuggestResponse.question`)
- Modify: `backend/app/api/v2/process_maps.py:2061-2097` (build the question; message handling)
- Test: `backend/tests/test_agent_endpoint.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_agent_endpoint.py`:

```python
def test_ask_user_question_is_surfaced_and_persisted(db):
    from tests.test_chat_suggest import _seed
    from app.services.map_chat_agent import AgentResult
    project, version, n1, claim = _seed(db)

    def fake_agent(*, tool_ctx, skeleton_text, focus_items, history, user_message):
        return AgentResult(
            answer="This step isn't in your sources.",
            trace=[], consulted_claim_ids=[], round_count=1,
            input_tokens=10, output_tokens=5, stop_reason="ask_user",
            question={"prompt": "Add it anyway?",
                      "options": [{"label": "Add it", "description": None},
                                  {"label": "Skip it", "description": None}]},
        )

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent", fake_agent)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="add a QA step", session_id="s1"),
            db=db,
        )
    assert resp.question is not None
    assert resp.question.prompt == "Add it anyway?"
    assert [o.label for o in resp.question.options] == ["Add it", "Skip it"]
    assert resp.message == "This step isn't in your sources."  # prose shown alongside the question

    row = db.scalar(select(AgentRun).where(AgentRun.id == resp.run_id))
    assert row.stop_reason == "ask_user"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_agent_endpoint.py::test_ask_user_question_is_surfaced_and_persisted -v`
Expected: FAIL — `ChatSuggestResponse` has no `question`.

- [ ] **Step 3a: Add the response schema**

In `backend/app/schemas/version_chat_suggest.py`, before `class ChatSuggestResponse`:

```python
class AgentOption(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=300)


class AgentQuestion(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    options: list[AgentOption] = Field(default_factory=list)
```

Add to `class ChatSuggestResponse` (after `grounded`):

```python
    question: AgentQuestion | None = None
```

- [ ] **Step 3b: Build the question in the endpoint**

In `backend/app/api/v2/process_maps.py`, import the new schemas (extend the existing import block near line 119 that already pulls `ChatSuggestResponse`, `GroupSummary`): add `AgentOption`, `AgentQuestion`.

In `_run_chat_agent`, after `resolved = _resolve_mention_refs(result.answer, ctx)` and the `suggestions = result.proposals` line, build the question and adjust `message`:

```python
    question = None
    if result.question and result.question.get("prompt"):
        question = AgentQuestion(
            prompt=result.question["prompt"],
            options=[AgentOption(label=o["label"], description=o.get("description"))
                     for o in result.question.get("options", []) if o.get("label")],
        )
    # Cards alone ARE the response (suppress stray prose). But when the agent
    # asked a question, its prose explains why — always show it.
    message = resolved if (question or not suggestions) else ""
```

(Replace the existing `message = "" if suggestions else resolved` line with the block above.)

Add `question=question,` to the final `return ChatSuggestResponse(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_agent_endpoint.py::test_ask_user_question_is_surfaced_and_persisted -v`
Expected: PASS.

- [ ] **Step 5: Run the full agent/endpoint suites (regression)**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_agent_endpoint.py tests/test_map_chat_agent.py -v`
Expected: PASS (existing tests unaffected — `question` defaults to `None`).

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas/version_chat_suggest.py backend/app/api/v2/process_maps.py backend/tests/test_agent_endpoint.py
git commit -m "feat(agent): surface ask_user question on ChatSuggestResponse; show prose alongside"
```

---

## Task 5: Synthesis-can-propose + cap tuning (#13)

The budget-capped synthesis turn keeps `propose_changes` (drops read tools) so it can still emit cards; token usage is now counted; `MAX_ROUNDS` 6→8.

**Files:**
- Modify: `backend/app/services/map_chat_agent.py` (`MAX_ROUNDS`, `_graceful_synthesis`, its 3 call sites)
- Test: `backend/tests/test_map_chat_agent.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_map_chat_agent.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py -k "synthesis or max_rounds_is_eight" -v`
Expected: FAIL — synthesis has no tools; `MAX_ROUNDS == 6`.

- [ ] **Step 3a: Bump the round cap**

In `backend/app/services/map_chat_agent.py`: `MAX_ROUNDS = 8`.

- [ ] **Step 3b: Add a synthesis prompt constant**

Near the other prompt constants:

```python
SYNTHESIS_PROMPT = (
    "You have reached your investigation budget. Using ONLY what you have already "
    "verified from the sources, call propose_changes for the grounded changes you "
    "were preparing (omit anything you could not verify — do not describe it). Then "
    "answer briefly, stating plainly what you could not verify."
)
```

- [ ] **Step 3c: Rewrite `_graceful_synthesis`**

Replace the whole function with one that offers `propose_changes`, accumulates proposals, and returns token usage:

```python
def _graceful_synthesis(client, system: str, messages: list[dict], *, tool_ctx, proposals: list, raw_groups: list) -> tuple[str, int, int]:
    """Final turn with ONLY propose_changes (no read tools): emit any grounded
    changes gathered so far, then answer with what's verified. Returns
    (answer_text, input_tokens, output_tokens)."""
    messages = messages + [{"role": "user", "content": SYNTHESIS_PROMPT}]
    resp = client.messages.create(
        model=AGENT_MODEL, max_tokens=MAX_TOKENS, system=system,
        tools=[PROPOSE_TOOL], messages=messages, timeout=90.0,
    )
    for b in resp.content:
        if getattr(b, "type", None) == "tool_use" and b.name == "propose_changes":
            _handle_propose(dict(b.input or {}), tool_ctx.mapctx, proposals, raw_groups)
    in_tok = getattr(resp.usage, "input_tokens", 0) or 0
    out_tok = getattr(resp.usage, "output_tokens", 0) or 0
    return (_text_of(resp.content) or "(no response)", in_tok, out_tok)
```

- [ ] **Step 3d: Update the 3 call sites**

Each of the three `result.answer = _graceful_synthesis(client, system, messages)` sites (token-cap, time-cap, and the `else` round-cap) becomes:

```python
            ans, syn_in, syn_out = _graceful_synthesis(
                client, system, messages, tool_ctx=tool_ctx, proposals=proposals, raw_groups=raw_groups)
            result.answer = ans
            in_tokens += syn_in
            out_tokens += syn_out
            result.stop_reason = AgentRunStopReason.TOKEN_CAP.value  # (TIME_CAP / ROUND_CAP respectively)
```

For the `else:` branch (round cap), it is not indented under the `if`, so match its indentation and set `AgentRunStopReason.ROUND_CAP.value`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py -v`
Expected: PASS. Note `test_proposals_survive_round_cap` and `test_round_cap_forces_graceful_synthesis` still pass — they use `MAX_ROUNDS` symbolically, so the 6→8 change is absorbed; the graceful-synthesis text response has no tool_use blocks, so no extra proposals are added there.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/map_chat_agent.py backend/tests/test_map_chat_agent.py
git commit -m "feat(agent): synthesis turn keeps propose_changes + count its tokens; MAX_ROUNDS 6->8"
```

---

## Task 6: Rewrite `SUGGEST_INSTRUCTIONS` — grounding gate, ask policy, op-selection (#1, #8)

Pure prompt work. The loop mechanics (Tasks 3–5) are already in place; this teaches the model the policy.

**Files:**
- Modify: `backend/app/services/map_chat_agent.py:61-118` (`SUGGEST_INSTRUCTIONS`)
- Test: `backend/tests/test_map_chat_agent.py`

- [ ] **Step 1: Write the failing tests (prompt-contract presence)**

Add to `backend/tests/test_map_chat_agent.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py::test_suggest_instructions_cover_gate_and_ask_and_op_selection -v`
Expected: FAIL — current instructions lack the gate/ask/origin phrasing.

- [ ] **Step 3: Rewrite `SUGGEST_INSTRUCTIONS`**

Replace the `SUGGEST_INSTRUCTIONS = """\ ... """` block with:

```python
SUGGEST_INSTRUCTIONS = """\
You may propose concrete edits to the map via `propose_changes`, or ask the
analyst a question via `ask_user`. Which one depends on how the requested change
relates to the sources.

THE GROUNDING GATE — before proposing ANY change, establish how it relates to the
sources by looking up the relevant claims/steps with your read tools:
- SUPPORTED (a source claim backs the change): call `propose_changes` right away
  and cite the claim(s) in `cited_claim_refs`. A grounded proposal beats a fast one.
- CONTRADICTS a source-backed element (the sources say otherwise): do NOT propose.
  State the conflict in one or two sentences of prose, then call `ask_user`
  ("proceed or revise?"). Only propose after the analyst confirms.
- NOT IN YOUR SOURCES (you looked and found no support, and no contradiction):
  do NOT propose yet. Note briefly that it isn't in the sources, then call
  `ask_user` ("I don't see this in your sources — add it anyway?"). Propose only
  after they confirm.
- MATERIALLY AMBIGUOUS (the command has readings that differ in a way that
  matters): call `ask_user` to disambiguate before proposing. Keep this bar HIGH —
  if one reading is clearly most likely, just take it.

The gate applies to every op that adds, removes, or alters a process assertion —
add/remove steps & edges, set_edge_condition, describe_node, change_node_type,
move_to_lane (who performs a step), reroute_edge (the flow), add_lane/rename_lane
(an actor), and meaning-changing relabels. The ONLY thing that skips the gate is a
reword that preserves meaning (a typo or clarity fix) — propose that directly.

ASK ONCE PER DECISION, NEVER ONCE PER OP. If a single logical change spans several
ops (e.g. add a lane and move three steps into it), ask ONE question about the
whole decision. Group those ops with a shared `group`. The analyst can always type
a free-form reply, so your options need not be exhaustive.

When you DO propose (no gate blocked it):
- Your prose message MUST be empty or a single short clause of framing. Do NOT
  restate the proposed content (label, description, new step) in prose — the card
  shows it. NEVER ask whether to apply/proceed/confirm — the card's Apply/Dismiss
  is the only confirmation.
- Set `origin` ONLY on a change that cites no claim: `user_directed` if the analyst
  explicitly commanded this exact change, `ai_volunteered` if you are suggesting it
  beyond what they asked. A change that cites a claim needs no origin.

Rules for suggestions:
- One suggestion per discrete change. Give each a short imperative `title`.
- Reference EXISTING objects by their short refs (nodes N1/N2, edges E1/E2, lanes
  L1/L2). Reference NEW objects by temp ids (tmp:1, tmp:2).
- For a NEW step (add_node) put its label in `new_label` (NOT `name`); every
  add_node needs a `temp_id`, and any add_edge wiring it in must reference that
  temp_id.
- For a NEW lane (add_lane) put its name in `name` with a `temp_id`; any op placing
  a step in it sets `lane_ref` to that temp_id.
- CONDITIONS vs LABELS: to set the GUARD on a gateway's outgoing flow (e.g.
  "amount < $10,000", "if rejected"), use `set_edge_condition` with the guard in
  `condition_text` — NOT `relabel_edge`. `relabel_edge` only changes the flow's
  visible display label. "Set/add the condition" always means set_edge_condition.
- Emit a NEW object and every op referencing its temp id in the SAME
  propose_changes call — temp ids do not carry across calls.
- In `title`/`rationale`, wrap a referenced step/claim in double brackets ([[N3]],
  [[C1]]); never a bare ref, never repeat the name after the ref.
- Group related changes with a shared `group`; add one entry per group to the
  top-level `groups` array ({"id": "...", "summary": "..."}).
- Justify each with `rationale` and (when supported) `cited_claim_refs`.
"""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py::test_suggest_instructions_cover_gate_and_ask_and_op_selection -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite (regression)**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest -q`
Expected: PASS (note `test_suggest_instructions_are_in_the_system_prompt` asserts "One suggestion per discrete change" — retained above).

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/map_chat_agent.py backend/tests/test_map_chat_agent.py
git commit -m "feat(agent): grounding-gate + ask_user + condition op-selection instructions (#1,#8)"
```

---

## Task 7: Frontend types

**Files:**
- Modify: `src/lib/types.ts:416-453`
- Test: none (type-only; verified by `tsc` after later tasks). Add a trivial compile assertion via the chip test in Task 8.

- [ ] **Step 1: Add `origin` to `ChatSuggestion`**

In `src/lib/types.ts`, in `interface ChatSuggestion`, after `before_label`:

```typescript
  /** Why the change was proposed when it cites no source claim: "user_directed"
   * (you commanded it) vs "ai_volunteered" (the agent suggested it beyond the
   * sources). Drives the grounding chip copy. Undefined/null when unspecified. */
  origin?: "user_directed" | "ai_volunteered" | null;
```

- [ ] **Step 2: Add the question types + response field**

Before `interface ChatSuggestResponse`:

```typescript
export interface AgentOption {
  label: string;
  description?: string | null;
}

export interface AgentQuestion {
  prompt: string;
  options: AgentOption[];
}
```

In `interface ChatSuggestResponse`, after `grounded?: boolean;`:

```typescript
  /** Present when the agent stopped to ask a clarifying question (ask_user). */
  question?: AgentQuestion | null;
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no usages yet).

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(chat): types for suggestion origin + agent question"
```

---

## Task 8: Grounding chip refinement (#2)

Replace the blanket "Not grounded in your sources" chip with origin-aware copy; `supported` (cites a claim) shows nothing.

**Files:**
- Modify: `src/components/canvas/suggestion-display.ts:133-138` (add `groundingChip`)
- Modify: `src/components/canvas/suggestion-card.tsx:9-15, 225-232`
- Test: `src/components/canvas/suggestion-display.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/components/canvas/suggestion-display.test.ts` (extend the import from `./suggestion-display` to include `groundingChip`):

```typescript
describe("groundingChip", () => {
  const s = (over: Partial<ChatSuggestion>): ChatSuggestion =>
    ({ id: "x", title: "t", op: op({ kind: "add_node" }), affected_refs: [],
       rationale: "", cited_claim_ids: [], ...over }) as ChatSuggestion;

  it("returns null when the change cites a claim (supported)", () => {
    expect(groundingChip(s({ cited_claim_ids: ["c1" as never], origin: "ai_volunteered" }))).toBeNull();
  });
  it("labels a user-directed uncited change 'Not in your sources'", () => {
    expect(groundingChip(s({ origin: "user_directed" }))?.label).toBe("Not in your sources");
  });
  it("labels an AI-volunteered uncited change as an AI suggestion", () => {
    expect(groundingChip(s({ origin: "ai_volunteered" }))?.label).toBe("AI suggestion · not in your sources");
  });
  it("defaults an uncited change with no origin to 'Not in your sources'", () => {
    expect(groundingChip(s({}))?.label).toBe("Not in your sources");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/canvas/suggestion-display.test.ts`
Expected: FAIL — `groundingChip` not exported.

- [ ] **Step 3a: Add the helper**

In `src/components/canvas/suggestion-display.ts`, after `isProposalGrounded`:

```typescript
export type GroundingChip = { label: string } | null;

/** The grounding chip to show on a proposed change, or null for none.
 * A change that cites a claim is "supported" (deterministic) → no chip. An
 * uncited change is flagged regardless of who initiated it; the copy differs by
 * origin: the agent volunteered it vs the user directly asked for it. */
export function groundingChip(
  s: Pick<ChatSuggestion, "cited_claim_ids" | "origin">,
): GroundingChip {
  if ((s.cited_claim_ids?.length ?? 0) > 0) return null;
  if (s.origin === "ai_volunteered") return { label: "AI suggestion · not in your sources" };
  return { label: "Not in your sources" };
}
```

- [ ] **Step 3b: Use it in the card**

In `src/components/canvas/suggestion-card.tsx`, change the import from `./suggestion-display` — replace `isProposalGrounded` with `groundingChip` (keep the others).

Replace the chip block (lines ~225-232):

```tsx
                {(() => {
                  const chip = groundingChip(s);
                  return chip ? (
                    <span
                      className="shrink-0 rounded px-1 py-px text-[8.5px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700"
                      title="This change is not backed by your uploaded sources."
                    >
                      {chip.label}
                    </span>
                  ) : null;
                })()}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/components/canvas/suggestion-display.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-display.ts src/components/canvas/suggestion-card.tsx src/components/canvas/suggestion-display.test.ts
git commit -m "feat(chat): origin-aware grounding chip; supported changes show none (#2)"
```

---

## Task 9: `QuestionBlock` component (#11 UI)

Renders the agent's clarifying question: prompt + option buttons + a trailing "Something else — I'll explain" affordance.

**Files:**
- Create: `src/components/canvas/question-block.tsx`
- Test: `src/components/canvas/question-block.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/question-block.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { QuestionBlock } from "./question-block";

const q = {
  prompt: "I don't see a QA step in your sources — add it anyway?",
  options: [
    { label: "Add it anyway", description: "Propose it as not-in-sources" },
    { label: "Skip it" },
  ],
};

describe("QuestionBlock", () => {
  it("renders the prompt and every option label", () => {
    render(<QuestionBlock question={q} onChoose={() => {}} />);
    expect(screen.getByText(/add it anyway\?/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add it anyway/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Skip it/ })).toBeTruthy();
    // free-form affordance is always present
    expect(screen.getByRole("button", { name: /Something else/i })).toBeTruthy();
  });

  it("calls onChoose with the option label when clicked", () => {
    const onChoose = vi.fn();
    render(<QuestionBlock question={q} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Add it anyway/ }));
    expect(onChoose).toHaveBeenCalledWith("Add it anyway");
  });

  it("calls onChoose with empty string for 'Something else' (focus the input)", () => {
    const onChoose = vi.fn();
    render(<QuestionBlock question={q} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Something else/i }));
    expect(onChoose).toHaveBeenCalledWith("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/canvas/question-block.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/components/canvas/question-block.tsx`:

```tsx
"use client";

import type { AgentQuestion } from "@/lib/types";

/** The agent's clarifying question, rendered under an assistant message.
 * Clicking an option calls `onChoose(label)`, which the parent sends as the next
 * message. "Something else" calls `onChoose("")` so the parent can just focus the
 * composer — the normal input is always available for a free-form reply. */
export function QuestionBlock({
  question,
  onChoose,
  disabled,
}: {
  question: AgentQuestion;
  onChoose: (label: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2">
      <p className="text-[11px] font-medium leading-snug text-slate-800">{question.prompt}</p>
      <div className="mt-1.5 flex flex-col gap-1">
        {question.options.map((o) => (
          <button
            key={o.label}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(o.label)}
            className="rounded border border-indigo-200 bg-white px-2 py-1 text-left text-[11px] font-medium text-indigo-800 hover:bg-indigo-100 disabled:opacity-50"
          >
            {o.label}
            {o.description ? (
              <span className="block text-[10px] font-normal text-slate-500">{o.description}</span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChoose("")}
          className="rounded px-2 py-1 text-left text-[11px] text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          Something else — I'll explain
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/components/canvas/question-block.test.tsx && npx tsc --noEmit`
Expected: PASS. (If `@testing-library/react` is not already a dev dep, verify with `npx vitest run src/components/canvas/chat-history.test.ts` first — the existing suite indicates its availability; if a render-based test isn't supported, fall back to unit-testing a pure `questionBlockModel(question)` helper that returns the labels array plus the trailing affordance, and keep rendering logic thin.)

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/question-block.tsx src/components/canvas/question-block.test.tsx
git commit -m "feat(chat): QuestionBlock — agent clarifying question with options + free-form"
```

---

## Task 10: Wire the question into chat-tab

Capture `data.question` onto the assistant message, render `QuestionBlock`, and route a choice through the existing `submit`.

**Files:**
- Modify: `src/components/canvas/chat-tab.tsx:35-48` (ChatItem), `:204-223` (onSuccess), `:432-457` (render), imports
- Test: `src/components/canvas/chat-history.test.ts` (or a small new `chat-question.test.ts`)

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/chat-question.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ChatSuggestResponse } from "@/lib/types";

// The onSuccess handler carries the response's question onto the assistant
// ChatItem. This helper mirrors that mapping and is asserted here so the wiring
// has an isolated contract test.
import { assistantItemFromResponse } from "./chat-tab-helpers";

describe("assistantItemFromResponse", () => {
  it("carries the question when present", () => {
    const data = {
      message: "Not in your sources.", suggestions: [], mention_sources: [],
      group_summaries: [], activity_trace: [], grounded: false,
      question: { prompt: "Add anyway?", options: [{ label: "Yes" }, { label: "No" }] },
    } as unknown as ChatSuggestResponse;
    const item = assistantItemFromResponse(data);
    expect(item.question?.prompt).toBe("Add anyway?");
    expect(item.role).toBe("assistant");
  });

  it("leaves question undefined when absent", () => {
    const data = {
      message: "ok", suggestions: [], mention_sources: [], group_summaries: [],
      activity_trace: [], grounded: true,
    } as unknown as ChatSuggestResponse;
    expect(assistantItemFromResponse(data).question).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/canvas/chat-question.test.ts`
Expected: FAIL — `./chat-tab-helpers` / `assistantItemFromResponse` not found.

- [ ] **Step 3a: Extract the mapping into a helper**

Create `src/components/canvas/chat-tab-helpers.ts`:

```typescript
import type { ChatSuggestResponse } from "@/lib/types";
import type { ChatItem } from "./chat-tab";

/** Build the assistant ChatItem from a chat-suggest response (the fields that
 * live on the message and survive reload). Selection/context fields are added by
 * the caller. */
export function assistantItemFromResponse(data: ChatSuggestResponse): ChatItem {
  return {
    role: "assistant",
    content: data.message,
    sources: data.mention_sources,
    suggestions: data.suggestions.length ? data.suggestions : undefined,
    suggestionStatus: {},
    groupSummaries: data.group_summaries.length ? data.group_summaries : undefined,
    activityTrace: data.activity_trace ?? [],
    grounded: data.grounded,
    runId: data.run_id ?? null,
    question: data.question ?? undefined,
  };
}
```

Note: `ChatItem` is exported from `chat-tab.tsx` (line 35). If importing it into a helper creates a cycle at build, move the `ChatItem` type into `chat-tab-helpers.ts` and re-export from `chat-tab.tsx`; otherwise the type-only import is fine.

- [ ] **Step 3b: Add `question` to `ChatItem`**

In `src/components/canvas/chat-tab.tsx`, add to the `ChatItem` type (after `runId`):

```typescript
  /** Present when this assistant turn asked a clarifying question (ask_user). */
  question?: AgentQuestion;
```

Add `AgentQuestion` to the `@/lib/types` import.

- [ ] **Step 3c: Use the helper in onSuccess**

In `chat-tab.tsx` `onSuccess`, replace the inline assistant object (the `{ role: "assistant", ... }` literal within `next`) with `assistantItemFromResponse(data)`. Import `assistantItemFromResponse` from `./chat-tab-helpers`.

- [ ] **Step 3d: Render the QuestionBlock**

Import `QuestionBlock` from `./question-block`. In the assistant-message render block, after the `SuggestionList` and before/after the `ActivityTrace` (place it after `SuggestionList`, before `ActivityTrace` so the trace stays last), add:

```tsx
                {m.role === "assistant" && m.question && (
                  <QuestionBlock
                    question={m.question}
                    disabled={ask.isPending}
                    onChoose={(label) => {
                      if (label) submit(label);
                      // empty label = "Something else": leave the composer for a
                      // free-form reply (the input is always available).
                    }}
                  />
                )}
```

- [ ] **Step 4: Run test + typecheck + build**

Run: `npx vitest run src/components/canvas/chat-question.test.ts && npx tsc --noEmit && npx next build`
Expected: PASS / clean build.

- [ ] **Step 5: Run the full frontend suite (regression)**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/chat-tab.tsx src/components/canvas/chat-tab-helpers.ts src/components/canvas/chat-question.test.ts
git commit -m "feat(chat): render agent clarifying question; a choice sends the next message (#11)"
```

---

## Task 11: Full-suite gate + live verification

- [ ] **Step 1: Backend full suite**

Run: `cd backend && POET_TEST_DB=poet_test_propose python -m pytest -q`
Expected: all green.

- [ ] **Step 2: Frontend full suite + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit && npx next build`
Expected: all green, clean build.

- [ ] **Step 3: Live verification on the isolated instance**

Relaunch per the run-poet-local recipe (worktree backend `:8001` on the `poet_propose` clone; frontend `:3001`). Walk these cases and confirm behavior + `agent_runs`:
- Clearly-supported command (e.g. rename a step to match an interview quote) → **direct proposal**, no chip, cites a claim.
- Command that contradicts a source → **ask_user** (prose states the conflict), no card until confirmed.
- Command with no source support (e.g. "add a QA review step") → **ask_user** ("not in your sources — add anyway?"); on "add anyway" → card with **"Not in your sources"** chip.
- Ambiguous command → **ask_user** to disambiguate.
- "Set the condition 'amount < $10,000'" → **`set_edge_condition`** (guard rendered on the edge), not `relabel_edge`.
- "Make all the changes we discussed" (change-heavy) → cards still emitted even if the round cap is hit (synthesis-can-propose).

- [ ] **Step 4: Verification note**

Append a short outcome note to `docs/superpowers/notes/2026-07-08-write-propose-test-findings.md` (Batch 2 outcome section) and commit.

- [ ] **Step 5: Push to update PR #46**

```bash
git push
```
(Do NOT merge. `/autofix-pr` on #46 to ride CodeRabbit's re-scan, per the repo convention, after the user's OK.)

---

## Notes for the implementer

- **Do not `git checkout` in the main repo dir** — a parallel chat works on `feat/provenance-v2-schema` there. All work is in the worktree `/home/ewise/projects/poet-propose`.
- **Backend pytest MUST set `POET_TEST_DB=poet_test_propose`** in this worktree (the shared `poet_test` is stamped at the other branch's prov_v2 schema).
- The `ask_user` resume is **stateless**: after the user answers, the next `chat_suggest` call rebuilds history from stored `ChatItem`s. A future prompt-hardening (not in this batch) may add an explicit "if you already asked and they answered, honor it — do not re-ask" line; the current instructions already forbid asking to confirm an apply, and the answer + prior prose sit in history. Watch for re-ask loops during live verification; if observed, add that line to `AGENT_INSTRUCTIONS`.
