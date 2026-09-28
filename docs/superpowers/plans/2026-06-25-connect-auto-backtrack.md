# Connect-tool auto-backtrack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Connect tool automatically draw an amber backtrack loop when you connect to an earlier step, draw a normal arrow when you connect to a later step, and stop dropping connections that land just outside a node.

**Architecture:** Two pure, unit-tested helpers — one decides which node a release point lands on (with tolerance), one classifies a connection as backtrack-or-not and derives its loop faces. The canvas drop handler and the live drag preview both call these helpers, so what you preview is what you get. The dedicated Rework tool is removed; all logic moves into the existing Connect drop path. Backend is untouched.

**Tech Stack:** Next.js / React / TypeScript, custom SVG canvas (`src/components/canvas/`), Vitest.

## Global Constraints

- The backend stays exactly as-is: `process_edges` columns `source_side`/`target_side`/`edge_kind`, migration `0011`, schemas, `create_edge`, and `buildPinnedEdgePath` are NOT modified by this plan.
- Forward connections must keep byte-for-byte today's behavior (normal `flow` edge, geometric auto-routing).
- A connection is a backtrack only when the target node's horizontal center is left of the source node's center by more than a dead-zone (default 24 world units).
- Loop faces: source face from the grabbed handle (`top`→top, anything else→`bottom`); target face from which half of the target box the release point is over.
- Drop hit-test tolerance: a release point within 20 world units of a node's rectangle resolves to that node (nearest wins); beyond that, no target.
- Work happens on branch `feat/rework-backtrack-edge`. Commit after every task.

---

### Task 1: Pure drop-target picker

**Files:**
- Create: `src/components/canvas/drop-target.ts`
- Test: `src/components/canvas/drop-target.test.ts`

**Interfaces:**
- Produces:
  - `interface RectLike { id: string; x: number; y: number; w: number; h: number }`
  - `distanceToRect(px: number, py: number, r: { x: number; y: number; w: number; h: number }): number` — 0 when the point is inside.
  - `pickDropTargetId(px: number, py: number, candidates: RectLike[], tolerance?: number): string | null` — id of the candidate whose rectangle is nearest the point when that distance ≤ `tolerance` (default 20); else `null`. Caller excludes the source node from `candidates`.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/canvas/drop-target.test.ts
import { describe, it, expect } from "vitest";
import { distanceToRect, pickDropTargetId } from "./drop-target";

const A = { id: "A", x: 0, y: 0, w: 100, h: 60 };       // covers (0..100, 0..60)
const B = { id: "B", x: 200, y: 0, w: 100, h: 60 };     // covers (200..300, 0..60)

describe("distanceToRect", () => {
  it("is 0 inside the rect", () => {
    expect(distanceToRect(50, 30, A)).toBe(0);
  });
  it("measures the gap to the nearest edge", () => {
    expect(distanceToRect(110, 30, A)).toBe(10); // 10px right of the right edge
  });
  it("measures the diagonal gap past a corner", () => {
    expect(distanceToRect(103, 64, A)).toBeCloseTo(5); // 3 right, 4 below -> 5
  });
});

