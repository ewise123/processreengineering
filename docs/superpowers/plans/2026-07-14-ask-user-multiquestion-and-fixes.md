# ask_user Multi-Question Redesign + Fixes (Batch 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Redesign the clarifying-question UI (multiple questions per turn, per-question lock, custom text answers, explicit "Send answers", ref hyperlinks) and land the remaining browser-pass + CodeRabbit fixes on `design/agent-loop-write-propose` (PR #46). Merge stays held.

**Context:** Batch 2 shipped a single terminal `ask_user` question. Browser testing surfaced: refs render as raw `[[N24]]`/`N7` instead of links; the free-form affordance should be a text input (and duplicates a model-provided option); options re-enable after answering; and the agent should be able to ask several questions answered together before anything sends. Plus prompt-variance (insertions left dangling) and CodeRabbit's `_graceful_synthesis` trace gap.

**Design decisions (locked with the user 2026-07-14):**
- Multi-question flow = **answer all → explicit "Send answers"**. The agent may ask 1–N questions in one turn; each renders with its options plus a text input for a custom answer; answering a question **locks** it (no re-select); when every question is answered a "Send answers" button appears; clicking it composes all answers into ONE next message and sends. Single-question case: same flow, one question, then Send.
- Stateless resume unchanged: the composed message **restates each question + its answer** so the model has context (its question tool-calls aren't in rebuilt history).
- Delete-requires-a-reason is a **separate follow-up**, NOT in this batch (tracked in the findings doc).
- `ai_applied` client-trust (CodeRabbit) stays deferred as **#16** (needs auth/prov-v2); reply on the PR.

**Tech stack / conventions:** same as Batch 2. Backend pytest `POET_TEST_DB=poet_test_propose`; frontend `npx vitest run` (node env — test PURE helpers, not React rendering) / `npx tsc --noEmit` / `npx next build`. Work in the worktree `/home/ewise/projects/poet-propose`; never `git checkout` in the main dir.

---

## Data flow (the redesign)

1. **Loop** (`map_chat_agent.run_chat_agent`): the terminating turn may contain several `ask_user` tool_use blocks. Collect them ALL into `result.questions: list[dict]` (replacing the singular `question`). Terminal as before.
2. **Endpoint** (`_run_chat_agent`): build `ChatSuggestResponse.questions: list[AgentQuestion]`, running each question's `prompt` and every option `label` through `_resolve_mention_refs(...)` so `[[N7]]` → `[[node:uuid]]` (renderable links). Prose alongside shown when questions present (unchanged rule, `questions` in place of `question`).
3. **Frontend**: `assistantItemFromResponse` carries `questions` onto the `ChatItem`. A `QuestionSet` component renders them; on Submit it composes `composeAnswers(questions, answers)` and calls `submit(text)`, then marks the message answered (persisted) so it locks across reloads.

---

## File map

**Backend (modify):** `services/map_chat_agent.py` (collect questions list; thread trace into synthesis; prompt nudges), `api/v2/process_maps.py` (`questions` + mention resolution), `schemas/version_chat_suggest.py` (`ChatSuggestResponse.questions`).
**Frontend (modify):** `lib/types.ts` (`questions`), `components/canvas/chat-tab.tsx` (`ChatItem.questions`, render `QuestionSet`, mark-answered), `components/canvas/chat-tab-helpers.ts` (`questions`; `composeAnswers`/`allAnswered` helpers), `components/canvas/question-block.tsx` → rework into `QuestionSet`.
**Docs (modify):** the two Batch-1 doc nits.

---

## Task 1: Backend — multiple questions per turn + endpoint `questions[]` + mention resolution

**Files:** `backend/app/services/map_chat_agent.py`, `backend/app/api/v2/process_maps.py`, `backend/app/schemas/version_chat_suggest.py`; tests `backend/tests/test_map_chat_agent.py`, `backend/tests/test_agent_endpoint.py`.

- [ ] **Step 1: Failing tests.**

`test_map_chat_agent.py`:
```python
def test_multiple_ask_user_calls_collected_as_questions():
    ctx = _ctx_for_agent()
    fake = _FakeClient([
        _resp([
            _ToolUse("a1", "ask_user", {"prompt": "Which lane?", "options": [{"label": "Finance"}]}),
            _ToolUse("a2", "ask_user", {"prompt": "Before or after N1?", "options": [{"label": "After"}]}),
        ]),
    ])
    result = _run_with_ctx(fake, ctx)
    assert result.stop_reason == "ask_user"
    assert [q["prompt"] for q in result.questions] == ["Which lane?", "Before or after N1?"]

def test_single_ask_user_still_one_question():
    ctx = _ctx_for_agent()
    fake = _FakeClient([_resp([_ToolUse("a1", "ask_user", {"prompt": "Add anyway?", "options": [{"label": "Yes"}]})])])
    result = _run_with_ctx(fake, ctx)
    assert len(result.questions) == 1
```

`test_agent_endpoint.py` (replace the Batch-2 singular test's assertions):
```python
def test_ask_user_questions_are_surfaced_and_mentions_resolved(db):
    from tests.test_chat_suggest import _seed
    from app.services.map_chat_agent import AgentResult
    project, version, n1, claim = _seed(db)
    n_ref = None  # resolve N-ref for n1 via assemble_map_context is internal; use a raw prompt with a known ref
    def fake_agent(*, tool_ctx, skeleton_text, focus_items, history, user_message):
        # tool_ctx.mapctx has node_ref_by_id; craft a prompt referencing the seeded node's ref
        ref = tool_ctx.mapctx.node_ref_by_id[n1.id]
        return AgentResult(answer="Need input.", trace=[], consulted_claim_ids=[], round_count=1,
                           input_tokens=1, output_tokens=1, stop_reason="ask_user",
                           questions=[{"prompt": f"Put it after [[{ref}]]?",
                                       "options": [{"label": "Yes", "description": None}]}])
    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent", fake_agent)
        resp = pm_api.chat_suggest(project=project, model_id=version.model_id, version_id=version.id,
                                   payload=ChatSuggestRequest(user_message="add a step", session_id="s1"), db=db)
    assert len(resp.questions) == 1
    assert "[[node:" in resp.questions[0].prompt and str(n1.id) in resp.questions[0].prompt
    assert resp.questions[0].options[0].label == "Yes"
```

- [ ] **Step 2: Verify fail.** `POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py -k "multiple_ask or single_ask" tests/test_agent_endpoint.py -k questions -v` → FAIL.

- [ ] **Step 3a: Loop collects a list.** In `map_chat_agent.py`: rename `AgentResult.question: dict | None = None` → `questions: list = field(default_factory=list)`. In `run_chat_agent`, replace the single `ask_input` with `ask_inputs: list = []`; in the `ask_user` branch `ask_inputs.append(_normalize_question(dict(tu.input or {})))` (keep the trace append per question). After the loop, `if ask_inputs:` set `result.questions = ask_inputs`, `result.answer = _text_of(resp.content)`, `stop_reason = ASK_USER`, `break`.

- [ ] **Step 3b: Schema.** In `version_chat_suggest.py`, replace `ChatSuggestResponse.question: AgentQuestion | None = None` with `questions: list[AgentQuestion] = Field(default_factory=list)`.

- [ ] **Step 3c: Endpoint.** In `_run_chat_agent`, replace the singular-`question` block with:
```python
    questions = []
    for rq in (result.questions or []):
        prompt = _resolve_mention_refs(rq.get("prompt") or "", ctx)
        if not prompt:
            continue
        opts = [AgentOption(label=_resolve_mention_refs(o["label"], ctx), description=o.get("description"))
                for o in rq.get("options", []) if o.get("label")]
        questions.append(AgentQuestion(prompt=prompt, options=opts))
    message = resolved if (questions or not suggestions) else ""
```
and `questions=questions,` on the success-path `ChatSuggestResponse(...)`. (Keep the error-path return defaulting `questions=[]`.)

- [ ] **Step 4: Verify pass** (same commands) + regression: `POET_TEST_DB=poet_test_propose python -m pytest tests/test_map_chat_agent.py tests/test_agent_endpoint.py tests/test_chat_suggest.py -v`. Update/replace the Batch-2 `test_ask_user_question_is_surfaced_and_persisted` to the plural shape if it still references `resp.question`.

- [ ] **Step 5: Commit** `feat(agent): support multiple ask_user questions per turn; resolve refs in question text`.

---

## Task 2: Backend — prompt nudges (batch questions, bracket refs, insertion rewiring)

**Files:** `backend/app/services/map_chat_agent.py` (`AGENT_INSTRUCTIONS` and/or `SUGGEST_INSTRUCTIONS`); test `backend/tests/test_map_chat_agent.py`.

- [ ] **Step 1: Failing test.**
```python
def test_prompt_covers_batch_questions_bracket_refs_and_insertion():
    ctx = _ctx_for_agent()
    fake = _FakeClient([_resp([_Text("ok")])])
    _run_with_ctx(fake, ctx)
    system = fake.calls[0]["system"]
    assert "multiple ask_user" in system.lower() or "more than one clarifying" in system.lower()
    assert "bracket" in system.lower() or "[[N" in system  # refs in questions must be bracketed
    assert "insert" in system.lower() and "both" in system.lower()  # rewire both sides
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Add the guidance.** In `SUGGEST_INSTRUCTIONS`, add:
  - Under the ask policy: *"If you have more than one clarifying question, emit them as multiple ask_user calls in the SAME turn — the analyst answers them together. In an ask_user `prompt` and every option `label`, wrap any step/claim reference in double brackets ([[N3]], [[C1]]) exactly as in prose, so the UI renders links — never a bare N3."*
  - Under the suggestion rules: *"INSERTING a step into an existing flow: remove the original edge between the two steps and add an edge INTO the new step and an edge OUT of it to the following step — never leave a new step dangling with only an incoming edge."*

- [ ] **Step 4: Verify pass** + full-file regression.

- [ ] **Step 5: Commit** `feat(agent): prompt nudges — batch questions, bracket refs, rewire inserted steps`.

---

## Task 3: Backend — `_graceful_synthesis` emits a trace entry (CodeRabbit)

**Files:** `backend/app/services/map_chat_agent.py`; test `backend/tests/test_map_chat_agent.py`.

- [ ] **Step 1: Failing test.**
```python
def test_synthesis_propose_adds_trace_entry():
    ctx = _ctx_for_agent()
    rounds = [_resp([_ToolUse(f"t{i}", "find_node", {"query": "x"})]) for i in range(map_chat_agent.MAX_ROUNDS)]
    rounds += [_resp([_ToolUse("p1", "propose_changes", {"suggestions": [
        {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log", "title": "Rename", "rationale": ""}]})])]
    fake = _FakeClient(rounds)
    result = _run_with_ctx(fake, ctx)
    assert any(t["tool"] == "propose_changes" for t in result.trace)
```

- [ ] **Step 2: Verify fail** (synthesis currently appends no trace).

- [ ] **Step 3: Thread trace.** Give `_graceful_synthesis` a `trace: list` param; capture `res, summary = _handle_propose(...)` and `trace.append({"tool": "propose_changes", "summary": summary, "detail": json.dumps({"args": dict(b.input or {}), "result": res})[:4000]})` for each propose block. Pass `trace=trace` at all three call sites.

- [ ] **Step 4: Verify pass** + full-file regression.

- [ ] **Step 5: Commit** `fix(agent): graceful-synthesis proposals now appear in the activity trace (CodeRabbit)`.

---

## Task 4: Frontend — types `questions[]`

**Files:** `src/lib/types.ts`.

- [ ] **Step 1:** Replace `ChatSuggestResponse.question?: AgentQuestion | null;` with:
```typescript
  /** Present when the agent stopped to ask one or more clarifying questions. */
  questions?: AgentQuestion[];
```
(keep `AgentQuestion`/`AgentOption`).
- [ ] **Step 2:** `npx tsc --noEmit` will fail where `question` is consumed (chat-tab-helpers, chat-tab) — those are fixed in Tasks 5/6; it's fine for this task to leave a type error ONLY if committed together. To keep each task green, do Task 4 + 5 + 6 as ONE commit sequence (see note). Alternatively add `questions` alongside a temporary `question` — NO: remove cleanly and land 4–6 together.

> **Sequencing note:** Tasks 4, 5, 6 are one coupled frontend change (rename `question`→`questions` across type, helper, component, chat-tab). Implement them together and gate with a single `tsc`/`vitest`/`build` at the end of Task 6. Commit once.

---

## Task 5: Frontend — `QuestionSet` component + pure helpers

**Files:** rework `src/components/canvas/question-block.tsx`; `src/components/canvas/chat-tab-helpers.ts`; tests `src/components/canvas/question-set.test.ts`.

- [ ] **Step 1: Failing tests (pure helpers).** Create `src/components/canvas/question-set.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import type { AgentQuestion } from "@/lib/types";
import { allAnswered, composeAnswers } from "./chat-tab-helpers";

const qs: AgentQuestion[] = [
  { prompt: "Which lane?", options: [{ label: "Finance" }] },
  { prompt: "Before or after?", options: [{ label: "After" }] },
];

describe("allAnswered", () => {
  it("false until every question has a non-empty answer", () => {
    expect(allAnswered(qs, { 0: "Finance" })).toBe(false);
    expect(allAnswered(qs, { 0: "Finance", 1: "After" })).toBe(true);
    expect(allAnswered(qs, { 0: "Finance", 1: "  " })).toBe(false);
  });
});

describe("composeAnswers", () => {
  it("restates each question with its answer as one message", () => {
    const msg = composeAnswers(qs, { 0: "Finance", 1: "After N1" });
    expect(msg).toContain("Which lane?");
    expect(msg).toContain("Finance");
    expect(msg).toContain("Before or after?");
    expect(msg).toContain("After N1");
  });
});
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3a: Helpers** in `chat-tab-helpers.ts`:
```typescript
import type { AgentQuestion, ChatSuggestResponse } from "@/lib/types";
// ...existing assistantItemFromResponse (update to carry `questions: data.questions ?? undefined`)...

export type QuestionAnswers = Record<number, string>;

export function allAnswered(questions: AgentQuestion[], answers: QuestionAnswers): boolean {
  return questions.length > 0 && questions.every((_, i) => (answers[i] ?? "").trim().length > 0);
}

export function composeAnswers(questions: AgentQuestion[], answers: QuestionAnswers): string {
  return questions
    .map((q, i) => `Q: ${q.prompt}\nA: ${(answers[i] ?? "").trim()}`)
    .join("\n\n");
}
```

- [ ] **Step 3b: `QuestionSet` component** (replace `QuestionBlock`'s export; keep file `question-block.tsx` or rename to `question-set.tsx` and update imports). Contract:
```tsx
export function QuestionSet({
  questions, renderText, disabled, answered, onSubmit,
}: {
  questions: AgentQuestion[];
  renderText: (t: string) => ReactNode;   // the chat's mention renderer (turns [[node:uuid]] into links)
  disabled?: boolean;                       // a send is in flight
  answered?: boolean;                       // this set was already submitted (locked forever)
  onSubmit: (composed: string) => void;
}) { /* ... */ }
```
Behavior:
- Local state `answers: QuestionAnswers`. Each question renders `renderText(q.prompt)`, its option buttons, and a text input + small "Use this" affordance for a custom answer.
- Selecting an option OR confirming the text input sets `answers[i]` and **locks question i** (its controls become read-only, showing the chosen answer). No changing after set (per decision).
- When `allAnswered(questions, answers)` and not `answered`/`disabled`, show a **"Send answers"** button → `onSubmit(composeAnswers(questions, answers))`.
- When `answered` (already submitted) or `disabled`, everything is read-only; render each question with its locked answer (or greyed if unanswered on reload).
- Render prompts/labels via `renderText` so `[[node:uuid]]` mentions become links.

- [ ] **Step 4:** helper tests pass (`npx vitest run src/components/canvas/question-set.test.ts`).

---

## Task 6: Frontend — wire `QuestionSet` into chat-tab + persist answered

**Files:** `src/components/canvas/chat-tab.tsx` (+ `chat-tab-helpers.ts` `ChatItem.questions`).

- [ ] **Step 1:** `ChatItem` gains `questions?: AgentQuestion[]` and `questionsAnswered?: boolean` (add `AgentQuestion` import). `assistantItemFromResponse` sets `questions: data.questions ?? undefined`.
- [ ] **Step 2:** In the assistant render block (after `SuggestionList`, before `ActivityTrace`), replace the old `QuestionBlock` render with:
```tsx
                {m.role === "assistant" && m.questions && m.questions.length > 0 && (
                  <QuestionSet
                    questions={m.questions}
                    renderText={renderText}
                    disabled={ask.isPending}
                    answered={m.questionsAnswered}
                    onSubmit={(composed) => {
                      // lock this set permanently, then send the composed answers
                      setHistory((curr) => {
                        const next = curr.map((it, idx) => (idx === i ? { ...it, questionsAnswered: true } : it));
                        sessionStore.save(versionId, next);
                        return next;
                      });
                      submit(composed);
                    }}
                  />
                )}
```
(`renderText` is the same closure the assistant prose uses — confirm its name in chat-tab; if it's inline, extract a stable `renderText`.)
- [ ] **Step 3: Gate the whole frontend change (Tasks 4–6).**
```
npx vitest run && npx tsc --noEmit && npx next build
```
All green.
- [ ] **Step 4: Commit** `feat(chat): multi-question QuestionSet — per-question lock, custom answers, Send answers; ref links (#11)`.

---

## Task 7: Doc nits + gate + live re-verify + PR replies + push

- [ ] **Step 1: Doc nits (CodeRabbit).** Label the unlabeled fence at `docs/superpowers/specs/2026-07-01-agent-loop-write-propose-design.md` line ~56 (` ```text `). In `docs/superpowers/plans/2026-07-01-agent-loop-write-propose.md` near line 123, add a one-line note that this shipped as `ChangeKind.SET_CONDITION` (not RELABEL). Commit `docs: address CodeRabbit markdownlint + SET_CONDITION note`.
- [ ] **Step 2: Full gate.** Backend `POET_TEST_DB=poet_test_propose python -m pytest -q` (all green); frontend `npx vitest run && npx tsc --noEmit && npx next build`.
- [ ] **Step 3: Live re-verify** on relaunched `:8001`/`:3001`: refs render as links in a question; a multi-question turn shows all questions, each locks on answer, "Send answers" appears only when all answered and sends a composed message; an insertion command wires both edges.
- [ ] **Step 4: PR replies.** Reply on PR #46 (`gh --repo ewise123/processreengineering`): `delete_lane` flush/collapsed-prune already fixed in Batch 1 (`a0a4ed9`) — resolve; `ai_applied` client-trust deferred as #16 (auth/prov-v2). 
- [ ] **Step 5: Push** to update PR #46. Do NOT merge.

---

## Follow-ups (tracked, NOT in this batch)
- **Delete requires a reason** (node/edge/lane), consistent with relane — own small change/PR. Add to the findings doc.
- **#16** server-derived `ai_applied` trust boundary (auth/prov-v2).
- Batch-2 watch items now addressed here: refs-as-links (done), lock-after-answer (done), duplicate free-form (done via text input). Stateless re-ask remains a watch item.
