# How the POET AI assistant works

_Last updated 2026-05-07 — pairs with PR #17 (Phase 3c-ii)._

This doc explains, in plain language, what the in-canvas AI assistant does, what it grounds its answers in, and what it deliberately won't do. It's intended for stakeholders and product reviewers — engineers should read alongside the file pointers at the bottom.

---

## What the assistant is for

A reviewer opens a process map and wants to challenge it: _Should there be a step before this? Is this label correct? Looks like there's a gap between these two — is anything missing?_

The assistant answers those questions, grounded in the project's own source documents. It's not a label-rewrite tool, not a chatbot disconnected from the map, and not a yes-machine that agrees with the user's framing.

---

## What the assistant sees each turn

Every time the user sends a message, the backend gathers a fresh snapshot and sends it to the model:

- **The map currently open** — every lane, every node (label + type), and every edge (source → target with optional label). Each one gets a short id (`L1`, `N1`, `E1`) so the model can refer back to it precisely.
- **All extracted claims for the project** — kind (e.g. _task_, _threshold_, _SLA_), the one-sentence statement of the claim, and the first verbatim quote from the source document along with the source name. Each claim gets an id (`C1`, `C2`…).
- **Which node, edge, or nothing the user has selected** — passed as "context", not as a hard constraint.
- **The full conversation history so far in this session** — questions and answers from this thread.

These are stitched together into a single context block the model receives _before_ the user's new message. The user's message is the only thing that changes turn-to-turn, which lets the model's prompt cache work and keeps response time + cost reasonable.

---

## The rules the assistant follows

The system prompt the model receives spells out four hard rules (described in plain language below; canonical text at the file pointers further down):

1. **Ground every substantive claim.** When the assistant states a fact about the process, it has to point at the supporting claim by id. It cannot invent steps, owners, timings, or thresholds that aren't in the claims.
2. **No sycophancy.** If the user's premise contradicts the source documents, the assistant has to say so. It can't open with "great question" or hedge to soften disagreement. It has to say "I don't know" or "the sources don't say" rather than guess.
3. **General process knowledge is allowed but labeled.** The model knows what a typical AP process or data pipeline tends to look like. It can use that knowledge — but only if it labels it as "general pattern" and frames it as a question ("most processes like this also have X — does that exist here?"), never as an assertion about _this_ process.
4. **Selection is context, not scope.** When the user clicks on a node and asks "is anything missing here?", the assistant freely reasons about neighbors, the lane, and the upstream/downstream path. It doesn't restrict itself to that one node.

The output is plain prose — short paragraphs, occasional lists, usually under 200 words unless the user asks for depth.

---

## What it deliberately won't do today

- **No web access.** The model can't look up vendor docs, regulations, or examples on the internet during a chat.
- **No corpus of similar processes.** The model doesn't have a library of "what other AP processes / data pipelines / etc. look like" to compare against. (See _Roadmap_.)
- **No auto-edits.** The assistant never modifies the canvas. Anything it suggests is just text — the human applies it through the existing edit controls.
- **No persistence across reloads.** Each chat thread is kept in the browser tab only. Refreshing the page starts a fresh conversation. (See _Roadmap_.)

---

## Where the answers come from

The assistant's answers blend three layers, in priority order:

1. **The project's own claims and citations** — extracted from the documents the user uploaded into this project (interviews, SOPs, etc.). This is the primary grounding source.
2. **The current shape of the map** — what nodes exist, which lanes they're in, how the edges connect them. Useful for "is there a gap between these two steps?".
3. **General process-domain knowledge from the model's training** — used cautiously, labeled when it appears, framed as a question rather than an assertion.

The assistant is required to cite layer 1 (claims) explicitly. Layer 3 must be flagged. Layer 2 is observable from the map itself.

---

## Roadmap

These are captured against later sub-phases of POET 3c (and beyond). Order is approximate.

- **Persisted chat threads per project.** Threads survive reloads, can be resumed for a while, and eventually archive — the model the user described as "Claude Code session resume."
- **AI-proposed concrete edits with explicit Apply.** The assistant can offer "I'd suggest renaming N3 to X — apply?" with a button the human hits. Edits still flow through the same audit-tracked PATCH endpoints.
- **Process-knowledge RAG corpus.** A growing library of similar real processes, tech-stack-aware. So the assistant can say things like _"in pipelines using dbt + Dagster + DLTHub, there's typically a transformation step between ingestion and modeling — is that intentionally absent here?"_ This is the largest long-term piece.
- **Stakeholder review wiring.** Threading review state (approved / changes requested / pending) into the assistant's reasoning so it can flag steps that haven't been reviewed yet.

---

## For engineers — pointers to the canonical text

| Behavior | Where to look |
| --- | --- |
| The system prompt verbatim, including the four hard rules | `backend/app/services/map_chat.py` — `SYSTEM_PROMPT` constant |
| How the map context block is rendered (short-id scheme, claim/citation rendering) | `backend/app/services/map_chat.py` — `build_map_context()` |
| What gets pulled from the database to feed the model | `backend/app/api/v2/process_maps.py` — `chat_with_map()` endpoint |
| Multi-turn history shape and the request/response schemas | `backend/app/schemas/process_map.py` — `ChatTurn`, `ChatRequest`, `ChatResponse` |
| The model used and the timeout | `backend/app/services/map_chat.py` — `CHAT_MODEL`, `MAX_TOKENS`, `timeout=` argument |
| The chat sidebar UI + in-memory history | `src/components/canvas/chat-sidebar.tsx` |
| The toolbar **Assistant** toggle and panel-shift logic | `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — `chatOpen` state |

Tuning levers without changing structure: the model name (`MAP_CHAT_MODEL` env var), the rules text in `SYSTEM_PROMPT`, and the context budget by editing `build_map_context` to truncate or summarize when maps get large.
