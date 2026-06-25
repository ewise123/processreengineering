# Suggest-Mode UI — Design

**Date:** 2026-06-25
**Status:** Approved, pending implementation plan
**Branch:** `feat/chat-suggest-mode-ui`

## Context

The chat-suggest backend already exists. `POST /process-maps/{model_id}/versions/{version_id}/chat-suggest`
returns `message` (prose) + `suggestions[]` (typed, applyable changes) + `mention_sources[]`.
Each `ChatSuggestion` carries `id`, optional `group`, `title`, a typed `op`, resolved
`affected_refs` (real UUIDs), `rationale`, and `cited_claim_ids`. There are 12 op kinds.

The frontend chat (`right-panel.tsx` → `ChatTab`) currently hardcodes `mode: "ask"` and never
renders `suggestions`. Frontend types already exist in `src/lib/types.ts` (`ChatSuggestion`,
`SuggestionOp`, `OpKind`, etc.).

The canvas (`bpmn-canvas.tsx`) exposes an imperative `BpmnCanvasHandle` with mutation primitives
(`updateNode`, `deleteNode`, `addProposedStep`, internal `createEdgeImpl`/`deleteEdgeImpl`/
`updateEdgeLabel`) and an undo stack via a `record({ do, undo })` helper. Some op kinds map directly
to the handle; edges/lanes/decompose need new plumbing.

This build is **frontend-only**: no backend changes. It is the centerpiece of the chat feature —
turning the existing suggestion engine into an applyable, Word-style tracked-changes experience.

## Decisions (locked)

1. **Apply coverage:** full — all 12 op kinds are applyable.
2. **Apply granularity:** per-card + `Apply all`, auto-bundling dependent ops.
3. **Undo model:** per-card inline Undo + canvas Cmd+Z for undoable ops; delete-type ops require a
   confirm and are non-undoable.
4. **Architecture:** Approach C — pure planner module + a single canvas executor method.

## Architecture (Approach C)

Three layers with clear boundaries:

1. **`suggestion-apply.ts`** (pure, no React, unit-tested)
   - `bundleSuggestions(suggestions): Bundle[]` — groups suggestions into bundles.
   - `planBundle(bundle, graphIndex): MutationPlan` — produces an ordered, tmp_id-resolved list of
     mutation steps plus a per-bundle classification.
   - Validation: stale-ref detection, tmp_id resolvability, delete-containing classification.
   - Knows nothing about the canvas or the network — it emits a declarative plan.

2. **Canvas executor** (in `bpmn-canvas.tsx`)
   - One new handle method `applySuggestionBatch(plan): Promise<BatchResult>` that executes the plan
     against existing mutation primitives, records a single **grouped** undo entry (for undoable
     bundles), and returns `{ ok, createdIds, undo }`.
   - New thin primitives as needed: re-point edge (delete+create), create lane (with computed
     `order_index`), create node at a computed position.

3. **`suggestion-card.tsx`** (presentational)
   - `SuggestionList` maps bundles → `SuggestionCard`s.
   - `SuggestionCard` renders title(s), rationale, claim chips, affected-object links, and the
     Apply / Dismiss / Undo / confirm controls. Visual vocabulary matches the existing
     `ai-edit-panel.tsx` cards (title + rationale + claim chips + accept/reject row).

## Bundling rule

A **bundle** is a set of suggestions joined by **either**:
- a shared non-null `group`, **or**
- a tmp_id dependency (one suggestion's op references a `tmp:N` produced by another's `temp_id`).

Computed with union-find over both relations. Independent suggestions are singleton bundles. Each
bundle renders as one card. `Apply all` applies every still-pending bundle in document order.

## Op → mutation mapping (all 12)

| Op kind | Mutation(s) | Undoable? |
|---|---|---|
| `relabel_node` | `updateNode{ name }` | ✅ |
| `describe_node` | `updateNode{ description }` | ✅ |
| `move_to_lane` | `updateNode{ laneId }` (lane_ref may be a tmp) | ✅ |
| `relabel_edge` | `updateEdge{ label }` | ✅ |
| `add_edge` | `createEdge` | ✅ |
| `add_node` | `createNode` — canvas places near `near_node_ref`, else appends in lane | ✅ |
| `add_lane` | `createLane` — canvas computes `order_index` (append) | ✅ |
| `rename_lane` | `updateLane{ name }` | ✅ |
| `decompose` | chain of `createNode` + `createEdge` (parent → first → … ) | ✅ |
| `remove_node` | `deleteNode` | ❌ delete-containing |
| `remove_edge` | `deleteEdge` | ❌ delete-containing |
| `reroute_edge` | `deleteEdge` + `createEdge` (no endpoint PATCH — see below) | ❌ delete-containing |

**Backend constraint:** `EdgeUpdate` accepts only `label`/`bend_x`/`bend_y`, **not** source/target.
So `reroute_edge` is implemented as delete-old + create-new, which makes it delete-containing.

**`NodeCreate`** requires `lane_id` + `x` + `relative_y`; **`LaneCreate`** requires `order_index`.
The canvas executor owns this geometry (placement, ordering) — the planner only carries semantic
fields (label, type, target lane, near-node hint).

### Undoability rule

A bundle is **undoable** only if *every* op in it is undoable. If a bundle contains any
delete-containing op, the whole bundle is non-undoable:
- requires an inline confirm before Apply,
- gets **no** inline Undo button,
- is **not** pushed onto the canvas Cmd+Z stack.

