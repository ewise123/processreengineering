# Agent Tool Loop — Layer 0: Read-only Investigation Loop (Design)

**Status:** Approved design, 2026-07-01. Ready for an implementation plan.
**Layer:** 0 (loop core) of the agent-tool-loop roadmap.
**Roadmap:** `docs/superpowers/specs/2026-07-01-agent-tool-loop-roadmap.md` — read for the full 4-layer territory and what's deferred.
**Related:** `2026-06-29-change-provenance-event-stream-design.md` (north star), `2026-06-24-chat-suggest-rebuild-design.md` + `2026-06-25-chat-suggest-mode-ui-design.md` (suggestion/apply pipeline the future write loop reuses), `2026-06-24-chat-pause-cancel-design.md` (its "Deferred" section sketched narrated tool calls), and the AI-assistant vision (grounded, non-sycophantic behaviors).

---

## 1. Purpose & scope

Turn the chat's **ask path** from a single-shot model call into an **agentic investigation loop**: the model reads claims, nodes, neighbors, and citations *on demand* through tools, then answers with citations and a "how I found this" trace.

**Why read-only first:** Proposals already work single-shot (suggest-mode → cards). The new value the loop adds is *investigation* — better-grounded, deeper answers — so a read-only v1 delivers that value while isolating the loop machinery (control, narration, grounding, persistence) from the riskier rewrite of the propose path. The propose loop is a deliberate fast-follow that reuses the proven loop.

**In scope (v1):**
- Agentic ask-mode: loop of model → read tool calls → observations → answer.
- Six read-only tools (the permission boundary).
- Retrieval-on-demand context strategy (cheap skeleton + selection seed; detail pulled via tools).
- Bounded loop control with graceful synthesis at the cap.
- Grounding: cited-by-construction + labeled ungrounded content.
- Batch response with a collapsible activity trace.
- A persisted `agent_run` record (observability / reproducibility / eval substrate).

**Explicitly out of scope (deferred to later layers/increments):**
Write/propose loop · streaming/SSE · web browsing · model/effort/context config UI (L2) · session lifecycle, context-window meter, Entra user-scoping, cross-session memory (L1) · thumbs/comments feedback + eval suites (L3) · change-event-stream integration · mid-loop steering.

**Bridge accepted:** ask-mode becomes agentic while **suggest-mode stays single-shot**, so two chat code paths coexist until the propose loop lands. This is an accepted, temporary bridge (user-confirmed).

---

## 2. Architecture & execution model

- New backend module **`map_chat_agent.py`** running a server-side loop on the Anthropic SDK's native tool-use.
- The chat endpoint's **ask branch routes to the agent loop**; the suggest branch is untouched.
- **Model:** the existing env-configured model (`MAP_CHAT_MODEL`, default `claude-sonnet-4-6`). Sonnet is the right default for a many-call loop; per-request model/effort selection is a Layer 2 concern, but the env var already exists.
- **Tools are thin Python functions** over services that already exist: claim search/embeddings, node/edge fetch, citations, conflict detection (`map_context.py` and the Phase 2 claim/conflict services). No new retrieval infrastructure.
- The loop controller owns: assembling the initial context, the model-call/tool-dispatch cycle, budget enforcement, the graceful-synthesis turn, the grounding post-check, and emitting the `agent_run` record.

---

## 3. Tool surface (the permission boundary)

All six are **read-only** in v1. The read/write split *is* the permission boundary; there are no write tools yet.

| Tool | Input | Returns |
|------|-------|---------|
| `search_claims` | `query`, `k` | matching claims: `id`, text, source refs |
| `find_node` | `query` | nodes by label/semantic match: `id`, label, lane |
| `get_node_detail` | `id` | label, lane, description, connected edges, citations |
| `get_neighbors` | `id` | predecessors + successors (gap-detection primitive) |
| `lookup_citation` | `claim_id` | the source excerpt behind the claim |
| `list_conflicts` | — | existing contradiction detections for the map |

**Contract:** every tool returning substantive content returns **stable ids** (claim / source / node) so the answer can cite them. Tool results are returned to the model as clearly delimited **untrusted data** (see §9).

*Tool-set extensibility noted for future:* a full-text `search_sources` (distinct from claim search) and a `get_process_summary` may be added if user questions warrant; not in v1.

---

## 4. Context assembly (retrieval-on-demand)

Initial context injected before the loop starts:
1. **System prompt** — grounded, non-sycophantic behaviors (cite sources; push back when the premise conflicts with sources; say "I don't know"; label general knowledge as not-from-sources).
2. **Cheap map skeleton** — lanes, node labels, adjacency only. **No** descriptions, citations, or history. On very large maps this is capped/summarized (e.g., top lanes + truncated adjacency) — exact cap is an implementation detail, but the skeleton must stay bounded.
3. **Selection seed** — the user's current selection + its immediate neighborhood.
4. **Session transcript** — prior turns (as today, stripped to `{role, content}` for the request).

