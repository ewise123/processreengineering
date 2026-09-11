# Product Roadmap

**Product name:** *rebrand in progress* — "POET" is the tool we forked from and is being retired (see Workstream: Rebrand).
**Status:** Living document. North star + sequence locked 2026-07-01.
**Audience:** The two of us building this. A working tool, not a stakeholder deck — honest about what's shaky.

---

## How to read this (and how we'll keep it useful)

A roadmap is **not** a feature list with dates. It's an *ordered set of outcomes*, sequenced so earlier work unblocks later work. The order here is **topological, not by excitement** — foundations the most other things depend on come first.

Three horizons, no calendar dates (dates on a two-person team are fiction; dependencies are real):

- **Now** — in-flight work + the cheapest foundations that unblock the most.
- **Next** — the things that make the AI a real expert and open the door to collaboration. Each becomes its own brainstorm → spec → plan when its turn comes.
- **Later** — the full consultant workflow and scale concerns. Directional, deliberately not detailed yet.

When we finish something, move it to a "Done" section with the PR. Re-sequence by asking "what does this unblock?", not "what do I feel like building?"

### Near-term milestone
**~2 weeks: internal show-and-tell.** Internal stakeholders only, *not* real usage — a demo. Implication: no auth needed for it; prioritize a **stable, impressive happy-path** (grounded map generation + the AI editing story are the highlights).

---

## North Star

> **The product is a living, evidence-grounded process model.** Stakeholders get a clear current-state map as the deliverable; behind it, every node, edge, and decision is version-controlled and traceable to the exact source it came from and the reasoning that changed it — with an AI that is a genuine expert in *your* process because it is grounded in your evidence.

The map is the visible surface and a real deliverable. The differentiator is everything underneath: **the boxes are earned.** Visio and Lucid draw the surface and know nothing about what it means or where it came from — that's the moat.

**Explicitly out of scope** (came with the original fork, not the product): the consulting deliverable factory (RACI, controls/risk, LEAN docs, GM docs), process mining / event logs, business-case generation. Future-state & optimization are *Later*, not *never*.

### The four pillars

| # | Pillar | What it is | State today |
|---|--------|-----------|-------------|
| P1 | **Agentic edit loop** | The AI's hands: read → propose → human-gated apply | Read-only loop built & tested; **write/propose is the active branch, not merged** |
| P2 | **Provenance / tracking spine** | Every change recorded with intent + evidence | **Strong foundation** (`ChangeEvent`, 24 write sites, history UI); design being re-examined; proposals & validation not yet in the stream |
| P3 | **Grounded knowledge base** *(the linchpin)* | A searchable KB the AI is grounded in — claims mapped to the *exact* piece of the *exact* file | **Least built.** Extraction + citations exist; embeddings write-only, search keyword-only, span-pinning best-effort |
| P4 | **Consultant workflow** | AI finds gaps/contradictions from sources; stakeholders validate in-app, fully tracked | **Largely unbuilt**, and **blocked on authentication** (none exists today) |

**Inputs include existing process maps** (Visio/BPMN/Lucid) alongside interviews and notes.

**Cross-cutting principle — the AI never invents.** It flags when a claim or recommendation isn't grounded. This must hold for the edit agent (P1), the KB (P3), *and* the gap-detector (P4). Not one feature — a property of every AI surface.

---

## Honest current state (you are here)

From a fresh code audit — not optimism. The core spine genuinely works end-to-end and is more solid than most prototypes at this stage.

**Genuinely works (wired, persisted, tested):**
- Projects → upload → parse (PDF/DOCX/PPTX/XLSX/TXT) → **claim extraction with verbatim-quote citations** → conflict detection → **generate a BPMN map from claims** → edit on a **fully backend-persisted canvas** (nodes, edges, lanes, routing, decompose-to-sublevel, versioning, review states).
- **Provenance citations on every node** — real data. Click a node → see the claims → open the source doc with the quote highlighted.
- AI chat: **ask-mode** (grounded answers) + **suggest-mode** (applyable cards with real inverse-op undo).
- **Read-only agent loop** (bounded multi-round tool use, logged as `AgentRun`).
- **Append-only change-event log** — the P2 backbone — written from 24 sites with actor / source / reason / citations.
- ~330 backend tests against a **real Postgres**.

