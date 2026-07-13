# Write/Propose Loop — Live Test Findings & Fix Worklist

**Status:** Live-testing PR #46 (`design/agent-loop-write-propose`) on the isolated instance
(worktree `../poet-propose`, backend `:8001`, frontend `:3001`, cloned DB `poet_propose`).
**Decision:** all fixes below land on **this same branch** (updates PR #46). Nothing merges without explicit OK.
**Testing status:** user got through Phase 03 test 2 of the playbook, then paused to log these. Test pass to be **finished first**, then fixes applied as one batch.

---

## Locked design decisions (2026-07-08)

- **Q1 — Command workflow = "propose, but push back on conflicts."** A clear command whose change is
  supported by the sources still proposes cards immediately. A command that would **remove or contradict**
  something the sources back → the agent investigates the relevant claims, states the conflict in prose,
  and asks "proceed or revise?" **before** emitting the card. This makes the grounded/ungrounded state
  meaningful signal instead of constant noise.
- **Q2 — Context UX = "consumable attachment."** Attach selection → send → it's injected into that turn and
  lives in conversation history → the chip **auto-clears**. Follow-ups rely on the agent recalling the nodes
  from history. Remove the persistent, manually-cleared working-set.

---

## Worklist

### 1. Command pushback behavior  (NEW — Q1)  ·  Medium
The loop currently proposes reflexively on any command, with no check against the docs and a hollow
auto-rationale. Change: in `map_chat_agent` SUGGEST_INSTRUCTIONS, instruct the loop that before proposing a
change that **removes or contradicts** a source-backed element, it must look up the relevant claims and, if
there's a conflict, lead with a caveat + ask before proposing (propose directly when the change is
supported). Uses the loop's existing read tools; no new machinery.

### 2. Grounding-chip refinement  (rides with #1)  ·  Small
Today every user-commanded net-new step gets "Not grounded in your sources" → noise. Reserve the strong
flag for genuinely **unsupported/volunteered** or **conflicting** changes; soften or drop it for a net-new
step the user explicitly asked for. **Open wrinkle:** exact rule for "user asked for it" vs "AI volunteered
it" — decide during implementation.

### 3. Consumable context  (Q2)  ·  Medium  ·  frontend
`chat-tab.tsx`: inject selection on send + auto-clear the chip; drop the persistent `sessionContext`
working-set and manual clear. **Open wrinkle:** a later deictic "this" relies on history recall rather than
a re-attached selection — accept, but be deliberate.

### 4. New-node placement  (BUG)  ·  Small–Med
**Symptom:** applied `add_node` landed far right (right of "Review non-PO invoice…" in lane 2), though
edges were correct. **Root cause:** `bpmn-canvas.tsx` `placeNewNode` (line 542–544) — when `near_node_ref`
is unresolved/absent, it dumps the node at the far-right end of the resolved lane (`max(x+w)+60`). The model
connected via a separate `add_edge` but set no placement anchor. **Fix direction:** when `near_node_ref` is
missing, anchor placement off the incoming `add_edge`'s **source** node; and nudge the model to always set
`near_node_ref` on `add_node`.

### 5. Activity-trace ordering  (BUG)  ·  Trivial
**Symptom:** "How I found this" renders at the **top** of suggestion responses. **Root cause:**
`chat-tab.tsx` (lines 448–453) renders `ChatMsg → ActivityTrace → SuggestionList`; suggestion responses
suppress the prose, so the trace floats above the cards. **Fix:** render `SuggestionList` before
`ActivityTrace` (trace always last).

### 6. Manual lane-move "Save failed" = 422  (BUG — pre-existing, not from PR #46)  ·  Small
**Symptom:** move a node to a new lane in the properties panel + enter a reason + save → "Save failed"
(logged: five `422`s on `PATCH /nodes`). **Root cause:** `properties-panel.tsx` `handleLaneChange`
(line 167) sends `onUpdate(id, { laneId })` with **no `reason`**, but the backend requires a reason for a
lane change (`process_maps.py:953`). The reason box isn't wired into the lane-change call. **Fix:** the lane
dropdown must collect/send a reason (like name/description edits do).

### 7. Rename undo failed  (BUG)  ·  TBD — needs repro detail
**Symptom:** applied a rename, could not undo it. Renames *should* be undoable (`relabel_node` is not a
delete op). **Need from user:** did an "Undo" link appear on the applied card, and did clicking it error?
Failure modes: (a) Undo link absent — undo handle not stored/cleared, OR the rename was bundled with a
delete op (which makes the whole bundle non-undoable — expected but confusing; should be surfaced on the
card); (b) link present but the revert PATCH failed.

