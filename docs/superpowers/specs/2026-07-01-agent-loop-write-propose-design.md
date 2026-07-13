# Agent Tool Loop — Write / Propose Loop (Design)

**Status:** Approved design, 2026-07-01. Ready for an implementation plan.
**Layer:** 0.5 (the propose fast-follow) of the agent-tool-loop roadmap.
**Roadmap:** `docs/superpowers/specs/2026-07-01-agent-tool-loop-roadmap.md` — the full 4-layer territory and what's deferred.
**Builds on:** `2026-07-01-agent-loop-layer0-readonly-design.md` (the shipped read-only loop this extends).
**Reuses:** `2026-06-24-chat-suggest-rebuild-design.md` + `2026-06-25-chat-suggest-mode-ui-design.md` (the suggestion-card / apply pipeline this loop emits into, unchanged).
**Feeds:** `2026-06-29-change-provenance-event-stream-design.md` (the north star every applied change already logs into).

---

## 1. Purpose & scope

Give the agent loop a **write capability** without letting it mutate anything. The loop gains one `propose_changes` tool that **validates and accumulates** suggested edits; at loop end those proposals surface as the existing approval cards, and the human applies/undoes/dismisses them exactly as today. This unifies ask-mode and suggest-mode into a single agentic loop and retires the single-shot suggester (`map_chat_suggest.run_chat_suggest`).

**Why this shape (the industry grounding):** The tool surface is deliberately *one* coarse tool, not a menu of per-operation tools. Anthropic's tool-use guidance prescribes exactly this — *"group them into a single tool with an `action` parameter … fewer, more capable tools reduce selection ambiguity"* — and warns that too many tools distract the agent. OpenAI ships the same shape in production (`apply_patch`: one tool, an `operation.type` discriminator, many ops per call). Every editing harness surveyed (Claude Code `Edit`/`Write`, Cursor `edit_file`, Cline `editor`/`apply_patch`) converges on 1–2 coarse edit tools; none exposes a per-operation tool menu. Our existing `PROPOSE_TOOL` schema — a flat op object with a `kind` enum and a nullable field-bag — is already that shape, and is also the correct way to express a discriminated union in strict function-calling (a top-level `oneOf` breaks strict mode; the flat-bag-plus-`kind` form does not).

