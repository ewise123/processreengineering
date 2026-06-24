# Word-Style AI Chat with Suggested Changes — Design

**Date:** 2026-06-24
**Status:** Approved design, ready for implementation planning
**Branch:** `chat-suggest-rebuild`

## Goal

Rebuild POET's in-app AI chat into a single conversational surface modeled on
Claude-in-Word. The chat understands the process map at the object level (nodes,
edges, swimlanes, claims), proposes edits as reviewable **suggested changes**, and
never mutates the map without a human clicking Apply. Suggestions are navigable,
grounded in sources, applied individually or all at once, and dim once applied.

## Background: what exists today

Two separate AI surfaces, which this work unifies:

1. **Chat tab** (`src/components/canvas/right-panel.tsx` → `api.chatWithMap` →
   `backend/app/services/map_chat.py`). Returns **plain text only**. Already
   grounded and non-sycophantic; already accepts a selected node/edge as context.
2. **Per-node "Ask AI to edit this step" panel** (`src/components/canvas/ai-edit-panel.tsx`
   → `api.aiEditNode` → `backend/app/services/map_ai_edit.py`). Returns
   **structured proposals** (relabel / describe / validate / suggest-next /
   decompose) with accept/reject cards, cached per node in `ai-edit-cache.tsx`.

Shared infrastructure we reuse:

- **Grounding spine** — `backend/app/services/map_context.py` (`assemble_map_context`)
  renders a compact map (`N1`, `E1`, `L1`, `C1` refs) plus project claims with
  source quotes, and returns `claim_ref_to_id` / `node_ref_by_id` lookups.
- **Ref-resolution discipline** — the AI cites claims by short refs (`C1`); the
  endpoint resolves them to UUIDs and **drops any fabricated refs**
  (`_resolve_refs`).
- **Apply endpoints** — `applyProposedStep` (node + edge + claim links),
  `applyDecompose` (child version), and the node/edge/lane PATCH + delete endpoints.
- **Canvas state** — `src/components/canvas/types.ts` (`CanvasNode`, `CanvasEdge`,
  `CanvasLane`, `Viewport`) and `bpmn-canvas.tsx` selection
  (`none | node | edge | multi`), with an undo stack (`useUndoStack`).

## Decisions (locked during brainstorming)

- **Scope:** full Word-style rebuild — one unified surface replacing both today's
  surfaces. The per-node ai-edit panel is removed once the chat reaches parity.
- **Edit types:** full structural edits — relabel, describe, add/remove node,
  add/remove/relabel/reroute edge, move-to-lane, add/rename lane, decompose.
- **Reasoning:** free-text rationale **plus** grounded claim citations (clickable
  through to the source quote/document). Leverages the provenance backbone.
- **Apply model:** per-suggestion Apply + group-level "Apply all" with an
  "X of Y applied" counter; applied cards dim with a checkmark.
- **Persistence:** ephemeral — chat history + suggestions live in client state,
  mirrored to `sessionStorage` keyed by version id. No new DB tables. Applied
  changes persist server-side through the existing versioned mutation endpoints.
- **Modes:** an explicit **Ask / Suggest** toggle. Ask answers in prose only.
  Suggest is judgment-based — it emits suggestion cards only when an edit is
  actually warranted; a question still returns prose with zero suggestions.

## Architecture

### Component map

| Today | After |
|---|---|
| Chat tab → `chatWithMap` (plain text) | Same tab, rebuilt → new agentic endpoint returning prose **+ suggestions** |
| Per-node ai-edit dropdown | Folded into chat (actions become asks / quick-prompt chips); panel removed at parity |

New frontend modules (each kept small, per the 200–400 line norm):

- `src/components/chat/chat-panel.tsx` — shell: message list, mode toggle,
  composer, selection chips.
- `src/components/chat/suggestion-card.tsx` — one card: title, navigable body,
  Reasoning disclosure, Apply/Reject, applied/dimmed state.
- `src/components/chat/suggestion-group.tsx` — grouped cards with "Apply all" and
  the "X of Y applied" header.
- `src/components/chat/use-chat-session.ts` — ephemeral session state (messages,
  suggestions, mode), mirrored to `sessionStorage`.
