# SP-1 — Canvas Interaction Hardening (Design)

_Date: 2026-05-28 · Status: approved design, pre-implementation · Sub-project 1 of the Maps-UI functional-completeness effort._

## Context

An audit of the Maps UI (the swimlane process-map editor under `src/app/(canvas)/` and `src/components/canvas/`) found that the backend is fully wired — every `src/lib/api.ts` call hits a real, implemented route — but several visible controls don't work to their intended use, and several core editor capabilities are missing entirely. The full scope was decomposed into five independent sub-projects (SP-1…SP-5). This spec covers **SP-1**, the pure-frontend pass: fix the genuine canvas bugs, make the dead tool controls actually do their job, and add the missing direct-manipulation capabilities. It adds **no new backend** — it calls only existing `api.ts` endpoints (`createNode`, `createEdge`, `updateNode`, `updateEdge`, `deleteNode`, `deleteEdge`, `updateLane`), introducing no routes, schema fields, or migrations.

The other sub-projects (SP-2 node/lane editing, SP-3 stakeholder review, SP-4 version control, SP-5 AI edit-this-step) each get their own spec and are out of scope here.

## Goals

1. The canvas reports accurate live state (lane/node/edge counts) after edits.
2. Zoom controls behave predictably (centered, consistent clamp).
3. No user action fails silently — failures surface as toasts.
4. The **Pan** and **Select** tool buttons and the `V` / `H` / `C` keyboard shortcuts do what their tooltips promise.
5. The editor supports multi-selection (marquee + shift-click) with group move, group delete, and a bulk-action bar.
6. Copy/paste of nodes (and the edges between them) works within a map.
7. Right-click context menus on nodes, edges, and the canvas.
8. Lanes can be collapsed/expanded (session-only view state).

## Non-goals (explicitly out of scope for SP-1)