Everything expensive (descriptions, provenance, source excerpts, deep traversal) is **pulled on demand** through tools. This is the concrete answer to "don't load the whole map + history every chat."

---

## 5. Loop control

- **Hard caps:** `MAX_ROUNDS ≈ 6` tool-call rounds **and** a total-token cap — whichever is hit first.
- **Graceful synthesis at the cap:** when a cap is reached, force one final synthesis turn instructing the model to answer with what it has gathered and **explicitly flag what it could not verify**. The loop always returns a grounded-so-far answer, never a dead end.
- **Normal stop:** the model emits a final answer (no further tool calls) before the cap.
- Caps are constants in v1; effort-tiered budgets are a Layer 2 concern.

---

## 6. Grounding

- Tools carry **claim/source ids**; the **answer schema carries a `citations` array** that renders with the existing per-message source-link UI.
- A **light post-check** flags any substantive assertion that carries zero citations (heuristic, not a second model pass).
- **General process knowledge not in the sources must be explicitly labeled** "not grounded in your sources" and rendered with distinct visual treatment, so grounded vs. general content is never conflated.
- Enforcement is **schema + prompt + cheap post-check** — deliberately not an always-on verifier model pass (that's an eval-grade Layer 3 tool).

---

## 7. Response shape & narration

- **Batch** (no SSE): `{ answer, citations, activity_trace[], run_id }`.
- `activity_trace[]` = one **human-readable line per tool call** ("Searched claims for 'invoice approval'", "Read step: Approve Invoice"), each expandable to the raw call + result.
- Frontend reuses today's markdown + `[[kind:id]]` mention rendering + per-message source links, and adds:
  - a **collapsible "how I found this"** activity list (default collapsed);
  - the **"not grounded"** label treatment.
- **Pause/cancel** stays exactly as today (abort the single fetch via `AbortController`); no change needed because there's no stream.
- Streaming is the immediate next increment and will replace batch delivery of `activity_trace` with live emission.

---

## 8. Persistence — the `agent_run` record

A new persisted record per run (new table + migration). Kept **separate from the change-event stream** (reads are not changes).

Fields:
- identity: `user`, `project`, `map/version`, `session`, `run_id`
- input: `question` (+ context refs / selection seed)
- process: ordered `tool_calls[]` — `name`, `args`, consulted `claim_ids` / `source_ids`, `latency`
- output: `answer`, `citations`
- cost: `token_usage`, `round_count`, `stop_reason` (normal | round_cap | token_cap | error)

Purpose: observability, reproducibility (replay a trace), and the eval substrate — and it **fixes the trace shape early** even though eval tooling is Layer 3. It can later be *projected into* the change-event stream once write tools exist.

---

## 9. Safety & edge cases

- **Tool-error recovery:** a failed tool returns a **structured error** the model can see and adapt to (retry or choose another tool). Infrastructure failures (DB down, etc.) **abort gracefully** with an "I hit an error looking that up" message; the `agent_run` record is still written with `stop_reason=error`.
- **Prompt-injection / trust boundary:** retrieved source/claim content is delimited as **untrusted data**; the system prompt instructs the model to treat retrieved content as data, never as instructions. Blast radius in v1 is bounded (read-only, no writes, no web) — a poisoned source can at worst skew an answer. The **hardened** boundary is revisited when web browsing or write tools land (cross-cutting concern in the roadmap).
- **Staleness / concurrency:** read-only, so effectively a non-issue. A stale id causes a tool to return not-found and the model adapts.
- **Write-scope guardrails:** N/A in v1 (no writes); flagged for the propose-loop increment.

---

## 10. Testing

- **Backend:** fake Anthropic client with **scripted tool-use sequences** (extends the existing test pattern; no API key needed). Unit-test: each tool function; the loop controller (normal stop, round cap, token cap, graceful synthesis, tool-error path); the grounding post-check; the `agent_run` record contents.
- **Frontend:** pure-logic tests (node env, no jsdom) for activity-trace rendering and the "not grounded" labeling.

---

## 11. Sequencing after this spec

1. Implement Layer 0 (this spec) — plan via writing-plans, build via subagent-driven-development.
2. **Immediate follow-on:** streaming/SSE for live activity narration.
3. **Next increment:** the write/propose loop (adds `propose_*` tools that emit ops through the existing card → Apply gate; brings in write-scope guardrails and staleness handling).
4. Then Layers 1–3 per the roadmap.
