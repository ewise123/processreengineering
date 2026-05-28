# SP-1 Canvas Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every interactive control on the swimlane process-map canvas work to its intended use, fix the three genuine canvas bugs, and add multi-select, copy/paste, context menus, and lane collapse — all frontend, no new backend.

**Architecture:** Approach C (hybrid). The cross-cutting selection-model change (`selectedId` → `selectedIds: Set`) happens in place inside `bpmn-canvas.tsx`; the genuinely separable new concerns become their own modules (`selection.ts`, `use-clipboard.ts`, `canvas-context-menu.tsx`). The delicate drag/persist/undo machinery is touched only for the selection swap and tool-aware branching.

**Tech Stack:** Next.js 16 / React 19, TypeScript, custom SVG canvas (no canvas lib), TanStack Query, Sonner (toasts, already mounted), Vitest (added in Task 1 for pure-helper unit tests).

**Spec:** `docs/superpowers/specs/2026-05-28-sp1-canvas-hardening-design.md`

---

## Conventions for this plan

- **Two verification modes.** Pure helpers (`selection.ts`) are TDD'd with Vitest (real failing-test-first cycles). The React/DOM-heavy interaction code has no unit runner, so its "verify" step is **`npx tsc --noEmit` + `npm run lint`** plus a concrete **manual check** against the running stack. Both are mandatory before each commit on those tasks.
- **Run the app for manual checks:** `./run-local.sh` brings up frontend (`:3000`), backend (`:8000`), and Postgres. Open a project → Maps → open a generated map's canvas. (WSL note: test in the Windows browser; curl from WSL may not reach `:3000`.)
- **Typecheck command:** `npx tsc --noEmit` (the project has no `typecheck` script; this uses the repo `tsconfig.json`).
- **Commit after every task.** Branch is `repo-restructure` (do not push; the user pushes).
- **Do not modify** `src/lib/api.ts`, `backend/**`, or `src/lib/types.ts` — SP-1 is frontend-only and uses existing endpoints.

---

## File Structure

**New files:**
- `src/components/canvas/selection.ts` — pure geometry helpers (marquee normalize, rect intersect, nodes-in-marquee). No React.
- `src/components/canvas/selection.test.ts` — Vitest unit tests for the above.
- `src/components/canvas/use-clipboard.ts` — in-memory copy/paste snapshot hook.
- `src/components/canvas/canvas-context-menu.tsx` — positioned HTML context-menu component.
- `vitest.config.ts` — minimal Vitest config (repo root).

**Modified files:**
- `src/components/canvas/types.ts` — add `type: string` to `CanvasNode`.
- `src/components/canvas/layout.ts` — populate `type` in `buildCanvasState`.
- `src/components/canvas/floating-toolbar.tsx` — zoom buttons → `onZoomIn`/`onZoomOut`; (Review toggle kept).
- `src/components/canvas/lane-rail.tsx` — per-lane collapse chevron + props.
- `src/components/canvas/bpmn-canvas.tsx` — selection swap, tool branching, marquee, group move, clipboard/context-menu wiring, collapse layout, counts/zoom callbacks, toasts, new imperative methods.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — live counts, selection-union mapping, bulk-action bar.
- `package.json` — add `vitest` dev-dep + `test` script.

---

## Task 1: Add Vitest for pure-helper tests

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create (temp): `src/components/canvas/smoke.test.ts`

- [ ] **Step 1: Install Vitest**

Run:
```bash
npm install -D vitest@^3
```
Expected: `vitest` appears under `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Add the `test` script**

In `package.json`, change the `scripts` block to:
```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run"
  },