**Looks more finished than it is — do not build on these blind:**
- **No authentication at all.** Hardcoded `dev@local` user; `/login` is dead markup; CORS wide open. Single-user, fully open.
- **Embeddings are a write-only dead-end** — vectors stored, never queried. No semantic search; "search" is keyword-only.
- **The agent can't write** — the loop is read-only by design.
- **No async/background processing** — parse, N-call extraction, generation, and the agent loop all run *inside the HTTP request*; big documents time out rather than stream.
- **Conflict detection doesn't scale** — every claim goes into one prompt.
- **BPMN XML export is stale** — reflects the original generation, not canvas edits.
- **The "ungrounded answer" warning is dead code** — fetched, never rendered. A core promise, currently invisible.
- **Zero frontend component/E2E tests.** Chat history + undo are in-memory / sessionStorage — wiped on reload.

**Likely fork residue** (confirm before assuming these are "in progress"): inert tables `analyses`, `outputs`, `generation_jobs`, `entities`, `review_comments`.

---

## Now

*In-flight work + the cheapest foundations that unblock the most. The design item leads; the rest can largely run in parallel between us.*

### N1 — Provenance model brainstorm & design lock — **P2** *(leads)*
Before hardening anything: re-examine how provenance / record / history *should* actually work. The current event-stream design (`docs/superpowers/specs/2026-06-29-change-provenance-event-stream-design.md`) may be right, or may need rethinking. This is a **brainstorm → design** activity, not code.
- **Gates:** N3 (Phase-1 build) and X5 (canonicalization). N2's provenance emission stays *interim* until this locks.
- **Size:** design effort. Do this first.

### N2 — Finish the write/propose agent loop (Layer 0.5) — **P1**
The active branch. `propose_*` tools that **do not mutate** — they emit ops through the existing card → human-Apply gate. Highest momentum.
- **Depends on:** read-only loop (done), suggestion-card pipeline (done).
- **Emits provenance in an interim shape** pending N1; the N1/N2 seam (how a proposed/applied change is recorded) must be agreed before final emission.
- **Size:** M. Plan written (`docs/superpowers/plans/2026-07-01-agent-loop-write-propose.md`). A strong demo highlight.

### N3 — Provenance Phase 1: origin integrity + proposals in the stream — **P2**
Once N1 locks the model: make origin **server-authoritative** (kill the forgeable client `ai_applied` flag); persist chat proposals as events when acted on (`proposed` = ai, `accepted`/`dismissed`-with-reason = human).
- **Depends on:** N1. **Size:** M.

### N4 — Render the ungrounded-answer signal — **cross-cutting**
Backend already returns a `grounded` flag; the frontend fetches and discards it. Wire it to a visible signal on chat answers and suggestion cards. Small, restores a core promise, and demos well.
- **Depends on:** nothing. **Size:** S.

### N5 — Fork-residue cleanup *(deferred — not yet)*
Confirm which of `analyses`, `outputs`, `generation_jobs`, `entities`, `review_comments`, and the write-only embedding column are dead vs. intended. Remove/quarantine dead ones. **Keep the embedding column — wanted for X2.** Parked at the user's request; pick up when convenient.
- **Size:** S–M.

---

## Next

*Make the AI a genuine expert, and open the door to collaboration. Each gets its own spec when its turn comes.*

### X1 — Robust file-ingestion pipeline — **P3 foundation** *(elevated: heavy docs incoming)*
Some real documents will be large. Build ingestion that holds up: **async/background processing** (off the request thread — this is the current request-blocking wall), reliable chunking, progress/status, multi-format robustness, retry on failure. Everything downstream (grounding, extraction quality) rests on this.
- **Depends on:** parse layer (done). **Absorbs** the old async/background work. **Size:** L. Prioritize — flagged as very important.