---

## Also confirmed / explained (no fix needed)

- **"Not grounded" flag is deterministic**, not the AI's choice: `isProposalGrounded(s)` =
  `cited_claim_ids.length > 0`. The model only influences it by whether it cites claims that resolve to real
  ones. (Addressed by #2.)

---

## Findings from the final test pass (Phases 03–08)

### 8. `set_edge_condition` changed the edge LABEL, not the condition  (BUG)  ·  Med
Prompt "set the condition 'amount < $10,000'" → the model emitted **`relabel_edge`**, not `set_edge_condition`
(confirmed: change_events shows `edge|relabel`, no `set_condition`). Two parts: (a) the model doesn't reliably
pick `set_edge_condition` for "set condition" — needs prompt/tool-description clarity distinguishing the
**guard** (`condition_text`) from the display **label**; (b) **`condition_text` is never rendered on the
canvas edge** — even a correct op would be invisible on the map (only shows in the Change Log). Render the
condition on the edge (e.g. a bracketed `[amount < $10,000]` guard near the arrow).

### 9. Last-lane guard — UNTESTED (no single-lane map available)
Cover it with a backend unit test in the fix batch so it's verified without needing a special map.

### 10. Grounding chip false-positive  (BUG — subsumed by #1/#2)
Rename "…invoice" → "…invoice by mail or email" tagged "Not grounded" even though it IS supported — because
the agent proposed **without checking the sources first**, so it cited nothing → chip fired. Root cause is the
same as #1: the agent must investigate before proposing. Fixing #1 makes grounded changes actually carry
citations, which fixes this. No separate work.

### 11. Agent needs an "ask the user" tool  (NEW FEATURE — needs mini-design)
Give the loop an `ask_user`-style tool (like Claude's AskUserQuestion) so it can pause and ask a clarifying
question with options — the mechanism the #1 "push back on conflicts" workflow needs to gate on your answer.
Changes the loop from batch → interactive/multi-turn. Own design pass.

### 12. Citations: repeated same-source shows "interview.txt / interview.txt / interview.txt …"  (BUG + bigger)
(a) **Quick:** dedupe repeated identical source citations in the mention rendering. (b) **Bigger:** claims
should tie to **exact quotes/lines** in the source doc (provenance granularity) — overlaps the
`feat/provenance-v2-schema` effort; likely coordinate there rather than in this PR.

### 13. "Make all the changes we discussed" → narrated changes but emitted none  (BUG — loop control)
Confirmed via `agent_runs`: that run hit `stop_reason=round_cap` (6 rounds) → forced **graceful-synthesis
turn runs with NO tools** → it can only produce prose ("here are the concrete changes…") but cannot emit
cards. So a change-heavy/complex request that exhausts the budget promises changes it never proposes.
**Fix directions:** (a) let the synthesis turn keep the `propose_changes` tool (drop only the read tools);
and/or (b) tune the caps for structural requests. (Also: complex requests hit the 6-round cap often.)

### 14. AI-applied CREATES mis-attributed as "User" in the Change Log  (BUG — provenance, HIGH)
Confirmed: `lane|create|user|manual` and `edge|connect|user|manual` for AI-applied creates. The CREATE
endpoints (`create_node`/`create_edge`/`create_lane`) DO accept `ai_applied`, but the canvas executor's
`api.createNode/createEdge/createLane` calls never pass it (only the edit ops do). So `add_node`, `add_edge`,
`add_lane`, and `decompose` all log as manual/user. **Fix:** thread `ai_applied` (+ the suggestion's reason)
through the executor's create calls. Pre-existing, but the loop makes it pervasive. High priority — provenance
is the make-or-break feature.

---

## Consolidated worklist by tier (post-testing)

**Tier 1 — clear bug fixes (do now):**
- #14 AI-create attribution (HIGH, provenance) · #5 activity-trace order · #4 node placement ·
  #6 manual lane-move 422 (pre-existing) · #12a citation dedupe · #8 condition op-selection + render ·
  #9 last-lane guard test · #7 rename-undo (repro on our side).

**Tier 2 — decided behavior changes:**
- #1 command pushback (also fixes #10) · #2 grounding-chip refinement · #3 consumable context.

**Tier 3 — new/loop-control, need a short design decision each:**
- #11 `ask_user` tool (enables #1's gating) · #13 let graceful-synthesis still propose + cap tuning.

**Tier 4 — bigger / defer or coordinate elsewhere:**
- #12b claims → exact quotes/lines (overlaps provenance-v2 branch).

---

## Batch 1 outcome (2026-07-13) — all clear-bug + context items done, each reviewed

- **#14 AI-create attribution** — FIXED (`312d217`). Backend Create schemas gain `ai_applied`+`reason`; create endpoints attribute AI creates to chat/AI; frontend executor passes it. Reviewed ✅.
- **test infra** — `POET_TEST_DB` env override (`23bacc7`) so this worktree's pytest uses `poet_test_propose` (the shared `poet_test` is stamped at the other branch's prov_v2). Full backend suite 341 green.
- **#5 trace order** — FIXED (`d666b6d`): cards above the "How I found this" trace.
- **#12a citation dedupe** — FIXED + reworked (`d666b6d` → `e48cb79`): dedupe scoped per render call (review caught a whole-message-scope bug that could drop an unrelated card's only citation). Non-adjacent same-doc grammar edge deferred to #12b.
- **#4 node placement** — FIXED (`5355ba1`): planner anchors a new node off its incoming edge's source when `near_node_ref` is absent (real-node guarded).
- **#8 edge condition** — RENDER FIXED (`5355ba1`): condition drawn on the edge (amber bracketed guard) in `shapes.tsx`. Op-selection nudge (model picks set_edge_condition) deferred to Batch 2's instructions rework.
- **#9 last-lane guard** — already covered by an existing unit test (`6e7be86`); no new work.
- **#3 consumable context** — FIXED (`322bdaf`): attach → send → auto-clear; persistent working-set removed. Reviewed ✅.
- **#7 rename undo** — INVESTIGATED, no code bug: the card-undo path returns a working revert closure for a relabel; report likely a manual/panel rename (uses Cmd+Z, not card Undo) or a rename bundled with a delete (non-undoable). Re-test on the fixed instance.
- **#6 manual lane-move 422** — FIXED (`fe3fafe`). Correction: the earlier "no bug" was WRONG — it only checked the DROPDOWN path. User's repro (DRAGGING a node across lanes with reason "Test") exposed the real bug: the drag `onMove` optimistically updates the node's lane in local state during the drag, then on drop `applyGroupPositionsLocal` decided whether to attach the reason by comparing each node's lane to `nodesRef.current` (already mutated) → computed "no lane change" → dropped the reason → backend 422 "a reason is required." Fix: attach the caller-supplied reason unconditionally (callers pass it only for semantic relanes). Verified by live PATCH replay (with-reason→200, reason-less→422) + tsc/tests. LESSON: verify the ACTUAL user path (drag ≠ dropdown), not just a raw-PATCH replay.

**Deferred to Batch 2 (converse/ask/propose redesign):** #1 pushback, #2 chip refinement (+#10), #11 ask_user tool, #13 synthesis-can-propose + cap tuning, #8 op-selection nudge. **Deferred to prov-v2 coordination:** #12b exact-quote claims.

### FUTURE — server-derived `ai_applied` / provenance trust boundary (#16, tracked 2026-07-13)
CodeRabbit (PR #46) flagged that `ai_applied` is a client-supplied boolean on the create/update/delete endpoints, so a caller could spoof AI-vs-user attribution. Valid in principle, but **not addressable in the current architecture**: there's no auth boundary and no server-side "agent execution context" — "Apply" is always a human action in the browser, and `ai_applied` is the client asserting "this edit came from applying an AI suggestion card" (vs a manual edit), which only the client knows. Harden when the auth/Entra work (Layer 1) lands or with the prov-v2 trust-boundary work: derive/verify attribution server-side from an authenticated agent path rather than trusting the body. Deferred, documented on the PR.

### FUTURE — richer Change Log entries (#15, tracked 2026-07-13, not now)
Change Log entries render only the kind + reason (e.g. "Relane" + "Test") — they don't show the **before → after** context (origin lane → destination lane, old name → new name, old type → new type, etc.). The data ALREADY exists: `change_events.before`/`after` (JSONB) capture the old/new values per changed field (e.g. relane stores `before={lane_id: old}`, `after={lane_id: new}`). So this is a **frontend rendering enhancement** in `change-entry.tsx`: resolve the before/after values (lane_id → lane name, type enum → label, etc.) and show the transition. Generalizes across kinds — relane (lane names), relabel (name old→new), retype (type old→new), describe, set_condition, connect/reconnect (endpoints), delete. Also consider resolving UUIDs in `before`/`after` to human labels. Likely coordinate with the prov-v2 event-stream work since it touches the same records.
