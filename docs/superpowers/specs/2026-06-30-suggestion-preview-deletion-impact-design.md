# Suggestion Preview ("Walk the Change") + Deletion Impact — Design

**Date:** 2026-06-30
**Status:** Approved, pending implementation plan
**Branch:** `feat/suggestion-preview-deletion-impact`

## Context

Suggest-mode shipped the applyable AI suggestion cards (#37, +fixes #38/#40): a chat
response carries `suggestions[]` that bundle into cards, and **Apply** runs a planned
`MutationStep[]` against the live API via the canvas `applySuggestionBatch` handle. Two
UX gaps remain, both agreed but unstarted:

1. **Walk the change** — there is no way to *see* what a suggestion will do before
   committing it. Apply mutates the map immediately; the user reads card text and trusts it.
2. **Deletion impact** — removing a step silently cuts its edges and can orphan
   downstream steps, with no preview of the fallout and no offer to heal the gap.

This build closes both. It also closes a **provenance gap** the deletion work exposes:
the `DELETE /nodes/{id}` and `/edges/{id}` endpoints take no body and hard-code
`reason="Deleted"`, `source=manual`, `actor=user` — so an AI-suggested deletion is logged
as a *manual user deletion reasoned "Deleted"*, throwing away the suggestion's rationale and
the AI authorship. This is the exact analog of the edit-reason regression PR #38 fixed for
*edits*; the *delete* path never got the same treatment.

Relationship to the north star ([`2026-06-29-change-provenance-event-stream-design.md`](./2026-06-29-change-provenance-event-stream-design.md)):
this build is **Phase 0.5-style interim** — it threads a client `ai_applied`-style flag on
the delete path (mirroring #38), to be removed when the server-authoritative two-event model
(D2) lands. It does **not** build the event stream, validation, or a persisted gap marker.

## Decisions (locked)

1. **Preview model:** ghost preview — render the would-be result on the canvas *without
   persisting*; **Apply** commits, **Cancel** drops the ghosts. (Not highlight-only; not a
   step-by-step walkthrough.)
2. **Preview architecture:** shadow graph — apply the plan to an in-memory copy of the graph
   and render from it in preview mode, styling the diff. One render path, uniform across all
   12 op kinds, and it doubles as the engine for deletion-impact analysis. (Not an overlay layer.)
3. **Deletion impact depth:** show impact + offer an opt-in **auto-bridge** (reconnect a
   removed middle step's predecessor → successor). Fully frontend. A persisted **gap marker**
   is a documented later follow-up.
4. **Delete provenance:** in scope this build — `DELETE` accepts an optional reason + source so
   AI-suggested deletions log their rationale and AI/chat attribution. Plus a **"Removed"**
   objects view in the Change Log so a deleted object's full history is reachable (the node is
   gone from the canvas and can't be selected). Object-centric surface, powered by the
   existing per-target log filter.
5. **Delete-card flow:** the bare "Can't be undone → Apply anyway" confirm is **replaced by
   the impact preview** — applying a removal always routes through "here's what breaks + want a
   bridge?". Non-delete bundles keep direct Apply, with Preview optional.

## Architecture

The build rests on one new pure module that is the single source of truth for both features.

### 1. `suggestion-shadow.ts` (new, pure, unit-tested)

The in-memory engine. Knows nothing about React or the network.

- `applyToShadow(graph: ProcessGraph, plan: BundlePlan): ShadowGraph` — runs the plan's
  `MutationStep[]` against an in-memory copy of the graph, resolving tmp refs as create-steps
  execute (same resolution rule as the real executor). It **mirrors backend FK behavior**:
  deleting a node also removes its touching edges in the shadow, so the preview matches what
  actually happens. New nodes are placed via the shared placement helper (§2) so their
  positions match the real apply.
- `diffGraphs(real: ProcessGraph, shadow: ShadowGraph): GraphDiff` —
  `{ addedNodeIds, addedEdgeIds, addedLaneIds, removedNodeIds, removedEdgeIds,
  changedNodes: {id, fields}[], changedEdges: {id, fields}[], changedLanes: {id, fields}[] }`.
  This drives the ghost styling.

### 2. Pure placement helper (extracted from `bpmn-canvas.tsx`)

New-node placement (`placeNewNode`, near-node geometry) currently lives inside the React
canvas executor. For the preview to match the committed result, both paths must place nodes
identically. Extract placement into a **pure function** that the shadow engine and the real
executor both call. This is the one real refactor; it is what keeps "preview" honest.

### 3. Canvas preview mode (`bpmn-canvas.tsx` edits)

Two new handle methods on `BpmnCanvasHandle`:
- `previewPlan(plan: BundlePlan): PreviewResult` — compute shadow + diff, enter preview mode,
  render from the shadow with ghost styling. Returns the `GraphDiff` (and, for delete plans,
  the `ImpactReport` from §4) so the card can render impact chips.
- `clearPreview(): void` — exit preview, drop the shadow, restore the live render.

While previewing, the canvas renders the **shadow** and styles each delta from the diff,
reusing the existing `aiProposed` ghost vocabulary. **Editing is suspended during preview**
(a stray drag/connect would diverge from the plan). Entering preview for a new plan replaces
any current preview.

### 4. `deletion-impact.ts` (new, pure, unit-tested)

Runs on the shadow. Given the plan's removed node ids:
- **Orphaned nodes** — nodes that, in the shadow, lost their only incoming path (no remaining
  in-edge, and not a start node).
- **Cascade-removed edges** — edges the shadow dropped because an endpoint node was removed
  (so the impact count reflects reality, not just the explicit `remove_edge` ops).
- **Bridge candidates** — for a removed node with exactly **one** predecessor edge and **one**
  successor edge, propose a predecessor → successor edge. Multi-in/multi-out removals offer no
  bridge (ambiguous); they only report the orphan/cut impact.

Returns `ImpactReport { removedNodes, removedEdges, orphanedNodes, bridges: {fromRef,toRef}[] }`.

### 5. UI (`suggestion-card.tsx` + `chat-tab.tsx` edits)

- A **Preview** button per card. Clicking → `onPreview(bundle)` (new prop, threaded
  page-side to `canvasRef.previewPlan(plan)`). The card enters a `previewing` state showing
  **Apply / Cancel**.
- **Delete bundles** surface the `ImpactReport` inline: an IMPACT block with chips
  (`N links cut`, `orphans: …`) and an opt-in **Reconnect X → Y** bridge toggle. Apply for a
  delete bundle *requires* having previewed (it is the replacement for the old confirm).
- **Apply** = the existing `applySuggestionBatch(plan)` extended to append the chosen bridge
  steps; on success the card flips to **Applied ✓** and `clearPreview()` runs. **Cancel** =
  `clearPreview()` and back to pending.

### 6. Provenance (backend + api + executor + Change Log)

- **Backend** `DELETE /nodes/{id}` & `/edges/{id}`: accept an optional `reason` and an
  `ai_applied` flag (query params or a small body, matching how the PATCH path took them in
  #38). `record_change` uses the supplied `reason` and sets `source=chat`/`actor_kind=ai`
  when `ai_applied` is true; defaults stay `reason="Deleted"`/`manual`/`user` so manual
  deletes are unchanged.
- **`api.deleteNode`/`deleteEdge`**: accept optional `{ reason, aiApplied }`.
- **`suggestion-apply.ts`**: `delete_node`/`delete_edge` steps carry `reason`
  (from `reasonForSuggestion(s)`, the same helper the edit steps use); the executor passes it.
  The auto-bridge `create_edge` carries a reason like `"Bridged after removing <name>"`.
- **Backend** `/models/{id}/log`: add a `kind` query filter (trivial; the endpoint already
  filters by `target_id`/`actor_kind`/`source`/`since`).
- **`right-panel.tsx` ChangeLogTab**: a **"Removed"** section listing DELETE events (deduped by
  `target_id`, newest-first, shown by `before.name`). Clicking an entry sets an explicit
  `targetId` filter — **decoupled from the canvas `selected`** — so a vanished object's full
  history renders. The drill-through uses the **model-log `target_id` filter**
  (`GET /models/{id}/log?target_id=…`), which queries `change_events` with no
  object-existence check. Note: the per-object `GET /nodes/{id}/history` and
  `/edges/{id}/history` endpoints **`db.get` the object first and 404 once it is deleted**, so
  they cannot serve removed objects — the model-log path is the one that works (and is already
  what the ChangeLogTab's per-target filter uses).

### Why this layering

`suggestion-shadow.ts` is the single "what would happen" computation. Walk-the-change renders
its diff; deletion-impact analyzes the same shadow. There is no duplicated simulation logic,
and the preview provably matches the committed result because new-node placement is shared
(§2) and FK cascades are mirrored (§1).

## Ghost visual language

Canvas preview mode shows a `⚡ Preview · N changes · not yet saved` banner. Styling by diff:

| Delta | Styling |
|---|---|
| Added node / lane | dashed violet outline, faint hatch fill; new lane label tinted violet |
| Added edge | dashed violet arrow (`⇢`) |
| Changed node (relabel / retype) | solid violet ring; old value struck-through in small text above the new |
| Moved to lane | node ghosted in its **new** lane |
| Removed node / edge | struck-through, faded, red outline; touching edges struck too (cascade) |
| Orphaned node | amber ring + `⚠` |
| Bridge (delete only) | dashed violet predecessor ⇢ successor edge, shown only when the toggle is on |

Colors reuse the cards' existing vocabulary: violet = AI/proposed, red = delete, amber =
warning, emerald = applied.

## Data flow

1. User clicks **Preview** on a card → `onPreview(bundle)` → page → `canvasRef.previewPlan(plan)`.
2. Canvas computes shadow + diff (+ `ImpactReport` for deletes), enters preview, returns the
   report to the card; the card shows Apply / Cancel (+ impact chips + bridge toggle for deletes).
3. **Apply** → page → `canvasRef.applySuggestionBatch(plan + chosen bridge steps)` → on success
   the card flips to **Applied ✓**, `clearPreview()` runs, the graph query invalidates.
4. **Cancel** → `clearPreview()`, card returns to pending.
5. Applied deletions log with the suggestion's rationale + AI attribution; later viewable under
   **Removed** in the Change Log, drill-through to full per-object history.

## Build phasing

One design doc, two sequenced implementation plans (Phase 2 depends on Phase 1's shadow engine):

- **Phase 1 — walk-the-change (frontend-only):** §1 shadow engine + diff, §2 placement
  extraction, §3 canvas preview mode + ghost styling (all 12 ops), §5 Preview button +
  Apply/Cancel + page plumbing.
- **Phase 2 — deletion impact + provenance:** §4 impact engine, §5 IMPACT block + bridge
  toggle + delete-confirm→preview replacement, §6 backend delete reason/source + executor
  threading + log `kind` filter + "Removed" view.

## Testing

- **Pure modules** (`suggestion-shadow.test.ts`, `deletion-impact.test.ts`), following the
  existing `suggestion-apply.test.ts` pattern:
  - shadow: `applyToShadow` for each op kind; delete-cascade of touching edges; tmp-ref
    resolution; `diffGraphs` correctness (added/removed/changed across nodes, edges, lanes).
  - impact: orphan detection; cascade-edge counting; bridge candidacy only for single-in/
    single-out removals; no bridge for multi-in/multi-out.
- **Backend** (`test_change_event_capture.py` extensions): an AI-flagged delete records the
  supplied reason + `source=chat`/`actor_kind=ai` (not `"Deleted"`/manual/user); a manual
  delete is unchanged; `/models/{id}/log?kind=delete` returns only deletes.
- **Canvas preview mode + card/preview interactions:** verified manually in the running app,
  consistent with how existing canvas behavior is covered — Preview/Apply/Cancel, the delete
  impact + bridge path, and the "Removed" drill-through.

## Out of scope (documented follow-ups)

- Persisted **gap-marker** placeholder (the "removed step" node, option C) — waits for the
  provenance/backend phase; institutional memory is preserved for now via the logged delete +
  "Removed" history view.
- **Server-authoritative origin** (north-star D2's proposer/accepter two-event model). Delete
  provenance uses the same interim client `ai_applied`-style flag as PR #38 and is removed with
  it when D2 lands.
- Agentic tool-loop; streaming suggestions; previewing **manual** (non-suggestion) edits
  (the delete-provenance backend change does, however, benefit manual deletes).