describe("pickDropTargetId", () => {
  it("returns the node the point sits inside", () => {
    expect(pickDropTargetId(50, 30, [A, B])).toBe("A");
  });
  it("snaps to a node just outside its edge within tolerance", () => {
    expect(pickDropTargetId(110, 30, [A, B], 20)).toBe("A"); // 10px out, tol 20
  });
  it("returns null when nothing is within tolerance", () => {
    expect(pickDropTargetId(150, 200, [A, B], 20)).toBeNull();
  });
  it("picks the nearer node when the point sits between two", () => {
    // 160 is 60px from A's right edge (x=100) and 40px from B's left edge (x=200).
    expect(pickDropTargetId(160, 30, [A, B], 100)).toBe("B");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/canvas/drop-target.test.ts`
Expected: FAIL — `distanceToRect`/`pickDropTargetId` not exported.

- [ ] **Step 3: Write minimal implementation**

Create the module:

```ts
// src/components/canvas/drop-target.ts

export interface RectLike {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Distance from a point to the nearest edge of a rect; 0 when inside. */
export function distanceToRect(
  px: number,
  py: number,
  r: { x: number; y: number; w: number; h: number }
): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * The candidate whose rectangle is nearest the point, provided that distance is
 * within `tolerance` world units (0 = the point must be inside). Returns its id,
 * or null when no candidate qualifies. Callers exclude the source node from
 * `candidates` so an edge can't target itself.
 */
export function pickDropTargetId(
  px: number,
  py: number,
  candidates: RectLike[],
  tolerance = 20
): string | null {
  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = distanceToRect(px, py, c);
    if (d < bestDist) {
      bestDist = d;
      bestId = c.id;
    }
  }
  return bestDist <= tolerance ? bestId : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/canvas/drop-target.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/drop-target.ts src/components/canvas/drop-target.test.ts
git commit -m "feat(canvas): tolerant drop-target picker"
```

---

### Task 2: Backtrack classification + loop-face derivation

**Files:**
- Create: `src/components/canvas/backtrack.ts`
- Test: `src/components/canvas/backtrack.test.ts`

**Interfaces:**
- Consumes: `ConnectSide` (`"top" | "right" | "bottom" | "left"`) from `./shapes`.
- Produces:
  - `BACKTRACK_DEADZONE_PX = 24`
  - `isBacktrack(source: { x: number; w: number }, target: { x: number; w: number }, deadzone?: number): boolean` — true when target center x < source center x − deadzone.
  - `deriveLoopSides(grabbedSide: ConnectSide, dropY: number, target: { y: number; h: number }): { sourceSide: "top" | "bottom"; targetSide: "top" | "bottom" }` — sourceSide is `"top"` only when `grabbedSide === "top"`, else `"bottom"`; targetSide is `"top"` when `dropY` is in the target's top half, else `"bottom"`.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/canvas/backtrack.test.ts
import { describe, it, expect } from "vitest";
import { isBacktrack, deriveLoopSides, BACKTRACK_DEADZONE_PX } from "./backtrack";

const later = { x: 400, w: 120 };   // center 460
const earlier = { x: 0, w: 120 };   // center 60
const target = { y: 100, h: 60 };   // top half y<130, bottom half y>=130

describe("isBacktrack", () => {
  it("is true when the target sits clearly left of the source", () => {
    expect(isBacktrack(later, earlier)).toBe(true);
  });
  it("is false when the target sits to the right", () => {
    expect(isBacktrack(earlier, later)).toBe(false);
  });
  it("is false inside the dead-zone (near-vertical stack)", () => {
    const a = { x: 0, w: 100 };               // center 50
    const b = { x: -10, w: 100 };             // center 40, only 10 left < 24
    expect(isBacktrack(a, b)).toBe(false);
    expect(BACKTRACK_DEADZONE_PX).toBe(24);
  });
});

describe("deriveLoopSides", () => {
  it("top handle + drop in top half => top/top", () => {
    expect(deriveLoopSides("top", 110, target)).toEqual({ sourceSide: "top", targetSide: "top" });
  });
  it("bottom handle + drop in bottom half => bottom/bottom", () => {
    expect(deriveLoopSides("bottom", 150, target)).toEqual({ sourceSide: "bottom", targetSide: "bottom" });
  });
  it("left/right handle defaults the source face to bottom", () => {
    expect(deriveLoopSides("left", 110, target)).toEqual({ sourceSide: "bottom", targetSide: "top" });
    expect(deriveLoopSides("right", 150, target)).toEqual({ sourceSide: "bottom", targetSide: "bottom" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/canvas/backtrack.test.ts`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/canvas/backtrack.ts
import type { ConnectSide } from "./shapes";

/** How far left of the source's center the target's center must sit before a
 * connection counts as a backtrack. Keeps near-vertical links as forward edges. */
export const BACKTRACK_DEADZONE_PX = 24;

export function isBacktrack(
  source: { x: number; w: number },
  target: { x: number; w: number },
  deadzone: number = BACKTRACK_DEADZONE_PX
): boolean {
  const sourceCenterX = source.x + source.w / 2;
  const targetCenterX = target.x + target.w / 2;
  return targetCenterX < sourceCenterX - deadzone;
}

/** Faces for an auto-drawn loop: the source face follows the grabbed handle
 * (top stays top; bottom/left/right default to bottom); the target face follows
 * which half of its box the cursor released over. */
export function deriveLoopSides(
  grabbedSide: ConnectSide,
  dropY: number,
  target: { y: number; h: number }
): { sourceSide: "top" | "bottom"; targetSide: "top" | "bottom" } {
  const sourceSide: "top" | "bottom" = grabbedSide === "top" ? "top" : "bottom";
  const targetSide: "top" | "bottom" =
    dropY < target.y + target.h / 2 ? "top" : "bottom";
  return { sourceSide, targetSide };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/canvas/backtrack.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/backtrack.ts src/components/canvas/backtrack.test.ts
git commit -m "feat(canvas): backtrack classification + loop-face derivation"
```

---

### Task 3: Rewire Connect to auto-detect; remove the Rework tool

**Files:**
- Modify: `src/components/canvas/floating-toolbar.tsx`
- Modify: `src/components/canvas/bpmn-canvas.tsx`
- Modify: `src/components/canvas/shapes.tsx`

**Interfaces:**
- Consumes: `pickDropTargetId`, `RectLike` (Task 1); `isBacktrack`, `deriveLoopSides` (Task 2); existing `buildEdgePath`, `buildPreviewToCursor`, `createEdgeImpl(sourceId, targetId, opts?)`.

This task has no new unit test; its gate is `tsc --noEmit` clean plus the full existing Vitest suite green (including Tasks 1–2 and the unchanged `rework-edge.test.ts`). Do the edits in order, then run the gate in Step 12.

- [ ] **Step 1: Toolbar — drop `"rework"` from the tool union**

In `src/components/canvas/floating-toolbar.tsx` change:

```tsx
export type CanvasTool = "select" | "pan" | "connect" | "rework";
```
to:
```tsx
export type CanvasTool = "select" | "pan" | "connect";
```

- [ ] **Step 2: Toolbar — remove the Rework button and its icon import**

Remove this block (the Rework `ToolButton`):

```tsx
        <ToolButton
          active={tool === "rework"}
          onClick={() => onToolChange("rework")}
          title="Rework / backtrack arrow (R) — drag a top/bottom handle onto an earlier step's top/bottom handle"
        >
          <Undo2 size={14} />
        </ToolButton>
```

And change the import to drop `Undo2`:

```tsx
import { Hand, Undo2 } from "lucide-react";
```
to:
```tsx
import { Hand } from "lucide-react";
```

- [ ] **Step 3: Canvas — add helper imports**

In `src/components/canvas/bpmn-canvas.tsx`, near the other `./` imports (e.g. just after the `buildPreviewToCursor`/`shapes` imports), add:

```tsx
import { pickDropTargetId, type RectLike } from "./drop-target";
import { isBacktrack, deriveLoopSides } from "./backtrack";
```

- [ ] **Step 4: Canvas — remove the `rework` flag from the connect drag type**

Change the connect drag variant:

```tsx
  | {
      type: "connect";
      sourceId: UUID;
      sourceSide: ConnectSide;
      // Live cursor position in world coords for the temp line.
      currX: number;
      currY: number;
      // True when started from the Rework tool: the drop pins source/target
      // faces and creates a distinct backtrack edge instead of an auto-routed one.
      rework?: boolean;
    }
```
to:
```tsx
  | {
      type: "connect";
      sourceId: UUID;
      sourceSide: ConnectSide;
      // Live cursor position in world coords for the temp line.
      currX: number;
      currY: number;
    }
```

- [ ] **Step 5: Canvas — delete the `REWORK_HANDLE_SIDES` constant**

Remove these lines:

```tsx
/** In Rework mode only the top/bottom faces anchor a backtrack loop, so we
 * hide the left/right handles. Module-level for a stable prop reference. */
const REWORK_HANDLE_SIDES: ConnectSide[] = ["top", "bottom"];
```

- [ ] **Step 6: Canvas — remove the `R` keyboard shortcut**

Remove this line:

```tsx
        if (e.key === "r" || e.key === "R") { setTool("rework"); return; }
```

- [ ] **Step 7: Canvas — restore the plain Connect body-drag**

Replace the whole rework-aware body-drag branch:

```tsx
    if (tool === "connect" || tool === "rework") {
      // Body-drag picks the source side from where the user grabbed. Connect
      // allows all four faces; Rework is restricted to top/bottom (the only
      // faces a backtrack loop anchors to).
      const cx = resolved.x + resolved.w / 2;
      const cy = resolved.y + resolved.h / 2;
      const dx = x - cx;
      const dy = y - cy;
      const side: ConnectSide =
        tool === "rework"
          ? dy >= 0
            ? "bottom"
            : "top"
          : Math.abs(dx) > Math.abs(dy)
            ? dx >= 0
              ? "right"
              : "left"
            : dy >= 0
              ? "bottom"
              : "top";
      setDrag({
        type: "connect",
        sourceId: id,
        sourceSide: side,
        currX: x,
        currY: y,
        rework: tool === "rework",
      });
      return;
    }
```
with:
```tsx
    if (tool === "connect") {
      // Body-drag picks the source side from where the user grabbed: the closest
      // of top/right/bottom/left to the click point. Backtrack vs forward is
      // decided on drop, not here.
      const cx = resolved.x + resolved.w / 2;
      const cy = resolved.y + resolved.h / 2;
      const dx = x - cx;
      const dy = y - cy;
      const side: ConnectSide =
        Math.abs(dx) > Math.abs(dy)
          ? dx >= 0
            ? "right"
            : "left"
          : dy >= 0
            ? "bottom"
            : "top";
      setDrag({ type: "connect", sourceId: id, sourceSide: side, currX: x, currY: y });
      return;
    }
```

- [ ] **Step 8: Canvas — drop the `rework` field from `onStartConnect`**

Replace:

```tsx
      setDrag({
        type: "connect",
        sourceId,
        sourceSide: side,
        currX: x,
        currY: y,
        rework: tool === "rework",
      });
    },
    [toWorld, selectOnly, tool]
  );
```
with:
```tsx
      setDrag({ type: "connect", sourceId, sourceSide: side, currX: x, currY: y });
    },
    [toWorld, selectOnly]
  );
```

- [ ] **Step 9: Canvas — rewrite the connect-drop handler to auto-detect backtrack**

Replace the entire `if (drag.type === "connect") { ... }` block inside the document `onUp` handler (the target `find` plus the `if (target) { ... }` body, from `const { x, y } = screenToWorld(...)` through `setDrag(null); return;`) with:

```tsx
      if (drag.type === "connect") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        // Build resolved candidate rects (exclude the source) and pick the
        // nearest within tolerance, so a drop just outside a node still lands.
        const candidates: RectLike[] = nodesRef.current
          .filter((n) => n.id !== drag.sourceId)
          .map((n) => {
            const lane = n.laneId
              ? displayLanesRef.current.find((l) => l.id === n.laneId)
              : undefined;
            const ny = lane ? lane.y + n.relativeY : n.relativeY;
            return { id: n.id, x: n.x, y: ny, w: n.w, h: n.h };
          });
        const targetId = pickDropTargetId(x, y, candidates);
        const targetRect = candidates.find((c) => c.id === targetId);
        if (targetId && targetRect) {
          const sourceId = drag.sourceId;
          const source = nodesRef.current.find((n) => n.id === sourceId);
          const exists = edgesRef.current.some(
            (e2) => e2.from === sourceId && e2.to === targetId
          );
          if (!exists && source && isBacktrack(source, targetRect)) {
            const { sourceSide, targetSide } = deriveLoopSides(
              drag.sourceSide,
              y,
              targetRect
            );
            void createEdgeImpl(sourceId, targetId, {
              sourceSide,
              targetSide,
              kind: "rework",
            }).catch((err) => {
              console.error("Failed to create rework edge", err);
              toast.error("Couldn't add that backtrack arrow — please try again.");
            });
          } else if (!exists) {
            void createEdgeImpl(sourceId, targetId).catch((err) => {
              console.error("Failed to create edge", err);
              toast.error("Couldn't connect those steps — please try again.");
            });
          }
        }
        setDrag(null);
        return;
      }
```

- [ ] **Step 10: Canvas — rewrite the connect preview to mirror the drop decision**

Replace the entire `{drag?.type === "connect" && (() => { ... })()}` preview block with:

```tsx
          {drag?.type === "connect" &&
            (() => {
              const source = renderNodes.find((n) => n.id === drag.sourceId);
              if (!source) return null;
              // Use the same picker as the drop so the preview matches the result.
              const candidates: RectLike[] = renderNodes
                .filter((n) => n.id !== drag.sourceId)
                .map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
              const targetId = pickDropTargetId(drag.currX, drag.currY, candidates);
              const target = targetId
                ? renderNodes.find((n) => n.id === targetId)
                : undefined;
              const backtrack = !!target && isBacktrack(source, target);
              let d: string;
              if (target && backtrack) {
                const { sourceSide, targetSide } = deriveLoopSides(
                  drag.sourceSide,
                  drag.currY,
                  target
                );
                d = buildEdgePath(source, target, { sourceSide, targetSide }).d;
              } else if (target) {
                d = buildEdgePath(source, target).d;
              } else {
                d = buildPreviewToCursor(
                  source,
                  drag.sourceSide,
                  drag.currX,
                  drag.currY
                );
              }
              return (
                <path
                  d={d}
                  fill="none"
                  stroke={backtrack ? "#d97706" : "#0f172a"}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  markerEnd={
                    backtrack ? "url(#poet-arrow-rework)" : "url(#poet-arrow)"
                  }
                  pointerEvents="none"
                />
              );
            })()}
```

- [ ] **Step 11: Canvas — drop the rework-only tool checks (cursor + handles)**

Change the cursor branch:

```tsx
                : tool === "connect" || tool === "rework"
                  ? "crosshair"
                  : "default",
```
to:
```tsx
                : tool === "connect"
                  ? "crosshair"
                  : "default",
```

Change the `NodeShape` props:

```tsx
              showHandles={tool === "connect" || tool === "rework"}
              handleSides={tool === "rework" ? REWORK_HANDLE_SIDES : undefined}
```
to:
```tsx
              showHandles={tool === "connect"}
```

(Leave the `poet-arrow-rework` `<marker>` in `<defs>` — it is still used by the loop edges and the preview.)

- [ ] **Step 12: Shapes — remove the now-unused `handleSides` prop**

In `src/components/canvas/shapes.tsx`, remove `handleSides` from the destructure and the prop type:

```tsx
  reviewBadge,
  showHandles,
  handleSides,
  onMouseDown,
```
back to:
```tsx
  reviewBadge,
  showHandles,
  onMouseDown,
```

and remove:

```tsx
  /** Restricts which connect handles render. Defaults to all four faces;
   * Rework mode passes ["top","bottom"]. */
  handleSides?: ConnectSide[];
```

Then revert the handle render block to always render all four:

```tsx
      {handlesVisible && (
        <>
          {(!handleSides || handleSides.includes("top")) && (
            <ConnectHandle cx={w / 2} cy={0} onMouseDown={(e) => onStartConnect!(e, id, "top")} />
          )}
          {(!handleSides || handleSides.includes("right")) && (
            <ConnectHandle cx={w} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "right")} />
          )}
          {(!handleSides || handleSides.includes("bottom")) && (
            <ConnectHandle cx={w / 2} cy={h} onMouseDown={(e) => onStartConnect!(e, id, "bottom")} />
          )}
          {(!handleSides || handleSides.includes("left")) && (
            <ConnectHandle cx={0} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "left")} />
          )}
        </>
      )}