This is consistent with the existing canvas convention that node/edge deletes aren't undoable.
Pure edit/create bundles get a single grouped Cmd+Z entry **and** an inline Undo button (both
revert the entire bundle).

### `decompose` semantics (defined simplification)

Create each `sub_step` as a new node, chained by edges (`sub_step[0] → sub_step[1] → …`), with an
edge from the original node to the first sub-step. Each `edge_label` annotates the edge leading into
that sub-step. Sub-steps land in the parent node's lane unless the sub-step's `role` resolves to an
existing lane name. The original node is **kept** (not deleted), so `decompose` stays fully
undoable. Composed entirely from `createNode` + `createEdge` primitives within one bundle.

## tmp_id resolution

The planner processes a bundle's ops in document order, maintaining a `tmp:N → realId` map populated
as create-ops execute in the canvas. Any op field equal to `tmp:N` is resolved at execution time
against that map. The planner validates that every referenced tmp is produced by an earlier op in
the same bundle; an unresolvable tmp marks the bundle unapplyable (defensive — the backend already
validates this, but the UI must not crash on bad input).

## Data flow

1. User toggles **Suggest** in the composer and sends → `api.chatSuggest(..., { mode: "suggest" })`.
2. Response `{ message, suggestions, mention_sources }` is stored on the assistant `ChatItem`:
   `{ role, content, sources, suggestions, suggestionStatus }`, where `suggestionStatus` maps a
   bundle id → `"pending" | "applied" | "dismissed"`. Status persists in the existing session store
   so a reload keeps card state.
3. Prose renders via the existing `ChatMsg`. Below it, `SuggestionList` renders the bundles.
4. **Apply** on a card → `planBundle(...)` → `onApplySuggestions(plan)` (new RightPanel prop) → page
   → `canvasRef.applySuggestionBatch(plan)`. On success the card flips to **Applied ✓** and holds
   the returned in-memory undo handle. (The handle is not persisted, so a reloaded applied card
   shows no inline Undo — Cmd+Z still works for that session only.)
5. Claim chips reuse `onOpenSource`; affected-object links reuse `onNavigate` (teleport + flash).
6. **Apply all** iterates pending bundles sequentially, stopping/surfacing on first failure.

## Mode toggle

A small segmented **Ask | Suggest** control in the composer (next to the existing example-prompts
Sparkles button). The chosen mode is sent on the request. Example prompts become mode-aware
(suggest-mode examples lean toward change requests, e.g. "Add the missing approval step",
"Fix the order of these two steps"). Default mode on a fresh thread: **Ask** (unchanged behavior);
the toggle is remembered for the session.

## Error handling

- **Per-bundle Apply failure:** card enters a `failed` state showing the error + a **Retry** action.
- **Partial multi-op failure:** steps already executed in that bundle are rolled back via the
  inverse the executor accumulated, so a half-applied bundle never persists.
- **Stale refs** (an object referenced by the op was deleted since the suggestion was generated):
  the bundle is marked **unapplyable** with a clear note instead of throwing. Detected in the
  planner against a current graph index passed in at plan time.

## Component / file plan

- **New** `src/components/canvas/suggestion-apply.ts` — pure planner (bundling, planning, tmp_id
  resolution, classification, stale-ref detection) + exported types (`Bundle`, `MutationPlan`,
  `MutationStep`).
- **New** `src/components/canvas/suggestion-apply.test.ts` — unit tests for the planner.
- **New** `src/components/canvas/suggestion-card.tsx` — `SuggestionList` + `SuggestionCard`
  (presentational; Apply / Dismiss / Undo / inline confirm; claim chips; affected links).
- **New** `src/components/canvas/chat-tab.tsx` — extracted `ChatTab` + `ChatMsg` from
  `right-panel.tsx` (targeted improvement: `right-panel.tsx` is ~1325 lines; the chat surface is the
  piece growing here, so it earns its own file). Now also owns mode toggle + suggestion threading.
- **Edit** `src/components/canvas/bpmn-canvas.tsx` — add `applySuggestionBatch` to the handle +
  needed primitives (reroute via delete+create, create lane with order, create node at position),
  exposed through `useImperativeHandle`.
- **Edit** `src/components/canvas/right-panel.tsx` — render extracted `ChatTab`, thread the new
  `onApplySuggestions` prop down from the page.
- **Edit** `.../versions/[versionId]/page.tsx` — implement `onApplySuggestions` delegating to
  `canvasRef.applySuggestionBatch`, pass to `RightPanel`.
- **Edit** `src/lib/api.ts` — pass `mode: "suggest"` (the method already accepts a mode in its body;
  no signature change expected).

## Testing

- **Pure planner** (`suggestion-apply.test.ts`): bundling by shared `group`, bundling by tmp_id
  dependency, union of both; document-order preservation; tmp_id resolution and unresolvable-tmp
  rejection; delete-containing classification (incl. `reroute_edge`); stale-ref detection; the
  full op→step mapping for each of the 12 kinds.
- **Canvas executor + card interactions:** verified manually in the running app (consistent with how
  existing canvas behavior is covered), exercising Apply, Apply-all, Undo (inline + Cmd+Z), the
  delete confirm, and the failed/retry path.

## Out of scope

- Backend changes of any kind.
- An agentic tool-loop (the model directly mutating the map) — that remains a later phase.
- Streaming suggestions; the response arrives whole, as today.
