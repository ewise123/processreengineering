import { describe, expect, it } from "vitest";

import { isEdgeProposed, placeNewNodeIn, placeProposedStep } from "./ai-edit";
import type { CanvasNode, CanvasLane } from "./types";

const lane = (id: string, y = 0, h = 150): CanvasLane => ({
  id: id as CanvasLane["id"],
  label: id,
  color: "#ccc",
  collapsed: false,
  y,
  h,
});
const node = (id: string, laneId: string, x: number, relativeY = 40, w = 120): CanvasNode => ({
  id: id as CanvasNode["id"],
  type: "task",
  kind: "task",
  label: id,
  laneId: laneId as CanvasNode["id"],
  x,
  relativeY,
  w,
  h: 60,
});

describe("placeProposedStep", () => {
  it("places the new step downstream (to the right) of the source", () => {
    const pos = placeProposedStep({ x: 100, relativeY: 30, w: 170 });
    expect(pos.x).toBe(100 + 170 + 80);
    expect(pos.relativeY).toBe(30);
  });

  it("accepts a custom gap", () => {
    expect(placeProposedStep({ x: 0, relativeY: 0, w: 100 }, 40).x).toBe(140);
  });
});

describe("isEdgeProposed", () => {
  it("is true when either endpoint is ai-proposed", () => {
    expect(isEdgeProposed({ aiProposed: false }, { aiProposed: true })).toBe(true);
    expect(isEdgeProposed({ aiProposed: true }, { aiProposed: false })).toBe(true);
  });
  it("is false when neither endpoint is ai-proposed", () => {
    expect(isEdgeProposed({ aiProposed: false }, { aiProposed: false })).toBe(false);
    expect(isEdgeProposed(undefined, undefined)).toBe(false);
  });
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
