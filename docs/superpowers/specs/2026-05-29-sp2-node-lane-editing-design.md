# SP-2 — Node + Lane Editing — Design

_Date: 2026-05-29 · Status: design / approved-pending-review · Sub-project 2 of the Maps-UI roadmap._

Pairs with `docs/superpowers/specs/2026-05-28-maps-ui-roadmap-sp2-sp5.md` (§ "SP-2 — Node + lane editing"), which pre-authorized SP-2 to skip the full brainstorm and go straight to a short spec + plan. SP-1 (`…/2026-05-28-sp1-canvas-hardening-design.md`) is the foundation this builds on.

---

## Goal

Turn two dead/placeholder controls into real, persisted editing:

1. **Type dropdown** (`properties-panel.tsx`) — currently `disabled`. Make it change a node's BPMN `type`, recompute the node's visual kind + size, re-render in place, persist via `PATCH /nodes/{id}`, and register an undo entry.
2. **Lane color** — add a persisted per-lane color, picked from a swatch set (the existing `LANE_PALETTE`) plus a custom color input, shown in the lane rail header. Persist via `PATCH /lanes/{id}`; the client palette becomes the fallback when a lane has no stored color.
3. **Lane collapse persistence** (ride-along) — SP-1 ships lane collapse as session-only view state. Since SP-2 already migrates the lane table, persist `collapsed` so it survives reload.

## Decisions locked (confirmed with the user)

| Decision | Choice | Consequence |
|---|---|---|
| Type transitions | **Allow any → any** `NodeType` | Dropdown offers all 8 backend types; no transition guardrails. "It's the consultant's map." |
| Shape change on type edit | **Keep `x`/`relative_y`, just re-render** | A task→gateway change shrinks the box in place; no reflow/auto-layout. |
| Lane color picker | **Swatch set + custom**, persisted | 8 `LANE_PALETTE` swatches + a native `<input type="color">`; `LANE_PALETTE[index]` is the fallback when `color` is null. |
| Lane collapse | **Persist now** (ride along on the lane migration) | New `collapsed` column; collapse survives reload. |
| Undo coverage | Type change **and** color change are undoable; collapse is **not** | Matches existing patterns: node rename and lane resize/rename are already undoable; collapse is pure view state. |
| Provenance | Type change **keeps** node→claim links | Guaranteed by construction — the update only writes `node.type`, never touches `node_claim_links`. |

---

## Architecture & data flow

Nothing new is invented. Both edits ride the persistence and undo plumbing SP-1 already established:

- **Node edits** (`bpmn-canvas.tsx`): a `*Local` mutator updates React state (`setNodes`) and persists, wrapped in `record({do, undo})` from `useUndoStack`. Type editing adds `applyNodeTypeLocal` alongside the existing `applyNodeEditLocal` (name/lane).
- **Lane edits** (`bpmn-canvas.tsx`): a `*Local` mutator updates `setLanes` and queues a debounced `markLane(id, partial)` (from `useGraphPersistence`), wrapped in `record`. Color editing adds `setLaneColorLocal`, exactly mirroring `resizeLaneLocal`/`renameLaneLocal`.
- **Persistence layer** (`use-persistence.ts`): `markNode`/`markLane` are typed against `NodeUpdate`/`LaneUpdate` from `@/lib/types`. **Once those two interfaces gain the new fields, the hook needs no changes** — the debounced flush already calls `api.updateNode`/`api.updateLane` with whatever partial it's handed.
- **Selection → panel**: the canvas's `onSelectionChange` payload (the `CanvasSelection` union) currently carries `nodeKind` but **not** `type`. SP-2 threads `type` through so the dropdown can show and edit the true backend type (kind is lossy: three gateway types collapse to `"gateway"`).

### Type dropdown: kind vs. type (the key subtlety)

The dropdown today lists **visual kinds** (`NODE_KINDS`: start/end/intermediate/user/service/manual/send/receive/gateway) but the backend stores **`NodeType`** (`task`, `event_start`, `event_end`, `event_intermediate`, `gateway_exclusive`, `gateway_parallel`, `gateway_inclusive`, `subprocess`). `nodeKindFromType` maps type→kind and is lossy and not invertible. SP-2 **replaces the dropdown's option list with the 8 backend `NodeType` values** (friendly labels), binds its value to `selected.type`, and on change PATCHes `type`. The visual kind + size are then recomputed locally from the new type via `nodeKindFromType` + `NODE_SIZES`.

