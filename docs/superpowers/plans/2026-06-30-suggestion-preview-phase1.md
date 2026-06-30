# Suggestion Preview ("Walk the Change") — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user preview an AI suggestion bundle on the canvas as non-committal ghosts (Apply commits, Cancel reverts), without persisting anything until Apply.

**Architecture:** A new pure module (`suggestion-shadow.ts`) applies a `BundlePlan` to an in-memory copy of the canvas's positioned state and diffs it against the live state. The canvas renders the *merge* of live + shadow while previewing, styling each delta (added / changed / removed) from the diff. New-node placement is extracted into a shared pure helper so the preview matches what Apply produces. No backend changes; deletion-impact + provenance are Phase 2.

**Tech Stack:** TypeScript, React (Next.js app), Vitest (`npm test` → `vitest run`). Canvas state is `CanvasNode[]` / `CanvasEdge[]` / `CanvasLane[]` (see `src/components/canvas/types.ts`), positioned via `relativeY` within lanes.

**Spec:** `docs/superpowers/specs/2026-06-30-suggestion-preview-deletion-impact-design.md`

---

## File structure

- **Create** `src/components/canvas/suggestion-shadow.ts` — pure: `applyPlanToCanvas(state, plan)` + `diffCanvas(before, after)` + the `CanvasState` / `CanvasDiff` types.
- **Create** `src/components/canvas/suggestion-shadow.test.ts` — unit tests.
- **Modify** `src/components/canvas/ai-edit.ts` — add pure `placeNewNodeIn(nodes, lanes, laneId, nearNodeId)` (extracted from the canvas's `placeNewNode`).
- **Modify** `src/components/canvas/ai-edit.test.ts` — tests for `placeNewNodeIn`.
- **Modify** `src/components/canvas/layout.ts` — export `recomputeY` (moved from `bpmn-canvas.tsx`) so the shadow reducer and the canvas share one copy.
- **Modify** `src/components/canvas/bpmn-canvas.tsx` — use `placeNewNodeIn` + imported `recomputeY`; add `previewPlan` / `clearPreview` to `BpmnCanvasHandle`; add preview state; render the live+shadow merge with diff-driven ghost styling; suspend edit gestures while previewing.
- **Modify** `src/components/canvas/suggestion-card.tsx` — add a **Preview** button; a `previewing` card state showing **Apply / Cancel**.
- **Modify** `src/components/canvas/chat-tab.tsx` — `onPreview` / `onCancelPreview` props; previewing-bundle state; route Apply through the previewed plan.
- **Modify** `src/components/canvas/right-panel.tsx` — thread `onPreview` / `onCancelPreview` down to `ChatTab`.
- **Modify** `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — `handlePreviewSuggestions` / `handleCancelPreview` delegating to the canvas handle.

---

## Task 1: Extract `placeNewNodeIn` into `ai-edit.ts`

The canvas's `placeNewNode` (bpmn-canvas.tsx:533-549) reads `nodesRef`/`lanesRef`. Extract its logic into a pure function so the shadow reducer places new nodes identically to a real Apply.

**Files:**
- Modify: `src/components/canvas/ai-edit.ts`
- Test: `src/components/canvas/ai-edit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/components/canvas/ai-edit.test.ts`:

```ts
import { placeNewNodeIn } from "./ai-edit";
import type { CanvasNode, CanvasLane } from "./types";

const lane = (id: string, y = 0, h = 150): CanvasLane => ({
  id, label: id, color: "#ccc", collapsed: false, y, h,
});
const node = (id: string, laneId: string, x: number, relativeY = 40, w = 120): CanvasNode => ({
  id, type: "task", kind: "task", label: id, laneId, x, relativeY, w, h: 60,
});

describe("placeNewNodeIn", () => {
  it("places to the right of a near node in the near node's lane", () => {
    const nodes = [node("A", "L1", 80)];
    const lanes = [lane("L1")];
    const pos = placeNewNodeIn(nodes, lanes, null, "A");
    expect(pos).not.toBeNull();
    expect(pos!.laneId).toBe("L1");
    expect(pos!.x).toBeGreaterThan(80);
  });

  it("appends after the rightmost node in an explicit lane when no near node", () => {
    const nodes = [node("A", "L1", 80), node("B", "L1", 300)];
    const lanes = [lane("L1")];
    const pos = placeNewNodeIn(nodes, lanes, "L1", null);
    expect(pos).toEqual({ laneId: "L1", x: 300 + 120 + 60, relativeY: 40 });
  });

  it("falls back to the first lane at x=80 when the lane is empty", () => {
    const pos = placeNewNodeIn([], [lane("L1")], "L1", null);
    expect(pos).toEqual({ laneId: "L1", x: 80, relativeY: 40 });
  });

  it("returns null when there is no lane to place into", () => {
    expect(placeNewNodeIn([], [], null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ai-edit`
Expected: FAIL — `placeNewNodeIn` is not exported.

- [ ] **Step 3: Implement `placeNewNodeIn` in `ai-edit.ts`**

Add (it can reuse the existing `placeProposedStep` already in this file):

```ts
import type { CanvasNode, CanvasLane } from "./types";

/** Pure placement: where a new node should land, given the current nodes/lanes
 * and an optional target lane + "near" node. Mirrors the canvas's placeNewNode
 * so a previewed add matches the committed result. Returns null if no lane. */
export function placeNewNodeIn(
  nodes: CanvasNode[],
  lanes: CanvasLane[],
  laneId: string | null,
  nearNodeId: string | null
): { laneId: string; x: number; relativeY: number } | null {
  const near = nearNodeId ? nodes.find((n) => n.id === nearNodeId) ?? null : null;
  const resolvedLane = laneId ?? near?.laneId ?? lanes[0]?.id ?? null;
  if (!resolvedLane) return null;
  if (near) {
    const pos = placeProposedStep({ x: near.x, relativeY: near.relativeY, w: near.w });
    return { laneId: resolvedLane, x: pos.x, relativeY: pos.relativeY };
  }
  const inLane = nodes.filter((n) => n.laneId === resolvedLane);
  const x = inLane.length ? Math.max(...inLane.map((n) => n.x + n.w)) + 60 : 80;
  return { laneId: resolvedLane, x, relativeY: 40 };
}
```

- [ ] **Step 4: Rewire the canvas to use it**

In `src/components/canvas/bpmn-canvas.tsx`, change the import on line 26 and replace the body of `placeNewNode` (533-549):

```ts
// line 26 area — add placeNewNodeIn to the ai-edit import:
import { placeProposedStep, placeNewNodeIn } from "./ai-edit";
```

```ts
const placeNewNode = useCallback(
  (laneId: UUID | null, nearNodeId: UUID | null) =>
    placeNewNodeIn(nodesRef.current, lanesRef.current, laneId, nearNodeId) as
      | { laneId: UUID; x: number; relativeY: number }
      | null,
  []
);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- ai-edit` → Expected: PASS.
Run: `npx tsc --noEmit` → Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/ai-edit.ts src/components/canvas/ai-edit.test.ts src/components/canvas/bpmn-canvas.tsx
git commit -m "refactor(canvas): extract pure placeNewNodeIn for shared placement"
```

---

## Task 2: Export `recomputeY` from `layout.ts`

The shadow reducer must recompute lane `y` after inserting a lane, exactly as the canvas does. `recomputeY` currently lives at `bpmn-canvas.tsx:214`. Move it to `layout.ts` so there is one copy.

**Files:**
- Modify: `src/components/canvas/layout.ts`
- Modify: `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Add `recomputeY` to `layout.ts`**

```ts
import type { CanvasLane } from "./types";

/** Recompute each lane's absolute `y` from the running sum of heights, in order.
 * Pure; used after any lane insert/remove/reorder. */
export function recomputeY(lanes: CanvasLane[]): CanvasLane[] {
  let y = 0;
  return lanes.map((l) => {
    const out = { ...l, y };
    y += l.h;
    return out;
  });
}
```

- [ ] **Step 2: Import it in the canvas and delete the local copy**

In `bpmn-canvas.tsx`: add `recomputeY` to the `./layout` import (line 24), and delete the local `function recomputeY` (lines 212-221).

```ts
import { LANE_HEIGHT, LANE_PALETTE, nodeKindFromType, recomputeY } from "./layout";
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors (the canvas's existing `recomputeY` calls now resolve to the import).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (no behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/layout.ts src/components/canvas/bpmn-canvas.tsx
git commit -m "refactor(canvas): move recomputeY into layout.ts for reuse"
```

---

## Task 3: `applyPlanToCanvas` — the in-memory shadow reducer

**Files:**
- Create: `src/components/canvas/suggestion-shadow.ts`
- Test: `src/components/canvas/suggestion-shadow.test.ts`

The reducer mirrors the **local-state** effects of the canvas executor `runStep` (bpmn-canvas.tsx:678-889) without API calls or inverses. Created objects get synthetic ids: a node/lane uses its step `tempId`; an edge uses its `tempId` if present, else `shadow:edge:<n>`. `resolve(ref) = tmp[ref] ?? ref` — identical to the real executor.

- [ ] **Step 1: Write the failing test**

Create `src/components/canvas/suggestion-shadow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyPlanToCanvas, type CanvasState } from "./suggestion-shadow";
import type { BundlePlan } from "./suggestion-apply";
import type { CanvasNode, CanvasEdge, CanvasLane } from "./types";

const lane = (id: string, y = 0, h = 150): CanvasLane => ({
  id, label: id, color: "#ccc", collapsed: false, y, h,
});
const node = (id: string, laneId: string, x = 80): CanvasNode => ({
  id, type: "task", kind: "task", label: id, laneId, x, relativeY: 40, w: 120, h: 60,
});
const edge = (id: string, from: string, to: string): CanvasEdge => ({
  id, from, to, label: null,
});
const base = (): CanvasState => ({
  nodes: [node("A", "L1", 80), node("B", "L1", 300)],
  edges: [edge("E1", "A", "B")],
  lanes: [lane("L1")],
});
const plan = (steps: BundlePlan["steps"]): BundlePlan => ({
  bundleId: "b", steps, undoable: true, applyable: true,
});

describe("applyPlanToCanvas", () => {
  it("is pure — does not mutate the input state", () => {
    const s = base();
    const snapshot = JSON.stringify(s);
    applyPlanToCanvas(s, plan([{ kind: "update_node", nodeRef: "A", name: "Renamed" }]));
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("relabels a node", () => {
    const out = applyPlanToCanvas(base(), plan([{ kind: "update_node", nodeRef: "A", name: "Submit" }]));
    expect(out.nodes.find((n) => n.id === "A")!.label).toBe("Submit");
  });

  it("moves a node to another lane", () => {
    const s = base();
    s.lanes.push(lane("L2", 150));
    const out = applyPlanToCanvas(s, plan([{ kind: "update_node", nodeRef: "A", laneRef: "L2" }]));
    expect(out.nodes.find((n) => n.id === "A")!.laneId).toBe("L2");
  });

  it("deletes a node and cascades its touching edges", () => {
    const out = applyPlanToCanvas(base(), plan([{ kind: "delete_node", nodeRef: "B" }]));
    expect(out.nodes.find((n) => n.id === "B")).toBeUndefined();
    expect(out.edges.find((e) => e.id === "E1")).toBeUndefined(); // E1 touched B
  });

  it("adds a node at the placed position with its tempId as id", () => {
    const out = applyPlanToCanvas(
      base(),
      plan([{ kind: "create_node", tempId: "tmp:1", laneRef: "L1", nodeType: "task", label: "New", nearNodeRef: "B" }])
    );
    const created = out.nodes.find((n) => n.id === "tmp:1");
    expect(created).toBeDefined();
    expect(created!.label).toBe("New");
    expect(created!.x).toBeGreaterThan(300); // right of B
  });

  it("adds an edge, resolving a tmp endpoint produced earlier in the plan", () => {
    const out = applyPlanToCanvas(
      base(),
      plan([
        { kind: "create_node", tempId: "tmp:1", laneRef: "L1", nodeType: "task", label: "New", nearNodeRef: "B" },
        { kind: "create_edge", fromRef: "B", toRef: "tmp:1", label: null },
      ])
    );
    expect(out.edges.some((e) => e.from === "B" && e.to === "tmp:1")).toBe(true);
  });

  it("relabels an edge, deletes an edge, reroutes an edge", () => {
    const relabel = applyPlanToCanvas(base(), plan([{ kind: "update_edge_label", edgeRef: "E1", label: "ok" }]));
    expect(relabel.edges.find((e) => e.id === "E1")!.label).toBe("ok");

    const del = applyPlanToCanvas(base(), plan([{ kind: "delete_edge", edgeRef: "E1" }]));
    expect(del.edges.find((e) => e.id === "E1")).toBeUndefined();

    const s = base();
    s.nodes.push(node("C", "L1", 520));
    const rer = applyPlanToCanvas(s, plan([{ kind: "reroute_edge", edgeRef: "E1", fromRef: "A", toRef: "C" }]));
    expect(rer.edges.find((e) => e.id === "E1")).toBeUndefined(); // old gone
    expect(rer.edges.some((e) => e.from === "A" && e.to === "C")).toBe(true); // new present
  });

  it("adds a lane (recomputed y) and renames a lane", () => {
    const add = applyPlanToCanvas(base(), plan([{ kind: "create_lane", tempId: "tmp:L", name: "Compliance" }]));
    const created = add.lanes.find((l) => l.id === "tmp:L");
    expect(created).toBeDefined();
    expect(created!.label).toBe("Compliance");
    expect(created!.y).toBe(150); // after the 150-tall L1

    const ren = applyPlanToCanvas(base(), plan([{ kind: "update_lane", laneRef: "L1", name: "Intake" }]));
    expect(ren.lanes.find((l) => l.id === "L1")!.label).toBe("Intake");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- suggestion-shadow`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `applyPlanToCanvas`**

Create `src/components/canvas/suggestion-shadow.ts`:

```ts
import type { CanvasNode, CanvasEdge, CanvasLane } from "./types";
import type { BundlePlan, MutationStep } from "./suggestion-apply";
import { placeNewNodeIn } from "./ai-edit";
import { sizeForNodeType } from "./node-type";
import { nodeKindFromType, LANE_PALETTE, LANE_HEIGHT, recomputeY } from "./layout";

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  lanes: CanvasLane[];
}

/** Apply a planned bundle to an in-memory copy of the canvas state, with NO API
 * calls. Mirrors the local-state effects of the canvas executor `runStep`, so
 * the preview matches a real Apply. Created objects use their step `tempId` as
 * the synthetic id (edges without one get `shadow:edge:<n>`), and refs resolve
 * through the same `tmp[ref] ?? ref` rule the executor uses. Pure. */
export function applyPlanToCanvas(state: CanvasState, plan: BundlePlan): CanvasState {
  // Deep-ish copy: new arrays + shallow-cloned members (we only ever replace
  // members immutably below, so a shallow clone per element is enough).
  let nodes: CanvasNode[] = state.nodes.map((n) => ({ ...n }));
  let edges: CanvasEdge[] = state.edges.map((e) => ({ ...e }));
  let lanes: CanvasLane[] = state.lanes.map((l) => ({ ...l }));

  const tmp: Record<string, string> = {};
  const resolve = (ref: string): string => tmp[ref] ?? ref;
  let synthEdge = 0;

  for (const step of plan.steps) {
    switch (step.kind) {
      case "update_node": {
        const id = resolve(step.nodeRef);
        nodes = nodes.map((n) => {
          if (n.id !== id) return n;
          const next = { ...n };
          if (step.name !== undefined) next.label = step.name;
          if (step.description !== undefined) next.description = step.description;
          if (step.laneRef !== undefined) next.laneId = resolve(step.laneRef);
          return next;
        });
        break;
      }
      case "delete_node": {
        const id = resolve(step.nodeRef);
        nodes = nodes.filter((n) => n.id !== id);
        edges = edges.filter((e) => e.from !== id && e.to !== id); // FK cascade
        break;
      }
      case "create_node": {
        const place = placeNewNodeIn(
          nodes,
          lanes,
          step.laneRef ? resolve(step.laneRef) : null,
          step.nearNodeRef ? resolve(step.nearNodeRef) : null
        );
        if (!place) break; // no lane to place into — drop (defensive)
        const size = sizeForNodeType(step.nodeType);
        nodes = [
          ...nodes,
          {
            id: step.tempId,
            type: step.nodeType,
            kind: nodeKindFromType(step.nodeType),
            label: step.label,
            laneId: place.laneId,
            x: place.x,
            relativeY: place.relativeY,
            w: size.w,
            h: size.h,
            aiProposed: true,
          },
        ];
        tmp[step.tempId] = step.tempId;
        break;
      }
      case "create_edge": {
        const id = step.tempId ?? `shadow:edge:${synthEdge++}`;
        if (step.tempId) tmp[step.tempId] = id;
        edges = [...edges, { id, from: resolve(step.fromRef), to: resolve(step.toRef), label: step.label }];
        break;
      }
      case "delete_edge": {
        edges = edges.filter((e) => e.id !== resolve(step.edgeRef));
        break;
      }
      case "update_edge_label": {
        const id = resolve(step.edgeRef);
        edges = edges.map((e) => (e.id === id ? { ...e, label: step.label } : e));
        break;
      }
      case "reroute_edge": {
        const id = resolve(step.edgeRef);
        const before = edges.find((e) => e.id === id);
        edges = edges.filter((e) => e.id !== id);
        edges = [
          ...edges,
          {
            id: `shadow:edge:${synthEdge++}`,
            from: step.fromRef ? resolve(step.fromRef) : before?.from ?? "",
            to: step.toRef ? resolve(step.toRef) : before?.to ?? "",
            label: before?.label ?? null,
          },
        ];
        break;
      }
      case "create_lane": {
        const slot = lanes.length;
        lanes = recomputeY([
          ...lanes,
          {
            id: step.tempId,
            label: step.name,
            color: LANE_PALETTE[slot % LANE_PALETTE.length],
            collapsed: false,
            y: 0,
            h: LANE_HEIGHT,
          },
        ]);
        tmp[step.tempId] = step.tempId;
        break;
      }
      case "update_lane": {
        const id = resolve(step.laneRef);
        lanes = lanes.map((l) => (l.id === id ? { ...l, label: step.name } : l));
        break;
      }
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
      }
    }
  }

  return { nodes, edges, lanes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- suggestion-shadow`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-shadow.ts src/components/canvas/suggestion-shadow.test.ts
git commit -m "feat(canvas): pure in-memory shadow reducer for suggestion preview"
```

---

## Task 4: `diffCanvas` — what changed between live and shadow

**Files:**
- Modify: `src/components/canvas/suggestion-shadow.ts`
- Modify: `src/components/canvas/suggestion-shadow.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `suggestion-shadow.test.ts`:

```ts
import { diffCanvas } from "./suggestion-shadow";

describe("diffCanvas", () => {
  it("classifies added / removed / changed across nodes, edges, lanes", () => {
    const before = base();
    const after = applyPlanToCanvas(before, plan([
      { kind: "update_node", nodeRef: "A", name: "Renamed" },          // changed node
      { kind: "delete_node", nodeRef: "B" },                            // removed node (+ cascade E1)
      { kind: "create_node", tempId: "tmp:1", laneRef: "L1", nodeType: "task", label: "New", nearNodeRef: "A" }, // added node
      { kind: "create_lane", tempId: "tmp:L", name: "QA" },             // added lane
      { kind: "update_lane", laneRef: "L1", name: "Intake" },           // changed lane
    ]));
    const d = diffCanvas(before, after);
    expect([...d.changedNodeIds]).toEqual(["A"]);
    expect([...d.removedNodeIds]).toEqual(["B"]);
    expect([...d.addedNodeIds]).toEqual(["tmp:1"]);
    expect([...d.removedEdgeIds]).toEqual(["E1"]); // cascade
    expect([...d.addedLaneIds]).toEqual(["tmp:L"]);
    expect([...d.changedLaneIds]).toEqual(["L1"]);
  });

  it("does not flag an unchanged node as changed", () => {
    const before = base();
    const after = applyPlanToCanvas(before, plan([{ kind: "update_node", nodeRef: "A", name: "Renamed" }]));
    expect(after.nodes.find((n) => n.id === "B")).toBeDefined();
    expect([...diffCanvas(before, after).changedNodeIds]).not.toContain("B");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- suggestion-shadow`
Expected: FAIL — `diffCanvas` not exported.

- [ ] **Step 3: Implement `diffCanvas`**

Append to `suggestion-shadow.ts`:

```ts
export interface CanvasDiff {
  addedNodeIds: Set<string>;
  addedEdgeIds: Set<string>;
  addedLaneIds: Set<string>;
  removedNodeIds: Set<string>;
  removedEdgeIds: Set<string>;
  changedNodeIds: Set<string>; // label / type / laneId / description changed
  changedEdgeIds: Set<string>; // label changed
  changedLaneIds: Set<string>; // name changed
}

/** Compare the live state (before) with the shadow (after) and classify each
 * object as added / removed / changed. Drives the preview's ghost styling. */
export function diffCanvas(before: CanvasState, after: CanvasState): CanvasDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  const beforeLanes = new Map(before.lanes.map((l) => [l.id, l]));
  const afterLanes = new Map(after.lanes.map((l) => [l.id, l]));

  const addedNodeIds = new Set<string>();
  const removedNodeIds = new Set<string>();
  const changedNodeIds = new Set<string>();
  for (const id of afterNodes.keys()) if (!beforeNodes.has(id)) addedNodeIds.add(id);
  for (const id of beforeNodes.keys()) if (!afterNodes.has(id)) removedNodeIds.add(id);
  for (const [id, a] of afterNodes) {
    const b = beforeNodes.get(id);
    if (!b) continue;
    if (a.label !== b.label || a.type !== b.type || a.laneId !== b.laneId || a.description !== b.description) {
      changedNodeIds.add(id);
    }
  }

  const addedEdgeIds = new Set<string>();
  const removedEdgeIds = new Set<string>();
  const changedEdgeIds = new Set<string>();
  for (const id of afterEdges.keys()) if (!beforeEdges.has(id)) addedEdgeIds.add(id);
  for (const id of beforeEdges.keys()) if (!afterEdges.has(id)) removedEdgeIds.add(id);
  for (const [id, a] of afterEdges) {
    const b = beforeEdges.get(id);
    if (b && a.label !== b.label) changedEdgeIds.add(id);
  }

  const addedLaneIds = new Set<string>();
  const changedLaneIds = new Set<string>();
  for (const id of afterLanes.keys()) if (!beforeLanes.has(id)) addedLaneIds.add(id);
  for (const [id, a] of afterLanes) {
    const b = beforeLanes.get(id);
    if (b && a.label !== b.label) changedLaneIds.add(id);
  }

  return {
    addedNodeIds, addedEdgeIds, addedLaneIds,
    removedNodeIds, removedEdgeIds,
    changedNodeIds, changedEdgeIds, changedLaneIds,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- suggestion-shadow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-shadow.ts src/components/canvas/suggestion-shadow.test.ts
git commit -m "feat(canvas): diffCanvas classifies preview deltas"
```

---

## Task 5: Canvas preview state + `previewPlan` / `clearPreview` handle

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Add imports + the handle type**

Add to the `./suggestion-shadow` import and extend `BpmnCanvasHandle` (after line 179):

```ts
import { applyPlanToCanvas, diffCanvas, type CanvasState, type CanvasDiff } from "./suggestion-shadow";
```

```ts
  /** Compute a non-committal preview of a plan and render it as ghosts. Returns
   * the diff so the caller (card) can summarize it. Does NOT persist anything. */
  previewPlan: (plan: BundlePlan) => CanvasDiff;
  /** Exit preview mode and drop the shadow, restoring the live render. */
  clearPreview: () => void;
```

- [ ] **Step 2: Add preview state + the two callbacks**

Near the other `useState` declarations (around line 249) add:

```ts
const [preview, setPreview] = useState<{ shadow: CanvasState; diff: CanvasDiff } | null>(null);
const previewRef = useRef<typeof preview>(null);
previewRef.current = preview;
```

Define the callbacks (place them just before `useImperativeHandle`, ~line 1900):

```ts
const previewPlan = useCallback((plan: BundlePlan): CanvasDiff => {
  const live: CanvasState = { nodes: nodesRef.current, edges: edgesRef.current, lanes: lanesRef.current };
  const shadow = applyPlanToCanvas(live, plan);
  const diff = diffCanvas(live, shadow);
  setPreview({ shadow, diff });
  return diff;
}, []);

const clearPreview = useCallback(() => setPreview(null), []);
```

- [ ] **Step 3: Expose them on the handle**

Add `previewPlan` and `clearPreview` to the `useImperativeHandle` object (line 1906-1926) and to its dependency array (line 1927-1940).

- [ ] **Step 4: Suspend edit gestures while previewing**

Preview is read-only — a stray drag/connect would diverge from the plan. Guard the gesture entry points with `if (previewRef.current) return;` at the top of: the SVG pointer-down handler that begins node drag / edge connect (search the `onPointerDown` / drag-start near line 1560-1600), the palette drop handler (`onDrop`, ~line 1730), and the lane-add handler (~line 2260). Each is a one-line early return.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (Render still uses live arrays — styling comes in Task 6 — so the canvas compiles and behaves unchanged until a preview is set.)

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(canvas): preview state + previewPlan/clearPreview handle methods"
```

---

## Task 6: Render the live+shadow merge with ghost styling

This task changes what the canvas draws while `preview` is set. **It is verified manually in the running app** (consistent with how existing canvas rendering is covered — there is no DOM test harness for the SVG canvas).

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx`

**Rendering rule (the merge):** while previewing, the canvas must show added objects (ghost), changed objects (new value + ring, old value struck), AND removed objects (struck) — so a simple swap to the shadow is not enough (removed objects vanish from the shadow). Render the **union**: every shadow object, plus every live object whose id is in the diff's `removed*` sets.

- [ ] **Step 1: Derive preview-aware source arrays**

Just above the `renderNodes` memo (line 1221) add source selectors:

```ts
// While previewing, draw the union of the shadow (adds + changes + survivors)
// and the live objects that the plan removes (so deletions show struck-through).
const srcNodes = useMemo<CanvasNode[]>(() => {
  if (!preview) return nodes;
  const removed = nodes.filter((n) => preview.diff.removedNodeIds.has(n.id));
  return [...preview.shadow.nodes, ...removed];
}, [preview, nodes]);

const srcEdges = useMemo<CanvasEdge[]>(() => {
  if (!preview) return edges;
  const removed = edges.filter((e) => preview.diff.removedEdgeIds.has(e.id));
  return [...preview.shadow.edges, ...removed];
}, [preview, edges]);

const srcLanes = useMemo<CanvasLane[]>(() => (preview ? preview.shadow.lanes : lanes), [preview, lanes]);
```

Then point the existing derivations at these: the `displayLanes` computation uses `srcLanes` instead of `lanes`; the `renderNodes` memo (1221-1232) maps over `srcNodes` instead of `nodes` (and depends on `srcNodes`); the edge-rendering pass (~2513) iterates `srcEdges`. Keep the live `nodes`/`edges`/`lanes` arrays for all mutation logic — only the **render** derivations switch sources.

- [ ] **Step 2: Add a diff-driven style helper**

Add near the render section:

```ts
type PreviewRole = "added" | "changed" | "removed" | null;
const nodePreviewRole = useCallback((id: string): PreviewRole => {
  const d = preview?.diff;
  if (!d) return null;
  if (d.addedNodeIds.has(id)) return "added";
  if (d.removedNodeIds.has(id)) return "removed";
  if (d.changedNodeIds.has(id)) return "changed";
  return null;
}, [preview]);
```

(Analogous `edgePreviewRole` for `added`/`removed`/`changed` edge ids.)

- [ ] **Step 3: Apply styling in the node render**

In the `renderNodes.map(...)` block (~2444), compute `const role = nodePreviewRole(node.id);` and apply, on the node's `<rect>`/group:
- `added` → `stroke="#7c3aed"`, `strokeDasharray="5 4"`, fill tinted `#faf5ff`.
- `changed` → keep normal fill, add an outer violet ring (`stroke="#7c3aed" strokeWidth={2}`) and render the **old** label struck above the new: look up the live node via `nodes.find((n) => n.id === node.id)` and, if its `label` differs, draw a small `<text>` with `textDecoration="line-through"` and the old text above the node title.
- `removed` → `opacity={0.5}`, red stroke `#fca5a5`, and a strike line across the node title.
- `null` → unchanged styling.

- [ ] **Step 4: Apply styling in the edge render**

In the edge pass (~2513), by `edgePreviewRole(edge.id)`:
- `added` → dashed violet stroke.
- `removed` → faded + red, with the path `strokeDasharray` for a struck look.
- `changed` → normal path; (label change already shows via the new label text).

- [ ] **Step 5: Apply styling in the lane render + the preview banner**

In the lane render (~2393), tint the label of any lane in `diff.addedLaneIds` violet. Add a fixed banner (HTML overlay above the SVG, or an SVG `<text>` pinned to the viewport top-left) shown only when `preview` is set: `⚡ Preview · N changes · not yet saved`, where `N = added+changed+removed counts across nodes/edges/lanes`. Use the rose variant (`⚠ Preview removal · impact shown`) when the diff has any `removedNodeIds`/`removedEdgeIds` — this is forward-compatible with Phase 2.

- [ ] **Step 6: Manual verification in the app**

Follow `/run-poet-local`. Send a suggest-mode message that yields a mixed bundle (e.g. "Rename Submit to Submit request, add an Approval step after it, move Review to a new Compliance lane"). On the card, click **Preview** (wired in Task 7). Confirm: the relabel shows old→new with a ring; the new node + edge render as dashed violet ghosts; the moved node appears in the new lane; the banner shows the count; nothing is saved (reload → changes gone); edit gestures are inert while previewing.

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(canvas): render live+shadow merge with ghost styling in preview mode"
```

---

## Task 7: Card — Preview button + previewing state

**Files:**
- Modify: `src/components/canvas/suggestion-card.tsx`

Add a `previewing` card status and an `onPreview`/`onCancelPreview` pair. The card flow becomes: **pending** → click *Preview* → **previewing** (shows *Apply* / *Cancel*) → *Apply* applies, *Cancel* returns to pending. Direct **Apply** from pending stays available for non-delete bundles (delete bundles route through preview in Phase 2).

- [ ] **Step 1: Extend the status union + props**

```ts
export type CardStatus = "pending" | "previewing" | "applying" | "applied" | "failed" | "dismissed";
```

Add to both `SuggestionList`'s and `SuggestionCard`'s props:

```ts
  onPreview: (bundle: Bundle) => void;
  onCancelPreview: (bundleId: string) => void;
```

Thread `onPreview`/`onCancelPreview` through `SuggestionList` into each `SuggestionCard` (mirroring the existing `onApply` wiring at lines 85-89).

- [ ] **Step 2: Render the previewing controls**

In `SuggestionCard`, add a branch before the final pending branch (line 254):

```tsx
) : status === "previewing" ? (
  <div className="mt-2 flex items-center gap-1.5">
    <span className="mr-auto flex items-center gap-1 text-[10px] font-semibold text-violet-700">
      <span className="h-1.5 w-1.5 rounded-full bg-violet-500" /> Previewing on canvas
    </span>
    <button
      type="button"
      onClick={runApply}
      className="rounded bg-slate-800 px-2 py-1 text-[10px] font-semibold text-white hover:bg-slate-700"
    >
      Apply
    </button>
    <button
      type="button"
      onClick={() => onCancelPreview(bundle.id)}
      className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100"
    >
      Cancel
    </button>
  </div>
```

- [ ] **Step 3: Add the Preview button to the pending controls**

In the pending branch (line 255-265), add a **Preview** button before **Apply** (skip it for delete bundles — they get the impact preview in Phase 2):

```tsx
{!isDelete && (
  <button
    type="button"
    onClick={() => onPreview(bundle)}
    className="rounded border border-violet-300 bg-white px-2 py-1 text-[10px] font-semibold text-violet-700 hover:bg-violet-50"
  >
    Preview
  </button>
)}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors only at the `chat-tab.tsx` call sites (fixed in Task 8) for the new required props.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-card.tsx
git commit -m "feat(suggest): Preview button + previewing card state"
```

---

## Task 8: Wire preview through chat-tab → right-panel → page

**Files:**
- Modify: `src/components/canvas/chat-tab.tsx`
- Modify: `src/components/canvas/right-panel.tsx`
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`

- [ ] **Step 1: Page — add preview delegates**

After `handleApplySuggestions` (page.tsx:191-201) add:

```tsx
const handlePreviewSuggestions = useCallback(
  (plan: BundlePlan) => canvasRef.current?.previewPlan(plan) ?? null,
  []
);
const handleCancelPreview = useCallback(() => canvasRef.current?.clearPreview(), []);
```

Pass both to `<RightPanel … onPreviewSuggestions={handlePreviewSuggestions} onCancelPreview={handleCancelPreview} />`.

- [ ] **Step 2: right-panel — thread the props to ChatTab**

Add `onPreviewSuggestions` and `onCancelPreview` to `RightPanel`'s props and forward them into `<ChatTab … />` (alongside the existing `onApplySuggestions`).

```ts
onPreviewSuggestions: (plan: BundlePlan) => CanvasDiff | null;
onCancelPreview: () => void;
```

(`CanvasDiff` import comes from `./suggestion-shadow`.)

- [ ] **Step 3: chat-tab — track the previewing bundle + handlers**

Add the props (chat-tab.tsx, near line 70):

```ts
  onPreviewSuggestions: (plan: BundlePlan) => CanvasDiff | null;
  onCancelPreview: () => void;
```

Add state for which bundle is previewing (only one at a time, canvas-wide):

```ts
const [previewingId, setPreviewingId] = useState<{ msgIndex: number; bundleId: string } | null>(null);
```

Add handlers:

```ts
const previewBundle = (msgIndex: number, bundle: Bundle) => {
  const plan = planBundle(bundle, graphIndex);
  if (!plan.applyable) {
    toast.error(plan.reason ?? "This change can no longer be previewed.");
    return;
  }
  onPreviewSuggestions(plan);
  setPreviewingId({ msgIndex, bundleId: bundle.id });
  setBundleStatus(msgIndex, bundle.id, "previewing");
};

const cancelPreview = (msgIndex: number, bundleId: string) => {
  onCancelPreview();
  setPreviewingId(null);
  setBundleStatus(msgIndex, bundleId, "pending");
};
```

In `applyBundle` (line 275), clear the preview when an apply starts so the committed result replaces the ghosts:

```ts
const applyBundle = async (msgIndex: number, bundle: Bundle) => {
  if (previewingId) { onCancelPreview(); setPreviewingId(null); }
  setBundleStatus(msgIndex, bundle.id, "applying");
  const plan = planBundle(bundle, graphIndex);
  const res = await onApplySuggestions(plan);
  // …unchanged…
};
```

- [ ] **Step 4: chat-tab — pass the new callbacks into SuggestionList**

At the `<SuggestionList … />` call (line 385-389), add:

```tsx
onPreview={(b) => previewBundle(i, b)}
onCancelPreview={(bundleId) => cancelPreview(i, bundleId)}
```

The per-message `statusById` already carries `"previewing"` (it is in the `CardStatus` union), so the card renders the previewing controls automatically.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit` → Expected: no errors.
Run: `npm test` → Expected: PASS (pure-module suites green; no canvas DOM tests).

- [ ] **Step 6: Manual end-to-end verification**

Follow `/run-poet-local`. In a suggest-mode thread: click **Preview** on a card → ghosts render + banner shows + card shows *Previewing… / Apply / Cancel*. Click **Cancel** → ghosts vanish, card back to pending. Preview again → **Apply** → ghosts replaced by the committed change, card flips to **Applied ✓**, graph query invalidates. Confirm previewing one bundle then previewing another replaces the first preview (only one preview at a time).

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas/chat-tab.tsx src/components/canvas/right-panel.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(suggest): wire Preview/Cancel from card through to canvas previewPlan"
```

---

## Self-review notes (already reconciled)

- **Spec coverage:** §1 shadow engine → Tasks 3-4; §2 placement extraction → Task 1; §3 canvas preview mode + ghost styling → Tasks 5-6; §5 Preview button + Apply/Cancel + page plumbing → Tasks 7-8. Deletion-impact (§4), the IMPACT block + bridge, and all provenance/backend work (§6) are **Phase 2** — intentionally absent here.
- **Type consistency:** `CanvasState`/`CanvasDiff` defined in Task 3-4 are imported unchanged in Tasks 5 and 8; `previewPlan` returns `CanvasDiff` everywhere; `CardStatus` gains `"previewing"` in Task 7 and chat-tab sets exactly that string in Task 8.
- **Placement parity:** Task 1's `placeNewNodeIn` is the single placement source for both the real executor (`placeNewNode`) and the shadow (`applyPlanToCanvas`), so a previewed add lands where Apply puts it.
- **No silent divergence:** the shadow reducer mirrors `runStep`'s local effects op-for-op; if a future op kind is added to `MutationStep`, the `default: never` arm in `applyPlanToCanvas` fails the typecheck.