```
back to:
```tsx
      {handlesVisible && (
        <>
          <ConnectHandle cx={w / 2} cy={0} onMouseDown={(e) => onStartConnect!(e, id, "top")} />
          <ConnectHandle cx={w} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "right")} />
          <ConnectHandle cx={w / 2} cy={h} onMouseDown={(e) => onStartConnect!(e, id, "bottom")} />
          <ConnectHandle cx={0} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "left")} />
        </>
      )}
```

- [ ] **Step 13: Typecheck and run the full suite**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors (no remaining `rework`/`handleSides`/`REWORK_HANDLE_SIDES`/`Undo2` references).

Run: `npx vitest run`
Expected: all test files pass, including `drop-target`, `backtrack`, and the unchanged `rework-edge` tests.

- [ ] **Step 14: Commit**

```bash
git add src/components/canvas/floating-toolbar.tsx src/components/canvas/bpmn-canvas.tsx src/components/canvas/shapes.tsx
git commit -m "feat(canvas): auto-detect backtrack in Connect, remove Rework tool"
```

---

### Task 4: Verify end-to-end and clean up stray test edges

**Files:** none (verification + a guarded data cleanup).

- [ ] **Step 1: Restart the frontend cleanly**

A running Turbopack server may hold stale chunks. Kill the process bound to `:3000`, clear the dev cache, relaunch:

```bash
cd "/home/chagood/workspace/projects/Process Engineering"
for i in 1 2 3; do pid=$(ss -ltnp 2>/dev/null | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1); [ -z "$pid" ] && break; kill "$pid"; sleep 1; done
rm -rf .next/dev
setsid bash -c 'exec npm run dev' > .run/frontend.log 2>&1 < /dev/null &
for i in $(seq 1 30); do ss -ltnp 2>/dev/null | grep -q ':3000' && break; sleep 1; done
ss -ltnp 2>/dev/null | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1 > .run/frontend.pid
```

- [ ] **Step 2: Confirm the canvas route compiles against the live backend**

```bash
PID=019eff31-c748-7e21-b319-f25f5d358e72
MID=019eff45-ff57-7fd2-b33f-b58e178e2926
VID=019eff45-ff59-7dd1-9059-712a6964f7d4
curl -sL "http://localhost:3000/projects/$PID/maps/$MID/versions/$VID" -o /dev/null -w 'canvas: %{http_code}\n'
grep -iE "module not found|failed to compile" .run/frontend.log | tail -5 || echo "(no compile errors)"
```
Expected: `canvas: 200`, no compile errors.

- [ ] **Step 3: Manual smoke test (user-driven)**

In the browser at `http://localhost:3000`, open a map and pick the Connect tool. Verify:
1. Drag from a later step's bottom handle onto an earlier step's bottom half → an amber dashed loop appears below and is saved (reload keeps it).
2. Drag from a later step's top handle onto an earlier step's top half → loop above.
3. Drag from an earlier step to a later step → a normal solid arrow (no loop).
4. Release a hair outside the target node → it still connects (tolerance).
5. There is no Rework button in the toolbar, and pressing `R` does nothing.

