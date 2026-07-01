# Agent Tool Loop — Territory & Roadmap

**Status:** Living roadmap. Layer 0 (the loop core) is the active design target as of 2026-07-01. Layers 1–3 are captured here so nothing is lost, but each becomes its own brainstorm → spec → plan when its turn comes. Do **not** try to spec all four layers in one document — that is the "multiple independent subsystems" trap.

**Why this exists:** The agent tool loop is the next big build for POET's in-canvas AI. The user's framing spanned a whole platform, not one feature. This doc names the layers, records the open questions, and fixes the sequence so any agent (or the user) picking this up later has the full map.

**Read alongside:**
- `docs/superpowers/specs/2026-06-29-change-provenance-event-stream-design.md` — the north-star provenance model every tool call must eventually feed.
- `docs/superpowers/specs/2026-06-24-chat-suggest-rebuild-design.md` + `2026-06-25-chat-suggest-mode-ui-design.md` — the suggestion-card / apply pipeline the loop's write tools reuse verbatim.
- `docs/superpowers/specs/2026-06-24-chat-pause-cancel-design.md` — its "Deferred" section is the original sketch of narrated tool calls.

---

## What exists to build on (as of 2026-07-01)

- **Backend `map_chat_suggest.py`** is today a **single-shot** model call: it emits `propose_changes` all at once, with **no read tools** and **no loop**. This is the thing we are replacing with an agentic loop.
- **`map_context.py`** already assembles grounding (claims / citations / short refs). This is the seed of retrieval-on-demand.
- **Endpoint pipeline** `_build_suggestion` → `_repair_new_lane_temp_ids` → `_drop_orphaned_consumers` validates and normalizes proposed ops.
- **Frontend** `suggestion-apply.ts` (pure planner) + the canvas `applySuggestionBatch` executor + `suggestion-card.tsx` (cards, Apply / Apply-all, per-card Undo, Dismiss) is **done and reused as-is** — agent proposals surface as the same cards. This is why **the loop does not depend on solving canvas auto-layout**: proposals live in the card list, not overlaid on the canvas.

---

## Layer 0 — The loop core  *(ACTIVE FOCUS)*

The engine everything else plugs into. Its shape — especially the tool contract and how proposals + provenance events are emitted — determines what Layers 1–3 look like, which is why it goes first.

**In scope:**
- The agentic loop: model → tool calls → observations → repeat → answer/propose, with a turn/step/token budget and explicit stopping rules.
- **Tool surface + read/write split** = the permission boundary. Read tools (`search_claims`, `get_node`, `lookup_citation`, …) run free in-loop. `propose_*` write tools **do not mutate** — they emit suggestion ops that route through the existing card → Apply human gate. Nothing auto-applies.
- **Retrieval-on-demand as the context strategy** — the loop pulls map/doc slices through tools rather than stuffing the whole map + history into context. This is the real answer to "don't load everything every chat," and it lives here, not in Layer 1.
- **Grounding enforcement in-loop** — a proposal carries the claims it consulted; ungrounded proposals are flagged, not hidden (ties to the non-sycophantic / gap-detection behaviors in the AI-assistant vision).
- **Activity narration** — surfacing the *real* tool calls as they happen (the honest version of the "activity" descoped in 2.1b).
- **Provenance emission** — each tool call / proposal becomes an auditable event feeding the change-provenance north star.

**Open questions to resolve in the Layer-0 brainstorm:**
1. Read-vs-write boundary + the exact initial tool set (which reads, which `propose_*`).
2. Loop control: turn/step/token budget, stopping rules, cost/latency of many model calls.
3. How activity notes render in the existing chat UI and interact with pause/cancel.
4. Where grounding is enforced (tool layer vs. synthesis vs. both) and how "not grounded" shows on a card.
5. Relation to the provenance event-stream: does the loop require Phase 1 of that, or emit an interim shape?
6. Streaming — the loop makes it genuinely useful again (legible progress).
7. Tool-error recovery — what the model sees when a tool fails, and how it recovers.
8. Staleness/concurrency — the map can change under a running loop (another user, or the user applying a card mid-session).
9. Mid-loop steering — injecting a correction while the loop is working (distinct from pause/cancel).

---

## Layer 1 — Session & context runtime  *(deferred)*

- What composes context: system prompt, session transcript, retrieved slices — and the **context-window meter** the user sees.
- Session lifecycle: **new / compact / clear**.
- Storage, retention policy, and **user-scoping via Entra** (the eventual sign-in method).
- Cross-session memory: does the agent remember decisions/preferences from prior sessions on the same project, or start cold?

## Layer 2 — Config & capabilities surface  *(deferred)*

- Model choice, context budget, thinking effort — surfaced in a chat menu (decide which are user-configurable).
- Capability toggles (web browsing, etc.). Note: a capability is just an **extension of the Layer-0 tool surface**, so its mechanics are L0-shaped even though the UI is L2.

## Layer 3 — Feedback & evaluation  *(deferred)*

- Thumbs up / down + free-text comments on messages.
- Observability: what's traced, where it's stored, retention.
- Eval framework — two distinct needs: **offline** curated task suites (does the loop produce correct, grounded proposals?) and **online** signal derived from real user feedback. Both depend on reproducible traces (see cross-cutting below).

---

## Cross-cutting aspects (surface in the layer where each lands, but don't lose them)

- **Prompt injection / trust boundary** — source docs *and* any web content are untrusted input. A browsing capability plus write-tools is a real injection surface. Needs an explicit trust boundary (primarily L0/L2). **Security-sensitive; do not defer silently.**
- **Cost governance** — many model calls per loop; per-user / per-project budgets, rate limits, cost attribution. Distinct from observability (L0 emits the data, L3 stores/reports, budgets may gate at L0/L2).
- **Reproducibility** — replaying a stored trace is the substrate for debugging *and* evals; it constrains how L0 logs. Decide the trace shape early even though eval tooling is L3.
- **Web results as sources** — if browsing is on, do web findings enter the claims/provenance model or stay ephemeral? (L0 tool-result handling × provenance model.)
- **Guardrails on write scope** — can a single loop propose 50 changes at once? Batching/limits (L0).

---

## Sequencing

1. **Layer 0 — loop core** *(now)*. Emit provenance events in whatever interim shape is cheapest if the full event-stream isn't built yet.
2. Provenance event-stream Phase 1 (its own spec) — can run before or alongside, informed by what L0 needs to emit.
3. **Layer 1 — session/context runtime** — once the loop's context strategy is proven, formalize sessions, the meter, storage, and Entra scoping.
4. **Layer 2 — config & capabilities** — add model/effort/context controls and the first non-map capability (likely web browsing, which forces the injection boundary).
5. **Layer 3 — feedback & evaluation** — thumbs/comments + observability storage + eval suites, built on the trace shape fixed in L0.

Layers 1–3 are roughly ordered but not rigidly gated; the trace/provenance/injection cross-cutting concerns must be *considered* in L0 even though their full builds come later.