```

- [ ] **Step 3: Create the Vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Add a smoke test to prove the runner works**

Create `src/components/canvas/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("vitest smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: PASS — 1 test passed.

- [ ] **Step 6: Delete the smoke test**

```bash
rm src/components/canvas/smoke.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore(test): add minimal Vitest runner for canvas helpers"
```

---

## Task 2: Pure selection helpers (TDD)

**Files:**
- Create: `src/components/canvas/selection.ts`
- Test: `src/components/canvas/selection.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/canvas/selection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { normalizeMarquee, rectsIntersect, nodesInMarquee } from "./selection";

describe("normalizeMarquee", () => {
  it("normalizes a top-left → bottom-right drag", () => {
    expect(normalizeMarquee(10, 20, 40, 60)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
  it("normalizes a bottom-right → top-left drag", () => {
    expect(normalizeMarquee(40, 60, 10, 20)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
  it("handles a zero-size drag", () => {
    expect(normalizeMarquee(5, 5, 5, 5)).toEqual({ x: 5, y: 5, w: 0, h: 0 });
  });
});

describe("rectsIntersect", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  it("true when overlapping", () => {
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });
  it("true when edges touch", () => {
    expect(rectsIntersect(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(true);
  });
  it("false when fully apart", () => {
    expect(rectsIntersect(a, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
  });
  it("true when one contains the other", () => {
    expect(rectsIntersect(a, { x: 2, y: 2, w: 2, h: 2 })).toBe(true);
  });
});

describe("nodesInMarquee", () => {
  const nodes = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 100, y: 100, w: 10, h: 10 },
    { id: "c", x: 5, y: 5, w: 10, h: 10 },
  ];
  it("returns ids of nodes overlapping the marquee", () => {
    expect(nodesInMarquee(nodes, { x: -1, y: -1, w: 8, h: 8 }).sort()).toEqual(["a", "c"]);
  });
  it("returns empty when nothing overlaps", () => {
    expect(nodesInMarquee(nodes, { x: 200, y: 200, w: 5, h: 5 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./selection` (module not found).

- [ ] **Step 3: Implement the helpers**

Create `src/components/canvas/selection.ts`:
```ts
/** Axis-aligned rectangle in world coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimal positioned node for hit-testing (resolved absolute coords). */
export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Build a normalized (non-negative w/h) rect from two world-space corners. */
export function normalizeMarquee(
  startX: number,
  startY: number,
  currX: number,
  currY: number
): Rect {
  return {
    x: Math.min(startX, currX),
    y: Math.min(startY, currY),
    w: Math.abs(currX - startX),
    h: Math.abs(currY - startY),
  };
}

/** AABB overlap test; touching edges count as intersecting. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w &&
    a.x + a.w >= b.x &&
    a.y <= b.y + b.h &&
    a.y + a.h >= b.y
  );
}

/** Ids of nodes whose bbox intersects the marquee rect. */
export function nodesInMarquee(nodes: PositionedNode[], marquee: Rect): string[] {
  return nodes
    .filter((n) => rectsIntersect(marquee, { x: n.x, y: n.y, w: n.w, h: n.h }))
    .map((n) => n.id);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS — all 9 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/selection.ts src/components/canvas/selection.test.ts
git commit -m "feat(canvas): pure marquee/selection geometry helpers"
```

---

## Task 3: Add backend `type` to `CanvasNode`

Faithful copy/paste needs each node's backend type (gateway subtypes are lossy through `kind`).

**Files:**
- Modify: `src/components/canvas/types.ts:24-33`
- Modify: `src/components/canvas/layout.ts:104-129`

- [ ] **Step 1: Add the field to the interface**

In `src/components/canvas/types.ts`, change the `CanvasNode` interface to:
```ts
export interface CanvasNode {
  id: UUID;
  /** Backend NodeType string, e.g. "task", "gateway_exclusive". Preserved
   * so copy/paste recreates the exact type (kind alone is lossy). */
  type: string;
  kind: CanvasNodeKind;
  label: string;
  laneId: UUID | null;
  x: number;
  relativeY: number;
  w: number;
  h: number;
}
```

- [ ] **Step 2: Populate it in `buildCanvasState`**

In `src/components/canvas/layout.ts`, in the `nodes` map (the returned object literal at lines 119-128), add `type: n.type,` as the second field:
```ts
    return {
      id: n.id,
      type: n.type,
      kind,
      label: n.name,
      laneId: n.lane_id,
      x,
      relativeY,
      w: size.w,
      h: size.h,
    };
```

- [ ] **Step 3: Verify the only other CanvasNode constructor compiles**

`bpmn-canvas.tsx`'s `onCanvasDrop` builds a `CanvasNode` literal (around line 882) without `type`; it will fail typecheck now. Fix it in the same step — in `onCanvasDrop`, change the `newNode` literal to include `type: shape.backendType,`:
```ts
      const newNode: CanvasNode = {
        id: created.id,
        type: shape.backendType,
        kind: shape.kind,
        label: created.name,
        laneId: targetLane.id,
        x: dropCenterX,
        relativeY: rel,
        w: shape.w,
        h: shape.h,
      };
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: clean (no errors about missing `type`).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/types.ts src/components/canvas/layout.ts src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(canvas): carry backend node type on CanvasNode"
```

---

## Task 4: Shared zoom constants + centered zoom buttons (bug fix)

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (constants, `zoomByStep`, wheel clamp, `fitToWorld`, toolbar props)
- Modify: `src/components/canvas/floating-toolbar.tsx` (zoom buttons → callbacks)

- [ ] **Step 1: Add shared scale constants**

In `bpmn-canvas.tsx`, near the existing top-level constants (after `const MIN_LANE_HEIGHT = 90;`, ~line 47), add:
```ts
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
const ZOOM_STEP = 1.2;
```

- [ ] **Step 2: Use the constants in the wheel handler**

In the wheel `useEffect` (~line 532), replace the clamp literal:
```ts
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * (1 + delta)));
```

- [ ] **Step 3: Use the constants in `fitToWorld`**

In `fitToWorld` (~line 907), replace the clamp:
```ts
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, Math.min(usableW / worldWidth, usableH / worldHeight))
    );
```

- [ ] **Step 4: Add `zoomByStep` (center-anchored)**

In `bpmn-canvas.tsx`, add this callback near `fitToWorld` (after it, ~line 916):
```ts
  // Zoom toward the viewport center, mirroring the wheel handler's anchor math
  // so the +/- buttons keep content centered instead of drifting to the origin.
  const zoomByStep = useCallback((factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const v = viewportRef.current;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - v.tx) / v.scale;
    const wy = (cy - v.ty) / v.scale;
    setViewport({ scale: newScale, tx: cx - wx * newScale, ty: cy - wy * newScale });
  }, []);
```

- [ ] **Step 5: Wire the toolbar props**

In `bpmn-canvas.tsx`, in the `<FloatingToolbar .../>` JSX (~line 1298), remove `onViewportChange={setViewport}` and add:
```tsx
        onZoomIn={() => zoomByStep(ZOOM_STEP)}
        onZoomOut={() => zoomByStep(1 / ZOOM_STEP)}
```
Keep `viewport={viewport}` (the toolbar still shows the zoom %).

- [ ] **Step 6: Update the toolbar component**

In `floating-toolbar.tsx`, change the prop type block (lines 24-38): remove `onViewportChange` and add `onZoomIn: () => void;` and `onZoomOut: () => void;`. Update the destructure (lines 9-23) accordingly (remove `onViewportChange`, add `onZoomIn, onZoomOut`).

Then replace the two zoom `PlainButton`s (lines 107-140) with:
```tsx
        <PlainButton onClick={onZoomOut} title="Zoom out">
          −
        </PlainButton>
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: "#475569",
            width: 44,
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {zoomPct}%
        </div>
        <PlainButton onClick={onZoomIn} title="Zoom in">
          +
        </PlainButton>
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: open a canvas, click `+`/`−` — content zooms toward the **center** and stays centered (no drift to top-left); Cmd/Ctrl+wheel still zooms toward the cursor.

- [ ] **Step 8: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx src/components/canvas/floating-toolbar.tsx
git commit -m "fix(canvas): center-anchor toolbar zoom; unify scale clamp"
```

---

## Task 5: Live header counts (bug fix)

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (add `onCountsChange` prop + effect)
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` (live counts state)

- [ ] **Step 1: Add the prop to `BpmnCanvasProps`**

In `bpmn-canvas.tsx`, in `interface BpmnCanvasProps` (~line 131), add:
```ts
  onCountsChange?: (counts: { lanes: number; nodes: number; edges: number }) => void;
```
Add `onCountsChange` to the destructured props in the component signature (~line 157).

- [ ] **Step 2: Fire it on change**

In `bpmn-canvas.tsx`, after the selection-notify effect (~line 485), add:
```ts
  useEffect(() => {
    onCountsChange?.({
      lanes: lanes.length,
      nodes: nodes.length,
      edges: edges.length,
    });
  }, [lanes.length, nodes.length, edges.length, onCountsChange]);
```

- [ ] **Step 3: Hold live counts on the page**

In `page.tsx`, add state + handler inside `CanvasPage` (after the other `useState`s, ~line 68):
```ts
  const [counts, setCounts] = useState<{ lanes: number; nodes: number; edges: number } | null>(null);
  const handleCountsChange = useCallback(
    (c: { lanes: number; nodes: number; edges: number }) => setCounts(c),
    []
  );
```

- [ ] **Step 4: Pass the handler to the canvas**

In `page.tsx`, on the `<BpmnCanvas .../>` element (~line 257), add:
```tsx
          onCountsChange={handleCountsChange}
```

- [ ] **Step 5: Render live counts in the header**

In `page.tsx`, replace the three count spans (lines 197-201) so they prefer live counts, falling back to the query snapshot on first paint:
```tsx
              <span style={{ fontWeight: 600 }}>{counts?.lanes ?? data.lanes.length} lanes</span>
              <span style={{ color: "#94a3b8" }}>·</span>
              <span style={{ fontWeight: 600 }}>{counts?.nodes ?? data.nodes.length} nodes</span>
              <span style={{ color: "#94a3b8" }}>·</span>
              <span style={{ fontWeight: 600 }}>{counts?.edges ?? data.edges.length} edges</span>
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: drag a shape from the palette onto the canvas → the "N nodes" count increments immediately; delete a node → it decrements; add/delete a lane → "N lanes" updates. No page reload needed.

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "fix(canvas): live lane/node/edge counts in the header"
```

---

## Task 6: Surface failures as toasts (bug fix)

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (3 catch sites)

- [ ] **Step 1: Import toast**

In `bpmn-canvas.tsx`, add after the existing imports (~line 16):
```ts
import { toast } from "sonner";
```

- [ ] **Step 2: Toast on failed palette drop**

In `onCanvasDrop`'s catch (~line 894), replace the body with:
```ts
    } catch (err) {
      console.error("Failed to create node from palette", err);
      toast.error("Couldn't add that shape — please try again.");
    }
```

- [ ] **Step 3: Toast on failed edge creation**

In the connect-drag `onUp` (~line 787), replace the `.catch(...)`:
```ts
            void createEdgeImpl(sourceId, targetId).catch((err) => {
              console.error("Failed to create edge", err);
              toast.error("Couldn't connect those steps — please try again.");
            });