- [ ] **Step 4: Confirm new backtrack edges persist with sides**

```bash
cd "/home/chagood/workspace/projects/Process Engineering/backend"
source .venv/bin/activate; set -a; source .env 2>/dev/null; set +a
python -c "
from sqlalchemy import create_engine, text
import os
e=create_engine(os.environ['DATABASE_URL'].replace('+asyncpg','').replace('postgresql:','postgresql+psycopg:'))
with e.connect() as c:
    for r in c.execute(text(\"select edge_kind, source_side, target_side from process_edges where edge_kind='rework' order by created_at desc limit 5\")).fetchall():
        print(dict(r._mapping))
"
```
Expected: rows with `edge_kind=rework` and non-null `source_side`/`target_side`.

- [ ] **Step 5: Guarded cleanup of stray test edges**

Do NOT auto-delete. List the recent `flow` edges with no sides created during earlier testing, show them to the user, and delete only the specific ids the user confirms (via `DELETE /api/v2/projects/{pid}/edges/{edge_id}` or a one-off SQL `DELETE` on confirmed ids). Skip entirely if the user would rather leave them.

- [ ] **Step 6: Final state check**

```bash
cd "/home/chagood/workspace/projects/Process Engineering"
git status --short && git log --oneline -4
```
Expected: clean tree, the three feature commits plus the spec commit present on `feat/rework-backtrack-edge`.