- `src/components/chat/use-suggestion-apply.ts` — translates a diff-op into
  existing canvas mutations plus one undo entry; runs staleness checks.
- `src/components/chat/mentions.ts` — parse `[[N3]]`/`[[E2]]`/`[[C1]]` refs in
  assistant prose into clickable spans.
- `src/components/canvas/use-navigate-to.ts` — the "teleport": pan/zoom to an
  object by id and flash-highlight it. Extends the existing recenter logic in
  `bpmn-canvas.tsx`.

New backend module:

- `backend/app/services/map_chat_suggest.py` — suggestion tool definitions and
  dispatch. The endpoint handler in `process_maps.py` stays thin.

### Suggestion diff-op model (the core)

Each suggestion carries one typed op. Ops reference **real object ids**, or
**temp ids** (`tmp:N`) for objects created within the same response — so a new
edge can point at a new node before either exists.

```
SuggestionOp =
  | { kind: "relabel_node";  nodeId; newLabel }
  | { kind: "describe_node"; nodeId; description }
  | { kind: "add_node";      tempId; lane(ref); nodeType; label; nearNodeId? }
  | { kind: "remove_node";   nodeId }
  | { kind: "add_edge";      from(ref); to(ref); label? }
  | { kind: "remove_edge";   edgeId }
  | { kind: "relabel_edge";  edgeId; newLabel }
  | { kind: "reroute_edge";  edgeId; newFrom(ref)?; newTo(ref)? }
  | { kind: "move_to_lane";  nodeId; laneId(ref) }
  | { kind: "add_lane";      tempId; name }
  | { kind: "rename_lane";   laneId; newName }
  | { kind: "decompose";     nodeId; subSteps[] }
```

`(ref)` = a real id **or** a `tmp:N`. Apply resolves temp ids in dependency order
(lanes → nodes → edges).

Wrapper:

```
Suggestion {
  id, groupId?,                // groupId ties related ops into one "Apply all" unit
  title,                       // e.g. "Add approval gate after Review Invoice"
  op: SuggestionOp,
  affectedRefs: ObjectRef[],   // resolved real ids, for navigation + highlight
  rationale: string,           // the prose "why"
  citedClaimIds: UUID[],       // grounds the Reasoning dropdown in provenance
  status: "pending" | "applied" | "rejected" | "stale"
}
```

## Backend

### Endpoint

`POST /api/v2/projects/{p}/process-maps/{m}/versions/{v}/chat-suggest`

Request:

```
{ history: ChatTurn[],
  user_message: string,
  mode: "ask" | "suggest",
  context_refs: ObjectRef[] }   // the selection chips attached by the user
```

Response:

```
{ message: string,             // prose, may contain [[N3]]/[[E2]]/[[C1]] mention refs
  suggestions: Suggestion[] }   // empty in ask mode, or when suggest judges none warranted
```

### Behavior

Reuses `assemble_map_context`. The model receives: the existing non-sycophantic,
ground-in-sources system persona; the compact map render; the project claims; and
the attached `context_refs` flagged as *"the user is focused on these — context,
not scope."*

- **Ask mode** — no suggestion tools bound. The model answers in prose, citing
  `[[N#]]`/`[[C#]]` refs, which the endpoint rewrites to real ids for the frontend.
- **Suggest mode** — one tool per `SuggestionOp` kind is bound. The system prompt
  instructs: *propose a change only when the sources or structure actually warrant
  one; a question still gets a prose answer with zero suggestions.* Each tool call
  carries `rationale` + `cited_claim_refs`; the endpoint resolves refs → UUIDs and
  drops fabricated ones (existing `_resolve_refs` discipline).

Config: `MAP_CHAT_SUGGEST_MODEL` env var, defaulting to the configured chat model.

### Whole-map consistency scan