---

## Part A — Type editing

### Backend

- **Schema** (`backend/app/schemas/process_map.py`): add `type` to `NodeUpdate`:
  ```python
  type: str | None = Field(
      default=None,
      pattern=r"^(task|event_start|event_end|event_intermediate|gateway_exclusive|gateway_parallel|gateway_inclusive|subprocess)$",
  )
  ```
  (Same allow-list regex `NodeCreate.type` already uses — keeps the two in sync and rejects garbage.)
- **Route** (`backend/app/api/v2/process_maps.py`, `update_node`): add, alongside the existing field applications:
  ```python
  if payload.type is not None:
      node.type = payload.type
  ```
  No claim-link handling — provenance is preserved by not touching it. `node.type` is a `String(40)` column (not a DB enum), so no migration is needed for type.

### Frontend

- **`src/lib/types.ts`**: add `type?: string` to the `NodeUpdate` interface.
- **`src/components/canvas/layout.ts`**: **export** `nodeKindFromType` and `NODE_SIZES` (both currently module-private) so the canvas can recompute kind+size on type change.
- **New `src/components/canvas/node-type.ts`** (pure, unit-tested): the single source of truth for the dropdown options and the type→size lookup.
  ```ts
  import { NODE_SIZES, nodeKindFromType } from "./layout";

  export const NODE_TYPE_OPTIONS: { value: string; label: string }[] = [
    { value: "task", label: "Task" },
    { value: "subprocess", label: "Subprocess" },
    { value: "event_start", label: "Start event" },
    { value: "event_end", label: "End event" },
    { value: "event_intermediate", label: "Intermediate event" },
    { value: "gateway_exclusive", label: "Exclusive gateway" },
    { value: "gateway_parallel", label: "Parallel gateway" },
    { value: "gateway_inclusive", label: "Inclusive gateway" },
  ];

  /** Box size for a backend NodeType, via its visual kind. */
  export function sizeForNodeType(type: string): { w: number; h: number } {
    return NODE_SIZES[nodeKindFromType(type)];
  }
  ```
