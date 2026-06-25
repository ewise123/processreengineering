import { describe, it, expect } from "vitest";
import { edgeFocusCenter } from "./edge-focus";

const lanes = [{ id: "L1", y: 0 }, { id: "L2", y: 100 }];
// node center = (x + w/2, laneY + relativeY + h/2)
const nodes = [
  { id: "a", laneId: "L1", x: 0, relativeY: 10, w: 100, h: 60 },   // center (50, 40)
  { id: "b", laneId: "L2", x: 200, relativeY: 10, w: 100, h: 60 }, // center (250, 140)
];

describe("edgeFocusCenter", () => {
  it("returns the midpoint between the two endpoint node centers", () => {
    const c = edgeFocusCenter({ from: "a", to: "b" }, nodes, lanes);
    expect(c).toEqual({ cx: 150, cy: 90 });
  });

  it("returns null when an endpoint node is missing", () => {
    expect(edgeFocusCenter({ from: "a", to: "ghost" }, nodes, lanes)).toBeNull();
  });

  it("treats a null lane as y=0 (relativeY only)", () => {
    const c = edgeFocusCenter(
      { from: "a", to: "b" },
      [{ id: "a", laneId: null, x: 0, relativeY: 10, w: 100, h: 60 },
       { id: "b", laneId: null, x: 0, relativeY: 10, w: 100, h: 60 }],
      lanes
    );
    expect(c).toEqual({ cx: 50, cy: 40 });
  });

  it("falls back to y=0 when a node points at a lane missing from the list", () => {
    // laneId "L9" is not in `lanes`, so lanes.find(...)?.y is undefined and the
    // `?? 0` fallback must kick in (laneY = 0 + relativeY).
    const c = edgeFocusCenter(
      { from: "a", to: "b" },
      [{ id: "a", laneId: "L9", x: 0, relativeY: 10, w: 100, h: 60 },
       { id: "b", laneId: "L9", x: 0, relativeY: 10, w: 100, h: 60 }],
      lanes
    );
    expect(c).toEqual({ cx: 50, cy: 40 });
  });
});
