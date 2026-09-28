import { describe, expect, it } from "vitest";
import { alignItems, minItemsFor, type AlignItem } from "./align";

// Two lanes: A at y 0 (h 200), B at y 200 (h 200). Tasks are 170×64.
const inA = (id: string, x: number, rel: number): AlignItem => ({
  id, x, y: rel, w: 170, h: 64, laneY: 0, laneH: 200,
});
const inB = (id: string, x: number, rel: number): AlignItem => ({
  id, x, y: 200 + rel, w: 170, h: 64, laneY: 200, laneH: 200,
});

describe("alignItems — horizontal", () => {
  it("aligns left, right and centre edges to the selection's bounds", () => {
    const items = [inA("a", 100, 20), inA("b", 300, 100)];
    expect(alignItems(items, "left")).toEqual([{ id: "b", x: 100, relativeY: 100 }]);
    expect(alignItems(items, "right")).toEqual([{ id: "a", x: 300, relativeY: 20 }]);
    // Bounds 100..470, centre 285 → each x = 200.
    expect(alignItems(items, "center")).toEqual([
      { id: "a", x: 200, relativeY: 20 },
      { id: "b", x: 200, relativeY: 100 },
    ]);
  });

  it("works across lanes, since x never changes a lane", () => {
    expect(alignItems([inA("a", 100, 0), inB("b", 400, 0)], "left")).toEqual([
      { id: "b", x: 100, relativeY: 0 },
    ]);
  });
});

describe("alignItems — vertical stays inside each lane", () => {
  it("aligns tops within one lane", () => {
    expect(alignItems([inA("a", 0, 20), inA("b", 300, 60)], "top")).toEqual([
      { id: "b", x: 300, relativeY: 20 },
    ]);
  });

  it("aligns middles (the 'straighten' command) within one lane", () => {
    // Tops 20 and 60 → bounds 20..124, middle 72 → relativeY 40 for both.
    expect(alignItems([inA("a", 0, 20), inA("b", 300, 60)], "middle")).toEqual([
      { id: "a", x: 0, relativeY: 40 },
      { id: "b", x: 300, relativeY: 40 },
    ]);
  });

  it("across lanes, clamps each step to its own lane instead of re-laning it", () => {
    // Top of the selection is y 10 (lane A). The lane-B step can only rise to its lane top.
    expect(alignItems([inA("a", 0, 10), inB("b", 300, 80)], "top")).toEqual([
      { id: "b", x: 300, relativeY: 0 },
    ]);
  });
});

describe("alignItems — distribute", () => {
  it("makes the gaps between neighbours equal, keeping the outer steps fixed", () => {
    const items = [inA("a", 0, 0), inA("b", 250, 0), inA("c", 700, 0)];
    // Span 0..870, widths 510 → gap 180: b moves to 350.
    expect(alignItems(items, "distribute-h")).toEqual([{ id: "b", x: 350, relativeY: 0 }]);
  });

  it("orders by position, not by selection order", () => {
    const items = [inA("c", 700, 0), inA("a", 0, 0), inA("b", 250, 0)];
    expect(alignItems(items, "distribute-h")).toEqual([{ id: "b", x: 350, relativeY: 0 }]);
  });

  it("spreads centres evenly when the steps overlap", () => {
    const items = [inA("a", 0, 0), inA("b", 10, 0), inA("c", 100, 0)];
    // Centres 85 and 185 → the middle one centres on 135 → x 50.
    expect(alignItems(items, "distribute-h")).toEqual([{ id: "b", x: 50, relativeY: 0 }]);
  });

  it("needs three steps", () => {
    expect(minItemsFor("distribute-v")).toBe(3);
    expect(alignItems([inA("a", 0, 0), inA("b", 400, 90)], "distribute-v")).toEqual([]);
  });
});

describe("alignItems — no-ops", () => {
  it("returns nothing when the steps are already aligned, or for one step", () => {
    expect(alignItems([inA("a", 100, 0), inA("b", 100, 100)], "left")).toEqual([]);
    expect(alignItems([inA("a", 100, 0)], "left")).toEqual([]);
  });
});
