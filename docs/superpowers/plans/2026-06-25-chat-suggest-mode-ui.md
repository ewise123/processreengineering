# Suggest-Mode UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing chat-suggest backend into an applyable, Word-style "suggested changes" experience: a mode toggle, suggestion cards in the chat thread, and an Apply layer that mutates the canvas with undo support.

**Architecture:** Approach C — a pure, unit-tested planner (`suggestion-apply.ts`) turns a batch of suggestions into an ordered, tmp_id-resolved mutation plan; the canvas gains one executor method (`applySuggestionBatch`) that runs the plan against existing mutation primitives and records a grouped undo entry; a presentational `suggestion-card.tsx` renders the cards. `ChatTab`/`ChatMsg` are extracted from the oversized `right-panel.tsx` into `chat-tab.tsx`.

**Tech Stack:** Next.js (App Router), React 19, TypeScript, TanStack Query, Vitest, Tailwind. No backend changes.

**Spec:** `docs/superpowers/specs/2026-06-25-chat-suggest-mode-ui-design.md`

---

## File structure

- **New** `src/components/canvas/suggestion-apply.ts` — pure planner: `indexGraph`, `bundleSuggestions`, `planBundle`, plus exported types (`Bundle`, `BundlePlan`, `MutationStep`, `GraphIndex`, `BatchResult`).
- **New** `src/components/canvas/suggestion-apply.test.ts` — planner unit tests.
- **New** `src/components/canvas/suggestion-card.tsx` — `SuggestionList` + `SuggestionCard` (presentational).
- **New** `src/components/canvas/chat-tab.tsx` — `ChatTab` + `ChatMsg`, extracted from `right-panel.tsx`, now owning the mode toggle + suggestion threading.
- **Modify** `src/components/canvas/bpmn-canvas.tsx` — add `applySuggestionBatch` to `BpmnCanvasHandle` + implementation + placement helper, wire into `useImperativeHandle`.
- **Modify** `src/components/canvas/right-panel.tsx` — remove inlined `ChatTab`/`ChatMsg`, import from `chat-tab.tsx`, thread the new `onApplySuggestions` prop.
- **Modify** `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — implement `onApplySuggestions` delegating to `canvasRef.applySuggestionBatch`.

---

## Task 1: Planner types + op→steps mapping

**Files:**
- Create: `src/components/canvas/suggestion-apply.ts`
- Test: `src/components/canvas/suggestion-apply.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/canvas/suggestion-apply.test.ts
import { describe, it, expect } from "vitest";
import { opToSteps, isDeleteOp } from "./suggestion-apply";
import type { SuggestionOp } from "@/lib/types";

const op = (o: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }): SuggestionOp => ({
  kind: o.kind,
  node_ref: o.node_ref ?? null,
  edge_ref: o.edge_ref ?? null,
  lane_ref: o.lane_ref ?? null,
  temp_id: o.temp_id ?? null,
  from_ref: o.from_ref ?? null,
  to_ref: o.to_ref ?? null,
  new_label: o.new_label ?? null,
  description: o.description ?? null,
  name: o.name ?? null,
  node_type: o.node_type ?? null,
  near_node_ref: o.near_node_ref ?? null,
  edge_label: o.edge_label ?? null,
  sub_steps: o.sub_steps ?? null,
});

describe("isDeleteOp", () => {
  it("flags remove_node, remove_edge, reroute_edge as delete-containing", () => {
    expect(isDeleteOp("remove_node")).toBe(true);
    expect(isDeleteOp("remove_edge")).toBe(true);
    expect(isDeleteOp("reroute_edge")).toBe(true);
  });
  it("treats edits/creates as non-delete", () => {
    expect(isDeleteOp("relabel_node")).toBe(false);
    expect(isDeleteOp("add_edge")).toBe(false);
    expect(isDeleteOp("decompose")).toBe(false);
  });
});