### X2 — The grounded knowledge base (the linchpin) — **P3**
The highest-value, hardest, most research-shaped work. Two halves:
- **(a) Exact source-span grounding** — a claim maps to the precise span (page/section/char-range), reliably (today's highlighting is best-effort matching). The whole differentiation rests here.
- **(b) Real retrieval** — decide the method (vector / graph RAG / hybrid), turn the write-only embeddings into actual search, give the agent **retrieval-on-demand**.
- **Depends on:** X1 (clean ingestion feeds grounding). **Size:** L. Deserves its own brainstorm before code.

### X3 — Authentication & identity — **prerequisite for P4**
Real login, users, org/project membership, server-side identity on every request. Touches every endpoint.
- **Timing:** stays here — the ~2-week demo is show-only (no real users), so auth isn't needed for it. It's the gate for the entire collaboration pillar and invasive to retrofit — don't discover it late.
- **Depends on:** nothing technical; everything in P4 depends on *it*. **Size:** L.

### X4 — Import existing maps as input — **P1/P3**
Ingest Visio (`.vsdx`) / BPMN XML / Lucid exports and ground them into the model (map elements → claims → the source map as evidence). Confirmed in scope: engagements often start from an existing map + interviews.
- **Depends on:** the model + grounding substrate; benefits from X2(a). **Size:** M–L.

### X5 — Provenance Phase 2: validation = canonicalization — **P2 → P4**
The **applied vs. canonical** distinction: an AI-authored change is *applied* but not *canonical* until a human explicitly validates it, with reasoning. Derived status rollup + a "validated map" filtered view.
- **Depends on:** N1 (locked model), N3 (proposals in stream), X3 (who validates?). **Size:** M.

---

## Later

*The full consultant workflow. Directional — we'll detail each when Next is well underway.*

- **L1 — AI gap / contradiction / change detection (P4).** Find missing steps, inconsistencies, and contradictions *strictly from the sources*, grounded via X2. Includes fixing conflict detection to scale (today it stuffs every claim into one prompt).
- **L2 — Tracked stakeholder validation workflow (P4).** In-app sign-off where every decision + its reasoning is recorded. Needs X3 (identity) + X5 (canonicalization).
- **L3 — Provenance Phase 3.** Contestation / staleness events; agent queries like *"why was step X dismissed?"* — the institutional-memory payoff.
- **L4 — Current-state map export fidelity.** Since the map is a deliverable, make export reflect canvas edits (BPMN XML is stale today) + clean PNG/SVG/PDF for stakeholders.
- **L5 — Future state & optimization.** The explicitly-later ambition.

---

## Parallel workstreams (not on the dependency spine)

### Rebrand from "POET"
POET is the forked tool's name and must be retired. Needs a naming/branding brainstorm → a working name (ideally before the ~2-week demo so we're not showing someone else's brand), then applied across UI, repo, and docs. Creative work — run it as its own brainstorm.

---

## Cross-cutting principles & tech debt (true across all horizons)

- **Anti-invention** (N4 and beyond): every AI surface flags ungrounded output. Non-negotiable.
- **Emit provenance from day one**: any new write path (agent, import, validation) records into the P2 stream — never bolt attribution on later.
- **Frontend testing**: zero component/E2E coverage today. Add alongside features, not as a debt sprint.
- **State durability**: chat history + undo are non-durable. Fine for a prototype; revisit before people rely on it.

---

## Dividing the work (for the two of us)

Two ownership tracks fall out of the dependency graph:

- **AI / intelligence track:** N2 (write loop) → X1 (ingestion) → X2 (knowledge base) → X4 (map import) → L1 (gap detection). The "make the AI an expert" spine.
- **Trust / platform track:** N1 (provenance design) → N3 (Phase 1) → X3 (auth) → X5 (canonicalization) → L2 (stakeholder validation). The "make it accountable and collaborative" spine.

N4 is small (either of us). **Coordination point:** N1 and N2 touch the same seam (how a proposed/applied change is recorded) — lock the provenance model (N1) before N2 finalizes emission, or we build attribution twice.