```

- [ ] **Step 4: Toast on failed edge-bend save**

In the edge-bend `onUp` (~line 750), replace the `.catch(...)`:
```ts
              .catch((err) => {
                console.error("Failed to save edge bend", err);
                toast.error("Couldn't save the connection shape.");
              });
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: with the canvas open, stop the backend (`Ctrl-C` its process in `run-local.sh`, or block `:8000`), then drag a shape onto the canvas → a red toast appears top-right (instead of a silent no-op). Restart the backend afterward.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "fix(canvas): toast on node/edge create + bend-save failures"
```

---

## Task 7: Selection model → `Set` + selection union + page mapping

This is the core refactor. After it, single-select behaves exactly as before; multi-selection becomes representable (marquee comes in Task 8).

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (selection state, helpers, all read/write sites, union export, delete-all)
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` (consume union)

- [ ] **Step 1: Export the selection union + extend the handle/props**

In `bpmn-canvas.tsx`, add above `export interface BpmnCanvasHandle` (~line 116):
```ts
export type CanvasSelection =
  | { kind: "none" }
  | { kind: "node"; id: UUID; name?: string; nodeKind?: string; laneId?: UUID | null }
  | { kind: "edge"; id: UUID }
  | { kind: "multi"; nodeIds: UUID[]; edgeIds: UUID[] };
```
Change `BpmnCanvasProps.onSelectionChange` (lines 140-150) to:
```ts
  onSelectionChange?: (selected: CanvasSelection) => void;
```

- [ ] **Step 2: Swap the selection state + add a ref**

In `bpmn-canvas.tsx`, replace `const [selectedId, setSelectedId] = useState<string | null>(null);` (line 178) with:
```ts
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
```
Add a ref alongside the other refs (after `edgesRef`, ~line 455):
```ts
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
```

- [ ] **Step 3: Add selection helpers**

In `bpmn-canvas.tsx`, after the state declarations (~line 188, before `deleteNodeImpl`), add:
```ts
  const selectOnly = useCallback((id: string) => setSelectedIds(new Set([id])), []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setSelection = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds((curr) => {
      const next = additive ? new Set(curr) : new Set<string>();
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  const deselect = useCallback((id: string) => {
    setSelectedIds((curr) => {
      if (!curr.has(id)) return curr;
      const next = new Set(curr);
      next.delete(id);
      return next;
    });
  }, []);
```

- [ ] **Step 4: Update every selection write site**

Apply these replacements in `bpmn-canvas.tsx`:
- `deleteNodeImpl` (line 195): `setSelectedId((curr) => (curr === id ? null : curr));` → `deselect(id);` and add `deselect` to its dep array.
- `deleteEdgeImpl` `remove` (line 274): `setSelectedId((curr) => (curr === rid ? null : curr));` → `deselect(rid);`
- `createEdgeImpl` undo (line 363): `setSelectedId((curr) => (curr === currentId ? null : curr));` → `deselect(currentId);`
- `onNodeMouseDown` (line 550): `setSelectedId(id);` → `selectOnly(id);`
- `onStartConnect` (line 630): `setSelectedId(sourceId);` → `selectOnly(sourceId);`
- `onUp` pan-click branch (line 835): `setSelectedId(null);` → `clearSelection();`
- `onCanvasDrop` (line 893): `setSelectedId(newNode.id);` → `selectOnly(newNode.id);`
- Edge render `onClick`/`onDoubleClick` (lines 1212, 1214): `setSelectedId(id)` → `selectOnly(id)`.
- Imperative `selectNode` (line 397): `setSelectedId(id);` → `setSelectedIds(new Set([id]));`

(`selectOnly`, `clearSelection`, `deselect` are stable `useCallback`s, safe to add to dep arrays.)

- [ ] **Step 5: Update every selection read site**

- Edge render `selected` (line 1211): `selected={selectedId === edge.id}` → `selected={selectedIds.has(edge.id)}`.
- Node render `selected` (line 1224): `selected={selectedId === node.id}` → `selected={selectedIds.has(node.id)}`.

- [ ] **Step 6: Add a delete-all-selected impl + rewire keyboard delete**

In `bpmn-canvas.tsx`, after `deleteEdgeImpl` (~line 305), add:
```ts
  const deleteSelectionImpl = useCallback(async () => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    const nodeIds = ids.filter((id) => nodesRef.current.some((n) => n.id === id));
    const edgeIds = ids.filter((id) => edgesRef.current.some((e) => e.id === id));
    // Nodes first: deleteNodeImpl also strips their touching edges locally.
    for (const id of nodeIds) {
      await deleteNodeImpl(id);
    }
    // Then any still-present standalone edges (skip ones a node delete removed).
    for (const id of edgeIds) {
      if (edgesRef.current.some((e) => e.id === id)) {
        await deleteEdgeImpl(id);
      }
    }
  }, [deleteNodeImpl, deleteEdgeImpl]);
```
In the keydown handler (lines 433-442), replace the Delete/Backspace branch with:
```ts
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        void deleteSelectionImpl();
      }
```
Update that effect's dependency array (line 446) to `[deleteSelectionImpl, undo, redo]`.

- [ ] **Step 7: Emit the union from the selection effect**

Replace the selection-notify effect (lines 467-485) with:
```ts
  useEffect(() => {
    if (!onSelectionChange) return;
    const ids = [...selectedIds];
    if (ids.length === 0) {
      onSelectionChange({ kind: "none" });
      return;
    }
    if (ids.length === 1) {
      const id = ids[0];
      const node = nodesRef.current.find((n) => n.id === id);
      if (node) {
        onSelectionChange({
          kind: "node",
          id,
          name: node.label,
          nodeKind: node.kind,
          laneId: node.laneId,
        });
      } else {
        onSelectionChange({ kind: "edge", id });
      }
      return;
    }
    const nodeIds = ids.filter((id) => nodesRef.current.some((n) => n.id === id));
    const edgeIds = ids.filter((id) => edgesRef.current.some((e) => e.id === id));
    onSelectionChange({ kind: "multi", nodeIds, edgeIds });
  }, [selectedIds, onSelectionChange]);
```

- [ ] **Step 8: Consume the union on the page**

In `page.tsx`:
- Replace the `Selected` type (lines 42-50) with an import-driven alias. At the top, add `CanvasSelection` to the canvas import (line 18):
```ts
import { BpmnCanvas, type BpmnCanvasHandle, type CanvasSelection } from "@/components/canvas/bpmn-canvas";
```
  and delete the local `type Selected = ...` block.
