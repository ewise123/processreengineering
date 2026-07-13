# Agent Loop — Converse / Ask / Propose Redesign (Batch 2)

**Status:** Design approved 2026-07-13. Lands on branch `design/agent-loop-write-propose`
(updates PR #46). Nothing merges to `main` without explicit OK.

**Predecessor:** Batch 1 (clear bug fixes + consumable context) is done and pushed to PR #46.
This is Batch 2 — one coherent redesign of how the agent converses, asks, and proposes.
Findings/worklist: `docs/superpowers/notes/2026-07-08-write-propose-test-findings.md`.

**Worklist items covered:** #1 command pushback, #2 grounding-chip refinement, #10 grounding
false-positive (subsumed by #1/#2), #11 `ask_user` tool, #13 synthesis-can-propose + cap
tuning, #8 op-selection nudge. Deferred (NOT in this batch): #12b exact-quote claims,
#15 richer Change Log, #16 server-derived `ai_applied`.

---

## Problem

The write/propose loop (`app/services/map_chat_agent.py`) proposes reflexively on any command,
with no check against the sources. Live testing surfaced the consequences:

- A command proposes a card even when the change **contradicts** or is **unsupported by** the
  sources — the opposite of what a provenance-first tool should do.
- The "Not grounded in your sources" chip is deterministic (`cited_claim_ids.length > 0`) and
  fires on *every* citation-less card, including ones the user directly commanded → constant
  noise, so the signal is meaningless (#2, #10).
- The loop has no way to pause and ask a clarifying question — it can only propose or narrate
  (#11).
- A change-heavy request that exhausts the round budget hits the graceful-synthesis turn, which
  runs with **no tools**, so it narrates changes it never emits as cards (#13).
- "Set the condition X" maps to `relabel_edge` (display label) instead of `set_edge_condition`
  (the guard) (#8).

## Governing principle

**The agent proposes a content change directly only when it is grounded in a source. Otherwise
it asks first.** This makes the grounded/ungrounded state meaningful signal instead of constant
noise, and keeps the agent from silently making changes the sources don't back — the make-or-break
behavior for a provenance-first tool.

---

## 1. Control flow: `ask_user` as a terminal tool with stateless resume

The chat endpoint (`chat_suggest` in `app/api/v2/process_maps.py`) is a synchronous
request → single `ChatSuggestResponse`. We do **not** suspend the loop mid-request and block a
worker thread on a human.

- `ask_user` is a **terminal** tool. When the model calls it, `run_chat_agent` **stops** the loop
  (the same way a tool-less final answer stops it) and returns the question in the response. No
  server-side loop state is persisted.
- The frontend renders the question as clickable option buttons inside the assistant message.
  Selecting an option — or typing a free-form reply — **sends it as the next user message**, an
  ordinary `chat_suggest` call.
- On that next call the model sees, in conversation history, that it asked and what the user
  answered, and proceeds (proposes, or revises). A prompt rule forbids re-asking a question the
  user has already answered.

**Why stateless resume, not a suspended loop:** it matches the existing "history carries
everything" design (the same pattern as the Layer 0 deictic-selection fix) and needs zero new
persistence. The cost — on resume the model re-investigates from the skeleton — is acceptable:
the user's answer and the agent's own prior prose are in history to anchor it, and investigation
is cheap (skeleton + a few read-tool calls).

**Accumulated proposals + a question in the same turn.** A change-heavy request may have some
grounded changes (propose directly) and one ungrounded change (needs an ask). A turn that ends in
`ask_user` returns the question **plus** any grounded cards already accumulated this turn — the
safe changes land, the risky one waits for the answer. `run_chat_agent` therefore attaches
`result.proposals` and `result.question` together on the ask path.

---

## 2. The grounding gate (#1, #2, #10 unified)

Before the loop proposes an op, it must establish grounding via the read tools
(`search_claims`, `get_node_detail`, `lookup_citation`, `list_conflicts`). Decision table:

| Situation | Behavior |
|---|---|
| Change is **supported** by a source claim | Propose directly, cite the claim, no warning chip |
| Change **contradicts** a source-backed element | `ask_user` first ("proceed or revise?"), do **not** propose yet |
| Change has **no support found** in the sources | `ask_user` first ("not in your sources — add anyway?"), do **not** propose yet |
| Command is **materially ambiguous** (readings that diverge in a way that matters) | `ask_user` to disambiguate |

After the user confirms an ungrounded or contradicting change, it is proposed **with** the amber
warning chip (see §3). A confirmed contradiction is marked `user_directed` and its rationale
should note the confirmation despite the conflicting source.

### Scope of the gate

The gate applies to **any op that adds, removes, or alters a process assertion** — which is
effectively every `propose_changes` op, because every op asserts something about the process:

- `add_node` / `add_edge` — a step or transition exists
- `remove_node` / `remove_edge` / `remove_lane` — it does not
- `set_edge_condition` — a guard governs a branch
- `describe_node` — what a step entails
- `change_node_type` — a step's nature (task vs gateway vs …)
- `move_to_lane` — **who performs** a step (lane = actor/role)
- `reroute_edge` — the **flow sequence** (endpoints)
- `add_lane` / `rename_lane` — an **actor/role** in the process
- `relabel_node` / `relabel_edge` — the meaning of a step/transition label

The **only** thing outside the gate is a change that alters nothing assertable: a
**meaning-preserving reword** (typo or clarity fix that keeps the same meaning) proposes directly.
There is no "cosmetic op" exemption, because pixel-position drags and edge-waypoint routing are
direct canvas PATCHes, not `propose_changes` ops.

### Anti-nag rule

The agent asks **once per logical decision (or `group`), never once per op.** "I'm grouping these
three steps into an Approvals lane, but the sources don't mention that grouping — proceed?" is one
question, not three. The high ambiguity bar and per-decision batching are what keep a
gate-on-everything policy from feeling chatty.

---

## 3. The grounding signal on the card (#2)

Replaces today's blanket `isProposalGrounded` chip.

- **`supported`** — DETERMINISTIC. Derived from `cited_claim_ids` resolving to ≥1 real claim; the
  model cannot self-declare it, so it can't be gamed. Renders **no chip**.
- **`ungrounded`** — no supporting claim. Renders an **amber warning chip regardless of who
  initiated the change**. The model sets a per-suggestion `origin` that changes only the **copy**:
  - `user_directed` → *"Not in your sources"* (you asked for it; heads-up it isn't backed)
  - `ai_volunteered` → *"AI suggestion · not in your sources"* (the agent proposed it beyond
    what you asked and the sources say)

`origin` is a new optional field on the suggestion the model sets when it proposes. It only
affects copy for the ungrounded case; a supported change shows no chip regardless of `origin`.

Because the gate (#2 §2) forces the agent to investigate before proposing, a supported change now
actually carries citations — which is what makes #10's false-positive go away without separate work.

---

## 4. `ask_user` schema + UI

**Tool.**

```
ask_user(prompt: string, options: [{label: string, description?: string}])
```

- Backend accepts 2–4 model options; the client appends the **"Something else — I'll explain"**
  affordance (it focuses the chat input) so the user is never boxed into the presented choices.
  The normal chat input stays live the whole time — free-form is always available.
- `ask_user` is a terminal tool (see §1). It does not return a tool_result the loop reacts to; it
  ends the turn.

**Backend contract.** `ChatSuggestResponse` gains an optional field:

```
question: {prompt: string, options: [{label, description}]} | null
```

`null`/absent on ordinary responses. New `AgentRunStopReason.ASK_USER` records the run stopped to
ask. The accumulated (grounded) proposals ride along on the same response.

**Frontend.** A small question block renders under the assistant message (prompt + option
buttons + the trailing "Something else" affordance). Clicking an option calls the existing
`submit(label)` path — an ordinary next message. The question is stored on the assistant
`ChatItem` like any turn so it survives reload.

---

## 5. #13 — let graceful-synthesis still propose + cap tuning

- `_graceful_synthesis` currently runs with **no tools**, so a budget-capped turn narrates changes
  it cannot emit. Fix: give the synthesis turn `[PROPOSE_TOOL]` **only** (drop the read tools),
  run the same `_handle_propose` accumulation used in the main loop, and merge those proposals
  into `AgentResult.proposals`. A change-heavy turn that hits the budget still emits cards.
- Bump `MAX_ROUNDS` 6 → 8. Ask turns end early, so this mostly buys genuine multi-step proposing
  room. Keep `MAX_TOKENS_BUDGET=80_000`, `MAX_WALL_SECONDS=180`, `MAX_PROPOSED_OPS=25`.
- The gate still holds on the synthesis turn: the synthesis prompt instructs the model to propose
  only what it already grounded during investigation, and to omit (not narrate) anything it could
  not verify. It cannot `ask_user` on the synthesis turn (that tool isn't offered there), so an
  unresolved ungrounded change is dropped with a one-line note rather than silently proposed.

---

## 6. #8 — op-selection nudge

Tighten `SUGGEST_INSTRUCTIONS` and the `set_edge_condition` / `relabel_edge` field descriptions so
"set the condition X" reliably maps to `set_edge_condition` (guard → `condition_text`), never
`relabel_edge` (display label). Make the guard-vs-label distinction explicit and give a worked
example. Pure prompt/description work — the schema exposure and the edge-condition render were
already fixed in Batch 1 (`a0a4ed9`, `5355ba1`).

---

## 7. Testing

**Backend (pytest, `POET_TEST_DB=poet_test_propose`).**

- Gate policy branches: supported → propose directly (cites claim); contradiction → `ask_user`,
  no card; no-support → `ask_user`, no card; ambiguous → `ask_user`; meaning-preserving reword →
  propose directly.
- `ask_user` terminal behavior: loop stops, response carries `question`, `stop_reason=ASK_USER`,
  accumulated grounded proposals ride along.
- Synthesis-can-propose: a round-capped run still returns proposals; read tools absent on that turn.
- Op-selection: "set the condition" yields `set_edge_condition` with `condition_text`.
- `origin` plumbs from model output through to the suggestion.

**Frontend (vitest / tsc / build).**

- Question block renders (prompt + options + "Something else"); clicking an option sends it.
- Chip copy/states: supported → none; `user_directed` ungrounded → "Not in your sources";
  `ai_volunteered` ungrounded → "AI suggestion · not in your sources". Retire the blanket
  `isProposalGrounded` chip path; `showUngroundedWarning` updated or removed.

**Live verification.** Isolated instance (worktree backend `:8001` on the `poet_propose` clone,
frontend `:3001`). Re-run the playbook cases that surfaced #8, #10, #13, plus new ones: a command
that contradicts a source (expect an ask), a command with no source support (expect an ask), an
ambiguous command (expect an ask), a clearly-supported command (expect a direct proposal).

---

## Out of scope (deferred)

- **#12b** claims → exact quotes/lines (coordinate with `feat/provenance-v2-schema`).
- **#15** richer Change Log before→after rendering.
- **#16** server-derived `ai_applied` trust boundary (blocked on auth / Layer 1).
- Streaming responses, flow-card preview — tracked elsewhere.
