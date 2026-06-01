# How this application works

_Last updated 2026-05-28. Pairs with `docs/spec/process-reengineering-spec-v1.1.md` (the full target spec) and `docs/ai-assistant.md` (deep dive on the in-canvas chat). This doc only describes what runs today._

---

## What it does, in one paragraph

A management consultant uploads interview transcripts, SOPs, and other source documents into a project. The app pulls atomic facts out of those documents — "the AP clerk routes the invoice to finance for approval", "SLA is four business hours" — and uses them to draft a swimlane process map the consultant can then edit by hand. Every step on the map traces back to the exact quote in the exact document that justified it, and an in-canvas assistant answers questions about the map using only those grounded claims.

---

## The user journey

### 1. Sign in

Open the app, land on a login screen with email + password and a "Login with Google" button. Today this screen is cosmetic — there is no real authentication wired up yet. Every request is treated as coming from a hard-coded development user. The login form is present so the eventual auth flow has a home, but anyone running the app locally is effectively the same user.

### 2. Pick or create a project

After login, the user sees a list of projects. Each project is a single client engagement — a name, a client, a description. Open one, or create a new one from a small form.

### 3. Upload documents

Inside a project, the **Documents** view is where source material goes. Drag in a PDF, DOCX, PPTX, XLSX, TXT, or Markdown file (up to 50 MB), pick a type from a dropdown — interview transcript, SOP, process-map upload, policy document, and so on — and submit. The file is uploaded, parsed into sections (one per page for PDFs, one per slide for PPTX, etc.), and split into ~1,000-character chunks.

### 4. Extract claims

The user then clicks **Extract**. Each chunk is sent to Claude, which is asked to pull out **claims** — typed statements about how the process works. Claim kinds include actor, task, decision, threshold, SLA, dependency, exception, control, system, and gateway condition. Every claim carries the verbatim quote it came from and the document it came from.

The Documents row shows live progress while this runs — chunks processed out of total, with an ETA. The user can move on; the page polls every few seconds.

### 5. Review claims

A **Claims** view lists everything that was extracted, grouped or filtered by kind, each row showing the quote and the source. This is where the consultant starts to see the shape of the process before any map exists.

### 6. Generate a process map

From the **Maps** view, the user opens **Generate** and fills in a short form: process name, level of detail (L1 through L4), an optional focus phrase if the documents cover several processes, and whether this is a current-state or future-state map. The app sends all the project's claims to Claude and asks for a structured description of the process — steps and gateways, each tagged with the claims that support it. That structure is turned into lanes, nodes, and edges, and the user is redirected onto the canvas.

### 7. Edit on the canvas

The canvas is a swimlane editor. Each lane is a role or system; each node is a BPMN shape (user task, service task, manual task, business-rule task, send/receive task, or an exclusive/parallel/inclusive gateway); edges connect them with orthogonal lines that the user can bend by dragging. The user can:

- drag nodes between lanes,
- resize lane heights,
- pan and zoom,
- undo and redo,
- click a node to open a **Properties** panel on the left, which lets them rename the node (changes save automatically after a short pause), reassign its lane, see the claims and source quotes that justify it, see any conflicting claims, or delete it.

Edits persist optimistically — the canvas updates immediately and the change is sent to the backend in the background.

### 8. Ask the assistant

A tabbed panel on the right of the canvas holds **Chat**, **Issues**, **Sources**, **Versions**, and **Review**. Chat is the in-canvas AI assistant: the user asks questions like _"is there a step missing between these two?"_ and the assistant answers, citing claims by short ID. It will not invent steps, will not flatter the user, and will say "the sources don't say" rather than guess. Full rules and behavior live in `ai-assistant.md`. The chat thread is held in the browser tab only — refreshing clears it.

### 9. Resolve conflicts

A separate action scans the project's claims pairwise and flags contradictions — different interviewees describing the same step differently, an SOP and a transcript disagreeing on an approval threshold. These surface on the **Issues** tab and on the affected nodes in the Properties panel. The consultant decides what to do; the app does not auto-resolve them.

That is everything the app currently does end-to-end.

---

## How it works under the hood (simply explained)

### The two halves

The frontend is a Next.js 16 / React 19 app served on port 3000. The backend is a FastAPI service on port 8000. A Postgres 16 database (with the `pgvector` extension) runs in Docker on port 5433. A single shell script, `run-local.sh`, brings the whole stack up locally.

### The data flow

Documents go through a chain of transformations, and each stage keeps a pointer back to the previous one:

```
Document  →  ParsedSections  →  Chunks  →  Claims (with Citations to a Chunk)
                                                  ↓
                       ProcessVersion  →  Lanes / Nodes / Edges
                                                  ↓
                            Nodes & Edges link many-to-many back to Claims
```

The point of that last link is the whole point of the product: when the user clicks a node and asks "where did this come from?", the app can answer with the exact quote in the exact document.

### What Claude is asked to do

Three jobs, all to Claude Sonnet 4.6, all blocking the HTTP request — there is no background queue, no streaming:

1. **Claim extraction.** Per chunk, the model is given a tool called `record_claims` with a JSON schema for kind, subject, confidence, and quote. It returns a list of claims; the backend writes them to the database with citations back to the chunk.
2. **Map generation.** Given the project's claims as a numbered list, the model returns JSON describing steps and gateways. Each step and each gateway carries a `claim_refs` array of indices back into that list. The backend turns the JSON into lanes, nodes, edges, and the links that tie each node and edge back to its supporting claims.
3. **In-canvas chat.** Before every reply, the backend builds a fresh context block: every lane, node, and edge in the current map, plus every claim in the project, each with a short ID (`L1`, `N1`, `E1`, `C1`) so the model can cite them precisely. That block goes in the system message, which makes prompt caching cheap across turns of a conversation.

The map-generation prompt requires `claim_refs` on every element. The chat system prompt forbids inventing steps and forbids sycophancy. Those rules are the difference between this app and a generic Claude chatbot.

### Where things live

Postgres holds the lot: identity (Organization, User, ProjectMember), Project, Input + DocumentSection + Chunk, Claim + ClaimCitation + ClaimConflict, ProcessModel + ProcessVersion + ProcessLane + ProcessNode + ProcessEdge with NodeClaimLink and EdgeClaimLink, plus housekeeping tables for Reviews, AuditEvents, AiInteractions, and GenerationJobs. Uploaded files sit on local disk under `backend/uploads/`. No S3, no Redis, no Celery — yet.

### What it does NOT do today

So the doc doesn't oversell:

- No real authentication. The login screen is UI-only.
- No event-log / process-mining workflow. Documents only.
- No future-state generation, no business case, no PowerPoint / Word / Visio export.
- No background workers. Big extractions tie up an HTTP request for the duration.
- Chat history is per browser tab. Refresh and it's gone.
- The right-panel **Versions** and **Review** tabs are placeholders.

---

## Code map

For anyone diving in:

- Frontend pages — `src/app/(app)/` (project list and detail) and `src/app/(canvas)/` (the map editor)
- Custom SVG canvas — `src/components/canvas/`
- API client — `src/lib/api.ts`
- Backend routes — `backend/app/api/v2/` (`projects.py`, `inputs.py`, `claims.py`, `process_maps.py`)
- Backend AI services — `backend/app/services/` (`claims_extraction.py`, `process_generation.py`, `map_chat.py`)
- Database models — `backend/app/models/`
- Local dev stack — `run-local.sh` and `docker-compose.yml`