A suggest-mode tool (and a "Check this map for problems" quick-prompt) that
surfaces dangling edges, duplicate step names, single-branch gateways, lanes with
no owner, and orphan nodes. Each finding becomes either a suggestion card with a
fix op, or a flagged-gap no-op card (like today's `validate`) where judgment is
required. This replaces the per-node `validate` action with a map-wide one. The
detection logic is a pure function over the map graph, unit-tested against fixtures.

## Frontend UX

### Composer and selection chips

Above the text input, a chip row shows what is attached as context — populated
from the live canvas selection at send time (node / edge / multi / lane each become
a chip). Chips are removable; sending with none is allowed. An **Ask / Suggest**
segmented toggle sits beside the send button.

### Assistant messages

Prose renders with `[[N3]]`-style refs resolved to inline **hyperlink chips**
(showing the object's label). Clicking one teleports and flash-highlights the
object via `use-navigate-to`. Every object mention is a hyperlink.

### Suggestion cards (matches the Word reference)

- **Title** row with a right-side state glyph (chevron-to-apply → checkmark when
  applied).
- **Body** describes the change; affected object names within it are the same
  navigable hyperlink chips. Clicking the card or a chip teleports to the affected
  object; multi-object suggestions expose ‹ › arrows to step through each affected
  object.
- **Reasoning** disclosure, collapsed by default → free-text rationale **plus** the
  cited claims, each linking to its source quote/document.
- **Apply** / **Reject** per card. Applied → dimmed + checkmark. Rejected →
  dismissed, recoverable under a "show rejected" toggle.

### Grouping and Apply-all

Related ops share a `groupId` and render under a group header with **"Apply all"**
and a live **"X of Y applied"** counter. Applying a group runs its ops in
dependency order as a single undo entry.

### Persistence

Session messages, suggestions, and mode mirror to `sessionStorage` keyed by version
id — surviving tab navigation, clearing on hard reload, never hitting the server.

## Applying suggestions

No new persistence. Apply translates each op to **existing** mutation endpoints,
composed into one undo-stack entry per suggestion (or per group for Apply-all):

| Op | Reuses |
|---|---|
| relabel / describe / move-to-lane / relabel-edge / reroute-edge | existing node/edge PATCH endpoints |
| add_node + add_edge | `applyProposedStep` (extended to accept a pre-resolved lane/edge) |
| decompose | `applyDecompose` (unchanged) |
| add_lane / rename_lane | existing lane endpoints |
| remove_node / remove_edge | existing delete + impact preview (below) |

Applied cards flip to `applied`. Undo (Cmd+Z) reverses the whole suggestion as one
step and flips the card back to `pending`.

### Deletions route through impact preview

Applying a `remove_node`/`remove_edge` suggestion does not delete immediately. It
opens an impact preview (what edges dangle, what gets orphaned); the card stays
`pending` until the user confirms there. This integrates with the planned
delete-with-consequences UX when it lands; until then, a minimal confirm dialog
stands in.

### Staleness

Because suggestions are ephemeral and the map can change underneath them (manual
edits, applying another card, undo), each pending suggestion is re-validated
against current canvas state before its Apply button goes live:

- referenced object gone, or the target already matches the proposed value → card
  marked `stale`, Apply disabled, with a "the map changed — ask again to refresh"
  note.

This check lives in `use-suggestion-apply.ts` and runs against the live canvas
store with no server round-trip. It makes group apply-order safe and prevents
applying a card that no longer makes sense.

## Testing

TDD per project norm — tests before implementation on each unit.

**Backend**

- tool-call → `SuggestionOp` mapping for each op kind
- ref resolution, including dropping fabricated claim refs
- ask mode binds no suggestion tools
- suggest mode can return zero suggestions for a pure question
- consistency-scan pure function over fixture maps (each problem type)

**Frontend**

- `mentions.ts` parsing of `[[N#]]`/`[[E#]]`/`[[C#]]` refs
- diff-op → mutation translation for each op kind
- temp-id resolution order (lanes → nodes → edges)
- staleness detection (object gone / value already matches)
- card state rendering (pending / applied / rejected / stale)
- "X of Y applied" counter and group Apply-all

## Out of scope (deferred; the model leaves room for them)

- Comment-anchored requests — drop a note on an object, AI resolves it in-thread.
- Server-persisted or collaborator-shared suggestions.
- The full delete-with-consequences UX (integrated when built; minimal confirm
  until then).