- Change the selection state (line 61): `const [selected, setSelected] = useState<CanvasSelection>({ kind: "none" });`
- Replace `handleNodeUpdate`'s `setSelected` updater (lines 86-94) with:
```ts
      setSelected((curr) =>
        curr.kind === "node" && curr.id === id
          ? {
              ...curr,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.laneId !== undefined ? { laneId: patch.laneId } : {}),
            }
          : curr
      );
```
- Replace `handleNodeDeleted`'s `setSelected(null)` (line 101) with `setSelected({ kind: "none" });`.
- Replace `handleSelectionChange` (lines 117-122) with:
```ts
  const handleSelectionChange = useCallback((s: CanvasSelection) => {
    setSelected(s);
    if (s.kind === "node") setPropertiesCollapsed(false);
  }, []);
```
- Replace `const selectedNode = selected?.kind === "node" ? selected : null;` (line 149) with:
```ts
  const selectedNode = selected.kind === "node" ? selected : null;
```
- In the `<RightPanel .../>` props (line 328), replace the `selected={...}` line with:
```tsx
            selected={
              selected.kind === "node"
                ? { id: selected.id, kind: "node", name: selected.name, nodeKind: selected.nodeKind }
                : selected.kind === "edge"
                  ? { id: selected.id, kind: "edge" }
                  : null
            }
```

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: single-click a node → Properties panel opens (unchanged); click empty canvas → deselects; click an edge → selected; Delete removes the selected node/edge; Issues-tab "focus node" still selects+centers; undo/redo of a move still works. (No multi-select yet — that's Task 8.)

- [ ] **Step 10: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "refactor(canvas): selection as a Set + typed selection union"
```

---

## Task 8: Tool-aware interaction + marquee + keyboard shortcuts

Make `tool` actually gate behavior, add marquee box-select, and the `V`/`H`/`C`/`Esc` shortcuts.

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Add the marquee drag variant**

In `bpmn-canvas.tsx`, extend the `Drag` union (after the `edgeBend` variant, ~line 87) with:
```ts
  | {
      type: "marquee";
      startX: number; // world coords
      startY: number;
      currX: number;
      currY: number;
      additive: boolean; // Shift held at start → add to existing selection
    };
```

- [ ] **Step 2: Import the marquee helpers**

Add to the `./selection` imports at the top of `bpmn-canvas.tsx`:
```ts
import { normalizeMarquee, nodesInMarquee } from "./selection";
```

- [ ] **Step 3: Branch background mousedown on the active tool**

Replace `onSvgMouseDown` (lines 637-653) with:
```ts
  const onSvgMouseDown = (e: MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement;
    const isBg =
      target === svgRef.current ||
      (target.tagName === "rect" && target.getAttribute("data-bg") === "1");
    if (!isBg) return;
    if (tool === "pan") {
      setDrag({
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewport.tx,
        ty0: viewport.ty,
      });
      return;
    }
    // Select tool: start a marquee. A non-moving marquee clears selection on up.
    const { x, y } = toWorld(e.clientX, e.clientY);
    setDrag({ type: "marquee", startX: x, startY: y, currX: x, currY: y, additive: e.shiftKey });
  };
```

- [ ] **Step 4: Branch node mousedown on the active tool**

At the very top of `onNodeMouseDown` (line 548, right after `e.stopPropagation();`), insert the pan/shift handling:
```ts
    if (tool === "pan") {
      // Hand mode: dragging a node pans the canvas instead of moving it.
      setDrag({
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewportRef.current.tx,
        ty0: viewportRef.current.ty,
      });
      return;
    }
    if (e.shiftKey) {
      // Shift-click toggles this node in the selection without starting a drag.
      toggleSelection(id);
      return;
    }
```
(The existing `setSelectedId(id)` → already `selectOnly(id)` from Task 7 stays directly below, for the normal select-and-drag path.)

- [ ] **Step 5: Handle marquee move + release**

In the document-level drag effect (`onMove`, ~line 670), add a marquee branch at the top:
```ts
      if (drag.type === "marquee") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        setDrag({ ...drag, currX: x, currY: y });
        return;
      }
```
In `onUp` (~line 732), add a marquee branch before the `setDrag(null)` tail (place it alongside the other `if (drag.type === ...)` blocks):
```ts
      if (drag.type === "marquee") {
        const rect = normalizeMarquee(drag.startX, drag.startY, drag.currX, drag.currY);
        const moved = rect.w * rect.w + rect.h * rect.h > 16; // >4px in world space
        if (!moved) {
          if (!drag.additive) clearSelection();
        } else {
          const positioned = renderNodesRef.current.map((n) => ({
            id: n.id,
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
          }));
          const hit = nodesInMarquee(positioned, rect);
          setSelection(hit, drag.additive);
        }
        setDrag(null);
        return;
      }
```
This needs a ref to the resolved nodes. Add it next to the other refs (after `edgesRef`, ~line 455):
```ts
  const renderNodesRef = useRef(renderNodes);
  renderNodesRef.current = renderNodes;
```
Add the marquee/selection helpers used here to the effect's dependency array (line 847): append `clearSelection, setSelection`.

- [ ] **Step 6: Render the marquee rectangle**

In the world `<g>` (after the connect-preview block, ~line 1281, still inside the `<g>`), add:
```tsx
          {drag?.type === "marquee" &&
            (() => {
              const r = normalizeMarquee(drag.startX, drag.startY, drag.currX, drag.currY);
              return (
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill="rgba(37,99,235,0.08)"
                  stroke="#2563eb"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  pointerEvents="none"
                />
              );
            })()}
```

- [ ] **Step 7: Update cursor for pan tool**

Replace the SVG `cursor` expression (lines 1133-1138) with:
```tsx
          cursor:
            drag?.type === "pan"
              ? "grabbing"
              : tool === "pan"
                ? "grab"
                : tool === "connect"
                  ? "crosshair"
                  : "default",
```

- [ ] **Step 8: Add the keyboard shortcuts**

In the keydown handler (after the redo/`y` branch, before the Delete branch, ~line 432), add:
```ts
      if (!mod) {
        if (e.key === "v" || e.key === "V") { setTool("select"); return; }
        if (e.key === "h" || e.key === "H") { setTool("pan"); return; }
        if (e.key === "c" || e.key === "C") { setTool("connect"); return; }
        if (e.key === "Escape") {
          setTool("select");
          clearSelection();
          return;
        }
      }
```
Add `clearSelection` (and `setTool` is a stable state setter) to that effect's dependency array.

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: press `H` (or click Pan) → cursor shows a hand; dragging anywhere (incl. over a node) pans; press `V` → Select; drag on empty canvas draws a blue marquee and selects the nodes it touches; Shift+drag adds to the selection; Shift+click a node toggles it; press `C` → Connect handles appear; `Esc` returns to Select and clears selection.

- [ ] **Step 10: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(canvas): real Pan/Select tools, marquee select, V/H/C/Esc shortcuts"
```

---

## Task 9: Group move (grouped undo)

Dragging a node that's part of a multi-selection moves the whole group as one undo entry.

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Extend the node drag variant to carry group members**

Replace the `Drag` union's `node` variant (lines 61-70) with:
```ts
  | {
      type: "node";
      id: string; // the grabbed node
      offX: number;
      offY: number;
      members: Array<{
        id: string;
        origX: number;
        origAbsY: number;
        origRelativeY: number;
        origLaneId: UUID | null;
      }>;
    }
```

- [ ] **Step 2: Capture the group at drag start**

In `onNodeMouseDown`, replace the final `setDrag({ type: "node", ... })` block (lines 573-581) with:
```ts
    const groupIds =
      selectedIdsRef.current.has(id) && selectedIdsRef.current.size > 1
        ? [...selectedIdsRef.current].filter((sid) =>
            nodesRef.current.some((n) => n.id === sid)
          )
        : [id];
    const laneById = new Map(lanesRef.current.map((l) => [l.id, l]));
    const members = groupIds
      .map((sid) => {
        const sn = nodesRef.current.find((n) => n.id === sid);
        if (!sn) return null;
        const lane = sn.laneId ? laneById.get(sn.laneId) : undefined;
        const origAbsY = (lane ? lane.y : 0) + sn.relativeY;
        return {
          id: sid,
          origX: sn.x,
          origAbsY,
          origRelativeY: sn.relativeY,
          origLaneId: sn.laneId,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    setDrag({ type: "node", id, offX: x - resolved.x, offY: y - resolved.y, members });
```

- [ ] **Step 3: Move all members on drag**

Replace the `if (drag.type === "node")` branch in `onMove` (lines 693-721) with:
```ts
      if (drag.type === "node") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        const grabbed = drag.members.find((m) => m.id === drag.id);
        if (!grabbed) return;
        const deltaX = x - drag.offX - grabbed.origX;
        const deltaY = y - drag.offY - grabbed.origAbsY;
        const currLanes = lanesRef.current;
        setNodes((curr) =>
          curr.map((n) => {
            const m = drag.members.find((mm) => mm.id === n.id);
            if (!m) return n;
            const newX = m.origX + deltaX;
            const targetAbsY = m.origAbsY + deltaY;
            const targetLane =
              laneAtY(targetAbsY + n.h / 2, currLanes) ??
              (n.laneId
                ? currLanes.find((l) => l.id === n.laneId)
                : currLanes[0]);
            if (!targetLane) return { ...n, x: newX };
            const maxRel = Math.max(0, targetLane.h - n.h);
            const rel = Math.max(0, Math.min(maxRel, targetAbsY - targetLane.y));
            return { ...n, x: newX, laneId: targetLane.id, relativeY: rel };
          })
        );
        return;
      }
```