**The human-in-the-loop model, named:** ours is the *asynchronous proposal queue* variant (the tool returns immediately; approval is an out-of-band UI action later), not the *synchronous interrupt* variant (OpenAI Agents SDK `needs_approval`, LangGraph `interrupt()`, where the agent's turn freezes on the call). The closest documented real-world analogue is Microsoft's **MSSQL Schema Designer + Copilot**: an agent that proposes structured edits to a *domain model* (a DB schema), surfaced as a diff list with per-change Accept/Undo, validated against guardrails before reaching the review queue. That is nearly a line-for-line match to our cards and validates the architecture.

**In scope (v1):**
- One `propose_changes` write tool added to the read-only loop (7 tools total: 6 read + 1 write).
- Three new op kinds closing the BPMN authoring gaps (12 → 15): `change_node_type`, `remove_lane`, `set_edge_condition`.
- In-loop op validation with per-op, self-correcting error feedback (replacing today's silent drop).
- Proposals accumulate across rounds and surface as the existing cards in the batch response.
- Per-proposal grounding surfaced on the card (labeled, not blocked).
- Retirement of the single-shot suggest path and the endpoint's `ChatMode` branch.
- A per-run write-scope guardrail (ops-per-run cap).
- Two small backend additions the new ops depend on.

**Explicitly out of scope (deferred):**
Streaming/SSE (proposals still batch at loop end) · the rich "flow card" preview (parked) · re-adding the ask/suggest toggle · web browsing · model/effort/context config UI (L2) · session lifecycle / context meter / Entra scoping / cross-session memory (L1) · thumbs/comments + eval suites (L3) · projecting proposals into the change-event stream before they're applied.

---

## 2. Decisions locked (2026-07-01 brainstorm)

1. **Tool granularity:** shape (A) — one coarse `propose_changes` tool. Reuse the existing `PROPOSE_TOOL` schema verbatim.
2. **Mode toggle:** dropped for now. One loop always carries `propose_changes` and decides whether to propose from the message (reusing the existing "when to propose vs converse" restraint rules). Re-addable later as a capability gate (withhold `propose_changes` in a read-only mode). Consequence accepted: no hard read-only guarantee in v1.
3. **BPMN coverage:** close all three gaps → 15 op kinds.
4. **In-loop validation:** required. Validate each op against the live map inside the tool handler; return per-op structured errors the model self-corrects from in the same loop.
5. **Grounding:** per-op `grounded` from surviving `cited_claim_refs`; ungrounded proposals get a distinct chip on the card (labeled, not hidden/blocked).
6. **Surfacing:** proposals accumulate across rounds and return as cards in the batch `ChatSuggestResponse`; proposing is non-terminal; accumulated proposals return regardless of `stop_reason`.
7. **Retirement:** delete `run_chat_suggest` and the endpoint's mode branch; keep the per-node `ai_edit_node` feature.

---

## 3. Architecture & execution model

- The write tool lives in **`map_chat_agent.py`**, alongside the 6 read tools. `PROPOSE_TOOL` and the suggest instructions move here from `map_chat_suggest.py`.
- The `chat_suggest` endpoint's `ChatMode` branch **collapses**: every request routes through `_run_ask_agent` (renamed to reflect that it now also proposes — e.g. `_run_chat_agent`). `payload.mode` becomes vestigial; keep the field optional on the request for backward compatibility and future re-gating, but ignore it.
- The loop controller owns, in addition to today's duties: dispatching `propose_changes`, validating ops, accumulating accepted proposals, and returning them alongside the answer.
- Validation reuses the endpoint's existing resolution/validation logic (`_build_suggestion`, `_repair_new_lane_temp_ids`, `_drop_orphaned_consumers`), refactored so the per-op check can return `(ok | error)` instead of only `(suggestion | None)`. The single source of truth for "is this op valid against this map" is shared between the in-loop tool handler and the final build step.

### Flow

```text
model → [read tools ...] → propose_changes(ops)
                              → handler resolves refs vs live map
                              → returns {accepted:[...], rejected:[{index,kind,error}]}
                              → accepted ops accumulate
model → (fixes rejected op / proposes more / investigates further) → ...
model → final answer (no tool call)  |  or budget cap → graceful synthesis
loop end → build accumulated ops into ChatSuggestion cards → ChatSuggestResponse
```

---

## 4. The write tool & op set

### 4.1 `propose_changes` (reused schema)

Lifted verbatim from `map_chat_suggest.PROPOSE_TOOL`: an object with `suggestions[]` (each carrying `kind`, `title`, `rationale`, `cited_claim_refs`, and the nullable ref/field bag) and `groups[]`. The suggest instructions ("when to propose vs converse", temp-id rules, one-suggestion-per-change, group summaries) move into the agent's instructions. The restraint rules matter more now that there is no mode gate: a direct command proposes; an open-ended or exploratory question answers in prose with no card; an already-correct map gets prose and no card.

### 4.2 Op kinds: 12 → 15

All three additions reuse `opToSteps` → `MutationStep` → the executor's PATCH/DELETE calls.

| New op | Fields | Maps to | Backend status |
|--------|--------|---------|----------------|
| `change_node_type` | `node_ref`, `node_type` | `update_node(type=…)` | Ready (`update_node` sets `type` today; logs a reason). |
| `remove_lane` | `lane_ref` | `DELETE /lanes/{id}` | Ready (`delete_lane` reassigns the lane's nodes to a remaining lane, blocks deleting the last lane, recompacts order). Delete-op semantics apply. |
| `set_edge_condition` | `edge_ref`, `condition_text`, optional cited claim → `condition_claim_id` | `update_edge(condition_text=…)` | Needs a small addition (§7). The gateway branch guard ("if amount > $10k") — distinct from the edge `label`. |

`remove_lane` is a **delete op**: it joins `DELETE_OPS` in `suggestion-apply.ts`, making its bundle non-undoable and confirm-gated, like `remove_node`/`remove_edge`. Its card copy names the reassignment target lane so the user understands the steps are not lost.

### 4.3 New frontend `MutationStep`s

- `change_node_type` → extend the existing `update_node` step with an optional `nodeType` field (the executor already PATCHes nodes; add `type` to the body). Carries a `reason` (semantic edit).
- `remove_lane` → new `delete_lane` step (`laneRef`); executor calls `DELETE /lanes/{id}` with `ai_applied`.
- `set_edge_condition` → new `update_edge_condition` step (`edgeRef`, `conditionText`, `reason`); executor PATCHes the edge.

---

## 5. In-loop validation & self-correction

This is the loop's substantive upgrade over the single-shot suggester.

- **On each `propose_changes` call**, the handler resolves every op's refs (`node_ref`, `edge_ref`, `lane_ref`, `from_ref`, `to_ref`, `near_node_ref`, `cited_claim_refs`) against the **live map context** for the run, treating temp-ids produced *within the same call* as satisfiable (the same `_repair_new_lane_temp_ids` recovery applies).
- **The tool returns a per-op verdict** to the model: `{accepted: [{index, kind, title}], rejected: [{index, kind, error}]}`. Errors are actionable, not opaque — e.g. *"`node_ref` 'N9' is not on the map; call find_node to get a valid ref"*, *"add_node is missing `new_label`"*, *"`lane_ref` 'tmp:2' has no producing add_lane in this call"*. This is the pattern Anthropic explicitly recommends (prompt-engineered, specific error responses that the model corrects from in the same turn).
- **Only accepted ops accumulate.** The model may re-propose a corrected version of a rejected op on a later round.
- **The map is stable during a run** (reads only; nothing applies mid-loop), so validation is against a fixed snapshot — no staleness within the loop.
- **The frontend `planBundle` staleness re-check is retained as the second layer.** Between a proposal and the human's click the map *can* change (the user applies a card the proposal depended on, or edits manually), so `planBundle` still marks a bundle unapplyable if a real ref has since disappeared. Backend validation is for the agent's benefit (self-correction); frontend validation is for the human's (safe apply).

Contrast with today: the single-shot path silently drops invalid ops (`_build_suggestion` returns `None`, `_drop_orphaned_consumers` prunes their dependents). In the loop we surface the failure to the model instead, so a fixable mistake gets fixed rather than vanishing.

---

## 6. Surfacing, grounding & response shape

- **No new response type.** Accumulated, resolved proposals populate `suggestions[]` (and `group_summaries`) in the existing `ChatSuggestResponse`, which already carries `message`, `mention_sources`, `activity_trace[]`, `run_id`, and `grounded`. Ask-style questions still return prose with `suggestions=[]`; commands return cards (and, per the existing rule, drop top-level prose when cards are present).
- **Grounding on the card (finally surfaced).** Each proposal's `grounded` = whether its `cited_claim_refs` survive resolution to real project claims (fabricated refs dropped). A proposal with zero surviving citations renders a distinct **"not grounded in your sources"** chip on its card. This is the signal the read-only design deliberately *reserved* for the write loop: it was removed from ask-mode prose as noisy, and belongs here, on a concrete proposed change, where the user actually wants the grounded/invented distinction. Labeled, never blocked or hidden.
- **Trace.** `propose_changes` calls appear as activity-trace lines like other tools — *"Proposed 3 changes (1 rejected: stale ref)"* — expandable to the raw args/verdict. `summarize_tool_call` gains a `propose_changes` case.
- **Pause/cancel** is unchanged (abort the single fetch via `AbortController`; no stream).

---

## 7. Small backend additions

1. **`EdgeUpdate.condition_text`** — add the field to the schema; `update_edge` sets `edge.condition_text` when present and records a change (mirroring the label-change path, including the reason requirement and `ai_applied` source/actor attribution). Optionally set `condition_claim_id` from a cited claim. Needed for `set_edge_condition`.
2. **`delete_lane` `ai_applied`** — `delete_lane` currently hardcodes `source=MANUAL` and `reason="Deleted"`. Add an `ai_applied` flag (query param or small body) so an AI-applied lane removal attributes to `source=CHAT` / `actor=AI` and carries a real reason, matching `update_node`/`update_edge`. Needed so `remove_lane` provenance is consistent with every other AI-applied change.

Both are additive and small; neither changes existing manual-edit behavior.

---

## 8. Loop control, budget & write-scope guardrail

- **Caps reused unchanged:** `MAX_ROUNDS = 6`, `MAX_TOKENS_BUDGET = 80_000`, `MAX_WALL_SECONDS = 180`, graceful synthesis at the cap, and the full `AgentRunStopReason` set (`normal`, `round_cap`, `token_cap`, `max_tokens`, `refusal`, `error`, `time_cap`).
- **`propose_changes` counts as a normal round.** Proposing is **non-terminal**: the agent may propose, keep investigating, propose more, then answer.
- **Accumulated proposals always return.** Hitting a budget cap forces graceful synthesis (a text answer, no tools) but does **not** discard proposals already accepted — they ride along in the response with whatever `stop_reason` applied.
- **Write-scope guardrail (new; roadmap cross-cutting).** Cap total accepted ops per run (≈25). Excess ops are not accumulated; a trace note records the truncation so it is never silent. This bounds a runaway loop from emitting a wall of cards.

---

## 9. Persistence

`AgentRun` persistence is unchanged. `propose_changes` calls (args + per-op verdict) are recorded in `tool_calls[]` like any tool, giving observability into what the agent proposed and what was rejected. Proposals are **ephemeral** until applied: a suggestion becomes a durable entity only when the human clicks Apply, which goes through the existing PATCH/DELETE endpoints and their change-log (`record_change`) — the same provenance path manual edits use. No proposal is written to the map or the change-event stream before the human accepts it.

---

## 10. Safety & edge cases

- **Tool-error recovery:** unchanged from Layer 0 — a failed tool returns a structured error; infra failures abort gracefully and still write the `AgentRun` with `stop_reason=error`. Op-validation failures are *not* errors; they return as `rejected` verdicts the model corrects from.
- **Prompt-injection / trust boundary:** retrieved content stays delimited as untrusted data (the model must treat claim/source text as data, never instructions). Blast radius is still bounded — a write tool that only *proposes* cannot mutate the map; a poisoned source can at worst produce a card the human can reject. The hardened boundary is revisited when web browsing or auto-apply ever lands.
- **Staleness / concurrency:** the map is read-only within a run (§5); the two-layer validation (backend in-loop + frontend apply-time) covers the window between proposal and apply.
- **`remove_lane` corner:** deleting the only remaining lane 422s on the backend; validation rejects the op in-loop (actionable error) so the model never proposes an unapplyable lane deletion.

---

## 11. Testing

- **Backend** (fake Anthropic client with scripted tool-use sequences; no API key):
  - A clean propose → accepted ops → cards.
  - A propose with a stale/invalid ref → `rejected` verdict → model corrects on the next round → accepted (proves self-correction).
  - The per-op accept/reject split, and temp-id-within-batch resolution (`add_lane` + `move_to_lane` in one call).
  - The ops-per-run cap (excess truncated + trace note).
  - Each of the 3 new op kinds validates and builds into a suggestion.
  - Accumulated proposals return when a budget cap forces graceful synthesis.
  - The endpoint no longer branches on `ChatMode`; a command and a question both route through the loop.
- **Frontend** (pure-logic, node env):
  - `opToSteps` for `change_node_type`, `remove_lane`, `set_edge_condition`.
  - The new/extended `MutationStep`s produce the right PATCH/DELETE bodies.
  - `remove_lane` is non-undoable and confirm-gated (`DELETE_OPS`).
  - The per-proposal grounded chip: shown when `cited_claim_refs` resolve to nothing, hidden otherwise.
  - `planBundle` staleness still marks a bundle unapplyable when a real ref is gone.

---

## 12. Sequencing after this spec

1. Implement this spec — plan via writing-plans, build via subagent-driven-development (per-task spec + quality review; backend `pytest`, frontend `npm run test` + `tsc --noEmit` + `npm run build`).
2. **Immediate follow-on:** streaming/SSE — live proposal + activity narration as the loop runs.
3. **Then:** the flow-card rich preview (the parked design becomes the write loop's in-canvas preview), and re-adding the mode toggle if users want a guaranteed read-only mode.
4. Then Layers 1–3 per the roadmap.