describe("opToSteps", () => {
  it("maps relabel_node to an update_node name step", () => {
    expect(opToSteps(op({ kind: "relabel_node", node_ref: "N1", new_label: "Review" }))).toEqual([
      { kind: "update_node", nodeRef: "N1", name: "Review" },
    ]);
  });
  it("maps move_to_lane to update_node laneRef", () => {
    expect(opToSteps(op({ kind: "move_to_lane", node_ref: "N1", lane_ref: "L2" }))).toEqual([
      { kind: "update_node", nodeRef: "N1", laneRef: "L2" },
    ]);
  });
  it("maps add_node to create_node carrying its temp_id", () => {
    expect(
      opToSteps(op({ kind: "add_node", temp_id: "t1", lane_ref: "L1", node_type: "task", new_label: "Approve", near_node_ref: "N3" }))
    ).toEqual([
      { kind: "create_node", tempId: "t1", laneRef: "L1", nodeType: "task", label: "Approve", nearNodeRef: "N3" },
    ]);
  });
  it("maps add_edge to create_edge with optional label", () => {
    expect(opToSteps(op({ kind: "add_edge", from_ref: "N1", to_ref: "t1", edge_label: "yes" }))).toEqual([
      { kind: "create_edge", fromRef: "N1", toRef: "t1", label: "yes" },
    ]);
  });
  it("maps reroute_edge to a single reroute_edge step", () => {
    expect(opToSteps(op({ kind: "reroute_edge", edge_ref: "E1", to_ref: "N9" }))).toEqual([
      { kind: "reroute_edge", edgeRef: "E1", fromRef: null, toRef: "N9" },
    ]);
  });
  it("expands decompose into chained create_node + create_edge steps", () => {
    const steps = opToSteps(
      op({
        kind: "decompose",
        node_ref: "N1",
        sub_steps: [
          { proposed_name: "A", proposed_type: "task", role: null, edge_label: "start" },
          { proposed_name: "B", proposed_type: "task", role: null, edge_label: null },
        ],
      })
    );
    expect(steps).toEqual([
      { kind: "create_node", tempId: "N1::sub0", laneRef: null, nodeType: "task", label: "A", nearNodeRef: "N1", role: null },
      { kind: "create_edge", fromRef: "N1", toRef: "N1::sub0", label: "start" },
      { kind: "create_node", tempId: "N1::sub1", laneRef: null, nodeType: "task", label: "B", nearNodeRef: "N1::sub0", role: null },
      { kind: "create_edge", fromRef: "N1::sub0", toRef: "N1::sub1", label: null },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: FAIL — `Cannot find module './suggestion-apply'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/canvas/suggestion-apply.ts
import type { ChatSuggestion, OpKind, SuggestionOp, UUID } from "@/lib/types";
import type { ProcessGraph } from "@/lib/types";

/** Op kinds that delete or re-point objects. A bundle containing any of these
 * is non-undoable and requires a confirm before applying. */
const DELETE_OPS = new Set<OpKind>(["remove_node", "remove_edge", "reroute_edge"]);

export function isDeleteOp(kind: OpKind): boolean {
  return DELETE_OPS.has(kind);
}

/** A single executable mutation. Ref fields hold either a real UUID or a
 * tmp placeholder (a producing step's `tempId`); the executor resolves them. */
export type MutationStep =
  | { kind: "update_node"; nodeRef: string; name?: string; description?: string; laneRef?: string }
  | { kind: "delete_node"; nodeRef: string }
  | { kind: "create_node"; tempId: string; laneRef: string | null; nodeType: string; label: string; nearNodeRef: string | null; role?: string | null }
  | { kind: "create_edge"; tempId?: string; fromRef: string; toRef: string; label: string | null }
  | { kind: "delete_edge"; edgeRef: string }
  | { kind: "update_edge_label"; edgeRef: string; label: string }
  | { kind: "reroute_edge"; edgeRef: string; fromRef: string | null; toRef: string | null }
  | { kind: "create_lane"; tempId: string; name: string }
  | { kind: "update_lane"; laneRef: string; name: string };

/** Translate one op into its ordered mutation steps. Pure; no ref resolution. */
export function opToSteps(op: SuggestionOp): MutationStep[] {
  switch (op.kind) {
    case "relabel_node":
      return [{ kind: "update_node", nodeRef: op.node_ref!, name: op.new_label! }];
    case "describe_node":
      return [{ kind: "update_node", nodeRef: op.node_ref!, description: op.description! }];
    case "move_to_lane":
      return [{ kind: "update_node", nodeRef: op.node_ref!, laneRef: op.lane_ref! }];
    case "remove_node":
      return [{ kind: "delete_node", nodeRef: op.node_ref! }];
    case "add_edge":
      return [{ kind: "create_edge", fromRef: op.from_ref!, toRef: op.to_ref!, label: op.edge_label ?? null }];
    case "remove_edge":
      return [{ kind: "delete_edge", edgeRef: op.edge_ref! }];
    case "relabel_edge":
      return [{ kind: "update_edge_label", edgeRef: op.edge_ref!, label: op.new_label! }];
    case "reroute_edge":
      return [{ kind: "reroute_edge", edgeRef: op.edge_ref!, fromRef: op.from_ref ?? null, toRef: op.to_ref ?? null }];
    case "add_node":
      return [
        {
          kind: "create_node",
          tempId: op.temp_id!,
          laneRef: op.lane_ref ?? null,
          nodeType: op.node_type!,
          label: op.new_label!,
          nearNodeRef: op.near_node_ref ?? null,
        },
      ];
    case "add_lane":
      return [{ kind: "create_lane", tempId: op.temp_id!, name: op.name! }];
    case "rename_lane":
      return [{ kind: "update_lane", laneRef: op.lane_ref!, name: op.name! }];
    case "decompose": {
      const steps: MutationStep[] = [];
      const subs = op.sub_steps ?? [];
      let prevRef = op.node_ref!;
      subs.forEach((s, i) => {
        const tempId = `${op.node_ref}::sub${i}`;
        steps.push({
          kind: "create_node",
          tempId,
          laneRef: null,
          nodeType: s.proposed_type || "task",
          label: s.proposed_name,
          nearNodeRef: prevRef,
          role: s.role ?? null,
        });
        steps.push({ kind: "create_edge", fromRef: prevRef, toRef: tempId, label: s.edge_label ?? null });
        prevRef = tempId;
      });
      return steps;
    }
    default:
      return [];
  }
}

// Placeholder exports completed in later tasks:
export interface GraphIndex {
  nodeIds: Set<UUID>;
  edgeIds: Set<UUID>;
  laneIds: Set<UUID>;
  laneNameToId: Map<string, UUID>;
}
export interface Bundle {
  id: string;
  suggestions: ChatSuggestion[];
  undoable: boolean;
}
export interface BundlePlan {
  bundleId: string;
  steps: MutationStep[];
  undoable: boolean;
  applyable: boolean;
  reason?: string;
}
export interface BatchResult {
  ok: boolean;
  error?: string;
  undo?: () => Promise<void>;
}
// indexGraph / bundleSuggestions / planBundle implemented in Tasks 2 & 3.
export function indexGraph(_graph: ProcessGraph): GraphIndex {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-apply.ts src/components/canvas/suggestion-apply.test.ts
git commit -m "feat(suggest): op->mutation-step mapping + delete-op classifier"
```

---

## Task 2: Bundling (group + tmp_id union-find) and graph index

**Files:**
- Modify: `src/components/canvas/suggestion-apply.ts`
- Test: `src/components/canvas/suggestion-apply.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing test file)**

```ts
import { bundleSuggestions, indexGraph } from "./suggestion-apply";
import type { ChatSuggestion, ProcessGraph } from "@/lib/types";

const sg = (id: string, opOverrides: Partial<SuggestionOp> & { kind: SuggestionOp["kind"] }, group?: string): ChatSuggestion => ({
  id,
  group: group ?? null,
  title: id,
  op: op(opOverrides),
  affected_refs: [],
  rationale: "",
  cited_claim_ids: [],
});

describe("bundleSuggestions", () => {
  it("keeps independent suggestions as singleton bundles", () => {
    const a = sg("a", { kind: "relabel_node", node_ref: "N1", new_label: "X" });
    const b = sg("b", { kind: "relabel_node", node_ref: "N2", new_label: "Y" });
    const bundles = bundleSuggestions([a, b]);
    expect(bundles.map((x) => x.suggestions.map((s) => s.id))).toEqual([["a"], ["b"]]);
  });
  it("bundles suggestions that share a non-null group", () => {
    const a = sg("a", { kind: "relabel_node", node_ref: "N1", new_label: "X" }, "g1");
    const b = sg("b", { kind: "relabel_node", node_ref: "N2", new_label: "Y" }, "g1");
    const bundles = bundleSuggestions([a, b]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].suggestions.map((s) => s.id)).toEqual(["a", "b"]);
  });
  it("bundles a tmp_id producer with its consumer", () => {
    const a = sg("a", { kind: "add_node", temp_id: "t1", lane_ref: "L1", node_type: "task", new_label: "New" });
    const b = sg("b", { kind: "add_edge", from_ref: "N1", to_ref: "t1" });
    const bundles = bundleSuggestions([a, b]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].suggestions.map((s) => s.id)).toEqual(["a", "b"]);
  });
  it("marks a bundle non-undoable if any member is a delete op", () => {
    const a = sg("a", { kind: "remove_node", node_ref: "N1" }, "g1");
    const b = sg("b", { kind: "relabel_node", node_ref: "N2", new_label: "Y" }, "g1");
    const bundles = bundleSuggestions([a, b]);
    expect(bundles[0].undoable).toBe(false);
  });
});

describe("indexGraph", () => {
  it("indexes node/edge/lane ids and lane names", () => {
    const graph = {
      nodes: [{ id: "n1" }, { id: "n2" }],
      edges: [{ id: "e1" }],
      lanes: [{ id: "l1", name: "Ops" }],
    } as unknown as ProcessGraph;
    const idx = indexGraph(graph);
    expect(idx.nodeIds.has("n1")).toBe(true);
    expect(idx.edgeIds.has("e1")).toBe(true);
    expect(idx.laneNameToId.get("Ops")).toBe("l1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: FAIL — `bundleSuggestions is not a function` / `indexGraph` throws "not implemented".

- [ ] **Step 3: Implement (replace the `indexGraph` stub and add `bundleSuggestions`)**

```ts
// Replace the throwing indexGraph stub with:
export function indexGraph(graph: ProcessGraph): GraphIndex {
  const laneNameToId = new Map<string, UUID>();
  for (const l of graph.lanes) laneNameToId.set(l.name, l.id);
  return {
    nodeIds: new Set(graph.nodes.map((n) => n.id)),
    edgeIds: new Set(graph.edges.map((e) => e.id)),
    laneIds: new Set(graph.lanes.map((l) => l.id)),
    laneNameToId,
  };
}

/** Every ref string a suggestion's op reads (consuming refs only — not temp_id). */
function consumedRefs(op: SuggestionOp): string[] {
  const refs: string[] = [];
  for (const v of [op.node_ref, op.edge_ref, op.lane_ref, op.from_ref, op.to_ref, op.near_node_ref]) {
    if (v) refs.push(v);
  }
  return refs;
}

/** Union-find: group suggestions joined by a shared `group` or a tmp_id dep. */
export function bundleSuggestions(suggestions: ChatSuggestion[]): Bundle[] {
  const parent = suggestions.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 1) shared non-null group
  const byGroup = new Map<string, number>();
  suggestions.forEach((s, i) => {
    if (!s.group) return;
    if (byGroup.has(s.group)) union(byGroup.get(s.group)!, i);
    else byGroup.set(s.group, i);
  });

  // 2) tmp_id producer -> consumer
  const producerOf = new Map<string, number>();
  suggestions.forEach((s, i) => {
    if (s.op.temp_id) producerOf.set(s.op.temp_id, i);
  });
  suggestions.forEach((s, i) => {
    for (const ref of consumedRefs(s.op)) {
      const producer = producerOf.get(ref);
      if (producer !== undefined) union(producer, i);
    }
  });

  // Collect members per root, preserving document order.
  const groups = new Map<number, ChatSuggestion[]>();
  suggestions.forEach((s, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(s);
  });

  // Emit bundles in the document order of their first member.
  const roots = [...groups.keys()].sort((a, b) => a - b);
  return roots.map((root) => {
    const members = groups.get(root)!;
    return {
      id: members.map((m) => m.id).join("+"),
      suggestions: members,
      undoable: members.every((m) => !isDeleteOp(m.op.kind)),
    };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-apply.ts src/components/canvas/suggestion-apply.test.ts
git commit -m "feat(suggest): bundle suggestions by group + tmp_id; graph index"
```

---

## Task 3: planBundle — ordering, tmp validation, stale-ref detection

**Files:**
- Modify: `src/components/canvas/suggestion-apply.ts`
- Test: `src/components/canvas/suggestion-apply.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { planBundle } from "./suggestion-apply";

const idx = (over?: Partial<GraphIndex>): GraphIndex => ({
  nodeIds: new Set(["N1", "N2"]),
  edgeIds: new Set(["E1"]),
  laneIds: new Set(["L1"]),
  laneNameToId: new Map(),
  ...over,
});

describe("planBundle", () => {
  it("produces ordered steps for a tmp-linked bundle and stays applyable", () => {
    const bundle = bundleSuggestions([
      sg("a", { kind: "add_node", temp_id: "t1", lane_ref: "L1", node_type: "task", new_label: "New" }),
      sg("b", { kind: "add_edge", from_ref: "N1", to_ref: "t1" }),
    ])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(true);
    expect(plan.undoable).toBe(true);
    expect(plan.steps.map((s) => s.kind)).toEqual(["create_node", "create_edge"]);
  });
  it("marks a bundle unapplyable when a real ref no longer exists", () => {
    const bundle = bundleSuggestions([sg("a", { kind: "relabel_node", node_ref: "GONE", new_label: "X" })])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(false);
    expect(plan.reason).toMatch(/no longer/i);
  });
  it("marks a bundle unapplyable when a consumed tmp is never produced", () => {
    const bundle = bundleSuggestions([sg("a", { kind: "add_edge", from_ref: "N1", to_ref: "ghost" })])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(false);
  });
  it("classifies a delete bundle as non-undoable but applyable", () => {
    const bundle = bundleSuggestions([sg("a", { kind: "remove_edge", edge_ref: "E1" })])[0];
    const plan = planBundle(bundle, idx());
    expect(plan.applyable).toBe(true);
    expect(plan.undoable).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: FAIL — `planBundle is not a function`.

- [ ] **Step 3: Implement (append to `suggestion-apply.ts`)**

```ts
/** Which id-set a given step field must exist in (for stale-ref checks). */
function stepRealRefs(step: MutationStep): { ref: string; set: "node" | "edge" | "lane" }[] {
  switch (step.kind) {
    case "update_node":
      return [
        { ref: step.nodeRef, set: "node" },
        ...(step.laneRef ? [{ ref: step.laneRef, set: "lane" as const }] : []),
      ];
    case "delete_node":
      return [{ ref: step.nodeRef, set: "node" }];
    case "create_node":
      return [
        ...(step.laneRef ? [{ ref: step.laneRef, set: "lane" as const }] : []),
        ...(step.nearNodeRef ? [{ ref: step.nearNodeRef, set: "node" as const }] : []),
      ];
    case "create_edge":
      return [
        { ref: step.fromRef, set: "node" },
        { ref: step.toRef, set: "node" },
      ];
    case "delete_edge":
      return [{ ref: step.edgeRef, set: "edge" }];
    case "update_edge_label":
      return [{ ref: step.edgeRef, set: "edge" }];
    case "reroute_edge":
      return [
        { ref: step.edgeRef, set: "edge" },
        ...(step.fromRef ? [{ ref: step.fromRef, set: "node" as const }] : []),
        ...(step.toRef ? [{ ref: step.toRef, set: "node" as const }] : []),
      ];
    case "update_lane":
      return [{ ref: step.laneRef, set: "lane" }];
    case "create_lane":
      return [];
  }
}

const SET_BY_KIND: Record<"node" | "edge" | "lane", keyof Pick<GraphIndex, "nodeIds" | "edgeIds" | "laneIds">> = {
  node: "nodeIds",
  edge: "edgeIds",
  lane: "laneIds",
};

/** Build an ordered, validated plan for one bundle. Refs that match a tmp
 * produced earlier in the plan are treated as in-plan; all other refs must
 * exist in the current graph index. */
export function planBundle(bundle: Bundle, index: GraphIndex): BundlePlan {
  const steps = bundle.suggestions.flatMap((s) => opToSteps(s.op));
  const produced = new Set<string>();
  let applyable = true;
  let reason: string | undefined;

  for (const step of steps) {
    for (const { ref, set } of stepRealRefs(step)) {
      if (produced.has(ref)) continue; // created earlier in this plan
      if (!index[SET_BY_KIND[set]].has(ref)) {
        applyable = false;
        reason = `A referenced ${set} no longer exists on the map.`;
        break;
      }
    }
    if (!applyable) break;
    if ((step.kind === "create_node" || step.kind === "create_lane") && step.tempId) {
      produced.add(step.tempId);
    } else if (step.kind === "create_edge" && step.tempId) {
      produced.add(step.tempId);
    }
  }

  return { bundleId: bundle.id, steps, undoable: bundle.undoable, applyable, reason };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/canvas/suggestion-apply.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas/suggestion-apply.ts src/components/canvas/suggestion-apply.test.ts
git commit -m "feat(suggest): planBundle with ordering, tmp + stale-ref validation"
```

---

## Task 4: Canvas executor — `applySuggestionBatch`

This task has no unit test (canvas behavior is verified manually in this codebase, consistent with `bpmn-canvas.tsx`). It adds one handle method plus a placement helper.

**Files:**
- Modify: `src/components/canvas/bpmn-canvas.tsx`

- [ ] **Step 1: Extend the handle type**

In `src/components/canvas/bpmn-canvas.tsx`, add to `interface BpmnCanvasHandle` (after `moveSelectionToLane`, around line 171):

```ts
  /** Apply a validated suggestion bundle plan to the canvas. Runs every step,
   * rolling back on failure. Undoable plans record a single grouped undo entry
   * (Cmd+Z) and return an inline `undo`; delete-containing plans do neither. */
  applySuggestionBatch: (plan: BundlePlan) => Promise<BatchResult>;
```

- [ ] **Step 2: Add the imports**

At the top of `bpmn-canvas.tsx`, add to the existing local imports:

```ts
import type { BundlePlan, BatchResult, MutationStep } from "./suggestion-apply";
```

And ensure `NodeUpdate` is imported from `@/lib/types` (add it to the existing type import list if absent).

- [ ] **Step 3a: Hoist `recomputeY` to module scope**

The executor's lane steps need `recomputeY`, but it's currently a local `const` at line ~1692 — *after* `useImperativeHandle` and the executor. It's a pure function of its argument with no closure dependencies, so hoist it. Delete the local declaration (lines ~1692-1699) and add a module-level function near the top of the file (outside the component):

```ts
function recomputeY(ls: CanvasLane[]): CanvasLane[] {
  let y = 0;
  return ls.map((l) => {
    const out = { ...l, y };
    y += l.h;
    return out;
  });
}
```

The existing callers (`moveLaneLocal`, `addLaneAt`, `deleteLane`, paste) keep working unchanged.

- [ ] **Step 3: Add a placement helper (near `addProposedStep`, after line 477)**

```ts
  // Pick a world position for a newly-created suggestion node: offset from the
  // anchor node when one is given, else a default slot in the target lane.
  const placeNewNode = useCallback(
    (laneId: UUID | null, nearNodeId: UUID | null): { laneId: UUID; x: number; relativeY: number } | null => {
      const near = nearNodeId ? nodesRef.current.find((n) => n.id === nearNodeId) : null;
      const resolvedLane = laneId ?? near?.laneId ?? lanesRef.current[0]?.id ?? null;
      if (!resolvedLane) return null;
      if (near) {
        const pos = placeProposedStep({ x: near.x, relativeY: near.relativeY, w: near.w });
        return { laneId: resolvedLane, x: pos.x, relativeY: pos.relativeY };
      }
      const inLane = nodesRef.current.filter((n) => n.laneId === resolvedLane);
      const x = inLane.length ? Math.max(...inLane.map((n) => n.x + n.w)) + 60 : 80;
      return { laneId: resolvedLane, x, relativeY: 40 };
    },
    []
  );
```

- [ ] **Step 4: Implement `applySuggestionBatch` (add after `createEdgeImpl`, around line 599)**

```ts
  const applySuggestionBatch = useCallback(
    async (plan: BundlePlan): Promise<BatchResult> => {
      if (!plan.applyable) {
        return { ok: false, error: plan.reason ?? "This change can no longer be applied." };
      }

      // tmp placeholder -> real id, populated as create-steps run.
      const tmp: Record<string, UUID> = {};
      const resolve = (ref: string): UUID => (tmp[ref] as UUID) ?? (ref as UUID);
      let inverses: Array<() => Promise<void>> = [];
      let applied = false;

      const runSteps = async () => {
        inverses = [];
        for (const step of plan.steps) {
          await runStep(step, tmp, resolve, inverses);
        }
        applied = true;
      };

      try {
        await runSteps();
      } catch (err) {
        for (const inv of [...inverses].reverse()) {
          try {
            await inv();
          } catch {
            /* best-effort rollback */
          }
        }
        return { ok: false, error: err instanceof Error ? err.message : "Couldn't apply the change." };
      }

      if (!plan.undoable) return { ok: true };

      const revert = async () => {
        if (!applied) return;
        for (const inv of [...inverses].reverse()) await inv();
        applied = false;
      };
      const reapply = async () => {
        if (applied) return;
        await runSteps();
      };
      record({ description: "Apply suggestion", do: reapply, undo: revert });
      return { ok: true, undo: revert };
    },
    [record, runStep]
  );
```

- [ ] **Step 5: Implement the per-step executor `runStep` (add immediately before `applySuggestionBatch`)**

```ts
  const runStep = useCallback(
    async (
      step: MutationStep,
      tmp: Record<string, UUID>,
      resolve: (ref: string) => UUID,
      inverses: Array<() => Promise<void>>
    ) => {
      switch (step.kind) {
        case "update_node": {
          const id = resolve(step.nodeRef);
          const before = nodesRef.current.find((n) => n.id === id);
          if (!before) throw new Error("Node no longer exists.");
          const apiPatch: NodeUpdate = {};
          const localPatch: Partial<CanvasNode> = {};
          if (step.name !== undefined) {
            apiPatch.name = step.name;
            localPatch.label = step.name;
          }
          if (step.description !== undefined) {
            apiPatch.description = step.description;
            localPatch.description = step.description;
          }
          if (step.laneRef !== undefined) {
            const laneId = resolve(step.laneRef);
            apiPatch.lane_id = laneId;
            localPatch.laneId = laneId;
          }
          setNodes((curr) => curr.map((n) => (n.id === id ? { ...n, ...localPatch } : n)));
          await api.updateNode(projectId, id, apiPatch);
          const prev = { label: before.label, description: before.description, laneId: before.laneId };
          inverses.push(async () => {
            setNodes((curr) => curr.map((n) => (n.id === id ? { ...n, ...prev } : n)));
            await api.updateNode(projectId, id, {
              name: prev.label,
              description: prev.description,
              lane_id: prev.laneId ?? undefined,
            });
          });
          break;
        }
        case "delete_node": {
          const id = resolve(step.nodeRef);
          await deleteNodeImpl(id);
          // delete-containing plans aren't undoable; no inverse pushed.
          break;
        }
        case "create_node": {
          const place = placeNewNode(step.laneRef ? resolve(step.laneRef) : null, step.nearNodeRef ? resolve(step.nearNodeRef) : null);
          if (!place) throw new Error("No lane available to place the new step.");
          const created = await api.createNode(projectId, modelId, versionId, {
            type: step.nodeType,
            name: step.label,
            lane_id: place.laneId,
            x: place.x,
            relative_y: place.relativeY,
          });
          const size = sizeForNodeType(created.type);
          const newNode: CanvasNode = {
            id: created.id,
            type: created.type,
            kind: nodeKindFromType(created.type),
            label: created.name,
            laneId: place.laneId,
            x: place.x,
            relativeY: place.relativeY,
            w: size.w,
            h: size.h,
            aiProposed: true,
          };
          tmp[step.tempId] = created.id;
          setNodes((curr) => [...curr, newNode]);
          inverses.push(async () => {
            await api.deleteNode(projectId, created.id);
            setNodes((curr) => curr.filter((n) => n.id !== created.id));
            setEdges((curr) => curr.filter((e) => e.from !== created.id && e.to !== created.id));
          });
          break;
        }
        case "create_edge": {
          const created = await api.createEdge(projectId, modelId, versionId, {
            source_node_id: resolve(step.fromRef),
            target_node_id: resolve(step.toRef),
            label: step.label,
          });
          if (step.tempId) tmp[step.tempId] = created.id;
          setEdges((curr) => [
            ...curr,
            { id: created.id, from: created.source_node_id, to: created.target_node_id, label: created.label ?? null },
          ]);
          inverses.push(async () => {
            await api.deleteEdge(projectId, created.id);
            setEdges((curr) => curr.filter((e) => e.id !== created.id));
          });
          break;
        }
        case "delete_edge": {
          const id = resolve(step.edgeRef);
          await api.deleteEdge(projectId, id);
          setEdges((curr) => curr.filter((e) => e.id !== id));
          break;
        }
        case "update_edge_label": {
          const id = resolve(step.edgeRef);
          const before = edgesRef.current.find((e) => e.id === id);
          if (!before) throw new Error("Edge no longer exists.");
          const oldLabel = before.label;
          setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, label: step.label } : e)));
          await api.updateEdge(projectId, id, { label: step.label });
          inverses.push(async () => {
            setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, label: oldLabel } : e)));
            await api.updateEdge(projectId, id, { label: oldLabel });
          });
          break;
        }
        case "reroute_edge": {
          const id = resolve(step.edgeRef);
          const before = edgesRef.current.find((e) => e.id === id);
          if (!before) throw new Error("Edge no longer exists.");
          const newFrom = step.fromRef ? resolve(step.fromRef) : before.from;
          const newTo = step.toRef ? resolve(step.toRef) : before.to;
          await api.deleteEdge(projectId, id);
          setEdges((curr) => curr.filter((e) => e.id !== id));
          const created = await api.createEdge(projectId, modelId, versionId, {
            source_node_id: newFrom,
            target_node_id: newTo,
            label: before.label,
          });
          setEdges((curr) => [
            ...curr,
            { id: created.id, from: created.source_node_id, to: created.target_node_id, label: created.label ?? null },
          ]);
          // delete-containing plan: no inverse.
          break;
        }
        case "create_lane": {
          const created = await api.createLane(projectId, modelId, versionId, {
            name: step.name,
            order_index: lanesRef.current.length,
            height_px: LANE_HEIGHT,
          });
          tmp[step.tempId] = created.id;
          const newLane: CanvasLane = {
            id: created.id,
            label: created.name,
            color: LANE_PALETTE[lanesRef.current.length % LANE_PALETTE.length],
            collapsed: false,
            y: 0,
            h: created.height_px,
          };
          setLanes((curr) => recomputeY([...curr, newLane]));
          inverses.push(async () => {
            await api.deleteLane(projectId, created.id);
            setLanes((curr) => recomputeY(curr.filter((l) => l.id !== created.id)));
          });
          break;
        }
        case "update_lane": {
          const id = resolve(step.laneRef);
          const before = lanesRef.current.find((l) => l.id === id);
          if (!before) throw new Error("Lane no longer exists.");
          const oldName = before.label;
          setLanes((curr) => curr.map((l) => (l.id === id ? { ...l, label: step.name } : l)));
          await api.updateLane(projectId, id, { name: step.name });
          inverses.push(async () => {
            setLanes((curr) => curr.map((l) => (l.id === id ? { ...l, label: oldName } : l)));
            await api.updateLane(projectId, id, { name: oldName });
          });
          break;
        }
      }
    },
    [projectId, modelId, versionId, deleteNodeImpl, placeNewNode]
  );
```

> Note: `runStep` must be declared **before** `applySuggestionBatch` so it can appear in that callback's dependency array. Both go before `useImperativeHandle` (line ~1476). `recomputeY` is now module-level (Step 3a); `LANE_HEIGHT`, `LANE_PALETTE`, `sizeForNodeType`, `nodeKindFromType` are already imported/used in this file.

- [ ] **Step 6: Wire into the imperative handle**

In the `useImperativeHandle` object (around line 1478) add `applySuggestionBatch,` after `moveSelectionToLane:`, and add `applySuggestionBatch` to its dependency array (around line 1513).

- [ ] **Step 7: Verify the build typechecks**

Run: `npm run build`
Expected: Compiles with no type errors. (If `runStep`'s position triggers a use-before-declaration lint, move its `const runStep = useCallback(...)` above `applySuggestionBatch` as the note says.)

- [ ] **Step 8: Commit**

```bash
git add src/components/canvas/bpmn-canvas.tsx
git commit -m "feat(suggest): canvas applySuggestionBatch executor with rollback + grouped undo"
```

---

## Task 5: Extract `ChatTab`/`ChatMsg` into `chat-tab.tsx` (pure refactor)

Move the existing chat code out of the oversized `right-panel.tsx` with **no behavior change**, so later tasks edit a focused file.

**Files:**
- Create: `src/components/canvas/chat-tab.tsx`
- Modify: `src/components/canvas/right-panel.tsx`

- [ ] **Step 1: Create `chat-tab.tsx`**

Cut the `ChatItem` type, `SUGGESTED_PROMPTS`, the `ChatTab` function, and the `ChatMsg` function out of `right-panel.tsx` (lines ~72-77, ~84, ~308-716) and paste them into a new `chat-tab.tsx`. Add `"use client";` at the top and these imports (copy the subset actually used):

```ts
"use client";

import { Pause, Play, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";

import { api } from "@/lib/api";
import type { ChatTurn, MentionSource, ObjectRef, UUID, ViewerTarget } from "@/lib/types";
import { mentionsToMarkdown } from "./mention-markdown";
import { selectionChips, selectionToContextRefs, type SelectedObject } from "./chat-context";
import { browserChatSessionStore } from "./chat-session";
import { restoreAfterCancel, type PendingSend } from "./chat-cancel";

export type ChatItem = ChatTurn & { contextNote?: string; sources?: MentionSource[] };
```

Export `ChatTab`: change `function ChatTab(` to `export function ChatTab(`.

- [ ] **Step 2: Update `right-panel.tsx` imports**

Remove the now-moved code from `right-panel.tsx`. Replace the deleted block with an import near the top:

```ts
import { ChatTab } from "./chat-tab";
```

Delete the now-unused imports from `right-panel.tsx` that were only used by the moved code (`ReactMarkdown`, `defaultUrlTransform`, `mentionsToMarkdown`, `restoreAfterCancel`, `PendingSend`, `browserChatSessionStore`, `selectionChips`, `selectionToContextRefs`, `Pause`, `Play`, and `Sparkles`/`X` **only if** unused elsewhere — verify with a search before removing each).

- [ ] **Step 3: Verify tests + build still green**

Run: `npx vitest run && npm run build`
Expected: PASS / compiles. Behavior is unchanged (still ask-mode only at this point).

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/chat-tab.tsx src/components/canvas/right-panel.tsx
git commit -m "refactor(chat): extract ChatTab/ChatMsg into chat-tab.tsx"
```

---

## Task 6: Suggestion card components (`suggestion-card.tsx`)

**Files:**
- Create: `src/components/canvas/suggestion-card.tsx`

- [ ] **Step 1: Create the presentational components**

```tsx
"use client";

import { Check, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import type { ChatSuggestion, ObjectRef, UUID } from "@/lib/types";
import type { Bundle } from "./suggestion-apply";

export type CardStatus = "pending" | "applying" | "applied" | "failed" | "dismissed";

export function SuggestionList({
  bundles,
  statusById,
  canUndoById,
  onApply,
  onUndo,
  onDismiss,
  onNavigate,
}: {
  bundles: Bundle[];
  statusById: Record<string, CardStatus>;
  canUndoById: Record<string, boolean>;
  onApply: (bundle: Bundle) => void;
  onUndo: (bundleId: string) => void;
  onDismiss: (bundleId: string) => void;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
}) {
  const visible = bundles.filter((b) => statusById[b.id] !== "dismissed");
  if (visible.length === 0) return null;
  const pending = visible.filter((b) => (statusById[b.id] ?? "pending") === "pending");
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-700">
          Suggested changes · {visible.length}
        </span>
        {pending.length > 1 && (
          <button
            onClick={() => pending.forEach((b) => onApply(b))}
            className="rounded-full border border-violet-200 px-2 py-0.5 text-[10px] font-semibold text-violet-700 hover:bg-violet-50"
          >
            Apply all
          </button>
        )}
      </div>
      {visible.map((b) => (
        <SuggestionCard
          key={b.id}
          bundle={b}
          status={statusById[b.id] ?? "pending"}
          canUndo={!!canUndoById[b.id]}
          onApply={() => onApply(b)}
          onUndo={() => onUndo(b.id)}
          onDismiss={() => onDismiss(b.id)}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

function SuggestionCard({
  bundle,
  status,
  canUndo,
  onApply,
  onUndo,
  onDismiss,
  onNavigate,
}: {
  bundle: Bundle;
  status: CardStatus;
  canUndo: boolean;
  onApply: () => void;
  onUndo: () => void;
  onDismiss: () => void;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const isDelete = !bundle.undoable;
  const head = bundle.suggestions[0];
  const extra = bundle.suggestions.length - 1;

  return (
    <div
      className={
        "rounded-md border p-2 " +
        (status === "applied"
          ? "border-emerald-200 bg-emerald-50/50"
          : status === "failed"
          ? "border-rose-200 bg-rose-50/50"
          : "border-slate-200 bg-slate-50/60")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-800">
          {head.title}
          {extra > 0 && <span className="ml-1 text-[10px] font-normal text-slate-500">+{extra} more</span>}
        </p>
        {isDelete && status === "pending" && (
          <span className="shrink-0 rounded bg-rose-100 px-1 py-px text-[9px] font-bold text-rose-700">removes</span>
        )}
      </div>

      {bundle.suggestions.map(
        (s) => s.rationale && <p key={s.id} className="mt-0.5 text-[10px] text-slate-500">{s.rationale}</p>
      )}

      <AffectedRefs suggestions={bundle.suggestions} onNavigate={onNavigate} />

      {status === "applied" ? (
        <div className="mt-2 flex items-center gap-2 text-[10px] font-semibold text-emerald-700">
          <Check size={12} /> Applied
          {canUndo && (
            <button onClick={onUndo} className="flex items-center gap-1 text-slate-500 hover:text-slate-800">
              <RotateCcw size={11} /> Undo
            </button>
          )}
        </div>
      ) : status === "applying" ? (
        <div className="mt-2 text-[10px] text-slate-500">Applying…</div>
      ) : confirming ? (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[10px] text-rose-700">Can&apos;t be undone.</span>
          <button onClick={onApply} className="rounded bg-rose-600 px-2 py-1 text-[10px] font-semibold text-white">
            Apply anyway
          </button>
          <button onClick={() => setConfirming(false)} className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600">
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-2 flex gap-1.5">
          <button
            onClick={() => (isDelete ? setConfirming(true) : onApply())}
            className="rounded bg-slate-800 px-2 py-1 text-[10px] font-semibold text-white hover:bg-slate-700"
          >
            Apply
          </button>
          <button onClick={onDismiss} className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100">
            Dismiss
          </button>
          {status === "failed" && <span className="self-center text-[10px] text-rose-600">Failed — try again</span>}
        </div>
      )}
    </div>
  );
}

function AffectedRefs({
  suggestions,
  onNavigate,
}: {
  suggestions: ChatSuggestion[];
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
}) {
  const refs: ObjectRef[] = suggestions.flatMap((s) => s.affected_refs).filter((r) => r.kind !== "lane");
  if (refs.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {refs.map((r) => (
        <button
          key={`${r.kind}:${r.id}`}
          onClick={() => onNavigate({ kind: r.kind as "node" | "edge", id: r.id })}
          className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[9px] text-slate-600 hover:bg-slate-100"
          title="Jump to this object"
        >
          {r.kind}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Compiles (component not yet rendered anywhere; that's fine).

- [ ] **Step 3: Commit**

```bash
git add src/components/canvas/suggestion-card.tsx
git commit -m "feat(suggest): suggestion card + list presentational components"
```

---

## Task 7: Wire suggest mode end-to-end (page + RightPanel + chat tab)

**Files:**
- Modify: `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`
- Modify: `src/components/canvas/right-panel.tsx`
- Modify: `src/components/canvas/chat-tab.tsx`

This task adds the page handler, the `RightPanel` pass-through props, and the chat-tab
consumption **together** so the build is green at the end of the task (no broken intermediate
prop wiring).

- [ ] **Step 0: Add the page handler + props**

In `page.tsx`, add the import:

```ts
import type { BundlePlan } from "@/components/canvas/suggestion-apply";
```

Add the handler after `handleAddStep` (around line 134):

```ts
  const handleApplySuggestions = useCallback(
    (plan: BundlePlan) => {
      if (!canvasRef.current) return Promise.resolve({ ok: false, error: "Canvas not ready." });
      return canvasRef.current.applySuggestionBatch(plan);
    },
    []
  );
```

And on the `<RightPanel ... />` element (around line 443) add both props:

```tsx
            onApplySuggestions={handleApplySuggestions}
            graph={data}
```

(Do not build yet — `RightPanel` gains these props in Step 6 below; finish the task, then build.)

- [ ] **Step 1: Extend `ChatItem` and add mode state**

In `chat-tab.tsx`, extend the type and imports:

```ts
import type { ChatSuggestion, ChatTurn, MentionSource, ObjectRef, ProcessGraph, UUID, ViewerTarget } from "@/lib/types";
import { bundleSuggestions, indexGraph, planBundle, type Bundle } from "./suggestion-apply";
import { SuggestionList, type CardStatus } from "./suggestion-card";

export type ChatItem = ChatTurn & {
  contextNote?: string;
  sources?: MentionSource[];
  suggestions?: ChatSuggestion[];
  suggestionStatus?: Record<string, CardStatus>;
};
```

Add a `ChatMode` type and props for apply + graph. Update `ChatTab`'s prop list to accept:

```ts
  onApplySuggestions,
  graph,
}: {
  /* ...existing props... */
  onApplySuggestions: (plan: import("./suggestion-apply").BundlePlan) => Promise<import("./suggestion-apply").BatchResult>;
  graph: ProcessGraph;
}) {
  const [mode, setMode] = useState<"ask" | "suggest">("ask");
```

- [ ] **Step 2: Send the chosen mode**

In the `ask` mutation's `mutationFn`, change the hardcoded `mode: "ask"` to `mode: input.mode`, and add `mode` to the mutate input type and to the `ask.mutate({...})` call (read it from the `mode` state at submit time, captured like `contextRefs`). In `onSuccess`, store suggestions on the assistant message:

```ts
      const next: ChatItem[] = [
        ...vars.history,
        { role: "user", content: vars.userMessage, contextNote: vars.note },
        {
          role: "assistant",
          content: data.message,
          sources: data.mention_sources,
          suggestions: data.suggestions.length ? data.suggestions : undefined,
          suggestionStatus: {},
        },
      ];
```

- [ ] **Step 3: Add the Ask | Suggest toggle to the composer**

Just above the `<div className="flex items-end gap-1.5">` row in the composer, add:

```tsx
          <div className="mb-1.5 inline-flex rounded-md border border-slate-200 p-0.5 text-[10px]">
            {(["ask", "suggest"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={
                  "rounded px-2 py-0.5 font-semibold capitalize transition " +
                  (mode === m ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800")
                }
              >
                {m}
              </button>
            ))}
          </div>
```

- [ ] **Step 4: Render suggestions under assistant messages**

The `history.map(...)` currently renders `<ChatMsg .../>`. Replace the per-item render so assistant items with suggestions also render a `SuggestionList`. Add an `applyBundle` handler that plans + applies and updates status. Add this inside `ChatTab`:

```ts
  const graphIndex = useMemo(() => indexGraph(graph), [graph]);
  // Inline-undo handles, keyed by bundle id (in-memory only; lost on reload).
  const undoHandles = useRef<Map<string, () => Promise<void>>>(new Map());

  const setBundleStatus = (msgIndex: number, bundleId: string, status: CardStatus) => {
    setHistory((curr) => {
      const next = curr.map((m, i) =>
        i === msgIndex
          ? { ...m, suggestionStatus: { ...(m.suggestionStatus ?? {}), [bundleId]: status } }
          : m
      );
      sessionStore.save(versionId, next);
      return next;
    });
  };

  const applyBundle = async (msgIndex: number, bundle: Bundle) => {
    setBundleStatus(msgIndex, bundle.id, "applying");
    const plan = planBundle(bundle, graphIndex);
    const res = await onApplySuggestions(plan);
    if (res.ok) {
      if (res.undo) undoHandles.current.set(bundle.id, res.undo);
      setBundleStatus(msgIndex, bundle.id, "applied");
    } else {
      setBundleStatus(msgIndex, bundle.id, "failed");
    }
  };

  const undoBundle = async (bundleId: string) => {
    const fn = undoHandles.current.get(bundleId);
    if (fn) await fn();
    undoHandles.current.delete(bundleId);
    // Reflect revert in whichever message owns this bundle.
    setHistory((curr) => {
      const next = curr.map((m) =>
        m.suggestionStatus?.[bundleId]
          ? { ...m, suggestionStatus: { ...m.suggestionStatus, [bundleId]: "pending" as CardStatus } }
          : m
      );
      sessionStore.save(versionId, next);
      return next;
    });
  };
```

Then change the message render to:

```tsx
        {history.map((m, i) => (
          <div key={i} className="space-y-1">
            <ChatMsg turn={m} labelById={labelById} onNavigate={onNavigate} onOpenSource={onOpenSource} />
            {m.role === "assistant" && m.suggestions && (
              <SuggestionList
                bundles={bundleSuggestions(m.suggestions)}
                statusById={m.suggestionStatus ?? {}}
                canUndoById={Object.fromEntries(bundleSuggestions(m.suggestions).map((b) => [b.id, undoHandles.current.has(b.id)]))}
                onApply={(b) => applyBundle(i, b)}
                onUndo={undoBundle}
                onDismiss={(id) => setBundleStatus(i, id, "dismissed")}
                onNavigate={onNavigate}
              />
            )}
          </div>
        ))}
```

- [ ] **Step 5: Make example prompts mode-aware**

Replace the single `SUGGESTED_PROMPTS` use with a per-mode list:

```ts
const SUGGESTED_PROMPTS: Record<"ask" | "suggest", string[]> = {
  ask: [
    "Find any gaps in this flow",
    "Which steps lack source citations?",
    "Compare this against typical processes",
  ],
  suggest: [
    "Add the missing approval step",
    "Fix the order of these two steps",
    "Split this step into its sub-steps",
  ],
};
```

And in the examples row use `SUGGESTED_PROMPTS[mode].map(...)`.

- [ ] **Step 6: Thread the props through `right-panel.tsx`**

Add `onApplySuggestions` and `graph` to `RightPanel`'s prop type and signature, and pass them into `<ChatTab .../>`. (The page already passes `graph={data}` and `onApplySuggestions={handleApplySuggestions}` from Step 0.) In `right-panel.tsx`:

```ts
  onApplySuggestions,
  graph,
}: {
  /* ...existing... */
  onApplySuggestions: (plan: import("./suggestion-apply").BundlePlan) => Promise<import("./suggestion-apply").BatchResult>;
  graph: import("@/lib/types").ProcessGraph;
}) {
```

Pass to `ChatTab`:

```tsx
          <ChatTab
            /* ...existing props... */
            onApplySuggestions={onApplySuggestions}
            graph={graph}
          />
```

- [ ] **Step 7: Verify tests + build**

Run: `npx vitest run && npm run build`
Expected: PASS / compiles cleanly.

- [ ] **Step 8: Commit**

```bash
git add src/components/canvas/chat-tab.tsx src/components/canvas/right-panel.tsx "src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx"
git commit -m "feat(suggest): mode toggle, suggestion threading, apply/undo/dismiss wiring"
```

---

## Task 8: Manual verification

No code — exercise the full loop in the running app.

- [ ] **Step 1: Start the app**

Run the backend and `npm run dev` per the repo's usual dev flow. Open a project → a map version with sources/claims.

- [ ] **Step 2: Verify the loop**

Confirm each:
- Toggle **Suggest**, send "Add the missing approval step" → assistant prose + at least one suggestion card render.
- **Apply** an edit card (e.g. relabel/add-edge) → canvas updates; card flips to **Applied ✓** with **Undo**; inline **Undo** reverts; **Cmd+Z** also reverts an applied edit.
- A multi-op suggestion (add_node + add_edge) renders as **one** bundled card and applies the node+edge together.
- A **remove**/reroute card shows the "removes" tag and an "Apply anyway / Cancel" confirm; after applying it shows **Applied ✓** with **no** Undo.
- **Apply all** applies every pending card.
- **Dismiss** hides a card; reloading the page preserves applied/dismissed status (Undo button is absent on reloaded applied cards, by design).
- Switch back to **Ask** → no suggestion cards; behavior matches today.

- [ ] **Step 3: Final checks + commit (if any fixes were needed)**

Run: `npx vitest run && npm run lint && npm run build`
Expected: all green.

```bash
git commit -am "fix(suggest): manual-verification fixes" # only if changes were needed
```

---

## Self-review notes

- **Spec coverage:** mode toggle (T7), suggestion cards (T6), full 12-op apply (T1 mapping + T4 executor), bundling group+tmp (T2), tmp resolution + stale-ref (T3), undoability rule incl. reroute-as-delete (T1/T2/T4), decompose semantics (T1), per-card Undo + Cmd+Z (T4/T7), confirm-before-delete (T6), Apply-all (T6), persistence of status (T7), error/retry + rollback (T4/T6/T7), ChatTab extraction (T5), page delegation (T7 Step 0). All spec sections map to a task.
- **Type consistency:** `BundlePlan`/`BatchResult`/`MutationStep`/`Bundle`/`GraphIndex` are defined in T1–T3 and consumed unchanged in T4/T6/T7. Handle method name `applySuggestionBatch` is identical across T4 (handle), T7 (page + chat). `CardStatus` defined in T6, reused in T7.
- **Build-green ordering:** planner (T1–T3) and executor (T4) build green standalone; the extraction (T5) and card components (T6) are unused-but-compiling; all prop wiring lands together in T7 so no task ends on a broken prop contract.
- **Known ordering caveat:** T4 requires `runStep` to be declared before `applySuggestionBatch` (called out in the task note) so the dependency array resolves; `recomputeY` is hoisted to module scope (T4 Step 3a).