- [ ] **Step 4: Persist + grouped undo on release**

Replace the `if (drag.type === "node")` branch in `onUp` (lines 795-827) with:
```ts
      if (drag.type === "node") {
        const finals = drag.members
          .map((m) => nodesRef.current.find((n) => n.id === m.id))
          .filter((n): n is NonNullable<typeof n> => !!n);
        for (const f of finals) {
          markNode(f.id, {
            x: f.x,
            relative_y: f.relativeY,
            lane_id: f.laneId ?? undefined,
          });
        }
        const moved = drag.members.some((m) => {
          const f = finals.find((n) => n.id === m.id);
          return (
            f &&
            (f.x !== m.origX ||
              f.relativeY !== m.origRelativeY ||
              f.laneId !== m.origLaneId)
          );
        });
        if (moved) {
          const newPositions = finals.map((f) => ({
            id: f.id,
            x: f.x,
            relativeY: f.relativeY,
            laneId: f.laneId,
          }));
          const oldPositions = drag.members.map((m) => ({
            id: m.id,
            x: m.origX,
            relativeY: m.origRelativeY,
            laneId: m.origLaneId,
          }));
          record({
            description: finals.length > 1 ? `Move ${finals.length} nodes` : "Move node",
            do: () => applyGroupPositionsLocal(newPositions),
            undo: () => applyGroupPositionsLocal(oldPositions),
          });
        }
      }
```

- [ ] **Step 5: Add the group-position mutator**

In `bpmn-canvas.tsx`, replace `applyNodePositionLocal` (lines 920-939) with a list-based version (used by both single and group moves):
```ts
  const applyGroupPositionsLocal = useCallback(
    (positions: Array<{ id: UUID; x: number; relativeY: number; laneId: UUID | null }>) => {
      const byId = new Map(positions.map((p) => [p.id, p]));
      setNodes((curr) =>
        curr.map((n) => {
          const p = byId.get(n.id);
          return p ? { ...n, x: p.x, relativeY: p.relativeY, laneId: p.laneId } : n;
        })
      );
      for (const p of positions) {
        markNode(p.id, { x: p.x, relative_y: p.relativeY, lane_id: p.laneId ?? undefined });
      }
    },
    [markNode]
  );
```
(Search for any other reference to `applyNodePositionLocal` — there are none after Step 4 replaces the single-move `record` call — so the old name is fully removed.)

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: marquee-select 3 nodes, drag one → all three move together (including across lanes); release → undo (`Cmd/Ctrl+Z`) snaps all three back in one step; redo re-applies. Dragging an *unselected* node still moves just that node.

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(canvas): group move for multi-selection with grouped undo"
```

---

## Task 10: Bulk-action bar + imperative selection methods

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (imperative `deleteSelection`/`copySelection`/`moveSelectionToLane`)
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` (bulk-action bar)

> Note: `copySelection` is fully wired in Task 11 (it needs `useClipboard`). Here it is added as a stub that Task 11 fills in, so the handle shape is stable. The bulk bar's Copy button calls it.

- [ ] **Step 1: Add a lane-reassign-with-undo impl**

In `bpmn-canvas.tsx`, after `applyGroupPositionsLocal` (from Task 9), add:
```ts
  const moveSelectionToLaneImpl = useCallback(
    (laneId: UUID) => {
      const ids = [...selectedIdsRef.current].filter((id) =>
        nodesRef.current.some((n) => n.id === id)
      );
      if (ids.length === 0) return;
      const oldPositions = ids.map((id) => {
        const n = nodesRef.current.find((nn) => nn.id === id)!;
        return { id, x: n.x, relativeY: n.relativeY, laneId: n.laneId };
      });
      const newPositions = oldPositions.map((p) => ({ ...p, relativeY: 0, laneId }));
      applyGroupPositionsLocal(newPositions);
      record({
        description: `Move ${ids.length} to lane`,
        do: () => applyGroupPositionsLocal(newPositions),
        undo: () => applyGroupPositionsLocal(oldPositions),
      });
    },
    [applyGroupPositionsLocal, record]
  );
```

- [ ] **Step 2: Add a copy stub (filled in Task 11)**

In `bpmn-canvas.tsx`, after the impl above, add:
```ts
  const copySelectionImpl = useCallback(() => {
    // Wired to the clipboard in Task 11.
  }, []);
```

- [ ] **Step 3: Extend the imperative handle**

In `bpmn-canvas.tsx`, add to `BpmnCanvasHandle` (after `selectNode`, ~line 128):
```ts
  /** Delete every selected node and edge (node deletes are non-undoable). */
  deleteSelection: () => Promise<void>;
  /** Copy the current selection to the in-memory clipboard. */
  copySelection: () => void;
  /** Reassign every selected node to a lane (grouped undo). */
  moveSelectionToLane: (laneId: UUID) => void;
```
Add them to the `useImperativeHandle` object (lines 393-400):
```ts
      deleteSelection: deleteSelectionImpl,
      copySelection: copySelectionImpl,
      moveSelectionToLane: moveSelectionToLaneImpl,
```
and to its dependency array (line 401): append `deleteSelectionImpl, copySelectionImpl, moveSelectionToLaneImpl`.

- [ ] **Step 4: Build the bulk-action bar on the page**

In `page.tsx`, add a `BulkActionBar` component at the bottom of the file (after `SaveIndicator`):
```tsx
function BulkActionBar({
  count,
  lanes,
  onDelete,
  onCopy,
  onMoveToLane,
}: {
  count: number;
  lanes: { id: string; name: string }[];
  onDelete: () => void;
  onCopy: () => void;
  onMoveToLane: (laneId: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: "rgba(255,255,255,0.98)",
        borderRadius: 8,
        border: "1px solid #e2e8f0",
        boxShadow: "0 8px 28px -8px rgba(15,23,42,0.18)",
        fontSize: 13,
        height: 44,
      }}
    >
      <span style={{ fontWeight: 600 }}>{count} selected</span>
      <span style={{ color: "#94a3b8" }}>·</span>
      <Button size="sm" variant="outline" onClick={onCopy}>
        Copy
      </Button>
      <select
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) {
            onMoveToLane(e.target.value);
            e.target.value = "";
          }
        }}
        style={{
          height: 32,
          borderRadius: 6,
          border: "1px solid #e2e8f0",
          fontSize: 12,
          padding: "0 6px",
        }}
      >
        <option value="" disabled>
          Move to lane…
        </option>
        {lanes.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <Button size="sm" variant="destructive" onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Render the bar in the Properties slot when multi-selected**

In `page.tsx`, the Properties wrapper currently renders only when `selectedNode && data` (lines 277-301). Add a sibling block for multi-selection, immediately after that wrapper:
```tsx
      {selected.kind === "multi" && data && (
        <div
          style={{
            position: "absolute",
            right: rightCollapsed ? 64 : 384,
            top: 60,
            zIndex: 25,
            transition: "right 150ms ease",
          }}
        >
          <BulkActionBar
            count={selected.nodeIds.length + selected.edgeIds.length}
            lanes={data.lanes.map((l) => ({ id: l.id, name: l.name }))}
            onDelete={() => canvasRef.current?.deleteSelection()}
            onCopy={() => canvasRef.current?.copySelection()}
            onMoveToLane={(laneId) => canvasRef.current?.moveSelectionToLane(laneId as UUID)}
          />
        </div>
      )}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: marquee-select 2+ nodes → the bulk bar appears where Properties normally is, showing "N selected"; "Move to lane…" reassigns all to the chosen lane (undoable); Delete removes them all. (Copy does nothing yet — Task 11.)

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(canvas): bulk-action bar (delete / copy / move-to-lane) for multi-select"
```

---

## Task 11: Copy / paste / duplicate (in-memory)

**Files:**
- Create: `src/components/canvas/use-clipboard.ts`
- Modify: `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Create the clipboard hook**