- Any backend change, migration, or new endpoint.
- Persisting lane collapse or lane color (color lands in SP-2; collapse persistence may ride along with SP-2's lane backend work).
- New BPMN shape types or per-type node rendering (the 4-shape palette stays as-is per product decision).
- Cross-map / cross-tab clipboard.
- Wiring the Review-mode toggle to real behavior (SP-3).
- Regenerating BPMN XML from canvas edits (separate concern).

## Approved decisions (from brainstorming)

- **Architecture: Approach C (hybrid).** Keep the cross-cutting selection-model change in place inside `bpmn-canvas.tsx`; extract genuinely separable new concerns into their own modules. No gratuitous refactoring of the delicate drag/persist/undo code.
- **Multi-select panel behavior:** when 2+ nodes are selected, hide the single-node Properties panel and show a compact **bulk-action bar** (`N selected` + Delete, Copy, Move-to-lane). Properties panel still shows for exactly one node.
- **Lane collapse:** session-only view toggle (browser state, no backend).
- **Copy/paste:** same-map, in-memory clipboard.
- **Review-mode toggle: KEEP IT.** Per user override, the toggle UI stays (the user likes it and will wire it into SP-3). It remains inert in SP-1 — a known, intentional placeholder, not removed. `reviewMode` state in `bpmn-canvas.tsx` is left untouched.

### Default micro-decisions (locked unless changed at spec review)

- Marquee selects nodes whose bounding box **intersects** the marquee rect (not strict containment).
- Paste places copies offset **+24 world px** in x and y, in the same lane (fallback to first lane if the original lane was deleted).
- Collapsed lane display height = **28 px**.
- Zoom step = **×1.2 / ÷1.2**, anchored to the **viewport center**, clamped to a shared **`MIN_SCALE = 0.2`, `MAX_SCALE = 2.5`**.
- Each bulk operation (group move, group delete, paste) records a **single grouped undo entry**.

## Architecture

### New modules

| File | Responsibility | Depends on |
|---|---|---|
| `src/components/canvas/selection.ts` | Pure helpers: marquee rect normalization, node-bbox computation, marquee↔node intersection test, "select all" id collection. No React. | `types.ts` |
| `src/components/canvas/use-clipboard.ts` | In-memory clipboard hook: snapshot a selection (nodes + internal edges) and expose `copy(...)` / `paste(...)` (paste delegates node/edge creation to callbacks supplied by the canvas). | `types.ts` |
| `src/components/canvas/canvas-context-menu.tsx` | Positioned HTML context menu (closes on outside-click / Esc / action). Stateless; driven by a `{x, y, target}` descriptor and an item list. | — |

### Changed files

- `bpmn-canvas.tsx` — selection-model swap, tool-aware interaction branching, marquee drag variant, clipboard + context-menu wiring, collapse-aware layout, counts/zoom callbacks, failure toasts, new imperative methods.
- `floating-toolbar.tsx` — zoom buttons call new `onZoomIn`/`onZoomOut` callbacks (remove inline scale math). Review toggle **unchanged** (kept).
- `lane-rail.tsx` — per-lane collapse/expand chevron + `collapsedLaneIds` / `onToggleCollapse` props.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — live counts in the header, selection-union mapping, the bulk-action bar.

## Detailed design

### 1. Live header counts (bug fix)

The page header (`page.tsx:182-206`) currently reads `data.lanes.length / data.nodes.length / data.edges.length` from the React-Query `["graph"]` snapshot, which the canvas never invalidates — so counts go stale after any edit.

**Fix:** add `onCountsChange?: (counts: { lanes: number; nodes: number; edges: number }) => void` to `BpmnCanvasProps`. The canvas fires it in an effect keyed on `nodes`/`edges`/`lanes`. The page holds a `counts` state, seeds it from `data`, and updates from the callback; the header renders `counts`. No refetch, no flicker, no clobbering of optimistic local state.

### 2. Centered, consistent zoom (bug fix)

Wheel zoom (`bpmn-canvas.tsx:530-539`) is already cursor-anchored and correct. Only the toolbar `+`/`−` buttons (`floating-toolbar.tsx:107-140`) mutate `scale` alone, leaving `tx/ty` — so content drifts toward the world origin.

**Fix:** add `zoomByStep(factor: number)` to the canvas, which anchors on the SVG rect **center** using the same math as the wheel handler, clamped to shared `MIN_SCALE`/`MAX_SCALE`. The toolbar takes `onZoomIn`/`onZoomOut` callbacks instead of computing scale inline. `MIN_SCALE`/`MAX_SCALE` are module constants reused by the wheel handler, the buttons, and `fitToWorld` (replacing the current ad-hoc `0.1`/`0.3`/`2.5` literals).

### 3. No silent failures (bug fix)

Three catches currently swallow errors to `console.error` only: palette drop `createNode` (`bpmn-canvas.tsx:894-896`), drag-to-connect `createEdge` (`:787-789`), and edge-bend save (`:750`). Each gets a `toast.error(...)` (Sonner is already mounted in `src/app/layout.tsx`). The palette drop additionally must not leave orphaned local state on failure (it currently adds the node to local state only inside the `try` after the await, so the happy path is fine; verify no optimistic node leaks on the throw path).

### 4. Tool semantics + keyboard shortcuts

Today `tool` is only ever compared to `"connect"`; `"pan"` and `"select"` are inert, and background-drag always pans regardless of tool.

**New behavior, gated on `tool`:**

- **Select (default):** background mousedown → **marquee** (see §5); node mousedown → select + move; node click → select.
- **Pan:** background mousedown → pan; **node mousedown also → pan** (hand mode — you can grab anywhere). Cursor `grab`, `grabbing` while dragging.
- **Connect:** unchanged (handles visible, drag-to-connect).

Update the SVG cursor logic (`:1133-1138`) to reflect `pan` (`grab`/`grabbing`) and keep `crosshair` for connect, `default` for select.

**Keyboard** (added to the existing `keydown` effect at `:407-446`, behind the same in-editable guard): `V`→`select`, `H`→`pan`, `C`→`connect`, `Esc`→clear selection + reset tool to `select` + close any open context menu.

### 5. Multi-select + marquee

**State change (the core refactor):** `selectedId: string | null` → `selectedIds: Set<string>`. Every read (`selectedId === x` at node/edge render `:1211,1224`, the keyboard-delete branch `:433-442`, the `onSelectionChange` effect `:467-485`) and every write (`setSelectedId(...)` across `deleteNodeImpl`, `deleteEdgeImpl`, `createEdgeImpl`, `onNodeMouseDown`, `onStartConnect`, `onSvgMouseDown` onUp, `onCanvasDrop`, the imperative `selectNode`) routes through small helpers: `selectOnly(id)`, `toggleInSelection(id)`, `selectMany(ids, {additive})`, `clearSelection()`.

**Marquee:** a new `Drag` variant `{ type: "marquee", startX, startY, currX, currY }` (world coords), started on background mousedown in Select tool. The document-level move updates `currX/currY`; a dashed rect renders in the world `<g>`. On mouseup: select nodes whose bbox intersects the normalized rect via `selection.ts`; `Shift` held → additive, else replace. A marquee that never moves (< 4px, same threshold as the current pan/click test) clears the selection.

**Group move:** if the node grabbed in `onNodeMouseDown` is already in `selectedIds` and `|selection| > 1`, the drag moves **all** selected nodes by the same world delta; each node's lane is recomputed from its own center (reusing `laneAtY`); positions persist via `markNode` for each; one grouped undo entry (`Move N nodes`) restores all original positions. If the grabbed node is **not** selected, behave as today: select only it, then move it.

**Group delete:** `Delete`/`Backspace` removes every selected node (and its edges) plus every selected edge, as one grouped undo entry (`Delete N items`). Implemented with low-level multi-item mutators recorded in a single `record({do, undo})` (the undo stack supports this directly; actions must not call `record` themselves).

**Selection contract to the page** changes from the current single-object form to a union:

```ts
type CanvasSelection =
  | { kind: "none" }
  | { kind: "node"; id: UUID; name?: string; nodeKind?: string; laneId?: UUID | null }
  | { kind: "edge"; id: UUID }
  | { kind: "multi"; nodeIds: UUID[]; edgeIds: UUID[] };
```

`onSelectionChange(sel: CanvasSelection)` fires from the selection effect. The page maps: `node` → Properties panel (unchanged behavior); `multi` → bulk-action bar; `edge`/`none` → neither. (The existing `RightPanel`'s `selected` prop is fed the single-node/edge case and `null` otherwise, preserving its current chat-context behavior.)

**Bulk-action bar** (new, page-level, occupying the Properties-panel slot when `kind === "multi"`): shows `N selected` and three actions — **Delete**, **Copy**, and a **Move to lane** dropdown (lists `data.lanes`). Backed by new imperative methods on `BpmnCanvasHandle`: `deleteSelection()`, `copySelection()`, `moveSelectionToLane(laneId)`. `moveSelectionToLane` reassigns every selected node to the chosen lane at `relativeY = 0`, persists, and records one grouped undo.

### 6. Copy / paste (same-map, in-memory)

`use-clipboard.ts` holds a snapshot: the selected nodes (kind, label, backend type, x, relativeY, laneId, w, h) and the edges whose **both** endpoints are in the selection. Edges to/from non-copied nodes are dropped.

- `Cmd/Ctrl+C` (canvas keydown) → `clipboard.copy(snapshotFromSelection())`.
- `Cmd/Ctrl+V` → for each clipboard node, `api.createNode(...)` with x/relativeY offset +24 and the same lane (fallback to first lane if missing); build an old-id→new-id map; then `api.createEdge(...)` for each clipboard edge using mapped ids. Add the new nodes/edges to local state, select the pasted set, record one grouped undo (`Paste N items` → deletes the pasted nodes/edges). Empty clipboard → no-op. Backend errors → `toast.error` and partial rollback of what was created.
- Context-menu **Duplicate** = `copy` of the one node + immediate `paste`.

### 7. Right-click context menus

`onContextMenu` handlers on nodes, edges, and the background `<rect data-bg>` call `e.preventDefault()` and set a `contextMenu` state `{ x, y, target: { kind, id? } }` (screen coords). `canvas-context-menu.tsx` renders a positioned menu, closing on outside-click, `Esc`, scroll, or item activation.

Right-clicking a node/edge that isn't selected selects it first. Items:

- **Node:** Copy, Duplicate, Delete. When `|selection| > 1` and the target is in the selection, labels show counts ("Copy 3", "Delete 3").
- **Edge:** Edit label (opens the existing inline `EdgeLabelEditor`), Delete.
- **Canvas:** Paste (disabled when clipboard empty), Select all, Fit to screen.

### 8. Lane collapse (session-only)

Canvas holds `collapsedLaneIds: Set<string>`. `LaneRail` gains a chevron in each lane header that calls `onToggleCollapse(laneId)`, plus a `collapsedLaneIds` prop to pick the chevron direction.

The canvas computes `displayLanes`: a copy of `lanes` where collapsed lanes get `h = COLLAPSED_LANE_HEIGHT (28)`, then re-runs `recomputeY`. `displayLanes` (not the raw `lanes`) drives: lane-band rendering, the `LaneRail` `lanes` prop, `laneAtY`, node-Y resolution in `renderNodes`, and `worldHeight`. The raw `lanes` (true `height_px`) are retained for persistence so expanding restores the real height — collapse touches no backend state.

Nodes whose lane is collapsed are filtered out of `renderNodes`; edges with an endpoint in a collapsed lane are filtered out of the edge render. Collapsed lanes are skipped as **drop targets** (palette drop / node drag re-lane resolves to the nearest expanded lane) and their hidden nodes are non-interactive.

### 9. Tooltip correctness

The `V`/`H`/`C` tooltips (`floating-toolbar.tsx:66,75,84`) become accurate once §4 lands; no text change needed. The Review toggle and its tooltip stay as-is (kept by user decision).

## Data / interface changes (summary)

- `BpmnCanvasProps`: add `onCountsChange`; change `onSelectionChange` to take `CanvasSelection`.
- `BpmnCanvasHandle`: add `deleteSelection()`, `copySelection()`, `moveSelectionToLane(laneId)`; `selectNode` now sets a single-element selection.
- `FloatingToolbar` props: add `onZoomIn` / `onZoomOut`; the inline scale math is removed. (`reviewMode`/`onReviewModeChange` unchanged.)
- `LaneRail` props: add `collapsedLaneIds: Set<string>` and `onToggleCollapse(laneId)`.
- No `src/lib/types.ts` backend-type changes; no `api.ts` changes.

## Edge cases

- Group move where some selected nodes share a lane and some don't — each re-lanes independently by its own center.
- Marquee + Shift toggling already-selected nodes — additive selection unions; plain marquee replaces.
- Paste when the source lane was deleted between copy and paste — fall back to first lane.
- Delete that removes a node whose edge is also individually selected — dedupe so the edge isn't deleted twice.
- Context menu opened while a marquee/drag is mid-flight — opening a menu cancels any active drag.
- Collapsing the lane that contains the only selected node — selection persists in state but the node is hidden; expanding reveals it (no auto-deselect).
- Undo/redo of grouped ops restores the full group atomically (single stack entry).
- `Esc` while editing an edge label must not also clear selection (the inline editor already `stopPropagation`s; keep that intact).

## Verification & testing

No frontend test runner exists today (scripts are only `dev`/`build`/`start`/`lint`).

- **Static:** `npm run lint` and `npx tsc --noEmit` must pass clean.
- **Manual:** against the running stack (`./run-local.sh`), exercise each item: stale-count fix, centered zoom, drop-failure toast (simulate by killing the backend mid-drop), V/H/C + Esc, Pan vs Select drag behavior, marquee select, shift-click, group move, group delete, bulk-action bar (delete/copy/move-to-lane), copy/paste, duplicate, all three context menus, lane collapse/expand (including hidden nodes/edges and drop-target skipping), and undo/redo of each grouped op.
- **Unit (proposed — confirm at spec review):** add a **minimal Vitest** dev-dependency to unit-test the pure `selection.ts` helpers (marquee normalization, bbox, intersection, select-all). These are the bug-prone, side-effect-free pieces and are worth TDD-ing. If you'd rather not add a test runner in this sub-project, we fall back to static + manual only and defer a test harness to a later pass.

## Risks

- **Selection-model swap touches ~15 sites** in the most delicate file. Mitigation: do it as one mechanical pass via the selection helpers, typecheck after, then layer features on top; manual regression of existing single-select flows (Properties panel, Issues-tab focus, keyboard delete, undo) before adding marquee.
- **Collapse-aware layout** changes the lane-geometry source of truth (`displayLanes`). Mitigation: route every geometry consumer through `displayLanes` and keep `lanes` strictly for persistence; verify drag/drop/connect math against collapsed lanes.
- **Grouped undo** must not let action callbacks call `record()` (would clear redo). Mitigation: follow the existing low-level-mutator pattern already used for single ops.

## Out-of-scope follow-ups noted for later sub-projects

- Persisting lane collapse and lane color (SP-2).
- Wiring the Review-mode toggle to a real review overlay (SP-3).
