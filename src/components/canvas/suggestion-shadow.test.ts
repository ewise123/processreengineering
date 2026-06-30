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

    const s: CanvasState = {
      nodes: [node("A", "L1", 80), node("B", "L1", 300), node("C", "L1", 520)],
      edges: [{ ...edge("E1", "A", "B"), label: "approved" }],
      lanes: [lane("L1")],
    };
    const rer = applyPlanToCanvas(s, plan([{ kind: "reroute_edge", edgeRef: "E1", fromRef: "A", toRef: "C" }]));
    expect(rer.edges.find((e) => e.id === "E1")).toBeUndefined(); // old gone
    expect(rer.edges.some((e) => e.from === "A" && e.to === "C")).toBe(true); // new present
    expect(rer.edges.find((e) => e.from === "A" && e.to === "C")!.label).toBe("approved"); // label carried over
  });

  it("rerouting a non-existent edge ref leaves edges unchanged (no ghost edge)", () => {
    const out = applyPlanToCanvas(base(), plan([{ kind: "reroute_edge", edgeRef: "MISSING", fromRef: "A", toRef: "B" }]));
    expect(out.edges.length).toBe(base().edges.length);
    expect(out.edges.every((e) => e.from !== "" && e.to !== "")).toBe(true);
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