Create `src/components/canvas/use-clipboard.ts`:
```ts
import { useCallback, useRef } from "react";

import type { UUID } from "@/lib/types";
import type { CanvasNodeKind } from "./types";

export interface ClipboardNode {
  oldId: UUID;
  type: string;
  kind: CanvasNodeKind;
  label: string;
  laneId: UUID | null;
  x: number;
  relativeY: number;
  w: number;
  h: number;
}

export interface ClipboardEdge {
  fromOldId: UUID;
  toOldId: UUID;
  label: string | null;
}

export interface ClipboardSnapshot {
  nodes: ClipboardNode[];
  edges: ClipboardEdge[];
}

/** In-memory, same-tab clipboard for canvas nodes + the edges between them. */
export function useClipboard() {
  const ref = useRef<ClipboardSnapshot | null>(null);
  const copy = useCallback((snapshot: ClipboardSnapshot) => {
    ref.current = snapshot.nodes.length > 0 ? snapshot : null;
  }, []);
  const get = useCallback(() => ref.current, []);
  const hasContent = useCallback(() => !!ref.current && ref.current.nodes.length > 0, []);
  return { copy, get, hasContent };
}
```

- [ ] **Step 2: Instantiate the hook + paste offset constant**

In `bpmn-canvas.tsx`, add the import:
```ts
import { useClipboard, type ClipboardSnapshot } from "./use-clipboard";
```
Add a constant near the others (~line 47):
```ts
const PASTE_OFFSET = 24;
```
Inside the component, near the undo stack (~line 188), add:
```ts
  const clipboard = useClipboard();
```

- [ ] **Step 3: Implement copy (build a snapshot from the selection)**

Replace the `copySelectionImpl` stub (from Task 10) with:
```ts
  const copySelectionImpl = useCallback(() => {
    const ids = new Set(
      [...selectedIdsRef.current].filter((id) =>
        nodesRef.current.some((n) => n.id === id)
      )
    );
    if (ids.size === 0) return;
    const nodes = nodesRef.current
      .filter((n) => ids.has(n.id))
      .map((n) => ({
        oldId: n.id,
        type: n.type,
        kind: n.kind,
        label: n.label,
        laneId: n.laneId,
        x: n.x,
        relativeY: n.relativeY,
        w: n.w,
        h: n.h,
      }));
    const edges = edgesRef.current
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ fromOldId: e.from, toOldId: e.to, label: e.label }));
    clipboard.copy({ nodes, edges });
  }, [clipboard]);
```

- [ ] **Step 4: Implement paste**

In `bpmn-canvas.tsx`, after `copySelectionImpl`, add:
```ts
  const pasteClipboardImpl = useCallback(async () => {
    const snap = clipboard.get();
    if (!snap || snap.nodes.length === 0) return;
    const fallbackLane = lanesRef.current[0];
    const idMap = new Map<UUID, UUID>();
    const createdNodes: CanvasNode[] = [];
    const createdEdgeIds: UUID[] = [];
    try {
      for (const cn of snap.nodes) {
        const laneId =
          (cn.laneId && lanesRef.current.some((l) => l.id === cn.laneId)
            ? cn.laneId
            : fallbackLane?.id) ?? null;
        if (!laneId) continue;
        const created = await api.createNode(projectId, modelId, versionId, {
          type: cn.type,
          name: cn.label,
          lane_id: laneId,
          x: cn.x + PASTE_OFFSET,
          relative_y: cn.relativeY + PASTE_OFFSET,
        });
        idMap.set(cn.oldId, created.id);
        createdNodes.push({
          id: created.id,
          type: cn.type,
          kind: cn.kind,
          label: created.name,
          laneId,
          x: cn.x + PASTE_OFFSET,
          relativeY: cn.relativeY + PASTE_OFFSET,
          w: cn.w,
          h: cn.h,
        });
      }
      setNodes((curr) => [...curr, ...createdNodes]);
      for (const ce of snap.edges) {
        const from = idMap.get(ce.fromOldId);
        const to = idMap.get(ce.toOldId);
        if (!from || !to) continue;
        const created = await api.createEdge(projectId, modelId, versionId, {
          source_node_id: from,
          target_node_id: to,
          label: ce.label ?? undefined,
        });
        createdEdgeIds.push(created.id);
        setEdges((curr) => [
          ...curr,
          { id: created.id, from, to, label: created.label ?? null },
        ]);
      }
      setSelectedIds(new Set(createdNodes.map((n) => n.id)));
      const newNodeIds = createdNodes.map((n) => n.id);
      const newEdgeIds = [...createdEdgeIds];
      record({
        description: `Paste ${createdNodes.length} item${createdNodes.length > 1 ? "s" : ""}`,
        // Redo of paste is intentionally a no-op for the created ids (they were
        // already removed by undo); a fresh paste re-creates with new ids. We
        // only support undo (delete the pasted items) here.
        do: () => {},
        undo: async () => {
          for (const id of newEdgeIds) {
            await api.deleteEdge(projectId, id).catch(() => {});
          }
          for (const id of newNodeIds) {
            await api.deleteNode(projectId, id).catch(() => {});
          }
          setEdges((curr) => curr.filter((e) => !newEdgeIds.includes(e.id)));
          setNodes((curr) => curr.filter((n) => !newNodeIds.includes(n.id)));
          setSelectedIds(new Set());
        },
      });
    } catch (err) {
      console.error("Failed to paste", err);
      toast.error("Couldn't paste — please try again.");
    }
  }, [clipboard, projectId, modelId, versionId, record]);
```

> **Note on redo:** since paste creates server rows with fresh ids, a true redo would need to re-create them. To keep this honest and simple, paste records an **undo-only** entry (`do` is a no-op); redoing a paste is not supported (the user can paste again). This is acceptable for SP-1 and avoids dangling-id bugs. If you'd rather not show it on the redo stack at all, that's a future refinement.

- [ ] **Step 5: Wire Cmd/Ctrl+C / +V into the keyboard handler**

In the keydown handler, in the `if (mod && ...)` area (after the undo/redo `z`/`y` branches, ~line 431), add:
```ts
      if (mod && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copySelectionImpl();
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        void pasteClipboardImpl();
        return;
      }
```
(Plain `c`/`v` without `mod` remain the tool shortcuts from Task 8 — the `mod` guard keeps them distinct.)
Add `copySelectionImpl, pasteClipboardImpl` to that effect's dependency array.

- [ ] **Step 6: Expose paste for the context menu (Task 13 uses it)**

No new handle method needed for keyboard paste, but Task 13's canvas context menu calls `pasteClipboardImpl` directly (same module). No action here beyond ensuring `pasteClipboardImpl` is in scope (it is).

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: select 2 connected nodes → `Cmd/Ctrl+C` → `Cmd/Ctrl+V` → two new nodes appear offset by 24px with the connecting edge intact, and the pasted set becomes the selection; `Cmd/Ctrl+Z` removes them; the bulk-bar **Copy** then `Cmd/Ctrl+V` also works.