- **`bpmn-canvas.tsx`**:
  - Add `type?: string` to the node branch of the `CanvasSelection` union.
  - In the `onSelectionChange` node payload, add `type: node.type`.
  - Add `applyNodeTypeLocal`:
    ```ts
    const applyNodeTypeLocal = useCallback(
      async (id: UUID, newType: string) => {
        const kind = nodeKindFromType(newType);
        const size = sizeForNodeType(newType);
        setNodes((curr) =>
          curr.map((n) =>
            n.id === id ? { ...n, type: newType, kind, w: size.w, h: size.h } : n
          )
        );
        await api.updateNode(projectId, id, { type: newType });
      },
      [projectId]
    );
    ```
    (Keeps `x`/`relativeY` untouched — decision: no reflow.)
  - Extend `updateNodeImpl`'s patch to `{ name?: string; laneId?: UUID; type?: string }`. Add a **type branch at the top**: if `patch.type` is set and differs from the node's current `type`, run `applyNodeTypeLocal` + `record({description: "Change node type", do, undo})` with old/new type, then return. The existing name/lane logic is unchanged. Type changes always arrive as their own single-field patch (the dropdown's `onChange` fires alone), so the branches never collide in practice.
    - **TDZ note:** `applyNodeTypeLocal` is declared near `applyNodeEditLocal` (early). It is referenced by `updateNodeImpl`, which lists its deps `[applyNodeEditLocal, applyNodeTypeLocal, record]`. This is safe because both are declared before `updateNodeImpl`. Do **not** introduce references to it from any effect/handle that is declared *before* it.
- **`properties-panel.tsx`**:
  - Add `type?: string` to the `SelectedNode` interface and to `onUpdate`'s patch type (`{ name?: string; laneId?: UUID; type?: string }`).
  - Replace the `NODE_KINDS`-based `<option>` list with `NODE_TYPE_OPTIONS`. Bind `value={selected.type ?? "task"}`. Remove `disabled` and the "coming soon" title. Add `onChange={(e) => onUpdate?.(selected.id, { type: e.target.value })}`. Disable only when `!onUpdate` (mirror the Lane select).
- **Page** (`src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`):
  - `handleNodeUpdate` patch type gains `type?: string`; pass it through to `canvasRef.current.updateNode`.
  - Extend the optimistic `setSelected` merge so a `type` change updates `selected.type` (so the dropdown reflects the new value immediately, matching the existing name/laneId merge).

---

## Part B — Lane color

### Backend

- **Model** (`backend/app/models/process.py`, `ProcessLane`): add
  ```python
  color: Mapped[str | None] = mapped_column(String(9), nullable=True)
  ```
  (`String(9)` covers `#rrggbb` and a possible 8-digit `#rrggbbaa`; we only emit 7-char hex.)
- **Schemas** (`process_map.py`):
  - `ProcessLaneRead`: add `color: str | None`.
  - `LaneUpdate`: add `color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")`.
  - `LaneCreate`: add `color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")` (optional; defaults to null → palette fallback).
- **Route** (`update_lane`): add `if payload.color is not None: lane.color = payload.color`. (`add_lane` sets `color=payload.color` when present.)
- **Migration**: Alembic revision adding nullable `color` to `process_lanes` (combined with the `collapsed` column from Part C — one migration for both lane fields).

> **No "clear to default"**: partial-PATCH semantics treat `None` as "leave unchanged", so we never write `color = NULL` back. To restore the auto look the user simply picks the matching palette swatch. (YAGNI — explicit clearing deferred.)

### Frontend

- **`src/lib/types.ts`**: `ProcessLane` gains `color: string | null`; `LaneUpdate` gains `color?: string`.
- **`layout.ts`**: **export** `LANE_PALETTE` (for the swatch set). In `buildCanvasState`, change the lane color line to `color: l.color ?? LANE_PALETTE[i % LANE_PALETTE.length]` (stored color wins; palette is fallback).
- **`lane-rail.tsx`**: add a color control to the lane header. A small swatch button (filled with the lane's current `lane.color`) opens a popover containing the 8 `LANE_PALETTE` swatches plus a native `<input type="color">` for a custom value. New prop `onSetColor: (laneId: string, color: string) => void`. Place it in the lane-header control column near the collapse chevron / options menu, consistent with the existing control styling. Selecting a swatch or committing the custom input calls `onSetColor(lane.id, hex)` and closes the popover.
- **`bpmn-canvas.tsx`**:
  - Add `setLaneColorLocal`:
    ```ts
    const setLaneColorLocal = useCallback(
      (laneId: string, color: string) => {
        setLanes((curr) =>
          curr.map((l) => (l.id === laneId ? { ...l, color } : l))
        );
        markLane(laneId, { color });
      },
      [markLane]
    );
    ```
  - Add `setLaneColor` (undoable wrapper), mirroring `resizeLane`/`renameLane`:
    ```ts
    const setLaneColor = useCallback(
      (laneId: string, color: string) => {
        const old = lanesRef.current.find((l) => l.id === laneId);
        if (!old || old.color === color) return;
        const oldColor = old.color;
        setLaneColorLocal(laneId, color);
        record({
          description: "Set lane color",
          do: () => setLaneColorLocal(laneId, color),
          undo: () => setLaneColorLocal(laneId, oldColor),
        });
      },
      [setLaneColorLocal, record]
    );
    ```
  - Pass `onSetColor={setLaneColor}` to `<LaneRail>`.

---

## Part C — Lane collapse persistence (ride-along)

### Backend

- **Model** (`ProcessLane`): add
  ```python
  collapsed: Mapped[bool] = mapped_column(
      Boolean, nullable=False, default=False, server_default="false"
  )
  ```
- **Schemas**: `ProcessLaneRead` gains `collapsed: bool`; `LaneUpdate` gains `collapsed: bool | None = None`.
- **Route** (`update_lane`): `if payload.collapsed is not None: lane.collapsed = payload.collapsed`.
- **Migration**: same Alembic revision as the `color` column.

### Frontend

- **`src/lib/types.ts`**: `ProcessLane` gains `collapsed: boolean`; `LaneUpdate` gains `collapsed?: boolean`.
- **`canvas/types.ts`**: `CanvasLane` gains `collapsed: boolean`.
- **`layout.ts`** (`buildCanvasState`): set `collapsed: l.collapsed ?? false` on each built `CanvasLane`.
- **`bpmn-canvas.tsx`**:
  - Seed the collapse set from persisted state:
    ```ts
    const [collapsedLaneIds, setCollapsedLaneIds] = useState<Set<string>>(
      () => new Set(initialLanes.filter((l) => l.collapsed).map((l) => l.id))
    );
    ```
    (`initialLanes` is already populated by the time the canvas mounts — the page gates rendering on loaded graph data.)
  - Persist on toggle. Compute the next value from a ref to avoid a side effect inside the state-updater:
    ```ts
    const collapsedLaneIdsRef = useRef(collapsedLaneIds);
    collapsedLaneIdsRef.current = collapsedLaneIds; // existing xRef.current = x idiom

    const toggleLaneCollapse = useCallback(
      (laneId: string) => {
        const willCollapse = !collapsedLaneIdsRef.current.has(laneId);
        setCollapsedLaneIds((curr) => {
          const next = new Set(curr);
          if (willCollapse) next.add(laneId);
          else next.delete(laneId);
          return next;
        });
        markLane(laneId, { collapsed: willCollapse });
      },
      [markLane]
    );
    ```
  - Collapse is **not** added to the undo stack (pure view state, matching its SP-1 treatment).

---

## Undo / persistence behavior summary

| Action | Local update | Persist | Undoable |
|---|---|---|---|
| Change node type | `setNodes` (type, kind, w, h) | `api.updateNode({type})` immediate | **Yes** |
| Set lane color | `setLanes` (color) | `markLane({color})` debounced | **Yes** |
| Toggle lane collapse | `setCollapsedLaneIds` | `markLane({collapsed})` debounced | No (view state) |

---

## Testing strategy

Per `[[frontend-lint-baseline]]`: lint is advisory. Binding gates: `npx tsc --noEmit`, `npm test` (Vitest), `npm run build`, and manual verification via `./run-local.sh`.

- **Vitest (pure)** — new `src/components/canvas/node-type.test.ts`:
  - `NODE_TYPE_OPTIONS` contains exactly the 8 backend `NodeType` values and every value matches the backend regex set.
  - `sizeForNodeType("gateway_exclusive")` → `{w:60,h:60}`; `sizeForNodeType("task")` → `{w:170,h:64}`; `sizeForNodeType("event_start")` → `{w:50,h:50}`; an unknown string falls back to task size (mirrors `nodeKindFromType` default).
- **Backend** — pytest on `update_node` (PATCH `type` persists; an invalid type → 422; claim links unchanged after a type PATCH) and `update_lane` (PATCH `color`/`collapsed` persist; invalid color → 422). Add a migration round-trip sanity check if the suite has that convention.
- **Manual** (`./run-local.sh`): change a task to a gateway (box shrinks in place, position kept; Ctrl+Z reverts); set a lane color from a swatch and from the custom picker (persists across reload; Ctrl+Z reverts); collapse a lane and reload (stays collapsed).

---

## File-by-file change list

**Backend**
- `backend/app/models/process.py` — `ProcessLane.color`, `ProcessLane.collapsed`.
- `backend/app/schemas/process_map.py` — `NodeUpdate.type`; `ProcessLaneRead.color/collapsed`; `LaneUpdate.color/collapsed`; `LaneCreate.color`.
- `backend/app/api/v2/process_maps.py` — apply `type` in `update_node`; apply `color`/`collapsed` in `update_lane`; set `color` in `add_lane`.
- `backend/alembic/versions/<rev>_lane_color_collapsed.py` — add the two lane columns.

**Frontend**
- `src/lib/types.ts` — `NodeUpdate.type`; `ProcessLane.color/collapsed`; `LaneUpdate.color/collapsed`.
- `src/components/canvas/layout.ts` — export `nodeKindFromType`, `NODE_SIZES`, `LANE_PALETTE`; color/collapsed in `buildCanvasState`.
- `src/components/canvas/node-type.ts` (new) — `NODE_TYPE_OPTIONS`, `sizeForNodeType`.
- `src/components/canvas/node-type.test.ts` (new) — Vitest.
- `src/components/canvas/types.ts` — `CanvasLane.collapsed`.
- `src/components/canvas/properties-panel.tsx` — functional Type dropdown.
- `src/components/canvas/lane-rail.tsx` — color picker control + `onSetColor` prop.
- `src/components/canvas/bpmn-canvas.tsx` — selection `type`; `applyNodeTypeLocal` + `updateNodeImpl` branch; `setLaneColorLocal`/`setLaneColor`; collapse seed + persist.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — thread `type` through `handleNodeUpdate` + `setSelected` merge.

## Out of scope

The richer §5.1.4 properties (description / actor / system / duration / cost / controls / risks), AI type suggestions (SP-5), and any node-transition validation rules. Lane color "reset to default/null".