- [ ] **Step 8: Commit**

```bash
git add src/components/canvas/use-clipboard.ts src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(canvas): in-memory copy/paste of nodes + internal edges"
```

---

## Task 12: Right-click context menus

**Files:**
- Create: `src/components/canvas/canvas-context-menu.tsx`
- Modify: `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Create the menu component**

Create `src/components/canvas/canvas-context-menu.tsx`:
```tsx
"use client";

import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function CanvasContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening contextmenu event doesn't immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("wheel", close, { passive: true });
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("wheel", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 50,
        minWidth: 160,
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: 4,
        boxShadow: "0 12px 32px -8px rgba(15,23,42,0.25)",
        fontSize: 13,
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "6px 10px",
            borderRadius: 6,
            border: "none",
            background: "transparent",
            color: item.disabled ? "#cbd5e1" : "#0f172a",
            cursor: item.disabled ? "not-allowed" : "pointer",
          }}
          onMouseEnter={(e) => {
            if (!item.disabled)
              (e.currentTarget as HTMLButtonElement).style.background = "#f1f5f9";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Import + add menu state**

In `bpmn-canvas.tsx`, add the import:
```ts
import { CanvasContextMenu, type ContextMenuItem } from "./canvas-context-menu";
```
Add state near the others (~line 183):
```ts
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
```

- [ ] **Step 3: Build the menu openers**

In `bpmn-canvas.tsx`, after `pasteClipboardImpl` (Task 11), add:
```ts
  const openNodeMenu = useCallback(
    (e: MouseEvent, nodeId: UUID) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectedIdsRef.current.has(nodeId)) selectOnly(nodeId);
      const count = selectedIdsRef.current.size;
      const suffix = count > 1 ? ` ${count}` : "";
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: `Copy${suffix}`, onSelect: copySelectionImpl },
          {
            label: "Duplicate",
            onSelect: () => {
              copySelectionImpl();
              void pasteClipboardImpl();
            },
          },
          { label: `Delete${suffix}`, onSelect: () => void deleteSelectionImpl() },
        ],
      });
    },
    [selectOnly, copySelectionImpl, pasteClipboardImpl, deleteSelectionImpl]
  );

  const openEdgeMenu = useCallback(
    (e: MouseEvent, edgeId: UUID) => {
      e.preventDefault();
      e.stopPropagation();
      selectOnly(edgeId);
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Edit label", onSelect: () => setEditingEdgeId(edgeId) },
          { label: "Delete", onSelect: () => void deleteEdgeImpl(edgeId) },
        ],
      });
    },
    [selectOnly, deleteEdgeImpl]
  );

  const openCanvasMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: "Paste",
            disabled: !clipboard.hasContent(),
            onSelect: () => void pasteClipboardImpl(),
          },
          {
            label: "Select all",
            onSelect: () =>
              setSelectedIds(new Set(nodesRef.current.map((n) => n.id))),
          },
          { label: "Fit to screen", onSelect: fitToWorld },
        ],
      });
    },
    [clipboard, pasteClipboardImpl, fitToWorld]
  );
```

- [ ] **Step 4: Wire `onContextMenu` on background, nodes, edges**

- Background: on the `<svg>` element (~line 1125), add `onContextMenu={openCanvasMenu}`.
- Node: `NodeShape` must forward a context-menu handler. In the `<NodeShape .../>` JSX (~line 1221), add `onContextMenu={openNodeMenu}`. Then in `shapes.tsx`, add `onContextMenu?: (e: MouseEvent, id: string) => void;` to `NodeShape`'s props and attach it to the node's root `<g>`: `onContextMenu={(e) => onContextMenu?.(e, node.id)}`.
- Edge: `EdgeArrow` similarly. In the `<EdgeArrow .../>` JSX (~line 1207), add `onContextMenu={openEdgeMenu}`; in `shapes.tsx`, add the prop to `EdgeArrow` and attach to its clickable path group: `onContextMenu={(e) => onContextMenu?.(e, edge.id)}`.

(If `MouseEvent` isn't already imported in `shapes.tsx`, import the React type: `import type { MouseEvent } from "react";`.)

- [ ] **Step 5: Render the menu**

In `bpmn-canvas.tsx`, just before the closing `</div>` of the component (after `<FloatingToolbar .../>`, ~line 1313), add:
```tsx
      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
```

- [ ] **Step 6: Cancel context menu when a drag starts**

In `onSvgMouseDown` and `onNodeMouseDown`, add `setContextMenu(null);` as the first line of each (so left-click interactions dismiss an open menu).

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: right-click a node → Copy / Duplicate / Delete (Duplicate creates an offset copy); right-click with 3 selected → labels read "Copy 3" / "Delete 3"; right-click an edge → Edit label / Delete; right-click empty canvas → Paste (disabled until you've copied), Select all, Fit to screen; the menu closes on outside-click, Esc, scroll, or after an action.

- [ ] **Step 8: Commit**

```bash
git add src/components/canvas/canvas-context-menu.tsx src/components/canvas/bpmn-canvas.tsx src/components/canvas/shapes.tsx
git commit -m "feat(canvas): right-click context menus for nodes, edges, canvas"
```

---

## Task 13: Lane collapse (session-only)

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx` (collapsed state, `displayLanes`, render/geometry, hidden nodes/edges)
- Modify: `src/components/canvas/lane-rail.tsx` (chevron + props)

- [ ] **Step 1: Add collapsed state + constant**

In `bpmn-canvas.tsx`, add a constant (~line 47):
```ts
const COLLAPSED_LANE_HEIGHT = 28;
```
Add state (~line 183):
```ts
  const [collapsedLaneIds, setCollapsedLaneIds] = useState<Set<string>>(() => new Set());
  const toggleLaneCollapse = useCallback((laneId: string) => {
    setCollapsedLaneIds((curr) => {
      const next = new Set(curr);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  }, []);
```

- [ ] **Step 2: Compute `displayLanes` (collapse-aware geometry)**

In `bpmn-canvas.tsx`, after `worldHeight` (~line 495), add:
```ts
  // Lane geometry as shown on screen: collapsed lanes shrink to a thin strip.
  // The real `lanes` (true heights) are kept for persistence; only display
  // geometry changes, so expanding restores the stored height.
  const displayLanes = useMemo(() => {
    let y = 0;
    return lanes.map((l) => {
      const h = collapsedLaneIds.has(l.id) ? COLLAPSED_LANE_HEIGHT : l.h;
      const out = { ...l, y, h };
      y += h;
      return out;
    });
  }, [lanes, collapsedLaneIds]);

  const displayLanesRef = useRef(displayLanes);
  displayLanesRef.current = displayLanes;
```

- [ ] **Step 3: Resolve node Y against `displayLanes` + hide collapsed nodes**

Replace `renderNodes` (lines 497-506) with:
```ts
  const renderNodes: ResolvedNode[] = useMemo(() => {
    const laneMap = new Map(displayLanes.map((l) => [l.id, l]));
    return nodes
      .filter((n) => !(n.laneId && collapsedLaneIds.has(n.laneId)))
      .map((n) => {
        const lane = n.laneId ? laneMap.get(n.laneId) : undefined;
        const y = lane ? lane.y + n.relativeY : n.relativeY;
        const { relativeY: _ignore, ...rest } = n;
        void _ignore;
        return { ...rest, y };
      });
  }, [nodes, displayLanes, collapsedLaneIds]);
```

- [ ] **Step 4: Use `displayLanes` for world height, lane bands, and drag geometry**

- `worldHeight` (lines 492-495): change `lanes.reduce(...)` to `displayLanes.reduce(...)` and add `displayLanes` to its dep array. (Define `worldHeight` after `displayLanes`, or compute height inline from `displayLanes`.) Simplest: replace the `worldHeight` memo body with:
```ts
  const worldHeight = useMemo(() => {
    const maxBottom = displayLanes.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    return Math.max(620, maxBottom);
  }, [displayLanes]);
```
  (Move the `worldHeight` declaration to **after** `displayLanes` so it's in scope.)
- Lane band render (lines 1177-1205): map over `displayLanes` instead of `lanes`.
- Edges render: filter out edges touching a collapsed lane. Replace the `edges.map(...)` opener (line 1206) by first computing visible edges:
```tsx
          {edges
            .filter((edge) => {
              const f = nodes.find((n) => n.id === edge.from);
              const t = nodes.find((n) => n.id === edge.to);
              const hidden = (n?: CanvasNode) => !!n?.laneId && collapsedLaneIds.has(n.laneId);
              return !hidden(f) && !hidden(t);
            })
            .map((edge) => (
```
- In `onMove`/`onUp`/`onCanvasDrop`, the calls to `laneAtY(..., lanesRef.current)` and lane lookups for node Y must use **display** geometry so positions line up with what's on screen. Change those reads from `lanesRef.current` to `displayLanesRef.current`:
  - Group-move `onMove` (Task 9 Step 3): `const currLanes = displayLanesRef.current;`
  - `onCanvasDrop` (line 865): `const currLanes = displayLanesRef.current;`
  - The connect `onUp` node-Y resolution (lines 768-771) and `onNodeMouseDown` group-capture lane lookup (Task 9 Step 2): use `displayLanesRef.current`.
  - **Skip collapsed lanes as drop targets:** in `onCanvasDrop` after computing `targetLane`, add: `if (!targetLane || collapsedLaneIds.has(targetLane.id)) return;` (so dropped shapes don't vanish into a thin lane).

> Note: persistence (`markNode` with `relative_y`) stays relative to the lane's *stored* height. Because collapsed lanes hide their nodes (you can't drag a hidden node), and dropping into a collapsed lane is blocked, no node ever gets a `relative_y` computed against the 28px display height. Expanding restores correct positions.

- [ ] **Step 5: Pass display geometry + collapse props to `LaneRail`**

In the `<LaneRail .../>` JSX (lines 1285-1293), change `lanes={lanes}` to `lanes={displayLanes}` and add:
```tsx
        collapsedLaneIds={collapsedLaneIds}
        onToggleCollapse={toggleLaneCollapse}
```

- [ ] **Step 6: Add the chevron to `LaneRail`**

In `lane-rail.tsx`:
- Add to the props interface (near `onDeleteLane`, ~line 37):
```ts
  collapsedLaneIds: Set<string>;
  onToggleCollapse: (laneId: string) => void;
```
- Add to the destructured props (near `onDeleteLane`, ~line 29): `collapsedLaneIds, onToggleCollapse,`.
- In each lane header (near the lane label render, around the rotated label block ~line 230), add a small chevron button that calls `onToggleCollapse(lane.id)`. Insert this button inside the lane header container:
```tsx
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onToggleCollapse(lane.id);
                  }}
                  title={collapsedLaneIds.has(lane.id) ? "Expand lane" : "Collapse lane"}
                  style={{
                    position: "absolute",
                    top: 4,
                    left: `${headerW / 2 - 8}px`,
                    width: 16,
                    height: 16,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "#475569",
                    padding: 0,
                    zIndex: 3,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    {collapsedLaneIds.has(lane.id) ? (
                      <path d="M9 18l6-6-6-6" />
                    ) : (
                      <path d="M6 9l6 6 6-6" />
                    )}
                  </svg>
                </button>
```
(Place it so it doesn't overlap the rename input / options button — adjust `top`/`left` to sit at the top of the lane strip. The exact pixel placement can be tuned during the manual check; the behavior is what matters.)

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.
Manual: click a lane's chevron → the lane shrinks to a thin strip, its nodes and any edges touching them disappear, and lanes below shift up; click again → it expands and everything returns to its original position; dropping a palette shape onto a collapsed lane is prevented (it lands in an expanded lane); reloading the page resets all lanes to expanded (session-only, as intended).

- [ ] **Step 8: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx src/components/canvas/lane-rail.tsx
git commit -m "feat(canvas): collapsible lanes (session-only view state)"
```

---

## Task 14: Full-pass verification + build

**Files:** none (verification only).

- [ ] **Step 1: Static gates**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: tests pass, no type errors, no lint errors, production build succeeds.

- [ ] **Step 2: Manual regression checklist (against `./run-local.sh`)**

Walk every item; all must hold:
- Header counts update live on add/delete of node/edge/lane.
- `+`/`−` zoom stays centered; Cmd/Ctrl+wheel zooms to cursor; Fit works.
- Killing the backend mid-drop shows a red toast (then restart it).
- `V`/`H`/`C` switch tools; `Esc` returns to Select and clears selection.
- Pan tool drags-to-pan anywhere (incl. over nodes), cursor is a hand.
- Marquee selects on empty-canvas drag; Shift+drag adds; Shift+click toggles.
- Group move of a multi-selection moves all together; one undo reverts all.
- Bulk bar: N-selected count, Copy, Move-to-lane (undoable), Delete.
- Copy/paste (keyboard + bulk bar) duplicates nodes + internal edges, offset, selects the paste; undo removes them.
- Context menus on node/edge/canvas with correct items + counts; close behaviors.
- Lane collapse/expand hides+restores nodes/edges and reflows lanes; reload resets.
- Pre-existing flows still work: single-select Properties edit, edge bend, lane rename/resize/reorder/add/delete, Issues-tab focus, BPMN-XML dialog, Chat tab.

- [ ] **Step 3: Commit (if any tuning edits were needed)**

```bash
git add -A
git commit -m "test(canvas): SP-1 full-pass verification fixes"
```
(If no edits were needed, skip the commit.)

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Live counts → Task 5. Centered zoom → Task 4. Failure toasts → Task 6.
- Tool semantics + V/H/C/Esc → Task 8. Multi-select/marquee → Tasks 7–8. Group move → Task 9. Group delete (per-item semantics) → Task 7 (`deleteSelectionImpl`). Selection union + bulk bar → Tasks 7, 10.
- Copy/paste + duplicate → Tasks 11–12. Context menus → Task 12. Lane collapse → Task 13.
- `CanvasNode.type` addition → Task 3. Vitest decision → Task 1. Review-toggle kept → untouched (no task removes it; confirmed in Task 4 it stays).
- Verification → Task 14.

**Placeholder scan** — the only `do: () => {}` is the deliberate, documented undo-only paste entry (Task 11, with a note explaining why redo of paste is unsupported). No TBDs; all code blocks are concrete.

**Type consistency** — `CanvasSelection`, `BpmnCanvasHandle` additions (`deleteSelection`/`copySelection`/`moveSelectionToLane`), the `Drag` `node`/`marquee` variants, `ClipboardSnapshot`/`ClipboardNode`/`ClipboardEdge`, `ContextMenuItem`, and `applyGroupPositionsLocal` are defined once and referenced with matching names/signatures throughout. `copySelectionImpl` is introduced as a stub in Task 10 and filled in Task 11 (called out explicitly). `applyNodePositionLocal` is fully replaced by `applyGroupPositionsLocal` (Task 9 Step 5 notes no remaining references).

**Known interim states** (acceptable, each resolved a task later): after Task 7 multi-selection is representable but has no UI (marquee lands in Task 8, bulk bar in Task 10); `copySelection` is a no-op between Tasks 10 and 11.
